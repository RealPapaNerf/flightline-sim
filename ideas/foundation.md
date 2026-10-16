# Foundation: sensors, link model, autopilot core

**Status: building.** Everything autonomous, every failsafe and the Mission Planner-style screen
need these three pieces, and each is useful on its own.

## 1. Sensors

Right now the OSD shows true values straight from the physics. Real aircraft see the world
through sensors that lie a little, and the autopilot only knows what the sensors say.

- **GPS**: 5–10 Hz updates, ~100–200 ms latency, a random-walk position error of a metre or two
  (HDOP-dependent), satellite count, fix type. Later: degraded near the mesas and in canyons,
  jamming as a failure.
- **Barometer**: altitude from pressure with a few tens of cm of noise and slow drift; prop wash
  and dynamic pressure errors at speed (the classic "baro dips in forward flight").
- **Downward lidar** (like your Goblin's): range to whatever is below along the body's down axis,
  so it reads long when banked. Max range set per sensor (e.g. 12 m for a TFmini-class, 40 m for a
  LightWare-class). Returns weaken with range and with poor reflectors: water, wet asphalt, fresh
  snow at a glancing angle, dark rock. Below a signal threshold the reading goes noisy, then
  invalid, and the autopilot falls back to baro: exactly the "holds altitude most of the time,
  loses it over the wrong surface or too high" behaviour.
- **Compass / attitude**: heading from the physics plus small errors; later, interference from
  the power line and high-current wiring.

## 2. Link model

- **RC link**: link quality and RSSI from distance, antenna orientation and line of sight
  (terrain, buildings, trees between pilot and aircraft), plus an interference slider. Packet
  loss shows as stick latency and freezes; below a threshold the receiver goes to failsafe.
- **Analog video**: signal-to-noise from the same geometry. Low SNR shows as snow, sync tearing,
  colour loss, and full breakups. Different from digital, which stays clean then freezes.
- **OSD**: LQ / RSSI and video-strength readouts.

## 3. Autopilot core (ArduPilot-flavoured)

- **Alt hold** using lidar where valid, else baro (with the handover you'd see for real).
- **Position hold / loiter** for multirotors, circle-loiter for planes.
- **RTL**: climb to RTL altitude, fly home, loiter or land (multirotor) / circle overhead (plane).
- **RC-loss failsafe**: after the timeout, RTL (or land / hold, per setting). Regaining the link
  gives control back on a mode switch, like ArduPilot.
- **Takeover**: your sticks always win: any stick input or mode switch drops you back into acro
  or stabilised.

## Open questions

- Which lidar should the Goblin carry: your actual model and its max range?
- RTL altitude and failsafe timeout defaults: copy from your ArduPilot params?
