/* =====================================================================
   The two chat prompts the sim can hand you, kept here rather than in the
   page so there is one copy of each: Settings copies them to the clipboard,
   docs/design-an-aircraft-prompt.md and docs/design-a-tutorial-prompt.md
   print them, and test/prompt_test.js checks the three agree.

   Both work the same way. You paste the prompt into an ordinary chat, tell
   it what you have or what you want to learn, and it writes you a JSON file
   the sim can read. Neither prompt asks the chat to write code and neither
   file can contain any: every field is copied against a table of rules on
   the way in.
   ===================================================================== */
const PROMPTS = (function () {
  'use strict';
  const aircraft = `You are helping me describe a radio-control aircraft for Flightline RC Sim, a
browser flight simulator. I will give you a build list. You will give me back
one JSON file in the sim's aircraft format, version 1.

The format reference is here — read it before you answer:
https://raw.githubusercontent.com/RealPapaNerf/flightline-sim/main/docs/aircraft-format.md

Write the short "build sheet" (\`spec\`) form, not the full \`def\`. Shape:

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
                   liftBody (true/false) - a wing across the middle of the
                     frame, for a long-range or speed build. With it:
                     lbSpan, lbChord, lbTipChord (mm), lbSweep (degrees),
                     lbAngle (degrees the leading edge is rigged UP out of
                     the plane of the props - it must be MORE than the lean
                     you cruise at, because a quad leans nose-down to fly
                     forward and a wing flat in the prop plane then pushes
                     down; 30 suits a 20-degree cruise),
                     lbAirfoil (flat/semi/symmetric/reflex; a plate between
                     the arms is symmetric)
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
all-up weight, anything else you know>`;

  const tutorial = `You are helping me write a training course for Flightline RC Sim, a browser
flight simulator. I will tell you what I want to learn. You will give me back
one JSON file in the sim's tutorial format, version 1, which I load with
Settings -> Training -> Load a tutorial file.

The format reference is here - read it before you answer:
https://raw.githubusercontent.com/RealPapaNerf/flightline-sim/main/docs/tutorial-format.md

Shape:

{
  "format": "flightline-tutorial/1",
  "id": "<short-lowercase-id>",
  "name": "<what the course is called>",
  "blurb": "<one or two sentences: what it teaches and in what order>",
  "author": "<my name if I gave you one, else leave it out>",
  "source": "<one line: where the drills came from>",
  "kinds": ["quad"],            // any of quad, heli, wing, conventional, vtol
  "lessons": [ ...in order, easiest first... ]
}

A lesson:

{
  "id": "<short-lowercase-id, unique in the course>",
  "name": "1 - What this lesson is",
  "blurb": "<two or three sentences: what the drill is and why it matters>",
  "start": "pad" | "runway" | "launch" | "air" | "any",
  "boxR":  <metres: how far from the pilot you may go, 0 = no fence>,
  "maxAlt":<metres: how high you may go, 0 = no ceiling>,
  "par":   <seconds: leave it out and it adds up the tasks>,
  "tasks": [ ...flown in order... ]
}

A task is one of four kinds. Everything is in metres from where the pilot
stands - **n** is north of him, **e** is east of him, **up** is above the
ground under him - and every angle is a compass heading, 0 = north, 90 = east.

  { "kind": "zone",            a place to get to, and maybe stay in
    "say":  "<the instruction, a short line>",
    "tip":  "<the coaching: what to do, what goes wrong, why>",
    "n": 8, "e": 0, "up": 2,
    "r": 3,                    how wide the zone is, metres
    "band": 1,                 how much height slack, metres
    "hold": 20,                seconds to stay inside (0 = just reach it)
    "spin": 360,               degrees to turn while inside (0 = none)
    "facing": "any" | "home" | "away" | "course" | <heading>,
    "facingTol": 40,           how many degrees off that is still allowed
    "speedMax": 4,             m/s you must be under (0 = no limit)
    "par": 30 }

  { "kind": "gate",            a rectangle standing in the air
    "n": 40, "e": 0, "up": 2.5,
    "width": 5, "height": 3.5,
    "yawDeg": 90,              the way you fly through it
    "par": 11 }

  { "kind": "land",            put it down inside a circle, gently
    "n": 8, "e": 0, "r": 2.5,
    "rate": 1.5,               m/s of sink that still counts as a good landing
    "par": 25 }

  { "kind": "say",             no flying: a line of coaching between two tasks
    "say": "<what to do next>", "tip": "<why>", "hold": 3 }

  "cut": true                  on any flying task, on a rotorcraft: the rotor
                               drive fails for the length of that task and the
                               sim holds it off, whether the pilot was ready or
                               not. The collective stays live on a helicopter;
                               an autogyro loses its engine instead. Use it for
                               engine-out drills, and give the task room — a
                               450 glides about 1.4 m along for every metre
                               down, a tip-driven rotor or a gyrodyne two to
                               three times that.

Scoring, so you can judge a par: 1,000 points - 500 for finishing, 200 for
coming in under par, 300 for precision (how near the middle of every marker
you flew, averaged). A crash costs 120. Gold is 850, silver 650, bronze 420.

Rules:

1. Ask me what I want to learn and what I fly before you write anything, if I
   have not said. A course for a 5-inch freestyle quad is not a course for a
   700-size helicopter.
2. Order the lessons so each one needs only what the ones before it taught. A
   ladder with a rung missing is worse than no ladder.
3. Every lesson must be **possible**. Work out roughly how long the flying
   takes and set par to about twice that, so a first attempt earns a medal and
   a second attempt earns a better one. A par nobody can make is not a
   challenge, it is a wall.
4. Fly it in your head before you write it. Can the aircraft get from the end
   of one task to the start of the next? Is the zone wide enough to hold a
   hover in? Is a 40-metre circle flyable at the speed that aircraft goes?
5. Keep it in front of the pilot. The home field is clear of trees from 35 m
   to 200 m out and 115 m either side, the flight line is 4 m in front of him,
   and the runway runs east and west 12 m beyond that. Positive n is out over
   the field. Do not put a task behind the pilot.
6. Write the \`tip\` for every flying task. The instruction says what to do; the
   tip is the part worth reading - what the mistake is, what it feels like,
   and what to do instead. That is the whole value of a lesson over a
   waypoint list.
7. Numbers only. No formulas, no expressions, no comments inside the JSON.
8. Reply with: a short list of what you assumed, then exactly one JSON code
   block and nothing after it.

What I want to learn:

<tell it here: the aircraft, the skill, how experienced you are, and anything
you already know you are bad at>
`;

  return { aircraft, tutorial };
})();
if (typeof module !== 'undefined') module.exports = PROMPTS;
