/* Accurate-aerodynamics tests. Run: node test/hifi_test.js
   Compares the lightweight model against the accurate one (env.hifi) and
   asserts the things that must hold: trim stays anchored, the new effects
   point the right way, nothing blows up, and the lightweight path is
   untouched. Prints the numbers; exits non-zero on a failed assertion. */
const fs = require('fs');
const path = require('path');
const FL = require('../src/physics.js');
const DT = 1 / 400;
const deg = (r) => (r * 180) / Math.PI;
let fails = 0;
const check = (ok, what) => { console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { fails++; process.exitCode = 1; } };
const envOf = (hifi) => ({ rho: 1.225, wind: [0, 0, 0], battery: false, crashes: false, hifi });
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));

function airStart(ac, V, alt, thr, roll = 0, pitch = 0) {
  const s = FL.makeState();
  FL.reset(s, ac, 'air');
  s.p = [0, 0, -alt];
  s.q = FL.quatFromEuler(roll, pitch, 0);
  s.v = FL.mulMV(FL.quatToMat(s.q), [V, 0, 0]);
  s.n = thr;
  return s;
}
function run(s, ac, env, ctl, secs, cb) {
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    const c0 = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    const c = { thr: c0.thr, a: FL.sat((c0.a || 0) + ac.trim.a), e: FL.sat((c0.e || 0) + ac.trim.e), r: c0.r || 0 };
    FL.step(s, ac, c, env, DT);
    if (cb && cb(s, i * DT) === false) break;
  }
}

/* ---- hands-off trim: accurate mode must stay anchored to the tuned aircraft ---- */
for (const id of ['goblin', 'trainer']) {
  const ac = FL.build(FL.DEFS[id]);
  console.log(`\n== ${ac.name}: hands-off trim, lightweight vs accurate ==`);
  const V = {};
  for (const hifi of [false, true]) {
    const s = airStart(ac, id === 'goblin' ? 18 : 14, 120, 0.55);
    run(s, ac, envOf(hifi), { thr: 0.55 }, 40);
    V[hifi] = s.tele.V;
    console.log(`   ${hifi ? 'accurate   ' : 'lightweight'}: V ${s.tele.V.toFixed(1)} m/s, α ${deg(s.tele.alpha).toFixed(1)}°, CL ${s.tele.CL.toFixed(2)}`);
    check(Number.isFinite(s.v[0] + s.w[0] + s.p[2]), 'state finite after 40 s');
  }
  check(Math.abs(V[true] - V[false]) / V[false] < 0.1, `trim speed within 10% (${V[false].toFixed(1)} → ${V[true].toFixed(1)} m/s)`);
}

/* ---- dynamic stall: a fast pull reaches a higher angle before the wing lets go ---- */
{
  const ac = FL.build(FL.DEFS.trainer);
  console.log('\n== Dynamic stall: α at the break, slow pull vs fast pull (trainer, 13 m/s) ==');
  const alphaAtBreak = (hifi, pullSecs) => {
    const s = airStart(ac, 13, 150, 0);
    let aMax = 0, broke = null;
    run(s, ac, envOf(hifi), (st, t) => ({ thr: 0, a: FL.sat(-0.8 * eul(st).roll), e: Math.min(1, t / pullSecs) }), pullSecs + 2, (st) => {
      if (Math.max(st.tele.stallL, st.tele.stallR) > 0.4) { broke = aMax; return false; }
      aMax = Math.max(aMax, st.tele.alpha);
    });
    return broke;
  };
  for (const hifi of [false, true]) {
    const slow = alphaAtBreak(hifi, 10), fast = alphaAtBreak(hifi, 0.25);
    console.log(`   ${hifi ? 'accurate   ' : 'lightweight'}: slow pull breaks past α ${deg(slow).toFixed(1)}°, snap pull past α ${deg(fast).toFixed(1)}°`);
    if (hifi) check(fast > slow + 0.8 * FL.D2R, `snap pull stalls ${(deg(fast - slow)).toFixed(1)}° later (dynamic stall)`);
  }
}

