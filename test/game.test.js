'use strict';
/**
 * Unit tests for src/game.js (+ content, match, views, net, scheduler).
 * Deterministic: seeded RNG + fake clock, no sockets, no real timers. Acceptance-test numbers refer to TECH.md §5.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createGame, SEGMENTS, recommendedRounds, PTS, MASCOTS, OTHER_ANSWER } = require('../src/game');
const { loadContent, validateItem, drawFrom, isQuickQuestion, FILES, loadQuips, validateQuip, QUIP_KEYS, QUIP_ANSWER_KEYS } = require('../src/content');
const { createScheduler, createFakeClock } = require('../src/scheduler');
const { publicView, hostView, playerView } = require('../src/views');
const { isMatch, matchKind, normalize, containsAnswer } = require('../src/match');
const { pickLanAddress } = require('../src/net');
const grammar = require('../src/grammar');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONTENT = loadContent(DATA_DIR);
const SEG = { christmas: 0, dare: 1, pop: 2, hotseat: 3, movies: 4, christmas2: 4, sound: 5, grinch: 6, showdown: 7, dare2: 8, list: 9, allplay: 10, doubledown: 11 };

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------ leak scanner
function esc(s) { return JSON.stringify(s).slice(1, -1); }
/** Strings that must NOT be visible to the room right now (from the server's private state). */
function secretsOf(g) {
  const S = g.state;
  const c = S.challenge;
  const out = [];
  if (c) {
    if (c.q && !c.revealed) { out.push(c.q.answer, ...c.q.accept, c.q.funFact); if (!c.hintShown) out.push(c.q.hint); }
    if (c.type === 'sounditout' && !c.revealed) { out.push(c.song.title, ...c.song.accept); if (!c.hintShown) out.push(c.song.hint); }
    if (c.type === 'dare' && c.secretValue && !c.revealed) out.push(c.secretValue);
    if (c.type === 'rapidlist') { if (!c.listRevealed) out.push(...c.list.answers.filter((a) => !c.ticked.includes(a))); out.push(c.list.note); }
    if (c.type === 'hotseat') c.hs.questions.forEach((x, i) => { out.push(x.answer, ...x.accept); if (i > c.hs.index || !c.started) out.push(x.question); });
  }
  if (S.final && !S.final.done) {
    out.push(S.final.q.answer, ...S.final.q.accept);
    if (!['finalAnswer', 'finalReveal', 'podium'].includes(S.phase)) out.push(S.final.q.question);
  }
  return out.filter((s) => typeof s === 'string' && s.trim().length >= 4 && !/^[\d,. ]+$/.test(s.trim()));
}
/** Text that is legitimately public right now (to skip coincidental matches like an answer word inside a dare). */
function allowedText(g) {
  const S = g.state;
  const c = S.challenge;
  const parts = [...S.teams.map((t) => t.name), ...Object.values(S.players).map((p) => p.name), ...SEGMENTS.flatMap((s) => [s.label, s.rule])];
  if (c) {
    if (c.q && c.type !== 'hotseat') parts.push(c.q.question);
    if (c.dare) parts.push(c.dare.title, c.dare.instructions, c.dare.judge, ...c.dare.props);
    if (c.showdown) parts.push(c.showdown.title, c.showdown.instructions, c.showdown.winner, ...c.showdown.props);
    if (c.list) parts.push(c.list.prompt, ...c.ticked);
    if (c.hs && c.started && c.hs.questions[c.hs.index]) parts.push(c.hs.questions[c.hs.index].question);
    if (c.subs) for (const s of Object.values(c.subs)) if (c.revealed) parts.push(s.text);
  }
  if (S.final) {
    if (['finalAnswer', 'finalReveal', 'podium'].includes(S.phase)) parts.push(S.final.q.question);
    for (const r of Object.values(S.final.rows || {})) if (r.revealed) parts.push(r.text);
  }
  for (const a of S.lastAwards) parts.push(a.reason);
  return parts.join('\n');
}
function scanViews(g, ctx) {
  ctx.scans++;
  const secrets = secretsOf(g);
  const allowed = allowedText(g);
  const pvJson = JSON.stringify(publicView(g));
  // comedy: every TV quip has its placeholders filled; record each new quip (in a game) for the no-repeat check
  const q = publicView(g).quip;
  if (q && /\{[a-zA-Z]+\}/.test(q.text)) ctx.leaks.push(`quip ${q.id} has an unfilled placeholder: ${q.text}`);
  if (q && g.state.phase !== 'lobby' && (!ctx.lastQuip || ctx.lastQuip.id !== q.id)) (ctx.quips = ctx.quips || []).push({ ...q, phase: g.state.phase, gameNo: g.state.gameNo });
  ctx.lastQuip = q;
  for (const key of ['"accept":', '"secretValue"', '"clientId"', '"clients"', '"subs"', '"hs":', '"song":', '"awarded"']) {
    if (pvJson.includes(key)) ctx.leaks.push(`publicView has key ${key} (phase ${g.state.phase})`);
  }
  for (const s of secrets) {
    if (allowed.includes(s)) continue;
    if (pvJson.includes(esc(s))) ctx.leaks.push(`publicView leaks "${s}" (phase ${g.state.phase}, challenge ${g.state.challenge && g.state.challenge.type}/${g.state.challenge && g.state.challenge.stage})`);
  }
  // performer-only secrets: nobody else's playerView may contain them
  const c = g.state.challenge;
  const perfSecrets = [];
  if (c && !c.revealed && c.type === 'sounditout') perfSecrets.push(c.song.title);
  if (c && !c.revealed && c.type === 'dare' && c.secretValue) perfSecrets.push(c.secretValue);
  const performers = new Set([c && c.performer && c.performer.playerId, c && c.partner && c.partner.playerId].filter(Boolean));
  for (const p of Object.values(g.state.players)) {
    const v = playerView(g, p.id);
    if (performers.has(p.id)) {
      if (perfSecrets.length && (!v.secret || !perfSecrets.includes(v.secret.value))) ctx.leaks.push(`performer ${p.id} lacks secret`);
      continue;
    }
    if (v.secret) ctx.leaks.push(`non-performer ${p.id} got a secret`);
    const j = JSON.stringify({ ...v, myTeam: null });
    for (const s of perfSecrets) if (s.length >= 4 && !allowed.includes(s) && j.includes(esc(s))) ctx.leaks.push(`player ${p.id} view leaks performer secret "${s}"`);
  }
  checkCoach(g, ctx, secrets, allowed);
}
/** Coach invariants: a headline, at least one usable action, every enabled action accepted by the server, never reads a secret aloud. */
function checkCoach(g, ctx, secrets, allowed) {
  const where = `phase ${g.state.phase}, challenge ${g.state.challenge && g.state.challenge.type}/${g.state.challenge && g.state.challenge.stage}`;
  const co = hostView(g, { connections: { tv: 1, hosts: 1 } }).host.coach;
  if (!co || typeof co.headline !== 'string' || !co.headline.trim()) { ctx.leaks.push(`coach without headline (${where})`); return; }
  ctx.coachStates = (ctx.coachStates || 0) + 1;
  const enabled = co.actions.filter((a) => !a.disabled && a.event);
  if (!enabled.length) ctx.leaks.push(`coach has no usable action (${where})`);
  for (const a of enabled) {
    const r = g.check({ role: 'host' }, a.event, a.payload || {});
    if (!r.ok) ctx.leaks.push(`coach action ${a.id} -> ${r.error} (${where})`);
  }
  for (const a of co.actions) {
    if (!['primary', 'secondary', 'danger', 'success'].includes(a.kind)) ctx.leaks.push(`coach action ${a.id} bad kind ${a.kind}`);
    if (a.disabled && !a.reason) ctx.leaks.push(`disabled coach action ${a.id} without a reason (${where})`);
  }
  if (new Set(co.actions.map((a) => a.id)).size !== co.actions.length) ctx.leaks.push(`duplicate coach action ids (${where})`);
  if (co.primary && !enabled.some((a) => a.id === co.primary)) ctx.leaks.push(`coach primary ${co.primary} is not an enabled action (${where})`);
  if (co.say) for (const sec of secrets) if (!allowed.includes(sec) && co.say.includes(sec)) ctx.leaks.push(`coach.say reads out a secret "${sec}" (${where})`);
  if (!Array.isArray(co.steps) || !Array.isArray(co.tips) || !Array.isArray(co.progress)) ctx.leaks.push(`coach arrays missing (${where})`);
}

// ------------------------------------------------------------------------------------------------ fixture
function setup({ teams = 3, perTeam = 2, seed = 7, scan = false, content = CONTENT, timing, names = null } = {}) {
  const clock = createFakeClock();
  const sched = createScheduler({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const fx = [];
  const ctx = { leaks: [], scans: 0 };
  let g = null;
  g = createGame({ content, rng: mulberry32(seed), now: clock.now, scheduler: sched, timing, onFx: (e) => fx.push(e), onChange: () => { if (scan && g) scanViews(g, ctx); } });
  const H = { role: 'host' };
  const d = (actor, type, payload) => g.dispatch(actor, type, payload);
  const host = (type, payload) => d(H, 'host:' + type, payload);
  const okHost = (type, payload) => { const r = host(type, payload); assert.equal(r.ok, true, `host:${type} ${JSON.stringify(payload)} -> ${r.error} (phase ${g.state.phase}, stage ${g.state.challenge && g.state.challenge.stage})`); return r; };
  const okP = (actor, type, payload) => { const r = d(actor, type, payload); assert.equal(r.ok, true, `${actor.clientId} ${type} ${JSON.stringify(payload)} -> ${r.error} (phase ${g.state.phase}, stage ${g.state.challenge && g.state.challenge.stage})`); return r; };
  const teamIds = [];
  const players = {};
  for (let i = 0; i < teams; i++) {
    const id = okHost('createTeam', { name: names && names[i] ? names[i] : 'Team ' + (i + 1) }).teamId;
    teamIds.push(id);
    players[id] = [];
    for (let j = 0; j < perTeam; j++) {
      const a = { role: 'player', clientId: `client-${i}-${j}` };
      okP(a, 'join', { name: `Player ${i}${j}`, teamId: id });
      players[id].push(a);
    }
  }
  const pid = (actor) => g.playerIdForClient(actor.clientId);
  const active = () => g.activeTeamId();
  const activeP = () => players[active()][0];
  const otherP = (n = 0) => players[teamIds.filter((t) => t !== active())[n]][0];
  /** start + land on a forced segment for the current active team */
  const land = (index) => { okHost('forceSegment', { index }); clock.advance(g.timing.spinMs); assert.ok(['challenge', 'turnResult'].includes(g.state.phase)); return g.state.challenge; };
  /** nextTurn, and step through a round break (incl. its bonus question) to the next turn */
  const next = () => {
    okHost('nextTurn', { turnId: g.state.turnId });
    for (let i = 0; i < 5 && g.state.phase === 'roundBreak'; i++) okHost('continue');
  };
  const score = (id) => g.state.teams.find((t) => t.id === id).score;
  const scores = () => g.state.teams.map((t) => t.score);
  const setScores = (arr) => { g.state.teams.forEach((t, i) => { t.score = arr[i]; }); };
  return { g, clock, fx, ctx, H, d, host, okHost, okP, teamIds, players, pid, active, activeP, otherP, land, next, score, scores, setScores };
}

// ------------------------------------------------------------------------------------------------ full-game driver
function driveChallenge(T, rng, seen) {
  const { g, clock, okHost, okP, players, teamIds } = T;
  if (g.state.challenge) seen.add(g.state.challenge.type);
  for (let guard = 0; guard < 200 && g.state.phase === 'challenge'; guard++) {
    const c = g.state.challenge;
    const act = g.activeTeamId();
    const actP = players[act][0];
    const others = teamIds.filter((t) => t !== act);
    seen.add(c.type);
    const r = rng();
    switch (c.type) {
      case 'doubledown':
        assert.equal(g.state.teams.find((t) => t.id === act).score >= 0, true);
        okHost('forceSegment', { index: [SEG.christmas, SEG.dare, SEG.list, SEG.hotseat][Math.floor(rng() * 4)] });
        clock.advance(g.timing.spinMs);
        break;
      case 'trivia':
        if (c.stage === 'pickDifficulty') okP(players[act][players[act].length - 1], 'pickDifficulty', { level: ['easy', 'medium', 'hard'][Math.floor(r * 3)] });
        else if (c.stage === 'question') {
          if (r < 0.4) okHost('judge', { result: 'correct' });
          else if (r < 0.5) okHost('showHint');
          else if (r < 0.8) okHost('judge', { result: 'wrong' });
          else clock.advance(g.timing.triviaMs);
        } else if (c.stage === 'steal') stealStep(T, rng);
        break;
      case 'sounditout':
        if (c.stage === 'perform') {
          if (!g.state.timer.started) okHost('timer', { action: 'start' });
          else if (r < 0.4) okHost('judge', { result: 'correct' });
          else if (r < 0.7) okHost('judge', { result: 'wrong' });
          else clock.advance(g.timing.soundMs);
        } else if (c.stage === 'steal') stealStep(T, rng);
        break;
      case 'dare':
        if (c.stage === 'perform') {
          if (!g.state.timer.started) okHost('timer', { action: 'start' });
          else if (r < 0.5) okHost('dareResult', { result: ['nailed', 'valiant', 'fail'][Math.floor(rng() * 3)], bonus: rng() < 0.3 });
          else okHost('openVote');
        } else if (c.stage === 'vote') {
          const voters = others.flatMap((t) => players[t]);
          if (r < 0.2) okHost('closeVote');
          else {
            const v = voters.find((a) => !Object.prototype.hasOwnProperty.call(c.vote.votes, T.pid(a)));
            if (v) okP(v, 'vote', { choice: rng() < 0.6 ? 'nailed' : 'good' });
          }
        }
        break;
      case 'showdown':
        if (c.stage === 'pickRival') okP(actP, 'pickTarget', { teamId: c.targets[Math.floor(rng() * c.targets.length)] });
        else if (!g.state.timer.started) okHost('timer', { action: 'start' });
        else okHost('showdownResult', { winner: ['active', 'rival', 'tie'][Math.floor(r * 3)] });
        break;
      case 'rapidlist':
        if (!g.state.timer.started) okHost('timer', { action: 'start' });
        else if (c.ticked.length < 3 + Math.floor(r * 6) && c.ticked.length < c.list.answers.length) okHost('listTick', { answer: c.list.answers.find((a) => !c.ticked.includes(a)) });
        else if (r < 0.3) okHost('listOther');
        else clock.advance(g.timing.listMs);
        break;
      case 'hotseat':
        if (!g.state.timer.started) okHost('timer', { action: 'start' });
        else if (r < 0.9) okHost('hotseatMark', { result: ['correct', 'correct', 'wrong', 'pass'][Math.floor(rng() * 4)], index: c.hs.index });
        else clock.advance(g.timing.hotseatMs);
        break;
      case 'allplay':
        if (c.stage === 'answering') {
          for (const t of teamIds) {
            const a = players[t][Math.floor(rng() * players[t].length)];
            const roll = rng();
            okP(a, 'submitAnswer', { text: roll < 0.5 ? c.q.answer : roll < 0.7 ? c.q.answer.toLowerCase() + '!' : 'no idea ' + Math.floor(rng() * 100) });
          }
          clock.advance(g.timing.allPlayMs);
          assert.equal(g.state.challenge.stage, 'marking');
        } else if (c.stage === 'marking') {
          const sub = Object.keys(c.subs)[0];
          if (sub && rng() < 0.3) okHost('markAnswer', { teamId: sub, correct: !g.effCorrect(c.subs[sub]) });
          okHost('revealAnswers');
        }
        break;
      case 'grinch':
        if (c.stage === 'pickTarget') okP(actP, 'pickTarget', { teamId: c.targets[0] });
        break;
      default:
        throw new Error('unhandled challenge ' + c.type);
    }
  }
}
function stealStep(T, rng) {
  const { g, clock, okHost, okP, players } = T;
  const b = g.state.challenge.buzz;
  if (b.armingUntil) { clock.advance(g.timing.armMs); return; }
  if (b.winner) { okHost('judge', { result: rng() < 0.5 ? 'correct' : 'wrong' }); return; }
  if (b.open) {
    if (rng() < 0.15) { clock.advance(g.timing.stealMs); return; }
    const team = b.eligibleTeamIds[Math.floor(rng() * b.eligibleTeamIds.length)];
    okP(players[team][0], 'buzz');
    return;
  }
  if (rng() < 0.6) okHost('openSteal'); else okHost('reveal');
}
function playFullGame(T, seed = 99) {
  const { g, clock, okHost, okP, players, teamIds } = T;
  const rng = mulberry32(seed);
  const seen = new Set();
  okHost('start');
  let turn = 0;
  for (let guard = 0; guard < 2000 && g.state.phase !== 'podium'; guard++) {
    const S = g.state;
    switch (S.phase) {
      case 'turnIntro':
        if (turn >= 12 && rng() < 0.3) { okP(players[g.activeTeamId()][0], 'spin'); clock.advance(g.timing.spinMs); turn++; }
        else { okHost('forceSegment', { index: turn++ % 12 }); clock.advance(g.timing.spinMs); }
        driveChallenge(T, rng, seen);
        assert.equal(g.state.phase, 'turnResult', 'challenge should end in turnResult');
        break;
      case 'turnResult':
        okHost('nextTurn', { turnId: S.turnId });
        break;
      case 'roundBreak':
        if (S.challenge && S.challenge.stage === 'answering') {
          for (const t of teamIds) okP(players[t][0], 'submitAnswer', { text: rng() < 0.5 ? S.challenge.q.answer : 'pass' });
        }
        okHost('continue');
        break;
      case 'finalIntro':
        okHost('continue');
        break;
      case 'finalWager':
        for (const t of teamIds) {
          const a = players[t][0];
          const max = g.maxWager(t);
          assert.equal(T.d(a, 'wager', { amount: max + 1 }).ok, false);
          okP(a, 'wager', { amount: Math.floor(rng() * (max + 1)) });
        }
        okHost('finalStartAnswering');
        break;
      case 'finalAnswer':
        for (const t of teamIds) okP(players[t][0], 'submitAnswer', { text: rng() < 0.5 ? S.final.q.answer : 'something else' });
        okHost('continue');
        break;
      case 'finalReveal':
        if (S.final.current && !S.final.rows[S.final.current].judged && rng() < 0.5) okHost('markAnswer', { teamId: S.final.current, correct: rng() < 0.5 });
        else okHost('finalRevealNext');
        break;
      default:
        throw new Error('unexpected phase ' + S.phase);
    }
  }
  assert.equal(g.state.phase, 'podium');
  return seen;
}

// ================================================================================================ tests

test('18. content files validate (schema, counts, unique ids, no answer in its question)', () => {
  assert.deepEqual(CONTENT.problems, [], 'content problems: ' + JSON.stringify(CONTENT.problems.slice(0, 10), null, 1));
  const ids = new Set();
  for (const file of Object.keys(FILES)) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    assert.ok(Array.isArray(raw) && raw.length > 0, file + ' is a non-empty array');
    for (const it of raw) {
      assert.deepEqual(validateItem(FILES[file], it), [], `${file} ${it.id}`);
      assert.ok(!ids.has(it.id), 'duplicate id ' + it.id);
      ids.add(it.id);
      if (it.question && it.answer) assert.ok(!containsAnswer(it.question, it.answer), `${it.id}: answer inside question`);
    }
  }
  for (const cat of ['christmas', 'popculture']) for (const d of ['easy', 'medium', 'hard']) {
    assert.ok(CONTENT.trivia.filter((q) => q.category === cat && q.difficulty === d).length >= 3, `${cat}/${d} >= 3`);
  }
  assert.ok(CONTENT.trivia.filter(isQuickQuestion).length >= 12, 'enough quick questions for Hot Seat / All Play');
  assert.ok(CONTENT.songs.length >= 6 && CONTENT.lists.length >= 6 && CONTENT.dares.length >= 8 && CONTENT.finals.length >= 2 && CONTENT.showdowns.length >= 6);
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'questions.json')) === false, 'v1 questions.json removed');
});

