// Christmas Chaos — host.js
// The host control room: PIN login for second devices, lobby setup, and the in-game coach panel with every
// persistent tool (scores, undo, timer, "More" menu), the private answer card and stage-specific tables.
//
// Rendering: the server pushes a role-filtered `state` after every change. render() rebuilds each region's
// markup with h`` (escaped by default) and only touches the DOM when a region's markup actually changed, so
// inputs, focus and the mirror wheel survive unrelated pushes. Colours that come from data (team / slot
// colours) are applied as CSS custom properties from data-* attributes — no inline styles in markup.

import {
  connect, h, raw, esc, toast, ic, disc, turnDots, formatPoints, formatDelta, plural, possessive,
  ordinal, listJoin, timerRemaining, timerFraction, timerWarn, timerRing, updateTimerRing,
} from '/assets/client.js';
import { MASCOTS, mascotFor, safeColor, hasIcon } from '/assets/icons.js';
import { createWheel } from '/assets/wheel.js';
import * as sound from '/assets/sound.js';

/* ============================================================================ storage & connection */

const KEY_STORE = 'cc.hostKey';
const ALERTS_STORE = 'cc.hostAlerts';
const lsGet = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
const lsSet = (k, v) => { try { globalThis.localStorage?.setItem(k, v); } catch { /* private mode */ } };
const lsDel = (k) => { try { globalThis.localStorage?.removeItem(k); } catch { /* private mode */ } };
const readKey = () => { const v = lsGet(KEY_STORE); return v && /^\d{4,12}$/.test(v) ? v : null; };

const client = connect('host', { hostKey: () => readKey() });

/* ============================================================================ local UI state */

const ui = {
  modal: null,              // {type:'confirm'|'script'|'player'|'team'|'more', ...}
  dockOpen: false,
  privateRevealed: false,
  privateKey: '',
  mascot: null,             // selected mascot in the add-team form
  justSignedIn: false,
  signedInAt: 0,
  remote: false,            // signed in with a PIN/key (not the laptop running the server)
  alerts: lsGet(ALERTS_STORE) === '1',
  bump: {},                 // teamId -> until (score bump animation)
  lastHeadline: '',
};
const login = { digits: '', error: '', code: null, retryUntil: 0, busy: false, shake: 0 };
const inflight = new Set();
let mode = null;            // 'login' | 'signedIn' | 'lobby' | 'game'
let shortcuts = new Map();  // key -> () => void
let mirrorWheel = null;
let mirrorWheelKey = '';

