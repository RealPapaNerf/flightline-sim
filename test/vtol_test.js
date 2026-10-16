/* Tail-sitter bench. Run: node test/vtol_test.js [file.json]
   Defaults to aircraft/speed-tailsitter.json. Prints numbers to compare with
   the real thing; exits non-zero only if it cannot do the things a tail-sitter
   has to be able to do. */
const fs = require('fs');
const path = require('path');
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');

const file = process.argv[2] || path.join(__dirname, '..', 'aircraft', 'speed-tailsitter.json');
const read = ACF.read(fs.readFileSync(file, 'utf8'));
if (!read.ok) { console.error(file + ': ' + read.errors.join('; ')); process.exit(1); }
const ac = FL.build(read.def);
if (ac.kind !== 'vtol') { console.error('not a tail-sitter: ' + ac.kind); process.exit(1); }

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };
const DT = 1 / 500, deg = (r) => (r * 180) / Math.PI, kmh = (v) => v * 3.6, mph = (v) => v * 2.23694;
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const H = ac.hoverThr, W = ac.mass * FL.G;
const envOf = (drain) => ({ rho: 1.225, wind: [0, 0, 0], battery: drain, crashes: true, wx: { T: 20, lwc: 0, mvd: 0, rain: 0 } });
function fly(s, ctl, secs, env, cb) {
  for (let i = 0, n = Math.round(secs / DT); i < n; i++) {
    const c = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    FL.step(s, ac, Object.assign({ armed: true, a: 0, e: 0, r: 0, fwd: 0, mode: 'angle', lim: { bank: 45, pitch: 45 } }, c), env, DT);
    if (cb && cb(s, i * DT) === false) break;
  }
}
const pad = (env) => { const s = FL.makeState(); FL.reset(s, ac, 'pad', 20); return s; };
// a pilot who holds a height with the throttle, which is all a hover needs
const holder = (tgt) => { let iz = 0; return (s) => { const ez = -s.p[2] - tgt; iz = FL.clamp(iz + ez * DT, -20, 20); return FL.clamp(H - 0.05 * ez - 0.01 * iz + 0.03 * s.v[2], 0, 1); }; };

console.log(`${ac.name}  (${path.basename(file)})`);
console.log(`  ${(ac.mass * 1000).toFixed(0)} g, ${ac.batt.label}, four ${(ac.motor.D / 0.0254).toFixed(1)}-inch props`);
console.log(`  wing area ${(ac.S * 1e4).toFixed(0)} cm² over ${ac.strips.length} strips, span ${(ac.b * 1000).toFixed(0)} mm, static margin ${(ac.SM * 100).toFixed(1)}% MAC`);
console.log(`  thrust to weight ${((4 * ac.motor.Tmax) / W).toFixed(1)} : 1, hover stick ${(H * 100).toFixed(0)}%, pitch speed ${ac.motor.Vp} m/s (${kmh(ac.motor.Vp).toFixed(0)} km/h)`);
console.log(`  transition takes ${ac.trans.time} s and it cruises at ${deg(ac.trans.pitch).toFixed(1)}° nose-up\n`);

console.log('== on its tail ==');
{ const s = pad(); const p0 = s.p.slice();
  fly(s, { thr: 0 }, 3, envOf(false));
  ok(!s.crashed && Math.hypot(s.p[0] - p0[0], s.p[1] - p0[1]) < 0.05,
    'stands on the pad, armed, at zero throttle', `pitch ${deg(eul(s).pitch).toFixed(1)}°, moved ${(Math.hypot(s.p[0] - p0[0], s.p[1] - p0[1]) * 1000).toFixed(0)} mm`); }

{ const s = pad(); let top = 0;
  fly(s, { thr: 1 }, 2, envOf(true), (st) => { top = Math.max(top, -st.v[2]); });
  ok(-s.p[2] > 20, 'leaves the pad at full throttle', `${(-s.p[2]).toFixed(0)} m up in 2 s, peak climb ${top.toFixed(0)} m/s (${kmh(top).toFixed(0)} km/h)`); }

{ // hold a hover at 30 m and see how far it wanders
  const s = pad(); const thr = holder(30); let drift = 0, alt = [];
  fly(s, (st) => ({ thr: thr(st) }), 25, envOf(true), (st, t) => {
    if (t > 8) { drift = Math.max(drift, Math.hypot(st.p[0] - 8, st.p[1] - 1.5)); alt.push(-st.p[2]); }
  });
  const lo = Math.min(...alt), hi = Math.max(...alt);
  ok(!s.crashed && Math.abs(-s.p[2] - 30) < 3, 'holds a hover in Angle mode',
    `height ${lo.toFixed(1)}–${hi.toFixed(1)} m, wandered ${drift.toFixed(1)} m, ${s.I.toFixed(0)} A, pack ${(s.soc * 100).toFixed(0)}%`);
  const Ih = s.I;
  console.log(`      hover costs ${Ih.toFixed(0)} A (${(Ih * s.vb / 1000).toFixed(1)} kW) → ${((ac.batt.mAh * 0.8) / 1000 / Ih * 60).toFixed(1)} min of hovering`); }

