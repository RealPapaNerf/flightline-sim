/* Controller input tests. Run: node test/input_test.js

   The switch detector and the stick modes live in src/app.js, which is a browser
   bundle with no exports, so this test cuts each block out of that file by its comment
   markers and evals it. That way the test can never drift from the code that actually
   ships: if someone renames or moves a function, this fails loudly instead of testing
   a stale copy. */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const m = src.match(/\/\* ---- switch-on-an-axis detector[\s\S]*?\/\* ---- end switch-on-an-axis detector ---- \*\//);
if (!m) { console.error('could not find the switch-on-an-axis detector block in src/app.js'); process.exit(1); }
const { axisStep, axisStart } = new Function(m[0] + '\nreturn { axisStep, axisStart };')();
const sm = src.match(/\/\* ---- stick modes[\s\S]*?\/\* ---- end stick modes ---- \*\//);
if (!sm) { console.error('could not find the stick modes block in src/app.js'); process.exit(1); }
const { sticksFor, throttleStick, axisKeys, touchAxes } = new Function(sm[0] + '\nreturn { sticksFor, throttleStick, axisKeys, touchAxes };')();

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

/* The stick modes, as a pilot would say them rather than read back from the table
   under test. Each push starts with the sticks at rest (the throttle stick at the
   bottom, the other centred) and moves one stick to one edge: exactly one axis may
   move, the one the mode puts there. Up on a pitch stick is forward, nose down: -e. */
const SAY = { thr: 'throttle', e: 'pitch', a: 'roll', r: 'yaw' }, SIDE = { L: 'left', R: 'right' };
const MODES = [
  ['2', 'throttle and yaw on the left, pitch and roll on the right',
    [['L', 'up', 'thr', 1], ['L', 'right', 'r', 1], ['R', 'up', 'e', -1], ['R', 'down', 'e', 1], ['R', 'right', 'a', 1]]],
  ['1', 'pitch and yaw on the left, throttle and roll on the right',
    [['L', 'up', 'e', -1], ['L', 'down', 'e', 1], ['L', 'right', 'r', 1], ['R', 'up', 'thr', 1], ['R', 'right', 'a', 1]]],
  ['3', 'pitch and roll on the left, throttle and yaw on the right',
    [['L', 'up', 'e', -1], ['L', 'down', 'e', 1], ['L', 'right', 'a', 1], ['R', 'up', 'thr', 1], ['R', 'right', 'r', 1]]],
];

console.log('\n== stick modes: the layout ==');
for (const [mode, says] of MODES) {
  const s = sticksFor(mode), [l, r] = [s.L, s.R].map((x) => x.map((k) => SAY[k]).join(' and '));
  ok(`${l} on the left, ${r} on the right` === says, `Mode ${mode} is ${says}`, `left ${l}, right ${r}`);
  const ud = [s.L[0], s.R[0]].sort().join(), lr = [s.L[1], s.R[1]].sort().join();
  ok(ud === 'e,thr' && lr === 'a,r', `Mode ${mode} has one up-down and one left-right axis on each stick, and every axis once`, `up-down ${ud}, left-right ${lr}`);
}
ok(throttleStick('2') === 'L' && throttleStick('1') === 'R' && throttleStick('3') === 'R', 'the throttle, which stays where you leave it, is on the left stick in Mode 2 and the right in Modes 1 and 3',
  ['2', '1', '3'].map((x) => `Mode ${x} ${throttleStick(x)}`).join(', '));
ok(JSON.stringify(sticksFor('7')) === JSON.stringify(sticksFor('2')) && JSON.stringify(sticksFor(undefined)) === JSON.stringify(sticksFor('2')),
  'a stick mode this build does not know flies as Mode 2', JSON.stringify(sticksFor('7')));

console.log('\n== stick modes: the touch sticks ==');
for (const [mode, , pushes] of MODES) {
  const thrSide = pushes.find((p) => p[2] === 'thr')[0];
  const rest = () => ({ L: { x: 0, y: thrSide === 'L' ? 1 : 0 }, R: { x: 0, y: thrSide === 'R' ? 1 : 0 } });
  const r0 = touchAxes(mode, rest().L, rest().R);
  ok(['thr', 'e', 'a', 'r'].every((k) => r0[k] === 0), `Mode ${mode} at rest: throttle at idle and nothing else moving`, ['thr', 'e', 'a', 'r'].map((k) => `${SAY[k]} ${r0[k]}`).join(', '));
  for (const [side, dir, ax, want] of pushes) {
    const s = rest();
    if (dir === 'up') s[side].y = -1; else if (dir === 'down') s[side].y = 1; else s[side].x = 1;
    const got = touchAxes(mode, s.L, s.R), others = ['thr', 'e', 'a', 'r'].filter((k) => k !== ax && got[k] !== 0);
    ok(got[ax] === want && !others.length, `Mode ${mode}: ${SIDE[side]} stick ${dir} takes ${SAY[ax]} to ${want > 0 ? '+' : ''}${want} and moves nothing else`,
      `${SAY[ax]} ${got[ax]}${others.length ? `, but ${others.map((k) => `${SAY[k]} ${got[k]}`).join(', ')} as well` : ''}`);
  }
}
{
  const at = (y) => touchAxes('3', { x: 0, y: 0 }, { x: 0, y }).thr;
  ok(at(1) === 0 && at(0) === 0.5 && at(-1) === 1, 'the throttle reads nothing at the bottom of its stick, half in the middle and full at the top', `${at(1)} / ${at(0)} / ${at(-1)}`);
}

console.log('\n== stick modes: the keyboard ==');
// the keys table in the README: WASD is the left stick, the arrows the right
const KEYS = {
  2: { thr: 'W / S', e: '↑ / ↓', a: '← / →', r: 'A / D' },
  1: { thr: '↑ / ↓', e: 'W / S', a: '← / →', r: 'A / D' },
  3: { thr: '↑ / ↓', e: 'W / S', a: 'A / D', r: '← / →' },
};
const KEY = { KeyW: 'W', KeyS: 'S', KeyA: 'A', KeyD: 'D', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const keyLine = (o) => ['thr', 'e', 'a', 'r'].map((x) => `${SAY[x]} ${o[x]}`).join(', ');
for (const [mode, want] of Object.entries(KEYS)) {
  const k = axisKeys(mode);
  const got = { thr: `${KEY[k.thr.up]} / ${KEY[k.thr.down]}`, e: `${KEY[k.e.up]} / ${KEY[k.e.down]}`, a: `${KEY[k.a.left]} / ${KEY[k.a.right]}`, r: `${KEY[k.r.left]} / ${KEY[k.r.right]}` };
  ok(keyLine(got) === keyLine(want), `Mode ${mode}: ${keyLine(want)}`, keyLine(got) === keyLine(want) ? '' : `got ${keyLine(got)}`);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
