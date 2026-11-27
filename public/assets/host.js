// Christmas Chaos — host.js  ("North Pole Workshop" host control room)
// PIN login for second devices (box-office keypad), the lobby (join gift tag, teams + 3D mascot picker, settings,
// opening script), and the in-game control room: the coach note card pinned to the workshop board (Now · Say this
// with the punchline + stage directions · Do this · actions · cheeky sticky-note tips · string-light progress), the
// red "Live" light, the private answer envelope, the score rail (3D mascots, −/+, Undo with a joke), the timer,
// the More menu, every stage table (steal, dare + room vote, showdown, Rapid List, Hot Seat, All Play / bonus
// marking, wagers, the final reveal with drumroll prompts, the podium awards ceremony) and the "On the TV now" mirror.
//
// Rendering: the server pushes a role-filtered `state` after every change. render() rebuilds each region's markup
// with h`` (escaped by default) and only touches the DOM when that region's markup actually changed, so inputs,
// focus and the mini wheel survive unrelated pushes. Coach actions are rendered generically from coach.actions.

import {
  connect, h, raw, esc, toast, ic, art as artLazy, mascot, slotChip, present, stocking, bellMeter, turnDots,
  formatPoints, formatDelta, plural, ordinal, listJoin, timerRemaining, timerFraction, timerWarn, timerRing,
  updateTimerRing, isPluralTeam, subject, possessive,
} from '/assets/client.js';
import { MASCOTS, mascotFor, safeColor } from '/assets/icons.js';
import { createWheel } from '/assets/wheel.js';
import { garland, snowfall } from '/assets/sky.js';
import * as fx from '/assets/fx.js';
import * as sound from '/assets/sound.js';

/* ============================================================================ storage & connection */

const KEY_STORE = 'cc.hostKey';
const ALERTS_STORE = 'cc.hostAlerts';
const lsGet = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
const lsSet = (k, v) => { try { globalThis.localStorage?.setItem(k, v); } catch { /* private mode */ } };
const lsDel = (k) => { try { globalThis.localStorage?.removeItem(k); } catch { /* private mode */ } };
const readKey = () => { const v = lsGet(KEY_STORE); return v && /^\d{4,12}$/.test(v) ? v : null; };

const client = connect('host', { hostKey: () => readKey(), banner: 'Reconnecting to the workshop… hold tight' });

/* ============================================================================ local UI state */

const ui = {
  modal: null,              // {type:'confirm'|'script'|'player'|'team'|'more', ...}
  dockOpen: false,
  envOpen: false,           // phone layout: the private envelope is opened
  envKey: '',
  mascot: null,             // selected mascot in the add-team form
  justSignedIn: false,
  signedInAt: 0,
  remote: false,            // signed in with a PIN/key (not the laptop running the server)
  alerts: lsGet(ALERTS_STORE) === '1',
  bump: {},                 // teamId -> until (score bump)
  lastHeadline: '',
  stageKey: '',
  stepsKey: '',
  stepsDone: new Set(),     // "Do this" steps the host ticked off
  liveUntil: 0,             // the TV is mid-moment until (fx window)
  liveText: '',
  liveMood: '',
  liveShown: null,          // last rendered live-light state (re-render when it flips)
  ideaSeed: Math.floor(Math.random() * 1000),
  undoJoke: Math.floor(Math.random() * 100),
};
const login = { digits: '', error: '', retryUntil: 0, busy: false, shake: 0, fails: Math.floor(Math.random() * 5) };
const inflight = new Set();
let mode = null;            // 'login' | 'signedIn' | 'lobby' | 'game'
let shortcuts = new Map();  // key -> () => void
let miniWheel = null;
let miniWheelKey = '';
let lights = null;          // the short garland across the top
let loginSnow = null;

/* ============================================================================ comedy (host side) */

const WRONG_PIN = [
  'Nice try, Grinch. That PIN didn’t match.',
  'The elves checked it twice. Not the right PIN.',
  'Ho ho… no. That one didn’t match.',
  'Close! Probably. Have another go.',
  'That PIN is on the naughty list. Try again.',
];
const UNDO_JOKES = [
  'The elves have reviewed the tape.',
  'Rewound faster than a VHS of Home Alone.',
  'Unwrapped and rewrapped. Nobody saw a thing.',
  'Santa’s lawyers approved the appeal.',
  'A Christmas miracle: that never happened.',
  'Ctrl+Z, but make it festive.',
];
const TEAM_IDEAS = [
  'The Nutcrackers', 'Sleigh Queens', 'Elf Control', 'Snow Problem', 'The Mistletoads', 'Fa La La Llamas',
  'Yule Log Jammers', 'Rudolph’s Rejects', 'The Grinch Pinchers', 'Jingle Bell Rockers', 'Tinsel Tantrums',
  'Holly Jolly Rogers', 'The Fruitcakes', 'Cookie Monsters', 'Silent Knights', 'Sleigh My Name',
];
/** Host-only margin notes for the opening script (printed in Santa's handwriting next to each section). */
const SCRIPT_ADLIBS = {
  Welcome: 'Ad-lib: “I’ve trained all year for this. Mostly by watching Elf.”',
  'Join in': 'Someone’s on the guest Wi-Fi. There’s always one. Gently shame them.',
  'How a turn works': 'Mime a dramatic spin. It does nothing. It looks amazing.',
  'The wheel': 'Read it fast, like a raffle caller. Nobody remembers it anyway.',
  'The finale': 'Hold eye contact with the current leader. A little too long.',
  'Let’s play': 'Bow. Accept imaginary applause. Then press Start.',
};
const STICKY_HEADS = ['Psst!', 'Elf advice', 'Pro tip', 'Between us', 'Heads-up'];
const LIVE_MOODS = { cheer: 'Cue the cheer!', groan: 'Cue the groan', gasp: 'Cue the gasp', laugh: 'Cue the laugh' };
const LIVE_FX = {
  land: 'The wheel landed!', correct: 'Correct! Let it land', wrong: 'Coal incoming…', steal: 'Grinch Steal!',
  reveal: 'Big reveal on the TV', doubleDown: 'Double Down!', round: 'New round!', roundBreak: 'Hot cocoa break',
  final: 'Final Chaos!', podium: 'Podium time!', timerEnd: 'Time’s up!', buzz: 'Someone buzzed!',
};

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
/** 3D art, loaded eagerly (small and cached; lazy images far down a long host page could stay blank). */
const art = (id, o = {}) => artLazy(id, { eager: true, ...o });
const pick = (list, n) => list[((n % list.length) + list.length) % list.length];
const isPhone = () => globalThis.innerWidth < 600;

/** style="--team-color:…" for a team (validated colour). */
const tstyle = (t) => raw(`style="--team-color:${safeColor(t?.color, mascotFor(t?.mascot).color)}"`);
/** A team's 3D mascot (decorative: the name is printed beside it). */
const mas = (t, size = 44, extra = '') => mascot(t || {}, { size, alt: '', className: extra });

/** "0:18" (whole seconds, rounded up). */
function mmss(ms) {
  const sec = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
const secsText = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} s`;
function clockTime(ms) {
  try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
}
const displayUrl = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/** Make the coach safe to render (arrays always present) and make sure the primary action is a live one. */
function normalizeCoach(s) {
  const C = s?.host?.coach;
  if (!C || C.__norm) return C;
  C.actions = Array.isArray(C.actions) ? C.actions : [];
  C.steps = Array.isArray(C.steps) ? C.steps : [];
  C.tips = Array.isArray(C.tips) ? C.tips : [];
  C.progress = Array.isArray(C.progress) ? C.progress : [];
  if (!C.primary || !C.actions.some((a) => a.id === C.primary && !a.disabled)) {
    const p = C.actions.find((a) => a.kind === 'primary' && !a.disabled);
    C.primary = p ? p.id : null;
  }
  C.__norm = true;
  return C;
}

const ERRORS = {
  'not-now': 'That can’t be done right now: the game has moved on.',
  'stale-turn': 'The turn already moved on.',
  'stale-question': 'That question was already marked.',
  offline: 'You’re offline. Reconnecting…',
  timeout: 'The game didn’t answer. Try again.',
  'name-required': 'Type a team name first.',
  'name-taken': 'Another team already has that name.',
  'mascot-taken': 'Another team already has that mascot.',
  'bad-mascot': 'Pick a mascot.',
  'too-many-teams': '8 teams is the maximum. The workshop is full.',
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
  'slow-down': 'Easy there, one tap at a time.',
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
  const res = await send(a.event, a.payload, { confirm: a.confirm, title: a.label, okLabel: a.label, tone: a.kind === 'danger' ? 'danger' : 'primary' });
  if (res?.ok && a.event === 'host:soundTest') soundTestToast();
}

function soundTestToast() {
  const tv = client.state?.host?.connections?.tv;
  toast(tv ? 'Jingle sent! Silent TV? Check the volume, and the elf who muted it.' : 'Sent, but the TV screen isn’t open yet. Open /tv on the TV first.', { tone: tv ? 'success' : 'warn', icon: 'volume-2', duration: 4200 });
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
  for (const n of el.querySelectorAll('[data-fill]')) n.style.setProperty('--fill', String(Math.max(0, Math.min(1, Number(n.dataset.fill) || 0))));
  if (key) {
    const again = [...el.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === key);
    try { again?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  return true;
}

/* ============================================================================ skeletons */

function setMode(m) {
  if (mode === m) return;
  mode = m;
  const app = document.getElementById('app');
  app.dataset.mode = m;
  if (miniWheel) { miniWheel.destroy(); miniWheel = null; miniWheelKey = ''; }
  if (lights) { lights.destroy(); lights = null; }
  if (loginSnow) { loginSnow.destroy(); loginSnow = null; }
  const garlandBox = '<div class="host-garland" id="r-garland" aria-hidden="true"></div>';
  if (m === 'login' || m === 'signedIn') {
    app.innerHTML = `${garlandBox}<div class="login-page" id="r-login-wrap"><div class="login-snow" id="r-login-snow" aria-hidden="true"></div><div id="r-login" class="login-holder"></div></div>`;
    try { loginSnow = snowfall(document.getElementById('r-login-snow'), { count: 26, avoid: ['.box-office'], margin: 1 }); } catch { loginSnow = null; }
  } else if (m === 'lobby') {
    app.innerHTML = `${garlandBox}
      <header class="topbar" id="r-top"></header>
      <div class="layout layout--lobby">
        <main class="board board--lobby" id="main">
          <section class="coach note" id="coach" aria-label="Live directions"></section>
          <div id="r-saved"></div>
          <div class="lobby">
            <div class="lobby__side" id="r-lobby-side"></div>
            <section class="card card--md teams" aria-labelledby="teams-h">
              <div class="teams__head" id="r-teams-head"></div>
              <form class="add-team" id="add-team" novalidate autocomplete="off">
                <div class="add-team__row">
                  <div class="field add-team__name">
                    <label class="label" for="team-name">New team name</label>
                    <input class="input input--sm" id="team-name" name="name" maxlength="24" placeholder="e.g. The Sleigh Riders" enterkeyhint="done">
                  </div>
                  <button class="btn btn--holly btn--md add-team__btn" type="submit" data-needs-online></button>
                </div>
                <div class="ideas" id="r-ideas"></div>
                <fieldset class="add-team__mascots">
                  <legend class="label">Pick a mascot (the team colour comes with it)</legend>
                  <div class="mascot-picker" id="r-mascots" role="radiogroup" aria-label="Mascot"></div>
                </fieldset>
              </form>
              <div id="r-teams"></div>
            </section>
          </div>
        </main>
      </div>`;
    $('#add-team .add-team__btn').innerHTML = h`${ic('plus', { size: 20, stroke: 2.8 })}Add team`.html;
  } else {
    app.innerHTML = `${garlandBox}
      <header class="topbar" id="r-top"></header>
      <div class="layout layout--game">
        <aside class="rail" id="r-rail" aria-label="Scores"></aside>
        <main class="board" id="main">
          <section class="coach note" id="coach" aria-label="Live directions"></section>
          <div class="stage" id="r-stage"></div>
          <section class="mirror" id="r-mirror" aria-label="On the TV now"></section>
          <p class="keys" id="r-keys"></p>
        </main>
        <aside class="side" id="r-side" aria-label="Private host info"></aside>
      </div>
      <section class="dock" id="r-dock" aria-label="Scores"></section>`;
  }
  const box = document.getElementById('r-garland');
  if (box) {
    try { lights = garland(box, { size: isPhone() ? 'phone' : 'host', seed: 1225 }); lights.__size = isPhone() ? 'phone' : 'laptop'; } catch { lights = null; }
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
    patch('r-ideas', ideasHtml(s));
    patch('r-mascots', mascotPickerHtml(s));
    patch('r-teams', teamsListHtml(s));
    const form = $('#add-team');
    if (form) form.hidden = s.teams.length >= 8 || !s.host.can.createTeam;
  } else {
    syncEnvelope(s);
    patch('r-rail', railHtml(s));
    patch('r-dock', dockHtml(s));
    patch('r-stage', stageHtml(s));
    patch('r-mirror', mirrorHtml(s));
    patch('r-side', sideHtml(s));
    patch('r-keys', keysHtml(s));
    syncMiniWheel(s);
  }
  syncLights(s);
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

/** The garland follows the game: chase while spinning, twinkle otherwise. */
function syncLights(s) {
  if (!lights) return;
  const want = s.phase === 'spinning' ? 'chase' : 'twinkle';
  if (lights.__mode !== want) {
    lights.__mode = want;
    if (want === 'chase') lights.chase(0.6); else lights.twinkle();
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
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'go'].map((k, i) => {
    if (k === 'del') return h`<button type="button" class="key key--del" data-pin="del" aria-label="Delete last digit" ${n ? '' : raw('disabled')}>${ic('arrow-left', { size: 30, stroke: 2.8 })}</button>`;
    if (k === 'go') return h`<button type="button" class="key key--go" data-pin="go" aria-label="Sign in" ${n === 4 && !login.busy && !waiting ? '' : raw('disabled')}>${ic('check', { size: 32, stroke: 3.2 })}</button>`;
    return h`<button type="button" class="key ${i % 2 ? 'key--snow' : 'key--candy'}" data-pin="${k}" ${waiting || login.busy ? raw('disabled') : ''}>${k}</button>`;
  });
  const hint = login.busy ? 'Checking with the head elf…' : waiting ? `The booth reopens in ${Math.ceil(wait / 1000)} s` : n < 4 ? 'Type the 4 digits. It signs you in by itself.' : 'Checking…';
  const addr = displayUrl(s.joinUrl);
  return h`
  <section class="box-office" aria-labelledby="login-h">
    <div class="awning" aria-hidden="true"></div>
    <div class="box-office__sign"><span class="box-office__sign-text">Host entrance</span></div>
    <div class="box-office__window">
      <div class="box-office__main">
        <div class="brand brand--login">${art('tree', { size: 44 })}<span class="wordmark wordmark--sm">Christmas Chaos</span><span class="tag tag--holly brand-tag">Host</span></div>
        <h1 id="login-h" class="login__title">Host sign-in</h1>
        <p class="login__sub">Show the elf at the window your 4-digit PIN. It’s on the game laptop’s host screen and in the terminal.</p>
        <div class="ticket ${login.shake ? 'fx-shake' : ''}" data-key="ticket">
          <div class="ticket__stub"><span>Admit one</span><b>Host</b></div>
          <div class="ticket__main">
            <div class="ticket__top"><span class="label" id="pin-l">Host PIN</span><span class="ticket__count" aria-live="polite">${n} of 4</span></div>
            <div class="pin-boxes" role="group" aria-labelledby="pin-l">${boxes}</div>
          </div>
        </div>
        ${login.error ? h`<p class="login__error" role="alert">${art('snowman', { size: 34 })}<span>${login.error}</span></p>` : ''}
        <p class="login__hint" aria-live="polite" data-login-hint>${hint}</p>
      </div>
      <div class="box-office__pad">
        <div class="keypad" role="group" aria-label="Number keypad">${keys}</div>
        <button type="button" class="btn btn--primary btn--lg btn--block login__submit" data-pin="go" ${n === 4 && !login.busy && !waiting ? '' : raw('aria-disabled="true"')}>${ic('lock-open', { size: 24, stroke: 2.6 })}Sign in</button>
      </div>
    </div>
    <ul class="login__tips" role="list">
      <li>${ic('laptop', { size: 20 })}<span>On the game laptop itself? <b>You’re signed in automatically.</b></span></li>
      <li>${ic('eye-off', { size: 20 })}<span>The PIN is never shown on the TV, so nobody can peek.</span></li>
      <li>${ic('shield-check', { size: 20 })}<span>Once you’re in, this device stays signed in, even after a refresh.</span></li>
    </ul>
  </section>
  <p class="login-page__foot">${ic('smartphone', { size: 18 })}<span>Here to play, not to host? Join at <b>${addr || 'the address on the TV'}</b></span></p>`;
}

function signedInHtml(s) {
  const hosts = s.host?.connections?.hosts || 1;
  return h`
  <section class="box-office box-office--done" role="status" aria-labelledby="done-h">
    <div class="awning" aria-hidden="true"></div>
    <div class="box-office__window box-office__window--done">
      ${art('santa', { size: 120, className: 'done-art' })}
      <div class="done-stamp" aria-hidden="true">Admitted</div>
      <h1 id="done-h" class="login__title">You’re the host!</h1>
      <p class="login__sub login__sub--center">This device can now run the game. Roam the room; the laptop keeps the TV going. It stays signed in, even after a refresh or a Wi-Fi hiccup.</p>
      <ul class="host-screens" role="list" aria-label="Host screens">
        <li class="host-screen">${ic('laptop', { size: 18 })}Game laptop<i class="ok-dot"></i></li>
        <li class="host-screen is-you">${ic('smartphone', { size: 18 })}This device<i class="ok-dot"></i></li>
      </ul>
      <span class="muted login__small">${plural(hosts, 'host screen')}, always in sync</span>
      <button type="button" class="btn btn--primary btn--lg" data-ui="enterHost" data-key="enter-host">Open host controls${ic('arrow-right', { size: 24, stroke: 2.8 })}</button>
      <button type="button" class="btn btn--link" data-ui="signOut">Sign out of this device</button>
    </div>
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
    login.fails++;
    const joke = pick(WRONG_PIN, login.fails);
    login.error = res.triesLeft > 0 ? `${joke} ${plural(res.triesLeft, 'try', 'tries')} left.` : joke;
    login.shake = Date.now();
  } else if (res.error === 'too-many-tries') {
    login.digits = '';
    login.retryUntil = Date.now() + (Number(res.retryInMs) || 60000);
    login.error = 'Whoa there, Rudolph. Too many guesses. Check the laptop screen while the booth cools down.';
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
  const inTurn = ['turnIntro', 'spinning', 'challenge', 'turnResult'].includes(s.phase);
  const isFinal = s.phase.startsWith('final');
  let pill = '';
  let sub = '';
  let compact = '';
  if (s.phase === 'lobby') {
    pill = h`<span class="pill pill--sm pill--snow phase-pill">${ic('users', { size: 16 })}Lobby</span>`;
    sub = h`<span class="topbar__sub"><b>${plural(s.players.length, 'player')}</b> joined · ${plural(s.teams.length, 'team')}</span>`;
    compact = 'Lobby';
  } else if (inTurn) {
    pill = h`<span class="pill pill--sm phase-pill">Round ${s.round} of ${s.totalRounds} ${turnDots(s.turnIndex, s.turnsPerRound)}</span>`;
    sub = h`<span class="topbar__sub">Turn ${s.turnIndex + 1} of ${s.turnsPerRound}${act ? h` · <b>${act.name}</b>` : ''}</span>`;
    compact = `Round ${s.round} · Turn ${s.turnIndex + 1}`;
  } else if (s.phase === 'roundBreak') {
    const rb = s.roundBreak;
    pill = h`<span class="pill pill--sm phase-pill">${art('cocoa', { size: 22 })}End of round ${s.round}</span>`;
    sub = h`<span class="topbar__sub">${rb?.finalNext ? 'The final round is next' : rb ? `Round ${rb.nextRound} of ${s.totalRounds} next` : ''}</span>`;
    compact = `Cocoa break · ${s.round} of ${s.totalRounds}`;
  } else if (isFinal) {
    const step = { finalIntro: 'Category', finalWager: 'Wagering', finalAnswer: 'Answering', finalReveal: 'The reveal' }[s.phase];
    const F = s.final;
    const extra = s.phase === 'finalReveal' && F ? ` · ${F.revealed.length} of ${F.revealOrder.length}` : '';
    pill = h`<span class="pill pill--sm phase-pill phase-pill--eve">${art('moon', { size: 22 })}Final Chaos</span>`;
    sub = h`<span class="topbar__sub">${step}${extra}</span>`;
    compact = `Final Chaos · ${step}`;
  } else if (s.phase === 'podium') {
    pill = h`<span class="pill pill--sm phase-pill phase-pill--gold">${art('trophy', { size: 22 })}Game over</span>`;
    sub = h`<span class="topbar__sub">The podium is on the TV</span>`;
    compact = 'Game over';
  }
  const tvOk = conn.tv > 0;
  const phones = conn.phones || 0;
  return h`
  <div class="topbar__brand">${art('tree', { size: 40 })}<span class="wordmark wordmark--sm">Christmas Chaos</span><span class="tag tag--holly brand-tag">Host</span></div>
  <div class="topbar__phase">${pill}${sub}</div>
  <span class="topbar__compact">${compact}</span>
  <div class="topbar__status">
    <span class="status ${tvOk ? 'is-ok' : 'is-warn'}" title="${tvOk ? 'The TV screen is connected' : 'Open /tv on the TV'}">${tvOk ? raw('<i class="ok-dot"></i>') : ic('triangle-alert', { size: 18 })}<span class="status__text">${tvOk ? 'TV connected' : 'TV not open'}</span></span>
    <span class="status status--phones" title="${plural(phones, 'phone') + ' connected'}">${ic('smartphone', { size: 18 })}<b>${phones}</b><span class="status__text">${phones === 1 ? ' phone' : ' phones'}</span></span>
    ${conn.hosts > 1 ? h`<span class="status status--hosts" title="${conn.hosts + ' host screens signed in'}">${ic('laptop', { size: 18 })}<b>${conn.hosts}</b><span class="sr-only"> host screens</span></span>` : ''}
    <span class="status status--conn ${client.connected ? 'is-ok' : 'is-bad'}">${client.connected ? raw('<i class="ok-dot"></i>Online') : h`${ic('wifi-off', { size: 16 })}Offline`}</span>
    <button type="button" class="btn btn--secondary btn--sm topbar__more" data-ui="more" aria-haspopup="dialog" data-key="more">${ic('ellipsis', { size: 20 })}<span>More</span></button>
    <a class="btn ${tvOk ? 'btn--secondary' : 'btn--gold'} btn--sm topbar__tv" href="/tv" target="_blank" rel="noopener" aria-label="Open the TV screen in a new tab">${ic('monitor', { size: 20 })}<span class="topbar__tv-text">Open TV screen</span></a>
  </div>`;
}

