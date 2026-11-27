// Christmas Chaos — fx.js
// The comedy kit (docs/design/COMEDY.md §3): short, skippable sight gags built from the 3D art. Every effect
// returns a Promise<boolean> (true = it played, false = nothing to do), never runs longer than 2.5 s, cleans up
// after itself, and becomes a quick fade under reduced motion (the media query or html.reduce-motion).
// Pure ES module: importing it without a DOM is safe (every effect resolves false).
//
//   import * as fx from '/assets/fx.js';
//   fx.bounce(mascotEl);            // cheer: squash-and-stretch hops        (pair with sound.boing)
//   fx.droop(mascotEl);             // sad tilt + slide down, then recovers
//   fx.wobble(el); fx.shake(el);
//   fx.splat(cardEl);               // a snowball hits the card and slides    (sound.splat)
//   fx.coalDrop(cardEl);            // a lump of coal falls, bounces, dust    (sound.slideWhistle — wrong answer)
//   fx.dash('deer');                // a reindeer gallops across the screen   (sound.sleighRun — correct)
//   fx.sneak('money', { from: tagEl });  // the Grinch money bag tiptoes off (sound.kaChing — steal)
//   fx.melt(timerEl);               // the ornament timer melts at 0          (sound.sadTrombone — time up)
//   fx.peek('santa', 'bottom-right', { say: 'Ho ho ho!' });              (sound.hoHoHo)
//   fx.confetti();                  // snow + gold                            (sound.sleighBells / fanfare)
//   fx.heartGrow(el);               // the Grinch's heart grows three sizes   (sound.boing)
//   fx.play('dash', 'deer');        // by name (for server 'react' fx)
//   fx.setScale('root');            // TV: sprite sizes follow the scaled root font (same look at 720p and 4K)
//
// Element effects use CSS classes from tokens.css (.fx-bounce …); overlay effects animate sprites in a fixed
// .fx-layer with the Web Animations API, styled by .fx-* classes in tokens.css. Nothing here plays sound.

import { artSrc } from './icons.js';

export const MAX_MS = 2500;

const hasDOM = () => typeof document !== 'undefined' && !!document.body;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vw = () => globalThis.innerWidth || 1920;
const vh = () => globalThis.innerHeight || 1080;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let scaleOpt = 1;
/**
 * Scale every sprite's size limits (they are authored in px for a 16 px root). Pass a number, or 'root' to follow the
 * root font size (the TV scales its root with the viewport: 10.67 px at 1280×720, 32 px at 4K), so gags keep the same
 * proportions on every TV. Phones and the host keep 1.
 * @param {number|'root'} v
 */
export function setScale(v) {
  scaleOpt = v === 'root' ? 'root' : Number(v) > 0 ? Number(v) : 1;
}
/** The current sprite scale (1 = authored px). */
export function getScale() {
  if (scaleOpt !== 'root') return scaleOpt;
  try {
    const fs = parseFloat(globalThis.getComputedStyle(document.documentElement).fontSize);
    return fs > 0 ? fs / 16 : 1;
  } catch {
    return 1;
  }
}
/** clamp() with the px limits scaled by getScale(). */
const clampS = (v, a, b) => {
  const k = getScale();
  return clamp(v, a * k, b * k);
};

