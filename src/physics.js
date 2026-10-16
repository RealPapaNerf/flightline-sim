/* =====================================================================
   Flightline flight model — pure JavaScript, no DOM, no graphics.
   Frames: world = NED (x north, y east, z down, metres, ground at z = 0)
           body  = FRD (x forward, y right wing, z down)
   Control sign convention used everywhere below:
     aileron  +  -> right wing down (roll right)
     elevator +  -> nose up
     rudder   +  -> nose right
   so every control derivative (Cl_da, Cm_de, Cn_dr) is positive.
   ===================================================================== */
const FL = (function () {
  'use strict';
  const G = 9.80665;
  const RHO0 = 1.225;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const sat = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);
  const approach = (x, t, d) => (x < t ? Math.min(t, x + d) : Math.max(t, x - d));

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  // quaternion q = [w,x,y,z], rotates body -> world
  function quatToMat(q) {
    const w = q[0], x = q[1], y = q[2], z = q[3];
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ];
  }
  const mulMV = (R, v) => [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
  const mulMtV = (R, v) => [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
  function quatFromEuler(roll, pitch, yaw) {
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
    const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    return [
      cr * cp * cy + sr * sp * sy,
      sr * cp * cy - cr * sp * sy,
      cr * sp * cy + sr * cp * sy,
      cr * cp * sy - sr * sp * cy,
    ];
  }
  function eulerFromMat(R) {
    return {
      roll: Math.atan2(R[7], R[8]),
      pitch: -Math.asin(clamp(R[6], -1, 1)),
      yaw: Math.atan2(R[3], R[0]),
    };
  }

  /* International Standard Atmosphere, troposphere.
     Returns density at a field elevation and actual temperature,
     plus the density altitude (the ISA altitude with that density). */
  function atmosphere(elevFt, tempF) {
    const T0 = 288.15, L = 0.0065, R = 287.053, p0 = 101325;
    const h = elevFt * 0.3048;
    const p = p0 * Math.pow(1 - (L * h) / T0, G / (R * L));
    const T = ((tempF - 32) * 5) / 9 + 273.15;
    const rho = p / (R * T);
    const n = G / (R * L) - 1; // ≈ 4.256
    const da = (T0 / L) * (1 - Math.pow(rho / RHO0, 1 / n));
    return { rho, p, T, daFt: da / 0.3048, isaTempF: ((T0 - L * h - 273.15) * 9) / 5 + 32 };
  }

  // LiPo open-circuit voltage per cell vs state of charge (typical curve)
  const OCV = [[0, 3.3], [0.05, 3.5], [0.1, 3.62], [0.2, 3.7], [0.4, 3.78], [0.6, 3.87], [0.8, 4.0], [0.95, 4.12], [1, 4.2]];
  function cellOCV(soc) {
    for (let i = 1; i < OCV.length; i++) {
      if (soc <= OCV[i][0]) {
        const a = OCV[i - 1], b = OCV[i];
        return a[1] + ((soc - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
      }
    }
    return 4.2;
  }

  /* ---------------- Aircraft: generic 1.5 m high-wing trainer ---------------- */
  const TRAINER = {
    id: 'trainer',
    name: '1.5 m trainer',
    mass: 1.3, // kg, flying weight with 3S 2200
    I: [0.075, 0.09, 0.15], // kg·m² about body x, y, z
    S: 0.33, b: 1.5, c: 0.22, // wing area m², span m, chord m  (AR ≈ 6.8)
    wingZ: -0.1, // wing height above CG (body z, m)
    aero: {
      CL0: 0.25, CLa: 4.8, a0: 0.27, M: 50, CLde: -0.2,
      CD0: 0.035, e: 0.8, CDfp: 1.2, CDbeta: 0.1,
      CYb: -0.6, CYdr: -0.15,
      Clb: -0.08, Clp: -0.5, Clr: 0.1, Clda: 0.18, Cldr: -0.005,
      Cm0: 0.012, Cma: -0.9, Cmq: -10, Cmde: 1.1,
      Cnb: 0.08, Cnp: -0.04, Cnr: -0.15, Cndr: 0.07, Cnda: -0.01,
      kRate: 0.004, // N·m·s, small structural/air damping that never fades
    },
    defl: { a: 0.35, e: 0.3, r: 0.44 }, // max surface deflection, rad (20°, 17°, 25°)
    servoRate: 8, // rad/s
    prop: { T0: 15, Vp: 30, D: 0.254, tau: 0.08, eta: 0.5, Tmin: -0.6 },
    batt: { cells: 3, mAh: 2200, R: 0.075, Imax: 32, Iidle: 0.3, Vref: 11.4 },
    steerMax: 0.3, // nose-wheel steering at full rudder, rad (17°)
    wheels: [
      { p: [0.32, 0, 0.17], steer: true },
      { p: [-0.05, -0.17, 0.17] },
      { p: [-0.05, 0.17, 0.17] },
    ],
    // impact = max speed into the ground (m/s), slide = max scraping speed (m/s) before it counts as a crash
    points: [
      { p: [0.43, 0, 0], prop: true, name: 'nose', impact: 2.5, slide: 7 },
      { p: [-0.02, -0.75, -0.13], name: 'left wingtip', impact: 2.5, slide: 7 },
      { p: [-0.02, 0.75, -0.13], name: 'right wingtip', impact: 2.5, slide: 7 },
      { p: [-0.8, 0, 0.03], name: 'tail', impact: 3, slide: 99 },
      { p: [-0.82, 0, -0.18], name: 'fin', impact: 1.5, slide: 2 },
      { p: [0.05, 0, -0.1], name: 'wing', impact: 1.5, slide: 2 },
      { p: [-0.74, -0.25, 0], name: 'stabiliser', impact: 2.5, slide: 9 },
      { p: [-0.74, 0.25, 0], name: 'stabiliser', impact: 2.5, slide: 9 },
    ],
    contact: { kW: 2500, cW: 35, kB: 3000, cB: 40, muRoll: 0.05, muLat: 0.9, muBody: 0.6 },
    crash: { wheelImpact: 4.5 },
  };

  function makeState() {
    return {
      p: [0, 0, 0], v: [0, 0, 0], q: [1, 0, 0, 0], w: [0, 0, 0],
      n: 0, sa: 0, se: 0, sr: 0,
      soc: 1, mAh: 0, vb: 12.6, I: 0,
      crashed: false, crashMsg: '', wow: false, t: 0,
      tele: { alpha: 0, beta: 0, V: 0, CL: 0, qbar: 0, T: 0, nz: 1 },
    };
  }

  function reset(s, ac, where) {
    s.w = [0, 0, 0]; s.n = 0; s.sa = s.se = s.sr = 0;
    s.crashed = false; s.crashMsg = ''; s.mAh = 0; s.soc = 1; s.t = 0;
    if (where === 'air') {
      // downwind leg 60 m in front of the pilot, 40 m up, flying west (pilot's right to left)
      s.p = [60, 40, -40];
      s.q = quatFromEuler(0, 0.02, -Math.PI / 2);
      s.v = mulMV(quatToMat(s.q), [15, 0, 0]);
      s.n = 0.6;
    } else {
      // west end of the runway, pointing east
      s.p = [12, -52, -0.172];
      s.q = quatFromEuler(0, 0, Math.PI / 2);
      s.v = [0, 0, 0];
    }
  }

  /* One fixed time step.
     ctl: { thr 0..1, a, e, r  -1..1 }   env: { rho, wind[3] NED m/s, battery bool, crashes bool } */
  function step(s, ac, ctl, env, dt) {
    const A = ac.aero, m = ac.mass, I = ac.I, P = ac.prop, B = ac.batt;
    s.t += dt;

    // --- motor & battery ---
    let thrCmd = s.crashed ? 0 : clamp(ctl.thr, 0, 1);
    if (env.battery && s.soc <= 0) thrCmd = 0;
    s.n += (thrCmd - s.n) * Math.min(1, dt / P.tau); // normalised rpm, first-order spool
    const Icur = B.Iidle + B.Imax * s.n * s.n * s.n; // electrical power ~ rpm³
    s.I = Icur;
    s.vb = Math.max(0, B.cells * cellOCV(env.battery ? s.soc : 1) - Icur * B.R);
    if (env.battery) {
      s.mAh += (Icur * dt) / 3.6;
      s.soc = Math.max(0, 1 - s.mAh / B.mAh);
    }

    // --- servos (rate limited) ---
    s.sa = approach(s.sa, sat(ctl.a) * ac.defl.a, ac.servoRate * dt);
    s.se = approach(s.se, sat(ctl.e) * ac.defl.e, ac.servoRate * dt);
    s.sr = approach(s.sr, sat(ctl.r) * ac.defl.r, ac.servoRate * dt);

    const R = quatToMat(s.q);
    const wind = env.wind || [0, 0, 0];
    const vb = mulMtV(R, [s.v[0] - wind[0], s.v[1] - wind[1], s.v[2] - wind[2]]);
    const V = Math.hypot(vb[0], vb[1], vb[2]);
    const rho = env.rho;
    const qbar = 0.5 * rho * V * V;

    // --- propeller: static thrust scales with rpm², falls off linearly toward pitch speed ---
    const rpmV = s.n * clamp(s.vb / B.Vref, 0, 1.15);
    const Vax = vb[0];
    let T = P.T0 * (rho / RHO0) * (rpmV * rpmV - (rpmV * Vax) / P.Vp);
    T = Math.max(P.Tmin * (rho / RHO0) * Math.min(1, Math.abs(Vax) / P.Vp), T);
    const Adisc = (Math.PI * P.D * P.D) / 4;
    const qt = qbar + (P.eta * Math.max(0, T)) / Adisc; // tail dynamic pressure incl. slipstream

    const Fb = [T, 0, 0];
    const Mb = [0, 0, 0];
    let alpha = 0, beta = 0, CL = 0;

    if (V > 0.3) {
      alpha = Math.atan2(vb[2], vb[0]);
      beta = Math.asin(clamp(vb[1] / V, -1, 1));
      const Vd = Math.max(V, 3);
      const ph = (s.w[0] * ac.b) / (2 * Vd);
      const qh = (s.w[1] * ac.c) / (2 * Vd);
      const rh = (s.w[2] * ac.b) / (2 * Vd);

      // lift: linear below stall, flat plate after, blended by a sigmoid (Beard & McLain 2012)
      const e1 = Math.exp(-A.M * (alpha - A.a0));
      const e2 = Math.exp(A.M * (alpha + A.a0));
      const sig = (1 + e1 + e2) / ((1 + e1) * (1 + e2));
      const sa_ = Math.sin(alpha), ca_ = Math.cos(alpha);
      const CLlin = A.CL0 + A.CLa * alpha;
      const CLfp = 2 * Math.sign(alpha) * sa_ * sa_ * ca_;
      CL = (1 - sig) * CLlin + sig * CLfp;

      // induced drag reduced in ground effect (McCormick)
      const hW = Math.max(0.02, -(s.p[2] + R[8] * ac.wingZ));
      const g16 = (16 * hW) / ac.b;
      const ge = (g16 * g16) / (1 + g16 * g16);
      const AR = (ac.b * ac.b) / ac.S;
      const k = ge / (Math.PI * A.e * AR);
      const sb = Math.sin(beta);
      const CD = (1 - sig) * (A.CD0 + k * CLlin * CLlin) + sig * (A.CD0 + A.CDfp * sa_ * sa_) + A.CDbeta * sb * sb;

      // lift and pitching moment only see the airflow in the wing's chord plane (u, w);
      // sideways flow (v) produces side force, not lift
      const qxz = 0.5 * rho * (vb[0] * vb[0] + vb[2] * vb[2]);
      const L = qxz * ac.S * CL + qt * ac.S * A.CLde * s.se;
      const D = qbar * ac.S * CD;
      const Y = qbar * ac.S * A.CYb * sb + qt * ac.S * A.CYdr * s.sr;

      const vx = vb[0] / V, vy = vb[1] / V, vz = vb[2] / V;
      Fb[0] -= D * vx; Fb[1] -= D * vy; Fb[2] -= D * vz;
      const lxz = Math.hypot(vx, vz); // lift is perpendicular to the airflow, in the body x–z plane
      if (lxz > 1e-3) { Fb[0] += (L * vz) / lxz; Fb[2] -= (L * vx) / lxz; }
      Fb[1] += Y;

      const Sb = ac.S * ac.b, Sc = ac.S * ac.c;
      Mb[0] += qbar * Sb * (A.Clb * sb + A.Clp * ph + A.Clr * rh + A.Clda * s.sa) + qt * Sb * A.Cldr * s.sr;
      Mb[1] += qxz * Sc * (A.Cm0 + A.Cma * Math.sin(alpha)) + qbar * Sc * A.Cmq * qh + qt * Sc * A.Cmde * s.se;
      Mb[2] += qbar * Sb * (A.Cnb * sb + A.Cnp * ph + A.Cnr * rh + A.Cnda * s.sa) + qt * Sb * A.Cndr * s.sr;
    } else {
      // standing still: only the slipstream acts on the tail surfaces
      Mb[0] += qt * ac.S * ac.b * A.Cldr * s.sr;
      Mb[1] += qt * ac.S * ac.c * A.Cmde * s.se;
      Mb[2] += qt * ac.S * ac.b * A.Cndr * s.sr;
    }
    Mb[0] -= A.kRate * s.w[0]; Mb[1] -= A.kRate * s.w[1]; Mb[2] -= A.kRate * s.w[2];

    // --- forces in world ---
    const Fw = mulMV(R, Fb);
    Fw[2] += m * G;

    // --- ground contact: spring-damper per point, regularised Coulomb friction ---
    const C = ac.contact;
    let wow = false, crash = null;
    const Fcb = [0, 0, 0];
    const contactPt = (pt, isWheel) => {
      const r = pt.p;
      const rw = mulMV(R, r);
      const pz = s.p[2] + rw[2];
      if (pz <= 0) return;
      const vp = mulMV(R, cross(s.w, r));
      vp[0] += s.v[0]; vp[1] += s.v[1]; vp[2] += s.v[2];
      const k = isWheel ? C.kW : C.kB, c = isWheel ? C.cW : C.cB;
      const N = Math.max(0, k * pz + c * vp[2]);
      let fx = 0, fy = 0;
      if (isWheel) {
        const st = pt.steer ? s.sr / ac.defl.r * ac.steerMax : 0;
        const fw = mulMV(R, [Math.cos(st), Math.sin(st), 0]);
        const nh = Math.hypot(fw[0], fw[1]);
        if (nh > 0.3) {
          const fhx = fw[0] / nh, fhy = fw[1] / nh;
          const vl = vp[0] * fhx + vp[1] * fhy;
          const vt = -vp[0] * fhy + vp[1] * fhx;
          const Fl = -C.muRoll * N * sat(vl / 0.3);
          const Ft = -C.muLat * N * sat(vt / 0.1);
          fx = Fl * fhx - Ft * fhy;
          fy = Fl * fhy + Ft * fhx;
        } else isWheel = false;
      }
      if (!isWheel) {
        const vh = Math.hypot(vp[0], vp[1]);
        if (vh > 1e-6) {
          const f = (-C.muBody * N * sat(vh / 0.2)) / vh;
          fx = f * vp[0]; fy = f * vp[1];
        }
      }
      const Fc = [fx, fy, -N];
      Fw[0] += Fc[0]; Fw[1] += Fc[1]; Fw[2] += Fc[2];
      const Fcb_ = mulMtV(R, Fc);
      Fcb[0] += Fcb_[0]; Fcb[1] += Fcb_[1]; Fcb[2] += Fcb_[2];
      const Mc = cross(r, Fcb_);
      Mb[0] += Mc[0]; Mb[1] += Mc[1]; Mb[2] += Mc[2];
      const impact = vp[2], slide = Math.hypot(vp[0], vp[1]);
      if (pt.wheelFlag) {
        wow = true;
        if (impact > ac.crash.wheelImpact) crash = 'Hard landing — gear folded';
      } else {
        if (pt.prop && s.n > 0.25 && Math.hypot(vp[0], vp[1], vp[2]) > 0.5) crash = 'Prop strike';
        else if (impact > pt.impact || slide > pt.slide) crash = 'Crashed — ' + (pt.name || 'airframe') + ' hit the ground';
      }
    };
    for (const w of ac.wheels) { w.wheelFlag = true; contactPt(w, true); }
    for (const b of ac.points) contactPt(b, false);
    s.wow = wow;
    if (crash && env.crashes && !s.crashed) { s.crashed = true; s.crashMsg = crash; }

    // --- integrate (semi-implicit Euler) ---
    s.v[0] += (Fw[0] / m) * dt; s.v[1] += (Fw[1] / m) * dt; s.v[2] += (Fw[2] / m) * dt;
    s.p[0] += s.v[0] * dt; s.p[1] += s.v[1] * dt; s.p[2] += s.v[2] * dt;
    const Iw = [I[0] * s.w[0], I[1] * s.w[1], I[2] * s.w[2]];
    const gy = cross(s.w, Iw);
    s.w[0] += ((Mb[0] - gy[0]) / I[0]) * dt;
    s.w[1] += ((Mb[1] - gy[1]) / I[1]) * dt;
    s.w[2] += ((Mb[2] - gy[2]) / I[2]) * dt;
    const q = s.q, wx = s.w[0], wy = s.w[1], wz = s.w[2];
    const h = 0.5 * dt;
    const nq = [
      q[0] + h * (-q[1] * wx - q[2] * wy - q[3] * wz),
      q[1] + h * (q[0] * wx + q[2] * wz - q[3] * wy),
      q[2] + h * (q[0] * wy - q[1] * wz + q[3] * wx),
      q[3] + h * (q[0] * wz + q[1] * wy - q[2] * wx),
    ];
    const qn = Math.hypot(nq[0], nq[1], nq[2], nq[3]);
    s.q = [nq[0] / qn, nq[1] / qn, nq[2] / qn, nq[3] / qn];

    const t = s.tele;
    t.alpha = alpha; t.beta = beta; t.V = V; t.CL = CL; t.qbar = qbar; t.T = T;
    t.nz = -(Fb[2] + Fcb[2]) / (m * G);

    if (!Number.isFinite(s.p[0] + s.p[1] + s.p[2] + s.q[0] + s.w[0] + s.w[1] + s.w[2])) {
      reset(s, ac, 'runway');
      s.crashMsg = 'Simulation reset (numerical error)';
    }
  }

  /* Stabilised mode, like ArduPilot FBWA / iNav ANGLE for planes:
     roll stick commands bank angle (±45°), pitch stick commands pitch angle (±30°). */
  function stabilize(cmd, s) {
    const R = quatToMat(s.q);
    const eu = eulerFromMat(R);
    const phD = cmd.a * 0.785, thD = cmd.e * 0.52;
    let ep = phD - eu.roll;
    if (ep > Math.PI) ep -= 2 * Math.PI;
    if (ep < -Math.PI) ep += 2 * Math.PI;
    const a = sat(1.8 * ep - 0.12 * s.w[0]);
    const turn = 0.6 * (1 / Math.max(0.5, Math.cos(eu.roll)) - 1);
    const e = sat(1.4 * (thD - eu.pitch) - 0.1 * s.w[1] + turn);
    return { thr: cmd.thr, a, e, r: cmd.r };
  }

  return { G, TRAINER, makeState, reset, step, stabilize, atmosphere, quatToMat, mulMV, mulMtV, eulerFromMat, quatFromEuler, clamp, sat };
})();
if (typeof module !== 'undefined') module.exports = FL;
