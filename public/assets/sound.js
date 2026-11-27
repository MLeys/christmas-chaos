// Christmas Chaos — sound.js
// Every sound is synthesised with Web Audio (no files, works offline). Browsers only allow audio after a
// user gesture, so call unlock() from a click/tap (the TV's "Click to start the show" overlay).
// Every effect is a safe no-op before unlock(), when muted, or when Web Audio is missing.
// Midnight Premiere palette (brief A13): sleigh bells and celesta; wooden-clack ticks with a bell overtone;
// celesta + timpani landing; major bell arpeggio for correct; a gentle muted-trombone wah for wrong; a brass
// honk buzz; film-leader beeps; a relay clunk + hum into a fanfare for Double Down; fanfare + choir pad podium.
//
//   import * as sound from '/assets/sound.js';
//   startButton.onclick = () => sound.unlock();
//   wheel.spinTo(i, ms, { onTick: sound.tick });
//   sound.setVolume(0.6); sound.toggleMute();   // persisted in localStorage (cc.volume / cc.muted)
//   const stop = sound.ambience();               // lobby bed; stop() before anything is read aloud

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

/* ------------------------------------------------------------------ instruments -------------- */
// Midnight Premiere palette (brief A13): sleigh bells and celesta, a wooden clack, timpani, warm brass.

/** Struck bell: inharmonic partials, the high ones die first. */
function bell(out, freq, t, { dur = 1.6, gain = 0.16 } = {}) {
  const partials = [
    [1, 1, 1],
    [2.0, 0.42, 0.7],
    [2.76, 0.3, 0.5],
    [5.4, 0.14, 0.28],
    [8.93, 0.06, 0.16],
  ];
  for (const [ratio, amp, life] of partials) {
    if (freq * ratio > 16000) continue;
    tone(out, { freq: freq * ratio, type: 'sine', t, dur: dur * life, gain: gain * amp, attack: 0.002 });
  }
}

/** Celesta: soft hammered sine with a glassy octave and a quick bright tick on the attack. */
function celesta(out, freq, t, { dur = 1.1, gain = 0.16 } = {}) {
  tone(out, { freq, type: 'sine', t, dur, gain, attack: 0.003 });
  tone(out, { freq: freq * 2, type: 'sine', t, dur: dur * 0.55, gain: gain * 0.32, attack: 0.003 });
  tone(out, { freq: freq * 4, type: 'sine', t, dur: dur * 0.18, gain: gain * 0.12, attack: 0.002 });
  tone(out, { freq: freq * 8, type: 'triangle', t, dur: 0.03, gain: gain * 0.1, attack: 0.001 });
}

/** One shake of sleigh bells: a cluster of tiny metallic pings over a bright noise burst. */
function jingle(out, t, gain = 0.1) {
  hiss(out, { t, dur: 0.09, gain: gain * 0.7, type: 'bandpass', freq: 7200, q: 1.2, attack: 0.002 });
  for (let k = 0; k < 5; k++) {
    const f = 2600 + Math.random() * 4400;
    tone(out, { freq: f, type: 'sine', t: t + Math.random() * 0.035, dur: 0.08 + Math.random() * 0.12, gain: gain * (0.35 + Math.random() * 0.4), attack: 0.001 });
  }
}

/** Timpani: a tuned drum with a little pitch drop and a felt thump. */
function timpani(out, t, { freq = 98, gain = 0.5, dur = 1.3 } = {}) {
  tone(out, { freq, to: freq * 0.94, type: 'sine', t, dur, gain, attack: 0.004 });
  tone(out, { freq: freq * 1.5, type: 'sine', t, dur: dur * 0.4, gain: gain * 0.22, attack: 0.004 });
  hiss(out, { t, dur: 0.12, gain: gain * 0.45, type: 'lowpass', freq: 420, q: 0.8, attack: 0.002 });
}

/** Warm brass voice (three slightly detuned saws through a soft low-pass). */
function brass(out, f, t, dur, g = 0.16, { cutoff = 2600 } = {}) {
  [0, 7, -6].forEach((det, k) =>
    tone(out, { freq: f, type: 'sawtooth', t, dur, gain: k ? g * 0.6 : g, attack: 0.03, release: dur, detune: det, filter: cutoff, q: 0.9, vibrato: dur > 0.4 ? 4 : 0 })
  );
}

