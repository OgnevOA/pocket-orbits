/*
 * Automated checks for the simulation core. Open tests/index.html in a browser (or run
 * tests/run_browser_tests.py) — results are rendered on the page and exposed as window.TEST_RESULTS.
 */
(function (root) {
  'use strict';
  const SB = root.SB, P = root.Pilots;
  const results = [];
  const DEG = 180 / Math.PI;

  function check(name, fn) {
    const t0 = performance.now();
    const rec = { name, pass: false, details: [], ms: 0 };
    const detail = (s) => rec.details.push(s);
    try {
      const r = fn(detail);
      rec.pass = r !== false;
    } catch (e) {
      rec.pass = false;
      detail('EXCEPTION: ' + (e && e.stack ? e.stack : e));
    }
    rec.ms = Math.round(performance.now() - t0);
    results.push(rec);
    return rec.pass;
  }
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const km = (m) => (m / 1000).toFixed(2) + ' km';

  const sys = new SB.PlanetSystem(SB.CONFIG);
  const starter = SB.Craft.makeDesign(SB.CONFIG.presets[0].name, SB.CONFIG.presets[0].parts);
  const planet = sys.planet, pock = sys.byId('pock');
  const shared = {};

  check('System parameters match the spec', (d) => {
    const R = planet.radius;
    d(`Planet R=${R} m, g=${planet.surfaceGravity}, mu=${planet.mu.toExponential(4)}, atmosphere top ${planet.atmosphere.height} m`);
    for (const m of sys.moons) d(`${m.name}: R=${m.radius / 1000} km, g=${m.surfaceGravity}, orbit ${m.orbitRadius / 1000} km, SOI ${km(m.soi)}, period ${(m.period / 3600).toFixed(2)} h, terrain ${m.terrain.minH.toFixed(0)}..${m.terrain.maxH.toFixed(0)} m`);
    d(`Planet terrain ${planet.terrain.minH.toFixed(0)}..${planet.terrain.maxH.toFixed(0)} m; density at 0/5/14.9/15 km: ${[0, 5000, 14900, 15000].map((h) => sys.density(planet, h).toFixed(4)).join(' / ')}`);
    return R === 120000 && planet.surfaceGravity === 4 && sys.density(planet, 15000) === 0 && sys.density(planet, 14000) > 0 &&
      sys.moons.map((m) => [m.radius, m.surfaceGravity, m.orbitRadius].join()).join('|') === '12000,0.3,600000|22000,0.5,1300000|35000,0.7,2500000';
  });

  check('Circular orbit speed at 25 km is ~630 m/s', (d) => {
    const v = Math.sqrt(planet.mu / (planet.radius + 25000));
    d(`v_circ(25 km) = ${v.toFixed(2)} m/s`);
    return near(v, 630, 2);
  });

  check('Kepler propagation: 3 periods in one call vs 3000 small steps (elliptic + hyperbolic)', (d) => {
    const mu = planet.mu, rp = planet.radius + 25000, ra = planet.radius + 400000;
    const a = (rp + ra) / 2, vp = Math.sqrt(mu * (2 / rp - 1 / a));
    const T = 2 * Math.PI * Math.sqrt(a * a * a / mu);
    const s = [rp, 0, 0, -vp];
    const one = SB.Orbit.propagate(mu, s[0], s[1], s[2], s[3], 3 * T);
    let st = s.slice();
    for (let i = 0; i < 3000; i++) st = SB.Orbit.propagate(mu, st[0], st[1], st[2], st[3], T / 1000);
    const e1 = Math.hypot(one[0] - s[0], one[1] - s[1]), e2 = Math.hypot(st[0] - s[0], st[1] - s[1]);
    d(`Return-to-start error: single call ${e1.toExponential(2)} m, stepped ${e2.toExponential(2)} m`);
    const hv = SB.Orbit.propagate(mu, rp, 0, 0, -1000, 5000);
    const back = SB.Orbit.propagate(mu, hv[0], hv[1], hv[2], hv[3], -5000);
    const e3 = Math.hypot(back[0] - rp, back[1]);
    d(`Hyperbolic forward/back error ${e3.toExponential(2)} m (r after 5000 s: ${km(Math.hypot(hv[0], hv[1]))})`);
    const rad = SB.Orbit.propagate(mu, rp, 0, 300, 0, 200);
    d(`Radial (vertical) trajectory after 200 s: r=${km(Math.hypot(rad[0], rad[1]))}, vr=${rad[2].toFixed(2)} m/s`);
    return e1 < 0.01 && e2 < 1 && e3 < 0.01 && isFinite(rad[0]);
  });

  check('Starter rocket analysis: wet mass, liftoff TWR, delta-v per stage', (d) => {
    const a = SB.Craft.analyzeDesign(starter, sys);
    d(`Wet ${a.wetMass} kg, dry ${a.dryMass} kg, height ${a.height.toFixed(2)} m, liftoff TWR ${a.liftoffTwr.toFixed(2)}`);
    a.stages.forEach((s) => d(`Stage ${s.number}: ignites [${s.ignites.map((x) => x.name).join(', ')}] decouples [${s.decouples.map((x) => x.name).join(', ')}] dv vac ${s.dvVac.toFixed(0)} / ASL ${s.dvAsl.toFixed(0)} m/s, TWR ${s.twrAsl.toFixed(2)}, burn ${s.burnTime.toFixed(0)} s, mass ${s.startMass.toFixed(0)} -> ${s.endMass.toFixed(0)} kg`));
    d(`Warnings: ${a.warnings.map((w) => w.text).join(' | ') || 'none'}`);
    shared.analysis = a;
    return a.stages.length === 2 && a.liftoffTwr > 1.5 && a.stages[0].ignites.length === 1 && a.stages[1].decouples.length === 1 && !a.warnings.some((w) => w.level === 'bad');
  });

  check('Staging and fuel: mass drops with burn and with decoupling', (d) => {
    const f = new SB.Flight(sys, starter);
    const m0 = f.craft.mass();
    f.setThrottle(1); f.stage();
    f.simulate(10);
    const m1 = f.craft.mass();
    const expectedFlow = 25000 / (285 * SB.CONFIG.g0);
    d(`Mass ${m0.toFixed(1)} -> ${m1.toFixed(1)} kg after 10 s (expected flow ${expectedFlow.toFixed(3)} kg/s, observed ${((m0 - m1) / 10).toFixed(3)} kg/s)`);
    const before = f.craft.mass();
    f.stage();
    const after = f.craft.mass();
    d(`Decoupling removed ${(before - after).toFixed(1)} kg; ${f.debris.length} debris object(s); remaining parts: ${f.craft.parts.map((p) => p.def.name.split(' ')[0]).join(', ')}`);
    return near((m0 - m1) / 10, expectedFlow, 0.05) && after < before - 1000 && f.craft.parts.length === 4;
  });

  check('Frame-rate independence: same flight at 30 fps vs 144 fps', (d) => {
    const run = (fps) => {
      const f = new SB.Flight(sys, starter);
      f.setThrottle(1); f.stage();
      for (let i = 0; i < 60 * fps; i++) { if (i === 20 * fps) f.rotInput = -1; if (i === 22 * fps) f.rotInput = 0; f.update(1 / fps); }
      return f;
    };
    const a = run(30), b = run(144);
    const dt = Math.abs(a.st.t - b.st.t);
    const dp = Math.hypot(a.st.rx - b.st.rx, a.st.ry - b.st.ry);
    d(`After 60 s: alt ${a.altitude().toFixed(1)} vs ${b.altitude().toFixed(1)} m; sim-time diff ${dt.toFixed(3)} s; position diff ${dp.toFixed(2)} m`);
    return dt < 0.05 && dp < 30;
  });

  // ---------------------------------------------------------------- mission: orbit
  let orbitFlight = null;
  check('Launch and stage the starter rocket; reach an orbit entirely above the atmosphere', (d) => {
    const f = new SB.Flight(sys, starter);
    const log = [];
    const p = { turnAlt: 500, turnDeg: 25, targetAp: 30000, targetPe: 20000 };
    const res = P.ascend(f, p, log);
    log.forEach((l) => d(`T+${l.t}s alt ${l.alt} m: ${l.text}`));
    const el = f.orbit();
    const R = planet.radius;
    d(`Result: ${f.situationText()} Ap ${km(el.ra - R)} Pe ${km(el.rp - R)} e=${el.e.toFixed(4)}; stages used ${f.craft.nextStage}; fuel left in active stage ${f.craft.activeStageFuel().fuel.toFixed(0)} kg; dv left ~${f.craft.activeStageDv(0).toFixed(0)} m/s`);
    shared.ascentLog = log; shared.ascentParams = p;
    orbitFlight = f;
    return res.ok && el.rp - R > 15000 && el.e < 1;
  });

  check('Coast three orbits (rails warp + 1x): orbit stays stable', (d) => {
    const f = orbitFlight;
    if (!f) return false;
    const R = planet.radius;
    const e0 = f.orbit();
    const t0 = f.st.t;
    // 1x for 120 s first (fixed-step coasting), then warp for the rest
    for (let i = 0; i < 120 * 60; i++) f.update(1 / 60);
    const target = t0 + 3 * e0.period;
    let maxWarp = 1;
    P.coastUntil(f, (ff) => ff.st.t >= target, 1000, 1e5);
    maxWarp = Math.max(maxWarp, f.warpRate());
    const e1 = f.orbit();
    d(`Before: Ap ${km(e0.ra - R)} Pe ${km(e0.rp - R)} period ${e0.period.toFixed(1)} s`);
    d(`After ${((f.st.t - t0) / e0.period).toFixed(2)} orbits: Ap ${km(e1.ra - R)} Pe ${km(e1.rp - R)} period ${e1.period.toFixed(1)} s`);
    d(`Drift: Ap ${(e1.ra - e0.ra).toFixed(3)} m, Pe ${(e1.rp - e0.rp).toFixed(3)} m, situation "${f.situationText()}"`);
    const r = f.r();
    d(`Speed now ${f.speed().toFixed(2)} m/s at ${km(r - R)}; vis-viva expects ${Math.sqrt(planet.mu * (2 / r - 1 / e1.a)).toFixed(2)} m/s`);
    return Math.abs(e1.ra - e0.ra) < 1 && Math.abs(e1.rp - e0.rp) < 1 && f.situation === 'flying';
  });

  check('Exact 25 km circular orbit: 630 m/s, unchanged after three orbits in flight', (d) => {
    const f = new SB.Flight(sys, starter);
    f.stage(); f.stage(); // drop booster to make the craft small
    const r = planet.radius + 25000, v = Math.sqrt(planet.mu / r);
    f.situation = 'flying'; f.st.body = planet; f.st.rx = 0; f.st.ry = r; f.st.vx = v; f.st.vy = 0; f.setThrottle(0);
    f.predDirty = true;
    const T = f.orbit().period;
    const t0 = f.st.t;
    let minS = Infinity, maxS = 0, minA = Infinity, maxA = 0;
    P.fly(f, () => {
      minS = Math.min(minS, f.speed()); maxS = Math.max(maxS, f.speed());
      minA = Math.min(minA, f.altitude()); maxA = Math.max(maxA, f.altitude());
      f.setWarp(P.warpIndexFor(f, 10));
      return f.st.t - t0 >= 3 * T;
    });
    d(`Period ${T.toFixed(1)} s; speed range ${minS.toFixed(3)}..${maxS.toFixed(3)} m/s; altitude range ${minA.toFixed(2)}..${maxA.toFixed(2)} m over ${((f.st.t - t0) / T).toFixed(2)} orbits`);
    return near(v, 630, 2) && maxS - minS < 0.01 && maxA - minA < 0.5;
  });

  // ---------------------------------------------------------------- maneuver nodes
  /** Starter upper stage in an exact circular orbit (clockwise, like the moons). */
  function orbitAt(alt) {
    const f = new SB.Flight(sys, starter);
    f.stage(); f.stage();
    const r = planet.radius + alt, v = Math.sqrt(planet.mu / r);
    f.situation = 'flying'; f.st.body = planet; f.st.rx = 0; f.st.ry = r; f.st.vx = v; f.st.vy = 0;
    f.heading = 0; f.setThrottle(0); f.predDirty = true; f.maybePredict(true);
    return f;
  }
  const R0 = planet.radius;

  check('Maneuver node: the planned orbit equals the orbit after the same impulsive burn', (d) => {
    const f = orbitAt(25000);
    const node = f.planner.add(f.st.t + 600, 120, 15);
    f.planner.compute();
    const inf = f.planner.info(node);
    const plan = inf.layer.segments[0].el;
    const s = { body: f.st.body, t: f.st.t, rx: f.st.rx, ry: f.st.ry, vx: f.st.vx, vy: f.st.vy };
    SB.Coast.advance(sys, s, node.t - s.t, { clearance: f.contactClearance() });
    const ax = SB.Maneuver.axes(s);
    s.vx += 120 * ax.px + 15 * ax.nx; s.vy += 120 * ax.py + 15 * ax.ny;
    const el = SB.Orbit.elements(planet.mu, s.rx, s.ry, s.vx, s.vy);
    d(`Node: +120 m/s prograde, +15 m/s radial in 600 s → planned Ap ${km(plan.ra - R0)} Pe ${km(plan.rp - R0)}`);
    d(`Same burn applied by hand at the node time → Ap ${km(el.ra - R0)} Pe ${km(el.rp - R0)}; |Δv| ${inf.total.toFixed(3)} m/s; burn estimate ${inf.burn.time.toFixed(1)} s`);
    const marks = inf.layer.segments[0].marks.map((m) => m.type).join(',');
    d(`Planned leg markers: ${marks}`);
    return Math.abs(plan.ra - el.ra) < 0.01 && Math.abs(plan.rp - el.rp) < 0.01 && near(inf.total, Math.hypot(120, 15), 1e-6) && /ap/.test(marks) && /pe/.test(marks);
  });

  check('Fly a node: warp stops before the burn, Δv counts down, node clears itself, orbit matches the plan', (d) => {
    const f = orbitAt(25000);
    const node = f.planner.add(f.st.t + 900, 150, 0);
    f.planner.compute();
    const planned = f.planner.info(node).layer.segments[0].el;
    const r = P.executeNode(f);
    const el = f.orbit();
    d(`Warp while waiting: up to ${r.maxWarp}x, ${r.warpAt10}x at 10 s before the burn start`);
    d(`Burn ${r.burnTime.toFixed(1)} s with maneuver hold; Δv left at cut-off ${r.remaining.toFixed(2)} m/s; node removed: ${r.removed}`);
    d(`Planned Ap ${km(planned.ra - R0)} Pe ${km(planned.rp - R0)}; flown Ap ${km(el.ra - R0)} Pe ${km(el.rp - R0)}`);
    return r.ok && r.removed && r.maxWarp >= 100 && r.warpAt10 === 1 &&
      Math.abs(el.ra - planned.ra) < 0.01 * planned.ra && Math.abs(el.rp - planned.rp) < 1000;
  });

  check('Plan transfer and capture as two nodes before leaving orbit, then fly both into Pock orbit', (d) => {
    const f = orbitAt(25000);
    f.setTarget(pock);
    const n1 = f.planner.planTransfer(pock);
    d(`"Create transfer node": ${n1.pro.toFixed(1)} m/s prograde in ${(n1.t - f.st.t).toFixed(0)} s`);
    const inRange = (inf) => { const pe = P.layerPeAt(inf.layer, pock); return pe !== null && pe > 4000 && pe < 9000; };
    let t1 = P.tuneNode(f, n1, 'pro', 0.1, inRange, 150);
    if (!t1.ok) { f.planner.setComps(n1, f.transferInfo(pock).dv, 0); t1 = P.tuneNode(f, n1, 'pro', -0.1, inRange, 150); }
    d(`Tuned node 1 to ${n1.pro.toFixed(1)} m/s → planned Pock periapsis ${(P.layerPeAt(f.planner.info(n1).layer, pock) / 1000).toFixed(2)} km (${t1.steps} clicks)`);
    if (!t1.ok) return false;
    const pockSeg = f.planner.info(n1).layer.segments.find((s) => s.body === pock);
    const peMark = pockSeg.marks.find((m) => m.type === 'pe');
    const n2 = f.planner.add(peMark.t, 0, 0);
    const t2 = P.tuneNode(f, n2, 'pro', -1, (inf) => inf.pre.body === pock && inf.postEl.e < 1 && inf.postEl.ra < pock.soi * 0.8, 300);
    const inf2 = f.planner.info(n2);
    d(`Node 2 at the planned Pock periapsis: ${n2.pro.toFixed(0)} m/s → planned Pock orbit ${km(inf2.postEl.ra - pock.radius)} × ${km(inf2.postEl.rp - pock.radius)}; total planned Δv ${(f.planner.info(n1).total + inf2.total).toFixed(0)} m/s`);
    const e1 = P.executeNode(f);
    const peNow = P.predictedPeAlt(f, pock);
    d(`Flew node 1: ${e1.burnTime.toFixed(1)} s, Δv left ${e1.remaining.toFixed(2)} m/s, removed ${e1.removed}; actual Pock periapsis now ${peNow === null ? 'none' : (peNow / 1000).toFixed(2) + ' km'}`);
    const e2 = P.executeNode(f);
    const el = f.orbit();
    d(`Flew node 2 (warp crossed the SOI on the way): ${e2.burnTime.toFixed(1)} s, removed ${e2.removed}; ${f.situationText()} Ap ${km(el.ra - pock.radius)} Pe ${km(el.rp - pock.radius)}; fuel left ${f.craft.activeStageFuel().fuel.toFixed(0)} kg`);
    return t2.ok && e1.removed && e2.removed && f.situationText().startsWith('Orbiting Pock');
  });

  // ---------------------------------------------------------------- mission: Pock
  check('Plan and burn a transfer: map prediction shows a Pock encounter', (d) => {
    const f = orbitFlight;
    if (!f) return false;
    const r = P.transfer(f, pock);
    d(`Phase angle ${(r.info0.phase * DEG).toFixed(1)}°, ideal ${(r.info0.ideal * DEG).toFixed(1)}°, wait ${r.info0.wait.toFixed(0)} s, Hohmann dv ${r.info0.dv.toFixed(1)} m/s`);
    d(`At burn: phase ${(r.info1.phase * DEG).toFixed(1)}° vs ideal ${(r.info1.ideal * DEG).toFixed(1)}°`);
    d(`Burned ${r.dv.toFixed(1)} m/s prograde; encounter=${!!r.entry}; predicted Pock Pe ${(r.pe / 1000).toFixed(2)} km`);
    if (r.entry) d(`Predicted SOI entry in ${(r.entry.t - f.st.t).toFixed(0)} s (T=${r.entry.t.toFixed(1)})`);
    shared.predictedEntry = r.entry ? r.entry.t : null;
    return r.ok;
  });

  check('Time warp through the encounter: warp slows down, SOI switch preserves position and velocity', (d) => {
    const f = orbitFlight;
    if (!f || !shared.predictedEntry) return false;
    const w = P.warpToSoi(f);
    const ev = w.ev;
    if (!ev) { d('No SOI change happened'); return false; }
    const mp = sys.bodyPos(ev.to, ev.t), mv = sys.bodyVel(ev.to, ev.t);
    const gBefore = ev.before; // the planet frame is the global frame
    const gAfter = [ev.after[0] + mp[0], ev.after[1] + mp[1], ev.after[2] + mv[0], ev.after[3] + mv[1]];
    const dp = Math.hypot(gAfter[0] - gBefore[0], gAfter[1] - gBefore[1]);
    const dv = Math.hypot(gAfter[2] - gBefore[2], gAfter[3] - gBefore[3]);
    d(`SOI change ${ev.from.name} -> ${ev.to.name} at T=${ev.t.toFixed(1)} (predicted ${shared.predictedEntry.toFixed(1)}, diff ${(ev.t - shared.predictedEntry).toFixed(2)} s)`);
    d(`Max warp requested ${f.warpLevels()[f.warpLevels().length - 1]}x, max reached ${w.maxWarp}x, warp in the frame before entry ${w.warpAtEntry}x`);
    d(`Global position jump ${dp.toExponential(2)} m, velocity jump ${dv.toExponential(2)} m/s; distance from ${ev.to.name} ${km(Math.hypot(ev.after[0], ev.after[1]))} (SOI ${km(ev.to.soi)})`);
    return w.ok && ev.to === pock && dp < 1e-6 && dv < 1e-9 && Math.abs(ev.t - shared.predictedEntry) < 2 && w.warpAtEntry < w.maxWarp;
  });

  check('Enter lunar orbit around Pock', (d) => {
    const f = orbitFlight;
    if (!f || f.body !== pock) return false;
    const el0 = f.orbit();
    d(`Arrival: e=${el0.e.toFixed(3)}, Pe ${km(el0.rp - pock.radius)} in ${el0.timeToPe.toFixed(0)} s`);
    const r = P.capture(f, pock);
    const el = f.orbit();
    d(`After capture burn: ${f.situationText()} Ap ${km(el.ra - pock.radius)} Pe ${km(el.rp - pock.radius)} period ${(el.period / 60).toFixed(1)} min; fuel ${f.craft.activeStageFuel().fuel.toFixed(0)} kg`);
    return r.ok;
  });

  check('Deorbit and land on Pock with the starter upper stage (legs)', (d) => {
    const f = orbitFlight;
    if (!f || f.body !== pock) return false;
    const r1 = P.deorbit(f, pock);
    d(`Deorbit burn done: Pe ${km(f.orbit().rp - pock.radius)}`);
    const log = [];
    const r2 = P.land(f, log);
    log.forEach((l) => d(`T=${l.t} radar ${l.alt} m: ${l.text}`));
    const o = f.outcome;
    if (o) d(`Outcome: ${o.type} on ${o.body.name}: descent ${o.descent.toFixed(2)} m/s, horizontal ${o.horizontal.toFixed(2)} m/s, tilt ${o.tilt.toFixed(1)}°, slope ${o.slope.toFixed(1)}°, legs=${o.legs} ${o.reasons.join('; ')}`);
    d(`Fuel left ${f.craft.activeStageFuel().fuel.toFixed(0)} kg`);
    return r1.ok && r2.ok && o && o.type === 'landed';
  });

  // ---------------------------------------------------------------- touchdown rules
  /** First angle at/after `a` where the ground is flat (< 3°) for ±10 m around it. */
  function findFlat(body, a) {
    const step = 2 / body.radius;
    for (let k = 0; k < 200000; k++) {
      const x = a + k * step;
      let ok = true;
      for (let j = -5; j <= 5 && ok; j++) ok = Math.abs(sys.surfaceFrame(body, x + j * step).slope) < 3 / DEG;
      if (ok) return x;
    }
    return a;
  }

  function dropTest(opts) {
    const f = new SB.Flight(sys, starter);
    f.stage(); f.stage();
    const ang = findFlat(pock, 1.0);
    const sf = sys.surfaceFrame(pock, ang);
    const g = f.geometry();
    const h = opts.height;
    const up = [Math.cos(ang), Math.sin(ang)];
    f.situation = 'flying';
    f.st.body = pock;
    f.st.rx = up[0] * (sf.R + g.bottomOffset + h); f.st.ry = up[1] * (sf.R + g.bottomOffset + h);
    const vd = opts.descent, vh = opts.horizontal || 0;
    f.st.vx = -up[0] * vd - up[1] * vh; f.st.vy = -up[1] * vd + up[0] * vh;
    f.heading = sf.normal + (opts.tiltDeg || 0) / DEG;
    f.setThrottle(0); f.setSas('stability');
    f.predDirty = true;
    P.fly(f, () => !!f.outcome, { maxSim: 600 });
    return f;
  }

  check('Unsafe touchdown registers as a crash; gentle upright touchdown lands', (d) => {
    const fast = dropTest({ height: 30, descent: 15 });
    const tilted = dropTest({ height: 5, descent: 2, tiltDeg: 30 });
    const slide = dropTest({ height: 5, descent: 2, horizontal: 8 });
    const gentle = dropTest({ height: 5, descent: 2 });
    const show = (n, f) => d(`${n}: ${f.outcome ? f.outcome.type : 'none'} — descent ${f.outcome.descent.toFixed(1)} m/s, horiz ${f.outcome.horizontal.toFixed(1)} m/s, tilt ${f.outcome.tilt.toFixed(0)}° ${f.outcome.reasons.length ? '(' + f.outcome.reasons.join('; ') + ')' : ''}`);
    show('15 m/s drop', fast); show('30° tilt', tilted); show('8 m/s sideways', slide); show('2 m/s upright', gentle);
    // warp into the ground: the limiter should bring warp down before impact
    const w = dropTest({ height: 3000, descent: 30 });
    d(`3 km fall at 30 m/s with max warp requested -> ${w.outcome.type} at ${w.outcome.descent.toFixed(1)} m/s`);
    return fast.outcome.type === 'crashed' && tilted.outcome.type === 'crashed' && slide.outcome.type === 'crashed' && gentle.outcome.type === 'landed';
  });

  check('Warp limiter drops to 1x before a terrain impact', (d) => {
    const f = new SB.Flight(sys, starter);
    f.stage(); f.stage();
    const ang = 2.0, sf = sys.surfaceFrame(pock, ang);
    f.situation = 'flying'; f.st.body = pock;
    const r = sf.R + 20000;
    f.st.rx = Math.cos(ang) * r; f.st.ry = Math.sin(ang) * r;
    f.st.vx = -Math.cos(ang) * 5; f.st.vy = -Math.sin(ang) * 5;
    f.heading = ang; f.setThrottle(0);
    let lastWarp = 0, maxWarp = 0;
    P.fly(f, () => { if (f.outcome) return true; f.setWarp(f.warpLevels().length - 1); maxWarp = Math.max(maxWarp, f.warpRate()); lastWarp = f.warpRate(); return false; }, { maxSim: 1e4 });
    d(`Max warp ${maxWarp}x during the fall, ${lastWarp}x on the final frame; outcome ${f.outcome && f.outcome.type} at ${f.outcome && f.outcome.descent.toFixed(1)} m/s`);
    return maxWarp >= 100 && lastWarp === 1 && f.outcome && f.outcome.type === 'crashed';
  });

  check('Atmospheric entry from orbit: warp is cut to physics warp at the atmosphere', (d) => {
    const f = new SB.Flight(sys, starter);
    f.stage(); f.stage();
    const r = planet.radius + 40000;
    f.situation = 'flying'; f.st.body = planet; f.st.rx = 0; f.st.ry = r;
    f.st.vx = Math.sqrt(planet.mu / r) * 0.93; f.st.vy = 0; f.setThrottle(0);
    let entryWarp = null, maxWarp = 0;
    P.fly(f, () => {
      if (f.inAtmosphere()) { entryWarp = f.warpRate(); return true; }
      f.setWarp(f.warpLevels().length - 1);
      maxWarp = Math.max(maxWarp, f.warpRate());
      return false;
    }, { maxSim: 1e5 });
    d(`Max warp ${maxWarp}x on the way down; at atmospheric interface ${entryWarp}x (physics limit ${SB.CONFIG.sim.maxPhysicsWarp}x)`);
    return entryWarp !== null && entryWarp <= SB.CONFIG.sim.maxPhysicsWarp && maxWarp >= 100;
  });

  root.TEST_RESULTS = { results, shared: { ascentLog: shared.ascentLog, ascentParams: shared.ascentParams, analysis: shared.analysis && { liftoffTwr: shared.analysis.liftoffTwr, stages: shared.analysis.stages.map((s) => ({ n: s.number, dvVac: s.dvVac, dvAsl: s.dvAsl, twr: s.twrAsl })) } } };
})(typeof window !== 'undefined' ? window : globalThis);
