/* Training: the file format, the scoring, and every built-in lesson flown.
   Run: node test/tutorial_test.js [courseId]

   The part that matters is the second half. A lesson is a promise that the
   drill can be done, and the only way to keep that promise is to fly it: this
   puts a simple position-holding pilot on the controls of the right aircraft
   and flies every lesson of every built-in course, start to finish, through
   the same TUT.tick() the browser calls. A lesson with a hold that cannot be
   held, a marker out of reach, a facing that fights the task, or a par nobody
   could make, fails here rather than in front of a beginner.

   The pilot is deliberately plain - a PD on position in Angle mode, a PD on
   height, and a yaw loop onto whatever the task is asking the nose to do. It
   is a competent club pilot, not a good one, so the scores it posts are a
   floor: a person flying well should beat them. */
const FL = require('../src/physics.js');
const TUT = require('../src/tutorial.js');

const D2R = Math.PI / 180, R2D = 180 / Math.PI, G = FL.G;
const clamp = FL.clamp;
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

/* ---------------- the file format ---------------- */
console.log('== reading a tutorial file ==');
const GOOD = {
  format: 'flightline-tutorial/1', id: 'mine', name: 'My drills', kinds: ['quad'],
  lessons: [{ id: 'one', name: 'Hover', tasks: [{ kind: 'zone', n: -10, e: 0, up: 2, r: 3, band: 1, hold: 5, par: 15 }] }],
};
{
  const r = TUT.read(JSON.stringify(GOOD));
  ok(r.ok && r.course.lessons.length === 1, 'a well-formed file reads', r.errors.join('; '));
  ok(r.ok && r.course.lessons[0].par === 15, 'a lesson with no par of its own adds up its tasks', r.ok ? `par ${r.course.lessons[0].par} s` : '');
}
ok(!TUT.read('{').ok, 'a file that is not JSON is refused');
ok(!TUT.read('[]').ok, 'a file that is not an object is refused');
ok(!TUT.read(JSON.stringify({ format: 'flightline-aircraft/1', lessons: [] })).ok, 'a file with the wrong format tag is refused');
ok(!TUT.read(JSON.stringify(Object.assign({}, GOOD, { format: 'flightline-tutorial/9' }))).ok, 'a file from a newer version is refused');
ok(!TUT.read(JSON.stringify(Object.assign({}, GOOD, { lessons: [] }))).ok, 'a course with no lessons is refused');
ok(!TUT.read(JSON.stringify(Object.assign({}, GOOD, { lessons: [{ name: 'Empty', tasks: [] }] }))).ok, 'a lesson with no tasks is refused');
{
  const wild = JSON.parse(JSON.stringify(GOOD));
  wild.lessons[0].tasks[0].r = 9999;
  wild.lessons[0].tasks[0].hold = -5;
  wild.lessons[0].tasks[0].mystery = 'hello';
  wild.lessons[0].tasks[0].facing = 'sideways';
  const r = TUT.read(JSON.stringify(wild));
  const t = r.course.lessons[0].tasks[0];
  ok(r.ok && t.r === 500 && t.hold === 0, 'numbers out of range are clamped, not refused', `r ${t.r}, hold ${t.hold}`);
  ok(t.facing === 'any', 'a facing it does not recognise falls back to "any"');
  ok(r.warnings.length >= 4, 'and every one of those changes is reported', `${r.warnings.length} warnings`);
}
{
  const dup = JSON.parse(JSON.stringify(GOOD));
  dup.lessons.push(JSON.parse(JSON.stringify(dup.lessons[0])));
  const r = TUT.read(JSON.stringify(dup));
  ok(r.ok && r.course.lessons[1].id !== r.course.lessons[0].id, 'two lessons cannot share an id — a best score is kept under it', r.ok ? r.course.lessons.map((l) => l.id).join(', ') : '');
}
{
  // a file cannot reach the prototype chain: only names in the table are copied
  const nasty = JSON.parse(JSON.stringify(GOOD));
  nasty.lessons[0].tasks[0].__proto__x = 1;
  const r = TUT.read(JSON.stringify(nasty).replace('__proto__x', '__proto__'));
  ok(r.ok && !('polluted' in {}), 'a "__proto__" key in a file is simply not a field name we look for');
}

