# Flightline aircraft format, version 1

An aircraft is **one JSON file**. It holds a few hundred numbers: the wing
geometry, the airfoil coefficients, the prop, the pack, the control throws and
the points that can hit the ground. The sim reads one with Settings → Aircraft
→ *Import aircraft file*, writes one with *Export this aircraft*, and keeps
imported ones in browser storage so they are there next time.

A file can describe an aircraft in two ways, and may carry both:

There are five kinds: `conventional` (wing, stabiliser, fin), `wing` (a plank
or flying wing with elevons), `quad`, `heli`, and `vtol` — a tail-sitter, which
has its own section below.

| | what it is | units | who writes it |
|---|---|---|---|
| `spec` | a **build sheet**: about thirty numbers you can read off a bench or a product page | mm, g, degrees, inches, mΩ | you, the builder panel, or a chat |
| `def` | the **full definition**: every number the flight model uses, the same shape as an entry in `FL.DEFS` | SI — metres, kilograms, radians, newtons | *Export this aircraft* |

A build sheet is expanded into a definition by one documented function
(`ACF.fromSpec`), so the two never disagree. If a file has both, the definition
wins and the sheet is kept so the builder can reopen it. A sheet is far shorter
and far easier to check by eye — 15 lines against 250 — so it is what
[the chat prompt](design-an-aircraft-prompt.md) asks for.

## What a file can and cannot do

A file is data. It is read with `JSON.parse` and then copied **field by field**
against the tables below. Nothing in it is ever evaluated, and only names that
appear in a table are copied at all, so:

- there is no code in an aircraft file, and no way to put any in;
- a `__proto__` key does nothing, because it is not a field name the reader
  looks for — prototype pollution is not blocked, it is impossible;
- every number is range-checked and clamped, and every clamp is reported in
  words: *"mass: 90 clamped to 80 (allowed 0.02 … 80)"*;
- every string is trimmed, stripped of control characters and length-capped;
- anything the reader does not recognise is dropped and listed;
- a file over 400 kB is refused unread.

The worst a bad file can do is fail to load and tell you why. The reader is
`read()` in [`src/aircraft.js`](../src/aircraft.js); `test/aircraft_test.js`
feeds it bad JSON, a future version, wrong types, out-of-range numbers, a
70-strip wing and a `__proto__` key, and checks it refuses each one.

## The wrapper

```json
{
  "format": "flightline-aircraft/1",
  "author": "RealPapaNerf",
  "version": "2",
  "source": "measured on the bench, 2026-10-14",
  "spec": { },
  "def": { }
}
```

| field | what it is |
|---|---|
| `format` | `"flightline-aircraft/1"`. A bare `"flightline": 1` is also read. A higher version is refused rather than guessed at |
| `author` | your name, ≤ 60 characters. Shown in the aircraft list |
| `version` | your version of *this aircraft*, ≤ 20 characters. Bump it when you reweigh it |
| `source` | ≤ 200 characters, free text: where the numbers came from |
| `spec` | the build sheet, below |
| `def` | the full definition, below |

A file that is a bare definition — no wrapper, just `{"kind": "conventional", …}`
— is read as well, so you can paste a `DEFS` entry straight out of
`src/physics.js`.

## The build sheet

Every field has a default worked out from the fields above it, so a sheet can
be as short as this and still fly:

```json
{
  "format": "flightline-aircraft/1",
  "author": "you",
  "spec": {
    "kind": "plane",
    "id": "ranger",
    "name": "Ranger 2 m",
    "mass": 3000,
    "span": 2000,
    "flapSpan": 70,
    "ailSpan": 25,
    "gear": "retract",
    "watts": 700,
    "cellChem": "lipo",
    "cellsS": 4,
    "cellmAh": 5000
  }
}
```

That is a 2 m, 3 kg plane with long flaps, short ailerons, retracts, 700 W on
4S. Everything else — chord, tail size, airfoil, inertias, drag areas, contact
points, gains — follows from those twelve numbers.

`kind` is `plane` (wing, stabiliser and fin), `wing` (a plank or flying wing
with elevons) or `quad`. `id` and `name` are free text; `blurb` is one or two
sentences for the picker. Quads also take three true/false fields: `quadGear`
(landing legs), `gimbal` (a three-camera pod) and `packTop` (battery above the
frame, default true).

In the builder panel, a field you have not set is marked **auto** and follows
its default, so moving the span moves the chord, the tail, the prop and the
gear with it. A field you type is marked **set** and stays where you put it.
### Every field in the build sheet

A dash means the field does not apply to that type. Where two types share a
column the default is the same.

#### Airframe

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `mass` | all | g | 30 … 60000 | `1000` | `1000` | `1000` |
| `wheelbase` | quad | mm | 60 … 2000 | – | – | `220` |
| `camTilt` | all | ° | -20 … 60 | `0` | `0` | `30` |
| `rateMax` | quad | °/s | 100 … 1800 | – | – | `700` |

#### Wing

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `span` | plane, wing | mm | 300 … 6000 | `1500` | `1500` | – |
| `rootChord` | plane, wing | mm | 40 … 1200 | `221` | `600` | – |
| `tipChord` | plane, wing | mm | 20 … 1200 | `221` | `210` | – |
| `sweep` | plane, wing | ° | 0 … 45 | `0` | `27` | – |
| `dihedral` | plane, wing | ° | -10 … 20 | `4` | `0` | – |
| `washout` | plane, wing | ° | 0 … 6 | `0` | `1.5` | – |
| `wingZ` | plane, wing | mm | -250 … 400 | `100` | `0` | – |
| `airfoil` | plane, wing |  | `flat`, `semi`, `symmetric`, `reflex` | `flat` | `reflex` | – |
| `build` | plane, wing |  | `foam`, `builtup`, `composite` | `builtup` | `foam` | – |
| `staticMargin` | plane, wing | % | 2 … 25 | `10` | `7` | – |

#### Tail

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `tailArm` | plane | mm | 100 … 3000 | `705` | – | – |
| `stabSpan` | plane | mm | 60 … 2000 | `495` | – | – |
| `stabChord` | plane | mm | 25 … 600 | `122` | – | – |
| `stabInc` | plane | ° | -5 … 2 | `-1.5` | – | – |
| `finHeight` | plane, wing | mm | 30 … 1200 | `173` | `195` | – |
| `finChord` | plane, wing | mm | 25 … 800 | `111` | `210` | – |

#### Fuselage

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `fuseW` | plane, wing | mm | 20 … 600 | `120` | `129` | – |
| `fuseH` | plane, wing | mm | 20 … 700 | `140` | `104` | – |
| `noseLen` | plane | mm | 40 … 2000 | `375` | – | – |
| `camX` | plane, wing | mm | -600 … 3000 | `349` | `0` | – |
| `camZ` | plane, wing | mm | -400 … 400 | `92` | `70` | – |
| `gear` | plane, wing |  | `none`, `tricycle`, `taildragger`, `retract` | `tricycle` | `none` | – |

