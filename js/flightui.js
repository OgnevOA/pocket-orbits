/*
 * Flight UI: keyboard + on-screen controls, HUD telemetry, staging stack, map panel,
 * landing/crash outcome overlay and pause menu.
 */
(function (root) {
  'use strict';
  const SB = root.SB;
  const DEG = 180 / Math.PI;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSpeed(v) { return `${Math.abs(v) < 100 ? v.toFixed(1) : Math.round(v).toLocaleString()} m/s`; }
  function fmtClock(s) {
    s = Math.max(0, Math.floor(s));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    const hh = String(h).padStart(2, '0'), mm = String(m).padStart(2, '0'), ss = String(x).padStart(2, '0');
    return (d ? d + 'd ' : '') + `${hh}:${mm}:${ss}`;
  }

  class FlightUI {
    constructor(app) {
      this.app = app;
      this.held = {};
      this.lastText = -1;
      this.lastMap = -1;
      this.outcomeShown = null;
      this.lastFrame = performance.now();
      this.dialCtx = $('dial').getContext('2d');
      this.bind();
      this.buildNodePanel();
      this.buildMapPanel();
    }

    get f() { return this.app.flight; }

    // ------------------------------------------------------------ input
    syncInputs() {
      const f = this.f;
      if (!f) return;
      const H = this.held;
      const fine = H.Shift ? 0.25 : 1;
      f.throttleInput = ((H.up ? 1 : 0) - (H.down ? 1 : 0)) * fine;
      f.rotInput = (H.left ? 1 : 0) - (H.right ? 1 : 0);
    }

    bind() {
      const keymap = {
        KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
        KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
        ShiftLeft: 'Shift', ShiftRight: 'Shift',
      };
      window.addEventListener('keydown', (e) => {
        if (this.app.screen !== 'flight' || !this.f) return;
        if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const f = this.f;
        if (e.code === 'Escape') { e.preventDefault(); if (!$('help').classList.contains('hidden')) this.app.toggleHelp(false); else this.toggleMenu(); return; }
        if (f.paused) return;
        if (keymap[e.code]) { this.held[keymap[e.code]] = true; this.syncInputs(); if (e.code.startsWith('Arrow')) e.preventDefault(); return; }
        if (e.repeat) { if (['Space', 'Tab'].includes(e.code)) e.preventDefault(); return; }
        switch (e.code) {
          case 'Space': e.preventDefault(); f.stage(); break;
          case 'KeyZ': f.setThrottle(1); break;
          case 'KeyX': f.setThrottle(0); break;
          case 'KeyT': f.toggleStability(); break;
          case 'KeyP': f.setSas('prograde'); break;
          case 'KeyR': f.setSas('retrograde'); break;
          case 'KeyV': f.setSas('maneuver'); break;
          case 'KeyU': this.toggleSound(); break;
          case 'Delete': case 'Backspace': {
            const n = f.planner.selected;
            if (n) { e.preventDefault(); f.planner.remove(n); f.msg('Maneuver node deleted', 'info', 'node'); }
            break;
          }
          case 'Period': f.warpUp(); break;
          case 'Comma': f.warpDown(); break;
          case 'Slash': f.stopWarp(); break;
          case 'KeyM': this.app.toggleView(); break;
          case 'Tab': e.preventDefault(); this.cycleFocus(); break;
          case 'KeyN': this.cycleTarget(); break;
          case 'Equal': case 'NumpadAdd': this.app.zoom(1.25); break;
          case 'Minus': case 'NumpadSubtract': this.app.zoom(0.8); break;
          case 'KeyH': this.app.toggleHelp(); break;
          default: return;
        }
      });
      window.addEventListener('keyup', (e) => {
        if (keymap[e.code]) { this.held[keymap[e.code]] = false; this.syncInputs(); }
      });
      window.addEventListener('blur', () => { this.held = {}; this.syncInputs(); });

      const hold = (id, key) => {
        const el = $(id);
        const on = (e) => { e.preventDefault(); this.held[key] = true; this.syncInputs(); el.classList.add('pressed'); };
        const off = () => { this.held[key] = false; this.syncInputs(); el.classList.remove('pressed'); };
        el.addEventListener('pointerdown', on);
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, off));
      };
      hold('thrUp', 'up'); hold('thrDown', 'down'); hold('rotL', 'left'); hold('rotR', 'right');
      const click = (id, fn) => $(id).addEventListener('click', () => { if (this.f) fn(this.f); });
      click('thrMax', (f) => f.setThrottle(1));
      click('thrCut', (f) => f.setThrottle(0));
      click('btnStage', (f) => f.stage());
      click('wUp', (f) => f.warpUp());
      click('wDown', (f) => f.warpDown());
      click('wStop', (f) => f.stopWarp());
      $('throttleSlider').addEventListener('input', (e) => { if (this.f) this.f.setThrottle(+e.target.value / 100); });
      document.querySelectorAll('#sasButtons button').forEach((b) => b.addEventListener('click', () => { if (this.f) this.f.setSas(b.dataset.mode); }));
      $('btnMap').addEventListener('click', () => this.app.toggleView());
      $('btnSound').addEventListener('click', () => this.toggleSound());
      $('volumeSlider').addEventListener('input', (e) => {
        if (!SB.Audio) return;
        SB.Audio.unlock();
        SB.Audio.setVolume(+e.target.value / 100);
        this.syncSoundUi();
      });
      $('btnHelpF').addEventListener('click', () => this.app.toggleHelp());
      $('btnMenu').addEventListener('click', () => this.toggleMenu());

      // Clicked buttons must not keep keyboard focus, or Space would also "click" them again.
      $('flight').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });
      $('outcome').addEventListener('click', (e) => this.onAction(e));
      $('menu').addEventListener('click', (e) => this.onAction(e));
      $('mapPanel').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !this.f) return;
        if (b.dataset.target !== undefined) this.f.setTarget(b.dataset.target ? this.app.sys.byId(b.dataset.target) : null);
        if (b.dataset.focus !== undefined) { this.app.mapView.setFocus(b.dataset.focus); }
        if (b.dataset.fit) { b.dataset.fit === 'orbit' ? this.app.mapView.fitOrbit() : this.app.mapView.fitSystem(); }
        this.lastMap = -1;
      });

      // Map canvas: wheel zoom; drag to pan; click the trajectory to add a maneuver node;
      // drag a node along its path to retime it; drag its handles to shape the burn;
      // click a moon to target it, double-click to focus it.
      const cv = $('view');
      const mv = () => this.app.mapView;
      cv.addEventListener('wheel', (e) => { e.preventDefault(); this.app.zoom(Math.pow(1.0018, -e.deltaY)); }, { passive: false });
      const near = (list, x, y, r) => {
        let best = null, bd = r;
        for (const it of list || []) { const d = Math.hypot(it.x - x, it.y - y); if (d < bd) { bd = d; best = it; } }
        return best;
      };
      let drag = null;
      cv.addEventListener('pointerdown', (e) => {
        if (this.app.view !== 'map' || !this.f || e.button !== 0) return;
        const x = e.offsetX, y = e.offsetY;
        cv.setPointerCapture(e.pointerId);
        const pl = this.f.planner;
        const h = near(mv().handles, x, y, 12);
        if (h) {
          pl.selected = h.node;
          mv().drag = { node: h.node, comp: h.comp, sign: h.sign, ax: h.ax, ox: h.x, oy: h.y, d: 0 };
          drag = { kind: 'handle' };
          return;
        }
        const n = near(mv().nodeScreens, x, y, 11);
        if (n) { pl.selected = n.node; drag = { kind: 'node', node: n.node, x: e.clientX, y: e.clientY, moved: false }; return; }
        drag = { kind: 'pan', x: e.clientX, y: e.clientY, moved: false };
      });
      cv.addEventListener('pointermove', (e) => {
        if (this.app.view !== 'map' || !this.f) return;
        const x = e.offsetX, y = e.offsetY;
        if (!drag) {
          const overNode = near(mv().handles, x, y, 12) || near(mv().nodeScreens, x, y, 11);
          mv().hover = overNode ? null : this.pickTrajectory(x, y);
          cv.style.cursor = overNode ? 'grab' : mv().hover ? 'copy' : 'default';
          return;
        }
        if (drag.kind === 'handle') {
          const D = mv().drag;
          D.d = Math.max(-34, Math.min(170, (x - D.ox) * D.ax[0] + (y - D.oy) * D.ax[1]));
          return;
        }
        if (drag.kind === 'node') {
          if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) drag.moved = true;
          if (drag.moved) {
            const pl = this.f.planner;
            const p = this.pickTrajectory(x, y, { layer: pl.indexOf(drag.node), anywhere: true });
            if (p) pl.setTime(drag.node, p.t);
          }
          return;
        }
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (drag.moved) { mv().panBy(dx, dy); drag.x = e.clientX; drag.y = e.clientY; }
      });
      const end = (e) => {
        const d = drag;
        drag = null;
        if (!d || !this.f) return;
        if (d.kind === 'handle') { mv().drag = null; return; }
        if (d.kind !== 'pan' || d.moved || e.type !== 'pointerup') return;
        const x = e.offsetX, y = e.offsetY;
        const p = this.pickTrajectory(x, y);
        const m = mv().bodyAt(x, y);
        if (p) {
          this.f.planner.add(p.t);
          mv().hover = null;
          this.f.msg('Maneuver node added: drag its handles, or use the panel', 'info', 'node');
        } else if (m && m.parent) { this.f.setTarget(this.f.target === m ? null : m); this.lastMap = -1; }
        else this.f.planner.selected = null;
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => { if (!drag) mv().hover = null; });
      cv.addEventListener('dblclick', (e) => {
        if (this.app.view !== 'map') return;
        const m = mv().bodyAt(e.offsetX, e.offsetY);
        mv().setFocus(m ? m.id : 'auto');
      });
    }

    /**
     * Nearest point of a drawn trajectory to (x, y) on the map. Without options: within 10 px,
     * in the future, and on a part of a path where a new node can go. With {layer, anywhere}:
     * nearest point of that leg at any distance (for dragging a node along its path).
     */
    pickTrajectory(x, y, opt) {
      opt = opt || {};
      const now = this.f.st.t;
      let best = null, bd = opt.anywhere ? Infinity : 10;
      for (const p of this.app.mapView.pick || []) {
        if (opt.layer !== undefined && p.layer !== opt.layer) continue;
        for (let k = 0; k < p.xs.length; k++) {
          const tk = p.ts[k];
          if (tk <= now + 2 || (!opt.anywhere && tk >= p.maxT)) continue;
          const d = Math.hypot(p.xs[k] - x, p.ys[k] - y);
          if (d < bd) { bd = d; best = { x: p.xs[k], y: p.ys[k], t: tk, layer: p.layer }; }
        }
      }
      return best;
    }

    toggleSound() {
      if (!SB.Audio) return;
      SB.Audio.unlock();
      const on = SB.Audio.toggle();
      if (this.f) this.f.msg(on ? 'Sound on' : 'Sound off', 'info', 'sound');
      this.syncSoundUi();
    }

    syncSoundUi() {
      if (!SB.Audio) return;
      const on = SB.Audio.enabled && SB.Audio.volume > 0;
      const b = $('btnSound');
      b.textContent = on ? 'Sound · U' : 'Muted · U';
      b.classList.toggle('muted', !on);
      const v = Math.round(SB.Audio.volume * 100);
      const sl = $('volumeSlider');
      if (document.activeElement !== sl) sl.value = v;
      $('volumeLabel').textContent = v + '%';
    }

    cycleTarget() {
      const f = this.f, moons = this.app.sys.moons;
      const i = f.target ? moons.indexOf(f.target) : -1;
      f.setTarget(i + 1 < moons.length ? moons[i + 1] : null);
      f.msg(f.target ? `Target: ${f.target.name}` : 'Target cleared', 'info', 'target');
    }

    cycleFocus() {
      const order = ['auto', 'craft'].concat(this.app.sys.bodies.map((b) => b.id));
      const mv = this.app.mapView;
      const i = order.indexOf(mv.focus);
      mv.setFocus(order[(i + 1) % order.length]);
      if (this.app.view !== 'map') this.app.setView('map');
    }

    onAction(e) {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'continue') { this.hideOutcome(); }
      if (act === 'resume') this.toggleMenu(false);
      if (act === 'revert') { this.toggleMenu(false); this.app.revert(); }
      if (act === 'hangar') { this.toggleMenu(false); this.app.toHangar(); }
      if (act === 'help') { this.app.toggleHelp(true); }
    }

    toggleMenu(show) {
      const m = $('menu');
      const vis = show === undefined ? m.classList.contains('hidden') : show;
      m.classList.toggle('hidden', !vis);
      if (this.f) this.f.paused = vis;
    }

    onNewFlight() {
      this.syncSoundUi();
      this.held = {};
      this.outcomeShown = null;
      this.hideOutcome();
      this.toggleMenu(false);
      this.lastText = -1;
      this.lastMap = -1;
      $('messages').innerHTML = '';
    }

    // ------------------------------------------------------------ outcome
    showOutcome(o) {
      const el = $('outcome');
      const ok = o.type === 'landed';
      const L = o.limits;
      const row = (k, v, lim, bad) => `<div class="kv"><span>${k}</span><b class="${bad ? 'bad' : 'good'}">${v}</b><small>${lim}</small></div>`;
      el.innerHTML = `<div class="card ${ok ? 'oc-ok' : 'oc-bad'}">
        <div class="oc-kicker">${ok ? 'Touchdown' : 'Mission failed'}</div>
        <h2>${ok ? 'LANDED on ' + esc(o.body.name) : 'CRASHED into ' + esc(o.body.name)}</h2>
        ${row('Descent rate', fmtSpeed(o.descent), `limit ${L.maxDescent} m/s`, o.descent > L.maxDescent)}
        ${row('Horizontal speed', fmtSpeed(o.horizontal), `limit ${L.maxHorizontal} m/s`, o.horizontal > L.maxHorizontal)}
        ${row('Tilt', o.tilt.toFixed(1) + '°', `limit ${L.maxTiltDeg}°`, o.tilt > L.maxTiltDeg)}
        ${row('Ground slope', o.slope.toFixed(1) + '°', 'limit 25°', o.slope > 25)}
        <div class="kv"><span>Landing legs</span><b>${o.legs ? 'yes' : 'no (strict limits)'}</b><small></small></div>
        ${o.reasons.length ? '<ul class="reasons">' + o.reasons.map((r) => `<li>${esc(r)}</li>`).join('') + '</ul>' : ''}
        <div class="actions">
          ${ok ? '<button data-act="continue" class="primary">Continue flying</button>' : ''}
          <button data-act="revert">Revert to launch</button>
          <button data-act="hangar">Back to hangar</button>
        </div></div>`;
      el.classList.remove('hidden');
    }
    hideOutcome() { $('outcome').classList.add('hidden'); }

    // ------------------------------------------------------------ per-frame update
    update() {
      const f = this.f;
      if (!f) return;
      SB.Render.renderDial(this.dialCtx, 150, f);
      const now = performance.now();
      if (f.outcome && this.outcomeShown !== f.outcome) {
        this.outcomeShown = f.outcome;
        const delay = f.outcome.type === 'crashed' ? 900 : 300;
        setTimeout(() => { if (this.f === f && f.outcome === this.outcomeShown) this.showOutcome(f.outcome); }, delay);
      }
      $('throttleFill').style.height = (f.throttle * 100).toFixed(1) + '%';
      const sl = $('throttleSlider');
      if (document.activeElement !== sl) sl.value = Math.round(f.throttle * 100);
      $('throttleLabel').textContent = Math.round(f.throttle * 100) + '%';
      document.querySelectorAll('#sasButtons button').forEach((b) => b.classList.toggle('active', b.dataset.mode === f.sas));
      const rate = f.warpRate();
      const lim = f.maxWarpIndex();
      $('warpLabel').textContent = rate + '×';
      $('warpMode').textContent = rate === 1 ? 'real time' : rate > SB.CONFIG.sim.maxPhysicsWarp ? 'on rails' : 'physics';
      $('warpNote').textContent = lim.index < f.warpLevels().length - 1 && lim.reason ? 'max ' + f.warpLevels()[lim.index] + '× · ' + lim.reason : '';
      $('warpBox').classList.toggle('warping', rate > 1);
      $('situation').textContent = f.situationText();
      $('clock').textContent = 'T+ ' + fmtClock(f.missionTime());
      $('btnMap').classList.toggle('active', this.app.view === 'map');
      $('mapPanel').classList.toggle('hidden', this.app.view !== 'map');
      $('flight').classList.toggle('view-map', this.app.view === 'map');
      this.renderMessages();
      // dragging a node handle changes delta-v at a rate that grows with the drag distance
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      const D = this.app.mapView.drag;
      if (D && this.app.view === 'map' && f.planner.nodes.includes(D.node)) {
        const rate = Math.sign(D.d) * Math.pow(Math.abs(D.d) / 25, 2) * 6;
        if (rate) f.planner.nudge(D.node, D.comp, D.sign * rate * dt);
      }
      $('nodePanel').classList.toggle('hidden', !(this.app.view === 'map' || f.planner.count > 0));
      if (now - this.lastText > 100) { this.lastText = now; this.renderTelemetry(); this.renderStages(); this.renderNodePanel(); }
      if (this.app.view === 'map' && now - this.lastMap > 250) { this.lastMap = now; this.renderMapPanel(); }
    }

    // ------------------------------------------------------------ maneuver node panel
    buildNodePanel() {
      const el = $('nodePanel');
      const dvRow = (comp) => `<div class="np-row" data-comp="${comp}">
          <button data-dv="-10">−10</button><button data-dv="-1">−1</button><button data-dv="-0.1">−.1</button>
          <input type="number" step="0.1" data-input="${comp}" aria-label="${comp === 'pro' ? 'Prograde' : 'Radial'} delta-v (m/s)">
          <button data-dv="0.1">+.1</button><button data-dv="1">+1</button><button data-dv="10">+10</button></div>`;
      el.innerHTML = `
        <div class="np-head"><h4>Maneuver <span id="npIdx"></span></h4>
          <span class="np-nav"><button class="icon" id="npPrev" title="Previous node">◀</button><button class="icon" id="npNext" title="Next node">▶</button></span></div>
        <div id="npInfo"></div>
        <div id="npEdit">
          <div class="np-lbl"><span class="c-pro">Prograde</span><small>m/s</small></div>${dvRow('pro')}
          <div class="np-lbl"><span class="c-rad">Radial out</span><small>m/s</small></div>${dvRow('rad')}
          <div class="np-lbl"><span>Time</span><b id="npTimeV"></b></div>
          <div class="np-row time"><button data-dt="orbit:-1" title="One orbit earlier">−orb</button><button data-dt="-60">−1m</button><button data-dt="-10">−10s</button><button data-dt="-1">−1s</button><button data-dt="1">+1s</button><button data-dt="10">+10s</button><button data-dt="60">+1m</button><button data-dt="orbit:1" title="One orbit later">+orb</button></div>
        </div>
        <div class="np-actions" id="npActions">
          <button id="npHold" title="Point along the remaining burn (V)">Hold burn <small>V</small></button>
          <button id="npWarp" title="Warp until shortly before the burn starts">Warp to burn</button>
          <button id="npDel" class="danger" title="Delete this node (Del)">Delete</button>
        </div>
        <p class="note" id="npHint"></p>`;
      const act = (b) => {
        const f = this.f;
        const n = f && f.planner.selected;
        if (!n) return;
        if (b.dataset.dv) f.planner.nudge(n, b.closest('[data-comp]').dataset.comp, +b.dataset.dv);
        if (b.dataset.dt) {
          const v = b.dataset.dt;
          if (v.startsWith('orbit:')) {
            const T = f.planner.orbitPeriod(n);
            if (T) f.planner.shiftTime(n, T * +v.slice(6));
            else f.msg('This node is not on a closed orbit', 'warn', 'node');
          } else f.planner.shiftTime(n, +v);
        }
        this.lastText = -1;
      };
      // press and hold to repeat (pointerdown acts at once, so fast clicking is never lost)
      const stop = () => { clearTimeout(this._repT); clearInterval(this._repI); };
      el.addEventListener('pointerdown', (e) => {
        const b = e.target.closest('[data-dv],[data-dt]');
        if (!b || e.button !== 0) return;
        e.preventDefault();
        stop();
        act(b);
        this._repT = setTimeout(() => { this._repI = setInterval(() => act(b), 70); }, 380);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, stop));
      el.addEventListener('keydown', (e) => {
        const b = e.target.closest && e.target.closest('[data-dv],[data-dt]');
        if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act(b); }
      });
      el.addEventListener('change', (e) => {
        const inp = e.target.closest('[data-input]');
        const f = this.f, n = f && f.planner.selected;
        if (!inp || !n) return;
        const v = parseFloat(inp.value);
        if (!isFinite(v)) return;
        if (inp.dataset.input === 'pro') f.planner.setComps(n, v, n.rad); else f.planner.setComps(n, n.pro, v);
        inp.blur();
      });
      const cycle = (d) => {
        const pl = this.f && this.f.planner;
        if (!pl || !pl.count) return;
        const i = pl.indexOf(pl.selected);
        pl.selected = pl.nodes[(i + d + pl.count) % pl.count];
        this.lastText = -1;
      };
      $('npPrev').addEventListener('click', () => cycle(-1));
      $('npNext').addEventListener('click', () => cycle(1));
      $('npHold').addEventListener('click', () => { if (this.f) this.f.setSas('maneuver'); });
      $('npWarp').addEventListener('click', () => {
        const f = this.f;
        if (!f || !f.planner.count) return;
        f.setThrottle(0);
        f.setWarp(f.warpLevels().length - 1);
      });
      $('npDel').addEventListener('click', () => {
        const f = this.f, n = f && (f.planner.selected || f.planner.first());
        if (n) { f.planner.remove(n); this.lastText = -1; }
      });
    }

    renderNodePanel() {
      const f = this.f, pl = f.planner;
      const inMap = this.app.view === 'map';
      if (!pl.selected && pl.count) pl.selected = pl.first();
      const n = pl.selected;
      const D = SB.Render.fmtDur, A = SB.Render.fmtAlt;
      $('npEdit').classList.toggle('hidden', !n || !inMap);
      $('npActions').classList.toggle('hidden', !n);
      $('npPrev').parentElement.classList.toggle('hidden', pl.count < 2);
      $('npIdx').textContent = n ? `${pl.indexOf(n) + 1} of ${pl.count}` : '';
      $('npHint').textContent = n ? (inMap ? 'Drag the node along the path to retime it, or drag its handles.' : '')
        : 'Click your trajectory on the map to add a maneuver node.';
      $('npHold').classList.toggle('active', f.sas === 'maneuver');
      let html = '';
      if (n) {
        const inf = pl.info(n);
        const now = f.st.t;
        const kv = (k, v, cls) => `<div class="kv ${cls || ''}"><span>${k}</span><b>${v}</b></div>`;
        html += kv('Node in', n.t > now ? D(n.t - now) : `passed ${D(now - n.t)} ago`);
        if (!inf || !inf.valid) html += '<p class="note warn">Unreachable: the craft hits the surface before this node.</p>';
        else {
          const first = n === pl.first();
          html += kv(first ? 'Δv remaining' : 'Δv', `${inf.total.toFixed(1)} m/s`);
          const b = inf.burn;
          if (b && b.time > 0) {
            const start = n.t - b.time / 2 - now;
            html += kv('Burn', `${b.time < 10 ? b.time.toFixed(1) : Math.round(b.time)} s${b.stages ? ` · ${b.stages} staging` : ''}`);
            if (first) html += kv('Start burn', start > 0 ? `in ${D(start)}` : n.t + b.time / 2 > now ? 'NOW' : 'late', start <= 0 && start > -b.time ? 'hot' : '');
            if (b.short > 0) html += `<p class="note warn">Not enough fuel: ${Math.round(b.short)} m/s short.</p>`;
          } else if (inf.total > 0.05) html += '<p class="note warn">No engine with fuel can make this burn.</p>';
          // what this node leads to (until the next node)
          const L = inf.layer, s0 = L && L.segments[0];
          if (s0) {
            const el = s0.el, body = s0.body;
            if (el.e < 1 && (!body.parent || el.ra < body.soi)) html += kv('Then', `${A(el.ra - body.radius)} × ${A(el.rp - body.radius)}`);
            else html += kv('Then', el.e >= 1 ? `escape from ${body.name}` : `leaves ${body.name}'s SOI`);
            const lim = L.drawUntil;
            for (const ev of L.events) {
              if (ev.t > lim) break;
              if (ev.type === 'soi' && ev.to.parent) {
                const seg = L.segments.find((sg) => sg.body === ev.to && sg.t0 >= ev.t - 1e-6);
                const pe = seg && seg.marks.find((m) => m.type === 'pe');
                html += kv(`${ev.to.name} encounter`, pe ? `Pe ${A(pe.alt)}` : 'impact', 'enc');
              } else if (ev.type === 'impact') html += kv('Impact', `${ev.body.name} in ${D(ev.t - now)}`, 'warn');
            }
          }
        }
        if (inMap) {
          $('npTimeV').textContent = n.t > now ? 'T−' + D(n.t - now) : 'passed';
          for (const inp of document.querySelectorAll('#nodePanel [data-input]')) {
            if (document.activeElement !== inp) { const v = inp.dataset.input === 'pro' ? n.pro : n.rad; inp.value = (Math.abs(v) < 0.05 ? 0 : v).toFixed(1); }
          }
        }
      }
      const info = $('npInfo');
      if (info._html !== html) { info.innerHTML = html; info._html = html; }
    }

    renderMessages() {
      const f = this.f;
      const t = f.realClock;
      const html = f.messages.filter((m) => t - m.time < 5).map((m) => `<div class="msg ${m.kind}" style="opacity:${Math.min(1, 5 - (t - m.time)).toFixed(2)}">${esc(m.text)}</div>`).join('');
      const el = $('messages');
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }

    renderTelemetry() {
      const f = this.f;
      const b = f.body;
      const rows = [];
      const row = (k, v, cls) => rows.push(`<div class="t-row ${cls || ''}"><span>${k}</span><b>${v}</b></div>`);
      const bar = (frac, cls) => rows.push(`<div class="t-bar ${cls || ''}"><i style="width:${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%"></i></div>`);
      const alt = f.altitude();
      row('ALT', SB.Render.fmtAlt(alt));
      const radar = f.radarAltitude();
      if (radar < 20000 && f.situation !== 'crashed') row('RADAR', SB.Render.fmtAlt(Math.max(0, radar)), radar < 500 ? 'hot' : '');
      const vs = f.verticalSpeed(), hs = f.horizontalSpeed();
      row('V.SPD', `${vs >= 0 ? '+' : '−'}${fmtSpeed(Math.abs(vs))} ${Math.abs(vs) < 0.05 ? '' : vs > 0 ? '↑' : '↓'}`);
      row('H.SPD', `${fmtSpeed(Math.abs(hs))} ${Math.abs(hs) < 0.05 ? '' : hs > 0 ? '←' : '→'}`);
      row('SPEED', fmtSpeed(f.speed()));
      if (!f.isLanded() && f.situation !== 'crashed') {
        const el = f.orbit();
        const ap = isFinite(el.ra) && (!b.parent || el.ra < b.soi) ? `${SB.Render.fmtAlt(el.ra - b.radius)} <small>${SB.Render.fmtDur(el.timeToAp)}</small>` : (el.e >= 1 ? 'escape' : 'beyond SOI');
        row('APOAPSIS', ap);
        const peAlt = el.rp - b.radius;
        row('PERIAPSIS', `${SB.Render.fmtAlt(peAlt)}${el.timeToPe > 0 && isFinite(el.timeToPe) ? ` <small>${SB.Render.fmtDur(el.timeToPe)}</small>` : ''}`, peAlt < (b.atmosphere ? b.atmosphere.height : 0) ? 'warn' : 'ok');
      }
      rows.push('<div class="t-sep"></div>');
      row('THROTTLE', Math.round(f.throttle * 100) + '%');
      bar(f.throttle, 'thr');
      const fuel = f.craft.activeStageFuel();
      const frac = fuel.max > 0 ? fuel.fuel / fuel.max : 0;
      row(fuel.active ? 'STAGE FUEL' : 'NEXT STAGE FUEL', fuel.max > 0 ? `${Math.round(fuel.fuel).toLocaleString()} kg · ${Math.round(frac * 100)}%` : 'none', fuel.max > 0 && frac < 0.1 ? 'warn' : '');
      bar(frac, frac < 0.1 ? 'low' : 'fuel');
      row('STAGE Δv', `${Math.round(f.craft.activeStageDv(f.pressureRatio())).toLocaleString()} m/s`);
      row('TWR', f.situation === 'crashed' ? '—' : f.twr().toFixed(2));
      row('MASS', `${Math.round(f.craft.mass()).toLocaleString()} kg`);
      if (b.atmosphere && alt < b.atmosphere.height) row('AIR', `${(f.pressureRatio() * 100).toFixed(0)}% sea level`);
      if (radar < 3000 && !f.isLanded()) {
        const sf = this.app.sys.surfaceFrame(b, Math.atan2(f.st.ry, f.st.rx));
        const slope = Math.abs(sf.slope) * DEG;
        row('GROUND', `slope ${slope.toFixed(0)}°`, slope > 25 ? 'warn' : '');
      }
      row('GRAVITY', `${f.localGravity().toFixed(2)} m/s²`);
      $('telemetry').innerHTML = rows.join('');
    }

    renderStages() {
      const f = this.f, c = f.craft;
      let html = '<h4>Staging</h4>';
      if (c.nextStage >= c.stages.length) html += '<div class="st-empty">All stages used</div>';
      for (let i = c.nextStage; i < c.stages.length; i++) {
        const items = c.stages[i].map((uid) => c.find(uid)).filter(Boolean);
        const parts = items.length ? items.map((p) => `<span class="tag ${p.role === 'engine' ? 'ignite' : 'decouple'}">${p.role === 'engine' ? 'IGNITE' : 'DECOUPLE'}</span> ${esc(p.def.name.split(' ')[0])}`).join('<br>') : '<i>nothing left to fire</i>';
        html += `<div class="st ${i === c.nextStage ? 'next' : ''}"><b>S${i + 1}</b>${i === c.nextStage ? ' <small>next · Space</small>' : ''}<div>${parts}</div></div>`;
      }
      const active = c.parts.filter((p) => c.active.has(p.uid));
      if (active.length) html += `<div class="st active"><b>Active</b><div>${active.map((p) => esc(p.def.name.split(' ')[0])).join(', ')}</div></div>`;
      const el = $('stageStack');
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }

    buildMapPanel() {
      $('mapPanel').innerHTML = `<div id="mpOrbit"></div>
        <h4>Target</h4><div id="mpTargetBtns" class="btnrow"></div><div id="mpTargetInfo"></div>
        <h4>View</h4><div id="mpView"></div>
        <p class="note">Wheel or +/− zoom · drag to pan · click a moon to target it · click your path to add a maneuver · Tab cycles focus</p>`;
    }

    renderMapPanel() {
      const f = this.f, sys = this.app.sys, b = f.body;
      const mv = this.app.mapView;
      const set = (id, html) => { const el = $(id); if (el._html !== html) { el.innerHTML = html; el._html = html; } };
      const kv = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
      const D = SB.Render.fmtDur, A = SB.Render.fmtAlt;
      let html = `<h4>Orbit · ${esc(b.name)}</h4>`;
      if (f.isLanded()) html += kv('Status', f.situationText());
      else if (f.situation === 'crashed') html += kv('Status', 'Crashed');
      else {
        const el = f.orbit();
        html += kv('Apoapsis', isFinite(el.ra) && (!b.parent || el.ra < b.soi) ? `${A(el.ra - b.radius)} · ${D(el.timeToAp)}` : '—');
        html += kv('Periapsis', `${A(el.rp - b.radius)}${el.timeToPe > 0 ? ' · ' + D(el.timeToPe) : ''}`);
        html += kv('Period', isFinite(el.period) ? D(el.period) : '—');
        html += kv('Eccentricity', el.e.toFixed(3));
        const ev = f.nextEvent();
        if (ev) html += kv('Next event', `${ev.type === 'soi' ? (ev.to.parent ? 'Enter ' + ev.to.name + ' SOI' : 'Leave ' + ev.from.name + ' SOI') : ev.type === 'atmo' ? 'Atmosphere' : 'Impact'} · ${D(ev.t - f.st.t)}`);
      }
      set('mpOrbit', html);

      let tb = '';
      for (const m of sys.moons) tb += `<button data-target="${m.id}" class="${f.target === m ? 'active' : ''}">${esc(m.name)}</button>`;
      tb += `<button data-target="" class="${!f.target ? 'active' : ''}">None</button>`;
      set('mpTargetBtns', tb);

      let ti = '';
      if (f.target) {
        const info = f.transferInfo(f.target);
        const circular = !f.isLanded() && f.situation !== 'crashed' && f.orbit().e < 0.15;
        const hasEnc = f.prediction && f.prediction.events.some((e) => e.type === 'soi' && e.to === f.target);
        if (info) {
          ti += kv('Phase angle', `${(info.phase * DEG).toFixed(1)}° <small>ideal ${(info.ideal * DEG).toFixed(1)}°</small>`);
          if (circular && !hasEnc) ti += kv('Transfer burn', `${info.dv.toFixed(0)} m/s prograde in ${D(info.wait)}`);
          if (!info.sameSense) ti += '<p class="note warn">You orbit opposite to the moons: transfers cost far more.</p>';
        }
        const plan = f.planner.plan;
        const src = plan && plan.layers.length ? plan.layers[plan.layers.length - 1] : f.prediction;
        const ca = src && src.closest;
        const tag = plan && plan.layers.length ? 'Planned ' : '';
        if (ca && ca.target === f.target) {
          ti += ca.encounter ? kv(tag + 'encounter', `Pe ${A(ca.dist - f.target.radius)}`) : kv(tag + 'closest approach', `${A(ca.dist)} <small>SOI ${A(f.target.soi)}</small>`);
        } else if (f.body === f.target) ti += '<p class="note">You are inside its sphere of influence.</p>';
      }
      set('mpTargetInfo', ti);

      let vb = '<div class="btnrow">';
      const foc = [['auto', 'Auto'], ['craft', 'Craft']].concat(sys.bodies.map((x) => [x.id, x.name]));
      for (const [id, name] of foc) vb += `<button data-focus="${id}" class="${mv.focus === id ? 'active' : ''}">${esc(name)}</button>`;
      vb += '</div><div class="btnrow"><button data-fit="orbit">Fit orbit</button><button data-fit="system">Whole system</button></div>';
      set('mpView', vb);
    }
  }

  SB.FlightUI = FlightUI;
})(typeof window !== 'undefined' ? window : globalThis);
