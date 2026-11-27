// Christmas Chaos — tv.js · the Big Screen ("North Pole Workshop", docs/design/NORTH-POLE.md + COMEDY.md).
//
// Renders every stage of the show from the server's publicView ALONE (a TV refreshed mid-anything shows the
// right screen; the wheel rests on lastSegmentIndex). `fx` events only trigger one-shot sounds and sight gags
// (fx.js), never state. The comedy layer: `state.quip` is shown as Santa's speech bubble at each moment, and
// `fx {type:'react', mood, key, teamId}` plays the matching gag + sound (both optional: the page works without).
//
// Rendering: each screen is built as escaped markup (h``) and patched into the DOM with a tiny morph, so pushes
// inside one screen (votes, ticks, answers arriving) update in place without replaying entrance animations, while
// a new screen gets fresh DOM. Timer ornaments, the steal countdown and score counters are driven by a ticker.
// Layout lives in tv.css on a 1920×1080 design grid (1rem = 16 design px; tokens.css scales the root).

import {
  connect, h, raw, ic, art, mascot, slotChip, slotArtId, turnDots, timerRing, present, stocking, bellMeter, santaList,
  formatPoints, formatDelta, possessive, ordinal, listJoin, plural, timerRemaining, reducedMotion, enterFullscreen,
  isPluralTeam, verb, isAre, subject, AWARD_CEREMONY,
  animateNumber,
} from '/assets/client.js';
import { createWheel } from '/assets/wheel.js';
import { garland, snowfall, snowbank, starfieldMarkup, garlandMarkup } from '/assets/sky.js';
import { safeColor, mascotFor } from '/assets/icons.js';
import * as sound from '/assets/sound.js';
import * as fx from '/assets/fx.js';

/* =========================================================================== setup ========== */

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const stage = $('#stage');
const top = $('#top');
const strip = $('#strip');
const stripTags = $('#stripTags');
const backdrop = $('#backdrop');
const flyLayer = $('#fly');
const live = $('#live');
const park = $('#park');
const wheelHost = $('#wheelHost');
const startEl = $('#start');
const muteBtn = $('#mute');

const client = connect('tv', { banner: 'Lost the workshop server — reconnecting' });
fx.setScale('root'); // gags keep their proportions at 720p, 1080p and 4K (the TV root font scales with the viewport)
const lights = garland($('#garland'), { size: 'tv' });
const snow = snowfall(app, { count: 46, avoid: ['[data-read]'], margin: 1 });
strip.insertAdjacentHTML('afterbegin', snowbank({ className: 'tv-strip__bank' }));

let S = null; // latest publicView
let wheel = null;
const ui = {
  started: false,
  live: false,         // true once the first state has been drawn (gags only play for live moments)
  screenKey: '',
  screenName: '',
  seenAwards: new Set(),
  pendingFly: new Map(),
  hold: null,          // { kind:'landed'|'picked', id, until }
  wheel: { mode: null, index: null },
  spinKey: null,
  beep: { id: '', sec: 0 },
  armBeep: { id: '', sec: 0 },
  judgedRows: new Set(),
  dareResultFor: null,
  pointerTimer: 0,
  gagAt: new Map(),    // gag name -> performance.now() (one gag per moment, even if fx + react both ask)
  lobby: { qid: null, t0: 0, idx: -1 },
  ceremony: null,      // { t0, n, step } podium awards ceremony
  snowTimer: 0,
};

/* =========================================================================== helpers ======== */

const LEVELS = [
  { id: 'easy', label: 'Easy', pts: 100, size: 'sm', color: '#1F7A4A', ribbon: '#EDB321' },
  { id: 'medium', label: 'Medium', pts: 200, size: 'md', color: '#2E6FD1', ribbon: '#FFFFFF' },
  { id: 'hard', label: 'Hard', pts: 300, size: 'lg', color: '#D42A2A', ribbon: '#EDB321' },
];
const CATEGORY_SEGMENT = { christmas: 0, popculture: 2, movies: 4 };

/** Rotating lobby lines (the server's lobbyIdle quip leads; these keep the gift tag fresh between joins). */
const LOBBY_LINES = [
  'Elves are still finding their phones. Santa is tapping his boot.',
  'Pick a team name you can shout with confidence.',
  'Phones out, snacks down. Okay, the snacks can stay.',
  'The wheel has been polished. The reindeer are stretching.',
  'Somebody show Grandma the square code. Yes, that square.',
  'Teams of any size. Egos of any size.',
];
/** Round-break roast for the leader and pep talk for last place (shown on their rows). */
const ROASTS = ['Don’t get comfy up there', 'Santa is watching that lead', 'Nice lead. Shame if someone stole it', 'Top of the list. For now', 'Leading and slightly smug'];
const PEPTALKS = ['Comeback season starts now', 'Every Grinch had a turnaround', 'Plenty of sleigh ride left', 'Underdogs make the best movies', 'Still time for a Christmas miracle'];

const cx = (...parts) => parts.filter(Boolean).join(' ');
const colorOf = (c, fb = '#C9D8EA') => safeColor(c, fb);
const now = () => client.serverNow();
const joinHost = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const pick = (list, seed) => list[Math.abs(Math.trunc(seed || 0)) % list.length];

