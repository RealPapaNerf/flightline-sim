# Map builder and shared maps

**Status: done (v1).** Built as
[terrain-and-maps-builder](https://github.com/RealPapaNerf/terrain-and-maps-builder),
with the library at [maps-folder](https://github.com/RealPapaNerf/maps-folder).

A dependency-free Node CLI — no GDAL, no rasterio, no PDAL. It reuses relief's
elevation layer (four files, copied verbatim with a provenance header) rather
than growing a "Flightline export" mode inside relief: relief's job is 3D
printing, and pilot spots, NED frames and density altitude have no business in
an STL exporter.

`flmap probe` checks every service from your machine. `flmap build` fetches and
writes a map. `flmap index` rebuilds a library. `flmap inspect` reads a map back
and checks it. See that repo's README for what is verified and what is not —
the elevation services are relief's and known good, the NAIP imagery URLs are
not verified.

**Not built:** per-tree extraction from LAZ classes 5 and 6, which needs PDAL or
a pure-JS LAZ reader. The hook is `--obstacles FILE`, which merges an obstacle
array a separate pipeline can produce. `--dsm` gets trees and buildings out of a
first-return surface raster instead, which needs no LAZ reader, but merges a
connected stand into one conservative cylinder.

The rest of this file is the original sketch, kept for the reasoning. The format
as built is in [`docs/map-format.md`](../docs/map-format.md) and differs in one
important way: heights are raw little-endian Uint16, not a 16-bit PNG.

## The idea

A separate tool (its own repo) that turns free elevation data into a **Flightline map file**.
Flightline gets an "Import map" button. Your topo-map generator already turns LiDAR into a
surface for STL, so the builder can be an export option there, or a sibling app reusing its
pipeline.

## Map file (to agree on first, so both sides can be built independently)

- `heightmap.png`: 16-bit greyscale, metres = value × scale + offset
- `color.jpg` (optional): orthophoto (e.g. NAIP) or a painted texture
- `map.json`:
  - name, author, licence
  - origin lat/lon and UTM zone, metres per pixel
  - pilot spot and home point
  - field elevation (sets density altitude)
  - runway or pad rectangles
  - obstacles: trees, buildings, power lines, gates, search targets
  - surface types (grass, asphalt, water, rock) for the lidar's reflectivity and the radio's
    obstruction
- Bundled as a `.flmap` (zip) or as plain files in a folder.

## Where maps live

| Option | Good for | Catch |
|---|---|---|
| Google Drive | your own maps, sharing a link with a friend | others download and import; the sim can't list a Drive folder by itself |
| Public GitHub repo (`flightline-maps`) | a free, versioned public library the sim can list and load directly | adding a map means a commit or pull request |
| Supabase (storage bucket + table) | anyone uploads and browses, ratings, search | needs a Supabase project (free tier) and sign-in for uploads |

Start with GitHub, add Supabase if people want to upload without git. The claude.ai artifact can't
reach outside servers; the GitHub Pages version of Flightline can.

## Size

Map file and importer: medium. The builder's UI depends on how much of the topo generator it can
reuse.
