/* =====================================================================
   Flightline live racing — transport, room, clock sync, interpolation.
   Pure JavaScript (no DOM, no sim): the page passes its own state in and
   reads other pilots out. Nothing here opens a connection until the page
   asks it to, so the sim runs exactly as before when you fly alone.

   Transports all look the same to the room, so the relay can be swapped:

     local     a BroadcastChannel — two tabs or two windows on one machine,
               no server and no internet
     supabase  a Supabase Realtime broadcast channel; supabase-js is loaded
               from a CDN at a pinned version the first time you connect
     ws        any WebSocket relay that echoes a room's frames to the room
               (a Cloudflare Worker, a few lines of node)

   A transport is { connect(), send(obj), close(), onMessage, onStatus }.
   It never looks inside a message; the room owns the protocol.

   Protocol, all small JSON frames:
     j  join / profile, also a heartbeat every 2 s
     s  state, 20 a second: a 32-byte binary blob in base64
     q  ping, a  ping answer   (clock offset and round trip per pilot)
     g  go: the shared countdown, in the sender's clock
     l  lap done, x  leaving
   ===================================================================== */
const NET = (function () {
  'use strict';
  const PROTO = 1;
  // supabase-js, pinned exactly; jsdelivr's +esm build is self-contained
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
  const STATE_BYTES = 32;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const i16 = (x) => clamp(Math.round(x), -32768, 32767);
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /* ---------------------------------------------------------------- base64 */
  const A64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const INV64 = (() => { const m = {}; for (let i = 0; i < 64; i++) m[A64[i]] = i; return m; })();
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i], b = u8[i + 1], c = u8[i + 2], n = i + 1 < u8.length, o = i + 2 < u8.length;
      s += A64[a >> 2] + A64[((a & 3) << 4) | (n ? b >> 4 : 0)] + (n ? A64[((b & 15) << 2) | (o ? c >> 6 : 0)] : '=') + (o ? A64[c & 63] : '=');
    }
    return s;
  }
  function unb64(s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let k = 0;
    for (let i = 0; i < s.length; i += 4) {
      const a = INV64[s[i]], b = INV64[s[i + 1]], c = INV64[s[i + 2]], d = INV64[s[i + 3]];
      if (a === undefined || b === undefined) break;
      out[k++] = (a << 2) | (b >> 4);
      if (c !== undefined) out[k++] = ((b & 15) << 4) | (c >> 2);
      if (d !== undefined) out[k++] = ((c & 3) << 6) | d;
    }
    return k === out.length ? out : out.subarray(0, k);
  }

  /* ---------------------------------------------------------------- state blob
     32 bytes: the sender's clock (ms), position (mm, NED), attitude, velocity
     (cm/s) and throttle. 44 characters of base64 — about a fifth of what the
     same numbers cost as JSON. */
  function packState(s) {
    const u8 = new Uint8Array(STATE_BYTES), dv = new DataView(u8.buffer);
    dv.setUint32(0, s.c >>> 0, true);
    for (let a = 0; a < 3; a++) dv.setInt32(4 + a * 4, clamp(Math.round(s.p[a] * 1000), -2147483648, 2147483647), true);
    for (let a = 0; a < 4; a++) dv.setInt16(16 + a * 2, i16(clamp(s.q[a], -1, 1) * 32767), true);
    for (let a = 0; a < 3; a++) dv.setInt16(24 + a * 2, i16(s.v[a] * 100), true);
    u8[30] = clamp(Math.round(s.thr * 255), 0, 255);
    u8[31] = s.flags & 255;
    return b64(u8);
  }
  function unpackState(str) {
    const u8 = unb64(str);
    if (u8.length < STATE_BYTES) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const q = [0, 0, 0, 0];
    for (let a = 0; a < 4; a++) q[a] = dv.getInt16(16 + a * 2, true) / 32767;
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return { c: dv.getUint32(0, true),
      p: [dv.getInt32(4, true) / 1000, dv.getInt32(8, true) / 1000, dv.getInt32(12, true) / 1000],
      q: [q[0] / l, q[1] / l, q[2] / l, q[3] / l],
      v: [dv.getInt16(24, true) / 100, dv.getInt16(26, true) / 100, dv.getInt16(28, true) / 100],
      thr: u8[30] / 255, flags: u8[31] };
  }

  /* ---------------------------------------------------------------- transports */
  const base = () => ({ onMessage: null, onStatus: null, bytes: { up: 0, down: 0 }, msgs: { up: 0, down: 0 } });
  const say = (tr, st, detail) => { if (tr.onStatus) tr.onStatus(st, detail || ''); };

  // two tabs of the same browser; needs nothing and works with the aeroplane off
  function localTransport(cfg) {
    const tr = base();
    let ch = null;
    tr.connect = () => new Promise((res, rej) => {
      if (typeof BroadcastChannel === 'undefined') { rej(new Error('This browser has no BroadcastChannel.')); return; }
      try {
        ch = new BroadcastChannel('flightline.room.' + cfg.room);
        ch.onmessage = (e) => {
          const txt = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
          tr.bytes.down += txt.length; tr.msgs.down++;
          if (tr.onMessage) tr.onMessage(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
        };
        say(tr, 'open', 'this browser only');
        res();
      } catch (e) { rej(e); }
    });
    tr.send = (o) => { if (!ch) return; const txt = JSON.stringify(o); tr.bytes.up += txt.length; tr.msgs.up++; ch.postMessage(o); };
    tr.close = () => { if (ch) { try { ch.close(); } catch (e) { /* already gone */ } ch = null; } say(tr, 'closed'); };
    return tr;
  }

  // any relay that sends a room's frames back to everyone else in the room
  function wsTransport(cfg) {
    const tr = base();
    let ws = null, shut = false;
    tr.connect = () => new Promise((res, rej) => {
      if (!cfg.url) { rej(new Error('No relay address.')); return; }
      let url;
      try { url = new URL(cfg.url); } catch (e) { rej(new Error('That relay address is not a URL.')); return; }
      url.searchParams.set('room', cfg.room);
      if (cfg.id) url.searchParams.set('id', cfg.id);
      say(tr, 'connecting');
      try { ws = new WebSocket(url.toString()); } catch (e) { rej(e); return; }
      ws.onopen = () => { say(tr, 'open', url.host); res(); };
      ws.onerror = () => { if (!shut) say(tr, 'error', 'the relay refused the connection'); rej(new Error('Could not reach the relay.')); };
      ws.onclose = () => { if (!shut) say(tr, 'closed', 'the relay closed the connection'); };
      ws.onmessage = (e) => {
        const txt = String(e.data);
        tr.bytes.down += txt.length; tr.msgs.down++;
        try { if (tr.onMessage) tr.onMessage(JSON.parse(txt)); } catch (err) { /* not ours */ }
      };
    });
    tr.send = (o) => {
      if (!ws || ws.readyState !== 1) return;
      const txt = JSON.stringify(o);
      tr.bytes.up += txt.length; tr.msgs.up++;
      ws.send(txt);
    };
    tr.close = () => { shut = true; if (ws) { try { ws.close(); } catch (e) { /* already gone */ } ws = null; } say(tr, 'closed'); };
    return tr;
  }

  // Supabase Realtime: a broadcast channel per room, no table and no sign-in
  let supaLib = null;
  function loadSupabase(url) {
    if (supaLib) return Promise.resolve(supaLib);
    const src = url || SUPABASE_CDN;
    return import(/* webpackIgnore: true */ src).then((m) => {
      const lib = m && (m.createClient ? m : m.default);
      if (!lib || !lib.createClient) throw new Error('That script is not supabase-js.');
      supaLib = lib;
      return lib;
    });
  }
  function supabaseTransport(cfg) {
    const tr = base();
    let client = null, chan = null, shut = false;
    tr.connect = () => {
      if (!cfg.url || !cfg.key) return Promise.reject(new Error('Supabase needs a project URL and an anon key (Settings → Racing).'));
      say(tr, 'connecting', 'loading supabase-js');
      return loadSupabase(cfg.cdn).then((lib) => new Promise((res, rej) => {
        say(tr, 'connecting', 'joining the room');
        client = lib.createClient(cfg.url, cfg.key, { realtime: { params: { eventsPerSecond: 40 } } });
        chan = client.channel('flightline-' + cfg.room, { config: { broadcast: { self: false, ack: false } } });
        chan.on('broadcast', { event: 'f' }, (m) => {
          const o = m && m.payload;
          if (!o) return;
          tr.bytes.down += JSON.stringify(o).length; tr.msgs.down++;
          if (tr.onMessage) tr.onMessage(o);
        });
        chan.subscribe((status, err) => {
          if (status === 'SUBSCRIBED') { say(tr, 'open', 'Supabase'); res(); }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            const msg = (err && err.message) || (status === 'TIMED_OUT' ? 'the project did not answer' : 'the project refused the room');
            if (!shut) say(tr, 'error', msg);
            rej(new Error(msg));
          } else if (status === 'CLOSED' && !shut) say(tr, 'closed');
        });
      }));
    };
    tr.send = (o) => {
      if (!chan) return;
      tr.bytes.up += JSON.stringify(o).length; tr.msgs.up++;
      try { chan.send({ type: 'broadcast', event: 'f', payload: o }); } catch (e) { /* dropped */ }
    };
    tr.close = () => {
      shut = true;
      try { if (chan) chan.unsubscribe(); if (client) client.removeAllChannels(); } catch (e) { /* already gone */ }
      chan = null; client = null; say(tr, 'closed');
    };
    return tr;
  }

  const TRANSPORTS = {
    local: { name: 'This browser', make: localTransport, help: 'Two tabs or two windows of this browser race each other. No server and no internet \u2014 but they share one set of settings, so it is for trying it out and for two people at one screen.' },
    supabase: { name: 'Supabase', make: supabaseTransport, help: 'A Supabase Realtime broadcast channel. Paste your project URL and anon key below.' },
    ws: { name: 'WebSocket relay', make: wsTransport, help: 'Any relay that echoes a room’s frames to the room, such as a small Cloudflare Worker.' },
  };

  /* ---------------------------------------------------------------- room */
  /* Keeps the peers, their clock offsets and their state buffers. The page
     calls tick() every frame and reads peer.view for where to draw them. */
  /* rate: state messages a second. delay: how far in the past other pilots are drawn, so
     there is always a sample either side of them. extrap: how long to carry on from the last
     sample before giving up. snap: a jump this big (a reset) empties the buffer. */
  const DEF = { rate: 20, delay: 120, extrap: 250, snap: 25, pingEvery: 2000, heartbeat: 2000, stale: 4000, drop: 12000 };

  function room(cfg) {
    const C = Object.assign({}, DEF, cfg || {});
    const clk = C.clock || nowMs; // injectable so tests can run on a virtual clock
    const tr = (TRANSPORTS[C.transport] || TRANSPORTS.local).make(C);
    const peers = new Map();
    const R = {
      id: C.id, transport: C.transport, room: C.room, status: 'closed', detail: '',
      peers, stats: { up: 0, down: 0, upBps: 0, downBps: 0, msgUp: 0, msgDown: 0, rate: 0 },
      me: { name: C.name || '', ac: C.aircraft || '', col: C.col || 0, ready: false, spec: !!C.spectate },
      on: { status: null, peer: null, go: null, lap: null },
    };
    let sendAcc = 0, pingAcc = 0, beatAcc = 0, statAcc = 0, lastUp = 0, lastDown = 0, sent = 0, open = false;

    const emit = (k, ...a) => { const f = R.on[k]; if (f) try { f(...a); } catch (e) { /* the page's problem */ } };
    const peer = (id) => {
      let p = peers.get(id);
      if (!p) {
        p = { id, name: '', ac: '', col: 0, ready: false, spec: false, rtt: null, offset: null, best: null, lap: null, laps: 0,
          buf: [], view: null, last: clk(), seen: clk(), pings: [], synced: false };
        peers.set(id, p);
        emit('peer', p, 'in');
      }
      return p;
    };

    tr.onStatus = (st, detail) => { R.status = st; R.detail = detail; open = st === 'open'; emit('status', st, detail); };
    tr.onMessage = (m) => {
      if (!m || typeof m !== 'object' || !m.i || m.i === R.id) return;
      const p = peer(m.i);
      p.seen = clk();
      if (m.t === 's') {
        const s = unpackState(m.d);
        if (!s) return;
        p.last = p.seen;
        // their clock -> ours; until the first ping answer, trust arrival time
        const t = p.offset === null ? p.seen : s.c - p.offset;
        const prev = p.buf.length ? p.buf[p.buf.length - 1] : null;
        if (prev && (Math.hypot(s.p[0] - prev.p[0], s.p[1] - prev.p[1], s.p[2] - prev.p[2]) > C.snap || t < prev.t - 1000)) p.buf.length = 0;
        p.buf.push({ t, c: s.c, p: s.p, q: s.q, v: s.v, thr: s.thr, flags: s.flags });
        if (p.buf.length > 80) p.buf.shift();
      } else if (m.t === 'j') {
        p.name = String(m.n || '').slice(0, 16); p.ac = String(m.a || ''); p.col = m.c | 0;
        p.ready = !!m.r; p.spec = !!m.s;
        if (m.b != null) p.best = m.b;
      } else if (m.t === 'q') {
        if (m.u === R.id) tr.send({ t: 'a', i: R.id, u: m.i, c: m.c, d: Math.round(clk()) });
      } else if (m.t === 'a') {
        if (m.u !== R.id) return;
        const rtt = clk() - m.c;
        if (rtt < 0 || rtt > 5000) return;
        // their clock minus ours, from the sample with the shortest round trip
        p.pings.push({ rtt, off: m.d + rtt / 2 - clk() });
        if (p.pings.length > 8) p.pings.shift();
        const best = p.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        p.rtt = Math.round(best.rtt);
        p.offset = best.off; p.synced = true;
        for (const e of p.buf) e.t = e.c - p.offset; // re-time what we already hold, so nobody blinks out
      } else if (m.t === 'g') {
        p.ready = true;
        emit('go', { at: p.offset === null ? clk() + (m.in || 0) : m.at - p.offset, laps: m.l | 0, coll: m.c || 'off', from: p.id });
      } else if (m.t === 'l') {
        p.lap = m.v; p.laps = m.n | 0;
        if (m.b != null && (p.best === null || m.b < p.best)) p.best = m.b;
        emit('lap', p, m.v);
      } else if (m.t === 'x') {
        peers.delete(m.i);
        emit('peer', p, 'out');
      }
    };

    R.connect = () => tr.connect().then(() => { R.hello(); });
    R.hello = () => tr.send({ t: 'j', v: PROTO, i: R.id, n: R.me.name, a: R.me.ac, c: R.me.col, r: R.me.ready, s: R.me.spec, b: R.me.best == null ? null : R.me.best });
    R.go = (inMs, laps, coll) => { const at = Math.round(clk() + inMs); tr.send({ t: 'g', i: R.id, at, in: inMs, l: laps, c: coll }); return at; };
    R.lap = (secs, best, n) => tr.send({ t: 'l', i: R.id, v: secs, b: best, n });
    R.leave = () => { try { tr.send({ t: 'x', i: R.id }); } catch (e) { /* going anyway */ } tr.close(); peers.clear(); };
    R.send = (o) => tr.send(o);
    R.set = (k, v) => { if (k in C) C[k] = v; }; // rate and buffer can be changed while flying

    // called every frame: broadcasts our state on the clock, pings, prunes, interpolates
    R.tick = (dt, mine) => {
      const t = clk();
      if (open && mine && !R.me.spec) {
        sendAcc += dt;
        const per = 1 / Math.max(1, C.rate);
        if (sendAcc >= per) {
          sendAcc = Math.min(sendAcc - per, per);
          tr.send({ t: 's', i: R.id, d: packState({ c: Math.round(t), p: mine.p, q: mine.q, v: mine.v, thr: mine.thr, flags: mine.flags || 0 }) });
          sent++;
        }
      }
      if (open) {
        pingAcc += dt * 1000;
        if (pingAcc >= C.pingEvery) { pingAcc = 0; for (const p of peers.values()) tr.send({ t: 'q', i: R.id, u: p.id, c: Math.round(t) }); }
        beatAcc += dt * 1000;
        if (beatAcc >= C.heartbeat) { beatAcc = 0; R.hello(); }
      }
      // where each peer is right now: interpolate in the past, extrapolate a little
      const render = t - C.delay;
      for (const p of peers.values()) {
        if (t - p.seen > C.drop) { peers.delete(p.id); emit('peer', p, 'out'); continue; }
        p.view = sampleAt(p, render, C.extrap);
        p.stale = t - p.last > C.stale;
        while (p.buf.length > 2 && p.buf[1].t < render - 1000) p.buf.shift();
      }
      statAcc += dt;
      if (statAcc >= 1) {
        R.stats.upBps = Math.round((tr.bytes.up - lastUp) / statAcc); R.stats.downBps = Math.round((tr.bytes.down - lastDown) / statAcc);
        R.stats.rate = Math.round(sent / statAcc);
        lastUp = tr.bytes.up; lastDown = tr.bytes.down; sent = 0; statAcc = 0;
      }
      R.stats.up = tr.bytes.up; R.stats.down = tr.bytes.down; R.stats.msgUp = tr.msgs.up; R.stats.msgDown = tr.msgs.down;
    };
    return R;
  }

  // one peer's place at render time: between the two samples around it, or a
  // short step on from the last one; null once it has been quiet too long
  function sampleAt(p, render, maxExtrap) {
    const b = p.buf;
    if (!b.length) return null;
    if (render <= b[0].t) return { p: b[0].p.slice(), q: b[0].q.slice(), thr: b[0].thr, flags: b[0].flags, extrap: 0 };
    for (let i = b.length - 1; i > 0; i--) {
      if (render >= b[i - 1].t && render <= b[i].t) {
        const a = b[i - 1], c = b[i], f = (render - a.t) / Math.max(1e-6, c.t - a.t);
        return { p: [a.p[0] + (c.p[0] - a.p[0]) * f, a.p[1] + (c.p[1] - a.p[1]) * f, a.p[2] + (c.p[2] - a.p[2]) * f],
          q: nlerp(a.q, c.q, f), thr: a.thr + (c.thr - a.thr) * f, flags: c.flags, extrap: 0 };
      }
    }
    const last = b[b.length - 1], ahead = render - last.t;
    if (ahead > maxExtrap) return null;
    const s = ahead / 1000;
    return { p: [last.p[0] + last.v[0] * s, last.p[1] + last.v[1] * s, last.p[2] + last.v[2] * s],
      q: last.q.slice(), thr: last.thr, flags: last.flags, extrap: ahead };
  }
  function nlerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
    if (d < 0) { s = -1; d = -d; }
    const o = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t];
    const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return [o[0] / l, o[1] / l, o[2] / l, o[3] / l];
  }

  // a room code people can read out: no vowels, so it spells nothing
  function roomCode(rand) {
    const CH = 'BCDFGHJKLMNPQRSTVWXZ23456789', r = rand || Math.random;
    let s = '';
    for (let i = 0; i < 6; i++) s += CH[Math.floor(r() * CH.length)];
    return s;
  }
  const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

  return { PROTO, TRANSPORTS, SUPABASE_CDN, STATE_BYTES, room, packState, unpackState, sampleAt, nlerp, roomCode, cleanCode, nowMs, b64, unb64 };
})();
if (typeof module !== 'undefined') module.exports = NET;
