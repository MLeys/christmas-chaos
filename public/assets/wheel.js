// Christmas Chaos — wheel.js
// The 12-slot marquee wheel, Midnight Premiere (brief A6), drawn in a -380..380 viewBox:
// slots r=308 with tangential Big Shoulders 800 caps labels (upright when the slot is under the pointer) and a
// 40 px Lucide icon above; 6 px night gutter; 3 px snow dividers at 70%; 28 px tinsel rim with a brass bevel
// and 24 bulbs in a 3-phase chase; peppermint hub with a gold cap; gold teardrop pointer with a cranberry
// jewel. Slots may carry trim (gold inner arc + velvet folds) or pattern:'candy' (candy-cane stripes + an
// ivory label pill). Landed: other slots dim to 45% and desaturate, the winner gets a 4 px ivory outline,
// 150 ms hit-stop, then the bulbs flash 3 times.
//
//   const wheel = createWheel(svgEl, state.segments);
//   wheel.restOn(state.lastSegmentIndex);                    // refresh-safe resting position
//   wheel.spinTo(spin.segmentIndex, spin.durationMs, {       // lands EXACTLY centred on the index
//     startedAt: spin.startedAt, clockOffset: client.clockOffset, onTick: () => sound.tick() });
//   wheel.highlight(i | null); wheel.idle(true);            // 1.2 s marquee chase while waiting
//   wheel.bulbs('rest' | 'chase' | 'spin' | 'lit' | 'blink' | 'off');
//
// Bulb animation is pure CSS on three phase groups (tokens.css); during a spin JS only advances
// svg[data-phase] at a rate that follows the wheel's speed. The pure math (planSpin / rotationAt /
// restRotation / tickCount …) is exported for tests.

import { ICONS, safeColor } from './icons.js';

/* ------------------------------------------------------------------ pure math ---------------- */

export const DEFAULT_TURNS = 6;
export const REDUCED_TURNS = 1;

export function mod(a, m) {
  return ((a % m) + m) % m;
}

export function clamp01(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** ease-out-quart: fast start, long gentle stop. */
export function easeOutQuart(t) {
  const u = 1 - clamp01(t);
  return 1 - u * u * u * u;
}

/** Width of one slot in degrees. */
export function slotDeg(n = 12) {
  return 360 / n;
}

/** Rotor rotation (deg, clockwise, in [0,360)) that puts the CENTRE of slot `index` under the top pointer. */
export function restRotation(index, n = 12) {
  return mod(-index * slotDeg(n), 360);
}

/** Signed smallest difference a-b in degrees, in (-180, 180]. */
export function angleDiff(a, b) {
  const d = mod(a - b, 360);
  return d > 180 ? d - 360 : d;
}

/** Index of the slot under the pointer for a given rotor rotation. */
export function indexAtRotation(rotation, n = 12) {
  return mod(Math.round(-rotation / slotDeg(n)), n);
}

/** Degrees between the pointer and the centre of the slot under it (0 = perfectly centred). */
export function offsetFromCentre(rotation, n = 12) {
  return angleDiff(rotation, restRotation(indexAtRotation(rotation, n), n));
}

/**
 * Monotonic count of slot boundaries that have passed the pointer. Boundaries sit at slot centre ± half a
 * slot, so a boundary is under the pointer whenever rotation ≡ slot/2 (mod slot). Each +1 is one tick.
 */
export function tickCount(rotation, n = 12) {
  const s = slotDeg(n);
  return Math.floor((rotation - s / 2) / s);
}

/** Final absolute rotation: at least `turns` full turns past `from`, ending centred on `index`. */
export function spinTarget(from, index, n = 12, turns = DEFAULT_TURNS) {
  const rest = restRotation(index, n);
  const delta = mod(rest - mod(from, 360), 360);
  return from + Math.max(0, Math.floor(turns)) * 360 + delta;
}

/**
 * Plan a spin. All times are in ONE clock (use server ms: startedAt from state.spin, now = Date.now()+offset).
 * @returns {{from:number,to:number,index:number,n:number,startedAt:number,durationMs:number}}
 */
export function planSpin({ from = 0, index, n = 12, durationMs = 5000, turns = DEFAULT_TURNS, startedAt, now = 0 }) {
  const i = mod(Math.trunc(Number(index) || 0), n);
  const dur = Math.max(0, Number(durationMs) || 0);
  const start = Number.isFinite(startedAt) ? startedAt : now;
  return { from, to: spinTarget(from, i, n, turns), index: i, n, startedAt: start, durationMs: dur };
}

/**
 * Rotation at time `now` for a plan. Before the start it holds `from`; at/after the end it returns the
 * exact resting rotation (mod 360) so the wheel is always perfectly centred on the winner.
 */
export function rotationAt(plan, now) {
  const elapsed = now - plan.startedAt;
  const t = plan.durationMs > 0 ? elapsed / plan.durationMs : 1;
  if (t >= 1) return { rotation: restRotation(plan.index, plan.n), progress: 1, done: true };
  const p = clamp01(t);
  return { rotation: plan.from + (plan.to - plan.from) * easeOutQuart(p), progress: p, done: false };
}

/** Angular speed (deg per ms) at progress p — derivative of ease-out-quart. */
export function speedAt(plan, progress) {
  if (plan.durationMs <= 0) return 0;
  const u = 1 - clamp01(progress);
  return ((plan.to - plan.from) * 4 * u * u * u) / plan.durationMs;
}

/* ------------------------------------------------------------------ segments ----------------- */

/** The wheel the server sends (src/game.js SEGMENTS). The live app always passes state.segments; this is the demo set. */
export const DEFAULT_SEGMENTS = Object.freeze(
  [
    ['trivia', 'Christmas Trivia', ['CHRISTMAS', 'TRIVIA'], '#C8102E', '#FFF7EA', 'tree-pine'],
    ['dare', 'Dare', ['DARE'], '#F6C453', '#1A1206', 'drama'],
    ['trivia', 'Pop Culture', ['POP', 'CULTURE'], '#2450D0', '#FFF7EA', 'clapperboard'],
    ['hotseat', 'Hot Seat', ['HOT', 'SEAT'], '#FF8FB1', '#2A0A18', 'flame'],
    ['trivia', 'Christmas Movies', ['CHRISTMAS', 'MOVIES'], '#7E0B22', '#FFF7EA', 'popcorn', { trim: '#F6C453' }],
    ['sounditout', 'Sound It Out', ['SOUND', 'IT OUT'], '#7B4CE0', '#FFF7EA', 'music'],
    ['grinch', 'Grinch Steal', ['GRINCH', 'STEAL'], '#9BD13B', '#0B1430', 'hand-coins'],
    ['showdown', 'Showdown', ['SHOW', 'DOWN'], '#5AA9E6', '#0B1430', 'swords'],
    ['dare', 'Dare', ['DARE'], '#F6C453', '#1A1206', 'drama'],
    ['rapidlist', 'Rapid List', ['RAPID', 'LIST'], '#0E7C74', '#FFF7EA', 'list-checks'],
    ['allplay', 'All Play', ['ALL', 'PLAY'], '#FF9A3C', '#1A1206', 'zap'],
    ['doubledown', 'Double Down', ['DOUBLE', 'DOWN'], '#FFF7EA', '#0B1430', 'sparkles', { pattern: 'candy', stripe: '#C8102E' }],
  ].map(([type, label, lines, color, ink, icon, extra], index) => Object.freeze({ index, type, label, lines, color, ink, icon, ...(extra || {}) }))
);

/** Upper-case label lines: the server's `lines`, else the label split into at most two balanced lines. */
export function labelLines(seg) {
  if (Array.isArray(seg?.lines) && seg.lines.length) {
    return seg.lines.slice(0, 3).map((l) => String(l).toUpperCase());
  }
  const words = String(seg?.label ?? '').toUpperCase().trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words;
  let best = null;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' ');
    const b = words.slice(k).join(' ');
    const score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { score, lines: [a, b] };
  }
  return best.lines;
}

