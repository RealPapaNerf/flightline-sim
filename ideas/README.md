# Ideas

Things we've talked about building into Flightline, with what each one depends on. Nothing in
this folder is built yet unless it says **status: building** or **status: done**. One file per
idea; each says what it is, why it matters for real flying, how it could work, open questions, and
rough size.

## Build order

The order matters more than the list. Most of the big features sit on three foundation pieces
that are useful on their own, so those come first.

```
foundation.md  ──┬── sensors (GPS, baro, downward lidar)
 (done, v1)      ├── link model (RC link quality, analog video, interference)
                 └── autopilot core (alt hold, RTL, RC-loss failsafe)
                          │
        ┌─────────────────┼──────────────────────┬─────────────────────┐
        ▼                 ▼                      ▼                     ▼
 mission-planner-mode   link-and-failsafe   gimbal-and-cameras     ardupilot-bridge
 (waypoints, AUTO,      (advanced: terrain  (gimbal on the HOTAS,  (real ArduPilot
  takeover)              shadow, multipath,  day / night / thermal) firmware & params
                         digital vs analog)                          via SITL)
        │                                        │
        └──────────────► aircraft.md ◄───────────┘
                         (camera-platform plane with flaps, gear, gimbal; match-my-aircraft)

 terrain-maps.md + map-builder.md (done; terrain-shaped wind is what is left)
 recovery-mission.md (13" winch-and-hook recovery; after the gimbal)
 multiplayer.md (ghost racing and live racing, done v1)
 failures-and-weather-extras.md (ESC cut-off, GPS glitch, thermals, night …)
 validate-with-your-data.md (check the sim against your thrust-stand and flight logs)
```

| Idea | Status | Size | Depends on |
|---|---|---|---|
| [Foundation: sensors, link, autopilot core](foundation.md) | done (v1) | large | — |
| [Mission Planner-style mode](mission-planner-mode.md) | pinned | large | foundation |
| [Gimbal and day / night / thermal cameras](gimbal-and-cameras.md) | pinned | medium | foundation (sensors) |
| [Link loss and interference, advanced](link-and-failsafe.md) | pinned | medium | foundation (link) |
| [Real ArduPilot in the loop](ardupilot-bridge.md) | pinned | medium–large | foundation helps, not required |
| [More aircraft](aircraft.md) | done (v1) | small–medium each | the camera plane still wants the gimbal |
| [Terrain maps from lidar](terrain-maps.md) | done (v1); wind left | large | — |
| [Failures and weather extras](failures-and-weather-extras.md) | pinned | small each | some need foundation |
| [Check the sim against your own data](validate-with-your-data.md) | pinned | small | — |
| [Map builder and shared maps](map-builder.md) | done (v1) | medium | terrain maps (shares the map file) |
| [13" quad recovery mission (winch and hook)](recovery-mission.md) | pinned | medium | foundation, gimbal |
| [Multiplayer: ghost racing, then live racing](multiplayer.md) | done (v1) | small → large | — |

Already built (for reference): Goblin, trainer, 5" / 4" LR / 7" LR / 13" quads, 450 heli; flight
modes; obstacle course; weather (density altitude, turbulence, precipitation, fog, ceiling, icing,
cold packs); HUD; controller profiles; home arrow and distance on the FPV OSD.
