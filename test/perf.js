// Trim/performance table straight from the model. Run: node test/perf.js
const FL = require('../src/physics.js');
const mph = (v) => (v * 2.23694).toFixed(0);
const deg = (r) => ((r * 180) / Math.PI).toFixed(1);
for (const id of Object.keys(FL.DEFS)) {
  const ac = FL.build(FL.DEFS[id]);
  if (ac.kind === 'quad' || ac.kind === 'heli') continue; // trim tables are for wings
  const t0 = Date.now();
  const P = FL.performance(ac);
  console.log(`\n${ac.name}: 1-g stall ${P.stall.Vs.toFixed(1)} m/s (${mph(P.stall.Vs)} mph), CLmax ${P.stall.CLmax.toFixed(2)} at α ${deg(P.stall.alpha)}°; ` +
    `top speed ${P.Vmax} m/s (${mph(P.Vmax)} mph); hands-off trim ${P.handsOff ? P.handsOff.toFixed(1) + ' m/s (' + mph(P.handsOff) + ' mph)' : 'n/a'}  [${Date.now() - t0} ms]`);
  if (ac.defl.f) { // flaps: half and full, at the same weight
    for (const fl of [0.5, 1]) {
      const st = FL.stallSpeed(ac, 1.225, { flap: fl });
      console.log(`   flap ${(fl * ac.defl.f * 180 / Math.PI).toFixed(0).padStart(2)}°: stall ${st.Vs.toFixed(1)} m/s (${mph(st.Vs)} mph), CLmax ${st.CLmax.toFixed(2)} at α ${deg(st.alpha)}°`);
    }
  }
  console.log('   V m/s  mph   α°    elev%  thr%  ail%');
  for (const r of P.rows) if (r.V % 2 === 0 || r === P.rows[P.rows.length - 1])
    console.log(`   ${String(r.V).padStart(4)}  ${mph(r.V).padStart(4)}  ${deg(r.alpha).padStart(5)}  ${(r.e * 100).toFixed(0).padStart(5)}  ${(r.thr * 100).toFixed(0).padStart(4)}  ${(r.a * 100).toFixed(1).padStart(5)}`);
}
