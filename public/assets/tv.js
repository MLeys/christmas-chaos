// Christmas Chaos — tv.js · the Big Screen.
//
// Renders every stage of the show from the server's publicView ALONE (a TV refreshed mid-anything shows the
// right screen; the wheel rests on lastSegmentIndex). `fx` events only trigger one-shot sounds/animations.
//
// Rendering: each screen is built as escaped markup (h``) and patched into the DOM with a tiny morph, so
// pushes inside one screen (votes, ticks, answers arriving) update in place without replaying entrance
// animations, while a new screen gets fresh DOM. Timer rings and score counters are driven by a ticker.
// All look-and-feel lives in tv.css (tokens only); markup carries semantic classes plus data-driven custom
// properties (team / slot colours from the server, percentages) and nothing else inline.

import {
  connect, h, raw, ic, disc, slotChip, turnDots, formatPoints, formatDelta, possessive, ordinal, listJoin, plural,
  timerRemaining, reducedMotion, enterFullscreen, animateNumber,
} from '/assets/client.js';
import { createWheel, displayWidthEm } from '/assets/wheel.js';
import { hasIcon, safeColor } from '/assets/icons.js';
import * as sound from '/assets/sound.js';

/* =========================================================================== setup ========== */

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const stage = $('#stage');
const top = $('#top');
const strip = $('#strip');
const backdrop = $('#backdrop');
const flyLayer = $('#fly');
const live = $('#live');
const park = $('#park');
const wheelHost = $('#wheelHost');
const startEl = $('#start');
const muteBtn = $('#mute');

const client = connect('tv', { banner: 'Lost the game server — reconnecting' });

let S = null; // latest publicView
let wheel = null;
const ui = {
  started: false,
  screenKey: '',
  screenName: '',
  seenAwards: new Set(),
  pendingFly: new Map(),
  hold: null, // { kind:'landed'|'picked', id, stage, until }
  wheel: { mode: null, index: null },
  spinKey: null,
  beep: { id: '', sec: 0 },
  armBeep: { id: '', sec: 0 },
  judgedRows: new Set(),
  dareResultFor: null,
  pointerTimer: 0,
};

/* =========================================================================== helpers ======== */

const LEVELS = [
  { id: 'easy', label: 'Easy', pts: 100, icon: 'smile', blurb: 'Most of the room knows it' },
  { id: 'medium', label: 'Medium', pts: 200, icon: 'brain', blurb: 'Think hard' },
  { id: 'hard', label: 'Hard', pts: 300, icon: 'mountain-snow', blurb: 'Legendary' },
];
const CATEGORY_SEGMENT = { christmas: 0, popculture: 2, movies: 4 };
const ICON_FALLBACK = { popcorn: 'film' }; // icons the server names that icons.js does not ship

const cx = (...parts) => parts.filter(Boolean).join(' ');
const colorOf = (c, fb = 'var(--frost)') => safeColor(c, fb);
const teamVar = (t) => `--team:${colorOf(t?.color)}`;
const iconName = (name, fb = 'sparkles') => (hasIcon(name) ? name : ICON_FALLBACK[name] && hasIcon(ICON_FALLBACK[name]) ? ICON_FALLBACK[name] : fb);
const fixSeg = (seg) => (seg ? { ...seg, icon: iconName(seg.icon) } : seg);
const segVar = (seg) => `--slot:${colorOf(seg?.color, 'var(--pine-2)')};--slot-ink:${colorOf(seg?.ink, 'var(--snow)')}`;
const now = () => client.serverNow();
const joinHost = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
/** True for slot colours too dark to read on the night background (relative luminance < 0.1). */
function isDarkColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) < 0.1;
}
const pct = (n) => `${Math.max(0, Math.min(100, Math.round(n * 10) / 10))}%`;

function team(id) {
  return S?.teams.find((t) => t.id === id) || null;
}
function activeTeam(s = S) {
  return s.teams.find((t) => t.id === s.activeTeamId) || null;
}
function playersOf(teamId, s = S) {
  return s.players.filter((p) => p.teamId === teamId);
}
function segOf(i, s = S) {
  return fixSeg(s.segments?.[i]) || null;
}
function multiplier(s = S) {
  return activeTeam(s)?.multiplier || 1;
}
function leaders(s = S) {
  const top = Math.max(0, ...s.teams.map((t) => t.score));
  return new Set(top > 0 ? s.teams.filter((t) => t.score === top).map((t) => t.id) : []);
}
/** 'fit-1'..'fit-4' by text length, so long copy steps down a size instead of overflowing. */
function fit(text, steps) {
  const n = String(text ?? '').length;
  for (let i = 0; i < steps.length; i++) if (n <= steps[i]) return `fit-${i + 1}`;
  return `fit-${steps.length + 1}`;
}
/** Size bucket for a giant uppercase display word (Fraunces 900, var(--font-display)) inside a fixed-width column. */
function wordFit(text, widthEm) {
  const longest = Math.max(...String(text).toUpperCase().split(/\s+/).map((w) => displayWidthEm(w)));
  const em = widthEm / Math.max(0.1, longest);
  if (em >= 9.375) return 'fit-1';
  if (em >= 7.5) return 'fit-2';
  if (em >= 6) return 'fit-3';
  if (em >= 4.75) return 'fit-4';
  return 'fit-5';
}
/** 'any Team Rudolph phone' / 'any phone on The Grinches'. */
function anyPhone(t) {
  return /^the\s/i.test(t?.name || '') ? `any phone on ${t.name}` : `any ${t?.name || ''} phone`;
}
function namesLine(names, max = 4) {
  if (!names.length) return '';
  if (names.length <= max) return listJoin(names);
  return `${names.slice(0, max - 1).join(', ')} or any teammate`;
}
function nextUp(s = S) {
  const i = s.teams.findIndex((t) => t.id === s.activeTeamId);
  if (i >= 0 && i + 1 < s.teams.length) return { team: s.teams[i + 1] };
  if (s.round >= s.totalRounds) return { label: 'Final Chaos', icon: 'sparkles' };
  return { label: `Round ${s.round} standings`, icon: 'flag' };
}
function timerKey(t) {
  return t ? `${t.kind}:${t.durationMs}:${t.started ? 1 : 0}` : 'none';
}

/* =========================================================================== morph ========== */
// Patch `el` to match `markup`. Same-shaped nodes are updated in place (attributes + text); anything marked
// data-morph-skip (the wheel slot, timer rings, score counters) is left alone once it exists.

function morph(el, markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(markup ?? '');
  patchChildren(el, tpl.content);
}
function same(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== 1) return true;
  return a.getAttribute('data-key') === b.getAttribute('data-key');
}
function patchChildren(parent, src) {
  const next = Array.from(src.childNodes);
  const curr = Array.from(parent.childNodes);
  next.forEach((n, i) => {
    const c = curr[i];
    if (!c) parent.appendChild(n);
    else if (same(c, n)) patchNode(c, n);
    else parent.replaceChild(n, c);
  });
  for (let i = next.length; i < curr.length; i++) curr[i].remove();
}
function patchNode(c, n) {
  if (c.nodeType !== 1) {
    if (c.nodeValue !== n.nodeValue) c.nodeValue = n.nodeValue;
    return;
  }
  if (c.hasAttribute('data-morph-skip')) return;
  for (const { name, value } of Array.from(n.attributes)) if (c.getAttribute(name) !== value) c.setAttribute(name, value);
  for (const { name } of Array.from(c.attributes)) if (!n.hasAttribute(name)) c.removeAttribute(name);
  patchChildren(c, n);
}

/* =========================================================================== shared bits ==== */

const wheelSlot = (size) => h`<div class="wheel-slot wheel-slot--${size}" data-wheel-slot data-morph-skip></div>`;

/** Timer ring shell; the ticker fills in the number/arc from state.timer. */
function ring(size, { unit = 'SECONDS LEFT', clock = true, key = '', tone = '' } = {}) {
  return h`<div class="timer-ring tv-ring tv-ring--${size} ${tone}" data-ring data-clock="${clock ? '1' : ''}" data-unit="${unit}" data-key="${key || timerKey(S?.timer)}" data-morph-skip role="timer" aria-label="Timer">
    <svg viewBox="0 0 124 124" aria-hidden="true" focusable="false"><circle class="tv-ring__face" cx="62" cy="62" r="49"/><circle class="timer-ring__track" cx="62" cy="62" r="54" fill="none"/><circle class="timer-ring__arc" cx="62" cy="62" r="54" fill="none" stroke-linecap="round" stroke-dasharray="339.3" stroke-dashoffset="0" transform="rotate(-90 62 62)"/></svg>
    <div class="timer-ring__center"><span class="timer-ring__num"></span><span class="timer-ring__unit">${unit}</span></div>
  </div>`;
}

function teamName(t, cls = 'team-ink') {
  return h`<span class="${cls}" style="${teamVar(t)}">${t?.name ?? ''}</span>`;
}

function upNextPill(s) {
  const n = nextUp(s);
  return h`<div class="upnext"><span class="upnext__label">Up next</span>${n.team ? h`${disc(n.team, { size: 40 })}<span class="upnext__name">${n.team.name}</span>` : h`<span class="upnext__icon">${ic(n.icon, { size: 26 })}</span><span class="upnext__name">${n.label}</span>`}</div>`;
}

function categoryChip(c, size = 'lg') {
  const seg = segOf(c.segmentIndex) || segOf(CATEGORY_SEGMENT[c.category] ?? 0);
  return slotChip(seg, { size, text: (c.categoryLabel || seg?.label || '').toUpperCase() });
}

function movieChip(c, cls = '') {
  if (!c.movie) return '';
  return h`<span class="chip chip--outline movie-chip ${cls}">${ic('film', { size: 24 })}<span class="movie-chip__title">${c.movie}</span>${c.movieYear ? h`<span class="movie-chip__year">${c.movieYear}</span>` : ''}</span>`;
}

function pointsLabel(n, mult = 1) {
  return h`<span class="pts-label">${formatPoints(n)} POINTS${mult > 1 ? h` <span class="pts-label__x">×${mult}</span>` : ''}</span>`;
}

const STAR_POINTS = (() => {
  const pts = [];
  const spikes = 18;
  for (let k = 0; k < spikes * 2; k++) {
    const r = k % 2 ? 236 : 304;
    const a = (Math.PI * k) / spikes;
    pts.push(`${(r * Math.sin(a)).toFixed(1)},${(-r * Math.cos(a)).toFixed(1)}`);
  }
  return pts.join(' ');
})();
const STAR_SHADOW = (() => {
  const pts = [];
  const spikes = 18;
  for (let k = 0; k < spikes * 2; k++) {
    const r = k % 2 ? 250 : 334;
    const a = (Math.PI * (k + 0.5)) / spikes;
    pts.push(`${(r * Math.sin(a)).toFixed(1)},${(-r * Math.cos(a)).toFixed(1)}`);
  }
  return pts.join(' ');
})();
const STAR_RAYS = (() => {
  let s = '';
  for (let k = 0; k < 18; k++) {
    const a = (Math.PI * 2 * (k + 0.25)) / 18;
    const r1 = 352 + (k % 3) * 6;
    const r2 = r1 + 30 + (k % 2) * 14;
    s += `<line x1="${(r1 * Math.sin(a)).toFixed(1)}" y1="${(-r1 * Math.cos(a)).toFixed(1)}" x2="${(r2 * Math.sin(a)).toFixed(1)}" y2="${(-r2 * Math.cos(a)).toFixed(1)}"/>`;
  }
  return s;
})();
const burst = (cls) => raw(`<svg class="burst ${cls}" viewBox="-400 -400 800 800" aria-hidden="true" focusable="false"><g class="burst__rays">${STAR_RAYS}</g><polygon class="burst__shadow" points="${STAR_SHADOW}"/><polygon class="burst__star" points="${STAR_POINTS}"/></svg>`);

const MUSIC_BARS = (() => {
  const n = 46;
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const env = 0.35 + 0.65 * Math.sin(Math.PI * x);
    const wob = 0.45 + 0.55 * Math.abs(Math.sin(i * 1.9) * Math.cos(i * 0.37) + 0.35 * Math.sin(i * 0.8));
    const hgt = Math.max(0.125, Math.min(1, env * Math.min(1, wob)));
    s += `<i class="${hgt > 0.75 ? 'is-hi' : ''}" style="--h:${hgt.toFixed(3)};--i:${i}"></i>`;
  }
  return s;
})();

const FILM_HOLES = raw(`<div class="film-strip" aria-hidden="true">${'<i></i>'.repeat(28)}</div>`);

function confettiMarkup(count = 64) {
  let s = '';
  for (let i = 0; i < count; i++) {
    const x = ((i * 197 + (i % 5) * 61) % 1880) / 19.2;
    const delay = ((i * 37) % 50) / 10;
    const speed = 5.5 + ((i * 13) % 30) / 10;
    const rot = (i * 47) % 360;
    s += `<i class="confetti__p c${i % 7} ${i % 4 === 0 ? 'is-round' : ''}" style="--x:${x.toFixed(2)}%;--d:${delay}s;--s:${speed}s;--r:${rot}deg"></i>`;
  }
  return raw(`<div class="confetti" data-confetti>${s}</div>`);
}

/* =========================================================================== screens ======== */
// Each returns { name, key, html, header, strip, stripMode, surface, backdrop, wheel, say }.

function view(name, html, o = {}) {
  return { name, key: o.key ?? name, html, header: o.header ?? true, strip: o.strip ?? true, stripMode: o.stripMode ?? 'normal', surface: o.surface ?? 'night', backdrop: o.backdrop ?? '', wheel: o.wheel ?? null, say: o.say ?? '' };
}