/** Relative luminance of #RRGGBB (0..1), or null. */
function lum(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** Text colour on a team / slot fill: the mascot table's ink when it is that mascot's colour, else by luminance. */
function inkOn(color, mascotId) {
  const m = mascotId ? mascotFor(mascotId) : null;
  if (m && String(m.color).toLowerCase() === String(color).toLowerCase()) return m.ink;
  const L = lum(color);
  return L != null && L > 0.3 ? '#1C2333' : '#FFFFFF';
}
const teamVar = (t) => {
  const c = colorOf(t?.color, mascotFor(t?.mascot).color);
  return `--team:${c};--team-ink:${inkOn(c, t?.mascot)}`;
};
const segVar = (seg) => {
  const c = seg?.pattern === 'candy' ? '#D42A2A' : colorOf(seg?.color, '#2E6FD1');
  return `--slot:${c};--slot-ink:${seg?.pattern === 'candy' ? '#FFFFFF' : colorOf(seg?.ink, '#FFFFFF')}`;
};
/** 3D art (always eager: the TV must never wait for lazy images). */
const img = (id, size, cls = '', alt = '') => art(id, { size, eager: true, className: cls, alt });
/** A team's 3D mascot (decorative: the name is always printed beside it). */
const mas = (t, size, cls = '') => mascot(t || {}, { size, alt: '', className: cls });

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
  return s.segments?.[i] || null;
}
function multiplier(s = S) {
  return activeTeam(s)?.multiplier || 1;
}
function leaders(s = S) {
  const best = Math.max(0, ...s.teams.map((t) => t.score));
  return new Set(best > 0 ? s.teams.filter((t) => t.score === best).map((t) => t.id) : []);
}
/** 'fit-1'..'fit-n' by text length, so long copy steps down a size instead of overflowing. */
function fit(text, steps) {
  const n = String(text ?? '').length;
  for (let i = 0; i < steps.length; i++) if (n <= steps[i]) return `fit-${i + 1}`;
  return `fit-${steps.length + 1}`;
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
  if (s.round >= s.totalRounds) return { label: 'Final Chaos', art: 'sparkles' };
  return { label: 'Hot cocoa break', art: 'cocoa' };
}
function timerKey(t) {
  return t ? `${t.kind}:${t.durationMs}:${t.started ? 1 : 0}` : 'none';
}
/** Deterministic 0..99 from a number (the tease and the Santa peek must not flicker between renders). */
function hash100(n) {
  return ((Math.trunc(Number(n) || 0) * 2654435761) >>> 0) % 100;
}
const isQuote = (q) => /[“"][^”"]{6,}[”"]?/.test(String(q || ''));

/* =========================================================================== morph ========== */
// Patch `el` to match `markup`. Same-shaped nodes are updated in place (attributes + text); anything marked
// data-morph-skip (the wheel slot, timer ornaments, score counters, the steal countdown) is left alone.

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

/** Ornament timer (client.js timerRing) inside a keyed shell; the ticker keeps it live. */
function ring(size, { unit = 'seconds', tone = 'candy', cls = '' } = {}) {
  const t = S?.timer;
  return h`<div class="ring-host ${cls}" data-ring data-unit="${unit}" data-key="ring:${timerKey(t)}" data-morph-skip>${timerRing(t, now(), { size, unit, tone })}</div>`;
}

/** The quip to show on this screen (land.* lines only on the landing moment). */
function quipFor(s, screen) {
  const q = s?.quip;
  if (!q || !q.text) return null;
  if (/^land\./.test(q.key || '') && !['landed', 'double-down', 'grinch-pick'].includes(screen)) return null;
  if (q.key === 'lobbyIdle' && screen !== 'lobby') return null;
  return q;
}
/**
 * Santa's speech bubble with the current quip (COMEDY.md §2). Always renders a stable keyed slot, so a quip
 * appearing / changing / clearing never disturbs its siblings. brief = fades out after a few seconds (screens
 * where people are reading a question).
 */
function quipBox(s, screen, { brief = false, cls = '', tail = 'left' } = {}) {
  const q = quipFor(s, screen);
  const tm = q?.teamId ? team(q.teamId) : null;
  return h`<div class="quip-slot ${cls}" data-key="quip-slot">${q
    ? h`<div class="quip quip--${q.tone || 'cheer'} quip--tail-${tail} ${brief ? 'is-brief' : ''} ${tm ? 'is-team' : ''}" data-key="q:${q.id || q.text}" role="status" style="${tm ? teamVar(tm) : ''}" ${tm ? raw(`data-tm="${tm.id}"`) : ''}>
        <span class="quip__who">${tm ? mas(tm, 80, 'quip__mascot') : img('santa', 80, 'quip__santa')}</span>
        <p class="quip__text ${fit(q.text, [48, 80])}"><span class="quip__mark" aria-hidden="true">“</span>${q.text}</p>
      </div>`
    : ''}</div>`;
}

function categoryChip(c, size = 'lg') {
  const seg = segOf(c.segmentIndex) || segOf(CATEGORY_SEGMENT[c.category] ?? 0);
  return slotChip(seg, { size, text: c.categoryLabel || seg?.label || '' });
}
function levelChip(c) {
  const lvl = LEVELS.find((l) => l.id === c.difficulty);
  return lvl ? h`<span class="chip chip--level">${lvl.label}</span>` : '';
}
function pointsChip(n, mult = 1, suffix = 'points') {
  return h`<span class="chip chip--points">${formatPoints(n)} ${suffix}${mult > 1 ? h`<span class="x2">×${mult}</span>` : ''}</span>`;
}
function filmCue(c) {
  if (!c.movie) return '';
  const title = c.movieYear && !String(c.movie).includes(String(c.movieYear)) ? `${c.movie} (${c.movieYear})` : c.movie;
  return h`<div class="film-cue">${img('film', 34)}<span>${title}</span></div>`;
}
function upNextPill(s) {
  const n = nextUp(s);
  return h`<div class="upnext"><span class="upnext__label">Up next</span>${n.team ? h`${mas(n.team, 44)}<span class="upnext__name">${n.team.name}</span>` : h`${img(n.art, 44)}<span class="upnext__name">${n.label}</span>`}</div>`;
}
function teamBadge(t, size = 56) {
  return h`<span class="team-badge" style="${teamVar(t)}">${mas(t, size)}<span class="team-badge__name">${t?.name ?? ''}</span></span>`;
}

/* =========================================================================== screens ======== */
// Each returns { name, key, html, header, strip, surface, backdrop, wheel, say, enter }.

function view(name, html, o = {}) {
  return {
    name, key: o.key ?? name, html, header: o.header ?? true, strip: o.strip ?? true, stripMode: o.stripMode ?? 'normal',
    surface: o.surface ?? 'snow', backdrop: o.backdrop ?? '', wheel: o.wheel ?? null, say: o.say ?? '', enter: o.enter ?? null,
    lights: o.lights ?? 'twinkle',
  };
}

/* ---------- lobby ---------- */
function lobbyLine(s) {
  const q = s.quip && s.quip.key === 'lobbyIdle' ? s.quip : null;
  const lines = q ? [q.text, ...LOBBY_LINES] : LOBBY_LINES;
  const idx = Math.max(0, ui.lobby.idx) % lines.length;
  return { text: lines[idx], key: `${q?.id || 'l'}:${idx}` };
}
function scrLobby(s) {
  const url = joinHost(s.joinUrl);
  const teams = s.teams;
  const total = s.players.length;
  const loose = s.players.filter((p) => !p.teamId || !team(p.teamId));
  const rows = teams.length > 4 ? [teams.slice(0, Math.ceil(teams.length / 2)), teams.slice(Math.ceil(teams.length / 2))] : [teams];
  const line = lobbyLine(s);
  const html = h`<section class="scr scr--lobby ${rows.length > 1 ? 'is-two' : ''}">
    <div class="lobby-left">
      <h1 class="lobby-title" data-read><span class="lobby-title__small">Welcome to the</span>North Pole Workshop!</h1>
      <section class="gift-tag gift-tag--twine lobby-tag" data-read aria-label="How to join">
        <div class="lobby-tag__body">
          <div class="lobby-qr"><img src="/api/qr.svg?v=${encodeURIComponent(s.joinUrl || '')}" alt="QR code that opens the join page" width="300" height="300"></div>
          <div class="lobby-tag__text">
            <span class="lobby-tag__head">Grab your phone and join a team</span>
            <ol class="lobby-steps" role="list">
              <li><span class="lobby-steps__n">1</span>Join the same Wi-Fi as this TV</li>
              <li><span class="lobby-steps__n">2</span>Scan the code with your camera</li>
              <li><span class="lobby-steps__n">3</span>Type your name, tap your team</li>
            </ol>
          </div>
        </div>
        <div class="lobby-url"><span class="lobby-url__label">No camera? Type</span><span class="lobby-url__value">${url}</span></div>
        <div class="holly-ribbon lobby-quip"><span class="lobby-quip__text" data-key="ll:${line.key}">${line.text}</span></div>
      </section>
      ${loose.length ? h`<p class="lobby-loose">${img('snowflake', 36)}<span>Still choosing a team: <strong>${listJoin(loose.map((p) => p.name), 'and')}</strong></span></p>` : ''}
    </div>
    <div class="lobby-right">
      <div class="lobby-right__head" data-read>
        <h2 class="lobby-right__title">The teams</h2>
        <span class="lobby-count">${total ? h`<strong>${plural(total, 'elf', 'elves')}</strong> in the workshop` : 'Be the first elf in!'}</span>
      </div>
      ${teams.length
        ? h`<div class="mantels">${rows.map((row, r) => h`<div class="mantel mantel--n${row.length}" data-key="row${r}">
            <div class="mantel__shelf" aria-hidden="true"><span class="mantel__garland">${raw(garlandMarkup({ width: 1060, size: 0.5, swags: 4, bulbs: 18, seed: 77 + r }))}</span></div>
            <ul class="stockings" role="list">${row.map((t) => lobbyStocking(t, rows.length > 1))}</ul>
          </div>`)}</div>`
        : h`<div class="lobby-empty">${stocking({ color: '#C9D8EA', state: 'empty', size: 150 })}<span class="lobby-empty__title">The host is hanging the stockings…</span><span class="lobby-empty__text">Join now. You can pick your team as soon as they appear.</span></div>`}
    </div>
  </section>`;
  return view('lobby', html, { header: false, strip: false, say: `Welcome to the North Pole Workshop. Scan the code or type ${url} to join a team.` });
}
function lobbyStocking(t, two = false) {
  const ps = playersOf(t.id);
  const cap = two ? 2 : 5;
  const shown = ps.slice(0, ps.length > cap ? cap - 1 : cap); // the last slot becomes "+N more"
  const size = two ? 92 : 132;
  return h`<li class="lobby-stocking ${ps.length ? '' : 'is-empty'}" data-key="${t.id}" style="${teamVar(t)}">
    <div class="lobby-stocking__hang">${ps.length ? stocking({ team: t, size, hung: true }) : stocking({ color: '#C9D8EA', state: 'empty', size })}</div>
    <span class="lobby-stocking__name">${t.name}</span>
    <ul class="name-tags" role="list" aria-label="${t.name} players">
      ${shown.length
        ? shown.map((p) => h`<li class="name-tag ${p.connected ? '' : 'is-offline'}" data-key="${p.id}">${p.name}</li>`)
        : h`<li class="name-tag name-tag--empty" data-key="empty">Needs elves</li>`}
      ${ps.length > shown.length ? h`<li class="name-tag name-tag--more" data-key="more">+${ps.length - shown.length} more</li>` : ''}
    </ul>
  </li>`;
}

/* ---------- turn intro ---------- */
function scrTurnIntro(s) {
  const t = activeTeam(s);
  const online = playersOf(t.id).filter((p) => p.connected).map((p) => p.name);
  const who = online.length ? `${namesLine(online)}: the first tap spins the wheel` : `Nobody from ${t.name} is online. The host can spin for you.`;
  const html = h`<section class="scr scr--intro" style="${teamVar(t)}">
    <div class="intro-hero" data-tm="${t.id}"><span class="intro-hero__snow" aria-hidden="true"></span>${mas(t, 300, 'intro-hero__mascot')}</div>
    <div class="intro-main">
      <h1 class="intro-title ${fit(t.name, [12, 18, 26])}" data-read><span class="intro-title__team">${t.name},</span> you’re up!</h1>
      ${quipBox(s, 'turn-intro', { cls: 'quip-slot--intro' })}
      <div class="gift-tag gift-tag--md gift-tag--twine intro-call" data-read>
        <span class="intro-call__phone" aria-hidden="true"><span class="intro-call__mint"></span></span>
        <div class="intro-call__text"><span class="intro-call__title">${t.name.length > 18 ? 'Spin from any of your phones' : `Spin from ${anyPhone(t)}`}</span><span class="intro-call__sub">${who}</span></div>
      </div>
    </div>
    ${wheelSlot('intro')}
  </section>`;
  const peek = hash100(s.turnId) < 34;
  return view('turn-intro', html, {
    key: `turn-intro:${s.turnId}`, wheel: { mode: 'idle', index: s.lastSegmentIndex }, lights: null,
    say: `${t.name}, you’re up! Spin from ${anyPhone(t)}.`,
    enter: () => {
      later(650, () => { bounceEl(stage.querySelector('.intro-hero__mascot')); play('boing'); });
      if (peek) later(1500, () => { gagOnce('peek', () => { play('hoHoHo'); fx.peek('santa', 'bottom-left', { say: 'Ho ho ho!' }); }); });
    },
  });
}

/* ---------- spinning ---------- */
function scrSpinning(s) {
  const t = activeTeam(s);
  const by = s.spin?.by;
  const dd = multiplier(s) > 1;
  const html = h`<section class="scr scr--spin" style="${teamVar(t)}">
    <div class="spin-side spin-side--left" data-read data-tm="${t.id}">
      ${mas(t, 190, 'spin-mascot')}
      <h1 class="spin-title ${fit(by?.name || t.name, [9, 14])}">${by ? by.name : t.name}<br>${by ? 'is' : isAre(t.name)} spinning…</h1>
      <span class="spin-for">${by ? h`for <strong>${t.name}</strong>` : 'The host spun for them'}</span>
    </div>
    ${wheelSlot('spin')}
    <div class="spin-side spin-side--right">
      ${quipBox(s, 'spinning', { cls: 'quip-slot--spin', tail: 'left' })}
      <div class="spin-note" data-read>${dd
        ? h`${img('sparkles', 56)}<span><strong>Double Down is on.</strong> Everything ${t.name} ${verb(t.name, 'wins', 'win')} this turn is doubled.</span>`
        : h`${img('bell', 56)}<span>${subject(t.name, 'plays')} whatever it lands on. A miss opens a <strong>steal</strong>.</span>`}</div>
    </div>
  </section>`;
  return view('spinning', html, { key: `spinning:${s.spin?.startedAt}`, wheel: { mode: 'spin' }, lights: null, say: `${by ? `${by.name} is` : subject(t.name, 'is')} spinning the wheel.` });
}

/* ---------- the wheel landed (client-side moment between spin and the mini-game) ---------- */
const NEXT_STEP = {
  trivia: (t) => `${subject(t.name, 'picks')} a present: Easy, Medium or Hard`,
  dare: (t) => `Picking a performer from ${t.name}…`,
  hotseat: (t) => `Picking someone from ${t.name} for the Hot Seat…`,
  sounditout: (t) => `Picking a secret hummer from ${t.name}…`,
  showdown: (t) => `${subject(t.name, 'picks')} a rival team…`,
  rapidlist: (t) => `${t.name}, warm up those voices!`,
  allplay: () => 'Every team, grab a phone!',
  grinch: (t, c) => (c && c.gift ? `${subject(t.name, 'is')} in the lead: nobody to rob!` : `Who will ${t.name} rob?`),
  doubledown: (t) => `${subject(t.name, 'spins')} again!`,
};
function scrLanded(s, c) {
  const t = activeTeam(s);
  const seg = segOf(c.segmentIndex);
  const pts = String(seg.points || '');
  const ptsText = pts.startsWith('×') ? `Points ${pts}` : `${pts} points`;
  const line = (NEXT_STEP[c.type] || (() => 'Get ready…'))(t, c);
  // the leader's Grinch Steal turns into a gift right away: say so, not "steal from a team ahead"
  const rule = c.type === 'grinch' && c.gift ? `Nobody is ahead of the leader, so the Grinch’s heart grows: they gift ${formatPoints(c.gift.amount)} points to the last-place team.` : seg.rule || c.rule;
  const html = h`<section class="scr scr--landed" style="${segVar(seg)}">
    ${wheelSlot('left')}
    <div class="landed-main">
      <div class="landed-gift">${present({ size: 'lg', color: seg.pattern === 'candy' ? '#FFFFFF' : colorOf(seg.color), ribbon: seg.pattern === 'candy' ? '#D42A2A' : '#EDB321', inside: slotArtId(seg) || 'sparkles', state: 'unwrapping', className: 'landed-present' })}</div>
      <div class="landed-text" data-read>
        <span class="landed-eyebrow">The wheel landed on</span>
        <h1 class="landed-word ${fit(seg.label, [10, 14])}">${seg.label}!</h1>
        <div class="landed-chips">${pts.startsWith('×') || !Number(pts) ? h`<span class="chip chip--points">${ptsText}</span>` : pointsChip(Number(pts), multiplier(s))}<span class="landed-next">${line}</span></div>
      </div>
      ${quipBox(s, 'landed', { cls: 'quip-slot--landed', tail: 'top' })}
      ${c.firstTime && rule ? h`<div class="holly-ribbon holly-ribbon--plain landed-rule" data-read><strong>How it works:</strong> ${rule}</div>` : ''}
    </div>
  </section>`;
  return view('landed', html, {
    key: `landed:${c.id}`, wheel: { mode: 'hl', index: c.segmentIndex }, lights: null, say: `The wheel landed on ${seg.label}.`,
    enter: () => later(350, () => fx.confetti({ count: 46, snow: 0.85, duration: 2000 })),
  });
}

/* ---------- trivia: pick difficulty ---------- */
function scrDifficulty(s, c, pickedHold) {
  const t = activeTeam(s);
  const picked = pickedHold ? c.difficulty : null;
  const who = c.pickedBy?.name || null;
  const lvl = LEVELS.find((l) => l.id === picked);
  const seg = segOf(c.segmentIndex);
  const html = h`<section class="scr scr--difficulty ${picked ? 'is-picked' : ''}">
    <div class="diff-head" data-read>
      ${categoryChip(c)}
      <h1 class="diff-title">${picked ? h`${who || t.name} picked <span class="diff-title__lvl diff-title__lvl--${picked}">${lvl?.label}</span>!` : h`${t.name}, pick a present!`}</h1>
      <p class="diff-sub">${multiplier(s) > 1 ? h`<strong>Double Down is on:</strong> every point counts twice.` : 'Bigger present, bigger points. Miss it and the other teams can steal half.'}</p>
    </div>
    <div class="diff-gifts">
      ${LEVELS.map((l) => h`<div class="diff-gift diff-gift--${l.id} ${picked === l.id ? 'is-chosen' : picked ? 'is-dim' : ''}" data-key="${l.id}">
        ${present({ size: l.size, color: l.color, ribbon: l.ribbon, label: l.label, points: formatPoints(l.pts * multiplier(s)), inside: picked === l.id ? slotArtId(seg) || 'tree' : '', state: picked === l.id ? 'unwrapping' : 'closed', ariaLabel: `${l.label}, ${l.pts * multiplier(s)} points`, className: `diff-present diff-present--${l.id}` })}
      </div>`)}
    </div>
    ${quipBox(s, 'difficulty', { cls: 'quip-slot--diff', tail: 'left' })}
    ${picked ? '' : h`<p class="diff-wait" data-read>${mas(t, 52)}<span>Choosing on their phones<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span></p>`}
  </section>`;
  return view(picked ? 'difficulty-picked' : 'difficulty', html, {
    key: `difficulty:${c.id}:${picked ? 1 : 0}`,
    say: picked ? `${who || t.name} picked ${lvl?.label}.` : `${subject(t.name, 'is')} picking a difficulty.`,
  });
}

/* ---------- trivia: question in play ---------- */
function qClass(c) {
  const n = String(c.question || '').length + (c.movie ? 18 : 0);
  return n <= 84 ? 'q-s' : n <= 122 ? 'q-m' : 'q-l';
}
function questionText(c, cls = 'question') {
  const quote = c.category === 'movies' && isQuote(c.question);
  return h`<h2 class="${cls} ${quote ? 'is-quote' : ''}">${quote ? h`<span class="quote-marks" aria-hidden="true">“</span>` : ''}${c.question}</h2>`;
}
function scrQuestion(s, c) {
  const t = activeTeam(s);
  const mult = multiplier(s);
  const size = qClass(c);
  const html = h`<section class="scr scr--question ${size}">
    ${wheelSlot(size === 'q-l' ? 'qsmall' : 'question')}
    <section class="gift-tag gift-tag--twine qcard ${size}" data-read aria-label="The question">
      <div class="qcard__chips">${categoryChip(c)}${levelChip(c)}${pointsChip(c.points, mult)}</div>
      ${ring(size === 'q-l' ? 128 : 150, { cls: 'qcard__ring' })}
      <div class="qcard__who" style="${teamVar(t)}">${mas(t, 58)}<span><b>${t.name}</b>, answer out loud</span></div>
      ${c.movie ? h`<div class="qcard__film">${filmCue(c)}</div>` : ''}
      ${questionText(c, 'question qcard__q')}
      ${c.hint
        ? h`<div class="holly-ribbon qcard__rib"><strong>Hint:</strong> ${c.hint}</div>`
        : h`<div class="holly-ribbon qcard__rib">Miss it? The other teams can buzz in and <strong>steal it for ${formatPoints(c.stealPoints)}</strong>.</div>`}
    </section>
    ${quipBox(s, 'question', { brief: true, cls: 'quip-slot--overwheel', tail: 'top' })}
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
  const left = (b.eligibleTeamIds || []).filter((id) => !(b.lockedTeamIds || []).includes(id)).map(team).filter(Boolean);
  const locked = (b.lockedTeamIds || []).map(team).filter(Boolean);
  const isSong = c.type === 'sounditout';
  const qText = isSong ? `${c.performer?.name || t.name} hummed it for ${t.name}. Name that tune!` : c.question;
  let head;
  if (phase === 'buzzed' && winner) {
    head = h`<div class="steal-buzzed" style="${teamVar(winner)}" data-tm="${winner.id}">
      ${mas(winner, 200, 'steal-buzzed__mascot')}
      <div class="steal-buzzed__text"><span class="steal-buzzed__name ${fit(b.winner.name, [8, 13])}">${b.winner.name}</span><span class="steal-buzzed__mid">buzzed first for ${winner.name}!</span><span class="steal-buzzed__cue">${ic('mic', { size: 34 })}Answer out loud!</span></div>
    </div>`;
  } else if (phase === 'arming') {
    head = h`<div class="steal-head">
      <h1 class="steal-word">Steal!</h1>
      <div class="steal-head__text"><span class="steal-head__big">Get ready to buzz for ${formatPoints(c.stealPoints)}</span><span class="steal-head__sub">Not this time, ${t.name}. Fingers on the ornaments…</span></div>
      <div class="arm-orns" data-arm="${b.armingUntil}" data-key="arm:${b.armingUntil}" data-morph-skip aria-hidden="true">${[3, 2, 1].map((n) => raw(`<span class="arm-orn" data-n="${n}"><i class="arm-orn__loop"></i><i class="arm-orn__cap"></i><b>${n}</b></span>`))}</div>
    </div>`;
  } else if (phase === 'open') {
    head = h`<div class="steal-head">
      <h1 class="steal-word">Steal!</h1>
      <div class="steal-head__text"><span class="steal-head__big">Buzz in for ${formatPoints(c.stealPoints)}</span><span class="steal-head__sub">${plural(left.length, 'team')} can steal. First buzz answers.</span></div>
      ${img('bell', 120, 'steal-bell')}
      ${ring(140, { cls: 'steal-ring' })}
    </div>`;
  } else {
    head = h`<div class="steal-head">
      <h1 class="steal-word steal-word--quiet">Steal?</h1>
      <div class="steal-head__text"><span class="steal-head__big">${locked.length ? `Not this time, ${listJoin(locked.map((x) => x.name), 'and')}` : 'Buzzers closed'}</span><span class="steal-head__sub">${left.length ? `${plural(left.length, 'team')} still in it. The host can reopen the buzzers.` : 'No teams left to steal.'}</span></div>
    </div>`;
  }
  const html = h`<section class="scr scr--steal is-${phase}">
    ${wheelSlot('question')}
    <section class="gift-tag gift-tag--twine steal-card is-${phase}" data-read aria-label="Steal" style="${winner ? teamVar(winner) : ''}">
      <div class="steal-card__chips">${isSong ? slotChip(segOf(c.segmentIndex)) : categoryChip(c)}${isSong ? '' : levelChip(c)}<span class="chip chip--steal">${ic('bell', { size: 24 })}Steal ${formatPoints(c.stealPoints)}</span></div>
      ${head}
      <div class="steal-card__q"><span class="steal-card__label">${isSong ? 'The song' : 'The question'}</span><p class="steal-card__text ${fit(qText, [80, 130])}">${qText}${isSong && c.hint ? h` <span class="steal-card__hint">Hint: ${c.hint}</span>` : ''}</p></div>
    </section>
    <div class="melt-slot" data-key="melt:${c.id}" data-morph-skip></div>
    ${quipBox(s, 'steal', { brief: true, cls: 'quip-slot--overwheel', tail: 'top' })}
  </section>`;
  const say = phase === 'buzzed' && winner ? `${b.winner.name} buzzed first for ${winner.name}!` : phase === 'open' ? `Steal! Buzzers are open for ${c.stealPoints} points.` : phase === 'arming' ? 'Steal! Get ready to buzz.' : 'Waiting for the host.';
  return view(`steal-${phase}`, html, { key: `steal:${c.id}:${b.winner?.playerId || ''}`, stripMode: 'steal', wheel: { mode: 'hl', index: c.segmentIndex }, say });
}

/* ---------- trivia + sound it out: result ---------- */
function scrResult(s, c) {
  const t = activeTeam(s);
  const kind = c.result?.kind || 'missed';
  const win = kind === 'correct' || kind === 'stolen';
  const winnerTeam = kind === 'stolen' ? team(c.buzz?.winner?.teamId) || team(c.result?.awards?.[0]?.teamId) : t;
  const hero = win ? winnerTeam || t : t;
  const isSong = c.type === 'sounditout';
  const answer = c.answer || '—';
  const gain = (c.result?.awards || []).filter((a) => a.teamId === hero?.id).reduce((x, y) => x + y.delta, 0);
  const label = kind === 'correct' ? 'Correct!' : kind === 'stolen' ? 'Stolen!' : kind === 'skipped' ? 'Skipped' : 'Not this time';
  const sub = kind === 'correct' ? `${winnerTeam?.name || ''} got it` : kind === 'stolen' ? `${winnerTeam?.name || ''} swiped it` : 'The answer was';
  const html = h`<section class="scr scr--result ${win ? 'is-win' : 'is-miss'} ${c.funFact ? '' : 'no-fact'}">
    <div class="result-chips">${isSong ? slotChip(segOf(c.segmentIndex)) : categoryChip(c)}${levelChip(c)}${filmCue(c)}<span class="result-chips__gap"></span>${upNextPill(s)}</div>
    <section class="gift-tag result-card ${win ? 'is-win' : 'is-miss'}" data-read data-fly-from aria-label="${label} The answer: ${answer}">
      ${win
        ? h`<div class="result-ribbon">${img('sparkles', 56)}<span class="result-ribbon__word">${label}</span><span class="result-ribbon__sub">${sub}</span>${gain > 0 ? h`<span class="result-ribbon__pts">${formatDelta(gain)}</span>` : ''}</div>`
        : h`<div class="result-miss"><span class="coal-stamp is-in">${label}</span><span class="result-miss__sub">${sub}</span></div>`}
      <p class="result-q">${isSong ? `${c.performer?.name || t.name} hummed it for ${t.name}` : c.question}</p>
      <div class="result-answer ${fit(answer, [18, 30, 46])}">${answer}${isSong && c.artist ? h`<span class="result-answer__by">${c.artist}</span>` : ''}</div>
    </section>
    <div class="result-side" style="${teamVar(hero)}" data-tm="${hero?.id || ''}">
      ${mas(hero, 230, 'result-mascot')}
      ${quipBox(s, 'result', { cls: 'quip-slot--result', tail: 'top' })}
    </div>
    ${c.funFact ? h`<div class="fun-fact" data-read>${img('sparkles', 52)}<p><strong>Fun fact:</strong> ${c.funFact}</p></div>` : ''}
  </section>`;
  return view('result', html, { key: `result:${c.id}`, say: win ? `${label} ${sub}. The answer: ${answer}.` : `The answer was ${answer}.` });
}

/* ---------- sound it out: performing ---------- */
function scrSound(s, c) {
  const t = activeTeam(s);
  const perf = c.performer?.name;
  const started = !!s.timer?.started;
  const html = h`<section class="scr scr--sound" style="${teamVar(t)}">
    <section class="gift-tag gift-tag--twine sound-card" data-read aria-label="Sound It Out">
      <div class="sound-card__chips">${slotChip(segOf(c.segmentIndex))}${pointsChip(c.points, multiplier(s))}<span class="chip chip--outline">${ic('mic-off', { size: 26 })}Hum or whistle, no words</span></div>
      <div class="sound-card__who" data-tm="${t.id}">${mas(t, 120)}<h1 class="sound-title ${fit(perf || t.name, [8, 13])}">${perf || t.name}<br>${perf ? 'is' : isAre(t.name)} humming…</h1></div>
      <p class="sound-card__call"><strong>${t.name}</strong>, name that tune!</p>
      <div class="bells ${started ? 'is-live' : ''}" aria-hidden="true">${['music', 'bell', 'bell', 'music', 'bell', 'bell', 'music'].map((a, i) => raw(`<span class="bells__b" style="--i:${i}">${img(a, a === 'music' ? 64 : 76)}</span>`))}</div>
      ${c.hint ? h`<div class="holly-ribbon sound-card__rib"><strong>Hint:</strong> ${c.hint}</div>` : h`<div class="holly-ribbon sound-card__rib">Can’t name it? The other teams can <strong>steal it for ${formatPoints(c.stealPoints)}</strong>.</div>`}
    </section>
    <div class="sound-side">
      ${ring(250, { unit: started ? 'seconds' : 'ready', cls: 'sound-ring' })}
      <div class="sound-secret" data-read>${present({ size: 'md', color: '#7B4BC9', ribbon: '#EDB321', className: 'sound-gift' })}<div class="sound-secret__text"><span class="sound-secret__title">The song is a secret</span><span class="sound-secret__sub">${perf ? `Only ${perf} sees it` : 'It is on one phone'}</span></div></div>
    </div>
    ${quipBox(s, 'sound', { brief: true, cls: 'quip-slot--side', tail: 'top' })}
  </section>`;
  return view('sound', html, { key: `sound:${c.id}:${perf || ''}`, say: `${perf ? `${perf} is` : subject(t.name, 'is')} humming. ${t.name}, name that tune!` });
}

/* ---------- dare ---------- */
function dareWho(c, t) {
  const p = c.performer?.name;
  const q = c.partner?.name;
  switch (c.dare?.who) {
    case 'pair': return p && q ? `${p} & ${q} perform, ${subject(t.name, 'cheers')}` : `Two players from ${t.name}`;
    case 'team': return `All of ${t.name}`;
    case 'everyone': return 'Every team joins in';
    default: return p ? `${p} performs, and ${t.name} can help` : `One player from ${t.name}`; // "can" agrees with any team name
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
  const kind = d.hasSecret ? 'Secret on a phone' : { pair: 'Pair dare', team: 'Team dare', everyone: 'Everyone plays' }[d.who] || 'Solo dare';
  return h`<section class="candy-frame dare-card" data-read aria-label="Dare card">
    <div class="dare-card__top">${img('masks', 110, 'dare-card__masks')}<div class="dare-card__chips">${slotChip(segOf(c.segmentIndex))}<span class="chip chip--level">${kind}</span>${pointsChip(200, multiplier(s), 'to win')}</div></div>
    <h1 class="dare-card__title ${fit(d.title, [18, 28])}">${d.title}</h1>
    <p class="dare-card__text ${fit(d.instructions, [110, 170, 240])}">${d.instructions}</p>
    <div class="dare-card__facts">
      <span class="dare-fact">${ic('users', { size: 30 })}${dareWho(c, t)}</span>
      ${d.props?.length ? h`<span class="dare-props">${d.props.map((p, i) => h`<span class="prop-tag" style="--r:${(i % 2 ? 3 : -3)}deg">${p}</span>`)}</span>` : h`<span class="dare-fact">${ic('hand', { size: 30 })}No props needed</span>`}
    </div>
    ${extra}
  </section>`;
}
function judgeLine(s, c, chosen = null, bonus = false) {
  const m = multiplier(s);
  const pill = (k, label, pts) => h`<span class="judge-pill judge-pill--${k} ${chosen ? (chosen === k ? 'is-chosen' : 'is-dim') : ''}">${chosen === k ? ic('check', { size: 24, stroke: 3 }) : ''}${label} <b>${pts}</b></span>`;
  return h`<div class="dare-judge">${c.dare?.judge && !chosen ? h`<p class="dare-judge__rule">${ic('gavel', { size: 28 })}${c.dare.judge}</p>` : ''}
    <div class="dare-judge__pills">${pill('nailed', 'Nailed it', 200 * m)}${pill('valiant', 'Valiant effort', 100 * m)}${pill('fail', 'Not this time', 0)}<span class="judge-pill judge-pill--bonus ${chosen ? (bonus ? 'is-chosen' : 'is-dim') : ''}">${img('star', 30)}Crowd favourite <b>+${50 * m}</b></span></div></div>`;
}
function scrDare(s, c) {
  const t = activeTeam(s);
  const d = c.dare || {};
  const started = !!s.timer?.started;
  const perf = performerLine(c, t);
  const html = h`<section class="scr scr--dare">
    ${dareCard(s, c, t, judgeLine(s, c))}
    <aside class="dare-side" style="${teamVar(t)}" data-tm="${t.id}">
      <span class="dare-side__eyebrow">Now performing</span>
      ${mas(t, 130, 'dare-side__mascot')}
      <span class="dare-side__name ${fit(perf, [8, 12, 18, 26])}" data-read>${perf}</span>
      ${c.answer
        ? h`<span class="secret-pill" data-read>${ic('eye', { size: 28 })}The secret: <strong>${c.answer}</strong></span>`
        : d.hasSecret ? h`<span class="secret-pill" data-read>${ic('smartphone', { size: 28 })}The secret is on ${possessive(c.performer?.name || 'their')} phone</span>` : ''}
      ${ring(210, { unit: started ? 'seconds' : 'ready', cls: 'dare-ring' })}
    </aside>
    ${quipBox(s, 'dare', { brief: true, cls: 'quip-slot--dare', tail: 'right' })}
  </section>`;
  return view('dare', html, { key: `dare:${c.id}:${d.title}`, say: `Dare: ${d.title}. ${perf} performs.` });
}

function scrDareVote(s, c) {
  const t = activeTeam(s);
  const v = c.vote || { nailed: 0, good: 0, voters: 0, eligible: 0 };
  const total = v.nailed + v.good;
  const mult = multiplier(s);
  const dots = Math.min(v.eligible, 30);
  const html = h`<section class="scr scr--vote" style="${teamVar(t)}">
    <div class="vote-head" data-read>
      ${img('bell', 150, 'vote-bell')}
      <div class="vote-head__text">
        <h1 class="vote-title">The room decides!</h1>
        <p class="vote-q">How did <strong>${performerLine(c, t)}</strong> do with “${c.dare?.title || 'the dare'}”? Vote on your phone!</p>
      </div>
      ${ring(190, { cls: 'vote-ring' })}
    </div>
    <section class="vote-meters" aria-label="Live applause meter" data-read>
      ${bellMeter({ label: `Nailed it · ${200 * mult}`, count: v.nailed, fill: total ? v.nailed / total : 0, tone: 'holly', ringing: v.nailed > 0 && v.nailed >= v.good })}
      ${bellMeter({ label: `Good try · ${100 * mult}`, count: v.good, fill: total ? v.good / total : 0, tone: 'tinsel', ringing: v.good > v.nailed })}
    </section>
    <div class="vote-foot" data-read>
      <span class="vote-count"><strong>${v.voters}</strong> of ${v.eligible} voted <span class="vote-dots" aria-hidden="true">${Array.from({ length: dots }, (_, i) => raw(`<i class="${i < v.voters ? 'is-on' : ''}"></i>`))}</span></span>
      <span class="vote-note">${mas(t, 44)}${t.name} can’t vote on their own dare</span>
    </div>
    ${quipBox(s, 'dare-vote', { cls: 'quip-slot--vote', tail: 'left' })}
  </section>`;
  return view('dare-vote', html, { key: `vote:${c.id}`, say: 'Room vote! How did they do? Vote on your phone.' });
}

function scrDareResult(s, c) {
  const t = activeTeam(s);
  const r = c.dareResult?.result || (c.result?.kind === 'skipped' ? 'skipped' : c.result?.kind) || 'fail';
  const bonus = !!c.dareResult?.bonus;
  const got = (c.result?.awards || []).filter((a) => a.teamId === t.id).reduce((a, b) => a + b.delta, 0);
  const stampText = { nailed: 'Nailed it!', valiant: 'Valiant effort!', fail: 'Not this time', skipped: 'Skipped' }[r] || 'Done';
  const v = c.vote;
  const extra = h`${c.answer ? h`<div class="dare-reveal">${ic('eye', { size: 30 })}<span>The secret was</span><strong>${c.answer}</strong></div>` : ''}${judgeLine(s, c, r, bonus)}`;
  const html = h`<section class="scr scr--dare scr--dare-result is-${r}">
    ${dareCard(s, c, t, extra)}
    <aside class="dare-side dare-side--result" style="${teamVar(t)}" data-fly-from data-tm="${t.id}">
      <span class="dare-stamp dare-stamp--${r} ${r === 'fail' ? 'coal-stamp' : 'stamp'} is-in">${stampText}</span>
      ${mas(t, 150, 'dare-side__mascot')}
      <span class="dare-side__name ${fit(performerLine(c, t), [8, 12, 18, 26])}" data-read>${performerLine(c, t)}</span>
      <span class="dare-got ${got > 0 ? 'is-up' : ''}" data-read>${got > 0 ? `${formatDelta(got)} points` : 'No points this time'}</span>
      ${v && (v.nailed || v.good) ? h`<span class="dare-side__vote" data-read>The room: <strong>${v.nailed}</strong> nailed it, <strong>${v.good}</strong> good try</span>` : ''}
      ${upNextPill(s)}
    </aside>
    ${quipBox(s, 'dare-result', { cls: 'quip-slot--dare', tail: 'right' })}
  </section>`;
  return view('dare-result', html, { key: `dare-result:${c.id}`, say: `${stampText}. ${got > 0 ? `${subject(t.name, 'scores')} ${got}.` : ''}` });
}

/* ---------- showdown ---------- */
function scrShowdownPick(s, c) {
  const t = activeTeam(s);
  const eye = c.eyeing;
  const targets = (c.targets || []).map(team).filter(Boolean);
  const html = h`<section class="scr scr--sdpick" style="${teamVar(t)}">
    <div class="sdpick-head" data-read>
      ${img('boxing', 140, 'sdpick-art')}
      <div><span class="sdpick-eyebrow">${slotChip(segOf(c.segmentIndex))}<span class="chip chip--points">Winner ${200 * multiplier(s)} · tie 100 each</span></span>
      <h1 class="sdpick-title">Who will ${t.name} call out?</h1>
      <p class="sdpick-eye">${eye ? h`${mas(team(eye.teamId), 44)}<span>${eye.by?.name ? `${eye.by.name} is` : subject(t.name, 'is')} eyeing <strong>${team(eye.teamId)?.name || ''}</strong>…</span>` : h`<span>Choosing on their phones<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`}</p></div>
    </div>
    <div class="sd-targets sd-targets--n${Math.min(targets.length, 7)}" role="list">
      ${targets.map((x) => h`<div class="sd-target ${eye?.teamId === x.id ? 'is-eyed' : ''}" role="listitem" data-key="${x.id}" style="${teamVar(x)}">
        ${eye?.teamId === x.id ? h`<span class="sd-target__tag">Called out?</span>` : ''}
        ${mas(x, 110, 'sd-target__mascot')}<span class="sd-target__name">${x.name}</span><span class="sd-target__score">${formatPoints(x.score)}</span>
      </div>`)}
    </div>
    <div class="holly-ribbon holly-ribbon--plain sdpick-rule" data-read>One player from each team goes head to head. <strong>The host picks the winner.</strong></div>
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
    return h`<div class="sd-side sd-side--${which} ${won ? 'is-won' : ''} ${lost ? 'is-lost' : ''}" style="${teamVar(tm)}" data-tm="${tm?.id || ''}" ${won ? raw('data-fly-from') : ''}>
      ${mas(tm, 250, 'sd-side__mascot')}
      <span class="sd-side__name ${fit(name, [7, 11, 15])}" data-read>${name}</span>
      <span class="sd-side__team" data-read>${tm?.name || ''}</span>
      ${won ? h`<span class="sd-side__won">${w === 'tie' ? 'Tie!' : 'Wins!'} ${delta ? formatDelta(delta) : ''}</span>` : ''}
    </div>`;
  };
  const html = h`<section class="scr scr--showdown ${done ? 'is-done' : ''}" aria-label="Showdown: ${aName} from ${t.name} versus ${bName} from ${rivalTeam?.name || ''}">
    <div class="sd-arena">
      ${side(t, aName, 'active')}
      <div class="sd-vs" role="img" aria-label="${done ? (w === 'tie' ? 'It’s a tie' : 'Winner decided') : 'Versus'}"><span class="sd-vs__ball">${done && w === 'tie' ? 'Tie' : 'VS'}</span></div>
      ${side(rivalTeam, bName, 'rival')}
    </div>
    <section class="gift-tag gift-tag--twine sd-card" data-read>
      <div class="sd-card__text"><span class="sd-card__label">${slotChip(segOf(c.segmentIndex), { size: 'md' })}<span class="chip chip--md chip--points">Winner ${200 * multiplier(s)} · tie 100 each</span></span><h1 class="sd-card__title ${fit(sd.title, [22, 32])}">${sd.title || ''}</h1>${done && quipFor(s, 'showdown') ? quipBox(s, 'showdown', { cls: 'quip-slot--inline', tail: 'left' }) : h`<p class="sd-card__rule ${fit(sd.instructions, [110, 170])}">${sd.instructions || ''}</p>`}</div>
      ${done ? upNextPill(s) : ring(150, { unit: started ? 'seconds' : 'ready', cls: 'sd-ring' })}
    </section>
  </section>`;
  const say = done ? (w === 'tie' ? 'It’s a tie! 100 points each.' : `${w === 'active' ? aName : bName} ${(w === 'active' ? !c.performer?.name && isPluralTeam(aName) : !c.rival?.name && isPluralTeam(bName)) ? 'win' : 'wins'} the showdown!`) : `Showdown: ${aName} versus ${bName}. ${sd.title || ''}`;
  return view(done ? 'showdown-result' : 'showdown', html, {
    key: `showdown:${c.id}:${sd.title || ''}`, stripMode: 'rival', say,
    enter: () => later(200, () => { play('whoosh', 400); later(380, () => play('splat')); }),
  });
}

