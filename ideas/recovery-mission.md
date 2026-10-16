# Quad recovery mission for the 13"

**Status: pinned.** Builds on the foundation (loiter, alt hold) and the gimbal (looking down).

## The idea

A SAR-style mission: a 5" quad has gone down somewhere. Find it with the 13", hover over it,
lower a hook on a winch line, snag the frame, reel it up, and carry it home without swinging it
into a tree.

## How it could work

- **Winch and line:**
  - a spool on the 13" pays out and reels in a line (0–15 m, ~0.5 m/s), from a radio channel
    or keys
  - the line is a chain of 6–10 point masses joined by stiff springs with damping, so it swings,
    slackens and wraps the way a real tether does
  - the 13" feels the line's pull at the attachment point, so a swinging load rocks it
- **Hook and catch:** the hook catches when it passes through the downed quad's frame at low
  relative speed. Too fast and it bounces off; snags on tree branches are possible.
- **Payload:** the recovered quad hangs on the line with its own drag (a pendulum under the
  lifter). Carrying it means flying smoothly, damping the swing, and watching the 13"'s battery
  sag with the extra weight.
- **Scenarios:**
  - quad in open grass
  - in tall brush
  - next to the treeline
  - on the barn roof
  - in wind
  - in freezing fog, where the 13"'s props ice while you hover
- **Camera:** the gimbal pointed straight down, with a crosshair over the hook.
- **Scoring:** time to recover, peak swing angle, battery used, whether it came home.

## Size

Medium: line physics, hook logic, scenario setup, a downward camera.
