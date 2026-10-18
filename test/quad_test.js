/* Quad bench tests. Run: node test/quad_test.js [quad|lr4|q7|q13]
   Prints numbers to compare with the real thing. */
const FL = require('../src/physics.js');
const id = process.argv[2] || 'quad';
const ac = FL.build(FL.DEFS[id]);
const RM = ac.rates.roll.m, YM = ac.rates.yaw.m, cells = ac.batt.cells;
const DT = 1 / 400, deg = (r) => (r * 180) / Math.PI, mph = (v) => v * 2.23694;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const line = (...a) => console.log(...a);
function run(s, ctl, secs, cb) {
  for (let i = 0, n = Math.round(secs / DT); i < n; i++) {
    const c = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    FL.step(s, ac, Object.assign({ armed: true, mode: 'acro' }, c), env, DT);
    if (cb && cb(s, i * DT) === false) break;
  }
}
const pad = () => { const s = FL.makeState(); FL.reset(s, ac, 'pad'); return s; };
const air = (alt = 30) => { const s = FL.makeState(); FL.reset(s, ac, 'air'); s.p[2] = -alt; return s; };
const H = ac.hoverThr;

line(`${ac.name}: ${ac.mass * 1000} g, ${ac.batt.label}, thrust/weight ${((4 * ac.motor.Tmax) / (ac.mass * 9.81)).toFixed(1)}:1, hover throttle ${(H * 100).toFixed(0)}%`);

{ const s = pad(); const p0 = s.p.slice(); run(s, { thr: 0, a: 0, e: 0, r: 0 }, 3);
  line(`armed on the pad at zero throttle, 3 s: moved ${Math.hypot(s.p[0] - p0[0], s.p[1] - p0[1]).toFixed(3)} m, height ${(-s.p[2]).toFixed(3)} m, motors ${(s.n * 100).toFixed(0)}%, crashed ${s.crashed}`); }

{ const s = air(20); run(s, { thr: H, a: 0, e: 0, r: 0 }, 5);
  line(`hover stick at ${(H * 100).toFixed(0)}% for 5 s: altitude change ${(-s.p[2] - 20).toFixed(2)} m, drift ${Math.hypot(s.p[0] - 15, s.p[1]).toFixed(2)} m`); }

{ const s = pad(); let vmax = 0; run(s, { thr: 1, a: 0, e: 0, r: 0 }, 1.5, (s) => { vmax = Math.max(vmax, -s.v[2]); });
  line(`punch-out from the pad, full throttle 1.5 s: ${(-s.p[2]).toFixed(1)} m up, peak climb ${vmax.toFixed(1)} m/s (${mph(vmax).toFixed(0)} mph), crashed ${s.crashed}`); }

{ const s = air(); let t90 = null, pmax = 0, ang = 0, tFlip = null;
  run(s, { thr: H * 1.4, a: 1, e: 0, r: 0 }, 2.0, (s, t) => {
    pmax = Math.max(pmax, s.w[0]); ang += s.w[0] * DT;
    if (!t90 && s.w[0] > 0.9 * RM * FL.D2R) t90 = t;
    if (!tFlip && ang >= 2 * Math.PI) tFlip = t;
  });
  line(`full right roll from hover: 90% of ${RM}°/s after ${t90 === null ? '—' : (t90 * 1000).toFixed(0) + ' ms'}, peak ${deg(pmax).toFixed(0)}°/s, a full roll in ${tFlip === null ? '—' : (tFlip * 1000).toFixed(0) + ' ms'}`); }

{ const s = air(); const tr = [];
  run(s, { thr: 0.45, a: 0.4, e: 0, r: 0 }, 0.6, (s, t) => { if (Math.abs(t % 0.05) < DT / 2) tr.push(deg(s.w[0]).toFixed(0)); });
  const sp = FL.actualRate(0.4, ac.rates.roll);
  line(`40% roll stick (setpoint ${sp.toFixed(0)}°/s), every 50 ms: ${tr.join(' ')}`); }

