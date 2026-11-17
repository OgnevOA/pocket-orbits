/*
 * Two-body orbital mechanics: universal-variable Kepler propagation and orbital elements.
 * Works for elliptic, parabolic, hyperbolic and purely radial trajectories.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const TAU = Math.PI * 2;

  function stumpC(z) {
    if (z > 1e-3) { const s = Math.sqrt(z); return (1 - Math.cos(s)) / z; }
    if (z < -1e-3) { const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / (-z); }
    return 0.5 - z / 24 + (z * z) / 720 - (z * z * z) / 40320;
  }

  function stumpS(z) {
    if (z > 1e-3) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
    if (z < -1e-3) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); }
    return 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880;
  }

  /**
   * Propagate state (rx, ry, vx, vy) by dt seconds around a body with parameter mu.
   * Writes [rx, ry, vx, vy] into `out` (allocated when omitted) and returns it.
   */
  function propagate(mu, rx, ry, vx, vy, dt, out) {
    out = out || [0, 0, 0, 0];
    if (dt === 0) { out[0] = rx; out[1] = ry; out[2] = vx; out[3] = vy; return out; }
    if (dt < 0) {
      // Time reversal: integrate the mirrored velocity forward, then flip it back.
      propagate(mu, rx, ry, -vx, -vy, -dt, out);
      out[2] = -out[2]; out[3] = -out[3];
      return out;
    }
    const r0 = Math.hypot(rx, ry);
    const v0sq = vx * vx + vy * vy;
    const rv = rx * vx + ry * vy;
    const alpha = 2 / r0 - v0sq / mu; // reciprocal semi-major axis
    const sqmu = Math.sqrt(mu);

    if (alpha > 1e-15) {
      const period = TAU / Math.sqrt(mu * alpha * alpha * alpha);
      if (dt > period) dt = dt % period;
    }

    const vr0 = rv / sqmu; // r0 * vr0 / sqrt(mu)
    const k1 = 1 - alpha * r0;

    // Initial guess
    let x;
    if (alpha > 1e-15) {
      x = sqmu * dt * alpha;
    } else if (alpha < -1e-15) {
      const a = 1 / alpha;
      const arg = (-2 * mu * alpha * dt) / (rv + Math.sqrt(-mu * a) * (1 - r0 * alpha));
      x = arg > 0 ? Math.sqrt(-a) * Math.log(arg) : NaN;
      if (!(x > 0) || !isFinite(x)) x = (sqmu * dt) / r0;
    } else {
      x = (sqmu * dt) / r0;
    }
    if (!(x > 0)) x = (sqmu * dt) / r0;

    // F(x) is monotonically increasing (dF/dx = r > 0): safeguarded Newton with a bracket.
    let lo = 0, hi = Infinity;
    const target = sqmu * dt;
    let C = 0.5, S = 1 / 6;
    for (let iter = 0; iter < 100; iter++) {
      const x2 = x * x;
      const z = alpha * x2;
      C = stumpC(z); S = stumpS(z);
      const F = vr0 * x2 * C + k1 * x2 * x * S + r0 * x - target;
      const dF = vr0 * x * (1 - z * S) + k1 * x2 * C + r0;
      if (!isFinite(F) || F > 0) hi = x; else lo = x;
      let xn = x - F / dF;
      if (!isFinite(F) || !isFinite(xn) || xn <= lo || xn >= hi) {
        xn = isFinite(hi) ? 0.5 * (lo + hi) : Math.max(2 * x, 1e-6);
      }
      if (Math.abs(xn - x) <= 1e-13 * Math.max(1, Math.abs(x))) { x = xn; break; }
      x = xn;
    }
    const x2 = x * x;
    const z = alpha * x2;
    C = stumpC(z); S = stumpS(z);
    const f = 1 - (x2 / r0) * C;
    const g = dt - ((x2 * x) / sqmu) * S;
    const nx = f * rx + g * vx;
    const ny = f * ry + g * vy;
    const r = Math.hypot(nx, ny);
    const fdot = (sqmu / (r * r0)) * (z * x * S - x);
    const gdot = 1 - (x2 / r) * C;
    out[0] = nx; out[1] = ny;
    out[2] = fdot * rx + gdot * vx;
    out[3] = fdot * ry + gdot * vy;
    return out;
  }

  function wrapPi(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
  }

  /** Classical elements of the osculating conic. Distances from the body centre. */
  function elements(mu, rx, ry, vx, vy) {
    const r = Math.hypot(rx, ry);
    const v2 = vx * vx + vy * vy;
    const rv = rx * vx + ry * vy;
    const h = rx * vy - ry * vx; // >0 counter-clockwise
    const energy = v2 / 2 - mu / r;
    const k = v2 - mu / r;
    const ex = (k * rx - rv * vx) / mu;
    const ey = (k * ry - rv * vy) / mu;
    const e = Math.hypot(ex, ey);
    const p = (h * h) / mu;
    const a = Math.abs(energy) < 1e-12 ? Infinity : -mu / (2 * energy);
    let rp, ra;
    if (e < 1) {
      rp = a * (1 - e);
      ra = a * (1 + e);
    } else {
      rp = p / (1 + e);
      ra = Infinity;
    }
    const sense = h >= 0 ? 1 : -1;
    const argp = e > 1e-9 ? Math.atan2(ey, ex) : Math.atan2(ry, rx);
    const nu = e > 1e-9 ? wrapPi(sense * (Math.atan2(ry, rx) - argp)) : 0;
    let period = Infinity, timeToPe = NaN, timeToAp = NaN, meanMotion = 0;
    if (e < 1 && a > 0) {
      meanMotion = Math.sqrt(mu / (a * a * a));
      period = TAU / meanMotion;
      // Eccentric anomaly from true anomaly (robust form)
      const E = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu));
      let M = E - e * Math.sin(E); // (-pi, pi]
      timeToPe = (M <= 0 ? -M : TAU - M) / meanMotion;
      let dAp = Math.PI - M;
      dAp = ((dAp % TAU) + TAU) % TAU;
      timeToAp = dAp / meanMotion;
      if (e < 1e-9) { timeToPe = 0; timeToAp = period / 2; }
    } else if (e > 1 && a < 0) {
      meanMotion = Math.sqrt(mu / (-a * -a * -a));
      const cosNu = Math.cos(nu);
      const coshF = (e + cosNu) / (1 + e * cosNu);
      let F = Math.acosh(Math.max(1, coshF));
      if (nu < 0) F = -F;
      const M = e * Math.sinh(F) - F;
      timeToPe = -M / meanMotion; // negative once past periapsis
    } else {
      // parabolic / radial: estimate time to periapsis from radial velocity
      timeToPe = rv < 0 ? r / Math.max(1e-6, Math.sqrt(v2)) : -1;
    }
    return { r, v: Math.sqrt(v2), h, sense, energy, e, ex, ey, a, p, rp, ra, argp, nu, period, timeToPe, timeToAp, meanMotion };
  }

  /** Position (relative to focus) of the periapsis / apoapsis of an element set. */
  function apsisPositions(el) {
    const c = Math.cos(el.argp), s = Math.sin(el.argp);
    return {
      pe: [el.rp * c, el.rp * s],
      ap: isFinite(el.ra) ? [-el.ra * c, -el.ra * s] : null,
    };
  }

  SB.Orbit = { propagate, elements, apsisPositions, wrapPi, stumpC, stumpS, TAU };
})(typeof window !== 'undefined' ? window : globalThis);
