'use strict';
/**
 * End-to-end: boots the real server on a random port and plays over real sockets with socket.io-client
 * (host + TV + up to 8 teams of phones). Acceptance-test numbers refer to TECH.md §5.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { startServer, isLocalAddress } = require('../server');

const FAST = { spinMs: 60, armMs: 60, voteMs: 1500 };
const ROOT = path.join(__dirname, '..');
const HOST_EVENTS = ['createTeam', 'updateTeam', 'removeTeam', 'reorderTeams', 'shuffleTeams', 'movePlayer', 'kickPlayer', 'setRounds', 'setOption', 'start',
  'spin', 'forceSegment', 'pickDifficulty', 'pickTarget', 'judge', 'openSteal', 'reveal', 'showHint', 'timer', 'rerollPerformer', 'swapQuestion', 'swapSecret',
  'endChallenge', 'dareResult', 'openVote', 'closeVote', 'showdownResult', 'listTick', 'listUntick', 'listOther', 'hotseatMark', 'markAnswer', 'revealAnswers',
  'finalStartAnswering', 'finalRevealNext', 'adjustScore', 'undo', 'nextTurn', 'continue', 'resetGame', 'soundTest', 'resume', 'discardSave'].map((e) => 'host:' + e);
const PLAYER_EVENTS = ['join', 'spin', 'pickDifficulty', 'buzz', 'pickTarget', 'previewTarget', 'submitAnswer', 'wager', 'vote', 'peek'];

function mulberry32(a) {
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));

async function boot(opts = {}) {
  const srv = await startServer({ port: 0, quiet: true, autosave: false, rateLimit: 0, coalesceMs: 5, timing: FAST, saveDir: tmpDir(), ...opts });
  srv.url = `http://127.0.0.1:${srv.port}`;
  return srv;
}

/** A client that behaves like the real pages: re-sends hello on EVERY (re)connect. */
function client(url, hello) {
  const socket = io(url, { transports: ['websocket'], forceNew: true, reconnectionDelay: 30, reconnectionDelayMax: 100, timeout: 4000 });
  const c = { socket, hello, state: null, states: [], fx: [], helloAcks: [], waiters: [] };
  socket.on('state', (s) => {
    c.state = s; c.states.push(s);
    for (const w of c.waiters.slice()) if (w.pred(s)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(s); }
  });
  socket.on('fx', (e) => c.fx.push(e));
  socket.on('connect', () => socket.emit('hello', c.hello, (r) => c.helloAcks.push(r)));
  c.emit = (ev, payload) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${ev}`)), 4000);
    socket.emit(ev, payload, (r) => { clearTimeout(t); resolve(r); });
  });
  c.waitFor = (pred, ms = 4000, label = '') => {
    if (c.state && pred(c.state)) return Promise.resolve(c.state);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      c.waiters.push(w);
      setTimeout(() => { const i = c.waiters.indexOf(w); if (i >= 0) { c.waiters.splice(i, 1); reject(new Error(`timeout waiting ${label} (phase ${c.state && c.state.phase}, stage ${c.state && c.state.challenge && c.state.challenge.stage})`)); } }, ms);
    });
  };
  c.ready = () => c.waitFor((s) => !!s, 4000, 'first state');
  c.close = () => socket.close();
  return c;
}

/** Host helper: emit, assert ok, wait until the host has seen the resulting state. */
function hostOps(h) {
  h.ok = async (ev, payload) => {
    const before = h.states.length;
    const r = await h.emit(ev, payload);
    assert.equal(r.ok, true, `${ev} ${JSON.stringify(payload)} -> ${r.error} (phase ${h.state && h.state.phase}, stage ${h.state && h.state.challenge && h.state.challenge.stage})`);
    await h.waitFor(() => h.states.length > before, 4000, 'state after ' + ev);
    return r;
  };
  return h;
}
async function pOk(h, p, ev, payload) {
  const before = h.states.length;
  const r = await p.emit(ev, payload);
  assert.equal(r.ok, true, `${p.hello.clientId} ${ev} ${JSON.stringify(payload)} -> ${r.error} (phase ${h.state.phase}, stage ${h.state.challenge && h.state.challenge.stage})`);
  await h.waitFor(() => h.states.length > before, 4000, 'state after player ' + ev);
  return r;
}

/** Host + TV + `teams` teams with `per` phones each, all joined. */
async function lobby(srv, teams, per) {
  const h = hostOps(client(srv.url, { role: 'host' }));
  const tv = client(srv.url, { role: 'tv' });
  await h.ready(); await tv.ready();
  const teamIds = [];
  const players = {};
  for (let i = 0; i < teams; i++) {
    const r = await h.ok('host:createTeam', { name: `Team ${i + 1}` });
    teamIds.push(r.teamId);
    players[r.teamId] = [];
  }
  const joins = [];
  for (let i = 0; i < teams; i++) {
    for (let j = 0; j < per; j++) {
      const p = client(srv.url, { role: 'player', clientId: `phone-${i}-${j}-${Math.random().toString(36).slice(2, 8)}` });
      players[teamIds[i]].push(p);
      joins.push((async () => {
        await p.ready();
        const r = await p.emit('join', { name: `P${i}-${j}`, teamId: teamIds[i] });
        assert.equal(r.ok, true, 'join ' + r.error);
        await p.waitFor((s) => s.me && s.me.teamId === teamIds[i], 4000, 'joined');
      })());
    }
  }
  await Promise.all(joins);
  await h.waitFor((s) => s.players.length === teams * per, 4000, 'all players');
  const all = () => [h, tv, ...Object.values(players).flat()];
  return { h, tv, teamIds, players, closeAll: () => all().forEach((c) => c.close()) };
}

// ------------------------------------------------------------------------------------------------ e2e game driver
async function stepChallenge(L, rng) {
  const { h, players, teamIds } = L;
  const S = h.state;
  const c = S.challenge;
  const act = S.activeTeamId;
  const actP = players[act][0];
  const r = rng();
  switch (c.type) {
    case 'doubledown': {
      const id = c.id;
      await h.ok('host:forceSegment', { index: [0, 1, 9, 3][Math.floor(rng() * 4)] });
      await h.waitFor((s) => s.challenge && s.challenge.id !== id && s.phase !== 'spinning', 4000, 'double down respin');
      return;
    }
    case 'trivia':
      if (c.stage === 'pickDifficulty') return pOk(h, players[act][players[act].length - 1], 'pickDifficulty', { level: ['easy', 'medium', 'hard'][Math.floor(r * 3)] });
      if (c.stage === 'question') return r < 0.45 ? h.ok('host:judge', { result: 'correct' }) : r < 0.55 && c.hasHint && !c.hint ? h.ok('host:showHint') : h.ok('host:judge', { result: 'wrong' });
      return stealStep(L, rng);
    case 'sounditout':
      if (c.stage === 'perform') {
        if (!S.timer.started) return h.ok('host:timer', { action: 'start' });
        return h.ok('host:judge', { result: r < 0.5 ? 'correct' : 'wrong' });
      }
      return stealStep(L, rng);
    case 'dare':
      if (c.stage === 'perform') {
        if (!S.timer.started) return h.ok('host:timer', { action: 'start' });
        if (r < 0.5) return h.ok('host:dareResult', { result: ['nailed', 'valiant', 'fail'][Math.floor(rng() * 3)], bonus: rng() < 0.3 });
        return h.ok('host:openVote');
      }
      if (c.stage === 'vote') {
        const voters = teamIds.filter((t) => t !== act).flatMap((t) => players[t]);
        const v = voters.find((p) => p.state.can.vote);
        if (v && r > 0.15) return pOk(h, v, 'vote', { choice: rng() < 0.6 ? 'nailed' : 'good' });
        return h.ok('host:closeVote');
      }
      break;
    case 'showdown':
      if (c.stage === 'pickRival') return pOk(h, actP, 'pickTarget', { teamId: c.targets[Math.floor(rng() * c.targets.length)] });
      if (!S.timer.started) return h.ok('host:timer', { action: 'start' });
      return h.ok('host:showdownResult', { winner: ['active', 'rival', 'tie'][Math.floor(r * 3)] });
    case 'rapidlist': {
      if (!S.timer.started) return h.ok('host:timer', { action: 'start' });
      const next = S.host.listAnswers.find((a) => !c.list.ticked.includes(a));
      if (c.list.count < 4 && next) return h.ok('host:listTick', { answer: next });
      if (r < 0.3) return h.ok('host:listOther');
      return h.ok('host:continue');
    }
    case 'hotseat':
      if (!S.timer.started) return h.ok('host:timer', { action: 'start' });
      return h.ok('host:hotseatMark', { result: ['correct', 'wrong', 'pass', 'correct'][Math.floor(r * 4)], index: c.hotseat.index });
    case 'allplay':
      if (c.stage === 'answering') {
        for (const t of teamIds) {
          const p = players[t][Math.floor(rng() * players[t].length)];
          await pOk(h, p, 'submitAnswer', { text: rng() < 0.5 ? S.host.answer : 'no clue ' + t });
        }
        return h.ok('host:continue');
      }
      if (c.stage === 'marking') {
        if (S.host.submissions.length && r < 0.3) await h.ok('host:markAnswer', { teamId: S.host.submissions[0].teamId, correct: !S.host.submissions[0].correct });
        return h.ok('host:revealAnswers');
      }
      break;
    case 'grinch':
      if (c.stage === 'pickTarget') return pOk(h, actP, 'pickTarget', { teamId: c.targets[0] });
      break;
    default:
      throw new Error('unknown challenge ' + c.type);
  }
  throw new Error(`stuck in ${c.type}/${c.stage}`);
}
async function stealStep(L, rng) {
  const { h, players } = L;
  const b = h.state.challenge.buzz;
  if (b.armingUntil) { await h.waitFor((s) => !s.challenge.buzz || !s.challenge.buzz.armingUntil, 4000, 'arming'); return; }
  if (b.winner) return h.ok('host:judge', { result: rng() < 0.5 ? 'correct' : 'wrong' });
  if (b.open) {
    const team = b.eligibleTeamIds[Math.floor(rng() * b.eligibleTeamIds.length)];
    const p = players[team][0];
    await p.waitFor((s) => s.can.buzz, 4000, 'phone can buzz');
    return pOk(h, p, 'buzz');
  }
  return rng() < 0.6 && h.state.host.can.openSteal ? h.ok('host:openSteal') : h.ok('host:reveal');
}
async function playGame(L, seed) {
  const { h, players, teamIds } = L;
  const rng = mulberry32(seed);
  const seen = new Set();
  let turn = 0;
  await h.ok('host:start');
  for (let guard = 0; guard < 4000 && h.state.phase !== 'podium'; guard++) {
    const S = h.state;
    switch (S.phase) {
      case 'turnIntro': {
        const tid = S.turnId;
        if (turn >= 12 && rng() < 0.4) {
          const p = players[S.activeTeamId][Math.floor(rng() * players[S.activeTeamId].length)];
          await p.waitFor((s) => s.can.spin, 4000, 'phone can spin');
          await pOk(h, p, 'spin');
        } else await h.ok('host:forceSegment', { index: turn % 12 });
        turn++;
        await h.waitFor((s) => s.turnId === tid && (s.phase === 'challenge' || s.phase === 'turnResult'), 4000, 'landing');
        if (h.state.challenge) seen.add(h.state.challenge.type);
        break;
      }
      case 'challenge':
        seen.add(S.challenge.type);
        await stepChallenge(L, rng);
        break;
      case 'turnResult':
        await h.ok('host:nextTurn', { turnId: S.turnId });
        break;
      case 'roundBreak':
        if (S.challenge && S.challenge.stage === 'answering') for (const t of teamIds) await pOk(h, players[t][0], 'submitAnswer', { text: rng() < 0.5 ? S.host.answer : 'pass' });
        await h.ok('host:continue');
        break;
      case 'finalIntro':
        await h.ok('host:continue');
        break;
      case 'finalWager':
        for (const t of teamIds) {
          const p = players[t][0];
          await p.waitFor((s) => s.can.wager && s.myTeam && s.myTeam.maxWager != null, 4000, 'phone can wager');
          const max = p.state.myTeam.maxWager;
          assert.equal((await p.emit('wager', { amount: max + 50 })).ok, false, 'over max rejected');
          await pOk(h, p, 'wager', { amount: Math.floor(rng() * (max + 1)) });
        }
        await h.ok('host:finalStartAnswering');
        break;
      case 'finalAnswer':
        for (const t of teamIds) await pOk(h, players[t][0], 'submitAnswer', { text: rng() < 0.5 ? S.host.final.answer : 'not sure' });
        await h.ok('host:continue');
        break;
      case 'finalReveal':
        if (S.final.current && !S.host.final.rows.find((x) => x.teamId === S.final.current).judged && rng() < 0.5) await h.ok('host:markAnswer', { teamId: S.final.current, correct: rng() < 0.5 });
        else await h.ok('host:finalRevealNext');
        break;
      default:
        throw new Error('unexpected phase ' + S.phase);
    }
  }
  return seen;
}
/** TV must never show a secret the host knows for the same challenge before it is revealed. */
function checkTvLeaks(h, tv) {
  const secrets = {};
  const finalSecrets = new Set();
  for (const s of h.states) {
    const c = s.challenge;
    if (c && s.host) {
      const set = secrets[c.id] || (secrets[c.id] = new Set());
      for (const v of [s.host.answer, ...(s.host.accept || []), s.host.song && s.host.song.title, s.host.secret && s.host.secret.value, s.host.hotseatAnswer]) if (typeof v === 'string' && v.trim().length >= 4 && !/^[\d,. ]+$/.test(v)) set.add(v);
    }
    if (s.host && s.host.final) finalSecrets.add(s.host.final.answer);
  }
  const leaks = [];
  for (const s of tv.states) {
    assert.equal(s.host, undefined, 'TV never gets host info');
    assert.equal(s.me, undefined);
    const json = JSON.stringify(s);
    for (const k of ['"accept":', '"secretValue"', '"clientId"', '"pin"']) if (json.includes(k)) leaks.push('key ' + k);
    const c = s.challenge;
    if (c && !c.revealed && secrets[c.id]) {
      const allowed = [c.question, c.dare && c.dare.instructions, c.dare && c.dare.title, c.dare && c.dare.judge, c.list && c.list.prompt, ...(c.list ? c.list.ticked : []), c.hotseat && c.hotseat.question, ...s.teams.map((t) => t.name), ...s.players.map((p) => p.name)].filter(Boolean).join('\n');
      for (const sec of secrets[c.id]) if (!allowed.includes(sec) && json.includes(JSON.stringify(sec).slice(1, -1))) leaks.push(`challenge ${c.id} ${c.type}/${c.stage}: "${sec}"`);
    }
    if (s.final && !s.final.done) {
      const allowedFinal = [s.final.question || '', ...s.final.revealed.map((r) => r.text)].join(' | ');
      for (const a of finalSecrets) if (a && a.length >= 4 && !allowedFinal.includes(a) && json.includes(JSON.stringify(a).slice(1, -1))) leaks.push('final answer before done');
    }
  }
  return leaks;
}

// ================================================================================================ tests

test('1. socket drops and reconnects with a new id -> same player, can still spin and buzz', async () => {
  const srv = await boot();
  const L = await lobby(srv, 2, 2);
  try {
    const { h, players, teamIds } = L;
    const ann = players[teamIds[0]][0];
    const meBefore = ann.state.me.playerId;
    const idBefore = ann.socket.id;
    await h.ok('host:start');
    // drop the transport (screen lock / Wi-Fi blip)
    ann.socket.io.engine.close();
    await h.waitFor((s) => s.players.find((p) => p.id === meBefore).connected === false, 4000, 'server noticed drop');
    await h.waitFor((s) => s.players.find((p) => p.id === meBefore).connected === true, 4000, 'auto re-hello');
    await ann.waitFor((s) => s.me && s.me.playerId === meBefore && s.can.spin, 4000, 'spin after reconnect');
    assert.notEqual(ann.socket.id, idBefore, 'new socket id');
    assert.equal(ann.helloAcks.at(-1).me.playerId, meBefore);
    await pOk(h, ann, 'spin');
    await h.waitFor((s) => s.phase === 'challenge' || s.phase === 'turnResult', 4000, 'spin landed');
    await h.ok('host:nextTurn', { turnId: h.state.turnId });
    // other team's trivia, Ann's team steals after another reconnect
    await h.ok('host:forceSegment', { index: 0 });
    await h.waitFor((s) => s.phase === 'challenge');
    await pOk(h, players[teamIds[1]][0], 'pickDifficulty', { level: 'easy' });
    ann.socket.io.engine.close();
    await h.ok('host:judge', { result: 'wrong' });
    await ann.waitFor((s) => s.can.buzz, 4000, 'buzz after reconnect');
    await pOk(h, ann, 'buzz');
    assert.equal(h.state.challenge.buzz.winner.playerId, meBefore);
  } finally { L.closeAll(); await srv.close(); }
});

test('2. page refresh (new socket, same clientId) -> same team, no re-typing', async () => {
  const srv = await boot();
  const L = await lobby(srv, 2, 1);
  try {
    const { h, players, teamIds } = L;
    const old = players[teamIds[1]][0];
    const { clientId } = old.hello;
    const pid = old.state.me.playerId;
    await h.ok('host:start');
    old.close();
    await h.waitFor((s) => !s.players.find((p) => p.id === pid).connected, 4000, 'disconnected');
    assert.ok(h.state.players.find((p) => p.id === pid), 'disconnect never deletes the player');
    const fresh = client(srv.url, { role: 'player', clientId });
    await fresh.waitFor((s) => s.me && s.me.teamId === teamIds[1], 4000, 'restored');
    assert.equal(fresh.helloAcks[0].me.playerId, pid);
    assert.equal(fresh.helloAcks[0].me.teamId, teamIds[1]);
    assert.equal(fresh.state.myTeam.teamId, teamIds[1]);
    fresh.close();
  } finally { L.closeAll(); await srv.close(); }
});

test('3. play again keeping teams keeps players; game 2 playable from phones; no repeats', async () => {
  const srv = await boot();
  const L = await lobby(srv, 2, 2);
  try {
    const { h, players, teamIds, tv } = L;
    await h.ok('host:setRounds', { n: 2 });
    const seen1 = await playGame(L, 31);
    assert.equal(h.state.phase, 'podium');
    assert.ok(seen1.size >= 3);
    await h.ok('host:resetGame', { keepTeams: true });
    assert.equal(h.state.phase, 'lobby');
    for (const t of teamIds) for (const p of players[t]) await p.waitFor((s) => s.phase === 'lobby' && s.me && s.me.teamId === t, 4000, 'kept team');
    await h.ok('host:start');
    const p = players[h.state.activeTeamId][1];
    await p.waitFor((s) => s.can.spin, 4000, 'can spin in game 2');
    await pOk(h, p, 'spin');
    await h.waitFor((s) => s.phase === 'challenge' || s.phase === 'turnResult', 4000);
    // question texts across both games never repeat
    const qs = new Map();
    for (const s of tv.states) if (s.challenge && s.challenge.question && (s.challenge.type === 'trivia' || s.challenge.type === 'allplay' || s.challenge.type === 'bonus')) qs.set(s.challenge.id, s.challenge.question);
    assert.equal(new Set(qs.values()).size, qs.size, 'no repeated questions');
  } finally { L.closeAll(); await srv.close(); }
});

test('4. removing a team in the lobby unassigns only its players; other phones keep correct teams', async () => {
  const srv = await boot();
  const L = await lobby(srv, 3, 2);
  try {
    const { h, players, teamIds } = L;
    assert.deepEqual(teamIds, ['t1', 't2', 't3']);
    await h.ok('host:removeTeam', { teamId: 't2' });
    for (const p of players.t2) {
      await p.waitFor((s) => s.me && s.me.teamId === null, 4000, 'unassigned');
      assert.ok(p.fx.some((e) => e.type === 'teamRemoved' && e.teamId === 't2'));
    }
    for (const t of ['t1', 't3']) for (const p of players[t]) await p.waitFor((s) => s.me.teamId === t && s.teams.map((x) => x.id).join() === 't1,t3', 4000, 'kept');
    // the orphan picks a team again and the game starts with correct spin rights
    await pOk(h, players.t2[0], 'join', { name: 'Back', teamId: 't3' });
    await h.ok('host:start');
    await players.t1[0].waitFor((s) => s.can.spin, 4000);
    await players.t3[0].waitFor((s) => s.can.spin === false);
    assert.equal(players.t2[0].state.can.spin, false);
    assert.equal(players.t2[1].state.me.teamId, null);
  } finally { L.closeAll(); await srv.close(); }
});

test('5. every host:* event from a non-host socket is rejected; PIN grants host from a second device', async () => {
  const srv = await boot();
  const L = await lobby(srv, 2, 1);
  try {
    const p = L.players[L.teamIds[0]][0];
    const fresh = client(srv.url, { role: 'player', clientId: 'not-joined-yet' });
    await fresh.ready();
    for (const c of [p, L.tv, fresh]) {
      for (const ev of HOST_EVENTS) {
        const r = await c.emit(ev, { teamId: 't1', name: 'x', n: 2, keepTeams: true, turnId: 1, index: 0 });
        assert.deepEqual(r, { ok: false, error: 'not-host' }, `${ev} from ${c.hello.role}`);
      }
    }
    assert.equal(L.h.state.teams.length, 2, 'nothing changed');
    assert.equal(L.h.state.phase, 'lobby');
    fresh.close();
  } finally { L.closeAll(); await srv.close(); }
  // a server that does NOT trust loopback (simulates a second device on the LAN, e.g. the host's phone)
  const srv2 = await boot({ trustLoopback: false, pin: '4821' });
  const open = [];
  const mk = (hello) => { const c = client(srv2.url, hello); open.push(c); return c; };
  try {
    const a = hostOps(mk({ role: 'host' }));
    await a.waitFor((st) => st.needPin === true, 4000, 'login view');
    assert.deepEqual({ ok: a.helloAcks[0].ok, isHost: a.helloAcks[0].isHost, needPin: a.helloAcks[0].needPin }, { ok: true, isHost: false, needPin: true });
    // the login view is minimal: no PIN, no teams, no host block, no secrets
    assert.equal(a.state.host, null);
    assert.equal(a.state.teams, undefined);
    assert.ok(!JSON.stringify(a.state).includes('4821'), 'PIN never sent to an unauthorised socket');
    assert.ok(a.state.joinUrl.startsWith('http://'));
    assert.equal((await a.emit('host:createTeam', { name: 'Nope' })).error, 'not-host');
    // wrong PINs: 5 tries per socket per minute, with tries left
    const r1 = await a.emit('hostLogin', { pin: '0000' });
    assert.deepEqual(r1, { ok: false, error: 'bad-pin', triesLeft: 4 });
    for (let i = 0; i < 3; i++) await a.emit('hostLogin', { pin: String(1000 + i) });
    assert.equal((await a.emit('hostLogin', { pin: 12 })).triesLeft, 0);
    const locked = await a.emit('hostLogin', { pin: '4821' });
    assert.equal(locked.error, 'too-many-tries', 'even the right PIN waits once the limit is hit');
    assert.ok(locked.retryInMs > 0 && locked.retryInMs <= 60000);
    // a fresh device (new socket) logs in with the right PIN
    const b = hostOps(mk({ role: 'host' }));
    await b.waitFor((st) => st.needPin === true, 4000, 'login view b');
    assert.equal((await b.emit('hostLogin')).error, 'bad-pin', 'missing pin');
    const okLogin = await b.emit('hostLogin', { pin: '4821' });
    assert.deepEqual(okLogin, { ok: true, isHost: true, hostKey: '4821' });
    await b.waitFor((st) => st.host && st.host.pin === '4821', 4000, 'full host view after login');
    await b.ok('host:createTeam', { name: 'Yes' });
    assert.equal(b.state.teams.length, 1);
    // remembered key: a refresh (new socket) hellos with hostKey and is host straight away
    const c2 = hostOps(mk({ role: 'host', hostKey: okLogin.hostKey }));
    await c2.waitFor((st) => st.host && st.teams.length === 1, 4000, 'remembered key');
    assert.equal(c2.helloAcks[0].isHost, true);
    assert.equal(c2.helloAcks[0].hostKey, '4821');
    // several host devices stay in sync and the host view counts them
    await c2.ok('host:createTeam', { name: 'Also yes' });
    await b.waitFor((st) => st.teams.length === 2, 4000, 'b sees c2 change');
    await b.waitFor((st) => st.host.connections.hosts === 2, 4000, 'two host screens');
    // a stale key (PIN changed after a restart) just asks for the PIN again
    const d = mk({ role: 'host', hostKey: '9999' });
    await d.waitFor((st) => st.needPin === true, 4000, 'stale key -> login view');
    assert.equal(d.helloAcks[0].pinError, 'bad-pin');
    assert.equal(d.helloAcks[0].isHost, false);
    // hostLogin needs a host hello first
    const e = mk({ role: 'tv' });
    await e.ready();
    assert.equal((await e.emit('hostLogin', { pin: '4821' })).error, 'hello-first');
    await b.waitFor((st) => st.host.connections.tv === 1, 4000, 'TV counted');
  } finally { open.forEach((c) => c.close()); await srv2.close(); }
});

test('6. 200+ random/malformed payloads across all events never crash the server', async () => {
  const srv = await boot();
  const L = await lobby(srv, 3, 1);
  const rng = mulberry32(66);
  const junk = () => {
    const pool = [undefined, null, 0, -1, 3.7, 1e308, '', 'x'.repeat(3000), true, [], [1, 'a', null], {}, { teamId: 't1' }, { teamId: 'tZZ' }, { teamId: 5 }, { amount: 'all' }, { amount: -5 },
      { text: { nested: [1, 2, 3] } }, { level: 'impossible' }, { index: 1e9 }, { n: '4' }, { turnId: null }, { result: 'correct' }, { choice: 'nailed' }, { playerId: 'p1', teamId: null },
      { name: '<img src=x onerror=alert(1)>', teamId: 't1' }, { key: 'joinIp', value: '8.8.8.8' }, { key: 'sound', value: 'loud' }, { action: 'add', seconds: 1e6 }, { __proto__: { teamId: 't1' } }, { constructor: { prototype: { x: 1 } } }];
    return pool[Math.floor(rng() * pool.length)];
  };
  try {
    const { h } = L;
    await h.ok('host:start');
    const raw = client(srv.url, { role: 'nobody' });
    await sleep(100);
    const events = [...HOST_EVENTS, ...PLAYER_EVENTS, 'hello', 'state', 'fx', 'unknownEvent', 'toString', '__proto__'];
    const senders = [h, L.tv, raw, ...Object.values(L.players).flat()];
    let n = 0;
    for (let i = 0; i < 260; i++) {
      const s = senders[Math.floor(rng() * senders.length)];
      const ev = events[Math.floor(rng() * events.length)];
      if (ev === 'hello') continue; // keep roles stable; hello fuzzing is below
      const mode = rng();
      if (mode < 0.15) s.socket.emit(ev, junk()); // no ack
      else if (mode < 0.25) s.socket.emit(ev, junk(), junk(), (r) => r); // extra args
      else { const r = await s.emit(ev, junk()); assert.equal(typeof r.ok, 'boolean'); assert.notEqual(r.error, 'server-error', `${ev} threw`); }
      n++;
    }
    for (const bad of [undefined, null, 'host', { role: 'admin' }, { role: 'player' }, { role: 'player', clientId: 'a b' }, { role: 'player', clientId: 'x'.repeat(200) }, { role: ['host'] }]) {
      const r = await raw.emit('hello', bad);
      assert.equal(r.ok, false);
      n++;
    }
    // an oversized packet just drops that one socket
    const big = client(srv.url, { role: 'tv' });
    await big.ready();
    big.socket.emit('submitAnswer', { text: 'y'.repeat(200 * 1024) });
    await sleep(200);
    assert.ok(n >= 200);
    // still alive and consistent
    const probe = client(srv.url, { role: 'tv' });
    await probe.ready();
    assert.equal(probe.helloAcks[0].ok, true);
    assert.ok(['turnIntro', 'spinning', 'challenge', 'turnResult', 'roundBreak', 'finalIntro', 'finalWager', 'finalAnswer', 'finalReveal', 'podium', 'lobby'].includes(probe.state.phase));
    assert.ok(probe.state.teams.every((t) => Number.isInteger(t.score) && t.score >= 0));
    const info = await fetch(srv.url + '/api/info').then((r) => r.json());
    assert.ok(info.joinUrl.startsWith('http://'));
    raw.close(); big.close(); probe.close();
  } finally { L.closeAll(); await srv.close(); }
});

test('6b. the real server process survives garbage and prints the banner (child process)', async () => {
  const saveDir = tmpDir();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: '0', HOST_PIN: '5150', CC_SAVE_DIR: saveDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no banner: ' + out)), 8000);
      const iv = setInterval(() => { const m = /localhost:(\d+)\/host/.exec(out); if (m) { clearInterval(iv); clearTimeout(t); resolve(+m[1]); } }, 30);
    });
    assert.match(out, /Phones join at:\s+http:\/\/[^\s]+:\d+\//);
    assert.match(out, /Host PIN:\s+5150/);
    assert.match(out, /firewall/i);
    assert.match(out, /VPN/);
    const url = `http://127.0.0.1:${port}`;
    const c = client(url, { role: 'player', clientId: 'garbage-sender' });
    await c.ready();
    const rng = mulberry32(9);
    for (let i = 0; i < 120; i++) {
      const ev = [...HOST_EVENTS, ...PLAYER_EVENTS][Math.floor(rng() * (HOST_EVENTS.length + PLAYER_EVENTS.length))];
      c.socket.emit(ev, [null, 1, 'x', [], { teamId: 7 }, { text: {} }][i % 6]);
    }
    await sleep(300);
    assert.equal(child.exitCode, null, 'process still running');
    const probe = client(url, { role: 'tv' });
    await probe.ready();
    assert.equal(probe.helloAcks[0].ok, true);
    c.close(); probe.close();
  } finally { child.kill(); }
});

