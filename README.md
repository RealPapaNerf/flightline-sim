# Flightline RC Sim

A browser flight simulator for practising RC fixed-wing flying on a Chromebook, with
line-of-sight, FPV, and a stacked split view for a portrait screen. It ships two
aircraft: a **Nano Goblin** (580 mm plank wing) and a **1.5 m high-wing trainer**.
Plug in your transmitter over USB and fly it like the real thing.

The flight model is built for stall practice. Each wing, tail and fin is cut into
strips that each see their own airflow and stall on their own, so wing drop, tip
stall, accelerated stalls and stall–spin entries come out of the physics instead of
being scripted.

## Run it

- **On the web:** <https://realpapanerf.github.io/flightline-sim/> (after GitHub Pages
  is switched on; see below).
- **Locally:** open `index.html` in Chrome. It is one self-contained file. Offline, the
  OSD falls back to a system monospace font.

### Switch on GitHub Pages (once)

Repo → **Settings** → **Pages** → *Build and deployment* → Source: **Deploy from a
branch**, Branch: **main**, folder **/ (root)** → **Save**. The site appears at the
address above within a minute or two.

### Put it on the Chromebook as an app

ChromeOS keeps apps in the launcher and shelf rather than on a desktop.

1. Open the Pages address in Chrome.
2. Click the install icon at the right end of the address bar (or ⋮ menu →
   *Cast, save and share* → *Install page as app…*).
3. Flightline now has its own icon in the launcher. Right-click it → **Pin to shelf**.

The installed app opens in its own window, and a service worker caches it so it runs
with no internet at the field.

## Radio setup

Works with EdgeTX/OpenTX radios (RadioMaster, Jumper, FrSky, …) in USB joystick mode.

1. Plug the radio into the Chromebook and choose **USB Joystick (HID)** on the radio.
2. In the sim: **Set up radio** (welcome card, or ⚙ Settings → Controls).
3. Follow the steps: centre the sticks with throttle down, then move throttle, roll,
   pitch and yaw when asked. Optionally pick switches for **reset**, **view**, and
   **stabilised mode**. Directions and ranges are detected, so channel order and
   reversed channels don't matter.

Tip: make a dedicated sim model on the radio with no mixes. If that model has its own
rates and expo, set expo in the sim to 0%.

Chrome only reports a controller after a stick moves, so wiggle a stick after plugging in.

## Controls

| | Mode 2 (default) | Mode 1 |
|---|---|---|
| Throttle | `W` / `S` | `↑` / `↓` |
| Pitch | `↑` / `↓` | `W` / `S` |
| Roll | `←` / `→` | `←` / `→` |
| Yaw | `A` / `D` | `A` / `D` |

`R` reset · `V` cycle view (also `1` LOS, `2` FPV, `3` split) · `M` manual/stabilised ·
`P` or `Space` pause · `F` full screen · `L` throw the Goblin at any throttle.

Touch screens get on-screen sticks (Settings → Controls → Touch sticks).

**Hand launch (Goblin):** pull throttle to zero to arm, then push it past 70%. The model
is thrown once the motor is wound up, a firm 25 mph toss. Launch too slow or with the
motor still spooling and it will sink, like the real thing. A touch of up elevator helps;
a lot of it stalls it into the ground.

## Views

- **LOS** – you stand at the flight line facing north; the runway runs east–west in
  front of you. *LOS zoom* keeps a small model visible on a small screen.
- **FPV** – nose camera with adjustable field of view and tilt, Betaflight-style OSD
  (altitude, speed, vario, battery, throttle, home arrow and distance).
- **Split** – LOS on top, FPV below when the screen is upright (side by side when wide).
  Rotate the Chromebook to portrait for the stacked layout.

## The aircraft

Numbers solved from the model at sea level (Settings → Flight model shows them live for
your field elevation and temperature):

