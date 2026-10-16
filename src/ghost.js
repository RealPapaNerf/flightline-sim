/* =====================================================================
   Flightline ghost laps — recording, quantisation, playback, storage.
   Pure JavaScript (no DOM); the browser's localStorage is passed in.

   A lap is sampled on a fixed grid (20 Hz by default) from the moment the
   aircraft crosses gate 1 to the moment it comes back round to it, so
   sample i is always at t = i / rate and the file carries no timestamps.

   Wire format "flightline-lap" v1: a small JSON envelope (aircraft,
   course, lap time, gate splits) around one base64 blob of samples:

     bytes 0..11   int32  first position, mm, NED  (n, e, d)
     then per sample, 15 bytes:
       int16 x3   position step from the previous sample, mm
       int16 x4   attitude quaternion (w, x, y, z), 1/32767
       uint8      throttle, 1/255

   Steps are taken between rounded millimetre positions, so the error
   never accumulates: every sample decodes to within half a millimetre of
   where it was recorded, and the attitude to within about 0.005°.
   ===================================================================== */
const GH = (function () {
  'use strict';
  const RATE = 20;            // samples a second
  const MAX_SECS = 600;       // never record more than ten minutes of lap
  const STRIDE = 15;          // bytes per sample
  const POS = 1000;           // position quantum: 1 mm
  const QSC = 32767;          // quaternion quantum: 1 / 32767
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const i16 = (x) => clamp(Math.round(x), -32768, 32767);

  /* ---------------------------------------------------------------- base64 */
  // Own codec so laps encode the same in the browser and in node.
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const INV = (() => { const m = {}; for (let i = 0; i < 64; i++) m[A[i]] = i; return m; })();
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i], b = u8[i + 1], c = u8[i + 2], n = i + 1 < u8.length, o = i + 2 < u8.length;
      s += A[a >> 2] + A[((a & 3) << 4) | (n ? b >> 4 : 0)] + (n ? A[((b & 15) << 2) | (o ? c >> 6 : 0)] : '=') + (o ? A[c & 63] : '=');
    }
    return s;
  }
  function unb64(s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let k = 0;
    for (let i = 0; i < s.length; i += 4) {
      const a = INV[s[i]], b = INV[s[i + 1]], c = INV[s[i + 2]], d = INV[s[i + 3]];
      if (a === undefined || b === undefined) break;
      out[k++] = (a << 2) | (b >> 4);
      if (c !== undefined) out[k++] = ((b & 15) << 4) | (c >> 2);
      if (d !== undefined) out[k++] = ((c & 3) << 6) | d;
    }
    return k === out.length ? out : out.subarray(0, k);
  }

  /* ---------------------------------------------------------------- samples */
  const nlerp = (a, b, t) => {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
    if (d < 0) { s = -1; d = -d; }
    const o = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t];
    const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
  };
  // keep consecutive quaternions in one hemisphere so interpolation takes the short way
  const near = (q, ref) => (ref && q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);

  function pack(samples) {
    const n = samples.length;
    if (!n) return new Uint8Array(0);
    const u8 = new Uint8Array(12 + STRIDE * n), dv = new DataView(u8.buffer);
    const first = samples[0].p.map((v) => Math.round(v * POS));
    for (let a = 0; a < 3; a++) dv.setInt32(a * 4, first[a], true);
    const prev = first.slice(); // the position as it will decode, so steps never drift
    for (let i = 0; i < n; i++) {
      const s = samples[i], o = 12 + i * STRIDE;
      for (let a = 0; a < 3; a++) {
        const d = i ? i16(Math.round(s.p[a] * POS) - prev[a]) : 0;
        dv.setInt16(o + a * 2, d, true);
        prev[a] += d;
      }
      for (let a = 0; a < 4; a++) dv.setInt16(o + 6 + a * 2, i16(clamp(s.q[a], -1, 1) * QSC), true);
      u8[o + 14] = clamp(Math.round(s.thr * 255), 0, 255);
    }
    return u8;
  }
  function unpack(u8, n) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
    const p = [dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)];
    for (let i = 0; i < n; i++) {
      const o = 12 + i * STRIDE;
      if (i) for (let a = 0; a < 3; a++) p[a] += dv.getInt16(o + a * 2, true);
      const q = [0, 0, 0, 0];
      for (let a = 0; a < 4; a++) q[a] = dv.getInt16(o + 6 + a * 2, true) / QSC;
      const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      out.push({ p: [p[0] / POS, p[1] / POS, p[2] / POS], q: [q[0] / l, q[1] / l, q[2] / l, q[3] / l], thr: u8[o + 14] / 255 });
    }
    return out;
  }

  /* ---------------------------------------------------------------- recorder */
  /* Driven by the sim: begin() on the gate-1 crossing that starts a lap, push()
     every frame, split() at each gate, end() on the crossing that closes it.
     push() lands samples exactly on the grid by interpolating between frames,
     so the recording is the same whatever frame rate the sim ran at. */
  function recorder(meta) {
    const rate = meta && meta.rate ? meta.rate : RATE, grid = 1 / rate, cap = Math.ceil(MAX_SECS * rate);
    let on = false, t0 = 0, prev = null, S = [], splits = [];
    const look = (s) => ({ p: [s.p[0], s.p[1], s.p[2]], q: near([s.q[0], s.q[1], s.q[2], s.q[3]], prev ? prev.v.q : null), thr: clamp(s.thr === undefined ? 0 : s.thr, 0, 1) });
    const add = (v) => { if (S.length < cap) S.push(v); };
    return {
      get active() { return on; },
      get count() { return S.length; },
      get rate() { return rate; },
      begin(clock, s) { on = true; t0 = clock; S = []; splits = [0]; prev = null; add(look(s)); prev = { t: 0, v: S[0] }; },
      // interpolate onto every grid time the frame stepped over
      push(clock, s) {
        if (!on) return;
        const t = clock - t0, now = look(s);
        if (!prev || t <= prev.t) { prev = { t, v: now }; return; }
        for (let k = S.length; k * grid <= t + 1e-9 && S.length < cap; k++) {
          const u = clamp((k * grid - prev.t) / (t - prev.t), 0, 1), a = prev.v;
          add({ p: [a.p[0] + (now.p[0] - a.p[0]) * u, a.p[1] + (now.p[1] - a.p[1]) * u, a.p[2] + (now.p[2] - a.p[2]) * u],
            q: nlerp(a.q, now.q, u), thr: a.thr + (now.thr - a.thr) * u });
        }
        prev = { t, v: now };
      },
      split(gate, clock) { if (on && gate > 0) splits[gate] = clock - t0; },
      abort() { on = false; S = []; splits = []; prev = null; },
      // close the lap; returns null if it is too short or lost samples
      end(clock) {
        if (!on) return null;
        const time = clock - t0;
        on = false;
        if (!(time > 0.5) || S.length < 2 || S.length >= cap) { S = []; return null; }
        const lap = { v: 1, aircraft: meta.aircraft, course: meta.course, rate, time, splits: splits.slice(), date: Date.now(), pilot: meta.pilot || '', samples: S };
        S = []; splits = []; prev = null;
        return lap;
      },
    };
  }

  /* ---------------------------------------------------------------- playback */
  function player(lap) {
    const S = lap.samples, n = S.length, rate = lap.rate || RATE, last = (n - 1) / rate;
    return {
      lap,
      get span() { return last; },
      // state at lap time t, interpolated; held at the ends
      at(t) {
        if (!n) return null;
        const u = clamp(t, 0, last) * rate, i = Math.min(n - 1, Math.floor(u)), j = Math.min(n - 1, i + 1), f = u - i;
        const a = S[i], b = S[j];
        return { p: [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f],
          q: nlerp(a.q, b.q, f), thr: a.thr + (b.thr - a.thr) * f, done: t > last };
      },
      split(gate) { const s = lap.splits && lap.splits[gate]; return typeof s === 'number' ? s : null; },
    };
  }

  /* ---------------------------------------------------------------- files */
  const FMT = 'flightline-lap';
  function encode(lap) {
    const u8 = pack(lap.samples);
    return { f: FMT, v: 1, course: lap.course, aircraft: lap.aircraft, pilot: lap.pilot || '', rate: lap.rate || RATE,
      ms: Math.round(lap.time * 1000), splits: (lap.splits || []).map((s) => Math.round(s * 1000)), date: lap.date || Date.now(),
      n: lap.samples.length, d: b64(u8) };
  }
  function decode(o) {
    try {
      if (!o || o.f !== FMT || o.v !== 1) return null;
      const n = o.n | 0, rate = o.rate || RATE;
      if (!(n >= 2) || !(rate > 0) || !(o.ms > 0) || typeof o.d !== 'string') return null;
      const u8 = unb64(o.d);
      if (u8.length < 12 + STRIDE * n) return null;
      const samples = unpack(u8, n);
      for (const s of samples) if (!s.p.every(Number.isFinite) || !s.q.every(Number.isFinite)) return null;
      return { v: 1, aircraft: String(o.aircraft || ''), course: String(o.course || ''), pilot: String(o.pilot || '').slice(0, 24),
        rate, time: o.ms / 1000, splits: (Array.isArray(o.splits) ? o.splits : []).map((m) => m / 1000), date: o.date || Date.now(), samples };
    } catch (e) { return null; }
  }
  const toText = (lap) => JSON.stringify(encode(lap));
  function fromText(txt) { try { return decode(JSON.parse(txt)); } catch (e) { return null; } }
  const fileName = (lap) => `${lap.course || 'course'}-${lap.aircraft || 'aircraft'}-${(lap.time || 0).toFixed(2)}s.flap.json`;
  const bytes = (lap) => 12 + STRIDE * lap.samples.length;

  /* ---------------------------------------------------------------- storage */
  /* Best lap per course and aircraft, one key each so a save rewrites only that
     lap. Every read and write is wrapped: storage can be full, blocked by the
     browser, or hold something another version wrote. */
  function laps(storage) {
    const PRE = 'flightline.lap.v1.';
    const key = (course, slot) => PRE + course + '|' + slot;
    const read = (k) => { try { const t = storage.getItem(k); return t ? decode(JSON.parse(t)) : null; } catch (e) { return null; } };
    return {
      available: !!storage,
      // slot: the aircraft id for your own best lap, 'aircraft@pilot' for a lap someone sent you
      get(course, slot) {
        if (!storage) return null;
        const lap = read(key(course, slot));
        if (lap) { lap.course = lap.course || course; lap.slot = slot; }
        return lap;
      },
      put(course, slot, lap) {
        if (!storage) return false;
        try { storage.setItem(key(course, slot), toText(lap)); return true; } catch (e) { return false; }
      },
      del(course, slot) { try { storage.removeItem(key(course, slot)); return true; } catch (e) { return false; } },
      // every stored lap, quickest first; bad entries are skipped, not thrown
      list() {
        const out = [];
        if (!storage) return out;
        try {
          const keys = [];
          for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.indexOf(PRE) === 0) keys.push(k); }
          for (const k of keys) {
            const rest = k.slice(PRE.length), cut = rest.indexOf('|');
            if (cut < 0) continue;
            const lap = read(k);
            if (!lap) continue;
            lap.course = rest.slice(0, cut); lap.slot = rest.slice(cut + 1);
            out.push(lap);
          }
        } catch (e) { /* storage blocked */ }
        return out.sort((a, b) => a.course.localeCompare(b.course) || a.time - b.time);
      },
    };
  }

  return { RATE, STRIDE, recorder, player, encode, decode, toText, fromText, fileName, bytes, laps, pack, unpack, b64, unb64, nlerp };
})();
if (typeof module !== 'undefined') module.exports = GH;
