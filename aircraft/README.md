# Aircraft files

Aircraft you can load without building them. On the web version
(<https://realpapanerf.github.io/flightline-sim/>) use Settings → Aircraft →
**Aircraft from this site's folder**. Anywhere, including offline and in the
installed app, download a `.json` from here and use **Import aircraft file**.

| file | what it is |
|---|---|
| `nano-goblin-ardupilot.json` | the 580 mm plank with an ArduPilot stack, GPS mast and lidar: 300 g |
| `quad-7in-ardupilot.json` | 7-inch long-range quad, ArduPilot, 6S2P 18650, 1.15 kg |
| `quad-10in-geprc-mark4.json` | GEPRC Mark4 LR10 on 6S2P 18650, 1.55 kg, tilting camera mount |
| `quad-13in-recovery.json` | 13-inch lifter, 12S2P 21700, landing gear and the camera pod, 3.7 kg |
| `camera-platform-2m.json` | 2 m pod-and-boom camera plane, 3 kg, long flaps and retracts |
| `speed-tailsitter.json` | tail-sitter in the Peregreen V4's class: hovers on its tail, runs at 653 km/h |
| `aero-5inch-tailsitter.json` | the 5-inch speed design from `5 Inch Speed Design.step`: 263 mm frame, 386 km/h |
| `tip-prop-heli.json` | 1.5 m rotor driven by two props at the blades, no tail rotor, derotated hub camera, 2.6 kg |
| `autogyro.json` | 1.7 m rotor nobody drives, mast raked 9° back, pusher prop and a prerotator, 3.2 kg |
| `gyrodyne.json` | shaft rotor with no tail rotor, two reversing-pitch props on booms; throttle hold makes it an autogyro, 4.5 kg |
| `prandtl-d.json` | 3.75 m bell-spanload flying wing, no fin; proverse yaw. **Needs Sim rules → Accurate aerodynamics** |

## From Whirligig

Eight more were built part-by-part in [Whirligig](https://github.com/RealPapaNerf/whirligig)
and exported with its `tools/export-flightline.js` — a projection, not a
translation: mass, inertia, geometry and battery carry over exactly, thrusts
and head speeds are estimated by momentum theory, and each file's `notes`
field ends with exactly what was estimated.

| file | what it is |
|---|---|
| `heli-600.json` | 600-size direct-drive electric heli, no gearbox, ~4 kg |
| `tipjet.json` | tip-drive heli: free shaft, two props on the blades, no tail rotor, 1.8 kg |
| `triblade.json` | three wings that are also rotor blades, a motor on each, 1.5 kg |
| `stoprotor.json` | the stop-rotor machine flying its helicopter half, 2.2 kg |
| `whirligig-autogyro.json` | the 2 kg autogyro (Flightline's own 3.2 kg one is `autogyro.json`) |
| `whirligig-gyrodyne.json` | the gyrodyne capstone on Flightline's heli→autogyro transition, 2.9 kg |
| `quad-7in-whirligig.json` | the 725 g 7-inch baseline quad on 4S Li-ion |
| `tiltrotor.json` | the tandem-wing tiltrotor as a plain quad in hover trim, 0.95 kg |

**These are starting points, not measurements.** Each one was built from
published frame, motor and cell figures plus a weight estimate, and each file
says in its own `notes` field exactly what was assumed — the sim shows that
under Settings → Aircraft when the aircraft is selected. The two numbers worth
correcting first are **all-up weight** and, for a quad, **thrust per motor**:
the stall speed rides on the first and everything else on the second. Open
Settings → Builder, change them, and press *Fly it*.

Each file carries its build sheet, so the builder opens it where it was left.

## Adding one

1. Build it in Settings → Builder, or write a build sheet with
   [the chat prompt](../docs/design-an-aircraft-prompt.md).
2. Export it, drop the file in this folder, and add a line to `index.json`:

   ```json
   { "file": "my-plane.json", "name": "My plane", "kind": "conventional",
     "blurb": "One sentence for the list." }
   ```

   `file` is the only field the sim needs; the rest is what the list shows
   before anything is loaded.
3. `node test/aircraft_test.js` has to pass. It reads every file here, checks
   it validates, prints its bench numbers, and checks that the folder and
   `index.json` agree in both directions.

[`docs/aircraft-format.md`](../docs/aircraft-format.md) says what every field
means.
