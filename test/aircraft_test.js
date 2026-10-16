/* Aircraft file format: export → import round trip, validator, build sheet.
   Run: node test/aircraft_test.js
   Exits non-zero if a round trip changes the flight model or a bad file
   is accepted, so it is safe to run as a check. */
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };
const mph = (v) => (v * 2.23694).toFixed(0);

console.log('========  export → import round trip  ========');
console.log('Every built-in aircraft is exported to a file, read back through the');
console.log('validator and rebuilt. The fingerprint covers geometry, every strip,');
console.log('hover/collective solutions and a 3-second flight with flaps and gear moving.\n');
for (const id of Object.keys(FL.DEFS)) {
  const def = FL.DEFS[id];
  const txt = ACF.text(def, { author: 'Flightline', version: '1' });
  const back = ACF.read(txt);
  const same = back.ok && ACF.fingerprint(def) === ACF.fingerprint(back.def);
  ok(same, `${id.padEnd(8)} ${String(txt.length).padStart(6)} bytes`,
    back.ok ? (same ? '' : 'FINGERPRINT DIFFERS') : 'errors: ' + back.errors.join('; '));
  if (back.warnings.length) console.log('        warnings: ' + back.warnings.join('; '));
}

console.log('\n========  the validator  ========');
const bad = [
  ['not JSON at all', 'hello {', /valid JSON/],
  ['no kind', '{"format":"flightline-aircraft/1","def":{"id":"x"}}', /kind/],
  ['a future format', '{"format":"flightline-aircraft/99","def":{"kind":"quad"}}', /version 99/],
  ['some other product\'s file', '{"format":"acme-plane/1","def":{"kind":"quad"}}', /not a Flightline aircraft file/],
  ['mass is text', JSON.stringify({ format: "flightline-aircraft/1", def: Object.assign({}, FL.DEFS.goblin, { mass: '250 g' }) }), /not a number/],
  ['missing surfaces', JSON.stringify({ format: "flightline-aircraft/1", def: { kind: 'wing', id: 'x', name: 'x' } }), /surfaces is missing/],
  ['too many strips', (() => { const d = JSON.parse(JSON.stringify(FL.DEFS.trainer)); for (const sf of d.surfaces) sf.n = 14; return JSON.stringify({ format: "flightline-aircraft/1", def: d }); })(), /strips/],
  ['empty spec kind', '{"format":"flightline-aircraft/1","spec":{"kind":"ornithopter"}}', /not one of/],
];
for (const [what, text, want] of bad) {
  const r = ACF.read(text);
  ok(!r.ok && r.errors.some((e) => want.test(e)), `rejected: ${what}`, r.errors[0] || 'ACCEPTED IT');
}
{ // clamping, and ignoring what it does not know
  const raw = JSON.parse(JSON.stringify(FL.DEFS.goblin));
  raw.mass = 500; raw.I = [0.0035, 0.003, 0.0062]; raw.surfaces[0].foil.CLmax = 9;
  raw.evilPlan = 'rm -rf'; raw.__proto__x = 1;
  const r = ACF.read({ format: "flightline-aircraft/1", def: raw });
  ok(r.ok, 'a file with junk fields still loads', r.warnings.length + ' warnings');
  ok(r.def.surfaces[0].foil.CLmax === 2.2, 'CLmax 9 clamped to 2.2');
  ok(r.def.evilPlan === undefined, 'unknown field dropped');
  ok(r.warnings.some((w) => /evilPlan/.test(w)), 'and reported');
}
{ // a prototype-pollution attempt is structurally impossible: only known names are copied
  const r = ACF.read('{"format":"flightline-aircraft/1","def":{"kind":"quad","__proto__":{"polluted":1}}}');
  ok(({}).polluted === undefined, 'no prototype pollution from a "__proto__" key', r.ok ? 'loaded' : 'rejected: ' + r.errors[0]);
}

