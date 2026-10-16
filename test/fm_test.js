const FL = require('../src/physics.js');
const ac = FL.TRAINER;
const DT = 1 / 400;
const deg = (r) => (r * 180) / Math.PI;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };

function airStart(V, alt, thr) {
  const s = FL.makeState();
  FL.reset(s, ac, 'air');
  s.p = [0, 0, -alt];
  s.q = FL.quatFromEuler(0, 0, 0);
  s.v = [V, 0, 0];
  s.n = thr;
  return s;
}
function run(s, ctl, secs, cb) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    const c = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    FL.step(s, ac, c, env, DT);
    if (cb) cb(s, i * DT);
  }
}
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const line = (...a) => console.log(...a);

// 1) hands-off trim: find throttle that holds altitude, check speed settles
line('\n== 1. Hands-off level flight ==');
for (const thr of [0.55, 0.6, 0.65, 0.7]) {
  const s = airStart(14, 60, thr);
  let minV = 99, maxV = 0;
  run(s, { thr, a: 0, e: 0, r: 0 }, 40, (s, t) => { if (t > 20) { minV = Math.min(minV, s.tele.V); maxV = Math.max(maxV, s.tele.V); } });
  const e = eul(s);
  line(`thr ${thr}: V ${s.tele.V.toFixed(1)} m/s (range t>20s ${minV.toFixed(1)}–${maxV.toFixed(1)}), climb ${(-s.v[2]).toFixed(2)} m/s, alpha ${deg(s.tele.alpha).toFixed(1)}°, pitch ${deg(e.pitch).toFixed(1)}°, roll ${deg(e.roll).toFixed(1)}°`);
}

// 2) stall: idle, hold increasing up elevator, record min speed with lift ≈ weight
line('\n== 2. Stall ==');
{
  const s = airStart(14, 100, 0.3);
  let stallV = null, maxCL = 0;
  run(s, (s, t) => ({ thr: 0.3, a: 0, e: Math.min(1, t / 12), r: 0 }), 14, (s, t) => {
    if (s.tele.CL > maxCL) { maxCL = s.tele.CL; stallV = s.tele.V; }
  });
  const theory = Math.sqrt((2 * ac.mass * 9.81) / (1.225 * ac.S * maxCL));
  line(`max CL reached ${maxCL.toFixed(2)} at V ${stallV.toFixed(1)} m/s; 1-g stall speed for that CL = ${theory.toFixed(1)} m/s (${(theory * 2.237).toFixed(0)} mph)`);
  const e = eul(s);
  line(`after full up-elevator hold: alpha ${deg(s.tele.alpha).toFixed(0)}°, pitch ${deg(e.pitch).toFixed(0)}°, V ${s.tele.V.toFixed(1)}, finite=${Number.isFinite(s.p[2])}`);
}

// 3) ground: sits still, no drift
line('\n== 3. Resting on runway ==');
{
  const s = FL.makeState(); FL.reset(s, ac, 'runway');
  const p0 = s.p.slice();
  run(s, { thr: 0, a: 0, e: 0, r: 0 }, 5);
  line(`after 5 s: moved ${Math.hypot(s.p[0] - p0[0], s.p[1] - p0[1]).toFixed(4)} m, z ${s.p[2].toFixed(4)}, wow ${s.wow}, crashed ${s.crashed}, pitch ${deg(eul(s).pitch).toFixed(2)}°`);
}

// 4) takeoff: full throttle, up elevator after 12 m/s
line('\n== 4. Takeoff ==');
{
  const s = FL.makeState(); FL.reset(s, ac, 'runway');
  const x0 = s.p[1];
  let liftoff = null;
  // pilot: hold pitch 0 until 9 m/s, then rotate to and hold 10° nose up
  run(s, (s) => { const e = eul(s); const thD = s.tele.V > 9 ? 0.17 : 0; return { thr: 1, a: -0.5 * e.roll, e: FL.sat(2 * (thD - e.pitch) - 0.2 * s.w[1]), r: 0 }; }, 10, (s, t) => {
    if (!liftoff && !s.wow && t > 0.5) liftoff = { t, d: s.p[1] - x0, V: s.tele.V };
  });
  line(liftoff ? `liftoff at t=${liftoff.t.toFixed(1)} s after ${liftoff.d.toFixed(0)} m ground roll, V ${liftoff.V.toFixed(1)} m/s` : 'no liftoff');
  line(`at 10 s: alt ${(-s.p[2]).toFixed(1)} m, climb ${(-s.v[2]).toFixed(1)} m/s, V ${s.tele.V.toFixed(1)}, crashed ${s.crashed} ${s.crashMsg}`);
}

// 5) roll rate at full aileron, 15 m/s
line('\n== 5. Roll rate ==');
{
  const s = airStart(15, 100, 0.65);
  let pmax = 0;
  run(s, { thr: 0.65, a: 1, e: 0, r: 0 }, 1.0, (s) => { pmax = Math.max(pmax, s.w[0]); });
  line(`full right aileron: peak roll rate ${deg(pmax).toFixed(0)}°/s`);
  const s2 = airStart(15, 100, 0.65);
  let p2 = 0;
  run(s2, { thr: 0.65, a: 0.3, e: 0, r: 0 }, 1.0, (s) => { p2 = Math.max(p2, s.w[0]); });
  line(`30% aileron: peak roll rate ${deg(p2).toFixed(0)}°/s`);
}

