/* Flight-model bench tests. Run: node test/fm_test.js [goblin|trainer]
   Prints numbers to compare against real-world expectations; it does not
   assert, because "realistic" is a judgement — read the output. */
const FL = require('../src/physics.js');
const DT = 1 / 400;
const deg = (r) => (r * 180) / Math.PI;
const mph = (v) => v * 2.23694;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const line = (...a) => console.log(...a);
const which = process.argv[2] || 'all';

function airStart(ac, V, alt, thr, roll = 0, pitch = 0) {
  const s = FL.makeState();
  FL.reset(s, ac, 'air');
  s.p = [0, 0, -alt];
  s.q = FL.quatFromEuler(roll, pitch, 0);
  s.v = FL.mulMV(FL.quatToMat(s.q), [V, 0, 0]);
  s.n = thr;
  return s;
}
function run(s, ac, ctl, secs, cb) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    const c0 = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    const c = { thr: c0.thr, a: FL.sat(c0.a + ac.trim.a), e: FL.sat(c0.e + ac.trim.e), r: c0.r };
    FL.step(s, ac, c, env, DT);
    if (cb && cb(s, i * DT) === false) break;
  }
}
// find the elevator that holds level flight at a given throttle (simple pilot)
function trimLevel(ac, thr, V0, secs = 40) {
  const s = airStart(ac, V0, 100, thr);
  let eI = 0;
  run(s, ac, (s) => {
    const climb = -s.v[2];
    eI += -0.4 * climb * DT;
    eI = FL.clamp(eI, -1, 1);
    return { thr, a: FL.sat(-1.5 * eul(s).roll - 0.1 * s.w[0]), e: FL.sat(eI - 0.3 * climb - 0.05 * s.w[1]), r: 0 };
  }, secs);
  return { V: s.tele.V, e: eI, alpha: s.tele.alpha, climb: -s.v[2] };
}

