// Christmas Chaos — sound.js
// Every sound is synthesised with Web Audio (no files, works offline). Browsers only allow audio after a
// user gesture, so call unlock() from a click/tap (the TV's "Click to start the show" overlay).
// Every effect is a safe no-op before unlock(), when muted, or when Web Audio is missing.
//
//   import * as sound from '/assets/sound.js';
//   startButton.onclick = () => sound.unlock();
//   wheel.spinTo(i, ms, { onTick: sound.tick });
//   sound.setVolume(0.6); sound.toggleMute();   // persisted in localStorage (cc.volume / cc.muted)

const LS_VOLUME = 'cc.volume';
const LS_MUTED = 'cc.muted';

function readStore(key, fallback) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writeStore(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / blocked storage: keep the in-memory value */
  }
}

let ctx = null;
let master = null;
let noise = null;
let volume = clampVolume(readStore(LS_VOLUME, 0.8));
let muted = readStore(LS_MUTED, false) === true;
const listeners = new Set();
let lastTick = 0;

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.8;
}

function notify() {
  for (const cb of listeners) {
    try {
      cb({ volume, muted, unlocked: isUnlocked() });
    } catch (e) {
      console.error(e);
    }
  }
}

function applyMaster() {
  if (!master || !ctx) return;
  const target = muted ? 0 : volume * volume; // perceptual curve
  master.gain.cancelScheduledValues(ctx.currentTime);
  master.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
}

/**
 * Create/resume the AudioContext. Call from a user gesture. Resolves true when audio can play.
 */
export async function unlock() {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC({ latencyHint: 'interactive' });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(comp);
      comp.connect(ctx.destination);
      const len = Math.floor(ctx.sampleRate * 2);
      noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state !== 'running') await ctx.resume();
    // A silent blip finishes the unlock on iOS Safari.
    const b = ctx.createBufferSource();
    b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    b.connect(ctx.destination);
    b.start(0);
    applyMaster();
    notify();
    return ctx.state === 'running';
  } catch (e) {
    console.warn('sound: unlock failed', e);
    return false;
  }
}

export function isUnlocked() {
  return !!ctx && ctx.state === 'running';
}

export function getVolume() {
  return volume;
}
export function setVolume(v) {
  volume = clampVolume(v);
  writeStore(LS_VOLUME, volume);
  applyMaster();
  notify();
  return volume;
}
export function isMuted() {
  return muted;
}
export function setMuted(m) {
  muted = !!m;
  writeStore(LS_MUTED, muted);
  applyMaster();
  notify();
  return muted;
}
export function toggleMute() {
  return setMuted(!muted);
}
/** Subscribe to {volume, muted, unlocked} changes. Returns an unsubscribe function. */
export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ------------------------------------------------------------------ voices ------------------- */

function ready() {
  return !!ctx && ctx.state === 'running' && !muted && volume > 0;
}

/** Output bus for one effect (lets drumroll be stopped early). */
function bus(gain = 1) {
  const g = ctx.createGain();
  g.gain.value = gain;
  g.connect(master);
  return g;
}

/** Oscillator voice with an attack/decay envelope and optional pitch glide + low-pass filter. */
function tone(out, { freq, type = 'sine', t = ctx.currentTime, dur = 0.2, gain = 0.3, attack = 0.005, release, to, detune = 0, filter, q = 0.7, vibrato = 0 }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  osc.detune.value = detune;
  let node = osc;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filter;
    f.Q.value = q;
    node.connect(f);
    node = f;
  }
  if (vibrato) {
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 5.5;
    lg.gain.value = vibrato;
    lfo.connect(lg).connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
  }
  node.connect(g).connect(out);
  const rel = release ?? dur;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + rel);
  osc.start(t);
  osc.stop(t + attack + rel + 0.05);
  return osc;
}

/** Filtered noise burst. */
function hiss(out, { t = ctx.currentTime, dur = 0.1, gain = 0.2, type = 'bandpass', freq = 1500, to, q = 1, attack = 0.003 }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  const offset = Math.random() * 1.5;
  src.start(t, offset, dur + 0.05);
  return src;
}

/* ------------------------------------------------------------------ effects ------------------ */

/** Wheel tick: a short woody click (self-throttled so a fast wheel never machine-guns). */
export function tick() {
  if (!ready()) return;
  const now = ctx.currentTime;
  if (now - lastTick < 0.028) return;
  lastTick = now;
  const out = bus(0.9);
  const p = 1 + (Math.random() - 0.5) * 0.08;
  tone(out, { freq: 1750 * p, type: 'triangle', t: now, dur: 0.035, gain: 0.32, attack: 0.001, to: 900 * p });
  hiss(out, { t: now, dur: 0.018, gain: 0.16, type: 'highpass', freq: 3200 });
}

/** Landing sting: bright strummed major chord with a bell on top. */
export function land() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.8);
  tone(out, { freq: 110, type: 'sine', t, dur: 0.18, gain: 0.5, attack: 0.002 });
  [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => {
    tone(out, { freq: f, type: 'triangle', t: t + k * 0.018, dur: 0.9, gain: 0.2, attack: 0.004 });
    tone(out, { freq: f * 2, type: 'sine', t: t + k * 0.018, dur: 0.5, gain: 0.05, attack: 0.004 });
  });
  tone(out, { freq: 2093, type: 'sine', t: t + 0.06, dur: 1.3, gain: 0.12, attack: 0.002 });
}

/** Game-show buzzer honk. */
export function buzz() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const out = bus(0.75);
  const dur = 0.62;
  tone(out, { freq: 155, type: 'sawtooth', t, dur, gain: 0.32, attack: 0.008, release: dur, filter: 1500, q: 1.2 });
  tone(out, { freq: 161, type: 'sawtooth', t, dur, gain: 0.26, attack: 0.008, release: dur, filter: 1500, q: 1.2 });
  tone(out, { freq: 77.5, type: 'square', t, dur, gain: 0.2, attack: 0.008, release: dur, filter: 900 });
}

