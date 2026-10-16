/* =====================================================================
   Flightline app: world, aircraft models, cameras, OSD, input, UI, loop.
   Depends on FL (physics.js) and GLR (render.js).
   Render world is Y-up: x = east, y = up, z = south. The pilot stands at
   the origin facing north (-z). The runway runs east–west 12 m north of him.
   ===================================================================== */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const DT = 1 / 400;
  const { M4, Geo } = GLR;
  const clamp = FL.clamp;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const scl = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

  /* ---------------------------------------------------------------- settings */
  const SKEY = 'flightline.settings.v1', RKEY = 'flightline.radio.v1';
  const DEF = {
    aircraft: 'goblin', view: 'los', splitSwap: false, mode: 'manual',
    start: { goblin: 'launch', trainer: 'runway' },
    losZoom: 'mild', fpvFov: 110, fpvTilt: 5, osd: 'full', losInfo: true, stallCue: false,
    stickMode: '2', touch: 'auto',
    rates: { a: 100, e: 100, r: 100 }, expo: { a: 25, e: 20, r: 15 },
    windSpd: 2, windDir: 90, gust: 30, elevFt: 0, tempF: 59,
    battery: true, crashes: true, autoReset: true,
    quality: 1, scenery: 'med', aa: false, fps: false, eng: false, sound: true, units: 'imp',
  };
  const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
  const S = JSON.parse(JSON.stringify(DEF));
  {
    const sv = load(SKEY);
    if (sv && typeof sv === 'object')
      for (const k of Object.keys(DEF)) if (k in sv) S[k] = DEF[k] && typeof DEF[k] === 'object' ? Object.assign({}, DEF[k], sv[k]) : sv[k];
  }
  if (!FL.DEFS[S.aircraft]) S.aircraft = 'goblin';
  let radioMap = load(RKEY);
  const saveS = () => store(SKEY, S);

  const U = {
    alt: (m) => (S.units === 'imp' ? `${Math.round(m * 3.2808)} ft` : `${Math.round(m)} m`),
    spd: (v) => (S.units === 'imp' ? `${Math.round(v * 2.23694)} mph` : `${Math.round(v * 3.6)} km/h`),
    dist: (m) => (S.units === 'imp' ? `${Math.round(m * 3.2808)} ft` : `${Math.round(m)} m`),
    wind: (v) => (S.units === 'imp' ? `${(v * 2.23694).toFixed(0)} mph` : `${v.toFixed(1)} m/s`),
  };
  const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  /* ---------------------------------------------------------------- aircraft */
  const ACS = {};
  for (const id of Object.keys(FL.DEFS)) ACS[id] = FL.build(FL.DEFS[id]);
  let AC = ACS[S.aircraft];
  const START_LABEL = { launch: 'Hand launch', runway: 'Runway', air: 'In the air' };
  const startOf = (id) => (ACS[id].starts.includes(S.start[id]) ? S.start[id] : ACS[id].starts[0]);

  /* ---------------------------------------------------------------- renderer */
  const stage = $('#stage'), canvas = $('#gl'), osd = $('#osd'), ctx = osd.getContext('2d');
  let R = null;
  try { R = GLR.create(canvas, S.aa); } catch (e) { console.error(e); }
  if (!R) {
    stage.insertAdjacentHTML('beforeend', '<div id="err"><p>This browser could not start WebGL, so the 3-D view can’t run.<br>In Chrome, open chrome://gpu and check that hardware acceleration is on.</p></div>');
    return;
  }
  const gl = R.gl, L = R.L;
  const FOG = [0.79, 0.86, 0.92];
  {
    const sun = [0.35, 0.85, 0.4], l = Math.hypot(...sun);
    gl.uniform3fv(L.uSun, sun.map((v) => v / l));
    gl.uniform3fv(L.uSkyAmb, [0.52, 0.56, 0.62]);
    gl.uniform3fv(L.uGndAmb, [0.34, 0.31, 0.27]);
    gl.uniform3fv(L.uFog, FOG);
    gl.uniform2fv(L.uFogRange, [350, 2700]);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE);
    gl.clearColor(FOG[0], FOG[1], FOG[2], 1); gl.clearStencil(0);
  }

  /* ---------------------------------------------------------------- procedural helpers */
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function hash2(x, y) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
  function vnoise(x, y, P) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const w = (v) => (P ? ((v % P) + P) % P : v);
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(w(xi), w(yi)), b = hash2(w(xi + 1), w(yi)), c = hash2(w(xi), w(yi + 1)), d = hash2(w(xi + 1), w(yi + 1));
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const fbm = (x, y) => vnoise(x, y) * 0.5 + vnoise(x * 2.07 + 5.1, y * 2.07 - 3.3) * 0.3 + vnoise(x * 4.3 - 1.7, y * 4.3 + 8.2) * 0.2;

  function grassTexture() {
    const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d'), img = g.createImageData(N, N), rnd = mulberry32(7);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const stripe = x < N / 2 ? 1.0 : 0.9; // mowing stripes, 4 m wide (tile = 8 m)
      const blotch = 0.9 + 0.1 * vnoise(x / 16, y / 16, N / 16);
      const v = 255 * stripe * blotch * (0.82 + 0.18 * rnd());
      const i = (y * N + x) * 4;
      img.data[i] = v * 0.98; img.data[i + 1] = v; img.data[i + 2] = v * 0.93; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function runwayTexture() {
    const W = 1024, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), rnd = mulberry32(3);
    g.fillStyle = '#5a5d60'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) { const v = 70 + rnd() * 50; g.fillStyle = `rgb(${v},${v + 2},${v + 4})`; g.fillRect(rnd() * W, rnd() * H, 2, 2); }
    g.fillStyle = '#e9ecee';
    g.fillRect(0, 5, W, 3); g.fillRect(0, H - 8, W, 3); // edge lines
    for (let x = 110; x < W - 110; x += 52) g.fillRect(x, H / 2 - 2, 26, 4); // centre dashes (3 m)
    for (const x0 of [10, W - 58]) for (let k = 0; k < 6; k++) g.fillRect(x0, 16 + k * 17, 48, 9); // threshold bars
    g.font = '700 46px "Chakra Petch", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.save(); g.translate(92, H / 2); g.rotate(Math.PI / 2); g.fillText('09', 0, 0); g.restore();
    g.save(); g.translate(W - 92, H / 2); g.rotate(-Math.PI / 2); g.fillText('27', 0, 0); g.restore();
    return c;
  }
  const grassTex = GLR.texture(R, grassTexture());
  const runwayTex = GLR.texture(R, runwayTexture());

  /* ---------------------------------------------------------------- world */
  const C = {
    near: [0.42, 0.56, 0.25], far: [0.63, 0.58, 0.41], tree: [0.2, 0.37, 0.17], tree2: [0.27, 0.41, 0.2], juniper: [0.31, 0.4, 0.27],
    trunk: [0.36, 0.26, 0.17], bush: [0.45, 0.48, 0.3], sage: [0.56, 0.58, 0.45], mesa: [[0.73, 0.42, 0.3], [0.79, 0.5, 0.36], [0.66, 0.37, 0.27]],
    post: [0.5, 0.44, 0.36], rope: [1.0, 0.5, 0.1], orange: [1.0, 0.45, 0.1], white: [0.94, 0.94, 0.95], wall: [0.76, 0.73, 0.67], roof: [0.55, 0.2, 0.18],
    blue: [0.15, 0.5, 0.82], mat: [0.2, 0.21, 0.22],
  };
  const SOCK_POS = [20, 4.1, -24];
  let world = null; // { ground, runway, decal, scenery, obstacles }

  function buildWorld(density) {
    const counts = { low: [110, 160], med: [240, 420], high: [420, 800] }[density] || [240, 420];
    const rnd = mulberry32(1234);
    const obstacles = [];
    // ground: grid with cells that grow away from the pilot, vertex-coloured
    const gg = new Geo(), N = 72, EXT = 3200;
    const map = (u) => Math.sign(u) * EXT * u * u;
    const colAt = (x, z) => {
      const d = Math.hypot(x, z + 12);
      const base = mixc(C.near, C.far, smooth(220, 900, d));
      const k = 0.8 + 0.34 * fbm(x / 160 + 9, z / 160 - 4);
      return scl(base, k);
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const x0 = map(-1 + (2 * i) / N), x1 = map(-1 + (2 * (i + 1)) / N), z0 = map(-1 + (2 * j) / N), z1 = map(-1 + (2 * (j + 1)) / N);
      const a = [x0, 0, z0], b = [x1, 0, z0], c = [x1, 0, z1], d = [x0, 0, z1];
      gg.triV(a, c, b, colAt(x0, z0), colAt(x1, z1), colAt(x1, z0));
      gg.triV(a, d, c, colAt(x0, z0), colAt(x0, z1), colAt(x1, z1));
    }
    // runway (uv mapped) and the pilot's mat
    const gr = new Geo();
    gr.quad([-60, 0, -17], [60, 0, -17], [60, 0, -7], [-60, 0, -7], [1, 1, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
    const gd = new Geo();
    gd.quad([-1.5, 0, -1.2], [1.5, 0, -1.2], [1.5, 0, 1.2], [-1.5, 0, 1.2], C.mat);
    for (const x of [-1.5, 1.45]) gd.quad([x, 0, -1.2], [x + 0.05, 0, -1.2], [x + 0.05, 0, 1.2], [x, 0, 1.2], C.orange);

    const g = new Geo(rnd); g.jit = 0.14;
    const clearOf = (x, z, pad) => Math.abs(z + 12) > pad + 6 || Math.abs(x) > 70 + pad; // runway strip
    // trees
    let placed = 0, tries = 0;
    while (placed < counts[0] && tries++ < 6000) {
      const ang = rnd() * Math.PI * 2, r = 120 + Math.pow(rnd(), 0.8) * 850;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      if (Math.abs(z + 12) < 45 && Math.abs(x) < 450) continue; // keep the approach corridors open
      const h = 5 + rnd() * 7, cr = 1.6 + rnd() * 2.2, kind = rnd();
      g.cyl(x, 0, z, 0.25, 0.18, h * 0.35, 5, C.trunk, false);
      if (kind < 0.45) { g.cyl(x, h * 0.25, z, cr, 0, h * 0.55, 7, C.tree); g.cyl(x, h * 0.55, z, cr * 0.7, 0, h * 0.45, 7, C.tree2); }
      else if (kind < 0.8) g.blob(x, h * 0.62, z, cr, h * 0.42, cr, kind < 0.62 ? C.tree2 : C.tree);
      else g.blob(x, h * 0.45, z, cr * 0.75, h * 0.45, cr * 0.75, C.juniper);
      obstacles.push({ x, z, r: cr * 0.75, h });
      placed++;
    }
    // bushes and sage (low, no collision)
    for (let i = 0; i < counts[1]; i++) {
      const ang = rnd() * Math.PI * 2, r = 18 + Math.pow(rnd(), 1.4) * 600;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      if (!clearOf(x, z, 4) || Math.hypot(x, z) < 12) continue;
      const s = 0.3 + rnd() * 0.7;
      g.blob(x, s * 0.35, z, s * (0.8 + rnd() * 0.5), s * 0.55, s * (0.8 + rnd() * 0.5), rnd() < 0.5 ? C.bush : C.sage);
    }
    // mesas on the horizon
    g.jit = 0.06;
    for (let i = 0; i < 17; i++) {
      const ang = (i / 17) * Math.PI * 2 + rnd() * 0.25, r = 1750 + rnd() * 800;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r, rad = 110 + rnd() * 230, h = 45 + rnd() * 120;
      const col = C.mesa[i % 3];
      g.cyl(x, 0, z, rad, rad * 0.86, h, 7, col, true, rnd());
      if (rnd() < 0.55) g.cyl(x + rad * 0.2, h, z - rad * 0.1, rad * 0.5, rad * 0.4, h * 0.45, 6, C.mesa[(i + 1) % 3], true, rnd());
    }
    g.jit = 0.1;
    // flight-line fence between the pilot and the runway
    for (let x = -30; x <= 30; x += 3) g.box(x - 0.05, 0, -4.05, x + 0.05, 1.0, -3.95, C.post);
    g.box(-30, 0.9, -4.02, 30, 0.94, -3.98, C.rope);
    // runway edge markers
    for (let x = -60; x <= 60; x += 15) for (const z of [-6.5, -17.5]) g.box(x - 0.2, 0, z - 0.12, x + 0.2, 0.28, z + 0.12, C.white);
    // shed and tables behind the pilot
    g.box(-18, 0, 5, -14, 2.6, 8, { top: C.roof, bottom: C.wall, side: C.wall });
    g.quad([-18.3, 2.6, 4.7], [-13.7, 2.6, 4.7], [-13.7, 3.3, 6.5], [-18.3, 3.3, 6.5], C.roof);
    g.quad([-18.3, 3.3, 6.5], [-13.7, 3.3, 6.5], [-13.7, 2.6, 8.3], [-18.3, 2.6, 8.3], C.roof);
    obstacles.push({ x: -16, z: 6.5, r: 2.2, h: 3.3 });
    g.box(4, 0.7, 3, 6, 0.75, 4, C.wall); for (const [x, z] of [[4.1, 3.1], [5.85, 3.1], [4.1, 3.85], [5.85, 3.85]]) g.box(x, 0, z, x + 0.06, 0.7, z + 0.06, C.post);
    // pylons
    for (const x of [-90, 90]) { g.cyl(x, 0, -120, 0.7, 0.05, 3.2, 8, C.orange); g.cyl(x, 1.4, -120, 0.4, 0.33, 0.4, 8, C.white, false); obstacles.push({ x, z: -120, r: 0.6, h: 3.2 }); }
    // gates to fly through
    const gate = (m) => g.with(m, () => {
      for (const x of [-10, 10]) g.cyl(x, 0, 0, 0.25, 0.25, 9.6, 8, C.white);
      g.box(-10.3, 9.0, -0.25, 10.3, 9.6, 0.25, C.white);
      g.box(-9.7, 7.5, -0.08, 9.7, 9.0, 0.08, C.blue);
    });
    gate(M4.trans(0, 0, -180));
    gate(M4.mul(M4.trans(-230, 0, -70), M4.rotY(Math.PI / 2)));
    for (const [x, z] of [[-10, -180], [10, -180], [-230, -60], [-230, -80]]) obstacles.push({ x, z, r: 0.35, h: 9.6 });
    // windsock pole
    g.cyl(SOCK_POS[0], 0, SOCK_POS[2], 0.07, 0.05, SOCK_POS[1], 6, C.white);
    obstacles.push({ x: SOCK_POS[0], z: SOCK_POS[2], r: 0.2, h: SOCK_POS[1] });

    if (world) for (const k of ['ground', 'runway', 'decal', 'scenery']) GLR.freeMesh(R, world[k]);
    world = { ground: GLR.mesh(R, gg), runway: GLR.mesh(R, gr), decal: GLR.mesh(R, gd), scenery: GLR.mesh(R, g), obstacles };
  }

  // sky dome (unlit, follows the camera)
  const skyMesh = (() => {
    const g = new Geo(), seg = 24, rad = 5000;
    const rings = [-0.4, 0, 0.06, 0.15, 0.3, 0.55, 0.9, Math.PI / 2];
    const zen = [0.33, 0.56, 0.84];
    const colAt = (el) => (el <= 0 ? FOG : mixc(FOG, zen, Math.pow(Math.min(1, el / 1.0), 0.7)));
    for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < seg; i++) {
      const e0 = rings[r], e1 = rings[r + 1], a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const P = (e, a) => [rad * Math.cos(e) * Math.cos(a), rad * Math.sin(e), rad * Math.cos(e) * Math.sin(a)];
      g.triV(P(e0, a0), P(e0, a1), P(e1, a1), colAt(e0), colAt(e0), colAt(e1));
      g.triV(P(e0, a0), P(e1, a1), P(e1, a0), colAt(e0), colAt(e1), colAt(e1));
    }
    return GLR.mesh(R, g);
  })();

  // windsock: three tapering bands along +x, origin at the pole top
  const sockMesh = (() => {
    const g = new Geo();
    g.with(M4.rotZ(-Math.PI / 2), () => {
      const r = [0.24, 0.2, 0.16, 0.12];
      for (let i = 0; i < 3; i++) g.cyl(0, i * 0.4, 0, r[i], r[i + 1], 0.4, 10, i % 2 ? C.white : C.orange, false);
    });
    return GLR.mesh(R, g);
  })();

  /* ---------------------------------------------------------------- aircraft meshes */
  const BR = (p) => [p[1], -p[2], -p[0]]; // body FRD -> render local (x right, y up, z aft)
  // closed slab from 4 mid-plane corners; thickness along `dir` (render local)
  function slab(g, a, b, c, d, t0, t1, top, bot, side, dir = [0, 1, 0]) {
    const off = (p, t) => [p[0] + (dir[0] * t) / 2, p[1] + (dir[1] * t) / 2, p[2] + (dir[2] * t) / 2];
    const neg = (p, t) => off(p, -t);
    const A = off(a, t0), B = off(b, t1), Cc = off(c, t1), D = off(d, t0);
    const a2 = neg(a, t0), b2 = neg(b, t1), c2 = neg(c, t1), d2 = neg(d, t0);
    g.quad(A, B, Cc, D, top); g.quad(a2, d2, c2, b2, bot);
    g.quad(a2, b2, B, A, side); g.quad(d2, D, Cc, c2, side); g.quad(a2, A, D, d2, side); g.quad(b2, c2, Cc, B, side);
  }
  function propMeshes(g, blades, rad, col) {
    const gb = new Geo();
    for (let i = 0; i < blades; i++) gb.with(M4.rotZ((i / blades) * Math.PI * 2), () => gb.box(0, -rad * 0.07, -0.004, rad, rad * 0.07, 0.004, col));
    const gd = new Geo(); gd.disc(rad, 24, [0.75, 0.77, 0.8]);
    return { blades: GLR.mesh(R, gb), disc: GLR.mesh(R, gd) };
  }
  const flapDefl = (ac, st, s) => clamp(st.ka * s.sa + st.ke * s.se + st.kr * s.sr, -ac.defl.flapMax, ac.defl.flapMax);

  function buildGoblin(ac) {
    const X = (x) => x - ac.xShift; // definition x -> body x (CG at origin)
    const P = (x, y, z) => BR([X(x), y, z]);
    const top = [1.0, 0.46, 0.1], bot = [0.15, 0.16, 0.19], side = [0.8, 0.38, 0.1], tip = [0.55, 0.95, 0.25];
    const pod = [0.22, 0.23, 0.26], dark = [0.08, 0.09, 0.1];
    const g = new Geo();
    const leAt = (y) => 0.23 - (0.15 * y) / 0.29;
    for (const s of [1, -1]) {
      slab(g, P(0.23, 0, 0), P(leAt(0.05), 0.05 * s, 0), P(0, 0.05 * s, 0), P(0, 0, 0), 0.03, 0.026, top, bot, side);
      slab(g, P(leAt(0.05), 0.05 * s, 0), P(leAt(0.285), 0.285 * s, 0), P(0.035, 0.285 * s, 0), P(0.035, 0.05 * s, 0), 0.026, 0.012, top, bot, side);
      slab(g, P(leAt(0.285), 0.285 * s, 0), P(0.08, 0.29 * s, 0), P(0, 0.29 * s, 0), P(0, 0.285 * s, 0), 0.012, 0.01, tip, tip, tip);
      // orientation stripe on the right wing top only
      if (s > 0) g.quad(P(0.17, 0.12, -0.0135), P(0.13, 0.2, -0.0115), P(0.1, 0.2, -0.0115), P(0.14, 0.12, -0.0135), [0.05, 0.05, 0.06]);
    }
    const z0 = -X(0.26), z1 = -X(-0.02);
    g.taper(z0, 0.05, 0.05, 0.0, z1, 0.04, 0.032, 0.002, { top: pod, bottom: pod, side: pod, front: dark, back: pod });
    g.box(-0.02, 0.02, z0 + 0.03, 0.02, 0.042, z0 + 0.1, dark); // camera / canopy
    // fin
    slab(g, P(0.07, 0, -0.015), P(0.035, 0, -0.09), P(-0.005, 0, -0.09), P(-0.01, 0, -0.015), 0.006, 0.004, top, top, side, [1, 0, 0]);
    // motor
    g.with(M4.trans(0, 0, -X(-0.022)), () => g.with(M4.rotX(Math.PI / 2), () => g.cyl(0, -0.006, 0, 0.012, 0.012, 0.014, 8, [0.6, 0.6, 0.62])));
    const parts = [{ mesh: GLR.mesh(R, g), mat: M4.ident() }];
    // elevons
    const hingeZ = -X(0.035);
    for (const s of [1, -1]) {
      const ge = new Geo();
      slab(ge, [0.05 * s, 0, 0], [0.285 * s, 0, 0], [0.285 * s, 0, 0.035], [0.05 * s, 0, 0.035], 0.012, 0.008, top, bot, side);
      const st = ac.strips.find((x) => x.role === 'wing' && x.side === s && x.tau > 0);
      parts.push({ mesh: GLR.mesh(R, ge), mat: M4.trans(0, 0, hingeZ), anim: (st0) => M4.rotX(flapDefl(ac, st, st0)) });
    }
    const pm = propMeshes(g, 3, 0.038, dark);
    const propZ = -ac.prop.r[0];
    return { parts, prop: { blades: pm.blades, disc: pm.disc, mat: M4.trans(0, 0, propZ), r: 0.038 }, cam: BR(ac.fpvCam) };
  }

  function buildTrainer(ac) {
    const top = [1.0, 0.78, 0.16], bot = [0.66, 0.1, 0.12], side = [0.9, 0.7, 0.14], white = [0.93, 0.93, 0.91], blue = [0.12, 0.32, 0.7], dark = [0.1, 0.1, 0.12];
    const G2 = 4 * D2R;
    const g = new Geo();
    for (const s of [1, -1]) g.with(M4.mul(M4.trans(0, 0.1, 0), M4.rotZ(s * G2)), () => {
      slab(g, [0, 0, -0.066], [0.36 * s, 0, -0.066], [0.36 * s, 0, 0.154], [0, 0, 0.154], 0.03, 0.03, top, bot, side);
      slab(g, [0.36 * s, 0, -0.066], [0.75 * s, 0, -0.066], [0.75 * s, 0, 0.104], [0.36 * s, 0, 0.104], 0.03, 0.026, top, bot, side);
      if (s > 0) g.quad([0.5, 0.0155, -0.03], [0.62, 0.0155, -0.03], [0.62, 0.0155, 0.06], [0.5, 0.0155, 0.06], dark); // orientation patch
    });
    g.box(-0.06, -0.07, -0.42, 0.06, 0.07, 0.0, { top: white, bottom: blue, side: white, front: dark, back: white });
    g.taper(0.0, 0.12, 0.14, 0, 0.82, 0.04, 0.05, 0.02, { top: white, bottom: blue, side: white, back: white });
    g.box(-0.045, 0.07, -0.3, 0.045, 0.1, -0.08, [0.1, 0.16, 0.24]); // canopy
    g.box(-0.05, -0.055, -0.45, 0.05, 0.055, -0.42, dark); // cowl
    g.with(M4.trans(0, 0, -0.45), () => g.with(M4.rotX(-Math.PI / 2), () => g.cyl(0, 0, 0, 0.03, 0, 0.05, 8, [0.85, 0.85, 0.87])));
    // stab and fin (fixed parts)
    slab(g, [-0.25, 0, 0.64], [0.25, 0, 0.64], [0.25, 0, 0.715], [-0.25, 0, 0.715], 0.012, 0.012, top, bot, side);
    slab(g, [0, 0.03, 0.66], [0, 0.2, 0.7], [0, 0.2, 0.735], [0, 0.03, 0.735], 0.01, 0.008, white, white, white, [1, 0, 0]);
    // landing gear
    const wheel = (x, z) => g.with(M4.trans(x, -0.135, z), () => g.with(M4.rotZ(Math.PI / 2), () => g.cyl(0, -0.012, 0, 0.035, 0.035, 0.024, 10, dark)));
    g.box(-0.006, -0.135, -0.326, 0.006, -0.07, -0.314, [0.7, 0.7, 0.72]);
    g.box(-0.17, -0.08, 0.044, 0.17, -0.07, 0.056, [0.7, 0.7, 0.72]);
    for (const x of [-0.17, 0.17]) g.box(x - 0.006, -0.135, 0.044, x + 0.006, -0.07, 0.056, [0.7, 0.7, 0.72]);
    wheel(0, -0.32); wheel(-0.185, 0.05); wheel(0.185, 0.05);
    const parts = [{ mesh: GLR.mesh(R, g), mat: M4.ident() }];
    for (const s of [1, -1]) {
      const ga = new Geo();
      slab(ga, [0.36 * s, 0, 0], [0.75 * s, 0, 0], [0.75 * s, 0, 0.05], [0.36 * s, 0, 0.05], 0.022, 0.018, top, bot, side);
      const st = ac.strips.find((x) => x.role === 'wing' && x.side === s && x.tau > 0);
      parts.push({ mesh: GLR.mesh(R, ga), mat: M4.chain(M4.trans(0, 0.1, 0), M4.rotZ(s * G2), M4.trans(0, 0, 0.104)), anim: (st0) => M4.rotX(flapDefl(ac, st, st0)) });
    }
    const gE = new Geo(); slab(gE, [-0.25, 0, 0], [0.25, 0, 0], [0.25, 0, 0.045], [-0.25, 0, 0.045], 0.01, 0.008, top, bot, side);
    const stE = ac.strips.find((x) => x.role === 'tail' && x.tau > 0);
    parts.push({ mesh: GLR.mesh(R, gE), mat: M4.trans(0, 0, 0.715), anim: (st0) => M4.rotX(flapDefl(ac, stE, st0)) });
    const gR = new Geo(); slab(gR, [0, 0.03, 0], [0, 0.2, 0], [0, 0.2, 0.055], [0, 0.03, 0.055], 0.008, 0.006, bot, bot, bot, [1, 0, 0]);
    const stR = ac.strips.find((x) => x.role === 'fin' && x.tau > 0);
    parts.push({ mesh: GLR.mesh(R, gR), mat: M4.trans(0, 0, 0.735), anim: (st0) => M4.rotY(-flapDefl(ac, stR, st0)) });
    const pm = propMeshes(g, 2, 0.127, dark);
    return { parts, prop: { blades: pm.blades, disc: pm.disc, mat: M4.trans(0, 0, -0.455), r: 0.127 }, cam: BR(ac.fpvCam) };
  }
  const MODELS = { goblin: buildGoblin(ACS.goblin), trainer: buildTrainer(ACS.trainer) };

  /* ---------------------------------------------------------------- sim state */
  const st = FL.makeState();
  const env = { rho: 1.225, wind: [0, 0, 0], battery: S.battery, crashes: S.crashes };
  const gust = [0, 0, 0];
  let armed = false, paused = false, userPaused = false, crashAt = 0, flightTime = 0, timerOn = false, launchHold = 0, acc = 0, propAng = 0;
  let farWarned = false, crashAnnounced = false;
  function updateAtmos() { const a = FL.atmosphere(S.elevFt, S.tempF); env.rho = a.rho; return a; }
  updateAtmos();

  function doReset() {
    const where = startOf(AC.id);
    FL.reset(st, AC, where);
    armed = where === 'air';
    if (where === 'air') { kb.thr = AC.kind === 'wing' ? 0.55 : 0.6; }
    crashAt = 0; crashAnnounced = false; flightTime = 0; timerOn = where === 'air'; launchHold = 0; acc = 0; farWarned = false;
    for (let i = 0; i < 3; i++) gust[i] = 0;
    hideBanner();
  }

  /* ---------------------------------------------------------------- input */
  const K = new Set();
  const kb = { thr: 0, a: 0, e: 0, r: 0 };
  const tch = { L: { x: 0, y: 1, id: null }, R: { x: 0, y: 0, id: null } };
  const inp = { thr: 0, a: 0, e: 0, r: 0 };
  let src = 'keys', padBlocked = false, padAxesPrev = null, swPrev = null, lastPadId = '';
  const coarse = matchMedia('(pointer: coarse)').matches;
  let sticksShown = false;

  function readPad() {
    let pads;
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { padBlocked = true; return null; }
    let best = null;
    for (const p of pads || []) {
      if (!p || !p.connected || p.axes.length < 4) continue;
      if (radioMap && p.id === radioMap.id) return p;
      if (!best) best = p;
    }
    return best;
  }
  const mapped = (p) => !!(p && radioMap && radioMap.id === p.id);
  function padSticks(p) {
    const ax = p.axes;
    if (mapped(p)) {
      const m = radioMap;
      const stick = (c) => { if (!c) return 0; let v = ((ax[c.i] - c.c) * c.s) / c.k; if (Math.abs(v) < 0.01) v = 0; return clamp(v, -1, 1); };
      const t = m.thr;
      return { thr: t ? clamp((ax[t.i] - t.lo) / (t.hi - t.lo), 0, 1) : 0, a: stick(m.a), e: stick(m.e), r: stick(m.r) };
    }
    if (p.mapping === 'standard') return { thr: p.buttons[7] ? p.buttons[7].value : 0, a: ax[2] || 0, e: ax[3] || 0, r: ax[0] || 0 };
    // uncalibrated transmitter: guess AETR channel order
    return { thr: clamp(((ax[2] || 0) + 1) / 2, 0, 1), a: ax[0] || 0, e: -(ax[1] || 0), r: ax[3] || 0 };
  }
  function swState(sw, p) {
    if (!sw) return null;
    if (sw.type === 'button') { const b = p.buttons[sw.i]; return !!(b && (b.pressed || b.value > 0.5)); }
    const v = p.axes[sw.i];
    return sw.dir > 0 ? v > sw.th : v < sw.th;
  }
  function handleSwitches(p) {
    if (!mapped(p) || !radioMap.sw) return;
    const now = { reset: swState(radioMap.sw.reset, p), view: swState(radioMap.sw.view, p), mode: swState(radioMap.sw.mode, p) };
    if (swPrev) {
      if (now.reset && !swPrev.reset) doReset();
      if (now.view !== null && now.view !== swPrev.view && (radioMap.sw.view.type === 'axis' || now.view)) cycleView();
      if (now.mode !== null && now.mode !== swPrev.mode) {
        if (radioMap.sw.mode.type === 'axis') setMode(now.mode ? 'stab' : 'manual');
        else if (now.mode) setMode(S.mode === 'stab' ? 'manual' : 'stab');
      }
    } else if (now.mode !== null && radioMap.sw.mode.type === 'axis') setMode(now.mode ? 'stab' : 'manual');
    swPrev = now;
  }

  function pollInput(dt) {
    const p = readPad();
    if (p) {
      if (p.id !== lastPadId) { lastPadId = p.id; padAxesPrev = null; swPrev = null; if (!wiz.open) toast(mapped(p) ? `Radio connected: ${shortName(p.id)}` : `Controller found: ${shortName(p.id)}. Run radio setup to calibrate.`); refreshRadioBox(); }
      let moved = false;
      if (padAxesPrev) for (let i = 0; i < p.axes.length; i++) if (Math.abs(p.axes[i] - padAxesPrev[i]) > 0.03) moved = true;
      padAxesPrev = Array.from(p.axes);
      if (moved || (mapped(p) && src !== 'touch' && src !== 'keys')) src = 'radio';
      if (mapped(p) && src === 'keys' && !K.size && moved) src = 'radio';
      if (!wiz.open) handleSwitches(p);
    } else if (lastPadId) { lastPadId = ''; if (src === 'radio') src = 'keys'; toast('Radio disconnected'); refreshRadioBox(); }

    // keyboard (mode 2: WASD = throttle/yaw, arrows = pitch/roll; mode 1 swaps throttle and pitch)
    const m2 = S.stickMode === '2';
    const thrUp = m2 ? 'KeyW' : 'ArrowUp', thrDn = m2 ? 'KeyS' : 'ArrowDown';
    const pFwd = m2 ? 'ArrowUp' : 'KeyW', pBack = m2 ? 'ArrowDown' : 'KeyS';
    const slew = (x, t) => (t === 0 ? (Math.abs(x) < 6 * dt ? 0 : x - Math.sign(x) * 6 * dt) : clamp(x + Math.sign(t - x) * Math.min(Math.abs(t - x), 3 * dt), -1, 1));
    if (K.has(thrUp)) kb.thr = Math.min(1, kb.thr + 0.9 * dt);
    if (K.has(thrDn)) kb.thr = Math.max(0, kb.thr - 0.9 * dt);
    kb.a = slew(kb.a, (K.has('ArrowRight') ? 1 : 0) - (K.has('ArrowLeft') ? 1 : 0));
    kb.e = slew(kb.e, (K.has(pBack) ? 1 : 0) - (K.has(pFwd) ? 1 : 0));
    kb.r = slew(kb.r, (K.has('KeyD') ? 1 : 0) - (K.has('KeyA') ? 1 : 0));

    let v;
    if (src === 'radio' && p) v = padSticks(p);
    else if (src === 'touch') {
      const thrSide = m2 ? tch.L : tch.R, pitchSide = m2 ? tch.R : tch.L;
      v = { thr: clamp((1 - thrSide.y) / 2, 0, 1), a: tch.R.x, e: pitchSide.y, r: tch.L.x };
    } else v = kb;
    inp.thr = v.thr; inp.a = v.a; inp.e = v.e; inp.r = v.r;
    return p;
  }
  const shortName = (id) => (id || '').replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 40) || 'controller';

  addEventListener('keydown', (e) => {
    if (e.target && e.target.closest && e.target.closest('input, select, textarea')) return;
    const c = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(c)) e.preventDefault();
    if (!K.has(c)) {
      if (!$('#welcome').hidden) { if (c === 'Enter' || c === 'Space') { fly(); return; } }
      if (c === 'Escape') { if (sheetOpen()) closeSheet(); else if (wiz.open) closeWizard(); }
      if (!wiz.open && !sheetOpen()) {
        if (c === 'KeyR') doReset();
        else if (c === 'KeyV') cycleView();
        else if (c === 'KeyM') setMode(S.mode === 'stab' ? 'manual' : 'stab');
        else if (c === 'KeyP' || c === 'Space') togglePause();
        else if (c === 'KeyF') toggleFull();
        else if (c === 'KeyL' && st.held && armed) { FL.launch(st); timerOn = true; }
        else if (c === 'Digit1') setView('los'); else if (c === 'Digit2') setView('fpv'); else if (c === 'Digit3') setView('split');
      }
    }
    K.add(c);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) src = 'keys';
    unlockAudio();
  });
  addEventListener('keyup', (e) => K.delete(e.code));
  addEventListener('blur', () => K.clear());
  addEventListener('gamepadconnected', () => refreshRadioBox());

  // touch sticks
  function setupStick(el, side) {
    const knob = el.querySelector('.knob'), t = tch[side];
    const draw = () => { knob.style.transform = `translate(${t.x * 41}px, ${t.y * 41}px)`; };
    const move = (e) => { const r = el.getBoundingClientRect(); t.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1); t.y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1); draw(); };
    el.addEventListener('pointerdown', (e) => { t.id = e.pointerId; try { el.setPointerCapture(e.pointerId); } catch (_) { /* old browser */ } move(e); src = 'touch'; e.preventDefault(); unlockAudio(); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === t.id) move(e); });
    const end = (e) => {
      if (e.pointerId !== t.id) return;
      t.id = null; t.x = 0;
      const thrSide = S.stickMode === '2' ? 'L' : 'R';
      if (side !== thrSide) t.y = 0;
      draw();
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    t.draw = draw; draw();
  }
  setupStick($('#stickL'), 'L'); setupStick($('#stickR'), 'R');
  function refreshTouch() {
    const show = S.touch === 'on' || (S.touch === 'auto' && coarse && src !== 'radio');
    $('#stickL').hidden = $('#stickR').hidden = !show;
    sticksShown = show;
    const m2 = S.stickMode === '2';
    $('#stickL').dataset.label = m2 ? 'Throttle · Yaw' : 'Pitch · Yaw';
    $('#stickR').dataset.label = m2 ? 'Pitch · Roll' : 'Throttle · Roll';
  }

  /* ---------------------------------------------------------------- radio setup wizard */
  const wiz = { open: false, step: 0, base: null, baseBtn: null, map: null, hold: 0, phase: 'detect', cand: -1, ext: 0, stableT: 0, last: null, used: new Set() };
  const WSTEPS = [
    { id: 'connect', title: 'Connect your radio', text: 'Plug the transmitter into the Chromebook by USB and choose <b>Joystick (HID)</b> on the radio’s USB prompt. Then move a stick so Chrome sees it.' },
    { id: 'center', title: 'Centre the sticks', text: 'Let the self-centring sticks rest in the middle and pull the <b>throttle all the way down</b>. Keep everything still for a moment.' },
    { id: 'thr', title: 'Throttle', text: 'Push the <b>throttle stick all the way up</b> and hold it there.', back: 'Now bring the throttle back down.' },
    { id: 'a', title: 'Roll (aileron)', text: 'Push the <b>roll stick fully right</b> and hold.', back: 'Let it return to centre.' },
    { id: 'e', title: 'Pitch (elevator)', text: 'Pull the <b>pitch stick fully back</b> toward you (nose up) and hold.', back: 'Let it return to centre.' },
    { id: 'r', title: 'Yaw (rudder)', text: 'Push the <b>yaw stick fully right</b> and hold. On a wing with no rudder, set it up anyway: it steers nothing but costs nothing.', back: 'Let it return to centre.' },
    { id: 'reset', sw: true, title: 'Reset switch', text: 'Flip the switch or press the button you want to use for <b>reset</b>, or skip.', back: 'Flip it back.' },
    { id: 'view', sw: true, title: 'View switch', text: 'Flip a switch for <b>changing view</b> (LOS → split → FPV), or skip.', back: 'Flip it back.' },
    { id: 'mode', sw: true, title: 'Flight-mode switch', text: 'Flip the switch you want for <b>stabilised mode</b>. Its flipped position will mean stabilised, the other manual. Or skip.', back: 'Flip it back.' },
    { id: 'done', title: 'Check and save', text: 'Move the sticks. The bars should follow: throttle up = right, roll right = right, pitch back = right, yaw right = right.' },
  ];
  function openWizard() {
    hide($('#welcome'));
    wiz.open = true; wiz.step = 0; wiz.map = { sw: {} }; wiz.used = new Set(); wiz.phase = 'detect';
    show($('#wizard')); renderWizStep(); setPaused(true);
  }
  function closeWizard() { wiz.open = false; hide($('#wizard')); setPaused(userPaused); }
  function renderWizStep() {
    const s = WSTEPS[wiz.step];
    $('#wzStep').textContent = `Radio setup · ${wiz.step + 1} of ${WSTEPS.length}`;
    $('#wzTitle').textContent = s.title;
    $('#wzText').innerHTML = s.text;
    $('#wzSkip').hidden = !s.sw;
    $('#wzNext').hidden = !(s.id === 'connect' || s.id === 'done');
    $('#wzNext').textContent = s.id === 'done' ? 'Save' : 'Start';
    wiz.hold = 0; wiz.cand = -1; wiz.phase = 'detect'; wiz.stableT = 0;
    $('#wzBar').style.width = '0%';
  }
  function nextWiz() { wiz.step++; if (wiz.step >= WSTEPS.length) return saveWizard(); renderWizStep(); }
  function saveWizard() {
    radioMap = wiz.map; store(RKEY, radioMap); swPrev = null; src = 'radio';
    closeWizard(); toast('Radio saved'); refreshRadioBox();
  }
  function wizTick(p, dt) {
    const s = WSTEPS[wiz.step];
    const mon = $('#wzMon');
    // live monitor of raw axes
    if (p) {
      let html = '';
      const roleOf = (i) => { const m = wiz.map; for (const k of ['thr', 'a', 'e', 'r']) if (m[k] && m[k].i === i) return { thr: 'THR', a: 'AIL', e: 'ELE', r: 'RUD' }[k]; for (const k of ['reset', 'view', 'mode']) if (m.sw[k] && m.sw[k].type === 'axis' && m.sw[k].i === i) return k.toUpperCase(); return ''; };
      if (s.id === 'done') {
        const v = { thr: 0, a: 0, e: 0, r: 0 }; const save = radioMap; radioMap = Object.assign({ id: p.id }, wiz.map); Object.assign(v, padSticks(p)); radioMap = save;
        for (const [k, lab] of [['thr', 'THR'], ['a', 'AIL'], ['e', 'ELE'], ['r', 'RUD']]) {
          const x = k === 'thr' ? v.thr : (v[k] + 1) / 2;
          html += `<div class="row on"><b>${lab}</b><div class="bar ${k === 'thr' ? 'thr' : ''}"><span style="left:${k === 'thr' ? 0 : Math.min(50, x * 100)}%;width:${k === 'thr' ? x * 100 : Math.abs(x - 0.5) * 100}%"></span></div><span>${(k === 'thr' ? v.thr * 100 : v[k] * 100).toFixed(0)}%</span></div>`;
        }
      } else {
        for (let i = 0; i < p.axes.length; i++) {
          const x = (p.axes[i] + 1) / 2, role = roleOf(i);
          html += `<div class="row ${role ? 'on' : ''}"><span>A${i} <b>${role}</b></span><div class="bar"><span style="left:${Math.min(50, x * 100)}%;width:${Math.abs(x - 0.5) * 100}%"></span></div><span>${p.axes[i].toFixed(2)}</span></div>`;
        }
        const pressed = p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
        html += `<div class="row"><span>Btns</span><span style="grid-column: span 2">${pressed.length ? 'pressed: ' + pressed.join(', ') : 'none pressed'} (${p.buttons.length} total)</span></div>`;
      }
      mon.innerHTML = html;
    } else mon.innerHTML = `<div class="row"><span>—</span><span style="grid-column: span 2">${padBlocked ? 'This view blocks game controllers. Open the page in its own Chrome tab.' : 'No controller seen yet. Plug in, pick Joystick on the radio, move a stick.'}</span></div>`;

    if (s.id === 'connect') { $('#wzNext').disabled = !p; return; }
    if (!p) return;
    const ax = p.axes;
    if (s.id === 'center') {
      if (wiz.last && ax.every((v, i) => Math.abs(v - wiz.last[i]) < 0.015)) wiz.stableT += dt; else wiz.stableT = 0;
      wiz.last = Array.from(ax);
      $('#wzBar').style.width = `${Math.min(100, (wiz.stableT / 1.2) * 100)}%`;
      if (wiz.stableT > 1.2) { wiz.base = Array.from(ax); wiz.baseBtn = p.buttons.map((b) => b.pressed); wiz.map.id = p.id; nextWiz(); }
      return;
    }
    if (s.id === 'done') return;
    const base = wiz.base;
    if (wiz.phase === 'detect') {
      let best = -1, dev = 0;
      for (let i = 0; i < ax.length; i++) { if (wiz.used.has(i)) continue; const d = Math.abs(ax[i] - base[i]); if (d > dev) { dev = d; best = i; } }
      let btn = -1;
      if (s.sw) p.buttons.forEach((b, i) => { if (b.pressed && !wiz.baseBtn[i] && btn < 0) btn = i; });
      if (s.sw && btn >= 0) { wiz.map.sw[s.id] = { type: 'button', i: btn }; wiz.phase = 'release'; wiz.relBtn = btn; return; }
      if (dev > 0.5 && best === wiz.cand) wiz.hold += dt; else { wiz.hold = 0; wiz.cand = dev > 0.5 ? best : -1; wiz.ext = 0; }
      if (wiz.cand >= 0) wiz.ext = Math.max(wiz.ext, Math.abs(ax[wiz.cand] - base[wiz.cand]));
      const need = s.sw ? 0.25 : 0.45;
      $('#wzBar').style.width = `${Math.min(100, (wiz.hold / need) * 100)}%`;
      if (wiz.hold > need) {
        const i = wiz.cand, d = ax[i] - base[i];
        if (s.sw) wiz.map.sw[s.id] = { type: 'axis', i, dir: Math.sign(d), th: base[i] + d / 2 };
        else if (s.id === 'thr') wiz.map.thr = { i, lo: base[i], hi: ax[i] };
        else wiz.map[s.id] = { i, c: base[i], s: Math.sign(d), k: Math.max(0.3, wiz.ext) };
        wiz.used.add(i); wiz.phase = 'release'; wiz.relAxis = i;
        $('#wzText').innerHTML = s.back || 'Release.';
      }
    } else if (wiz.phase === 'release') {
      const done = wiz.relBtn != null && WSTEPS[wiz.step].sw && wiz.map.sw[s.id] && wiz.map.sw[s.id].type === 'button'
        ? !p.buttons[wiz.relBtn].pressed
        : Math.abs(ax[wiz.relAxis] - base[wiz.relAxis]) < 0.2;
      if (done) { wiz.relBtn = null; nextWiz(); }
    }
  }
  $('#wzNext').addEventListener('click', () => { const s = WSTEPS[wiz.step]; if (s.id === 'done') saveWizard(); else if (s.id === 'connect') nextWiz(); });
  $('#wzSkip').addEventListener('click', () => nextWiz());
  $('#wzCancel').addEventListener('click', closeWizard);

  /* ---------------------------------------------------------------- UI: bar, banner, toast */
  const show = (el) => { el.hidden = false; }, hide = (el) => { el.hidden = true; };
  let toastT = 0;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; show(t); clearTimeout(toastT); toastT = setTimeout(() => hide(t), 2600); }
  function showBanner(title, text, crash) { const b = $('#banner'); $('#banTitle').textContent = title; $('#banText').textContent = text; b.classList.toggle('crash', !!crash); show(b); }
  function hideBanner() { hide($('#banner')); }
  $('#banner').addEventListener('click', () => { if (st.crashed) doReset(); else if (userPaused) togglePause(); });

  const VIEW_LABEL = { los: 'LOS', fpv: 'FPV', split: 'Split' };
  function refreshBar() {
    $('#vAc').textContent = AC.name;
    $('#vView').textContent = VIEW_LABEL[S.view];
    $('#vMode').textContent = S.mode === 'stab' ? 'Stabilised' : 'Manual';
    $('#bMode').classList.toggle('hot', S.mode === 'stab');
    $('#vStart').textContent = START_LABEL[startOf(AC.id)];
    $('#vPause').textContent = paused ? 'Paused' : 'Running';
    $('#bPause').classList.toggle('hot', userPaused);
    const chip = $('#chip');
    chip.className = src === 'radio' ? 'radio' : src === 'touch' ? 'touch' : 'keys';
    $('#chipTxt').innerHTML = src === 'radio' ? `Radio${lastPadId && !mapped({ id: lastPadId }) ? ' <b>· uncalibrated</b>' : ''}` : src === 'touch' ? 'Touch' : 'Keys';
  }
  function setView(v) { S.view = v; saveS(); refreshBar(); syncSheet(); }
  function cycleView() { setView({ los: 'split', split: 'fpv', fpv: 'los' }[S.view]); }
  function setMode(m) { S.mode = m; saveS(); refreshBar(); syncSheet(); }
  function setAircraft(id) { S.aircraft = id; AC = ACS[id]; saveS(); doReset(); refreshBar(); buildSheet(); }
  function setPaused(p) { paused = p; }
  function togglePause() { userPaused = !userPaused; setPaused(userPaused || sheetOpen() || wiz.open); if (userPaused) showBanner('Paused', 'Press P or tap here to resume.'); else hideBanner(); refreshBar(); }
  function toggleFull() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('Full screen is not available in this view'));
    } catch (e) { toast('Full screen is not available in this view'); }
  }
  $('#bAc').addEventListener('click', () => setAircraft(S.aircraft === 'goblin' ? 'trainer' : 'goblin'));
  $('#bView').addEventListener('click', cycleView);
  $('#bMode').addEventListener('click', () => setMode(S.mode === 'stab' ? 'manual' : 'stab'));
  $('#bStart').addEventListener('click', () => { const opts = AC.starts, cur = startOf(AC.id); S.start[AC.id] = opts[(opts.indexOf(cur) + 1) % opts.length]; saveS(); doReset(); refreshBar(); });
  $('#bReset').addEventListener('click', doReset);
  $('#bPause').addEventListener('click', togglePause);
  $('#bSettings').addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));
  $('#bFull').addEventListener('click', toggleFull);
  if (!document.fullscreenEnabled) hide($('#bFull'));

  function fly() {
    hide($('#welcome')); unlockAudio();
    try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* not offered */ }
  }
  $('#wFly').addEventListener('click', fly);
  $('#wSetup').addEventListener('click', openWizard);

  /* ---------------------------------------------------------------- settings sheet */
  const sheetOpen = () => $('#sheet').classList.contains('open');
  function openSheet() { buildSheet(); $('#sheet').classList.add('open'); setPaused(true); }
  function closeSheet() { $('#sheet').classList.remove('open'); setPaused(userPaused || wiz.open); }
  $('#shClose').addEventListener('click', closeSheet);

  const seg = (key, label, opts, help, get, set) => ({ type: 'seg', key, label, opts, help, get, set });
  const rng = (key, label, min, max, stepv, fmt, help) => ({ type: 'range', key, label, min, max, step: stepv, fmt, help });
  function schema() {
    const imp = S.units === 'imp';
    return [
      { title: 'Aircraft', items: [
        seg('aircraft', 'Model', Object.values(ACS).map((a) => [a.id, a.name]), AC.blurb, () => S.aircraft, (v) => setAircraft(v)),
        seg('start', 'Reset puts you', AC.starts.map((s) => [s, START_LABEL[s]]), AC.kind === 'wing' ? 'Hand launch: arm with throttle down, then push throttle above 70% and the model is thrown once the motor is wound up (or press L to throw at any throttle). Real technique applies: full power, and maybe a touch of up elevator.' : '', () => startOf(AC.id), (v) => { S.start[AC.id] = v; doReset(); refreshBar(); }),
        seg('mode', 'Flight mode', [['manual', 'Manual'], ['stab', 'Stabilised']], 'Stabilised works like ArduPilot FBWA: sticks command bank (±45°) and pitch (±30°). It does not stop you stalling.', () => S.mode, (v) => setMode(v)),
      ] },
      { title: 'Controls', items: [{ type: 'radio' },
        seg('stickMode', 'Stick mode (keyboard & touch)', [['2', 'Mode 2'], ['1', 'Mode 1']], 'With a radio the setup wizard maps channels, so this only affects keys and touch.'),
        seg('touch', 'Touch sticks', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]),
      ] },
      { title: 'Rates & expo', items: [{ type: 'rates' }] },
      { title: 'View', items: [
        seg('view', 'View', [['los', 'LOS'], ['split', 'Split'], ['fpv', 'FPV']], 'Split puts LOS on top and FPV below when the screen is upright, side by side when it is wide.', () => S.view, (v) => setView(v)),
        seg('splitSwap', 'Split order', [[false, 'LOS first'], [true, 'FPV first']]),
        seg('losZoom', 'LOS zoom', [['off', 'Off'], ['mild', 'Mild'], ['strong', 'Strong']], 'Narrows your field of view as the model gets farther away, so it stays visible on a small screen.'),
        rng('fpvFov', 'FPV camera field of view', 80, 150, 5, (v) => `${v}°`),
        rng('fpvTilt', 'FPV camera tilt', -20, 35, 1, (v) => `${v > 0 ? '+' : ''}${v}°`, 'Positive tilts the camera up.'),
        seg('osd', 'FPV OSD', [['full', 'Full'], ['min', 'Minimal'], ['off', 'Off']]),
        seg('losInfo', 'LOS readout', [[true, 'On'], [false, 'Off']]),
        seg('stallCue', 'Stall indicator', [[false, 'Off'], [true, 'On']], 'Flashes STALL when a wing panel is stalled. Off is realistic; turn it on while you learn what a stall looks like.'),
        seg('eng', 'Engineering readout', [[false, 'Off'], [true, 'On']], 'Angle of attack, sideslip, load factor and stalled area per wing.'),
      ] },
      { title: 'Conditions', items: [
        rng('windSpd', 'Wind speed', 0, 12, 0.5, (v) => U.wind(v)),
        rng('windDir', 'Wind from', 0, 355, 5, (v) => `${v}° (${compass(v)})`, 'You stand facing north. The runway runs east–west, so 90° is a headwind for a runway takeoff.'),
        rng('gust', 'Gusts', 0, 100, 5, (v) => `${v}%`),
        rng('elevFt', 'Field elevation', 0, 10000, 250, (v) => `${v.toLocaleString()} ft`),
        rng('tempF', 'Temperature', 0, 115, 1, (v) => `${v}°F`),
        { type: 'da' },
        seg('battery', 'Battery', [[true, 'Drains'], [false, 'Unlimited']], () => AC.batt.label),
        seg('crashes', 'Crashes', [[true, 'On'], [false, 'Off']]),
        seg('autoReset', 'After a crash', [[true, 'Auto reset (3 s)'], [false, 'Wait for me']]),
      ] },
      { title: 'Display & sound', items: [
        seg('units', 'Units', [['imp', 'ft · mph'], ['met', 'm · km/h']]),
        seg('quality', 'Render resolution', [[0.6, 'Fast'], [0.8, 'Balanced'], [1, 'Sharp'], ['dev', 'Device']], 'Lower it if the frame rate drops.'),
        seg('scenery', 'Scenery', [['low', 'Light'], ['med', 'Normal'], ['high', 'Dense']]),
        seg('aa', 'Smooth edges', [[false, 'Off'], [true, 'On']], 'Takes effect after a reload.'),
        seg('fps', 'Frame rate', [[false, 'Hide'], [true, 'Show']]),
        seg('sound', 'Motor sound', [[true, 'On'], [false, 'Off']]),
      ] },
      { title: 'Flight model', items: [{ type: 'notes' }] },
    ];
  }
  function applySetting(k) {
    if (k === 'scenery') buildWorld(S.scenery);
    if (k === 'quality') resize();
    if (k === 'elevFt' || k === 'tempF') { updateAtmos(); const n = $('#daBox'); if (n) n.innerHTML = daHtml(); }
    if (k === 'battery') env.battery = S.battery;
    if (k === 'crashes') env.crashes = S.crashes;
    if (k === 'touch' || k === 'stickMode') refreshTouch();
    if (k === 'aa') toast('Smooth edges applies after you reload the page');
    if (k === 'units') buildSheet();
  }
  function daHtml() {
    const a = FL.atmosphere(S.elevFt, S.tempF);
    return `<div class="kv"><span>Air density</span><span>${a.rho.toFixed(3)} kg/m³ (${((a.rho / 1.225) * 100).toFixed(0)}% of sea level)</span><span>Density altitude</span><span>${Math.round(a.daFt).toLocaleString()} ft</span></div>`;
  }
  function buildSheet() {
    const body = $('#shBody');
    const scroll = $('#sheet').scrollTop;
    body.innerHTML = '';
    for (const sec of schema()) {
      const el = document.createElement('section');
      el.innerHTML = `<h3>${sec.title}</h3>`;
      for (const it of sec.items) {
        const box = document.createElement('div'); box.className = 'set';
        if (it.type === 'seg') {
          const cur = it.get ? it.get() : S[it.key];
          const help = typeof it.help === 'function' ? it.help() : it.help;
          box.innerHTML = `<div class="lab"><span>${it.label}</span></div><div class="seg" role="group" aria-label="${it.label}">${it.opts.map(([v, l], i) => `<button type="button" id="set-${it.key}-${i}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>${help ? `<div class="help">${help}</div>` : ''}`;
          box.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => {
            const v = it.opts[i][0];
            if (it.set) it.set(v); else { S[it.key] = v; saveS(); applySetting(it.key); }
            box.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
          }));
        } else if (it.type === 'range') {
          const id = `set-${it.key}`;
          box.innerHTML = `<label for="${id}"><span>${it.label}</span><output id="${id}-o">${it.fmt(S[it.key])}</output></label><input type="range" id="${id}" min="${it.min}" max="${it.max}" step="${it.step}" value="${S[it.key]}">${it.help ? `<div class="help">${it.help}</div>` : ''}`;
          const inpEl = box.querySelector('input'), out = box.querySelector('output');
          inpEl.addEventListener('input', () => { S[it.key] = Number(inpEl.value); out.textContent = it.fmt(S[it.key]); saveS(); applySetting(it.key); });
        } else if (it.type === 'da') {
          box.id = 'daBox'; box.innerHTML = daHtml();
        } else if (it.type === 'radio') {
          box.innerHTML = `<div class="radio-box"><div class="name" id="rbName"></div><div class="live" id="rbLive"></div><div class="actions" style="justify-content:flex-start"><button class="btn small" id="rbSetup">Set up radio</button><button class="btn small" id="rbForget">Forget radio</button></div></div>`;
          box.querySelector('#rbSetup').addEventListener('click', () => { closeSheet(); openWizard(); });
          box.querySelector('#rbForget').addEventListener('click', () => { radioMap = null; store(RKEY, null); refreshRadioBox(); toast('Radio calibration cleared'); });
        } else if (it.type === 'rates') {
          const ax = AC.kind === 'wing' ? [['a', 'Roll'], ['e', 'Pitch']] : [['a', 'Aileron'], ['e', 'Elevator'], ['r', 'Rudder']];
          let h = '<div class="rates"><span class="hd">Axis</span><span class="hd">Rate</span><span class="hd">Expo</span>';
          for (const [k, l] of ax) {
            h += `<span>${l}</span><label for="rt-${k}"><output id="rt-${k}-o">${S.rates[k]}%</output><input type="range" id="rt-${k}" min="30" max="100" step="5" value="${S.rates[k]}"></label>`;
            h += `<label for="ex-${k}"><output id="ex-${k}-o">${S.expo[k]}%</output><input type="range" id="ex-${k}" min="0" max="80" step="5" value="${S.expo[k]}"></label>`;
          }
          h += '</div>';
          const throws = AC.kind === 'wing' ? `Full stick = ${Math.round(AC.defl.a * R2D)}° elevon for roll, ${Math.round(AC.defl.e * R2D)}° for pitch.` : `Full stick = ${Math.round(AC.defl.a * R2D)}° aileron, ${Math.round(AC.defl.e * R2D)}° elevator, ${Math.round(AC.defl.r * R2D)}° rudder.`;
          box.innerHTML = h + `<div class="help">${throws} If your radio already applies rates and expo, set expo here to 0%.</div>`;
          for (const [k] of ax) for (const [pre, obj, unit] of [['rt', 'rates', '%'], ['ex', 'expo', '%']]) {
            const e = box.querySelector(`#${pre}-${k}`), o = box.querySelector(`#${pre}-${k}-o`);
            e.addEventListener('input', () => { S[obj][k] = Number(e.value); o.textContent = e.value + unit; saveS(); });
          }
        } else if (it.type === 'notes') {
          box.innerHTML = notesHtml();
        }
        el.appendChild(box);
      }
      body.appendChild(el);
    }
    refreshRadioBox();
    $('#sheet').scrollTop = scroll;
  }
  function syncSheet() { if (sheetOpen()) buildSheet(); }
  function refreshRadioBox() {
    const n = $('#rbName'), w = $('#wRadio'), dot = $('#wRadioDot');
    const p = readPad();
    const txt = padBlocked ? 'This view blocks game controllers. Open the page in its own Chrome tab.'
      : !p ? 'Not detected. Plug in by USB, choose Joystick (HID) on the radio, then move a stick.'
      : mapped(p) ? `${shortName(p.id)} · calibrated` : `${shortName(p.id)} · not calibrated yet (run setup)`;
    if (n) n.textContent = txt;
    if (w) w.textContent = p ? txt : 'Plug your transmitter in by USB, choose Joystick (HID) on the radio, then move a stick.';
    if (dot) dot.classList.toggle('ok', !!(p && mapped(p)));
  }

  let perfCache = { key: '', html: '' };
  function notesHtml() {
    const key = `${AC.id}|${env.rho.toFixed(4)}|${S.units}`;
    if (perfCache.key !== key) {
      const P = FL.performance(AC, env.rho);
      const sp = (v) => U.spd(v);
      const te = AC.trim.e;
      const rows = P.rows.filter((r, i) => i % 2 === 0 || i === P.rows.length - 1)
        .map((r) => `<tr><td>${sp(r.V)}</td><td>${(r.alpha * R2D).toFixed(1)}°</td><td>${Math.round(r.thr * 100)}%</td><td>${Math.round((r.e - te) * 100)}%</td></tr>`).join('');
      let handsOff = null; // speed where the stick needed on top of trim crosses zero
      for (let i = 1; i < P.rows.length; i++) { const a = P.rows[i - 1].e - te, b = P.rows[i].e - te; if (a * b <= 0 && a !== b) handsOff = lerp(P.rows[i - 1].V, P.rows[i].V, a / (a - b)); }
      const wl = (AC.mass * 1000) / (AC.S * 100);
      perfCache = {
        key,
        html: `<div class="kv">
          <span>Flying weight</span><span>${Math.round(AC.mass * 1000)} g</span>
          <span>Span · wing area</span><span>${Math.round(AC.b * 1000)} mm · ${Math.round(AC.S * 1550)} in²</span>
          <span>Wing loading</span><span>${wl.toFixed(1)} g/dm²</span>
          <span>Static margin</span><span>${(AC.SM * 100).toFixed(1)}% MAC</span>
          <span>1-g stall speed</span><span>${sp(P.stall.Vs)}</span>
          <span>Max lift coefficient</span><span>${P.stall.CLmax.toFixed(2)} at ${(P.stall.alpha * R2D).toFixed(1)}°</span>
          <span>Hands-off speed (trimmed)</span><span>${handsOff ? sp(handsOff) : '—'}</span>
          <span>Top speed (level)</span><span>${P.Vmax ? sp(P.Vmax) : '—'}</span></div>
          <div class="tbl"><table><thead><tr><th>Level flight at</th><th>AoA</th><th>Throttle</th><th>Elevator</th></tr></thead><tbody>${rows}</tbody></table></div>`,
      };
    }
    return `<div class="notes">
      <p>These numbers are solved from the same model you are flying, at the current air density. Elevator is the stick needed on top of the built-in trim; negative means forward stick.</p>
      ${perfCache.html}
      <p><b>How it works.</b> Each wing half, the tail and the fin are cut into strips (${AC.strips.length} on this model). Every strip computes its own airflow from the aircraft’s velocity plus its rotation, so a rolling wing sees more angle of attack on the down-going side, and a yawing wing sees a slower inside tip. Each strip has its own stall.</p>
      <span class="eq">α_strip = atan2(−v·n, v·c) + τ·δ_flap
CL = (1−σ)·k·(CL0 + a·α) + σ·CN90·sin α·cos α
σ  = stall blend: 0 attached → 1 separated</span>
      <p>Strips that carry more load stall first. On a tapered wing that is the outboard panels (tip stall); on a rectangular wing it is the root. Damping, dihedral effect, weathervaning, wing drop and spin entry are not programmed in. They come out of adding up the strips.</p>
      <span class="eq">Thrust  T = T0·(ρ/ρ0)·(n² − n·V/Vpitch)
Battery V = cells·OCV(charge) − I·R
Tail sees prop wash and wing downwash ε = 2·CL/(π·AR)</span>
      <p><b>What is simplified.</b> No spanwise flow interaction between strips beyond the load-distribution factor, no dynamic stall or hysteresis, no gyroscopic prop effects, a single rigid body (except a foam-flex factor on the Goblin’s elevons at high speed), and trees are cylinders. Goblin geometry comes from Strix’s published span, area, weight and power system; CG position, airfoil numbers and inertia are estimates.</p>
    </div>`;
  }

  /* ---------------------------------------------------------------- cameras and drawing */
  let cssW = 0, cssH = 0, dpr = 1;
  function resize() {
    cssW = stage.clientWidth || innerWidth; cssH = stage.clientHeight || innerHeight;
    dpr = window.devicePixelRatio || 1;
    const q = S.quality === 'dev' ? dpr : Math.min(dpr, Number(S.quality) || 1);
    canvas.width = Math.max(1, Math.round(cssW * q)); canvas.height = Math.max(1, Math.round(cssH * q));
    osd.width = Math.round(cssW * dpr); osd.height = Math.round(cssH * dpr);
  }
  addEventListener('resize', resize);

  function layout() {
    const W = cssW, H = cssH;
    if (S.view === 'split') {
      const portrait = H >= W * 0.9;
      const a = portrait ? { x: 0, y: 0, w: W, h: Math.floor(H / 2) } : { x: 0, y: 0, w: Math.floor(W / 2), h: H };
      const b = portrait ? { x: 0, y: a.h, w: W, h: H - a.h } : { x: a.w, y: 0, w: W - a.w, h: H };
      const [l, f] = S.splitSwap ? [b, a] : [a, b];
      return [Object.assign({ kind: 'los' }, l), Object.assign({ kind: 'fpv' }, f)];
    }
    return [{ kind: S.view, x: 0, y: 0, w: W, h: H }];
  }
  // fov given for the shorter side of the view → vertical fov
  const vfovFor = (shortFov, aspect) => (aspect >= 1 ? shortFov : 2 * Math.atan(Math.tan(shortFov / 2) / aspect));

  function planeMatrix(s) {
    const Rm = FL.quatToMat(s.q);
    const sg = [1, -1, -1], ix = [1, 2, 0], R3 = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R3[i * 3 + j] = sg[i] * sg[j] * Rm[ix[i] * 3 + ix[j]];
    return M4.fromRT(R3, [s.p[1], -s.p[2], -s.p[0]]);
  }
  let losFov = 50 * D2R;
  const EYE = [0, 1.7, 0];
  function losCam(v, planeM) {
    const p = [planeM[12], planeM[13], planeM[14]];
    const d = Math.hypot(p[0] - EYE[0], p[1] - EYE[1], p[2] - EYE[2]);
    const aspect = v.w / v.h;
    const vf = vfovFor(losFov, aspect);
    return { view: M4.lookAt(EYE, d < 0.3 ? [0, 1.7, -1] : p, [0, 1, 0]), pos: EYE, fovy: Math.min(vf, 100 * D2R), near: 0.25, dist: d };
  }
  function fpvCam(v, planeM) {
    const m = MODELS[AC.id];
    const camW = M4.chain(planeM, M4.trans(m.cam[0], m.cam[1], m.cam[2]), M4.rotX(S.fpvTilt * D2R));
    const aspect = v.w / v.h;
    const hf = S.fpvFov * D2R;
    let vf = aspect >= 1 ? 2 * Math.atan(Math.tan(hf / 2) / aspect) : 2 * Math.atan(Math.tan(hf / 2) * 1) ;
    if (aspect < 1) vf = Math.min(2 * Math.atan(Math.tan(hf / 2) / Math.max(aspect, 0.4)) , 125 * D2R);
    return { view: M4.rigidInv(camW), pos: [camW[12], camW[13], camW[14]], fovy: Math.min(vf, 125 * D2R), near: 0.03 };
  }

  const FLAT = M4.mul(M4.trans(0, 0.035, 0), M4.scale(1, 0, 1));
  const SHADOW_TINT = [0, 0, 0];
  function renderView(v, planeM, sockM) {
    const sc = canvas.width / cssW;
    const x = Math.round(v.x * sc), w = Math.round(v.w * sc), h = Math.round(v.h * sc), y = canvas.height - Math.round((v.y + v.h) * sc);
    gl.viewport(x, y, w, h); gl.scissor(x, y, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    const cam = v.kind === 'fpv' ? fpvCam(v, planeM) : losCam(v, planeM);
    v.cam = cam;
    gl.uniformMatrix4fv(L.uVP, false, M4.mul(M4.persp(cam.fovy, v.w / v.h, cam.near, 7000), cam.view));
    gl.uniform3fv(L.uCam, cam.pos);
    // sky
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    GLR.draw(R, skyMesh, M4.trans(cam.pos[0], cam.pos[1], cam.pos[2]), { unlit: true, noFog: true });
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    const I = M4.ident();
    GLR.draw(R, world.ground, I, { tex: grassTex, worldUV: true, texScale: 1 / 8 });
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -4);
    GLR.draw(R, world.runway, M4.trans(0, 0.02, 0), { tex: runwayTex });
    GLR.draw(R, world.decal, M4.trans(0, 0.02, 0));
    gl.disable(gl.POLYGON_OFFSET_FILL);
    GLR.draw(R, world.scenery, I);
    GLR.draw(R, sockMesh, sockM);
    const model = MODELS[AC.id];
    const partM = [];
    for (const p of model.parts) { const m = p.anim ? M4.chain(planeM, p.mat, p.anim(st)) : M4.mul(planeM, p.mat); partM.push(m); GLR.draw(R, p.mesh, m); }
    const propM = M4.chain(planeM, model.prop.mat, M4.rotZ(propAng));
    if (v.kind !== 'fpv') GLR.draw(R, model.prop.blades, propM);
    // shadow (sun overhead), drawn once per pixel via stencil
    const hgt = planeM[13];
    if (hgt < 120) {
      gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.EQUAL, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-4, -8);
      const a = 0.42 * (1 - smooth(25, 120, hgt));
      for (let i = 0; i < model.parts.length; i++) GLR.draw(R, model.parts[i].mesh, M4.mul(FLAT, partM[i]), { unlit: true, alpha: a, tint: SHADOW_TINT, noFog: true });
      gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.STENCIL_TEST);
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
    if (v.kind !== 'fpv' && st.n > 0.12) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      GLR.draw(R, model.prop.disc, propM, { alpha: 0.16 + 0.1 * st.n, unlit: true });
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
  }

  /* ---------------------------------------------------------------- OSD */
  function osdText(str, x, y, align, fs, color) {
    ctx.textAlign = align; ctx.lineWidth = Math.max(2, fs / 5); ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y); ctx.fillStyle = color || '#ffffff'; ctx.fillText(str, x, y);
  }
  const fmtTime = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  let blink = 0;
  function warnings() {
    const w = [];
    if (st.held && !armed) w.push(['THROTTLE DOWN TO ARM', '#ffd36a']);
    else if (st.held) w.push(['THROTTLE UP TO LAUNCH', '#ffd36a']);
    else if (!armed) w.push(['THROTTLE DOWN TO ARM', '#ffd36a']);
    if (S.battery && st.soc <= 0) w.push(['BATTERY EMPTY', '#ff6157']);
    else if (S.battery && st.vb / AC.batt.cells < (AC.batt.chem === 'liion' ? 3.1 : 3.45) && st.n > 0.05) w.push(['LOW BATTERY', '#ff9d42']);
    const d = Math.hypot(st.p[0], st.p[1]);
    if (d > 400) w.push([`FAR · ${U.dist(d)}`, '#ff9d42']);
    if (-st.p[2] > 121.9) w.push(['ABOVE 400 FT', '#ff9d42']);
    if (S.stallCue && Math.max(st.tele.stallL, st.tele.stallR) > 0.25 && blink % 1 < 0.6) {
      const side = st.tele.stallL - st.tele.stallR > 0.15 ? ' L' : st.tele.stallR - st.tele.stallL > 0.15 ? ' R' : '';
      w.push([`STALL${side}`, '#ff6157']);
    }
    return w;
  }
  function drawOSD(views) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const eu = FL.eulerFromMat(FL.quatToMat(st.q));
    const alt = -st.p[2], gs = Math.hypot(st.v[0], st.v[1]);
    const W = warnings();
    for (const v of views) {
      ctx.save(); ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
      const fs = clamp(Math.round(Math.min(v.w, v.h) / 24), 12, 24);
      ctx.font = `${fs}px "Share Tech Mono", ui-monospace, Menlo, Consolas, monospace`; ctx.textBaseline = 'middle';
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2, m = fs * 1.1;
      const topY = v.y + (v.y < 4 ? 60 + fs : m + fs * 0.4);
      const lift = sticksShown && v.y + v.h >= cssH - 2 ? 165 : 0; // keep the bottom row clear of touch sticks
      if (v.kind === 'fpv' && S.osd !== 'off') {
        const full = S.osd === 'full';
        // crosshair and artificial horizon
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx - fs * 1.2, cy); ctx.lineTo(cx - fs * 0.4, cy); ctx.moveTo(cx + fs * 0.4, cy); ctx.lineTo(cx + fs * 1.2, cy); ctx.moveTo(cx, cy - fs * 0.4); ctx.lineTo(cx, cy - fs * 0.15); ctx.stroke();
        if (full && v.cam) {
          const f = v.h / 2 / Math.tan(v.cam.fovy / 2);
          const pc = eu.pitch + S.fpvTilt * D2R;
          if (Math.abs(pc) < 1.2) {
            const off = f * Math.tan(pc);
            ctx.save(); ctx.translate(cx, cy); ctx.rotate(-eu.roll); ctx.translate(0, off);
            ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 4;
            const L1 = Math.min(v.w, v.h) * 0.22, gap = fs * 2.2;
            ctx.beginPath(); ctx.moveTo(-L1, 0); ctx.lineTo(-gap, 0); ctx.moveTo(gap, 0); ctx.lineTo(L1, 0); ctx.stroke();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
            ctx.restore();
          }
        }
        osdText(S.mode === 'stab' ? 'STAB' : 'MANU', v.x + m, topY, 'left', fs);
        osdText(fmtTime(flightTime), v.x + v.w - m, topY, 'right', fs);
        osdText(`ALT ${U.alt(alt)}`, v.x + m, cy, 'left', fs);
        osdText(`${U.spd(st.tele.V)}`, v.x + v.w - m, cy, 'right', fs);
        if (full) {
          const vs = -st.v[2];
          osdText(`${vs >= 0 ? '↑' : '↓'}${S.units === 'imp' ? Math.abs(vs * 3.28).toFixed(0) + ' ft/s' : Math.abs(vs).toFixed(1) + ' m/s'}`, v.x + m, cy + fs * 1.3, 'left', fs * 0.85);
          osdText(`GS ${U.spd(gs)}`, v.x + v.w - m, cy + fs * 1.3, 'right', fs * 0.85);
        }
        const by = v.y + v.h - m - fs * 0.2 - lift;
        if (S.battery) osdText(`${st.vb.toFixed(1)}V ${Math.round(st.mAh)}mAh`, v.x + m, by, 'left', fs);
        osdText(`THR ${Math.round(inp.thr * 100)}`, cx, by, 'center', fs);
        // home arrow + distance
        const hd = Math.hypot(st.p[0], st.p[1]);
        const brg = Math.atan2(-st.p[1], -st.p[0]) - eu.yaw;
        const ax = v.x + v.w - m - fs * 4.6, ay = by;
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(brg);
        ctx.beginPath(); ctx.moveTo(0, -fs * 0.6); ctx.lineTo(fs * 0.42, fs * 0.45); ctx.lineTo(0, fs * 0.2); ctx.lineTo(-fs * 0.42, fs * 0.45); ctx.closePath();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 2; ctx.stroke(); ctx.fill(); ctx.restore();
        osdText(U.dist(hd), v.x + v.w - m, by, 'right', fs);
      }
      if (v.kind === 'los' && S.losInfo) {
        const s2 = Math.max(11, fs * 0.8);
        ctx.font = `${s2}px "Share Tech Mono", ui-monospace, Menlo, Consolas, monospace`;
        const y2 = v.y + v.h - m - lift;
        osdText(`ALT ${U.alt(alt)}  SPD ${U.spd(st.tele.V)}  THR ${Math.round(inp.thr * 100)}%${S.battery ? '  ' + st.vb.toFixed(1) + 'V' : ''}`, v.x + m, y2, 'left', s2);
        osdText(`WIND ${U.wind(S.windSpd)} from ${compass(S.windDir)} · ${S.mode === 'stab' ? 'STAB' : 'MANUAL'}`, v.x + m, y2 - s2 * 1.4, 'left', s2, 'rgba(255,255,255,0.85)');
        ctx.font = `${fs}px "Share Tech Mono", ui-monospace, Menlo, Consolas, monospace`;
      }
      // warnings
      W.forEach(([t, c], i) => osdText(t, cx, topY + fs * 1.6 + i * fs * 1.35, 'center', fs, c));
      ctx.restore();
    }
    // split divider
    if (views.length > 1) {
      const b = views[1];
      ctx.fillStyle = 'rgba(15,21,25,0.9)';
      if (b.x === 0) ctx.fillRect(0, Math.min(views[0].y + views[0].h, b.y + b.h) - 1, cssW, 3);
      else ctx.fillRect(Math.min(views[0].x + views[0].w, b.x + b.w) - 1, 0, 3, cssH);
      ctx.font = '600 10px "Chakra Petch", system-ui, sans-serif'; ctx.textBaseline = 'top';
      for (const v of views) osdText(v.kind === 'fpv' ? 'FPV' : 'LINE OF SIGHT', v.x + 12, v.y + (v.y < 4 ? 64 : 10), 'left', 11, 'rgba(255,255,255,0.75)');
    }
    if (S.eng) drawEng(views[0]);
    if (S.fps) { ctx.font = '12px "Share Tech Mono", monospace'; ctx.textBaseline = 'bottom'; osdText(`${fpsVal} fps`, cssW - 10, cssH - 8, 'right', 12, '#9fe6b8'); }
  }
  function drawEng(v) {
    const t = st.tele, x = v.x + 12, y0 = v.y + (v.y < 4 ? 92 : 30);
    const lines = [
      `α  ${(t.alpha * R2D).toFixed(1)}°   β ${(t.beta * R2D).toFixed(1)}°`,
      `V  ${t.V.toFixed(1)} m/s   q ${t.qbar.toFixed(0)} Pa`,
      `CL ${t.CL.toFixed(2)}   n ${t.nz.toFixed(2)} g`,
      `T  ${t.T.toFixed(2)} N   ρ ${env.rho.toFixed(3)}`,
    ];
    ctx.font = '12px "Share Tech Mono", ui-monospace, monospace'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(15,21,25,0.72)'; ctx.fillRect(x - 6, y0 - 12, 210, lines.length * 17 + 38);
    lines.forEach((l, i) => osdText(l, x, y0 + i * 17, 'left', 12, '#cfe9f3'));
    const by = y0 + lines.length * 17 + 4;
    osdText('stalled', x, by, 'left', 12, '#cfe9f3');
    for (const [lab, val, ox] of [['L', t.stallL, 60], ['R', t.stallR, 130]]) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x + ox, by - 5, 56, 10);
      ctx.fillStyle = val > 0.25 ? '#ff6157' : '#6ad49a'; ctx.fillRect(x + ox, by - 5, 56 * clamp(val, 0, 1), 10);
      osdText(lab, x + ox - 10, by, 'left', 12, '#cfe9f3');
    }
  }

  /* ---------------------------------------------------------------- audio */
  let actx = null, osc = null, osc2 = null, gainN = null, filt = null;
  function unlockAudio() {
    if (actx || !S.sound) { if (actx && actx.state === 'suspended') actx.resume(); return; }
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      osc = actx.createOscillator(); osc.type = 'sawtooth';
      osc2 = actx.createOscillator(); osc2.type = 'square';
      filt = actx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1400; filt.Q.value = 0.7;
      gainN = actx.createGain(); gainN.gain.value = 0;
      const g2 = actx.createGain(); g2.gain.value = 0.25;
      osc.connect(filt); osc2.connect(g2); g2.connect(filt); filt.connect(gainN); gainN.connect(actx.destination);
      osc.start(); osc2.start();
    } catch (e) { actx = null; }
  }
  function updateAudio(losDist) {
    if (!actx) return;
    const t = actx.currentTime;
    let g = S.sound && !paused && !st.crashed ? 0.012 + 0.05 * st.n : 0;
    let f = (AC.kind === 'wing' ? 120 : 70) + (AC.kind === 'wing' ? 520 : 260) * st.n;
    if (S.view !== 'fpv') {
      g /= 1 + losDist / 45;
      // Doppler for fly-bys (pilot at the origin)
      const r = Math.hypot(st.p[0], st.p[1], st.p[2]) || 1;
      const vr = (st.v[0] * st.p[0] + st.v[1] * st.p[1] + st.v[2] * st.p[2]) / r;
      f *= 343 / (343 + vr);
    }
    gainN.gain.setTargetAtTime(g, t, 0.05);
    osc.frequency.setTargetAtTime(f, t, 0.04);
    osc2.frequency.setTargetAtTime(f * (AC.kind === 'wing' ? 1.5 : 2), t, 0.04);
  }

  /* ---------------------------------------------------------------- loop */
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function updateWind(dt) {
    const Wm = S.windSpd, dir = S.windDir * D2R, sig = (S.gust / 100) * Wm;
    for (let i = 0; i < 3; i++) {
      const tau = i < 2 ? 2.2 : 1.0, s = sig * (i < 2 ? 1 : 0.35);
      gust[i] += (-gust[i] / tau) * dt + s * Math.sqrt((2 * dt) / tau) * gauss();
    }
    const h = Math.max(0.3, -st.p[2]);
    const prof = clamp(Math.log(h / 0.03) / Math.log(10 / 0.03), 0.3, 1.3); // log wind profile, 10 m reference
    env.wind = [(-Wm * Math.cos(dir) + gust[0]) * prof, (-Wm * Math.sin(dir) + gust[1]) * prof, gust[2] * Math.min(1, h / 10)];
  }
  function sockMatrix() {
    const Wm = S.windSpd, dir = S.windDir * D2R;
    const wn = -Wm * Math.cos(dir) + gust[0], we = -Wm * Math.sin(dir) + gust[1];
    const sp = Math.hypot(wn, we);
    const droop = (Math.PI / 2) * 0.92 * (1 - clamp(sp / 7, 0, 1));
    return M4.chain(M4.trans(SOCK_POS[0], SOCK_POS[1], SOCK_POS[2]), M4.rotY(Math.atan2(wn, we)), M4.rotZ(-droop));
  }
  function controls() {
    const ex = (x, e) => { const k = e / 100; return x * (k * x * x + 1 - k); };
    const T = AC.trim;
    return {
      thr: armed ? inp.thr : 0,
      a: FL.sat((ex(inp.a, S.expo.a) * S.rates.a) / 100 + T.a),
      e: FL.sat((ex(inp.e, S.expo.e) * S.rates.e) / 100 + T.e),
      r: FL.sat((ex(inp.r, S.expo.r) * S.rates.r) / 100),
      sa: inp.a, se: inp.e,
    };
  }
  function checkObstacles() {
    if (!S.crashes || st.crashed || st.held) return;
    const x = st.p[1], y = -st.p[2], z = -st.p[0];
    for (const o of world.obstacles) {
      const dx = x - o.x, dz = z - o.z;
      if (y < o.h && dx * dx + dz * dz < (o.r + 0.4) * (o.r + 0.4)) { st.crashed = true; st.crashMsg = 'Hit an obstacle'; return; }
    }
  }

  let last = performance.now(), fpsN = 0, fpsT = 0, fpsVal = 0, barT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = Math.max(0, (now - last) / 1000); last = now;
    const dt = Math.min(0.1, raw); // physics never takes a bigger bite than 0.1 s
    blink += dt;
    fpsN++; fpsT += dt; if (fpsT > 0.5) { fpsVal = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
    const p = pollInput(dt);
    if (wiz.open) wizTick(p, Math.min(0.5, raw)); // wizard timers use real time

    if (!paused) {
      if (!armed && inp.thr < 0.05) armed = true;
      if (st.held && armed) {
        // throw once the motor is wound up: throttle above 70% for 0.3 s
        if (inp.thr > 0.7) launchHold += dt; else launchHold = 0;
        if (launchHold > 0.3) { FL.launch(st); timerOn = true; }
      }
      updateWind(dt);
      acc += dt;
      const c = controls();
      let steps = 0;
      while (acc >= DT && steps < 60) {
        const cc = S.mode === 'stab' ? FL.stabilize({ thr: c.thr, a: c.sa, e: c.se, r: c.r }, st, AC) : c;
        FL.step(st, AC, cc, env, DT);
        acc -= DT; steps++;
      }
      if (steps >= 60) acc = 0;
      checkObstacles();
      if (!timerOn && armed && inp.thr > 0.1) timerOn = true;
      if (timerOn && !st.crashed) flightTime += dt;
      propAng += st.n * dt * 60;
      if (st.crashed) {
        if (!crashAt) crashAt = now;
        if (!crashAnnounced) { crashAnnounced = true; showBanner('Crashed', `${st.crashMsg}. ${S.autoReset ? 'Resetting…' : 'Press R, flip reset, or tap here.'}`, true); }
        if (S.autoReset && now - crashAt > 3000) doReset();
      }
      const d = Math.hypot(st.p[0], st.p[1]);
      if (d > 1500) { doReset(); toast('Flew out of range. Reset.'); }
    }
    const planeM = planeMatrix(st);
    const views = layout();
    const losD = Math.hypot(planeM[12] - EYE[0], planeM[13] - EYE[1], planeM[14] - EYE[2]);
    // LOS zoom: keep the wingspan at a set share of the view height (mild 4%, strong 8%)
    const share = { mild: 0.04, strong: 0.08 }[S.losZoom];
    const target = share ? clamp(AC.b / (Math.max(losD, 0.1) * share), 6 * D2R, 55 * D2R) : 55 * D2R;
    losFov += (target - losFov) * Math.min(1, dt * 3);
    const sockM = sockMatrix();
    for (const v of views) renderView(v, planeM, sockM);
    drawOSD(views);
    updateAudio(losD);
    barT += dt; if (barT > 0.25) { barT = 0; refreshBar(); refreshTouch(); }
  }

  /* ---------------------------------------------------------------- boot */
  buildWorld(S.scenery);
  resize();
  doReset();
  refreshBar(); refreshTouch(); refreshRadioBox();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { gl.bindTexture(gl.TEXTURE_2D, runwayTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, runwayTexture()); gl.generateMipmap(gl.TEXTURE_2D); });
  requestAnimationFrame((t) => { last = t; frame(t); });
  window.__flightline = { st, S, env, AC: () => AC, doReset, FL };
})();