test('7. reset / nextTurn during a spin cancels it; no stale result; lobby not locked', async () => {
  const srv = await boot({ timing: { ...FAST, spinMs: 400 } });
  const L = await lobby(srv, 3, 1);
  try {
    const { h, players } = L;
    await h.ok('host:start');
    await pOk(h, players[h.state.activeTeamId][0], 'spin');
    assert.equal(h.state.phase, 'spinning');
    assert.equal((await players[h.state.activeTeamId][0].emit('spin')).error, 'not-now', 'once per spin window');
    await h.ok('host:resetGame', { keepTeams: true });
    await sleep(600);
    assert.equal(h.state.phase, 'lobby');
    assert.equal(h.state.challenge, null);
    await h.ok('host:createTeam', { name: 'Late' });
    await h.ok('host:start');
    const first = h.state.activeTeamId;
    await pOk(h, players[first][0], 'spin');
    await h.ok('host:nextTurn', { turnId: h.state.turnId });
    const second = h.state.activeTeamId;
    await sleep(600);
    assert.equal(h.state.phase, 'turnIntro');
    assert.equal(h.state.activeTeamId, second);
    assert.notEqual(first, second);
    assert.equal(h.state.challenge, null);
  } finally { L.closeAll(); await srv.close(); }
});

test('8. stale nextTurn is ignored (double click cannot skip a team); rejected in lobby / podium', async () => {
  const srv = await boot();
  const L = await lobby(srv, 3, 1);
  try {
    const { h } = L;
    assert.equal((await h.emit('host:nextTurn', { turnId: h.state.turnId })).error, 'not-now');
    await h.ok('host:start');
    const turnId = h.state.turnId;
    const [r1, r2] = await Promise.all([h.emit('host:nextTurn', { turnId }), h.emit('host:nextTurn', { turnId })]);
    assert.deepEqual([r1.ok, r2.ok].sort(), [false, true]);
    assert.equal([r1, r2].find((r) => !r.ok).error, 'stale-turn');
    await h.waitFor((s) => s.turnIndex === 1, 4000);
    await sleep(50);
    assert.equal(h.state.turnIndex, 1, 'exactly one team advanced');
  } finally { L.closeAll(); await srv.close(); }
});

