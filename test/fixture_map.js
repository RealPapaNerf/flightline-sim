/* Build a synthetic map folder, so the whole map path — the format, the
   loader, the chunked terrain, the physics and the renderer — can be tested
   without a network and without waiting on real lidar.

   The shape is deliberately awkward in the ways real ground is: a ridge that
   blocks the radio, a bowl you can lose a model in, a steep face a quad cannot
   be set down on, and a flat shelf to fly off. It is NOT a stand-in for real
   terrain and nothing about it is claimed to be Cedar City.

   Run: node test/fixture_map.js [outDir]       (default: maps/synthetic-ridge)
*/
const fs = require('fs');
const path = require('path');
const TER = require('../src/terrain.js');

const COLS = 513, ROWS = 513, CELL = 4; // 2.048 km square at 4 m
const FIELD = 1710; // metres above sea level, a plausible Cedar City bench

// elevation, metres above sea level, as a function of local north and east
function elev(n, e) {
  let z = FIELD;
  // a ridge running east-west, 180 m high, 300 m north of the field
  z += 180 * Math.exp(-((n - 300) ** 2) / (2 * 110 ** 2));
  // a second, higher summit to the north-east, for a known high point
  z += 240 * Math.exp(-(((n - 620) ** 2) / (2 * 150 ** 2) + ((e - 500) ** 2) / (2 * 180 ** 2)));
  // a bowl south-west, 40 m deep
  z -= 40 * Math.exp(-(((n + 420) ** 2) / (2 * 160 ** 2) + ((e + 450) ** 2) / (2 * 160 ** 2)));
  // a steep face on the east side: a ramp no quad can hold on
  z += 150 * Math.max(0, Math.min(1, (e - 600) / 220));
  // Roughness, so slopes are not glassy. A product of sines would do it in one
  // line but lays regular corduroy across every hillside, which looks nothing
  // like ground and hides shading faults behind a pattern. Four octaves of
  // value noise instead: no preferred direction, and the fine octaves are the
  // scale the 4 m cells actually have to resolve.
  z += fbm(n, e);
  // A flat shelf round the field itself, so there is somewhere to stand and
  // somewhere to put a runway. This goes LAST, after the roughness: blend the
  // shelf in first and the roughness lands back on top of it, leaving the
  // "flat" field in a hollow with lumps between you and everything you fly.
  const shelf = Math.exp(-((n ** 2 + e ** 2) / (2 * 150 ** 2)));
  return z * (1 - shelf) + FIELD * shelf;
}

function hash2(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296 - 0.5;
}
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
function fbm(n, e) {
  let v = 0, amp = 8, wl = 300;
  for (let o = 0; o < 4; o++) { v += amp * vnoise(n / wl, e / wl); amp *= 0.45; wl *= 0.38; }
  return v;
}

