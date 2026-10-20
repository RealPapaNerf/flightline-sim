/* Navigation bench tests: sensors, link budget, autopilot. Run: node test/nav_test.js */
const FL = require('../src/physics.js');
const NAV = require('../src/nav.js');
const line = (...a) => console.log(...a);
const DT = 1 / 400, FRAME = 1 / 60, deg = (r) => (r * 180) / Math.PI;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true, wx: { T: 15, lwc: 0, mvd: 0, rain: 0 } };
const flat = (refl) => () => ({ h: 0, refl });

line('== Link budget (no obstructions, no interference) ==');
for (const [k, L] of Object.entries(NAV.RCLINKS)) {
  const row = [100, 1000, 3000, 10000].map((d) => `${d} m ${NAV.received(L, d, 40, Math.atan2(40, d), 0).toFixed(0)}`);
  let far = 0; for (let d = 50; d < 200000; d *= 1.05) if (NAV.received(L, d, 40, Math.atan2(40, d), 0) > L.sens) far = d;
  line(`${L.name}: ${row.join(' | ')} dBm; sensitivity ${L.sens} → range at 40 m ≈ ${(far / 1000).toFixed(1)} km`);
}
for (const [k, L] of Object.entries(NAV.VTXS)) {
  let clean = 0, gone = 0;
  for (let d = 20; d < 30000; d *= 1.03) { const r = NAV.received(L, d, 40, Math.atan2(40, d), 0); if (r > NAV.VIDEO_FLOOR + NAV.VIDEO_CLEAN) clean = d; if (r > NAV.VIDEO_FLOOR) gone = d; }
  let low = 0; for (let d = 20; d < 30000; d *= 1.03) if (NAV.received(L, d, 3, Math.atan2(3, d), 0) > NAV.VIDEO_FLOOR + NAV.VIDEO_CLEAN) low = d;
  line(`${L.name}: clean to ${(clean / 1000).toFixed(2)} km, snow to ${(gone / 1000).toFixed(2)} km at 40 m up; clean only to ${(low / 1000).toFixed(2)} km at 3 m up (ground bounce)`);
}

line('\n== Lidar: furthest valid range by surface (no tilt) ==');
for (const [k, L] of Object.entries(NAV.LIDARS)) {
  if (!L.max) continue;
  const row = [['grass', 0.45], ['asphalt', 0.12], ['wet asphalt', 0.06], ['snow', 0.7]].map(([n, r]) => {
    let best = 0;
    for (let h = 0.5; h < 200; h += 0.5) {
      const nav = NAV.make(), s = FL.makeState(); s.p = [0, 0, -h]; s.q = [1, 0, 0, 0];
      let ok = 0; for (let i = 0; i < 120; i++) { NAV.sensors(nav, s, { lidar: k, surface: flat(r) }, FRAME); if (i >= 60 && nav.est.src === 'lidar') ok++; }
      if (ok > 45) best = h;
    }
    return `${n} ${best} m`;
  });
  line(`${L.name.padEnd(26)} ${row.join(' | ')}`);
}
{
  const nav = NAV.make(), s = FL.makeState(); s.p = [0, 0, -6]; s.q = [1, 0, 0, 0]; let bad = 0, n = 0;
  for (let i = 0; i < 600; i++) { NAV.sensors(nav, s, { lidar: 'tf02', surface: flat(0.45), precipR: 4, snowing: true }, FRAME); if (nav.rng.valid) { n++; if (Math.abs(nav.rng.d - 6) > 1) bad++; } }
  line(`TF02 at 6 m in heavy snow: ${((100 * bad) / n).toFixed(0)}% of returns are flakes`);
}
{
  const nav = NAV.make(), s = FL.makeState(); s.p = [0, 0, -20]; let lid = 0;
  for (const bank of [0, 20, 35, 50]) {
    s.q = FL.quatFromEuler(bank * FL.D2R, 0, 0); let src = '';
    for (let i = 0; i < 60; i++) { NAV.sensors(nav, s, { lidar: 'tf02', surface: flat(0.45) }, FRAME); src = nav.est.src; }
    line(`TF02 at 20 m, ${bank}° bank: range ${nav.rng.d.toFixed(1)} m (slant), estimate from ${src}, height ${nav.est.alt.toFixed(1)} m`);
  }
}

