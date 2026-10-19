/* The real page, in a real browser. Run: python3 tools/build.py && node test/browser_test.js

   Every other test in here cuts a pure block out of src/app.js and runs it in
   Node. That keeps them fast and keeps them honest, but it leaves out the three
   things most likely to break: the DOM, the Gamepad API, and the frame loop. A
   channel that is never created, a panel row whose listener is lost on a
   re-render, a slider that reads right but drives nothing - none of that can
   fail a Node test.

   So this one loads the built index.html in headless Chromium with a fake EdgeTX
   radio bolted onto navigator.getGamepads, works its sticks, switches, buttons
   and slider, and reads back what the sim did. It skips rather than fails when
   there is no Chromium to run, because it is the only test here that needs one.

   Three things about headless that are not obvious, and each of which looks
   exactly like a bug in the code under test:
     - WebGL falls back to software and is then refused unless you ask for it,
       so GLR.create returns null and the app stops before it starts.
     - requestAnimationFrame never fires with no compositor, so the frame loop
       never runs. The shim below stands in for it, and stops once the checks
       are done - otherwise virtual time keeps feeding a software-rendered 3-D
       sim until the whole budget is spent.
     - '#welcome .btn.primary, #welcome button' selects "Set up controller", not
       "Fly", because a comma list returns the first match in document order.
       That opens the guided setup, which correctly suppresses the switch scan.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BUDGET_MS = 90000;   // virtual time, not wall clock: the shim spends it 16 ms a frame
const TIMEOUT_MS = 300000; // wall clock, in case Chromium wedges

function findChromium() {
  const names = process.env.CHROMIUM ? [process.env.CHROMIUM]
    : ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'];
  for (const n of names) {
    const r = spawnSync(n, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return n;
  }
  return null;
}

// tools/build.py stamps the source hash into index.html; a stale page would test old code
function stale() {
  const files = ['physics.js', 'aircraft.js', 'tutorial.js', 'prompts.js', 'nav.js', 'render.js', 'terrain.js', 'maps.js', 'ghost.js', 'net.js', 'app.js'];
  const js = files.map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
  const want = crypto.createHash('sha1').update(js).digest('hex').slice(0, 8);
  const head = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').slice(0, 400);
  const m = /built by tools\/build\.py from src\/ \(([0-9a-f]+)\)/.exec(head);
  return m && m[1] !== want ? `${m[1]}, sources are ${want}` : null;
}

/* The frame loop. This has to run before the app registers its own, so it is
   injected right after <body>, ahead of the bundle. */
const SHIM = `<script>
(function () {
  let t = 0;
  window.requestAnimationFrame = (cb) => (window.__done ? 0 : setTimeout(() => { t += 16; cb(t); }, 1));
  window.cancelAnimationFrame = (id) => clearTimeout(id);
})();
</script>`;

/* The checks themselves, run in the page. A fake RadioMaster Zorro: four axes
   for the sticks, three carrying switches, one a slider, and eight buttons. AX
   and BT are mutated between frames to work the controls. */
