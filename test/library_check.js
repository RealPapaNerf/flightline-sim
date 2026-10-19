/* Load every map in a local library through the real page, in headless
   Chromium, and report what the sim makes of it.

   This is the check that the map builder and the sim still agree. The unit
   tests prove the decode against a synthetic fixture whose answer is known;
   this proves a map built from live USGS data opens, has no consistency
   warnings, and lands at the elevations the builder said it would.

   Run:  NODE_PATH=../Frag-Zone-Discount-Warfare/node_modules \
           node test/library_check.js ../maps-folder [outDir]
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.resolve(process.argv[2] || path.join(ROOT, '..', 'maps-folder'));
const OUT = process.argv[3] || path.join(ROOT, 'dist', 'library-shots');
const PORT = 8732;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.u16': 'application/octet-stream', '.u8': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = rel.startsWith('library/') ? path.join(LIB, rel.slice(8)) : path.join(ROOT, rel);
      const base = rel.startsWith('library/') ? LIB : ROOT;
      if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rep.writeHead(404); rep.end('no'); return; }
      rep.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      rep.end(fs.readFileSync(file));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  let fail = 0;
  const ok = (cond, what, got) => { if (cond) console.log(`  ok    ${what}${got === undefined ? '' : `  (${got})`}`); else { fail++; console.log(`  FAIL  ${what}  (${got})`); } };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__flightline', null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#wFly') && document.querySelector('#wFly').click());
  await page.waitForTimeout(800);

  const lib = await page.evaluate(async () => {
    const l = await window.__flightline.MAPS.fetchLibrary('library/');
    return { name: l.name, maps: l.maps.map((m) => ({ id: m.id, kind: m.kind || 'terrain' })) };
  });
  console.log(`\n== ${lib.name}: ${lib.maps.length} entries ==`);

  const terrain = lib.maps.filter((m) => m.kind === 'terrain');
  for (const entry of terrain) {
    console.log(`\n-- ${entry.id} --`);
    const r = await page.evaluate(async (id) => {
      const F = window.__flightline;
      const l = await F.MAPS.fetchLibrary('library/');
      const e = l.maps.find((m) => m.id === id);
      const got = await F.MAPS.fetchMap(l.base, e, () => {});
      const m = F.openMap(got);
      return {
        name: m.name, warnings: m.warnings,
        cols: m.terrain.cols, rows: m.terrain.rows, cell: m.terrain.cell,
        minUp: m.terrain.minUp, maxUp: m.terrain.maxUp,
        field: m.fieldElevM, chunks: m.terrain.chunkCount,
        hasImage: !!got.image, starts: (m.starts || []).length,
        pilot: m.pilot ? { n: m.pilot.n, e: m.pilot.e } : null,
      };
    }, entry.id);
    console.log(`  ${r.name}: ${r.cols}x${r.rows} at ${r.cell} m, ${Math.round(r.maxUp - r.minUp)} m of relief, field ${Math.round(r.field)} m`);
    console.log(`  ${r.chunks} chunks, imagery ${r.hasImage ? 'yes' : 'no'}, ${r.starts} launch points`);
    ok(r.warnings.length === 0, 'no consistency warnings', JSON.stringify(r.warnings));
    ok(r.chunks > 0, 'the terrain built chunks', r.chunks);

    for (let i = 0; i < 60; i++) await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${entry.id}.png`) });
  }

  ok(errors.length === 0, 'no page errors across the whole library', errors.join(' | ') || 'none');
  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} — screenshots in ${OUT}`);
  await browser.close();
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
})();
