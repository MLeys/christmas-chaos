// Christmas Chaos — sky.js
// Ambient pieces of the North Pole Workshop look (docs/design/NORTH-POLE.md §4, NORTH-POLE-API.md):
//
//   const lights = garland(topEl, { size: 'tv' });       // swagged pine rope + C9 bulbs, any width
//   lights.chase(0.6); lights.flash(); lights.blink('#1F9D57'); lights.twinkle();
//   createWheel(svg, segs, { lights });                   // the bulbs chase with the wheel
//   const snow = snowfall(stageEl, { avoid: ['.gift-tag'] }); // pale-blue flakes, never over the reading column
//   el.insertAdjacentHTML('beforeend', snowbank());       // the two-layer snow hills along the bottom
//   starfield(nightEl, { count: 30 });                    // Christmas Eve only (Final Chaos): static sparkles
//
// Markup helpers return plain strings built from escaped parts; wrap them in raw() inside client.js h``.
// Everything is cheap: CSS animations on a handful of classes, no per-frame JS. Reduced motion (the media
// query or html.reduce-motion) hides the snow and leaves every bulb lit and still (tokens.css).
// bulbString / marqueeBulbs / letterboard are the old Midnight Premiere pieces, kept for compatibility.

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
 * Snowfall behind the content of `container` (a positioned element; .snow-page / .stage create the stacking context).
 * Pale-blue round flakes (4–12 px, opacity .35–.85, slow parallax) so they read on white, and about 1 in 10 a
 * Lucide snowflake (14–20 px). Reduced motion: no snow at all.
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

  const flakeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="#A9C3E2" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS.snowflake}</svg>`;

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
        const px = isFlake ? 14 + Math.round(rand() * 6) : 4 + Math.round(rand() * 8);
        const depth = (px - 4) / 16; // 0 = far, 1 = near
        const o = isFlake ? 0.45 + rand() * 0.25 : 0.35 + rand() * 0.5;
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
          !isFlake && px >= 10 ? '--blur:blur(0.6px)' : '',
        ].filter(Boolean).join(';');
        parts.push(isFlake ? `<i class="is-flake" style="${style}">${flakeSvg}</i>` : `<i style="${style}"></i>`);
      }
    }
    layer.innerHTML = prefersReducedMotion() ? '' : parts.join('');
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

/* ------------------------------------------------------------------ garland ------------------- */

/** C9 bulb colours along the garland (red, gold, blue, green, orange, magenta), as in the TV concept. */
export const BULB_COLORS = Object.freeze(['#D42A2A', '#EDB321', '#2E7BE0', '#1F9D57', '#F28C28', '#C2185B']);
/** Garland modes (svg[data-mode]); all CSS-driven in tokens.css. */
export const GARLAND_MODES = Object.freeze(['twinkle', 'chase', 'spin', 'lit', 'flash', 'blink', 'off']);
const GARLAND_SIZES = { tv: 1, host: 0.5, phone: 0.53 };

/** Point on a quadratic Bézier. */
function quad(p0, c, p1, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

/**
 * Geometry of a swagged garland `width` design-px wide (pure; exported for tests).
 * @param {{width?:number, size?:number|'tv'|'host'|'phone', swags?:number, bulbs?:number}} [o]
 * @returns {{width:number, height:number, size:number, top:number, dip:number, path:string, points:number[][]}}
 */
export function garlandGeometry({ width = 1960, size = 'tv', swags, bulbs } = {}) {
  const k = typeof size === 'number' && size > 0 ? size : GARLAND_SIZES[size] ?? 1;
  const W = Math.max(60, Number(width) || 1960);
  const top = 18 * k;
  const dip = 58 * Math.min(1, k ** 1.2);
  const nS = Math.max(1, Math.trunc(swags ?? Math.round(W / (280 * k))) || 1);
  const nB = Math.max(1, Math.trunc(bulbs ?? Math.round(W / (65 * k))) || 1);
  let d = `M0 ${r2(top)}`;
  const pts = [];
  for (let i = 0; i < nS; i++) {
    const x0 = (i * W) / nS;
    const x1 = ((i + 1) * W) / nS;
    const c = [(x0 + x1) / 2, top + dip * 2];
    d += ` Q ${r2(c[0])} ${r2(c[1])} ${r2(x1)} ${r2(top)}`;
    for (let j = i ? 1 : 0; j <= 48; j++) pts.push(quad([x0, top], c, [x1, top], j / 48));
  }
  // cumulative arc length, then bulbs evenly spaced along the rope
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const points = [];
  let j = 1;
  for (let b = 0; b < nB; b++) {
    const target = (total * (b + 0.5)) / nB;
    while (j < cum.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const t = (target - cum[j - 1]) / seg;
    points.push([r2(pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * t), r2(pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * t)]);
  }
  const height = Math.ceil(top + dip + 60 * k);
  return { width: r2(W), height, size: k, top: r2(top), dip: r2(dip), path: d, points };
}

/**
 * The pine garland as an <svg> string: a swagged rope in three greens with C9 bulbs (soft halos) hanging from it.
 * Size it with CSS (width 100%, height auto): the viewBox matches `width`, so nothing stretches.
 * @param {{width?:number, size?:number|'tv'|'host'|'phone', swags?:number, bulbs?:number, colors?:string[],
 *          mode?:string, seed?:number, className?:string}} [opts]
 */
export function garlandMarkup(opts = {}) {
  const g = garlandGeometry(opts);
  const k = g.size;
  const colors = (Array.isArray(opts.colors) && opts.colors.length ? opts.colors : BULB_COLORS).map((c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#D42A2A'));
  const mode = GARLAND_MODES.includes(opts.mode) ? opts.mode : 'twinkle';
  const rand = rng(opts.seed ?? 1224);
  const rope = (stroke, w, dash, op) =>
    `<path d="${g.path}" fill="none" stroke="${stroke}" stroke-width="${r2(w * k)}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash.map((v) => r2(v * k)).join(' ')}"` : ''}${op < 1 ? ` opacity="${op}"` : ''}/>`;
  const bulbs = g.points
    .map(([x, y], i) => {
      const c = colors[i % colors.length];
      const tw = `--tw:${(-rand() * 4).toFixed(2)}s;--twd:${(2.8 + rand() * 2.2).toFixed(2)}s`;
      return (
        `<g class="garland__bulb p${i % 3}" style="--c:${c};${tw}" transform="translate(${x} ${r2(y + 10 * k)})">` +
        `<ellipse class="garland__halo" cx="0" cy="${r2(22 * k)}" rx="${r2(20 * k)}" ry="${r2(26 * k)}" fill="${c}" opacity=".18"/>` +
        `<rect class="garland__socket" x="${r2(-6 * k)}" y="${r2(-2 * k)}" width="${r2(12 * k)}" height="${r2(10 * k)}" rx="${r2(2 * k)}" fill="#7A6A44"/>` +
        `<ellipse class="garland__glass" cx="0" cy="${r2(22 * k)}" rx="${r2(10 * k)}" ry="${r2(16 * k)}" fill="${c}"/>` +
        `<ellipse class="garland__shine" cx="${r2(-3 * k)}" cy="${r2(16 * k)}" rx="${r2(3 * k)}" ry="${r2(6 * k)}" fill="#fff" opacity=".55"/>` +
        `</g>`
      );
    })
    .join('');
  return (
    `<svg class="garland${opts.className ? ' ' + esc(opts.className) : ''}" viewBox="0 0 ${g.width} ${g.height}" data-mode="${mode}" data-phase="0" aria-hidden="true" focusable="false">` +
    `<g class="garland__rope">${rope('#1B5E3B', 30, null, 1)}${rope('#2E8B57', 26, [2, 7], 1)}${rope('#43A36B', 18, [1, 9], 0.9)}</g>` +
    `<g class="garland__bulbs">${bulbs}</g></svg>`
  );
}