line('\n== GPS and baro ==');
{
  const nav = NAV.make(), s = FL.makeState(); s.p = [0, 0, -30]; let maxH = 0, sumB = 0, n = 0;
  for (let i = 0; i < 60 * 300; i++) { NAV.sensors(nav, s, { lidar: 'none', V: 0 }, FRAME); maxH = Math.max(maxH, Math.hypot(nav.gps.p[0], nav.gps.p[1])); sumB += (nav.baro.alt - 30) ** 2; n++; }
  line(`5 min parked at 30 m: GPS wandered up to ${maxH.toFixed(1)} m horizontally; baro RMS error ${Math.sqrt(sumB / n).toFixed(2)} m`);
  line(`baro error at 20 m/s from the static-port term: ${(-0.0025 * 400).toFixed(1)} m`);
}

function flyAP(id, mode, opts) {
  const ac = FL.build(FL.DEFS[id]), nav = NAV.make(), s = FL.makeState();
  FL.reset(s, ac, 'air', 20);
  if (opts.p) s.p = opts.p.slice();
  if (opts.v) s.v = opts.v.slice();
  if (opts.q) s.q = opts.q.slice();
  NAV.reset(nav, s);
  const plane = !(ac.kind === 'quad' || ac.kind === 'heli');
  const base0 = ac.kind === 'quad' ? ac.motor.idle + ac.hoverThr * (1 - ac.motor.idle) : 0;
  const cfg = plane ? { kind: 'plane', rtlAlt: 50, Vcruise: 15, Vmin: 11, Vmax: 25, loiterR: 40, aTrim: 2 * FL.D2R, thrTrim: 0.45 }
                    : { kind: ac.kind, rtlAlt: 15, hover: ac.hoverThr, curveK: 0.3, base0, idle: ac.kind === 'quad' ? ac.motor.idle : 0 };
  const e2 = Object.assign({}, env, { wind: opts.wind || [0, 0, 0] });
  for (let i = 0; i < 20; i++) NAV.sensors(nav, s, { lidar: opts.lidar || 'none', surface: flat(0.45) }, FRAME);
  NAV.enter(nav, mode, s);
  const log = [];
  for (let f = 0, nf = Math.round(opts.secs * 60); f < nf; f++) {
    NAV.sensors(nav, s, { lidar: opts.lidar || 'none', surface: flat(0.45), V: s.tele.V }, FRAME);
    const sticks = opts.sticks ? opts.sticks(f / 60) : null;
    const o = NAV.autopilot(nav, s, sticks, cfg, FRAME);
    let ctl;
    if (plane) ctl = FL.planeAssist('stab', { a: o.bank / (50 * FL.D2R), e: o.pitch / (25 * FL.D2R) }, { thr: o.thr, r: 0 }, s, ac, { bank: 50, pitch: 25 });
    else ctl = Object.assign({ armed: o.armed !== false, curve: 'normal' }, o);
    for (let k = 0; k < Math.round(FRAME / DT); k++) FL.step(s, ac, ctl, e2, DT);
    if (opts.every && f % Math.round(opts.every * 60) === 0) log.push(opts.rec(s, nav, f / 60));
    if (s.crashed) { log.push('CRASH ' + s.crashMsg); break; }
  }
  return { s, nav, log };
}

