# Multiplayer and racing

**Status: pinned.**

## Step 1: ghost racing (no server)

- Every lap on the gate course records a compact track: position and attitude at 20 Hz, about
  30 KB a minute.
- Race against your own best lap, or a friend's lap file, shown as a translucent "ghost" with
  the split time at every gate.
- Lap files are shared like maps (GitHub, Drive, Supabase).
- Leaderboards per course and aircraft class can come later, through the same storage.

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