#### Controls

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `ailSpan` | plane, wing | % of half span | 10 … 100 | `50` | `80` | – |
| `ailChord` | plane, wing | % of chord | 8 … 40 | `22` | `15` | – |
| `flapSpan` | plane | % of half span | 0 … 90 | `0` | – | – |
| `flapChord` | plane | % of chord | 10 … 40 | `25` | – | – |
| `elevChord` | plane | % of stab chord | 15 … 60 | `38` | – | – |
| `rudChord` | plane, wing | % of fin chord | 15 … 60 | `45` | `20` | – |
| `throwA` | plane, wing | ° | 3 … 40 | `14` | `9` | – |
| `throwE` | plane, wing | ° | 3 … 40 | `17` | `12` | – |
| `throwR` | plane, wing | ° | 0 … 40 | `25` | `0` | – |
| `throwF` | plane | ° | 10 … 60 | `30` | – | – |

#### Power

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `propD` | all | in | 1.5 … 40 | `9.4` | `9.4` | `5` |
| `thrustPerMotor` | quad | g | 30 … 60000 | – | – | `1250` |
| `propPitch` | all | in | 1 … 20 | `4.7` | `4.7` | `2.5` |
| `blades` | all |  | 2 … 4 | `2` | `2` | `3` |
| `watts` | all | W | 5 … 60000 | `250` | `250` | `2215` |
| `thrustStatic` | plane, wing | g | 0 … 60000 | `0` | `0` | – |
| `motorKV` | all | rpm/V | 50 … 20000 | `990` | `990` | `930` |
| `pitchSpeed` | all | m/s | 0 … 200 | `0` | `0` | `0` |

#### Battery

| field | applies to | unit | range | plane | wing | quad |
|---|---|---|---|---|---|---|
| `cellChem` | all |  | `lipo`, `liion` | `lipo` | `lipo` | `lipo` |
| `cellsS` | all | S | 1 … 14 | `3` | `3` | `6` |
| `cellsP` | all | P | 1 … 8 | `1` | `1` | `1` |
| `cellmAh` | all | mAh | 100 … 30000 | `2200` | `2200` | `1300` |
| `cellR` | all | mΩ | 1 … 200 | `8` | `8` | `8` |


### How the sheet becomes a definition

Every formula is in `fromSpec()` in [`src/aircraft.js`](../src/aircraft.js).
They are all calibrated against the aircraft that were built by hand, and
`node test/aircraft_test.js` prints a generated trainer and a generated 7-inch
quad beside the originals so you can see the error.

**Wing and tail**

| what | formula | where it comes from |
|---|---|---|
| lift-curve slope | `a = 5.9 / (1 + 5.9/(π·0.95·AR))` | the usual 3-D correction. Goblin AR 3.7 → 3.86 (hand-built 3.65); trainer AR 6.8 → 4.57 (4.8) |
| fin aspect ratio | `1.6·h²/area` | a fin against a fuselage behaves like a surface with 1.6× its own aspect ratio |
| airfoil | CL0 / CLmax / CLmin / Cm0 from the four choices | flat-bottomed 0.25 / 1.25 / −0.7 / −0.06 is the trainer; reflexed 0.03 / 0.95 / −0.65 / +0.012 is the Goblin |
| profile drag | `CD0 = 0.012·(2·10⁵/Re)^0.2 ×` 1.2 foam, 1.0 built-up, 0.9 composite | Re at a CL 0.45 cruise. Trainer 0.0123 (hand-built 0.012); Goblin 0.0161 (0.016) |
| stall sharpness | `M` = 30 foam, 40 built-up, 45 composite | matches both hand-built planes |
| tail size | arm 0.47·span, stab 0.33·span × 0.55·root, fin 0.115·span × 0.5·root | the trainer's own proportions; tail volume 0.58, fin volume 0.027 |

**Weight and inertia**

| what | formula | check |
|---|---|---|
| roll inertia | `Ixx = k·m·(b/2)²`, k = 0.10 plane, 0.17 plank | trainer 0.073 (hand-built 0.075); Goblin 0.0036 (0.0035) |
| pitch inertia | `Iyy = k·m·(L/2)²`, k = 0.18 plane, 0.40 plank | trainer 0.084 (0.090); Goblin 0.0031 (0.0030) |
| yaw inertia | `Izz = 0.9·(Ixx + Iyy)` | trainer 0.141 (0.150) |
| quad inertia | `Ixx = 0.27·m·r²`, `Iyy = 1.09·Ixx`, `Izz = 1.8·Ixx`, r = motor radius | the same 0.27 fits the 4, 5, 7 and 13-inch quads to within 10% |

**Drag**

`CdA = [0.30·w·h + gear, 0.28·L·h, 0.34·L·w]` for a plane, where w and h are
the fuselage width and height and L its length. Trainer 0.0065 / 0.047 / 0.049
against 0.0065 / 0.045 / 0.050 by hand; Goblin 0.0006 / 0.0039 / 0.0053
against 0.0007 / 0.004 / 0.006. Fixed gear adds `0.0015·(b/1.5)²` m²;
retracts put that same number in `retract.drag` instead, so it only counts
while the gear is down. A quad is `[0.40, 0.47, 1.00]·D²` — within 20% of all
four built-in quads.

**Power.** This is the one place where planes and quads work in opposite
directions, because of what you can look up:

- **A plane** gives watts, and the sheet works out the thrust:
  `T0 = FOM·(2ρA·(0.8·W)²)^⅓` — momentum theory, with a figure of merit of
  0.65 for two blades, 0.60 for three, 0.56 for four. The trainer's 365 W and
  10-inch prop gives 14.3 N against the 15 N chosen by hand. If you have a
  thrust-stand number, put it in `thrustStatic` and the watts are only used
  for current.
- **A quad** gives the thrust per motor from the motor's own thrust table, and
  the sheet works out the watts: `W = 4·T^1.5/(0.55·√(2ρA))/0.8`. Against the
  built-in quads: 5-inch 2,560 W (built by hand as 2,740), 7-inch 2,580
  (2,660), 4-inch 660 (680), 13-inch 5,400 (7,100).

`Vp` — the airspeed where the prop stops pulling at full rpm — is 1.5× the
geometric pitch speed `KV·V·0.85/60 × pitch` for a plane (the trainer's 10×5 on
3S works out at 31 m/s against the 30 chosen by hand), and for a quad
`42 − 30·(D − 0.1)` m/s, which is the line through the four built-in quads.
Set `pitchSpeed` directly if you know your top speed; it lands close to it.

