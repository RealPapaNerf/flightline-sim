/* =====================================================================
   terrain.js — the map's heightfield.

   Holds the loaded map, answers the one fast height-and-normal query that
   physics, the lidar, the radio, the OSD and the renderer all share, casts
   rays against the terrain, and builds chunked level-of-detail meshes.

   No DOM and no WebGL in here: it runs in node for test/terrain_test.js, and
   chunkMesh returns plain typed arrays for app.js to upload.

   Frames. Two of them, and they are easy to mix up:
     world (physics, nav, maps)  NED: x north, y east, z down, metres
     render (meshes, cameras)    Y-up: x east, y up, z south
   A height is carried as `up`: metres above the map's datum, positive up.
   NED z = -up, and render y = up.

   Grid. Posts, not cells: cols x rows samples at the cell corners. Post
   (c, r) sits at e = e0 + c*cell, n = n0 - r*cell, with (n0, e0) the
   north-west post, so row 0 is the north edge and column 0 the west edge —
   the same north-up order as height.u16, surface.u8 and color.jpg.
   See docs/map-format.md.
   ===================================================================== */
const TERRAIN = (function () {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  /* ---------- surface classes ----------
     Reflectivity is for the 905 nm the hobby rangefinders use. The grass,
     asphalt and snow numbers are the ones the built-in flat field already
     assumed (0.45 / 0.12 / 0.70), so a mapped field does not move the
     rangefinder's behaviour. Water at 0.03 is the one that bites: a TF-Luna
     over calm water gets almost nothing back.
     `radio` is extra one-way loss in dB if a post of this class stands in the
     line of sight; terrain blocks by its height, so this is only for the
     classes that are vegetation rather than ground. */
  const SURFACE = [
    { id: 'unknown', name: 'Unknown', refl: 0.40, radio: 0, col: [0.52, 0.50, 0.40] },
    { id: 'grass', name: 'Grass', refl: 0.45, radio: 0, col: [0.42, 0.56, 0.25] },
    { id: 'rock', name: 'Rock', refl: 0.35, radio: 0, col: [0.60, 0.50, 0.42] },
    { id: 'water', name: 'Water', refl: 0.03, radio: 0, col: [0.19, 0.32, 0.40] },
    { id: 'asphalt', name: 'Asphalt', refl: 0.12, radio: 0, col: [0.26, 0.26, 0.27] },
    { id: 'snow', name: 'Snow', refl: 0.70, radio: 0, col: [0.90, 0.92, 0.95] },
    { id: 'dirt', name: 'Dirt', refl: 0.30, radio: 0, col: [0.58, 0.46, 0.33] },
    { id: 'brush', name: 'Brush', refl: 0.40, radio: 3, col: [0.48, 0.50, 0.33] },
  ];
  const CLASS_OF = {};
  SURFACE.forEach((s, i) => { CLASS_OF[s.id] = i; });

  const CHUNK = 64; // cells per chunk side at full detail
  const LODS = [1, 2, 4, 8]; // post stride; 8192, 2048, 512 and 128 triangles per chunk

  /* ---------- the terrain object ---------- */

  /* Build from a grid of `up` values (metres above the datum), north-up,
     row-major, cols*rows long. Everything else is a wrapper round this. */
  function fromGrid(o) {
    const cols = o.cols | 0, rows = o.rows | 0, cell = +o.cell;
    const up = o.up;
    if (!(cols >= 2 && rows >= 2)) throw new Error(`grid must be at least 2x2, got ${cols}x${rows}`);
    if (!(cell > 0)) throw new Error(`cell must be positive, got ${cell}`);
    if (up.length !== cols * rows) throw new Error(`grid is ${up.length} values, expected ${cols * rows}`);
    const n0 = o.n0 == null ? ((rows - 1) * cell) / 2 : +o.n0;
    const e0 = o.e0 == null ? -((cols - 1) * cell) / 2 : +o.e0;
    const cls = o.cls || null;
    if (cls && cls.length !== cols * rows) throw new Error(`surface grid is ${cls.length} values, expected ${cols * rows}`);

    let minUp = Infinity, maxUp = -Infinity;
    for (let i = 0; i < up.length; i++) { const v = up[i]; if (v < minUp) minUp = v; if (v > maxUp) maxUp = v; }
    const span = maxUp - minUp || 1;

    // extent, as the usable square of ground
    const widthM = (cols - 1) * cell, heightM = (rows - 1) * cell;
    const nMax = n0, nMin = n0 - heightM, eMin = e0, eMax = e0 + widthM;

    const T = {
      isFlat: false,
      cols, rows, cell, n0, e0, up, cls,
      minUp, maxUp, widthM, heightM, nMin, nMax, eMin, eMax,
      surfaceClasses: o.surfaceClasses || SURFACE,
      inside: (n, e) => n >= nMin && n <= nMax && e >= eMin && e <= eMax,
    };

    /* The query. Bilinear height plus the two gradients, from one cell's four
       posts: four array reads, no allocation, no branches past the clamp. At
       400 Hz with ten contact points that is 4,000 calls a second, so it fills
       a caller-owned object instead of returning a new one.

       `out` gets: up, dn = d(up)/d(north), de = d(up)/d(east), the NED unit
       normal (nN, nE, nD; it points up, so nD is negative), and cls.
       Outside the grid the edge posts are held, so the ground stays flat and
       finite rather than falling to zero at the boundary. */
    T.probe = function (n, e, out) {
      let fc = (e - T.e0) / cell;
      let fr = (T.n0 - n) / cell;
      if (fc < 0) fc = 0; else if (fc > cols - 1) fc = cols - 1;
      if (fr < 0) fr = 0; else if (fr > rows - 1) fr = rows - 1;
      let c = fc | 0, r = fr | 0;
      if (c > cols - 2) c = cols - 2;
      if (r > rows - 2) r = rows - 2;
      const tx = fc - c, ty = fr - r;
      const i0 = r * cols + c, i1 = i0 + cols;
      const h00 = up[i0], h10 = up[i0 + 1], h01 = up[i1], h11 = up[i1 + 1];

      const a = 1 - tx, b = 1 - ty;
      out.up = h00 * a * b + h10 * tx * b + h01 * a * ty + h11 * tx * ty;
      // d/d(tx) and d/d(ty), then into metres: tx grows east, ty grows south
      const dE = ((h10 - h00) * b + (h11 - h01) * ty) / cell;
      const dN = -((h01 - h00) * a + (h11 - h10) * tx) / cell;
      out.de = dE; out.dn = dN;
      // NED normal of up = f(n, e) is (-df/dn, -df/de, -1), normalised
      const L = Math.sqrt(dN * dN + dE * dE + 1);
      out.nN = -dN / L; out.nE = -dE / L; out.nD = -1 / L;
      out.cls = cls ? cls[(Math.round(fr) * cols + Math.round(fc)) | 0] : 0;
      return out;
    };

    /* Height only. Same maths without the gradients, for the callers that
       just want the ground under a point. */
    T.heightAt = function (n, e) {
      let fc = (e - T.e0) / cell;
      let fr = (T.n0 - n) / cell;
      if (fc < 0) fc = 0; else if (fc > cols - 1) fc = cols - 1;
      if (fr < 0) fr = 0; else if (fr > rows - 1) fr = rows - 1;
      let c = fc | 0, r = fr | 0;
      if (c > cols - 2) c = cols - 2;
      if (r > rows - 2) r = rows - 2;
      const tx = fc - c, ty = fr - r;
      const i0 = r * cols + c, i1 = i0 + cols;
      const a = 1 - tx, b = 1 - ty;
      return up[i0] * a * b + up[i0 + 1] * tx * b + up[i1] * a * ty + up[i1 + 1] * tx * ty;
    };

    T.classAt = function (n, e) {
      if (!cls) return 0;
      const c = clamp(Math.round((e - T.e0) / cell), 0, cols - 1);
      const r = clamp(Math.round((T.n0 - n) / cell), 0, rows - 1);
      return cls[r * cols + c];
    };

    T.reflAt = function (n, e) { return (T.surfaceClasses[T.classAt(n, e)] || SURFACE[0]).refl; };

    /* Highest post in a rectangle, for the chunk LOD and for a cheap
       "could anything in here be in the way" test. */
    T.maxUpIn = function (cLo, rLo, cHi, rHi) {
      cLo = clamp(cLo, 0, cols - 1); cHi = clamp(cHi, 0, cols - 1);
      rLo = clamp(rLo, 0, rows - 1); rHi = clamp(rHi, 0, rows - 1);
      let m = -Infinity;
      for (let r = rLo; r <= rHi; r++) {
        const row = r * cols;
        for (let c = cLo; c <= cHi; c++) { const v = up[row + c]; if (v > m) m = v; }
      }
      return m;
    };

    /* ---------- rays ----------
       March a straight segment and find where it first goes under the ground.
       Used by the downward lidar and by the radio's line of sight; both want
       the first hit, and the radio also wants how close it came.

       Step is half a cell, so no single cell is stepped over, capped at
       `maxSteps` samples for a long ray (a 2 km shot across a 4 m map is 1,024
       steps at half a cell, which is the cap). A crossing is then bisected
       four times, to about 1/16 of a step.

       `minGap` is the closest the ray came to the ground and `minGapT` is where
       along it that happened; the radio's knife-edge diffraction needs both,
       because a shot that clears a ridge by 10 m is not the same link as one
       that clears it by 200. */
    T.ray = function (aN, aE, aUp, bN, bE, bUp, out, maxSteps) {
      out = out || {};
      const dN = bN - aN, dE = bE - aE, dUp = bUp - aUp;
      const len = Math.hypot(dN, dE, dUp);
      const steps = Math.max(2, Math.min(maxSteps || 1024, Math.ceil((2 * Math.hypot(dN, dE)) / cell) + 2));
      let prevT = 0, prevGap = aUp - T.heightAt(aN, aE);
      out.hit = false; out.t = 1; out.minGap = prevGap; out.minGapT = 0;
      out.n = bN; out.e = bE; out.up = bUp; out.dist = len;
      if (prevGap <= 0) { // started underground: hit at once
        out.hit = true; out.t = 0; out.n = aN; out.e = aE; out.up = aUp; out.dist = 0; out.minGap = prevGap; out.minGapT = 0;
        return out;
      }
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const n = aN + dN * t, e = aE + dE * t;
        const gap = aUp + dUp * t - T.heightAt(n, e);
        if (gap < out.minGap) { out.minGap = gap; out.minGapT = t; }
        if (gap <= 0) {
          let lo = prevT, hi = t, gLo = prevGap;
          for (let k = 0; k < 4; k++) {
            const mid = (lo + hi) / 2;
            const gm = aUp + dUp * mid - T.heightAt(aN + dN * mid, aE + dE * mid);
            if (gm <= 0) hi = mid; else { lo = mid; gLo = gm; }
          }
          void gLo;
          out.hit = true; out.t = hi;
          out.n = aN + dN * hi; out.e = aE + dE * hi; out.up = aUp + dUp * hi;
          out.dist = len * hi;
          out.minGap = 0; out.minGapT = hi;
          return out;
        }
        prevT = t; prevGap = gap;
      }
      return out;
    };

    /* Straight down from a point: the distance to the ground, which is all the
       lidar needs when it is pointing anywhere near vertical. */
    T.downTo = function (n, e, fromUp) { return fromUp - T.heightAt(n, e); };

    /* ---------- chunks ---------- */
    T.chunksX = Math.ceil((cols - 1) / CHUNK);
    T.chunksY = Math.ceil((rows - 1) / CHUNK);
    T.chunkCount = T.chunksX * T.chunksY;

    /* Where a chunk is and how big, in render coords, so app.js can pick a
       level of detail from the camera without touching the heightfield. */
    T.chunkInfo = function (k) {
      const cx = k % T.chunksX, cy = (k / T.chunksX) | 0;
      const c0 = cx * CHUNK, r0 = cy * CHUNK;
      const c1 = Math.min(c0 + CHUNK, cols - 1), r1 = Math.min(r0 + CHUNK, rows - 1);
      const x0 = T.e0 + c0 * cell, x1 = T.e0 + c1 * cell;
      const z0 = r0 * cell - T.n0, z1 = r1 * cell - T.n0;
      const top = T.maxUpIn(c0, r0, c1, r1);
      return {
        k, cx, cy, c0, r0, c1, r1,
        x0, x1, z0, z1,
        cxM: (x0 + x1) / 2, czM: (z0 + z1) / 2, top,
        radius: Math.hypot(x1 - x0, z1 - z0) / 2,
      };
    };

    /* One chunk at one level of detail, as interleaved vertices in the
       renderer's own layout (pos3 nrm3 col3 uv2 = 11 floats, 44 bytes) plus a
       Uint16 index list, in render coords.

       Edges get a skirt: the border ring repeated, dropped straight down, and
       stitched to the border. Where this chunk meets a coarser neighbour the
       two edges do not agree and leave a crack; the skirt fills it with ground
       colour instead of sky. Two triangles per border cell, and at the coarsest
       level that is 32 of the chunk's 128 triangles — the cheapest fix there
       is, and it needs no agreement between neighbours at all. */
    T.chunkMesh = function (k, lod) {
      const s = LODS[clamp(lod, 0, LODS.length - 1)];
      const info = T.chunkInfo(k);
      const { c0, r0, c1, r1 } = info;
      // post indices this chunk uses, on the stride, always including the far edge
      const cIdx = [], rIdx = [];
      for (let c = c0; c < c1; c += s) cIdx.push(c);
      cIdx.push(c1);
      for (let r = r0; r < r1; r += s) rIdx.push(r);
      rIdx.push(r1);
      const nx = cIdx.length, ny = rIdx.length;

      const nVerts = nx * ny + 2 * (nx + ny);
      if (nVerts > 65536) throw new Error(`chunk ${k} lod ${lod} needs ${nVerts} vertices`);
      const V = new Float32Array(nVerts * 11);
      const I = new Uint16Array(((nx - 1) * (ny - 1) * 2 + (nx - 1) * 2 + (ny - 1) * 2) * 3);
      let vi = 0, ii = 0;

      const put = (c, r, yOverride) => {
        const i = r * cols + c;
        const h = up[i];
        // gradients on this level's own stride, so the shading matches the
        // geometry that is actually drawn rather than detail that is not
        const cW = Math.max(0, c - s), cE = Math.min(cols - 1, c + s);
        const rN = Math.max(0, r - s), rS = Math.min(rows - 1, r + s);
        const dE = (up[r * cols + cE] - up[r * cols + cW]) / ((cE - cW) * cell || cell);
        const dN = (up[rN * cols + c] - up[rS * cols + c]) / ((rS - rN) * cell || cell);
        // render normal of y = f(x, z) with x = east, z = south: (-df/de, 1, df/dn)
        const L = Math.sqrt(dE * dE + dN * dN + 1);
        const col = vcolour(cls ? cls[i] : 0, Math.hypot(dE, dN), (h - minUp) / span, T.surfaceClasses);
        const o = vi * 11;
        V[o] = T.e0 + c * cell;
        V[o + 1] = yOverride == null ? h : yOverride;
        V[o + 2] = r * cell - T.n0;
        V[o + 3] = -dE / L; V[o + 4] = 1 / L; V[o + 5] = dN / L;
        V[o + 6] = col[0]; V[o + 7] = col[1]; V[o + 8] = col[2];
        V[o + 9] = c / (cols - 1); V[o + 10] = r / (rows - 1);
        return vi++;
      };

      // the grid
      const grid = new Int32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid[j * nx + i] = put(cIdx[i], rIdx[j]);
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const a = grid[j * nx + i], b = grid[j * nx + i + 1], c = grid[(j + 1) * nx + i + 1], d = grid[(j + 1) * nx + i];
          // split along the shorter diagonal, so a ridge running across a cell
          // stays a ridge instead of being cut flat
          const ha = V[a * 11 + 1], hb = V[b * 11 + 1], hc = V[c * 11 + 1], hd = V[d * 11 + 1];
          if (Math.abs(ha - hc) <= Math.abs(hb - hd)) {
            I[ii++] = a; I[ii++] = d; I[ii++] = c;
            I[ii++] = a; I[ii++] = c; I[ii++] = b;
          } else {
            I[ii++] = a; I[ii++] = d; I[ii++] = b;
            I[ii++] = b; I[ii++] = d; I[ii++] = c;
          }
        }
      }

      // the skirt: each border run repeated `drop` metres lower
      const drop = cell * s * 2;
      const edge = (get, count) => {
        let prevTop = -1, prevBot = -1;
        for (let i = 0; i < count; i++) {
          const [c, r] = get(i);
          const top = grid[get.gi(i)];
          const bot = put(c, r, up[r * cols + c] - drop);
          if (i > 0) { I[ii++] = prevTop; I[ii++] = prevBot; I[ii++] = bot; I[ii++] = prevTop; I[ii++] = bot; I[ii++] = top; }
          prevTop = top; prevBot = bot;
        }
      };
      const north = (i) => [cIdx[i], rIdx[0]]; north.gi = (i) => i;
      const south = (i) => [cIdx[nx - 1 - i], rIdx[ny - 1]]; south.gi = (i) => (ny - 1) * nx + (nx - 1 - i);
      const west = (i) => [cIdx[0], rIdx[ny - 1 - i]]; west.gi = (i) => (ny - 1 - i) * nx;
      const east = (i) => [cIdx[nx - 1], rIdx[i]]; east.gi = (i) => i * nx + (nx - 1);
      edge(north, nx); edge(south, nx); edge(west, ny); edge(east, ny);

      return {
        verts: V.subarray(0, vi * 11),
        idx: I.subarray(0, ii),
        tris: ii / 3,
        lod, k, info,
      };
    };

    return T;
  }

  /* Terrain colour where there is no orthophoto: grass on the flat, rock on
     the steep and the high. It reads better than it sounds, and it means a map
     is worth flying before anyone downloads 600 KB of imagery. */
  function vcolour(cls, slope, upFrac, table) {
    if (cls > 0) return (table[cls] || SURFACE[cls] || SURFACE[0]).col;
    const rockiness = clamp(smoothstep(0.30, 0.75, slope) + 0.45 * upFrac, 0, 1);
    return mixc(SURFACE[1].col, SURFACE[2].col, rockiness);
  }

  /* ---------- the flat ground the built-in field flies over ----------
     Same interface, every answer a constant, so nothing downstream needs to
     ask whether a map is loaded. */
  const FLAT = {
    isFlat: true,
    cols: 2, rows: 2, cell: 1e6, n0: 5e5, e0: -5e5,
    minUp: 0, maxUp: 0, widthM: 1e6, heightM: 1e6,
    nMin: -5e5, nMax: 5e5, eMin: -5e5, eMax: 5e5,
    surfaceClasses: SURFACE,
    chunksX: 0, chunksY: 0, chunkCount: 0,
    inside: () => true,
    probe(n, e, out) { out.up = 0; out.dn = 0; out.de = 0; out.nN = 0; out.nE = 0; out.nD = -1; out.cls = 0; return out; },
    heightAt: () => 0,
    classAt: () => 0,
    reflAt: () => SURFACE[1].refl,
    maxUpIn: () => 0,
    downTo: (n, e, fromUp) => fromUp,
    ray(aN, aE, aUp, bN, bE, bUp, out) {
      out = out || {};
      const len = Math.hypot(bN - aN, bE - aE, bUp - aUp);
      // flat ground at up = 0: the only hit is where the segment crosses it
      if (aUp >= 0 && bUp >= 0) { out.hit = false; out.t = 1; out.minGap = Math.min(aUp, bUp); out.minGapT = aUp <= bUp ? 0 : 1; out.n = bN; out.e = bE; out.up = bUp; out.dist = len; return out; }
      const t = aUp === bUp ? 0 : clamp(aUp / (aUp - bUp), 0, 1);
      out.hit = true; out.t = t; out.minGap = 0; out.minGapT = t;
      out.n = aN + (bN - aN) * t; out.e = aE + (bE - aE) * t; out.up = 0; out.dist = len * t;
      return out;
    },
    chunkInfo() { throw new Error('flat terrain has no chunks'); },
    chunkMesh() { throw new Error('flat terrain has no chunks'); },
  };

  /* ---------- a reusable probe result ----------
     One of these per caller, filled in place. Never shared between the
     physics step and the render pass. */
  const newProbe = () => ({ up: 0, dn: 0, de: 0, nN: 0, nE: 0, nD: -1, cls: 0 });

  /* ---------- the map file ---------- */

  function checkFormat(json) {
    const f = String(json && json.format || '');
    if (!/^flightline-map\/1(\b|$)/.test(f)) {
      throw new Error(`not a version 1 Flightline map (format: ${f || 'missing'})`);
    }
  }

  /* Decode map.json plus its heightfield into a terrain, and normalise
     everything else the sim needs out of the JSON. `heightBuf` is the raw
     bytes of height.u16; `surfaceBuf` the raw bytes of surface.u8, or null. */
  function loadMap(json, heightBuf, surfaceBuf) {
    checkFormat(json);
    const g = json.grid || {};
    const cols = g.cols | 0, rows = g.rows | 0, cell = +g.cell;
    const H = g.heights || {};
    if (H.type && H.type !== 'uint16le') throw new Error(`unsupported height type: ${H.type}`);
    const scale = +H.scale, offset = +H.offset;
    if (!(scale > 0)) throw new Error(`grid.heights.scale must be positive, got ${H.scale}`);

    const raw = heightBuf instanceof Uint16Array ? heightBuf : asUint16(heightBuf);
    if (raw.length !== cols * rows) {
      throw new Error(`height.u16 holds ${raw.length} values, map.json says ${cols}x${rows} = ${cols * rows}`);
    }

    const datum = +((json.origin || {}).datumElevM || 0);
    const up = new Float32Array(cols * rows);
    for (let i = 0; i < up.length; i++) up[i] = raw[i] * scale + offset - datum;

    let cls = null;
    if (surfaceBuf) {
      cls = surfaceBuf instanceof Uint8Array ? surfaceBuf : new Uint8Array(surfaceBuf);
      if (cls.length !== cols * rows) throw new Error(`surface.u8 holds ${cls.length} values, expected ${cols * rows}`);
    }

    const originNE = g.originNE || [((rows - 1) * cell) / 2, -((cols - 1) * cell) / 2];
    const T = fromGrid({
      cols, rows, cell, up, cls,
      n0: originNE[0], e0: originNE[1],
      surfaceClasses: mergeClasses(json.surfaceClasses),
    });

    // the elevation range the file claimed, checked against what it holds
    const gotMin = T.minUp + datum, gotMax = T.maxUp + datum;
    const warn = [];
    if (H.min != null && Math.abs(H.min - gotMin) > Math.max(0.5, scale)) warn.push(`grid.heights.min says ${H.min} m, the heightfield holds ${gotMin.toFixed(1)} m`);
    if (H.max != null && Math.abs(H.max - gotMax) > Math.max(0.5, scale)) warn.push(`grid.heights.max says ${H.max} m, the heightfield holds ${gotMax.toFixed(1)} m`);

    return {
      terrain: T,
      id: json.id || 'map',
      name: json.name || json.id || 'Map',
      region: json.region || '',
      author: json.author || '',
      attribution: json.attribution || '',
      license: json.license || '',
      origin: json.origin || {},
      datumElevM: datum,
      fieldElevM: json.fieldElevM == null ? datum : +json.fieldElevM,
      rangeM: json.rangeM == null ? 1500 : +json.rangeM,
      pilot: fillPoint(json.pilot, T),
      home: fillPoint(json.home, T),
      pads: (json.pads || []).map((p) => ({
        kind: p.kind || 'pad', n: +p.n, e: +p.e, yawDeg: +(p.yawDeg || 0),
        lengthM: +(p.lengthM || 10), widthM: +(p.widthM || 10),
        surface: p.surface || 'asphalt', cls: CLASS_OF[p.surface] == null ? 4 : CLASS_OF[p.surface],
      })),
      starts: (json.starts || []).map((s) => ({
        id: s.id || 'start', name: s.name || s.id || 'Start',
        n: +s.n, e: +s.e, yawDeg: +(s.yawDeg || 0), aglM: +(s.aglM || 0), speedMs: +(s.speedMs || 0),
      })),
      obstacles: json.obstacles || [],
      gates: json.gates || [],
      color: json.color || null,
      warnings: warn,
      json,
    };
  }

  function mergeClasses(over) {
    if (!over) return SURFACE;
    const out = SURFACE.map((s) => ({ ...s }));
    for (const k of Object.keys(over)) {
      const i = /^\d+$/.test(k) ? +k : CLASS_OF[k];
      if (i >= 0 && i < out.length) Object.assign(out[i], over[k]);
    }
    return out;
  }

  function fillPoint(p, T) {
    const n = +((p && p.n) || 0), e = +((p && p.e) || 0);
    return { n, e, up: T.heightAt(n, e), yawDeg: +((p && p.yawDeg) || 0) };
  }

  function asUint16(buf) {
    const b = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (b.byteLength % 2) throw new Error(`height.u16 is ${b.byteLength} bytes, not a whole number of Uint16`);
    return new Uint16Array(b);
  }

  /* ---------- writing ----------
     The builder owns this, but the sim needs it for its own synthetic maps and
     the tests need it to check the round trip. */
  function encodeHeights(elev, opts) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < elev.length; i++) { const v = elev[i]; if (v < min) min = v; if (v > max) max = v; }
    if (!isFinite(min)) throw new Error('heightfield holds no finite values');
    const scale = (opts && opts.scale) || (max - min) / 65535 || 1e-6;
    const offset = (opts && opts.offset != null) ? opts.offset : min;
    const out = new Uint16Array(elev.length);
    for (let i = 0; i < elev.length; i++) out[i] = clamp(Math.round((elev[i] - offset) / scale), 0, 65535);
    return { values: out, scale, offset, min, max };
  }

  return {
    SURFACE, CLASS_OF, CHUNK, LODS,
    fromGrid, loadMap, encodeHeights, checkFormat, newProbe,
    FLAT,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TERRAIN;
