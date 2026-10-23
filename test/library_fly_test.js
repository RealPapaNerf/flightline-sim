/* Every aircraft in aircraft/ actually flies. Run: node test/library_fly_test.js [file]

   test/aircraft_test.js proves a file round-trips through the validator. That
   is not the same as proving the machine in it works, and for a long time it
   was not: files exported from Whirligig sat on the pad with a dead rotor, or
   spun on the spot in a hover, or stopped their rotor in mid-air and fell out
   of the sky, and every one of them passed the round trip.

   So this flies them. The checks are the things that are not opinions:

     builds       the file reads and builds without a validator error
     one step     a single step does not put a NaN into the state — an
                  optional field read as a number when it is absent will,
                  and it takes the whole aircraft out on the first frame
     spins up     anything with a driven rotor reaches most of its head
                  speed from the pad, because a rotor that never spools is
                  not a slow aircraft, it is a broken one
     hovers       it is still in the air after fifteen seconds at its own
                  trim, and has not wandered off in heading: a machine with
                  no anti-torque spins, and spinning is the symptom
     pack lives   full throttle draws a current the pack can tell apart from
                  idle. Flightline's pack model is I = Iidle + Imax·cmd³, so
                  a file with Imax 0 never sags, never drains and reports a
                  flight time out of a hat
     stays up     a free rotor is still turning after a dive. The profile
                  power correlation has no business past µ = 0.5 and used to
                  be let run on, which on a free rotor is a loop: more drag,
                  slower head, higher µ, until it stops in level flight

   Numbers are printed either way. Only the failures above exit non-zero. */
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'aircraft');
const DT = 1 / 400, R2D = 180 / Math.PI;
const env = { rho: 1.225, wind: [0, 0, 0], battery: true, crashes: false };
const rpm = (om) => (om * 60) / (2 * Math.PI);
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));

let fails = 0;
const ok = (cond, what, extra) => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};
/* Anything non-finite anywhere in the state. `reset` wipes the state when it
   catches one, so the message is the only evidence left of the frame that
   blew up — which is why it is checked by name here. */
const finite = (s) => {
  const bad = [];
  (function walk(o, p) {
    for (const k in o) {
      const v = o[k], q = `${p}.${k}`;
      if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(q); } else if (Array.isArray(v)) {
        v.forEach((x, i) => { if (typeof x === 'number' && !Number.isFinite(x)) bad.push(`${q}[${i}]`); });
      } else if (v && typeof v === 'object') walk(v, q);
    }
  })(s, 's');
  return bad;
};
function fly(ac, s, ctl, secs, cb) {
  for (let i = 0, n = Math.round(secs / DT); i < n; i++) {
    const c = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    FL.step(s, ac, Object.assign({ armed: true, mode: 'angle', curve: 'normal', thr: 0, a: 0, e: 0, r: 0 }, c), env, DT);
    if (cb) cb(s, i * DT);
  }
}

const PICK = process.argv[2];
const index = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const files = index.aircraft.map((a) => a.file).filter((f) => !PICK || f === PICK);
ok(files.length > 0, `${files.length} aircraft listed in index.json`);