/* ---- propeller effects, each checked for direction (trainer: clockwise prop seen from behind) ---- */
{
  const ac = FL.build(FL.DEFS.trainer);
  console.log('\n== Propeller: swirl, P-factor, gyroscopics (accurate mode) ==');

  // slipstream swirl over the fin: full power at low speed walks the nose left
  const yawDrift = (hifi) => {
    const s = airStart(ac, 8, 100, 0.9, 0, 10 * FL.D2R);
    const y0 = eul(s).yaw;
    run(s, ac, envOf(hifi), (st) => ({ thr: 1, a: FL.sat(-1.2 * eul(st).roll - 0.1 * st.w[0]), e: 0 }), 2.5);
    let dy = eul(s).yaw - y0;
    if (dy > Math.PI) dy -= 2 * Math.PI; if (dy < -Math.PI) dy += 2 * Math.PI;
    return dy;
  };
  const d0 = yawDrift(false), d1 = yawDrift(true);
  console.log(`   full-power climb, 2.5 s, rudder centred: heading ${deg(d0).toFixed(1)}° lightweight, ${deg(d1).toFixed(1)}° accurate`);
  check(d1 < d0 - 1 * FL.D2R, 'swirl and P-factor walk the nose left (clockwise prop)');

  // gyroscopic precession: a sharp pitch-up at high rpm yaws the nose right
  const gyroYaw = (hifi) => {
    const s = airStart(ac, 14, 100, 0.9);
    let r = 0;
    run(s, ac, envOf(hifi), { thr: 1, e: 1 }, 0.35, (st) => { r = st.w[2]; });
    return r;
  };
  const g0 = gyroYaw(false), g1 = gyroYaw(true);
  console.log(`   full-power pitch snap: yaw rate after 0.35 s ${deg(g0).toFixed(1)}°/s lightweight, ${deg(g1).toFixed(1)}°/s accurate`);
  check(g1 > g0 + 1 * FL.D2R, 'gyroscopic precession: pitch up yaws right');
}

/* ---- adverse yaw survives the lifting line: rolling right, the nose lags
   left of the flight path, which reads as sideslip toward the roll ---- */
{
  const ac = FL.build(FL.DEFS.trainer);
  console.log('\n== Adverse yaw: full right aileron at idle, sideslip after 0.5 s (trainer) ==');
  for (const hifi of [false, true]) {
    const s = airStart(ac, 12, 100, 0.2);
    run(s, ac, envOf(hifi), { thr: 0.2, a: 1 }, 0.5);
    console.log(`   ${hifi ? 'accurate   ' : 'lightweight'}: β ${deg(s.tele.beta).toFixed(1)}°`);
    check(s.tele.beta > 0.2 * FL.D2R, 'nose lags the roll (adverse yaw)');
  }
}

/* ---- Reynolds: the accurate model costs more drag when slow ---- */
{
  const ac = FL.build(FL.DEFS.goblin);
  console.log('\n== Reynolds number: slow glide, pitch held (goblin, near its low-Re corner) ==');
  const sink = (hifi) => {
    const s = airStart(ac, 10, 200, 0);
    let vz = 0, V = 0, n = 0;
    run(s, ac, envOf(hifi), (st) => {
      const e = eul(st);
      return { thr: 0, a: FL.sat(-0.8 * e.roll), e: FL.sat(2.5 * (-6 * FL.D2R - e.pitch) - 0.3 * st.w[1]) };
    }, 8, (st, t) => { if (t > 4) { vz += st.v[2]; V += st.tele.V; n++; } });
    return { sink: vz / n, V: V / n };
  };
  const s0 = sink(false), s1 = sink(true);
  console.log(`   lightweight: ${s0.V.toFixed(1)} m/s, sink ${s0.sink.toFixed(2)} m/s · accurate: ${s1.V.toFixed(1)} m/s, sink ${s1.sink.toFixed(2)} m/s`);
}

