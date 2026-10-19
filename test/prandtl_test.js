/* The bell spanload, and what moving the planform does to it.
   Run: node test/prandtl_test.js [span_m] [rootChord_m] [sweep_deg]

   Prandtl's 1933 answer to "what lift distribution costs least induced drag
   for a given root bending moment" is not the ellipse. It is a bell:

       Γ(η) ∝ (1 − η²)^{3/2},      η = 2y/b

   and the whole of its reputation comes from what that does to the downwash
   rather than to the total. Writing the bell as a Fourier series gives
   A₃ = −A₁/3, and the induced flow of that series is

       w(η)/V = 2·A₁·(1 − 2η²)

   — downwash inboard, and **upwash** outboard of η = 1/√2 = 0.707. A wing
   section sitting in upwash has its lift vector tilted *forward*: it makes
   induced thrust, not induced drag. The tips are where the ailerons are, so
   the wing that rolls up yaws into the turn instead of out of it. Proverse
   yaw, and no fin to make it happen.

   None of that is programmed in here. Flightline's accurate model
   (`env.hifi`) solves circulation strip by strip and charges each strip
   `CL·(w/V)` of induced drag from the induced velocity the solve found, so a
   strip in upwash is charged a negative number. This file's job is to find out
   whether the bell actually falls out of that, and what happens to it as the
   planform moves — which is the question the sweep at the bottom answers.

   The twist that produces the bell is worked out in closed form rather than
   searched for: see bellTwist(). It is the only part of this that is designed
   rather than measured. */
const FL = require('../src/physics.js');
const ACF = require('../src/aircraft.js');

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: false, hifi: true };
const line = (...a) => console.log(...a);
let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

/* ---------------- the twist that makes a bell ----------------
   cl(η) = 2Γ/(Vc) with Γ = Γ₀(1−η²)^{3/2} and Γ₀ = (8/3)·b·V·A₁, so the
   section has to be flying at cl/a₀ of effective incidence; add the induced
   angle w/V the bell itself produces and you have the geometric incidence the
   section must be built at. The difference between that at the tip and at the
   root is the washout, and for a 3.75 m wing at CL 0.5 it comes out near 10°,
   which is about what NASA built into the real one. */
function bellTwist(n, { b, S, c0, c1, CL, a0 = 5.9 }) {
  const AR = (b * b) / S, A1 = CL / (Math.PI * AR);
  const geo = (eta) => {
    const c = c0 + (c1 - c0) * eta;
    const cl = ((16 / 3) * b * A1 * Math.pow(Math.max(0, 1 - eta * eta), 1.5)) / c;
    return cl / a0 + 2 * A1 * (1 - 2 * eta * eta); // effective incidence + the bell's own induced angle
  };
  const root = geo(0), out = [];
  for (let i = 0; i < n; i++) out.push(round((geo(i / (n - 1)) - root) * R2D, 3));
  return out;
}
const round = (x, k) => Math.round(x * Math.pow(10, k)) / Math.pow(10, k);

/* A flying wing built to a planform, with or without the bell twist on it.
   The build sheet does the boilerplate — prop, pack, contact points, gains —
   and then the wing surface is replaced with the one being studied. A
   Prandtl-D has no fin at all, which is the other half of the claim. */
function wing({ b = 3.75, c0 = 0.4, taper = 0.35, sweep = 24, mass = 2.2, V = 11, twist = 'bell', n = 16, fin = false, sm = null }) {
  const c1 = c0 * taper;

  const spec = {
    kind: 'wing', id: 'prandtl', name: 'Prandtl-D',
    span: Math.round(b * 1000), rootChord: Math.round(c0 * 1000), tipChord: Math.round(c1 * 1000),
    sweep, mass: Math.round(mass * 1000), watts: 300, cellsS: 4, cellmAh: 3000,
  };
  const def = ACF.fromSpec(spec);
  if (!def) throw new Error('the build sheet refused that planform');
  const w = def.surfaces.find((s) => s.role === 'wing');
  w.n = n;
  if (!fin) def.surfaces = def.surfaces.filter((s) => s.role !== 'fin');
  def.body.fin = fin ? def.body.fin : 0;
  /* The design lift coefficient is not a number to pick, and it is not one to
     work out from the numbers that went *into* the build sheet either: it is
     whatever the aircraft that came out of it is actually flying at. The sheet
     adds structure, a pack and a motor, so the mass and the area on the other
     side are not the ones asked for — and designing the bell for one CL and
     then flying it at half of that gives a wing whose washed-out tips carry
     negative lift. Different aircraft, different spanload, no bell in it.
     Build it once to find out what it weighs, then twist it. */
  const ac0 = FL.build(def);
  const S = ac0.S, CL = (ac0.mass * FL.G) / (0.5 * env.rho * V * V * S);
  const bell = bellTwist(10, { b: ac0.b, S, c0, c1, CL });
  if (twist === 'bell') { w.twist = bell; delete w.inc0; delete w.inc1; }
  /* The fair comparison is not "a wing with 10° of washout", which at this
     design CL would be flying its tips upside down. It is **the same washout,
     put on in a straight line** — same total, different distribution — which
     is the only way to ask whether the bell's shape is doing the work. */
  else if (twist === 'linear') { w.inc0 = 0; w.inc1 = bell[bell.length - 1]; delete w.twist; }
  else { w.inc0 = 0; w.inc1 = 0; delete w.twist; }
  if (sm !== null) def.staticMargin = sm;
  def.CLdes = CL;
  return def;
}

