# Map builder and shared maps

**Status: pinned.** Pairs with [terrain-maps](terrain-maps.md): that file is about flying real
terrain; this one is about making maps without spending Claude credits on each one.

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
