/* Controller input tests. Run: node test/input_test.js

   The switch detector lives in src/app.js, which is a browser bundle with no exports,
   so this test cuts the block out of that file by its comment markers and evals it.
   That way the test can never drift from the code that actually ships: if someone
   renames or moves the function, this fails loudly instead of testing a stale copy. */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const m = src.match(/\/\* ---- switch-on-an-axis detector[\s\S]*?\/\* ---- end switch-on-an-axis detector ---- \*\//);
if (!m) { console.error('could not find the switch-on-an-axis detector block in src/app.js'); process.exit(1); }
const { axisStep, axisStart } = new Function(m[0] + '\nreturn { axisStep, axisStart };')();

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

const DT = 1 / 60; // the gamepad is polled once a frame
const hold = (v, n) => Array(n).fill(v);
const ramp = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);

// run a trace of axis values through the detector and collect what it would record
function record(trace) {
  let a = null;
  const hits = [];
  for (const v of trace) {
    if (!a) { a = axisStart(v); continue; }
    const hit = axisStep(a, v, DT);
    if (hit !== null) hits.push(hit);
  }
  return hits;
}

console.log('== switches and hats on an axis ==');
const CASES = [
  // what a RadioMaster radio in USB joystick mode actually sends
  ['3-position switch: mid, up, mid, down, mid', [...hold(0, 20), ...hold(1, 20), ...hold(0, 20), ...hold(-1, 20), ...hold(0, 20)], [1, 0, -1, 0]],
  ['2-position switch: low, high, low', [...hold(-1, 20), ...hold(1, 20), ...hold(-1, 20)], [1, -1]],
  ['3-position switch already flipped up when recording starts', [...hold(1, 20), ...hold(0, 20), ...hold(-1, 20)], [0, -1]],
  ['switch on a mixer line set to 50% weight', [...hold(0, 20), ...hold(0.5, 20), ...hold(-0.5, 20)], [0.5, -0.5]],
  ['6-position switch stepped up one notch at a time', [...hold(-1, 20), ...hold(-0.5, 20), ...hold(0, 20), ...hold(0.5, 20), ...hold(1, 20)], [-0.5, 0, 0.5, 1]],
  // a gamepad POV hat, which is what the old detector was written for
  ['POV hat: press right, release', [...hold(0, 20), ...hold(-3 / 7, 20), ...hold(0, 20)], [-0.43, 0]],
  ['switch flicked and let go fast (4 frames at the far end)', [...hold(0, 20), ...hold(1, 4), ...hold(0, 20)], [1, 0]],
];
for (const [what, trace, want] of CASES) {
  const got = record(trace);
  ok(JSON.stringify(got) === JSON.stringify(want), what, `recorded [${got.join(', ')}]${JSON.stringify(got) === JSON.stringify(want) ? '' : ` but wanted [${want.join(', ')}]`}`);
}

console.log('\n== things that are not switches, and must record nothing ==');
const QUIET = [
  ['a slider swept slowly end to end', [...hold(-1, 10), ...ramp(-1, 1, 60), ...hold(1, 20)]],
  ['a slider nudged a fifth of the way and held', [...hold(0, 20), ...ramp(0, 0.2, 8), ...hold(0.2, 20)]],
  ['stick noise around centre', Array.from({ length: 120 }, (_, i) => 0.02 * Math.sin(i))],
  ['an axis sitting still at an odd value', hold(0.37, 60)],
  ['a stick pushed to the corner and worked around it', [...hold(0, 10), ...ramp(0, 1, 30), ...ramp(1, -1, 40), ...ramp(-1, 0, 30), ...hold(0, 20)]],
];
for (const [what, trace] of QUIET) {
  const got = record(trace);
  ok(got.length === 0, what, got.length ? `recorded [${got.join(', ')}]` : 'quiet');
}

console.log('\n== holding a position does not re-record it ==');
{
  const got = record([...hold(0, 20), ...hold(1, 300), ...hold(0, 300)]);
  ok(JSON.stringify(got) === JSON.stringify([1, 0]), 'a switch held for five seconds records once per position', `recorded [${got.join(', ')}]`);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