**Battery.** `R = S·cellR/P + 3 mΩ` of wiring, `mAh = cellmAh × P`,
`Vref = S × 3.8` (LiPo) or `3.7` (Li-ion), `Imax = watts/Vref`. Default cell
resistance is 8 mΩ for LiPo and 25 mΩ for Li-ion. Worth checking against the
packs already in the sim: the 12S2P 21700 pack is 80 mΩ, which is
`12 × 13 / 2 + 3`; the 6S2P 18650 is 70 mΩ, which is `6 × 23 / 2 + 3`.

**Trim.** After the definition is built, the elevator that holds level flight
at 1.5× the stall speed is solved for and written into `trim.e`, so the
aircraft flies hands-off at about that speed, like one you have trimmed out.

## The definition

Lengths in metres, mass in kilograms, forces in newtons, angles in **radians**
except where a field name says otherwise (`surfaces[].dihedral`, `inc0`,
`inc1` and the helicopter pitch curves are in degrees). The body frame is
**x forward, y right wing, z down, with the origin at the CG**.

If `staticMargin` is present the whole definition is shifted so the CG lands
that far ahead of the neutral point, which means you can lay a plane out from
the wing leading edge and let the sim place the CG. If it is absent, the
origin is the CG and the geometry has to be right.

### Every field in the definition

#### Every aircraft

| field | range | default | what it is |
|---|---|---|---|
| `id` | text ≤ 32 | **required** | short name used in files and settings; letters, digits, dot, dash, underscore |
| `name` | text ≤ 48 | **required** | what you see in the aircraft picker |
| `blurb` | text ≤ 400 | `""` | one or two sentences shown under the picker |
| `notes` | text ≤ 1200 | *optional* | anything you want to remember about the build; the sim ignores it |
| `mass` | 0.02 … 80 | **required** | flying weight, kg |
| `I` | 3 × (0.000001 … 100) | **required** | moments of inertia about the CG, kg·m² (roll, pitch, yaw) |
| `body.r` | 3 × (-8 … 8) | **required** | where the body drag acts, body metres (x forward, y right, z down), CG at the origin |
| `body.CdA` | 3 × (0 … 4) | **required** | drag area, m², head-on / sideways / from above. Gear-up value if the aircraft has retracts |
| `body.fin` | 0 … 1 | *optional* | helicopter only: tail-boom fin area, m² |
| `body.finX` | -8 … 8 | *optional* | helicopter only: where that fin is, body x |
| `batt.chem` | `lipo`, `liion` | **required** | cell curve to use |
| `batt.cells` | 1 … 24 | **required** | cells in series |
| `batt.mAh` | 50 … 100000 | **required** | capacity of the whole pack |
| `batt.R` | 0.001 … 5 | **required** | internal resistance of the whole pack, ohms |
| `batt.Imax` | 0 … 800 | **required** | current at full throttle, amps |
| `batt.Iidle` | 0 … 30 | **required** | what the receiver, FC, VTX and ESCs draw with the motor stopped, amps |
| `batt.Vref` | 1 … 120 | **required** | the volts the thrust numbers were measured at; cells × 3.8 (LiPo) or 3.7 (Li-ion) |
| `batt.label` | text ≤ 48 | **required** | how the pack is written in the readouts |
| `batt.cool` | 2 × (0 … 5) | *optional* | how fast the pack loses heat, W/K: still, and per √(m/s) of airspeed |
| `batt.cell.d` | 0.005 … 0.1 | **required** | cell diameter, m (18650 is 0.0185, 21700 is 0.021) |
| `batt.cell.l` | 0.01 … 0.3 | **required** | cell length, m |
| `batt.series` | 1 … 24 | *optional* | cells in series, for the model and the label |
| `batt.parallel` | 1 … 12 | *optional* | strings in parallel, for the model and the label |
| `wheels[].p` | 3 × (-8 … 8) | **required** | where the wheel touches, body metres |
| `wheels[].steer` | true / false | *optional* | this wheel steers with the rudder |
| `points[].p` | 3 × (-8 … 8) | **required** | a point that can hit the ground, body metres |
| `points[].name` | text ≤ 24 | **required** | what the crash message calls it |
| `points[].impact` | 0.1 … 200 | **required** | vertical speed it survives, m/s |
| `points[].slide` | 0.1 … 200 | **required** | sideways speed it survives, m/s (99 = it slides) |
| `points[].prop` | true / false | *optional* | a turning prop or rotor: touching the ground while it spins is a strike |
| `points[].foot` | true / false | *optional* | counts as being on the ground (skids, feet) |
| `points[].rotor` | true / false | *optional* | a main rotor blade tip |
| `points[].motor` | 0 … 7 | *optional* | which motor this prop belongs to, for a multirotor |
| `points[].strike` | 0 … 50 | *optional* | speed above which a spinning prop here is a strike, m/s |
| `contact.kW` | 0 … 1000000 | **required** | wheel spring, N/m |
| `contact.cW` | 0 … 100000 | **required** | wheel damping, N·s/m |
| `contact.kB` | 0 … 1000000 | **required** | airframe spring, N/m |
| `contact.cB` | 0 … 100000 | **required** | airframe damping, N·s/m |
| `contact.muRoll` | 0 … 2 | **required** | rolling friction |
| `contact.muLat` | 0 … 3 | **required** | sideways tyre grip |
| `contact.muBody` | 0 … 3 | **required** | friction of anything that is not a wheel |
| `crash.wheelImpact` | 0.5 … 200 | **required** | vertical speed the gear survives, m/s (99 = no gear to fold) |
| `starts` | list ≤ 4 of `launch`, `runway`, `air`, `pad` | **required** | where a reset can put you |
| `fpvCam` | 3 × (-8 … 8) | **required** | FPV camera position, body metres |
| `camTilt` | -40 … 70 | `0` | FPV camera tilt, degrees up |
| `prop.reverse` | true / false | `false` | a reversing ESC: mid-throttle is zero, below it the prop turns backwards |
| `prop.revEff` | 0.1 … 1 | `0.6` | how much thrust it makes backwards, since the blade is the wrong way round |

`fpvCam` has to be in clear air. The FPV view draws your own aircraft, so a camera
inside the fuselage looks out at the inside of its own nose, and a camera a little
way back and high up ends up inside the canopy, which is a box sitting on top of the
nose from 22% to 80% of the body length back. `node test/camera_test.js` checks every
built-in and every file in `aircraft/`, and the build sheet's `camX` and `camZ` put it
somewhere clear by default.

| `colR` | 0.02 … 4 | **required** | radius of the sphere used against trees, poles and wires, m |
| `look.blades` | 2 … 6 | *optional* | how many blades to draw |