/* Where the centre of gravity has to be for this wing to fly at its design
   point with the elevons doing nothing.

   This is not a detail. A flying wing's spanload is whatever its twist and its
   elevons add up to, so a wing trimmed on 100% elevon is not flying the
   spanload it was built with — and the build sheet places the CG from a
   lift-slope-weighted quarter-chord that knows nothing about twist. Bisect the
   static margin until the trim deflection is nearly zero, then measure. Every
   planform in the sweep gets this done to it, or the comparison is between
   trim states rather than between shapes. */


/* ---------------- trimming it, in the model being measured ----------------
   FL.trim() solves the *lightweight* model, and it is a four-variable Newton
   solve that gives up on a small wing with ten degrees of washout in it — it
   reported `ok: false` on most of the planforms in the sweep below, which is
   how this was found. Trimming in one model and measuring the spanload in
   another is wrong anyway: the induced flow is the thing under study and only
   the accurate model has it.

   So: nested bisection against the real step. Each loop is monotonic on its
   own — more elevon is more nose-up, more alpha is more lift — which is why
   this converges where a Newton solve on all four at once does not.

   The probe steps sixty times at a hundredth of a millisecond. The circulation
   solve relaxes once per step regardless of the step size, so that is sixty
   iterations of the lifting line against six hundredths of a millisecond of
   flight: converged circulation, and a state that has not moved. */
function probe(ac, V, alpha, e, thr = 0.5) {
  const s = FL.makeState();
  s.p = [0, 0, -300];
  // the body pitched up by alpha with the velocity along the *world* x: that is
  // an angle of attack. Putting the velocity along the body axis is not.
  s.q = FL.quatFromEuler(0, alpha, 0);
  s.v = [V, 0, 0];
  s.n = thr; s.se = FL.sat(e) * ac.defl.e; s.sa = 0; s.gear = 0;
  const ctl = { thr, a: 0, e, r: 0, gear: 0 };
  const dt = 1e-5;
  for (let i = 0; i < 26; i++) FL.step(s, ac, ctl, env, dt);
  const v0 = s.v.slice(), w0 = s.w.slice();
  FL.step(s, ac, ctl, env, dt);
  return { az: (s.v[2] - v0[2]) / dt, aq: (s.w[1] - w0[1]) / dt, s };
}
// the angle of attack that carries the weight at this speed, at a fixed elevon
const A_LO = -10 * D2R, A_HI = 24 * D2R;
function alphaFor(ac, V, e) {
  let lo = A_LO, hi = A_HI;
  for (let i = 0; i < 16; i++) { const m = 0.5 * (lo + hi); if (probe(ac, V, m, e).az > 0) lo = m; else hi = m; }
  return 0.5 * (lo + hi);
}
function trimIt(ac, V) {
  const e = (() => { // elevon for no pitching moment, at the alpha that carries the weight
    let lo = -1, hi = 1, a = alphaFor(ac, V, 0);
    for (let i = 0; i < 14; i++) {
      const m = 0.5 * (lo + hi);
      a = alphaFor(ac, V, m);
      if (probe(ac, V, a, m).aq > 0) hi = m; else lo = m;
    }
    return 0.5 * (lo + hi);
  })();
  const alpha = alphaFor(ac, V, e), r = probe(ac, V, alpha, e);
  /* A trim is only a trim if it carries the weight without the search running
     into the end of its own bracket. A wing asked to fly below the speed its
     washout leaves it will sit at the alpha limit still sinking, and every
     number downstream of that — spanload, span efficiency, proverse yaw — is
     then describing an aircraft falling out of the sky. Say so instead. */
  const pinned = alpha > A_HI - 0.4 * D2R || alpha < A_LO + 0.4 * D2R;
  const why = pinned ? `${(alpha * R2D).toFixed(0)}° alpha, at the end of the search`
    : Math.abs(r.az) >= 0.3 ? `${Math.abs(r.az).toFixed(1)} m/s² of ${r.az > 0 ? 'sink' : 'climb'} left at trim`
    : Math.abs(e) >= 0.97 ? `${(e * 100).toFixed(0)}% elevon and still not trimmed` : '';
  return { alpha, e, az: r.az, aq: r.aq, s: r.s, why, ok: !why };
}