/* ------------------------------------------------------------------ effects ------------------ */

/** Wheel tick: a wooden clack with a little bell overtone (self-throttled so a fast wheel never machine-guns). */
export function tick() {
  if (!ready()) return;
  const now = ctx.currentTime;
  if (now - lastTick < 0.028) return;
  lastTick = now;
  const out = bus(0.85);
  const p = 1 + (Math.random() - 0.5) * 0.06;
  hiss(out, { t: now, dur: 0.028, gain: 0.3, type: 'bandpass', freq: 1500 * p, q: 3.5, attack: 0.001 });
  tone(out, { freq: 560 * p, to: 380 * p, type: 'triangle', t: now, dur: 0.045, gain: 0.26, attack: 0.001 });
  tone(out, { freq: 2637 * p, type: 'sine', t: now + 0.004, dur: 0.14, gain: 0.045, attack: 0.002 });
}

/** Wheel landing: a timpani hit under a celesta arpeggio and a sleigh-bell shimmer. */
export function land() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.8);
  timpani(out, t, { freq: 98, gain: 0.55 });
  [1046.5, 1318.5, 1568, 2093].forEach((f, k) => celesta(out, f, t + 0.02 + k * 0.06, { dur: 1.2, gain: 0.15 }));
  bell(out, 2093, t + 0.26, { dur: 1.8, gain: 0.07 });
  jingle(out, t + 0.05, 0.07);
}

/** Buzz-in: a short brass honk. */
export function buzz() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const out = bus(0.75);
  const dur = 0.48;
  tone(out, { freq: 225, to: 233, type: 'sawtooth', t, dur, gain: 0.26, attack: 0.012, release: dur, filter: 1900, q: 1.4 });
  tone(out, { freq: 228, to: 236, type: 'sawtooth', t, dur, gain: 0.2, attack: 0.012, release: dur, filter: 1900, q: 1.4, detune: 9 });
  tone(out, { freq: 116.5, type: 'square', t, dur, gain: 0.12, attack: 0.012, release: dur, filter: 700 });
}

/** Correct answer: a rising major bell arpeggio with a jingle on top. */
export function correct() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.8);
  [1046.5, 1318.5, 1568, 2093, 2637].forEach((f, k) => bell(out, f, t + k * 0.075, { dur: k === 4 ? 1.6 : 0.9, gain: 0.13 }));
  jingle(out, t + 0.32, 0.08);
}

/** Wrong answer: a soft muted-trombone "wah-wah" — gentle, never mocking. */
export function wrong() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.6);
  const wah = (freq, at, dur) => {
    const osc = ctx.createOscillator();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq * 1.02, t + at);
    osc.frequency.exponentialRampToValueAtTime(freq, t + at + 0.08);
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(350, t + at);
    f.frequency.exponentialRampToValueAtTime(1300, t + at + dur * 0.35);
    f.frequency.exponentialRampToValueAtTime(380, t + at + dur);
    g.gain.setValueAtTime(0.0001, t + at);
    g.gain.exponentialRampToValueAtTime(0.2, t + at + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
    osc.connect(f).connect(g).connect(out);
    osc.start(t + at);
    osc.stop(t + at + dur + 0.05);
  };
  wah(196, 0, 0.34);
  wah(174.6, 0.36, 0.62);
}

/** Film-leader countdown beep (1 kHz). Pass true for the final, longer beep. */
export function beep(final = false) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const out = bus(0.55);
  tone(out, { freq: 1000, type: 'sine', t, dur: final ? 0.42 : 0.09, gain: 0.3, attack: 0.003 });
  tone(out, { freq: 2000, type: 'sine', t, dur: final ? 0.25 : 0.05, gain: 0.04, attack: 0.003 });
}

/** One film-leader blip for the 3-2-1 steal countdown. */
export function leaderBeep() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const out = bus(0.55);
  tone(out, { freq: 1000, type: 'sine', t, dur: 0.08, gain: 0.32, attack: 0.002 });
  hiss(out, { t, dur: 0.02, gain: 0.05, type: 'highpass', freq: 5000 });
}