/* ============================================================================ the coach note card */

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
const iconFor = (a) => ACTION_ICONS[a.id] || (String(a.id).startsWith('change-') ? 'pencil' : 'chevron-right');

function splitHeadline(text) {
  const t = String(text || '');
  let m = t.match(/^(.+?)\s(\([^()]+\))$/);
  if (m) return [m[1], m[2]];
  const i = t.lastIndexOf(' — ');
  if (i > 0) return [`${t.slice(0, i)} ·`, t.slice(i + 3)];
  m = t.match(/^(.+?)\s([+−-][\d,]+)$/);
  if (m) return [m[1], m[2]];
  return [t, ''];
}

/** Stage directions read as italics: (lowercase words in brackets) and [cues]. Questions' "(1964)" stay text. */
const CUE_RE = /(\((?=[a-z])[^()\d]{2,90}\)|\[[^[\]]{2,90}\])/g;
function richLine(text) {
  const parts = String(text || '').split(CUE_RE);
  return parts.map((p, i) => (i % 2 ? h`<em class="cue">${p}</em>` : h`${p}`));
}

function sayHtml(C, s) {
  let lines = String(C.say || '').split('\n').map((x) => x.trim()).filter(Boolean);
  // podium: the awards are read from the ceremony card below, so "Say this" keeps the opener and the sign-off
  if (s?.phase === 'podium' && (s.podium?.awards || []).length) {
    const before = lines.length;
    lines = lines.filter((l) => !/goes to(…|\.\.\.)/i.test(l) && !/^Now, the awards!?$/i.test(l));
    if (lines.length < before) lines.splice(Math.min(1, lines.length), 0, 'Now, the awards! [read them from the ceremony card below]');
  }
  const punch = C.punchline && C.punchline.text ? C.punchline : null;
  const isPunch = (l) => punch && l.includes(punch.text);
  const body = lines.filter((l) => !isPunch(l));
  const total = body.join(' ').length;
  const size = total > 280 ? 'say__text--xs' : total > 170 ? 'say__text--sm' : '';
  // the punchline (coach.punchline = {id, key, text, cue}): its own highlighted line, the cue in italics
  const cue = punch ? String(punch.cue || '(say it with feeling)').trim() : '';
  return h`<div class="say">
    <div class="say__label">${ic('mic', { size: 18, stroke: 2.6 })}Say this<span class="say__hint">read it out loud</span></div>
    ${body.length ? h`<div class="say__text ${size}">${body.map((l) => h`<p class="say__line">${richLine(l)}</p>`)}</div>` : ''}
    ${punch ? h`<div class="punch">
      <span class="punch__label">${art('party', { size: 26 })}Punchline</span>
      <p class="punch__line">${cue ? h`<em class="cue">${cue}</em> ` : ''}“${punch.text}”</p>
    </div>` : ''}
  </div>`;
}

function doHtml(C) {
  const steps = C.steps || [];
  if (!steps.length) return '';
  const key = `${C.headline}|${steps.join('|')}`;
  if (key !== ui.stepsKey) { ui.stepsKey = key; ui.stepsDone = new Set(); }
  const current = steps.findIndex((_, i) => !ui.stepsDone.has(i));
  return h`<div class="do">
    <div class="do__label">${ic('list-checks', { size: 18, stroke: 2.6 })}Do this<span class="say__hint">tap a step when it’s done</span></div>
    <ol class="do__steps" role="list">${steps.map((st, i) => {
      const done = ui.stepsDone.has(i);
      const state = done ? 'done' : i === current ? 'current' : 'todo';
      return h`<li><button type="button" class="step is-${state}" data-ui="step" data-i="${i}" data-key="${'step:' + i}" aria-pressed="${done ? 'true' : 'false'}">
        <span class="step__n">${done ? ic('check', { size: 16, stroke: 3.4 }) : i + 1}</span><span class="step__text">${st}</span></button></li>`;
    })}</ol>
  </div>`;
}

function liveState(s) {
  const now = client.serverNow();
  if (Date.now() < ui.liveUntil) return { on: true, text: ui.liveText || 'Big moment on the TV', mood: ui.liveMood || '' };
  if (s.phase === 'spinning') return { on: true, text: 'The wheel is spinning' };
  const c = s.challenge;
  const b = c?.buzz;
  if (b && !b.winner && (b.open || (b.armingUntil && b.armingUntil > now))) return { on: true, text: b.open ? 'Buzzers are live' : 'Buzzers arming…' };
  if (c?.vote?.open) return { on: true, text: 'The room is voting' };
  if (s.timer?.running) return { on: true, text: 'The clock is running' };
  return { on: false, text: '' };
}

function liveLight(s) {
  const L = liveState(s);
  ui.liveShown = `${L.on}|${L.text}`;
  return L.on
    ? h`<span class="live-light is-on ${L.mood ? 'is-' + L.mood : ''}" role="status"><i class="live-light__bulb" aria-hidden="true"></i><span class="live-light__text"><b>Live</b><small>${L.text}</small></span></span>`
    : h`<span class="live-light" role="status"><i class="live-light__bulb" aria-hidden="true"></i><span class="live-light__text"><b>Your cue</b><small>The TV waits for you</small></span></span>`;
}

function contextChip(s) {
  const c = s.challenge;
  if (c && (s.phase === 'challenge' || s.phase === 'turnResult' || c.type === 'bonus')) {
    const sg = c.type === 'bonus' ? segOf(s, 10) : segOf(s, c.segmentIndex);
    if (!sg) return '';
    const text = c.type === 'bonus' ? 'Bonus question' : `${sg.label}${c.difficulty ? ` · ${cap(c.difficulty)}` : ''}`;
    return slotChip(sg, { size: 'sm', text });
  }
  const map = {
    lobby: ['gift', 'Setting up'], turnIntro: ['sled', 'Turn intro'], spinning: ['star', 'Spinning'],
    roundBreak: ['cocoa', 'Hot cocoa break'], finalIntro: ['moon', 'Final Chaos'], finalWager: ['moon', 'Final · wagers'],
    finalAnswer: ['moon', 'Final · answers'], finalReveal: ['moon', 'Final · reveal'], podium: ['trophy', 'Podium'],
  };
  const m = map[s.phase];
  return m ? h`<span class="chip chip--sm ctx-chip">${art(m[0], { size: 26 })}${m[1]}</span>` : '';
}

function actBtn(a, s, size) {
  const dis = !!a.disabled;
  const kind = size === 'hero'
    ? (a.kind === 'success' ? 'btn--holly' : 'btn--primary')
    : { primary: 'btn--primary', success: 'btn--holly', danger: 'btn--danger', secondary: 'btn--secondary' }[a.kind] || 'btn--secondary';
  const detail = dis ? a.reason : a.detail;
  const t = a.payload && a.payload.teamId && size !== 'hero' ? teamOf(s, a.payload.teamId) : null;
  return h`<button type="button" class="btn ${kind} act act--${size} ${dis ? 'is-locked' : ''}" data-act="coach" data-id="${a.id}" data-key="${'coach:' + a.id}"
    ${a.shortcut ? raw(`aria-keyshortcuts="${esc(a.shortcut)}"`) : ''} ${dis ? raw('aria-disabled="true"') : ''} data-needs-online>
    <span class="act__icon" aria-hidden="true">${dis ? ic('lock', { size: size === 'hero' ? 26 : 18, stroke: 2.6 }) : t ? mas(t, 30) : ic(iconFor(a), { size: size === 'hero' ? 28 : 18, stroke: 2.8 })}</span>
    <span class="act__text"><span class="act__label">${a.label}</span>${detail ? h`<span class="act__detail">${detail}</span>` : ''}</span>
    ${a.shortcut ? h`<kbd class="kbd act__kbd">${a.shortcut}</kbd>` : ''}
  </button>`;
}

const PICK_LOOK = {
  easy: { size: 'sm', color: '#2E6FD1', ribbon: '#EDB321' },
  medium: { size: 'md', color: '#1F7A4A', ribbon: '#D42A2A' },
  hard: { size: 'lg', color: '#D42A2A', ribbon: '#EDB321' },
};
function pickBtn(a) {
  const lvl = String(a.id).slice(5);
  const look = PICK_LOOK[lvl] || PICK_LOOK.medium;
  const dis = !!a.disabled;
  return h`<button type="button" class="dpick dpick--${lvl} ${dis ? 'is-locked' : ''}" data-act="coach" data-id="${a.id}" data-key="${'coach:' + a.id}" ${dis ? raw('aria-disabled="true"') : ''} data-needs-online>
    <span class="dpick__gift">${present({ size: look.size, color: look.color, ribbon: look.ribbon })}</span>
    <span class="dpick__label">${a.label}</span>
    ${a.shortcut ? h`<kbd class="kbd">${a.shortcut}</kbd>` : ''}
  </button>`;
}

function targetCard(a, s) {
  const id = a.payload?.teamId;
  const t = teamOf(s, id);
  const eye = s.challenge?.eyeing;
  const eyed = eye && eye.teamId === id;
  const dis = !!a.disabled;
  return h`<button type="button" class="target ${eyed ? 'is-eyed' : ''} ${dis ? 'is-locked' : ''}" data-act="coach" data-id="${a.id}" data-key="${'coach:' + a.id}" ${dis ? raw('aria-disabled="true"') : ''} ${tstyle(t)} data-needs-online>
    ${mas(t, 52)}
    <span class="target__body"><span class="target__name">${t ? t.name : id}</span><span class="target__meta"><b class="num">${fmt(t?.score || 0)}</b> pts${a.detail ? h` · ${a.detail}` : ''}</span></span>
    ${eyed ? h`<span class="tag tag--ember target__eye">${ic('eye', { size: 14, stroke: 2.6 })}${eye.by?.name || 'Someone'} is eyeing</span>` : ''}
    <span class="target__go">${ic('chevron-right', { size: 22 })}</span>
  </button>`;
}

