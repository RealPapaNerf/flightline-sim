#!/usr/bin/env node
/* A WebSocket relay for Flightline live racing: it sends every frame a pilot
   sends to the others in the same room, and keeps nothing.

   Run it:   node tools/relay.js [port]            (default 8787)
   Use it:   Settings → Racing → Relay: WebSocket relay
             Relay address: ws://<this machine>:8787

   No dependencies — the WebSocket handshake and framing are done here, which is
   all a relay of small JSON frames needs. For racing over the internet, put the
   same idea in a Cloudflare Worker (Durable Object per room) or use Supabase.
   It is deliberately dumb: no accounts, no history, no rules about what a frame
   means. The sims decide everything; this just passes the frames along. */
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8787;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 16;      // a state frame is ~80 bytes; anything huge is not ours
const rooms = new Map();        // room code -> Set of sockets

const send = (sock, text) => {
  const data = Buffer.from(text, 'utf8');
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x81, len])
    : len < 65536 ? Buffer.concat([Buffer.from([0x81, 126]), u16(len)])
      : Buffer.concat([Buffer.from([0x81, 127]), u64(len)]);
  try { sock.write(Buffer.concat([head, data])); } catch (e) { /* going away */ }
};
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(n / 4294967296), 0); b.writeUInt32BE(n >>> 0, 4); return b; };
const ctl = (sock, op) => { try { sock.write(Buffer.from([0x80 | op, 0])); } catch (e) { /* going away */ } };

const srv = http.createServer((req, res) => { res.writeHead(426); res.end('This is a WebSocket relay.\n'); });

srv.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  const room = (url.searchParams.get('room') || 'LOBBY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'LOBBY';
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`);
  sock.setNoDelay(true);

  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);
  peers.add(sock);
  log(`+ ${room} (${peers.size} in the room)`);

  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_FRAME) { close(); return; }
      const mask = masked ? buf.slice(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const body = buf.slice(off, off + len);
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      buf = buf.slice(off + len);
      if (op === 8) { close(); return; }
      if (op === 9) { ctl(sock, 10); continue; }         // ping -> pong
      if (op !== 1 && op !== 0) continue;                 // only text frames carry racing
      const text = body.toString('utf8');
      for (const other of peers) if (other !== sock) send(other, text);
    }
  });
  const close = () => {
    if (!peers.has(sock)) return;
    peers.delete(sock);
    if (!peers.size) rooms.delete(room);
    try { sock.destroy(); } catch (e) { /* already gone */ }
    log(`- ${room} (${peers.size} left)`);
  };
  sock.on('error', close);
  sock.on('close', close);
});

const log = (m) => { if (!srv.quiet) console.log(`${new Date().toISOString().slice(11, 19)}  ${m}`); };
function start(port, quiet) {
  srv.quiet = !!quiet;
  return new Promise((res) => srv.listen(port, () => { log(`relay on ws://localhost:${srv.address().port}`); res(srv); }));
}
if (require.main === module) start(PORT);
module.exports = { start, server: srv, rooms };