console.log('\n== the score ==');
{
  const L = TUT.read(JSON.stringify(GOOD)).course.lessons[0];
  const perfect = TUT.start(L);
  perfect.done = true; perfect.t = L.par; perfect.marks = [{ id: 0, err: 0, t: 5 }];
  const sc = TUT.score(perfect);
  ok(sc.total === 1000 && sc.medal === 'gold', 'dead centre, inside par, no crashes = 1,000 and gold', `${sc.total}`);

  const slow = TUT.start(L);
  slow.done = true; slow.t = 2 * L.par; slow.marks = [{ id: 0, err: 0, t: 5 }];
  ok(TUT.score(slow).time === 0, 'twice par leaves no time points at all');

  const sloppy = TUT.start(L);
  sloppy.done = true; sloppy.t = L.par; sloppy.marks = [{ id: 0, err: 1, t: 5 }];
  ok(TUT.score(sloppy).precision === 0, 'scraping the edge of every shape leaves no precision points');

  const pranged = TUT.start(L);
  pranged.done = true; pranged.t = L.par; pranged.marks = [{ id: 0, err: 0, t: 5 }]; pranged.crashes = 2;
  ok(TUT.score(pranged).total === 1000 - 2 * TUT.CRASH_COST, 'two crashes cost 240', `${TUT.score(pranged).total}`);

  const quit = TUT.start(L);
  ok(TUT.score(quit).total === 0 && TUT.score(quit).medal === null, 'giving up before the first task scores nothing');
}

/* ---------------- flying it ----------------
   A pilot that can hold a position, hold a height and point the nose. */
function makePilot(ac) {
  const hoverThr = ac.hoverThr || 0.5;
  /* Two numbers the engine-out pilot needs about this particular machine: how
     high to start the flare, which scales with how fast it is coming down, and
     whether the throttle stick is still a collective once the drive is off. On
     a gyrodyne it is not — the stick becomes engine power and the flare is
     flown on pitch alone. */
  /* The speed to glide an engine-out at: about four times the hover induced
     velocity, which lands between 9 and 15 m/s across everything here and is
     near enough to minimum power for a pilot this crude. A helicopter
     autorotated at no airspeed comes straight down and has nothing to flare
     with, which is the single thing this number is here to prevent. */
  const vhov = ac.rotor ? Math.sqrt((ac.mass * G) / (2 * 1.225 * ac.rotor.A)) : 3;
  const glideV = clamp(4 * vhov, 8, 18);
  return {
    iN: 0, iE: 0, iU: 0, ac, hoverThr, step: -1, through: false,
    glideV,
    glideLD: ac.rotor ? measureGlide(ac, glideV) : 6,
    // with no collective the flare is pitch alone, and pitch alone has to be left late
    flareH: ac.thrusters && ac.thrusters.length ? 2.2 : clamp(1.1 * vhov + 3, 4, 9),
    noCollective: !!(ac.thrusters && ac.thrusters.length),
  };
}

/* How far this particular machine goes for every metre it comes down, with the
   rotor drive dead. Measured rather than guessed, because it is the number the
   whole approach is planned on and it is wildly different between a 450 (about
   1.4 to 1) and a tip-driven rotor or a gyrodyne (three times that). Fly it at
   the glide speed off the clock for twenty seconds and read the slope. */
function measureGlide(ac, V) {
  const st = FL.makeState();
  FL.reset(st, ac, 'air');
  st.p = [0, 0, -600]; st.q = FL.quatFromEuler(0, 0, 0); st.v = [V, 0, 0];
  const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: false };
  const DT = 1 / 400;
  for (let i = 0; i < 400 * 20; i++) {
    const vb = FL.mulMtV(FL.quatToMat(st.q), st.v);
    const e = clamp(-0.1 * (V - vb[0]), -0.7, 0.12);
    FL.step(st, ac, { thr: 0, a: 0, e, r: 0, armed: true, hold: true, mode: 'angle', curve: 'normal' }, env, DT);
  }
  return clamp(Math.hypot(st.v[0], st.v[1]) / Math.max(0.3, st.v[2]), 0.6, 8);
}

