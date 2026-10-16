# More aircraft

**Status: done (v1).** Aircraft are files now: [`docs/aircraft-format.md`](../docs/aircraft-format.md)
is the format, Settings → Builder makes one from a build sheet with live bench numbers, and
[`aircraft/`](../aircraft) holds the first five. What is left is listed at the bottom.

## Camera-platform plane

**Built**, as [`aircraft/camera-platform-2m.json`](../aircraft/camera-platform-2m.json): 2 m
span, 3 kg, high wing, flaps over 70% of the half span, retractable tricycle gear. Ranger 1980 /
Skywalker 1900 class.

- **Flaps**: done, as a fourth control channel (`C`, or a switch: up / takeoff / landing).
  Flap theory was already in the strip model, but it needed three things to behave: effectiveness
  that tails off past about 12°, a flap raising the section's stall angle, and a part-span flap
  inducing downwash on itself. The numbers are in the format doc. The surprise worth knowing:
  **short flaps cost stall speed**, and only past about 60% of the half span do they pay.
- **Gear**: done. `retract` in the file, `U` in the air, drag while it is down, and the wheels
  only touch the ground when it is.
- **Gimbal**: still to come — see [gimbal-and-cameras](gimbal-and-cameras.md). The 13" quad's
  three-camera pod is drawn but is not a gimbal yet.
- Autonomy and takeover come with the [Mission Planner mode](mission-planner-mode.md).

## Match your real aircraft

**Done.** Enter the numbers you can read off a bench — weight, motor KV, prop, pack, cells — and
the sim builds the model, showing the stall speed, trim table, hover current, punch-out sag and
flight time as you type. There is also a
[prompt](../docs/design-an-aircraft-prompt.md) for turning a build list into a file in a chat.

Built from published specs, each with its assumptions in the file:
- the Goblin with the ArduPilot stack and lidar, at 300 g
- the 7" ArduPilot quad
- the 13" recovery platform
- the 10" GEPRC Mark4 with the tilt mount

Weigh yours and correct them. Thrust-stand data would set the motor and prop curves directly
(see [validate-with-your-data](validate-with-your-data.md)); the format holds two numbers for a
prop today, not a curve.

## Still to do

- **The helicopter in a file.** It imports and exports, but the build sheet has no `heli` kind.
- **A measured thrust curve** instead of static thrust plus pitch speed.
- **Slotted and Fowler flaps.** The flap channel is a plain hinged surface.
- **A quadplane.** The tail-sitter (`kind: "vtol"`) is built — it pitches the whole
  airframe over and flies on its own body. One that keeps its wing level and tilts only
  its motors, or carries separate lift and cruise motors, needs a second thrust axis the
  format does not have.
- **An autopilot that knows about transitions.** ALT HOLD, LOITER and RTL are off on a
  tail-sitter today.

## Others mentioned or worth having

- your forward-flying lifting-body quad — closer than it was: a tail-sitter already has
  wings on a four-motor airframe, so this is a build sheet away
- your helicopter, once it flies