/* ---------- rapid list ---------- */
function scrRapid(s, c) {
  const t = activeTeam(s);
  const L = c.list || { ticked: [], count: 0, max: 6, each: 50 };
  const done = c.stage === 'done';
  const mult = multiplier(s);
  const so = Math.min(L.count, L.max) * L.each * mult;
  const revealed = done && Array.isArray(L.answers);
  const items = L.ticked.slice(0, L.max).map((a) => ({ text: a, done: true }));
  const extra = Math.max(0, L.ticked.length - L.max);
  const html = h`<section class="scr scr--rapid ${revealed ? 'is-revealed' : ''}" style="${teamVar(t)}">
    <section class="gift-tag gift-tag--twine rl-card" data-read ${done ? raw('data-fly-from') : ''}>
      <div class="rl-card__chips">${slotChip(segOf(c.segmentIndex))}${pointsChip(L.each, mult, 'each')}<span class="chip chip--level">Max ${L.max * L.each * mult}</span></div>
      <h1 class="rl-card__prompt ${fit(L.prompt, [26, 44, 64])}">${L.prompt}</h1>
      <div class="rl-card__team">${mas(t, 64)}<span>${done ? (L.count ? `${t.name} named ${Math.min(L.count, L.max)}!` : `Time’s up, ${t.name}!`) : h`<b>${t.name}</b>, shout them out!`}</span></div>
      <div class="rl-card__foot">
        ${done ? h`<span class="rl-card__done">${img('list', 64)}Santa checked it twice</span>` : ring(170, { unit: s.timer?.started ? 'seconds' : 'ready', cls: 'rl-ring' })}
        <div class="rl-score"><span class="rl-score__n">${formatPoints(so)}</span><span class="rl-score__l">points${done ? '' : ' so far'}</span></div>
      </div>
      ${extra ? h`<p class="rl-extra">+${extra} more named</p>` : ''}
    </section>
    <div class="rl-list" data-read>
      ${revealed
        ? h`<div class="santa-list rl-all"><div class="santa-list__head"><span class="santa-list__title">Santa’s list</span><span class="santa-list__count">${Math.min(L.count, L.max)} of ${L.max}</span></div><ul class="rl-all__items" role="list">${revealAll(L)}</ul></div>`
        : santaList({ items, total: L.max })}
    </div>
    ${quipBox(s, 'rapid', { cls: 'quip-slot--rapid', tail: 'right', brief: !done })}
  </section>`;
  return view(done ? 'rapid-result' : 'rapid', html, { key: `rapid:${c.id}:${done ? 'done' : 'list'}:${revealed ? 'r' : ''}`, say: done ? `${t.name} named ${L.count}.` : `Rapid list: ${L.prompt}` });
}
function revealAll(L) {
  const hits = L.answers.filter((a) => L.ticked.includes(a));
  const rest = L.answers.filter((a) => !L.ticked.includes(a));
  const shown = rest.slice(0, Math.max(0, 12 - hits.length));
  const more = rest.length - shown.length;
  return h`${hits.map((a) => h`<li class="is-hit">${a}</li>`)}${shown.map((a) => h`<li>${a}</li>`)}${more > 0 ? h`<li class="is-more">+${more} more</li>` : ''}`;
}

