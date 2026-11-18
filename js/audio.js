/*
 * Sound, synthesised with the Web Audio API (no audio files).
 *
 * Engines: one voice for the craft mixes
 *   - rumble   brown noise through a low-pass (deeper for big engines)
 *   - roar     pink noise through a band-pass (the exhaust)
 *   - hiss     white noise through a high-pass (small engines, in air)
 *   - throb    two detuned low sawtooths (combustion pulsing)
 *   - whine    a turbopump tone that rises with throttle (heard best in vacuum)
 *   - crackle  sparse pops modulating the level (big engines in air)
 * driven every frame by throttle, the firing engines' sound profiles (config) and air pressure.
 * In vacuum an "air" low-pass muffles everything to a structure-borne rumble.
 * One-shots: ignition thump + whoosh, and a sputter when the fuel runs out.
 *
 * EngineVoice works on any BaseAudioContext, so tests can render it offline and analyse it.
 */
(function (root) {
  'use strict';
  const SB = (root.SB = root.SB || {});
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Looping noise buffers (crossfaded ends, so the loop point is inaudible). */
  function makeBuffers(ctx) {
    const sr = ctx.sampleRate;
    const fade = 4096;
    const loop = (seconds, seed, gen) => {
      const n = Math.floor(sr * seconds);
      const raw = new Float32Array(n + fade);
      const next = gen(rng(seed));
      for (let i = 0; i < raw.length; i++) raw[i] = next();
      const buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = raw[i];
      for (let i = 0; i < fade; i++) { const w = i / fade; d[i] = raw[i] * w + raw[n + i] * (1 - w); }
      return buf;
    };
    const white = loop(2.7, 7, (r) => () => r() * 2 - 1);
    const brown = loop(3.1, 3, (r) => { let b = 0; return () => { b = (b + 0.02 * (r() * 2 - 1)) / 1.02; return b * 3.5; }; });
    const pink = loop(2.3, 5, (r) => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      return () => {
        const w = r() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
        return out;
      };
    });
    // Crackle: sparse, short positive pops around a zero mean (fed into a gain AudioParam).
    const crackle = (() => {
      const n = Math.floor(sr * 1.9);
      const buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      const r = rng(11);
      let env = 0, amp = 0;
      for (let i = 0; i < n; i++) {
        if (r() < 34 / sr) amp = 0.6 + r() * 1.4;
        env = Math.max(env * Math.exp(-1 / (0.004 * sr)), amp);
        amp = 0;
        d[i] = env;
      }
      let mean = 0;
      for (let i = 0; i < n; i++) mean += d[i];
      mean /= n;
      for (let i = 0; i < n; i++) d[i] -= mean;
      return buf;
    })();
    return { white, brown, pink, crackle };
  }

  /**
   * Master chain: engines bus -> compressor -> master volume -> destination. Alert sounds have their
   * own bus straight into the master, so a roaring engine never squashes them.
   */
  function buildChain(ctx) {
    const engineBus = ctx.createGain();
    engineBus.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 6;
    comp.attack.value = 0.005; comp.release.value = 0.2;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    const alertBus = ctx.createGain();
    alertBus.gain.value = SB.CONFIG.audio.alertLevel;
    engineBus.connect(comp);
    comp.connect(master);
    alertBus.connect(master);
    master.connect(ctx.destination);
    return { engineBus, comp, master, alertBus };
  }

  /** A short tone with a soft attack and release (for the alert sounds). */
  function tone(ctx, dest, freq, t, dur, level, type) {
    const o = ctx.createOscillator();
    o.type = type || 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.012);
    g.gain.setValueAtTime(level, t + dur - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }
  /** Caution: a falling two-tone chime. */
  function chime(ctx, dest, t) { tone(ctx, dest, 880, t, 0.16, 0.5); tone(ctx, dest, 660, t + 0.17, 0.24, 0.5); }
  /** A parachute filling: a low thump with a rush of air (bigger for the mains). */
  function whump(ctx, dest, bufs, t, big) {
    const n = ctx.createBufferSource();
    n.buffer = bufs.pink;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = big ? 700 : 1100; lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(big ? 0.9 : 0.6, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0005, t + (big ? 1.1 : 0.6));
    n.connect(lp); lp.connect(g); g.connect(dest);
    n.start(t, 0.3); n.stop(t + 1.3);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(big ? 70 : 110, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(big ? 0.8 : 0.5, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0005, t + 0.4);
    o.connect(og); og.connect(dest);
    o.start(t); o.stop(t + 0.5);
  }
  /** Warning: two quick high pips (repeated while the warning lasts). */
  function beep(ctx, dest, t) { tone(ctx, dest, 1250, t, 0.08, 0.3, 'square'); tone(ctx, dest, 1250, t + 0.13, 0.08, 0.3, 'square'); }

  class EngineVoice {
    constructor(ctx, dest, bufs) {
      this.ctx = ctx;
      this.dest = dest;
      this.bufs = bufs;
      const t0 = ctx.currentTime;
      const gain = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
      const filt = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
      const src = (buf, offset) => {
        const s = ctx.createBufferSource();
        s.buffer = buf; s.loop = true;
        s.start(t0, offset % buf.duration);
        return s;
      };
      this.out = gain(0);        // overall loudness
      this.sputterG = gain(1);   // flameout dips
      this.crack = gain(1);      // crackle amplitude modulation
      this.air = filt('lowpass', 9000, 0.5);
      this.mix = gain(1);
      this.mix.connect(this.air); this.air.connect(this.crack); this.crack.connect(this.sputterG);
      this.sputterG.connect(this.out); this.out.connect(dest);

      this.rumbleSrc = src(bufs.brown, 0.37); this.rumbleLP = filt('lowpass', 150, 0.8); this.rumbleG = gain(0);
      this.rumbleSrc.connect(this.rumbleLP); this.rumbleLP.connect(this.rumbleG); this.rumbleG.connect(this.mix);
      this.roarSrc = src(bufs.pink, 1.13); this.roarBP = filt('bandpass', 900, 0.7); this.roarG = gain(0);
      this.roarSrc.connect(this.roarBP); this.roarBP.connect(this.roarG); this.roarG.connect(this.mix);
      this.hissSrc = src(bufs.white, 0.71); this.hissHP = filt('highpass', 3500, 0.5); this.hissG = gain(0);
      this.hissSrc.connect(this.hissHP); this.hissHP.connect(this.hissG); this.hissG.connect(this.mix);

      this.osc1 = ctx.createOscillator(); this.osc1.type = 'sawtooth'; this.osc1.frequency.value = 45;
      this.osc2 = ctx.createOscillator(); this.osc2.type = 'sawtooth'; this.osc2.frequency.value = 45.6;
      this.oscLP = filt('lowpass', 160, 1.0); this.throbG = gain(0);
      this.osc1.connect(this.oscLP); this.osc2.connect(this.oscLP); this.oscLP.connect(this.throbG); this.throbG.connect(this.mix);
      this.osc1.start(t0); this.osc2.start(t0);

      this.whine = ctx.createOscillator(); this.whine.type = 'sine'; this.whine.frequency.value = 1800;
      this.whineG = gain(0);
      this.whine.connect(this.whineG); this.whineG.connect(this.out); // bypasses the air filter
      this.whine.start(t0);

      this.crackSrc = src(bufs.crackle, 0.29); this.crackDepth = gain(0);
      this.crackSrc.connect(this.crackDepth); this.crackDepth.connect(this.crack.gain);

      this.noiseSrcs = [this.rumbleSrc, this.roarSrc, this.hissSrc];
      this.params = null;
    }

    /**
     * p: { level 0..1, size 0..1, throttle 0..1, air 0..1 (1 = sea level), crackle, whine, rate }
     * tc: smoothing time constant (s); when: start time (defaults to now).
     */
    set(p, tc, when) {
      const t = when === undefined ? this.ctx.currentTime : when;
      const k = tc || 0.08;
      const to = (param, v) => param.setTargetAtTime(v, t, k);
      const s = clamp(p.size, 0, 1), thr = clamp(p.throttle, 0, 1), a = clamp(p.air, 0, 1);
      to(this.out.gain, Math.max(0, p.level));
      to(this.air.frequency, 650 + 9000 * Math.pow(a, 1.5));
      to(this.rumbleLP.frequency, 70 + 170 * (1 - s) + 60 * thr);
      to(this.rumbleG.gain, 0.9 * (0.5 + 0.5 * s));
      to(this.roarBP.frequency, 300 + 900 * (1 - s) + 350 * thr);
      to(this.roarG.gain, 0.6 * (0.35 + 0.65 * a));
      to(this.hissG.gain, (0.08 + 0.22 * (1 - s)) * (0.25 + 0.75 * a));
      const f0 = 30 + 34 * (1 - s) + 12 * thr;
      to(this.osc1.frequency, f0);
      to(this.osc2.frequency, f0 * 1.013);
      to(this.throbG.gain, 0.22 * s);
      to(this.whine.frequency, 1100 + 1900 * thr * (1.2 - 0.5 * s));
      to(this.whineG.gain, 0.045 * (p.whine || 0) * (0.5 + 0.5 * (1 - a)) * Math.max(0, p.level));
      to(this.crackDepth.gain, 0.55 * (p.crackle || 0) * a * thr);
      const rate = p.rate || 1;
      for (const n of this.noiseSrcs) to(n.playbackRate, rate);
      this.params = p;
    }

    /** Ignition: a low thump with a falling pitch plus a short burst of filtered noise. */
    ignite(strength, size, when) {
      const ctx = this.ctx, t = when === undefined ? ctx.currentTime : when;
      this.sputterG.gain.cancelScheduledValues(t);
      this.sputterG.gain.setValueAtTime(1, t);
      const st = clamp(strength, 0, 1.5), sz = clamp(size, 0, 1);
      const burst = ctx.createBufferSource();
      burst.buffer = this.bufs.white;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400 + 1600 * (1 - sz); lp.Q.value = 0.7;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.linearRampToValueAtTime(0.9 * st, t + 0.012);
      bg.gain.exponentialRampToValueAtTime(0.0005, t + 0.35 + 0.45 * sz);
      burst.connect(lp); lp.connect(bg); bg.connect(this.dest);
      burst.start(t, 0.5); burst.stop(t + 1.2);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(140 - 60 * sz, t);
      o.frequency.exponentialRampToValueAtTime(32, t + 0.3);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.9 * st, t + 0.008);
      og.gain.exponentialRampToValueAtTime(0.0005, t + 0.4);
      o.connect(og); og.connect(this.dest);
      o.start(t); o.stop(t + 0.6);
    }

    /** Fuel ran out: a few coughs, then silence. */
    sputter(when) {
      const t = when === undefined ? this.ctx.currentTime : when;
      const g = this.sputterG.gain;
      g.cancelScheduledValues(t);
      const steps = [[0, 0.25], [0.06, 1.0], [0.13, 0.08], [0.2, 0.75], [0.31, 0.05], [0.38, 0.45], [0.5, 0.0]];
      for (const [dt, v] of steps) g.setValueAtTime(v, t + dt);
      g.setValueAtTime(1, t + 0.9);
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setTargetAtTime(0, t + 0.45, 0.06);
    }

    stop() {
      const t = this.ctx.currentTime;
      for (const n of [this.rumbleSrc, this.roarSrc, this.hissSrc, this.crackSrc, this.osc1, this.osc2, this.whine]) {
        try { n.stop(t + 0.05); } catch (e) { /* already stopped */ }
      }
      setTimeout(() => { try { this.out.disconnect(); } catch (e) { /* gone */ } }, 200);
    }
  }

  /** What the craft's engines are doing right now, reduced to sound parameters. */
  function engineState(f) {
    const c = f.craft;
    if (f.situation === 'crashed') return { firing: false, uids: new Set() };
    const pr = f.pressureRatio();
    const ts = c.thrustState(1, pr);
    const engines = [];
    for (const per of ts.per) for (const e of per.sec.engines) if (c.active.has(e.uid)) engines.push(e);
    const firing = f.throttle > 0.001 && engines.length > 0;
    let w = 0, size = 0, crackle = 0, whine = 0, thrust = 0;
    for (const e of engines) {
      const s = e.def.sound || { size: 0.5, crackle: 0.3, whine: 0.3 };
      const k = e.def.thrust;
      w += k; size += k * s.size; crackle += k * s.crackle; whine += k * s.whine; thrust += k;
    }
    if (w > 0) { size /= w; crackle /= w; whine /= w; }
    return { firing, uids: new Set(engines.map((e) => e.uid)), throttle: f.throttle, size, crackle, whine, thrust, air: Math.sqrt(clamp(pr, 0, 1)) };
  }

  /** Loudness for an engine state (bigger engines louder; vacuum keeps only part of it). */
  function levelFor(st, vacuumLevel) {
    if (!st.firing) return 0;
    const sizeGain = clamp(0.5 + 0.18 * Math.log2(Math.max(1, st.thrust) / 10000), 0.3, 1.0);
    return sizeGain * Math.pow(st.throttle, 0.55) * (vacuumLevel + (1 - vacuumLevel) * st.air);
  }

  const Audio = {
    ctx: null,
    voice: null,
    enabled: true,
    volume: 0.8,
    stats: { ignitions: 0, flameouts: 0, level: 0, bus: 0, chimes: 0, beeps: 0, whumps: 0 },
    prev: null,
    flightRef: null,

    loadSettings() {
      try {
        const s = JSON.parse(localStorage.getItem(SB.CONFIG.storageKeys.audio) || 'null');
        if (s) { this.enabled = s.enabled !== false; this.volume = clamp(+s.volume || 0, 0, 1); }
      } catch (e) { /* defaults */ }
    },
    saveSettings() {
      try { localStorage.setItem(SB.CONFIG.storageKeys.audio, JSON.stringify({ enabled: this.enabled, volume: this.volume })); } catch (e) { /* ignore */ }
    },

    /** Creates / resumes the AudioContext. Browsers only allow this from a user gesture. */
    unlock() {
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          this.ctx = new AC({ latencyHint: 'interactive' });
          this.bufs = makeBuffers(this.ctx);
          this.chain = buildChain(this.ctx);
          this.applyVolume();
        }
        if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('Audio unavailable:', e);
      }
    },

    init() {
      this.loadSettings();
      const unlock = () => this.unlock();
      window.addEventListener('pointerdown', unlock, true);
      window.addEventListener('keydown', unlock, true);
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend(); else this.ctx.resume();
      });
    },

    applyVolume() {
      if (!this.chain) return;
      const v = this.enabled ? this.volume * SB.CONFIG.audio.masterVolume : 0;
      this.chain.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    },
    setEnabled(on) { this.enabled = !!on; this.applyVolume(); this.saveSettings(); },
    toggle() { this.setEnabled(!this.enabled); return this.enabled; },
    setVolume(v) { this.volume = clamp(v, 0, 1); if (this.volume > 0 && !this.enabled) this.enabled = true; this.applyVolume(); this.saveSettings(); },

    /** Called every frame by the app. */
    update(app) {
      if (!this.ctx || !this.chain) return;
      const A = SB.CONFIG.audio;
      const f = app.screen === 'flight' ? app.flight : null;
      const now = this.ctx.currentTime;
      const busTarget = f && !f.paused ? (app.view === 'map' ? A.mapViewLevel : 1) : 0;
      this.chain.engineBus.gain.setTargetAtTime(busTarget, now, 0.08);
      this.stats.bus = busTarget;
      this.updateAlerts(f, now);
      if (!this.voice) this.voice = new EngineVoice(this.ctx, this.chain.engineBus, this.bufs);
      if (!f) { this.voice.set({ level: 0, size: 0.5, throttle: 0, air: 1 }, 0.1); this.prev = null; this.stats.level = 0; return; }
      if (this.flightRef !== f) { this.flightRef = f; this.prev = null; this.chuteSeen = f.chuteLog.length; }
      while (this.chuteSeen < f.chuteLog.length) {
        const e = f.chuteLog[this.chuteSeen++];
        whump(this.ctx, this.chain.engineBus, this.bufs, now + 0.01, e.ev === 'main');
        this.stats.whumps++;
      }
      const st = engineState(f);
      const level = levelFor(st, A.vacuumLevel);
      const prev = this.prev || { firing: false, uids: new Set() };
      if (st.firing) {
        const lit = [...st.uids].filter((u) => !prev.uids.has(u) || !prev.firing);
        if (lit.length) {
          const defs = f.craft.parts.filter((p) => lit.includes(p.uid)).map((p) => p.def);
          const size = defs.reduce((s, d) => s + (d.sound ? d.sound.size : 0.5), 0) / Math.max(1, defs.length);
          this.voice.ignite(Math.sqrt(st.throttle) * (0.6 + 0.4 * size) * (0.5 + 0.5 * st.air), size);
          this.stats.ignitions++;
        }
      } else if (prev.firing && f.situation !== 'crashed' && f.throttle > 0.001) {
        // still commanded on, so the tanks ran dry (or the engine was dropped): cough, then die
        this.voice.sputter();
        this.holdUntil = now + 0.45;
        this.holdLevel = prev.level || 0;
        this.stats.flameouts++;
      }
      const warp = f.warpRate();
      const p = {
        level: !st.firing && now < (this.holdUntil || 0) ? this.holdLevel : level,
        size: st.firing ? st.size : (prev.size || 0.5), throttle: st.firing ? st.throttle : (prev.throttle || 0) * 0.5,
        air: st.air === undefined ? 1 : st.air, crackle: st.crackle || 0, whine: st.whine || 0,
        rate: 1 + 0.06 * Math.log2(Math.max(1, warp)),
      };
      const tc = f.situation === 'crashed' ? 0.02 : st.firing && !prev.firing ? 0.04 : 0.09;
      this.voice.set(p, tc);
      st.level = level;
      if (!st.firing && prev.size !== undefined) st.size = prev.size;
      this.prev = st;
      this.stats.level = level;
    },

    /**
     * A chime when a caution appears (again after it has been gone for 3 s, or only once for
     * `once` alerts), and pips every half second while a warning lasts. Silent while paused.
     */
    updateAlerts(f, now) {
      const list = f && !f.paused ? f.alertList || [] : [];
      if (this.alertFlight !== f) { this.alertFlight = f; this.alertSeen = new Map(); this.nextBeep = 0; }
      const seen = this.alertSeen;
      let warning = false, chimed = false;
      for (const a of list) {
        const key = a.key || a.id;
        const last = seen.get(key);
        if (a.level === 'warning') warning = true;
        else if (!chimed && (last === undefined || (!a.once && now - last > 3))) {
          chime(this.ctx, this.chain.alertBus, now + 0.01);
          this.stats.chimes++;
          chimed = true;
        }
        seen.set(key, now);
      }
      if (warning && now >= this.nextBeep) {
        beep(this.ctx, this.chain.alertBus, now + 0.01);
        this.stats.beeps++;
        this.nextBeep = now + 0.5;
      }
    },

    debug() {
      return {
        state: this.ctx ? this.ctx.state : 'none', enabled: this.enabled, volume: this.volume,
        level: this.stats.level, bus: this.stats.bus, ignitions: this.stats.ignitions, flameouts: this.stats.flameouts,
        firing: !!(this.prev && this.prev.firing), chimes: this.stats.chimes, beeps: this.stats.beeps, whumps: this.stats.whumps,
      };
    },
  };

  SB.Audio = Audio;
  SB.AudioSynth = { makeBuffers, buildChain, EngineVoice, engineState, levelFor, chime, beep, whump };
})(typeof window !== 'undefined' ? window : globalThis);
