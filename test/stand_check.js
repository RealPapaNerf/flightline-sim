/* Where you stand, driven through the real page.

   The stand point is a setting rather than a property of the map, and the
   thing that can quietly go wrong is partial movement: the camera moves and
   the windsock does not, or the density altitude keeps reading the elevation
   of a spot you left. So this presses the key a player presses and then
   checks everything that is supposed to be "you" came along.

   Run:  NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules \
           node test/stand_check.js ../maps-folder
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.resolve(process.argv[2] || path.join(ROOT, '..', 'maps-folder'));
const PORT = 8733;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.u16': 'application/octet-stream', '.u8': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

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

const MAP = 'zion-canyon';

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  let fail = 0;
  const ok = (cond, what, got) => { if (cond) console.log(`  ok    ${what}${got === undefined ? '' : `  (${got})`}`); else { fail++; console.log(`  FAIL  ${what}  (${got})`); } };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__flightline', null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#wFly') && document.querySelector('#wFly').click());
  await page.waitForTimeout(600);

  const open = async (id) => page.evaluate(async (want) => {
    const F = window.__flightline;
    const l = await F.MAPS.fetchLibrary('library/');
    const got = await F.MAPS.fetchMap(l.base, l.maps.find((m) => m.id === want), () => {});
    const m = F.openMap(got);
    return { pilot: { n: m.pilot.n, e: m.pilot.e, up: m.pilot.up }, base: m.basePilot, sel: m.standSel, elevFt: F.S.elevFt, sites: m.sites.length };
  }, id);

  console.log(`\n== ${MAP}: where the map puts you ==`);
  const a = await open(MAP);
  console.log(`  stand ${a.pilot.n}, ${a.pilot.e} (up ${a.pilot.up.toFixed(1)} m), density-altitude setting ${a.elevFt} ft`);
  ok(a.sel === 'map', 'a fresh map stands you where the document says', a.sel);
  ok(a.pilot.n === a.base.n && a.pilot.e === a.base.e, 'and that is the document\'s own pilot spot');

  // Somewhere definitely else: 1.2 km north-east of the centre.
  console.log('\n== fly somewhere and press B ==');
  const target = { n: a.base.n + 1200, e: a.base.e + 800 };
  // Pause first: an unlaunched model is held at its start, so the physics
  // step would put the aircraft back before the keypress was read.
  await page.keyboard.press('p');
  await page.waitForTimeout(150);
  await page.evaluate((t) => { const F = window.__flightline; F.st.p[0] = t.n; F.st.p[1] = t.e; }, target);
  await page.keyboard.press('b');
  await page.waitForTimeout(300);

  const b = await page.evaluate(() => {
    const F = window.__flightline, m = F.mapInfo();
    // the windsock is built into the world from the stand point, so finding
    // it where the new stand point is proves the world was rebuilt, not just
    // the camera moved
    const sock = F.world().obstacles.filter((o) => o.k === 'cyl' && o.r === 0.2);
    return {
      pilot: { n: m.pilot.n, e: m.pilot.e, up: m.pilot.up }, sel: m.standSel, elevFt: F.S.elevFt,
      sock: sock.length ? { x: sock[0].x, z: sock[0].z } : null,
      datum: m.datumElevM,
    };
  });
  console.log(`  stand ${b.pilot.n}, ${b.pilot.e} (up ${b.pilot.up.toFixed(1)} m), density-altitude setting ${b.elevFt} ft`);
  ok(b.pilot.n === target.n && b.pilot.e === target.e, 'the stand point is where the aircraft was', `${b.pilot.n}, ${b.pilot.e}`);
  ok(b.sel === 'custom', 'and it is recorded as a custom point', b.sel);
  ok(b.elevFt !== a.elevFt, 'density altitude followed the ground you moved to', `${a.elevFt} -> ${b.elevFt} ft`);
  ok(b.sock !== null && Math.abs(b.sock.x - (target.e + 20)) < 0.5 && Math.abs(b.sock.z - (-target.n - 24)) < 0.5,
    'the windsock was rebuilt beside the new stand point', b.sock ? `${b.sock.x.toFixed(0)}, ${b.sock.z.toFixed(0)}` : 'no sock');

  console.log('\n== a reset puts the model at your feet, not back at the old spot ==');
  const r = await page.evaluate(() => { const F = window.__flightline; F.doReset(); return { n: F.st.p[0], e: F.st.p[1] }; });
  const away = Math.hypot(r.n - target.n, r.e - target.e);
  console.log(`  reset to ${r.n.toFixed(0)}, ${r.e.toFixed(0)} — ${away.toFixed(0)} m from where you stand`);
  ok(away < 30, 'the pilot-anchored start came with you', `${away.toFixed(0)} m`);

  console.log('\n== it is remembered, per map ==');
  await open(MAP);
  const c = await page.evaluate(() => { const m = window.__flightline.mapInfo(); return { n: m.pilot.n, e: m.pilot.e, sel: m.standSel }; });
  ok(c.n === target.n && c.e === target.e && c.sel === 'custom', 'reopening the map stands you where you left off', `${c.n}, ${c.e}`);

  const other = await open('timpanogos');
  ok(other.sel === 'map', 'a different map is untouched by it', other.sel);

  console.log('\n== going back to the map\'s own spot ==');
  // Against MAP by name: timpanogos is the map that happens to be open here,
  // and writing the setting against the open map instead of the named one is
  // exactly the bug this line used to have.
  await page.evaluate((id) => { window.__flightline.S.mapStand[id] = { sel: 'map' }; }, MAP);
  await open(MAP);
  const d = await page.evaluate(() => { const m = window.__flightline.mapInfo(); return { n: m.pilot.n, e: m.pilot.e, sel: m.standSel }; });
  ok(d.sel === 'map' && d.n === a.base.n && d.e === a.base.e, 'selecting "where the map puts you" goes back', `${d.n}, ${d.e}`);

  ok(errors.length === 0, 'no page errors throughout', errors.join(' | ') || 'none');
  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
  await browser.close();
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
})();
