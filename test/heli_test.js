/* Helicopter bench tests. Run: node test/heli_test.js
   Prints numbers to compare with a real 450-class flybarless heli on 6S. */
const FL = require('../src/physics.js');
const ac = FL.build(FL.DEFS.heli);
const Ro = ac.rotor;
const DT = 1 / 400, deg = (r) => (r * 180) / Math.PI, rpm = (om) => (om * 60) / (2 * Math.PI);
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const line = (...a) => console.log(...a);
function run(s, ctl, secs, cb) {
  for (let i = 0, n = Math.round(secs / DT); i < n; i++) {
    const c = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    FL.step(s, ac, Object.assign({ armed: true, mode: 'acro', curve: 'normal' }, c), env, DT);
    if (cb && cb(s, i * DT) === false) break;
  }
}
const pad = () => { const s = FL.makeState(); FL.reset(s, ac, 'pad'); return s; };
const air = (alt = 30) => { const s = FL.makeState(); FL.reset(s, ac, 'air'); s.p[2] = -alt; return s; };
const H = ac.hoverThrCurve.normal;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

line(`450 heli: ${ac.mass * 1000} g, rotor ${(Ro.R * 2000).toFixed(0)} mm at ${rpm(Ro.om0).toFixed(0)} rpm (tip ${(Ro.om0 * Ro.R).toFixed(0)} m/s), solidity ${Ro.sigma.toFixed(3)}`);
line(`hover collective ${deg(ac.hoverPitch).toFixed(1)}°, stick ${(H * 100).toFixed(0)}% on the Normal curve, ${(ac.hoverThrCurve['3d'] * 100).toFixed(0)}% on 3D`);

{ const s = pad(); let tSpool = null;
  run(s, { thr: 0.2, a: 0, e: 0, r: 0 }, 8, (s, t) => { if (!tSpool && s.om > 0.95 * Ro.om0) tSpool = t; });
  line(`spool-up on the pad at low stick: 95% headspeed after ${tSpool === null ? '—' : tSpool.toFixed(1) + ' s'}, still on the skids: ${s.wow}, crashed ${s.crashed} ${s.crashMsg || ''}`); }

{ const s = air(20); let pw = 0;
  run(s, { thr: H, a: 0, e: 0, r: 0 }, 5, (s) => { pw = s.tele.Pm; });
  line(`hover stick for 5 s: altitude change ${(-s.p[2] - 20).toFixed(2)} m, drift ${Math.hypot(s.p[0] - 15, s.p[1]).toFixed(2)} m, heading ${deg(eul(s).yaw).toFixed(1)}°, rotor ${rpm(s.om).toFixed(0)} rpm, shaft power ${pw.toFixed(0)} W`); }

{ const s = air(20); let vmax = 0, omMin = 1e9;
  run(s, { thr: 1, a: 0, e: 0, r: 0 }, 2, (s) => { vmax = Math.max(vmax, -s.v[2]); omMin = Math.min(omMin, s.om); });
  line(`full collective (11°) for 2 s: peak climb ${vmax.toFixed(1)} m/s, headspeed dipped to ${rpm(omMin).toFixed(0)} rpm, power ${s.tele.Pm.toFixed(0)} W`); }

{ const s = air(); let t90 = null, pmax = 0;
  run(s, { thr: H, a: 1, e: 0, r: 0 }, 0.6, (s, t) => { pmax = Math.max(pmax, s.w[0]); if (!t90 && s.w[0] > 0.9 * 360 * FL.D2R) t90 = t; });
  line(`full right cyclic: 90% of 360°/s after ${t90 === null ? '—' : (t90 * 1000).toFixed(0) + ' ms'}, peak ${deg(pmax).toFixed(0)}°/s`); }

{ const s = air(); let rmax = 0; run(s, { thr: H, a: 0, e: 0, r: 1 }, 1.0, (s) => { rmax = Math.max(rmax, s.w[2]); });
  line(`full right pedal: peak ${deg(rmax).toFixed(0)}°/s (setpoint 600°/s)`); }

{ const s = air(); let yawMax = 0;
  run(s, (s, t) => ({ thr: t < 0.5 ? H : t < 1.0 ? 1 : H, a: 0, e: 0, r: 0 }), 2, (s) => { yawMax = Math.max(yawMax, Math.abs(s.w[2])); });
  line(`collective punch with sticks centred: tail held heading to within ${deg(yawMax).toFixed(1)}°/s yaw rate`); }

{ const rows = [];
  for (const e of [-0.3, -0.6, -1]) {
    const s = air(200); run(s, { thr: H * 1.05, a: 0, e, r: 0, mode: 'angle' }, 10);
    rows.push(`${(-e * 55).toFixed(0)}° nose down: ${(s.tele.V * 3.6).toFixed(0)} km/h, climb ${(-s.v[2]).toFixed(1)} m/s`);
  }
  line('forward flight at hover collective +5%:  ' + rows.join(' | ')); }

