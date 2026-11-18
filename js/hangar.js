/*
 * Hangar: part catalogue, drag-and-drop stack assembly, staging editor, stats, saved designs.
 */
(function (root) {
  'use strict';
  const SB = root.SB;
  const C = () => SB.CONFIG;
  const STAGE_COLORS = ['#ff8f4f', '#4fd1ff', '#c792ff', '#7dffa8', '#ffd36b', '#ff6b9d', '#6bb8ff', '#d0ff6b'];
  const CATS = [['command', 'Command'], ['tank', 'Fuel tanks'], ['engine', 'Engines'], ['structural', 'Structural']];
  const fmtKg = (m) => `${Math.round(m).toLocaleString()} kg`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    read(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } },
    write(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } },
  };

  function partStats(type) {
    const d = C().parts[type];
    switch (SB.Craft.role(type)) {
      case 'tank': return `${fmtKg(d.dryMass + d.fuel)} wet · ${d.fuel} kg fuel`;
      case 'engine': return `${fmtKg(d.mass)} · ${(d.thrust / 1000).toFixed(0)} kN · Isp ${d.ispAsl}/${d.ispVac} s`;
      default: return fmtKg(d.mass);
    }
  }

  class Hangar {
    constructor(app) {
      this.app = app;
      this.canvas = document.getElementById('stackCanvas');
      this.ctx = this.canvas.getContext('2d');
      this.selected = null;
      this.hover = null;
      this.highlight = null;
      this.insertIndex = null;
      this.drag = null;
      this.rects = [];
      this.analysis = null;
      this.buildCatalog();
      this.buildPaintPanel();
      this.bindUi();
      const cur = SB.Craft.sanitizeDesign(store.read(C().storageKeys.current, null));
      this.setDesign(cur && cur.parts.length ? cur : this.preset(0), { keepSelection: false });
      this.refreshSelect();
    }

    preset(i) { const p = C().presets[i]; return SB.Craft.makeDesign(p.name, p.parts); }
    savedDesigns() { return store.read(C().storageKeys.designs, {}) || {}; }

    // ------------------------------------------------------------ model edits
    setDesign(d, opts) {
      this.design = SB.Craft.sanitizeDesign(SB.Craft.cloneDesign(d)) || this.preset(0);
      if (!opts || !opts.keepSelection) this.selected = null;
      document.getElementById('designName').value = this.design.name;
      this.changed(false);
    }

    changed(structural) {
      const d = this.design;
      if (structural !== false) d.stages = SB.Craft.reconcileStages(d.parts, d.stages, d.customStaging);
      this.analysis = SB.Craft.analyzeDesign(d, this.app.sys);
      store.write(C().storageKeys.current, d);
      this.renderInfo();
      this.render();
    }

    addPart(type, index) {
      const parts = this.design.parts;
      if (index === undefined || index === null) {
        const si = parts.findIndex((p) => p.uid === this.selected);
        index = si >= 0 ? si + 1 : parts.length;
      }
      const p = { uid: SB.Craft.newUid(), type };
      const twin = parts.find((q) => q.type === type) || parts.find((q) => SB.Craft.role(q.type) === SB.Craft.role(type));
      if (twin && twin.paint) p.paint = Object.assign({}, twin.paint);
      parts.splice(index, 0, p);
      this.selected = p.uid;
      this.changed();
    }

    // Paint ----------------------------------------------------------
    setPaint(uid, patch) {
      const p = this.design.parts.find((q) => q.uid === uid);
      if (!p) return;
      const next = SB.Paint.sanitize(p.type, Object.assign({}, SB.Paint.resolve(p.type, p.paint), patch));
      if (next) p.paint = next; else delete p.paint;
      this.changed(false);
    }

    /** Copies the selected part's paint to every part of the same type ('type') or role ('role'). */
    copyPaint(uid, scope) {
      const src = this.design.parts.find((q) => q.uid === uid);
      if (!src) return;
      const role = SB.Craft.role(src.type);
      let n = 0;
      for (const q of this.design.parts) {
        if (q === src || (scope === 'type' ? q.type !== src.type : SB.Craft.role(q.type) !== role)) continue;
        // same role but another type: carry the colours and the pattern where it applies
        const next = SB.Paint.sanitize(q.type, SB.Paint.resolve(src.type, src.paint));
        if (next) q.paint = next; else delete q.paint;
        n++;
      }
      this.changed(false);
      this.toast(n ? `Painted ${n} more part${n > 1 ? 's' : ''}` : 'No other matching parts');
    }

    applyLivery(name) {
      const livery = SB.Paint.liveries().find((l) => l.name === name);
      if (!livery) return;
      for (const q of this.design.parts) {
        const next = SB.Paint.liveryPaint(livery, q.type);
        if (next) q.paint = next; else delete q.paint;
      }
      this.changed(false);
      this.toast(`Livery: ${name}`);
    }

    buildPaintPanel() {
      const el = document.getElementById('paintSection');
      const swatches = SB.Paint.palette().map(([name, c]) => `<button class="sw" data-color="${c}" title="${esc(name)}" style="--c:${c}" aria-label="${esc(name)}"></button>`).join('');
      el.innerHTML = `
        <h2><span>Paint · <span id="ppName"></span></span><button id="ppReset" class="small ghost" title="Back to the default colours">Reset</button></h2>
        <div class="pp-row"><span class="pp-lbl" id="ppLbl0">Main</span><div class="swatches" data-slot="base">${swatches}</div>
          <input type="color" data-slot="base" title="Custom colour" aria-label="Custom main colour"></div>
        <div class="pp-row"><span class="pp-lbl" id="ppLbl1">Accent</span><div class="swatches" data-slot="accent">${swatches}</div>
          <input type="color" data-slot="accent" title="Custom colour" aria-label="Custom accent colour"></div>
        <div class="pp-row stacked" id="ppPatternRow"><span class="pp-lbl">Pattern</span><div id="ppPatterns" class="pp-patterns"></div></div>
        <div class="pp-row pp-apply"><button id="ppSameType"></button><button id="ppSameRole"></button></div>
        <div class="pp-row"><span class="pp-lbl">Livery</span><div id="ppLiveries" class="pp-liveries">${SB.Paint.liveries().map((l) => {
          const t = Object.assign({ base: '#e8e4da', accent: '#cf6f2c' }, (l.roles || {}).tank || {});
          return `<button data-livery="${esc(l.name)}" title="Paint the whole rocket"><i style="background:linear-gradient(90deg, ${t.base} 50%, ${t.accent} 50%)"></i>${esc(l.name)}</button>`;
        }).join('')}</div></div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || !this.selected) return;
        if (b.dataset.color) this.setPaint(this.selected, { [b.closest('[data-slot]').dataset.slot]: b.dataset.color });
        else if (b.dataset.pattern) this.setPaint(this.selected, { pattern: b.dataset.pattern });
        else if (b.dataset.livery) this.applyLivery(b.dataset.livery);
        else if (b.id === 'ppSameType') this.copyPaint(this.selected, 'type');
        else if (b.id === 'ppSameRole') this.copyPaint(this.selected, 'role');
        else if (b.id === 'ppReset') {
          const p = this.design.parts.find((q) => q.uid === this.selected);
          if (p) { delete p.paint; this.changed(false); }
        }
      });
      el.addEventListener('input', (e) => {
        const inp = e.target.closest('input[type=color]');
        if (inp && this.selected) this.setPaint(this.selected, { [inp.dataset.slot]: inp.value });
      });
    }

    renderPaint() {
      const el = document.getElementById('paintSection');
      const p = this.selected && this.design.parts.find((q) => q.uid === this.selected);
      el.classList.toggle('hidden', !p);
      if (!p) return;
      const d = C().parts[p.type], role = SB.Craft.role(p.type);
      const pt = SB.Paint.resolve(p.type, p.paint);
      const [l0, l1] = SB.Paint.labels(p.type);
      document.getElementById('ppName').textContent = d.name;
      document.getElementById('ppLbl0').textContent = l0;
      document.getElementById('ppLbl1').textContent = l1;
      for (const slot of ['base', 'accent']) {
        el.querySelectorAll(`.swatches[data-slot="${slot}"] .sw`).forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === pt[slot]));
        const inp = el.querySelector(`input[data-slot="${slot}"]`);
        if (document.activeElement !== inp) inp.value = pt[slot];
      }
      const pats = SB.Paint.patterns(p.type);
      document.getElementById('ppPatternRow').classList.toggle('hidden', !pats.length);
      const box = document.getElementById('ppPatterns');
      const key = p.type + '|' + pt.base + '|' + pt.accent;
      if (box._key !== key) {
        box._key = key;
        box.innerHTML = pats.map((n) => `<button class="pat" data-pattern="${n}" title="${SB.Paint.PATTERN_NAMES[n]}"><canvas width="44" height="60"></canvas><span>${SB.Paint.PATTERN_NAMES[n]}</span></button>`).join('');
        box.querySelectorAll('.pat').forEach((b) => {
          const cv = b.querySelector('canvas'), cx = cv.getContext('2d');
          const s = Math.min((cv.width - 6) / d.width, (cv.height - 6) / d.height);
          SB.Render.drawPart(cx, p.type, cv.width / 2, (cv.height - d.height * s) / 2, s, { base: pt.base, accent: pt.accent, pattern: b.dataset.pattern });
        });
      }
      box.querySelectorAll('.pat').forEach((b) => b.classList.toggle('active', b.dataset.pattern === pt.pattern));
      const roleName = { pod: 'pod', tank: 'tank', engine: 'engine', decoupler: 'decoupler', legs: 'leg ring', chute: 'parachute pack' }[role] || 'part';
      const sameType = this.design.parts.filter((q) => q.type === p.type).length;
      const sameRole = this.design.parts.filter((q) => SB.Craft.role(q.type) === role).length;
      const bt = document.getElementById('ppSameType'), br = document.getElementById('ppSameRole');
      bt.textContent = `Every ${d.name}`; bt.disabled = sameType < 2;
      br.textContent = `Every ${roleName}`; br.disabled = sameRole < 2 || sameRole === sameType;
    }

    movePart(uid, index) {
      const parts = this.design.parts;
      const from = parts.findIndex((p) => p.uid === uid);
      if (from < 0) return;
      const [p] = parts.splice(from, 1);
      if (index > from) index -= 1;
      parts.splice(Math.max(0, Math.min(parts.length, index)), 0, p);
      this.selected = uid;
      this.changed();
    }

    removePart(uid) {
      const parts = this.design.parts;
      const i = parts.findIndex((p) => p.uid === uid);
      if (i < 0) return;
      parts.splice(i, 1);
      if (this.selected === uid) this.selected = parts[Math.min(i, parts.length - 1)] ? parts[Math.min(i, parts.length - 1)].uid : null;
      this.changed();
    }

    nudgeSelected(dir) {
      const parts = this.design.parts;
      const i = parts.findIndex((p) => p.uid === this.selected);
      if (i < 0) return;
      const j = i + dir;
      if (j < 0 || j >= parts.length) return;
      [parts[i], parts[j]] = [parts[j], parts[i]];
      this.changed();
    }

    // Staging edits ------------------------------------------------
    moveStageItem(uid, dir) {
      const st = this.design.stages;
      const i = st.findIndex((s) => s.includes(uid));
      if (i < 0) return;
      const j = i + dir;
      if (j < 0 && st[i].length === 1) return; // already alone in the first step
      st[i].splice(st[i].indexOf(uid), 1);
      if (j < 0) st.unshift([uid]);
      else if (j >= st.length) st.push([uid]);
      else st[j].push(uid);
      this.design.stages = st.filter((s) => s.length);
      this.design.customStaging = true;
      this.changed(false);
    }

    moveStep(i, dir) {
      const st = this.design.stages;
      const j = i + dir;
      if (j < 0 || j >= st.length) return;
      [st[i], st[j]] = [st[j], st[i]];
      this.design.customStaging = true;
      this.changed(false);
    }

    autoStage() {
      this.design.customStaging = false;
      this.design.stages = SB.Craft.autoStage(this.design.parts);
      this.changed(false);
      this.toast('Staging reset to automatic order');
    }

    // Save / load ---------------------------------------------------
    save() {
      const name = (document.getElementById('designName').value || '').trim() || 'Untitled rocket';
      this.design.name = name;
      const all = this.savedDesigns();
      const existed = !!all[name];
      all[name] = SB.Craft.cloneDesign(this.design);
      if (!store.write(C().storageKeys.designs, all)) { this.toast('Could not save: browser storage is unavailable', 'bad'); return; }
      store.write(C().storageKeys.current, this.design);
      this.refreshSelect('s:' + name);
      this.toast(existed ? `Saved over “${name}”` : `Saved “${name}”`, 'good');
    }

    refreshSelect(value) {
      const sel = document.getElementById('designSelect');
      const all = this.savedDesigns();
      const names = Object.keys(all).sort((a, b) => a.localeCompare(b));
      let html = '<optgroup label="Saved designs">';
      html += names.length ? names.map((n) => `<option value="s:${esc(n)}">${esc(n)}</option>`).join('') : '<option value="" disabled>(none yet)</option>';
      html += '</optgroup><optgroup label="Presets">';
      html += C().presets.map((p, i) => `<option value="p:${i}">${esc(p.name)}</option>`).join('');
      html += '</optgroup>';
      sel.innerHTML = html;
      if (value) sel.value = value;
      else if (names.includes(this.design.name)) sel.value = 's:' + this.design.name;
      else sel.value = 'p:0';
    }

    openSelected() {
      const v = document.getElementById('designSelect').value || '';
      if (v.startsWith('s:')) {
        const d = this.savedDesigns()[v.slice(2)];
        if (!d) { this.toast('That design no longer exists', 'bad'); return; }
        this.setDesign(d);
        this.toast(`Opened “${v.slice(2)}”`);
      } else if (v.startsWith('p:')) {
        this.setDesign(this.preset(+v.slice(2)));
        this.toast(`Loaded preset “${this.design.name}”`);
      }
    }

    deleteSelected() {
      const v = document.getElementById('designSelect').value || '';
      if (!v.startsWith('s:')) { this.toast('Pick a saved design to delete (presets cannot be deleted)', 'warn'); return; }
      const name = v.slice(2);
      if (!window.confirm(`Delete saved design “${name}”?`)) return;
      const all = this.savedDesigns();
      delete all[name];
      store.write(C().storageKeys.designs, all);
      this.refreshSelect();
      this.toast(`Deleted “${name}”`);
    }

    newDesign() {
      if (this.design.parts.length && !window.confirm('Start a new, empty design? Unsaved changes to the current one will be lost.')) return;
      this.setDesign({ name: 'New rocket', parts: [], stages: [], customStaging: false });
    }

    toast(text, kind) {
      const el = document.getElementById('hangarToast');
      el.textContent = text;
      el.className = 'toast show ' + (kind || '');
      clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { el.className = 'toast'; }, 2600);
    }

    tryLaunch() {
      const a = this.analysis;
      if (!this.design.parts.some((p) => SB.Craft.role(p.type) === 'pod')) { this.toast('Add a command pod before launching', 'bad'); return; }
      if (!a.stages.length || a.stages[0].thrustVac <= 0) { this.toast('Stage 1 has no engine with fuel', 'bad'); return; }
      if (a.liftoffTwr < 1 && !window.confirm(`Liftoff TWR is ${a.liftoffTwr.toFixed(2)} — the rocket will not leave the pad. Launch anyway?`)) return;
      this.app.launch(this.design);
    }

    // ------------------------------------------------------------ catalogue
    buildCatalog() {
      const el = document.getElementById('catalog');
      let html = '<h2>Parts</h2>';
      for (const [cat, title] of CATS) {
        html += `<h3>${title}</h3>`;
        for (const [type, d] of Object.entries(C().parts)) {
          if (d.category !== cat) continue;
          html += `<div class="part-card" data-type="${type}" title="${esc(d.description || '')}">
            <canvas class="thumb" width="96" height="112"></canvas>
            <div class="pc-body"><div class="pc-name">${esc(d.name)}</div><div class="pc-stats">${partStats(type)}</div></div>
            <button class="add" title="Add below the selected part (or at the bottom)" aria-label="Add ${esc(d.name)}">+</button>
          </div>`;
        }
      }
      html += '<p class="hint">Drag a part onto the stack, or press + to add it below the selected part.</p>';
      el.innerHTML = html;
      el.querySelectorAll('.part-card').forEach((card) => {
        const type = card.dataset.type;
        this.paintThumb(card.querySelector('canvas'), type);
        card.querySelector('.add').addEventListener('click', (e) => { e.stopPropagation(); this.addPart(type); });
        card.addEventListener('pointerdown', (e) => {
          if (e.target.closest('.add') || e.button !== 0) return;
          this.beginPointer(e, { type });
        });
      });
    }

    paintThumb(cv, type) {
      const ctx = cv.getContext('2d');
      const d = C().parts[type];
      ctx.clearRect(0, 0, cv.width, cv.height);
      const r = SB.Craft.role(type), isLegs = r === 'legs', isChute = r === 'chute';
      const hTot = d.height + (isLegs ? 1.2 : 0) + (isChute ? 1.3 : 0);
      const wTot = Math.max(d.width + (isLegs ? d.footSpread * 2 : 0), isChute ? 1.3 : 0);
      const s = Math.min((cv.width - 16) / wTot, (cv.height - 16) / hTot, 60);
      const y = (cv.height - hTot * s) / 2 + (isChute ? 1.3 * s : 0);
      if (isLegs) SB.Render.drawLegStruts(ctx, d, cv.width / 2, y + d.height * s * 0.5, y + hTot * s, s, SB.Paint.resolve(type));
      if (isChute) { // a single small canopy above the pack, so the part reads as a parachute
        const pt = SB.Paint.resolve(type);
        ctx.strokeStyle = 'rgba(225,230,238,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cv.width / 2, y + 2); ctx.lineTo(cv.width / 2 - 0.6 * s, y - 0.45 * s); ctx.moveTo(cv.width / 2, y + 2); ctx.lineTo(cv.width / 2 + 0.6 * s, y - 0.45 * s); ctx.stroke();
        ctx.save(); ctx.translate(cv.width / 2, y - 0.45 * s); SB.Render.drawCanopy(ctx, 1.25 * s, 1, pt, 8, s); ctx.restore();
      }
      SB.Render.drawPart(ctx, type, cv.width / 2, y, s);
    }

    // ------------------------------------------------------------ pointer / drag
    bindUi() {
      const $ = (id) => document.getElementById(id);
      $('btnSave').addEventListener('click', () => this.save());
      $('btnOpen').addEventListener('click', () => this.openSelected());
      $('btnDelete').addEventListener('click', () => this.deleteSelected());
      $('btnNew').addEventListener('click', () => this.newDesign());
      $('btnStarter').addEventListener('click', () => { this.setDesign(this.preset(0)); this.toast('Loaded the starter rocket'); });
      $('btnLaunch').addEventListener('click', () => this.tryLaunch());
      $('btnAutoStage').addEventListener('click', () => this.autoStage());
      $('designName').addEventListener('input', (e) => { this.design.name = e.target.value; store.write(C().storageKeys.current, this.design); });
      $('designSelect').addEventListener('dblclick', () => this.openSelected());
      $('selToolbar').addEventListener('click', (e) => {
        const act = e.target.closest('button') && e.target.closest('button').dataset.act;
        if (act === 'up') this.nudgeSelected(-1);
        if (act === 'down') this.nudgeSelected(1);
        if (act === 'remove' && this.selected) this.removePart(this.selected);
      });
      $('staging').addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const item = b.closest('.stage-item');
        const step = b.closest('.stage-step');
        if (item && b.classList.contains('mv-up')) this.moveStageItem(item.dataset.uid, -1);
        else if (item && b.classList.contains('mv-down')) this.moveStageItem(item.dataset.uid, 1);
        else if (step && b.classList.contains('step-up')) this.moveStep(+step.dataset.step, -1);
        else if (step && b.classList.contains('step-down')) this.moveStep(+step.dataset.step, 1);
      });
      $('staging').addEventListener('mouseover', (e) => {
        const item = e.target.closest('.stage-item');
        const uid = item ? item.dataset.uid : null;
        if (uid !== this.highlight) { this.highlight = uid; this.render(); }
      });
      $('staging').addEventListener('mouseleave', () => { this.highlight = null; this.render(); });

      const cv = this.canvas;
      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const hit = this.hitTest(e);
        if (hit) this.beginPointer(e, { uid: hit.uid });
        else { this.selected = null; this.render(); this.renderInfo(); }
      });
      cv.addEventListener('pointermove', (e) => {
        if (this.drag) return;
        const hit = this.hitTest(e);
        const uid = hit ? hit.uid : null;
        cv.style.cursor = uid ? 'grab' : 'default';
        if (uid !== this.hover) { this.hover = uid; this.render(); }
      });
      cv.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this.render(); } });

      window.addEventListener('keydown', (e) => {
        if (this.app.screen !== 'hangar') return;
        if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.removePart(this.selected); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
        if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); this.nudgeSelected(-1); }
        if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); this.nudgeSelected(1); }
      });
      if (window.ResizeObserver) new ResizeObserver(() => this.render()).observe(cv.parentElement);
    }

    hitTest(e) {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      return this.rects.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1) || null;
    }

    insertionIndexAt(clientY) {
      const r = this.canvas.getBoundingClientRect();
      const y = clientY - r.top;
      for (let i = 0; i < this.rects.length; i++) if (y < (this.rects[i].y0 + this.rects[i].y1) / 2) return i;
      return this.rects.length;
    }

    overCanvas(e) {
      const r = this.canvas.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    beginPointer(e, what) {
      const start = { x: e.clientX, y: e.clientY };
      let dragging = false;
      const ghost = document.getElementById('dragGhost');
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5) {
          dragging = true;
          this.drag = what;
          const type = what.type || this.design.parts.find((p) => p.uid === what.uid).type;
          this.paintThumb(ghost, type);
          ghost.style.display = 'block';
          document.body.classList.add('dragging');
        }
        if (!dragging) return;
        ghost.style.left = ev.clientX - ghost.width / 2 + 'px';
        ghost.style.top = ev.clientY - ghost.height / 2 + 'px';
        const idx = this.overCanvas(ev) ? this.insertionIndexAt(ev.clientY) : null;
        if (idx !== this.insertIndex) { this.insertIndex = idx; this.render(); }
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        ghost.style.display = 'none';
        document.body.classList.remove('dragging');
        const idx = this.insertIndex;
        this.drag = null;
        this.insertIndex = null;
        if (!dragging) {
          if (what.uid) { this.selected = what.uid; this.render(); this.renderInfo(); }
          else if (what.type) this.addPart(what.type);
          return;
        }
        if (ev.type === 'pointerup' && this.overCanvas(ev) && idx !== null) {
          if (what.type) this.addPart(what.type, idx);
          else this.movePart(what.uid, idx);
        } else if (what.uid && ev.type === 'pointerup') {
          this.removePart(what.uid);
          this.toast('Part removed');
        } else this.render();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }

    // ------------------------------------------------------------ drawing
    stageOf(uid) { return this.design.stages.findIndex((s) => s.includes(uid)); }

    render() {
      const cv = this.canvas, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.parentElement.clientWidth, H = cv.parentElement.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a1426';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(90,140,220,0.08)';
      ctx.lineWidth = 1;
      for (let x = (W / 2) % 24; x < W; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      const d = this.design;
      this.rects = [];
      if (!d.parts.length) {
        ctx.fillStyle = 'rgba(200,220,255,0.55)';
        ctx.font = '15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Empty stack — drag a command pod here to start', W / 2, H / 2);
        if (this.insertIndex !== null) { ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(W / 2 - 60, H / 2 + 20); ctx.lineTo(W / 2 + 60, H / 2 + 20); ctx.stroke(); }
        return;
      }
      const craft = SB.FlightCraft.fromDesign(d);
      const g = craft.geometry();
      const total = g.height + 0.6;
      const s = Math.max(6, Math.min(64, (H - 110) / Math.max(total, 3)));
      const x = W / 2;
      const y0 = Math.max(40, (H - total * s) / 2);
      // widest point including deployed legs, so badges never sit on the struts
      let ext = g.maxWidth / 2;
      for (const p of craft.parts) if (p.role === 'legs') ext = Math.max(ext, p.def.width / 2 + p.def.footSpread + 0.3);
      const badgeX = x + ext * s + 16;

      // legs first (behind the stack), as they will be on the pad: folded unless the rocket stands on
      // them. A selected leg ring opens its legs, so you can see them (and their paint).
      craft.standOnLegs();
      for (const p of craft.parts) {
        if (p.role !== 'legs') continue;
        SB.Render.drawLegStruts(ctx, p.def, x, y0 + (g.tops.get(p.uid) + p.def.height / 2) * s, y0 + g.legReach.get(p.uid) * s, s,
          SB.Paint.resolve(p.type, p.paint), p.legsOut || p.uid === this.selected ? 1 : 0);
      }
      // a selected parachute pack shows its open canopies (in its paint) in the free space left of the stack
      const sel = craft.parts.find((p) => p.uid === this.selected && p.role === 'chute');
      if (sel) {
        const d = sel.def;
        const reach = d.main.riser * 1.1 + d.main.size * 0.5, span = 2 * (Math.sin(0.45) * d.main.riser + d.main.size * 0.55);
        const left = x - (g.maxWidth * s) / 2 - 90; // keeps clear of the CoM marker
        const ps = Math.min((left - 30) / span, (H * 0.5) / reach);
        if (ps > 2) {
          const px = left / 2 + 10, py = H / 2 + (reach * ps) / 2;
          SB.Render.drawChuteCluster(ctx, d, px, py, ps, SB.Paint.resolve(sel.type, sel.paint), { stage: 'main', main: [1, 1, 1], drogue: 0, cut: 1, gone: 0 }, 0);
          SB.Render.drawPart(ctx, sel.type, px, py - d.height * 0.4 * ps, ps, sel.paint, { chute: { stage: 'main' } });
          ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(200,220,255,0.55)';
          ctx.fillText('Main canopies, open', px, py + 12);
        }
      }
      craft.parts.forEach((p, i) => {
        const top = y0 + g.tops.get(p.uid) * s, h = p.def.height * s;
        const w = Math.max(p.def.width, p.def.bell || 0) * s;
        SB.Render.drawPart(ctx, p.type, x, top, s, p.paint);
        const rect = { uid: p.uid, i, y0: top, y1: top + h, x0: x - Math.max(w / 2, 30) - 12, x1: x + Math.max(w / 2, 30) + 12 };
        this.rects.push(rect);
        const sel = p.uid === this.selected, hov = p.uid === this.hover || p.uid === this.highlight;
        if (sel || hov) {
          ctx.strokeStyle = sel ? '#4fd1ff' : 'rgba(180,220,255,0.6)';
          ctx.lineWidth = sel ? 2 : 1.5;
          ctx.setLineDash(sel ? [] : [4, 3]);
          ctx.strokeRect(x - w / 2 - 6, top - 1, w + 12, h + 2);
          ctx.setLineDash([]);
        }
        // stage badge for engines/decouplers
        const si = this.stageOf(p.uid);
        if (si >= 0) {
          const col = STAGE_COLORS[si % STAGE_COLORS.length];
          const bx = badgeX, by = top + h / 2;
          ctx.fillStyle = col;
          SB.Render.roundRect(ctx, bx, by - 9, 34, 18, 9); ctx.fill();
          ctx.fillStyle = '#0a1020';
          ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('S' + (si + 1), bx + 17, by + 0.5);
          ctx.fillStyle = 'rgba(210,225,255,0.7)';
          ctx.textAlign = 'left';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(p.role === 'engine' ? 'ignite' : p.role === 'chute' ? 'chutes' : 'separate', bx + 40, by + 0.5);
        }
        if (p.role === 'decoupler') {
          ctx.strokeStyle = 'rgba(241,194,50,0.35)';
          ctx.setLineDash([6, 6]);
          ctx.beginPath(); ctx.moveTo(x - 150, top + h / 2); ctx.lineTo(x - w / 2 - 10, top + h / 2); ctx.stroke();
          ctx.setLineDash([]);
        }
      });
      // centre of mass marker + height
      const comY = y0 + g.comY * s;
      ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1.5;
      const mx = x - Math.max(g.maxWidth * s / 2, 30) - 34;
      ctx.beginPath(); ctx.arc(mx, comY, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffd36b';
      ctx.beginPath(); ctx.moveTo(mx, comY); ctx.arc(mx, comY, 7, 0, Math.PI / 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(mx, comY); ctx.arc(mx, comY, 7, Math.PI, Math.PI * 1.5); ctx.closePath(); ctx.fill();
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,211,107,0.85)';
      ctx.fillText('CoM', mx - 11, comY);
      ctx.fillStyle = 'rgba(200,220,255,0.55)';
      ctx.textAlign = 'center';
      ctx.fillText(`${g.height.toFixed(1)} m tall`, x, Math.min(H - 12, y0 + total * s + 22));

      if (this.insertIndex !== null) {
        const yi = this.insertIndex < this.rects.length ? this.rects[this.insertIndex].y0 : this.rects[this.rects.length - 1].y1;
        ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = 3;
        ctx.shadowColor = '#4fd1ff'; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.moveTo(x - 70, yi); ctx.lineTo(x + 70, yi); ctx.stroke();
        ctx.shadowBlur = 0;
      }
      const tb = document.getElementById('selToolbar');
      tb.classList.toggle('hidden', !this.selected);
    }

    renderInfo() {
      const a = this.analysis, d = this.design;
      const twrCls = a.liftoffTwr >= 1.25 ? 'good' : a.liftoffTwr >= 1 ? 'warn' : 'bad';
      let html = `<div class="kv"><span>Wet mass</span><b>${fmtKg(a.wetMass)}</b></div>
        <div class="kv"><span>Dry mass</span><b>${fmtKg(a.dryMass)}</b></div>
        <div class="kv"><span>Parts · height</span><b>${a.partCount} · ${a.height.toFixed(1)} m</b></div>
        <div class="kv"><span>Liftoff TWR (${this.app.sys.planet.name})</span><b class="${twrCls}">${a.liftoffTwr.toFixed(2)}</b></div>
        <div class="kv"><span>Total Δv (vacuum)</span><b>${Math.round(a.totalDv).toLocaleString()} m/s</b></div>`;
      if (a.stages.length) {
        html += '<table class="dv"><thead><tr><th>Stage</th><th>Δv vac</th><th>Δv ASL</th><th>TWR</th><th>Burn</th></tr></thead><tbody>';
        a.stages.forEach((s, i) => {
          html += `<tr><td><span class="badge" style="background:${STAGE_COLORS[i % STAGE_COLORS.length]}">S${s.number}</span></td>
            <td>${s.thrustVac > 0 || s.dvVac > 0 ? Math.round(s.dvVac) : '—'}</td><td>${s.thrustVac > 0 || s.dvAsl > 0 ? Math.round(s.dvAsl) : '—'}</td><td>${s.thrustVac > 0 ? s.twrAsl.toFixed(2) : '—'}</td><td>${s.burnTime > 0 ? Math.round(s.burnTime) + ' s' : '—'}</td></tr>`;
        });
        html += '</tbody></table><p class="note">Δv in m/s. TWR uses sea-level thrust and Verdis gravity.</p>';
      }
      document.getElementById('stats').innerHTML = html;

      // staging editor
      let sh = '';
      if (!d.stages.length) sh = '<p class="note">No engines, decouplers or parachutes yet.</p>';
      d.stages.forEach((step, i) => {
        const col = STAGE_COLORS[i % STAGE_COLORS.length];
        const st = a.stages[i];
        sh += `<div class="stage-step" data-step="${i}" style="--c:${col}">
          <div class="step-head"><span class="badge" style="background:${col}">S${i + 1}</span>
            <span class="step-title">${i === 0 ? 'Launch' : 'Stage ' + (i + 1)}</span>
            <span class="step-dv">${st && st.dvVac > 0 ? Math.round(st.dvVac) + ' m/s' : ''}</span>
            <button class="step-up icon" title="Fire this step earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="step-down icon" title="Fire this step later" ${i === d.stages.length - 1 ? 'disabled' : ''}>↓</button>
          </div>`;
        const sorted = step.slice().sort((u, v) => (SB.Craft.role(this.typeOf(u)) === 'decoupler' ? -1 : 0) - (SB.Craft.role(this.typeOf(v)) === 'decoupler' ? -1 : 0));
        for (const uid of sorted) {
          const type = this.typeOf(uid);
          const r = SB.Craft.role(type);
          sh += `<div class="stage-item" data-uid="${uid}" data-role="${r}">
            <span class="tag ${r === 'engine' ? 'ignite' : r === 'chute' ? 'chute' : 'decouple'}">${r === 'engine' ? 'IGNITE' : r === 'chute' ? 'CHUTES' : 'DECOUPLE'}</span>
            <span class="si-name">${esc(C().parts[type].name)}</span>
            <button class="mv-up icon" title="Move to an earlier stage">▲</button>
            <button class="mv-down icon" title="Move to a later stage">▼</button>
          </div>`;
        }
        sh += '</div>';
      });
      if (d.customStaging) sh += '<p class="note">Custom staging. Press Auto to restore the default order.</p>';
      document.getElementById('staging').innerHTML = sh;

      document.getElementById('warnings').innerHTML = a.warnings.map((w) => `<div class="warn-${w.level}">${esc(w.text)}</div>`).join('');
      this.renderPaint();
    }

    typeOf(uid) { const p = this.design.parts.find((q) => q.uid === uid); return p ? p.type : 'decoupler'; }
  }

  SB.Hangar = Hangar;
  SB.store = store;
})(typeof window !== 'undefined' ? window : globalThis);