#### Planes only (`kind` `conventional` or `wing`)

| field | range | default | what it is |
|---|---|---|---|
| `kind` | `wing`, `conventional` | **required** | `conventional` has a tail, `wing` is a plank or flying wing |
| `staticMargin` | -0.1 … 0.6 | *optional* | CG ahead of the neutral point, as a fraction of the mean chord. Leave it out to place the CG by geometry instead |
| `surfaces[].name` | text ≤ 24 | **required** | shown in the strip table |
| `surfaces[].role` | `wing`, `tail`, `fin` | **required** | `wing` carries the weight, `tail` sees wing downwash, `fin` is left out of the neutral point |
| `surfaces[].mirror` | true / false | *optional* | the same surface on both sides |
| `surfaces[].vertical` | true / false | *optional* | a fin: its span runs up, not out |
| `surfaces[].hidden` | true / false | *optional* | an aerodynamic stand-in — the model does not draw it (a lifting body) |
| `surfaces[].n` | 1 … 14 | **required** | strips per side. 5–7 on a wing, 2 on a tail |
| `surfaces[].y0` | 0 … 6 | **required** | inboard station, m from the centreline |
| `surfaces[].y1` | 0.01 … 6 | **required** | outboard station (tip), m |
| `surfaces[].xLE0` | -8 … 8 | **required** | leading edge at y0, body x |
| `surfaces[].xLE1` | -8 … 8 | **required** | leading edge at y1 — smaller means swept back |
| `surfaces[].c0` | 0.01 … 2.5 | **required** | chord at y0, m |
| `surfaces[].c1` | 0.01 … 2.5 | **required** | chord at y1, m |
| `surfaces[].z0` | -3 … 3 | **required** | height of the surface at y0, body z (negative is above the CG) |
| `surfaces[].dihedral` | -60 … 60 | *optional* | degrees up from the root to the tip |
| `surfaces[].inc0` | -15 … 15 | *optional* | incidence at the root, degrees |
| `surfaces[].inc1` | -15 … 15 | *optional* | incidence at the tip; less than inc0 is washout |
| `surfaces[].sweepLoad` | -1 … 1 | *optional* | how much sweep pushes the lift outboard (0.25 on a swept plank) |
| `surfaces[].foil.a` | 0.5 … 7 | **required** | lift-curve slope for this surface's aspect ratio, per radian |
| `surfaces[].foil.CL0` | -1 … 1 | **required** | lift coefficient at zero angle of attack (camber) |
| `surfaces[].foil.CLmax` | 0.2 … 2.2 | **required** | section maximum lift coefficient |
| `surfaces[].foil.CLmin` | -2.2 … -0.1 | **required** | the same upside down (negative) |
| `surfaces[].foil.M` | 5 … 80 | **required** | how sharply it stalls: 30 foam, 40 built-up, 45 composite |
| `surfaces[].foil.CD0` | 0.003 … 0.12 | **required** | section profile drag coefficient |
| `surfaces[].foil.e` | 0.4 … 1.1 | **required** | span efficiency, for induced drag |
| `surfaces[].foil.Cm0` | -0.4 … 0.4 | **required** | section pitching moment about the quarter chord |
| `surfaces[].foil.CN90` | 0.8 … 2.5 | **required** | normal-force coefficient once it is a flat plate |
| `surfaces[].flaps[].y0` | 0 … 6 | **required** | inboard end of this moving surface, m |
| `surfaces[].flaps[].y1` | 0 … 6 | **required** | outboard end, m |
| `surfaces[].flaps[].chord` | 0.002 … 1 | **required** | how deep the moving part is, m |
| `surfaces[].flaps[].a` | -1 … 1 | *optional* | how much aileron stick moves it: −1, 0 or 1 |
| `surfaces[].flaps[].e` | -1 … 1 | *optional* | how much elevator stick moves it |
| `surfaces[].flaps[].r` | -1 … 1 | *optional* | how much rudder stick moves it |
| `surfaces[].flaps[].f` | -1 … 1 | *optional* | how much the flap channel moves it |
| `surfaces[].flaps[].side` | `mirror`, `both` | *optional* | `mirror` flips the sign on the left (ailerons), `both` does not (elevator, flaps) |
| `defl.a` | 0 … 1.2 | **required** | full aileron stick, radians |
| `defl.e` | 0 … 1.2 | **required** | full elevator stick, radians |
| `defl.r` | 0 … 1.2 | **required** | full rudder stick, radians |
| `defl.flapMax` | 0 … 1.4 | **required** | total travel any one surface can reach, radians |
| `defl.f` | 0 … 1.2 | *optional* | full flaps, radians. Leave it out and there is no flap channel |
| `flexQ` | 0 … 1000000 | `0` | control effectiveness is divided by (1 + q/flexQ): foam wings wash out at speed. 0 = rigid |
| `servoRate` | 0.5 … 60 | **required** | servo speed, radians per second |
| `prop.r` | 3 × (-8 … 8) | **required** | prop disc position, body metres (negative x is a pusher) |
| `prop.T0` | 0 … 3000 | **required** | static thrust at full throttle and full pack, newtons |
| `prop.Vp` | 1 … 300 | **required** | airspeed where thrust reaches zero at full rpm, m/s |
| `prop.D` | 0.01 … 2 | **required** | prop diameter, m |
| `prop.tau` | 0.005 … 2 | **required** | how long the motor takes to spool, s |
| `prop.Tmin` | -20 … 0 | **required** | braking thrust at zero throttle, newtons (negative) |
| `prop.torque` | -1 … 1 | **required** | reaction torque per newton of thrust per metre of diameter |
| `prop.wash` | true / false | `false` | true if the slipstream blows over the tail (a tractor) |
| `prop.eta` | 0 … 1 | *optional* | how much of the slipstream has developed at the tail |
| `steerMax` | 0 … 1 | `0` | nosewheel or tailwheel steering at full rudder, radians |
| `retract.drag` | 0 … 0.5 | **required** | extra drag area with the gear down, m² |
| `retract.time` | 0.3 … 20 | **required** | how long the gear takes to move, s |
| `shape.fuseW` | 0.01 … 1.5 | **required** | fuselage width, m — only used to draw it |
| `shape.fuseH` | 0.01 … 1.8 | **required** | fuselage height, m — only used to draw it |
| `shape.wheelR` | 0.004 … 0.4 | *optional* | wheel radius, m — only used to draw it |
| `trim.a` | -1 … 1 | `0` | built-in mechanical trim, stick units |
| `trim.e` | -1 … 1 | `0` | built-in elevator trim: what makes it fly hands-off |
| `trim.r` | -1 … 1 | `0` | built-in rudder trim |
| `stab.kRoll` | 0 … 8 | **required** | Stabilised mode: roll gain |
| `stab.dRoll` | 0 … 2 | **required** | Stabilised mode: roll damping |
| `stab.kPitch` | 0 … 8 | **required** | Stabilised mode: pitch gain |
| `stab.dPitch` | 0 … 2 | **required** | Stabilised mode: pitch damping |
| `stab.turn` | 0 … 3 | **required** | Stabilised mode: how much up elevator it feeds in a bank |
| `look.top` | 3 × (0…1) | *optional* | wing and tail upper surfaces |
| `look.bottom` | 3 × (0…1) | *optional* | their undersides |
| `look.side` | 3 × (0…1) | *optional* | their edges |
| `look.tip` | 3 × (0…1) | *optional* | the outer tenth of each wing, for orientation |
| `look.accent` | 3 × (0…1) | *optional* | the stripe on the right wing |
| `look.fuse` | 3 × (0…1) | *optional* | fuselage sides and top |
| `look.fuseBottom` | 3 × (0…1) | *optional* | fuselage underside |
| `look.canopy` | 3 × (0…1) | *optional* | canopy |
| `look.dark` | 3 × (0…1) | *optional* | prop, cowl and tyres |
| `look.metal` | 3 × (0…1) | *optional* | spinner and gear legs |

