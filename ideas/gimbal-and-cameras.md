# Gimbal and day / night / thermal cameras

**Status: pinned.** Needs the controller channels (done) and, for ROI pointing, the autopilot core.

## Gimbal

- Two-axis (tilt, pan) or three-axis gimbal on the quads and the camera plane.
- Driven from the HOTAS: map an axis or the hat to tilt and pan, in rate or angle mode, with a
  recentre button. Same profile system as the sticks, so the Zorro gets its own mapping.
- Stabilised (holds the horizon) or follow mode (follows the airframe in yaw), like a real
  BGC/STorM32/Gremsy setup. Slew-rate and travel limits, e.g. your tilt mount's 90° down / 30° up.
- FPV view switch: pilot camera (fixed) vs gimbal camera.

## Camera switcher

Matches the three-camera pod you're building (Caddx Infra V2 night, RunCam Phoenix 2 day,
FPV thermal).

- **Day**: what the sim renders now.
- **Night / low light**: a dark scene (moon-dependent), sensor noise and gain, IR illuminator
  cone that lights only nearby things, blooming on bright lights.
- **Thermal**:
  - false colour (white-hot / black-hot / ironbow)
  - every object gets a temperature: people, animals, warm motors and batteries, vehicles,
    sun-heated rock, cold water, sky
  - thermal crossover at dawn and dusk, when targets and background match
  - low resolution and a narrow field of view, like a real FPV thermal core

## SAR practice

Hidden search targets (a lost hiker, a pack, a campfire) placed around the map. A timer and a
"found it" button with the GPS position you report, so you can practise search patterns and
target confirmation in each camera mode.

## Size

Medium. The renderer already supports colour mixing per object, which is most of what thermal
needs.
