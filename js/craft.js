/*
 * Craft model: designs (vertical stacks + staging sequence), auto-staging,
 * fuel flow per stack section, decoupling, geometry, and delta-v analysis.
 *
 * Design format: { name, parts: [{uid, type}], stages: [[uid,...], ...], customStaging }
 *   parts are ordered top -> bottom; stages[0] is the first activation (launch).
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const CFG = () => SB.CONFIG;

  let uidSeq = 0;
  function newUid() {
    uidSeq += 1;
    return 'p' + Date.now().toString(36).slice(-4) + uidSeq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  function def(type) { return CFG().parts[type]; }

  function role(type) {
    const d = def(type);
    if (!d) return null;
    if (d.role) return d.role;
    return { command: 'pod', tank: 'tank', engine: 'engine' }[d.category] || 'structural';
  }

  const isStageable = (type) => role(type) === 'engine' || role(type) === 'decoupler';

  function partMass(p) {
    const d = p.def || def(p.type);
    return (d.mass || d.dryMass || 0) + (p.fuel !== undefined ? p.fuel : d.fuel || 0);
  }

  /** Default staging: bottom engines first, then each decoupler (moving up) with the engines above it. */
  function autoStage(parts) {
    const podIdx = Math.max(0, parts.findIndex((p) => role(p.type) === 'pod'));
    const steps = [];
    let cur = [];
    for (let i = parts.length - 1; i >= podIdx; i--) {
      const r = role(parts[i].type);
      if (r === 'engine') cur.push(parts[i].uid);
      else if (r === 'decoupler') { steps.push(cur); cur = [parts[i].uid]; }
    }
    steps.push(cur);
    // Anything stacked above the pod fires last.
    const above = [];
    for (let i = 0; i < podIdx; i++) if (isStageable(parts[i].type)) above.push(parts[i].uid);
    if (above.length) steps.push(above);
    return steps
      .map((s) => s.slice().sort((a, b) => (role(typeOf(parts, a)) === 'decoupler' ? -1 : 0) - (role(typeOf(parts, b)) === 'decoupler' ? -1 : 0)))
      .filter((s) => s.length);
  }

  function typeOf(parts, uid) {
    const p = parts.find((q) => q.uid === uid);
    return p ? p.type : null;
  }

  /** Keep a customised staging valid after the stack changed. */
  function reconcileStages(parts, stages, custom) {
    if (!custom) return autoStage(parts);
    const valid = new Set(parts.filter((p) => isStageable(p.type)).map((p) => p.uid));
    const seen = new Set();
    let out = (stages || []).map((s) => s.filter((uid) => valid.has(uid) && !seen.has(uid) && (seen.add(uid), true)));
    const auto = autoStage(parts);
    auto.forEach((step, i) => {
      step.forEach((uid) => {
        if (seen.has(uid)) return;
        while (out.length <= i) out.push([]);
        out[i].push(uid);
        seen.add(uid);
      });
    });
    out = out.filter((s) => s.length);
    return out;
  }

  function makeDesign(name, types) {
    const parts = types.map((t) => ({ uid: newUid(), type: t }));
    return { name, parts, stages: autoStage(parts), customStaging: false };
  }

  function cloneDesign(d) { return JSON.parse(JSON.stringify(d)); }

  /** Validates/repairs a design loaded from storage. Returns null if unusable. */
  function sanitizeDesign(d) {
    if (!d || !Array.isArray(d.parts)) return null;
    const parts = d.parts.filter((p) => p && def(p.type)).map((p) => ({ uid: String(p.uid || newUid()), type: p.type }));
    const seen = new Set();
    parts.forEach((p) => { if (seen.has(p.uid)) p.uid = newUid(); seen.add(p.uid); });
    const custom = !!d.customStaging;
    const stages = reconcileStages(parts, Array.isArray(d.stages) ? d.stages : [], custom);
    return { name: String(d.name || 'Untitled'), parts, stages, customStaging: custom };
  }

  class FlightCraft {
    constructor(parts, stages) {
      this.parts = parts.map((p) => {
        const d = def(p.type);
        return { uid: p.uid, type: p.type, def: d, role: role(p.type), fuel: p.fuel !== undefined ? p.fuel : d.fuel || 0, fuelMax: d.fuel || 0 };
      });
      this.stages = (stages || []).map((s) => s.slice());
      this.nextStage = 0;
      this.active = new Set();
      this._geom = null;
      this._sections = null;
    }

    static fromDesign(design) { return new FlightCraft(design.parts, design.stages); }

    invalidate() { this._geom = null; this._sections = null; }
    find(uid) { return this.parts.find((p) => p.uid === uid) || null; }
    mass() { let m = 0; for (const p of this.parts) m += partMass(p); return m; }
    fuelTotal() { let f = 0; for (const p of this.parts) f += p.fuel; return f; }
    hasPod() { return this.parts.some((p) => p.role === 'pod'); }

    /** Stack segments between decouplers. Fuel only flows within a section. */
    sections() {
      if (this._sections) return this._sections;
      const secs = [];
      let cur = { parts: [], tanks: [], engines: [] };
      for (const p of this.parts) {
        if (p.role === 'decoupler') { secs.push(cur); cur = { parts: [], tanks: [], engines: [] }; continue; }
        cur.parts.push(p);
        if (p.role === 'tank') cur.tanks.push(p);
        if (p.role === 'engine') cur.engines.push(p);
      }
      secs.push(cur);
      this._sections = secs;
      return secs;
    }

    sectionFuel(sec) { let f = 0; for (const t of sec.tanks) f += t.fuel; return f; }
    sectionFuelMax(sec) { let f = 0; for (const t of sec.tanks) f += t.fuelMax; return f; }

    /** Thrust (N) and propellant flow (kg/s) of active engines with fuel at a throttle and pressure ratio (0 vac .. 1 sea level). */
    thrustState(throttle, pressureRatio) {
      const g0 = CFG().g0;
      const pr = Math.min(1, Math.max(0, pressureRatio || 0));
      let thrust = 0, mdot = 0, ispSum = 0;
      const per = [];
      for (const sec of this.sections()) {
        if (!sec.engines.length) continue;
        const fuel = this.sectionFuel(sec);
        if (fuel <= 1e-9) continue;
        let secMdot = 0;
        for (const e of sec.engines) {
          if (!this.active.has(e.uid)) continue;
          const md = (e.def.thrust / (e.def.ispVac * g0)) * throttle;
          const isp = e.def.ispVac + (e.def.ispAsl - e.def.ispVac) * pr;
          thrust += md * isp * g0;
          ispSum += md * isp;
          secMdot += md;
        }
        if (secMdot > 0) { per.push({ sec, mdot: secMdot, fuel }); mdot += secMdot; }
      }
      return { thrust, mdot, per, isp: mdot > 0 ? ispSum / mdot : 0 };
    }

    /** Burn propellant for dt seconds; each section drains its own tanks proportionally. */
    burn(dt, throttle, pressureRatio) {
      const st = this.thrustState(throttle, pressureRatio);
      for (const p of st.per) {
        const need = p.mdot * dt;
        if (need >= p.fuel) { for (const t of p.sec.tanks) t.fuel = 0; }
        else { const k = (p.fuel - need) / p.fuel; for (const t of p.sec.tanks) t.fuel *= k; }
      }
      if (st.per.length) this._geom = null;
      return st;
    }

    /** Fuel available to the currently active engines (or the next stage's engines before ignition). */
    activeStageFuel() {
      let fuel = 0, max = 0, any = false;
      const secs = this.sections();
      let wanted = secs.filter((s) => s.engines.some((e) => this.active.has(e.uid)));
      if (!wanted.length && this.nextStage < this.stages.length) {
        const next = new Set(this.stages[this.nextStage]);
        wanted = secs.filter((s) => s.engines.some((e) => next.has(e.uid)));
      } else any = true;
      for (const s of wanted) { fuel += this.sectionFuel(s); max += this.sectionFuelMax(s); }
      return { fuel, max, active: any && wanted.length > 0, sections: wanted.length };
    }

    /** Rough remaining delta-v of the active engines at the given pressure. */
    activeStageDv(pressureRatio) {
      const st = this.thrustState(1, pressureRatio);
      if (st.mdot <= 0) return 0;
      let fuel = 0;
      for (const p of st.per) fuel += p.fuel;
      const m = this.mass();
      return st.isp * CFG().g0 * Math.log(m / Math.max(1e-6, m - fuel));
    }

    /** Fires the next step of the staging sequence. Returns what happened or null. */
    activateNextStage() {
      if (this.nextStage >= this.stages.length) return null;
      const step = this.stages[this.nextStage];
      this.nextStage += 1;
      const res = { number: this.nextStage, ignited: [], decoupled: [] };
      for (const uid of step) {
        const p = this.find(uid);
        if (p && p.role === 'decoupler') res.decoupled.push(this.decouple(p));
      }
      for (const uid of step) {
        const p = this.find(uid);
        if (p && p.role === 'engine') { this.active.add(uid); res.ignited.push(p); }
      }
      this.invalidate();
      return res;
    }

    /** Separates at a decoupler; the side without the command pod is removed (with the decoupler). */
    decouple(p) {
      const geomOld = this.geometry();
      const idx = this.parts.indexOf(p);
      const podIdx = this.parts.findIndex((q) => q.role === 'pod');
      const keepTop = podIdx < 0 || podIdx < idx;
      let removed, removedTopDepth, keptTopDepth;
      if (keepTop) {
        removed = this.parts.slice(idx);
        this.parts = this.parts.slice(0, idx);
        removedTopDepth = geomOld.tops.get(removed[0].uid);
        keptTopDepth = 0;
      } else {
        removed = this.parts.slice(0, idx + 1);
        this.parts = this.parts.slice(idx + 1);
        removedTopDepth = 0;
        keptTopDepth = this.parts.length ? geomOld.tops.get(this.parts[0].uid) : 0;
      }
      for (const q of removed) this.active.delete(q.uid);
      this.invalidate();
      const geomNew = this.geometry();
      const debris = new FlightCraft(removed, []);
      const geomDebris = debris.geometry();
      return {
        decoupler: p,
        debris,
        // Offsets measured along the craft axis, positive toward the nose, relative to the OLD centre of mass.
        craftShift: geomOld.comY - (keptTopDepth + geomNew.comY),
        debrisOffset: geomOld.comY - (removedTopDepth + geomDebris.comY),
      };
    }

    /** Stack geometry: heights from the top, centre of mass, contact extents. */
    geometry() {
      if (this._geom) return this._geom;
      let y = 0, m = 0, my = 0, maxW = 0;
      const tops = new Map();
      for (const p of this.parts) {
        const d = p.def;
        tops.set(p.uid, y);
        const pm = partMass(p);
        m += pm;
        my += pm * (y + d.height / 2);
        y += d.height;
        maxW = Math.max(maxW, d.width);
      }
      const height = y;
      const comY = m > 0 ? my / m : height / 2;
      // Section bottoms (for drawing leg reach), legs that touch the ground
      const legReach = new Map();
      const secs = this.sections();
      let legsAtBottom = null;
      secs.forEach((sec, si) => {
        if (!sec.parts.length) return;
        const last = sec.parts[sec.parts.length - 1];
        const bottom = tops.get(last.uid) + last.def.height;
        for (const p of sec.parts) {
          if (p.role === 'legs') {
            legReach.set(p.uid, bottom + p.def.footDrop);
            if (si === secs.length - 1) legsAtBottom = p;
          }
        }
      });
      const bottomPart = this.parts[this.parts.length - 1];
      const bottomHalf = bottomPart ? (bottomPart.def.bell || bottomPart.def.width) / 2 : 0.5;
      const footDrop = legsAtBottom ? legsAtBottom.def.footDrop : 0;
      const footHalfWidth = legsAtBottom ? legsAtBottom.def.width / 2 + legsAtBottom.def.footSpread : bottomHalf;
      this._geom = {
        height, comY, mass: m, maxWidth: maxW, tops, legReach,
        legsAtBottom: !!legsAtBottom,
        footHalfWidth,
        bottomOffset: height + footDrop - comY, // CoM to lowest point along the axis
        dragArea: Math.PI * (maxW / 2) * (maxW / 2),
      };
      return this._geom;
    }
  }

  /** Per-stage delta-v / TWR analysis of a design, using the same craft model as flight. */
  function analyzeDesign(design, sys) {
    const cfg = CFG();
    const g0 = cfg.g0;
    const gP = sys ? sys.planet.surfaceGravity : cfg.planet.surfaceGravity;
    const craft = FlightCraft.fromDesign(design);
    const warnings = [];
    const wetMass = craft.mass();
    const dryMass = wetMass - craft.fuelTotal();
    const height = craft.geometry().height;
    const result = { wetMass, dryMass, height, partCount: craft.parts.length, stages: [], totalDv: 0, liftoffTwr: 0, warnings };
    if (!craft.parts.length) { warnings.push({ level: 'info', text: 'Drag parts from the catalogue to start building.' }); return result; }
    const pods = craft.parts.filter((p) => p.role === 'pod').length;
    if (!pods) warnings.push({ level: 'bad', text: 'No command pod. Add a Lark Command Pod to fly.' });

    for (let i = 0; i < craft.stages.length; i++) {
      const act = craft.activateNextStage();
      const m0 = craft.mass();
      const tVac = craft.thrustState(1, 0);
      const tAsl = craft.thrustState(1, 1);
      for (const e of act.ignited) {
        const idx = craft.parts.indexOf(e);
        if (idx >= 0 && idx < craft.parts.length - 1) {
          warnings.push({ level: 'warn', text: `Stage ${i + 1}: ${e.def.name} fires into the ${craft.parts[idx + 1].def.name} below it.` });
        }
        const sec = craft.sections().find((s) => s.engines.includes(e));
        if (sec && craft.sectionFuel(sec) <= 0) warnings.push({ level: 'warn', text: `Stage ${i + 1}: ${e.def.name} has no fuel tank in its section.` });
      }
      let dvVac = 0, dvAsl = 0, burnTime = 0;
      for (let k = 0; k < 24; k++) {
        const st = craft.thrustState(1, 0);
        if (st.thrust <= 0 || st.mdot <= 0) break;
        let tEmpty = Infinity;
        for (const p of st.per) tEmpty = Math.min(tEmpty, p.fuel / p.mdot);
        const mA = craft.mass();
        const mB = mA - st.mdot * tEmpty;
        const asl = craft.thrustState(1, 1).thrust;
        const lr = Math.log(mA / mB);
        dvVac += (st.thrust / st.mdot) * lr;
        dvAsl += (asl / st.mdot) * lr;
        craft.burn(tEmpty * (1 + 1e-9), 1, 0);
        burnTime += tEmpty;
      }
      result.stages.push({
        number: i + 1,
        ignites: act.ignited.map((p) => ({ uid: p.uid, name: p.def.name })),
        decouples: act.decoupled.map((d) => ({ uid: d.decoupler.uid, name: d.decoupler.def.name, dropped: d.debris.parts.length - 1 })),
        startMass: m0, endMass: craft.mass(),
        dvVac, dvAsl, burnTime,
        thrustVac: tVac.thrust, thrustAsl: tAsl.thrust,
        twrAsl: m0 > 0 ? tAsl.thrust / (m0 * gP) : 0,
        twrVac: m0 > 0 ? tVac.thrust / (m0 * gP) : 0,
      });
      result.totalDv += dvVac;
    }
    const first = result.stages[0];
    result.liftoffTwr = first ? first.twrAsl : 0;
    if (pods) {
      if (!first || first.thrustVac <= 0) warnings.push({ level: 'bad', text: 'Stage 1 ignites no engine with fuel. The rocket cannot leave the pad.' });
      else if (result.liftoffTwr < 1) warnings.push({ level: 'bad', text: `Liftoff TWR ${result.liftoffTwr.toFixed(2)} is below 1. Add thrust or remove mass.` });
      else if (result.liftoffTwr < 1.25) warnings.push({ level: 'warn', text: `Liftoff TWR ${result.liftoffTwr.toFixed(2)} is low; the climb will be slow and costly.` });
    }
    const leftover = craft.fuelTotal();
    if (leftover > 1) warnings.push({ level: 'warn', text: `${Math.round(leftover)} kg of fuel is never burned (no engine in its section fires).` });
    // After every stage has fired, `craft` is the final stage: does it still have legs?
    if (pods && !craft.geometry().legsAtBottom) {
      warnings.push({ level: 'info', text: 'Final stage has no landing legs at its base: touchdowns must be under 2.5 m/s.' });
    }
    return result;
  }

  SB.Craft = { newUid, def, role, isStageable, partMass, autoStage, reconcileStages, makeDesign, cloneDesign, sanitizeDesign, analyzeDesign };
  SB.FlightCraft = FlightCraft;
})(typeof window !== 'undefined' ? window : globalThis);