function stickyNotes(s, C) {
  const tipText = (C.tips || []).join(' ').toLowerCase();
  const warn = (s.host.warnings || []).map((w) => ({ text: w.text || String(w.code || ''), warn: true })).filter((x) => x.text && !tipText.includes(x.text.replace(/[.!]+$/, '').toLowerCase()));
  const notes = [...warn, ...(C.tips || []).map((t) => ({ text: t, warn: false }))];
  if (!notes.length) return '';
  return h`<ul class="tips" role="list" aria-label="Tips">${notes.slice(0, 6).map((n, i) => h`<li class="sticky ${n.warn ? 'sticky--warn' : `sticky--${i % 3}`}">
    <b class="sticky__head">${n.warn ? 'Heads-up' : pick(STICKY_HEADS, i + (C.headline || '').length)}</b><span class="sticky__text">${n.text}</span></li>`)}</ul>`;
}

function trackerHtml(C) {
  const P = C.progress || [];
  if (!P.length) return '';
  return h`<ol class="tracker" role="list" aria-label="Turn progress">${P.map((p) => h`<li class="tracker__step is-${p.state === 'done' || p.state === 'current' ? p.state : 'todo'}">
    <i class="tracker__bulb" aria-hidden="true"></i><span class="tracker__label">${p.label}${p.detail ? h`<small>${p.detail}</small>` : ''}</span>
    <span class="sr-only">${p.state === 'done' ? ' (done)' : p.state === 'current' ? ' (now)' : ''}</span></li>`)}</ol>`;
}

function coachHtml(s) {
  const C = s.host.coach;
  const [main, hl] = splitHeadline(C.headline);
  const acts = C.actions || [];
  const primary = acts.find((a) => a.id === C.primary) || null;
  const picks = acts.filter((a) => /^pick-(easy|medium|hard)$/.test(a.id));
  const targets = acts.filter((a) => a.event === 'host:pickTarget');
  const rest = acts.filter((a) => a !== primary && !picks.includes(a) && !targets.includes(a));
  const isMain = (a) => a.kind === 'success' || a.kind === 'primary' || (a.kind === 'danger' && a.shortcut) || /^[1-3]$/.test(a.shortcut || '') || MAIN_IDS.has(a.id) || String(a.id).startsWith('change-');
  const mains = rest.filter(isMain);
  const tools = rest.filter((a) => !isMain(a));
  const t = s.timer;
  const waitingText = C.steps?.[0] || 'Follow the TV';
  const hasSay = !!(C.say || C.punchline?.text);
  return h`
  <span class="pin pin--l" aria-hidden="true"></span><span class="pin pin--r" aria-hidden="true"></span>
  <header class="coach__head">
    <div class="coach__tags"><span class="now-chip">${ic('radio', { size: 16, stroke: 2.6 })}Now</span>${contextChip(s)}</div>
    <div class="coach__signals">
      ${t ? h`<span class="timer-pill ${t.running ? 'is-running' : ''}" data-timer-pill>${ic('timer', { size: 18, stroke: 2.4 })}<b data-timer-text>${mmss(timerRemaining(t, client.serverNow()))}</b></span>` : ''}
      ${liveLight(s)}
    </div>
    <h2 class="coach__headline">${main}${hl ? h` <span class="coach__hl">${hl}</span>` : ''}</h2>
  </header>
  ${hasSay || (C.steps || []).length ? h`<div class="coach__script ${hasSay ? '' : 'is-nosay'}">${hasSay ? sayHtml(C, s) : ''}${doHtml(C)}</div>` : ''}
  <div class="coach__actions">
    ${picks.length ? h`<div class="coach__picks"><p class="coach__picks-lead">${art('gift', { size: 26 })}<span>${subject(teamName(s, s.activeTeamId), 'picks')} on a phone, or tap a present for them:</span></p><div class="dpicks">${picks.map(pickBtn)}</div></div>` : ''}
    ${primary
      ? h`<div class="hero">${actBtn(primary, s, 'hero')}</div>`
      : picks.length || targets.length ? '' : h`<div class="coach__waiting" role="status">${art('cocoa', { size: 44 })}<span><b>Nothing to press yet</b><small>${waitingText}</small></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`}
    ${targets.length ? h`<div class="coach__targets"><p class="coach__picks-lead">${art('money', { size: 26 })}<span>${subject(teamName(s, s.activeTeamId), 'chooses')} on a phone, or pick for them:</span></p><div class="targets">${targets.map((a) => targetCard(a, s))}</div></div>` : ''}
    ${mains.length ? h`<div class="coach__mains ${mains.length > 2 ? 'is-grid' : ''}">${mains.map((a) => actBtn(a, s, 'main'))}</div>` : ''}
    ${tools.length ? h`<div class="coach__tools">${tools.map((a) => actBtn(a, s, 'tool'))}</div>` : ''}
  </div>
  ${stickyNotes(s, C)}
  ${trackerHtml(C)}`;
}

/* ============================================================================ scores (rail + phone dock) */

function scoreRows(s, cls) {
  const lead = Math.max(0, ...s.teams.map((t) => t.score));
  const now = Date.now();
  const small = cls === 'dock-row';
  return s.teams.map((t) => {
    const active = t.id === s.activeTeamId;
    const offline = t.playerCount > 0 && t.connectedCount === 0;
    const bump = (ui.bump[t.id] || 0) > now;
    const leader = lead > 0 && t.score === lead;
    return h`<li class="${cls} ${active ? 'is-active' : ''} ${offline ? 'is-offline' : ''} ${bump ? 'is-bump' : ''}" ${tstyle(t)} data-team="${t.id}">
      ${active ? h`<span class="up-now ${cls}__up">Up now</span>` : ''}
      ${t.multiplier > 1 ? h`<span class="${cls}__x2" role="img" aria-label="Points doubled this turn">×2</span>` : ''}
      <span class="${cls}__mascot">${mas(t, small ? 34 : 46)}${leader ? art('glowing-star', { size: small ? 20 : 26, className: `${cls}__star`, alt: 'Leader' }) : ''}</span>
      <span class="${cls}__body"><span class="${cls}__name">${t.name}${offline ? h` <small>· offline</small>` : ''}</span>
        <span class="${cls}__score">${fmt(t.score)}</span></span>
      <span class="${cls}__adj">
        <button type="button" class="adj" data-emit="host:adjustScore" data-payload="${json({ teamId: t.id, delta: -50 })}" data-key="${'minus:' + t.id}" aria-label="${'Take 50 from ' + t.name}" data-needs-online>${ic('minus', { size: 18, stroke: 3 })}</button>
        <button type="button" class="adj adj--plus" data-emit="host:adjustScore" data-payload="${json({ teamId: t.id, delta: 50 })}" data-key="${'plus:' + t.id}" aria-label="${'Give ' + t.name + ' 50'}" data-needs-online>${ic('plus', { size: 18, stroke: 3 })}</button>
      </span>
    </li>`;
  });
}

function undoBtn(s, cls = '') {
  const H = s.host;
  return h`<button type="button" class="btn btn--secondary btn--md undo ${cls}" data-ui="undo" data-key="undo" ${H.canUndo ? '' : raw('aria-disabled="true"')} aria-keyshortcuts="U Control+Z" title="${H.undoLabel ? 'Undo: ' + H.undoLabel : 'Nothing to undo'}">${ic('undo-2', { size: 20, stroke: 2.6 })}<span>Undo last change</span><kbd class="kbd">U</kbd></button>`;
}

function railHtml(s) {
  const H = s.host;
  return h`<section class="card card--sm scores">
    <div class="scores__head">${art('star', { size: 30 })}<h2 class="panel-title">Scoreboard</h2><span class="scores__hint">50 a tap</span></div>
    <ol class="scores__list" role="list">${scoreRows(s, 'score-row')}</ol>
    <div class="scores__foot">${undoBtn(s)}<span class="scores__last">${H.undoLabel ? h`Last: ${H.undoLabel}${H.undoDepth > 1 ? h` · ${H.undoDepth} steps back` : ''}` : 'No score changes yet'}</span></div>
  </section>`;
}

function dockHtml(s) {
  const lead = [...s.teams].sort((a, b) => b.score - a.score)[0];
  const tie = lead && s.teams.filter((t) => t.score === lead.score).length > 1;
  const summary = !lead ? 'No teams' : lead.score === 0 ? 'Everyone is on 0' : tie ? `Tied at the top on ${fmt(lead.score)}` : `${subject(lead.name, 'leads')} with ${fmt(lead.score)}`;
  return h`<div class="dock__bar">
    <button type="button" class="dock__toggle" data-ui="dock" aria-expanded="${ui.dockOpen ? 'true' : 'false'}" data-key="dock">${art('star', { size: 30 })}
      <span class="dock__sum"><b>Scores</b><small>${summary}</small></span>${ic(ui.dockOpen ? 'chevron-down' : 'chevron-up', { size: 22, stroke: 2.6 })}</button>
    <button type="button" class="btn btn--secondary btn--sm dock__undo" data-ui="undo" ${s.host.canUndo ? '' : raw('aria-disabled="true"')} aria-label="Undo last score change">${ic('undo-2', { size: 18, stroke: 2.6 })}Undo</button>
  </div>
  ${ui.dockOpen ? h`<div class="dock__body"><ol class="dock__list" role="list">${scoreRows(s, 'dock-row')}</ol><span class="dock__note">50 a tap${s.host.undoLabel ? h` · Last change: ${s.host.undoLabel}` : ''}</span></div>` : ''}`;
}

/* ============================================================================ the private envelope + timer (side) */

function envKeyOf(s) {
  const c = s.challenge;
  return [s.phase, c?.id, c?.stage, c?.hotseat?.index, s.final?.current, s.host?.answer, s.host?.secret?.value].join('|');
}
function syncEnvelope(s) {
  const k = envKeyOf(s);
  if (k !== ui.envKey) { ui.envKey = k; ui.envOpen = false; }
}

function acceptChips(list, main) {
  const a = (list || []).filter((x) => x && x !== main);
  return a.length ? h`<div class="letter__block"><span class="letter__label">Also accept</span><ul class="chips" role="list">${a.slice(0, 8).map((x) => h`<li class="chip-sm">${x}</li>`)}</ul></div>` : '';
}

