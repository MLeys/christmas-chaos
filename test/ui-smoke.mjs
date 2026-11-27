// Christmas Chaos — full UI smoke test (npm run test:ui)
//
// Starts the real server on a free port (temp CC_SAVE_DIR), then in ONE headless Edge drives a complete game through
// the real pages only: the host (/host, auto-host on loopback, 1440×900), the TV (/tv, 1920×1080) and 4 phones
// (390×844) on 3 teams. Phones type names, tap teams, tap the peppermint, presents, ornaments, votes, rival / Grinch
// targets, type answers and wagers; the host clicks the coach's buttons (the More menu's "Force the wheel" makes sure
// every mini-game shows up). Then a quick second game ("Play again") with the TV at 1280×720 and phones at 360×740.
//
// Every new stage of every screen is screenshotted into test/screens/ (gitignored). The run fails on any console error
// or page error, horizontal overflow on a phone, scrollable overflow on the TV, a stuck stage (no progress for 60 s),
// a sound / sight gag that never fired, or a mini-game type that never came up.
//
//   npm run test:ui                 # headless
//   UI_HEADED=1 npm run test:ui     # watch it (slow-mo off)
//   UI_QUICK=0 npm run test:ui      # skip the 720p / 360 px pass

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startServer } = require(path.join(ROOT, 'server.js'));
const { publicView } = require(path.join(ROOT, 'src', 'views.js'));

const SHOTS = path.join(ROOT, 'test', 'screens');
const STUCK_MS = 60_000;
const HEADED = process.env.UI_HEADED === '1';
const QUICK = process.env.UI_QUICK !== '0';
const T0 = Date.now();

/* ------------------------------------------------------------------ cast */
const TEAMS = [
  { name: 'Team Rudolph', mascot: 'deer' },
  { name: 'The Grinches', mascot: 'tree' },        // plural names: the copy must say "The Grinches are…"
  { name: 'Jingle Bell Rockers', mascot: 'bell' },
];
const PHONES = [
  { name: 'Aunt Linda', team: 0 },
  { name: 'Max', team: 0 },
  { name: 'Priya', team: 1 },
  { name: 'Sam', team: 2 },
];
// Wheel slots (src/game.js SEGMENTS)
const SEG = { christmas: 0, dare: 1, pop: 2, hotseat: 3, movies: 4, sound: 5, grinch: 6, showdown: 7, dare2: 8, rapid: 9, allplay: 10, double: 11 };
// The order the host forces the wheel in the main game (turn 1 is a real spin from a phone; Double Down re-spins into a dare).
const MAIN_PLAN = [SEG.double, SEG.dare, SEG.sound, SEG.showdown, SEG.hotseat, SEG.rapid, SEG.allplay, SEG.movies, SEG.pop, SEG.christmas, SEG.grinch];
const QUICK_PLAN = [SEG.showdown, SEG.dare, SEG.allplay];
const ALL_TYPES = ['trivia', 'dare', 'hotseat', 'sounditout', 'grinch', 'showdown', 'rapidlist', 'allplay', 'doubledown'];

/* ------------------------------------------------------------------ tiny utils */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = () => ((Date.now() - T0) / 1000).toFixed(0).padStart(4, ' ');
const log = (...a) => console.log(`[${secs()}s]`, ...a);
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 90);
const problems = [];
function fail(msg) {
  problems.push(msg);
  console.error(`  ✖ ${msg}`);
}

/* ------------------------------------------------------------------ server */
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ui-'));
process.env.CC_SAVE_DIR = saveDir;
const srv = await startServer({ port: 0, quiet: true, saveDir, env: { ...process.env, CC_SAVE_DIR: saveDir } });
const BASE = `http://127.0.0.1:${srv.port}`;
const G = srv.game;
const pv = () => publicView(G);
log(`server on ${BASE} (saves in ${saveDir})`);

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

/* ------------------------------------------------------------------ browser */
const browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });

// Counts every sound node and sight gag in the page (test-only instrumentation, injected before the app loads).
const INSTRUMENT = () => {
  const cc = (window.__cc = { osc: 0, buf: 0, sprites: {}, classes: {} });
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const o = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function (...a) { cc.osc++; return o.apply(this, a); };
    const b = AC.prototype.createBufferSource;
    AC.prototype.createBufferSource = function (...a) { cc.buf++; return b.apply(this, a); };
  }
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  new MutationObserver((list) => {
    for (const r of list) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || !n.classList.contains('fx-sprite')) continue;
          const img = n.querySelector('img');
          const art = img ? (img.getAttribute('src') || '').replace(/^.*\/|\.png$/g, '') : '';
          bump(cc.sprites, [...n.classList].filter((c) => c !== 'fx-sprite').join('.') || `art:${art}`);
        }
      } else if (r.type === 'attributes' && r.target.classList) {
        for (const c of r.target.classList) if (/^fx-(bounce|droop|wobble|shake|melt)$/.test(c)) bump(cc.classes, c);
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
};