console.log('\n========  build sheet → definition  ========');
for (const kind of ACF.SPEC_KINDS) {
  const sp = ACF.specDefaults(kind);
  const def = ACF.autoTrim(ACF.fromSpec(sp));
  const v = ACF.read({ flightline: 1, def }); // the older bare-number format marker still reads
  ok(v.ok, `default ${kind} passes the validator`, v.errors.join('; '));
  if (!v.ok) continue;
  const ac = FL.build(def);
  if (kind === 'quad') {
    const B = ACF.quadBench(ac);
    console.log(`      ${Math.round(ac.mass * 1000)} g, ${ac.batt.label}, ${B.twFull.toFixed(1)}:1 rated (${B.twSag.toFixed(1)}:1 with pack sag), ` +
      `hover ${Math.round(B.hoverThr * 100)}% / ${B.hoverI.toFixed(1)} A / ${B.hoverMin.toFixed(0)} min, punch ${B.punchI.toFixed(0)} A at ${B.punchVcell.toFixed(2)} V/cell, ` +
      `cruise ${(B.cruiseV * 3.6).toFixed(0)} km/h for ${B.cruiseMin.toFixed(0)} min`);
  } else {
    const B = ACF.planeBench(ac);
    console.log(`      ${Math.round(ac.mass * 1000)} g, ${Math.round(ac.b * 1000)} mm, AR ${B.AR.toFixed(1)}, ${B.wl.toFixed(1)} g/dm², SM ${(B.SM * 100).toFixed(1)}%, ` +
      `${B.strips} strips, stall ${B.Vs.toFixed(1)} m/s (${mph(B.Vs)} mph), top ${B.Vmax} m/s (${mph(B.Vmax)} mph), hands-off ${B.handsOff ? mph(B.handsOff) + ' mph' : '—'}`);
  }
  // a spec-only file must rebuild the same aircraft
  const r2 = ACF.read({ format: "flightline-aircraft/1", spec: sp });
  ok(r2.ok && ACF.fingerprint(ACF.fromSpec(sp)) === ACF.fingerprint(r2.def), `spec-only ${kind} file rebuilds the same aircraft`, (r2.errors || []).join('; '));
}

console.log('\n========  how the generator compares with the hand-built trainer  ========');
{
  const sp = ACF.normSpec({
    kind: 'plane', id: 'gen-trainer', name: 'Generated trainer',
    mass: 1300, span: 1500, rootChord: 220, tipChord: 220, dihedral: 4, wingZ: 100,
    airfoil: 'flat', build: 'builtup', staticMargin: 11,
    tailArm: 706, stabSpan: 500, stabChord: 120, finHeight: 170, finChord: 110,
    propD: 10, propPitch: 5, motorKV: 1000, watts: 365, cellChem: 'lipo', cellsS: 3, cellsP: 1, cellmAh: 2200, cellR: 25,
  }, { errors: [], warnings: [] });
  const gen = FL.build(ACF.autoTrim(ACF.fromSpec(sp)));
  const real = FL.build(FL.DEFS.trainer);
  const G = ACF.planeBench(gen), Rl = ACF.planeBench(real);
  const row = (k, g, r, fmt) => console.log(`  ${k.padEnd(26)} generated ${String(fmt(g)).padStart(8)}   hand-built ${String(fmt(r)).padStart(8)}`);
  const f2 = (x) => (x === null ? '—' : x.toFixed(2));
  row('wing area m²', G.S, Rl.S, f2);
  row('aspect ratio', G.AR, Rl.AR, f2);
  row('static margin %', G.SM * 100, Rl.SM * 100, f2);
  row('stall speed mph', G.Vs * 2.23694, Rl.Vs * 2.23694, f2);
  row('CLmax', G.CLmax, Rl.CLmax, f2);
  row('top speed mph', G.Vmax * 2.23694, Rl.Vmax * 2.23694, f2);
  row('hands-off mph', G.handsOff && G.handsOff * 2.23694, Rl.handsOff && Rl.handsOff * 2.23694, f2);
  row('static thrust N', gen.prop.T0, real.prop.T0, f2);
  row('Ixx kg·m²', gen.I[0], real.I[0], (x) => x.toFixed(4));
  row('Iyy kg·m²', gen.I[1], real.I[1], (x) => x.toFixed(4));
  row('body CdA fwd m²', gen.body.CdA[0], real.body.CdA[0], (x) => x.toFixed(4));
  row('pack resistance Ω', gen.batt.R, real.batt.R, (x) => x.toFixed(3));
}

