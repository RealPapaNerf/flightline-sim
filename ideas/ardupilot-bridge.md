# Real ArduPilot in the loop

**Status: pinned.** You asked whether a real ArduPilot flight controller could fly the sim.

## What ArduPilot supports today

- **Classic HIL is gone.** ArduPilot dropped hardware-in-the-loop years ago (developers' own
  words on the forum).
- **SITL (software in the loop)**: ArduPilot's actual firmware compiled for a PC. It can take its
  physics from an outside simulator through the **JSON interface** over UDP: SITL sends servo
  outputs, the simulator sends back the vehicle state.
  - Load your Goblin's real parameter file and you get your exact tuning, modes and failsafe
    settings.
  - Mission Planner or QGroundControl connects to SITL exactly as it would to the aircraft.
- **Simulation on Hardware**: your actual flight controller runs ArduPilot with the simulator
  built in, and it can take outside physics over MAVLink. The catches:
  - it needs a custom firmware build (the only pre-built one is Copter on a Cube Orange)
  - the simulated and real aircraft share one parameter set, so you wipe and reload parameters
    when switching
  - props off

## How Flightline would do it

- **SITL route (recommended)**: a tiny helper (Python or Node) bridges the browser and SITL,
  WebSocket ↔ UDP, because browsers can't open UDP sockets. Runs in the Chromebook's Linux or on
  a PC.
  - Flightline sends position, velocity, attitude, gyro, accelerometer, lidar range and
    airspeed.
  - Flightline receives PWM per servo or motor and drives its own physics with them.
  - Mission Planner on a Windows PC, or QGroundControl (Linux, or Android on the Chromebook)
    connects to SITL.
- **Simulation-on-hardware route**: Chrome on a Chromebook can talk to a USB flight controller
  over **Web Serial**, so the sim could speak MAVLink straight to the board. Needs the custom
  firmware above.

## Why bother

Rehearsing with your real parameters catches the dangerous stuff before the field. Examples:
- a failsafe set to the wrong action
- RTL altitude below the treeline
- a fence that blocks the search area
- a tune that oscillates at the 13"'s weight

## Open questions

- Which flight controllers do you run (Goblin, 7", 13")? Simulation-on-hardware support depends
  on the board.
- Is a Linux helper on the Chromebook acceptable, or should it run on the Windows machine?

Sources: [Simulation on Hardware](https://ardupilot.org/dev/docs/sim-on-hardware.html) ·
[SITL JSON interface](https://ardupilot.org/dev/docs/sitl-with-JSON.html) ·
[ArduPilot forum: HIL dropped](https://discuss.ardupilot.org/t/hardware-in-the-loop-hil-with-cube-orange-and-flightgear/144416)