/* ---------- lobby ---------- */
function scrLobby(s) {
  const url = joinHost(s.joinUrl);
  const teams = s.teams;
  const total = s.players.length;
  const loose = s.players.filter((p) => !p.teamId || !team(p.teamId));
  const cols = teams.length > 6 ? 4 : 3;
  const html = h`<section class="scr scr--lobby">
    <div class="lobby-left">
      <div class="lobby-brand">${ic('snowflake', { size: 48 })}<span>Christmas Chaos</span></div>
      <h1 class="lobby-title">Grab your phone<br>and join a team</h1>
      <div class="lobby-join">
        <div class="lobby-qr"><img class="lobby-qr__img" src="/api/qr.svg?v=${encodeURIComponent(s.joinUrl || '')}" alt="QR code that opens the join page" width="256" height="256"></div>
        <ol class="lobby-steps" role="list">
          <li><span class="lobby-steps__n">1</span><span>Join the <strong>same Wi-Fi</strong> as this TV</span></li>
          <li><span class="lobby-steps__n">2</span><span>Point your camera at the code</span></li>
          <li><span class="lobby-steps__n">3</span><span>Type your name, tap your team</span></li>
        </ol>
      </div>
      <div class="lobby-url"><span class="lobby-url__label">No camera? Type this into your browser</span><span class="lobby-url__value">${url}</span></div>
      <p class="lobby-hint">${ic('volume-2', { size: 30 })}Turn the TV volume up — the wheel ticks, buzzers honk.</p>
    </div>
    <div class="lobby-right">
      <div class="lobby-right__head">
        <h2 class="lobby-right__title">The teams</h2>
        <span class="lobby-right__count">${total ? h`<strong>${plural(total, 'player')}</strong> in · waiting for the host to start` : 'Nobody’s in yet — be the first!'}</span>
      </div>
      ${teams.length
        ? h`<div class="lobby-teams lobby-teams--c${cols}">${teams.map((t) => lobbyTeam(t))}</div>`
        : h`<div class="lobby-empty">${ic('users', { size: 64 })}<span class="lobby-empty__title">The host is setting up the teams…</span><span class="lobby-empty__text">Join now — you can pick your team as soon as they appear.</span></div>`}
      ${loose.length ? h`<p class="lobby-loose">${ic('user-plus', { size: 26 })}<span>Picking a team: <strong>${listJoin(loose.map((p) => p.name), 'and')}</strong></span></p>` : ''}
    </div>
  </section>`;
  return view('lobby', html, { header: false, strip: false, say: `Christmas Chaos. Scan the code or type ${url} to join a team.` });
}
function lobbyTeam(t) {
  const ps = playersOf(t.id);
  return h`<div class="lobby-team ${ps.length ? '' : 'is-empty'}" data-key="${t.id}" style="${teamVar(t)}">
    <div class="lobby-team__head">${disc(t, { size: 64, label: true })}<span class="lobby-team__name">${t.name}</span></div>
    ${ps.length
      ? h`<div class="lobby-team__players">${ps.map((p) => h`<span class="player-chip lobby-chip ${p.connected ? '' : 'is-offline'}" data-key="${p.id}">${p.name}</span>`)}</div>`
      : h`<span class="lobby-team__empty">Nobody yet — this team needs players.</span>`}
  </div>`;
}

/* ---------- turn intro ---------- */
function scrTurnIntro(s) {
  const t = activeTeam(s);
  const online = playersOf(t.id).filter((p) => p.connected).map((p) => p.name);
  const who = online.length ? `${namesLine(online)} — the first tap spins the wheel` : `Nobody from ${t.name} is online — the host can spin for you`;
  const html = h`<section class="scr scr--intro" style="${teamVar(t)}">
    <div class="intro">
      <div class="intro__hero">
        <span class="intro__burst"></span><span class="intro__glow"></span>
        ${disc(t, { size: 240, label: true, className: 'disc--hero intro__disc' })}
        <span class="intro__spark intro__spark--a">${ic('sparkle', { size: 56 })}</span>
        <span class="intro__spark intro__spark--b">${ic('sparkle', { size: 38 })}</span>
        <span class="intro__spark intro__spark--c">${ic('sparkle', { size: 30 })}</span>
      </div>
      <h1 class="intro__title ${fit(t.name, [13, 19])}"><span class="team-ink">${t.name}</span> —<br>you’re up!</h1>
      <div class="intro__call">
        <div class="phone-glyph" aria-hidden="true"><span class="phone-glyph__notch"></span><span class="phone-glyph__btn">SPIN</span></div>
        <div class="intro__call-text"><span class="intro__call-title">Spin from ${anyPhone(t)}</span><span class="intro__call-sub">${who}</span></div>
      </div>
    </div>
    <div class="intro__side">
      ${wheelSlot('md')}
      <span class="tv-pill">${ic('rotate-cw', { size: 26 })}Ready for ${possessive(t.name)} spin</span>
    </div>
  </section>`;
  return view('turn-intro', html, { key: `turn-intro:${s.turnId}`, wheel: { mode: 'idle', index: s.lastSegmentIndex }, say: `${t.name}, you’re up! Spin from ${anyPhone(t)}.` });
}

/* ---------- spinning ---------- */
function scrSpinning(s) {
  const t = activeTeam(s);
  const by = s.spin?.by;
  const dd = multiplier(s) > 1;
  const html = h`<section class="scr scr--spinning" style="${teamVar(t)}">
    <div class="spin-left">
      <span class="eyebrow-tv live-dot">Spinning now</span>
      ${disc(t, { size: 128, label: true, className: 'disc--ring' })}
      <h1 class="spin-title ${fit((by?.name || '') + t.name, [22, 30])}">${by ? `${by.name} is spinning for ` : 'Spinning for '}<span class="team-ink">${t.name}</span>…</h1>
    </div>
    ${wheelSlot('xl')}
    <div class="spin-right">
      <span class="eyebrow-tv">When it stops</span>
      <p class="spin-lead">${t.name} plays whatever it lands on.</p>
      <hr class="tv-rule">
      ${dd
        ? h`<div class="spin-tip spin-tip--dd"><span class="spin-tip__icon">${ic('sparkles', { size: 28 })}</span><span><strong>Double Down is on:</strong> everything ${t.name} wins this turn is doubled.</span></div>`
        : h`<div class="spin-tip"><span class="spin-tip__icon">${ic('zap', { size: 28 })}</span><span>Everyone else: stay sharp. A miss opens a <strong>steal</strong>, and <strong>All Play</strong> is for every team.</span></div>`}
    </div>
  </section>`;
  return view('spinning', html, { key: `spinning:${s.spin?.startedAt}`, wheel: { mode: 'spin' }, say: `${by ? by.name : t.name} is spinning the wheel.` });
}

/* ---------- the wheel landed (client-side moment between spin and the mini-game) ---------- */
const NEXT_STEP = {
  trivia: ['hand', (t) => `${t.name} picks Easy, Medium or Hard…`],
  dare: ['drama', (t) => `Picking a performer from ${t.name}…`],
  hotseat: ['flame', (t) => `Picking someone from ${t.name} for the Hot Seat…`],
  sounditout: ['music', (t) => `Picking a secret hummer from ${t.name}…`],
  showdown: ['swords', (t) => `${t.name} picks a rival team…`],
  rapidlist: ['list-checks', (t) => `${t.name}, get ready to shout!`],
  allplay: ['smartphone', () => 'Every team, grab a phone!'],
  grinch: ['hand-coins', (t) => `Who will ${t.name} rob?`],
  doubledown: ['sparkles', (t) => `${t.name} spins again!`],
};
function scrLanded(s, c) {
  const t = activeTeam(s);
  const seg = segOf(c.segmentIndex);
  const by = s.lastSpin?.by;
  const [icon, line] = NEXT_STEP[c.type] || ['sparkles', () => 'Get ready…'];
  const word = `${seg.label.toUpperCase()}!`;
  const pts = String(seg.points || '');
  const ptsText = pts.startsWith('×') ? `Points ${pts}` : `${pts} points`;
  const html = h`<section class="scr scr--landed ${isDarkColor(seg.color) ? 'is-dark-slot' : ''}" style="${segVar(seg)}">
    <div class="landed-left">
      <span class="eyebrow-tv">Spun by</span>
      <div class="landed-team" style="${teamVar(t)}">${disc(t, { size: 84 })}<div class="landed-team__text"><span class="landed-team__name">${t.name}</span><span class="landed-team__by">${by ? `${by.name} pressed spin` : 'The host spun for them'}</span></div></div>
      <hr class="tv-rule">
      <span class="eyebrow-tv">${c.firstTime ? 'New game — how it works' : 'How it works'}</span>
      <p class="landed-rule">${seg.rule || c.rule || ''}</p>
    </div>
    ${wheelSlot('xl')}
    <div class="landed-right">
      <span class="eyebrow-tv">It landed on</span>
      <span class="landed-word ${wordFit(word, 30)}">${word}</span>
      <span class="landed-points">${ptsText}${multiplier(s) > 1 ? ' · ×2' : ''}</span>
      <div class="landed-next">${ic(icon, { size: 36 })}<span>${line(t)}</span></div>
    </div>
  </section>`;
  return view('landed', html, { key: `landed:${c.id}`, wheel: { mode: 'hl', index: c.segmentIndex }, say: `The wheel landed on ${seg.label}.` });
}

/* ---------- trivia: pick difficulty ---------- */
function scrDifficulty(s, c, pickedHold) {
  const t = activeTeam(s);
  const picked = pickedHold ? c.difficulty : null;
  const who = c.pickedBy?.name || null;
  const lvl = LEVELS.find((l) => l.id === picked);
  const html = h`<section class="scr scr--difficulty">
    <div class="diff-head">
      <div class="diff-landed"><span class="eyebrow-tv">It landed on</span>${categoryChip(c)}</div>
      <h1 class="diff-title">${picked ? h`${teamName(t)} goes <span class="diff-title__lvl diff-title__lvl--${picked}">${lvl?.label}</span>!` : h`${teamName(t)} is choosing on their phones…`}</h1>
      <p class="diff-sub">${multiplier(s) > 1 ? h`<strong class="ink-gold">Double Down is on</strong> — every point counts twice.` : 'Harder question, bigger points. Miss it and the other teams can steal half.'}</p>
    </div>
    <div class="diff-cards">
      ${LEVELS.map((l, i) => h`<div class="diff-card diff-card--${l.id} ${picked === l.id ? 'is-picked' : picked ? 'is-dim' : ''}" data-key="${l.id}">
        ${picked === l.id ? h`<span class="diff-card__who" style="${teamVar(t)}">${disc(t, { size: 40 })}${who ? `${who} picked ${l.label}` : `${l.label} it is`}</span>` : ''}
        <div class="diff-card__top"><span class="diff-card__icon">${ic(l.icon, { size: 42 })}</span><span class="diff-bars" role="img" aria-label="Difficulty ${i + 1} of 3"><i class="is-on"></i><i class="${i >= 1 ? 'is-on' : ''}"></i><i class="${i >= 2 ? 'is-on' : ''}"></i></span></div>
        <span class="diff-card__name">${l.label}</span>
        <div class="diff-card__pts"><span class="diff-card__num">${formatPoints(l.pts * multiplier(s))}</span><span class="diff-card__unit">Points</span></div>
        <div class="diff-card__foot"><span>${l.blurb}</span>${picked === l.id ? h`<span class="diff-card__lock">${ic('circle-check', { size: 26 })}Locked in</span>` : ''}</div>
      </div>`)}
    </div>
  </section>`;
  return view(picked ? 'difficulty-picked' : 'difficulty', html, { key: `difficulty:${c.id}:${picked ? 1 : 0}`, say: picked ? `${who || t.name} picked ${lvl?.label}.` : `${t.name} is picking a difficulty.` });
}

/* ---------- trivia: question in play ---------- */
function scrQuestion(s, c) {
  const t = activeTeam(s);
  const lvl = LEVELS.find((l) => l.id === c.difficulty);
  const mult = multiplier(s);
  const html = h`<section class="scr scr--question">
    <div class="question-wheel">${wheelSlot('lg')}</div>
    <div class="card qcard ${c.movie || c.hint ? 'is-dense' : ''}">
      <div class="qcard__top">
        <div class="qcard__chips">${categoryChip(c)}${lvl ? h`<span class="chip chip--outline">${lvl.label.toUpperCase()}</span>` : ''}${pointsLabel(c.points, mult)}</div>
        ${ring('md', { unit: 'SECONDS', clock: false })}
      </div>
      ${c.movie ? h`<div class="qcard__movie">${movieChip(c)}</div>` : ''}
      <div class="qcard__team" style="${teamVar(t)}">${disc(t, { size: 44 })}<span><strong class="team-ink">${t.name}</strong> — answer out loud</span></div>
      <h1 class="qcard__q ${fit(c.question, [90, 140, 200])}">${c.question}</h1>
      <div class="qcard__foot">
        ${c.hint
          ? h`<div class="card__hint qcard__hint">${ic('lightbulb', { size: 34 })}<span><strong>Hint:</strong> ${c.hint}<span class="qcard__hint-steal">Wrong answer? The other teams can steal it for ${formatPoints(c.stealPoints)}.</span></span></div>`
          : h`<div class="card__hint">${ic('bell', { size: 34 })}<span>Wrong answer? Every other team can <strong>buzz in to steal</strong> it for ${formatPoints(c.stealPoints)}.</span></div>`}
      </div>
    </div>
  </section>`;
  return view('question', html, { key: `question:${c.id}:${c.question}`, wheel: { mode: 'hl', index: c.segmentIndex }, say: `${t.name}, answer out loud. ${c.question}` });
}

/* ---------- trivia + sound it out: steal ---------- */
function stealPhase(c) {
  const b = c.buzz || {};
  if (b.winner) return 'buzzed';
  if (b.armingUntil && !b.open) return 'arming';
  if (b.open) return 'open';
  return 'waiting';
}
function scrSteal(s, c) {
  const t = activeTeam(s);
  const b = c.buzz || { eligibleTeamIds: [], lockedTeamIds: [] };
  const phase = stealPhase(c);
  const winner = b.winner ? team(b.winner.teamId) : null;
  const left = (b.eligibleTeamIds || []).filter((id) => !(b.lockedTeamIds || []).includes(id));
  const locked = (b.lockedTeamIds || []).map(team).filter(Boolean);
  const isSong = c.type === 'sounditout';
  const status = { arming: ['timer', 'GET READY'], open: ['bell-ring', 'BUZZER OPEN'], buzzed: ['bell-ring', 'BUZZED IN'], waiting: ['hourglass', 'BUZZERS CLOSED'] }[phase];
  const lvl = LEVELS.find((l) => l.id === c.difficulty);
  const lead = phase === 'waiting' && locked.length
    ? `Not this time, ${listJoin(locked.map((x) => x.name), 'and')}. The host can reopen the buzzers.`
    : isSong ? `${t.name} couldn’t name it. Anyone else know the song?` : `Not this time, ${t.name}. Anyone else know it?`;
  let right;
  if (phase === 'buzzed' && winner) {
    right = h`<div class="steal-burst is-buzzed" style="${teamVar(winner)}">${burst('burst--team')}
      <div class="steal-burst__body">
        <span class="steal-burst__disc">${ic(iconName(winner.mascot, 'star'), { size: 54 })}</span>
        <h2 class="steal-burst__who"><span class="steal-burst__name ${fit(b.winner.name, [8, 12])}">${b.winner.name}</span><span class="steal-burst__mid">buzzed first for</span><span class="steal-burst__team">${winner.name}!</span></h2>
      </div>
      <span class="steal-burst__cue">${ic('mic', { size: 30 })}${b.winner.name}, answer out loud!</span>
    </div>`;
  } else if (phase === 'arming') {
    right = h`<div class="steal-burst is-arming">${burst('burst--ghost')}
      <div class="steal-burst__body"><span class="steal-burst__label">Buzzers arm in</span><span class="steal-burst__count" data-countdown="${b.armingUntil}" data-morph-skip></span><span class="steal-burst__label">Fingers ready…</span></div>
    </div>`;
  } else if (phase === 'open') {
    right = h`<div class="steal-burst is-open">${burst('burst--snow')}
      <div class="steal-burst__body"><span class="steal-burst__go">BUZZ NOW!</span>${ring('sm', { unit: 'SECONDS', clock: false, tone: 'tv-ring--ink' })}<span class="steal-burst__label">${plural(left.length, 'team')} can steal</span></div>
    </div>`;
  } else {
    right = h`<div class="steal-burst is-waiting">${burst('burst--ghost')}
      <div class="steal-burst__body"><span class="steal-burst__icon">${ic('hourglass', { size: 64 })}</span><span class="steal-burst__label">${left.length ? `${plural(left.length, 'team')} still in it` : 'No teams left'}</span><span class="steal-burst__small">Waiting for the host…</span></div>
    </div>`;
  }
  const html = h`<section class="scr scr--steal">
    <div class="steal-card">
      <div class="steal-card__main">
        <div class="steal-card__chips">
          <span class="chip steal-chip">${ic(iconName(segOf(c.segmentIndex)?.icon), { size: 26 })}${(c.categoryLabel || segOf(c.segmentIndex)?.label || '').toUpperCase()}</span>
          ${lvl ? h`<span class="chip chip--outline steal-chip--line">${lvl.label.toUpperCase()}</span>` : ''}
          <span class="chip chip--outline steal-chip--line">${ic(status[0], { size: 24 })}${status[1]}</span>
        </div>
        <h1 class="steal-card__title">STEAL!</h1>
        <span class="steal-card__pts">Buzz in for ${formatPoints(c.stealPoints)}</span>
        <span class="steal-card__lead">${lead}</span>
        <div class="steal-card__q">
          <span class="steal-card__q-label">${isSong ? 'The song' : 'The question'}</span>
          ${isSong
            ? h`<p class="steal-card__q-text">${c.performer?.name || t.name} hummed it for ${t.name} — name that tune!${c.hint ? h` <span class="steal-card__hint">Hint: ${c.hint}</span>` : ''}</p>`
            : h`<p class="steal-card__q-text ${fit(c.question, [80, 130, 190])}">${c.question}</p>`}
        </div>
      </div>
      <div class="steal-card__side">${right}</div>
    </div>
  </section>`;
  const say = phase === 'buzzed' && winner ? `${b.winner.name} buzzed first for ${winner.name}!` : phase === 'open' ? `Steal! Buzzers are open for ${c.stealPoints} points.` : phase === 'arming' ? 'Steal! Get ready to buzz.' : 'Waiting for the host.';
  return view(`steal-${phase}`, html, { key: `steal:${c.id}:${phase}:${b.winner?.playerId || ''}:${(b.lockedTeamIds || []).length}`, stripMode: 'steal', say });
}

