/*
 * Flight simulation. Fixed-step physics (RK4 with thrust + drag) while powered or in atmosphere,
 * exact Kepler coasting otherwise (also used on-rails during time warp). Patched conics for moons.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const wrap = (a) => SB.Orbit.wrapPi(a);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const approach = (x, target, step) => (x < target ? Math.min(target, x + step) : Math.max(target, x - step));
  const DEG = 180 / Math.PI;

  /**
   * One step of a parachute pack's opening sequence; shared by flight and the touchdown estimate.
   * k: {air, falling, radar, speed}. Armed packs open their drogues once falling in air below the
   * drogue height and speed limits; the mains follow below theirs, and the drogues are cut away.
   * Open fractions grow with the square of time (a canopy fills slowly at first). Returns the event.
   */
  function advanceChute(c, D, dt, k) {
    let ev = null;
    if (c.stage === 'armed' && k.air && k.falling && k.radar < D.drogue.maxRadar && k.speed < D.drogue.maxSpeed) { c.stage = 'drogue'; c.t = 0; ev = 'drogue'; }
    if (c.stage === 'drogue' && k.radar < D.main.maxRadar && k.speed < D.main.maxSpeed) { c.stage = 'main'; c.t = 0; c.dc = c.drogue; ev = 'main'; }
    if (c.stage === 'drogue') {
      c.t += dt;
      c.drogue = Math.min(1, c.t / D.drogue.openTime) ** 2;
    } else if (c.stage === 'main') {
      c.t += dt;
      c.drogue = 0;
      for (let i = 0; i < c.main.length; i++) c.main[i] = clamp((c.t - i * D.main.stagger) / D.main.openTime, 0, 1) ** 2;
    }
    return ev;
  }
  const mainFraction = (c) => c.main.reduce((a, b) => a + b, 0) / c.main.length;
  /** Drag area (m^2) a pack adds right now. */
  const chuteArea = (c, D) => D.drogue.cdA * c.drogue + D.main.cdA * mainFraction(c);
  const chuteLive = (c) => c.stage === 'armed' || c.stage === 'drogue' || c.stage === 'main';

  class Flight {
    constructor(sys, design) {
      this.sys = sys;
      this.cfg = SB.CONFIG;
      this.design = SB.Craft.cloneDesign(design);
      this.craft = SB.FlightCraft.fromDesign(this.design);
      this.craft.standOnLegs();
      this.st = { body: sys.planet, t: 0, rx: 0, ry: 0, vx: 0, vy: 0 };
      this.heading = 0;
      this.omega = 0;
      this.throttle = this.cfg.sim.startThrottle;
      this.throttleInput = 0;
      this.rotInput = 0;
      this.sas = 'stability';
      this.situation = 'prelaunch';
      this.warpIndex = 0;
      this.acc = 0;
      this.realClock = 0;
      this.paused = false;
      this.messages = [];
      this.debris = [];
      this.particles = [];
      this.outcome = null;
      this.launchTime = null;
      this.prediction = null;
      this.predDirty = true;
      this.lastPredReal = -1e9;
      this.target = null;
      this.soiLog = [];
      this.stageLog = [];
      this.maxAlt = 0;
      this.alertList = [];
      this.lastEngine = 'none';
      this.chuteLog = [];
      this._chuteEst = null;
      this.landedBody = sys.planet;
      this.landedAngle = sys.planet.launchAngle;
      this.placeOnSurface(sys.planet, sys.planet.launchAngle);
      this.planner = new SB.Planner(this);
    }

    // ------------------------------------------------------------------ basics
    get body() { return this.st.body; }
    geometry() { return this.craft.geometry(); }
    isLanded() { return this.situation === 'landed' || this.situation === 'prelaunch'; }
    r() { return Math.hypot(this.st.rx, this.st.ry); }
    altitude() { return this.r() - this.st.body.radius; }
    speed() { return Math.hypot(this.st.vx, this.st.vy); }
    verticalSpeed() { const r = this.r(); return (this.st.rx * this.st.vx + this.st.ry * this.st.vy) / r; }
    /** Signed horizontal speed: positive = counter-clockwise (screen-left in the flight view). */
    horizontalSpeed() { const r = this.r(); return (this.st.rx * this.st.vy - this.st.ry * this.st.vx) / r; }
    radarAltitude() {
      const ang = Math.atan2(this.st.ry, this.st.rx);
      return this.r() - this.sys.surfaceRadius(this.st.body, ang) - this.geometry().bottomOffset;
    }
    pressureRatio() { return this.sys.pressureRatio(this.st.body, this.altitude()); }
    orbit() { const s = this.st; return SB.Orbit.elements(s.body.mu, s.rx, s.ry, s.vx, s.vy); }
    globalPos() { const p = this.sys.bodyPos(this.st.body, this.st.t); return [p[0] + this.st.rx, p[1] + this.st.ry]; }
    missionTime() { return this.launchTime === null ? 0 : this.st.t - this.launchTime; }
    isThrusting() { return this.throttle > 0 && this.craft.thrustState(1, 0).thrust > 0; }
    inAtmosphere() { const b = this.st.body; return !!b.atmosphere && this.altitude() < b.atmosphere.height; }
    localGravity() { const r = this.r(); return this.st.body.mu / (r * r); }
    twr() {
      const t = this.craft.thrustState(this.throttle, this.pressureRatio()).thrust;
      return t / (this.craft.mass() * this.localGravity());
    }

    msg(text, kind, key) {
      const now = this.realClock;
      const k = key || text;
      const last = this.messages.find((m) => m.key === k && now - m.time < 5);
      if (last) { last.time = now; last.text = text; return; }
      this.messages.push({ text, kind: kind || 'info', time: now, key: k });
      if (this.messages.length > 6) this.messages.shift();
    }

    situationText() {
      const b = this.st.body;
      if (this.situation === 'prelaunch') return `Pre-launch · ${b.name}`;
      if (this.situation === 'landed') return `Landed on ${b.name}`;
      if (this.situation === 'crashed') return `Crashed on ${b.name}`;
      if (this.inAtmosphere()) return `Flying · ${b.name}`;
      const el = this.orbit();
      const safe = b.atmosphere ? b.radius + b.atmosphere.height : b.radius + b.terrain.maxH;
      if (el.e >= 1) return b.parent ? `Escaping ${b.name}` : 'Escape trajectory';
      if (b.parent && el.ra >= b.soi) return `Passing ${b.name}`;
      if (el.rp > safe) return `Orbiting ${b.name}`;
      return `Sub-orbital · ${b.name}`;
    }

    /** 'ok' if a lit engine has fuel, 'dry' if every lit engine has run out, 'none' if no engine is lit. */
    engineStatus() {
      const c = this.craft;
      let lit = false;
      for (const sec of c.sections()) {
        if (!sec.engines.some((e) => c.active.has(e.uid))) continue;
        lit = true;
        if (c.sectionFuel(sec) > 1e-9) return 'ok';
      }
      return lit ? 'dry' : 'none';
    }
    hasNextStage() { return this.craft.nextStage < this.craft.stages.length; }
    /** True when the next stage only arms parachutes (so "press Space" means "arm the chutes"). */
    nextStageIsChutes() {
      if (!this.hasNextStage()) return false;
      const step = this.craft.stages[this.craft.nextStage].map((uid) => this.craft.find(uid)).filter(Boolean);
      return step.length > 0 && step.every((p) => p.role === 'chute');
    }

    /**
     * Touchdown limits: legs or none, made more lenient (field by field) while hanging from the main
     * chutes, or with assumeMains, for judging a descent that the mains will finish.
     */
    landingLimits(assumeMains) {
      const L = this.cfg.landing;
      const base = this.geometry().legsAtBottom ? L.withLegs : L.withoutLegs;
      if (!assumeMains && this.mainsFraction() <= 0.5) return base;
      const u = L.underChutes;
      return { maxDescent: Math.max(base.maxDescent, u.maxDescent), maxHorizontal: Math.max(base.maxHorizontal, u.maxHorizontal), maxTiltDeg: Math.max(base.maxTiltDeg, u.maxTiltDeg) };
    }

    // ------------------------------------------------------------------ parachutes
    chutePacks() { return this.craft.parts.filter((p) => p.role === 'chute'); }
    /** Extra drag area (m^2) of every open canopy. */
    chuteCdA() { let a = 0; for (const p of this.craft.parts) if (p.role === 'chute') a += chuteArea(p.chute, p.def); return a; }
    /** How far the main canopies are open, 0..1 (the most open pack). */
    mainsFraction() { let f = 0; for (const p of this.craft.parts) if (p.role === 'chute' && p.chute.stage === 'main') f = Math.max(f, mainFraction(p.chute)); return f; }
    mainsOpen() { return this.mainsFraction() >= 0.999; }

    stepChutes(dt) {
      let k = null;
      for (const p of this.craft.parts) {
        if (p.role !== 'chute' || !chuteLive(p.chute)) continue;
        if (!k) k = { air: this.inAtmosphere(), falling: this.verticalSpeed() < -1, radar: this.radarAltitude(), speed: this.speed() };
        const ev = advanceChute(p.chute, p.def, dt, k);
        if (!ev) continue;
        this.chuteLog.push({ ev, t: this.st.t, speed: k.speed, radar: k.radar });
        this.msg(ev === 'drogue' ? 'Drogue chutes out' : 'Main chutes out · drogues cut away', ev === 'drogue' ? 'info' : 'good', 'chute-' + ev);
        this._chuteEst = null;
      }
    }

    /** After touchdown (or a crash) the canopies collapse. */
    spendChutes() {
      for (const p of this.chutePacks()) if (p.chute.stage === 'drogue' || p.chute.stage === 'main') p.chute.stage = 'spent';
    }

    /**
     * Touchdown estimate under parachutes: a fall from here with the same opening rules and drag,
     * engines off. {t: seconds to touchdown, speed: descent rate then, horizontal}, or null without an
     * armed or open pack, or outside the air. The map's path ignores drag, so this replaces its impact
     * time while the chutes work. Recomputed a few times a second.
     */
    chuteDescent() {
      const packs = this.chutePacks().filter((p) => chuteLive(p.chute));
      if (!packs.length || this.situation !== 'flying' || !this.inAtmosphere()) return null;
      const key = packs.map((p) => p.chute.stage).join();
      const C = this._chuteEst;
      if (C && C.key === key && this.realClock - C.real < 0.2 && this.st.t >= C.simT) {
        return { t: Math.max(0, C.t - (this.st.t - C.simT)), speed: C.speed, horizontal: C.horizontal };
      }
      const b = this.st.body, sys = this.sys;
      const m = this.craft.mass(), g = this.localGravity();
      const radar = this.radarAltitude();
      const ground = this.altitude() - radar; // altitude of the touchdown point above the mean radius
      const base = this.cfg.sim.dragCd * this.geometry().dragArea;
      const states = packs.map((p) => ({ c: JSON.parse(JSON.stringify(p.chute)), D: p.def }));
      let h = radar, d = -this.verticalSpeed(), u = Math.abs(this.horizontalSpeed()), t = 0;
      for (let i = 0; i < 40000 && h > 0 && t < 7200; i++) {
        const V = Math.hypot(d, u);
        const rho = sys.density(b, h + ground);
        let area = base;
        for (const s of states) area += chuteArea(s.c, s.D);
        const k = (0.5 * rho * area) / m;
        const opening = states.some((s) => (s.c.stage === 'drogue' && s.c.drogue < 1) || (s.c.stage === 'main' && s.c.main.some((x) => x < 1)));
        let dt = Math.min(opening ? 0.05 : 1, 0.25 / (k * V + 1e-6));
        if (d > 0) dt = Math.min(dt, Math.max(0.02, (0.5 * h) / d));
        for (const s of states) advanceChute(s.c, s.D, dt, { air: rho > 0, falling: d > 1, radar: h, speed: V });
        const damp = 1 + k * V * dt; // semi-implicit drag: stable for any step
        const dn = (d + g * dt) / damp;
        u /= damp;
        h -= 0.5 * (d + dn) * dt;
        d = dn;
        t += dt;
      }
      this._chuteEst = { key, real: this.realClock, simT: this.st.t, t, speed: Math.max(0, d), horizontal: u };
      return { t, speed: Math.max(0, d), horizontal: u };
    }

    /**
     * Cautions and warnings for this moment, warnings first: {id, level: 'warning' | 'caution', text,
     * key, once}. The HUD shows each with an icon and words, and the audio plays a chime for a new
     * caution (once per key if `once`) and beeps while a warning lasts.
     * The landing alerts mirror the touchdown limits. Sink rate compares the distance needed to brake
     * to a safe touchdown speed at full thrust with the height that is left.
     */
    alerts() {
      const out = [];
      if (this.situation === 'crashed' || this.situation === 'prelaunch') return out;
      const c = this.craft, A = this.cfg.alerts;
      const eng = this.engineStatus();
      const chutesNext = this.nextStageIsChutes();
      if (eng !== 'ok' && this.hasNextStage() && !chutesNext) {
        out.push({ id: 'stage', level: 'caution', text: eng === 'dry' ? 'Stage empty · press Space' : 'No engine lit · press Space', key: 'stage' + c.nextStage, once: true });
      }
      const B = this.st.body;
      if (chutesNext && this.situation === 'flying' && B.atmosphere && this.altitude() < B.atmosphere.height && this.verticalSpeed() < -1) {
        out.push({ id: 'stage', level: 'caution', text: 'Chutes not armed · press Space', key: 'chute-arm' + c.nextStage, once: true });
      }
      if (eng === 'ok' && this.isThrusting()) {
        const fu = c.activeStageFuel();
        if (fu.max > 0 && fu.fuel / fu.max < A.lowFuel) out.push({ id: 'fuel', level: 'caution', text: `Low fuel · ${SB.Flight.pct(fu.fuel / fu.max)}`, key: 'fuel' + c.nextStage, once: true });
      }
      const pack = this.chutePacks().find((p) => p.chute.stage === 'armed');
      if (pack && this.situation === 'flying') {
        if (!this.st.body.atmosphere) out.push({ id: 'chute', level: 'caution', text: 'Chutes armed · no air here', key: 'chute-noair', once: true });
        else if (this.inAtmosphere() && this.verticalSpeed() < -1 && this.speed() >= pack.def.drogue.maxSpeed) {
          out.push({ id: 'chute', level: 'caution', text: 'Chutes armed · too fast to open', key: 'chute-fast', once: true });
        }
      }
      if (this.situation === 'flying') {
        const radar = this.radarAltitude();
        if (radar < A.groundRange) {
          const lim = this.landingLimits();
          const vs = this.verticalSpeed(), down = -vs;
          // a descent the chutes will bring down gently needs no sink-rate alert
          const est = this.chuteDescent();
          const chutesWillDo = est && est.speed <= this.landingLimits(true).maxDescent;
          if (down > lim.maxDescent && !chutesWillDo) {
            const accel = (eng === 'ok' ? c.thrustState(1, this.pressureRatio()).thrust / c.mass() : 0) - this.localGravity();
            const need = accel > 0 ? (down * down - lim.maxDescent * lim.maxDescent) / (2 * accel) : Infinity;
            const ratio = need / Math.max(0.5, radar);
            if (ratio > A.sinkWarning) out.push({ id: 'sink', level: 'warning', text: accel > 0 ? 'Sink rate · burn now' : 'Sink rate · no thrust', key: 'sink' });
            else if (ratio > A.sinkCaution) out.push({ id: 'sink', level: 'caution', text: 'Sink rate', key: 'sink' });
          }
          if (vs < 0) {
            const b = this.st.body, ang = Math.atan2(this.st.ry, this.st.rx);
            const hs = Math.abs(this.horizontalSpeed());
            if (radar < A.driftRange && hs > lim.maxHorizontal) out.push({ id: 'drift', level: 'caution', text: `Drift · ${hs.toFixed(1)} m/s sideways`, key: 'drift' });
            if (radar < Math.max(A.tiltRange, A.slopeRange)) {
              const sf = this.sys.surfaceFrame(b, ang);
              const tilt = Math.min(Math.abs(wrap(this.heading - sf.normal)), Math.abs(wrap(this.heading - ang))) * DEG;
              if (radar < A.tiltRange && tilt > lim.maxTiltDeg) out.push({ id: 'tilt', level: 'caution', text: `Tilt ${tilt.toFixed(0)}° · stand upright`, key: 'tilt' });
              const slope = Math.abs(sf.slope) * DEG;
              if (radar < A.slopeRange && slope > this.cfg.landing.maxSlopeDeg) out.push({ id: 'slope', level: 'caution', text: `Steep ground · ${slope.toFixed(0)}°`, key: 'slope' });
            }
          }
        }
      }
      return out.sort((a, b) => (a.level === 'warning' ? 0 : 1) - (b.level === 'warning' ? 0 : 1));
    }

    /** Says so when the lit engines run out of fuel. */
    trackEngine() {
      const eng = this.engineStatus();
      if (this.lastEngine === 'ok' && eng === 'dry' && this.situation !== 'crashed') {
        this.msg(this.hasNextStage() && !this.nextStageIsChutes() ? 'Out of fuel · press Space to stage' : 'Out of fuel', 'warn', 'flameout');
      }
      this.lastEngine = eng;
    }

    /**
     * Hohmann planning aid toward moon m from the current planet orbit: current phase angle
     * (moon ahead of craft, in the direction of travel), the ideal phase for a prograde burn now,
     * the burn delta-v and the time until the ideal phase comes around.
     */
    transferInfo(m) {
      if (!m || this.st.body !== this.sys.planet || this.isLanded()) return null;
      const mu = this.sys.planet.mu;
      const el = this.orbit();
      const rc = el.e < 1 ? el.a : this.r();
      const cp = this.globalPos(), mp = this.sys.bodyPos(m, this.st.t);
      const sense = el.h >= 0 ? 1 : -1;
      const TAU = Math.PI * 2;
      let phase = (Math.atan2(mp[1], mp[0]) - Math.atan2(cp[1], cp[0])) * sense;
      phase = ((phase % TAU) + TAU) % TAU;
      const at = (rc + m.orbitRadius) / 2;
      const tTransfer = Math.PI * Math.sqrt((at * at * at) / mu);
      let ideal = Math.PI - Math.abs(m.meanMotion) * tTransfer;
      ideal = ((ideal % TAU) + TAU) % TAU;
      const sameSense = Math.sign(m.meanMotion) === sense;
      const nc = Math.sqrt(mu / (rc * rc * rc));
      const rel = nc - Math.abs(m.meanMotion) * (sameSense ? 1 : -1);
      const synodic = TAU / Math.abs(rel);
      let wait = (phase - ideal) / rel;
      wait = ((wait % synodic) + synodic) % synodic;
      const dv = Math.sqrt(mu * (2 / rc - 1 / at)) - Math.sqrt(mu / rc);
      return { phase, ideal, dv, wait, tTransfer, sameSense, synodic };
    }

    // ------------------------------------------------------------------ surface handling
    placeOnSurface(b, ang) {
      const sf = this.sys.surfaceFrame(b, ang);
      const g = this.geometry();
      const nx = Math.cos(sf.normal), ny = Math.sin(sf.normal);
      this.st.body = b;
      this.st.rx = sf.R * Math.cos(ang) + nx * g.bottomOffset;
      this.st.ry = sf.R * Math.sin(ang) + ny * g.bottomOffset;
      this.st.vx = 0; this.st.vy = 0;
      this.heading = sf.normal;
      this.omega = 0;
      this.landedBody = b;
      this.landedAngle = ang;
    }

    contactClearance() { return this.geometry().bottomOffset; }

    /** Contact test after a numeric step; triggers touchdown evaluation. */
    checkContact() {
      const st = this.st, b = st.body, g = this.geometry();
      const r = this.r();
      if (r - b.radius > b.terrain.maxH + g.bottomOffset + g.footHalfWidth + 5) return;
      const ang = Math.atan2(st.ry, st.rx);
      const sf = this.sys.surfaceFrame(b, ang);
      const tilt = wrap(this.heading - sf.normal);
      const clearance = g.bottomOffset * Math.abs(Math.cos(tilt)) + g.footHalfWidth * Math.abs(Math.sin(tilt));
      const gap = (r - sf.R) * Math.cos(sf.slope) - clearance;
      if (gap > 0) return;
      const vn = st.vx * Math.cos(sf.normal) + st.vy * Math.sin(sf.normal);
      if (vn > 0.05 && gap > -2) return; // moving away (lift-off)
      this.touchdown();
    }

    touchdown() {
      const st = this.st, b = st.body;
      const ang = Math.atan2(st.ry, st.rx);
      const sf = this.sys.surfaceFrame(b, ang);
      const nx = Math.cos(sf.normal), ny = Math.sin(sf.normal);
      const vn = st.vx * nx + st.vy * ny;
      const vt = -st.vx * ny + st.vy * nx;
      // Upright means aligned with either local vertical (gravity) or the ground normal;
      // steep ground is rejected separately by the slope limit.
      const tilt = Math.min(Math.abs(wrap(this.heading - sf.normal)), Math.abs(wrap(this.heading - ang))) * DEG;
      const slope = Math.abs(sf.slope) * DEG;
      const g = this.geometry();
      const lim = this.landingLimits();
      const maxSlope = this.cfg.landing.maxSlopeDeg;
      const descent = Math.max(0, -vn), horizontal = Math.abs(vt);
      const reasons = [];
      if (descent > lim.maxDescent) reasons.push(`descent rate ${descent.toFixed(1)} m/s (limit ${lim.maxDescent} m/s)`);
      if (horizontal > lim.maxHorizontal) reasons.push(`horizontal speed ${horizontal.toFixed(1)} m/s (limit ${lim.maxHorizontal} m/s)`);
      if (tilt > lim.maxTiltDeg) reasons.push(`tilted ${tilt.toFixed(0)}° from the surface (limit ${lim.maxTiltDeg}°)`);
      if (slope > maxSlope) reasons.push(`ground slope ${slope.toFixed(0)}° is too steep (limit ${maxSlope}°)`);
      const report = { body: b, descent, horizontal, tilt, slope, legs: g.legsAtBottom, chutes: this.mainsFraction() > 0.5, limits: lim, t: st.t, speed: Math.hypot(st.vx, st.vy), reasons };
      if (reasons.length) this.crash(report);
      else this.land(report, ang);
    }

    land(report, ang) {
      this.situation = 'landed';
      this.outcome = Object.assign({ type: 'landed' }, report);
      this.spendChutes();
      this.placeOnSurface(report.body, ang);
      this.warpIndex = 0;
      this.predDirty = true;
      this.prediction = null;
      this.planner.clear();
      this.msg(`Landed on ${report.body.name}! Touchdown ${report.descent.toFixed(1)} m/s`, 'good');
    }

    crash(report) {
      this.situation = 'crashed';
      this.outcome = Object.assign({ type: 'crashed' }, report);
      this.throttle = 0;
      this.warpIndex = 0;
      this.prediction = null;
      this.alertList = [];
      this.spendChutes();
      this.planner.clear();
      this.spawnExplosion(this.st.rx, this.st.ry, 90);
      this.msg(`Crashed into ${report.body.name}`, 'bad');
    }

    // ------------------------------------------------------------------ controls
    setThrottle(x) { this.throttle = clamp(x, 0, 1); }
    setSas(mode, quiet) {
      this.sas = mode;
      if (mode === 'maneuver' && !quiet && !this.planner.count) { this.msg('No maneuver node: add one by clicking your trajectory on the map', 'warn', 'sas'); return; }
      if (!quiet) this.msg({ off: 'SAS off', stability: 'Stability assist', prograde: 'Holding prograde', retrograde: 'Holding retrograde', maneuver: 'Holding maneuver burn direction' }[mode], 'info', 'sas');
    }
    toggleStability() { this.setSas(this.sas === 'off' ? 'stability' : 'off'); }
    setTarget(m) { this.target = m || null; this.predDirty = true; }

    stage() {
      if (this.situation === 'crashed') return null;
      const res = this.craft.activateNextStage();
      if (!res) { this.msg('No stages left', 'warn'); return null; }
      const st = this.st;
      const hx = Math.cos(this.heading), hy = Math.sin(this.heading);
      let dropped = 0;
      for (const d of res.decoupled) {
        const mc = this.craft.mass(), md = d.debris.mass();
        const rel = 2.5;
        if (!this.isLanded() && d.debris.parts.length) {
          this.debris.push({
            body: st.body,
            rx: st.rx + hx * d.debrisOffset, ry: st.ry + hy * d.debrisOffset,
            vx: st.vx - hx * rel * (mc / (mc + md)), vy: st.vy - hy * rel * (mc / (mc + md)),
            heading: this.heading, omega: (Math.random() - 0.5) * 0.3, craft: d.debris, age: 0,
          });
        }
        st.rx += hx * d.craftShift; st.ry += hy * d.craftShift;
        if (!this.isLanded()) { st.vx += hx * rel * (md / (mc + md)); st.vy += hy * rel * (md / (mc + md)); }
        dropped += d.debris.parts.length;
      }
      if (this.isLanded()) this.placeOnSurface(this.landedBody, this.landedAngle);
      const parts = [];
      if (dropped) parts.push(`dropped ${dropped} part${dropped > 1 ? 's' : ''}`);
      if (res.ignited.length) parts.push('ignited ' + res.ignited.map((p) => p.def.name.split(' ')[0]).join(', '));
      if (res.legs.length) parts.push('legs out');
      if (res.armed.length) parts.push('chutes armed');
      this.msg(`Stage ${res.number}: ${parts.join(' · ') || 'nothing to do'}`, 'info');
      this.stageLog.push({ number: res.number, t: st.t, alt: this.altitude() });
      this.predDirty = true;
      return res;
    }

    // ------------------------------------------------------------------ warp
    warpLevels() { return this.cfg.sim.warpLevels; }
    /** Warp coasts on Kepler orbits only above the physics limit and outside the air. */
    onRails() { return this.warpRate() > this.cfg.sim.maxPhysicsWarp && !this.inAtmosphere(); }
    warpRate() { return this.cfg.sim.warpLevels[this.warpIndex]; }
    physicsWarpIndex() {
      const L = this.cfg.sim.warpLevels;
      let i = 0;
      while (i + 1 < L.length && L[i + 1] <= this.cfg.sim.maxPhysicsWarp) i++;
      return i;
    }

    nextEvent() {
      if (!this.prediction) return null;
      const t = this.st.t;
      for (const ev of this.prediction.events) if (ev.t > t + 1e-6 && ev.type !== 'limit') return ev;
      return null;
    }

    /** Highest warp index allowed right now, and why. */
    maxWarpIndex() {
      const L = this.cfg.sim.warpLevels;
      let idx = L.length - 1, reason = '';
      if (this.situation === 'crashed') return { index: 0, reason: 'crashed' };
      if (this.isLanded()) return { index: idx, reason };
      const phys = this.physicsWarpIndex();
      if (this.isThrusting()) { idx = Math.min(idx, phys); reason = 'engines firing — cut throttle (X) to warp faster'; }
      else if (this.inAtmosphere()) {
        if (this.mainsOpen()) { idx = Math.min(idx, Math.max(phys, L.indexOf(this.cfg.sim.chuteWarp))); reason = 'under parachutes'; }
        else { idx = Math.min(idx, phys); reason = 'in the atmosphere'; }
      }
      const lead = this.cfg.sim.warpLeadSeconds;
      const ev = this.nextEvent();
      if (ev) {
        let dt = ev.t - this.st.t;
        if (ev.type === 'impact') { const est = this.chuteDescent(); if (est) dt = est.t; } // the path ignores drag
        let j = idx;
        while (j > 0 && L[j] * lead > dt) j--;
        if (ev.type === 'impact' && dt < 20) j = 0;
        if (j < idx) { idx = j; reason = 'approaching ' + this.describeEvent(ev); }
      }
      // Stop 10 s before the next maneuver burn should start.
      const bs = this.planner.nextBurnStart();
      if (bs !== null && bs > this.st.t) {
        const dt = bs - 10 - this.st.t;
        let j = idx;
        while (j > 0 && L[j] * lead > dt) j--;
        if (j < idx) { idx = j; reason = 'approaching the maneuver burn'; }
      }
      return { index: idx, reason };
    }

    describeEvent(ev) {
      if (ev.type === 'soi') return ev.to.parent ? `${ev.to.name}'s sphere of influence` : `${ev.from.name}'s SOI edge`;
      if (ev.type === 'atmo') return 'atmospheric entry';
      if (ev.type === 'impact') return `the surface of ${ev.body.name}`;
      return ev.type;
    }

    setWarp(i) {
      const L = this.cfg.sim.warpLevels;
      i = clamp(i, 0, L.length - 1);
      const lim = this.maxWarpIndex();
      if (i > lim.index) {
        if (i > this.warpIndex) this.msg(`Warp limited: ${lim.reason}`, 'warn', 'warplimit');
        i = lim.index;
      }
      this.warpIndex = i;
    }
    warpUp() { this.setWarp(this.warpIndex + 1); }
    warpDown() { this.setWarp(this.warpIndex - 1); }
    stopWarp() { this.warpIndex = 0; }

    enforceWarpLimit() {
      const lim = this.maxWarpIndex();
      if (this.warpIndex > lim.index) {
        this.warpIndex = lim.index;
        this.msg(`Warp reduced: ${lim.reason}`, 'warn', 'warpreduce');
      }
    }

    // ------------------------------------------------------------------ prediction
    maybePredict(force) {
      if (this.isLanded() || this.situation === 'crashed') { this.prediction = null; return; }
      const interval = this.onRails() ? 0 : this.isThrusting() ? 0.1 : 0.25;
      if (!force && !this.predDirty && this.realClock - this.lastPredReal < interval) return;
      this.prediction = SB.predict(this.sys, this.st, {
        clearance: this.contactClearance(), target: this.target, maxSegments: this.cfg.sim.predictionSegments,
      });
      this.predDirty = false;
      this.lastPredReal = this.realClock;
    }

    // ------------------------------------------------------------------ simulation
    update(realDt) {
      this.realClock += realDt;
      if (this.paused) { this.alertList = this.alerts(); return; }
      realDt = Math.min(realDt, 0.1);
      this.updateParticles(realDt);
      this.animateParts(realDt);
      if (this.situation === 'crashed') return;
      if (this.throttleInput) this.setThrottle(this.throttle + this.throttleInput * this.cfg.control.throttleRate * realDt);
      this.maybePredict(false);
      this.enforceWarpLimit();
      const rate = this.warpRate();
      if (this.onRails()) {
        this.railsAdvance(realDt * rate);
      } else {
        const dt = this.cfg.sim.physicsDt;
        this.acc += realDt * rate;
        let n = 0;
        while (this.acc >= dt) {
          this.physicsStep(dt);
          this.acc -= dt;
          if (this.situation === 'crashed') { this.acc = 0; break; }
          if (++n >= this.cfg.sim.maxPhysicsStepsPerFrame) { this.acc = 0; break; }
        }
      }
      this.maybePredict(false);
      this.planner.update();
      this.trackEngine();
      this.alertList = this.alerts();
    }

    /** Advances exactly `seconds` of simulation time at physics resolution (used by tests and autopilots). */
    simulate(seconds) {
      const dt = this.cfg.sim.physicsDt;
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n && this.situation !== 'crashed'; i++) this.physicsStep(dt);
    }

    holdTarget() {
      const v = this.speed();
      if (v < 0.3) return null;
      const a = Math.atan2(this.st.vy, this.st.vx);
      if (this.sas === 'prograde') return a;
      if (this.sas === 'retrograde') return wrap(a + Math.PI);
      if (this.sas === 'maneuver') {
        const b = this.planner.burnVector();
        // Near the end of a burn the remaining vector gets tiny and noisy: keep the last direction.
        if (b && Math.hypot(b[0], b[1]) > 0.4) this.mnvDir = Math.atan2(b[1], b[0]);
        return b ? (this.mnvDir !== undefined ? this.mnvDir : null) : null;
      }
      return null;
    }

    isHoldMode() { return this.sas === 'prograde' || this.sas === 'retrograde' || this.sas === 'maneuver'; }

    updateAttitude(dt) {
      if (this.isLanded()) { this.omega = 0; return; }
      const c = this.cfg.control;
      const maxA = c.maxAngularAccel, maxW = c.maxAngularRate;
      // Hanging from parachutes, the craft swings round to trail them (nose into the airflow's
      // source, i.e. pointing retrograde) and cannot be steered.
      let pull = 0;
      for (const p of this.craft.parts) if (p.role === 'chute' && chuteLive(p.chute)) pull = Math.max(pull, p.chute.drogue * 0.5, mainFraction(p.chute));
      if (pull > 0.02 && this.inAtmosphere() && this.speed() > 0.5) {
        const err = wrap(Math.atan2(-this.st.vy, -this.st.vx) - this.heading);
        const want = Math.sign(err) * Math.min(maxW * 1.5, 2.2 * Math.abs(err)) * Math.min(1, pull * 3);
        this.omega = approach(this.omega, want, maxA * 2 * dt);
        this.heading = wrap(this.heading + this.omega * dt);
        return;
      }
      if (this.rotInput !== 0) {
        if (this.isHoldMode()) this.setSas('stability', true);
        this.omega = clamp(this.omega + this.rotInput * maxA * dt, -maxW, maxW);
      } else if (this.sas === 'stability') {
        this.omega = approach(this.omega, 0, maxA * dt);
      } else if (this.isHoldMode()) {
        const tgt = this.holdTarget();
        if (tgt === null) this.omega = approach(this.omega, 0, maxA * dt);
        else {
          const err = wrap(tgt - this.heading);
          const mag = Math.min(maxW, Math.sqrt(2 * maxA * 0.7 * Math.abs(err)), 4 * Math.abs(err));
          this.omega = approach(this.omega, Math.sign(err) * mag, maxA * dt);
        }
      }
      this.heading = wrap(this.heading + this.omega * dt);
    }

    physicsStep(dt) {
      this.updateAttitude(dt);
      if (this.situation === 'crashed') return;
      const st = this.st, b = st.body;
      const pr = this.sys.pressureRatio(b, this.altitude());
      if (this.isLanded()) { this.landedStep(dt, pr); return; }
      this.stepChutes(dt);
      if (this.isThrusting() || this.inAtmosphere()) {
        this.numericStep(dt, pr);
        this.checkSoiNumeric();
        if (this.situation === 'flying') this.checkContact();
      } else {
        const ev = SB.Coast.advance(this.sys, st, dt, { stopAtSoi: true, stopAtAtmo: true, clearance: this.contactClearance() });
        if (ev) this.onCoastEvent(ev, false);
      }
      this.updateDebris(dt);
      const alt = this.altitude();
      if (alt > this.maxAlt && st.body === this.sys.planet) this.maxAlt = alt;
    }

    landedStep(dt, pr) {
      const ts = this.craft.thrustState(this.throttle, pr);
      const m = this.craft.mass();
      if (this.throttle > 0 && ts.thrust > m * this.localGravity() * 1.0005) {
        if (this.situation === 'prelaunch') { this.launchTime = this.st.t; this.msg('Liftoff!', 'good'); }
        else this.msg(`Lift-off from ${this.st.body.name}`, 'good');
        this.situation = 'flying';
        this.outcome = null;
        this.predDirty = true;
        this.numericStep(dt, pr);
        return;
      }
      this.craft.burn(dt, this.throttle, pr);
      this.st.t += dt;
      this.placeOnSurface(this.landedBody, this.landedAngle);
    }

    numericStep(dt, pr) {
      const st = this.st, b = st.body, sys = this.sys;
      const m = this.craft.mass();
      const ts = this.craft.thrustState(this.throttle, pr);
      const aT = ts.thrust / m;
      const hx = Math.cos(this.heading), hy = Math.sin(this.heading);
      const CdA = this.cfg.sim.dragCd * this.geometry().dragArea + this.chuteCdA();
      const mu = b.mu, R = b.radius, atmo = !!b.atmosphere;
      const a = [0, 0];
      function acc(rx, ry, vx, vy) {
        const r2 = rx * rx + ry * ry, r = Math.sqrt(r2), gk = -mu / (r2 * r);
        let ax = gk * rx + aT * hx, ay = gk * ry + aT * hy;
        if (atmo) {
          const rho = sys.density(b, r - R);
          if (rho > 0) {
            const k = (-0.5 * rho * Math.hypot(vx, vy) * CdA) / m;
            ax += k * vx; ay += k * vy;
          }
        }
        a[0] = ax; a[1] = ay;
      }
      const x0 = st.rx, y0 = st.ry, u0 = st.vx, w0 = st.vy, h2 = dt / 2;
      acc(x0, y0, u0, w0); const a1x = a[0], a1y = a[1];
      const x2 = x0 + u0 * h2, y2 = y0 + w0 * h2, u2 = u0 + a1x * h2, w2 = w0 + a1y * h2;
      acc(x2, y2, u2, w2); const a2x = a[0], a2y = a[1];
      const x3 = x0 + u2 * h2, y3 = y0 + w2 * h2, u3 = u0 + a2x * h2, w3 = w0 + a2y * h2;
      acc(x3, y3, u3, w3); const a3x = a[0], a3y = a[1];
      const x4 = x0 + u3 * dt, y4 = y0 + w3 * dt, u4 = u0 + a3x * dt, w4 = w0 + a3y * dt;
      acc(x4, y4, u4, w4); const a4x = a[0], a4y = a[1];
      st.rx = x0 + (dt / 6) * (u0 + 2 * u2 + 2 * u3 + u4);
      st.ry = y0 + (dt / 6) * (w0 + 2 * w2 + 2 * w3 + w4);
      st.vx = u0 + (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
      st.vy = w0 + (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
      this.craft.burn(dt, this.throttle, pr);
      st.t += dt;
    }

    checkSoiNumeric() {
      const st = this.st, b = st.body, sys = this.sys;
      if (b.parent) {
        if (this.r() > b.soi) {
          const before = [st.rx, st.ry, st.vx, st.vy];
          SB.Coast.exitSoi(sys, st);
          this.onSoiChange({ type: 'soi', from: b, to: st.body, t: st.t, before, after: [st.rx, st.ry, st.vx, st.vy] });
        }
        return;
      }
      for (const m of sys.moons) {
        const mp = sys.bodyPos(m, st.t);
        if (Math.hypot(st.rx - mp[0], st.ry - mp[1]) < m.soi) {
          const before = [st.rx, st.ry, st.vx, st.vy];
          SB.Coast.enterSoi(sys, st, m);
          this.onSoiChange({ type: 'soi', from: b, to: m, t: st.t, before, after: [st.rx, st.ry, st.vx, st.vy] });
          return;
        }
      }
    }

    onSoiChange(ev) {
      this.soiLog.push(ev);
      this.debris = [];
      this.predDirty = true;
      if (ev.to.parent) this.msg(`Entered ${ev.to.name}'s sphere of influence`, 'good');
      else this.msg(`Left ${ev.from.name}'s sphere of influence`, 'info');
    }

    onCoastEvent(ev, onRails) {
      if (ev.type === 'soi') {
        this.onSoiChange(ev);
        if (onRails) this.maybePredict(true);
      } else if (ev.type === 'atmo') {
        if (this.warpIndex > this.physicsWarpIndex()) {
          this.warpIndex = this.physicsWarpIndex();
          this.msg('Atmospheric entry: warp reduced', 'warn', 'warpreduce');
        }
      } else if (ev.type === 'impact') {
        this.touchdown();
      }
    }

    railsAdvance(simDt) {
      const st = this.st;
      if (this.isLanded()) { st.t += simDt; this.placeOnSurface(this.landedBody, this.landedAngle); return; }
      this.debris = [];
      this.omega = 0;
      const follow = () => { const tg = this.holdTarget(); if (tg !== null) this.heading = tg; };
      follow();
      const ev = SB.Coast.advance(this.sys, st, simDt, { stopAtSoi: true, stopAtAtmo: true, clearance: this.contactClearance() });
      follow();
      if (ev) this.onCoastEvent(ev, true);
    }

    // ------------------------------------------------------------------ debris & effects
    updateDebris(dt) {
      const sys = this.sys;
      for (let i = this.debris.length - 1; i >= 0; i--) {
        const d = this.debris[i];
        const b = d.body;
        if (b !== this.st.body) { this.debris.splice(i, 1); continue; }
        const r = Math.hypot(d.rx, d.ry);
        const gk = -b.mu / (r * r * r);
        let ax = gk * d.rx, ay = gk * d.ry;
        const rho = sys.density(b, r - b.radius);
        if (rho > 0) {
          const g = d.craft.geometry();
          const k = (-0.5 * rho * Math.hypot(d.vx, d.vy) * this.cfg.sim.dragCd * g.dragArea * 1.6) / Math.max(1, d.craft.mass());
          ax += k * d.vx; ay += k * d.vy;
        }
        d.vx += ax * dt; d.vy += ay * dt;
        d.rx += d.vx * dt; d.ry += d.vy * dt;
        d.heading += d.omega * dt;
        d.age += dt;
        const gap = Math.hypot(d.rx, d.ry) - sys.surfaceRadius(b, Math.atan2(d.ry, d.rx));
        if (gap < 1) {
          this.spawnExplosion(d.rx, d.ry, 40);
          this.debris.splice(i, 1);
        } else if (d.age > 400) this.debris.splice(i, 1);
      }
    }

    spawnExplosion(x, y, n) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 28;
        this.particles.push({ body: this.st.body, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.2 + Math.random() * 1.6, age: 0, size: 1 + Math.random() * 3 });
      }
    }

    /**
     * Cosmetic animation in real time (the same speed under time warp): opening legs swing down, cut
     * drogues drift away, spent canopies collapse.
     */
    animateParts(realDt) {
      for (const p of this.craft.parts) {
        if (p.role === 'legs' && p.legsOut && p.deploy < 1) p.deploy = Math.min(1, p.deploy + realDt / (p.def.deployTime || 1.2));
        if (p.role === 'chute') {
          const c = p.chute;
          if (c.stage === 'main' && c.cut < 1) c.cut = Math.min(1, c.cut + realDt / 1.5);
          if (c.stage === 'spent' && c.gone < 1) c.gone = Math.min(1, c.gone + realDt / 2.5);
        }
      }
    }

    updateParticles(dt) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.age += dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.98; p.vy *= 0.98;
        if (p.age > p.life) this.particles.splice(i, 1);
      }
    }
  }

  /** A fraction as a whole percentage, rounded down (so 9.6% never reads as 10%), and "<1%" for a nearly empty tank. */
  Flight.pct = (frac) => (frac > 0 && frac < 0.01 ? '<1%' : Math.floor(frac * 100 + 1e-9) + '%');

  SB.Flight = Flight;
})(typeof window !== 'undefined' ? window : globalThis);
