You're picking up work on **Flightline RC Sim** (github.com/RealPapaNerf/flightline-sim, public). It's a browser flight sim I use on a Chromebook to practise flying my RC aircraft before real flights. It's one self-contained WebGL page built from `src/` by `tools/build.py` and served from GitHub Pages. Push straight to `main`, with no PRs, and write each commit message like a PR description. I have no formal engineering background, so be an editor, not an author: show checkable numbers and assumptions.

**This session: aircraft files, a generic plane model, and an in-game aircraft builder.**

Read first: `README.md` and `ideas/aircraft.md`. Then in the code:
- `src/physics.js`:
  - `DEFS`: plane surfaces cut into strips with flaps, prop, battery, contact points
  - `quadDef()`, the heli
  - `build()`, `stallSpeed()`, `performance()`, the battery model
- `src/app.js`:
  - `buildGoblin` and `buildTrainer` are hand-made meshes
  - `buildQuad` is generic
  - settings tabs and `schema()`
- tests: `test/fm_test.js`, `test/perf.js`, `test/quad_test.js <id>`

**Goals, in order:**
1. **Aircraft file v1, in `docs/aircraft-format.md`:**
   - A JSON aircraft definition (the same shape as a `DEFS` entry) plus metadata: author, version, colours.
   - Validate and clamp every number on import. Never run code from a file.
   - Round-trip test: export every built-in aircraft, re-import it, and get identical bench numbers.
2. **Generic plane model:** build the 3D model from the definition's surfaces (wing, stab, fin, flaps, fuselage, gear, prop), so an imported plane renders. Keep the Goblin and trainer models as they are.
3. **Import and export:** Settings → Aircraft gets "Import aircraft file" and "Export this aircraft". Save imported aircraft in browser storage, with try/catch around every read and write. Optionally an `aircraft/` folder with an `index.json` in a public repo, loadable by URL (GitHub Pages version only).
4. **Builder panel:** forms for:
   - type (plane or quad), size, weight, CG / static margin
   - motor and prop
   - battery: chemistry, cells in series and parallel, cell capacity and internal resistance
   - surfaces and throws

   Live bench numbers as you edit:
   - plane: stall speed, trim table, top speed
   - quad: thrust/weight, hover throttle, punch-out sag, hover and cruise flight time

   And a "Fly it" button.
5. **Stretch:** a flaps channel and retractable gear, which the camera-platform plane in `ideas/aircraft.md` needs.
6. **Chat prompt:** write `docs/design-an-aircraft-prompt.md`, a ready-to-paste prompt for a normal Claude chat. It should turn my build list (frame, motor KV, prop, cells, all-up weight) into a valid aircraft file, pointing at the format doc's raw GitHub URL.

**Performance:** an aircraft is a few hundred numbers, so flying cost stays the same as today. Cap planes at about 40 strips, and only run the builder while it's open.

**First real aircraft** (ask me for specs):
- my Nano Goblin with ArduPilot and lidar
- my 7" ArduPilot quad
- my 13" recovery quad on 12S2P 21700
- my 10" GEPRC Mark4
- a ~2 m camera-platform plane with flaps and gear

Other sessions may push to this repo. Pull and rebase before you start and before every push.