// 6) top speed at full throttle, level (hold altitude with elevator P-loop)
line('\n== 6. Top speed ==');
{
  const s = airStart(16, 100, 1);
  run(s, (s) => ({ thr: 1, a: -0.5 * eul(s).roll, e: FL.sat(0.05 * (100 + s.p[2]) - 0.3 * -s.v[2] * 0.1 + 0.02 * s.v[2]), r: 0 }), 40);
  line(`full throttle level: V ${s.tele.V.toFixed(1)} m/s (${(s.tele.V * 2.237).toFixed(0)} mph), alt ${(-s.p[2]).toFixed(0)} m`);
}

// 7) spiral mode: bank 30° then let go
line('\n== 7. Spiral stability (released at 30° bank) ==');
{
  const s = airStart(14, 150, 0.62);
  s.q = FL.quatFromEuler(30 * Math.PI / 180, 0, 0);
  s.v = FL.mulMV(FL.quatToMat(s.q), [14, 0, 0]);
  const out = [];
  run(s, { thr: 0.62, a: 0, e: 0, r: 0 }, 30, (s, t) => { if (Math.abs(t % 5) < DT / 2) out.push(`${t.toFixed(0)}s:${deg(eul(s).roll).toFixed(0)}°`); });
  line('bank over time: ' + out.join('  '));
}

// 8) rudder-only turn (dihedral effect): rudder right should roll right
line('\n== 8. Rudder roll coupling ==');
{
  const s = airStart(14, 100, 0.62);
  run(s, { thr: 0.62, a: 0, e: 0, r: 0.6 }, 3);
  line(`3 s of 60% right rudder: bank ${deg(eul(s).roll).toFixed(0)}°, heading change ${deg(eul(s).yaw).toFixed(0)}°`);
}

// 9) stabilised mode returns level and holds bank
line('\n== 9. Stabilised mode ==');
{
  const s = airStart(14, 100, 0.62);
  s.q = FL.quatFromEuler(60 * Math.PI / 180, 0.2, 0);
  s.v = FL.mulMV(FL.quatToMat(s.q), [14, 0, 0]);
  const out = [];
  run(s, (s) => FL.stabilize({ thr: 0.62, a: 0, e: 0, r: 0 }, s), 6, (s, t) => { if (Math.abs(t % 1) < DT / 2) out.push(`${t.toFixed(0)}s:${deg(eul(s).roll).toFixed(0)}°/${deg(eul(s).pitch).toFixed(0)}°`); });
  line('sticks centred from 60° bank (roll/pitch): ' + out.join('  '));
  const s2 = airStart(14, 100, 0.65);
  run(s2, (s) => FL.stabilize({ thr: 0.65, a: 1, e: 0, r: 0 }, s), 6);
  line(`full right stick held 6 s: bank ${deg(eul(s2).roll).toFixed(0)}° (target 45°), alt change ${(-s2.p[2] - 100).toFixed(1)} m`);
}

// 10) idle glide
line('\n== 10. Idle glide ==');
{
  const s = airStart(13, 150, 0);
  run(s, { thr: 0, a: 0, e: 0, r: 0 }, 30);
  line(`idle glide: V ${s.tele.V.toFixed(1)} m/s, sink ${s.v[2].toFixed(2)} m/s, L/D ${(Math.hypot(s.v[0], s.v[1]) / s.v[2]).toFixed(1)}`);
}

// 11) landing: hold ~1 m/s sink on approach, flare below 1.2 m, idle at touchdown
line('\n== 11. Landing ==');
{
  const s = airStart(13, 20, 0.35);
  s.p[1] = 0;
  let td = null;
  run(s, (s) => {
    const agl = -s.p[2] - 0.17;
    const vzt = agl > 1.2 ? 1.0 : 0.15 + 0.7 * agl;
    const e = FL.sat(0.03 + 0.35 * (s.v[2] - vzt) - 0.08 * s.w[1]);
    return { thr: agl > 1.2 ? 0.35 : 0, a: -0.6 * eul(s).roll, e, r: 0 };
  }, 40, (s, t) => { if (!td && s.wow) td = { vz: s.v[2], V: s.tele.V, pitch: deg(eul(s).pitch) }; });
  line(td ? `touchdown: sink ${td.vz.toFixed(2)} m/s, airspeed ${td.V.toFixed(1)} m/s, pitch ${td.pitch.toFixed(1)}°` : 'no touchdown');
  line(`rolled out: ground speed ${Math.hypot(s.v[0], s.v[1]).toFixed(2)} m/s, crashed ${s.crashed} ${s.crashMsg}`);
}

// 11b) hard arrival: 3 m drop onto the mains
line('\n== 11b. Dropped from 3 m ==');
{
  const s = FL.makeState(); FL.reset(s, ac, 'runway'); s.p[2] = -3;
  run(s, { thr: 0, a: 0, e: 0, r: 0 }, 2);
  line(`crashed ${s.crashed}: ${s.crashMsg}`);
}

// 12) density altitude
line('\n== 12. Atmosphere ==');
for (const [ft, f] of [[0, 59], [2800, 95], [5800, 85]]) {
  const a = FL.atmosphere(ft, f);
  line(`${ft} ft, ${f}°F: rho ${a.rho.toFixed(3)} kg/m³, density altitude ${a.daFt.toFixed(0)} ft (ISA temp ${a.isaTempF.toFixed(0)}°F)`);
}
