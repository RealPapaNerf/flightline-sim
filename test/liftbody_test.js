/* A lifting body on a quad. Run: node test/liftbody_test.js

   A wing across the middle of the frame, set at an angle to the plane of the
   props, so that some of the weight is carried by air instead of by the
   motors. The thing this test exists to pin down is the **sign**, because it
   is the one part of it that is not obvious and getting it wrong looks
   plausible right up until the range goes down:

   a quad leans NOSE-DOWN to fly forward, which tips the frame's up-vector
   forward with it, so a wing lying flat in the plane of the props meets the
   air on its top surface and pushes down. At a lean of phi, a wing in the
   prop plane is at MINUS phi. The rig angle is measured leading edge UP from
   the prop plane and has to be larger than the lean you cruise at; the wing
   then flies at (angle - phi).

   So: 0 degrees must cost you range, a rig angle above the cruise lean must
   earn it, and a quad with no lifting body must fly exactly as it did before. */
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');

const D2R = Math.PI / 180, R2D = 180 / Math.PI, G = FL.G;
let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

const BASE = { kind: 'quad', propD: 7, mass: 1200, cellChem: 'liion', cellsS: 6, cellsP: 2, cellmAh: 3000, wheelbase: 300 };
const spec = (extra) => Object.assign({}, BASE, extra);
const build = (extra) => FL.build(ACF.fromSpec(spec(extra)));
const bench = (extra) => { const ac = build(extra); return Object.assign({ ac }, ACF.quadBench(ac, 1.225, 20)); };

/* ---------------- nothing changes for a quad without one ---------------- */
console.log('== a quad with no lifting body is the quad it always was ==');
{
  const plain = build({});
  ok(plain.strips.length === 0, 'it has no strips at all', `${plain.strips.length}`);
  ok(plain.S === 0 && !plain.lift, 'and no wing area to report');
  for (const id of ['lr4', 'q7', 'q13', 'quad']) {
    const ac = FL.build(FL.DEFS[id]);
    ok(ac.strips.length === 0, `the built-in ${id} still has no strips`);
  }
}

/* ---------------- the geometry ---------------- */
console.log('\n== the wing the build sheet makes ==');
{
  const ac = build({ liftBody: true, lbAngle: 30, lbSpan: 400, lbChord: 160 });
  ok(ac.surfaces && ac.surfaces.length === 1, 'one surface, mirrored to both sides');
  const sf = ac.surfaces[0];
  ok(Math.abs(sf.y1 * 2 - 0.4) < 1e-6, 'the span is what was asked for', `${(sf.y1 * 2 * 1000).toFixed(0)} mm`);
  ok(Math.abs(sf.c0 - 0.16) < 1e-6, 'and the chord', `${(sf.c0 * 1000).toFixed(0)} mm`);
  ok(sf.inc0 === 30 && sf.inc1 === 30, 'the incidence is the rig angle, leading edge up', `${sf.inc0}°`);
  // the quarter chord sits on the centre of gravity, so it adds no trim change
  ok(Math.abs(sf.xLE0 - 0.25 * sf.c0) < 1e-9, 'the quarter chord sits on the CG, so it costs no trim', `leading edge ${(sf.xLE0 * 1000).toFixed(0)} mm ahead`);
  ok(ac.strips.length === 8, 'it is cut into strips like any other wing', `${ac.strips.length}`);
  ok(ac.ARw > 1.5 && ac.ARw < 4, 'and it is the low aspect ratio that makes it stall late', `AR ${ac.ARw.toFixed(2)}`);
  ok(Math.abs(ac.b - (2 * Math.max(...ac.motors.map(([x, y]) => Math.hypot(x, y))) * 0.71 + ac.motor.D)) < 1e-9,
    'ac.b is still the motor span — ground effect and shed ice are scaled by it', `${(ac.b * 1000).toFixed(0)} mm`);
}

/* ---------------- the sign, measured in flight ----------------
   Fly it level at a known lean and read the angle of attack the strip model
   actually sees. It has to be the rig angle minus the lean. */
console.log('\n== which way up the air hits it ==');
function alphaAtLean(rig, leanDeg) {
  const ac = build({ liftBody: true, lbAngle: rig });
  const DT = 1 / 400, env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: false };
  const s = FL.makeState();
  FL.reset(s, ac, 'air');
  s.p[2] = -60;
  let iz = 0;
  for (let k = 0; k < 400 * 16; k++) {
    const ez = -s.p[2] - 60;
    iz += ez * DT;
    const thr = FL.clamp(ac.hoverThr * 1.25 - 0.03 * ez - 0.01 * iz + 0.02 * s.v[2], 0, 1);
    FL.step(s, ac, { thr, a: 0, e: -leanDeg / 55, r: 0, armed: true, mode: 'angle', lim: { bank: 55, pitch: 55 } }, env, DT);
  }
  const eu = FL.eulerFromMat(FL.quatToMat(s.q));
  return { alpha: s.tele.alpha * R2D, pitch: eu.pitch * R2D, V: s.tele.V };
}
for (const [rig, lean] of [[0, 20], [30, 20], [40, 20], [30, 10]]) {
  const r = alphaAtLean(rig, lean);
  const want = rig + r.pitch; // pitch is negative nose-down, so this is rig - lean
  ok(Math.abs(r.alpha - want) < 3.5, `rigged ${rig}° and leaning ${(-r.pitch).toFixed(0)}°, the wing flies at ${r.alpha.toFixed(1)}°`,
    `expected about ${want.toFixed(1)}°`);
}
{
  const flat = alphaAtLean(0, 20);
  ok(flat.alpha < -5, 'a wing flat in the prop plane is at a NEGATIVE angle of attack when the quad leans',
    `${flat.alpha.toFixed(1)}° at ${(-flat.pitch).toFixed(0)}° of lean`);
}