/* The engine-out pilot. The position-hold pilot below has nothing to hold a
   position with once the rotor drive is dead, so a task with `cut` set gets
   this one instead: collective on the floor to keep the head turning, the nose
   where the glide wants it, one turn onto the target rather than three, and a
   flare at the bottom if there is something to land on. It is the same recipe
   as the autorotation in test/heli_test.js, with a target to aim at.

   It is deliberately mediocre — a fixed glide attitude and a fixed flare
   height, no judgement at all — so a lesson it can finish is one a person can
   finish with room to spare. */
function glideIn(p, snap, w, dt) {
  p.gt = (p.gt || 0) + dt;
  const h = snap.up;
  /* Aim short of the spot, not at it. The flare is not a stop: it is a float,
     and how long a float depends on how flat this machine glides — a 450 carries
     about eight metres past the aim point and a tip-driven rotor half as far
     again. Aiming at the pad lands you beyond it, every time. */
  const short = p.flareH * p.glideLD * 1.4;
  const dn0 = w.n - snap.n, de0 = w.e - snap.e, far = Math.hypot(dn0, de0) || 1;
  const k = w.land ? Math.max(0, 1 - short / far) : 1;
  const dn = dn0 * k, de = de0 * k, dist = Math.hypot(dn, de);
  const brg = Math.atan2(de0, dn0);
  const crs = snap.gs > 2.5 ? Math.atan2(snap.ve, snap.vn) : snap.yaw;
  const flaring = w.land && h < p.flareH;
  const cushion = flaring && (snap.gs < 2.5 || h < 1.2);
  let e, thr;
  if (cushion) { e = 0.03; thr = p.noCollective ? 0 : clamp(0.5 + 0.35 * (-snap.vup - 0.5), 0, 1); }
  else if (flaring) { e = 0.45; thr = p.noCollective ? 0 : 0.2; }
  else {
    /* The glide slope. How much height it takes to reach the target is the
       distance over this machine's glide ratio; anything above that is surplus
       and anything below it is a problem. Surplus goes into a slower, steeper
       glide and a deficit into a faster, flatter one, which is the only range
       control an aircraft with no engine has. */
    const need = dist / p.glideLD;
    const high = clamp((snap.up - w.up) - need, -40, 40);
    const Vt = clamp(p.glideV - 0.22 * high, 0.55 * p.glideV, 1.5 * p.glideV);
    e = clamp(-0.1 * (Vt - snap.gs), -0.7, 0.3);
    thr = 0;
  }
  /* Arriving with height you cannot use is the other way to miss. There is no
     airbrake on any of these and collective does the opposite of what you want —
     it trades rotor for lift and makes you float further — so the only thing
     that loses height without losing the field is to stop going straight at it.
     Weave across the approach until the surplus is gone. A 450 glides about 1.4
     to 1 and never needs this; a tip-driven rotor glides nearly three times
     that and needs it on every approach. */
  const spare = (h - w.up) - dist / p.glideLD;
  const weave = !flaring && spare > 4 && far > 14 ? 0.85 * Math.sin(p.gt * 0.55) : 0;
  // bank onto the target, and stop banking once the flare starts
  const bank = flaring ? clamp(-0.5 * snap.roll, -0.3, 0.3) : clamp(1.3 * wrapPi(brg + weave - crs), -0.7, 0.7);
  if (snap.wow) thr = 0; // a landing is not over until the collective is down
  return {
    thr, a: bank, e, r: clamp(1.0 * wrapPi(brg - snap.yaw), -0.6, 0.6),
    armed: true, hold: true, mode: 'angle', lim: { bank: 35, pitch: 35, tBank: 60, tPitch: 60 },
  };
}
// where the live task wants the aircraft to be, and which way round
function want(run) {
  const t = TUT.taskOf(run);
  if (!t) return null;
  if (t.kind === 'say') return { hold: true };
  return {
    n: t.n, e: t.e, up: t.up, r: t.r,
    facing: t.facing, facingTol: t.facingTol,
    spin: t.spin > 0 && run.spun < t.spin,
    gate: t.kind === 'gate' ? t.yawDeg : null,
    slow: t.kind === 'land' || t.speedMax > 0, land: t.kind === 'land',
    cut: !!t.cut,
  };
}

/* A gate is the one target you must not stop at. Line up on a point short of
   it, and once you have reached that, aim at a point well beyond, so you go
   through square rather than hovering in the middle of it. The switch is
   sticky — a gate you are lined up on stays lined up on. */
