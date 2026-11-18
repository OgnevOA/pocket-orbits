/*
 * Rendering: part painter (shared by hangar and flight), flight view, orbital map, attitude dial.
 * All drawing is in CSS pixels; callers set the device-pixel-ratio transform.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------ colour helpers
  const rgbCache = new Map();
  function rgb(hex) {
    let v = rgbCache.get(hex);
    if (v) return v;
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
    return v;
  }
  function mix(a, b, t, alpha) {
    const A = rgb(a), B = rgb(b);
    const c = (i) => Math.round(A[i] + (B[i] - A[i]) * t);
    return alpha === undefined ? `rgb(${c(0)},${c(1)},${c(2)})` : `rgba(${c(0)},${c(1)},${c(2)},${alpha})`;
  }
  function shade(hex, k) {
    const A = rgb(hex);
    const f = (c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
    return `rgb(${f(A[0])},${f(A[1])},${f(A[2])})`;
  }
  function alphaOf(hex, a) { const A = rgb(hex); return `rgba(${A[0]},${A[1]},${A[2]},${a})`; }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ------------------------------------------------------------ part painter
  function cylGrad(ctx, x0, x1, base) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, shade(base, -0.5));
    g.addColorStop(0.28, shade(base, 0.3));
    g.addColorStop(0.55, base);
    g.addColorStop(1, shade(base, -0.6));
    return g;
  }
  const outline = (ctx, s) => { ctx.strokeStyle = 'rgba(8,12,20,0.55)'; ctx.lineWidth = Math.max(0.6, s * 0.025); ctx.stroke(); };

  /** Cylinder shading laid over flat paint: dark edges and a highlight left of centre. */
  function cylShade(ctx, x0, x1, y, h) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(0.28, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y, x1 - x0, h);
  }

  /** Paints a pattern in the accent colour (the caller has clipped to the part). */
  function paintPattern(ctx, pattern, x0, y, w, h, s, accent, heightM) {
    ctx.fillStyle = accent;
    switch (pattern) {
      case 'bands': { const b = Math.min(0.1 * s, h * 0.14); ctx.fillRect(x0, y, w, b); ctx.fillRect(x0, y + h - b, w, b); break; }
      case 'rings': {
        const n = Math.max(2, Math.round(heightM / 0.5)), t = Math.max(1, Math.min(0.09 * s, (h / n) * 0.35));
        for (let k = 0; k < n; k++) ctx.fillRect(x0, y + ((k + 0.5) * h) / n - t / 2, w, t);
        break;
      }
      case 'checker': {
        const rows = Math.max(2, Math.round(heightM / 0.62)), rh = h / rows;
        for (let r = 0; r < rows; r++) ctx.fillRect(x0 + (r % 2 ? w / 2 : 0), y + r * rh, w / 2, rh);
        break;
      }
      case 'split': ctx.fillRect(x0, y, w / 2, h); break;
      case 'stripe': ctx.fillRect(x0 + w * 0.38, y, w * 0.24, h); break;
      default: break;
    }
  }

  function drawPod(ctx, d, x, y, s, pt) {
    const w = d.width * s, h = d.height * s, tw = w * 0.42;
    const path = new Path2D();
    path.moveTo(x - w / 2, y + h);
    path.lineTo(x - tw / 2, y + h * 0.14);
    path.quadraticCurveTo(x, y - h * 0.03, x + tw / 2, y + h * 0.14);
    path.lineTo(x + w / 2, y + h);
    path.closePath();
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = pt.base;
    ctx.fillRect(x - w / 2, y - h * 0.05, w, h * 1.05);
    paintPattern(ctx, pt.pattern, x - w / 2, y - h * 0.05, w, h * 1.05, s, pt.accent, d.height);
    ctx.fillStyle = pt.accent; // heat shield / trim
    ctx.fillRect(x - w / 2, y + h * 0.92, w, h * 0.08);
    cylShade(ctx, x - w / 2, x + w / 2, y - h * 0.05, h * 1.05);
    ctx.restore();
    ctx.strokeStyle = 'rgba(8,12,20,0.55)'; ctx.lineWidth = Math.max(0.6, s * 0.025);
    ctx.stroke(path);
    ctx.fillStyle = '#8c949f';
    ctx.fillRect(x - tw * 0.32, y - h * 0.01, tw * 0.64, h * 0.07);
    const ww = w * 0.2, wh = h * 0.2;
    roundRect(ctx, x - ww / 2 + w * 0.05, y + h * 0.4, ww, wh, ww * 0.35);
    ctx.fillStyle = '#16263f';
    ctx.fill();
    ctx.fillStyle = 'rgba(160,210,255,0.55)';
    ctx.fillRect(x - ww / 2 + w * 0.05 + ww * 0.18, y + h * 0.43, ww * 0.18, wh * 0.4);
  }

  function drawTank(ctx, d, x, y, s, pt) {
    const w = d.width * s, h = d.height * s, x0 = x - w / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y, w, h); ctx.clip();
    ctx.fillStyle = pt.base;
    ctx.fillRect(x0, y, w, h);
    paintPattern(ctx, pt.pattern, x0, y, w, h, s, pt.accent, d.height);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = Math.max(0.5, s * 0.02);
    for (let k = 1; k < d.height; k++) { ctx.beginPath(); ctx.moveTo(x0, y + k * s); ctx.lineTo(x0 + w, y + k * s); ctx.stroke(); }
    cylShade(ctx, x0, x0 + w, y, h);
    ctx.restore();
    ctx.beginPath(); ctx.rect(x0, y, w, h); outline(ctx, s);
  }

  function drawEngine(ctx, d, x, y, s, pt) {
    const w = d.width * s, h = d.height * s, bell = d.bell * s;
    const mh = h * 0.36;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.46, y); ctx.lineTo(x + w * 0.46, y);
    ctx.lineTo(x + bell * 0.24, y + mh); ctx.lineTo(x - bell * 0.24, y + mh); ctx.closePath();
    ctx.fillStyle = cylGrad(ctx, x - w / 2, x + w / 2, pt.base);
    ctx.fill(); outline(ctx, s);
    ctx.beginPath();
    ctx.moveTo(x - bell * 0.2, y + mh);
    ctx.quadraticCurveTo(x - bell * 0.24, y + h * 0.75, x - bell / 2, y + h);
    ctx.lineTo(x + bell / 2, y + h);
    ctx.quadraticCurveTo(x + bell * 0.24, y + h * 0.75, x + bell * 0.2, y + mh);
    ctx.closePath();
    ctx.fillStyle = cylGrad(ctx, x - bell / 2, x + bell / 2, pt.accent);
    ctx.fill(); outline(ctx, s);
    ctx.fillStyle = '#c96a2a';
    ctx.fillRect(x - bell / 2, y + h - Math.max(1, s * 0.04), bell, Math.max(1, s * 0.04));
  }

  function drawDecoupler(ctx, d, x, y, s, pt) {
    const w = d.width * s, h = d.height * s;
    ctx.save();
    ctx.beginPath(); ctx.rect(x - w / 2, y, w, h); ctx.clip();
    ctx.fillStyle = pt.accent; ctx.fillRect(x - w / 2, y, w, h);
    ctx.fillStyle = pt.base;
    const step = Math.max(3, h * 1.4);
    for (let k = -h * 2; k < w + h * 2; k += step) {
      ctx.beginPath();
      ctx.moveTo(x - w / 2 + k, y + h); ctx.lineTo(x - w / 2 + k + step / 2, y + h);
      ctx.lineTo(x - w / 2 + k + step / 2 + h, y); ctx.lineTo(x - w / 2 + k + h, y); ctx.closePath(); ctx.fill();
    }
    const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.45)'); g.addColorStop(0.3, 'rgba(255,255,255,0.15)'); g.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = g; ctx.fillRect(x - w / 2, y, w, h);
    ctx.restore();
    ctx.beginPath(); ctx.rect(x - w / 2, y, w, h); outline(ctx, s);
  }

  function drawLegRing(ctx, d, x, y, s, pt) {
    const w = d.width * s, h = d.height * s;
    ctx.fillStyle = cylGrad(ctx, x - w / 2, x + w / 2, pt.base);
    ctx.fillRect(x - w * 0.49, y, w * 0.98, h);
    ctx.beginPath(); ctx.rect(x - w * 0.49, y, w * 0.98, h); outline(ctx, s);
    ctx.fillStyle = '#c9cfd8';
    for (const k of [-0.3, 0, 0.3]) { ctx.beginPath(); ctx.arc(x + k * w, y + h / 2, Math.max(0.6, s * 0.04), 0, TAU); ctx.fill(); }
  }

  /**
   * The legs of a leg ring, on both sides of the stack. `deploy` runs from 0, folded up flat against
   * the side of the stack, to 1 (the default), down and out on their feet. In between, each leg swings
   * outward about its hinge in the ring. Purely visual: contact always uses the deployed shape.
   */
  function drawLegStruts(ctx, d, x, yHip, yFoot, s, pt, deploy) {
    const t = deploy === undefined ? 1 : Math.max(0, Math.min(1, deploy));
    const e = t * t * (3 - 2 * t); // ease in and out
    const w = d.width * s;
    const col = (pt && pt.accent) || '#aab2bd';
    // one leg, in coordinates measured from its hinge: x away from the stack axis, y down
    const hinge = w * 0.44;
    const foot = [w / 2 + d.footSpread * s - hinge, yFoot - yHip];
    const knee = [w / 2 + d.footSpread * s * 0.8 - hinge, (yFoot - yHip) * 0.35];
    const L = Math.hypot(foot[0], foot[1]) || 1;
    const u = [foot[0] / L, foot[1] / L], v = [-u[1], u[0]];
    const ku = knee[0] * u[0] + knee[1] * u[1], kv = knee[0] * v[0] + knee[1] * v[1];
    const aOut = Math.atan2(foot[1], foot[0]);
    const fold = Math.min(L, w * 0.06 + s * 0.14); // folded, the foot sits just outside the stack's side
    const aIn = Math.atan2(-Math.sqrt(L * L - fold * fold), fold);
    const a = aIn + (aOut - aIn) * e;
    const U = [Math.cos(a), Math.sin(a)], V = [-U[1], U[0]];
    const K = [ku * U[0] + kv * e * V[0], ku * U[1] + kv * e * V[1]]; // the knee straightens as it folds
    const F = [L * U[0], L * U[1]];
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const hx = x + side * hinge;
      const kx = hx + side * K[0], ky = yHip + K[1];
      const fx = hx + side * F[0], fy = yHip + F[1];
      ctx.strokeStyle = shade(col, -0.65);
      ctx.lineWidth = Math.max(1.5, s * 0.16);
      ctx.beginPath(); ctx.moveTo(hx, yHip); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(0.8, s * 0.08);
      ctx.beginPath(); ctx.moveTo(hx, yHip); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
      // the foot pad turns with the leg (flat on the ground when deployed)
      ctx.save();
      ctx.translate(fx, fy);
      ctx.rotate(side * (a - aOut));
      ctx.fillStyle = '#2d3238';
      ctx.fillRect(-s * 0.25, -s * 0.07, s * 0.5, s * 0.1);
      ctx.restore();
    }
  }

  /** Parachute pack: a metal can; while packed, the folded canopy shows on top in its colours. */
  function drawChutePack(ctx, d, x, y, s, pt, deployed) {
    const w = d.width * s, h = d.height * s;
    const can = y + h * 0.42;
    ctx.fillStyle = cylGrad(ctx, x - w / 2, x + w / 2, '#9aa3ad');
    ctx.fillRect(x - w / 2, can, w, y + h - can);
    ctx.fillStyle = pt.accent;
    ctx.fillRect(x - w / 2, can + (y + h - can) * 0.35, w, (y + h - can) * 0.22);
    ctx.beginPath(); ctx.rect(x - w / 2, can, w, y + h - can); outline(ctx, s);
    if (deployed) { // empty: the open mouth of the can
      ctx.fillStyle = '#1b2027';
      ctx.beginPath(); ctx.ellipse(x, can, w * 0.46, Math.max(1, h * 0.1), 0, 0, TAU); ctx.fill();
      return;
    }
    const dome = new Path2D();
    dome.moveTo(x - w * 0.48, can);
    dome.bezierCurveTo(x - w * 0.48, y - h * 0.05, x + w * 0.48, y - h * 0.05, x + w * 0.48, can);
    dome.closePath();
    ctx.save();
    ctx.clip(dome);
    ctx.fillStyle = pt.base;
    ctx.fillRect(x - w / 2, y - h * 0.1, w, can - y + h * 0.1);
    ctx.fillStyle = pt.accent;
    for (let k = -2; k <= 2; k += 2) ctx.fillRect(x + (k / 5 - 0.1) * w * 0.96, y - h * 0.1, w * 0.19, can - y + h * 0.1);
    cylShade(ctx, x - w / 2, x + w / 2, y - h * 0.1, can - y + h * 0.1);
    ctx.restore();
    ctx.strokeStyle = 'rgba(8,12,20,0.55)'; ctx.lineWidth = Math.max(0.6, s * 0.025);
    ctx.stroke(dome);
  }

  /**
   * One canopy, skirt centre at the origin, opening upward (-y). D: full diameter (px); open: 0
   * (a narrow streamer) .. 1 (a full dome). Alternate gores in the accent colour, fanning from the apex.
   */
  function drawCanopy(ctx, D, open, pt, gores, s) {
    const w = D * (0.16 + 0.84 * open), h = D * (0.6 - 0.2 * open);
    const path = new Path2D();
    path.moveTo(-w / 2, 0);
    path.bezierCurveTo(-w * 0.56, -h * 0.72, -w * 0.3, -h, 0, -h);
    path.bezierCurveTo(w * 0.3, -h, w * 0.56, -h * 0.72, w / 2, 0);
    path.quadraticCurveTo(0, -h * 0.24, -w / 2, 0);
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = pt.base;
    ctx.fillRect(-w, -h * 1.2, 2 * w, h * 1.4);
    ctx.fillStyle = pt.accent;
    for (let k = 0; k < gores; k += 2) {
      const a = -w * 0.6 + (k / gores) * w * 1.2, b = a + (w * 1.2) / gores;
      ctx.beginPath(); ctx.moveTo(0, -h * 1.05); ctx.lineTo(a, h * 0.1); ctx.lineTo(b, h * 0.1); ctx.closePath(); ctx.fill();
    }
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.38)'); g.addColorStop(0.35, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = g;
    ctx.fillRect(-w, -h * 1.2, 2 * w, h * 1.4);
    ctx.restore();
    ctx.strokeStyle = 'rgba(8,12,20,0.6)'; ctx.lineWidth = Math.max(0.6, s * 0.04);
    ctx.stroke(path);
  }

  /**
   * The drogues and the three mains of a pack whose top is at (x, yTop), in craft coordinates (the
   * canopies stream out along the craft axis, -y). c: the pack's chute state. Risers run to the skirt
   * edges; the canopies sway gently and slightly out of step. Cut drogues drift away and fade;
   * spent canopies sag sideways and fade.
   */
  function drawChuteCluster(ctx, d, x, yTop, s, pt, c, now) {
    now = now === undefined ? performance.now() : now;
    const fade = 1 - (c.gone || 0);
    if (fade <= 0) return;
    const one = (ang, riser, D, open, alpha, drift, gores) => {
      if (alpha <= 0.01) return;
      const L = riser * (0.35 + 0.65 * Math.min(1, open * 3)) * s + drift;
      const sx = x + Math.sin(ang) * L, sy = yTop - Math.cos(ang) * L;
      const wOpen = D * s * (0.16 + 0.84 * open);
      ctx.save();
      ctx.globalAlpha *= alpha;
      if (drift <= 0) {
        ctx.strokeStyle = 'rgba(225,230,238,0.75)';
        ctx.lineWidth = Math.max(0.5, s * 0.035);
        ctx.beginPath();
        for (const side of [-1, 1]) { ctx.moveTo(x, yTop); ctx.lineTo(sx + Math.cos(ang) * side * wOpen / 2, sy + Math.sin(ang) * side * wOpen / 2); }
        ctx.stroke();
      }
      ctx.translate(sx, sy);
      ctx.rotate(ang);
      drawCanopy(ctx, D * s, open, pt, gores, s);
      ctx.restore();
    };
    const sag = (c.gone || 0) * 1.3;
    const sway = (i) => 0.05 * Math.sin(now / 1100 + i * 2.3);
    // drogues: while open, and drifting away for a moment after they are cut
    const dOpen = c.stage === 'drogue' ? c.drogue : c.dc || 0;
    if (dOpen > 0 && (c.stage === 'drogue' || (c.cut || 0) < 1)) {
      const cut = c.stage === 'drogue' ? 0 : c.cut || 0;
      for (let i = 0; i < d.drogue.count; i++) {
        const a = (i - (d.drogue.count - 1) / 2) * 0.4 + sway(i + 5);
        one(a, d.drogue.riser, d.drogue.size, Math.sqrt(dOpen), 1 - cut, cut * 14 * s, 6);
      }
    }
    if (c.stage === 'main' || c.stage === 'spent') {
      const order = [1, 0, 2]; // the middle canopy sits behind the other two
      for (const i of order) {
        const open = Math.sqrt(c.main[i] || 0) * (1 - 0.7 * (c.gone || 0));
        const a = (i - 1) * 0.38 + sway(i) + sag;
        one(a, d.main.riser * (i === 1 ? 1.1 : 1), d.main.size, open, fade, 0, 10);
      }
    }
  }

  /** Draws one part with its top centre at (x, y), s px/m, in its paint (or the defaults). */
  function drawPart(ctx, type, x, y, s, paint, part) {
    const d = SB.CONFIG.parts[type];
    const pt = SB.Paint ? SB.Paint.resolve(type, paint) : { base: '#cccccc', accent: '#777777', pattern: null };
    switch (SB.Craft.role(type)) {
      case 'pod': return drawPod(ctx, d, x, y, s, pt);
      case 'tank': return drawTank(ctx, d, x, y, s, pt);
      case 'engine': return drawEngine(ctx, d, x, y, s, pt);
      case 'decoupler': return drawDecoupler(ctx, d, x, y, s, pt);
      case 'legs': return drawLegRing(ctx, d, x, y, s, pt);
      case 'chute': return drawChutePack(ctx, d, x, y, s, pt, !!(part && part.chute && part.chute.stage !== 'packed' && part.chute.stage !== 'armed'));
      default: ctx.fillStyle = '#888'; ctx.fillRect(x - d.width * s / 2, y, d.width * s, d.height * s);
    }
  }

  const strutPaint = (type, paint) => (SB.Paint ? SB.Paint.resolve(type, paint) : null);

  function drawFlame(ctx, x, y, bell, throttle, pr) {
    const vac = 1 - pr;
    const len = bell * (1.4 + 3.4 * throttle) * (1 + 0.6 * vac) * (0.9 + 0.2 * Math.random());
    const wid = bell * (0.85 + 0.9 * vac);
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, 'rgba(255,255,235,0.95)');
    g.addColorStop(0.2, 'rgba(255,214,110,0.9)');
    g.addColorStop(0.55, 'rgba(255,120,40,0.5)');
    g.addColorStop(1, 'rgba(255,70,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - bell * 0.46, y);
    ctx.quadraticCurveTo(x - wid / 2, y + len * 0.35, x, y + len);
    ctx.quadraticCurveTo(x + wid / 2, y + len * 0.35, x + bell * 0.46, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(190,225,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(x - bell * 0.3, y);
    ctx.quadraticCurveTo(x, y + len * 0.45, x + bell * 0.3, y);
    ctx.fill();
  }

  /** Draws a craft (FlightCraft) with its centre of mass at (cx, cy), rotated, s px/m. */
  function drawCraft(ctx, craft, cx, cy, rotation, s, opts) {
    opts = opts || {};
    const g = craft.geometry();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    const top = -g.comY * s;
    if (opts.throttle > 0) {
      const firing = new Set();
      for (const per of craft.thrustState(1, 0).per) for (const e of per.sec.engines) if (craft.active.has(e.uid)) firing.add(e.uid);
      for (const p of craft.parts) {
        if (!firing.has(p.uid)) continue;
        drawFlame(ctx, 0, top + (g.tops.get(p.uid) + p.def.height) * s, (p.def.bell || p.def.width) * s, opts.throttle, opts.pressure || 0);
      }
    }
    for (const p of craft.parts) {
      if (p.role === 'legs') drawLegStruts(ctx, p.def, 0, top + (g.tops.get(p.uid) + p.def.height * 0.5) * s, top + g.legReach.get(p.uid) * s, s, strutPaint(p.type, p.paint), p.deploy);
      if (p.role === 'chute' && p.chute.stage !== 'packed' && p.chute.stage !== 'armed') {
        drawChuteCluster(ctx, p.def, 0, top + (g.tops.get(p.uid) + p.def.height * 0.4) * s, s, strutPaint(p.type, p.paint), p.chute);
      }
    }
    for (const p of craft.parts) drawPart(ctx, p.type, 0, top + g.tops.get(p.uid) * s, s, p.paint, p);
    ctx.restore();
  }

  // ------------------------------------------------------------ backgrounds
  const STARS = (() => {
    const r = SB.mulberry32(99);
    const out = [];
    for (let i = 0; i < 420; i++) out.push({ a: r() * TAU, d: Math.sqrt(r()), b: 0.25 + 0.75 * r() * r(), s: r() < 0.08 ? 1.6 : 0.9 });
    return out;
  })();

  function drawStars(ctx, W, H, rot, alpha) {
    if (alpha <= 0.01) return;
    const R = Math.hypot(W, H) * 0.55;
    for (const st of STARS) {
      const x = W / 2 + Math.cos(st.a + rot) * st.d * R;
      const y = H / 2 - Math.sin(st.a + rot) * st.d * R;
      if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
      ctx.fillStyle = `rgba(230,238,255,${(st.b * alpha).toFixed(3)})`;
      ctx.fillRect(x, y, st.s, st.s);
    }
  }

  // Seeded surface decorations for full-disc views (craters, blotches, cracks, clouds).
  const decoCache = new Map();
  function decorations(body) {
    let d = decoCache.get(body.id);
    if (d) return d;
    const r = SB.mulberry32(body.terrain.N + body.radius);
    d = [];
    const n = { cratered: 18, rocky: 10, icy: 9, continental: 9 }[body.style] || 8;
    for (let i = 0; i < n; i++) {
      const a = r() * TAU, rr = Math.sqrt(r()) * 0.82;
      d.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr, r: 0.05 + r() * (body.style === 'cratered' ? 0.16 : 0.3), a: r() * TAU, k: r() });
    }
    decoCache.set(body.id, d);
    return d;
  }

  /**
   * Full silhouette of a body at screen centre (sx, sy), radius px = R*scale, world rotation `rot`,
   * game time t (cloud drift). Uses the GPU sphere texture when available, else flat 2D shading.
   */
  function drawBodyDisc(ctx, sys, body, sx, sy, scale, rot, t) {
    const Rpx = body.radius * scale;
    const pal = body.palette;
    if (Rpx < 1.2) {
      ctx.fillStyle = pal.rim;
      ctx.beginPath(); ctx.arc(sx, sy, 1.6, 0, TAU); ctx.fill();
      return;
    }
    if (body.atmosphere) {
      const A = body.atmosphere;
      const outer = (body.radius + A.height * 1.6) * scale;
      const g = ctx.createRadialGradient(sx, sy, Rpx * 0.98, sx, sy, Math.max(outer, Rpx + 3));
      g.addColorStop(0, pal.glow);
      g.addColorStop(1, 'rgba(120,190,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(outer, Rpx + 3), 0, TAU); ctx.fill();
    }
    const T = body.terrain;
    const M = Math.min(T.N, Math.max(48, Math.round(Rpx * 2.2)));
    const path = new Path2D();
    for (let i = 0; i <= M; i++) {
      const ang = (i / M) * TAU;
      const rr = (body.radius + T.h[Math.floor((i / M) * T.N) % T.N]) * scale;
      const x = sx + Math.cos(ang + rot) * rr, y = sy - Math.sin(ang + rot) * rr;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
    if (Rpx >= 2 && SB.Planets && SB.Planets.init()) {
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      ctx.save();
      ctx.clip(path);
      SB.Planets.draw(ctx, body, sx, sy, (body.radius + body.terrain.maxH) * scale, rot, t || 0, ctx.canvas.width / dpr, ctx.canvas.height / dpr);
      ctx.restore();
      ctx.strokeStyle = alphaOf(pal.rim, 0.16);
      ctx.lineWidth = 1;
      ctx.stroke(path);
      return;
    }
    const g = ctx.createRadialGradient(sx - Rpx * 0.35, sy - Rpx * 0.35, Rpx * 0.1, sx, sy, Rpx * 1.05);
    g.addColorStop(0, shade(pal.surface, 0.18));
    g.addColorStop(0.7, pal.surface);
    g.addColorStop(1, pal.deep);
    ctx.fillStyle = g;
    ctx.fill(path);
    if (Rpx > 6) {
      ctx.save();
      ctx.clip(path);
      for (const dd of decorations(body)) {
        const x = sx + dd.x * Rpx, y = sy + dd.y * Rpx, rr = dd.r * Rpx;
        if (body.style === 'cratered') {
          ctx.fillStyle = alphaOf(pal.deep, 0.35); ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
          ctx.strokeStyle = alphaOf(pal.rim, 0.35); ctx.lineWidth = Math.max(0.6, rr * 0.12);
          ctx.beginPath(); ctx.arc(x, y, rr, Math.PI * 0.9, Math.PI * 1.9); ctx.stroke();
        } else if (body.style === 'icy') {
          ctx.strokeStyle = alphaOf(pal.deep, 0.45); ctx.lineWidth = Math.max(0.6, Rpx * 0.008);
          ctx.beginPath(); ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + Math.cos(dd.a) * rr, y + Math.sin(dd.a) * rr, x + Math.cos(dd.a + 0.6) * rr * 2.2, y + Math.sin(dd.a + 0.6) * rr * 2.2);
          ctx.stroke();
        } else if (body.style === 'rocky') {
          ctx.fillStyle = alphaOf(dd.k > 0.5 ? pal.detail : pal.deep, 0.35);
          ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 0.55, dd.a, 0, TAU); ctx.fill();
        } else {
          ctx.fillStyle = alphaOf(dd.k > 0.4 ? pal.detail : '#3f6fa8', 0.42);
          ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 0.6, dd.a, 0, TAU); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = Math.max(0.6, Rpx * 0.008);
          ctx.beginPath(); ctx.arc(x + rr, y - rr * 0.4, rr * 0.9, dd.a, dd.a + 1.1); ctx.stroke();
        }
      }
      // terminator shading
      const sh = ctx.createLinearGradient(sx - Rpx, sy - Rpx, sx + Rpx, sy + Rpx);
      sh.addColorStop(0.45, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,10,0.45)');
      ctx.fillStyle = sh; ctx.fillRect(sx - Rpx * 1.1, sy - Rpx * 1.1, Rpx * 2.2, Rpx * 2.2);
      ctx.restore();
    }
    ctx.strokeStyle = alphaOf(pal.rim, 0.75);
    ctx.lineWidth = 1;
    ctx.stroke(path);
  }

  /**
   * Close-up terrain: only the arc of surface around `centerAng` within view.
   * toS maps world (global) coordinates to the screen.
   */
  function drawTerrainArc(ctx, sys, body, bp, centerAng, viewM, toS, scale, W, H) {
    const T = body.terrain, R = body.radius;
    const span = Math.min(Math.PI, (viewM * 1.3) / R + 0.002);
    const n0 = Math.floor(((centerAng - span) / TAU) * T.N);
    const n1 = Math.ceil(((centerAng + span) / TAU) * T.N);
    const count = n1 - n0;
    const stride = Math.max(1, Math.ceil(count / 1600));
    const surf = [];
    for (let i = n0; i <= n1; i += stride) {
      const ang = (i / T.N) * TAU;
      const h = T.h[((i % T.N) + T.N) % T.N];
      surf.push(toS(bp[0] + Math.cos(ang) * (R + h), bp[1] + Math.sin(ang) * (R + h)));
    }
    const depth = Math.min(R * 0.9, viewM * 1.6);
    const inner = [];
    const steps = 24;
    for (let k = steps; k >= 0; k--) {
      const ang = centerAng - span + (2 * span * k) / steps;
      const rr = R + T.minH - depth;
      inner.push(toS(bp[0] + Math.cos(ang) * rr, bp[1] + Math.sin(ang) * rr));
    }
    const path = new Path2D();
    surf.forEach((p, i) => (i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1])));
    inner.forEach((p) => path.lineTo(p[0], p[1]));
    path.closePath();
    const pal = body.palette;
    // same sun as the sphere textures: the ground darkens toward night (kept readable for landing)
    const sun = sunlight(centerAng);
    const lit = Math.min(1, Math.max(0.24, sun.light * 1.15)) - 1;
    const groundPx = Math.min(H, Math.max(60, 900 * Math.min(1, scale * 0.6)));
    const midY = surf.length ? surf[surf.length >> 1][1] : H / 2;
    const g = ctx.createLinearGradient(0, midY - 20, 0, midY + groundPx);
    g.addColorStop(0, shade(pal.surface, lit));
    g.addColorStop(1, shade(pal.deep, lit));
    ctx.fillStyle = g;
    ctx.fill(path);
    // strata lines give a sense of depth below the silhouette
    ctx.save();
    ctx.clip(path);
    ctx.lineWidth = 2;
    for (const [off, a] of [[6, 0.35], [16, 0.22], [34, 0.15]]) {
      ctx.strokeStyle = alphaOf(pal.detail, a);
      ctx.beginPath();
      surf.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1] + off) : ctx.moveTo(p[0], p[1] + off)));
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = shade(pal.rim, Math.max(lit, -0.55));
    ctx.lineWidth = 2;
    ctx.beginPath();
    surf.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  }

  function sunlight(ang) {
    if (SB.Planets && SB.Planets.sunAt) return SB.Planets.sunAt(ang);
    return { ndl: 1, light: 1, day: 1 };
  }

  function drawLaunchPad(ctx, sys, toS, scale) {
    const b = sys.planet;
    const a = b.launchAngle;
    const sf = sys.surfaceFrame(b, a);
    const up = [Math.cos(sf.normal), Math.sin(sf.normal)], right = [up[1], -up[0]];
    const base = [Math.cos(a) * sf.R, Math.sin(a) * sf.R];
    const P = (u, v) => toS(base[0] + right[0] * u + up[0] * v, base[1] + right[1] * u + up[1] * v);
    if (scale < 0.05) return;
    const poly = (pts, fill) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
    poly([P(-26, 0.2), P(26, 0.2), P(30, -3), P(-30, -3)], '#7d838c');
    poly([P(-26, 0.2), P(26, 0.2), P(26, -0.4), P(-26, -0.4)], '#a7adb5');
    // service tower
    poly([P(-7.5, 0), P(-5, 0), P(-5, 15), P(-7.5, 15)], '#8f3b2c');
    ctx.strokeStyle = '#d9a35c';
    ctx.lineWidth = Math.max(0.5, scale * 0.12);
    for (let k = 0; k < 15; k += 1.5) {
      const p1 = P(-7.5, k), p2 = P(-5, k + 1.5), p3 = P(-5, k), p4 = P(-7.5, k + 1.5);
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.moveTo(p3[0], p3[1]); ctx.lineTo(p4[0], p4[1]); ctx.stroke();
    }
    poly([P(-7.5, 15), P(-1.2, 15), P(-1.2, 14.4), P(-7.5, 14.4)], '#8f3b2c');
    const lamp = P(-6.25, 15.6);
    ctx.fillStyle = 'rgba(255,90,70,' + (0.5 + 0.5 * Math.sin(performance.now() / 300)) + ')';
    ctx.beginPath(); ctx.arc(lamp[0], lamp[1], Math.max(1.5, scale * 0.3), 0, TAU); ctx.fill();
  }

  // ------------------------------------------------------------ flight view
  function renderFlight(ctx, W, H, app) {
    const f = app.flight, sys = app.sys;
    const st = f.st, b = st.body;
    const s = app.flightView.zoom;
    const cg = f.globalPos();
    const upAng = Math.atan2(st.ry, st.rx);
    const rot = Math.PI / 2 - upAng;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const cx = W / 2, cy = H * 0.5;
    const toS = (gx, gy) => {
      const dx = gx - cg[0], dy = gy - cg[1];
      return [cx + (dx * cosR - dy * sinR) * s, cy - (dx * sinR + dy * cosR) * s];
    };

    // sky: thins with altitude, and goes dark on the night side
    let air = 0;
    if (b.atmosphere) air = Math.pow(sys.density(b, f.altitude()) / b.atmosphere.surfaceDensity, 0.45);
    air *= 0.12 + 0.88 * sunlight(upAng).day;
    const A = sys.planet.atmosphere;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, mix(A.spaceColor, A.skyColor, air * 0.85));
    sky.addColorStop(1, mix(A.spaceColor, A.horizonColor, air));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    drawStars(ctx, W, H, rot, 1 - air * 1.6);

    const viewM = Math.hypot(W, H) / s;
    // bodies (far ones first)
    const order = sys.bodies.slice().sort((p, q) => {
      const pp = sys.bodyPos(p, st.t), qq = sys.bodyPos(q, st.t);
      return Math.hypot(qq[0] - cg[0], qq[1] - cg[1]) - Math.hypot(pp[0] - cg[0], pp[1] - cg[1]);
    });
    for (const body of order) {
      const bp = sys.bodyPos(body, st.t);
      const sc = toS(bp[0], bp[1]);
      const D = Math.hypot(bp[0] - cg[0], bp[1] - cg[1]);
      const Rpx = body.radius * s;
      if (D - body.radius - body.terrain.maxH > viewM) {
        // only the disc might be visible from far away
        if (sc[0] < -Rpx - 50 || sc[0] > W + Rpx + 50 || sc[1] < -Rpx - 50 || sc[1] > H + Rpx + 50) continue;
      }
      // The textured sphere is used until the body is huge on screen; only real close-ups switch
      // to the side-on terrain cross-section (or always, when the GPU textures are unavailable).
      const discLimit = SB.Planets && SB.Planets.ok ? 16000 : 2500;
      if (Rpx < discLimit) drawBodyDisc(ctx, sys, body, sc[0], sc[1], s, rot, st.t);
      else {
        const ca = Math.atan2(cg[1] - bp[1], cg[0] - bp[0]);
        drawTerrainArc(ctx, sys, body, bp, ca, viewM + Math.max(0, D - body.radius), toS, s, W, H);
      }
      if (body.isPlanet && s >= 0.05) drawLaunchPad(ctx, sys, toS, s);
    }

    // debris
    for (const d of f.debris) {
      const bp = sys.bodyPos(d.body, st.t);
      const p = toS(bp[0] + d.rx, bp[1] + d.ry);
      if (p[0] < -200 || p[0] > W + 200 || p[1] < -200 || p[1] > H + 200) continue;
      drawCraft(ctx, d.craft, p[0], p[1], Math.PI / 2 - (d.heading + rot), s, {});
    }

    // craft
    if (f.situation !== 'crashed') {
      const ang = Math.PI / 2 - (f.heading + rot);
      const g = f.geometry();
      if (g.height * s < 10) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
        ctx.fillStyle = '#ffd36b';
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(5, 6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      drawCraft(ctx, f.craft, cx, cy, ang, s, { throttle: f.throttle, pressure: f.pressureRatio() });
    }

    // particles (explosions)
    for (const p of f.particles) {
      const bp = sys.bodyPos(p.body, st.t);
      const q = toS(bp[0] + p.x, bp[1] + p.y);
      const k = 1 - p.age / p.life;
      ctx.fillStyle = k > 0.6 ? `rgba(255,240,180,${k})` : k > 0.3 ? `rgba(255,140,50,${k})` : `rgba(90,80,75,${k})`;
      const r = Math.min(16, Math.max(1.5, p.size * s * 0.25 * (1.5 - k)));
      ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, TAU); ctx.fill();
    }
  }

  // ------------------------------------------------------------ orbital map
  const SEG_COLORS = ['#4fd1ff', '#ffb347', '#c792ff', '#7dffa8'];
  const PLAN_COLORS = ['#ff8ff0', '#ffd36b', '#9dffcf', '#ffa38f'];

  function fmtAlt(m) {
    const a = Math.abs(m);
    if (a < 10000) return `${Math.round(m).toLocaleString()} m`;
    if (a < 1e6) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000).toLocaleString()} km`;
  }

  function fmtDur(s) {
    if (!isFinite(s)) return '—';
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
    return `${sec}s`;
  }

  // ---- map labels
  // Labels are collected while the map is drawn and placed at the end, on top of everything. Each one
  // tries spots around its anchor (its preferred side first, then the others, then a little farther
  // out) and takes the first that is clear of the labels already placed, the map markers and the HUD
  // panels. Higher priorities go first. A label with no room is dropped, unless it is important
  // (priority 3+: nodes, encounters, impacts, the click hint), which then takes its preferred spot.
  const LABEL_FONT = '12px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
  const LABEL_H = 15;
  const SIDES = ['e', 'ne', 'se', 'w', 'nw', 'sw', 'n', 's'];
  let labels = null, obstacles = null;
  const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];

  /** Keeps labels off a marker at (x, y) with half-size r. Only active while the map is drawn. */
  function obstacle(x, y, r) { if (obstacles) obstacles.push([x - r, y - r, 2 * r, 2 * r]); }
  /** gap: distance from the anchor; at least the half-size of the anchor's own marker, so a label never covers it. */
  function label(text, x, y, color, prio, side, gap) {
    if (labels) labels.push({ text, x, y, color, prio: prio || 1, side: side || 'e', gap: gap || 10, i: labels.length });
  }

  function labelSpot(side, x, y, w, gap) {
    const h = LABEL_H;
    switch (side) {
      case 'e': return [x + gap, y - h / 2];
      case 'ne': return [x + gap, y - gap - h];
      case 'se': return [x + gap, y + gap];
      case 'w': return [x - gap - w, y - h / 2];
      case 'nw': return [x - gap - w, y - gap - h];
      case 'sw': return [x - gap - w, y + gap];
      case 'n': return [x - w / 2, y - gap - h];
      default: return [x - w / 2, y + gap];
    }
  }

  function placeLabels(ctx, W, H) {
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(3,6,14,0.85)';
    const done = [];
    const clear = (r) => r[0] >= 2 && r[1] >= 2 && r[0] + r[2] <= W - 2 && r[1] + r[3] <= H - 2 &&
      !done.some((q) => overlaps(r, q.r)) && !obstacles.some((q) => overlaps(r, q));
    labels.sort((a, b) => b.prio - a.prio || a.i - b.i);
    for (const L of labels) {
      const w = ctx.measureText(L.text).width + 4;
      const order = [L.side].concat(SIDES.filter((s) => s !== L.side));
      let rect = null;
      for (const gap of [L.gap, L.gap + 16]) {
        for (const s of order) {
          const p = labelSpot(s, L.x, L.y, w, gap);
          const r = [p[0], p[1], w, LABEL_H];
          if (clear(r)) { rect = r; break; }
        }
        if (rect) break;
      }
      let forced = false;
      if (!rect) {
        if (L.prio < 3) continue;
        const p = labelSpot(L.side, L.x, L.y, w, L.gap);
        rect = [p[0], p[1], w, LABEL_H];
        forced = true;
      }
      done.push({ text: L.text, r: rect, prio: L.prio, forced });
      ctx.strokeText(L.text, rect[0] + 2, rect[1] + LABEL_H / 2);
      ctx.fillStyle = L.color;
      ctx.fillText(L.text, rect[0] + 2, rect[1] + LABEL_H / 2);
    }
    return done;
  }

  function marker(ctx, type, x, y, color) {
    obstacle(x, y, 8);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    if (type === 'ap' || type === 'pe') {
      ctx.beginPath();
      if (type === 'ap') { ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y + 4); ctx.lineTo(x - 6, y + 4); }
      else { ctx.moveTo(x, y + 7); ctx.lineTo(x + 6, y - 4); ctx.lineTo(x - 6, y - 4); }
      ctx.closePath(); ctx.fill();
    } else if (type === 'impact') {
      ctx.strokeStyle = '#ff5d5d';
      ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke();
    } else if (type === 'atmo') {
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.stroke();
    } else if (type === 'soi') {
      ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  function progradeMarker(ctx, x, y, retro) {
    obstacle(x, y, 12);
    ctx.strokeStyle = '#9dff6b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.stroke();
    ctx.beginPath();
    if (!retro) {
      ctx.arc(x, y, 1.5, 0, TAU); ctx.fillStyle = '#9dff6b'; ctx.fill();
      ctx.moveTo(x, y - 6); ctx.lineTo(x, y - 11); ctx.moveTo(x - 6, y); ctx.lineTo(x - 11, y); ctx.moveTo(x + 6, y); ctx.lineTo(x + 11, y);
    } else {
      ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4);
      ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 11); ctx.moveTo(x - 6, y); ctx.lineTo(x - 11, y); ctx.moveTo(x + 6, y); ctx.lineTo(x + 11, y);
    }
    ctx.stroke();
  }

  function radialMarker(ctx, x, y, inward) {
    obstacle(x, y, 11);
    ctx.strokeStyle = '#5ee6ff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.stroke();
    ctx.beginPath();
    if (!inward) {
      ctx.arc(x, y, 1.5, 0, TAU); ctx.fillStyle = '#5ee6ff'; ctx.fill();
      for (const a of [0.785, 2.356, 3.927, 5.498]) { ctx.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6); ctx.lineTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10); }
    } else {
      for (const a of [0.785, 2.356, 3.927, 5.498]) { ctx.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6); ctx.lineTo(x + Math.cos(a) * 2, y + Math.sin(a) * 2); }
    }
    ctx.stroke();
  }

  function maneuverMarker(ctx, x, y) {
    ctx.strokeStyle = '#5ea2ff'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.stroke();
    ctx.beginPath();
    for (const a of [0, 1.571, 3.142, 4.712]) { ctx.moveTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7); ctx.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12); }
    ctx.stroke();
    ctx.fillStyle = '#5ea2ff'; ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill();
  }

  function renderMap(ctx, W, H, app) {
    const f = app.flight, sys = app.sys, mv = app.mapView;
    const t = f.st.t;
    const focus = mv.focusPoint(t);
    const sc = mv.scale;
    const toS = (x, y) => [W / 2 + (x - focus[0]) * sc, H / 2 - (y - focus[1]) * sc];

    ctx.fillStyle = '#04070f';
    ctx.fillRect(0, 0, W, H);
    drawStars(ctx, W, H, 0, 0.6);
    labels = [];
    obstacles = mv.hudRects().slice(); // labels stay out from under the HUD panels
    const focusBody = mv.focusBody();

    // moon orbits and SOIs
    const pc = toS(0, 0);
    for (const m of sys.moons) {
      ctx.strokeStyle = 'rgba(140,170,220,0.16)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(pc[0], pc[1], m.orbitRadius * sc, 0, TAU); ctx.stroke();
      const mp = sys.bodyPos(m, t), q = toS(mp[0], mp[1]);
      const soiPx = m.soi * sc;
      if (soiPx > 4) {
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = f.target === m ? 'rgba(255,200,90,0.55)' : 'rgba(160,190,240,0.3)';
        ctx.beginPath(); ctx.arc(q[0], q[1], soiPx, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // bodies
    for (const body of sys.bodies) {
      const bp = sys.bodyPos(body, t), q = toS(bp[0], bp[1]);
      const Rpx = body.radius * sc;
      if (q[0] < -Rpx - 40 || q[0] > W + Rpx + 40 || q[1] < -Rpx - 40 || q[1] > H + Rpx + 40) continue;
      drawBodyDisc(ctx, sys, body, q[0], q[1], sc, 0, t);
      if (Rpx < 4) { ctx.fillStyle = body.palette.rim; ctx.beginPath(); ctx.arc(q[0], q[1], 3.5, 0, TAU); ctx.fill(); }
      const lr = Math.max(Rpx, 4);
      const name = body.name + (f.target === body ? ' ◎' : ''), col = f.target === body ? '#ffc861' : '#cfe0ff', prio = f.target === body ? 2 : 1;
      if (lr < 40) { obstacle(q[0], q[1], lr + 2); label(name, q[0], q[1], col, prio, 'ne', lr + 3); }
      else label(name, q[0] + lr * 0.72, q[1] - lr * 0.72, col, prio, 'ne', 8); // big discs: just off the rim
    }

    // trajectories: the actual prediction, then the planned leg after each maneuver node
    const pred = f.prediction;
    const planner = f.planner;
    const plan = planner.plan;
    const firstNodeT = planner.count ? planner.nodes[0].t : Infinity;
    const pick = [];
    const ghosts = new Set();
    // Moon-frame arcs follow the moon itself when it is the current SOI or the map focus;
    // otherwise they are drawn around a "ghost" of the moon at the time its SOI is entered.
    const isLive = (body, refT) => !body.parent || body === f.body || body === focusBody || !isFinite(refT);
    const refPos = (body, refT) => (body.parent ? sys.bodyPos(body, isLive(body, refT) ? t : refT) : [0, 0]);
    const drawGhost = (body, refT) => {
      const key = body.id + ':' + Math.round(refT);
      if (ghosts.has(key)) return;
      ghosts.add(key);
      const r = refPos(body, refT), g = toS(r[0], r[1]);
      ctx.globalAlpha = 0.45;
      drawBodyDisc(ctx, sys, body, g[0], g[1], sc, 0, t);
      ctx.globalAlpha = 1;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,190,100,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(g[0], g[1], Math.max(4, body.soi * sc), 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    };
    const polyline = (xs, ys, from, to) => {
      if (to - from < 1) return;
      ctx.beginPath();
      ctx.moveTo(xs[from], ys[from]);
      for (let k = from + 1; k <= to; k++) ctx.lineTo(xs[k], ys[k]);
      ctx.stroke();
    };
    function drawLayer(pr, layerIdx) {
      const planned = layerIdx > 0;
      pr.segments.forEach((seg, i) => {
        const P = seg.points;
        const ref = refPos(seg.body, seg.refT);
        const col = planned ? PLAN_COLORS[i % PLAN_COLORS.length] : SEG_COLORS[i % SEG_COLORS.length];
        // The actual path is dimmed after the first node; a planned leg stops at the next node.
        const limitT = planned ? pr.drawUntil : firstNodeT;
        const xs = new Array(P.xs.length), ys = new Array(P.xs.length);
        let cut = P.xs.length - 1;
        for (let k = 0; k < P.xs.length; k++) {
          const q = toS(ref[0] + P.xs[k], ref[1] + P.ys[k]);
          xs[k] = q[0]; ys[k] = q[1];
          if (P.ts[k] > limitT && cut === P.xs.length - 1) cut = k;
        }
        // kept for dragging a node later along its leg, even where the leg is not drawn
        pick.push({ layer: layerIdx, xs, ys, ts: P.ts, maxT: limitT, body: seg.body, wx: P.xs, wy: P.ys });
        if (planned && seg.t0 > limitT) return;
        if (seg.body.parent && !isLive(seg.body, seg.refT)) drawGhost(seg.body, seg.refT);
        ctx.strokeStyle = col;
        ctx.lineWidth = planned ? 2.2 : 2;
        if (planned) ctx.setLineDash([9, 6]);
        polyline(xs, ys, 0, cut);
        if (!planned && cut < P.xs.length - 1) { ctx.globalAlpha = 0.28; polyline(xs, ys, cut, P.xs.length - 1); ctx.globalAlpha = 1; }
        ctx.setLineDash([]);
        for (const mk of seg.marks) {
          if (mk.t > limitT) continue; // beyond the next node (or, for the actual path, the first node)
          if ((mk.type === 'ap' || mk.type === 'pe') && seg.el.e < 1e-3) continue; // circular: apsides are arbitrary
          const q = toS(ref[0] + mk.pos[0], ref[1] + mk.pos[1]);
          marker(ctx, mk.type, q[0], q[1], col);
          const dt = mk.t - t;
          if (mk.type === 'ap') label(`Ap ${fmtAlt(mk.alt)} · ${fmtDur(dt)}`, q[0], q[1], col, 2, 'ne');
          if (mk.type === 'pe') label(`Pe ${fmtAlt(mk.alt)} · ${fmtDur(dt)}`, q[0], q[1], col, 2, 'se');
          if (mk.type === 'impact') {
            // the path ignores drag: under parachutes the touchdown estimate gives the real time
            const est = layerIdx === 0 && seg.body === f.body ? f.chuteDescent() : null;
            label(est ? `Touchdown under chutes · ${fmtDur(est.t)}` : `Impact ${seg.body.name} · ${fmtDur(dt)}`, q[0], q[1], est ? '#9dffcf' : '#ff8a8a', 3, 'e');
          }
          if (mk.type === 'atmo') label('Atmosphere', q[0], q[1], col, 1, 'e');
        }
        if (seg.end && seg.end.type === 'soi' && seg.end.t <= limitT) {
          const last = P.xs.length - 1;
          marker(ctx, 'soi', xs[last], ys[last], planned ? PLAN_COLORS[(i + 1) % PLAN_COLORS.length] : SEG_COLORS[(i + 1) % SEG_COLORS.length]);
          const enc = !!seg.end.to.parent;
          const txt = enc ? `Encounter ${seg.end.to.name} · ${fmtDur(seg.end.t - t)}` : `Leave ${seg.end.from.name} SOI · ${fmtDur(seg.end.t - t)}`;
          label(txt, xs[last], ys[last], '#ffd28a', enc ? 3 : 2, 'ne');
        }
      });
    }
    if (pred) drawLayer(pred, 0);
    if (plan) plan.layers.forEach((L, i) => drawLayer(L, i + 1));
    mv.pick = pick;

    const lastLayer = plan && plan.layers.length ? plan.layers[plan.layers.length - 1] : pred;
    const ca = lastLayer && lastLayer.closest;
    if (ca && !ca.encounter) {
      const a = toS(ca.craftPos[0], ca.craftPos[1]), m = toS(ca.moonPos[0], ca.moonPos[1]);
      ctx.setLineDash([2, 4]); ctx.strokeStyle = 'rgba(255,200,97,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(m[0], m[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 0.4;
      drawBodyDisc(ctx, sys, ca.target, m[0], m[1], sc, 0, t);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ffc861'; ctx.beginPath(); ctx.arc(m[0], m[1], Math.max(5, ca.target.soi * sc), 0, TAU); ctx.stroke();
      marker(ctx, 'atmo', a[0], a[1], '#ffc861');
      label(`Closest ${ca.target.name}: ${fmtAlt(ca.dist)} · ${fmtDur(ca.t - t)}`, a[0], a[1], '#ffc861', 2, 'se');
    }

    // maneuver nodes and the selected node's handles
    mv.nodeScreens = [];
    mv.handles = [];
    if (plan) {
      for (const inf of plan.infos) {
        if (!inf.valid) continue;
        const ref = refPos(inf.pre.body, inf.pre.soiT);
        const q = toS(ref[0] + inf.pre.rx, ref[1] + inf.pre.ry);
        const sel = inf.node === planner.selected;
        mv.nodeScreens.push({ node: inf.node, x: q[0], y: q[1] });
        if (sel) {
          const A = inf.ax, R0 = 38;
          const defs = [
            { comp: 'pro', sign: 1, ax: [A.px, -A.py], kind: 'pro' },
            { comp: 'pro', sign: -1, ax: [-A.px, A.py], kind: 'retro' },
            { comp: 'rad', sign: 1, ax: [A.nx, -A.ny], kind: 'radout' },
            { comp: 'rad', sign: -1, ax: [-A.nx, A.ny], kind: 'radin' },
          ];
          for (const h of defs) {
            const drag = mv.drag && mv.drag.node === inf.node && mv.drag.comp === h.comp && mv.drag.sign === h.sign ? mv.drag.d : 0;
            const hx = q[0] + h.ax[0] * (R0 + drag), hy = q[1] + h.ax[1] * (R0 + drag);
            ctx.strokeStyle = 'rgba(200,220,255,0.35)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(q[0] + h.ax[0] * 9, q[1] + h.ax[1] * 9); ctx.lineTo(hx, hy); ctx.stroke();
            if (h.kind === 'pro' || h.kind === 'retro') progradeMarker(ctx, hx, hy, h.kind === 'retro');
            else radialMarker(ctx, hx, hy, h.kind === 'radin');
            mv.handles.push(Object.assign({ node: inf.node, x: q[0] + h.ax[0] * R0, y: q[1] + h.ax[1] * R0 }, h));
          }
        }
        ctx.fillStyle = sel ? '#5ea2ff' : '#3b6fd1';
        ctx.strokeStyle = '#eaf2ff';
        ctx.lineWidth = 2;
        if (sel) { ctx.shadowColor = '#5ea2ff'; ctx.shadowBlur = 12; }
        ctx.beginPath(); ctx.arc(q[0], q[1], sel ? 7.5 : 6, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.shadowBlur = 0;
        obstacle(q[0], q[1], 10);
        const idx = planner.indexOf(inf.node) + 1;
        label(`Node ${idx} · Δv ${inf.total.toFixed(1)} m/s · ${inf.node.t > t ? fmtDur(inf.node.t - t) : 'now'}`, q[0], q[1], '#9cc4ff', sel ? 5 : 4, 'se', 12);
      }
    }
    if (mv.hover && !mv.drag) {
      const h = mv.hover;
      ctx.strokeStyle = '#eaf2ff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(h.x, h.y, 6, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(h.x - 3.5, h.y); ctx.lineTo(h.x + 3.5, h.y); ctx.moveTo(h.x, h.y - 3.5); ctx.lineTo(h.x, h.y + 3.5); ctx.stroke();
      obstacle(h.x, h.y, 8);
      label(`Alt ${fmtAlt(h.alt)}${h.body !== f.body ? ` (${h.body.name})` : ''} · ${fmtDur(h.t - t)}`, h.x, h.y, '#eaf2ff', 6, 'ne');
    }

    // craft
    if (f.situation !== 'crashed') {
      const g = f.globalPos(), q = toS(g[0], g[1]);
      ctx.save(); ctx.translate(q[0], q[1]); ctx.rotate(Math.PI / 2 - f.heading);
      ctx.fillStyle = '#ffd36b'; ctx.strokeStyle = '#1a1206'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(6, 7); ctx.lineTo(0, 4); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      obstacle(q[0], q[1], 12);
      const v = f.speed();
      if (v > 0.5 && !f.isLanded()) {
        const ux = f.st.vx / v, uy = f.st.vy / v;
        progradeMarker(ctx, q[0] + ux * 30, q[1] - uy * 30, false);
        progradeMarker(ctx, q[0] - ux * 30, q[1] + uy * 30, true);
      }
    } else {
      const g = f.globalPos(), q = toS(g[0], g[1]);
      marker(ctx, 'impact', q[0], q[1]);
    }

    // scale bar
    const nice = [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6];
    let bar = nice[0];
    for (const n of nice) if (n * sc < W * 0.18) bar = n;
    const bx = W - 30 - bar * sc, by = H - 26;
    ctx.strokeStyle = '#8fa3c3'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by); ctx.lineTo(bx + bar * sc, by); ctx.lineTo(bx + bar * sc, by - 5); ctx.stroke();
    ctx.font = LABEL_FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8fa3c3';
    ctx.fillText(fmtAlt(bar), bx + (bar * sc) / 2, by - 12);
    obstacles.push([bx - 4, by - 22, bar * sc + 8, 26]);

    // labels last, on top of every marker
    mv.labelInfo = { placed: placeLabels(ctx, W, H), obstacles, requested: labels.length };
    labels = null;
    obstacles = null;
  }

  // ------------------------------------------------------------ attitude dial
  function renderDial(ctx, size, f) {
    const c = size / 2, R = size / 2 - 4;
    ctx.clearRect(0, 0, size, size);
    const st = f.st;
    const up = Math.atan2(st.ry, st.rx);
    const dirTo = (ang, rr) => { const rel = SB.Orbit.wrapPi(ang - up); return [c - Math.sin(rel) * rr, c - Math.cos(rel) * rr]; };
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.clip();
    const b = st.body;
    ctx.fillStyle = b.atmosphere ? '#2f6fb1' : '#18213a';
    ctx.fillRect(0, 0, size, c);
    ctx.fillStyle = shade(b.palette.surface, -0.35);
    ctx.fillRect(0, c, size, c);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, c); ctx.lineTo(size, c); ctx.stroke();
    ctx.restore();
    // ticks
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
    for (let d = 0; d < 360; d += 15) {
      const a = (d * Math.PI) / 180;
      const r0 = d % 45 === 0 ? R - 9 : R - 5;
      ctx.beginPath(); ctx.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0); ctx.lineTo(c + Math.sin(a) * R, c - Math.cos(a) * R); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(200,220,255,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.stroke();
    // prograde / retrograde
    const v = f.speed();
    if (v > 0.3) {
      const va = Math.atan2(st.vy, st.vx);
      const p = dirTo(va, R * 0.68), q = dirTo(va + Math.PI, R * 0.68);
      progradeMarker(ctx, p[0], p[1], false);
      progradeMarker(ctx, q[0], q[1], true);
    }
    const bv = f.planner.burnVector();
    if (bv && Math.hypot(bv[0], bv[1]) > 0.05) {
      const p = dirTo(Math.atan2(bv[1], bv[0]), R * 0.55);
      maneuverMarker(ctx, p[0], p[1]);
    }
    // craft needle
    const tip = dirTo(f.heading, R * 0.82), tail = dirTo(f.heading + Math.PI, R * 0.45);
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(tail[0], tail[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke();
    ctx.fillStyle = '#ffd36b';
    ctx.beginPath(); ctx.arc(tip[0], tip[1], 4, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(c, c, 3, 0, TAU); ctx.fill();
    const tilt = -SB.Orbit.wrapPi(f.heading - up) * (180 / Math.PI);
    ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(3,6,14,0.7)';
    roundRect(ctx, c - 26, size - 30, 52, 16, 4); ctx.fill();
    ctx.fillStyle = '#e8f0ff';
    ctx.fillText(`${Math.abs(tilt).toFixed(0)}° ${tilt > 0.5 ? 'R' : tilt < -0.5 ? 'L' : ''}`, c, size - 22);
  }

  SB.Render = { drawPart, drawLegStruts, drawChuteCluster, drawCanopy, drawCraft, renderFlight, renderMap, renderDial, drawBodyDisc, fmtAlt, fmtDur, mix, shade, roundRect };
})(typeof window !== 'undefined' ? window : globalThis);