/** Brass fanfare: da-da-da DAAA, da-DAAAA, with a bell on the final chord (podium, Double Down). */
export function fanfare() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.02;
  const out = bus(0.7);
  brass(out, 392, t, 0.13);
  brass(out, 392, t + 0.15, 0.13);
  brass(out, 392, t + 0.3, 0.13);
  brass(out, 523.25, t + 0.45, 0.42);
  brass(out, 392, t + 0.92, 0.14);
  brass(out, 523.25, t + 1.08, 1.0, 0.18);
  brass(out, 659.25, t + 1.08, 1.0, 0.12);
  brass(out, 783.99, t + 1.08, 1.0, 0.1);
  timpani(out, t + 1.08, { freq: 65.4, gain: 0.4, dur: 1.4 });
  bell(out, 2093, t + 1.1, { dur: 1.6, gain: 0.06 });
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

/** Whoosh: a soft swept-air pass for transitions (the steam wipe). */
export function whoosh(ms = 650) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const dur = Math.min(3000, Math.max(150, Number(ms) || 650)) / 1000;
  const out = bus(0.6);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.3;
  f.frequency.setValueAtTime(320, t);
  f.frequency.exponentialRampToValueAtTime(2400, t + dur * 0.55);
  f.frequency.exponentialRampToValueAtTime(520, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.36, t + dur * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t, Math.random(), dur + 0.05);
}

/** Steam wipe: a breathier hiss than whoosh (600 ms by default). */
export function steam(ms = 600) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const dur = Math.min(3000, Math.max(150, Number(ms) || 600)) / 1000;
  const out = bus(0.5);
  hiss(out, { t, dur, gain: 0.22, type: 'highpass', freq: 2200, to: 5200, q: 0.5, attack: dur * 0.35 });
  hiss(out, { t, dur: dur * 0.8, gain: 0.12, type: 'bandpass', freq: 900, to: 1600, q: 0.7, attack: dur * 0.3 });
}

/**
 * Drumroll that crescendos for `ms` (snare over a rolling timpani), then a cymbal crash. Returns stop().
 */
export function drumroll(ms = 2000, { crash = true } = {}) {
  if (!ready()) return () => {};
  const t = ctx.currentTime + 0.01;
  const dur = Math.min(10000, Math.max(300, Number(ms) || 2000)) / 1000;
  const out = bus(0.75);
  const step = 0.045;
  for (let at = 0; at < dur; at += step) {
    const p = at / dur;
    const g = 0.05 + 0.2 * p * p;
    hiss(out, { t: t + at, dur: 0.06, gain: g, type: 'highpass', freq: 1400 + Math.random() * 400, q: 0.7, attack: 0.001 });
    if (Math.round(at / step) % 2 === 0) tone(out, { freq: 73.4, type: 'sine', t: t + at, dur: 0.12, gain: 0.04 + 0.18 * p, attack: 0.004 });
  }
  if (crash) {
    timpani(out, t + dur, { freq: 73.4, gain: 0.5, dur: 0.9 });
    hiss(out, { t: t + dur, dur: 1.6, gain: 0.26, type: 'highpass', freq: 4500, q: 0.5, attack: 0.002 });
    jingle(out, t + dur, 0.1);
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

/** The plug-in gag: a relay clunk, then the mains hum swells as the bulbs blaze on. */
export function plugIn() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const out = bus(0.7);
  hiss(out, { t, dur: 0.05, gain: 0.5, type: 'lowpass', freq: 260, q: 0.9, attack: 0.001 });
  tone(out, { freq: 95, to: 60, type: 'sine', t, dur: 0.12, gain: 0.4, attack: 0.001 });
  hiss(out, { t: t + 0.004, dur: 0.012, gain: 0.18, type: 'highpass', freq: 3500 });
  // hum: 60 Hz + harmonics through a low-pass that opens as the lights come up
  const hum = ctx.createGain();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(140, t + 0.08);
  f.frequency.exponentialRampToValueAtTime(900, t + 0.7);
  hum.gain.setValueAtTime(0.0001, t + 0.08);
  hum.gain.exponentialRampToValueAtTime(0.16, t + 0.55);
  hum.gain.setValueAtTime(0.16, t + 0.9);
  hum.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
  f.connect(hum).connect(out);
  for (const [fr, type] of [[60, 'sawtooth'], [120, 'square']]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = fr;
    o.connect(f);
    o.start(t + 0.08);
    o.stop(t + 1.7);
  }
}

/** Double Down: the plug-in clunk and hum straight into the brass fanfare. */
export function doubleDown() {
  if (!ready()) return;
  plugIn();
  setTimeout(fanfare, 760);
}

/** A single bright bell ding (a final wager locks in). */
export function dingLock() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const out = bus(0.7);
  bell(out, 1568, t, { dur: 1.5, gain: 0.18 });
  tone(out, { freq: 3136, type: 'sine', t: t + 0.003, dur: 0.3, gain: 0.03, attack: 0.002 });
}