#### Quads only (`kind` `quad`)

| field | range | default | what it is |
|---|---|---|---|
| `pid.roll` | 5 × (-500 … 500) | **required** | rate PID: [P 1/s, I 1/s², feed-forward, I limit rad, D s] |
| `pid.pitch` | 5 × (-500 … 500) | **required** | as above |
| `pid.yaw` | 5 × (-500 … 500) | **required** | as above |
| `angle.max` | 5 … 89 | **required** | Angle mode bank and pitch limit, degrees |
| `angle.k` | 0.5 … 30 | **required** | self-level gain, 1/s |
| `angle.rate` | 20 … 2000 | **required** | fastest levelling rate, °/s |
| `rates.roll.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.roll.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.roll.e` | 0 … 1 | **required** | expo, 0…1 |
| `rates.pitch.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.pitch.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.pitch.e` | 0 … 1 | **required** | expo, 0…1 |
| `rates.yaw.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.yaw.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.yaw.e` | 0 … 1 | **required** | expo, 0…1 |
| `kind` | `quad` | **required** | `conventional` has a tail, `wing` is a plank or flying wing |
| `motors` | list ≤ 8 of 3 numbers | **required** | one per motor. Quad: [x, y, spin], body metres, +1 for counter-clockwise seen from above. Tail-sitter: [x, y, z, spin], and the z offsets are what it pitches with |
| `motor.Tmax` | 0.05 … 600 | **required** | thrust per motor at full throttle and Vref volts, newtons |
| `motor.tau` | 0.005 … 1 | **required** | spool-up time constant, s |
| `motor.idle` | 0 … 0.3 | **required** | idle motor command when armed |
| `motor.kQ` | 0.0005 … 0.5 | **required** | yaw torque per newton of thrust, m |
| `motor.Vp` | 1 … 200 | **required** | airspeed where a motor stops pulling at full rpm, m/s |
| `motor.D` | 0.01 … 1.5 | **required** | prop diameter, m |
| `rotorDrag` | 0 … 0.2 | **required** | in-plane rotor drag, N per N of thrust per m/s |
| `gear` | true / false | *optional* | quad: draw landing legs |
| `gimbal` | true / false | *optional* | quad: a three-camera pod instead of an FPV camera |
| `look.front` | 3 × (0…1) | *optional* | quad: front props |
| `look.rear` | 3 × (0…1) | *optional* | quad: rear props |
| `look.frame` | 3 × (0…1) | *optional* | quad: arms and plates |
| `look.wrap` | 3 × (0…1) | *optional* | quad: battery wrap |

#### Tail-sitters only (`kind` `vtol`)

Thrust runs along the nose, so motors offset in **z** pitch it, motors offset in
**y** yaw it by running at different speeds, and roll about the nose is the
propellers' own reaction torque. A four-motor cruciform has all three. A
two-motor flying wing has no motors above or below the centreline at all: it
yaws on differential thrust and flies pitch and roll on elevons sitting in the
propwash. `surf` says which axes belong to the surfaces — the angular
acceleration at which an axis asks for full deflection — and the motor mixer
then leaves those axes alone rather than fighting the surfaces for them. The
validator checks that every axis has something flying it, and that an axis given
to the surfaces has the deflection to fly it with.

