# More aircraft

**Status: pinned.**

## Camera-platform plane

A large, stable fixed wing for mapping and SAR: ~2 m span, high wing, tricycle or tail-dragger
gear, flaps, a belly gimbal with the three-camera pod. Think Ranger 1980 / Skywalker 1900 class.

- **Flaps**: a new control axis (or a 3-position switch: up / takeoff / landing). Flap theory
  already exists in the strip model, so this is mostly a new channel and new strips.
- **Gear**: steerable nose wheel exists; optional retracts with drag.
- **Gimbal**: see [gimbal-and-cameras](gimbal-and-cameras.md).
- Autonomy and takeover come with the [Mission Planner mode](mission-planner-mode.md).

## Match your real aircraft

Enter your build's numbers (weight, motor KV, prop, pack, cells) and the sim fits the model:
- your Goblin's actual weight and battery
- your 7" ArduPilot quad
- your 13" recovery platform
- the 10" GEPRC Mark4 with the tilt mount
- your helicopter, once it flies

Your thrust-stand data could set the motor and prop curves directly (see
[validate-with-your-data](validate-with-your-data.md)).

## Others mentioned or worth having

- 10" quad (your Mark4)
- your forward-flying lifting-body quad
- a VTOL (quadplane), the classic SAR long-range platform; needs transition logic