function aimAt(p, w, snap) {
  if (w.gate === null || w.gate === undefined) return [w.n, w.e];
  const c = Math.cos(w.gate * D2R), s = Math.sin(w.gate * D2R);
  const an = w.n - 16 * c, ae = w.e - 16 * s;
  if (!p.through && Math.hypot(an - snap.n, ae - snap.e) < 8) p.through = true;
  return p.through ? [w.n + 14 * c, w.e + 14 * s] : [an, ae];
}
function fly(p, snap, w, dt) {
  const ac = p.ac;
  if (!w || w.hold) return { thr: p.hoverThr, a: 0, e: 0, r: 0, armed: true, mode: 'angle', lim: { bank: 35, pitch: 35, tBank: 60, tPitch: 60 } };
  if (w.cut) return glideIn(p, snap, w, dt);
  // horizontal: velocity demand toward the target, then a lean that produces it
  const [tn, te] = aimAt(p, w, snap);
  const dn = tn - snap.n, de = te - snap.e, dist = Math.hypot(dn, de);
  const cap = w.slow ? 4 : 14;
  const sp = Math.min(cap, 0.85 * dist);
  const vtN = dist > 0.05 ? (dn / dist) * sp : 0, vtE = dist > 0.05 ? (de / dist) * sp : 0;
  p.iN = clamp(p.iN + (vtN - snap.vn) * dt, -4, 4);
  p.iE = clamp(p.iE + (vtE - snap.ve) * dt, -4, 4);
  const aN = 1.9 * (vtN - snap.vn) + 0.5 * p.iN, aE = 1.9 * (vtE - snap.ve) + 0.5 * p.iE;
  const c = Math.cos(snap.yaw), s = Math.sin(snap.yaw);
  const aF = aN * c + aE * s, aR = -aN * s + aE * c;
  const pitch = -Math.atan2(clamp(aF, -6, 6), G), roll = Math.atan2(clamp(aR, -6, 6), G);
  /* Height: a velocity demand, then throttle around the hover setting. A
     landing is the one case where holding the demand would never finish —
     the wheels touch before the centre of gravity reaches the pad — so once
     it is lined up it commits to a steady descent and cuts the throttle the
     moment the feet are on. */
  const dup = w.up - snap.up;
  const committed = w.land && Math.hypot(w.n - snap.n, w.e - snap.e) < w.r * 0.8;
  const vtU = committed ? -0.75 : clamp(0.8 * dup, -3, 3);
  p.iU = clamp(p.iU + (vtU - snap.vup) * dt, -3, 3);
  const az = 2.2 * (vtU - snap.vup) + 1.1 * p.iU;
  const tilt = Math.max(0.5, Math.cos(snap.roll) * Math.cos(snap.pitch));
  const Tf = (1 + az / G) / tilt;
  let thr = ac.kind === 'heli'
    ? clamp((ac.hoverThrCurve ? ac.hoverThrCurve.normal : 0.55) + 0.22 * (Tf - 1), 0, 1)
    : clamp((Math.sqrt(Math.max(0, Tf)) * Math.sqrt((ac.mass * G) / (4 * ac.motor.Tmax)) - ac.motor.idle) / (1 - ac.motor.idle), 0, 1);
  if (w.land && snap.wow) thr = 0;
  // nose: wherever the task wants it, else along the way we are going
  let yawWant = null;
  if (w.facing === 'home') yawWant = Math.atan2(-snap.e, -snap.n);
  else if (w.facing === 'away') yawWant = Math.atan2(snap.e, snap.n);
  else if (w.facing === 'course') yawWant = dist > 3 ? Math.atan2(de, dn) : null;
  else if (typeof w.facing === 'number') yawWant = w.facing * D2R;
  // a task that asks for a pirouette gets one: a steady turn, slow enough that
  // the lean it causes does not walk the aircraft out of the circle
  const r = w.spin ? 0.3 : yawWant === null ? 0 : clamp(1.1 * wrapPi(yawWant - snap.yaw), -0.6, 0.6);
  return { thr, a: clamp(roll / (35 * D2R), -1, 1), e: clamp(pitch / (35 * D2R), -1, 1), r, armed: true, mode: 'angle', lim: { bank: 35, pitch: 35, tBank: 60, tPitch: 60 } };
}

