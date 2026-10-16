# Flightline map format, version 1

A map is **a folder**. The folder holds a small JSON file describing the place, a
binary heightfield, and two optional extras (a surface-class grid and a colour
image). A library of maps is a folder of those folders plus an `index.json`.

```
maps/
  index.json                  every map in this library
  cedar-city-field/
    map.json                  name, origin, grid, pilot spot, obstacles
    height.u16                heights: little-endian Uint16, cols x rows
    surface.u8                optional: surface class per post, Uint8
    color.jpg                 optional: orthophoto draped over the terrain
    thumb.jpg                 optional: 256 px preview for the map picker
```

Nothing in a map folder needs a server that can do anything but serve files, so
a library works from GitHub Pages, from a local folder picked in the browser, or
from a `file://` directory.

## Why the heights are raw binary and not a PNG

A 16-bit greyscale PNG is the obvious choice and it does not work. Browsers
decode PNG through the image pipeline, which gives 8 bits per channel: the
canvas and WebGL both hand back `Uint8`, so a 16-bit PNG arrives with its low
byte thrown away. On a 600 m map that turns 9 mm of height resolution into
2.3 m — visible terracing on every slope, and a ground-contact query that
reports the aircraft standing on a step.

Packing the 16 bits across two 8-bit channels of an RGB PNG does survive
decoding, but it costs a canvas round trip, a `getImageData` copy, and an
awkward encoder. A bare `Uint16Array` from `fetch().arrayBuffer()` is smaller
than the PNG would be after compression of a noisy DEM, needs no decode step,
and is three lines to read. So: raw little-endian `Uint16`.

The colour image stays a JPEG, because 8 bits per channel is all colour needs.

## `map.json`

```json
{
  "format": "flightline-map/1",
  "id": "cedar-city-field",
  "name": "Cedar City field",
  "region": "Cedar City, Utah",
  "author": "RealPapaNerf",
  "attribution": "Elevation: USGS 3DEP 1 m (public domain). Imagery: USGS NAIP (public domain).",
  "license": "CC0-1.0",
  "created": "2026-10-16",
  "builder": "flightline-map-builder 0.1.0",

  "origin": {
    "lat": 37.67745,
    "lon": -113.06284,
    "utm": { "zone": 12, "hemisphere": "N", "easting": 318087.75, "northing": 4172030.46 },
    "datumElevM": 1710.0
  },

  "grid": {
    "cols": 513,
    "rows": 513,
    "cell": 4.0,
    "originNE": [1024.0, -1024.0],
    "heights": {
      "file": "height.u16",
      "type": "uint16le",
      "scale": 0.009095,
      "offset": 1650.2,
      "min": 1650.2,
      "max": 2246.3
    },
    "surface": { "file": "surface.u8", "type": "uint8" }
  },

  "color": { "file": "color.jpg", "coverage": "grid" },

  "fieldElevM": 1710.0,
  "rangeM": 2000,
  "pilot": { "n": 0, "e": 0, "yawDeg": 0 },
  "home": { "n": 0, "e": 0 },

  "pads": [
    { "kind": "runway", "n": -12, "e": 0, "yawDeg": 90, "lengthM": 120, "widthM": 10, "surface": "asphalt" }
  ],

  "starts": [
    { "id": "runway", "name": "On the runway", "n": -12, "e": -50, "yawDeg": 90, "aglM": 0 },
    { "id": "air", "name": "In the air, 80 m", "n": -200, "e": 0, "yawDeg": 90, "aglM": 80, "speedMs": 16 }
  ],

  "obstacles": [],
  "gates": []
}
```

Every field below is required unless it says otherwise. A loader that meets a
`format` it does not know refuses the map rather than guessing.

### `origin` — where on Earth the map is

| Field | Meaning |
|---|---|
| `lat`, `lon` | WGS84 latitude and longitude of **local NED (0, 0)**, degrees |
| `utm.zone`, `utm.hemisphere` | UTM zone the easting and northing are in |
| `utm.easting`, `utm.northing` | the same point in UTM metres |
| `datumElevM` | the elevation, in metres above sea level, that local **NED z = 0** sits at |

`datumElevM` is the one that matters in flight. The sim's world frame is NED —
x north, y east, z **down**, metres — with its origin where you stand. A
terrain post whose elevation is `e` metres above sea level sits at

```
up = e - datumElevM          metres above the datum, positive up
NED z = -up
```

so `datumElevM` is what ties the map's sea-level heights to the sim's zero. Set
it to the field elevation and home sits at z ≈ 0, the altitude tape reads height
above the field, and nothing in the existing code has to change its idea of
zero.