{ // power required vs airspeed at constant height: speed held with pitch, height with collective
  const rows = [];
  for (const V of [0, 4, 8, 12, 16, 20]) {
    const s = air(100); let iz = 0, ix = 0, P = 0, n = 0, th = 0;
    run(s, (s, t) => {
      const R = FL.quatToMat(s.q), u = s.v[0], ez = -s.p[2] - 100;
      iz += ez * DT; ix += (V - u) * DT;
      return { thr: H + 0.002 * (-15 * ez - 25 * iz + 30 * s.v[2]) * 10, a: 0, e: -(0.04 * (V - u) + 0.01 * ix) - 0.0045 * V, r: 0, mode: 'angle' };
    }, 20, (s, t) => { if (t > 14) { P += s.tele.Pm; th += s.coll; n++; } });
    rows.push(`${(V * 3.6).toFixed(0)} km/h ${(P / n).toFixed(0)} W @ ${deg(th / n).toFixed(1)}°`);
  }
  line('level-flight power (translational lift makes 15–45 km/h cheaper than hovering):  ' + rows.join(' | ')); }

{ // autorotation: throttle hold at 80 m, collective to the bottom, glide at ~12 m/s, flare at 8 m, cushion at 1.5 m
  const s = air(80); s.v = [12, 0, 0]; let ph = 'glide', g = null, omFlare = 0, td = null;
  run(s, (s, t) => {
    const h = -s.p[2];
    if (ph === 'glide' && h < 8) { ph = 'flare'; omFlare = s.om; }
    if (ph === 'flare' && (s.v[0] < 2 || h < 1.5)) ph = 'cushion';
    if (ph === 'glide') return { thr: 0, a: 0, e: -0.12, r: 0, hold: true, mode: 'angle' };
    if (ph === 'flare') return { thr: 0.2, a: 0, e: 0.45, r: 0, hold: true, mode: 'angle' };
    return { thr: clamp01(0.5 + 0.35 * (s.v[2] - 0.5)), a: 0, e: 0.03, r: 0, hold: true, mode: 'angle' };
  }, 40, (s, t) => {
    if (!g && t > 8) g = { vz: s.v[2], vx: s.v[0], om: s.om };
    if (s.wow) { td = { v: s.v[2], vh: Math.hypot(s.v[0], s.v[1]), om: s.om }; return false; }
  });
  line(`autorotation from 80 m (hold, −4° collective): glide ${g.vx.toFixed(1)} m/s forward, ${g.vz.toFixed(1)} m/s down at ${rpm(g.om).toFixed(0)} rpm (${((100 * g.om) / Ro.om0).toFixed(0)}%); flare at 8 m; touchdown ${td.v.toFixed(2)} m/s down, ${td.vh.toFixed(1)} m/s forward, rotor ${rpm(td.om).toFixed(0)} rpm — ${s.crashed ? s.crashMsg : 'landed'}`); }

{ const s = air(60); let minOm = 1e9, msg = '';
  run(s, { thr: H, a: 0, e: 0, r: 0, hold: true }, 6, (s) => { minOm = Math.min(minOm, s.om); if (s.crashed) { msg = s.crashMsg; return false; } });
  line(`throttle hold but collective left at hover pitch: headspeed decays to ${rpm(minOm).toFixed(0)} rpm — ${msg || 'no crash'}`); }

{ const s = air(40); let vrsMax = 0, shake = 0;
  run(s, (s, t) => ({ thr: t < 2 ? H * 0.5 : H * 1.2, a: 0, e: 0, r: 0, mode: 'angle' }), 5, (s, t) => {
    vrsMax = Math.max(vrsMax, s.tele.vrs);
    if (t > 2) shake = Math.max(shake, Math.hypot(s.w[0], s.w[1]));
  });
  line(`vertical descent into own downwash then power on: peak vortex-ring ${(vrsMax * 100).toFixed(0)}%, wobble ${deg(shake).toFixed(0)}°/s`); }

{ const s = air(3); let td = null;
  run(s, { thr: H * 0.9, a: 0, e: 0, r: 0, mode: 'angle' }, 8, (s) => { if (!td && s.wow) td = s.v[2]; });
  line(`gentle landing: touchdown ${td === null ? '—' : td.toFixed(2) + ' m/s'}, crashed ${s.crashed} ${s.crashMsg || ''}`); }

{ const s = air(0.7); s.q = FL.quatFromEuler(70 * FL.D2R, 0, 0); let msg = '';
  run(s, { thr: H * 0.5, a: 0, e: 0, r: 0 }, 4, (s) => { if (s.crashed) { msg = s.crashMsg; return false; } });
  line(`rolled 70° just above the grass: ${msg || 'no crash'}`); }

{ const t0 = process.hrtime.bigint(); const s = air(); run(s, { thr: 0.5, a: 0.3, e: 0.2, r: 0.1 }, 10);
  line(`CPU: ${(Number(process.hrtime.bigint() - t0) / 1e6 / 10).toFixed(2)} ms per simulated second`); }