/* ============================================================================ small helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const teamOf = (s, id) => (s.teams || []).find((t) => t.id === id) || null;
const teamName = (s, id) => teamOf(s, id)?.name || 'a team';
const segOf = (s, i) => (i != null && s.segments ? s.segments[i] : null);
const fmt = formatPoints;
const signed = formatDelta;
const cap = (x) => (x ? String(x).charAt(0).toUpperCase() + String(x).slice(1) : '');
const playerOf = (s, id) => (s.players || []).find((p) => p.id === id) || null;
const json = (v) => JSON.stringify(v ?? null);

/** "0:18" (whole seconds, rounded up). */
function mmss(ms) {
  const sec = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
/** 5800 -> "5.8 s" */
const secsText = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} s`;

function clockTime(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}

/** data-* attribute that becomes --team-color after rendering. */
const tc = (team) => raw(`data-team-color="${safeColor(team?.color, '#FF5A4E')}"`);
/** data-* attributes that become --slot-color / --slot-ink. */
const sc = (seg) => raw(`data-slot-color="${safeColor(seg?.color, '#1B4636')}" data-slot-ink="${safeColor(seg?.ink, '#FFF6E5')}"`);
const isCream = (c) => String(c || '').toUpperCase() === '#FFF6E5';
/** Icons the server names that icons.js does not ship (segment 4 says 'popcorn'). */
const ICON_FALLBACK = { popcorn: 'film' };
const segIcon = (name) => (name && hasIcon(name) ? name : ICON_FALLBACK[name] || 'sparkles');
const wheelSegments = (segs) => (segs || []).map((g) => ({ ...g, icon: segIcon(g.icon) }));

/**
 * Server workaround: the coach dry-runs every action through game.check(), but host:resume / host:discardSave
 * are server-level events, so they come back disabled with reason 'unknown-event' even though a save is offered.
 * Re-enable them (only while state.savedGame exists) and re-pick the primary action.
 */
const SERVER_LEVEL = new Set(['host:resume', 'host:discardSave']);
function normalizeCoach(s) {
  const C = s?.host?.coach;
  if (!C || C.__norm) return C;
  for (const a of C.actions || []) {
    if (a.disabled && a.reason === 'unknown-event' && SERVER_LEVEL.has(a.event) && s.savedGame) { delete a.disabled; delete a.reason; }
  }
  if (!C.primary || !(C.actions || []).some((a) => a.id === C.primary && !a.disabled)) {
    const p = (C.actions || []).find((a) => a.kind === 'primary' && !a.disabled);
    C.primary = p ? p.id : null;
  }
  C.__norm = true;
  return C;
}

const ERRORS = {
  'not-now': 'That can’t be done right now — the game has moved on.',
  'stale-turn': 'The turn already moved on.',
  'stale-question': 'That question was already marked.',
  offline: 'You’re offline — reconnecting…',
  timeout: 'The game didn’t answer. Try again.',
  'name-required': 'Type a team name first.',
  'name-taken': 'Another team already has that name.',
  'mascot-taken': 'Another team already has that mascot.',
  'bad-mascot': 'Pick a mascot.',
  'too-many-teams': '8 teams is the maximum.',
  'need-two-teams': 'Add at least two teams first.',
  'nothing-to-undo': 'Nothing to undo.',
  'no-hint': 'This question has no hint.',
  'below-current-round': 'You can’t set fewer rounds than the round you’re in.',
  'bad-rounds': 'Rounds go from 1 to 8.',
  'not-host': 'This device isn’t signed in as host.',
  'already-ticked': 'Already ticked.',
  'no-answer': 'That team has no answer to mark.',
  'no-teams-left': 'Every team has had its try.',
  'no-players': 'That team has no players.',
  'no-secret': 'Nothing to swap.',
  'no-timer': 'There’s no timer right now.',
  'already-running': 'The timer is already running.',
  'slow-down': 'Easy there — one tap at a time.',
  'bad-ip': 'That address isn’t available any more.',
  'no-save': 'The saved game is gone.',
  'bad-save': 'The saved game couldn’t be loaded.',
  'ask-host': 'Move players with the host controls.',
};
const errorText = (code) => ERRORS[code] || `That didn’t work (${code || 'unknown error'}).`;

/* ============================================================================ emitting */

async function send(event, payload = null, { confirm, title, okLabel, tone } = {}) {
  if (confirm && !(await confirmDialog(confirm, { title, okLabel, tone }))) return null;
  const key = event + json(payload);
  if (inflight.has(key)) return null;
  inflight.add(key);
  try {
    const res = await client.emit(event, payload || {});
    if (!res.ok) toast(errorText(res.error), { tone: 'error' });
    return res;
  } finally {
    inflight.delete(key);
  }
}

function coachAction(id) {
  return client.state?.host?.coach?.actions?.find((a) => a.id === id) || null;
}

async function runAction(a) {
  if (!a) return;
  if (a.disabled) { toast(a.reason || 'Not available right now', { tone: 'info', icon: 'lock' }); return; }
  if (a.local === 'introScript') { openModal({ type: 'script' }); return; }
  if (!a.event) return;
  await send(a.event, a.payload, { confirm: a.confirm, title: a.label, okLabel: a.label, tone: a.kind === 'danger' ? 'danger' : 'primary' });
}

/* ============================================================================ confirm dialog & modals */

function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Yes, do it', tone = 'primary' } = {}) {
  return new Promise((resolve) => {
    if (ui.modal?.type === 'confirm') ui.modal.resolve?.(false);
    openModal({ type: 'confirm', message, title, okLabel, tone, resolve });
  });
}

let lastFocus = null;
function openModal(m) {
  if (!ui.modal) lastFocus = document.activeElement;
  ui.modal = m;
  renderModal(true);
}
function closeModal(result = false) {
  const m = ui.modal;
  if (!m) return;
  ui.modal = null;
  m.resolve?.(result);
  renderModal(true);
  try { lastFocus?.focus?.({ preventScroll: true }); } catch { /* gone */ }
}

/* ============================================================================ patching */

const painted = new WeakMap();
function patch(target, markup) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return false;
  const html = String(markup ?? '');
  if (painted.get(el) === html) return false;
  const active = document.activeElement;
  const key = active && el.contains(active) ? active.getAttribute('data-key') : null;
  el.innerHTML = html;
  painted.set(el, html);
  applyVars(el);
  if (key) {
    const again = [...el.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === key);
    try { again?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  return true;
}

function applyVars(root) {
  for (const n of root.querySelectorAll('[data-team-color]')) n.style.setProperty('--team-color', safeColor(n.dataset.teamColor, '#FF5A4E'));
  for (const n of root.querySelectorAll('[data-slot-color]')) {
    n.style.setProperty('--slot-color', safeColor(n.dataset.slotColor, '#1B4636'));
    n.style.setProperty('--slot-ink', safeColor(n.dataset.slotInk, '#FFF6E5'));
  }
  for (const n of root.querySelectorAll('[data-fill]')) n.style.setProperty('--fill', String(Math.max(0, Math.min(1, Number(n.dataset.fill) || 0))));
}

/* ============================================================================ skeletons */

function setMode(m) {
  if (mode === m) return;
  mode = m;
  const app = document.getElementById('app');
  app.dataset.mode = m;
  if (mirrorWheel) { mirrorWheel.destroy(); mirrorWheel = null; mirrorWheelKey = ''; }
  if (m === 'login' || m === 'signedIn') {
    app.innerHTML = '<div class="login-page" id="r-login"></div>';
  } else if (m === 'lobby') {
    app.innerHTML = `
      <header class="topbar" id="r-top"></header>
      <div class="layout layout--lobby">
        <main class="main" id="main">
          <section class="coach coach--wide" id="coach" aria-label="Live directions"></section>
          <div id="r-saved"></div>
          <div class="lobby">
            <div class="lobby__side" id="r-lobby-side"></div>
            <section class="panel teams" aria-labelledby="teams-h">
              <div class="teams__head" id="r-teams-head"></div>
              <form class="add-team" id="add-team" novalidate autocomplete="off">
                <div class="field add-team__name">
                  <label class="label" for="team-name">Team name</label>
                  <input class="input input--sm" id="team-name" name="name" maxlength="24" placeholder="e.g. The Sleigh Riders" enterkeyhint="done">
                </div>
                <fieldset class="add-team__mascots">
                  <legend class="label">Mascot &amp; colour</legend>
                  <div class="mascot-picker" id="r-mascots" role="radiogroup" aria-label="Mascot and colour"></div>
                </fieldset>
                <button class="btn btn--gold btn--md add-team__btn" type="submit" data-needs-online></button>
              </form>
              <div id="r-teams"></div>
            </section>
          </div>
        </main>
      </div>`;
    $('#add-team .add-team__btn').innerHTML = h`${ic('plus', { size: 20, stroke: 2.6 })}Add team`.html;
  } else {
    app.innerHTML = `
      <header class="topbar" id="r-top"></header>
      <div class="layout layout--game">
        <aside class="rail" id="r-rail" aria-label="Scores"></aside>
        <main class="main" id="main">
          <section class="coach" id="coach" aria-label="Live directions"></section>
          <div class="stage" id="r-stage"></div>
          <section class="mirror" id="r-mirror" aria-label="On the TV now"></section>
          <p class="keys" id="r-keys"></p>
        </main>
        <aside class="side" id="r-side" aria-label="Private host info"></aside>
      </div>
      <section class="dock" id="r-dock" aria-label="Scores"></section>`;
  }
}

/* ============================================================================ render */

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const s = client.state;
  const app = document.getElementById('app');
  if (!s) return;
  app.removeAttribute('aria-busy');
  if (s.needPin || !s.host) {
    setMode('login');
    patch('r-login', loginHtml(s));
    shortcuts = new Map();
    if (ui.modal) closeModal(false);
    return;
  }
  if (ui.justSignedIn) {
    setMode('signedIn');
    patch('r-login', signedInHtml(s));
    shortcuts = new Map([['Enter', () => leaveSignedIn()]]);
    return;
  }
  normalizeCoach(s);
  const m = s.phase === 'lobby' ? 'lobby' : 'game';
  const modeChanged = mode !== m;
  setMode(m);
  app.dataset.phase = s.phase;
  const stageKey = [s.phase, s.challenge?.id, s.challenge?.stage].join('|');
  if (modeChanged || (stageKey !== ui.stageKey && window.innerWidth < 1000 && ui.stageKey)) window.scrollTo(0, 0);
  ui.stageKey = stageKey;
  patch('r-top', topHtml(s));
  patch('coach', coachHtml(s));
  if (m === 'lobby') {
    patch('r-saved', savedGameHtml(s));
    patch('r-lobby-side', lobbySideHtml(s));
    patch('r-teams-head', teamsHeadHtml(s));
    patch('r-mascots', mascotPickerHtml(s));
    patch('r-teams', teamsListHtml(s));
    const form = $('#add-team');
    if (form) form.hidden = s.teams.length >= 8 || !s.host.can.createTeam;
  } else {
    syncPrivateKey(s);
    patch('r-rail', railHtml(s));
    patch('r-dock', dockHtml(s));
    patch('r-stage', stageHtml(s));
    patch('r-mirror', mirrorHtml(s));
    patch('r-side', sideHtml(s));
    patch('r-keys', keysHtml(s));
    syncMirrorWheel(s);
  }
  if (ui.modal) renderModal(false);
  buildShortcuts(s);
  announce(s);
  tick();
}

function announce(s) {
  const head = s.host?.coach?.headline || '';
  if (head && head !== ui.lastHeadline) {
    ui.lastHeadline = head;
    const live = document.getElementById('live');
    if (live) live.textContent = head;
  }
}

/* ============================================================================ login (second host device) */

function loginHtml(s) {
  const n = login.digits.length;
  const wait = Math.max(0, login.retryUntil - Date.now());
  const waiting = wait > 0;
  const boxes = [0, 1, 2, 3].map((i) => {
    const filled = i < n;
    const current = i === n && !login.busy && !waiting;
    return h`<span class="pin-box ${filled ? 'is-filled' : ''} ${current ? 'is-current' : ''}" aria-hidden="true">${filled ? raw('<i class="pin-box__dot"></i>') : current ? raw('<i class="pin-box__caret"></i>') : ''}</span>`;
  });
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => {
    if (!k) return raw('<span class="keypad__gap" aria-hidden="true"></span>');
    if (k === 'del') return h`<button type="button" class="keypad__key keypad__key--del" data-pin="del" aria-label="Delete last digit" ${n ? '' : raw('disabled')}>${ic('arrow-left', { size: 28 })}</button>`;
    return h`<button type="button" class="keypad__key" data-pin="${k}" ${waiting || login.busy ? raw('disabled') : ''}>${k}</button>`;
  });
  const hint = login.busy ? 'Checking…' : waiting ? `Too many tries — try again in ${Math.ceil(wait / 1000)} s` : n < 4 ? 'Type the 4 digits — it signs in by itself' : 'Ready';
  const addr = String(s.joinUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return h`
  <span class="login-page__glow" aria-hidden="true"></span>
  <span class="login-page__flake login-page__flake--a" aria-hidden="true">${ic('snowflake', { size: 240, stroke: 1.4 })}</span>
  <span class="login-page__flake login-page__flake--b" aria-hidden="true">${ic('snowflake', { size: 150, stroke: 1.4 })}</span>
  <section class="login" aria-labelledby="login-h">
    <div class="login__main">
      <div class="brand">${ic('snowflake', { size: 30, color: 'var(--tinsel)' })}<span class="brand__name">Christmas Chaos</span><span class="tag brand__tag">Host</span></div>
      <div class="login__intro">
        <h1 id="login-h" class="login__title">Host sign-in</h1>
        <p class="login__sub">Enter the 4-digit PIN shown on the game laptop or in the terminal.</p>
      </div>
      <div class="login__pin">
        <div class="login__pin-top"><span class="label" id="pin-l">Host PIN</span><span class="login__count" aria-live="polite">${n} of 4</span></div>
        <div class="pin-boxes ${login.shake ? 'shake' : ''}" role="group" aria-labelledby="pin-l" data-key="pin-boxes">${boxes}</div>
        ${login.error ? h`<p class="login__error" role="alert">${ic('circle-x', { size: 18, stroke: 2.4 })}<span>${login.error}</span></p>` : ''}
      </div>
      <div class="login__go">
        <button type="button" class="btn btn--primary btn--lg btn--block login__submit" data-pin="go" ${n === 4 && !login.busy && !waiting ? '' : raw('aria-disabled="true"')}>${ic('lock-open', { size: 24, stroke: 2.4 })}Sign in</button>
        <span class="login__hint" aria-live="polite" data-login-hint>${hint}</span>
      </div>
    </div>
    <div class="login__aside">
      <div class="keypad" role="group" aria-label="Number keypad">${keys}</div>
      <ul class="login__tips" role="list">
        <li>${ic('laptop', { size: 20, color: 'var(--tinsel)' })}<span>On the game laptop itself? <strong>You’re signed in automatically.</strong></span></li>
        <li>${ic('keyboard', { size: 20, color: 'var(--tinsel)' })}<span>Can’t see it? Look for <strong>Host PIN</strong> in the terminal. It’s never shown on the TV.</span></li>
        <li>${ic('shield-check', { size: 20, color: 'var(--tinsel)' })}<span>Once you’re in, this device stays signed in, even after a refresh.</span></li>
      </ul>
    </div>
  </section>
  <p class="login-page__foot">${ic('smartphone', { size: 18 })}<span>Here to play, not host? Join the game at <strong>${addr}</strong></span></p>`;
}

function signedInHtml(s) {
  const hosts = s.host?.connections?.hosts || 1;
  return h`
  <span class="login-page__glow" aria-hidden="true"></span>
  <section class="login login--done" role="status" aria-labelledby="done-h">
    <span class="done-badge">${ic('check', { size: 56, stroke: 3, color: 'var(--night)' })}</span>
    <div class="login__intro login__intro--center">
      <span class="eyebrow eyebrow--gold">Signed in</span>
      <h1 id="done-h" class="login__title">You’re the host!</h1>
      <p class="login__sub">This device can now run the game. It stays signed in, even after a refresh or a Wi-Fi hiccup.</p>
    </div>
    <ul class="host-screens" role="list" aria-label="Host screens">
      <li class="host-screen">${ic('laptop', { size: 18 })}Game laptop<i class="live-dot"></i></li>
      <li class="host-screen is-you">${ic('smartphone', { size: 18, color: 'var(--tinsel)' })}This device<i class="live-dot"></i></li>
    </ul>
    <span class="muted login__small">${plural(hosts, 'host screen')} · always in sync</span>
    <button type="button" class="btn btn--gold btn--lg" data-ui="enterHost" data-key="enter-host">Open host controls${ic('arrow-right', { size: 24, stroke: 2.6 })}</button>
    <button type="button" class="btn btn--link" data-ui="signOut">Sign out of this device</button>
  </section>`;
}

function leaveSignedIn() {
  ui.justSignedIn = false;
  render();
}

function pinPress(k) {
  if (login.busy || login.retryUntil > Date.now()) return;
  if (k === 'del') login.digits = login.digits.slice(0, -1);
  else if (k === 'go') { if (login.digits.length === 4) submitPin(); return; }
  else if (/^\d$/.test(k) && login.digits.length < 4) login.digits += k;
  login.shake = 0;
  render();
  if (login.digits.length === 4) submitPin();
}

async function submitPin() {
  if (login.busy) return;
  login.busy = true;
  render();
  const res = await client.emit('hostLogin', { pin: login.digits });
  login.busy = false;
  if (res.ok) {
    if (res.hostKey) lsSet(KEY_STORE, String(res.hostKey));
    ui.remote = true;
    login.digits = '';
    login.error = '';
    ui.justSignedIn = true;
    ui.signedInAt = Date.now();
    setTimeout(() => { if (ui.justSignedIn && Date.now() - ui.signedInAt >= 3900) leaveSignedIn(); }, 4000);
  } else if (res.error === 'bad-pin') {
    login.digits = '';
    login.error = res.triesLeft > 0 ? `That PIN didn’t match — ${plural(res.triesLeft, 'try', 'tries')} left` : 'That PIN didn’t match.';
    login.shake = Date.now();
  } else if (res.error === 'too-many-tries') {
    login.digits = '';
    login.retryUntil = Date.now() + (Number(res.retryInMs) || 60000);
    login.error = 'Too many wrong PINs. Take a breath and check the laptop screen.';
    login.shake = Date.now();
  } else {
    login.digits = '';
    login.error = errorText(res.error);
  }
  render();
}

function signOut() {
  lsDel(KEY_STORE);
  ui.remote = false;
  ui.justSignedIn = false;
  login.digits = '';
  login.error = '';
  if (ui.modal) closeModal(false);
  client.rehello();
}

/* ============================================================================ top bar */

function topHtml(s) {
  const H = s.host;
  const conn = H.connections || {};
  const act = teamOf(s, s.activeTeamId);
  let phase = '';
  let sub = '';
  let compact = '';
  const inTurn = ['turnIntro', 'spinning', 'challenge', 'turnResult'].includes(s.phase);
  if (s.phase === 'lobby') {
    phase = 'Lobby';
    sub = h`<span class="topbar__sub">Setting up · <b>${plural(s.players.length, 'player')}</b> joined</span>`;
    compact = 'Lobby · setting up';
  } else if (inTurn) {
    phase = `Round ${s.round} of ${s.totalRounds}`;
    sub = h`${turnDots(s.turnIndex, s.turnsPerRound)}<span class="topbar__sub">Turn ${s.turnIndex + 1} of ${s.turnsPerRound}${act ? h` · <b class="team-ink" ${tc(act)}>${act.name}</b>` : ''}</span>`;
    compact = `Round ${s.round} · Turn ${s.turnIndex + 1}`;
  } else if (s.phase === 'roundBreak') {
    phase = `End of round ${s.round}`;
    const rb = s.roundBreak;
    sub = h`<span class="topbar__sub">${rb?.finalNext ? 'Final round next' : rb ? `Round ${rb.nextRound} next` : ''}</span>`;
    compact = `Round break · ${s.round} of ${s.totalRounds}`;
  } else if (s.phase.startsWith('final')) {
    phase = 'Final Chaos';
    let step = { finalIntro: 'Category', finalWager: 'Wagering', finalAnswer: 'Answering', finalReveal: 'Revealing answers' }[s.phase];
    const F = s.final;
    const extra = s.phase === 'finalReveal' && F ? ` · ${F.revealed.length} of ${F.revealOrder.length}` : '';
    if (s.phase === 'finalReveal') step = 'Reveal';
    sub = h`<span class="topbar__sub">${step}${extra}</span>`;
    compact = `Final Chaos · ${step}`;
  } else if (s.phase === 'podium') {
    phase = 'Game over';
    sub = h`<span class="topbar__sub">Podium on the TV</span>`;
    compact = 'Game over';
  }
  const tvOk = conn.tv > 0;
  return h`
  <div class="topbar__brand">${ic('snowflake', { size: 30, color: 'var(--tinsel)' })}<span class="brand__name">Christmas Chaos</span><span class="tag brand__tag">Host</span></div>
  <div class="topbar__phase">
    <span class="phase-pill ${s.phase.startsWith('final') ? 'phase-pill--final' : ''}">${s.phase.startsWith('final') ? ic('sparkles', { size: 18 }) : ''}${phase}</span>
    ${sub}
  </div>
  <span class="topbar__compact">${compact}</span>
  <div class="topbar__status">
    <span class="status-pill ${tvOk ? 'is-ok' : 'is-warn'}" title="${tvOk ? 'The TV screen is connected' : 'Open /tv on the TV'}">${tvOk ? raw('<i class="live-dot"></i>') : ic('triangle-alert', { size: 18 })}<span class="status-pill__text">${tvOk ? 'TV connected' : 'TV not connected'}</span></span>
    <span class="status-pill status-pill--phones" title="${plural(conn.phones || 0, 'phone') + ' connected'}">${ic('smartphone', { size: 18 })}<b>${conn.phones || 0}</b><span>${(conn.phones || 0) === 1 ? ' phone' : ' phones'}</span></span>
    ${conn.hosts > 1 ? h`<span class="status-pill status-pill--hosts" title="${conn.hosts + ' host screens signed in'}">${ic('laptop', { size: 18 })}<b>${conn.hosts}</b><span class="sr-only"> host screens</span></span>` : ''}
    <span class="status-pill status-pill--live ${client.connected ? 'is-ok' : 'is-warn'}">${client.connected ? raw('<i class="live-dot"></i>Live') : h`${ic('wifi-off', { size: 16 })}Offline`}</span>
    <button type="button" class="btn btn--secondary btn--sm topbar__more" data-ui="more" aria-haspopup="dialog" data-key="more">${ic('ellipsis', { size: 20 })}<span>More</span></button>
    <a class="btn ${tvOk ? 'btn--secondary' : 'btn--gold'} btn--sm topbar__tv" href="/tv" target="_blank" rel="noopener" aria-label="Open TV screen" title="Open the TV screen in a new tab">${ic('monitor', { size: 20 })}<span class="topbar__tv-text">Open TV screen</span>${ic('external-link', { size: 16 })}</a>
  </div>`;
}

/* ============================================================================ coach panel */

const ACTION_ICONS = {
  start: 'play', introScript: 'megaphone', soundTest: 'volume-2', resume: 'play', discardSave: 'trash-2',
  spinFor: 'rotate-cw', skipTurn: 'skip-forward', correct: 'check', wrong: 'x', hint: 'lightbulb', reveal: 'eye',
  swap: 'refresh-cw', swapSong: 'refresh-cw', swapDare: 'refresh-cw', swapSecret: 'refresh-cw', swapFinal: 'refresh-cw',
  reopen: 'bell-ring', timerStart: 'play', reroll: 'dices', skip: 'skip-forward', nailed: 'check', valiant: 'thumbs-up',
  fail: 'x', vote: 'users', closeVote: 'gavel', winActive: 'trophy', winRival: 'trophy', tie: 'hand-heart',
  award: 'check', other: 'plus', pass: 'skip-forward', end: 'flag', lock: 'lock', revealAll: 'tv', nextTurn: 'arrow-right',
  crowd: 'party-popper', bonus: 'sparkles', skipBonus: 'skip-forward', nextRound: 'arrow-right', openWagers: 'coins',
  showQuestion: 'eye', startReveal: 'lock', confirm: 'check', accept: 'check', reject: 'x', revealNext: 'tv',
  flip: 'refresh-cw', playAgain: 'rotate-ccw', newTeams: 'users',
};
const MAIN_IDS = new Set(['vote', 'closeVote', 'reopen', 'lock', 'flip', 'crowd', 'spinFor', 'pass', 'introScript', 'resume']);
const iconFor = (a) => ACTION_ICONS[a.id] || (a.id.startsWith('change-') ? 'pencil' : a.id.startsWith('pick-') ? 'target' : 'chevron-right');

function splitHeadline(text) {
  const t = String(text || '');
  let m = t.match(/^(.+?)\s(\([^()]+\))$/);
  if (m) return [m[1], m[2]];
  const i = t.lastIndexOf(' — ');
  if (i > 0) return [`${t.slice(0, i)} —`, t.slice(i + 3)];
  m = t.match(/^(.+?)\s([+−-][\d,]+)$/);
  if (m) return [m[1], m[2]];
  return [t, ''];
}

function sayHtml(say) {
  const lines = String(say || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!lines.length) return '';
  let lead = '';
  let body = lines;
  let punch = '';
  if (lines.length > 1) {
    body = lines.slice(0, -1);
    punch = lines[lines.length - 1];
  } else {
    const m = lines[0].match(/^([^.!?…]{2,30}!)\s+(.+)$/);
    if (m && m[1].trim().split(/\s+/).length <= 4) { lead = m[1]; body = [m[2]]; }
  }
  const total = lines.join(' ').length;
  const size = total > 260 ? 'say__text--xs' : total > 170 ? 'say__text--sm' : '';
  return h`<div class="say__text ${size}">${lead ? h`<p class="say__lead">${lead}</p>` : ''}${body.map((l) => h`<p class="say__line">${l}</p>`)}${punch ? h`<p class="say__punch">${punch}</p>` : ''}</div>`;
}

function contextLabel(s) {
  const c = s.challenge;
  if ((s.phase === 'challenge' || s.phase === 'turnResult') && c) {
    const sg = segOf(s, c.segmentIndex);
    const bits = [sg ? sg.label : 'Bonus'];
    if (c.difficulty) bits.push(cap(c.difficulty));
    return { text: bits.join(' · '), seg: sg };
  }
  if (c && c.type === 'bonus') return { text: 'Bonus question', seg: segOf(s, 10) };
  const map = { lobby: 'Lobby', turnIntro: 'Turn intro', spinning: 'Spinning', roundBreak: 'Round break', finalIntro: 'Final Chaos', finalWager: 'Final · wagers', finalAnswer: 'Final · answers', finalReveal: 'Final · reveal', podium: 'Podium' };
  return { text: map[s.phase] || '', seg: null };
}

function actionBtn(a, size, s) {
  const dis = !!a.disabled;
  const kindCls = { primary: 'cbtn--primary', success: 'cbtn--success', danger: 'cbtn--danger', secondary: 'cbtn--secondary' }[a.kind] || 'cbtn--secondary';
  const detail = dis ? a.reason : a.detail;
  const t = a.payload && a.payload.teamId ? teamOf(s, a.payload.teamId) : null;
  return h`<button type="button" class="cbtn ${kindCls} cbtn--${size} ${dis ? 'is-disabled' : ''} ${a.id === s.host.coach.primary ? 'is-primary' : ''}"
    data-act="coach" data-id="${a.id}" data-key="${'coach:' + a.id}" ${a.shortcut ? raw(`aria-keyshortcuts="${a.shortcut === 'Enter' ? 'Enter' : a.shortcut}"`) : ''} ${dis ? raw('aria-disabled="true"') : ''} ${t ? tc(t) : ''}>
    <span class="cbtn__icon" aria-hidden="true">${t ? disc(t, { size: size === 'hero' ? 44 : 28 }) : ic(dis ? 'lock' : iconFor(a), { size: size === 'hero' ? 34 : size === 'main' ? 24 : 18, stroke: 2.6 })}</span>
    <span class="cbtn__text"><span class="cbtn__label">${a.label}</span>${detail ? h`<span class="cbtn__detail">${detail}</span>` : ''}</span>
    ${a.shortcut ? h`<kbd class="kbd">${a.shortcut}</kbd>` : ''}
  </button>`;
}

function targetCard(a, s) {
  const id = a.payload?.teamId;
  const t = teamOf(s, id);
  const eye = s.challenge?.eyeing;
  const eyed = eye && eye.teamId === id;
  const dis = !!a.disabled;
  return h`<button type="button" class="target ${eyed ? 'is-eyed' : ''} ${dis ? 'is-disabled' : ''}" data-act="coach" data-id="${a.id}" data-key="${'coach:' + a.id}" ${dis ? raw('aria-disabled="true"') : ''} ${tc(t)}>
    ${disc(t || {}, { size: 48 })}
    <span class="target__body"><span class="target__name">${t ? t.name : id}</span><span class="target__meta"><b class="num">${fmt(t?.score || 0)}</b> pts${a.detail ? h` · ${a.detail}` : ''}</span></span>
    ${eyed ? h`<span class="tag tag--ember target__eye">${ic('eye', { size: 14, stroke: 2.6 })}${eye.by?.name || 'Someone'} is eyeing</span>` : ''}
    <span class="target__go">${ic('chevron-right', { size: 22 })}</span>
  </button>`;
}

function coachHtml(s) {
  const C = s.host.coach;
  const [main, hl] = splitHeadline(C.headline);
  const ctx = contextLabel(s);
  const acts = C.actions || [];
  const primary = acts.find((a) => a.id === C.primary) || null;
  const targets = acts.filter((a) => a.event === 'host:pickTarget');
  const rest = acts.filter((a) => a !== primary && !targets.includes(a));
  const isMain = (a) => a.kind === 'success' || a.kind === 'primary' || (a.kind === 'danger' && a.shortcut) || /^[1-3]$/.test(a.shortcut || '') || MAIN_IDS.has(a.id) || a.id.startsWith('pick-');
  const mains = rest.filter(isMain);
  const tools = rest.filter((a) => !isMain(a));
  const t = s.timer;
  const waitingText = C.steps?.[0] || 'Follow the TV';
  const progress = (C.progress || []).length
    ? h`<ol class="progress" aria-label="Turn progress">${C.progress.map((p, i) => h`<li class="progress__step is-${p.state}">
        <span class="progress__n">${p.state === 'done' ? ic('check', { size: 14, stroke: 3 }) : i + 1}</span><span>${p.label}${p.detail ? h` <small>· ${p.detail}</small>` : ''}</span></li>`)}</ol>`
    : '';
  return h`
  <div class="coach__head">
    <div class="coach__eyebrow">${ic('radio', { size: 18, color: 'var(--tinsel)' })}<span>Live directions</span>${ctx.text ? h`<span class="coach__ctx">${ctx.seg ? h`<i class="ctx-dot" ${sc(ctx.seg)}></i>` : ''}${ctx.text}</span>` : ''}</div>
    ${t ? h`<span class="timer-pill ${t.running ? 'is-running' : ''}" data-timer-pill>${ic('timer', { size: 18 })}<b data-timer-text>${mmss(timerRemaining(t, client.serverNow()))}</b></span>` : ''}
    <h2 class="coach__headline"><span class="tag coach__now"><i class="now-dot"></i>Now</span><span class="coach__headline-text">${main}${hl ? h` <span class="coach__hl">${hl}</span>` : ''}</span></h2>
    <p class="coach__live"><i class="live-dot"></i>Updates with every step</p>
  </div>
  ${C.say ? h`<div class="say"><div class="say__top"><span class="say__label">${ic('mic', { size: 18, stroke: 2.4 })}Say this</span><span class="say__hint">Read it out loud</span></div>${sayHtml(C.say)}</div>` : ''}
  ${(C.steps || []).length ? h`<div class="do ${C.say ? '' : 'do--wide'}"><div class="do__label">${ic('list-checks', { size: 20, color: 'var(--tinsel)' })}Do this</div>
    <ol class="do__steps">${C.steps.map((st, i) => h`<li class="do__step ${i === 0 ? 'is-first' : ''}"><span class="do__n">${i + 1}</span><span>${st}</span></li>`)}</ol></div>` : ''}
  <div class="coach__actions ${primary ? '' : 'has-no-primary'}">
    ${primary
      ? h`<div class="hero-frame hero-frame--${primary.kind}">${actionBtn(primary, 'hero', s)}</div>`
      : h`<div class="coach__waiting" role="status">${ic('hourglass', { size: 28, color: 'var(--tinsel)' })}<span><b>Nothing to press yet</b><small>${waitingText}</small></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`}
    ${targets.length ? h`<div class="coach__targets">${targets.map((a) => targetCard(a, s))}</div>` : ''}
    ${mains.length ? h`<div class="coach__mains ${mains.length > 2 ? 'is-grid' : ''}">${mains.map((a) => actionBtn(a, 'main', s))}</div>` : ''}
    ${tools.length ? h`<div class="coach__tools">${tools.map((a) => actionBtn(a, 'tool', s))}</div>` : ''}
  </div>
  ${(C.tips || []).length ? h`<ul class="tips" role="list">${C.tips.map((tip) => h`<li class="tip">${ic('lightbulb', { size: 20, color: 'var(--tinsel)' })}<span><b>Heads-up:</b> ${tip}</span></li>`)}</ul>` : ''}
  ${progress}`;
}

/* ============================================================================ scores (rail + phone dock) */

function scoreRows(s, cls) {
  const lead = Math.max(0, ...s.teams.map((t) => t.score));
  const now = Date.now();
  return s.teams.map((t) => {
    const active = t.id === s.activeTeamId;
    const offline = t.playerCount > 0 && t.connectedCount === 0;
    const bump = (ui.bump[t.id] || 0) > now;
    return h`<li class="${cls} ${active ? 'is-active' : ''} ${offline ? 'is-offline' : ''}" ${tc(t)}>
      ${active ? h`<span class="tag ${cls}__tag">Up now</span>` : ''}
      ${t.multiplier > 1 ? h`<span class="${cls}__x2" role="img" aria-label="Points doubled this turn">×2</span>` : ''}
      ${disc(t, { size: cls === 'dock-row' ? 32 : 44, className: offline ? 'is-offline' : '' })}
      <span class="${cls}__body"><span class="${cls}__name">${lead > 0 && t.score === lead ? ic('crown', { size: 16, stroke: 2.4, color: 'var(--tinsel)', label: 'Leader' }) : ''}${t.name}${offline ? h` <small>· offline</small>` : ''}</span>
        <span class="${cls}__score num ${bump ? 'is-bump' : ''}">${fmt(t.score)}</span></span>
      <button type="button" class="icon-btn" data-emit="host:adjustScore" data-payload="${json({ teamId: t.id, delta: -50 })}" data-key="${'minus:' + t.id}" aria-label="${'Take 50 from ' + t.name}" data-needs-online>${ic('minus', { size: 18, stroke: 2.6 })}</button>
      <button type="button" class="icon-btn" data-emit="host:adjustScore" data-payload="${json({ teamId: t.id, delta: 50 })}" data-key="${'plus:' + t.id}" aria-label="${'Give ' + t.name + ' 50'}" data-needs-online>${ic('plus', { size: 18, stroke: 2.6 })}</button>
    </li>`;
  });
}

function undoBtn(s, cls = '') {
  const H = s.host;
  return h`<button type="button" class="btn btn--secondary btn--md undo ${cls}" data-ui="undo" data-key="undo" ${H.canUndo ? '' : raw('aria-disabled="true"')} aria-keyshortcuts="U Control+Z" title="${H.undoLabel ? 'Undo: ' + H.undoLabel : 'Nothing to undo'}">${ic('undo-2', { size: 20, color: 'var(--tinsel)' })}<span>Undo last change</span><kbd class="kbd">U</kbd></button>`;
}

function railHtml(s) {
  const H = s.host;
  return h`<section class="panel scores">
    <div class="scores__head"><h2 class="panel__title">Scores</h2><span class="muted scores__hint">Turn order · 50 a tap</span></div>
    <ol class="scores__list" role="list">${scoreRows(s, 'score-row')}</ol>
    <div class="scores__foot">${undoBtn(s)}<span class="scores__last">${H.undoLabel ? h`Last: ${H.undoLabel}${H.undoDepth > 1 ? h` · ${H.undoDepth} steps back` : ''}` : 'No score changes yet'}</span></div>
  </section>`;
}

function dockHtml(s) {
  const lead = [...s.teams].sort((a, b) => b.score - a.score)[0];
  const tie = lead && s.teams.filter((t) => t.score === lead.score).length > 1;
  const summary = !lead ? 'No teams' : lead.score === 0 ? 'Everyone is on 0' : tie ? `Tied at the top on ${fmt(lead.score)}` : `${lead.name} leads with ${fmt(lead.score)}`;
  return h`<div class="dock__bar">
    <button type="button" class="dock__toggle" data-ui="dock" aria-expanded="${ui.dockOpen ? 'true' : 'false'}" data-key="dock">${ic('trophy', { size: 22, color: 'var(--tinsel)' })}
      <span class="dock__sum"><b>Scores</b><small>${summary}</small></span>${ic(ui.dockOpen ? 'chevron-down' : 'chevron-up', { size: 22 })}</button>
    <button type="button" class="btn btn--secondary btn--sm dock__undo" data-ui="undo" ${s.host.canUndo ? '' : raw('aria-disabled="true"')} aria-label="Undo last score change">${ic('undo-2', { size: 18, color: 'var(--tinsel)' })}Undo</button>
  </div>
  ${ui.dockOpen ? h`<div class="dock__body"><ol class="dock__list" role="list">${scoreRows(s, 'dock-row')}</ol><span class="dock__note">50 a tap${s.host.undoLabel ? h` · Last change: ${s.host.undoLabel}` : ''}</span></div>` : ''}`;
}

/* ============================================================================ private panel + timer (side) */

function secretKeyOf(s) {
  const c = s.challenge;
  return [s.phase, c?.id, c?.stage, c?.hotseat?.index, s.final?.current].join('|');
}
function syncPrivateKey(s) {
  const k = secretKeyOf(s);
  if (k !== ui.privateKey) { ui.privateKey = k; ui.privateRevealed = false; }
}

function acceptChips(list, main) {
  const a = (list || []).filter((x) => x && x !== main);
  return a.length ? h`<div class="pv__block"><span class="pv__label">Also accept</span><ul class="chips" role="list">${a.slice(0, 8).map((x) => h`<li class="chip-sm">${x}</li>`)}</ul></div>` : '';
}

function privateInfo(s) {
  const H = s.host;
  const c = s.challenge;
  const F = H.final;
  if (s.phase.startsWith('final') && F) {
    return {
      noun: 'answer', secret: true,
      body: h`<div class="pv__block"><span class="pv__label">Final question · ${F.categoryLabel}</span><p class="pv__q">${F.question}</p></div>
        <div class="pv__block"><span class="pv__label">Correct answer</span><p class="pv__answer">${F.answer}</p></div>
        ${acceptChips(F.accept, F.answer)}
        ${s.phase === 'finalReveal' ? projectedHtml(s) : ''}`,
    };
  }
  if (!c) return null;
  if (c.type === 'trivia' || c.type === 'allplay' || c.type === 'bonus') {
    if (!H.answer) return { noun: 'answer', secret: false, body: h`<p class="pv__empty">${ic('lock', { size: 22 })}The question and answer appear here once ${teamName(s, s.activeTeamId)} picks a difficulty.</p>` };
    return {
      noun: 'answer', secret: true,
      body: h`${c.type !== 'trivia' && c.question ? h`<div class="pv__block"><span class="pv__label">Question</span><p class="pv__q">${c.question}</p></div>` : ''}
        <div class="pv__block"><span class="pv__label">Answer</span><p class="pv__answer">${H.answer}</p></div>
        ${acceptChips(H.accept, H.answer)}
        ${c.movie ? h`<p class="pv__note">${ic('film', { size: 16 })}From <b>${c.movie}</b>${c.movieYear ? ` (${c.movieYear})` : ''}</p>` : ''}
        ${H.funFact ? h`<div class="pv__say"><b>Say after:</b> ${H.funFact}</div>` : ''}
        ${H.hint ? h`<div class="pv__block pv__block--rule"><span class="pv__label">${ic('lightbulb', { size: 16 })}Hint${c.hint ? h` <span class="tag tag--ember pv__tag">On the TV</span>` : ''}</span><p class="pv__text">“${H.hint}”</p></div>` : ''}`,
    };
  }
  if (c.type === 'sounditout') {
    const song = H.song || {};
    return {
      noun: 'song', secret: true,
      body: h`<div class="pv__block"><span class="pv__label">The song</span><p class="pv__answer">${song.title || H.answer || ''}</p>${song.artist ? h`<p class="pv__text">by ${song.artist}</p>` : ''}</div>
        <p class="pv__text">Only on ${c.performer?.name || 'the performer'}’s phone. They press and hold to peek.</p>
        ${peekChip(s)}
        ${acceptChips(song.accept, song.title)}
        ${song.hint ? h`<div class="pv__block pv__block--rule"><span class="pv__label">${ic('lightbulb', { size: 16 })}Hint${c.hint ? h` <span class="tag tag--ember pv__tag">On the TV</span>` : ''}</span><p class="pv__text">“${song.hint}”</p></div>` : ''}`,
    };
  }
  if (c.type === 'dare') {
    const d = c.dare || {};
    const sec = H.secret;
    return {
      noun: sec ? 'secret' : 'judging guide', secret: !!sec,
      body: h`${sec ? h`<div class="pv__block"><span class="pv__label">The secret</span><p class="pv__answer">${sec.value}</p><p class="pv__text">${sec.label}</p></div>${peekChip(s)}` : ''}
        ${d.judge ? h`<div class="pv__block pv__block--rule"><span class="pv__label">${ic('gavel', { size: 16 })}How to judge</span><p class="pv__text">${d.judge}</p></div>` : ''}
        ${(d.props || []).length ? h`<div class="pv__block"><span class="pv__label">Props</span><ul class="chips" role="list">${d.props.map((p) => h`<li class="chip-sm">${p}</li>`)}</ul></div>` : ''}
        <ul class="pv__legend" role="list">
          <li><i class="legend-dot legend-dot--holly"></i><span><b>Nailed it</b> — 200, they did it</span></li>
          <li><i class="legend-dot legend-dot--gold"></i><span><b>Valiant effort</b> — 100, a big try</span></li>
          <li><i class="legend-dot legend-dot--muted"></i><span><b>Not this time</b> — 0 points</span></li>
        </ul>`,
    };
  }
  if (c.type === 'showdown' && c.showdown) {
    const sd = c.showdown;
    return {
      noun: 'rules', secret: false,
      body: h`<div class="pv__block"><span class="pv__label">Challenge</span><p class="pv__q">${sd.title}</p><p class="pv__text">${sd.instructions}</p></div>
        ${sd.winner ? h`<div class="pv__block pv__block--rule"><span class="pv__label">${ic('trophy', { size: 16 })}How to win</span><p class="pv__text">${sd.winner}</p></div>` : ''}
        ${(sd.props || []).length ? h`<div class="pv__block"><span class="pv__label">Props</span><ul class="chips" role="list">${sd.props.map((p) => h`<li class="chip-sm">${p}</li>`)}</ul></div>` : ''}`,
    };
  }
  if (c.type === 'rapidlist') {
    const l = c.list;
    return {
      noun: 'answers', secret: true,
      body: h`<div class="pv__block"><span class="pv__label">Rules</span><ul class="chips" role="list"><li class="chip-sm">30 seconds</li><li class="chip-sm">${l.each} each</li><li class="chip-sm">${l.max} count · max ${fmt(l.max * l.each)}</li><li class="chip-sm">Repeats don’t count</li></ul></div>
        <div class="pv__block"><span class="pv__label">Valid answers</span><p class="pv__text"><b>${plural((H.listAnswers || []).length, 'answer')}</b> on your checklist. Tap what they shout.</p></div>
        ${H.listNote ? h`<div class="pv__say"><b>Note:</b> ${H.listNote}</div>` : ''}`,
    };
  }
  if (c.type === 'hotseat') {
    const hs = c.hotseat;
    if (!H.hotseatQuestion) return null;
    return {
      noun: 'answer', secret: true,
      body: h`<div class="pv__block"><span class="pv__label">Question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}</span><p class="pv__q">${H.hotseatQuestion}</p></div>
        <div class="pv__block"><span class="pv__label">Answer</span><p class="pv__answer">${H.hotseatAnswer}</p></div>
        ${acceptChips(H.hotseatAccept, H.hotseatAnswer)}`,
    };
  }
  return null;
}

function peekChip(s) {
  const p = s.challenge?.performer;
  if (!p) return '';
  return s.host.secretPeeked
    ? h`<span class="peek is-yes">${ic('eye', { size: 16, stroke: 2.4 })}${p.name} has peeked</span>`
    : h`<span class="peek">${ic('eye-off', { size: 16, stroke: 2.4 })}${p.name} hasn’t peeked yet</span>`;
}

function projectedHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const rows = F.rows.map((r) => {
    const t = teamOf(s, r.teamId);
    const after = r.judged ? r.after : Math.max(0, r.before + (r.correct ? r.wager : -r.wager));
    return { r, t, after };
  }).sort((a, b) => b.after - a.after);
  return h`<div class="pv__block"><span class="pv__label">Projected final standings</span><span class="pv__text pv__text--sm">if every current mark stands</span>
    <ol class="proj" role="list">${rows.map((x, i) => h`<li class="proj__row ${x.r.teamId === F.current ? 'is-current' : ''}" ${tc(x.t)}>
      <span class="proj__rank num">${i + 1}</span>${disc(x.t || {}, { size: 26 })}<span class="proj__name">${x.t?.name || ''}${x.r.judged ? h` <small>· final</small>` : x.r.teamId === F.current ? h` <small>· reading now</small>` : ''}</span>
      <span class="proj__delta ${x.after >= x.r.before ? 'is-up' : 'is-down'}">${signed(x.after - x.r.before)}</span><span class="proj__score num">${fmt(x.after)}</span></li>`)}</ol></div>`;
}

function timerHtml(s) {
  const t = s.timer;
  if (!t) return '';
  const st = !t.started ? 'ready' : t.ended ? 'ended' : t.running ? 'running' : 'paused';
  const stLabel = { ready: 'Timer ready', running: 'Timer running', paused: 'Timer paused', ended: 'Time’s up' }[st];
  const main = st === 'running'
    ? { label: 'Pause', icon: 'pause', payload: { action: 'pause' } }
    : st === 'paused' ? { label: 'Resume', icon: 'play', payload: { action: 'resume' } }
      : { label: st === 'ended' ? 'Restart' : 'Start', icon: 'play', payload: { action: 'start' } };
  const tTaken = (s.host.coach.actions || []).some((a) => a.shortcut === 'T' && !a.disabled);
  return h`<section class="timer-panel is-${st}" aria-label="Timer">
    <div class="timer-panel__top"><span class="timer-panel__state"><i class="state-dot"></i>${stLabel}</span>
      <span class="timer-panel__time"><b data-timer-text>${mmss(timerRemaining(t, client.serverNow()))}</b><small>of ${mmss(t.durationMs)}</small></span></div>
    <div class="bar" aria-hidden="true"><i class="bar__fill" data-timer-bar></i></div>
    <span class="timer-panel__label">${t.label}</span>
    <div class="timer-panel__btns">
      <button type="button" class="btn btn--secondary btn--sm" data-emit="host:timer" data-payload="${json(main.payload)}" data-key="timer-main" data-needs-online>${ic(main.icon, { size: 18 })}${main.label}${tTaken ? '' : raw('<kbd class="kbd">T</kbd>')}</button>
      <button type="button" class="btn btn--secondary btn--sm" data-emit="host:timer" data-payload="${json({ action: 'add', seconds: 10 })}" data-key="timer-add" data-needs-online>${ic('alarm-clock-plus', { size: 18 })}+10 s</button>
    </div>
  </section>`;
}

function sideHtml(s) {
  const info = privateInfo(s);
  const concealed = !!(info && info.secret && !ui.privateRevealed);
  const priv = info
    ? h`<section class="private ${info.secret ? 'is-secret' : ''}" data-concealed="${concealed ? 'true' : 'false'}" aria-label="Only you see this">
      <div class="private__head"><span class="private__title">${ic('lock', { size: 20 })}Only you see this</span><span class="private__not">${ic('eye-off', { size: 16 })}Not on TV</span>
        ${info.secret ? h`<button type="button" class="private__hide" data-ui="hidePrivate">${ic('eye-off', { size: 18 })}Hide</button>` : ''}</div>
      ${info.secret ? h`<button type="button" class="private__reveal" data-ui="revealPrivate" data-key="reveal-private">
        <span class="private__lock">${ic('lock', { size: 22, color: 'var(--tinsel)' })}</span>
        <span class="private__reveal-text"><b>Tap to show ${info.noun}</b><small>Only you see it · never on the TV</small></span>${ic('eye', { size: 26, color: 'var(--tinsel)' })}</button>` : ''}
      <div class="private__body">${info.body}</div>
    </section>`
    : h`<section class="private private--empty" aria-label="Only you see this"><div class="private__head"><span class="private__title">${ic('lock', { size: 20 })}Only you see this</span><span class="private__not">${ic('eye-off', { size: 16 })}Not on TV</span></div>
      <p class="pv__empty">${ic('sparkles', { size: 22 })}Nothing secret right now. Answers, songs and dare secrets show up here — never on the TV.</p></section>`;
  return h`${priv}${timerHtml(s)}`;
}

/* ============================================================================ stage-specific panels */

function stageHtml(s) {
  const c = s.challenge;
  const out = [];
  if (s.phase === 'challenge' || s.phase === 'turnResult') {
    if (c) {
      if (c.type === 'trivia' && c.stage === 'steal') out.push(stealHtml(s));
      if (c.type === 'sounditout') out.push(c.stage === 'steal' ? stealHtml(s) : performerHtml(s, 'Hums the song'));
      if (c.type === 'dare') out.push(c.stage === 'vote' || c.vote ? voteHtml(s) : '', c.stage === 'perform' ? performerHtml(s, 'Performs the dare') : '', c.stage === 'done' ? dareResultHtml(s) : '');
      if (c.type === 'showdown' && c.stage !== 'pickRival') out.push(versusHtml(s));
      if (c.type === 'rapidlist') out.push(checklistHtml(s));
      if (c.type === 'hotseat') out.push(hotseatHtml(s));
      if (c.type === 'allplay') out.push(answersHtml(s));
      if (c.type === 'grinch' && c.stage === 'done') out.push(grinchResultHtml(s));
      if (s.phase === 'turnResult' && c.result) out.push(resultHtml(s));
    }
  } else if (s.phase === 'roundBreak') {
    if (c && c.type === 'bonus') out.push(answersHtml(s));
    out.push(standingsHtml(s));
  } else if (s.phase === 'finalIntro' || s.phase === 'finalWager') {
    out.push(wagersHtml(s));
  } else if (s.phase === 'finalAnswer') {
    out.push(finalAnswersHtml(s));
  } else if (s.phase === 'finalReveal') {
    out.push(finalRevealHtml(s));
  } else if (s.phase === 'podium') {
    out.push(podiumHtml(s));
  }
  return h`${out.filter(Boolean)}`;
}

function panel(title, sub, body, { icon = null, cls = '', eyebrow = '' } = {}) {
  return h`<section class="panel stage-panel ${cls}">
    <div class="stage-panel__head">${eyebrow ? h`<span class="eyebrow eyebrow--gold">${icon ? ic(icon, { size: 16 }) : ''}${eyebrow}</span>` : ''}<h3 class="stage-panel__title">${title}</h3>${sub ? h`<span class="stage-panel__sub">${sub}</span>` : ''}</div>
    ${body}
  </section>`;
}

function stealHtml(s) {
  const c = s.challenge;
  const b = c.buzz || {};
  const elig = b.eligibleTeamIds || [];
  const locked = b.lockedTeamIds || [];
  const others = s.teams.filter((t) => t.id !== s.activeTeamId);
  let status;
  if (b.winner) status = h`<p class="steal__status is-winner" ${tc(teamOf(s, b.winner.teamId))}>${ic('bell-ring', { size: 22 })}<span><b>${b.winner.name}</b> (${teamName(s, b.winner.teamId)}) buzzed first — listen to their answer</span></p>`;
  else if (b.armingUntil) status = h`<p class="steal__status is-arming">${ic('hourglass', { size: 22 })}<span>Buzzers arm in <b data-arming="${b.armingUntil}">3</b>… get the room ready</span></p>`;
  else if (b.open) status = h`<p class="steal__status is-open">${ic('zap', { size: 22 })}<span><b>Buzzers are live!</b> First buzz answers for ${fmt(c.stealPoints)}.</span></p>`;
  else status = h`<p class="steal__status">${ic('lock', { size: 22 })}<span>Buzzers closed. Reopen the steal for the teams that are left, or reveal the answer.</span></p>`;
  return panel(`Steal for ${fmt(c.stealPoints)}`, 'Each team gets one try', h`
    ${status}
    <ul class="steal__teams" role="list">${others.map((t) => {
      const isLocked = locked.includes(t.id);
      const isWin = b.winner && b.winner.teamId === t.id;
      const isElig = elig.includes(t.id) && !isLocked;
      return h`<li class="steal-team ${isLocked ? 'is-locked' : ''} ${isWin ? 'is-winner' : ''} ${isElig ? 'is-eligible' : ''}" ${tc(t)}>${disc(t, { size: 32 })}<span class="steal-team__body"><span class="steal-team__name">${t.name}</span>
        <span class="steal-team__state">${isWin ? 'Buzzed first' : isLocked ? 'Locked out' : isElig ? (b.open ? 'Armed' : 'Can steal') : 'Out'}</span></span></li>`;
    })}</ul>`, { eyebrow: 'Steal', icon: 'bell-ring', cls: 'steal' });
}

function performerHtml(s, role) {
  const c = s.challenge;
  const p = c.performer;
  if (!p) return panel('No performer', '', h`<p class="muted">${teamName(s, s.activeTeamId)} has no players. Move someone onto the team, or skip.</p>`, { eyebrow: 'Performer', icon: 'user' });
  const t = teamOf(s, p.teamId);
  const pl = playerOf(s, p.playerId);
  const partner = c.partner;
  const d = c.dare;
  return h`<section class="panel performer" ${tc(t)}>
    ${disc(t || {}, { size: 56 })}
    <div class="performer__body"><span class="eyebrow">${role}</span><span class="performer__name">${p.name}${partner ? h` <span class="performer__amp">&amp;</span> ${partner.name}` : ''}</span>
      <span class="performer__meta">${pl && !pl.connected ? h`<b class="warn-ink">${ic('wifi-off', { size: 14 })} Phone offline</b> · ` : ''}Random pick from ${t?.name || 'the team'}${d && d.who === 'team' ? ' · whole team plays' : d && d.who === 'everyone' ? ' · everyone plays' : ''}</span></div>
    ${c.dare?.hasSecret || c.type === 'sounditout' ? peekChip(s) : ''}
  </section>`;
}

function voteHtml(s) {
  const c = s.challenge;
  const v = c.vote;
  if (!v) return '';
  const total = Math.max(1, v.nailed + v.good);
  const res = v.result || (c.dareResult ? c.dareResult.result : null);
  return panel(v.open ? 'The room is voting' : 'Room vote result', v.open ? h`<span data-timer-text-inline>${v.voters} of ${v.eligible} voted</span>` : `${v.voters} of ${v.eligible} voted`, h`
    <div class="vote">
      <div class="vote__row"><span class="vote__label">${ic('thumbs-up', { size: 20 })}Nailed it</span><span class="vote__bar"><i class="vote__fill vote__fill--nailed" data-fill="${v.nailed / total}"></i></span><b class="num">${v.nailed}</b></div>
      <div class="vote__row"><span class="vote__label">${ic('hand-metal', { size: 20 })}Good try</span><span class="vote__bar"><i class="vote__fill vote__fill--good" data-fill="${v.good / total}"></i></span><b class="num">${v.good}</b></div>
    </div>
    ${res ? h`<p class="vote__result">${ic('gavel', { size: 18 })}Result: <b>${{ nailed: 'Nailed it', valiant: 'Valiant effort', fail: 'Not this time' }[res] || res}</b>${v.result && c.dareResult && c.dareResult.result !== v.result ? ' (you overrode it)' : ''}</p>` : h`<p class="muted vote__note">Majority wins · a tie counts as Nailed it · you can still override.</p>`}`, { eyebrow: 'Room vote', icon: 'users', cls: 'vote-panel' });
}

function dareResultHtml(s) {
  const c = s.challenge;
  const r = c.dareResult;
  if (!r) return '';
  const label = { nailed: 'Nailed it', valiant: 'Valiant effort', fail: 'Not this time' }[r.result] || r.result;
  return panel(label, r.bonus ? '+50 crowd favourite added' : 'Change it below if you need to', h`${c.answer ? h`<p class="muted">The secret was <b class="snow-ink">${c.answer}</b>.</p>` : ''}`, { eyebrow: 'Dare judged', icon: 'gavel' });
}

function versusHtml(s) {
  const c = s.challenge;
  const a = c.performer;
  const r = c.rival;
  const ta = teamOf(s, s.activeTeamId);
  const tr = r ? teamOf(s, r.teamId) : null;
  const side = (t, p, win) => h`<div class="vs__side ${win ? 'is-winner' : ''}" ${tc(t)}>${disc(t || {}, { size: 56 })}<span class="vs__name">${p?.name || 'Nobody online'}</span><span class="vs__team">${t?.name || ''}</span>${win ? h`<span class="tag tag--holly">Winner</span>` : ''}</div>`;
  const ws = c.winnerSide;
  return panel(c.showdown?.title || 'Showdown', c.showdown ? `${c.showdown.time} s · winner takes 200` : '', h`
    <div class="vs">${side(ta, a, ws === 'active')}<span class="vs__x">VS</span>${side(tr, r, ws === 'rival')}</div>
    ${ws === 'tie' ? h`<p class="vote__result">${ic('hand-heart', { size: 18 })}A tie — 100 each</p>` : ''}`, { eyebrow: 'Head to head', icon: 'swords', cls: 'versus' });
}

function checklistHtml(s) {
  const c = s.challenge;
  const l = c.list;
  const answers = s.host.listAnswers || l.answers || [];
  const ticked = l.ticked || [];
  const otherCount = ticked.filter((x) => x === 'Other answer').length;
  const pts = Math.min(l.count, l.max) * l.each;
  const segs = Array.from({ length: l.max }, (_, i) => raw(`<i class="${i < l.count ? 'is-on' : ''}"></i>`));
  const keyed = answers.slice(0, 9);
  return panel(`Tick every answer they shout`, c.stage === 'done' ? 'Time’s up — late ticks still count' : 'Tap or press 1–9 · tap again to untick', h`
    <ul class="checklist" role="list">${answers.map((a, i) => {
      const on = ticked.includes(a);
      return h`<li><button type="button" class="check ${on ? 'is-on' : ''}" data-emit="${on ? 'host:listUntick' : 'host:listTick'}" data-payload="${json({ answer: a })}" data-key="${'tick:' + a}" aria-pressed="${on ? 'true' : 'false'}" data-needs-online>
        <span class="check__box">${on ? ic('check', { size: 18, stroke: 3 }) : ''}</span><span class="check__label">${a}</span>${i < keyed.length ? h`<kbd class="kbd">${i + 1}</kbd>` : ''}</button></li>`;
    })}</ul>
    <div class="checklist__other">
      <button type="button" class="btn btn--dashed btn--md checklist__add" data-emit="host:listOther" data-key="list-other" data-needs-online>${ic('plus', { size: 20 })}Other valid answer <small>counts as one more</small></button>
      ${otherCount ? h`<button type="button" class="chip-sm chip-sm--on" data-emit="host:listUntick" data-payload="${json({ answer: 'Other answer' })}" aria-label="Remove one other answer">${ic('check', { size: 14, stroke: 3 })}${otherCount} other ${otherCount === 1 ? 'answer' : 'answers'} ${ic('x', { size: 14 })}</button>` : ''}
    </div>
    <div class="tally"><span class="tally__big num">${Math.min(l.count, l.max)} of ${l.max}</span><span class="tally__pts num">· ${fmt(pts)} points</span>${l.count > l.max ? h`<span class="muted">(${l.count} ticked, ${l.max} count)</span>` : ''}</div>
    <div class="segments" aria-hidden="true">${segs}</div>`, { eyebrow: `Checklist · ${l.prompt}`, icon: 'list-checks', cls: 'checklist-panel' });
}

function hotseatHtml(s) {
  const c = s.challenge;
  const hs = c.hotseat;
  const qs = s.host.hotseatQuestions || [];
  const res = { correct: ['check', 'is-correct', 'Correct'], wrong: ['x', 'is-wrong', 'Wrong'], pass: ['skip-forward', 'is-pass', 'Passed'] };
  return panel(`${c.performer?.name || 'The player'} · ${fmt(hs.banked || 0)} banked`, `${hs.results.filter((r) => r === 'correct').length} right of ${hs.total} · ${hs.each} each`, h`
    <ol class="hotseat" role="list">${qs.map((q) => {
      const r = q.result ? res[q.result] : null;
      const cur = q.index === hs.index && c.stage === 'hotseat';
      return h`<li class="hs-row ${r ? r[1] : ''} ${cur ? 'is-current' : ''}">
        <span class="hs-row__n">${r ? ic(r[0], { size: 16, stroke: 3 }) : q.index + 1}</span>
        <span class="hs-row__q">${q.question}</span>
        <span class="hs-row__a">${q.answer}</span>
        <span class="hs-row__state">${cur ? 'Now' : r ? r[2] : ''}</span></li>`;
    })}</ol>`, { eyebrow: 'Hot Seat questions', icon: 'flame', cls: 'hotseat-panel' });
}

function matchPill(sub) {
  if (!sub) return h`<span class="mark mark--wait">${ic('hourglass', { size: 14 })}Waiting</span>`;
  if (sub.override != null) return h`<span class="mark ${sub.override ? 'mark--yes' : 'mark--no'}">${ic('pencil', { size: 14 })}${sub.override ? 'You accepted' : 'You rejected'}</span>`;
  if (sub.match === 'exact') return h`<span class="mark mark--yes">${ic('check', { size: 14, stroke: 3 })}Exact</span>`;
  if (sub.match === 'match') return h`<span class="mark mark--yes">${ic('check', { size: 14, stroke: 3 })}Match</span>`;
  if (sub.match === 'close') return h`<span class="mark mark--close">${ic('triangle-alert', { size: 14 })}Close — check</span>`;
  return h`<span class="mark mark--no">${ic('x', { size: 14, stroke: 3 })}No match</span>`;
}

function answersHtml(s) {
  const c = s.challenge;
  const H = s.host;
  const subs = H.submissions || [];
  const isBonus = c.type === 'bonus';
  const done = c.stage === 'done';
  const pub = c.submissions || [];
  const canMark = !!H.can.markAnswer;
  const rows = s.teams.map((t) => {
    const sub = subs.find((x) => x.teamId === t.id);
    const ps = pub.find((x) => x.teamId === t.id);
    const award = done && ps ? ps.delta || 0 : sub ? sub.preview : null;
    const needs = sub && sub.match === 'close' && sub.override == null;
    const yes = sub && sub.correct;
    return h`<li class="ans-row ${needs ? 'is-check' : ''} ${!sub ? 'is-empty' : ''}" ${tc(t)}>
      <span class="ans-row__team">${disc(t, { size: 34 })}<span class="ans-row__name"><b>${t.name}</b>${sub && sub.first ? h`<span class="tag tag--ember ans-tag">${ic('zap', { size: 12 })}First correct</span>` : ''}${needs ? h`<span class="tag ans-tag ans-tag--check">Needs you</span>` : ''}</span></span>
      <span class="ans-row__text">${sub ? h`<b>“${sub.text}”</b><small>${sub.name}${sub.elapsedMs > 0 ? ` · ${secsText(sub.elapsedMs)}` : ''}</small>` : h`<i>No answer yet</i><small>${done || c.stage === 'marking' ? 'Counts as blank' : 'Still typing…'}</small>`}</span>
      <span class="ans-row__mark">${matchPill(sub)}</span>
      <span class="ans-row__call">
        <button type="button" class="judge judge--yes ${yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: t.id, correct: true })}" data-key="${'yes:' + t.id}" aria-label="${'Accept ' + t.name + '’s answer'}" aria-pressed="${yes ? 'true' : 'false'}" ${sub && canMark ? '' : raw('disabled')} data-needs-online>${ic('check', { size: 20, stroke: 3 })}</button>
        <button type="button" class="judge judge--no ${sub && !yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: t.id, correct: false })}" data-key="${'no:' + t.id}" aria-label="${'Reject ' + t.name + '’s answer'}" aria-pressed="${sub && !yes ? 'true' : 'false'}" ${sub && canMark ? '' : raw('disabled')} data-needs-online>${ic('x', { size: 20, stroke: 3 })}</button>
      </span>
      <span class="ans-row__award num ${award > 0 ? 'is-plus' : ''}">${award == null ? '—' : award > 0 ? `+${fmt(award)}` : '0'}</span>
    </li>`;
  });
  const answered = subs.length;
  const sub = done ? 'Revealed on the TV · you can still flip a mark' : c.stage === 'marking' ? 'Answers locked · auto-marked, flip any with one click' : `${answered} of ${s.teams.length} teams in · answers stay hidden on the TV`;
  return panel(isBonus ? 'Bonus answers' : 'Answers', sub, h`
    <div class="ans-head" aria-hidden="true"><span>Team</span><span>Typed answer</span><span>Auto-mark</span><span>Your call</span><span>Award</span></div>
    <ul class="answers" role="list">${rows}</ul>
    <p class="answers__foot">${ic('trophy', { size: 18, color: 'var(--tinsel)' })}<span>${done ? 'Paid out' : 'Paying out'} <b>${fmt(done ? pub.reduce((a, x) => a + (x.delta || 0), 0) : H.payout || 0)}</b>${isBonus ? ' · 100 for each right answer' : ' · 100 each, +50 for the first right answer'}</span></p>`, { eyebrow: isBonus ? 'Round bonus' : 'All Play', icon: 'zap', cls: 'answers-panel' });
}

function grinchResultHtml(s) {
  const c = s.challenge;
  if (c.steal) return panel(`${teamName(s, c.steal.to)} stole ${fmt(c.steal.amount)}`, `from ${teamName(s, c.steal.from)}`, '', { eyebrow: 'Grinch Steal', icon: 'hand-coins' });
  if (c.gift) return panel(`Gift of ${fmt(c.gift.amount)} to ${teamName(s, c.gift.toTeamId)}`, `${teamName(s, s.activeTeamId)} was in the lead, so the Grinch’s heart grew`, '', { eyebrow: 'Grinch Steal', icon: 'heart' });
  return '';
}

function resultHtml(s) {
  const c = s.challenge;
  const aw = (c.result?.awards || []).filter((a) => a.delta);
  if (!aw.length) return '';
  return panel('Points this turn', 'Wrong? Use − / + or Undo', h`<ul class="awards" role="list">${aw.map((a) => {
    const t = teamOf(s, a.teamId);
    return h`<li class="award-row" ${tc(t)}>${disc(t || {}, { size: 32 })}<span>${t?.name || ''}</span><b class="num ${a.delta > 0 ? 'is-plus' : 'is-minus'}">${signed(a.delta)}</b></li>`;
  })}</ul>`, { eyebrow: 'Scored', icon: 'trophy', cls: 'result-panel' });
}

function standingsHtml(s) {
  const rb = s.roundBreak;
  if (!rb) return '';
  return panel(`Standings after round ${rb.round}`, rb.finalNext ? 'Next: the final round' : `Next: round ${rb.nextRound} of ${s.totalRounds}`, h`
    <ol class="standings" role="list">${rb.standings.map((st) => {
      const t = teamOf(s, st.teamId);
      const mv = st.move === 'up' ? ['arrow-up', 'is-up', `Up ${st.places}`] : st.move === 'down' ? ['arrow-down', 'is-down', `Down ${st.places}`] : null;
      return h`<li class="stand-row" ${tc(t)}><span class="stand-row__rank num">${ordinal(st.rank)}</span>${disc(t || {}, { size: 36 })}<span class="stand-row__name">${t?.name || ''}</span>
        ${mv ? h`<span class="move ${mv[1]}">${ic(mv[0], { size: 14, stroke: 3 })}${mv[2]}</span>` : ''}<b class="stand-row__score num">${fmt(st.score)}</b></li>`;
    })}</ol>`, { eyebrow: 'Round break', icon: 'trophy', cls: 'standings-panel' });
}

function wagersHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const intro = s.phase === 'finalIntro';
  const locked = F.wagers.filter((w) => w.locked).length;
  return panel(intro ? 'Teams and their wager limits' : 'Wagers', intro ? 'Up to their score, or 300 if they’re behind' : `${locked} of ${F.wagers.length} locked in · amounts stay hidden on the TV`, h`
    <ul class="wagers" role="list">${F.wagers.map((w) => {
      const t = teamOf(s, w.teamId);
      return h`<li class="wager-row ${w.locked ? 'is-locked' : ''}" ${tc(t)}>${disc(t || {}, { size: 34 })}<span class="wager-row__name"><b>${t?.name || ''}</b><small>${fmt(t?.score || 0)} pts · max ${fmt(w.max)}</small></span>
        <span class="wager-row__state">${intro ? '' : w.locked ? h`<span class="mark mark--yes">${ic('lock', { size: 14 })}Locked${w.by ? ` by ${w.by}` : ''}</span>` : w.amount != null ? h`<span class="mark mark--wait">Thinking… ${fmt(w.amount)}</span>` : h`<span class="mark mark--wait">${ic('hourglass', { size: 14 })}Wagering</span>`}</span>
        <b class="wager-row__amt num">${intro ? '' : w.amount != null ? fmt(w.amount) : '—'}</b></li>`;
    })}</ul>`, { eyebrow: 'Final Chaos', icon: 'coins', cls: 'wagers-panel' });
}

function finalAnswersHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const canMark = !!s.host.can.markAnswer;
  const n = F.answers.filter((a) => a.text).length;
  return panel('Final answers', `${n} of ${F.answers.length} in · pre-mark now, or judge during the reveal`, h`
    <div class="ans-head" aria-hidden="true"><span>Team</span><span>Typed answer</span><span>Auto-mark</span><span>Your call</span><span>Wager</span></div>
    <ul class="answers" role="list">${F.answers.map((a) => {
      const t = teamOf(s, a.teamId);
      const w = F.wagers.find((x) => x.teamId === a.teamId);
      const yes = a.override != null ? a.override : a.autoCorrect;
      const sub = a.text ? a : null;
      return h`<li class="ans-row ${!sub ? 'is-empty' : ''}" ${tc(t)}>
        <span class="ans-row__team">${disc(t || {}, { size: 34 })}<span class="ans-row__name"><b>${t?.name || ''}</b></span></span>
        <span class="ans-row__text">${sub ? h`<b>“${a.text}”</b><small>${a.by || ''}</small>` : h`<i>No answer yet</i><small>Still typing…</small>`}</span>
        <span class="ans-row__mark">${matchPill(sub)}</span>
        <span class="ans-row__call">
          <button type="button" class="judge judge--yes ${sub && yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: a.teamId, correct: true })}" aria-label="${'Accept ' + (t?.name || '')}" ${sub && canMark ? '' : raw('disabled')}>${ic('check', { size: 20, stroke: 3 })}</button>
          <button type="button" class="judge judge--no ${sub && !yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: a.teamId, correct: false })}" aria-label="${'Reject ' + (t?.name || '')}" ${sub && canMark ? '' : raw('disabled')}>${ic('x', { size: 20, stroke: 3 })}</button>
        </span>
        <span class="ans-row__award num">${w ? fmt(w.amount || 0) : '—'}</span></li>`;
    })}</ul>`, { eyebrow: 'Final Chaos', icon: 'sparkles', cls: 'answers-panel' });
}

function finalRevealHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const canMark = !!s.host.can.markAnswer;
  return panel('Answers', 'Lowest score first · the TV sees each one only when revealed', h`
    <div class="fr-head" aria-hidden="true"><span>#</span><span>Team</span><span>Wager</span><span>Typed answer</span><span>Your call</span><span>Status</span><span>Total</span></div>
    <ol class="final-rows" role="list">${F.rows.map((r, i) => {
      const t = teamOf(s, r.teamId);
      const cur = r.teamId === F.current;
      const nextUp = !r.revealed && F.rows.findIndex((x) => !x.revealed) === i;
      const how = r.override != null ? 'Your call' : { exact: 'Exact match', match: 'Matches the answer', close: 'Close spelling', none: 'No match' }[r.match] || '';
      let status;
      if (r.judged) status = h`<span class="mark ${r.correct ? 'mark--yes' : 'mark--no'}">${r.correct ? 'Correct' : 'Missed'} ${signed(r.delta || 0)}</span>`;
      else if (r.revealed) status = h`<span class="mark mark--now">${ic('mic', { size: 14 })}Reading now</span>`;
      else status = h`<span class="mark mark--hidden">${ic('eye-off', { size: 14 })}Hidden on TV</span>`;
      const total = r.judged ? r.after : r.before;
      return h`<li class="fr-row ${cur && !r.judged ? 'is-current' : ''} ${r.judged ? 'is-judged' : ''}" ${tc(t)}>
        <span class="fr-row__n num">${i + 1}</span>
        <span class="fr-row__team">${disc(t || {}, { size: 32 })}<span><b>${t?.name || ''}</b>${cur && !r.judged ? h`<span class="tag fr-tag">On TV now</span>` : nextUp ? h`<span class="tag tag--ghost fr-tag">Up next</span>` : ''}</span></span>
        <span class="fr-row__wager num">${fmt(r.wager)}</span>
        <span class="fr-row__text"><b>${r.text ? `“${r.text}”` : 'No answer'}</b><small class="${r.correct ? 'ok-ink' : 'bad-ink'}">${how}</small></span>
        <span class="fr-row__call">
          <button type="button" class="pick pick--yes ${r.correct ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: r.teamId, correct: true })}" ${canMark && r.text ? '' : raw('disabled')}>${ic('check', { size: 16, stroke: 3 })}${r.correct ? 'Accepted' : 'Accept'}</button>
          <button type="button" class="pick pick--no ${!r.correct ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: r.teamId, correct: false })}" ${canMark && r.text ? '' : raw('disabled')}>${ic('x', { size: 16, stroke: 3 })}${!r.correct ? 'Rejected' : 'Reject'}</button>
        </span>
        <span class="fr-row__status">${status}</span>
        <span class="fr-row__total num">${fmt(total)}${!r.judged && r.revealed ? h`<small>${fmt(r.wager)} riding on it</small>` : ''}</span>
      </li>`;
    })}</ol>`, { eyebrow: 'Final reveal', icon: 'sparkles', cls: 'final-panel' });
}

function podiumHtml(s) {
  const pd = s.podium;
  if (!pd) return '';
  return panel('Final standings', 'The podium is on the TV', h`
    <ol class="standings" role="list">${pd.standings.map((st) => {
      const t = teamOf(s, st.teamId);
      return h`<li class="stand-row ${st.place === 1 ? 'is-winner' : ''}" ${tc(t)}><span class="stand-row__rank num">${ordinal(st.place)}</span>${disc(t || {}, { size: 36 })}<span class="stand-row__name">${t?.name || ''}</span>${st.place === 1 ? ic('crown', { size: 20, color: 'var(--tinsel)', label: 'Winner' }) : ''}<b class="stand-row__score num">${fmt(st.score)}</b></li>`;
    })}</ol>
    ${pd.awards.length ? h`<ul class="awards awards--fun" role="list">${pd.awards.map((a) => h`<li class="fun-award">${ic(a.key === 'fastestFinger' ? 'zap' : 'star', { size: 22, color: 'var(--tinsel)' })}<span><b>${a.title}:</b> ${a.name} <small>(${teamName(s, a.teamId)}) · ${a.detail}</small></span></li>`)}</ul>` : ''}`, { eyebrow: 'Game over', icon: 'trophy', cls: 'podium-panel' });
}

/* ============================================================================ mirror: on the TV now */

function mirrorHtml(s) {
  const m = mirrorContent(s);
  if (!m) return '';
  return h`<div class="mirror__head"><span class="mirror__label"><i class="rec-dot"></i>On the TV now</span><span class="mirror__sub">${m.sub || ''}</span></div>
    <div class="mirror__card ${m.cls || ''}" ${m.seg ? sc(m.seg) : ''}>${m.body}</div>`;
}

function miniRing(s, seg) {
  if (!s.timer) return '';
  return timerRing(s.timer, client.serverNow(), { size: 88, ink: !!seg && !isCream(seg.ink) });
}

function mirrorContent(s) {
  const c = s.challenge;
  const act = teamOf(s, s.activeTeamId);
  switch (s.phase) {
    case 'turnIntro':
      return { sub: 'Turn intro · the wheel is waiting', cls: 'mirror__card--split', body: h`<div class="mini-wheel-wrap"><svg class="mirror-wheel" id="mirror-wheel" aria-hidden="true"></svg></div>
        <div class="mirror__text">${act ? disc(act, { size: 64 }) : ''}<p class="mirror__big"><span class="team-ink" ${tc(act)}>${act?.name || ''}</span> — you’re up!</p><p class="mirror__line">Spin from any ${act?.name || ''} phone.</p></div>` };
    case 'spinning':
      return { sub: s.spin?.by ? `${s.spin.by.name} is spinning…` : 'The wheel is spinning…', cls: 'mirror__card--split', body: h`<div class="mini-wheel-wrap is-big"><svg class="mirror-wheel" id="mirror-wheel" aria-hidden="true"></svg></div>
        <div class="mirror__text"><p class="mirror__big">${s.spin?.by ? `${s.spin.by.name} is spinning…` : 'Spinning…'}</p><p class="mirror__line">Lands in a few seconds — then follow Live directions.</p></div>` };
    case 'challenge':
    case 'turnResult':
      return c ? challengeMirror(s, c) : null;
    case 'roundBreak': {
      const rb = s.roundBreak;
      if (c && c.type === 'bonus') return challengeMirror(s, c);
      return { sub: 'Round break', body: h`<p class="mirror__eyebrow">End of round ${rb?.round || s.round}</p><p class="mirror__big">${rb?.finalNext ? `Round ${rb.nextRound} — the final round!` : rb ? `Round ${rb.nextRound} of ${s.totalRounds} next` : ''}</p>
        <div class="mirror__teams">${(rb?.standings || []).slice(0, 8).map((st) => { const t = teamOf(s, st.teamId); return h`<span class="mini-tile" ${tc(t)}>${disc(t || {}, { size: 26 })}<b class="num">${fmt(st.score)}</b></span>`; })}</div>` };
    }
    case 'finalIntro':
      return { sub: 'Final Chaos · category only', cls: 'mirror__card--final', body: h`<p class="mirror__eyebrow">${ic('sparkles', { size: 18 })}Final Chaos</p><p class="mirror__big">Category: ${s.final?.categoryLabel || ''}</p><p class="mirror__line">The question stays hidden until the wagers are in.</p>` };
    case 'finalWager':
    case 'finalAnswer': {
      const F = s.final;
      const list = s.phase === 'finalWager' ? F.wagers.map((w) => ({ id: w.teamId, ok: w.locked })) : F.submissions.map((x) => ({ id: x.teamId, ok: x.answered }));
      return { sub: s.phase === 'finalWager' ? 'Wagers locking in · amounts hidden' : 'Teams typing their final answer', cls: 'mirror__card--final', body: h`
        <div class="mirror__row"><div class="mirror__text"><p class="mirror__eyebrow">${ic('sparkles', { size: 18 })}Final Chaos · ${F.categoryLabel}</p>
        <p class="mirror__q">${s.phase === 'finalAnswer' && F.question ? F.question : 'Every team: lock in your wager!'}</p></div>${miniRing(s, null)}</div>
        <div class="mirror__teams">${list.map((x) => { const t = teamOf(s, x.id); return h`<span class="mini-tile ${x.ok ? 'is-ok' : ''}" ${tc(t)}>${disc(t || {}, { size: 26 })}<b>${x.ok ? (s.phase === 'finalWager' ? 'Locked' : 'Answered') : s.phase === 'finalWager' ? 'Wagering…' : 'Typing…'}</b></span>`; })}</div>` };
    }
    case 'finalReveal': {
      const F = s.final;
      const cur = F.revealed.find((r) => r.teamId === F.current);
      const t = cur ? teamOf(s, cur.teamId) : null;
      return { sub: cur ? `${t?.name}’s answer is on the TV` : 'Reveal table', cls: 'mirror__card--final', body: h`<p class="mirror__eyebrow">${ic('sparkles', { size: 18 })}Final Chaos · ${F.categoryLabel}</p><p class="mirror__q">${F.question || ''}</p>
        ${cur ? h`<p class="mirror__line" ${tc(t)}><b class="team-ink">${t?.name}</b> wagered ${fmt(cur.wager)} · “${cur.text || 'no answer'}”${cur.judged ? h` · <b>${cur.correct ? 'Correct' : 'Wrong'} ${signed(cur.delta || 0)}</b>` : ''}</p>` : ''}` };
    }
    case 'podium': {
      const pd = s.podium;
      const win = pd?.standings.filter((x) => x.place === 1).map((x) => teamName(s, x.teamId)) || [];
      return { sub: 'Podium · confetti', cls: 'mirror__card--final', body: h`<p class="mirror__eyebrow">${ic('trophy', { size: 18 })}Game over</p><p class="mirror__big">${listJoin(win, 'and')} ${win.length === 1 ? 'wins' : 'win'} Christmas!</p>` };
    }
    default:
      return null;
  }
}

function challengeMirror(s, c) {
  const sg = segOf(s, c.segmentIndex) || segOf(s, 10);
  const label = c.type === 'bonus' ? 'Bonus question' : sg?.label || '';
  const chip = h`<span class="chip chip--sm slot-chip">${ic(segIcon(sg?.icon), { size: 16 })}${label}</span>`;
  const act = teamOf(s, s.activeTeamId);
  const ring = miniRing(s, sg);
  const done = c.stage === 'done';
  let body = '';
  let sub = '';
  switch (c.type) {
    case 'trivia': {
      if (c.stage === 'pickDifficulty') {
        sub = 'Difficulty pick';
        body = h`<div class="mirror__chips">${chip}</div><p class="mirror__big">${act?.name || ''} is choosing…</p>
          <div class="mirror__levels"><span>Easy <b>100</b></span><span>Medium <b>200</b></span><span>Hard <b>300</b></span></div>`;
      } else {
        const b = c.buzz;
        sub = done ? (c.result?.kind === 'missed' ? 'Answer revealed · nobody scored' : 'Answer revealed') : c.stage === 'steal' ? (b?.winner ? `${b.winner.name} buzzed first` : 'Steal! Buzzers') : 'Question in play · every phone is watching';
        body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="chip-sm chip-sm--ink">${cap(c.difficulty)}</span><span class="mirror__pts">${fmt(c.points)} points</span>${c.movie ? h`<span class="chip-sm chip-sm--ink">${ic('film', { size: 14 })}${c.movie}</span>` : ''}</div>
          <p class="mirror__line">${c.stage === 'steal' ? h`<b>Steal for ${fmt(c.stealPoints)}!</b> ${b?.winner ? `${b.winner.name} (${teamName(s, b.winner.teamId)}) buzzed first` : b?.open ? 'Buzzers are live' : b?.armingUntil ? 'Get ready…' : 'Buzzers closed'}` : h`<b>${act?.name || ''}</b> — answer out loud`}</p>
          <p class="mirror__q">${c.question || ''}</p>
          ${c.hint ? h`<p class="mirror__hint">${ic('lightbulb', { size: 16 })}Hint: ${c.hint}</p>` : ''}
          ${c.answer ? h`<p class="mirror__answer ${c.result?.kind === 'missed' ? 'is-miss' : ''}">${ic(c.result?.kind === 'missed' ? 'x' : 'check', { size: 20, stroke: 3 })}${c.answer}</p>` : ''}</div>${ring}</div>`;
      }
      break;
    }
    case 'sounditout':
      sub = done ? 'Song revealed' : 'The song is never shown before the reveal';
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="mirror__pts">${fmt(c.points)} points</span></div>
        <p class="mirror__big">${c.performer?.name || 'Someone'} is humming… ${act?.name || ''}, name that tune!</p>
        ${c.answer ? h`<p class="mirror__answer">${ic('music', { size: 20 })}${c.answer}${c.artist ? ` · ${c.artist}` : ''}</p>` : ''}</div>${ring}</div>`;
      break;
    case 'dare': {
      const d = c.dare || {};
      sub = c.stage === 'vote' ? 'Applause meter · phones voting' : 'Dare in play · the secret is never shown';
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="mirror__pts">${fmt(c.points)} points</span></div>
        <p class="mirror__title">${d.title || 'Dare'}</p><p class="mirror__line">${d.instructions || ''}</p>
        <p class="mirror__line mirror__line--meta">${ic('users', { size: 16 })}${c.performer ? `${c.performer.name}${c.partner ? ` & ${c.partner.name}` : ''} performs` : act?.name || ''}${d.hasSecret ? ' · secret is on their phone' : ''}</p></div>${ring}</div>`;
      break;
    }
    case 'showdown':
      sub = c.stage === 'pickRival' ? (c.eyeing ? `${c.eyeing.by.name} is eyeing ${teamName(s, c.eyeing.teamId)}…` : `${act?.name} is picking a rival`) : 'Split screen · head to head';
      body = c.stage === 'pickRival'
        ? h`<div class="mirror__chips">${chip}</div><p class="mirror__big">${act?.name || ''} — pick your rival!</p>`
        : h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="mirror__pts">Winner takes 200</span></div><p class="mirror__title">${c.showdown?.title || ''}</p>
          <p class="mirror__line">${c.performer?.name || '?'} (${act?.name || ''}) vs ${c.rival?.name || '?'} (${c.rival ? teamName(s, c.rival.teamId) : ''})</p></div>${ring}</div>`;
      break;
    case 'rapidlist': {
      const l = c.list;
      sub = 'Each tick appears on the TV right away';
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="mirror__pts">${l.each} each · max ${fmt(l.max * l.each)}</span></div><p class="mirror__title">${l.prompt}</p>
        <div class="mirror__ticks">${l.ticked.map((t) => h`<span class="chip-sm chip-sm--ink">${ic('check', { size: 14, stroke: 3 })}${t}</span>`)}</div></div>
        <div class="mirror__count"><b class="num">${Math.min(l.count, l.max)}</b><span>/ ${l.max}</span><small>counted</small></div>${ring}</div>`;
      break;
    }
    case 'hotseat': {
      const hs = c.hotseat;
      sub = hs.question ? `Question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}` : 'Waiting for the clock';
      const dots = Array.from({ length: hs.total }, (_, i) => raw(`<i class="hs-dot ${hs.results[i] ? 'is-' + hs.results[i] : i === hs.index ? 'is-current' : ''}"></i>`));
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="mirror__pts">${fmt(hs.banked || 0)} banked</span></div>
        <p class="mirror__line"><b>${c.performer?.name || ''}</b> is in the Hot Seat</p><p class="mirror__q">${hs.question || 'The question appears when the clock starts.'}</p><div class="hs-dots">${dots}</div></div>${ring}</div>`;
      break;
    }
    case 'allplay':
    case 'bonus': {
      const subs = c.submissions || [];
      sub = done ? 'Every answer is on the TV' : `${subs.filter((x) => x.answered).length} of ${s.teams.length} teams answered · answers hidden`;
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}</div><p class="mirror__line"><b>${c.type === 'bonus' ? 'Bonus question' : 'All Play'}</b> — every team, type your answer!</p>
        <p class="mirror__q">${c.question || ''}</p>${c.answer ? h`<p class="mirror__answer">${ic('check', { size: 20, stroke: 3 })}${c.answer}</p>` : ''}</div>${ring}</div>
        <div class="mirror__teams">${s.teams.map((t) => { const x = subs.find((y) => y.teamId === t.id); return h`<span class="mini-tile ${x?.answered ? 'is-ok' : ''} ${done && x?.correct ? 'is-right' : ''}" ${tc(t)}>${disc(t, { size: 26 })}<b>${done ? (x?.correct ? signed(x.delta || 0) : '✗') : x?.answered ? 'Answered' : '…'}</b></span>`; })}</div>`;
      break;
    }
    case 'grinch':
      sub = c.stage === 'pickTarget' ? (c.eyeing ? `${c.eyeing.by.name} is eyeing ${teamName(s, c.eyeing.teamId)}…` : 'Picking a victim') : 'Grinch Steal';
      body = h`<div class="mirror__chips">${chip}</div><p class="mirror__big">${c.steal ? `${teamName(s, c.steal.to)} steals ${fmt(c.steal.amount)} from ${teamName(s, c.steal.from)}!` : c.gift ? `Heart grew three sizes — ${fmt(c.gift.amount)} to ${teamName(s, c.gift.toTeamId)}` : `${act?.name || ''} picks a team that’s ahead`}</p>`;
      break;
    case 'doubledown':
      sub = 'Double Down splash';
      body = h`<div class="mirror__chips">${chip}</div><p class="mirror__big">DOUBLE DOWN! ${act?.name || ''} spins again — everything is ×2</p>`;
      break;
    default:
      body = h`<div class="mirror__chips">${chip}</div>`;
  }
  if (s.phase === 'turnResult' && c.result) sub = `Turn result · ${sub}`;
  return { sub, seg: sg, cls: c.type === 'trivia' ? 'mirror__card--plain' : 'mirror__card--slot', body };
}

