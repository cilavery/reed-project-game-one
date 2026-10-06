import { clamp } from './util.js';

// Every sound in the game is synthesised with the Web Audio API: filtered
// noise bursts and oscillators routed through HRTF panners and a generated
// concrete-room reverb. No audio files are needed.

function setPos(node, v) {
  if (node.positionX) {
    node.positionX.value = v.x;
    node.positionY.value = v.y;
    node.positionZ.value = v.z;
  } else {
    node.setPosition(v.x, v.y, v.z);
  }
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micEnabled = false;
    this.micLevel = 0;
    this.micFloor = null;
    this.hbTimer = 0;
    this.breathTimer = 0;
    this.breathIn = true;
    this.ambTimer = 5;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.comp = comp;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);

    this.verb = ctx.createConvolver();
    this.verb.buffer = this.impulse(3.2, 2.4);
    this.verbIn = ctx.createGain();
    this.verbIn.gain.value = 0.5;
    this.verbIn.connect(this.verb);
    this.verb.connect(this.master);

    // Player-originated sounds: mostly dry, a little room.
    this.sfx = ctx.createGain();
    this.out(this.sfx, 0.35);
    // Sounds inside your head (heartbeat, breathing, UI): dry.
    this.dry = ctx.createGain();
    this.dry.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.amb = ctx.createGain();
    this.amb.connect(this.master);
    this.ambWet = ctx.createGain();
    this.ambWet.gain.value = 0.6;
    this.ambWet.connect(this.verbIn);

    this.startAmbience();
    this.startRain();
    this.startEntityLoop();
  }

  get now() { return this.ctx.currentTime; }

  impulse(dur, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * dur);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // a few discrete early reflections off nearby concrete, then a diffuse tail
        const early = i < rate * 0.08 && Math.random() < 0.004 ? 2.5 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  }

  out(node, wet = 1) {
    node.connect(this.master);
    if (wet > 0) {
      const g = this.ctx.createGain();
      g.gain.value = wet;
      node.connect(g);
      g.connect(this.verbIn);
    }
  }

  // A one-shot 3D source at pos. muffle 0..1 lowpasses it (walls in between).
  spatial(pos, muffle = 0, wet = 1.2, ref = 2) {
    const ctx = this.ctx;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 18000 * Math.pow(0.035, clamp(muffle, 0, 1));
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.1;
    p.maxDistance = 100;
    setPos(p, pos);
    f.connect(p);
    this.out(p, wet);
    return f;
  }

  burst(dest, { t = 0, dur = 0.1, freq = 1000, q = 1, type = 'bandpass', gain = 0.3, attack = 0.002, rate = 1 }) {
    const ctx = this.ctx;
    const when = ctx.currentTime + t;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + dur);
    s.connect(f);
    f.connect(g);
    g.connect(dest);
    s.start(when, Math.random() * 1.5);
    s.stop(when + attack + dur + 0.05);
  }

  tone(dest, { t = 0, freq = 100, end = null, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.005 }) {
    const ctx = this.ctx;
    const when = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    if (end) o.frequency.exponentialRampToValueAtTime(end, when + attack + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + dur);
    o.connect(g);
    g.connect(dest);
    o.start(when);
    o.stop(when + attack + dur + 0.05);
    return o;
  }

  // ---------- ambience ----------
  startAmbience() {
    const ctx = this.ctx;
    const drone = ctx.createGain();
    drone.gain.value = 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 150;
    for (const f of [41.2, 41.7, 61.9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.04;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start();
    lp.connect(drone);
    drone.connect(this.amb);
    drone.connect(this.ambWet);

    const vent = ctx.createBufferSource();
    vent.buffer = this.noise;
    vent.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 170;
    bp.Q.value = 0.6;
    const vg = ctx.createGain();
    vg.gain.value = 0.06;
    vent.connect(bp);
    bp.connect(vg);
    vg.connect(this.amb);
    vent.start();

    const air = ctx.createBufferSource();
    air.buffer = this.noise;
    air.loop = true;
    air.playbackRate.value = 0.7;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const ag = ctx.createGain();
    ag.gain.value = 0.004;
    air.connect(hp);
    hp.connect(ag);
    ag.connect(this.amb);
    air.start();
  }

  // Distant random events: water drips, pipe knocks, metal groans.
  ambientEvent(listener) {
    if (!this.ctx) return;
    const a = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 22;
    const pos = { x: listener.x + Math.cos(a) * r, y: 2.5, z: listener.z + Math.sin(a) * r };
    const d = this.spatial(pos, 0.3 + Math.random() * 0.5, 2.5);
    const k = Math.random();
    if (k < 0.4) {
      const f = 900 + Math.random() * 900;
      this.tone(d, { freq: f, end: f * 0.45, dur: 0.05, gain: 0.25 });
      if (Math.random() < 0.5) this.tone(d, { t: 0.4 + Math.random() * 0.6, freq: f * 1.1, end: f * 0.5, dur: 0.05, gain: 0.2 });
    } else if (k < 0.7) {
      for (let i = 0; i < 3; i++) {
        this.tone(d, { t: i * 0.14, freq: 140 + Math.random() * 40, end: 70, dur: 0.25, type: 'triangle', gain: 0.35 });
        this.burst(d, { t: i * 0.14, dur: 0.08, freq: 1800, q: 6, gain: 0.25 });
      }
    } else {
      const ctx = this.ctx;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const when = ctx.currentTime;
      const f0 = 70 + Math.random() * 60;
      o.frequency.setValueAtTime(f0, when);
      o.frequency.linearRampToValueAtTime(f0 * 0.7, when + 2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 600 + Math.random() * 600;
      bp.Q.value = 9;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(0.5, when + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 2.2);
      o.connect(bp);
      bp.connect(g);
      g.connect(d);
      o.start(when);
      o.stop(when + 2.3);
    }
  }

  // ---------- player sounds ----------
  footstep(v) {
    if (!this.ctx) return;
    const d = this.sfx;
    this.tone(d, { freq: 85 + Math.random() * 25, end: 40, dur: 0.09, gain: 0.32 * v });
    this.burst(d, { dur: 0.07 + 0.05 * v, freq: 320 + Math.random() * 260, q: 0.9, gain: 0.24 * v });
    this.burst(d, { t: 0.012, dur: 0.05, freq: 2600 + Math.random() * 1600, q: 0.8, gain: 0.07 * v });
  }

  land(v) {
    if (!this.ctx) return;
    const d = this.sfx;
    this.tone(d, { freq: 70, end: 32, dur: 0.22, gain: 0.55 * v });
    this.burst(d, { dur: 0.2, freq: 260, q: 0.7, gain: 0.4 * v });
    this.burst(d, { t: 0.02, dur: 0.08, freq: 2400, q: 0.8, gain: 0.12 * v });
  }

  glass(v) {
    if (!this.ctx) return;
    const d = this.sfx;
    for (let i = 0; i < 7; i++) {
      this.burst(d, { t: Math.random() * 0.16, dur: 0.015 + Math.random() * 0.05, freq: 2800 + Math.random() * 6000, q: 3 + Math.random() * 8, gain: (0.14 + Math.random() * 0.2) * v });
    }
    for (let i = 0; i < 3; i++) {
      this.tone(d, { t: Math.random() * 0.12, freq: 3500 + Math.random() * 4000, dur: 0.06, gain: 0.03 * v });
    }
  }

  click() {
    if (!this.ctx) return;
    this.burst(this.dry, { dur: 0.012, freq: 3500, type: 'highpass', gain: 0.18 });
    this.tone(this.dry, { freq: 1700, dur: 0.008, type: 'square', gain: 0.04 });
  }

  pickup() {
    if (!this.ctx) return;
    this.burst(this.sfx, { dur: 0.02, freq: 4000, q: 4, gain: 0.15 });
    this.tone(this.dry, { t: 0.02, freq: 440, dur: 0.6, gain: 0.05 });
    this.tone(this.dry, { t: 0.1, freq: 660, dur: 0.8, gain: 0.04 });
  }

  heartbeat(v) {
    if (!this.ctx) return;
    this.tone(this.dry, { freq: 58, end: 38, dur: 0.12, gain: 0.55 * v });
    this.tone(this.dry, { t: 0.2, freq: 52, end: 36, dur: 0.14, gain: 0.38 * v });
  }

  breath(v, inhale) {
    if (!this.ctx) return;
    this.burst(this.dry, {
      dur: inhale ? 0.45 : 0.55, attack: 0.22, freq: inhale ? 1700 : 1100, q: 0.7, gain: 0.06 * v,
    });
  }

  stinger() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const when = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(5000, when);
    lp.frequency.exponentialRampToValueAtTime(300, when + 3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.16, when + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 3.2);
    lp.connect(g);
    this.out(g, 1);
    for (const f of [92.5, 98, 138.6, 196, 207.7, 293.7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.01);
      o.connect(lp);
      o.start(when);
      o.stop(when + 3.3);
    }
    this.tone(this.dry, { freq: 70, end: 28, dur: 1.6, gain: 0.7 });
    this.burst(this.sfx, { dur: 0.9, attack: 0.05, freq: 3000, type: 'highpass', gain: 0.18 });
  }

  scream() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const when = ctx.currentTime;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.9, when + 0.02);
    g.gain.setValueAtTime(0.9, when + 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 1.8);
    bp.connect(g);
    this.out(g, 0.8);
    const mod = ctx.createOscillator();
    mod.frequency.value = 33;
    const modG = ctx.createGain();
    modG.gain.value = 120;
    mod.connect(modG);
    mod.start(when);
    mod.stop(when + 1.9);
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f = 300 + Math.random() * 500;
      o.frequency.setValueAtTime(f * 0.6, when);
      o.frequency.exponentialRampToValueAtTime(f * 1.4, when + 0.12);
      o.frequency.exponentialRampToValueAtTime(f, when + 1.6);
      modG.connect(o.frequency);
      o.connect(bp);
      o.start(when);
      o.stop(when + 1.9);
    }
    this.burst(this.sfx, { dur: 1.4, freq: 2500, type: 'highpass', gain: 0.6 });
    this.tone(this.dry, { freq: 80, end: 25, dur: 1.2, gain: 1 });
  }

  // ---------- entity ----------
  startEntityLoop() {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 330;
    bp.Q.value = 2.2;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 43;
    const og = ctx.createGain();
    og.gain.value = 0.12;
    this.eGain = ctx.createGain();
    this.eGain.gain.value = 0;
    this.eMuffle = ctx.createBiquadFilter();
    this.eMuffle.type = 'lowpass';
    this.eMuffle.frequency.value = 18000;
    this.ePanner = ctx.createPanner();
    this.ePanner.panningModel = 'HRTF';
    this.ePanner.distanceModel = 'inverse';
    this.ePanner.refDistance = 1.5;
    this.ePanner.rolloffFactor = 1.3;
    n.connect(bp);
    bp.connect(this.eGain);
    o.connect(og);
    og.connect(this.eGain);
    this.eGain.connect(this.eMuffle);
    this.eMuffle.connect(this.ePanner);
    this.out(this.ePanner, 1);
    n.start();
    o.start();
  }

  updateEntityLoop(pos, muffle, level) {
    if (!this.ctx) return;
    setPos(this.ePanner, pos);
    const t = this.now;
    this.eMuffle.frequency.setTargetAtTime(18000 * Math.pow(0.035, clamp(muffle, 0, 1)), t, 0.1);
    this.eGain.gain.setTargetAtTime(level, t, 0.06);
  }

  entityStep(pos, muffle, v) {
    if (!this.ctx) return;
    const d = this.spatial(pos, muffle, 1.4);
    this.tone(d, { freq: 62, end: 30, dur: 0.25, gain: 1.0 * v });
    this.burst(d, { dur: 0.18, freq: 300, type: 'lowpass', q: 0.5, gain: 0.7 * v });
    // claws on concrete
    this.burst(d, { t: 0.03, dur: 0.025, freq: 3400, q: 6, gain: 0.25 * v });
    this.burst(d, { t: 0.06, dur: 0.02, freq: 4100, q: 6, gain: 0.18 * v });
  }

  entityVoice(pos, muffle, kind) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const d = this.spatial(pos, muffle, 2);
    const when = ctx.currentTime;
    if (kind === 'click') {
      const n = 14 + Math.floor(Math.random() * 14);
      for (let i = 0; i < n; i++) {
        this.burst(d, { t: i * 0.04 + Math.random() * 0.012, dur: 0.012, freq: 1100 + Math.random() * 900, q: 4, gain: 0.5 });
      }
      this.tone(d, { freq: 85, end: 60, dur: n * 0.04, type: 'sawtooth', gain: 0.08 });
      return;
    }
    const shriek = kind === 'shriek';
    const dur = shriek ? 1.1 : 2.2 + Math.random();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = shriek ? 1600 : 650;
    bp.Q.value = shriek ? 1.2 : 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(shriek ? 0.9 : 0.6, when + (shriek ? 0.04 : 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    bp.connect(g);
    g.connect(d);
    const vib = ctx.createOscillator();
    vib.frequency.value = shriek ? 23 : 5.5;
    const vibG = ctx.createGain();
    vibG.gain.value = shriek ? 60 : 4;
    vib.connect(vibG);
    vib.start(when);
    vib.stop(when + dur);
    const base = shriek ? 520 : 72 + Math.random() * 20;
    for (const mul of [1, 1.047, 2.01]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * mul * (shriek ? 0.7 : 1.1), when);
      o.frequency.exponentialRampToValueAtTime(base * mul * (shriek ? 1.5 : 1), when + (shriek ? 0.15 : 0.6));
      o.frequency.exponentialRampToValueAtTime(base * mul * (shriek ? 0.9 : 0.72), when + dur);
      vibG.connect(o.frequency);
      o.connect(bp);
      o.start(when);
      o.stop(when + dur);
    }
    if (shriek) this.burst(d, { dur: 0.8, freq: 3000, type: 'highpass', gain: 0.4 });
  }


  // ---------- weather ----------
  startRain() {
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5000;
    const g = ctx.createGain();
    g.gain.value = 0.03;
    n.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(this.amb);
    n.start();
  }

  thunder(closeness) {
    if (!this.ctx) return;
    const d = this.amb;
    this.burst(d, { t: 0, dur: 0.25 * closeness, freq: 2500, type: 'highpass', gain: 0.25 * closeness * closeness });
    this.burst(d, { t: 0.05, dur: 5 + Math.random() * 2, attack: 0.3, freq: 120, type: 'lowpass', q: 0.7, gain: 0.5 + closeness * 0.4, rate: 0.5 });
    this.burst(d, { t: 0.6, dur: 3, attack: 0.5, freq: 70, type: 'lowpass', gain: 0.4, rate: 0.3 });
  }

  // ---------- flare ----------
  flareIgnite() {
    if (!this.ctx) return;
    this.burst(this.sfx, { dur: 0.3, freq: 2200, type: 'highpass', gain: 0.35 });
    this.burst(this.sfx, { t: 0.15, dur: 0.6, attack: 0.05, freq: 900, q: 0.6, gain: 0.45 });
    this.tone(this.sfx, { t: 0.15, freq: 120, end: 60, dur: 0.2, gain: 0.3 });
    if (!this.flareGain) {
      const ctx = this.ctx;
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 0.4;
      this.flareGain = ctx.createGain();
      this.flareGain.gain.value = 0;
      n.connect(bp);
      bp.connect(this.flareGain);
      this.out(this.flareGain, 0.3);
      n.start();
    }
    this.flareGain.gain.setTargetAtTime(0.06, this.now + 0.2, 0.1);
  }

  flareCrackle() {
    if (!this.ctx) return;
    this.burst(this.sfx, { dur: 0.01 + Math.random() * 0.02, freq: 1500 + Math.random() * 4000, q: 3, gain: 0.05 + Math.random() * 0.08 });
  }

  flareOut() {
    if (!this.flareGain) return;
    this.flareGain.gain.setTargetAtTime(0, this.now, 0.3);
    this.burst(this.sfx, { dur: 0.4, freq: 1800, q: 0.6, gain: 0.08 });
  }

  // ---------- body ----------
  hurt() {
    if (!this.ctx) return;
    this.burst(this.dry, { dur: 0.18, freq: 3000, type: 'highpass', gain: 0.6 });
    this.burst(this.dry, { t: 0.02, dur: 0.3, freq: 900, q: 2, gain: 0.5 });
    this.tone(this.dry, { freq: 70, end: 35, dur: 0.3, gain: 0.8 });
    this.voice(this.dry, 150, 105, 0.45, 0.22, 750);
  }

  pain() {
    if (!this.ctx) return;
    this.voice(this.dry, 125, 98, 0.6, 0.07, 620);
  }

  heal() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) this.burst(this.dry, { t: i * 0.18, dur: 0.14, freq: 3200, q: 1, gain: 0.12 });
    this.burst(this.dry, { t: 0.7, dur: 0.9, attack: 0.3, freq: 1100, q: 0.6, gain: 0.07 });
  }

  // A dragged foot.
  limpScuff() {
    if (!this.ctx) return;
    this.burst(this.sfx, { dur: 0.28, attack: 0.06, freq: 650, q: 0.8, gain: 0.09 });
  }

  // Formant-filtered sawtooth: a crude human vocalisation.
  voice(dest, f0, f1, dur, gain, formant) {
    const ctx = this.ctx;
    const when = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = formant;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(bp);
    bp.connect(g);
    g.connect(dest);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  // ---------- objects ----------
  // The working clock. Carries a long way down quiet corridors, and is
  // muffled by every wall in between, so you can follow it.
  // loud scales how far the ticking carries: <1 faint, >1 loud.
  tick(pos, tock, muffle, loud = 1) {
    if (!this.ctx) return;
    const d = this.spatial(pos, (muffle * 0.75) / Math.max(1, loud), 0.6, 7 * loud);
    const g = Math.min(1, loud);
    this.burst(d, { dur: 0.014, freq: tock ? 2300 : 3100, q: 8, gain: 1.4 * g });
    this.burst(d, { dur: 0.03, freq: tock ? 900 : 1200, q: 3, gain: 0.25 * g });
    this.tone(d, { freq: tock ? 1800 : 2400, dur: 0.02, gain: 0.08 * g });
  }

  clockClunk() {
    if (!this.ctx) return;
    this.tone(this.sfx, { freq: 320, end: 200, dur: 0.1, gain: 0.2 });
    this.burst(this.sfx, { dur: 0.05, freq: 1500, q: 5, gain: 0.2 });
  }

  doorCreak(pos) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const d = this.spatial(pos, 0, 1);
    const when = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(170 + Math.random() * 40, when);
    o.frequency.linearRampToValueAtTime(110, when + 0.7);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 14;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.25, when + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.75);
    o.connect(bp);
    bp.connect(g);
    g.connect(d);
    o.start(when);
    o.stop(when + 0.8);
  }

  entityCrawl(pos, muffle, v) {
    if (!this.ctx) return;
    const d = this.spatial(pos, muffle, 1.2);
    this.burst(d, { dur: 0.04, freq: 1200, q: 1.5, gain: 0.55 * v }); // palm slap
    this.tone(d, { freq: 95, end: 50, dur: 0.08, gain: 0.45 * v });
    this.burst(d, { t: 0.09, dur: 0.05, freq: 500, q: 1, gain: 0.35 * v }); // knee
    this.burst(d, { t: 0.02, dur: 0.015, freq: 4200, q: 8, gain: 0.2 * v }); // nails
  }

  // ---------- the ending ----------
  // A bus that bypasses the master gain, for sounds that carry on while the
  // rest of the world is silenced.
  overBus() {
    if (!this.over) {
      this.over = this.ctx.createGain();
      this.over.connect(this.comp);
    }
    return this.over;
  }

  // A clock chime: inharmonic bell partials with long tails.
  chime(gain = 0.5, f = 196) {
    if (!this.ctx) return;
    const o = this.overBus();
    for (const [r, g, d] of [[1, 1, 3.5], [2, 0.6, 2.6], [2.76, 0.4, 2], [5.4, 0.22, 1.2], [8.93, 0.12, 0.7]]) {
      this.tone(o, { freq: f * r, dur: d, gain: gain * g * 0.35, attack: 0.004 });
      this.tone(this.verbIn, { freq: f * r, dur: d, gain: gain * g * 0.2, attack: 0.004 });
    }
  }

  bulbPop(pos) {
    if (!this.ctx) return;
    const d = this.spatial(pos, 0, 1.2, 3);
    this.burst(d, { dur: 0.04, freq: 1800, q: 1.5, gain: 0.9 });
    this.tone(d, { freq: 120, end: 50, dur: 0.12, gain: 0.3 });
    for (let i = 0; i < 6; i++) {
      this.burst(d, { t: 0.05 + Math.random() * 0.4, dur: 0.02, freq: 4000 + Math.random() * 4000, q: 6, gain: 0.15 });
    }
  }

  // Time stops: the world goes silent except what's inside your head, and
  // one tick from the clock in your hands.
  timeStop() {
    if (!this.ctx) return;
    const t = this.now;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0.0001, t, 0.03);
    const o = this.overBus();
    this.tone(o, { freq: 52, end: 34, dur: 0.5, gain: 0.8 });
    this.tone(o, { t: 0.1, freq: 6800, dur: 1.3, attack: 0.3, gain: 0.02 });
    this.burst(o, { t: 0.95, dur: 0.014, freq: 2600, q: 8, gain: 0.9 });
    this.burst(o, { t: 0.95, dur: 0.03, freq: 1000, q: 3, gain: 0.2 });
  }

  timeResume() {
    if (!this.ctx) return;
    const t = this.now;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0.9, t, 0.03);
  }

  endingRumble(dur) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const when = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    n.playbackRate.value = 0.4;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(60, when);
    lp.frequency.exponentialRampToValueAtTime(500, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(1.2, when + dur);
    g.gain.setValueAtTime(1.2, when + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.15);
    n.connect(lp);
    lp.connect(g);
    this.out(g, 0.6);
    n.start(when);
    n.stop(when + dur + 0.2);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(28, when);
    o.frequency.exponentialRampToValueAtTime(70, when + dur);
    const og = ctx.createGain();
    og.gain.value = 0.2;
    o.connect(og);
    og.connect(g);
    o.start(when);
    o.stop(when + dur + 0.2);
    // the building groaning and snapping as it folds
    for (let t = 0.3; t < dur; t += 0.15 + Math.random() * 0.35) {
      this.burst(this.sfx, { t, dur: 0.05 + Math.random() * 0.2, freq: 300 + Math.random() * 2500, q: 4 + Math.random() * 8, gain: 0.2 + (t / dur) * 0.4 });
      if (Math.random() < 0.3) this.tone(this.sfx, { t, freq: 80 + Math.random() * 120, end: 40, dur: 0.6, type: 'sawtooth', gain: 0.1 });
    }
    // fade the building's own ambience out
    this.amb.gain.setTargetAtTime(0, when + dur * 0.5, dur * 0.2);
    this.ambWet.gain.setTargetAtTime(0, when + dur * 0.5, dur * 0.2);
    if (this.flareGain) this.flareGain.gain.setTargetAtTime(0, when, 0.2);
  }

  crush() {
    if (!this.ctx) return;
    this.tone(this.master, { freq: 55, end: 18, dur: 2.5, gain: 1 });
    this.burst(this.master, { dur: 1.6, freq: 400, type: 'lowpass', gain: 1 });
    for (let i = 0; i < 18; i++) this.burst(this.master, { t: Math.random() * 0.4, dur: 0.05 + Math.random() * 0.1, freq: 200 + Math.random() * 3000, q: 3, gain: 0.5 });
    this.voice(this.master, 900, 300, 0.7, 0.3, 1500);
  }

  // Daylight: traffic, birds, people.
  startCity() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const when = ctx.currentTime;
    this.city = ctx.createGain();
    this.city.gain.setValueAtTime(0.0001, when);
    this.city.gain.exponentialRampToValueAtTime(1, when + 3);
    this.city.connect(this.master);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 450;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    n.connect(lp);
    lp.connect(g);
    g.connect(this.city);
    n.start();
    const hum = ctx.createBufferSource();
    hum.buffer = this.noise;
    hum.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 0.5;
    const hg = ctx.createGain();
    hg.gain.value = 0.015;
    hum.connect(bp);
    bp.connect(hg);
    hg.connect(this.city);
    hum.start();
    this.cityTimer = 0;
  }

  updateCity(dt) {
    if (!this.city) return;
    this.cityTimer -= dt;
    if (this.cityTimer > 0) return;
    this.cityTimer = 0.25 + Math.random() * 0.8;
    const r = Math.random();
    const d = this.city;
    if (r < 0.45) {
      // bird
      const f = 2500 + Math.random() * 2500;
      const count = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < count; i++) this.tone(d, { t: i * 0.09, freq: f, end: f * (0.7 + Math.random() * 0.6), dur: 0.06, gain: 0.04 });
    } else if (r < 0.7) {
      // car passing
      this.burst(d, { dur: 2.2, attack: 1, freq: 300 + Math.random() * 200, q: 0.5, gain: 0.25, rate: 0.6 });
    } else if (r < 0.92) {
      // voices, far off
      for (let i = 0; i < 3; i++) this.voice(d, 160 + Math.random() * 90, 140 + Math.random() * 80, 0.25, 0.012, 500 + Math.random() * 600);
    } else {
      this.tone(d, { freq: 420, dur: 0.35, type: 'square', gain: 0.015 }); // distant horn
    }
  }

  resetAfterEnding() {
    if (!this.ctx) return;
    const t = this.now;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(0.9, t);
    this.amb.gain.cancelScheduledValues(t);
    this.amb.gain.setValueAtTime(1, t);
    this.ambWet.gain.cancelScheduledValues(t);
    this.ambWet.gain.setValueAtTime(0.6, t);
    if (this.city) {
      this.city.gain.cancelScheduledValues(t);
      this.city.gain.setTargetAtTime(0, t, 0.3);
      const old = this.city;
      setTimeout(() => old.disconnect(), 2000);
      this.city = null;
    }
  }

  // ---------- per-frame ----------
  setListener(pos, fwd, up) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  // fear 0..1 drives the heartbeat; exertion 0..1 drives breathing.
  update(dt, fear, exertion, listenerPos) {
    if (!this.ctx) return;
    this.hbTimer -= dt;
    if (fear > 0.12 && this.hbTimer <= 0) {
      this.heartbeat(0.25 + fear * 0.75);
      this.hbTimer = 1.15 - fear * 0.75;
    }
    this.breathTimer -= dt;
    const b = Math.max(exertion, fear * 0.6);
    if (b > 0.2 && this.breathTimer <= 0) {
      this.breath(b, this.breathIn);
      this.breathTimer = (this.breathIn ? 0.55 : 0.75) * (1.4 - b * 0.7);
      this.breathIn = !this.breathIn;
    }
    this.ambTimer -= dt;
    if (this.ambTimer <= 0) {
      this.ambientEvent(listenerPos);
      this.ambTimer = 5 + Math.random() * 12;
    }
  }

  // ---------- microphone ----------
  async enableMic() {
    this.init();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    const src = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.micBuf = new Float32Array(this.analyser.fftSize);
    this.micEnabled = true;
  }

  // Returns 0..1 loudness above the room's adaptive noise floor.
  readMic(dt) {
    if (!this.micEnabled) return 0;
    this.analyser.getFloatTimeDomainData(this.micBuf);
    let s = 0;
    for (let i = 0; i < this.micBuf.length; i++) s += this.micBuf[i] * this.micBuf[i];
    const db = 20 * Math.log10(Math.sqrt(s / this.micBuf.length) + 1e-9);
    if (this.micFloor === null) this.micFloor = db;
    if (db < this.micFloor) this.micFloor += (db - this.micFloor) * Math.min(1, dt * 3);
    else this.micFloor += (db - this.micFloor) * Math.min(1, dt * 0.03);
    const lvl = clamp((db - this.micFloor - 9) / 28, 0, 1);
    this.micLevel = lvl > this.micLevel ? lvl : Math.max(lvl, this.micLevel - dt * 1.2);
    return this.micLevel;
  }
}
