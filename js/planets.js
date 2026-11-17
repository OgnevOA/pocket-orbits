/*
 * Sphere textures for planets and moons, rendered per pixel on the GPU (WebGL2).
 *
 * The map looks down on the orbital plane, so every body is seen from above its north pole:
 * the disc centre is the pole and the rim is the equator, which is exactly the terrain outline
 * used by the flight physics. Each pixel is mapped onto the unit sphere and coloured from
 * layered 3D gradient (Perlin) noise sampled at that point, so there are no seams or pinched
 * poles. Crater and ridge height fields bump the surface normal, and a fixed sun lights it.
 *
 * If WebGL2 is unavailable, SB.Planets.draw() returns false and the caller keeps its 2D drawing.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const MAX_CRATERS = 128;
  const MAX_RAYS = 4;
  const CLOUD_RATE = 0.00029; // rad per second of game time (clouds drift about once per 6 hours)

  const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uOrigin;      // CSS px of the target's top-left corner
uniform float uPx;         // CSS px per target pixel
uniform float uTH;         // target height in pixels
uniform vec2 uCenter;      // disc centre (CSS px)
uniform float uRadius;     // sphere radius (CSS px)
uniform float uRadiusPx;   // sphere radius in target pixels (edge anti-aliasing)
uniform float uRot;        // world -> screen rotation
uniform vec3 uLight;       // sun direction, body/world frame
uniform float uCloudAng;   // cloud layer rotation
uniform int uStyle;        // 0 planet, 1 cratered, 2 rocky, 3 icy
uniform vec3 uSeed;
uniform int uOct;          // upper limit for noise octaves
uniform vec3 uCol[6];
uniform int uN;
uniform vec4 uCr[${MAX_CRATERS}]; // crater centre (unit vector) + angular radius
uniform int uNRay;
uniform vec4 uRay[${MAX_RAYS}];   // young craters with bright ejecta rays
uniform float uBump;

// PCG integer hash on the integer lattice: exact at any zoom level (no float-precision streaks).
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// Hash bits -> floats in [0, 1) by building the float directly from 23 mantissa bits.
// No numeric uint->float conversion: some GPU drivers get those wrong (seen on ANGLE/Vulkan).
vec3 u2f(uvec3 h) { return uintBitsToFloat((h >> 9u) | 0x3f800000u) - 1.0; }
vec3 grad(vec3 i) { return u2f(pcg3d(uvec3(ivec3(i)))) * 2.0 - 1.0; }

// 3D gradient (Perlin) noise with quintic fade, roughly in [-0.7, 0.7].
float gnoise(vec3 p) {
  vec3 i = floor(p), f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i), f);
  float b = dot(grad(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float c = dot(grad(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float d = dot(grad(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float e = dot(grad(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float g = dot(grad(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float h = dot(grad(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float k = dot(grad(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

// Octaves for a noise layer of base frequency 'base' (cycles per radius): stop once the
// wavelength drops below ~3 px, otherwise sub-pixel detail aliases into moiré in the bump normals.
int octFor(float base) { return int(clamp(floor(log2(uRadiusPx / (3.0 * base))) + 1.0, 1.0, float(uOct))); }

// a fixed rotation between octaves hides the lattice
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Layered noise: each octave doubles the frequency and halves the amplitude.
float fbm(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = ROT * p * 2.03 + vec3(1.7, -2.3, 0.9);
    a *= 0.5;
  }
  return s;
}

// Ridged multifractal: sharp crests from folded noise, each octave weighted by the last.
float ridged(vec3 p, int oct) {
  float s = 0.0, a = 0.5, w = 1.0;
  for (int i = 0; i < 12; i++) {
    if (i >= oct) break;
    float n = clamp(1.0 - abs(gnoise(p)) * 1.6, 0.0, 1.0);
    n *= n * w;
    w = clamp(n * 1.8, 0.0, 1.0);
    s += a * n;
    p = ROT * p * 2.07 + vec3(-1.3, 2.1, 0.7);
    a *= 0.5;
  }
  return s;
}

// Bowl-shaped craters with raised rims, central peaks in big ones and a brighter ejecta blanket.
void craterField(vec3 p, inout float h, inout float alb, float depthK) {
  for (int i = 0; i < ${MAX_CRATERS}; i++) {
    if (i >= uN) break;
    vec4 c = uCr[i];
    float r = length(p - c.xyz) / c.w;
    if (r > 2.4) continue;
    float bowl = r < 1.0 ? (r * r - 1.0) : 0.0;
    float rim = 0.32 * exp(-(r - 1.0) * (r - 1.0) / 0.05);
    float peak = c.w > 0.06 ? 0.3 * exp(-r * r * 30.0) : 0.0;
    float dep = c.w * 0.2 * depthK;
    h += dep * (bowl + rim + peak);
    alb += (r < 1.0 ? -0.05 : 0.0) + 0.07 * exp(-(r - 1.0) * (r - 1.0) / 0.03)
         + (r > 1.0 ? 0.05 * exp(-(r - 1.0) * 2.0) : 0.0);
  }
}

vec3 rand3(vec3 cell, uint salt) { return u2f(pcg3d(uvec3(ivec3(cell)) + uvec3(salt, salt * 3u, salt * 7u))); }

// Cellular crater layer: at most one crater per 3D grid cell ('scale' cells per radius).
// Fades in once the cells are big enough on screen, so zooming in reveals ever smaller craters.
float smallCraters(vec3 p, float scale, float density, inout float alb) {
  float fade = smoothstep(30.0, 60.0, uRadiusPx / scale);   // craters only once they span several pixels
  if (fade <= 0.0) return 0.0;
  vec3 x = p * scale, cell = floor(x), f = x - cell;
  vec3 o = step(0.5, f) - 1.0;
  float h = 0.0;
  for (int i = 0; i < 8; i++) {
    vec3 c = cell + o + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    vec3 r = rand3(c, uint(scale));
    if (r.x > density) continue;
    vec3 ctr = c + 0.2 + 0.6 * fract(r * 3.17 + r.yzx);
    float rad = 0.1 + 0.2 * r.y;           // reach 2*rad stays inside the 2x2x2 block
    float d = length(x - ctr) / rad;
    if (d > 2.0) continue;
    float bowl = d < 1.0 ? (d * d - 1.0) : 0.0;
    float rim = 0.3 * exp(-(d - 1.0) * (d - 1.0) / 0.05);
    h += fade * rad * 0.16 * (bowl + rim) / scale;
    alb += fade * ((d < 1.0 ? -0.04 : 0.0) + 0.05 * exp(-(d - 1.0) * (d - 1.0) / 0.03));
  }
  return h;
}

float smallCraterField(vec3 p, float density, inout float alb) {
  return smallCraters(p, 7.0, density, alb) + smallCraters(p, 20.0, density, alb) + smallCraters(p, 60.0, density, alb) + smallCraters(p, 180.0, density, alb);
}

float rays(vec3 p) {
  float s = 0.0;
  for (int i = 0; i < ${MAX_RAYS}; i++) {
    if (i >= uNRay) break;
    vec4 c = uRay[i];
    vec3 v = p - c.xyz;
    float r = length(v) / c.w;
    if (r < 0.9 || r > 10.0) continue;
    vec3 e1 = normalize(cross(c.xyz, abs(c.z) < 0.9 ? vec3(0, 0, 1) : vec3(1, 0, 0)));
    vec3 e2 = cross(c.xyz, e1);
    float ang = atan(dot(v, e2), dot(v, e1));
    float n = fbm(vec3(cos(ang), sin(ang), float(i) * 3.7) * 5.0, 3);
    s += smoothstep(0.05, 0.3, n) * exp(-(r - 1.0) / 2.5) * 0.35;
  }
  return s;
}

// Long, sparse cracks for the icy moon: thin bands around zero crossings of smooth noise.
float cracks(vec3 q) {
  float l1 = abs(fbm(q * 1.3 + 7.0, 3));
  float l2 = abs(fbm(q * 3.1 - 4.0, 2));
  float c1 = 1.0 - smoothstep(0.0, 0.0055 + fwidth(l1), l1);
  float c2 = (1.0 - smoothstep(0.0, 0.004 + fwidth(l2), l2)) * 0.55;
  return max(c1, c2);
}

// --- per-style surfaces: height (in units of the radius) and albedo -----------------------
float continent(vec3 q) { return fbm(q * 1.6, octFor(1.6)) + 0.26 * (1.0 - abs(normalize(q - uSeed).z)) - 0.07; }

float heightAt(vec3 p) {
  vec3 q = p + uSeed;
  if (uStyle == 0) {
    float cont = continent(q);
    float land = smoothstep(-0.006, 0.006, cont);
    float mount = ridged(q * 4.0 + 3.0, octFor(4.0));
    float elev = max(cont, 0.0);
    float hi = smoothstep(0.16, 0.4, elev + mount * 0.12);
    return land * (elev * 0.03 + mount * 0.012 * hi + 0.002 * fbm(q * 14.0, octFor(14.0)));
  }
  if (uStyle == 1) {
    float h = fbm(q * 6.0, octFor(6.0)) * 0.003, a = 0.0;
    craterField(p, h, a, 1.0);
    return h + smallCraterField(p, 0.75, a);
  }
  if (uStyle == 2) {
    float r = ridged(q * 1.7, octFor(1.7));
    float t = r * 6.0, fl = floor(t);
    float terr = (fl + smoothstep(0.3, 0.7, t - fl)) / 6.0;
    float h = terr * 0.03 + fbm(q * 9.0, octFor(9.0)) * 0.002, a = 0.0;
    craterField(p, h, a, 0.6);
    return h + 0.6 * smallCraterField(p, 0.3, a);
  }
  float big = fbm(q * 1.8, 5);
  float crack = cracks(q);
  float h = 0.004 * big - 0.003 * crack + 0.0015 * fbm(q * 20.0, octFor(20.0)), a = 0.0;
  craterField(p, h, a, 0.5);
  return h + 0.5 * smallCraterField(p, 0.12, a);
}

void main() {
  vec2 css = vec2(uOrigin.x + gl_FragCoord.x * uPx, uOrigin.y + (uTH - gl_FragCoord.y) * uPx);
  vec2 d = (css - uCenter) / uRadius;
  d.y = -d.y;
  float rr = dot(d, d);
  float alpha = 1.0 - smoothstep(1.0 - 1.5 / uRadiusPx, 1.0, sqrt(rr));
  if (alpha <= 0.0) { outColor = vec4(0.0); return; }
  float cr = cos(-uRot), sr = sin(-uRot);
  vec2 b = vec2(d.x * cr - d.y * sr, d.x * sr + d.y * cr);
  float z = sqrt(max(0.0, 1.0 - rr));
  vec3 p = normalize(vec3(b, max(z, 0.002)));   // point on the sphere; z = north pole = viewer
  vec3 q = p + uSeed;

  vec3 col = vec3(0.5); // albedo
  float spec = 0.0;
  float cloud = 0.0;
  if (uStyle == 0) {
    float cont = continent(q);
    float land = smoothstep(-0.006, 0.006, cont);
    float moist = fbm(q * 3.3 + 11.0, 5);
    float mount = ridged(q * 4.0 + 3.0, octFor(4.0));
    float elev = max(cont, 0.0);
    vec3 lc = mix(uCol[0], uCol[1], smoothstep(-0.02, 0.22, moist));
    lc = mix(lc, uCol[2], (1.0 - smoothstep(-0.28, -0.1, moist)) * (1.0 - smoothstep(0.2, 0.75, abs(p.z))));
    float hi = smoothstep(0.16, 0.4, elev + mount * 0.12);
    lc = mix(lc, uCol[3], hi);
    lc = mix(lc, vec3(0.94, 0.95, 0.97), smoothstep(0.42, 0.56, elev + mount * 0.15));
    vec3 oc = mix(uCol[5], uCol[4], smoothstep(-0.22, 0.0, cont));
    float ice = smoothstep(0.965, 0.985, abs(p.z) + 0.03 * fbm(q * 7.0, 4));
    col = mix(mix(oc, lc, land), vec3(0.93, 0.96, 0.99), ice);
    spec = (1.0 - land) * (1.0 - ice) * 0.55;
    // clouds: domain-warped noise on a layer that drifts around the pole
    float ca = uCloudAng;
    vec3 cq = vec3(p.x * cos(ca) - p.y * sin(ca), p.x * sin(ca) + p.y * cos(ca), p.z) + uSeed * 0.7;
    vec3 w = vec3(fbm(cq * 1.7 + 4.0, 4), fbm(cq * 1.7 + 9.0, 4), fbm(cq * 1.7 + 2.0, 4));
    float cn = fbm(cq * 2.8 + w * 1.6, octFor(2.8));
    cloud = smoothstep(-0.02, 0.26, cn) * 0.85;
  } else if (uStyle == 1) {
    // grey regolith, dark basalt maria, dense craters, a few young rayed craters
    float reg = fbm(q * 6.0, octFor(6.0));
    float mare = smoothstep(-0.02, 0.1, fbm(q * 1.3 + 5.0, 5));
    float a = mix(0.74, 0.3, mare) + reg * 0.22, hh = 0.0;
    craterField(p, hh, a, 1.0);
    hh += smallCraterField(p, 0.75, a);
    a += rays(p);
    col = mix(uCol[1], uCol[0], clamp(a, 0.0, 1.15));
  } else if (uStyle == 2) {
    // rust-red ridges cut into terraces (matching the stepped mesas), dust in the lowlands
    float r = ridged(q * 1.7, octFor(1.7));
    float t = r * 6.0, fl = floor(t);
    float terr = (fl + smoothstep(0.3, 0.7, t - fl)) / 6.0;
    float a = 0.0, hh = 0.0;
    craterField(p, hh, a, 0.6);
    hh += smallCraterField(p, 0.3, a);
    float dust = smoothstep(0.0, 0.3, fbm(q * 2.4 + 3.0, 6));
    vec3 base = mix(uCol[0], uCol[1], smoothstep(0.55, 0.95, r));
    base = mix(base, uCol[2], dust * (1.0 - smoothstep(0.2, 0.6, terr)) * 0.75);
    base *= 1.0 + 0.1 * sin(terr * 40.0 + fbm(q * 6.0, 3) * 3.0);
    col = base * (1.0 + a);
  } else {
    // bright ice crossed by long stained cracks (lineae), smooth with a sheen, few craters
    float big = fbm(q * 1.8, 5);
    vec3 ice = mix(uCol[0], uCol[1], smoothstep(-0.1, 0.3, big));
    float crack = cracks(q);
    col = mix(ice, uCol[2], crack * 0.8);
    float a = 0.0, hh = 0.0;
    craterField(p, hh, a, 0.5);
    hh += smallCraterField(p, 0.12, a);
    col *= 1.0 + a * 0.6;
    spec = 0.35 * (1.0 - crack);
  }

  // bump-mapped normal: finite differences of the displaced surface along the tangent plane
  vec3 t1 = normalize(cross(p, abs(p.z) < 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(p, t1);
  float e = max(0.6 / uRadiusPx, 2e-5);
  vec3 pa = normalize(p + t1 * e), pb = normalize(p + t2 * e);
  vec3 S0 = p * (1.0 + uBump * heightAt(p));
  vec3 Sa = pa * (1.0 + uBump * heightAt(pa));
  vec3 Sb = pb * (1.0 + uBump * heightAt(pb));
  vec3 N = normalize(cross(Sa - S0, Sb - S0));
  if (dot(N, p) < 0.0) N = -N;

  float term = smoothstep(-0.05, 0.2, dot(p, uLight));   // soft day/night terminator
  float diff = max(dot(N, uLight), 0.0) * term;
  vec3 H = normalize(uLight + vec3(0.0, 0.0, 1.0));
  float sp = pow(max(dot(N, H), 0.0), 48.0) * spec * term;
  vec3 c = col * (0.17 + diff) + vec3(sp);   // night sides keep some planetshine
  if (cloud > 0.0) {
    float cd = max(dot(p, uLight), 0.0) * term;
    c = mix(c, vec3(0.97) * (0.04 + cd), cloud);
  }
  if (uStyle == 0) {   // atmospheric haze thickening toward the limb
    float limb = pow(1.0 - z, 3.0);
    c = mix(c, vec3(0.45, 0.68, 1.0) * (0.12 + 0.88 * max(dot(p, uLight) + 0.25, 0.0)), limb * 0.6);
  }
  outColor = vec4(c * alpha, alpha);
}`;

  const STYLE = { continental: 0, cratered: 1, rocky: 2, icy: 3 };

  function hexRgb(h) {
    const n = parseInt(h.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  const P = {
    ok: false,
    tried: false,
    error: null,
    renders: 0,
    cache: new Map(),
    regionCache: new Map(),
    budget: 2.5e6, // max pixels for a large region render; adapts to the frame rate
    regionRendered: false,
    params: new Map(),

    init() {
      if (this.tried) return this.ok;
      this.tried = true;
      try {
        if (typeof document === 'undefined') return false;
        const cv = document.createElement('canvas');
        cv.width = 64; cv.height = 64;
        const gl = cv.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true });
        if (!gl) { this.error = 'WebGL2 unavailable'; return false; }
        const sh = (type, src) => {
          const s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
          return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const U = {};
        for (const n of ['uOrigin', 'uPx', 'uTH', 'uCenter', 'uRadius', 'uRadiusPx', 'uRot', 'uLight', 'uCloudAng', 'uStyle', 'uSeed', 'uOct', 'uCol', 'uN', 'uCr', 'uNRay', 'uRay', 'uBump']) {
          U[n] = gl.getUniformLocation(prog, n);
        }
        this.gl = gl;
        this.canvas = cv;
        this.U = U;
        const s = SB.CONFIG.sunDirection || [-0.55, 0.42, 0.72];
        const l = Math.hypot(s[0], s[1], s[2]);
        this.light = [s[0] / l, s[1] / l, s[2] / l];
        this.ok = true;
      } catch (e) {
        this.error = String(e && e.message ? e.message : e);
        this.ok = false;
        if (typeof console !== 'undefined') console.warn('Planet shader disabled:', this.error);
      }
      return this.ok;
    },

    /** Uniform data per body: palette, seed, craters (equatorial ones from the terrain + random). */
    bodyParams(body) {
      let p = this.params.get(body.id);
      if (p) return p;
      const tex = body.texture || {};
      const rand = SB.mulberry32(1000 + (tex.seed || 1) * 7919);
      const craters = [];
      for (const c of body.terrain.craters || []) craters.push([Math.cos(c.ang), Math.sin(c.ang), 0, Math.max(0.004, c.w)]);
      const extra = tex.craters || 0;
      for (let i = 0; i < extra && craters.length < MAX_CRATERS; i++) {
        const zc = rand() * 2 - 1, phi = rand() * Math.PI * 2, s = Math.sqrt(1 - zc * zc);
        const w = 0.012 * Math.pow(0.24 / 0.012, Math.pow(rand(), 2.4));
        craters.push([s * Math.cos(phi), s * Math.sin(phi), zc, w]);
      }
      craters.length = Math.min(craters.length, MAX_CRATERS);
      const cr = new Float32Array(MAX_CRATERS * 4);
      craters.forEach((c, i) => cr.set(c, i * 4));
      const ray = new Float32Array(MAX_RAYS * 4);
      const nRay = Math.min(MAX_RAYS, tex.rays || 0);
      const mid = craters.filter((c) => c[3] > 0.025 && c[3] < 0.08);
      for (let i = 0; i < nRay && i < mid.length; i++) ray.set(mid[Math.floor(rand() * mid.length)], i * 4);
      const colors = (tex.colors || ['#888888']).slice(0, 6);
      while (colors.length < 6) colors.push(colors[colors.length - 1]);
      const col = new Float32Array(18);
      colors.forEach((c, i) => col.set(hexRgb(c), i * 3));
      p = {
        style: STYLE[body.style] !== undefined ? STYLE[body.style] : 1,
        seed: [rand() * 8, rand() * 8, rand() * 8],
        col, cr, n: craters.length, ray, nRay: Math.min(nRay, mid.length), bump: tex.bump || 2,
      };
      this.params.set(body.id, p);
      return p;
    },

    /** Sunlight on the equator of any body at polar angle `ang` (world frame), for side-on views. */
    sunAt(ang) {
      const s = SB.CONFIG.sunDirection || [-0.3, 0.85, 0.43];
      const l = Math.hypot(s[0], s[1], s[2]);
      const ndl = (Math.cos(ang) * s[0] + Math.sin(ang) * s[1]) / l;
      const t = Math.min(1, Math.max(0, (ndl + 0.05) / 0.25));
      const term = t * t * (3 - 2 * t);
      return { ndl, light: 0.17 + Math.max(0, ndl) * term, day: Math.min(1, Math.max(0, (ndl + 0.15) / 0.4)) };
    },

    /** Called once per frame with the frame time: shrinks the region-render budget when frames run slow. */
    noteFrame(ms) {
      if (!this.regionRendered) return;
      this.regionRendered = false;
      this.avgMs = this.avgMs ? this.avgMs * 0.85 + ms * 0.15 : ms;
      if (this.avgMs > 24 && this.budget > 3e5) this.budget *= 0.85;
      else if (this.avgMs < 13 && this.budget < 4.5e6) this.budget = Math.min(4.5e6, this.budget * 1.05);
    },

    /**
     * Craters that can touch the visible patch of the sphere (centre cx, cy and half-diagonal hd,
     * all CSS px), so zoomed-in views loop over a handful of craters instead of all of them.
     */
    visibleCraters(body, cx, cy, hd, sx, sy, Rs, rot) {
      const p = this.bodyParams(body);
      let dx = (cx - sx) / Rs, dy = -(cy - sy) / Rs;
      const r2 = dx * dx + dy * dy;
      let dz;
      if (r2 >= 1) { const l = Math.sqrt(r2); dx /= l; dy /= l; dz = 0; } else dz = Math.sqrt(1 - r2);
      const c = Math.cos(-rot), s = Math.sin(-rot);
      const v = [dx * c - dy * s, dx * s + dy * c, dz];
      const cap = Math.min(Math.PI, 2 * Math.asin(Math.min(1, hd / Rs)) + 0.05);
      const cr = new Float32Array(p.cr.length);
      let n = 0;
      for (let i = 0; i < p.n; i++) {
        const x = p.cr[i * 4], y = p.cr[i * 4 + 1], z = p.cr[i * 4 + 2], w = p.cr[i * 4 + 3];
        const ang = Math.acos(Math.max(-1, Math.min(1, x * v[0] + y * v[1] + z * v[2])));
        if (ang < cap + 2.5 * w) { cr.set([x, y, z, w], n * 4); n++; }
      }
      return { cr, n };
    },

    /** Renders into the GL canvas' lower-left tw×th pixels. */
    render(body, o) {
      const gl = this.gl, U = this.U, cv = this.canvas;
      if (cv.width < o.tw || cv.height < o.th) {
        cv.width = Math.max(cv.width, o.tw);
        cv.height = Math.max(cv.height, o.th);
      }
      const p = this.bodyParams(body);
      gl.viewport(0, 0, o.tw, o.th);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, o.tw, o.th);
      gl.uniform2f(U.uOrigin, o.origin[0], o.origin[1]);
      gl.uniform1f(U.uPx, o.px);
      gl.uniform1f(U.uTH, o.th);
      gl.uniform2f(U.uCenter, o.center[0], o.center[1]);
      gl.uniform1f(U.uRadius, o.radius);
      gl.uniform1f(U.uRadiusPx, o.radius / o.px);
      gl.uniform1f(U.uRot, o.rot);
      gl.uniform3fv(U.uLight, this.light);
      gl.uniform1f(U.uCloudAng, (o.t || 0) * CLOUD_RATE);
      gl.uniform1i(U.uStyle, p.style);
      gl.uniform3fv(U.uSeed, p.seed);
      gl.uniform1i(U.uOct, 10);
      gl.uniform3fv(U.uCol, p.col);
      gl.uniform1i(U.uN, o.craters ? o.craters.n : p.n);
      gl.uniform4fv(U.uCr, o.craters ? o.craters.cr : p.cr);
      gl.uniform1i(U.uNRay, p.nRay);
      gl.uniform4fv(U.uRay, p.ray);
      gl.uniform1f(U.uBump, p.bump);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.renders++;
    },

    /**
     * Draws the textured sphere of radius Rs (CSS px) centred at (sx, sy) into ctx.
     * Small discs are rendered whole and cached (re-rendered only when size, rotation or the
     * clouds change); discs bigger than ~900 device px render just their visible part.
     */
    draw(ctx, body, sx, sy, Rs, rot, t, W, H) {
      if (!this.init()) return false;
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const RsPx = Rs * dpr;
      if (RsPx < 1.5) return false;
      if (RsPx <= 900) {
        const S = Math.ceil(RsPx * 2) + 2;
        const cloudKey = body.isPlanet ? Math.round(((t || 0) * CLOUD_RATE * RsPx) / 0.5) : 0;
        const key = `${Math.round(Math.log(RsPx) / Math.log(1.012))}|${Math.round(rot / 0.002)}|${cloudKey}`;
        let c = this.cache.get(body.id);
        if (!c || c.key !== key) {
          this.render(body, { tw: S, th: S, origin: [0, 0], px: 1, center: [S / 2, S / 2], radius: RsPx, rot, t });
          if (!c) { c = { canvas: document.createElement('canvas') }; this.cache.set(body.id, c); }
          if (c.canvas.width !== S) { c.canvas.width = S; c.canvas.height = S; }
          const cx = c.canvas.getContext('2d');
          cx.clearRect(0, 0, S, S);
          cx.drawImage(this.canvas, 0, this.canvas.height - S, S, S, 0, 0, S, S);
          c.key = key; c.S = S; c.R = RsPx;
        }
        const size = (c.S * (RsPx / c.R)) / dpr;
        ctx.drawImage(c.canvas, sx - size / 2, sy - size / 2, size, size);
        return true;
      }
      const x0 = Math.max(0, Math.floor(sx - Rs)), y0 = Math.max(0, Math.floor(sy - Rs));
      const x1 = Math.min(W, Math.ceil(sx + Rs)), y1 = Math.min(H, Math.ceil(sy + Rs));
      if (x1 <= x0 || y1 <= y0) return true;
      const pix = (x1 - x0) * (y1 - y0) * dpr * dpr;
      const k = pix > this.budget ? Math.sqrt(this.budget / pix) : 1;
      const tw = Math.ceil((x1 - x0) * dpr * k), th = Math.ceil((y1 - y0) * dpr * k);
      // Re-render only when the view changed (a map focused on this body is usually still).
      const cloudKey = body.isPlanet ? Math.round(((t || 0) * CLOUD_RATE * RsPx) / 0.5) : 0;
      const key = [x0, y0, x1, y1, tw, th, Math.round(sx * 4), Math.round(sy * 4), Math.round(Rs * 64), Math.round(rot / 2e-5), cloudKey].join('|');
      let c = this.regionCache.get(body.id);
      if (!c || c.key !== key) {
        this.regionRendered = true;
        this.render(body, { tw, th, origin: [x0, y0], px: 1 / (dpr * k), center: [sx, sy], radius: Rs, rot, t, craters: this.visibleCraters(body, (x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(x1 - x0, y1 - y0) / 2, sx, sy, Rs, rot) });
        if (!c) { c = { canvas: document.createElement('canvas') }; this.regionCache.set(body.id, c); }
        if (c.canvas.width !== tw || c.canvas.height !== th) { c.canvas.width = tw; c.canvas.height = th; }
        const cx = c.canvas.getContext('2d');
        cx.clearRect(0, 0, tw, th);
        cx.drawImage(this.canvas, 0, this.canvas.height - th, tw, th, 0, 0, tw, th);
        c.key = key;
      }
      ctx.drawImage(c.canvas, 0, 0, tw, th, x0, y0, x1 - x0, y1 - y0);
      return true;
    },
  };

  SB.Planets = P;
})(typeof window !== 'undefined' ? window : globalThis);