/* ---------- trivia + sound it out: result ---------- */
function scrResult(s, c) {
  const t = activeTeam(s);
  const kind = c.result?.kind || 'missed';
  const win = kind === 'correct' || kind === 'stolen';
  const winnerTeam = kind === 'stolen' ? team(c.buzz?.winner?.teamId) || team(c.result?.awards?.[0]?.teamId) : t;
  const isSong = c.type === 'sounditout';
  const lvl = LEVELS.find((l) => l.id === c.difficulty);
  const label = kind === 'correct' ? `Correct! ${winnerTeam?.name || ''} got it`
    : kind === 'stolen' ? `Stolen! ${winnerTeam?.name || ''} got it`
    : kind === 'skipped' ? 'Skipped — the answer was'
    : 'Not this time — the answer was';
  const answer = c.answer || '—';
  const html = h`<section class="scr scr--result ${c.funFact ? '' : 'no-fact'}">
    <div class="result-top">
      <div class="result-top__chips">${isSong ? slotChip(segOf(c.segmentIndex)) : categoryChip(c)}${lvl ? h`<span class="chip chip--outline">${lvl.label.toUpperCase()}</span>` : ''}${pointsLabel(c.points, multiplier(s))}${movieChip(c, 'chip--md')}</div>
      ${upNextPill(s)}
    </div>
    <p class="result-q">${isSong ? `${c.performer?.name || t.name} hummed it for ${t.name}` : c.question}</p>
    <section class="answer-panel ${win ? 'is-win' : 'is-miss'} ${fit(answer, [22, 34, 52])}" data-fly-from aria-label="${win ? 'Correct answer' : 'The answer'}: ${answer}">
      <span class="answer-panel__icon">${ic(win ? 'check' : 'x', { size: 108, stroke: 2.6 })}</span>
      <div class="answer-panel__text">
        <span class="answer-panel__label">${label}</span>
        <span class="answer-panel__answer">${answer}</span>
        ${isSong && c.artist ? h`<span class="answer-panel__sub">${c.artist}</span>` : ''}
      </div>
    </section>
    ${c.funFact ? h`<div class="funfact"><span class="funfact__icon">${ic('lightbulb', { size: 32 })}</span><div class="funfact__text"><span class="funfact__label">Fun fact</span><span class="funfact__body">${c.funFact}</span></div></div>` : ''}
  </section>`;
  const say = win ? `${label}. The answer: ${answer}.` : `The answer was ${answer}.`;
  return view('result', html, { key: `result:${c.id}`, say });
}

/* ---------- sound it out: performing ---------- */
function scrSound(s, c) {
  const t = activeTeam(s);
  const perf = c.performer?.name;
  const started = !!s.timer?.started;
  const html = h`<section class="scr scr--sound">
    <div class="sound-card">
      <div class="sound-card__chips">
        <span class="chip sound-chip">${ic('music', { size: 26 })}SOUND IT OUT</span>
        ${pointsLabel(c.points, multiplier(s))}
        <span class="chip chip--outline sound-chip--line">${ic('mic-off', { size: 24 })}HUM OR WHISTLE — NO WORDS</span>
      </div>
      <div class="sound-card__body">
        <div class="sound-card__main">
          <div class="sound-card__who" style="${teamVar(t)}">${disc(t, { size: 76, className: 'disc--halo' })}<h1 class="sound-card__title ${fit(perf || t.name, [10, 16])}">${perf ? `${perf} is humming…` : `${t.name} is humming…`}</h1></div>
          <p class="sound-card__call">${t.name} — name that tune!</p>
          <div class="music-bars ${started ? 'is-live' : ''}" aria-hidden="true">${ic('music', { size: 40 })}<div class="music-bars__bars">${raw(MUSIC_BARS)}</div>${ic('music-2', { size: 40 })}</div>
          <div class="sound-card__song">
            <span class="sound-card__song-label">The song</span>
            <span class="sound-card__secret" role="img" aria-label="Song title hidden until the reveal">? ? ?</span>
            <span class="sound-card__song-note">${ic('lock', { size: 26 })}Revealed after the guess</span>
          </div>
        </div>
        <div class="sound-card__side">
          ${ring('lg', { unit: started ? 'SECONDS LEFT' : 'READY' })}
          <span class="sound-card__peek">${ic('smartphone', { size: 26 })}${perf ? `Only ${perf} sees the song` : 'The song is on one phone'}</span>
        </div>
      </div>
      <div class="sound-card__foot">
        ${c.hint ? h`${ic('lightbulb', { size: 34 })}<span><strong>Hint:</strong> ${c.hint}</span>` : h`${ic('bell', { size: 34 })}<span>Not guessed in time? Every other team can <strong>buzz in to steal</strong> it for ${formatPoints(c.stealPoints)}.</span>`}
      </div>
    </div>
  </section>`;
  return view('sound', html, { key: `sound:${c.id}:${perf || ''}`, say: `${perf || t.name} is humming. ${t.name}, name that tune!` });
}

/* ---------- dare ---------- */
function dareWho(c, t) {
  const p = c.performer?.name;
  const q = c.partner?.name;
  switch (c.dare?.who) {
    case 'pair': return p && q ? `${p} & ${q} perform · ${t.name} cheers` : `Two players from ${t.name}`;
    case 'team': return `All of ${t.name}`;
    case 'everyone': return 'Every team joins in';
    default: return p ? `${p} performs · the rest of ${t.name} helps` : `One player from ${t.name}`;
  }
}
function performerLine(c, t) {
  const names = [c.performer?.name, c.partner?.name].filter(Boolean);
  if (c.dare?.who === 'team') return t.name;
  if (c.dare?.who === 'everyone') return 'Everyone!';
  return names.length ? names.join(' & ') : t.name;
}
function dareCard(s, c, t, extra = '') {
  const d = c.dare || {};
  const mult = multiplier(s);
  const kind = d.hasSecret ? ['eye-off', 'SECRET ON PHONE'] : { pair: ['users', 'PAIR DARE'], team: ['users', 'TEAM DARE'], everyone: ['party-popper', 'EVERYONE PLAYS'] }[d.who] || ['user', 'SOLO DARE'];
  return h`<section class="dare-card" aria-label="Dare card">
    ${FILM_HOLES}
    <span class="dare-card__mark">${ic('clapperboard', { size: 230, stroke: 2 })}</span>
    <div class="dare-card__body">
      <div class="dare-card__chips">
        <span class="chip dare-chip">${ic('drama', { size: 26 })}DARE</span>
        <span class="chip chip--outline dare-chip--line">${ic(kind[0], { size: 24 })}${kind[1]}</span>
        ${pointsLabel(c.points, mult)}
      </div>
      <h1 class="dare-card__title ${fit(d.title, [16, 26])}">${d.title}</h1>
      <p class="dare-card__text ${fit(d.instructions, [110, 170, 240])}">${d.instructions}</p>
      <div class="dare-card__facts">
        <span class="dare-fact">${ic('users', { size: 28 })}<strong>WHO</strong>${dareWho(c, t)}</span>
        <span class="dare-fact">${ic('hand', { size: 28 })}<strong>PROPS</strong>${d.props?.length ? listJoin(d.props, 'and') : 'None — just you'}</span>
      </div>
      ${extra}
    </div>
    ${FILM_HOLES}
  </section>`;
}
function scrDare(s, c) {
  const t = activeTeam(s);
  const d = c.dare || {};
  const mult = multiplier(s);
  const started = !!s.timer?.started;
  const judge = h`<div class="dare-judge">
    <div class="dare-judge__head">${ic('gavel', { size: 26 })}<span>When time’s up, the host decides</span></div>
    ${d.judge ? h`<p class="dare-judge__rule">${d.judge}</p>` : ''}
    <div class="dare-judge__pills">
      <span class="judge-pill judge-pill--nailed">Nailed it <b>${200 * mult}</b></span>
      <span class="judge-pill judge-pill--valiant">Valiant effort <b>${100 * mult}</b></span>
      <span class="judge-pill judge-pill--fail">Not this time <b>0</b></span>
      <span class="judge-pill judge-pill--bonus">${ic('heart', { size: 22 })}Crowd favourite <b>+${50 * mult}</b></span>
    </div>
  </div>`;
  const perf = performerLine(c, t);
  const html = h`<section class="scr scr--dare">
    ${dareCard(s, c, t, judge)}
    <aside class="dare-side" style="${teamVar(t)}">
      <div class="dare-side__who">
        <span class="eyebrow-tv ink-gold">Now performing</span>
        ${disc(t, { size: 84, className: 'disc--halo' })}
        <span class="dare-side__name ${fit(perf, [10, 16, 24])}">${perf}</span>
        ${c.answer
          ? h`<span class="tv-pill tv-pill--gold">${ic('eye', { size: 28 })}The secret: <strong>${c.answer}</strong></span>`
          : d.hasSecret ? h`<span class="tv-pill tv-pill--gold">${ic('smartphone', { size: 28 })}The secret is on ${possessive(c.performer?.name || 'their')} phone</span>` : ''}
      </div>
      ${ring('xl', { unit: started ? 'SECONDS LEFT' : 'READY' })}
    </aside>
  </section>`;
  return view('dare', html, { key: `dare:${c.id}:${d.title}`, say: `Dare: ${d.title}. ${perf} performs.` });
}

function scrDareVote(s, c) {
  const t = activeTeam(s);
  const v = c.vote || { nailed: 0, good: 0, voters: 0, eligible: 0 };
  const total = v.nailed + v.good;
  const mult = multiplier(s);
  const lead = total && v.nailed !== v.good ? (v.nailed > v.good ? 'nailed' : 'good') : null;
  const bar = (k, count, label, points, icon) => {
    const share = total ? count / total : 0;
    return h`<div class="vote-row vote-row--${k}" data-key="${k}">
      <div class="vote-row__label"><span class="vote-row__icon">${ic(icon, { size: 58 })}</span><div class="vote-row__text"><span class="vote-row__name">${label}</span><span class="vote-row__pts">${points} points</span></div></div>
      <div class="vote-bar ${count ? '' : 'is-empty'} ${lead === k ? 'is-lead' : ''}" style="--pct:${pct(share * 100)}" role="img" aria-label="${label}: ${plural(count, 'vote')}">
        <div class="vote-bar__fill"><span class="vote-bar__num">${count}</span><span class="vote-bar__unit">${count === 1 ? 'VOTE' : 'VOTES'}</span></div>
        <span class="vote-bar__mid" aria-hidden="true"></span>
        ${k === 'nailed' ? h`<span class="vote-bar__mid-label" aria-hidden="true">Majority wins</span>` : ''}
        ${lead === k ? h`<span class="vote-bar__lead">${ic('party-popper', { size: 30 })}Leading</span>` : ''}
      </div>
    </div>`;
  };
  const dots = Math.min(v.eligible, 30);
  const html = h`<section class="scr scr--vote">
    <div class="vote-head">
      <div class="vote-head__main">
        <div class="vote-head__chips"><span class="chip dare-chip--gold">${ic('drama', { size: 26 })}DARE</span><span class="chip chip--outline">${(c.dare?.title || '').toUpperCase()}</span><span class="chip vote-chip">${ic('thumbs-up', { size: 26 })}ROOM VOTE</span></div>
        <h1 class="vote-head__title">The room decides!</h1>
        <div class="vote-head__q" style="${teamVar(t)}">${disc(t, { size: 58, className: 'disc--halo' })}<span>How did <strong class="vote-head__name">${performerLine(c, t)}</strong> do? Vote on your phone!</span></div>
      </div>
      ${ring('vote', { unit: 'SECONDS LEFT' })}
    </div>
    <section class="vote-meter" aria-label="Live applause meter">
      ${bar('nailed', v.nailed, 'Nailed it', 200 * mult, 'thumbs-up')}
      ${bar('good', v.good, 'Good try', 100 * mult, 'hand-metal')}
    </section>
    <div class="vote-foot">
      <div class="vote-foot__count">${ic('users', { size: 42 })}<span class="vote-foot__num"><span class="ink-gold">${v.voters}</span> of ${v.eligible} voted</span>
        <span class="vote-dots" role="img" aria-label="${v.voters} of ${v.eligible} phones have voted">${Array.from({ length: dots }, (_, i) => raw(`<i class="${i < v.voters ? 'is-on' : ''}"></i>`))}</span></div>
      <div class="vote-foot__note" style="${teamVar(t)}">${disc(t, { size: 44 })}${ic('lock', { size: 22 })}<span><strong>${t.name}</strong> can’t vote on their own dare</span></div>
    </div>
  </section>`;
  return view('dare-vote', html, { key: `vote:${c.id}`, header: true, strip: false, backdrop: raw('<div class="bd-glow bd-glow--gold-left"></div>'), say: 'Room vote! How did they do? Vote on your phone.' });
}

