# Multiplayer and racing

**Status: step 1 (ghosts) done; step 2 (live racing) building.**

## Step 1: ghost racing (no server) — done

- Every lap on the gate course records a compact track: position, attitude, throttle and the
  gate times at 20 Hz (`src/ghost.js`), about 20 KB a minute as a file.
- Position is kept as millimetre steps between samples and attitude as a 1/32767 quaternion, so
  a decoded lap is within a millimetre and 0.01° of what was flown (`node test/ghost_test.js`).
- Your best lap per course and aircraft lives in browser storage, one key each, every read and
  write wrapped.
- The ghost is a translucent copy of the model in both views, with a name tag and the split at
  every gate. Settings → Racing picks which lap it flies.
- Laps export and import as JSON files. A public `flightline-laps` repo, or the same storage as
  maps, can come later, and leaderboards per course and aircraft class through it.

## Step 2: live racing

- Each player's sim flies its own aircraft locally (no input lag) and broadcasts its state about
  20 times a second.
- Others are drawn from those messages with interpolation and a little extrapolation. A typical
  100 ms internet delay looks smooth.
- **Relay:** a Supabase Realtime channel is the easiest, since it needs no server of our own.
  Peer-to-peer WebRTC works too but still needs a signalling server.
- **Lobby:** create or join a room code, pick a course, ready up, shared countdown, gate timing
  checked locally, results broadcast.
- **Collisions between players:** approximate (bump and wobble, or ghost-through, chosen per
  room). Exact physics across the internet isn't worth it for racing.
- Works in the GitHub Pages version. The claude.ai artifact can't open outside connections.

## Size

Ghosts: small–medium. Live racing: medium–large (lobby, networking, smoothing, cheating isn't a
concern among friends).
