/* Load the real page in headless Chromium, fly the synthetic map, screenshot
   it, and count what the terrain actually costs.

   Run: node test/fixture_map.js && node test/screenshot.js [outDir]

   A note on what this can and cannot measure. The renderer here is
   SwiftShader, which rasterises on the CPU. It proves the page builds a
   context, compiles the shaders, loads a map and draws the terrain, the pads,
   the obstacles and the OSD without a GL error — which is the thing worth
   proving automatically. It says **nothing** about frame rate on a Chromebook,
   because a software rasteriser's pixel throughput has no relationship to a
   real GPU's. The numbers that do carry over are the ones below that are
   hardware-independent: triangles submitted, draw calls, buffer bytes, and the
   CPU time spent choosing levels of detail and building chunk meshes.
*/
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'shots');
const PORT = 8731;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.u16': 'application/octet-stream', '.u8': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { rep.writeHead(404); rep.end('no'); return; }
      rep.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      rep.end(fs.readFileSync(file));
    });
    srv.listen(PORT, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(path.join(ROOT, 'maps', 'synthetic-ridge', 'map.json'))) {
    console.error('No fixture map. Run: node test/fixture_map.js');
    process.exit(1);
  }
  const srv = await serve();
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });

  let fail = 0;
  const ok = (cond, what, got) => { if (cond) console.log(`  ok    ${what}${got === undefined ? '' : `  (${got})`}`); else { fail++; console.log(`  FAIL  ${what}  (${got})`); } };

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.__flightline', null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#wFly') && document.querySelector('#wFly').click());
  await page.waitForTimeout(1200);

  const gl = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const g = c && (c.getContext('webgl') || c.getContext('experimental-webgl'));
    return g ? { renderer: g.getParameter(g.RENDERER), vendor: g.getParameter(g.VENDOR), err: g.getError() } : null;
  });
  console.log(`\n== Context ==\n  ${gl ? `${gl.vendor} / ${gl.renderer}` : 'NO WEBGL CONTEXT'}`);
  ok(!!gl, 'the page got a WebGL context');
  ok(gl && gl.err === 0, 'no GL error after the first frames', gl && `glGetError = ${gl.err}`);

  console.log('\n== The built-in field (unchanged) ==');
  const flat = await page.evaluate(() => {
    const F = window.__flightline;
    return { map: F.mapInfo(), flat: F.terrain().isFlat, agl: F.agl(), tris: F.terrainStats().tris, z: F.st.p[2] };
  });
  ok(flat.map === null, 'no map is loaded by default', 'built-in field');
  ok(flat.flat === true, 'the terrain is the flat one', 'TERRAIN.FLAT');
  ok(flat.tris === 0, 'no terrain chunks are drawn', `${flat.tris} triangles`);
  await page.screenshot({ path: path.join(OUT, '01-builtin-field.png') });

  console.log('\n== Loading the synthetic map ==');
  const loaded = await page.evaluate(async () => {
    const F = window.__flightline;
    const lib = await F.MAPS.fetchLibrary('maps/');
    const got = await F.MAPS.fetchMap(lib.base, lib.maps[0], () => {});
    const m = F.openMap(got);
    return {
      name: m.name, warnings: m.warnings,
      cols: m.terrain.cols, rows: m.terrain.rows, cell: m.terrain.cell,
      minUp: m.terrain.minUp, maxUp: m.terrain.maxUp,
      chunkCount: m.terrain.chunkCount, obstacles: F.world().obstacles.length, gates: F.world().gates.length,
      elevFt: F.S.elevFt, field: m.fieldElevM,
    };
  });
  console.log(`  ${loaded.name}: ${loaded.cols}x${loaded.rows} posts at ${loaded.cell} m, ${loaded.chunkCount} chunks, ${Math.round(loaded.maxUp - loaded.minUp)} m of relief`);
  console.log(`  ${loaded.obstacles} collision shapes, ${loaded.gates} course gates, field elevation ${loaded.field} m -> density-altitude setting ${loaded.elevFt} ft`);
  ok(loaded.warnings.length === 0, 'the map loads with no consistency warnings', JSON.stringify(loaded.warnings));
  ok(loaded.chunkCount === 64, '64 terrain chunks', loaded.chunkCount);
  ok(loaded.obstacles > 200, 'the obstacles came across', `${loaded.obstacles} shapes`);

  // let the level of detail settle: one chunk is promoted per frame by design
  for (let i = 0; i < 90; i++) await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.waitForTimeout(400);

  console.log('\n== What a frame costs, where it is hardware-independent ==');
  const cost = await page.evaluate(() => {
    const F = window.__flightline, s = F.terrainStats();
    const hist = [0, 0, 0, 0];
    for (const l of s.lods) hist[l]++;
    // CPU cost of the two things terrain adds to a frame
    const T = F.terrain();
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) T.chunkMesh(i % T.chunkCount, 0);
    const buildMs = (performance.now() - t0) / 200;
    const p = F.TERRAIN.newProbe();
    const t1 = performance.now();
    for (let i = 0; i < 200000; i++) T.probe(((i * 7919) % 2000) - 1000, ((i * 104729) % 2000) - 1000, p);
    const probeNs = ((performance.now() - t1) * 1e6) / 200000;
    return { ...s, hist, buildMs, probeNs, agl: F.agl(), z: F.st.p[2] };
  });
  console.log(`  level of detail across the 64 chunks: ${cost.hist.map((n, i) => `lod ${i}: ${n}`).join(', ')}`);
  console.log(`  drawn last frame: ${cost.chunks} chunks, ${cost.tris.toLocaleString()} triangles`);
  console.log(`  height probe ${cost.probeNs.toFixed(1)} ns; one full-detail chunk rebuild ${cost.buildMs.toFixed(2)} ms`);
  ok(cost.tris > 0, 'terrain is actually being drawn', `${cost.tris.toLocaleString()} triangles`);
  ok(cost.tris <= 150000, 'inside the 150k triangle budget', `${cost.tris.toLocaleString()} of 150,000`);
  ok(cost.buildMs < 16, 'a chunk rebuild fits in a 60 fps frame', `${cost.buildMs.toFixed(2)} ms`);
  ok(cost.hist[0] >= 1 && cost.hist[0] <= 9, 'only a few chunks are at full detail', `${cost.hist[0]} chunks`);

  console.log('\n== The queries, in the running page ==');
  const q = await page.evaluate(() => {
    const F = window.__flightline, T = F.terrain();
    const out = {};
    // the pilot stands on the ground, not in it
    const pu = T.heightAt(F.mapInfo().pilot.n, F.mapInfo().pilot.e);
    out.pilotUp = pu;
    // radio: down in the bowl behind the ridge, versus up high
    const look = (n, e, aglM) => {
      F.st.p[0] = n; F.st.p[1] = e; F.st.p[2] = -(T.heightAt(n, e) + aglM);
      return F.world() && { lq: null };
    };
    look(500, 0, 5);
    const o = {};
    T.ray(0, 0, pu + 1.5, 500, 0, T.heightAt(500, 0) + 5, o);
    out.behindRidge = { hit: o.hit, at: o.n };
    T.ray(0, 0, pu + 1.5, 500, 0, T.heightAt(500, 0) + 300, o);
    out.highOver = { hit: o.hit, minGap: o.minGap };
    return out;
  });
  console.log(`  the pilot stands at up = ${q.pilotUp.toFixed(2)} m`);
  console.log(`  5 m over the ground 500 m north: ${q.behindRidge.hit ? `blocked by the ridge at n = ${q.behindRidge.at.toFixed(0)} m` : 'clear'}`);
  console.log(`  300 m over the same spot: ${q.highOver.hit ? 'blocked' : `clear, closest approach ${q.highOver.minGap.toFixed(0)} m`}`);
  ok(q.behindRidge.hit, 'the ridge blocks the low shot', `hit at n = ${q.behindRidge.at.toFixed(0)}`);
  ok(!q.highOver.hit, 'and not the high one', `${q.highOver.minGap.toFixed(0)} m of clearance`);

  console.log('\n== Screenshots ==');
  const shots = [
    ['02-map-los', 'ridge', '1'],
    ['03-map-fpv', 'ridge', '2'],
    ['04-map-split', 'air', '3'],
    ['05-pad-view', 'pad', '1'],
  ];
  for (const [name, start, view] of shots) {
    await page.evaluate(([st, v]) => {
      const F = window.__flightline;
      F.S.mapStart = st; F.S.view = v;
      F.doReset();
      const key = { 1: 'Digit1', 2: 'Digit2', 3: 'Digit3' }[v];
      window.dispatchEvent(new KeyboardEvent('keydown', { code: key, key: v }));
    }, [start, view]);
    for (let i = 0; i < 25; i++) await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.waitForTimeout(250);
    const f = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: f });
    const kb = (fs.statSync(f).size / 1024).toFixed(0);
    console.log(`  ${name}.png  ${kb} KB`);
    ok(fs.statSync(f).size > 20000, `${name} is not a blank frame`, `${kb} KB of PNG`);
  }

  /* The settings panel builds its own DOM, and nothing else here touches it,
     so a typo in the Map tab would ship silently. Open it and look. */
  console.log('\n== The Map tab in Settings ==');
  const panel = await page.evaluate(() => {
    const F = window.__flightline;
    F.S.sheetTab = 'map';
    document.querySelector('#bSettings').click();
    const box = document.querySelector('#mapBox');
    if (!box) return { built: false };
    return {
      built: true,
      flying: (box.querySelector('.kv span:last-child') || {}).textContent || '',
      buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
      libValue: (box.querySelector('#mpLib') || {}).value || '(no field)',
      hasPicker: !!box.querySelector('#mpFiles'),
      status: (box.querySelector('.help') || {}).textContent || '',
    };
  });
  ok(panel.built, 'the Map tab builds', panel.built ? 'yes' : 'no #mapBox');
  if (panel.built) {
    console.log(`  flying:  ${panel.flying}`);
    console.log(`  buttons: ${panel.buttons.join(' | ')}`);
    console.log(`  library: ${panel.libValue}`);
    ok(panel.hasPicker, 'the folder picker is there', 'yes');
    ok(panel.buttons.some((b) => /folder/i.test(b)), 'it offers a folder', panel.buttons.join(', '));
    ok(/Synthetic ridge/.test(panel.flying), 'it names the map being flown', panel.flying);
  }
  await page.screenshot({ path: path.join(OUT, '07-map-settings.png') });
  await page.evaluate(() => document.querySelector('#shClose').click());
  await page.waitForTimeout(200);

  console.log('\n== Back to the built-in field ==');
  const back = await page.evaluate(() => {
    const F = window.__flightline;
    F.closeMap();
    return { map: F.mapInfo(), flat: F.terrain().isFlat, tris: F.terrainStats().tris, obstacles: F.world().obstacles.length };
  });
  for (let i = 0; i < 20; i++) await page.evaluate(() => new Promise(requestAnimationFrame));
  ok(back.map === null && back.flat, 'the built-in field comes back', 'flat again');
  ok(back.obstacles > 100, 'and so does its obstacle course', `${back.obstacles} shapes`);
  await page.screenshot({ path: path.join(OUT, '06-back-to-field.png') });

  const glEnd = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const g = c.getContext('webgl') || c.getContext('experimental-webgl');
    return g.getError();
  });
  ok(glEnd === 0, 'still no GL error at the end', `glGetError = ${glEnd}`);
  ok(errors.length === 0, 'no uncaught page errors', errors.length ? errors.join(' | ') : 'none');
  if (logs.length) console.log(`\n  console warnings/errors:\n${logs.map((l) => `    ${l}`).join('\n')}`);

  await browser.close();
  srv.close();
  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`} — screenshots in ${OUT}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
