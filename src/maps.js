/* =====================================================================
   maps.js — getting a map's files into memory.

   Two ways in, because the sim runs in two places that can reach different
   things:

     a URL library    index.json, then the map's folder beside it. Works from
                      the GitHub Pages build; the claude.ai artifact build
                      cannot reach another server at all, so there the picker
                      says so instead of failing in the network tab.
     local files      a folder chosen with a directory picker, or the three or
                      four files selected by hand. Works everywhere, including
                      the artifact and offline at the field.

   Decoding is terrain.js's job; this file only fetches and reads.
   ===================================================================== */
const MAPS = (function () {
  'use strict';

  const LIB_FORMAT = /^flightline-maps\/1(\b|$)/;

  /* Where the public library lives. The sim lists maps from this index.json.
     Overridable so a map library can be served from anywhere static. */
  const DEFAULT_LIBRARY = 'https://realpapanerf.github.io/flightline-maps/';

  /* Can this build reach another server at all? The claude.ai artifact runs
     from a blob or a sandboxed origin with no outbound fetch, so there is no
     point offering a URL library there — the folder picker is the only way in.
     Checked by origin rather than by trying and waiting for a timeout. */
  function canFetchRemote() {
    if (typeof location === 'undefined') return false;
    const p = location.protocol;
    if (p === 'blob:' || p === 'data:') return false;
    // file:// can fetch neither a sibling file nor a URL in most browsers
    if (p === 'file:') return false;
    return true;
  }

  const join = (base, rel) => (/^https?:\/\//i.test(rel) ? rel : base.replace(/\/*$/, '/') + rel.replace(/^\/+/, ''));

  async function getJSON(url, signal) {
    const res = await fetch(url, { signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url.split('/').pop()}: ${res.status} ${res.statusText}`);
    return res.json();
  }
  async function getBuffer(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${url.split('/').pop()}: ${res.status} ${res.statusText}`);
    return res.arrayBuffer();
  }

  /* ---------- a library index ---------- */
  async function fetchLibrary(base, signal) {
    if (!canFetchRemote()) throw new Error('This build cannot reach another server — use "Open a map folder" instead.');
    const url = join(base || DEFAULT_LIBRARY, 'index.json');
    const json = await getJSON(url, signal);
    if (!LIB_FORMAT.test(String(json.format || ''))) {
      throw new Error(`${url} is not a version 1 map library (format: ${json.format || 'missing'})`);
    }
    const maps = (json.maps || []).filter((m) => m && m.id && m.path);
    return { base: (base || DEFAULT_LIBRARY).replace(/\/*$/, '/'), name: json.name || 'Map library', updated: json.updated || '', maps };
  }

  /* ---------- one map, from a library ---------- */
  async function fetchMap(libBase, entry, onProgress, signal) {
    const say = onProgress || (() => {});
    const dir = join(libBase, entry.path);
    say('Reading map.json…');
    const json = await getJSON(join(dir, 'map.json'), signal);
    const g = json.grid || {};
    const hFile = (g.heights && g.heights.file) || 'height.u16';
    say(`Downloading the heightfield (${g.cols}x${g.rows})…`);
    const heights = new Uint16Array(await getBuffer(join(dir, hFile), signal));
    let surface = null;
    if (g.surface && g.surface.file) {
      say('Downloading the surface grid…');
      try { surface = new Uint8Array(await getBuffer(join(dir, g.surface.file), signal)); }
      catch (e) { say(`No surface grid (${e.message}) — carrying on without it.`); }
    }
    let image = null;
    if (json.color && json.color.file) {
      say('Downloading the imagery…');
      try { image = await loadImage(join(dir, json.color.file)); }
      catch (e) { say(`No imagery (${e.message}) — the terrain will be coloured by slope.`); }
    }
    return { json, heights, surface, image, source: dir };
  }

  /* ---------- one map, from local files ----------
     A directory picker hands back every file under the folder with a
     webkitRelativePath; a plain multi-select hands back bare names. Either
     way the files are matched by the names map.json asks for, and the folder
     may be the map itself or a library with the map inside it. */
  async function fromFiles(fileList, onProgress) {
    const say = onProgress || (() => {});
    const files = Array.from(fileList || []);
    if (!files.length) throw new Error('No files chosen.');

    const baseName = (f) => (f.name || '').toLowerCase();
    const relOf = (f) => (f.webkitRelativePath || f.name || '');

    const mapJsons = files.filter((f) => baseName(f) === 'map.json');
    if (!mapJsons.length) {
      const names = files.slice(0, 6).map(baseName).join(', ');
      throw new Error(`No map.json in the chosen folder (saw ${names}${files.length > 6 ? ', …' : ''}).`);
    }
    // shallowest map.json wins, so picking a whole library folder opens its first map
    mapJsons.sort((a, b) => relOf(a).split('/').length - relOf(b).split('/').length);
    const mj = mapJsons[0];
    const dir = relOf(mj).replace(/map\.json$/i, '');
    const sibling = (name) => files.find((f) => relOf(f) === dir + name) || files.find((f) => baseName(f) === name.toLowerCase());

    say('Reading map.json…');
    const json = JSON.parse(await mj.text());
    const g = json.grid || {};
    const hName = (g.heights && g.heights.file) || 'height.u16';
    const hFile = sibling(hName);
    if (!hFile) throw new Error(`map.json asks for ${hName}, which is not in the folder.`);
    say(`Reading the heightfield (${g.cols}x${g.rows})…`);
    const heights = new Uint16Array(await hFile.arrayBuffer());

    let surface = null;
    if (g.surface && g.surface.file) {
      const sf = sibling(g.surface.file);
      if (sf) surface = new Uint8Array(await sf.arrayBuffer());
      else say(`No ${g.surface.file} in the folder — carrying on without it.`);
    }
    let image = null;
    if (json.color && json.color.file) {
      const cf = sibling(json.color.file);
      if (cf) {
        say('Reading the imagery…');
        const url = URL.createObjectURL(cf);
        try { image = await loadImage(url); } catch (e) { say(`The imagery would not decode (${e.message}).`); }
        URL.revokeObjectURL(url);
      } else say(`No ${json.color.file} in the folder — the terrain will be coloured by slope.`);
    }
    const howMany = mapJsons.length > 1 ? ` (${mapJsons.length} maps in that folder; opened the first)` : '';
    return { json, heights, surface, image, source: `local folder${howMany}` };
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('could not decode the image'));
      img.src = url;
    });
  }

  return { DEFAULT_LIBRARY, canFetchRemote, fetchLibrary, fetchMap, fromFiles, loadImage, join };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MAPS;