test('18b. validator rejects malformed items and loader survives broken files', () => {
  assert.ok(validateItem('trivia', { id: 'x', category: 'christmas', difficulty: 'easy', question: 'What colour is Rudolph\'s nose?', answer: 'Rudolph' }).includes('answer text appears in the question'));
  assert.ok(validateItem('trivia', { id: 'x', category: 'xmas', difficulty: 'easy', question: 'Q?????', answer: 'A' }).length > 0);
  assert.ok(validateItem('dares', { id: 'd', title: 't', who: 'one', instructions: 'do it now', secret: { label: 'x', options: [] }, time: 30, props: [], judge: 'j', tags: [] }).length > 0);
  assert.ok(validateItem('showdowns', { id: 's', title: 't', instructions: 'do it now', time: 2, props: [], winner: 'w', tags: [] }).length > 0);
  assert.deepEqual(validateItem('showdowns', { id: 's', title: 't', instructions: 'do it now', time: 30, props: [], winner: 'w', tags: [] }), []);
  assert.ok(validateItem('lists', { id: 'l', prompt: 'Name things', answers: ['a', 'A', 'b'] }).includes('duplicate answers'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-content-'));
  fs.writeFileSync(path.join(dir, 'trivia-christmas.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'songs.json'), JSON.stringify([{ id: 's1', title: 'Jingle Bells' }, { id: 's1', title: 'dup' }, { nope: 1 }]));
  const c = loadContent(dir);
  assert.ok(c.problems.length > 3);
  assert.equal(c.songs.length, 1);
  for (const k of ['trivia', 'songs', 'lists', 'dares', 'finals', 'showdowns']) assert.ok(c[k].length > 0, k + ' has fallback items');
  // a game on fallback content still runs every segment
  const T = setup({ content: c, teams: 2, perTeam: 1 });
  const seen = playFullGame(T, 5);
  assert.equal(seen.size, 9, 'all 9 mini-game types: ' + [...seen].join(','));
});

test('content bags never repeat until exhausted, then release only that pool', () => {
  const used = new Set();
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const rng = mulberry32(3);
  const firstRound = [drawFrom(pool, used, rng), drawFrom(pool, used, rng), drawFrom(pool, used, rng)].map((x) => x.id).sort();
  assert.deepEqual(firstRound, ['a', 'b', 'c']);
  used.add('other');
  const next = drawFrom(pool, used, rng);
  assert.ok(next);
  assert.ok(used.has('other'), 'other pools keep their used ids');
});

test('13a. answer matching: case, punctuation, articles, accents, number words, accept list, small typos', () => {
  assert.ok(isMatch('  the ONE horse open sleigh!! ', 'One Horse Open Sleigh'));
  assert.ok(isMatch('Rudolf', 'Rudolph'));
  assert.ok(isMatch('Clarance', 'Clarence'));
  assert.ok(isMatch('kevin mccallister', 'Kevin'));
  assert.ok(isMatch('paris france', 'Paris'));
  assert.ok(isMatch('Noel', 'Noël'));
  assert.ok(isMatch('8', 'Eight'));
  assert.ok(isMatch('Norge', 'Norway', ['Norge']));
  assert.ok(isMatch('25000', '25,000'));
  assert.ok(isMatch('wham', 'Wham!'));
  assert.ok(!isMatch('New York City', 'Paris'));
  assert.ok(!isMatch('1858', '1857'));
  assert.ok(!isMatch('cat', 'car'));
  assert.ok(!isMatch('', 'Paris'));
  assert.equal(normalize("The Grinch's"), 'grinchs');
});

test('16. rounds formula and manual rounds survive adding/removing teams', () => {
  const expected = { 2: 6, 3: 6, 4: 5, 5: 4, 6: 3, 7: 3, 8: 3 };
  for (const [n, r] of Object.entries(expected)) assert.equal(recommendedRounds(+n), r, `${n} teams`);
  const T = setup({ teams: 4, perTeam: 0 });
  assert.equal(T.g.state.settings.rounds, 5);
  assert.equal(T.g.state.settings.autoRounds, true);
  T.okHost('createTeam', { name: 'Fifth' });
  assert.equal(T.g.state.settings.rounds, 4);
  assert.equal(T.g.state.settings.roundBonus, true, 'round bonus defaults on for 5+ teams');
  T.okHost('setRounds', { n: 2 });
  assert.equal(T.g.state.settings.autoRounds, false);
  T.okHost('createTeam', { name: 'Sixth' });
  T.okHost('removeTeam', { teamId: T.teamIds[0] });
  T.okHost('removeTeam', { teamId: T.teamIds[1] });
  assert.equal(T.g.state.settings.rounds, 2, 'manual choice is never overwritten');
  assert.equal(T.host('setRounds', { n: 0 }).ok, false);
  assert.equal(T.host('setRounds', { n: 9 }).ok, false);
  assert.equal(T.host('setRounds', { n: '3' }).ok, false);
  const pv = publicView(T.g);
  assert.equal(pv.settings.estimatedMinutes, Math.round(5 + 4 * 2 * 2.6 + 9));
});

test('4. removing a team in the lobby unassigns only its players; ids stay stable', () => {
  const T = setup({ teams: 4, perTeam: 2 });
  const [a, b, c, d] = T.teamIds;
  assert.deepEqual(T.teamIds, ['t1', 't2', 't3', 't4']);
  T.okHost('removeTeam', { teamId: b });
  assert.deepEqual(T.g.state.teams.map((t) => t.id), [a, c, d]);
  for (const p of T.players[b]) assert.equal(playerView(T.g, T.pid(p)).me.teamId, null);
  for (const t of [a, c, d]) for (const p of T.players[t]) assert.equal(playerView(T.g, T.pid(p)).me.teamId, t);
  assert.equal(T.fx.filter((e) => e.type === 'teamRemoved').length, 1);
  // unassigned player picks a team again; new team gets a NEW id
  const e = T.okHost('createTeam', { name: 'Late Arrivals' }).teamId;
  assert.equal(e, 't5');
  T.okP(T.players[b][0], 'join', { name: 'Back again', teamId: e });
  assert.equal(playerView(T.g, T.pid(T.players[b][0])).me.teamId, e);
  // removal is lobby-only
  T.okHost('start');
  assert.equal(T.host('removeTeam', { teamId: a }).error, 'not-now');
  // mid-game a player cannot switch teams by re-joining; the host can move them
  assert.equal(T.d(T.players[a][0], 'join', { name: 'x', teamId: c }).error, 'ask-host');
  T.okHost('movePlayer', { playerId: T.pid(T.players[a][0]), teamId: c });
  assert.equal(playerView(T.g, T.pid(T.players[a][0])).me.teamId, c);
});

test('team creation rules: unique names, mascot/colour pairing, max 8, escaping-safe names', () => {
  const T = setup({ teams: 0 });
  const r1 = T.okHost('createTeam', { name: '  <b>Elves</b>  ' });
  const t1 = T.g.state.teams[0];
  assert.equal(t1.name, '<b>Elves</b>', 'stored as plain text (clients escape)');
  assert.equal(t1.mascot, 'deer', 'first team gets the reindeer');
  assert.equal(t1.color, '#D42A2A', '…paired with candy red');
  assert.equal(T.host('createTeam', { name: '<B>ELVES</B>' }).error, 'name-taken');
  assert.equal(T.host('createTeam', { name: 'Other', mascot: 'deer' }).error, 'mascot-taken');
  assert.equal(T.host('createTeam', { name: 'Other', mascot: 'unicorn' }).error, 'bad-mascot');
  assert.equal(T.host('createTeam', { name: '' }).error, 'name-required');
  assert.equal(T.okHost('createTeam', { name: 'Gifts', mascot: 'gift' }) && T.g.state.teams[1].color, '#2E6FD1');
  for (let i = 0; i < 6; i++) T.okHost('createTeam', { name: 'T' + i });
  assert.equal(T.host('createTeam', { name: 'Ninth' }).error, 'too-many-teams');
  assert.equal(new Set(T.g.state.teams.map((t) => t.mascot)).size, 8);
  assert.ok(r1.teamId);
  T.okHost('updateTeam', { teamId: 't1', name: 'Elf Help' });
  assert.equal(T.g.state.teams[0].name, 'Elf Help');
  assert.equal(T.host('start').ok, true);
  assert.equal(T.host('updateTeam', { teamId: 't1', name: 'Renamed mid-game' }).ok, true, 'rename allowed mid-game');
});

test('player join validation and identity by clientId', () => {
  const T = setup({ teams: 2, perTeam: 0 });
  const a = { role: 'player', clientId: 'abc123xyz' };
  assert.equal(T.d(a, 'join', { name: '   ', teamId: 't1' }).error, 'name-required');
  assert.equal(T.d(a, 'join', { name: 'Ann', teamId: 't9' }).error, 'no-such-team');
  assert.equal(T.d(a, 'join', null).error, 'name-required');
  const r = T.okP(a, 'join', { name: 'Ann\u0000‮ the Great and Wonderful Aunt', teamId: 't1' });
  assert.equal(r.me.name.length <= 20, true);
  assert.ok(!/[\u0000‮]/.test(r.me.name));
  assert.equal(T.g.playerIdForClient('abc123xyz'), r.me.playerId);
  T.okP(a, 'join', { name: 'Ann', teamId: 't2' }); // lobby: switching allowed
  assert.equal(T.g.state.players[r.me.playerId].teamId, 't2');
  assert.equal(Object.keys(T.g.state.players).length, 1, 'same clientId = same player');
  T.g.setClientConnected('abc123xyz', false);
  assert.equal(publicView(T.g).players[0].connected, false);
  assert.equal(T.g.state.players[r.me.playerId] !== undefined, true, 'disconnect never deletes');
  T.okHost('kickPlayer', { playerId: r.me.playerId });
  assert.equal(T.g.playerIdForClient('abc123xyz'), null);
  assert.equal(T.d({ role: 'player', clientId: '__proto__' }, 'spin').error, 'not-joined');
});

test('9. trivia: only the active team picks; steal opens for OTHER teams after 3 s arm; wrong steal locks; one try each', () => {
  const T = setup({ teams: 4, perTeam: 2 });
  T.okHost('start');
  const act = T.active();
  const c = T.land(SEG.christmas);
  assert.equal(c.stage, 'pickDifficulty');
  const other = T.otherP(0);
  assert.equal(T.d(other, 'pickDifficulty', { level: 'hard' }).error, 'not-your-turn');
  assert.equal(playerView(T.g, T.pid(other)).can.pickDifficulty, false);
  assert.equal(playerView(T.g, T.pid(T.players[act][1])).can.pickDifficulty, true);
  assert.equal(T.d(T.players[act][1], 'pickDifficulty', { level: 'extreme' }).error, 'bad-level');
  T.okP(T.players[act][1], 'pickDifficulty', { level: 'hard' });
  assert.equal(T.d(T.players[act][0], 'pickDifficulty', { level: 'easy' }).error, 'not-now', 'first tap wins');
  assert.equal(T.g.state.challenge.points, 300);
  assert.equal(T.g.state.timer.running, true);
  assert.equal(T.g.state.timer.durationMs, 20000);
  // nobody can buzz during the question
  assert.equal(T.d(other, 'buzz').ok, false);
  T.okHost('judge', { result: 'wrong' });
  const b = T.g.state.challenge.buzz;
  assert.equal(T.g.state.challenge.stage, 'steal');
  assert.equal(T.g.state.challenge.stealPoints, 150);
  assert.ok(!b.eligibleTeamIds.includes(act), 'active team cannot steal');
  assert.equal(b.eligibleTeamIds.length, 3);
  // 3 s arm
  T.clock.advance(2999);
  assert.equal(T.d(other, 'buzz').error, 'arming');
  assert.equal(playerView(T.g, T.pid(other)).can.buzz, false);
  T.clock.advance(1);
  assert.equal(T.g.state.challenge.buzz.open, true);
  assert.equal(T.d(T.activeP(), 'buzz').error, 'not-eligible');
  assert.equal(playerView(T.g, T.pid(other)).can.buzz, true);
  const otherTeam = T.g.state.players[T.pid(other)].teamId;
  T.okP(other, 'buzz');
  assert.equal(T.d(T.otherP(1), 'buzz').error, 'not-now', 'only one winner');
  assert.equal(T.g.state.challenge.buzz.winner.teamId, otherTeam);
  T.okHost('judge', { result: 'wrong' });
  assert.ok(T.g.state.challenge.buzz.lockedTeamIds.includes(otherTeam));
  assert.equal(T.g.state.challenge.buzz.open, false, 'host reopens manually');
  T.okHost('openSteal');
  T.clock.advance(3000);
  assert.equal(T.d(T.players[otherTeam][1], 'buzz').error, 'locked-out', 'teammates are locked out too');
  T.okP(T.otherP(1), 'buzz');
  T.okHost('judge', { result: 'wrong' });
  T.okHost('openSteal');
  T.clock.advance(3000);
  T.okP(T.otherP(2), 'buzz');
  T.okHost('judge', { result: 'wrong' });
  // every other team tried once -> no more steals, answer revealed, turn over
  assert.equal(T.g.state.phase, 'turnResult');
  assert.equal(T.g.state.challenge.result.kind, 'missed');
  assert.ok(publicView(T.g).challenge.answer);
  assert.deepEqual(T.scores(), [0, 0, 0, 0]);
});

test('9b. trivia: correct awards active team; timeout opens steal; steal correct gives half; reveal closes buzzers', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  T.land(SEG.pop);
  T.okP(T.activeP(), 'pickDifficulty', { level: 'medium' });
  T.okHost('judge', { result: 'correct' });
  assert.equal(T.score(T.teamIds[0]), 200);
  assert.equal(T.g.state.phase, 'turnResult');
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  T.land(SEG.christmas);
  T.okP(T.activeP(), 'pickDifficulty', { level: 'easy' });
  T.okHost('showHint');
  assert.equal(T.g.state.challenge.points, 50, 'hint halves the points');
  assert.ok(publicView(T.g).challenge.hint);
  T.clock.advance(20000); // time-out
  assert.equal(T.g.state.challenge.stage, 'steal');
  T.clock.advance(3000);
  T.okP(T.otherP(0), 'buzz');
  T.okHost('judge', { result: 'correct' });
  assert.equal(T.score(T.teamIds[0]), 225, 'steal = half of the (hinted) value');
  // reveal during an open steal closes buzzers
  T.next();
  T.land(SEG.christmas2);
  T.okP(T.activeP(), 'pickDifficulty', { level: 'hard' });
  T.okHost('judge', { result: 'wrong' });
  T.clock.advance(3000);
  T.okHost('reveal');
  assert.equal(T.d(T.otherP(0), 'buzz').ok, false);
  assert.equal(T.g.state.phase, 'turnResult');
  // steal window timeout with no buzz
  T.next();
  T.land(SEG.christmas);
  T.okP(T.activeP(), 'pickDifficulty', { level: 'hard' });
  T.okHost('judge', { result: 'wrong' });
  T.clock.advance(3000 + 10000);
  assert.equal(T.g.state.challenge.result.kind, 'missed');
});

test('10. Double Down: only the active team, only positive awards, expires at nextTurn', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  const [a, b] = T.teamIds;
  const c = T.land(SEG.doubledown);
  assert.equal(c.stage, 'spinAgain');
  assert.equal(publicView(T.g).teams[0].multiplier, 2);
  assert.equal(playerView(T.g, T.pid(T.activeP())).can.spin, true);
  assert.equal(playerView(T.g, T.pid(T.otherP())).can.spin, false);
  // spin again from the phone -> trivia
  T.okHost('forceSegment', { index: SEG.christmas });
  T.clock.advance(5000);
  T.okP(T.activeP(), 'pickDifficulty', { level: 'medium' });
  T.okHost('judge', { result: 'correct' });
  assert.equal(T.score(a), 400, '200 doubled');
  // other team's points are never doubled, penalties never doubled
  T.okHost('adjustScore', { teamId: b, delta: 100 });
  assert.equal(T.score(b), 100);
  T.okHost('adjustScore', { teamId: a, delta: -50 });
  assert.equal(T.score(a), 350, 'penalty not doubled');
  assert.equal(T.g._award(b, 100, 'test'), 100, 'positive to another team not doubled');
  // landing it again keeps x2 (not x4)
  T.g.state.teams[2].score = 0;
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  assert.equal(publicView(T.g).teams.every((t) => t.multiplier === 1), true, 'expired at nextTurn');
  T.land(SEG.doubledown);
  T.okHost('forceSegment', { index: SEG.doubledown });
  T.clock.advance(5000);
  assert.equal(T.g.state.turn.multiplier, 2);
  T.okHost('forceSegment', { index: SEG.dare });
  T.clock.advance(5000);
  T.okHost('dareResult', { result: 'nailed', bonus: true });
  assert.equal(T.score(T.teamIds[1]), 200 + (200 + 50) * 2);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  // next team's All Play: only nothing doubled because no double down this turn
  T.land(SEG.allplay);
  for (const t of T.teamIds) T.okP(T.players[t][0], 'submitAnswer', { text: T.g.state.challenge.q.answer });
  const before = T.scores();
  T.okHost('revealAnswers');
  const gained = T.scores().map((s, i) => s - before[i]);
  assert.equal(gained.reduce((x, y) => x + y, 0), 3 * 100 + 50);
});

test('10b. Double Down doubles the active team in All Play / Grinch steal amount, never the others', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  const act = T.active();
  T.land(SEG.doubledown);
  T.okHost('forceSegment', { index: SEG.allplay });
  T.clock.advance(5000);
  const ans = T.g.state.challenge.q.answer;
  T.okP(T.otherP(0), 'submitAnswer', { text: ans }); // first correct
  T.clock.advance(10);
  T.okP(T.activeP(), 'submitAnswer', { text: ans });
  T.okP(T.otherP(1), 'submitAnswer', { text: 'nope' });
  T.okHost('revealAnswers');
  const other0 = T.g.state.players[T.pid(T.otherP(0))].teamId;
  assert.equal(T.score(act), 200, 'active doubled');
  assert.equal(T.score(other0), 150, 'other team: 100 + 50 first, not doubled');
});

test('11. Grinch Steal: targets only teams ahead; capped at victim score; single use; leader gift', () => {
  const T = setup({ teams: 4, perTeam: 1 });
  T.okHost('start');
  const [a, b, c, d] = T.teamIds;
  T.setScores([100, 500, 120, 50]);
  const ch = T.land(SEG.grinch);
  assert.deepEqual(ch.targets.sort(), [b, c].sort(), 'only teams strictly ahead');
  assert.equal(T.d(T.activeP(), 'pickTarget', { teamId: d }).error, 'bad-target');
  assert.equal(T.d(T.players[b][0], 'pickTarget', { teamId: c }).error, 'not-your-turn');
  assert.equal(playerView(T.g, T.pid(T.activeP())).can.pickTarget, true);
  T.okP(T.activeP(), 'pickTarget', { teamId: c });
  assert.deepEqual(T.scores(), [220, 500, 0, 50], 'capped at the victim score (120)');
  assert.equal(T.d(T.activeP(), 'pickTarget', { teamId: b }).ok, false, 'single use');
  assert.equal(T.host('pickTarget', { teamId: b }).ok, false);
  assert.deepEqual(T.g.state.challenge.steal, { from: c, to: a, amount: 120 });
  assert.equal(T.fx.filter((e) => e.type === 'steal').length, 1);
  // leader variant
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  T.setScores([220, 900, 0, 50]);
  const g2 = T.land(SEG.grinch);
  assert.equal(g2.stage, 'done');
  assert.equal(T.g.state.phase, 'turnResult');
  assert.deepEqual(g2.gift, { toTeamId: c, amount: 100 });
  assert.deepEqual(T.scores(), [220, 900, 100, 50]);
  assert.equal(publicView(T.g).challenge.gift.toTeamId, c);
});

test('12. secrets: song / dare secret only in the performer\'s playerView and hostView', () => {
  const T = setup({ teams: 3, perTeam: 3, seed: 11 });
  T.okHost('start');
  const c = T.land(SEG.sound);
  const perf = c.performer.playerId;
  const title = c.song.title;
  const act = T.active();
  for (const p of Object.values(T.g.state.players)) {
    const v = playerView(T.g, p.id);
    if (p.id === perf) { assert.equal(v.secret.value, title); assert.ok(v.secret.label); }
    else { assert.equal(v.secret, null); assert.ok(!JSON.stringify(v).includes(esc(title)), 'teammates/other teams never see the song'); }
  }
  assert.ok(!JSON.stringify(publicView(T.g)).includes(esc(title)));
  assert.equal(hostView(T.g, {}).host.song.title, title);
  // performer is on the active team and re-rollable
  assert.equal(T.g.state.players[perf].teamId, act);
  T.okHost('rerollPerformer');
  assert.notEqual(T.g.state.challenge.performer.playerId, perf);
  assert.equal(playerView(T.g, perf).secret, null, 'old performer loses the secret');
  // after reveal, the room sees it
  T.okHost('judge', { result: 'correct' });
  assert.equal(publicView(T.g).challenge.answer, title);
  // dare with a secret
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  let d;
  for (let i = 0; i < 40; i++) {
    d = T.land(SEG.dare);
    if (d.secretValue) break;
    T.okHost('swapQuestion');
    if (T.g.state.challenge.secretValue) { d = T.g.state.challenge; break; }
    T.okHost('endChallenge');
    T.okHost('nextTurn', { turnId: T.g.state.turnId });
  }
  assert.ok(d.secretValue, 'found a dare with a secret');
  const pv = publicView(T.g);
  assert.equal(pv.challenge.dare.hasSecret, true);
  assert.ok(!JSON.stringify(pv).includes(esc(d.secretValue)));
  assert.equal(playerView(T.g, d.performer.playerId).secret.value, d.secretValue);
  assert.equal(hostView(T.g, {}).host.secret.value, d.secretValue);
});

test('13. All Play typed: per team (last wins), auto-match incl. accept + typos, +50 first correct, host flip', () => {
  const T = setup({ teams: 4, perTeam: 2 });
  T.okHost('start');
  const c = T.land(SEG.allplay);
  const q = c.q;
  const [a, b, cc, d] = T.teamIds;
  assert.equal(T.g.state.timer.running, true);
  for (const t of T.teamIds) assert.equal(playerView(T.g, T.pid(T.players[t][0])).can.submitAnswer, true, 'every team, including the active one');
  T.okP(T.players[a][0], 'submitAnswer', { text: 'totally wrong' });
  T.clock.advance(100);
  T.okP(T.players[b][0], 'submitAnswer', { text: q.answer.toUpperCase() + '!!' });
  T.clock.advance(100);
  T.okP(T.players[a][1], 'submitAnswer', { text: q.answer }); // last submission per team wins
  T.clock.advance(100);
  const typo = q.answer.length >= 8 ? q.answer.slice(0, -2) + q.answer.slice(-1) : q.answer; // drop one char
  T.okP(T.players[cc][0], 'submitAnswer', { text: typo });
  assert.equal(T.d(T.players[d][0], 'submitAnswer', { text: '   ' }).error, 'empty-answer');
  assert.equal(T.d(T.players[d][0], 'submitAnswer', { text: 'x'.repeat(500) }).ok, true, 'long answers are truncated, not crashing');
  assert.equal(T.g.state.challenge.subs[d].text.length, 80);
  // public: answered flags only
  const pv = publicView(T.g);
  assert.deepEqual(pv.challenge.submissions.map((s) => Object.keys(s).sort()), T.teamIds.map(() => ['answered', 'teamId']));
  // host sees text + auto marks
  const hv = hostView(T.g, {}).host;
  assert.equal(hv.submissions.find((s) => s.teamId === a).text, q.answer);
  assert.equal(hv.submissions.find((s) => s.teamId === a).autoCorrect, true);
  assert.equal(hv.submissions.find((s) => s.teamId === b).autoCorrect, true);
  assert.equal(hv.submissions.find((s) => s.teamId === d).autoCorrect, false);
  // my team's submission shows on my phone
  assert.equal(playerView(T.g, T.pid(T.players[a][0])).myTeam.submission.text, q.answer);
  assert.equal(playerView(T.g, T.pid(T.players[a][0])).myTeam.submission.by, 'Player 01');
  T.clock.advance(20000);
  assert.equal(T.g.state.challenge.stage, 'marking');
  assert.equal(T.d(T.players[d][0], 'submitAnswer', { text: 'late' }).ok, false, 'locked after time');
  // host flips d to correct
  T.okHost('markAnswer', { teamId: d, correct: true });
  assert.equal(T.host('markAnswer', { teamId: 'nope', correct: true }).ok, false);
  T.okHost('revealAnswers');
  // b answered first correctly (a's correct answer came later)
  const subsCorrect = { [a]: true, [b]: true, [cc]: T.g.effCorrect(T.g.state.challenge.subs[cc]), [d]: true };
  assert.equal(T.score(b), 150, 'first correct +50');
  assert.equal(T.score(a), 100);
  assert.equal(T.score(d), 100);
  assert.equal(T.score(cc), subsCorrect[cc] ? 100 : 0);
  const pv2 = publicView(T.g).challenge;
  assert.equal(pv2.answer, q.answer);
  assert.equal(pv2.submissions.find((s) => s.teamId === b).first, true);
  // flip after reveal re-settles (first moves to a)
  T.okHost('markAnswer', { teamId: b, correct: false });
  assert.equal(T.score(b), 0);
  assert.equal(T.score(a), 150, 'a becomes first correct');
  assert.ok(isMatch(typo, q.answer));
});

test('14. Final Chaos: wager bounds, reveal low->high, +/-wager floored at 0, shared places', () => {
  const T = setup({ teams: 4, perTeam: 1 });
  T.okHost('setRounds', { n: 1 });
  T.okHost('start');
  for (let i = 0; i < 4; i++) { T.land(SEG.dare); T.okHost('dareResult', { result: 'fail' }); T.okHost('nextTurn', { turnId: T.g.state.turnId }); }
  assert.equal(T.g.state.phase, 'finalIntro');
  const [a, b, c, d] = T.teamIds;
  T.setScores([500, 100, 800, 100]);
  assert.equal(publicView(T.g).final.question, null, 'question hidden until answering');
  assert.ok(publicView(T.g).final.categoryLabel);
  T.okHost('continue');
  assert.equal(T.g.state.phase, 'finalWager');
  const P = (t) => T.players[t][0];
  assert.equal(T.d(P(b), 'wager', { amount: 301 }).error, 'bad-amount', 'max(score,300)');
  assert.equal(T.d(P(b), 'wager', { amount: -1 }).error, 'bad-amount');
  assert.equal(T.d(P(b), 'wager', { amount: 12.5 }).error, 'bad-amount');
  assert.equal(T.d(P(b), 'wager', { amount: '100' }).error, 'bad-amount');
  T.okP(P(b), 'wager', { amount: 300 });
  T.okP(P(c), 'wager', { amount: 800 });
  assert.equal(T.d(P(c), 'wager', { amount: 801 }).ok, false);
  T.okP(P(a), 'wager', { amount: 100 });
  T.okP(P(a), 'wager', { amount: 200 }); // last lock-in wins
  // d never wagers -> 0
  const pv = publicView(T.g);
  assert.deepEqual(pv.final.wagers.find((w) => w.teamId === a), { teamId: a, locked: true, max: T.g.maxWager(a) }, 'amounts hidden (only the public max)');
  assert.ok(!JSON.stringify(pv.final).includes('"amount"'), 'no wager amounts in the public view');
  assert.ok(!JSON.stringify(pv.final.wagers.map((w) => ({ ...w, max: 0 }))).includes('200'), 'team a wagered 200: not visible');
  assert.equal(playerView(T.g, T.pid(P(a))).myTeam.wager.amount, 200);
  assert.equal(playerView(T.g, T.pid(P(a))).myTeam.maxWager, 500);
  T.okHost('finalStartAnswering');
  assert.equal(T.g.state.final.wagers[d].amount, 0);
  assert.ok(publicView(T.g).final.question);
  const ans = T.g.state.final.q.answer;
  T.okP(P(a), 'submitAnswer', { text: ans });
  T.okP(P(b), 'submitAnswer', { text: 'wrong!' });
  T.okP(P(c), 'submitAnswer', { text: 'wrong too' });
  T.okP(P(d), 'submitAnswer', { text: ans.toLowerCase() });
  T.clock.advance(45000); // time-out -> reveal
  assert.equal(T.g.state.phase, 'finalReveal');
  assert.deepEqual(T.g.state.final.order, [b, d, a, c], 'lowest score first (ties keep turn order)');
  assert.equal(publicView(T.g).final.revealed.length, 0);
  T.okHost('finalRevealNext'); // reveal b
  assert.equal(publicView(T.g).final.revealed[0].teamId, b);
  assert.equal(publicView(T.g).final.revealed[0].judged, false);
  T.okHost('markAnswer', { teamId: b, correct: false }); // judge b: -300 floored at 0
  assert.equal(T.score(b), 0);
  assert.equal(publicView(T.g).final.revealed[0].delta, -100);
  T.okHost('finalRevealNext'); // reveal d
  T.okHost('finalRevealNext'); // judge d by auto-mark (correct, wager 0)
  assert.equal(T.score(d), 100);
  T.okHost('finalRevealNext'); // reveal a
  T.okHost('finalRevealNext'); // judge a: +200
  assert.equal(T.score(a), 700);
  T.okHost('finalRevealNext'); // reveal c
  T.okHost('markAnswer', { teamId: c, correct: false });
  assert.equal(T.score(c), 0);
  T.okHost('markAnswer', { teamId: c, correct: true }); // host flips: +800 instead
  assert.equal(T.score(c), 1600);
  assert.equal(publicView(T.g).final.done, true);
  assert.equal(publicView(T.g).final.answer, ans);
  T.okHost('finalRevealNext');
  assert.equal(T.g.state.phase, 'podium');
  const st = publicView(T.g).podium.standings;
  assert.deepEqual(st.map((s) => [s.teamId, s.place]), [[c, 1], [a, 2], [d, 3], [b, 4]]);
  // ties share places
  T.okHost('adjustScore', { teamId: a, delta: 900 });
  const st2 = publicView(T.g).podium.standings;
  assert.deepEqual(st2.slice(0, 2).map((s) => s.place), [1, 1]);
  assert.equal(st2[2].place, 3);
  assert.equal(T.host('nextTurn', { turnId: T.g.state.turnId }).error, 'not-now');
});

test('15. undo restores the exact previous scores, multi-level', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  const history = [T.scores()];
  T.land(SEG.christmas); T.okP(T.activeP(), 'pickDifficulty', { level: 'hard' }); T.okHost('judge', { result: 'correct' }); history.push(T.scores());
  T.okHost('adjustScore', { teamId: T.teamIds[1], delta: 250 }); history.push(T.scores());
  T.okHost('adjustScore', { teamId: T.teamIds[0], delta: -1000 }); history.push(T.scores()); // floored at 0
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  assert.equal(T.active(), T.teamIds[1]);
  T.okHost('adjustScore', { teamId: T.teamIds[0], delta: 400 }); history.push(T.scores());
  T.land(SEG.grinch); T.okP(T.activeP(), 'pickTarget', { teamId: T.teamIds[0] }); history.push(T.scores());
  assert.equal(hostView(T.g, {}).host.canUndo, true);
  assert.match(hostView(T.g, {}).host.undoLabel, /steals/);
  for (let i = history.length - 2; i >= 0; i--) {
    T.okHost('undo');
    assert.deepEqual(T.scores(), history[i], 'undo level ' + i);
  }
  assert.equal(T.host('undo').error, 'nothing-to-undo');
});

