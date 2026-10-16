/* Live racing: state blob, clock sync, interpolation, bandwidth.
   Run: node test/net_test.js   (no network: a virtual relay on a virtual clock) */
const FL = require('../src/physics.js');
const NET = require('../src/net.js');
const line = (...a) => console.log(...a);
let bad = 0;
const check = (ok, what, detail) => { line(`${ok ? ' ok ' : 'FAIL'}  ${what}${detail ? '  (' + detail + ')' : ''}`); if (!ok) bad++; };
const angBetween = (a, b) => { const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])); return (2 * Math.acos(d) * 180) / Math.PI; };

/* ---- a relay on a virtual clock: every frame of every peer is deterministic ---- */
let VT = 0; // virtual milliseconds
const wire = { q: [], latency: 60, jitter: 0, loss: 0, ends: [] };
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function testTransport(cfg) {
  const tr = { onMessage: null, onStatus: null, bytes: { up: 0, down: 0 }, msgs: { up: 0, down: 0 } };
  tr.connect = () => { wire.ends.push(tr); if (tr.onStatus) tr.onStatus('open', 'test'); return Promise.resolve(); };
  tr.send = (o) => {
    const txt = JSON.stringify(o);
    tr.bytes.up += txt.length; tr.msgs.up++;
    if (wire.loss && rnd() < wire.loss) return;
    wire.q.push({ at: VT + wire.latency + (wire.jitter ? (rnd() - 0.5) * wire.jitter : 0), from: tr, txt });
  };
  tr.close = () => { wire.ends = wire.ends.filter((e) => e !== tr); if (tr.onStatus) tr.onStatus('closed'); };
  return tr;
}
NET.TRANSPORTS.test = { name: 'test', make: testTransport, help: '' };
function pump() {
  const due = wire.q.filter((m) => m.at <= VT);
  wire.q = wire.q.filter((m) => m.at > VT);
  for (const m of due) for (const e of wire.ends) {
    if (e === m.from) continue;
    e.bytes.down += m.txt.length; e.msgs.down++;
    if (e.onMessage) e.onMessage(JSON.parse(m.txt));
  }
}

line('== State blob ==');
{
  const s = { c: 1234567, p: [123.456, -78.901, -34.567], q: FL.quatFromEuler(0.4, -0.2, 2.1), v: [21.3, -4.5, 1.25], thr: 0.63, flags: 3 };
  const txt = NET.packState(s), back = NET.unpackState(txt);
  check(txt.length === 44, 'a state is 44 characters of base64', `${NET.STATE_BYTES} bytes`);
  check(back.c === s.c, 'clock kept to the millisecond');
  const pe = Math.hypot(back.p[0] - s.p[0], back.p[1] - s.p[1], back.p[2] - s.p[2]);
  check(pe < 0.002, 'position within 2 mm', `${(pe * 1000).toFixed(2)} mm`);
  check(angBetween(back.q, s.q) < 0.02, 'attitude within 0.02°', `${angBetween(back.q, s.q).toFixed(4)}°`);
  check(Math.max(...[0, 1, 2].map((i) => Math.abs(back.v[i] - s.v[i]))) <= 0.005, 'velocity within 5 mm/s');
  check(Math.abs(back.thr - s.thr) < 0.004 && back.flags === 3, 'throttle and flags kept');
  check(NET.unpackState('rubbish') === null, 'refuses a short blob');
  const frame = JSON.stringify({ t: 's', i: 'ab12cd', d: txt });
  line(`     one state frame is ${frame.length} B of JSON → ${((frame.length * 20) / 1024).toFixed(1)} KB/s a pilot at 20 Hz`);
}

