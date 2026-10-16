# Flightline RC Sim

A browser flight simulator for practising RC flying on a Chromebook: fixed wings,
quads and a helicopter. You can fly line-of-sight, FPV, or a stacked split view for a
portrait screen. Plug in your transmitter or HOTAS over USB and fly it like the real
thing, in the weather you're worried about, with a radio link that can fail.

The flight models are built for practice that transfers:
- Wings are cut into strips that each stall on their own, so wing drop, tip stall and
  stall–spin entries come out of the physics.
- Quads run a Betaflight-style rate controller.
- The heli has a governed rotor you can autorotate.
- Weather, icing, cold batteries, sensors and the radio link all change how the aircraft
  flies, not just how it looks.

## Run it

- **On the web:** <https://realpapanerf.github.io/flightline-sim/>
- **Locally:** open `index.html` in Chrome. It's one self-contained file.

### Put it on the Chromebook as an app

1. Open the web address in Chrome.
2. Click the install icon at the right end of the address bar (or ⋮ → *Cast, save and
   share* → *Install page as app…*).
3. Right-click the new Flightline icon in the launcher → **Pin to shelf**.

The installed app opens in its own window and runs offline at the field.

GitHub Pages is switched on under Repo → Settings → Pages → Deploy from a branch → main →
/ (root).

## The aircraft

| | What it is | Power |
|---|---|---|
| **Nano Goblin** | 580 mm plank wing, 250 g, hand-launched | 2S 3200 Li-ion, pusher |
| **1.5 m trainer** | high-wing tricycle, 1.3 kg, runway | 3S 2200 LiPo, 10″ prop |
| **5-inch quad** | freestyle, 650 g, ~8.5:1 thrust/weight | 6S 1300 LiPo |
| **4″ LR** | long range, 340 g | 4S1P 18650 Li-ion |
| **7″ LR** | long range, 1.05 kg | 6S2P 18650 Li-ion |
| **13″ lifter** | 3.7 kg, landing gear, three-camera pod | 12S2P 21700 Li-ion |
| **450 heli** | flybarless, 2,900 rpm governor, Normal and 3D pitch curves | 6S 1300 LiPo |

Li-ion packs can't feed a full punch on the bigger quads: the voltage dives and the
thrust goes with it. Bench numbers for each aircraft come from `node test/quad_test.js
<id>`, `node test/heli_test.js` and `node test/fm_test.js`.

**How the planes stall.** The Goblin mushes: full up elevon gives a nose-high bob and
sink, and a hard pull at speed stalls it at about 6 g. The trainer stalls root-first and
drops a wing. Stall it in a turn and the inside wing goes first: the base-to-final
stall–spin.

**The heli.** Throttle hold (`H`) stops the motor and leaves the collective live. Lower
the collective and the air coming up through the disc keeps the rotor turning. Flare and
cushion with the stored headspeed. Leave the collective up and the rotor dies.

## Flight modes

- **Manual / Acro:** sticks move surfaces (planes) or command rotation rates (multirotors).
- **Horizon:** levels near centre stick, full stick flips or rolls.
- **Trainer:** manual or acro, but stopped at the bank and pitch limits.
- **Stabilised / Angle:** sticks command bank and pitch. Limits are adjustable.
- **Autopilot (ArduPilot-style):**
  - `J` Alt hold
  - `K` Loiter (GPS position hold for multirotors, a circle for planes)
  - `G` RTL
  - any flight-mode switch, or `M`, takes control back
- **RC failsafe:** a second without packets starts an RTL. When the link returns, RTL
  continues until you switch modes.

## Weather (Settings → Weather)

Presets:
- Clear day
- High & hot
- Hot & humid
- Cold front
- Storm outflow
- Cold & clear
- Freezing fog
- Freezing drizzle
- Snow squall

Then adjust anything:
- **Density altitude** from field elevation, temperature, humidity and altimeter
  setting. Wings, props and rotors all lose performance in thin air.
- **Wind, gusts and turbulence:** Dryden turbulence including rotational gusts that
  rock small wings, plus gusty, sinking air in the lee of trees and buildings.
- **Rain, snow, fog, cloud ceiling:** reduced visibility, a cloud deck that hides the
  model from the ground and whites out FPV, and drops or frost on the FPV lens.
- **Icing:** in supercooled cloud, freezing fog, drizzle or wet snow, ice builds on
  leading edges and props. Small chords ice first. Stall speed rises, drag and weight
  climb, prop thrust falls, and ice sheds with a shake.
- **Cold batteries:** a cold pack sags hard on a punch and warms as you fly. You can
  start it pre-warmed.

Every equation and coefficient is listed under Settings → Flight model. The icing
numbers follow published trends but err pessimistic: a reason to turn around early, not
a margin to fly to.

## Link and sensors (Settings → Link & sensors)

- **Sensors:**
  - GPS: latency and wander
  - Baro: drift, and reads low at speed
  - Downward lidar: TF-Luna, TFmini Plus, TF02-Pro or SF11/C. Range depends on the
    surface (snow good, wet asphalt bad), bank angle and weather.

  The autopilot flies on these, and the OSD shows them.
