/* Two pages, one room, racing the gate course in headless Chromium.
   Run: node test/race_test.js        (needs playwright; skips if it is missing)

   The relay is tools/relay.js on a loopback port, so the test needs nothing from
   the internet, and every layer is the real thing: the built index.html, the
   WebSocket transport, the room protocol, clock sync, the interpolation buffer,
   gate timing and the lap broadcast. */
const http = require('http'), fs = require('fs'), path = require('path');
const relay = require('../tools/relay.js');
const ROOT = path.join(__dirname, '..');
const line = (...a) => console.log(...a);
let bad = 0;
const check = (ok, what, detail) => { line(`${ok ? ' ok ' : 'FAIL'}  ${what}${detail ? '  (' + detail + ')' : ''}`); if (!ok) bad++; };

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  line('playwright is not installed, so the two-page race test is skipped.');
  line('  npm i -D playwright   (Chromium only: npx playwright install chromium)');
  process.exit(0);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(String(req.url).split('?')[0]);
    const f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
    if (f.indexOf(ROOT) !== 0) { res.writeHead(403); res.end(); return; }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      res.end(d);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}/` })));
}

/* ---- page side: fly the oval on wall-clock time, so both pages agree on phase ---- */
function startFlying({ t0, phase, speed }) {
  const F = window.__flightline, gs = F.world().gates, N = gs.length;
  const OCZ = -118, ORX = 78, ORZ = 52;
  F.S.crashes = false; F.env.crashes = false; F.S.battery = false; F.env.battery = false;
  window.__path = { t0, phase, speed, per: (2 * Math.PI * ((ORX + ORZ) / 2)) / speed, OCZ, ORX, ORZ };
  const hAt = (th) => {
    const u = ((th - Math.PI / 2) / (Math.PI * 2)) * N, i = ((Math.floor(u) % N) + N) % N, f = u - Math.floor(u);
    return (gs[i].b + gs[i].H / 2) * (1 - f) + (gs[(i + 1) % N].b + gs[(i + 1) % N].H / 2) * f;
  };
  window.__at = (t) => { // where this aircraft is at wall-clock time t (ms), in NED
    const th = Math.PI / 2 + (((t - t0) / 1000 + phase) / window.__path.per) * Math.PI * 2;
    const x = ORX * Math.cos(th), z = OCZ + ORZ * Math.sin(th);
    return { p: [-z, x, -hAt(th)], yaw: Math.atan2(-ORX * Math.sin(th), -ORZ * Math.cos(th)), th };
  };
  const fly = () => {
    const now = Date.now(), a = window.__at(now), b = window.__at(now + 50), st = F.st;
    st.p[0] = a.p[0]; st.p[1] = a.p[1]; st.p[2] = a.p[2];
    st.v[0] = (b.p[0] - a.p[0]) * 20; st.v[1] = (b.p[1] - a.p[1]) * 20; st.v[2] = (b.p[2] - a.p[2]) * 20;
    st.w[0] = st.w[1] = st.w[2] = 0;
    const q = F.FL.quatFromEuler(0, 0, a.yaw);
    st.q[0] = q[0]; st.q[1] = q[1]; st.q[2] = q[2]; st.q[3] = q[3];
    st.crashed = false; st.held = false;
    if (!window.__flyStop) requestAnimationFrame(fly);
  };
  requestAnimationFrame(fly);
}

// how far behind the other pilot is drawn, and how far off their path, measured from
// the phase their drawn position implies
function watchPeer(otherPhase) {
  const F = window.__flightline, R = F.race.r;
  const p = [...R.peers.values()][0];
  if (!p || !p.view) return null;
  const P = window.__path, now = Date.now();
  const v = p.view.p, x = v[1], z = -v[0];
  const th = Math.atan2((z - P.OCZ) / P.ORZ, x / P.ORX);
  const mine = window.__at(now).th;
  // their phase in seconds, unwrapped against ours
  let dth = (mine + (otherPhase / P.per) * Math.PI * 2) - th;
  while (dth > Math.PI) dth -= Math.PI * 2;
  while (dth < -Math.PI) dth += Math.PI * 2;
  const lag = (dth / (Math.PI * 2)) * P.per * 1000;
  const r = Math.hypot(x / P.ORX, (z - P.OCZ) / P.ORZ); // 1 on the path
  return { lag, offPath: Math.abs(r - 1) * ((P.ORX + P.ORZ) / 2), rtt: p.rtt, offset: p.offset, name: p.name,
    laps: p.laps, lapTime: p.lap, stale: !!p.stale, label: (F.avatars.find((a) => a.remote) || {}).label || '' };
}

(async () => {
  const { srv, base } = await serve();
  await relay.start(0, true);
  const relayUrl = `ws://127.0.0.1:${relay.server.address().port}`;
  const browser = await chromium.launch();
  const pages = [];
  for (const [name, col] of [['Ann', 0], ['Bob', 3]]) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 600 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { line(`FAIL  ${name} page error: ${e.message}`); bad++; });
    await page.addInitScript(({ name, col, relayUrl }) => {
      // settings as if the pilot had set them up and left the room joined
      localStorage.setItem('flightline.settings.v1', JSON.stringify({
        aircraft: 'quad', start: { quad: 'air' }, pilot: name, course: true, crashes: false, autoReset: false,
        net: { relay: 'ws', ws: relayUrl, room: 'RACE01', col, spec: false, rate: 20, delay: 120, coll: 'off', laps: 2 },
      }));
      localStorage.setItem('flightline.id.v1', name.toLowerCase());
    }, { name, col, relayUrl });
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__flightline, null, { timeout: 20000 });
    await page.click('#wFly');
    pages.push({ name, page });
  }
  const [A, B] = pages;

  line('== The room ==');
  await A.page.waitForFunction(() => window.__flightline.race.r && window.__flightline.race.r.peers.size === 1, null, { timeout: 10000 }).catch(() => {});
  const seen = async (p) => p.page.evaluate(() => {
    const R = window.__flightline.race.r;
    return R ? { status: R.status, room: R.room, peers: [...R.peers.values()].map((x) => ({ n: x.name, ac: x.ac, col: x.col })) } : null;
  });
  const sa = await seen(A), sb = await seen(B);
  check(sa && sa.status === 'open' && sb && sb.status === 'open', 'both pages joined the room on their own', sa && `room ${sa.room}`);
  check(sa && sa.peers.length === 1 && sa.peers[0].n === 'Bob', 'Ann sees Bob', sa && JSON.stringify(sa.peers[0]));
  check(sb && sb.peers.length === 1 && sb.peers[0].n === 'Ann', 'Bob sees Ann');
  check(await A.page.evaluate(() => !document.querySelector('#race').hidden), 'the race panel is up');

  line('');
  line('== Ready, countdown, go ==');
  await A.page.click('#rcReady');
  await B.page.click('#rcReady');
  await A.page.waitForFunction(() => window.__flightline.race.phase === 'count', null, { timeout: 8000 }).catch(() => {});
  const phases = await Promise.all(pages.map((p) => p.page.evaluate(() => ({ phase: window.__flightline.race.phase, at: window.__flightline.race.startAt }))));
  check(phases.every((x) => x.phase === 'count'), 'one countdown for both pages', phases.map((x) => x.phase).join(' + '));
  await Promise.all(pages.map((p) => p.page.waitForFunction(() => window.__flightline.race.phase === 'race', null, { timeout: 15000 }).catch(() => {})));
  const racing = await Promise.all(pages.map((p) => p.page.evaluate(() => window.__flightline.race.phase)));
  check(racing.every((x) => x === 'race'), 'both are racing', racing.join(' + '));

  line('');
  line('== Racing ==');
  const t0 = Date.now() + 500, speed = 34;
  await A.page.evaluate(startFlying, { t0, phase: 0, speed });
  await B.page.evaluate(startFlying, { t0, phase: 3.5, speed }); // Bob is 3.5 s up the course
  const per = (2 * Math.PI * ((78 + 52) / 2)) / speed;
  line(`     a lap is about ${per.toFixed(1)} s at ${speed} m/s; racing two`);
  const samples = [];
  const settle = Date.now() + 2000; // let both aircraft get onto the course first
  const until = Date.now() + (per * 2 + 8) * 1000;
  while (Date.now() < until) {
    const r = Date.now() > settle ? await A.page.evaluate(watchPeer, 3.5) : null;
    if (r) samples.push(r);
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const good = samples.filter((s) => !s.stale);
  const lags = good.map((s) => s.lag).sort((a, b) => a - b);
  const offs = good.map((s) => s.offPath);
  const med = lags[Math.floor(lags.length / 2)];
  check(samples.length > 50 && good.length / samples.length > 0.95, 'the other aircraft has a place to be on nearly every look',
    `${good.length} of ${samples.length} samples live`);
  check(med > 60 && med < 400, 'drawn about a buffer behind', `median ${Math.round(med)} ms (120 ms buffer set)`);
  check(Math.max(...offs) < 2, 'and on the course, not beside it', `worst ${Math.max(...offs).toFixed(2)} m off the path`);
  check(/BOB/.test(good[good.length - 1].label), 'with a name tag', good[good.length - 1].label);
  const last = samples[samples.length - 1];
  check(last.rtt !== null && last.rtt < 200, 'round trip measured', `${last.rtt} ms`);
  check(last.offset !== null && Math.abs(last.offset) < 60000, 'clocks lined up', `${Math.round(last.offset)} ms apart`);

  line('');
  line('== Laps and bandwidth ==');
  const end = await Promise.all(pages.map((p) => p.page.evaluate(() => {
    const F = window.__flightline, R = F.race.r, o = [...R.peers.values()][0];
    return { me: F.race.laps, best: F.S.best[F.AC().id], phase: F.race.phase,
      peerLaps: o.laps, peerLap: o.lap, up: R.stats.upBps, down: R.stats.downBps, rate: R.stats.rate,
      bytesUp: R.stats.up, msgUp: R.stats.msgUp, stored: Object.keys(localStorage).filter((k) => k.indexOf('flightline.lap') === 0).length };
  })));
  check(end.every((e) => e.me >= 1), 'both pages timed their own laps', end.map((e) => `${e.me} laps`).join(' + '));
  check(end.every((e) => e.peerLaps >= 1 && e.peerLap > 0), 'and heard the other’s lap time', end.map((e) => e.peerLap && e.peerLap.toFixed(2) + ' s').join(' + '));
  check(end.every((e) => e.stored >= 1), 'each kept its best lap as a ghost');
  check(end.every((e) => Math.abs(e.best - per) < per * 0.25), 'lap times are about right for the speed flown',
    end.map((e) => e.best.toFixed(2) + ' s').join(' + ') + ` vs ${per.toFixed(2)} s`);
  const perMsg = end[0].bytesUp / Math.max(1, end[0].msgUp);
  line(`     bandwidth a pilot: ${end[0].up} B/s up, ${end[0].down} B/s down at ${end[0].rate} states a second`);
  line(`     ${(end[0].bytesUp / 1024).toFixed(1)} KB in ${end[0].msgUp} messages = ${perMsg.toFixed(0)} B a message`);
  line(`     \u2192 ${((perMsg * 20) / 1024).toFixed(1)} KB/s a pilot at a full 20 Hz (headless frames are slower than a real browser\u2019s)`);
  check(end[0].up > 0 && perMsg * 20 < 4096, 'under 4 KB/s a pilot at 20 Hz', `${Math.round(perMsg * 20)} B/s`);

  line('');
  line('== Bumping ==');
  {
    // stop both drivers and freeze Bob, then fly Ann into where Bob is drawn
    await A.page.evaluate(() => { window.__flyStop = true; });
    await B.page.evaluate(() => { window.__flyStop = true; });
    await B.page.keyboard.press('p'); // Bob pauses: a still target that keeps broadcasting
    await new Promise((r) => setTimeout(r, 600));
    const bump = await A.page.evaluate(async () => {
      const F = window.__flightline;
      F.race.coll = 'bump';
      const step = () => new Promise((r) => requestAnimationFrame(() => r()));
      const other = () => F.avatars.find((a) => a.remote);
      if (!other()) return { err: 'nobody to bump' };
      let before = null, after = null, gap = null;
      for (let i = 0; i < 6 && !after; i++) {
        const p = other().st.p.slice();
        F.st.p[0] = p[0] - 0.6; F.st.p[1] = p[1]; F.st.p[2] = p[2]; // just inside touching distance
        F.st.v[0] = 4; F.st.v[1] = 0; F.st.v[2] = 0;                // closing on them
        before = F.st.v.slice();
        await step();
        const now = F.st.v.slice();
        gap = Math.hypot(F.st.p[0] - p[0], F.st.p[1] - p[1], F.st.p[2] - p[2]);
        if (Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]) > 1) after = now;
      }
      return { before, after, gap, coll: F.race.coll, phase: F.race.phase, crashed: F.st.crashed, held: F.st.held,
        b: F.AC().b, dist: (() => { const o = other().st.p, q = F.st.p; return Math.hypot(o[0] - q[0], o[1] - q[1], o[2] - q[2]); })() };
    });
    const moved = bump.after && bump.before ? Math.hypot(bump.after[0] - bump.before[0], bump.after[1] - bump.before[1], bump.after[2] - bump.before[2]) : 0;
    check(!bump.err && moved > 1, 'flying into another pilot knocks you off line',
      bump.err || `velocity changed by ${moved.toFixed(1)} m/s; ${bump.gap && bump.gap.toFixed(2)} m apart after` + (bump.after ? '' : ` [no bump: coll=${bump.coll} phase=${bump.phase} crashed=${bump.crashed} held=${bump.held} b=${bump.b} dist=${bump.dist && bump.dist.toFixed(2)}]`));
    await A.page.evaluate(() => { window.__flightline.race.coll = 'off'; });
    await B.page.keyboard.press('p');
  }

  line('');
  line('== Spectating ==');
  {
    await A.page.evaluate(() => {
      const F = window.__flightline;
      F.S.net.spec = true; F.race.r.me.spec = true; F.race.r.hello();
    });
    await A.page.click('#rcSpec');
    await new Promise((r) => setTimeout(r, 600));
    const spec = await A.page.evaluate(() => {
      const F = window.__flightline, w = F.race.watch;
      return { watch: w, name: w && F.race.r.peers.get(w).name, sent: F.race.r.stats.rate };
    });
    check(spec.watch && spec.name === 'Bob', 'a spectator can pick a pilot to ride along with', spec.name);
    await new Promise((r) => setTimeout(r, 1200));
    const quiet = await A.page.evaluate(() => window.__flightline.race.r.stats.rate);
    check(quiet === 0, 'and sends nothing while watching', `${quiet} states a second`);
    const seenBySpec = await B.page.evaluate(() => [...window.__flightline.race.r.peers.values()].map((p) => p.spec));
    check(seenBySpec.every(Boolean), 'the others know they are being watched, not raced');
  }

  line('');
  line('== Leaving ==');
  await B.page.click('#rcLeave');
  await A.page.waitForFunction(() => window.__flightline.race.r.peers.size === 0, null, { timeout: 8000 }).catch(() => {});
  check(await A.page.evaluate(() => window.__flightline.race.r.peers.size === 0), 'the room empties when a pilot leaves');
  check(await B.page.evaluate(() => !window.__flightline.race.r && document.querySelector('#race').hidden), 'and that page is back to flying alone');
  check(await B.page.evaluate(() => { const F = window.__flightline; return !F.st.crashed && F.world().gates.length === 8; }), 'the sim carries on as before');

  await browser.close();
  srv.close();
  relay.server.close();
  line('');
  line(bad ? `${bad} check(s) failed` : 'all checks passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { line('FAIL  ' + (e && e.stack || e)); process.exit(1); });
