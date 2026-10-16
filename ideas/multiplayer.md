# Multiplayer and racing

**Status: both steps done (v1).**

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

## Step 2: live racing — done (v1)

- `src/net.js`: a transport is `{ connect, send, close, onMessage, onStatus }` and nothing more,
  so the relay can be swapped. Three are built: a BroadcastChannel between two tabs, Supabase
  Realtime broadcast (supabase-js from a CDN at a pinned version, URL and anon key in settings),
  and any WebSocket relay — `tools/relay.js` is one, in no dependencies, and the same idea fits
  in a Cloudflare Worker.
- Each sim flies its own aircraft locally and broadcasts a 32-byte state 20 times a second:
  clock, position, attitude, velocity, throttle, flags. About 1.4 KB/s a pilot.
- Clocks are lined up with ping/pong (the offset from the shortest round trip). Others are drawn
  from a 120 ms buffer with a short extrapolation, and the buffer is thrown away on a reset.
- Lobby: room code, name, colour, ready, a shared countdown from the pilot whose id sorts first,
  gate timing checked locally, lap times broadcast, and a panel with pings and best laps.
- Spectating sends nothing and rides the view of whichever pilot you pick.
- Collisions are off or a local bump, set by whoever starts the race.
- `node test/net_test.js` for the protocol, clock sync, interpolation and bandwidth;
  `node test/race_test.js` races two headless Chromium pages through the relay.

### Still to do

- Leaderboards per course and aircraft class, through the same storage as laps.
- Rejoining a race in progress (you currently wait for the next countdown).
- A host that survives the host leaving mid-countdown.

## Size

Ghosts: small–medium. Live racing: medium–large (lobby, networking, smoothing, cheating isn't a
concern among friends).