Latitude and longitude are carried for attribution, for the map picker, and so
the builder can be re-run over the same ground. The sim does not fly on them.

The UTM easting and northing are the same point, for lining a map up against a
paper topo or a GPS set to UTM. Let the builder work them out — `flmap` has the
Snyder series in `lib/utm.mjs`, checked by round trip to 0.84 mm. The example
above was wrong by 1,526 m the first time it was written here by hand, which is
how far off a plausible-looking guess can be.

### `grid` — the heightfield

Heights are stored on **posts**, not cells: `cols` x `rows` samples at the
corners of the grid, spacing `cell` metres, so the ground covered is
`(cols - 1) x (rows - 1)` cells, i.e. `(cols-1) * cell` by `(rows-1) * cell`
metres. Posts are what a mesh wants (one vertex per sample) and what bilinear
interpolation is exact at.

**Layout.** `height.u16` is row-major, `cols * rows` little-endian `Uint16`
values, `2 * cols * rows` bytes and not one byte more.

- **row 0 is the north edge**, rows run north → south
- **column 0 is the west edge**, columns run west → east

That is the north-up, top-down order every raster tool and every image uses, so
`height.u16`, `surface.u8` and `color.jpg` all index the same way and a map can
be inspected by loading the colour image in any viewer.

**Post (c, r) in local metres:**

```
e = originNE[1] + c * cell
n = originNE[0] - r * cell
```

`originNE` is the **north-west** post, as `[north, east]`. For a map centred on
local (0, 0) that is `[+(rows-1)*cell/2, -(cols-1)*cell/2]`, but a map may put
the pilot anywhere in the grid.

**Height decode:**

```
elevM = value * scale + offset           value is the Uint16, 0 .. 65535
```

`scale` must be greater than zero. The builder picks
`scale = (max - min) / 65535` and `offset = min`, which spends the whole 16-bit
range on the relief that is actually there. Worst-case quantisation error is
`scale / 2`:

| Relief across the map | `scale` | Worst error |
|---|---|---|
| 100 m (a gentle field) | 1.5 mm | 0.8 mm |
| 600 m (Cedar City to the ridge) | 9.2 mm | 4.6 mm |
| 1,500 m (Zion canyon rim to floor) | 22.9 mm | 11.4 mm |
| 6,553.5 m | 100 mm | 50 mm |

`min` and `max` repeat the elevation range in metres. They are redundant with
`scale` and `offset` and exist so a map picker can show the relief without
reading the heightfield; a loader checks them for consistency and trusts
`scale`/`offset`.

A fixed `scale` of 1 m or 0.1 m is also legal if a builder prefers absolute
elevations: `scale = 0.1, offset = 0` spans 0 to 6,553.5 m, which covers every
summit in the lower 48 at 100 mm resolution. The per-map fit is better and costs
nothing, so that is the default.

**Size.** `cols` and `rows` are at most 1024 each, which caps `height.u16` at
2 MB. A 1024 x 1024 grid at 2 m per cell is 2.046 km square; at 4 m it is
4.092 km.

### `grid.surface` — optional surface classes

`surface.u8` is `cols * rows` bytes, one per post, same layout as the heights.
Each byte is a class:

| Value | Class | Lidar reflectivity at 905 nm | Notes |
|---|---|---|---|
| 0 | `unknown` | 0.40 | the default where nothing is known |
| 1 | `grass` | 0.45 | dry grass and crops |
| 2 | `rock` | 0.35 | bare rock, slickrock, scree |
| 3 | `water` | 0.03 | specular: the beam leaves and does not come back |
| 4 | `asphalt` | 0.12 | also concrete, dry |
| 5 | `snow` | 0.70 | fresh snow; dirty old snow is lower |
| 6 | `dirt` | 0.30 | dirt road, sand, bare soil |
| 7 | `brush` | 0.40 | sage, scrub, low chaparral |

Those are reflectivities at the 905 nm the hobby lidars use, and they are the
numbers the sim already assumed for its built-in field — grass 0.45, dry
asphalt 0.12, snow cover 0.70 — so switching a flat field to a mapped one does
not move the rangefinder's behaviour. Water at 0.03 is the important one: a
TF-Luna pointed at calm water gets almost nothing back, which is exactly the
failure a search-and-rescue flight over a reservoir runs into.

The table lives in the sim, not in the map, so every map agrees. A map may
override any row with a `surfaceClasses` object in `map.json`:

```json
"surfaceClasses": { "5": { "name": "wet snow", "refl": 0.45 } }
```