/* ---------------- does it do any work ---------------- */
console.log('\n== what it is worth ==');
{
  const plain = bench({});
  const rows = [0, 10, 20, 30, 40, 50, 90].map((a) => ({ a, b: bench({ liftBody: true, lbAngle: a }) }));
  console.log(`      no lifting body: cruise ${(plain.cruiseV * 3.6).toFixed(0)} km/h on ${plain.cruiseI.toFixed(1)} A, ${plain.cruiseKm.toFixed(1)} km`);
  for (const { a, b } of rows) {
    console.log(`      rigged ${String(a).padStart(2)}°:      cruise ${(b.cruiseV * 3.6).toFixed(0)} km/h on ${b.cruiseI.toFixed(1)} A, ${b.cruiseKm.toFixed(1)} km, carrying ${(b.lbLift * 100).toFixed(0)}% of the weight`);
  }
  const at = (a) => rows.find((r) => r.a === a).b;

  ok(at(0).lbLift < -0.1, 'flat in the prop plane it carries NEGATIVE weight — it is pushing down',
    `${(at(0).lbLift * 100).toFixed(0)}%`);
  ok(at(0).cruiseKm < plain.cruiseKm, 'so a flat plate costs you range', `${at(0).cruiseKm.toFixed(1)} km against ${plain.cruiseKm.toFixed(1)} km`);

  const best = rows.reduce((a2, r) => (r.b.cruiseKm > a2.b.cruiseKm ? r : a2));
  ok(best.a > 19, 'the best rig angle is above the 19° lean the cruise is flown at', `${best.a}°`);
  ok(best.b.cruiseKm > plain.cruiseKm * 1.15, 'and at that angle it is worth more than 15% of the range',
    `${best.b.cruiseKm.toFixed(1)} km against ${plain.cruiseKm.toFixed(1)} km, +${((best.b.cruiseKm / plain.cruiseKm - 1) * 100).toFixed(0)}%`);
  ok(best.b.cruiseI < plain.cruiseI * 0.85, 'because the motors are carrying less of the weight',
    `${best.b.cruiseI.toFixed(1)} A against ${plain.cruiseI.toFixed(1)} A`);
  ok(at(90).lbLift < at(30).lbLift, 'on edge at 90° it is a fin, not a wing', `${(at(90).lbLift * 100).toFixed(0)}% against ${(at(30).lbLift * 100).toFixed(0)}%`);

  // a bigger wing carries more and flies slower, which is the trade
  const small = bench({ liftBody: true, lbAngle: 35, lbSpan: 250 });
  const big = bench({ liftBody: true, lbAngle: 35, lbSpan: 600 });
  ok(big.lbLift > small.lbLift, 'a bigger wing carries more of the weight', `${(big.lbLift * 100).toFixed(0)}% against ${(small.lbLift * 100).toFixed(0)}%`);
  ok(big.cruiseV < small.cruiseV, 'and cruises slower for it', `${(big.cruiseV * 3.6).toFixed(0)} against ${(small.cruiseV * 3.6).toFixed(0)} km/h`);
  ok(Math.abs(big.hoverI - small.hoverI) < 0.2, 'neither of them changes the hover — a wing does nothing standing still',
    `${big.hoverI.toFixed(1)} A and ${small.hoverI.toFixed(1)} A`);
}

/* ---------------- it survives being written to a file ---------------- */
console.log('\n== export and import ==');
{
  const sp = spec({ liftBody: true, lbAngle: 35, lbSpan: 420, lbChord: 180, lbTipChord: 120, lbSweep: 12, lbAirfoil: 'semi' });
  const def = ACF.autoTrim(ACF.fromSpec(sp));
  const text = ACF.text(def, { author: 'test', version: '1' }, ACF.normSpec(sp, { errors: [], warnings: [] }));
  const r = ACF.read(text);
  ok(r.ok, 'a lifting-body quad writes and reads back', r.ok ? '' : r.errors.join('; '));
  if (r.ok) {
    ok(ACF.fingerprint(r.def) === ACF.fingerprint(def), 'and it flies identically afterwards');
    ok(r.def.lift && Math.abs(r.def.lift.angle - 35) < 1e-9, 'the rig angle survives the round trip', r.def.lift ? `${r.def.lift.angle}°` : 'no lift block');
    ok(r.spec && r.spec.liftBody === true, 'and the build sheet remembers it has one, so the builder reopens it');
  }
}
{
  // the fields are clamped like every other one, not refused
  const out = { errors: [], warnings: [] };
  const sp = ACF.normSpec(spec({ liftBody: true, lbAngle: 400, lbSpan: 4 }), out);
  ok(sp.lbAngle === 90, 'a rig angle past 90° is clamped to 90°', `${sp.lbAngle}°`);
  ok(sp.lbSpan === 50, 'and a 4 mm span to the smallest the table allows', `${sp.lbSpan} mm`);
  ok(out.warnings.length >= 2, 'and both changes are reported', `${out.warnings.length} warnings`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
