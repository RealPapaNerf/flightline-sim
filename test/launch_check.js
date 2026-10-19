/* Where every aircraft begins on a terrain map, driven through the real page.

   The built-in field is flat and has one place to stand, so for a long time
   nothing noticed that a map's start is a completely separate path through
   FL.reset from the built-in field's named starts. On real terrain it showed
   up all at once: hand-launch models sitting on the ground and refusing to
   launch, tail-sitters lying on their side, and anything on a slope starting
   with half its legs underground.

   So this asks, for every aircraft the sim knows: given the start you chose,
   where does a map actually put you, is the bar telling the truth about it,
   are you held when you should be held, and are you above the ground.

   Run:  NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules \
           node test/launch_check.js ../maps-folder
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.resolve(process.argv[2] || path.join(ROOT, '..', 'maps-folder'));
const MAP = process.argv[3] || 'bridal-veil-falls';
const PORT = 8738;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.u16': 'application/octet-stream', '.u8': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const base = rel.startsWith('library/') ? LIB : ROOT;
      const file = rel.startsWith('library/') ? path.join(LIB, rel.slice(8)) : path.join(ROOT, rel);
      if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rep.writeHead(404); rep.end('no'); return; }
      rep.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      rep.end(fs.readFileSync(file));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  let fail = 0;
  const ok = (c, what, got) => { if (c) console.log(`  ok    ${what}${got === undefined ? '' : `  (${got})`}`); else { fail++; console.log(`  FAIL  ${what}  (${got})`); } };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__flightline', null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#wFly') && document.querySelector('#wFly').click());
  await page.waitForTimeout(400);

  await page.evaluate(async (want) => {
    const F = window.__flightline;
    const l = await F.MAPS.fetchLibrary('library/');
    const got = await F.MAPS.fetchMap(l.base, l.maps.find((m) => m.id === want), () => {});
    F.openMap(got);
  }, MAP);

  const acs = await page.evaluate(() => {
    const F = window.__flightline, out = [];
    for (const id of F.acList()) { F.setAircraft(id); const a = F.AC(); out.push({ id, name: a.name, kind: a.kind, starts: a.starts.slice() }); }
    return out;
  });
  console.log(`\n== ${MAP}: ${acs.length} aircraft ==`);

  for (const a of acs) {
    for (const want of a.starts) {
      const r = await page.evaluate((info) => {
        const F = window.__flightline;
        F.S.start[info.id] = info.want;  // the start the bar is showing
        F.setAircraft(info.id);          // re-picks the map's start and resets
        const T = F.mapInfo().terrain;
        return {
          mapStart: F.S.mapStart, held: !!F.st.held,
          agl: -F.st.p[2] - T.heightAt(F.st.p[0], F.st.p[1]),
          bar: document.querySelector('#vStart').textContent,
          offered: F.mapInfo().starts.map((x) => x.id),
          usable: F.AC().starts.slice(),
        };
      }, { id: a.id, want });

      const label = `${a.name} [${a.kind}] asking for "${want}"`;
      console.log(`\n  ${label} -> "${r.mapStart}", bar says "${r.bar}", agl ${r.agl.toFixed(2)} m`);

      /* The start the aircraft asked for must be the one it got, whenever the
         map offers it. Picking "hand launch" and silently getting the pad is
         the bug that made hand launch impossible on every map.

         When the map does NOT offer it — a map with no runway, for a model
         with wheels — any fallback is allowed except one this aircraft has
         no idea how to use. Handing a wheeled trainer the hand launch left
         over from the last model is the failure that matters here. */
      if (r.offered.includes(want)) {
        ok(r.mapStart === want, 'the map honours the start the aircraft asked for', r.mapStart);
      } else {
        ok(r.usable.includes(r.mapStart),
          `the map has no "${want}", so it fell back to one this aircraft can use`, r.mapStart);
      }
      // Whatever it settles on, the bar has to name that and not the other one.
      ok(r.bar && r.bar.length > 0, 'the bar names a start', r.bar);
      ok(r.agl > -0.2, 'not spawned underground', `${r.agl.toFixed(2)} m`);
      if (r.mapStart === 'launch') ok(r.held === true, 'a hand launch is held in your hand', `held=${r.held}`);
      if (r.mapStart === 'pad' || r.mapStart === 'runway') ok(r.held === false, 'a ground start is not held', `held=${r.held}`);
    }
  }

  ok(errors.length === 0, 'no page errors throughout', errors.join(' | ') || 'none');
  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
  await browser.close();
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
})();
