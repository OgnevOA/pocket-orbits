/*
 * Maneuver nodes: planned impulsive burns at a future time, chained in time order.
 *
 * Each node is {t, pro, rad}: delta-v along prograde and radial-out of the trajectory at time t
 * (the game is 2D, so there is no normal component). The trajectory after every node is predicted
 * with SB.predict, i.e. with exactly the same gravity, SOI and terrain rules as flight.
 *
 * The next node keeps its *planned* post-burn velocity fixed while you fly: as you burn toward it,
 * its prograde/radial components shrink to the delta-v that is still missing, and the planned
 * orbit stays where it is. Later nodes keep their components.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  let idSeq = 0;

  /** Prograde and radial-out unit vectors of a state (radial-out is perpendicular to prograde). */
  function axes(st) {
    const v = Math.hypot(st.vx, st.vy) || 1;
    const px = st.vx / v, py = st.vy / v;
    let nx = -py, ny = px;
    if (nx * st.rx + ny * st.ry < 0) { nx = -nx; ny = -ny; }
    return { px, py, nx, ny };
  }

  /**
   * Coasting state at time t, starting from st0, with the same rules as flight and prediction.
   * Going backwards (a node that is already in the past) uses the current conic only.
   * Returns null if the craft hits the ground first. soiT records when the frame was entered.
   */
  function stateAt(sys, st0, t, clearance) {
    const s = { body: st0.body, t: st0.t, rx: st0.rx, ry: st0.ry, vx: st0.vx, vy: st0.vy, soiT: st0.soiT !== undefined ? st0.soiT : -Infinity };
    if (t >= s.t) {
      const ev = SB.Coast.advance(sys, s, t - s.t, { stopAtSoi: false, stopAtAtmo: false, clearance, maxIter: 60000, onEvent: (e) => { s.soiT = e.t; } });
      if (ev) return null;
    } else {
      const o = SB.Orbit.propagate(s.body.mu, s.rx, s.ry, s.vx, s.vy, t - s.t);
      s.rx = o[0]; s.ry = o[1]; s.vx = o[2]; s.vy = o[3]; s.t = t;
    }
    return s;
  }

  class Planner {
    constructor(flight) {
      this.f = flight;
      this.nodes = [];
      this.selected = null;
      this.plan = null;
      this.dirty = true;
      this.lastReal = -1e9;
    }

    get count() { return this.nodes.length; }
    first() { return this.nodes[0] || null; }
    info(node) { return this.plan ? this.plan.infos.find((i) => i.node === node) || null : null; }
    indexOf(node) { return this.nodes.indexOf(node); }

    touch(node) {
      if (node === this.nodes[0]) { node.vPlanG = null; node.initial = null; node.burned = false; node.doneMsg = false; }
      this.dirty = true;
    }

    add(t, pro, rad) {
      const now = this.f.st.t;
      t = Math.max(t, now + 1);
      const node = { id: ++idSeq, t, pro: pro || 0, rad: rad || 0, vPlanG: null, initial: null, burned: false, doneMsg: false };
      this.nodes.push(node);
      this.nodes.sort((a, b) => a.t - b.t);
      // a node inserted before the current first one takes over the "active" role
      for (const n of this.nodes) if (n !== this.nodes[0]) n.vPlanG = null;
      this.selected = node;
      this.touch(node);
      this.compute();
      return node;
    }

    remove(node) {
      const i = this.nodes.indexOf(node);
      if (i < 0) return;
      this.nodes.splice(i, 1);
      if (this.nodes[0]) this.touch(this.nodes[0]);
      if (this.selected === node) this.selected = this.nodes[Math.min(i, this.nodes.length - 1)] || null;
      this.dirty = true;
      this.compute();
    }

    clear() { this.nodes = []; this.selected = null; this.plan = null; this.dirty = false; }

    setComps(node, pro, rad) {
      if (!isFinite(pro) || !isFinite(rad)) return;
      node.pro = Math.max(-5000, Math.min(5000, pro));
      node.rad = Math.max(-5000, Math.min(5000, rad));
      this.touch(node);
    }

    nudge(node, comp, d) {
      this.setComps(node, node.pro + (comp === 'pro' ? d : 0), node.rad + (comp === 'rad' ? d : 0));
    }

    /** Moves a node in time, keeping it between its neighbours and in the future. */
    setTime(node, t) {
      const i = this.nodes.indexOf(node);
      const lo = Math.max(this.f.st.t + 1, i > 0 ? this.nodes[i - 1].t + 1 : -Infinity);
      const hi = i < this.nodes.length - 1 ? this.nodes[i + 1].t - 1 : Infinity;
      node.t = Math.min(hi, Math.max(lo, t));
      this.touch(node);
    }

    shiftTime(node, dt) { this.setTime(node, node.t + dt); }

    /** Period of the trajectory the node sits on (for "± one orbit"), or null if not closed. */
    orbitPeriod(node) {
      const inf = this.info(node);
      if (!inf || !inf.valid) return null;
      const el = inf.preEl;
      return el.e < 1 && (!inf.pre.body.parent || el.ra < inf.pre.body.soi) ? el.period : null;
    }

    /** Burn estimate for a delta-v with the engines that would fire (stages ahead if needed). */
    burnEstimate(dv) {
      const f = this.f;
      const src = f.craft;
      const clone = new SB.FlightCraft(src.parts.map((p) => ({ uid: p.uid, type: p.type, fuel: p.fuel })), src.stages);
      clone.nextStage = src.nextStage;
      clone.active = new Set(src.active);
      const pr = f.pressureRatio();
      let stages = 0;
      let time = 0, remaining = dv;
      for (let guard = 0; guard < 8 && remaining > 1e-6; guard++) {
        const ts = clone.thrustState(1, pr);
        if (ts.thrust > 0 && ts.mdot > 0) {
          const ve = ts.thrust / ts.mdot;
          const m = clone.mass();
          let fuel = 0;
          for (const p of ts.per) fuel += p.fuel;
          const stageDv = ve * Math.log(m / Math.max(1e-6, m - fuel));
          const use = Math.min(remaining, stageDv);
          const burned = m * (1 - Math.exp(-use / ve));
          time += burned / ts.mdot;
          remaining -= use;
          if (remaining <= 1e-6) break;
          clone.burn(burned / ts.mdot * (1 + 1e-9), 1, pr);
        }
        if (clone.nextStage >= clone.stages.length) break;
        clone.activateNextStage();
        stages++;
      }
      return { time, short: remaining > 0.5 ? remaining : 0, stages };
    }

    /** Remaining burn vector of the next node (global frame), or null. */
    burnVector() {
      const inf = this.plan && this.plan.infos[0];
      return inf && inf.valid ? inf.dv : null;
    }

    /** Recomputes the node chain and the predicted trajectory after each node. */
    compute() {
      const f = this.f, sys = f.sys;
      this.dirty = false;
      this.lastReal = f.realClock;
      if (!this.nodes.length || f.isLanded() || f.situation === 'crashed') { this.plan = null; return; }
      const clearance = f.contactClearance();
      let base = { body: f.st.body, t: f.st.t, rx: f.st.rx, ry: f.st.ry, vx: f.st.vx, vy: f.st.vy, soiT: -Infinity };
      const infos = [];
      for (let i = 0; i < this.nodes.length; i++) {
        const n = this.nodes[i];
        const pre = stateAt(sys, base, n.t, clearance);
        if (!pre) { infos.push({ node: n, valid: false }); break; }
        const ax = axes(pre);
        const bv = sys.bodyVel(pre.body, n.t);
        const vG = [pre.vx + bv[0], pre.vy + bv[1]];
        if (i === 0) {
          if (n.vPlanG) {
            const dx = n.vPlanG[0] - vG[0], dy = n.vPlanG[1] - vG[1];
            n.pro = dx * ax.px + dy * ax.py;
            n.rad = dx * ax.nx + dy * ax.ny;
          } else {
            n.vPlanG = [vG[0] + n.pro * ax.px + n.rad * ax.nx, vG[1] + n.pro * ax.py + n.rad * ax.ny];
          }
        }
        const dv = [n.pro * ax.px + n.rad * ax.nx, n.pro * ax.py + n.rad * ax.ny];
        const post = Object.assign({}, pre, { vx: pre.vx + dv[0], vy: pre.vy + dv[1] });
        const total = Math.hypot(dv[0], dv[1]);
        infos.push({
          node: n, valid: true, pre, post, ax, dv, total,
          preEl: SB.Orbit.elements(pre.body.mu, pre.rx, pre.ry, pre.vx, pre.vy),
          postEl: SB.Orbit.elements(post.body.mu, post.rx, post.ry, post.vx, post.vy),
        });
        base = post;
      }
      const layers = [];
      for (let i = 0; i < infos.length && infos[i].valid; i++) {
        const next = this.nodes[i + 1];
        // Each leg is predicted over its full horizon (so the next node can be dragged later),
        // but only drawn up to the next node.
        const L = SB.predict(sys, infos[i].post, {
          clearance, target: f.target, maxSegments: SB.CONFIG.sim.predictionSegments, refT: infos[i].post.soiT,
        });
        L.drawUntil = next ? next.t : Infinity;
        layers.push(L);
        infos[i].layer = L;
      }
      for (const inf of infos) if (inf.valid) inf.burn = this.burnEstimate(inf.total);
      this.plan = { infos, layers, t: f.st.t };
      this.trackCompletion();
    }

    /** Detects a finished burn on the next node; the node is removed once the engine is cut. */
    trackCompletion() {
      const f = this.f;
      const inf = this.plan && this.plan.infos[0];
      if (!inf || !inf.valid) return;
      const n = inf.node;
      if (n.initial === null) n.initial = inf.total;
      const thrusting = f.isThrusting();
      if (thrusting && inf.total < n.initial - 0.5) n.burned = true;
      if (thrusting && n.burned && inf.total < 0.3 && !n.doneMsg) {
        n.doneMsg = true;
        f.msg('Maneuver complete: cut throttle (X)', 'good', 'node-done');
      }
      if (!thrusting && n.burned && inf.total < Math.max(1, 0.02 * n.initial)) {
        f.msg(`Maneuver complete (${inf.total.toFixed(1)} m/s left) · node removed`, 'good', 'node-done');
        this.remove(n);
      }
    }

    /** Recompute when edited, quickly while the engines fire, otherwise a few times a second. */
    update() {
      const f = this.f;
      if (!this.nodes.length) { this.plan = null; return; }
      const interval = f.isThrusting() ? 0.1 : 0.5;
      if (this.dirty || f.realClock - this.lastReal >= interval) this.compute();
    }

    /** Next burn start (half the burn before the node), for warp limiting. */
    nextBurnStart() {
      const inf = this.plan && this.plan.infos[0];
      if (!inf || !inf.valid) return null;
      return inf.node.t - (inf.burn ? inf.burn.time / 2 : 0);
    }

    /** Creates a Hohmann transfer node toward moon m from the current near-circular orbit. */
    planTransfer(m) {
      const info = this.f.transferInfo(m);
      if (!info) return null;
      // Too close to the ideal moment to start the burn on time? Use the next window.
      const wait = info.wait < 60 ? info.wait + info.synodic : info.wait;
      const node = this.add(this.f.st.t + wait, info.dv, 0);
      this.compute();
      return node;
    }
  }

  SB.Planner = Planner;
  SB.Maneuver = { axes, stateAt };
})(typeof window !== 'undefined' ? window : globalThis);