const harness = (aircraftJson) => `<script>
const AX = [0, 0, 0, -1, -1, 0, 0, -1];   // 0..3 sticks, 4..6 switches, 7 slider
const BT = [false, false, false, false, false, false, false, false];
const PAD = { id: 'RadioMaster Zorro Joystick (Vendor: 1209 Product: 4f54)', index: 0, connected: true,
  mapping: '', timestamp: 0, get axes() { return AX; },
  get buttons() { return BT.map((p) => ({ pressed: p, value: p ? 1 : 0, touched: p })); } };
navigator.getGamepads = () => [PAD];

const L = [];
const say = (ok, what, extra) => L.push((ok ? ' ok  ' : 'FAIL ') + what + (extra ? '  ' + extra : ''));
const raf = (n) => new Promise((r) => { let i = 0; const go = () => (++i >= n ? r() : requestAnimationFrame(go)); requestAnimationFrame(go); });

(async () => {
 try {
  document.getElementById('wFly').click();
  await raf(5);
  const F = window.__flightline;

  // ---- the radio arrives ----
  const r = F.addFile(${JSON.stringify(aircraftJson)});
  say(r && r.ok, 'the blown wing loads', r && (r.id || (r.errors || []).join('; ')));
  await raf(5);
  const profs = F.IN().profiles.filter((p) => /Zorro/.test(p.name));
  say(profs.length === 1, 'the fake Zorro made one profile', profs.map((p) => p.name).join(', '));
  const P = profs[0] || { channels: [], axes: {}, devs: [] };
  say(P.channels.filter((c) => c.kind === 'button').length === 8, 'all eight buttons got a channel on sight', P.channels.length + ' channels');

  // map the sticks: until they are mapped there is no telling which axes are sticks,
  // and the switch scan holds off for exactly that reason
  for (const [k, i] of [['thr', 2], ['a', 0], ['e', 1], ['r', 3]])
    P.axes[k] = k === 'thr' ? { dev: P.devs[0], i, lo: -1, hi: 1 } : { dev: P.devs[0], i, c: 0, s: 1, k: 1 };
  await raf(5);

  // ---- switches, with no panel open: the thing that used to need Record ----
  const atAxis = (i) => P.channels.filter((c) => c.kind === 'axisVal' && c.i === i);
  AX[4] = 1; await raf(8);
  say(atAxis(4).length === 1, 'flipping a switch with no panel open makes a channel', atAxis(4).map((c) => c.i + '=' + c.v).join(', '));
  AX[4] = -1; await raf(8);
  say(atAxis(4).length === 2, 'and the way back makes the other position', atAxis(4).map((c) => c.i + '=' + c.v).join(', '));
  AX[5] = -1; await raf(8); AX[5] = 0; await raf(8); AX[5] = 1; await raf(8);
  say(atAxis(5).length === 3, 'a 3-position switch makes three, middle included');
  say(!P.channels.some((c) => c.kind === 'axisVal' && c.i < 4), 'and no channel came from a mapped stick');

  // ---- the panel: the live monitor, and binding a slider ----
  F.openCtl(); await raf(4);
  say(document.querySelectorAll('#ctlMon [data-ax]').length === 8, 'the monitor shows every axis', document.querySelectorAll('#ctlMon [data-ax]').length + ' rows');
  say(document.querySelectorAll('#ctlMon .pips i').length === 8, 'and every button');
  BT[2] = true; await raf(3);
  say(document.querySelectorAll('#ctlMon .pips i')[2].classList.contains('on'), 'a pressed button lights its pip');
  BT[2] = false;
  for (let v = -1; v <= 1.0001; v += 0.1) { AX[7] = Math.min(1, v); await raf(2); }
  AX[7] = -1; await raf(3);
  const btn = [...document.querySelectorAll('#ctlMon [data-slider]')].find((b) => b.dataset.slider.endsWith('|7'));
  say(btn && !btn.disabled && btn.textContent === 'Use as a slider', 'a swept axis offers itself as a slider', btn && btn.textContent);
  btn.click(); await raf(4);
  const an = P.channels.find((c) => c.kind === 'axisAn' && c.i === 7);
  say(!!an, 'binding it makes an analog channel', an && ('lo ' + an.lo.toFixed(2) + ', hi ' + an.hi.toFixed(2)));
  const opts = [...document.querySelector('#ac-' + an.id).options].map((o) => o.value);
  say(opts.join(',') === ',an-flaps,an-transition,an-cam', 'and it offers the analog actions, not the switch ones', opts.join(','));
  an.action = 'an-transition';
  F.closeCtl(); await raf(4);

  // ---- the camera mount, over a transition the sim actually flies ----
  F.setAircraft('blown-wing-twin'); await raf(6);
  const AC = F.AC(), st = F.st;
  say(AC.kind === 'vtol' && AC.trans.camHover === -10 && AC.trans.camFwd === -10, 'the file brought its two camera angles', JSON.stringify(F.camPair()));
  /* Drive it with the slider rather than setting st.fwd: the controller pulls
     st.fwd straight back toward whatever is commanded, so a forced value reads
     wrong a few frames later. */
  AX[7] = -1; await raf(200);
  const hov = F.camTilt();
  say(st.fwd < 0.01 && Math.abs(hov + 100) < 0.05, 'hovering, the mount sits 100° down from the nose', 'fwd ' + st.fwd.toFixed(3) + ', mount ' + hov.toFixed(2) + '°');
  AX[7] = 1; await raf(260);
  const fw = F.camTilt();
  say(st.fwd > 0.999, 'the slider at the far end drives the transition to forward flight', 'fwd ' + st.fwd.toFixed(4));
  say(Math.abs(fw + 13.5) < 0.1, 'and there the mount is 13.5° down from it', fw.toFixed(2) + '°');
  say(fw - hov > 80 && fw - hov < 95, 'so the transition swept it up through about 86°', (fw - hov).toFixed(1) + '°');
  AX[7] = -1; await raf(260);
  say(st.fwd < 0.001 && Math.abs(F.camTilt() + 100) < 0.05, 'and back at rest both come home to the hover', 'fwd ' + st.fwd.toFixed(4) + ', mount ' + F.camTilt().toFixed(2) + '°');

  /* ---- every aircraft's model notes, rendered ----
     A page of generated HTML with a row for everything an aircraft might have,
     and three of them now have very little in common: an autogyro has no pitch
     curves to print, a tip-driven rotor no tail rotor and no motor power, a
     gyrodyne two propellers where the tail rotor used to be. Rendering it for
     each one is the cheapest way to catch a field that is not there. */
  for (const id of F.acList()) {
    F.setAircraft(id); await raf(4);
    let html = '', err = null;
    try { html = F.notes(); } catch (e) { err = (e && e.message) || String(e); }
    const ac = F.AC();
    say(!err && html.length > 400 && !/undefined|NaN/.test(html), 'the model notes render for the ' + ac.name,
      err ? 'threw: ' + err : /undefined|NaN/.test(html) ? 'printed a missing field' : html.length + ' characters');
  }

  say(true, 'the page ran all of that without an exception');
 } catch (e) { say(false, 'threw: ' + ((e && e.stack) || e)); }
 window.__done = true;
 const pre = document.createElement('pre');
 pre.id = 'smoke';
 pre.textContent = L.join('\\n');
 document.body.appendChild(pre);
})();
</script>`;