| field | range | default | what it is |
|---|---|---|---|
| `pid.roll` | 5 × (-500 … 500) | **required** | rate PID: [P 1/s, I 1/s², feed-forward, I limit rad, D s] |
| `pid.pitch` | 5 × (-500 … 500) | **required** | as above |
| `pid.yaw` | 5 × (-500 … 500) | **required** | as above |
| `angle.max` | 5 … 89 | **required** | Angle mode bank and pitch limit, degrees |
| `angle.k` | 0.5 … 30 | **required** | self-level gain, 1/s |
| `angle.rate` | 20 … 2000 | **required** | fastest levelling rate, °/s |
| `rates.roll.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.roll.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.roll.e` | 0 … 1 | **required** | expo, 0…1 |
| `rates.pitch.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.pitch.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.pitch.e` | 0 … 1 | **required** | expo, 0…1 |
| `rates.yaw.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.yaw.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.yaw.e` | 0 … 1 | **required** | expo, 0…1 |
| `kind` | `vtol` | **required** | `conventional` has a tail, `wing` is a plank or flying wing |
| `motors` | 2 … 8 lists of 4 numbers | **required** | one per motor. Quad: [x, y, spin], body metres, +1 for counter-clockwise seen from above. Tail-sitter: [x, y, z, spin] |
| `motor.Tmax` | 0.05 … 900 | **required** | thrust per motor at full throttle and Vref volts, newtons |
| `motor.tau` | 0.005 … 1 | **required** | spool-up time constant, s |
| `motor.idle` | 0 … 0.3 | **required** | idle motor command when armed |
| `motor.kQ` | 0.0005 … 0.5 | **required** | yaw torque per newton of thrust, m |
| `motor.Vp` | 1 … 400 | **required** | airspeed where a motor stops pulling at full rpm, m/s |
| `motor.D` | 0.01 … 1.5 | **required** | prop diameter, m |
| `staticMargin` | -0.1 … 0.6 | *optional* | CG ahead of the neutral point, as a fraction of the mean chord. Leave it out to place the CG by geometry instead |
| `surf.roll` | 0 … 2000 | `0` | rad/s² at which roll asks for full aileron. Non-zero gives roll to the surfaces and the motor mixer stops mixing for it |
| `surf.pitch` | 0 … 2000 | `0` | the same for pitch and the elevator |
| `surf.yaw` | 0 … 2000 | `0` | the same for yaw and the rudder |
| `washEta` | 0 … 1 | `0.5` | how much of the propwash reaches a surface sitting behind a propeller |
| `surfaces[].name` | text ≤ 24 | **required** | shown in the strip table |
| `surfaces[].role` | `wing`, `tail`, `fin` | **required** | `wing` carries the weight, `tail` sees wing downwash, `fin` is left out of the neutral point |
| `surfaces[].mirror` | true / false | *optional* | the same surface on both sides |
| `surfaces[].vertical` | true / false | *optional* | a fin: its span runs up, not out |
| `surfaces[].hidden` | true / false | *optional* | an aerodynamic stand-in — the model does not draw it (a lifting body) |
| `surfaces[].n` | 1 … 14 | **required** | strips per side. 5–7 on a wing, 2 on a tail |
| `surfaces[].y0` | 0 … 6 | **required** | inboard station, m from the centreline |
| `surfaces[].y1` | 0.01 … 6 | **required** | outboard station (tip), m |
| `surfaces[].xLE0` | -8 … 8 | **required** | leading edge at y0, body x |
| `surfaces[].xLE1` | -8 … 8 | **required** | leading edge at y1 — smaller means swept back |
| `surfaces[].c0` | 0.01 … 2.5 | **required** | chord at y0, m |
| `surfaces[].c1` | 0.01 … 2.5 | **required** | chord at y1, m |
| `surfaces[].z0` | -3 … 3 | **required** | height of the surface at y0, body z (negative is above the CG) |
| `surfaces[].dihedral` | -60 … 60 | *optional* | degrees up from the root to the tip |
| `surfaces[].inc0` | -15 … 15 | *optional* | incidence at the root, degrees |
| `surfaces[].inc1` | -15 … 15 | *optional* | incidence at the tip; less than inc0 is washout |
| `surfaces[].sweepLoad` | -1 … 1 | *optional* | how much sweep pushes the lift outboard (0.25 on a swept plank) |
| `surfaces[].foil.a` | 0.5 … 7 | **required** | lift-curve slope for this surface's aspect ratio, per radian |
| `surfaces[].foil.CL0` | -1 … 1 | **required** | lift coefficient at zero angle of attack (camber) |
| `surfaces[].foil.CLmax` | 0.2 … 2.2 | **required** | section maximum lift coefficient |
| `surfaces[].foil.CLmin` | -2.2 … -0.1 | **required** | the same upside down (negative) |
| `surfaces[].foil.M` | 5 … 80 | **required** | how sharply it stalls: 30 foam, 40 built-up, 45 composite |
| `surfaces[].foil.CD0` | 0.003 … 0.12 | **required** | section profile drag coefficient |
| `surfaces[].foil.e` | 0.4 … 1.1 | **required** | span efficiency, for induced drag |
| `surfaces[].foil.Cm0` | -0.4 … 0.4 | **required** | section pitching moment about the quarter chord |
| `surfaces[].foil.CN90` | 0.8 … 2.5 | **required** | normal-force coefficient once it is a flat plate |
| `surfaces[].flaps[].y0` | 0 … 6 | **required** | inboard end of this moving surface, m |
| `surfaces[].flaps[].y1` | 0 … 6 | **required** | outboard end, m |
| `surfaces[].flaps[].chord` | 0.002 … 1 | **required** | how deep the moving part is, m |
| `surfaces[].flaps[].a` | -1 … 1 | *optional* | how much aileron stick moves it: −1, 0 or 1 |
| `surfaces[].flaps[].e` | -1 … 1 | *optional* | how much elevator stick moves it |
| `surfaces[].flaps[].r` | -1 … 1 | *optional* | how much rudder stick moves it |
| `surfaces[].flaps[].f` | -1 … 1 | *optional* | how much the flap channel moves it |
| `surfaces[].flaps[].side` | `mirror`, `both` | *optional* | `mirror` flips the sign on the left (ailerons), `both` does not (elevator, flaps) |
| `defl.a` | 0 … 1.2 | **required** | full aileron stick, radians |
| `defl.e` | 0 … 1.2 | **required** | full elevator stick, radians |
| `defl.r` | 0 … 1.2 | **required** | full rudder stick, radians |
| `defl.flapMax` | 0 … 1.4 | **required** | total travel any one surface can reach, radians |
| `defl.f` | 0 … 1.2 | *optional* | full flaps, radians. Leave it out and there is no flap channel |
| `flexQ` | 0 … 1000000 | `0` | control effectiveness is divided by (1 + q/flexQ): foam wings wash out at speed. 0 = rigid |
| `servoRate` | 0.5 … 60 | `8` | servo speed, radians per second |
| `trans.time` | 0.2 … 30 | **required** | seconds to swing the nose between vertical and level |
| `trans.pitch` | -0.4 … 0.4 | **required** | the attitude it holds in cruise, radians nose-up |
| `trans.vAir` | 1 … 300 | **required** | the speed a start in the air begins at, m/s |
| `shape.fuseW` | 0.01 … 1.5 | **required** | fuselage width, m — only used to draw it |
| `shape.fuseH` | 0.01 … 1.8 | **required** | fuselage height, m — only used to draw it |
| `shape.wheelR` | 0.004 … 0.4 | *optional* | wheel radius, m — only used to draw it |
| `rotorDrag` | 0 … 0.2 | **required** | in-plane rotor drag, N per N of thrust per m/s |
| `look.top` | 3 × (0…1) | *optional* | wing and tail upper surfaces |
| `look.bottom` | 3 × (0…1) | *optional* | their undersides |
| `look.side` | 3 × (0…1) | *optional* | their edges |
| `look.tip` | 3 × (0…1) | *optional* | the outer tenth of each wing, for orientation |
| `look.accent` | 3 × (0…1) | *optional* | the stripe on the right wing |
| `look.fuse` | 3 × (0…1) | *optional* | fuselage sides and top |
| `look.fuseBottom` | 3 × (0…1) | *optional* | fuselage underside |
| `look.canopy` | 3 × (0…1) | *optional* | canopy |
| `look.dark` | 3 × (0…1) | *optional* | prop, cowl and tyres |
| `look.metal` | 3 × (0…1) | *optional* | spinner and gear legs |

#### Helicopters only (`kind` `heli`)