function scrDareResult(s, c) {
  const t = activeTeam(s);
  const r = c.dareResult?.result || (c.result?.kind === 'skipped' ? 'skipped' : c.result?.kind) || 'fail';
  const bonus = !!c.dareResult?.bonus;
  const got = (c.result?.awards || []).filter((a) => a.teamId === t.id).reduce((a, b) => a + b.delta, 0);
  const stamp = { nailed: ['NAILED IT!', 'party-popper'], valiant: ['VALIANT EFFORT', 'heart'], fail: ['NOT THIS TIME', 'hand'], skipped: ['SKIPPED', 'skip-forward'] }[r] || ['DONE', 'check'];
  const v = c.vote;
  const m = multiplier(s);
  const pill = (k, label, pts) => h`<span class="judge-pill judge-pill--${k} ${r === k ? 'is-chosen' : 'is-dim'}">${r === k ? ic('check', { size: 22, stroke: 3 }) : ''}${label} <b>${pts}</b></span>`;
  const extra = h`${c.answer ? h`<div class="dare-reveal">${ic('eye', { size: 30 })}<span>The secret was</span><strong>${c.answer}</strong></div>` : ''}
    <div class="dare-judge ${c.answer ? 'is-tight' : ''}"><div class="dare-judge__head">${ic('gavel', { size: 26 })}<span>${v && (v.nailed || v.good) ? 'The room has spoken' : 'The host’s verdict'}</span></div>
      <div class="dare-judge__pills">${pill('nailed', 'Nailed it', 200 * m)}${pill('valiant', 'Valiant effort', 100 * m)}${pill('fail', 'Not this time', 0)}<span class="judge-pill judge-pill--bonus ${bonus ? 'is-chosen' : 'is-dim'}">${ic('heart', { size: 22 })}Crowd favourite <b>+${50 * m}</b></span></div></div>`;
  const html = h`<section class="scr scr--dare scr--dare-result">
    ${dareCard(s, c, t, extra)}
    <aside class="dare-side dare-side--result" style="${teamVar(t)}" data-fly-from>
      <span class="dare-stamp dare-stamp--${r}">${ic(stamp[1], { size: 44 })}<span>${stamp[0]}</span></span>
      <div class="dare-side__who">
        ${disc(t, { size: 84 })}
        <span class="dare-side__name ${fit(performerLine(c, t), [10, 16, 24])}">${performerLine(c, t)}</span>
        <span class="dare-side__got ${got > 0 ? 'is-up' : ''}">${got > 0 ? formatDelta(got) : 'No points'}</span>
        ${bonus ? h`<span class="tv-pill tv-pill--gold">${ic('heart', { size: 26 })}Crowd favourite +${50 * multiplier(s)}</span>` : ''}
        ${v && (v.nailed || v.good) ? h`<span class="dare-side__vote">The room voted <strong>${v.nailed}</strong> nailed it · <strong>${v.good}</strong> good try</span>` : ''}
      </div>
      ${upNextPill(s)}
    </aside>
  </section>`;
  return view('dare-result', html, { key: `dare-result:${c.id}`, say: `${stamp[0]}. ${got > 0 ? `${t.name} scores ${got}.` : ''}` });
}

/* ---------- showdown ---------- */
function scrShowdownPick(s, c) {
  const t = activeTeam(s);
  const eye = c.eyeing;
  const targets = (c.targets || []).map(team).filter(Boolean);
  const html = h`<section class="scr scr--showdown">
    <div class="sd-card">
      <span class="sd-card__split" aria-hidden="true"></span>
      <span class="sd-card__mark">${ic('swords', { size: 420, stroke: 2 })}</span>
      <div class="sd-card__top">
        <div class="sd-card__lead"><span class="chip sd-chip">${ic('swords', { size: 26 })}SHOWDOWN</span><span class="sd-card__line"><strong>${t.name}</strong> — pick a rival on your phones</span></div>
        <span class="sd-prize">Winner <b>${200 * multiplier(s)}</b><i aria-hidden="true">·</i>Tie <b>100</b> each</span>
      </div>
      <div class="sd-pick">
        <h1 class="sd-pick__title">Who will ${t.name} call out?</h1>
        <p class="sd-pick__eye">${eye ? h`${ic('pointer', { size: 30 })}<span>${eye.by?.name || t.name} is eyeing <strong>${team(eye.teamId)?.name || ''}</strong>…</span>` : h`${ic('smartphone', { size: 30 })}<span>Choosing on their phones…</span>`}</p>
        <div class="sd-targets sd-targets--n${Math.min(targets.length, 7)}" role="list">
          ${targets.map((x) => h`<div class="sd-target ${eye?.teamId === x.id ? 'is-eyed' : ''}" role="listitem" data-key="${x.id}" style="${teamVar(x)}">
            ${eye?.teamId === x.id ? h`<span class="sd-target__tag">CALLED OUT?</span>` : ''}
            ${disc(x, { size: 76 })}<span class="sd-target__name">${x.name}</span><span class="sd-target__score">${formatPoints(x.score)}</span>
          </div>`)}
        </div>
      </div>
      <div class="sd-rule">${ic('users', { size: 40 })}<span>One player from each team goes head to head. The host picks the winner.</span></div>
    </div>
  </section>`;
  return view('showdown-pick', html, { key: `showdown-pick:${c.id}`, say: `Showdown! ${t.name}, pick a rival team.` });
}
function scrShowdown(s, c) {
  const t = activeTeam(s);
  const rivalTeam = team(c.rival?.teamId);
  const sd = c.showdown || {};
  const started = !!s.timer?.started;
  const done = c.stage === 'done';
  const w = c.winnerSide;
  const aName = c.performer?.name || t.name;
  const bName = c.rival?.name || rivalTeam?.name || '';
  const side = (tm, name, which) => {
    const won = done && (w === which || w === 'tie');
    const lost = done && w && w !== 'tie' && w !== which;
    const delta = (c.result?.awards || []).filter((a) => a.teamId === tm?.id).reduce((x, y) => x + y.delta, 0);
    return h`<div class="sd-side sd-side--${which} ${won ? 'is-won' : ''} ${lost ? 'is-lost' : ''}" style="${teamVar(tm)}" ${won ? raw('data-fly-from') : ''}>
      ${disc(tm, { size: 180, className: 'sd-side__disc' })}
      <div class="sd-side__text"><span class="sd-side__team">${(tm?.name || '').toUpperCase()}</span><span class="sd-side__name ${fit(name, [6, 10, 14])}">${name}</span>
      ${won ? h`<span class="sd-side__won">${w === 'tie' ? 'Tie' : 'Wins!'} ${delta ? formatDelta(delta) : ''}</span>` : ''}</div>
    </div>`;
  };
  const html = h`<section class="scr scr--showdown">
    <div class="sd-card ${done ? 'is-done' : ''}" aria-label="Showdown: ${aName} from ${t.name} versus ${bName} from ${rivalTeam?.name || ''}">
      <span class="sd-card__split" aria-hidden="true"></span>
      <span class="sd-card__glow" aria-hidden="true"></span>
      <span class="sd-card__mark">${ic('swords', { size: 420, stroke: 2 })}</span>
      <div class="sd-card__top">
        <div class="sd-card__lead"><span class="chip sd-chip">${ic('swords', { size: 26 })}SHOWDOWN</span><span class="sd-card__line"><strong>${t.name}</strong> called out <strong>${rivalTeam?.name || ''}</strong>${done ? '' : ' — get to the front!'}</span></div>
        <span class="sd-prize">Winner <b>${200 * multiplier(s)}</b><i aria-hidden="true">·</i>Tie <b>100</b> each</span>
      </div>
      <div class="sd-versus">
        ${side(t, aName, 'active')}
        <div class="sd-vs" role="img" aria-label="${done ? (w === 'tie' ? 'It’s a tie' : 'Winner decided') : 'Versus'}">
          <span class="sd-vs__ring"></span>
          <span class="sd-vs__text">${done && w === 'tie' ? 'TIE' : 'VS'}</span>
        </div>
        ${side(rivalTeam, bName, 'rival')}
      </div>
      <div class="sd-challenge">
        <span class="sd-challenge__icon">${ic('target', { size: 68 })}</span>
        <div class="sd-challenge__text"><span class="sd-challenge__label">The challenge</span><h1 class="sd-challenge__title ${fit(sd.title, [20, 30])}">${sd.title || ''}</h1><p class="sd-challenge__rule ${fit(sd.instructions, [110, 170])}">${sd.instructions || ''}</p></div>
        ${done ? upNextPill(s) : ring('sd', { unit: started ? 'SECONDS' : 'READY' })}
      </div>
    </div>
  </section>`;
  const say = done ? (w === 'tie' ? 'It’s a tie! 100 points each.' : `${w === 'active' ? aName : bName} wins the showdown!`) : `Showdown: ${aName} versus ${bName}. ${sd.title || ''}`;
  return view(done ? 'showdown-result' : 'showdown', html, { key: `showdown:${c.id}:${done ? 'done' : 'battle'}:${sd.title || ''}`, stripMode: 'rival', say });
}

/* ---------- rapid list ---------- */
function scrRapid(s, c) {
  const t = activeTeam(s);
  const L = c.list || { ticked: [], count: 0, max: 6, each: 50 };
  const done = c.stage === 'done';
  const mult = multiplier(s);
  const shown = L.ticked.slice(0, L.max);
  const so = Math.min(L.count, L.max) * L.each * mult;
  const latest = L.ticked.length - 1;
  const cards = [];
  for (let i = 0; i < L.max; i++) {
    const a = shown[i];
    cards.push(a != null
      ? h`<div class="rl-answer ${i === latest && !done ? 'is-new' : ''}" data-key="a${i}">${i === latest && !done ? h`<span class="rl-answer__plus">+${L.each * mult}</span>` : ''}<span class="rl-answer__tick">${ic('check', { size: 30, stroke: 2.8 })}</span><span class="rl-answer__text ${fit(a, [9, 14])}">${a}</span></div>`
      : h`<div class="rl-answer is-empty" data-key="e${i}" aria-label="Answer ${i + 1}, not named yet"><span class="rl-answer__n">${i + 1}</span><span class="rl-answer__line" aria-hidden="true"></span></div>`);
  }
  const extra = Math.max(0, L.ticked.length - L.max);
  const revealed = done && Array.isArray(L.answers);
  const html = h`<section class="scr scr--rapid ${revealed ? 'is-revealed' : ''}">
    <div class="rl-card">
      <div class="rl-card__top">
        <div class="rl-card__main">
          <div class="rl-card__chips"><span class="chip rl-chip">${ic('list-checks', { size: 26 })}RAPID LIST</span><span class="pts-label">${L.each * mult} POINTS EACH</span><span class="chip chip--outline rl-chip--line">MAX ${L.max * L.each * mult}</span></div>
          <h1 class="rl-card__prompt ${fit(L.prompt, [24, 40, 60])}">${L.prompt}</h1>
          <div class="rl-card__team" style="${teamVar(t)}">${disc(t, { size: 56 })}<span>${done ? (L.count ? `${t.name} named ${L.count}!` : `Time’s up, ${t.name}!`) : `${t.name} — shout them out!`}</span></div>
          <p class="rl-card__note">${done ? (revealed ? 'Here’s every answer that counted:' : 'Nice shouting. Points are on the board.') : 'Any order. The host ticks each one off as you shout it.'}</p>
        </div>
        <div class="rl-count" ${done ? raw('data-fly-from') : ''}>
          <div class="rl-count__main">
            <span class="rl-count__label">${done ? 'Named in time' : 'Answers named'}</span>
            <div class="rl-count__nums" aria-label="${Math.min(L.count, L.max)} of ${L.max} named"><span class="rl-count__n">${Math.min(L.count, L.max)}</span><span class="rl-count__of">of ${L.max}</span></div>
            <div class="rl-count__pips" aria-hidden="true">${Array.from({ length: L.max }, (_, i) => raw(`<i class="${i < L.count ? 'is-on' : ''}"></i>`))}</div>
            <span class="rl-count__pts"><b>${formatPoints(so)}</b> points${done ? '' : ' so far'}</span>
          </div>
          ${done ? '' : ring('rl', { unit: s.timer?.started ? 'SECONDS LEFT' : 'READY' })}
        </div>
      </div>
      ${revealed
        ? h`<div class="rl-all">${revealList(L)}</div>`
        : h`<div class="rl-answers">${cards}</div>`}
      ${extra ? h`<p class="rl-extra">+${extra} more named — still counts toward the max</p>` : ''}
    </div>
  </section>`;
  return view(done ? 'rapid-result' : 'rapid', html, { key: `rapid:${c.id}:${done ? 'done' : 'list'}:${revealed ? 'r' : ''}`, say: done ? `${t.name} named ${L.count}.` : `Rapid list: ${L.prompt}` });
}

function revealList(L) {
  const hits = L.answers.filter((a) => L.ticked.includes(a));
  const rest = L.answers.filter((a) => !L.ticked.includes(a));
  const room = Math.max(0, 16 - hits.length);
  const shown = rest.slice(0, room);
  const more = rest.length - shown.length;
  return h`${hits.map((a) => h`<span class="rl-all__item is-hit">${ic('check', { size: 22, stroke: 2.8 })}${a}</span>`)}${shown.map((a) => h`<span class="rl-all__item">${a}</span>`)}${more > 0 ? h`<span class="rl-all__item is-more">+${more} more</span>` : ''}`;
}

/* ---------- hot seat ---------- */
function scrHotSeat(s, c) {
  const t = activeTeam(s);
  const hs = c.hotseat || { index: 0, total: 6, results: [], question: null, each: 50, banked: 0 };
  const done = c.stage === 'done';
  const perf = c.performer?.name || t.name;
  const right = hs.results.filter((r) => r === 'correct').length;
  const dots = Array.from({ length: hs.total }, (_, i) => {
    const r = hs.results[i];
    if (r === 'correct') return h`<span class="hs-dot is-correct" data-key="d${i}">${ic('check', { size: 40, stroke: 2.8 })}</span>`;
    if (r === 'wrong') return h`<span class="hs-dot is-wrong" data-key="d${i}">${ic('x', { size: 40, stroke: 2.8 })}</span>`;
    if (r === 'pass') return h`<span class="hs-dot is-pass" data-key="d${i}">${ic('skip-forward', { size: 34 })}</span>`;
    if (i === hs.index && !done) return h`<span class="hs-dot is-current" data-key="d${i}">${i + 1}</span>`;
    return h`<span class="hs-dot" data-key="d${i}">${i + 1}</span>`;
  });
  const qText = done
    ? h`<span class="hs-q__label">${ic('flame', { size: 26 })}Hot Seat over</span><h1 class="hs-q__text">${perf} got ${right} of ${hs.total} right</h1>`
    : hs.question
      ? h`<span class="hs-q__label">${ic('flame', { size: 26 })}Quick-fire · ${hs.each * multiplier(s)} points</span><h1 class="hs-q__text ${fit(hs.question, [70, 110, 160])}">${hs.question}</h1>`
      : h`<span class="hs-q__label">${ic('timer', { size: 26 })}Get ready, ${perf}</span><h1 class="hs-q__text">The first question pops up the moment the clock starts.</h1>`;
  const html = h`<section class="scr scr--hotseat">
    <div class="hs-card" aria-label="Hot Seat: ${perf} from ${t.name}">
      <span class="hs-card__mark">${ic('flame', { size: 620, stroke: 2 })}</span>
      <div class="hs-left" style="${teamVar(t)}">
        <span class="chip hs-chip">${ic('flame', { size: 26 })}HOT SEAT</span>
        <div class="hs-left__hero"><span class="hs-left__glow"></span>${disc(t, { size: 140, className: 'hs-left__disc' })}</div>
        <span class="hs-left__name ${fit(perf, [6, 9, 13])}">${perf}</span>
        <span class="hs-left__line">${done ? 'is out of the Hot Seat' : 'is in the Hot Seat'}</span>
        <span class="hs-left__sub">${t.name} · flying solo</span>
        <div class="hs-stats">
          <div class="hs-stat"><span class="hs-stat__n">${hs.each * multiplier(s)}</span><span class="hs-stat__l">Points each</span></div>
          <div class="hs-stat" ${done ? raw('data-fly-from') : ''}><span class="hs-stat__n ink-gold">${formatPoints(hs.banked)}</span><span class="hs-stat__l">Banked${done ? '' : ' so far'}</span></div>
        </div>
      </div>
      <div class="hs-right">
        <div class="hs-right__top">
          <div class="hs-progress"><span class="hs-progress__label">${done ? 'Final tally' : `Question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}`}</span><div class="hs-dots" role="img" aria-label="${right} correct so far">${dots}</div></div>
          ${done ? upNextPill(s) : ring('hs', { unit: s.timer?.started ? 'LEFT' : 'READY' })}
        </div>
        <div class="hs-q">${qText}</div>
        <p class="hs-right__note">${ic('mic', { size: 32 })}<span>${done ? `${formatPoints(hs.banked)} points to ${t.name}.` : h`${perf} answers out loud — <strong>teammates, no helping!</strong>`}</span></p>
      </div>
    </div>
  </section>`;
  return view(done ? 'hotseat-result' : 'hotseat', html, { key: `hotseat:${c.id}:${done ? 'done' : 'live'}`, say: done ? `${perf} banked ${hs.banked} points.` : hs.question || `${perf} is in the Hot Seat.` });
}

