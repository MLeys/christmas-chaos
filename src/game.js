'use strict';
/**
 * Christmas Chaos v2 \u2014 the PURE game state machine (no sockets, no fs).
 *
 *   const game = createGame({ content, rng, now, scheduler, timing, onChange, onFx });
 *   game.dispatch({ role: 'player', clientId }, 'spin', {})       -> { ok, error? }
 *   game.dispatch({ role: 'host' }, 'host:judge', { result: 'correct' })
 *
 * Every action has a state guard (phase/stage/who) and a payload validator. The same guards produce the
 * server-computed `can` flags in the views, so a phone only ever shows an action the server will accept.
 * All scoring goes through award(); all delayed work goes through the generation-aware scheduler.
 */
const { drawFrom, isQuickQuestion, contentStats } = require('./content');
const { isMatch } = require('./match');
const { createScheduler } = require('./scheduler');

const TIMING = {
  spinMs: 5000, armMs: 3000, triviaMs: 20000, stealMs: 10000, soundMs: 30000, listMs: 30000,
  hotseatMs: 45000, allPlayMs: 20000, bonusMs: 20000, voteMs: 15000, wagerMs: 30000, finalMs: 45000, warnMs: 5000,
};

const PTS = {
  trivia: { easy: 100, medium: 200, hard: 300 },
  allPlay: 100, allPlayFirst: 50, bonus: 100,
  dare: { nailed: 200, valiant: 100, fail: 0 }, dareBonus: 50,
  showdownWin: 200, showdownTie: 100,
  sound: 200, listEach: 50, listMax: 6, hotseatEach: 50, hotseatQuestions: 6,
  grinch: 150, gift: 100,
};

const CREAM = '#FFF6E5';
const NIGHT = '#0B1F17';
const seg = (index, type, label, lines, color, ink, icon, points, rule, category) =>
  Object.freeze({ index, type, ...(category ? { category } : {}), label, lines, color, ink, icon, points, rule });
const TRIVIA_RULE = 'Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.';
const DARE_RULE = 'One of you performs the dare. Nail it for 200!';
const SEGMENTS = Object.freeze([
  seg(0, 'trivia', 'Christmas Trivia', ['Christmas', 'Trivia'], '#C8232C', CREAM, 'tree-pine', '100\u2013300', TRIVIA_RULE, 'christmas'),
  seg(1, 'dare', 'Dare', ['Dare'], '#F5B82E', '#1A1206', 'drama', '200', DARE_RULE),
  seg(2, 'trivia', 'Pop Culture', ['Pop', 'Culture'], '#1F6FD1', CREAM, 'clapperboard', '100\u2013300', TRIVIA_RULE, 'popculture'),
  seg(3, 'hotseat', 'Hot Seat', ['Hot', 'Seat'], '#D63384', CREAM, 'flame', '50\u2013300', 'One player, alone, 45 seconds: up to 6 quick questions. 50 points each.'),
  seg(4, 'trivia', 'Christmas Trivia', ['Christmas', 'Trivia'], '#C8232C', CREAM, 'tree-pine', '100\u2013300', TRIVIA_RULE, 'christmas'),
  seg(5, 'sounditout', 'Sound It Out', ['Sound', 'It Out'], '#7A4FD3', CREAM, 'music', '200', 'One of you hums a secret song (no words!). Your team has 30 s to name it.'),
  seg(6, 'grinch', 'Grinch Steal', ['Grinch', 'Steal'], CREAM, NIGHT, 'hand-coins', '150', 'Steal 150 points from a team that is ahead of you.'),
  seg(7, 'showdown', 'Showdown', ['Showdown'], '#8FD8FF', NIGHT, 'swords', '200', 'Pick a rival team. One player from each team goes head to head. Winner takes 200.'),
  seg(8, 'dare', 'Dare', ['Dare'], '#F5B82E', '#1A1206', 'drama', '200', DARE_RULE),
  seg(9, 'rapidlist', 'Rapid List', ['Rapid', 'List'], '#0B8A75', CREAM, 'list-checks', '50\u2013300', 'Shout as many answers as you can in 30 s. 50 each, up to 300.'),
  seg(10, 'allplay', 'All Play', ['All', 'Play'], '#F2731D', NIGHT, 'zap', '100+', 'Every team types an answer on a phone. 100 for each right answer, +50 for the first.'),
  seg(11, 'doubledown', 'Double Down', ['Double', 'Down'], '#1E8A4C', CREAM, 'sparkles', '\u00D72', 'Spin again! Everything your team wins this turn is doubled.'),
]);

const MASCOTS = Object.freeze([
  { mascot: 'star', color: '#FF5A4E', colorName: 'red' },
  { mascot: 'bell', color: '#FFC93C', colorName: 'gold' },
  { mascot: 'candy-cane', color: '#5AC8FA', colorName: 'sky' },
  { mascot: 'tree-pine', color: '#7EE081', colorName: 'lime' },
  { mascot: 'gift', color: '#B794FF', colorName: 'violet' },
  { mascot: 'cookie', color: '#FF9F43', colorName: 'orange' },
  { mascot: 'moon', color: '#FF7AB6', colorName: 'pink' },
  { mascot: 'snowflake', color: '#3DDBC4', colorName: 'teal' },
]);
const MASCOT_NAMES = MASCOTS.map((m) => m.mascot);
const PALETTE = MASCOTS.map((m) => m.color);

const TIMER_LABELS = {
  trivia: 'Answer out loud', sound: 'Name that tune', steal: 'Steal', dare: 'Dare', showdown: 'Showdown',
  list: 'Rapid List', hotseat: 'Hot Seat', allplay: 'All Play', bonus: 'Bonus question', vote: 'Room vote',
  wager: 'Wagers', final: 'Final answer',
};
const CATEGORY_LABELS = { christmas: 'Christmas', popculture: 'Pop Culture', mixed: 'Mixed Bag' };
const OTHER_ANSWER = 'Other answer';
const IN_TURN = new Set(['turnIntro', 'spinning', 'challenge', 'turnResult']);
const PLAYING = new Set(['turnIntro', 'spinning', 'challenge', 'turnResult', 'roundBreak', 'finalIntro', 'finalWager', 'finalAnswer', 'finalReveal']);

const MAX_TEAMS = 8;
const MAX_PLAYERS = 120;
const LIMITS = { playerName: 20, teamName: 24, answer: 80 };

function recommendedRounds(teamCount) {
  if (!teamCount) return 6;
  return Math.min(6, Math.max(3, Math.round(20 / teamCount)));
}
function estimateMinutes(teams, rounds) { return Math.round(5 + teams * rounds * 2.6 + 9); }

