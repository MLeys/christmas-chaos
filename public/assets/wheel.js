// Christmas Chaos — wheel.js
// The 12-slot candy-cane prize wheel, North Pole Workshop (docs/design/NORTH-POLE.md §4, the approved TV concept
// public/concepts/north-pole-tv.html), drawn in a -380..380 viewBox (1 unit = 1 px at 760 px):
//   red/white candy-cane rim (r 308–334, white edge) · white gutter · 12 bright slots (r=300, 4 px white seams) with
//   the 3D slot art near the rim and RADIAL Bagel Fat One labels running from the rim towards the centre ·
//   pattern:'candy' slots get candy stripes + a white label pill · peppermint hub (stripes turn with the wheel)
//   with Santa on top · a gold 3D star pointer at 12 o'clock that rocks on every tick.
//   Stopped: the other slots wash out (opacity .82 over white + 25 % desaturate) and the winner gets a white outline.
//
//   const wheel = createWheel(svgEl, state.segments, { lights: garland });   // garland chases with the wheel
//   wheel.restOn(state.lastSegmentIndex);                    // refresh-safe resting position
//   wheel.spinTo(spin.segmentIndex, spin.durationMs, {       // lands EXACTLY centred on the index
//     startedAt: spin.startedAt, clockOffset: client.clockOffset, onTick: () => sound.tick(), tease: true });
//   wheel.highlight(i | null); wheel.idle(true);            // lights chase while waiting
//   wheel.bulbs('rest' | 'chase' | 'spin' | 'lit' | 'blink' | 'off');   // drives svg[data-bulbs] + the lights
//
// The wheel has no bulbs of its own any more: the garland (sky.js) is the light show. bulbs() still sets
// svg[data-bulbs] / svg[data-phase] (the star pointer glints on 'blink') and forwards every mode + phase step to
// the attached lights. The pure math (planSpin / rotationAt / restRotation / tickCount …) is exported for tests.

import { ICONS, safeColor, artSrc, hasArt } from './icons.js';

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

const easeInOutSine = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
const easeOutCubic = (t) => 1 - (1 - clamp01(t)) ** 3;

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
 * The comedy tease (COMEDY.md §3), as fractions of the spin and of a slot. The wheel slows to a stop in the slot
 * BEFORE the winner, just short of the peg (STOP), creeps up to the peg and hangs there teetering (HANG), then tips
 * over and drops into the centre of the real slot. Purely visual: the end rotation is still exactly restRotation().
 */
export const TEASE = Object.freeze({ stopAt: 0.74, hangAt: 0.9, stopSlots: 0.66, hangSlots: 0.53 });

/**
 * Plan a spin. All times are in ONE clock (use server ms: startedAt from state.spin, now = Date.now()+offset).
 * tease: true plays the creep-and-hang ending (ignored when the spin is shorter than two slots).
 * @returns {{from:number,to:number,index:number,n:number,startedAt:number,durationMs:number,tease:boolean}}
 */
export function planSpin({ from = 0, index, n = 12, durationMs = 5000, turns = DEFAULT_TURNS, startedAt, now = 0, tease = false }) {
  const i = mod(Math.trunc(Number(index) || 0), n);
  const dur = Math.max(0, Number(durationMs) || 0);
  const start = Number.isFinite(startedAt) ? startedAt : now;
  const to = spinTarget(from, i, n, turns);
  return { from, to, index: i, n, startedAt: start, durationMs: dur, tease: !!tease && to - from >= 2 * slotDeg(n) };
}