// Advance widths in em, measured in Edge with the bundled woff2 files (scratch/measure.cjs).
const GLYPH_W = {
  // Big Shoulders Display 800 — wheel labels, eyebrows, marquee
  marquee: {
    A: 0.443, B: 0.441, C: 0.455, D: 0.461, E: 0.381, F: 0.378, G: 0.457, H: 0.455, I: 0.215, J: 0.421, K: 0.458, L: 0.374, M: 0.691,
    N: 0.508, O: 0.462, P: 0.436, Q: 0.462, R: 0.444, S: 0.441, T: 0.384, U: 0.453, V: 0.456, W: 0.733, X: 0.435, Y: 0.43, Z: 0.388,
    0: 0.473, 1: 0.255, 2: 0.457, 3: 0.47, 4: 0.479, 5: 0.48, 6: 0.465, 7: 0.446, 8: 0.466, 9: 0.465,
    ' ': 0.217, "'": 0.19, '’': 0.239, '&': 0.581, '!': 0.238, '?': 0.441, '-': 0.413, '.': 0.238, ',': 0.239, ':': 0.238, '×': 0.456, '+': 0.512,
    _: 0.46,
  },
  // Fraunces 900 (opsz 144) — var(--font-display) splash words, titles
  display: {
    A: 0.678, B: 0.714, C: 0.662, D: 0.759, E: 0.637, F: 0.583, G: 0.713, H: 0.808, I: 0.398, J: 0.456, K: 0.759, L: 0.603, M: 0.864,
    N: 0.686, O: 0.749, P: 0.689, Q: 0.767, R: 0.736, S: 0.595, T: 0.677, U: 0.683, V: 0.642, W: 0.994, X: 0.685, Y: 0.646, Z: 0.598,
    0: 0.663, 1: 0.414, 2: 0.611, 3: 0.564, 4: 0.624, 5: 0.574, 6: 0.618, 7: 0.531, 8: 0.59, 9: 0.625,
    ' ': 0.152, "'": 0.202, '’': 0.207, '&': 0.959, '!': 0.308, '?': 0.583, '-': 0.259, '.': 0.259, ',': 0.268, ':': 0.259, '×': 0.408, '+': 0.46,
    _: 0.7,
  },
};