function syncMirrorWheel(s) {
  const svg = document.getElementById('mirror-wheel');
  if (!svg) { if (mirrorWheel) { mirrorWheel.destroy(); mirrorWheel = null; mirrorWheelKey = ''; } return; }
  const key = s.phase === 'spinning' && s.spin ? `spin:${s.spin.startedAt}` : `rest:${s.lastSegmentIndex}`;
  if (mirrorWheel && mirrorWheel.el === svg && mirrorWheelKey === key) return;
  if (mirrorWheel && mirrorWheel.el !== svg) { mirrorWheel.destroy(); mirrorWheel = null; }
  if (!mirrorWheel) mirrorWheel = createWheel(svg, wheelSegments(s.segments), { label: 'The wheel on the TV' });
  mirrorWheelKey = key;
  if (s.phase === 'spinning' && s.spin) {
    mirrorWheel.spinTo(s.spin.segmentIndex, s.spin.durationMs, { startedAt: s.spin.startedAt, clockOffset: client.clockOffset });
  } else {
    mirrorWheel.restOn(s.lastSegmentIndex ?? 0);
    mirrorWheel.idle(true);
  }
}

/* ============================================================================ keys legend */

const KEY_NAMES = { Enter: 'Enter' };
function keysHtml(s) {
  const acts = (s.host.coach.actions || []).filter((a) => a.shortcut && !a.disabled);
  const items = acts.map((a) => [a.shortcut, a.label.replace(/\s*[+−-][\d,]+$/, '').toLowerCase()]);
  items.push(['U', 'undo']);
  if (s.timer && !acts.some((a) => a.shortcut === 'T')) items.push(['T', 'timer']);
  return h`${ic('keyboard', { size: 18 })}<span>Keys work anywhere on this page</span>${items.map(([k, l]) => h`<span class="keys__item"><kbd class="kbd">${KEY_NAMES[k] || k}</kbd>${l}</span>`)}`;
}

