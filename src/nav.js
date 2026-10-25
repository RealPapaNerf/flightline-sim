/* =====================================================================
   Flightline navigation layer — pure JavaScript (no DOM).

   What the aircraft *knows*, as opposed to what it *is*:
     sensors   GPS (rate, latency, wandering error), barometer (bias, noise, airspeed error),
               downward lidar (range limit, surface reflectivity, tilt, rain/snow/fog)
     estimate  height from lidar when it's trustworthy, else baro; position and velocity from GPS
     link      RC and video link budgets: free-space loss, ground bounce, antenna null overhead,
               obstructions and interference → RSSI, link quality, failsafe, video quality
     autopilot ArduPilot-flavoured ALT HOLD, LOITER and RTL for multirotors, helis and planes,
               flying on the estimates (so sensor errors show up as real wander and drift)
   Frames as in physics.js: NED world (home at the origin), FRD body.
   ===================================================================== */
const NAV = (function () {
  'use strict';
  const F = typeof FL !== 'undefined' ? FL : require('./physics.js');
  const { G, D2R, clamp, quatToMat, eulerFromMat } = F;
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const gm = (x, tau, sig, dt) => x + (-x / tau) * dt + sig * Math.sqrt((2 * dt) / tau) * gauss(); // Gauss–Markov drift
  const log10 = Math.log10;
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  /* ---------------- sensor and radio catalogue (datasheet-level numbers, rounded) ---------------- */
  // downward lidars: max range on a 90%-reflective target; range scales with √reflectivity
  const LIDARS = {
    none: { name: 'None', max: 0 },
    luna: { name: 'TF-Luna (8 m)', max: 8, sigma: 0.02 },
    tfmini: { name: 'TFmini Plus (12 m)', max: 12, sigma: 0.02 },
    tf02: { name: 'TF02-Pro (40 m)', max: 40, sigma: 0.03 },
    sf11: { name: 'LightWare SF11/C (120 m)', max: 120, sigma: 0.05 },
  };
  // RC links: frequency (MHz), transmit power (dBm), receiver sensitivity at that packet rate (dBm), packet rate (Hz)
  const RCLINKS = {
    elrs24: { name: 'ELRS 2.4 GHz · 250 mW · 250 Hz', f: 2440, p: 24, sens: -108, rate: 250 },
    elrs900: { name: 'ELRS 900 MHz · 250 mW · 200 Hz', f: 915, p: 24, sens: -112, rate: 200 },
  };
  // analog video: frequency, power; picture is clean ~10 dB above the noise floor, snow below, gone at it
  const VTXS = {
    a25: { name: 'Analog 5.8 GHz · 25 mW', f: 5800, p: 14 },
    a200: { name: 'Analog 5.8 GHz · 200 mW', f: 5800, p: 23 },
    a600: { name: 'Analog 5.8 GHz · 600 mW', f: 5800, p: 27.8 },
  };
  const VIDEO_FLOOR = -93, VIDEO_CLEAN = 10, LINK_MARGIN = 8; // dBm; dB lost to the airframe, polarisation and multipath in real life

  /* Received power (dBm) over distance d (m) with the aircraft hAir (m) above the ground and seen at
     elevation angle elev from the pilot.
       free space   FSPL = 20·log10(d_km) + 20·log10(f_MHz) + 32.44
       ground bounce past the two-ray breakpoint d_b = 4·h_pilot·h_air/λ: +10·log10(d/d_b) (half the flat-earth
                    two-ray penalty of 20·log10, since real ground is rough and antennas aren't at exactly 1.5 m)
       antenna null dipoles on both ends lose up to 10 dB with the aircraft straight overhead */
  function received(link, d, hAir, elev, extra) {
    const dd = Math.max(1, d), lam = 3e8 / (link.f * 1e6);
    let L = 20 * log10(dd / 1000) + 20 * log10(link.f) + 32.44;
    const db = (4 * 1.5 * Math.max(0.3, hAir)) / lam;
    if (dd > db) L += 10 * log10(dd / db);
    return link.p + 2 + 2 - L - 10 * Math.pow(Math.sin(Math.abs(elev)), 4) - LINK_MARGIN - extra;
  }

  function make() {
    return {
      t: 0,
      gps: { p: [0, 0, 0], v: [0, 0, 0], err: [0, 0, 0], sats: 16, hdop: 0.8, next: 0, hist: [] },
      baro: { alt: 0, bias: 0 },
      rng: { d: 0, valid: false, m: 0, ok: 0, raw: 0 },
      est: { alt: 0, vz: 0, src: 'baro', p: [0, 0, 0], v: [0, 0, 0], ver: 0 },
      link: { rcRssi: -60, rcLq: 100, rcFs: false, lastPkt: 0, fadeRc: 0, fadeVid: 0, vidRssi: -60, vidQ: 1, obsRc: 0, obsVid: 0, fresh: true },
      ap: { mode: null, phase: '', altT: 0, posT: null, vzI: 0, vI: [0, 0], spdI: 0, pI: 0, center: null, landed: false, hold: false },
    };
  }
  function reset(nav, s) {
    const n = make();
    n.baro.alt = n.est.alt = -s.p[2];
    n.gps.p = s.p.slice(); n.est.p = s.p.slice();
    Object.assign(nav, n);
  }

  /* ---------------- sensors and the estimate ----------------
     opt: { lidar: LIDARS key, surface(n, e) → { h: top height above the datum (m), refl: 0–1 },
            beta: optical extinction (1/m), precipR: mm/h, snowing: bool, V: airspeed (m/s) }
     `surface` may return a height below the datum: over a map the ground is
     wherever the map says, not at zero. */
  function sensors(nav, s, opt, dt) {
    nav.t += dt;
    const R = quatToMat(s.q), h = -s.p[2], t = nav.t;
    // GPS: 10 Hz, 150 ms late, error wanders with HDOP (horizontal σ ≈ 1 m × HDOP, vertical ×2)
    const g = nav.gps;
    for (let i = 0; i < 3; i++) g.err[i] = gm(g.err[i], 45, (i < 2 ? 1.0 : 2.0) * g.hdop, dt);
    g.hist.push([t, s.p.slice(), s.v.slice()]);
    while (g.hist.length > 2 && g.hist[1][0] <= t - 0.15) g.hist.shift();
    if (t >= g.next) {
      g.next = t + 0.1;
      const [, p, v] = g.hist[0];
      g.p = [p[0] + g.err[0], p[1] + g.err[1], p[2] + g.err[2]];
      g.v = [v[0] + 0.05 * gauss(), v[1] + 0.05 * gauss(), v[2] + 0.08 * gauss()];
    }
    // baro: slow bias, noise, and the static-port error at speed (reads low as you go faster)
    nav.baro.bias = gm(nav.baro.bias, 300, 0.4, dt);
    nav.baro.alt = h + nav.baro.bias + 0.12 * gauss() - 0.0025 * (opt.V || 0) ** 2;
    // lidar: ray along the body's down axis to the ground, or whatever stands on it
    const L = LIDARS[opt.lidar] || LIDARS.none, rg = nav.rng;
    rg.valid = false; rg.m = 0;
    /* The beam leaves along the body's down axis, so where it lands depends on
       how high the ground is there, and how high the ground is there depends on
       where it lands. Over the flat field one correction settled it. Over
       terrain it has to iterate: start from the ground straight below, step to
       where that says the beam lands, and repeat. Three passes converge to
       under a centimetre for anything shallower than the beam's own angle; a
       wall steeper than that is a case this does not claim to get right, and
       the reading simply comes out long. */
    const probe = (t2) => (opt.surface ? opt.surface(s.p[0] + R[2] * t2, s.p[1] + R[5] * t2) : { h: 0, refl: 0.4 });
    const srf0 = probe(0);
    if (L.max > 0 && R[8] > 0.25 && h - srf0.h > 0.05) {
      let tR = (h - srf0.h) / R[8], srf = probe(tR);
      for (let it = 0; it < 3; it++) {
        const d2 = (h - srf.h) / R[8];
        if (!(d2 > 0.01) || Math.abs(d2 - tR) < 0.01) break;
        tR = d2; srf = probe(tR);
      }
      // returned signal relative to a 90% target at max range: (ρ/0.9)·cosθ·(max/r)²·e^(−2βr)
      const m = (srf.refl / 0.9) * R[8] * (L.max / Math.max(tR, 0.1)) ** 2 * Math.exp(-2 * (opt.beta || 0) * tR);
      rg.m = m;
      const pValid = clamp((m - 0.7) / 0.6, 0, 1);
      if (Math.random() < pValid) {
        rg.valid = true;
        rg.raw = tR + (L.sigma + 0.004 * tR + 0.04 * tR * clamp(1.4 - m, 0, 1)) * gauss();
      }
      // drops and flakes close to the sensor give false short returns
      if (opt.precipR > 0 && Math.random() < Math.min(0.15, 0.012 * opt.precipR * (opt.snowing ? 3 : 1))) { rg.valid = true; rg.raw = 0.3 + Math.random() * 3; }
      if (rg.valid) rg.d = rg.raw;
    }
    // health: share of good samples over the last ~0.3 s, and the tilt it's measured at
    rg.ok += ((rg.valid ? 1 : 0) - rg.ok) * Math.min(1, dt / 0.3);
    const lidarOk = L.max > 0 && rg.ok > 0.75 && R[8] > 0.82 && rg.d < 0.95 * L.max;
    // estimate: height above what's below from the lidar when healthy, else baro height above home
    const e = nav.est, was = e.src;
    e.src = lidarOk ? 'lidar' : 'baro';
    const a = e.src === 'lidar' ? rg.d * R[8] : nav.baro.alt;
    if (was !== e.src) { e.ver++; e.alt = a; } else e.alt += (a - e.alt) * Math.min(1, dt / (e.src === 'lidar' ? 0.05 : 0.15));
    e.vz = -s.v[2] + 0.05 * gauss(); // IMU-aided vertical speed is good on any real autopilot
    e.p = g.p.slice(); e.v = g.v.slice();
    return e;
  }

  /* ---------------- link ----------------
     opt: { rc, vtx (catalogue keys), obsRc, obsVid (dB of obstruction), noise (dB rise of the noise floor),
            perfect (skip the link budget: full LQ, clean picture, no failsafe, however far away) } */
  function link(nav, s, opt, dt) {
    const k = nav.link, rc = RCLINKS[opt.rc] || RCLINKS.elrs24, vt = VTXS[opt.vtx] || VTXS.a600;
    /* Radio off: the aircraft is on the end of a wire. Nothing to do with how far
       or how low it is, so the fades and the obstruction losses go to zero too —
       a half-modelled link would still make the OSD twitch. */
    if (opt.perfect) {
      k.fadeRc = 0; k.fadeVid = 0; k.obsRc = 0; k.obsVid = 0;
      k.rcRssi = -40; k.vidRssi = -40; k.rcLq = 100; k.vidQ = 1;
      k.fresh = true; k.lastPkt = nav.t; k.rcFs = false;
      return k;
    }
    /* Your antenna is where YOU are, not at the map's origin. On the built-in
       field those are the same place; on a terrain map the document puts the
       pilot wherever it likes and the stand point can then move again (B, or
       the site picker), so the caller passes the antenna's NED position. The
       range loss, ground bounce and the overhead null all measure from it —
       the obstruction losses in opt already do. */
    const pilot = opt.pilot || [0, 0, -1.5], d = Math.hypot(s.p[0] - pilot[0], s.p[1] - pilot[1], s.p[2] - pilot[2]);
    const elev = Math.atan2(-(s.p[2] - pilot[2]), Math.hypot(s.p[0] - pilot[0], s.p[1] - pilot[1])), hAir = Math.max(0.3, -s.p[2]);
    k.fadeRc = gm(k.fadeRc, 0.25, 2.5, dt); k.fadeVid = gm(k.fadeVid, 0.25, 2.5, dt);
    k.obsRc = opt.obsRc || 0; k.obsVid = opt.obsVid || 0;
    k.rcRssi = received(rc, d, hAir, elev, k.obsRc) + k.fadeRc;
    k.vidRssi = received(vt, d, hAir, elev, k.obsVid) + k.fadeVid;
    // packets: each one gets through with a probability that falls off around the sensitivity
    const margin = k.rcRssi - (rc.sens + (opt.noise || 0));
    const pPkt = 1 / (1 + Math.exp(-(margin - 1) / 1.2));
    const n = Math.max(1, Math.round(rc.rate * dt));
    k.fresh = Math.random() < 1 - Math.pow(1 - pPkt, n);
    if (k.fresh) k.lastPkt = nav.t;
    k.rcLq += (100 * pPkt - k.rcLq) * Math.min(1, dt / 0.5);
    const lost = nav.t - k.lastPkt > 1.0; // ArduPilot-style: failsafe after a second with no packets
    k.rcFs = lost;
    k.vidQ = clamp((k.vidRssi - (VIDEO_FLOOR + (opt.noise || 0))) / VIDEO_CLEAN, 0, 1);
    return k;
  }

  /* ---------------- autopilot ----------------
     mode: 'althold' | 'loiter' | 'rtl'. Returns what the pilot's sticks would have done:
       rotary → { thr, a, e, r, mode: 'angle', lim }   (a/e are bank/pitch fractions of lim)
       plane  → { thr, bank, pitch, r } in radians, fed to the stabiliser
     sticks: the pilot's (thr 0–1, a/e/r ±1), or null when the RC link is lost.
     cfg: { rtlAlt (m), hover (stick), kind, curveK, Vcruise, Vmin, Vmax, loiterR } */
  function enter(nav, mode, s) {
    const ap = nav.ap;
    ap.mode = mode; ap.phase = mode === 'rtl' ? 'climb' : ''; ap.altT = nav.est.alt; ap.altVer = nav.est.ver;
    ap.posT = nav.est.p.slice(); ap.vzI = 0; ap.vI = [0, 0]; ap.spdI = 0; ap.pI = 0; ap.landed = false;
    ap.center = mode === 'loiter' ? nav.est.p.slice() : [0, 0, 0];
  }
  function exit(nav) { nav.ap.mode = null; nav.ap.phase = ''; }

  // shared height loop → wanted vertical acceleration (m/s²)
  function heightLoop(nav, vzCmd, dt, maxUp, maxDn) {
    const ap = nav.ap, e = nav.est;
    if (ap.altVer !== e.ver) { ap.altT = e.alt + (ap.altT - ap.altPrev); ap.altVer = e.ver; } // lidar ↔ baro handover: keep the same error
    ap.altPrev = e.alt;
    ap.altT += vzCmd * dt;
    const vzT = clamp(vzCmd + 1.2 * (ap.altT - e.alt), -maxDn, maxUp);
    ap.vzI = clamp(ap.vzI + (vzT - e.vz) * dt, -3, 3);
    return clamp(2.5 * (vzT - e.vz) + 0.8 * ap.vzI, -6, 8);
  }

  function rotary(nav, s, sticks, cfg, dt) {
    const ap = nav.ap, e = nav.est, R = quatToMat(s.q), eu = eulerFromMat(R);
    const st = sticks || { thr: 0.5, a: 0, e: 0, r: 0 };
    const lim = { bank: 35, pitch: 35, tBank: 60, tPitch: 60 };
    const dz = (x, d) => (Math.abs(x) < d ? 0 : (x - Math.sign(x) * d) / (1 - d));
    let vzCmd = 0, vH = null, yawRate = sticks ? st.r : 0;
    if (ap.mode === 'rtl') {
      const home = cfg.home || [0, 0], dx = home[0] - e.p[0], dy = home[1] - e.p[1], dist = Math.hypot(dx, dy);
      if (ap.phase === 'climb') { ap.altT = Math.max(ap.altT, cfg.rtlAlt); vzCmd = 0; if (e.alt > cfg.rtlAlt - 1 || e.alt > ap.altT - 1) ap.phase = 'return'; ap.posT = e.p.slice(); }
      if (ap.phase === 'return') {
        const sp = Math.min(8, 0.6 * dist + 0.5); vH = [(dx / (dist || 1)) * sp, (dy / (dist || 1)) * sp];
        const want = Math.atan2(dy, dx); if (dist > 4) yawRate = clamp(wrapPi(want - eu.yaw) * 1.2, -1, 1);
        if (dist < 2) { ap.phase = 'land'; ap.posT = [home[0], home[1], 0]; }
      }
      if (ap.phase === 'land') { vzCmd = e.alt > 6 ? -1.5 : -0.5; ap.altT = e.alt; if (s.wow && Math.abs(s.v[2]) < 0.3) ap.landed = true; }
    } else {
      vzCmd = st.thr > 0.5 ? 2.5 * dz((st.thr - 0.5) * 2, 0.15) : 1.5 * dz((st.thr - 0.5) * 2, 0.15);
      if (ap.mode === 'loiter') {
        const c = Math.cos(eu.yaw), sn = Math.sin(eu.yaw), fw = 6 * dz(-st.e, 0.05), rt = 6 * dz(st.a, 0.05); // stick forward (e < 0) flies forward
        // sticks fly velocity in the heading frame; let go and it holds where it stopped
        if (fw || rt) { vH = [fw * c - rt * sn, fw * sn + rt * c]; ap.posT = e.p.slice(); }
      }
    }
    const az = heightLoop(nav, vzCmd, dt, 2.5, ap.phase === 'land' ? 1.5 : 1.5);
    // thrust: tilt-compensated; heli collective ≈ linear in thrust, quad stick ≈ √thrust
    const tilt = Math.max(0.5, R[8]), Tf = (1 + az / G) / tilt;
    const thr = ap.landed ? 0 : cfg.kind === 'heli' ? cfg.hover + cfg.curveK * (Tf - 1) : clamp((cfg.base0 * Math.sqrt(Math.max(0, Tf)) - cfg.idle) / (1 - cfg.idle), 0, 1);
    // horizontal: hold a GPS position, or fly a velocity
    let roll = 0, pitch = 0;
    if (ap.mode === 'loiter' || ap.mode === 'rtl') {
      const pT = ap.posT || e.p;
      const vt = vH || [clamp(0.9 * (pT[0] - e.p[0]), -6, 6), clamp(0.9 * (pT[1] - e.p[1]), -6, 6)];
      const aN = 2.0 * (vt[0] - e.v[0]) + 0.4 * ap.vI[0], aE = 2.0 * (vt[1] - e.v[1]) + 0.4 * ap.vI[1];
      ap.vI[0] = clamp(ap.vI[0] + (vt[0] - e.v[0]) * dt, -4, 4); ap.vI[1] = clamp(ap.vI[1] + (vt[1] - e.v[1]) * dt, -4, 4);
      const c = Math.cos(eu.yaw), sn = Math.sin(eu.yaw), aF = aN * c + aE * sn, aR = -aN * sn + aE * c;
      pitch = -Math.atan2(clamp(aF, -6, 6), G); roll = Math.atan2(clamp(aR, -6, 6), G);
      return { thr: clamp(thr, 0, 1), a: roll / (lim.bank * D2R), e: pitch / (lim.pitch * D2R), r: clamp(yawRate, -1, 1), mode: 'angle', lim, armed: !ap.landed };
    }
    return { thr: clamp(thr, 0, 1), a: st.a, e: st.e, r: st.r, mode: 'angle', lim: { bank: 45, pitch: 45, tBank: 60, tPitch: 60 }, armed: true };
  }

  function plane(nav, s, sticks, cfg, dt) {
    const ap = nav.ap, e = nav.est, R = quatToMat(s.q), eu = eulerFromMat(R);
    const st = sticks || { thr: 0.5, a: 0, e: 0, r: 0 };
    const V = Math.max(3, s.tele.V || 0), gsp = Math.hypot(e.v[0], e.v[1]);
    let bank = 0, vzCmd = 0, Vt = cfg.Vcruise;
    const orbit = (c, Rr) => { // circle clockwise around c: steer onto the circle, then along it
      const dx = e.p[0] - c[0], dy = e.p[1] - c[1], r = Math.hypot(dx, dy) || 1;
      const tang = Math.atan2(dy, dx) + Math.PI / 2, crs = gsp > 2 ? Math.atan2(e.v[1], e.v[0]) : eu.yaw;
      const want = tang + clamp(((r - Rr) / Rr) * 1.2, -1.2, 1.2);
      return clamp(Math.atan2(V * V, G * Rr) + 1.6 * wrapPi(want - crs), -45 * D2R, 45 * D2R);
    };
    if (ap.mode === 'althold') {
      bank = st.a * 45 * D2R;
      vzCmd = 3 * (Math.abs(st.e) < 0.08 ? 0 : st.e);
      Vt = cfg.Vmin + (cfg.Vmax - cfg.Vmin) * clamp(st.thr, 0, 1);
    } else if (ap.mode === 'loiter') {
      bank = orbit(ap.center, cfg.loiterR);
    } else if (ap.mode === 'rtl') {
      ap.altT = ap.phase === 'climb' ? Math.max(ap.altT, cfg.rtlAlt) : ap.altT;
      const dist = Math.hypot(e.p[0], e.p[1]);
      if (ap.phase === 'climb' || ap.phase === 'return') {
        const crs = gsp > 2 ? Math.atan2(e.v[1], e.v[0]) : eu.yaw, want = Math.atan2(-e.p[1], -e.p[0]);
        bank = clamp(1.6 * wrapPi(want - crs), -40 * D2R, 40 * D2R);
        if (e.alt > cfg.rtlAlt - 3) ap.phase = 'return';
        if (dist < cfg.loiterR) ap.phase = 'loiter';
      }
      if (ap.phase === 'loiter') bank = orbit([0, 0], cfg.loiterR);
    }
    // height through pitch (flight-path angle + trim α, with an integrator), speed through throttle
    if (ap.altVer !== e.ver) { ap.altT = e.alt + (ap.altT - ap.altPrev); ap.altVer = e.ver; }
    ap.altPrev = e.alt;
    ap.altT += vzCmd * dt;
    const vzT = clamp(vzCmd + 0.35 * (ap.altT - e.alt), -3, 3.5);
    ap.pI = clamp(ap.pI + (vzT - e.vz) * dt, -6, 6);
    let pitch = Math.asin(clamp(vzT / V, -0.5, 0.5)) + cfg.aTrim + 0.04 * (vzT - e.vz) + 0.02 * ap.pI;
    if (V < cfg.Vmin) pitch -= (cfg.Vmin - V) * 0.04; // never trade the last of the airspeed for height
    pitch = clamp(pitch, -20 * D2R, 22 * D2R);
    ap.spdI = clamp(ap.spdI + (Vt - V) * dt, -10, 10);
    const thr = clamp(cfg.thrTrim + 0.06 * (Vt - V) + 0.012 * ap.spdI + 0.06 * vzT, 0.05, 1);
    return { thr, bank, pitch, r: 0 };
  }

  function autopilot(nav, s, sticks, cfg, dt) {
    if (!nav.ap.mode) return null;
    return cfg.kind === 'plane' ? plane(nav, s, sticks, cfg, dt) : rotary(nav, s, sticks, cfg, dt);
  }

  return { LIDARS, RCLINKS, VTXS, VIDEO_FLOOR, VIDEO_CLEAN, LINK_MARGIN, received, make, reset, sensors, link, enter, exit, autopilot };
})();
if (typeof module !== 'undefined') module.exports = NAV;