/** Estimated width of an upper-case string in em. face: 'marquee' (Big Shoulders 800, the wheel) or 'display' (Fraunces 900). */
export function textWidthEm(text, face = 'marquee') {
  const t = GLYPH_W[face] || GLYPH_W.marquee;
  let w = 0;
  for (const ch of String(text)) w += t[ch] ?? t._;
  return w;
}

/** Width of a wheel label in em of Big Shoulders Display 800 (the wheel's label face). */
export function labelWidthEm(text) {
  return textWidthEm(text, 'marquee');
}

/** Width of a giant display word in em of Fraunces 900 (var(--font-display)). */
export function displayWidthEm(text) {
  return textWidthEm(text, 'display');
}

const LABEL_TRACK = 0.02; // letter-spacing per glyph, in em

/** Usable label width (viewBox units) at a baseline y for a text of `size`, inside a slot of an n-slot wheel. */
export function labelRoom(y, size, n = 12) {
  const r = Math.abs(y) + size * 0.35; // vertical middle of the caps
  return 2 * r * Math.tan(Math.PI / n) * 0.92;
}

/** Font size + baselines for a slot's label (brief A6: Big Shoulders 800 caps 30 px; 1 line @ -210, 2 lines @ -226/-194). */
export function labelLayout(lines, n = 12) {
  const spec =
    lines.length <= 1
      ? { size: 30, ys: [-210] }
      : lines.length === 2
        ? { size: 30, ys: [-226, -194] }
        : { size: 24, ys: [-238, -212, -186] };
  return lines.map((text, k) => {
    const y = spec.ys[k];
    const w = labelWidthEm(text) + Math.max(0, [...text].length - 1) * LABEL_TRACK;
    // room depends on the size (taller caps sit on a wider chord), so settle it in a few passes
    let size = spec.size;
    for (let pass = 0; pass < 4 && w > 0; pass++) {
      size = Math.max(14, Math.min(spec.size, Math.floor((labelRoom(y, size, n) / w) * 10) / 10));
    }
    return { text, y, size, room: +labelRoom(y, size, n).toFixed(1) };
  });
}

/* ------------------------------------------------------------------ rendering ---------------- */
// Construction (brief A6), drawn in a -380..380 viewBox (1 unit = 1 px at 760 px):
//   slots r=308 · 6 px night gutter · 28 px tinsel rim (r=328) with a brass bevel (r=345) · 24 bulbs on the rim
//   in 3 phase groups · 3 px snow dividers at 70% · peppermint hub (8 blades, r=60) with a gold cap · gold
//   teardrop pointer with a cranberry jewel at 12 o'clock.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const f2 = (x) => +x.toFixed(2);

export const VIEWBOX = '-380 -380 760 760';
const R_SLOT = 308;
const R_RIM = 328;
const RIM_W = 28;
const R_BEVEL = 345;
const R_HUB = 60;
const IVORY = '#FFF7EA';
const NIGHT = '#0B1430';
const BRASS = '#C9962E';
const FONT = "'Big Shoulders Display', 'Bahnschrift', 'Arial Narrow', sans-serif";
/** The pointer teardrop (tip at r=306, round end centred at r=343). */
export const POINTER_PATH = 'M0 -306 L18.01 -343.3 A20 20 0 1 0 -18.01 -343.3 Z';
const POINTER_PIVOT = '0 -343';

let uid = 0;

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [f2(r * Math.sin(a)), f2(-r * Math.cos(a))];
}