Classes also set how much the radio cares: `water` and `asphalt` are ground,
`brush` costs nothing, and a post classed `rock` that stands above the
line of sight blocks it like terrain, because it is terrain.

With no `surface.u8`, every post is `unknown` and the sim falls back to slope
and elevation for colour, which is what the built-in field does today.

### `color` — optional draped imagery

```json
"color": { "file": "color.jpg", "coverage": "grid" }
```

`coverage: "grid"` means the image covers the grid's full extent corner to
corner: the image's top-left pixel is the north-west post and its bottom-right
pixel is the south-east post, so

```
u = c / (cols - 1)        v = r / (rows - 1)
```

It is the only `coverage` version 1 defines. The image is sampled with
clamp-to-edge, never repeated, and its aspect ratio should match
`(cols-1) : (rows-1)`; a loader that finds it does not match stretches to the
grid and says so rather than shifting the imagery off the ground.

JPEG and PNG are both fine. 2048 x 2048 JPEG at quality 80 is about 600 KB and
is plenty over 2 km — that is one pixel per metre.

With no colour image the terrain is coloured per-vertex from its surface class,
slope and elevation. That reads better than it sounds and costs nothing to
download, so a map is useful without imagery.

### The flying bits

| Field | Meaning |
|---|---|
| `fieldElevM` | field elevation, metres above sea level. Drives density altitude. |
| `rangeM` | optional. How far out the aircraft may go before the sim resets it. Default 1500. |
| `pilot` | where you stand: `n`, `e` in local metres, optional `yawDeg` for the direction you face (0 = north) |
| `home` | the autopilot's home point, `n`, `e` in local metres |
| `pads` | runways and pads |
| `starts` | start positions offered in the menu |
| `obstacles` | everything you can hit |
| `gates` | an optional race course, flown in array order |

`fieldElevM` is separate from `origin.datumElevM` on purpose. The datum is a
coordinate convention; the field elevation is a weather input. They are normally
the same number, and a map may differ if, say, the datum is set to a round
value.

Heights everywhere in this section are metres **above the terrain at that
point**, unless a field says otherwise. The builder does not have to know the
ground height to place a tree.

#### `pads`

```json
{ "kind": "runway", "n": -12, "e": 0, "yawDeg": 90, "lengthM": 120, "widthM": 10, "surface": "asphalt" }
```

A rectangle centred on `n`, `e`, with `lengthM` running along `yawDeg` (degrees
clockwise from north, so 90 is an east–west runway) and `widthM` across it.
`kind` is `runway` or `pad`. `surface` is a class name from the table above and
sets the pad's colour and lidar reflectivity; the terrain underneath is not
flattened by the loader, so a builder that wants a flat runway flattens those
posts in the heightfield.

#### `starts`

```json
{ "id": "runway", "name": "On the runway", "n": -12, "e": -50, "yawDeg": 90, "aglM": 0, "speedMs": 16 }
```

`aglM` is height above the terrain, so 0 means on the ground and the loader
works out the elevation. `speedMs` is optional and defaults to 0; a start with
`aglM > 0` and no speed is a drop.

#### `obstacles`

Every obstacle is anchored to a point on the ground and measured up from there,
so the same obstacle list works whatever the terrain does underneath.

```json
{ "t": "tree",     "n": 120, "e": -40, "r": 2.4, "h": 9.5, "kind": "pine" }
{ "t": "building", "n": -30, "e": 18, "sizeN": 4, "sizeE": 6, "h": 3.2, "roof": "gable" }
{ "t": "pole",     "n": 330, "e": -210, "r": 0.16, "h": 10 }
{ "t": "wire",     "a": { "n": 330, "e": -210, "up": 9.2 }, "b": { "n": 330, "e": -140, "up": 9.2 }, "r": 0.02, "sagM": 1.1 }
{ "t": "gate",     "n": -118, "e": 78, "yawDeg": 0, "widthM": 2.2, "heightM": 2.0, "baseM": 0 }
{ "t": "target",   "n": 390, "e": 260, "kind": "hiker" }
```

| `t` | Shape | Fields |
|---|---|---|
| `tree` | cylinder standing on the ground | `n`, `e`, `r` (collision radius), `h`; optional `kind` for the look |
| `building` | box, axis-aligned in NED | `n`, `e` (centre), `sizeN`, `sizeE`, `h`; optional `roof` |
| `pole` | thin cylinder | `n`, `e`, `r`, `h` |
| `wire` | segment between two points | `a`, `b` as `{n, e, up}` with `up` above the terrain **at that end**, `r`, optional `sagM` |
| `gate` | race or course gate | `n`, `e`, `yawDeg`, `widthM`, `heightM`, `baseM` above the ground |
| `target` | a search-and-rescue target, no collision | `n`, `e`, optional `kind` |