line('\n== Autopilot ==');
{
  const r = flyAP('quad', 'althold', { secs: 20, lidar: 'none', sticks: (t) => ({ thr: t < 6 ? 0.5 : t < 9 ? 1 : 0.5, a: 0, e: 0, r: 0 }), every: 3, rec: (s, n, t) => `${t.toFixed(0)}s ${(-s.p[2]).toFixed(1)}m` });
  line(`5" ALT HOLD (baro), centre throttle, then full up for 3 s: ${r.log.join(' | ')}`);
}
{
  const r = flyAP('quad', 'loiter', { secs: 30, lidar: 'tf02', wind: [0, -5, 0], every: 5, rec: (s, n, t) => `${t.toFixed(0)}s (${s.p[0].toFixed(1)}, ${s.p[1].toFixed(1)}) h ${(-s.p[2]).toFixed(1)}` });
  line(`5" LOITER in a 5 m/s crosswind: ${r.log.join(' | ')}`);
}
{
  const r = flyAP('q7', 'rtl', { secs: 60, p: [120, 80, -8], lidar: 'tf02', every: 6, rec: (s, n, t) => `${t.toFixed(0)}s ${n.ap.phase} d ${Math.hypot(s.p[0], s.p[1]).toFixed(0)} h ${(-s.p[2]).toFixed(1)}` });
  line(`7" RTL from 144 m out at 8 m: ${r.log.join(' | ')} | landed ${r.nav.ap.landed}, ${Math.hypot(r.s.p[0], r.s.p[1]).toFixed(1)} m from home, crashed ${r.s.crashed}`);
}
{
  const r = flyAP('heli', 'rtl', { secs: 60, p: [80, -60, -10], lidar: 'none', every: 8, rec: (s, n, t) => `${t.toFixed(0)}s ${n.ap.phase} d ${Math.hypot(s.p[0], s.p[1]).toFixed(0)} h ${(-s.p[2]).toFixed(1)}` });
  line(`heli RTL from 100 m out: ${r.log.join(' | ')} | landed ${r.nav.ap.landed}, crashed ${r.s.crashed}`);
}
{
  const q = FL.quatFromEuler(0, 0.02, Math.PI / 2);
  const r = flyAP('goblin', 'rtl', { secs: 60, p: [300, 200, -30], v: FL.mulMV(FL.quatToMat(q), [16, 0, 0]), q, every: 6, rec: (s, n, t) => `${t.toFixed(0)}s ${n.ap.phase} d ${Math.hypot(s.p[0], s.p[1]).toFixed(0)} h ${(-s.p[2]).toFixed(0)} V ${s.tele.V.toFixed(0)}` });
  line(`Goblin RTL from 360 m out at 30 m: ${r.log.join(' | ')}`);
}
{
  const q = FL.quatFromEuler(0, 0.02, 0);
  const r = flyAP('trainer', 'althold', { secs: 30, p: [0, 0, -60], v: [15, 0, 0], q, sticks: (t) => ({ thr: 0.4, a: t > 10 && t < 20 ? 0.6 : 0, e: 0, r: 0 }), every: 3, rec: (s, n, t) => `${t.toFixed(0)}s h ${(-s.p[2]).toFixed(1)} V ${s.tele.V.toFixed(1)} bank ${deg(FL.eulerFromMat(FL.quatToMat(s.q)).roll).toFixed(0)}` });
  line(`trainer ALT HOLD (FBWB-style), 27° bank from 10–20 s: ${r.log.join(' | ')}`);
}
{
  const q = FL.quatFromEuler(0, 0.02, 0);
  const r = flyAP('goblin', 'loiter', { secs: 40, p: [100, 0, -40], v: [16, 0, 0], q, every: 5, rec: (s, n, t) => `${t.toFixed(0)}s r ${Math.hypot(s.p[0] - 100, s.p[1]).toFixed(0)} h ${(-s.p[2]).toFixed(0)}` });
  line(`Goblin LOITER (40 m circle): ${r.log.join(' | ')}`);
}
{ // lidar over a tree line: surface tracking then handover to baro when the trees leave range
  const ac = FL.build(FL.DEFS.quad), nav = NAV.make(), s = FL.makeState(); FL.reset(s, ac, 'air', 20); s.p = [0, 0, -11]; NAV.reset(nav, s);
  const trees = (n, e) => ({ h: n > 20 && n < 40 ? 8 : 0, refl: n > 20 && n < 40 ? 0.35 : 0.45 });
  const out = [];
  for (let f = 0; f < 60 * 12; f++) {
    s.p[0] += 4 * FRAME; NAV.sensors(nav, s, { lidar: 'luna', surface: trees }, FRAME);
    if (f % 30 === 0) out.push(`${s.p[0].toFixed(0)}m ${nav.est.src} ${nav.est.alt.toFixed(1)}`);
  }
  line(`TF-Luna, flying level at 11 m (out of its range over grass) across 8 m trees (n 20–40 m): ${out.join(' | ')}`);
}