/* ---------- hot seat ---------- */
function scrHotSeat(s, c) {
  const t = activeTeam(s);
  const hs = c.hotseat || { index: 0, total: 6, results: [], question: null, each: 50, banked: 0 };
  const done = c.stage === 'done';
  const perf = c.performer?.name || t.name;
  const right = hs.results.filter((r) => r === 'correct').length;
  const socks = Array.from({ length: hs.total }, (_, i) => {
    const r = hs.results[i];
    const st = r === 'correct' ? 'full' : r === 'wrong' || r === 'pass' ? 'coal' : 'empty'; // a pass scores nothing: coal, like on the phone and the host (labelled "Pass")
    const cur = i === hs.index && !done;
    return h`<span class="hs-sock ${cur ? 'is-current' : ''} ${r ? `is-${r}` : 'is-todo'}" data-key="s${i}">${stocking({ color: r === 'correct' ? '#1F7A4A' : '#D42A2A', state: st, size: 92, ariaLabel: `Question ${i + 1}: ${r || 'not yet'}` })}<span class="hs-sock__n">${r === 'pass' ? 'Pass' : i + 1}</span></span>`;
  });
  const html = h`<section class="scr scr--hotseat" style="${teamVar(t)}">
    <aside class="hs-left" data-tm="${t.id}">
      <div class="hs-hero">${img('fire', 170, 'hs-fire')}${mas(t, 170, 'hs-mascot')}</div>
      <span class="hs-name ${fit(perf, [7, 10, 14])}" data-read>${perf}</span>
      <span class="hs-line" data-read>${done ? 'is out of the Hot Seat' : 'is in the Hot Seat'}</span>
      <div class="hs-bank" data-read ${done ? raw('data-fly-from') : ''}><span class="hs-bank__n">${formatPoints(hs.banked)}</span><span class="hs-bank__l">banked${done ? '' : ' so far'}</span></div>
    </aside>
    <div class="hs-main">
      <div class="hs-progress" data-read>
        <div class="hs-socks" role="img" aria-label="${right} correct so far">${socks}</div>
        ${done ? upNextPill(s) : ring(150, { unit: s.timer?.started ? 'seconds' : 'ready', cls: 'hs-ring' })}
      </div>
      <section class="gift-tag hs-card" data-read>
        ${done
          ? h`<span class="hs-card__label">${slotChip(segOf(c.segmentIndex), { size: 'md' })}Final tally</span><h1 class="hs-card__q">${perf} got ${right} of ${hs.total} right</h1>`
          : hs.question
            ? h`<span class="hs-card__label">${slotChip(segOf(c.segmentIndex), { size: 'md' })}<span class="chip chip--md chip--level">Question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}</span><span class="chip chip--md chip--points">${hs.each * multiplier(s)} points</span></span><h1 class="hs-card__q ${fit(hs.question, [70, 110, 150])}">${hs.question}</h1>`
            : h`<span class="hs-card__label">${slotChip(segOf(c.segmentIndex), { size: 'md' })}Get ready, ${perf}</span><h1 class="hs-card__q">The first question pops up the moment the clock starts.</h1>`}
        <div class="holly-ribbon hs-card__rib">${done ? `${formatPoints(hs.banked)} points to ${t.name}.` : h`${perf} answers out loud. <strong>Teammates, no helping!</strong>`}</div>
      </section>
    </div>
    ${quipBox(s, 'hotseat', { cls: 'quip-slot--hs', tail: 'top', brief: !done })}
  </section>`;
  return view(done ? 'hotseat-result' : 'hotseat', html, { key: `hotseat:${c.id}:${done ? 'done' : 'live'}`, say: done ? `${perf} banked ${hs.banked} points.` : hs.question || `${perf} is in the Hot Seat.` });
}

/* ---------- all play + round bonus: the snowy village ---------- */
function house(tm, x, i, marking) {
  const lit = x.answered;
  return h`<li class="house ${lit ? 'is-lit' : marking ? 'is-dark' : ''}" data-key="${x.teamId}" data-tm="${x.teamId}" style="${teamVar(tm)};--i:${i}">
    <svg class="house__svg" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
      <rect class="house__chimney" x="128" y="30" width="22" height="44" rx="3"/>
      <path class="house__snowcap" d="M126 30 h26 a4 4 0 0 1 0 8 h-26 a4 4 0 0 1 0-8z"/>
      <rect class="house__wall" x="30" y="92" width="140" height="100" rx="6"/>
      <path class="house__roof" d="M14 100 L100 34 L186 100 Z"/>
      <path class="house__snow" d="M10 100 L100 28 L190 100 C 178 108 168 98 156 104 C 140 112 128 100 112 106 C 96 112 86 100 70 106 C 56 112 44 100 28 106 C 20 110 14 106 10 100 Z"/>
      <rect class="house__window" x="48" y="118" width="46" height="42" rx="5"/>
      <path class="house__mullion" d="M71 118 v42 M48 139 h46"/>
      <rect class="house__door" x="114" y="128" width="38" height="64" rx="16"/>
      <circle class="house__knob" cx="144" cy="162" r="3"/>
      <path class="house__ground" d="M0 192 C 40 184 70 196 100 190 C 130 184 160 196 200 190 V200 H0Z"/>
    </svg>
    ${mas(tm, 64, 'house__mascot')}
    <span class="house__tag"><span class="house__name">${tm.name}</span><span class="house__state">${lit ? h`${ic('check', { size: 22, stroke: 3 })}Answered` : marking ? 'No answer' : h`typing<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`}</span></span>
  </li>`;
}
function scrAllPlay(s, c) {
  const bonus = c.type === 'bonus';
  const marking = c.stage === 'marking';
  const subs = c.submissions || [];
  const answered = subs.filter((x) => x.answered).length;
  const html = h`<section class="scr scr--allplay ${bonus ? 'is-bonus' : ''} houses--n${Math.min(subs.length, 8)}">
    <section class="gift-tag gift-tag--twine ap-card" data-read aria-label="${bonus ? 'Round bonus' : 'All Play'} question for every team">
      <div class="ap-card__head">
        <span class="ap-card__title">${img(bonus ? 'gift' : 'zap', 72)}<span>${bonus ? 'Round bonus!' : 'All Play!'}</span></span>
        <span class="ap-card__sub">${marking ? 'Answers are locked. The host is checking…' : 'Every team, type your answer on a phone'}</span>
        <span class="ap-card__rules"><span class="chip chip--points">100 each</span>${bonus ? '' : h`<span class="chip chip--holly">+${c.firstBonus || 50} first</span>`}</span>
      </div>
      <h1 class="ap-card__q ${fit(c.question, [70, 110, 150])}">${c.question}</h1>
      ${marking ? h`<div class="ap-lock">${ic('lock', { size: 64 })}<span>Locked</span></div>` : ring(150, { cls: 'ap-ring' })}
    </section>
    <div class="village" aria-label="Which teams have answered: ${answered} of ${subs.length}">
      <span class="village__count" data-read><strong>${answered} of ${subs.length}</strong> windows lit</span>
      <ul class="houses" role="list">${subs.map((x, i) => { const tm = team(x.teamId); return tm ? house(tm, x, i, marking) : ''; })}</ul>
    </div>
  </section>`;
  const name = `${bonus ? 'bonus' : 'allplay'}${marking ? '-marking' : ''}`;
  return view(name, html, { key: `${bonus ? 'bonus' : 'allplay'}:${c.id}:${c.question}`, strip: false, say: marking ? 'Answers are locked.' : `${bonus ? 'Round bonus' : 'All Play'}! Every team, type your answer. ${c.question}` });
}