const snapOf = (st) => {
  const R = FL.quatToMat(st.q), eu = FL.eulerFromMat(R);
  return {
    n: st.p[0], e: st.p[1], up: -st.p[2],
    vn: st.v[0], ve: st.v[1], vup: -st.v[2],
    gs: Math.hypot(st.v[0], st.v[1]), V: st.tele.V,
    yaw: eu.yaw, pitch: eu.pitch, roll: eu.roll,
    thr: st.lastThr || 0, armed: true, wow: st.wow, held: st.held, crashed: st.crashed,
  };
};

function flyLesson(ac, lesson, limit) {
  const DT = 1 / 400, env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
  const st = FL.makeState();
  FL.reset(st, ac, lesson.start === 'air' ? 'air' : lesson.start === 'any' ? ac.starts[0] : lesson.start);
  // lessons that start in the air start over the pad, not a kilometre downwind
  if (lesson.start === 'air') { st.p[0] = lesson.tasks[0].n; st.p[1] = lesson.tasks[0].e; st.p[2] = -Math.max(20, lesson.tasks[0].up); st.v = [0, 0, 0]; }
  if (st.held) FL.launch(st);
  const p = makePilot(ac);
  const run = TUT.start(lesson);
  let t = 0, crashes = 0;
  while (t < limit && !run.done) {
    if (run.step !== p.step) { p.step = run.step; p.through = false; }
    const snap = snapOf(st);
    const ctl = fly(p, snap, want(run), DT);
    st.lastThr = ctl.thr;
    FL.step(st, ac, ctl, env, DT);
    TUT.tick(run, snapOf(st), DT);
    if (st.crashed) { // the sim auto-resets after a crash; so does the test pilot
      crashes++;
      if (crashes > 3) break;
      FL.reset(st, ac, lesson.start === 'air' ? 'air' : lesson.start === 'any' ? ac.starts[0] : lesson.start);
      if (st.held) FL.launch(st);
      p.iN = p.iE = p.iU = 0;
    }
    t += DT;
  }
  return { run, t, crashes, score: TUT.score(run), end: snapOf(st), note: run.note };
}

console.log('\n== every built-in lesson, flown ==');
const PICK = process.argv[2];
const AC_FOR = { quad: 'q7', heli: 'heli', wing: 'goblin', conventional: 'trainer' };
for (const course of TUT.BUILTIN) {
  if (PICK && course.id !== PICK) continue;
  const kind = course.kinds[0];
  if (kind !== 'quad' && kind !== 'heli') continue; // the plane ladder is flown below, with a plane pilot
  const ac = FL.build(FL.DEFS[AC_FOR[kind]]);
  console.log(`\n-- ${course.name} (${course.id}), on the ${ac.name} --`);
  for (const lesson of course.lessons) {
    const limit = Math.max(120, lesson.par * 3);
    const r = flyLesson(ac, lesson, limit);
    const sc = r.score;
    ok(r.run.done, `${lesson.id}: flown to the end`,
      r.run.done
        ? `${r.t.toFixed(0)} s of a ${lesson.par} s par, ${sc.total}/1000 ${sc.medal || 'no medal'}, mean error ${(sc.err * 100).toFixed(0)}% of the way to the edge${r.crashes ? `, ${r.crashes} crashes` : ''}`
        : `stuck on task ${r.run.step + 1}/${lesson.tasks.length} ("${TUT.sayNow(r.run).say}") after ${r.t.toFixed(0)} s${r.crashes ? `, ${r.crashes} crashes` : ''} — ${r.note || 'no note'}, ended ${r.end.wow ? 'down' : 'flying'} at ${r.end.n.toFixed(0)}, ${r.end.e.toFixed(0)}, ${r.end.up.toFixed(0)} m`);
    if (r.run.done) ok(r.t < 2 * lesson.par, `${lesson.id}: par is reachable`, `${r.t.toFixed(0)} s against a ${lesson.par} s par`);
  }
}

/* The engine-out ladder is one course flown by three very different machines,
   and the differences are the whole point of it: a 450 glides at about 1.4 to
   1, a tip-driven rotor at nearly three times that, and a gyrodyne further
   still. A ladder that only worked on the one it was written for would be a
   ladder that lied about the other two. */