function suite(id) {
  const ac = FL.build(FL.DEFS[id]);
  line(`\n################  ${ac.name}  ################`);
  line(`wing area ${ac.S.toFixed(4)} m² (${(ac.S * 1550).toFixed(0)} in²), span ${ac.b} m, AR ${ac.ARw.toFixed(2)}, MAC ${ac.mac.toFixed(3)} m, ` +
    `wing loading ${((ac.mass * 1000) / (ac.S * 100)).toFixed(1)} g/dm², static margin ${(ac.SM * 100).toFixed(1)}% MAC, CG shift ${ac.xShift.toFixed(3)} m`);
  line('wing strips (right side): y, chord, load factor, local stall angle, flap τ:');
  for (const st of ac.strips.filter((x) => x.role === 'wing' && x.side > 0))
    line(`   y ${st.y.toFixed(3)}  c ${st.chord.toFixed(3)}  load ${st.load.toFixed(2)}  stall ${deg(st.aS).toFixed(1)}°  ${st.tau ? 'flap τ ' + st.tau.toFixed(2) + ' (cf ' + st.cf.toFixed(2) + ')' : ''}`);

  line('\n== Hands-off (sticks centred) ==');
  for (const thr of id === 'goblin' ? [0.4, 0.53, 0.65] : [0.5, 0.58, 0.7]) {
    const s = airStart(ac, id === 'goblin' ? 18 : 14, 100, thr);
    let lo = 99, hi = 0;
    run(s, ac, { thr, a: 0, e: 0, r: 0 }, 40, (s, t) => { if (t > 25) { lo = Math.min(lo, s.tele.V); hi = Math.max(hi, s.tele.V); } });
    const e = eul(s);
    line(`thr ${thr}: V ${s.tele.V.toFixed(1)} m/s (${mph(s.tele.V).toFixed(0)} mph, swing ${lo.toFixed(1)}–${hi.toFixed(1)}), climb ${(-s.v[2]).toFixed(2)} m/s, α ${deg(s.tele.alpha).toFixed(1)}°, pitch ${deg(e.pitch).toFixed(1)}°, roll ${deg(e.roll).toFixed(1)}°`);
  }

  line('\n== 1-g stall: idle, wings held level, elevator fed in slowly, then held full up ==');
  {
    const s = airStart(ac, id === 'goblin' ? 16 : 13, 150, 0);
    let first = null; const tl = [];
    run(s, ac, (s, t) => ({ thr: 0, a: first ? 0 : FL.sat(-0.8 * eul(s).roll - 0.05 * s.w[0]), e: Math.min(1, t / 12), r: 0 }), 18, (s, t) => {
      const sf = Math.max(s.tele.stallL, s.tele.stallR);
      if (!first && sf > 0.3) first = { t, V: s.tele.V, side: s.tele.stallL > s.tele.stallR ? 'left' : 'right', L: s.tele.stallL, R: s.tele.stallR, e: Math.min(1, t / 12) };
      if (first && Math.abs((t - first.t) / 0.5 - Math.round((t - first.t) / 0.5)) < DT && t - first.t <= 4.01)
        tl.push(`+${(t - first.t).toFixed(1)}s V${s.tele.V.toFixed(1)} pitch${deg(eul(s).pitch).toFixed(0)}° roll${deg(eul(s).roll).toFixed(0)}° sink${s.v[2].toFixed(1)} stall L${(s.tele.stallL * 100).toFixed(0)}/R${(s.tele.stallR * 100).toFixed(0)}`);
    });
    if (first) line(`stall began at ${first.V.toFixed(1)} m/s (${mph(first.V).toFixed(0)} mph) with ${(first.e * 100).toFixed(0)}% up elevator`);
    for (const l of tl) line('   ' + l);
  }

  line('\n== Accelerated stall: full up elevator at speed ==');
  for (const V of id === 'goblin' ? [20, 30] : [14, 20]) {
    const s = airStart(ac, V, 150, 0.5);
    let nzMax = 0, stalled = null;
    run(s, ac, { thr: 0.5, a: 0, e: 1, r: 0 }, 1.5, (s, t) => { nzMax = Math.max(nzMax, s.tele.nz); if (!stalled && Math.max(s.tele.stallL, s.tele.stallR) > 0.5) stalled = { t, V: s.tele.V, nz: s.tele.nz }; });
    line(`at ${V} m/s (${mph(V).toFixed(0)} mph): peak load ${nzMax.toFixed(1)} g; ` + (stalled ? `wing stalled at ${stalled.V.toFixed(1)} m/s pulling ${stalled.nz.toFixed(1)} g` : 'wing did not stall (elevator authority limit)'));
  }

  line('\n== Stall in a 45° bank (pulling to hold altitude, slowing) ==');
  {
    const s = airStart(ac, id === 'goblin' ? 17 : 13, 150, 0.15, 45 * FL.D2R);
    let ev = null;
    run(s, ac, (s, t) => {
      const e = eul(s);
      return { thr: 0.15, a: FL.sat(1.5 * (45 * FL.D2R - e.roll) - 0.1 * s.w[0]), e: Math.min(1, 0.2 + t / 10), r: 0 };
    }, 12, (s, t) => {
      if (!ev && Math.max(s.tele.stallL, s.tele.stallR) > 0.4) ev = { t, V: s.tele.V, L: s.tele.stallL, R: s.tele.stallR, roll0: deg(eul(s).roll) };
      if (ev && t > ev.t + 1.0) { ev.roll1 = deg(eul(s).roll); ev.pitch1 = deg(eul(s).pitch); return false; }
    });
    if (ev) line(`stalled at ${ev.V.toFixed(1)} m/s, bank ${ev.roll0.toFixed(0)}°; stalled area L ${(ev.L * 100).toFixed(0)}% / R ${(ev.R * 100).toFixed(0)}% (right = inside wing); 1 s later bank ${ev.roll1.toFixed(0)}°, pitch ${ev.pitch1.toFixed(0)}°`);
    else line('no stall reached');
  }

  line(id === 'goblin' ? '\n== Spin attempt: idle, full up + full right roll at the stall, held 6 s ==' : '\n== Spin: idle, full up + full right rudder at the stall, held 6 s ==');
  {
    const s = airStart(ac, id === 'goblin' ? 9 : 9, 300, 0);
    let rmax = 0, turns = 0, lastYaw = eul(s).yaw, alt0 = -s.p[2];
    run(s, ac, id === 'goblin' ? { thr: 0, a: 1, e: 1, r: 0 } : { thr: 0, a: 0, e: 1, r: 1 }, 6, (s) => {
      const y = eul(s).yaw; let dy = y - lastYaw; if (dy > Math.PI) dy -= 2 * Math.PI; if (dy < -Math.PI) dy += 2 * Math.PI; turns += dy / (2 * Math.PI); lastYaw = y;
      rmax = Math.max(rmax, Math.abs(s.w[2]));
    });
    line(`heading turns ${turns.toFixed(1)}, peak yaw rate ${deg(rmax).toFixed(0)}°/s, height lost ${(alt0 + s.p[2]).toFixed(0)} m, V ${s.tele.V.toFixed(1)} m/s, wing stalled L ${(s.tele.stallL * 100).toFixed(0)}% R ${(s.tele.stallR * 100).toFixed(0)}%`);
    // recovery: neutral controls
    let rec = null;
    run(s, ac, { thr: 0, a: 0, e: 0, r: 0 }, 8, (s, t) => { if (!rec && Math.abs(s.w[2]) < 20 * FL.D2R && Math.abs(s.w[0]) < 30 * FL.D2R && Math.max(s.tele.stallL, s.tele.stallR) < 0.1) rec = { t, loss: alt0 + s.p[2] }; });
    line(rec ? `released: recovered in ${rec.t.toFixed(1)} s, total height lost ${rec.loss.toFixed(0)} m` : 'released: still rotating after 8 s');
  }

  line('\n== Roll rate (full aileron/elevon roll) ==');
  for (const V of id === 'goblin' ? [12, 20, 28] : [10, 15]) {
    const s = airStart(ac, V, 100, 0.5);
    let pmax = 0;
    run(s, ac, { thr: 0.5, a: 1, e: 0, r: 0 }, 1.0, (s) => { pmax = Math.max(pmax, s.w[0]); });
    line(`${V} m/s: ${deg(pmax).toFixed(0)}°/s`);
  }

  line('\n== Idle glide ==');
  {
    const s = airStart(ac, id === 'goblin' ? 16 : 13, 200, 0);
    run(s, ac, { thr: 0, a: 0, e: 0, r: 0 }, 40);
    line(`V ${s.tele.V.toFixed(1)} m/s (${mph(s.tele.V).toFixed(0)} mph), sink ${s.v[2].toFixed(2)} m/s, L/D ${(Math.hypot(s.v[0], s.v[1]) / s.v[2]).toFixed(1)}`);
  }

  if (id === 'goblin') {
    line('\n== Hand launch, full throttle, hands off ==');
    const s = FL.makeState(); FL.reset(s, ac, 'launch');
    run(s, ac, { thr: 1, a: 0, e: 0, r: 0 }, 0.3);
    FL.launch(s);
    let minAlt = 9, maxSt = 0;
    run(s, ac, { thr: 1, a: 0, e: 0, r: 0 }, 5, (s) => { minAlt = Math.min(minAlt, -s.p[2]); maxSt = Math.max(maxSt, s.tele.stallL, s.tele.stallR); });
    line(`after 5 s: alt ${(-s.p[2]).toFixed(1)} m (lowest ${minAlt.toFixed(2)} m), V ${s.tele.V.toFixed(1)} m/s, pitch ${deg(eul(s).pitch).toFixed(0)}°, roll ${deg(eul(s).roll).toFixed(0)}°, max stalled area ${(maxSt * 100).toFixed(0)}%, crashed ${s.crashed}`);

    line('\n== Belly landing: glide in, flare, motor off ==');
    const s2 = airStart(ac, 15, 15, 0.2);
    let td = null;
    run(s2, ac, (s) => {
      const agl = -s.p[2];
      const vzt = agl > 1.5 ? 1.2 : 0.2 + 0.6 * agl;
      return { thr: 0, a: FL.sat(-1.2 * eul(s).roll), e: FL.sat(0.1 + 0.5 * (s.v[2] - vzt) - 0.05 * s.w[1]), r: 0 };
    }, 30, (s) => { if (!td && s.wow) td = { vz: s.v[2], V: Math.hypot(s.v[0], s.v[1]) }; });
    line(td ? `touchdown sink ${td.vz.toFixed(2)} m/s at ${td.V.toFixed(1)} m/s ground speed; crashed ${s2.crashed} ${s2.crashMsg}; slid to ${Math.hypot(s2.v[0], s2.v[1]).toFixed(2)} m/s` : 'no touchdown');
  } else {
    line('\n== Takeoff ==');
    const s = FL.makeState(); FL.reset(s, ac, 'runway');
    const x0 = s.p[1]; let lo = null;
    run(s, ac, (s) => { const e = eul(s); const thD = s.tele.V > 9 ? 0.17 : 0; return { thr: 1, a: -0.5 * e.roll, e: FL.sat(2 * (thD - e.pitch) - 0.2 * s.w[1]), r: 0 }; }, 10, (s, t) => { if (!lo && !s.wow && t > 0.5) lo = { t, d: s.p[1] - x0, V: s.tele.V }; });
    line(lo ? `liftoff ${lo.t.toFixed(1)} s, ${lo.d.toFixed(0)} m roll, ${lo.V.toFixed(1)} m/s; at 10 s alt ${(-s.p[2]).toFixed(0)} m, crashed ${s.crashed} ${s.crashMsg}` : `no liftoff; crashed ${s.crashed} ${s.crashMsg}`);
    line('\n== Landing ==');
    const s2 = airStart(ac, 13, 20, 0.35); let td = null;
    run(s2, ac, (s) => { const agl = -s.p[2] - 0.17; const vzt = agl > 1.2 ? 1.0 : 0.15 + 0.7 * agl; return { thr: agl > 1.2 ? 0.35 : 0, a: -0.6 * eul(s).roll, e: FL.sat(0.03 + 0.35 * (s.v[2] - vzt) - 0.08 * s.w[1]), r: 0 }; }, 40, (s) => { if (!td && s.wow) td = { vz: s.v[2], V: s.tele.V }; });
    line(td ? `touchdown sink ${td.vz.toFixed(2)} m/s at ${td.V.toFixed(1)} m/s; stopped ${Math.hypot(s2.v[0], s2.v[1]).toFixed(2)} m/s; crashed ${s2.crashed} ${s2.crashMsg}` : 'no touchdown');
    line('\n== Ground handling ==');
    let g = FL.makeState(); FL.reset(g, ac, 'runway'); const p0 = g.p.slice();
    run(g, ac, { thr: 0, a: 0, e: 0, r: 0 }, 4);
    line(`parked 4 s: moved ${Math.hypot(g.p[0] - p0[0], g.p[1] - p0[1]).toFixed(3)} m, pitch ${deg(eul(g).pitch).toFixed(2)}°`);
    const envSave = env.wind; env.wind = [5, 0, 0];
    g = FL.makeState(); FL.reset(g, ac, 'runway');
    run(g, ac, { thr: 0, a: 0, e: 0, r: 0 }, 5);
    line(`parked in 5 m/s crosswind: roll ${deg(eul(g).roll).toFixed(1)}°, heading ${deg(eul(g).yaw).toFixed(0)}°`);
    env.wind = envSave;
    g = FL.makeState(); FL.reset(g, ac, 'runway');
    run(g, ac, { thr: 0.35, a: 0, e: 0, r: 1 }, 6);
    line(`taxi 35% + full rudder 6 s: roll ${deg(eul(g).roll).toFixed(1)}°, speed ${Math.hypot(g.v[0], g.v[1]).toFixed(1)} m/s, crashed ${g.crashed}`);
  }
}

if (which === 'all' || which === 'goblin') suite('goblin');
if (which === 'all' || which === 'trainer') suite('trainer');