/**
 * Live garland: renders into `container` at its real width (in design px, so it scales with the TV root) and
 * re-renders on resize. Returns a controller; the wheel drives it through mode()/phase() (createWheel lights).
 * @param {Element} container  where the <svg class="garland"> goes (put .garland--top on it via className to hang
 *                             it across the top edge, overhanging 20 px each side)
 * @param {{size?:number|'tv'|'host'|'phone', swags?:number, bulbs?:number, colors?:string[], className?:string,
 *          seed?:number, mode?:string, width?:number}} [opts]
 * @returns {{el:SVGElement|null, mode:(m:string)=>void, phase:(k:number)=>void, twinkle:()=>void, chase:(cycleSec?:number)=>void,
 *            flash:(times?:number)=>Promise<void>, blink:(color?:string, times?:number)=>Promise<void>, lit:()=>void, off:()=>void,
 *            refresh:()=>void, destroy:()=>void}}
 */
export function garland(container, opts = {}) {
  let current = GARLAND_MODES.includes(opts.mode) ? opts.mode : 'twinkle';
  let after = 'twinkle';
  let timer = 0;
  let svg = null;
  const api = {
    el: null,
    mode(m) {
      if (!GARLAND_MODES.includes(m)) return;
      clearTimeout(timer);
      current = m;
      if (m !== 'flash' && m !== 'blink') after = m;
      if (svg) {
        svg.dataset.mode = m;
        if (m !== 'spin') svg.dataset.phase = '0';
      }
    },
    phase(k) {
      if (svg) svg.dataset.phase = String(((Math.trunc(k) % 3) + 3) % 3);
    },
    twinkle: () => api.mode('twinkle'),
    lit: () => api.mode('lit'),
    off: () => api.mode('off'),
    /** Idle chase; cycleSec = seconds per 3-phase cycle (smaller = faster, default 1.2). */
    chase(cycleSec = 1.2) {
      if (svg) svg.style.setProperty('--chase', `${Math.max(0.15, Number(cycleSec) || 1.2)}s`);
      api.mode('chase');
    },
    /** Flash every bulb `times` times (360 ms each), then go back to the previous steady mode. */
    flash(times = 3) {
      return api._burst('flash', times);
    },
    /** Blink every bulb in one colour (default holly green, the Correct blink), then back to the steady mode. */
    blink(color = '#1F9D57', times = 3) {
      if (svg) svg.style.setProperty('--blink', /^#[0-9a-f]{3,8}$/i.test(String(color)) ? color : '#1F9D57');
      return api._burst('blink', times);
    },
    _burst(m, times) {
      const back = after;
      const n = Math.max(1, Math.min(12, Math.trunc(Number(times) || 3)));
      api.mode(m);
      if (svg) svg.style.setProperty('--flashes', String(n));
      return new Promise((resolve) => {
        timer = setTimeout(() => {
          if (current === m) api.mode(back);
          resolve();
        }, prefersReducedMotion() ? 0 : n * 360 + 40);
      });
    },
    refresh: () => build(),
    destroy() {
      clearTimeout(timer);
      ro?.disconnect();
      svg?.remove();
      svg = null;
      api.el = null;
    },
  };
  if (!hasDOM() || !container) return api;

  function designWidth() {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const scale = document.documentElement.dataset.surface === 'tv' ? root / 16 : 1;
    const px = svg?.getBoundingClientRect().width || container.getBoundingClientRect().width || 1920;
    return Math.max(60, Math.round(px / scale));
  }
  let lastW = 0;
  function build() {
    const keep = svg;
    const tmp = document.createElement('div');
    if (!keep) {
      tmp.innerHTML = garlandMarkup({ ...opts, width: opts.width || 1960, mode: current });
      svg = tmp.firstElementChild;
      container.append(svg);
    }
    const w = opts.width || designWidth();
    if (keep && Math.abs(w - lastW) < 2) return;
    lastW = w;
    tmp.innerHTML = garlandMarkup({ ...opts, width: w, mode: current });
    const fresh = tmp.firstElementChild;
    for (const p of ['--chase', '--blink', '--flashes']) {
      const v = svg.style.getPropertyValue(p);
      if (v) fresh.style.setProperty(p, v);
    }
    fresh.dataset.phase = svg.dataset.phase || '0';
    svg.replaceWith(fresh);
    svg = fresh;
    api.el = svg;
  }
  let raf = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(build); }) : null;
  build();
  ro?.observe(container);
  return api;
}

