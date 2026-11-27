// Christmas Chaos — wheel.js
// The 12-slot marquee wheel, drawn exactly like the artboards (viewBox -400 -410 800 800):
// slots r=340 with tangential Lilita labels (upright when the slot is under the pointer), Lucide icon
// per slot, gold rim r=352 (22 wide) with 12 lit + 12 dark marquee bulbs, night hub with the snowflake
// mark, cream pointer wedge at 12 o'clock. Landed: other slots dim to 50%, winner gets a 6 px cream outline.
//
//   const wheel = createWheel(svgEl, state.segments);
//   wheel.restOn(state.lastSegmentIndex);                    // refresh-safe resting position
//   wheel.spinTo(spin.segmentIndex, spin.durationMs, {       // lands EXACTLY centred on the index
//     startedAt: spin.startedAt, clockOffset: client.clockOffset, onTick: () => sound.tick() });
//   wheel.highlight(i | null); wheel.idle(true);            // gentle bulb chase while waiting
//
// The pure math (planSpin / rotationAt / restRotation / tickCount …) is exported for tests.

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

/** The SPEC §2 wheel. The live app always passes the server's `segments`; this is the fallback/demo set. */
export const DEFAULT_SEGMENTS = Object.freeze(
  [
    ['christmas', 'Christmas Trivia', ['CHRISTMAS', 'TRIVIA'], '#C8232C', '#FFF6E5', 'tree-pine'],
    ['dare', 'Dare', ['DARE'], '#F5B82E', '#1A1206', 'drama'],
    ['popculture', 'Pop Culture', ['POP', 'CULTURE'], '#1F6FD1', '#FFF6E5', 'clapperboard'],
    ['hotseat', 'Hot Seat', ['HOT', 'SEAT'], '#D63384', '#FFF6E5', 'flame'],
    ['christmas', 'Christmas Trivia', ['CHRISTMAS', 'TRIVIA'], '#C8232C', '#FFF6E5', 'tree-pine'],
    ['sounditout', 'Sound It Out', ['SOUND', 'IT OUT'], '#7A4FD3', '#FFF6E5', 'music'],
    ['grinch', 'Grinch Steal', ['GRINCH', 'STEAL'], '#FFF6E5', '#0B1F17', 'hand-coins'],
    ['showdown', 'Showdown', ['SHOWDOWN'], '#8FD8FF', '#0B1F17', 'swords'],
    ['dare', 'Dare', ['DARE'], '#F5B82E', '#1A1206', 'drama'],
    ['rapidlist', 'Rapid List', ['RAPID', 'LIST'], '#0B8A75', '#FFF6E5', 'list-checks'],
    ['allplay', 'All Play', ['ALL', 'PLAY'], '#F2731D', '#0B1F17', 'zap'],
    ['doubledown', 'Double Down', ['DOUBLE', 'DOWN'], '#1E8A4C', '#FFF6E5', 'sparkles'],
  ].map(([type, label, lines, color, ink, icon], index) => Object.freeze({ index, type, label, lines, color, ink, icon }))
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

// Advance widths of Lilita One glyphs in em (measured in Edge with the bundled woff2).
const LILITA_W = {
  A: 0.66, B: 0.59, C: 0.56, D: 0.62, E: 0.49, F: 0.47, G: 0.62, H: 0.64, I: 0.43, J: 0.46, K: 0.62, L: 0.44, M: 0.91,
  N: 0.65, O: 0.7, P: 0.57, Q: 0.71, R: 0.59, S: 0.53, T: 0.5, U: 0.63, V: 0.66, W: 0.95, X: 0.68, Y: 0.62, Z: 0.56,
  0: 0.64, 1: 0.41, 2: 0.53, 3: 0.53, 4: 0.6, 5: 0.52, 6: 0.58, 7: 0.5, 8: 0.57, 9: 0.57,
  ' ': 0.19, "'": 0.3, '’': 0.31, '&': 0.67, '!': 0.29, '?': 0.58, '-': 0.53, '.': 0.23, ',': 0.31, ':': 0.28, '×': 0.61,
};

/** Estimated width of an upper-case label in em of Lilita One. */
export function labelWidthEm(text) {
  let w = 0;
  for (const ch of String(text)) w += LILITA_W[ch] ?? 0.62;
  return w;
}

/** Usable label width (viewBox units) at a baseline y for a text of `size`, inside a slot of an n-slot wheel. */
export function labelRoom(y, size, n = 12) {
  const r = Math.abs(y) + size * 0.35; // vertical middle of the caps
  return 2 * r * Math.tan(Math.PI / n) * 0.96;
}

/** Font size + baselines for a slot's label, matching the artboards (1 line: 32 @ -232; 2 lines: 25 @ -246/-218). */
export function labelLayout(lines, n = 12) {
  const spec =
    lines.length <= 1
      ? { size: 32, ys: [-232] }
      : lines.length === 2
        ? { size: 25, ys: [-246, -218] }
        : { size: 21, ys: [-256, -232, -208] };
  return lines.map((text, k) => {
    const y = spec.ys[k];
    const w = labelWidthEm(text);
    // room depends on the size (taller caps sit on a wider chord), so settle it in a few passes
    let size = spec.size;
    for (let pass = 0; pass < 4 && w > 0; pass++) {
      size = Math.max(14, Math.min(spec.size, Math.floor((labelRoom(y, size, n) / w) * 10) / 10));
    }
    return { text, y, size, room: +labelRoom(y, size, n).toFixed(1) };
  });
}

/* ------------------------------------------------------------------ rendering ---------------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const f2 = (x) => +x.toFixed(2);

const R_BG = 364;
const R_SLOT = 340;
const R_RIM = 352;
const R_HUB = 62;
const BULB = { lit: '#FFF6E5', dark: '#7A4A00', halo: '#FFE08A' };
const FONT = "'Lilita One', 'Arial Rounded MT Bold', 'Arial Black', sans-serif";

function slotPath(n) {
  const h = Math.PI / n;
  const x = f2(R_SLOT * Math.sin(h));
  const y = f2(-R_SLOT * Math.cos(h));
  return { wedge: `M0 0 L${-x} ${y} A${R_SLOT} ${R_SLOT} 0 0 1 ${x} ${y} Z`, rest: `M0 0 L${x} ${y} A${R_SLOT} ${R_SLOT} 0 1 1 ${-x} ${y} Z` };
}

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

function slotMarkup(seg, i, n, wedge) {
  const color = safeColor(seg?.color, '#1B4636');
  const ink = safeColor(seg?.ink, '#FFF6E5');
  const iconInner = ICONS[seg?.icon] || '';
  const lines = labelLayout(labelLines(seg), n);
  const text = lines
    .map(
      (l) =>
        `<text x="0" y="${l.y}" text-anchor="middle" font-family="${FONT}" font-size="${l.size}" fill="${ink}" data-room="${l.room}">${esc(l.text)}</text>`
    )
    .join('');
  const ic = iconInner
    ? `<svg class="wheel__icon" x="-21" y="-318" width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconInner}</svg>`
    : '';
  return `<g class="wheel__slot" data-index="${i}" transform="rotate(${f2(i * slotDeg(n))})"><path d="${wedge}" fill="${color}" stroke="#0B1F17" stroke-width="3"/>${ic}${text}</g>`;
}

/** Static markup of the whole wheel (no state). Exported so pages/tests can render a wheel without JS motion. */
export function wheelMarkup(segments = DEFAULT_SEGMENTS) {
  const segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  const n = segs.length;
  const { wedge, rest } = slotPath(n);
  const slots = segs.map((s, i) => slotMarkup(s, i, n, wedge)).join('');

  // Motion streaks around the outside (from the Spinning artboard) and soft blur arcs over the face.
  const streakSpec = [
    [384, 10, 56, '#FFC93C'], [404, 62, 96, '#FFF6E5'], [388, 104, 160, '#FFF6E5'],
    [410, 184, 214, '#FFC93C'], [386, 214, 268, '#FFC93C'], [404, 282, 322, '#FFF6E5'],
  ];
  const streaks = streakSpec
    .map(([r, a, b, c]) => {
      const len = b - a;
      return [0.14, 0.26, 0.5]
        .map((op, k) => `<path d="${arc(r, a + (len * k) / 3, b)}" stroke="${c}" stroke-width="6" opacity="${op}"/>`)
        .join('');
    })
    .join('');
  const blur = [
    [300, 20, 72], [300, 200, 252], [236, 112, 158], [236, 292, 338], [170, 40, 88], [170, 220, 268],
  ]
    .map(([r, a, b]) => `<path d="${arc(r, a, b)}"/>`)
    .join('');

  const bulbs = [];
  const halos = [];
  for (let k = 0; k < 2 * n; k++) {
    const [x, y] = polar(R_RIM, k * (slotDeg(n) / 2));
    halos.push(`<circle class="wheel__halo" cx="${x}" cy="${y}" r="14" fill="${BULB.halo}"/>`);
    bulbs.push(`<circle class="wheel__bulb" data-set="${k % 2 ? 'b' : 'a'}" cx="${x}" cy="${y}" r="6" fill="${BULB.lit}"/>`);
  }

  const snow = ICONS.snowflake;
  return (
    `<g class="wheel__streaks" fill="none" stroke-linecap="round" opacity="0">${streaks}</g>` +
    `<circle class="wheel__bg" r="${R_BG}" fill="#0B1F17"/>` +
    `<g class="wheel__rotor" transform="rotate(0)">` +
    `<g class="wheel__slots">${slots}</g>` +
    `<g class="wheel__hl" transform="rotate(0)" opacity="0" pointer-events="none">` +
    `<path class="wheel__dim" d="${rest}" fill="#0B1F17" opacity="0.5"/>` +
    `<path class="wheel__outline" d="${wedge}" fill="none" stroke="#FFF6E5" stroke-width="6" stroke-linejoin="round"/>` +
    `</g></g>` +
    `<g class="wheel__blur" fill="none" stroke="#FFF6E5" stroke-width="5" stroke-linecap="round" opacity="0">${blur}</g>` +
    `<circle class="wheel__rim" r="${R_RIM}" fill="none" stroke="#E8B53A" stroke-width="22"/>` +
    `<g class="wheel__halos" opacity="0">${halos.join('')}</g>` +
    `<g class="wheel__bulbs">${bulbs.join('')}</g>` +
    `<circle class="wheel__hub" r="${R_HUB}" fill="#0B1F17" stroke="#E8B53A" stroke-width="8"/>` +
    `<g class="wheel__hubicon" transform="rotate(0)"><svg x="-28" y="-28" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#FFC93C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${snow}</svg></g>` +
    `<g class="wheel__pointer" transform="rotate(0 0 -404)"><polygon points="-32,-404 32,-404 0,-334" fill="#FFF6E5" stroke="#0B1F17" stroke-width="5" stroke-linejoin="round"/></g>`
  );
}

/** Small static wheel glyph used inside the phone SPIN button (Phone-Spin artboard). */
export function miniWheelMarkup(segments = DEFAULT_SEGMENTS, { tilt = -8 } = {}) {
  const segs = Array.isArray(segments) && segments.length >= 2 ? segments : DEFAULT_SEGMENTS;
  const n = segs.length;
  const h = Math.PI / n;
  const x = f2(88 * Math.sin(h));
  const y = f2(-88 * Math.cos(h));
  const wedges = segs
    .map(
      (s, i) =>
        `<path transform="rotate(${f2(i * slotDeg(n))})" d="M0 0 L${-x} ${y} A88 88 0 0 1 ${x} ${y} Z" fill="${safeColor(s?.color, '#1B4636')}" stroke="#0B1F17" stroke-width="2"/>`
    )
    .join('');
  const dots = Array.from({ length: n }, (_, k) => {
    const [cx, cy] = polar(94, k * slotDeg(n));
    return `<circle cx="${cx}" cy="${cy}" r="3.6"/>`;
  }).join('');
  return (
    `<svg class="mini-wheel" viewBox="-110 -122 220 232" aria-hidden="true" focusable="false">` +
    `<circle r="102" fill="#0B1F17"/><g transform="rotate(${Number(tilt) || 0})">${wedges}</g>` +
    `<circle r="94" fill="none" stroke="#E8B53A" stroke-width="12"/><g fill="#FFF6E5">${dots}</g>` +
    `<circle r="20" fill="#0B1F17" stroke="#E8B53A" stroke-width="5"/>` +
    `<polygon points="-14,-120 14,-120 0,-88" fill="#FFF6E5" stroke="#0B1F17" stroke-width="4" stroke-linejoin="round"/></svg>`
  );
}

/* ------------------------------------------------------------------ live wheel --------------- */

function prefersReducedMotion() {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const raf = (cb) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(cb) : setTimeout(() => cb(perfNow()), 16));
const caf = (id) => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id));

