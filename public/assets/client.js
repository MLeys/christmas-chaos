// Christmas Chaos — client.js
// Shared browser helpers for the TV, host and player pages.
//
//   import { connect, h, raw, esc, toast } from '/assets/client.js';
//   const client = connect('player');                      // or connect('host', { hostKey: pin })
//   client.onState((state) => render(state));               // state is pushed on every change
//   client.onFx((type, payload) => …);                      // one-shot sound/animation cues
//   const res = await client.emit('spin');                  // always resolves {ok, error?, ...}
//   el.innerHTML = h`<p>${player.name}</p>`;                // interpolations are HTML-escaped
//
// Pure helpers (esc, h, raw, formatPoints, timer math …) have no DOM access at import time, so node tests
// can import this module directly.

import { icon, teamDisc, isTrustedMarkup, safeColor } from './icons.js';

/* ================================================================== escaping & templates ====== */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** HTML-escape any value for text or attribute context. null/undefined -> ''. */
export function esc(value) {
  if (value == null) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);
}

/** Trusted markup wrapper. Behaves like a string (toString/valueOf), so `el.innerHTML = raw(x)` works. */
export class Raw {
  constructor(html) {
    this.html = String(html ?? '');
  }
  toString() {
    return this.html;
  }
  valueOf() {
    return this.html;
  }
  toJSON() {
    return this.html;
  }
}

/** Mark markup as trusted so h`` does not escape it. Only use with markup YOU built. */
export function raw(html) {
  return html instanceof Raw ? html : new Raw(html);
}

export function isRaw(v) {
  return v instanceof Raw;
}

function interp(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(interp).join('');
  if (typeof v === 'string' && isTrustedMarkup(v)) return v; // exact output of icon()/teamDisc()
  return esc(v);
}

/**
 * Tagged template that escapes every interpolation unless it is raw(), another h`` result, an array of
 * those, or the exact output of icon()/teamDisc(). null/undefined/false render nothing.
 * Returns a Raw (string-like): `el.innerHTML = h\`…\`` and nesting h`` inside h`` both work.
 */
