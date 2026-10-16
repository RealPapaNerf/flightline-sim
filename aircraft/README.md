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
