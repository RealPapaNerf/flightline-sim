You're picking up work on **Flightline RC Sim** (github.com/RealPapaNerf/flightline-sim, public). It's a browser flight sim for Chromebook practice: planes, quads and a heli, with an FPV gate course and lap timer. It's one self-contained WebGL page built from `src/` by `tools/build.py` and served from GitHub Pages at realpapanerf.github.io/flightline-sim. Push straight to `main`, with no PRs, and write each commit message like a PR description.

**This session: racing other people. Ghosts first, then live multiplayer.**

Read first: `README.md`, `ideas/multiplayer.md`. Then in the code:
- `src/app.js`: `courseTick` and the gate course, `MODELS` and `renderView`, the OSD, settings tabs and `schema()`, the frame loop
- `src/physics.js`: state layout. The world is NED metres, the pilot stands at the origin, attitude is a quaternion.

**Step 1: ghost racing (no server):**
- Record each lap at 20 Hz: time, position, quaternion, throttle and gate times, quantised and compact.
- Keep the best lap per aircraft and course in browser storage, with try/catch around every read and write.
- Draw the ghost as a translucent copy of the model, in both LOS and FPV, with the split time at every gate.
- Export and import lap files.
- Later: a public `flightline-laps` repo or the same storage as maps.

**Step 2: live racing:**
- Put a small transport interface in `src/net.js` so the relay can be swapped.
- v1 relay: Supabase Realtime broadcast channels.
  - I'll create the project and give you the URL and anon key. Keep them in settings, not hard-coded.
  - Load supabase-js from a CDN at a pinned exact version.
  - Alternative: a tiny WebSocket relay such as a Cloudflare Worker.
- Each sim flies its own aircraft locally and broadcasts its state about 20 times a second: id, time, position, quaternion, velocity, throttle, aircraft and colours.
- Remote players:
  - sync clocks with ping/pong offsets
  - 100–150 ms interpolation buffer, short extrapolation, snap on reset
  - draw them with name tags
- Lobby:
  - room code, display name, aircraft, course
  - ready, a shared countdown, gate timing checked locally, a results table
  - spectate mode
- Player-to-player collisions: off, or a local bump, chosen per room.
- The sim must run exactly as now when offline. Live play needs the GitHub Pages version, because the claude.ai artifact build can't open outside connections, so say that in the UI.

**Checks:**
- A node test for lap recording and quantisation error.
- A headless Chromium test with two pages in one room racing the course.
- Bandwidth measured per player.

Other sessions may push to this repo. Pull and rebase before you start and before every push.
