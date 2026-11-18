/*
 * Pocket Orbits — the single editable configuration.
 * Planetary system, part catalogue, presets and tuning all live here.
 * Units: metres, kilograms, seconds, newtons. Angles in degrees unless noted.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});

  SB.CONFIG = {
    g0: 9.80665, // standard gravity, converts Isp (s) to exhaust velocity

    // Orbital sense of the moon system as drawn on the map. -1 = clockwise, which is the
    // direction you travel after pitching toward screen-right ("east") at launch.
    orbitSense: -1,

    planet: {
      id: 'verdis',
      name: 'Verdis',
      kind: 'Home planet',
      radius: 120000,
      surfaceGravity: 4.0,
      atmosphere: {
        height: 15000, // density reaches exactly zero here
        surfaceDensity: 1.0, // kg/m^3
        scaleHeight: 3200,
        skyColor: '#6aaee8',
        horizonColor: '#bfe0ff',
        spaceColor: '#03050c',
      },
      terrain: { style: 'continental', seed: 7, samples: 32768 },
      palette: { surface: '#5b8f47', deep: '#2c4a27', rim: '#a4d27e', detail: '#8b7b4a', glow: 'rgba(120,190,255,0.55)' },
      // Sphere texture (map / distant views): layered 3D noise rendered on the GPU.
      // colours: grassland, forest, desert, rock, shallow sea, deep sea
      texture: { colors: ['#5f8f45', '#2d5a2a', '#b89c64', '#7b6c58', '#2b78b8', '#0a2350'], bump: 2.5, craters: 0, seed: 11 },
      launchSite: { angleDeg: 90, flatHalfWidth: 1200, blend: 2500, elevation: 60 },
    },

    moons: [
      {
        id: 'pock',
        name: 'Pock',
        kind: 'Cratered inner moon',
        radius: 12000,
        surfaceGravity: 0.3,
        orbitRadius: 600000,
        startAngleDeg: 140,
        terrain: { style: 'cratered', seed: 21, samples: 16384 },
        palette: { surface: '#a19e98', deep: '#55534f', rim: '#dcd9d2', detail: '#76736d' },
        // colours: highlands, maria; craters = extra random craters (the equator's craters come from the terrain)
        texture: { colors: ['#dcd8d0', '#46443f'], bump: 3.2, craters: 62, rays: 3, seed: 5 },
      },
      {
        id: 'ferro',
        name: 'Ferro',
        kind: 'Rocky middle moon',
        radius: 22000,
        surfaceGravity: 0.5,
        orbitRadius: 1300000,
        startAngleDeg: 15,
        terrain: { style: 'rocky', seed: 42, samples: 16384 },
        palette: { surface: '#b3613a', deep: '#552615', rim: '#e8996a', detail: '#7c3b20' },
        // colours: rust, basalt, dust
        texture: { colors: ['#b8643a', '#47210f', '#d6a066'], bump: 2.4, craters: 26, seed: 8 },
      },
      {
        id: 'rime',
        name: 'Rime',
        kind: 'Icy outer moon',
        radius: 35000,
        surfaceGravity: 0.7,
        orbitRadius: 2500000,
        startAngleDeg: 255,
        terrain: { style: 'icy', seed: 77, samples: 16384 },
        palette: { surface: '#d3ecf7', deep: '#5f98b8', rim: '#ffffff', detail: '#97c4da' },
        // colours: clean ice, blue ice, crack stains
        texture: { colors: ['#f0f9fd', '#9cc6dd', '#98654c'], bump: 2.0, craters: 14, seed: 3 },
      },
    ],

    // Direction of sunlight in the world frame (x right, y up on the map, z toward the viewer).
    // Mostly in the orbital plane (a crisp terminator on every body); the launch site faces the sun.
    sunDirection: [-0.3, 0.85, 0.43],

    sim: {
      physicsDt: 0.02, // fixed physics step (s), independent of frame rate
      warpLevels: [1, 2, 4, 10, 50, 100, 500, 1000, 5000, 10000, 50000],
      maxPhysicsWarp: 4, // above this, warp is "on rails" (coasting only)
      chuteWarp: 50, // physics warp allowed in the air while the main chutes are fully open
      warpLeadSeconds: 3, // keep the next event at least this many real seconds away
      maxPhysicsStepsPerFrame: 600,
      dragCd: 0.6,
      startThrottle: 1.0,
      predictionSegments: 4,
    },

    control: {
      maxAngularAccel: 1.2, // rad/s^2
      maxAngularRate: 0.7, // rad/s
      throttleRate: 0.8, // full range per second while a throttle key is held
    },

    landing: {
      withLegs: { maxDescent: 6, maxHorizontal: 3, maxTiltDeg: 12 },
      withoutLegs: { maxDescent: 2.5, maxHorizontal: 1.5, maxTiltDeg: 8 },
      maxSlopeDeg: 25, // steeper ground is a crash either way
      underChutes: { maxDescent: 7, maxHorizontal: 3, maxTiltDeg: 15 }, // a pod hanging from open mains
    },

    // Cautions (amber, a chime) and warnings (red, flashing screen edges, beeps) in flight.
    alerts: {
      lowFuel: 0.1, // stage fuel fraction for "Low fuel" while the engines fire
      groundRange: 5000, // landing alerts start below this radar altitude (m)
      // Sink rate: distance needed to brake to a safe touchdown speed at full thrust,
      // as a fraction of the height left. Above these it is a caution / a warning.
      sinkCaution: 0.6,
      sinkWarning: 0.9,
      driftRange: 150, // sideways speed over the touchdown limit is called out below this height (m)
      tiltRange: 40, // tilt over the touchdown limit is called out below this height (m)
      slopeRange: 300, // ground steeper than maxSlopeDeg is called out below this height (m)
    },

    // Part catalogue. Heights/widths in metres. Engines: thrust in N (vacuum), Isp in s.
    parts: {
      pod_lark: {
        category: 'command', name: 'Lark Command Pod', mass: 600, height: 1.4, width: 1.25,
        description: 'One-seat capsule with reaction wheels. Every flight needs one.',
      },
      chute: {
        category: 'command', role: 'chute', name: 'Triad Parachute Pack', mass: 120, height: 0.4, width: 0.56,
        // Space arms it. Two drogues open once the speed and height are safe, then three mains lower
        // down (the drogues are cut away). cdA is the total drag area (m^2) when fully open.
        drogue: { count: 2, cdA: 5, maxSpeed: 250, maxRadar: 8000, openTime: 1.0, size: 2.0, riser: 9 },
        main: { count: 3, cdA: 280, maxSpeed: 90, maxRadar: 2500, openTime: 3.0, stagger: 0.45, size: 8.5, riser: 15 },
        description: 'Sits on top of the pod. Space arms it; two drogues, then three mains open by themselves when it is safe. Needs air: Verdis only.',
      },
      tank_s: {
        category: 'tank', name: 'FT-100 Fuel Tank', dryMass: 60, fuel: 540, height: 1.0, width: 1.25,
        description: 'Short propellant tank.',
      },
      tank_m: {
        category: 'tank', name: 'FT-200 Fuel Tank', dryMass: 120, fuel: 1080, height: 1.9, width: 1.25,
        description: 'Medium propellant tank.',
      },
      tank_l: {
        category: 'tank', name: 'FT-400 Fuel Tank', dryMass: 240, fuel: 2160, height: 3.6, width: 1.25,
        description: 'Long propellant tank.',
      },
      eng_wren: {
        category: 'engine', name: 'Wren Lander Engine', mass: 60, thrust: 4000, ispVac: 315, ispAsl: 150,
        height: 0.55, width: 0.8, bell: 0.55,
        sound: { size: 0.15, crackle: 0.0, whine: 0.8 },
        description: 'Tiny, efficient. For landers in low gravity.',
      },
      eng_sparrow: {
        category: 'engine', name: 'Sparrow Vacuum Engine', mass: 120, thrust: 10000, ispVac: 320, ispAsl: 200,
        height: 0.95, width: 1.0, bell: 0.85,
        sound: { size: 0.42, crackle: 0.15, whine: 1.0 },
        description: 'Upper-stage engine. Efficient in vacuum.',
      },
      eng_hammer: {
        category: 'engine', name: 'Hammer Lifter Engine', mass: 300, thrust: 25000, ispVac: 285, ispAsl: 255,
        height: 1.3, width: 1.25, bell: 1.1,
        sound: { size: 0.75, crackle: 0.7, whine: 0.2 },
        description: 'Booster engine with good sea-level thrust.',
      },
      eng_anvil: {
        category: 'engine', name: 'Anvil Heavy Engine', mass: 650, thrust: 60000, ispVac: 280, ispAsl: 250,
        height: 1.7, width: 1.25, bell: 1.25,
        sound: { size: 1.0, crackle: 1.0, whine: 0.1 },
        description: 'Brute-force first stage engine.',
      },
      decoupler: {
        category: 'structural', role: 'decoupler', name: 'Stack Decoupler', mass: 40, height: 0.3, width: 1.25,
        description: 'Separates the stack. Everything on the side away from the pod is jettisoned with it.',
      },
      legs: {
        category: 'structural', role: 'legs', name: 'Landing Leg Ring', mass: 50, height: 0.4, width: 1.25,
        footSpread: 1.0, footDrop: 0.35,
        deployTime: 1.2, // seconds for the legs to swing down (cosmetic)
        description: 'Legs reach below the bottom of their own stage. Needed for safe landings. They stay folded until their stage fires.',
      },
    },

    // Ready-made designs (top of stack first). Staging is generated automatically.
    presets: [
      {
        name: 'Kestrel (starter two-stage)',
        parts: ['pod_lark', 'tank_s', 'legs', 'eng_sparrow', 'decoupler', 'tank_m', 'eng_hammer'],
      },
      {
        name: 'Heron (three-stage, outer moons)',
        parts: ['pod_lark', 'tank_s', 'legs', 'eng_sparrow', 'decoupler', 'tank_m', 'eng_sparrow',
          'decoupler', 'tank_l', 'tank_m', 'eng_anvil'],
      },
      {
        name: 'Kestrel Return (with parachutes)',
        parts: ['chute', 'pod_lark', 'tank_s', 'legs', 'eng_sparrow', 'decoupler', 'tank_m', 'eng_hammer'],
      },
    ],

    // Synthesised sound (Web Audio). Engine parts carry their own `sound` profile:
    // size 0..1 (deeper and louder), crackle 0..1 (pops in air), whine 0..1 (turbopump tone).
    audio: {
      masterVolume: 0.8,
      mapViewLevel: 0.55, // engines are quieter while looking at the map
      vacuumLevel: 0.4, // in vacuum only the muffled structure-borne rumble remains
      alertLevel: 0.4, // caution chime and warning beeps
    },

    // Paint. Every part has a main colour, an accent colour and (pods and tanks) a pattern.
    paint: {
      palette: [
        ['White', '#f2f0ea'], ['Silver', '#c9ced6'], ['Steel', '#8b939e'], ['Graphite', '#3a3f47'], ['Black', '#16181c'],
        ['Orange', '#e8772e'], ['Red', '#c8352b'], ['Yellow', '#f1c232'], ['Gold', '#c9a227'], ['Copper', '#b87333'],
        ['Olive', '#6b7b3a'], ['Green', '#2f8f5b'], ['Teal', '#2a9d9b'], ['Sky', '#4fa3e0'], ['Navy', '#24406e'],
        ['Purple', '#6b4fa0'], ['Pink', '#d9668f'],
      ],
      // per part role: default colours, the pattern choices (first = default) and slot names
      roles: {
        pod: { base: '#cfd4dc', accent: '#6a4a32', patterns: ['plain', 'stripe', 'split', 'checker'], labels: ['Hull', 'Trim'] },
        tank: { base: '#e8e4da', accent: '#cf6f2c', patterns: ['bands', 'plain', 'rings', 'checker', 'split', 'stripe'], labels: ['Body', 'Accent'] },
        engine: { base: '#6f7680', accent: '#4c525b', patterns: [], labels: ['Housing', 'Nozzle'] },
        decoupler: { base: '#f1c232', accent: '#23272e', patterns: [], labels: ['Stripes', 'Base'] },
        legs: { base: '#5e6670', accent: '#aab2bd', patterns: [], labels: ['Ring', 'Legs'] },
        chute: { base: '#f2f0ea', accent: '#e8772e', patterns: [], labels: ['Canopy', 'Gores'] },
      },
      // whole-rocket colour schemes (any role left out keeps its defaults)
      liveries: [
        { name: 'Classic', roles: {} },
        { name: 'Midnight', roles: {
          pod: { base: '#2a2e35', accent: '#c9a227', pattern: 'stripe' }, tank: { base: '#16181c', accent: '#c9a227', pattern: 'bands' },
          engine: { base: '#3a3f47', accent: '#23272e' }, decoupler: { base: '#c9a227', accent: '#16181c' }, legs: { base: '#3a3f47', accent: '#c9a227' }, chute: { base: '#16181c', accent: '#c9a227' } } },
        { name: 'Retro', roles: {
          pod: { base: '#f2f0ea', accent: '#16181c', pattern: 'split' }, tank: { base: '#f2f0ea', accent: '#16181c', pattern: 'checker' },
          engine: { base: '#3a3f47', accent: '#23272e' }, decoupler: { base: '#f2f0ea', accent: '#16181c' }, legs: { base: '#16181c', accent: '#c9ced6' }, chute: { base: '#f2f0ea', accent: '#16181c' } } },
        { name: 'Arctic', roles: {
          pod: { base: '#f2f0ea', accent: '#4fa3e0', pattern: 'plain' }, tank: { base: '#f2f0ea', accent: '#4fa3e0', pattern: 'rings' },
          engine: { base: '#c9ced6', accent: '#8b939e' }, decoupler: { base: '#4fa3e0', accent: '#f2f0ea' }, legs: { base: '#c9ced6', accent: '#4fa3e0' }, chute: { base: '#f2f0ea', accent: '#4fa3e0' } } },
        { name: 'Racer', roles: {
          pod: { base: '#c8352b', accent: '#f2f0ea', pattern: 'stripe' }, tank: { base: '#c8352b', accent: '#f2f0ea', pattern: 'stripe' },
          engine: { base: '#16181c', accent: '#3a3f47' }, decoupler: { base: '#f2f0ea', accent: '#c8352b' }, legs: { base: '#16181c', accent: '#f2f0ea' }, chute: { base: '#f2f0ea', accent: '#c8352b' } } },
        { name: 'Copper', roles: {
          pod: { base: '#b87333', accent: '#24406e', pattern: 'plain' }, tank: { base: '#b87333', accent: '#24406e', pattern: 'rings' },
          engine: { base: '#8b939e', accent: '#b87333' }, decoupler: { base: '#24406e', accent: '#b87333' }, legs: { base: '#24406e', accent: '#b87333' }, chute: { base: '#b87333', accent: '#24406e' } } },
      ],
    },

    storageKeys: {
      designs: 'pocketOrbits.designs.v1',
      current: 'pocketOrbits.current.v1',
      audio: 'pocketOrbits.audio.v1',
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
