# The Flightline tutorial format, version 1

A tutorial file is one JSON object holding a **course**: a ladder of
**lessons**, each a list of **tasks** you fly in order. The sim ships with
three of them — a quad ladder, a helicopter ladder and a plane ladder — and
they are written in exactly this format, through exactly this reader, so
nothing a built-in course does is something a file cannot do.

Load one with Settings → Training → *Load a tutorial file*. It is kept in the
browser and appears in the lesson list beside the built-in courses, with the
same medals and best scores.

**Nothing in a tutorial file is ever executed.** It is read with `JSON.parse`
and then copied field by field against the tables below: every number is
range-checked and clamped, every string is trimmed and length-capped, and only
field names that appear in a table are copied at all — so a `__proto__` key is
simply not a name we look for. Everything that gets changed on the way in is
listed on screen. The worst a bad file can do is fail to load.

The engine is `src/tutorial.js`; `test/tutorial_test.js` reads the format and
then flies every lesson of every built-in course with an autopilot, which is
how a lesson that cannot be completed gets caught.

---

## Coordinates

Everything is **metres relative to where the pilot stands**, in the same axes
the flight controller uses:

| | |
|---|---|
| `n` | metres north of the pilot |
| `e` | metres east of the pilot |
| `up` | metres above the ground **under the pilot** |

and every angle is a **compass heading in degrees**: 0 is north, 90 is east.

Because the datum is the pilot and not the map, a course written for the home
field works unchanged on a terrain map — the sim subtracts the map's pilot
position before it scores anything. The one thing to know is that `up` is
measured from the ground under the *pilot*, not from the ground under the
aircraft, which is the same thing the altitude tape reads. On flat ground
they are identical; across a mountain a lesson written at "50 m" is 50 m above
the pilot's feet, not 50 m above whatever is below the aircraft.

On the home field: the flight-line fence is 4 m out (`n = 4`), the runway runs
east and west 12 m out (`n = 12`, `e` from −60 to 60), the quad and helicopter
pad is 8 m out, and the field is clear of trees from 35 m to 200 m out and
115 m either side. **Lay a course out to the north.** Nothing should ask a
pilot to fly behind the flight line.

---

## The file

```json
{
  "format": "flightline-tutorial/1",
  "id": "my-drills",
  "name": "My drills",
  "blurb": "What this teaches, in a sentence or two.",
  "author": "Your name",
  "source": "Where the drills came from",
  "kinds": ["quad"],
  "lessons": [ ... ]
}
```

| field | rule |
|---|---|
| `format` | **required**, `"flightline-tutorial/1"`. A higher version number is refused rather than guessed at. |
| `id` | up to 32 characters. Must not collide with a course that ships with the sim. |
| `name` | up to 60 characters. What appears in the lesson list. |
| `blurb` | up to 400 characters. |
| `author`, `source` | up to 60 and 200 characters. |
| `kinds` | which aircraft the course is for: any of `quad`, `heli`, `wing`, `conventional`, `vtol`. Left out, it is offered for all of them. A lesson is only flyable when the aircraft you have loaded is one of these. |
| `lessons` | 1 to 30, in the order they should be flown. |

## A lesson

```json
{
  "id": "hover",
  "name": "1 · Throttle, and nothing else",
  "blurb": "What the drill is and why it matters.",
  "start": "pad",
  "boxR": 60,
  "maxAlt": 25,
  "par": 70,
  "tasks": [ ... ]
}
```

| field | range | default | what it does |
|---|---|---|---|
| `id` | ≤ 32 chars | from the name | Best scores are remembered under it. Two lessons cannot share one; the second gets a `-2`. |
| `name` | ≤ 60 chars | `Lesson` | |
| `blurb` | ≤ 400 chars | — | |
| `start` | `pad` `runway` `launch` `air` `any` | `any` | Where a reset puts the aircraft when the lesson begins. Ignored if that aircraft cannot start that way. |
| `boxR` | 0 … 4000 m | `0` | A fence around the pilot. Outside it costs 3 points a second and the sim says so. `0` = none. |
| `maxAlt` | 0 … 2000 m | `0` | A ceiling, charged the same way. `0` = none. |
| `par` | 5 … 3600 s | the tasks added up | The time the 200 time points are measured against. |
| `tasks` | 1 to 40 | **required** | Flown in order. |

The clock starts when the aircraft does — armed and off the ground — not when
you press *Fly*, so reading the first instruction costs nothing.

## A task

Four kinds. Fields that do not belong to a kind are ignored.

### `zone` — a place to get to, and maybe stay in

The workhorse. A cylinder you have to be inside: `r` metres across and `band`
metres of height either side of `up`.

| field | range | default | |
|---|---|---|---|
| `say` | ≤ 120 chars | — | The instruction, one short line. |
| `tip` | ≤ 400 chars | — | The coaching: what goes wrong and what to do instead. |
| `n`, `e` | ±4000 m | `0` | |
| `up` | 0 … 2000 m | `2` | |
| `r` | 0.5 … 500 m | `3` | |
| `band` | 0.3 … 500 m | `2` | |
| `hold` | 0 … 300 s | `0` | Unbroken seconds inside it. Leaving the zone restarts the count — a 20-second hover means twenty seconds. `0` = just reach it. |
| `spin` | 0 … 3600 ° | `0` | Degrees of yaw to turn while inside it, either way round. A pirouette drill. |
| `facing` | see below | `any` | Where the nose has to point. |
| `facingTol` | 5 … 180 ° | `30` | How far off that still counts. |
| `speedMax` | 0 … 300 m/s | `0` | Ground speed you must be under to count as being there. This is what makes a "stop in the circle" drill a stop rather than a fly-past. |
| `par` | 1 … 600 s | `20` | |