console.log('\n-- the engine-out ladder, on the other rotorcraft --');
{
  const course = TUT.BUILTIN.find((c) => c.id === 'engine-out');
  for (const id of ['tipjet', 'gyrodyne']) {
    const ac = FL.build(FL.DEFS[id]);
    const p0 = makePilot(ac);
    console.log(`\n   ${ac.name}: glides ${p0.glideLD.toFixed(1)} to 1 at ${p0.glideV.toFixed(1)} m/s, flares from ${p0.flareH.toFixed(1)} m${p0.noCollective ? ', and has no collective once the drive is off' : ''}`);
    for (const lesson of course.lessons) {
      const r = flyLesson(ac, lesson, Math.max(120, lesson.par * 3));
      ok(r.run.done, `${id}/${lesson.id}: flown to the end`,
        r.run.done ? `${r.t.toFixed(0)} s of a ${lesson.par} s par, ${r.score.total}/1000 ${r.score.medal || 'no medal'}${r.crashes ? `, ${r.crashes} crashes` : ''}`
          : `stuck on task ${r.run.step + 1}/${lesson.tasks.length} after ${r.t.toFixed(0)} s — ${r.note || 'no note'}, ended ${r.end.wow ? 'down' : 'flying'} at ${r.end.n.toFixed(0)}, ${r.end.e.toFixed(0)}, ${r.end.up.toFixed(0)} m`);
    }
  }
}

/* The autogyro ladder needs a third pilot again. A gyro steers like a plane and
   is held up like a rotorcraft, so it banks onto a marker the way the plane
   pilot does and flies height on the throttle the way nothing else here does —
   and it has to wait for the prerotator before it can go anywhere at all. */
console.log('\n-- the autogyro ladder, on the autogyro --');
function flyGyroLesson(ac, lesson, limit) {
  const DT = 1 / 400, env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
  const lim = { bank: 35, pitch: 30, tBank: 55, tPitch: 45 };
  const st = FL.makeState();
  const first = lesson.tasks.find((t) => t.kind !== 'say') || lesson.tasks[0];
  const begin = () => {
    FL.reset(st, ac, lesson.start === 'air' ? 'air' : 'runway');
    if (lesson.start === 'air') {
      // an air start for something that cannot hover is a cruise, not a hover
      st.p = [first.n - 80, first.e, -Math.max(40, first.up + 25)];
      st.q = FL.quatFromEuler(0, 0, 0);
      st.v = [ac.cruise, 0, 0];
      st.om = ac.rotor.om0;
    }
  };
  begin();
  const run = TUT.start(lesson);
  const prerotOm = ac.rotor.prerot.om;
  let t = 0, crashes = 0, pI = 0, flareT = null;
  while (t < limit && !run.done) {
    const snap = snapOf(st);
    const w = want(run);
    let a = 0, e = 0, thr = 0;
    if (!w || w.hold) {
      // the only thing to do while a `say` task runs is let the head spin up
      thr = st.wow && st.om < prerotOm ? 0 : st.wow ? 0.05 : 0.6;
    } else if (st.wow && st.om < prerotOm) {
      thr = 0; // not going anywhere until the rotor is up
    } else {
      const dn = w.n - snap.n, de = w.e - snap.e, dist = Math.hypot(dn, de);
      const crs = snap.gs > 4 ? Math.atan2(snap.ve, snap.vn) : snap.yaw;
      /* Never ask for a turn tighter than the machine can fly. A gyro at 18 m/s
         turns in about fifty metres, so a pure pursuit at full bank does not
         capture a marker, it orbits one — which is exactly what it did before
         this line existed. Ease the bank off as the marker comes up and fly
         through it. */
      const turnR = Math.max(25, (snap.gs * snap.gs) / (G * Math.tan(35 * D2R)));
      a = clamp(1.4 * wrapPi(Math.atan2(de, dn) - crs) * clamp(dist / (2.2 * turnR), 0.18, 1), -1, 1);
      if (w.cut) {
        /* Engine off. Hold a nose-down glide at the attitude that sinks least,
           and if there is something to land on, flare at two metres — the
           window is about a metre deep and starting early is what loses it. */
        thr = 0;
        if (w.land && snap.up < 2) { if (flareT === null) flareT = t; e = clamp(0.1 + 1.0 * (t - flareT) / 0.9, 0.1, 0.8); a *= 0.2; }
        else e = clamp(-0.3 + 0.03 * (w.up - snap.up), -0.5, -0.1);
      } else {
        const climb = clamp(0.3 * (w.up - snap.up), -3, 3);
        thr = clamp(0.5 + 0.14 * climb, st.wow ? 0.9 : 0.1, 1);
        pI = clamp(pI + (climb - snap.vup) * DT, -8, 8);
        e = clamp(0.1 * (climb - snap.vup) + 0.04 * pI, -0.5, 0.5);
        if (st.wow) e = 0.25; // hold the nose up through the roll
      }
    }
    st.lastThr = thr;
    FL.step(st, ac, { thr, a, e, r: 0, armed: true, hold: !!(w && w.cut), mode: 'angle', lim }, env, DT);
    TUT.tick(run, snapOf(st), DT);
    if (st.crashed) { crashes++; if (crashes > 3) break; begin(); pI = 0; flareT = null; }
    t += DT;
  }
  return { run, t, crashes, score: TUT.score(run), end: snapOf(st), note: run.note };
}
{
  const ac = FL.build(FL.DEFS.gyro);
  const course = TUT.BUILTIN.find((c) => c.id === 'gyro-circuits');
  if (!PICK || PICK === 'gyro-circuits') for (const lesson of course.lessons) {
    const r = flyGyroLesson(ac, lesson, Math.max(220, lesson.par * 3));
    ok(r.run.done, `${lesson.id}: flown to the end`,
      r.run.done ? `${r.t.toFixed(0)} s of a ${lesson.par} s par, ${r.score.total}/1000 ${r.score.medal || 'no medal'}${r.crashes ? `, ${r.crashes} crashes` : ''}`
        : `stuck on task ${r.run.step + 1}/${lesson.tasks.length} ("${TUT.sayNow(r.run).say}") after ${r.t.toFixed(0)} s${r.crashes ? `, ${r.crashes} crashes` : ''} — ${r.note || 'no note'}, ended ${r.end.wow ? 'down' : 'flying'} at ${r.end.n.toFixed(0)}, ${r.end.e.toFixed(0)}, ${r.end.up.toFixed(0)} m`);
  }
}