/** Correct answer: rising sparkle chime. */
export function correct() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.8);
  [1046.5, 1318.5, 1568, 2093].forEach((f, k) => {
    tone(out, { freq: f, type: 'sine', t: t + k * 0.075, dur: 0.7, gain: 0.22, attack: 0.003 });
    tone(out, { freq: f * 3, type: 'sine', t: t + k * 0.075, dur: 0.25, gain: 0.03, attack: 0.003 });
  });
}

/** Wrong answer: friendly low "eh-eh" buzz (never harsh — "Not this time"). */
export function wrong() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.7);
  [0, 0.27].forEach((d) => {
    tone(out, { freq: 140, to: 105, type: 'sawtooth', t: t + d, dur: 0.22, gain: 0.28, attack: 0.006, release: 0.22, filter: 800 });
    tone(out, { freq: 133, to: 99, type: 'square', t: t + d, dur: 0.22, gain: 0.14, attack: 0.006, release: 0.22, filter: 600 });
  });
}

/** Countdown beep for the last five seconds. Pass true for the final (higher, longer) beep. */
export function beep(final = false) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const out = bus(0.6);
  tone(out, { freq: final ? 1320 : 880, type: 'sine', t, dur: final ? 0.5 : 0.12, gain: 0.32, attack: 0.004 });
  tone(out, { freq: final ? 2640 : 1760, type: 'sine', t, dur: final ? 0.3 : 0.08, gain: 0.05, attack: 0.004 });
}

/** Brass fanfare: da-da-da DAAA, da-DAAAA (podium, Double Down). */
export function fanfare() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.02;
  const out = bus(0.7);
  const brass = (f, at, dur, g = 0.16) => {
    [0, 7, -6].forEach((det, k) =>
      tone(out, { freq: f, type: 'sawtooth', t: t + at, dur, gain: k ? g * 0.6 : g, attack: 0.03, release: dur, detune: det, filter: 2600, q: 0.9, vibrato: dur > 0.4 ? 4 : 0 })
    );
  };
  brass(392, 0, 0.13);
  brass(392, 0.15, 0.13);
  brass(392, 0.3, 0.13);
  brass(523.25, 0.45, 0.42);
  brass(392, 0.92, 0.14);
  brass(523.25, 1.08, 1.0, 0.18);
  brass(659.25, 1.08, 1.0, 0.12);
  brass(783.99, 1.08, 1.0, 0.1);
  tone(out, { freq: 130.8, type: 'triangle', t: t + 1.08, dur: 1.0, gain: 0.25, attack: 0.02 });
}

/** Applause: a crowd of random claps over a soft noise bed. */
export function applause(ms = 2600) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const dur = Math.min(8000, Math.max(400, Number(ms) || 2600)) / 1000;
  const out = bus(0.7);
  hiss(out, { t, dur, gain: 0.06, type: 'bandpass', freq: 1800, q: 0.4, attack: Math.min(0.35, dur / 3) });
  const claps = Math.floor(dur * 38);
  for (let i = 0; i < claps; i++) {
    const at = t + Math.pow(Math.random(), 1.25) * dur * 0.95;
    const fade = 1 - (at - t) / dur;
    hiss(out, {
      t: at,
      dur: 0.02 + Math.random() * 0.035,
      gain: (0.08 + Math.random() * 0.18) * (0.35 + 0.65 * fade),
      type: 'bandpass',
      freq: 900 + Math.random() * 1800,
      q: 1.4,
      attack: 0.001,
    });
  }
}

/** Whoosh: swept noise for transitions and the result splash. */
export function whoosh(ms = 650) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const dur = Math.min(3000, Math.max(150, Number(ms) || 650)) / 1000;
  const out = bus(0.7);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.6;
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(2600, t + dur * 0.55);
  f.frequency.exponentialRampToValueAtTime(500, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42, t + dur * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random(), dur + 0.05);
}

/**
 * Snare drumroll that crescendos for `ms`, then a cymbal crash. Returns stop() to cut it short.
 */
export function drumroll(ms = 2000, { crash = true } = {}) {
  if (!ready()) return () => {};
  const t = ctx.currentTime + 0.01;
  const dur = Math.min(10000, Math.max(300, Number(ms) || 2000)) / 1000;
  const out = bus(0.75);
  const step = 0.045;
  for (let at = 0; at < dur; at += step) {
    const p = at / dur;
    const g = 0.05 + 0.22 * p * p;
    hiss(out, { t: t + at, dur: 0.06, gain: g, type: 'highpass', freq: 1400 + Math.random() * 400, q: 0.7, attack: 0.001 });
    tone(out, { freq: 190 + Math.random() * 20, type: 'triangle', t: t + at, dur: 0.035, gain: g * 0.5, attack: 0.001 });
  }
  if (crash) {
    tone(out, { freq: 70, type: 'sine', t: t + dur, dur: 0.4, gain: 0.5, attack: 0.002 });
    hiss(out, { t: t + dur, dur: 1.6, gain: 0.3, type: 'highpass', freq: 4500, q: 0.5, attack: 0.002 });
  }
  return () => {
    try {
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      setTimeout(() => out.disconnect(), 200);
    } catch {
      /* already gone */
    }
  };
}

/** Name -> effect, for fx dispatch: play('correct'). Unknown names are ignored. */
export const EFFECTS = Object.freeze({ tick, land, buzz, correct, wrong, beep, fanfare, applause, whoosh, drumroll });
export function play(name, ...args) {
  const fn = EFFECTS[name];
  return fn ? fn(...args) : undefined;
}
