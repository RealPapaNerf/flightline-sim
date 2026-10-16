# Terrain maps from lidar

**Status: done (v1).** The map format, the loader, the chunked terrain, every
query that reads the ground, and the terrain-shaped wind are all built and
shipping. What is left is listed at the bottom, and none of it is code.

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
- **Terrain-shaped wind**: the flow follows the ground (ridge lift and lee
  sink, `w = V.grad(h)`, measured over a stencil that widens with height so it
  decays properly), a wake behind whatever is upwind on the same model the sim
  already used for trees and barns, and valley channelling sampled at three
  radii. On a 200 m ridge in 10 m/s that is 6.8 m/s up the windward face and
  12.7 m/s down in the lee; a wind blowing straight across a 300 m canyon
  leaves 0.72 m/s in the bottom of it. Settings → Map, on by default.
- **A builder**: [terrain-and-maps-builder](https://github.com/RealPapaNerf/terrain-and-maps-builder).
- **A library**: [maps-folder](https://github.com/RealPapaNerf/maps-folder).

## Left to do

- **The real maps.** Cedar City, Brian Head, Timpanogos, Zion. The builder is
  written and tested; it needs a machine that can reach
  `elevation.nationalmap.gov`.
- **Frame time on an actual Chromebook.** The triangle counts are measured and
  within budget, but a software rasteriser says nothing about a real GPU.
- **Imagery.** The NAIP service URLs in the builder are unverified.

Beyond v1, if the wind turns out to want more: a real separation bubble with
reversed flow in it, mountain wave downstream of a ridge, and thermals off
sunlit slopes. None of those is in here — what is in here is three local rules.