/* The plane ladder needs a plane pilot - bank and pitch rather than a position
   hold - so it is flown through FL.planeAssist in Stabilised, steering onto
   each marker. Same engine, same scoring. */
console.log('\n-- the plane ladder, on the trainer --');
function flyPlaneLesson(ac, lesson, limit) {
  const DT = 1 / 400, env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
  const lim = { bank: 45, pitch: 30, tBank: 60, tPitch: 45 };
  const Vs = FL.stallSpeed(ac, 1.225).Vs, Vrot = 1.35 * Vs;
  const st = FL.makeState();
  // a lesson that starts in the air starts on the first thing it asks you to
  // fly to, not wherever a reset happens to put you
  const first = lesson.tasks.find((t) => t.kind !== 'say') || lesson.tasks[0];
  const begin = () => {
    FL.reset(st, ac, lesson.start === 'air' ? 'air' : 'runway');
    if (lesson.start === 'air') {
      st.p = [first.n - 90, first.e, -Math.max(40, first.up)];
      st.q = FL.quatFromEuler(0, 0.02, 0);
      st.v = FL.mulMV(FL.quatToMat(st.q), [1.6 * Vs, 0, 0]);
    }
  };
  begin();
  const run = TUT.start(lesson);
  let t = 0, crashes = 0, pI = 0, step = -1, from = null;
  while (t < limit && !run.done) {
    const snap = snapOf(st);
    if (run.step !== step) { step = run.step; pI = 0; from = { n: snap.n, e: snap.e, up: snap.up }; }
    const w = want(run);
    let a = 0, e = 0, thr = 0.75, assist = 'stab';
    if (!w || w.hold) {
      a = 0; e = 0; thr = 0.75;
    } else if (snap.wow && snap.V < Vrot) {
      /* The ground roll. Wings level, full power, and nothing on the elevator
         until it is flying: a trainer dragged off below rotation speed drops a
         wing, and on the runway there is no height to put it back. */
      a = 0; e = 0; thr = 1;
    } else {
      const dn = w.n - snap.n, de = w.e - snap.e, dist = Math.hypot(dn, de);
      const crs = snap.gs > 3 ? Math.atan2(snap.ve, snap.vn) : snap.yaw;
      a = clamp((1.4 * wrapPi(Math.atan2(de, dn) - crs)) / (45 * D2R), -1, 1);
      if (dist < 30) a *= 0.35; // do not wind up over a marker underneath you
      let climb = clamp(0.35 * (w.up - snap.up), -3, 3.5);
      thr = clamp(0.62 + 0.09 * climb, 0.15, 1);
      if (w.land) {
        /* A landing is a straight line in space, not a descent rate: aim down
           a slope from wherever the final began to a foot above the pad, and
           let the elevator hold the slope. A fixed sink rate either runs out
           of runway or arrives high, because how long the strip is and how
           high you turned final are not the same two numbers. */
        const total = Math.hypot(w.n - from.n, w.e - from.e) || 1;
        const frac = clamp(1 - dist / total, 0, 1);
        const slope = from.up * (1 - frac) + 0.4;
        climb = clamp(1.3 * (slope - snap.up), -4.5, 1);
        thr = clamp(0.3 + 0.09 * climb, 0.05, 0.7);
        if (snap.up < 1.5) { climb = -0.3; thr = 0; a *= 0.3; } // hold it off
        if (snap.wow) { thr = 0; climb = 0; }
      }
      // in Stabilised the elevator stick is a pitch angle, nose up positive
      pI = clamp(pI + (climb - snap.vup) * DT, -8, 8);
      e = clamp(0.13 * (climb - snap.vup) + 0.05 * pI, -0.7, 0.7);
      if (snap.V < 1.2 * Vs) e = Math.min(e, 0.05); // never trade the last of the airspeed for height
    }
    const sticks = { a, e, r: 0, thr };
    const ctl = FL.planeAssist(assist, { a, e }, sticks, st, ac, lim);
    ctl.thr = thr; ctl.armed = true;
    st.lastThr = thr;
    FL.step(st, ac, ctl, env, DT);
    TUT.tick(run, snapOf(st), DT);
    if (st.crashed) { crashes++; if (crashes > 3) break; begin(); pI = 0; step = -1; }
    t += DT;
  }
  return { run, t, crashes, score: TUT.score(run) };
}
{
  const ac = FL.build(FL.DEFS.trainer);
  const course = TUT.BUILTIN.find((c) => c.id === 'circuits');
  if (!PICK || PICK === 'circuits') for (const lesson of course.lessons) {
    const r = flyPlaneLesson(ac, lesson, Math.max(220, lesson.par * 3));
    const sc = r.score;
    ok(r.run.done, `${lesson.id}: flown to the end`,
      r.run.done ? `${r.t.toFixed(0)} s of a ${lesson.par} s par, ${sc.total}/1000 ${sc.medal || 'no medal'}${r.crashes ? `, ${r.crashes} crashes` : ''}`
        : `stuck on task ${r.run.step + 1}/${lesson.tasks.length} ("${TUT.sayNow(r.run).say}") after ${r.t.toFixed(0)} s${r.crashes ? `, ${r.crashes} crashes` : ''}`);
  }
}

