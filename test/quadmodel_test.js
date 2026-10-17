/* Which way up a quad is drawn. Run: node test/quadmodel_test.js

   The 13-inch and the 10-inch quads flew correctly and were drawn upside
   down: landing gear on top, battery hanging off the underside. The cause was
   a double negation. The body frame is FRD, so a foot 160 mm below the centre
   of gravity has p[2] = +0.16, and the render frame is Y-up, so it belongs at
   render y = -0.16. The gear code negated p[2] on the way in and again on the
   way out, which put the skids 160 mm *above* the frame.

   So this test checks the one thing that cannot be got wrong twice and still
   look right: the sign of every part's render height against the sign the
   definition asked for. It covers every built-in quad, every quad in
   aircraft/, and the quads the build sheet generates across its range.

   quadFit lives in src/app.js, which is a browser bundle with no exports, so
   this cuts the block out of that file by its comment markers and evals it -
   the same trick as test/camera_test.js and test/input_test.js, and for the
   same reason: the test can then never pass against a stale copy of the code
   that actually draws the model. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');

const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const m = src.match(/\/\* ---- quad fit[\s\S]*?\/\* ---- end quad fit ---- \*\//);
if (!m) { console.error('could not find the quad fit block in src/app.js'); process.exit(1); }
const { quadFit } = new Function(m[0] + '\nreturn { quadFit };')();

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };
const mm = (v) => `${(v * 1000).toFixed(0)} mm`;

function check(label, ac) {
  const fit = quadFit(ac);
  const feet = ac.points.filter((p) => p.foot);
  const pack = ac.points.find((p) => p.name === 'battery');
  const eye = ac.points.find((p) => p.name === 'camera' || p.name === 'gimbal');
  const lowest = Math.max(...feet.map((p) => p.p[2]));

  // the feet rest where the file says they do, not at minus that
  ok(Math.abs(fit.gear.y - -lowest) < 1e-12, `${label}: the skid is where the lowest foot is`,
    `foot ${mm(lowest)} down, skid at render y ${mm(fit.gear.y)}`);
  // and on a quad with gear that means under the frame, never over it
  if (ac.gear) ok(fit.gear.y < 0, `${label}: the landing gear is under the frame`, `render y ${mm(fit.gear.y)}`);
  // the skid has to reach past the frame plate, or it is drawn inside it
  ok(fit.gear.x > 0.015 && fit.gear.z > 0.02, `${label}: the skid has a real footprint`,
    `${mm(2 * fit.gear.x)} across x ${mm(2 * fit.gear.z)} fore and aft`);

  // the pack is on the side of the frame the file puts it on
  ok(fit.pack.up === pack.p[2] < 0, `${label}: the pack is ${pack.p[2] < 0 ? 'on top' : 'underneath'}, as the file says`,
    `pack point ${mm(-pack.p[2])} up`);
  ok(Math.abs(fit.pack.y - -pack.p[2]) < 1e-12, `${label}: the pack's render height matches the file`);

  // and the camera looks out of the right side of the airframe
  ok(Math.abs(fit.cam[1] - -eye.p[2]) < 1e-12 && Math.abs(fit.cam[2] - -eye.p[0]) < 1e-12,
    `${label}: the ${eye.name} is where the file puts it`,
    `render [${fit.cam.map((v) => v.toFixed(3)).join(', ')}]`);
  if (eye.name === 'gimbal') ok(fit.cam[1] < 0, `${label}: the gimbal pod hangs below the frame`, `render y ${mm(fit.cam[1])}`);
}

console.log('== built-in quads ==');
for (const [id, def] of Object.entries(FL.DEFS)) {
  if (def.kind !== 'quad') continue;
  check(id, FL.build(def));
}

console.log('\n== the aircraft folder ==');
for (const f of fs.readdirSync(path.join(ROOT, 'aircraft')).sort()) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const r = ACF.read(fs.readFileSync(path.join(ROOT, 'aircraft', f), 'utf8'));
  if (!r.ok) { ok(false, `${f} reads`, r.errors.join('; ')); continue; }
  if (r.def.kind !== 'quad') continue;
  check(f, FL.build(r.def));
}

/* The build sheet's own range. "Pack on top" off has to actually put the pack
   underneath - it used to draw it on top whatever you picked, because the LiPo
   branch of the model had the height written into it. */
console.log('\n== quads the build sheet generates ==');
const SWEEP = [
  ['3" no gear, LiPo on top', { propD: 3, mass: 250, quadGear: false }],
  ['3" no gear, LiPo underneath', { propD: 3, mass: 250, quadGear: false, packTop: false }],
  ['5" freestyle', { propD: 5, mass: 650 }],
  ['5" pack underneath', { propD: 5, mass: 650, packTop: false }],
  ['7" long range, Li-ion', { propD: 7, mass: 1050, cellChem: 'liion', cellsS: 6, cellsP: 2 }],
  ['7" Li-ion underneath', { propD: 7, mass: 1050, cellChem: 'liion', cellsS: 6, cellsP: 2, packTop: false }],
  ['10" with gear', { propD: 10, mass: 1800, quadGear: true }],
  ['13" lifter with a gimbal', { propD: 13, mass: 3700, cellChem: 'liion', cellsS: 12, cellsP: 2, quadGear: true, gimbal: true }],
  ['35" heavy lift', { propD: 35, mass: 30000, cellChem: 'liion', cellsS: 14, cellsP: 4, quadGear: true, gimbal: true }],
];
for (const [label, fields] of SWEEP) {
  const def = ACF.fromSpec(Object.assign({ kind: 'quad' }, fields));
  check(label, FL.build(def));
}

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