/* ---------- all play + round bonus ---------- */
function scrAllPlay(s, c) {
  const bonus = c.type === 'bonus';
  const marking = c.stage === 'marking';
  const subs = c.submissions || [];
  const answered = subs.filter((x) => x.answered).length;
  const title = bonus ? 'ROUND BONUS' : 'ALL PLAY';
  const html = h`<section class="scr scr--allplay ${bonus ? 'is-bonus' : ''}">
    <section class="ap-card" aria-label="${bonus ? 'Round bonus' : 'All Play'} question for every team">
      <span class="ap-card__mark">${ic(bonus ? 'gift' : 'zap', { size: 620, stroke: 2 })}</span>
      <div class="ap-card__top">
        <div class="ap-card__title"><span class="ap-card__icon">${ic(bonus ? 'gift' : 'zap', { size: 60 })}</span><div class="ap-card__words"><span class="ap-card__big">${title}</span><span class="ap-card__sub">${marking ? '— answers are locked!' : '— every team, type your answer!'}</span></div></div>
        ${marking ? h`<div class="ap-lock">${ic('lock', { size: 64 })}<span>Locked</span></div>` : ring('ap', { unit: 'SECONDS LEFT' })}
      </div>
      <div class="ap-card__q"><span class="ap-card__q-label">Question for every team</span><h1 class="ap-card__q-text ${fit(c.question, [70, 110, 160])}">${c.question}</h1></div>
      <div class="ap-card__foot">
        <div class="ap-card__rules">
          <span class="ap-rule"><b>100</b>per correct team</span>
          ${bonus ? '' : h`<i class="ap-card__dot" aria-hidden="true"></i><span class="ap-rule">${ic('sparkles', { size: 34 })}<b>+${c.firstBonus || 50}</b>for the first correct</span>`}
        </div>
        <span class="ap-card__status">${ic(marking ? 'gavel' : 'keyboard', { size: 30 })}${marking ? 'The host is checking the answers…' : `${answered} of ${subs.length} teams answered`}</span>
      </div>
    </section>
    <section class="ap-teams ap-teams--n${Math.min(subs.length, 8)}" role="list" aria-label="Which teams have answered">
      ${subs.map((x) => {
        const tm = team(x.teamId);
        if (!tm) return '';
        return h`<div class="ap-team ${x.answered ? 'is-in' : marking ? 'is-none' : ''}" role="listitem" data-key="${x.teamId}" style="${teamVar(tm)}">
          <div class="ap-team__top">${disc(tm, { size: 56 })}${x.answered
            ? h`<span class="ap-team__tag">${ic('check', { size: 20, stroke: 3 })}ANSWERED</span>`
            : marking ? h`<span class="ap-team__none">No answer</span>` : h`<span class="ap-team__typing"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>typing…</span>`}</div>
          <span class="ap-team__name">${tm.name}</span>
        </div>`;
      })}
    </section>
    <p class="ap-note"><span>${ic('smartphone', { size: 30 })}Answer on any phone on your team — <strong>the last answer counts</strong></span><span>${ic('lock', { size: 26 })}Answers stay hidden until the reveal</span></p>
  </section>`;
  const name = `${bonus ? 'bonus' : 'allplay'}${marking ? '-marking' : ''}`;
  return view(name, html, { key: `${name}:${c.id}:${c.question}`, strip: false, say: marking ? 'Answers are locked.' : `${title}! Every team, type your answer. ${c.question}` });
}

function scrAllPlayReveal(s, c) {
  const bonus = c.type === 'bonus';
  const subs = c.submissions || [];
  const right = subs.filter((x) => x.correct).length;
  const first = team(c.firstTeamId);
  const n = subs.length;
  const html = h`<section class="scr scr--reveal ${bonus ? 'is-bonus' : ''}">
    <section class="rv-q" aria-label="The question">
      <span class="rv-q__icon">${ic(bonus ? 'gift' : 'zap', { size: 48 })}</span>
      <div class="rv-q__text"><span class="rv-q__label">${bonus ? 'Round bonus' : 'All Play'} · the answers are in</span><p class="rv-q__q">${c.question}</p></div>
      <div class="rv-q__score"><span class="rv-q__score-label">Got it right</span><span class="rv-q__score-n">${right} of ${n}</span></div>
    </section>
    <section class="rv-answer" aria-label="Correct answer: ${c.answer || ''}">
      <span class="rv-answer__icon">${ic('check', { size: 70, stroke: 2.8 })}</span>
      <div class="rv-answer__text"><span class="rv-answer__label">The answer</span><span class="rv-answer__value ${fit(c.answer, [24, 36])}">${c.answer || ''}</span></div>
      ${first && !bonus ? h`<div class="rv-first" style="${teamVar(first)}">${disc(first, { size: 60 })}<span class="rv-first__text"><span class="rv-first__label">First correct · +${c.firstBonus || 50}</span><span class="rv-first__name">${first.name}</span></span></div>` : ''}
    </section>
    <ol class="rv-grid rv-grid--n${Math.min(n, 8)}" role="list" aria-label="Every team’s typed answer">
      ${subs.map((x, i) => {
        const tm = team(x.teamId);
        if (!tm) return '';
        const delta = x.delta || 0;
        return h`<li class="rv-card ${x.correct ? 'is-right' : ''} ${x.first ? 'is-first' : ''}" data-key="${x.teamId}" style="${teamVar(tm)}">
          ${x.first ? h`<span class="rv-card__first">${ic('zap', { size: 18 })}FIRST CORRECT</span>` : ''}
          <div class="rv-card__head">${disc(tm, { size: 56 })}<span class="rv-card__name">${tm.name}</span><span class="rv-card__mark ${x.correct ? 'is-yes' : 'is-no'}" role="img" aria-label="${x.correct ? 'Correct' : 'Not this time'}">${ic(x.correct ? 'check' : 'x', { size: 30, stroke: 2.8 })}</span></div>
          <div class="rv-card__note-wrap">${x.answered ? h`<span class="paper-note tilt-${i % 5}">“${x.text}”</span>` : h`<span class="paper-note is-blank tilt-${i % 5}">No answer</span>`}</div>
          <div class="rv-card__foot">
            <span class="rv-card__delta ${delta > 0 ? 'is-up' : ''}">${delta > 0 ? formatDelta(delta) : '0'}${x.first ? h`<span class="rv-card__first-tag">FIRST!</span>` : ''}</span>
            <span class="rv-card__now">${delta > 0 ? 'now' : 'stays at'} <strong>${formatPoints(tm.score)}</strong></span>
          </div>
        </li>`;
      })}
    </ol>
  </section>`;
  const name = bonus ? 'bonus-reveal' : 'allplay-reveal';
  return view(name, html, { key: `${name}:${c.id}`, strip: false, say: `The answer: ${c.answer}. ${right} of ${n} teams got it right.` });
}

/* ---------- double down ---------- */
function scrDoubleDown(s) {
  const t = activeTeam(s);
  const decor = raw(`<div class="dd-decor" aria-hidden="true">${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map((k) => `<span class="dd-decor__s dd-decor__s--${k}">${ic('sparkles', { size: 64 })}</span>`).join('')}</div>`);
  const html = h`<section class="scr scr--dd">
    ${decor}
    <span class="splash__eyebrow dd-eyebrow">${ic('sparkles', { size: 28 })}The wheel landed on</span>
    <h1 class="splash__word dd-word">DOUBLE DOWN!</h1>
    <p class="splash__sub dd-sub">${t.name} spins again —<br>whatever you win next is <span class="highlight-word">doubled</span></p>
    <div class="dd-call" style="${teamVar(t)}">${disc(t, { size: 52 })}<span>Spin from ${anyPhone(t)}</span>${ic('smartphone', { size: 34 })}</div>
  </section>`;
  return view('double-down', html, { key: `dd:${s.turnId}`, surface: 'splash', backdrop: raw('<div class="splash splash--contained dd-splash"></div>'), say: `Double Down! ${t.name} spins again, and everything you win this turn is doubled.` });
}

/* ---------- grinch steal ---------- */
function scrGrinchPick(s, c) {
  const t = activeTeam(s);
  const eye = c.eyeing;
  const targets = new Set(c.targets || []);
  const others = s.teams.filter((x) => x.id !== t.id).sort((a, b) => b.score - a.score);
  const eyed = eye ? team(eye.teamId) : null;
  const take = (victim) => Math.min(c.points, victim.score);
  const gain = eyed ? take(eyed) : c.points;
  const order = (id) => 1 + s.teams.filter((x) => x.score > (team(id)?.score ?? 0)).length;
  const html = h`<section class="scr scr--grinch">
    <span class="grinch-hazard" aria-hidden="true"></span>
    <div class="grinch-head">
      <span class="grinch-head__icon">${ic('hand-coins', { size: 80 })}</span>
      <h1 class="grinch-head__title">GRINCH STEAL!</h1>
    </div>
    <div class="grinch-sub" style="${teamVar(t)}">
      ${disc(t, { size: 84, className: 'grinch-sub__disc' })}
      <div class="grinch-sub__text">
        <span class="grinch-sub__line">${t.name} can rob any team ahead of them</span>
        <span class="grinch-sub__eye">${eye ? h`${ic('smartphone', { size: 28 })}<span>${eye.by?.name || t.name} is eyeing <strong>${eyed?.name || ''}</strong>…</span>` : h`${ic('smartphone', { size: 28 })}<span>Choosing on their phones…</span>`}</span>
      </div>
    </div>
    <div class="grinch-targets grinch-targets--n${Math.min(others.length, 7)}" role="list" aria-label="Teams ${t.name} can steal from">
      ${others.map((x) => {
        const can = targets.has(x.id);
        const isEyed = eye?.teamId === x.id;
        const lead = leaders(s).has(x.id);
        if (!can) {
          return h`<div class="g-target is-safe" role="listitem" data-key="${x.id}" style="${teamVar(x)}">
            ${disc(x, { size: 76, className: 'g-target__disc' })}<span class="g-target__name">${x.name}</span><span class="g-target__score">${formatPoints(x.score)}</span>
            <span class="g-target__safe">${ic('shield-check', { size: 24 })}${x.score === t.score ? 'level — safe' : 'behind you — safe'}</span>
          </div>`;
        }
        return h`<div class="g-target ${isEyed ? 'is-eyed' : ''}" role="listitem" data-key="${x.id}" style="${teamVar(x)}">
          ${isEyed ? h`<span class="g-target__tag">UH-OH…</span>` : ''}
          ${disc(x, { size: 76 })}<span class="g-target__name">${x.name}</span>
          <span class="g-target__score">${formatPoints(x.score)}${lead ? ic('crown', { size: 34, label: 'Leader' }) : ''}</span>
          ${isEyed ? h`<span class="g-target__drop">would drop to ${formatPoints(x.score - take(x))}</span>` : h`<span class="g-target__place">${ordinal(order(x.id))} place</span>`}
          ${isEyed ? h`<span class="g-target__hand" role="img" aria-label="${eye.by?.name || ''} is hovering on this team">${ic('pointer', { size: 42 })}</span>` : ''}
        </div>`;
      })}
    </div>
    <div class="grinch-bar" style="${teamVar(t)}">
      <div class="grinch-bar__left">${ic('arrow-right-left', { size: 50 })}<span>Up to ${formatPoints(c.points)} points change hands</span></div>
      <div class="grinch-bar__right">${disc(t, { size: 52 })}<span>${t.name}</span><span class="grinch-bar__from">${formatPoints(t.score)}</span>${ic('arrow-right', { size: 34, label: 'becomes' })}<span class="grinch-bar__to">${formatPoints(t.score + gain)}</span></div>
    </div>
  </section>`;
  return view('grinch-pick', html, { key: `grinch-pick:${c.id}`, surface: 'cream', backdrop: raw('<div class="bd-cream"><span class="bd-cream__glow"></span></div>'), say: `Grinch Steal! ${t.name} can rob a team ahead of them.` });
}
function grinchCard(tm, { tag, tagTone, big, sub, glow }) {
  return h`<div class="g-card ${glow ? 'is-glow' : ''}" style="${teamVar(tm)}">
    <span class="g-card__tag g-card__tag--${tagTone}">${tag}</span>
    ${disc(tm, { size: 108 })}
    <div class="g-card__text"><span class="g-card__name">${tm.name}</span><span class="g-card__score">${big}</span><span class="g-card__sub">${sub}</span></div>
  </div>`;
}
function scrGrinchDone(s, c) {
  const t = activeTeam(s);
  if (c.gift) {
    const to = team(c.gift.toTeamId);
    const before = (to?.score ?? 0) - c.gift.amount;
    const decor = raw(`<div class="gift-decor" aria-hidden="true">${['a', 'b', 'c', 'd'].map((k) => `<span class="gift-decor__g gift-decor__g--${k}">${ic('gift', { size: 170, stroke: 2 })}</span>`).join('')}${['a', 'b', 'c'].map((k) => `<span class="gift-decor__h gift-decor__h--${k}">${ic('heart', { size: 46 })}</span>`).join('')}</div>`);
    const html = h`<section class="scr scr--gift">
      ${decor}
      <span class="chip gift-chip">${ic('hand-coins', { size: 26 })}GRINCH STEAL</span>
      <div class="gift-hearts" role="img" aria-label="A heart growing three sizes"><span class="gift-hearts__1">${ic('heart', { size: 56 })}</span><span class="gift-hearts__2">${ic('heart', { size: 96 })}</span><span class="gift-hearts__3">${ic('heart', { size: 156 })}<span class="gift-hearts__spark">${ic('sparkles', { size: 48 })}</span></span></div>
      <h1 class="gift-title">Your heart grew three sizes!</h1>
      <p class="gift-line" style="${teamVar(t)}">${disc(t, { size: 54 })}<span><strong>${t.name}</strong> is in 1st — nobody to rob.</span></p>
      <p class="gift-line2">They gift <span class="ink-berry">${formatPoints(c.gift.amount)} points</span> to ${to?.name || ''}</p>
      <div class="gift-cards" role="group" aria-label="${t.name} gives ${c.gift.amount} points to ${to?.name || ''}">
        ${grinchCard(t, { tag: 'GIVES', tagTone: 'gold', big: h`${formatPoints(t.score)}${ic('crown', { size: 40, label: 'Still the leader' })}`, sub: 'still in 1st' })}
        <div class="gift-mid">${ic('arrow-right', { size: 44 })}<span class="gift-mid__box">${ic('gift', { size: 86 })}<span class="gift-mid__heart">${ic('heart', { size: 30 })}</span></span><span class="gift-mid__label">A gift of <b>${formatPoints(c.gift.amount)}</b></span></div>
        ${to ? grinchCard(to, { tag: formatDelta(c.gift.amount), tagTone: 'holly', big: formatPoints(to.score), sub: `from ${formatPoints(before)} · Merry Christmas!`, glow: true }) : ''}
      </div>
    </section>`;
    return view('grinch-gift', html, { key: `grinch-gift:${c.id}`, strip: false, surface: 'cream', backdrop: raw('<div class="bd-cream bd-cream--gift"></div>'), say: `${t.name}'s heart grew three sizes! They gift ${c.gift.amount} points to ${to?.name}.` });
  }
  if (c.steal) {
    const from = team(c.steal.from);
    const to = team(c.steal.to) || t;
    const html = h`<section class="scr scr--gift scr--heist">
      <span class="grinch-hazard" aria-hidden="true"></span>
      <div class="grinch-head grinch-head--center"><span class="grinch-head__icon">${ic('hand-coins', { size: 80 })}</span><h1 class="grinch-head__title">GRINCH STEAL!</h1></div>
      <p class="heist-line">${teamName(to)} steals <span class="ink-berry">${formatPoints(c.steal.amount)}</span> from ${teamName(from)}!</p>
      <div class="gift-cards" role="group" aria-label="${to.name} takes ${c.steal.amount} points from ${from?.name || ''}">
        ${from ? grinchCard(from, { tag: formatDelta(-c.steal.amount), tagTone: 'berry', big: formatPoints(from.score), sub: `from ${formatPoints(from.score + c.steal.amount)} · ouch!` }) : ''}
        <div class="gift-mid">${ic('arrow-right', { size: 44 })}<span class="gift-mid__box gift-mid__box--ember">${ic('hand-coins', { size: 86 })}</span><span class="gift-mid__label">Swiped <b>${formatPoints(c.steal.amount)}</b></span></div>
        ${grinchCard(to, { tag: formatDelta(c.steal.amount), tagTone: 'holly', big: formatPoints(to.score), sub: `from ${formatPoints(to.score - c.steal.amount)} · sneaky!`, glow: true })}
      </div>
      ${upNextPill(s)}
    </section>`;
    return view('grinch-steal', html, { key: `grinch-steal:${c.id}`, strip: false, surface: 'cream', backdrop: raw('<div class="bd-cream"><span class="bd-cream__glow"></span></div>'), say: `${to.name} steals ${c.steal.amount} points from ${from?.name}!` });
  }
  return scrSkipped(s, c);
}

