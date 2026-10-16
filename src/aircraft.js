/* =====================================================================
   Flightline aircraft files — format v1, validator and builder (no DOM).

   An aircraft file is JSON and nothing but JSON. It is read with
   JSON.parse and then copied field by field against the tables below:
   every number is range-checked and clamped, every string is trimmed and
   length-capped, and only field names that appear in a table are copied
   at all. Nothing in a file is ever executed, no function or expression
   is evaluated, and because only known names are copied a file cannot
   reach the prototype chain (a "__proto__" key is simply not a field
   name we look for). The worst a bad file can do is fail to load.

   Two ways to describe an aircraft:
     def   the full definition: the same shape as an entry in FL.DEFS,
           SI units (metres, kilograms, radians, newtons). Exact, verbose,
           and what "Export this aircraft" writes.
     spec  a parametric build sheet in the units you read off a bench:
           millimetres, grams, degrees, inches, mΩ. fromSpec() turns it
           into a def with documented formulas. This is what the in-game
           builder edits and what docs/design-an-aircraft-prompt.md asks
           a chat to produce.
   A file may carry either or both. If it carries both, def wins and the
   spec is kept so the builder can reopen it.
   ===================================================================== */
const ACF = (function (FL) {
  'use strict';
  const FORMAT = 1;
  const G = 9.80665, RHO0 = 1.225, D2R = Math.PI / 180, IN = 0.0254;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const round = (x, n) => { const k = Math.pow(10, n || 0); return Math.round(x * k) / k; };

  /* ---------------- field rules ----------------
     n  number, clamped to [min, max]      i  integer, clamped
     b  boolean      s  string (trimmed, control characters removed, capped)
     e  one of a fixed list                v  fixed-length vector of numbers
     o  object with a known field table    a  array of a rule, length capped
     c  colour: three numbers 0…1
     A rule with `dflt` is filled in when missing; `opt: true` is left out
     when missing; anything else is required and its absence is an error. */
  const n = (min, max, dflt) => ({ t: 'n', min, max, dflt });
  const i = (min, max, dflt) => ({ t: 'i', min, max, dflt });
  const b = (dflt) => ({ t: 'b', dflt });
  const s = (max, dflt) => ({ t: 's', max, dflt });
  const e = (vals, dflt) => ({ t: 'e', vals, dflt });
  const v = (len, min, max, dflt) => ({ t: 'v', len, min, max, dflt });
  const o = (f, dflt) => ({ t: 'o', f, dflt });
  const a = (max, r, dflt) => ({ t: 'a', max, r, dflt });
  const c = () => ({ t: 'c', opt: true });
  const opt = (r) => Object.assign({}, r, { opt: true, dflt: undefined });

  const show = (x) => (typeof x === 'number' ? String(x) : Array.isArray(x) ? 'a list' : typeof x === 'object' && x ? 'an object' : JSON.stringify(x));
  const clean = (str, max) => String(str).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

  function check(rule, val, path, out) {
    if (val === undefined || val === null) {
      if (rule.opt) return undefined;
      if (rule.dflt !== undefined) return JSON.parse(JSON.stringify(rule.dflt));
      out.errors.push(`${path} is missing`);
      return undefined;
    }
    switch (rule.t) {
      case 'n': case 'i': {
        if (typeof val !== 'number' || !Number.isFinite(val)) { out.errors.push(`${path}: ${show(val)} is not a number`); return undefined; }
        const x = rule.t === 'i' ? Math.round(val) : val;
        const y = clamp(x, rule.min, rule.max);
        if (y !== x) out.warnings.push(`${path}: ${x} clamped to ${y} (allowed ${rule.min} … ${rule.max})`);
        return y;
      }
      case 'b':
        if (typeof val !== 'boolean') { out.errors.push(`${path}: ${show(val)} is not true or false`); return undefined; }
        return val;
      case 's': {
        if (typeof val !== 'string') { out.errors.push(`${path}: ${show(val)} is not text`); return undefined; }
        const t = clean(val, rule.max);
        if (t.length < String(val).trim().length) out.warnings.push(`${path}: shortened to ${rule.max} characters`);
        return t;
      }
      case 'e':
        if (!rule.vals.includes(val)) { out.errors.push(`${path}: ${show(val)} is not one of ${rule.vals.join(', ')}`); return undefined; }
        return val;
      case 'v': {
        if (!Array.isArray(val) || val.length !== rule.len) { out.errors.push(`${path}: expected a list of ${rule.len} numbers`); return undefined; }
        return val.map((x, k) => check({ t: 'n', min: rule.min, max: rule.max }, x, `${path}[${k}]`, out));
      }
      case 'c': {
        if (!Array.isArray(val) || val.length !== 3) { out.errors.push(`${path}: a colour is three numbers 0…1 (red, green, blue)`); return undefined; }
        return val.map((x, k) => check({ t: 'n', min: 0, max: 1 }, x, `${path}[${k}]`, out));
      }
      case 'a': {
        if (!Array.isArray(val)) { out.errors.push(`${path}: expected a list`); return undefined; }
        if (val.length > rule.max) { out.errors.push(`${path}: ${val.length} entries, at most ${rule.max} allowed`); return undefined; }
        return val.map((x, k) => check(rule.r, x, `${path}[${k}]`, out));
      }
      case 'o': {
        if (typeof val !== 'object' || Array.isArray(val)) { out.errors.push(`${path}: expected an object`); return undefined; }
        const res = {};
        for (const k of Object.keys(rule.f)) {
          const r = check(rule.f[k], Object.prototype.hasOwnProperty.call(val, k) ? val[k] : undefined, path ? `${path}.${k}` : k, out);
          if (r !== undefined) res[k] = r;
        }
        for (const k of Object.keys(val)) if (!Object.prototype.hasOwnProperty.call(rule.f, k)) out.warnings.push(`${path ? path + '.' : ''}${k}: not a field in format v${FORMAT}, ignored`);
        return res;
      }
      default: out.errors.push(`${path}: internal rule error`); return undefined;
    }
  }

  /* ---------------- the definition tables ----------------
     Ranges are deliberately wide: they are there to keep a bad file from
     producing NaNs or a 400-strip model, not to police taste. */
  const FOIL = o({
    a: n(0.5, 7),            // 3-D lift-curve slope for this surface's aspect ratio, per radian
    CL0: n(-1, 1),           // lift coefficient at zero angle of attack (camber)
    CLmax: n(0.2, 2.2), CLmin: n(-2.2, -0.1),
    M: n(5, 80),             // stall blend sharpness; 30 = foam, 40 = clean built-up
    CD0: n(0.003, 0.12),     // section profile drag
    e: n(0.4, 1.1),          // span efficiency for induced drag
    Cm0: n(-0.4, 0.4),       // section pitching moment about the quarter chord
    CN90: n(0.8, 2.5),       // normal-force coefficient of the stalled (flat-plate) surface
  });
  const FLAP = o({
    y0: n(0, 6), y1: n(0, 6), chord: n(0.002, 1),
    a: opt(n(-1, 1)), e: opt(n(-1, 1)), r: opt(n(-1, 1)), f: opt(n(-1, 1)),
    side: opt(e(['mirror', 'both'])),
  });
  const SURFACE = o({
    name: s(24), role: e(['wing', 'tail', 'fin']),
    mirror: opt(b()), vertical: opt(b()),
    n: i(1, 14),
    y0: n(0, 6), y1: n(0.01, 6),
    xLE0: n(-8, 8), xLE1: n(-8, 8), c0: n(0.01, 2.5), c1: n(0.01, 2.5), z0: n(-3, 3),
    dihedral: opt(n(-25, 45)), inc0: opt(n(-15, 15)), inc1: opt(n(-15, 15)), sweepLoad: opt(n(-1, 1)),
    foil: FOIL, flaps: a(6, FLAP, []),
  });
  const POINT = o({
    p: v(3, -8, 8), name: s(24),
    impact: n(0.1, 200), slide: n(0.1, 200),
    prop: opt(b()), foot: opt(b()), rotor: opt(b()), motor: opt(i(0, 7)), strike: opt(n(0, 50)),
  });
  const BATT = o({
    chem: e(['lipo', 'liion']), cells: i(1, 24), mAh: n(50, 100000),
    R: n(0.001, 5), Imax: n(0, 800), Iidle: n(0, 30), Vref: n(1, 120),
    label: s(48),
    cool: opt(v(2, 0, 5)),                       // W/K: still air, and per √(m/s) of airspeed
    cell: opt(o({ d: n(0.005, 0.1), l: n(0.01, 0.3) })), // cylindrical cell size, for the model
    series: opt(i(1, 24)), parallel: opt(i(1, 12)),
  });
  const CONTACT = o({ kW: n(0, 1e6), cW: n(0, 1e5), kB: n(0, 1e6), cB: n(0, 1e5), muRoll: n(0, 2), muLat: n(0, 3), muBody: n(0, 3) });
  const COMMON = {
    id: s(32), name: s(48), blurb: s(400, ''), notes: opt(s(1200)),
    mass: n(0.02, 80), I: v(3, 1e-6, 100),
    body: o({ r: v(3, -8, 8), CdA: v(3, 0, 4), fin: opt(n(0, 1)), finX: opt(n(-8, 8)) }),
    batt: BATT,
    wheels: a(8, o({ p: v(3, -8, 8), steer: opt(b()) }), []),
    points: a(28, POINT),
    contact: CONTACT,
    crash: o({ wheelImpact: n(0.5, 200) }),
    starts: a(4, e(['launch', 'runway', 'air', 'pad'])),
    fpvCam: v(3, -8, 8), camTilt: n(-40, 70, 0), colR: n(0.02, 4),
  };
  const PLANE_LOOK = o({
    top: c(), bottom: c(), side: c(), tip: c(), accent: c(),
    fuse: c(), fuseBottom: c(), canopy: c(), dark: c(), metal: c(),
    blades: opt(i(2, 6)),
  }, {});
  const QUAD_LOOK = o({ front: c(), rear: c(), frame: c(), wrap: c(), blades: opt(i(2, 6)) }, {});
  const PLANE = Object.assign({}, COMMON, {
    kind: e(['wing', 'conventional']),
    staticMargin: opt(n(-0.1, 0.6)),
    surfaces: a(8, SURFACE),
    defl: o({ a: n(0, 1.2), e: n(0, 1.2), r: n(0, 1.2), flapMax: n(0, 1.4), f: opt(n(0, 1.2)) }),
    flexQ: n(0, 1e6, 0), servoRate: n(0.5, 60),
    prop: o({
      r: v(3, -8, 8), T0: n(0, 3000), Vp: n(1, 300), D: n(0.01, 2),
      tau: n(0.005, 2), Tmin: n(-20, 0), torque: n(-1, 1), wash: b(false), eta: opt(n(0, 1)),
    }),
    steerMax: n(0, 1, 0),
    retract: opt(o({ drag: n(0, 0.5), time: n(0.3, 20) })),
    // what the 3-D model needs that the flight model does not: the flight
    // model takes its drag from body.CdA, not from these
    shape: opt(o({ fuseW: n(0.01, 1.5), fuseH: n(0.01, 1.8), wheelR: opt(n(0.004, 0.4)) })),
    trim: o({ a: n(-1, 1, 0), e: n(-1, 1, 0), r: n(-1, 1, 0) }, { a: 0, e: 0, r: 0 }),
    stab: o({ kRoll: n(0, 8), dRoll: n(0, 2), kPitch: n(0, 8), dPitch: n(0, 2), turn: n(0, 3) }),
    look: PLANE_LOOK,
  });
  const ROTARY = {
    pid: o({ roll: v(5, -500, 500), pitch: v(5, -500, 500), yaw: v(5, -500, 500) }),
    angle: o({ max: n(5, 89), k: n(0.5, 30), rate: n(20, 2000) }),
    rates: o({
      roll: o({ c: n(1, 600), m: n(20, 2000), e: n(0, 1) }),
      pitch: o({ c: n(1, 600), m: n(20, 2000), e: n(0, 1) }),
      yaw: o({ c: n(1, 600), m: n(20, 2000), e: n(0, 1) }),
    }),
  };
  const QUAD = Object.assign({}, COMMON, ROTARY, {
    kind: e(['quad']),
    motors: a(8, v(3, -3, 3)),
    motor: o({ Tmax: n(0.05, 600), tau: n(0.005, 1), idle: n(0, 0.3), kQ: n(0.0005, 0.5), Vp: n(1, 200), D: n(0.01, 1.5) }),
    rotorDrag: n(0, 0.2),
    gear: opt(b()), gimbal: opt(b()),
    look: QUAD_LOOK,
  });
  const HELI = Object.assign({}, COMMON, ROTARY, {
    kind: e(['heli']),
    rotor: o({
      R: n(0.05, 2), chord: n(0.005, 0.2), blades: i(2, 8), a: n(2, 8), Cd0: n(0.004, 0.06),
      kInd: n(1, 1.5), CLmax: n(0.4, 1.6), om0: n(20, 3000), J: n(1e-5, 5), Pmax: n(10, 20000),
      govK: n(0, 1), spool: n(0.01, 3), friction: n(0, 0.1),
      h: n(0, 1.5), Kh: n(0, 2000), tauF: n(0.001, 0.5), maxCyc: n(0.02, 0.6), blowback: n(0, 20),
      lt: n(0.05, 3), TtMax: n(0.1, 300), tauT: n(0.002, 0.5), spin: n(-1, 1),
      curves: o({ normal: v(3, -20, 20), '3d': v(3, -20, 20) }),
    }),
    look: opt(QUAD_LOOK),
  });
  const TABLE = { wing: PLANE, conventional: PLANE, quad: QUAD, heli: HELI };
  const MAX_STRIPS = 40; // a plane's whole flying cost is its strips; see docs/aircraft-format.md

  function stripCount(def) {
    let t = 0;
    for (const sf of def.surfaces || []) t += (sf.n || 0) * (!sf.vertical && sf.mirror ? 2 : 1);
    return t;
  }

  /* Validate and clamp one definition. Returns the cleaned definition, or
     null if something was missing or the wrong type. */
  function validateDef(raw, out) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { out.errors.push('aircraft: expected an object'); return null; }
    const kind = raw.kind;
    if (!TABLE[kind]) { out.errors.push(`kind: ${show(kind)} is not one of ${Object.keys(TABLE).join(', ')}`); return null; }
    const def = check(o(TABLE[kind]), raw, '', out);
    if (!def || out.errors.length) return null;
    if (!def.id) { out.errors.push('id is empty'); return null; }
    const safe = def.id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (safe !== def.id) { out.warnings.push(`id: "${def.id}" → "${safe}" (letters, digits, dot, dash, underscore)`); def.id = safe; }
    if (!def.id) { out.errors.push('id has no usable characters'); return null; }
    if (!def.name) def.name = def.id;
    const ns = stripCount(def);
    if (ns > MAX_STRIPS) { out.errors.push(`surfaces add up to ${ns} strips; the limit is ${MAX_STRIPS} (lower each surface's "n")`); return null; }
    if (kind !== 'quad' && kind !== 'heli' && !def.surfaces.some((sf) => sf.role === 'wing')) { out.errors.push('no surface has role "wing"'); return null; }
    if (kind === 'quad' && def.motors.length !== 4) { out.errors.push(`motors: ${def.motors.length} given; the model flies 4`); return null; }
    if (!def.starts.length) def.starts = kind === 'wing' ? ['launch', 'air'] : kind === 'conventional' ? ['runway', 'air'] : ['pad', 'air'];
    return def;
  }

  /* Read a file (text or already-parsed object). Always returns an object:
       { ok, def, spec, meta, errors, warnings } */
  function read(input) {
    const out = { errors: [], warnings: [] };
    let file = input;
    if (typeof input === 'string') {
      if (input.length > 400000) return { ok: false, errors: ['file is larger than 400 kB'], warnings: [] };
      try { file = JSON.parse(input); } catch (err) { return { ok: false, errors: ['not valid JSON: ' + err.message], warnings: [] }; }
    }
    if (!file || typeof file !== 'object' || Array.isArray(file)) return { ok: false, errors: ['expected a JSON object'], warnings: [] };
    // "flightline-aircraft/1", like the map format; a bare number is read too
    const fmt = file.format !== undefined ? file.format : file.flightline;
    let ver = null;
    if (fmt === undefined) { ver = FORMAT; out.warnings.push(`no "format" field; reading it as flightline-aircraft/${FORMAT}`); }
    else if (typeof fmt === 'number' && Number.isFinite(fmt)) ver = fmt;
    else if (typeof fmt === 'string' && /^flightline-aircraft\/\d+$/.test(fmt.trim())) ver = Number(fmt.trim().split('/')[1]);
    else out.errors.push(`format: ${show(fmt)} is not a Flightline aircraft file (expected "flightline-aircraft/${FORMAT}")`);
    if (ver !== null && ver > FORMAT) out.errors.push(`format: this file is version ${ver} and this sim reads version ${FORMAT}`);
    const meta = {
      author: typeof file.author === 'string' ? clean(file.author, 60) : '',
      version: typeof file.version === 'string' ? clean(file.version, 20) : typeof file.version === 'number' ? String(file.version) : '',
      source: typeof file.source === 'string' ? clean(file.source, 200) : '',
    };
    // a file may be { def, spec }, or a bare definition, or spec-only
    const rawDef = file.def && typeof file.def === 'object' && !Array.isArray(file.def) ? file.def : file.kind ? file : null;
    let spec = null;
    if (file.spec && typeof file.spec === 'object' && !Array.isArray(file.spec)) {
      spec = normSpec(file.spec, out);
    }
    let def = null;
    if (rawDef) def = validateDef(rawDef, out);
    else if (spec) def = validateDef(fromSpec(spec), out);
    else out.errors.push('nothing to build: the file has neither a "def" nor a "spec" block');
    if (def) {
      if (spec && spec.name && !file.def) def.name = spec.name;
      if (meta.author && !def.blurb) def.blurb = 'by ' + meta.author;
    }
    return { ok: !!def && !out.errors.length, def, spec, meta, errors: out.errors, warnings: out.warnings };
  }

  /* Write a file. The definition goes through the same tables as an
     import, so anything this writes can be read back. */
  function write(def, meta, spec) {
    const out = { errors: [], warnings: [] };
    const clean2 = validateDef(def, out);
    const file = { format: `flightline-aircraft/${FORMAT}` };
    const m = meta || {};
    if (m.author) file.author = clean(m.author, 60);
    file.version = m.version ? clean(String(m.version), 20) : '1';
    if (m.source) file.source = clean(m.source, 200);
    if (spec) file.spec = normSpec(spec, { errors: [], warnings: [] });
    file.def = clean2 || def;
    return { file, errors: out.errors };
  }
  const text = (def, meta, spec) => JSON.stringify(write(def, meta, spec).file, null, 2) + '\n';

  /* ---------------- the build sheet (spec) ----------------
     One row per number you can read off a bench or a product page.
     `dflt` may be a function of the spec resolved so far, so the rows are
     listed in dependency order; `group` is only for laying out the panel.
     Every default is calibrated against the built-in aircraft — the
     numbers are in docs/aircraft-format.md so you can check them. */
  const f = (k, on, group, label, unit, min, max, step, dflt, help) => ({ k, on, group, label, unit, min, max, step, dflt, help });
  const fe = (k, on, group, label, opts, dflt, help) => ({ k, on, group, label, opts, dflt, help });
  const FIXED = 'fixed', ALL = 'all';
  const SPEC_FIELDS = [
    f('mass', ALL, 'Airframe', 'All-up weight', 'g', 30, 60000, 5, 1000, 'Flying weight with the battery in.'),
    // ---- wing ----
    f('span', FIXED, 'Wing', 'Span', 'mm', 300, 6000, 10, 1500),
    f('rootChord', FIXED, 'Wing', 'Root chord', 'mm', 40, 1200, 5, (p) => Math.round(p.kind === 'wing' ? p.span / 2.5 : p.span / 6.8), 'Default gives aspect ratio 6.8 (the trainer) or 2.5 (a plank).'),
    f('tipChord', FIXED, 'Wing', 'Tip chord', 'mm', 20, 1200, 5, (p) => Math.round(p.kind === 'wing' ? 0.35 * p.rootChord : p.rootChord)),
    f('sweep', FIXED, 'Wing', 'Leading-edge sweep', '°', 0, 45, 1, (p) => (p.kind === 'wing' ? 27 : 0)),
    f('dihedral', FIXED, 'Wing', 'Dihedral', '°', -10, 20, 0.5, (p) => (p.kind === 'wing' ? 0 : 4)),
    f('washout', FIXED, 'Wing', 'Tip washout', '°', 0, 6, 0.5, (p) => (p.kind === 'wing' ? 1.5 : 0), 'Tip set nose-down relative to the root, so the root stalls first.'),
    f('wingZ', FIXED, 'Wing', 'Wing above the CG', 'mm', -250, 400, 5, (p) => (p.kind === 'wing' ? 0 : 100), 'High wing (positive) adds pendulum stability.'),
    fe('airfoil', FIXED, 'Wing', 'Airfoil', [['flat', 'Flat-bottomed'], ['semi', 'Semi-symmetrical'], ['symmetric', 'Symmetrical'], ['reflex', 'Reflexed / plank']], (p) => (p.kind === 'wing' ? 'reflex' : 'flat')),
    fe('build', FIXED, 'Wing', 'Construction', [['foam', 'Foam'], ['builtup', 'Built-up / balsa'], ['composite', 'Composite']], (p) => (p.kind === 'wing' ? 'foam' : 'builtup'), 'Sets surface drag, stall sharpness and wing flex.'),
    f('staticMargin', FIXED, 'Wing', 'Static margin', '%', 2, 25, 0.5, (p) => (p.kind === 'wing' ? 7 : 10), 'How far ahead of the neutral point the CG sits, as a fraction of the mean chord. Under 5% is twitchy, over 15% is sluggish.'),
    // ---- tail ----
    f('tailArm', 'plane', 'Tail', 'Tail arm', 'mm', 100, 3000, 10, (p) => Math.round(0.47 * p.span), 'Wing leading edge to stabiliser leading edge.'),
    f('stabSpan', 'plane', 'Tail', 'Stabiliser span', 'mm', 60, 2000, 5, (p) => Math.round(0.33 * p.span)),
    f('stabChord', 'plane', 'Tail', 'Stabiliser chord', 'mm', 25, 600, 5, (p) => Math.round(0.55 * p.rootChord)),
    f('stabInc', 'plane', 'Tail', 'Stabiliser incidence', '°', -5, 2, 0.5, -1.5),
    f('finHeight', FIXED, 'Tail', 'Fin height', 'mm', 30, 1200, 5, (p) => Math.round((p.kind === 'wing' ? 0.13 : 0.115) * p.span)),
    f('finChord', FIXED, 'Tail', 'Fin chord', 'mm', 25, 800, 5, (p) => Math.round((p.kind === 'wing' ? 0.35 : 0.5) * p.rootChord)),
    // ---- fuselage and gear ----
    f('fuseW', FIXED, 'Fuselage', 'Fuselage width', 'mm', 20, 600, 5, (p) => Math.round((p.kind === 'wing' ? 0.086 : 0.08) * p.span)),
    f('fuseH', FIXED, 'Fuselage', 'Fuselage height', 'mm', 20, 700, 5, (p) => Math.round((p.kind === 'wing' ? 0.069 : 0.093) * p.span)),
    f('noseLen', 'plane', 'Fuselage', 'Nose length', 'mm', 40, 2000, 5, (p) => Math.round(0.25 * p.span), 'Wing leading edge forward to the prop.'),
    fe('gear', FIXED, 'Fuselage', 'Landing gear', [['none', 'None (hand launch)'], ['tricycle', 'Fixed tricycle'], ['taildragger', 'Fixed taildragger'], ['retract', 'Retractable tricycle']], (p) => (p.kind === 'wing' ? 'none' : 'tricycle')),
    // ---- control surfaces ----
    f('ailSpan', FIXED, 'Controls', 'Aileron span', '% of half span', 10, 100, 1, (p) => (p.kind === 'wing' ? 80 : 50), 'Measured inward from the tip.'),
    f('ailChord', FIXED, 'Controls', 'Aileron chord', '% of chord', 8, 50, 1, (p) => (p.kind === 'wing' ? 15 : 22)),
    f('flapSpan', 'plane', 'Controls', 'Flap span', '% of half span', 0, 90, 1, 0, '0 = no flaps. Measured outward from the root; it stops short of the ailerons.'),
    f('flapChord', 'plane', 'Controls', 'Flap chord', '% of chord', 10, 40, 1, 25),
    f('elevChord', 'plane', 'Controls', 'Elevator chord', '% of stab chord', 15, 60, 1, 38),
    f('rudChord', FIXED, 'Controls', 'Rudder chord', '% of fin chord', 15, 60, 1, (p) => (p.kind === 'wing' ? 20 : 45)),
    f('throwA', FIXED, 'Controls', 'Aileron throw', '°', 3, 40, 1, (p) => (p.kind === 'wing' ? 9 : 14)),
    f('throwE', FIXED, 'Controls', 'Elevator throw', '°', 3, 40, 1, (p) => (p.kind === 'wing' ? 12 : 17)),
    f('throwR', FIXED, 'Controls', 'Rudder throw', '°', 0, 40, 1, (p) => (p.kind === 'wing' ? 0 : 25)),
    f('throwF', 'plane', 'Controls', 'Flap travel', '°', 10, 60, 1, 30, 'Full flap. Takeoff flap is half of it.'),
    // ---- quad airframe ----
    f('propD', ALL, 'Power', 'Prop diameter', 'in', 1.5, 40, 0.1, (p) => (p.kind === 'quad' ? 5 : round((0.16 * p.span) / 25.4, 1)), 'Planes: the default is span/6.3, the ratio both built-in planes use.'),
    f('wheelbase', 'quad', 'Airframe', 'Wheelbase (motor to motor)', 'mm', 60, 2000, 5, (p) => Math.round(44 * p.propD), 'Diagonal, corner to corner. 44 mm per inch of prop fits all four built-in quads.'),
    f('thrustPerMotor', 'quad', 'Power', 'Thrust per motor, full throttle', 'g', 30, 60000, 10, (p) => Math.round(1.25 * p.mass), 'From the motor manufacturer\'s thrust table, at your cell count and prop. The default is 5:1 thrust to weight.'),
    f('camTilt', 'quad', 'Airframe', 'Camera tilt', '°', 0, 60, 1, (p) => (p.propD >= 10 ? 10 : 30)),
    f('rateMax', 'quad', 'Airframe', 'Max rotation rate', '°/s', 100, 1800, 10, (p) => Math.round(clamp(700 * Math.pow(0.127 / (p.propD * IN), 0.9), 200, 900))),
    // ---- power ----
    f('propPitch', ALL, 'Power', 'Prop pitch', 'in', 1, 20, 0.1, (p) => round(0.5 * p.propD, 1)),
    f('blades', ALL, 'Power', 'Blades', '', 2, 4, 1, (p) => (p.kind === 'quad' ? (p.propD < 6 ? 3 : 2) : 2)),
    // ---- battery (before the power numbers that need pack voltage) ----
    fe('cellChem', ALL, 'Battery', 'Chemistry', [['lipo', 'LiPo'], ['liion', 'Li-ion']], 'lipo'),
    f('cellsS', ALL, 'Battery', 'Cells in series', 'S', 1, 14, 1, (p) => (p.kind === 'quad' ? 6 : 3)),
    f('cellsP', ALL, 'Battery', 'Cells in parallel', 'P', 1, 8, 1, 1),
    f('cellmAh', ALL, 'Battery', 'Capacity per parallel string', 'mAh', 100, 30000, 50, (p) => (p.cellChem === 'liion' ? 3000 : p.kind === 'quad' ? 1300 : 2200)),
    f('cellR', ALL, 'Battery', 'Internal resistance per cell', 'mΩ', 1, 200, 0.5, (p) => (p.cellChem === 'liion' ? 25 : 8), 'Li-ion: 25 mΩ for a P28A-class 18650, 13 mΩ for a P50B 21700. A good LiPo is 5–10 mΩ per cell.'),
    f('watts', ALL, 'Power', 'Electrical power, full throttle', 'W', 5, 60000, 5, (p) => (p.kind === 'quad' ? wattsForThrust(p) : Math.round(0.25 * p.mass)),
      'Pack volts × current at full throttle. Planes default to 250 W per kg (the trainer runs 280). Quads work it back from the thrust you entered, by momentum theory — within about 15% of all four built-in quads.'),
    f('thrustStatic', FIXED, 'Power', 'Measured static thrust', 'g', 0, 60000, 10, 0, '0 = work it out from the power with momentum theory. Put your thrust-stand number here if you have one.'),
    f('motorKV', ALL, 'Power', 'Motor KV', 'rpm/V', 50, 20000, 10, (p) => Math.round(90000 / (p.propD * 0.85 * cellsV(p)) / 10) * 10, 'Default keeps prop tip speed roughly constant (90,000 rpm·inch).'),
    f('pitchSpeed', ALL, 'Power', 'Speed where the prop stops pulling', 'm/s', 0, 200, 1, 0, '0 = work it out from KV and pitch. This is the model\'s Vp: thrust falls to zero here at full rpm, so it lands near the full-throttle top speed.'),
  ];
  const cellsV = (p) => (p.cellsS || 3) * (p.cellChem === 'liion' ? 3.7 : 3.8);
  /* The power four motors need for the thrust they are rated at: momentum
     theory backwards, P_shaft = T^1.5 / (FOM·√(2ρA)), and 80% ESC-and-motor
     efficiency on top. Against the built-in quads: 5-inch 2,560 W (rated
     2,740), 7-inch 2,580 (2,660), 4-inch 660 (680), 13-inch 5,400 (7,100). */
  function wattsForThrust(p) {
    const D = p.propD * IN, A = (Math.PI * D * D) / 4, T = (p.thrustPerMotor / 1000) * G;
    return Math.round((4 * Math.pow(T, 1.5)) / (0.55 * Math.sqrt(2 * RHO0 * A)) / 0.8 / 5) * 5;
  }
  const SPEC_KINDS = ['plane', 'wing', 'quad'];
  const wants = (fd, kind) => fd.on === ALL || fd.on === kind || (fd.on === FIXED && kind !== 'quad');

  /* Fill in, clamp and order a build sheet. Unknown keys are reported and dropped. */
  function normSpec(raw, out) {
    out = out || { errors: [], warnings: [] };
    const kind = SPEC_KINDS.includes(raw.kind) ? raw.kind : null;
    if (!kind) { out.errors.push(`spec.kind: ${show(raw.kind)} is not one of ${SPEC_KINDS.join(', ')}`); return null; }
    const sp = { kind };
    if (raw.name !== undefined) sp.name = clean(String(raw.name), 48);
    if (raw.id !== undefined) sp.id = clean(String(raw.id), 32);
    if (raw.blurb !== undefined) sp.blurb = clean(String(raw.blurb), 400);
    if (raw.gimbal !== undefined) sp.gimbal = !!raw.gimbal;
    if (raw.packTop !== undefined) sp.packTop = !!raw.packTop;
    if (raw.quadGear !== undefined) sp.quadGear = !!raw.quadGear;
    for (const fd of SPEC_FIELDS) {
      if (!wants(fd, kind)) continue;
      const have = Object.prototype.hasOwnProperty.call(raw, fd.k) ? raw[fd.k] : undefined;
      if (fd.opts) {
        const vals = fd.opts.map((x) => x[0]);
        if (have !== undefined && !vals.includes(have)) out.warnings.push(`spec.${fd.k}: ${show(have)} is not one of ${vals.join(', ')}; using the default`);
        sp[fd.k] = have !== undefined && vals.includes(have) ? have : (typeof fd.dflt === 'function' ? fd.dflt(sp) : fd.dflt);
      } else if (have === undefined) {
        sp[fd.k] = typeof fd.dflt === 'function' ? fd.dflt(sp) : fd.dflt;
      } else if (typeof have !== 'number' || !Number.isFinite(have)) {
        out.errors.push(`spec.${fd.k}: ${show(have)} is not a number`);
        sp[fd.k] = typeof fd.dflt === 'function' ? fd.dflt(sp) : fd.dflt;
      } else {
        const y = clamp(have, fd.min, fd.max);
        if (y !== have) out.warnings.push(`spec.${fd.k}: ${have} clamped to ${y} (allowed ${fd.min} … ${fd.max})`);
        sp[fd.k] = fd.k === 'blades' || fd.k === 'cellsS' || fd.k === 'cellsP' ? Math.round(y) : y;
      }
    }
    const known = new Set(['kind', 'name', 'id', 'blurb', 'gimbal', 'packTop', 'quadGear'].concat(SPEC_FIELDS.map((x) => x.k)));
    for (const k of Object.keys(raw)) if (!known.has(k)) out.warnings.push(`spec.${k}: not a build-sheet field, ignored`);
    if (sp.tipChord > sp.rootChord * 1.5) out.warnings.push('spec.tipChord: wider than the root — the wing is tapered the wrong way');
    return sp;
  }
  const specDefaults = (kind) => normSpec({ kind }, { errors: [], warnings: [] });

  /* ---------------- spec → definition ----------------
     Formulas and where each one comes from are in docs/aircraft-format.md. */
  // 3-D lift-curve slope from the 2-D slope and the aspect ratio (Helmbold / Diederich form)
  const slopeOf = (AR) => round(5.9 / (1 + 5.9 / (Math.PI * 0.95 * AR)), 3);
  const AIRFOILS = {
    flat: { CL0: 0.25, CLmax: 1.25, CLmin: -0.7, Cm0: -0.06 },
    semi: { CL0: 0.12, CLmax: 1.15, CLmin: -0.9, Cm0: -0.03 },
    symmetric: { CL0: 0, CLmax: 1.1, CLmin: -1.1, Cm0: 0 },
    reflex: { CL0: 0.03, CLmax: 0.95, CLmin: -0.65, Cm0: 0.012 },
  };
  const BUILDS = { foam: { CD0: 1.2, M: 30, CN90: 1.6, flexQ: 1200 }, builtup: { CD0: 1.0, M: 40, CN90: 1.8, flexQ: 0 }, composite: { CD0: 0.9, M: 45, CN90: 1.8, flexQ: 0 } };
  const FOM = { 2: 0.65, 3: 0.6, 4: 0.56 }; // propeller figure of merit: static thrust from shaft power

  function battOf(sp) {
    const chem = sp.cellChem, S = sp.cellsS, P = sp.cellsP;
    const Vref = round(S * (chem === 'liion' ? 3.7 : 3.8), 2);
    const mAh = sp.cellmAh * P;
    const Wh = (Vref * mAh) / 1000;
    const cool = round(0.06 + 0.02 * Math.pow(Wh, 1 / 3), 3);
    const B = {
      chem, cells: S, mAh, R: round((S * sp.cellR) / 1000 / P + 0.003, 4),
      Imax: round(sp.watts / Vref, 1), Iidle: round(0.2 + 0.07 * S, 2), Vref,
      label: `${S}S${P > 1 ? P + 'P' : ''} ${mAh.toLocaleString('en-US')} ${chem === 'liion' ? 'Li-ion' : 'LiPo'}`,
      cool: [cool, round(cool / 2.5, 3)],
    };
    if (chem === 'liion') { // 18650 under ~4 Ah per string, 21700 above
      B.cell = sp.cellmAh > 3600 ? { d: 0.021, l: 0.07 } : { d: 0.0185, l: 0.065 };
      B.series = S; B.parallel = P;
    }
    return B;
  }
  // static thrust (N): measured if given, else momentum theory with a figure of merit
  function thrustOf(sp) {
    if (sp.thrustStatic > 0) return round((sp.thrustStatic / 1000) * G, 2);
    const D = sp.propD * IN, A = (Math.PI * D * D) / 4, Ps = 0.8 * sp.watts;
    return round((FOM[sp.blades] || 0.6) * Math.cbrt(2 * RHO0 * A * Ps * Ps), 2);
  }
  // Vp: pitch speed, 1.5× geometric (a real prop still pulls past its pitch speed; fits both built-in planes)
  const pitchSpeedOf = (sp) => (sp.pitchSpeed > 0 ? sp.pitchSpeed : round(1.5 * ((sp.motorKV * cellsV(sp) * 0.85) / 60) * sp.propPitch * IN, 1));

  function planeDef(sp) {
    const kind = sp.kind === 'wing' ? 'wing' : 'conventional';
    const plank = kind === 'wing';
    const m = sp.mass / 1000, bS = sp.span / 1000, half = bS / 2;
    const c0 = sp.rootChord / 1000, c1 = sp.tipChord / 1000;
    const S = ((c0 + c1) / 2) * bS, AR = (bS * bS) / S, mac = (c0 + c1) / 2;
    const BD = BUILDS[sp.build] || BUILDS.builtup, AF = AIRFOILS[sp.airfoil] || AIRFOILS.flat;
    // cruise Reynolds number (at CL 0.45) sets the profile drag
    const Vc = Math.sqrt((2 * m * G) / (RHO0 * S * 0.45)), Re = (RHO0 * Vc * mac) / 1.81e-5;
    const CD0 = round(clamp(0.012 * Math.pow(2e5 / Re, 0.2) * BD.CD0, 0.009, 0.035), 4);
    const foil = (ar, af) => ({ a: slopeOf(ar), CL0: af.CL0, CLmax: af.CLmax, CLmin: af.CLmin, M: BD.M, CD0, e: plank ? 0.85 : 0.8, Cm0: af.Cm0, CN90: BD.CN90 });
    const tanSw = Math.tan(sp.sweep * D2R);
    const hasFlap = !plank && sp.flapSpan > 0;
    const nW = hasFlap ? 7 : 6;
    // --- wing: leading edge at x = 0, swept tip trailing the root ---
    const ailY0 = round(half * (1 - sp.ailSpan / 100), 4), ailY1 = round(half * 0.98, 4);
    const flaps = [];
    if (plank) flaps.push({ y0: round(half * 0.17, 4), y1: ailY1, chord: round(sp.ailChord / 100 * c1, 4), a: -1, e: -1, side: 'mirror' });
    else {
      flaps.push({ y0: ailY0, y1: ailY1, chord: round((sp.ailChord / 100) * c1, 4), a: -1, side: 'mirror' });
      if (hasFlap) flaps.push({ y0: round(half * 0.05, 4), y1: round(Math.min(sp.flapSpan / 100, 1 - sp.ailSpan / 100 - 0.03) * half, 4), chord: round((sp.flapChord / 100) * c0, 4), f: 1, side: 'both' });
    }
    const surfaces = [{
      name: 'wing', role: 'wing', mirror: true, n: nW,
      y0: 0, y1: round(half, 4), xLE0: 0, xLE1: round(-tanSw * half, 4),
      c0: round(c0, 4), c1: round(c1, 4), z0: round(-sp.wingZ / 1000, 4), dihedral: sp.dihedral,
      inc0: 0, inc1: -sp.washout, sweepLoad: sp.sweep > 1 ? 0.25 : 0,
      foil: foil(AR, AF), flaps,
    }];
    const tailArm = plank ? 0 : sp.tailArm / 1000;
    const stabC = sp.stabChord / 1000, stabHalf = sp.stabSpan / 2000;
    if (!plank) {
      const arH = (sp.stabSpan * sp.stabSpan) / (sp.stabSpan * sp.stabChord);
      surfaces.push({
        name: 'stab', role: 'tail', mirror: true, n: 2,
        y0: 0, y1: round(stabHalf, 4), xLE0: round(-tailArm, 4), xLE1: round(-tailArm, 4),
        c0: round(stabC, 4), c1: round(stabC, 4), z0: 0, dihedral: 0,
        inc0: sp.stabInc, inc1: sp.stabInc, sweepLoad: 0,
        foil: foil(arH, AIRFOILS.symmetric),
        flaps: [{ y0: 0, y1: round(stabHalf, 4), chord: round((sp.elevChord / 100) * stabC, 4), e: -1, side: 'both' }],
      });
    }
    // fin: aspect ratio of a half-surface against the fuselage, 1.6·h²/area
    const finH = sp.finHeight / 1000, finC = sp.finChord / 1000;
    const finX = plank ? round(-0.1 * c0, 4) : round(-(tailArm + 0.02), 4);
    surfaces.push({
      name: 'fin', role: 'fin', vertical: true, n: plank ? 1 : 2,
      y0: 0, y1: round(finH, 4), xLE0: finX, xLE1: round(finX - 0.25 * finC, 4),
      c0: round(finC, 4), c1: round(0.65 * finC, 4), z0: round(-sp.wingZ / 1000 - 0.01, 4),
      foil: foil((1.6 * finH * finH) / (finH * finC), AIRFOILS.symmetric),
      flaps: sp.throwR > 0 && sp.rudChord > 0 ? [{ y0: 0, y1: round(finH, 4), chord: round((sp.rudChord / 100) * finC, 4), r: -1 }] : [],
    });

    const w = sp.fuseW / 1000, h = sp.fuseH / 1000;
    const propD = sp.propD * IN, propR = propD / 2;
    const noseLen = plank ? round(1.15 * c0, 4) : sp.noseLen / 1000;
    const tailLen = plank ? c0 + 0.03 : tailArm + stabC;
    const Lt = noseLen + tailLen;
    const gearKind = plank ? 'none' : sp.gear;
    const fixedGear = gearKind === 'tricycle' || gearKind === 'taildragger';
    const gearDrag = round(0.0015 * Math.pow(bS / 1.5, 2), 5);
    const defl = {
      a: round(sp.throwA * D2R, 4), e: round(sp.throwE * D2R, 4), r: round(sp.throwR * D2R, 4),
      flapMax: round((plank ? sp.throwA + sp.throwE : 1.15 * Math.max(sp.throwA, sp.throwE, sp.throwR, hasFlap ? sp.throwF : 0)) * D2R, 4),
    };
    if (hasFlap) defl.f = round(sp.throwF * D2R, 4);
    const T0 = thrustOf(sp);
    const def = {
      id: sp.id || 'custom', name: sp.name || 'Custom aircraft', blurb: sp.blurb || '',
      kind, mass: round(m, 4),
      I: [round((plank ? 0.17 : 0.1) * m * half * half, 6), round((plank ? 0.4 : 0.18) * m * (Lt / 2) * (Lt / 2), 6), 0],
      staticMargin: round(sp.staticMargin / 100, 4),
      surfaces,
      body: {
        r: [round(0.02 * bS, 4), 0, round(0.01 * bS, 4)],
        CdA: [round(0.3 * w * h + (fixedGear ? gearDrag : 0), 5), round(0.28 * Lt * h, 5), round(0.34 * Lt * w, 5)],
      },
      defl,
      flexQ: BD.flexQ, servoRate: 8,
      shape: { fuseW: round(w, 4), fuseH: round(h, 4), wheelR: round(0.035 * Math.pow(bS / 1.5, 0.8), 4) },
      prop: {
        r: [plank ? round(-1.15 * c0, 4) : round(noseLen, 4), 0, 0],
        T0, Vp: pitchSpeedOf(sp), D: round(propD, 4),
        tau: round(clamp(0.02 + 0.25 * propD, 0.03, 0.5), 3),
        Tmin: round(-0.04 * T0, 3), torque: -0.06, wash: !plank, eta: 0.5,
      },
      batt: battOf(sp),
      steerMax: gearKind === 'none' ? 0 : gearKind === 'taildragger' ? 0.35 : 0.3,
      wheels: [], points: [],
      contact: { kW: round(1900 * m), cW: round(27 * m, 1), kB: round(2400 * m + 300), cB: round(32 * m, 1), muRoll: 0.05, muLat: 0.9, muBody: gearKind === 'none' ? 0.45 : 0.6 },
      crash: { wheelImpact: gearKind === 'none' ? 99 : 4.5 },
      starts: gearKind === 'none' ? ['launch', 'air'] : ['runway', 'air'],
      trim: { a: 0, e: 0, r: 0 },
      stab: {
        kRoll: round(clamp(1.0 + 0.55 * bS, 1, 3), 2), dRoll: round(0.08 * bS, 3),
        kPitch: round(clamp(1.0 + 0.27 * bS, 1, 2.5), 2), dPitch: round(0.067 * bS, 3), turn: round(clamp(0.3 + 0.2 * bS, 0.3, 1), 2),
      },
      fpvCam: [0, 0, 0], camTilt: 0, colR: round(0.37 * bS, 3),
      look: {},
    };
    def.I[2] = round(0.9 * (def.I[0] + def.I[1]), 6);
    if (gearKind === 'retract') def.retract = { drag: gearDrag, time: 3 };

    // --- contact points, gear and camera, placed around the CG ---
    // build() shifts the whole definition so the CG lands at the origin; do that
    // once here so the gear and the belly can be positioned against the real CG.
    const shift = FL.build(JSON.parse(JSON.stringify(def))).xShift;
    const X = (x) => round(x + shift, 4); // body x (CG at 0) → definition x
    const tipY = round(half * Math.cos(sp.dihedral * D2R), 4), tipZ = round(-sp.wingZ / 1000 - half * Math.sin(sp.dihedral * D2R), 4);
    const tipLE = -tanSw * half;
    const pts = [
      { p: [X(def.prop.r[0] + (plank ? -0.02 : 0.02)), 0, 0], name: plank ? 'prop' : 'nose', prop: true, impact: 2.5, slide: 7 },
      { p: [X(tipLE - 0.5 * c1), -tipY, tipZ], name: 'left wingtip', impact: 2.5, slide: 7 },
      { p: [X(tipLE - 0.5 * c1), tipY, tipZ], name: 'right wingtip', impact: 2.5, slide: 7 },
      { p: [X(-tailLen + 0.02), 0, round(h / 2, 4)], name: plank ? 'trailing edge' : 'tail', impact: 3, slide: 99 },
      { p: [X(finX - 0.5 * finC), 0, round(-sp.wingZ / 1000 - finH, 4)], name: 'fin', impact: 1.5, slide: 2 },
      { p: [X(-0.35 * c0), 0, round(h / 2, 4)], name: 'belly', impact: 3.5, slide: 25 },
      { p: [X(0.15 * c0), 0, round(-sp.wingZ / 1000 - 0.02, 4)], name: 'wing', impact: 1.5, slide: 2 },
    ];
    if (!plank) {
      pts.push({ p: [X(-tailArm - 0.5 * stabC), -round(stabHalf, 4), 0], name: 'stabiliser', impact: 2.5, slide: 9 });
      pts.push({ p: [X(-tailArm - 0.5 * stabC), round(stabHalf, 4), 0], name: 'stabiliser', impact: 2.5, slide: 9 });
    } else {
      pts.push({ p: [X(-0.02), -round(half * 0.5, 4), round(-sp.wingZ / 1000 + 0.012, 4)], name: 'left elevon', impact: 3.5, slide: 25 });
      pts.push({ p: [X(-0.02), round(half * 0.5, 4), round(-sp.wingZ / 1000 + 0.012, 4)], name: 'right elevon', impact: 3.5, slide: 25 });
    }
    def.points = pts;
    if (gearKind !== 'none') {
      const zG = round(propR + 0.03, 4), track = round(0.115 * bS, 4);
      if (gearKind === 'taildragger') {
        def.wheels = [
          { p: [X(0.1 * bS), -track, zG] }, { p: [X(0.1 * bS), track, zG] },
          { p: [X(-tailLen + 0.03), 0, round(0.3 * zG, 4)], steer: true },
        ];
      } else {
        def.wheels = [
          { p: [X(0.21 * bS), 0, zG], steer: true },
          { p: [X(-0.033 * bS), -track, zG] }, { p: [X(-0.033 * bS), track, zG] },
        ];
      }
    }
    def.fpvCam = plank ? [X(0.17 * c0), 0, round(-sp.wingZ / 1000 - 0.005, 4)] : [X(0.8 * noseLen), 0, round(-0.71 * h, 4)];
    const look = {
      top: [1.0, 0.52, 0.12], bottom: [0.16, 0.17, 0.2], side: [0.85, 0.42, 0.1], tip: [0.55, 0.95, 0.25],
      fuse: [0.93, 0.93, 0.91], fuseBottom: [0.12, 0.3, 0.68], canopy: [0.1, 0.16, 0.24], dark: [0.09, 0.09, 0.11], metal: [0.72, 0.74, 0.78],
      accent: [0.05, 0.05, 0.06], blades: sp.blades,
    };
    def.look = look;
    return def;
  }

  function quadDefFromSpec(sp) {
    const m = sp.mass / 1000, D = sp.propD * IN;
    const arm = round(sp.wheelbase / 1000 / (2 * Math.SQRT2), 4); // wheelbase is the diagonal
    const r = arm * Math.SQRT2; // motor distance from the centre
    const Ix = round(0.27 * m * r * r, 6);
    const gear = sp.quadGear !== undefined ? sp.quadGear : sp.propD >= 10;
    const foot = round((gear ? 0.78 : 0.3) * arm, 4);
    const Pr = round(clamp(30 * Math.pow(0.127 / D, 0.7), 4, 60), 1);
    const o = {
      id: sp.id || 'custom', name: sp.name || 'Custom quad', blurb: sp.blurb || '',
      mass: round(m, 4), I: [Ix, round(1.09 * Ix, 6), round(1.8 * Ix, 6)],
      arm, foot, footX: round(0.58 * arm, 4), footY: round(0.42 * arm, 4),
      gear, gimbal: !!sp.gimbal,
      pack: [0, 0, round((sp.packTop === false ? 0.9 : -0.55) * foot, 4)],
      cam: sp.gimbal ? [round(0.73 * arm, 4), 0, round(0.49 * arm, 4)] : [round(0.85 * arm, 4), 0, round(-0.15 * arm, 4)],
      motor: {
        Tmax: round((sp.thrustPerMotor / 1000) * G, 2),
        tau: round(clamp(0.25 * D, 0.02, 0.4), 3), idle: 0.05,
        kQ: round(0.125 * D, 4), Vp: sp.pitchSpeed > 0 ? sp.pitchSpeed : round(clamp(42 - 30 * (D - 0.1), 28, 48), 1),
        D: round(D, 4),
      },
      body: { r: [0, 0, 0], CdA: [round(0.4 * D * D, 5), round(0.47 * D * D, 5), round(1.0 * D * D, 5)] },
      pid: {
        roll: [Pr, round(5.33 * Pr), 0.3, 0.35, round(0.025 * Math.pow(0.127 / D, 0.75), 4)],
        pitch: [Pr, round(5.33 * Pr), 0.3, 0.35, round(0.025 * Math.pow(0.127 / D, 0.75), 4)],
        yaw: [round(0.7 * Pr, 1), round(0.45 * 5.33 * Pr), 0.3, 0.5, 0],
      },
      angle: D >= 0.25 ? { max: 40, k: 4, rate: 200 } : { max: 55, k: 7, rate: 500 },
      rates: {
        roll: { c: 70, m: sp.rateMax, e: 0 }, pitch: { c: 70, m: sp.rateMax, e: 0 },
        yaw: { c: 70, m: round(0.8 * sp.rateMax), e: 0 },
      },
      batt: battOf(sp),
      fpvCam: sp.gimbal ? [round(0.75 * arm, 4), 0, round(0.5 * arm, 4)] : [round(0.88 * arm, 4), 0, round(-0.15 * arm, 4)],
      camTilt: sp.camTilt, colR: round(0.68 * (sp.wheelbase / 1000), 3),
      look: { front: [1.0, 0.45, 0.1], rear: [0.86, 0.88, 0.91], frame: [0.14, 0.14, 0.15], wrap: [0.2, 0.5, 0.8], blades: sp.blades },
    };
    const def = FL.quadDef(o);
    for (const k of ['arm', 'foot', 'footX', 'footY', 'pack', 'cam']) delete def[k];
    return def;
  }
  function fromSpec(spec) {
    const sp = spec && spec.__norm ? spec : normSpec(spec || {}, { errors: [], warnings: [] });
    if (!sp) return null;
    return sp.kind === 'quad' ? quadDefFromSpec(sp) : planeDef(sp);
  }

  /* Bake in the mechanical trim: the elevator a hands-off aircraft flies
     with. V defaults to 1.5× the stall speed. */
  function autoTrim(def, V) {
    if (def.kind === 'quad' || def.kind === 'heli') return def;
    const ac = FL.build(def);
    const Vt = V || 1.5 * FL.stallSpeed(ac).Vs;
    const t = FL.trim(ac, Vt);
    if (t.ok) def.trim = { a: round(t.a, 4), e: round(t.e, 4), r: 0 };
    return def;
  }

  /* ---------------- bench numbers ----------------
     Planes: solved from the model (same call the Flight model tab makes).
     Quads: the pack and thrust equations solved directly, which is what
     the sim does step by step — test/quad_test.js flies it instead and
     agrees to a few per cent. */
  function planeBench(ac, rho) {
    const P = FL.performance(ac, rho);
    const te = (ac.trim && ac.trim.e) || 0;
    let handsOff = null;
    for (let k = 1; k < P.rows.length; k++) {
      const a0 = P.rows[k - 1].e - te, b0 = P.rows[k].e - te;
      if (a0 * b0 <= 0 && a0 !== b0) handsOff = P.rows[k - 1].V + (P.rows[k].V - P.rows[k - 1].V) * (a0 / (a0 - b0));
    }
    const flapped = ac.defl.f ? FL.stallSpeed(ac, rho, { flap: 1 }) : null;
    return {
      S: ac.S, b: ac.b, AR: ac.ARw, mac: ac.mac, SM: ac.SM, strips: ac.strips.length,
      wl: (ac.mass * 1000) / (ac.S * 100),
      Vs: P.stall.Vs, CLmax: P.stall.CLmax, alpha: P.stall.alpha,
      VsFlap: flapped ? flapped.Vs : null, CLmaxFlap: flapped ? flapped.CLmax : null,
      Vmax: P.Vmax, handsOff, rows: P.rows,
    };
  }
  // pack voltage and current at a steady motor command, with the pack's sag
  function packAt(ac, cmd, rho, soc, Tc) {
    const B = ac.batt, R = FL.battR(B, Tc === undefined ? 20 : Tc), ocv = B.cells * FL.cellOCV(B.chem, soc === undefined ? 1 : soc);
    let v = ocv, I = 0;
    for (let k = 0; k < 80; k++) {
      I = B.Iidle + B.Imax * Math.pow(cmd, 3) * (rho / RHO0) * Math.pow(clamp(v / B.Vref, 0, 1.2), 2);
      v = 0.5 * v + 0.5 * (ocv - I * R);
    }
    return { v, I, vcell: v / B.cells, k: Math.pow(clamp(v / B.Vref, 0, 1.2), 2) };
  }
  function quadBench(ac, rho, Tc) {
    rho = rho || RHO0;
    const M = ac.motor, B = ac.batt, W = ac.mass * G;
    // hover: the motor command where four motors carry the weight on a sagging pack
    let cmd = Math.sqrt(W / (4 * M.Tmax));
    for (let k = 0; k < 8; k++) cmd = clamp(Math.sqrt(W / (4 * M.Tmax * (rho / RHO0) * packAt(ac, cmd, rho, 1, Tc).k)), 0, 1);
    const hov = packAt(ac, cmd, rho, 1, Tc);
    const full = packAt(ac, 1, rho, 1, Tc);
    const minutes = (I) => (I > 0 ? ((B.mAh * 0.8) / 1000 / I) * 60 : 0);
    const bench = {
      twFull: (4 * M.Tmax * (rho / RHO0)) / W,          // on the motor rating, no sag
      twSag: (4 * M.Tmax * full.k * (rho / RHO0)) / W,  // what the pack can actually deliver
      hoverThr: (cmd - M.idle) / (1 - M.idle),
      hoverI: hov.I, hoverW: hov.I * hov.v, hoverMin: minutes(hov.I),
      punchI: full.I, punchVcell: full.vcell, punchLoss: 1 - full.k,
      packLimited: full.I > B.Imax * 1.0001 ? false : null,
    };
    // cruise: flown, because the drag balance at a lean angle has no tidy closed form
    const DT = 1 / 400, env = { rho, wind: [0, 0, 0], battery: true, crashes: false, wx: { T: Tc === undefined ? 20 : Tc, lwc: 0, mvd: 0, rain: 0 } };
    const s = FL.makeState();
    FL.reset(s, ac, 'air', Tc === undefined ? 20 : Tc);
    s.p[2] = -60;
    let iz = 0, I = 0, V = 0, nn = 0;
    for (let k = 0, n2 = Math.round(18 / DT); k < n2; k++) {
      const ez = -s.p[2] - 60;
      iz += ez * DT;
      const thr = clamp(bench.hoverThr * 1.25 - 0.03 * ez - 0.01 * iz + 0.02 * s.v[2], 0, 1);
      FL.step(s, ac, { thr, a: 0, e: -0.35, r: 0, armed: true, mode: 'angle', lim: { bank: 55, pitch: 55 } }, env, DT);
      if (s.t > 10) { I += s.I; V += s.tele.V; nn++; }
    }
    bench.cruiseV = nn ? V / nn : 0;
    bench.cruiseI = nn ? I / nn : 0;
    bench.cruiseMin = minutes(bench.cruiseI);
    bench.cruiseKm = (bench.cruiseMin / 60) * bench.cruiseV * 3.6;
    return bench;
  }

  /* A one-line fingerprint of everything the flight model does with a
     definition: geometry, bench numbers and a short flight. Two
     definitions with the same fingerprint fly identically.
     Used by test/aircraft_test.js for the export → import round trip. */
  function fingerprint(def) {
    const ac = FL.build(def);
    const q = (x) => (typeof x === 'number' ? x.toFixed(6) : String(x));
    const parts = [ac.kind, q(ac.mass), ac.I.map(q).join(','), q(ac.S), q(ac.b), q(ac.mac), q(ac.ARw), q(ac.SM), q(ac.xShift), ac.strips.length];
    for (const st of ac.strips) parts.push([st.surf, st.side, q(st.y), q(st.chord), q(st.area), st.r.map(q).join(','), q(st.a), q(st.aS), q(st.load), q(st.tau), st.ka, st.ke, st.kr, st.kf].join(':'));
    if (ac.hoverThr !== undefined) parts.push('hover' + q(ac.hoverThr));
    if (ac.hoverPitch !== undefined) parts.push('coll' + q(ac.hoverPitch));
    const DT = 1 / 400, env = { rho: RHO0, wind: [0, 0, 0], battery: true, crashes: false };
    const s = FL.makeState();
    FL.reset(s, ac, 'air');
    for (let k = 0; k < 1200; k++) {
      const t = k * DT;
      FL.step(s, ac, { thr: 0.55, a: 0.2 * Math.sin(t), e: -0.1 * Math.cos(0.7 * t), r: 0.1, f: t > 1.5 ? 1 : 0, gear: t <= 1.5, armed: true, mode: 'acro' }, env, DT);
    }
    parts.push('fly' + [s.p, s.v, s.q, s.w].map((x) => x.map(q).join(',')).join('|') + '|' + q(s.soc) + '|' + q(s.vb));
    return parts.join(' ');
  }

  return {
    FORMAT, MAX_STRIPS, SPEC_FIELDS, SPEC_KINDS, specDefaults, normSpec, wants, RULES: TABLE,
    read, write, text, validateDef, stripCount,
    fromSpec, autoTrim, planeBench, quadBench, packAt, fingerprint, slopeOf, thrustOf,
  };
// node: require the model; browser: FL is the const the bundle declared before this file
})(typeof module !== 'undefined' && typeof require === 'function' ? require('./physics.js') : FL);
if (typeof module !== 'undefined') module.exports = ACF;