/* Where the centre of gravity has to be for the elevons to be doing nothing.

   Not a search: one probe gives the pitching moment and the lift at once, and
   a moment divided by a lift is the distance the centre of gravity has to move
   to cancel it. Three passes of that converges from anywhere, where bisecting
   on the static margin needed eighteen rebuilds and still missed on the wings
   that needed the most. */
function cgFor(mk, V) {
  let sm = 0.12, out = null;
  for (let k = 0; k < 4; k++) {
    const def = mk(sm), ac = FL.build(def);
    const a = alphaFor(ac, V, 0), r = probe(ac, V, a, 0);
    const M = r.aq * ac.I[1], L = ac.mass * FL.G;
    out = { sm, def, ac };
    const d = M / (L * ac.mac);
    if (Math.abs(d) < 0.002) break;
    sm = FL.clamp(sm + FL.clamp(d, -0.25, 0.25), -0.1, 0.6);
  }
  const ac = FL.build(out.def);
  return { sm: out.sm, def: out.def, ac, tr: trimIt(ac, V) };
}

/* Fly it level at a speed and read the spanload off the lifting line. `s.gam`
   is the circulation the solve settled on and `ac._hb.wi` the induced velocity
   it found at each strip — the two numbers this whole file is about. */
function spanload(def0, V, pre) {
  const got = pre || cgFor((sm) => Object.assign({}, def0, { staticMargin: sm }), V);
  const def = got.def, ac = got.ac, tr = got.tr, s = tr.s;
  const rows = [];
  ac.strips.forEach((st, i) => {
    if (st.role !== 'wing' || st.side < 0) return;
    rows.push({ y: st.r[1], eta: st.r[1] / (ac.b / 2), chord: st.chord, dy: st.area / st.chord, gam: s.gam[i], wi: ac._hb.wi[i], Vin: ac._hb.Vin[i] });
  });
  rows.sort((p, q) => p.eta - q.eta);
  /* Induced drag and lift read off the solved circulation, the classical way:
     Dᵢ = ρ·ΣΓᵢwᵢΔy and L = ρV·ΣΓᵢΔy, both doubled for the other half of the
     wing. Span efficiency is then CL²/(π·AR·CDᵢ) — and on a bell it is
     *supposed* to come out below 1, because the bell is not trying to minimise
     induced drag for a given span. It is minimising it for a given root
     bending moment, which is a different and more useful thing to be good at. */
  let L = 0, Di = 0, Mb = 0;
  for (const q of rows) { L += q.gam * q.dy; Di += q.gam * q.wi * q.dy; Mb += q.gam * q.y * q.dy; }
  const qS = 0.5 * env.rho * V * V * ac.S;
  const CLw = (2 * env.rho * V * L) / qS, CDi = (2 * env.rho * Di) / qS;
  const e = CDi > 1e-9 ? (CLw * CLw) / (Math.PI * ac.ARw * CDi) : NaN;
  /* How far out the lift is sitting, as a fraction of the semi-span: the
     spanwise centroid of the circulation. This is the number the root bending
     moment is proportional to at a given weight, and it is what the bell is
     actually buying. An ellipse puts its lift at 4/(3π) = 0.424 of the
     semi-span; a bell pulls it inboard, and that is what pays for the span
     efficiency it gives away. */
  const ybar = L > 1e-9 ? Mb / L / (ac.b / 2) : NaN;
  /* How far the wing has departed from the bell it was built to be, and why.
     A bell asks the root to carry a much higher section lift coefficient than
     the mean, so there is a design CL above which the root reaches its own
     stall first: the load spills outboard, the distribution relaxes back
     towards an ellipse, and the proverse yaw goes with it. That is a real
     ceiling on the shape and the sweep below walks straight into it. */
  const stall = Math.max(s.tele.stallL, s.tele.stallR);
  const bellErr = rows.reduce((q, r2) => q + Math.abs(r2.gam / rows[0].gam - Math.pow(Math.max(0, 1 - r2.eta * r2.eta), 1.5)), 0) / rows.length;
  return { ac, tr, s, rows, ok: tr.ok, sm: got.sm, def, CLw, CDi, e, ybar, stall, bellErr, pre: got };
}