/** Rotation (absolute degrees) at progress p in [0,1) of a plan. Monotonic in p for both endings. */
function curveAt(plan, p) {
  if (!plan.tease) return plan.from + (plan.to - plan.from) * easeOutQuart(p);
  const s = slotDeg(plan.n);
  const stop = plan.to - TEASE.stopSlots * s; // resting in the slot before the winner, short of the peg
  const hang = plan.to - TEASE.hangSlots * s; // right up against the peg
  if (p < TEASE.stopAt) return plan.from + (stop - plan.from) * easeOutQuart(p / TEASE.stopAt);
  if (p < TEASE.hangAt) return stop + (hang - stop) * easeInOutSine((p - TEASE.stopAt) / (TEASE.hangAt - TEASE.stopAt));
  return hang + (plan.to - hang) * easeOutCubic((p - TEASE.hangAt) / (1 - TEASE.hangAt));
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
  return { rotation: curveAt(plan, p), progress: p, done: false };
}

/** Angular speed (deg per ms) at progress p. */
export function speedAt(plan, progress) {
  if (plan.durationMs <= 0) return 0;
  if (!plan.tease) {
    const u = 1 - clamp01(progress);
    return ((plan.to - plan.from) * 4 * u * u * u) / plan.durationMs;
  }
  const p = clamp01(progress);
  const h = 1e-4;
  const a = curveAt(plan, Math.max(0, p - h));
  const b = curveAt(plan, Math.min(1 - 1e-9, p + h));
  return (b - a) / (Math.min(1 - 1e-9, p + h) - Math.max(0, p - h)) / plan.durationMs;
}

/* ------------------------------------------------------------------ segments ----------------- */

/** The wheel the server sends (src/game.js SEGMENTS). The live app always passes state.segments; this is the demo set. */
export const DEFAULT_SEGMENTS = Object.freeze(
  [
    ['trivia', 'Christmas Trivia', ['Christmas', 'Trivia'], '#D42A2A', '#FFFFFF', 'tree-pine', 'tree'],
    ['dare', 'Dare', ['Dare'], '#EDB321', '#1C2333', 'drama', 'masks'],
    ['trivia', 'Pop Culture', ['Pop', 'Culture'], '#2E6FD1', '#FFFFFF', 'clapperboard', 'clapper'],
    ['hotseat', 'Hot Seat', ['Hot', 'Seat'], '#E9558A', '#FFFFFF', 'flame', 'fire'],
    ['trivia', 'Christmas Movies', ['Christmas', 'Movies'], '#9E1B32', '#FFFFFF', 'popcorn', 'popcorn'],
    ['sounditout', 'Sound It Out', ['Sound', 'It Out'], '#7B4BC9', '#FFFFFF', 'music', 'music'],
    ['grinch', 'Grinch Steal', ['Grinch', 'Steal'], '#7CB518', '#1C2333', 'hand-coins', 'money'],
    ['showdown', 'Showdown', ['Show', 'Down'], '#8ECAE6', '#1C2333', 'swords', 'boxing'],
    ['dare', 'Dare', ['Dare'], '#EDB321', '#1C2333', 'drama', 'masks'],
    ['rapidlist', 'Rapid List', ['Rapid', 'List'], '#1F7A4A', '#FFFFFF', 'list-checks', 'list'],
    ['allplay', 'All Play', ['All', 'Play'], '#F28C28', '#1C2333', 'zap', 'zap'],
    ['doubledown', 'Double Down', ['Double', 'Down'], '#FFFFFF', '#1C2333', 'sparkles', 'sparkles', { pattern: 'candy', stripe: '#D42A2A' }],
  ].map(([type, label, lines, color, ink, icon, art, extra], index) => Object.freeze({ index, type, label, lines, color, ink, icon, art, ...(extra || {}) }))
);

