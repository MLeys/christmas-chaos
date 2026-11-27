// Christmas Chaos — sky.js
// Ambient pieces of the Midnight Premiere look (docs/design/MIDNIGHT-PREMIERE.md):
//
//   const snow = snowfall(document.body, { count: 50, avoid: ['.question-card'] }); // flakes in the margins only
//   starfield(stageEl, { count: 30 });                                              // static sparkles, top third
//   el.innerHTML = bulbString({ count: 16 });            // warm bulbs on a wire (add .is-chase / .is-flash …)
//   el.innerHTML = `<div class="marquee is-chase">${marqueeBulbs()}<span class="marquee__eyebrow">Now showing</span>
//                   ${letterboard('Team Rudolph')}</div>`;
//
// Markup helpers return plain strings built from escaped parts; wrap them in raw() inside client.js h``.
// Everything is cheap: CSS animations on a handful of classes, no per-frame JS. Reduced motion (the media
// query or html.reduce-motion) hides the snow and leaves every bulb lit and still (tokens.css).

import { ICONS } from './icons.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
const r2 = (v) => Math.round(v * 100) / 100;
const hasDOM = () => typeof document !== 'undefined';

/** Small deterministic PRNG (mulberry32) so layouts are stable between renders. */
export function rng(seed = 1225) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function prefersReducedMotion() {
  try {
    if (hasDOM() && document.documentElement.classList.contains('reduce-motion')) return true;
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ snow ---------------------- */

/**
 * Allowed horizontal lanes (in % of the container width) after removing the columns covered by `avoid`
 * rectangles. Pure — exported for tests. `blocked` = [[x0, x1], …] in %.
 */
export function freeLanes(lanes = [[0, 100]], blocked = []) {
  let out = lanes.map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(100, Math.max(a, b))]).filter(([a, b]) => b - a > 0.5);
  for (const [b0, b1] of blocked) {
    const next = [];
    for (const [a, b] of out) {
      if (b1 <= a || b0 >= b) next.push([a, b]);
      else {
        if (b0 > a) next.push([a, b0]);
        if (b1 < b) next.push([b1, b]);
      }
    }
    out = next.filter(([a, b]) => b - a > 0.5);
  }
  return out;
}

/** Pick an x (in %) uniformly across the lanes. */
function pickX(lanes, rand) {
  const total = lanes.reduce((n, [a, b]) => n + (b - a), 0);
  let t = rand() * total;
  for (const [a, b] of lanes) {
    if (t <= b - a) return a + t;
    t -= b - a;
  }
  return lanes.length ? lanes[0][0] : 50;
}

/**
 * Snowfall behind the content of `container` (which should be a .night-sky or otherwise a stacking context).
 * 40–60 soft round flakes (2–6 px, opacity .3–.7, slow parallax) and about 1 in 10 a Lucide snowflake (14–20 px).
 * @param {Element} container
 * @param {{count?:number, seed?:number, lanes?:number[][], avoid?:(Element|string)[], margin?:number,
 *          flakeEvery?:number, speed?:number}} [opts]
 *   lanes: x-ranges in % where snow may fall (default the full width).
 *   avoid: elements or selectors whose columns (plus `margin` %) stay clear — the reading column.
 *   speed: 1 = brief default (a flake crosses the screen in ~16–30 s).
 * @returns {{el:HTMLElement|null, refresh:() => void, destroy:() => void}}
 */
export function snowfall(container, opts = {}) {
  const noop = { el: null, refresh() {}, destroy() {} };
  if (!hasDOM() || !container) return noop;
  const { count = 50, seed = 1225, lanes = [[0, 100]], avoid = [], margin = 2.5, flakeEvery = 10, speed = 1 } = opts;
  const layer = document.createElement('div');
  layer.className = 'snowfall';
  layer.setAttribute('aria-hidden', 'true');
  container.prepend(layer);

  const flakeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="#E6ECF7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.snowflake}</svg>`;

  function blockedColumns() {
    const box = container.getBoundingClientRect();
    if (!box.width) return [];
    const els = avoid.flatMap((a) => (typeof a === 'string' ? [...container.querySelectorAll(a)] : a ? [a] : []));
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return [((r.left - box.left) / box.width) * 100 - margin, ((r.right - box.left) / box.width) * 100 + margin];
    });
  }

  function build() {
    const rand = rng(seed);
    const free = freeLanes(lanes, blockedColumns());
    const parts = [];
    if (free.length) {
      for (let i = 1; i <= count; i++) {
        const x = r2(pickX(free, rand));
        const isFlake = flakeEvery > 0 && i % flakeEvery === 5;
        const px = isFlake ? 14 + Math.round(rand() * 6) : 2 + Math.round(rand() * 4);
        const depth = (px - 2) / 18; // 0 = far, 1 = near
        const o = isFlake ? 0.35 + rand() * 0.25 : 0.3 + rand() * 0.4;
        const dur = (30 - (isFlake ? 0.55 : depth * 2.2) * 12 + rand() * 4) / Math.max(0.2, speed);
        const drift = (rand() - 0.5) * 3;
        const sway = (rand() - 0.5) * 2.5;
        const style = [
          `--x:${x}%`,
          `--s:${r2(px / 16)}rem`,
          `--o:${o.toFixed(2)}`,
          `--dur:${dur.toFixed(1)}s`,
          `--delay:${(-rand() * dur).toFixed(1)}s`,
          `--drift:${drift.toFixed(2)}rem`,
          `--sway:${sway.toFixed(2)}rem`,
          `--y0:${Math.round(rand() * 100)}cqh`,
          !isFlake && px >= 5 ? '--blur:blur(0.6px)' : '',
        ].filter(Boolean).join(';');
        parts.push(isFlake ? `<i class="is-flake" style="${style}">${flakeSvg}</i>` : `<i style="${style}"></i>`);
      }
    }
    layer.innerHTML = parts.join('');
    layer.classList.toggle('is-static', prefersReducedMotion());
  }

  let raf = 0;
  const onResize = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(build);
  };
  build();
  globalThis.addEventListener?.('resize', onResize);
  return {
    el: layer,
    refresh: build,
    destroy() {
      globalThis.removeEventListener?.('resize', onResize);
      cancelAnimationFrame(raf);
      layer.remove();
    },
  };
}

