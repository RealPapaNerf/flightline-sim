/* Weather bench tests: density altitude, cold batteries, icing, rain. Run: node test/weather_test.js
   Every number printed here can be checked by hand or against a reference. */
const FL = require('../src/physics.js');
const line = (...a) => console.log(...a);
const DT = 1 / 400, mph = (v) => v * 2.23694, fToC = (f) => ((f - 32) * 5) / 9, ft = (m) => m * 3.28084;
const r0 = (x) => Math.round(x).toLocaleString('en-US');

line('== Density altitude (field elevation, temperature, humidity, altimeter) ==');
for (const [e, t, rh, alt, note] of [
  [0, 59, 0, 29.92, 'ISA sea level → expect ρ 1.225, DA 0'],
  [5000, 41, 0, 29.92, 'ISA at 5,000 ft (41 °F) → expect DA ≈ 5,000'],
  [5000, 59, 0, 29.92, '18 °F above ISA → rule of thumb +120 ft/°C → ≈ 6,200'],
  [6000, 98, 12, 30.05, 'Utah July afternoon'],
  [0, 95, 0, 29.92, 'hot, dry'],
  [0, 95, 85, 29.92, 'hot, humid: water vapour is lighter than air'],
  [4500, 25, 70, 30.4, 'cold winter high pressure'],
  [0, 59, 0, 30.5, 'high altimeter → pressure altitude ≈ −560 ft'],
]) {
  const a = FL.atmosphere(e, t, rh, alt);
  line(`${String(e).padStart(5)} ft ${String(t).padStart(3)}°F ${String(rh).padStart(3)}% ${alt.toFixed(2)} inHg: ρ ${a.rho.toFixed(4)} kg/m³, DA ${r0(a.daFt)} ft, PA ${r0(a.paFt)} ft, dew point ${a.dewC.toFixed(1)}°C — ${note}`);
}
{
  const dry = FL.atmosphere(0, 95, 0), wet = FL.atmosphere(0, 95, 85);
  line(`humidity at 95°F adds ${r0(wet.daFt - dry.daFt)} ft of density altitude (${(100 * (1 - wet.rho / dry.rho)).toFixed(1)}% less dense)`);
}

line('\n== Visibility and liquid water ==');
for (const [vis, p, rh, ceil, alt, t] of [[300, 'none', 100, 0, 30, 27], [1000, 'none', 100, 0, 30, 27], [10000, 'drizzle', 98, 150, 30, 30], [10000, 'drizzle', 98, 150, 160, 30], [10000, 'heavy', 90, 0, 30, 60], [10000, 'heavysnow', 90, 0, 30, 31], [10000, 'heavysnow', 90, 0, 30, 20]]) {
  const w = FL.weatherAt({ tempC: fToC(t), rh, precip: p, fogVisM: vis, ceilM: ceil }, alt);
  line(`fog vis ${vis} m, ${p}, ${t}°F, ${ceil ? 'ceiling ' + ceil + ' m, ' : ''}at ${alt} m: liquid water ${(w.lwc * 1000).toFixed(3)} g/m³, drops ${(w.mvd * 1e6).toFixed(0)} µm, visibility ${r0(w.visM)} m${w.inCloud ? ', IN CLOUD' : ''}${w.freezing && w.lwc > 0 ? ', FREEZING' : ''}`);
}

line('\n== Ice growth rate at the leading edge ==');
{
  const cloud = { lwc: 0.25e-3, mvd: 15e-6 }, fzdz = { lwc: 0.12e-3, mvd: 250e-6 };
  for (const [what, w, V, c, T] of [
    ['Goblin wing root, cloud', cloud, 17, 0.217, -5], ['Goblin wing tip, cloud', cloud, 17, 0.09, -5],
    ['trainer stab, cloud', cloud, 15, 0.075, -5], ['Goblin wing, freezing drizzle', fzdz, 17, 0.167, -1],
    ['prop, 75% radius at 80 m/s', cloud, 80, 0.013, -5], ['prop at 80 m/s, −1°C', cloud, 80, 0.013, -1], ['prop at 150 m/s, −5°C', cloud, 150, 0.013, -5],
  ]) line(`${what.padEnd(32)} ${T}°C: ${(FL.iceRate(w, V, c, T) * 6e4).toFixed(2)} mm/min`);
}