function scrAllPlayReveal(s, c) {
  const bonus = c.type === 'bonus';
  const subs = c.submissions || [];
  const right = subs.filter((x) => x.correct).length;
  const n = subs.length;
  const html = h`<section class="scr scr--reveal ${bonus ? 'is-bonus' : ''} rv--n${Math.min(n, 8)} ${n > 4 ? 'rv--many' : ''}">
    <div class="rv-top" data-read>
      <div class="rv-q"><span class="rv-q__label">${img(bonus ? 'gift' : 'zap', 44)}${bonus ? 'Round bonus' : 'All Play'}: the answers are in</span><p class="rv-q__q ${fit(c.question, [90, 140])}">${c.question}</p></div>
      <div class="rv-answer"><span class="rv-answer__label">The answer</span><span class="rv-answer__value ${fit(c.answer, [18, 30])}">${c.answer || ''}</span><span class="rv-answer__score">${right} of ${n} got it</span></div>
    </div>
    <ol class="rv-grid" role="list" aria-label="Every team’s typed answer">
      ${subs.map((x, i) => {
        const tm = team(x.teamId);
        if (!tm) return '';
        const delta = x.delta || 0;
        return h`<li class="gift-tag gift-tag--md rv-tag ${x.correct ? 'is-right' : 'is-wrong'} ${x.first ? 'is-first' : ''}" data-key="${x.teamId}" style="${teamVar(tm)};--i:${i}">
          ${x.first ? h`<span class="rv-tag__first">${img('zap', 30)}First correct!</span>` : ''}
          <div class="rv-tag__head">${mas(tm, 56)}<span class="rv-tag__name">${tm.name}</span><span class="rv-tag__mark ${x.correct ? 'is-yes' : 'is-no'}" role="img" aria-label="${x.correct ? 'Correct' : 'Not this time'}">${ic(x.correct ? 'check' : 'x', { size: 30, stroke: 3 })}</span></div>
          <p class="rv-tag__text ${x.answered ? '' : 'is-blank'} ${fit(x.text, [14, 24, 40])}">${x.answered ? x.text : 'No answer'}</p>
          <div class="rv-tag__foot"><span class="rv-tag__delta ${delta > 0 ? 'is-up' : ''}">${delta > 0 ? formatDelta(delta) : '0'}</span><span class="rv-tag__now">${delta > 0 ? 'now' : 'stays at'} <strong>${formatPoints(tm.score)}</strong></span></div>
        </li>`;
      })}
    </ol>
    ${quipBox(s, 'allplay-reveal', { cls: 'quip-slot--rv', tail: 'bottom' })}
  </section>`;
  const name = bonus ? 'bonus-reveal' : 'allplay-reveal';
  return view(name, html, { key: `${name}:${c.id}`, strip: false, say: `The answer: ${c.answer}. ${right} of ${n} teams got it right.` });
}

/* ---------- double down ---------- */
function scrDoubleDown(s) {
  const t = activeTeam(s);
  const html = h`<section class="scr scr--dd" style="${teamVar(t)}">
    <span class="splash__eyebrow dd-eyebrow">${img('sparkles', 44)}The wheel landed on</span>
    <h1 class="splash__word dd-word">Double Down!</h1>
    <p class="dd-sub" data-read>Everything ${t.name} ${verb(t.name, 'wins', 'win')} this turn is <span class="highlight-word">doubled</span></p>
    ${quipBox(s, 'double-down', { cls: 'quip-slot--dd', tail: 'bottom' })}
    <div class="dd-call" data-read>${mas(t, 60)}<span>Spin again from ${anyPhone(t)}</span></div>
    <div class="sleigh sleigh--dd" aria-hidden="true">${img('deer', 150, 'sleigh__deer sleigh__deer--a')}${img('deer', 150, 'sleigh__deer sleigh__deer--b')}<span class="sleigh__reins"></span>${img('sled', 190, 'sleigh__sled')}</div>
  </section>`;
  return view('double-down', html, {
    key: `dd:${s.turnId}:${s.challenge?.id || ''}`, strip: true, header: false,
    backdrop: raw('<div class="splash splash--contained splash--candy dd-splash"></div>'),
    say: `Double Down! ${subject(t.name, 'spins')} again, and everything you win this turn is doubled.`,
    enter: () => later(300, () => play('sleighBells', 1600)),
  });
}

/* ---------- grinch steal ---------- */
const GRINCH_BD = raw(`<div class="grinch-field"><span class="grinch-field__hill"></span>${[
  ['#D42A2A', '#EDB321', 'sm', 4, 'a'], ['#2E6FD1', '#FFFFFF', 'md', 2, 'b'], ['#7B4BC9', '#EDB321', 'sm', 6, 'c'], ['#F28C28', '#D42A2A', 'sm', 8, 'd'], ['#1F7A4A', '#FFFFFF', 'md', 3, 'e'],
].map(([c, r, sz, d, k]) => `<span class="teeter teeter--${k}" style="--d:${d}">${present({ size: sz, color: c, ribbon: r })}</span>`).join('')}</div>`);
function scrGrinchPick(s, c) {
  const t = activeTeam(s);
  const eye = c.eyeing;
  const targets = new Set(c.targets || []);
  const others = s.teams.filter((x) => x.id !== t.id).sort((a, b) => b.score - a.score);
  const eyed = eye ? team(eye.teamId) : null;
  const take = (victim) => Math.min(c.points, victim.score);
  const gain = eyed ? take(eyed) : c.points;
  const html = h`<section class="scr scr--grinch" style="${teamVar(t)}">
    <div class="grinch-head" data-read>${img('money', 150, 'grinch-money')}<div><h1 class="grinch-title">Grinch Steal!</h1><p class="grinch-sub">${t.name} can rob any team ahead of them</p></div></div>
    <p class="grinch-eye" data-read>${eye ? h`${mas(t, 48)}<span>${eye.by?.name ? `${eye.by.name} is` : subject(t.name, 'is')} eyeing <strong>${eyed?.name || ''}</strong>…</span>` : h`${mas(t, 48)}<span>Choosing on their phones<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`}</p>
    <div class="g-targets g-targets--n${Math.min(others.length, 7)}" role="list" aria-label="Teams ${t.name} can steal from">
      ${others.map((x) => {
        const can = targets.has(x.id);
        const isEyed = eye?.teamId === x.id;
        if (!can) return h`<div class="g-target is-safe" role="listitem" data-key="${x.id}" style="${teamVar(x)}">${mas(x, 90)}<span class="g-target__name">${x.name}</span><span class="g-target__score">${formatPoints(x.score)}</span><span class="g-target__safe">${ic('shield-check', { size: 24 })}${x.score === t.score ? 'Level: safe' : 'Behind: safe'}</span></div>`;
        return h`<div class="g-target ${isEyed ? 'is-eyed' : ''}" role="listitem" data-key="${x.id}" style="${teamVar(x)}">
          ${isEyed ? h`<span class="g-target__tag">Uh-oh…</span>` : ''}
          ${mas(x, 90)}<span class="g-target__name">${x.name}</span><span class="g-target__score">${formatPoints(x.score)}</span>
          <span class="g-target__drop">${isEyed ? `would drop to ${formatPoints(x.score - take(x))}` : `${ordinal(x.rank || 1)} place`}</span>
        </div>`;
      })}
    </div>
    <div class="grinch-bar" data-read>${mas(t, 56)}<span>${t.name}: <b>${formatPoints(t.score)}</b> ${ic('arrow-right', { size: 30 })} <b>${formatPoints(t.score + gain)}</b></span><span class="grinch-bar__up">Up to ${formatPoints(c.points)} points change hands</span></div>
    ${quipBox(s, 'grinch-pick', { cls: 'quip-slot--grinch', tail: 'left' })}
  </section>`;
  return view('grinch-pick', html, { key: `grinch-pick:${c.id}`, header: false, surface: 'grinch', backdrop: GRINCH_BD, strip: false, say: `Grinch Steal! ${t.name} can rob a team ahead of them.` });
}
function grinchCard(tm, { tag, tone, big, sub, cls = '' }) {
  return h`<div class="g-card ${cls}" style="${teamVar(tm)}" data-tm="${tm.id}">
    <span class="g-card__tag g-card__tag--${tone}">${tag}</span>
    ${mas(tm, 120, 'g-card__mascot')}
    <span class="g-card__name">${tm.name}</span><span class="g-card__score">${big}</span><span class="g-card__sub">${sub}</span>
  </div>`;
}
function scrGrinchDone(s, c) {
  const t = activeTeam(s);
  if (c.gift) {
    const to = team(c.gift.toTeamId);
    const before = (to?.score ?? 0) - c.gift.amount;
    const html = h`<section class="scr scr--gift" style="${teamVar(t)}">
      <div class="gift-head" data-read><span class="gift-heart" aria-hidden="true"></span><div><h1 class="grinch-title">Your heart grew three sizes!</h1><p class="grinch-sub">${subject(t.name, 'is')} in 1st, so nobody to rob. They gift <strong>${formatPoints(c.gift.amount)} points</strong> to ${to?.name || ''}.</p></div></div>
      <div class="g-cards" data-read>
        ${grinchCard(t, { tag: 'Gives', tone: 'gold', big: formatPoints(t.score), sub: 'still in 1st', cls: 'is-giver' })}
        <div class="g-mid">${present({ size: 'md', color: '#D42A2A', ribbon: '#EDB321', label: 'A gift of', points: formatPoints(c.gift.amount) })}</div>
        ${to ? grinchCard(to, { tag: formatDelta(c.gift.amount), tone: 'holly', big: formatPoints(to.score), sub: `from ${formatPoints(before)}. Merry Christmas!`, cls: 'is-glow' }) : ''}
      </div>
      ${quipBox(s, 'grinch-gift', { cls: 'quip-slot--gcard', tail: 'top' })}
    </section>`;
    return view('grinch-gift', html, {
      key: `grinch-gift:${c.id}`, header: false, surface: 'grinch', backdrop: GRINCH_BD, strip: false,
      say: `${t.name}'s heart grew three sizes! They gift ${c.gift.amount} points to ${to?.name}.`,
      enter: () => later(500, () => gagOnce('heartGrow', () => { play('boing'); fx.heartGrow(stage.querySelector('.is-giver')); })),
    });
  }
  if (c.steal) {
    const from = team(c.steal.from);
    const to = team(c.steal.to) || t;
    const html = h`<section class="scr scr--gift scr--heist" style="${teamVar(to)}">
      <div class="gift-head" data-read>${img('money', 150, 'grinch-money')}<div><h1 class="grinch-title">Grinch Steal!</h1><p class="grinch-sub"><strong>${to.name}</strong> swiped <strong>${formatPoints(c.steal.amount)}</strong> from ${from?.name || ''}!</p></div></div>
      <div class="g-cards" data-read>
        ${from ? grinchCard(from, { tag: formatDelta(-c.steal.amount), tone: 'candy', big: formatPoints(from.score), sub: `from ${formatPoints(from.score + c.steal.amount)}. Ouch!`, cls: 'is-victim' }) : ''}
        <div class="g-mid g-mid--arrow">${ic('arrow-right', { size: 90, stroke: 3 })}<span>Swiped ${formatPoints(c.steal.amount)}</span></div>
        ${grinchCard(to, { tag: formatDelta(c.steal.amount), tone: 'holly', big: formatPoints(to.score), sub: `from ${formatPoints(to.score - c.steal.amount)}. Sneaky!`, cls: 'is-glow is-thief' })}
      </div>
      ${quipBox(s, 'grinch-steal', { cls: 'quip-slot--gcard', tail: 'top' })}
      <div class="g-next">${upNextPill(s)}</div>
    </section>`;
    return view('grinch-steal', html, {
      key: `grinch-steal:${c.id}`, header: false, surface: 'grinch', backdrop: GRINCH_BD, strip: false,
      say: `${subject(to.name, 'steals')} ${c.steal.amount} points from ${from?.name}!`,
      enter: () => later(450, () => gagOnce('grinchSteal', () => { play('kaChing'); fx.sneak('money', { from: stage.querySelector('.is-victim') }); })),
    });
  }
  return scrSkipped(s, c);
}

/* ---------- skipped / fallback ---------- */
function scrSkipped(s, c) {
  const t = activeTeam(s);
  const seg = segOf(c?.segmentIndex) || segOf(0);
  const html = h`<section class="scr scr--skipped">
    <div class="gift-tag gift-tag--twine skip-card" data-read>
      ${slotChip(seg)}
      <h1 class="skip-card__title">Skipped. No points this time.</h1>
      <p class="skip-card__text">${t ? `${subject(t.name, 'lives')} to spin another day.` : 'On to the next one!'}</p>
      ${upNextPill(s)}
    </div>
    ${quipBox(s, 'skipped', { cls: 'quip-slot--skip', tail: 'top' })}
  </section>`;
  return view('skipped', html, { key: `skipped:${c?.id}` });
}