function privateInfo(s) {
  const H = s.host;
  const c = s.challenge;
  const F = H.final;
  if (s.phase.startsWith('final') && F) {
    return {
      noun: 'the final answer', secret: true,
      body: h`<div class="letter__block"><span class="letter__label">Final question · ${F.categoryLabel}</span><p class="letter__q">${F.question}</p></div>
        <div class="letter__block"><span class="letter__label">Correct answer</span><p class="letter__answer">${F.answer}</p></div>
        ${acceptChips(F.accept, F.answer)}
        ${s.phase === 'finalReveal' ? projectedHtml(s) : ''}`,
    };
  }
  if (!c) return null;
  if (c.type === 'trivia' || c.type === 'allplay' || c.type === 'bonus') {
    if (!H.answer) return { noun: 'the answer', secret: false, body: h`<p class="letter__empty">${art('gift', { size: 40 })}<span>The question and answer appear here once ${subject(teamName(s, s.activeTeamId), 'picks')} a present.</span></p>` };
    return {
      noun: 'the answer', secret: true,
      body: h`${c.type !== 'trivia' && c.question ? h`<div class="letter__block"><span class="letter__label">Question</span><p class="letter__q">${c.question}</p></div>` : ''}
        <div class="letter__block"><span class="letter__label">Answer</span><p class="letter__answer">${H.answer}</p></div>
        ${acceptChips(H.accept, H.answer)}
        ${c.movie ? h`<p class="letter__note">${art('film', { size: 24 })}<span>From <b>${c.movie}</b>${c.movieYear ? ` (${c.movieYear})` : ''}</span></p>` : ''}
        ${H.hint ? h`<div class="letter__block letter__block--rule"><span class="letter__label">${ic('lightbulb', { size: 15, stroke: 2.4 })}Hint${c.hint ? h` <span class="tag tag--ember letter__tag">On the TV</span>` : ''}</span><p class="letter__text">“${H.hint}”</p></div>` : ''}
        ${H.funFact ? h`<div class="letter__say"><b>Say after:</b> ${H.funFact}</div>` : ''}`,
    };
  }
  if (c.type === 'sounditout') {
    const song = H.song || {};
    return {
      noun: 'the song', secret: true,
      body: h`<div class="letter__block"><span class="letter__label">The song</span><p class="letter__answer">${song.title || H.answer || ''}</p>${song.artist ? h`<p class="letter__text">by ${song.artist}</p>` : ''}</div>
        <p class="letter__text">Only on ${c.performer?.name || 'the performer'}’s phone. They press and hold to peek.</p>
        ${peekChip(s)}
        ${acceptChips(song.accept, song.title)}
        ${song.hint ? h`<div class="letter__block letter__block--rule"><span class="letter__label">${ic('lightbulb', { size: 15, stroke: 2.4 })}Hint${c.hint ? h` <span class="tag tag--ember letter__tag">On the TV</span>` : ''}</span><p class="letter__text">“${song.hint}”</p></div>` : ''}`,
    };
  }
  if (c.type === 'dare') {
    const d = c.dare || {};
    const sec = H.secret;
    const x = Math.max(1, teamOf(s, s.activeTeamId)?.multiplier || 1); // Double Down: the legend matches the ×2 buttons
    return {
      noun: sec ? 'the secret' : 'the judging guide', secret: !!sec,
      body: h`${sec ? h`<div class="letter__block"><span class="letter__label">The secret</span><p class="letter__answer">${sec.value}</p><p class="letter__text">${sec.label}</p></div>${peekChip(s)}` : ''}
        ${d.judge ? h`<div class="letter__block letter__block--rule"><span class="letter__label">${ic('gavel', { size: 15, stroke: 2.4 })}How to judge</span><p class="letter__text">${d.judge}</p></div>` : ''}
        ${(d.props || []).length ? h`<div class="letter__block"><span class="letter__label">Props</span><ul class="chips" role="list">${d.props.map((p) => h`<li class="chip-sm">${p}</li>`)}</ul></div>` : ''}
        <ul class="legend" role="list">
          <li><i class="legend__dot legend__dot--holly"></i><span><b>Nailed it</b> ${fmt(200 * x)}: they did it</span></li>
          <li><i class="legend__dot legend__dot--gold"></i><span><b>Valiant effort</b> ${fmt(100 * x)}: a brave try</span></li>
          <li><i class="legend__dot legend__dot--coal"></i><span><b>Not this time</b> 0: lump of coal</span></li>
        </ul>`,
    };
  }
  if (c.type === 'showdown' && c.showdown) {
    const sd = c.showdown;
    return {
      noun: 'the rules', secret: false,
      body: h`<div class="letter__block"><span class="letter__label">Challenge</span><p class="letter__q">${sd.title}</p><p class="letter__text">${sd.instructions}</p></div>
        ${sd.winner ? h`<div class="letter__block letter__block--rule"><span class="letter__label">${ic('trophy', { size: 15, stroke: 2.4 })}How to win</span><p class="letter__text">${sd.winner}</p></div>` : ''}
        ${(sd.props || []).length ? h`<div class="letter__block"><span class="letter__label">Props</span><ul class="chips" role="list">${sd.props.map((p) => h`<li class="chip-sm">${p}</li>`)}</ul></div>` : ''}`,
    };
  }
  if (c.type === 'rapidlist') {
    const l = c.list;
    return {
      noun: 'the answer list', secret: true,
      body: h`<div class="letter__block"><span class="letter__label">The rules</span><ul class="chips" role="list"><li class="chip-sm">30 seconds</li><li class="chip-sm">${l.each} each</li><li class="chip-sm">Max ${fmt(l.max * l.each)}</li><li class="chip-sm">Repeats don’t count</li></ul></div>
        <div class="letter__block"><span class="letter__label">Valid answers</span><p class="letter__text"><b>${plural((H.listAnswers || []).length, 'answer')}</b> on Santa’s list below. Tap what they shout.</p></div>
        ${H.listNote ? h`<div class="letter__say"><b>Note:</b> ${H.listNote}</div>` : ''}`,
    };
  }
  if (c.type === 'hotseat') {
    const hs = c.hotseat;
    if (!H.hotseatQuestion) return { noun: 'the answers', secret: false, body: h`<p class="letter__empty">${art('fire', { size: 40 })}<span>Questions show up here when the clock starts. Every answer is on the Hot Seat sheet below.</span></p>` };
    return {
      noun: 'the answer', secret: true,
      body: h`<div class="letter__block"><span class="letter__label">Question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}</span><p class="letter__q">${H.hotseatQuestion}</p></div>
        <div class="letter__block"><span class="letter__label">Answer</span><p class="letter__answer">${H.hotseatAnswer}</p></div>
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
  return h`<div class="letter__block"><span class="letter__label">If every mark stands…</span>
    <ol class="proj" role="list">${rows.map((x, i) => h`<li class="proj__row ${x.r.teamId === F.current ? 'is-current' : ''}" ${tstyle(x.t)}>
      <span class="proj__rank num">${i + 1}</span>${mas(x.t, 26)}<span class="proj__name">${x.t?.name || ''}${x.r.judged ? h` <small>· final</small>` : ''}</span>
      <span class="proj__delta ${x.after >= x.r.before ? 'is-up' : 'is-down'}">${signed(x.after - x.r.before)}</span><span class="proj__score num">${fmt(x.after)}</span></li>`)}</ol></div>`;
}

function envelopeHtml(s) {
  const info = privateInfo(s);
  if (!info) {
    return h`<section class="envelope envelope--empty" aria-label="Only you see this">
      <div class="letter"><div class="letter__head">${ic('lock', { size: 16, stroke: 2.6 })}<span>Only you see this</span><span class="letter__never">Never on the TV</span></div>
      <p class="letter__empty">${art('mitten', { size: 40 })}<span>Nothing secret right now. Answers, songs and dare secrets land here. The elves are sworn to secrecy.</span></p></div>
      <div class="envelope__pocket" aria-hidden="true"></div>
    </section>`;
  }
  const sealed = info.secret && !ui.envOpen;
  return h`<section class="envelope ${info.secret ? 'is-secret' : ''} ${sealed ? 'is-sealed' : 'is-open'}" aria-label="Only you see this">
    ${info.secret ? h`<button type="button" class="envelope__front" data-ui="openEnvelope" data-key="open-env" aria-label="${'Open the envelope: shows ' + info.noun}">
      <span class="envelope__flap" aria-hidden="true"></span>
      <span class="envelope__seal" aria-hidden="true">${art('star', { size: 34 })}</span>
      <span class="envelope__to"><b>Tap to open</b><small>${cap(info.noun)} · only you see it</small></span>
    </button>` : ''}
    <div class="letter">
      <div class="letter__head">${ic('lock', { size: 16, stroke: 2.6 })}<span>Only you see this</span><span class="letter__never">Never on the TV</span>
        ${info.secret ? h`<button type="button" class="letter__seal" data-ui="sealEnvelope">${ic('eye-off', { size: 16, stroke: 2.4 })}Seal it</button>` : ''}</div>
      <div class="letter__body">${info.body}</div>
    </div>
    <div class="envelope__pocket" aria-hidden="true"></div>
  </section>`;
}

function timerHtml(s) {
  const t = s.timer;
  if (!t) return '';
  const st = !t.started ? 'ready' : t.ended ? 'ended' : t.running ? 'running' : 'paused';
  const stLabel = { ready: 'Ready when you are', running: 'Running', paused: 'Paused', ended: 'Time’s up!' }[st];
  const main = st === 'running'
    ? { label: 'Pause', icon: 'pause', payload: { action: 'pause' } }
    : st === 'paused' ? { label: 'Resume', icon: 'play', payload: { action: 'resume' } }
      : { label: st === 'ended' ? 'Restart' : 'Start', icon: 'play', payload: { action: 'start' } };
  const tTaken = (s.host.coach.actions || []).some((a) => a.shortcut === 'T' && !a.disabled);
  return h`<section class="card card--sm timer-card is-${st}" aria-label="Timer">
    <div class="timer-card__ring">${timerRing(t, client.serverNow(), { size: 84 })}</div>
    <div class="timer-card__body">
      <span class="timer-card__label">${t.label || 'Timer'}</span>
      <span class="timer-card__state"><i class="state-dot"></i>${stLabel} <small>· <span data-timer-text>${mmss(timerRemaining(t, client.serverNow()))}</span> of ${mmss(t.durationMs)}</small></span>
      <div class="timer-card__btns">
        <button type="button" class="btn btn--secondary btn--sm" data-emit="host:timer" data-payload="${json(main.payload)}" data-key="timer-main" data-needs-online>${ic(main.icon, { size: 18, stroke: 2.6 })}${main.label}${tTaken ? '' : raw('<kbd class="kbd">T</kbd>')}</button>
        <button type="button" class="btn btn--secondary btn--sm" data-emit="host:timer" data-payload="${json({ action: 'add', seconds: 10 })}" data-key="timer-add" data-needs-online>${ic('alarm-clock-plus', { size: 18, stroke: 2.4 })}+10 s</button>
      </div>
    </div>
  </section>`;
}

function sideHtml(s) {
  return h`${envelopeHtml(s)}${timerHtml(s)}`;
}

/* ============================================================================ stage panels */

function stageHtml(s) {
  const c = s.challenge;
  const out = [];
  if (s.phase === 'challenge' || s.phase === 'turnResult') {
    if (c) {
      if (c.type === 'trivia' && c.stage === 'steal') out.push(stealHtml(s));
      if (c.type === 'sounditout') out.push(c.stage === 'steal' ? stealHtml(s) : c.stage === 'perform' ? performerHtml(s, 'Hums the song (no words!)') : '');
      if (c.type === 'dare') out.push(c.stage === 'perform' ? performerHtml(s, 'Performs the dare') : '', c.vote ? voteHtml(s) : '', c.stage === 'done' ? dareResultHtml(s) : '');
      if (c.type === 'showdown' && c.stage !== 'pickRival') out.push(versusHtml(s));
      if (c.type === 'rapidlist') out.push(checklistHtml(s));
      if (c.type === 'hotseat') out.push(hotseatHtml(s));
      if (c.type === 'allplay') out.push(answersHtml(s));
      if (c.type === 'grinch' && c.stage === 'done') out.push(grinchResultHtml(s));
      if (c.type === 'doubledown') out.push(doubleDownHtml(s));
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
    out.push(ceremonyHtml(s), podiumHtml(s));
  }
  return h`${out.filter(Boolean)}`;
}

function panel(title, sub, body, { artId = null, cls = '', eyebrow = '' } = {}) {
  return h`<section class="card card--md stage-panel ${cls}">
    <div class="stage-panel__head">${artId ? art(artId, { size: 44, className: 'stage-panel__art' }) : ''}<div class="stage-panel__titles">${eyebrow ? h`<span class="stage-panel__eyebrow">${eyebrow}</span>` : ''}<h3 class="stage-panel__title">${title}</h3>${sub ? h`<span class="stage-panel__sub">${sub}</span>` : ''}</div></div>
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
  if (b.winner) status = h`<p class="steal__status is-winner" ${tstyle(teamOf(s, b.winner.teamId))}>${ic('bell-ring', { size: 22, stroke: 2.4 })}<span><b>${b.winner.name}</b> (${teamName(s, b.winner.teamId)}) buzzed first. Listen to their answer, then judge.</span></p>`;
  else if (b.armingUntil && b.armingUntil > client.serverNow()) status = h`<p class="steal__status is-arming">${ic('hourglass', { size: 22, stroke: 2.4 })}<span>Buzzers arm in <b data-arming="${b.armingUntil}">3</b>… <em class="cue">(rub your hands together)</em></span></p>`;
  else if (b.open) status = h`<p class="steal__status is-open">${ic('zap', { size: 22, stroke: 2.4 })}<span><b>Buzzers are live!</b> First buzz answers for ${fmt(c.stealPoints)}.</span></p>`;
  else status = h`<p class="steal__status">${ic('lock', { size: 22, stroke: 2.4 })}<span>Buzzers closed. Reopen the steal for the teams that are left, or reveal the answer.</span></p>`;
  return panel(`Steal it for ${fmt(c.stealPoints)}`, 'Each team gets one try', h`
    ${status}
    <ul class="steal__teams" role="list">${others.map((t) => {
      const isLocked = locked.includes(t.id);
      const isWin = b.winner && b.winner.teamId === t.id;
      const isElig = elig.includes(t.id) && !isLocked;
      return h`<li class="steal-team ${isLocked ? 'is-locked' : ''} ${isWin ? 'is-winner' : ''} ${isElig ? 'is-eligible' : ''}" ${tstyle(t)}>${mas(t, 34)}<span class="steal-team__body"><span class="steal-team__name">${t.name}</span>
        <span class="steal-team__state">${isWin ? 'Buzzed first' : isLocked ? 'Locked out' : isElig ? (b.open ? 'Armed' : 'Can steal') : 'Out'}</span></span></li>`;
    })}</ul>`, { eyebrow: 'Steal', artId: 'bell', cls: 'steal' });
}

function performerHtml(s, role) {
  const c = s.challenge;
  const p = c.performer;
  if (!p) return panel('No performer', '', h`<p class="muted">${subject(teamName(s, s.activeTeamId), 'has')} no players. Move someone onto the team, or skip.</p>`, { eyebrow: 'Performer', artId: 'masks' });
  const t = teamOf(s, p.teamId);
  const pl = playerOf(s, p.playerId);
  const partner = c.partner;
  const d = c.dare;
  return h`<section class="card card--md performer" ${tstyle(t)}>
    <span class="performer__spot" aria-hidden="true"></span>
    ${mas(t, 72, 'performer__mascot')}
    <div class="performer__body"><span class="stage-panel__eyebrow">${role}</span><span class="performer__name">${p.name}${partner ? h` <span class="performer__amp">&amp;</span> ${partner.name}` : ''}</span>
      <span class="performer__meta">${pl && !pl.connected ? h`<b class="warn-ink">${ic('wifi-off', { size: 14 })} Phone offline</b> · ` : ''}Random pick from ${t?.name || 'the team'}${d && d.who === 'team' ? ' · the whole team plays' : d && d.who === 'everyone' ? ' · everyone plays' : ''}</span></div>
    ${c.dare?.hasSecret || c.type === 'sounditout' ? peekChip(s) : ''}
  </section>`;
}

function voteHtml(s) {
  const c = s.challenge;
  const v = c.vote;
  if (!v) return '';
  const total = Math.max(1, v.nailed + v.good);
  const res = v.result || (c.dareResult ? c.dareResult.result : null);
  return panel(v.open ? 'The room is voting' : 'Room vote result', `${v.voters} of ${v.eligible} voted${v.open ? ' · phones are voting now' : ''}`, h`
    <div class="vote">
      ${bellMeter({ label: 'Nailed it', count: v.nailed, fill: v.nailed / total, tone: 'holly', size: 'sm', ringing: v.open && v.nailed >= v.good && v.nailed > 0 })}
      ${bellMeter({ label: 'Good try', count: v.good, fill: v.good / total, tone: 'tinsel', size: 'sm', ringing: v.open && v.good > v.nailed })}
    </div>
    ${res ? h`<p class="vote__result">${ic('gavel', { size: 18, stroke: 2.4 })}Result: <b>${{ nailed: 'Nailed it', valiant: 'Valiant effort', fail: 'Not this time' }[res] || res}</b>${v.result && c.dareResult && c.dareResult.result !== v.result ? ' (you overrode it)' : ''}</p>`
      : h`<p class="muted vote__note">Majority wins. A tie counts as Nailed it. You can still overrule the elves.</p>`}`, { eyebrow: 'Room vote', artId: 'bell', cls: 'vote-panel' });
}

function dareResultHtml(s) {
  const c = s.challenge;
  const r = c.dareResult;
  if (!r) return '';
  const label = { nailed: 'Nailed it', valiant: 'Valiant effort', fail: 'Not this time' }[r.result] || r.result;
  return panel(label, r.bonus ? '+50 crowd favourite added' : 'Change it with the buttons above if you need to', h`
    ${r.result === 'fail' ? raw('<span class="stamp stamp--sm is-in">Not this time</span>') : ''}
    ${c.answer ? h`<p class="muted">The secret was <b class="ink">${c.answer}</b>.</p>` : ''}`, { eyebrow: 'Dare judged', artId: r.result === 'fail' ? 'snowman' : 'masks' });
}

function versusHtml(s) {
  const c = s.challenge;
  const a = c.performer;
  const r = c.rival;
  const ta = teamOf(s, s.activeTeamId);
  const tr = r ? teamOf(s, r.teamId) : null;
  const ws = c.winnerSide;
  const side = (t, p, win) => h`<div class="vs__side ${win ? 'is-winner' : ''}" ${tstyle(t)}>${mas(t, 72)}<span class="vs__name">${p?.name || 'Nobody online'}</span><span class="vs__team">${t?.name || ''}</span>${win ? h`<span class="tag tag--holly">Winner</span>` : ''}</div>`;
  return panel(c.showdown?.title || 'Showdown', c.showdown ? `${c.showdown.time} s · winner takes 200` : '', h`
    <div class="vs">${side(ta, a, ws === 'active')}<span class="vs__ball" aria-hidden="true">VS</span>${side(tr, r, ws === 'rival')}</div>
    ${ws === 'tie' ? h`<p class="vote__result">${ic('hand-heart', { size: 18 })}A tie: 100 each. Hug it out.</p>` : ''}`, { eyebrow: 'Head to head', artId: 'boxing', cls: 'versus' });
}

function checklistHtml(s) {
  const c = s.challenge;
  const l = c.list;
  const answers = s.host.listAnswers || l.answers || [];
  const ticked = l.ticked || [];
  const otherCount = ticked.filter((x) => x === 'Other answer').length;
  const pts = Math.min(l.count, l.max) * l.each;
  const keyed = answers.slice(0, 9);
  const segs = Array.from({ length: l.max }, (_, i) => raw(`<i class="${i < l.count ? 'is-on' : ''}"></i>`));
  return panel(l.prompt, c.stage === 'done' ? 'Time’s up. Late ticks still count.' : 'Tap what they shout (or press 1–9). Tap again to untick.', h`
    <div class="list-paper">
      <div class="list-paper__head"><span class="list-paper__title">Santa’s list</span><span class="list-paper__count"><b class="num">${Math.min(l.count, l.max)}</b> of ${l.max} · ${fmt(pts)} points</span></div>
      <ul class="checklist" role="list">${answers.map((a, i) => {
        const on = ticked.includes(a);
        return h`<li><button type="button" class="check ${on ? 'is-on' : ''}" data-emit="${on ? 'host:listUntick' : 'host:listTick'}" data-payload="${json({ answer: a })}" data-key="${'tick:' + a}" aria-pressed="${on ? 'true' : 'false'}" data-needs-online>
          <span class="check__box">${on ? ic('check', { size: 18, stroke: 3.4 }) : ''}</span><span class="check__label">${a}</span>${i < keyed.length ? h`<kbd class="kbd">${i + 1}</kbd>` : ''}</button></li>`;
      })}</ul>
      <div class="checklist__other">
        <button type="button" class="btn btn--dashed btn--sm" data-emit="host:listOther" data-key="list-other" data-needs-online>${ic('plus', { size: 18, stroke: 2.6 })}Other valid answer</button>
        ${otherCount ? h`<button type="button" class="chip-sm chip-sm--on" data-emit="host:listUntick" data-payload="${json({ answer: 'Other answer' })}" aria-label="Remove one other answer">${ic('check', { size: 14, stroke: 3 })}${otherCount} other ${otherCount === 1 ? 'answer' : 'answers'} ${ic('x', { size: 14, stroke: 2.6 })}</button>` : ''}
      </div>
      <div class="segments" aria-hidden="true">${segs}</div>
    </div>`, { eyebrow: 'Rapid List', artId: 'list', cls: 'checklist-panel' });
}

function hotseatHtml(s) {
  const c = s.challenge;
  const hs = c.hotseat;
  const qs = s.host.hotseatQuestions || [];
  const res = { correct: ['check', 'is-correct', 'Correct'], wrong: ['x', 'is-wrong', 'Wrong'], pass: ['skip-forward', 'is-pass', 'Passed'] };
  const socks = Array.from({ length: hs.total }, (_, i) => {
    const r = hs.results[i];
    return stocking({ state: r === 'correct' ? 'full' : r === 'wrong' || r === 'pass' ? 'coal' : 'empty', size: 40, color: r === 'correct' ? '#1F7A4A' : undefined });
  });
  return panel(`${c.performer?.name || 'The player'} is in the Hot Seat`, `${hs.results.filter((r) => r === 'correct').length} right of ${hs.total} · ${fmt(hs.banked || 0)} banked · ${hs.each} each`, h`
    <div class="socks" aria-label="${hs.results.length + ' of ' + hs.total + ' questions done'}">${socks}</div>
    <ol class="hotseat" role="list">${qs.map((q) => {
      const r = q.result ? res[q.result] : null;
      const cur = q.index === hs.index && c.stage === 'hotseat';
      return h`<li class="hs-row ${r ? r[1] : ''} ${cur ? 'is-current' : ''}">
        <span class="hs-row__n">${r ? ic(r[0], { size: 16, stroke: 3 }) : q.index + 1}</span>
        <span class="hs-row__q">${q.question}</span>
        <span class="hs-row__a">${q.answer}</span>
        <span class="hs-row__state">${cur ? 'Now' : r ? r[2] : ''}</span></li>`;
    })}</ol>`, { eyebrow: 'Hot Seat', artId: 'fire', cls: 'hotseat-panel' });
}

function matchPill(sub, locked = false) {
  if (!sub) return locked ? h`<span class="mark mark--hidden">${ic('circle', { size: 14 })}Blank</span>` : h`<span class="mark mark--wait">${ic('hourglass', { size: 14 })}Waiting</span>`;
  if (sub.override != null) return h`<span class="mark ${sub.override ? 'mark--yes' : 'mark--no'}">${ic('pencil', { size: 14 })}${sub.override ? 'You accepted' : 'You rejected'}</span>`;
  if (sub.match === 'exact') return h`<span class="mark mark--yes">${ic('check', { size: 14, stroke: 3 })}Exact</span>`;
  if (sub.match === 'match') return h`<span class="mark mark--yes">${ic('check', { size: 14, stroke: 3 })}Match</span>`;
  if (sub.match === 'close') return h`<span class="mark mark--close">${ic('triangle-alert', { size: 14 })}Close: check it</span>`;
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
    return h`<li class="ans-row ${needs ? 'is-check' : ''} ${!sub ? 'is-empty' : ''}" ${tstyle(t)}>
      <span class="ans-row__team">${mas(t, 34)}<span class="ans-row__name"><b>${t.name}</b>${sub && sub.first ? h`<span class="tag tag--ember ans-tag">${ic('zap', { size: 12 })}First right</span>` : ''}${needs ? h`<span class="tag ans-tag">Needs you</span>` : ''}</span></span>
      <span class="ans-row__text">${sub ? h`<b>“${sub.text}”</b><small>${sub.name}${sub.elapsedMs > 0 ? ` · ${secsText(sub.elapsedMs)}` : ''}</small>` : h`<i>No answer yet</i><small>${done || c.stage === 'marking' ? 'Counts as blank' : 'Still typing…'}</small>`}</span>
      <span class="ans-row__mark">${matchPill(sub, done || c.stage === 'marking')}</span>
      <span class="ans-row__call">
        <button type="button" class="judge judge--yes ${yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: t.id, correct: true })}" data-key="${'yes:' + t.id}" aria-label="${'Accept ' + t.name + '’s answer'}" aria-pressed="${yes ? 'true' : 'false'}" ${sub && canMark ? '' : raw('disabled')} data-needs-online>${ic('check', { size: 20, stroke: 3 })}</button>
        <button type="button" class="judge judge--no ${sub && !yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: t.id, correct: false })}" data-key="${'no:' + t.id}" aria-label="${'Reject ' + t.name + '’s answer'}" aria-pressed="${sub && !yes ? 'true' : 'false'}" ${sub && canMark ? '' : raw('disabled')} data-needs-online>${ic('x', { size: 20, stroke: 3 })}</button>
      </span>
      <span class="ans-row__award num ${award > 0 ? 'is-plus' : ''}">${award == null ? '—' : award > 0 ? `+${fmt(award)}` : '0'}</span>
    </li>`;
  });
  const answered = subs.length;
  const sub = done ? 'Revealed on the TV. You can still flip a mark.' : c.stage === 'marking' ? 'Answers locked and auto-marked. Flip any you disagree with.' : `${answered} of ${s.teams.length} teams in. Answers stay hidden on the TV.`;
  return panel(isBonus ? 'Bonus answers' : 'Everybody’s answers', sub, h`
    <div class="ans-head" aria-hidden="true"><span>Team</span><span>Typed answer</span><span>Auto-mark</span><span>Your call</span><span>Points</span></div>
    <ul class="answers" role="list">${rows}</ul>
    <p class="answers__foot">${art('money', { size: 26 })}<span>${done ? 'Paid out' : 'Paying out'} <b>${fmt(done ? pub.reduce((a, x) => a + (x.delta || 0), 0) : H.payout || 0)}</b>${isBonus ? ' · 100 for each right answer' : ' · 100 each, +50 for the first right answer'}</span></p>`, { eyebrow: isBonus ? 'Round bonus' : 'All Play', artId: 'zap', cls: 'answers-panel' });
}

