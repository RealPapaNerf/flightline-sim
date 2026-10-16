/* FPV camera placement. Run: node test/camera_test.js

   The FPV view draws your own aircraft, so a camera inside its own fuselage looks
   out at the inside of the nose. This checks every built-in and every file in
   aircraft/ puts the camera in clear air.

   The fuselage geometry lives in src/app.js, which is a browser bundle with no
   exports, so this test cuts the block out of that file by its comment markers and
   evals it - the same trick as test/input_test.js, and for the same reason: the
   test can then never check a stale copy of the shape being drawn. */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');

const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const m = src.match(/\/\* ---- fuselage extent[\s\S]*?\/\* ---- end fuselage extent ---- \*\//);
if (!m) { console.error('could not find the fuselage extent block in src/app.js'); process.exit(1); }
const { fuseExtent, camClearance } = new Function(m[0] + '\nreturn { fuseExtent, camClearance };')();

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

// which of the three fuselage shapes buildPlane draws for this aircraft
const kindOf = (ac) => (ac.kind === 'vtol' ? 'tailsit' : !ac.surfaces.some((s) => s.role === 'tail') ? 'plank' : 'plane');
const MIN = 0.012; // metres of clear air; less than this and the near plane clips skin

function check(label, ac) {
  const k = kindOf(ac);
  const c = camClearance(ac, ac.fpvCam, k);
  const mm = c === Infinity ? 'nothing ahead of it' : `${(c * 1000).toFixed(0)} mm clear`;
  ok(c > MIN, `${label} (${k}) looks out of its own body`, `${mm}, camera at [${ac.fpvCam.map((v) => v.toFixed(3)).join(', ')}]`);
}

console.log('== built-in aircraft ==');
for (const [id, def] of Object.entries(FL.DEFS)) {
  const ac = FL.build(def);
  if (!ac.surfaces || !ac.surfaces.length || ac.kind === 'quad' || ac.kind === 'heli') continue;
  check(id, ac);
}

console.log('\n== the aircraft folder ==');
for (const f of fs.readdirSync(path.join(ROOT, 'aircraft')).sort()) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const r = ACF.read(fs.readFileSync(path.join(ROOT, 'aircraft', f), 'utf8'));
  if (!r.ok) { ok(false, `${f} reads`, r.errors.join('; ')); continue; }
  const ac = FL.build(r.def);
  if (!ac.surfaces || !ac.surfaces.length || ac.kind === 'quad' || ac.kind === 'heli') continue;
  check(f, ac);
}

/* And the build sheet, across its range: anything the builder generates has to come
   out clear too, or the first thing a new aircraft does in FPV is show you its own
   nose. Sweeps the fields the camera position is derived from. */
console.log('\n== aircraft the build sheet generates ==');
const SWEEP = [
  ['small wing', 'wing', { span: 600, rootChord: 180, fuseW: 40, fuseH: 36 }],
  ['big wing', 'wing', { span: 2400, rootChord: 600, fuseW: 150, fuseH: 130 }],
  ['short-nosed plane', 'plane', { span: 900, rootChord: 180, noseLen: 120, fuseW: 60, fuseH: 70 }],
  ['long-nosed plane', 'plane', { span: 2000, rootChord: 300, noseLen: 700, fuseW: 130, fuseH: 160 }],
  ['deep-bodied plane', 'plane', { span: 1400, rootChord: 260, noseLen: 300, fuseW: 150, fuseH: 220 }],
  ['slim plane', 'plane', { span: 1400, rootChord: 260, noseLen: 300, fuseW: 60, fuseH: 55 }],
  ['stock trainer', 'plane', {}],
  ['stock wing', 'wing', {}],
  ['camera set by hand', 'plane', { span: 2000, noseLen: 700, fuseH: 160, camX: 600, camZ: 110 }],
];
for (const [what, kind, over] of SWEEP) {
  // the builder stores only the fields you actually set and re-derives the rest,
  // so pass only the overrides - exactly what Settings → Build an aircraft does
  const sp = Object.assign({ kind }, over);
  let def = null;
  try { def = ACF.fromSpec(sp); } catch (e) { ok(false, what, 'could not generate: ' + e.message); continue; }
  if (!def) { ok(false, what, 'the build sheet rejected these numbers'); continue; }
  check(what, FL.build(def));
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