/* ---------- skipped / fallback ---------- */
function scrSkipped(s, c) {
  const t = activeTeam(s);
  const seg = segOf(c.segmentIndex) || segOf(0);
  const html = h`<section class="scr scr--skipped">
    <div class="card skip-card">
      ${slotChip(seg)}
      <h1 class="skip-card__title">Skipped — no points this time</h1>
      <p class="skip-card__text">${t ? `${t.name} lives to spin another day.` : 'On to the next one!'}</p>
      ${upNextPill(s)}
    </div>
  </section>`;
  return view('skipped', html, { key: `skipped:${c.id}` });
}

/* ---------- round break ---------- */
function scrRoundBreak(s) {
  const rb = s.roundBreak;
  const st = rb.standings || [];
  const top = team(st[0]?.teamId);
  const max = Math.max(1, ...st.map((x) => x.score));
  const left = s.totalRounds - rb.round;
  const hasMove = st.some((x) => x.move);
  const tie = st.length > 1 && st[0].score === st[1].score;
  let lead;
  if (!st.length || st[0].score === 0) lead = 'Everyone’s still on zero — anything can happen!';
  else if (tie) lead = 'It’s neck and neck at the top!';
  else lead = `${top?.name} leads by ${formatPoints(rb.leadBy)} — ${rb.finalNext ? 'Final Chaos decides it.' : left === 1 ? 'one round left to catch them.' : `${left} rounds left to catch them.`}`;
  const next = rb.nextRound;
  const isLast = !rb.finalNext && next === s.totalRounds;
  const first = s.teams[0];
  const move = (x) => {
    if (!x.move) return '';
    if (x.move === 'up') return h`<span class="rb-move rb-move--up">${ic('arrow-up', { size: 26 })}UP ${x.places}</span>`;
    if (x.move === 'down') return h`<span class="rb-move rb-move--down">${ic('arrow-down', { size: 26 })}DOWN ${x.places}</span>`;
    return h`<span class="rb-move rb-move--same">${ic('minus', { size: 26 })}SAME</span>`;
  };
  const html = h`<section class="scr scr--round ${st.length > 6 ? 'is-many' : ''}">
    <div class="rb-head">
      <div class="rb-head__main">
        <span class="eyebrow-tv">Round ${rb.round} complete</span>
        <h1 class="rb-head__title">End of Round ${rb.round}</h1>
        <p class="rb-head__lead">${lead}</p>
      </div>
      <div class="rb-next">
        <span class="rb-next__tag">Up next</span>
        ${rb.bonusPlanned && !rb.bonusDone ? h`<div class="rb-next__row">${ic('gift', { size: 40 })}<span class="rb-next__title">Bonus question!</span></div><span class="rb-next__sub">Every team answers on a phone — 100 for each right answer. Then${rb.finalNext ? ' Final Chaos.' : ` Round ${next}.`}</span>`
          : rb.finalNext ? h`<div class="rb-next__row">${ic('sparkles', { size: 48 })}<span class="rb-next__title">Final Chaos!</span></div><span class="rb-next__sub">Every team wagers on one last question.</span>`
          : h`<div class="rb-next__row">${ic('flag', { size: 48 })}<span class="rb-next__title">${isLast ? `Round ${next} — the final round!` : `Round ${next} of ${s.totalRounds}`}</span></div>
            <span class="rb-next__sub">${isLast ? 'One last spin for every team.' : 'Every team spins again.'} <strong>${first?.name || ''}</strong> spins first.</span>
            ${isLast ? h`<hr class="tv-rule"><div class="rb-next__then"><span class="rb-next__then-label">Then</span>${ic('coins', { size: 36 })}<span class="rb-next__then-title">Final Chaos</span></div><span class="rb-next__sub">Wager your points on one last question.</span>` : ''}`}
      </div>
    </div>
    <section class="rb-table" aria-label="Standings after Round ${rb.round}">
      <div class="rb-table__head"><span>Standings</span>${hasMove ? h`<span class="rb-table__since">Since round ${rb.round - 1}</span>` : ''}</div>
      ${st.map((x) => {
        const tm = team(x.teamId);
        if (!tm) return '';
        return h`<div class="rb-row" data-key="${x.teamId}" style="${teamVar(tm)}">
          <span class="rb-rank rb-rank--${Math.min(x.rank, 4)}">${x.rank}</span>
          <div class="rb-row__team">${disc(tm, { size: 56 })}<span class="rb-row__name">${tm.name}</span>${x.rank === 1 && x.score > 0 ? ic('crown', { size: 30, label: 'Leader' }) : ''}</div>
          <div class="rb-bar"><div class="rb-bar__fill" style="--pct:${pct(Math.max(0.09, x.score / max) * 100)}"><span class="rb-bar__num">${formatPoints(x.score)}</span></div></div>
          ${hasMove ? move(x) : ''}
        </div>`;
      })}
    </section>
  </section>`;
  return view('round-break', html, { key: `round-break:${rb.round}`, strip: false, say: `End of round ${rb.round}. ${lead}` });
}

/* ---------- final chaos ---------- */
function finalCategory(f) {
  const seg = segOf(CATEGORY_SEGMENT[f.category] ?? 0);
  return h`<div class="fc-cat" style="${segVar(seg)}"><span class="fc-cat__icon">${ic(iconName(seg?.icon, 'sparkles'), { size: 68 })}</span><div class="fc-cat__text"><span class="fc-cat__label">Tonight’s final category</span><span class="fc-cat__name ${fit(f.categoryLabel, [12, 18])}">${f.categoryLabel}</span></div></div>`;
}
function scrFinalIntro(s) {
  const f = s.final;
  const wager = s.phase === 'finalWager';
  const locked = f.wagers.filter((w) => w.locked).length;
  const n = s.teams.length;
  const html = h`<section class="scr scr--final ${n > 6 ? 'is-many' : ''}">
    <div class="fc-eyebrow">${ic('sparkles', { size: 30 })}<span>The last question of the night</span>${ic('sparkles', { size: 30 })}</div>
    <h1 class="fc-title">FINAL CHAOS</h1>
    <div class="fc-row">${finalCategory(f)}${wager ? ring('fc', { unit: 'TO LOCK IN' }) : ''}</div>
    <div class="fc-explain">
      <p class="fc-explain__main">Wager any amount up to your score — <span class="ink-gold">or up to 300 if you’re behind</span>.</p>
      <p class="fc-explain__sub">${ic(wager ? 'smartphone' : 'hourglass', { size: 30 })}<span>${wager ? 'Lock it in from any teammate’s phone. Right answer wins it, wrong answer loses it.' : 'Talk it over with your team — wagers open in a moment.'}</span></p>
    </div>
    <section class="fc-status" aria-label="Wager status by team">
      <div class="fc-status__head">
        <div class="fc-status__count"><h2>${wager ? `${locked} of ${n} teams locked in` : 'Get ready to wager'}</h2>${wager ? h`<span class="fc-pips" aria-hidden="true">${f.wagers.map((w) => raw(`<i class="${w.locked ? 'is-on' : ''}"></i>`))}</span>` : ''}</div>
        <span class="fc-status__note">${ic('eye-off', { size: 30 })}Wagers stay secret until the reveal</span>
      </div>
      <ul class="fc-tiles" role="list">
        ${f.wagers.map((w) => {
          const tm = team(w.teamId);
          if (!tm) return '';
          const lead = leaders(s).has(tm.id);
          const extra = w.max > tm.score ? h`<span class="fc-tile__extra">can wager ${formatPoints(w.max)}</span>` : '';
          return h`<li class="fc-tile ${w.locked ? 'is-locked' : wager ? 'is-waiting' : ''}" data-key="${tm.id}" style="${teamVar(tm)}">
            ${disc(tm, { size: 64 })}
            <div class="fc-tile__text"><span class="fc-tile__name">${tm.name}</span><span class="fc-tile__score">${formatPoints(tm.score)} points${extra}${lead ? ic('crown', { size: 22, label: 'Leader' }) : ''}</span></div>
            ${w.locked ? h`<span class="fc-tile__tag">${ic('lock', { size: 22 })}LOCKED IN</span>` : wager ? h`<span class="fc-tile__wait">wagering<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>` : h`<span class="fc-tile__max">up to <b>${formatPoints(w.max)}</b></span>`}
          </li>`;
        })}
      </ul>
    </section>
  </section>`;
  return view(wager ? 'final-wager' : 'final-intro', html, { key: wager ? 'final-wager' : 'final-intro', strip: false, backdrop: raw('<div class="bd-final"></div>'), say: wager ? 'Final Chaos: lock in your wagers.' : `Final Chaos! Tonight's final category is ${f.categoryLabel}.` });
}
function scrFinalAnswer(s) {
  const f = s.final;
  const answered = f.submissions.filter((x) => x.answered).length;
  const n = s.teams.length;
  const html = h`<section class="scr scr--final scr--final-answer ${n > 6 ? 'is-many' : ''}">
    <h1 class="fc-title fc-title--sm">FINAL CHAOS</h1>
    <div class="fa-card">
      <div class="fa-card__main">
        <span class="fa-card__label">${ic('sparkles', { size: 26 })}Final Chaos · ${f.categoryLabel}</span>
        <h1 class="fa-card__q ${fit(f.question, [80, 130, 190])}">${f.question || ''}</h1>
        <p class="fa-card__sub">${ic('smartphone', { size: 30 })}<span>Type your answer on any phone on your team — <strong>the last answer counts</strong>.</span></p>
      </div>
      ${ring('fa', { unit: 'SECONDS LEFT' })}
    </div>
    <section class="fc-status" aria-label="Answer status by team">
      <div class="fc-status__head">
        <div class="fc-status__count"><h2>${answered} of ${n} teams answered</h2><span class="fc-pips" aria-hidden="true">${f.submissions.map((x) => raw(`<i class="${x.answered ? 'is-on' : ''}"></i>`))}</span></div>
        <span class="fc-status__note">${ic('eye-off', { size: 30 })}Answers and wagers stay secret until the reveal</span>
      </div>
      <ul class="fc-tiles" role="list">
        ${f.submissions.map((x) => {
          const tm = team(x.teamId);
          if (!tm) return '';
          return h`<li class="fc-tile ${x.answered ? 'is-locked' : 'is-waiting'}" data-key="${tm.id}" style="${teamVar(tm)}">
            ${disc(tm, { size: 64 })}
            <div class="fc-tile__text"><span class="fc-tile__name">${tm.name}</span><span class="fc-tile__score">${formatPoints(tm.score)} points</span></div>
            ${x.answered ? h`<span class="fc-tile__tag">${ic('check', { size: 22, stroke: 3 })}ANSWERED</span>` : h`<span class="fc-tile__wait">typing<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`}
          </li>`;
        })}
      </ul>
    </section>
  </section>`;
  return view('final-answer', html, { key: 'final-answer', strip: false, backdrop: raw('<div class="bd-final"></div>'), say: `Final question: ${f.question}` });
}
function scrFinalReveal(s) {
  const f = s.final;
  const revealed = new Map(f.revealed.map((r) => [r.teamId, r]));
  const order = f.revealOrder.length ? f.revealOrder : s.teams.map((t) => t.id);
  const n = order.length;
  const seg = segOf(CATEGORY_SEGMENT[f.category] ?? 0);
  const rows = order.map((id, i) => {
    const tm = team(id);
    if (!tm) return '';
    const r = revealed.get(id);
    const current = f.current === id && !f.done;
    if (!r) {
      return h`<li class="fr-row is-hidden" data-key="${id}" style="${teamVar(tm)}">
        <div class="fr-team"><span class="fr-num">${i + 1}</span>${disc(tm, { size: 50 })}<div class="fr-team__text fr-team__text--inline"><span class="fr-team__name">${tm.name}</span><span class="fr-team__sub">now ${formatPoints(tm.score)}${leaders(s).has(id) ? ic('crown', { size: 20, label: 'Leader' }) : ''}</span></div></div>
        <div class="fr-answer"><span class="fr-secret" role="img" aria-label="Answer hidden">?</span></div>
        <span class="fr-wager fr-q" aria-label="Wager hidden">?</span><span class="fr-result fr-q" aria-label="Result hidden">?</span><span class="fr-score fr-q" aria-label="New score hidden">?</span>
      </li>`;
    }
    const names = playersOf(id).map((p) => p.name);
    const judged = r.judged;
    return h`<li class="fr-row ${current ? 'is-current' : ''} ${judged ? (r.correct ? 'is-right' : 'is-wrong') : 'is-pending'}" data-key="${id}" style="${teamVar(tm)}" ${current ? raw('aria-current="true"') : ''}>
      ${current ? h`<span class="fr-row__tag">Revealing now</span>` : ''}
      <div class="fr-team"><span class="fr-num">${i + 1}</span>${disc(tm, { size: current ? 78 : 58 })}<div class="fr-team__text"><span class="fr-team__name ${fit(tm.name, [13])}">${tm.name}</span>${current && names.length ? h`<span class="fr-team__sub">${namesLine(names, 4)}</span>` : ''}</div></div>
      <div class="fr-answer"><span class="paper-note tilt-${i % 5} ${r.text ? '' : 'is-blank'}">${r.text || 'No answer'}</span></div>
      <span class="fr-wager">${formatPoints(r.wager)}</span>
      <div class="fr-result">${judged
        ? h`<span class="fr-mark ${r.correct ? 'is-yes' : 'is-no'}" role="img" aria-label="${r.correct ? 'Correct' : 'Not this time'}">${ic(r.correct ? 'check' : 'x', { size: 30, stroke: 2.8 })}</span><span class="fr-delta ${r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}">${r.delta ? formatDelta(r.delta) : '±0'}</span>`
        : h`<span class="fr-wait">${ic('hourglass', { size: 28 })}</span><span class="fr-wait__text">Host is<br>checking…</span>`}</div>
      <div class="fr-score"><span class="fr-score__n">${formatPoints(judged ? r.after : r.before)}</span><span class="fr-score__sub">${judged ? `from ${formatPoints(r.before)}` : `${formatPoints(r.wager)} riding on it`}</span></div>
    </li>`;
  });
  const shown = f.revealed.length;
  const html = h`<section class="scr scr--final-reveal ${n > 6 ? 'is-many' : ''}">
    <section class="fr-q-card">
      <span class="fr-q-card__icon" style="${segVar(seg)}">${ic(iconName(seg?.icon, 'sparkles'), { size: 56 })}</span>
      <div class="fr-q-card__text"><span class="fr-q-card__label">Final question · ${f.categoryLabel}</span><h1 class="fr-q-card__q ${fit(f.question, [90, 140])}">${f.question || ''}</h1></div>
      <div class="fr-q-card__side">${f.answer
        ? h`<span class="fr-q-card__side-label">The answer</span><span class="fr-q-card__answer">${f.answer}</span>`
        : h`<span class="fr-q-card__side-label">Revealing</span><span class="fr-q-card__n">${shown} of ${n}</span><span class="fr-q-card__side-sub">lowest score first</span>`}</div>
    </section>
    <div class="fr-cols" aria-hidden="true"><span class="fr-cols__team">Team</span><span class="fr-cols__answer">Their answer</span><span class="fr-cols__wager">Wager</span><span class="fr-cols__result">Result</span><span class="fr-cols__score">New score</span></div>
    <ol class="fr-rows" role="list" aria-label="Final answers, revealed from lowest score to highest">${rows}</ol>
  </section>`;
  const cur = f.revealed.find((r) => r.teamId === f.current);
  const say = cur ? `${team(cur.teamId)?.name} wagered ${cur.wager}. Their answer: ${cur.text || 'no answer'}.${cur.judged ? (cur.correct ? ' Correct!' : ' Not this time.') : ''}` : 'Final reveal.';
  return view('final-reveal', html, { key: 'final-reveal', strip: false, backdrop: raw('<div class="bd-final bd-final--low"></div>'), say });
}