/** A few seconds of sleigh bells (default 1.4 s). */
export function sleighBells(ms = 1400) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const dur = Math.min(8000, Math.max(200, Number(ms) || 1400)) / 1000;
  const out = bus(0.6);
  for (let at = 0, k = 0; at < dur; at += 0.125, k++) {
    const accent = k % 4 === 0 ? 1 : k % 2 === 0 ? 0.7 : 0.45;
    const fade = at > dur - 0.4 ? (dur - at) / 0.4 : 1;
    jingle(out, t + at + (Math.random() - 0.5) * 0.01, 0.1 * accent * fade);
  }
}

/** Podium: the fanfare over a warm "aah" choir pad. */
export function podium() {
  if (!ready()) return;
  fanfare();
  const t = ctx.currentTime + 1.05;
  const out = bus(0.5);
  const formants = [700, 1150, 2600].map((fr, k) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = fr;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.value = [1, 0.6, 0.18][k];
    bp.connect(g).connect(out);
    return bp;
  });
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.5, t + 0.5);
  amp.gain.setValueAtTime(0.5, t + 2.4);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
  formants.forEach((bp) => amp.connect(bp));
  for (const f of [261.63, 329.63, 392, 523.25]) {
    for (const det of [-8, 0, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 4.6 + Math.random();
      lg.gain.value = 2.5;
      lfo.connect(lg).connect(o.frequency);
      o.connect(amp);
      o.start(t);
      lfo.start(t);
      o.stop(t + 3.7);
      lfo.stop(t + 3.7);
    }
  }
}

/**
 * Ambient bed for the lobby and turn intros: a faint projector hum with an occasional soft sleigh-bell shake.
 * Returns stop(); call it (or duck by stopping) before anything is read aloud.
 */
export function ambience({ level = 0.5 } = {}) {
  if (!ready()) return () => {};
  const out = bus(Math.max(0, Math.min(1, Number(level) || 0.5)) * 0.5);
  const t = ctx.currentTime + 0.05;
  // projector: low motor hum + a 24 fps flutter on filtered noise
  const hum = ctx.createOscillator();
  hum.type = 'sawtooth';
  hum.frequency.value = 50;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 220;
  const hg = ctx.createGain();
  hg.gain.setValueAtTime(0.0001, t);
  hg.gain.exponentialRampToValueAtTime(0.035, t + 1.2);
  hum.connect(lp).connect(hg).connect(out);
  hum.start(t);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.8;
  const flutter = ctx.createGain();
  flutter.gain.value = 0.012;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 24;
  const lg = ctx.createGain();
  lg.gain.value = 0.008;
  lfo.connect(lg).connect(flutter.gain);
  src.connect(bp).connect(flutter).connect(out);
  src.start(t);
  lfo.start(t);
  let alive = true;
  let timer = 0;
  const shake = () => {
    if (!alive || !ready()) return;
    const at = ctx.currentTime + 0.02;
    for (let k = 0; k < 4; k++) jingle(out, at + k * 0.13, 0.05 * (k === 0 ? 1 : 0.6));
    timer = setTimeout(shake, 5000 + Math.random() * 4000);
  };
  timer = setTimeout(shake, 2500);
  return () => {
    if (!alive) return;
    alive = false;
    clearTimeout(timer);
    try {
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      setTimeout(() => {
        try {
          hum.stop();
          src.stop();
          lfo.stop();
        } catch {
          /* already stopped */
        }
        out.disconnect();
      }, 900);
    } catch {
      /* already gone */
    }
  };
}

/** Name -> effect, for fx dispatch: play('correct'). Unknown names are ignored. */
export const EFFECTS = Object.freeze({
  tick, land, buzz, correct, wrong, beep, fanfare, applause, whoosh, drumroll,
  leaderBeep, plugIn, dingLock, doubleDown, podium, sleighBells, steam,
});
export function play(name, ...args) {
  const fn = EFFECTS[name];
  return fn ? fn(...args) : undefined;
}