// control chars, zero-width + bidi override chars (built from escapes so the source stays ASCII)
const CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]', 'g');
/** Strip control characters, collapse whitespace, trim, cap length. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const noop = () => {};
const fmtDelta = (d) => (d > 0 ? '+' : d < 0 ? '\u2212' : '\u00B1') + Math.abs(d);

function freshState() {
  return {
    v: 2,
    gameNo: 1,
    phase: 'lobby',
    settings: { rounds: recommendedRounds(0), autoRounds: true, roundBonus: false, roundBonusAuto: true, sound: true },
    teams: [],
    teamSeq: 0,
    players: {},
    playerSeq: 0,
    clients: {},
    round: 0,
    turnIndex: 0,
    turnSeq: 0,
    turnId: 0,
    lastSegmentIndex: 0,
    spinSeq: 0,
    spin: null,
    challengeSeq: 0,
    challenge: null,
    turn: null,
    roundBreak: null,
    timer: null,
    undo: [],
    undoSeq: 0,
    lastAwards: [],
    awardSeq: 0,
    stats: { picks: {}, buzzes: [], firsts: {}, perf: {} },
    final: null,
    podium: null,
    used: [],
  };
}

function createGame(opts = {}) {
  const content = opts.content || { trivia: [], songs: [], lists: [], dares: [], finals: [], showdowns: [], problems: [] };
  const rng = opts.rng || Math.random;
  const now = opts.now || (() => Date.now());
  const T = { ...TIMING, ...(opts.timing || {}) };
  const sched = opts.scheduler || createScheduler();
  const onChange = opts.onChange || noop;
  const onFx = opts.onFx || noop;
  let S = freshState();
  let used = new Set();
  let joinUrl = opts.joinUrl || '';
  let groupDepth = 0;

  // ---------------------------------------------------------------- helpers
  const fail = (error) => ({ ok: false, error });
  const changed = () => { try { onChange(); } catch (e) { console.error('[game] onChange', e); } };
  const fx = (type, data = {}) => { try { onFx({ type, ...data, at: now() }); } catch (e) { console.error('[game] onFx', e); } };
  const team = (id) => (typeof id === 'string' ? S.teams.find((t) => t.id === id) || null : null);
  const player = (id) => (typeof id === 'string' && hasOwn(S.players, id) ? S.players[id] : null);
  const playersOf = (teamId) => Object.values(S.players).filter((p) => p.teamId === teamId);
  const activeTeamId = () => (IN_TURN.has(S.phase) && S.teams[S.turnIndex] ? S.teams[S.turnIndex].id : null);
  const otherTeamIds = () => S.teams.filter((t) => t.id !== activeTeamId()).map((t) => t.id);
  const clientKey = (clientId) => 'c:' + clientId;
  const ch = () => S.challenge;
  const rint = (n) => Math.min(n - 1, Math.floor(rng() * n));
  const pick = (arr) => arr[rint(arr.length)];
  const teamName = (id) => (team(id) ? team(id).name : 'a team');

  function recomputeAuto() {
    if (S.settings.autoRounds) S.settings.rounds = recommendedRounds(S.teams.length);
    if (S.settings.roundBonusAuto) S.settings.roundBonus = S.teams.length >= 5;
  }

  // ---------------------------------------------------------------- scoring + undo
  function snapshot(label) {
    const c = ch();
    return {
      id: ++S.undoSeq, label, at: now(),
      scores: Object.fromEntries(S.teams.map((t) => [t.id, t.score])),
      challengeId: c ? c.id : null,
      awarded: c ? { ...c.awarded } : null,
      final: S.final ? { awarded: { ...S.final.awarded }, rows: JSON.parse(JSON.stringify(S.final.rows)), done: S.final.done } : null,
    };
  }
  /** Run fn as ONE undo step (all score changes inside are undone together). */
  function group(label, fn) {
    if (groupDepth > 0) return fn();
    const snap = snapshot(label);
    groupDepth++;
    try { return fn(); } finally {
      groupDepth--;
      if (S.teams.some((t) => snap.scores[t.id] !== t.score)) {
        S.undo.push(snap);
        if (S.undo.length > 100) S.undo.shift();
      }
    }
  }
  /**
   * THE scoring function. Applies the Double Down multiplier (only the active team, only positive, only
   * this turn) unless o.mult is given, floors at 0, records undo/lastAwards/fx. Returns the applied delta.
   */
  function award(teamId, base, reason, o = {}) {
    const t = team(teamId);
    base = Math.round(Number(base));
    if (!t || !Number.isFinite(base) || base === 0) return 0;
    const mult = o.mult != null ? o.mult : (base > 0 && S.turn && IN_TURN.has(S.phase) && teamId === activeTeamId() ? S.turn.multiplier : 1);
    const delta = base * mult;
    return group(o.label || `${t.name} ${fmtDelta(delta)} \u00B7 ${reason}`, () => {
      const before = t.score;
      t.score = Math.max(0, before + delta);
      const applied = t.score - before;
      if (applied !== 0) {
        S.lastAwards.push({ id: ++S.awardSeq, teamId, delta: applied, reason, doubled: mult > 1 });
        if (S.lastAwards.length > 12) S.lastAwards.splice(0, S.lastAwards.length - 12);
        fx('points', { teamId, delta: applied, reason, doubled: mult > 1 });
      }
      return applied;
    });
  }
  const multFor = (teamId, base) => (base > 0 && S.turn && teamId === activeTeamId() ? S.turn.multiplier : 1);
  /** Award inside the current challenge and remember it (for results + re-judging). */
  function cAward(teamId, base, reason, o) {
    const c = ch();
    const applied = award(teamId, base, reason, o);
    if (c && applied) c.awarded[teamId] = (c.awarded[teamId] || 0) + applied;
    return applied;
  }
  /** Move a team's total for this challenge to `desired` (already multiplied). */
  function settle(ledger, teamId, desired, reason) {
    const diff = desired - (ledger[teamId] || 0);
    if (!diff) return 0;
    const applied = award(teamId, diff, reason, { mult: 1 });
    ledger[teamId] = (ledger[teamId] || 0) + applied;
    return applied;
  }
  function undo() {
    const snap = S.undo.pop();
    if (!snap) return false;
    for (const t of S.teams) {
      if (!hasOwn(snap.scores, t.id)) continue;
      const d = snap.scores[t.id] - t.score;
      if (d) {
        t.score = snap.scores[t.id];
        S.lastAwards.push({ id: ++S.awardSeq, teamId: t.id, delta: d, reason: 'Undo', doubled: false });
        fx('points', { teamId: t.id, delta: d, reason: 'Undo', doubled: false });
      }
    }
    if (S.lastAwards.length > 12) S.lastAwards.splice(0, S.lastAwards.length - 12);
    const c = ch();
    if (c && snap.challengeId === c.id && snap.awarded) { c.awarded = { ...snap.awarded }; if (c.result) c.result.awards = awardsList(c); }
    if (S.final && snap.final) { S.final.awarded = snap.final.awarded; S.final.rows = snap.final.rows; S.final.done = snap.final.done; }
    if (S.phase === 'podium') S.podium = computePodium();
    return true;
  }
  const awardsList = (c) => Object.entries(c.awarded).filter(([, d]) => d !== 0).map(([teamId, delta]) => ({ teamId, delta }));

  // ---------------------------------------------------------------- timers
  function prepareTimer(kind, ms, autostart) {
    sched.cancel('timer'); sched.cancel('timerWarn');
    S.timer = { kind, label: TIMER_LABELS[kind] || kind, running: false, endsAt: null, durationMs: ms, remainingMs: ms, started: false, ended: false };
    if (autostart) runTimer();
  }
  function runTimer() {
    const t = S.timer;
    if (!t || t.running) return false;
    if (t.ended || t.remainingMs <= 0) { t.remainingMs = t.durationMs; t.ended = false; }
    t.running = true; t.started = true; t.endsAt = now() + t.remainingMs;
    armTimer();
    if (S.challenge) S.challenge.started = true;
    return true;
  }
  function armTimer() {
    const t = S.timer;
    const left = Math.max(0, t.endsAt - now());
    sched.after('timer', left, () => {
      if (S.timer !== t || !t.running) return;
      t.running = false; t.remainingMs = 0; t.endsAt = null; t.ended = true;
      fx('timerEnd', { kind: t.kind });
      onTimerEnd(t.kind);
      changed();
    });
    if (left > T.warnMs + 20) sched.after('timerWarn', left - T.warnMs, () => { if (S.timer === t && t.running) fx('timerWarn', { kind: t.kind }); });
    else sched.cancel('timerWarn');
  }
  function pauseTimer() {
    const t = S.timer;
    if (!t || !t.running) return false;
    t.remainingMs = Math.max(0, t.endsAt - now()); t.running = false; t.endsAt = null;
    sched.cancel('timer'); sched.cancel('timerWarn');
    return true;
  }
  function addTime(sec) {
    const t = S.timer;
    const ms = sec * 1000;
    if (t.running) { t.endsAt += ms; t.durationMs += ms; armTimer(); }
    else if (t.ended) { t.durationMs = ms; t.remainingMs = ms; t.ended = false; runTimer(); }
    else { t.remainingMs += ms; t.durationMs += ms; }
  }
  function stopTimer() { sched.cancel('timer'); sched.cancel('timerWarn'); S.timer = null; }
  function onTimerEnd(kind) {
    const c = ch();
    switch (kind) {
      case 'trivia': if (c && c.type === 'trivia' && c.stage === 'question') { fx('wrong', { teamId: activeTeamId(), timeUp: true }); openSteal(); } break;
      case 'sound': if (c && c.type === 'sounditout' && c.stage === 'perform') { fx('wrong', { teamId: activeTeamId(), timeUp: true }); openSteal(); } break;
      case 'steal': if (c && c.stage === 'steal' && c.buzz && !c.buzz.winner) finish('missed'); break;
      case 'list': if (c && c.type === 'rapidlist' && c.stage === 'list') finish('list'); break;
      case 'hotseat': if (c && c.type === 'hotseat' && c.stage === 'hotseat') finish('hotseat'); break;
      case 'allplay': case 'bonus': if (c && c.stage === 'answering') c.stage = 'marking'; break;
      case 'vote': if (c && c.type === 'dare' && c.stage === 'vote' && c.vote && c.vote.open) closeVote(); break;
      case 'wager': if (S.phase === 'finalWager') startFinalAnswering(); break;
      case 'final': if (S.phase === 'finalAnswer') enterFinalReveal(); break;
      default: break; // dare / showdown: the host judges
    }
  }

  // ---------------------------------------------------------------- content draws
  const copyQ = (q) => ({ id: q.id, category: q.category, difficulty: q.difficulty, question: q.question, answer: q.answer, accept: q.accept || [], hint: q.hint || '', funFact: q.funFact || '' });
  function drawTrivia(category, difficulty, exclude) {
    const pool = content.trivia.filter((q) => q.category === category && q.difficulty === difficulty);
    const q = drawFrom(pool, used, rng, exclude);
    return q ? copyQ(q) : null;
  }
  function drawQuick(exclude) {
    let pool = content.trivia.filter(isQuickQuestion);
    if (!pool.length) pool = content.trivia;
    const q = drawFrom(pool, used, rng, exclude);
    return q ? copyQ(q) : null;
  }
  const draw = (kind, exclude) => drawFrom(content[kind], used, rng, exclude);

  // ---------------------------------------------------------------- players
  function pickPlayer(teamId, exclude = []) {
    const all = playersOf(teamId);
    if (!all.length) return null;
    let pool = all.filter((p) => p.connected && !exclude.includes(p.id));
    if (!pool.length) pool = all.filter((p) => !exclude.includes(p.id));
    if (!pool.length) pool = all;
    const picks = (p) => S.stats.picks[p.id] || 0;
    const min = Math.min(...pool.map(picks));
    pool = pool.filter((p) => picks(p) === min);
    const p = pick(pool);
    S.stats.picks[p.id] = picks(p) + 1;
    return { playerId: p.id, name: p.name, teamId };
  }
  const unpick = (perf) => { if (perf && S.stats.picks[perf.playerId]) S.stats.picks[perf.playerId]--; };
  function calledUp(c) {
    const ids = [c.performer, c.partner, c.rival].filter((x) => x && x.playerId).map((x) => x.playerId);
    if (ids.length) fx('calledUp', { playerIds: ids, kind: c.type });
  }

  // ---------------------------------------------------------------- turn flow
  function beginTurn() {
    S.phase = 'turnIntro';
    S.turnId = ++S.turnSeq;
    S.turn = { multiplier: 1 };
    S.spin = null;
    S.challenge = null;
    S.timer = null;
    fx('turn', { teamId: activeTeamId(), turnId: S.turnId, round: S.round });
  }
  function startGame() {
    sched.bump();
    for (const t of S.teams) t.score = 0;
    S.round = 1; S.turnIndex = 0;
    S.undo = []; S.lastAwards = []; S.final = null; S.podium = null; S.roundBreak = null;
    S.stats = { picks: {}, buzzes: [], firsts: {}, perf: {} };
    fx('round', { round: 1 });
    beginTurn();
  }
  function startSpin(by, forced) {
    const index = Number.isInteger(forced) ? forced : rint(SEGMENTS.length);
    sched.cancel('arm'); stopTimer();
    S.challenge = null;
    S.phase = 'spinning';
    const id = ++S.spinSeq;
    S.spin = { id, segmentIndex: index, startedAt: now(), durationMs: T.spinMs, by };
    sched.after('spin', T.spinMs, () => {
      if (S.phase !== 'spinning' || !S.spin || S.spin.id !== id) return; // stale
      land();
      changed();
    });
    fx('spinStart', { segmentIndex: index, startedAt: S.spin.startedAt, durationMs: T.spinMs, teamId: activeTeamId(), by });
  }
  function land() {
    const idx = S.spin.segmentIndex;
    S.lastSegmentIndex = idx;
    S.spin = null;
    S.phase = 'challenge';
    S.challenge = buildChallenge(idx);
    fx('land', { segmentIndex: idx, segmentType: SEGMENTS[idx].type, teamId: activeTeamId() });
  }
  function newChallenge(type, segmentIndex, rule) {
    return { id: ++S.challengeSeq, type, segmentIndex, stage: '', rule, points: 0, awarded: {}, revealed: false, hintShown: false, started: false, result: null };
  }
  function buildChallenge(idx) {
    const sg = SEGMENTS[idx];
    const c = newChallenge(sg.type, idx, sg.rule);
    const act = activeTeamId();
    S.challenge = c;
    switch (sg.type) {
      case 'trivia':
        c.category = sg.category; c.stage = 'pickDifficulty';
        break;
      case 'dare':
        setupDare(c, draw('dares'));
        break;
      case 'hotseat': {
        c.points = PTS.hotseatEach * PTS.hotseatQuestions;
        c.performer = pickPlayer(act);
        const qs = [];
        for (let i = 0; i < PTS.hotseatQuestions; i++) { const q = drawQuick(qs.map((x) => x.id)); if (q) qs.push(q); }
        c.hs = { questions: qs, index: 0, results: [] };
        c.stage = 'hotseat';
        prepareTimer('hotseat', T.hotseatMs, false);
        calledUp(c);
        break;
      }
      case 'sounditout': {
        const s = draw('songs');
        c.points = PTS.sound;
        c.performer = pickPlayer(act);
        c.song = { id: s.id, title: s.title, artist: s.artist || '', accept: s.accept || [], hint: s.hint || '' };
        c.stage = 'perform';
        prepareTimer('sound', T.soundMs, false);
        calledUp(c);
        break;
      }
      case 'grinch': {
        const me = team(act);
        const ahead = S.teams.filter((t) => t.id !== act && t.score > me.score).map((t) => t.id);
        if (ahead.length) {
          c.points = PTS.grinch * S.turn.multiplier;
          c.targets = ahead;
          c.stage = 'pickTarget';
        } else {
          // Leader: the Grinch's heart grows \u2014 gift 100 to the last-place team instead.
          const others = S.teams.filter((t) => t.id !== act);
          const low = Math.min(...others.map((t) => t.score));
          const to = others.find((t) => t.score === low);
          c.points = PTS.gift;
          c.gift = { toTeamId: to.id, amount: PTS.gift };
          c.targets = [];
          cAward(to.id, PTS.gift, 'Grinch gift', { mult: 1 });
          finish('gift');
        }
        break;
      }
      case 'showdown':
        c.points = PTS.showdownWin;
        c.targets = otherTeamIds();
        c.stage = 'pickRival';
        break;
      case 'rapidlist': {
        const l = draw('lists');
        c.points = PTS.listEach * PTS.listMax;
        c.list = { id: l.id, prompt: l.prompt, answers: l.answers.slice(), note: l.note || '' };
        c.ticked = [];
        c.stage = 'list';
        prepareTimer('list', T.listMs, false);
        break;
      }
      case 'allplay':
        c.points = PTS.allPlay;
        c.q = drawQuick();
        c.subs = {};
        c.stage = 'answering';
        prepareTimer('allplay', T.allPlayMs, true);
        break;
      case 'doubledown':
        S.turn.multiplier = 2;
        c.stage = 'spinAgain';
        fx('doubleDown', { teamId: act });
        break;
      default: break;
    }
    return c;
  }
  function setupDare(c, d) {
    const act = activeTeamId();
    unpick(c.performer); unpick(c.partner);
    c.points = PTS.dare.nailed;
    c.dare = { id: d.id, title: d.title, who: d.who, instructions: d.instructions, time: d.time, props: d.props || [], judge: d.judge, tags: d.tags || [], secret: d.secret || null };
    c.secretValue = d.secret && d.secret.options && d.secret.options.length ? pick(d.secret.options) : null;
    c.performer = pickPlayer(act);
    c.partner = d.who === 'pair' ? pickPlayer(act, c.performer ? [c.performer.playerId] : []) : null;
    if (c.partner && c.performer && c.partner.playerId === c.performer.playerId) { unpick(c.partner); c.partner = null; }
    c.stage = 'perform';
    c.vote = null;
    prepareTimer('dare', d.time * 1000, false);
    calledUp(c);
  }

  /** Mini-game over: stage 'done', phase 'turnResult' (round-break bonus keeps phase 'roundBreak'). */
  function finish(kind, text) {
    const c = ch();
    if (!c) return;
    stopTimer(); sched.cancel('arm');
    if (c.buzz) { c.buzz.open = false; c.buzz.armingUntil = null; }
    if (c.vote) c.vote.open = false;
    c.stage = 'done';
    c.revealed = true;
    c.result = { kind, awards: awardsList(c), ...(text ? { text } : {}) };
    recordPerformance(c);
    if (S.phase === 'challenge') S.phase = 'turnResult';
  }
  function refreshResult(c) { if (c.result) { c.result.awards = awardsList(c); recordPerformance(c); } }
  function recordPerformance(c) {
    const act = activeTeamId();
    let ids = [];
    let pts = 0;
    if (c.type === 'dare' || c.type === 'sounditout' || c.type === 'hotseat') {
      ids = [c.performer, c.partner].filter((x) => x && x.playerId).map((x) => x.playerId);
      pts = (c.type === 'sounditout' ? (c.result && c.result.kind === 'correct' ? c.awarded[act] || 0 : 0) : c.awarded[act] || 0);
    } else if (c.type === 'showdown' && c.winnerSide) {
      if (c.winnerSide === 'active' && c.performer) { ids = [c.performer.playerId]; pts = c.awarded[act] || 0; }
      if (c.winnerSide === 'rival' && c.rival && c.rival.playerId) { ids = [c.rival.playerId]; pts = c.awarded[c.rival.teamId] || 0; }
      if (c.winnerSide === 'tie') { ids = [c.performer, c.rival].filter((x) => x && x.playerId).map((x) => x.playerId); pts = PTS.showdownTie; }
    }
    if (ids.length) S.stats.perf[c.id] = { playerIds: ids, points: Math.max(0, pts), kind: c.type, nailed: c.type === 'dare' && c.dareResult && c.dareResult.result === 'nailed' };
  }

  // trivia / sound-it-out steal
  function openSteal() {
    const c = ch();
    stopTimer();
    c.stage = 'steal';
    c.stealPoints = Math.round(c.points / 2);
    c.buzz = { open: false, armingUntil: null, eligibleTeamIds: [], lockedTeamIds: [], winner: null, attempts: 0 };
    armSteal();
  }
  function armSteal() {
    const c = ch();
    const b = c.buzz;
    b.eligibleTeamIds = otherTeamIds().filter((id) => !b.lockedTeamIds.includes(id));
    if (!b.eligibleTeamIds.length) { finish('missed'); return; }
    stopTimer();
    b.open = false; b.winner = null; b.attempts++;
    b.armingUntil = now() + T.armMs;
    const cid = c.id;
    sched.after('arm', T.armMs, () => {
      const cc = ch();
      if (!cc || cc.id !== cid || cc.stage !== 'steal' || cc.buzz.winner || cc.buzz.open) return;
      cc.buzz.open = true; cc.buzz.armingUntil = null;
      prepareTimer('steal', T.stealMs, true);
      fx('armed', { eligibleTeamIds: cc.buzz.eligibleTeamIds });
      changed();
    });
  }

  function closeVote() {
    const c = ch();
    c.vote.open = false;
    const tally = voteTally(c);
    c.vote.result = tally.nailed >= tally.good && tally.nailed > 0 ? 'nailed' : 'valiant';
    stopTimer();
    fx('vote', { closed: true, ...tally, result: c.vote.result });
    judgeDare(c.vote.result, false);
  }
  function voteTally(c) {
    const vals = Object.values((c.vote && c.vote.votes) || {});
    return { nailed: vals.filter((v) => v === 'nailed').length, good: vals.filter((v) => v === 'good').length, voters: vals.length };
  }
  function eligibleVoters() {
    const act = activeTeamId();
    return Object.values(S.players).filter((p) => p.teamId && p.teamId !== act && p.connected).length;
  }
  function judgeDare(result, bonus) {
    const c = ch();
    const act = activeTeamId();
    const base = PTS.dare[result] + (bonus ? PTS.dareBonus : 0);
    c.dareResult = { result, bonus: !!bonus };
    group(`${teamName(act)} \u00B7 Dare: ${result}`, () => settle(c.awarded, act, base * multFor(act, base), 'Dare'));
    if (c.stage !== 'done') finish(result);
    else { c.result.kind = result; refreshResult(c); }
    fx(result === 'fail' ? 'wrong' : 'correct', { teamId: act });
  }

  function settleList() {
    const c = ch();
    const act = activeTeamId();
    const base = Math.min(c.ticked.length, PTS.listMax) * PTS.listEach;
    settle(c.awarded, act, base * multFor(act, base), 'Rapid List');
    refreshResult(c);
  }

  function effCorrect(sub) { return sub.override != null ? sub.override : sub.autoCorrect; }
  function settleAllPlay() {
    const c = ch();
    const isBonus = c.type === 'bonus';
    const subs = c.subs;
    const correct = Object.entries(subs).filter(([, s]) => effCorrect(s)).sort((a, b) => a[1].at - b[1].at);
    const first = !isBonus && correct.length ? correct[0][0] : null;
    c.firstTeamId = first;
    if (first) S.stats.firsts[c.id] = subs[first].by; else delete S.stats.firsts[c.id];
    group(isBonus ? 'Bonus question' : 'All Play', () => {
      const ids = new Set([...Object.keys(subs), ...Object.keys(c.awarded)]);
      for (const id of ids) {
        if (!team(id)) continue;
        const ok = subs[id] && effCorrect(subs[id]);
        const base = ok ? (isBonus ? PTS.bonus : PTS.allPlay + (id === first ? PTS.allPlayFirst : 0)) : 0;
        settle(c.awarded, id, base * (isBonus ? 1 : multFor(id, base)), isBonus ? 'Bonus question' : 'All Play');
      }
    });
    refreshResult(c);
  }

  function startBonus() {
    const c = newChallenge('bonus', null, 'Bonus round: every team types an answer. 100 for each right answer.');
    c.points = PTS.bonus;
    c.q = drawQuick();
    c.subs = {};
    c.stage = 'answering';
    S.challenge = c;
    prepareTimer('bonus', T.bonusMs, true);
  }

  function endTurn() {
    sched.bump();
    S.timer = null; S.spin = null; S.challenge = null; S.turn = null;
    S.turnIndex++;
    if (S.turnIndex < S.teams.length) { beginTurn(); return; }
    S.turnId = ++S.turnSeq; // any stale nextTurn is now ignored
    if (S.round < S.settings.rounds) {
      S.phase = 'roundBreak';
      S.roundBreak = { round: S.round, nextRound: S.round + 1, finalNext: S.round + 1 === S.settings.rounds, bonusDone: false };
    } else enterFinal();
  }
  function nextRound() {
    S.challenge = null; S.timer = null; S.roundBreak = null;
    if (S.round >= S.settings.rounds) { enterFinal(); return; }
    S.round++;
    S.turnIndex = 0;
    fx('round', { round: S.round });
    beginTurn();
  }

  // final chaos
  function enterFinal() {
    sched.bump();
    S.phase = 'finalIntro';
    S.roundBreak = null; S.challenge = null; S.timer = null; S.turn = null;
    const q = draw('finals');
    S.final = {
      q: { id: q.id, category: q.category, question: q.question, answer: q.answer, accept: q.accept || [] },
      categoryLabel: CATEGORY_LABELS[q.category] || titleCase(q.category),
      wagers: {}, subs: {}, order: [], rows: {}, current: null, awarded: {}, done: false,
    };
    fx('final', {});
  }
  function maxWager(teamId) { const t = team(teamId); return Math.max(t ? t.score : 0, 300); }
  function startFinalAnswering() {
    for (const t of S.teams) if (!S.final.wagers[t.id]) S.final.wagers[t.id] = { amount: 0, locked: true, by: null, name: null, at: now(), auto: true };
    for (const t of S.teams) { const w = S.final.wagers[t.id]; w.locked = true; w.amount = Math.min(w.amount, maxWager(t.id)); }
    S.phase = 'finalAnswer';
    prepareTimer('final', T.finalMs, true);
  }
  function enterFinalReveal() {
    stopTimer();
    S.phase = 'finalReveal';
    const order = S.teams.map((t, i) => ({ t, i })).sort((a, b) => a.t.score - b.t.score || a.i - b.i).map((x) => x.t.id);
    S.final.order = order;
    S.final.rows = {};
    for (const id of order) {
      const sub = S.final.subs[id];
      const w = S.final.wagers[id] || { amount: 0 };
      S.final.rows[id] = { text: sub ? sub.text : '', by: sub ? sub.name : null, wager: w.amount, autoCorrect: sub ? sub.autoCorrect : false, override: sub && sub.override != null ? sub.override : null, revealed: false, judged: false, correct: null, delta: null, before: team(id).score, after: null };
    }
    S.final.current = null;
  }
  function judgeFinalRow(teamId) {
    const row = S.final.rows[teamId];
    const ok = row.override != null ? row.override : row.autoCorrect;
    group(`${teamName(teamId)} \u00B7 Final Chaos`, () => settle(S.final.awarded, teamId, ok ? row.wager : -row.wager, 'Final Chaos'));
    row.judged = true; row.correct = ok; row.delta = S.final.awarded[teamId] || 0; row.after = team(teamId).score;
    fx(ok ? 'correct' : 'wrong', { teamId });
    S.final.done = S.final.order.every((id) => S.final.rows[id].judged);
  }
  /** Step the reveal: judge the current row (auto/host mark) if unjudged, else reveal the next team, else podium. */
  function finalRevealNext() {
    const F = S.final;
    if (F.current && !F.rows[F.current].judged) { judgeFinalRow(F.current); return; }
    const next = F.order.find((id) => !F.rows[id].revealed);
    if (next) { F.rows[next].revealed = true; F.current = next; fx('reveal', { teamId: next }); return; }
    enterPodium();
  }
  function computePodium() {
    const sorted = S.teams.map((t, i) => ({ t, i })).sort((a, b) => b.t.score - a.t.score || a.i - b.i).map((x) => x.t);
    const standings = sorted.map((t) => ({ teamId: t.id, score: t.score, place: 1 + S.teams.filter((o) => o.score > t.score).length }));
    return { standings, awards: computeAwards() };
  }
  function computeAwards() {
    const awards = [];
    const fast = {};
    for (const pid of S.stats.buzzes) { fast[pid] = fast[pid] || { buzz: 0, first: 0 }; fast[pid].buzz++; }
    for (const pid of Object.values(S.stats.firsts)) { if (!pid) continue; fast[pid] = fast[pid] || { buzz: 0, first: 0 }; fast[pid].first++; }
    const fastest = Object.entries(fast).filter(([pid]) => player(pid)).sort((a, b) => (b[1].buzz + b[1].first) - (a[1].buzz + a[1].first) || b[1].buzz - a[1].buzz)[0];
    if (fastest) {
      const [pid, f] = fastest;
      const parts = [];
      if (f.buzz) parts.push(`${f.buzz} buzz${f.buzz === 1 ? '' : 'es'} won`);
      if (f.first) parts.push(`${f.first} first answer${f.first === 1 ? '' : 's'}`);
      awards.push({ key: 'fastestFinger', title: 'Fastest Finger', playerId: pid, name: player(pid).name, teamId: player(pid).teamId, detail: parts.join(' \u00B7 ') });
    }
    const perf = {};
    for (const p of Object.values(S.stats.perf)) for (const pid of p.playerIds) {
      perf[pid] = perf[pid] || { count: 0, points: 0, dares: 0 };
      perf[pid].count++; perf[pid].points += p.points; if (p.kind === 'dare') perf[pid].dares++;
    }
    const star = Object.entries(perf).filter(([pid, v]) => player(pid) && v.points > 0).sort((a, b) => b[1].points - a[1].points || b[1].count - a[1].count)[0];
    if (star) {
      const [pid, v] = star;
      const what = v.dares === v.count ? `${v.count} dare${v.count === 1 ? '' : 's'}` : `${v.count} performance${v.count === 1 ? '' : 's'}`;
      awards.push({ key: 'starPerformer', title: 'Star Performer', playerId: pid, name: player(pid).name, teamId: player(pid).teamId, detail: `${what} \u00B7 ${v.points} pts` });
    }
    return awards;
  }
  function enterPodium() {
    sched.bump();
    S.timer = null;
    S.phase = 'podium';
    S.podium = computePodium();
    fx('podium', {});
  }

  function resetGame(keepTeams) {
    sched.bump();
    const old = S;
    S = freshState();
    S.gameNo = old.gameNo + 1;
    S.teamSeq = old.teamSeq; S.playerSeq = old.playerSeq; S.challengeSeq = old.challengeSeq; S.spinSeq = old.spinSeq;
    S.turnSeq = old.turnSeq; S.undoSeq = old.undoSeq; S.awardSeq = old.awardSeq;
    S.settings = { ...old.settings };
    S.players = old.players; S.clients = old.clients;
    S.lastSegmentIndex = old.lastSegmentIndex;
    if (keepTeams) S.teams = old.teams.map((t) => ({ ...t, score: 0 }));
    else for (const p of Object.values(S.players)) p.teamId = null;
    recomputeAuto();
  }

  // ---------------------------------------------------------------- action table
  // guard(ctx) -> true | errorCode   (state only; used for `can` flags)
  // validate(p, ctx) -> true | errorCode  (payload)
  const ok = true;
  const inChallenge = (type, stages) => {
    const c = ch();
    if (!c) return 'not-now';
    const types = Array.isArray(type) ? type : [type];
    if (!types.includes(c.type)) return 'not-now';
    const phaseOk = c.type === 'bonus' ? S.phase === 'roundBreak' : (S.phase === 'challenge' || (S.phase === 'turnResult' && c.stage === 'done'));
    if (!phaseOk) return 'not-now';
    return stages.includes(c.stage) ? ok : 'not-now';
  };
  const needTeam = (ctx) => (!ctx.player ? 'not-joined' : !ctx.team ? 'no-team' : ok);
  const needActive = (ctx) => { const n = needTeam(ctx); if (n !== ok) return n; return ctx.team.id === activeTeamId() ? ok : 'not-your-turn'; };
  const all = (...checks) => { for (const c of checks) { const r = typeof c === 'function' ? c() : c; if (r !== ok) return r; } return ok; };
  const canSpinNow = () => (S.phase === 'turnIntro' || (S.phase === 'challenge' && ch() && ch().type === 'doubledown' && ch().stage === 'spinAgain') ? ok : 'not-now');
  const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
  const isBool = (v) => typeof v === 'boolean';

  const ACTIONS = {
    // ------------------------------------------------ players
    join: {
      player: true,
      guard: (ctx) => (ctx.player && ctx.team && S.phase !== 'lobby' ? 'ask-host' : ok),
      validate: (p) => (!cleanText(p.name, LIMITS.playerName) ? 'name-required' : !team(p.teamId) ? 'no-such-team' : ok),
      run: (ctx, p) => {
        const name = cleanText(p.name, LIMITS.playerName);
        let pl = ctx.player;
        if (!pl) {
          if (Object.keys(S.players).length >= MAX_PLAYERS) return fail('game-full');
          const id = 'p' + (++S.playerSeq);
          pl = { id, name, teamId: p.teamId, connected: true, joinedAt: now() };
          S.players[id] = pl;
          S.clients[clientKey(ctx.actor.clientId)] = id;
        } else {
          pl.name = name; pl.teamId = p.teamId; pl.connected = true;
        }
        fx('joined', { playerId: pl.id, teamId: pl.teamId });
        return { ok: true, me: { playerId: pl.id, name: pl.name, teamId: pl.teamId } };
      },
    },
    spin: {
      player: true,
      guard: (ctx) => all(() => needActive(ctx), canSpinNow),
      run: (ctx) => startSpin({ playerId: ctx.player.id, name: ctx.player.name }),
    },
    pickDifficulty: {
      player: true,
      guard: (ctx) => all(() => needActive(ctx), () => inChallenge('trivia', ['pickDifficulty'])),
      validate: (p) => (hasOwn(PTS.trivia, p.level) ? ok : 'bad-level'),
      run: (ctx, p) => pickDifficulty(p.level, { playerId: ctx.player.id, name: ctx.player.name }),
    },
    buzz: {
      player: true,
      guard: (ctx) => all(() => needTeam(ctx), () => inChallenge(['trivia', 'sounditout'], ['steal']), () => {
        const b = ch().buzz;
        if (b.armingUntil) return 'arming';
        if (!b.open || b.winner) return 'not-now';
        if (b.lockedTeamIds.includes(ctx.team.id)) return 'locked-out';
        return b.eligibleTeamIds.includes(ctx.team.id) ? ok : 'not-eligible';
      }),
      run: (ctx) => {
        const c = ch();
        c.buzz.winner = { playerId: ctx.player.id, name: ctx.player.name, teamId: ctx.team.id };
        c.buzz.open = false;
        stopTimer();
        S.stats.buzzes.push(ctx.player.id);
        fx('buzz', { teamId: ctx.team.id, name: ctx.player.name, playerId: ctx.player.id });
      },
    },
    pickTarget: {
      player: true,
      guard: (ctx) => all(() => needActive(ctx), () => (inChallenge('grinch', ['pickTarget']) === ok || inChallenge('showdown', ['pickRival']) === ok ? ok : 'not-now')),
      validate: (p) => (typeof p.teamId === 'string' && ch().targets.includes(p.teamId) ? ok : 'bad-target'),
      run: (ctx, p) => pickTarget(p.teamId),
    },
    submitAnswer: {
      player: true,
      guard: (ctx) => all(() => needTeam(ctx), () => (inChallenge('allplay', ['answering']) === ok || inChallenge('bonus', ['answering']) === ok || S.phase === 'finalAnswer' ? ok : 'not-now')),
      validate: (p) => (cleanText(p.text, LIMITS.answer) ? ok : 'empty-answer'),
      run: (ctx, p) => {
        const text = cleanText(p.text, LIMITS.answer);
        const target = S.phase === 'finalAnswer' ? S.final : ch();
        const q = target.q;
        target.subs[ctx.team.id] = { text, by: ctx.player.id, name: ctx.player.name, at: now(), autoCorrect: isMatch(text, q.answer, q.accept), override: null };
        fx('answered', { teamId: ctx.team.id });
      },
    },
    wager: {
      player: true,
      guard: (ctx) => all(() => needTeam(ctx), () => (S.phase === 'finalWager' ? ok : 'not-now')),
      validate: (p, ctx) => (isInt(p.amount) && p.amount >= 0 && p.amount <= maxWager(ctx.team.id) ? ok : 'bad-amount'),
      run: (ctx, p) => {
        S.final.wagers[ctx.team.id] = { amount: p.amount, locked: true, by: ctx.player.id, name: ctx.player.name, at: now() };
        fx('wagered', { teamId: ctx.team.id });
      },
    },
    vote: {
      player: true,
      guard: (ctx) => all(() => needTeam(ctx), () => inChallenge('dare', ['vote']), () => {
        const c = ch();
        if (!c.vote.open) return 'not-now';
        if (ctx.team.id === activeTeamId()) return 'not-eligible';
        return hasOwn(c.vote.votes, ctx.player.id) ? 'already-voted' : ok;
      }),
      validate: (p) => (p.choice === 'nailed' || p.choice === 'good' ? ok : 'bad-choice'),
      run: (ctx, p) => {
        const c = ch();
        c.vote.votes[ctx.player.id] = p.choice;
        fx('vote', voteTally(c));
        if (Object.keys(c.vote.votes).length >= eligibleVoters()) closeVote();
      },
    },

    // ------------------------------------------------ host: lobby / setup
    'host:createTeam': {
      guard: () => (S.phase !== 'lobby' ? 'not-now' : S.teams.length >= MAX_TEAMS ? 'too-many-teams' : ok),
      validate: (p) => {
        const name = cleanText(p.name, LIMITS.teamName);
        if (!name) return 'name-required';
        if (S.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) return 'name-taken';
        if (p.mascot !== undefined && p.mascot !== null && !MASCOT_NAMES.includes(p.mascot)) return 'bad-mascot';
        if (p.mascot && S.teams.some((t) => t.mascot === p.mascot)) return 'mascot-taken';
        if (p.color !== undefined && p.color !== null && !PALETTE.includes(p.color)) return 'bad-color';
        return ok;
      },
      run: (ctx, p) => {
        const mascot = p.mascot || MASCOT_NAMES.find((m) => !S.teams.some((t) => t.mascot === m));
        const color = p.color || MASCOTS.find((m) => m.mascot === mascot).color;
        const t = { id: 't' + (++S.teamSeq), name: cleanText(p.name, LIMITS.teamName), mascot, color, score: 0 };
        S.teams.push(t);
        recomputeAuto();
        return { ok: true, teamId: t.id };
      },
    },
    'host:updateTeam': {
      guard: () => ok,
      validate: (p) => {
        const t = team(p.teamId);
        if (!t) return 'no-such-team';
        if (p.name !== undefined) {
          const name = cleanText(p.name, LIMITS.teamName);
          if (!name) return 'name-required';
          if (S.teams.some((o) => o !== t && o.name.toLowerCase() === name.toLowerCase())) return 'name-taken';
        }
        if (p.mascot !== undefined && (!MASCOT_NAMES.includes(p.mascot) || S.teams.some((o) => o !== t && o.mascot === p.mascot))) return 'bad-mascot';
        if (p.color !== undefined && !PALETTE.includes(p.color)) return 'bad-color';
        return ok;
      },
      run: (ctx, p) => {
        const t = team(p.teamId);
        if (p.name !== undefined) t.name = cleanText(p.name, LIMITS.teamName);
        if (p.mascot !== undefined) { t.mascot = p.mascot; if (p.color === undefined) t.color = MASCOTS.find((m) => m.mascot === p.mascot).color; }
        if (p.color !== undefined) t.color = p.color;
      },
    },
    'host:removeTeam': {
      guard: () => (S.phase === 'lobby' ? ok : 'not-now'),
      validate: (p) => (team(p.teamId) ? ok : 'no-such-team'),
      run: (ctx, p) => {
        const t = team(p.teamId);
        S.teams = S.teams.filter((x) => x !== t);
        for (const pl of Object.values(S.players)) if (pl.teamId === t.id) pl.teamId = null;
        recomputeAuto();
        fx('teamRemoved', { teamId: t.id, name: t.name });
      },
    },
    'host:movePlayer': {
      guard: () => ok,
      validate: (p) => (!player(p.playerId) ? 'no-such-player' : p.teamId !== null && !team(p.teamId) ? 'no-such-team' : ok),
      run: (ctx, p) => { player(p.playerId).teamId = p.teamId; },
    },
    'host:kickPlayer': {
      guard: () => ok,
      validate: (p) => (player(p.playerId) ? ok : 'no-such-player'),
      run: (ctx, p) => {
        delete S.players[p.playerId];
        for (const k of Object.keys(S.clients)) if (S.clients[k] === p.playerId) delete S.clients[k];
      },
    },
    'host:setRounds': {
      guard: () => (S.phase === 'lobby' || IN_TURN.has(S.phase) || S.phase === 'roundBreak' ? ok : 'not-now'),
      validate: (p) => (!isInt(p.n) || p.n < 1 || p.n > 8 ? 'bad-rounds' : S.phase !== 'lobby' && p.n < S.round ? 'below-current-round' : ok),
      run: (ctx, p) => {
        S.settings.rounds = p.n; S.settings.autoRounds = false;
        if (S.roundBreak) S.roundBreak.finalNext = S.roundBreak.nextRound >= p.n;
      },
    },
    'host:setOption': {
      guard: () => ok,
      validate: (p) => ((p.key === 'roundBonus' || p.key === 'sound') && isBool(p.value) ? ok : 'bad-option'),
      run: (ctx, p) => {
        if (p.key === 'roundBonus') { S.settings.roundBonus = p.value; S.settings.roundBonusAuto = false; }
        if (p.key === 'sound') S.settings.sound = p.value;
      },
    },
    'host:start': {
      guard: () => (S.phase !== 'lobby' ? 'not-now' : S.teams.length < 2 ? 'need-two-teams' : ok),
      run: () => startGame(),
    },

    // ------------------------------------------------ host: turn
    'host:spin': { guard: () => canSpinNow(), run: () => startSpin(null) },
    'host:forceSegment': {
      guard: () => canSpinNow(),
      validate: (p) => (isInt(p.index) && p.index >= 0 && p.index < SEGMENTS.length ? ok : 'bad-index'),
      run: (ctx, p) => startSpin(null, p.index),
    },
    'host:pickDifficulty': {
      guard: () => inChallenge('trivia', ['pickDifficulty']),
      validate: (p) => (hasOwn(PTS.trivia, p.level) ? ok : 'bad-level'),
      run: (ctx, p) => pickDifficulty(p.level, null),
    },
    'host:pickTarget': {
      guard: () => (inChallenge('grinch', ['pickTarget']) === ok || inChallenge('showdown', ['pickRival']) === ok ? ok : 'not-now'),
      validate: (p) => (typeof p.teamId === 'string' && ch().targets.includes(p.teamId) ? ok : 'bad-target'),
      run: (ctx, p) => pickTarget(p.teamId),
    },
    'host:judge': {
      guard: () => {
        const c = ch();
        if (inChallenge('trivia', ['question']) === ok || inChallenge('sounditout', ['perform']) === ok) return ok;
        if (inChallenge(['trivia', 'sounditout'], ['steal']) === ok && c.buzz.winner) return ok;
        return 'not-now';
      },
      validate: (p) => (p.result === 'correct' || p.result === 'wrong' ? ok : 'bad-result'),
      run: (ctx, p) => judge(p.result),
    },
    'host:openSteal': {
      guard: () => {
        const c = ch();
        if (inChallenge('trivia', ['question']) === ok || inChallenge('sounditout', ['perform']) === ok) return ok;
        if (inChallenge(['trivia', 'sounditout'], ['steal']) !== ok) return 'not-now';
        const b = c.buzz;
        if (b.open || b.winner || b.armingUntil) return 'not-now';
        return otherTeamIds().some((id) => !b.lockedTeamIds.includes(id)) ? ok : 'no-teams-left';
      },
      run: () => {
        const c = ch();
        if (c.stage === 'steal') armSteal();
        else { fx('wrong', { teamId: activeTeamId() }); openSteal(); }
      },
    },
    'host:reveal': {
      guard: () => {
        const c = ch();
        if (!c || c.revealed && c.type !== 'rapidlist') return 'not-now';
        if (inChallenge(['trivia'], ['question', 'steal', 'done']) === ok) return c.revealed ? 'not-now' : ok;
        if (inChallenge(['sounditout'], ['perform', 'steal', 'done']) === ok) return c.revealed ? 'not-now' : ok;
        if (inChallenge(['dare'], ['perform', 'vote', 'done']) === ok) return c.secretValue && !c.revealed ? ok : 'not-now';
        if (inChallenge(['rapidlist'], ['list', 'done']) === ok) return c.listRevealed ? 'not-now' : ok;
        return 'not-now';
      },
      run: () => {
        const c = ch();
        if (c.type === 'dare') { c.revealed = true; return; }
        if (c.type === 'rapidlist') { c.listRevealed = true; if (c.stage !== 'done') finish('list'); return; }
        finish('missed');
        fx('reveal', {});
      },
    },
    'host:showHint': {
      guard: () => {
        const c = ch();
        if (inChallenge('trivia', ['question']) === ok) return c.q.hint && !c.hintShown ? ok : 'no-hint';
        if (inChallenge('sounditout', ['perform']) === ok) return c.song.hint && !c.hintShown ? ok : 'no-hint';
        return 'not-now';
      },
      run: () => { const c = ch(); c.hintShown = true; c.points = Math.round(c.points / 2); },
    },
    'host:timer': {
      guard: () => (S.timer ? ok : 'no-timer'),
      validate: (p) => {
        const t = S.timer;
        if (p.action === 'start') return t.running ? 'already-running' : ok;
        if (p.action === 'pause') return t.running ? ok : 'not-running';
        if (p.action === 'resume') return !t.running && t.started && !t.ended ? ok : 'not-paused';
        if (p.action === 'add') return p.seconds === undefined || (isInt(p.seconds) && p.seconds >= 1 && p.seconds <= 300) ? ok : 'bad-seconds';
        return 'bad-action';
      },
      run: (ctx, p) => {
        if (p.action === 'start' || p.action === 'resume') runTimer();
        else if (p.action === 'pause') pauseTimer();
        else addTime(p.seconds === undefined ? 10 : p.seconds);
      },
    },
    'host:rerollPerformer': {
      guard: () => {
        const c = ch();
        if (inChallenge('dare', ['perform']) === ok || inChallenge('sounditout', ['perform']) === ok) return c.performer ? ok : 'no-players';
        if (inChallenge('hotseat', ['hotseat']) === ok) return c.performer && c.hs.index === 0 ? ok : 'not-now';
        if (inChallenge('showdown', ['battle']) === ok) return ok;
        return 'not-now';
      },
      validate: (p) => (p.side === undefined || p.side === 'active' || p.side === 'rival' ? ok : 'bad-side'),
      run: (ctx, p) => {
        const c = ch();
        const act = activeTeamId();
        if (c.type === 'showdown') {
          if (p.side !== 'rival') { const old = c.performer; const np = pickPlayer(act, old ? [old.playerId] : []); if (np) { unpick(old); c.performer = np; } }
          if (p.side !== 'active') { const old = c.rival; const np = pickPlayer(old.teamId, old.playerId ? [old.playerId] : []); if (np) { unpick(old.playerId ? old : null); c.rival = np; } }
        } else {
          const old = c.performer;
          const np = pickPlayer(act, [old.playerId, c.partner && c.partner.playerId].filter(Boolean));
          if (np) { unpick(old); c.performer = np; }
          if (c.type === 'dare' && c.dare.secret) { const rest = c.dare.secret.options.filter((o) => o !== c.secretValue); if (rest.length) c.secretValue = pick(rest); }
        }
        calledUp(c);
      },
    },
    'host:swapQuestion': {
      guard: () => {
        if (S.phase === 'finalIntro' || S.phase === 'finalWager') return ok;
        if (inChallenge('trivia', ['question']) === ok || inChallenge('sounditout', ['perform']) === ok || inChallenge('dare', ['perform']) === ok
          || inChallenge('showdown', ['battle']) === ok || inChallenge(['allplay', 'bonus'], ['answering']) === ok) return ok;
        if (inChallenge('rapidlist', ['list']) === ok) return ch().ticked.length ? 'not-now' : ok;
        if (inChallenge('hotseat', ['hotseat']) === ok) return ch().hs.index < ch().hs.questions.length ? ok : 'not-now';
        return 'not-now';
      },
      run: () => swapQuestion(),
    },
    'host:endChallenge': {
      guard: () => (S.phase === 'challenge' && ch() && ch().type !== 'doubledown' && ch().stage !== 'done' ? ok : 'not-now'),
      run: () => finish('skipped'),
    },
    'host:dareResult': {
      guard: () => inChallenge('dare', ['perform', 'vote', 'done']),
      validate: (p) => (hasOwn(PTS.dare, p.result) && (p.bonus === undefined || isBool(p.bonus)) ? ok : 'bad-result'),
      run: (ctx, p) => {
        const c = ch();
        if (c.vote && c.vote.open) { c.vote.open = false; c.vote.result = c.vote.result || null; }
        judgeDare(p.result, p.bonus === undefined ? !!(c.dareResult && c.dareResult.bonus) : p.bonus);
      },
    },
    'host:openVote': {
      guard: () => (inChallenge('dare', ['perform']) === ok ? ok : 'not-now'),
      run: () => {
        const c = ch();
        c.stage = 'vote';
        c.vote = { open: true, endsAt: now() + T.voteMs, votes: {}, result: null };
        prepareTimer('vote', T.voteMs, true);
        fx('vote', { opened: true, nailed: 0, good: 0, voters: 0 });
      },
    },
    'host:closeVote': {
      guard: () => (inChallenge('dare', ['vote']) === ok && ch().vote.open ? ok : 'not-now'),
      run: () => closeVote(),
    },
    'host:showdownResult': {
      guard: () => inChallenge('showdown', ['battle']),
      validate: (p) => (['active', 'rival', 'tie'].includes(p.winner) ? ok : 'bad-winner'),
      run: (ctx, p) => {
        const c = ch();
        const act = activeTeamId();
        c.winnerSide = p.winner;
        group(`Showdown \u00B7 ${p.winner}`, () => {
          if (p.winner === 'active') cAward(act, PTS.showdownWin, 'Showdown');
          else if (p.winner === 'rival') cAward(c.rival.teamId, PTS.showdownWin, 'Showdown');
          else { cAward(act, PTS.showdownTie, 'Showdown tie'); cAward(c.rival.teamId, PTS.showdownTie, 'Showdown tie'); }
        });
        finish(p.winner === 'tie' ? 'tie' : 'win');
        fx('correct', { teamId: p.winner === 'rival' ? c.rival.teamId : act });
      },
    },
    'host:listTick': {
      guard: () => inChallenge('rapidlist', ['list', 'done']),
      validate: (p) => (typeof p.answer !== 'string' || !ch().list.answers.includes(p.answer) ? 'bad-answer' : ch().ticked.includes(p.answer) ? 'already-ticked' : ok),
      run: (ctx, p) => {
        const c = ch();
        if (S.timer && !S.timer.started && c.stage === 'list') runTimer();
        c.ticked.push(p.answer); settleList();
      },
    },
    'host:listUntick': {
      guard: () => inChallenge('rapidlist', ['list', 'done']),
      validate: (p) => (typeof p.answer === 'string' && ch().ticked.includes(p.answer) ? ok : 'bad-answer'),
      run: (ctx, p) => { const c = ch(); c.ticked.splice(c.ticked.lastIndexOf(p.answer), 1); settleList(); },
    },
    'host:listOther': {
      guard: () => inChallenge('rapidlist', ['list', 'done']),
      run: () => { const c = ch(); if (S.timer && !S.timer.started && c.stage === 'list') runTimer(); c.ticked.push(OTHER_ANSWER); settleList(); },
    },
    'host:hotseatMark': {
      guard: () => (inChallenge('hotseat', ['hotseat']) === ok && ch().hs.index < ch().hs.questions.length ? ok : 'not-now'),
      validate: (p) => (!['correct', 'wrong', 'pass'].includes(p.result) ? 'bad-result' : p.index !== undefined && p.index !== ch().hs.index ? 'stale-question' : ok),
      run: (ctx, p) => {
        const c = ch();
        if (S.timer && !S.timer.started) runTimer();
        c.hs.results.push(p.result);
        if (p.result === 'correct') cAward(activeTeamId(), PTS.hotseatEach, 'Hot Seat');
        fx(p.result === 'correct' ? 'correct' : 'wrong', { teamId: activeTeamId(), small: true });
        c.hs.index++;
        if (c.hs.index >= c.hs.questions.length) finish('hotseat');
      },
    },
    'host:markAnswer': {
      guard: () => (inChallenge(['allplay', 'bonus'], ['answering', 'marking', 'done']) === ok || S.phase === 'finalReveal' || S.phase === 'finalAnswer' ? ok : 'not-now'),
      validate: (p) => {
        if (!team(p.teamId)) return 'no-such-team';
        if (!isBool(p.correct)) return 'bad-correct';
        if (S.phase === 'finalAnswer') return S.final.subs[p.teamId] ? ok : 'no-answer';
        if (S.phase === 'finalReveal') return ok;
        return ch().subs[p.teamId] ? ok : 'no-answer';
      },
      run: (ctx, p) => {
        if (S.phase === 'finalAnswer') { S.final.subs[p.teamId].override = p.correct; return; }
        if (S.phase === 'finalReveal') {
          const row = S.final.rows[p.teamId];
          row.override = p.correct;
          if (row.revealed) judgeFinalRow(p.teamId);
          return;
        }
        const c = ch();
        c.subs[p.teamId].override = p.correct;
        if (c.stage === 'done') settleAllPlay();
      },
    },
    'host:revealAnswers': {
      guard: () => inChallenge(['allplay', 'bonus'], ['answering', 'marking']),
      run: () => revealAnswers(),
    },
    'host:finalStartAnswering': {
      guard: () => (S.phase === 'finalWager' ? ok : 'not-now'),
      run: () => startFinalAnswering(),
    },
    'host:finalRevealNext': {
      guard: () => (S.phase === 'finalReveal' ? ok : 'not-now'),
      run: () => finalRevealNext(),
    },
    'host:adjustScore': {
      guard: () => (S.phase === 'lobby' ? 'not-now' : ok),
      validate: (p) => (!team(p.teamId) ? 'no-such-team' : !isInt(p.delta) || p.delta === 0 || Math.abs(p.delta) > 10000 ? 'bad-delta' : ok),
      run: (ctx, p) => {
        award(p.teamId, p.delta, 'Host adjustment', { mult: 1 });
        if (S.phase === 'podium') S.podium = computePodium();
      },
    },
    'host:undo': {
      guard: () => (S.undo.length ? ok : 'nothing-to-undo'),
      run: () => { undo(); },
    },
    'host:nextTurn': {
      guard: () => (IN_TURN.has(S.phase) ? ok : 'not-now'),
      validate: (p) => (p.turnId === S.turnId ? ok : 'stale-turn'),
      run: () => endTurn(),
    },
    'host:continue': {
      guard: () => (continueAction() ? ok : 'not-now'),
      run: () => continueAction()(),
    },
    'host:resetGame': {
      guard: () => ok,
      validate: (p) => (p.keepTeams === undefined || isBool(p.keepTeams) ? ok : 'bad-option'),
      run: (ctx, p) => resetGame(p.keepTeams !== false),
    },
  };

  function pickDifficulty(level, by) {
    const c = ch();
    c.difficulty = level;
    c.points = PTS.trivia[level];
    c.q = drawTrivia(c.category, level);
    c.pickedBy = by;
    c.stage = 'question';
    prepareTimer('trivia', T.triviaMs, true);
  }
  function pickTarget(targetId) {
    const c = ch();
    const act = activeTeamId();
    if (c.type === 'grinch') {
      const victim = team(targetId);
      const amount = Math.min(PTS.grinch * S.turn.multiplier, victim.score);
      group(`${teamName(act)} steals ${amount} from ${victim.name}`, () => {
        cAward(victim.id, -amount, 'Grinch Steal', { mult: 1 });
        cAward(act, amount, 'Grinch Steal', { mult: 1 });
      });
      c.steal = { from: victim.id, to: act, amount };
      fx('steal', { from: victim.id, to: act, amount });
      finish('steal');
    } else {
      c.rival = pickPlayer(targetId) || { teamId: targetId, playerId: null, name: null };
      c.performer = pickPlayer(act);
      const s = draw('showdowns');
      c.showdown = { id: s.id, title: s.title, instructions: s.instructions, time: s.time, props: s.props || [], winner: s.winner, tags: s.tags || [] };
      c.stage = 'battle';
      prepareTimer('showdown', s.time * 1000, false);
      calledUp(c);
    }
  }
  function judge(result) {
    const c = ch();
    const act = activeTeamId();
    if (c.stage === 'steal') {
      const w = c.buzz.winner;
      if (result === 'correct') {
        cAward(w.teamId, c.stealPoints, 'Steal');
        fx('correct', { teamId: w.teamId, steal: true });
        finish('stolen');
      } else {
        c.buzz.lockedTeamIds.push(w.teamId);
        c.buzz.winner = null;
        c.buzz.eligibleTeamIds = c.buzz.eligibleTeamIds.filter((id) => id !== w.teamId);
        fx('wrong', { teamId: w.teamId, steal: true });
        if (!otherTeamIds().some((id) => !c.buzz.lockedTeamIds.includes(id))) finish('missed');
      }
      return;
    }
    if (result === 'correct') {
      cAward(act, c.points, c.type === 'trivia' ? (c.category === 'christmas' ? 'Christmas Trivia' : 'Pop Culture') : 'Sound It Out');
      fx('correct', { teamId: act });
      finish('correct');
    } else {
      fx('wrong', { teamId: act });
      openSteal();
    }
  }
  function revealAnswers() {
    const c = ch();
    stopTimer();
    c.stage = 'done';
    settleAllPlay();
    finish(c.type === 'bonus' ? 'bonus' : 'allplay');
    if (c.type === 'bonus' && S.roundBreak) S.roundBreak.bonusDone = true;
    fx('reveal', {});
  }
  function swapQuestion() {
    const c = ch();
    if (S.phase === 'finalIntro' || S.phase === 'finalWager') {
      const q = draw('finals', [S.final.q.id]);
      S.final.q = { id: q.id, category: q.category, question: q.question, answer: q.answer, accept: q.accept || [] };
      S.final.categoryLabel = CATEGORY_LABELS[q.category] || titleCase(q.category);
      return;
    }
    switch (c.type) {
      case 'trivia': c.q = drawTrivia(c.category, c.difficulty, [c.q.id]); c.hintShown = false; c.points = PTS.trivia[c.difficulty]; prepareTimer('trivia', T.triviaMs, true); break;
      case 'sounditout': { const s = draw('songs', [c.song.id]); c.song = { id: s.id, title: s.title, artist: s.artist || '', accept: s.accept || [], hint: s.hint || '' }; c.hintShown = false; c.points = PTS.sound; prepareTimer('sound', T.soundMs, false); break; }
      case 'dare': setupDare(c, draw('dares', [c.dare.id])); break;
      case 'showdown': { const s = draw('showdowns', [c.showdown.id]); c.showdown = { id: s.id, title: s.title, instructions: s.instructions, time: s.time, props: s.props || [], winner: s.winner, tags: s.tags || [] }; prepareTimer('showdown', s.time * 1000, false); break; }
      case 'rapidlist': { const l = draw('lists', [c.list.id]); c.list = { id: l.id, prompt: l.prompt, answers: l.answers.slice(), note: l.note || '' }; prepareTimer('list', T.listMs, false); break; }
      case 'hotseat': { const q = drawQuick(c.hs.questions.map((x) => x.id)); if (q) c.hs.questions[c.hs.index] = q; break; }
      case 'allplay': case 'bonus': c.q = drawQuick([c.q.id]); c.subs = {}; prepareTimer(c.type, c.type === 'bonus' ? T.bonusMs : T.allPlayMs, true); break;
      default: break;
    }
  }
  /** What "Continue" does right now (null = nothing). */
  function continueAction() {
    const c = ch();
    switch (S.phase) {
      case 'roundBreak':
        if (!c) {
          if (S.settings.roundBonus && !S.roundBreak.bonusDone && S.round < S.settings.rounds) return startBonus;
          return nextRound;
        }
        if (c.stage === 'answering') return () => { stopTimer(); c.stage = 'marking'; };
        if (c.stage === 'marking') return revealAnswers;
        return nextRound;
      case 'challenge':
        if (!c) return null;
        if (c.type === 'allplay' && c.stage === 'answering') return () => { stopTimer(); c.stage = 'marking'; };
        if (c.type === 'allplay' && c.stage === 'marking') return revealAnswers;
        if (c.type === 'rapidlist' && c.stage === 'list') return () => finish('list');
        if (c.type === 'hotseat' && c.stage === 'hotseat') return () => finish('hotseat');
        if (c.type === 'dare' && c.stage === 'vote' && c.vote.open) return closeVote;
        return null;
      case 'finalIntro': return () => { S.phase = 'finalWager'; prepareTimer('wager', T.wagerMs, true); };
      case 'finalWager': return startFinalAnswering;
      case 'finalAnswer': return enterFinalReveal;
      case 'finalReveal': return finalRevealNext;
      default: return null;
    }
  }

  // ---------------------------------------------------------------- dispatch
  function makeCtx(actor) {
    const a = isObj(actor) ? actor : {};
    let pl = null;
    if (a.role === 'player' && typeof a.clientId === 'string') pl = player(S.clients[clientKey(a.clientId)]);
    return { actor: a, player: pl, team: pl ? team(pl.teamId) : null };
  }
  function dispatch(actor, type, payload) {
    try {
      if (typeof type !== 'string' || !hasOwn(ACTIONS, type)) return fail('unknown-event');
      const def = ACTIONS[type];
      const a = isObj(actor) ? actor : {};
      if (def.player) { if (a.role !== 'player' || typeof a.clientId !== 'string' || !a.clientId || a.clientId.length > 100) return fail('not-player'); }
      else if (a.role !== 'host') return fail('not-host');
      const p = isObj(payload) ? payload : {};
      const ctx = makeCtx(a);
      const g = def.guard(ctx);
      if (g !== ok) return fail(g || 'not-now');
      if (def.validate) { const v = def.validate(p, ctx); if (v !== ok) return fail(v || 'bad-payload'); }
      const r = def.run(ctx, p);
      changed();
      if (r && r.ok === false) return r;
      return r && typeof r === 'object' ? { ok: true, ...r } : { ok: true };
    } catch (err) {
      console.error('[game] action', type, 'failed:', err && err.stack || err);
      return fail('server-error');
    }
  }
  function playerCan(playerId) {
    const pl = player(playerId);
    const out = {};
    for (const k of ['spin', 'pickDifficulty', 'buzz', 'pickTarget', 'submitAnswer', 'wager', 'vote']) {
      try { out[k] = !!pl && ACTIONS[k].guard({ actor: { role: 'player' }, player: pl, team: team(pl.teamId) }) === ok; } catch { out[k] = false; }
    }
    return out;
  }
  function hostCan() {
    const out = {};
    for (const k of Object.keys(ACTIONS)) {
      if (!k.startsWith('host:')) continue;
      try { out[k.slice(5)] = ACTIONS[k].guard({ actor: { role: 'host' } }) === ok; } catch { out[k.slice(5)] = false; }
    }
    return out;
  }

  // ---------------------------------------------------------------- identity
  function playerIdForClient(clientId) {
    if (typeof clientId !== 'string') return null;
    const id = S.clients[clientKey(clientId)];
    return id && hasOwn(S.players, id) ? id : null;
  }
  function setClientConnected(clientId, connected) {
    const id = playerIdForClient(clientId);
    if (!id) return;
    const p = S.players[id];
    if (p.connected !== !!connected) { p.connected = !!connected; changed(); }
  }

  // ---------------------------------------------------------------- persistence
  function serialize() {
    const copy = JSON.parse(JSON.stringify(S));
    copy.used = [...used];
    if (copy.timer && copy.timer.running) { copy.timer.remainingMs = Math.max(0, S.timer.endsAt - now()); copy.timer.running = false; copy.timer.endsAt = null; }
    copy.savedAt = now();
    return copy;
  }
  function summary(data) {
    const d = data || S;
    return {
      savedAt: d.savedAt || now(), phase: d.phase, round: d.round, totalRounds: d.settings && d.settings.rounds,
      teams: (d.teams || []).map((t) => ({ name: t.name, score: t.score })),
      players: Object.keys(d.players || {}).length,
    };
  }
  function isValidSave(d) {
    return isObj(d) && d.v === 2 && Array.isArray(d.teams) && isObj(d.players) && isObj(d.clients) && typeof d.phase === 'string' && isObj(d.settings);
  }
  function restore(data) {
    if (!isValidSave(data)) return false;
    sched.bump();
    const fresh = freshState();
    S = { ...fresh, ...JSON.parse(JSON.stringify(data)) };
    delete S.savedAt;
    S.stats = { ...fresh.stats, ...(S.stats || {}) };
    used = new Set(Array.isArray(data.used) ? data.used : []);
    S.used = [];
    for (const p of Object.values(S.players)) p.connected = false;
    // re-establish transient things
    if (S.phase === 'spinning' && S.spin) land();
    if (S.timer) { S.timer.running = false; S.timer.endsAt = null; if (S.timer.remainingMs <= 0) S.timer.ended = true; }
    const c = S.challenge;
    if (c && c.buzz && c.stage === 'steal' && !c.buzz.open && c.buzz.armingUntil) armSteal();
    if (c && c.vote && c.vote.open) c.vote.endsAt = null;
    changed();
    return true;
  }

  function titleCase(s) { return String(s || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()); }

  /** The one performer-only secret for a player, or null. */
  function playerSecret(playerId) {
    const c = ch();
    if (!c || !playerId || c.stage === 'done') return null;
    const isPerformer = (c.performer && c.performer.playerId === playerId) || (c.partner && c.partner.playerId === playerId);
    if (!isPerformer) return null;
    if (c.type === 'sounditout') return { label: 'Hum this song. No words!', value: c.song.title, detail: c.song.artist || '' };
    if (c.type === 'dare' && c.secretValue) return { label: c.dare.secret.label, value: c.secretValue, detail: '' };
    return null;
  }

  return {
    get state() { return S; },
    get used() { return used; },
    content,
    segments: SEGMENTS,
    mascots: MASCOTS,
    timing: T,
    points: PTS,
    now,
    dispatch,
    playerCan,
    hostCan,
    playerIdForClient,
    setClientConnected,
    activeTeamId,
    maxWager,
    eligibleVoters,
    voteTally: () => (S.challenge && S.challenge.vote ? voteTally(S.challenge) : null),
    playerSecret,
    effCorrect,
    undoInfo: () => ({ canUndo: S.undo.length > 0, label: S.undo.length ? S.undo[S.undo.length - 1].label : null, depth: S.undo.length }),
    contentStats: () => contentStats(content, used),
    get joinUrl() { return joinUrl; },
    setJoinUrl(u) { joinUrl = String(u || ''); changed(); },
    serialize,
    restore,
    summary,
    isValidSave,
    estimateMinutes: () => estimateMinutes(S.teams.length, S.settings.rounds),
    // test hooks
    _award: award,
  };
}

module.exports = { createGame, SEGMENTS, MASCOTS, PTS, TIMING, recommendedRounds, estimateMinutes, cleanText, LIMITS, OTHER_ANSWER };
