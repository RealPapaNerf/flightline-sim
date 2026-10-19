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
- An **Accurate aerodynamics** option (Settings → Aircraft → Sim rules) swaps in a
  nonlinear lifting line for the induced flow, Reynolds-number effects, dynamic stall
  with hysteresis, and the propeller's gyroscopics, P-factor and slipstream swirl.
  **Accurate · fine** rebuilds the aircraft with twice the strips, clustered toward
  the tips where the line needs the resolution. The default stays the lightweight
  model; the options cost about 2% and 3.5% of one CPU core and are anchored at build
  time so trim barely moves. `node test/hifi_test.js` checks all three against each
  other and the new effects for direction.

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
| **Tip-prop heli** | 1.5 m rotor driven by two props out on the blades. No tail rotor; the pedal is a motor on the mast. Derotated camera on the hub | 6S 5000 LiPo |
| **Autogyro** | 1.7 m rotor nobody drives, mast raked 9° back, pusher prop, prerotator | 6S 6000 LiPo |
| **Gyrodyne** | shaft-driven rotor, no tail rotor, two reversing-pitch props on stub booms. Throttle hold turns it into an autogyro | 12S 8000 LiPo |

Plus whatever you load: the [`aircraft/`](aircraft/) folder here — which has the
Goblin with an ArduPilot stack, three of the quads, a 2 m camera plane, a
657 km/h-class tail-sitter and the three rotorcraft above — a file someone sends
you, or one you build in the sim. See **Your own aircraft** below.

Li-ion packs can't feed a full punch on the bigger quads: the voltage dives and the
thrust goes with it. Bench numbers for each aircraft come from `node test/quad_test.js
<id>`, `node test/heli_test.js`, `node test/rotorcraft_test.js`, `node test/fm_test.js`
and `node test/aircraft_test.js`.

**How the planes stall.** The Goblin mushes: full up elevon gives a nose-high bob and
sink, and a hard pull at speed stalls it at about 6 g. The trainer stalls root-first and
drops a wing. Stall it in a turn and the inside wing goes first: the base-to-final
stall–spin.

**The heli.** Throttle hold (`H`) stops the motor and leaves the collective live. Lower
the collective and the air coming up through the disc keeps the rotor turning. Flare and
cushion with the stored headspeed. Leave the collective up and the rotor dies.

### Rotors that are not helicopters