{ const s = air(); let rmax = 0; run(s, { thr: H, a: 0, e: 0, r: 1 }, 1.0, (s) => { rmax = Math.max(rmax, s.w[2]); });
  line(`full right yaw: peak ${deg(rmax).toFixed(0)}°/s (setpoint ${YM}°/s; yaw is torque-limited on a quad)`); }

{ const keep = ac.angle.max; ac.angle.max = 85; const rows = [];
  for (const pitch of [40, 55, 65, 75]) {
    const s = air(400);
    run(s, { thr: 1, a: 0, e: -pitch / 85, r: 0, mode: 'angle' }, 8);
    rows.push(`${pitch}°: ${(s.tele.V * 3.6).toFixed(0)} km/h (${mph(s.tele.V).toFixed(0)} mph), climbing ${(-s.v[2]).toFixed(1)} m/s`);
  }
  ac.angle.max = keep;
  line('full throttle, nose held down at:  ' + rows.join(' | ')); }

{ // zero throttle: the dive is ballistic, the brake is attitude. Terminal nose-first,
  // flat-fall sink, and how hard a level-off actually slows you down.
  const s = air(3000); s.q = FL.quatFromEuler(0, -Math.PI / 2 + 0.001, 0); s.v = [0, 0, 10];
  run(s, { thr: 0, a: 0, e: 0, r: 0 }, 20);
  line(`zero-throttle vertical dive, 20 s: terminal ${(s.tele.V * 3.6).toFixed(0)} km/h (${mph(s.tele.V).toFixed(0)} mph)`);
  const vt = Math.sqrt((2 * ac.mass * 9.81) / (1.225 * ac.body.CdA[0]));
  line(`   (closed form √(2mg/ρ·CdA_front) = ${(vt * 3.6).toFixed(0)} km/h; real 5-inch dives measure 180–200)`);
  const s2 = air(800);
  run(s2, { thr: 1, a: 0, e: 1, r: 0, mode: 'angle', lim: { bank: 55, pitch: 55, tBank: 60, tPitch: 60 } }, 12);
  const v0 = s2.tele.V, marks = [];
  run(s2, { thr: 0, a: 0, e: 0, r: 0, mode: 'angle', lim: { bank: 55, pitch: 55, tBank: 60, tPitch: 60 } }, 4,
    (st, t) => { if (Math.abs(t % 1) < DT / 2) marks.push(`${(Math.hypot(st.v[0], st.v[1]) * 3.6).toFixed(0)}`); });
  line(`chop to zero and level off from ${(v0 * 3.6).toFixed(0)} km/h: horizontal speed each second ${marks.join(' → ')} km/h (sink builds to ${s2.v[2].toFixed(0)} m/s — total V stays up because it is falling)`); }

{ const s = air(); s.q = FL.quatFromEuler(30 * FL.D2R, 0, 0); const tr = [];
  run(s, { thr: H / Math.cos(0.5), a: 0, e: 0, r: 0, mode: 'angle' }, 1.0, (s, t) => { if (Math.abs(t % 0.2) < DT / 2) tr.push(deg(eul(s).roll).toFixed(1)); });
  line(`angle mode, sticks centred from 30° bank, every 200 ms: ${tr.join(' ')}°`); }

{ const s = air(60); let maxShake = 0, minVz = 0;
  run(s, (s, t) => ({ thr: t < 2.5 ? 0.02 : H * 1.3, a: 0, e: 0, r: 0 }), 4.5, (s, t) => {
    minVz = Math.max(minVz, s.v[2]);
    if (t > 2.5) maxShake = Math.max(maxShake, Math.hypot(s.w[0], s.w[1]));
  });
  line(`drop straight down at idle (peak sink ${minVz.toFixed(1)} m/s), then power up into the wash: peak wobble ${deg(maxShake).toFixed(0)}°/s, wash ${s.tele.wash.toFixed(2)}`); }