// hold the aircraft in level flight at V (a wind tunnel), let ice build for some minutes
function soak(ac, wx, V, alpha, minutes, thr = 0.6) {
  const s = FL.makeState(); FL.reset(s, ac, 'air', 10);
  const env = { rho: 1.27, wind: [0, 0, 0], battery: false, crashes: false, wx };
  const steps = Math.round((minutes * 60) / DT);
  for (let i = 0; i < steps; i++) {
    s.p = [0, 0, -100]; s.q = FL.quatFromEuler(0, alpha, 0); s.v = [V, 0, 0]; s.w = [0, 0, 0];
    FL.step(s, ac, { thr, a: 0, e: 0, r: 0 }, env, DT);
  }
  return s;
}

line('\n== Goblin in freezing cloud (−5°C, 0.25 g/m³, 15 µm), flying 17 m/s ==');
{
  const ac = FL.build(FL.DEFS.goblin), rho = 1.27;
  const dry = FL.stallSpeed(ac, rho);
  line(`clean: CLmax ${dry.CLmax.toFixed(2)}, stall ${mph(dry.Vs).toFixed(1)} mph at α ${(dry.alpha / FL.D2R).toFixed(1)}°`);
  const wx = { T: -5, lwc: 0.25e-3, mvd: 15e-6, rain: 0 };
  for (const min of [1, 3, 6, 10]) {
    const s = soak(ac, wx, 17, 0.03, min);
    const st = FL.stallSpeed(ac, rho, { ice: s.ice, iceMass: s.iceMass, iceGl: s.iceGl });
    const root = s.ice[0] * 1000, k = s.ice.reduce((a, b, i) => a + b / ac.strips[i].chord, 0) / s.ice.length;
    line(`${String(min).padStart(2)} min: root ice ${root.toFixed(1)} mm, mean k/c ${(k * 100).toFixed(2)}%, +${(s.iceMass * 1000).toFixed(0)} g, CLmax ${st.CLmax.toFixed(2)} (−${(100 * (1 - st.CLmax / dry.CLmax)).toFixed(0)}%), stall ${mph(st.Vs).toFixed(1)} mph at α ${(st.alpha / FL.D2R).toFixed(1)}°, prop ice ${(s.iceProp * 1000).toFixed(2)} mm, lens ${(s.iceLens * 100).toFixed(0)}%`);
  }
}

line('\n== Trainer: tailplane vs wing in the same cloud (smaller chord collects faster) ==');
{
  const ac = FL.build(FL.DEFS.trainer);
  const s = soak(ac, { T: -5, lwc: 0.25e-3, mvd: 15e-6, rain: 0 }, 15, 0.04, 5);
  const avg = (role) => { let a = 0, n = 0; ac.strips.forEach((st, i) => { if (st.role === role) { a += s.ice[i] / st.chord; n++; } }); return (100 * a) / n; };
  line(`after 5 min: wing k/c ${avg('wing').toFixed(2)}%, stab k/c ${avg('tail').toFixed(2)}%, fin k/c ${avg('fin').toFixed(2)}%`);
  const dry = FL.stallSpeed(ac, 1.27), st = FL.stallSpeed(ac, 1.27, { ice: s.ice, iceMass: s.iceMass, iceGl: s.iceGl });
  line(`stall ${mph(dry.Vs).toFixed(1)} → ${mph(st.Vs).toFixed(1)} mph`);
}

line('\n== Rain on the Goblin wing ==');
{
  const ac = FL.build(FL.DEFS.goblin);
  for (const [nm, r] of [['dry', 0], ['rain 4 mm/h', 0.04], ['heavy 25 mm/h', 0.25], ['cloudburst 100 mm/h', 1]]) {
    const st = FL.stallSpeed(ac, 1.2, { rain: r });
    line(`${nm.padEnd(20)} CLmax ${st.CLmax.toFixed(3)}, stall ${mph(st.Vs).toFixed(1)} mph`);
  }
}

line('\n== 5" quad hovering in freezing fog (−4°C, 200 m visibility) ==');
{
  const ac = FL.build(FL.DEFS.quad);
  const wx = FL.weatherAt({ tempC: -4, rh: 100, precip: 'none', fogVisM: 200, ceilM: 0 }, 5);
  line(`fog liquid water ${(wx.lwc * 1000).toFixed(3)} g/m³`);
  const s = FL.makeState(); FL.reset(s, ac, 'air', 15); s.p[2] = -20;
  const env = { rho: 1.3, wind: [0, 0, 0], battery: false, crashes: true, wx };
  let thr = ac.hoverThr, iz = 0, sheds = 0, wasShed = 0;
  const out = [];
  for (let i = 0, n = Math.round(240 / DT); i < n; i++) {
    const ez = -s.p[2] - 20; iz += ez * DT;
    thr = Math.min(1, Math.max(0, ac.hoverThr - 0.03 * ez - 0.01 * iz + 0.02 * s.v[2]));
    FL.step(s, ac, { armed: true, mode: 'angle', thr, a: 0, e: 0, r: 0 }, env, DT);
    if (s.shed > wasShed + 0.5) sheds++;
    wasShed = s.shed;
    if (i % Math.round(30 / DT) === 0) out.push(`${Math.round(i * DT)}s ${Math.round(thr * 100)}% (ice ${(s.iceProp * 1000).toFixed(2)} mm)`);
  }
  line('throttle to hold height: ' + out.join(' | ') + `; ice shed ${sheds} times; lens ${(s.iceLens * 100).toFixed(0)}% frosted`);
}