function grinchResultHtml(s) {
  const c = s.challenge;
  if (c.steal) return panel(`${teamName(s, c.steal.to)} stole ${fmt(c.steal.amount)}`, `from ${teamName(s, c.steal.from)}. Boo! (Affectionately.)`, '', { eyebrow: 'Grinch Steal', artId: 'money' });
  if (c.gift) return panel(`A gift of ${fmt(c.gift.amount)} to ${teamName(s, c.gift.toTeamId)}`, `${subject(teamName(s, s.activeTeamId), 'was')} already in the lead, so the Grinch’s heart grew three sizes`, '', { eyebrow: 'Grinch Steal', artId: 'gift' });
  return '';
}

function doubleDownHtml(s) {
  const act = teamOf(s, s.activeTeamId);
  return panel('Double Down!', `${subject(act?.name || 'The team', 'spins')} again. Everything they win this turn is ×2.`, h`<p class="muted">Ham it up: “Double or nothing! Well… double or slightly less.”</p>`, { eyebrow: 'Wheel bonus', artId: 'sparkles', cls: 'dd-panel' });
}

function resultHtml(s) {
  const c = s.challenge;
  const aw = (c.result?.awards || []).filter((a) => a.delta);
  if (!aw.length) {
    if (c.result?.kind === 'missed' || c.result?.kind === 'skipped') {
      return panel(c.result.kind === 'skipped' ? 'Skipped' : 'Nobody scored', c.result.kind === 'skipped' ? 'No points this time' : 'The answer is on the TV', raw('<span class="stamp stamp--sm is-in">Not this time</span>'), { eyebrow: 'Turn result', artId: 'snowman', cls: 'result-panel' });
    }
    return '';
  }
  return panel('Points this turn', 'Wrong? Fix it with − / + or Undo', h`<ul class="awards" role="list">${aw.map((a) => {
    const t = teamOf(s, a.teamId);
    return h`<li class="award-row" ${tstyle(t)}>${mas(t, 36)}<span>${t?.name || ''}</span><b class="num ${a.delta > 0 ? 'is-plus' : 'is-minus'}">${signed(a.delta)}</b></li>`;
  })}</ul>`, { eyebrow: 'Turn result', artId: 'trophy', cls: 'result-panel' });
}

function standingsHtml(s) {
  const rb = s.roundBreak;
  if (!rb) return '';
  const st = rb.standings || [];
  const leader = st.length ? teamOf(s, st[0].teamId) : null;
  const last = st.length > 1 ? teamOf(s, st[st.length - 1].teamId) : null;
  return panel(`Standings after round ${rb.round}`, rb.finalNext ? 'Next: the final round, then Final Chaos' : `Next: round ${rb.nextRound} of ${s.totalRounds}`, h`
    <ol class="standings" role="list">${st.map((x) => {
      const t = teamOf(s, x.teamId);
      const mv = x.move === 'up' ? ['arrow-up', 'is-up', `Up ${x.places}`] : x.move === 'down' ? ['arrow-down', 'is-down', `Down ${x.places}`] : null;
      return h`<li class="stand-row ${x.rank === 1 ? 'is-first' : ''}" ${tstyle(t)}><span class="stand-row__rank">${ordinal(x.rank)}</span>${mas(t, 40)}<span class="stand-row__name">${t?.name || ''}</span>
        ${mv ? h`<span class="move ${mv[1]}">${ic(mv[0], { size: 14, stroke: 3 })}${mv[2]}</span>` : ''}<b class="stand-row__score">${fmt(x.score)}</b></li>`;
    })}</ol>
    ${leader && last && leader.id !== last.id && (st[0].score > 0) ? h`<div class="roast">
      <p class="roast__line"><span class="roast__tag">Roast the leader</span>“${leader.name}, enjoy the view from the top. Final Chaos is coming for you.” <em class="cue">(with a wink)</em></p>
      <p class="roast__line"><span class="roast__tag roast__tag--holly">Pep talk</span>“${last.name}, comebacks are a Christmas tradition. Just ask the Grinch.” <em class="cue">(warmly)</em></p>
    </div>` : ''}`, { eyebrow: 'Hot cocoa break', artId: 'cocoa', cls: 'standings-panel' });
}

function wagersHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const intro = s.phase === 'finalIntro';
  const locked = F.wagers.filter((w) => w.locked).length;
  return panel(intro ? 'Teams and their wager limits' : 'Wagers', intro ? 'Up to their score, or 300 if they’re behind' : `${locked} of ${F.wagers.length} locked in. Amounts stay hidden on the TV.`, h`
    <ul class="wagers" role="list">${F.wagers.map((w) => {
      const t = teamOf(s, w.teamId);
      return h`<li class="wager-row ${w.locked ? 'is-locked' : ''}" ${tstyle(t)}>
        <span class="wager-row__gift">${present({ size: 'sm', color: safeColor(t?.color, '#D42A2A'), ribbon: '#EDB321', state: w.locked ? 'sealed' : 'closed' })}</span>
        ${mas(t, 34)}<span class="wager-row__name"><b>${t?.name || ''}</b><small>${fmt(t?.score || 0)} pts · max ${fmt(w.max)}</small></span>
        <span class="wager-row__state">${intro ? '' : w.locked ? h`<span class="mark mark--yes">${ic('lock', { size: 14 })}Sealed${w.by ? ` by ${w.by}` : ''}</span>` : w.amount != null ? h`<span class="mark mark--wait">Thinking… ${fmt(w.amount)}</span>` : h`<span class="mark mark--wait">${ic('hourglass', { size: 14 })}Wagering</span>`}</span>
        <b class="wager-row__amt num">${intro ? '' : w.amount != null ? fmt(w.amount) : '—'}</b></li>`;
    })}</ul>`, { eyebrow: 'Final Chaos · Christmas Eve', artId: 'moon', cls: 'wagers-panel eve-panel' });
}

function finalAnswersHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const canMark = !!s.host.can.markAnswer;
  const n = F.answers.filter((a) => a.text).length;
  return panel('Final answers', `${n} of ${F.answers.length} in. Pre-mark now, or judge during the reveal.`, h`
    <div class="ans-head" aria-hidden="true"><span>Team</span><span>Typed answer</span><span>Auto-mark</span><span>Your call</span><span>Wager</span></div>
    <ul class="answers" role="list">${F.answers.map((a) => {
      const t = teamOf(s, a.teamId);
      const w = F.wagers.find((x) => x.teamId === a.teamId);
      const yes = a.override != null ? a.override : a.autoCorrect;
      const sub = a.text ? a : null;
      return h`<li class="ans-row ${!sub ? 'is-empty' : ''}" ${tstyle(t)}>
        <span class="ans-row__team">${mas(t, 34)}<span class="ans-row__name"><b>${t?.name || ''}</b></span></span>
        <span class="ans-row__text">${sub ? h`<b>“${a.text}”</b><small>${a.by || ''}</small>` : h`<i>No answer yet</i><small>Still typing…</small>`}</span>
        <span class="ans-row__mark">${matchPill(sub)}</span>
        <span class="ans-row__call">
          <button type="button" class="judge judge--yes ${sub && yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: a.teamId, correct: true })}" aria-label="${'Accept ' + (t?.name || '')}" ${sub && canMark ? '' : raw('disabled')}>${ic('check', { size: 20, stroke: 3 })}</button>
          <button type="button" class="judge judge--no ${sub && !yes ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: a.teamId, correct: false })}" aria-label="${'Reject ' + (t?.name || '')}" ${sub && canMark ? '' : raw('disabled')}>${ic('x', { size: 20, stroke: 3 })}</button>
        </span>
        <span class="ans-row__award num">${w ? fmt(w.amount || 0) : '—'}</span></li>`;
    })}</ul>`, { eyebrow: 'Final Chaos · Christmas Eve', artId: 'moon', cls: 'answers-panel eve-panel' });
}

function finalRevealHtml(s) {
  const F = s.host.final;
  if (!F) return '';
  const canMark = !!s.host.can.markAnswer;
  const cur = F.rows.find((r) => r.teamId === F.current && r.revealed && !r.judged);
  const curTeam = cur ? teamOf(s, cur.teamId) : null;
  return panel('The reveal', 'Lowest score first. The TV sees each answer only when you reveal it.', h`
    ${cur ? h`<div class="drumroll" ${tstyle(curTeam)}>
      <span class="drumroll__label">${art('bell', { size: 28 })}Drumroll moment</span>
      <p class="drumroll__line"><em class="cue">(drum on the table)</em> “${curTeam?.name || ''} wagered… <b>${fmt(cur.wager)}</b>.” <em class="cue">(pause)</em> “Their answer… <b>${cur.text ? `“${cur.text}”` : 'nothing at all'}</b>.” <em class="cue">(longer pause, look at the TV)</em> “That is… <b>${cur.correct ? 'CORRECT!' : 'not right.'}</b>”</p>
    </div>` : ''}
    <div class="fr-head" aria-hidden="true"><span>#</span><span>Team</span><span>Wager</span><span>Typed answer</span><span>Your call</span><span>Status</span><span>Total</span></div>
    <ol class="final-rows" role="list">${F.rows.map((r, i) => {
      const t = teamOf(s, r.teamId);
      const isCur = r.teamId === F.current;
      const nextUp = !r.revealed && F.rows.findIndex((x) => !x.revealed) === i;
      const how = r.override != null ? 'Your call' : { exact: 'Exact match', match: 'Matches the answer', close: 'Close spelling', none: 'No match' }[r.match] || '';
      let status;
      if (r.judged) status = h`<span class="mark ${r.correct ? 'mark--yes' : 'mark--no'}">${r.correct ? 'Correct' : 'Missed'} ${signed(r.delta || 0)}</span>`;
      else if (r.revealed) status = h`<span class="mark mark--now">${ic('mic', { size: 14 })}Reading now</span>`;
      else status = h`<span class="mark mark--hidden">${ic('eye-off', { size: 14 })}Hidden on TV</span>`;
      const total = r.judged ? r.after : r.before;
      return h`<li class="fr-row ${isCur && !r.judged ? 'is-current' : ''} ${r.judged ? 'is-judged' : ''}" ${tstyle(t)}>
        <span class="fr-row__n num">${i + 1}</span>
        <span class="fr-row__team">${mas(t, 32)}<span><b>${t?.name || ''}</b>${isCur && !r.judged ? h`<span class="tag fr-tag">On TV now</span>` : nextUp ? h`<span class="tag tag--ghost fr-tag">Up next</span>` : ''}</span></span>
        <span class="fr-row__wager num">${fmt(r.wager)}</span>
        <span class="fr-row__text"><b>${r.text ? `“${r.text}”` : 'No answer'}</b><small class="${r.correct ? 'ok-ink' : 'bad-ink'}">${how}</small></span>
        <span class="fr-row__call">
          <button type="button" class="pickbtn pickbtn--yes ${r.correct ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: r.teamId, correct: true })}" ${canMark && r.text ? '' : raw('disabled')}>${ic('check', { size: 16, stroke: 3 })}${r.correct ? 'Accepted' : 'Accept'}</button>
          <button type="button" class="pickbtn pickbtn--no ${!r.correct ? 'is-on' : ''}" data-emit="host:markAnswer" data-payload="${json({ teamId: r.teamId, correct: false })}" ${canMark && r.text ? '' : raw('disabled')}>${ic('x', { size: 16, stroke: 3 })}${!r.correct ? 'Rejected' : 'Reject'}</button>
        </span>
        <span class="fr-row__status">${status}</span>
        <span class="fr-row__total num">${fmt(total)}${!r.judged && r.revealed ? h`<small>${fmt(r.wager)} riding on it</small>` : ''}</span>
      </li>`;
    })}</ol>`, { eyebrow: 'Final Chaos · Christmas Eve', artId: 'moon', cls: 'final-panel eve-panel' });
}

const AWARD_ART = { fastestFinger: 'zap', starPerformer: 'masks', lumpOfCoal: 'snowman', grinchOfTheYear: 'money', silentNight: 'moon', comebackKid: 'sled', rudolph: 'deer' };

