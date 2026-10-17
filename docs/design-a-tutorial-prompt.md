# Writing a training course in a chat

A ready-to-paste prompt for an ordinary Claude chat (claude.ai, no repository
access needed). Tell it what you want to learn and it writes a Flightline
tutorial file you can load with Settings → Training → *Load a tutorial file*.

**How to use it**

1. In the sim, open Settings → Training and press **Copy the prompt** — it is
   the same text as the box below, so you never have to find this page. (If
   the browser will not reach the clipboard, the sim puts the text on screen
   to copy by hand.)
2. Paste it into a new chat and say what you want to learn, on what aircraft.
3. Save what comes back as `something.json` and load it under Training.
4. The lesson list, the medals and the best scores all work exactly as they do
   for the courses that ship with the sim.

The format is in [`docs/tutorial-format.md`](tutorial-format.md), and the same
reader checks a chat-written file as checks the built-in courses: every number
range-checked and clamped, every change listed, anything unrecognised dropped.
Nothing in a tutorial file is ever executed.

---

````text
You are helping me write a training course for Flightline RC Sim, a browser
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
6. Write the `tip` for every flying task. The instruction says what to do; the
   tip is the part worth reading - what the mistake is, what it feels like,
   and what to do instead. That is the whole value of a lesson over a
   waypoint list.
7. Numbers only. No formulas, no expressions, no comments inside the JSON.
8. Reply with: a short list of what you assumed, then exactly one JSON code
   block and nothing after it.

What I want to learn:

<tell it here: the aircraft, the skill, how experienced you are, and anything
you already know you are bad at>

````

---

## What makes a good one

The sim can only check that a lesson is *possible*. Whether it is worth flying
is down to the writing, and three things separate a course from a waypoint
list:

- **Order.** Each lesson should need only what the ones before it taught. The
  built-in quad ladder spends its first three lessons on throttle and yaw
  alone, because everything after them is built on holding a spot.
- **The tip.** The instruction says what to do. The tip says what goes wrong,
  what it feels like, and what to do instead — that is the part a beginner
  cannot get from a marker in the sky.
- **A par you can beat.** Par is not a deadline, it is a second lap. Set it at
  about twice what the flying actually takes and a first attempt earns a
  medal, which is what makes a pilot fly it again for a better one.

## Asking for a course for a map

Lesson geometry is metres from where the pilot stands and metres above the
ground under him, so a course written for the home field works anywhere. If
you want one for a particular map, say so and give the chat the map's
`map.json` — the pads and the terrain in it are what a course should be laid
out around.
