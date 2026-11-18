/*
 * Part paint: every part has a main colour, an accent colour and (pods and tanks) a pattern.
 * A part's `paint` is optional and sparse; anything missing falls back to its role's defaults
 * in SB.CONFIG.paint, so old designs keep their look.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const HEX = /^#[0-9a-f]{6}$/i;

  const cfg = () => SB.CONFIG.paint;
  const roleOf = (type) => (SB.Craft ? SB.Craft.role(type) : null);
  const roleCfg = (role) => cfg().roles[role] || { base: '#888888', accent: '#555555', patterns: [], labels: ['Main', 'Accent'] };

  /** Full paint for a part: { base, accent, pattern }. */
  function resolve(type, paint) {
    const rc = roleCfg(roleOf(type));
    const p = paint || {};
    return {
      base: HEX.test(p.base) ? p.base : rc.base,
      accent: HEX.test(p.accent) ? p.accent : rc.accent,
      pattern: rc.patterns.includes(p.pattern) ? p.pattern : rc.patterns[0] || null,
    };
  }

  /** Keeps only valid fields that differ from the defaults; null when nothing is left. */
  function sanitize(type, paint) {
    if (!paint || typeof paint !== 'object') return null;
    const rc = roleCfg(roleOf(type));
    const out = {};
    if (HEX.test(paint.base) && paint.base.toLowerCase() !== rc.base) out.base = paint.base.toLowerCase();
    if (HEX.test(paint.accent) && paint.accent.toLowerCase() !== rc.accent) out.accent = paint.accent.toLowerCase();
    if (rc.patterns.includes(paint.pattern) && paint.pattern !== rc.patterns[0]) out.pattern = paint.pattern;
    return Object.keys(out).length ? out : null;
  }

  const patterns = (type) => roleCfg(roleOf(type)).patterns.slice();
  const labels = (type) => roleCfg(roleOf(type)).labels.slice();
  const liveries = () => cfg().liveries.slice();
  const palette = () => cfg().palette.slice();

  /** The paint a livery gives a part of this type (null = defaults). */
  function liveryPaint(livery, type) {
    return sanitize(type, (livery.roles || {})[roleOf(type)] || null);
  }

  const PATTERN_NAMES = { plain: 'Plain', bands: 'Bands', rings: 'Rings', checker: 'Checker', split: 'Split', stripe: 'Stripe' };

  SB.Paint = { resolve, sanitize, patterns, labels, liveries, palette, liveryPaint, PATTERN_NAMES, HEX };
})(typeof window !== 'undefined' ? window : globalThis);