test('7. reset / nextTurn during a spin cancels it; no stale result lands; lobby not locked', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  T.okP(T.activeP(), 'spin');
  assert.equal(T.g.state.phase, 'spinning');
  assert.equal(T.d(T.activeP(), 'spin').error, 'not-now', 'spin accepted once per window');
  assert.equal(T.host('spin').error, 'not-now');
  T.clock.advance(2000);
  T.okHost('resetGame', { keepTeams: true });
  T.clock.advance(10000);
  assert.equal(T.g.state.phase, 'lobby');
  assert.equal(T.g.state.challenge, null);
  T.okHost('createTeam', { name: 'Late team' });
  T.okHost('removeTeam', { teamId: 't4' });
  // nextTurn during a spin
  T.okHost('start');
  const first = T.active();
  T.okP(T.activeP(), 'spin');
  T.clock.advance(1500);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  const second = T.active();
  assert.notEqual(first, second);
  T.clock.advance(10000);
  assert.equal(T.g.state.phase, 'turnIntro', 'stale spin did not land');
  assert.equal(T.g.state.challenge, null);
  assert.equal(T.active(), second);
  assert.equal(playerView(T.g, T.pid(T.activeP())).can.spin, true);
  // reset with keepTeams:false unassigns everybody
  T.okHost('resetGame', { keepTeams: false });
  assert.equal(T.g.state.teams.length, 0);
  assert.ok(Object.values(T.g.state.players).every((p) => p.teamId === null));
});