/* ---------- podium ---------- */
function scrPodium(s) {
  const p = s.podium;
  const st = (p.standings || []).slice().sort((a, b) => a.place - b.place || b.score - a.score);
  const blocks = st.length >= 3 ? [st[1], st[0], st[2]] : st.length === 2 ? [st[1], st[0]] : st.slice(0, 1);
  const winners = st.filter((x) => x.place === 1).map((x) => team(x.teamId)?.name).filter(Boolean);
  const title = winners.length > 1 ? `${listJoin(winners, 'and')} share Christmas!` : `${winners[0] || ''} wins Christmas!`;
  const rest = st.slice(3);
  const AW = { fastestFinger: 'zap', starPerformer: 'drama' };
  const html = h`<section class="scr scr--podium">
    <span class="podium-eyebrow">Final results${s.final?.answer ? h` · the final answer was <strong>${s.final.answer}</strong>` : ''}</span>
    <h1 class="podium-title ${fit(title, [30, 44])}">${title}</h1>
    <div class="podium-stage podium-stage--n${blocks.length}">
      ${blocks.map((x) => {
        const tm = team(x.teamId);
        if (!tm) return '';
        const pl = Math.min(x.place, 3);
        return h`<div class="podium-col podium-col--${pl}" data-key="${x.teamId}" style="${teamVar(tm)}">
          ${x.place === 1 ? h`<span class="podium-col__crown">${ic('crown', { size: 72 })}</span>` : ''}
          ${disc(tm, { size: x.place === 1 ? 128 : 104, className: x.place === 1 ? 'disc--halo podium-col__disc' : 'podium-col__disc' })}
          <span class="podium-col__name">${tm.name}</span>
          <div class="podium-block"><span class="podium-block__place">${x.place}</span><span class="podium-block__score">${formatPoints(x.score)}</span></div>
        </div>`;
      })}
    </div>
    ${p.awards?.length || rest.length ? h`<div class="podium-foot">
      ${(p.awards || []).map((a) => h`<div class="award">${ic(AW[a.key] || 'award', { size: 40 })}<div class="award__text"><span class="award__title">${a.title}</span><span class="award__who">${a.name}${a.detail ? ` · ${a.detail}` : ''}</span></div></div>`)}
      ${rest.length ? h`<div class="podium-rest">${rest.map((x) => h`<span class="podium-rest__item"><span class="podium-rest__place">${x.place}</span>${team(x.teamId)?.name || ''}<strong>${formatPoints(x.score)}</strong></span>`)}</div>` : ''}
    </div>` : ''}
  </section>`;
  return view('podium', html, { key: 'podium', header: false, strip: false, backdrop: confettiMarkup(), say: `${title} Thanks for playing Christmas Chaos!` });
}

/* =========================================================================== screen router == */

function buildScreen(s) {
  const c = s.challenge;
  const t = activeTeam(s);
  const hold = ui.hold && performance.now() < ui.hold.until ? ui.hold : null;
  switch (s.phase) {
    case 'lobby':
      return scrLobby(s);
    case 'turnIntro':
      return t ? scrTurnIntro(s) : scrLobby(s);
    case 'spinning':
      return t ? scrSpinning(s) : scrLobby(s);
    case 'challenge':
    case 'turnResult': {
      if (!c || !t) return t ? scrTurnIntro(s) : scrLobby(s);
      if (hold?.kind === 'landed' && hold.id === c.id && c.type !== 'doubledown') return scrLanded(s, c);
      switch (c.type) {
        case 'trivia':
          if (c.stage === 'pickDifficulty') return scrDifficulty(s, c, false);
          if (c.stage === 'question') return hold?.kind === 'picked' && hold.id === c.id ? scrDifficulty(s, c, true) : scrQuestion(s, c);
          if (c.stage === 'steal') return scrSteal(s, c);
          return scrResult(s, c);
        case 'sounditout':
          if (c.stage === 'perform') return scrSound(s, c);
          if (c.stage === 'steal') return scrSteal(s, c);
          return scrResult(s, c);
        case 'dare':
          if (c.stage === 'perform') return scrDare(s, c);
          if (c.stage === 'vote') return scrDareVote(s, c);
          return scrDareResult(s, c);
        case 'showdown':
          if (c.stage === 'pickRival') return scrShowdownPick(s, c);
          if (c.stage === 'done' && !c.winnerSide) return scrSkipped(s, c);
          return scrShowdown(s, c);
        case 'rapidlist':
          return scrRapid(s, c);
        case 'hotseat':
          return scrHotSeat(s, c);
        case 'allplay':
          if (c.stage === 'done') return c.result?.kind === 'skipped' && !c.revealed ? scrSkipped(s, c) : scrAllPlayReveal(s, c);
          return scrAllPlay(s, c);
        case 'grinch':
          if (c.stage === 'pickTarget') return scrGrinchPick(s, c);
          return scrGrinchDone(s, c);
        case 'doubledown':
          return scrDoubleDown(s);
        default:
          return scrSkipped(s, c);
      }
    }
    case 'roundBreak':
      if (c && c.type === 'bonus') return c.stage === 'done' ? scrAllPlayReveal(s, c) : scrAllPlay(s, c);
      return s.roundBreak ? scrRoundBreak(s) : scrLobby(s);
    case 'finalIntro':
    case 'finalWager':
      return s.final ? scrFinalIntro(s) : scrLobby(s);
    case 'finalAnswer':
      return s.final ? scrFinalAnswer(s) : scrLobby(s);
    case 'finalReveal':
      return s.final ? scrFinalReveal(s) : scrLobby(s);
    case 'podium':
      return s.podium ? scrPodium(s) : scrLobby(s);
    default:
      return scrLobby(s);
  }
}

/* =========================================================================== header & strip = */

function headerHTML(s) {
  const final = ['finalIntro', 'finalWager', 'finalAnswer', 'finalReveal'].includes(s.phase);
  let center;
  if (final) {
    const step = s.phase === 'finalAnswer' ? 2 : s.phase === 'finalReveal' ? 3 : 1;
    const steps = ['Wager', 'Answer', 'Reveal'];
    center = h`<ol class="tv-steps" role="list" aria-label="Finale, step ${step} of 3: ${steps[step - 1].toLowerCase()}">${steps.map((label, i) => {
      const n = i + 1;
      const st = n < step ? 'is-done' : n === step ? 'is-current' : '';
      return h`${i ? raw('<li class="tv-steps__join" aria-hidden="true"></li>') : ''}<li class="tv-steps__step ${st}"><span class="tv-steps__n">${n < step ? ic('check', { size: 20, stroke: 3 }) : n}</span>${label.toUpperCase()}</li>`;
    })}</ol>`;
  } else {
    const done = s.phase === 'roundBreak';
    center = h`<span class="pill tv-round">ROUND ${s.round} OF ${s.totalRounds}</span>${turnDots(done ? s.turnsPerRound : s.turnIndex, s.turnsPerRound)}`;
  }
  return h`<div class="tv-brand">${ic('snowflake', { size: 40 })}<span>Christmas Chaos</span></div>
    <div class="tv-top__center">${center}</div>
    <div class="tv-join">${ic('wifi', { size: 28 })}<span>Join at <strong>${joinHost(s.joinUrl)}</strong></span></div>`;
}

function tileState(t, s, mode) {
  const c = s.challenge;
  if (mode === 'steal' && c?.buzz) {
    const b = c.buzz;
    if (b.winner?.teamId === t.id) return { cls: 'is-buzzed', tag: 'BUZZED FIRST', tagCls: 'tag--buzzed' };
    if (t.id === s.activeTeamId) return { cls: 'is-out', tag: 'ANSWERED', tagCls: 'tag--pine' };
    if ((b.lockedTeamIds || []).includes(t.id)) return { cls: 'is-out', tag: 'LOCKED OUT', tagCls: 'tag--pine' };
    if ((b.eligibleTeamIds || []).includes(t.id)) return { cls: 'is-steal', tag: 'CAN STEAL', tagCls: 'tag--ember' };
    return { cls: '' };
  }
  if (mode === 'rival' && c?.rival?.teamId === t.id) return { cls: 'is-rival', tag: 'RIVAL', tagCls: 'tag--rival', icon: 'swords' };
  if (t.id === s.activeTeamId) return { cls: 'is-active', tag: 'UP NOW', tagCls: '' };
  return { cls: '' };
}

function stripHTML(s, mode) {
  const lead = leaders(s);
  return h`<div class="score-strip tv-strip__row tv-strip__row--n${Math.min(s.teams.length, 8)}">${s.teams.map((t) => {
    const st = tileState(t, s, mode);
    return h`<div class="score-tile ${st.cls}" data-key="${t.id}" data-team="${t.id}" style="${teamVar(t)}">
      ${st.tag ? h`<span class="tag score-tile__tag ${st.tagCls}">${st.icon ? ic(st.icon, { size: 16, stroke: 2.6 }) : ''}${st.tag}</span>` : ''}
      ${t.multiplier > 1 ? h`<span class="score-tile__badge" role="img" aria-label="Points doubled this turn">×2</span>` : ''}
      ${disc(t, { size: 64, className: t.playerCount && !t.connectedCount ? 'is-offline' : '' })}
      <div class="score-tile__body"><span class="score-tile__name">${t.name}</span>
        <span class="score-tile__score"><span class="num" data-score="${t.id}" data-value="${t.score}" data-morph-skip>${formatPoints(t.score)}</span>${lead.has(t.id) ? ic('crown', { size: 30, stroke: 2.4, label: 'Leader' }) : ''}</span></div>
    </div>`;
  })}</div>`;
}

function updateScores() {
  for (const el of strip.querySelectorAll('[data-score]')) {
    const t = team(el.dataset.score);
    if (!t || ui.pendingFly.get(t.id)) continue;
    if (Number(el.dataset.value) !== t.score) {
      animateNumber(el, t.score, { duration: 900 });
      bump(el.closest('.score-tile'));
    }
  }
}
function bump(tile) {
  if (!tile) return;
  tile.classList.remove('is-bump');
  void tile.offsetWidth;
  tile.classList.add('is-bump');
  clearTimeout(tile._bumpT);
  tile._bumpT = setTimeout(() => tile.classList.remove('is-bump'), 1100);
}

/* =========================================================================== wheel ========== */

function ensureWheel(s) {
  if (wheel || !s.segments?.length) return;
  wheel = createWheel($('#wheel'), s.segments.map(fixSeg), { label: 'The prize wheel' });
  wheel.restOn(s.lastSegmentIndex ?? 0);
  ui.wheel = { mode: 'rest', index: s.lastSegmentIndex ?? 0 };
}