/* ============================================================================ lobby */

function savedGameHtml(s) {
  const sg = s.savedGame?.summary;
  if (!sg) return '';
  const teams = sg.teams || [];
  return h`<section class="panel saved" aria-labelledby="saved-h">
    <span class="saved__icon">${ic('history', { size: 34, color: 'var(--night)' })}</span>
    <div class="saved__body">
      <span class="eyebrow eyebrow--gold">Saved game found</span>
      <h2 id="saved-h" class="saved__title">Pick up where you left off?</h2>
      <p class="muted">Saved ${clockTime(sg.savedAt)} · Round ${sg.round || '?'} of ${sg.totalRounds || '?'} · ${plural(teams.length, 'team')} · ${plural(sg.players || 0, 'player')}</p>
      <ul class="saved__teams" role="list">${teams.map((t) => h`<li class="chip-sm">${t.name} <b class="num">${fmt(t.score)}</b></li>`)}</ul>
    </div>
    <p class="saved__hint">${ic('arrow-up', { size: 18 })}Resume or start fresh with the buttons in Live directions</p>
  </section>`;
}

function lobbySideHtml(s) {
  const H = s.host;
  const url = s.joinUrl || '';
  const addr = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const st = s.settings;
  const cands = H.candidates || [];
  const turns = s.teams.length * st.rounds;
  const pin = String(H.pin || '');
  return h`
  <section class="panel join" aria-labelledby="join-h">
    <div class="join__head"><h2 id="join-h" class="panel__title">Players join here</h2>
      <button type="button" class="btn btn--secondary btn--sm" data-ui="copy" data-copy="${url}">${ic('external-link', { size: 18 })}Copy link</button></div>
    <div class="join__body">
      <img class="join__qr" src="${'/api/qr.svg?v=' + encodeURIComponent(url)}" alt="${'QR code for ' + addr}" width="112" height="112">
      <div class="join__text"><span class="label">Scan, or type into a phone</span><span class="join__addr num">${addr}</span>
        <span class="join__wifi">${ic('wifi', { size: 18, color: 'var(--tinsel)' })}<span>Phones must use <b>this laptop’s Wi-Fi</b>, not the guest network.</span></span></div>
    </div>
    ${cands.length > 1 ? h`<div class="ip-switch"><span class="label">Phones can’t connect? Try another address</span>
      <div class="ip-switch__list" role="radiogroup" aria-label="Join address">${cands.map((c) => {
        const on = c.address === H.joinIp;
        return h`<button type="button" class="ip ${on ? 'is-on' : ''}" role="radio" aria-checked="${on ? 'true' : 'false'}" data-emit="host:setOption" data-payload="${json({ key: 'joinIp', value: c.address })}" data-key="${'ip:' + c.address}">${on ? ic('check', { size: 16, stroke: 3 }) : ic('wifi', { size: 16 })}<b>${c.address}</b><small>${c.iface}</small></button>`;
      })}</div></div>` : ''}
  </section>
  <section class="panel settings" aria-labelledby="set-h">
    <h2 id="set-h" class="panel__title">Game settings</h2>
    <div class="setting">
      <div class="setting__label"><b>Rounds</b><small>${st.autoRounds ? `Auto · best for ${plural(s.teams.length, 'team')}` : 'Set by you'} · 1 to 8</small></div>
      <div class="stepper" role="group" aria-label="Rounds">
        <button type="button" class="stepper__btn" data-emit="host:setRounds" data-payload="${json({ n: st.rounds - 1 })}" aria-label="One round fewer" ${st.rounds <= 1 ? raw('disabled') : ''} data-key="rounds-minus">${ic('minus', { size: 20, stroke: 2.6 })}</button>
        <span class="stepper__value num" aria-live="polite">${st.rounds}</span>
        <button type="button" class="stepper__btn" data-emit="host:setRounds" data-payload="${json({ n: st.rounds + 1 })}" aria-label="One more round" ${st.rounds >= 8 ? raw('disabled') : ''} data-key="rounds-plus">${ic('plus', { size: 20, stroke: 2.6 })}</button>
      </div>
    </div>
    <div class="estimate">${ic('timer', { size: 20, color: 'var(--tinsel)' })}<b class="num">≈ ${st.estimatedMinutes} min</b><span>${plural(turns, 'turn')}, then the Final Chaos finale</span></div>
    ${toggleRow('Bonus question between rounds', st.roundBonusAuto ? 'Auto: on for 5+ teams' : 'Set by you', st.roundBonus, { key: 'roundBonus', value: !st.roundBonus })}
    ${toggleRow('Sound on the TV', 'Wheel ticks, buzzers, fanfare', st.sound, { key: 'sound', value: !st.sound })}
    <div class="setting">
      <div class="setting__label"><b>Sound check</b><small>Plays a jingle on the TV speakers</small></div>
      <button type="button" class="btn btn--secondary btn--sm" data-emit="host:soundTest" data-key="soundtest" data-needs-online>${ic('volume-2', { size: 18, color: 'var(--tinsel)' })}Play test sound</button>
    </div>
  </section>
  <section class="panel pin-card" aria-labelledby="pin-h">
    <div class="pin-card__top"><span class="pin-card__icon">${ic('lock', { size: 24, color: 'var(--tinsel)' })}</span>
      <div><h2 id="pin-h" class="pin-card__title">Second host device?</h2><p class="pin-card__text">On your phone, open <b>${addr}/host</b> and type this PIN.</p></div></div>
    <div class="pin-digits" aria-label="${'Host PIN ' + pin.split('').join(' ')}">${pin.split('').map((d) => h`<span class="pin-digit num" aria-hidden="true">${d}</span>`)}</div>
    <ul class="pin-card__foot" role="list"><li>${ic('eye-off', { size: 16 })}Only shown on host screens, never on the TV</li><li>${ic('smartphone', { size: 16 })}${H.connections.hosts > 1 ? `${H.connections.hosts} host screens signed in` : 'No second device yet'}</li></ul>
  </section>`;
}