test('8. nextTurn with stale turnId is ignored; rejected in lobby and podium', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  assert.equal(T.host('nextTurn', { turnId: 0 }).error, 'not-now');
  T.okHost('start');
  const id = T.g.state.turnId;
  const first = T.active();
  T.okHost('nextTurn', { turnId: id });
  assert.equal(T.host('nextTurn', { turnId: id }).error, 'stale-turn', 'double click cannot skip a team');
  assert.equal(T.host('nextTurn', {}).error, 'stale-turn');
  assert.equal(T.host('nextTurn', { turnId: String(T.g.state.turnId) }).error, 'stale-turn');
  assert.equal(T.g.state.turnIndex, 1);
  assert.notEqual(T.active(), first);
});

test('3. play again keeping teams keeps players; game 2 playable; no question repeats across games', () => {
  const T = setup({ teams: 2, perTeam: 2, seed: 21 });
  T.okHost('setRounds', { n: 3 });
  const asked = [];
  const askTrivia = () => {
    T.land(SEG.christmas);
    T.okP(T.activeP(), 'pickDifficulty', { level: 'easy' });
    asked.push(T.g.state.challenge.q.id);
    T.okHost('judge', { result: 'correct' });
    T.okHost('nextTurn', { turnId: T.g.state.turnId });
    if (T.g.state.phase === 'roundBreak') T.okHost('continue');
  };
  T.okHost('start');
  for (let i = 0; i < 6; i++) askTrivia();
  assert.equal(T.g.state.phase, 'finalIntro');
  T.okHost('resetGame', { keepTeams: true });
  assert.equal(T.g.state.phase, 'lobby');
  assert.equal(T.g.state.teams.length, 2);
  assert.ok(T.g.state.teams.every((t) => t.score === 0));
  for (const t of T.teamIds) for (const p of T.players[t]) assert.equal(playerView(T.g, T.pid(p)).me.teamId, t, 'players kept on their teams');
  T.okHost('start');
  assert.equal(playerView(T.g, T.pid(T.activeP())).can.spin, true, 'phones work in game 2');
  T.okP(T.activeP(), 'spin');
  T.clock.advance(5000);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  for (let i = 0; i < 5; i++) askTrivia();
  assert.equal(T.g.state.phase, 'finalIntro');
  assert.equal(new Set(asked).size, asked.length, 'no question repeats across games');
});

test('dare: performer, timer start, room vote (others only, one vote each, changeable while open), majority + host override + crowd bonus', () => {
  const T = setup({ teams: 3, perTeam: 2 });
  T.okHost('start');
  const act = T.active();
  const c = T.land(SEG.dare);
  assert.ok(c.performer && c.performer.teamId === act);
  assert.equal(T.g.state.timer.running, false, 'host starts the dare timer');
  assert.equal(T.g.state.timer.durationMs, c.dare.time * 1000);
  T.okHost('timer', { action: 'start' });
  T.clock.advance(1000);
  T.okHost('timer', { action: 'pause' });
  const rem = T.g.state.timer.remainingMs;
  T.clock.advance(5000);
  assert.equal(publicView(T.g).timer.remainingMs, rem, 'paused');
  T.okHost('timer', { action: 'add', seconds: 10 });
  assert.equal(T.g.state.timer.remainingMs, rem + 10000);
  T.okHost('timer', { action: 'resume' });
  assert.equal(T.host('timer', { action: 'resume' }).ok, false);
  T.okHost('openVote');
  assert.equal(T.g.state.timer.kind, 'vote');
  assert.equal(T.g.state.timer.durationMs, 15000);
  assert.equal(T.d(T.players[act][0], 'vote', { choice: 'nailed' }).error, 'not-eligible');
  assert.equal(playerView(T.g, T.pid(T.players[act][0])).can.vote, false);
  const voters = T.teamIds.filter((t) => t !== act).flatMap((t) => T.players[t]);
  assert.equal(playerView(T.g, T.pid(voters[0])).can.vote, true);
  T.okP(voters[0], 'vote', { choice: 'good' });
  // voting again CHANGES the vote (one vote per player), it never adds a second one
  assert.deepEqual(T.d(voters[0], 'vote', { choice: 'nailed' }), { ok: true, changed: true });
  assert.equal(publicView(T.g).challenge.vote.voters, 1);
  assert.equal(publicView(T.g).challenge.vote.nailed, 1);
  T.okP(voters[0], 'vote', { choice: 'good' });
  assert.deepEqual(T.d(voters[0], 'vote', { choice: 'good' }), { ok: true, changed: false });
  assert.equal(publicView(T.g).challenge.vote.voters, 1);
  assert.equal(playerView(T.g, T.pid(voters[0])).myVote, 'good');
  assert.equal(T.d(voters[1], 'vote', { choice: 'maybe' }).error, 'bad-choice');
  T.okP(voters[1], 'vote', { choice: 'nailed' });
  T.okP(voters[2], 'vote', { choice: 'nailed' });
  assert.equal(publicView(T.g).challenge.vote.nailed, 2);
  T.okP(voters[3], 'vote', { choice: 'good' }); // all eligible voted -> closes; tie 2:2 -> nailed
  assert.equal(T.g.state.phase, 'turnResult');
  assert.equal(T.g.state.challenge.dareResult.result, 'nailed');
  assert.equal(T.score(act), 200);
  T.okHost('dareResult', { result: 'valiant' }); // host overrides the room
  assert.equal(T.score(act), 100);
  T.okHost('dareResult', { result: 'valiant', bonus: true }); // +50 crowd favourite
  assert.equal(T.score(act), 150);
  assert.equal(publicView(T.g).challenge.result.awards[0].delta, 150);
  // vote timer closes with whatever came in
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  T.land(SEG.dare2);
  T.okHost('openVote');
  T.clock.advance(15000);
  assert.equal(T.g.state.challenge.dareResult.result, 'valiant', 'no votes -> good try');
});

test('showdown: rival pick, called-up players, winner / tie scoring', () => {
  const T = setup({ teams: 3, perTeam: 2 });
  T.okHost('start');
  const act = T.active();
  let c = T.land(SEG.showdown);
  assert.equal(c.stage, 'pickRival');
  assert.equal(c.targets.length, 2);
  assert.equal(T.d(T.otherP(), 'pickTarget', { teamId: act }).error, 'not-your-turn');
  T.okP(T.activeP(), 'pickTarget', { teamId: T.teamIds[2] });
  c = T.g.state.challenge;
  assert.equal(c.stage, 'battle');
  assert.equal(c.rival.teamId, T.teamIds[2]);
  assert.equal(c.performer.teamId, act);
  assert.ok(T.fx.some((e) => e.type === 'calledUp' && e.playerIds.includes(c.rival.playerId)));
  const pv = publicView(T.g).challenge;
  assert.ok(pv.showdown.title && pv.showdown.winner && pv.rival.name);
  T.okHost('rerollPerformer', { side: 'rival' });
  T.okHost('showdownResult', { winner: 'tie' });
  assert.deepEqual(T.scores(), [100, 0, 100]);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  T.land(SEG.showdown);
  T.okHost('pickTarget', { teamId: T.teamIds[0] });
  T.okHost('showdownResult', { winner: 'rival' });
  assert.deepEqual(T.scores(), [300, 0, 100]);
});

test('rapid list: ticks are live, 50 each max 300, untick, other answers; hot seat: 6 questions, stale index rejected', () => {
  const T = setup({ teams: 2, perTeam: 1 });
  T.okHost('start');
  const act = T.active();
  const c = T.land(SEG.list);
  assert.equal(publicView(T.g).challenge.list.answers, undefined, 'answers hidden');
  assert.equal(T.host('listTick', { answer: 'not on the list' }).error, 'bad-answer');
  for (const a of c.list.answers.slice(0, 7)) T.okHost('listTick', { answer: a });
  assert.equal(T.host('listTick', { answer: c.list.answers[0] }).error, 'already-ticked');
  assert.equal(T.score(act), 300, 'capped at 300');
  assert.equal(publicView(T.g).challenge.list.count, 7);
  T.okHost('listUntick', { answer: c.list.answers[0] });
  T.okHost('listUntick', { answer: c.list.answers[1] });
  assert.equal(T.score(act), 250);
  T.okHost('listOther');
  assert.equal(T.score(act), 300);
  assert.ok(publicView(T.g).challenge.list.ticked.includes(OTHER_ANSWER));
  T.clock.advance(30000);
  assert.equal(T.g.state.phase, 'turnResult');
  T.okHost('listUntick', { answer: OTHER_ANSWER }); // late correction still allowed
  assert.equal(T.score(act), 250);
  T.okHost('reveal');
  assert.ok(publicView(T.g).challenge.list.answers.length >= 3);
  // hot seat
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  const act2 = T.active();
  const h = T.land(SEG.hotseat);
  assert.equal(h.hs.questions.length, 6);
  assert.ok(h.hs.questions.every((q) => isQuickQuestion(CONTENT.trivia.find((x) => x.id === q.id))));
  assert.equal(publicView(T.g).challenge.hotseat.question, null, 'question hidden until the clock starts');
  T.okHost('hotseatMark', { result: 'correct', index: 0 }); // auto-starts the clock
  assert.equal(T.g.state.timer.running, true);
  assert.equal(T.host('hotseatMark', { result: 'correct', index: 0 }).error, 'stale-question', 'double click cannot skip a question');
  assert.ok(publicView(T.g).challenge.hotseat.question);
  assert.equal(hostView(T.g, {}).host.hotseatAnswer, h.hs.questions[1].answer);
  for (let i = 1; i < 6; i++) T.okHost('hotseatMark', { result: i % 2 ? 'correct' : 'pass', index: i });
  assert.equal(T.score(act2), 200);
  assert.equal(T.g.state.phase, 'turnResult');
  assert.deepEqual(publicView(T.g).challenge.hotseat.results, ['correct', 'correct', 'pass', 'correct', 'pass', 'correct']);
});

test('sound it out: performer timer, timeout opens steal for other teams (100), hint halves', () => {
  const T = setup({ teams: 3, perTeam: 2 });
  T.okHost('start');
  const c = T.land(SEG.sound);
  assert.equal(c.points, 200);
  T.okHost('timer', { action: 'start' });
  T.clock.advance(30000);
  assert.equal(T.g.state.challenge.stage, 'steal');
  assert.equal(T.g.state.challenge.stealPoints, 100);
  T.clock.advance(3000);
  T.okP(T.otherP(0), 'buzz');
  T.okHost('judge', { result: 'correct' });
  assert.equal(T.score(T.g.state.players[T.pid(T.otherP(0))].teamId), 100);
});

test('round break with bonus question, then next round; continue semantics', () => {
  const T = setup({ teams: 5, perTeam: 1 });
  assert.equal(T.g.state.settings.roundBonus, true);
  T.okHost('setRounds', { n: 2 });
  T.okHost('start');
  for (let i = 0; i < 5; i++) { T.land(SEG.dare); T.okHost('dareResult', { result: 'valiant' }); T.okHost('nextTurn', { turnId: T.g.state.turnId }); }
  assert.equal(T.g.state.phase, 'roundBreak');
  const rb = publicView(T.g).roundBreak;
  assert.deepEqual([rb.round, rb.nextRound, rb.finalNext, rb.bonusPlanned], [1, 2, true, true]);
  T.okHost('continue');
  const c = T.g.state.challenge;
  assert.equal(c.type, 'bonus');
  assert.equal(T.g.state.phase, 'roundBreak');
  T.okP(T.players[T.teamIds[0]][0], 'submitAnswer', { text: c.q.answer });
  T.okP(T.players[T.teamIds[1]][0], 'submitAnswer', { text: 'nope' });
  T.okHost('continue'); // -> marking
  assert.equal(T.g.state.challenge.stage, 'marking');
  T.okHost('continue'); // -> reveal
  assert.equal(T.score(T.teamIds[0]), 200, 'bonus: 100, no first bonus');
  T.okHost('continue'); // -> round 2
  assert.equal(T.g.state.phase, 'turnIntro');
  assert.equal(T.g.state.round, 2);
  assert.ok(T.fx.some((e) => e.type === 'round' && e.round === 2));
});

test('every malformed payload is rejected without throwing (unit-level fuzz)', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  const rng = mulberry32(4);
  const junk = [undefined, null, 0, -1, 1e309, NaN, '', 'x'.repeat(5000), [], [1, 2], {}, { __proto__: { teamId: 't1' } }, JSON.parse('{"__proto__":{"x":1}}'), { teamId: 't1', amount: 'all' },
    { teamId: { toString: null } }, { level: ['hard'] }, { index: 99 }, { index: -1 }, { n: 3.5 }, { result: 'correct' }, { turnId: 1 }, { text: 42 }, { name: { a: 1 }, teamId: 't1' },
    { order: ['t1', 't1', 't2'] }, { order: 't1' }, { order: [{}, null, 3] }, { teamId: null }, { choice: 'good' }];
  const types = ['join', 'spin', 'pickDifficulty', 'buzz', 'pickTarget', 'previewTarget', 'submitAnswer', 'wager', 'vote', 'peek',
    'host:swapSecret', 'host:reorderTeams', 'host:shuffleTeams', 'host:soundTest',
    ...['createTeam', 'updateTeam', 'removeTeam', 'movePlayer', 'kickPlayer', 'setRounds', 'setOption', 'start', 'spin', 'forceSegment', 'judge', 'openSteal', 'reveal', 'showHint', 'timer', 'rerollPerformer', 'swapQuestion', 'dareResult', 'openVote', 'closeVote', 'showdownResult', 'listTick', 'listUntick', 'listOther', 'hotseatMark', 'markAnswer', 'revealAnswers', 'finalStartAnswering', 'finalRevealNext', 'adjustScore', 'undo', 'nextTurn', 'continue', 'pickDifficulty', 'pickTarget', 'endChallenge'].map((x) => 'host:' + x), 'host:nope', '__proto__', 'constructor', 'toString'];
  const actors = [{ role: 'host' }, { role: 'player', clientId: 'client-0-0' }, { role: 'player', clientId: 'client-1-0' }, { role: 'tv' }, null, 'host', { role: 'player' }, { role: 'player', clientId: 'x'.repeat(200) }];
  T.okHost('start');
  for (let i = 0; i < 3000; i++) {
    const r = T.g.dispatch(actors[Math.floor(rng() * actors.length)], types[Math.floor(rng() * types.length)], junk[Math.floor(rng() * junk.length)]);
    assert.equal(typeof r.ok, 'boolean');
    if (!r.ok) assert.equal(typeof r.error, 'string');
    assert.notEqual(r.error, 'server-error', 'no handler threw');
    T.clock.advance(Math.floor(rng() * 4000));
    assert.ok(T.g.state.teams.every((t) => Number.isInteger(t.score) && t.score >= 0), 'scores stay valid integers');
    if (T.g.state.phase === 'lobby' && rng() < 0.05) T.host('start');
    if (i % 50 === 0) assert.ok(hostView(T.g, {}).host.coach.headline, 'coach survives any state');
  }
  assert.doesNotThrow(() => { publicView(T.g); hostView(T.g, {}); for (const p of Object.keys(T.g.state.players)) playerView(T.g, p); });
});