line('\n== RC failsafe ==');
{ // fly a quad out behind a barn's worth of obstruction with heavy interference: when does the link drop?
  const nav = NAV.make(), s = FL.makeState(); s.p = [0, 0, -20];
  let tFs = null, lq = [];
  for (let f = 0; f < 60 * 120; f++) {
    s.p[0] += 25 * FRAME; // 25 m/s outbound
    NAV.sensors(nav, s, { lidar: 'none' }, FRAME);
    const k = NAV.link(nav, s, { rc: 'elrs24', vtx: 'a600', obsRc: 18, obsVid: 25, noise: 20 }, FRAME);
    if (f % 600 === 0) lq.push(`${(s.p[0] / 1000).toFixed(1)} km LQ ${Math.round(k.rcLq)} vid ${k.vidQ.toFixed(2)}`);
    if (k.rcFs && tFs === null) { tFs = s.p[0]; break; }
  }
  line(`ELRS 2.4 behind a building (−18 dB) with +20 dB interference, 20 m up: ${lq.join(' | ')} → failsafe at ${tFs === null ? '—' : (tFs / 1000).toFixed(2) + ' km'}`);
}

line('\n== The antenna is where you stand, not at the map origin ==');
{ /* Found on the public maps: fly 2 km down the canyon, press B to stand by
     the aircraft, and the video was still snow — link() measured range from
     NED (0,0) whatever the stand point did. The antenna position now rides in
     opt.pilot, so an aircraft 50 m from YOU must read like 50 m, not 2 km. */
  const at = (sp, pilot) => {
    const nav = NAV.make(), s = FL.makeState();
    s.p = sp;
    let k;
    for (let f = 0; f < 120; f++) k = NAV.link(nav, s, { rc: 'elrs24', vtx: 'a600', pilot }, FRAME);
    return k;
  };
  // the same 50 m / 20 m-up geometry, at the origin and 2 km out
  const home = at([50, 0, -20], [0, 0, -1.5]);
  const far = at([2050, 0, -20], [2000, 0, -1.5]);
  const drift = Math.abs(far.rcRssi - home.rcRssi);
  const okNear = drift < 6 && far.vidQ > 0.9; // fading is random ±; the old bug was ~32 dB down and vidQ 0
  line(`50 m away, 20 m up: RSSI ${home.rcRssi.toFixed(0)} dBm at the origin, ${far.rcRssi.toFixed(0)} dBm standing 2 km out (Δ ${drift.toFixed(1)} dB), video ${far.vidQ.toFixed(2)}`);
  line(okNear ? '  ok    the link follows the stand point' : '  FAIL  the link is still measured from the origin');
  if (!okNear) process.exitCode = 1;
  // and with no pilot passed, the old built-in-field behaviour stands
  const legacy = at([50, 0, -20], undefined);
  const okLegacy = Math.abs(legacy.rcRssi - home.rcRssi) < 6;
  line(okLegacy ? '  ok    no opt.pilot still means the origin (built-in field)' : '  FAIL  default antenna moved');
  if (!okLegacy) process.exitCode = 1;
}
