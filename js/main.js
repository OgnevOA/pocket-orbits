/*
 * App shell: screens (hangar / flight), views (flight / map), game loop, map camera.
 */
(function (root) {
  'use strict';
  const SB = root.SB;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  class MapView {
    constructor(app) {
      this.app = app;
      this.scale = 1e-3;
      this.focus = 'auto';
      this.pan = [0, 0];
      // filled by the renderer each frame, used for mouse picking
      this.pick = [];
      this.nodeScreens = [];
      this.handles = [];
      this.hover = null;
      this.drag = null;
    }
    size() { const c = $('view'); return [c.clientWidth || 1200, c.clientHeight || 800]; }
    half() { const [W, H] = this.size(); return Math.min(W, H) / 2; }
    /** Usable half-size for "fit" views, keeping clear of the HUD side panels and control deck. */
    fitHalf() { const [W, H] = this.size(); return Math.max(150, Math.min(H / 2 - 70, (W - 640) / 2)); }
    focusPoint(t) {
      const f = this.app.flight, sys = this.app.sys;
      let p;
      if (this.focus === 'craft') p = f.globalPos();
      else {
        const b = this.focus === 'auto' ? f.body : sys.byId(this.focus) || f.body;
        p = sys.bodyPos(b, t);
      }
      return [p[0] + this.pan[0], p[1] + this.pan[1]];
    }
    setFocus(id) { this.focus = id; this.pan = [0, 0]; }
    focusBody() {
      if (this.focus === 'craft') return null;
      return this.focus === 'auto' ? this.app.flight.body : this.app.sys.byId(this.focus);
    }
    zoom(k) { const h = this.half(); this.scale = clamp(this.scale * k, h / 4.2e6, h / 1500); }
    panBy(dx, dy) { this.pan[0] -= dx / this.scale; this.pan[1] += dy / this.scale; }
    fitOrbit() {
      const f = this.app.flight, b = f.body;
      let ext;
      if (f.isLanded() || f.situation === 'crashed') ext = b.radius * 2.5;
      else {
        const el = f.orbit();
        if (b.parent) ext = b.soi * 1.1;
        else ext = isFinite(el.ra) && el.ra < 3.1e6 ? el.ra * 1.1 : 3.1e6;
        ext = Math.max(ext, f.r() * 1.2, b.radius * 1.5);
        // include planned legs (around the current body) so a new maneuver's result is in view
        const plan = f.planner.plan;
        if (plan && !b.parent) {
          for (const L of plan.layers) for (const sg of L.segments) {
            if (sg.body !== b) continue;
            const P = sg.points;
            for (let k = 0; k < P.xs.length; k += 4) if (P.ts[k] <= L.drawUntil) ext = Math.max(ext, Math.min(3.1e6, Math.hypot(P.xs[k], P.ys[k]) * 1.1));
          }
        }
      }
      this.focus = 'auto';
      this.pan = [0, 0];
      this.scale = this.fitHalf() / ext;
    }
    fitSystem() { this.focus = this.app.sys.planet.id; this.pan = [0, 0]; this.scale = this.half() / 3.05e6; }
    focusOn(id, extent) { this.focus = id; this.pan = [0, 0]; this.scale = this.half() / extent; }
    bodyAt(x, y) {
      const [W, H] = this.size();
      const t = this.app.flight.st.t;
      const fp = this.focusPoint(t);
      let best = null, bd = 1e9;
      for (const b of this.app.sys.bodies) {
        const p = this.app.sys.bodyPos(b, t);
        const sx = W / 2 + (p[0] - fp[0]) * this.scale, sy = H / 2 - (p[1] - fp[1]) * this.scale;
        const d = Math.hypot(sx - x, sy - y) - Math.max(10, b.radius * this.scale);
        if (d < bd) { bd = d; best = b; }
      }
      return bd < 8 ? best : null;
    }
  }

  const App = {
    init() {
      this.sys = new SB.PlanetSystem(SB.CONFIG);
      this.screen = 'hangar';
      this.view = 'flight';
      this.flight = null;
      this.flightView = { zoom: 14 };
      this.mapView = new MapView(this);
      this.canvas = $('view');
      this.ctx = this.canvas.getContext('2d');
      if (SB.Planets) SB.Planets.init();
      if (SB.Audio) SB.Audio.init();
      this.hangar = new SB.Hangar(this);
      this.ui = new SB.FlightUI(this);
      $('btnHelpH').addEventListener('click', () => this.toggleHelp());
      $('help').addEventListener('click', (e) => { if (e.target.id === 'help' || e.target.closest('[data-close]')) this.toggleHelp(false); });
      this.last = performance.now();
      requestAnimationFrame((t) => this.loop(t));
    },

    launch(design) {
      this.launchDesign = SB.Craft.cloneDesign(design);
      this.flight = new SB.Flight(this.sys, this.launchDesign);
      this.flightView.zoom = 14;
      this.screen = 'flight';
      this.view = 'flight';
      $('hangar').classList.add('hidden');
      $('flight').classList.remove('hidden');
      this.ui.onNewFlight();
      this.flight.msg(`${design.name} on the pad · throttle ${Math.round(this.flight.throttle * 100)}% · press Space to launch`, 'info');
    },

    revert() { if (this.launchDesign) this.launch(this.launchDesign); },

    toHangar() {
      this.screen = 'hangar';
      $('flight').classList.add('hidden');
      $('hangar').classList.remove('hidden');
      this.hangar.render();
    },

    setView(v) {
      this.view = v;
      if (v === 'map') this.mapView.fitOrbit();
    },
    toggleView() { this.setView(this.view === 'map' ? 'flight' : 'map'); },

    zoom(k) {
      if (this.view === 'map') this.mapView.zoom(k);
      else this.flightView.zoom = clamp(this.flightView.zoom * k, 0.0004, 60);
    },

    toggleHelp(show) {
      const h = $('help');
      const vis = show === undefined ? h.classList.contains('hidden') : show;
      h.classList.toggle('hidden', !vis);
      if (this.flight && this.screen === 'flight') this.flight.paused = vis || !$('menu').classList.contains('hidden');
    },

    loop(now) {
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      if (this.screen === 'flight' && this.flight) {
        if (SB.Planets) SB.Planets.noteFrame(dt * 1000);
        this.flight.update(dt);
        this.render();
        this.ui.update();
      }
      if (SB.Audio) SB.Audio.update(this);
      requestAnimationFrame((t) => this.loop(t));
    },

    render() {
      const cv = this.canvas, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.view === 'map') SB.Render.renderMap(ctx, W, H, this);
      else SB.Render.renderFlight(ctx, W, H, this);
    },

    /**
     * Developer scenarios (used by the automated UI checks and handy from the console):
     * 'orbit', 'transfer', 'landed', 'crash', 'surface' (+ body id).
     */
    debugScenario(name, arg) {
      const sys = this.sys, P = sys.planet;
      const p0 = SB.CONFIG.presets[0];
      this.launch(SB.Craft.makeDesign(p0.name, p0.parts));
      const f = this.flight;
      f.stage(); f.stage();
      f.setThrottle(0);
      f.launchTime = 0;
      const setOrbit = (r, v, ang) => {
        f.situation = 'flying';
        f.st.body = P;
        f.st.rx = Math.cos(ang) * r; f.st.ry = Math.sin(ang) * r;
        f.st.vx = Math.sin(ang) * v; f.st.vy = -Math.cos(ang) * v; // clockwise, like the moons
        f.heading = Math.atan2(f.st.vy, f.st.vx);
        f.setSas('prograde', true);
        f.predDirty = true;
      };
      const flatNear = (body, a) => {
        const step = 3 / body.radius;
        for (let k = 0; k < 400000; k++) {
          const x = a + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
          let ok = true;
          for (let j = -4; j <= 4 && ok; j++) ok = Math.abs(sys.surfaceFrame(body, x + j * step).slope) < 0.05;
          if (ok) return x;
        }
        return a;
      };
      const result = { scenario: name };
      if (name === 'orbit') {
        setOrbit(P.radius + 25000, Math.sqrt(P.mu / (P.radius + 25000)), Math.PI / 2);
      } else if (name === 'transfer') {
        const pock = sys.byId('pock');
        const r = P.radius + 25000;
        setOrbit(r, Math.sqrt(P.mu / r), Math.PI / 2);
        f.setTarget(pock);
        const info = f.transferInfo(pock);
        const mAng = pock.startAngle + pock.meanMotion * f.st.t;
        const craftAng = mAng + info.ideal; // moon leads by the ideal phase (clockwise travel)
        let best = null;
        for (let dv = -6; dv <= 8 && !best; dv += 0.25) {
          setOrbit(r, Math.sqrt(P.mu / r) + info.dv + dv, craftAng);
          f.maybePredict(true);
          const seg = f.prediction.segments.find((s) => s.body === pock);
          const pe = seg && seg.marks.find((m) => m.type === 'pe');
          if (pe && pe.alt > 3000 && pe.alt < 12000) best = { dv: info.dv + dv, pe: pe.alt };
        }
        if (best) setOrbit(r, Math.sqrt(P.mu / r) + best.dv, craftAng);
        f.maybePredict(true);
        result.encounter = !!(f.prediction && f.prediction.events.some((e) => e.type === 'soi' && e.to === pock));
        result.pe = best && best.pe;
        result.burn = best && best.dv;
      } else if (name === 'landed' || name === 'crash' || name === 'surface') {
        const body = sys.byId(name === 'surface' ? arg || 'pock' : 'pock');
        let a0 = 1.2;
        if (name === 'surface') {
          // stand near the tallest feature so its silhouette is in view
          const T = body.terrain;
          let im = 0;
          for (let i = 0; i < T.N; i++) if (T.h[i] > T.h[im]) im = i;
          a0 = (im / T.N) * Math.PI * 2 + 2600 / body.radius;
        }
        const a = flatNear(body, a0);
        f.placeOnSurface(body, a);
        if (name === 'crash') {
          const sf = sys.surfaceFrame(body, a);
          const n = [Math.cos(sf.normal), Math.sin(sf.normal)];
          f.st.rx += n[0] * 40; f.st.ry += n[1] * 40;
          f.st.vx = -n[0] * 18; f.st.vy = -n[1] * 18;
          f.situation = 'flying';
        } else {
          f.situation = 'landed';
          if (name === 'landed') {
            f.outcome = { type: 'landed', body, descent: 1.4, horizontal: 0.3, tilt: 1.2, slope: Math.abs(sys.surfaceFrame(body, a).slope) * 57.3, legs: true, limits: SB.CONFIG.landing.withLegs, reasons: [], t: f.st.t };
          }
          this.flightView.zoom = name === 'surface' ? 0.16 : 7;
        }
        result.body = body.id;
      }
      f.maybePredict(true);
      return result;
    },
  };

  root.APP = App;
  window.addEventListener('DOMContentLoaded', () => App.init());
})(typeof window !== 'undefined' ? window : globalThis);