test('autosave: serialize/restore mid-challenge keeps scores, identity, challenge; timers come back paused', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  T.land(SEG.christmas);
  T.okP(T.activeP(), 'pickDifficulty', { level: 'medium' });
  T.okHost('adjustScore', { teamId: T.teamIds[1], delta: 300 });
  T.clock.advance(4000);
  const saved = JSON.parse(JSON.stringify(T.g.serialize()));
  assert.equal(saved.timer.running, false);
  assert.equal(saved.timer.remainingMs, 16000);
  const T2 = setup({ teams: 0 });
  assert.equal(T2.g.restore({ v: 1 }), false);
  assert.equal(T2.g.restore(saved), true);
  assert.equal(T2.g.state.phase, 'challenge');
  assert.deepEqual(T2.g.state.teams.map((t) => t.score), [0, 300, 0]);
  assert.equal(T2.g.state.challenge.q.id, T.g.state.challenge.q.id);
  assert.equal(T2.g.playerIdForClient('client-0-0'), T.g.playerIdForClient('client-0-0'));
  assert.ok(Object.values(T2.g.state.players).every((p) => !p.connected));
  assert.equal(T2.g.state.timer.running, false);
  T2.okHost('timer', { action: 'resume' });
  T2.okHost('judge', { result: 'correct' });
  assert.equal(T2.g.state.teams[0].score, 200);
  assert.equal(T2.g.summary(saved).round, 1);
  // a spin in progress lands on restore
  T.okHost('judge', { result: 'correct' });
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  T.okHost('forceSegment', { index: SEG.list });
  const saved2 = T.g.serialize();
  const T3 = setup({ teams: 0 });
  T3.g.restore(saved2);
  assert.equal(T3.g.state.phase, 'challenge');
  assert.equal(T3.g.state.challenge.type, 'rapidlist');
  // content used-set survives (no repeats after resume)
  assert.ok(T3.g.used.has(T.g.state.challenge && T.g.state.challenge.q ? T.g.state.challenge.q.id : [...T.g.used][0]));
});

test('views: can flags, segments, spin info, players never carry clientId', () => {
  const T = setup({ teams: 2, perTeam: 1 });
  const pv0 = publicView(T.g);
  assert.equal(pv0.segments.length, 12);
  assert.deepEqual(pv0.segments.map((s) => s.type), ['trivia', 'dare', 'trivia', 'hotseat', 'trivia', 'sounditout', 'grinch', 'showdown', 'dare', 'rapidlist', 'allplay', 'doubledown']);
  // North Pole wheel: exactly the approved TV concept's slot fills, label inks and 3D slot art
  assert.deepEqual(pv0.segments.map((s) => [s.color, s.ink, s.art]), [
    ['#D42A2A', '#FFFFFF', 'tree'], ['#EDB321', '#1C2333', 'masks'], ['#2E6FD1', '#FFFFFF', 'clapper'], ['#E9558A', '#FFFFFF', 'fire'],
    ['#9E1B32', '#FFFFFF', 'popcorn'], ['#7B4BC9', '#FFFFFF', 'music'], ['#7CB518', '#1C2333', 'money'], ['#8ECAE6', '#1C2333', 'boxing'],
    ['#EDB321', '#1C2333', 'masks'], ['#1F7A4A', '#FFFFFF', 'list'], ['#F28C28', '#1C2333', 'zap'], ['#FFFFFF', '#1C2333', 'sparkles'],
  ]);
  assert.equal(pv0.segments[4].trim, undefined, 'Christmas Movies is a plain cranberry slot now');
  assert.equal(pv0.segments[11].pattern, 'candy', 'Double Down is candy-cane striped');
  assert.equal(pv0.segments[11].stripe, '#D42A2A', 'red stripes on white');
  assert.ok(pv0.segments.every((s) => s.icon && s.art && s.rule && s.lines.length));
  assert.ok(!JSON.stringify(pv0).includes('client-0-0'));
  T.okHost('start');
  const v = playerView(T.g, T.pid(T.activeP()));
  assert.deepEqual(v.can, { spin: true, pickDifficulty: false, buzz: false, pickTarget: false, previewTarget: false, submitAnswer: false, wager: false, vote: false, peek: false });
  assert.equal(v.myTeam.isActive, true);
  T.okP(T.activeP(), 'spin');
  const pv = publicView(T.g);
  assert.equal(pv.phase, 'spinning');
  assert.equal(pv.spin.durationMs, 5000);
  assert.equal(pv.spin.by.name, 'Player 00');
  assert.ok(T.fx.some((e) => e.type === 'spinStart'));
  T.clock.advance(5000);
  const pv2 = publicView(T.g);
  assert.equal(pv2.spin, null);
  assert.equal(pv2.lastSegmentIndex, T.g.state.challenge.segmentIndex);
  assert.ok(T.fx.some((e) => e.type === 'land' && e.segmentIndex === pv2.lastSegmentIndex));
  const unjoined = playerView(T.g, null);
  assert.equal(unjoined.me, null);
  assert.equal(Object.values(unjoined.can).some(Boolean), false);
  const hv = hostView(T.g, { pin: '1234', candidates: [{ address: '10.0.0.2', iface: 'Wi-Fi', score: 1 }] });
  assert.equal(hv.host.pin, '1234');
  assert.equal(hv.host.can.nextTurn, true);
  assert.equal(hv.host.can.start, false);
  assert.equal(hv.host.mascots.length, MASCOTS.length);
  assert.deepEqual(hv.host.mascots.map((m) => [m.mascot, m.color]), [
    ['deer', '#D42A2A'], ['tree', '#1F7A4A'], ['bell', '#EDB321'], ['gift', '#2E6FD1'],
    ['santa', '#7B4BC9'], ['snowman', '#F28C28'], ['cookie', '#E9558A'], ['star', '#0F8C8C'],
  ], 'mascots are the 3D art ids, each paired with a team accent that reads on white');
});

test('net: pickLanAddress skips virtual/VPN adapters, prefers Wi-Fi, honours HOST_IP', () => {
  const ifaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Tailscale': [{ family: 'IPv4', address: '100.64.1.2', internal: false }],
    'Cisco AnyConnect': [{ family: 'IPv4', address: '10.200.101.14', internal: false }],
    'Ethernet 3': [{ family: 'IPv4', address: '169.254.10.10', internal: false }],
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.23', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    'Ethernet': [{ family: 'IPv4', address: '10.0.0.9', internal: false }],
  };
  const r = pickLanAddress(ifaces, {});
  assert.equal(r.address, '192.168.1.23');
  assert.deepEqual(r.candidates.map((c) => c.address), ['192.168.1.23', '10.0.0.9']);
  assert.equal(pickLanAddress(ifaces, { HOST_IP: '10.0.0.9' }).address, '10.0.0.9');
  assert.equal(pickLanAddress({}, {}).address, 'localhost');
});