- **RC link:** ELRS 2.4 GHz or 900 MHz. Link quality falls with distance, trees and
  buildings in the way, low-and-far flying, flying overhead, and an interference
  slider. Lost packets freeze the sticks.
- **Analog video:** 25 / 200 / 600 mW. The picture goes to snow, then tears, then
  drops out, OSD included.

## FPV OSD

**HUD** (default):
- pitch ladder
- speed tape and altitude tape with vario
- heading tape and bank scale
- flight-path marker

Plus link quality, GPS sats, rangefinder, battery, throttle (collective and rpm on the
heli), and home arrow with distance. **Classic** shows a horizon line and numbers instead.

## Controllers: radios, HOTAS, gamepads

Anything Chrome sees as a game controller works: an EdgeTX/OpenTX radio in USB joystick
mode, a HOTAS, or a gamepad.

- **Profiles:** one per controller, picked automatically when you plug it in. Each keeps
  its own stick mapping, button names and actions, rates and expo. A HOTAS with separate
  stick and throttle USB devices can share one profile.
- **Sticks:** Settings → Controller → **Guided setup**, or **Learn** per axis in
  Controls & buttons. On a radio, choose **USB Joystick (HID)** when you plug it in.
- **Buttons:** every button and hat gets a channel. Press **Record buttons**, press
  things one at a time, name them, and give each an action:
  - reset, pause, views
  - every flight mode and autopilot mode, stabilised while held
  - throttle cut / heli throttle hold
  - heli pitch curve
  - hand launch
  - trims, camera tilt, LOS zoom, OSD mode
  - stall indicator, engineering readout
  - switch aircraft, start position

## Keys

| | Mode 2 (default) | Mode 1 |
|---|---|---|
| Throttle | `W` / `S` | `↑` / `↓` |
| Pitch | `↑` / `↓` | `W` / `S` |
| Roll | `←` / `→` | `←` / `→` |
| Yaw | `A` / `D` | `A` / `D` |

| Key | Action |
|---|---|
| `R` | Reset |
| `V` | Cycle view (`1` LOS, `2` FPV, `3` split) |
| `M` | Cycle flight mode |
| `J` `K` `G` | Alt hold, loiter, RTL |
| `H` | Throttle cut (heli: throttle hold) |
| `I` | Heli Normal / 3D pitch curve |
| `L` | Throw the Goblin |
| `P` or `Space` | Pause |
| `F` | Full screen |

Touch screens get on-screen sticks.

**Hand launch (Goblin):** pull throttle to zero to arm, then push past 70%. It's thrown
once the motor is wound up.

## Views and the field

- **LOS:** you stand at the flight line facing north, with the runway east–west in front
  of you. *LOS zoom* keeps a small model visible.
- **FPV:** nose camera with adjustable field of view and tilt.
- **Split:** LOS on top, FPV below in portrait (side by side when wide).

The field has:
- an eight-gate FPV course with a lap timer and ghost laps
- pylons and plane gates
- slalom poles and a tree line
- a power line with sagging wires
- a barn, silo and water tower
- a search scene

Collisions with all of them count.

## Racing

**Ghost laps.** Every lap of the gate course is recorded at 20 Hz — position, attitude,
throttle and the time at each gate. Your quickest lap with each aircraft is kept in the
browser, and the ghost flies it back beside you: a translucent copy of the model in both
LOS and FPV, with the split at every gate (`−0.42` means you are up on it) and a name tag
over it.

Settings → Racing:
- **Race a ghost:** off, your best lap, or a lap you picked from the list.
- **Your name:** goes on the laps you export.
- **Saved laps:** race, export or delete any of them. *Load a lap file…* takes one back in.

A lap file is JSON, about 20 KB a minute, so you can e-mail a lap to a friend and they can
race it. Laps are kept per course and aircraft; nothing leaves the browser unless you
export it.

## Ideas

Planned features, with their order and dependencies, live in [`ideas/`](ideas/README.md):
- the Mission Planner-style mode
- the ArduPilot SITL bridge
- gimbal and night / thermal cameras
- terrain maps and a map builder
- the 13″ recovery mission
- multiplayer racing

## Development

```
src/physics.js   flight models: strip-theory wings, quads, heli, weather, icing, batteries (no DOM)
src/nav.js       sensors, link budget, autopilot (no DOM)
src/render.js    small WebGL 1 renderer
src/ghost.js     lap recording, quantisation, playback and storage (no DOM)
src/app.js       world, aircraft meshes, cameras, HUD/OSD, controllers, settings, loop
src/shell.html   page markup and styles
src/sw.js        offline cache for the installed app
tools/build.py   assembles index.html (and dist/artifact.html) from src/
test/*.js        bench tests: fm_test (planes), perf (trim table), quad_test <id>, heli_test,
                 modes_test, weather_test, nav_test, ghost_test
```

Edit `src/`, then run `python3 tools/build.py`. `index.html` is generated; commit it with
the sources (GitHub Pages serves it directly). Run the tests with `node test/<name>.js`.

## License

MIT. See [LICENSE](LICENSE).
