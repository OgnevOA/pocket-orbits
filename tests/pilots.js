/*
 * Scripted "pilots" for automated checks. They only use controls a player has:
 * throttle, rotate left/right, SAS (stability / prograde / retrograde), staging and time warp.
 * Frames are fed through Flight.update(), exactly like the game loop.
 */
(function (root) {
  'use strict';
  const SB = root.SB;
  const DEG = 180 / Math.PI;
  const wrap = (a) => SB.Orbit.wrapPi(a);

  /** Tilt from local vertical in degrees; positive = leaning right (clockwise, "east"). */
  function tiltRight(f) {
    const up = Math.atan2(f.st.ry, f.st.rx);
    return -wrap(f.heading - up) * DEG;
  }

  function warpIndexFor(f, rate) {
    const L = f.warpLevels();
    let i = 0;
    while (i + 1 < L.length && L[i + 1] <= rate) i++;
    return i;
  }

  /** Runs frames at `fps` until `step(f)` returns true, the craft crashes, or maxSim seconds pass. */
  function fly(f, step, opts) {
    opts = opts || {};
    const fps = opts.fps || 60, dt = 1 / fps;
    const t0 = f.st.t;
    const maxSim = opts.maxSim || 1e6;
    const maxFrames = opts.maxFrames || 2e6;
    for (let i = 0; i < maxFrames; i++) {
      if (step(f) === true) return { ok: true, frames: i, simTime: f.st.t - t0 };
      if (f.situation === 'crashed') return { ok: false, crashed: true, frames: i, simTime: f.st.t - t0 };
      if (f.st.t - t0 > maxSim) return { ok: false, timeout: true, frames: i, simTime: f.st.t - t0 };
      f.update(dt);
    }
    return { ok: false, timeout: true, frames: maxFrames, simTime: f.st.t - t0 };
  }

  /**
   * Ascent: full throttle, launch, at turnAlt lean right to turnDeg, then hold prograde.
   * Cut at the target apoapsis, coast (warping above the atmosphere), circularise at apoapsis.
   */
  function ascend(f, p, log) {
    const R = f.body.radius;
    let phase = 'launch';
    const note = (text) => log.push({ t: +(f.missionTime()).toFixed(1), alt: Math.round(f.altitude()), text });
    const stageIfDry = () => {
      const fuel = f.craft.activeStageFuel();
      if (fuel.active && fuel.fuel <= 1e-6 && f.craft.nextStage < f.craft.stages.length) {
        f.stage();
        note(`Stage ${f.craft.nextStage}: active stage empty, staged (TWR now ${f.twr().toFixed(2)})`);
      }
    };
    const res = fly(f, () => {
      const el = f.orbit();
      switch (phase) {
        case 'launch':
          f.setThrottle(1);
          f.stage();
          note('Throttle 100%, Space: stage 1 ignites');
          phase = 'climb';
          break;
        case 'climb':
          if (f.altitude() > p.turnAlt) { phase = 'pitch'; note(`Altitude ${p.turnAlt} m: start leaning right (hold D)`); }
          break;
        case 'pitch':
          f.rotInput = -1;
          if (tiltRight(f) >= p.turnDeg) {
            f.rotInput = 0;
            f.setSas('stability');
            note(`Leaning ${p.turnDeg}° right: release D (stability holds the tilt)`);
            phase = 'settle';
          }
          break;
        case 'settle': {
          // Wait until the prograde marker has swung over to the nose, then hold prograde.
          const vAng = Math.atan2(f.st.vy, f.st.vx);
          if (Math.abs(wrap(vAng - f.heading)) * DEG < 1.5) {
            f.setSas('prograde');
            note(`Prograde marker reached the nose (tilt ${tiltRight(f).toFixed(0)}°): press P (prograde hold) for the gravity turn`);
            phase = 'turn';
          }
          stageIfDry();
          break;
        }
        case 'turn':
          stageIfDry();
          if (el.ra - R >= p.targetAp) {
            f.setThrottle(0);
            note(`Apoapsis ${(p.targetAp / 1000).toFixed(0)} km: cut throttle (X)`);
            phase = 'coast';
          }
          break;
        case 'coast': {
          if (f.inAtmosphere() && el.ra - R < p.targetAp - 500) {
            f.setThrottle(0.3); // top up apoapsis lost to drag
            stageIfDry();
            break;
          }
          if (f.throttle > 0 && el.ra - R >= p.targetAp) f.setThrottle(0);
          const tAp = el.timeToAp;
          // Start the burn about half its duration before apoapsis (what the HUD Ap timer is for).
          const vAp = Math.abs(el.h) / el.ra, vCirc = Math.sqrt(f.body.mu / el.ra);
          const thrust = f.craft.thrustState(1, 0).thrust || 1;
          const lead = Math.max(3, (0.5 * (vCirc - vAp) * f.craft.mass()) / thrust);
          if (!f.inAtmosphere() && tAp > lead + 20) f.setWarp(warpIndexFor(f, 50));
          else f.setWarp(0);
          if (!f.inAtmosphere() && tAp < lead) {
            f.setWarp(0);
            f.setSas('prograde');
            f.setThrottle(1);
            note(`${tAp.toFixed(0)} s before apoapsis (needs ~${(vCirc - vAp).toFixed(0)} m/s): prograde hold, full throttle to circularise`);
            phase = 'circ';
          }
          break;
        }
        case 'circ':
          stageIfDry();
          if (el.rp - R >= p.targetPe) {
            f.setThrottle(0);
            note(`Periapsis ${(el.rp - R) / 1000 | 0} km: cut throttle. Orbit reached.`);
            return true;
          }
          if (f.craft.activeStageFuel().fuel <= 0 && f.craft.nextStage >= f.craft.stages.length) return true;
          break;
      }
      return false;
    }, { maxSim: 3000 });
    return res;
  }

  /** Burns along the current SAS hold at `throttle` until done() is true. Aligns first. */
  function burn(f, mode, throttle, done, maxSim) {
    f.setSas(mode);
    let aligned = false;
    return fly(f, () => {
      f.setWarp(0);
      const tgt = f.holdTarget();
      if (!aligned) {
        f.setThrottle(0);
        if (tgt === null || Math.abs(wrap(tgt - f.heading)) < 0.02) aligned = true;
        return false;
      }
      if (done(f)) { f.setThrottle(0); return true; }
      const fuel = f.craft.activeStageFuel();
      if (fuel.active && fuel.fuel <= 1e-6 && f.craft.nextStage < f.craft.stages.length) f.stage();
      f.setThrottle(typeof throttle === 'function' ? throttle(f) : throttle);
      return false;
    }, { maxSim: maxSim || 2000 });
  }

  /** Coast (warping where allowed) until cond(f) is true. */
  function coastUntil(f, cond, rate, maxSim) {
    f.setThrottle(0);
    return fly(f, () => {
      if (cond(f)) { f.setWarp(0); return true; }
      f.setWarp(warpIndexFor(f, typeof rate === 'function' ? rate(f) : rate));
      return false;
    }, { maxSim: maxSim || 1e6 });
  }

  function encounterWith(f, m) {
    const p = f.prediction;
    if (!p) return null;
    return p.events.find((e) => e.type === 'soi' && e.to === m) || null;
  }

  function predictedPeAlt(f, m) {
    const p = f.prediction;
    if (!p) return null;
    const seg = p.segments.find((s) => s.body === m);
    if (!seg) return null;
    const pe = seg.marks.find((k) => k.type === 'pe');
    if (pe) return pe.alt;
    const imp = seg.marks.find((k) => k.type === 'impact');
    return imp ? -1 : seg.el.rp - m.radius;
  }

  /**
   * Powered descent: retrograde hold, start braking at the last safe moment, then descend
   * slowly, switching to stability and standing upright for touchdown.
   */
  function land(f, log) {
    const note = (text) => log.push({ t: Math.round(f.st.t), alt: Math.round(f.radarAltitude()), text });
    let phase = 'fall';
    return fly(f, () => {
      const g = f.localGravity();
      const ts = f.craft.thrustState(1, 0);
      const aMax = ts.thrust / f.craft.mass();
      const h = f.radarAltitude();
      const vs = f.verticalSpeed();
      const hs = f.horizontalSpeed();
      const v = f.speed();
      if (f.situation === 'landed') { f.setThrottle(0); note('Touchdown'); return true; }
      switch (phase) {
        case 'fall': {
          f.setSas('retrograde');
          const stop = (v * v) / (2 * Math.max(0.1, aMax * 0.8 - g));
          f.setWarp(h > stop * 3 + 3000 ? warpIndexFor(f, 50) : 0);
          if (h < stop * 1.25 + 120) { phase = 'brake'; note(`Suicide burn start: speed ${v.toFixed(0)} m/s`); }
          break;
        }
        case 'brake': {
          f.setWarp(0);
          f.setSas('retrograde');
          // fly the descent rate down to a target that shrinks with height
          const target = -Math.max(1.5, Math.min(40, h * 0.12));
          const err = target - vs;
          let thr = (g + 1.5 * err) / Math.max(0.1, aMax);
          // keep burning retrograde until the sideways drift is gone, not just the descent
          if (Math.abs(hs) > 0.5) thr = Math.max(thr, Math.min(1, Math.abs(hs) / Math.max(0.1, aMax * 1.5)));
          f.setThrottle(Math.min(1, Math.max(0, thr)));
          if (Math.abs(hs) < 0.6 && h < 60) { phase = 'final'; note('Horizontal speed killed: stability hold, stand upright'); }
          break;
        }
        case 'final': {
          f.setSas('stability');
          const up = Math.atan2(f.st.ry, f.st.rx);
          const err = wrap(up - f.heading);
          f.rotInput = Math.abs(err) > 0.01 ? Math.sign(err) * Math.min(1, Math.abs(err) * 3 + 0.05) : 0;
          if (Math.abs(f.omega) > 0.2) f.rotInput = -Math.sign(f.omega);
          const target = -Math.max(1.2, Math.min(5, h * 0.1));
          const errV = target - vs;
          f.setThrottle(Math.min(1, Math.max(0, (g + 2 * errV) / Math.max(0.1, aMax))));
          break;
        }
      }
      return false;
    }, { maxSim: 20000 });
  }

  /** Waits (warping) for the ideal phase angle, then burns prograde until the predicted moon periapsis is 3–9 km. */
  function transfer(f, m) {
    f.setTarget(m);
    const info0 = f.transferInfo(m);
    const tIdeal = f.st.t + info0.wait;
    coastUntil(f, (ff) => ff.st.t >= tIdeal - 8, (ff) => (tIdeal - ff.st.t > 200 ? 50 : tIdeal - ff.st.t > 40 ? 10 : 1));
    const info1 = f.transferInfo(m);
    const v0 = f.speed();
    const r = burn(f, 'prograde', (ff) => (encounterWith(ff, m) ? 0.1 : 1), (ff) => {
      ff.maybePredict(true);
      const pe = predictedPeAlt(ff, m);
      return pe !== null && pe < 9000 && pe > 3000;
    }, 400);
    return { ok: r.ok && !!encounterWith(f, m), info0, info1, dv: f.speed() - v0, pe: predictedPeAlt(f, m), entry: encounterWith(f, m) };
  }

  /** Holds maximum warp (like a player holding "."), until the sphere of influence changes. */
  function warpToSoi(f) {
    let warpAtEntry = null, maxWarp = 0;
    const n0 = f.soiLog.length;
    const res = fly(f, () => {
      if (f.soiLog.length > n0) return true;
      f.setWarp(f.warpLevels().length - 1);
      maxWarp = Math.max(maxWarp, f.warpRate());
      warpAtEntry = f.warpRate();
      return false;
    }, { maxSim: 2e5 });
    return { ok: res.ok, ev: f.soiLog[n0] || null, warpAtEntry, maxWarp };
  }

  /** Retrograde burn shortly before periapsis until the orbit closes well inside the SOI. */
  function capture(f, m) {
    coastUntil(f, (ff) => ff.orbit().timeToPe < 40, (ff) => (ff.orbit().timeToPe > 400 ? 50 : 4));
    // Pock's SOI ends only ~21.7 km above its surface, so close the orbit well inside it.
    const r = burn(f, 'retrograde', 1, (ff) => { const el = ff.orbit(); return el.e < 1 && el.ra < m.soi * 0.8; }, 400);
    return { ok: r.ok && f.situationText().startsWith('Orbiting ' + m.name) };
  }

  /** Retrograde burn until the periapsis is 3 km below the datum, i.e. the path meets the ground. */
  function deorbit(f, m) { return burn(f, 'retrograde', 1, (ff) => ff.orbit().rp - m.radius < -3000, 300); }

  /** Nudges a node component step by step (like clicking the panel's ± buttons) until ok(info). */
  function tuneNode(f, node, comp, step, ok, maxSteps) {
    const pl = f.planner;
    for (let i = 0; i <= (maxSteps || 400); i++) {
      pl.compute();
      const inf = pl.info(node);
      if (inf && inf.valid && ok(inf)) return { ok: true, steps: i, info: inf };
      pl.nudge(node, comp, step);
    }
    pl.compute();
    return { ok: false, steps: maxSteps };
  }

  /** Periapsis altitude at moon m on a planned leg (before the next node); -1 = impact; null = no encounter. */
  function layerPeAt(layer, m) {
    if (!layer) return null;
    for (const seg of layer.segments) {
      if (seg.body !== m || seg.t0 > layer.drawUntil) continue;
      const pe = seg.marks.find((k) => k.type === 'pe');
      if (pe) return pe.alt;
      if (seg.marks.some((k) => k.type === 'impact')) return -1;
    }
    return null;
  }

  /**
   * Flies the next maneuver node the way the panel suggests: "Warp to burn" (holding max warp),
   * hold the burn direction (V), full throttle when the burn starts, ease off for the last m/s,
   * cut near zero. The planner removes the node itself once the burn is done.
   */
  function executeNode(f) {
    const pl = f.planner;
    const node = pl.first();
    if (!node) return { ok: false, reason: 'no node' };
    let phase = 'warp', maxWarp = 0, warpAt10 = null, minRem = Infinity, startT = null, rem = null;
    const res = fly(f, () => {
      if (!pl.nodes.includes(node)) return true;
      const bs = pl.nextBurnStart();
      switch (phase) {
        case 'warp':
          f.setThrottle(0);
          if (bs !== null && f.st.t >= bs - 10) { warpAt10 = f.warpRate(); f.setWarp(0); f.setSas('maneuver'); phase = 'align'; break; }
          f.setWarp(f.warpLevels().length - 1);
          maxWarp = Math.max(maxWarp, f.warpRate());
          break;
        case 'align':
          f.setWarp(0);
          if (bs === null || f.st.t >= bs) { phase = 'burn'; startT = f.st.t; }
          break;
        case 'burn': {
          pl.compute();
          const inf = pl.info(node);
          if (!inf || !inf.valid) { f.setThrottle(0); return true; }
          rem = inf.total;
          minRem = Math.min(minRem, rem);
          const fuel = f.craft.activeStageFuel();
          if (fuel.active && fuel.fuel <= 1e-6 && f.craft.nextStage < f.craft.stages.length) f.stage();
          if (rem < 0.3 || rem > minRem + 1) { f.setThrottle(0); phase = 'done'; break; }
          const aMax = f.craft.thrustState(1, f.pressureRatio()).thrust / f.craft.mass();
          const misalign = Math.abs(wrap(Math.atan2(inf.dv[1], inf.dv[0]) - f.heading));
          f.setThrottle(misalign > 0.1 ? 0 : Math.max(0.02, Math.min(1, rem / Math.max(0.1, aMax * 1.5))));
          break;
        }
        case 'done':
          f.setThrottle(0);
          pl.compute(); // the planner sees the finished burn and removes the node
          return true;
      }
      return false;
    }, { maxSim: 5e5 });
    return { ok: res.ok, maxWarp, warpAt10, remaining: rem, removed: !pl.nodes.includes(node), burnTime: startT !== null ? f.st.t - startT : 0 };
  }

  root.Pilots = { tiltRight, warpIndexFor, fly, ascend, burn, coastUntil, encounterWith, predictedPeAlt, land, transfer, warpToSoi, capture, deorbit, tuneNode, layerPeAt, executeNode };
})(typeof window !== 'undefined' ? window : globalThis);