/* ------------------------------------------------------------------ snowbank ------------------ */

/**
 * The two-layer snow hills from the TV concept (pale back hill + white front hill) as an <svg> string. It stretches
 * to its box (preserveAspectRatio none); put it in a .snowbank (absolute, bottom 0, 250 px tall on the TV).
 * @param {{className?:string, back?:string, front?:string}} [opts]
 */
export function snowbank({ className = '', back = '#E7EFF8', front = '#FFFFFF' } = {}) {
  const b = /^#[0-9a-f]{3,8}$/i.test(back) ? back : '#E7EFF8';
  const f = /^#[0-9a-f]{3,8}$/i.test(front) ? front : '#FFFFFF';
  return (
    `<svg class="snowbank${className ? ' ' + esc(className) : ''}" viewBox="0 0 1920 250" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    `<path d="M0 120 C 160 60, 300 110, 460 80 S 760 40, 960 90 S 1300 50, 1480 86 S 1800 60, 1920 100 L1920 250 L0 250 Z" fill="${b}"/>` +
    `<path d="M0 150 C 200 110, 380 150, 560 128 S 900 100, 1100 138 S 1460 112, 1660 140 S 1860 120, 1920 132 L1920 250 L0 250 Z" fill="${f}"/></svg>`
  );
}

/* ------------------------------------------------------------------ stars --------------------- */

const SPARKLE = ICONS.sparkle;

/**
 * Static field of tiny 4-point sparkles in the top third, one or two twinkling. Christmas Eve (Final Chaos) only.
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

/* ------------------------------------------------------------------ legacy bulbs -------------- */

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