Buildings are axis-aligned in version 1. A building at an angle is either a
cylinder or a short run of `wire`-style segments; a `yawDeg` on `building` is
reserved and a version 1 loader ignores it rather than drawing the box wrong.

`sagM` on a wire is how far the middle hangs below the straight line between the
ends. The loader draws and collides it as a few straight segments following a
parabola, which is what the built-in field's power line already does.

#### `gates`

```json
{ "n": -118, "e": 78, "yawDeg": 0, "widthM": 2.2, "heightM": 2.0, "baseM": 0 }
```

The same shape as a `gate` obstacle. A gate listed here is part of the timed
course, in array order; a gate in `obstacles` is scenery you can hit. A gate
should appear in one list or the other, not both — the loader adds a course
gate's posts to the collision set itself.

## `index.json`

One per library, at its root. The sim fetches this, shows the list, and only
then downloads a map.

```json
{
  "format": "flightline-maps/1",
  "name": "Flightline public maps",
  "updated": "2026-10-16",
  "maps": [
    {
      "id": "cedar-city-field",
      "name": "Cedar City field",
      "region": "Cedar City, Utah",
      "path": "cedar-city-field/",
      "extentM": [2048, 2048],
      "cell": 4.0,
      "fieldElevM": 1710.0,
      "reliefM": 596,
      "bytes": 1140000,
      "hasColor": true,
      "thumb": "cedar-city-field/thumb.jpg",
      "attribution": "USGS 3DEP, USGS NAIP"
    }
  ]
}
```

`path` is relative to the `index.json`, ends in `/`, and the map's own files are
relative to `path`. `bytes` is the whole folder, so the picker can warn before a
2 MB download on a phone tether. Everything but `id`, `name` and `path` is
optional: a library is still valid if it only lists those, and the sim fills the
rest in from `map.json` once a map is picked.

## Reading a map, end to end

```js
const base = 'https://realpapanerf.github.io/flightline-maps/';
const lib = await (await fetch(base + 'index.json')).json();
const entry = lib.maps.find((m) => m.id === 'cedar-city-field');

const dir = base + entry.path;
const json = await (await fetch(dir + 'map.json')).json();
const g = json.grid;

const heights = new Uint16Array(await (await fetch(dir + g.heights.file)).arrayBuffer());
if (heights.length !== g.cols * g.rows) throw new Error('heightfield is the wrong size');

// elevation, metres above sea level, at post (c, r)
const elevAt = (c, r) => heights[r * g.cols + c] * g.heights.scale + g.heights.offset;

// height above the sim's datum, metres, positive up
const upAt = (c, r) => elevAt(c, r) - json.origin.datumElevM;
```

`Uint16Array` on the `ArrayBuffer` is correct on every machine the sim runs on,
because every one of them is little-endian — x86 and ARM alike, and WebAssembly
mandates it. A loader that wants to be strict about it reads with a `DataView`
and `getUint16(i, true)` instead, at about four times the cost.

## Writing one

The builder (`terrain-and-maps-builder`) does this, but the format is simple
enough to write by hand or from a spreadsheet:

1. Get elevations onto a `cols` x `rows` post grid in local metres, north-up.
2. `min` and `max` over the grid; `scale = (max - min) / 65535`; `offset = min`.
3. `value = Math.round((elev - offset) / scale)`, clamped to 0 .. 65535.
4. Write them little-endian, row 0 first, west to east within a row.
5. Write `map.json`, with `datumElevM` set to the field elevation.
6. Add the map to `index.json`.

## What version 1 deliberately leaves out

- **Terrain-shaped wind.** Upslope flow, lee sink and ridge rotor are computed
  by the sim from the heightfield; nothing about them belongs in the file.
- **Rotated buildings.** See above.
- **Several colour levels.** One image, one resolution. Tiled imagery with
  level-of-detail is a version 2 problem, and 2048 px over 2 km does not need it.
- **Vector roads, rivers, fences.** Everything you can hit is an obstacle;
  everything you cannot is either in the colour image or not there.
- **Bathymetry.** Water is a surface class with a reflectivity, not a volume.
- **Zip bundles.** A `.flmap` zip was in the original sketch. A folder works
  from a URL, from a folder picker and from `file://` with no zip reader, so
  version 1 is folders only. A zip may come later as a convenience, with the
  same contents.

A version 2 will bump `format` to `flightline-map/2`. A loader should accept any
`flightline-map/1*` string, ignore JSON keys it does not know, and refuse a
major version it was not built for.