/* ---- the other airframes keep flying with it on ---- */
{
  console.log('\n== Smoke: tail-sitter and lifting-body quad, accurate mode ==');
  const vt = JSON.parse(fs.readFileSync(path.join(__dirname, '../aircraft/blown-wing-twin.json'))).def;
  const ac = FL.build(vt);
  const s = FL.makeState();
  FL.reset(s, ac, 'air');
  const env = envOf(true);
  for (let i = 0; i < 400 * 15; i++) FL.step(s, ac, { thr: ac.hoverThr, a: 0, e: 0, r: 0, fwd: 1, armed: true, mode: 'acro' }, env, DT);
  console.log(`   ${ac.name}: V ${s.tele.V.toFixed(1)} m/s after 15 s forward flight`);
  check(Number.isFinite(s.v[0] + s.w[0]) && !s.crashed, 'tail-sitter flies 15 s in accurate mode');

  // prop hang: the blown wing holding attitude at zero airspeed, elevons flying on wash alone
  const s1 = FL.makeState();
  FL.reset(s1, ac, { n: 0, e: 0, yawDeg: 0, aglM: 25, speedMs: 0 });
  for (let i = 0; i < 400 * 10; i++) FL.step(s1, ac, { thr: ac.hoverThr, a: 0, e: 0, r: 0, fwd: 0, armed: true, mode: 'acro' }, env, DT);
  console.log(`   ${ac.name}: hover after 10 s, V ${s1.tele.V.toFixed(1)} m/s`);
  check(Number.isFinite(s1.v[0] + s1.w[0]) && !s1.crashed && s1.tele.V < 6, 'blown wing prop-hangs in accurate mode');

  const lb = JSON.parse(fs.readFileSync(path.join(__dirname, '../aircraft/lb7-longrange.json'))).def;
  const ac2 = FL.build(lb);
  const s2 = FL.makeState();
  FL.reset(s2, ac2, 'air');
  for (let i = 0; i < 400 * 10; i++) FL.step(s2, ac2, { thr: ac2.hoverThr, a: 0, e: 0.25, r: 0, armed: true, mode: 'angle' }, env, DT);
  console.log(`   ${ac2.name}: V ${s2.tele.V.toFixed(1)} m/s after 10 s under way`);
  check(Number.isFinite(s2.v[0] + s2.w[0]) && !s2.crashed, 'lifting-body quad flies 10 s in accurate mode');

  // flaps and retracts under the lifting line, flown by a pitch-hold pilot
  const cp = JSON.parse(fs.readFileSync(path.join(__dirname, '../aircraft/camera-platform-2m.json'))).def;
  const ac3 = FL.build(cp);
  const s3 = FL.makeState();
  FL.reset(s3, ac3, 'air');
  for (let i = 0; i < 400 * 12; i++) {
    const e3 = eul(s3);
    FL.step(s3, ac3, {
      thr: 0.35, a: FL.sat(-1.2 * e3.roll - 0.1 * s3.w[0]),
      e: FL.sat(ac3.trim.e + 2 * (-2 * FL.D2R - e3.pitch) - 0.3 * s3.w[1]), r: 0, f: 1, gear: true,
    }, env, DT);
  }
  console.log(`   ${ac3.name}: full flap, pitch held, V ${s3.tele.V.toFixed(1)} m/s after 12 s`);
  check(Number.isFinite(s3.v[0] + s3.w[0]) && !s3.crashed && s3.tele.V > 5, 'flapped plane flies slow and steady in accurate mode');

  // icing while the accurate model is on: ice growth shares the same strip pass
  const acI = FL.build(FL.DEFS.goblin);
  const sI = airStart(acI, 18, 200, 0.6);
  const envI = envOf(true);
  envI.wx = FL.weatherAt({ tempC: -2, rh: 98, precip: 'drizzle', fogVisM: 10000, ceilM: 0 }, 100);
  for (let i = 0; i < 400 * 20; i++) FL.step(sI, acI, { thr: 0.6, a: FL.sat(acI.trim.a), e: FL.sat(acI.trim.e), r: 0 }, envI, DT);
  console.log(`   goblin in freezing drizzle: ice mass ${(sI.iceMass * 1000).toFixed(1)} g after 20 s`);
  check(Number.isFinite(sI.v[0] + sI.w[0]) && sI.iceMass > 0, 'icing grows and the model stays finite in accurate mode');
}

