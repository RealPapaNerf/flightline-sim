/* =====================================================================
   Flightline training — the lesson engine and the built-in courses.

   A course is a ladder of lessons; a lesson is a list of tasks you fly in
   order; a task is a shape in the air you have to get to, hold, turn in,
   fly through or land on. The engine is a pure function of a snapshot of
   the aircraft — no DOM, no renderer, no physics — so it runs the same in
   the browser and under node, and test/tutorial_test.js flies the whole
   quad ladder with an autopilot to prove every lesson is passable.

   Coordinates. Everything is in metres relative to **where the pilot
   stands**, with the same axes the flight controller uses:

       n   north of the pilot        e   east of the pilot
       up  height above the ground under the pilot

   so a lesson written for the home field works unchanged on a terrain map:
   the app subtracts the map's pilot position before it calls tick(). An
   angle in degrees is a compass heading, 0 = north, 90 = east.

   Scoring is out of 1,000, and it is the same three numbers everywhere:
   500 for finishing, 200 for doing it inside the lesson's par time, and
   300 for precision — how near the middle of every shape you actually
   flew. Crashes come off the top. The point is that a second run can
   always beat the first, which is what makes a ladder worth climbing.

   A tutorial file is JSON and nothing but JSON, read the same way an
   aircraft file is: parsed, then copied field by field against the table
   below, every number range-checked and clamped, every string trimmed and
   capped, anything unrecognised dropped and listed. Nothing in a file is
   ever executed. docs/tutorial-format.md is the format and
   docs/design-a-tutorial-prompt.md is the prompt that writes one.
   ===================================================================== */