/** Label lines as given (sentence/title case): the server's `lines`, else the label split into two balanced lines. */
export function labelLines(seg) {
  if (Array.isArray(seg?.lines) && seg.lines.length) {
    return seg.lines.slice(0, 3).map((l) => String(l));
  }
  const words = String(seg?.label ?? '').trim().split(/\s+/).filter(Boolean);
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

// Advance widths in em of Bagel Fat One 400, measured in Edge with the bundled woff2 (canvas measureText at
// 100 px). It is the display face (wheel labels, headlines, scores, splash words) and has both cases.
const BAGEL = {
  A: 0.709, B: 0.644, C: 0.662, D: 0.661, E: 0.614, F: 0.593, G: 0.707, H: 0.672, I: 0.275, J: 0.582, K: 0.645, L: 0.595, M: 0.83,
  N: 0.686, O: 0.706, P: 0.629, Q: 0.709, R: 0.643, S: 0.644, T: 0.675, U: 0.664, V: 0.703, W: 0.93, X: 0.679, Y: 0.7, Z: 0.617,
  a: 0.551, b: 0.569, c: 0.518, d: 0.581, e: 0.526, f: 0.44, g: 0.554, h: 0.547, i: 0.245, j: 0.255, k: 0.596, l: 0.236, m: 0.804,
  n: 0.547, o: 0.558, p: 0.586, q: 0.569, r: 0.482, s: 0.54, t: 0.519, u: 0.548, v: 0.537, w: 0.819, x: 0.558, y: 0.554, z: 0.526,
  0: 0.621, 1: 0.468, 2: 0.621, 3: 0.603, 4: 0.693, 5: 0.608, 6: 0.59, 7: 0.603, 8: 0.639, 9: 0.59,
  ' ': 0.18, "'": 0.27, '’': 0.275, '&': 0.72, '!': 0.432, '?': 0.522, '-': 0.522, '.': 0.297, ',': 0.297, ':': 0.36, '×': 0.72, '+': 0.657,
  _: 0.6,
};
const GLYPH_W = { display: BAGEL, label: BAGEL, marquee: BAGEL };

/** Estimated width of a string in em. face: 'display' / 'label' (both Bagel Fat One; 'marquee' is an old alias). */
export function textWidthEm(text, face = 'display') {
  const t = GLYPH_W[face] || BAGEL;
  let w = 0;
  for (const ch of String(text)) w += t[ch] ?? t._;
  return w;
}

/** Width of a wheel label in em of Bagel Fat One (the wheel's label face). */
export function labelWidthEm(text) {
  return textWidthEm(text, 'label');
}

/** Width of a giant display word in em of Bagel Fat One (var(--font-display)). */
export function displayWidthEm(text) {
  return textWidthEm(text, 'display');
}

/* Radial label geometry (the TV concept): text starts at r=LABEL_START and runs towards the centre; two lines sit
   13 / 15 units either side of the slot's centre line, one line on it. */
export const LABEL_START = 222;
const LABEL_SIZE = 25;
const HUB_CLEAR = 72; // labels stop short of the hub (white r=64)

/** Usable label length (viewBox units) for a line `offset` units off the slot's centre line at font `size`. */
export function labelRoom(offset, size, n = 12) {
  const tan = Math.tan(Math.PI / n);
  const innermost = (Math.abs(offset) + size * 0.42) / tan; // where the slot gets too narrow for this line
  return Math.max(0, LABEL_START - Math.max(HUB_CLEAR, innermost));
}

/** Font size + tangential offsets for a slot's label (Bagel Fat One 25; 2 lines at -13/+15, 1 line at +1). */
export function labelLayout(lines, n = 12) {
  const spec =
    lines.length <= 1
      ? { size: LABEL_SIZE, offs: [1] }
      : lines.length === 2
        ? { size: LABEL_SIZE, offs: [-13, 15] }
        : { size: 20, offs: [-21, 1, 23] };
  return lines.map((text, k) => {
    const offset = spec.offs[k];
    const w = labelWidthEm(text);
    let size = spec.size;
    for (let pass = 0; pass < 4 && w > 0; pass++) {
      size = Math.max(12, Math.min(spec.size, Math.floor((labelRoom(offset, size, n) / w) * 10) / 10));
    }
    return { text, offset, size, start: LABEL_START, room: +labelRoom(offset, size, n).toFixed(1) };
  });
}

/* ------------------------------------------------------------------ rendering ---------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const f2 = (x) => +x.toFixed(2);

export const VIEWBOX = '-380 -380 760 760';
export const R_SLOT = 300;
export const R_GUTTER = 308;
export const R_RIM = 334;
const R_HUB = 64;
const WHITE = '#FFFFFF';
const INK = '#1C2333';
const CANDY = '#D42A2A';
const FONT = "'Bagel Fat One', 'Arial Rounded MT Bold', system-ui, sans-serif";
const ART_SIZE = 54;
const ART_Y = -(R_SLOT - 12); // -288: the art sits just inside the rim
/** The gold star pointer: a 5-point star centred at (0,-336) (shadow / hit shape; the 3D star.png sits on it). */
export const POINTER_PATH = 'M0 -374 L11.17 -351.37 L36.14 -347.74 L18.07 -330.13 L22.34 -305.26 L0 -317 L-22.34 -305.26 L-18.07 -330.13 L-36.14 -347.74 L-11.17 -351.37 Z';
const POINTER_PIVOT = '0 -306';

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

/** Diagonal candy-cane stripes: `stripe` on white. */
function stripePattern(id, { size = 40, band = 16, angle = 45, stripe = CANDY } = {}) {
  return `<pattern id="${id}" width="${size}" height="${size}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><rect width="${size}" height="${size}" fill="${WHITE}"/><rect width="${band}" height="${size}" fill="${stripe}"/></pattern>`;
}

function defs(p) {
  return (
    `<defs>` +
    stripePattern(`${p}-rim`, { size: 34, band: 14, angle: 30 }) +
    stripePattern(`${p}-mint`, { size: 22, band: 9, angle: 45 }) +
    `<radialGradient id="${p}-shadow"><stop offset=".86" stop-color="${INK}" stop-opacity=".2"/><stop offset="1" stop-color="${INK}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="${p}-hubshadow"><stop offset=".78" stop-color="${INK}" stop-opacity=".22"/><stop offset="1" stop-color="${INK}" stop-opacity="0"/></radialGradient>` +
    `</defs>`
  );
}

function slotArt(seg, ink) {
  if (seg?.art && hasArt(seg.art)) {
    return `<image class="wheel__art" href="${artSrc(seg.art)}" x="${-ART_SIZE / 2}" y="${ART_Y}" width="${ART_SIZE}" height="${ART_SIZE}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const inner = ICONS[seg?.icon];
  if (!inner) return '';
  return `<svg class="wheel__icon" x="-21" y="${ART_Y + 6}" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function slotMarkup(seg, i, n, p) {
  const candy = seg?.pattern === 'candy';
  const color = safeColor(seg?.color, '#2E6FD1');
  const ink = safeColor(seg?.ink, WHITE);
  const lines = labelLayout(labelLines(seg), n);
  const wedge = wedgePath(R_SLOT, n);
  const parts = [];
  let extraDefs = '';
  if (candy) {
    const pid = `${p}-cane${i}`;
    extraDefs = `<defs>${stripePattern(pid, { stripe: safeColor(seg?.stripe, CANDY) })}</defs>`;
    parts.push(`<path class="wheel__face" d="${wedge}" fill="url(#${pid})" stroke="${WHITE}" stroke-width="4" stroke-linejoin="round"/>`);
  } else {
    parts.push(`<path class="wheel__face" d="${wedge}" fill="${color}" stroke="${WHITE}" stroke-width="4" stroke-linejoin="round"/>`);
  }
  parts.push(slotArt(seg, ink));
  if (candy && lines.length) {
    // white label pill (radial, like the label) so the words never sit on the stripes
    const longest = Math.max(...lines.map((l) => labelWidthEm(l.text) * l.size), 40);
    const offs = lines.map((l) => l.offset);
    const half = (Math.max(...offs) - Math.min(...offs)) / 2 + lines[0].size * 0.62;
    const mid = (Math.max(...offs) + Math.min(...offs)) / 2;
    const top = -(LABEL_START + 9);
    const len = Math.min(LABEL_START - HUB_CLEAR + 14, longest + 18);
    // the text frame is rotated 90deg: text-y +offset -> slot-x -offset
    parts.push(`<rect class="wheel__pill" x="${f2(-mid - half)}" y="${top}" width="${f2(half * 2)}" height="${f2(len)}" rx="${f2(Math.min(half, 16))}" fill="${color}"/>`);
  }
  for (const l of lines) {
    parts.push(
      `<text class="wheel__label" transform="rotate(90)" x="${-l.start}" y="${l.offset}" dominant-baseline="middle" font-family="${FONT}" font-size="${l.size}" fill="${ink}" data-room="${l.room}">${esc(l.text)}</text>`
    );
  }
  return `<g class="wheel__slot" data-index="${i}" transform="rotate(${f2(i * slotDeg(n))})">${extraDefs}${parts.join('')}</g>`;
}

function hubMarkup(p) {
  return (
    `<circle class="wheel__hubshadow" cx="0" cy="7" r="${R_HUB + 12}" fill="url(#${p}-hubshadow)"/>` +
    `<circle class="wheel__hub" r="${R_HUB}" fill="${WHITE}"/>` +
    `<g class="wheel__hubicon" transform="rotate(0)"><circle r="54" fill="url(#${p}-mint)"/></g>` +
    `<circle r="54" fill="none" stroke="${INK}" stroke-opacity=".08" stroke-width="1.5"/>` +
    `<circle r="27" fill="${WHITE}"/>` +
    `<image class="wheel__santa" href="${artSrc('santa')}" x="-25" y="-25" width="50" height="50"/>`
  );
}

function pointerMarkup() {
  return (
    `<g class="wheel__pointer" transform="rotate(0 ${POINTER_PIVOT})">` +
    `<path class="wheel__pointer-shadow" d="${POINTER_PATH}" fill="${INK}" fill-opacity=".2" stroke="${INK}" stroke-opacity=".2" stroke-width="6" stroke-linejoin="round" transform="translate(0 9)"/>` +
    `<path class="wheel__pointer-base" d="${POINTER_PATH}" fill="#EDB321" stroke="#C48A0A" stroke-width="5" stroke-linejoin="round"/>` +
    `<image class="wheel__star" href="${artSrc('star')}" x="-44" y="-382" width="88" height="88"/>` +
    `</g>`
  );
}

/**
 * Static markup of the whole wheel (no state). Exported so pages/tests can render a wheel without JS motion.
 * @param {Array} segments
 * @param {{id?:string}} [opts] id prefix for pattern/gradient ids (unique per wheel on the page)
 */
export function wheelMarkup(segments = DEFAULT_SEGMENTS, { id } = {}) {
  const segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  const n = segs.length;
  const p = String(id || `ccw${++uid}`).replace(/[^\w-]/g, '');
  const slots = segs.map((s, i) => slotMarkup(s, i, n, p)).join('');
  // soft motion streaks over the face while spinning fast
  const blur = [[286, 20, 72], [286, 200, 252], [226, 112, 158], [226, 292, 338], [160, 40, 88], [160, 220, 268]]
    .map(([r, a, b]) => `<path d="${arc(r, a, b)}"/>`)
    .join('');
  return (
    defs(p) +
    `<circle class="wheel__shadow" cx="0" cy="16" r="${R_RIM + 26}" fill="url(#${p}-shadow)"/>` +
    `<circle class="wheel__rim" r="${R_RIM}" fill="url(#${p}-rim)"/>` +
    `<circle class="wheel__rim-edge" r="${R_RIM - 2}" fill="none" stroke="${WHITE}" stroke-width="5"/>` +
    `<circle class="wheel__gutter" r="${R_GUTTER}" fill="${WHITE}"/>` +
    `<g class="wheel__rotor" transform="rotate(0)">` +
    `<g class="wheel__slots">${slots}</g>` +
    `<g class="wheel__hl" transform="rotate(0)" opacity="0" pointer-events="none">` +
    `<path class="wheel__dim" d="${restPath(R_SLOT + 2, n)}" fill="${WHITE}" fill-opacity=".18"/>` +
    `<path class="wheel__desat" d="${restPath(R_SLOT + 2, n)}" fill="#808080" fill-opacity=".25" style="mix-blend-mode:saturation"/>` +
    `<path class="wheel__outline" d="${wedgePath(R_SLOT, n)}" fill="none" stroke="${WHITE}" stroke-width="8" stroke-linejoin="round"/>` +
    `</g></g>` +
    `<g class="wheel__blur" fill="none" stroke="${WHITE}" stroke-width="5" stroke-linecap="round" opacity="0">${blur}</g>` +
    hubMarkup(p) +
    pointerMarkup()
  );
}

/** Small static wheel glyph (e.g. inside a phone SPIN button or a turn-intro hint). */
export function miniWheelMarkup(segments = DEFAULT_SEGMENTS, { tilt = -8 } = {}) {
  const segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  const n = segs.length;
  const h = Math.PI / n;
  const x = f2(84 * Math.sin(h));
  const y = f2(-84 * Math.cos(h));
  const p = `ccm${++uid}`;
  let pattern = stripePattern(`${p}-rim`, { size: 16, band: 7, angle: 30 });
  const wedges = segs
    .map((s, i) => {
      let fill = safeColor(s?.color, '#2E6FD1');
      if (s?.pattern === 'candy') {
        pattern += stripePattern(`${p}-cane`, { size: 14, band: 6, stripe: safeColor(s?.stripe, CANDY) });
        fill = `url(#${p}-cane)`;
      }
      return `<path transform="rotate(${f2(i * slotDeg(n))})" d="M0 0 L${-x} ${y} A84 84 0 0 1 ${x} ${y} Z" fill="${fill}" stroke="${WHITE}" stroke-width="2.5" stroke-linejoin="round"/>`;
    })
    .join('');
  return (
    `<svg class="mini-wheel" viewBox="-110 -124 220 234" aria-hidden="true" focusable="false"><defs>${pattern}</defs>` +
    `<circle r="100" fill="url(#${p}-rim)"/><circle r="99" fill="none" stroke="${WHITE}" stroke-width="3"/><circle r="88" fill="${WHITE}"/>` +
    `<g transform="rotate(${Number(tilt) || 0})">${wedges}</g>` +
    `<circle r="22" fill="${WHITE}"/><circle r="17" fill="${CANDY}"/><circle r="8" fill="${WHITE}"/>` +
    `<path d="M0 -122 L6.7 -108.4 L21.7 -106.2 L10.8 -95.6 L13.4 -80.7 L0 -87.7 L-13.4 -80.7 L-10.8 -95.6 L-21.7 -106.2 L-6.7 -108.4 Z" fill="#EDB321" stroke="#C48A0A" stroke-width="3" stroke-linejoin="round"/></svg>`
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

/** Light chase steps per second while spinning: follows the wheel's speed (fast spin → fast chase). */
export function chaseRate(speedFraction) {
  const s = Math.max(0, Math.min(1, Number(speedFraction) || 0));
  return 2.5 + 21.5 * s;
}

export const HIT_STOP_MS = 150;
export const FLASH_MS = 3 * 360;

/** Wheel bulb mode -> garland mode (sky.js garland()). */
export const LIGHT_MODES = Object.freeze({ rest: 'twinkle', chase: 'chase', spin: 'spin', lit: 'lit', blink: 'flash', off: 'off' });

/**
 * Render the wheel into an <svg> element and return its controller.
 * @param {SVGSVGElement} svgEl
 * @param {Array<{index:number,label:string,lines?:string[],color:string,ink:string,icon:string,art?:string,pattern?:string,stripe?:string}>} segments
 * @param {{label?:string, autoHighlight?:boolean, reducedMotion?:boolean, lights?:object|object[]}} [opts]
 *   lights: one or more garland controllers (sky.js garland()) that follow the wheel's light modes and chase phase.
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
  const lights = new Set([].concat(o.lights || []).filter(Boolean));

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

  // Re-fit labels with real measurements (handles a fallback font if Bagel Fat One failed to load).
  function fitLabels() {
    for (const t of svgEl.querySelectorAll('text[data-room]')) {
      try {
        const room = Number(t.dataset.room);
        const base = Number(t.dataset.size) || Number(t.getAttribute('font-size')) || LABEL_SIZE;
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
    el.blur?.setAttribute('opacity', String(+(v * 0.22).toFixed(3)));
  }

  function forLights(fn) {
    for (const l of lights) {
      try {
        fn(l);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function setPhase(p) {
    if (p !== phase || svgEl.dataset.phase === undefined) {
      phase = p;
      svgEl.dataset.phase = String(p);
      forLights((l) => l.phase?.(p));
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
   * Light modes (CSS in tokens.css + the attached garlands do the animation, no per-bulb JS):
   *   rest  — lights twinkle gently           chase — idle 3-phase chase
   *   spin  — chase whose speed follows the wheel (JS advances data-phase while the rotor moves)
   *   lit   — everything bright (also the 150 ms hit-stop when the wheel lands)
   *   blink — 3 flashes after landing, then lit (or chase if idle)        off — dark
   */
  function bulbs(mode = 'rest') {
    clearTimeout(bulbTimer);
    bulbTimer = 0;
    svgEl.dataset.bulbs = mode;
    forLights((l) => l.mode?.(LIGHT_MODES[mode] || 'twinkle'));
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
      svgEl.classList.remove('is-teasing');
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
   * tease: true plays the creep-and-hang ending (svg gets .is-teasing for the last stretch); the landing is
   * still exact. On landing: the others wash out, the winner gets a white outline, a 150 ms hit-stop (lights
   * freeze lit) and then the lights flash 3 times.
   */
  function spinTo(index, durationMs = 5000, sopts = {}) {
    const { onTick, onDone, startedAt, clockOffset = 0, turns, tease = false } = sopts || {};
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
      tease: tease && !reduce,
    });

    const land = (celebrate = true) => {
      spinning = false;
      svgEl.classList.remove('is-spinning');
      svgEl.classList.remove('is-teasing');
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
        if (plan.tease) svgEl.classList.toggle('is-teasing', progress >= TEASE.stopAt);
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
        const sp = Math.max(0, speedAt(plan, progress)) / peak;
        // the lights chase with the wheel: one attribute write per phase step, CSS does the rest
        if (!reduce) {
          phaseAcc += (Math.min(100, p - lastPerf) / 1000) * chaseRate(sp);
          setPhase(Math.floor(phaseAcc) % 3);
        }
        lastPerf = p;
        // the star rocks back on each boundary and springs home in ~110 ms
        const since = p - kickAt;
        const flap = kick * Math.exp(-since / 55);
        setPointer(reduce ? 0 : -14 * flap);
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

  /** Wash out every other slot and outline the winner (null clears). */
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

  /** Lights chase while waiting for a spin. */
  function idle(on = true) {
    idleOn = !!on;
    if (spinning) return;
    bulbs(idleOn ? 'chase' : hlIndex == null ? 'rest' : 'lit');
  }

  /** Attach a garland (or anything with mode()/phase()) that should follow the wheel. Returns a detach function. */
  function attachLights(l) {
    if (!l) return () => {};
    lights.add(l);
    try {
      l.mode?.(LIGHT_MODES[svgEl.dataset.bulbs] || 'twinkle');
    } catch (e) {
      console.error(e);
    }
    return () => lights.delete(l);
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
          s.art === p.art &&
          s.label === p.label &&
          s.pattern === p.pattern &&
          s.stripe === p.stripe &&
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
    lights.clear();
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
    attachLights,
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