`facing` is one of:

| | |
|---|---|
| `any` | don't care |
| `home` | at the pilot — nose-in, the hard one |
| `away` | straight out from the pilot — tail-in |
| `course` | along the way you are moving, which is a turn flown on the rudder. Below 1.5 m/s anything counts, because standing still has no course. |
| a number | a compass heading in degrees |

A zone with `hold: 0` finishes at the point of **closest approach**, not the
moment you clip its edge: it completes either when you are well inside it or
when you have been inside and have started to leave again. That is what makes
flying through the middle of a marker worth more than scraping it.

### `gate` — a rectangle standing in the air

| field | range | default | |
|---|---|---|---|
| `n`, `e`, `up` | | | the centre of the opening |
| `width` | 0.6 … 60 m | `3` | |
| `height` | 0.6 … 60 m | `2.5` | |
| `yawDeg` | ±360 ° | `0` | the heading you fly through it on |
| `par` | | `20` | |

You have to cross the plane of the gate inside the frame. Crossing it outside
the frame says so and does not count. **Gates in a lesson are not solid** —
clipping one costs precision, not a crash.

### `land` — put it down inside a circle, gently

| field | range | default | |
|---|---|---|---|
| `n`, `e` | | | the middle of the pad |
| `r` | 0.5 … 500 m | `3` | |
| `rate` | 0.2 … 20 m/s | `1.5` | the sink rate that still scores a clean landing |
| `par` | | `20` | |

It counts when the aircraft is on the ground inside the circle with the
throttle down and within 25° of level. The sink rate used is the one from just
*before* contact, peak-held for a moment, so a bounce is scored on the arrival
rather than on the settling.

### `say` — a line of coaching, no flying

`say`, `tip` and `hold` (seconds before it clears; `0` clears at once).

---

## Scoring

Out of **1,000**, the same three numbers for every lesson so two scores can be
compared:

| | | |
|---|---|---|
| **500** | finishing | Half marks pro rata for the tasks you did get through if you quit. |
| **200** | the clock | Full marks at or inside par, nothing left at twice par, straight line between. |
| **300** | precision | `300 × (1 − mean error)`, where a task's error is 0 at the dead centre of its shape and 1 at the edge. A held zone averages the error over the hold; a fly-through takes the closest approach; a gate takes the offset where you crossed it; a landing takes the worse of how far off the pad and how hard you arrived. |

Off the top: **120 a crash**, and **3 a second** outside the fence or above
the ceiling. A crash also puts the current task back to its beginning — you
are on the pad again anyway — but the lesson clock keeps running.

Medals: **gold** at 850, **silver** at 650, **bronze** at 420. Only your best
score on each lesson is kept.

---

## A whole small course

```json
{
  "format": "flightline-tutorial/1",
  "id": "two-drills",
  "name": "Two drills",
  "blurb": "A hover and a spot landing.",
  "kinds": ["quad"],
  "lessons": [
    {
      "id": "hover",
      "name": "1 · Hold a hover",
      "blurb": "Twenty unbroken seconds at eye level.",
      "start": "pad",
      "boxR": 60,
      "maxAlt": 25,
      "tasks": [
        { "kind": "say", "say": "Arm with the throttle down, then ease it up",
          "tip": "Throttle is altitude. There is no stick that holds a height.", "hold": 2 },
        { "kind": "zone", "say": "Hold it at eye level",
          "tip": "Small corrections, early. Waiting until it has moved is how beginners end up chasing it.",
          "n": 8, "e": 0, "up": 1.7, "r": 3, "band": 1.2, "hold": 20, "par": 35 },
        { "kind": "land", "say": "Land it on the pad", "n": 8, "e": 0, "r": 2.5, "rate": 1.5, "par": 25 }
      ]
    },
    {
      "id": "spot",
      "name": "2 · Spot landing",
      "blurb": "From height and distance onto a small pad.",
      "start": "air",
      "boxR": 160,
      "tasks": [
        { "kind": "zone", "say": "Line up on the approach", "n": 53, "e": 0, "up": 15, "r": 10, "band": 6, "par": 20 },
        { "kind": "zone", "say": "Over the pad at 5 m", "n": 8, "e": 0, "up": 5, "r": 4, "band": 2,
          "hold": 4, "speedMax": 3, "par": 25 },
        { "kind": "land", "say": "Put it down on the pad", "n": 8, "e": 0, "r": 1.6, "rate": 1.0, "par": 30 }
      ]
    }
  ]
}
```

## Writing one in a chat

[`docs/design-a-tutorial-prompt.md`](design-a-tutorial-prompt.md) is a prompt
that turns "teach me to fly nose-in on a 700-size heli" into one of these.
The sim carries the same text: Settings → Training → *Copy the prompt*.