/* Roll it and see which way the nose goes. A tiny step from trim with the
   aileron over: the sign of the yaw acceleration against the roll acceleration
   is the whole question, and the ratio is how much of it there is. */
function yawWithRoll(def0, V, ail = 0.6, pre) {
  const got = pre || cgFor((sm) => Object.assign({}, def0, { staticMargin: sm }), V);
  const ac = got.ac, tr = got.tr;
  const dt = 1 / 2000;
  const run = (a) => {
    const s = FL.makeState();
    s.p = [0, 0, -300]; s.q = FL.quatFromEuler(0, tr.alpha, 0);
    s.v = FL.mulMV(FL.quatToMat(s.q), [V, 0, 0]);
    s.n = 0.5; s.se = FL.sat(tr.e) * ac.defl.e;
    const ctl = { thr: 0.5, a, e: tr.e, r: 0 };
    for (let i = 0; i < 30; i++) FL.step(s, ac, ctl, env, dt);
    return { p: s.w[0] / (30 * dt), r: s.w[2] / (30 * dt) };
  };
  const base = run(0), over = run(ail);
  const p = over.p - base.p, r = over.r - base.r;
  return { ac, p, r, ratio: Math.abs(p) > 1e-6 ? r / p : 0, tr };
}

/* ---------------- the baseline ---------------- */
const b0 = Number(process.argv[2]) || 3.75;
const c00 = Number(process.argv[3]) || 0.4;
const sw0 = process.argv[4] !== undefined ? Number(process.argv[4]) : 24;
const V0 = Number(process.argv[5]) || 11;
const M0 = Number(process.argv[6]) || 2.2 * Math.pow(b0 / 3.75, 2); // kg; a 3.75 m composite wing, scaled by area

