/* =====================================================================
   Flightline flight model — strip theory, pure JavaScript (no DOM).

   Frames: world = NED (x north, y east, z down, metres; ground at z = 0)
           body  = FRD (x forward, y right wing, z down), origin at the CG
   Control sign convention (servo channels, radians):
     a + -> roll right, e + -> nose up, r + -> nose right
   Strip flap deflection d is + when the trailing edge moves toward -n
   (i.e. "trailing edge down" on a wing), which adds lift along +n.

   Every lifting surface is cut into spanwise strips. Each strip sees its
   own airflow (aircraft velocity + rotation), its own angle of attack,
   its own stall, and its own flap. Roll/pitch/yaw damping, dihedral
   effect, weathervaning, wing drop and spin autorotation are not
   programmed in — they come out of summing the strips.
   ===================================================================== */
const FL = (function () {
  'use strict';
  const G = 9.80665;
  const RHO0 = 1.225;
  const D2R = Math.PI / 180;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sat = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
  const approach = (x, t, d) => (x < t ? Math.min(t, x + d) : Math.max(t, x - d));
  const lerp = (a, b, t) => a + (b - a) * t;
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  function quatToMat(q) {
    const w = q[0], x = q[1], y = q[2], z = q[3];
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
  }
  const mulMV = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  const mulMtV = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  function quatFromEuler(roll, pitch, yaw) {
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
  }
  function eulerFromMat(R) {
    return { roll: Math.atan2(R[7], R[8]), pitch: -Math.asin(clamp(R[6], -1, 1)), yaw: Math.atan2(R[3], R[0]) };
  }

  /* International Standard Atmosphere (troposphere): density at a field
     elevation and actual temperature, plus density altitude. */
  function atmosphere(elevFt, tempF) {
    const T0 = 288.15, L = 0.0065, R = 287.053, p0 = 101325;
    const h = elevFt * 0.3048;
    const p = p0 * Math.pow(1 - (L * h) / T0, G / (R * L));
    const T = ((tempF - 32) * 5) / 9 + 273.15;
    const rho = p / (R * T);
    const n = G / (R * L) - 1;
    const da = (T0 / L) * (1 - Math.pow(rho / RHO0, 1 / n));
    return { rho, p, T, daFt: da / 0.3048, isaTempF: ((T0 - L * h - 273.15) * 9) / 5 + 32 };
  }

  // open-circuit volts per cell vs state of charge
  const CELL = {
    lipo: [[0, 3.3], [0.05, 3.5], [0.1, 3.62], [0.2, 3.7], [0.4, 3.78], [0.6, 3.87], [0.8, 4.0], [0.95, 4.12], [1, 4.2]],
    liion: [[0, 2.8], [0.05, 3.1], [0.1, 3.3], [0.2, 3.45], [0.4, 3.6], [0.6, 3.75], [0.8, 3.95], [0.95, 4.1], [1, 4.2]],
  };
  function cellOCV(chem, soc) {
    const t = CELL[chem] || CELL.lipo;
    for (let i = 1; i < t.length; i++) if (soc <= t[i][0]) { const a = t[i - 1], b = t[i]; return a[1] + ((soc - a[0]) / (b[0] - a[0])) * (b[1] - a[1]); }
    return t[t.length - 1][1];
  }

  /* Thin-airfoil flap theory, scaled by 0.85 for real (thick, gapped) surfaces.
     cf = flap chord / local chord.
     tau : change in angle of attack per radian of flap
     cmd : change in section pitching moment (about 1/4 chord) per radian */
  function flapTheory(cf) {
    const th = Math.acos(2 * cf - 1);
    return { tau: 0.85 * (1 - (th - Math.sin(th)) / Math.PI), cmd: (-0.85 * (Math.sin(th) * (1 - Math.cos(th)))) / 2 };
  }

  /* ---------------------------------------------------------------
     Aircraft definitions. Lengths in metres, angles in degrees.
     Surface: xLE = leading-edge position (body x), c = chord,
     y0..y1 = span stations from the centreline.
     foil.a = 3-D lift-curve slope (per rad) for that surface's aspect ratio.
     --------------------------------------------------------------- */
  const DEFS = {
    goblin: {
      id: 'goblin',
      name: 'Nano Goblin',
      blurb: '580 mm plank wing, 250 g, 2S Li-ion, 3-inch pusher. Built from the Strix Nano Goblin’s published specs.',
      kind: 'wing',
      mass: 0.25,
      I: [0.0035, 0.003, 0.0062],
      staticMargin: 0.07, // CG ahead of the neutral point, fraction of MAC
      surfaces: [
        {
          name: 'wing', role: 'wing', mirror: true, n: 6,
          y0: 0, y1: 0.29, xLE0: 0.23, xLE1: 0.08, c0: 0.23, c1: 0.08, z0: 0, dihedral: 0,
          inc0: 0, inc1: -1.5, // 1.5° washout at the tip
          sweepLoad: 0.25,
          foil: { a: 3.65, CL0: 0.03, CLmax: 0.95, CLmin: -0.65, M: 30, CD0: 0.016, e: 0.85, Cm0: 0.012, CN90: 1.6 },
          flaps: [{ y0: 0.05, y1: 0.285, chord: 0.035, a: -1, e: -1, side: 'mirror' }], // elevons
        },
        {
          name: 'fin', role: 'fin', vertical: true, n: 1,
          y0: 0, y1: 0.075, xLE0: 0.07, xLE1: 0.035, c0: 0.08, c1: 0.04, z0: -0.015,
          foil: { a: 2.6, CL0: 0, CLmax: 0.9, CLmin: -0.9, M: 30, CD0: 0.015, e: 0.8, Cm0: 0, CN90: 1.6 },
          flaps: [],
        },
      ],
      body: { r: [0.12, 0, 0.0], CdA: [0.0007, 0.004, 0.006] }, // drag area m² (forward, side, top): pod + camera + antenna
      defl: { a: 9 * D2R, e: 12 * D2R, r: 0, flapMax: 20 * D2R }, // elevon throw for roll, for pitch, combined limit
      flexQ: 1200, // EPP foam: control effectiveness ÷ (1 + q/flexQ), q in Pa
      servoRate: 9,
      prop: { r: [-0.035, 0, 0], T0: 3.8, Vp: 45, D: 0.076, tau: 0.05, Tmin: -0.15, torque: -0.06, wash: false },
      batt: { chem: 'liion', cells: 2, mAh: 3200, R: 0.1, Imax: 13, Iidle: 0.45, Vref: 7.2, label: '2S 3200 Li-ion' },
      steerMax: 0,
      wheels: [],
      points: [
        { p: [0.1, 0, 0.025], name: 'belly', impact: 3.5, slide: 25 },
        { p: [0.25, 0, 0.01], name: 'nose', impact: 3.5, slide: 14 },
        { p: [0.03, -0.29, 0.005], name: 'left wingtip', impact: 3.5, slide: 12 },
        { p: [0.03, 0.29, 0.005], name: 'right wingtip', impact: 3.5, slide: 12 },
        { p: [0.0, -0.15, 0.012], name: 'left elevon', impact: 3.5, slide: 25 },
        { p: [0.0, 0.15, 0.012], name: 'right elevon', impact: 3.5, slide: 25 },
        { p: [-0.035, 0, 0.03], name: 'prop', prop: true, impact: 3.5, slide: 25 },
        { p: [0.035, 0, -0.09], name: 'fin', impact: 1.5, slide: 3 },
        { p: [0.12, 0, -0.035], name: 'canopy', impact: 1.5, slide: 3 },
      ],
      contact: { kW: 0, cW: 0, kB: 900, cB: 9, muRoll: 0, muLat: 0, muBody: 0.45 },
      crash: { wheelImpact: 99 },
      starts: ['launch', 'air'],
      trim: { a: 0.004, e: -0.08 }, // built-in mechanical trim (stick units): hands-off ≈ 40 mph
      stab: { kRoll: 1.2, dRoll: 0.04, kPitch: 1.1, dPitch: 0.05, turn: 0.4 },
      fpvCam: [0.2, 0, -0.03], // body FRD
    },

    trainer: {
      id: 'trainer',
      name: '1.5 m trainer',
      blurb: 'High-wing tricycle trainer, 1.3 kg, 3S, 10-inch prop. Slow and forgiving.',
      kind: 'conventional',
      mass: 1.3,
      I: [0.075, 0.09, 0.15],
      surfaces: [
        {
          name: 'wing', role: 'wing', mirror: true, n: 5,
          y0: 0, y1: 0.75, xLE0: 0.066, xLE1: 0.066, c0: 0.22, c1: 0.22, z0: -0.1, dihedral: 4,
          inc0: 0, inc1: 0, sweepLoad: 0,
          foil: { a: 4.8, CL0: 0.25, CLmax: 1.25, CLmin: -0.7, M: 40, CD0: 0.012, e: 0.8, Cm0: -0.06, CN90: 1.8 },
          flaps: [{ y0: 0.36, y1: 0.75, chord: 0.05, a: -1, side: 'mirror' }], // ailerons
        },
        {
          name: 'stab', role: 'tail', mirror: true, n: 2,
          y0: 0, y1: 0.25, xLE0: -0.64, xLE1: -0.64, c0: 0.12, c1: 0.12, z0: 0, dihedral: 0,
          inc0: -1.5, inc1: -1.5, sweepLoad: 0,
          foil: { a: 3.8, CL0: 0, CLmax: 0.9, CLmin: -0.9, M: 40, CD0: 0.012, e: 0.8, Cm0: 0, CN90: 1.8 },
          flaps: [{ y0: 0, y1: 0.25, chord: 0.045, e: -1, side: 'both' }], // elevator
        },
        {
          name: 'fin', role: 'fin', vertical: true, n: 2,
          y0: 0, y1: 0.17, xLE0: -0.66, xLE1: -0.7, c0: 0.13, c1: 0.09, z0: -0.03,
          foil: { a: 3.0, CL0: 0, CLmax: 0.9, CLmin: -0.9, M: 40, CD0: 0.012, e: 0.8, Cm0: 0, CN90: 1.8 },
          flaps: [{ y0: 0, y1: 0.17, chord: 0.055, r: -1 }], // rudder
        },
      ],
      body: { r: [0, 0, 0.02], CdA: [0.0065, 0.045, 0.05] },
      defl: { a: 14 * D2R, e: 17 * D2R, r: 25 * D2R, flapMax: 25 * D2R },
      flexQ: 0,
      servoRate: 8,
      prop: { r: [0.45, 0, 0], T0: 15, Vp: 30, D: 0.254, tau: 0.08, Tmin: -0.6, torque: -0.06, wash: true, eta: 0.5 },
      batt: { chem: 'lipo', cells: 3, mAh: 2200, R: 0.075, Imax: 32, Iidle: 0.3, Vref: 11.4, label: '3S 2200 LiPo' },
      steerMax: 0.3,
      wheels: [{ p: [0.32, 0, 0.17], steer: true }, { p: [-0.05, -0.17, 0.17] }, { p: [-0.05, 0.17, 0.17] }],
      points: [
        { p: [0.43, 0, 0], prop: true, name: 'nose', impact: 2.5, slide: 7 },
        { p: [-0.02, -0.75, -0.13], name: 'left wingtip', impact: 2.5, slide: 7 },
        { p: [-0.02, 0.75, -0.13], name: 'right wingtip', impact: 2.5, slide: 7 },
        { p: [-0.8, 0, 0.03], name: 'tail', impact: 3, slide: 99 },
        { p: [-0.82, 0, -0.2], name: 'fin', impact: 1.5, slide: 2 },
        { p: [0.05, 0, -0.12], name: 'wing', impact: 1.5, slide: 2 },
        { p: [-0.7, -0.25, 0], name: 'stabiliser', impact: 2.5, slide: 9 },
        { p: [-0.7, 0.25, 0], name: 'stabiliser', impact: 2.5, slide: 9 },
      ],
      contact: { kW: 2500, cW: 35, kB: 3000, cB: 40, muRoll: 0.05, muLat: 0.9, muBody: 0.6 },
      crash: { wheelImpact: 4.5 },
      starts: ['runway', 'air'],
      trim: { a: 0.004, e: -0.08 }, // built-in mechanical trim (stick units): hands-off ≈ 29 mph
      stab: { kRoll: 1.8, dRoll: 0.12, kPitch: 1.4, dPitch: 0.1, turn: 0.6 },
      fpvCam: [0.3, 0, -0.1],
    },
  };

  /* Build strips from a definition. Returns the aircraft object step() uses. */
  function build(def) {
    const ac = JSON.parse(JSON.stringify(def));
    ac.strips = [];
    let wingArea = 0, wingSpan = 0, wingSlope = 4;
    for (const sf of ac.surfaces) {
      const sides = sf.vertical ? [0] : sf.mirror ? [1, -1] : [1];
      const half = sf.y1 - sf.y0;
      const areaHalf = ((sf.c0 + sf.c1) / 2) * half;
      const span = sf.vertical ? half : 2 * sf.y1;
      const areaTot = sf.vertical ? areaHalf : 2 * areaHalf;
      const AR = sf.vertical ? (1.6 * half * half) / areaHalf : (span * span) / areaTot;
      if (sf.role === 'wing') { wingArea = areaTot; wingSpan = span; wingSlope = sf.foil.a; }
      const Gam = (sf.dihedral || 0) * D2R;
      // Schrenk load factor: local lift ∝ (actual chord + elliptic chord)/2; sweep pushes load outboard
      const loads = [];
      for (let i = 0; i < sf.n; i++) {
        const fm = (i + 0.5) / sf.n;
        const y = sf.y0 + fm * half;
        const c = lerp(sf.c0, sf.c1, fm);
        let L = 1;
        if (!sf.vertical) {
          const cEll = ((4 * areaTot) / (Math.PI * span)) * Math.sqrt(Math.max(0, 1 - Math.pow(y / (span / 2), 2)));
          L = (c + cEll) / (2 * c);
          L *= 1 + (sf.sweepLoad || 0) * (y / (span / 2) - 0.5);
        }
        loads.push({ L, w: c * (half / sf.n) });
      }
      const mean = loads.reduce((s, l) => s + l.L * l.w, 0) / loads.reduce((s, l) => s + l.w, 0);
      for (const side of sides) {
        for (let i = 0; i < sf.n; i++) {
          const fm = (i + 0.5) / sf.n;
          const y = sf.y0 + fm * half;
          const chord = lerp(sf.c0, sf.c1, fm);
          const xLE = lerp(sf.xLE0, sf.xLE1, fm);
          const inc = lerp(sf.inc0 || 0, sf.inc1 || 0, fm) * D2R;
          const width = half / sf.n;
          let r, n0;
          const c0 = [1, 0, 0];
          if (sf.vertical) {
            r = [xLE - 0.25 * chord, 0, sf.z0 - y];
            n0 = [0, 1, 0];
          } else {
            const d = [0, side * Math.cos(Gam), -Math.sin(Gam)];
            r = [xLE - 0.25 * chord, side * y * Math.cos(Gam), sf.z0 - y * Math.sin(Gam)];
            n0 = norm(cross(c0, d));
            if (n0[2] > 0) n0 = [-n0[0], -n0[1], -n0[2]];
          }
          const ci = Math.cos(inc), si = Math.sin(inc);
          const cA = [c0[0] * ci + n0[0] * si, c0[1] * ci + n0[1] * si, c0[2] * ci + n0[2] * si];
          const nA = [n0[0] * ci - c0[0] * si, n0[1] * ci - c0[1] * si, n0[2] * ci - c0[2] * si];
          const sA = cross(cA, nA);
          const L = loads[i].L / mean;
          const f = sf.foil;
          const st = {
            surf: sf.name, role: sf.role, side, y, chord, area: chord * width,
            r, r34: [r[0] - 0.5 * chord * cA[0], r[1] - 0.5 * chord * cA[1], r[2] - 0.5 * chord * cA[2]],
            c: cA, n: nA, s: sA,
            load: L,
            a: f.a, CL0: f.CL0,
            aS: (f.CLmax / L - f.CL0) / f.a, // local stall angle: strips carrying more load stall sooner
            aSn: (f.CL0 - f.CLmin / L) / f.a,
            M: f.M, CD0: f.CD0, k: 1 / (Math.PI * f.e * AR), Cm0: f.Cm0, CN90: f.CN90,
            AR, ka: 0, ke: 0, kr: 0, tau: 0, cmd: 0, cf: 0,
            wash: false,
          };
          for (const fl of sf.flaps || []) {
            if (y >= fl.y0 - 1e-9 && y <= fl.y1 + 1e-9) {
              st.cf = clamp(fl.chord / chord, 0.05, 0.6);
              const th = flapTheory(st.cf);
              st.tau = th.tau; st.cmd = th.cmd;
              const sgn = fl.side === 'mirror' ? side : 1;
              st.ka = (fl.a || 0) * sgn;
              st.ke = fl.e || 0;
              st.kr = fl.r || 0;
            }
          }
          if (ac.prop.wash) {
            const dy = r[1] - ac.prop.r[1], dz = r[2] - ac.prop.r[2];
            st.wash = r[0] < ac.prop.r[0] && Math.hypot(dy, dz) < 0.6 * ac.prop.D;
          }
          ac.strips.push(st);
        }
      }
    }
    ac.S = wingArea; ac.b = wingSpan;
    const wingStrips = ac.strips.filter((s) => s.role === 'wing');
    const ws = wingStrips.reduce((s, x) => s + x.area, 0);
    ac.mac = wingStrips.reduce((s, x) => s + x.area * x.chord, 0) / ws;
    ac.ARw = (wingSpan * wingSpan) / wingArea;
    // neutral point: lift-slope-weighted 1/4-chord position (tail reduced by the downwash gradient)
    const deda = (2 * wingSlope) / (Math.PI * ac.ARw);
    let num = 0, den = 0;
    for (const s of ac.strips) {
      if (s.role === 'fin') continue;
      const wgt = s.a * s.load * s.area * (s.role === 'tail' ? 1 - deda : 1);
      num += wgt * s.r[0]; den += wgt;
    }
    ac.xNP = num / den;
    ac.deda = deda;
    ac.xShift = 0;
    if (ac.staticMargin != null) {
      // place the CG staticMargin·MAC ahead of the neutral point (body origin = CG)
      const shift = ac.xNP + ac.staticMargin * ac.mac;
      const mv = (p) => { p[0] -= shift; };
      for (const s of ac.strips) { mv(s.r); mv(s.r34); }
      mv(ac.body.r); mv(ac.prop.r);
      for (const p of ac.points) mv(p.p);
      for (const wh of ac.wheels) mv(wh.p);
      mv(ac.fpvCam);
      ac.xShift = shift;
      ac.xNP -= shift;
    }
    ac.SM = -ac.xNP / ac.mac;
    return ac;
  }

  function makeState() {
    return {
      p: [0, 0, 0], v: [0, 0, 0], q: [1, 0, 0, 0], w: [0, 0, 0],
      n: 0, sa: 0, se: 0, sr: 0, soc: 1, mAh: 0, vb: 0, I: 0,
      crashed: false, crashMsg: '', wow: false, held: false, t: 0, clw: 0,
      tele: { alpha: 0, beta: 0, V: 0, CL: 0, qbar: 0, T: 0, nz: 1, stallL: 0, stallR: 0 },
    };
  }

  function reset(s, ac, where) {
    s.w = [0, 0, 0]; s.n = 0; s.sa = s.se = s.sr = 0;
    s.crashed = false; s.crashMsg = ''; s.mAh = 0; s.soc = 1; s.t = 0; s.held = false; s.clw = 0;
    if (where === 'air') {
      // downwind leg in front of the pilot, flying west (pilot's right to left)
      const V = ac.kind === 'wing' ? 18 : 15;
      s.p = [60, 40, -40];
      s.q = quatFromEuler(0, 0.02, -Math.PI / 2);
      s.v = mulMV(quatToMat(s.q), [V, 0, 0]);
      s.n = ac.kind === 'wing' ? 0.45 : 0.6;
    } else if (where === 'launch') {
      // held in the pilot's hand, pointing north (away from the pilot), nose up 10°
      s.p = [0.6, 0.45, -1.7];
      s.q = quatFromEuler(0, 10 * D2R, 0);
      s.v = [0, 0, 0];
      s.held = true;
    } else {
      // runway, west end, pointing east, wheels just touching
      const zw = ac.wheels.length ? ac.wheels[0].p[2] : 0.05;
      s.p = [12, -52, -zw - 0.002];
      s.q = quatFromEuler(0, 0, Math.PI / 2);
      s.v = [0, 0, 0];
    }
  }

  // hand launch: a firm throw, ~9 m/s along the nose
  function launch(s) {
    if (!s.held) return;
    s.held = false;
    s.v = mulMV(quatToMat(s.q), [9, 0, 0]);
    s.w = [0, 0, 0];
  }

  /* Section coefficients of one strip at effective angle of attack ae (rad).
     Linear lift below stall, flat-plate normal force above, blended by a
     sigmoid around the strip's own stall angles (Beard & McLain 2012). */
  function foilCoeffs(st, ae, d) {
    const e1 = Math.exp(-st.M * (ae - st.aS));
    const e2 = Math.exp(st.M * (ae + st.aSn));
    const sig = (1 + e1 + e2) / ((1 + e1) * (1 + e2)); // 0 attached … 1 stalled
    const sn = Math.sin(ae), cs = Math.cos(ae);
    const CLlin = st.load * (st.CL0 + st.a * ae);
    return {
      sig, CLlin,
      CL: (1 - sig) * CLlin + sig * st.CN90 * sn * cs,
      CDp: (1 - sig) * st.CD0 + sig * (st.CD0 + st.CN90 * sn * sn),
      Cm: (1 - sig) * (st.Cm0 + st.cmd * d) - sig * 0.2 * st.CN90 * sn,
    };
  }

  /* One fixed time step.
     ctl: { thr 0..1, a, e, r  in -1..1 }
     env: { rho, wind[3] NED m/s, battery bool, crashes bool } */
  function step(s, ac, ctl, env, dt) {
    const m = ac.mass, I = ac.I, P = ac.prop, B = ac.batt;
    s.t += dt;

    // --- motor & battery ---
    let thrCmd = s.crashed ? 0 : clamp(ctl.thr, 0, 1);
    if (env.battery && s.soc <= 0) thrCmd = 0;
    s.n += (thrCmd - s.n) * Math.min(1, dt / P.tau);
    const Icur = B.Iidle + B.Imax * s.n * s.n * s.n;
    s.I = Icur;
    s.vb = Math.max(0, B.cells * cellOCV(B.chem, env.battery ? s.soc : 1) - Icur * B.R);
    if (env.battery) { s.mAh += (Icur * dt) / 3.6; s.soc = Math.max(0, 1 - s.mAh / B.mAh); }

    // --- servos ---
    s.sa = approach(s.sa, sat(ctl.a) * ac.defl.a, ac.servoRate * dt);
    s.se = approach(s.se, sat(ctl.e) * ac.defl.e, ac.servoRate * dt);
    s.sr = approach(s.sr, sat(ctl.r) * ac.defl.r, ac.servoRate * dt);

    const rho = env.rho;
    if (s.held) { // in the pilot's hand: motor spins, nothing moves
      const rpm0 = s.n * clamp(s.vb / B.Vref, 0, 1.15);
      s.tele.T = P.T0 * (rho / RHO0) * rpm0 * rpm0; s.tele.V = 0;
      return;
    }

    const R = quatToMat(s.q);
    const wind = env.wind || [0, 0, 0];
    const vb = mulMtV(R, [s.v[0] - wind[0], s.v[1] - wind[1], s.v[2] - wind[2]]);
    const V = Math.hypot(vb[0], vb[1], vb[2]);
    const w = s.w;

    // --- propeller: static thrust ∝ rpm², falling off toward pitch speed ---
    const rpm = s.n * clamp(s.vb / B.Vref, 0, 1.15);
    const Vax = vb[0];
    let T = P.T0 * (rho / RHO0) * (rpm * rpm - (rpm * Vax) / P.Vp);
    T = Math.max(P.Tmin * (rho / RHO0) * Math.min(1, Math.abs(Vax) / P.Vp), T);
    let dWash = 0; // slipstream speed-up behind a tractor prop (momentum theory, part developed)
    if (P.wash && T > 0) {
      const A = (Math.PI * P.D * P.D) / 4, Vx = Math.max(0, Vax);
      dWash = (P.eta || 0.5) * (Math.sqrt(Vx * Vx + (2 * T) / (rho * A)) - Vx);
    }
    const F = [T, 0, 0];
    const Mo = cross(P.r, F);
    Mo[0] += P.torque * T * P.D; // prop reaction torque

    // --- lifting strips ---
    const hCG = -s.p[2];
    let clwSum = 0, clwArea = 0, stL = 0, stR = 0, aL = 0, aR = 0, aSum = 0;
    const eps = (2 * s.clw) / (Math.PI * ac.ARw); // tail downwash from last step's wing CL
    for (let i = 0; i < ac.strips.length; i++) {
      const st = ac.strips[i];
      const r = st.r34; // angle of attack taken at 3/4 chord (Pistolesi); force applied at 1/4 chord
      const v0 = vb[0] + (w[1] * r[2] - w[2] * r[1]);
      const v1 = vb[1] + (w[2] * r[0] - w[0] * r[2]);
      const v2 = vb[2] + (w[0] * r[1] - w[1] * r[0]);
      let uc = v0 * st.c[0] + v1 * st.c[1] + v2 * st.c[2];
      const un = v0 * st.n[0] + v1 * st.n[1] + v2 * st.n[2];
      if (st.wash) uc += dWash;
      const V2 = uc * uc + un * un;
      if (V2 < 0.04) continue;
      const Vin = Math.sqrt(V2);
      let alpha = Math.atan2(-un, uc);
      if (st.role === 'tail') alpha -= eps;
      const d = clamp(st.ka * s.sa + st.ke * s.se + st.kr * s.sr, -ac.defl.flapMax, ac.defl.flapMax);
      const flex = ac.flexQ ? 1 / (1 + (0.5 * rho * V2) / ac.flexQ) : 1;
      let ae = alpha + st.tau * d * flex;
      if (ae > Math.PI) ae -= 2 * Math.PI; else if (ae < -Math.PI) ae += 2 * Math.PI;
      const cf = foilCoeffs(st, ae, d * flex);
      // induced drag, reduced in ground effect (McCormick)
      const hz = hCG - (R[6] * st.r[0] + R[7] * st.r[1] + R[8] * st.r[2]);
      const g16 = (16 * Math.max(0.02, hz)) / (ac.b || 1);
      const ge = st.role === 'fin' ? 1 : (g16 * g16) / (1 + g16 * g16);
      const CD = cf.CDp + (1 - cf.sig) * st.k * ge * cf.CLlin * cf.CLlin;
      const qs = ((w[0] * st.s[0] + w[1] * st.s[1] + w[2] * st.s[2]) * st.chord) / Vin;
      const Cm = cf.Cm - 0.4 * qs; // section pitch-rate damping
      const qS = 0.5 * rho * V2 * st.area;
      const vh0 = (uc * st.c[0] + un * st.n[0]) / Vin, vh1 = (uc * st.c[1] + un * st.n[1]) / Vin, vh2 = (uc * st.c[2] + un * st.n[2]) / Vin;
      const lh0 = st.s[1] * vh2 - st.s[2] * vh1, lh1 = st.s[2] * vh0 - st.s[0] * vh2, lh2 = st.s[0] * vh1 - st.s[1] * vh0; // lift ⟂ local flow
      const L = qS * cf.CL, D = qS * CD;
      const f0 = L * lh0 - D * vh0, f1 = L * lh1 - D * vh1, f2 = L * lh2 - D * vh2;
      F[0] += f0; F[1] += f1; F[2] += f2;
      const p = st.r, mc = qS * st.chord * Cm;
      Mo[0] += p[1] * f2 - p[2] * f1 + mc * st.s[0];
      Mo[1] += p[2] * f0 - p[0] * f2 + mc * st.s[1];
      Mo[2] += p[0] * f1 - p[1] * f0 + mc * st.s[2];
      if (st.role === 'wing') {
        clwSum += cf.CL * st.area; clwArea += st.area; aSum += alpha * st.area;
        if (st.side > 0) { stR += cf.sig * st.area; aR += st.area; } else { stL += cf.sig * st.area; aL += st.area; }
      }
    }
    s.clw = clwArea > 0 ? clwSum / clwArea : 0;

    // --- fuselage / pod drag ---
    if (V > 0.1) {
      const Bd = ac.body, k = 0.5 * rho * V;
      const fb = [-k * Bd.CdA[0] * vb[0], -k * Bd.CdA[1] * vb[1], -k * Bd.CdA[2] * vb[2]];
      F[0] += fb[0]; F[1] += fb[1]; F[2] += fb[2];
      const mb = cross(Bd.r, fb);
      Mo[0] += mb[0]; Mo[1] += mb[1]; Mo[2] += mb[2];
    }
    // small structural damping that never fades (keeps a parked model from spinning forever)
    Mo[0] -= 0.02 * I[0] * w[0]; Mo[1] -= 0.02 * I[1] * w[1]; Mo[2] -= 0.02 * I[2] * w[2];

    const Fw = mulMV(R, F);
    Fw[2] += m * G;

    // --- ground contact: spring–damper per point, regularised Coulomb friction ---
    const C = ac.contact;
    let wow = false, crash = null;
    const Fcb = [0, 0, 0];
    const contactPt = (pt, isWheel) => {
      const r = pt.p;
      const rw = mulMV(R, r);
      const pz = s.p[2] + rw[2];
      if (pz <= 0) return;
      const vp = mulMV(R, cross(w, r));
      vp[0] += s.v[0]; vp[1] += s.v[1]; vp[2] += s.v[2];
      const k = isWheel ? C.kW : C.kB, c = isWheel ? C.cW : C.cB;
      const N = Math.max(0, k * pz + c * vp[2]);
      let fx = 0, fy = 0, rolled = false;
      if (isWheel) {
        const stA = pt.steer && ac.defl.r ? (s.sr / ac.defl.r) * ac.steerMax : 0;
        const fwv = mulMV(R, [Math.cos(stA), Math.sin(stA), 0]);
        const nh = Math.hypot(fwv[0], fwv[1]);
        if (nh > 0.3) {
          const hx = fwv[0] / nh, hy = fwv[1] / nh;
          const vl = vp[0] * hx + vp[1] * hy, vt = -vp[0] * hy + vp[1] * hx;
          const Fl = -C.muRoll * N * sat(vl / 0.3), Ft = -C.muLat * N * sat(vt / 0.1);
          fx = Fl * hx - Ft * hy; fy = Fl * hy + Ft * hx; rolled = true;
        }
      }
      if (!rolled) {
        const vh = Math.hypot(vp[0], vp[1]);
        if (vh > 1e-6) { const f = (-C.muBody * N * sat(vh / 0.2)) / vh; fx = f * vp[0]; fy = f * vp[1]; }
      }
      const Fc = [fx, fy, -N];
      Fw[0] += Fc[0]; Fw[1] += Fc[1]; Fw[2] += Fc[2];
      const fb = mulMtV(R, Fc);
      Fcb[0] += fb[0]; Fcb[1] += fb[1]; Fcb[2] += fb[2];
      const mc = cross(r, fb);
      Mo[0] += mc[0]; Mo[1] += mc[1]; Mo[2] += mc[2];
      const impact = vp[2], slide = Math.hypot(vp[0], vp[1]);
      if (isWheel) {
        wow = true;
        if (impact > ac.crash.wheelImpact) crash = 'Hard landing — gear folded';
      } else {
        if (pt.name === 'belly') wow = true;
        if (pt.prop && s.n > 0.25 && Math.hypot(vp[0], vp[1], vp[2]) > 0.5) crash = 'Prop strike — motor still running at touchdown';
        else if (impact > pt.impact || slide > pt.slide) crash = 'Crashed — ' + pt.name + ' hit the ground';
      }
    };
    for (const wh of ac.wheels) contactPt(wh, true);
    for (const b of ac.points) contactPt(b, false);
    s.wow = wow;
    if (crash && env.crashes && !s.crashed) { s.crashed = true; s.crashMsg = crash; }

    // --- integrate (semi-implicit Euler, quaternion attitude) ---
    s.v[0] += (Fw[0] / m) * dt; s.v[1] += (Fw[1] / m) * dt; s.v[2] += (Fw[2] / m) * dt;
    s.p[0] += s.v[0] * dt; s.p[1] += s.v[1] * dt; s.p[2] += s.v[2] * dt;
    const gy = cross(w, [I[0] * w[0], I[1] * w[1], I[2] * w[2]]);
    w[0] += ((Mo[0] - gy[0]) / I[0]) * dt;
    w[1] += ((Mo[1] - gy[1]) / I[1]) * dt;
    w[2] += ((Mo[2] - gy[2]) / I[2]) * dt;
    const q = s.q, h = 0.5 * dt;
    const nq = [
      q[0] + h * (-q[1] * w[0] - q[2] * w[1] - q[3] * w[2]),
      q[1] + h * (q[0] * w[0] + q[2] * w[2] - q[3] * w[1]),
      q[2] + h * (q[0] * w[1] - q[1] * w[2] + q[3] * w[0]),
      q[3] + h * (q[0] * w[2] + q[1] * w[1] - q[2] * w[0]),
    ];
    const qn = Math.hypot(nq[0], nq[1], nq[2], nq[3]);
    s.q = [nq[0] / qn, nq[1] / qn, nq[2] / qn, nq[3] / qn];

    const t = s.tele;
    t.alpha = clwArea > 0 ? aSum / clwArea : 0;
    t.beta = V > 0.3 ? Math.asin(clamp(vb[1] / V, -1, 1)) : 0;
    t.V = V; t.qbar = 0.5 * rho * V * V; t.T = T; t.CL = s.clw;
    t.nz = -(F[2] + Fcb[2]) / (m * G);
    t.stallL = aL ? stL / aL : 0; t.stallR = aR ? stR / aR : 0;

    if (!Number.isFinite(s.p[0] + s.p[1] + s.p[2] + s.q[0] + w[0] + w[1] + w[2])) {
      reset(s, ac, ac.starts[0]);
      s.crashMsg = 'Simulation reset (numerical error)';
    }
  }

  /* Stabilised mode, like ArduPilot FBWA / iNav ANGLE for planes:
     roll stick commands bank (±45°), pitch stick commands pitch (±30°). */
  function stabilize(cmd, s, ac) {
    const g = ac.stab;
    const eu = eulerFromMat(quatToMat(s.q));
    let ep = cmd.a * 0.785 - eu.roll;
    if (ep > Math.PI) ep -= 2 * Math.PI; else if (ep < -Math.PI) ep += 2 * Math.PI;
    const a = sat(g.kRoll * ep - g.dRoll * s.w[0]);
    const turn = g.turn * (1 / Math.max(0.5, Math.cos(eu.roll)) - 1);
    const e = sat(g.kPitch * (cmd.e * 0.52 - eu.pitch) - g.dPitch * s.w[1] + turn);
    return { thr: cmd.thr, a, e, r: cmd.r };
  }

  /* ---------------- Trim and performance (used by tests and the model notes) ----------------
     Accelerations for straight, wings-level flight at airspeed V, angle of attack alpha,
     elevator e and aileron a (stick units) and throttle thr, from one tiny step. */
  function accelAt(ac, V, alpha, e, thr, a, rho) {
    const env = { rho, wind: [0, 0, 0], battery: false, crashes: false };
    const mk = () => {
      const s = makeState();
      s.p = [0, 0, -200]; s.q = quatFromEuler(0, alpha, 0); s.v = [V, 0, 0];
      s.n = thr; s.sa = sat(a) * ac.defl.a; s.se = sat(e) * ac.defl.e;
      return s;
    };
    const dt = 1e-5;
    let s = mk();
    step(s, ac, { thr, a, e, r: 0 }, env, dt); // first pass sets wing CL for tail downwash
    const clw = s.clw;
    s = mk(); s.clw = clw;
    step(s, ac, { thr, a, e, r: 0 }, env, dt);
    return [(s.v[2]) / dt, (s.v[0] - V) / dt, s.w[1] / dt, s.w[0] / dt, clw];
  }
  function solve4(A, b) {
    const n = 4, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function trim(ac, V, rho = RHO0, x0) {
    let x = x0 ? [x0.alpha, x0.e, x0.thr, x0.a] : [0.05, 0, 0.5, 0];
    const H = [1e-4, 1e-3, 1e-3, 1e-3];
    for (let it = 0; it < 40; it++) {
      const f = accelAt(ac, V, x[0], x[1], x[2], x[3], rho).slice(0, 4);
      if (Math.abs(f[0]) + Math.abs(f[1]) < 1e-4 && Math.abs(f[2]) + Math.abs(f[3]) < 1e-3) break;
      const J = [[], [], [], []];
      for (let j = 0; j < 4; j++) {
        const xp = x.slice(); xp[j] += H[j];
        const fp = accelAt(ac, V, xp[0], xp[1], xp[2], xp[3], rho);
        for (let i = 0; i < 4; i++) J[i][j] = (fp[i] - f[i]) / H[j];
      }
      const dx = solve4(J, f.map((v) => -v));
      if (!dx) break;
      for (let j = 0; j < 4; j++) x[j] += clamp(dx[j], -0.2, 0.2);
      x[2] = clamp(x[2], 0, 1.5);
    }
    const f = accelAt(ac, V, x[0], x[1], x[2], x[3], rho);
    const ok = x[2] <= 1.0001 && Math.abs(f[0]) < 0.05 && Math.abs(f[1]) < 0.05 && Math.abs(x[1]) <= 1.0001;
    return { V, alpha: x[0], e: x[1], thr: x[2], a: x[3], CL: f[4], ok };
  }
  // whole-aircraft maximum lift coefficient (elevator neutral), and the 1-g stall speed
  function stallSpeed(ac, rho = RHO0) {
    let best = 0, bestA = 0;
    for (let a = 0; a <= 0.45; a += 0.005) {
      const f = accelAt(ac, 15, a, 0, 0, 0, rho);
      const Lz = ac.mass * (G - f[0]); // vertical force supporting the aircraft
      const CL = Lz / (0.5 * rho * 225 * ac.S);
      if (CL > best) { best = CL; bestA = a; }
    }
    return { CLmax: best, alpha: bestA, Vs: Math.sqrt((2 * ac.mass * G) / (rho * ac.S * best)) };
  }
  function performance(ac, rho = RHO0) {
    const st = stallSpeed(ac, rho);
    const rows = [];
    let prev = null;
    for (let V = Math.ceil(st.Vs * 1.1); V <= 70; V += 1) {
      const t = trim(ac, V, rho, prev);
      if (!t.ok) { if (rows.length) break; else continue; }
      rows.push(t); prev = t;
    }
    let handsOff = null;
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].e * rows[i].e <= 0) { const k = rows[i - 1].e / (rows[i - 1].e - rows[i].e); handsOff = lerp(rows[i - 1].V, rows[i].V, k); }
    return { stall: st, rows, Vmax: rows.length ? rows[rows.length - 1].V : null, handsOff };
  }

  return { G, D2R, DEFS, build, makeState, reset, launch, step, stabilize, atmosphere, quatToMat, mulMV, mulMtV, eulerFromMat, quatFromEuler, clamp, sat, flapTheory, trim, stallSpeed, performance };
})();
if (typeof module !== 'undefined') module.exports = FL;