/* ---------- round break: hot cocoa ---------- */
function scrRoundBreak(s) {
  const rb = s.roundBreak;
  const st = rb.standings || [];
  const best = team(st[0]?.teamId);
  const max = Math.max(1, ...st.map((x) => x.score));
  const left = s.totalRounds - rb.round;
  const tie = st.length > 1 && st[0].score === st[1].score;
  let lead;
  if (!st.length || st[0].score === 0) lead = 'Everyone’s still on zero. Anything can happen!';
  else if (tie) lead = 'It’s neck and neck at the top!';
  else lead = `${subject(best?.name || '', 'leads')} by ${formatPoints(rb.leadBy)}. ${rb.finalNext ? 'Final Chaos decides it.' : left === 1 ? 'One round left to catch them.' : `${left} rounds left to catch them.`}`;
  const next = rb.nextRound;
  const isLast = !rb.finalNext && next === s.totalRounds;
  const first = s.teams[0];
  const lastId = st.length > 1 && st[st.length - 1].score < st[0].score ? st[st.length - 1].teamId : null;
  const move = (x) => {
    if (!x.move) return '';
    if (x.move === 'up') return h`<span class="rb-move rb-move--up">${ic('arrow-up', { size: 26, stroke: 3 })}${x.places}</span>`;
    if (x.move === 'down') return h`<span class="rb-move rb-move--down">${ic('arrow-down', { size: 26, stroke: 3 })}${x.places}</span>`;
    return h`<span class="rb-move rb-move--same">${ic('minus', { size: 26, stroke: 3 })}</span>`;
  };
  const nextCard = rb.bonusPlanned && !rb.bonusDone
    ? h`<span class="rb-next__title">${img('gift', 56)}Bonus question next!</span><span class="rb-next__sub">Every team answers on a phone, 100 for each right answer.</span>`
    : rb.finalNext
      ? h`<span class="rb-next__title">${img('moon', 56)}Final Chaos is next!</span><span class="rb-next__sub">Every team wagers on one last question.</span>`
      : h`<span class="rb-next__title">${img('sled', 56)}${isLast ? `Round ${next} is the last round!` : `Round ${next} of ${s.totalRounds} is next`}</span><span class="rb-next__sub"><strong>${first?.name || ''}</strong> ${verb(first?.name, 'spins', 'spin')} first.${isLast ? ' Then Final Chaos.' : ''}</span>`;
  const html = h`<section class="scr scr--round ${st.length > 6 ? 'is-many' : ''}">
    <aside class="rb-left">
      <div class="rb-head">${img('cocoa', 190, 'rb-cocoa')}<h1 class="rb-title" data-read>Hot cocoa break!</h1></div>
      <p class="rb-lead" data-read>End of Round ${rb.round}. ${lead}</p>
      <div class="gift-tag gift-tag--md gift-tag--twine rb-next" data-read>${nextCard}</div>
      ${quipBox(s, 'round-break', { cls: 'quip-slot--rb', tail: 'top' })}
    </aside>
    <section class="rb-table" aria-label="Standings after Round ${rb.round}" data-read>
      ${st.map((x, i) => {
        const tm = team(x.teamId);
        if (!tm) return '';
        const isTop = x.rank === 1 && x.score > 0 && !tie;
        const isLast = x.teamId === lastId;
        return h`<div class="rb-row ${isTop ? 'is-top' : ''}" data-key="${x.teamId}" data-tm="${x.teamId}" style="${teamVar(tm)};--i:${i}">
          <span class="rb-rank rb-rank--${Math.min(x.rank, 4)}">${x.rank <= 3 ? img(`medal${x.rank}`, 60) : x.rank}</span>
          ${mas(tm, 64, 'rb-row__mascot')}
          <div class="rb-row__body">
            <div class="rb-row__line"><span class="rb-row__name">${tm.name}</span>${move(x)}${isTop ? h`<span class="rb-note rb-note--roast">${pick(ROASTS, rb.round + 1)}</span>` : isLast ? h`<span class="rb-note rb-note--pep">${pick(PEPTALKS, rb.round)}</span>` : ''}</div>
            <div class="rb-bar"><span class="rb-bar__fill" style="--pct:${Math.max(6, Math.round((x.score / max) * 100))}%"></span><span class="rb-bar__num">${formatPoints(x.score)}</span></div>
          </div>
        </div>`;
      })}
    </section>
  </section>`;
  return view('round-break', html, { key: `round-break:${rb.round}`, strip: false, say: `Hot cocoa break. End of round ${rb.round}. ${lead}` });
}

/* ---------- final chaos: Christmas Eve ---------- */
const NIGHT_BD = raw(`<div class="night-sky tv-night"><div class="starfield">${starfieldMarkup({ count: 40, seed: 2412, twinkle: 4 })}</div>${artImgRaw('moon', 190, 'tv-night__moon')}<div class="night-sleigh">${artImgRaw('deer', 96, 'night-sleigh__deer')}${artImgRaw('deer', 96, 'night-sleigh__deer night-sleigh__deer--b')}${artImgRaw('sled', 120, 'night-sleigh__sled')}</div><span class="tv-night__hills"></span></div>`);
function artImgRaw(id, size, cls) {
  return String(art(id, { size, eager: true, className: cls }));
}
function finalCategory(f) {
  const seg = segOf(CATEGORY_SEGMENT[f.category] ?? 0);
  return h`<div class="fc-cat" style="${segVar(seg)}">${img(slotArtId(seg) || 'sparkles', 84)}<div class="fc-cat__text"><span class="fc-cat__label">Tonight’s final category</span><span class="fc-cat__name ${fit(f.categoryLabel, [14, 20])}">${f.categoryLabel}</span></div></div>`;
}
function wagerGift(s, w, mode) {
  const tm = team(w.teamId);
  if (!tm) return '';
  const done = mode === 'wager' ? w.locked : w.answered;
  const lead = leaders(s).has(tm.id);
  const label = mode === 'wager' ? (w.locked ? 'Locked in' : 'Wagering…') : mode === 'answer' ? (w.answered ? 'Answered' : 'Typing…') : `Up to ${formatPoints(w.max)}`;
  return h`<li class="fc-gift ${done ? 'is-done' : ''}" data-key="${tm.id}" style="${teamVar(tm)}">
    <span class="fc-gift__box">${present({ size: 'sm', color: colorOf(tm.color, '#D42A2A'), ribbon: '#EDB321', state: done ? 'sealed' : 'closed', className: done ? 'is-sealed-now' : '' })}${mas(tm, 64, 'fc-gift__mascot')}${lead ? img('glowing-star', 44, 'fc-gift__star') : ''}</span>
    <span class="fc-gift__name">${tm.name}</span>
    <span class="fc-gift__score">${formatPoints(tm.score)}</span>
    <span class="fc-gift__state">${done ? ic(mode === 'wager' ? 'lock' : 'check', { size: 22, stroke: 3 }) : ''}${label}</span>
  </li>`;
}
function scrFinalIntro(s) {
  const f = s.final;
  const wager = s.phase === 'finalWager';
  const locked = f.wagers.filter((w) => w.locked).length;
  const n = s.teams.length;
  const html = h`<section class="scr scr--final">
    <div class="fc-top">
      <div class="fc-title-wrap" data-read><span class="fc-eyebrow">${img('star', 40)}Christmas Eve</span><h1 class="fc-title">Final Chaos</h1></div>
      <div class="fc-mid" data-read>${finalCategory(f)}<p class="fc-explain">Wager up to your score <span class="fc-explain__soft">(or up to 300 if you’re behind)</span>. Right answer wins it, wrong answer loses it.</p></div>
      ${wager ? ring(190, { unit: 'to lock in', tone: 'gold', cls: 'fc-ring' }) : ''}
    </div>
    ${quipBox(s, 'final', { cls: 'quip-slot--final', tail: 'bottom' })}
    <div class="fc-status" data-read>
      <span class="fc-status__count">${wager ? h`<strong>${locked} of ${n}</strong> wagers wrapped` : 'Talk it over with your team. Wagers open in a moment.'}</span>
      <span class="fc-status__note">${ic('eye-off', { size: 28 })}Wagers stay secret until the reveal</span>
    </div>
    <ul class="fc-gifts fc-gifts--n${Math.min(n, 8)}" role="list" data-read>${f.wagers.map((w) => wagerGift(s, w, wager ? 'wager' : 'intro'))}</ul>
  </section>`;
  return view(wager ? 'final-wager' : 'final-intro', html, { key: wager ? 'final-wager' : 'final-intro', strip: false, surface: 'night', backdrop: NIGHT_BD, say: wager ? 'Final Chaos: lock in your wagers.' : `Final Chaos! Tonight's final category is ${f.categoryLabel}.` });
}
function scrFinalAnswer(s) {
  const f = s.final;
  const answered = f.submissions.filter((x) => x.answered).length;
  const n = s.teams.length;
  const html = h`<section class="scr scr--final scr--final-answer">
    <section class="gift-tag gift-tag--twine fa-card" data-read>
      <div class="fa-card__chips"><span class="chip chip--points">${img('star', 34)}Final Chaos</span>${finalCategoryChip(f)}</div>
      ${ring(170, { cls: 'fa-ring' })}
      <h1 class="question fa-card__q ${fit(f.question, [80, 120, 160])}">${f.question || ''}</h1>
      <div class="holly-ribbon fa-card__rib">Type your answer on any phone on your team. <strong>The last answer counts.</strong></div>
    </section>
    <div class="fc-status" data-read>
      <span class="fc-status__count"><strong>${answered} of ${n}</strong> teams answered</span>
      <span class="fc-status__note">${ic('eye-off', { size: 28 })}Answers and wagers stay secret until the reveal</span>
    </div>
    <ul class="fc-gifts fc-gifts--n${Math.min(n, 8)} fc-gifts--short" role="list" data-read>${f.submissions.map((x) => wagerGift(s, { ...x, max: 0 }, 'answer'))}</ul>
  </section>`;
  return view('final-answer', html, { key: 'final-answer', strip: false, surface: 'night', backdrop: NIGHT_BD, say: `Final question: ${f.question}` });
}
function finalCategoryChip(f) {
  const seg = segOf(CATEGORY_SEGMENT[f.category] ?? 0);
  return slotChip(seg, { text: f.categoryLabel });
}
function scrFinalReveal(s) {
  const f = s.final;
  const revealed = new Map(f.revealed.map((r) => [r.teamId, r]));
  const order = f.revealOrder.length ? f.revealOrder : s.teams.map((t) => t.id);
  const n = order.length;
  const rows = order.map((id, i) => {
    const tm = team(id);
    if (!tm) return '';
    const r = revealed.get(id);
    const current = f.current === id && !f.done;
    if (!r) {
      return h`<li class="fr-row is-hidden" data-key="${id}" style="${teamVar(tm)}">
        <div class="fr-team">${mas(tm, 56)}<span class="fr-team__name">${tm.name}</span></div>
        <div class="fr-answer"><span class="fr-wrapped">${present({ size: 'sm', color: colorOf(tm.color, '#D42A2A'), ribbon: '#EDB321', state: 'sealed' })}Still wrapped</span></div>
        <span class="fr-wager">?</span><span class="fr-result"></span><span class="fr-score"><span class="fr-score__n">${formatPoints(tm.score)}</span></span>
      </li>`;
    }
    const judged = r.judged;
    return h`<li data-tm="${id}" class="fr-row ${current ? 'is-current' : ''} ${judged ? (r.correct ? 'is-right' : 'is-wrong') : 'is-pending'}" data-key="${id}" style="${teamVar(tm)}" ${current ? raw('aria-current="true"') : ''}>
      <div class="fr-team">${mas(tm, current ? 72 : 56)}<span class="fr-team__name ${fit(tm.name, [13])}">${tm.name}</span></div>
      <div class="fr-answer"><span class="fr-note ${r.text ? '' : 'is-blank'}">${r.text || 'No answer'}</span></div>
      <span class="fr-wager"><span class="fr-wager__l">Wager</span>${formatPoints(r.wager)}</span>
      <span class="fr-result">${judged
        ? h`<span class="fr-mark ${r.correct ? 'is-yes' : 'is-no'}" role="img" aria-label="${r.correct ? 'Correct' : 'Not this time'}">${ic(r.correct ? 'check' : 'x', { size: 34, stroke: 3 })}</span><span class="fr-delta ${r.delta > 0 ? 'is-up' : r.delta < 0 ? 'is-down' : ''}">${r.delta ? formatDelta(r.delta) : '±0'}</span>`
        : h`<span class="fr-wait">Checking<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`}</span>
      <span class="fr-score"><span class="fr-score__n">${formatPoints(judged ? r.after : r.before)}</span></span>
    </li>`;
  });
  const shown = f.revealed.length;
  const html = h`<section class="scr scr--final scr--final-reveal fr--n${Math.min(n, 8)}">
    <section class="gift-tag fr-q" data-read>
      <div class="fr-q__text"><span class="fr-q__label">${img('star', 34)}Final question · ${f.categoryLabel}</span><p class="fr-q__q ${fit(f.question, [90, 140])}">${f.question || ''}</p></div>
      <div class="fr-q__side">${f.answer
        ? h`<span class="fr-q__side-label">The answer</span><span class="fr-q__answer ${fit(f.answer, [16, 26])}">${f.answer}</span>`
        : h`<span class="fr-q__side-label">Unwrapping</span><span class="fr-q__n">${shown} of ${n}</span><span class="fr-q__side-sub">lowest score first</span>`}</div>
    </section>
    <ol class="fr-rows" role="list" aria-label="Final answers, revealed from lowest score to highest" data-read>${rows}</ol>
    ${quipBox(s, 'final-reveal', { cls: 'quip-slot--fr', tail: 'left' })}
  </section>`;
  const cur = f.revealed.find((r) => r.teamId === f.current);
  const say = cur ? `${team(cur.teamId)?.name} wagered ${cur.wager}. Their answer: ${cur.text || 'no answer'}.${cur.judged ? (cur.correct ? ' Correct!' : ' Not this time.') : ''}` : 'Final reveal.';
  return view('final-reveal', html, { key: 'final-reveal', strip: false, surface: 'night', backdrop: NIGHT_BD, say });
}