line(`== A bell spanload on a ${b0} m wing, no fin — the Prandtl-D idea ==`);
{
  const def = wing({ b: b0, c0: c00, sweep: sw0, V: V0, mass: M0 });
  const w = def.surfaces.find((s) => s.role === 'wing');
  const r = spanload(def, V0);
  const ac = r.ac;
  line(`${b0} m span, ${(c00 * 1000).toFixed(0)}–${(c00 * 0.35 * 1000).toFixed(0)} mm chord, ${sw0}° sweep: S ${ac.S.toFixed(3)} m², AR ${ac.ARw.toFixed(1)}, ${ac.strips.filter((x) => x.role === 'wing').length} strips`);
  line(`design CL at ${V0} m/s and ${(M0 * 1000).toFixed(0)} g: ${def.CLdes.toFixed(3)} — the washout below is derived for that, and grows with it`);
  line(`washout, root to tip: ${w.twist.map((x) => x.toFixed(1)).join(' / ')}° — ${(-w.twist[w.twist.length - 1]).toFixed(1)}° of it in all`);
  line(`CG solved to ${(r.sm * 100).toFixed(1)}% MAC of static margin; trimmed at ${(r.tr.alpha * R2D).toFixed(2)}° alpha, elevon ${(r.tr.e * 100).toFixed(1)}%${r.tr.ok ? '' : '  ** DID NOT TRIM **'}`);
  line(`induced drag CDᵢ ${r.CDi.toFixed(5)} at CL ${r.CLw.toFixed(3)} — span efficiency ${r.e.toFixed(3)}, lift centroid at ${r.ybar.toFixed(3)} of the semi-span`);
  line(`${(r.stall * 100).toFixed(0)}% of the wing separated at trim; the circulation is ${(r.bellErr * 100).toFixed(1)}% off the bell`);
  /* The bell's own span efficiency is not a free parameter: with A₃ = −A₁/3 it
     is exactly 1/(1 + 3·(1/3)²) = 0.75, and an independent numerical lifting
     line landing on that is the strongest evidence here that the solve and the
     theory are describing the same wing. */
  ok(Math.abs(r.e - 0.75) < 0.06, 'and its span efficiency is the 0.75 the bell series says it must be',
    `${r.e.toFixed(3)} — an ellipse would be 1.000, and giving that up is the point`);
  /* Span efficiency is computed from the same discrete circulation the solve
     produced, so on a near-elliptical wing it lands a per cent or two over
     1.000 — that is the 16-strip discretisation, not a wing beating theory.
     The differences between shapes here are far larger than that. */
  ok(r.ybar < 0.424, 'the lift sits further inboard than an ellipse would put it',
    `${r.ybar.toFixed(3)} against 4/(3π) = 0.424 of the semi-span — less root bending for the same lift`);

  // the spanload itself, against the bell it is supposed to be
  const g0 = r.rows[0].gam;
  line('\n  η      chord   Γ/Γ₀   bell    w/V      what the section is doing');
  for (const q of r.rows) {
    const bell = Math.pow(Math.max(0, 1 - q.eta * q.eta), 1.5);
    const wv = q.wi / q.Vin;
    line(`  ${q.eta.toFixed(3)}  ${(q.chord * 1000).toFixed(0)} mm  ${(q.gam / g0).toFixed(3)}  ${bell.toFixed(3)}  ${wv >= 0 ? '+' : ''}${wv.toFixed(4)}  ${wv < 0 ? 'upwash — induced THRUST' : 'downwash — induced drag'}`);
  }
  // where the downwash changes sign, which theory puts at 1/√2
  let cross = null;
  for (let i = 1; i < r.rows.length; i++) {
    const a = r.rows[i - 1].wi, c = r.rows[i].wi;
    if (a > 0 && c <= 0) cross = r.rows[i - 1].eta + ((r.rows[i].eta - r.rows[i - 1].eta) * a) / (a - c);
  }
  line('');
  ok(cross !== null, 'the downwash changes sign somewhere out along the span',
    cross === null ? 'it never does — this is not a bell' : `at η = ${cross.toFixed(3)}`);
  if (cross !== null) ok(Math.abs(cross - 0.707) < 0.1, 'and it does it where Prandtl says it should', `η ${cross.toFixed(3)} against 1/√2 = 0.707`);
  ok(r.bellErr < 0.03, 'the circulation the solve settles on is the bell it was built for', `mean error ${r.bellErr.toFixed(3)} of Γ₀`);
}

/* ---------------- the thing the shape is for ---------------- */
line('\n== roll it, and see which way the nose goes ==');
{
  const rows = [];
  for (const [label, twist, fin] of [['bell spanload, no fin', 'bell', false], ['same washout, linear', 'linear', false], ['no twist at all', 'none', false], ['bell spanload, with a fin', 'bell', true]]) {
    const def = wing({ b: b0, c0: c00, sweep: sw0, twist, fin, V: V0, mass: M0 });
    const sl = spanload(def, V0), y = yawWithRoll(def, V0, 0.6, sl.pre);
    rows.push({ label, ...y, e: sl.e, ybar: sl.ybar });
    line(`  ${label.padEnd(26)} yaw ${(y.r * R2D >= 0 ? '+' : '') + (y.r * R2D).toFixed(1).padStart(5)}°/s² on ${(y.p * R2D).toFixed(0).padStart(4)}°/s² of roll  ·  e ${sl.e.toFixed(3)}  ·  lift centroid ${sl.ybar.toFixed(3)}  ·  ${y.r > 0 ? 'PROVERSE' : 'adverse'}`);
  }
  const bell = rows[0], lin = rows[1], flat = rows[2], finned = rows[3];
  ok(bell.r > 0, 'the bell spanload yaws into its own roll', `${(bell.r * R2D).toFixed(1)}°/s² of yaw with ${(bell.p * R2D).toFixed(0)}°/s² of roll`);
  ok(bell.ratio > flat.ratio, 'and it does better at it than the same planform untwisted',
    `${bell.ratio.toFixed(3)} against ${flat.ratio.toFixed(3)} of yaw per unit roll`);
  ok(Math.abs(bell.ratio - finned.ratio) < 0.2 * Math.abs(bell.ratio), 'and it does not need the fin to do it',
    `${bell.ratio.toFixed(3)} without a fin, ${finned.ratio.toFixed(3)} with one — the yaw is coming off the spanload, not off a surface`);
  /* The honest result, and not the one the story usually tells: putting the
     same washout on in a straight line yaws harder. It does it by unloading
     the tips further still, and it pays for it — so the comparison that
     matters is not yaw alone but yaw against what the wing gives up to get it. */
  line(`\n  A straight-line washout of the same total yaws ${(lin.ratio / bell.ratio).toFixed(2)}× as hard as the bell does.`);
  line(`  It gets there by throwing the tips away harder: lift centroid ${lin.ybar.toFixed(3)} against the bell's ${bell.ybar.toFixed(3)},`);
  line(`  and span efficiency ${lin.e.toFixed(3)} against ${bell.e.toFixed(3)}. Proverse yaw is cheap if you do not mind a worse wing;`);
  line('  the bell is the shape that gets it while being the best wing it can be for the spar it has.');
}

