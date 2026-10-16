/* Flight-mode checks for a plane and the quad. Run: node test/modes_test.js */
const FL = require('../src/physics.js');
const DT = 1 / 400, deg = (r) => (r * 180) / Math.PI;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const lim = { bank: 45, pitch: 30, tBank: 60, tPitch: 45 };
const rlim = { bank: 55, pitch: 55, tBank: 60, tPitch: 60 };

function plane(mode, sticks, secs, roll0 = 0) {
  const ac = FL.build(FL.DEFS.goblin), s = FL.makeState(); FL.reset(s, ac, 'air');
  s.p = [0, 0, -150]; s.q = FL.quatFromEuler(roll0 * FL.D2R, 0, 0); s.v = FL.mulMV(FL.quatToMat(s.q), [18, 0, 0]); s.n = 0.55;
  let turned = 0, maxBank = 0;
  for (let i = 0; i < secs / DT; i++) {
    const manual = { thr: 0.55, a: FL.sat(sticks.a + ac.trim.a), e: FL.sat(sticks.e + ac.trim.e), r: 0 };
    const c = mode === 'manual' ? manual : FL.planeAssist(mode, sticks, manual, s, ac, lim);
    FL.step(s, ac, c, env, DT);
    turned += s.w[0] * DT; maxBank = Math.max(maxBank, Math.abs(deg(eul(s).roll)));
  }
  return { bank: deg(eul(s).roll), turned: deg(turned), maxBank };
}
function quad(mode, sticks, secs, roll0 = 0) {
  const ac = FL.build(FL.DEFS.quad), s = FL.makeState(); FL.reset(s, ac, 'air'); s.p[2] = -40;
  s.q = FL.quatFromEuler(roll0 * FL.D2R, 0, 0);
  let turned = 0, maxBank = 0;
  for (let i = 0; i < secs / DT; i++) {
    FL.step(s, ac, { thr: 0.4, a: sticks.a, e: sticks.e, r: 0, armed: true, mode, lim: rlim }, env, DT);
    turned += s.w[0] * DT; maxBank = Math.max(maxBank, Math.abs(deg(eul(s).roll)));
  }
  return { bank: deg(eul(s).roll), turned: deg(turned), maxBank };
}
const f = (r) => `ends at ${r.bank.toFixed(0)}° bank, rolled ${r.turned.toFixed(0)}° total, peak bank ${r.maxBank.toFixed(0)}°`;
console.log('Nano Goblin, full right stick held 1.5 s:');
for (const m of ['manual', 'horizon', 'trainer', 'stab']) console.log(`  ${m.padEnd(8)} ${f(plane(m, { a: 1, e: 0 }, 1.5))}`);
console.log('Nano Goblin, 30% right stick held 3 s:');
for (const m of ['horizon', 'stab']) console.log(`  ${m.padEnd(8)} ${f(plane(m, { a: 0.3, e: 0 }, 3))}`);
console.log('Nano Goblin, sticks centred from 70° bank, 2 s:');
for (const m of ['manual', 'horizon', 'trainer', 'stab']) console.log(`  ${m.padEnd(8)} ${f(plane(m, { a: 0, e: 0 }, 2, 70))}`);
console.log('Quad, full right stick held 1.5 s:');
for (const m of ['acro', 'horizon', 'trainer', 'angle']) console.log(`  ${m.padEnd(8)} ${f(quad(m, { a: 1, e: 0 }, 1.5))}`);
console.log('Quad, sticks centred from 70° bank, 1 s:');
for (const m of ['acro', 'horizon', 'trainer', 'angle']) console.log(`  ${m.padEnd(8)} ${f(quad(m, { a: 0, e: 0 }, 1, 70))}`);