One rotor model, three ways of turning it, and the differences between them are
the point. [`docs/aircraft-format.md`](docs/aircraft-format.md#three-ways-to-turn-a-rotor)
has the fields.

- **Tip-prop heli** — propellers out on the blades, pushing the disc round like
  a tipjet. They push against the air and not against the airframe, so there is
  no reaction torque and no tail rotor. One number sizes the machine: a
  propeller stops pulling at its own pitch speed, and these are flying at the
  blade tip speed, so the tip speed has to stay low, so the rotor has to be big
  and lightly loaded. It glides 2 to 1 against a 450's 1.4 and autorotates at
  2.9 m/s against 7.2. Yaw is a motor across the mast bearing turning the
  fuselage against the rotor's own momentum — it works at a standstill and it
  works engine-out, because the hub carries its own pack for the derotator, the
  receiver and the flight controller, and **the pedal spends headspeed**.
- **Autogyro** — nothing drives the rotor, ever. The mast leans back 9°, so air
  comes up through the disc and keeps it turning, and the pusher's only job is
  to keep that happening. It cannot hover and it cannot stall. Prerotate on the
  ground (throttle closed, about ten seconds), roll, fly. Every landing is an
  autorotation, and the flare window is about a metre deep: started at 2 m it
  touches down at 0.4 m/s, started at 4 m at 3.7.
- **Gyrodyne** — the Fairey idea at model scale. Shaft-driven rotor, no tail
  rotor, and two reversing-pitch propellers on stub booms taking the torque
  between them: in the hover they sit at +3 N and −3 N, so the reaction is
  cancelled at no net thrust and it hovers straight instead of charging forward.
  Throttle hold rakes the head back 7°, parks the collective and hands the stick
  to the propellers, and the same airframe is an autogyro at 46% headspeed. Let
  it off and it is a helicopter again. The switch can be thrown in flight and
  thrown back.

**The flare margin.** Once any of them loses its drive, the only budget left is
the one in the rotor, and the OSD shows it: the energy the head holds above the
speed at which it can no longer make one g, against the energy it takes to stop
the descent. Under 100% the landing is an arrival.

## Your own aircraft

Every aircraft in the sim is a few hundred numbers in a JSON file — wing geometry,
airfoil coefficients, prop, pack, throws, and the points that can hit the ground. You
can export them, import them, and build new ones without leaving the page.

**Settings → Aircraft** has *Export this aircraft* (the built-in ones too, so the
quickest way to a new design is to export the trainer and edit it), *Import aircraft
file*, a list of what you have imported, and a button that reads the
[`aircraft/`](aircraft/) folder on this site. You can load a file from any URL as well,
which is how you fly something a friend has put in their own repository.

**Settings → Builder** is a build sheet as a form: type, span, weight, CG, motor and
prop, battery chemistry and cell layout, surfaces and throws. A field you have not
touched follows its default and is marked *auto*, so changing the span moves the chord,
the tail, the prop and the gear with it; a field you type is marked *set* and stays put.
Underneath it, the bench numbers, worked out from the same model you fly and updated as
you type:

- **planes:** wing area, aspect ratio, wing loading, static margin, stall speed clean
  and at full flap, hands-off speed, top speed, static thrust, and a table of throttle
  and elevator against speed
- **quads:** thrust to weight at nominal volts and with the pack's own sag, hover
  throttle, hover current and flight time, punch-out current and sag, cruise speed,
  endurance and range

Then **Fly it**. The aircraft is saved in the browser with its build sheet, so you can
come back and change it, and exported as a file when you want to keep or share it.

**Flaps and retracts** come with the format: `C` cycles the flaps up → takeoff →
landing, `U` raises and lowers the gear, and both can go on a radio switch. The OSD
shows the flap setting and warns when the gear is up.

**Lifting bodies on a quad.** Turn on *Fit → Lifting body* in the builder and the
quad gets a wing across the middle of the frame, so that in forward flight some
of the weight is carried by air instead of by the motors — a long-range build,
or the idea a speed quad's aero shell is a version of.

The one number that matters is the angle it is rigged at, and its sign is the
thing that catches people out: a quad leans **nose-down** to go forward, which
tips the frame's up-vector forward with it, so a wing lying flat in the plane of
the props meets the air on its *top* surface and pushes down. The angle is
measured leading edge up from the props and has to be bigger than the lean you
cruise at. On the 7-inch, 1.2 kg example, rigging it 30° up takes the cruise from
13.9 A to 9.2 A and the range from 18.6 km to 23.6 km; rigging it flat costs you
a third of the range. [`aircraft/lb7-longrange.json`](aircraft/lb7-longrange.json)
is one built, and `node test/liftbody_test.js` prints the whole table.

**Tail-sitters** stand on their tail, hover on the props, then pitch over and fly
horizontally — the shape the fastest drones in the world are built in.
[`aircraft/speed-tailsitter.json`](aircraft/speed-tailsitter.json) is one in the class
of the Peregreen V4: it leaves the pad at 300 km/h straight up, transitions in 2.5
seconds on `T`, and runs at 653 km/h until the pack gives out about forty seconds
later. The OSD says HOVER, TRANSITION or FORWARD FLIGHT; Angle is the mode to hover
in. `node test/vtol_test.js` flies the whole sortie and prints the numbers.

[`aircraft/blown-wing-twin.json`](aircraft/blown-wing-twin.json) is the other
shape: a one-metre **twin-motor blown wing**. Two motors either side of the
centreline cannot pitch it — there is nothing above or below the middle to
pitch *with* — so it yaws on differential thrust and flies pitch and roll on
elevons sitting in the propwash, which is the only thing holding its attitude
with the nose straight up and no airspeed. It hovers for five minutes, tips
over, and runs at 97 km/h. `node test/vtol_test.js aircraft/blown-wing-twin.json`
proves the wash is what is flying it: settled to a standstill it answers full
pitch stick at 420°/s, and with the wash taken away it cannot hold the hover
at all.

Nothing in an aircraft file is ever executed. It is read with `JSON.parse` and copied
field by field against a table of rules: every number range-checked and clamped, every
clamp reported in words, anything unrecognised dropped and listed.

- [`docs/aircraft-format.md`](docs/aircraft-format.md) — every field, every formula the
  build sheet uses, and where each number comes from
- [`docs/design-an-aircraft-prompt.md`](docs/design-an-aircraft-prompt.md) — a prompt to
  paste into a Claude chat: give it your build list (frame, motor KV, prop, cells,
  all-up weight) and it writes the file for you

## Training (Settings → Training)

A **course** is a ladder of **lessons**; a lesson is a list of things to fly, in
order, and it scores you out of 1,000 at the end. Three ship with the sim:

- **Learn to fly a quad** — ten drills in the order Joshua Bardwell teaches them.
  Throttle on its own, then up and down, then yaw in the hover, then flying out
  and *stopping*, then the box, then turns on the rudder, the figure of eight,
  the nose-in hover, a spot landing, and six gates against a clock.
- **Learn to fly a helicopter** — the hovering ladder every club teaches: tail
  in, side on, nose in, the box, the pirouette, a circuit, and an autorotation.
- **Learn to fly a plane** — the circuit ladder: get it off the ground, fly a
  left-hand circuit round the strip, a figure of eight, slow flight and the
  stall, then approaches and landings.
- **Engine out** — six engine failures with less height each time, from sixty
  metres down to eighteen. A task can carry `cut`, and when it does the sim
  fails the rotor drive for you: there is nothing to press and no warning,
  because a real failure does not wait until you are ready. Fly it on the 450,
  then on the tip-prop heli, then on the gyrodyne, and watch the same ladder
  turn into three different problems.
- **Learn to fly an autogyro** — prerotate and roll, speed and height without
  hard turns, close the throttle and find the glide, and then the flare window.

Each lesson draws what you have to fly: hover cages you have to stay inside,
hoops you have to fly through, gates, and a landing pad. The live one is amber,
the ones behind you turn green. None of them are solid — clipping a hoop costs
precision, not a crash.

**The score is 1,000**: 500 for finishing, 200 for doing it inside the lesson's
par time, and 300 for precision — how near the middle of every marker you
actually flew. A crash costs 120, and so does a hundred and twenty metres of
fence-busting. Gold is 850, silver 650, bronze 420. Only your best on each
lesson is kept, so there is always a reason to fly it again.

**Write your own in a chat.** Settings → Training → *Copy the prompt*, paste it
into a chat with Claude, tell it what you want to learn, and load the JSON it
writes back. It appears in the lesson list beside the built-in courses with the
same medals and scores.

- [`docs/tutorial-format.md`](docs/tutorial-format.md) — every field, the
  coordinates, the four task kinds and exactly how the score is worked out
- [`docs/design-a-tutorial-prompt.md`](docs/design-a-tutorial-prompt.md) — the
  prompt, and what separates a course from a waypoint list

`node test/tutorial_test.js` flies every lesson of all five courses with an
autopilot, which is how a lesson that cannot be completed — a hold that cannot
be held, a marker out of reach, a par nobody could make — gets caught before a
beginner finds it. The engine-out ladder is flown three times over, once on each
rotorcraft, by a pilot that measures the machine's glide ratio first and then
plans the approach on it; the autogyro ladder gets a pilot of its own, because a
gyro steers like a plane and is held up like a rotorcraft and waits for its
prerotator like neither.

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

| | Mode 2 (default) | Mode 1 | Mode 3 |
|---|---|---|---|
| Throttle | `W` / `S` | `↑` / `↓` | `↑` / `↓` |
| Pitch | `↑` / `↓` | `W` / `S` | `W` / `S` |
| Roll | `←` / `→` | `←` / `→` | `A` / `D` |
| Yaw | `A` / `D` | `A` / `D` | `←` / `→` |

| Key | Action |
|---|---|
| `R` | Reset |
| `V` | Cycle view (`1` LOS, `2` FPV, `3` split) |
| `M` | Cycle flight mode |
| `J` `K` `G` | Alt hold, loiter, RTL |
| `H` | Throttle cut (heli: throttle hold) |
| `I` | Heli Normal / 3D pitch curve |
| `C` | Flaps: up / takeoff / landing |
| `U` | Landing gear up / down (retracts) |
| `T` | Tail-sitter: hover ↔ forward flight |
| `L` | Throw the Goblin |
| `P` or `Space` | Pause |
| `F` | Full screen |

Touch screens get on-screen sticks, in the same stick mode as the keys (Settings →
Controller). Mode 3 is Mode 2 the other way round: pitch and roll under the left thumb,
throttle and yaw under the right.

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

### Racing other people

Everyone in a room flies their own aircraft on their own machine — no input lag — and sends
where it is twenty times a second, about **1.4 KB/s a pilot**. The others are drawn from
those messages, a tenth of a second in the past so there is always a message either side of
them, with a short extrapolation when one goes missing. Clocks are lined up with ping/pong,
gates are timed on your own machine, and lap times are told to the room.

Settings → Racing → *Race other people*:

| | |
|---|---|
| **Relay** | where the messages go: *This browser*, *Supabase* or a *WebSocket relay* |
| **Room code** | everyone who types the same code is in the same room |
| **Your colour** | how your aircraft is painted for everyone else |
| **Spectate** | send nothing and ride the view of whichever pilot you pick |
| **Aircraft touching** | fly through each other, or bump |
| **Laps, state messages, smoothing buffer** | race length, how often you send, how far behind others are drawn |

The panel over the view shows who is in the room, their ping and their best lap, with
**Ready**. When everyone is ready there is a shared countdown, then everyone's course resets
together and the lap timer starts. From the countdown on, the panel is the race order: laps
done, then best lap.

**Relays.**
- *This browser* needs nothing at all: two tabs or two windows of the same browser race each
  other over a BroadcastChannel. They share one set of settings, so it is for trying it out
  and for two people at one Chromebook.
- *Supabase* is the easiest way to race over the internet: make a free project, then paste the
  project URL and the anon key from Project Settings → API. They are kept in your browser,
  not in the page. supabase-js is loaded from a CDN at a pinned version the first time you
  connect; Realtime broadcast needs no table and no sign-in.
- *WebSocket relay* is any relay that echoes a room's frames to the room. `node tools/relay.js`
  runs one on your own machine for a club night on the field wi-fi (then put
  `ws://<that machine>:8787` in Relay address); the same few lines fit in a Cloudflare Worker
  for racing over the internet.

**Live racing needs the page served over the internet** —
<https://realpapanerf.github.io/flightline-sim/> — because the claude.ai artifact build cannot
open connections of its own. Everything else, ghosts included, works offline exactly as before.

## Maps: real terrain

The field you start on is flat, and it stays the default. **Settings → Map**
loads real terrain instead — a heightfield built from USGS 3DEP lidar, with the
pilot spot, the runway, the obstacles and the field elevation that comes with
it.

- **List the public maps** downloads from
  [the map library](https://github.com/RealPapaNerf/maps-folder). The URL is a
  field in the panel, so you can point it anywhere static.
- **Open a map folder…** reads a folder off your own disk. This is the only
  route in the claude.ai artifact build, which cannot reach another server, and
  it is how you fly a map offline at the field.

On a map, the terrain is the ground for everything: wheels and bellies touch the
slope and slide down it, the downward lidar ranges to whatever is under you with
the reflectivity of what it is (water comes back at 0.03, which is why a
rangefinder goes blank over a reservoir), a ridge between you and the aircraft
costs the radio link real signal, the OSD gains an **AGL** readout of height
above the ground below, and RTL flies to the map's home.

Field elevation comes from the map, so density altitude follows it without being
asked.

**The ground shapes the wind too.** The air flows up a windward slope and sinks
down a lee one, a valley turns it to run along itself, and behind a ridge it is
sheltered, sinking and rough. On a 200 m ridge in a 10 m/s wind that is about
6.8 m/s of lift on the windward face and 12.7 m/s of sink in the lee — enough
that a trainer cannot outclimb it, which is the point. A wind blowing straight
across a 300 m canyon leaves under 1 m/s in the bottom. Settings → Map →
*Terrain-shaped wind*, on by default; it does nothing without a map.

**Making maps:**
[terrain-and-maps-builder](https://github.com/RealPapaNerf/terrain-and-maps-builder)
is a dependency-free Node CLI that turns a lat/lon box into a map folder.
The format is [`docs/map-format.md`](docs/map-format.md).

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
src/aircraft.js  aircraft file format: validator, build sheet → definition, bench numbers (no DOM)
src/tutorial.js  training: the lesson engine, the scoring and the built-in courses (no DOM)
src/prompts.js   the two chat prompts the sim hands you, for an aircraft and for a course
src/nav.js       sensors, link budget, autopilot (no DOM)
src/render.js    small WebGL 1 renderer
src/terrain.js   map heightfield: the height-and-normal query, terrain rays, chunked LOD meshes (no DOM)
src/maps.js      fetching a map library or reading a map folder off disk
src/ghost.js     lap recording, quantisation, playback and storage (no DOM)
src/net.js       live racing: transports, room protocol, clock sync, interpolation (no DOM)
src/app.js       world, aircraft meshes, cameras, HUD/OSD, controllers, settings, loop
src/shell.html   page markup and styles
src/sw.js        offline cache for the installed app
tools/build.py   assembles index.html (and dist/artifact.html) from src/
tools/relay.js   a dependency-free WebSocket relay for live racing: node tools/relay.js
docs/            the aircraft, tutorial and map formats, and the two prompts that write one
aircraft/        aircraft files anyone can load, with an index.json
test/*.js        bench tests: fm_test (planes), perf (trim table), quad_test <id>, heli_test,
                 vtol_test, modes_test, weather_test, nav_test, ghost_test, net_test, aircraft_test;
                 tutorial_test flies every lesson of every built-in course with an autopilot;
                 quadmodel_test checks which way up a quad is drawn; prompt_test checks the
                 prompts in src/, the docs and the two readers still agree;
                 race_test drives two pages through a relay in headless Chromium (needs playwright);
                 browser_test flies the built page in headless Chromium with a fake radio on the
                 Gamepad API (needs only a chromium binary, and skips without one);
                 terrain_test covers the height query, terrain rays, chunk LOD and contact on
                 slopes; fixture_map writes a synthetic map and screenshot renders it in
                 headless Chromium (needs playwright)
```

Edit `src/`, then run `python3 tools/build.py`. `index.html` is generated; commit it with
the sources (GitHub Pages serves it directly). Run the tests with `node test/<name>.js`.
`input_test` checks the controller recorder against synthetic switch and slider
traces, and every stick mode against what each stick should do; `camera_test` checks
that no aircraft's FPV camera is inside its own fuselage, and that a tail-sitter's
camera mount lands on the angle its file asked for at both ends of the transition;
`quadmodel_test` checks the sign of every part's height on a quad against the sign its
definition asked for. All three lift the code they test straight out of `src/app.js`
by its comment markers, so they cannot drift from what ships.

Those three run pure functions in Node, which cannot reach the DOM, the Gamepad API or
the frame loop — so `browser_test` loads the built `index.html` in headless Chromium
with a fake EdgeTX radio bolted onto `navigator.getGamepads` and works its sticks,
switches, buttons and slider for real. Run `python3 tools/build.py` first: it refuses a
stale `index.html` rather than testing code you are no longer shipping.

## License

MIT. See [LICENSE](LICENSE).