/** True when motion should be replaced by a quick fade. */
export function reducedMotion() {
  try {
    if (hasDOM() && document.documentElement.classList.contains('reduce-motion')) return true;
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function layer() {
  let l = document.getElementById('cc-fx-layer');
  if (!l) {
    l = document.createElement('div');
    l.id = 'cc-fx-layer';
    l.className = 'fx-layer';
    l.setAttribute('aria-hidden', 'true');
    document.body.appendChild(l);
  }
  return l;
}

function rectOf(el) {
  const r = el?.getBoundingClientRect?.();
  if (r && r.width + r.height > 0) return r;
  const w = Math.min(vw(), vh()) * 0.3;
  return { left: (vw() - w) / 2, top: (vh() - w) / 2, width: w, height: w, right: (vw() + w) / 2, bottom: (vh() + w) / 2 };
}

/** A positioned sprite in the fx layer (art = a 3D art id, or none for CSS-drawn sprites). */
function sprite({ cls = '', art, w, h, x = 0, y = 0, html = '' }) {
  const s = document.createElement('span');
  s.className = `fx-sprite ${cls}`.trim();
  s.style.width = `${Math.round(w)}px`;
  s.style.height = `${Math.round(h ?? w)}px`;
  s.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  if (art) {
    const img = document.createElement('img');
    img.src = artSrc(art);
    img.alt = '';
    img.decoding = 'async';
    s.appendChild(img);
  } else if (html) {
    s.innerHTML = html;
  }
  layer().appendChild(s);
  return s;
}

/** Web Animations helper; resolves when finished (or immediately when WAAPI is missing). */
function anim(el, frames, opts) {
  if (!el?.animate) return Promise.resolve();
  try {
    const a = el.animate(frames, { fill: 'forwards', ...opts });
    return a.finished.then(() => {}, () => {});
  } catch {
    return Promise.resolve();
  }
}

const tr = (x, y, extra = '') => `translate(${Math.round(x)}px, ${Math.round(y)}px) ${extra}`.trim();

/** Run a tokens.css animation class on an element; resolves on animationend (or a safety timeout). */
function playClass(el, cls, ms, { keep = false } = {}) {
  if (!hasDOM() || !el?.classList) return Promise.resolve(false);
  if (reducedMotion()) return fadeEl(el);
  el.classList.remove(cls);
  void el.offsetWidth; // restart the animation
  el.classList.add(cls);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('animationend', onEnd);
      if (!keep) el.classList.remove(cls);
      resolve(true);
    };
    const onEnd = (e) => {
      if (e.target === el) finish();
    };
    el.addEventListener('animationend', onEnd);
    setTimeout(finish, Math.min(MAX_MS, ms) + 120);
  });
}

/** Reduced-motion stand-in: a 220 ms fade-up on the element. */
function fadeEl(el) {
  if (!el?.classList) return Promise.resolve(false);
  el.classList.remove('fx-fade');
  void el.offsetWidth;
  el.classList.add('fx-fade');
  return wait(240).then(() => {
    el.classList.remove('fx-fade');
    return true;
  });
}