{ const s = air(40); s.q = FL.quatFromEuler(Math.PI, 0, 0); let msg = '';
  run(s, { thr: 0, a: 0, e: 0, r: 0, armed: false }, 5, (s) => { if (s.crashed) { msg = s.crashMsg; return false; } });
  line(`disarmed and inverted from 40 m: ${msg || 'no crash'}`); }

{ const s = air(3); let td = null;
  run(s, (s) => ({ thr: H * 0.85, a: 0, e: 0, r: 0 }), 6, (s) => { if (!td && s.wow) td = s.v[2]; });
  line(`gentle descent onto the ground: touchdown ${td === null ? '—' : td.toFixed(2) + ' m/s'}, crashed ${s.crashed} ${s.crashMsg}`); }

{ // battery: punch-out sag on a full pack, and hover / cruise current and flight time
  const envB = Object.assign({}, env, { battery: true, wx: { T: 20, lwc: 0, mvd: 0, rain: 0 } });
  const runB = (s, ctl, secs, cb) => { for (let i = 0, n = Math.round(secs / DT); i < n; i++) { FL.step(s, ac, Object.assign({ armed: true, mode: 'acro' }, typeof ctl === 'function' ? ctl(s) : ctl), envB, DT); if (cb) cb(s); } };
  { const s = FL.makeState(); FL.reset(s, ac, 'pad', 20); let vmin = 99, imax = 0, vz = 0;
    runB(s, { thr: 1, a: 0, e: 0, r: 0 }, 2, (s) => { if (s.t > 0.1) vmin = Math.min(vmin, s.vb / cells); imax = Math.max(imax, s.I); vz = Math.max(vz, -s.v[2]); });
    line(`full-throttle punch on a full pack at 20°C: ${imax.toFixed(0)} A peak, sags to ${vmin.toFixed(2)} V/cell, peak climb ${vz.toFixed(1)} m/s`); }
  { const s = FL.makeState(); FL.reset(s, ac, 'air', 20); s.p[2] = -30; let iz = 0, I = 0, n = 0;
    runB(s, (s) => { const ez = -s.p[2] - 30; iz += ez * DT; return { thr: Math.min(1, Math.max(0, H - 0.03 * ez - 0.01 * iz + 0.02 * s.v[2])), a: 0, e: 0, r: 0, mode: 'angle' }; }, 20, (s) => { if (s.t > 5) { I += s.I; n++; } });
    const Ih = I / n; line(`hover: ${Ih.toFixed(1)} A (${(Ih * cells * 3.7).toFixed(0)} W) → ${((ac.batt.mAh * 0.8) / 1000 / Ih * 60).toFixed(0)} min to 80% of the pack`); }
  { const s = FL.makeState(); FL.reset(s, ac, 'air', 20); s.p[2] = -60; let iz = 0, I = 0, n = 0, V = 0;
    runB(s, (s) => { const ez = -s.p[2] - 60; iz += ez * DT; return { thr: Math.min(1, Math.max(0, H * 1.25 - 0.03 * ez - 0.01 * iz + 0.02 * s.v[2])), a: 0, e: -0.35, r: 0, mode: 'angle' }; }, 25, (s) => { if (s.t > 10) { I += s.I; V += s.tele.V; n++; } });
    const Ic = I / n; line(`cruise at ${Math.round((0.35 * 55))}° nose down: ${(V / n * 3.6).toFixed(0)} km/h on ${Ic.toFixed(1)} A → ${((ac.batt.mAh * 0.8) / 1000 / Ic * 60).toFixed(0)} min, ${((ac.batt.mAh * 0.8) / 1000 / Ic * V / n * 3.6).toFixed(1)} km`); }
}

{ const t0 = process.hrtime.bigint(); const s = air(); run(s, { thr: 0.5, a: 0.3, e: 0.2, r: 0.1 }, 10);
  line(`CPU: ${(Number(process.hrtime.bigint() - t0) / 1e6 / 10).toFixed(2)} ms per simulated second`); }