function toggleRow(label, sub, on, payload) {
  return h`<div class="setting"><div class="setting__label"><b>${label}</b><small>${sub}</small></div>
    <button type="button" class="switch ${on ? 'is-on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" data-emit="host:setOption" data-payload="${json(payload)}" data-key="${'opt:' + payload.key}" data-needs-online><span class="switch__text">${on ? 'On' : 'Off'}</span><i class="switch__knob"></i></button></div>`;
}

function teamsHeadHtml(s) {
  return h`<div class="teams__title"><h2 id="teams-h" class="panel__title">Teams</h2><span class="muted">${s.teams.length} of 8 · listed in turn order</span></div>
    <button type="button" class="btn btn--secondary btn--sm" data-emit="host:shuffleTeams" data-key="shuffle" ${s.host.can.shuffleTeams ? '' : raw('disabled')} data-needs-online>${ic('shuffle', { size: 18 })}Shuffle order</button>`;
}

function freeMascots(s, exceptTeamId) {
  const taken = new Set(s.teams.filter((t) => t.id !== exceptTeamId).map((t) => t.mascot));
  return MASCOTS.filter((m) => !taken.has(m.id));
}

function mascotButtons(s, selected, exceptTeamId, name) {
  const taken = new Set(s.teams.filter((t) => t.id !== exceptTeamId).map((t) => t.mascot));
  return MASCOTS.map((m) => {
    const isTaken = taken.has(m.id);
    const on = m.id === selected;
    return h`<button type="button" class="mascot ${on ? 'is-on' : ''} ${isTaken ? 'is-taken' : ''}" role="radio" aria-checked="${on ? 'true' : 'false'}" aria-label="${m.colorName + ' ' + m.noun.replace(/^an? /, '') + (isTaken ? ' (taken)' : '')}" data-ui="${name}" data-mascot="${m.id}" ${isTaken ? raw('disabled') : ''}>${disc({ color: m.color, mascot: m.id }, { size: 40 })}</button>`;
  });
}

