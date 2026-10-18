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
  /* ---------------- Atmosphere and weather ---------------- */
  // saturation vapour pressure over water (Pa), Magnus–Tetens form (Bolton 1980), T in °C
  const esat = (Tc) => 611.2 * Math.exp((17.67 * Tc) / (Tc + 243.5));
  /* Field conditions → air density. Station pressure from the altimeter setting (QNH) through the
     ISA lapse, moist air as dry air + water vapour (partial pressures), density altitude by
     inverting the ISA density curve. */
  function atmosphere(elevFt, tempF, rh = 0, altimInHg = 29.92) {
    const T0 = 288.15, L = 0.0065, Rd = 287.053, Rv = 461.495, p0 = 101325, n0 = G / (Rd * L);
    const h = elevFt * 0.3048;
    const p = altimInHg * 3386.389 * Math.pow(1 - (L * h) / T0, n0); // station pressure
    const Tc = ((tempF - 32) * 5) / 9, T = Tc + 273.15;
    const e = (clamp(rh, 0, 100) / 100) * esat(Tc); // vapour pressure
    const rho = (p - e) / (Rd * T) + e / (Rv * T);
    const da = (T0 / L) * (1 - Math.pow(rho / RHO0, 1 / (n0 - 1)));
    const pa = (T0 / L) * (1 - Math.pow(p / p0, 1 / n0));
    const lg = Math.log(Math.max(e, 1) / 611.2), dew = (243.5 * lg) / (17.67 - lg);
    return {
      rho, p, T, Tc, e, dewC: dew, daFt: da / 0.3048, paFt: pa / 0.3048,
      isaTempF: ((T0 - L * h - 273.15) * 9) / 5 + 32,
      cloudBaseFt: Math.max(0, ((Tc - dew) / 2.5) * 1000), // spread rule: ~400 ft per °C of temperature–dew point spread
    };
  }

  /* Precipitation: rate R (mm/h, water), liquid water content (kg/m³), median drop size (m),
     optical extinction (1/km, visibility = 3.912/β), fall speed (m/s). Liquid water from
     Marshall–Palmer (LWC ≈ 0.072·R^0.88 g/m³) for rain; drizzle and snow are typical values. */
  const PRECIP = {
    none: { name: 'None', R: 0, lwc: 0, mvd: 0, beta: 0, fall: 0, liquid: true },
    drizzle: { name: 'Drizzle', R: 0.5, lwc: 0.12e-3, mvd: 250e-6, beta: 1.4, fall: 2, liquid: true },
    rain: { name: 'Rain', R: 4, lwc: 0.24e-3, mvd: 1000e-6, beta: 0.6, fall: 5, liquid: true },
    heavy: { name: 'Heavy rain', R: 25, lwc: 1.2e-3, mvd: 1500e-6, beta: 1.9, fall: 7.5, liquid: true },
    snow: { name: 'Snow', R: 1, lwc: 0.1e-3, mvd: 1000e-6, beta: 2.5, fall: 1, liquid: false },
    heavysnow: { name: 'Heavy snow', R: 4, lwc: 0.3e-3, mvd: 1500e-6, beta: 8, fall: 1.2, liquid: false },
  };
  const CLOUD_LWC = 0.25e-3, CLOUD_MVD = 15e-6, CLOUD_VIS = 40; // stratus: g/m³ ×1e-3, 15 µm drops, ~40 m inside

  /* Weather at the aircraft. wx = { tempC (at the field), rh (%), precip, fogVisM, ceilM (0 = no
     ceiling) }, alt = height above the field (m). Returns air temperature there, the supercooled-or-
     not liquid water the aircraft flies through and its drop size, a 0–1 rain intensity for the
     aerodynamic penalty, whether it's in cloud, and the visibility. */
  function weatherAt(wx, alt) {
    const T = wx.tempC - 0.0065 * alt;
    const P = PRECIP[wx.precip] || PRECIP.none;
    const inCloud = wx.ceilM > 0 && alt >= wx.ceilM;
    let lwc = 0, m = 0;
    const add = (l, d) => { lwc += l; m += l * d; };
    if (inCloud) add(CLOUD_LWC, CLOUD_MVD);
    const fogVis = Math.min(30000, wx.fogVisM >= 10000 ? 30000 : wx.fogVisM);
    // fog or mist: liquid water from visibility, Kunkel (1984) β = 144.7·LWC^0.88 (β 1/km, LWC g/m³)
    if (wx.rh >= 95 && fogVis < 5000) add(Math.pow(3.912 / (fogVis / 1000) / 144.7, 1 / 0.88) * 1e-3, 10e-6);
    if (P.liquid || (T > -1.5 && T < 1)) add(P.lwc, P.mvd); // snow only sticks when it's wet
    const beta = (inCloud ? 3912 / CLOUD_VIS : 0) + 3.912 / (fogVis / 1000) + P.beta;
    return { T, lwc, mvd: lwc > 0 ? m / lwc : 0, rain: P.liquid && T > 0 ? Math.min(1, P.R / 100) : 0, inCloud, visM: 3912 / beta, freezing: T <= 0 };
  }

  /* Ice growth (m/s) at the leading edge of a section with chord c (m) moving at V (m/s) through
     liquid water at air temperature Tamb (°C). Kinetic heating warms the surface by about V²/2365 °C,
     so fast props and rotor tips stay clean near 0 °C.
       K = ρw·d²·V / (18μ·r_LE),  r_LE ≈ 0.04c      collection efficiency E = K / (K + 0.6)
       freezing fraction n = 0.25 − Ts/4 (glaze near 0 °C, all rime colder than −3 °C)
       dk/dt = E·n·LWC·V / ρ_ice                    ρ_ice 700 (rime) … 900 kg/m³ (glaze) */
  const glazeOf = (Ts) => clamp(1 - (-Ts - 2) / 8, 0, 1);
  function iceRate(wxa, V, c, Tamb) {
    if (!wxa || wxa.lwc <= 0) return 0;
    const Ts = Tamb + (V * V) / 2365;
    if (Ts >= 0) return 0;
    const K = (1000 * wxa.mvd * wxa.mvd * V) / (18 * 1.72e-5 * 0.04 * c);
    const E = K / (K + 0.6);
    const n = Math.min(1, 0.25 - Ts / 4);
    const cold = Tamb < -15 ? Math.max(0.2, 1 + (Tamb + 15) / 15) : 1; // fewer supercooled drops when very cold
    return (E * n * cold * wxa.lwc * V) / (700 + 200 * glazeOf(Ts));
  }
  /* Aerodynamic cost of leading-edge ice of relative height x = k/c. Trends follow wind-tunnel work on
     iced airfoils (Bragg et al.; Hann et al. on small UAV airfoils): even roughness costs lift, horn
     glaze near 0 °C is worse than rime. Rough numbers: fraction of CLmax lost, added profile drag,
     lift-slope factor. */
  function icePenalty(x, gl) {
    if (!(x > 0)) return { dCL: 0, dCD: 0, slope: 1 };
    const g = 1 - Math.exp(-x / 0.002), h = 1 - Math.exp(-x / 0.005);
    return { dCL: (0.3 + 0.15 * gl) * g, dCD: (0.025 + 0.03 * gl) * h, slope: 1 - 0.08 * g };
  }
  // ice on a propeller or rotor blade: thrust lost, extra shaft power
  // (UAV propeller icing tests show thrust falling by half and power rising 50–100% within minutes)
  const propIce = (x) => { const g = 1 - Math.exp(-x / 0.01); return { thrust: 1 - 0.6 * g, power: 1 + 0.8 * g }; };

  /* Battery temperature. Internal resistance grows about 2.8%/°C as the pack cools (×1.7 at 0 °C, ×3 at
     −20 °C, relative to the 20 °C rating) and usable capacity drops ~0.6%/°C below 20 °C. The pack warms by I²R and cools toward the air:
       m·cp·dT/dt = I²R(T) − (UA0 + UA1·√V)·(T − T_air)       cp ≈ 1000 J/(kg·K) */
  const PACK_KG = { lipo: 0.027, liion: 0.016 }; // kg per cell per Ah
  const battR = (B, Tc) => B.R * clamp(Math.exp(0.0277 * (20 - Tc)), 0.5, 6);
  const capF = (Tc) => clamp(1 - 0.006 * (20 - Tc), 0.6, 1);
  function battery(s, B, Icur, V, env, dt) {
    const R = battR(B, s.bT);
    s.I = Icur;
    s.vb = Math.max(0, B.cells * cellOCV(B.chem, env.battery ? s.soc : 1) - Icur * R);
    if (env.battery) { s.mAh += (Icur * dt) / 3.6; s.soc = Math.max(0, 1 - s.mAh / (B.mAh * capF(s.bT))); }
    const m = B.cells * (B.mAh / 1000) * (PACK_KG[B.chem] || 0.027), cool = B.cool || [0.08, 0.03];
    const Ta = env.wx ? env.wx.T : 20;
    s.bT += ((Icur * Icur * R - (cool[0] + cool[1] * Math.sqrt(Math.max(0, V))) * (s.bT - Ta)) / (m * 1000)) * dt;
  }
  /* Shared per-step icing bookkeeping for props, rotor blades and the FPV lens. vP: blade speed at 75%
     radius, cP: blade chord. Returns the prop factors. Ice sheds off fast props now and then, unevenly. */
  function iceSmall(s, env, V, vP, cP, dt) {
    const wxa = env.wx;
    if (!wxa) return propIce(0);
    if (wxa.lwc > 0 && wxa.T < 3) {
      s.iceProp += iceRate(wxa, vP, cP, wxa.T) * dt;
      s.iceLens = Math.min(1, s.iceLens + ((iceRate(wxa, Math.max(V, 3), 0.02, wxa.T) * 0.5) / 0.001) * dt);
    }
    if (wxa.T > 0.5) { // melting
      const m = (wxa.T - 0.5) * 2e-6 * (wxa.rain > 0 ? 3 : 1) * dt;
      s.iceProp = Math.max(0, s.iceProp - m); s.iceLens = Math.max(0, s.iceLens - m / 0.001);
    }
    if (s.iceProp > 3e-4 && vP > 50 && Math.random() < 0.08 * (vP / 100) ** 2 * (s.iceProp / 5e-4) * dt) {
      s.iceProp *= 0.3 + 0.3 * Math.random(); s.shed = 1.2; // a chunk lets go: shake for a moment
    }
    s.shed = Math.max(0, s.shed - dt);
    return propIce(s.iceProp / cP);
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
  /* A quad from a few numbers. arm: motor offset along x and y (m); foot: how far the landing feet sit
     below the CG; pack/cam: where the battery and camera stick out (contact points). */
  function quadDef(o) {
    const a = o.arm, f = o.foot, ms = o.mass / 0.65;
    const names = ['front right motor', 'front left motor', 'rear right motor', 'rear left motor'];
    const motors = [[a, a, 1], [a, -a, -1], [-a, a, -1], [-a, -a, 1]];
    return Object.assign({
      kind: 'quad', wheels: [], starts: ['pad', 'air'], rotorDrag: 0.012,
      motors,
      angle: { max: 55, k: 7, rate: 500 },
      points: [
        ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sy]) => ({ p: [sx * o.footX, sy * o.footY, f], name: o.gear ? 'landing leg' : 'frame', foot: true, impact: o.gear ? 3.5 : 6, slide: 99 })),
        ...motors.map(([x, y], i) => ({ p: [x, y, f * 0.4], name: names[i], prop: true, motor: i, strike: 3, impact: 6, slide: 99 })),
        { p: o.pack, name: 'battery', impact: 5, slide: 10 },
        { p: o.cam, name: o.gimbal ? 'gimbal' : 'camera', impact: 4, slide: 8 },
      ],
      contact: { kW: 0, cW: 0, kB: 1500 * ms, cB: 18 * Math.sqrt(ms), muRoll: 0, muLat: 0, muBody: 0.7 },
      crash: { wheelImpact: 99 },
    }, o);
  }

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
      trim: { a: 0.004, e: -0.06 }, // built-in mechanical trim (stick units): hands-off ≈ 36 mph
      stab: { kRoll: 1.2, dRoll: 0.04, kPitch: 1.1, dPitch: 0.05, turn: 0.4 },
      fpvCam: [0.25, 0, -0.0442], // nose camera, body FRD (definition x)
      colR: 0.25, // obstacle-collision radius, m
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
      fpvCam: [0.4246, 0, -0.0872],
      colR: 0.55,
    },

    quad: {
      id: 'quad',
      name: '5-inch quad',
      blurb: '5-inch 6S freestyle quad, 650 g, about 8:1 thrust to weight. Betaflight-style Actual rates; acro, or angle mode as stabilised.',
      kind: 'quad',
      mass: 0.65,
      I: [0.0022, 0.0024, 0.004],
      // motors in an X, 220 mm wheelbase: [x forward, y right, spin] where spin +1 = counter-clockwise seen from above
      motors: [[0.078, 0.078, 1], [0.078, -0.078, -1], [-0.078, 0.078, -1], [-0.078, -0.078, 1]],
      motor: { Tmax: 13.5, tau: 0.025, idle: 0.055, kQ: 0.016, Vp: 40, D: 0.127 }, // per motor: max thrust N, spool lag s, idle, yaw torque per N (m), pitch speed m/s, prop dia m
      rotorDrag: 0.012, // in-plane rotor drag, N per N of thrust per m/s of airspeed in the rotor plane
      body: { r: [0, 0, 0], CdA: [0.0075, 0.009, 0.02] },
      // flight controller: rate PID per axis [P (1/s), I (1/s²), feed-forward, I limit (rad), D (s)]
      pid: { roll: [30, 160, 0.3, 0.35, 0.025], pitch: [30, 160, 0.3, 0.35, 0.025], yaw: [22, 70, 0.3, 0.5, 0] },
      angle: { max: 55, k: 7, rate: 500 }, // self-level gain (1/s) and max levelling rate (°/s); limits come from settings
      rates: { roll: { c: 70, m: 670, e: 0 }, pitch: { c: 70, m: 670, e: 0 }, yaw: { c: 70, m: 670, e: 0 } },
      batt: { chem: 'lipo', cells: 6, mAh: 1300, R: 0.035, Imax: 120, Iidle: 0.6, Vref: 22.8, label: '6S 1300 LiPo', cool: [0.15, 0.06] },
      wheels: [],
      points: [
        { p: [0.055, 0.04, 0.03], name: 'frame', foot: true, impact: 6, slide: 99 },
        { p: [0.055, -0.04, 0.03], name: 'frame', foot: true, impact: 6, slide: 99 },
        { p: [-0.055, 0.04, 0.03], name: 'frame', foot: true, impact: 6, slide: 99 },
        { p: [-0.055, -0.04, 0.03], name: 'frame', foot: true, impact: 6, slide: 99 },
        { p: [0.078, 0.078, 0.012], name: 'front right motor', prop: true, motor: 0, strike: 3, impact: 6, slide: 99 },
        { p: [0.078, -0.078, 0.012], name: 'front left motor', prop: true, motor: 1, strike: 3, impact: 6, slide: 99 },
        { p: [-0.078, 0.078, 0.012], name: 'rear right motor', prop: true, motor: 2, strike: 3, impact: 6, slide: 99 },
        { p: [-0.078, -0.078, 0.012], name: 'rear left motor', prop: true, motor: 3, strike: 3, impact: 6, slide: 99 },
        { p: [0, 0, -0.05], name: 'battery', impact: 5, slide: 10 },
        { p: [0.07, 0, -0.02], name: 'camera', impact: 4, slide: 8 },
      ],
      contact: { kW: 0, cW: 0, kB: 1500, cB: 18, muRoll: 0, muLat: 0, muBody: 0.7 },
      crash: { wheelImpact: 99 },
      starts: ['pad', 'air'],
      fpvCam: [0.07, 0, -0.02],
      camTilt: 30,
      colR: 0.15,
    },
    lr4: quadDef({
      id: 'lr4',
      name: '4" LR · 4S Li-ion',
      blurb: '4-inch long-range quad on a 4S1P 18650 Li-ion pack (Molicel P28A-class: 2,800 mAh, 35 A). 340 g, about 5.5:1 thrust to weight on a full pack. Long flight times at cruise, but Li-ion can\'t feed a full punch: the voltage dives and the thrust goes with it.',
      mass: 0.34,
      I: [0.0008, 0.0009, 0.0015],
      arm: 0.062, foot: 0.022, footX: 0.04, footY: 0.03, pack: [0, 0, 0.04], cam: [0.055, 0, -0.012],
      motor: { Tmax: 4.7, tau: 0.03, idle: 0.05, kQ: 0.014, Vp: 44, D: 0.1016 },
      body: { r: [0, 0, 0], CdA: [0.0045, 0.0055, 0.012] },
      pid: { roll: [30, 160, 0.3, 0.35, 0.025], pitch: [30, 160, 0.3, 0.35, 0.025], yaw: [22, 70, 0.3, 0.5, 0] },
      rates: { roll: { c: 70, m: 550, e: 0 }, pitch: { c: 70, m: 550, e: 0 }, yaw: { c: 70, m: 450, e: 0 } },
      batt: { chem: 'liion', cells: 4, mAh: 2800, R: 0.09, Imax: 46, Iidle: 0.35, Vref: 14.8, label: '4S1P 18650 Li-ion, 2,800 mAh', cool: [0.1, 0.05], cell: { d: 0.0185, l: 0.065 }, series: 4, parallel: 1 },
      fpvCam: [0.058, 0, -0.012], camTilt: 15, colR: 0.12,
      look: { front: [1.0, 0.25, 0.2], rear: [0.88, 0.9, 0.92], frame: [0.14, 0.14, 0.15], wrap: [0.15, 0.6, 0.45], blades: 3 },
    }),
    q7: quadDef({
      id: 'q7',
      name: '7" LR · 6S2P Li-ion',
      blurb: '7-inch long-range quad on a 6S2P 18650 Li-ion pack (P30B-class cells: 6,000 mAh, 72 A). 1.05 kg, about 6:1 thrust to weight on a full pack. Full throttle wants ~120 A, more than the pack can give: punch hard and the voltage collapses.',
      mass: 1.05,
      I: [0.0068, 0.0074, 0.0124],
      arm: 0.108, foot: 0.03, footX: 0.06, footY: 0.04, pack: [0, 0, -0.06], cam: [0.09, 0, -0.015],
      motor: { Tmax: 17, tau: 0.045, idle: 0.05, kQ: 0.022, Vp: 39, D: 0.178 },
      body: { r: [0, 0, 0], CdA: [0.012, 0.014, 0.03] },
      pid: { roll: [24, 120, 0.3, 0.35, 0.02], pitch: [24, 120, 0.3, 0.35, 0.02], yaw: [16, 60, 0.3, 0.5, 0] },
      rates: { roll: { c: 70, m: 480, e: 0 }, pitch: { c: 70, m: 480, e: 0 }, yaw: { c: 70, m: 400, e: 0 } },
      batt: { chem: 'liion', cells: 6, mAh: 6000, R: 0.07, Imax: 120, Iidle: 0.8, Vref: 22.2, label: '6S2P 18650 Li-ion, 6,000 mAh', cool: [0.12, 0.06], cell: { d: 0.0185, l: 0.065 }, series: 6, parallel: 2 },
      fpvCam: [0.095, 0, -0.015], camTilt: 20, colR: 0.2,
      look: { front: [1.0, 0.5, 0.1], rear: [0.88, 0.9, 0.92], frame: [0.14, 0.14, 0.15], wrap: [0.2, 0.45, 0.85], blades: 2 },
    }),
    q13: quadDef({
      id: 'q13',
      name: '13" lifter · 12S2P Li-ion',
      blurb: '13-inch heavy lifter with landing gear and a three-camera gimbal pod, on a 12S2P 21700 Li-ion pack (P50B-class: 10,000 mAh, 120 A). 3.7 kg, about 4.6:1 thrust to weight. Big props spool slowly and it carries a lot of momentum: plan your stops.',
      mass: 3.7,
      I: [0.07, 0.08, 0.13],
      arm: 0.205, foot: 0.16, footX: 0.12, footY: 0.14, gear: true, gimbal: true, pack: [0, 0, -0.088], cam: [0.15, 0, 0.1],
      motor: { Tmax: 42, tau: 0.09, idle: 0.06, kQ: 0.04, Vp: 30, D: 0.33 },
      body: { r: [0, 0, 0], CdA: [0.04, 0.045, 0.09] },
      pid: { roll: [14, 60, 0.3, 0.4, 0.012], pitch: [14, 60, 0.3, 0.4, 0.012], yaw: [9, 30, 0.3, 0.6, 0] },
      angle: { max: 40, k: 4, rate: 200 },
      rates: { roll: { c: 50, m: 260, e: 0 }, pitch: { c: 50, m: 260, e: 0 }, yaw: { c: 50, m: 180, e: 0 } },
      batt: { chem: 'liion', cells: 12, mAh: 10000, R: 0.08, Imax: 160, Iidle: 1.5, Vref: 44.4, label: '12S2P 21700 Li-ion, 10,000 mAh', cool: [0.2, 0.08], cell: { d: 0.021, l: 0.07 }, series: 12, parallel: 2 },
      fpvCam: [0.16, 0, 0.11], camTilt: 0, colR: 0.4,
      look: { front: [0.25, 0.9, 0.4], rear: [0.88, 0.9, 0.92], frame: [0.16, 0.16, 0.17], wrap: [0.25, 0.3, 0.35], blades: 2 },
    }),
    heli: {
      id: 'heli',
      name: '450 heli',
      blurb: '450-class flybarless helicopter, 800 g, 720 mm rotor at 2900 rpm, 6S. Governor, throttle hold for autorotations, Normal or 3D pitch curve.',
      kind: 'heli',
      mass: 0.8,
      I: [0.007, 0.022, 0.018],
      rotor: {
        R: 0.36, chord: 0.034, blades: 2, a: 5.7, Cd0: 0.013, kInd: 1.15, CLmax: 1.0, // blade-element and momentum inflow
        om0: 304, J: 0.0025, Pmax: 750, govK: 0.02, spool: 0.16, friction: 0.0001, // headspeed (rad/s), inertia, motor power W, governor
        h: 0.18, Kh: 25, tauF: 0.015, maxCyc: 0.2, blowback: 2.5, // hub height above CG, hub stiffness N·m/rad, flapping lag, cyclic limit rad
        lt: 0.42, TtMax: 7, tauT: 0.02, spin: -1, // tail arm, tail thrust at full headspeed (N); main rotor turns clockwise seen from above
        curves: { normal: [-4, 4.5, 11], '3d': [-11, 0, 11] }, // collective (°) at stick 0, ½, 1
      },
      body: { r: [0, 0, 0], CdA: [0.012, 0.03, 0.045], fin: 0.006, finX: -0.6 },
      pid: { roll: [30, 200, 0.3, 2.5, 0.01], pitch: [30, 200, 0.3, 2.5, 0.01], yaw: [30, 150, 0.3, 1.5, 0] },
      angle: { max: 55, k: 6, rate: 400 },
      rates: { roll: { c: 120, m: 360, e: 0 }, pitch: { c: 120, m: 360, e: 0 }, yaw: { c: 200, m: 600, e: 0 } },
      batt: { chem: 'lipo', cells: 6, mAh: 1300, R: 0.035, Imax: 0, Iidle: 1.0, Vref: 22.8, label: '6S 1300 LiPo' },
      wheels: [],
      points: [
        { p: [0.09, 0.075, 0.17], name: 'skid', foot: true, impact: 3.5, slide: 99 },
        { p: [0.09, -0.075, 0.17], name: 'skid', foot: true, impact: 3.5, slide: 99 },
        { p: [-0.09, 0.075, 0.17], name: 'skid', foot: true, impact: 3.5, slide: 99 },
        { p: [-0.09, -0.075, 0.17], name: 'skid', foot: true, impact: 3.5, slide: 99 },
        { p: [-0.62, 0, -0.02], name: 'tail', impact: 2, slide: 4 },
        { p: [0.19, 0, 0.04], name: 'canopy', impact: 2.5, slide: 6 },
        { p: [0, 0, -0.2], name: 'rotor head', impact: 1.5, slide: 2 },
      ],
      contact: { kW: 0, cW: 0, kB: 1800, cB: 22, muRoll: 0, muLat: 0, muBody: 0.6 },
      crash: { wheelImpact: 99 },
      starts: ['pad', 'air'],
      fpvCam: [0.3, 0, 0.05], // on the canopy nose, just ahead of it
      camTilt: 5,
      colR: 0.38,
    },
  };

  /* Cut every lifting surface into strips and push them onto ac.strips.
     Shared by the planes, the tail-sitters and — since a quad may now carry a
     lifting body — by the multirotors too, which is why it is a function
     rather than the first half of build(). Returns the wing totals build()
     needs to place the neutral point. */
  function buildStrips(ac) {
    let wingArea = 0, wingSpan = 0, wingSlope = 4;
    for (const sf of ac.surfaces) {
      const sides = sf.vertical ? [0] : sf.mirror ? [1, -1] : [1];
      const half = sf.y1 - sf.y0;
      const areaHalf = ((sf.c0 + sf.c1) / 2) * half;
      const span = sf.vertical ? half : 2 * sf.y1;
      const areaTot = sf.vertical ? areaHalf : 2 * areaHalf;
      const AR = sf.vertical ? (1.6 * half * half) / areaHalf : (span * span) / areaTot;
      // more than one surface can be a wing: a tail-sitter's body and its four arms all carry weight
      if (sf.role === 'wing') {
        if (areaTot > wingArea) { wingSlope = sf.foil.a; }
        wingArea += areaTot;
        wingSpan = Math.max(wingSpan, span);
      }
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
            vert: !!sf.vertical, wy: sf.vertical ? 0 : width * Math.cos(Gam), // strip width along y, for the lifting line
            load: L,
            a: f.a, CL0: f.CL0,
            aS: (f.CLmax / L - f.CL0) / f.a, // local stall angle: strips carrying more load stall sooner
            aSn: (f.CL0 - f.CLmin / L) / f.a,
            dAS: f.CLmax / L / f.a, dASn: -f.CLmin / L / f.a, // stall-angle change per unit fraction of CLmax / CLmin lost
            M: f.M, CD0: f.CD0, k: 1 / (Math.PI * f.e * AR), Cm0: f.Cm0, CN90: f.CN90,
            AR, ka: 0, ke: 0, kr: 0, kf: 0, tau: 0, cmd: 0, cf: 0,
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
              st.kf = fl.f || 0;
            }
          }
          if (ac.prop && ac.prop.wash) {
            const dy = r[1] - ac.prop.r[1], dz = r[2] - ac.prop.r[2];
            st.wash = r[0] < ac.prop.r[0] && Math.hypot(dy, dz) < 0.6 * ac.prop.D;
          }
          // a tail-sitter's elevons sit behind its propellers and live on the wash
          if (ac.motors && ac.motor) for (const mo of ac.motors) {
            if (r[0] < mo[0] && Math.hypot(r[1] - mo[1], r[2] - mo[2]) < 0.6 * ac.motor.D) st.wash = true;
          }
          ac.strips.push(st);
        }
      }
    }
    return { wingArea, wingSpan, wingSlope };
  }

  /* =====================================================================
     Accurate aerodynamics (env.hifi). Everything here is precomputed at
     build time and costs nothing until the option is switched on; with it
     off, step() is bit-identical to the lightweight model.

     What the option changes, and why each piece is behind it:
       - a nonlinear lifting line replaces the Schrenk load factor: every
         strip's circulation induces real up/downwash on every other strip
         of its surface, and the wing's wake is evaluated at each tail
         station instead of one whole-wing downwash angle,
       - Reynolds number moves CLmax and profile drag, which at model
         scale (Re 30k–400k) it does a lot,
       - stall separation lags the quasi-steady value (dynamic stall):
         a fast pull stalls later and harder, reattachment is slower,
       - planes get the propeller's gyroscopic moment, P-factor, hub
         normal force and slipstream swirl over whatever sits in the wash.
     ===================================================================== */
  function hifiPrep(ac) {
    ac.ll = null; ac._hb = null;
    if (!ac.strips || !ac.strips.length) return;
    /* Reynolds references: the foil numbers are taken to describe the aircraft
       at its own flight regime — CLmax at the Reynolds number of its stall,
       CD0 at that of its cruise — so turning the option on does not move the
       numbers the aircraft was tuned to, only adds how they change away from
       that regime. */
    const w0 = ac.strips.find((x) => x.role === 'wing') || ac.strips[0];
    const CLref = Math.max(0.3, w0.load * (w0.aS * w0.a + w0.CL0));
    const Vs = Math.sqrt((2 * ac.mass * G) / (RHO0 * Math.max(ac.S || 0, 1e-3) * CLref));
    for (const st of ac.strips) {
      st.ReS = (Vs * st.chord) / 1.48e-5;
      st.ReC = (2 * Vs * st.chord) / 1.48e-5;
      st.ll = false;
    }
    /* Group the strips the lifting line will solve: every mirrored or single
       horizontal surface. The file's slope is 3-D (it already contains the
       induced flow), so peel the induced part back out for a first guess at
       the 2-D slope; it is calibrated against the discrete line below. */
    const bySurf = new Map();
    ac.strips.forEach((st, i) => {
      if (st.vert || st.role === 'fin') return;
      if (!bySurf.has(st.surf)) bySurf.set(st.surf, []);
      bySurf.get(st.surf).push(i);
    });
    if (!bySurf.size) return;
    const wingIdx = [];
    for (const [, idx] of bySurf) for (const i of idx) if (ac.strips[i].role === 'wing') wingIdx.push(i);
    /* Horseshoe influence: trailing legs at each strip's edges, downwash read
       at every other strip's centre. The vortex core radius keeps a tail
       strip that sits exactly behind a trailer finite. */
    const groups = [];
    for (const [, idx] of bySurf) {
      const n = idx.length, W = new Float64Array(n * n);
      for (let a = 0; a < n; a++) {
        const si = ac.strips[idx[a]], yi = si.r[1], zi = si.r[2];
        for (let j = 0; j < n; j++) {
          const sj = ac.strips[idx[j]];
          const dz = zi - sj.r[2], rc2 = 0.01 * sj.wy * sj.wy + dz * dz;
          const hl = yi - (sj.r[1] - sj.wy / 2), hr = yi - (sj.r[1] + sj.wy / 2);
          W[a * n + j] = (hl / (hl * hl + rc2) - hr / (hr * hr + rc2)) / (4 * Math.PI);
        }
      }
      const g = { idx, W, E: null, src: null };
      // the wing's wake at each tail station: trailers grown by the downstream
      // distance plus the bound vortex, instead of one downwash for the whole tail
      if (ac.strips[idx[0]].role === 'tail' && wingIdx.length) {
        const wn = wingIdx.length, E = new Float64Array(n * wn);
        for (let a = 0; a < n; a++) {
          const si = ac.strips[idx[a]], yi = si.r[1], zi = si.r[2];
          for (let j = 0; j < wn; j++) {
            const sj = ac.strips[wingIdx[j]];
            const dx = Math.max(0, sj.r[0] - si.r[0]);
            const dz = zi - sj.r[2], rc2 = 0.04 * sj.wy * sj.wy + dz * dz;
            const hl = yi - (sj.r[1] - sj.wy / 2), hr = yi - (sj.r[1] + sj.wy / 2);
            const tr = (hh) => (hh / (hh * hh + rc2)) * (1 + dx / Math.sqrt(dx * dx + hh * hh + rc2));
            const bound = dx > 1e-6 ? (hl / Math.sqrt(dx * dx + hl * hl + rc2) - hr / Math.sqrt(dx * dx + hr * hr + rc2)) / dx : 0;
            E[a * wn + j] = (tr(hl) - tr(hr) + bound) / (4 * Math.PI);
          }
        }
        g.E = E; g.src = wingIdx;
      }
      for (const i of idx) ac.strips[i].ll = true;
      groups.push(g);
    }
    // wings sweep before tails: a tail row reads the wing's circulation
    groups.sort((p, q) => (ac.strips[p.idx[0]].role === 'tail' ? 1 : 0) - (ac.strips[q.idx[0]].role === 'tail' ? 1 : 0));

    /* Calibrate. The strips are few and the vortex cores finite, so the raw
       discrete line comes out a little shy of the continuous theory the 3-D
       slope in the file assumes. Solve each surface at a uniform angle and
       scale its 2-D slope until the line gives back the surface's own 3-D
       slope, then scale the wing→tail influence until the mean tail downwash
       matches the one-angle value the aircraft was trimmed with. What the
       option adds is the structure — who stalls first, what a flap or an
       aileron does to the flow over everything behind it — anchored to the
       numbers the aircraft was tuned to. */
    const solveLin = (g, a0, alpha) => {
      const n = g.idx.length, gm = new Float64Array(n);
      for (let it = 0; it < 80; it++) {
        for (let a = 0; a < n; a++) {
          const st = ac.strips[g.idx[a]];
          let w = 0;
          for (let j = 0; j < n; j++) w += g.W[a * n + j] * gm[j];
          const D = 1 + 0.5 * st.chord * a0 * g.W[a * n + a];
          gm[a] += (0.5 * st.chord * a0 * (alpha - w) - gm[a]) / D;
        }
      }
      return gm;
    };
    const wingGam = new Float64Array(ac.strips.length);
    let CLw = 0;
    for (const g of groups) {
      const sts = g.idx.map((i) => ac.strips[i]);
      let a0 = sts[0].a / Math.max(0.35, 1 - sts[0].a * sts[0].k);
      const A = sts.reduce((t, x) => t + x.area, 0);
      for (let pass = 0; pass < 4; pass++) {
        const gm = solveLin(g, a0, 0.1);
        const got = sts.reduce((t, x, j) => t + ((2 * gm[j]) / x.chord) * x.area, 0) / (A * 0.1);
        a0 *= clamp(sts[0].a / Math.max(got, 0.05), 0.6, 2.5);
      }
      g.a0 = a0;
      if (sts[0].role === 'wing') {
        const gm = solveLin(g, a0, 0.1);
        g.idx.forEach((i, j) => { wingGam[i] = gm[j]; });
        CLw += sts.reduce((t, x, j) => t + ((2 * gm[j]) / x.chord) * x.area, 0);
      }
    }
    const SwAll = ac.strips.reduce((t, x) => t + (x.role === 'wing' ? x.area : 0), 0);
    for (const g of groups) {
      if (!g.E) continue;
      const n = g.idx.length, wn = g.src.length;
      let em = 0;
      for (let a = 0; a < n; a++) { let e = 0; for (let j = 0; j < wn; j++) e += g.E[a * wn + j] * wingGam[g.src[j]]; em += e * ac.strips[g.idx[a]].area; }
      em /= g.idx.reduce((t, i) => t + ac.strips[i].area, 0);
      const target = (2 * (CLw / Math.max(SwAll, 1e-6))) / (Math.PI * ac.ARw);
      const kE = clamp(target / Math.max(em, 1e-6), 0.5, 2.5);
      for (let j = 0; j < g.E.length; j++) g.E[j] *= kE;
    }
    // section constants on the calibrated 2-D slope; the load factor's job is now done by induction.
    // CL0 is scaled the same way the slope was: the camber lift makes circulation too, and the line
    // takes its induced share back out, so the section must start with more to land on the file's number
    for (const g of groups) for (const i of g.idx) {
      const st = ac.strips[i], a0 = g.a0, CL0 = (st.CL0 * a0) / st.a;
      const CLmax = st.load * (st.aS * st.a + st.CL0), CLmin = st.load * (st.CL0 - st.aSn * st.a);
      st.h = {
        load: 1, a: a0, CL0,
        aS: (CLmax - CL0) / a0, aSn: (CL0 - CLmin) / a0,
        dAS: CLmax / a0, dASn: -CLmin / a0,
        M: st.M, CD0: st.CD0, Cm0: st.Cm0, CN90: st.CN90, cmd: st.cmd, tau: st.tau,
      };
    }
    ac.ll = groups;
    const N = ac.strips.length, f = () => new Float64Array(N);
    ac._hb = { uc: f(), un: f(), Vin: f(), ae: f(), dEff: f(), dCL: f(), dCD: f(), slope: f(), ge: f(), wi: f() };
  }

  /* Solve the circulation distribution: Γ = ½·V·c·CL(α − w/V) with w = WΓ,
     damped per strip by its own self-influence (a diagonal Newton step), warm
     started from the last time step so three sweeps keep up at 400 Hz. The
     separation state passed in is the lagged one, so a dynamically stalled
     strip sheds its lift into the line too. Ice is a step stale here (the
     force pass grows it); at mm-per-minute that is nothing. */
  function solveInduced(s, ac, hb) {
    if (!s.gam || s.gam.length !== ac.strips.length) s.gam = new Float64Array(ac.strips.length);
    const gam = s.gam, wi = hb.wi;
    for (let it = 0; it < 3; it++) {
      for (const g of ac.ll) {
        const n = g.idx.length, src = g.src, wn = src ? src.length : 0;
        for (let a = 0; a < n; a++) {
          const gi = g.idx[a], st = ac.strips[gi], Vin = hb.Vin[gi];
          if (Vin === 0) { gam[gi] = 0; wi[gi] = 0; continue; }
          let w = 0;
          const row = a * n;
          for (let j = 0; j < n; j++) w += g.W[row + j] * gam[g.idx[j]];
          if (src) { const rowE = a * wn; for (let j = 0; j < wn; j++) w += g.E[rowE + j] * gam[src[j]]; }
          w *= hb.ge[gi];
          wi[gi] = w;
          const cf = foilCoeffs(st.h, hb.ae[gi] - Math.atan(w / Vin), hb.dEff[gi], hb.dCL[gi], 0, hb.slope[gi],
            s.sep && s.sep[gi] >= 0 ? s.sep[gi] : undefined);
          const D = 1 + 0.5 * st.chord * st.h.a * g.W[row + a] * hb.ge[gi];
          gam[gi] += (0.5 * Vin * st.chord * cf.CL - gam[gi]) / D;
        }
      }
    }
  }

  /* Build strips from a definition. Returns the aircraft object step() uses. */
  function build(def) {
    const ac = JSON.parse(JSON.stringify(def));
    ac.strips = [];
    if (ac.kind === 'quad' || ac.kind === 'heli') return buildRotary(ac);
    const { wingArea, wingSpan, wingSlope } = buildStrips(ac);
    ac.S = wingArea; ac.b = wingSpan;
    const wingStrips = ac.strips.filter((s) => s.role === 'wing');
    ac.flapArea = wingStrips.reduce((t, x) => t + (x.kf ? x.area : 0), 0) / (wingStrips.reduce((t, x) => t + x.area, 0) || 1);
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
      mv(ac.body.r);
      if (ac.prop) mv(ac.prop.r);
      if (ac.motors) for (const mo of ac.motors) { mo[0] -= shift; }
      for (const p of ac.points) mv(p.p);
      for (const wh of ac.wheels) mv(wh.p);
      mv(ac.fpvCam);
      ac.xShift = shift;
      ac.xNP -= shift;
    }
    ac.SM = -ac.xNP / ac.mac;
    if (ac.kind === 'vtol') {
      const base = hoverCommand(ac);
      ac.hoverThr = (base - ac.motor.idle) / (1 - ac.motor.idle);
    }
    hifiPrep(ac);
    return ac;
  }

  /* The motor command that holds a hover on a full pack, as a stick position
     (thrust goes as the command squared, and a sagging pack makes less of it). */
  function hoverCommand(ac) {
    const Bt = ac.batt;
    let base = Math.sqrt((ac.mass * G) / (4 * ac.motor.Tmax));
    for (let i = 0; i < 4; i++) {
      let v = Bt.cells * 4.2;
      for (let j = 0; j < 4; j++) v = Bt.cells * 4.2 - (Bt.Iidle + Bt.Imax * base ** 3 * (v / Bt.Vref) ** 2) * Bt.R;
      const k = (v / Bt.Vref) ** 2;
      base = Math.sqrt((ac.mass * G) / (4 * ac.motor.Tmax * k));
    }
    return base;
  }

  function buildRotary(ac) {
    ac.S = 0; ac.b = ac.kind === 'quad' ? 2 * Math.max(...ac.motors.map(([x, y]) => Math.hypot(x, y))) * 0.71 + ac.motor.D : 2 * ac.rotor.R; ac.mac = 0; ac.ARw = 1; ac.xShift = 0; ac.SM = 0;
    /* A lifting body: a wing in the middle of the frame, at an angle to the
       plane of the props. A quad leaning over to go forward is a quad holding
       its whole airframe at an angle of attack, so a wing bolted across the
       frame carries part of the weight at cruise and the motors carry less of
       it — which is the whole point of a long-range build, and of a speed
       quad's aero shell.

       The surfaces go through exactly the same strip builder as a plane's, so
       the stall, the induced drag, the ground effect and the icing are the
       same code and not a second, friendlier copy of it. What a quad does not
       get is the neutral point and the static margin: its centre of gravity is
       the body origin by definition and the flight controller holds the
       attitude, so there is nothing for a static margin to mean.

       ac.b stays the motor span. It is the length ground effect and shed ice
       are scaled by, and the quad is still a quad. */
    if (ac.surfaces && ac.surfaces.length) {
      const { wingArea, wingSpan } = buildStrips(ac);
      ac.S = wingArea;
      ac.lbSpan = wingSpan;
      ac.ARw = wingArea > 0 ? (wingSpan * wingSpan) / wingArea : 1;
      const ws = ac.strips.reduce((t, x) => t + x.area, 0);
      ac.mac = ws > 0 ? ac.strips.reduce((t, x) => t + x.area * x.chord, 0) / ws : 0;
      // a lifting body has no moving surfaces; stripForces still asks for the limit
      ac.defl = ac.defl || { a: 0, e: 0, r: 0, f: 0, flapMax: 0 };
      ac.flapArea = 0;
      ac.deda = 0;
    }
    if (ac.kind === 'quad') {
      // collective thrust for hover, as a stick position (thrust ∝ motor command²)
      const base = hoverCommand(ac);
      ac.hoverThr = (base - ac.motor.idle) / (1 - ac.motor.idle);
    }
    if (ac.kind === 'heli') {
      const Ro = ac.rotor;
      Ro.A = Math.PI * Ro.R * Ro.R;
      Ro.sigma = (Ro.blades * Ro.chord) / (Math.PI * Ro.R);
      // blade tips at 8 azimuths: touching the ground while the rotor turns is a blade strike
      for (let k = 0; k < 8; k++) { const az = (k / 8) * 2 * Math.PI; ac.points.push({ p: [Ro.R * Math.cos(az), Ro.R * Math.sin(az), -Ro.h], name: 'rotor blade', prop: true, rotor: true, strike: 0.2, impact: 0.5, slide: 0.5 }); }
      // hover collective and its stick position on each pitch curve
      const T = ac.mass * G, OmR = Ro.om0 * Ro.R, vi = Math.sqrt((Ro.kInd * T) / (2 * 1.225 * Ro.A));
      const k = 0.5 * Ro.sigma * Ro.a * 1.225 * Ro.A * OmR * OmR;
      ac.hoverPitch = 3 * (T / k + vi / OmR / 2);
      const stickFor = (c) => { const d = ac.hoverPitch / D2R; return d < c[1] ? (0.5 * (d - c[0])) / (c[1] - c[0]) : 0.5 + (0.5 * (d - c[1])) / (c[2] - c[1]); };
      ac.hoverThrCurve = { normal: stickFor(Ro.curves.normal), '3d': stickFor(Ro.curves['3d']) };
      ac.hoverThr = ac.hoverThrCurve.normal;
    }
    hifiPrep(ac);
    return ac;
  }

  function makeState() {
    return {
      p: [0, 0, 0], v: [0, 0, 0], q: [1, 0, 0, 0], w: [0, 0, 0],
      n: 0, sa: 0, se: 0, sr: 0, sf: 0, gear: 1, fwd: 0, soc: 1, mAh: 0, vb: 0, I: 0,
      crashed: false, crashMsg: '', wow: false, held: false, t: 0, clw: 0,
      mot: [0, 0, 0, 0], pidI: [0, 0, 0], spPrev: [0, 0, 0], ff: [0, 0, 0], buf: [0, 0], wPrev: [0, 0, 0], dF: [0, 0, 0], // flight controller
      om: 0, coll: 0, gov: 0, tailI: 0, vi: 0, tilt: [0, 0], tt: 0, // helicopter rotor
      bT: 20, ice: null, iceProp: 0, iceLens: 0, iceMass: 0, iceGl: 0, shed: 0, // pack temperature (°C) and icing
      sep: null, gam: null, // accurate aero: per-strip separation lag and circulation (lazily sized)
      tele: { alpha: 0, beta: 0, V: 0, CL: 0, qbar: 0, T: 0, nz: 1, stallL: 0, stallR: 0 },
    };
  }

  /* Put the aircraft at a start position. `where` is one of the aircraft's own
     start names for the built-in field, or an object from a map's `starts`:
     { n, e, yawDeg, aglM, speedMs }, with aglM measured from the ground.
     `ground` is anything with heightAt(n, e) — a loaded map's terrain — so a
     start on a hillside starts on the hillside. */
  function reset(s, ac, where, packC = 20, ground = null) {
    const gAt = ground && ground.heightAt ? ground : null;
    const up = (n, e) => (gAt ? gAt.heightAt(n, e) : 0);
    s.bT = packC; s.ice = null; s.iceProp = 0; s.iceLens = 0; s.iceMass = 0; s.iceGl = 0; s.shed = 0;
    s.sep = null; s.gam = null;
    s.w = [0, 0, 0]; s.n = 0; s.sa = s.se = s.sr = s.sf = 0; s.gear = 1;
    s.crashed = false; s.crashMsg = ''; s.mAh = 0; s.soc = 1; s.t = 0; s.held = false; s.clw = 0;
    s.mot = [0, 0, 0, 0]; s.pidI = [0, 0, 0]; s.spPrev = [0, 0, 0]; s.ff = [0, 0, 0]; s.buf = [0, 0]; s.wPrev = [0, 0, 0]; s.dF = [0, 0, 0]; s.om = 0; s.coll = 0; s.gov = 0; s.tailI = 0; s.vi = 0; s.tilt = [0, 0]; s.tt = 0;
    s.fwd = 0;

    /* A tail-sitter stands on its tail with the nose straight up, and in the
       air it is already flying horizontally. */
    if (ac.kind === 'vtol' && !(where && typeof where === 'object')) {
      const hov = Math.sqrt((ac.mass * G) / (4 * ac.motor.Tmax));
      if (where === 'air') {
        s.fwd = 1;
        const V = ac.trans.vAir;
        s.p = [60, 40, -up(60, 40) - 60];
        s.q = quatFromEuler(0, ac.trans.pitch, -Math.PI / 2);
        s.v = mulMV(quatToMat(s.q), [V, 0, 0]);
        s.mot = [hov, hov, hov, hov];
      } else {
        // on its tail on the pad, nose at the sky
        s.q = quatFromEuler(0, Math.PI / 2, 0);
        const R0 = quatToMat(s.q);
        const zr = Math.max(...ac.points.map((pt) => mulMV(R0, pt.p)[2]));
        s.p = [8, 1.5, -up(8, 1.5) - zr - 0.001];
        s.v = [0, 0, 0];
      }
      return;
    }

    // a start position out of a map file: put it where the map says
    if (where && typeof where === 'object') {
      const n = +where.n || 0, e = +where.e || 0, agl = +where.aglM || 0;
      const psi = (+where.yawDeg || 0) * D2R;
      // on the ground means the lowest contact point touching, not the CG on the ground
      const zr = agl > 0.05 ? 0 : Math.max(0, ...[...ac.points, ...ac.wheels].map((pt) => pt.p[2])) + 0.001;
      s.p = [n, e, -up(n, e) - agl - zr];
      s.q = quatFromEuler(0, agl > 0.05 ? 0.02 : 0, psi);
      const V = +where.speedMs || 0;
      s.v = V > 0 ? mulMV(quatToMat(s.q), [V, 0, 0]) : [0, 0, 0];
      if (V > 0 || agl > 0.05) {
        if (ac.kind === 'quad' || ac.kind === 'vtol') { const b = Math.sqrt((ac.mass * G) / (4 * ac.motor.Tmax)); s.mot = [b, b, b, b]; if (ac.kind === 'vtol') s.fwd = V > 0 ? 1 : 0; }
        else if (ac.kind === 'heli') { s.om = ac.rotor.om0; s.gov = 1; s.coll = ac.hoverPitch; s.vi = Math.sqrt((ac.mass * G) / (2 * 1.225 * ac.rotor.A)); }
        else s.n = ac.kind === 'wing' ? 0.45 : 0.6;
      }
      return;
    }

    if (ac.kind === 'quad' || ac.kind === 'heli') {
      const zr = Math.max(...ac.points.map((pt) => pt.p[2]));
      if (where === 'air') {
        // hovering in front of the pilot, nose north
        s.p = [15, 0, -up(15, 0) - 6]; s.q = [1, 0, 0, 0]; s.v = [0, 0, 0];
        if (ac.kind === 'quad') { const b = Math.sqrt((ac.mass * G) / (4 * ac.motor.Tmax)); s.mot = [b, b, b, b]; }
        else { s.om = ac.rotor.om0; s.gov = 1; s.coll = ac.hoverPitch; s.vi = Math.sqrt((ac.mass * G) / (2 * 1.225 * ac.rotor.A)); }
      } else {
        // on the pad 8 m in front of the pilot, nose north
        s.p = [8, 1.5, -up(8, 1.5) - zr - 0.001]; s.q = [1, 0, 0, 0]; s.v = [0, 0, 0];
      }
      return;
    }
    if (where === 'air') {
      // downwind leg in front of the pilot, flying west (pilot's right to left)
      const V = ac.kind === 'wing' ? 18 : 15;
      s.p = [60, 40, -up(60, 40) - 40];
      s.q = quatFromEuler(0, 0.02, -Math.PI / 2);
      s.v = mulMV(quatToMat(s.q), [V, 0, 0]);
      s.n = ac.kind === 'wing' ? 0.45 : 0.6;
    } else if (where === 'launch') {
      // held in the pilot's hand, pointing north (away from the pilot), nose up 10°
      s.p = [0.6, 0.45, -up(0.6, 0.45) - 1.7];
      s.q = quatFromEuler(0, 10 * D2R, 0);
      s.v = [0, 0, 0];
      s.held = true;
    } else {
      // runway, west end, pointing east, wheels just touching
      const zw = ac.wheels.length ? ac.wheels[0].p[2] : 0.05;
      s.p = [12, -52, -up(12, -52) - zw - 0.002];
      s.q = quatFromEuler(0, 0, Math.PI / 2);
      s.v = [0, 0, 0];
    }
  }

  // hand launch: a firm overhand throw, ~11 m/s (25 mph) along the nose
  function launch(s) {
    if (!s.held) return;
    s.held = false;
    s.v = mulMV(quatToMat(s.q), [11, 0, 0]);
    s.w = [0, 0, 0];
  }

  /* Section coefficients of one strip at effective angle of attack ae (rad).
     Linear lift below stall, flat-plate normal force above, blended by a
     sigmoid around the strip's own stall angles (Beard & McLain 2012). */
  function foilCoeffs(st, ae, d, dCL = 0, dCD = 0, slope = 1, sigOv) {
    // dCL: fraction of CLmax lost (ice, rain), dCD: added profile drag, slope: lift-slope factor
    // sigOv: use this separation state instead of the quasi-steady one (dynamic stall lag)
    /* A deflected flap adds camber, so the section carries more lift before it
       separates. Plain-flap measurements (NACA 23012 with a 20% flap at 30°:
       CLmax +0.5 and the stall 4° earlier) put the extra lift at about 55% of
       what the deflection adds, so the stall angle in geometric terms falls by
       the other 45%. Without this, a landing flap setting would read as a wing
       that is already stalled. */
    const ds = clamp(0.55 * st.tau * d, -0.9 * st.aSn, 0.9 * st.aS);
    const e1 = Math.exp(-st.M * (ae - (st.aS - dCL * st.dAS + ds)));
    const e2 = Math.exp(st.M * (ae + (st.aSn - dCL * st.dASn - ds)));
    const sigS = (1 + e1 + e2) / ((1 + e1) * (1 + e2)); // 0 attached … 1 stalled, quasi-steady
    const sig = sigOv === undefined ? sigS : sigOv;
    const sn = Math.sin(ae), cs = Math.cos(ae);
    const CLlin = st.load * (st.CL0 + st.a * slope * ae);
    return {
      sig, sigS, CLlin,
      CL: (1 - sig) * CLlin + sig * st.CN90 * sn * cs,
      CDp: st.CD0 + dCD + sig * st.CN90 * sn * sn,
      Cm: (1 - sig) * (st.Cm0 + st.cmd * d) - sig * 0.2 * st.CN90 * sn,
    };
  }

  /* One reusable result for the terrain query. The ground is asked for at up to
     ten contact points, 400 times a second; allocating there would make the
     garbage collector part of the flight model. */
  const gProbe = { up: 0, dn: 0, de: 0, nN: 0, nE: 0, nD: -1, cls: 0 };


  /* Every lifting surface, strip by strip: its own airflow, angle of attack,
     stall, ice and flap. Adds to F and Mo in the body frame and returns what
     the telemetry and the next step's tail downwash need. Shared by the
     fixed-wing and tail-sitter models.

     sw (accurate aero only): slipstream swirl behind the propeller, as a
     solid rotation { w rad/s, y, z axis position } felt by strips in the
     wash — the reason a powerful tractor needs right rudder. */
  function stripForces(s, ac, vb, wa, R, rho, env, dWash, dt, F, Mo, sw) {
      // --- lifting strips ---
      const hCG = -s.p[2];
      let clwSum = 0, clwArea = 0, stL = 0, stR = 0, aL = 0, aR = 0, aSum = 0;
      const eps = (2 * s.clw) / (Math.PI * ac.ARw); // tail downwash from last step's wing CL
      // weather: rain roughens the wing; ice builds on each strip's leading edge and melts above freezing
      const wxa = env.wx, rainP = wxa ? wxa.rain : 0;
      const icing = wxa && wxa.lwc > 0 && wxa.T < 3, melt = wxa && wxa.T > 0.5 ? (wxa.T - 0.5) * 2e-6 * (wxa.rain > 0 ? 3 : 1) * dt : 0;
      if (icing && !s.ice) s.ice = new Float64Array(ac.strips.length);
      let iceM = 0;
      const hb = env.hifi && ac._hb ? ac._hb : null;
      if (hb) {
        /* Accurate aero, first pass: each strip's local flow, flap and weather,
           buffered so the circulation solve can see the whole span at once. */
        for (let i = 0; i < ac.strips.length; i++) {
          const st = ac.strips[i], r = st.r34;
          let v0 = vb[0] + (wa[1] * r[2] - wa[2] * r[1]);
          let v1 = vb[1] + (wa[2] * r[0] - wa[0] * r[2]);
          let v2 = vb[2] + (wa[0] * r[1] - wa[1] * r[0]);
          if (sw && st.wash) { v1 += sw.w * (r[2] - sw.z); v2 -= sw.w * (r[1] - sw.y); }
          let uc = v0 * st.c[0] + v1 * st.c[1] + v2 * st.c[2];
          const un = v0 * st.n[0] + v1 * st.n[1] + v2 * st.n[2];
          if (st.wash) uc += dWash;
          const V2 = uc * uc + un * un;
          if (V2 < 0.04) { hb.Vin[i] = 0; continue; }
          const Vin = Math.sqrt(V2);
          let alpha = Math.atan2(-un, uc);
          // a tail the lifting line can't reach (a vertical one) keeps the one-angle downwash
          if (st.role === 'tail' && !st.ll) alpha -= eps;
          const d = clamp(st.ka * s.sa + st.ke * s.se + st.kr * s.sr + st.kf * s.sf, -ac.defl.flapMax, ac.defl.flapMax);
          const flex = ac.flexQ ? 1 / (1 + (0.5 * rho * V2) / ac.flexQ) : 1;
          // no partial-span flap knockdown here: the circulation solve induces that downwash itself
          const dEff = d * flex * (1 - 0.65 * clamp((Math.abs(d) - 0.21) / 0.58, 0, 1));
          let ae = alpha + st.tau * dEff;
          if (ae > Math.PI) ae -= 2 * Math.PI; else if (ae < -Math.PI) ae += 2 * Math.PI;
          let dCL = 0.12 * rainP, dCD = 0.01 * rainP;
          /* Reynolds number: CLmax referenced at the stall's Re, CD0 at the
             cruise's, so the published numbers stay put and only the trend
             away from them is added — slower is draggier and stalls sooner,
             faster carries a little more before letting go. */
          const Re = (Vin * st.chord * rho) / 1.81e-5;
          dCL += 1 - clamp(Math.pow(Re / st.ReS, 0.12), 0.8, 1.08);
          dCD += st.CD0 * (clamp(Math.pow(st.ReC / Re, 0.2), 0.85, 1.6) - 1);
          const hz = hCG - (R[6] * st.r[0] + R[7] * st.r[1] + R[8] * st.r[2]);
          const g16 = (16 * Math.max(0.02, hz)) / (ac.b || 1);
          hb.ge[i] = st.role === 'fin' ? 1 : (g16 * g16) / (1 + g16 * g16);
          hb.uc[i] = uc; hb.un[i] = un; hb.Vin[i] = Vin; hb.ae[i] = ae; hb.dEff[i] = dEff;
          hb.dCL[i] = dCL; hb.dCD[i] = dCD; hb.slope[i] = 1;
        }
        if (ac.ll) solveInduced(s, ac, hb);
        if (!s.sep || s.sep.length !== ac.strips.length) s.sep = new Float64Array(ac.strips.length).fill(-1);
      }
      for (let i = 0; i < ac.strips.length; i++) {
        const st = ac.strips[i];
        let uc, un, V2, Vin, ae, alpha, dEff, dCL, dCD, slope, wIn = 0;
        if (hb) {
          Vin = hb.Vin[i];
          if (Vin === 0) continue;
          uc = hb.uc[i]; un = hb.un[i]; V2 = Vin * Vin;
          dEff = hb.dEff[i]; dCL = hb.dCL[i]; dCD = hb.dCD[i]; slope = hb.slope[i];
          wIn = st.ll ? hb.wi[i] : 0;
          alpha = hb.ae[i] - st.tau * dEff;
          ae = hb.ae[i] - Math.atan(wIn / Vin);
        } else {
          const r = st.r34; // angle of attack taken at 3/4 chord (Pistolesi); force applied at 1/4 chord
          const v0 = vb[0] + (wa[1] * r[2] - wa[2] * r[1]);
          const v1 = vb[1] + (wa[2] * r[0] - wa[0] * r[2]);
          const v2 = vb[2] + (wa[0] * r[1] - wa[1] * r[0]);
          uc = v0 * st.c[0] + v1 * st.c[1] + v2 * st.c[2];
          un = v0 * st.n[0] + v1 * st.n[1] + v2 * st.n[2];
          if (st.wash) uc += dWash;
          V2 = uc * uc + un * un;
          if (V2 < 0.04) continue;
          Vin = Math.sqrt(V2);
          alpha = Math.atan2(-un, uc);
          if (st.role === 'tail') alpha -= eps;
          const d = clamp(st.ka * s.sa + st.ke * s.se + st.kr * s.sr + st.kf * s.sf, -ac.defl.flapMax, ac.defl.flapMax);
          const flex = ac.flexQ ? 1 / (1 + (0.5 * rho * V2) / ac.flexQ) : 1;
          /* Thin-airfoil flap theory holds to about 12°; past that the flow starts
             to leave the flap and the extra lift tails off — a plain flap at 30°
             measures about 65% of theory, and at 45° it has almost given up. */
          dEff = d * flex * (1 - 0.65 * clamp((Math.abs(d) - 0.21) / 0.58, 0, 1));
          /* A flap over part of the span dumps a bump of lift inboard, and that bump
             induces downwash on itself: lifting-line solutions put the extra induced
             angle at roughly 45% of the flap's α shift for a short flap, fading to
             nothing when the flap runs the whole span. It costs some of the flap's
             lift and it is what stops the flapped span from stalling far ahead of
             the rest of the wing. Flaps up (kf = 0 everywhere) this does nothing. */
          if (st.kf) dEff *= 1 - 0.45 * (1 - (ac.flapArea || 0));
          ae = alpha + st.tau * dEff;
          if (ae > Math.PI) ae -= 2 * Math.PI; else if (ae < -Math.PI) ae += 2 * Math.PI;
          dCL = 0.12 * rainP; dCD = 0.01 * rainP; slope = 1;
        }
        if (s.ice) {
          let k = s.ice[i];
          if (icing) k += iceRate(wxa, Vin, st.chord, wxa.T) * dt;
          if (melt && k > 0) k = Math.max(0, k - melt);
          s.ice[i] = k;
          if (k > 0) { const pn = icePenalty(k / st.chord, s.iceGl); dCL += pn.dCL; dCD += pn.dCD; slope *= pn.slope; iceM += 80 * k * st.area; }
        }
        let cf, CD;
        if (hb) {
          const stc = st.ll ? st.h : st;
          const cfS = foilCoeffs(stc, ae, dEff, dCL, dCD, slope);
          /* Dynamic stall: separation chases the quasi-steady state over a few
             chord times — slower to let go, slower still to reattach. A fast
             pull rides the attached line past the static stall angle and then
             breaks harder; recovery wants the nose held down for a moment. */
          if (s.sep[i] < 0) s.sep[i] = cfS.sigS;
          const tauS = ((cfS.sigS > s.sep[i] ? 4 : 8) * st.chord) / Math.max(Vin, 1);
          s.sep[i] += (cfS.sigS - s.sep[i]) * Math.min(1, dt / tauS);
          cf = foilCoeffs(stc, ae, dEff, dCL, dCD, slope, s.sep[i]);
          // induced drag is the lift tilted back by the induced angle the solve found
          CD = st.ll ? cf.CDp + cf.CL * (wIn / Vin)
            : cf.CDp + (1 - cf.sig) * st.k * hb.ge[i] * cf.CLlin * cf.CLlin;
        } else {
          cf = foilCoeffs(st, ae, dEff, dCL, dCD, slope);
          // induced drag, reduced in ground effect (McCormick)
          const hz = hCG - (R[6] * st.r[0] + R[7] * st.r[1] + R[8] * st.r[2]);
          const g16 = (16 * Math.max(0.02, hz)) / (ac.b || 1);
          const ge = st.role === 'fin' ? 1 : (g16 * g16) / (1 + g16 * g16);
          CD = cf.CDp + (1 - cf.sig) * st.k * ge * cf.CLlin * cf.CLlin;
        }
        const qs = ((wa[0] * st.s[0] + wa[1] * st.s[1] + wa[2] * st.s[2]) * st.chord) / Vin;
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
      // ice mass ≈ ρ_ice·0.1·k·c per unit span (a wedge ~10% of chord deep); glaze share by mass
      if (icing && iceM > s.iceMass) s.iceGl += ((glazeOf(wxa.T) - s.iceGl) * (iceM - s.iceMass)) / iceM;
      s.iceMass = iceM;
    return {
      alpha: clwArea > 0 ? aSum / clwArea : 0,
      stallL: aL ? stL / aL : 0,
      stallR: aR ? stR / aR : 0,
    };
  }

  /* Second half of every step, shared by all aircraft: gravity, ground contact, crash checks
     and integration. F and Mo are the body-frame force and moment from the aircraft itself. */
  function finish(s, ac, F, Mo, R, env, dt) {
    const m = ac.mass + (s.iceMass || 0), I = ac.I, w = s.w;
    // small structural damping that never fades (keeps a parked model from spinning forever)
    Mo[0] -= 0.02 * I[0] * w[0]; Mo[1] -= 0.02 * I[1] * w[1]; Mo[2] -= 0.02 * I[2] * w[2];

    const Fw = mulMV(R, F);
    Fw[2] += m * G;

    /* --- ground contact: spring–damper per point, regularised Coulomb friction ---
       The ground is whatever env.terrain says it is. Without one it is the flat
       plane at NED z = 0 this started out as, and the arithmetic below reduces
       to exactly that: the normal becomes (0, 0, -1), the perpendicular depth
       becomes the vertical one, the closing speed becomes the descent rate and
       the tangent plane becomes the horizontal one.

       With a terrain the spring pushes along the surface normal and friction
       acts in the surface's tangent plane, so a model set down on a slope
       slides down it instead of gripping a horizontal plane it is not touching,
       and a hard arrival is judged on the speed into the slope rather than on
       descent rate — which is the difference between a survivable uphill
       landing and a crash into a hillside at the same sink rate. */
    const C = ac.contact, T = env.terrain || null;
    let wow = false, crash = null, touching = false;
    const Fcb = [0, 0, 0];
    const contactPt = (pt, isWheel) => {
      const r = pt.p;
      const rw = mulMV(R, r);
      let gUp = 0, nN = 0, nE = 0, nD = -1;
      if (T) {
        T.probe(s.p[0] + rw[0], s.p[1] + rw[1], gProbe);
        gUp = gProbe.up; nN = gProbe.nN; nE = gProbe.nE; nD = gProbe.nD;
      }
      const pz = s.p[2] + rw[2] + gUp; // > 0: the point is below the surface
      if (pz <= 0) return;
      touching = true;
      const depth = pz * -nD; // vertical overlap turned perpendicular to the slope
      const vp = mulMV(R, cross(w, r));
      vp[0] += s.v[0]; vp[1] += s.v[1]; vp[2] += s.v[2];
      const vn = vp[0] * nN + vp[1] * nE + vp[2] * nD; // along the outward normal
      const closing = -vn; // into the surface, positive
      const k = isWheel ? C.kW : C.kB, c = isWheel ? C.cW : C.cB;
      const N = Math.max(0, k * depth + c * closing);
      // velocity in the surface's tangent plane
      const tN = vp[0] - vn * nN, tE = vp[1] - vn * nE, tD = vp[2] - vn * nD;
      let fx = 0, fy = 0, fz = 0, rolled = false;
      if (isWheel) {
        const stA = pt.steer && ac.defl.r ? (s.sr / ac.defl.r) * ac.steerMax : 0;
        const fwv = mulMV(R, [Math.cos(stA), Math.sin(stA), 0]);
        // the wheel rolls along its heading flattened into the surface
        const fd = fwv[0] * nN + fwv[1] * nE + fwv[2] * nD;
        let hx = fwv[0] - fd * nN, hy = fwv[1] - fd * nE, hz = fwv[2] - fd * nD;
        const nh = Math.hypot(hx, hy, hz);
        if (nh > 0.3) {
          hx /= nh; hy /= nh; hz /= nh;
          // sideways: the surface normal crossed with the rolling direction
          const lx = nE * hz - nD * hy, ly = nD * hx - nN * hz, lz = nN * hy - nE * hx;
          const vl = vp[0] * hx + vp[1] * hy + vp[2] * hz;
          const vs = vp[0] * lx + vp[1] * ly + vp[2] * lz;
          const Fl = -C.muRoll * N * sat(vl / 0.3), Ft = -C.muLat * N * sat(vs / 0.1);
          fx = Fl * hx + Ft * lx; fy = Fl * hy + Ft * ly; fz = Fl * hz + Ft * lz;
          rolled = true;
        }
      }
      if (!rolled) {
        const vt = Math.hypot(tN, tE, tD);
        if (vt > 1e-6) { const f = (-C.muBody * N * sat(vt / 0.2)) / vt; fx = f * tN; fy = f * tE; fz = f * tD; }
      }
      const Fc = [fx + N * nN, fy + N * nE, fz + N * nD];
      Fw[0] += Fc[0]; Fw[1] += Fc[1]; Fw[2] += Fc[2];
      const fb = mulMtV(R, Fc);
      Fcb[0] += fb[0]; Fcb[1] += fb[1]; Fcb[2] += fb[2];
      const mc = cross(r, fb);
      Mo[0] += mc[0]; Mo[1] += mc[1]; Mo[2] += mc[2];
      const impact = closing, slide = Math.hypot(tN, tE, tD);
      if (isWheel) {
        wow = true;
        if (impact > ac.crash.wheelImpact) crash = 'Hard landing — gear folded';
      } else {
        if (pt.name === 'belly' || pt.foot) wow = true;
        const spin = pt.motor !== undefined ? s.mot[pt.motor] : pt.rotor ? s.om / ac.rotor.om0 : s.n;
        if (pt.prop && spin > 0.25 && Math.hypot(vp[0], vp[1], vp[2]) > (pt.strike || 0.5))
          crash = pt.rotor ? 'Blade strike — the rotor hit the ground' : 'Prop strike — motor still running at touchdown';
        else if (impact > pt.impact || slide > pt.slide) crash = 'Crashed — ' + pt.name + ' hit the ground';
      }
    };
    if (!ac.retract || s.gear > 0.5) for (const wh of ac.wheels) contactPt(wh, true);
    for (const b of ac.points) contactPt(b, false);
    s.wow = wow;
    /* A model dragging on a slope steeper than atan(mu) gets tripped by its own
       feet and tumbles. Friction torque then spins it faster than the explicit
       integrator can follow, the contact points' own r x w velocity runs away,
       and a few tenths of a second later the state goes non-finite and the
       numerical-error guard below silently puts it back on the pad with the
       crash flag cleared — so a genuine crash on a hillside would read as a
       teleport. A model in contact with the ground and rotating at 40 rad/s
       (380 rpm, well past the ~31 rad/s a 5" quad can command in the air) has
       tumbled, and tumbled is crashed. Catching it here keeps the crash
       honest and keeps the integrator inside its range. */
    if (!crash && touching && Math.hypot(w[0], w[1], w[2]) > 40) crash = 'Tumbled — it rolled down the slope';
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


    if (!Number.isFinite(s.p[0] + s.p[1] + s.p[2] + s.q[0] + w[0] + w[1] + w[2])) {
      reset(s, ac, ac.starts[0], 20, env.terrain || null);
      s.crashMsg = 'Simulation reset (numerical error)';
    }
    return Fcb;
  }

  /* One fixed time step.
     ctl: { thr 0..1, a, e, r  in -1..1 }
     env: { rho, wind[3] NED m/s, battery bool, crashes bool } */
  function step(s, ac, ctl, env, dt) {
    const m = ac.mass, I = ac.I, P = ac.prop, B = ac.batt;
    s.t += dt;
    if (ac.kind === 'quad') return stepQuad(s, ac, ctl, env, dt);
    if (ac.kind === 'heli') return stepHeli(s, ac, ctl, env, dt);
    if (ac.kind === 'vtol') return stepVtol(s, ac, ctl, env, dt);

    /* --- motor & battery ---
       A reversing ESC (ctl.rev, on an aircraft whose prop.reverse says it has
       one) makes the middle of the throttle zero and everything below it
       reverse: s.n then runs −1 … +1 instead of 0 … 1. A reversing prop is
       much less efficient backwards — the blade is the wrong way round — which
       is what prop.revEff is for. */
    const rev = !!(ctl.rev && P.reverse);
    let thrCmd = s.crashed ? 0 : rev ? 2 * clamp(ctl.thr, 0, 1) - 1 : clamp(ctl.thr, 0, 1);
    if (env.battery && s.soc <= 0) thrCmd = 0;
    s.n += (thrCmd - s.n) * Math.min(1, dt / P.tau);
    if (!rev && s.n < 0) s.n = 0;
    const rho = env.rho;
    const an = Math.abs(s.n);
    const vbody = Math.hypot(s.v[0], s.v[1], s.v[2]);
    const pice = iceSmall(s, env, vbody, 3.5 * P.Vp * an + vbody, 0.08 * P.D + 0.006, dt);
    // motor current: power ∝ ρ·rpm³ for a fixed prop (thin air unloads it), more with an iced prop
    battery(s, B, B.Iidle + B.Imax * an * an * an * (rho / RHO0) * pice.power, vbody, env, dt);

    // --- servos ---
    s.sa = approach(s.sa, sat(ctl.a) * ac.defl.a, ac.servoRate * dt);
    s.se = approach(s.se, sat(ctl.e) * ac.defl.e, ac.servoRate * dt);
    s.sr = approach(s.sr, sat(ctl.r) * ac.defl.r, ac.servoRate * dt);
    // flaps: a slow separate channel (0 = up, 1 = full), and retractable gear in transit
    s.sf = approach(s.sf, clamp(ctl.f || 0, 0, 1) * (ac.defl.f || 0), ((ac.defl.f || 0) / 2) * dt);
    if (ac.retract) s.gear = approach(s.gear, ctl.gear === undefined || ctl.gear ? 1 : 0, dt / ac.retract.time);

    if (s.held) { // in the pilot's hand: motor spins, nothing moves
      const rpm0 = s.n * clamp(s.vb / B.Vref, 0, 1.15);
      s.tele.T = P.T0 * (rho / RHO0) * rpm0 * Math.abs(rpm0); s.tele.V = 0;
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
    // rpm·|rpm| keeps the sign when the prop is turning backwards
    let T = P.T0 * (rho / RHO0) * (rpm * Math.abs(rpm) - (rpm * Vax) / P.Vp);
    if (rpm < 0) T *= P.revEff || 0.6; // a propeller pushing backwards is a bad propeller
    T = Math.max(P.Tmin * (rho / RHO0) * Math.min(1, Math.abs(Vax) / P.Vp), T) * pice.thrust;
    let dWash = 0; // slipstream speed-up behind a tractor prop (momentum theory, part developed)
    if (P.wash && T > 0) {
      const A = (Math.PI * P.D * P.D) / 4, Vx = Math.max(0, Vax);
      // `=== undefined`, not `||`: a file that says eta is zero means zero
      dWash = (P.eta === undefined ? 0.5 : P.eta) * (Math.sqrt(Vx * Vx + (2 * T) / (rho * A)) - Vx);
    }
    const F = [T, 0, 0];
    const Mo = cross(P.r, F);
    Mo[0] += P.torque * T * P.D; // prop reaction torque
    if (s.shed > 0) for (let k = 0; k < 3; k++) Mo[k] += (Math.random() * 2 - 1) * s.shed * 0.04 * m * ac.b; // ice shed off the prop: imbalance

    /* --- accurate aero: what a spinning propeller does besides pull ---
       Gyroscopic precession (pitch begets yaw and yaw begets pitch, through the
       prop's angular momentum), P-factor (the advancing blade at an angle of
       attack carries more of the thrust, so the thrust line walks sideways),
       the hub normal force (the disc turns the oncoming flow toward its axis,
       a small fin at the prop — destabilising on a tractor, stabilising on a
       pusher), and slipstream swirl over whatever flies in the wash. */
    let sw = null;
    if (env.hifi) {
      const spin = P.torque <= 0 ? 1 : -1; // reaction rolls one way, the prop turns the other
      const Om = (2 * Math.PI * P.Vp * rpm) / (0.65 * P.D); // rad/s, pitch taken as 0.65·D
      // geometrically similar props weigh like D³ and store momentum like D⁵; Ip overrides the estimate
      const H = spin * (P.Ip === undefined ? 0.075 * Math.pow(P.D, 4.7) : P.Ip) * Om;
      Mo[1] -= H * w[2]; Mo[2] += H * w[1];
      if (T > 0) {
        const A = (Math.PI * P.D * P.D) / 4;
        const mdot = rho * A * Math.sqrt(Math.max(0, Vax) ** 2 + (2 * T) / (rho * A)); // momentum-theory mass flow
        const Fy = -0.25 * mdot * vb[1], Fz = -0.25 * mdot * vb[2]; // hub normal force: partial flow turning
        F[1] += Fy; F[2] += Fz;
        Mo[0] += P.r[1] * Fz - P.r[2] * Fy; Mo[1] -= P.r[0] * Fz; Mo[2] += P.r[0] * Fy;
        const Vt = 0.35 * P.D * Math.abs(Om); // blade speed at 75% radius
        if (Vt > 2) {
          Mo[1] -= (0.5 * T * spin * P.D * vb[1]) / Vt; // P-factor: sideslip pitches,
          Mo[2] -= (0.5 * T * spin * P.D * vb[2]) / Vt; // angle of attack yaws
        }
        // swirl: the reaction torque leaves the wake as solid-body rotation
        if (P.wash) sw = { w: clamp((spin * Math.abs(P.torque) * T * P.D) / (Math.max(mdot, 1e-3) * 0.1225 * P.D * P.D), -60, 60), y: P.r[1], z: P.r[2] };
      }
    }

    // --- lifting surfaces ---
    // turbulence: rotational gusts (Dryden p, q, r) act like the air itself rotating
    const gw = env.gw || [0, 0, 0], wa = [w[0] - gw[0], w[1] - gw[1], w[2] - gw[2]];
    const sf = stripForces(s, ac, vb, wa, R, rho, env, dWash, dt, F, Mo, sw);

    // --- fuselage / pod drag ---
    if (V > 0.1) {
      const Bd = ac.body, k = 0.5 * rho * V;
      // CdA[0] is the clean aircraft; extended gear adds retract.drag of frontal area
      const CdAx = Bd.CdA[0] + (ac.retract ? ac.retract.drag * s.gear : 0);
      const fb = [-k * CdAx * vb[0], -k * Bd.CdA[1] * vb[1], -k * Bd.CdA[2] * vb[2]];
      F[0] += fb[0]; F[1] += fb[1]; F[2] += fb[2];
      const mb = cross(Bd.r, fb);
      Mo[0] += mb[0]; Mo[1] += mb[1]; Mo[2] += mb[2];
    }
    const Fcb = finish(s, ac, F, Mo, R, env, dt);

    const t = s.tele;
    t.alpha = sf.alpha;
    t.beta = V > 0.3 ? Math.asin(clamp(vb[1] / V, -1, 1)) : 0;
    t.V = V; t.qbar = 0.5 * rho * V * V; t.T = T; t.CL = s.clw;
    t.nz = -(F[2] + Fcb[2]) / (m * G);
    t.stallL = sf.stallL; t.stallR = sf.stallR;

  }

  /* Flight-controller setpoints (rad/s) for multirotors and flybarless helis.
     mode: 'acro' | 'horizon' | 'trainer' | 'angle'; lim (degrees): { bank, pitch, tBank, tPitch }
       angle   – sticks command bank and pitch up to bank/pitch, centred sticks level
       horizon – levels near centre stick, fading to pure acro at 75% stick so flips are possible
       trainer – acro, but stopped at tBank/tPitch (80 ms look-ahead); it does not level */
  function rotarySetpoints(ctl, R, w, ac) {
    const RT = ac.rates, A = ac.angle;
    const lim = ctl.lim || { bank: A.max, pitch: A.max, tBank: 60, tPitch: 60 };
    // an axis the caller left out is centred, not NaN
    const a = sat(ctl.a || 0), e = sat(ctl.e || 0);
    const acro = [actualRate(a, RT.roll) * D2R, actualRate(e, RT.pitch) * D2R, actualRate(sat(ctl.r || 0), RT.yaw) * D2R];
    const mode = ctl.mode || 'acro';
    if (mode === 'acro') return acro;
    const eu = eulerFromMat(R), cap = A.rate * D2R;
    const level = [
      clamp(A.k * (a * lim.bank * D2R - eu.roll), -cap, cap),
      clamp(A.k * (e * lim.pitch * D2R - eu.pitch), -cap, cap),
      acro[2],
    ];
    if (mode === 'angle') return level;
    if (mode === 'horizon') {
      const mag = Math.max(Math.abs(a), Math.abs(e));
      const tilt = Math.acos(clamp(R[8], -1, 1)); // 0 upright … π inverted
      const k = clamp(1 - mag / 0.75, 0, 1) * clamp(1 - (tilt - 75 * D2R) / (30 * D2R), 0, 1);
      return [lerp(acro[0], level[0], k), lerp(acro[1], level[1], k), acro[2]];
    }
    const sp = acro.slice();
    const guard = (k, ang, rate, limDeg) => {
      const L = limDeg * D2R;
      if (Math.abs(ang + rate * 0.08) > L && Math.sign(sp[k]) !== -Math.sign(ang)) sp[k] = clamp(A.k * (Math.sign(ang) * L - ang), -cap, cap);
    };
    guard(0, eu.roll, w[0], lim.tBank);
    guard(1, eu.pitch, w[1], lim.tPitch);
    return sp;
  }

  /* Betaflight "Actual" rates: deg/s for stick x in -1..1.
     c = centre sensitivity, m = max rate, e = expo (0..1). */
  function actualRate(x, r) { return x * r.c + (r.m - r.c) * Math.abs(x) * (Math.pow(x, 5) * r.e + x * (1 - r.e)); }

  /* ---------------- Multirotor ----------------
     ctl: { thr 0..1, a, e, r -1..1, mode 'acro' | 'angle', armed bool } */
  function stepQuad(s, ac, ctl, env, dt) {
    const M = ac.motor, B = ac.batt, I = ac.I, rho = env.rho, w = s.w;
    const armed = !!ctl.armed && !s.crashed && !(env.battery && s.soc <= 0);

    // battery: electrical power ~ ρ·rpm³; props pick up ice in freezing cloud, fog or drizzle
    const m3 = (s.mot[0] ** 3 + s.mot[1] ** 3 + s.mot[2] ** 3 + s.mot[3] ** 3) / 4;
    const vbody = Math.hypot(s.v[0], s.v[1], s.v[2]), mAvg = (s.mot[0] + s.mot[1] + s.mot[2] + s.mot[3]) / 4;
    const pice = iceSmall(s, env, vbody, 3.5 * M.Vp * mAvg + vbody, 0.09 * M.D, dt);
    // at a given command the motors draw more from a full pack than a sagging one (prop load ∝ V²)
    const vprev = clamp((s.vb || B.Vref) / B.Vref, 0, 1.2);
    battery(s, B, B.Iidle + B.Imax * m3 * (rho / RHO0) * pice.power * vprev * vprev, vbody, env, dt);
    const vsc = clamp(s.vb / B.Vref, 0, 1.2);
    const Tmax = M.Tmax * vsc * vsc * (rho / RHO0) * pice.thrust; // thrust falls with voltage sag, thin air and prop ice

    const R = quatToMat(s.q);
    const wind = env.wind || [0, 0, 0];
    const vb = mulMtV(R, [s.v[0] - wind[0], s.v[1] - wind[1], s.v[2] - wind[2]]);

    // ---- flight controller: setpoints ----
    const sp = rotarySetpoints(ctl, R, s.w, ac);
    // ---- rate PID with feed-forward → wanted angular acceleration → wanted moments ----
    const resetI = !armed || (s.wow && ctl.thr < 0.05);
    const alpha = [0, 0, 0];
    const gains = [ac.pid.roll, ac.pid.pitch, ac.pid.yaw];
    for (let k = 0; k < 3; k++) {
      const g = gains[k], e = sp[k] - w[k];
      // I-term relax: don't integrate while the setpoint is moving fast (stick flicks)
      const relax = clamp(1 - Math.abs(s.ff[k]) / 40, 0, 1);
      s.pidI[k] = resetI ? 0 : clamp(s.pidI[k] + e * dt * relax, -g[3], g[3]);
      const dsp = (sp[k] - s.spPrev[k]) / dt;
      s.spPrev[k] = sp[k];
      s.ff[k] += (dsp - s.ff[k]) * Math.min(1, dt / 0.02); // smoothed setpoint derivative
      const dw = (w[k] - s.wPrev[k]) / dt;
      s.wPrev[k] = w[k];
      s.dF[k] += (dw - s.dF[k]) * Math.min(1, dt / 0.006); // D-term on gyro, low-passed
      alpha[k] = g[0] * e + g[1] * s.pidI[k] + g[2] * s.ff[k] - (g[4] || 0) * s.dF[k];
    }
    const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]], gyro = cross(w, Iw);
    const Mx = I[0] * alpha[0] + gyro[0], My = I[1] * alpha[1] + gyro[1], Mz = I[2] * alpha[2] + gyro[2];

    // ---- mixer (thrust space) with airmode: keep attitude authority, shift the collective ----
    const base = M.idle + clamp(ctl.thr, 0, 1) * (1 - M.idle);
    const Tc = 4 * Tmax * base * base;
    const a = ac.motors[0][0];
    const want = ac.motors.map(([x, y, q]) => (-Mx / a) * Math.sign(y) / 4 + (My / a) * Math.sign(x) / 4 + (Mz / M.kQ) * q / 4);
    const lo = Tmax * M.idle * M.idle, hi = Tmax;
    let spread = Math.max(...want) - Math.min(...want);
    if (spread > hi - lo) { const k = (hi - lo) / spread; for (let i = 0; i < 4; i++) want[i] *= k; }
    let Ti = want.map((d) => Tc / 4 + d);
    const over = Math.max(...Ti) - hi, under = lo - Math.min(...Ti);
    if (over > 0) Ti = Ti.map((t) => t - over); else if (under > 0) Ti = Ti.map((t) => t + under);

    // ---- motors (first-order spool) ----
    for (let i = 0; i < 4; i++) {
      const cmd = armed ? Math.sqrt(clamp(Ti[i] / Tmax, 0, 1)) : 0;
      s.mot[i] += (cmd - s.mot[i]) * Math.min(1, dt / M.tau);
    }

    // ---- forces and moments ----
    const F = [0, 0, 0], Mo = [0, 0, 0];
    const vip = Math.hypot(vb[0], vb[1]);
    // descending into your own prop wash with little forward speed: thrust loss and shake
    const wash = clamp((vb[2] - 2.5) / 3, 0, 1) * clamp(1 - vip / 5, 0, 1);
    s.buf[0] += (Math.random() * 2 - 1 - s.buf[0]) * Math.min(1, dt / 0.05);
    s.buf[1] += (Math.random() * 2 - 1 - s.buf[1]) * Math.min(1, dt / 0.05);
    const h = Math.max(0.03, -s.p[2]), rr = M.D / 2;
    const ge = 1 / (1 - Math.min(0.25, Math.pow(rr / (4 * h), 2))); // ground effect (Cheeseman–Bennett)
    let Ttot = 0;
    for (let i = 0; i < 4; i++) {
      const [x, y, q] = ac.motors[i], om = s.mot[i];
      // air moving up through this rotor (body z is down): aircraft velocity plus rotation at the motor
      const vup = -(vb[2] + (w[0] * y - w[1] * x));
      const inflow = om > 0.02 ? clamp(1 - vup / Math.max(M.Vp * om, 1), 0.25, 1.35) : 1;
      const T = Tmax * om * om * inflow * ge * (1 - 0.3 * wash);
      Ttot += T;
      F[2] -= T;
      Mo[0] += -y * T; Mo[1] += x * T; Mo[2] += q * M.kQ * T;
    }
    const shake = (wash * 0.14 + s.shed * 0.12) * ((M.Tmax * Math.abs(ac.motors[0][0])) / (13.5 * 0.078)); // prop wash, or ice thrown unevenly off a prop; scales with the quad's size
    Mo[0] += shake * s.buf[0]; Mo[1] += shake * s.buf[1];
    F[0] -= ac.rotorDrag * Ttot * vb[0]; F[1] -= ac.rotorDrag * Ttot * vb[1];
    // a lifting body, if it has one: the same strip model the planes fly
    let sf = null;
    if (ac.strips.length) {
      const gw = env.gw || [0, 0, 0];
      sf = stripForces(s, ac, vb, [w[0] - gw[0], w[1] - gw[1], w[2] - gw[2]], R, rho, env, 0, dt, F, Mo);
    }
    const Vn = Math.hypot(vb[0], vb[1], vb[2]), kd = 0.5 * rho * Vn, Cd = ac.body.CdA;
    F[0] -= kd * Cd[0] * vb[0]; F[1] -= kd * Cd[1] * vb[1]; F[2] -= kd * Cd[2] * vb[2];

    const Fcb = finish(s, ac, F, Mo, R, env, dt);
    s.n = (s.mot[0] + s.mot[1] + s.mot[2] + s.mot[3]) / 4;
    const t = s.tele;
    t.V = Vn; t.qbar = 0.5 * rho * Vn * Vn; t.T = Ttot;
    t.alpha = sf ? sf.alpha : 0; t.beta = Vn > 0.3 ? Math.asin(clamp(vb[1] / Vn, -1, 1)) : 0;
    t.CL = sf ? s.clw : 0; t.stallL = sf ? sf.stallL : 0; t.stallR = sf ? sf.stallR : 0;
    t.nz = -(F[2] + Fcb[2]) / (ac.mass * G);
    t.tw = (4 * Tmax) / (ac.mass * G); t.sp = sp; t.wash = wash;
  }


  /* ---------------- Tail-sitter VTOL ----------------
     Four motors thrusting along the nose (+x), lifting surfaces in the cruise
     frame, and one number for which way up it is flying: s.fwd, 0 standing on
     its tail and 1 flying horizontally. The pack, the rate PID and the mixer
     are the multirotor model; the lift, the stall and the drag are the strip
     model. They meet in the control frame below.

     The trick that makes a tail-sitter tractable is that there is no "hover
     controller" and no "forward controller" — there is one attitude the
     aircraft should be holding, which starts out vertical and ends up level,
     and the ordinary multirotor controller flies level *in that frame*. The
     transition is then nothing but that frame rotating, and because the frame
     is near level in both regimes the Euler angles it works in never go near
     the 90° singularity a tail-sitter otherwise lives on.

     ctl adds: { fwd: 0 hover … 1 forward } */
  function stepVtol(s, ac, ctl, env, dt) {
    const M = ac.motor, B = ac.batt, I = ac.I, rho = env.rho, w = s.w;
    const armed = !!ctl.armed && !s.crashed && !(env.battery && s.soc <= 0);
    s.fwd = approach(s.fwd, clamp(ctl.fwd === undefined ? 0 : +ctl.fwd, 0, 1), dt / ac.trans.time);

    // --- battery and motors, as on a multirotor ---
    let m3 = 0, mAvg = 0;
    for (let i = 0; i < ac.motors.length; i++) { m3 += s.mot[i] ** 3; mAvg += s.mot[i]; }
    m3 /= ac.motors.length; mAvg /= ac.motors.length;
    const vbody = Math.hypot(s.v[0], s.v[1], s.v[2]);
    const pice = iceSmall(s, env, vbody, 3.5 * M.Vp * mAvg + vbody, 0.09 * M.D, dt);
    const vprev = clamp((s.vb || B.Vref) / B.Vref, 0, 1.2);
    battery(s, B, B.Iidle + B.Imax * m3 * (rho / RHO0) * pice.power * vprev * vprev, vbody, env, dt);
    const vsc = clamp(s.vb / B.Vref, 0, 1.2);
    const Tmax = M.Tmax * vsc * vsc * (rho / RHO0) * pice.thrust;

    const R = quatToMat(s.q);
    const wind = env.wind || [0, 0, 0];
    const vb = mulMtV(R, [s.v[0] - wind[0], s.v[1] - wind[1], s.v[2] - wind[2]]);
    const V = Math.hypot(vb[0], vb[1], vb[2]);

    // --- control frame: Rf = R·Ry(−tilt), level when the aircraft sits at the
    //     attitude the transition currently asks for ---
    // the cruise trim attitude only belongs at the forward-flight end of it:
    // held in the hover it is a permanent 2° lean, and the aircraft slides away
    const tilt = (1 - s.fwd) * (Math.PI / 2) + s.fwd * ac.trans.pitch;
    const ct = Math.cos(tilt), stl = Math.sin(tilt);
    const Rf = [
      R[0] * ct + R[2] * stl, R[1], -R[0] * stl + R[2] * ct,
      R[3] * ct + R[5] * stl, R[4], -R[3] * stl + R[5] * ct,
      R[6] * ct + R[8] * stl, R[7], -R[6] * stl + R[8] * ct,
    ];
    const wf = [ct * w[0] + stl * w[2], w[1], -stl * w[0] + ct * w[2]];
    const spF = rotarySetpoints(ctl, Rf, wf, ac);
    const sp = [ct * spF[0] - stl * spF[2], spF[1], stl * spF[0] + ct * spF[2]];

    // --- rate PID with feed-forward, exactly as the multirotor ---
    const resetI = !armed || (s.wow && ctl.thr < 0.05);
    const alpha = [0, 0, 0];
    const gains = [ac.pid.roll, ac.pid.pitch, ac.pid.yaw];
    for (let k = 0; k < 3; k++) {
      const g = gains[k], e = sp[k] - w[k];
      const relax = clamp(1 - Math.abs(s.ff[k]) / 40, 0, 1);
      s.pidI[k] = resetI ? 0 : clamp(s.pidI[k] + e * dt * relax, -g[3], g[3]);
      const dsp = (sp[k] - s.spPrev[k]) / dt;
      s.spPrev[k] = sp[k];
      s.ff[k] += (dsp - s.ff[k]) * Math.min(1, dt / 0.02);
      const dw = (w[k] - s.wPrev[k]) / dt;
      s.wPrev[k] = w[k];
      s.dF[k] += (dw - s.dF[k]) * Math.min(1, dt / 0.006);
      alpha[k] = g[0] * e + g[1] * s.pidI[k] + g[2] * s.ff[k] - (g[4] || 0) * s.dF[k];
    }
    const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]], gyro = cross(w, Iw);
    const Mx = I[0] * alpha[0] + gyro[0], My = I[1] * alpha[1] + gyro[1], Mz = I[2] * alpha[2] + gyro[2];

    /* --- who flies which axis ---
       Thrust is along the nose, so motors above and below the centreline pitch
       it, motors left and right yaw it by running at different speeds, and
       roll about the nose is the propellers' own reaction torque. A two-motor
       tail-sitter has no motors above or below the centreline at all: it yaws
       on differential thrust and flies pitch and roll on elevons sitting in
       the propwash. That is what `surf` is for — the angular acceleration
       (rad/s²) at which an axis asks for full control-surface deflection. An
       axis `surf` names belongs to the surfaces, and the mixer leaves it alone
       rather than fighting them for it. */
    const nM = ac.motors.length;
    const SU = ac.surf || { roll: 0, pitch: 0, yaw: 0 };
    if (ac.defl) {
      const put = (cur, demand, full, lim) => approach(cur, full > 0 ? clamp(demand / full, -1, 1) * lim : 0, ac.servoRate * dt);
      s.sa = put(s.sa, alpha[0], SU.roll, ac.defl.a);
      s.se = put(s.se, alpha[1], SU.pitch, ac.defl.e);
      s.sr = put(s.sr, alpha[2], SU.yaw, ac.defl.r);
      s.sf = approach(s.sf, clamp(ctl.f || 0, 0, 1) * (ac.defl.f || 0), ((ac.defl.f || 0) / 2) * dt);
    }
    const ay = Math.abs(ac.motors[0][1]), az = Math.abs(ac.motors[0][2]);
    const mRoll = SU.roll > 0 ? 0 : Mx / M.kQ;              // the propellers' reaction torque
    const mPitch = SU.pitch > 0 || az < 1e-4 ? 0 : My / az; // motors above and below the centreline
    const mYaw = SU.yaw > 0 || ay < 1e-4 ? 0 : Mz / ay;     // motors left and right of it
    const base = M.idle + clamp(ctl.thr, 0, 1) * (1 - M.idle);
    const Tc = nM * Tmax * base * base;
    const want = ac.motors.map(([x, y, z, q]) => (mPitch * Math.sign(z) - mYaw * Math.sign(y) + mRoll * q) / nM);
    const lo = Tmax * M.idle * M.idle, hi = Tmax;
    const spread = Math.max(...want) - Math.min(...want);
    if (spread > hi - lo) { const k = (hi - lo) / spread; for (let i = 0; i < nM; i++) want[i] *= k; }
    let Ti = want.map((d) => Tc / nM + d);
    const over = Math.max(...Ti) - hi, under = lo - Math.min(...Ti);
    if (over > 0) Ti = Ti.map((t) => t - over); else if (under > 0) Ti = Ti.map((t) => t + under);
    for (let i = 0; i < nM; i++) {
      const cmd = armed ? Math.sqrt(clamp(Ti[i] / Tmax, 0, 1)) : 0;
      s.mot[i] += (cmd - s.mot[i]) * Math.min(1, dt / M.tau);
    }

    // --- thrust ---
    const F = [0, 0, 0], Mo = [0, 0, 0];
    // ground effect only counts when the thrust is pointing at the ground
    const h = Math.max(0.03, -s.p[2]), rr = M.D / 2;
    const up = clamp(-R[6], 0, 1); // how vertical the thrust axis is
    const ge = 1 + up * (1 / (1 - Math.min(0.25, Math.pow(rr / (4 * h), 2))) - 1);
    // sinking back into its own wake, hovering: the nose-up equivalent of a quad's prop wash
    const vperp = Math.hypot(vb[1], vb[2]);
    const wash = clamp((-vb[0] - 2.5) / 3, 0, 1) * clamp(1 - vperp / 5, 0, 1);
    s.buf[0] += (Math.random() * 2 - 1 - s.buf[0]) * Math.min(1, dt / 0.05);
    s.buf[1] += (Math.random() * 2 - 1 - s.buf[1]) * Math.min(1, dt / 0.05);
    let Ttot = 0;
    for (let i = 0; i < nM; i++) {
      const mo = ac.motors[i], om = s.mot[i];
      // air going into the disc: forward speed plus what the rotation adds at this motor
      const vax = vb[0] + (w[1] * mo[2] - w[2] * mo[1]);
      /* Thrust falls away as the aircraft catches up with its own propellers
         and reaches zero at the pitch speed — no floor under it, unlike the
         multirotor model, because a tail-sitter spends its whole run up there
         and the top speed is exactly this. */
      const inflow = om > 0.02 ? clamp(1 - vax / Math.max(M.Vp * om, 1), 0, 1.35) : 1;
      const T = Tmax * om * om * inflow * ge * (1 - 0.3 * wash);
      Ttot += T;
      F[0] += T;
      Mo[0] += mo[3] * M.kQ * T;
      Mo[1] += mo[2] * T;
      Mo[2] += -mo[1] * T;
    }
    const shake = (wash * 0.14 + s.shed * 0.12) * ((M.Tmax * Math.max(ay, az, 0.02)) / (13.5 * 0.078));
    Mo[1] += shake * s.buf[0]; Mo[2] += shake * s.buf[1];
    // rotor drag acts in the disc plane, which here is across the aircraft
    F[1] -= ac.rotorDrag * Ttot * vb[1]; F[2] -= ac.rotorDrag * Ttot * vb[2];
    if (s.shed > 0) for (let k = 0; k < 3; k++) Mo[k] += (Math.random() * 2 - 1) * s.shed * 0.04 * ac.mass * ac.b;

    /* --- lifting surfaces and body drag ---
       Strips behind a propeller see its slipstream, which is the only reason a
       twin tail-sitter can hold its nose up at zero airspeed: its elevons are
       flying in 15 m/s of their own making. */
    let dWash = 0;
    if (Ttot > 0) {
      const A = (Math.PI * M.D * M.D) / 4, Vx = Math.max(0, vb[0]);
      // `=== undefined`, not `||`: a file that says the wash is zero means zero
      dWash = (ac.washEta === undefined ? 0.5 : ac.washEta) * (Math.sqrt(Vx * Vx + (2 * (Ttot / nM)) / (rho * A)) - Vx);
    }
    const gw = env.gw || [0, 0, 0], wa = [w[0] - gw[0], w[1] - gw[1], w[2] - gw[2]];
    const sf = stripForces(s, ac, vb, wa, R, rho, env, dWash, dt, F, Mo);
    if (V > 0.1) {
      const Bd = ac.body, kq = 0.5 * rho * V;
      const fb = [-kq * Bd.CdA[0] * vb[0], -kq * Bd.CdA[1] * vb[1], -kq * Bd.CdA[2] * vb[2]];
      F[0] += fb[0]; F[1] += fb[1]; F[2] += fb[2];
      const mb = cross(Bd.r, fb);
      Mo[0] += mb[0]; Mo[1] += mb[1]; Mo[2] += mb[2];
    }

    const Fcb = finish(s, ac, F, Mo, R, env, dt);
    s.n = mAvg;
    const t = s.tele;
    t.V = V; t.qbar = 0.5 * rho * V * V; t.T = Ttot; t.CL = s.clw;
    t.alpha = sf.alpha; t.beta = V > 0.3 ? Math.asin(clamp(vb[1] / V, -1, 1)) : 0;
    t.nz = -(F[2] + Fcb[2]) / (ac.mass * G);
    t.stallL = sf.stallL; t.stallR = sf.stallR;
    t.wash = wash;
  }

  /* ---------------- Helicopter (flybarless, governed) ----------------
     ctl: { thr = collective stick 0..1, a, e, r, mode, lim, armed (motor allowed), hold (throttle hold), curve 'normal' | '3d' } */
  function stepHeli(s, ac, ctl, env, dt) {
    const Ro = ac.rotor, B = ac.batt, I = ac.I, rho = env.rho, w = s.w;
    const motorOn = !!ctl.armed && !ctl.hold && !s.crashed && !(env.battery && s.soc <= 0);

    // collective from the pitch curve (servo-rate limited)
    const c = Ro.curves[ctl.curve] || Ro.curves.normal, x = clamp(ctl.thr, 0, 1);
    const thDeg = x < 0.5 ? lerp(c[0], c[1], x / 0.5) : lerp(c[1], c[2], (x - 0.5) / 0.5);
    s.coll = approach(s.coll, thDeg * D2R, 4 * dt);

    const R = quatToMat(s.q);
    const wind = env.wind || [0, 0, 0];
    const vb = mulMtV(R, [s.v[0] - wind[0], s.v[1] - wind[1], s.v[2] - wind[2]]);
    const OmR = Math.max(1e-3, s.om * Ro.R), A = Ro.A;
    const vc = -vb[2], Vh = Math.hypot(vb[0], vb[1]); // climb along the shaft, speed in the rotor plane
    const vhov = Math.sqrt((ac.mass * G) / (2 * rho * A));

    // ---- blade ice (inner blade, ~75% radius, warms least) ----
    const bIce = s.om > 5 || s.iceProp > 0 ? iceSmall(s, env, Math.hypot(s.v[0], s.v[1], s.v[2]), 0.75 * OmR, Ro.chord, dt) : null;
    const bx = s.iceProp / Ro.chord, bpen = icePenalty(bx, glazeOf(env.wx ? env.wx.T : 0));

    // ---- thrust: blade element (CT = σa/2·(θ/3 − λ/2)) with momentum inflow (Glauert), solved by bisection ----
    const kT = 0.5 * Ro.sigma * Ro.a * bpen.slope * rho * A * OmR * OmR, mu0 = Math.min(0.5, Vh / OmR);
    // solve vi = κT(vi) / (2ρA·|V'|) by bisection (plain fixed-point iteration oscillates in descent)
    const th = s.coll * (1 / 3 + (mu0 * mu0) / 2), Tof = (v) => kT * (th - (vc + v) / OmR / 2);
    let lo = -40, hi = 40;
    for (let it = 0; it < 22; it++) {
      const m = 0.5 * (lo + hi);
      const f = m - (Ro.kInd * Tof(m)) / (2 * rho * A * Math.max(0.4 * vhov, Math.hypot(Vh, vc + m)));
      if (f > 0) hi = m; else lo = m;
    }
    const vi = 0.5 * (lo + hi);
    let T = Tof(vi);
    s.vi = vi;
    // blade stall: mean blade lift coefficient 6·CT/σ can't pass about 1.0, so thrust needs headspeed
    const Tstall = ((Ro.CLmax * (1 - bpen.dCL)) / 6) * Ro.sigma * rho * A * OmR * OmR;
    const bladeStall = Math.max(0, Math.abs(T) / Tstall - 1);
    if (bladeStall > 0) T = Math.sign(T) * Tstall;
    // vortex ring state: sinking at about the induced speed with little forward speed
    const sink = -vc / vhov;
    const vrs = clamp(1 - Math.abs(sink - 1.2) / 0.8, 0, 1) * clamp(1 - Vh / (1.5 * vhov), 0, 1);
    const hR = Math.max(0.05, -s.p[2] + Ro.h);
    const ge = 1 / (1 - Math.min(0.3, Math.pow(Ro.R / (4 * hR), 2)));
    T *= ge * (1 - 0.35 * vrs);

    // ---- rotor speed: governor vs aerodynamic torque (autorotation when the air drives the rotor) ----
    const mu = Vh / OmR;
    const P0 = (rho * A * OmR ** 3 * Ro.sigma * (Ro.Cd0 + bpen.dCD) * (1 + 4.65 * mu * mu) * (1 + 6 * bladeStall)) / 8; // iced or stalled blades: more drag
    const Qaero = (T * (vc + vi) + P0 * 1.12) / Math.max(s.om, 5); // tail rotor ≈ 12% of the main rotor's profile power
    s.gov = approach(s.gov, motorOn ? 1 : 0, (s.om > 0.6 * Ro.om0 ? 1.5 : Ro.spool) * dt); // soft start, quick bailout
    const Qmax = Ro.Pmax / Math.max(s.om, 30);
    const Qm = motorOn ? clamp(Qaero + Ro.govK * (s.gov * Ro.om0 - s.om) * 50, 0, Qmax) : 0;
    s.om = Math.max(0, s.om + ((Qm - Qaero - Ro.friction * s.om) / Ro.J) * dt);
    const Pel = (Qm * s.om) / 0.8;
    battery(s, B, B.Iidle + Pel / Math.max(s.vb || B.Vref, 10), Math.hypot(s.v[0], s.v[1], s.v[2]), env, dt);

    // ---- flybarless controller: rate PID → wanted moments → disc tilt; heading hold → tail thrust ----
    const sp = rotarySetpoints(ctl, R, w, ac);
    const gains = [ac.pid.roll, ac.pid.pitch, ac.pid.yaw], alpha = [0, 0, 0];
    const live = s.om > 0.3 * Ro.om0 && !s.crashed;
    for (let k = 0; k < 3; k++) {
      const g = gains[k], e = sp[k] - w[k];
      const dsp = (sp[k] - s.spPrev[k]) / dt;
      s.spPrev[k] = sp[k];
      s.ff[k] += (dsp - s.ff[k]) * Math.min(1, dt / 0.02);
      const relax = clamp(1 - Math.abs(s.ff[k]) / 40, 0, 1);
      s.pidI[k] = live && !(s.wow && x < 0.4) ? clamp(s.pidI[k] + e * dt * relax, -g[3], g[3]) : 0;
      const dw = (w[k] - s.wPrev[k]) / dt;
      s.wPrev[k] = w[k];
      s.dF[k] += (dw - s.dF[k]) * Math.min(1, dt / 0.006);
      alpha[k] = g[0] * e + g[1] * s.pidI[k] + g[2] * s.ff[k] - (g[4] || 0) * s.dF[k];
    }
    const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]], gyro = cross(w, Iw);
    const omr = s.om / Ro.om0;
    const Kc = Ro.Kh * omr * omr + Math.max(0, T) * Ro.h; // moment per radian of disc tilt
    const tiltCmd = [
      live ? clamp((I[0] * alpha[0] + gyro[0]) / Math.max(Kc, 0.5), -Ro.maxCyc, Ro.maxCyc) : 0,
      live ? clamp((I[1] * alpha[1] + gyro[1]) / Math.max(Kc, 0.5), -Ro.maxCyc, Ro.maxCyc) : 0,
    ];
    for (let k = 0; k < 2; k++) s.tilt[k] += (tiltCmd[k] - s.tilt[k]) * Math.min(1, dt / Ro.tauF);
    // blowback: the disc flaps away from the relative wind
    const tp = s.tilt[0] - Ro.blowback * (vb[1] / OmR) * s.coll, tq = s.tilt[1] + Ro.blowback * (vb[0] / OmR) * s.coll;
    // tail: cancel the motor's reaction torque, then chase the yaw-rate setpoint
    const react = -Ro.spin * Qm; // motor torque pushes the body the other way
    const TtMax = Ro.TtMax * omr * omr;
    const TtCmd = s.om > 5 ? clamp((I[2] * alpha[2] + gyro[2] - react) / Ro.lt, -TtMax, TtMax) : 0;
    s.tt += (TtCmd - s.tt) * Math.min(1, dt / Ro.tauT); // tail servo and pitch slider lag
    const Tt = clamp(s.tt, -TtMax, TtMax);

    // ---- forces and moments ----
    const F = [-T * tq, T * tp, -T];
    const Mo = [Kc * tp, Kc * tq, Tt * Ro.lt + react];
    if (vrs > 0) { // VRS: buffeting
      s.buf[0] += (Math.random() * 2 - 1 - s.buf[0]) * Math.min(1, dt / 0.08);
      s.buf[1] += (Math.random() * 2 - 1 - s.buf[1]) * Math.min(1, dt / 0.08);
      Mo[0] += vrs * 0.5 * s.buf[0]; Mo[1] += vrs * 0.7 * s.buf[1]; F[2] += vrs * 1.5 * s.buf[0];
    }
    if (s.shed > 0) { // ice let go of one blade: out of balance
      const ph = s.t * s.om;
      Mo[0] += s.shed * 0.35 * Math.cos(ph); Mo[1] += s.shed * 0.35 * Math.sin(ph);
    }
    const Vn = Math.hypot(vb[0], vb[1], vb[2]), kd = 0.5 * rho * Vn, Cd = ac.body.CdA;
    F[0] -= kd * Cd[0] * vb[0]; F[1] -= kd * Cd[1] * vb[1]; F[2] -= kd * Cd[2] * vb[2];
    // tail fin and boom: weathervane in sideslip
    const Yf = -0.5 * rho * Vn * ac.body.fin * 3 * vb[1];
    F[1] += Yf; Mo[2] += ac.body.finX * Yf;
    Mo[0] -= 0.03 * w[0]; Mo[1] -= 0.05 * w[1]; // rotor damping

    const Fcb = finish(s, ac, F, Mo, R, env, dt);
    s.n = omr;
    const t = s.tele;
    t.V = Vn; t.qbar = 0.5 * rho * Vn * Vn; t.T = T; t.alpha = 0; t.beta = 0; t.CL = 0; t.stallL = 0; t.stallR = 0;
    t.nz = -(F[2] + Fcb[2]) / (ac.mass * G);
    t.coll = s.coll; t.vi = vi; t.vrs = vrs; t.Pm = Qm * s.om; t.bladeStall = bladeStall; t.bladeIce = bpen.dCL;
  }

  /* Assisted modes for planes. sticks: raw pilot sticks; manual: the surfaces the pilot would get in
     manual mode (rates, expo, trim applied); lim (degrees): { bank, pitch, tBank, tPitch }.
       stab    – like ArduPilot FBWA: sticks command bank and pitch, centred sticks level
       horizon – like iNav HORIZON: levels near centre stick, fading to manual at 75% stick
       trainer – like ArduPilot TRAINING: manual, but the aircraft is held at the bank/pitch limits */
  function planeAssist(mode, sticks, manual, s, ac, lim) {
    const g = ac.stab;
    const R = quatToMat(s.q), eu = eulerFromMat(R);
    lim = lim || { bank: 45, pitch: 30, tBank: 60, tPitch: 45 };
    const wrap = (x) => (x > Math.PI ? x - 2 * Math.PI : x < -Math.PI ? x + 2 * Math.PI : x);
    const level = () => {
      const a = sat(g.kRoll * wrap(sat(sticks.a) * lim.bank * D2R - eu.roll) - g.dRoll * s.w[0]);
      const turn = g.turn * (1 / Math.max(0.5, Math.cos(eu.roll)) - 1);
      const e = sat(g.kPitch * (sat(sticks.e) * lim.pitch * D2R - eu.pitch) - g.dPitch * s.w[1] + turn);
      return { a, e };
    };
    if (mode === 'stab') { const L = level(); return { thr: manual.thr, a: L.a, e: L.e, r: manual.r }; }
    if (mode === 'horizon') {
      const L = level(), mag = Math.max(Math.abs(sticks.a), Math.abs(sticks.e));
      const tilt = Math.acos(clamp(R[8], -1, 1));
      const k = clamp(1 - mag / 0.75, 0, 1) * clamp(1 - (tilt - 75 * D2R) / (30 * D2R), 0, 1);
      return { thr: manual.thr, a: lerp(manual.a, L.a, k), e: lerp(manual.e, L.e, k), r: manual.r };
    }
    if (mode === 'trainer') {
      const out = { thr: manual.thr, a: manual.a, e: manual.e, r: manual.r };
      const hold = (ang, rate, limDeg, cur, kp, kd) => {
        const L = limDeg * D2R;
        if (Math.abs(ang + rate * 0.15) <= L || Math.sign(cur) === -Math.sign(ang)) return cur; // inside, or pilot recovering
        return sat(kp * (Math.sign(ang) * L - ang) - kd * rate);
      };
      out.a = hold(eu.roll, s.w[0], lim.tBank, manual.a, g.kRoll, g.dRoll);
      // elevator: nose-up pitch rate in a bank isn't pitch-angle change, so use the pitch angle's own rate
      const pitchRate = s.w[1] * Math.cos(eu.roll) - s.w[2] * Math.sin(eu.roll);
      out.e = hold(eu.pitch, pitchRate, lim.tPitch, manual.e, g.kPitch, g.dPitch);
      return out;
    }
    return manual;
  }

  /* ---------------- Trim and performance (used by tests and the model notes) ----------------
     Accelerations for straight, wings-level flight at airspeed V, angle of attack alpha,
     elevator e and aileron a (stick units) and throttle thr, from one tiny step. */
  /* wing: optional { ice: per-strip ice (m), iceMass, iceGl, rain } to evaluate an iced or wet wing,
     plus { flap: 0..1, gear: 0 up / 1 down } to evaluate a flapped or gear-down configuration */
  function accelAt(ac, V, alpha, e, thr, a, rho, wing) {
    const env = { rho, wind: [0, 0, 0], battery: false, crashes: false, wx: wing && wing.rain ? { T: 10, lwc: 0, mvd: 0, rain: wing.rain } : null };
    const mk = () => {
      const s = makeState();
      if (wing && wing.ice) { s.ice = Float64Array.from(wing.ice); s.iceMass = wing.iceMass || 0; s.iceGl = wing.iceGl || 0; }
      s.p = [0, 0, -200]; s.q = quatFromEuler(0, alpha, 0); s.v = [V, 0, 0];
      s.n = thr; s.sa = sat(a) * ac.defl.a; s.se = sat(e) * ac.defl.e;
      s.sf = cf * (ac.defl.f || 0); s.gear = cg;
      return s;
    };
    const cf = clamp((wing && wing.flap) || 0, 0, 1), cg = wing && wing.gear !== undefined ? wing.gear : 1;
    const ctl = { thr, a, e, r: 0, f: cf, gear: cg };
    const dt = 1e-5;
    let s = mk();
    step(s, ac, ctl, env, dt); // first pass sets wing CL for tail downwash
    const clw = s.clw;
    s = mk(); s.clw = clw;
    step(s, ac, ctl, env, dt);
    return [(s.v[2]) / dt, (s.v[0] - V) / dt, s.w[1] / dt, s.w[0] / dt, clw, (s.tele.stallL + s.tele.stallR) / 2];
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
  function trim(ac, V, rho = RHO0, x0, wing) {
    let x = x0 ? [x0.alpha, x0.e, x0.thr, x0.a] : [0.05, 0, 0.5, 0];
    const H = [1e-4, 1e-3, 1e-3, 1e-3];
    for (let it = 0; it < 40; it++) {
      const f = accelAt(ac, V, x[0], x[1], x[2], x[3], rho, wing).slice(0, 4);
      if (Math.abs(f[0]) + Math.abs(f[1]) < 1e-4 && Math.abs(f[2]) + Math.abs(f[3]) < 1e-3) break;
      const J = [[], [], [], []];
      for (let j = 0; j < 4; j++) {
        const xp = x.slice(); xp[j] += H[j];
        const fp = accelAt(ac, V, xp[0], xp[1], xp[2], xp[3], rho, wing);
        for (let i = 0; i < 4; i++) J[i][j] = (fp[i] - f[i]) / H[j];
      }
      const dx = solve4(J, f.map((v) => -v));
      if (!dx) break;
      for (let j = 0; j < 4; j++) x[j] += clamp(dx[j], -0.2, 0.2);
      x[2] = clamp(x[2], 0, 1.5);
    }
    const f = accelAt(ac, V, x[0], x[1], x[2], x[3], rho, wing);
    const ok = x[2] <= 1.0001 && Math.abs(f[0]) < 0.05 && Math.abs(f[1]) < 0.05 && Math.abs(x[1]) <= 1.0001;
    return { V, alpha: x[0], e: x[1], thr: x[2], a: x[3], CL: f[4], ok };
  }
  // whole-aircraft maximum lift coefficient (elevator neutral), and the 1-g stall speed
  function stallSpeed(ac, rho = RHO0, wing) {
    let best = 0, bestA = 0;
    const m = ac.mass + ((wing && wing.iceMass) || 0);
    // a third of the wing has let go: that's the stall, not the post-stall plateau beyond it.
    // With flaps down the flapped span is meant to let go first, so allow for its area.
    const sLim = 0.3 + 0.7 * (ac.flapArea || 0) * clamp((wing && wing.flap) || 0, 0, 1);
    for (let a = 0; a <= 0.45; a += 0.005) {
      const f = accelAt(ac, 15, a, 0, 0, 0, rho, wing);
      const Lz = m * (G - f[0]); // vertical force supporting the aircraft
      const CL = Lz / (0.5 * rho * 225 * ac.S);
      if (f[5] > sLim) break;
      if (CL > best) { best = CL; bestA = a; }
    }
    return { CLmax: best, alpha: bestA, Vs: Math.sqrt((2 * m * G) / (rho * ac.S * best)) };
  }
  function performance(ac, rho = RHO0, wing) {
    const st = stallSpeed(ac, rho, wing);
    const rows = [];
    let prev = null;
    for (let V = Math.ceil(st.Vs * 1.1); V <= 70; V += 1) {
      const t = trim(ac, V, rho, prev, wing);
      if (!t.ok) { if (rows.length) break; else continue; }
      rows.push(t); prev = t;
    }
    let handsOff = null;
    for (let i = 1; i < rows.length; i++) if (rows[i - 1].e * rows[i].e <= 0) { const k = rows[i - 1].e / (rows[i - 1].e - rows[i].e); handsOff = lerp(rows[i - 1].V, rows[i].V, k); }
    return { stall: st, rows, Vmax: rows.length ? rows[rows.length - 1].V : null, handsOff };
  }

  return { G, D2R, RHO0, DEFS, quadDef, cellOCV, build, actualRate, planeAssist, rotarySetpoints, makeState, reset, launch, step, atmosphere, PRECIP, weatherAt, iceRate, icePenalty, propIce, battR, capF, quatToMat, mulMV, mulMtV, eulerFromMat, quatFromEuler, clamp, sat, flapTheory, trim, stallSpeed, performance };
})();
if (typeof module !== 'undefined') module.exports = FL;