/** Reduced-motion stand-in for overlay gags: the art fades in and out where it would have ended up. */
async function fadeSprite(art, x, y, size) {
  const s = sprite({ art, w: size, x, y });
  s.style.opacity = '0';
  await anim(s, [{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 420 });
  s.remove();
  return true;
}

/* ------------------------------------------------------------------ element gags ------------- */

/** Mascot cheer: squash-and-stretch hops (900 ms). */
export function bounce(el) {
  return playClass(el, 'fx-bounce', 900);
}

/** Sad tilt + slide down, then it recovers (1.6 s). */
export function droop(el) {
  return playClass(el, 'fx-droop', 1600);
}

/** A decaying wobble (800 ms). */
export function wobble(el) {
  return playClass(el, 'fx-wobble', 800);
}

/** A quick head-shake (500 ms). */
export function shake(el) {
  return playClass(el, 'fx-shake', 500);
}

/**
 * The ornament timer melts at 0: it squishes and slumps while red drips fall off it (2 s). The element keeps its
 * melted look (class .fx-melt) until you re-render it or remove the class.
 */
export async function melt(timerEl) {
  if (!hasDOM() || !timerEl) return false;
  if (reducedMotion()) return fadeEl(timerEl);
  const r = rectOf(timerEl);
  const drips = [0.32, 0.55, 0.72].map((fx, k) => {
    const w = clampS(r.width * 0.09, 8, 22);
    const d = sprite({ cls: 'fx-drip', w, h: w * 1.4, x: r.left + r.width * fx - w / 2, y: r.top + r.height * 0.86 });
    d.style.opacity = '0';
    return anim(d, [
      { transform: tr(r.left + r.width * fx - w / 2, r.top + r.height * 0.84, 'scaleY(.6)'), opacity: 0 },
      { transform: tr(r.left + r.width * fx - w / 2, r.top + r.height * 0.9, 'scaleY(1.1)'), opacity: 1, offset: 0.25 },
      { transform: tr(r.left + r.width * fx - w / 2, r.top + r.height * 1.6 + k * 20, 'scaleY(1.6)'), opacity: 0 },
    ], { duration: 1100, delay: 500 + k * 260, easing: 'cubic-bezier(.5,0,.9,.6)' }).then(() => d.remove());
  });
  await Promise.all([playClass(timerEl, 'fx-melt', 2000, { keep: true }), ...drips]);
  return true;
}

/* ------------------------------------------------------------------ overlay gags ------------- */

/**
 * A snowball flies in, splats on the target, the target shakes and the splat slides down (≈2 s).
 * @param {Element} targetEl
 * @param {{at?:[number, number]}} [o] where it hits, as fractions of the target (default the middle, [.5, .42]);
 *   aim at an empty corner (e.g. [.84, .18]) so the splat never sits on text people are reading
 */
export async function splat(targetEl, { at = [0.5, 0.42] } = {}) {
  if (!hasDOM()) return false;
  const r = rectOf(targetEl);
  if (reducedMotion()) return targetEl ? fadeEl(targetEl) : false;
  const size = clampS(Math.min(r.width, r.height) * 0.3, 56, 150);
  const cx = r.left + r.width * at[0];
  const cy = r.top + r.height * at[1];
  const sx = -size;
  const sy = vh() * 0.78;
  const ball = sprite({ cls: 'fx-snowball', w: size, x: sx, y: sy });
  await anim(ball, [
    { transform: tr(sx, sy, 'rotate(0deg)') },
    { transform: tr((sx + cx) / 2 - size / 2, Math.min(sy, cy) - vh() * 0.22, 'rotate(220deg)'), offset: 0.5 },
    { transform: tr(cx - size / 2, cy - size / 2, 'rotate(400deg)') },
  ], { duration: 460, easing: 'cubic-bezier(.3,.1,.6,1)' });
  ball.remove();
  const m = size * 1.7;
  const mark = sprite({ cls: 'fx-splat-mark', w: m, h: m * 0.86, x: cx - m / 2, y: cy - m * 0.43 });
  if (targetEl) shake(targetEl);
  await anim(mark, [
    { transform: tr(cx - m / 2, cy - m * 0.43, 'scale(.3)'), opacity: 1 },
    { transform: tr(cx - m / 2, cy - m * 0.43, 'scale(1.15, .9)'), offset: 0.08 },
    { transform: tr(cx - m / 2, cy - m * 0.43, 'scale(1)'), offset: 0.16 },
    { transform: tr(cx - m / 2, cy - m * 0.43 + 6, 'scale(1, 1.04)'), offset: 0.5, opacity: 1 },
    { transform: tr(cx - m / 2, cy - m * 0.43 + r.height * 0.35, 'scale(.92, 1.25)'), opacity: 0 },
  ], { duration: 1500, easing: 'cubic-bezier(.45,0,.8,.6)' });
  mark.remove();
  return true;
}

/**
 * A lump of coal drops onto the target, bounces twice and puffs dust (≈1.9 s).
 * @param {Element} targetEl
 * @param {{at?:[number, number]}} [o] where it lands, as fractions of the target (default [.5, .62]); [.84, 0] lands it
 *   on the card's top edge, clear of the text
 */
export async function coalDrop(targetEl, { at = [0.5, 0.62] } = {}) {
  if (!hasDOM()) return false;
  const r = rectOf(targetEl);
  const size = clampS(r.width * 0.16, 56, 120);
  const x = r.left + r.width * at[0] - size / 2;
  const land = r.top + r.height * at[1] - size / 2;
  if (reducedMotion()) {
    const c = sprite({ cls: 'fx-coal', w: size, h: size * 0.8, x, y: land });
    await anim(c, [{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 420 });
    c.remove();
    return true;
  }
  const coal = sprite({ cls: 'fx-coal', w: size, h: size * 0.8, x, y: -size });
  await anim(coal, [
    { transform: tr(x, -size * 1.2, 'rotate(-20deg)'), easing: 'cubic-bezier(.55,0,1,.45)' },
    { transform: tr(x, land, 'rotate(10deg) scale(1.12,.84)'), offset: 0.42, easing: 'cubic-bezier(0,.55,.45,1)' },
    { transform: tr(x + size * 0.12, land - size * 0.9, 'rotate(28deg)'), offset: 0.6, easing: 'cubic-bezier(.55,0,1,.45)' },
    { transform: tr(x + size * 0.2, land, 'rotate(40deg) scale(1.06,.9)'), offset: 0.75, easing: 'cubic-bezier(0,.55,.45,1)' },
    { transform: tr(x + size * 0.26, land - size * 0.28, 'rotate(46deg)'), offset: 0.85, easing: 'cubic-bezier(.55,0,1,.45)' },
    { transform: tr(x + size * 0.3, land, 'rotate(50deg)') },
  ], { duration: 1050 });
  const puffs = [-1, 1].map((dir) => {
    const p = sprite({ cls: 'fx-dust', w: size * 0.9, x: x + size * 0.05, y: land + size * 0.2 });
    return anim(p, [
      { transform: tr(x + size * 0.05, land + size * 0.2, 'scale(.3)'), opacity: 0.9 },
      { transform: tr(x + size * 0.05 + dir * size * 0.9, land + size * 0.05, 'scale(1.4)'), opacity: 0 },
    ], { duration: 620, easing: 'ease-out' }).then(() => p.remove());
  });
  await Promise.all(puffs);
  await anim(coal, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 120 });
  coal.remove();
  return true;
}

/**
 * A 3D character gallops across the screen (default the reindeer, 1.8 s) with a little sparkle trail.
 * @param {string} [art='deer']
 * @param {{direction?:'ltr'|'rtl', y?:number, size?:number, duration?:number}} [o] y = 0..1 of the viewport height
 */
export async function dash(art = 'deer', { direction = 'ltr', y = 0.6, size, duration = 1800 } = {}) {
  if (!hasDOM()) return false;
  const s = size || clampS(vh() * 0.24, 120, 320);
  const top = vh() * clamp(y, 0, 1) - s / 2;
  if (reducedMotion()) return fadeSprite(art, (vw() - s) / 2, top, s);
  const ltr = direction !== 'rtl';
  const flip = ltr ? 'scaleX(-1)' : ''; // the Fluent deer faces left
  const x0 = ltr ? -s : vw();
  const x1 = ltr ? vw() : -s;
  const el = sprite({ art, w: s, x: x0, y: top });
  const frames = [];
  const steps = 10;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const hop = k % 2 ? -s * 0.12 : 0;
    frames.push({ transform: tr(x0 + (x1 - x0) * t, top + hop, `${flip} rotate(${k % 2 ? (ltr ? 6 : -6) : 0}deg)`), offset: t });
  }
  const trail = [0.25, 0.45, 0.65].map((t, k) =>
    wait(Math.min(MAX_MS, duration) * t).then(() => {
      const sp = sprite({ art: 'sparkles', w: s * 0.28, x: x0 + (x1 - x0) * t + (ltr ? 0 : s * 0.7), y: top + s * 0.55 });
      return anim(sp, [{ opacity: 1, transform: tr(x0 + (x1 - x0) * t + (ltr ? 0 : s * 0.7), top + s * 0.55, 'scale(.6)') }, { opacity: 0, transform: tr(x0 + (x1 - x0) * t + (ltr ? 0 : s * 0.7), top + s * 0.4 - k * 10, 'scale(1.1)') }], { duration: 700 }).then(() => sp.remove());
    })
  );
  await Promise.all([anim(el, frames, { duration: Math.min(MAX_MS - 300, duration), easing: 'linear' }), ...trail]);
  el.remove();
  return true;
}