function mascotPickerHtml(s) {
  const free = freeMascots(s);
  if (!ui.mascot || !free.some((m) => m.id === ui.mascot)) ui.mascot = free[0]?.id || null;
  return h`${mascotButtons(s, ui.mascot, null, 'pickMascot')}`;
}

function teamsListHtml(s) {
  const can = s.host.can;
  const unassigned = s.players.filter((p) => !p.teamId);
  const rows = s.teams.map((t, i) => {
    const players = s.players.filter((p) => p.teamId === t.id);
    const offline = players.filter((p) => !p.connected).length;
    return h`<li class="team-row ${players.length ? '' : 'is-empty'}" ${tc(t)}>
      <span class="team-row__num num">${i + 1}</span>
      ${disc(t, { size: 44 })}
      <span class="team-row__id"><button type="button" class="team-row__name" data-ui="editTeam" data-team="${t.id}" data-key="${'edit:' + t.id}" title="Rename or change mascot">${t.name}${ic('pencil', { size: 14 })}</button>
        <small>${players.length ? `${plural(players.length, 'player')}${offline ? ` · ${offline} offline` : ''}` : 'No players yet'}</small></span>
      <span class="team-row__players">${players.length
        ? h`<ul class="player-list" role="list">${players.map((p) => h`<li><button type="button" class="player-chip pchip ${p.connected ? '' : 'is-offline'}" data-ui="player" data-player="${p.id}" data-key="${'player:' + p.id}" aria-label="${p.name + (p.connected ? '' : ' (offline)') + ': move or remove'}">${p.name}</button></li>`)}</ul>`
        : h`<span class="team-row__wait">Waiting for someone to tap this team on their phone.</span>`}</span>
      <span class="team-row__tools">
        <button type="button" class="icon-btn icon-btn--sm" data-ui="moveTeam" data-team="${t.id}" data-dir="-1" aria-label="${'Move ' + t.name + ' up'}" ${i === 0 || !can.reorderTeams ? raw('disabled') : ''}>${ic('arrow-up', { size: 16, stroke: 2.6 })}</button>
        <button type="button" class="icon-btn icon-btn--sm" data-ui="moveTeam" data-team="${t.id}" data-dir="1" aria-label="${'Move ' + t.name + ' down'}" ${i === s.teams.length - 1 || !can.reorderTeams ? raw('disabled') : ''}>${ic('arrow-down', { size: 16, stroke: 2.6 })}</button>
        <button type="button" class="icon-btn icon-btn--danger" data-ui="removeTeam" data-team="${t.id}" aria-label="${'Remove ' + t.name}" ${can.removeTeam ? '' : raw('disabled')}>${ic('trash-2', { size: 18 })}</button>
      </span>
    </li>`;
  });
  const room = 8 - s.teams.length;
  return h`
    ${s.teams.length ? h`<ol class="team-list" role="list">${rows}</ol>` : h`<p class="teams__empty">${ic('users', { size: 26, color: 'var(--tinsel)' })}<span><b>No teams yet.</b> Add 2 to 8 teams above — 4 to 6 plays best. Players pick a team on their phone.</span></p>`}
    ${unassigned.length ? h`<div class="unassigned"><span class="label">Not on a team yet</span><ul class="player-list" role="list">${unassigned.map((p) => h`<li><button type="button" class="player-chip pchip ${p.connected ? '' : 'is-offline'}" data-ui="player" data-player="${p.id}">${p.name}</button></li>`)}</ul></div>` : ''}
    ${s.teams.length && room > 0 ? h`<p class="teams__room">${ic('users', { size: 18 })}Room for ${plural(room, 'more team')} · 4 to 6 plays best</p>` : ''}`;
}