const TUT = (function () {
  'use strict';
  const FORMAT = 1;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const round = (x, n) => { const k = Math.pow(10, n || 0); return Math.round(x * k) / k; };
  // the shortest way round from a to b, in radians
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  /* ---------------- the task table ----------------
     kind decides which fields mean anything; the rest default. The four
     kinds are deliberately few — every drill in every built-in course is
     built out of them, and a kind the engine does not know is a kind the
     engine cannot score.

       zone   be inside a cylinder, optionally for a while, optionally
              pointing somewhere, optionally turning while you are there
       gate   fly through a rectangle standing in the air
       land   put it down inside a circle, gently, right way up
       say    no flying: a line of coaching between two tasks, cleared
              after `hold` seconds (or at once if it is zero)
   */
  const KINDS = ['zone', 'gate', 'land', 'say'];
  /* facing: where the nose has to point while a zone task is held.
       any     don't care
       home    at the pilot (nose-in: the hard one)
       away    straight out from the pilot (tail-in: the easy one)
       course  along the way you are moving — a turn flown on the rudder
       <deg>   a compass heading */
  const FACINGS = ['any', 'home', 'away', 'course'];

  const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

  // k: name, t: 'n' number | 'i' integer | 's' string | 'b' bool | 'e' enum, with range or values
  const TASK_RULES = [
    ['kind', 'e', KINDS, 'zone'],
    ['say', 's', 120, ''],
    ['tip', 's', 400, ''],
    ['n', 'n', [-4000, 4000], 0],
    ['e', 'n', [-4000, 4000], 0],
    ['up', 'n', [0, 2000], 2],
    ['r', 'n', [0.5, 500], 3],
    ['band', 'n', [0.3, 500], 2],
    ['hold', 'n', [0, 300], 0],
    ['spin', 'n', [0, 3600], 0],
    ['facing', 'f', FACINGS, 'any'],
    ['facingTol', 'n', [5, 180], 30],
    ['speedMax', 'n', [0, 300], 0],   // 0 = no limit
    ['width', 'n', [0.6, 60], 3],     // gate
    ['height', 'n', [0.6, 60], 2.5],
    ['yawDeg', 'n', [-360, 360], 0],  // gate heading: which way you fly through it
    ['rate', 'n', [0.2, 20], 1.5],    // land: the touchdown rate that still counts as gentle
    ['par', 'n', [1, 600], 20],
  ];
  const LESSON_RULES = [
    ['id', 's', 32, ''],
    ['name', 's', 60, 'Lesson'],
    ['blurb', 's', 400, ''],
    ['start', 'e', ['pad', 'runway', 'launch', 'air', 'any'], 'any'],
    ['maxAlt', 'n', [0, 2000], 0],    // 0 = no ceiling
    ['boxR', 'n', [0, 4000], 0],      // 0 = no fence
    ['par', 'n', [5, 3600], 0],       // 0 = add up the tasks
  ];

  function readRules(raw, rules, out, where) {
    const o = {};
    for (const [k, t, lim, dflt] of rules) {
      const have = Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : undefined;
      if (have === undefined) { o[k] = dflt; continue; }
      if (t === 's') { o[k] = clean(have, lim); continue; }
      if (t === 'b') { o[k] = !!have; continue; }
      if (t === 'e') {
        if (!lim.includes(have)) { out.warnings.push(`${where}.${k}: ${show(have)} is not one of ${lim.join(', ')}; using ${show(dflt)}`); o[k] = dflt; }
        else o[k] = have;
        continue;
      }
      if (t === 'f') { // an enum or a compass heading
        if (typeof have === 'number' && Number.isFinite(have)) { o[k] = ((have % 360) + 360) % 360; continue; }
        if (!lim.includes(have)) { out.warnings.push(`${where}.${k}: ${show(have)} is not one of ${lim.join(', ')} or a heading in degrees; using ${show(dflt)}`); o[k] = dflt; }
        else o[k] = have;
        continue;
      }
      if (typeof have !== 'number' || !Number.isFinite(have)) {
        out.errors.push(`${where}.${k}: ${show(have)} is not a number`);
        o[k] = dflt; continue;
      }
      const y = clamp(have, lim[0], lim[1]);
      if (y !== have) out.warnings.push(`${where}.${k}: ${have} clamped to ${y} (allowed ${lim[0]} … ${lim[1]})`);
      o[k] = t === 'i' ? Math.round(y) : y;
    }
    const known = new Set(rules.map((r) => r[0]));
    for (const k of Object.keys(raw)) if (!known.has(k) && k !== 'tasks') out.warnings.push(`${where}.${k}: not a field, ignored`);
    return o;
  }

  const MAX_TASKS = 40, MAX_LESSONS = 30;
  const AC_KINDS = ['quad', 'heli', 'wing', 'conventional', 'vtol'];

  function normLesson(raw, out, where) {
    if (!raw || typeof raw !== 'object') { out.errors.push(`${where}: not an object`); return null; }
    const L = readRules(raw, LESSON_RULES, out, where);
    const list = Array.isArray(raw.tasks) ? raw.tasks : [];
    if (!list.length) { out.errors.push(`${where}.tasks: a lesson needs at least one task`); return null; }
    if (list.length > MAX_TASKS) out.warnings.push(`${where}.tasks: ${list.length} tasks, only the first ${MAX_TASKS} kept`);
    L.tasks = list.slice(0, MAX_TASKS).map((t, i) => readRules(t && typeof t === 'object' ? t : {}, TASK_RULES, out, `${where}.tasks[${i}]`));
    if (!L.id) L.id = clean(L.name, 32).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `lesson${Math.max(1, list.length)}`;
    if (!L.par) L.par = Math.round(L.tasks.reduce((a, t) => a + t.par, 0));
    return L;
  }

  /* Read a tutorial file. Same contract as an aircraft file: it either comes
     back whole and safe, or it comes back with a list of what was wrong. */
  function read(text) {
    const out = { errors: [], warnings: [] };
    let raw;
    try { raw = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, errors: [`not JSON: ${e.message}`], warnings: [] }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['the file is not a JSON object'], warnings: [] };
    const fmt = String(raw.format || '');
    if (!/^flightline-tutorial\/\d+$/.test(fmt)) out.errors.push(`format: expected "flightline-tutorial/${FORMAT}", got ${show(raw.format)}`);
    else if (Number(fmt.split('/')[1]) > FORMAT) out.errors.push(`format: this file is version ${fmt.split('/')[1]} and this sim reads ${FORMAT}`);
    const course = {
      id: clean(raw.id, 32) || 'course',
      name: clean(raw.name, 60) || 'Course',
      blurb: clean(raw.blurb, 400),
      author: clean(raw.author, 60),
      source: clean(raw.source, 200),
      kinds: Array.isArray(raw.kinds) ? raw.kinds.filter((k) => AC_KINDS.includes(k)) : [],
    };
    if (Array.isArray(raw.kinds)) for (const k of raw.kinds) if (!AC_KINDS.includes(k)) out.warnings.push(`kinds: ${show(k)} is not one of ${AC_KINDS.join(', ')}, ignored`);
    if (!course.kinds.length) course.kinds = AC_KINDS.slice();
    const list = Array.isArray(raw.lessons) ? raw.lessons : [];
    if (!list.length) out.errors.push('lessons: the course has none');
    if (list.length > MAX_LESSONS) out.warnings.push(`lessons: ${list.length} lessons, only the first ${MAX_LESSONS} kept`);
    course.lessons = list.slice(0, MAX_LESSONS).map((l, i) => normLesson(l, out, `lessons[${i}]`)).filter(Boolean);
    const seen = new Set();
    for (const l of course.lessons) { // ids are how a best score is remembered, so they have to be unique
      let id = l.id, k = 2;
      while (seen.has(id)) id = `${l.id}-${k++}`;
      if (id !== l.id) out.warnings.push(`lessons: two lessons called "${l.id}"; the second is now "${id}"`);
      l.id = id; seen.add(id);
    }
    if (out.errors.length) return { ok: false, errors: out.errors, warnings: out.warnings };
    return { ok: true, course, errors: [], warnings: out.warnings };
  }

  const write = (course) => ({
    format: `flightline-tutorial/${FORMAT}`,
    id: course.id, name: course.name, blurb: course.blurb,
    author: course.author || undefined, source: course.source || undefined,
    kinds: course.kinds,
    lessons: course.lessons.map((l) => ({
      id: l.id, name: l.name, blurb: l.blurb, start: l.start, maxAlt: l.maxAlt, boxR: l.boxR, par: l.par,
      tasks: l.tasks,
    })),
  });

  /* ---------------- flying a lesson ----------------
     `run` is everything about one attempt. It is a plain object so the app
     can show it, the tests can read it and nothing has to be copied out. */
  function start(lesson) {
    return {
      lesson,
      step: 0,            // which task is live
      t: 0,               // seconds since the lesson began
      stepT: 0,           // seconds on this task
      held: 0,            // seconds inside the current zone
      spun: 0,            // degrees turned while inside it
      yawPrev: null,
      errSum: 0, errN: 0, // the running precision average
      best: 1,            // closest approach on this task, 0 = dead centre
      wasIn: false,       // have we been inside the live task's shape yet
      marks: [],          // one { id, err, t } per task finished
      crashes: 0, outT: 0, ceilT: 0,
      outPen: 0,          // seconds spent outside the fence or over the ceiling
      vsAir: 0,           // how fast it was sinking just before the wheels touched
      done: false, failed: null, flying: false,
      note: '',           // why the current task is not completing yet
    };
  }

  const taskOf = (run) => run.lesson.tasks[run.step] || null;

  // where the aircraft is relative to a task's centre
  function offset(task, s) {
    const dn = s.n - task.n, de = s.e - task.e;
    return { flat: Math.hypot(dn, de), dup: s.up - task.up, dn, de };
  }

  /* How far off the middle of this task the aircraft is, 0 (centre) to 1
     (just inside the edge) and over 1 outside it. This single number is
     what precision is scored from, so it has to mean the same thing for
     every kind: the worst of the ways you can be off. */
  function errorAt(task, s) {
    if (task.kind === 'gate') return 0;
    const o = offset(task, s);
    return Math.max(o.flat / task.r, Math.abs(o.dup) / task.band);
  }

  // is the nose where the task wants it? returns [ok, degrees off]
  function facingOff(task, s) {
    const f = task.facing;
    if (f === 'any') return [true, 0];
    let want;
    if (f === 'home') want = Math.atan2(-s.e, -s.n);
    else if (f === 'away') want = Math.atan2(s.e, s.n);
    else if (f === 'course') {
      if (Math.hypot(s.vn, s.ve) < 1.5) return [true, 0]; // standing still: any way is along the course
      want = Math.atan2(s.ve, s.vn);
    } else want = f * D2R;
    const off = Math.abs(wrap(want - s.yaw)) * R2D;
    return [off <= task.facingTol, off];
  }

  /* One step of the engine. `s` is the snapshot described at the top of the
     file; `dt` is real seconds. Returns the events the app should react to. */
  function tick(run, s, dt) {
    const ev = [];
    if (run.done || run.failed) return ev;
    const L = run.lesson;
    if (!run.flying) { // the clock starts when the aircraft does, not when the panel opens
      if (!s.armed || (s.wow && s.thr < 0.05 && L.tasks[0].kind !== 'say')) return ev;
      run.flying = true;
    }
    run.t += dt; run.stepT += dt;

    // --- the whole-lesson rules ---
    if (s.crashed) {
      if (!run.crashedNow) {
        run.crashedNow = true; run.crashes++;
        // back to the start of this task: you are on the pad again anyway
        run.held = 0; run.spun = 0; run.best = 1; run.wasIn = false; run.yawPrev = null; run.stepT = 0;
        ev.push(['crash', run.crashes]);
      }
      return ev;
    }
    run.crashedNow = false;
    /* The touchdown rate is worked out here rather than passed in, because
       "how hard did it land" is the sink rate from just *before* contact: on
       the ground it is already zero. Peak-hold with a slow bleed, so a quad
       that touches, bounces and settles is still scored on the arrival. */
    run.vsAir = s.wow ? Math.max(0, run.vsAir - 4 * dt) : Math.max(-s.vup, run.vsAir - 4 * dt);
    // over the ceiling or outside the fence: it costs by the second, and it
    // says so once rather than every frame
    const over = !!(L.maxAlt && s.up > L.maxAlt), out = !!(L.boxR && Math.hypot(s.n, s.e) > L.boxR);
    if (over || out) run.outPen += dt;
    if (over) { run.ceilT += dt; if (run.ceilT > 0.6 && !run.ceilSaid) { run.ceilSaid = true; ev.push(['over', L.maxAlt]); } }
    else { run.ceilT = 0; run.ceilSaid = false; }
    if (out) { run.outT += dt; if (run.outT > 0.6 && !run.outSaid) { run.outSaid = true; ev.push(['out', L.boxR]); } }
    else { run.outT = 0; run.outSaid = false; }

    const task = taskOf(run);
    if (!task) { run.done = true; ev.push(['done']); return ev; }

    // --- the live task ---
    let pass = false;
    run.note = '';
    if (task.kind === 'say') {
      if (run.stepT >= task.hold) pass = true;
    } else if (task.kind === 'gate') {
      // crossing the gate plane between last frame and this one, inside the frame
      if (run.gatePrev) {
        const c = Math.cos(task.yawDeg * D2R), si = Math.sin(task.yawDeg * D2R);
        // into the gate's own axes: y along the way you fly through it, x across
        const loc = (p) => { const dn = p.n - task.n, de = p.e - task.e; return [c * de - si * dn, p.up - task.up, si * de + c * dn]; };
        const a = loc(run.gatePrev), b = loc(s);
        if ((a[2] < 0) !== (b[2] < 0)) {
          const k = a[2] / (a[2] - b[2]);
          const x = a[0] + (b[0] - a[0]) * k, y = a[1] + (b[1] - a[1]) * k;
          const off = Math.max(Math.abs(x) / (task.width / 2), Math.abs(y) / (task.height / 2));
          if (off <= 1) { run.best = Math.min(run.best, off); pass = true; }
          else ev.push(['miss', round(off, 2)]);
        }
      }
    } else if (task.kind === 'land') {
      const o = offset(task, s);
      if (s.wow && s.thr < 0.15) {
        const soft = run.vsAir / task.rate;
        const level = Math.abs(s.roll * R2D) < 25 && Math.abs(s.pitch * R2D) < 25;
        if (o.flat <= task.r && level) { run.best = Math.max(soft, o.flat / task.r); pass = true; }
        else if (!level) run.note = 'not level';
        else run.note = `${Math.round(o.flat)} m off the pad`;
      } else run.note = o.flat > task.r ? `line up on the pad — ${Math.round(o.flat)} m off` : 'ease it down';
    } else { // zone
      const err = errorAt(task, s);
      const [facingOk, facingDeg] = facingOff(task, s);
      const fast = task.speedMax > 0 && s.gs > task.speedMax;
      const inside = err <= 1 && facingOk && !fast;
      if (inside) {
        run.best = Math.min(run.best, err);
        run.errSum += err; run.errN++;
        run.held += dt;
        run.wasIn = true;
        if (task.spin > 0) {
          if (run.yawPrev !== null) run.spun += Math.abs(wrap(s.yaw - run.yawPrev)) * R2D;
          run.yawPrev = s.yaw;
        }
        /* A marker you only have to reach is finished at the point of closest
           approach, not the moment you first clip its edge. Scoring it on
           first contact would give every fly-through an error of 1.0 — the
           edge is where you touch it — and no amount of flying it better
           could ever earn a point. So it finishes either when you are well
           inside it, or when you have been inside and have started to leave
           again, and the precision is the nearest you actually got. */
        if (run.held >= task.hold && run.spun >= task.spin) {
          if (task.hold > 0 || task.spin > 0 || err < 0.3) pass = true;
          else run.note = 'through';
        } else if (task.spin > 0 && run.spun < task.spin) run.note = `${Math.round(task.spin - run.spun)}° to go`;
        else run.note = `${(task.hold - run.held).toFixed(1)} s`;
      } else if (run.wasIn && task.hold === 0 && task.spin === 0) {
        pass = true; // left it again: scored on the nearest it got
      } else {
        // leaving the zone loses the hold: a 20-second hover means twenty
        // unbroken seconds, which is the whole point of the drill
        if (run.held > 0) ev.push(['lost', round(run.held, 1)]);
        run.held = 0; run.spun = 0; run.yawPrev = null;
        run.note = fast ? 'too fast — stop it first'
          : !facingOk ? `nose ${Math.round(facingDeg)}° off`
          : err > 1 ? `${Math.round(Math.max(offset(task, s).flat - task.r, Math.abs(offset(task, s).dup) - task.band))} m out` : '';
      }
    }
    run.gatePrev = { n: s.n, e: s.e, up: s.up };

    if (pass) {
      // precision for this task: how near the middle you managed, averaged
      // over a hold and taken at the closest point of a fly-through
      const err = task.kind === 'zone' && task.hold > 0 && run.errN ? run.errSum / run.errN : run.best;
      run.marks.push({ id: run.step, err: clamp(err, 0, 1), t: round(run.stepT, 2) });
      run.step++; run.stepT = 0; run.held = 0; run.spun = 0; run.yawPrev = null;
      run.errSum = 0; run.errN = 0; run.best = 1; run.wasIn = false; run.note = '';
      if (run.step >= L.tasks.length) { run.done = true; ev.push(['done']); }
      else ev.push(['step', run.step]);
    }
    return ev;
  }

  /* ---------------- the score ----------------
     Out of 1,000, and deliberately the same shape for every lesson so two
     scores can be compared: finish it at all, do it inside par, and fly it
     near the middle of every shape. Crashes and fence-busting come off.

     Par is generous on purpose — the time points are there to reward a
     second run, not to lock a beginner out of a medal on the first. */
  const FINISH = 500, TIME = 200, PRECISION = 300;
  const CRASH_COST = 120, OUT_RATE = 3;
  function score(run) {
    const L = run.lesson;
    const finished = run.done;
    const part = L.tasks.length ? run.marks.length / L.tasks.length : 0;
    const finish = finished ? FINISH : Math.round(FINISH * 0.5 * part); // half marks for what you did get through
    // full time points at or under par, nothing left at twice par
    const time = finished ? Math.round(TIME * clamp((2 * L.par - run.t) / L.par, 0, 1)) : 0;
    const err = run.marks.length ? run.marks.reduce((a, m) => a + m.err, 0) / run.marks.length : 1;
    const precision = Math.round(PRECISION * clamp(1 - err, 0, 1) * (finished ? 1 : part));
    const penalty = Math.round(run.crashes * CRASH_COST + OUT_RATE * (run.outPen || 0));
    const total = Math.max(0, finish + time + precision - penalty);
    return { total, finish, time, precision, penalty, err: round(err, 3), medal: medalFor(total), finished };
  }
  const MEDALS = [['gold', 850], ['silver', 650], ['bronze', 420]];
  function medalFor(total) { for (const [m, at] of MEDALS) if (total >= at) return m; return null; }

  /* ---------------- what the renderer draws ----------------
     A flat list of shapes, in the same pilot-relative metres the tasks use.
     The app turns them into meshes; nothing here knows about WebGL. */
  function markers(lesson) {
    const out = [];
    lesson.tasks.forEach((t, i) => {
      if (t.kind === 'say') return;
      if (t.kind === 'gate') out.push({ k: 'gate', i, n: t.n, e: t.e, up: t.up, w: t.width, h: t.height, yaw: t.yawDeg });
      else if (t.kind === 'land') out.push({ k: 'pad', i, n: t.n, e: t.e, up: t.up, r: t.r });
      else out.push({ k: 'zone', i, n: t.n, e: t.e, up: t.up, r: t.r, band: t.band, hold: t.hold > 0 });
    });
    if (lesson.boxR) out.push({ k: 'fence', i: -1, n: 0, e: 0, up: 0, r: lesson.boxR });
    return out;
  }

  /* The line of instruction for the task that is live, and the one after it.
     Written here rather than in the app so a tutorial file reads the same
     way the built-in courses do. */
  function sayNow(run) {
    const t = taskOf(run);
    if (!t) return { say: 'Finished', note: '', tip: '' };
    return { say: t.say || defaultSay(t), note: run.note, tip: t.tip };
  }
  function defaultSay(t) {
    if (t.kind === 'gate') return 'Through the gate';
    if (t.kind === 'land') return 'Land on the pad';
    if (t.spin) return `Turn ${Math.round(t.spin)}° where you are`;
    if (t.hold) return `Hold it there for ${Math.round(t.hold)} s`;
    return 'Fly to the marker';
  }

  /* ---------------- the built-in courses ----------------
     Three ladders, each in the order the skill is actually taught.

     The quad ladder is Joshua Bardwell's: throttle first and alone, then
     yaw, then forward flight with a stop at the end of it, then turns on
     the roll stick, then turns on the rudder, then the orientations, then a
     spot landing, then gates. His two rules run through all of it — fly in
     Acro from the first minute, and learn to *stop* the quad rather than
     let it coast — so the early lessons are scored on holding a spot, and
     the forward-flight lesson is a there-and-back with a hover at each end.

     The helicopter ladder is the hovering ladder every club teaches: tail
     in, then side on, then the wall every heli pilot hits, which is nose
     in; then the box, the pirouette, the circuit and an autorotation.

     The plane ladder is a circuit ladder: get it off the ground, fly a
     rectangle, fly it the other way round, slow it down until it stops
     flying, then approaches and landings.

     Heights are above the ground under the pilot and distances are from
     where the pilot stands, so every one of these works on a terrain map
     as well as on the home field. */
  const say = (text, tip, hold) => ({ kind: 'say', say: text, tip: tip || '', hold: hold || 0, par: hold || 3 });
  const hover = (o) => Object.assign({ kind: 'zone', r: 3, band: 2, hold: 10, par: 20 }, o);
  const mark = (o) => Object.assign({ kind: 'zone', r: 6, band: 4, hold: 0, par: 10 }, o);
  const gate = (o) => Object.assign({ kind: 'gate', width: 4, height: 3, par: 8 }, o);
  const pad = (o) => Object.assign({ kind: 'land', r: 2.5, band: 2, rate: 1.5, par: 25 }, o);

  /* A ring of waypoints, which is what a circle or a figure of eight is made
     of: `n` of them around (cn, ce), starting `from` degrees round and
     sweeping `sweep` degrees (negative sweeps the other way). Bearings are
     compass degrees, so 0 is due north of the centre. */
  function ring(cn, ce, radius, up, from, sweep, n, extra) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const a = (from + (sweep * i) / n) * D2R;
      out.push(mark(Object.assign({ n: round(cn + radius * Math.cos(a), 1), e: round(ce + radius * Math.sin(a), 1), up, r: 8, band: 6, par: 6 }, extra)));
    }
    return out;
  }

  /* A ring of gates, which is a race course: `n` of them evenly round a circle
     at (cn, ce), each standing square to the way you fly through it. The first
     one is on the near side so you meet the course head on coming out from the
     pad, and they are numbered the way they are flown. */
  function gateRing(cn, ce, radius, up, n, extra) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = ((2 * Math.PI) * i) / n;
      out.push(gate(Object.assign({
        say: `Gate ${i + 1}`,
        n: round(cn - radius * Math.cos(a), 1), e: round(ce + radius * Math.sin(a), 1), up,
        // the way round the circle at this point, as a compass heading
        yawDeg: round(((Math.atan2(Math.cos(a), Math.sin(a)) * R2D) % 360 + 360) % 360, 1),
      }, extra)));
    }
    return out;
  }

  /* Where the drills are flown. The pilot stands at the origin facing north,
     the flight-line fence is 4 m in front of him and the runway runs east and
     west 12 m further on, so everything below is laid out to the **north** —
     out over the field, in front of the line, which is the only side you are
     ever allowed to fly on. The home field keeps a corridor clear of trees
     from 35 m to 200 m out and 115 m either side, and nothing here leaves it.

     Quads and helicopters start on the pad 8 m out, so that is where every
     landing pad sits too: you put it down where you picked it up. */
  const PAD_N = 8, PAD_E = 0;

  const QUAD = {
    id: 'bardwell', name: 'Learn to fly a quad',
    blurb: 'Ten drills in the order Joshua Bardwell teaches them: throttle first and alone, then yaw, then stopping, then turns, then the orientations, then gates. Fly all of it in Acro.',
    kinds: ['quad'],
    lessons: [
      { id: 'hover', name: '1 · Throttle, and nothing else', start: 'pad', boxR: 60, maxAlt: 25, par: 70,
        blurb: 'The only stick that matters today is the left one. Get it off the ground, keep it at eye level, put it back down. Everything else in FPV is built on this.',
        tasks: [
          say('Arm with the throttle down, then ease it up', 'Throttle is altitude. On a quad there is no "up" stick that holds a height — you are balancing on the throttle the whole time, and you will be for the rest of your flying life.', 2),
          hover({ say: 'Hold it at eye level', n: PAD_N, e: PAD_E, up: 1.7, r: 3, band: 1.2, hold: 20, par: 35,
            tip: 'Small corrections, early. The mistake every beginner makes is waiting until it has moved, then grabbing a big handful of stick, then grabbing a bigger one back.' }),
          pad({ say: 'Land it on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.5, par: 25,
            tip: 'Come down slowly and take the throttle to zero the moment the feet touch. If you leave throttle in, it will tip over.' }),
        ] },
      { id: 'throttle', name: '2 · Up and down', start: 'pad', boxR: 80, maxAlt: 40, par: 90,
        blurb: 'Throttle discipline: climb to a height, stop there, come back down, stop there. A quad that will not stop climbing is a quad you cannot land.',
        tasks: [
          hover({ say: 'Climb to 10 m and stop', n: PAD_N, e: PAD_E, up: 10, r: 4, band: 2, hold: 6, par: 20,
            tip: 'A quad carries its climb. Start easing the throttle back before you get there, not when you arrive.' }),
          hover({ say: 'Back down to 2 m and stop', n: PAD_N, e: PAD_E, up: 2, r: 4, band: 1, hold: 6, par: 20,
            tip: 'Come down at a walking pace. Drop it fast and it sinks into its own prop wash, which is where the wobble comes from.' }),
          hover({ say: 'Up to 15 m and hold it', n: PAD_N, e: PAD_E, up: 15, r: 4, band: 2, hold: 10, par: 25,
            tip: 'Same again. By now the throttle hand should be making the corrections before you have thought about them.' }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 25 }),
        ] },
      { id: 'yaw', name: '3 · Yaw in the hover', start: 'pad', boxR: 60, maxAlt: 25, par: 110,
        blurb: 'Yaw turns the quad without moving it. Keep it over the same spot through a full turn each way, and you have learnt that the rudder is for pointing, not for going.',
        tasks: [
          hover({ say: 'Hover at 3 m', n: PAD_N, e: PAD_E, up: 3, r: 3, band: 1.5, hold: 5, par: 15 }),
          hover({ say: 'Turn all the way round, staying put', n: PAD_N, e: PAD_E, up: 3, r: 4, band: 2, hold: 0, spin: 360, par: 35,
            tip: 'Slowly. The faster you spin, the more the quad leans and walks off the spot — and as the nose comes round, left on the right stick stops meaning left to you.' }),
          hover({ say: 'And back the other way', n: PAD_N, e: PAD_E, up: 3, r: 4, band: 2, hold: 0, spin: 360, par: 35 }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 25 }),
        ] },
      { id: 'stop', name: '4 · Fly out, and stop', start: 'pad', boxR: 140, maxAlt: 40, par: 120,
        blurb: 'Anyone can make a quad go. Stopping it where you meant to is the skill, and it is the one that keeps you out of trees.',
        tasks: [
          say('Fly out to the marker and stop in it', 'Pitch forward to go, then pitch *back* to stop. A quad has no brakes: if you just centre the stick it coasts, and it coasts a long way.', 2),
          hover({ say: '40 m out — stop and hover', n: PAD_N + 40, e: PAD_E, up: 8, r: 5, band: 3, hold: 5, speedMax: 4, par: 30,
            tip: 'Start braking at about two thirds of the way. Stopping it inside the circle is the whole exercise.' }),
          hover({ say: 'Come back and stop here', n: PAD_N, e: PAD_E, up: 8, r: 5, band: 3, hold: 5, speedMax: 4, par: 30 }),
          hover({ say: 'Out again — a bit quicker this time', n: PAD_N + 40, e: PAD_E, up: 8, r: 5, band: 3, hold: 3, speedMax: 4, par: 25 }),
          pad({ say: 'Fly home and land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 30 }),
        ] },
      { id: 'box', name: '5 · The box', start: 'pad', boxR: 160, maxAlt: 45, par: 140,
        blurb: 'A square at a constant height with the nose pointed the same way all the way round. Two sides are flown on pitch and two on roll, which is why it teaches more than a circle does.',
        tasks: [
          say('Nose stays north. Fly the square on pitch and roll alone', 'No rudder at all this time. On the sideways legs you are flying on the roll stick with the nose pointing across your path, which is exactly the orientation that catches people out.', 2),
          mark({ say: 'Corner 1 — out and left', n: 30, e: -25, up: 12, r: 8, facing: 0, facingTol: 40, par: 22 }),
          mark({ say: 'Corner 2 — straight out', n: 70, e: -25, up: 12, r: 8, facing: 0, facingTol: 40, par: 20 }),
          mark({ say: 'Corner 3 — across to the right', n: 70, e: 25, up: 12, r: 8, facing: 0, facingTol: 40, par: 20 }),
          mark({ say: 'Corner 4 — back towards you', n: 30, e: 25, up: 12, r: 8, facing: 0, facingTol: 40, par: 20 }),
          hover({ say: 'Back to the middle and hold', n: 50, e: 0, up: 12, r: 5, band: 3, hold: 5, par: 25 }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 30 }),
        ] },
      { id: 'circle', name: '6 · Turns on the rudder', start: 'pad', boxR: 160, maxAlt: 45, par: 150,
        blurb: 'A circle out in front of you with the nose always pointing the way you are going. Roll to hold the turn, rudder to bring the nose round with it — this is the turn every piece of cinematic footage is flown on.',
        tasks: [
          say('Fly the circle with the nose along the path', 'Lead with the rudder and hold the lean with roll. If the nose lags the turn you are skidding, and the footage will show it.', 2),
          ...ring(55, 0, 40, 14, 180, 360, 8, { facing: 'course', facingTol: 55, say: 'Round you go' }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 30 }),
        ] },
      { id: 'eight', name: '7 · Figure of eight', start: 'pad', boxR: 180, maxAlt: 50, par: 160,
        blurb: 'Two circles the opposite way round, joined in the middle. The crossing is the bit worth practising: you have to change which way you are leaning while the nose swings through.',
        tasks: [
          say('Near loop one way, far loop the other', 'Keep the height. Almost everyone climbs in one loop and sinks in the other, and the sim will tell you which.', 2),
          ...ring(45, 0, 32, 14, 180, -360, 6, { say: 'Near loop' }),
          ...ring(109, 0, 32, 14, 180, 360, 6, { say: 'Far loop' }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 30 }),
        ] },
      { id: 'nosein', name: '8 · Nose-in hover', start: 'pad', boxR: 60, maxAlt: 25, par: 120,
        blurb: 'The wall. Pointed at you, every control on the right stick is backwards, and the only way through it is to stop translating and start thinking in the quad\'s frame.',
        tasks: [
          hover({ say: 'Hover at 4 m, tail towards you', n: 18, e: 0, up: 4, r: 3, band: 1.5, hold: 5, facing: 'away', facingTol: 40, par: 20 }),
          hover({ say: 'Turn it round to face you', n: 18, e: 0, up: 4, r: 5, band: 2.5, hold: 0, spin: 180, par: 25,
            tip: 'Turn it slowly and watch which way it drifts as the nose comes round.' }),
          hover({ say: 'Hold a nose-in hover for 20 s', n: 18, e: 0, up: 4, r: 4, band: 2, hold: 20, facing: 'home', facingTol: 40, par: 40,
            tip: 'Left stick is still throttle, and that has not reversed. Everything on the right stick has. Tiny inputs, and if it gets away from you, yaw it back to tail-in and start again.' }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 30 }),
        ] },
      { id: 'spot', name: '9 · The spot landing', start: 'air', boxR: 160, maxAlt: 60, par: 100,
        blurb: 'From height and distance, down onto a pad two and a half metres across, gently. A quad that can be landed on a spot can be landed anywhere, which matters the day the pack goes flat a field away.',
        tasks: [
          say('Bring it down the approach and put it on the pad', 'Lose the height first and the distance second. Coming in fast and low leaves you no room to judge the flare.', 2),
          mark({ say: 'Line up on the approach', n: 53, e: 0, up: 15, r: 10, band: 6, par: 20 }),
          hover({ say: 'Over the pad at 5 m', n: PAD_N, e: PAD_E, up: 5, r: 4, band: 2, hold: 4, speedMax: 3, par: 25 }),
          pad({ say: 'Put it down on the pad', n: PAD_N, e: PAD_E, up: 0, r: 1.6, rate: 1.0, par: 30,
            tip: 'Under one metre a second, inside a metre and a half of the middle. That is a landing you can do with a camera on the front.' }),
        ] },
      { id: 'gates', name: '10 · The gate run', start: 'pad', boxR: 220, maxAlt: 60, par: 130,
        blurb: 'Six gates on an oval out in front of you, flown in order. Everything from the first nine lessons at once, against a clock — and the first lesson here where going faster actually pays.',
        tasks: [
          say('Six gates, in order, as quick as you can hold them', 'Look at the gate after the one you are going through. If you are looking at the one you are in, you are already too late for the next.', 2),
          ...gateRing(78, 0, 38, 2.5, 6, { width: 5, height: 3.5, par: 11 }),
          pad({ say: 'Through gate 6, then land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, par: 30 }),
        ] },
    ],
  };

  const HELI = {
    id: 'hover-ladder', name: 'Learn to fly a helicopter',
    blurb: 'The hovering ladder every club teaches, in order: tail in, side on, nose in, then the box, the pirouette, a circuit and an autorotation. Nobody gets past step four quickly.',
    kinds: ['heli'],
    lessons: [
      { id: 'lift', name: '1 · Lift off into a hover', start: 'pad', boxR: 50, maxAlt: 20, par: 80,
        blurb: 'Collective up until it is light on the skids, then a little more. The tail will try to swing as it comes off — catch it with the rudder, do not chase it.',
        tasks: [
          say('Spool up, then ease the collective in', 'Let the head come up to speed before you lift. A helicopter leaving the ground on a slow head has no authority to put it back down with.', 4),
          hover({ say: 'Hold it a metre up, tail towards you', n: PAD_N, e: PAD_E, up: 1.2, r: 3, band: 0.8, hold: 15, facing: 'away', facingTol: 50, par: 35,
            tip: 'It will drift. Every helicopter drifts — the tail rotor pushes it sideways and the main rotor leans to hold it there. Put in the cyclic to stop the drift and leave it there.' }),
          pad({ say: 'Set it back down', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'hold', name: '2 · Hold the hover', start: 'pad', boxR: 50, maxAlt: 20, par: 110,
        blurb: 'A minute in a two-metre box at head height. Boring, and it is the single most valuable minute in model helicopters.',
        tasks: [
          say('Spool up and lift into a hover', '', 4),
          hover({ say: 'Hover at 2 m for a full minute', n: PAD_N, e: PAD_E, up: 2, r: 2.5, band: 1, hold: 60, facing: 'away', facingTol: 55, par: 75,
            tip: 'Pick a spot on the ground and keep it under the skids. If you watch the whole helicopter you will chase its attitude instead of its position.' }),
          pad({ say: 'Land', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'sidein', name: '3 · Side on', start: 'pad', boxR: 60, maxAlt: 20, par: 150,
        blurb: 'Turn it ninety degrees and hover again. Now the cyclic that used to move it left and right moves it towards and away from you, and that is half the way to nose-in.',
        tasks: [
          say('Spool up and lift into a tail-in hover', '', 4),
          hover({ say: 'Hover tail-in at 2 m', n: PAD_N, e: PAD_E, up: 2, r: 3, band: 1, hold: 5, facing: 'away', facingTol: 50, par: 20 }),
          hover({ say: 'Turn 90° left and hold it', n: PAD_N, e: PAD_E, up: 2, r: 3.5, band: 1.2, hold: 20, facing: 270, facingTol: 45, par: 45 }),
          hover({ say: 'Now 90° right of tail-in, and hold', n: PAD_N, e: PAD_E, up: 2, r: 3.5, band: 1.2, hold: 20, facing: 90, facingTol: 45, par: 45 }),
          pad({ say: 'Land', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'nosein', name: '4 · Nose in', start: 'pad', boxR: 60, maxAlt: 20, par: 150,
        blurb: 'The wall. Pointed at you, left is right and forward is back, and there is no trick that gets you past it except hours.',
        tasks: [
          say('Spool up and lift into a hover', '', 4),
          hover({ say: 'Hover side-on at 3 m', n: PAD_N, e: PAD_E, up: 3, r: 3, band: 1.2, hold: 5, facing: 90, facingTol: 50, par: 20 }),
          hover({ say: 'Bring the nose round to face you', n: PAD_N, e: PAD_E, up: 3, r: 5, band: 2, hold: 0, spin: 90, par: 25 }),
          hover({ say: 'Hold it nose-in for 30 s', n: PAD_N, e: PAD_E, up: 3, r: 4, band: 1.5, hold: 30, facing: 'home', facingTol: 50, par: 55,
            tip: 'Stop thinking "left" and start thinking "towards the retreating side". Most people get there by hovering nose-in behind a tail-in hover they can escape to.' }),
          pad({ say: 'Land', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'box', name: '5 · The hover box', start: 'pad', boxR: 80, maxAlt: 25, par: 140,
        blurb: 'A twenty-metre square at walking pace with the tail in the whole way round. Pure cyclic discipline.',
        tasks: [
          say('Spool up and lift into a hover', '', 4),
          mark({ say: 'Out to the first corner', n: 20, e: -10, up: 3, r: 4, band: 2, facing: 'away', facingTol: 60, speedMax: 4, par: 25 }),
          mark({ say: 'Across', n: 20, e: 10, up: 3, r: 4, band: 2, facing: 'away', facingTol: 60, speedMax: 4, par: 25 }),
          mark({ say: 'Back towards you', n: 6, e: 10, up: 3, r: 4, band: 2, facing: 'away', facingTol: 60, speedMax: 4, par: 25 }),
          mark({ say: 'And home', n: 6, e: -10, up: 3, r: 4, band: 2, facing: 'away', facingTol: 60, speedMax: 4, par: 25 }),
          pad({ say: 'Land on the pad', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'pirouette', name: '6 · Pirouette in the hover', start: 'pad', boxR: 60, maxAlt: 25, par: 130,
        blurb: 'A slow full turn over one spot. Every orientation in one exercise, and the cyclic correction has to rotate with the helicopter.',
        tasks: [
          say('Spool up and lift into a hover', '', 4),
          hover({ say: 'Hover at 3 m', n: PAD_N, e: PAD_E, up: 3, r: 3, band: 1.2, hold: 5, par: 20 }),
          hover({ say: 'One slow turn, staying over the spot', n: PAD_N, e: PAD_E, up: 3, r: 4, band: 2, hold: 0, spin: 360, par: 45,
            tip: 'Think of the correction as a point on a clock face that turns with the helicopter. Most people get a quarter of the way round and stop — which is fine, do a quarter at a time.' }),
          hover({ say: 'And the other way', n: PAD_N, e: PAD_E, up: 3, r: 4, band: 2, hold: 0, spin: 360, par: 45 }),
          pad({ say: 'Land', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'circuit', name: '7 · A circuit', start: 'pad', boxR: 200, maxAlt: 50, par: 160,
        blurb: 'Out of the hover into forward flight, a rectangle at height, and back to a hover over the pad. Forward flight is the easy part; the transition back into a hover is not.',
        tasks: [
          say('Spool up and climb away', '', 4),
          mark({ say: 'Climb away to 20 m', n: 45, e: 0, up: 20, r: 10, band: 6, par: 25 }),
          mark({ say: 'Downwind leg', n: 95, e: 35, up: 20, r: 12, band: 8, par: 25 }),
          mark({ say: 'Base', n: 45, e: 35, up: 15, r: 12, band: 8, par: 25 }),
          mark({ say: 'Turn final', n: 25, e: 0, up: 10, r: 10, band: 6, par: 25 }),
          hover({ say: 'Into the hover over the pad', n: PAD_N, e: PAD_E, up: 3, r: 4, band: 2, hold: 5, speedMax: 3, par: 35,
            tip: 'Translational lift goes away as you slow down and the helicopter sinks. Feed collective in as the speed washes off, not after.' }),
          pad({ say: 'Land', n: PAD_N, e: PAD_E, up: 0, r: 2.5, rate: 1.2, par: 25 }),
        ] },
      { id: 'auto', name: '8 · Autorotation', start: 'air', boxR: 160, maxAlt: 80, par: 100,
        blurb: 'Throttle hold on at height, and bring it down on the energy already in the blades. Press H, or put throttle hold on a switch.',
        tasks: [
          say('Climb to 50 m over the field, then kill the motor with throttle hold', 'Collective straight down the moment it goes quiet — that is what keeps the head turning. Holding collective in is what kills the head speed, and a dead head cannot be flared.', 3),
          mark({ say: 'Get to 50 m over the field', n: 25, e: 0, up: 50, r: 20, band: 12, par: 30 }),
          pad({ say: 'Autorotate down to the pad', n: PAD_N, e: PAD_E, up: 0, r: 6, rate: 2.5, par: 45,
            tip: 'Keep the nose a little up to hold the rotor speed, then flare at about five metres and level it with the last of the collective. You get one try.' }),
        ] },
    ],
  };

  /* The plane ladder is flown round the real runway: it runs east and west
     12 m north of the pilot, and a runway start puts you at the west end of it
     pointing east. So every circuit here is a left-hand one off an easterly
     takeoff — climb out east, turn left onto crosswind, downwind heading west
     out to the north, base, and final back onto the strip heading east. */
  const RWY_N = 12;
  const PLANE = {
    id: 'circuits', name: 'Learn to fly a plane',
    blurb: 'The club circuit ladder: get it off the ground, fly a left-hand circuit round the strip, fly a figure of eight, find out where the wing stops flying, then approaches and landings.',
    kinds: ['wing', 'conventional'],
    lessons: [
      { id: 'climb', name: '1 · Up and round', start: 'runway', boxR: 300, maxAlt: 120, par: 120,
        blurb: 'Full power, let it fly itself off, climb straight ahead down the strip, then a gentle turn to the left. No more than about twenty degrees of bank the whole way.',
        tasks: [
          say('Full throttle, let the tail come up, and let it fly off', 'Do not haul it off the ground. A plane dragged into the air below flying speed will drop a wing, and down low there is no height to fix it in.', 3),
          mark({ say: 'Climb straight ahead to 35 m', n: RWY_N, e: 70, up: 35, r: 28, band: 18, par: 30 }),
          mark({ say: 'Gentle turn left, out to the north', n: 110, e: 100, up: 45, r: 30, band: 20, par: 28 }),
          mark({ say: 'And back past yourself', n: 110, e: -60, up: 45, r: 30, band: 20, par: 30 }),
        ] },
      { id: 'circuit', name: '2 · The circuit', start: 'runway', boxR: 350, maxAlt: 120, par: 160,
        blurb: 'A rectangle at a constant height: upwind, crosswind, downwind, base, final. Left-hand, which is how a club flies it.',
        tasks: [
          mark({ say: 'Upwind, climbing to 35 m', n: RWY_N, e: 70, up: 35, r: 28, band: 18, par: 30 }),
          mark({ say: 'Crosswind', n: 110, e: 105, up: 50, r: 30, band: 20, par: 28 }),
          mark({ say: 'Downwind', n: 110, e: -60, up: 50, r: 30, band: 20, par: 30 }),
          mark({ say: 'Base', n: 60, e: -125, up: 35, r: 28, band: 18, par: 28 }),
          mark({ say: 'Final', n: RWY_N, e: -85, up: 18, r: 25, band: 12, par: 28 }),
        ] },
      { id: 'eight', name: '3 · Figure of eight', start: 'air', boxR: 350, maxAlt: 150, par: 150,
        blurb: 'Two turns the opposite way at the same height out in front of you. It is a height-holding exercise dressed up as a turning one.',
        tasks: [
          say('Hold 60 m right the way round both loops', 'Bank costs you lift, so a turn at a constant height needs a little up elevator and a little power. Most people descend in the turns and climb on the straights.', 2),
          ...ring(120, -70, 65, 60, 180, 360, 5, { r: 30, band: 18, say: 'Left loop' }),
          ...ring(120, 70, 65, 60, 180, -360, 5, { r: 30, band: 18, say: 'Right loop' }),
        ] },
      { id: 'slow', name: '4 · Slow flight and the stall', start: 'air', boxR: 350, maxAlt: 200, par: 120,
        blurb: 'Take the power off at height and find out what it does when the wing gives up — somewhere you can afford to.',
        tasks: [
          mark({ say: 'Get to 100 m with room in front of you', n: 100, e: 20, up: 100, r: 35, band: 22, par: 35 }),
          say('Power right off, hold the nose up, and let it stall', 'It will drop a wing, and which way it drops tells you something about your model. Recover with the nose down and the power on, not with aileron.', 8),
          mark({ say: 'Recover, and level out at 50 m', n: 100, e: -40, up: 50, r: 35, band: 20, par: 35,
            tip: 'Down elevator first, power second, and leave the ailerons alone until the wing is flying again.' }),
        ] },
      { id: 'approach', name: '5 · The approach', start: 'air', boxR: 350, maxAlt: 150, par: 140,
        blurb: 'A powered approach down a steady slope onto the strip. Power sets how fast you come down; elevator sets how fast you are going.',
        tasks: [
          mark({ say: 'Downwind at 50 m', n: 95, e: -40, up: 50, r: 30, band: 20, par: 32 }),
          mark({ say: 'Base at 35 m', n: 60, e: -135, up: 35, r: 28, band: 18, par: 28 }),
          mark({ say: 'Final at 15 m', n: RWY_N, e: -110, up: 15, r: 25, band: 12, par: 28 }),
          mark({ say: 'Over the numbers at 4 m', n: RWY_N, e: -55, up: 4, r: 18, band: 4, par: 28,
            tip: 'If it is high and fast, go round. Every landing you salvage from a bad approach teaches you to fly a bad approach.' }),
        ] },
      { id: 'land', name: '6 · The landing', start: 'air', boxR: 350, maxAlt: 150, par: 170,
        blurb: 'The whole thing: a circuit, an approach, the flare, and the wheels on the strip.',
        tasks: [
          mark({ say: 'Downwind at 50 m', n: 95, e: -40, up: 50, r: 30, band: 20, par: 32 }),
          mark({ say: 'Base at 35 m', n: 60, e: -135, up: 35, r: 28, band: 18, par: 28 }),
          mark({ say: 'Turn final at 15 m', n: RWY_N, e: -110, up: 15, r: 25, band: 12, par: 30 }),
          pad({ say: 'Put the wheels on the strip', n: RWY_N, e: -5, up: 0, r: 28, rate: 2.5, par: 55,
            tip: 'Hold it off. Let it come down to a foot above the strip and then keep easing the elevator back as it sinks, so it runs out of flying speed at the moment it touches.' }),
        ] },
    ],
  };


  // the courses that ship with the sim, normalised through the same reader a
  // file goes through, so a built-in course cannot be something a file could
  // not have been
  const BUILTIN = [QUAD, HELI, PLANE].map((c) => {
    const r = read(Object.assign({ format: `flightline-tutorial/${FORMAT}`, author: 'Flightline' }, c));
    if (!r.ok) throw new Error(`built-in course ${c.id}: ${r.errors.join('; ')}`);
    return r.course;
  });

  const forKind = (kind) => BUILTIN.filter((c) => c.kinds.includes(kind));

  return { FORMAT, BUILTIN, forKind, read, write, start, tick, score, medalFor, markers, sayNow, taskOf, errorAt, facingOff, MEDALS, FINISH, TIME, PRECISION, CRASH_COST, OUT_RATE };
})();
if (typeof module !== 'undefined') module.exports = TUT;