| field | range | default | what it is |
|---|---|---|---|
| `pid.roll` | 5 × (-500 … 500) | **required** | rate PID: [P 1/s, I 1/s², feed-forward, I limit rad, D s] |
| `pid.pitch` | 5 × (-500 … 500) | **required** | as above |
| `pid.yaw` | 5 × (-500 … 500) | **required** | as above |
| `angle.max` | 5 … 89 | **required** | Angle mode bank and pitch limit, degrees |
| `angle.k` | 0.5 … 30 | **required** | self-level gain, 1/s |
| `angle.rate` | 20 … 2000 | **required** | fastest levelling rate, °/s |
| `rates.roll.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.roll.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.roll.e` | 0 … 1 | **required** | expo, 0…1 |
| `rates.pitch.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.pitch.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.pitch.e` | 0 … 1 | **required** | expo, 0…1 |
| `rates.yaw.c` | 1 … 600 | **required** | Betaflight Actual rates: centre sensitivity, °/s |
| `rates.yaw.m` | 20 … 2000 | **required** | max rate at full stick, °/s |
| `rates.yaw.e` | 0 … 1 | **required** | expo, 0…1 |
| `kind` | `heli` | **required** | `conventional` has a tail, `wing` is a plank or flying wing |
| `rotor.R` | 0.05 … 2 | **required** | rotor radius, m |
| `rotor.chord` | 0.005 … 0.2 | **required** | blade chord, m |
| `rotor.blades` | 2 … 8 | **required** | number of main-rotor blades |
| `rotor.a` | 2 … 8 | **required** | blade lift-curve slope, per radian |
| `rotor.Cd0` | 0.004 … 0.06 | **required** | blade profile drag coefficient |
| `rotor.kInd` | 1 … 1.5 | **required** | induced-power factor (1.15 is typical) |
| `rotor.CLmax` | 0.4 … 1.6 | **required** | mean blade lift coefficient it can hold |
| `rotor.om0` | 20 … 3000 | **required** | governed headspeed, rad/s (rpm × π/30) |
| `rotor.J` | 0.00001 … 5 | **required** | rotor inertia, kg·m² — what you autorotate on |
| `rotor.Pmax` | 10 … 20000 | **required** | motor power the governor can call on, W |
| `rotor.govK` | 0 … 1 | **required** | governor gain |
| `rotor.spool` | 0.01 … 3 | **required** | spool-up time constant, s |
| `rotor.friction` | 0 … 0.1 | **required** | drivetrain friction torque, N·m |
| `rotor.h` | 0 … 1.5 | **required** | hub height above the CG, m |
| `rotor.Kh` | 0 … 2000 | **required** | hub stiffness, N·m/rad |
| `rotor.tauF` | 0.001 … 0.5 | **required** | how quickly the disc follows a cyclic input, s |
| `rotor.maxCyc` | 0.02 … 0.6 | **required** | cyclic limit, radians of disc tilt |
| `rotor.blowback` | 0 … 20 | **required** | how much forward speed tilts the disc back |
| `rotor.lt` | 0.05 … 3 | **required** | tail rotor arm, m |
| `rotor.TtMax` | 0.1 … 300 | **required** | tail thrust at full headspeed, N |
| `rotor.tauT` | 0.002 … 0.5 | **required** | tail response lag, s |
| `rotor.spin` | -1 … 1 | **required** | main rotor direction: −1 clockwise seen from above |
| `rotor.curves.normal` | 3 × (-20 … 20) | **required** | collective in degrees at stick 0, ½ and 1 |
| `rotor.curves.3d` | 3 × (-20 … 20) | **required** | the same for the 3D curve (zero pitch at mid stick) |
| `look.front` | 3 × (0…1) | *optional* | quad: front props |
| `look.rear` | 3 × (0…1) | *optional* | quad: rear props |
| `look.frame` | 3 × (0…1) | *optional* | quad: arms and plates |
| `look.wrap` | 3 × (0…1) | *optional* | quad: battery wrap |

## Tail-sitters

`kind: "vtol"` is four motors thrusting along the nose and wings in the cruise
frame: it stands on its tail, hovers on the props, pitches over, and flies
horizontally. `aircraft/speed-tailsitter.json` is one, in the class of the
Peregreen V4 that holds the Guinness record at 657.59 km/h.

**The one idea.** There is no hover controller and no forward controller.
There is one attitude the aircraft should be holding, which starts vertical and
ends level, and the ordinary multirotor controller flies *level in that frame*:

```
tilt = (1 − fwd)·90° + fwd·trans.pitch        fwd: 0 on its tail … 1 flying level
Rf   = R · Ry(−tilt)                          the control frame
setpoints = the same multirotor controller, given Rf
```

The transition is that frame rotating, with `fwd` running 0 → 1 over
`trans.time` seconds when you press `T`. Acro, Horizon, Angle and Acro-trainer
all work in both regimes, and because the frame is near level at both ends the
Euler angles the controller works in never reach the 90° singularity a
tail-sitter otherwise lives on.

**What is different from a quad**

| | quad | tail-sitter |
|---|---|---|
| thrust | along −z, out of the top | along +x, out of the nose |
| `motors` | `[x, y, spin]` | `[x, y, z, spin]` |
| pitch | from the x offsets | from the **z** offsets |
| yaw | from the prop torque | from the **y** offsets |
| roll | from the y offsets | from the **prop torque** — so it rolls lazily and pitches hard |
| thrust at speed | falls to a quarter and stops there | falls to **zero** at the pitch speed, which is what sets the top speed |
| lift | none | the strip model, in the cruise frame |

It needs motors above and below the centreline to pitch with, and some wing
area to fly on; the validator checks both.

**Giving it lift.** A speed machine's lift comes from its fuselage and its arm
fairings, so the aircraft file says so directly: the body is one surface with a
low aspect ratio, a slow lift curve and a late stall, and the four arms are two
mirrored pairs at ±45° of dihedral — a cruciform wing. A surface with
`"hidden": true` is not drawn by the 3-D model, which is how the fuselage can
be a lifting body to the physics and a fuselage to your eyes.

**What this does not do.** The autopilot has no transition in it, so ALT HOLD,
LOITER and RTL are off on a tail-sitter. There is no compressibility anywhere
in this model: the record aircraft cruises at Mach 0.53 with its prop tips past
Mach 1, so treat the top end as optimistic. And the build sheet has no `vtol`
kind yet — write the definition, or start from the file in `aircraft/`.

**What makes one faster.** A tail-sitter at speed is propeller-limited, not
drag-limited or thrust-limited. Taking `aircraft/aero-5inch-tailsitter.json`
— a 5-inch, 1.1 kg machine that tops out at 386 km/h — and changing one thing
at a time:

