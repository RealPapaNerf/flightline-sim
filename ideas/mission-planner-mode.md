# Mission Planner-style mode

**Status: pinned.** Needs the foundation (sensors, autopilot core).

## The idea

Plan and fly missions the way you would with Mission Planner, but inside the sim, so you can
rehearse a SAR mission end to end: plan, upload, arm, AUTO, watch, intervene, RTL.

## How it could work

- **Planner screen** (the FPV half of the split, or a full-screen tab):
  - a top-down map of the field
  - click to drop waypoints, drag to move them
  - altitude per waypoint, relative to home or terrain once terrain maps exist
  - mission items that matter for SAR: TAKEOFF, WAYPOINT, LOITER_TURNS / LOITER_TIME,
    DO_CHANGE_SPEED, DO_SET_ROI (point the gimbal), camera trigger, RTL, LAND
  - a **survey / grid** generator with lane spacing from camera footprint and overlap (the real
    SAR tool)
- **Flight data view**, laid out like Mission Planner's:
  - HUD, map with the vehicle and its track, quick-status tiles (alt, speed, distance to WP,
    battery, LQ)
  - an Actions panel: Arm, AUTO, LOITER, RTL, set WP, change speed / alt
- **AUTO mode**: L1 / NAVL1-style guidance for planes, position controller for multirotors.
  - current waypoint and distance shown
  - mission state saved, so a link loss mid-mission resumes or RTLs per setting
- **Takeover**: any stick movement or mode switch hands control back (acro, stabilised, angle).
  Matches ArduPilot's behaviour of mode changes from the radio.
- **Controller**: map a switch to AUTO / LOITER / RTL like your real radio.

## Tie-ins

- **Ardu-waddle** (your Mission Planner / Betaflight hybrid) could be the planner UI, or share
  its mission format, so missions planned there fly here.
- With the [ArduPilot bridge](ardupilot-bridge.md), the *real* Mission Planner or QGroundControl
  could drive the sim instead, using your real firmware and parameters.
- Mission files: read and write the Mission Planner `.waypoints` text format so missions move
  between the sim and the field.

## Size

Large: planner UI, guidance for each aircraft kind, mission state. Build after the autopilot core.
