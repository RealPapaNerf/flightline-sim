/* The three rotorcraft that are not plain helicopters. Run: node test/rotorcraft_test.js [id]

   A bench, like test/heli_test.js, printing numbers rather than asserting them —
   except for the handful of things that are not opinions, which are checked.
   What each machine is for:

     tipjet    a rotor driven by propellers at the blade tips. No reaction
               torque, so no tail rotor; the pedal is a motor on the mast and it
               steers on the rotor's own inertia.
     gyro      an autogyro. Nothing drives the rotor, ever.
     gyrodyne  a shaft-driven rotor with no tail rotor, countered by two
               reversing-pitch propellers on stub wings — and an autogyro the
               moment the rotor drive goes off.

   The number to watch throughout is the flare margin: the energy the head is
   holding above the speed at which it can no longer make one g, against the
   energy it takes to stop the descent. Under 100% the landing is an arrival. */
const FL = require('../src/physics.js');

const DT = 1 / 400, R2D = 180 / Math.PI;
const env = { rho: 1.225, wind: [0, 0, 0], battery: false, crashes: true };
const rpm = (om) => (om * 60) / (2 * Math.PI);
const eul = (s) => FL.eulerFromMat(FL.quatToMat(s.q));
const line = (...a) => console.log(...a);
let fails = 0;
const ok = (cond, what, extra) => { console.log(`${cond ? ' ok ' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); if (!cond) fails++; };

function fly(ac, s, ctl, secs, cb) {
  for (let i = 0, n = Math.round(secs / DT); i < n; i++) {
    const c = typeof ctl === 'function' ? ctl(s, i * DT) : ctl;
    FL.step(s, ac, Object.assign({ armed: true, mode: 'angle', curve: 'normal', a: 0, e: 0, r: 0 }, c), env, DT);
    if (cb && cb(s, i * DT) === false) return false;
  }
  return true;
}
const at = (ac, alt, V) => {
  const s = FL.makeState();
  FL.reset(s, ac, 'air');
  s.p = [0, 0, -alt];
  if (V !== undefined) { s.q = FL.quatFromEuler(0, 0, 0); s.v = [V, 0, 0]; }
  return s;
};

const PICK = process.argv[2];
const want = (id) => !PICK || PICK === id;

/* ---------------- the tip-driven rotor ---------------- */
if (want('tipjet')) {
  const ac = FL.build(FL.DEFS.tipjet), Ro = ac.rotor, H = ac.hoverThrCurve.normal;
  line('\n== Tip-prop heli ==');
  line(`${ac.mass} kg, ${(2 * Ro.R * 1000).toFixed(0)} mm rotor at ${rpm(Ro.om0).toFixed(0)} rpm (tip ${(Ro.om0 * Ro.R).toFixed(0)} m/s), solidity ${Ro.sigma.toFixed(3)}, disc loading ${((ac.mass * FL.G) / Ro.A).toFixed(1)} N/m²`);
  line(`${Ro.tip.n} tip props at ${Ro.tip.r} m, ${Ro.tip.Tmax} N static each, pitch speed ${Ro.tip.Vp} m/s — at the design headspeed they are flying at ${(Ro.om0 * Ro.tip.r).toFixed(0)} m/s and have ${(100 * (1 - (Ro.om0 * Ro.tip.r) / Ro.tip.Vp)).toFixed(0)}% of their thrust left`);
  line(`hover collective ${(ac.hoverPitch * R2D).toFixed(1)}°, stick ${(H * 100).toFixed(0)}%; rotor energy at the design headspeed ${(0.5 * Ro.J * Ro.om0 ** 2).toFixed(0)} J, of which ${(0.5 * Ro.J * (Ro.om0 ** 2 - ac.omMin ** 2)).toFixed(0)} J is spendable before the blades stall at ${rpm(ac.omMin).toFixed(0)} rpm`);

  { const s = FL.makeState(); FL.reset(s, ac, 'pad'); let t95 = null;
    fly(ac, s, { thr: 0.2, mode: 'acro' }, 20, (s, t) => { if (!t95 && s.om > 0.95 * Ro.om0) t95 = t; });
    line(`spool-up on the pad: 95% headspeed after ${t95 === null ? '—' : t95.toFixed(1) + ' s'}, on the skids: ${s.wow}, crashed ${s.crashed} ${s.crashMsg || ''}`); }

  { const s = at(ac, 6); let P = 0;
    fly(ac, s, { thr: H }, 8, (s) => { P = s.tele.Pm; });
    line(`hover stick for 8 s: altitude change ${(-s.p[2] - 6).toFixed(2)} m, drift ${Math.hypot(s.p[0], s.p[1]).toFixed(2)} m, heading ${(eul(s).yaw * R2D).toFixed(1)}°, ${rpm(s.om).toFixed(0)} rpm, ${P.toFixed(0)} W at the head`);
    ok(Math.abs(eul(s).yaw * R2D) < 3, 'it holds heading in a hover with no tail rotor', `${(eul(s).yaw * R2D).toFixed(1)}° in 8 s — tip drive reacts on the air, so there is nothing to hold`); }

  { const s = at(ac, 30); let vmax = 0, omMin = 1e9;
    fly(ac, s, { thr: 1 }, 6, (s) => { vmax = Math.max(vmax, -s.v[2]); omMin = Math.min(omMin, s.om); });
    line(`full collective for 6 s: peak climb ${vmax.toFixed(1)} m/s, headspeed held at ${(100 * omMin / Ro.om0).toFixed(0)}%, blades ${(s.tele.bladeStall * 100).toFixed(0)}% past the stall, ${s.tele.Pm.toFixed(0)} W at the head`); }

  { const s = at(ac, 30); let r = 0;
    fly(ac, s, { thr: H, r: 1 }, 3, (s) => { r = Math.max(r, s.w[2]); });
    line(`full right pedal, drive on: peak ${(r * R2D).toFixed(0)}°/s on the mast motor alone`); }

  /* The claim this configuration lives or dies on: that the pedal still works
     with the drive dead, because the head carries its own pack — and that it is
     paid for out of the rotor. */
  { const rows = [];
    let base = 0;
    for (const pedal of [0, 1]) {
      const s = at(ac, 120, 9);
      fly(ac, s, { thr: 0.15, e: -0.12, r: pedal, hold: true }, 8);
      if (pedal === 0) base = s.om;
      rows.push(`pedal ${pedal ? 'hard over' : 'centred'}: ${(100 * s.om / Ro.om0).toFixed(0)}% headspeed, ${(s.w[2] * R2D).toFixed(0)}°/s of yaw, flare margin ${(s.tele.flare * 100).toFixed(0)}%`);
      if (pedal === 1) ok(Math.abs(s.w[2] * R2D) > 90, 'the pedal still steers it with the drive dead', `${(s.w[2] * R2D).toFixed(0)}°/s — the hub has its own pack, so the mast motor does not go away with the engine`);
      if (pedal === 1) ok(s.om < base, 'and the yaw comes out of the rotor', `${rpm(base).toFixed(0)} rpm centred against ${rpm(s.om).toFixed(0)} rpm held over: ${(100 * (base - s.om) / base).toFixed(1)}% of the head spent on 8 s of pedal`);
    }
    line('eight seconds of autorotation:  ' + rows.join(' | ')); }

  { const s = at(ac, 80, 9); let g = null, td = null;
    fly(ac, s, (s) => {
      const h = -s.p[2];
      if (h > 8) return { thr: 0.15, e: -0.1, hold: true };
      return { thr: Math.min(1, 0.15 + (8 - h) / 9), e: 0.35, hold: true };
    }, 40, (s, t) => {
      if (!g && t > 6) g = { vz: s.v[2], vx: s.v[0], om: s.om, fl: s.tele.flare };
      if (s.wow || s.crashed) { td = { vz: s.v[2], vh: Math.hypot(s.v[0], s.v[1]), om: s.om }; return false; }
    });
    line(`autorotation from 80 m: glide ${g.vx.toFixed(1)} m/s forward, ${g.vz.toFixed(1)} m/s down at ${rpm(g.om).toFixed(0)} rpm with ${(g.fl * 100).toFixed(0)}% flare margin; touchdown ${td ? td.vz.toFixed(2) + ' m/s down, ' + td.vh.toFixed(1) + ' forward, ' + rpm(td.om).toFixed(0) + ' rpm' : '—'} — ${s.crashed ? s.crashMsg : 'landed'}`);
    ok(!s.crashed, 'it can be autorotated to the ground', `low disc loading and pods out at ${Ro.tip.r} m: ${g.vz.toFixed(1)} m/s of sink against a 450's 7.2`); }
}

/* ---------------- the autogyro ---------------- */
if (want('gyro')) {
  const ac = FL.build(FL.DEFS.gyro), Ro = ac.rotor;
  line('\n== Autogyro ==');
  line(`${ac.mass} kg, ${(2 * Ro.R * 1000).toFixed(0)} mm rotor nobody drives, blades fixed at ${Ro.fixed}°, mast raked ${Ro.rake}° back, ${ac.thrusters[0].Tmax} N pusher`);

  { const s = FL.makeState(); FL.reset(s, ac, 'runway'); let pre = null, off = null, roll = null;
    const start = s.p[1];
    fly(ac, s, (s, t) => (t < 14 ? { thr: 0.05 } : { thr: 1, e: s.tele.V > 10 ? 0.3 : 0.1 }), 60, (s, t) => {
      if (!pre && s.om >= Ro.prerot.om) pre = t;
      if (!off && !s.wow && t > 14) { off = t; roll = Math.abs(s.p[1] - start); }
      if (s.crashed) return false;
    });
    line(`prerotator reaches ${Ro.prerot.om} rad/s after ${pre === null ? '—' : pre.toFixed(0) + ' s'} of waiting; unstick ${off === null ? 'never' : (off - 14).toFixed(0) + ' s into the roll, after ' + roll.toFixed(0) + ' m'}; one minute in: ${(-s.p[2]).toFixed(0)} m at ${s.tele.V.toFixed(1)} m/s, ${rpm(s.om).toFixed(0)} rpm`);
    ok(off !== null && !s.crashed, 'it prerotates, rolls and flies', s.crashMsg || `${roll === null ? '—' : roll.toFixed(0) + ' m of runway'}`); }

  { const rows = [];
    for (const thr of [0.3, 0.5, 0.75, 1]) {
      const s = at(ac, 400); fly(ac, s, { thr }, 40);
      rows.push(`${(thr * 100).toFixed(0)}%: ${s.tele.V.toFixed(1)} m/s, ${s.v[2] > 0 ? s.v[2].toFixed(1) + ' down' : (-s.v[2]).toFixed(1) + ' up'}, ${rpm(s.om).toFixed(0)} rpm`);
    }
    line('level-ish flight on the throttle alone (sticks centred):  ' + rows.join(' | ')); }

  { const rows = []; let steady = true;
    for (const e of [-0.1, -0.2, -0.3, -0.45, -0.6]) {
      const s = at(ac, 400); fly(ac, s, { thr: 0, e }, 40);
      const vb = FL.mulMtV(FL.quatToMat(s.q), s.v);
      rows.push(`${(e * 35).toFixed(0)}°: ${vb[0].toFixed(1)} m/s, ${s.v[2].toFixed(2)} down, L/D ${(Math.hypot(s.v[0], s.v[1]) / s.v[2]).toFixed(1)}, ${rpm(s.om).toFixed(0)} rpm`);
      if (Math.abs(100 * s.om / Ro.om0 - 100) > 25) steady = false;
    }
    line('engine off, held at a pitch attitude (the rotor finds its own speed every time):  ' + rows.join(' | '));
    ok(steady, 'the rotor self-regulates across the whole glide', 'nothing governs it: the disc angle does'); }

  /* The flare window. An autogyro cannot hover, so a flare that arrests the
     sink also runs the speed out — the whole skill is arriving at the ground at
     the moment that happens, and the window is about a metre wide. */
  { const rows = [];
    for (const hf of [1.5, 2, 2.5, 3, 4]) {
      const s = at(ac, 60); let t0 = null, td = null;
      fly(ac, s, (s, t) => {
        const h = -s.p[2];
        if (h >= hf) return { thr: 0, e: -0.3 };
        if (t0 === null) t0 = t;
        return { thr: 0, e: -0.3 + 1.05 * Math.min(1, (t - t0) / 0.9) };
      }, 70, (s) => { if (s.wow || s.crashed) { td = { vz: s.v[2], vh: Math.hypot(s.v[0], s.v[1]) }; return false; } });
      rows.push(`${hf} m: ${td ? td.vz.toFixed(2) + ' down, ' + td.vh.toFixed(1) + ' forward' : '—'}${s.crashed ? ' CRASH' : ''}`);
    }
    line('flaring from an 8 m/s glide, started at:  ' + rows.join(' | ')); }
}

/* ---------------- the gyrodyne ---------------- */
if (want('gyrodyne')) {
  const ac = FL.build(FL.DEFS.gyrodyne), Ro = ac.rotor, H = ac.hoverThrCurve.normal;
  line('\n== Gyrodyne ==');
  line(`${ac.mass} kg, ${(2 * Ro.R * 1000).toFixed(0)} mm shaft-driven rotor at ${rpm(Ro.om0).toFixed(0)} rpm, no tail rotor; two props at ±${Math.abs(ac.thrusters[0].p[1])} m, ${ac.thrusters[0].Tmax} N forward and ${ac.thrusters[0].Tmin} N backward each`);
  line(`hover collective ${(ac.hoverPitch * R2D).toFixed(1)}°, stick ${(H * 100).toFixed(0)}%; the head takes up ${Ro.rakeFree}° of rake and the collective parks at ${Ro.autoPitch}° once the drive goes off`);

  { const s = at(ac, 6); let P = 0;
    fly(ac, s, { thr: H }, 8, (s) => { P = s.tele.Pm; });
    line(`hover stick for 8 s: altitude change ${(-s.p[2] - 6).toFixed(2)} m, drift ${Math.hypot(s.p[0], s.p[1]).toFixed(2)} m, heading ${(eul(s).yaw * R2D).toFixed(1)}°, ${P.toFixed(0)} W at the head, props ${s.tp.map((x) => x.toFixed(1)).join(' / ')} N`);
    ok(Math.abs(s.tp[0] + s.tp[1]) < 0.6 * Math.abs(s.tp[0]), 'the propellers counter the torque at zero net thrust', `${s.tp[0].toFixed(1)} N one side against ${s.tp[1].toFixed(1)} N the other — reversing pitch is what lets it hover straight`);
    ok(Math.hypot(s.p[0], s.p[1]) < 2, 'so it holds a spot instead of charging forward', `${Math.hypot(s.p[0], s.p[1]).toFixed(2)} m of drift in 8 s`); }

  { const s = at(ac, 30); let r = 0;
    fly(ac, s, { thr: H, r: 1 }, 3, (s) => { r = Math.max(r, s.w[2]); });
    line(`full right pedal in the hover: peak ${(r * R2D).toFixed(0)}°/s on differential thrust`); }

  /* The switch the whole machine exists for, thrown in flight and thrown back. */
  { const s = at(ac, 120);
    const snap = (tag) => `${tag}: ${s.tele.V.toFixed(1)} m/s, ${rpm(s.om).toFixed(0)} rpm (${(100 * s.om / Ro.om0).toFixed(0)}%), rake ${(s.rk * R2D).toFixed(1)}°, collective ${(s.coll * R2D).toFixed(1)}°, props ${s.tp.map((x) => x.toFixed(1)).join('/')} N, stick is the ${s.tele.stickIsEngine ? 'engine' : 'collective'}`;
    fly(ac, s, { thr: H }, 6); line('  ' + snap('helicopter, hovering'));
    const omHeli = s.om;
    fly(ac, s, { thr: 0.9, hold: true }, 20); line('  ' + snap('throttle hold on, 20 s later'));
    const omGyro = s.om;
    fly(ac, s, { thr: 1, e: 0.1, hold: true }, 20); line('  ' + snap('autogyro, full power'));
    fly(ac, s, { thr: H }, 15); line('  ' + snap('throttle hold off, 15 s later'));
    ok(!s.crashed, 'the mode switch can be thrown in flight and thrown back', s.crashMsg || 'throttle hold is the whole switch');
    ok(omGyro < 0.7 * omHeli && s.om > 0.9 * omHeli, 'and the rotor slows to a free speed and comes back', `${rpm(omHeli).toFixed(0)} → ${rpm(omGyro).toFixed(0)} → ${rpm(s.om).toFixed(0)} rpm`); }

  { const s = at(ac, 80, 10); let g = null, td = null;
    fly(ac, s, (s) => {
      const h = -s.p[2];
      if (h > 2) return { thr: 0.3, e: -0.15, hold: true };
      return { thr: 0.1, e: 0.45, hold: true };
    }, 50, (s, t) => {
      if (!g && t > 8) g = { vz: s.v[2], vx: s.v[0], om: s.om, fl: s.tele.flare };
      if (s.wow || s.crashed) { td = { vz: s.v[2], vh: Math.hypot(s.v[0], s.v[1]) }; return false; }
    });
    line(`engine out from 80 m, flown as an autogyro: glide ${g.vx.toFixed(1)} m/s forward, ${g.vz.toFixed(1)} m/s down at ${rpm(g.om).toFixed(0)} rpm, ${(g.fl * 100).toFixed(0)}% flare margin; touchdown ${td ? td.vz.toFixed(2) + ' m/s down, ' + td.vh.toFixed(1) + ' forward' : '—'} — ${s.crashed ? s.crashMsg : 'landed'}`);
    ok(!s.crashed, 'and it can be put down on its skids without the rotor drive', s.crashMsg || 'flared at 2 m: heavier, faster and on skids, so the window is tighter than the autogyro\'s'); }
}

/* ---------------- what every rotorcraft file has to hold together ----------------
   The three drives each need their own block, and a file that says `tip` but
   carries no tip propellers builds an aircraft with no way to turn its rotor.
   Checked across the built-ins and the aircraft folder together, because an
   imported file goes through exactly the same build. */
line('\n== every rotorcraft, built-in and in the folder ==');
{
  const fs = require('fs'), path = require('path');
  const all = [];
  for (const [id, def] of Object.entries(FL.DEFS)) if (def.kind === 'heli' || def.kind === 'gyro') all.push([id, def]);
  const ACF = require('../src/aircraft.js');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'aircraft')).sort()) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const r = ACF.read(fs.readFileSync(path.join(__dirname, '..', 'aircraft', f), 'utf8'));
    if (r.ok && (r.def.kind === 'heli' || r.def.kind === 'gyro')) all.push([f, r.def]);
  }
  for (const [name, def] of all) {
    const ac = FL.build(def), Ro = ac.rotor, drv = Ro.drive || 'shaft';
    const need = drv === 'tip' ? !!Ro.tip : drv === 'none' ? Ro.fixed !== undefined : !!Ro.curves;
    ok(need, `${name}: a '${drv}' drive carries what a '${drv}' drive needs`,
      drv === 'tip' ? 'rotor.tip' : drv === 'none' ? 'rotor.fixed' : 'rotor.curves');
    // something has to be able to point the nose, or the pedal does nothing at all
    const yaw = (Ro.TtMax > 0 && Ro.lt > 0) || (Ro.mast && Ro.mast.Q > 0) || (Ro.vane && Ro.vane.area > 0)
      || !!(def.thrusters && def.thrusters.some((T) => T.yaw));
    ok(yaw, `${name}: has something to yaw with`,
      Ro.TtMax > 0 ? 'a tail rotor' : Ro.mast ? 'a motor on the mast' : def.thrusters ? 'differential thrust' : 'vanes');
    // a shaft-driven rotor with no tail rotor needs something to take the reaction
    if (drv === 'shaft' && !(Ro.TtMax > 0)) {
      ok(!!(def.thrusters && def.thrusters.some((T) => T.yaw)), `${name}: a shaft drive with no tail rotor has something to take the torque`,
        'otherwise the airframe simply spins the other way');
    }
    /* A camera on the rotor head has to sit in clear air above the housing the
       model draws under it, or the only thing it ever shows you is the inside
       of its own dome. The clearance here is the one buildRotorcraft() uses. */
    if (def.hubCam) {
      const above = -def.hubCam[2] - Ro.h;
      ok(above > 0.03, `${name}: the hub camera looks out of its own housing`, `${(above * 1000).toFixed(0)} mm above the head`);
      // and if that camera is also the pilot's, it has to look down past the blades rather than up over them
      if (ac.fpvOnHub) ok(def.camTilt < 0, `${name}: and the view from it looks down`, `${def.camTilt}°`);
      else ok(true, `${name}: its head camera is payload, not the pilot's view`, `FPV is on the nose at ${def.fpvCam[0]} m`);
    }
  }
}

line(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
