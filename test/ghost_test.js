/* Ghost lap recording, quantisation and storage. Run: node test/ghost_test.js */
const FL = require('../src/physics.js');
const GH = require('../src/ghost.js');
const line = (...a) => console.log(...a);
let bad = 0;
const check = (ok, what, detail) => { line(`${ok ? ' ok ' : 'FAIL'}  ${what}${detail ? '  (' + detail + ')' : ''}`); if (!ok) bad++; };
const D2R = Math.PI / 180;

/* A flown lap to record: a climbing, banking circuit with a rolling attitude and
   a throttle that moves, sampled at an uneven frame rate like a real browser. */
function truth(t) {
  const w = (2 * Math.PI) / 24, r = 80;
  const n = r * Math.cos(w * t), e = r * Math.sin(w * t), d = -(30 + 8 * Math.sin(w * t * 2));
  const yaw = w * t + Math.PI / 2, roll = 35 * D2R * Math.sin(w * t * 1.5), pitch = 8 * D2R * Math.cos(w * t * 2);
  return { p: [n, e, d], q: FL.quatFromEuler(roll, pitch, yaw), thr: 0.5 + 0.35 * Math.sin(w * t * 3) };
}
const angBetween = (a, b) => { // angle between two quaternions, degrees
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
};

const LAP = 24, GATES = 8;
function record(rate, frameDt) {
  const rec = GH.recorder({ aircraft: 'quad5', course: 'oval8', pilot: 'bench', rate });
  rec.begin(0, truth(0));
  let t = 0, next = 1;
  while (t < LAP) {
    t = Math.min(LAP, t + frameDt());
    rec.push(t, truth(t));
    while (next < GATES && t >= (next * LAP) / GATES) { rec.split(next, (next * LAP) / GATES); next++; }
  }
  return rec.end(LAP);
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const jitter = () => 1 / 60 + (rnd() - 0.5) * 0.012; // ~60 fps, uneven

line('== Recording ==');
const lap = record(GH.RATE, jitter);
check(!!lap, 'a lap is recorded');
check(lap.samples.length === LAP * GH.RATE + 1, 'samples land on the 20 Hz grid', `${lap.samples.length} samples for ${LAP} s`);
check(Math.abs(lap.time - LAP) < 1e-9, 'lap time kept', `${lap.time.toFixed(3)} s`);
check(lap.splits.length === GATES && lap.splits[0] === 0, 'a split per gate', lap.splits.map((s) => s.toFixed(2)).join(' '));

// the grid is the same however fast the frames came
const slow = record(GH.RATE, () => 0.1), fast = record(GH.RATE, () => 1 / 240);
check(slow.samples.length === lap.samples.length && fast.samples.length === lap.samples.length, 'same sample count at 10, 60 and 240 fps');
let gridErr = 0;
for (const r of [lap, fast]) for (let i = 0; i < r.samples.length; i++) {
  const T = truth(i / GH.RATE), s = r.samples[i];
  gridErr = Math.max(gridErr, Math.hypot(s.p[0] - T.p[0], s.p[1] - T.p[1], s.p[2] - T.p[2]));
}
check(gridErr < 0.05, 'grid samples sit on the flown path', `max ${(gridErr * 1000).toFixed(1)} mm off`);

line('');
line('== Quantisation ==');
const file = GH.encode(lap), back = GH.decode(file);
check(!!back, 'encode → decode');
let pe = 0, qe = 0, te = 0;
for (let i = 0; i < lap.samples.length; i++) {
  const a = lap.samples[i], b = back.samples[i];
  pe = Math.max(pe, Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]));
  qe = Math.max(qe, angBetween(a.q, b.q));
  te = Math.max(te, Math.abs(a.thr - b.thr));
}
check(pe < 0.002, 'position within 2 mm', `max ${(pe * 1000).toFixed(2)} mm`);
check(qe < 0.02, 'attitude within 0.02°', `max ${qe.toFixed(4)}°`);
check(te < 0.003, 'throttle within 0.3%', `max ${(te * 100).toFixed(2)}%`);
check(back.splits.every((s, i) => Math.abs(s - lap.splits[i]) < 0.001), 'gate splits within 1 ms');
check(Math.abs(back.time - lap.time) < 0.001, 'lap time within 1 ms');