test('17. full 6-team game over real sockets reaches the podium; every segment type; TV never sees secrets', async () => {
  const srv = await boot();
  const L = await lobby(srv, 6, 3);
  try {
    const { h, tv } = L;
    assert.equal(h.state.settings.rounds, 3);
    assert.equal(h.state.settings.roundBonus, true);
    const seen = await playGame(L, 606);
    assert.equal(h.state.phase, 'podium');
    assert.deepEqual([...seen].sort(), ['allplay', 'dare', 'doubledown', 'grinch', 'hotseat', 'rapidlist', 'showdown', 'sounditout', 'trivia']);
    const pod = await tv.waitFor((s) => s.phase === 'podium' && s.podium, 4000, 'tv podium');
    assert.equal(pod.podium.standings.length, 6);
    for (const s of pod.podium.standings) assert.equal(s.place, 1 + pod.podium.standings.filter((o) => o.score > s.score).length);
    assert.ok(tv.fx.some((e) => e.type === 'podium'));
    for (const t of ['spinStart', 'land', 'points', 'round', 'turn', 'buzz']) assert.ok(tv.fx.some((e) => e.type === t), 'fx ' + t);
    const leaks = checkTvLeaks(h, tv);
    assert.deepEqual(leaks.slice(0, 5), []);
    // every host state carried live directions; the coach never offered a button the server then refused
    assert.ok(h.states.length > 100);
    for (const st of h.states) {
      assert.ok(st.host && st.host.coach && st.host.coach.headline, 'coach headline in ' + st.phase);
      assert.ok(Array.isArray(st.host.coach.actions));
      for (const a of st.host.coach.actions) if (!a.disabled && a.event) assert.ok(a.event === 'host:' + a.event.slice(5) && st.host.can[a.event.slice(5)] !== false, `coach action ${a.id} enabled while host.can.${a.event.slice(5)} is false (${st.phase})`);
    }
    assert.ok(h.states.some((st) => st.challenge && st.challenge.type === 'trivia' && st.challenge.category === 'movies' && st.challenge.movie), 'a Christmas Movies question with its film chip');
    // comedy layer: TV quips (placeholders filled, never the same line twice in the game), react cues, coach punchlines
    const tvQuips = [];
    let prevQuip = null;
    for (const st of tv.states) {
      if (st.quip && st.phase !== 'lobby' && st.quip.id !== prevQuip) tvQuips.push(st.quip);
      prevQuip = st.quip ? st.quip.id : null;
    }
    assert.ok(tvQuips.length > 30, `quips on the TV (${tvQuips.length})`);
    assert.equal(new Set(tvQuips.map((q) => q.id)).size, tvQuips.length, 'no quip repeats within a game');
    for (const q of tvQuips) assert.ok(q.key && q.text && !/\{[a-zA-Z]+\}/.test(q.text), 'placeholders filled: ' + q.text);
    const reacts = tv.fx.filter((e) => e.type === 'react');
    assert.ok(reacts.length > 10, 'react cues');
    for (const e of reacts) assert.ok(['cheer', 'groan', 'gasp', 'laugh'].includes(e.mood) && typeof e.key === 'string', JSON.stringify(e));
    assert.ok(h.states.some((st) => st.quip && st.host.coach.punchline && st.host.coach.punchline.id === st.quip.id && st.host.coach.say.includes(st.quip.text)), 'the coach suggests the punchline');
    assert.ok(pod.podium.awards.length <= 6 && pod.podium.awards.every((a) => a.title && a.name && a.detail && a.art), 'funny awards');
    // every phone ends on the podium with its own team
    for (const p of Object.values(L.players).flat()) await p.waitFor((s) => s.phase === 'podium' && s.myTeam, 4000);
    const lines = pod.podium.standings.map((s) => `${s.place}. ${pod.teams.find((t) => t.id === s.teamId).name} ${s.score}`);
    console.log('    podium: ' + lines.join(' | ') + ' | awards: ' + pod.podium.awards.map((a) => `${a.title}: ${a.name} (${a.detail})`).join('; '));
  } finally { L.closeAll(); await srv.close(); }
});

