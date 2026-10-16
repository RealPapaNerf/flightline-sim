# Terrain maps from lidar

**Status: done (v1), except the wind.** The map format, the loader, the chunked
terrain and every query that reads the ground are built and shipping. What is
left is listed at the bottom.

## Built

- **A map format**, specified in [`docs/map-format.md`](../docs/map-format.md).
  One folder per map: `map.json`, `height.u16` (little-endian Uint16, because a
  browser decodes a 16-bit PNG to 8 bits and loses the low byte), optionally a
  surface-class grid and a colour image. A library is a folder of those plus an
  `index.json`.
- **Loading**, from a URL library or a local folder picker. The claude.ai
  artifact build cannot reach another server, so there the picker is the way in
  — which is also how it works offline at the field. Settings → Map.
- **Chunked terrain with levels of detail**, 64 cells a chunk, stride 1/2/4/8,
  one chunk rebuilt per frame. A 2 km map at 4 m is 64 chunks; a view from the
  pad submits about 62,000 triangles against a 150,000 budget. Chunk edges get
  skirts, so a crack where two levels meet shows ground rather than sky.
- **One height-and-normal query**, 49 ns a call, used by ground contact at
  400 Hz, the lidar, radio line of sight, the OSD's AGL readout, the shadow,
  gates, and where the pilot stands.
- **Ground contact on slopes**: the spring pushes along the terrain normal,
  friction acts in the tangent plane, and a hard arrival is judged on speed into
  the slope rather than descent rate.
- **Field elevation sets density altitude** from the map, automatically.
- **Line of sight for the link model comes out of the terrain**, by ITU-R
  P.526's knife-edge diffraction, so a quad down in a canyon loses the link and
  one 50 m higher does not.
- **Orthophoto colours draped over it**, where a map carries an image.
- **A builder**: [terrain-and-maps-builder](https://github.com/RealPapaNerf/terrain-and-maps-builder).
- **A library**: [maps-folder](https://github.com/RealPapaNerf/maps-folder).

## Left to do

- **Terrain-shaped wind.** Flow up windward slopes and down lee slopes, rotor
  behind ridges, canyon channelling. This is where real mountain SAR flights get
  into trouble, and it is the biggest single thing still missing. Everything it
  needs is now in place: the heightfield, the gradient at any point, and a ray
  cast. The existing `leeAt` already does this for discrete obstacles; terrain
  wants a field computed from the slope and the wind direction instead.
- **The real maps.** Cedar City, Brian Head, Timpanogos, Zion. The builder is
  written and tested; it needs a machine that can reach
  `elevation.nationalmap.gov`.
- **Frame time on an actual Chromebook.** The triangle counts are measured and
  within budget, but a software rasteriser says nothing about a real GPU.
- **Imagery.** The NAIP service URLs in the builder are unverified.