for (const file of files) {
  console.log(`\n======== ${file} ========`);
  const read = ACF.read(fs.readFileSync(path.join(DIR, file), 'utf8'));
  ok(read.ok, `${file}: reads and validates`, read.ok ? '' : read.errors.join('; '));
  if (!read.ok) continue;
  if (read.warnings.length) console.log(`        warnings: ${read.warnings.join('; ')}`);
  const ac = FL.build(read.def), Ro = ac.rotor;
  const kind = read.def.kind;

  // ---- one step must not produce a NaN ----
  {
    const s = FL.makeState();
    FL.reset(s, ac, ac.starts[0]);
    FL.step(s, ac, { armed: true, mode: 'angle', curve: 'normal', thr: 0.5, a: 0, e: 0, r: 0 }, env, DT);
    const bad = finite(s);
    ok(bad.length === 0 && s.crashMsg !== 'Simulation reset (numerical error)',
      `${file}: one step leaves the state finite`, bad.length ? bad.join(', ') : (s.crashMsg || ''));
  }

  const hoverStick = ac.hoverThrCurve ? Math.min(1, ac.hoverThrCurve.normal)
    : kind === 'quad' || kind === 'vtol' ? Math.min(1, ACF.quadBench(ac).hoverThr) : null;

  // ---- a driven rotor has to spool up, and the machine has to stay put ----
  if (Ro) {
    console.log(`        ${ac.mass} kg, ${(2 * Ro.R * 1000).toFixed(0)} mm rotor, ${Ro.drive} drive, ` +
      `design head ${rpm(Ro.om0).toFixed(0)} rpm (tip ${(Ro.om0 * Ro.R).toFixed(0)} m/s), ` +
      `disc loading ${((ac.mass * FL.G) / Ro.A).toFixed(1)} N/m²`);
    const s = FL.makeState();
    FL.reset(s, ac, 'pad');
    let worstYaw = 0;
    fly(ac, s, { thr: hoverStick }, 15, (st, t) => { if (t > 5) worstYaw = Math.max(worstYaw, Math.abs(st.w[2]) * R2D); });
    const N = s.om / Ro.om0, hdg = Math.abs(eul(s).yaw * R2D);
    if (Ro.drive !== 'none') {
      ok(N > 0.9, `${file}: the rotor spools up on the pad`,
        `${(100 * N).toFixed(0)}% of design head speed after 15 s`);
      ok(-s.p[2] > 0.5, `${file}: and it gets off the ground at its own hover trim`,
        `${(-s.p[2]).toFixed(1)} m on ${(100 * hoverStick).toFixed(0)}% stick`);
      /* A machine with nothing to yaw with does not fall over, it rotates —
         so heading, not attitude, is where missing anti-torque shows up. */
      ok(hdg < 60 && worstYaw < 360, `${file}: and it holds a heading while it does`,
        `${hdg.toFixed(0)}° of drift, worst yaw rate ${worstYaw.toFixed(0)}°/s, yaw authority ${s.tele.yawCap.toFixed(1)} N·m`);
    }
  }

  // ---- the pack has to be part of the aircraft ----
  {
    const B = ac.batt;
    const s = FL.makeState();
    FL.reset(s, ac, 'air');
    s.p = [0, 0, -200];
    let peak = 0;
    fly(ac, s, { thr: 1, hold: false }, 6, (st) => { peak = Math.max(peak, st.I); });
    ok(peak > B.Iidle * 2 + 1, `${file}: full throttle draws a current the pack notices`,
      `${peak.toFixed(0)} A peak against ${B.Iidle} A idle, pack rated ${B.Imax} A`);
  }

  // ---- a free rotor has to survive the speed the aircraft can reach ----
  if (Ro && (Ro.drive === 'none' || Ro.vAuto !== undefined)) {
    const s = FL.makeState();
    FL.reset(s, ac, 'air');
    s.p = [0, 0, -600]; s.q = FL.quatFromEuler(0, 0, 0); s.v = [Math.max(12, ac.cruise || 12), 0, 0];
    let Vmax = 0, Nmin = 9;
    const emax = (ac.angle && ac.angle.max) || 45;
    fly(ac, s, (st, t) => ({ thr: 1, hold: true, e: t < 6 ? -25 / emax : 0 }), 40, (st, t) => {
      Vmax = Math.max(Vmax, Math.hypot(st.v[0], st.v[1]));
      if (t > 2) Nmin = Math.min(Nmin, st.om / Ro.om0);
    });
    ok(Nmin > 0.2, `${file}: the free rotor keeps turning through a dive`,
      `${(Vmax * 2.23694).toFixed(0)} mph reached, head never below ${(100 * Nmin).toFixed(0)}%` +
      (s.crashed ? `, CRASHED: ${s.crashMsg}` : ''));
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