/* ---------------- the sweep ----------------
   The question this was built to answer: what happens to all of that on a
   smaller wing. The twist is recomputed for every planform, because the bell
   is a shape the washout has to be derived for and not a number to copy. */
line('\n== what the planform does to it ==');
/* Every row is flown at its own design speed, not at the baseline's. Measuring
   a wing twisted for 22 m/s while flying it at 11 is a comparison between two
   different aircraft and reads as a flat line where there should be a trend. */
function sweepRow(label, def, V = V0) {
  let r, y;
  try { r = spanload(def, V); y = yawWithRoll(def, V, 0.6, r.pre); } catch (e) { return `${label.padEnd(22)} — ${e.message}`; }
  const ac = r.ac;
  let cross = null;
  for (let i = 1; i < r.rows.length; i++) {
    const a = r.rows[i - 1].wi, c = r.rows[i].wi;
    if (a > 0 && c <= 0) cross = r.rows[i - 1].eta + ((r.rows[i].eta - r.rows[i - 1].eta) * a) / (a - c);
  }
  const up = r.rows.filter((q) => q.wi < 0).length / r.rows.length;
  if (!r.tr.ok) return `${label.padEnd(22)} would not trim at ${V} m/s — ${r.tr.why}`;
  const gone = r.bellErr > 0.06;
  return `${label.padEnd(22)} AR ${ac.ARw.toFixed(1).padStart(4)}  CL ${r.CLw.toFixed(2)}${r.tr.ok ? ' ' : '!'} washout ${(-r.def.surfaces[0].twist[9]).toFixed(1).padStart(4)}°  upwash η ${cross === null ? ' —  ' : cross.toFixed(2)}  e ${r.e.toFixed(3)}  yaw/roll ${(y.ratio >= 0 ? '+' : '') + y.ratio.toFixed(3)}  ${gone ? `BELL LOST (${(r.bellErr * 100).toFixed(0)}% off, ${(r.stall * 100).toFixed(0)}% separated)` : y.r > 0 ? 'proverse' : 'adverse'}`;
}
line('\n-- span, at a fixed chord (the wing gets slenderer) --');
for (const b of [0.75, 1.0, 1.5, 2.0, 2.75, 3.75, 5.0]) line(sweepRow(`${b} m span`, wing({ b, c0: c00, sweep: sw0, V: V0, mass: M0 * Math.pow(b / 3.75, 2) })));
line('\n-- chord, at a fixed span (the wing gets stubbier) --');
for (const c of [0.2, 0.3, 0.4, 0.55, 0.75]) line(sweepRow(`${(c * 1000).toFixed(0)} mm root`, wing({ b: b0, c0: c, sweep: sw0, V: V0, mass: M0 })));
line('\n-- sweep, at a fixed planform --');
for (const sw of [0, 10, 20, 24, 32, 40]) line(sweepRow(`${sw}° sweep`, wing({ b: b0, c0: c00, sweep: sw, V: V0, mass: M0 })));
/* And the ceiling. The bell needs the root to carry far more section lift than
   the mean, so winding the design CL up walks the root into its own stall —
   and a wing whose root has let go is not flying a bell any more, whatever it
   was built to. This is the limit worth knowing before shrinking one. */
line('\n-- design CL, on a 1 m wing: where the shape gives up --');
for (const m of [0.12, 0.2, 0.3, 0.42, 0.55]) line(sweepRow(`${(m * 1000).toFixed(0)} g at 13 m/s`, wing({ b: 1.0, c0: 0.2, sweep: sw0, V: 13, mass: m }), 13));
line('\n-- the same 1 m wing, flown faster instead --');
for (const V of [8, 10, 13, 17, 22]) line(sweepRow(`${V} m/s at 300 g`, wing({ b: 1.0, c0: 0.2, sweep: sw0, V, mass: 0.3 }), V));

line(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