test('17b. full 2-team and 8-team games over sockets reach the podium', async () => {
  for (const [n, per] of [[2, 2], [8, 2]]) {
    const srv = await boot();
    const L = await lobby(srv, n, per);
    try {
      const seen = await playGame(L, 800 + n);
      assert.equal(L.h.state.phase, 'podium');
      assert.equal(seen.size, 9, `${n} teams: ${[...seen].join(',')}`);
      assert.deepEqual(checkTvLeaks(L.h, L.tv).slice(0, 3), []);
    } finally { L.closeAll(); await srv.close(); }
  }
});

test('server: v2.1 events are routed (soundTest fx on the TV, reorder, previewTarget, peek, swapSecret, vote change)', async () => {
  const srv = await boot();
  const L = await lobby(srv, 3, 2);
  try {
    const { h, tv, teamIds, players } = L;
    await h.ok('host:soundTest');
    for (let i = 0; i < 100 && !tv.fx.some((e) => e.type === 'soundTest'); i++) await sleep(20);
    assert.ok(tv.fx.some((e) => e.type === 'soundTest'), 'soundTest fx reached the TV');
    await h.ok('host:reorderTeams', { order: [teamIds[2], teamIds[0], teamIds[1]] });
    await tv.waitFor((st) => st.teams[0].id === teamIds[2], 4000, 'TV sees the new order');
    await h.ok('host:start');
    const act = h.state.activeTeamId;
    assert.equal(act, teamIds[2]);
    const actP = players[act];
    const otherP = players[teamIds[0]][0];
    assert.equal((await otherP.emit('peek')).error, 'no-secret');
    assert.equal((await otherP.emit('previewTarget', { teamId: act })).error, 'not-your-turn');
    // sound it out: performer peeks, host sees it, swapSecret keeps the performer
    await h.ok('host:forceSegment', { index: 5 });
    await h.waitFor((st) => st.phase === 'challenge' && st.challenge.type === 'sounditout', 4000, 'sound it out');
    const perfId = h.state.challenge.performer.playerId;
    const perf = actP.find((p) => p.state.me && p.state.me.playerId === perfId);
    await perf.waitFor((st) => st.secret && st.can.peek, 4000, 'performer secret');
    const r = await perf.emit('peek');
    assert.deepEqual(r, { ok: true, first: true });
    await h.waitFor((st) => st.host.secretPeeked === true, 4000, 'host sees the peek');
    const before = h.state.host.song.title;
    await h.ok('host:swapSecret');
    assert.notEqual(h.state.host.song.title, before);
    assert.equal(h.state.challenge.performer.playerId, perfId);
    await h.ok('host:endChallenge');
    await h.ok('host:nextTurn', { turnId: h.state.turnId });
    // showdown: previewTarget shows "eyeing" on the TV
    const act2 = h.state.activeTeamId;
    await h.ok('host:forceSegment', { index: 7 });
    await h.waitFor((st) => st.challenge && st.challenge.stage === 'pickRival', 4000, 'pick rival');
    const rival = h.state.challenge.targets[0];
    const p2 = players[act2][0];
    await pOk(h, p2, 'previewTarget', { teamId: rival });
    await tv.waitFor((st) => st.challenge && st.challenge.eyeing && st.challenge.eyeing.teamId === rival, 4000, 'TV eyeing');
    await pOk(h, p2, 'pickTarget', { teamId: rival });
    await h.ok('host:showdownResult', { winner: 'tie' });
    await h.ok('host:nextTurn', { turnId: h.state.turnId });
    // dare vote: one vote per player, changeable while open
    const act3 = h.state.activeTeamId;
    await h.ok('host:forceSegment', { index: 1 });
    await h.waitFor((st) => st.challenge && st.challenge.type === 'dare', 4000, 'dare');
    await h.ok('host:timer', { action: 'start' });
    await h.ok('host:openVote');
    const voter = players[teamIds.find((t) => t !== act3)][0];
    await voter.waitFor((st) => st.can.vote, 4000, 'can vote');
    await pOk(h, voter, 'vote', { choice: 'good' });
    const ch = await voter.emit('vote', { choice: 'nailed' });
    assert.deepEqual(ch, { ok: true, changed: true });
    await tv.waitFor((st) => st.challenge.vote && st.challenge.vote.nailed === 1 && st.challenge.vote.good === 0 && st.challenge.vote.voters === 1, 4000, 'changed vote on TV');
  } finally { L.closeAll(); await srv.close(); }
});