| | Nano Goblin | 1.5 m trainer |
|---|---|---|
| Flying weight | 250 g | 1.3 kg |
| Span · area | 580 mm · 139 in² | 1.5 m · 512 in² |
| 1-g stall | 18 mph | 18 mph |
| Hands-off (trimmed) | ~36 mph | ~28 mph |
| Top speed | 65 mph | 45 mph |
| Power | 2S 3200 Li-ion, 3″ pusher | 3S 2200 LiPo, 10″ prop |

Goblin geometry, weight and power system follow Strix's published specs (580 mm span,
~140 in², 200–250 g, 1606 motor on 2S, 3052 prop, 60–70 mph top speed). CG position,
airfoil coefficients and inertia are estimates.

**How they stall.** The Goblin, like most planks, mushes: with full up elevon it bobs
nose-high and sinks with the wings roughly level; yank hard at speed and it stalls at
about 6 g. Pro-spin inputs give a spiral it leaves in under a second. The trainer stalls
root-first, then drops a wing; stall it in a turn and the inside wing goes first and the
bank tightens: the base-to-final stall–spin.

### Matching your own Goblin

Everything lives in `DEFS.goblin` in `src/physics.js`. The ones worth changing first:

- `mass` – weigh it ready to fly (FC, GPS, lidar and camera add up).
- `batt` – chemistry (`lipo`/`liion`), cell count, capacity, internal resistance.
- `prop.T0` (static thrust, N) and `prop.Vp` (pitch speed, m/s) for your motor/prop.
- `staticMargin` – where your CG sits (fraction of MAC ahead of the neutral point).
- `defl` – elevon throws in degrees for roll and pitch.

Then run `node test/perf.js` and `node test/fm_test.js goblin` to see what changed.

## Flight model

- **Strip theory.** Each surface is cut into spanwise strips. Each strip's angle of
  attack comes from the aircraft's velocity plus its rotation (taken at ¾ chord), so
  roll, pitch and yaw damping, dihedral effect and weathervaning emerge from geometry.
- **Lift and stall.** Linear lift below the stall, flat-plate normal force above,
  blended with a sigmoid (Beard & McLain, *Small Unmanned Aircraft*, 2012). Each strip
  has its own stall angle from a Schrenk load distribution, so tapered and swept wings
  stall at the tips first and rectangular wings at the root.
- **Controls.** Flap effectiveness and hinge-moment change from thin-airfoil theory for
  the actual flap-to-chord ratio. Servos are rate-limited. The Goblin's EPP elevons lose
  some authority at high dynamic pressure.
- **Tail.** Downwash from the wing's lift, plus prop wash from momentum theory on a
  tractor prop (lets the trainer steer and lift its tail on the ground).
- **Propulsion.** Thrust ∝ rpm², falling off toward pitch speed; rpm follows battery
  voltage under load; prop torque rolls the model.
- **Air.** ISA density from field elevation and temperature (density altitude shown),
  log wind profile near the ground, filtered gusts, ground effect on induced drag.
- **Ground.** Spring–damper contact points with friction, steerable nose wheel, crash
  detection by impact and scrape speed per point (prop strikes included).
- **Integration.** 400 Hz fixed step, quaternion attitude, about 1 ms of CPU per
  simulated second.

**Simplified:** no strip-to-strip induced-flow coupling beyond the load distribution, no
dynamic stall, no gyroscopic prop effects, rigid airframe except the elevon flex factor,
trees are cylinders.

## Development

```
src/physics.js   flight model (no DOM; runs in Node for tests)
src/render.js    small WebGL 1 renderer
src/app.js       world, aircraft meshes, cameras, OSD, input, radio wizard, settings, loop
src/shell.html   page markup and styles
src/sw.js        offline cache for the installed app
tools/build.py   assembles index.html (and dist/artifact.html) from src/
tools/make_icons.py  draws the app icons
test/fm_test.js  flight-model bench tests (stall, spin, roll rate, launch, landing…)
test/perf.js     trim solver: level-flight table, stall speed, top speed
```

Edit `src/`, then run `python3 tools/build.py`. `index.html` is generated, so commit it
along with the sources (GitHub Pages serves it directly).
