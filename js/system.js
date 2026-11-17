/*
 * The planetary system: bodies, moon ephemerides (circular orbits on rails),
 * spheres of influence, atmosphere and procedurally generated terrain silhouettes.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const TAU = Math.PI * 2;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /** Builds a height table h(theta) sampled uniformly around the body. */
  function makeTerrain(body, tc, launchSite) {
    const N = tc.samples || 16384;
    const R = body.radius;
    const rand = mulberry32(tc.seed || 1);
    const h = new Float64Array(N);
    const dTheta = TAU / N;

    function harmonics(count, kMin, kMax, amp, power, ridge) {
      for (let c = 0; c < count; c++) {
        const k = Math.max(1, Math.round(kMin * Math.pow(kMax / kMin, rand())));
        const a = amp * Math.pow(kMin / k, power) * (0.6 + 0.8 * rand());
        const ph = rand() * TAU;
        for (let i = 0; i < N; i++) {
          const s = Math.sin(k * i * dTheta + ph);
          h[i] += ridge ? a * (0.55 - Math.abs(s)) : a * s;
        }
      }
    }

    // Adds height * profile(d) where d = arc distance / width (only near the centre).
    function feature(center, width, height, profile, reach) {
      const span = Math.ceil(((width * (reach || 3)) / (TAU * R)) * N);
      const ci = Math.round((center / TAU) * N);
      for (let j = -span; j <= span; j++) {
        const i = (((ci + j) % N) + N) % N;
        const d = (Math.abs(j) * dTheta * R) / width;
        h[i] += height * profile(d);
      }
    }

    const craters = []; // equatorial craters, shared with the sphere texture
    const crater = (rim) => (d) => (d < 1 ? -(1 - d * d) : 0) + rim * Math.exp(-((d - 1) / 0.28) * ((d - 1) / 0.28));

    switch (tc.style) {
      case 'continental': {
        harmonics(10, 2, 12, 320, 0.3);
        harmonics(18, 12, 120, 160, 0.6);
        harmonics(24, 120, 1500, 35, 0.8);
        for (let m = 0; m < 8; m++) {
          const ph = rand() * TAU;
          feature(rand() * TAU, 5000 + rand() * 14000, 450 + rand() * 650,
            (d) => (d < 1.6 ? Math.exp(-d * d * 2.2) * (0.72 + 0.28 * Math.cos(d * 9 + ph)) : 0), 1.6);
        }
        break;
      }
      case 'cratered': {
        harmonics(6, 2, 8, 140, 0.3);
        harmonics(12, 8, 80, 50, 0.6);
        harmonics(16, 80, 600, 2.5, 0.8);
        for (let c = 0; c < 2; c++) {
          const rc = 2800 + rand() * 1600, ang = rand() * TAU;
          feature(ang, rc, rc * 0.1, crater(0.25), 2.2);
          craters.push({ ang, w: rc / R });
        }
        for (let c = 0; c < 64; c++) {
          const rc = 150 * Math.pow(12, Math.pow(rand(), 1.7)), ang = rand() * TAU;
          feature(ang, rc, rc * 0.12, crater(0.3), 2.2);
          craters.push({ ang, w: rc / R });
        }
        break;
      }
      case 'rocky': {
        harmonics(8, 2, 10, 380, 0.3);
        harmonics(20, 10, 160, 360, 0.55, true);
        harmonics(24, 160, 1200, 22, 0.8);
        // flat-topped mesas with cliff edges
        for (let m = 0; m < 7; m++) {
          feature(rand() * TAU, 1500 + rand() * 3500, 300 + rand() * 500,
            (d) => (d < 1 ? 1 : d < 1.22 ? 1 - smoothstep(1, 1.22, d) : 0), 1.3);
        }
        // terracing gives stepped shelves (good landing spots) and a jagged outline
        const step = 220;
        for (let i = 0; i < N; i++) {
          const q = h[i] / step;
          const f = q - Math.floor(q);
          h[i] = step * (Math.floor(q) + smoothstep(0.38, 0.62, f));
        }
        break;
      }
      case 'icy': {
        harmonics(8, 2, 9, 320, 0.3);
        harmonics(10, 9, 60, 110, 0.6);
        harmonics(14, 300, 1500, 3, 0.8);
        for (let s = 0; s < 12; s++) {
          feature(rand() * TAU, 1200 + rand() * 2400, 500 + rand() * 800,
            (d) => (d < 1 ? Math.pow(1 - d, 2.4) : 0), 1.05);
        }
        for (let s = 0; s < 8; s++) {
          feature(rand() * TAU, 300 + rand() * 300, 80 + rand() * 140, (d) => Math.exp(-d * d * 4), 2);
        }
        break;
      }
      default:
        harmonics(10, 2, 60, 200, 0.5);
    }

    if (launchSite) {
      const c = (launchSite.angleDeg * Math.PI) / 180;
      const flat = launchSite.flatHalfWidth, blend = launchSite.blend;
      const span = Math.ceil(((flat + blend) / (TAU * R)) * N) + 1;
      const ci = Math.round((c / TAU) * N);
      for (let j = -span; j <= span; j++) {
        const i = (((ci + j) % N) + N) % N;
        const d = Math.abs(j) * dTheta * R;
        const w = 1 - smoothstep(flat, flat + blend, d);
        h[i] = h[i] * (1 - w) + launchSite.elevation * w;
      }
    }

    let minH = Infinity, maxH = -Infinity;
    for (let i = 0; i < N; i++) { if (h[i] < minH) minH = h[i]; if (h[i] > maxH) maxH = h[i]; }
    return { h, N, minH, maxH, craters };
  }

  class PlanetSystem {
    constructor(cfg) {
      this.cfg = cfg;
      const pc = cfg.planet;
      const planet = {
        index: 0, id: pc.id, name: pc.name, kind: pc.kind, isPlanet: true,
        radius: pc.radius, surfaceGravity: pc.surfaceGravity, mu: pc.surfaceGravity * pc.radius * pc.radius,
        soi: Infinity, parent: null, orbitRadius: 0, meanMotion: 0, startAngle: 0, speed: 0,
        atmosphere: pc.atmosphere, palette: pc.palette, style: pc.terrain.style, texture: pc.texture,
        launchAngle: (pc.launchSite.angleDeg * Math.PI) / 180,
      };
      planet.terrain = makeTerrain(planet, pc.terrain, pc.launchSite);
      this.planet = planet;
      this.moons = cfg.moons.map((mc, i) => {
        const mu = mc.surfaceGravity * mc.radius * mc.radius;
        const a = mc.orbitRadius;
        const n = (cfg.orbitSense || 1) * Math.sqrt(planet.mu / (a * a * a));
        const m = {
          index: i + 1, id: mc.id, name: mc.name, kind: mc.kind, isPlanet: false,
          radius: mc.radius, surfaceGravity: mc.surfaceGravity, mu,
          soi: a * Math.pow(mu / planet.mu, 0.4), parent: planet, orbitRadius: a,
          meanMotion: n, startAngle: (mc.startAngleDeg * Math.PI) / 180, speed: Math.abs(n) * a,
          period: TAU / Math.abs(n), atmosphere: null, palette: mc.palette, style: mc.terrain.style, texture: mc.texture,
        };
        m.terrain = makeTerrain(m, mc.terrain, null);
        return m;
      });
      this.bodies = [planet].concat(this.moons);
    }

    byId(id) { return this.bodies.find((b) => b.id === id) || null; }

    bodyPos(b, t) {
      if (!b.parent) return [0, 0];
      const ang = b.startAngle + b.meanMotion * t;
      return [b.orbitRadius * Math.cos(ang), b.orbitRadius * Math.sin(ang)];
    }

    bodyVel(b, t) {
      if (!b.parent) return [0, 0];
      const ang = b.startAngle + b.meanMotion * t;
      const s = b.meanMotion * b.orbitRadius;
      return [-s * Math.sin(ang), s * Math.cos(ang)];
    }

    /** Terrain height (m above datum radius) and its derivative dh/dtheta. */
    terrainAt(b, ang) {
      const T = b.terrain;
      let u = (ang / TAU) * T.N;
      u = ((u % T.N) + T.N) % T.N;
      const i0 = Math.floor(u);
      const f = u - i0;
      const i1 = i0 + 1 === T.N ? 0 : i0 + 1;
      const h0 = T.h[i0], h1 = T.h[i1];
      return { h: h0 + (h1 - h0) * f, dh: ((h1 - h0) * T.N) / TAU };
    }

    surfaceRadius(b, ang) { return b.radius + this.terrainAt(b, ang).h; }

    /** Outward surface normal angle at polar angle `ang`, and slope (rad). */
    surfaceFrame(b, ang) {
      const T = this.terrainAt(b, ang);
      const R = b.radius + T.h;
      const slope = Math.atan(T.dh / R);
      return { R, h: T.h, slope, normal: ang - slope };
    }

    density(b, alt) {
      const A = b.atmosphere;
      if (!A || alt >= A.height) return 0;
      const top = Math.exp(-A.height / A.scaleHeight);
      const x = Math.exp(-Math.max(0, alt) / A.scaleHeight);
      return (A.surfaceDensity * (x - top)) / (1 - top);
    }

    pressureRatio(b, alt) {
      const A = b.atmosphere;
      return A ? this.density(b, alt) / A.surfaceDensity : 0;
    }

    gravity(b, r) { return b.mu / (r * r); }
  }

  SB.PlanetSystem = PlanetSystem;
  SB.mulberry32 = mulberry32;
  SB.smoothstep = smoothstep;
})(typeof window !== 'undefined' ? window : globalThis);
