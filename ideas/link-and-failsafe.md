# Link loss and interference, advanced

**Status: pinned.** The foundation adds the basic link model; these are the next layers.

- **Terrain and obstacle shadow**: line of sight from the pilot's antenna to the aircraft. The
  barn, trees, mesas and (with terrain maps) ridgelines cut the signal. Going behind the treeline
  low is the classic way to lose a quad.
- **Fresnel zone and ground bounce**: low and far loses signal even with clear line of sight;
  multipath fading at certain distances.
- **Antenna patterns**: dipole nulls straight up and down, so the link drops overhead.
  Directional patch on the ground station, circular polarisation.
- **Interference sources**:
  - the power line (broadband noise)
  - a noisy BEC
  - other pilots on your channel
  - a slider for a "busy" RF environment at a SAR staging area
- **Digital vs analog video**: analog degrades gracefully (snow you can fly through); digital
  stays clean then freezes or drops. Pick per aircraft.
- **Failsafe stages**: hold, then RTL or land, with the timings you set; regain behaviour; ELRS
  telemetry lost vs RC lost.
- **Training scenarios**: "fly out until the video breaks, then get home on the OSD alone";
  "lose RC behind the barn, let RTL bring it back".