/* Every marker a lesson draws has to be somewhere a renderer can put it, and
   every lesson has to be flyable by the aircraft its course claims. */
console.log('\n== the courses themselves ==');
for (const c of TUT.BUILTIN) {
  ok(c.kinds.length > 0, `${c.id}: says which aircraft it is for`, c.kinds.join(', '));
  for (const l of c.lessons) {
    const mk = TUT.markers(l);
    const flying = l.tasks.filter((t) => t.kind !== 'say').length;
    ok(mk.length >= flying, `${c.id}/${l.id}: every flying task has a marker`, `${mk.length} markers, ${flying} tasks`);
    ok(l.tasks.some((t) => t.kind !== 'say'), `${c.id}/${l.id}: has something to fly`);
    const far = Math.max(...l.tasks.map((t) => Math.hypot(t.n, t.e)));
    ok(!l.boxR || far < l.boxR, `${c.id}/${l.id}: no task sits outside its own fence`, `furthest ${far.toFixed(0)} m, fence ${l.boxR || '—'} m`);
    const high = Math.max(...l.tasks.map((t) => t.up));
    ok(!l.maxAlt || high < l.maxAlt, `${c.id}/${l.id}: no task sits above its own ceiling`, `highest ${high.toFixed(0)} m, ceiling ${l.maxAlt || '—'} m`);
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