line('');
line('== Two pilots in a room ==');
const mk = (id, name, skew) => NET.room({ transport: 'test', room: 'TEST', id, name, aircraft: 'quad', clock: () => VT + skew, rate: 20, delay: 120 });
const A = mk('aaa', 'ann', 0), B = mk('bbb', 'bob', 1234567); // B's clock is 20 minutes out
A.connect(); B.connect();
// a flown path both ends agree on
const path = (t) => { const w = 0.5, r = 60; return { p: [r * Math.cos(w * t), r * Math.sin(w * t), -25 - 3 * Math.sin(w * t)], q: FL.quatFromEuler(0.3 * Math.sin(w * t), 0, w * t), v: [-r * w * Math.sin(w * t), r * w * Math.cos(w * t), -3 * w * Math.cos(w * t)], thr: 0.6 }; };
const FRAME = 1000 / 60;
let worst = 0, lag = [], drawn = 0, want = 0;
for (let i = 0; i < 60 * 12; i++) { // twelve seconds at 60 fps
  VT += FRAME;
  pump();
  const t = VT / 1000;
  A.tick(FRAME / 1000, path(t));
  B.tick(FRAME / 1000, path(t));
  const seen = A.peers.get('bbb');
  if (i > 120) want++;
  if (i > 120 && seen && seen.view) {
    drawn++;
    // where B really was when A draws it: the interpolation delay behind now
    let best = 1e9, bestDt = 0;
    for (let dt = 0; dt < 400; dt += 2) { const tr = path((VT - dt) / 1000); const d = Math.hypot(tr.p[0] - seen.view.p[0], tr.p[1] - seen.view.p[1], tr.p[2] - seen.view.p[2]); if (d < best) { best = d; bestDt = dt; } }
    worst = Math.max(worst, best);
    lag.push(bestDt);
  }
}
const pB = A.peers.get('bbb'), pA = B.peers.get('aaa');
check(!!pB && pB.name === 'bob', 'each pilot sees the other', pB && `${pB.name} flying the ${pB.ac}`);
check(pB && Math.abs(pB.offset - 1234567) < 15, 'clock offset found through the delay', pB && `${Math.round(pB.offset)} ms vs 1234567`);
check(pB && Math.abs(pB.rtt - 120) < 25, 'round trip measured', pB && `${pB.rtt} ms (120 ms on the wire)`);
check(pA && Math.abs(pA.offset + 1234567) < 15, 'and the same the other way');
const meanLag = lag.reduce((a, b) => a + b, 0) / lag.length;
check(worst < 0.5, 'drawn within half a metre of the path flown', `worst ${(worst * 100).toFixed(0)} cm`);
check(meanLag > 120 && meanLag < 260, 'drawn one buffer behind, not more', `${Math.round(meanLag)} ms behind (60 ms wire + 120 ms buffer)`);
check(drawn === want, 'a place to draw on every frame', `${drawn} of ${want} frames`);
line(`     bandwidth: ${A.stats.upBps} B/s up, ${A.stats.downBps} B/s down a pilot at ${A.stats.rate} state messages a second`);
check(A.stats.upBps < 3000, 'under 3 KB/s up a pilot');

line('');
line('== A rough connection ==');
{
  wire.latency = 150; wire.jitter = 80; wire.loss = 0.1;
  let gaps = 0, far = 0, frames = 0;
  for (let i = 0; i < 60 * 8; i++) {
    VT += FRAME; pump();
    A.tick(FRAME / 1000, path(VT / 1000)); B.tick(FRAME / 1000, path(VT / 1000));
    const v = A.peers.get('bbb').view;
    frames++;
    if (!v) { gaps++; continue; }
    let best = 1e9;
    for (let dt = 0; dt < 700; dt += 5) { const tr = path((VT - dt) / 1000); best = Math.min(best, Math.hypot(tr.p[0] - v.p[0], tr.p[1] - v.p[1], tr.p[2] - v.p[2])); }
    far = Math.max(far, best);
  }
  check(gaps / frames < 0.02, 'still drawn with 150±80 ms and one packet in ten lost', `${((gaps / frames) * 100).toFixed(1)}% of frames with nothing to draw`);
  check(far < 1.5, 'and stays near the path', `worst ${far.toFixed(2)} m`);
}

line('');
line('== Resets and silence ==');
{
  const p = { buf: [], offset: 0 };
  const push = (t, x) => p.buf.push({ t, p: [x, 0, -20], q: [1, 0, 0, 0], v: [10, 0, 0], thr: 0.5, flags: 0 });
  for (let i = 0; i < 5; i++) push(i * 50, i * 0.5);
  const mid = NET.sampleAt(p, 125, 250);
  check(Math.abs(mid.p[0] - 1.25) < 1e-6, 'interpolates between samples', `x ${mid.p[0]}`);
  const ext = NET.sampleAt(p, 300, 250);
  check(ext && Math.abs(ext.p[0] - (2 + 10 * 0.1)) < 1e-6 && ext.extrap === 100, 'carries on from the last sample on velocity');
  check(NET.sampleAt(p, 700, 250) === null, 'gives up after the extrapolation window');
  check(NET.sampleAt({ buf: [] }, 100, 250) === null, 'nothing to draw before the first message');
  // a reset teleports the aircraft: the buffer is thrown away, not interpolated through
  const R2 = NET.room({ transport: 'test', room: 'T2', id: 'ccc', clock: () => VT });
  R2.connect();
  const mkState = (c, x) => ({ t: 's', i: 'ddd', d: NET.packState({ c, p: [x, 0, -20], q: [1, 0, 0, 0], v: [0, 0, 0], thr: 0, flags: 0 }) });
  R2.peers.clear();
  for (let i = 0; i < 4; i++) { VT += 50; wire.ends.forEach(() => {}); R2.tick(0.05, null); testDeliver(R2, mkState(VT, i)); }
  const before = R2.peers.get('ddd').buf.length;
  VT += 50; testDeliver(R2, mkState(VT, 900));
  check(before >= 3 && R2.peers.get('ddd').buf.length === 1, 'a reset empties the buffer instead of flying across the field', `${before} → 1`);
  R2.leave();
}
function testDeliver(R, msg) { for (const e of wire.ends) if (e.onMessage) e.onMessage(msg); }

A.leave(); B.leave();
line('');
line(bad ? `${bad} check(s) failed` : 'all checks passed');
process.exit(bad ? 1 : 0);