test('scheduler: bump() invalidates queued callbacks; keyed timers replace each other', () => {
  const clock = createFakeClock();
  const s = createScheduler({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const hits = [];
  s.after('a', 100, () => hits.push('a1'));
  s.after('a', 200, () => hits.push('a2'));
  s.after('b', 50, () => hits.push('b'));
  clock.advance(250);
  assert.deepEqual(hits, ['b', 'a2']);
  s.after('c', 100, () => hits.push('c'));
  s.bump();
  clock.advance(500);
  assert.deepEqual(hits, ['b', 'a2']);
});

test('timer warnings + end fx; host timer controls validate', () => {
  const T = setup({ teams: 2, perTeam: 1 });
  T.okHost('start');
  T.land(SEG.christmas);
  assert.equal(T.host('timer', { action: 'start' }).error, 'no-timer');
  T.okP(T.activeP(), 'pickDifficulty', { level: 'easy' });
  assert.equal(T.host('timer', { action: 'start' }).error, 'already-running');
  assert.equal(T.host('timer', { action: 'fly' }).error, 'bad-action');
  assert.equal(T.host('timer', { action: 'add', seconds: 0 }).error, 'bad-seconds');
  T.okHost('timer', { action: 'add' });
  assert.equal(T.g.state.timer.durationMs, 30000);
  T.clock.advance(25000);
  assert.ok(T.fx.some((e) => e.type === 'timerWarn'));
  T.clock.advance(5000);
  assert.ok(T.fx.some((e) => e.type === 'timerEnd'));
  assert.equal(T.g.state.challenge.stage, 'steal');
});

for (const n of [2, 4, 6, 8]) {
  test(`17+12. full simulated ${n}-team game reaches the podium, every segment type exercised, no secret ever public`, () => {
    const T = setup({ teams: n, perTeam: n === 8 ? 2 : 3, seed: 100 + n, scan: true });
    const seen = playFullGame(T, 200 + n);
    assert.deepEqual([...seen].sort(), ['allplay', 'dare', 'doubledown', 'grinch', 'hotseat', 'rapidlist', 'showdown', 'sounditout', 'trivia'].sort());
    const pv = publicView(T.g);
    assert.equal(pv.phase, 'podium');
    assert.equal(pv.podium.standings.length, n);
    const sorted = [...pv.podium.standings].sort((a, b) => b.score - a.score);
    assert.deepEqual(pv.podium.standings.map((s) => s.score), sorted.map((s) => s.score));
    for (const s of pv.podium.standings) assert.equal(s.place, 1 + pv.podium.standings.filter((o) => o.score > s.score).length);
    const AWARD_KEYS = ['fastestFinger', 'starPerformer', 'lumpOfCoal', 'grinchOfTheYear', 'silentNight', 'comebackKid', 'rudolph'];
    assert.ok(pv.podium.awards.length <= 6, 'at most 6 awards');
    assert.equal(new Set(pv.podium.awards.map((a) => a.key)).size, pv.podium.awards.length, 'each award once');
    for (const a of pv.podium.awards) assert.ok(AWARD_KEYS.includes(a.key) && a.title && a.name && a.detail && a.art, JSON.stringify(a));
    // comedy: quips all game long, never the same line twice in a game
    const ids = (T.ctx.quips || []).map((x) => x.id);
    assert.ok(ids.length > 15 * n / 2, `quips on the TV (${ids.length})`);
    assert.equal(new Set(ids).size, ids.length, 'a quip repeated within the game');
    assert.ok(T.fx.some((e) => e.type === 'react'), 'react cues fired');
    assert.ok(T.ctx.scans > 100, 'scanned many states');
    assert.ok(T.ctx.coachStates > 100, 'coach checked on many states');
    assert.deepEqual(T.ctx.leaks.slice(0, 5), [], 'no secrets leaked');
    assert.equal(T.g.state.round, T.g.state.settings.rounds);
  });
}

// ================================================================================================ v2.1 additions

test('Christmas Movies: slot 4, movie sub-chip once the question is shown, fallback to Christmas movie questions', () => {
  assert.equal(SEGMENTS[4].label, 'Christmas Movies');
  assert.equal(SEGMENTS[4].category, 'movies');
  assert.equal(SEGMENTS[4].color, '#9E1B32', 'Christmas Movies cranberry (TV concept)');
  assert.equal(SEGMENTS[4].art, 'popcorn');
  assert.equal(SEGMENTS[4].icon, 'popcorn');
  assert.ok(CONTENT.trivia.some((q) => q.category === 'movies' && q.movie), 'movies file loaded');
  const T = setup({ teams: 2, perTeam: 1 });
  T.okHost('start');
  const c = T.land(SEG.movies);
  assert.equal(c.category, 'movies');
  let pv = publicView(T.g);
  assert.equal(pv.challenge.categoryLabel, 'Christmas Movies');
  assert.equal(pv.challenge.movie, undefined, 'no movie before the question');
  T.okP(T.activeP(), 'pickDifficulty', { level: 'medium' });
  pv = publicView(T.g);
  assert.equal(pv.challenge.movie, T.g.state.challenge.q.movie);
  assert.ok(pv.challenge.movie);
  assert.ok(!JSON.stringify(pv).includes(esc(T.g.state.challenge.q.answer)), 'answer hidden');
  T.okHost('judge', { result: 'correct' });
  assert.equal(T.g.state.lastAwards[T.g.state.lastAwards.length - 1].reason, 'Christmas Movies');
  // without data/trivia-movies.json the slot draws Christmas questions about movies
  const noMovies = { ...CONTENT, trivia: CONTENT.trivia.filter((q) => q.category !== 'movies') };
  const T2 = setup({ teams: 2, perTeam: 1, content: noMovies });
  T2.okHost('start');
  T2.land(SEG.movies);
  T2.okP(T2.activeP(), 'pickDifficulty', { level: 'easy' });
  const q = T2.g.state.challenge.q;
  const src = noMovies.trivia.find((x) => x.id === q.id);
  assert.equal(src.category, 'christmas');
  assert.equal(src.topic, 'movies');
  // the validator rejects a movie question whose answer is in the film title (the TV shows the title)
  const bad = validateItem('trivia', { id: 'x', category: 'movies', difficulty: 'easy', movie: 'How the Grinch Stole Christmas', question: 'Who steals all the presents from Whoville?', answer: 'The Grinch' });
  assert.ok(bad.some((e) => /movie title/.test(e)));
  assert.deepEqual(validateItem('trivia', { id: 'y', category: 'movies', difficulty: 'easy', movie: 'Elf', question: 'Which actor plays Buddy?', answer: 'Will Ferrell' }), []);
  assert.equal(FILES['trivia-movies.json'], 'trivia');
});

test('matchKind: exact / match (extra words) / close (typo) / none; changed answers reset the host mark', () => {
  assert.equal(matchKind('Clarence', 'Clarence', ['Clarence Odbody']), 'exact');
  assert.equal(matchKind('clarence odbody', 'Clarence', ['Clarence Odbody']), 'exact');
  assert.equal(matchKind('CLARENCE (he got his wings!)', 'Clarence'), 'match');
  assert.equal(matchKind('paris france', 'Paris'), 'match');
  assert.equal(matchKind('clarance', 'Clarence'), 'close');
  assert.equal(matchKind('Maxx', 'Max the dog', ['Max']), 'close', 'doubled letter: close, host checks it');
  assert.equal(matchKind('Mix', 'Max the dog', ['Max']), 'none', 'too short for a typo');
  assert.equal(matchKind('Gabriel', 'Clarence'), 'none');
  assert.equal(matchKind('', 'Clarence'), 'none');
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('start');
  const c = T.land(SEG.allplay);
  const [a, b] = T.teamIds;
  T.clock.advance(3000);
  T.okP(T.players[a][0], 'submitAnswer', { text: c.q.answer });
  T.okP(T.players[b][0], 'submitAnswer', { text: 'wrong guess' });
  T.okHost('markAnswer', { teamId: b, correct: true });
  let hv = hostView(T.g);
  const sb = hv.host.submissions.find((x) => x.teamId === b);
  assert.equal(sb.override, true);
  assert.equal(sb.preview, 100);
  const sa = hv.host.submissions.find((x) => x.teamId === a);
  assert.equal(sa.match, 'exact');
  assert.equal(sa.elapsedMs, 3000);
  assert.equal(sa.first, true);
  assert.equal(sa.preview, 150, '100 + 50 first');
  assert.equal(hv.host.payout, sa.preview + sb.preview);
  T.okP(T.players[b][0], 'submitAnswer', { text: 'another guess' });
  hv = hostView(T.g);
  assert.equal(hv.host.submissions.find((x) => x.teamId === b).override, null, 'a changed answer resets the mark');
});

test('new player events: previewTarget (TV "eyeing"), peek (host sees it), vote change; new host events: swapSecret, reorder/shuffle, soundTest', () => {
  const T = setup({ teams: 3, perTeam: 2 });
  // lobby: reorder + shuffle teams, sound test
  const [t1, t2, t3] = T.teamIds;
  T.okHost('reorderTeams', { order: [t3, t1, t2] });
  assert.deepEqual(T.g.state.teams.map((t) => t.id), [t3, t1, t2]);
  assert.equal(T.host('reorderTeams', { order: [t3, t1] }).error, 'bad-order');
  assert.equal(T.host('reorderTeams', { order: [t3, t3, t1] }).error, 'bad-order');
  T.okHost('shuffleTeams');
  assert.notDeepEqual(T.g.state.teams.map((t) => t.id), [t3, t1, t2], 'shuffle always changes the order');
  assert.deepEqual(T.g.state.teams.map((t) => t.id).sort(), [t1, t2, t3].sort(), 'same teams, stable ids');
  T.okHost('soundTest');
  assert.ok(T.fx.some((e) => e.type === 'soundTest'));
  T.okHost('start');
  assert.equal(T.host('shuffleTeams').error, 'not-now');
  assert.equal(T.host('reorderTeams', { order: T.g.state.teams.map((t) => t.id) }).error, 'not-now');
  // grinch: previewTarget shows who is being eyed; only the active team; cleared on pick
  T.setScores([0, 300, 500]);
  const act = T.active();
  T.land(SEG.grinch);
  const target = T.g.state.challenge.targets[0];
  assert.equal(T.d(T.otherP(), 'previewTarget', { teamId: target }).error, 'not-your-turn');
  assert.equal(T.d(T.activeP(), 'previewTarget', { teamId: act }).error, 'bad-target');
  assert.equal(playerView(T.g, T.pid(T.activeP())).can.previewTarget, true);
  T.okP(T.activeP(), 'previewTarget', { teamId: target });
  let pv = publicView(T.g);
  assert.equal(pv.challenge.eyeing.teamId, target);
  assert.equal(pv.challenge.eyeing.by.playerId, T.pid(T.activeP()));
  T.okP(T.activeP(), 'previewTarget', { teamId: null });
  assert.equal(publicView(T.g).challenge.eyeing, null);
  T.okP(T.activeP(), 'pickTarget', { teamId: target });
  assert.equal(publicView(T.g).challenge.eyeing, null);
  T.next();
  // sound it out: only the performer can peek; host sees it; swapSecret swaps the song and keeps the performer
  const c = T.land(SEG.sound);
  const perf = c.performer.playerId;
  const perfActor = T.players[T.active()].find((a) => T.pid(a) === perf);
  const other = T.players[T.active()].find((a) => T.pid(a) !== perf);
  assert.equal(T.d(other, 'peek').error, 'no-secret');
  assert.equal(playerView(T.g, perf).can.peek, true);
  assert.equal(hostView(T.g).host.secretPeeked, false);
  assert.deepEqual(T.okP(perfActor, 'peek'), { ok: true, first: true });
  assert.deepEqual(T.okP(perfActor, 'peek'), { ok: true, first: false });
  assert.equal(hostView(T.g).host.secretPeeked, true);
  assert.equal(JSON.stringify(publicView(T.g)).includes('secretPeeked'), false, 'peek state is host-only');
  const song = c.song.title;
  T.okHost('swapSecret');
  assert.notEqual(T.g.state.challenge.song.title, song);
  assert.equal(T.g.state.challenge.performer.playerId, perf, 'same performer');
  assert.equal(hostView(T.g).host.secretPeeked, false, 'new secret, not peeked yet');
  T.next();
  // dare with a secret: swapSecret picks another option; swapQuestion (Swap dare) keeps the performer
  let d = T.land(SEG.dare);
  for (let i = 0; i < 40 && !(d.secretValue && d.dare.secret.options.length > 1); i++) { T.okHost('swapQuestion'); d = T.g.state.challenge; }
  assert.ok(d.secretValue, 'found a dare with a secret');
  const p0 = d.performer.playerId;
  const v0 = d.secretValue;
  T.okHost('swapSecret');
  assert.notEqual(T.g.state.challenge.secretValue, v0);
  T.okHost('swapQuestion');
  assert.equal(T.g.state.challenge.performer.playerId, p0, 'Swap dare keeps the performer');
  // vote change
  T.okHost('timer', { action: 'start' });
  T.okHost('openVote');
  const voter = T.otherP();
  T.okP(voter, 'vote', { choice: 'good' });
  T.okP(voter, 'vote', { choice: 'nailed' });
  pv = publicView(T.g);
  assert.deepEqual([pv.challenge.vote.nailed, pv.challenge.vote.good, pv.challenge.vote.voters], [1, 0, 1]);
  assert.equal(playerView(T.g, T.pid(voter)).myVote, 'nailed');
});

test('public extras: lastSpin, firstTime, hot seat banked, round-break standings with movement, final max wager', () => {
  const T = setup({ teams: 3, perTeam: 1 });
  T.okHost('setRounds', { n: 3 });
  T.okHost('start');
  T.okP(T.activeP(), 'spin');
  T.clock.advance(5000);
  let pv = publicView(T.g);
  assert.equal(pv.lastSpin.teamId, T.teamIds[0]);
  assert.equal(pv.lastSpin.by.name, 'Player 00');
  assert.equal(pv.lastSpin.segmentIndex, pv.lastSegmentIndex);
  assert.equal(pv.challenge.firstTime, true);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  const hs = T.land(SEG.hotseat);
  T.okHost('hotseatMark', { result: 'correct', index: 0 });
  T.okHost('hotseatMark', { result: 'wrong', index: 1 });
  T.okHost('hotseatMark', { result: 'correct', index: 2 });
  assert.equal(publicView(T.g).challenge.hotseat.banked, 100);
  assert.ok(hs.performer);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  T.land(SEG.hotseat);
  assert.equal(publicView(T.g).challenge.firstTime, false, 'second Hot Seat is not the first');
  T.okHost('endChallenge');
  T.setScores([100, 300, 200]);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  assert.equal(T.g.state.phase, 'roundBreak');
  pv = publicView(T.g);
  assert.deepEqual(pv.roundBreak.standings.map((s) => [s.teamId, s.rank, s.move]), [[T.teamIds[1], 1, null], [T.teamIds[2], 2, null], [T.teamIds[0], 3, null]]);
  assert.equal(pv.roundBreak.leadBy, 100);
  T.okHost('continue');
  for (let i = 0; i < 3; i++) { T.land(SEG.dare); T.okHost('dareResult', { result: 'fail' }); if (i < 2) T.okHost('nextTurn', { turnId: T.g.state.turnId }); }
  T.setScores([500, 300, 200]);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  assert.equal(T.g.state.phase, 'roundBreak');
  pv = publicView(T.g);
  const st = Object.fromEntries(pv.roundBreak.standings.map((s) => [s.teamId, s]));
  assert.deepEqual([st[T.teamIds[0]].move, st[T.teamIds[0]].places], ['up', 2]);
  assert.equal(st[T.teamIds[1]].move, 'down');
  assert.equal(st[T.teamIds[2]].move, 'down');
  assert.equal(pv.roundBreak.finalNext, true);
  // final: max wager is public, amount is not
  T.okHost('continue');
  for (let i = 0; i < 3; i++) { T.land(SEG.dare); T.okHost('dareResult', { result: 'fail' }); T.okHost('nextTurn', { turnId: T.g.state.turnId }); }
  assert.equal(T.g.state.phase, 'finalIntro');
  T.okHost('continue');
  assert.equal(T.g.state.phase, 'finalWager');
  pv = publicView(T.g);
  assert.deepEqual(pv.final.wagers.map((w) => w.max), T.g.state.teams.map((t) => Math.max(300, t.score)));
});

test('coach: right words and buttons per stage; dare judging unlocks with the timer; say never contains the answer', () => {
  const T = setup({ teams: 3, perTeam: 2 });
  const coach = (ex) => hostView(T.g, ex || { connections: { tv: 0, hosts: 1 } }).host.coach;
  const ids = (co) => co.actions.map((a) => a.id);
  let co = coach();
  assert.equal(co.primary, 'start');
  assert.ok(co.tips.some((t) => /TV screen/.test(t)), 'TV not connected tip');
  assert.ok(co.say.includes('Scan the code'));
  assert.ok(ids(co).includes('introScript'));
  assert.equal(co.actions.find((a) => a.id === 'introScript').local, 'introScript');
  const intro = hostView(T.g).host.introScript;
  assert.ok(intro.sections.length >= 5 && intro.words > 100 && intro.text.includes('Christmas Chaos'));
  for (const s of SEGMENTS) assert.ok(intro.text.includes(s.label), 'script names ' + s.label);
  assert.ok(intro.summary.includes('Team 1'));
  T.okHost('start');
  assert.equal(hostView(T.g).host.introScript, null);
  co = coach();
  assert.match(co.headline, /Team 1 is up/);
  assert.ok(ids(co).includes('spinFor') && ids(co).includes('skipTurn'));
  assert.equal(co.progress[0].state, 'current');
  // trivia
  T.land(SEG.christmas);
  co = coach();
  assert.deepEqual(ids(co).filter((x) => x.startsWith('pick-')), ['pick-easy', 'pick-medium', 'pick-hard']);
  assert.ok(co.tips.some((t) => /First Christmas Trivia/.test(t)));
  T.okHost('pickDifficulty', { level: 'hard' });
  co = coach();
  const q = T.g.state.challenge.q;
  assert.ok(co.say.startsWith(q.question));
  assert.ok(!co.say.includes(q.answer));
  assert.equal(co.primary, 'correct');
  assert.equal(co.actions.find((a) => a.id === 'correct').shortcut, 'C');
  assert.equal(co.actions.find((a) => a.id === 'wrong').shortcut, 'W');
  assert.equal(!!co.actions.find((a) => a.id === 'hint').disabled, !q.hint);
  assert.deepEqual(co.progress.map((p) => p.state), ['done', 'done', 'current', 'todo', 'todo']);
  T.okHost('judge', { result: 'wrong' });
  co = coach();
  assert.match(co.headline, /arm/);
  T.clock.advance(3000);
  co = coach();
  assert.match(co.headline, /waiting for a buzz/);
  T.okP(T.otherP(0), 'buzz');
  co = coach();
  assert.match(co.headline, /buzzed first/);
  T.okHost('judge', { result: 'wrong' });
  co = coach();
  assert.equal(co.primary, 'reopen');
  T.okHost('reveal');
  co = coach();
  assert.equal(T.g.state.phase, 'turnResult');
  assert.equal(co.primary, 'nextTurn');
  assert.ok(co.say.includes(q.answer), 'after the reveal the host reads the answer');
  assert.deepEqual(co.actions.find((a) => a.id === 'nextTurn').payload, { turnId: T.g.state.turnId });
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  // dare: judging unlocks when the timer starts
  const d = T.land(SEG.dare);
  co = coach();
  assert.equal(co.primary, 'timerStart');
  for (const id of ['nailed', 'valiant', 'fail', 'vote']) {
    const a = co.actions.find((x) => x.id === id);
    assert.equal(a.disabled, true, id);
    assert.equal(a.reason, 'Unlocks when the timer starts');
  }
  if (d.secretValue) assert.ok(!co.say.includes(d.secretValue), 'dare secret never read out');
  T.okHost('timer', { action: 'start' });
  co = coach();
  assert.equal(co.primary, 'nailed');
  assert.equal(co.actions.find((a) => a.id === 'nailed').disabled, undefined);
  T.okHost('dareResult', { result: 'nailed' });
  co = coach();
  assert.ok(ids(co).includes('crowd'));
  T.okHost('dareResult', co.actions.find((a) => a.id === 'crowd').payload);
  assert.equal(T.g.state.challenge.dareResult.bonus, true);
  T.okHost('nextTurn', { turnId: T.g.state.turnId });
  // double down: tip about x2
  T.land(SEG.doubledown);
  co = coach();
  assert.ok(co.tips.some((t) => /Double Down active/.test(t)));
  // sound it out: the song title never appears in the coach
  T.okHost('forceSegment', { index: SEG.sound });
  T.clock.advance(5000);
  co = coach();
  assert.ok(!JSON.stringify(co).includes(T.g.state.challenge.song.title));
  assert.equal(co.primary, 'timerStart');
});

test('coach-driven game: pressing only the coach’s buttons (and phones doing what they show) reaches the podium', () => {
  for (const [teams, seed] of [[2, 5], [4, 6], [6, 7]]) {
    const T = setup({ teams, perTeam: 2, seed });
    const { g, clock, players, teamIds } = T;
    const rng = mulberry32(seed * 31);
    const pickOne = (arr) => arr[Math.floor(rng() * arr.length)];
    const all = teamIds.flatMap((t) => players[t]);
    const done = new Set();
    const types = new Set();
    let presses = 0;
    for (let step = 0; step < 6000 && g.state.phase !== 'podium'; step++) {
      const S = g.state;
      if (S.challenge) types.add(S.challenge.type);
      // phones first: each phone does what its screen offers (once)
      let acted = false;
      for (const a of all.slice().sort(() => rng() - 0.5)) {
        const v = playerView(g, T.pid(a));
        const key = (k) => `${S.turnId}|${S.phase}|${S.challenge ? S.challenge.id + S.challenge.stage : ''}|${a.clientId}|${k}`;
        const once = (k, payload) => { if (done.has(key(k))) return false; done.add(key(k)); return g.dispatch(a, k, payload).ok; };
        const answer = () => (S.phase === 'finalAnswer' ? S.final.q.answer : S.challenge && S.challenge.q ? S.challenge.q.answer : 'x');
        if (v.can.spin && rng() < 0.6 && once('spin', {})) acted = true;
        else if (v.can.pickDifficulty && once('pickDifficulty', { level: pickOne(['easy', 'medium', 'hard']) })) acted = true;
        else if (v.can.pickTarget && once('pickTarget', { teamId: pickOne(v.challenge.targets) })) acted = true;
        else if (v.can.submitAnswer && !v.myTeam.submission && once('submitAnswer', { text: rng() < 0.5 ? answer() : 'no idea' })) acted = true;
        else if (v.can.wager && !(v.myTeam.wager && v.myTeam.wager.by) && once('wager', { amount: Math.floor(rng() * (v.myTeam.maxWager + 1)) })) acted = true;
        else if (v.can.vote && !v.myVote && once('vote', { choice: rng() < 0.6 ? 'nailed' : 'good' })) acted = true;
        else if (v.can.buzz && rng() < 0.5 && once('buzz', {})) acted = true;
        if (acted) break;
      }
      if (acted) continue;
      if (S.spin || (S.challenge && S.challenge.buzz && S.challenge.buzz.armingUntil)) { clock.advance(1000); continue; }
      if (S.timer && S.timer.running && rng() < 0.2) { clock.advance(S.timer.endsAt - clock.now()); continue; }
      // the host presses the coach's primary button, sometimes another one it offers (never a confirm-guarded one)
      const co = hostView(g, { connections: { tv: 1, hosts: 1 } }).host.coach;
      const usable = co.actions.filter((x) => !x.disabled && x.event && !x.confirm);
      let a = co.actions.find((x) => x.id === co.primary);
      if (!a || rng() < 0.3) a = usable.length ? pickOne(usable) : a;
      if (!a) { clock.advance(1000); continue; }
      const r = g.dispatch({ role: 'host' }, a.event, a.payload || {});
      assert.equal(r.ok, true, `coach action ${a.id} (${a.event}) rejected: ${r.error} in ${S.phase}/${S.challenge && S.challenge.stage}`);
      presses++;
    }
    assert.equal(g.state.phase, 'podium', `${teams}-team coach-driven game reached ${g.state.phase}`);
    assert.ok(presses > 20);
    assert.ok(types.size >= 5, 'several mini-games were played');
    const co = hostView(g).host.coach;
    assert.match(co.headline, /Christmas/);
    assert.equal(co.primary, 'playAgain');
  }
});

// ================================================================================================ comedy layer (COMEDY.md)

/** A synthetic quip bank whose lines show exactly which value went into which placeholder ("#n" = line number). */
function testBank(extra = {}) {
  const mk = (key, tpl, n = 6) => Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}`, text: `${tpl} #${i}`, tone: 'cheer' }));
  const b = {
    lobbyIdle: mk('lobbyIdle', 'lobby', 2), gameStart: mk('gameStart', 'start'), turnIntro: mk('turnIntro', 'up: {team}', 12),
    spinStart: mk('spinStart', 'spin: {player}', 12), 'land.trivia': mk('land.trivia', 'land: {team} at {segment}'),
    pickEasy: mk('pickEasy', 'easy: {team} for {points}'), pickMedium: mk('pickMedium', 'medium: {team} for {points}'), pickHard: mk('pickHard', 'hard: {team} for {points}'),
    correct: mk('correct', 'right: {team} +{points} ({answer})'), correctHard: mk('correctHard', 'hard right: {team} +{points}'),
    wrong: mk('wrong', 'wrong: {team}'), wrongEasy: mk('wrongEasy', 'easy miss: {team}'), timeUp: mk('timeUp', 'time: {team}'),
    stealOpen: mk('stealOpen', 'steal open'), stealWon: mk('stealWon', 'stole: {team} took {points} from {other}'),
    stealMissed: mk('stealMissed', 'steal miss: {team}'), nobodyBuzzed: mk('nobodyBuzzed', 'silence'),
    grinchSteal: mk('grinchSteal', 'grinch: {team} took {points} from {other}'), leadChange: mk('leadChange', 'lead: {leader} over {other}'),
    dareNailed: mk('dareNailed', 'nailed: {player} of {team}'), dareFail: mk('dareFail', 'fail: {player} of {team}'), undo: mk('undo', 'undo'),
    roundBreak: mk('roundBreak', 'break: {leader} / {last}'), finalAllIn: mk('finalAllIn', 'all in: {team} {points}'), finalZeroBet: mk('finalZeroBet', 'zero: {team}'),
    finalCorrect: mk('finalCorrect', 'final right: {team} said {answer}'), finalWrong: mk('finalWrong', 'final wrong: {team}'), podium: mk('podium', 'winner: {leader}'),
  };
  return { ...b, ...extra };
}
const lastReact = (T) => [...T.fx].reverse().find((e) => e.type === 'react') || null;

test('comedy: quips.json loads + validates; a missing file is an empty bank and a game without quips still runs', () => {
  assert.ok(Object.keys(CONTENT.quips).length >= 40, 'quip bank loaded');
  for (const key of QUIP_KEYS) assert.ok((CONTENT.quips[key] || []).length >= 6, `${key} has at least 6 lines`);
  for (const [key, lines] of Object.entries(CONTENT.quips)) {
    assert.ok(QUIP_KEYS.includes(key), key);
    for (const l of lines) {
      assert.deepEqual(validateQuip(key, l), [], `${key} ${l.id}`);
      if (l.text.includes('{answer}')) assert.ok(QUIP_ANSWER_KEYS.includes(key), `${l.id}: {answer} outside the answer moments`);
    }
  }
  assert.ok(validateQuip('wrong', { id: 'x', text: 'It was {answer}!' }).some((e) => /answer/.test(e)), '{answer} only in correct/correctHard/finalCorrect');
  assert.ok(validateQuip('correct', { id: 'x', text: 'Hi {santa}' }).some((e) => /placeholder/.test(e)));
  assert.ok(validateQuip('correct', { id: 'x', text: 'ok', tone: 'loud' }).length > 0);
  assert.deepEqual(validateQuip('correct', { id: 'x', text: '{team} got {answer}!', tone: 'cheer' }), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-quips-'));
  const problems = [];
  assert.deepEqual(loadQuips(dir, problems), {}, 'missing file = empty bank');
  assert.deepEqual(problems, [], 'a missing quips file is not a content problem');
  fs.writeFileSync(path.join(dir, 'quips.json'), JSON.stringify({ correct: [{ id: 'c1', text: 'Yes {team}!' }, { id: 'c1', text: 'dup' }, { id: 'c2', text: 'bad {nope}' }], wrong: 'nope', mystery: [] }));
  const bank = loadQuips(dir, problems);
  assert.deepEqual(bank.correct.map((l) => l.id), ['c1']);
  assert.equal(bank.wrong, undefined);
  assert.equal(problems.length, 4, JSON.stringify(problems));
  fs.writeFileSync(path.join(dir, 'quips.json'), '{broken');
  const p2 = [];
  assert.deepEqual(loadQuips(dir, p2), {});
  assert.equal(p2.length, 1);
  // a whole game with no quip bank: the quip stays null, react cues still fire, nothing breaks
  const T = setup({ content: { ...CONTENT, quips: {} }, teams: 2, perTeam: 1, scan: true });
  playFullGame(T, 9);
  assert.equal(publicView(T.g).quip, null);
  assert.equal((T.ctx.quips || []).length, 0);
  assert.ok(T.fx.some((e) => e.type === 'react' && e.quipId === null));
  assert.deepEqual(T.ctx.leaks.slice(0, 3), []);
});

test('comedy: quips land on the right moments with the right names; cleared between moments; react moods; coach punchline', () => {
  const T = setup({ content: { ...CONTENT, quips: testBank() }, teams: 3, perTeam: 2, seed: 21 });
  const { g, clock, okHost, okP, players, teamIds } = T;
  const [A, B, C] = teamIds;
  const q = () => publicView(g).quip;
  const coach = () => hostView(g, { connections: { tv: 1, hosts: 1 } }).host.coach;
  const seen = [];
  const note = () => { const x = q(); if (x) seen.push(x.id); return x; };
  assert.equal(note().key, 'lobbyIdle');
  okHost('setRounds', { n: 2 });
  okHost('start');
  assert.match(note().text, /^start #\d$/);
  // the host spins for Team 1: {player} = the team
  okHost('forceSegment', { index: SEG.christmas });
  assert.match(note().text, /^spin: Team 1 #\d+$/);
  clock.advance(g.timing.spinMs);
  assert.match(note().text, /^land: Team 1 at Christmas Trivia #\d$/);
  okP(T.activeP(), 'pickDifficulty', { level: 'hard' });
  assert.match(note().text, /^hard: Team 1 for 300 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).key], ['gasp', 'pickHard']);
  okHost('judge', { result: 'correct' });
  assert.match(note().text, /^hard right: Team 1 \+300 #\d$/);
  let r = lastReact(T);
  assert.deepEqual([r.type, r.mood, r.teamId, r.key, r.quipId], ['react', 'cheer', A, 'correctHard', q().id]);
  assert.equal(q().teamId, A);
  // coach: the quip is the suggested punchline, with a stage direction
  let co = coach();
  assert.deepEqual(co.punchline, { id: q().id, key: 'correctHard', text: q().text, cue: '(point at Team 1)' });
  assert.ok(co.say.endsWith(`(point at Team 1) “${q().text}”`), co.say);
  assert.ok(co.say.startsWith('The answer:'), 'the answer line still comes first');
  okHost('nextTurn', { turnId: g.state.turnId });
  // Team 1 leads now, but there was no previous leader for {other}: the turn intro line is used, the react still fires
  assert.match(note().text, /^up: Team 2 #\d+$/);
  r = lastReact(T);
  assert.deepEqual([r.mood, r.key, r.teamId], ['gasp', 'leadChange', A]);
  // a player spins: {player} = the spinner
  okP(T.activeP(), 'spin');
  assert.equal(note().text.replace(/ #\d+$/, ''), 'spin: Player 10');
  g.state.spin.segmentIndex = SEG.christmas; // (test) make this random spin land on Christmas Trivia
  clock.advance(g.timing.spinMs);
  assert.equal(g.state.challenge.type, 'trivia');
  okP(T.activeP(), 'pickDifficulty', { level: 'easy' });
  assert.deepEqual([lastReact(T).mood, lastReact(T).key], ['laugh', 'pickEasy']);
  okHost('judge', { result: 'wrong' });
  assert.match(note().text, /^easy miss: Team 2 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).teamId, lastReact(T).key], ['groan', B, 'wrongEasy']);
  co = coach();
  assert.ok(co.tips.some((t) => /Tease the play, never the person/.test(t)), 'playful tip');
  assert.ok(co.say.includes('(slow head shake)'));
  clock.advance(g.timing.armMs);
  assert.match(note().text, /^steal open #\d$/);
  okP(players[C][0], 'buzz');
  assert.equal(q(), null, 'a buzz is a new moment: the old quip is cleared');
  assert.equal(coach().punchline, null);
  okHost('judge', { result: 'correct' });
  assert.match(note().text, /^stole: Team 3 took 50 from Team 2 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).teamId, lastReact(T).key], ['gasp', C, 'stealWon']);
  okHost('nextTurn', { turnId: g.state.turnId });
  assert.match(note().text, /^up: Team 3 #\d+$/, 'same leader: a plain turn intro');
  // Grinch Steal: {team} = the thief, {other} = the victim; then the host undoes it
  T.land(SEG.grinch);
  okP(players[C][0], 'pickTarget', { teamId: A });
  assert.match(note().text, /^grinch: Team 3 took 150 from Team 1 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).teamId], ['gasp', C]);
  okHost('undo');
  assert.match(note().text, /^undo #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).key], ['laugh', 'undo']);
  assert.deepEqual(T.scores(), [300, 0, 50]);
  // round break: Team 1 leads, Team 2 is far behind -> the pep talk (no lastPlaceCheer lines here -> the roundBreak line)
  okHost('nextTurn', { turnId: g.state.turnId });
  assert.equal(g.state.phase, 'roundBreak');
  assert.match(note().text, /^break: Team 1 \/ Team 2 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).key, lastReact(T).teamId], ['cheer', 'lastPlaceCheer', B]);
  okHost('continue');
  assert.match(note().text, /^up: Team 1 #\d+$/);
  // time up, then nobody buzzes
  T.land(SEG.christmas);
  okP(T.activeP(), 'pickDifficulty', { level: 'medium' });
  clock.advance(g.timing.triviaMs);
  assert.match(note().text, /^time: Team 1 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).key], ['groan', 'timeUp']);
  clock.advance(g.timing.armMs);
  clock.advance(g.timing.stealMs);
  assert.match(note().text, /^silence #\d$/);
  assert.equal(lastReact(T).key, 'nobodyBuzzed');
  okHost('nextTurn', { turnId: g.state.turnId });
  // a failed dare gets a laugh; {player} = the performer(s) (or the team for a team dare)
  const d = T.land(SEG.dare);
  okHost('timer', { action: 'start' });
  okHost('dareResult', { result: 'fail' });
  const who = d.dare.who === 'team' || d.dare.who === 'everyone' ? 'Team 2' : [d.performer, d.partner].filter(Boolean).map((x) => x.name).join(' and ');
  assert.equal(note().text.replace(/ #\d$/, ''), `fail: ${who} of Team 2`);
  assert.deepEqual([lastReact(T).mood, lastReact(T).key], ['laugh', 'dareFail']);
  okHost('dareResult', { result: 'fail', bonus: true });
  assert.equal(q().key, 'dareFail', 'the crowd-favourite toggle is not a new verdict');
  okHost('nextTurn', { turnId: g.state.turnId });
  okHost('nextTurn', { turnId: g.state.turnId }); // Team 3 skips: Final Chaos
  assert.equal(g.state.phase, 'finalIntro');
  assert.equal(q(), null, 'no finalIntro lines in this bank');
  okHost('continue');
  okP(players[B][0], 'wager', { amount: 300 }); // 0 points: 300 is all in
  okP(players[C][0], 'wager', { amount: 0 });
  okP(players[A][0], 'wager', { amount: 100 });
  assert.equal(q(), null, 'wagers stay secret: no all-in quip before the reveal');
  okHost('finalStartAnswering');
  const ans = g.state.final.q.answer;
  okP(players[B][0], 'submitAnswer', { text: ans.toUpperCase() });
  okP(players[C][0], 'submitAnswer', { text: 'certainly not that' });
  okP(players[A][0], 'submitAnswer', { text: ans });
  okHost('continue');
  assert.deepEqual(g.state.final.order, [B, C, A]);
  okHost('finalRevealNext');
  assert.match(note().text, /^all in: Team 2 300 #\d$/);
  assert.deepEqual([lastReact(T).mood, lastReact(T).key], ['gasp', 'finalAllIn']);
  okHost('finalRevealNext');
  // not every row is judged yet: {answer} is this team's own (revealed) text, never the official answer
  assert.equal(note().text.replace(/ #\d$/, ''), `final right: Team 2 said ${ans.toUpperCase()}`);
  if (ans.toUpperCase() !== ans) assert.ok(!q().text.includes(ans));
  okHost('finalRevealNext');
  assert.match(note().text, /^zero: Team 3 #\d$/);
  okHost('finalRevealNext');
  assert.match(note().text, /^final wrong: Team 3 #\d$/);
  okHost('finalRevealNext');
  assert.equal(q(), null, 'a plain wager: no quip, the old one is cleared');
  okHost('finalRevealNext');
  assert.equal(note().text.replace(/ #\d$/, ''), `final right: Team 1 said ${ans}`, 'last row: the official answer is public now');
  okHost('finalRevealNext');
  assert.equal(g.state.phase, 'podium');
  assert.match(note().text, /^winner: Team 1 #\d$/);
  assert.equal(new Set(seen).size, seen.length, 'no line twice in one game');
  for (const e of T.fx.filter((x) => x.type === 'react')) assert.ok(['cheer', 'groan', 'gasp', 'laugh'].includes(e.mood) && typeof e.key === 'string', JSON.stringify(e));
});

test('comedy: never the same line twice in a game (falls back, then nothing); {answer} never fills outside the answer moments', () => {
  const bank = testBank({ correct: [{ id: 'only', text: 'only {team}' }], correctHard: [] });
  const T = setup({ content: { ...CONTENT, quips: bank }, teams: 2, perTeam: 1 });
  const { g, okHost } = T;
  okHost('start');
  const right = (level) => { T.land(SEG.christmas); okHost('pickDifficulty', { level }); okHost('judge', { result: 'correct' }); return publicView(g).quip; };
  assert.equal(right('hard').id, 'only', 'correctHard has no lines: falls back to correct');
  okHost('nextTurn', { turnId: g.state.turnId });
  assert.equal(right('easy'), null, 'the only correct line was used: no repeat, no quip');
  assert.equal(lastReact(T).key, 'correct', 'the react cue still fires');
  okHost('resetGame', { keepTeams: true });
  okHost('start');
  assert.equal(right('easy').id, 'only', 'a new game may use it again');
  // a bank that bypasses the loader: {answer} in a moment that must not name it never fills
  const T2 = setup({ content: { ...CONTENT, quips: { wrong: [{ id: 'w', text: 'it was {answer}' }], correct: [{ id: 'c', text: 'yes, {answer}' }] } }, teams: 2, perTeam: 1 });
  T2.okHost('start');
  T2.land(SEG.christmas);
  T2.okHost('pickDifficulty', { level: 'easy' });
  T2.okHost('judge', { result: 'wrong' });
  assert.equal(publicView(T2.g).quip, null);
  T2.okHost('reveal');
  T2.okHost('nextTurn', { turnId: T2.g.state.turnId });
  T2.land(SEG.christmas);
  T2.okHost('pickDifficulty', { level: 'easy' });
  const qq = T2.g.state.challenge.q;
  assert.ok(!JSON.stringify(publicView(T2.g)).includes(esc(qq.answer)));
  T2.okHost('judge', { result: 'correct' });
  assert.equal(publicView(T2.g).quip.text, `yes, ${qq.answer}`, 'filled once revealed');
});

test('comedy: result variants (hot seat perfect/zero, rapid list big/small, showdown, gift, Double Down, close vote, lead change)', () => {
  const T = setup({ teams: 3, perTeam: 2, seed: 33 });
  const { g, clock, okHost, okP, players, teamIds } = T;
  const [A, B, C] = teamIds;
  const q = () => publicView(g).quip;
  const nextT = () => { okHost('nextTurn', { turnId: g.state.turnId }); for (let i = 0; i < 3 && g.state.phase === 'roundBreak'; i++) okHost('continue'); };
  okHost('setRounds', { n: 6 });
  okHost('start');
  // Team 1: a perfect Hot Seat
  let c = T.land(SEG.hotseat);
  okHost('timer', { action: 'start' });
  while (g.state.challenge.stage === 'hotseat') okHost('hotseatMark', { result: 'correct', index: g.state.challenge.hs.index });
  assert.equal(c.hs.results.length, 6);
  assert.equal(q().key, 'hotseatPerfect');
  assert.deepEqual([lastReact(T).mood, lastReact(T).teamId], ['cheer', A]);
  nextT();
  // Team 2: zero
  T.land(SEG.hotseat);
  okHost('timer', { action: 'start' });
  while (g.state.challenge.stage === 'hotseat') okHost('hotseatMark', { result: 'wrong', index: g.state.challenge.hs.index });
  assert.equal(q().key, 'hotseatZero');
  assert.equal(lastReact(T).mood, 'groan');
  nextT();
  // Team 3: a big list (5 ticks)
  c = T.land(SEG.list);
  okHost('timer', { action: 'start' });
  for (const a of c.list.answers.slice(0, 5)) okHost('listTick', { answer: a });
  okHost('continue');
  assert.equal(q().key, 'listBig');
  nextT();
  // Team 1: a small list (1 tick, time runs out)
  c = T.land(SEG.list);
  okHost('timer', { action: 'start' });
  okHost('listTick', { answer: c.list.answers[0] });
  clock.advance(g.timing.listMs);
  assert.equal(q().key, 'listSmall');
  nextT();
  // Team 2: showdown won by the rival (Team 3): {team} = the winner, the react goes to the winner
  T.land(SEG.showdown);
  okP(T.activeP(), 'pickTarget', { teamId: C });
  okHost('timer', { action: 'start' });
  okHost('showdownResult', { winner: 'rival' });
  assert.equal(q().key, 'showdownWin');
  assert.equal(q().teamId, C);
  assert.deepEqual([lastReact(T).mood, lastReact(T).teamId], ['cheer', C]);
  nextT();
  // Team 3 leads: the Grinch's heart grows -> gift to last place
  T.setScores([300, 0, 550]);
  c = T.land(SEG.grinch);
  assert.ok(c.gift);
  assert.equal(q().key, 'grinchGift');
  assert.deepEqual([lastReact(T).mood, lastReact(T).teamId], ['cheer', c.gift.toTeamId]);
  nextT();
  // Team 1: Double Down, then a right answer -> the doubled line
  T.land(SEG.doubledown);
  assert.equal(q().key, 'land.doubledown');
  okHost('forceSegment', { index: SEG.pop });
  clock.advance(g.timing.spinMs);
  assert.equal(q().key, 'land.popculture');
  okHost('pickDifficulty', { level: 'easy' });
  okHost('judge', { result: 'correct' });
  assert.equal(q().key, 'doubleDown');
  assert.equal(lastReact(T).key, 'doubleDown');
  nextT();
  // Team 2: a dare with a neck-and-neck room vote
  T.land(SEG.dare);
  okHost('timer', { action: 'start' });
  okHost('openVote');
  okP(players[A][0], 'vote', { choice: 'nailed' });
  okP(players[C][0], 'vote', { choice: 'good' });
  assert.equal(q().key, 'voteClose');
  assert.equal(lastReact(T).mood, 'gasp');
  okP(players[A][1], 'vote', { choice: 'nailed' });
  okP(players[C][1], 'vote', { choice: 'nailed' }); // everyone voted: it closes as nailed
  assert.equal(q().key, 'dareNailed');
  // a lead change with a previous leader: Team 2 jumps over Team 3 by the next turn intro
  T.setScores([100, 900, 550]);
  nextT();
  assert.equal(q().key, 'leadChange');
  assert.equal(q().teamId, B);
  assert.ok(q().text.includes('Team 2'));
});

test('comedy: funny awards from a scripted game (stats per player and team, only when earned, ceremony order)', () => {
  const T = setup({ teams: 3, perTeam: 2, seed: 11 });
  const { g, clock, okHost, okP, players, teamIds, pid } = T;
  const [A, B, C] = teamIds;
  okHost('kickPlayer', { playerId: pid(players[C][1]) }); // Team 3 is one player: c0
  const c0 = players[C][0];
  const [a0, b0] = [players[A][0], players[B][0]];
  const nextT = () => okHost('nextTurn', { turnId: g.state.turnId });
  okHost('setRounds', { n: 2 });
  okHost('start');
  // Round 1 — Team 1 misses a Hard one; b0 buzzes wrong; the steal reopens; c0 steals 150
  T.land(SEG.christmas);
  okHost('pickDifficulty', { level: 'hard' });
  okHost('judge', { result: 'wrong' });
  clock.advance(g.timing.armMs);
  okP(b0, 'buzz');
  okHost('judge', { result: 'wrong' });
  okHost('openSteal');
  clock.advance(g.timing.armMs);
  okP(c0, 'buzz');
  okHost('judge', { result: 'correct' });
  nextT();
  // Team 2 misses a Medium one; c0 steals 100
  T.land(SEG.christmas);
  okHost('pickDifficulty', { level: 'medium' });
  okHost('judge', { result: 'wrong' });
  clock.advance(g.timing.armMs);
  okP(c0, 'buzz');
  okHost('judge', { result: 'correct' });
  nextT();
  // Team 3: c0 nails a dare
  let d = T.land(SEG.dare);
  assert.equal(d.performer.playerId, pid(c0));
  okHost('timer', { action: 'start' });
  okHost('dareResult', { result: 'nailed' });
  assert.deepEqual(T.scores(), [0, 0, 450]);
  nextT();
  assert.equal(g.state.phase, 'roundBreak');
  okHost('continue');
  // Round 2 — Team 1's Hot Seat: 3 wrong, 3 right
  const hs = T.land(SEG.hotseat);
  const hsPerf = hs.performer.playerId;
  okHost('timer', { action: 'start' });
  for (const res of ['wrong', 'wrong', 'wrong', 'correct', 'correct', 'correct']) okHost('hotseatMark', { result: res, index: g.state.challenge.hs.index });
  nextT();
  // Team 2 Grinch-steals 150 from Team 3
  T.land(SEG.grinch);
  okP(b0, 'pickTarget', { teamId: C });
  nextT();
  // Team 3: c0 dares again and fails
  d = T.land(SEG.dare);
  okHost('timer', { action: 'start' });
  okHost('dareResult', { result: 'fail' });
  assert.deepEqual(T.scores(), [150, 150, 300]);
  nextT();
  assert.equal(g.state.phase, 'finalIntro');
  okHost('continue');
  okP(a0, 'wager', { amount: 300 });
  okP(b0, 'wager', { amount: 0 });
  okP(c0, 'wager', { amount: 0 });
  okHost('finalStartAnswering');
  okP(a0, 'submitAnswer', { text: g.state.final.q.answer });
  okP(b0, 'submitAnswer', { text: 'no idea at all' });
  okP(c0, 'submitAnswer', { text: 'something else entirely' });
  okHost('continue');
  while (g.state.phase === 'finalReveal') okHost('finalRevealNext');
  const pv = publicView(g);
  assert.deepEqual(pv.podium.standings.map((s) => [s.teamId, s.score, s.place]), [[A, 450, 1], [C, 300, 2], [B, 150, 3]]);
  // ceremony order (the Lump of Coal is the finale); Silent Night not earned (nobody else had 3 steal chances)
  assert.deepEqual(pv.podium.awards.map((a) => a.key), ['fastestFinger', 'starPerformer', 'grinchOfTheYear', 'comebackKid', 'rudolph', 'lumpOfCoal']);
  const aw = Object.fromEntries(pv.podium.awards.map((a) => [a.key, a]));
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  assert.deepEqual(pick(aw.fastestFinger, ['playerId', 'name', 'teamId', 'art', 'tie']), { playerId: T.pid(c0), name: 'Player 20', teamId: C, art: 'zap', tie: false });
  assert.match(aw.fastestFinger.detail, /^2 buzzes won — /);
  assert.deepEqual(pick(aw.starPerformer, ['playerId', 'art']), { playerId: T.pid(c0), art: 'masks' });
  assert.match(aw.starPerformer.detail, /^2 dares · 200 pts — /);
  assert.deepEqual(pick(aw.grinchOfTheYear, ['playerId', 'name', 'teamId', 'art']), { playerId: null, name: 'Team 3', teamId: C, art: 'money' });
  assert.match(aw.grinchOfTheYear.detail, /^Stole 250 points in 2 heists — /);
  assert.deepEqual(pick(aw.comebackKid, ['teamId', 'art']), { teamId: A, art: 'sled' });
  assert.match(aw.comebackKid.detail, /^From 2nd to 1st — and won the whole thing!$/);
  assert.deepEqual(pick(aw.rudolph, ['teamId', 'art']), { teamId: C, art: 'deer' });
  assert.match(aw.rudolph.detail, /^Led 2 of 2 rounds — /);
  assert.deepEqual(pick(aw.lumpOfCoal, ['playerId', 'teamId', 'art']), { playerId: hsPerf, teamId: A, art: 'snowman' });
  assert.equal(aw.lumpOfCoal.detail, '3 wrong answers — Santa noticed');
  // the stats behind them
  const ps = Object.fromEntries(pv.podium.stats.players.map((p) => [p.playerId, p]));
  const P = ['buzzWins', 'steals', 'performances', 'wrongAnswers', 'buzzChances', 'perfectHotSeat'];
  assert.deepEqual(pick(ps[T.pid(c0)], P), { buzzWins: 2, steals: 2, performances: 2, wrongAnswers: 1, buzzChances: 3, perfectHotSeat: 0 });
  assert.deepEqual(pick(ps[T.pid(b0)], P), { buzzWins: 1, steals: 0, performances: 0, wrongAnswers: 2, buzzChances: 1, perfectHotSeat: 0 });
  assert.deepEqual(pick(ps[hsPerf], ['wrongAnswers', 'performances']), { wrongAnswers: 3, performances: 1 });
  const ts = Object.fromEntries(pv.podium.stats.teams.map((t) => [t.teamId, t]));
  const TK = ['steals', 'stealCount', 'wrong', 'timesLed', 'climb'];
  assert.deepEqual(pick(ts[A], TK), { steals: 0, stealCount: 0, wrong: 4, timesLed: 0, climb: 1 });
  assert.deepEqual(pick(ts[B], TK), { steals: 150, stealCount: 1, wrong: 3, timesLed: 0, climb: 0 });
  assert.deepEqual(pick(ts[C], TK), { steals: 250, stealCount: 2, wrong: 1, timesLed: 2, climb: 0 });
  // the host reads it as a ceremony, coal last
  const co = hostView(g).host.coach;
  assert.ok(co.say.includes(`The Lump of Coal Award goes to… ${aw.lumpOfCoal.name}! (3 wrong answers — Santa noticed)`), co.say);
  assert.ok(co.say.indexOf('Lump of Coal') > co.say.indexOf('Rudolph Award'), 'coal comes last');
  assert.ok(co.tips.some((t) => /Lump of Coal goes last/.test(t)));
  // undo on the podium recomputes it (and says so)
  okHost('undo');
  assert.equal(publicView(g).quip.key, 'undo');
  assert.ok(publicView(g).podium.awards.length >= 1);
});

test('comedy: tied awards are shared ("A and B"); a game with no notable play earns no awards', () => {
  const T = setup({ teams: 3, perTeam: 1, seed: 12 });
  const { g, clock, okHost, okP, players, teamIds } = T;
  const [, B, C] = teamIds;
  okHost('setRounds', { n: 1 });
  okHost('start');
  for (const thief of [B, C]) { // Team 1, then Team 2, miss an Easy one; Team 2, then Team 3, steal 50
    T.land(SEG.christmas);
    okHost('pickDifficulty', { level: 'easy' });
    okHost('judge', { result: 'wrong' });
    clock.advance(g.timing.armMs);
    okP(players[thief][0], 'buzz');
    okHost('judge', { result: 'correct' });
    okHost('nextTurn', { turnId: g.state.turnId });
  }
  okHost('nextTurn', { turnId: g.state.turnId });
  assert.equal(g.state.phase, 'finalIntro');
  okHost('continue');
  okHost('finalStartAnswering');
  okHost('continue');
  while (g.state.phase === 'finalReveal') okHost('finalRevealNext');
  const aw = Object.fromEntries(publicView(g).podium.awards.map((a) => [a.key, a]));
  assert.deepEqual([aw.fastestFinger.name, aw.fastestFinger.playerId, aw.fastestFinger.teamId, aw.fastestFinger.tie], ['Player 10 and Player 20', null, null, true]);
  assert.match(aw.fastestFinger.detail, /^1 buzz won each — /);
  assert.deepEqual([aw.grinchOfTheYear.name, aw.grinchOfTheYear.tie], ['Team 2 and Team 3', true]);
  // a shared award lists everyone in it (pages decide "mine" from the ids, never from the joined name)
  assert.deepEqual(aw.fastestFinger.playerIds.slice().sort(), [T.pid(players[B][0]), T.pid(players[C][0])].sort());
  assert.deepEqual(aw.fastestFinger.teamIds.slice().sort(), [B, C].sort());
  assert.deepEqual([aw.grinchOfTheYear.playerIds, aw.grinchOfTheYear.teamIds.slice().sort(), aw.grinchOfTheYear.teamId], [[], [B, C].sort(), null]);
  // a single winner: the lists hold just them
  for (const a of Object.values(aw).filter((x) => !x.tie)) {
    assert.deepEqual(a.playerIds, a.playerId ? [a.playerId] : [], a.key);
    assert.deepEqual(a.teamIds, a.teamId ? [a.teamId] : [], a.key);
  }
  // nothing notable at all: no awards
  const T2 = setup({ teams: 2, perTeam: 1 });
  T2.okHost('setRounds', { n: 1 });
  T2.okHost('start');
  T2.okHost('nextTurn', { turnId: T2.g.state.turnId });
  T2.okHost('nextTurn', { turnId: T2.g.state.turnId });
  T2.okHost('continue');
  T2.okHost('finalStartAnswering');
  T2.okHost('continue');
  while (T2.g.state.phase === 'finalReveal') T2.okHost('finalRevealNext');
  assert.deepEqual(publicView(T2.g).podium.awards, []);
});

// ================================================================================================ grammar (plural team names)
const GRAMMAR_NAMES = [
  ['The Grinches', true], ['Jingle Bell Rockers', true], ['Elves', true], ['Reindeer Games', true], ['The Grinches!', true],
  ['Team Rudolph', false], ['Elf Help', false], ['Naughty List', false], ["Frosty's Crew", false], ['Frosty’s', false], ["Santa's", false],
  ['Boss', false], ['Santa Claus', false], ['Merry Christmas', false], ['Krampus', false], ['Saint Nicholas', false], ['', false], [null, false],
];

test('grammar: isPluralTeam / verb / subject / pluralOf / possessive', () => {
  for (const [name, plural] of GRAMMAR_NAMES) assert.equal(grammar.isPluralTeam(name), plural, String(name));
  assert.equal(grammar.subject('The Grinches', 'is'), 'The Grinches are');
  assert.equal(grammar.subject('Team Rudolph', 'is'), 'Team Rudolph is');
  assert.equal(grammar.subject('Jingle Bell Rockers', 'wins'), 'Jingle Bell Rockers win');
  assert.equal(grammar.subject("Frosty's Crew", 'has'), "Frosty's Crew has");
  assert.equal(grammar.verb('The Grinches', 'wins', 'win'), 'win');
  assert.equal(grammar.verb('Elf Help', 'wins', 'win'), 'wins');
  assert.deepEqual([grammar.isAre('Naughty List'), grammar.hasHave('Elves'), grammar.wasWere('Elves')], ['is', 'have', 'were']);
  for (const [one, many] of [['wins', 'win'], ['catches', 'catch'], ['tries', 'try'], ['is', 'are'], ['has', 'have'], ['was', 'were'], ['misses', 'miss'], ['buzzes', 'buzz'], ['plays', 'play'], ['goes', 'go'], ['spins', 'spin'], ['lives', 'live']]) {
    assert.equal(grammar.pluralOf(one), many, one);
  }
  assert.deepEqual([grammar.possessive('The Grinches'), grammar.possessive('Team Rudolph'), grammar.possessive('')], ['The Grinches’', 'Team Rudolph’s', '']);
});

test('grammar: quip verb markers validate; the real quip bank never puts a bare present-tense verb after a team name', () => {
  assert.deepEqual(validateQuip('correct', { id: 'v1', text: '{team} {teamVerb:wins|win} {points}! {other} {otherVerb:is|are} sad.' }), []);
  assert.deepEqual(validateQuip('podium', { id: 'v2', text: '{leader} {leaderVerb:wins|win}' }), []);
  assert.match(validateQuip('correct', { id: 'v3', text: 'Yes! {teamVerb:wins|win}' }).join(), /needs \{team\}/);
  assert.match(validateQuip('correct', { id: 'v4', text: '{points} {pointsVerb:is|are}' }).join(), /must agree with one of/);
  assert.match(validateQuip('correct', { id: 'v5', text: '{team} {teamVerb:wins}' }).join(), /bad verb marker/);
  // data/quips.json: every line loaded (no problems), and no "{team} is" / "{leader} wins" left (they are rephrased or use a marker)
  assert.deepEqual(CONTENT.problems.filter((p) => p.file === 'quips.json'), []);
  const lines = Object.values(CONTENT.quips).flat();
  const bad = lines.filter((l) => /\{(team|other|leader|last)\} (is|has|was|does|[a-z]+s)\b/.test(l.text)).map((l) => `${l.id}: ${l.text}`);
  assert.deepEqual(bad, []);
  assert.ok(lines.filter((l) => /\{[a-z]+Verb:/.test(l.text)).length >= 10, 'verb markers in use');
});

test('grammar: plural team names get plural verbs in quips, possessives and the coach (singular names stay singular)', () => {
  const bank = testBank({
    gameStart: [],
    turnIntro: [
      { id: 'ti-1', text: "{team} {teamVerb:is|are} up. Go, {team}'s elves!", tone: 'cheer' },
      { id: 'ti-2', text: "{team} {teamVerb:is|are} up. Go, {team}'s elves!", tone: 'cheer' },
    ],
    leadChange: [],
    spinStart: [{ id: 'sp-1', text: '{player} {playerVerb:spins|spin} it', tone: 'cheer' }, { id: 'sp-2', text: '{player} {playerVerb:spins|spin} it', tone: 'cheer' }],
    podium: [{ id: 'po-1', text: '{leader} {leaderVerb:wins|win} Christmas', tone: 'cheer' }],
  });
  const T = setup({ content: { ...CONTENT, quips: bank }, teams: 2, perTeam: 1, names: ['The Grinches', 'Team Rudolph'] });
  const { g, okHost } = T;
  const quip = () => publicView(g).quip && publicView(g).quip.text;
  const coach = () => hostView(g, {}).host.coach;
  okHost('setRounds', { n: 1 });
  okHost('start');
  assert.equal(quip(), "The Grinches are up. Go, The Grinches' elves!");
  assert.match(coach().headline, /^The Grinches are up/);
  okHost('forceSegment', { index: SEG.christmas }); // the host spins for them: {player} is the (plural) team
  assert.equal(quip(), 'The Grinches spin it');
  T.clock.advance(g.timing.spinMs);
  assert.equal(coach().headline, 'The Grinches are picking a difficulty');
  okHost('pickDifficulty', { level: 'easy' });
  assert.match(coach().headline, /^The Grinches are answering/);
  okHost('judge', { result: 'correct' });
  okHost('nextTurn', { turnId: g.state.turnId });
  assert.equal(quip(), "Team Rudolph is up. Go, Team Rudolph's elves!");
  assert.match(coach().headline, /^Team Rudolph is up/);
  okHost('forceSegment', { index: SEG.christmas });
  assert.equal(quip(), 'Team Rudolph spins it');
  T.clock.advance(g.timing.spinMs);
  assert.equal(coach().headline, 'Team Rudolph is picking a difficulty');
  okHost('pickDifficulty', { level: 'easy' });
  okHost('judge', { result: 'correct' });
  okHost('nextTurn', { turnId: g.state.turnId });
  okHost('continue');
  okHost('finalStartAnswering');
  okHost('continue');
  while (g.state.phase === 'finalReveal') okHost('finalRevealNext');
  // a shared win: the joined names are plural even though "Team Rudolph" alone is singular
  assert.equal(quip(), 'The Grinches and Team Rudolph win Christmas');
  assert.equal(coach().headline, 'The Grinches and Team Rudolph win Christmas!');

  // a single plural winner
  const T2 = setup({ content: { ...CONTENT, quips: bank }, teams: 2, perTeam: 1, names: ['Team Rudolph', 'Jingle Bell Rockers'] });
  T2.okHost('setRounds', { n: 1 });
  T2.okHost('start');
  T2.okHost('nextTurn', { turnId: T2.g.state.turnId });
  T2.land(SEG.christmas);
  T2.okHost('pickDifficulty', { level: 'easy' });
  T2.okHost('judge', { result: 'correct' });
  T2.okHost('nextTurn', { turnId: T2.g.state.turnId });
  T2.okHost('continue');
  T2.okHost('finalStartAnswering');
  T2.okHost('continue');
  while (T2.g.state.phase === 'finalReveal') T2.okHost('finalRevealNext');
  assert.equal(publicView(T2.g).quip.text, 'Jingle Bell Rockers win Christmas');
  assert.equal(hostView(T2.g, {}).host.coach.headline, 'Jingle Bell Rockers win Christmas!');
});

test('dare: a team of one never draws a pair dare (also on Swap dare)', () => {
  const pairs = CONTENT.dares.filter((d) => d.who === 'pair').length;
  assert.ok(pairs > 0, 'the content has pair dares to avoid');
  for (const [perTeam, allowPair] of [[1, false], [3, true]]) {
    const T = setup({ teams: 2, perTeam, seed: 11 });
    T.okHost('start');
    let draws = 0;
    for (let i = 0; i < 24; i++) {
      const c = T.land(SEG.dare);
      draws++;
      if (!allowPair) assert.notEqual(c.dare.who, 'pair', `team of ${perTeam}: drew pair dare ${c.dare.id}`);
      T.okHost('swapQuestion');
      if (!allowPair) assert.notEqual(T.g.state.challenge.dare.who, 'pair', 'Swap dare keeps it solo-friendly');
      T.okHost('endChallenge');
      T.okHost('nextTurn', { turnId: T.g.state.turnId });
      if (T.g.state.phase === 'roundBreak') T.okHost('continue');
      if (T.g.state.phase !== 'turnIntro') break;
    }
    assert.ok(draws >= 6, `only ${draws} dares were drawn`);
  }
});
