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
sentences for the picker. Quads also take four true/false fields: `quadGear`
(landing legs), `gimbal` (a three-camera pod), `packTop` (battery above the
frame, default true) and `liftBody` (a wing across the middle of the frame —
see [Lifting bodies on a quad](#lifting-bodies-on-a-quad)).

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

#### Lifting body — quads with `liftBody: true`

| field | applies to | unit | range | default |
|---|---|---|---|---|
| `lbSpan` | quad | mm | 50 … 3000 | `1.15 × wheelbase` |
| `lbChord` | quad | mm | 20 … 1500 | `0.42 × lbSpan` |
| `lbTipChord` | quad | mm | 10 … 1500 | `lbChord` |
| `lbSweep` | quad | ° | -30 … 60 | `0` |
| `lbAngle` | quad | ° | 0 … 90 | `30` |
| `lbAirfoil` | quad | — | flat / semi / symmetric / reflex | `symmetric` |

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
| `prop.Ip` | 0 … 1 | *optional* | spinning inertia of prop + motor bell, kg·m², for the Accurate model's gyroscopics. Left out, it is estimated from the diameter |
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
| `surfaces` | list ≤ 4 | *optional* | quad: a lifting body, as the same surface shape a plane uses |
| `lift.span` | 0.02 … 4 | *optional* | quad: what the model draws the lifting body from, metres |
| `lift.rootChord` | 0.01 … 2 | *optional* | quad: root chord, metres |
| `lift.tipChord` | 0.01 … 2 | *optional* | quad: tip chord, metres |
| `lift.angle` | 0 … 90 | *optional* | quad: how far the leading edge is rigged up out of the plane of the props, degrees |
| `lift.sweep` | -45 … 60 | *optional* | quad: leading-edge sweep, degrees |
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
| `trans.camHover` | -30 … 30 | `-10` | where the FPV camera looks in the hover, degrees up from the horizon |
| `trans.camFwd` | -10 … 0 | `-10` | where it looks in forward flight, degrees from the direction of flight |
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

#### Rotorcraft only (`kind` `heli` or `gyro`)

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
| `kind` | `heli`, `gyro` | **required** | `gyro` is an autogyro: a rotorcraft, but not one that hovers |
| `rotor.R` | 0.05 … 2 | **required** | rotor radius, m |
| `rotor.chord` | 0.005 … 0.2 | **required** | blade chord, m |
| `rotor.blades` | 2 … 8 | **required** | number of main-rotor blades |
| `rotor.a` | 2 … 8 | **required** | blade lift-curve slope, per radian |
| `rotor.Cd0` | 0.004 … 0.06 | **required** | blade profile drag coefficient |
| `rotor.kInd` | 1 … 1.5 | **required** | induced-power factor (1.15 is typical) |
| `rotor.CLmax` | 0.4 … 1.6 | **required** | mean blade lift coefficient it can hold |
| `rotor.om0` | 20 … 3000 | **required** | governed headspeed, rad/s (rpm × π/30) |
| `rotor.J` | 0.00001 … 5 | **required** | rotor inertia, kg·m² — what you autorotate on |
| `rotor.Pmax` | 0 … 20000 | **required** | motor power the governor can call on, W (0 on an autogyro) |
| `rotor.govK` | 0 … 1 | **required** | governor gain |
| `rotor.spool` | 0.01 … 3 | **required** | spool-up time constant, s |
| `rotor.friction` | 0 … 0.1 | **required** | drivetrain friction torque, N·m |
| `rotor.h` | 0 … 1.5 | **required** | hub height above the CG, m |
| `rotor.Kh` | 0 … 2000 | **required** | hub stiffness, N·m/rad |
| `rotor.tauF` | 0.001 … 0.5 | **required** | how quickly the disc follows a cyclic input, s |
| `rotor.maxCyc` | 0.02 … 0.6 | **required** | cyclic limit, radians of disc tilt |
| `rotor.blowback` | 0 … 20 | **required** | how much forward speed tilts the disc back |
| `rotor.lt` | 0 … 3 | **required** | tail rotor arm, m (0 if it has no tail rotor) |
| `rotor.TtMax` | 0 … 300 | **required** | tail thrust at full headspeed, N (0 if it has no tail rotor) |
| `rotor.tauT` | 0.002 … 0.5 | **required** | tail response lag, s |
| `rotor.spin` | -1 … 1 | **required** | main rotor direction: −1 clockwise seen from above |
| `rotor.curves.normal` | 3 × (-20 … 20) | *optional* | collective in degrees at stick 0, ½ and 1 |
| `rotor.curves.3d` | 3 × (-20 … 20) | *optional* | the same for the 3D curve (zero pitch at mid stick) |
| `rotor.drive` | `shaft`, `tip`, `none` | *shaft* | what turns the rotor — see [Three ways to turn a rotor](#three-ways-to-turn-a-rotor) |
| `rotor.fixed` | -5 … 15 | *optional* | one blade angle for the whole flight, degrees. An autogyro has this instead of `curves` |
| `rotor.autoPitch` | -10 … 10 | *optional* | where a collective parks when the drive goes off and the stick becomes engine power, degrees |
| `rotor.rake` | 0 … 20 | *0* | degrees the mast leans back. An autogyro's reason to turn at all |
| `rotor.rakeFree` | 0 … 20 | *= rake* | the rake the head takes up with the drive off — a tilting head, and a gyrodyne's mode change |
| `rotor.tauRake` | 0.1 … 10 | *1.2* | how long the head takes to get there, s |
| `rotor.hFlare` | 0.2 … 10 | *2* | the height the cushion is flown over, which is what the flare margin is measured against, m |
| `rotor.tip.n` | 1 … 8 | **required with `tip`** | how many propellers are out on the blades |
| `rotor.tip.r` | 0.02 … 2 | **required with `tip`** | how far out they are, m |
| `rotor.tip.Tmax` | 0.1 … 600 | **required with `tip`** | static thrust of each one, N |
| `rotor.tip.Vp` | 5 … 400 | **required with `tip`** | its pitch speed, m/s: thrust fades to nothing as the tip approaches this |
| `rotor.tip.eta` | 0.1 … 1 | **required with `tip`** | how much of the electrical power reaches the rotor |
| `rotor.tip.kD` | 0 … 0.1 | **required with `tip`** | pod drag torque, N·m per (rad/s)² — paid whether driven or not |
| `rotor.mast.Q` | 0 … 200 | *optional* | a motor across the mast bearing: the pedal on a machine with no reaction torque, N·m |
| `rotor.vane.area` | 0 … 2 | *optional* | vanes or a rudder in the rotor's wash, m² |
| `rotor.vane.arm` | 0.02 … 4 | *optional* | their arm behind the CG, m |
| `rotor.vane.k` | 0 … 4 | *optional* | lift coefficient at full deflection |
| `rotor.prerot.Q` | 0 … 200 | *optional* | prerotator torque, N·m. Runs only on the ground with the throttle closed |
| `rotor.prerot.om` | 1 … 3000 | *optional* | the headspeed it spins up to, rad/s |
| `thrusters[].p` | 3 × (-4 … 4) | *optional* | a propeller bolted to the airframe: where it is, m |
| `thrusters[].Tmax` | 0.1 … 600 | *optional* | its thrust, N |
| `thrusters[].Tmin` | -600 … 0 | *0* | how hard it can push backwards — below zero means reversing pitch |
| `thrusters[].tau` | 0.005 … 2 | *optional* | response lag, s |
| `thrusters[].Vp` | 1 … 300 | *optional* | pitch speed, m/s |
| `thrusters[].D` | 0.01 … 1.5 | *optional* | diameter, m |
| `thrusters[].yaw` | true/false | *false* | whether this one is part of the pedal |
| `cruise` | 1 … 120 | *optional* | the speed an air start begins at, for a machine that cannot hover, m/s |
| `hubCam` | 3 × (-8 … 8) | *optional* | a derotated camera on top of the rotor head, body coordinates |
| `steerMax` | 0 … 1 | *0* | nosewheel steering, for a rotorcraft that takes off on wheels |
| `look.front` | 3 × (0…1) | *optional* | quad: front props |
| `look.rear` | 3 × (0…1) | *optional* | quad: rear props |
| `look.frame` | 3 × (0…1) | *optional* | quad: arms and plates |
| `look.wrap` | 3 × (0…1) | *optional* | quad: battery wrap |

## Three ways to turn a rotor

`kind` `heli` and `kind` `gyro` share one rotor model. What separates the
machines built on it is `rotor.drive`, and which of the optional blocks above
the file carries with it.

### `shaft` — a motor on the mast

The ordinary helicopter, and the default. The motor's torque has to react on
something and the something is the airframe, which is what a tail rotor is for:
`lt` and `TtMax`. The throttle stick is the collective, through `curves`, and it
stays live with the motor held — that is what you autorotate on.

A shaft-driven rotor **without** a tail rotor has to put that reaction
somewhere else. The gyrodyne puts it into a pair of `thrusters` with `yaw` set
and `Tmin` below zero, so one pushes while the other pulls and the torque is
cancelled at no net thrust. Without something to take it, the airframe simply
turns the other way.

### `tip` — propellers out on the blades

A tipjet, driven by propellers rather than gas. They push against the air and
not against the airframe, so there is no reaction torque at all and nothing for
a tail rotor to cancel.

One number sizes the whole machine: `tip.Vp`, the propellers' pitch speed. A
propeller stops pulling when it is flying at its own pitch speed, and these ones
are flying at the blade tip speed, so the tip speed has to stay well under it.
A slow tip speed buys thrust only through area, so the rotor comes out big and
lightly loaded — which is why the tip-prop heli in `aircraft/` glides twice as
far as a 450 and autorotates at under 3 m/s. `tip.kD` is the pods' drag, paid
whether they are driven or not, and it is what you give up for all of that.

With no torque path between rotor and fuselage, the fuselage hangs free on the
mast bearing and has nothing to point the nose with either. `mast.Q` is the
answer: a motor across that bearing, turning the fuselage against the rotor's
own angular momentum. It works at a standstill and it works with the drive
dead — and its reaction comes out of the rotor, so on a machine like this **the
pedal spends headspeed**.

### `none` — an autogyro

Nothing drives the rotor, ever. `rake` leans the mast back so that air comes up
through the disc all the time and keeps it turning, which is autorotation flown
on purpose, and `thrusters` push the machine along fast enough for that to keep
happening. The blades sit at one angle, `fixed`, for the whole flight: there is
no collective and `curves` is left out.

It cannot hover and it cannot stall. It needs a run to take off and a `prerot`
to start the head, because standing still there is no air going through the
disc. And every landing is an autorotation, flared in a window about a metre
deep, which is why its `starts` are `runway` and `air` rather than `pad`.

### The energy budget

Whatever is driving it, once the drive goes off the only budget left is the one
in the rotor, and the sim reports it as **flare margin** — in the OSD and in
`tele.flare`. It is the energy the head is holding above the speed at which it
can no longer make one g, against the energy it takes to stop the descent plus
the height (`hFlare`) the cushion is flown over. Under 100% the landing is an
arrival. `tele.Eair` is the airspeed you can still trade into it, which is why a
glide is flown at a speed and not at an attitude.

## Lifting bodies on a quad

A quad may carry a **lifting body**: a wing across the middle of the frame,
set at an angle to the plane of the props, so that in forward flight some of
the weight is carried by air rather than by the motors. That is what a
long-range build with a wing on it is for, and it is the same idea as a speed
quad's aero shell.

Turn it on in the builder (Fit → Lifting body) or with `liftBody: true` in a
build sheet. In a definition it is an ordinary `surfaces` entry — the same
shape a plane's wing is — plus a `lift` block the model draws it from. It goes
through the same strip model as every other wing in the sim: the same stall,
the same induced drag, the same ground effect, the same icing.

### The sign of the angle, which is the whole thing

A quad leans **nose-down** to fly forward. That tips the frame's up-vector
forward with it — which is exactly why the thrust pushes you along — and it
means **a wing lying flat in the plane of the props meets the oncoming air on
its top surface.** At a lean of φ, a wing in the prop plane is at an angle of
attack of **−φ**, not +φ. It pushes down, and it costs you range:

| rig angle | carries, at a 19° cruise | cruise | range |
|---|---|---|---|
| no lifting body | — | 54 km/h on 13.9 A | 18.6 km |
| `lbAngle: 0` | **−41%** | 51 km/h on 20.8 A | 11.7 km |
| `lbAngle: 20` | 1% | 52 km/h on 13.6 A | 18.5 km |
| `lbAngle: 30` | 24% | 45 km/h on 9.2 A | **23.6 km** |
| `lbAngle: 40` | 25% | 40 km/h on 8.5 A | 22.4 km |
| `lbAngle: 90` | 7% | 26 km/h on 9.8 A | 12.7 km |

(A 7-inch, 1.2 kg quad on 6S2P Li-ion with a 345 mm lifting body;
`node test/liftbody_test.js` prints this table and checks it.)

So **`lbAngle` is measured leading edge up from the plane of the props, and it
has to be bigger than the lean you cruise at.** The wing flies at
`lbAngle − φ`. Thirty degrees suits a twenty-degree cruise; the default is 30.
Zero is a flat plate, which is what a speed quad's shell is — and a speed quad
is not using it to carry weight.

### Why it keeps working at angles a wing would not

A plate between the arms has an aspect ratio near 2, which gives it a
lift-curve slope about half a wing's and a stall that arrives late and
gently (`M: 22` in the generated foil, against 30 for foam and 40 for balsa).
That is why a lifting body is still doing something at 40° of lean, where a
real wing would have given up long before — and it is also why it never makes
very much lift per square inch. A bigger one carries more and cruises slower.

### What it does not change

Nothing in the hover. A wing standing still makes no lift, so the hover
current, the hover time, the punch-out and the thrust-to-weight are all
exactly what they were. `ac.b` also stays the motor span, because that is the
length ground effect and shed ice are scaled by, and the quad is still a quad.

Nor does it get a static margin. A quad's centre of gravity is the body origin
by definition and the flight controller holds the attitude, so there is
nothing for a static margin to mean. The wing's quarter chord is put on the
centre of gravity instead, so it adds lift without adding a pitching moment
the controller then has to trim out — which is what a plate between the arms
actually does.

## Tail-sitters

`kind: "vtol"` is two to eight motors thrusting along the nose and wings in
the cruise frame: it stands on its tail, hovers on the props, pitches over,
and flies horizontally. Two of them ship: `aircraft/speed-tailsitter.json`, a
four-motor cruciform in the class of the Peregreen V4 that holds the Guinness
record at 657.59 km/h, and `aircraft/blown-wing-twin.json`, a one-metre
**twin-motor blown wing** — see [Blown wings](#blown-wings) below, which is
where the interesting part is.

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

**The camera rides the transition too.** `camTilt`, the one number every other
aircraft uses, is no use here: a camera bolted to the nose of something standing
on its tail looks straight up, and the same camera in cruise looks straight
ahead. So a tail-sitter's camera gets a mount, and `fwd` drives it.

The two numbers in the file are the ones a pilot thinks in rather than mount
angles. `trans.camHover` is where the camera looks while hovering, measured up
from the horizon — the default −10° puts the ground, and you, in the bottom of
the picture instead of the sky. `trans.camFwd` is where it looks in cruise,
measured from the direction of flight; −10° again, just under the flight path.
The aircraft holds a known attitude at each end of the transition, so each of
those is one fixed mount angle:

```
want  = camHover + (camFwd − camHover)·fwd        against the horizon
frame = (1 − fwd)·90° + fwd·trans.pitch           the attitude it is holding there
mount = want − frame                              what to ask of a mount on the airframe
```

With the defaults that sweeps the mount about 86° up over `trans.time`, and the
view pans up through the horizon as the nose comes down. Nothing tracks the
horizon part-way through: a strapped-down mount cannot, and a gimbal that did
would take the attitude out of the picture, which is the one thing you need to
see during a transition. Both numbers are per-aircraft settings too, under
Settings → Display, and the camera-tilt buttons move whichever end of the
transition the aircraft is nearer. A radio slider bound to camera tilt takes the
mount off the schedule and flies it by hand over the same arc.

**What is different from a quad**

| | quad | tail-sitter |
|---|---|---|
| thrust | along −z, out of the top | along +x, out of the nose |
| `motors` | `[x, y, spin]` | `[x, y, z, spin]` |
| pitch | from the x offsets | from the **z** offsets |
| yaw | from the prop torque | from the **y** offsets |
| roll | from the y offsets | from the **prop torque**, or from the surfaces — see below |
| thrust at speed | falls to a quarter and stops there | falls to **zero** at the pitch speed, which is what sets the top speed |
| lift | none | the strip model, in the cruise frame |

It needs some wing area to fly on, and it needs *some* way to reach every
axis; the validator checks both. Motors above and below the centreline are one
way to pitch it. Control surfaces in the propwash are the other.

**Giving it lift.** A speed machine's lift comes from its fuselage and its arm
fairings, so the aircraft file says so directly: the body is one surface with a
low aspect ratio, a slow lift curve and a late stall, and the four arms are two
mirrored pairs at ±45° of dihedral — a cruciform wing. A surface with
`"hidden": true` is not drawn by the 3-D model, which is how the fuselage can
be a lifting body to the physics and a fuselage to your eyes.

### Blown wings

A **twin-motor** tail-sitter has no motors above or below the centreline at
all, so the table above runs out: there is nothing to pitch it with. What it
has instead is two propellers blowing over a wing, and elevons sitting in that
slipstream. That is a blown wing, and it is the only reason it can hold an
attitude with the nose straight up and no airspeed.

Two fields make it work.

**`surf`** says which axes belong to the control surfaces, as the angular
acceleration (rad/s²) at which an axis asks for full deflection. An axis named
there is flown by the surfaces and the motor mixer leaves it alone rather than
fighting them for it:

```json
"surf": { "roll": 18, "pitch": 16, "yaw": 0 }
```

so pitch and roll are on the elevons and yaw stays on differential thrust,
which is what two motors either side of the centreline are good for.

**`washEta`** is how much of the slipstream reaches the surfaces behind the
propellers — 0 to 1, and 0.5 if the file does not say. A strip whose centre is
inside 0.6 prop diameters of a motor and behind it is marked at build time and
sees the momentum-theory slipstream added to its own airspeed:

```
dWash = washEta · (√(Vx² + 2(T/n)/(ρA)) − Vx)
```

On the twin that ships, six of the fourteen strips are blown, and in the hover
they are flying in about 15 m/s of the aircraft's own making.

**It is worth measuring rather than asserting**, so `vtol_test` does. Settle
the twin to a genuine standstill — 11 mm/s — ask for full pitch stick, and it
answers at 420°/s inside a quarter of a second. Set `washEta` to zero and it
cannot hold the hover at all: it is tumbling away at 20 m/s before the stick
even moves.

**Two things to know if you write one.**

*Use a symmetrical section.* A cambered or reflexed wing makes lift in its own
propwash with the nose straight up, and in a hover that lift is **horizontal** —
the aircraft walks away from you, forever, and the attitude controller has no
reason to stop it because nothing about the attitude is wrong. The twin that
ships drifted a quarter of a metre a second with a reflexed plank section in
it. Symmetrical, it holds station to 20 cm.

*Balance the propellers.* With roll on the surfaces the mixer stops using
propeller torque for it, so the reaction torque of the props becomes a
disturbance the elevons have to fight rather than a control input. Counter-
rotating pairs cancel it in the steady state, which is what the `spin` column
of `motors` is for.

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
    { "file": "nano-goblin-ardupilot.json", "name": "Nano Goblin · ArduPilot",
      "kind": "wing", "blurb": "580 mm plank, 2S Li-ion, lidar and a GPS mast." }
  ]
}
```

`file` is the only field that has to be there; the rest is what the list
shows before you load anything. Files load by URL too, so anything on
`raw.githubusercontent.com` works — that host sends the header a browser needs
to read it from another site. This only works on the web version: opened as a
local file there is no folder to read.

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
