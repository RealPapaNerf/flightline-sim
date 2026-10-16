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
    losZoom: 'mild', fpvFov: 110, osd: 'full', losInfo: true, stallCue: false,
    tilt: { goblin: 5, trainer: 0, quad: 30, heli: 5 }, // FPV camera tilt per aircraft (°)
    // limits (°) for Stabilised/Angle and Trainer modes, separately for planes and rotorcraft
    lim: { plane: { bank: 45, pitch: 30, tBank: 60, tPitch: 45 }, rotary: { bank: 55, pitch: 55, tBank: 60, tPitch: 60 } },
    fc: {}, // Betaflight-style rates per rotorcraft, filled from the aircraft defaults
    stickMode: '2', touch: 'auto',
    rates: { a: 100, e: 100, r: 100 }, expo: { a: 25, e: 20, r: 15 },
    windSpd: 2, windDir: 90, gust: 30, elevFt: 0, tempF: 59,
    // weather: turbulence %, humidity %, altimeter inHg, precipitation, fog/mist visibility (m, 10000 = clear),
    // cloud ceiling (ft above the field, 0 = none), pack pre-warmed, ice indicator, last preset picked
    turb: 15, rh: 40, altim: 29.92, precip: 'none', fogVis: 10000, ceilFt: 0, packWarm: false, iceCue: true, wxPreset: 'clear',
    battery: true, crashes: true, autoReset: true,
    quality: 1, scenery: 'med', aa: false, fps: false, eng: false, sound: true, units: 'imp',
    trim: {}, // user trims per aircraft, stick units, set from controller trim buttons
    course: true, best: {}, // gate course lap timer, best lap per aircraft (s)
    curve: 'normal', // helicopter pitch curve: 'normal' or '3d' (idle up)
    sheetTab: 'aircraft', // last settings tab
    hud: 'hud', // FPV OSD style: 'hud' (pitch ladder and tapes) or 'classic'
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
  for (const g of ['plane', 'rotary']) S.lim[g] = Object.assign({}, DEF.lim[g], S.lim[g]);
  const saveS = () => store(SKEY, S);

  const U = {
    alt: (m) => (S.units === 'imp' ? `${Math.round(m * 3.2808)} ft` : `${Math.round(m)} m`),
    spd: (v) => (S.units === 'imp' ? `${Math.round(v * 2.23694)} mph` : `${Math.round(v * 3.6)} km/h`),
    dist: (m) => (S.units === 'imp' ? `${Math.round(m * 3.2808)} ft` : `${Math.round(m)} m`),
    wind: (v) => (S.units === 'imp' ? `${(v * 2.23694).toFixed(0)} mph` : `${v.toFixed(1)} m/s`),
  };
  const fToC = (f) => ((f - 32) * 5) / 9;
  const UW = {
    temp: (f) => (S.units === 'imp' ? `${Math.round(f)}°F` : `${Math.round(fToC(f))}°C`),
    tempC: (c) => (S.units === 'imp' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`),
    vis: (m) => (m >= 10000 ? 'Unlimited' : S.units === 'imp' ? (m < 1609 ? `${Math.round(m * 3.2808 / 50) * 50} ft` : `${(m / 1609.34).toFixed(1)} mi`) : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`),
    ceil: (ftv) => (!ftv ? 'None' : S.units === 'imp' ? `${ftv.toLocaleString()} ft` : `${Math.round(ftv * 0.3048)} m`),
    press: (inHg) => (S.units === 'imp' ? `${inHg.toFixed(2)} inHg` : `${Math.round(inHg * 33.8639)} hPa`),
  };
  /* Weather presets. Each sets the conditions listed; field elevation and wind direction stay yours
     unless the preset is about them. */
  const WX_PRESETS = [
    ['clear', 'Clear day', 'Light breeze, mild, dry.', { windSpd: 2, gust: 30, turb: 15, tempF: 68, rh: 40, altim: 29.92, precip: 'none', fogVis: 10000, ceilFt: 0 }],
    ['hot', 'High & hot', 'Utah July afternoon at 6,000 ft: density altitude near 10,000 ft, thermal bumps, gusty.', { elevFt: 6000, windSpd: 5, gust: 50, turb: 45, tempF: 98, rh: 12, altim: 30.05, precip: 'none', fogVis: 10000, ceilFt: 0 }],
    ['humid', 'Hot & humid', 'Muggy summer day: humidity adds a few hundred feet of density altitude.', { windSpd: 3, gust: 30, turb: 25, tempF: 94, rh: 85, altim: 29.85, precip: 'none', fogVis: 8000, ceilFt: 0 }],
    ['front', 'Cold front', 'Gusty, turbulent, showers, ragged 1,500 ft ceiling.', { windSpd: 10, gust: 60, turb: 55, tempF: 45, rh: 75, altim: 29.65, precip: 'rain', fogVis: 10000, ceilFt: 1500 }],
    ['storm', 'Storm outflow', 'Thunderstorm gust front: strong gusts, severe turbulence, heavy rain.', { windSpd: 13, gust: 90, turb: 85, tempF: 72, rh: 85, altim: 29.8, precip: 'heavy', fogVis: 10000, ceilFt: 2500 }],
    ['winter', 'Cold & clear', 'Winter high pressure: dense air, cold packs.', { windSpd: 3, gust: 30, turb: 10, tempF: 12, rh: 60, altim: 30.4, precip: 'none', fogVis: 10000, ceilFt: 0 }],
    ['fzfog', 'Freezing fog', '27°F, 300 m visibility: the fog itself is supercooled water. Props and lens ice.', { windSpd: 1.5, gust: 20, turb: 5, tempF: 27, rh: 100, altim: 30.3, precip: 'none', fogVis: 300, ceilFt: 0 }],
    ['fzdz', 'Freezing drizzle', '30°F drizzle under a 500 ft overcast. Climb into the cloud and you ice up fast.', { windSpd: 4, gust: 30, turb: 20, tempF: 30, rh: 98, altim: 29.9, precip: 'drizzle', fogVis: 10000, ceilFt: 500 }],
    ['snow', 'Snow squall', 'Heavy snow, 400 m visibility, gusty. Wet snow sticks near freezing.', { windSpd: 8, gust: 60, turb: 40, tempF: 28, rh: 92, altim: 29.75, precip: 'heavysnow', fogVis: 10000, ceilFt: 900 }],
  ];
  const WX_KEYS = ['elevFt', 'windSpd', 'gust', 'turb', 'tempF', 'rh', 'altim', 'precip', 'fogVis', 'ceilFt'];
  const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  /* ---------------------------------------------------------------- aircraft */
  const ACS = {};
  for (const id of Object.keys(FL.DEFS)) ACS[id] = FL.build(FL.DEFS[id]);
  let AC = ACS[S.aircraft];
  const START_LABEL = { launch: 'Hand launch', runway: 'Runway', air: 'In the air', pad: 'Launch pad' };
  const ROTARY = (ac) => ac.kind === 'quad' || ac.kind === 'heli';
  for (const id of Object.keys(ACS)) if (ACS[id].rates) { // rotorcraft rates live in settings so they persist
    const def = ACS[id].rates, cur = S.fc[id] || {};
    S.fc[id] = Object.fromEntries(Object.keys(def).map((k) => [k, Object.assign({}, def[k], cur[k])]));
    ACS[id].rates = S.fc[id];
  }
  const MODES = ['manual', 'horizon', 'trainer', 'stab'];
  const modeName = (m) => (ROTARY(AC) ? { manual: 'Acro', horizon: 'Horizon', trainer: 'Acro trainer', stab: 'Angle' } : { manual: 'Manual', horizon: 'Horizon', trainer: 'Trainer', stab: 'Stabilised' })[m] || 'Manual';
  const modeOsd = (m) => (ROTARY(AC) ? { manual: 'ACRO', horizon: 'HORZ', trainer: 'TRNR', stab: 'ANGL' } : { manual: 'MANU', horizon: 'HORZ', trainer: 'TRNR', stab: 'STAB' })[m] || 'MANU';
  const limNow = () => S.lim[ROTARY(AC) ? 'rotary' : 'plane'];
  const tiltOf = () => (S.tilt[AC.id] !== undefined ? S.tilt[AC.id] : AC.camTilt || 0);
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
    gl.uniform1f(L.uFogK, 0); gl.uniform3fv(L.uSunCol, [0.8, 0.76, 0.68]);
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
    const tree = (x, z, h, cr, kind) => {
      g.cyl(x, 0, z, 0.25, 0.18, h * 0.35, 5, C.trunk, false);
      if (kind < 0.45) { g.cyl(x, h * 0.25, z, cr, 0, h * 0.55, 7, C.tree); g.cyl(x, h * 0.55, z, cr * 0.7, 0, h * 0.45, 7, C.tree2); }
      else if (kind < 0.8) g.blob(x, h * 0.62, z, cr, h * 0.42, cr, kind < 0.62 ? C.tree2 : C.tree);
      else g.blob(x, h * 0.45, z, cr * 0.75, h * 0.45, cr * 0.75, C.juniper);
      obstacles.push({ x, z, r: cr * 0.75, h });
    };
    const keepClear = (x, z) =>
      (Math.abs(z + 12) < 45 && Math.abs(x) < 450) || // runway approach corridors
      (Math.abs(x) < 115 && z < -35 && z > -200) || // race course
      Math.hypot(x - 195, z + 108) < 30 || Math.hypot(x + 200, z + 250) < 18 || Math.hypot(x - 260, z + 390) < 22 || // farm, tower, search scene
      Math.abs(z + 330) < 8; // under the power line
    let placed = 0, tries = 0;
    while (placed < counts[0] && tries++ < 6000) {
      const ang = rnd() * Math.PI * 2, r = 120 + Math.pow(rnd(), 0.8) * 850;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      if (keepClear(x, z)) continue;
      tree(x, z, 5 + rnd() * 7, 1.6 + rnd() * 2.2, rnd());
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
    // ---------- obstacles ----------
    // Collision shapes: {x,z,r,h} cylinders standing on the ground, {k:'cyl', x,z,r,y0,y1},
    // axis-aligned {k:'box'}, and {k:'seg', a,b,r} for wires, bars and posts at any angle.
    const seg = (a2, b2, r) => obstacles.push({ k: 'seg', a: a2, b: b2, r });
    const tf = (m, q) => [m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12], m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13], m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14]];
    // pylons for plane patterns
    for (const x of [-150, 150]) { g.cyl(x, 0, -120, 0.7, 0.05, 3.2, 8, C.orange); g.cyl(x, 1.4, -120, 0.4, 0.33, 0.4, 8, C.white, false); obstacles.push({ x, z: -120, r: 0.6, h: 3.2 }); }
    // big gates for planes
    const bigGate = (m) => g.with(m, () => {
      for (const x of [-10, 10]) g.cyl(x, 0, 0, 0.25, 0.25, 9.6, 8, C.white);
      g.box(-10.3, 9.0, -0.25, 10.3, 9.6, 0.25, C.white);
      g.box(-9.7, 7.5, -0.08, 9.7, 9.0, 0.08, C.blue);
    });
    bigGate(M4.trans(0, 0, -240));
    bigGate(M4.mul(M4.trans(-250, 0, -70), M4.rotY(Math.PI / 2)));
    for (const [x, z] of [[-10, -240], [10, -240], [-250, -60], [-250, -80]]) obstacles.push({ x, z, r: 0.35, h: 9.6 });
    seg([-10, 9.3, -240], [10, 9.3, -240], 0.4); seg([-250, 9.3, -60], [-250, 9.3, -80], 0.4);

    // FPV race course: 8 gates on an oval north of the runway, flown in order
    const gates = [];
    const NG = 8, ocx = 0, ocz = -118, orx = 78, orz = 52, raise = [0, 0, 0, 3, 0, 0, 1.5, 0];
    for (let k = 0; k < NG; k++) {
      const th = Math.PI / 2 + (k / NG) * Math.PI * 2;
      const x = ocx + orx * Math.cos(th), z = ocz + orz * Math.sin(th);
      const tx = -orx * Math.sin(th), tz = orz * Math.cos(th);
      const psi = Math.atan2(tx, tz); // gate normal along the course direction
      const bb = raise[k], W = 2.2, H = 2.0, col = k % 2 ? C.blue : C.orange;
      const m = M4.mul(M4.trans(x, 0, z), M4.rotY(psi));
      g.with(m, () => {
        g.box(-W / 2 - 0.2, bb, -0.1, -W / 2, bb + H + 0.2, 0.1, col);
        g.box(W / 2, bb, -0.1, W / 2 + 0.2, bb + H + 0.2, 0.1, col);
        g.box(-W / 2 - 0.2, bb + H, -0.1, W / 2 + 0.2, bb + H + 0.2, 0.1, col);
        if (bb > 0) {
          g.box(-W / 2 - 0.2, bb - 0.2, -0.1, W / 2 + 0.2, bb, 0.1, col);
          for (const sx of [-1, 1]) g.box(sx * (W / 2 + 0.1) - 0.05, 0, -0.05, sx * (W / 2 + 0.1) + 0.05, bb - 0.2, 0.05, C.post);
        } else for (const sx of [-1, 1]) g.box(sx * (W / 2 + 0.1) - 0.25, 0, -0.35, sx * (W / 2 + 0.1) + 0.25, 0.06, 0.35, C.post);
      });
      const P = (lx, ly) => tf(m, [lx, ly, 0]);
      seg(P(-W / 2 - 0.1, 0), P(-W / 2 - 0.1, bb + H + 0.2), 0.12);
      seg(P(W / 2 + 0.1, 0), P(W / 2 + 0.1, bb + H + 0.2), 0.12);
      seg(P(-W / 2 - 0.2, bb + H + 0.1), P(W / 2 + 0.2, bb + H + 0.1), 0.12);
      if (bb > 0) seg(P(-W / 2 - 0.2, bb - 0.1), P(W / 2 + 0.2, bb - 0.1), 0.12);
      gates.push({ x, z, psi, b: bb, W, H, top: bb + H + 0.2 });
    }

    // slalom poles east of the runway
    for (let x = 70; x <= 170; x += 20) {
      for (let k = 0; k < 5; k++) g.cyl(x, k, -40, 0.09, 0.09, 1, 8, k % 2 ? C.white : [0.85, 0.15, 0.12], false);
      obstacles.push({ x, z: -40, r: 0.09, h: 5 });
    }
    // tree line west of the course, and one big lone tree
    for (let z = -20; z >= -200; z -= 14) tree(-170 + (rnd() - 0.5) * 4, z, 8 + rnd() * 5, 2 + rnd() * 1.4, rnd() * 0.8);
    tree(70, -215, 15, 5, 0.7);

    // power line across the north end; the wires are thin and hard to see, like real ones
    const wireCol = [0.13, 0.13, 0.14];
    const ribbon = (a2, b2, w) => {
      const d = [b2[0] - a2[0], b2[1] - a2[1], b2[2] - a2[2]];
      const sd = Math.hypot(d[0], d[2]) || 1, s2 = [-d[2] / sd * w / 2, 0, d[0] / sd * w / 2], u = [0, w / 2, 0];
      const add = (p2, q) => [p2[0] + q[0], p2[1] + q[1], p2[2] + q[2]], sub = (p2, q) => [p2[0] - q[0], p2[1] - q[1], p2[2] - q[2]];
      g.quad(add(a2, u), add(b2, u), sub(b2, u), sub(a2, u), wireCol);
      g.quad(add(a2, s2), add(b2, s2), sub(b2, s2), sub(a2, s2), wireCol);
    };
    const PLZ = -330, poles = [];
    for (let x = -630; x <= 630; x += 70) poles.push(x);
    for (const x of poles) {
      g.cyl(x, 0, PLZ, 0.16, 0.13, 10, 6, [0.42, 0.32, 0.22]);
      g.box(x - 0.08, 9.1, PLZ - 1.4, x + 0.08, 9.3, PLZ + 1.4, [0.42, 0.32, 0.22]);
      obstacles.push({ x, z: PLZ, r: 0.16, h: 10 });
      obstacles.push({ k: 'box', x0: x - 0.1, x1: x + 0.1, y0: 9.1, y1: 9.3, z0: PLZ - 1.4, z1: PLZ + 1.4 });
    }
    for (let i = 0; i < poles.length - 1; i++) for (const dz of [-1.2, 0, 1.2]) {
      const x0 = poles[i], x1 = poles[i + 1], sag = 0.9, n = 4;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n;
        const A = [lerp(x0, x1, t0), 9.45 - 4 * sag * t0 * (1 - t0), PLZ + dz], B = [lerp(x0, x1, t1), 9.45 - 4 * sag * t1 * (1 - t1), PLZ + dz];
        ribbon(A, B, 0.05);
        seg(A, B, 0.04);
      }
    }

    // farm: barn and silo
    const red = [0.62, 0.16, 0.12], roofC = [0.3, 0.3, 0.32];
    g.box(184, 0, -116, 196, 6, -104, { top: roofC, bottom: red, side: red });
    g.quad([183.5, 6, -116.5], [196.5, 6, -116.5], [196.5, 9, -110], [183.5, 9, -110], roofC);
    g.quad([183.5, 9, -110], [196.5, 9, -110], [196.5, 6, -103.5], [183.5, 6, -103.5], roofC);
    for (const x of [184, 196]) g.tri([x, 6, -116], [x, 9, -110], [x, 6, -104], red);
    g.box(188, 0, -103.98, 192, 4, -103.9, C.white);
    obstacles.push({ k: 'box', x0: 184, x1: 196, y0: 0, y1: 6, z0: -116, z1: -104 });
    obstacles.push({ k: 'box', x0: 184, x1: 196, y0: 6, y1: 9, z0: -113, z1: -107 });
    g.cyl(203, 0, -112, 2.6, 2.6, 13, 10, [0.62, 0.66, 0.7]);
    g.blob(203, 13, -112, 2.6, 1.6, 2.6, [0.55, 0.58, 0.62]);
    obstacles.push({ x: 203, z: -112, r: 2.6, h: 14.6 });

    // water tower
    for (const [dx, dz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) { g.cyl(-200 + dx, 0, -250 + dz, 0.18, 0.18, 15, 6, [0.7, 0.72, 0.75], false); obstacles.push({ x: -200 + dx, z: -250 + dz, r: 0.18, h: 15 }); }
    g.cyl(-200, 15, -250, 4, 4, 6, 14, [0.82, 0.86, 0.9]);
    g.cyl(-200, 21, -250, 4.2, 0, 2, 14, [0.5, 0.56, 0.62]);
    obstacles.push({ k: 'cyl', x: -200, z: -250, r: 4.1, y0: 15, y1: 23 });

    // search scene in the scrub: parked car, tent, and a person in a red jacket
    g.box(256, 0.3, -392, 260.4, 1.0, -390.2, [0.2, 0.35, 0.65]);
    g.box(257, 1.0, -391.8, 259.4, 1.5, -390.4, [0.16, 0.25, 0.45]);
    for (const [x, z] of [[256.8, -392.05], [259.6, -392.05], [256.8, -390.15], [259.6, -390.15]]) g.with(M4.mul(M4.trans(x, 0.32, z), M4.rotX(Math.PI / 2)), () => g.cyl(0, -0.12, 0, 0.32, 0.32, 0.24, 8, [0.08, 0.08, 0.09]));
    obstacles.push({ k: 'box', x0: 256, x1: 260.4, y0: 0, y1: 1.5, z0: -392, z1: -390.2 });
    g.tri([264, 0, -386], [266, 1.4, -386], [268, 0, -386], [1.0, 0.5, 0.1]);
    g.tri([264, 0, -389], [266, 1.4, -389], [268, 0, -389], [1.0, 0.5, 0.1]);
    g.quad([264, 0, -386], [266, 1.4, -386], [266, 1.4, -389], [264, 0, -389], [1.0, 0.5, 0.1]);
    g.quad([268, 0, -386], [266, 1.4, -386], [266, 1.4, -389], [268, 0, -389], [0.9, 0.44, 0.08]);
    g.box(271.1, 0, -383.1, 271.5, 0.85, -382.9, [0.2, 0.22, 0.28]);
    g.box(271, 0.85, -383.15, 271.6, 1.45, -382.85, [0.85, 0.12, 0.1]);
    g.blob(271.3, 1.6, -383, 0.13, 0.15, 0.13, [0.85, 0.68, 0.55]);

    // windsock pole
    g.cyl(SOCK_POS[0], 0, SOCK_POS[2], 0.07, 0.05, SOCK_POS[1], 6, C.white);
    obstacles.push({ x: SOCK_POS[0], z: SOCK_POS[2], r: 0.2, h: SOCK_POS[1] });

    if (world) for (const k of ['ground', 'runway', 'decal', 'scenery']) GLR.freeMesh(R, world[k]);
    // normalise collision shapes and keep a coarse radius for quick rejection
    const shapes = obstacles.map((o) => (o.k ? o : { k: 'cyl', x: o.x, z: o.z, r: o.r, y0: 0, y1: o.h }));
    for (const o of shapes) {
      if (o.k === 'cyl') { o.cx = o.x; o.cz = o.z; o.br = o.r; }
      else if (o.k === 'box') { o.cx = (o.x0 + o.x1) / 2; o.cz = (o.z0 + o.z1) / 2; o.br = Math.hypot(o.x1 - o.x0, o.z1 - o.z0) / 2; }
      else { o.cx = (o.a[0] + o.b[0]) / 2; o.cz = (o.a[2] + o.b[2]) / 2; o.br = Math.hypot(o.b[0] - o.a[0], o.b[2] - o.a[2]) / 2 + o.r; }
    }
    // things tall and wide enough to make a turbulent wake downwind (trees, barn, silo, shed)
    const blockers = [];
    for (const o of shapes) {
      if (o.k === 'cyl' && o.y0 < 2 && o.y1 >= 3.5 && o.r >= 0.5) blockers.push({ n: -o.z, e: o.x, r: o.r * 1.3, h: o.y1 });
      else if (o.k === 'box' && o.y0 < 2 && o.y1 >= 3 && o.x1 - o.x0 > 2) blockers.push({ n: -(o.z0 + o.z1) / 2, e: (o.x0 + o.x1) / 2, r: Math.hypot(o.x1 - o.x0, o.z1 - o.z0) / 2, h: o.y1 });
    }
    world = { ground: GLR.mesh(R, gg), runway: GLR.mesh(R, gr), decal: GLR.mesh(R, gd), scenery: GLR.mesh(R, g), obstacles: shapes, gates, blockers };
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

  // weather: an overcast dome drawn over the sky, and a cloud deck (rings, finer near the camera so the
  // per-vertex fog distance stays right) that follows the camera at the ceiling height
  const overMesh = (() => {
    const g = new Geo(), seg = 24, rad = 4900, rings = [-0.4, 0, 0.15, 0.5, Math.PI / 2];
    for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < seg; i++) {
      const e0 = rings[r], e1 = rings[r + 1], a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const P = (e, a) => [rad * Math.cos(e) * Math.cos(a), rad * Math.sin(e), rad * Math.cos(e) * Math.sin(a)];
      g.triV(P(e0, a0), P(e0, a1), P(e1, a1), [1, 1, 1], [1, 1, 1], [1, 1, 1]);
      g.triV(P(e0, a0), P(e1, a1), P(e1, a0), [1, 1, 1], [1, 1, 1], [1, 1, 1]);
    }
    return GLR.mesh(R, g);
  })();
  const cloudMesh = (() => {
    const g = new Geo(), seg = 28, radii = [0, 25, 60, 120, 240, 480, 960, 1900, 3800, 6000];
    for (let r = 0; r < radii.length - 1; r++) for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, r0 = radii[r], r1 = radii[r + 1];
      const P = (rr, a) => [rr * Math.cos(a), 0, rr * Math.sin(a)];
      g.quad(P(r0, a0), P(r1, a0), P(r1, a1), P(r0, a1), [1, 1, 1]);
    }
    return GLR.mesh(R, g);
  })();
  /* How the scene looks from a camera at height camH: fog colour and extinction from the visibility,
     how overcast it is, sun strength. Clear weather keeps the original haze-only look. */
  const SKY_AMB = [0.52, 0.56, 0.62], GND_AMB = [0.34, 0.31, 0.27];
  function lookFrom(camH) {
    const w = FL.weatherAt(wxBase, Math.max(0, camH)), P = S.precip, snow = P === 'snow' || P === 'heavysnow';
    const clear = !w.inCloud && P === 'none' && S.fogVis >= 10000;
    const over = w.inCloud ? 1 : clamp((S.ceilFt > 0 ? 0.85 : 0) + (P !== 'none' ? 0.6 : 0) + (S.fogVis < 3000 ? 0.7 : S.fogVis < 10000 ? 0.3 : 0), 0, 1);
    const grey = w.inCloud ? [0.8, 0.82, 0.84] : snow ? [0.8, 0.82, 0.85] : P === 'heavy' ? [0.5, 0.53, 0.57] : P !== 'none' ? [0.6, 0.63, 0.67] : S.ceilFt > 0 ? [0.66, 0.69, 0.72] : [0.74, 0.76, 0.78];
    const fog = mixc(FOG, grey, over), k = clear ? 0 : 3.912 / w.visM;
    return { fog, k, over, sky: Math.max(over, 1 - Math.exp(-k * 1500)), sun: 1 - 0.75 * over, inCloud: w.inCloud, snow, w };
  }
  function applyLook(lk) {
    gl.uniform3fv(L.uFog, lk.fog); gl.uniform1f(L.uFogK, lk.k);
    gl.uniform3fv(L.uSunCol, [0.8 * lk.sun, 0.76 * lk.sun, 0.68 * lk.sun]);
    gl.uniform3fv(L.uSkyAmb, mixc(SKY_AMB, [0.66, 0.67, 0.69], lk.over));
    gl.uniform3fv(L.uGndAmb, mixc(GND_AMB, [0.42, 0.42, 0.42], lk.over * 0.6));
    gl.clearColor(lk.fog[0], lk.fog[1], lk.fog[2], 1);
  }
  // ground under snow: only when it's snowing and cold enough to lie
  const snowCover = () => ((S.precip === 'snow' || S.precip === 'heavysnow') && atmo.Tc <= 1 ? (S.precip === 'heavysnow' ? 0.72 : 0.5) : 0);
  // ice the pilot can see: plane surfaces whiten with relative ice height; props and blades with prop ice
  const propChord = (ac) => (ac.kind === 'quad' ? 0.09 * ac.motor.D : ac.kind === 'heli' ? ac.rotor.chord : 0.08 * ac.prop.D + 0.006);
  function iceInfo() {
    let kc = 0;
    if (st.ice && AC.strips) { let a = 0; AC.strips.forEach((sp, i) => { if (sp.role === 'wing') { kc += (st.ice[i] / sp.chord) * sp.area; a += sp.area; } }); kc = a ? kc / a : 0; }
    const pen = FL.icePenalty(kc, st.iceGl), pi = FL.propIce(st.iceProp / propChord(AC));
    return { kc, lift: pen.dCL, prop: 1 - pi.thrust, mass: st.iceMass };
  }
  const markerMesh = (() => { const g = new Geo(); g.blob(0, 0, 0, 1, 1, 1, [1.0, 0.55, 0.1]); return GLR.mesh(R, g); })();

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
  function propMeshes(g, blades, rad, col, discCol) {
    const gb = new Geo();
    for (let i = 0; i < blades; i++) gb.with(M4.rotZ((i / blades) * Math.PI * 2), () => gb.box(0, -rad * 0.07, -0.004, rad, rad * 0.07, 0.004, col));
    const gd = new Geo(); gd.disc(rad, 24, discCol || [0.75, 0.77, 0.8]);
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
    return { parts, props: [{ blades: pm.blades, disc: pm.disc, mat: M4.trans(0, 0, propZ), spin: (s0) => s0.n, dir: 1, ang: 0 }], cam: BR(ac.fpvCam) };
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
    return { parts, props: [{ blades: pm.blades, disc: pm.disc, mat: M4.trans(0, 0, -0.455), spin: (s0) => s0.n, dir: 1, ang: 0 }], cam: BR(ac.fpvCam) };
  }
  function buildQuad(ac) {
    const carbon = [0.14, 0.14, 0.15], dark = [0.06, 0.06, 0.07], battC = [0.98, 0.78, 0.15], bell = [0.72, 0.74, 0.78];
    const frontC = [1.0, 0.45, 0.1], rearC = [0.85, 0.87, 0.9];
    const g = new Geo();
    const bar = (a, b, w, t, col) => {
      const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * (w / 2), nz = (dx / l) * (w / 2);
      slab(g, [a[0] + nx, a[1], a[2] + nz], [b[0] + nx, b[1], b[2] + nz], [b[0] - nx, b[1], b[2] - nz], [a[0] - nx, a[1], a[2] - nz], t, t, col, col, col);
    };
    for (const [x, y] of ac.motors) bar([0, 0, 0], BR([x, y, 0]), 0.022, 0.006, carbon);
    g.box(-0.03, -0.004, -0.055, 0.03, 0.004, 0.055, carbon); // bottom plate
    g.box(-0.02, 0.004, -0.028, 0.02, 0.026, 0.028, dark); // stack
    g.box(-0.028, 0.026, -0.05, 0.028, 0.03, 0.05, carbon); // top plate
    g.box(-0.018, 0.03, -0.038, 0.018, 0.062, 0.038, { top: battC, bottom: dark, side: battC, front: dark, back: dark }); // battery
    g.box(-0.019, 0.044, -0.008, 0.019, 0.063, 0.008, dark); // strap
    g.box(-0.016, 0.0, -0.075, 0.016, 0.03, -0.05, dark); // camera
    g.box(-0.004, 0.005, 0.05, 0.004, 0.06, 0.056, dark); // antenna
    const props = [];
    ac.motors.forEach(([x, y, q], i) => {
      const P = BR([x, y, 0]);
      g.cyl(P[0], -0.004, P[2], 0.013, 0.013, 0.018, 10, bell);
      const front = x > 0, col = front ? frontC : rearC;
      const pm = propMeshes(g, 3, 0.0635, col, col);
      props.push({ blades: pm.blades, disc: pm.disc, mat: M4.mul(M4.trans(P[0], 0.02, P[2]), M4.rotX(-Math.PI / 2)), spin: (s0) => s0.mot[i], dir: q, ang: i, hideFpv: true });
    });
    return { parts: [{ mesh: GLR.mesh(R, g), mat: M4.ident() }], props, cam: BR(ac.fpvCam) };
  }
  function buildHeli(ac) {
    const Ro = ac.rotor;
    const red = [0.92, 0.16, 0.12], white = [0.95, 0.95, 0.93], dark = [0.08, 0.08, 0.09], frame = [0.22, 0.23, 0.25], alu = [0.72, 0.74, 0.78];
    const blade = [0.12, 0.12, 0.13], tip = [1.0, 0.85, 0.15];
    const g = new Geo();
    g.box(-0.026, -0.08, -0.02, 0.026, 0.1, 0.11, frame); // side frames
    g.box(-0.02, -0.075, 0.02, 0.02, -0.04, 0.12, { top: [0.2, 0.45, 0.9], bottom: dark, side: [0.2, 0.45, 0.9] }); // battery
    g.blob(0, 0.015, -0.07, 0.06, 0.092, 0.2, red); // canopy
    g.blob(0, 0.05, -0.17, 0.04, 0.042, 0.085, [0.12, 0.16, 0.22]); // windscreen
    g.blob(0.024, -0.005, -0.08, 0.04, 0.06, 0.15, white); // white flash on the right side, for orientation
    g.cyl(0, 0.1, 0, 0.005, 0.005, 0.08, 6, alu); // main shaft
    g.box(-0.016, 0.168, -0.016, 0.016, 0.19, 0.016, alu); // rotor head
    g.taper(0.1, 0.022, 0.022, 0.03, 0.62, 0.014, 0.014, 0.03, alu); // tail boom
    slab(g, [-0.075, 0.03, 0.44], [0.075, 0.03, 0.44], [0.075, 0.03, 0.49], [-0.075, 0.03, 0.49], 0.004, 0.004, dark, dark, dark); // horizontal stab
    slab(g, [0, -0.05, 0.6], [0, 0.11, 0.6], [0, 0.11, 0.655], [0, -0.05, 0.665], 0.004, 0.004, white, white, white, [1, 0, 0]); // fin
    g.box(-0.012, 0.015, 0.6, 0.012, 0.045, 0.64, frame); // tail gearbox
    // landing gear: two skids and four struts
    for (const x of [-0.075, 0.075]) {
      g.box(x - 0.005, -0.175, -0.17, x + 0.005, -0.165, 0.16, dark);
      for (const z of [-0.09, 0.09]) g.box(x * 0.6 - 0.004, -0.17, z - 0.006, x * 0.6 + 0.004, -0.08, z + 0.006, dark);
      g.box(x - 0.004, -0.168, -0.2, x + 0.004, -0.15, -0.17, dark); // upturned skid tip
    }
    const parts = [{ mesh: GLR.mesh(R, g), mat: M4.ident() }];
    // main rotor: two blades with yellow tips; the disc tilts with the cyclic
    const gb = new Geo();
    for (const s of [1, -1]) {
      gb.box(s > 0 ? 0.02 : -Ro.R * 0.85, -Ro.chord / 2, -0.003, s > 0 ? Ro.R * 0.85 : -0.02, Ro.chord / 2, 0.003, blade);
      gb.box(s > 0 ? Ro.R * 0.85 : -Ro.R, -Ro.chord / 2, -0.003, s > 0 ? Ro.R : -Ro.R * 0.85, Ro.chord / 2, 0.003, tip);
    }
    const gd = new Geo(); gd.disc(Ro.R, 32, [0.55, 0.57, 0.6]);
    const main = { blades: GLR.mesh(R, gb), disc: GLR.mesh(R, gd), mat: M4.trans(0, 0.185, 0), post: M4.rotX(-Math.PI / 2),
      tilt: (s0) => M4.mul(M4.rotZ(-1.5 * s0.tilt[0]), M4.rotX(1.5 * s0.tilt[1])), spin: (s0) => s0.om / Ro.om0, dir: -1, ang: 0, hideFpv: true };
    const tp = propMeshes(g, 2, 0.055, blade, [0.6, 0.6, 0.62]);
    const tail = { blades: tp.blades, disc: tp.disc, mat: M4.mul(M4.trans(-0.03, 0.03, 0.62), M4.rotY(Math.PI / 2)), spin: (s0) => s0.om / Ro.om0, dir: 1, ang: 0 };
    return { parts, props: [main, tail], cam: BR(ac.fpvCam) };
  }
  const MODELS = { goblin: buildGoblin(ACS.goblin), trainer: buildTrainer(ACS.trainer), quad: buildQuad(ACS.quad), heli: buildHeli(ACS.heli) };

  /* ---------------------------------------------------------------- sim state */
  const st = FL.makeState();
  const env = { rho: 1.225, wind: [0, 0, 0], battery: S.battery, crashes: S.crashes };
  const gust = [0, 0, 0];
  let armed = false, paused = false, userPaused = false, crashAt = 0, flightTime = 0, timerOn = false, launchHold = 0, acc = 0;
  let farWarned = false, crashAnnounced = false;
  // air and weather: density from the field conditions; weather at the aircraft and at each camera
  let atmo = null, wxBase = null;
  function updateAtmos() {
    atmo = FL.atmosphere(S.elevFt, S.tempF, S.rh, S.altim); env.rho = atmo.rho;
    wxBase = { tempC: atmo.Tc, rh: S.rh, precip: S.precip, fogVisM: S.fogVis, ceilM: S.ceilFt * 0.3048 };
    env.wx = FL.weatherAt(wxBase, Math.max(0, -st.p[2]));
    return atmo;
  }
  const packStartC = () => (S.packWarm ? Math.max(30, atmo.Tc) : atmo.Tc); // pre-warmed packs come out of a warm bag at ~30 °C
  updateAtmos();

  function doReset() {
    const where = startOf(AC.id);
    FL.reset(st, AC, where, packStartC());
    armed = where === 'air';
    if (where === 'air') kb.thr = AC.kind === 'quad' ? AC.hoverThr : AC.kind === 'heli' ? AC.hoverThrCurve[S.curve] : AC.kind === 'wing' ? 0.55 : 0.6;
    else kb.thr = 0;
    crashAt = 0; crashAnnounced = false; flightTime = 0; timerOn = where === 'air'; launchHold = 0; acc = 0; farWarned = false;
    for (let i = 0; i < 3; i++) gust[i] = 0;
    courseReset(); obsPrev = null;
    hideBanner();
  }

  /* ---------------------------------------------------------------- controllers (radios, HOTAS, gamepads) */
  // Every connected game controller is a "device", keyed by its id string (#2, #3 … for identical twins).
  // A HOTAS often appears as two devices (stick + throttle); a radio in USB joystick mode as one.
  // Flight axes (throttle, roll, pitch, yaw) each map to one axis on any device.
  // Every button gets a "channel" automatically; hats and switches that report as axes become channels
  // when recorded. Each channel has a user-given name and an optional action.
  const IKEY = 'flightline.inputs.v3';
  const ACTIONS = [
    ['', 'No action'],
    ['reset', 'Reset'],
    ['pause', 'Pause / resume'],
    ['view-cycle', 'View: cycle'], ['view-los', 'View: line of sight'], ['view-fpv', 'View: FPV'], ['view-split', 'View: split'],
    ['mode-cycle', 'Flight mode: cycle'], ['mode-manual', 'Flight mode: manual / acro'], ['mode-horizon', 'Flight mode: horizon'], ['mode-trainer', 'Flight mode: trainer'], ['mode-stab', 'Flight mode: stabilised / angle'],
    ['stab-toggle', 'Stabilised mode: toggle'], ['stab-hold', 'Stabilised mode: while held / switch on'],
    ['cut-toggle', 'Throttle cut / heli throttle hold: toggle'], ['cut-hold', 'Throttle cut / heli throttle hold: while held'],
    ['curve-toggle', 'Heli pitch curve: Normal / 3D'], ['curve-3d-hold', 'Heli pitch curve: 3D while held / switch on'],
    ['launch', 'Hand launch: throw now'],
    ['trim-e-up', 'Trim: nose up'], ['trim-e-down', 'Trim: nose down'],
    ['trim-a-left', 'Trim: roll left'], ['trim-a-right', 'Trim: roll right'],
    ['trim-r-left', 'Trim: yaw left'], ['trim-r-right', 'Trim: yaw right'],
    ['trim-reset', 'Trim: reset to zero'],
    ['tilt-up', 'FPV camera: tilt up'], ['tilt-down', 'FPV camera: tilt down'],
    ['zoom-cycle', 'LOS zoom: cycle'],
    ['osd-cycle', 'FPV OSD: full / minimal / off'],
    ['stallcue-toggle', 'Stall indicator: on / off'], ['eng-toggle', 'Engineering readout: on / off'],
    ['aircraft-cycle', 'Switch aircraft'], ['start-cycle', 'Start position: cycle'],
  ];
  const REPEATS = new Set(['trim-e-up', 'trim-e-down', 'trim-a-left', 'trim-a-right', 'trim-r-left', 'trim-r-right', 'tilt-up', 'tilt-down']);
  const AXES = [['thr', 'Throttle'], ['a', 'Roll'], ['e', 'Pitch'], ['r', 'Yaw']];
  let uidN = 0;
  const uid = () => 'c' + Date.now().toString(36) + (uidN++).toString(36);
  const shortName = (id) => (id || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Controller';
  const devName = (dev) => { const m = /#(\d+)$/.exec(dev); return shortName(m ? dev.slice(0, m.index) : dev) + (m ? ` #${m[1]}` : ''); };
  function migrateV1(m) { // v1 stored one radio: { id, thr, a, e, r, sw: { reset, view, mode } }
    const out = { axes: {}, channels: [] };
    if (!m || !m.id) return out;
    for (const [k] of AXES) if (m[k]) out.axes[k] = Object.assign({ dev: m.id }, m[k]);
    for (const [k, sw] of Object.entries(m.sw || {})) {
      if (!sw) continue;
      const action = k === 'mode' ? (sw.type === 'axis' ? 'stab-hold' : 'stab-toggle') : k === 'view' ? 'view-cycle' : 'reset';
      out.channels.push(sw.type === 'button'
        ? { id: uid(), dev: m.id, kind: 'button', i: sw.i, name: '', action }
        : { id: uid(), dev: m.id, kind: 'axisDir', i: sw.i, dir: sw.dir, th: sw.th, name: '', action });
    }
    return out;
  }
  // Profiles: one per controller (a HOTAS, a transmitter …). Each holds that controller's axis
  // mapping, named buttons and actions, and its own rates & expo. A device belongs to one profile;
  // plugging a device in makes its profile active.
  function newProfile(name, devs) { return { id: uid(), name, devs: devs || [], axes: {}, channels: [], rates: null, expo: null }; }
  let IN = load(IKEY);
  if (!IN || !Array.isArray(IN.profiles)) {
    IN = { profiles: [], last: null };
    const old = migrateV1(load(RKEY)); // keep a setup made with the first release
    const devs = [...new Set([...old.channels.map((c) => c.dev), ...Object.values(old.axes).map((r) => r.dev)])];
    if (devs.length) { const p = newProfile(shortName(devs[0]), devs); p.axes = old.axes; p.channels = old.channels; IN.profiles.push(p); IN.last = p.id; }
    store(IKEY, IN);
  }
  const saveIN = () => store(IKEY, IN);
  const EMPTY = { id: '', name: 'No controller', devs: [], axes: {}, channels: [], rates: null, expo: null };
  let activePid = IN.last;
  const prof = () => IN.profiles.find((p) => p.id === activePid) || EMPTY;
  const profileOf = (dev) => IN.profiles.find((p) => p.devs.includes(dev));
  function setActive(pid) {
    if (pid === activePid) return;
    activePid = pid; IN.last = pid; saveIN(); chPrev.clear();
    const p = prof();
    if (p !== EMPTY && !wiz.open) flash(`PROFILE ${p.name.toUpperCase()}`);
    refreshCtlStatus(); syncSheet();
    if (ctl.open) renderCtl();
  }

  const K = new Set();
  const kb = { thr: 0, a: 0, e: 0, r: 0 };
  const tch = { L: { x: 0, y: 1, id: null }, R: { x: 0, y: 0, id: null } };
  const inp = { thr: 0, a: 0, e: 0, r: 0 };
  let src = 'keys';
  const coarse = matchMedia('(pointer: coarse)').matches;
  let sticksShown = false;
  let pads = new Map(), padBlocked = false, padSig = null;
  const axesPrev = new Map();

  const devKey = (dev, i) => `${dev}|${i}`;
  const btnOn = (b) => !!(b && (b.pressed || b.value > 0.5));
  const isFlightAxis = (dev, i) => AXES.some(([k]) => prof().axes[k] && prof().axes[k].dev === dev && prof().axes[k].i === i);
  const hasAxes = () => AXES.some(([k]) => prof().axes[k] && pads.has(prof().axes[k].dev));
  const profPads = () => [...pads].filter(([dev]) => prof().devs.includes(dev));

  function scanPads() {
    let list = [];
    try { list = navigator.getGamepads ? Array.from(navigator.getGamepads()) : []; } catch (e) { padBlocked = true; }
    const m = new Map(), seen = {};
    for (const p of list) {
      if (!p || !p.connected) continue;
      seen[p.id] = (seen[p.id] || 0) + 1;
      m.set(seen[p.id] > 1 ? `${p.id}#${seen[p.id]}` : p.id, p);
    }
    const before = pads;
    pads = m;
    const sig = [...m.keys()].join('\n');
    if (sig === padSig) return;
    if (padSig !== null) {
      const added = [...m.keys()].filter((k) => !before.has(k)), gone = [...before.keys()].filter((k) => !m.has(k));
      if (added.length && !wiz.open) toast(`Connected: ${added.map(devName).join(', ')}${hasAxes() ? '' : '. Open Controls & buttons to map the sticks.'}`);
      if (gone.length) toast(`Disconnected: ${gone.map(devName).join(', ')}`);
      if (!m.size && src === 'radio') src = 'keys';
    }
    padSig = sig;
    // every connected device belongs to a profile; a newly plugged-in device makes its profile active
    const fresh = [...m.keys()].filter((k) => !before.has(k));
    for (const dev of m.keys()) if (!profileOf(dev)) { const p = newProfile(devName(dev), [dev]); IN.profiles.push(p); saveIN(); }
    const cur = IN.profiles.find((p) => p.id === activePid);
    const curLive = cur && cur.devs.some((d) => m.has(d));
    if (fresh.length) setActive(profileOf(fresh[fresh.length - 1]).id);
    else if (!curLive && m.size) setActive(profileOf([...m.keys()][0]).id);
    ensureChannels();
    refreshCtlStatus();
    if (ctl.open) renderCtl();
  }
  // one channel per physical button on every connected device
  function ensureChannels() {
    let added = false;
    for (const [dev, p] of pads) {
      const P = profileOf(dev);
      if (!P) continue;
      for (let i = 0; i < p.buttons.length; i++)
        if (!P.channels.some((c) => c.dev === dev && c.kind === 'button' && c.i === i)) { P.channels.push({ id: uid(), dev, kind: 'button', i, name: '', action: '' }); added = true; }
      if (added) P.channels.sort((a, b) => (a.dev === b.dev ? (a.kind === b.kind ? a.i - b.i || (a.v || 0) - (b.v || 0) : a.kind === 'button' ? -1 : 1) : 0));
    }
    if (added) saveIN();
  }
  function chActive(ch) {
    const p = pads.get(ch.dev);
    if (!p) return false;
    if (ch.kind === 'button') return btnOn(p.buttons[ch.i]);
    const v = p.axes[ch.i];
    if (v === undefined) return false;
    if (ch.kind === 'axisDir') return ch.dir > 0 ? v > ch.th : v < ch.th;
    return Math.abs(v - ch.v) < 0.12; // hat position or other discrete axis value
  }
  const POV = { '-7': '↑', '-5': '↗', '-3': '→', '-1': '↘', 1: '↓', 3: '↙', 5: '←', 7: '↖' };
  function chLabel(ch) {
    if (ch.kind === 'button') return `Button ${ch.i + 1}`;
    if (ch.kind === 'axisDir') return `Axis ${ch.i} ${ch.dir > 0 ? '+' : '−'}`;
    const r = Math.round(ch.v * 7), arrow = POV[r] || '';
    return `Axis ${ch.i} = ${ch.v.toFixed(2)}${arrow ? ' (hat ' + arrow + ')' : ''}`;
  }
  const chTitle = (ch) => ch.name || chLabel(ch);

  // flight axes, calibrated
  function sticksFrom(axes) {
    const val = (ref) => { const p = ref && pads.get(ref.dev); return p ? p.axes[ref.i] : undefined; };
    const stick = (ref) => { const v0 = val(ref); if (v0 === undefined) return 0; let v = ((v0 - ref.c) * ref.s) / ref.k; if (Math.abs(v) < 0.01) v = 0; return clamp(v, -1, 1); };
    const t = axes.thr, tv = val(t);
    return { thr: tv === undefined ? 0 : clamp((tv - t.lo) / (t.hi - t.lo), 0, 1), a: stick(axes.a), e: stick(axes.e), r: stick(axes.r) };
  }
  function readSticks() {
    if (hasAxes()) return sticksFrom(prof().axes);
    const first = profPads()[0] || [...pads][0];
    const p = first && first[1];
    if (!p || p.axes.length < 2) return null;
    const ax = p.axes;
    if (p.mapping === 'standard') return { thr: p.buttons[7] ? p.buttons[7].value : 0, a: ax[2] || 0, e: ax[3] || 0, r: ax[0] || 0 };
    // not mapped yet: guess AETR (typical transmitter channel order)
    return { thr: clamp(((ax[2] || 0) + 1) / 2, 0, 1), a: ax[0] || 0, e: -(ax[1] || 0), r: ax[3] || 0 };
  }

  /* ---------- actions ---------- */
  let cutOn = false, cutHeld = false;
  let osdFlash = { text: '', t: 0 };
  const flash = (text) => { osdFlash = { text, t: 1.6 }; };
  if (!S.trim || typeof S.trim !== 'object') S.trim = {};
  const userTrim = () => (S.trim[AC.id] = Object.assign({ a: 0, e: 0, r: 0 }, S.trim[AC.id]));
  function trimStep(ax, dir) {
    const t = userTrim();
    t[ax] = clamp(Math.round((t[ax] + dir * 0.01) * 1000) / 1000, -0.25, 0.25);
    saveS();
    flash(`TRIM ${{ a: 'AIL', e: 'ELE', r: 'RUD' }[ax]} ${t[ax] > 0 ? '+' : ''}${Math.round(t[ax] * 100)}`);
  }
  function fire(a) {
    switch (a) {
      case 'reset': doReset(); break;
      case 'pause': togglePause(); break;
      case 'view-cycle': cycleView(); break;
      case 'view-los': setView('los'); break;
      case 'view-fpv': setView('fpv'); break;
      case 'view-split': setView('split'); break;
      case 'stab-toggle': setMode(S.mode === 'stab' ? 'manual' : 'stab'); break;
      case 'mode-cycle': cycleMode(); break;
      case 'mode-manual': setMode('manual'); break;
      case 'mode-horizon': setMode('horizon'); break;
      case 'mode-trainer': setMode('trainer'); break;
      case 'mode-stab': setMode('stab'); break;
      case 'cut-toggle': cutOn = !cutOn; flash(`${AC.kind === 'heli' ? 'THROTTLE HOLD' : 'THROTTLE CUT'} ${cutOn ? 'ON' : 'OFF'}`); break;
      case 'curve-toggle': setCurve(S.curve === '3d' ? 'normal' : '3d'); break;
      case 'launch': if (st.held && armed) { FL.launch(st); timerOn = true; } break;
      case 'trim-e-up': trimStep('e', 1); break;
      case 'trim-e-down': trimStep('e', -1); break;
      case 'trim-a-left': trimStep('a', -1); break;
      case 'trim-a-right': trimStep('a', 1); break;
      case 'trim-r-left': trimStep('r', -1); break;
      case 'trim-r-right': trimStep('r', 1); break;
      case 'trim-reset': S.trim[AC.id] = { a: 0, e: 0, r: 0 }; saveS(); flash('TRIMS RESET'); break;
      case 'tilt-up': S.tilt[AC.id] = clamp(tiltOf() + 2, -20, 50); saveS(); flash(`CAM TILT ${S.tilt[AC.id]}°`); break;
      case 'tilt-down': S.tilt[AC.id] = clamp(tiltOf() - 2, -20, 50); saveS(); flash(`CAM TILT ${S.tilt[AC.id]}°`); break;
      case 'aircraft-cycle': cycleAircraft(); break;
      case 'zoom-cycle': S.losZoom = { off: 'mild', mild: 'strong', strong: 'off' }[S.losZoom] || 'mild'; saveS(); flash(`LOS ZOOM ${S.losZoom.toUpperCase()}`); break;
      case 'osd-cycle': S.osd = { full: 'min', min: 'off', off: 'full' }[S.osd] || 'full'; saveS(); break;
      case 'stallcue-toggle': S.stallCue = !S.stallCue; saveS(); flash(`STALL INDICATOR ${S.stallCue ? 'ON' : 'OFF'}`); break;
      case 'eng-toggle': S.eng = !S.eng; saveS(); break;
      case 'start-cycle': cycleStart(); break;
    }
    syncSheet();
  }
  const chPrev = new Map(), repeatT = new Map();
  function processChannels(dt) {
    let cut = false;
    for (const ch of prof().channels) {
      if (!ch.action || !pads.has(ch.dev)) continue;
      const on = chActive(ch), was = chPrev.get(ch.id);
      chPrev.set(ch.id, on);
      if (ch.action === 'cut-hold') { cut = cut || on; continue; }
      if (ch.action === 'stab-hold') { if (was === undefined ? on : on !== was) setMode(on ? 'stab' : 'manual'); continue; }
      if (ch.action === 'curve-3d-hold') { if (was === undefined ? on : on !== was) setCurve(on ? '3d' : 'normal'); continue; }
      if (was === undefined) continue; // no edge on first sight
      if (on && !was) { fire(ch.action); repeatT.set(ch.id, 0.45); }
      else if (on && REPEATS.has(ch.action)) {
        let t = (repeatT.get(ch.id) || 0) - dt;
        if (t <= 0) { fire(ch.action); t = 0.12; }
        repeatT.set(ch.id, t);
      }
    }
    cutHeld = cut;
  }

  function pollInput(dt) {
    scanPads();
    let moved = false;
    for (const [dev, p] of pads) {
      const prev = axesPrev.get(dev), own = profileOf(dev), mine = own && own.id === activePid;
      const mappedOnly = own && AXES.some(([k]) => own.axes[k] && own.axes[k].dev === dev);
      let mv = false;
      if (prev) for (let i = 0; i < p.axes.length; i++) if ((!mappedOnly || AXES.some(([k]) => own.axes[k] && own.axes[k].dev === dev && own.axes[k].i === i)) && Math.abs(p.axes[i] - prev[i]) > 0.03) mv = true;
      axesPrev.set(dev, Array.from(p.axes));
      if (mv && !mine && own && !wiz.open && !ctl.open) setActive(own.id); // grabbed the other controller
      moved = moved || mv;
    }
    if (moved && !wiz.open && !ctl.open) src = 'radio';
    if (!wiz.open && !ctl.open) processChannels(dt); else chPrev.clear();

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

    let v = src === 'radio' ? readSticks() : null;
    if (!v && src === 'touch') {
      const thrSide = m2 ? tch.L : tch.R, pitchSide = m2 ? tch.R : tch.L;
      v = { thr: clamp((1 - thrSide.y) / 2, 0, 1), a: tch.R.x, e: pitchSide.y, r: tch.L.x };
    }
    if (!v) v = kb;
    inp.thr = v.thr; inp.a = v.a; inp.e = v.e; inp.r = v.r;
  }

  addEventListener('keydown', (e) => {
    if (e.target && e.target.closest && e.target.closest('input, select, textarea')) return;
    const c = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(c)) e.preventDefault();
    if (!K.has(c)) {
      if (!$('#welcome').hidden) { if (c === 'Enter' || c === 'Space') { fly(); return; } }
      if (c === 'Escape') { if (ctl.open) closeCtl(); else if (sheetOpen()) closeSheet(); else if (wiz.open) closeWizard(); }
      if (!wiz.open && !sheetOpen() && !ctl.open) {
        if (c === 'KeyR') doReset();
        else if (c === 'KeyV') cycleView();
        else if (c === 'KeyM') cycleMode();
        else if (c === 'KeyP' || c === 'Space') togglePause();
        else if (c === 'KeyF') toggleFull();
        else if (c === 'KeyL' && st.held && armed) { FL.launch(st); timerOn = true; }
        else if (c === 'KeyH') fire('cut-toggle');
        else if (c === 'KeyI') fire('curve-toggle');
        else if (c === 'Digit1') setView('los'); else if (c === 'Digit2') setView('fpv'); else if (c === 'Digit3') setView('split');
      }
    }
    K.add(c);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(c)) src = 'keys';
    unlockAudio();
  });
  addEventListener('keyup', (e) => K.delete(e.code));
  addEventListener('blur', () => K.clear());

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

  /* ---------- detection helpers shared by the guided setup and the controls panel ---------- */
  function snapshot() {
    const s = new Map();
    for (const [dev, p] of pads) s.set(dev, { axes: Array.from(p.axes), btn: p.buttons.map(btnOn) });
    return s;
  }
  // true once every axis on every device has stayed within `tol` for `need` seconds
  function stillness(state, dt, need, tol = 0.03) {
    const now = snapshot();
    let still = !!state.last && now.size === state.last.size;
    if (still) for (const [dev, s] of now) { const l = state.last.get(dev); if (!l || s.axes.some((v, i) => Math.abs(v - l.axes[i]) > tol)) { still = false; break; } }
    state.t = still ? state.t + dt : 0;
    state.last = now;
    return { done: state.t >= need, progress: Math.min(1, state.t / need), snap: now };
  }
  // the axis (on any device) that has moved more than 0.5 from `base` and been held there for `need` s
  function detectAxis(d, dt, need) {
    let best = null, dmax = 0;
    for (const [dev, p] of pads) {
      const b = d.base.get(dev);
      if (!b) continue;
      for (let i = 0; i < p.axes.length; i++) {
        if (d.skip && d.skip(dev, i)) continue;
        const dv = Math.abs(p.axes[i] - b.axes[i]);
        if (dv > dmax) { dmax = dv; best = devKey(dev, i); }
      }
    }
    if (dmax > 0.5 && best === d.cand) d.hold += dt; else { d.hold = 0; d.cand = dmax > 0.5 ? best : null; d.ext = 0; }
    if (!d.cand) return { progress: 0 };
    const j = d.cand.lastIndexOf('|'), dev = d.cand.slice(0, j), i = +d.cand.slice(j + 1);
    const base = d.base.get(dev).axes[i], val = pads.get(dev).axes[i];
    d.ext = Math.max(d.ext, Math.abs(val - base));
    return d.hold >= need ? { done: true, dev, i, base, val, ext: d.ext } : { progress: d.hold / need };
  }
  function detectButton(base) {
    for (const [dev, p] of pads) {
      const b = base.get(dev);
      if (!b) continue;
      for (let i = 0; i < p.buttons.length; i++) if (btnOn(p.buttons[i]) && !b.btn[i]) return { dev, i };
    }
    return null;
  }
  function axisRef(key, hit) {
    if (key === 'thr') return { dev: hit.dev, i: hit.i, lo: hit.base, hi: hit.val };
    return { dev: hit.dev, i: hit.i, c: hit.base, s: Math.sign(hit.val - hit.base), k: Math.max(0.3, hit.ext) };
  }
  function findOrMakeChannel(m) {
    const P = profileOf(m.dev) || prof();
    let ch = P.channels.find((c) => c.dev === m.dev && c.kind === m.kind && c.i === m.i && (m.kind !== 'axisVal' || Math.abs(c.v - m.v) < 0.05) && (m.kind !== 'axisDir' || c.dir === m.dir));
    if (!ch) { ch = Object.assign({ id: uid(), name: '', action: '' }, m); P.channels.push(ch); saveIN(); }
    return ch;
  }

  /* ---------------------------------------------------------------- guided setup */
  const wiz = { open: false, step: 0, base: null, det: null, phase: 'detect', rel: null, still: {}, draft: null };
  const WSTEPS = [
    { id: 'connect', title: 'Connect your controller', text: 'Plug in by USB. A transmitter needs <b>Joystick (HID)</b> chosen on its USB prompt; a HOTAS or gamepad just works. If the stick and throttle are separate USB devices, plug in both. Then move a stick so Chrome sees it.' },
    { id: 'center', title: 'Centre the sticks', text: 'Let self-centring sticks rest in the middle and pull the <b>throttle all the way back</b> (idle). Keep everything still for a moment.' },
    { id: 'thr', title: 'Throttle', text: 'Push the <b>throttle all the way up / forward</b> and hold it there.', back: 'Now bring the throttle back to idle.' },
    { id: 'a', title: 'Roll', text: 'Push the stick <b>fully right</b> and hold.', back: 'Let it return to centre.' },
    { id: 'e', title: 'Pitch', text: 'Pull the stick <b>fully back</b> toward you (nose up) and hold.', back: 'Let it return to centre.' },
    { id: 'r', title: 'Yaw', text: 'Yaw <b>fully right</b> and hold: twist the stick, push the rudder rocker, or the radio’s rudder stick. On a wing with no rudder it steers nothing but costs nothing.', back: 'Let it return to centre.' },
    { id: 'reset', sw: true, action: 'reset', title: 'Reset button', text: 'Press the button (or flip the switch) you want for <b>reset</b>, or skip.', back: 'Let go.' },
    { id: 'view', sw: true, action: 'view-cycle', title: 'View button', text: 'Press a button for <b>changing view</b> (LOS → split → FPV), or skip.', back: 'Let go.' },
    { id: 'mode', sw: true, action: 'stab', title: 'Stabilised-mode switch', text: 'Press a button to <b>toggle stabilised mode</b>, or flip a switch whose flipped position should mean stabilised. Or skip.', back: 'Let go.' },
    { id: 'done', title: 'Check and save', text: 'Move the sticks. The bars should follow: throttle up = right, roll right = right, pitch back = right, yaw right = right. Every other button can be named and given a job in <b>Controls &amp; buttons</b>.' },
  ];
  function openWizard() {
    hide($('#welcome')); if (ctl.open) closeCtl(); if (sheetOpen()) closeSheet();
    wiz.open = true; wiz.step = 0; wiz.draft = { axes: {}, assign: [] };
    show($('#wizard')); renderWizStep(); syncPause();
  }
  function closeWizard() { wiz.open = false; hide($('#wizard')); syncPause(); }
  function renderWizStep() {
    const s = WSTEPS[wiz.step];
    $('#wzStep').textContent = `Controller setup · ${wiz.step + 1} of ${WSTEPS.length}`;
    $('#wzTitle').textContent = s.title;
    $('#wzText').innerHTML = s.text;
    $('#wzSkip').hidden = !s.sw;
    $('#wzNext').hidden = !(s.id === 'connect' || s.id === 'done');
    $('#wzNext').textContent = s.id === 'done' ? 'Save' : 'Start';
    wiz.phase = 'detect'; wiz.still = {}; wiz.rel = null;
    if (wiz.base) {
      const used = new Set(Object.values(wiz.draft.axes).map((r) => devKey(r.dev, r.i)));
      wiz.det = { base: wiz.base, skip: (dev, i) => used.has(devKey(dev, i)), cand: null, hold: 0, ext: 0 };
    }
    $('#wzBar').style.width = '0%';
  }
  function nextWiz() { wiz.step++; if (wiz.step >= WSTEPS.length) return saveWizard(); renderWizStep(); }
  function saveWizard() {
    const used = Object.values(wiz.draft.axes).map((r) => r.dev).concat(wiz.draft.assign.map((a) => a.match.dev));
    const owner = used.length ? profileOf(used[0]) : null;
    if (owner) { setActive(owner.id); for (const d of used) if (!owner.devs.includes(d)) { const o = profileOf(d); if (o) o.devs = o.devs.filter((x) => x !== d); owner.devs.push(d); } }
    prof().axes = Object.assign({}, wiz.draft.axes);
    for (const a of wiz.draft.assign) findOrMakeChannel(a.match).action = a.action;
    saveIN(); src = 'radio'; chPrev.clear();
    closeWizard(); toast('Controller saved'); refreshCtlStatus();
  }
  function monitorHtml(roleOf) {
    if (!pads.size) return `<div class="row"><span>—</span><span style="grid-column: span 2">${padBlocked ? 'This view blocks game controllers. Open the page in its own Chrome tab.' : 'No controller seen yet. Plug in and move a stick.'}</span></div>`;
    let html = '';
    for (const [dev, p] of pads) {
      html += `<div class="row dev"><span style="grid-column: 1 / -1">${devName(dev)}</span></div>`;
      for (let i = 0; i < p.axes.length; i++) {
        const x = (p.axes[i] + 1) / 2, role = roleOf(dev, i);
        html += `<div class="row ${role ? 'on' : ''}"><span>A${i} <b>${role}</b></span><div class="bar"><span style="left:${Math.min(50, x * 100)}%;width:${Math.abs(x - 0.5) * 100}%"></span></div><span>${p.axes[i].toFixed(2)}</span></div>`;
      }
      const pressed = p.buttons.map((b, i) => (btnOn(b) ? i + 1 : 0)).filter(Boolean);
      html += `<div class="row"><span>Btns</span><span style="grid-column: span 2">${pressed.length ? 'pressed: ' + pressed.join(', ') : 'none pressed'} (${p.buttons.length} total)</span></div>`;
    }
    return html;
  }
  function wizTick(dt) {
    const s = WSTEPS[wiz.step];
    const roleOf = (dev, i) => { for (const [k, lab] of AXES) { const r = wiz.draft.axes[k]; if (r && r.dev === dev && r.i === i) return lab.toUpperCase(); } return ''; };
    if (s.id === 'done') {
      const v = sticksFrom(wiz.draft.axes);
      $('#wzMon').innerHTML = AXES.map(([k, lab]) => {
        const x = k === 'thr' ? v.thr : (v[k] + 1) / 2;
        return `<div class="row on"><b>${lab.toUpperCase()}</b><div class="bar ${k === 'thr' ? 'thr' : ''}"><span style="left:${k === 'thr' ? 0 : Math.min(50, x * 100)}%;width:${k === 'thr' ? x * 100 : Math.abs(x - 0.5) * 100}%"></span></div><span>${Math.round((k === 'thr' ? v.thr : v[k]) * 100)}%</span></div>`;
      }).join('');
      return;
    }
    $('#wzMon').innerHTML = monitorHtml(roleOf);
    if (s.id === 'connect') { $('#wzNext').disabled = !pads.size; return; }
    if (!pads.size) return;
    if (s.id === 'center') {
      const r = stillness(wiz.still, dt, 1.2);
      $('#wzBar').style.width = `${r.progress * 100}%`;
      if (r.done) { wiz.base = r.snap; nextWiz(); }
      return;
    }
    if (wiz.phase === 'detect') {
      if (s.sw) {
        const b = detectButton(wiz.base);
        if (b) {
          wiz.draft.assign.push({ match: { dev: b.dev, kind: 'button', i: b.i }, action: s.action === 'stab' ? 'stab-toggle' : s.action });
          wiz.phase = 'release'; wiz.rel = { btn: b }; $('#wzText').innerHTML = s.back; return;
        }
      }
      const hit = detectAxis(wiz.det, dt, s.sw ? 0.25 : 0.45);
      $('#wzBar').style.width = `${(hit.progress || (hit.done ? 1 : 0)) * 100}%`;
      if (!hit.done) return;
      if (s.sw) {
        const d = hit.val - hit.base;
        wiz.draft.assign.push({ match: { dev: hit.dev, kind: 'axisDir', i: hit.i, dir: Math.sign(d), th: hit.base + d / 2 }, action: s.action === 'stab' ? 'stab-hold' : s.action });
      } else wiz.draft.axes[s.id] = axisRef(s.id, hit);
      wiz.phase = 'release'; wiz.rel = { dev: hit.dev, i: hit.i, base: hit.base };
      $('#wzText').innerHTML = s.back || 'Let go.';
    } else if (wiz.phase === 'release') {
      const r = wiz.rel;
      const p = pads.get(r.btn ? r.btn.dev : r.dev);
      const done = !p || (r.btn ? !btnOn(p.buttons[r.btn.i]) : Math.abs(p.axes[r.i] - r.base) < 0.2);
      if (done) nextWiz();
    }
  }
  $('#wzNext').addEventListener('click', () => { const s = WSTEPS[wiz.step]; if (s.id === 'done') saveWizard(); else if (s.id === 'connect') nextWiz(); });
  $('#wzSkip').addEventListener('click', () => nextWiz());
  $('#wzCancel').addEventListener('click', closeWizard);

  /* ---------------------------------------------------------------- controls & buttons panel */
  const ctl = { open: false, rec: false, learn: null, sel: null, rows: new Map(), axisRows: new Map(), prevBtn: new Map(), axState: new Map(), recent: [] };
  const LEARN_TEXT = { thr: ['Pull the throttle to idle and hold still…', 'Now push the throttle to full and hold.'], a: ['Let the stick centre…', 'Push the stick fully right and hold.'], e: ['Let the stick centre…', 'Pull the stick fully back and hold.'], r: ['Let the stick centre…', 'Yaw fully right and hold.'] };
  function openCtl() {
    hide($('#welcome')); if (sheetOpen()) closeSheet();
    ctl.open = true; ctl.rec = false; ctl.learn = null; ctl.sel = null; ctl.recent = [];
    show($('#ctl')); renderCtl(); syncPause();
  }
  function closeCtl() { ctl.open = false; ctl.rec = false; ctl.learn = null; hide($('#ctl')); syncPause(); refreshCtlStatus(); }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const actionOptions = (cur) => ACTIONS.map(([v, l]) => `<option value="${v}"${v === (cur || '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const knownDevices = () => prof().devs.slice();
  function moveDevice(dev, to) {
    const from = profileOf(dev);
    if (from === to) return;
    if (from) {
      from.devs = from.devs.filter((d) => d !== dev);
      to.channels.push(...from.channels.filter((c) => c.dev === dev));
      from.channels = from.channels.filter((c) => c.dev !== dev);
      for (const [k] of AXES) if (from.axes[k] && from.axes[k].dev === dev) { to.axes[k] = from.axes[k]; delete from.axes[k]; }
      if (!from.devs.length) IN.profiles = IN.profiles.filter((p) => p !== from);
    }
    to.devs.push(dev);
    saveIN();
  }
  function renderCtl() {
    const P = prof();
    // profile bar
    $('#ctlProfile').innerHTML = IN.profiles.length
      ? `<label for="profSel">Profile</label><select id="profSel">${IN.profiles.map((p) => `<option value="${p.id}"${p.id === activePid ? ' selected' : ''}>${esc(p.name)}${p.devs.some((d) => pads.has(d)) ? '' : ' (not connected)'}</option>`).join('')}</select>` +
        `<input type="text" id="profName" value="${esc(P.name)}" maxlength="32" aria-label="Profile name"><button class="btn small" id="profDel"${P === EMPTY ? ' disabled' : ''}>${ctl.delArm ? 'Confirm delete' : 'Delete profile'}</button>`
      : '';
    if (IN.profiles.length) {
      $('#profSel').addEventListener('change', (e) => { ctl.sel = null; setActive(e.target.value); renderCtl(); });
      $('#profName').addEventListener('input', (e) => { P.name = e.target.value.trim() || devName(P.devs[0] || 'Controller'); saveIN(); refreshCtlStatus(); });
      $('#profDel').addEventListener('click', () => {
        if (!ctl.delArm) { ctl.delArm = true; renderCtl(); setTimeout(() => { if (ctl.delArm) { ctl.delArm = false; if (ctl.open) renderCtl(); } }, 3000); return; }
        ctl.delArm = false;
        IN.profiles = IN.profiles.filter((p) => p !== P);
        const live = IN.profiles.find((p) => p.devs.some((d) => pads.has(d)));
        activePid = live ? live.id : IN.profiles[0] ? IN.profiles[0].id : null; IN.last = activePid;
        saveIN(); ensureChannels(); renderCtl(); toast(`Deleted profile ${P.name}`);
      });
    }
    // devices in this profile, plus other connected devices that could join it
    const devs = knownDevices();
    const others = [...pads.keys()].filter((d) => !devs.includes(d));
    let dh = devs.map((d, n) => { const p = pads.get(d); return `<div class="devchip ${p ? 'on' : ''}"><i></i><span><b>${esc(devName(d))}</b><small>${p ? `${p.axes.length} axes · ${p.buttons.length} buttons` : 'not connected'}</small></span><button class="btn small" data-forget="${n}">Forget</button></div>`; }).join('');
    dh += others.map((d, n) => `<div class="devchip other"><i></i><span><b>${esc(devName(d))}</b><small>connected · in profile ${esc((profileOf(d) || EMPTY).name)}</small></span><button class="btn small" data-adopt="${n}"${P === EMPTY ? ' disabled' : ''}>Add to this profile</button></div>`).join('');
    $('#ctlDevices').innerHTML = dh || `<p class="note">${padBlocked ? 'This view blocks game controllers. Open the page in its own Chrome tab.' : 'No controller detected yet. Plug in by USB and move a stick or press a button.'}</p>`;
    $('#ctlDevices').querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', () => {
      const d = devs[+b.dataset.forget];
      P.devs = P.devs.filter((x) => x !== d);
      P.channels = P.channels.filter((c) => c.dev !== d);
      for (const [k] of AXES) if (P.axes[k] && P.axes[k].dev === d) delete P.axes[k];
      if (!P.devs.length) { IN.profiles = IN.profiles.filter((p) => p !== P); activePid = null; }
      saveIN(); padSig = null; scanPads(); renderCtl(); toast(`Forgot ${devName(d)}`);
    }));
    $('#ctlDevices').querySelectorAll('[data-adopt]').forEach((b) => b.addEventListener('click', () => { moveDevice(others[+b.dataset.adopt], P); ensureChannels(); renderCtl(); }));
    // flight axes
    ctl.axisRows.clear();
    $('#ctlAxes').innerHTML = AXES.map(([k, lab]) => {
      const r = prof().axes[k];
      const srcTxt = r ? `${esc(devName(r.dev))} · axis ${r.i}${(k === 'thr' ? r.hi < r.lo : r.s < 0) ? ' · reversed' : ''}` : 'Not set';
      const learning = ctl.learn && ctl.learn.key === k;
      return `<div class="axrow" data-k="${k}"><b>${lab}</b><span class="src">${learning ? `<em>${LEARN_TEXT[k][ctl.learn.phase === 'still' ? 0 : 1]}</em>` : srcTxt}</span><div class="bar ${k === 'thr' ? 'thr' : ''}"><span></span></div><span class="ax-btns"><button class="btn small" data-learn="${k}">${learning ? 'Cancel' : 'Learn'}</button><button class="btn small" data-clear="${k}"${r ? '' : ' disabled'}>Clear</button></span></div>`;
    }).join('');
    $('#ctlAxes').querySelectorAll('.axrow').forEach((row) => ctl.axisRows.set(row.dataset.k, row.querySelector('.bar span')));
    $('#ctlAxes').querySelectorAll('[data-learn]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.learn;
      ctl.learn = ctl.learn && ctl.learn.key === k ? null : { key: k, phase: 'still', still: {} };
      ctl.rec = false; renderCtl();
    }));
    $('#ctlAxes').querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { delete prof().axes[b.dataset.clear]; saveIN(); renderCtl(); }));
    // record toggle
    const rb = $('#ctlRec');
    rb.setAttribute('aria-pressed', String(ctl.rec));
    rb.textContent = ctl.rec ? '■ Stop recording' : '● Record buttons';
    $('#ctlRecHint').textContent = ctl.rec
      ? 'Recording: press buttons and hats one at a time. Each press jumps to its channel so you can name it. Names save as you type.'
      : 'Every button already has a channel. Press Record, then press each button to find and name it. Hats and switches that Chrome reports as axes are added when you record them.';
    // channel list
    ctl.rows.clear();
    let html = '';
    for (const d of devs) {
      const chs = prof().channels.filter((c) => c.dev === d);
      if (!chs.length) continue;
      html += `<div class="chdev">${esc(devName(d))}${pads.has(d) ? '' : ' · not connected'}</div>`;
      for (const ch of chs)
        html += `<div class="ch${ctl.sel === ch.id ? ' hl' : ''}" data-id="${ch.id}"><i class="led"></i><span class="lab">${esc(chLabel(ch))}</span>` +
          `<input type="text" id="nm-${ch.id}" value="${esc(ch.name || '')}" placeholder="Name it" aria-label="Name for ${esc(chLabel(ch))}" maxlength="40">` +
          `<select id="ac-${ch.id}" aria-label="Action for ${esc(chLabel(ch))}">${actionOptions(ch.action)}</select>` +
          `${ch.kind === 'button' ? '<span></span>' : `<button class="btn small del" data-del="${ch.id}" aria-label="Remove">×</button>`}</div>`;
    }
    $('#ctlList').innerHTML = html || '<p class="note">Buttons appear here once a controller is connected.</p>';
    $('#ctlList').querySelectorAll('.ch').forEach((row) => {
      const ch = prof().channels.find((c) => c.id === row.dataset.id);
      ctl.rows.set(ch.id, { row, led: row.querySelector('.led') });
      row.querySelector('input').addEventListener('input', (e) => { ch.name = e.target.value.trim(); saveIN(); syncLast(ch); });
      row.querySelector('select').addEventListener('change', (e) => { ch.action = e.target.value; saveIN(); syncLast(ch); });
      const del = row.querySelector('[data-del]');
      if (del) del.addEventListener('click', () => { { const P = prof(); P.channels = P.channels.filter((c) => c !== ch); } saveIN(); renderCtl(); });
    });
    renderLast();
  }
  function renderLast() {
    const box = $('#ctlLast');
    const ch = ctl.sel && prof().channels.find((c) => c.id === ctl.sel);
    if (!ch) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<span class="eyebrow">Just pressed</span><div class="last-row"><i class="led on"></i><b>${esc(devName(ch.dev))} · ${esc(chLabel(ch))}</b>` +
      `<input type="text" id="lastName" value="${esc(ch.name || '')}" placeholder="Name it, e.g. Trigger" maxlength="40">` +
      `<select id="lastAct" aria-label="Action">${actionOptions(ch.action)}</select></div>` +
      (ctl.recent.length > 1 ? `<div class="note">Recorded so far: ${ctl.recent.map(esc).join(' · ')}</div>` : '');
    const nm = $('#lastName'), ac = $('#lastAct');
    nm.addEventListener('input', () => { ch.name = nm.value.trim(); saveIN(); const r = $(`#nm-${ch.id}`); if (r) r.value = nm.value; });
    nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') nm.blur(); });
    ac.addEventListener('change', () => { ch.action = ac.value; saveIN(); const r = $(`#ac-${ch.id}`); if (r) r.value = ac.value; });
    if (ctl.rec) nm.focus({ preventScroll: true });
  }
  function syncLast(ch) {
    if (ctl.sel !== ch.id) return;
    const nm = $('#lastName'), ac = $('#lastAct');
    if (nm && document.activeElement !== nm) nm.value = ch.name || '';
    if (ac) ac.value = ch.action || '';
  }
  function recordHit(m) {
    const before = prof().channels.length;
    const ch = findOrMakeChannel(m);
    ctl.sel = ch.id;
    const lab = `${devName(ch.dev)} ${chLabel(ch)}`;
    ctl.recent = [chTitle(ch) === chLabel(ch) ? chLabel(ch) : `${chLabel(ch)} (${ch.name})`, ...ctl.recent.filter((x) => !x.startsWith(chLabel(ch)))].slice(0, 8);
    if (prof().channels.length !== before) renderCtl();
    else {
      ctl.rows.forEach((r, id) => r.row.classList.toggle('hl', id === ch.id));
      renderLast();
    }
    const r = ctl.rows.get(ch.id);
    if (r) r.row.scrollIntoView({ block: 'nearest' });
    return lab;
  }
  const discrete = (v) => { const r = Math.round(v * 7); return Math.abs(v * 7 - r) < 0.25 && Math.abs(r) % 2 === 1; };
  function ctlTick(dt) {
    // live values
    for (const [k, el] of ctl.axisRows) {
      const r = prof().axes[k];
      if (!r || !pads.has(r.dev)) { el.style.width = '0'; continue; }
      const v = sticksFrom({ [k]: r, thr: k === 'thr' ? r : null })[k === 'thr' ? 'thr' : k];
      if (k === 'thr') { el.style.left = '0'; el.style.width = `${v * 100}%`; }
      else { const x = (v + 1) / 2; el.style.left = `${Math.min(50, x * 100)}%`; el.style.width = `${Math.abs(x - 0.5) * 100}%`; }
    }
    for (const ch of prof().channels) { const r = ctl.rows.get(ch.id); if (r) r.led.classList.toggle('on', chActive(ch)); }
    // learning one flight axis
    if (ctl.learn) {
      const L = ctl.learn;
      if (L.phase === 'still') {
        const r = stillness(L.still, dt, 0.8);
        if (r.done) { L.phase = 'move'; L.det = { base: r.snap, cand: null, hold: 0, ext: 0, skip: (dev, i) => AXES.some(([k]) => k !== L.key && prof().axes[k] && prof().axes[k].dev === dev && prof().axes[k].i === i) }; renderCtl(); }
      } else {
        const hit = detectAxis(L.det, dt, 0.45);
        if (hit.done) { prof().axes[L.key] = axisRef(L.key, hit); saveIN(); ctl.learn = null; renderCtl(); toast(`${AXES.find(([k]) => k === L.key)[1]} set to ${devName(hit.dev)} axis ${hit.i}`); }
      }
    }
    // recording buttons and hats
    if (!ctl.rec) { ctl.prevBtn.clear(); ctl.axState.clear(); return; }
    for (const [dev, p] of pads) {
      const prev = ctl.prevBtn.get(dev);
      const now = p.buttons.map(btnOn);
      if (prev) now.forEach((on, i) => { if (on && !prev[i]) recordHit({ dev, kind: 'button', i }); });
      ctl.prevBtn.set(dev, now);
      p.axes.forEach((v, i) => {
        if (isFlightAxis(dev, i)) return;
        const key = devKey(dev, i);
        let a = ctl.axState.get(key);
        if (!a) { ctl.axState.set(key, { rest: v, last: v, fired: false, jumped: false }); return; }
        const off = Math.abs(v - a.rest);
        if (off < 0.1) { a.fired = false; a.jumped = false; }
        else {
          if (Math.abs(a.last - a.rest) < 0.1 && off > 0.4) a.jumped = true; // left rest in one step, like a hat
          // a hat jumps straight to a discrete value and stays; an analog axis sweeps through values
          if (!a.fired && a.jumped && discrete(v) && Math.abs(v - a.last) < 0.02) { a.fired = true; recordHit({ dev, kind: 'axisVal', i, v: Math.round(v * 7) / 7 }); }
        }
        a.last = v;
      });
    }
  }
  $('#ctlRec').addEventListener('click', () => { ctl.rec = !ctl.rec; ctl.learn = null; if (ctl.rec) { ctl.recent = []; ctl.prevBtn.clear(); ctl.axState.clear(); } renderCtl(); });
  $('#ctlClose').addEventListener('click', closeCtl);
  $('#ctlWizard').addEventListener('click', () => { closeCtl(); openWizard(); });

  function refreshCtlStatus() {
    const n = $('#rbName'), w = $('#wRadio'), dot = $('#wRadioDot');
    const named = prof().channels.filter((c) => c.name).length, acting = prof().channels.filter((c) => c.action).length;
    const txt = padBlocked ? 'This view blocks game controllers. Open the page in its own Chrome tab.'
      : !pads.size ? 'No controller detected. Plug in by USB (a radio needs Joystick (HID) mode), then move a stick.'
      : `${[...pads.keys()].map(devName).join(' + ')} · ${hasAxes() ? 'sticks mapped' : 'sticks not mapped yet'} · ${named} named, ${acting} with actions`;
    if (n) n.textContent = txt;
    if (w) w.textContent = pads.size ? txt : 'Plug in by USB, then move a stick. A transmitter needs Joystick (HID) mode; a HOTAS or gamepad just works.';
    if (dot) dot.classList.toggle('ok', pads.size > 0 && hasAxes());
  }

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
    $('#vMode').textContent = modeName(S.mode);
    $('#bMode').classList.toggle('hot', S.mode !== 'manual');
    $('#vStart').textContent = START_LABEL[startOf(AC.id)];
    $('#vPause').textContent = paused ? 'Paused' : 'Running';
    $('#bPause').classList.toggle('hot', userPaused);
    const chip = $('#chip');
    chip.className = src === 'radio' ? 'radio' : src === 'touch' ? 'touch' : 'keys';
    $('#chipTxt').innerHTML = src === 'radio' ? `${esc(prof().name.slice(0, 22))}${hasAxes() ? '' : ' <b>· not mapped</b>'}` : src === 'touch' ? 'Touch' : 'Keys';
  }
  function setView(v) { S.view = v; saveS(); refreshBar(); syncSheet(); }
  function cycleView() { setView({ los: 'split', split: 'fpv', fpv: 'los' }[S.view]); }
  function setMode(m) { if (!MODES.includes(m)) m = 'manual'; if (m !== S.mode) flash(modeName(m).toUpperCase()); S.mode = m; saveS(); refreshBar(); syncSheet(); }
  function cycleMode() { setMode(MODES[(MODES.indexOf(S.mode) + 1) % MODES.length]); }
  function setCurve(c) { c = c === '3d' ? '3d' : 'normal'; if (c !== S.curve && AC.kind === 'heli') flash(c === '3d' ? '3D CURVE' : 'NORMAL CURVE'); S.curve = c; saveS(); syncSheet(); }
  function setAircraft(id) { S.aircraft = id; AC = ACS[id]; saveS(); doReset(); refreshBar(); buildSheet(); }
  function cycleAircraft() { const ids = Object.keys(ACS); setAircraft(ids[(ids.indexOf(S.aircraft) + 1) % ids.length]); }
  function syncPause() { paused = userPaused || sheetOpen() || wiz.open || ctl.open; }
  function togglePause() { userPaused = !userPaused; syncPause(); if (userPaused) showBanner('Paused', 'Press P or tap here to resume.'); else hideBanner(); refreshBar(); }
  function toggleFull() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('Full screen is not available in this view'));
    } catch (e) { toast('Full screen is not available in this view'); }
  }
  $('#bAc').addEventListener('click', cycleAircraft);
  $('#bView').addEventListener('click', cycleView);
  $('#bMode').addEventListener('click', cycleMode);
  function cycleStart() { const opts = AC.starts, cur = startOf(AC.id); S.start[AC.id] = opts[(opts.indexOf(cur) + 1) % opts.length]; saveS(); doReset(); refreshBar(); }
  $('#bStart').addEventListener('click', cycleStart);
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
  function openSheet(tab) { if (ctl.open) closeCtl(); if (tab) S.sheetTab = tab; buildSheet(); $('#sheet').classList.add('open'); syncPause(); }
  function closeSheet() { $('#sheet').classList.remove('open'); syncPause(); }
  $('#shClose').addEventListener('click', closeSheet);

  const seg = (key, label, opts, help, get, set) => ({ type: 'seg', key, label, opts, help, get, set });
  const rng = (key, label, min, max, stepv, fmt, help, get, set) => ({ type: 'range', key, label, min, max, step: stepv, fmt, help, get, set });
  function schema() {
    const imp = S.units === 'imp';
    return [
      { tab: 'aircraft', title: 'Aircraft', items: [
        seg('aircraft', 'Model', Object.values(ACS).map((a) => [a.id, a.name]), AC.blurb, () => S.aircraft, (v) => setAircraft(v)),
        seg('start', 'Reset puts you', AC.starts.map((s) => [s, START_LABEL[s]]), AC.kind === 'wing' ? 'Hand launch: arm with throttle down, then push throttle above 70% and the model is thrown once the motor is wound up (or press L to throw at any throttle). Real technique applies: full power, and maybe a touch of up elevator.' : '', () => startOf(AC.id), (v) => { S.start[AC.id] = v; doReset(); refreshBar(); }),
        ...(AC.kind === 'heli' ? [seg('curve', 'Pitch curve', [['normal', 'Normal'], ['3d', '3D (idle up)']],
          `Normal: ${AC.rotor.curves.normal.join('° / ')}° at the bottom, middle and top of the stick; hover is at about ${Math.round(AC.hoverThrCurve.normal * 100)}%. 3D: ${AC.rotor.curves['3d'].join('° / ')}°, with zero pitch at mid stick so you can fly inverted; hover is at about ${Math.round(AC.hoverThrCurve['3d'] * 100)}%. The governor holds ${Math.round((AC.rotor.om0 * 60) / (2 * Math.PI))} rpm in both. Throttle hold (H, or a controller channel) stops the motor and leaves the collective live, for autorotations.`,
          () => S.curve, (v) => setCurve(v))] : []),
        seg('mode', 'Flight mode', MODES.map((m) => [m, modeName(m)]), ROTARY(AC)
          ? 'Acro: sticks command rotation rates. Horizon: levels near centre stick and becomes acro at full stick, so hard stick means a flip. Acro trainer: acro, but stopped at the trainer limits. Angle: sticks command bank and pitch.'
          : 'Manual: sticks move the surfaces. Horizon: levels near centre stick and becomes manual at full stick, so hard stick means a roll. Trainer: manual, but held at the trainer limits. Stabilised: sticks command bank and pitch. None of them stop a stall.', () => S.mode, (v) => setMode(v)),
        rng('limBank', `${ROTARY(AC) ? 'Angle' : 'Stabilised'} bank limit`, 20, 85, 5, (v) => `${v}°`, null, () => limNow().bank, (v) => { limNow().bank = v; }),
        rng('limPitch', `${ROTARY(AC) ? 'Angle' : 'Stabilised'} pitch limit`, 15, 85, 5, (v) => `${v}°`, 'Also the dive limit.', () => limNow().pitch, (v) => { limNow().pitch = v; }),
        rng('limTBank', 'Trainer bank limit', 20, 85, 5, (v) => `${v}°`, null, () => limNow().tBank, (v) => { limNow().tBank = v; }),
        rng('limTPitch', 'Trainer pitch limit', 15, 85, 5, (v) => `${v}°`, null, () => limNow().tPitch, (v) => { limNow().tPitch = v; }),
      ] },
      { tab: 'aircraft', title: ROTARY(AC) ? `Rates · ${AC.name}` : 'Rates & expo', items: [{ type: 'rates' }] },
      { tab: 'aircraft', title: 'Sim rules', items: [
        seg('battery', 'Battery', [[true, 'Drains'], [false, 'Unlimited']], () => AC.batt.label),
        seg('crashes', 'Crashes', [[true, 'On'], [false, 'Off']]),
        seg('autoReset', 'After a crash', [[true, 'Auto reset (3 s)'], [false, 'Wait for me']]),
      ] },
      { tab: 'controller', title: 'Controller', items: [{ type: 'radio' },
        seg('stickMode', 'Stick mode (keyboard & touch)', [['2', 'Mode 2'], ['1', 'Mode 1']], 'With a radio the setup wizard maps channels, so this only affects keys and touch.'),
        seg('touch', 'Touch sticks', [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']]),
      ] },
      { tab: 'display', title: 'View', items: [
        seg('view', 'View', [['los', 'LOS'], ['split', 'Split'], ['fpv', 'FPV']], 'Split puts LOS on top and FPV below when the screen is upright, side by side when it is wide.', () => S.view, (v) => setView(v)),
        seg('splitSwap', 'Split order', [[false, 'LOS first'], [true, 'FPV first']]),
        seg('losZoom', 'LOS zoom', [['off', 'Off'], ['mild', 'Mild'], ['strong', 'Strong']], 'Narrows your field of view as the model gets farther away, so it stays visible on a small screen.'),
        rng('fpvFov', 'FPV camera field of view', 80, 150, 5, (v) => `${v}°`),
        rng('tilt', 'FPV camera tilt (this aircraft)', -20, 50, 1, (v) => `${v > 0 ? '+' : ''}${v}°`, 'Positive tilts the camera up. Quads usually fly 25–40° up.', () => tiltOf(), (v) => { S.tilt[AC.id] = v; }),
      ] },
      { tab: 'display', title: 'OSD & readouts', items: [
        seg('osd', 'FPV OSD', [['full', 'Full'], ['min', 'Minimal'], ['off', 'Off']]),
        seg('hud', 'FPV OSD style', [['hud', 'HUD'], ['classic', 'Classic']], 'HUD: pitch ladder that rolls with the horizon, airspeed tape on the left, altitude tape and vario on the right, heading tape on top, bank scale and a flight-path marker showing where the aircraft is actually going. Classic: horizon line and numbers.'),
        seg('losInfo', 'LOS readout', [[true, 'On'], [false, 'Off']]),
        seg('course', 'Gate course', [[true, 'Timer on'], [false, 'Off']], 'Eight gates on an oval north of the runway. Fly them in order; an orange marker floats over the next one. Laps run from gate 1 back to gate 1.', null, (v) => { S.course = v; saveS(); courseReset(); }),
        seg('stallCue', 'Stall indicator', [[false, 'Off'], [true, 'On']], 'Flashes STALL when a wing panel is stalled. Off is realistic; turn it on while you learn what a stall looks like.'),
        seg('iceCue', 'Ice indicator', [[true, 'On'], [false, 'Off']], 'Shows lift and thrust lost to ice. Real aircraft don’t tell you: turn it off and watch for the signs (more throttle for the same speed, a mushy climb, a stall at a higher speed, white leading edges).'),
        seg('eng', 'Engineering readout', [[false, 'Off'], [true, 'On']], 'Angle of attack, sideslip, load factor and stalled area per wing, plus air and pack temperature and ice.'),
        seg('units', 'Units', [['imp', 'ft · mph · °F'], ['met', 'm · km/h · °C']]),
      ] },
      { tab: 'weather', title: 'Weather', items: [
        { type: 'wxpresets' },
        rng('windSpd', 'Wind speed', 0, 20, 0.5, (v) => U.wind(v)),
        rng('windDir', 'Wind from', 0, 355, 5, (v) => `${v}° (${compass(v)})`, 'You stand facing north. The runway runs east–west, so 90° is a headwind for a runway takeoff.'),
        rng('gust', 'Gusts', 0, 100, 5, (v) => `${v}%`, 'Slow swings in wind speed and direction, as a share of the wind speed.'),
        rng('turb', 'Turbulence', 0, 100, 5, (v) => `${v}% · ${v < 10 ? 'smooth' : v < 35 ? 'light' : v < 70 ? 'moderate' : 'severe'}`, 'Dryden model: quick bumps and wing-rocking, stronger near the ground. Behind trees and the barn the wind also turns gusty and sinks, whatever this is set to.'),
        rng('tempF', 'Temperature', -20, 115, 1, (v) => UW.temp(v)),
        rng('rh', 'Humidity', 0, 100, 1, (v) => `${v}%`),
        rng('elevFt', 'Field elevation', 0, 12000, 250, (v) => (S.units === 'imp' ? `${v.toLocaleString()} ft` : `${Math.round(v * 0.3048).toLocaleString()} m`)),
        rng('altim', 'Altimeter setting', 28.5, 31, 0.01, (v) => UW.press(v)),
        seg('precip', 'Precipitation', Object.entries(FL.PRECIP).map(([k, p]) => [k, p.name]), 'Below freezing, drizzle and rain freeze on contact. Wet snow (around 32°F) sticks too.'),
        rng('fogVis', 'Fog / mist visibility', 100, 10000, 100, (v) => UW.vis(v), 'Fog only holds water when humidity is 95% or more. Precipitation cuts visibility further on its own.'),
        rng('ceilFt', 'Cloud ceiling', 0, 3000, 50, (v) => UW.ceil(v), 'Height of the overcast base above the field. Climb into it and you lose sight of the model from the ground; in FPV it goes white. Cloud below freezing ices you up.'),
        { type: 'da' },
        seg('packWarm', 'Battery temperature', [[false, 'Same as the air'], [true, 'Pre-warmed (86°F)']], 'A cold pack has higher internal resistance and less usable capacity, so it sags hard on a punch. It warms as you fly.', null, (v) => { S.packWarm = v; saveS(); doReset(); }),
      ] },
      { tab: 'graphics', title: 'Graphics', items: [
        seg('quality', 'Render resolution', [[0.6, 'Fast'], [0.8, 'Balanced'], [1, 'Sharp'], ['dev', 'Device']], 'Lower it if the frame rate drops.'),
        seg('scenery', 'Scenery', [['low', 'Light'], ['med', 'Normal'], ['high', 'Dense']]),
        seg('aa', 'Smooth edges', [[false, 'Off'], [true, 'On']], 'Takes effect after a reload.'),
        seg('fps', 'Frame rate', [[false, 'Hide'], [true, 'Show']]),
      ] },
      { tab: 'graphics', title: 'Sound', items: [
        seg('sound', 'Motor sound', [[true, 'On'], [false, 'Off']]),
      ] },
      { tab: 'model', title: `Flight model · ${AC.name}`, items: [{ type: 'notes' }] },
    ];
  }
  function applySetting(k) {
    if (k === 'scenery') buildWorld(S.scenery);
    if (k === 'quality') resize();
    if (WX_KEYS.includes(k) || k === 'windDir') {
      updateAtmos(); const n = $('#daBox'); if (n) n.innerHTML = daHtml();
      if (WX_KEYS.includes(k) && S.wxPreset !== 'custom') { S.wxPreset = 'custom'; saveS(); document.querySelectorAll('#wxPre button').forEach((b) => b.setAttribute('aria-pressed', 'false')); }
    }
    if (k === 'battery') env.battery = S.battery;
    if (k === 'crashes') env.crashes = S.crashes;
    if (k === 'touch' || k === 'stickMode') refreshTouch();
    if (k === 'aa') toast('Smooth edges applies after you reload the page');
    if (k === 'units') buildSheet();
  }
  function daHtml() {
    const a = updateAtmos(), w0 = FL.weatherAt(wxBase, 10), wc = S.ceilFt > 0 ? FL.weatherAt(wxBase, S.ceilFt * 0.3048 + 5) : null;
    const ice = (w) => w && w.lwc > 0 && w.T <= 0;
    const risk = ice(w0) ? `Yes, near the ground (${(w0.lwc * 1000).toFixed(2)} g/m³ supercooled water)` : ice(wc) ? 'In the cloud' : a.Tc <= 2 && (S.precip !== 'none' || S.ceilFt > 0 || S.rh >= 95) ? 'Marginal: near freezing' : 'No';
    const ft = (x) => (S.units === 'imp' ? `${Math.round(x).toLocaleString()} ft` : `${Math.round(x * 0.3048).toLocaleString()} m`);
    return `<div class="kv">
      <span>Air density</span><span>${a.rho.toFixed(3)} kg/m³ (${((a.rho / 1.225) * 100).toFixed(0)}% of sea level)</span>
      <span>Density altitude</span><span>${ft(a.daFt)}</span>
      <span>Pressure altitude</span><span>${ft(a.paFt)}</span>
      <span>Dew point</span><span>${UW.tempC(a.dewC)} (spread ${Math.round(((a.Tc - a.dewC) * 9) / 5)}°F)</span>
      <span>Visibility</span><span>${UW.vis(Math.round(w0.visM)).replace('Unlimited', '10+ km')}</span>
      <span>Icing</span><span>${risk}</span>
      <span>Pack at reset</span><span>${UW.tempC(packStartC())}, ${Math.round(FL.battR(AC.batt, packStartC()) * 1000)} mΩ, ${Math.round(FL.capF(packStartC()) * 100)}% capacity</span></div>`;
  }
  function applyPreset(id) {
    const p = WX_PRESETS.find((x) => x[0] === id);
    if (!p) return;
    Object.assign(S, p[3]); S.wxPreset = id; saveS(); updateAtmos(); doReset(); buildSheet();
    toast(`${p[1]}: ${p[2]}`);
  }
  const TABS = [['aircraft', 'Aircraft'], ['controller', 'Controller'], ['weather', 'Weather'], ['display', 'Display'], ['graphics', 'Graphics & sound'], ['model', 'Flight model']];
  function setTab(t) { if (S.sheetTab !== t) { S.sheetTab = t; saveS(); $('#sheet').scrollTop = 0; } buildSheet(); }
  function buildSheet() {
    const body = $('#shBody');
    const scroll = $('#sheet').scrollTop;
    body.innerHTML = '';
    if (!TABS.some(([t]) => t === S.sheetTab)) S.sheetTab = 'aircraft';
    const tabs = $('#shTabs');
    tabs.innerHTML = TABS.map(([t, l]) => `<button type="button" role="tab" id="tab-${t}" aria-selected="${t === S.sheetTab}">${l}</button>`).join('');
    tabs.querySelectorAll('button').forEach((b0, i) => b0.addEventListener('click', () => setTab(TABS[i][0])));
    for (const sec of schema()) {
      if (sec.tab !== S.sheetTab) continue;
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
          const val0 = it.get ? it.get() : S[it.key];
          box.innerHTML = `<label for="${id}"><span>${it.label}</span><output id="${id}-o">${it.fmt(val0)}</output></label><input type="range" id="${id}" min="${it.min}" max="${it.max}" step="${it.step}" value="${val0}">${it.help ? `<div class="help">${it.help}</div>` : ''}`;
          const inpEl = box.querySelector('input'), out = box.querySelector('output');
          inpEl.addEventListener('input', () => { const v = Number(inpEl.value); if (it.set) it.set(v); else S[it.key] = v; out.textContent = it.fmt(v); saveS(); applySetting(it.key); });
        } else if (it.type === 'wxpresets') {
          const cur = WX_PRESETS.find((x) => x[0] === S.wxPreset);
          box.innerHTML = `<div class="lab"><span>Presets</span></div><div class="seg wrap" id="wxPre" role="group" aria-label="Weather presets">${WX_PRESETS.map(([id, nm]) => `<button type="button" data-id="${id}" aria-pressed="${S.wxPreset === id}">${nm}</button>`).join('')}</div><div class="help">${cur ? esc(cur[2]) : 'Custom conditions. Pick a preset to start from, then adjust anything below.'}</div>`;
          box.querySelectorAll('button').forEach((b0) => b0.addEventListener('click', () => applyPreset(b0.dataset.id)));
        } else if (it.type === 'da') {
          box.id = 'daBox'; box.innerHTML = daHtml();
        } else if (it.type === 'radio') {
          box.innerHTML = `<div class="radio-box"><div class="name" id="rbName"></div><div class="actions" style="justify-content:flex-start"><button class="btn small" id="rbCtl">Controls &amp; buttons</button><button class="btn small" id="rbSetup">Guided setup</button></div><div class="help">One profile per controller (your HOTAS, your radio…), picked automatically when you plug it in. Each keeps its own stick mapping, button names and actions, rates and expo.</div></div>`;
          box.querySelector('#rbCtl').addEventListener('click', () => { closeSheet(); openCtl(); });
          box.querySelector('#rbSetup').addEventListener('click', () => { closeSheet(); openWizard(); });
        } else if (it.type === 'rates' && ROTARY(AC)) {
          const RT = S.fc[AC.id];
          let h = '<div class="rates rates4"><span class="hd">Axis</span><span class="hd">Centre °/s</span><span class="hd">Max °/s</span><span class="hd">Expo</span>';
          for (const [k, l] of [['roll', 'Roll'], ['pitch', 'Pitch'], ['yaw', 'Yaw']]) {
            h += `<span>${l}</span>`;
            for (const [f, mn, mx, st0] of [['c', 10, 300, 5], ['m', 100, 1800, 10], ['e', 0, 1, 0.05]])
              h += `<label for="fc-${k}-${f}"><output id="fc-${k}-${f}-o">${RT[k][f]}</output><input type="range" id="fc-${k}-${f}" min="${mn}" max="${mx}" step="${st0}" value="${RT[k][f]}"></label>`;
          }
          box.innerHTML = h + '</div><div class="help">Betaflight “Actual” rates: centre sensitivity, max rate at full stick, expo. Enter your quad’s numbers from the Betaflight Rates tab to make it feel the same. Set your radio’s expo to 0 for this.</div>';
          for (const [k] of [['roll'], ['pitch'], ['yaw']]) for (const f of ['c', 'm', 'e']) {
            const e = box.querySelector(`#fc-${k}-${f}`), o = box.querySelector(`#fc-${k}-${f}-o`);
            e.addEventListener('input', () => { RT[k][f] = Number(e.value); o.textContent = e.value; saveS(); });
          }
        } else if (it.type === 'rates') {
          const RE = rateSource(true);
          const ax = AC.kind === 'wing' ? [['a', 'Roll'], ['e', 'Pitch']] : [['a', 'Aileron'], ['e', 'Elevator'], ['r', 'Rudder']];
          let h = '<div class="rates"><span class="hd">Axis</span><span class="hd">Rate</span><span class="hd">Expo</span>';
          for (const [k, l] of ax) {
            h += `<span>${l}</span><label for="rt-${k}"><output id="rt-${k}-o">${RE.rates[k]}%</output><input type="range" id="rt-${k}" min="30" max="100" step="5" value="${RE.rates[k]}"></label>`;
            h += `<label for="ex-${k}"><output id="ex-${k}-o">${RE.expo[k]}%</output><input type="range" id="ex-${k}" min="0" max="80" step="5" value="${RE.expo[k]}"></label>`;
          }
          h += '</div>';
          const throws = AC.kind === 'wing' ? `Full stick = ${Math.round(AC.defl.a * R2D)}° elevon for roll, ${Math.round(AC.defl.e * R2D)}° for pitch.` : `Full stick = ${Math.round(AC.defl.a * R2D)}° aileron, ${Math.round(AC.defl.e * R2D)}° elevator, ${Math.round(AC.defl.r * R2D)}° rudder.`;
          box.innerHTML = `<div class="help">Applies to: <b>${esc(RE.label)}</b></div>` + h + `<div class="help">${throws} If your radio already applies rates and expo, set expo here to 0% for its profile.</div>`;
          for (const [k] of ax) for (const [pre, obj, unit] of [['rt', 'rates', '%'], ['ex', 'expo', '%']]) {
            const e = box.querySelector(`#${pre}-${k}`), o = box.querySelector(`#${pre}-${k}-o`);
            e.addEventListener('input', () => { RE[obj][k] = Number(e.value); o.textContent = e.value + unit; RE.save(); });
          }
        } else if (it.type === 'notes') {
          box.innerHTML = notesHtml() + weatherNotesHtml();
        }
        el.appendChild(box);
      }
      body.appendChild(el);
    }
    refreshCtlStatus();
    $('#sheet').scrollTop = scroll;
  }
  function syncSheet() { if (sheetOpen()) buildSheet(); }
  function rotaryNotesHtml() {
    const W = AC.mass * FL.G;
    if (AC.kind === 'quad') {
      const M = AC.motor, tw = (4 * M.Tmax) / W, pid = AC.pid;
      return `<div class="notes"><div class="kv">
        <span>Flying weight</span><span>${Math.round(AC.mass * 1000)} g</span>
        <span>Max thrust (full pack)</span><span>4 × ${(M.Tmax / FL.G).toFixed(2)} kgf</span>
        <span>Thrust to weight</span><span>${tw.toFixed(1)} : 1</span>
        <span>Hover throttle</span><span>${Math.round(AC.hoverThr * 100)}%</span>
        <span>Props · pack</span><span>${(M.D / 0.0254).toFixed(0)} in · ${AC.batt.label}</span>
        <span>Rate PID roll/pitch</span><span>P ${pid.roll[0]} I ${pid.roll[1]} D ${pid.roll[4]} FF ${pid.roll[2]}</span></div>
        <p><b>Motors.</b> Each motor spools with a ${Math.round(M.tau * 1000)} ms lag. Thrust goes as rpm² and falls off as air flows up through the prop (climbing, or the rotor rising during a roll, which is where roll damping comes from). Pack sag under load lowers thrust as the battery drains.</p>
        <span class="eq">T_i = Tmax·(V/Vref)²·ω_i²·(1 − v_up/(Vpitch·ω_i))·ground effect
rotor drag = −k·ΣT·v_inplane   body drag = −½ρ|v|·CdA·v</span>
        <p><b>Flight controller.</b> Betaflight-style: Actual rates turn sticks into rotation-rate targets, a rate PID with feed-forward, D on gyro and I-term relax turns them into wanted moments, and an air-mode mixer shares thrust between the four motors, giving up collective before it gives up attitude.</p>
        <p><b>Prop wash.</b> Dropping fast and straight down puts the props in their own wake: thrust drops and the quad shakes until you get forward speed.</p>
        <p><b>Simplified.</b> No blade flapping, no motor temperature, no filtering delays beyond the motor lag and D-term filter; the frame is rigid.</p></div>`;
    }
    const Ro = AC.rotor, rpm = (om) => Math.round((om * 60) / (2 * Math.PI)), pid = AC.pid;
    return `<div class="notes"><div class="kv">
      <span>Flying weight</span><span>${Math.round(AC.mass * 1000)} g</span>
      <span>Rotor</span><span>${Math.round(Ro.R * 2000)} mm, ${Ro.blades} blades, ${Math.round(Ro.chord * 1000)} mm chord (σ ${Ro.sigma.toFixed(3)})</span>
      <span>Headspeed · tip speed</span><span>${rpm(Ro.om0)} rpm · ${Math.round(Ro.om0 * Ro.R)} m/s</span>
      <span>Hover collective</span><span>${(AC.hoverPitch / D2R).toFixed(1)}° (stick ${Math.round(AC.hoverThrCurve.normal * 100)}% Normal, ${Math.round(AC.hoverThrCurve['3d'] * 100)}% 3D)</span>
      <span>Pitch curves</span><span>Normal ${Ro.curves.normal.join(' / ')}° · 3D ${Ro.curves['3d'].join(' / ')}°</span>
      <span>Blade lift slope · Cd0 · CLmax</span><span>${Ro.a} /rad · ${Ro.Cd0} · ${Ro.CLmax}</span>
      <span>Motor power · rotor inertia</span><span>${Ro.Pmax} W · ${Ro.J} kg·m²</span>
      <span>Rate PID roll/pitch</span><span>P ${pid.roll[0]} I ${pid.roll[1]} FF ${pid.roll[2]}</span>
      <span>Pack</span><span>${AC.batt.label}</span></div>
      <p><b>Rotor thrust.</b> Blade-element theory with momentum inflow, solved every step, so thrust depends on collective, headspeed, climb or descent rate and forward speed. Forward speed lowers the induced velocity (translational lift), which is why 15–45 km/h takes less power than a hover. Mean blade lift is capped at CLmax, so a slow rotor can't make much thrust no matter how much pitch you pull.</p>
      <span class="eq">T = ½σa·ρA(ΩR)²·[θ(1/3 + μ²/2) − λ/2]     λ = (v_climb + v_i)/(ΩR)
v_i = κT / (2ρA·√(V_fwd² + (v_climb + v_i)²))     κ = ${Ro.kInd}
T ≤ (CLmax/6)·σρA(ΩR)²</span>
      <p><b>Headspeed.</b> The rotor is its own state. A governor holds ${rpm(Ro.om0)} rpm up to ${Ro.Pmax} W of motor power. On throttle hold the motor stops and only the air drives the rotor: with the collective low and the heli descending, air flowing up through the disc keeps it turning (autorotation); leave the collective up and it slows down fast. Bank that headspeed for the flare and the cushion.</p>
      <span class="eq">J·dΩ/dt = Q_motor − [T·(v_climb + v_i) + 1.12·P0] / Ω − friction
P0 = ρA(ΩR)³·σ·Cd0·(1 + 4.65μ²) / 8</span>
      <p><b>Vortex ring.</b> Descending straight down at about the hover induced velocity (1–2 m/s here) puts the rotor in its own wake: thrust drops up to 35% and the heli shakes until you add forward speed.</p>
      <p><b>Flybarless controller.</b> Rate PID on cyclic with feed-forward; the wanted moment becomes disc tilt through the hub stiffness and thrust offset. The tail chases a yaw-rate target and cancels the motor's reaction torque, with a ${Math.round(Ro.tauT * 1000)} ms lag, so a collective punch kicks the tail a little. Horizon, Trainer and Angle work as on the quad.</p>
      <p><b>Simplified.</b> Uniform inflow (no wake skew or blade-by-blade loads), no blade flapping dynamics beyond a short tilt lag and blowback, a stiff hub, and no tail-rotor stall.</p></div>`;
  }
  // the weather model, written so every number can be checked
  function weatherNotesHtml() {
    const pc = propChord(AC);
    return `<div class="notes"><p><b>Weather: air density.</b> Station pressure comes from the altimeter setting and field elevation; humid air is a mix of dry air and water vapour, which is lighter. Density altitude is the height in the standard atmosphere with the same density. Wings, props and rotors all scale with ρ, and so does the motor's load: thin air unloads the prop, so it draws less current and makes less thrust.</p>
      <span class="eq">p = QNH·(1 − 0.0065·h/288.15)^5.256      e = RH·611.2·exp(17.67·T/(T + 243.5))
ρ = (p − e)/(287.05·T) + e/(461.5·T)      DA: ρ = 1.225·(1 − 0.0065·DA/288.15)^4.256</span>
      <p><b>Wind and turbulence.</b> Mean wind follows a log profile (10 m reference) and drops by up to 60% in the lee of trees and the barn, where it turns gusty and sinks. Turbulence is the MIL-F-8785C Dryden low-altitude model: σw = 0.1·W20 with 100% = 45 kt at 20 ft, scale length L = h. Planes also get Dryden rotational gusts (σp grows as the span gets smaller), which is why a small wing rocks in bumpy air.</p>
      <p><b>Precipitation and visibility.</b> Visibility = 3.912/β with β from fog (Kunkel 1984: β = 144.7·LWC^0.88 per km), rain or snow, and ~40 m inside cloud. Heavy rain roughens the wing: up to −12% CLmax and +0.01 drag at 100 mm/h (rough).</p>
      <p><b>Icing.</b> Supercooled water — cloud (0.25 g/m³, 15 µm drops), freezing fog (water content from visibility), freezing drizzle or rain, wet snow — freezes on leading edges. Small chords collect drops better, so tails, wing tips and props ice first. Fast blades warm by V²/2365 °C, so prop tips and rotor blades stay clean near 0 °C.</p>
      <span class="eq">dk/dt = E·n·LWC·V/ρice     E = K/(K + 0.6),  K = ρw·d²·V/(18μ·0.04c)
n = min(1, 0.25 − Ts/4)     ρice 700 (rime) … 900 (glaze) kg/m³
ΔCLmax = (0.30 + 0.15·glaze)·(1 − e^(−(k/c)/0.002))     ΔCD0 = (0.025 + 0.03·glaze)·(1 − e^(−(k/c)/0.005))
props: thrust ×(1 − 0.6·g), power ×(1 + 0.8·g), g = 1 − e^(−(k/c)/0.01), blade chord ${(pc * 1000).toFixed(0)} mm</span>
      <p>These follow published trends for iced airfoils and UAV props (Bragg; Hann et al.; Müller et al.) but the numbers are rough and on the pessimistic side: treat the sim as a reason to turn around early, not as a margin to fly to. Ice melts above +0.5 °C (faster in rain) and sheds off fast props in chunks, which shakes the aircraft.</p>
      <p><b>Batteries.</b> Internal resistance ×e^(0.0277·(20 − T)), usable capacity −0.6%/°C below 20 °C. The pack heats by I²R and cools to the air through ${(AC.batt.cool || [0.08, 0.03]).join(' + ')}·√V W/K. A punch-out on a frozen pack sags hard; a gentle hover may never warm it.</p></div>`;
  }
  let perfCache = { key: '', html: '' };
  function notesHtml() {
    if (ROTARY(AC)) return rotaryNotesHtml();
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
    const camW = M4.chain(planeM, M4.trans(m.cam[0], m.cam[1], m.cam[2]), M4.rotX(tiltOf() * D2R));
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
    const cam = v.kind === 'fpv' ? fpvCam(v, planeM) : losCam(v, planeM);
    v.cam = cam;
    const lk = lookFrom(cam.pos[1]);
    v.look = lk;
    applyLook(lk);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    v.vp = M4.mul(M4.persp(cam.fovy, v.w / v.h, cam.near, 7000), cam.view);
    gl.uniformMatrix4fv(L.uVP, false, v.vp);
    gl.uniform3fv(L.uCam, cam.pos);
    // sky, then the overcast over it
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    const camT = M4.trans(cam.pos[0], cam.pos[1], cam.pos[2]);
    GLR.draw(R, skyMesh, camT, { unlit: true, noFog: true });
    if (lk.sky > 0.01) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      GLR.draw(R, overMesh, camT, { unlit: true, noFog: true, alpha: lk.sky, tint: lk.fog });
      gl.disable(gl.BLEND);
    }
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
    const I = M4.ident(), sn = snowCover(), WHITE = [0.93, 0.94, 0.96];
    GLR.draw(R, world.ground, I, { tex: grassTex, worldUV: true, texScale: 1 / 8, mix: sn ? [...WHITE, sn] : null });
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-2, -4);
    GLR.draw(R, world.runway, M4.trans(0, 0.02, 0), { tex: runwayTex, mix: sn ? [...WHITE, sn * 0.6] : null });
    GLR.draw(R, world.decal, M4.trans(0, 0.02, 0));
    gl.disable(gl.POLYGON_OFFSET_FILL);
    GLR.draw(R, world.scenery, I, { mix: sn ? [...WHITE, sn * 0.35] : null });
    GLR.draw(R, sockMesh, sockM);
    if (S.course && world.gates.length) { // marker floating over the next gate
      const gt = world.gates[course.next], bob = Math.sin(course.clock * 3) * 0.15;
      GLR.draw(R, markerMesh, M4.chain(M4.trans(gt.x, gt.top + 1.1 + bob, gt.z), M4.rotY(course.clock * 2), M4.scale(0.32, 0.45, 0.32)), { unlit: true });
    }
    const model = MODELS[AC.id];
    const partM = [];
    const ii = iceInfo(), iceMix = ii.kc > 0 ? [0.86, 0.92, 0.98, clamp(ii.kc * 40, 0, 0.65)] : null;
    const propMix = ii.prop > 0.02 ? [0.86, 0.92, 0.98, clamp(ii.prop * 1.3, 0, 0.75)] : null;
    for (const p of model.parts) { const m = p.anim ? M4.chain(planeM, p.mat, p.anim(st)) : M4.mul(planeM, p.mat); partM.push(m); GLR.draw(R, p.mesh, m, { mix: iceMix }); }
    const propMs = model.props.map((pr) => (pr.tilt ? M4.chain(planeM, pr.mat, pr.tilt(st), pr.post, M4.rotZ(pr.ang)) : M4.chain(planeM, pr.mat, M4.rotZ(pr.ang))));
    if (v.kind !== 'fpv') model.props.forEach((pr, i) => GLR.draw(R, pr.blades, propMs[i], { mix: propMix }));
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
    if (v.kind !== 'fpv') {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      model.props.forEach((pr, i) => { const sp = pr.spin(st); if (sp > 0.12) GLR.draw(R, pr.disc, propMs[i], { alpha: 0.16 + 0.12 * sp, unlit: true, mix: propMix }); });
      gl.depthMask(true); gl.disable(gl.BLEND);
    }
    // cloud deck: a thin lower layer and an opaque one 12 m up, so a model climbing into it fades out
    if (S.ceilFt > 0) {
      const cy = S.ceilFt * 0.3048, base = S.precip === 'heavy' ? [0.5, 0.52, 0.56] : S.precip !== 'none' ? [0.6, 0.62, 0.66] : [0.7, 0.72, 0.75];
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      for (const [dy, a] of [[0, 0.55], [12, 0.92]]) GLR.draw(R, cloudMesh, M4.trans(cam.pos[0], cy + dy, cam.pos[2]), { unlit: true, alpha: a, tint: cam.pos[1] > cy + dy ? [0.9, 0.91, 0.93] : base });
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
  // throttle readout; a heli shows collective pitch and headspeed instead
  const thrText = (pct) => (AC.kind === 'heli'
    ? `${st.coll >= 0 ? '+' : ''}${(st.coll / D2R).toFixed(1)}° ${Math.round((st.om * 60) / (2 * Math.PI))} RPM`
    : `THR ${Math.round(inp.thr * 100)}${pct ? '%' : ''}`);
  // one-line weather summary for the LOS readout (empty on a plain clear day)
  function wxLine() {
    const P = FL.PRECIP[S.precip], wxa = env.wx || {}, parts = [];
    const fz = wxa.lwc > 0 && wxa.T <= 0;
    if (S.precip !== 'none') parts.push(((P.liquid && atmo.Tc <= 0) ? 'FREEZING ' : '') + P.name.toUpperCase());
    else if (S.fogVis < 10000 && S.rh >= 95) parts.push(atmo.Tc <= 0 ? 'FREEZING FOG' : 'FOG');
    if (S.fogVis < 10000 || S.precip !== 'none') parts.push(`VIS ${UW.vis(Math.round(wxa.visM || S.fogVis)).toUpperCase()}`);
    if (S.ceilFt > 0) parts.push(`CEIL ${UW.ceil(S.ceilFt).toUpperCase()}`);
    if (wxa.inCloud) parts.push('IN CLOUD');
    if (fz && S.precip === 'none' && !wxa.inCloud && !(S.fogVis < 10000)) parts.push('ICING');
    const hot = Math.abs(atmo.daFt - S.elevFt) > 1500;
    if (!parts.length && !hot && S.turb < 40) return [];
    return [UW.temp(S.tempF), `DA ${Math.round(atmo.daFt / 100) * 100} FT`, S.turb >= 40 ? `TURB ${S.turb >= 75 ? 'SEVERE' : 'MOD'}` : '', ...parts].filter(Boolean);
  }
  function warnings() {
    const w = [];
    if (st.held && !armed) w.push(['THROTTLE DOWN TO ARM', '#ffd36a']);
    else if (st.held) w.push(['THROTTLE UP TO LAUNCH', '#ffd36a']);
    else if (!armed) w.push(['THROTTLE DOWN TO ARM', '#ffd36a']);
    if (cutOn || cutHeld) w.push([AC.kind === 'heli' ? 'THROTTLE HOLD' : 'THROTTLE CUT', '#ff9d42']);
    if (AC.kind === 'heli' && !st.crashed) {
      if (armed && !(cutOn || cutHeld) && st.wow && st.om < 0.95 * AC.rotor.om0) w.push(['SPOOLING UP', '#ffd36a']);
      else if (!st.wow && st.om < 0.8 * AC.rotor.om0 && blink % 1 < 0.6) w.push(['LOW HEADSPEED', '#ff6157']);
    }
    if (S.battery && st.soc <= 0) w.push(['BATTERY EMPTY', '#ff6157']);
    else if (S.battery && st.vb / AC.batt.cells < (AC.batt.chem === 'liion' ? 3.1 : 3.45) && st.n > 0.05) w.push(['LOW BATTERY', '#ff9d42']);
    const d = Math.hypot(st.p[0], st.p[1]);
    if (d > 400) w.push([`FAR · ${U.dist(d)}`, '#ff9d42']);
    if (-st.p[2] > 121.9) w.push(['ABOVE 400 FT', '#ff9d42']);
    if (S.iceCue && !st.crashed) { // not something a real aircraft tells you; turn it off to practise spotting the signs
      const ii = iceInfo();
      if (ii.lift > 0.08) w.push([`ICE −${Math.round(ii.lift * 100)}% LIFT`, '#9fd3ff']);
      if (ii.prop > 0.08) w.push([`${AC.kind === 'heli' ? 'BLADE' : 'PROP'} ICE −${Math.round(ii.prop * 100)}% THRUST`, '#9fd3ff']);
    }
    if (S.stallCue && Math.max(st.tele.stallL, st.tele.stallR) > 0.25 && blink % 1 < 0.6) {
      const side = st.tele.stallL - st.tele.stallR > 0.15 ? ' L' : st.tele.stallR - st.tele.stallL > 0.15 ? ' R' : '';
      w.push([`STALL${side}`, '#ff6157']);
    }
    return w;
  }
  /* ---------- HUD: pitch ladder, flight-path marker, speed / altitude / heading tapes, bank scale ---------- */
  const HUDC = '#93ffa6';
  function hudStroke(path, w = 1.6) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = w + 2.4; path(); ctx.stroke();
    ctx.strokeStyle = HUDC; ctx.lineWidth = w; path(); ctx.stroke();
  }
  function hudBox(x, y, w, h, text, align, fs) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y - h / 2, w, h);
    hudStroke(() => { ctx.beginPath(); ctx.rect(x, y - h / 2, w, h); }, 1.4);
    osdText(text, align === 'right' ? x + w - 4 : x + 4, y, align, fs, HUDC);
  }
  // vertical tape: value in display units, ticks every `step`, labels every `lab`, `span` units over height h
  function vTape(x, cy, h, value, step, lab, span, side, fs, title, min = -Infinity) {
    const k = h / span, top = cy - h / 2, bot = cy + h / 2, dir = side === 'left' ? -1 : 1;
    ctx.save(); ctx.beginPath(); ctx.rect(x - 80, top, 160, h); ctx.clip();
    const v0 = Math.floor((value - span / 2) / step) * step;
    hudStroke(() => {
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot);
      for (let u = Math.max(v0, Math.floor(min / step) * step); u <= value + span / 2 + step; u += step) {
        const y = cy - (u - value) * k, big = Math.abs(u / lab - Math.round(u / lab)) < 1e-6;
        ctx.moveTo(x, y); ctx.lineTo(x + dir * (big ? fs * 0.6 : fs * 0.3), y);
      }
    }, 1.4);
    for (let u = Math.max(Math.ceil((value - span / 2) / lab) * lab, min); u <= value + span / 2; u += lab) {
      const y = cy - (u - value) * k;
      if (Math.abs(y - cy) > fs * 0.9) osdText(String(Math.round(u)), x + dir * fs * 0.85, y, side === 'left' ? 'right' : 'left', fs * 0.72, HUDC);
    }
    ctx.restore();
    if (title) osdText(title, x, top - fs * 0.7, 'center', fs * 0.62, HUDC);
  }
  function drawHud(v, fs, cx, cy, eu, alt, gs, m, topY) {
    if (!v.cam) return;
    const f = v.h / 2 / Math.tan(v.cam.fovy / 2), tilt = tiltOf() * D2R, pc = eu.pitch + tilt;
    const imp = S.units === 'imp';
    // pitch ladder, clipped to a central window
    const W = Math.min(v.w, v.h) * 0.42, step = f * Math.tan(5 * D2R) > fs * 1.6 ? 5 : 10; // 5° rungs only when they're far enough apart
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, Math.min(v.w * 0.3, v.h * 0.34), 0, Math.PI * 2); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(-eu.roll);
    const L1 = W * 0.42, gap = fs * 2.2;
    for (let d = -90; d <= 90; d += step) {
      const rel = pc - d * D2R;
      if (Math.abs(rel) > 32 * D2R && d !== 0) continue;
      const y = f * Math.tan(rel);
      if (Math.abs(y) > v.h * 0.6) continue;
      if (d === 0) { hudStroke(() => { ctx.beginPath(); ctx.moveTo(-W * 1.2, y); ctx.lineTo(-gap, y); ctx.moveTo(gap, y); ctx.lineTo(W * 1.2, y); }, 2); continue; }
      const len = d % 10 === 0 ? L1 * 0.55 : L1 * 0.3, tick = (d > 0 ? 1 : -1) * fs * 0.45;
      hudStroke(() => {
        ctx.beginPath();
        if (d < 0) ctx.setLineDash([fs * 0.45, fs * 0.3]);
        ctx.moveTo(-gap - len, y + tick); ctx.lineTo(-gap - len, y); ctx.lineTo(-gap, y);
        ctx.moveTo(gap, y); ctx.lineTo(gap + len, y); ctx.lineTo(gap + len, y + tick);
      }, 1.4);
      ctx.setLineDash([]);
      if (d % 10 === 0) { osdText(String(Math.abs(d)), -gap - len - fs * 0.25, y, 'right', fs * 0.62, HUDC); osdText(String(Math.abs(d)), gap + len + fs * 0.25, y, 'left', fs * 0.62, HUDC); }
    }
    ctx.restore();
    // waterline (where the camera points) and flight-path marker (where the aircraft is going)
    hudStroke(() => { ctx.beginPath(); ctx.moveTo(cx - fs * 1.6, cy); ctx.lineTo(cx - fs * 0.7, cy); ctx.lineTo(cx - fs * 0.35, cy + fs * 0.35); ctx.lineTo(cx, cy); ctx.lineTo(cx + fs * 0.35, cy + fs * 0.35); ctx.lineTo(cx + fs * 0.7, cy); ctx.lineTo(cx + fs * 1.6, cy); }, 1.8);
    const R0 = FL.quatToMat(st.q), vb = FL.mulMtV(R0, st.v), sp = Math.hypot(vb[0], vb[1], vb[2]);
    if (sp > 2) {
      const fw = vb[0] * Math.cos(tilt) - vb[2] * Math.sin(tilt), dn = vb[0] * Math.sin(tilt) + vb[2] * Math.cos(tilt);
      if (fw > 0.2) {
        const px = cx + (f * vb[1]) / fw, py = cy + (f * dn) / fw, r = fs * 0.42;
        if (Math.abs(px - cx) < v.w * 0.42 && Math.abs(py - cy) < v.h * 0.4)
          hudStroke(() => { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.moveTo(px - r, py); ctx.lineTo(px - r * 2.2, py); ctx.moveTo(px + r, py); ctx.lineTo(px + r * 2.2, py); ctx.moveTo(px, py - r); ctx.lineTo(px, py - r * 1.9); }, 1.6);
      }
    }
    // bank scale: arc with ticks at 10/20/30/45/60°, pointer at the current bank
    const BR0 = Math.min(v.w, v.h) * 0.36, by0 = cy;
    hudStroke(() => {
      ctx.beginPath();
      for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
        const t = (a - 90) * D2R, l = a % 30 === 0 ? fs * 0.6 : fs * 0.35;
        ctx.moveTo(cx + BR0 * Math.cos(t), by0 + BR0 * Math.sin(t)); ctx.lineTo(cx + (BR0 + l) * Math.cos(t), by0 + (BR0 + l) * Math.sin(t));
      }
    }, 1.3);
    const tb = clamp(-eu.roll, -70 * D2R, 70 * D2R) - Math.PI / 2;
    hudStroke(() => {
      const px = cx + (BR0 - 2) * Math.cos(tb), py = by0 + (BR0 - 2) * Math.sin(tb), nx = Math.cos(tb), ny = Math.sin(tb);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - nx * fs * 0.55 - ny * fs * 0.32, py - ny * fs * 0.55 + nx * fs * 0.32); ctx.lineTo(px - nx * fs * 0.55 + ny * fs * 0.32, py - ny * fs * 0.55 - nx * fs * 0.32); ctx.closePath();
    }, 1.4);
    // speed tape (left) and altitude tape (right)
    const th = v.h * 0.46, sx = v.x + m + fs * 3.6, ax = v.x + v.w - m - fs * 3.6;
    const spd = imp ? st.tele.V * 2.23694 : st.tele.V * 3.6, altU = imp ? alt * 3.2808 : alt;
    vTape(sx, cy, th, spd, 1, 10, imp ? 40 : 60, 'left', fs, imp ? 'MPH' : 'KM/H', 0);
    vTape(ax, cy, th, altU, imp ? 10 : 2, imp ? 50 : 10, imp ? 200 : 60, 'right', fs, imp ? 'FT' : 'M');
    hudBox(sx - fs * 3.2, cy, fs * 3.0, fs * 1.3, String(Math.round(spd)), 'right', fs);
    hudBox(ax + fs * 0.2, cy, fs * 3.4, fs * 1.3, String(Math.round(altU)), 'left', fs);
    // vario: a bar beside the altitude tape (full scale ±5 m/s) and the number under it
    const vs = -st.v[2], vh = clamp(vs / 5, -1, 1) * th * 0.45;
    hudStroke(() => { ctx.beginPath(); ctx.moveTo(ax + fs * 3.9, cy); ctx.lineTo(ax + fs * 3.9, cy - vh); ctx.moveTo(ax + fs * 3.6, cy - vh); ctx.lineTo(ax + fs * 4.2, cy - vh); }, 2.4);
    osdText(`${vs >= 0 ? '↑' : '↓'}${imp ? Math.abs(vs * 3.28).toFixed(0) : Math.abs(vs).toFixed(1)}`, ax + fs * 1.6, cy + th / 2 + fs * 0.8, 'center', fs * 0.8, HUDC);
    osdText(`GS ${Math.round(imp ? gs * 2.23694 : gs * 3.6)}`, sx - fs * 1.4, cy + th / 2 + fs * 0.8, 'center', fs * 0.8, HUDC);
    // heading tape (top)
    const hdg = ((eu.yaw * R2D) % 360 + 360) % 360, tw = Math.min(v.w * 0.5, fs * 16), hy = topY + fs * 0.3, kx = tw / 60;
    ctx.save(); ctx.beginPath(); ctx.rect(cx - tw / 2, hy - fs, tw, fs * 2.4); ctx.clip();
    hudStroke(() => {
      ctx.beginPath(); ctx.moveTo(cx - tw / 2, hy); ctx.lineTo(cx + tw / 2, hy);
      for (let d = Math.floor((hdg - 35) / 5) * 5; d <= hdg + 35; d += 5) { const x = cx + (d - hdg) * kx; ctx.moveTo(x, hy); ctx.lineTo(x, hy + (d % 10 === 0 ? fs * 0.45 : fs * 0.25)); }
    }, 1.3);
    for (let d = Math.ceil((hdg - 30) / 30) * 30; d <= hdg + 30; d += 30) {
      const n = ((d % 360) + 360) % 360, lab = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n] || String(n / 10).padStart(2, '0');
      const x = cx + (d - hdg) * kx;
      if (Math.abs(x - cx) > fs * 1.3) osdText(lab, x, hy + fs * 1.05, 'center', fs * 0.7, HUDC);
    }
    ctx.restore();
    hudBox(cx - fs * 1.4, hy + fs * 1.05, fs * 2.8, fs * 1.15, String(Math.round(hdg) % 360).padStart(3, '0'), 'right', fs * 0.8);
  }

  /* ---------- precipitation, lens water and frost (drawn on the OSD canvas, projected per view) ---------- */
  const PRN = 480, prt = Array.from({ length: PRN }, () => [Math.random(), Math.random(), Math.random(), Math.random()]);
  let wxClock = 0, osdDt = 0;
  const lensDrops = [];
  function project(vp, v, p) {
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    if (cw < 0.3) return null;
    return [v.x + ((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / cw + 1) * 0.5 * v.w, v.y + (1 - (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / cw) * 0.5 * v.h, cw];
  }
  function drawPrecip(v) {
    const P = FL.PRECIP[S.precip];
    if (!P || !P.R || !v.vp || !v.cam) return;
    const wet = P.liquid || atmo.Tc > 2, inC = v.look && v.look.inCloud;
    if (inC) return; // inside the cloud you see grey, not drops
    const n = Math.round(PRN * Math.min(1, wet ? 0.3 + P.R / 30 : 0.45 + P.R / 6)), B = wet ? 26 : 20;
    const c = v.cam.pos, w = env.wind, t = wxClock;
    const vd = [w[1], -(wet ? P.fall : P.fall) - w[2], -w[0]]; // drop velocity, render axes (x east, y up, z south)
    const vc = v.kind === 'fpv' ? [st.v[1], -st.v[2], -st.v[0]] : [0, 0, 0];
    const rel = [vd[0] - vc[0], vd[1] - vc[1], vd[2] - vc[2]], ex = 0.035; // streak = motion during ~1/30 s
    const wrap = (o, vel, ci) => ((((o * B + vel * t - ci) % B) + B) % B) - B / 2 + ci;
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(205,215,228,0.35)'; ctx.fillStyle = 'rgba(250,251,255,0.85)';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const o = prt[i];
      const wob = wet ? 0 : Math.sin(t * 1.7 + o[3] * 6.3) * 0.5;
      const p = [wrap(o[0], vd[0], c[0]) + wob, wrap(o[1], vd[1], c[1]), wrap(o[2], vd[2], c[2])];
      const a = project(v.vp, v, p);
      if (!a || a[0] < v.x || a[0] > v.x + v.w || a[1] < v.y || a[1] > v.y + v.h) continue;
      if (wet) {
        const b = project(v.vp, v, [p[0] - rel[0] * ex, p[1] - rel[1] * ex, p[2] - rel[2] * ex]);
        if (!b) continue;
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      } else {
        const r = clamp(55 / a[2], 0.6, 3.2);
        ctx.moveTo(a[0] + r, a[1]); ctx.arc(a[0], a[1], r, 0, Math.PI * 2);
      }
    }
    if (wet) ctx.stroke(); else ctx.fill();
  }
  // water drops on the FPV lens in rain or cloud above freezing; frost when the lens ices
  function drawLens(v, dt) {
    const P = FL.PRECIP[S.precip], wxa = env.wx || {};
    const wetRate = (wxa.T > 0 ? (P.liquid ? P.R : 0) + (wxa.inCloud ? 3 : 0) : 0) * (1 + Math.min(2, (st.tele.V || 0) / 12));
    if (Math.random() < wetRate * 0.04 && lensDrops.length < 40) lensDrops.push({ x: Math.random(), y: Math.random(), r: 0.008 + Math.random() * 0.022, life: 3 + Math.random() * 6 });
    const sp = (st.tele.V || 0) / 30;
    for (let i = lensDrops.length - 1; i >= 0; i--) {
      const d = lensDrops[i];
      d.life -= dt * (1 + sp * 2); d.y += dt * (0.01 + sp * 0.12); d.x += (d.x - 0.5) * dt * sp * 0.3;
      if (d.life <= 0 || d.y > 1.1) { lensDrops.splice(i, 1); continue; }
      const R0 = d.r * Math.min(v.w, v.h), x = v.x + d.x * v.w, y = v.y + d.y * v.h;
      ctx.beginPath(); ctx.arc(x, y, R0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200,214,230,0.16)'; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.stroke();
    }
    const ice = st.iceLens;
    if (ice > 0.02) {
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2, Rr = Math.hypot(v.w, v.h) / 2;
      const g = ctx.createRadialGradient(cx, cy, Rr * 0.6 * (1 - ice), cx, cy, Rr);
      g.addColorStop(0, 'rgba(235,242,250,0)'); g.addColorStop(1, `rgba(235,242,250,${(0.9 * ice).toFixed(3)})`);
      ctx.fillStyle = g; ctx.fillRect(v.x, v.y, v.w, v.h);
      if (ice > 0.4) { ctx.fillStyle = `rgba(230,238,246,${(0.55 * (ice - 0.4) / 0.6).toFixed(3)})`; ctx.fillRect(v.x, v.y, v.w, v.h); }
    }
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
      drawPrecip(v);
      if (v.kind === 'fpv') drawLens(v, osdDt);
      if (v.kind === 'fpv' && S.osd !== 'off') {
        const full = S.osd === 'full', hud = full && S.hud === 'hud';
        if (hud) drawHud(v, fs, cx, cy, eu, alt, gs, m, topY);
        // crosshair and artificial horizon
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
        if (!hud) { ctx.beginPath(); ctx.moveTo(cx - fs * 1.2, cy); ctx.lineTo(cx - fs * 0.4, cy); ctx.moveTo(cx + fs * 0.4, cy); ctx.lineTo(cx + fs * 1.2, cy); ctx.moveTo(cx, cy - fs * 0.4); ctx.lineTo(cx, cy - fs * 0.15); ctx.stroke(); }
        if (full && !hud && v.cam) {
          const f = v.h / 2 / Math.tan(v.cam.fovy / 2);
          const pc = eu.pitch + tiltOf() * D2R;
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
        osdText(modeOsd(S.mode), v.x + m, topY, 'left', fs);
        osdText(fmtTime(flightTime), v.x + v.w - m, topY, 'right', fs);
        if (!hud) {
          osdText(`ALT ${U.alt(alt)}`, v.x + m, cy, 'left', fs);
          osdText(`${U.spd(st.tele.V)}`, v.x + v.w - m, cy, 'right', fs);
        }
        if (full && !hud) {
          const vs = -st.v[2];
          osdText(`${vs >= 0 ? '↑' : '↓'}${S.units === 'imp' ? Math.abs(vs * 3.28).toFixed(0) + ' ft/s' : Math.abs(vs).toFixed(1) + ' m/s'}`, v.x + m, cy + fs * 1.3, 'left', fs * 0.85);
          osdText(`GS ${U.spd(gs)}`, v.x + v.w - m, cy + fs * 1.3, 'right', fs * 0.85);
        }
        const by = v.y + v.h - m - fs * 0.2 - lift;
        if (S.battery) osdText(`${st.vb.toFixed(1)}V ${Math.round(st.mAh)}mAh`, v.x + m, by, 'left', fs);
        osdText(thrText(false), cx, by, 'center', fs);
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
        osdText(`ALT ${U.alt(alt)}  SPD ${U.spd(st.tele.V)}  ${thrText(true)}${S.battery ? '  ' + st.vb.toFixed(1) + 'V' : ''}`, v.x + m, y2, 'left', s2);
        osdText(`WIND ${U.wind(S.windSpd)} from ${compass(S.windDir)} · ${modeName(S.mode).toUpperCase()}`, v.x + m, y2 - s2 * 1.4, 'left', s2, 'rgba(255,255,255,0.85)');
        const wl = wxLine();
        if (wl.length) { // one line if it fits, else two
          const one = wl.join(' · '), fits = ctx.measureText(one).width < v.w - 2 * m;
          const rows = fits ? [one] : [wl.slice(0, Math.ceil(wl.length / 2)).join(' · '), wl.slice(Math.ceil(wl.length / 2)).join(' · ')];
          rows.reverse().forEach((r, i) => osdText(r, v.x + m, y2 - s2 * (2.8 + 1.4 * i), 'left', s2, 'rgba(225,238,255,0.85)'));
        }
        ctx.font = `${fs}px "Share Tech Mono", ui-monospace, Menlo, Consolas, monospace`;
      }
      // warnings
      const wy = topY + fs * (v.kind === 'fpv' && S.osd === 'full' && S.hud === 'hud' ? 2.9 : 1.6); // clear of the HUD heading tape
      W.forEach(([t, c], i) => osdText(t, cx, wy + i * fs * 1.35, 'center', fs, c));
      if (osdFlash.t > 0) osdText(osdFlash.text, cx, cy - fs * 3, 'center', fs, '#cfe9f3');
      const ct = courseText();
      if (ct) osdText(ct, cx, v.kind === 'fpv' ? v.y + v.h - m - fs * 1.6 - lift : v.y + v.h - m - fs * 3.2 - lift, 'center', v.kind === 'fpv' ? fs : Math.max(11, fs * 0.8), '#ffd36a');
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
  function wxEng() {
    const ii = iceInfo(), wxa = env.wx || {};
    const out = [`air ${(wxa.T ?? atmo.Tc).toFixed(1)}°C   pack ${st.bT.toFixed(1)}°C ${Math.round(FL.battR(AC.batt, st.bT) * 1000)} mΩ`];
    if (ii.kc > 0 || st.iceProp > 0 || st.iceLens > 0) out.push(`ice k/c ${(ii.kc * 100).toFixed(2)}%  lift −${Math.round(ii.lift * 100)}%  prop −${Math.round(ii.prop * 100)}%  +${Math.round(ii.mass * 1000)} g`);
    return out;
  }
  function drawEng(v) {
    const t = st.tele, x = v.x + 12, y0 = v.y + (v.y < 4 ? 92 : 30);
    if (ROTARY(AC)) {
      const L2 = AC.kind === 'quad'
        ? [`V  ${t.V.toFixed(1)} m/s   n ${t.nz.toFixed(2)} g`, `T  ${t.T.toFixed(1)} N   T/W max ${(t.tw || 0).toFixed(1)}`,
           `motors ${st.mot.map((m) => Math.round(m * 100)).join(' ')}%`, `pack ${st.vb.toFixed(1)} V  ${st.I.toFixed(0)} A   wash ${(t.wash || 0).toFixed(2)}`]
        : [`V  ${t.V.toFixed(1)} m/s   n ${t.nz.toFixed(2)} g`, `T  ${t.T.toFixed(1)} N   rotor ${Math.round(st.om * 60 / (2 * Math.PI))} rpm`,
           `collective ${((t.coll || 0) * R2D).toFixed(1)}°   inflow ${(t.vi || 0).toFixed(1)} m/s`, `shaft ${(t.Pm || 0).toFixed(0)} W   pack ${st.vb.toFixed(1)} V  ${st.I.toFixed(0)} A`,
           `vortex ring ${Math.round((t.vrs || 0) * 100)}%   blade stall ${Math.round(Math.min(1, t.bladeStall || 0) * 100)}%`];
      L2.push(...wxEng());
      ctx.font = '12px "Share Tech Mono", ui-monospace, monospace'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(15,21,25,0.72)'; ctx.fillRect(x - 6, y0 - 12, 300, L2.length * 17 + 8);
      L2.forEach((l, i) => osdText(l, x, y0 + i * 17, 'left', 12, '#cfe9f3'));
      return;
    }
    const lines = [
      `α  ${(t.alpha * R2D).toFixed(1)}°   β ${(t.beta * R2D).toFixed(1)}°`,
      `V  ${t.V.toFixed(1)} m/s   q ${t.qbar.toFixed(0)} Pa`,
      `CL ${t.CL.toFixed(2)}   n ${t.nz.toFixed(2)} g`,
      `T  ${t.T.toFixed(2)} N   ρ ${env.rho.toFixed(3)}`,
      ...wxEng(),
    ];
    ctx.font = '12px "Share Tech Mono", ui-monospace, monospace'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(15,21,25,0.72)'; ctx.fillRect(x - 6, y0 - 12, 300, lines.length * 17 + 38);
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
    const K0 = { wing: [120, 520, 1.5], conventional: [70, 260, 2], quad: [170, 950, 1.5], heli: [0, 0, 2] }[AC.kind];
    let f = K0[0] + K0[1] * st.n;
    if (AC.kind === 'heli') { f = (st.om / (2 * Math.PI)) * 2; g = S.sound && !paused && !st.crashed ? 0.015 + 0.04 * (st.om / AC.rotor.om0) : 0; } // blade pass
    if (S.view !== 'fpv') {
      g /= 1 + losDist / 45;
      // Doppler for fly-bys (pilot at the origin)
      const r = Math.hypot(st.p[0], st.p[1], st.p[2]) || 1;
      const vr = (st.v[0] * st.p[0] + st.v[1] * st.p[1] + st.v[2] * st.p[2]) / r;
      f *= 343 / (343 + vr);
    }
    gainN.gain.setTargetAtTime(g, t, 0.05);
    osc.frequency.setTargetAtTime(f, t, 0.04);
    osc2.frequency.setTargetAtTime(f * K0[2], t, 0.04);
  }

  /* ---------------------------------------------------------------- loop */
  function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  /* Wind = mean wind (log profile, slowed in the lee of trees and buildings) + big slow gusts +
     Dryden turbulence (MIL-F-8785C low-altitude model) + mechanical turbulence behind obstacles.
     Planes also get Dryden rotational gusts (p, q, r), which is what makes a small wing rock. */
  const turbV = [0, 0, 0], gwV = [0, 0, 0];
  let lee = 0;
  const ou = (x, tau, sig, dt) => x + (-x / tau) * dt + sig * Math.sqrt((2 * dt) / tau) * gauss();
  function leeAt(pN, pE, h, Wm, dir) {
    if (Wm < 1 || !world.blockers) return 0;
    const dN = -Math.cos(dir), dE = -Math.sin(dir); // the way the wind blows
    let f = 0;
    for (const b of world.blockers) {
      const rN = pN - b.n, rE = pE - b.e, along = rN * dN + rE * dE;
      if (along < -b.r || along > 10 * b.h || h > 1.6 * b.h) continue;
      const lat = Math.abs(-rN * dE + rE * dN), wid = b.r + 0.15 * Math.max(0, along) + 1;
      if (lat > wid) continue;
      f = Math.max(f, (1 - Math.max(0, along) / (10 * b.h)) * (1 - h / (1.6 * b.h)) * (1 - lat / wid));
    }
    return f;
  }
  function updateWind(dt) {
    const Wm = S.windSpd, dir = S.windDir * D2R, sig = (S.gust / 100) * Wm;
    for (let i = 0; i < 3; i++) gust[i] = ou(gust[i], i < 2 ? 2.2 : 1.0, sig * (i < 2 ? 1 : 0.35), dt);
    const h = Math.max(0.3, -st.p[2]);
    lee = leeAt(st.p[0], st.p[1], h, Wm, dir);
    // Dryden: σw = 0.1·W20 (W20 = wind at 20 ft: 15 kt light, 30 moderate, 45 severe → 100% here = 45 kt),
    // σu = σw / (0.177 + 0.000823·h)^0.4, scale lengths Lw = h, Lu = h / (0.177 + 0.000823·h)^1.2 (feet)
    const hf = Math.max(5, h * 3.2808), kq = 0.177 + 0.000823 * Math.min(hf, 1000);
    const sw = 0.1 * (S.turb / 100) * 23.1, su = sw / Math.pow(kq, 0.4);
    const Lw = hf * 0.3048, Lu = (hf / Math.pow(kq, 1.2)) * 0.3048;
    const V = Math.max(4, st.tele.V || 0);
    const smech = 0.45 * Wm * lee, tmech = 0.4; // eddies shed by the obstacle
    const gnd = Math.min(1, h / 4); // the ground stops vertical gusts
    for (let i = 0; i < 2; i++) turbV[i] = ou(turbV[i], Math.max(dt * 2, Lu / V), Math.hypot(su, smech), dt);
    turbV[2] = ou(turbV[2], Math.max(dt * 2, Math.min(Lw / V, tmech + Lw / V)), Math.hypot(sw, smech) * gnd, dt);
    if (!ROTARY(AC) && sw > 0) {
      const b = AC.b, sp = sw * Math.sqrt((0.8 * Math.cbrt((Math.PI * Lw) / (4 * b)) * Math.PI * Math.PI) / (8 * b * Lw));
      const tp = Math.max(dt * 2, (4 * b) / (Math.PI * V));
      gwV[0] = ou(gwV[0], tp, sp, dt); gwV[1] = ou(gwV[1], tp * 2, sp * 0.5, dt); gwV[2] = ou(gwV[2], tp * 2, sp * 0.4, dt);
    } else gwV[0] = gwV[1] = gwV[2] = 0;
    env.gw = gwV;
    const prof = clamp(Math.log(h / 0.03) / Math.log(10 / 0.03), 0.3, 1.3); // log wind profile, 10 m reference
    const shelter = 1 - 0.6 * lee;
    env.wind = [
      (-Wm * Math.cos(dir) * shelter + gust[0]) * prof + turbV[0],
      (-Wm * Math.sin(dir) * shelter + gust[1]) * prof + turbV[1],
      gust[2] * Math.min(1, h / 10) + turbV[2] + 0.25 * Wm * lee * gnd, // sinking air in the lee
    ];
  }
  function sockMatrix() {
    const Wm = S.windSpd, dir = S.windDir * D2R;
    const wn = -Wm * Math.cos(dir) + gust[0], we = -Wm * Math.sin(dir) + gust[1];
    const sp = Math.hypot(wn, we);
    const droop = (Math.PI / 2) * 0.92 * (1 - clamp(sp / 7, 0, 1));
    return M4.chain(M4.trans(SOCK_POS[0], SOCK_POS[1], SOCK_POS[2]), M4.rotY(Math.atan2(wn, we)), M4.rotZ(-droop));
  }
  // rates & expo: the active controller profile's when flying with a controller, else keyboard/touch
  function rateSource(forEdit) {
    const P = prof();
    if (src === 'radio' && P !== EMPTY) {
      if (forEdit) { P.rates = P.rates || Object.assign({}, S.rates); P.expo = P.expo || Object.assign({}, S.expo); }
      return { rates: P.rates || S.rates, expo: P.expo || S.expo, label: `${P.name} profile`, save: saveIN };
    }
    return { rates: S.rates, expo: S.expo, label: 'keyboard and touch', save: saveS };
  }
  function controls() {
    if (ROTARY(AC)) {
      const cut = cutOn || cutHeld, heli = AC.kind === 'heli';
      // heli: the left stick is collective, live even with the motor held; hold stops the motor only
      return { thr: armed || heli ? inp.thr : 0, a: inp.a, e: inp.e, r: inp.r, armed: armed && !cut, hold: cut, curve: S.curve,
        mode: { manual: 'acro', horizon: 'horizon', trainer: 'trainer', stab: 'angle' }[S.mode] || 'acro', lim: limNow() };
    }
    const ex = (x, e) => { const k = e / 100; return x * (k * x * x + 1 - k); };
    const T = AC.trim, ut = userTrim(), RE = rateSource(false);
    return {
      thr: armed && !cutOn && !cutHeld ? inp.thr : 0,
      a: FL.sat((ex(inp.a, RE.expo.a) * RE.rates.a) / 100 + T.a + ut.a),
      e: FL.sat((ex(inp.e, RE.expo.e) * RE.rates.e) / 100 + T.e + ut.e),
      r: FL.sat((ex(inp.r, RE.expo.r) * RE.rates.r) / 100 + ut.r),
      sa: inp.a, se: inp.e,
    };
  }
  // the aircraft is a sphere of radius AC.colR (about half its size) for obstacle checks
  function hitObstacle(p, R0) {
    for (const o of world.obstacles) {
      const qx = p[0] - o.cx, qz = p[2] - o.cz, lim = o.br + R0;
      if (qx * qx + qz * qz > lim * lim) continue;
      if (o.k === 'cyl') {
        if (p[1] < o.y0 - R0 || p[1] > o.y1 + R0) continue;
        const dx = p[0] - o.x, dz = p[2] - o.z;
        if (dx * dx + dz * dz < (o.r + R0) * (o.r + R0)) return o;
      } else if (o.k === 'box') {
        const cx = clamp(p[0], o.x0, o.x1), cy = clamp(p[1], o.y0, o.y1), cz = clamp(p[2], o.z0, o.z1);
        if ((p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 < R0 * R0) return o;
      } else {
        const a = o.a, d = [o.b[0] - a[0], o.b[1] - a[1], o.b[2] - a[2]];
        const t = clamp(((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), 0, 1);
        const ex = p[0] - a[0] - d[0] * t, ey = p[1] - a[1] - d[1] * t, ez = p[2] - a[2] - d[2] * t;
        if (ex * ex + ey * ey + ez * ez < (o.r + R0) * (o.r + R0)) return o;
      }
    }
    return null;
  }
  // swept check along the path flown since the last frame, so thin poles and wires can't be skipped
  let obsPrev = null;
  function checkObstacles() {
    const p = [st.p[1], -st.p[2], -st.p[0]], prev = obsPrev;
    obsPrev = p;
    if (!S.crashes || st.crashed || st.held || !prev) return;
    const R0 = AC.colR || 0.3, d = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    if (d > 50) return; // teleported (reset)
    const n = Math.max(1, Math.ceil(d / (R0 * 0.5)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, q = [lerp(prev[0], p[0], t), lerp(prev[1], p[1], t), lerp(prev[2], p[2], t)];
      const o = hitObstacle(q, R0);
      if (o) { st.crashed = true; st.crashMsg = o.k === 'seg' && o.r < 0.06 ? 'Hit the power lines' : 'Hit an obstacle'; return; }
    }
  }

  /* ---------- gate course: fly the gates in order; lap time from gate 1 to gate 1 ---------- */
  const course = { next: 0, lapStart: null, clock: 0, prev: null };
  const fmtLap = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  function courseReset() { course.next = 0; course.lapStart = null; course.prev = null; }
  function courseTick(dt) {
    course.clock += dt;
    const p = [st.p[1], -st.p[2], -st.p[0]], prev = course.prev;
    course.prev = p;
    if (!S.course || !prev || st.crashed || st.held || !world.gates.length) return;
    const gt = world.gates[course.next], c = Math.cos(gt.psi), s = Math.sin(gt.psi);
    const loc = (q) => { const dx = q[0] - gt.x, dz = q[2] - gt.z; return [c * dx - s * dz, q[1], s * dx + c * dz]; };
    const a = loc(prev), b = loc(p);
    if ((a[2] < 0) === (b[2] < 0)) return;
    const t = a[2] / (a[2] - b[2]), x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    if (Math.abs(x) > gt.W / 2 || y < gt.b || y > gt.b + gt.H) return;
    if (course.next === 0) {
      if (course.lapStart !== null) {
        const lap = course.clock - course.lapStart, best = S.best[AC.id];
        if (!best || lap < best) { S.best[AC.id] = lap; saveS(); flash(`LAP ${fmtLap(lap)} · NEW BEST`); } else flash(`LAP ${fmtLap(lap)}`);
      } else flash('LAP STARTED');
      course.lapStart = course.clock;
    }
    course.next = (course.next + 1) % world.gates.length;
  }
  function courseText() {
    if (!S.course || course.lapStart === null) return '';
    const best = S.best[AC.id];
    return `GATE ${course.next + 1}/${world.gates.length}  ${fmtLap(course.clock - course.lapStart)}${best ? '  BEST ' + fmtLap(best) : ''}`;
  }

  let last = performance.now(), fpsN = 0, fpsT = 0, fpsVal = 0, barT = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = Math.max(0, (now - last) / 1000); last = now;
    const dt = Math.min(0.1, raw); // physics never takes a bigger bite than 0.1 s
    blink += dt;
    fpsN++; fpsT += dt; if (fpsT > 0.5) { fpsVal = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
    pollInput(dt);
    if (wiz.open) wizTick(Math.min(0.5, raw)); // setup timers use real time
    if (ctl.open) ctlTick(Math.min(0.5, raw));
    if (osdFlash.t > 0) osdFlash.t -= raw;

    if (!paused) {
      if (!armed && inp.thr < 0.05) armed = true;
      if (st.held && armed) {
        // throw once the motor is wound up: throttle above 70% for 0.3 s
        if (inp.thr > 0.7) launchHold += dt; else launchHold = 0;
        if (launchHold > 0.3) { FL.launch(st); timerOn = true; }
      }
      updateWind(dt);
      env.wx = FL.weatherAt(wxBase, Math.max(0, -st.p[2]));
      acc += dt;
      const c = controls();
      let steps = 0;
      while (acc >= DT && steps < 60) {
        const cc = ROTARY(AC) || S.mode === 'manual' ? c : FL.planeAssist(S.mode, { a: c.sa, e: c.se }, c, st, AC, limNow());
        FL.step(st, AC, cc, env, DT);
        acc -= DT; steps++;
      }
      if (steps >= 60) acc = 0;
      checkObstacles();
      courseTick(dt);
      if (!timerOn && armed && inp.thr > 0.1) timerOn = true;
      if (timerOn && !st.crashed) flightTime += dt;
      for (const pr of MODELS[AC.id].props) pr.ang += pr.spin(st) * pr.dir * dt * 60;
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
    osdDt = paused ? 0 : dt; wxClock += osdDt;
    drawOSD(views);
    updateAudio(losD);
    barT += dt; if (barT > 0.25) { barT = 0; refreshBar(); refreshTouch(); }
  }

  /* ---------------------------------------------------------------- boot */
  buildWorld(S.scenery);
  resize();
  doReset();
  refreshBar(); refreshTouch(); refreshCtlStatus();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { gl.bindTexture(gl.TEXTURE_2D, runwayTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, runwayTexture()); gl.generateMipmap(gl.TEXTURE_2D); });
  requestAnimationFrame((t) => { last = t; frame(t); });
  window.__flightline = { st, S, env, AC: () => AC, doReset, FL, IN: () => IN, prof, ctl, world: () => world, course }; // debugging and tests
})();