function build(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const n0 = ((ROWS - 1) * CELL) / 2, e0 = -((COLS - 1) * CELL) / 2;

  const raw = new Float64Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) raw[r * COLS + c] = elev(n0 - r * CELL, e0 + c * CELL);

  // flatten the runway strip so there is somewhere to roll
  const RW = { n: -12, e: 0, len: 120, wid: 10 };
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const n = n0 - r * CELL, e = e0 + c * CELL;
    const k = Math.max(0, 1 - Math.max(Math.abs(e - RW.e) / (RW.len / 2 + 14), Math.abs(n - RW.n) / (RW.wid / 2 + 10)));
    if (k > 0) raw[r * COLS + c] = raw[r * COLS + c] * (1 - k) + FIELD * k;
  }

  const enc = TER.encodeHeights(raw);

  // surface classes: snow on the tops, rock on the steep, water in the bowl, grass elsewhere
  const cls = new Uint8Array(COLS * ROWS);
  const at = (c, r) => raw[Math.min(ROWS - 1, Math.max(0, r)) * COLS + Math.min(COLS - 1, Math.max(0, c))];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const z = at(c, r);
    const slope = Math.hypot((at(c + 1, r) - at(c - 1, r)) / (2 * CELL), (at(c, r - 1) - at(c, r + 1)) / (2 * CELL));
    const n = n0 - r * CELL, e = e0 + c * CELL;
    const onRw = Math.abs(e - RW.e) < RW.len / 2 && Math.abs(n - RW.n) < RW.wid / 2;
    cls[r * COLS + c] = onRw ? TER.CLASS_OF.asphalt
      : z > FIELD + 300 ? TER.CLASS_OF.snow
        : z < FIELD - 32 ? TER.CLASS_OF.water
          : slope > 0.6 ? TER.CLASS_OF.rock
            : slope > 0.28 ? TER.CLASS_OF.brush
              : TER.CLASS_OF.grass;
  }

  // obstacles: a tree line, a barn, and a power line on poles across the north
  const obstacles = [];
  let seed = 20261016;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 220; i++) {
    const n = -900 + rnd() * 1500, e = -900 + rnd() * 1500;
    if (Math.hypot(n - RW.n, e - RW.e) < 110) continue; // keep the strip clear
    if (elev(n, e) > FIELD + 260) continue; // no trees above the snow line
    obstacles.push({ t: 'tree', n: +n.toFixed(1), e: +e.toFixed(1), r: +(1.6 + rnd() * 2.2).toFixed(2), h: +(5 + rnd() * 7).toFixed(1), kind: rnd() < 0.45 ? 'pine' : 'juniper' });
  }
  obstacles.push({ t: 'building', n: -60, e: -90, sizeN: 8, sizeE: 14, h: 4.5, roof: 'gable' });
  obstacles.push({ t: 'building', n: -58, e: 40, sizeN: 3, sizeE: 4, h: 2.6 });
  const PLN = 180;
  for (let e = -420; e <= 420; e += 70) obstacles.push({ t: 'pole', n: PLN, e, r: 0.16, h: 10 });
  for (let e = -420; e < 420; e += 70) {
    obstacles.push({ t: 'wire', a: { n: PLN, e, up: 9.2 }, b: { n: PLN, e: e + 70, up: 9.2 }, r: 0.02, sagM: 1.1 });
  }
  obstacles.push({ t: 'target', n: -430, e: -460, kind: 'hiker' });

  // an eight-gate oval course on the shelf, each gate standing on the ground
  const gates = [];
  for (let k = 0; k < 8; k++) {
    const th = Math.PI / 2 + (k / 8) * Math.PI * 2;
    const n = -118 + 52 * Math.sin(th), e = 78 * Math.cos(th);
    const tn = 52 * Math.cos(th), te = -78 * Math.sin(th);
    gates.push({ n: +n.toFixed(1), e: +e.toFixed(1), yawDeg: +((Math.atan2(te, tn) * 180) / Math.PI).toFixed(1), widthM: 2.2, heightM: 2.0, baseM: k === 3 ? 3 : k === 6 ? 1.5 : 0 });
  }

  const json = {
    format: 'flightline-map/1',
    id: 'synthetic-ridge',
    name: 'Synthetic ridge',
    region: 'Nowhere — a test fixture',
    author: 'test/fixture_map.js',
    attribution: 'Synthetic. Not real terrain, and not anywhere.',
    license: 'CC0-1.0',
    created: new Date().toISOString().slice(0, 10),
    builder: 'flightline test/fixture_map.js',
    origin: {
      lat: 37.67745, lon: -113.06284,
      utm: { zone: 12, hemisphere: 'N', easting: 318244.0, northing: 4170512.0 },
      datumElevM: FIELD,
    },
    grid: {
      cols: COLS, rows: ROWS, cell: CELL, originNE: [n0, e0],
      heights: { file: 'height.u16', type: 'uint16le', scale: enc.scale, offset: enc.offset, min: +enc.min.toFixed(2), max: +enc.max.toFixed(2) },
      surface: { file: 'surface.u8', type: 'uint8' },
    },
    fieldElevM: FIELD,
    rangeM: 1400,
    pilot: { n: 0, e: 0, yawDeg: 0 },
    home: { n: 0, e: 0 },
    pads: [{ kind: 'runway', n: RW.n, e: RW.e, yawDeg: 90, lengthM: RW.len, widthM: RW.wid, surface: 'asphalt' }],
    starts: [
      { id: 'pad', name: 'On the pad', n: 8, e: 1.5, yawDeg: 0, aglM: 0 },
      { id: 'runway', name: 'On the runway', n: RW.n, e: -52, yawDeg: 90, aglM: 0 },
      { id: 'launch', name: 'In your hand', n: 0.6, e: 0.45, yawDeg: 0, aglM: 1.7 },
      { id: 'air', name: 'In the air, 60 m', n: -200, e: 120, yawDeg: 270, aglM: 60, speedMs: 16 },
      { id: 'ridge', name: 'Over the ridge, 40 m', n: 300, e: 0, yawDeg: 180, aglM: 40, speedMs: 14 },
    ],
    obstacles,
    gates,
  };

  fs.writeFileSync(path.join(outDir, 'map.json'), JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'height.u16'), Buffer.from(enc.values.buffer, enc.values.byteOffset, enc.values.byteLength));
  fs.writeFileSync(path.join(outDir, 'surface.u8'), Buffer.from(cls.buffer));

  const index = {
    format: 'flightline-maps/1',
    name: 'Flightline test fixtures',
    updated: json.created,
    maps: [{
      id: json.id, name: json.name, region: json.region, path: 'synthetic-ridge/',
      extentM: [(COLS - 1) * CELL, (ROWS - 1) * CELL], cell: CELL, fieldElevM: FIELD,
      reliefM: Math.round(enc.max - enc.min),
      bytes: 2 * COLS * ROWS + COLS * ROWS + 40000,
      hasColor: false, attribution: json.attribution,
    }],
  };
  fs.writeFileSync(path.join(path.dirname(outDir), 'index.json'), JSON.stringify(index, null, 2) + '\n');

  return { json, enc, cls, dir: outDir };
}

module.exports = { build, elev, COLS, ROWS, CELL, FIELD };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, '..', 'maps', 'synthetic-ridge');
  const { json, enc } = build(out);
  const span = enc.max - enc.min;
  console.log(`wrote ${out}`);
  console.log(`  ${COLS}x${ROWS} posts at ${CELL} m = ${((COLS - 1) * CELL) / 1000} km square`);
  console.log(`  elevation ${enc.min.toFixed(1)} to ${enc.max.toFixed(1)} m (${span.toFixed(1)} m of relief)`);
  console.log(`  height scale ${(enc.scale * 1000).toFixed(3)} mm per step, so at worst ${((enc.scale / 2) * 1000).toFixed(2)} mm of quantisation error`);
  console.log(`  height.u16 ${(2 * COLS * ROWS / 1024).toFixed(0)} KB, surface.u8 ${(COLS * ROWS / 1024).toFixed(0)} KB`);
  console.log(`  ${json.obstacles.length} obstacles, ${json.gates.length} gates, field ${FIELD} m`);
}