| change | top speed | |
|---|---|---|
| as drawn | 386 km/h | |
| pitch speed 150 → 200 m/s | 446 km/h | **+60** |
| pitch speed 150 → 260 m/s | 499 km/h | **+113** |
| thrust 1,800 → 2,400 gf per motor | 411 km/h | +25 |
| head-on drag area 0.0016 → 0.0011 m² | 401 km/h | +15 |
| arm fairings half as draggy | 391 km/h | +6 |
| 1,100 → 900 g | 387 km/h | +1 |
| 1,100 → 1,400 g | 384 km/h | −2 |
| pitch speed 260, the cleaner shell and the bigger motors together | 579 km/h | +194 |

Weight hardly matters to the top speed at all — it decides the hover time and
the climb. Pitch speed is worth more than everything else put together, which
is why the Peregreen team went from 800KV to 900KV and cut their props down:
a shorter blade off the same high-pitch stock is a higher pitch-to-diameter
ratio, and that is the number the top end is made of.

`node test/vtol_test.js [file.json]` flies one: off the pad, a hover, the
transition, the top speed on a full pack and on a draining one, the
back-transition and the landing.

## Strips, and why planes are capped at 40

Each lifting surface is cut into `n` strips per side, and every strip is
solved separately each step: its own airflow, its own angle of attack, its own
stall. That is where wing drop, tip stall and spin entry come from, and it is
also essentially the whole cost of flying a plane. The built-in planes use 13
and 16 strips; a 2 m plane with flaps uses 20. A file whose surfaces add up to
more than **40** strips is refused, with the count in the message.

Useful numbers: 5 to 7 per wing side, 2 per tail side, 1 or 2 on a fin. More
than 8 on a wing buys very little — the load distribution is already smooth —
and the stall behaviour barely moves.

## Flaps, and how much they are worth

A flap entry with `"f": 1` puts that part of the wing on the flap channel
(`C` in the sim, or a controller switch), with `defl.f` as full travel. Three
things make a flap behave like a real one, and all three are in
`src/physics.js`:

- **Effectiveness falls off with deflection.** Thin-airfoil theory holds to
  about 12°; past that the flow starts to leave the flap and the extra lift
  tails off. A plain flap at 30° gives about 65% of what theory says, and at
  45° it has nearly given up.
- **A flap raises the section's stall angle.** Measured plain-flap data (NACA
  23012, 20% flap at 30°: CLmax +0.5 with the stall 4° earlier) says the extra
  lift is worth about 55% of what the deflection adds. Without this, any
  landing flap setting reads as a wing that is already stalled.
- **A part-span flap induces downwash on itself**, and that is what stops the
  flapped span from letting go well before the rest of the wing. The induced
  angle scales with how little of the span the flap covers.

What comes out, on a 2 m, 3 kg plane with 25%-chord flaps at 30°:

| flap span (% of half span) | share of wing area | 1-g stall, clean → full flap |
|---|---|---|
| 30% | 29% | 9.29 → 9.48 m/s (+2.1%) |
| 45% | 43% | 9.29 → 9.45 m/s (+1.7%) |
| 60% | 57% | 9.29 → 9.17 m/s (−1.3%) |
| 70% | 71% | 9.29 → 8.81 m/s (−5.2%) |
| 85% | 86% | 9.29 → 8.44 m/s (−9.1%) |

**Short flaps cost you stall speed.** They separate part of the wing early
without raising the whole wing's peak lift. That is why a camera plane wants
long flaps and short ailerons — and it is also why flaps are mostly a drag
device: at any span they let you come down steeply and fly a lower nose
attitude, which is usually the point.

This is a plain-flap model. Slotted and Fowler flaps do better than anything
here and the format has no way to say so yet.

## Retractable gear

```json
"retract": { "drag": 0.0027, "time": 3 }
```

The wheels only touch the ground when the gear is down, `drag` m² of frontal
area is added while it is, and `time` is how long it takes to move. `body.CdA`
holds the clean figure. `U` raises and lowers it, and the OSD says GEAR UP in
red below 25 m if you are going down.

On that same 2 m plane the gear is worth about one point of throttle at 34 mph
and 1 m/s of top speed — small, which is what you would expect from a drag
area a thirtieth the size of the wing's.

## An aircraft folder

A public repository can serve aircraft files beside the page. The sim's own
folder is [`aircraft/`](../aircraft), and *Settings → Aircraft → Aircraft from
this site's folder* reads `aircraft/index.json`:

```json
{
  "format": "flightline-aircraft-index/1",
  "aircraft": [
    { "file": "nano-goblin-ardupilot.json", "id": "goblin-ap", "name": "Nano Goblin · ArduPilot",
      "kind": "wing", "blurb": "580 mm plank, 2S Li-ion, lidar and a GPS mast." }
  ]
}
```

`file` is the only field that has to be there; the rest is what the list
shows before you load anything. `id` is the `def.id` inside that file: give it
and the sim can say which entries are already loaded, and offer only the new
ones, without fetching every file first. Files load by URL too, so anything on
`raw.githubusercontent.com` works — that host sends the header a browser needs
to read it from another site. This only works on the web version: opened as a
local file there is no folder to read.

Loading the same aircraft twice adds nothing the second time. Every file that
comes in is written out in canonical form and compared with what is already
there, ignoring the id: if some aircraft in the library is the same file, the
import stops and says so, whatever either copy is called. That is what makes
*Load all* safe to press again after a file is added to the folder — and what
*Remove duplicates* in Settings → Aircraft uses to find copies an older build
left behind. Change one gram, or the name, and it is a different aircraft
again.

## What version 1 leaves out

- **Helicopters can be imported and exported but not built.** The build sheet
  has no `heli` kind; the rotor block is documented above and the hand-built
  450 exports and re-imports unchanged.
- **A quadplane is not a tail-sitter.** `vtol` is the aircraft that pitches
  its whole airframe over. One that keeps its wing level and tilts only its
  motors, or carries separate lift and cruise motors, needs a second thrust
  axis the format does not have.
- **No tail-sitter in the build sheet.** It can be imported, exported and
  flown, but not generated from a page of numbers.
- **Slotted and Fowler flaps, spoilers and airbrakes.** The flap channel is a
  plain hinged surface.
- **No per-strip airfoil.** One airfoil per surface.
- **No thrust or power curve.** The prop is two numbers, static thrust and
  pitch speed, and thrust falls linearly between them. A measured curve from a
  thrust stand would be better, and is the obvious version 2.
- **Colours only, no texture or model file.** The 3-D model is drawn from the
  geometry you give, and `look` tints it.

## Checking a file

```
node test/aircraft_test.js
```

Exports every built-in aircraft, reads it back and compares a fingerprint of
the rebuilt aircraft — geometry, every strip, hover solutions and a 3-second
flight — against the original, so a round trip cannot quietly change how
anything flies. It also prints the validator's refusals, the default plane,
wing and quad from the build sheet, and the generated-versus-hand-built
comparisons.