console.log('\n========  and with the hand-built 7-inch quad  ========');
{
  const sp = ACF.normSpec({
    kind: 'quad', id: 'gen-q7', name: 'Generated 7-inch',
    mass: 1050, propD: 7, wheelbase: 305, thrustPerMotor: 1733, blades: 2, camTilt: 20, rateMax: 480,
    cellChem: 'liion', cellsS: 6, cellsP: 2, cellmAh: 3000, cellR: 23, pitchSpeed: 39,
  }, { errors: [], warnings: [] });
  const gen = FL.build(ACF.fromSpec(sp)), real = FL.build(FL.DEFS.q7);
  const G = ACF.quadBench(gen), Rl = ACF.quadBench(real);
  const row = (k, g, r, f0) => console.log(`  ${k.padEnd(26)} generated ${String(f0(g)).padStart(8)}   hand-built ${String(f0(r)).padStart(8)}`);
  const f1 = (x) => x.toFixed(1);
  row('thrust / weight', G.twFull, Rl.twFull, f1);
  row('hover throttle %', G.hoverThr * 100, Rl.hoverThr * 100, (x) => x.toFixed(0));
  row('hover current A', G.hoverI, Rl.hoverI, f1);
  row('hover flight time min', G.hoverMin, Rl.hoverMin, (x) => x.toFixed(0));
  row('punch current A', G.punchI, Rl.punchI, (x) => x.toFixed(0));
  row('punch sag V/cell', G.punchVcell, Rl.punchVcell, (x) => x.toFixed(2));
  row('cruise km/h', G.cruiseV * 3.6, Rl.cruiseV * 3.6, (x) => x.toFixed(0));
  row('cruise range km', G.cruiseKm, Rl.cruiseKm, f1);
  row('full-throttle watts', gen.batt.Imax * gen.batt.Vref, real.batt.Imax * real.batt.Vref, (x) => x.toFixed(0));
  row('roll inertia kg·m²', gen.I[0], real.I[0], (x) => x.toFixed(5));
  row('motor spool lag ms', gen.motor.tau * 1000, real.motor.tau * 1000, (x) => x.toFixed(0));
}

console.log('\n========  flaps and retracts  ========');
{
  const sp = ACF.normSpec({ kind: 'plane', id: 'camtest', name: 'Flap test', mass: 3000, span: 2000, flapSpan: 70, ailSpan: 25, gear: 'retract', watts: 700, cellsS: 4, cellmAh: 5000 }, { errors: [], warnings: [] });
  const def = ACF.autoTrim(ACF.fromSpec(sp));
  const ac = FL.build(def);
  const B = ACF.planeBench(ac);
  ok(ac.strips.filter((s) => s.kf !== 0).length > 0, `${ac.strips.filter((s) => s.kf !== 0).length} strips on the flap channel`);
  ok(!!def.retract, 'retracts in the definition', def.retract ? `+${def.retract.drag} m² CdA down, ${def.retract.time} s transit` : '');
  ok(B.VsFlap < B.Vs, 'flaps lower the stall speed',
    `clean ${B.Vs.toFixed(1)} m/s (${mph(B.Vs)} mph, CLmax ${B.CLmax.toFixed(2)}) → full flap ${B.VsFlap.toFixed(1)} m/s (${mph(B.VsFlap)} mph, CLmax ${B.CLmaxFlap.toFixed(2)})`);
  // how much of the span the flaps cover decides whether they pay: a short flap
  // stalls its own span early without raising the whole wing's peak lift
  console.log('      flap span (% of half span) → 1-g stall at full flap:');
  for (const [fs, ail] of [[30, 50], [45, 50], [60, 35], [70, 25], [85, 12]]) {
    const ac2 = FL.build(ACF.fromSpec(ACF.normSpec({ kind: 'plane', id: 't', mass: 3000, span: 2000, flapSpan: fs, ailSpan: ail, watts: 700, cellsS: 4, cellmAh: 5000 }, { errors: [], warnings: [] })));
    const c0 = FL.stallSpeed(ac2, 1.225), f0 = FL.stallSpeed(ac2, 1.225, { flap: 1 });
    console.log(`        ${String(fs).padStart(2)}% (flapped area ${(ac2.flapArea * 100).toFixed(0)}%): ${c0.Vs.toFixed(2)} → ${f0.Vs.toFixed(2)} m/s  (${((f0.Vs / c0.Vs - 1) * 100).toFixed(1)}%)`);
  }
  // gear drag: the throttle needed for level flight, gear up and gear down
  const rows = (g) => FL.performance(ac, 1.225, { gear: g }).rows;
  const up = rows(0), dn = rows(1);
  const V0 = Math.max(up[0].V, dn[0].V) + 4;
  const tU = up.find((r) => r.V === V0), tD = dn.find((r) => r.V === V0);
  ok(tD.thr > tU.thr, 'gear down costs throttle', `at ${V0} m/s (${mph(V0)} mph): ${Math.round(tU.thr * 100)}% up → ${Math.round(tD.thr * 100)}% down; top speed ${up[up.length - 1].V} m/s up, ${dn[dn.length - 1].V} m/s down`);
}