/** The podium "awards ceremony": a printed script card to read out, drumrolls included. */
function ceremonyHtml(s) {
  const pd = s.podium;
  if (!pd) return '';
  const byPlace = [...(pd.standings || [])].sort((a, b) => b.place - a.place);
  const podium = byPlace.filter((x) => x.place <= 3);
  const winners = (pd.standings || []).filter((x) => x.place === 1).map((x) => teamName(s, x.teamId));
  const awards = Array.isArray(pd.awards) ? pd.awards : [];
  const placeLine = (x) => {
    const t = teamOf(s, x.teamId);
    if (x.place === 1) return null;
    return h`<li class="cer__line">${mas(t, 34)}<p>“In ${ordinal(x.place)} place, with <b>${fmt(x.score)}</b> points…” <em class="cue">(pause)</em> “<b>${t?.name || ''}</b>!” <em class="cue">(applause)</em></p></li>`;
  };
  let n = 0;
  return h`<section class="card card--md ceremony" aria-labelledby="cer-h">
    <div class="ceremony__top">${art('trophy', { size: 56 })}<div><span class="stage-panel__eyebrow">Read it out loud</span><h3 class="ceremony__title" id="cer-h">The awards ceremony</h3><span class="stage-panel__sub">Slow down. Drumroll, pause, then the name. You’re the star now.</span></div></div>
    <div class="ceremony__paper">
      <section class="cer__sec"><h4 class="cer__h"><span class="cer__n">${++n}</span>The podium</h4>
        <ol class="cer__lines" role="list">${podium.map(placeLine)}
          ${winners.length ? h`<li class="cer__line cer__line--big">${art('glowing-star', { size: 38 })}<p><em class="cue">(drumroll on the table, the longest one of the night)</em> “And the winner of Christmas Chaos is…” <em class="cue">(pause… longer… longer)</em> “<b>${listJoin(winners, 'and')}</b>!” <em class="cue">(arms up, lead the cheer)</em></p></li>` : ''}
        </ol></section>
      ${awards.length ? h`<section class="cer__sec"><h4 class="cer__h"><span class="cer__n">${++n}</span>The awards</h4>
        <ol class="cer__awards" role="list">${awards.map((a) => {
          const tids = Array.isArray(a.teamIds) && a.teamIds.length ? a.teamIds : a.teamId ? [a.teamId] : [];
          const pids = Array.isArray(a.playerIds) && a.playerIds.length ? a.playerIds : a.playerId ? [a.playerId] : [];
          const t = tids.length === 1 ? teamOf(s, tids[0]) : null;
          const coal = a.key === 'lumpOfCoal';
          // who to read out: one team ("Sam from Team Rudolph"), or each player with their own team in a shared award
          const who = pids.length > 1 && tids.length > 1 && pids.every((id) => playerOf(s, id))
            ? listJoin(pids.map((id) => { const p = playerOf(s, id); return `${p.name} from ${teamName(s, p.teamId)}`; }), 'and')
            : `${a.name || 'everyone'}${t && pids.length ? ` from ${t.name}` : ''}`;
          return h`<li class="award-tag ${coal ? 'is-coal' : ''}" ${t ? tstyle(t) : ''}>
            <span class="award-tag__art">${art(a.art || AWARD_ART[a.key] || 'medal1', { size: 52 })}</span>
            <div class="award-tag__body">
              <span class="award-tag__title">${a.title || 'Award'}</span>
              <p class="award-tag__say"><em class="cue">(drumroll)</em> “The ${a.title || 'award'} goes to…” <em class="cue">(${coal ? 'try not to laugh' : 'pause'})</em> “<b>${who}</b>!”</p>
              ${a.detail ? h`<small class="award-tag__detail">${a.detail}</small>` : ''}
            </div></li>`;
        })}</ol></section>` : ''}
      <section class="cer__sec"><h4 class="cer__h"><span class="cer__n">${++n}</span>Sign-off</h4>
        <p class="cer__close">“Thanks for playing, everyone, and Merry Christmas!” <em class="cue">(take a bow; you earned it)</em></p></section>
    </div>
  </section>`;
}

function podiumHtml(s) {
  const pd = s.podium;
  if (!pd) return '';
  return panel('Final standings', 'The podium is on the TV', h`
    <ol class="standings" role="list">${pd.standings.map((x) => {
      const t = teamOf(s, x.teamId);
      return h`<li class="stand-row ${x.place === 1 ? 'is-first' : ''}" ${tstyle(t)}><span class="stand-row__rank">${x.place <= 3 ? art(`medal${x.place}`, { size: 30 }) : ordinal(x.place)}</span>${mas(t, 40)}<span class="stand-row__name">${t?.name || ''}</span><b class="stand-row__score">${fmt(x.score)}</b></li>`;
    })}</ol>`, { eyebrow: 'Game over', artId: 'party', cls: 'podium-panel' });
}

/* ============================================================================ mirror: on the TV now */

function quipBubble(s) {
  const q = s.quip;
  if (!q || !q.text) return '';
  return h`<p class="tv-quip">${art('santa', { size: 34 })}<span><small>The TV quips</small>“${q.text}”</span></p>`;
}

function mirrorHtml(s) {
  const m = mirrorContent(s);
  if (!m) return '';
  return h`<div class="mirror__head"><span class="mirror__label">${ic('tv', { size: 18, stroke: 2.4 })}On the TV now</span><span class="mirror__sub">${m.sub || ''}</span></div>
    <div class="mirror__screen ${m.cls || ''}">${m.body}${quipBubble(s)}</div>`;
}

function miniRing(s) {
  if (!s.timer) return '';
  return timerRing(s.timer, client.serverNow(), { size: 72 });
}

function mirrorContent(s) {
  const c = s.challenge;
  const act = teamOf(s, s.activeTeamId);
  switch (s.phase) {
    case 'turnIntro':
      return { sub: 'Turn intro · the wheel is waiting', cls: 'is-split', body: h`<div class="mini-wheel"><svg class="mini-wheel__svg" id="mini-wheel" aria-hidden="true"></svg></div>
        <div class="mirror__text">${mas(act, 72)}<p class="mirror__big">${act?.name || ''}, you’re up!</p><p class="mirror__line">Spin from any ${act?.name || ''} phone.</p></div>` };
    case 'spinning':
      return { sub: s.spin?.by ? `${s.spin.by.name} is spinning…` : 'The wheel is spinning…', cls: 'is-split', body: h`<div class="mini-wheel is-big"><svg class="mini-wheel__svg" id="mini-wheel" aria-hidden="true"></svg></div>
        <div class="mirror__text"><p class="mirror__big">${s.spin?.by ? `${s.spin.by.name} is spinning…` : 'Spinning…'}</p><p class="mirror__line">It lands in a few seconds. Then follow the note card.</p></div>` };
    case 'challenge':
    case 'turnResult':
      return c ? challengeMirror(s, c) : null;
    case 'roundBreak': {
      const rb = s.roundBreak;
      if (c && c.type === 'bonus') return challengeMirror(s, c);
      return { sub: 'Hot cocoa break', body: h`<p class="mirror__eyebrow">${art('cocoa', { size: 26 })}End of round ${rb?.round || s.round}</p><p class="mirror__big">${rb?.finalNext ? `Round ${rb.nextRound}: the final round!` : rb ? `Round ${rb.nextRound} of ${s.totalRounds} is next` : ''}</p>
        <div class="mirror__teams">${(rb?.standings || []).slice(0, 8).map((x) => { const t = teamOf(s, x.teamId); return h`<span class="mini-tile" ${tstyle(t)}>${mas(t, 26)}<b class="num">${fmt(x.score)}</b></span>`; })}</div>` };
    }
    case 'finalIntro':
      return { sub: 'Christmas Eve · category only', cls: 'is-eve', body: h`<p class="mirror__eyebrow">${art('moon', { size: 26 })}Final Chaos</p><p class="mirror__big">Category: ${s.final?.categoryLabel || ''}</p><p class="mirror__line">The question stays hidden until every wager is in.</p>` };
    case 'finalWager':
    case 'finalAnswer': {
      const F = s.final;
      const list = s.phase === 'finalWager' ? F.wagers.map((w) => ({ id: w.teamId, ok: w.locked })) : F.submissions.map((x) => ({ id: x.teamId, ok: x.answered }));
      return { sub: s.phase === 'finalWager' ? 'Wagers sealing · amounts hidden' : 'Teams typing their final answer', cls: 'is-eve', body: h`
        <div class="mirror__row"><div class="mirror__text"><p class="mirror__eyebrow">${art('moon', { size: 26 })}Final Chaos · ${F.categoryLabel}</p>
        <p class="mirror__q">${s.phase === 'finalAnswer' && F.question ? F.question : 'Every team: seal your wager!'}</p></div>${miniRing(s)}</div>
        <div class="mirror__teams">${list.map((x) => { const t = teamOf(s, x.id); return h`<span class="mini-tile ${x.ok ? 'is-ok' : ''}" ${tstyle(t)}>${mas(t, 26)}<b>${x.ok ? (s.phase === 'finalWager' ? 'Sealed' : 'Answered') : s.phase === 'finalWager' ? 'Wagering…' : 'Typing…'}</b></span>`; })}</div>` };
    }
    case 'finalReveal': {
      const F = s.final;
      const cur = F.revealed.find((r) => r.teamId === F.current);
      const t = cur ? teamOf(s, cur.teamId) : null;
      return { sub: cur ? `${possessive(t?.name || '')} answer is on the TV` : 'The reveal', cls: 'is-eve', body: h`<p class="mirror__eyebrow">${art('moon', { size: 26 })}Final Chaos · ${F.categoryLabel}</p><p class="mirror__q">${F.question || ''}</p>
        ${cur ? h`<p class="mirror__line"><b>${t?.name}</b> wagered ${fmt(cur.wager)} · “${cur.text || 'no answer'}”${cur.judged ? h` · <b>${cur.correct ? 'Correct' : 'Wrong'} ${signed(cur.delta || 0)}</b>` : ''}</p>` : ''}` };
    }
    case 'podium': {
      const pd = s.podium;
      const win = pd?.standings.filter((x) => x.place === 1).map((x) => teamName(s, x.teamId)) || [];
      return { sub: 'Podium · confetti', body: h`<p class="mirror__eyebrow">${art('trophy', { size: 26 })}Game over</p><p class="mirror__big">${listJoin(win, 'and')} ${win.length > 1 || isPluralTeam(win[0]) ? 'win' : 'wins'} Christmas!</p>` };
    }
    default:
      return null;
  }
}