export function h(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += interp(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Set an element's markup from h``/raw()/string-escaped text. Returns the element. */
export function setHTML(el, markup) {
  if (el) el.innerHTML = markup instanceof Raw ? markup.html : esc(markup);
  return el;
}

/* ================================================================== formatting ================ */

const MINUS = '−';

/** 1150 -> "1,150"; -50 -> "−50". Non-numbers render "0". */
export function formatPoints(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '0';
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return v < 0 ? MINUS + s : s;
}

/** 300 -> "+300"; -100 -> "−100"; 0 -> "0". */
export function formatDelta(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v === 0) return '0';
  return (v > 0 ? '+' : '') + formatPoints(v);
}

/** plural(1,'player') -> "1 player"; plural(3,'player') -> "3 players"; custom plural form optional. */
export function plural(n, word, pluralWord) {
  const v = Number(n) || 0;
  return `${v} ${v === 1 ? word : pluralWord ?? word + 's'}`;
}

/** possessive('Team Rudolph') -> "Team Rudolph’s"; possessive('The Grinches') -> "The Grinches’". */
export function possessive(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  return /s$/i.test(s) ? `${s}’` : `${s}’s`;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd". */
export function ordinal(n) {
  const v = Math.trunc(Number(n) || 0);
  const t = v % 100;
  const suffix = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${v}${suffix}`;
}

/** Natural list: ['A'] -> "A"; ['A','B'] -> "A or B"; ['A','B','C'] -> "A, B or C". */
export function listJoin(items, word = 'or') {
  const a = (items || []).map(String).filter(Boolean);
  if (a.length <= 1) return a[0] ?? '';
  return `${a.slice(0, -1).join(', ')} ${word} ${a[a.length - 1]}`;
}

/* ================================================================== timers ==================== */

/** Milliseconds left on a state.timer at server time `now` (0 when finished or missing). */
export function timerRemaining(timer, now = Date.now()) {
  if (!timer) return 0;
  const ms = timer.running ? Number(timer.endsAt) - now : Number(timer.remainingMs);
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/** Whole seconds shown on screen (ceil, so "1" shows until the very end). */
export function timerSeconds(timer, now = Date.now()) {
  return Math.ceil(timerRemaining(timer, now) / 1000);
}

/** "18" under a minute, "1:05" above. */
export function timerText(timer, now = Date.now()) {
  const s = timerSeconds(timer, now);
  if (s < 60) return String(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Fraction of time left, 0..1. */
export function timerFraction(timer, now = Date.now()) {
  if (!timer) return 0;
  const total = Number(timer.durationMs);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, timerRemaining(timer, now) / total));
}

/** The timer turns red (and beeps) in the last 5 seconds. */
export function timerWarn(timer, now = Date.now(), warnAtSeconds = 5) {
  const s = timerSeconds(timer, now);
  return s > 0 && s <= warnAtSeconds;
}

const RING_R = 54;
const RING_C = 2 * Math.PI * RING_R; // 339.29

/**
 * Timer ring markup (gold arc on a 12% cream track, number in Lilita; red in the last 5 s).
 * @param {object|null} timer  state.timer {running, endsAt, durationMs, remainingMs, label}
 * @param {number} now          server time (client.serverNow())
 * @param {{size?:number, unit?:string, ink?:boolean, className?:string}} [opts] size in design px (default 124)
 */
export function timerRing(timer, now = Date.now(), opts = {}) {
  const { size = 124, unit = 'SECONDS', ink = false, className = '' } = opts;
  const frac = timerFraction(timer, now);
  const secs = timerText(timer, now);
  const warn = timerWarn(timer, now);
  const paused = !!timer && !timer.running && timerRemaining(timer, now) > 0;
  const compact = Number(size) < 90; // phone-size rings drop the SECONDS label
  const cls = ['timer-ring', compact && 'timer-ring--compact', warn && 'is-warn', paused && 'is-paused', ink && 'timer-ring--ink', className]
    .filter(Boolean)
    .join(' ');
  const offset = (RING_C * (1 - frac)).toFixed(1);
  return h`<div class="${cls}" style="--ring-size:${+(Number(size) / 16 || 7.75).toFixed(4)}rem" role="timer" aria-label="${secs} seconds left" data-timer-ring>
  <svg viewBox="0 0 124 124" aria-hidden="true" focusable="false"><circle class="timer-ring__track" cx="62" cy="62" r="54" fill="none" stroke-width="10"/><circle class="timer-ring__arc" cx="62" cy="62" r="54" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${offset}" transform="rotate(-90 62 62)"/></svg>
  <div class="timer-ring__center"><span class="timer-ring__num">${secs}</span><span class="timer-ring__unit">${paused ? 'PAUSED' : unit}</span></div>
</div>`;
}

/**
 * Update an existing timer ring in place (no re-render, no flicker). Returns the whole seconds shown,
 * so callers can beep when the number changes.
 */
export function updateTimerRing(el, timer, now = Date.now(), { unit = 'SECONDS' } = {}) {
  const ring = el?.matches?.('[data-timer-ring]') ? el : el?.querySelector?.('[data-timer-ring]');
  if (!ring) return 0;
  const frac = timerFraction(timer, now);
  const text = timerText(timer, now);
  const warn = timerWarn(timer, now);
  const paused = !!timer && !timer.running && timerRemaining(timer, now) > 0;
  ring.classList.toggle('is-warn', warn);
  ring.classList.toggle('is-paused', paused);
  ring.querySelector('.timer-ring__arc')?.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(1));
  const num = ring.querySelector('.timer-ring__num');
  if (num && num.textContent !== text) num.textContent = text;
  const u = ring.querySelector('.timer-ring__unit');
  const unitText = paused ? 'PAUSED' : unit;
  if (u && u.textContent !== unitText) u.textContent = unitText;
  ring.setAttribute('aria-label', `${text} seconds left`);
  return timerSeconds(timer, now);
}

/* ================================================================== markup helpers ============ */

/** Icon as trusted markup for h`` (same options as icons.js icon()). */
export function ic(name, opts) {
  return raw(icon(name, opts));
}

/** Team disc as trusted markup (same options as icons.js teamDisc()). */
export function disc(team, opts) {
  return raw(teamDisc(team, opts));
}

const CHIP_SIZES = { lg: { icon: 26 }, md: { icon: 22 }, sm: { icon: 18 } };

/**
 * Category chip for a wheel segment: icon + caps label on the slot colour.
 * @param {{label:string,color:string,ink:string,icon:string}} seg
 * @param {{size?:'lg'|'md'|'sm', text?:string}} [opts] lg = TV 22px, md = 18px, sm = phone 14px
 */
export function slotChip(seg, { size = 'lg', text } = {}) {
  const s = CHIP_SIZES[size] || CHIP_SIZES.lg;
  const bg = safeColor(seg?.color, '#1B4636');
  const ink = safeColor(seg?.ink, '#FFF6E5');
  const sizeCls = size === 'lg' ? '' : ` chip--${size}`;
  return h`<span class="chip${raw(sizeCls)}" style="--chip-bg:${bg};--chip-ink:${ink}">${ic(seg?.icon || 'sparkles', { size: s.icon, color: ink })}${text ?? seg?.label ?? ''}</span>`;
}

/** Turn dots for the header: done (gold), current (ring), upcoming (dim). */
export function turnDots(index, total, { label = true } = {}) {
  const n = Math.max(0, Math.trunc(Number(total) || 0));
  const cur = Math.trunc(Number(index) || 0);
  const dots = Array.from({ length: n }, (_, k) => raw(`<i class="${k < cur ? 'is-done' : k === cur ? 'is-current' : ''}"></i>`));
  return h`<span class="turn-dots" ${label ? raw(`role="img" aria-label="Turn ${Math.min(cur + 1, n)} of ${n}"`) : ''}>${dots}</span>`;
}

/* ================================================================== DOM helpers =============== */

const hasDOM = () => typeof document !== 'undefined';

export const qs = (sel, root) => (hasDOM() ? (root || document).querySelector(sel) : null);
export const qsa = (sel, root) => (hasDOM() ? [...(root || document).querySelectorAll(sel)] : []);

/** True when the viewer prefers reduced motion (or html has .reduce-motion). */
export function reducedMotion() {
  try {
    if (hasDOM() && document.documentElement.classList.contains('reduce-motion')) return true;
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** navigator.vibrate that never throws (iOS has no vibrate). Returns true if a vibration was requested. */
export function vibrate(pattern = 60) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') return navigator.vibrate(pattern) === true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Keep the screen awake (Screen Wake Lock). Re-acquires whenever the page becomes visible again.
 * Needs a secure context (localhost works; plain-http LAN phones usually don't) — then it is a no-op.
 * @returns {{release():void, readonly active:boolean, readonly supported:boolean}}
 */
export function wakeLock() {
  let sentinel = null;
  let wanted = true;
  const supported = typeof navigator !== 'undefined' && !!navigator.wakeLock?.request;
  const acquire = async () => {
    if (!supported || !wanted || sentinel || (hasDOM() && document.visibilityState !== 'visible')) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener?.('release', () => {
        sentinel = null;
      });
    } catch {
      sentinel = null;
    }
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') acquire();
  };
  if (supported && hasDOM()) {
    document.addEventListener('visibilitychange', onVis);
    // Requests need a gesture on some browsers; retry on the first interaction too.
    const once = () => acquire();
    document.addEventListener('pointerdown', once, { once: true, passive: true });
  }
  acquire();
  return {
    release() {
      wanted = false;
      if (hasDOM()) document.removeEventListener('visibilitychange', onVis);
      try {
        sentinel?.release();
      } catch {
        /* ignore */
      }
      sentinel = null;
    },
    get active() {
      return !!sentinel;
    },
    supported,
  };
}

/** Request fullscreen on the document (TV "Click to start"). Safe everywhere. */
export async function enterFullscreen(el) {
  try {
    const target = el || (hasDOM() ? document.documentElement : null);
    if (!target || document.fullscreenElement) return true;
    await (target.requestFullscreen?.() ?? target.webkitRequestFullscreen?.());
    return true;
  } catch {
    return false;
  }
}

let iosActiveFix = false;
/**
 * Fire `handler` on POINTERDOWN (not click) so the fastest finger wins the buzzer race, with the
 * .is-pressed lip-compress feedback. Keyboard Enter/Space still works through the click event.
 * Returns an unbind function.
 */
export function onPress(el, handler, { haptic = 0 } = {}) {
  if (!el) return () => {};
  if (!iosActiveFix && hasDOM()) {
    iosActiveFix = true;
    document.addEventListener('touchstart', () => {}, { passive: true }); // enables :active on iOS
  }
  let lastPointer = 0;
  const disabled = () => el.disabled || el.getAttribute('aria-disabled') === 'true';
  const down = (e) => {
    if (e.button > 0 || disabled()) return;
    lastPointer = Date.now();
    el.classList.add('is-pressed');
    if (haptic) vibrate(haptic);
    handler(e);
  };
  const up = () => el.classList.remove('is-pressed');
  const click = (e) => {
    if (Date.now() - lastPointer < 800) return; // already handled on pointerdown
    if (disabled()) return;
    handler(e); // keyboard activation (detail === 0) or a synthetic click
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('click', click);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('pointerleave', up);
    el.removeEventListener('click', click);
  };
}

/* ================================================================== press-and-hold secret ===== */

/**
 * Press-and-hold secret card markup (Phone-Secret artboard). Bind it with bindSecretCard().
 * @param {{label:string, value:string, rule?:string, tag?:string, hint?:string, tone?:'gold'|'violet'}} o
 */
export function secretCard({ label = 'Your secret', value = '', rule = '', tag = 'For your eyes only', hint = 'Tilt your phone toward you first', tone = 'gold' } = {}) {
  const fs = secretFontSize(value);
  return h`<button type="button" class="secret secret--${tone === 'violet' ? 'violet' : 'gold'}" aria-pressed="false" aria-label="${`Secret card. Press and hold to see your ${label.toLowerCase()}.`}" data-secret-card>
  <span class="secret__face secret__face--hidden">
    <span class="secret__frame" aria-hidden="true"></span>
    <span class="secret__tag">${tag}</span>
    <span class="secret__eye">${ic('eye', { size: 56, color: 'var(--tinsel)' })}</span>
    <span class="secret__title">Hold to peek</span>
    <span class="secret__hint">${hint}</span>
  </span>
  <span class="secret__face secret__face--shown" aria-hidden="true">
    <span class="secret__label">${ic('eye', { size: 20, color: 'currentColor' })}${label}</span>
    <span class="secret__value" style="--secret-fs:${fs}">${value}</span>
    ${rule ? h`<span class="secret__rule"><span class="secret__rule-icon">${ic('volume-x', { size: 22, color: '#FFFFFF' })}</span><span>${rule}</span></span>` : ''}
    <span class="secret__release">${ic('hand', { size: 16, color: 'currentColor' })}Let go to hide it</span>
  </span>
</button>`;
}

/** Font size for the secret value so long titles still fit the 352 px card (76 px for short ones, like the artboard). */
export function secretFontSize(value) {
  const t = String(value ?? '');
  const longest = Math.max(0, ...t.split(/s+/).map((w) => w.length));
  if (t.length <= 12 && longest <= 7) return 'min(4.75rem, 19vw)';
  if (t.length <= 20 && longest <= 9) return 'min(3.5rem, 14vw)';
  if (t.length <= 32 && longest <= 12) return 'min(2.75rem, 11vw)';
  return 'min(2.125rem, 8.5vw)';
}

/**
 * Make a secret card reveal only while pressed (pointer, Space or Enter held). Returns an unbind function.
 * @param {HTMLElement} el  the [data-secret-card] button (or a container holding one)
 * @param {{onReveal?:()=>void, onHide?:()=>void}} [o]
 */
export function bindSecretCard(el, { onReveal, onHide } = {}) {
  const card = el?.matches?.('[data-secret-card]') ? el : el?.querySelector?.('[data-secret-card]');
  if (!card) return () => {};
  const shown = card.querySelector('.secret__face--shown');
  const hidden = card.querySelector('.secret__face--hidden');
  let open = false;
  const set = (v) => {
    if (open === v) return;
    open = v;
    card.classList.toggle('is-revealed', v);
    card.setAttribute('aria-pressed', String(v));
    shown?.setAttribute('aria-hidden', String(!v));
    hidden?.setAttribute('aria-hidden', String(v));
    if (v) {
      vibrate(15);
      onReveal?.();
    } else onHide?.();
  };
  const down = (e) => {
    if (e.button > 0) return;
    try {
      card.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    set(true);
  };
  const up = () => set(false);
  const key = (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.type === 'keydown') set(true);
      else set(false);
    }
  };
  const ctx = (e) => e.preventDefault(); // no long-press menu
  card.addEventListener('pointerdown', down);
  card.addEventListener('pointerup', up);
  card.addEventListener('pointercancel', up);
  card.addEventListener('lostpointercapture', up);
  card.addEventListener('keydown', key);
  card.addEventListener('keyup', key);
  card.addEventListener('blur', up);
  card.addEventListener('contextmenu', ctx);
  const vis = () => hasDOM() && document.visibilityState !== 'visible' && set(false);
  if (hasDOM()) document.addEventListener('visibilitychange', vis);
  return () => {
    set(false);
    card.removeEventListener('pointerdown', down);
    card.removeEventListener('pointerup', up);
    card.removeEventListener('pointercancel', up);
    card.removeEventListener('lostpointercapture', up);
    card.removeEventListener('keydown', key);
    card.removeEventListener('keyup', key);
    card.removeEventListener('blur', up);
    card.removeEventListener('contextmenu', ctx);
    if (hasDOM()) document.removeEventListener('visibilitychange', vis);
  };
}

/* ================================================================== toast & banner =========== */

const TOAST_ICONS = { gold: 'bell', info: 'info', success: 'circle-check', error: 'triangle-alert', warn: 'triangle-alert' };
const TOAST_COLORS = { gold: 'var(--tinsel)', info: 'var(--frost)', success: 'var(--holly)', error: 'var(--berry-hi)', warn: 'var(--tinsel)' };

function region(id, cls, attrs) {
  let r = document.getElementById(id);
  if (!r) {
    r = document.createElement('div');
    r.id = id;
    r.className = cls;
    for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, v);
    document.body.appendChild(r);
  }
  return r;
}

/**
 * Pill toast with a gold border (System artboard). Text is escaped; pass h``/raw() for markup.
 * @param {string|Raw} msg
 * @param {{tone?:'gold'|'info'|'success'|'error'|'warn', icon?:string|false, duration?:number, position?:'top'|'bottom'}} [o]
 * @returns {() => void} dismiss
 */
export function toast(msg, { tone = 'gold', icon: iconName, duration = 3200, position = 'top' } = {}) {
  if (!hasDOM() || !document.body) return () => {};
  const reg = region(`cc-toasts-${position}`, `toast-region toast-region--${position}`, { role: 'status', 'aria-live': 'polite' });
  while (reg.children.length >= 3) reg.firstElementChild.remove();
  const t = document.createElement('div');
  const tn = TOAST_ICONS[tone] ? tone : 'gold';
  t.className = `toast toast--${tn}`;
  const name = iconName === false ? null : iconName || TOAST_ICONS[tn];
  t.innerHTML = h`${name ? ic(name, { size: 24, color: TOAST_COLORS[tn] }) : ''}<span class="toast__text">${msg instanceof Raw ? msg : String(msg ?? '')}</span>`.html;
  reg.appendChild(t);
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), reducedMotion() ? 0 : 220);
  };
  const timer = setTimeout(dismiss, Math.max(800, Number(duration) || 3200));
  t.addEventListener('click', dismiss);
  return dismiss;
}

/**
 * Full-width status banner (e.g. "Reconnecting…"). One banner per id; calling again updates it.
 * @param {string} id
 * @param {string|Raw} msg
 * @param {{tone?:'warn'|'error'|'info', icon?:string, busy?:boolean}} [o]
 */
export function showBanner(id, msg, { tone = 'warn', icon: iconName = 'wifi-off', busy = true } = {}) {
  if (!hasDOM() || !document.body) return;
  const domId = `cc-banner-${String(id).replace(/[^\w-]/g, '')}`;
  let b = document.getElementById(domId);
  if (!b) {
    b = document.createElement('div');
    b.id = domId;
    b.setAttribute('role', 'status');
    b.setAttribute('aria-live', 'assertive');
    document.body.appendChild(b);
  }
  b.className = `banner banner--${tone === 'error' ? 'error' : tone === 'info' ? 'info' : 'warn'}`;
  b.innerHTML = h`${iconName ? ic(iconName, { size: 22, color: 'currentColor' }) : ''}<span class="banner__text">${msg instanceof Raw ? msg : String(msg ?? '')}</span>${busy ? raw('<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>') : ''}`.html;
  document.documentElement.classList.add('has-banner');
}

export function hideBanner(id) {
  if (!hasDOM()) return;
  document.getElementById(`cc-banner-${String(id).replace(/[^\w-]/g, '')}`)?.remove();
  if (!document.querySelector('.banner')) document.documentElement.classList.remove('has-banner');
}

/* ================================================================== identity ================== */

const CLIENT_ID_KEY = 'cc.clientId';
let memoryClientId = null;

/** Random id from crypto.getRandomValues (Math.random fallback). NOT crypto.randomUUID (missing on http LAN). */
export function randomId(len = 16) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(len);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

/** Persistent per-device id (localStorage 'cc.clientId'); survives refresh, reconnect and restarts. */
export function getClientId() {
  try {
    const saved = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
    if (saved && /^[\w-]{8,64}$/.test(saved)) return saved;
    const id = memoryClientId || `c_${randomId(16)}`;
    globalThis.localStorage?.setItem(CLIENT_ID_KEY, id);
    memoryClientId = id;
    return id;
  } catch {
    memoryClientId = memoryClientId || `c_${randomId(16)}`;
    return memoryClientId;
  }
}

/* ================================================================== clock ===================== */

/**
 * Server clock offset estimator. Each sample is serverNow - clientNow measured on arrival, which is the
 * true offset minus network latency, so the MAX of recent samples is the best estimate.
 */
export function createClock(windowSize = 12) {
  const samples = [];
  let offset = 0;
  return {
    sample(serverNow, clientNow = Date.now()) {
      const s = Number(serverNow) - clientNow;
      if (!Number.isFinite(s)) return offset;
      samples.push(s);
      if (samples.length > windowSize) samples.shift();
      offset = Math.max(...samples);
      return offset;
    },
    get offset() {
      return offset;
    },
    now() {
      return Date.now() + offset;
    },
  };
}

/* ================================================================== socket connection ========= */

async function loadIo(opts) {
  if (opts.io) return opts.io;
  if (typeof globalThis.io === 'function') return globalThis.io;
  const mod = await import('/socket.io/socket.io.esm.min.js');
  return mod.io || mod.default;
}

/**
 * Connect to the game server.
 * - Sends `hello {role, clientId, hostKey}` on EVERY connect and reconnect (server rebinds the socket).
 * - Tracks the server clock from state.now (client.serverNow(), client.clockOffset).
 * - Shows a "Reconnecting…" banner while offline and toggles html.is-offline.
 * @param {'player'|'tv'|'host'} role
 * @param {{hostKey?:string|(()=>string), url?:string, io?:Function, ackTimeout?:number, banner?:boolean|string}} [opts]
 */
export function connect(role, opts = {}) {
  const o = { ackTimeout: 6000, banner: true, ...opts };
  const clientId = getClientId();
  const clock = createClock();
  const stateCbs = new Set();
  const fxCbs = new Set();
  const connCbs = new Set();
  const helloCbs = new Set();
  let socket = null;
  let lastState = null;
  let hello = null;
  let connected = false;
  let bannerTimer = 0;
  let closed = false;

  const call = (set, ...args) => {
    for (const cb of set) {
      try {
        cb(...args);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const setOnline = (on) => {
    connected = on;
    if (hasDOM()) document.documentElement.classList.toggle('is-offline', !on);
    clearTimeout(bannerTimer);
    if (o.banner && hasDOM()) {
      if (on) hideBanner('connection');
      else
        bannerTimer = setTimeout(
          () => showBanner('connection', typeof o.banner === 'string' ? o.banner : 'Reconnecting… hold tight', { tone: 'warn', icon: 'wifi-off' }),
          700
        );
    }
    call(connCbs, on);
  };

  const sendHello = () => {
    const hostKey = typeof o.hostKey === 'function' ? o.hostKey() : o.hostKey;
    const payload = { role, clientId };
    if (hostKey) payload.hostKey = String(hostKey);
    socket.timeout(o.ackTimeout).emit('hello', payload, (err, res) => {
      hello = err ? { ok: false, error: 'timeout' } : res || { ok: false, error: 'no-response' };
      call(helloCbs, hello);
    });
  };

  const ready = loadIo(o)
    .then((io) => {
      if (closed) return null;
      socket = io(o.url, {
        reconnection: true,
        reconnectionDelay: 400,
        reconnectionDelayMax: 2500,
        timeout: 8000,
      });
      socket.on('connect', () => {
        setOnline(true);
        sendHello();
      });
      socket.on('disconnect', () => setOnline(false));
      socket.on('connect_error', () => setOnline(false));
      socket.on('state', (state) => {
        if (!state || typeof state !== 'object') return;
        if (state.now != null) clock.sample(state.now);
        lastState = state;
        call(stateCbs, state);
      });
      socket.on('fx', (a, b) => {
        // Accept both emit('fx', {type, ...payload}) and emit('fx', type, payload).
        let type;
        let payload;
        if (typeof a === 'string') {
          type = a;
          payload = b ?? {};
        } else if (a && typeof a === 'object') {
          ({ type, ...payload } = a);
        }
        if (!type) return;
        call(fxCbs, type, payload, a);
      });
      return socket;
    })
    .catch((e) => {
      console.error('client: could not load socket.io', e);
      setOnline(false);
      return null;
    });

  if (hasDOM()) document.documentElement.classList.add('is-offline');

  return {
    role,
    clientId,
    ready,
    /** Subscribe to state pushes; called immediately with the latest state if one arrived. */
    onState(cb) {
      stateCbs.add(cb);
      if (lastState) {
        try {
          cb(lastState);
        } catch (e) {
          console.error(e);
        }
      }
      return () => stateCbs.delete(cb);
    },
    /** Subscribe to fx one-shots: cb(type, payload). */
    onFx(cb) {
      fxCbs.add(cb);
      return () => fxCbs.delete(cb);
    },
    /** cb(true|false) whenever the connection goes up/down. */
    onConnection(cb) {
      connCbs.add(cb);
      return () => connCbs.delete(cb);
    },
    /** cb(res) after every hello ack ({ok, isHost, me} or {ok:false, error}). */
    onHello(cb) {
      helloCbs.add(cb);
      if (hello) cb(hello);
      return () => helloCbs.delete(cb);
    },
    /**
     * Emit with ack. Always resolves (never rejects): {ok:true, ...} or {ok:false, error}.
     * While offline it fails fast with error 'offline' instead of buffering a stale action for later.
     */
    async emit(event, payload = {}, { timeout } = {}) {
      const s = socket || (await ready);
      if (!s) return { ok: false, error: 'offline' };
      if (!s.connected) return { ok: false, error: 'offline' };
      return new Promise((resolve) => {
        s.timeout(timeout ?? o.ackTimeout).emit(event, payload, (err, res) => {
          if (err) resolve({ ok: false, error: 'timeout' });
          else if (res && typeof res === 'object') resolve(res);
          else resolve({ ok: false, error: 'bad-response' });
        });
      });
    },
    /** Re-send hello now (e.g. after the user typed a host PIN). */
    rehello() {
      if (socket?.connected) sendHello();
    },
    serverNow: () => clock.now(),
    get clockOffset() {
      return clock.offset;
    },
    get state() {
      return lastState;
    },
    get hello() {
      return hello;
    },
    get isHost() {
      return !!hello?.isHost;
    },
    get me() {
      return hello?.me ?? null;
    },
    get connected() {
      return connected;
    },
    get socket() {
      return socket;
    },
    close() {
      closed = true;
      clearTimeout(bannerTimer);
      socket?.close();
      if (hasDOM()) hideBanner('connection');
    },
  };
}

/* ================================================================== motion helpers ============ */

/** Count a number up/down inside an element (score tiles). Honors reduced motion. */
export function animateNumber(el, to, { from, duration = 900, format = formatPoints } = {}) {
  if (!el) return;
  const target = Number(to) || 0;
  const start = from ?? (Number(String(el.dataset.value ?? el.textContent).replace(/[^\d-]/g, '')) || 0);
  el.dataset.value = String(target);
  if (reducedMotion() || start === target || typeof requestAnimationFrame !== 'function') {
    el.textContent = format(target);
    return;
  }
  const t0 = performance.now();
  const step = (t) => {
    if (el.dataset.value !== String(target)) return; // superseded
    const p = Math.min(1, (t - t0) / duration);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = format(Math.round(start + (target - start) * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