console.log('\n========  a library of files: the same aircraft twice  ========');
console.log('What the sim uses to load only what is new, and to find the copies');
console.log('an earlier load left behind.\n');
{
  const file = ACF.write(FL.DEFS.q7, { author: 'Flightline', version: '1' }).file;
  const copy = JSON.parse(JSON.stringify(file));
  copy.def.id = 'q7-2'; // what an importer does with an id already taken
  ok(ACF.sameFile(file, copy), 'a copy under another id is the same file');
  ok(ACF.sameFile(file, JSON.stringify(copy)), 'and reads as text as well as an object');
  // field order is whatever wrote the file, and says nothing about the aircraft
  const shuffled = Object.fromEntries(Object.keys(copy).reverse().map((k) => [k, copy[k]]));
  ok(ACF.sameFile(file, shuffled), 'field order does not matter');
  const heavier = JSON.parse(JSON.stringify(copy));
  heavier.def.mass += 0.001; // one gram
  ok(!ACF.sameFile(file, heavier), 'one gram heavier is not the same file');
  const renamed = JSON.parse(JSON.stringify(copy));
  renamed.def.name = 'My 7-inch';
  ok(!ACF.sameFile(file, renamed), 'a different name is not the same file');
  ok(!ACF.sameFile(file, null) && !ACF.sameFile(file, 'not json'), 'nothing is the same as a non-file');

  // a folder loaded three times, with the first copy since removed, plus one
  // aircraft that is merely named with a number on the end
  const lib = { 'q7-2': copy, 'q7-3': JSON.parse(JSON.stringify(copy)), 'q7-4': heavier, 'mark4-10': ACF.write(FL.DEFS.lr4, {}).file };
  const fileOf = (id) => lib[id] || null;
  const dm = ACF.dupMap(Object.keys(lib), fileOf);
  ok(dm.get('q7-3') === 'q7-2', 'the second copy of a file is a copy of the first one in the list');
  ok(!dm.has('q7-2'), 'and the first one is not, even with the original gone');
  ok(!dm.has('q7-4'), 'one gram heavier is its own aircraft, not a copy');
  ok(!dm.has('mark4-10'), 'an id that merely ends in a number is not a copy');
  ok(dm.size === 1, 'so one of those four is a duplicate', [...dm.keys()].join(', ') || 'none');
  // the order of the list decides which copy is kept
  ok(ACF.dupMap(['q7-3', 'q7-2'], fileOf).get('q7-2') === 'q7-3', 'whichever is listed first is the one kept');
  ok(ACF.dupMap(['q7-2'], (id) => (id === 'q7-2' ? 'not json' : null)).size === 0, 'a file that will not read is never a copy');
}

console.log('\n========  the aircraft/ folder  ========');
{
  const dir = path.join(__dirname, '..', 'aircraft');
  let listed = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    listed = idx.aircraft || [];
    ok(Array.isArray(listed), 'index.json lists aircraft', `${listed.length} in the list`);
  } catch (err) { ok(false, 'index.json reads', err.message); }
  const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
  for (const f of onDisk) {
    const r = ACF.read(fs.readFileSync(path.join(dir, f), 'utf8'));
    ok(r.ok, `aircraft/${f}`, r.ok ? `${r.def.name} · ${r.warnings.length} warnings` : r.errors.join('; '));
    if (r.ok && r.def.kind === 'quad') {
      const ac = FL.build(r.def), B = ACF.quadBench(ac);
      console.log(`      ${Math.round(ac.mass * 1000)} g, ${ac.batt.label}, ${B.twFull.toFixed(1)}:1 rated (${B.twSag.toFixed(1)} after sag), hover ${Math.round(B.hoverThr * 100)}% / ${B.hoverI.toFixed(1)} A / ${B.hoverMin.toFixed(0)} min, ` +
        `punch ${B.punchI.toFixed(0)} A at ${B.punchVcell.toFixed(2)} V/cell, cruise ${mph(B.cruiseV)} mph for ${B.cruiseMin.toFixed(0)} min`);
    } else if (r.ok && r.def.kind !== 'heli') {
      const ac = FL.build(r.def), B = ACF.planeBench(ac);
      console.log(`      ${Math.round(ac.mass * 1000)} g, ${Math.round(B.b * 1000)} mm, ${B.wl.toFixed(0)} g/dm², ${B.strips} strips, stall ${mph(B.Vs)} mph` +
        `${B.VsFlap ? ` (${mph(B.VsFlap)} with flap)` : ''}, hands-off ${mph(B.handsOff)} mph, top ${mph(B.Vmax)} mph`);
    }
    ok(listed.some((x) => x.file === f), `aircraft/${f} is in index.json`);
    // the list names each id so the sim can say what is already loaded
    // without fetching every file first
    const entry = listed.find((x) => x.file === f);
    if (r.ok && entry) ok(entry.id === r.def.id, `index.json has the right id for aircraft/${f}`, entry.id ? `${entry.id}${entry.id === r.def.id ? '' : ' \u2260 ' + r.def.id}` : 'missing; the file says ' + r.def.id);
  }
  for (const x of listed) ok(onDisk.includes(x.file), `index.json lists a file that exists: ${x.file}`);
}

console.log(`\n${fails ? fails + ' CHECK(S) FAILED' : 'all checks passed'}`);
process.exit(fails ? 1 : 0);