function applyWheel(v, s) {
  if (!wheel) return;
  const slot = stage.querySelector('[data-wheel-slot]');
  if (slot && wheelHost.parentElement !== slot) slot.appendChild(wheelHost);
  if (!slot && wheelHost.parentElement !== park) park.appendChild(wheelHost);
  const w = v.wheel;
  if (!w) return;
  if (w.mode === 'spin' && s.spin) {
    const key = `${s.spin.startedAt}:${s.spin.segmentIndex}`;
    if (ui.spinKey === key) return;
    ui.spinKey = key;
    ui.wheel = { mode: 'spin', index: s.spin.segmentIndex };
    wheel.idle(false);
    wheel.spinTo(s.spin.segmentIndex, s.spin.durationMs, {
      startedAt: s.spin.startedAt,
      clockOffset: client.clockOffset,
      onTick: () => play('tick'),
      onDone: (i) => {
        ui.wheel = { mode: 'hl', index: i };
      },
    });
    return;
  }
  if (w.mode === 'hl') {
    if (wheel.spinning) return; // let a spin in flight land on its own (it highlights the winner)
    if (ui.wheel.mode === 'hl' && ui.wheel.index === w.index) return;
    wheel.idle(false);
    wheel.restOn(w.index, { highlight: true });
    ui.wheel = { mode: 'hl', index: w.index };
    return;
  }
  if (w.mode === 'idle') {
    if (ui.wheel.mode === 'idle' && ui.wheel.index === w.index && !wheel.spinning) return;
    wheel.restOn(w.index ?? 0);
    wheel.idle(true);
    ui.wheel = { mode: 'idle', index: w.index };
    ui.spinKey = null;
  }
}

/* =========================================================================== render ========= */

function render() {
  if (!S) return;
  ensureWheel(S);
  const v = buildScreen(S);
  const fresh = v.key !== ui.screenKey;

  app.dataset.header = v.header ? 'on' : 'off';
  app.dataset.strip = v.strip ? 'on' : 'off';
  app.dataset.surface = v.surface;
  app.dataset.screen = v.name;
  if (!ui.started) startEl.classList.toggle('is-compact', S.phase !== 'lobby');
  document.body.dataset.screen = v.name;

  if (v.header) morph(top, headerHTML(S));
  morph(strip, stripHTML(S, v.stripMode));
  updateScores();

  if (fresh) {
    // Park the wheel first so replacing the stage never destroys it.
    if (wheelHost.parentElement !== park) park.appendChild(wheelHost);
    stage.innerHTML = String(v.html);
    backdrop.innerHTML = String(v.backdrop || '');
    stage.classList.remove('is-entering');
    void stage.offsetWidth;
    stage.classList.add('is-entering');
    ui.screenKey = v.key;
    ui.screenName = v.name;
    if (v.say) announce(v.say);
  } else {
    morph(stage, v.html);
  }
  applyWheel(v, S);
  tick();
}

function announce(text) {
  live.textContent = '';
  setTimeout(() => {
    live.textContent = text;
  }, 60);
}

/* =========================================================================== ticker ========= */

function fmtClock(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function tick() {
  if (!S) return;
  const n = now();
  const t = S.timer;
  for (const el of document.querySelectorAll('[data-ring]')) {
    const clock = el.dataset.clock === '1';
    const arc = el.querySelector('.timer-ring__arc');
    const num = el.querySelector('.timer-ring__num');
    const unitEl = el.querySelector('.timer-ring__unit');
    let frac = 0;
    let secs = 0;
    let unit = el.dataset.unit || '';
    let state = 'run';
    if (!t) {
      state = 'idle';
      unit = '';
    } else if (!t.started) {
      frac = 1;
      secs = Math.ceil(t.durationMs / 1000);
      state = 'ready';
      unit = 'READY';
    } else {
      const left = timerRemaining(t, n);
      frac = t.durationMs > 0 ? Math.min(1, left / t.durationMs) : 0;
      secs = Math.ceil(left / 1000);
      if (left <= 0) {
        state = 'over';
        unit = 'TIME’S UP';
      } else if (!t.running) {
        state = 'paused';
        unit = 'PAUSED';
      }
    }
    const text = state === 'idle' ? '–' : clock ? fmtClock(secs) : String(secs);
    if (num && num.textContent !== text) num.textContent = text;
    if (unitEl && unitEl.textContent !== unit) unitEl.textContent = unit;
    arc?.setAttribute('stroke-dashoffset', (339.3 * (1 - frac)).toFixed(1));
    el.classList.toggle('is-warn', state === 'run' && secs > 0 && secs <= 5);
    el.classList.toggle('is-paused', state === 'paused');
    el.classList.toggle('is-ready', state === 'ready');
    el.classList.toggle('is-over', state === 'over');
    el.setAttribute('aria-label', state === 'ready' ? `${secs} seconds, waiting to start` : `${secs} seconds left`);
  }
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const left = Number(el.dataset.countdown) - n;
    const text = left > 0 ? String(Math.ceil(left / 1000)) : 'GO!';
    if (el.textContent !== text) el.textContent = text;
  }

  // Last-five-second beeps (the final beep comes with the timerEnd fx).
  if (t && t.running && t.started) {
    const id = `${t.kind}:${t.endsAt}`;
    const secs = Math.ceil(timerRemaining(t, n) / 1000);
    if (secs >= 1 && secs <= 5 && (ui.beep.id !== id || ui.beep.sec !== secs)) {
      if (ui.beep.id === id || secs === 5) play('beep', false);
      ui.beep = { id, sec: secs };
    }
  }
  // Steal arming 3-2-1.
  const b = S.challenge?.buzz;
  if (b?.armingUntil && !b.open) {
    const secs = Math.ceil((b.armingUntil - n) / 1000);
    const id = String(b.armingUntil);
    if (secs >= 1 && secs <= 3 && (ui.armBeep.id !== id || ui.armBeep.sec !== secs)) {
      play('beep', false);
      ui.armBeep = { id, sec: secs };
    }
  }
  if (ui.hold && performance.now() >= ui.hold.until) {
    ui.hold = null;
    render();
  }
}
setInterval(tick, 100);

/* =========================================================================== points fly ===== */

function newAwards(prev, next) {
  const fresh = [];
  for (const a of next.lastAwards || []) {
    if (!ui.seenAwards.has(a.id)) {
      ui.seenAwards.add(a.id);
      if (prev) fresh.push(a);
    }
  }
  return fresh;
}

function launchFlights(list) {
  const visible = app.dataset.strip === 'on' && !reducedMotion();
  list.forEach((a, k) => {
    const tile = strip.querySelector(`[data-team="${CSS.escape(a.teamId)}"]`);
    if (!visible || !tile || !a.delta || Math.abs(a.delta) <= 50) {
      ui.pendingFly.delete(a.teamId);
      return;
    }
    const from = stage.querySelector('[data-fly-from]') || stage;
    const A = app.getBoundingClientRect();
    const F = from.getBoundingClientRect();
    const T = tile.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `tv-fly ${a.delta < 0 ? 'is-down' : ''}`;
    el.textContent = formatDelta(a.delta);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${formatDelta(a.delta)} points to ${team(a.teamId)?.name || ''}`);
    flyLayer.appendChild(el);
    const x0 = F.left - A.left + F.width * (from === stage ? 0.5 : 0.7);
    const y0 = F.top - A.top + F.height * (from === stage ? 0.45 : 0.62);
    const x1 = T.left - A.left + T.width * 0.62;
    const y1 = T.top - A.top + T.height * 0.5;
    el.style.left = `${x0}px`;
    el.style.top = `${y0}px`;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const anim = el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4) rotate(0deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.12) rotate(-7deg)', opacity: 1, offset: 0.18 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(-7deg)', opacity: 1, offset: 0.42 },
        { transform: `translate(calc(-50% + ${dx * 0.86}px), calc(-50% + ${dy * 0.86}px)) scale(0.55) rotate(-2deg)`, opacity: 1, offset: 0.9 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.42) rotate(0deg)`, opacity: 0 },
      ],
      { duration: 1500, delay: 450 + k * 220, easing: 'cubic-bezier(0.5, 0, 0.3, 1)', fill: 'both' }
    );
    anim.finished
      .catch(() => {})
      .then(() => {
        el.remove();
        const left = (ui.pendingFly.get(a.teamId) || 1) - 1;
        if (left <= 0) ui.pendingFly.delete(a.teamId);
        else ui.pendingFly.set(a.teamId, left);
        updateScores();
      });
  });
  updateScores();
}

/* =========================================================================== state ========== */

function onState(next) {
  const prev = S;
  const awards = newAwards(prev, next);
  // Hold the "it landed on…" moment, and the "Sam picked Medium" moment, for a beat.
  if (prev) {
    const c = next.challenge;
    const pc = prev.challenge;
    if (prev.phase === 'spinning' && (next.phase === 'challenge' || next.phase === 'turnResult') && c && c.type !== 'doubledown') {
      ui.hold = { kind: 'landed', id: c.id, until: performance.now() + 2800 };
    } else if (c && pc && c.id === pc.id && c.type === 'trivia' && pc.stage === 'pickDifficulty' && c.stage === 'question') {
      ui.hold = { kind: 'picked', id: c.id, until: performance.now() + 1700 };
    } else if (ui.hold && (!c || c.id !== ui.hold.id)) {
      ui.hold = null;
    }
    if (ui.hold?.kind === 'landed' && c && c.stage !== 'pickDifficulty' && c.stage !== 'perform' && c.stage !== 'pickRival' && c.stage !== 'pickTarget' && c.stage !== 'hotseat' && c.stage !== 'list' && c.stage !== 'answering' && c.stage !== 'done') ui.hold = null;
    stateSounds(prev, next);
  } else {
    for (const r of next.final?.revealed || []) if (r.judged) ui.judgedRows.add(r.teamId);
    ui.dareResultFor = next.challenge?.dareResult ? next.challenge.id : null;
  }
  S = next;
  // Teams whose points are about to fly: hold their counters until the badge lands.
  const flying = awards.filter((a) => a.delta);
  for (const a of flying) ui.pendingFly.set(a.teamId, (ui.pendingFly.get(a.teamId) || 0) + 1);
  render();
  if (flying.length) launchFlights(flying);
}

/** Sounds that come from state changes rather than fx (dare verdicts, final reveal judgements). */
function stateSounds(prev, next) {
  const c = next.challenge;
  if (c?.type === 'dare' && c.dareResult && ui.dareResultFor !== c.id) {
    ui.dareResultFor = c.id;
    const r = c.dareResult.result;
    if (r === 'nailed') {
      play('correct');
      play('applause', 2600);
    } else if (r === 'valiant') {
      play('correct');
      play('applause', 1400);
    } else play('wrong');
  }
  for (const r of next.final?.revealed || []) {
    if (r.judged && !ui.judgedRows.has(r.teamId)) {
      ui.judgedRows.add(r.teamId);
      play(r.correct ? 'correct' : 'wrong');
    }
  }
  if (c?.type === 'grinch' && c.gift && (!prev.challenge || prev.challenge.id !== c.id || !prev.challenge.gift)) {
    setTimeout(() => play('correct'), 2900);
  }
  if (next.phase === 'lobby' && prev.phase !== 'lobby') {
    ui.judgedRows.clear();
    ui.seenAwards.clear();
    for (const a of next.lastAwards || []) ui.seenAwards.add(a.id);
  }
}

/* =========================================================================== sound ========== */

function soundOn() {
  return ui.started && S?.settings?.sound !== false;
}
function play(name, ...args) {
  if (!soundOn()) return undefined;
  try {
    return sound.play(name, ...args);
  } catch (e) {
    console.warn('sound', name, e);
    return undefined;
  }
}

function onFx(type, p = {}) {
  switch (type) {
    case 'spinStart':
      play('whoosh', 500);
      break;
    case 'land':
      play(p.segmentType === 'doubledown' ? 'fanfare' : 'land');
      break;
    case 'buzz':
      play('buzz');
      break;
    case 'armed':
      play('beep', true);
      break;
    case 'correct':
      play('correct');
      if (S?.challenge?.type === 'showdown') play('applause', 2200);
      break;
    case 'wrong':
      play('wrong');
      break;
    case 'timerEnd':
      play('beep', true);
      break;
    case 'vote':
      if (p.opened) play('whoosh', 500);
      else if (p.closed) play('applause', 2400);
      else play('tick');
      break;
    case 'steal':
      play('whoosh', 700);
      setTimeout(() => play('land'), 350);
      break;
    case 'roundBreak':
      play('applause', 2400);
      break;
    case 'turn':
      play('whoosh', 450);
      break;
    case 'final':
      play('drumroll', 1400);
      setTimeout(() => play('fanfare'), 1500);
      break;
    case 'reveal':
      if (p.teamId) play('drumroll', 1500, { crash: false });
      else play('drumroll', 700);
      break;
    case 'podium':
      play('fanfare');
      setTimeout(() => play('applause', 4000), 1700);
      break;
    case 'calledUp':
      play('beep', false);
      break;
    case 'joined':
    case 'answered':
    case 'wagered':
      play('tick');
      break;
    case 'soundTest':
      play('fanfare');
      break;
    default:
      break;
  }
}

/* =========================================================================== start / mute === */

$('#startMark').innerHTML = String(ic('snowflake', { size: 64 }));
$('#startIcon').innerHTML = String(ic('play', { size: 30 }));
$('#bootMark').innerHTML = String(ic('snowflake', { size: 72 }));

async function startShow() {
  if (ui.started) return;
  ui.started = true;
  startEl.hidden = true;
  document.documentElement.classList.add('is-started');
  try {
    await sound.unlock();
  } catch {
    /* audio stays off */
  }
  enterFullscreen();
  syncMute();
  play('land');
}
$('#startBtn').addEventListener('click', startShow);
startEl.addEventListener('click', (e) => {
  if (e.target === startEl) startShow();
});
// Mid-game the prompt is a small pill; a click anywhere on the TV starts the show.
document.addEventListener('click', () => {
  if (!ui.started && startEl.classList.contains('is-compact')) startShow();
});
document.addEventListener('keydown', (e) => {
  if (!ui.started && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    startShow();
    return;
  }
  if (e.key === 'm' || e.key === 'M') sound.toggleMute();
  if (e.key === 'f' || e.key === 'F') enterFullscreen();
});

function syncMute() {
  const muted = sound.isMuted();
  muteBtn.innerHTML = String(ic(muted ? 'volume-x' : 'volume-2', { size: 26 }));
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.setAttribute('aria-label', muted ? 'Unmute the TV' : 'Mute the TV');
  muteBtn.title = muted ? 'Sound is off (M)' : 'Sound is on (M)';
  document.documentElement.classList.toggle('is-muted', muted);
}
muteBtn.addEventListener('click', () => {
  if (!ui.started) startShow();
  else sound.toggleMute();
});
sound.onChange(syncMute);
syncMute();

// Show the mute button (and the cursor) only while the mouse moves.
document.addEventListener('pointermove', () => {
  document.documentElement.classList.add('is-pointer');
  clearTimeout(ui.pointerTimer);
  ui.pointerTimer = setTimeout(() => document.documentElement.classList.remove('is-pointer'), 2500);
});

/* =========================================================================== go ============= */

client.onState(onState);
client.onFx(onFx);
window.__tv = { get state() { return S; }, get screen() { return ui.screenName; }, render };