/* ============================================================================ modals */

function renderModal(force) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  const s = client.state;
  if (!ui.modal || !s || (!s.host && ui.modal.type !== 'confirm')) {
    if (root.innerHTML) { root.innerHTML = ''; painted.delete(root); }
    document.documentElement.classList.remove('has-modal');
    return;
  }
  document.documentElement.classList.add('has-modal');
  if (ui.modal.type === 'team' && !force) { const inp = document.getElementById('edit-name'); if (inp) ui.modal.name = inp.value; }
  const changed = patch(root, modalHtml(s, ui.modal));
  if (changed && force) {
    const f = root.querySelector('[data-autofocus]') || root.querySelector('button, input');
    try { f?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
}

function modalShell(inner, { cls = '', label = 'Dialog' } = {}) {
  return h`<div class="modal-backdrop" data-ui="closeModal"></div>
    <div class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${label}">${inner}</div>`;
}

function modalHtml(s, m) {
  if (m.type === 'confirm') {
    return modalShell(h`<div class="modal__body confirm">
      <span class="confirm__icon ${m.tone === 'danger' ? 'is-danger' : ''}">${ic(m.tone === 'danger' ? 'triangle-alert' : 'circle-help', { size: 30 })}</span>
      <h2 class="modal__title">${m.title}</h2><p class="confirm__msg">${m.message}</p>
      <div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="cancelConfirm">Cancel <kbd class="kbd">Esc</kbd></button>
        <button type="button" class="btn ${m.tone === 'danger' ? 'btn--primary' : 'btn--gold'} btn--md" data-ui="okConfirm" data-autofocus>${m.okLabel}</button></div></div>`, { cls: 'modal--sm', label: m.title });
  }
  if (m.type === 'script') return scriptModal(s);
  if (m.type === 'player') return playerModal(s, m);
  if (m.type === 'team') return teamModal(s, m);
  if (m.type === 'more') return moreModal(s);
  return '';
}

function scriptModal(s) {
  const sc0 = s.host.introScript;
  if (!sc0) return modalShell(h`<div class="modal__body"><p>The opening script is only available in the lobby.</p><div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="closeModal" data-autofocus>Close</button></div></div>`, { cls: 'modal--sm' });
  const labels = new Set((s.segments || []).map((x) => x.label));
  const segByLabel = (l) => (s.segments || []).find((x) => x.label === l);
  const start = coachAction('start');
  const sectionHtml = (sec, i) => {
    const isWheel = sec.parts.filter((p) => p.kind === 'em' && labels.has(p.text)).length >= 3;
    let body;
    if (isWheel) {
      const intro = sec.parts[0]?.kind === 'say' && !labels.has(sec.parts[0].text) ? sec.parts[0].text : '';
      const items = [];
      sec.parts.forEach((p, k) => { if (p.kind === 'em' && labels.has(p.text)) items.push([p.text, (sec.parts[k + 1]?.text || '').replace(/^\s*—\s*/, '').trim()]); });
      body = h`${intro ? h`<p class="script__p">${intro.trim()}</p>` : ''}<ul class="script__wheel" role="list">${items.map(([l, d]) => { const g = segByLabel(l); return h`<li ${g ? sc(g) : ''}><span class="script__seg">${ic(segIcon(g?.icon), { size: 16 })}</span><span><b>${l}</b> — ${d}</span></li>`; })}</ul>`;
    } else {
      const segs = sec.parts.map((p) => {
        if (p.kind === 'cue') return h`<span class="cue">[${p.text}]</span>`;
        if (p.kind === 'em' && p.text.trim() === sc0.joinAddress) return h`<span class="script__addr">${ic('smartphone', { size: 20 })}${p.text}</span>`;
        if (p.kind === 'em' && /let.s play/i.test(p.text)) return h`<span class="script__shout">${p.text}</span>`;
        if (p.kind === 'em') return h`<b>${p.text}</b>`;
        return h`${p.text}`;
      });
      body = h`<p class="script__p">${segs}</p>`;
    }
    return h`<section class="script__sec"><h3 class="script__h"><span class="script__n">${i + 1}</span>${sec.title}</h3>${body}</section>`;
  };
  return modalShell(h`
    <div class="script__top">
      <span class="script__mic">${ic('mic', { size: 28, color: 'var(--white)' })}</span>
      <div class="script__titles"><span class="eyebrow eyebrow--gold">Opening script · before you press Start</span><h2 class="script__title">${sc0.title}</h2></div>
      <span class="script__time">${ic('timer', { size: 20, color: 'var(--tinsel)' })}<b>About ${plural(sc0.minutes, 'minute')}</b><small>${sc0.words} words · no need to rush</small></span>
      <button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close">${ic('x', { size: 22 })}</button>
    </div>
    <div class="script__paper">
      <p class="script__legend">${ic('info', { size: 16 })}Read the big words out loud. <span class="cue">[cues like this]</span> are just for you.</p>
      <div class="script__cols">${sc0.sections.map(sectionHtml)}</div>
    </div>
    <div class="script__foot">
      <p class="script__sum">${ic('users', { size: 20, color: 'var(--tinsel)' })}<span>${sc0.summary}</span></p>
      <button type="button" class="btn btn--secondary btn--md" data-ui="closeModal">Close <kbd class="kbd">Esc</kbd></button>
      ${start ? h`<button type="button" class="btn btn--primary btn--md script__start" data-act="coach" data-id="start" ${start.disabled ? raw('aria-disabled="true"') : ''} data-autofocus title="${start.disabled ? start.reason || '' : ''}">${ic('play', { size: 20 })}Done — start the game</button>` : ''}
    </div>`, { cls: 'modal--script', label: 'Opening script' });
}

function playerModal(s, m) {
  const p = playerOf(s, m.playerId);
  if (!p) return modalShell(h`<div class="modal__body"><p>That player has left.</p><div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="closeModal" data-autofocus>Close</button></div></div>`, { cls: 'modal--sm' });
  const cur = teamOf(s, p.teamId);
  return modalShell(h`<div class="modal__body">
    <div class="modal__head"><span class="pm__avatar ${p.connected ? '' : 'is-offline'}">${ic('user', { size: 24 })}</span><div><h2 class="modal__title">${p.name}</h2><p class="muted">${p.connected ? 'Online' : 'Phone offline'} · ${cur ? cur.name : 'No team yet'}</p></div>
      <button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close">${ic('x', { size: 22 })}</button></div>
    <span class="label">Move to</span>
    <div class="pm__teams">${s.teams.map((t) => h`<button type="button" class="pm__team ${t.id === p.teamId ? 'is-on' : ''}" data-ui="movePlayer" data-player="${p.id}" data-team="${t.id}" ${t.id === p.teamId ? raw('aria-current="true" disabled') : ''} ${tc(t)}>${disc(t, { size: 28 })}<span>${t.name}</span>${t.id === p.teamId ? ic('check', { size: 18, stroke: 3 }) : ''}</button>`)}</div>
    <div class="modal__acts modal__acts--split">
      ${p.teamId ? h`<button type="button" class="btn btn--ghost btn--sm" data-ui="movePlayer" data-player="${p.id}" data-team="">${ic('user-x', { size: 18 })}Take off the team</button>` : ''}
      <button type="button" class="btn btn--danger btn--sm" data-ui="kickPlayer" data-player="${p.id}">${ic('trash-2', { size: 18 })}Remove from game</button>
    </div></div>`, { cls: 'modal--sm', label: `${p.name}: move or remove` });
}

function teamModal(s, m) {
  const t = teamOf(s, m.teamId);
  if (!t) return modalShell(h`<div class="modal__body"><p>That team was removed.</p><div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="closeModal" data-autofocus>Close</button></div></div>`, { cls: 'modal--sm' });
  if (!m.mascot) m.mascot = t.mascot;
  return modalShell(h`<form class="modal__body" data-form="team" data-team="${t.id}">
    <div class="modal__head">${disc({ ...t, mascot: m.mascot, color: mascotFor(m.mascot).color }, { size: 48 })}<div><h2 class="modal__title">Edit team</h2><p class="muted">Rename any time — even mid-game.</p></div>
      <button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close">${ic('x', { size: 22 })}</button></div>
    <div class="field"><label class="label" for="edit-name">Team name</label><input class="input input--sm" id="edit-name" name="name" maxlength="24" value="${m.name ?? t.name}" data-autofocus></div>
    <fieldset class="add-team__mascots"><legend class="label">Mascot &amp; colour</legend><div class="mascot-picker" role="radiogroup">${mascotButtons(s, m.mascot, t.id, 'editMascot')}</div></fieldset>
    <div class="modal__acts modal__acts--split">
      ${s.host.can.removeTeam ? h`<button type="button" class="btn btn--danger btn--sm" data-ui="removeTeam" data-team="${t.id}">${ic('trash-2', { size: 18 })}Remove team</button>` : raw('<span></span>')}
      <button type="submit" class="btn btn--gold btn--md">${ic('check', { size: 18, stroke: 3 })}Save</button>
    </div></form>`, { cls: 'modal--sm', label: 'Edit team' });
}

function moreModal(s) {
  const H = s.host;
  const can = H.can;
  const inGame = s.phase !== 'lobby';
  const item = (label, sub, iconName, attrs, enabled = true, tone = '') => h`<button type="button" class="menu-item ${tone}" ${attrs} ${enabled ? '' : raw('disabled')}>${ic(iconName, { size: 20 })}<span><b>${label}</b>${sub ? h`<small>${sub}</small>` : ''}</span></button>`;
  const e = (event, payload, confirm) => raw(`data-emit="${esc(event)}"${payload ? ` data-payload="${esc(json(payload))}"` : ''}${confirm ? ` data-confirm="${esc(confirm)}"` : ''}`);
  const st = s.settings;
  const segs = s.segments || [];
  return modalShell(h`
    <div class="modal__head"><h2 class="modal__title">More</h2><button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close" data-autofocus>${ic('x', { size: 22 })}</button></div>
    <div class="menu">
      ${inGame ? h`<div class="menu__group"><span class="label">This mini-game</span>
        ${item('Swap question', 'Draws an unused replacement', 'refresh-cw', e('host:swapQuestion'), can.swapQuestion)}
        ${item('Swap secret', 'New song / secret, same performer', 'refresh-cw', e('host:swapSecret'), can.swapSecret)}
        ${item('Re-roll performer', 'Pick someone else at random', 'dices', e('host:rerollPerformer'), can.rerollPerformer)}
        ${item('Skip this mini-game', 'Ends it with no more points', 'skip-forward', e('host:endChallenge', null, 'Skip this mini-game? Nobody scores.'), can.endChallenge, 'is-danger')}
        ${item('Skip to the next turn', 'Cancels whatever is happening', 'arrow-right', e('host:nextTurn', { turnId: s.turnId }, 'Skip to the next turn?'), can.nextTurn, 'is-danger')}
      </div>
      <div class="menu__group"><span class="label">Rounds</span>
        <div class="setting setting--menu"><div class="setting__label"><b>Rounds</b><small>Now in round ${s.round} of ${s.totalRounds}</small></div>
          <div class="stepper" role="group" aria-label="Rounds">
            <button type="button" class="stepper__btn" ${e('host:setRounds', { n: st.rounds - 1 })} aria-label="One round fewer" ${st.rounds <= Math.max(1, s.round) || !can.setRounds ? raw('disabled') : ''}>${ic('minus', { size: 20, stroke: 2.6 })}</button>
            <span class="stepper__value num">${st.rounds}</span>
            <button type="button" class="stepper__btn" ${e('host:setRounds', { n: st.rounds + 1 })} aria-label="One more round" ${st.rounds >= 8 || !can.setRounds ? raw('disabled') : ''}>${ic('plus', { size: 20, stroke: 2.6 })}</button>
          </div></div>
        ${toggleRow('Bonus question between rounds', st.roundBonusAuto ? 'Auto: on for 5+ teams' : 'Set by you', st.roundBonus, { key: 'roundBonus', value: !st.roundBonus })}
      </div>` : ''}
      <div class="menu__group"><span class="label">Sound</span>
        ${toggleRow('Sound on the TV', 'Wheel ticks, buzzers, fanfare', st.sound, { key: 'sound', value: !st.sound })}
        <div class="setting"><div class="setting__label"><b>Alerts on this device</b><small>A buzz here when someone buzzes in</small></div>
          <button type="button" class="switch ${ui.alerts ? 'is-on' : ''}" role="switch" aria-checked="${ui.alerts ? 'true' : 'false'}" aria-label="Alerts on this device" data-ui="alerts"><span class="switch__text">${ui.alerts ? 'On' : 'Off'}</span><i class="switch__knob"></i></button></div>
        ${item('Play test sound on the TV', '', 'volume-2', e('host:soundTest'), true)}
      </div>
      ${inGame ? h`<div class="menu__group"><span class="label">Force the wheel (testing)</span>
        <div class="force">${segs.map((g) => h`<button type="button" class="force__seg" ${sc(g)} ${e('host:forceSegment', { index: g.index })} ${can.forceSegment ? '' : raw('disabled')} title="${'Land on ' + g.label}">${ic(segIcon(g.icon), { size: 16 })}<span>${g.index} · ${g.label}</span></button>`)}</div>
        ${can.forceSegment ? '' : h`<small class="muted">Available while a team is waiting to spin.</small>`}</div>` : ''}
      <div class="menu__group"><span class="label">Second host device</span>
        <p class="menu__pin">PIN <b class="num">${H.pin || '----'}</b> · open <b>${String(s.joinUrl || '').replace(/^https?:\/\//, '')}host</b></p>
        ${ui.remote || readKey() ? item('Sign out of this device', 'Forget the PIN on this device', 'log-out', raw('data-ui="signOut"'), true) : ''}
      </div>
      <div class="menu__group"><span class="label">Start over</span>
        ${item('Reset, keep the teams', 'Scores back to 0 · players stay', 'rotate-ccw', e('host:resetGame', { keepTeams: true }, 'Reset the game and keep the teams and players? Scores go back to 0.'), can.resetGame, 'is-danger')}
        ${item('Reset everything', 'Removes all teams', 'trash-2', e('host:resetGame', { keepTeams: false }, 'Reset everything? All teams are removed and players pick a team again.'), can.resetGame, 'is-danger')}
      </div>
    </div>`, { cls: 'modal--menu', label: 'More host tools' });
}

/* ============================================================================ events */

function payloadOf(el) {
  const p = el.getAttribute('data-payload');
  if (!p) return null;
  try { return JSON.parse(p); } catch { return null; }
}

document.addEventListener('click', async (e) => {
  const pinKey = e.target.closest('[data-pin]');
  if (pinKey) {
    if (pinKey.getAttribute('aria-disabled') === 'true') return;
    pinPress(pinKey.dataset.pin);
    return;
  }
  const el = e.target.closest('[data-act], [data-emit], [data-ui]');
  if (!el || el.disabled) return;
  if (el.dataset.act === 'coach') {
    e.preventDefault();
    if (ui.modal?.type === 'script') closeModal(false);
    await runAction(coachAction(el.dataset.id));
    return;
  }
  if (el.dataset.emit) {
    e.preventDefault();
    if (el.getAttribute('aria-disabled') === 'true') return;
    const inMenu = !!el.closest('.modal--menu');
    const confirm = el.dataset.confirm;
    if (inMenu && confirm) closeModal(false);
    const res = await send(el.dataset.emit, payloadOf(el), confirm ? { confirm, tone: 'danger', okLabel: 'Yes, do it' } : {});
    if (res?.ok && inMenu && /forceSegment|resetGame|nextTurn|endChallenge/.test(el.dataset.emit) && ui.modal?.type === 'more') closeModal(false);
    if (res?.ok && el.dataset.emit === 'host:soundTest') toast(client.state?.host?.connections?.tv ? 'Test jingle sent to the TV' : 'Sent — but the TV screen isn’t open yet', { tone: client.state?.host?.connections?.tv ? 'success' : 'warn', icon: 'volume-2' });
    return;
  }
  const u = el.dataset.ui;
  const s = client.state;
  switch (u) {
    case 'more': openModal({ type: 'more' }); break;
    case 'closeModal': closeModal(false); break;
    case 'cancelConfirm': closeModal(false); break;
    case 'okConfirm': closeModal(true); break;
    case 'dock': ui.dockOpen = !ui.dockOpen; render(); break;
    case 'undo': undo(); break;
    case 'revealPrivate': ui.privateRevealed = true; render(); break;
    case 'hidePrivate': ui.privateRevealed = false; render(); break;
    case 'enterHost': leaveSignedIn(); break;
    case 'signOut': signOut(); break;
    case 'alerts': {
      ui.alerts = !ui.alerts;
      lsSet(ALERTS_STORE, ui.alerts ? '1' : '0');
      if (ui.alerts) { await sound.unlock(); sound.buzz(); }
      renderModal(false);
      break;
    }
    case 'copy': copyText(el.dataset.copy); break;
    case 'pickMascot': ui.mascot = el.dataset.mascot; render(); break;
    case 'editMascot': if (ui.modal) { ui.modal.mascot = el.dataset.mascot; ui.modal.name = $('#edit-name')?.value; renderModal(false); } break;
    case 'editTeam': openModal({ type: 'team', teamId: el.dataset.team }); break;
    case 'player': openModal({ type: 'player', playerId: el.dataset.player }); break;
    case 'movePlayer': {
      const res = await send('host:movePlayer', { playerId: el.dataset.player, teamId: el.dataset.team || null });
      if (res?.ok) closeModal(false);
      break;
    }
    case 'kickPlayer': {
      const p = s && playerOf(s, el.dataset.player);
      closeModal(false);
      await send('host:kickPlayer', { playerId: el.dataset.player }, { confirm: `Remove ${p ? p.name : 'this player'} from the game? Their phone goes back to the join screen.`, title: 'Remove player', okLabel: 'Remove', tone: 'danger' });
      break;
    }
    case 'removeTeam': {
      const t = s && teamOf(s, el.dataset.team);
      if (ui.modal) closeModal(false);
      const n = s ? s.players.filter((p) => p.teamId === el.dataset.team).length : 0;
      await send('host:removeTeam', { teamId: el.dataset.team }, { confirm: `Remove ${t ? t.name : 'this team'}?${n ? ` Its ${plural(n, 'player')} will pick a new team.` : ''}`, title: 'Remove team', okLabel: 'Remove team', tone: 'danger' });
      break;
    }
    case 'moveTeam': {
      if (!s) break;
      const order = s.teams.map((t) => t.id);
      const i = order.indexOf(el.dataset.team);
      const j = i + Number(el.dataset.dir);
      if (i < 0 || j < 0 || j >= order.length) break;
      [order[i], order[j]] = [order[j], order[i]];
      await send('host:reorderTeams', { order });
      break;
    }
    default: break;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'add-team') {
    e.preventDefault();
    const input = $('#team-name');
    const name = (input?.value || '').trim();
    if (!name) { toast('Type a team name first', { tone: 'error' }); input?.focus(); return; }
    const res = await send('host:createTeam', { name, mascot: ui.mascot || undefined });
    if (res?.ok) {
      if (input) input.value = '';
      ui.mascot = null;
      input?.focus();
      toast(h`<strong>${name}</strong> added`, { tone: 'success', icon: 'circle-check' });
    }
    return;
  }
  if (form.dataset.form === 'team') {
    e.preventDefault();
    const s = client.state;
    const t = s && teamOf(s, form.dataset.team);
    if (!t) { closeModal(false); return; }
    const name = (form.querySelector('[name=name]')?.value || '').trim();
    const payload = { teamId: t.id };
    if (name && name !== t.name) payload.name = name;
    if (ui.modal?.mascot && ui.modal.mascot !== t.mascot) { payload.mascot = ui.modal.mascot; payload.color = mascotFor(ui.modal.mascot).color; }
    if (Object.keys(payload).length === 1) { closeModal(false); return; }
    const res = await send('host:updateTeam', payload);
    if (res?.ok) closeModal(false);
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Join link copied', { tone: 'success', icon: 'circle-check' });
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? 'Join link copied' : `Join link: ${text}`, { tone: ok ? 'success' : 'info' });
  }
}

async function undo() {
  const s = client.state;
  if (!s?.host) return;
  if (!s.host.canUndo) { toast('Nothing to undo', { tone: 'info', icon: 'undo-2' }); return; }
  const label = s.host.undoLabel;
  const res = await send('host:undo');
  if (res?.ok) toast(h`Undone: ${label || 'last change'}`, { tone: 'success', icon: 'undo-2' });
}

function timerToggle() {
  const t = client.state?.timer;
  if (!t) return;
  const action = !t.started || t.ended ? 'start' : t.running ? 'pause' : 'resume';
  send('host:timer', { action });
}

/* ============================================================================ keyboard shortcuts */

function buildShortcuts(s) {
  const map = new Map();
  for (const a of s.host.coach.actions || []) {
    if (!a.shortcut) continue;
    const k = a.shortcut.length === 1 ? a.shortcut.toUpperCase() : a.shortcut;
    if (!map.has(k)) map.set(k, () => runAction(coachAction(a.id)));
  }
  if (!map.has('U')) map.set('U', undo);
  if (s.timer && !map.has('T')) map.set('T', timerToggle);
  const c = s.challenge;
  if (c && c.type === 'rapidlist') {
    const answers = (s.host.listAnswers || []).slice(0, 9);
    answers.forEach((a, i) => {
      const k = String(i + 1);
      if (map.has(k)) return;
      map.set(k, () => send((c.list.ticked || []).includes(a) ? 'host:listUntick' : 'host:listTick', { answer: a }));
    });
  }
  shortcuts = map;
}

document.addEventListener('keydown', (e) => {
  const tgt = e.target;
  const typing = tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName));
  if (e.key === 'Escape') {
    if (ui.modal) { e.preventDefault(); closeModal(false); }
    return;
  }
  // PIN keypad from the keyboard
  if (mode === 'login') {
    if (/^\d$/.test(e.key)) { e.preventDefault(); pinPress(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); pinPress('del'); }
    else if (e.key === 'Enter') { e.preventDefault(); pinPress('go'); }
    return;
  }
  if (typing) return;
  if (ui.modal) {
    if (e.key === 'Enter' && ui.modal.type === 'confirm' && !(tgt && tgt.closest?.('button'))) { e.preventDefault(); closeModal(true); }
    if (e.key === 'Enter' && ui.modal.type === 'script' && !(tgt && tgt.closest?.('button'))) { e.preventDefault(); closeModal(false); runAction(coachAction('start')); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const key = e.key === 'Enter' ? 'Enter' : e.key.length === 1 ? e.key.toUpperCase() : null;
  if (!key) return;
  if (key === 'Enter' && tgt && tgt !== document.body && tgt.closest?.('button, a, [role=button], summary')) return; // let Enter press the focused button
  if (key === ' ') return;
  const fn = shortcuts.get(key);
  if (fn) { e.preventDefault(); fn(); }
});

/* ============================================================================ fx & ticking */

client.onFx((type, p) => {
  const s = client.state;
  if (!s?.host) return;
  if (type === 'points' && p?.teamId) {
    ui.bump[p.teamId] = Date.now() + 900;
    setTimeout(scheduleRender, 950);
  }
  if (type === 'buzz' && p?.name) {
    toast(h`<strong>${p.name}</strong> (${teamName(s, p.teamId)}) buzzed first!`, { icon: 'bell-ring' });
    if (ui.alerts) sound.buzz();
  }
  if (type === 'timerWarn' && ui.alerts) sound.beep();
  if (type === 'timerEnd') toast('Time’s up!', { tone: 'info', icon: 'timer' });
});

function tick() {
  const s = client.state;
  if (mode === 'login') {
    if (login.retryUntil && login.retryUntil <= Date.now()) { login.retryUntil = 0; login.error = ''; render(); return; }
    if (login.retryUntil) { const hint = document.querySelector('[data-login-hint]'); if (hint) hint.textContent = `Too many tries — try again in ${Math.ceil((login.retryUntil - Date.now()) / 1000)} s`; }
    return;
  }
  if (!s?.host) return;
  const now = client.serverNow();
  const t = s.timer;
  if (t) {
    const text = mmss(timerRemaining(t, now));
    const frac = timerFraction(t, now);
    const warn = timerWarn(t, now);
    for (const el of document.querySelectorAll('[data-timer-text]')) if (el.textContent !== text) el.textContent = text;
    for (const el of document.querySelectorAll('[data-timer-bar]')) { el.style.setProperty('--fill', frac.toFixed(4)); el.classList.toggle('is-warn', warn); }
    for (const el of document.querySelectorAll('[data-timer-pill]')) el.classList.toggle('is-warn', warn);
    for (const el of document.querySelectorAll('[data-timer-ring]')) updateTimerRing(el, t, now);
  }
  for (const el of document.querySelectorAll('[data-arming]')) {
    const left = Math.max(0, Math.ceil((Number(el.dataset.arming) - now) / 1000));
    const txt = String(left);
    if (el.textContent !== txt) el.textContent = txt;
  }
}
setInterval(tick, 200);

/* ============================================================================ boot */

client.onHello((res) => {
  if (!res?.ok) return;
  if (res.isHost) {
    ui.remote = !!res.hostKey;
    if (res.hostKey) lsSet(KEY_STORE, String(res.hostKey));
  }
  if (res.needPin) {
    if (res.pinError === 'bad-pin' && readKey()) {
      lsDel(KEY_STORE);
      login.error = 'The saved PIN no longer works (the game restarted). Type the new PIN.';
    } else if (res.pinError === 'too-many-tries') {
      login.error = 'Too many wrong PINs. Wait a minute, then try again.';
    }
  }
  scheduleRender();
});
client.onState(() => scheduleRender());
client.onConnection((on) => { if (!on) scheduleRender(); });

// Expose a tiny hook for automated UI tests (read-only).
globalThis.__host = { get state() { return client.state; }, get mode() { return mode; }, ui };