/* ------------------------------------------------------------------ stars --------------------- */

const SPARKLE = ICONS.sparkle;

/**
 * Static field of tiny 4-point sparkles at ~6 % in the top third, one or two twinkling (brief A1).
 * @param {Element} container
 * @param {{count?:number, seed?:number, twinkle?:number, lanes?:number[][]}} [opts]
 * @returns {HTMLElement|null}
 */
export function starfield(container, opts = {}) {
  if (!hasDOM() || !container) return null;
  const el = document.createElement('div');
  el.className = 'starfield';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = starfieldMarkup(opts);
  container.prepend(el);
  return el;
}

/** Inner markup of a star field (absolutely positioned sparkles, % coordinates). */
export function starfieldMarkup({ count = 30, seed = 2412, twinkle = 2, lanes = [[0, 100]] } = {}) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = r2(pickX(lanes, rand));
    const y = r2(rand() * 100);
    const tw = i < twinkle;
    const px = tw ? 14 : 5 + Math.round(rand() * 5);
    const o = tw ? 0.75 : 0.1 + rand() * 0.14;
    const glow = tw ? ';filter:drop-shadow(0 0 4px rgba(255,230,168,.9))' : '';
    out.push(
      `<svg class="${tw ? 'is-twinkle' : ''}" viewBox="0 0 24 24" style="position:absolute;left:${x}%;top:${y}%;width:${r2(px / 16)}rem;height:${r2(px / 16)}rem;opacity:${o.toFixed(2)}${glow}">${SPARKLE.replace('<path', '<path fill="#FFF7EA" stroke="none"')}</svg>`
    );
  }
  return out.join('');
}

/* ------------------------------------------------------------------ bulbs --------------------- */

/**
 * A string of warm bulbs hanging from a wire (16 under the TV top bar). Phases p0/p1/p2 drive the 3-phase chase.
 * Add .is-chase, .is-flash, .is-off or .is-plugin to the returned .bulb-string to animate it; .bulb-string--c9
 * makes multicolour C9 bulbs (Double Down).
 * @param {{count?:number, className?:string}} [opts]
 */
export function bulbString({ count = 16, className = '' } = {}) {
  const n = Math.max(2, Math.min(64, Math.trunc(Number(count) || 16)));
  const W = n * 100;
  let d = `M-40 2 Q5 14 50 8`;
  for (let k = 1; k < n; k++) d += ` Q${k * 100} 24 ${k * 100 + 50} 8`;
  d += ` Q${W - 5} 14 ${W + 40} 2`;
  const bulbs = Array.from({ length: n }, (_, k) => `<i class="bulb-string__bulb p${k % 3}"></i>`).join('');
  return (
    `<div class="bulb-string${className ? ' ' + esc(className) : ''}" aria-hidden="true">` +
    `<svg class="bulb-string__wire" viewBox="0 0 ${W} 20" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="rgba(195,205,230,.34)" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>` +
    `${bulbs}</div>`
  );
}

/**
 * Bulbs ringing a .marquee box, clockwise from the top-left corner, as % positions (any box size works).
 * @param {{cols?:number, rows?:number}} [opts] cols = bulbs along the top and bottom, rows = along each side (no corners)
 */
export function marqueeBulbs({ cols = 10, rows = 4 } = {}) {
  const c = Math.max(2, Math.trunc(cols));
  const r = Math.max(0, Math.trunc(rows));
  const pts = [];
  for (let k = 0; k < c; k++) pts.push([(k / (c - 1)) * 100, 0]);
  for (let j = 1; j <= r; j++) pts.push([100, (j / (r + 1)) * 100]);
  for (let k = c - 1; k >= 0; k--) pts.push([(k / (c - 1)) * 100, 100]);
  for (let j = r; j >= 1; j--) pts.push([0, (j / (r + 1)) * 100]);
  const bulbs = pts.map(([x, y], i) => `<i class="p${i % 3}" style="--x:${r2(x)}%;--y:${r2(y)}%"></i>`).join('');
  return `<span class="marquee__bulbs" aria-hidden="true">${bulbs}</span>`;
}

/**
 * Ivory letterboard: the text drops in one letter every 40 ms (CSS). Screen readers get the plain text.
 * @param {string} text
 * @param {{className?:string, delay?:number}} [opts] delay = letters to wait before the first one drops
 */
export function letterboard(text, { className = '', delay = 0 } = {}) {
  const words = String(text ?? '').toUpperCase().trim().split(/\s+/).filter(Boolean);
  let i = Math.max(0, Math.trunc(Number(delay) || 0));
  const html = words
    .map((w) => `<span class="letterboard__word">${[...w].map((ch) => `<span class="letterboard__char" style="--i:${i++}">${esc(ch)}</span>`).join('')}</span>`)
    .join('');
  return `<span class="letterboard${className ? ' ' + esc(className) : ''}"><span class="sr-only">${esc(text)}</span><span class="letterboard__words" aria-hidden="true" style="display:contents">${html}</span></span>`;
}