line('\n== 450 heli hovering in freezing fog (−8°C, 200 m visibility; at −1°C the blades stay clean: tip heating) ==');
{
  const ac = FL.build(FL.DEFS.heli);
  const wx = FL.weatherAt({ tempC: -8, rh: 100, precip: 'none', fogVisM: 200, ceilM: 0 }, 5);
  const s = FL.makeState(); FL.reset(s, ac, 'air', 10); s.p[2] = -20;
  const env = { rho: 1.28, wind: [0, 0, 0], battery: true, crashes: true, wx };
  let iz = 0; const out = [];
  for (let i = 0, n = Math.round(240 / DT); i < n; i++) {
    const ez = -s.p[2] - 20; iz += ez * DT;
    const thr = Math.min(1, Math.max(0, ac.hoverThrCurve.normal - 0.03 * ez - 0.01 * iz + 0.02 * s.v[2]));
    FL.step(s, ac, { armed: true, mode: 'angle', curve: 'normal', thr, a: 0, e: 0, r: 0 }, env, DT);
    if (i % Math.round(60 / DT) === 0) out.push(`${Math.round(i * DT)}s ${s.tele.Pm.toFixed(0)} W, ${(s.coll / FL.D2R).toFixed(1)}°`);
  }
  line('shaft power and collective to hover: ' + out.join(' | ') + ` | 240s ${s.tele.Pm.toFixed(0)} W; blade ice ${(s.iceProp * 1000).toFixed(2)} mm, used ${Math.round(s.mAh)} mAh`);
}

line('\n== Cold LiPo: 5" quad punch-out, pack at different temperatures (air 0°C) ==');
{
  const ac = FL.build(FL.DEFS.quad);
  for (const Tp of [25, 5, -5, -15]) {
    const s = FL.makeState(); FL.reset(s, ac, 'pad', Tp);
    const env = { rho: 1.29, wind: [0, 0, 0], battery: true, crashes: true, wx: { T: 0, lwc: 0, mvd: 0, rain: 0 } };
    let vmin = 99, vmax = 0;
    for (let i = 0, n = Math.round(1.5 / DT); i < n; i++) {
      FL.step(s, ac, { armed: true, mode: 'acro', thr: 1, a: 0, e: 0, r: 0 }, env, DT);
      if (i > 40) vmin = Math.min(vmin, s.vb / 6);
      vmax = Math.max(vmax, -s.v[2]);
    }
    line(`pack ${String(Tp).padStart(3)}°C: R ${(FL.battR(ac.batt, Tp) * 1000).toFixed(0)} mΩ, capacity ${(FL.capF(Tp) * 100).toFixed(0)}%, sags to ${vmin.toFixed(2)} V/cell, peak climb ${vmax.toFixed(1)} m/s, pack ${s.bT.toFixed(1)}°C after 1.5 s`);
  }
}
{
  const ac = FL.build(FL.DEFS.goblin);
  const s = FL.makeState(); FL.reset(s, ac, 'air', -5);
  const env = { rho: 1.31, wind: [0, 0, 0], battery: true, crashes: false, wx: { T: -5, lwc: 0, mvd: 0, rain: 0 } };
  const out = [];
  for (let i = 0, n = Math.round(600 / DT); i < n; i++) {
    s.p = [0, 0, -100]; s.q = FL.quatFromEuler(0, 0.03, 0); s.v = [17, 0, 0]; s.w = [0, 0, 0];
    FL.step(s, ac, { thr: 0.6, a: 0, e: 0, r: 0 }, env, DT);
    if (i % Math.round(120 / DT) === 0) out.push(`${Math.round(i * DT / 60)} min ${s.bT.toFixed(1)}°C ${(s.vb / 2).toFixed(2)} V/cell`);
  }
  line(`Goblin cruising at 60% throttle, air −5°C, pack starts −5°C: ${out.join(' | ')} | 10 min ${s.bT.toFixed(1)}°C, ${Math.round(s.mAh)} mAh of ${Math.round(ac.batt.mAh * FL.capF(s.bT))} usable`);
}