// ---------------------------------------------------------------- run it
const bin = findChromium();
if (!bin) {
  console.log('skipped: no Chromium found. Install one, or point CHROMIUM at it.');
  process.exit(0);
}
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('no index.html: run python3 tools/build.py first');
  process.exit(1);
}
const old = stale();
if (old) {
  console.error(`index.html is stale (${old}): run python3 tools/build.py first`);
  process.exit(1);
}

const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const craft = fs.readFileSync(path.join(ROOT, 'aircraft', 'blown-wing-twin.json'), 'utf8');
const at = page.indexOf('<body>') + '<body>'.length;
const html = (page.slice(0, at) + '\n' + SHIM + page.slice(at)).replace('</body>', harness(craft) + '\n</body>');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightline-browser-'));
const file = path.join(dir, 'smoke.html');
fs.writeFileSync(file, html);

const run = spawnSync(bin, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',          // or WebGL is refused and the app never starts
  `--virtual-time-budget=${BUDGET_MS}`,
  '--dump-dom', 'file://' + file,
], { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
fs.rmSync(dir, { recursive: true, force: true });

if (run.error) { console.error(`could not run ${bin}: ${run.error.message}`); process.exit(1); }
const got = /<pre id="smoke">([\s\S]*?)<\/pre>/.exec(run.stdout || '');
if (!got) {
  console.error('the page never reported. Either it threw before the checks, or the frame loop never ran.');
  if (/id="err"/.test(run.stdout || '')) console.error('It showed the "could not start WebGL" panel, so this Chromium would not give it a context.');
  process.exit(1);
}
const lines = got[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').split('\n');
console.log('== the built page, in a browser, with a fake Zorro ==');
for (const l of lines) console.log(l);
const fails = lines.filter((l) => l.startsWith('FAIL')).length;
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