/**
 * Something tiptoes off-screen, hop… pause… hop (default the Grinch's money bag, 2.2 s).
 * @param {string} [art='money']
 * @param {{from?:Element, direction?:'ltr'|'rtl', size?:number}} [o] from = where it starts (default bottom centre)
 */
export async function sneak(art = 'money', { from, direction = 'ltr', size } = {}) {
  if (!hasDOM()) return false;
  const r = from ? rectOf(from) : { left: vw() / 2 - 60, top: vh() * 0.7, width: 120, height: 120 };
  const s = size || clampS(Math.min(r.width, r.height) * 0.9, 72, 200);
  const x0 = r.left + r.width / 2 - s / 2;
  const y0 = r.top + r.height / 2 - s / 2;
  if (reducedMotion()) return fadeSprite(art, x0, y0, s);
  const ltr = direction !== 'rtl';
  const x1 = ltr ? vw() + s : -s * 2;
  const el = sprite({ art, w: s, x: x0, y: y0 });
  const lean = ltr ? 8 : -8;
  const frames = [{ transform: tr(x0, y0, 'rotate(0deg)'), offset: 0 }, { transform: tr(x0, y0 + s * 0.04, `rotate(${-lean}deg) scale(1.05,.95)`), offset: 0.08 }];
  const hops = 6;
  for (let k = 1; k <= hops; k++) {
    const t0 = 0.08 + ((k - 1) / hops) * 0.86;
    const t1 = 0.08 + (k / hops) * 0.86;
    const ease = Math.pow(k / hops, 1.6);
    const xa = x0 + (x1 - x0) * Math.pow((k - 1) / hops, 1.6);
    const xb = x0 + (x1 - x0) * ease;
    frames.push({ transform: tr((xa + xb) / 2, y0 - s * 0.16, `rotate(${lean}deg)`), offset: t0 + (t1 - t0) * 0.35 });
    frames.push({ transform: tr(xb, y0, `rotate(${lean / 2}deg) scale(1.04,.96)`), offset: t0 + (t1 - t0) * 0.7 });
    frames.push({ transform: tr(xb, y0, `rotate(${lean / 2}deg)`), offset: t1 });
  }
  frames[frames.length - 1].offset = 1;
  await anim(el, frames, { duration: 2200, easing: 'ease-in-out' });
  el.remove();
  return true;
}

