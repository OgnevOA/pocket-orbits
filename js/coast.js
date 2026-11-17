/*
 * Patched-conic coasting with event detection, shared by flight and by trajectory prediction.
 *
 * advance() moves a state {body, t, rx, ry, vx, vy} along its Kepler conic. Step sizes come from
 * rigorous speed bounds (energy conservation), so sphere-of-influence, atmosphere and terrain
 * crossings cannot be stepped over at any time-warp rate; crossings are then located by bisection.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const MIN_STEP = 0.2; // s; smallest step while closing on an event boundary
  const ATMO = { kind: 'atmo' };
  const IMPACT = { kind: 'impact' };
  const EXIT = { kind: 'exit' };

  function surfaceGap(sys, b, x, y, clearance) {
    return Math.hypot(x, y) - sys.surfaceRadius(b, Math.atan2(y, x)) - clearance;
  }

  function evalCheck(sys, c, b, x, y, t, clearance) {
    if (c === ATMO) return Math.hypot(x, y) - (b.radius + b.atmosphere.height);
    if (c === IMPACT) return surfaceGap(sys, b, x, y, clearance);
    if (c === EXIT) return b.soi - Math.hypot(x, y);
    const mp = sys.bodyPos(c, t);
    return Math.hypot(x - mp[0], y - mp[1]) - c.soi;
  }

  /** Re-expresses the state relative to moon m, preserving global position and velocity. */
  function enterSoi(sys, st, m) {
    const p = sys.bodyPos(m, st.t), v = sys.bodyVel(m, st.t);
    st.rx -= p[0]; st.ry -= p[1]; st.vx -= v[0]; st.vy -= v[1];
    st.body = m;
  }

  /** Re-expresses the state relative to the parent of the current body. */
  function exitSoi(sys, st) {
    const b = st.body;
    const p = sys.bodyPos(b, st.t), v = sys.bodyVel(b, st.t);
    st.rx += p[0]; st.ry += p[1]; st.vx += v[0]; st.vy += v[1];
    st.body = b.parent;
  }

  function globalState(sys, st) {
    const p = sys.bodyPos(st.body, st.t), v = sys.bodyVel(st.body, st.t);
    return [st.rx + p[0], st.ry + p[1], st.vx + v[0], st.vy + v[1]];
  }

  /**
   * Coast for up to dtTotal seconds. Mutates st. Returns null, or an event:
   *   {type:'soi', from, to, t, before, after}  (state already converted to the new frame)
   *   {type:'atmo', t, body}  (stopped at atmosphere top; only when opts.stopAtAtmo)
   *   {type:'impact', t, body} (stopped at terrain contact, using opts.clearance)
   */
  function advance(sys, st, dtTotal, opts) {
    opts = opts || {};
    const clearance = opts.clearance || 0;
    const maxIter = opts.maxIter || 200000;
    const out = [0, 0, 0, 0], tmp = [0, 0, 0, 0];
    let remaining = dtTotal;
    let iter = 0;
    while (remaining > 1e-9) {
      if (++iter > maxIter) return { type: 'limit', t: st.t, body: st.body };
      const b = st.body, mu = b.mu;
      const el = SB.Orbit.elements(mu, st.rx, st.ry, st.vx, st.vy);
      const r = el.r;
      const rLow = Math.min(r, Math.max(isFinite(el.rp) ? el.rp : 0, b.radius + b.terrain.minH));
      const vmax = Math.sqrt(el.v * el.v + 2 * mu * Math.max(0, 1 / rLow - 1 / r)) + 1e-6;
      let h = remaining;
      const checks = [];

      // Radial events: atmosphere entry, else terrain contact.
      const atmoTop = b.atmosphere ? b.radius + b.atmosphere.height : -Infinity;
      const terrainTop = b.radius + b.terrain.maxH + clearance;
      if (opts.stopAtAtmo && b.atmosphere && r > atmoTop) {
        if (el.rp < atmoTop) {
          h = Math.min(h, Math.max((r - atmoTop) / vmax, MIN_STEP));
          checks.push(ATMO);
        }
      } else if (el.rp < terrainTop) {
        const gap = r - terrainTop;
        if (gap > 0) h = Math.min(h, Math.max(gap / vmax, MIN_STEP));
        else h = Math.min(h, Math.max(surfaceGap(sys, b, st.rx, st.ry, clearance) / (2 * vmax), 0.05));
        checks.push(IMPACT);
      }

      // Sphere-of-influence events.
      if (b.parent) {
        if (!(el.e < 1 && el.ra < b.soi)) {
          h = Math.min(h, Math.max((b.soi - r) / vmax, MIN_STEP));
          checks.push(EXIT);
        }
      } else {
        for (const m of sys.moons) {
          if (el.ra < m.orbitRadius - m.soi || el.rp > m.orbitRadius + m.soi) continue;
          const mp = sys.bodyPos(m, st.t);
          const gap = Math.hypot(st.rx - mp[0], st.ry - mp[1]) - m.soi;
          h = Math.min(h, Math.max(gap / (vmax + m.speed), MIN_STEP));
          checks.push(m);
        }
      }

      SB.Orbit.propagate(mu, st.rx, st.ry, st.vx, st.vy, h, out);
      const t0 = st.t;
      let best = null;
      for (const c of checks) {
        if (!(evalCheck(sys, c, b, out[0], out[1], t0 + h, clearance) < 0)) continue;
        if (evalCheck(sys, c, b, st.rx, st.ry, t0, clearance) < 0) continue; // started past it
        let lo = 0, hi = h;
        for (let k = 0; k < 64 && hi - lo > 1e-4; k++) {
          const mid = 0.5 * (lo + hi);
          SB.Orbit.propagate(mu, st.rx, st.ry, st.vx, st.vy, mid, tmp);
          if (evalCheck(sys, c, b, tmp[0], tmp[1], t0 + mid, clearance) < 0) hi = mid; else lo = mid;
        }
        if (!best || hi < best.dt) best = { c, dt: hi };
      }

      if (!best) {
        st.rx = out[0]; st.ry = out[1]; st.vx = out[2]; st.vy = out[3];
        st.t = t0 + h;
        remaining -= h;
        continue;
      }

      SB.Orbit.propagate(mu, st.rx, st.ry, st.vx, st.vy, best.dt, out);
      st.rx = out[0]; st.ry = out[1]; st.vx = out[2]; st.vy = out[3];
      st.t = t0 + best.dt;
      remaining -= best.dt;
      const c = best.c;
      if (c === ATMO) return { type: 'atmo', t: st.t, body: b };
      if (c === IMPACT) return { type: 'impact', t: st.t, body: b };
      const before = [st.rx, st.ry, st.vx, st.vy];
      if (c === EXIT) exitSoi(sys, st); else enterSoi(sys, st, c);
      const ev = { type: 'soi', from: b, to: st.body, t: st.t, before, after: [st.rx, st.ry, st.vx, st.vy] };
      if (opts.onEvent) opts.onEvent(ev);
      if (opts.stopAtSoi) return ev;
    }
    return null;
  }

  /** Points along a conic for drawing (body-relative), with their times. */
  function sampleSegment(mu, r0, v0, duration, t0, maxR) {
    const xs = [r0[0]], ys = [r0[1]], ts = [t0];
    if (!(duration > 0)) return { xs, ys, ts };
    let rx = r0[0], ry = r0[1], vx = v0[0], vy = v0[1], t = 0;
    const out = [0, 0, 0, 0];
    const minDt = duration / 2500, maxDt = duration / 16;
    for (let n = 0; t < duration && n < 3000; n++) {
      const r = Math.hypot(rx, ry), v = Math.hypot(vx, vy);
      let dt = (0.035 * r) / Math.max(v, 1e-6);
      dt = Math.min(Math.max(dt, minDt), maxDt, duration - t);
      if (dt <= 0) break;
      SB.Orbit.propagate(mu, rx, ry, vx, vy, dt, out);
      rx = out[0]; ry = out[1]; vx = out[2]; vy = out[3];
      t += dt;
      xs.push(rx); ys.push(ry); ts.push(t0 + t);
      if (maxR && Math.hypot(rx, ry) > maxR) break;
    }
    return { xs, ys, ts };
  }

  function closestApproach(sys, seg, tgt) {
    const P = seg.points;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < P.ts.length; i++) {
      const mp = sys.bodyPos(tgt, P.ts[i]);
      const d = Math.hypot(P.xs[i] - mp[0], P.ys[i] - mp[1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return null;
    // golden-section refinement around the best sample
    const tmp = [0, 0, 0, 0];
    const dist = (t) => {
      SB.Orbit.propagate(seg.body.mu, seg.r0[0], seg.r0[1], seg.v0[0], seg.v0[1], t - seg.t0, tmp);
      const mp = sys.bodyPos(tgt, t);
      return Math.hypot(tmp[0] - mp[0], tmp[1] - mp[1]);
    };
    let a = P.ts[Math.max(0, best - 1)], b = P.ts[Math.min(P.ts.length - 1, best + 1)];
    const g = 0.381966;
    let c = a + g * (b - a), d = b - g * (b - a), fc = dist(c), fd = dist(d);
    for (let k = 0; k < 40; k++) {
      if (fc < fd) { b = d; d = c; fd = fc; c = a + g * (b - a); fc = dist(c); }
      else { a = c; c = d; fc = fd; d = b - g * (b - a); fd = dist(d); }
    }
    const t = 0.5 * (a + b);
    const dd = dist(t);
    const craft = [tmp[0], tmp[1]];
    const best2 = dd < bestD ? { t, d: dd, craft } : { t: P.ts[best], d: bestD, craft: [P.xs[best], P.ys[best]] };
    return { t: best2.t, dist: best2.d, craftPos: best2.craft, moonPos: sys.bodyPos(tgt, best2.t), target: tgt };
  }

  /**
   * Predict the trajectory from a state using exactly the same coasting rules as flight.
   * Returns { segments, events, closest } where each segment is in its own body's frame.
   * opts.until stops the prediction at that time (used for the leg between two maneuver nodes).
   */
  function predict(sys, st0, opts) {
    opts = opts || {};
    const clearance = opts.clearance || 0;
    const maxSeg = opts.maxSegments || 4;
    const s = { body: st0.body, t: st0.t, rx: st0.rx, ry: st0.ry, vx: st0.vx, vy: st0.vy };
    const segments = [], events = [];
    const until = opts.until !== undefined ? opts.until : Infinity;
    for (let k = 0; k < maxSeg; k++) {
      const b = s.body;
      const el = SB.Orbit.elements(b.mu, s.rx, s.ry, s.vx, s.vy);
      let horizon;
      if (b.parent) horizon = el.e < 1 && el.ra < b.soi ? el.period : 3e5;
      else horizon = el.e < 1 ? Math.min(el.period, 8e5) : 3e5;
      // refT: when this body's frame was entered (moon arcs are drawn around the moon at that time)
      const refT = k === 0 ? (opts.refT !== undefined ? opts.refT : -Infinity) : s.t;
      const seg = { body: b, t0: s.t, r0: [s.rx, s.ry], v0: [s.vx, s.vy], el, marks: [], end: null, refT };
      const tEnd = Math.min(s.t + horizon, until);
      if (!(tEnd > s.t)) break;
      let ev = null;
      for (let g = 0; g < 4; g++) {
        ev = advance(sys, s, tEnd - s.t, { stopAtSoi: true, stopAtAtmo: true, clearance, maxIter: opts.maxIter || 40000 });
        if (ev && ev.type === 'atmo') {
          events.push(ev);
          seg.marks.push({ type: 'atmo', t: ev.t, pos: [s.rx, s.ry] });
          ev = null;
          continue;
        }
        break;
      }
      if (ev && ev.type === 'limit') ev = null;
      seg.t1 = ev ? ev.t : s.t;
      seg.end = ev;
      if (ev && ev.type === 'impact') seg.marks.push({ type: 'impact', t: ev.t, pos: [s.rx, s.ry] });
      const dur = seg.t1 - seg.t0;
      const aps = SB.Orbit.apsisPositions(el);
      if (el.e < 1) {
        if (el.timeToPe <= dur + 1e-6) seg.marks.push({ type: 'pe', t: seg.t0 + el.timeToPe, alt: el.rp - b.radius, pos: aps.pe });
        if (el.timeToAp <= dur + 1e-6 && (!b.parent || el.ra < b.soi)) seg.marks.push({ type: 'ap', t: seg.t0 + el.timeToAp, alt: el.ra - b.radius, pos: aps.ap });
      } else if (el.timeToPe > 0 && el.timeToPe <= dur) {
        seg.marks.push({ type: 'pe', t: seg.t0 + el.timeToPe, alt: el.rp - b.radius, pos: aps.pe });
      }
      segments.push(seg);
      if (!ev) break;
      events.push(ev);
      if (ev.type !== 'soi') break;
    }
    const maxR = opts.maxDrawRadius || 6e6;
    for (const seg of segments) seg.points = sampleSegment(seg.body.mu, seg.r0, seg.v0, seg.t1 - seg.t0, seg.t0, seg.body.parent ? 0 : maxR);

    let closest = null;
    if (opts.target) {
      const tgt = opts.target;
      const enc = segments.find((sg) => sg.body === tgt);
      if (enc) {
        const pe = enc.marks.find((m) => m.type === 'pe');
        let dmin = Infinity, tmin = enc.t0;
        enc.points.ts.forEach((t, i) => { const d = Math.hypot(enc.points.xs[i], enc.points.ys[i]); if (d < dmin) { dmin = d; tmin = t; } });
        closest = { encounter: true, target: tgt, t: pe ? pe.t : tmin, dist: pe ? pe.alt + tgt.radius : dmin };
      } else if (st0.body !== tgt) {
        const seg = segments.find((sg) => !sg.body.parent);
        if (seg) closest = closestApproach(sys, seg, tgt);
      }
    }
    return { t0: st0.t, segments, events, closest };
  }

  SB.Coast = { advance, enterSoi, exitSoi, globalState, sampleSegment, surfaceGap, closestApproach };
  SB.predict = predict;
})(typeof window !== 'undefined' ? window : globalThis);