console.log('\n== transition and run ==');
{ const s = pad(); const thr = holder(80); let tDone = null, vAt = [], minAlt = 1e9;
  fly(s, (st, t) => (t < 10 ? { thr: thr(st), fwd: 0 } : { thr: 1, fwd: 1 }), 50, envOf(true), (st, t) => {
    if (t > 10) {
      if (tDone === null && st.fwd > 0.999) tDone = t - 10;
      minAlt = Math.min(minAlt, -st.p[2]);
      if (Math.abs((t - 10) % 5) < DT / 2) vAt.push(`${(t - 10).toFixed(0)}s ${kmh(st.tele.V).toFixed(0)}`);
    }
  });
  ok(tDone !== null, 'transitions to forward flight', `nose over in ${tDone ? tDone.toFixed(1) : '—'} s, lost ${(80 - minAlt) > 0 ? (80 - minAlt).toFixed(0) + ' m' : 'no'} height`);
  console.log(`      km/h at t+: ${vAt.join('  ')}`);
  ok(!s.crashed, 'and keeps flying', `${kmh(s.tele.V).toFixed(0)} km/h (${mph(s.tele.V).toFixed(0)} mph) at α ${deg(s.tele.alpha).toFixed(1)}°, ${(-s.p[2]).toFixed(0)} m up, pack ${(s.soc * 100).toFixed(0)}% after ${s.t.toFixed(0)} s`); }

{ // top speed in level flight, on a pack that does not drain and one that does
  const run = (drain) => {
    const s = FL.makeState();
    FL.reset(s, ac, 'air', 20);
    s.p[2] = -300;
    let v = 0;
    fly(s, (st) => ({ thr: 1, fwd: 1, e: FL.clamp(-0.02 * (-st.p[2] - 300) - 0.04 * st.v[2], -0.4, 0.4), mode: 'angle', lim: { bank: 45, pitch: 20 } }), 60, envOf(drain), (st) => { v = Math.max(v, st.tele.V); });
    return { v, end: s.tele.V, soc: s.soc, I: s.I };
  };
  const full = run(false), real = run(true);
  console.log(`  top speed, pack held full:   ${kmh(full.v).toFixed(0)} km/h (${mph(full.v).toFixed(0)} mph)`);
  console.log(`  top speed, pack draining:    ${kmh(real.v).toFixed(0)} km/h (${mph(real.v).toFixed(0)} mph) peak, ${kmh(real.end).toFixed(0)} km/h after 60 s at ${(real.soc * 100).toFixed(0)}% pack and ${real.I.toFixed(0)} A`);
  console.log('  the Peregreen V4 holds the Guinness record at 657.59 km/h (408.60 mph), a two-run average');
  ok(full.v > 0.8 * (ac.motor.Vp * 0.75), 'reaches the speed its pitch speed and drag allow', `${(full.v / ac.motor.Vp * 100).toFixed(0)}% of the pitch speed`); }

console.log('\n== back to a hover, and down ==');
{ const s = FL.makeState();
  FL.reset(s, ac, 'air', 20);
  s.p = [0, 0, -60];
  let vMin = 1e9, back = null;
  const thr = holder(60);
  fly(s, (st, t) => (t < 3 ? { thr: 1, fwd: 1 } : { thr: thr(st), fwd: 0 }), 45, envOf(true), (st, t) => {
    if (t > 3) { vMin = Math.min(vMin, st.tele.V); if (back === null && st.fwd < 0.001 && st.tele.V < 5) back = t - 3; }
  });
  ok(back !== null, 'stops and goes back to a hover', back !== null ? `slowed to under 5 m/s ${back.toFixed(0)} s after the command, now ${kmh(s.tele.V).toFixed(0)} km/h at ${(-s.p[2]).toFixed(0)} m` : `slowest ${kmh(vMin).toFixed(0)} km/h`);
  // and land it: come down at 2 m/s, slowing to walking pace near the ground
  let td = null, iz = 0;
  fly(s, (st) => {
    const agl = -st.p[2], want = Math.min(2.5, 0.3 * agl + 0.2); // 2.5 m/s down, easing off near the ground
    const err = st.v[2] - want;                                   // v[2] > 0 is going down
    iz = FL.clamp(iz + err * DT * 0.5, -0.25, 0.25);
    return { thr: FL.clamp(H + 0.05 * err + iz, 0, 1) };
  }, 90, envOf(true), (st) => { if (td === null && st.wow) td = st.v[2]; return td === null; });
  ok(td !== null && !s.crashed, 'lands back on its tail', td === null ? 'never touched down' : `touchdown at ${td.toFixed(2)} m/s, crashed ${s.crashed} ${s.crashMsg}`); }

{ const t0 = process.hrtime.bigint();
  const s = pad(); fly(s, { thr: 0.6, a: 0.2, e: 0.1, r: 0.05 }, 10, envOf(true));
  console.log(`\nCPU: ${(Number(process.hrtime.bigint() - t0) / 1e6 / 10).toFixed(2)} ms per simulated second (${ac.strips.length} strips, 4 motors)`); }

console.log(`\n${fails ? fails + ' CHECK(S) FAILED' : 'all checks passed'}`);
process.exit(fails ? 1 : 0);