const BUBBLE_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Santa (or anyone) peeks in from a corner, winks, says a line and ducks out again (2.4 s).
 * @param {string} [art='santa']
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [corner='bottom-right']
 * @param {{say?:string, size?:number}} [o]
 */
export async function peek(art = 'santa', corner = 'bottom-right', { say = 'Ho ho ho!', size } = {}) {
  if (!hasDOM()) return false;
  const s = size || clampS(vh() * 0.26, 120, 340);
  const right = !String(corner).includes('left');
  const bottom = !String(corner).includes('top');
  const xIn = right ? vw() - s * 0.82 : -s * 0.18;
  const yIn = bottom ? vh() - s * 0.78 : -s * 0.22;
  const xOut = right ? vw() + s * 0.1 : -s * 1.1;
  const yOut = bottom ? vh() + s * 0.1 : -s * 1.1;
  if (reducedMotion()) return fadeSprite(art, xIn, yIn, s);
  const tilt = (right ? -1 : 1) * (bottom ? 1 : -1) * 16;
  const el = sprite({ art, w: s, x: xOut, y: yOut });
  const bubble = say
    ? sprite({ cls: 'fx-bubble', w: 0, h: 0, x: right ? xIn - s * 0.55 : xIn + s * 0.7, y: bottom ? yIn - s * 0.05 : yIn + s * 0.9, html: String(say).replace(/[&<>"']/g, (c) => BUBBLE_ESC[c]) })
    : null;
  if (bubble) {
    bubble.style.width = 'auto';
    bubble.style.height = 'auto';
    bubble.style.opacity = '0';
  }
  const at = (x, y, extra) => ({ transform: tr(x, y, extra) });
  const run = anim(el, [
    { ...at(xOut, yOut, `rotate(${tilt}deg)`), offset: 0 },
    { ...at(xIn, yIn, `rotate(${tilt}deg)`), offset: 0.22, easing: 'cubic-bezier(.2,1.4,.5,1)' },
    { ...at(xIn, yIn, `rotate(${tilt * 0.6}deg)`), offset: 0.4 },
    { ...at(xIn, yIn + s * 0.02, `rotate(${tilt * 0.6}deg) scale(1.04,.92)`), offset: 0.46 },  // the wink
    { ...at(xIn, yIn, `rotate(${tilt * 0.6}deg)`), offset: 0.52 },
    { ...at(xIn, yIn + s * 0.02, `rotate(${tilt * 0.6}deg) scale(1.04,.92)`), offset: 0.58 },
    { ...at(xIn, yIn, `rotate(${tilt}deg)`), offset: 0.78 },
    { ...at(xOut, yOut, `rotate(${tilt}deg)`), offset: 1 },
  ], { duration: 2400, easing: 'ease-in-out' });
  const talk = bubble
    ? anim(bubble, [
        { opacity: 0, transform: `${bubble.style.transform} scale(.4)`, offset: 0 },
        { opacity: 0, transform: `${bubble.style.transform} scale(.4)`, offset: 0.3 },
        { opacity: 1, transform: `${bubble.style.transform} scale(1.08)`, offset: 0.38 },
        { opacity: 1, transform: `${bubble.style.transform} scale(1)`, offset: 0.44 },
        { opacity: 1, transform: `${bubble.style.transform} scale(1)`, offset: 0.72 },
        { opacity: 0, transform: `${bubble.style.transform} scale(.8)`, offset: 0.8 },
        { opacity: 0, offset: 1 },
      ], { duration: 2400 })
    : Promise.resolve();
  await Promise.all([run, talk]);
  el.remove();
  bubble?.remove();
  return true;
}

const CONFETTI = ['#EDB321', '#FFE38A', '#D42A2A', '#1F7A4A', '#C48A0A'];

/**
 * Snow + gold confetti falling over the whole screen (≈2.4 s).
 * @param {{count?:number, colors?:string[], snow?:number, duration?:number}} [o] snow = share of snowflakes (0..1)
 */
export async function confetti({ count = 90, colors = CONFETTI, snow = 0.4, duration = 2300 } = {}) {
  if (!hasDOM() || reducedMotion()) return false;
  const n = clamp(Math.trunc(count) || 90, 1, 220);
  const W = vw();
  const H = vh();
  const k = getScale();
  const runs = [];
  for (let i = 0; i < n; i++) {
    const flake = Math.random() < snow;
    const w = (flake ? 6 + Math.random() * 10 : 8 + Math.random() * 8) * k;
    const h = flake ? w : w * (1.6 + Math.random());
    const x = Math.random() * W;
    const el = sprite({ cls: `fx-confetti${flake ? ' is-flake' : ''}`, w, h, x, y: -40 });
    el.style.background = flake ? (Math.random() < 0.5 ? '#FFFFFF' : '#CFE0F3') : colors[i % colors.length];
    if (flake) el.style.boxShadow = '0 0 0 1px rgba(169,195,226,.6)';
    const delay = Math.random() * 200;
    const d = Math.min(MAX_MS - 150 - delay, duration * (0.7 + Math.random() * 0.3));
    const drift = (Math.random() - 0.5) * 220 * k;
    const spin = (Math.random() - 0.5) * 900;
    runs.push(
      anim(el, [
        { transform: tr(x, -40 - Math.random() * 120, 'rotate(0deg)'), opacity: 1 },
        { transform: tr(x + drift * 0.5, H * 0.5, `rotate(${spin / 2}deg)`), opacity: 1, offset: 0.55 },
        { transform: tr(x + drift, H + 40, `rotate(${spin}deg)`), opacity: 0.85 },
      ], { duration: d, delay, easing: 'cubic-bezier(.25,.4,.6,1)' }).then(() => el.remove())
    );
  }
  await Promise.all(runs);
  return true;
}

const HEART = '<svg viewBox="0 0 24 22" width="100%" height="100%"><path d="M12 21.4 10.6 20C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.6 11.5z" fill="#D42A2A"/><path d="M7.2 5.6c-1.6.2-2.8 1.5-2.9 3.1" stroke="#fff" stroke-opacity=".6" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>';

/** The Grinch's heart grows three sizes: a red heart over the element beats bigger three times (2.3 s). */
export async function heartGrow(el) {
  if (!hasDOM()) return false;
  const r = rectOf(el);
  const s = clampS(Math.min(r.width, r.height) * 0.28, 48, 180);
  const x = r.left + r.width / 2 - s / 2;
  const y = r.top + r.height / 2 - s / 2;
  const h = sprite({ cls: 'fx-heart', w: s, h: s * 0.92, x, y, html: HEART });
  const at = (k, o) => ({ transform: tr(x, y, `scale(${k})`), opacity: o ?? 1 });
  if (reducedMotion()) {
    await anim(h, [{ ...at(1.6, 0) }, { ...at(1.6, 1), offset: 0.4 }, { ...at(1.6, 0) }], { duration: 420 });
    h.remove();
    return true;
  }
  await anim(h, [
    { ...at(0.3, 0), offset: 0 },
    { ...at(1, 1), offset: 0.12, easing: 'cubic-bezier(.2,1.6,.5,1)' },
    { ...at(0.92), offset: 0.22 },
    { ...at(1.45), offset: 0.3, easing: 'cubic-bezier(.2,1.6,.5,1)' },
    { ...at(1.35), offset: 0.42 },
    { ...at(1.95), offset: 0.5, easing: 'cubic-bezier(.2,1.6,.5,1)' },
    { ...at(1.85), offset: 0.62 },
    { ...at(2.6), offset: 0.72, easing: 'cubic-bezier(.2,1.6,.5,1)' },
    { ...at(2.5), offset: 0.86 },
    { ...at(2.7, 0), offset: 1 },
  ], { duration: 2300 });
  h.remove();
  return true;
}

/** Name -> effect (for the server's {type:'react', mood} cues or a sound-board). */
export const FX = Object.freeze({ bounce, droop, wobble, shake, splat, coalDrop, dash, sneak, melt, peek, confetti, heartGrow });
export const EFFECT_NAMES = Object.freeze(Object.keys(FX));

/** Play an effect by name: play('dash', 'deer'). Unknown names resolve false. */
export function play(name, ...args) {
  const fn = FX[name];
  return fn ? fn(...args) : Promise.resolve(false);
}