function challengeMirror(s, c) {
  const sg = c.type === 'bonus' ? segOf(s, 10) : segOf(s, c.segmentIndex);
  const label = c.type === 'bonus' ? 'Bonus question' : sg?.label || '';
  const chip = sg ? slotChip(sg, { size: 'sm', text: label }) : '';
  const act = teamOf(s, s.activeTeamId);
  const ring = miniRing(s);
  const done = c.stage === 'done';
  let body = '';
  let sub = '';
  switch (c.type) {
    case 'trivia': {
      if (c.stage === 'pickDifficulty') {
        sub = 'Picking a present';
        body = h`<div class="mirror__chips">${chip}</div><p class="mirror__big">${subject(act?.name || 'The team', 'is')} choosing…</p>
          <div class="mirror__levels"><span>Easy <b>100</b></span><span>Medium <b>200</b></span><span>Hard <b>300</b></span></div>`;
      } else {
        const b = c.buzz;
        sub = done ? (c.result?.kind === 'missed' ? 'Answer revealed · nobody scored' : 'Answer revealed') : c.stage === 'steal' ? (b?.winner ? `${b.winner.name} buzzed first` : 'Steal! Buzzers') : 'Question in play';
        body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}${c.difficulty ? h`<span class="chip chip--sm chip--level">${cap(c.difficulty)}</span>` : ''}<span class="chip chip--sm chip--points">${fmt(c.points)} points</span></div>
          ${c.movie ? h`<p class="mirror__film">${art('film', { size: 22 })}${c.movie}${c.movieYear ? ` (${c.movieYear})` : ''}</p>` : ''}
          <p class="mirror__line">${c.stage === 'steal' ? h`<b>Steal for ${fmt(c.stealPoints)}!</b> ${b?.winner ? `${b.winner.name} (${teamName(s, b.winner.teamId)}) buzzed first` : b?.open ? 'Buzzers are live' : b?.armingUntil ? 'Get ready…' : 'Buzzers closed'}` : h`<b>${act?.name || ''}</b>, answer out loud`}</p>
          <p class="mirror__q">${c.question || ''}</p>
          ${c.hint ? h`<p class="mirror__hint">${ic('lightbulb', { size: 16 })}Hint: ${c.hint}</p>` : ''}
          ${c.answer ? h`<p class="mirror__answer ${c.result?.kind === 'missed' ? 'is-miss' : ''}">${ic(c.result?.kind === 'missed' ? 'x' : 'check', { size: 20, stroke: 3 })}${c.answer}</p>` : ''}</div>${ring}</div>`;
      }
      break;
    }
    case 'sounditout':
      sub = done ? 'Song revealed' : 'The song is never shown before the reveal';
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="chip chip--sm chip--points">${fmt(c.points)} points</span></div>
        <p class="mirror__big">${c.performer?.name || 'Someone'} is humming… ${act?.name || ''}, name that tune!</p>
        ${c.answer ? h`<p class="mirror__answer">${ic('music', { size: 20 })}${c.answer}${c.artist ? ` · ${c.artist}` : ''}</p>` : ''}</div>${ring}</div>`;
      break;
    case 'dare': {
      const d = c.dare || {};
      sub = c.stage === 'vote' ? 'Sleigh-bell meters · phones voting' : 'Dare in play · the secret is never shown';
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="chip chip--sm chip--points">${fmt(c.points)} points</span></div>
        <p class="mirror__title">${d.title || 'Dare'}</p><p class="mirror__line">${d.instructions || ''}</p>
        <p class="mirror__line mirror__line--meta">${ic('users', { size: 16 })}${c.performer ? `${c.performer.name}${c.partner ? ` & ${c.partner.name}` : ''} performs` : act?.name || ''}${d.hasSecret ? ' · the secret is on their phone' : ''}</p></div>${ring}</div>`;
      break;
    }
    case 'showdown':
      sub = c.stage === 'pickRival' ? (c.eyeing ? `${c.eyeing.by.name} is eyeing ${teamName(s, c.eyeing.teamId)}…` : `${subject(act?.name || 'The team', 'is')} picking a rival`) : 'Split screen · head to head';
      body = c.stage === 'pickRival'
        ? h`<div class="mirror__chips">${chip}</div><p class="mirror__big">${act?.name || ''}, pick your rival!</p>`
        : h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="chip chip--sm chip--points">Winner takes 200</span></div><p class="mirror__title">${c.showdown?.title || ''}</p>
          <p class="mirror__line">${c.performer?.name || '?'} (${act?.name || ''}) vs ${c.rival?.name || '?'} (${c.rival ? teamName(s, c.rival.teamId) : ''})</p></div>${ring}</div>`;
      break;
    case 'rapidlist': {
      const l = c.list;
      sub = 'Each tick shows on the TV right away';
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="chip chip--sm chip--points">${l.each} each · max ${fmt(l.max * l.each)}</span></div><p class="mirror__title">${l.prompt}</p>
        <div class="mirror__ticks">${l.ticked.map((t) => h`<span class="chip-sm chip-sm--on">${ic('check', { size: 14, stroke: 3 })}${t}</span>`)}</div></div>
        <div class="mirror__count"><b>${Math.min(l.count, l.max)}</b><span>of ${l.max}</span></div>${ring}</div>`;
      break;
    }
    case 'hotseat': {
      const hs = c.hotseat;
      sub = hs.question ? `Question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}` : 'Waiting for the clock';
      const dots = Array.from({ length: hs.total }, (_, i) => raw(`<i class="hs-dot ${hs.results[i] ? 'is-' + hs.results[i] : i === hs.index ? 'is-current' : ''}"></i>`));
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}<span class="chip chip--sm chip--points">${fmt(hs.banked || 0)} banked</span></div>
        <p class="mirror__line"><b>${c.performer?.name || ''}</b> is in the Hot Seat</p><p class="mirror__q">${hs.question || 'The question appears when the clock starts.'}</p><div class="hs-dots">${dots}</div></div>${ring}</div>`;
      break;
    }
    case 'allplay':
    case 'bonus': {
      const subs = c.submissions || [];
      sub = done ? 'Every answer is on the TV' : `${subs.filter((x) => x.answered).length} of ${s.teams.length} teams answered · answers hidden`;
      body = h`<div class="mirror__row"><div class="mirror__text"><div class="mirror__chips">${chip}</div><p class="mirror__line"><b>${c.type === 'bonus' ? 'Bonus question' : 'All Play'}</b>: every team, type your answer!</p>
        <p class="mirror__q">${c.question || ''}</p>${c.answer ? h`<p class="mirror__answer">${ic('check', { size: 20, stroke: 3 })}${c.answer}</p>` : ''}</div>${ring}</div>
        <div class="mirror__teams">${s.teams.map((t) => { const x = subs.find((y) => y.teamId === t.id); return h`<span class="mini-tile ${x?.answered ? 'is-ok' : ''} ${done && x?.correct ? 'is-right' : ''}" ${tstyle(t)}>${mas(t, 26)}<b>${done ? (x?.correct ? signed(x.delta || 0) : 'Missed') : x?.answered ? 'Answered' : '…'}</b></span>`; })}</div>`;
      break;
    }
    case 'grinch':
      sub = c.stage === 'pickTarget' ? (c.eyeing ? `${c.eyeing.by.name} is eyeing ${teamName(s, c.eyeing.teamId)}…` : 'Picking a victim') : 'Grinch Steal';
      body = h`<div class="mirror__chips">${chip}</div><p class="mirror__big">${c.steal ? `${subject(teamName(s, c.steal.to), 'steals')} ${fmt(c.steal.amount)} from ${teamName(s, c.steal.from)}!` : c.gift ? `Heart grew three sizes: ${fmt(c.gift.amount)} to ${teamName(s, c.gift.toTeamId)}` : `${subject(act?.name || 'The team', 'picks')} a team that’s ahead`}</p>`;
      break;
    case 'doubledown':
      sub = 'Double Down splash';
      body = h`<div class="mirror__chips">${chip}</div><p class="mirror__big">Double Down! ${subject(act?.name || 'The team', 'spins')} again. Everything is ×2.</p>`;
      break;
    default:
      body = h`<div class="mirror__chips">${chip}</div>`;
  }
  if (s.phase === 'turnResult' && c.result) sub = `Turn result · ${sub}`;
  return { sub, body };
}

function syncMiniWheel(s) {
  const svg = document.getElementById('mini-wheel');
  if (!svg) { if (miniWheel) { miniWheel.destroy(); miniWheel = null; miniWheelKey = ''; } return; }
  const key = s.phase === 'spinning' && s.spin ? `spin:${s.spin.startedAt}` : `rest:${s.lastSegmentIndex}`;
  if (miniWheel && miniWheel.el === svg && miniWheelKey === key) return;
  if (miniWheel && miniWheel.el !== svg) { miniWheel.destroy(); miniWheel = null; }
  if (!miniWheel) miniWheel = createWheel(svg, s.segments, { label: 'The wheel on the TV' });
  miniWheelKey = key;
  if (s.phase === 'spinning' && s.spin) {
    miniWheel.spinTo(s.spin.segmentIndex, s.spin.durationMs, { startedAt: s.spin.startedAt, clockOffset: client.clockOffset }).catch?.(() => {});
  } else {
    miniWheel.restOn(s.lastSegmentIndex ?? 0);
    miniWheel.idle(true);
  }
}

/* ============================================================================ keys legend */

function keysHtml(s) {
  const acts = (s.host.coach.actions || []).filter((a) => a.shortcut && !a.disabled);
  const items = acts.map((a) => [a.shortcut, a.label.replace(/\s*[+−-][\d,]+$/, '')]);
  items.push(['U', 'Undo']);
  if (s.timer && !acts.some((a) => a.shortcut === 'T')) items.push(['T', 'Timer']);
  return h`${ic('keyboard', { size: 18 })}<span>Keyboard shortcuts work anywhere on this page:</span>${items.map(([k, l]) => h`<span class="keys__item"><kbd class="kbd">${k}</kbd>${l}</span>`)}`;
}

/* ============================================================================ lobby */

function savedGameHtml(s) {
  const sg = s.savedGame?.summary;
  if (!sg) return '';
  const teams = sg.teams || [];
  return h`<section class="card card--md saved" aria-labelledby="saved-h">
    ${art('sled', { size: 64 })}
    <div class="saved__body">
      <span class="stage-panel__eyebrow">Saved game found</span>
      <h2 id="saved-h" class="saved__title">Pick up where you left off?</h2>
      <p class="muted">Saved ${clockTime(sg.savedAt)} · Round ${sg.round || '?'} of ${sg.totalRounds || '?'} · ${plural(teams.length, 'team')} · ${plural(sg.players || 0, 'player')}</p>
      <ul class="chips" role="list">${teams.map((t) => h`<li class="chip-sm">${t.name} <b class="num">${fmt(t.score)}</b></li>`)}</ul>
    </div>
    <p class="saved__hint">${ic('arrow-up', { size: 18 })}Resume or start fresh on the note card above</p>
  </section>`;
}

function lobbySideHtml(s) {
  const H = s.host;
  const url = s.joinUrl || '';
  const addr = displayUrl(url);
  const st = s.settings;
  const cands = H.candidates || [];
  const turns = s.teams.length * st.rounds;
  const pin = String(H.pin || '');
  return h`
  <section class="gift-tag gift-tag--md gift-tag--twine join" aria-labelledby="join-h">
    <div class="join__head"><h2 id="join-h" class="panel-title">Players join here</h2>
      <button type="button" class="btn btn--secondary btn--sm" data-ui="copy" data-copy="${url}">${ic('external-link', { size: 16 })}Copy link</button></div>
    <div class="join__body">
      <img class="join__qr" src="${'/api/qr.svg?v=' + encodeURIComponent(url)}" alt="${'QR code for ' + addr}" width="128" height="128">
      <div class="join__text"><span class="label">Point a phone camera at the code. It opens the game, no app needed.</span>
        <span class="join__wifi">${ic('wifi', { size: 18 })}<span>Phones must use <b>this laptop’s Wi-Fi</b>, not the guest network.</span></span></div>
    </div>
    <div class="join__addrrow"><span class="label">No camera? Type this into the browser</span><span class="join__addr">${addr}</span></div>
    ${s.quip?.text ? h`<p class="join__quip">${art('bell', { size: 26 })}<span><small>On the TV right now</small>“${s.quip.text}”</span></p>` : ''}
    ${cands.length > 1 ? h`<div class="ip-switch"><span class="label">Phones can’t connect? Try another address</span>
      <div class="ip-switch__list" role="radiogroup" aria-label="Join address">${cands.map((c) => {
        const on = c.address === H.joinIp;
        return h`<button type="button" class="ip ${on ? 'is-on' : ''}" role="radio" aria-checked="${on ? 'true' : 'false'}" data-emit="host:setOption" data-payload="${json({ key: 'joinIp', value: c.address })}" data-key="${'ip:' + c.address}">${on ? ic('check', { size: 16, stroke: 3 }) : ic('wifi', { size: 16 })}<b>${c.address}</b><small>${c.iface}</small></button>`;
      })}</div></div>` : ''}
  </section>
  <section class="card card--md settings" aria-labelledby="set-h">
    <h2 id="set-h" class="panel-title">${art('ribbon', { size: 30 })}Game settings</h2>
    <div class="setting">
      <div class="setting__label"><b>Rounds</b><small>${st.autoRounds ? `Auto: best for ${plural(s.teams.length, 'team')}` : 'Set by you'} · 1 to 8</small></div>
      <div class="stepper" role="group" aria-label="Rounds">
        <button type="button" class="stepper__btn" data-emit="host:setRounds" data-payload="${json({ n: st.rounds - 1 })}" aria-label="One round fewer" ${st.rounds <= 1 ? raw('disabled') : ''} data-key="rounds-minus">${ic('minus', { size: 20, stroke: 3 })}</button>
        <span class="stepper__value" aria-live="polite">${st.rounds}</span>
        <button type="button" class="stepper__btn" data-emit="host:setRounds" data-payload="${json({ n: st.rounds + 1 })}" aria-label="One more round" ${st.rounds >= 8 ? raw('disabled') : ''} data-key="rounds-plus">${ic('plus', { size: 20, stroke: 3 })}</button>
      </div>
    </div>
    <div class="estimate">${art('cocoa', { size: 32 })}<span><b>≈ ${st.estimatedMinutes} min</b><small>${plural(turns, 'turn')}, then the Final Chaos finale. Plenty of time for cocoa.</small></span></div>
    ${toggleRow('Bonus question between rounds', st.roundBonusAuto ? 'Auto: on for 5+ teams' : 'Set by you', st.roundBonus, { key: 'roundBonus', value: !st.roundBonus })}
    ${toggleRow('Sound on the TV', 'Wheel ticks, buzzers, sleigh bells, sad trombones', st.sound, { key: 'sound', value: !st.sound })}
    <div class="setting">
      <div class="setting__label"><b>Sound check</b><small>Plays a jingle on the TV speakers</small></div>
      <button type="button" class="btn btn--secondary btn--sm" data-emit="host:soundTest" data-key="soundtest" data-needs-online>${ic('volume-2', { size: 18, stroke: 2.4 })}Play test sound</button>
    </div>
  </section>
  <section class="pin-ticket" aria-labelledby="pin-h">
    <div class="pin-ticket__stub"><span>Admit one</span><b>Host</b></div>
    <div class="pin-ticket__main">
      <h2 id="pin-h" class="pin-ticket__title">Second host device?</h2>
      <p class="pin-ticket__text">On your phone, open <b>${addr}/host</b> and type this PIN.</p>
      <div class="pin-digits" aria-label="${'Host PIN ' + pin.split('').join(' ')}">${pin.split('').map((d) => h`<span class="pin-digit" aria-hidden="true">${d}</span>`)}</div>
      <p class="pin-ticket__foot">${ic('eye-off', { size: 15 })}Only on host screens, never on the TV · ${H.connections.hosts > 1 ? `${H.connections.hosts} host screens signed in` : 'no second device yet'}</p>
    </div>
  </section>`;
}

function toggleRow(label, sub, on, payload) {
  return h`<div class="setting"><div class="setting__label"><b>${label}</b><small>${sub}</small></div>
    <button type="button" class="switch ${on ? 'is-on' : ''}" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" data-emit="host:setOption" data-payload="${json(payload)}" data-key="${'opt:' + payload.key}" data-needs-online><span class="switch__text">${on ? 'On' : 'Off'}</span><i class="switch__knob"></i></button></div>`;
}

function teamsHeadHtml(s) {
  return h`<div class="teams__title">${art('gift', { size: 34 })}<div><h2 id="teams-h" class="panel-title">Teams</h2><span class="muted teams__count">${s.teams.length} of 8 · listed in turn order</span></div></div>
    <button type="button" class="btn btn--secondary btn--sm" data-emit="host:shuffleTeams" data-key="shuffle" ${s.host.can.shuffleTeams ? '' : raw('disabled')} data-needs-online>${ic('shuffle', { size: 18 })}Shuffle order</button>`;
}

function ideasHtml(s) {
  const taken = new Set(s.teams.map((t) => t.name.toLowerCase()));
  const free = TEAM_IDEAS.filter((n) => !taken.has(n.toLowerCase()));
  if (!free.length || s.teams.length >= 8) return '';
  const start = ui.ideaSeed % free.length;
  const show = Array.from({ length: Math.min(4, free.length) }, (_, i) => free[(start + i) % free.length]);
  return h`<span class="ideas__lead">Need a name?</span>${show.map((n) => h`<button type="button" class="idea" data-ui="idea" data-name="${n}">${n}</button>`)}
    <button type="button" class="idea idea--more" data-ui="moreIdeas" aria-label="Show other name ideas">${ic('refresh-cw', { size: 14, stroke: 2.6 })}More</button>`;
}

function mascotButtons(s, selected, exceptTeamId, name) {
  const taken = new Set(s.teams.filter((t) => t.id !== exceptTeamId).map((t) => t.mascot));
  return MASCOTS.map((m) => {
    const isTaken = taken.has(m.id);
    const on = m.id === selected;
    return h`<button type="button" class="mascot-opt ${on ? 'is-on' : ''} ${isTaken ? 'is-taken' : ''}" style="--team-color:${m.color}" role="radio" aria-checked="${on ? 'true' : 'false'}" aria-label="${m.colorName + ' ' + m.noun.replace(/^an? /, '') + (isTaken ? ' (taken)' : '')}" data-ui="${name}" data-mascot="${m.id}" ${isTaken ? raw('disabled') : ''}>
      ${art(m.art, { size: 46 })}<span class="mascot-opt__name">${m.colorName}</span>${on ? h`<span class="mascot-opt__check">${ic('check', { size: 14, stroke: 3.4 })}</span>` : ''}</button>`;
  });
}

function mascotPickerHtml(s) {
  const taken = new Set(s.teams.map((t) => t.mascot));
  const free = MASCOTS.filter((m) => !taken.has(m.id));
  if (!ui.mascot || !free.some((m) => m.id === ui.mascot)) ui.mascot = free[0]?.id || null;
  return h`${mascotButtons(s, ui.mascot, null, 'pickMascot')}`;
}

function teamsListHtml(s) {
  const can = s.host.can;
  const unassigned = s.players.filter((p) => !p.teamId);
  const rows = s.teams.map((t, i) => {
    const players = s.players.filter((p) => p.teamId === t.id);
    const offline = players.filter((p) => !p.connected).length;
    return h`<li class="team-row ${players.length ? '' : 'is-empty'}" ${tstyle(t)}>
      <span class="team-row__num">${i + 1}</span>
      <span class="team-row__mascot">${mas(t, 52)}</span>
      <span class="team-row__id"><button type="button" class="team-row__name" data-ui="editTeam" data-team="${t.id}" data-key="${'edit:' + t.id}" title="Rename or change mascot"><span>${t.name}</span>${ic('pencil', { size: 14, stroke: 2.4 })}</button>
        <small>${players.length ? `${plural(players.length, 'elf', 'elves')}${offline ? ` · ${offline} offline` : ''}` : 'Needs elves'}</small></span>
      <span class="team-row__players">${players.length
        ? h`<ul class="player-list" role="list">${players.map((p) => h`<li><button type="button" class="player-chip pchip ${p.connected ? '' : 'is-offline'}" data-ui="player" data-player="${p.id}" data-key="${'player:' + p.id}" aria-label="${p.name + (p.connected ? '' : ' (offline)') + ': move or remove'}">${p.name}</button></li>`)}</ul>`
        : h`<span class="team-row__wait">Empty stocking. Waiting for someone to tap this team on their phone.</span>`}</span>
      <span class="team-row__tools">
        <button type="button" class="icon-btn" data-ui="moveTeam" data-team="${t.id}" data-dir="-1" aria-label="${'Move ' + t.name + ' up'}" ${i === 0 || !can.reorderTeams ? raw('disabled') : ''}>${ic('arrow-up', { size: 16, stroke: 2.8 })}</button>
        <button type="button" class="icon-btn" data-ui="moveTeam" data-team="${t.id}" data-dir="1" aria-label="${'Move ' + t.name + ' down'}" ${i === s.teams.length - 1 || !can.reorderTeams ? raw('disabled') : ''}>${ic('arrow-down', { size: 16, stroke: 2.8 })}</button>
        <button type="button" class="icon-btn icon-btn--danger" data-ui="removeTeam" data-team="${t.id}" aria-label="${'Remove ' + t.name}" ${can.removeTeam ? '' : raw('disabled')}>${ic('trash-2', { size: 17, stroke: 2.4 })}</button>
      </span>
    </li>`;
  });
  const room = 8 - s.teams.length;
  return h`
    ${s.teams.length ? h`<ol class="team-list" role="list">${rows}</ol>` : h`<p class="teams__empty">${art('sled', { size: 56 })}<span><b>No teams yet.</b> Even Santa needs a team. Add 2 to 8 above (4 to 6 plays best). Players then pick a team on their phone.</span></p>`}
    ${unassigned.length ? h`<div class="unassigned"><span class="label">Not on a team yet</span><ul class="player-list" role="list">${unassigned.map((p) => h`<li><button type="button" class="player-chip pchip ${p.connected ? '' : 'is-offline'}" data-ui="player" data-player="${p.id}">${p.name}</button></li>`)}</ul></div>` : ''}
    ${s.teams.length && room > 0 ? h`<p class="teams__room">${ic('users', { size: 18 })}Room for ${plural(room, 'more team')}. 4 to 6 plays best.</p>` : ''}`;
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
      ${art(m.tone === 'danger' ? 'snowman' : 'bell', { size: 64, className: 'confirm__art' })}
      <h2 class="modal__title">${m.title}</h2><p class="confirm__msg">${m.message}</p>
      <div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="cancelConfirm">Cancel <kbd class="kbd">Esc</kbd></button>
        <button type="button" class="btn ${m.tone === 'danger' ? 'btn--primary' : 'btn--holly'} btn--md" data-ui="okConfirm" data-autofocus>${m.okLabel}</button></div></div>`, { cls: 'modal--sm', label: m.title });
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
    const parts = sec.parts || [];
    const isWheel = parts.filter((p) => p.kind === 'em' && labels.has(p.text)).length >= 3;
    let body;
    if (isWheel) {
      const intro = parts[0]?.kind === 'say' && !labels.has(parts[0].text) ? parts[0].text : '';
      const items = [];
      parts.forEach((p, k) => { if (p.kind === 'em' && labels.has(p.text)) items.push([p.text, (parts[k + 1]?.text || '').replace(/^\s*—\s*/, '').trim()]); });
      body = h`${intro ? h`<p class="script__p">${intro.trim()}</p>` : ''}<ul class="script__wheel" role="list">${items.map(([l, d]) => { const g = segByLabel(l); return h`<li>${g ? slotChip(g, { size: 'sm' }) : h`<b>${l}</b>`}<span>${d}</span></li>`; })}</ul>`;
    } else {
      const segs = parts.map((p) => {
        if (p.kind === 'cue') return h`<em class="cue">[${p.text}]</em>`;
        if (p.kind === 'em' && p.text.trim() === sc0.joinAddress) return h`<span class="script__addr">${ic('smartphone', { size: 20 })}${p.text}</span>`;
        if (p.kind === 'em' && /let.s play/i.test(p.text)) return h`<span class="script__shout">${p.text}</span>`;
        if (p.kind === 'em') return h`<b>${p.text}</b>`;
        return h`${p.text}`;
      });
      body = h`<p class="script__p">${segs}</p>`;
    }
    const adlib = SCRIPT_ADLIBS[sec.title];
    return h`<section class="script__sec"><h3 class="script__h"><span class="script__n">Scene ${i + 1}</span>${sec.title}</h3>${body}${adlib ? h`<p class="script__adlib">${adlib}</p>` : ''}</section>`;
  };
  return modalShell(h`
    <div class="script">
      <div class="script__top">
        ${art('clapper', { size: 56 })}
        <div class="script__titles"><span class="script__kicker">Christmas Chaos · live from the North Pole · take 1</span><h2 class="script__title">${sc0.title}</h2></div>
        <span class="script__time"><b>About ${plural(sc0.minutes, 'minute')}</b><small>${sc0.words} words · no need to rush</small></span>
        <button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close">${ic('x', { size: 22 })}</button>
      </div>
      <div class="script__paper">
        <p class="script__legend">${ic('info', { size: 16 })}Read the words out loud. <em class="cue">[Cues like this]</em> are stage directions, just for you. The handwriting is the elves’ notes.</p>
        <div class="script__cols">${(sc0.sections || []).map(sectionHtml)}</div>
        <p class="script__end"><em class="cue">[End of script. Take a breath. You’ve got this.]</em></p>
      </div>
      <div class="script__foot">
        <p class="script__sum">${art('gift', { size: 30 })}<span>${sc0.summary}</span></p>
        <button type="button" class="btn btn--secondary btn--md" data-ui="closeModal">Close <kbd class="kbd">Esc</kbd></button>
        ${start ? h`<button type="button" class="btn btn--primary btn--md script__start" data-act="coach" data-id="start" ${start.disabled ? raw('aria-disabled="true"') : ''} data-autofocus title="${start.disabled ? start.reason || '' : ''}">${ic('play', { size: 20 })}Done: start the game</button>` : ''}
      </div>
    </div>`, { cls: 'modal--script', label: 'Opening script' });
}

function playerModal(s, m) {
  const p = playerOf(s, m.playerId);
  if (!p) return modalShell(h`<div class="modal__body"><p>That player has left the workshop.</p><div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="closeModal" data-autofocus>Close</button></div></div>`, { cls: 'modal--sm' });
  const cur = teamOf(s, p.teamId);
  return modalShell(h`<div class="modal__body">
    <div class="modal__head">${cur ? mas(cur, 52) : art('mitten', { size: 52 })}<div><h2 class="modal__title">${p.name}</h2><p class="muted">${p.connected ? 'Online' : 'Phone offline'} · ${cur ? cur.name : 'No team yet'}</p></div>
      <button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close">${ic('x', { size: 22 })}</button></div>
    <span class="label">Move to</span>
    <div class="pm__teams">${s.teams.map((t) => h`<button type="button" class="pm__team ${t.id === p.teamId ? 'is-on' : ''}" data-ui="movePlayer" data-player="${p.id}" data-team="${t.id}" ${t.id === p.teamId ? raw('aria-current="true" disabled') : ''} ${tstyle(t)}>${mas(t, 32)}<span>${t.name}</span>${t.id === p.teamId ? ic('check', { size: 18, stroke: 3 }) : ''}</button>`)}</div>
    <div class="modal__acts modal__acts--split">
      ${p.teamId ? h`<button type="button" class="btn btn--ghost btn--sm" data-ui="movePlayer" data-player="${p.id}" data-team="">${ic('user-x', { size: 18 })}Take off the team</button>` : raw('<span></span>')}
      <button type="button" class="btn btn--danger btn--sm" data-ui="kickPlayer" data-player="${p.id}">${ic('trash-2', { size: 18 })}Remove from game</button>
    </div></div>`, { cls: 'modal--sm', label: `${p.name}: move or remove` });
}

function teamModal(s, m) {
  const t = teamOf(s, m.teamId);
  if (!t) return modalShell(h`<div class="modal__body"><p>That team was removed.</p><div class="modal__acts"><button type="button" class="btn btn--secondary btn--md" data-ui="closeModal" data-autofocus>Close</button></div></div>`, { cls: 'modal--sm' });
  if (!m.mascot) m.mascot = t.mascot;
  const preview = { ...t, mascot: m.mascot };
  return modalShell(h`<form class="modal__body" data-form="team" data-team="${t.id}">
    <div class="modal__head">${mas(preview, 56)}<div><h2 class="modal__title">Edit team</h2><p class="muted">Rename any time, even mid-game.</p></div>
      <button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close">${ic('x', { size: 22 })}</button></div>
    <div class="field"><label class="label" for="edit-name">Team name</label><input class="input input--sm" id="edit-name" name="name" maxlength="24" value="${m.name ?? t.name}" data-autofocus></div>
    <fieldset class="add-team__mascots"><legend class="label">Mascot</legend><div class="mascot-picker" role="radiogroup">${mascotButtons(s, m.mascot, t.id, 'editMascot')}</div></fieldset>
    <div class="modal__acts modal__acts--split">
      ${s.host.can.removeTeam ? h`<button type="button" class="btn btn--danger btn--sm" data-ui="removeTeam" data-team="${t.id}">${ic('trash-2', { size: 18 })}Remove team</button>` : raw('<span></span>')}
      <button type="submit" class="btn btn--holly btn--md">${ic('check', { size: 18, stroke: 3 })}Save</button>
    </div></form>`, { cls: 'modal--sm', label: 'Edit team' });
}

function moreModal(s) {
  const H = s.host;
  const can = H.can;
  const inGame = s.phase !== 'lobby';
  const item = (label, sub, iconName, attrs, enabled = true, tone = '') => h`<button type="button" class="menu-item ${tone}" ${attrs} ${enabled ? '' : raw('disabled')}>${ic(iconName, { size: 20, stroke: 2.4 })}<span><b>${label}</b>${sub ? h`<small>${sub}</small>` : ''}</span></button>`;
  const e = (event, payload, confirm) => raw(`data-emit="${esc(event)}"${payload ? ` data-payload="${esc(json(payload))}"` : ''}${confirm ? ` data-confirm="${esc(confirm)}"` : ''}`);
  const st = s.settings;
  const segs = s.segments || [];
  return modalShell(h`
    <div class="modal__head">${art('mitten', { size: 44 })}<h2 class="modal__title">More tools</h2><button type="button" class="icon-btn" data-ui="closeModal" aria-label="Close" data-autofocus>${ic('x', { size: 22 })}</button></div>
    <div class="menu">
      ${inGame ? h`<div class="menu__group"><span class="label">This mini-game</span>
        ${item('Swap question', 'Draws an unused replacement', 'refresh-cw', e('host:swapQuestion'), can.swapQuestion)}
        ${item('Swap secret', 'New song or secret, same performer', 'refresh-cw', e('host:swapSecret'), can.swapSecret)}
        ${item('Re-roll performer', 'Somebody else, picked at random', 'dices', e('host:rerollPerformer'), can.rerollPerformer)}
        ${item('Skip this mini-game', 'Ends it with no more points', 'skip-forward', e('host:endChallenge', null, 'Skip this mini-game? Nobody scores.'), can.endChallenge, 'is-danger')}
        ${item('Skip to the next turn', 'Cancels whatever is happening', 'arrow-right', e('host:nextTurn', { turnId: s.turnId }, 'Skip to the next turn?'), can.nextTurn, 'is-danger')}
      </div>
      <div class="menu__group"><span class="label">Rounds</span>
        <div class="setting setting--menu"><div class="setting__label"><b>Rounds</b><small>Now in round ${s.round} of ${s.totalRounds}</small></div>
          <div class="stepper" role="group" aria-label="Rounds">
            <button type="button" class="stepper__btn" ${e('host:setRounds', { n: st.rounds - 1 })} aria-label="One round fewer" ${st.rounds <= Math.max(1, s.round) || !can.setRounds ? raw('disabled') : ''}>${ic('minus', { size: 20, stroke: 3 })}</button>
            <span class="stepper__value">${st.rounds}</span>
            <button type="button" class="stepper__btn" ${e('host:setRounds', { n: st.rounds + 1 })} aria-label="One more round" ${st.rounds >= 8 || !can.setRounds ? raw('disabled') : ''}>${ic('plus', { size: 20, stroke: 3 })}</button>
          </div></div>
        ${toggleRow('Bonus question between rounds', st.roundBonusAuto ? 'Auto: on for 5+ teams' : 'Set by you', st.roundBonus, { key: 'roundBonus', value: !st.roundBonus })}
      </div>` : ''}
      <div class="menu__group"><span class="label">Sound</span>
        ${toggleRow('Sound on the TV', 'Wheel ticks, buzzers, sleigh bells', st.sound, { key: 'sound', value: !st.sound })}
        <div class="setting"><div class="setting__label"><b>Alerts on this device</b><small>A buzz here when someone buzzes in</small></div>
          <button type="button" class="switch ${ui.alerts ? 'is-on' : ''}" role="switch" aria-checked="${ui.alerts ? 'true' : 'false'}" aria-label="Alerts on this device" data-ui="alerts"><span class="switch__text">${ui.alerts ? 'On' : 'Off'}</span><i class="switch__knob"></i></button></div>
        ${item('Play test sound on the TV', '', 'volume-2', e('host:soundTest'), true)}
      </div>
      ${inGame ? h`<div class="menu__group"><span class="label">Force the wheel (testing)</span>
        <div class="force">${segs.map((g) => h`<button type="button" class="force__seg" ${e('host:forceSegment', { index: g.index })} ${can.forceSegment ? '' : raw('disabled')} title="${'Land on ' + g.label}">${slotChip(g, { size: 'sm', text: `${g.index} · ${g.label}` })}</button>`)}</div>
        ${can.forceSegment ? '' : h`<small class="muted">Works while a team is waiting to spin.</small>`}</div>` : ''}
      <div class="menu__group"><span class="label">Second host device</span>
        <p class="menu__pin">PIN <b class="num">${H.pin || '----'}</b> · open <b>${displayUrl(s.joinUrl)}/host</b></p>
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
    if (pinKey.getAttribute('aria-disabled') === 'true' || pinKey.disabled) return;
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
    if (res?.ok && el.dataset.emit === 'host:soundTest') soundTestToast();
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
    case 'openEnvelope': ui.envOpen = true; render(); break;
    case 'sealEnvelope': ui.envOpen = false; render(); break;
    case 'step': {
      const i = Number(el.dataset.i);
      if (ui.stepsDone.has(i)) ui.stepsDone.delete(i); else ui.stepsDone.add(i);
      render();
      break;
    }
    case 'enterHost': leaveSignedIn(); break;
    case 'signOut': signOut(); break;
    case 'alerts': {
      ui.alerts = !ui.alerts;
      lsSet(ALERTS_STORE, ui.alerts ? '1' : '0');
      if (ui.alerts) { try { await sound.unlock(); sound.buzz(); } catch { /* no audio */ } }
      renderModal(false);
      break;
    }
    case 'copy': copyText(el.dataset.copy); break;
    case 'idea': {
      const input = $('#team-name');
      if (input) { input.value = el.dataset.name || ''; input.focus(); }
      break;
    }
    case 'moreIdeas': ui.ideaSeed += 4; render(); break;
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
      await send('host:kickPlayer', { playerId: el.dataset.player }, { confirm: `Remove ${p ? p.name : 'this player'} from the game? Their phone goes back to the join screen. (They can rejoin any time.)`, title: 'Remove player', okLabel: 'Remove', tone: 'danger' });
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
    if (!name) { toast('Type a team name first (or tap one of the ideas)', { tone: 'error' }); input?.focus(); return; }
    const res = await send('host:createTeam', { name, mascot: ui.mascot || undefined });
    if (res?.ok) {
      if (input) input.value = '';
      ui.mascot = null;
      ui.ideaSeed += 1;
      input?.focus();
      toast(h`<strong>${name}</strong> joined the workshop`, { tone: 'success', icon: 'circle-check' });
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
  if (!s.host.canUndo) { toast('Nothing to undo. Your record is spotless.', { tone: 'info', icon: 'undo-2' }); return; }
  const label = s.host.undoLabel;
  const res = await send('host:undo');
  if (res?.ok) {
    ui.undoJoke++;
    toast(h`<strong>Undone:</strong> ${label || 'last change'}. ${pick(UNDO_JOKES, ui.undoJoke)}`, { tone: 'success', icon: 'undo-2', duration: 4200 });
  }
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
  if (key === 'Enter' && tgt && tgt !== document.body && tgt.closest?.('button, a, [role=button], summary')) return;
  if (key === ' ') return;
  const fn = shortcuts.get(key);
  if (fn) { e.preventDefault(); fn(); }
});

/* ============================================================================ fx & ticking */

function markLive(text, ms = 2600, mood = '') {
  ui.liveUntil = Date.now() + ms;
  ui.liveText = text;
  ui.liveMood = mood;
  scheduleRender();
  setTimeout(scheduleRender, ms + 60);
}

client.onFx((type, p) => {
  const s = client.state;
  if (!s?.host) return;
  if (type === 'points' && p?.teamId) {
    ui.bump[p.teamId] = Date.now() + 900;
    setTimeout(scheduleRender, 950);
    scheduleRender();
    requestAnimationFrame(() => {
      const m = document.querySelector(`.score-row[data-team="${p.teamId}"] .score-row__mascot`);
      if (m && p.delta > 0) fx.bounce(m); else if (m && p.delta < 0) fx.droop(m);
    });
  }
  if (type === 'buzz' && p?.name) {
    toast(h`<strong>${p.name}</strong> (${teamName(s, p.teamId)}) buzzed first!`, { icon: 'bell-ring' });
    if (ui.alerts) sound.buzz();
  }
  if (type === 'timerWarn' && ui.alerts) sound.beep();
  if (type === 'timerEnd') toast('Time’s up! Cue the sad trombone.', { tone: 'info', icon: 'timer' });
  if (type === 'react' && p?.mood) markLive(LIVE_MOODS[p.mood] || 'Big moment on the TV', 2600, p.mood);
  else if (LIVE_FX[type]) markLive(LIVE_FX[type], type === 'podium' || type === 'final' ? 3200 : 2600);
  if (lights) {
    if (type === 'land') lights.flash(3);
    if (type === 'correct' && !p?.small) lights.blink('#1F9D57', 3);
  }
});

function tick() {
  const s = client.state;
  if (mode === 'login') {
    if (login.retryUntil && login.retryUntil <= Date.now()) { login.retryUntil = 0; login.error = ''; render(); return; }
    if (login.retryUntil) { const hint = document.querySelector('[data-login-hint]'); if (hint) hint.textContent = `The booth reopens in ${Math.ceil((login.retryUntil - Date.now()) / 1000)} s`; }
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
  if (mode === 'game' || mode === 'lobby') {
    const L = liveState(s);
    if (`${L.on}|${L.text}` !== ui.liveShown) scheduleRender();
  }
}
setInterval(tick, 250);

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
      login.error = 'The saved PIN expired (the game restarted). Type the new one from the laptop.';
    } else if (res.pinError === 'too-many-tries') {
      login.error = 'Whoa there, Rudolph. Too many guesses. Wait a minute, then try again.';
    }
  }
  scheduleRender();
});
client.onState(() => scheduleRender());
client.onConnection((on) => { if (!on) scheduleRender(); });

let resizeTimer = 0;
globalThis.addEventListener?.('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const box = document.getElementById('r-garland');
    if (!box || !lights) return;
    const want = isPhone() ? 'phone' : 'laptop';
    if (lights.__size !== want) {
      lights.destroy();
      try { lights = garland(box, { size: isPhone() ? 'phone' : 'host', seed: 1225 }); lights.__size = want; } catch { lights = null; }
    }
  }, 200);
});

// A tiny read-only hook for automated UI tests.
globalThis.__host = { get state() { return client.state; }, get mode() { return mode; }, ui };