/* ---- the fine build: twice the strips, clustered toward the tips ---- */
{
  console.log('\n== Fine build: trim parity and tip loading ==');
  for (const id of ['goblin', 'trainer']) {
    const acS = FL.build(FL.DEFS[id]), acF = FL.build(FL.DEFS[id], { fine: true });
    const V = {};
    for (const [key, ac, hifi] of [['std', acS, false], ['fine', acF, true]]) {
      const s = airStart(ac, id === 'goblin' ? 18 : 14, 120, 0.55);
      run(s, ac, envOf(hifi), { thr: 0.55 }, 40);
      V[key] = s.tele.V;
      check(Number.isFinite(s.v[0] + s.w[0]), `${id} fine build: ${key} state finite after 40 s`);
    }
    console.log(`   ${id}: ${acS.strips.length} → ${acF.strips.length} strips, trim ${V.std.toFixed(1)} → ${V.fine.toFixed(1)} m/s`);
    check(Math.abs(V.fine - V.std) / V.std < 0.1, `fine trim within 10% of lightweight`);
    // tip-clustered strips must load like a wing: circulation rolls off outboard, no root dip
    const env = envOf(true);
    const s = airStart(acF, 14, 120, 0.3);
    run(s, acF, env, { thr: 0.3 }, 3);
    const gRight = [];
    acF.strips.forEach((st, i) => { if (st.role === 'wing' && st.side > 0 && st.surf === acF.strips[0].surf) gRight.push(s.gam[i]); });
    const iMax = gRight.indexOf(Math.max(...gRight));
    check(iMax <= 1 && gRight[gRight.length - 1] < 0.6 * gRight[iMax], `circulation peaks inboard and rolls off at the tip (peak strip ${iMax})`);
  }
}

/* ---- ground effect follows the terrain under the aircraft, not the map datum:
   skimming a 50 m plateau must fly like skimming the field, in both models ---- */
{
  const ac = FL.build(FL.DEFS.goblin);
  console.log('\n== Ground effect above a 50 m plateau (goblin, one-step drag and lift) ==');
  const plateau = (up) => ({
    heightAt: () => up,
    probe: (n, e, out) => { out.up = up; out.nN = 0; out.nE = 0; out.nD = -1; out.cls = 0; },
  });
  const dragAt = (hifi, terrainUp) => {
    const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: false, hifi, terrain: plateau(terrainUp) };
    const s = FL.makeState();
    FL.reset(s, ac, 'air');
    s.p = [0, 0, -50.08]; s.q = FL.quatFromEuler(0, 6 * FL.D2R, 0); s.v = [12, 0, 0]; s.w = [0, 0, 0]; s.n = 0;
    for (let i = 0; i < 20; i++) { FL.step(s, ac, { thr: 0, a: 0, e: 0, r: 0 }, env, DT); if (i < 19) { s.p = [0, 0, -50.08]; s.v = [12, 0, 0]; } }
    return { drag: 12 - s.v[0], dvz: s.v[2] };
  };
  /* The two models spend the benefit differently at a fixed angle of attack:
     the lightweight one cuts induced drag at fixed lift, the accurate one
     re-equilibrates the circulation so part of it appears as extra lift. */
  for (const hifi of [false, true]) {
    const near = dragAt(hifi, 50), high = dragAt(hifi, 0); // same altitude: 0.08 m over the plateau vs 50 m over the field
    console.log(`   ${hifi ? 'accurate   ' : 'lightweight'}: at 8 cm AGL vs 50 m — drag ${near.drag.toFixed(5)} vs ${high.drag.toFixed(5)} m/s per step, lift Δvz ${near.dvz.toFixed(5)} vs ${high.dvz.toFixed(5)}`);
    check(near.drag < high.drag, 'less induced drag skimming the plateau');
    if (hifi) check(near.dvz < high.dvz - 1e-5, 'and more lift (the float in the flare)');
  }
}

/* ---- cost: steps per second, all three models ---- */
{
  console.log('\n== Cost of the options (trainer, 1-s batches) ==');
  for (const [label, ac, hifi] of [['lightweight    ', FL.build(FL.DEFS.trainer), false], ['accurate       ', FL.build(FL.DEFS.trainer), true], ['accurate · fine', FL.build(FL.DEFS.trainer, { fine: true }), true]]) {
    const env = envOf(hifi);
    const s = airStart(ac, 14, 500, 0.55);
    const N = 40000, t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) FL.step(s, ac, { thr: 0.55, a: 0.05, e: -0.05, r: 0 }, env, DT);
    const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
    console.log(`   ${label}: ${us.toFixed(2)} µs/step (${(us * 0.04).toFixed(2)}% of one core at 400 Hz)`);
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