function arc(r, fromDeg, toDeg) {
  const [x1, y1] = polar(r, fromDeg);
  const [x2, y2] = polar(r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function wedgePath(r, n) {
  const h = Math.PI / n;
  const x = f2(r * Math.sin(h));
  const y = f2(-r * Math.cos(h));
  return `M0 0 L${-x} ${y} A${r} ${r} 0 0 1 ${x} ${y} Z`;
}

function restPath(r, n) {
  const h = Math.PI / n;
  const x = f2(r * Math.sin(h));
  const y = f2(-r * Math.cos(h));
  return `M0 0 L${x} ${y} A${r} ${r} 0 1 1 ${-x} ${y} Z`;
}

function defs(p, n) {
  const half = f2(R_SLOT * Math.sin(Math.PI / n));
  return (
    `<defs>` +
    `<radialGradient id="${p}-shadow"><stop offset=".84" stop-color="#000" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="${p}-rim" x1="0" y1="-350" x2="0" y2="350" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFE7A0"/><stop offset=".3" stop-color="#F6C453"/><stop offset=".62" stop-color="#D9A441"/><stop offset="1" stop-color="#F3BE4E"/></linearGradient>` +
    `<radialGradient id="${p}-halo"><stop offset="0" stop-color="#FFE296" stop-opacity=".95"/><stop offset=".35" stop-color="#FFB938" stop-opacity=".55"/><stop offset="1" stop-color="#FFB938" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="${p}-velvet" x1="${-half}" y1="0" x2="${half}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset=".12" stop-color="#FFF" stop-opacity=".07"/><stop offset=".24" stop-color="#000" stop-opacity=".2"/><stop offset=".38" stop-color="#FFF" stop-opacity=".09"/><stop offset=".5" stop-color="#000" stop-opacity=".12"/><stop offset=".62" stop-color="#FFF" stop-opacity=".09"/><stop offset=".76" stop-color="#000" stop-opacity=".2"/><stop offset=".88" stop-color="#FFF" stop-opacity=".07"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient>` +
    `<radialGradient id="${p}-cap" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#FFF1C2"/><stop offset=".45" stop-color="#F6C453"/><stop offset="1" stop-color="#A9761F"/></radialGradient>` +
    `<linearGradient id="${p}-ptr" x1="-20" y1="0" x2="20" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#C9962E"/><stop offset=".4" stop-color="#FFE7A0"/><stop offset=".65" stop-color="#F6C453"/><stop offset="1" stop-color="#B8862B"/></linearGradient>` +
    `</defs>`
  );
}

/** One candy-cane stripe pattern per striped slot (ivory 20 + stripe colour 12, at 45°). */
function canePattern(id, stripe) {
  return `<pattern id="${id}" width="32" height="32" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="32" height="32" fill="${IVORY}"/><rect x="20" width="12" height="32" fill="${stripe}"/></pattern>`;
}

function slotMarkup(seg, i, n, p) {
  const candy = seg?.pattern === 'candy';
  const color = safeColor(seg?.color, '#1F2C5E');
  const ink = safeColor(seg?.ink, IVORY);
  const trim = seg?.trim ? safeColor(seg.trim, '') : '';
  const iconInner = ICONS[seg?.icon] || '';
  const lines = labelLayout(labelLines(seg), n);
  const wedge = wedgePath(R_SLOT, n);
  const parts = [];
  let extraDefs = '';
  if (candy) {
    const pid = `${p}-cane${i}`;
    extraDefs = `<defs>${canePattern(pid, safeColor(seg?.stripe, '#C8102E'))}</defs>`;
    parts.push(`<path class="wheel__face" d="${wedge}" fill="url(#${pid})"/>`);
  } else {
    parts.push(`<path class="wheel__face" d="${wedge}" fill="${color}"/>`);
  }
  if (trim) {
    // velvet folds + a 4 px gold inner arc with little tassels, like a curtain fringe
    parts.push(`<path d="${wedge}" fill="url(#${p}-velvet)"/>`);
    const half = 180 / n - 0.8;
    parts.push(`<path d="${arc(303, -half, half)}" fill="none" stroke="${trim}" stroke-width="4" stroke-linecap="round"/>`);
    const ticks = [];
    for (let a = -half + 1.7; a <= half - 1.6; a += 2.5) {
      const [x1, y1] = polar(301, a);
      const [x2, y2] = polar(296.5, a);
      ticks.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }
    parts.push(`<g stroke="${trim}" stroke-width="2" stroke-linecap="round">${ticks.join('')}</g>`);
  }
  if (candy) {
    // ivory label pill so the label never sits on the stripes
    const widest = Math.max(...lines.map((l) => (labelWidthEm(l.text) + [...l.text].length * LABEL_TRACK) * l.size), 40);
    const w = Math.round(Math.min(labelRoom(-186, 30, n) - 4, widest + 22));
    const top = -300;
    const bottom = lines.length ? lines[lines.length - 1].y + 8 : -246;
    parts.push(`<rect class="wheel__pill" x="${f2(-w / 2)}" y="${top}" width="${w}" height="${f2(bottom - top)}" rx="18" fill="${color}" stroke="${NIGHT}" stroke-opacity=".18" stroke-width="1.5"/>`);
  }
  if (iconInner) {
    parts.push(`<svg class="wheel__icon" x="-20" y="-294" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconInner}</svg>`);
  }
  for (const l of lines) {
    parts.push(`<text x="0" y="${l.y}" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${l.size}" letter-spacing="${f2(l.size * LABEL_TRACK)}" fill="${ink}" data-room="${l.room}">${esc(l.text)}</text>`);
  }
  return `<g class="wheel__slot" data-index="${i}" transform="rotate(${f2(i * slotDeg(n))})">${extraDefs}${parts.join('')}</g>`;
}

function bulbMarkup(p) {
  const base = [];
  const lit = [[], [], []];
  for (let k = 0; k < 24; k++) {
    const [x, y] = polar(R_RIM, 7.5 + k * 15);
    base.push(`<circle class="wheel__bulb" cx="${x}" cy="${y}" r="8" fill="#6B4A0E"/><circle cx="${x}" cy="${y}" r="5.5" fill="#9C7A3A"/>`);
    lit[k % 3].push(
      `<circle class="wheel__halo" cx="${x}" cy="${y}" r="16" fill="url(#${p}-halo)"/><circle class="wheel__core" cx="${x}" cy="${y}" r="5.8" fill="#FFE6A8"/><circle cx="${f2(x - 1.8)}" cy="${f2(y - 1.8)}" r="1.8" fill="#FFFDF6"/>`
    );
  }
  return (
    `<g class="wheel__bulbs">` +
    `<g class="wheel__base">${base.join('')}</g>` +
    lit.map((g, k) => `<g class="wheel__lit wheel__lit--p${k}">${g.join('')}</g>`).join('') +
    `</g>`
  );
}

function hubMarkup(p) {
  const blades = [];
  for (let k = 0; k < 8; k++) {
    const t0 = k * 45;
    const t1 = t0 + 45;
    const [x0, y0] = polar(R_HUB, t0);
    const [x1, y1] = polar(R_HUB, t1);
    const [cx0, cy0] = polar(34, t0 - 52);
    const [cx1, cy1] = polar(34, t1 - 52);
    blades.push(`<path d="M0 0 Q${cx0} ${cy0} ${x0} ${y0} A${R_HUB} ${R_HUB} 0 0 1 ${x1} ${y1} Q${cx1} ${cy1} 0 0 Z" fill="${k % 2 ? IVORY : '#C8102E'}"/>`);
  }
  return (
    `<circle class="wheel__hub" r="68" fill="${NIGHT}"/>` +
    `<circle r="66" fill="none" stroke="${BRASS}" stroke-width="3"/>` +
    `<g class="wheel__hubicon" transform="rotate(0)">${blades.join('')}<circle r="${R_HUB}" fill="none" stroke="${NIGHT}" stroke-opacity=".35" stroke-width="1.5"/></g>` +
    `<circle r="21" fill="url(#${p}-cap)" stroke="#8A6416" stroke-width="1.5"/>` +
    `<ellipse cx="-6" cy="-8" rx="6" ry="3.5" fill="#FFFCF2" fill-opacity=".55" transform="rotate(-30 -6 -8)"/>`
  );
}

/**
 * Static markup of the whole wheel (no state). Exported so pages/tests can render a wheel without JS motion.
 * @param {Array} segments
 * @param {{id?:string}} [opts] id prefix for gradient/pattern ids (unique per wheel on the page)
 */
export function wheelMarkup(segments = DEFAULT_SEGMENTS, { id } = {}) {
  const segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  const n = segs.length;
  const p = String(id || `ccw${++uid}`).replace(/[^\w-]/g, '');
  const slots = segs.map((s, i) => slotMarkup(s, i, n, p)).join('');
  const dividers = Array.from({ length: n }, (_, k) => {
    const a = slotDeg(n) / 2 + k * slotDeg(n);
    const [x1, y1] = polar(64, a);
    const [x2, y2] = polar(R_SLOT, a);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }).join('');
  // soft motion arcs over the face while spinning fast
  const blur = [[296, 20, 72], [296, 200, 252], [236, 112, 158], [236, 292, 338], [170, 40, 88], [170, 220, 268]]
    .map(([r, a, b]) => `<path d="${arc(r, a, b)}"/>`)
    .join('');
  return (
    defs(p, n) +
    `<circle class="wheel__shadow" cx="0" cy="20" r="372" fill="url(#${p}-shadow)"/>` +
    `<circle class="wheel__bg" r="348" fill="${NIGHT}"/>` +
    `<g class="wheel__rotor" transform="rotate(0)">` +
    `<g class="wheel__slots">${slots}</g>` +
    `<g class="wheel__dividers" stroke="${IVORY}" stroke-opacity=".7" stroke-width="3" stroke-linecap="round">${dividers}</g>` +
    `<g class="wheel__hl" transform="rotate(0)" opacity="0" pointer-events="none">` +
    `<path class="wheel__dim" d="${restPath(R_SLOT, n)}" fill="${NIGHT}" fill-opacity=".55"/>` +
    `<path class="wheel__desat" d="${restPath(R_SLOT, n)}" fill="#808080" fill-opacity=".3" style="mix-blend-mode:saturation"/>` +
    `<path class="wheel__outline" d="${wedgePath(309, n)}" fill="none" stroke="${IVORY}" stroke-width="4" stroke-linejoin="round"/>` +
    `</g></g>` +
    `<g class="wheel__blur" fill="none" stroke="${IVORY}" stroke-width="5" stroke-linecap="round" opacity="0">${blur}</g>` +
    `<circle class="wheel__gutter" r="311" fill="none" stroke="${NIGHT}" stroke-width="6"/>` +
    `<circle class="wheel__rim" r="${R_RIM}" fill="none" stroke="url(#${p}-rim)" stroke-width="${RIM_W}"/>` +
    `<circle r="314.5" fill="none" stroke="#6B4A0E" stroke-opacity=".6" stroke-width="1"/>` +
    `<circle class="wheel__bevel" r="${R_BEVEL}" fill="none" stroke="${BRASS}" stroke-width="6"/>` +
    `<circle r="347.4" fill="none" stroke="#FFF0C8" stroke-opacity=".45" stroke-width="1.2"/>` +
    bulbMarkup(p) +
    hubMarkup(p) +
    `<g class="wheel__pointer" transform="rotate(0 ${POINTER_PIVOT})">` +
    `<path d="${POINTER_PATH}" fill="#000" fill-opacity=".4" transform="translate(0 5)"/>` +
    `<path d="${POINTER_PATH}" fill="url(#${p}-ptr)" stroke="#6B4A0E" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<circle cx="0" cy="-352" r="9.5" fill="#C8102E" stroke="#8E0B22" stroke-width="1.5"/>` +
    `<circle cx="-3" cy="-355" r="3" fill="#FFFCF2" fill-opacity=".75"/>` +
    `</g>`
  );
}

/** Small static wheel glyph (e.g. inside a phone SPIN button). */
export function miniWheelMarkup(segments = DEFAULT_SEGMENTS, { tilt = -8 } = {}) {
  const segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  const n = segs.length;
  const h = Math.PI / n;
  const x = f2(88 * Math.sin(h));
  const y = f2(-88 * Math.cos(h));
  const p = `ccm${++uid}`;
  let pattern = '';
  const wedges = segs
    .map((s, i) => {
      let fill = safeColor(s?.color, '#1F2C5E');
      if (s?.pattern === 'candy') {
        pattern = `<defs><pattern id="${p}-cane" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" fill="${IVORY}"/><rect x="9" width="5" height="14" fill="${safeColor(s?.stripe, '#C8102E')}"/></pattern></defs>`;
        fill = `url(#${p}-cane)`;
      }
      return `<path transform="rotate(${f2(i * slotDeg(n))})" d="M0 0 L${-x} ${y} A88 88 0 0 1 ${x} ${y} Z" fill="${fill}" stroke="${NIGHT}" stroke-width="2"/>`;
    })
    .join('');
  const dots = Array.from({ length: n }, (_, k) => {
    const [cx, cy] = polar(94, k * slotDeg(n) + slotDeg(n) / 2);
    return `<circle cx="${cx}" cy="${cy}" r="3.6"/>`;
  }).join('');
  return (
    `<svg class="mini-wheel" viewBox="-110 -124 220 234" aria-hidden="true" focusable="false">${pattern}` +
    `<circle r="102" fill="${NIGHT}"/><g transform="rotate(${Number(tilt) || 0})">${wedges}</g>` +
    `<circle r="94" fill="none" stroke="#F6C453" stroke-width="12"/><circle r="101" fill="none" stroke="${BRASS}" stroke-width="3"/><g fill="#FFE6A8">${dots}</g>` +
    `<circle r="20" fill="#C8102E" stroke="${IVORY}" stroke-width="5"/><circle r="7" fill="#F6C453"/>` +
    `<path d="M0 -84 L9 -104 A11 11 0 1 0 -9 -104 Z" fill="#F6C453" stroke="#6B4A0E" stroke-width="2" stroke-linejoin="round"/><circle cy="-110" r="4.5" fill="#C8102E"/></svg>`
  );
}

/* ------------------------------------------------------------------ live wheel --------------- */

function prefersReducedMotion() {
  try {
    if (typeof document !== 'undefined' && document.documentElement?.classList?.contains('reduce-motion')) return true;
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const raf = (cb) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(cb) : setTimeout(() => cb(perfNow()), 16));
const caf = (id) => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id));

/** Bulb chase steps per second while spinning: follows the wheel's speed (fast spin → fast chase). */
export function chaseRate(speedFraction) {
  const s = Math.max(0, Math.min(1, Number(speedFraction) || 0));
  return 2.5 + 21.5 * s;
}

export const HIT_STOP_MS = 150;
export const FLASH_MS = 3 * 360;

/**
 * Render the wheel into an <svg> element and return its controller.
 * @param {SVGSVGElement} svgEl
 * @param {Array<{index:number,label:string,lines?:string[],color:string,ink:string,icon:string,trim?:string,pattern?:string}>} segments
 * @param {{label?:string, autoHighlight?:boolean, reducedMotion?:boolean}} [opts]
 */
export function createWheel(svgEl, segments = DEFAULT_SEGMENTS, opts = {}) {
  if (!svgEl) throw new Error('createWheel: svg element required');
  const o = { label: 'The prize wheel', autoHighlight: true, ...opts };
  const idPrefix = `ccw${++uid}`;

  let segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  let n = segs.length;
  let rotation = 0;
  let hlIndex = null;
  let restingIndex = null;
  let spinning = false;
  let gen = 0;
  let frameId = 0;
  let endTimer = 0;
  let bulbTimer = 0;
  let hitTimer = 0;
  let idleOn = false;
  let kick = 0;
  let kickAt = 0;
  let phase = 0;
  let pendingResolve = null; // resolver of the running spinTo() promise

  svgEl.setAttribute('viewBox', VIEWBOX);
  svgEl.setAttribute('role', 'img');
  svgEl.classList.add('wheel');
  if (!svgEl.getAttribute('xmlns')) svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  let el = {};
  function build() {
    svgEl.innerHTML = wheelMarkup(segs, { id: idPrefix });
    const q = (s) => svgEl.querySelector(s);
    el = {
      rotor: q('.wheel__rotor'),
      hl: q('.wheel__hl'),
      hub: q('.wheel__hubicon'),
      pointer: q('.wheel__pointer'),
      blur: q('.wheel__blur'),
    };
    applyRotation(rotation);
    applyHighlight();
    fitLabels();
  }

  // Re-fit labels with real measurements (handles a fallback font if Big Shoulders failed to load).
  function fitLabels() {
    for (const t of svgEl.querySelectorAll('text[data-room]')) {
      try {
        const room = Number(t.dataset.room);
        const base = Number(t.dataset.size) || Number(t.getAttribute('font-size')) || 30;
        t.dataset.size = String(base);
        t.setAttribute('font-size', String(base));
        const len = t.getComputedTextLength?.();
        if (!len || !room) continue;
        if (len > room + 0.5) {
          t.setAttribute('font-size', String(Math.max(12, Math.floor(((base * room) / len) * 10) / 10)));
        }
      } catch {
        /* not rendered yet */
      }
    }
  }
  try {
    globalThis.document?.fonts?.ready?.then(() => fitLabels());
  } catch {
    /* no font loading API */
  }

  function applyRotation(r) {
    const t = `rotate(${+r.toFixed(3)})`;
    el.rotor?.setAttribute('transform', t);
    el.hub?.setAttribute('transform', t);
  }

  function setPointer(deg) {
    el.pointer?.setAttribute('transform', `rotate(${+deg.toFixed(2)} ${POINTER_PIVOT})`);
  }

  function setMotion(level) {
    const v = Math.max(0, Math.min(1, level));
    el.blur?.setAttribute('opacity', String(+(v * 0.16).toFixed(3)));
  }

  function setPhase(p) {
    if (p !== phase || svgEl.dataset.phase === undefined) {
      phase = p;
      svgEl.dataset.phase = String(p);
    }
  }

  function setLabel(text) {
    svgEl.setAttribute('aria-label', text);
  }

  function segLabel(i) {
    return segs[i]?.label || labelLines(segs[i]).join(' ') || `slot ${i + 1}`;
  }

  function applyHighlight() {
    if (!el.hl) return;
    if (hlIndex == null) {
      el.hl.setAttribute('opacity', '0');
      svgEl.classList.remove('is-landed');
    } else {
      el.hl.setAttribute('transform', `rotate(${f2(hlIndex * slotDeg(n))})`);
      el.hl.setAttribute('opacity', '1');
      svgEl.classList.add('is-landed');
    }
  }

  /**
   * Bulb modes (CSS in tokens.css drives the animation — no per-bulb JS):
   *   rest  — every bulb softly on
   *   chase — idle 3-phase chase, 1.2 s cycle
   *   spin  — chase whose speed follows the wheel (JS advances data-phase while the rotor moves)
   *   lit   — every bulb bright (also the 150 ms hit-stop when the wheel lands)
   *   blink — 3 flashes after landing, then lit (or chase if idle)
   *   off   — dark
   */
  function bulbs(mode = 'rest') {
    clearTimeout(bulbTimer);
    bulbTimer = 0;
    svgEl.dataset.bulbs = mode;
    if (mode !== 'spin') setPhase(0);
    if (mode === 'blink') {
      const reduce = o.reducedMotion ?? prefersReducedMotion();
      if (reduce) return bulbs('lit');
      bulbTimer = setTimeout(() => bulbs(idleOn ? 'chase' : 'lit'), FLASH_MS + 40);
    }
  }

  function cancelSpin() {
    gen++;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      r(false); // a cancelled spin resolves false and never lands
    }
    caf(frameId);
    clearTimeout(endTimer);
    clearTimeout(hitTimer);
    frameId = 0;
    if (spinning) {
      spinning = false;
      svgEl.classList.remove('is-spinning');
      setMotion(0);
      setPointer(0);
    }
  }

  function settle(index) {
    rotation = restRotation(index, n);
    restingIndex = index;
    applyRotation(rotation);
    setPointer(0);
    setMotion(0);
  }

  /**
   * Spin to land exactly centred on `index` at server time startedAt + durationMs.
   * A TV that joins late (startedAt in the past) jumps into the motion at the right place; if the spin is
   * already over it simply rests on the winner. Resolves true when it lands, false if cancelled.
   * On landing: other slots dim to 45% and desaturate, the winner gets a 4 px ivory outline, a 150 ms
   * hit-stop (bulbs freeze lit) and then the bulbs flash 3 times.
   */
  function spinTo(index, durationMs = 5000, sopts = {}) {
    const { onTick, onDone, startedAt, clockOffset = 0, turns } = sopts || {};
    const target = mod(Math.trunc(Number(index) || 0), n);
    cancelSpin();
    const my = gen;
    idleOn = false;
    hlIndex = null;
    applyHighlight();
    const reduce = o.reducedMotion ?? prefersReducedMotion();
    const serverNow0 = Date.now() + (Number(clockOffset) || 0);
    const perf0 = perfNow();
    const clock = () => serverNow0 + (perfNow() - perf0);
    const plan = planSpin({
      from: rotation,
      index: target,
      n,
      durationMs,
      turns: turns ?? (reduce ? REDUCED_TURNS : DEFAULT_TURNS),
      startedAt: Number.isFinite(startedAt) ? startedAt : serverNow0,
      now: serverNow0,
    });

    const land = (celebrate = true) => {
      spinning = false;
      svgEl.classList.remove('is-spinning');
      settle(target);
      if (o.autoHighlight) {
        hlIndex = target;
        applyHighlight();
      }
      setLabel(`The wheel landed on ${segLabel(target)}`);
      if (celebrate) {
        bulbs('lit'); // hit-stop: everything freezes, lit
        clearTimeout(hitTimer);
        hitTimer = setTimeout(() => {
          if (my === gen && !spinning) bulbs('blink');
        }, HIT_STOP_MS);
      } else {
        bulbs(idleOn ? 'chase' : 'lit');
      }
      try {
        onDone?.(target);
      } catch (e) {
        console.error(e);
      }
    };

    if (clock() >= plan.startedAt + plan.durationMs) {
      land(false);
      return Promise.resolve(true);
    }

    spinning = true;
    svgEl.classList.add('is-spinning');
    setLabel('The wheel is spinning');
    bulbs('spin');
    let lastTick = tickCount(rotationAt(plan, clock()).rotation, n);
    const peak = speedAt(plan, 0) || 1;
    let phaseAcc = 0;
    let lastPerf = perfNow();

    return new Promise((resolve) => {
      pendingResolve = resolve;
      const frame = () => {
        if (my !== gen || !spinning) return; // cancelled (already resolved false) or already landed
        const now = clock();
        const { rotation: r, done, progress } = rotationAt(plan, now);
        if (done) {
          clearTimeout(endTimer);
          caf(frameId);
          pendingResolve = null;
          land(true);
          return resolve(true);
        }
        rotation = r;
        applyRotation(r);
        const tc = tickCount(r, n);
        if (tc > lastTick) {
          const passed = Math.min(tc - lastTick, 2); // never burst after a throttled/hidden tab
          lastTick = tc;
          kick = 1;
          kickAt = perfNow();
          for (let k = 0; k < passed; k++) {
            try {
              onTick?.({ index: indexAtRotation(r, n), progress });
            } catch (e) {
              console.error(e);
            }
          }
        }
        const p = perfNow();
        const sp = speedAt(plan, progress) / peak;
        // bulb chase follows the wheel: one attribute write per phase step, CSS does the rest
        if (!reduce) {
          phaseAcc += (Math.min(100, p - lastPerf) / 1000) * chaseRate(sp);
          setPhase(Math.floor(phaseAcc) % 3);
        }
        lastPerf = p;
        // pointer flapper: kicked back by each boundary, springs home in ~110 ms
        const since = p - kickAt;
        const flap = kick * Math.exp(-since / 55);
        setPointer(reduce ? 0 : -16 * flap);
        setMotion(reduce ? 0 : Math.min(1, sp * 1.4));
        frameId = raf(frame);
      };
      frameId = raf(frame);
      // rAF pauses in hidden tabs; make sure we still land (and fire onDone) on time.
      endTimer = setTimeout(() => {
        if (my === gen && spinning) frame();
      }, Math.max(0, plan.startedAt + plan.durationMs - clock()) + 30);
    });
  }

  /** Rest (no animation) centred on `index`. Clears the highlight unless {highlight:true}. */
  function restOn(index, { highlight: hl = false } = {}) {
    if (index == null || !Number.isFinite(Number(index))) return;
    cancelSpin();
    const i = mod(Math.trunc(Number(index)), n);
    settle(i);
    hlIndex = hl ? i : null;
    applyHighlight();
    setLabel(hl ? `The wheel landed on ${segLabel(i)}` : o.label);
    if (!idleOn) bulbs(hl ? 'lit' : 'rest');
  }

  /** Dim every other slot and outline the winner (null clears). */
  function highlight(index) {
    if (index == null || !Number.isFinite(Number(index))) {
      hlIndex = null;
      applyHighlight();
      if (!spinning) setLabel(o.label);
      return;
    }
    hlIndex = mod(Math.trunc(Number(index)), n);
    applyHighlight();
    if (!spinning) setLabel(`The wheel landed on ${segLabel(hlIndex)}`);
  }

  /** Marquee chase while waiting for a spin (1.2 s 3-phase cycle). */
  function idle(on = true) {
    idleOn = !!on;
    if (spinning) return;
    bulbs(idleOn ? 'chase' : hlIndex == null ? 'rest' : 'lit');
  }

  /** Replace the segment definitions (keeps rotation and highlight). */
  function setSegments(next) {
    if (!Array.isArray(next) || next.length < 2) return;
    const same =
      next.length === segs.length &&
      next.every((s, i) => {
        const p = segs[i];
        return (
          p &&
          s.color === p.color &&
          s.ink === p.ink &&
          s.icon === p.icon &&
          s.label === p.label &&
          s.trim === p.trim &&
          s.pattern === p.pattern &&
          String(s.lines) === String(p.lines)
        );
      });
    segs = next;
    if (same) return;
    n = segs.length;
    build();
  }

  function destroy() {
    cancelSpin();
    clearTimeout(bulbTimer);
    svgEl.innerHTML = '';
  }

  build();
  setLabel(o.label);
  bulbs('rest');

  return {
    spinTo,
    restOn,
    highlight,
    idle,
    bulbs,
    setSegments,
    destroy,
    cancel: cancelSpin,
    /** Current rotor rotation in degrees (for tests/debug). */
    get rotation() {
      return rotation;
    },
    get spinning() {
      return spinning;
    },
    get index() {
      return spinning ? indexAtRotation(rotation, n) : restingIndex;
    },
    get segments() {
      return segs;
    },
    el: svgEl,
  };
}