test('server: autosave + resume after restart; host lobby shows saved game; discard', async () => {
  const saveDir = tmpDir();
  const srv = await boot({ autosave: true, saveDebounceMs: 20, saveDir });
  const L = await lobby(srv, 2, 1);
  const clientIds = Object.values(L.players).flat().map((p) => p.hello.clientId);
  try {
    await L.h.ok('host:start');
    await L.h.ok('host:adjustScore', { teamId: 't2', delta: 350 });
    await sleep(150);
  } finally { L.closeAll(); await srv.close(); }
  assert.ok(fs.existsSync(path.join(saveDir, 'autosave.json')));
  const srv2 = await boot({ autosave: true, saveDebounceMs: 20, saveDir });
  try {
    const h = hostOps(client(srv2.url, { role: 'host' }));
    await h.waitFor((s) => s.savedGame && s.savedGame.summary.teams.length === 2, 4000, 'saved game offered');
    assert.equal(h.state.phase, 'lobby');
    assert.equal(h.state.savedGame.summary.teams[1].score, 350);
    const phone = client(srv2.url, { role: 'player', clientId: clientIds[1] });
    await phone.ready();
    await h.ok('host:resume');
    assert.equal(h.state.phase, 'turnIntro');
    assert.equal(h.state.teams[1].score, 350);
    await phone.waitFor((s) => s.me && s.me.teamId === 't2' && s.players.find((p) => p.id === s.me.playerId).connected, 4000, 'phone recognised after resume');
    assert.equal((await h.emit('host:resume')).error, 'no-save');
    h.close(); phone.close();
  } finally { await srv2.close(); }
  // discard
  const srv3 = await boot({ autosave: true, saveDebounceMs: 20, saveDir });
  try {
    const h = hostOps(client(srv3.url, { role: 'host' }));
    await h.waitFor((s) => !!s.savedGame, 4000);
    await h.ok('host:discardSave');
    await h.waitFor((st) => st.savedGame === null, 4000, 'saved game discarded');
    assert.equal(h.state.savedGame, null);
    h.close();
  } finally { await srv3.close(); }
});