const txt = GH.toText(lap), kbMin = (txt.length / 1024 / (LAP / 60));
line(`     file ${(txt.length / 1024).toFixed(1)} KB for a ${LAP} s lap = ${kbMin.toFixed(1)} KB a minute (${GH.bytes(lap)} B binary)`);
check(kbMin < 30, 'under 30 KB a minute');
check(!!GH.fromText(txt), 'round-trips through text');

line('');
line('== Playback ==');
const pl = GH.player(back);
let ie = 0;
for (let t = 0; t <= LAP; t += 0.017) {
  const T = truth(t), g = pl.at(t);
  ie = Math.max(ie, Math.hypot(g.p[0] - T.p[0], g.p[1] - T.p[1], g.p[2] - T.p[2]));
}
check(ie < 0.35, 'interpolated ghost tracks the path between samples', `max ${(ie * 100).toFixed(1)} cm`);
check(pl.at(-5).p[0] === back.samples[0].p[0], 'held before the start');
check(pl.at(LAP + 5).done === true, 'reports done past the end');
check(Math.abs(pl.split(4) - (4 * LAP) / GATES) < 0.002, 'split time read back');

line('');
line('== Bad input ==');
for (const [what, o] of [['null', null], ['wrong format', { f: 'nope', v: 1 }],
  ['future version', Object.assign({}, file, { v: 9 })],
  ['truncated blob', Object.assign({}, file, { d: file.d.slice(0, 40) })],
  ['no samples', Object.assign({}, file, { n: 0 })],
  ['junk base64', Object.assign({}, file, { d: '!!!!' })]])
  check(GH.decode(o) === null, `refuses ${what}`);
check(GH.fromText('{not json') === null, 'refuses junk text');

line('');
line('== Storage ==');
function mem(limit) { // stand-in for localStorage, with a quota
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i],
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { if (limit && v.length > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); } };
}
const s1 = mem(0), store = GH.laps(s1);
check(store.put('oval8', 'quad5', lap) === true, 'saves a lap');
const got = store.get('oval8', 'quad5');
check(got && Math.abs(got.time - lap.time) < 0.001 && got.samples.length === lap.samples.length, 'reads it back');
check(store.get('oval8', 'goblin') === null, 'nothing for an aircraft with no lap');
store.put('oval8', 'goblin', Object.assign({}, lap, { aircraft: 'goblin' }));
check(store.list().length === 2, 'lists stored laps', store.list().map((l) => l.course + '/' + l.slot).join(' '));
check(store.list().every((l) => l.course === 'oval8' && l.slot), 'listed laps know their course and slot');
store.put('oval8', 'quad5@kim', Object.assign({}, lap, { pilot: 'kim' }));
check(store.get('oval8', 'quad5@kim').pilot === 'kim', 'a friend\u2019s lap sits in its own slot');
store.del('oval8', 'quad5@kim');
store.del('oval8', 'goblin');
check(store.list().length === 1, 'deletes one');
s1.setItem('flightline.lap.v1.oval8|trainer', '{broken');
check(store.get('oval8', 'trainer') === null && store.list().length === 1, 'skips a corrupt entry');
check(GH.laps(mem(100)).put('oval8', 'quad5', lap) === false, 'reports a full quota instead of throwing');
const blocked = GH.laps(null);
check(blocked.get('a', 'b') === null && blocked.put('a', 'b', lap) === false && blocked.list().length === 0, 'survives storage being blocked');

line('');
line(bad ? `${bad} check(s) failed` : 'all checks passed');
process.exit(bad ? 1 : 0);