/**
 * Render the wheel into an <svg> element and return its controller.
 * @param {SVGSVGElement} svgEl
 * @param {Array<{index:number,label:string,lines?:string[],color:string,ink:string,icon:string}>} segments
 * @param {{label?:string, autoHighlight?:boolean, reducedMotion?:boolean, blinkMs?:number}} [opts]
 */
export function createWheel(svgEl, segments = DEFAULT_SEGMENTS, opts = {}) {
  if (!svgEl) throw new Error('createWheel: svg element required');
  const o = { label: 'The prize wheel', autoHighlight: true, blinkMs: 2200, ...opts };

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
  let bulbMode = 'rest';
  let idleOn = false;
  let kick = 0;
  let kickAt = 0;
  let pendingResolve = null; // resolver of the running spinTo() promise

  svgEl.setAttribute('viewBox', '-400 -410 800 800');
  svgEl.setAttribute('role', 'img');
  svgEl.classList.add('wheel');
  if (!svgEl.getAttribute('xmlns')) svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  let el = {};
  function build() {
    svgEl.innerHTML = wheelMarkup(segs);
    const q = (s) => svgEl.querySelector(s);
    el = {
      rotor: q('.wheel__rotor'),
      hl: q('.wheel__hl'),
      hub: q('.wheel__hubicon'),
      pointer: q('.wheel__pointer'),
      streaks: q('.wheel__streaks'),
      blur: q('.wheel__blur'),
      halos: q('.wheel__halos'),
      bulbs: [...svgEl.querySelectorAll('.wheel__bulb')],
      haloEls: [...svgEl.querySelectorAll('.wheel__halo')],
    };
    applyRotation(rotation);
    applyHighlight();
    applyBulbs(bulbMode, 0);
    fitLabels();
  }

  // Re-fit labels with real measurements (handles a fallback font if Lilita One failed to load).
  function fitLabels() {
    for (const t of svgEl.querySelectorAll('text[data-room]')) {
      try {
        const room = Number(t.dataset.room);
        const base = Number(t.dataset.size) || Number(t.getAttribute('font-size')) || 25;
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
    el.pointer?.setAttribute('transform', `rotate(${+deg.toFixed(2)} 0 -404)`);
  }

  function setMotion(level) {
    const v = Math.max(0, Math.min(1, level));
    el.streaks?.setAttribute('opacity', String(+v.toFixed(3)));
    el.blur?.setAttribute('opacity', String(+(v * 0.2).toFixed(3)));
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

  // Bulb looks, straight from the artboards:
  //   rest  — Main: a-set lit (r6), b-set dark (r5), no halos
  //   chase — Turn intro: alternate sets lit (r7 + halo) every 450 ms
  //   spin  — Spinning: every bulb lit (r7 + halo)
  //   lit   — Landed: every bulb lit (r7), no halo
  //   blink — celebration after landing: lit <-> rest every 200 ms, then lit
  function paintBulbs(litFn, rLit, rDark, halo) {
    el.bulbs.forEach((b, k) => {
      const on = litFn(k);
      b.setAttribute('fill', on ? BULB.lit : BULB.dark);
      b.setAttribute('r', String(on ? rLit : rDark));
      if (el.haloEls[k]) el.haloEls[k].setAttribute('opacity', on && halo ? '1' : '0');
    });
    el.halos?.setAttribute('opacity', halo ? '0.34' : '0');
  }

  function applyBulbs(mode, phase) {
    if (!el.bulbs?.length) return;
    switch (mode) {
      case 'chase':
        paintBulbs((k) => k % 2 === phase % 2, 7, 5, true);
        break;
      case 'spin':
        paintBulbs(() => true, 7, 7, true);
        break;
      case 'lit':
        paintBulbs(() => true, 7, 7, false);
        break;
      case 'blink':
        if (phase % 2) paintBulbs((k) => k % 2 === 0, 6, 5, false);
        else paintBulbs(() => true, 7, 7, true);
        break;
      default:
        paintBulbs((k) => k % 2 === 0, 6, 5, false);
    }
  }

  function bulbs(mode = 'rest') {
    clearInterval(bulbTimer);
    bulbTimer = 0;
    bulbMode = mode;
    svgEl.dataset.bulbs = mode;
    applyBulbs(mode, 0);
    const reduce = o.reducedMotion ?? prefersReducedMotion();
    if (reduce) {
      if (mode === 'blink') bulbs('lit');
      return;
    }
    if (mode === 'chase' || mode === 'blink') {
      let phase = 0;
      const started = perfNow();
      bulbTimer = setInterval(
        () => {
          phase++;
          if (mode === 'blink' && perfNow() - started > o.blinkMs) {
            bulbs(idleOn ? 'chase' : 'lit');
            return;
          }
          applyBulbs(mode, phase);
        },
        mode === 'chase' ? 450 : 200
      );
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

    const land = () => {
      spinning = false;
      svgEl.classList.remove('is-spinning');
      settle(target);
      if (o.autoHighlight) {
        hlIndex = target;
        applyHighlight();
      }
      setLabel(`The wheel landed on ${segLabel(target)}`);
      bulbs('blink');
      try {
        onDone?.(target);
      } catch (e) {
        console.error(e);
      }
    };

    if (clock() >= plan.startedAt + plan.durationMs) {
      land();
      return Promise.resolve(true);
    }

    spinning = true;
    svgEl.classList.add('is-spinning');
    setLabel('The wheel is spinning');
    bulbs('spin');
    let lastTick = tickCount(rotationAt(plan, clock()).rotation, n);
    const peak = speedAt(plan, 0) || 1;

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
          land();
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
        // pointer flapper: kicked back by each boundary, springs home in ~110 ms
        const since = perfNow() - kickAt;
        const flap = kick * Math.exp(-since / 55);
        setPointer(reduce ? 0 : -16 * flap);
        const sp = speedAt(plan, progress) / peak;
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

  /** Gentle marquee chase while waiting for a spin. */
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
        return p && s.color === p.color && s.ink === p.ink && s.icon === p.icon && s.label === p.label && String(s.lines) === String(p.lines);
      });
    segs = next;
    if (same) return;
    n = segs.length;
    build();
  }

  function destroy() {
    cancelSpin();
    clearInterval(bulbTimer);
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