const pages = []; // {name, kind:'host'|'tv'|'phone', page, ...}
async function open(name, kind, url, viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(kind === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10_000); // a missing button fails fast instead of hanging the run
  await page.addInitScript(INSTRUMENT);
  const P = { name, kind, page, ctx, ...extra };
  page.on('console', (m) => {
    if (m.type() === 'error') fail(`${name} console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => fail(`${name} page error: ${e.message}`));
  page.on('requestfailed', (r) => {
    // an image removed before it finished loading is aborted, not broken
    const why = r.failure()?.errorText || '';
    if (!/socket\.io/.test(r.url()) && !/ERR_ABORTED/.test(why)) fail(`${name} request failed: ${r.url()} ${why}`);
  });
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  pages.push(P);
  return P;
}

/* ------------------------------------------------------------------ screenshots + layout checks */
let shotNo = 0;
let prefix = '';
const seenKeys = new Set();
const SETTLE = 650; // a new screen gets its screenshot once it has been on screen this long (entrance animations)
const pending = new Map(); // page name -> {key, since}

/** The server-side moment, so a screenshot is taken once per stage (not per state push). */
function momentKey(v = pv()) {
  const c = v.challenge;
  const parts = [v.phase];
  if (c) {
    parts.push(c.type, c.stage);
    if (c.buzz) parts.push(c.buzz.winner ? 'buzzed' : c.buzz.open ? 'open' : c.buzz.armingUntil ? 'arming' : 'closed');
    if (c.vote) parts.push(c.vote.open ? 'vote-open' : 'vote-closed');
    if (c.result) parts.push(`res-${c.result.kind}`);
    if (c.type === 'rapidlist' && c.list) parts.push(c.list.count ? 'ticked' : 'none');
    if (c.type === 'hotseat' && c.hotseat) parts.push(c.hotseat.question ? 'q' : 'noq', c.hotseat.results.length ? 'marked' : 'unmarked');
    if (c.type === 'showdown' && c.rival) parts.push('rival');
    if (c.type === 'grinch') parts.push(c.steal ? 'stolen' : c.gift ? 'gift' : 'picking');
  }
  if (v.timer) parts.push(v.timer.started ? (v.timer.running ? 'timer-run' : v.timer.ended ? 'timer-end' : 'timer-pause') : 'timer-ready');
  if (v.final) parts.push(`rev${(v.final.revealed || []).length}`, v.final.done ? 'done' : '', (v.final.revealed || []).some((r) => r.judged) ? 'judged' : '');
  return parts.filter(Boolean).join('.');
}

async function pageInfo(P) {
  return P.page.evaluate(() => {
    const d = document.documentElement;
    const se = document.scrollingElement || d;
    return {
      screen: document.body?.dataset.screen || '',
      stageKey: document.querySelector('.award-stage')?.dataset.key || '',
      w: innerWidth, h: innerHeight, sw: se.scrollWidth, sh: se.scrollHeight,
      hero: document.querySelector('.hero [data-act="coach"]')?.dataset.id || '',
      modal: !!document.querySelector('.modal'),
    };
  });
}

/**
 * Screenshot every page whose (screen, moment) pair is new, once it has settled; check overflow while we are there.
 * now: shoot immediately (explicit moments: a confirm dialog, the secret being held…). force: even if seen before.
 */
async function capture({ force = false, now = false, tag = '' } = {}) {
  const mk = momentKey();
  await Promise.all(pages.map(async (P) => {
    if (P.closed) return;
    let info;
    try {
      info = await pageInfo(P);
    } catch {
      return; // mid-navigation
    }
    const role = P.kind === 'phone' ? (P.teamId && P.teamId === pv().activeTeamId ? 'up' : 'watch') : '';
    // phones: one screenshot per (screen, moment, up/watch) across all phones; host + TV: one per (screen, moment)
    const key = `${prefix}|${P.kind === 'phone' ? 'phone' : P.name}|${info.screen}|${mk}|${role}|${info.stageKey}|${info.modal ? 'modal' : ''}${tag}`;
    if (!force && seenKeys.has(key)) return;
    if (!force && !now) {
      const pd = pending.get(P.name);
      if (!pd || pd.key !== key) {
        pending.set(P.name, { key, since: Date.now() });
        return;
      }
      if (Date.now() - pd.since < SETTLE) return;
    }
    seenKeys.add(key);
    checkLayout(P, info, mk);
    const file = `${String(++shotNo).padStart(3, '0')}-${prefix}${P.name}-${slug(info.screen || 'page')}-${slug(mk)}${role ? '-' + role : ''}${info.stageKey ? '-' + slug(info.stageKey) : ''}${tag ? '-' + slug(tag) : ''}.png`;
    try {
      await P.page.screenshot({ path: path.join(SHOTS, file), animations: 'allow' });
    } catch (e) {
      fail(`${P.name}: screenshot failed (${e.message})`);
    }
  }));
}

function checkLayout(P, info, mk) {
  if (P.kind === 'phone' && info.sw > info.w + 1) fail(`${P.name} horizontal overflow on "${info.screen}" (${mk}): scrollWidth ${info.sw} > ${info.w}`);
  if (P.kind === 'tv' && (info.sw > info.w + 1 || info.sh > info.h + 1)) fail(`${P.name} overflows the screen on "${info.screen}" (${mk}): ${info.sw}×${info.sh} in ${info.w}×${info.h}`);
}

/* ------------------------------------------------------------------ cross-page sync (no stale screens) */
// What every page must show once a phase has settled (phones by role: the team that is up vs the others).
const PHONE_FOR = {
  lobby: () => ['lobby'],
  turnIntro: (up) => (up ? ['spin'] : ['watch']),
  finalIntro: () => ['finalintro'],
  finalWager: () => ['wager'],
  finalAnswer: () => ['answer'],
  finalReveal: () => ['freveal'],
  podium: () => ['podium'],
};
const TV_FOR = {
  lobby: ['lobby'], turnIntro: ['turn-intro'], spinning: ['spinning'], roundBreak: ['round-break', 'bonus', 'bonus-marking', 'bonus-reveal'],
  finalIntro: ['final-intro'], finalWager: ['final-wager'], finalAnswer: ['final-answer'], finalReveal: ['final-reveal'], podium: ['podium'],
};
const synced = new Set();
async function checkSync() {
  const v = pv();
  const key = `${prefix}|${v.turnId}|${v.phase}|${v.challenge?.id || ''}`;
  if (stableFor() < 2500 || synced.has(key)) return;
  synced.add(key);
  const want = PHONE_FOR[v.phase];
  if (want) {
    for (const P of phones()) {
      const scr = await phoneScreen(P);
      const ok = want(P.teamId === v.activeTeamId);
      if (!ok.includes(scr)) fail(`stale phone: ${P.name} shows "${scr}" during ${v.phase} (expected ${ok.join(' / ')})`);
    }
  }
  const tvWant = TV_FOR[v.phase];
  const tvScr = await phoneScreen(tv());
  if (tvWant && !tvWant.includes(tvScr)) fail(`stale TV: shows "${tvScr}" during ${v.phase} (expected ${tvWant.join(' / ')})`);
}

/* ------------------------------------------------------------------ progress / stuck detection */
let lastSig = '';
let lastProgress = Date.now();
function signature(v = pv()) {
  const c = v.challenge;
  return JSON.stringify([
    v.phase, v.turnId, v.round, v.teams.map((t) => t.score), v.spin && v.spin.startedAt,
    c && [c.id, c.stage, c.buzz, c.vote && [c.vote.nailed, c.vote.good, c.vote.open], c.result && c.result.kind, c.list && c.list.count, c.hotseat && c.hotseat.results.length, c.submissions && c.submissions.filter((s) => s.answered).length, c.rival, c.steal, c.gift],
    v.final && [v.final.wagers.filter((w) => w.locked).length, v.final.submissions.filter((s) => s.answered).length, v.final.revealed.length, v.final.revealed.filter((r) => r.judged).length, v.final.done],
    v.timer && [v.timer.started, v.timer.running, v.timer.ended],
  ]);
}
function watchProgress() {
  const s = signature();
  if (s !== lastSig) {
    lastSig = s;
    lastProgress = Date.now();
    return;
  }
  if (Date.now() - lastProgress > STUCK_MS) throw new Error(`stuck: no progress for ${STUCK_MS / 1000} s in ${momentKey()}\n${s}`);
}
/** How long the game has been in the current state (the host waits a beat so every screen renders + gets its shot). */
const stableFor = () => Date.now() - lastProgress;

/* ------------------------------------------------------------------ page helpers */
const host = () => pages.find((p) => p.kind === 'host');
const tv = () => pages.find((p) => p.kind === 'tv');
const phones = () => pages.filter((p) => p.kind === 'phone');
const teamIdByName = (n) => G.state.teams.find((t) => t.name === n)?.id;

async function until(fn, what, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (${momentKey()})`);
    await sleep(120);
  }
}

/** Click a host coach button by id when it is there and live. Returns true if clicked. */
async function hostAct(id) {
  const H = host().page;
  const btn = H.locator(`[data-act="coach"][data-id="${id}"]:not([aria-disabled="true"])`).first();
  if (!(await btn.count())) return false;
  await btn.click({ timeout: 4000 });
  await confirmIfAsked();
  log(`host: ${id}`);
  return true;
}
async function hostEmit(selector, label) {
  const H = host().page;
  const btn = H.locator(selector).first();
  if (!(await btn.count()) || (await btn.isDisabled())) return false;
  await btn.click({ timeout: 4000 });
  await confirmIfAsked();
  log(`host: ${label}`);
  return true;
}
async function confirmIfAsked() {
  const H = host().page;
  const ok = H.locator('[data-ui="okConfirm"]');
  try {
    await ok.waitFor({ state: 'visible', timeout: 450 });
  } catch {
    return;
  }
  await H.waitForTimeout(250); // the dialog fades in
  await capture({ now: true, tag: 'confirm' });
  await ok.click();
}
async function coachIds() {
  return host().page.evaluate(() => [...document.querySelectorAll('[data-act="coach"]')].map((b) => ({ id: b.dataset.id, off: b.getAttribute('aria-disabled') === 'true', hero: !!b.closest('.hero') })));
}

/** The lobby's rounds stepper: click − until the setting is n (waiting for the host page to show each new value). */
async function setRounds(n) {
  const H = host().page;
  const shown = async () => Number((await H.locator('.stepper__value').first().textContent()) || 0);
  while (G.state.settings.rounds > n) {
    const r = G.state.settings.rounds;
    await until(async () => (await shown()) === r, 'the stepper to show the rounds');
    await H.locator('[data-key="rounds-minus"]').click();
    await until(() => G.state.settings.rounds < r, 'rounds to drop');
  }
  await until(async () => (await shown()) === n, 'the stepper to show the rounds');
}

/** Force the next wheel slot through the host's More menu ("Force the wheel (testing)"). */
async function forceWheel(index) {
  const H = host().page;
  await H.locator('[data-ui="more"]').first().click();
  const seg = H.locator(`.force__seg[data-payload='{"index":${index}}']`);
  await seg.waitFor({ state: 'visible', timeout: 4000 });
  await capture({ now: true, tag: 'more-menu' });
  if (await seg.isDisabled()) {
    await H.locator('.modal [data-ui="closeModal"]').first().click();
    return false;
  }
  await seg.click();
  await until(async () => !(await H.locator('.modal--menu').count()), 'the More menu to close', 5000);
  log(`host: forced the wheel to slot ${index} (${G.segments[index].label})`);
  return true;
}

/* ------------------------------------------------------------------ phone actions */
const once = new Set();
function first(key) {
  if (once.has(key)) return false;
  once.add(key);
  return true;
}
async function tap(P, selector) {
  const el = P.page.locator(selector).first();
  if (!(await el.count())) return false;
  // the peppermint breathes and the ornament sways (never "stable"): tap where they are, like a thumb would
  await el.waitFor({ state: 'visible', timeout: 4000 });
  await el.tap({ timeout: 4000, force: true });
  return true;
}
async function phoneScreen(P) {
  try {
    return await P.page.evaluate(() => document.body.dataset.screen || '');
  } catch {
    return '';
  }
}

const plan = { list: [], natural: 0, trivia: 0, stealsJudged: 0, dares: 0, buzzWanted: new Map() };
const PHONE_DWELL = 700; // phones act once their new screen has been up (and screenshotted)
let forcing = false;

/** Each phone does what its screen offers. Returns true if any phone acted. */
async function phonesStep() {
  const v = pv();
  const S = G.state;
  const c = v.challenge;
  const k = (P, what) => `${prefix}|${v.turnId}|${v.phase}|${c ? c.id + c.stage : ''}|${v.final ? v.final.revealed.length : ''}|${P ? P.name : ''}|${what}`;
  let acted = false;
  if (stableFor() < PHONE_DWELL) return false;
  // players watch the TV: while it still shows "the wheel landed on…" nobody taps yet (so every TV stage gets its shot)
  if ((await phoneScreen(tv())) === 'landed' && stableFor() < 6000) return false;
  for (const P of phones()) {
    const scr = await phoneScreen(P);
    const mine = P.teamId === v.activeTeamId;
    switch (scr) {
      case 'spin': {
        if (!mine || forcing || (plan.list.length && plan.natural <= 0) || !(await P.page.locator('[data-spin][aria-disabled="false"]').count())) break;
        if (!first(k(null, 'spin'))) break;
        await tap(P, '[data-spin]');
        plan.natural--;
        log(`${P.name}: spin`);
        acted = true;
        break;
      }
      case 'difficulty': {
        if (!mine || !first(k(null, 'pick'))) break;
        const level = ['easy', 'medium', 'hard'][plan.trivia % 3];
        await tap(P, `[data-level="${level}"]`);
        log(`${P.name}: picked ${level}`);
        acted = true;
        break;
      }
      case 'buzzer': {
        const want = plan.buzzWanted.get(`${c?.id}:${(c?.buzz?.lockedTeamIds || []).length}`);
        if (!want || !c?.buzz?.open || c.buzz.winner) break;
        if (!(await P.page.locator('[data-buzz]').count())) break;
        if (!first(k(null, `buzz${(c.buzz.lockedTeamIds || []).length}`))) break;
        await capture({ now: true, tag: 'armed' });
        await tap(P, '[data-buzz]');
        log(`${P.name}: buzz`);
        acted = true;
        break;
      }
      case 'secret': {
        if (!first(k(P, 'peek'))) break;
        const card = P.page.locator('[data-secret-card]').first();
        await card.dispatchEvent('pointerdown', { button: 0, pointerId: 7, isPrimary: true });
        await until(() => P.page.locator('[data-secret-card].is-revealed').count(), 'the secret to show');
        await P.page.waitForTimeout(450); // the wrapping paper cross-fades away
        await capture({ now: true, tag: 'peek' });
        await card.dispatchEvent('pointerup', { button: 0, pointerId: 7, isPrimary: true });
        log(`${P.name}: peeked at the secret`);
        acted = true;
        break;
      }
      case 'vote': {
        if (!(await P.page.locator('[data-vote]').count()) || !first(k(P, 'vote'))) break;
        const choice = P.name === 'Sam' ? 'good' : 'nailed';
        await tap(P, `[data-vote="${choice}"]`);
        log(`${P.name}: voted ${choice}`);
        acted = true;
        break;
      }
      case 'picker': {
        if (!mine || !(await P.page.locator('[data-target]:not([aria-disabled="true"])').count())) break;
        if (!first(k(null, 'target'))) break;
        await tap(P, '[data-target]');
        await until(() => P.page.locator('[data-confirm][aria-disabled="false"]').count(), 'the confirm button');
        await capture({ now: true, tag: 'target-picked' });
        await tap(P, '[data-confirm]');
        log(`${P.name}: picked a target`);
        acted = true;
        break;
      }
      case 'answer': {
        if (!(await P.page.locator('#answer-input').count())) break;
        if (!first(k({ name: P.teamId }, 'answer'))) break; // one phone per team answers
        const ti = TEAMS.findIndex((t) => teamIdByName(t.name) === P.teamId);
        const right = v.phase === 'finalAnswer' ? S.final?.q?.answer : S.challenge?.q?.answer;
        const text = ti === 1 ? 'no idea, sorry' : right || 'Rudolph';
        await P.page.locator('#answer-input').fill(text);
        await capture({ now: true, tag: 'typed' });
        await tap(P, '[data-answer-form] button[type="submit"]');
        log(`${P.name}: answered "${text}"`);
        acted = true;
        break;
      }
      case 'wager': {
        if (!(await P.page.locator('[data-w-lock][aria-disabled="false"]').count())) break;
        if (!first(k({ name: P.teamId }, 'wager'))) break;
        const ti = TEAMS.findIndex((t) => teamIdByName(t.name) === P.teamId);
        await tap(P, ['[data-w-set]:last-child', '.qchip:nth-child(2)', '.qchip:first-child'][ti] || '.qchip');
        await tap(P, '[data-w-lock]');
        log(`${P.name}: locked a wager`);
        acted = true;
        break;
      }
      default:
        break;
    }
  }
  return acted;
}

/* ------------------------------------------------------------------ the host's brain */
const DWELL = 1400; // a human host waits a beat; every page renders and gets its screenshot first

async function hostStep() {
  const v = pv();
  const S = G.state;
  const c = v.challenge;
  if (stableFor() < DWELL) return false;
  // like a real host, wait while the TV still plays "it landed on…" / "Priya picked Easy!" (a few seconds at most)
  if (['landed', 'difficulty-picked'].includes(await phoneScreen(tv())) && stableFor() < 6000) return false;
  // …and give a brand-new TV screen a moment on air (and its screenshot) before changing it
  if (Date.now() - (pending.get('tv')?.since || 0) < SETTLE + 400 && stableFor() < 6000) return false;
  const ids = await coachIds();
  const has = (id) => ids.some((a) => a.id === id && !a.off);
  const hero = ids.find((a) => a.hero && !a.off)?.id;

  // a team is waiting to spin: force the next planned slot (Double Down's re-spin too)
  const waitingToSpin = v.phase === 'turnIntro' || (v.phase === 'challenge' && c?.type === 'doubledown');
  if (waitingToSpin) {
    if (plan.list.length && plan.natural <= 0) {
      forcing = true;
      try {
        const idx = plan.list[0];
        if (await forceWheel(idx)) plan.list.shift();
      } finally {
        forcing = false;
      }
      return true;
    }
    // natural spin: the phone does it; if nobody has for a while, the host spins for them
    if (stableFor() > 8000 && has('spinFor')) return hostAct('spinFor');
    return false;
  }
  if (v.phase === 'spinning') return false;

  // All Play (a challenge) and the round bonus (in the cocoa break): phones type, then the host locks the answers
  if (c && (c.type === 'allplay' || c.type === 'bonus') && c.stage === 'answering') {
    const answered = (c.submissions || []).filter((x) => x.answered).length;
    if (answered < v.teams.length && stableFor() < 6000) return false; // phones are typing
    return hostAct(has('lock') ? 'lock' : hero);
  }
  if (v.phase === 'challenge' && c) {
    switch (c.type) {
      case 'trivia': {
        if (c.stage === 'pickDifficulty') return false; // a phone picks
        if (c.stage === 'question') {
          const n = plan.trivia++;
          // 1st trivia: wrong → a steal someone wins; 3rd: wrong → a wrong steal; others: correct
          if (n % 3 !== 1) {
            plan.buzzWanted.set(`${c.id}:0`, true);
            plan.buzzWanted.set(`${c.id}:1`, n % 3 === 2);
            return hostAct('wrong');
          }
          return hostAct('correct');
        }
        if (c.stage === 'steal') return stealStep(c, has);
        break;
      }
      case 'sounditout':
        if (c.stage === 'perform') {
          if (!S.timer?.started) return hostAct('timerStart');
          plan.buzzWanted.set(`${c.id}:0`, false); // nobody buzzes: the steal times out ("nobody buzzed")
          return hostAct('wrong');
        }
        if (c.stage === 'steal') return stealStep(c, has);
        break;
      case 'dare':
        if (c.stage === 'perform') {
          if (!S.timer?.started && has('timerStart')) return hostAct('timerStart');
          if (plan.dares++ % 2 === 0 && has('vote')) return hostAct('vote');
          return hostAct('nailed');
        }
        if (c.stage === 'vote') return stableFor() > 16_000 ? hostAct('closeVote') : false; // phones vote; it closes itself
        break;
      case 'showdown':
        if (c.stage === 'pickRival') return false; // a phone picks
        if (c.stage === 'battle') return !S.timer?.started && has('timerStart') ? hostAct('timerStart') : hostAct('winActive');
        break;
      case 'rapidlist':
        if (c.stage === 'list') {
          if (!S.timer?.started && has('timerStart')) return hostAct('timerStart');
          if ((c.list?.count || 0) < 3) return hostEmit('.check:not(.is-on)', 'ticked a list answer');
          return hostAct(has('award') ? 'award' : hero);
        }
        break;
      case 'hotseat':
        if (c.stage === 'hotseat') {
          if (!S.timer?.started && has('timerStart')) return hostAct('timerStart');
          const mark = ['correct', 'correct', 'wrong', 'pass', 'correct', 'wrong'][c.hotseat?.results?.length || 0] || 'correct';
          return hostAct(has(mark) ? mark : hero);
        }
        break;
      case 'grinch':
        if (c.stage === 'pickTarget') return stableFor() > 8000 ? hostAct(hero) : false; // a phone picks
        break;
      default:
        break;
    }
  }
  if (v.phase === 'finalWager') {
    const locked = v.final.wagers.filter((w) => w.locked).length;
    if (locked < v.teams.length && stableFor() < 6000) return false;
  }
  if (v.phase === 'finalAnswer') {
    const answered = v.final.submissions.filter((x) => x.answered).length;
    if (answered < v.teams.length && stableFor() < 6000) return false;
  }
  if (v.phase === 'podium') return false;
  // everything else: the coach's big button
  if (hero) return hostAct(hero);
  return false;
}

async function stealStep(c, has) {
  const b = c.buzz;
  if (!b) return false;
  if (b.winner) {
    const n = plan.stealsJudged++;
    return hostAct(n % 2 === 0 ? 'correct' : 'wrong');
  }
  const key = `${c.id}:${(b.lockedTeamIds || []).length}`;
  if (!b.open) {
    if (b.armingUntil && b.armingUntil > Date.now() - 500) return false; // 3-2-1
    // closed after a wrong steal: reveal the answer
    return hostAct(has('reveal') ? 'reveal' : 'reopen');
  }
  if (plan.buzzWanted.get(key)) return stableFor() > 8000 ? hostAct('reveal') : false; // a phone buzzes
  return false; // nobody buzzes: wait for the steal timer
}

/* ------------------------------------------------------------------ one game */
async function playGame(name, forcePlan, { maxMs, natural = 0 }) {
  plan.list = forcePlan.slice();
  plan.natural = natural;
  const types = new Set();
  const end = Date.now() + maxMs;
  lastProgress = Date.now();
  lastSig = '';
  for (;;) {
    if (Date.now() > end) throw new Error(`${name}: did not finish within ${maxMs / 1000} s (${momentKey()})`);
    watchProgress();
    const v = pv();
    if (v.challenge) types.add(v.challenge.type);
    await capture();
    await checkSync();
    if (v.phase === 'podium') break;
    if (await phonesStep()) continue;
    if (await hostStep()) continue;
    await sleep(150);
  }
  log(`${name}: podium reached; mini-games played: ${[...types].join(', ')}`);
  return types;
}

/** Wait for the TV's awards ceremony to finish, screenshotting every award. */
async function ceremony() {
  const n = pv().podium?.awards?.length || 0;
  log(`podium: ${n} award(s): ${(pv().podium?.awards || []).map((a) => `${a.title} → ${a.name}`).join(' | ')}`);
  const awardsOn = (P) => P.page.locator('.award-tag, .other-awards li').count();
  // the phones keep every award a secret until the TV's drumroll reveals it
  if (n) {
    const early = await Promise.all(phones().map(awardsOn));
    if (early.some((x) => x > 0)) fail(`a phone showed an award before the TV ceremony revealed it (${early.join(', ')})`);
  }
  const end = Date.now() + 20_000 + n * 8000;
  while (Date.now() < end) {
    await capture();
    if (await tv().page.locator(n ? '.scr--podium.is-done' : '.scr--podium').count()) break;
    await sleep(250);
  }
  await sleep(SETTLE + 100);
  if (n && !(await tv().page.locator('.scr--podium.is-done').count())) fail('the TV awards ceremony never finished');
  const late = await Promise.all(phones().map(awardsOn));
  if (late.some((x) => x !== n)) fail(`after the ceremony every phone should list all ${n} awards (got ${late.join(', ')})`);
  await capture({ force: true, tag: 'final' });
}

/* ================================================================== run */
let exitCode = 0;
try {
  // ---------------------------------------------------------------- open everything
  await open('host', 'host', '/host', { width: 1440, height: 900 });
  await open('tv', 'tv', '/tv', { width: 1920, height: 1080 });
  await until(() => host().page.locator('#team-name').count(), 'the host lobby');
  await until(() => tv().page.locator('body[data-screen="lobby"]').count(), 'the TV lobby');
  await capture();
  await tv().page.locator('#startBtn').click(); // "Click to start the show" (sound + full screen)
  await until(() => tv().page.evaluate(() => document.documentElement.classList.contains('is-started')), 'the TV show to start');

  // ---------------------------------------------------------------- host makes the teams
  for (const t of TEAMS) {
    await host().page.locator('#team-name').fill(t.name);
    const m = host().page.locator(`#add-team .mascot-opt[data-mascot="${t.mascot}"]`);
    if (await m.count()) await m.click();
    await host().page.locator('#add-team .add-team__btn').click();
    await until(() => teamIdByName(t.name), `team ${t.name}`);
    // the form clears itself when the ack arrives (after the state push): wait for it before typing the next name
    await until(async () => (await host().page.locator('#team-name').inputValue()) === '', 'the add-team form to reset');
    log(`host: added ${t.name}`);
  }
  await capture({ now: true, tag: 'teams' });

  // ---------------------------------------------------------------- phones join
  for (const ph of PHONES) {
    const P = await open(slug(ph.name), 'phone', '/', { width: 390, height: 844 });
    P.teamId = teamIdByName(TEAMS[ph.team].name);
    await until(() => P.page.locator('body[data-screen="join"] #player-name').count(), `${ph.name}'s join screen`);
    await P.page.locator('#player-name').fill(ph.name);
    await tap(P, `[data-team="${P.teamId}"]`);
    await capture({ now: true, tag: 'join-filled' });
    await tap(P, '[data-join]');
    await until(() => P.page.locator('body[data-screen="lobby"]').count(), `${ph.name} in the waiting room`);
    log(`${ph.name} joined ${TEAMS[ph.team].name}`);
  }
  await capture({ now: true, tag: 'everyone-in' });

  // ---------------------------------------------------------------- settings: 4 rounds, round bonus on
  await setRounds(4);
  if (!G.state.settings.roundBonus) {
    await host().page.locator('[data-key="opt:roundBonus"]').click();
    await until(() => G.state.settings.roundBonus, 'the round bonus to turn on');
  }
  // the opening script
  if (await hostAct('introScript')) {
    await until(() => host().page.locator('.modal--script').count(), 'the opening script');
    await capture({ now: true, tag: 'script' });
    await host().page.locator('.modal [data-ui="closeModal"]').first().click();
  }
  await capture({ now: true, tag: 'ready' });

  // ---------------------------------------------------------------- main game
  await until(() => hostAct('start'), 'the Start button');
  const main = await playGame('main game', MAIN_PLAN, { maxMs: 15 * 60_000, natural: 1 });
  await ceremony();
  const missing = ALL_TYPES.filter((t) => !main.has(t));
  if (missing.length) fail(`mini-games that never came up: ${missing.join(', ')}`);
  if (!pv().podium?.awards?.length) log('note: no funny awards were earned this game');

  // sound + sight gags fired on the TV (and the phones reacted)
  const tvCc = await tv().page.evaluate(() => window.__cc);
  log(`TV sound nodes: ${tvCc.osc} oscillators, ${tvCc.buf} buffers; gags: ${JSON.stringify(tvCc.sprites)}; element gags: ${JSON.stringify(tvCc.classes)}`);
  if (tvCc.osc < 50) fail(`the TV barely made a sound (${tvCc.osc} oscillators)`);
  const sprites = Object.keys(tvCc.sprites).join(' ');
  for (const [what, re] of [['reindeer dash (correct)', /art:deer/], ['coal drop (wrong)', /fx-coal/], ['confetti', /fx-confetti/], ['Santa peek or money sneak', /art:(santa|money)/]]) {
    if (!re.test(sprites)) fail(`TV gag never fired: ${what}`);
  }
  if (!tvCc.classes['fx-bounce']) fail('TV mascots never bounced');
  const phoneCc = await Promise.all(phones().map((P) => P.page.evaluate(() => window.__cc)));
  if (!phoneCc.some((cc) => Object.keys(cc.classes).length)) fail('no phone mascot ever reacted (bounce / droop)');

  // ---------------------------------------------------------------- quick pass: TV 1280×720, phones 360×740
  if (QUICK) {
    prefix = 'q-';
    await tv().page.setViewportSize({ width: 1280, height: 720 });
    for (const P of phones()) await P.page.setViewportSize({ width: 360, height: 740 });
    await until(() => hostAct('playAgain'), 'Play again');
    await until(() => pv().phase === 'lobby', 'the lobby');
    await setRounds(1);
    if (G.state.settings.roundBonus) await host().page.locator('[data-key="opt:roundBonus"]').click();
    await capture({ now: true, tag: 'lobby-again' });
    await until(() => hostAct('start'), 'the Start button');
    const quick = await playGame('quick game (720p TV, 360 px phones)', QUICK_PLAN, { maxMs: 8 * 60_000 });
    await ceremony();
    for (const t of ['showdown', 'dare', 'allplay']) if (!quick.has(t)) fail(`quick pass: ${t} never came up`);
  }
} catch (e) {
  exitCode = 1;
  fail(e.stack || String(e));
  try {
    prefix = 'FAIL-';
    await capture({ force: true, tag: 'failure' });
  } catch {
    /* ignore */
  }
} finally {
  await browser.close().catch(() => {});
  await srv.close().catch(() => {});
  fs.rmSync(saveDir, { recursive: true, force: true });
}

console.log('');
console.log(`${shotNo} screenshots in ${path.relative(process.cwd(), SHOTS) || SHOTS}`);
if (problems.length || exitCode) {
  console.log(`UI smoke FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}) after ${secs().trim()} s`);
  for (const p of problems) console.log(`  - ${p.split('\n')[0]}`);
  process.exit(1);
}
console.log(`UI smoke passed in ${secs().trim()} s`);
process.exit(0);