/* ---------- podium + the funny awards ceremony ---------- */
const AWARD_FALLBACK_ART = { fastestFinger: 'zap', starPerformer: 'masks', lumpOfCoal: 'snowman', grinchOfTheYear: 'money', silentNight: 'moon', comebackKid: 'sled', rudolph: 'deer' };
const CEREMONY = AWARD_CEREMONY; // shared with the phones, so nobody's phone spoils an award before the TV reveals it
function ceremonyStep(n) {
  const cm = ui.ceremony;
  if (!cm || cm.done || !n) return { i: n, phase: 'done' };
  const t = performance.now() - cm.t0 - CEREMONY.lead;
  if (t < 0) return { i: -1, phase: 'podium' };
  const i = Math.floor(t / CEREMONY.each);
  if (i >= n) return { i: n, phase: 'done' };
  return { i, phase: t - i * CEREMONY.each < CEREMONY.drum ? 'drum' : 'reveal' };
}
/** Every team that shares an award (a tie lists them all in teamIds; teamId is only set for a single team). */
function awardTeamIds(a) {
  return Array.isArray(a?.teamIds) && a.teamIds.length ? a.teamIds : a?.teamId ? [a.teamId] : [];
}
function awardTag(a, cls = '') {
  const ids = awardTeamIds(a);
  const tm = ids.length === 1 ? team(ids[0]) : null;
  return h`<div class="gift-tag gift-tag--md award-tag ${a.key === 'lumpOfCoal' ? 'is-coal' : ''} ${cls}" data-key="aw:${a.key}" style="${tm ? teamVar(tm) : ''}">
    ${img(a.art || AWARD_FALLBACK_ART[a.key] || 'trophy', 64, 'award-tag__art')}
    <div class="award-tag__text"><span class="award-tag__title">${a.title}</span><span class="award-tag__who">${a.name}</span>${a.detail ? h`<span class="award-tag__detail">${a.detail}</span>` : ''}</div>
  </div>`;
}
function scrPodium(s) {
  const p = s.podium;
  const st = (p.standings || []).slice().sort((a, b) => a.place - b.place || b.score - a.score);
  const blocks = st.length >= 3 ? [st[1], st[0], st[2]] : st.length === 2 ? [st[1], st[0]] : st.slice(0, 1);
  const winners = st.filter((x) => x.place === 1).map((x) => team(x.teamId)?.name).filter(Boolean);
  const title = winners.length > 1 ? `${listJoin(winners, 'and')} share Christmas!` : `${winners[0] || ''} ${verb(winners[0], 'wins', 'win')} Christmas!`;
  const rest = st.slice(3);
  const awards = p.awards || [];
  const step = ceremonyStep(awards.length);
  const cur = step.i >= 0 && step.i < awards.length ? awards[step.i] : null;
  const shownAwards = awards.slice(0, step.phase === 'done' ? awards.length : Math.max(0, step.i));
  const ceremony = awards.length && step.phase !== 'podium';
  const html = h`<section class="scr scr--podium ${ceremony ? 'is-ceremony' : ''} ${step.phase === 'done' ? 'is-done' : ''}">
    <h1 class="podium-title ${fit(title, [26, 40])}" data-read>${title}</h1>
    <div class="podium">
      ${blocks.some((x) => team(x.teamId)?.mascot === 'santa') ? '' : img('santa', 250, 'podium-santa')}
      <div class="podium-blocks podium-blocks--n${blocks.length}">
        ${blocks.map((x) => {
          const tm = team(x.teamId);
          if (!tm) return '';
          const pl = Math.min(x.place, 3);
          return h`<div class="podium-col podium-col--${pl}" data-key="${x.teamId}" data-tm="${x.teamId}" style="${teamVar(tm)}">
            ${pl === 1 ? img('trophy', 110, 'podium-col__trophy') : ''}
            ${mas(tm, pl === 1 ? 190 : 140, 'podium-col__mascot')}
            <div class="podium-box"><span class="podium-box__bow" aria-hidden="true"></span><span class="podium-box__tag">${img(`medal${pl}`, 64)}<span class="podium-box__text"><span class="podium-box__name">${tm.name}</span><span class="podium-box__score">${formatPoints(x.score)}</span></span></span></div>
          </div>`;
        })}
      </div>
      ${rest.length ? h`<div class="podium-rest">${rest.map((x) => h`<span class="podium-rest__item">${ordinal(x.place)} ${mas(team(x.teamId), 36)}${team(x.teamId)?.name || ''} <strong>${formatPoints(x.score)}</strong></span>`)}</div>` : ''}
    </div>
    ${awards.length ? h`<aside class="awards" aria-label="The funny awards">
      <span class="awards__eyebrow">${img('trophy', 44)}The North Pole awards</span>
      ${cur && step.phase !== 'done'
        ? h`<div class="award-stage is-${step.phase}" data-key="stage:${cur.key}:${step.phase}">
            <span class="award-stage__title">The ${cur.title.replace(/^The\s+/i, '')}${/award$/i.test(cur.title) ? '' : ' award'} goes to…</span>
            ${step.phase === 'drum'
              ? h`<span class="award-stage__drum">${present({ size: 'md', color: '#D42A2A', ribbon: '#EDB321', className: 'award-stage__gift' })}</span>`
              : h`<div class="award-stage__reveal">${img(cur.art || AWARD_FALLBACK_ART[cur.key] || 'trophy', 130, 'award-stage__art')}<span class="award-stage__who ${fit(cur.name, [12, 20])}">${cur.name}</span>${cur.detail ? h`<span class="award-stage__detail">${cur.detail}</span>` : ''}</div>`}
          </div>`
        : ''}
      <div class="awards__wall ${step.phase === 'done' ? 'is-all' : ''}">${shownAwards.map((a) => awardTag(a))}</div>
    </aside>` : ''}
    ${step.phase === 'done' || !awards.length ? quipBox(s, 'podium', { cls: 'quip-slot--podium', tail: 'left' }) : ''}
  </section>`;
  return view('podium', html, {
    key: 'podium', header: false, strip: false, say: `${title} Thanks for playing Christmas Chaos!`,
    backdrop: raw(`${snowbank({ className: 'podium-bank' })}`),
  });
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
      return h`<li class="tv-steps__step ${st}"><span class="tv-steps__n">${n < step ? ic('check', { size: 20, stroke: 3 }) : n}</span>${label}</li>`;
    })}</ol>`;
  } else {
    const done = s.phase === 'roundBreak';
    center = h`<span class="pill tv-round" aria-label="Round ${s.round} of ${s.totalRounds}">Round ${s.round} of ${s.totalRounds} ${turnDots(done ? s.turnsPerRound : s.turnIndex, s.turnsPerRound, { label: false })}</span>`;
  }
  return h`<span class="wordmark tv-wordmark">${img('tree', 64)}Christmas Chaos</span>
    <div class="tv-top__center">${center}</div>
    <span class="tv-join">Join at <strong>${joinHost(s.joinUrl)}</strong></span>`;
}

function tileState(t, s, mode) {
  const c = s.challenge;
  if (mode === 'steal' && c?.buzz) {
    const b = c.buzz;
    if (b.winner?.teamId === t.id) return { cls: 'is-buzzed', tag: 'Buzzed first!', tagCls: 'tag-team' };
    if (t.id === s.activeTeamId) return { cls: 'is-out', tag: 'Had a go', tagCls: 'tag-soft' };
    if ((b.lockedTeamIds || []).includes(t.id)) return { cls: 'is-out', tag: 'Locked out', tagCls: 'tag-soft' };
    if ((b.eligibleTeamIds || []).includes(t.id)) return { cls: 'is-steal', tag: 'Can steal', tagCls: 'tag-ember' };
    return { cls: '' };
  }
  if (mode === 'rival' && c?.rival?.teamId === t.id) return { cls: 'is-rival', tag: 'Rival', tagCls: 'tag-ice' };
  if (t.id === s.activeTeamId) return { cls: 'is-active', tag: 'Up now', tagCls: '' };
  return { cls: '' };
}

function stripHTML(s, mode) {
  const lead = leaders(s);
  return h`${s.teams.map((t) => {
    const st = tileState(t, s, mode);
    return h`<div class="score-tag ${st.cls}" data-key="${t.id}" data-team="${t.id}" style="${teamVar(t)}">
      ${st.tag ? h`<span class="up-now score-tag__upnow ${st.tagCls}">${st.tag}</span>` : ''}
      ${lead.has(t.id) ? img('glowing-star', 52, 'score-tag__lead', 'Leader') : ''}
      ${t.multiplier > 1 ? h`<span class="score-tag__badge" role="img" aria-label="Points doubled this turn">×2</span>` : ''}
      ${mas(t, 64, `score-tag__mascot ${t.playerCount && !t.connectedCount ? 'is-offline' : ''}`)}
      <span class="score-tag__name">${t.name}</span>
      <span class="score-tag__pts"><span class="score-num" data-score="${t.id}" data-value="${t.score}" data-morph-skip>${formatPoints(t.score)}</span></span>
    </div>`;
  })}`;
}

function updateScores() {
  for (const el of stripTags.querySelectorAll('[data-score]')) {
    const t = team(el.dataset.score);
    if (!t || ui.pendingFly.get(t.id)) continue;
    if (Number(el.dataset.value) !== t.score) {
      animateNumber(el, t.score, { duration: 900 });
      bump(el.closest('.score-tag'));
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
  wheel = createWheel($('#wheel'), s.segments, { label: 'The prize wheel', lights });
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
      tease: hash100(s.spin.startedAt) < 25, // COMEDY.md: ~1 spin in 4 creeps, hangs on the peg, then tips in
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
  morph(stripTags, stripHTML(S, v.stripMode));
  updateScores();

  if (fresh) {
    // Park the wheel first so replacing the stage never destroys it.
    if (wheelHost.parentElement !== park) park.appendChild(wheelHost);
    stage.innerHTML = String(v.html);
    const bd = String(v.backdrop || '');
    if (backdrop.dataset.src !== bd) {
      backdrop.innerHTML = bd;
      backdrop.dataset.src = bd;
    }
    stage.classList.remove('is-entering');
    void stage.offsetWidth;
    stage.classList.add('is-entering');
    // once the entrance has played, drop its fill so state classes (ceremony moves, fades) own the elements
    clearTimeout(ui.enterTimer);
    ui.enterTimer = setTimeout(() => stage.classList.remove('is-entering'), 1100);
    ui.screenKey = v.key;
    ui.screenName = v.name;
    if (v.say) announce(v.say);
    refreshSnow();
  } else {
    morph(stage, v.html);
  }
  applyWheel(v, S);
  if (fresh && v.lights) lights.mode(v.lights);
  tick();
  if (fresh && ui.live && v.enter) {
    try {
      v.enter();
    } catch (e) {
      console.error(e);
    }
  }
}

/** The snow keeps out of every column with something to read (re-measured after the entrance animations). */
function refreshSnow() {
  snow.refresh();
  clearTimeout(ui.snowTimer);
  ui.snowTimer = setTimeout(() => snow.refresh(), 700);
}

function announce(text) {
  live.textContent = '';
  setTimeout(() => {
    live.textContent = text;
  }, 60);
}

/* =========================================================================== ticker ========= */

const RING_C = 339.3;
function updateRing(host, t, n) {
  const el = host.querySelector('.timer-ring');
  if (!el) return;
  const arc = el.querySelector('.timer-ring__arc');
  const head = el.querySelector('.timer-ring__head');
  const num = el.querySelector('.timer-ring__num');
  const unitEl = el.querySelector('.timer-ring__unit');
  let frac = 0;
  let secs = 0;
  let unit = host.dataset.unit || 'seconds';
  let state = 'run';
  if (!t) {
    state = 'idle';
    unit = '';
  } else if (!t.started) {
    frac = 1;
    secs = Math.ceil(t.durationMs / 1000);
    state = 'ready';
    unit = 'ready';
  } else {
    const left = timerRemaining(t, n);
    frac = t.durationMs > 0 ? Math.min(1, left / t.durationMs) : 0;
    secs = Math.ceil(left / 1000);
    if (left <= 0) {
      state = 'over';
      unit = 'time’s up';
    } else if (!t.running) {
      state = 'paused';
      unit = 'paused';
    }
  }
  const text = state === 'idle' ? '–' : secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : String(secs);
  if (num && num.textContent !== text) num.textContent = text;
  if (unitEl && unitEl.textContent !== unit) unitEl.textContent = unit;
  arc?.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(1));
  if (head) head.style.transform = `rotate(${(360 * frac).toFixed(1)}deg)`;
  el.classList.toggle('is-warn', state === 'run' && secs > 0 && secs <= 5);
  el.classList.toggle('is-paused', state === 'paused');
  el.classList.toggle('is-ready', state === 'ready');
  el.classList.toggle('is-over', state === 'over');
  el.setAttribute('aria-label', state === 'ready' ? `${secs} seconds, waiting to start` : `${secs} seconds left`);
}

function tick() {
  if (!S) return;
  const n = now();
  const t = S.timer;
  for (const host of document.querySelectorAll('[data-ring]')) updateRing(host, t, n);
  // the steal countdown: three ornaments light 3-2-1
  for (const el of document.querySelectorAll('[data-arm]')) {
    const left = Math.ceil((Number(el.dataset.arm) - n) / 1000);
    for (const o of el.querySelectorAll('.arm-orn')) {
      const k = Number(o.dataset.n);
      o.classList.toggle('is-lit', left <= k);
      o.classList.toggle('is-now', left === k);
    }
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
  // the lobby gift tag rotates its funny line
  if (S.phase === 'lobby') {
    const qid = S.quip?.key === 'lobbyIdle' ? S.quip.id : null;
    if (qid !== ui.lobby.qid) ui.lobby = { qid, t0: performance.now(), idx: -1 };
    const idx = Math.floor((performance.now() - ui.lobby.t0) / 9000);
    if (idx !== ui.lobby.idx) {
      ui.lobby.idx = idx;
      render();
    }
  }
  // the podium awards ceremony advances on its own clock
  if (S.phase === 'podium' && ui.ceremony && !ui.ceremony.done) {
    const st = ceremonyStep(S.podium?.awards?.length || 0);
    const key = `${st.i}:${st.phase}`;
    if (key !== ui.ceremony.step) {
      ui.ceremony.step = key;
      if (st.phase === 'drum') play('drumroll', CEREMONY.drum - 150, { crash: false });
      if (st.phase === 'reveal') {
        play('cymbal');
        const a = S.podium.awards[st.i];
        later(120, () => a?.key === 'lumpOfCoal' ? (play('slideWhistle'), fx.coalDrop(stage.querySelector('.award-stage'))) : fx.confetti({ count: 50, snow: 0.3, duration: 1800 }));
        // the winning team(s) react on the podium (a shared award bounces every team in it)
        later(260, () => {
          for (const id of awardTeamIds(a)) {
            const m = stage.querySelector(`.podium-col[data-tm="${CSS.escape(id)}"] .podium-col__mascot`);
            if (a?.key === 'lumpOfCoal') droopEl(m);
            else bounceEl(m);
          }
        });
      }
      if (st.phase === 'done') {
        ui.ceremony.done = true;
        play('applause', 2600);
      }
      render();
    }
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
    const tile = stripTags.querySelector(`[data-team="${CSS.escape(a.teamId)}"]`);
    if (!visible || !tile || !a.delta || Math.abs(a.delta) <= 50) {
      ui.pendingFly.delete(a.teamId);
      return;
    }
    const from = stage.querySelector('[data-fly-from]') || stage;
    const A = app.getBoundingClientRect();
    const scale = A.width / 1920;
    const F = from.getBoundingClientRect();
    const T = tile.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `points-pop tv-fly ${a.delta < 0 ? 'points-pop--down' : ''}`;
    el.textContent = formatDelta(a.delta);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `${formatDelta(a.delta)} points to ${team(a.teamId)?.name || ''}`);
    flyLayer.appendChild(el);
    const x0 = (F.left - A.left + F.width * (from === stage ? 0.5 : 0.72)) / scale;
    const y0 = (F.top - A.top + F.height * (from === stage ? 0.45 : 0.4)) / scale;
    const x1 = (T.left - A.left + T.width * 0.62) / scale;
    const y1 = (T.top - A.top + T.height * 0.5) / scale;
    el.style.left = `${x0 / 16}rem`;
    el.style.top = `${y0 / 16}rem`;
    const dx = (x1 - x0) / 16;
    const dy = (y1 - y0) / 16;
    const anim = el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4) rotate(0deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.15) rotate(-7deg)', opacity: 1, offset: 0.18 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(-7deg)', opacity: 1, offset: 0.42 },
        { transform: `translate(calc(-50% + ${dx * 0.86}rem), calc(-50% + ${dy * 0.86}rem)) scale(0.55) rotate(-2deg)`, opacity: 1, offset: 0.9 },
        { transform: `translate(calc(-50% + ${dx}rem), calc(-50% + ${dy}rem)) scale(0.42) rotate(0deg)`, opacity: 0 },
      ],
      { duration: 1600, delay: 500 + k * 220, easing: 'cubic-bezier(0.5, 0, 0.3, 1)', fill: 'both' }
    );
    anim.finished
      .catch(() => {})
      .then(() => {
        el.remove();
        const left = (ui.pendingFly.get(a.teamId) || 1) - 1;
        if (left <= 0) ui.pendingFly.delete(a.teamId);
        else ui.pendingFly.set(a.teamId, left);
        updateScores();
        if (a.delta > 0) bounceEl(tile.querySelector('.score-tag__mascot'));
      });
  });
  updateScores();
}

/* =========================================================================== state ========== */

function onState(next) {
  const prev = S;
  const awards = newAwards(prev, next);
  if (prev) {
    const c = next.challenge;
    const pc = prev.challenge;
    // Hold the "it landed on…" moment (present unwraps + land quip) and the "Sam picked Medium" moment for a beat.
    if (prev.phase === 'spinning' && (next.phase === 'challenge' || next.phase === 'turnResult') && c && c.type !== 'doubledown') {
      // timerAtLand: All Play's clock starts on landing; any OTHER clock starting means the host got going: show it now
      ui.hold = { kind: 'landed', id: c.id, until: performance.now() + 3800, timerAtLand: !!next.timer?.started };
    } else if (c && pc && c.id === pc.id && c.type === 'trivia' && pc.stage === 'pickDifficulty' && c.stage === 'question') {
      ui.hold = { kind: 'picked', id: c.id, until: performance.now() + 2600 };
    } else if (ui.hold && (!c || c.id !== ui.hold.id)) {
      ui.hold = null;
    }
    if (ui.hold?.kind === 'landed' && c && !['pickDifficulty', 'perform', 'pickRival', 'pickTarget', 'hotseat', 'list', 'answering', 'done'].includes(c.stage)) ui.hold = null;
    if (ui.hold?.kind === 'landed' && !ui.hold.timerAtLand && next.timer?.started) ui.hold = null; // the host started the clock: no stale 'it landed on' screen
    if (next.phase === 'podium' && prev.phase !== 'podium') ui.ceremony = { t0: performance.now(), done: false, step: '' };
  } else {
    for (const r of next.final?.revealed || []) if (r.judged) ui.judgedRows.add(r.teamId);
    ui.dareResultFor = next.challenge?.dareResult ? next.challenge.id : null;
    if (next.phase === 'podium') ui.ceremony = { t0: 0, done: true, step: 'done' }; // a refreshed TV shows the finished ceremony
  }
  if (next.phase !== 'podium') ui.ceremony = null;
  S = next;
  // Teams whose points are about to fly: hold their counters until the gift tag lands.
  const flying = awards.filter((a) => a.delta);
  for (const a of flying) ui.pendingFly.set(a.teamId, (ui.pendingFly.get(a.teamId) || 0) + 1);
  render();
  if (prev) stateSounds(prev, next); // after render: the gags animate the new screen
  ui.live = true;
  if (flying.length) launchFlights(flying);
}

/** Sounds and gags that come from state changes rather than fx (dare verdicts, final reveal judgements). */
function stateSounds(prev, next) {
  const c = next.challenge;
  if (c?.type === 'dare' && c.dareResult && ui.dareResultFor !== c.id) {
    ui.dareResultFor = c.id;
    const r = c.dareResult.result;
    if (r === 'nailed') gag('dareNailed');
    else if (r === 'valiant') gag('dareValiant');
    else gag('dareFail');
  }
  for (const r of next.final?.revealed || []) {
    if (r.judged && !ui.judgedRows.has(r.teamId)) {
      ui.judgedRows.add(r.teamId);
      play('cymbal');
      later(160, () => {
        const row = stage.querySelector(`.fr-row[data-key="${CSS.escape(r.teamId)}"] .fr-team img`);
        if (r.correct) { play('correct'); bounceEl(row); } else { play('slideWhistle'); droopEl(row); }
      });
    }
  }
  if (next.final && prev.final) {
    for (const w of next.final.wagers || []) {
      const was = prev.final.wagers?.find((x) => x.teamId === w.teamId);
      if (w.locked && was && !was.locked) play('dingLock');
    }
  }
  if (next.phase === 'lobby' && prev.phase !== 'lobby') {
    ui.judgedRows.clear();
    ui.seenAwards.clear();
    for (const a of next.lastAwards || []) ui.seenAwards.add(a.id);
  }
}

/* =========================================================================== sound + gags === */

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
function later(ms, fn) {
  setTimeout(() => {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }, ms);
}
const safe = (p) => Promise.resolve(p).catch(() => false);
function bounceEl(el) {
  if (el) safe(fx.bounce(el));
}
function droopEl(el) {
  if (el) safe(fx.droop(el));
}
/** Run a gag once per moment: the server's fx + react cues can both ask for it within a second. */
function gagOnce(name, fn, windowMs = 1800) {
  const t = performance.now();
  if (t - (ui.gagAt.get(name) || -1e9) < windowMs) return false;
  ui.gagAt.set(name, t);
  try {
    fn();
  } catch (e) {
    console.error(e);
  }
  return true;
}
/** The team's mascots on screen right now (score tag + any big mascot for that team). */
function teamMascots(teamId) {
  if (!teamId) return [];
  const id = CSS.escape(teamId);
  return [...stripTags.querySelectorAll(`[data-team="${id}"] .score-tag__mascot`), ...stage.querySelectorAll(`[data-tm="${id}"] .mascot-img`)];
}
const card = () => stage.querySelector('.result-card, .steal-card, .qcard, .dare-card, .rl-card, .hs-card, .sd-card, .ap-card, .gift-tag, .candy-frame');

/** Every comedy moment (COMEDY.md §3–4): one gag + its sound, ≤ 2.5 s, never blocking. */
function gag(name, o = {}) {
  if (!ui.live) return;
  const tid = o.teamId || S?.activeTeamId;
  const G = {
    correct: () => { play('sleighRun'); lights.blink('#1F9D57', 3); safe(fx.dash('deer', { y: 0.46 })); later(300, () => teamMascots(tid).forEach(bounceEl)); },
    // the coal lands on the card's top edge and the snowball hits its top-right corner: never on the words being read
    wrong: () => { play('slideWhistle'); safe(fx.coalDrop(card(), { at: [0.86, 0.02] })); later(200, () => teamMascots(tid).forEach(droopEl)); },
    timeUp: () => { play('sadTrombone'); meltTimer(); later(300, () => teamMascots(tid).forEach(droopEl)); },
    stealWon: () => {
      play('kaChing');
      const tag = stripTags.querySelector(`[data-team="${CSS.escape(tid || '')}"]`);
      safe(fx.sneak(mascotFor(team(tid)?.mascot).art, { from: tag || card() }));
      lights.flash(2);
    },
    splat: () => { play('splat'); safe(fx.splat(card(), { at: [0.86, 0.16] })); later(250, () => teamMascots(tid).forEach(droopEl)); },
    groan: () => { play('sadTrombone'); teamMascots(tid).forEach(droopEl); },
    dareNailed: () => { play('correct'); play('applause', 2400); safe(fx.confetti({ count: 80, snow: 0.35 })); teamMascots(tid).forEach(bounceEl); },
    dareValiant: () => { play('boing'); play('applause', 1300); teamMascots(tid).forEach(bounceEl); },
    dareFail: () => { play('hoHoHo'); teamMascots(tid).forEach(droopEl); later(500, () => safe(fx.peek('santa', 'bottom-right', { say: 'Ho ho ho!' }))); },
    cheer: () => { play('boing'); teamMascots(tid).forEach(bounceEl); },
    big: () => { play('sleighRun'); safe(fx.confetti({ count: 70, snow: 0.4 })); teamMascots(tid).forEach(bounceEl); },
    gasp: () => { play('crowdOoh', 1400); safe(fx.shake(card())); },
    laugh: () => { play('hoHoHo'); safe(fx.peek('santa', 'bottom-right', { say: 'Ho ho ho!' })); },
    peekDeer: () => { play('boing'); safe(fx.peek('deer', 'bottom-right', { say: 'Really?' })); },
    peekUndo: () => { play('hoHoHo'); safe(fx.peek('santa', 'bottom-left', { say: 'Rewind!' })); },
    grinchSteal: () => { play('kaChing'); safe(fx.sneak('money', { from: stage.querySelector('.is-victim') || card() })); },
    heartGrow: () => { play('boing'); safe(fx.heartGrow(stage.querySelector('.is-giver') || card())); },
  };
  const fn = G[name];
  if (!fn) return;
  // correct / wrong cousins share one slot so fx + react never double up
  const slot = { stealWon: 'judge', splat: 'judge', correct: 'judge', wrong: 'judge', timeUp: 'judge', groan: 'judge' }[name] || name;
  gagOnce(slot, fn);
}
/** Time's up: the ornament melts (the current one, or a stand-in where the steal card now is). */
function meltTimer() {
  let el = stage.querySelector('[data-ring] .timer-ring');
  if (!el) {
    const slot = stage.querySelector('.melt-slot');
    if (slot) {
      slot.innerHTML = String(timerRing({ running: false, remainingMs: 0, durationMs: 1000, started: true }, now(), { size: 140, unit: 'time’s up' }));
      el = slot.querySelector('.timer-ring');
      later(2600, () => { slot.innerHTML = ''; });
    }
  }
  if (el) safe(fx.melt(el));
}

/** The server's comedy cue {type:'react', mood, key, teamId} -> the matching gag (COMEDY.md §2–4). */
const REACT_BY_KEY = {
  correct: 'correct', correctHard: 'correct', wrong: 'wrong', wrongEasy: 'wrong', timeUp: 'timeUp',
  stealWon: 'stealWon', stealMissed: 'splat', nobodyBuzzed: 'groan',
  dareNailed: 'dareNailed', dareValiant: 'dareValiant', dareFail: 'dareFail',
  showdownWin: 'big', showdownTie: 'cheer', hotseatPerfect: 'big', hotseatZero: 'groan', listBig: 'big', listSmall: 'groan',
  grinchSteal: 'grinchSteal', grinchGift: 'heartGrow', doubleDown: 'cheer', leadChange: 'gasp', bigComeback: 'big', lastPlaceCheer: 'cheer',
  finalAllIn: 'gasp', finalZeroBet: 'laugh', finalCorrect: 'cheer', finalWrong: 'groan', podium: 'none', undo: 'peekUndo',
  pickEasy: 'peekDeer', pickHard: 'gasp', voteClose: 'gasp',
};
const REACT_BY_MOOD = { cheer: 'cheer', groan: 'groan', gasp: 'gasp', laugh: 'laugh' };
function onReact(p) {
  const name = REACT_BY_KEY[p.key] || REACT_BY_MOOD[p.mood];
  if (name) gag(name, { teamId: p.teamId });
}

function onFx(type, p = {}) {
  switch (type) {
    case 'spinStart':
      play('whoosh', 500);
      break;
    case 'land':
      play(p.segmentType === 'doubledown' ? 'doubleDown' : 'land');
      break;
    case 'buzz':
      play('buzz');
      later(120, () => bounceEl(stage.querySelector('.steal-buzzed__mascot')));
      break;
    case 'armed':
      play('sleighBells', 700);
      later(60, () => safe(fx.wobble(stage.querySelector('.steal-bell'))));
      break;
    case 'correct':
      if (p.small) { play('correct'); break; }
      if (p.steal) gag('stealWon', { teamId: p.teamId });
      else { play('correct'); gag('correct', { teamId: p.teamId }); }
      break;
    case 'wrong':
      if (p.small) { play('wrong'); break; }
      if (p.timeUp) gag('timeUp', { teamId: p.teamId });
      else if (p.steal) gag('splat', { teamId: p.teamId });
      else gag('wrong', { teamId: p.teamId });
      break;
    case 'timerEnd':
      play('beep', true);
      break;
    case 'vote':
      if (p.opened) play('whoosh', 500);
      else if (p.closed) play('applause', 2400);
      else play('sleighBells', 380);
      break;
    case 'steal':
      gag('grinchSteal', { teamId: p.to });
      break;
    case 'roundBreak':
      play('sleighBells', 1200);
      break;
    case 'turn':
      play('whoosh', 450);
      break;
    case 'doubleDown':
      break;
    case 'final':
      play('drumroll', 1400);
      later(1500, () => play('fanfare'));
      break;
    case 'reveal':
      if (p.teamId) play('drumroll', 1500, { crash: false });
      else play('drumroll', 700);
      break;
    case 'podium':
      play('podium');
      later(400, () => safe(fx.confetti({ count: 120, snow: 0.4 })));
      later(1800, () => play('applause', 3000));
      break;
    case 'calledUp':
      play('beep', false);
      break;
    case 'joined':
      play('boing');
      break;
    case 'answered':
      play('dingLock');
      break;
    case 'wagered':
      play('tick');
      break;
    case 'react':
      onReact(p);
      break;
    case 'soundTest':
      play('fanfare');
      break;
    default:
      break;
  }
}

/* =========================================================================== start / mute === */

$('#startMark').innerHTML = String(img('tree', 120));
$('#bootMark').innerHTML = String(img('tree', 150));

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
  play('sleighBells', 900);
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
  muteBtn.innerHTML = String(ic(muted ? 'volume-x' : 'volume-2', { size: 28 }));
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

// Fonts change text widths: re-measure the snow lanes and the garland once they are in.
document.fonts?.ready?.then(() => {
  refreshSnow();
  lights.refresh();
});

/* =========================================================================== go ============= */

client.onState(onState);
client.onFx(onFx);
window.__tv = {
  get state() { return S; },
  get screen() { return ui.screenName; },
  render,
  /** Test hook: draw an arbitrary publicView (visual checks of long copy / edge cases). */
  inject: (s) => onState(s),
  fx: onFx,
};
