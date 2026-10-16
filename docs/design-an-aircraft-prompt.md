# Turning a build list into an aircraft file

A ready-to-paste prompt for an ordinary Claude chat (claude.ai, no repository
access needed). Give it what you know about an aircraft — frame, motor KV,
prop, cells, all-up weight — and it writes a Flightline aircraft file you can
load with Settings → Aircraft → *Import aircraft file*.

**How to use it**

1. Copy everything in the box below into a new chat.
2. Replace the build list at the bottom with yours. Anything you leave out, it
   should ask about rather than invent.
3. Save what comes back as `something.json` and import it.
4. Open Settings → Builder to see the bench numbers and change anything that
   looks wrong. The aircraft keeps its build sheet, so the builder opens it
   where the chat left off.

It writes the short **build sheet** form, not the full definition: about
fifteen numbers you can check by eye instead of two hundred and fifty you
cannot. The sim expands it with the formulas in
[`docs/aircraft-format.md`](aircraft-format.md).

---

````text
You are helping me describe a radio-control aircraft for Flightline RC Sim, a
browser flight simulator. I will give you a build list. You will give me back
one JSON file in the sim's aircraft format, version 1.

The format reference is here — read it before you answer:
https://raw.githubusercontent.com/RealPapaNerf/flightline-sim/main/docs/aircraft-format.md

Write the short "build sheet" (`spec`) form, not the full `def`. Shape:

{
  "format": "flightline-aircraft/1",
  "author": "<my name if I gave you one, else leave it out>",
  "version": "1",
  "source": "<one line: where these numbers came from>",
  "spec": {
    "kind": "plane" | "wing" | "quad",
    "id": "<short-lowercase-id>",
    "name": "<what it should be called in the sim>",
    "blurb": "<one or two sentences>",
    ...the numbers below...
  }
}

Fields, with their units. Leave out anything I did not tell you and cannot
work out — every one of them has a default worked out from the others, and a
sensible default beats a number you made up.

  Every aircraft:  mass (g, all-up, with the battery)
                   propD (in), propPitch (in), blades (2-4)
                   motorKV (rpm/V)
                   cellChem ("lipo" | "liion"), cellsS, cellsP,
                   cellmAh (per parallel string), cellR (mOhm per cell)
                   watts (electrical, at full throttle)
                   pitchSpeed (m/s, the full-throttle top speed if you know it)

  Planes and wings (kind "plane" or "wing"):
                   span, rootChord, tipChord (mm)
                   sweep, dihedral, washout (degrees)
                   wingZ (mm the wing sits above the CG)
                   airfoil ("flat" | "semi" | "symmetric" | "reflex")
                   build ("foam" | "builtup" | "composite")
                   staticMargin (%, 8-12 is normal, 5-7 for a plank)
                   tailArm, stabSpan, stabChord, finHeight, finChord (mm)
                   fuseW, fuseH, noseLen (mm)
                   camX, camZ (mm) — where the FPV camera sits, from the wing
                   leading edge and above the body centre. Leave them out and
                   they follow the nose.
                   gear ("none" | "tricycle" | "taildragger" | "retract")
                   ailSpan, flapSpan (% of the half span)
                   ailChord, flapChord, elevChord, rudChord (% of chord)
                   throwA, throwE, throwR, throwF (degrees)
                   thrustStatic (g, only if I measured it on a stand)

  Quads (kind "quad"):
                   wheelbase (mm, motor to motor diagonally)
                   thrustPerMotor (g, at full throttle on my cell count,
                     from the motor maker's thrust table)
                   rateMax (deg/s)
    all:           camTilt (degrees down from level)
                   quadGear, gimbal, packTop (true/false)

Rules:

1. Ask me about anything important that is missing or that does not add up,
   before you write the file. Thrust per motor for a quad and all-up weight
   for anything are the two that matter most.
2. Do not invent a number you could leave out. A left-out field gets a default
   worked out from the rest of the aircraft, which is almost always better
   than a guess.
3. Numbers only. No formulas, no expressions, no comments inside the JSON.
4. Reply with: a short list of what you assumed or changed, then exactly one
   JSON code block and nothing after it.
5. Before you answer, check your own numbers and tell me if any of these look
   wrong:
   - a plane's wing loading (mass in g / wing area in dm^2): 20-40 is a
     trainer or a park flyer, 40-70 is a big camera plane, over 90 wants a
     runway and a lot of speed
   - a plane's static thrust against its weight: 0.4-0.7 for a cruiser,
     0.8-1.2 for something aerobatic
   - a quad's thrust to weight: 4-6 is a long-range or lifting build, 8-12 is
     a freestyle quad
   - power: a plane is usually 150-350 W per kg; a quad is 1,500-4,000 W per
     kg, and the file wants the *electrical* watts at full throttle
   - cell resistance: a good LiPo is 5-10 mOhm per cell; an 18650 is 20-30,
     a 21700 nearer 12-15
   - whether the pack can actually feed full throttle: cells x capacity x the
     C rating, against watts / pack volts. If it cannot, say so — the sim
     models the sag and it will be obvious in the air.
6. If I gave you something the format cannot express — a VTOL, a twin, a
   slotted flap, a helicopter — say so plainly, give me the nearest thing it
   can do, and tell me what will be different.

My build:

<paste your build list here: frame, motor and KV, prop, cells and pack,
all-up weight, anything else you know>
````

---

## A worked example

**What goes in**

> 7-inch long-range quad. 305 mm wheelbase, 2806.5 1300KV motors on HQ 7×3.5
> two-blade props, 6S2P of Molicel P30B 18650s, 1,050 g all up with the pack.
> The motor chart says 1,733 g per motor at 25 V.

**What comes back**

```json
{
  "format": "flightline-aircraft/1",
  "version": "1",
  "source": "motor chart at 6S, pack from the cell datasheet",
  "spec": {
    "kind": "quad",
    "id": "lr7",
    "name": "7\" long range",
    "blurb": "7-inch long-range quad on 6S2P 18650 Li-ion, 1,050 g.",
    "mass": 1050,
    "propD": 7,
    "propPitch": 3.5,
    "blades": 2,
    "wheelbase": 305,
    "thrustPerMotor": 1733,
    "motorKV": 1300,
    "cellChem": "liion",
    "cellsS": 6,
    "cellsP": 2,
    "cellmAh": 3000,
    "cellR": 23
  }
}
```

That is what the sim's own 7-inch quad was built from, and the two agree
closely enough to be the same aircraft — `node test/aircraft_test.js` prints
them side by side:

| | from the build sheet | built by hand |
|---|---|---|
| thrust / weight | 6.6 : 1 | 6.6 : 1 |
| hover throttle | 32% | 32% |
| hover current | 6.8 A | 7.2 A |
| hover flight time | 42 min | 40 min |
| punch-out current | 86 A | 89 A |
| punch-out sag | 3.17 V/cell | 3.17 V/cell |
| cruise | 52 km/h | 53 km/h |
| cruise range | 20.7 km | 19.8 km |

## If the chat has no web access

Paste [`docs/aircraft-format.md`](aircraft-format.md) in alongside the prompt,
or just use the field list in the prompt itself — it is enough to write a
valid build sheet. The sim tells you about anything it had to clamp or ignore
when you import the file.
