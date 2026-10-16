You're picking up work on **Flightline RC Sim** (github.com/RealPapaNerf/flightline-sim, public). It's a browser flight sim I use on a Chromebook to practise flying my RC planes, quads and heli before real flights, including search-and-rescue flights. It's one self-contained WebGL page built from `src/` by `tools/build.py` and served from GitHub Pages at realpapanerf.github.io/flightline-sim. Push straight to `main`, with no PRs, and write each commit message like a PR description. I have no formal engineering background, so be an editor, not an author: show the numbers and assumptions so I can check them.

**This session: real terrain from lidar, a map file format, and a map builder.**

Read first: `README.md`, `ideas/terrain-maps.md`, `ideas/map-builder.md`, `ideas/README.md`. Then in the code:
- `src/physics.js`: `finish()` contact points assume flat ground at NED z = 0
- `src/app.js`:
  - `buildWorld` and `world.obstacles`
  - `surfaceAt` (lidar), `obstruction` (radio line of sight), `leeAt` (wind shelter)
  - `renderView`, the stencil shadow, the 1,500 m range reset
- `src/nav.js`: the lidar ray
- `src/render.js`: the `Geo` mesh builder and fog

**Goals, in order:**
1. **Map format v1, in `docs/map-format.md`:** one folder per map containing:
   - `map.json`:
     - name, author, attribution
     - origin lat/lon plus UTM zone, easting, northing
     - cols, rows, metres per cell
     - height scale and offset
     - field elevation (it drives density altitude)
     - pilot spot and home in local metres, NED
     - runway or pad rectangles
     - obstacles (trees, buildings, poles, wires, gates, search targets)
     - an optional surface-class grid (grass, rock, water, asphalt, snow) for lidar reflectivity and radio obstruction
   - Heights as little-endian `Uint16` binary, **not** 16-bit PNG: browsers decode PNGs to 8 bits per channel.
   - An optional colour image draped over the terrain.
   Then a `maps/index.json` listing every map.
2. **Game side:**
   - Load a map from a URL list, or from a local file or folder picker. The claude.ai artifact build can't fetch from outside servers.
   - Terrain mesh in chunks with level of detail. Budget about 150k triangles; it must hold 60 fps on a Chromebook at "Balanced" resolution.
   - One fast height-and-normal query, used by:
     - physics ground contact and crash detection (it runs at 400 Hz)
     - height above ground on the OSD
     - the lidar
     - radio line of sight blocked by terrain
     - shadows, gates and where the pilot stands
   - Keep the current field as the built-in default map.
   - Terrain-shaped wind (upslope, lee sink, ridge rotor) is a later step.
3. **Map builder, as a separate repo:**
   - I already built a LiDAR-to-STL relief generator with Claude Code. Look at whether it should get a "Flightline export" mode instead of starting fresh.
   - Input: a lat/lon box or centre plus size. Fetch USGS 3DEP 1 m DEM data (The National Map / 3DEP ImageServer), or take files I download myself (UGRC Utah lidar, USGS LidarExplorer: LAZ or GeoTIFF).
   - Resample to about 2–4 m per cell, at most 1024 × 1024.
   - Optionally drape NAIP orthophoto colour.
   - Optionally pull trees and buildings out of lidar classes 5 and 6 as obstacles.
   - Write the map folder and update `index.json`.
   - A Python CLI (GDAL, rasterio, PDAL) is fine for v1. Verify every endpoint before relying on it.
4. **Storage:** a public `flightline-maps` repo with GitHub Pages switched on. The game lists maps from its `index.json`.

**First maps:**
- my flying field near Cedar City (I'll give you the coordinates)
- Brian Head
- Timpanogos
- Zion (the sim only; real drones aren't allowed in national parks)

About 2 × 2 km each.

**Checks:**
- Node tests for the height query and ground contact on slopes.
- A known summit elevation, compared against the map.
- A screenshot pass in headless Chromium with SwiftShader.
- Frame time measured on a dense map.

Other sessions may also push to this repo. Pull and rebase before you start and before every push, and keep your changes focused.