test('server: http routes, QR colours, fonts, join IP switching, hello validation', async () => {
  const srv = await boot();
  try {
    const info = await fetch(srv.url + '/api/info').then((r) => r.json());
    assert.match(info.joinUrl, /^http:\/\/[^/]+:\d+\/$/);
    assert.equal(info.port, srv.port);
    const qr = await fetch(srv.url + '/api/qr.svg');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    const svg = await qr.text();
    assert.ok(svg.includes('#FFFFFF') && svg.includes('#1C2333'), 'ink QR on a white gift tag');
    for (const f of ['/fonts/bagel-fat-one/bagel-fat-one-latin-400-normal.woff2', '/fonts/bagel-fat-one/bagel-fat-one-latin-ext-400-normal.woff2', '/fonts/fraunces/fraunces-latin-full-normal.woff2', '/fonts/fraunces/fraunces-latin-full-italic.woff2', '/fonts/figtree/figtree-latin-wght-normal.woff2', '/fonts/big-shoulders-display/big-shoulders-display-latin-wght-normal.woff2', '/fonts/lilita-one/lilita-one-latin-400-normal.woff2', '/fonts/fredoka/fredoka-latin-400-normal.woff2', '/fonts/fredoka/fredoka-latin-500-normal.woff2', '/fonts/fredoka/fredoka-latin-600-normal.woff2', '/fonts/fredoka/fredoka-latin-700-normal.woff2']) {
      const r = await fetch(srv.url + f);
      assert.equal(r.status, 200, f);
      assert.match(r.headers.get('content-type') || '', /font\/woff2/, f);
    }
    assert.equal((await fetch(srv.url + '/fonts/fredoka/../../package.json')).status, 404);
    const red = await fetch(srv.url + '/player', { redirect: 'manual' });
    assert.equal(red.status, 302);
    assert.equal(red.headers.get('location'), '/');
    for (const p of ['/', '/tv', '/host']) assert.equal((await fetch(srv.url + p)).status, 200, p);
    const socketIoClient = await fetch(srv.url + '/socket.io/socket.io.esm.min.js');
    assert.equal(socketIoClient.status, 200, 'socket.io client is served for the pages');
    const h = hostOps(client(srv.url, { role: 'host' }));
    await h.ready();
    assert.equal(h.helloAcks[0].isHost, true, 'loopback is host');
    assert.equal(h.state.host.pin, srv.pin);
    assert.equal((await h.emit('host:setOption', { key: 'joinIp', value: '1.2.3.4' })).error, 'bad-ip');
    if (srv.candidates.length) {
      await h.ok('host:setOption', { key: 'joinIp', value: srv.candidates[0].address });
      assert.equal(h.state.joinUrl, `http://${srv.candidates[0].address}:${srv.port}/`);
    }
    await h.ok('host:setOption', { key: 'sound', value: false });
    assert.equal(h.state.settings.sound, false);
    const tv = client(srv.url, { role: 'tv' });
    await tv.ready();
    assert.equal(tv.state.host, undefined);
    assert.equal((await tv.emit('spin')).error, 'not-player');
    const p = client(srv.url, { role: 'player', clientId: 'short' });
    await sleep(150);
    assert.equal(p.helloAcks[0].error, 'bad-client-id');
    assert.equal((await p.emit('spin')).error, 'hello-first');
    h.close(); tv.close(); p.close();
  } finally { await srv.close(); }
});

test('server: the laptop is recognised as host by loopback or its own LAN address; other devices are not', () => {
  const ifaces = { 'Wi-Fi': [{ family: 'IPv4', address: '10.0.0.235', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }] };
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.235', '::ffff:10.0.0.235', 'FE80::1']) assert.equal(isLocalAddress(a, ifaces), true, a);
  for (const a of ['10.0.0.236', '::ffff:192.168.1.20', '', null, undefined, 42]) assert.equal(isLocalAddress(a, ifaces), false, String(a));
});

test('server: port in use gives a friendly error', async () => {
  const srv = await boot();
  try {
    await assert.rejects(startServer({ port: srv.port, quiet: true, autosave: false }), (e) => e.code === 'EADDRINUSE' && /already in use/.test(e.friendly));
  } finally { await srv.close(); }
});
