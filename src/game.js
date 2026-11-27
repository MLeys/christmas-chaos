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
const { drawFrom, isQuickQuestion, contentStats, triviaPool, QUIP_ANSWER_KEYS } = require('./content');
const { matchKind } = require('./match');
const { createScheduler } = require('./scheduler');
const { isPluralTeam, subject } = require('./grammar');

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

// North Pole Workshop palette (docs/design/NORTH-POLE.md §1, §3; the approved TV concept's wheel). Clients
// draw these exactly. ink = label colour on the slot fill; art = the Fluent 3D illustration id
// (/assets/art/<art>.png) drawn near the rim and on the category chip; icon = the small Lucide fallback glyph.
const WHITE = '#FFFFFF';
const INK = '#1C2333';
const seg = (index, type, label, lines, color, ink, icon, art, points, rule, category, extra) =>
  Object.freeze({ index, type, ...(category ? { category } : {}), label, lines, color, ink, icon, art, points, rule, ...(extra || {}) });
const TRIVIA_RULE = 'Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.';
const DARE_RULE = 'One of you performs the dare. Nail it for 200!';
// Optional drawing hint: pattern 'candy' = 45deg candy-cane stripes (stripe colour on white) with a white
// label pill (color is the pill/base colour, ink the label colour).
const SEGMENTS = Object.freeze([
  seg(0, 'trivia', 'Christmas Trivia', ['Christmas', 'Trivia'], '#D42A2A', WHITE, 'tree-pine', 'tree', '100\u2013300', TRIVIA_RULE, 'christmas'),
  seg(1, 'dare', 'Dare', ['Dare'], '#EDB321', INK, 'drama', 'masks', '200', DARE_RULE),
  seg(2, 'trivia', 'Pop Culture', ['Pop', 'Culture'], '#2E6FD1', WHITE, 'clapperboard', 'clapper', '100\u2013300', TRIVIA_RULE, 'popculture'),
  seg(3, 'hotseat', 'Hot Seat', ['Hot', 'Seat'], '#E9558A', WHITE, 'flame', 'fire', '50\u2013300', 'One player, alone, 45 seconds: up to 6 quick questions. 50 points each.'),
  seg(4, 'trivia', 'Christmas Movies', ['Christmas', 'Movies'], '#9E1B32', WHITE, 'popcorn', 'popcorn', '100\u2013300', TRIVIA_RULE, 'movies'),
  seg(5, 'sounditout', 'Sound It Out', ['Sound', 'It Out'], '#7B4BC9', WHITE, 'music', 'music', '200', 'One of you hums a secret song (no words!). Your team has 30 s to name it.'),
  seg(6, 'grinch', 'Grinch Steal', ['Grinch', 'Steal'], '#7CB518', INK, 'hand-coins', 'money', '150', 'Steal 150 points from a team that is ahead of you.'),
  seg(7, 'showdown', 'Showdown', ['Show', 'Down'], '#8ECAE6', INK, 'swords', 'boxing', '200', 'Pick a rival team. One player from each team goes head to head. Winner takes 200.'),
  seg(8, 'dare', 'Dare', ['Dare'], '#EDB321', INK, 'drama', 'masks', '200', DARE_RULE),
  seg(9, 'rapidlist', 'Rapid List', ['Rapid', 'List'], '#1F7A4A', WHITE, 'list-checks', 'list', '50\u2013300', 'Shout as many answers as you can in 30 s. 50 each, up to 300.'),
  seg(10, 'allplay', 'All Play', ['All', 'Play'], '#F28C28', INK, 'zap', 'zap', '100+', 'Every team types an answer on a phone. 100 for each right answer, +50 for the first.'),
  seg(11, 'doubledown', 'Double Down', ['Double', 'Down'], WHITE, INK, 'sparkles', 'sparkles', '\u00D72', 'Spin again! Everything your team wins this turn is doubled.', undefined, { pattern: 'candy', stripe: '#D42A2A' }),
]);

// Team mascots (3D art ids, /assets/art/<mascot>.png) in offer order, each paired with a team accent colour
// that reads on white (tile accent, stocking, splash). The first team created gets the reindeer + candy red.
const MASCOTS = Object.freeze([
  { mascot: 'deer', color: '#D42A2A', colorName: 'red' },
  { mascot: 'tree', color: '#1F7A4A', colorName: 'green' },
  { mascot: 'bell', color: '#EDB321', colorName: 'gold' },
  { mascot: 'gift', color: '#2E6FD1', colorName: 'blue' },
  { mascot: 'santa', color: '#7B4BC9', colorName: 'violet' },
  { mascot: 'snowman', color: '#F28C28', colorName: 'orange' },
  { mascot: 'cookie', color: '#E9558A', colorName: 'pink' },
  { mascot: 'star', color: '#0F8C8C', colorName: 'teal' },
]);
const MASCOT_NAMES = MASCOTS.map((m) => m.mascot);
const PALETTE = MASCOTS.map((m) => m.color);

const TIMER_LABELS = {
  trivia: 'Answer out loud', sound: 'Name that tune', steal: 'Steal', dare: 'Dare', showdown: 'Showdown',
  list: 'Rapid List', hotseat: 'Hot Seat', allplay: 'All Play', bonus: 'Bonus question', vote: 'Room vote',
  wager: 'Wagers', final: 'Final answer',
};
const CATEGORY_LABELS = { christmas: 'Christmas', popculture: 'Pop Culture', movies: 'Christmas Movies', mixed: 'Mixed Bag' };
const TRIVIA_LABELS = { christmas: 'Christmas Trivia', popculture: 'Pop Culture', movies: 'Christmas Movies' };
const OTHER_ANSWER = 'Other answer';
const IN_TURN = new Set(['turnIntro', 'spinning', 'challenge', 'turnResult']);
const PLAYING = new Set(['turnIntro', 'spinning', 'challenge', 'turnResult', 'roundBreak', 'finalIntro', 'finalWager', 'finalAnswer', 'finalReveal']);

// ---- comedy layer (docs/design/COMEDY.md §2)
/** The TV's react cue for each quip moment (fx {type:'react', mood}). Moments not listed get no react. */
const MOODS = Object.freeze({
  correct: 'cheer', correctHard: 'cheer', doubleDown: 'cheer', wrong: 'groan', wrongEasy: 'groan', timeUp: 'groan',
  stealWon: 'gasp', stealMissed: 'groan', nobodyBuzzed: 'groan', dareNailed: 'cheer', dareValiant: 'cheer', dareFail: 'laugh',
  voteClose: 'gasp', showdownWin: 'cheer', showdownTie: 'cheer', hotseatPerfect: 'cheer', hotseatZero: 'groan',
  listBig: 'cheer', listSmall: 'groan', grinchSteal: 'gasp', grinchGift: 'cheer', leadChange: 'gasp', bigComeback: 'cheer',
  lastPlaceCheer: 'cheer', finalAllIn: 'gasp', finalZeroBet: 'laugh', finalCorrect: 'cheer', finalWrong: 'groan',
  podium: 'cheer', undo: 'laugh', pickEasy: 'laugh', pickHard: 'gasp',
});
/** Funny podium awards: max 6 shown; when more are earned the last ones in PICK order drop out. */
const AWARD_MAX = 6;
const AWARD_PICK = ['fastestFinger', 'starPerformer', 'lumpOfCoal', 'grinchOfTheYear', 'comebackKid', 'silentNight', 'rudolph'];
const AWARD_ORDER = ['fastestFinger', 'starPerformer', 'grinchOfTheYear', 'comebackKid', 'rudolph', 'silentNight', 'lumpOfCoal']; // coal = the finale
const AWARD_INFO = Object.freeze({
  fastestFinger: { title: 'Fastest Finger', art: 'zap' },
  starPerformer: { title: 'Star Performer', art: 'masks' },
  lumpOfCoal: { title: 'Lump of Coal Award', art: 'snowman' },
  grinchOfTheYear: { title: 'Grinch of the Year', art: 'money' },
  silentNight: { title: 'Silent Night Award', art: 'moon' },
  comebackKid: { title: 'Comeback Kid', art: 'sled' },
  rudolph: { title: 'Rudolph Award', art: 'deer' },
});
/** Small seeded PRNG (mulberry32) for the quip stream, so quip picks never shift the game's content draws. */
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));
const fmtNum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
/** "A", "A and B", "A, B and C" */
const joinNames = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

const PLAYER_CAN = ['spin', 'pickDifficulty', 'buzz', 'pickTarget', 'previewTarget', 'submitAnswer', 'wager', 'vote', 'peek'];
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
    lastSpin: null,      // {segmentIndex, teamId, by} of the most recent landed spin (TV "spun by" line)
    seen: [],            // challenge types already played this game (first time = explain the rules)
    prevRanks: null,     // {teamId: rank} at the previous round break (round-break movement arrows)
    challengeSeq: 0,
    challenge: null,
    turn: null,
    roundBreak: null,
    timer: null,
    undo: [],
    undoSeq: 0,
    lastAwards: [],
    awardSeq: 0,
    stats: freshStats(),
    final: null,
    podium: null,
    used: [],
    quip: null,          // {id, key, text, tone, teamId} the current TV quip (COMEDY.md §2), null between moments
    quipUsed: [],        // quip ids used this game: a line never repeats within a game
    quipNight: [],       // quip ids used tonight (kept across "Play again"): unused lines are preferred
    comedy: { leader: null }, // the last sole leader announced (leadChange)
  };
}
/**
 * Award stats. Event logs (buzzes, chances) only grow; per-challenge records (perf, firsts, ch) are recomputed from the
 * challenge whenever it is (re)judged or undone, so a re-judge or an undo never double counts.
 */
function freshStats() {
  return {
    picks: {}, buzzes: [], firsts: {}, perf: {},
    ch: {},          // challengeId -> {wrongTeams, wrongPlayers, stolen:{teamId:pts}, stealPlayers, perfect:playerId|null}
    chances: {},     // "challengeId:attempt" -> playerIds who could buzz when the steal armed (Silent Night)
    checkpoints: {}, // round -> {ranks:{teamId:rank}, scores:{teamId:score}} at the end of each round (Rudolph, Comeback Kid)
  };
}

function createGame(opts = {}) {
  const content = opts.content || { trivia: [], songs: [], lists: [], dares: [], finals: [], showdowns: [], problems: [] };
  const rng = opts.rng || Math.random;
  // the quip stream is seeded from the game rng once, then runs on its own (quips never shift content draws)
  const qrng = typeof opts.quipRng === 'function' ? opts.quipRng : seededRng(Math.floor(rng() * 4294967296));
  const quipBank = isObj(content.quips) ? content.quips : {};
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
  const changed = () => {
    settleQuip();
    try { onChange(); } catch (e) { console.error('[game] onChange', e); }
  };
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

  /** {teamId: rank} with shared ranks for ties (1, 1, 3). */
  function rankNow() {
    const out = {};
    for (const t of S.teams) out[t.id] = 1 + S.teams.filter((o) => o.score > t.score).length;
    return out;
  }

  function recomputeAuto() {
    if (S.settings.autoRounds) S.settings.rounds = recommendedRounds(S.teams.length);
    if (S.settings.roundBonusAuto) S.settings.roundBonus = S.teams.length >= 5;
  }

  // ---------------------------------------------------------------- comedy: quips + react cues (COMEDY.md §1–2)
  // moment(keys, vars) picks an unused line for the first key that has one whose placeholders can all be filled,
  // puts it on the TV (S.quip) and fires the react fx. Any other moment change clears the quip (settleQuip).
  let quipTouched = false;
  let lastSig = null;
  /**
   * {team, …} placeholder values: names are already-public text; the answer is passed only after the reveal.
   * Grammar: {teamVerb:wins|win} agrees with {team} (plural team name, or vars.plural.team for joined names; a
   * {player} is singular unless vars.plural.player says otherwise), and "{team}'s" becomes "The Grinches'".
   */
  function fillQuip(text, key, vars) {
    let okFill = true;
    const value = (name) => {
      if (name === 'answer' && !QUIP_ANSWER_KEYS.includes(key)) return null;
      const v = hasOwn(vars, name) ? vars[name] : null;
      return v === null || v === undefined || v === '' ? null : typeof v === 'number' ? fmtNum(v) : String(v);
    };
    const plural = (name, v) => (vars.plural && hasOwn(vars.plural, name) ? !!vars.plural[name] : name === 'player' ? false : isPluralTeam(v));
    const out = text
      .replace(/\{([a-zA-Z]+)Verb:([^{}|]+)\|([^{}|]+)\}/g, (m, name, one, many) => {
        const v = value(name);
        if (v === null) { okFill = false; return m; }
        return plural(name, v) ? many : one;
      })
      .replace(/\{([a-zA-Z]+)\}(['’]s\b)?/g, (m, name, poss) => {
        const v = value(name);
        if (v === null) { okFill = false; return m; }
        if (!poss) return v;
        return /s$/i.test(v) ? v + poss.charAt(0) : v + poss; // "The Grinches'" / "Team Rudolph's"
      });
    return okFill ? out : null;
  }
  function pickQuip(keys, vars, o = {}) {
    if (!Array.isArray(S.quipUsed)) S.quipUsed = [];
    if (!Array.isArray(S.quipNight)) S.quipNight = [];
    const night = new Set(S.quipNight);
    for (const key of keys) {
      const lines = Array.isArray(quipBank[key]) ? quipBank[key] : [];
      const fill = () => {
        const game = new Set(S.quipUsed);
        return lines.map((l) => ({ l, text: game.has(l.id) ? null : fillQuip(l.text, key, vars) })).filter((x) => x.text);
      };
      let usable = fill();
      if (!usable.length && o.recycle && lines.length) { // lobby idle lines may come round again (not "in a game")
        const ids = new Set(lines.map((l) => l.id));
        S.quipUsed = S.quipUsed.filter((id) => !ids.has(id));
        usable = fill();
      }
      if (!usable.length) continue;
      const fresh = usable.filter((x) => !night.has(x.l.id));
      const pool = fresh.length ? fresh : usable;
      const got = pool[Math.min(pool.length - 1, Math.floor(qrng() * pool.length))];
      S.quipUsed.push(got.l.id);
      if (!night.has(got.l.id)) S.quipNight.push(got.l.id);
      return { id: got.l.id, key, text: got.text, tone: got.l.tone || null };
    }
    return null;
  }
  /** A comedy moment: the TV quip (or null when no line is left) + the react cue for the primary key. */
  function moment(keys, vars = {}, o = {}) {
    const list = Array.isArray(keys) ? keys : [keys];
    const c = ch();
    const seg = c && c.segmentIndex != null && SEGMENTS[c.segmentIndex] && S.phase !== 'spinning' ? SEGMENTS[c.segmentIndex].label : null;
    const q = pickQuip(list, { segment: seg, ...vars }, o);
    const teamId = o.teamId && team(o.teamId) ? o.teamId : null;
    S.quip = q ? { ...q, teamId } : null;
    quipTouched = true;
    const mood = MOODS[list[0]];
    if (mood) fx('react', { mood, ...(teamId ? { teamId } : {}), key: list[0], quipId: q ? q.id : null });
    return q;
  }
  /** Everything that makes "a new moment" (a phase / stage / buzz / vote / reveal step change). */
  function momentSig() {
    const c = S.challenge;
    const b = c && c.buzz;
    const F = S.final;
    const row = F && F.current && F.rows ? F.rows[F.current] : null;
    return [S.phase, S.turnId, c ? c.id : '', c ? c.stage : '',
      b ? `${b.open ? 1 : 0}${b.armingUntil ? 1 : 0}${b.winner ? b.winner.playerId : ''}/${b.attempts}` : '',
      c && c.vote ? (c.vote.open ? 1 : 0) : '', F ? F.current || '' : '', row ? (row.judged ? 1 : 0) : ''].join('|');
  }
  /** Runs before every state push: a quip lives until the next moment starts (cleared unless that moment set one). */
  function settleQuip() {
    const sig = momentSig();
    if (!quipTouched && lastSig !== null && sig !== lastSig) S.quip = null;
    quipTouched = false;
    lastSig = sig;
  }
  /** The one team with the highest score (> 0), or null on a tie / all zero. */
  function soleLeader() {
    const top = Math.max(0, ...S.teams.map((t) => t.score));
    const lead = S.teams.filter((t) => t.score === top);
    return top > 0 && lead.length === 1 ? lead[0].id : null;
  }
  function soleLast() {
    if (S.teams.length < 2) return null;
    const low = Math.min(...S.teams.map((t) => t.score));
    const last = S.teams.filter((t) => t.score === low);
    return last.length === 1 ? last[0].id : null;
  }
  const doubled = (teamId) => !!(S.turn && S.turn.multiplier > 1 && teamId === activeTeamId());
  /** Who performed a dare / sound / hot seat, as one name ("Mia", "Mia and Leo", or the team for a team dare). */
  function castName(c) {
    if (c.dare && (c.dare.who === 'team' || c.dare.who === 'everyone')) return teamName(activeTeamId());
    const n = [c.performer, c.partner].filter((x) => x && x.name).map((x) => x.name);
    return n.length ? joinNames(n) : teamName(activeTeamId());
  }
  /** True when castName() is plural ("Mia and Leo", or a plural team name like "The Grinches"): for {playerVerb:…}. */
  function castPlural(c) {
    if (c.dare && (c.dare.who === 'team' || c.dare.who === 'everyone')) return isPluralTeam(teamName(activeTeamId()));
    const n = [c.performer, c.partner].filter((x) => x && x.name).length;
    return n ? n > 1 : isPluralTeam(teamName(activeTeamId()));
  }
  function turnQuip() {
    const act = activeTeamId();
    if (S.round === 1 && S.turnIndex === 0) { moment(['gameStart', 'turnIntro'], { team: teamName(act) }); return; }
    const lead = soleLeader();
    const prev = S.comedy && S.comedy.leader;
    S.comedy = { ...(S.comedy || {}), leader: lead || prev || null };
    if (lead && lead !== prev) {
      moment(['leadChange', 'turnIntro'], { leader: teamName(lead), other: prev && team(prev) ? teamName(prev) : null, team: teamName(act) }, { teamId: lead });
      return;
    }
    moment('turnIntro', { team: teamName(act) });
  }
  function landQuip(c) {
    const act = activeTeamId();
    if (c.type === 'grinch' && c.gift) {
      moment('grinchGift', { team: teamName(act), last: teamName(c.gift.toTeamId), points: c.gift.amount }, { teamId: c.gift.toTeamId });
      return;
    }
    const keys = c.type === 'trivia' ? (c.category === 'christmas' ? ['land.trivia'] : ['land.' + c.category, 'land.trivia']) : ['land.' + c.type];
    moment(keys, { team: teamName(act) });
  }
  /** The active team just missed (wrong / time up / host opened the steal): a groan before the steal arms. */
  function activeMiss(c, kind) {
    const act = activeTeamId();
    c.activeMissed = kind;
    if (kind === 'timeUp') moment(['timeUp', 'wrong'], { team: teamName(act) }, { teamId: act });
    else moment(c.difficulty === 'easy' ? ['wrongEasy', 'wrong'] : ['wrong'], { team: teamName(act) }, { teamId: act });
  }
  function rapidListQuip(c) {
    const act = activeTeamId();
    const pts = c.awarded[act] || 0;
    const n = c.ticked.length;
    const keys = [];
    if (doubled(act) && pts > 0) keys.push('doubleDown');
    if (n >= 5) keys.push('listBig'); else if (n <= 2) keys.push('listSmall');
    if (keys.length) moment(keys, { team: teamName(act), points: pts }, { teamId: act });
  }
  function hotSeatQuip(c) {
    const act = activeTeamId();
    const res = c.hs.results;
    const right = res.filter((r) => r === 'correct').length;
    const pts = c.awarded[act] || 0;
    const keys = [];
    if (c.hs.questions.length && right === c.hs.questions.length) keys.push('hotseatPerfect');
    else if (res.length && !right) keys.push('hotseatZero');
    if (doubled(act) && pts > 0) keys.push('doubleDown');
    if (keys.length) moment(keys, { player: c.performer ? c.performer.name : teamName(act), team: teamName(act), points: pts, plural: { player: !c.performer && isPluralTeam(teamName(act)) } }, { teamId: act });
  }
  function allPlayQuip(c) {
    const right = S.teams.filter((t) => c.subs[t.id] && effCorrect(c.subs[t.id])).map((t) => t.id);
    const who = c.firstTeamId || (right.length === 1 ? right[0] : null);
    if (right.length) moment('correct', { team: who ? teamName(who) : null, points: who ? c.awarded[who] || null : null, answer: c.q.answer }, { teamId: who });
    else if (Object.keys(c.subs).length) moment('wrong', {});
    else moment('nobodyBuzzed', {});
  }
  function roundBreakQuip() {
    const ranks = rankNow();
    const prev = S.roundBreak && S.roundBreak.prevRanks;
    let climber = null;
    let best = 1;
    if (prev) for (const t of S.teams) { const up = (prev[t.id] || ranks[t.id]) - ranks[t.id]; if (up > best) { best = up; climber = t.id; } }
    const lead = soleLeader();
    const last = soleLast();
    S.comedy = { ...(S.comedy || {}), leader: lead || (S.comedy && S.comedy.leader) || null };
    const vars = { leader: lead ? teamName(lead) : null, last: last ? teamName(last) : null };
    if (climber) { moment(['bigComeback', 'roundBreak'], { ...vars, team: teamName(climber) }, { teamId: climber }); return; }
    const top = Math.max(...S.teams.map((t) => t.score));
    if (last && top - team(last).score >= 300) { moment(['lastPlaceCheer', 'roundBreak'], vars, { teamId: last }); return; }
    moment(['roundBreak', 'lastPlaceCheer'], vars);
  }

  // ---------------------------------------------------------------- comedy: award stats
  /** (Re)compute this challenge's stats record from the challenge itself (idempotent; undo/re-judge safe). */
  function recordChallengeStats(c) {
    if (!c || !c.id) return;
    const r = { wrongTeams: {}, wrongPlayers: {}, stolen: {}, stealPlayers: {}, perfect: null };
    const inc = (o, k, n = 1) => { if (k) o[k] = (o[k] || 0) + n; };
    const own = c.teamId || null;
    if (c.activeMissed) inc(r.wrongTeams, own);
    if (c.buzz) {
      for (const m of c.buzz.misses || []) { inc(r.wrongTeams, m.teamId); inc(r.wrongPlayers, m.playerId); }
      const w = c.buzz.winner;
      if (c.result && c.result.kind === 'stolen' && w && (c.awarded[w.teamId] || 0) > 0) { inc(r.stolen, w.teamId, c.awarded[w.teamId]); inc(r.stealPlayers, w.playerId); }
    }
    if (c.type === 'grinch' && c.steal && (c.awarded[c.steal.to] || 0) > 0) inc(r.stolen, c.steal.to, c.awarded[c.steal.to]);
    if (c.type === 'hotseat' && c.hs) {
      const wrong = c.hs.results.filter((x) => x === 'wrong').length;
      if (wrong) { inc(r.wrongTeams, own, wrong); inc(r.wrongPlayers, c.performer && c.performer.playerId, wrong); }
      if (c.hs.questions.length && c.hs.results.filter((x) => x === 'correct').length === c.hs.questions.length && c.performer) r.perfect = c.performer.playerId;
    }
    if ((c.type === 'allplay' || c.type === 'bonus') && c.revealed && c.subs) {
      for (const [tid, s] of Object.entries(c.subs)) if (!effCorrect(s)) { inc(r.wrongTeams, tid); inc(r.wrongPlayers, s.by); }
    }
    S.stats.ch[c.id] = r;
  }
  /** Rank + score snapshot at the end of a round (keyed by round, so it is idempotent). */
  function checkpoint() {
    if (!S.round) return;
    const ranks = rankNow();
    S.stats.checkpoints[S.round] = { ranks, scores: Object.fromEntries(S.teams.map((t) => [t.id, t.score])) };
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
    if (c && snap.challengeId === c.id && snap.awarded) { c.awarded = { ...snap.awarded }; if (c.result) { c.result.awards = awardsList(c); recordPerformance(c); } }
    if (c) recordChallengeStats(c);
    if (S.final && snap.final) { S.final.awarded = snap.final.awarded; S.final.rows = snap.final.rows; S.final.done = snap.final.done; }
    if (S.phase === 'roundBreak' && !c) checkpoint();
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
      case 'trivia': if (c && c.type === 'trivia' && c.stage === 'question') { fx('wrong', { teamId: activeTeamId(), timeUp: true }); activeMiss(c, 'timeUp'); openSteal(); } break;
      case 'sound': if (c && c.type === 'sounditout' && c.stage === 'perform') { fx('wrong', { teamId: activeTeamId(), timeUp: true }); activeMiss(c, 'timeUp'); openSteal(); } break;
      case 'steal': if (c && c.stage === 'steal' && c.buzz && !c.buzz.winner) { finish('missed'); moment('nobodyBuzzed', {}); } break;
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
  const copyQ = (q) => ({
    id: q.id, category: q.category, difficulty: q.difficulty, question: q.question, answer: q.answer, accept: q.accept || [],
    hint: q.hint || '', funFact: q.funFact || '', movie: q.movie || '', year: Number.isInteger(q.year) ? q.year : null,
  });
  function drawTrivia(category, difficulty, exclude) {
    const q = drawFrom(triviaPool(content.trivia, category, difficulty), used, rng, exclude);
    return q ? copyQ(q) : null;
  }
  function drawQuick(exclude) {
    let pool = content.trivia.filter(isQuickQuestion);
    if (!pool.length) pool = content.trivia;
    const q = drawFrom(pool, used, rng, exclude);
    return q ? copyQ(q) : null;
  }
  const draw = (kind, exclude) => drawFrom(content[kind], used, rng, exclude);
  /** A dare the active team can actually do: a team of one never draws a pair dare (when any other dare is left). */
  function drawDare(exclude) {
    const solo = playersOf(activeTeamId()).length < 2;
    const pool = solo ? content.dares.filter((d) => d.who !== 'pair') : content.dares;
    return drawFrom(pool.length ? pool : content.dares, used, rng, exclude);
  }

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
    turnQuip();
  }
  function startGame() {
    sched.bump();
    for (const t of S.teams) t.score = 0;
    S.round = 1; S.turnIndex = 0;
    S.undo = []; S.lastAwards = []; S.final = null; S.podium = null; S.roundBreak = null;
    S.seen = []; S.prevRanks = null; S.lastSpin = null;
    S.stats = freshStats();
    S.quipUsed = []; S.comedy = { leader: null };
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
    // {player} = the spinner (the team's name when the host spun for them)
    moment('spinStart', { player: by && by.name ? by.name : teamName(activeTeamId()), team: teamName(activeTeamId()), plural: { player: !(by && by.name) && isPluralTeam(teamName(activeTeamId())) } });
  }
  function land() {
    const idx = S.spin.segmentIndex;
    S.lastSegmentIndex = idx;
    S.lastSpin = { segmentIndex: idx, teamId: activeTeamId(), by: S.spin.by || null };
    S.spin = null;
    S.phase = 'challenge';
    S.challenge = buildChallenge(idx);
    fx('land', { segmentIndex: idx, segmentType: SEGMENTS[idx].type, teamId: activeTeamId() });
    landQuip(S.challenge);
  }
  function newChallenge(type, segmentIndex, rule) {
    if (!Array.isArray(S.seen)) S.seen = [];
    const firstTime = !S.seen.includes(type);
    if (firstTime) S.seen.push(type);
    return { id: ++S.challengeSeq, type, segmentIndex, stage: '', rule, points: 0, awarded: {}, revealed: false, hintShown: false, started: false, result: null, firstTime, secretPeeked: false, eyeing: null, teamId: activeTeamId() };
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
        setupDare(c, drawDare());
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
        c.openedAt = now();
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
  /** Set up a dare. keepPerformer (Swap dare) keeps the same performer, adding/dropping a partner as needed. */
  function setupDare(c, d, keepPerformer) {
    const act = activeTeamId();
    const keep = keepPerformer && c.performer && player(c.performer.playerId) ? c.performer : null;
    if (!keep) unpick(c.performer);
    unpick(c.partner);
    c.points = PTS.dare.nailed;
    c.dare = { id: d.id, title: d.title, who: d.who, instructions: d.instructions, time: d.time, props: d.props || [], judge: d.judge, tags: d.tags || [], secret: d.secret || null };
    c.secretValue = d.secret && d.secret.options && d.secret.options.length ? pick(d.secret.options) : null;
    c.secretPeeked = false;
    c.performer = keep || pickPlayer(act);
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
    recordChallengeStats(c);
    if (S.phase === 'challenge') S.phase = 'turnResult';
    if (kind === 'list') rapidListQuip(c);
    if (kind === 'hotseat') hotSeatQuip(c);
  }
  function refreshResult(c) { if (c.result) { c.result.awards = awardsList(c); recordPerformance(c); recordChallengeStats(c); } }
  /**
   * Performances for the awards: `cast` = everyone who performed (Star Performer counts these), `playerIds` = who
   * scored with it and `points` (tie-break). A skipped challenge is not a performance.
   */
  function recordPerformance(c) {
    const act = activeTeamId();
    let ids = [];
    let cast = [];
    let pts = 0;
    const idsOf = (...xs) => xs.filter((x) => x && x.playerId).map((x) => x.playerId);
    if (c.result && c.result.kind === 'skipped') { delete S.stats.perf[c.id]; return; }
    if (c.type === 'dare' || c.type === 'sounditout' || c.type === 'hotseat') {
      ids = idsOf(c.performer, c.partner);
      cast = ids;
      pts = (c.type === 'sounditout' ? (c.result && c.result.kind === 'correct' ? c.awarded[act] || 0 : 0) : c.awarded[act] || 0);
    } else if (c.type === 'showdown' && c.winnerSide) {
      cast = idsOf(c.performer, c.rival);
      if (c.winnerSide === 'active' && c.performer) { ids = [c.performer.playerId]; pts = c.awarded[act] || 0; }
      if (c.winnerSide === 'rival' && c.rival && c.rival.playerId) { ids = [c.rival.playerId]; pts = c.awarded[c.rival.teamId] || 0; }
      if (c.winnerSide === 'tie') { ids = cast; pts = PTS.showdownTie; }
    }
    if (cast.length) S.stats.perf[c.id] = { playerIds: ids, cast, points: Math.max(0, pts), kind: c.type, nailed: c.type === 'dare' && c.dareResult && c.dareResult.result === 'nailed' };
  }

  // trivia / sound-it-out steal
  function openSteal() {
    const c = ch();
    stopTimer();
    c.stage = 'steal';
    c.stealPoints = Math.round(c.points / 2);
    c.buzz = { open: false, armingUntil: null, eligibleTeamIds: [], lockedTeamIds: [], winner: null, attempts: 0, misses: [] };
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
      // Silent Night: everyone online on an eligible team could have buzzed this time
      S.stats.chances[`${cc.id}:${cc.buzz.attempts}`] = Object.values(S.players).filter((p) => p.connected && cc.buzz.eligibleTeamIds.includes(p.teamId)).map((p) => p.id);
      moment('stealOpen', {});
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
    const prev = c.dareResult ? c.dareResult.result : null;
    c.dareResult = { result, bonus: !!bonus };
    group(`${teamName(act)} \u00B7 Dare: ${result}`, () => settle(c.awarded, act, base * multFor(act, base), 'Dare'));
    if (c.stage !== 'done') finish(result);
    else { c.result.kind = result; refreshResult(c); }
    fx(result === 'fail' ? 'wrong' : 'correct', { teamId: act });
    if (prev !== result) { // a new verdict (not just the +50 crowd-favourite toggle)
      const key = 'dare' + result.charAt(0).toUpperCase() + result.slice(1);
      const pts = c.awarded[act] || 0;
      moment(doubled(act) && pts > 0 ? [key, 'doubleDown'] : [key], { player: castName(c), team: teamName(act), points: pts, plural: { player: castPlural(c) } }, { teamId: act });
    }
  }
  /** Room vote: a too-close-to-call tally gets one "voteClose" line while the vote is still open. */
  function voteCloseQuip(c) {
    if (!c.vote || !c.vote.open || c.vote.closeQuipped) return;
    const t = voteTally(c);
    if (t.voters >= 2 && Math.abs(t.nailed - t.good) <= (t.voters >= 4 ? 1 : 0)) { c.vote.closeQuipped = true; moment('voteClose', {}); }
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
    c.openedAt = now();
    c.stage = 'answering';
    S.challenge = c;
    prepareTimer('bonus', T.bonusMs, true);
  }

  function endTurn() {
    sched.bump();
    if (S.challenge) recordChallengeStats(S.challenge); // a turn skipped mid-challenge still counts its misses
    S.timer = null; S.spin = null; S.challenge = null; S.turn = null;
    S.turnIndex++;
    if (S.turnIndex < S.teams.length) { beginTurn(); return; }
    S.turnId = ++S.turnSeq; // any stale nextTurn is now ignored
    if (S.round < S.settings.rounds) {
      S.phase = 'roundBreak';
      const ranks = rankNow();
      S.roundBreak = { round: S.round, nextRound: S.round + 1, finalNext: S.round + 1 === S.settings.rounds, bonusDone: false, prevRanks: S.prevRanks ? { ...S.prevRanks } : null };
      S.prevRanks = ranks;
      checkpoint();
      fx('roundBreak', { round: S.round });
      roundBreakQuip();
    } else enterFinal();
  }
  function nextRound() {
    if (S.challenge) recordChallengeStats(S.challenge);
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
    if (S.challenge) recordChallengeStats(S.challenge);
    checkpoint(); // standings at the end of the last round
    S.phase = 'finalIntro';
    S.roundBreak = null; S.challenge = null; S.timer = null; S.turn = null;
    const q = draw('finals');
    S.final = {
      q: { id: q.id, category: q.category, question: q.question, answer: q.answer, accept: q.accept || [] },
      categoryLabel: CATEGORY_LABELS[q.category] || titleCase(q.category),
      wagers: {}, subs: {}, order: [], rows: {}, current: null, awarded: {}, done: false,
    };
    fx('final', {});
    const lead = soleLeader();
    moment('finalIntro', { leader: lead ? teamName(lead) : null, last: soleLast() ? teamName(soleLast()) : null });
  }
  function maxWager(teamId) { const t = team(teamId); return Math.max(t ? t.score : 0, 300); }
  function startFinalAnswering() {
    for (const t of S.teams) if (!S.final.wagers[t.id]) S.final.wagers[t.id] = { amount: 0, locked: true, by: null, name: null, at: now(), auto: true };
    for (const t of S.teams) { const w = S.final.wagers[t.id]; w.locked = true; w.amount = Math.min(w.amount, maxWager(t.id)); }
    S.final.openedAt = now();
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
      S.final.rows[id] = { text: sub ? sub.text : '', by: sub ? sub.name : null, wager: w.amount, autoCorrect: sub ? sub.autoCorrect : false, match: sub ? sub.match || (sub.autoCorrect ? 'match' : 'none') : 'none', override: sub && sub.override != null ? sub.override : null, revealed: false, judged: false, correct: null, delta: null, before: team(id).score, after: null };
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
    // {answer}: the official answer once every row is judged (public then), before that this team's own revealed text
    const answer = ok ? (S.final.done ? S.final.q.answer : row.text) : null;
    moment(ok ? 'finalCorrect' : 'finalWrong', { team: teamName(teamId), answer, points: Math.abs(row.delta) || null }, { teamId });
  }
  /** Step the reveal: judge the current row (auto/host mark) if unjudged, else reveal the next team, else podium. */
  function finalRevealNext() {
    const F = S.final;
    if (F.current && !F.rows[F.current].judged) { judgeFinalRow(F.current); return; }
    const next = F.order.find((id) => !F.rows[id].revealed);
    if (next) {
      F.rows[next].revealed = true; F.current = next; fx('reveal', { teamId: next });
      // the wager is public from this moment (never earlier: wagers stay secret until the reveal)
      const r = F.rows[next];
      if (r.wager > 0 && r.wager >= (r.before > 0 ? r.before : 300)) moment('finalAllIn', { team: teamName(next), points: r.wager }, { teamId: next });
      else if (r.wager === 0) moment('finalZeroBet', { team: teamName(next) }, { teamId: next });
      return;
    }
    enterPodium();
  }
  function computePodium() {
    const sorted = S.teams.map((t, i) => ({ t, i })).sort((a, b) => b.t.score - a.t.score || a.i - b.i).map((x) => x.t);
    const standings = sorted.map((t) => ({ teamId: t.id, score: t.score, place: 1 + S.teams.filter((o) => o.score > t.score).length }));
    const stats = computeStats(standings);
    return { standings, awards: computeAwards(stats), stats };
  }
  /**
   * Award stats (COMEDY.md \u00A72). Players: buzzWins, firsts (All Play first-correct), wrongAnswers (missed steals, wrong
   * All Play / bonus / Final answers they typed, Hot Seat misses), steals, performances, perfectHotSeat, buzzChances.
   * Teams: steals (points stolen: steals + Grinch Steal), stealCount, wrong, timesLed (rounds ended in first), worstRank,
   * place, climb (worst end-of-round rank -> final place).
   */
  function computeStats(standings) {
    const P = {};
    const TM = {};
    const pRow = (pid) => P[pid] || (P[pid] = { buzzWins: 0, firsts: 0, wrongAnswers: 0, steals: 0, performances: 0, perfPoints: 0, dares: 0, perfectHotSeat: 0, buzzChances: 0 });
    const tRow = (tid) => TM[tid] || (TM[tid] = { steals: 0, stealCount: 0, wrong: 0, timesLed: 0, worstRank: null, place: null, climb: 0 });
    for (const p of Object.values(S.players)) pRow(p.id);
    for (const t of S.teams) tRow(t.id);
    const st = S.stats;
    for (const pid of st.buzzes || []) pRow(pid).buzzWins++;
    for (const pid of Object.values(st.firsts || {})) if (pid) pRow(pid).firsts++;
    for (const pf of Object.values(st.perf || {})) {
      for (const pid of pf.cast || pf.playerIds) { const r = pRow(pid); r.performances++; if (pf.kind === 'dare') r.dares++; }
      for (const pid of pf.playerIds) pRow(pid).perfPoints += pf.points;
    }
    for (const r of Object.values(st.ch || {})) {
      for (const [tid, n] of Object.entries(r.wrongTeams)) tRow(tid).wrong += n;
      for (const [pid, n] of Object.entries(r.wrongPlayers)) pRow(pid).wrongAnswers += n;
      for (const [tid, n] of Object.entries(r.stolen)) { tRow(tid).steals += n; tRow(tid).stealCount++; }
      for (const [pid, n] of Object.entries(r.stealPlayers)) pRow(pid).steals += n;
      if (r.perfect) pRow(r.perfect).perfectHotSeat++;
    }
    if (S.final) {
      for (const [tid, row] of Object.entries(S.final.rows || {})) {
        if (!row.judged || row.correct) continue;
        tRow(tid).wrong++;
        const sub = S.final.subs[tid];
        if (sub && sub.by) pRow(sub.by).wrongAnswers++;
      }
    }
    for (const ids of Object.values(st.chances || {})) for (const pid of ids) pRow(pid).buzzChances++;
    const cps = Object.keys(st.checkpoints || {}).map(Number).sort((a, b) => a - b).map((k) => st.checkpoints[k]);
    for (const cp of cps) {
      const top = Math.max(0, ...Object.values(cp.scores));
      for (const [tid, rank] of Object.entries(cp.ranks)) {
        const r = tRow(tid);
        if (rank === 1 && top > 0) r.timesLed++;
        if (r.worstRank == null || rank > r.worstRank) r.worstRank = rank;
      }
    }
    for (const s of standings) { const r = tRow(s.teamId); r.place = s.place; r.climb = r.worstRank ? Math.max(0, r.worstRank - s.place) : 0; }
    return { players: P, teams: TM, rounds: cps.length };
  }
  /** The funny awards: only when earned, max 6; a two-way tie is shared, a bigger tie means nobody stood out (no award). */
  function computeAwards(stats) {
    const earned = {};
    const given = new Set(); // players who already have an award (no Silent Night for them)
    const tops = (list, cmp) => {
      if (!list.length) return null;
      const sorted = list.slice().sort(cmp);
      const tied = sorted.filter((x) => cmp(x, sorted[0]) === 0);
      return tied.length > 2 ? null : tied;
    };
    const make = (key, who, detail) => {
      const info = AWARD_INFO[key];
      const teams = [...new Set(who.map((w) => w.teamId))];
      for (const w of who) if (w.playerId) given.add(w.playerId);
      const playerIds = [...new Set(who.map((w) => w.playerId).filter(Boolean))];
      // playerId / teamId: the single winner (null when shared); playerIds / teamIds: everyone who shares it
      earned[key] = {
        key, title: info.title, playerId: who.length === 1 && who[0].playerId ? who[0].playerId : null,
        playerIds, teamIds: teams,
        name: joinNames(who.map((w) => (w.playerId ? player(w.playerId).name : teamName(w.teamId)))),
        teamId: teams.length === 1 ? teams[0] : null, detail, art: info.art, ...(who.length > 1 ? { tie: true } : {}),
      };
    };
    const players = Object.entries(stats.players).filter(([pid]) => player(pid) && team(player(pid).teamId))
      .map(([pid, s]) => ({ ...s, playerId: pid, teamId: player(pid).teamId, joined: player(pid).joinedAt || 0 }));
    const teams = S.teams.map((t) => ({ ...stats.teams[t.id], teamId: t.id }));
    const each = (w) => (w.length > 1 ? ' each' : '');

    // Fastest Finger: steal buzzes won + All Play first-correct answers
    let w = tops(players.filter((p) => p.buzzWins + p.firsts > 0), (a, b) => (b.buzzWins + b.firsts) - (a.buzzWins + a.firsts) || b.buzzWins - a.buzzWins);
    if (w) {
      const f = w[0];
      const parts = [];
      if (f.buzzWins) parts.push(`${f.buzzWins} buzz${f.buzzWins === 1 ? '' : 'es'} won`);
      if (f.firsts) parts.push(`${plural(f.firsts, 'first answer')}`);
      make('fastestFinger', w, `${parts.join(' \u00B7 ')}${each(w)} \u2014 thumbs faster than Santa\u2019s sleigh`);
    }
    // Star Performer: the most performances (dares, songs, Hot Seats, showdowns), points as the tie-break
    w = tops(players.filter((p) => p.performances > 0 && (p.perfPoints > 0 || p.performances >= 2)), (a, b) => b.performances - a.performances || b.perfPoints - a.perfPoints);
    if (w && w.length > 1 && w[0].performances < 2) w = null; // two people with one turn each: nobody stood out yet
    if (w) {
      const s = w[0];
      const what = s.dares === s.performances ? plural(s.performances, 'dare') : plural(s.performances, 'performance');
      make('starPerformer', w, `${what}${s.perfPoints ? ` \u00B7 ${fmtNum(s.perfPoints)} pts` : ''}${s.perfectHotSeat ? ' \u00B7 a perfect Hot Seat' : ''}${each(w)} \u2014 the elves want an encore`);
    }
    // Lump of Coal: the most wrong answers (a player with 3+, else a team with 2+), played for laughs
    w = tops(players.filter((p) => p.wrongAnswers >= 3), (a, b) => b.wrongAnswers - a.wrongAnswers);
    if (w) make('lumpOfCoal', w, `${plural(w[0].wrongAnswers, 'wrong answer')}${each(w)} \u2014 Santa noticed`);
    else {
      w = tops(teams.filter((t) => t.wrong >= 2), (a, b) => b.wrong - a.wrong);
      if (w) make('lumpOfCoal', w, `${plural(w[0].wrong, 'wrong answer')} between them${each(w)} \u2014 Santa checked his list twice`);
    }
    // Grinch of the Year: the most points stolen (steals + Grinch Steal)
    w = tops(teams.filter((t) => t.steals > 0), (a, b) => b.steals - a.steals || b.stealCount - a.stealCount);
    if (w) make('grinchOfTheYear', w, `Stole ${fmtNum(w[0].steals)} points${w[0].stealCount > 1 ? ` in ${w[0].stealCount} heists` : ''}${each(w)} \u2014 heart still two sizes too small`);
    // Comeback Kid: the biggest climb from the worst end-of-round rank to the final place
    w = tops(teams.filter((t) => t.climb >= 2 || (t.climb >= 1 && t.place === 1)), (a, b) => b.climb - a.climb || a.place - b.place);
    if (w) {
      const c = w[0];
      make('comebackKid', w, `From ${ordinal(c.worstRank)} to ${ordinal(c.place)} \u2014 ${c.place === 1 ? 'and won the whole thing!' : 'a Christmas miracle'}`);
    }
    // Silent Night: the fewest buzzes among players who could buzz (3+ chances, buzzed in at most 1 of 4)
    w = tops(players.filter((p) => !given.has(p.playerId) && p.buzzChances >= 3 && p.buzzWins * 4 <= p.buzzChances),
      (a, b) => a.buzzWins - b.buzzWins || b.buzzChances - a.buzzChances || a.performances - b.performances);
    if (w) {
      const s = w[0];
      make('silentNight', w, `${s.buzzWins ? plural(s.buzzWins, 'buzz', 'buzzes') : 'Not one buzz'} in ${s.buzzChances} steal chances${each(w)} \u2014 all is calm, all is bright`);
    }
    // Rudolph Award: led the most rounds (at least 2)
    w = tops(teams.filter((t) => t.timesLed >= 2), (a, b) => b.timesLed - a.timesLed || a.place - b.place);
    if (w) make('rudolph', w, `Led ${w[0].timesLed} of ${stats.rounds} rounds${each(w)} \u2014 guided the sleigh all night`);

    // more than 6 earned: shared (tied) awards drop out first, then the last in AWARD_PICK order
    const keep = AWARD_PICK.filter((k) => earned[k])
      .sort((a, b) => (earned[a].tie ? 1 : 0) - (earned[b].tie ? 1 : 0) || AWARD_PICK.indexOf(a) - AWARD_PICK.indexOf(b)).slice(0, AWARD_MAX);
    return AWARD_ORDER.filter((k) => keep.includes(k)).map((k) => earned[k]);
  }
  function enterPodium() {
    sched.bump();
    S.timer = null;
    S.phase = 'podium';
    S.podium = computePodium();
    fx('podium', {});
    const winners = S.podium.standings.filter((s) => s.place === 1 && s.score > 0).map((s) => s.teamId);
    moment('podium', { leader: winners.length ? joinNames(winners.map(teamName)) : null, ...(winners.length > 1 ? { plural: { leader: true } } : {}) }, { teamId: winners.length === 1 ? winners[0] : null });
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
    S.quipNight = Array.isArray(old.quipNight) ? old.quipNight.slice() : [];
    if (keepTeams) S.teams = old.teams.map((t) => ({ ...t, score: 0 }));
    else for (const p of Object.values(S.players)) p.teamId = null;
    recomputeAuto();
    moment('lobbyIdle', {}, { recycle: true });
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
          if (S.phase === 'lobby') moment('lobbyIdle', {}, { recycle: true }); // the lobby gift tag rotates as people arrive
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
        const prev = target.subs[ctx.team.id];
        const match = matchKind(text, q.answer, q.accept);
        const at = now();
        // a changed answer resets the host's manual mark ("If a team changes its answer, its mark resets.")
        target.subs[ctx.team.id] = {
          text, by: ctx.player.id, name: ctx.player.name, at, elapsedMs: Math.max(0, at - (target.openedAt || at)),
          autoCorrect: match !== 'none', match, override: prev && prev.text === text ? prev.override : null,
        };
        fx('answered', { teamId: ctx.team.id, changed: !!prev });
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
      // One vote per player; voting again while the vote is open CHANGES that player's vote (phone "Change vote").
      guard: (ctx) => all(() => needTeam(ctx), () => inChallenge('dare', ['vote']), () => {
        const c = ch();
        if (!c.vote.open) return 'not-now';
        return ctx.team.id === activeTeamId() ? 'not-eligible' : ok;
      }),
      validate: (p) => (p.choice === 'nailed' || p.choice === 'good' ? ok : 'bad-choice'),
      run: (ctx, p) => {
        const c = ch();
        const changedVote = hasOwn(c.vote.votes, ctx.player.id);
        if (changedVote && c.vote.votes[ctx.player.id] === p.choice) return { changed: false };
        c.vote.votes[ctx.player.id] = p.choice;
        fx('vote', { ...voteTally(c), choice: p.choice, changed: changedVote });
        if (!changedVote && Object.keys(c.vote.votes).length >= eligibleVoters()) closeVote();
        else voteCloseQuip(c);
        return { changed: changedVote };
      },
    },
    previewTarget: {
      // The active team's phone highlights a target before confirming: the TV shows "Mia is eyeing Team Rudolph...".
      player: true,
      guard: (ctx) => all(() => needActive(ctx), () => (inChallenge('grinch', ['pickTarget']) === ok || inChallenge('showdown', ['pickRival']) === ok ? ok : 'not-now')),
      validate: (p) => (p.teamId === null || (typeof p.teamId === 'string' && ch().targets.includes(p.teamId)) ? ok : 'bad-target'),
      run: (ctx, p) => {
        const c = ch();
        c.eyeing = p.teamId ? { teamId: p.teamId, by: { playerId: ctx.player.id, name: ctx.player.name } } : null;
      },
    },
    peek: {
      // The performer pressed-and-held their secret card (host sees "Aunt Linda has peeked").
      player: true,
      guard: (ctx) => (!ctx.player ? 'not-joined' : playerSecret(ctx.player.id) ? ok : 'no-secret'),
      run: () => {
        const c = ch();
        if (c.secretPeeked) return { first: false };
        c.secretPeeked = true;
        return { first: true };
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
        else { fx('wrong', { teamId: activeTeamId() }); activeMiss(c, 'wrong'); openSteal(); }
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
        const silent = c.stage === 'steal' && c.buzz && !c.buzz.winner && !c.buzz.lockedTeamIds.length && (c.buzz.open || c.buzz.armingUntil);
        finish('missed');
        fx('reveal', {});
        if (silent) moment('nobodyBuzzed', {}); // the host gave up waiting for a buzz
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
          if (np) { unpick(old); c.performer = np; c.secretPeeked = false; }
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
    'host:swapSecret': {
      // New secret for the SAME performer: another option of the same dare, or another song (Sound It Out).
      guard: () => {
        const c = ch();
        if (inChallenge('dare', ['perform']) === ok) return c.secretValue && c.dare.secret.options.length > 1 ? ok : 'no-secret';
        if (inChallenge('sounditout', ['perform']) === ok) return ok;
        return 'not-now';
      },
      run: () => {
        const c = ch();
        if (c.type === 'sounditout') { swapQuestion(); return; }
        const rest = c.dare.secret.options.filter((o) => o !== c.secretValue);
        c.secretValue = pick(rest);
        c.secretPeeked = false;
      },
    },
    'host:reorderTeams': {
      guard: () => (S.phase === 'lobby' ? ok : 'not-now'),
      validate: (p) => {
        if (!Array.isArray(p.order) || p.order.length !== S.teams.length) return 'bad-order';
        const ids = new Set(p.order);
        return ids.size === S.teams.length && S.teams.every((t) => ids.has(t.id)) ? ok : 'bad-order';
      },
      run: (ctx, p) => { S.teams = p.order.map((id) => team(id)); },
    },
    'host:shuffleTeams': {
      guard: () => (S.phase !== 'lobby' ? 'not-now' : S.teams.length < 2 ? 'need-two-teams' : ok),
      run: () => {
        const a = S.teams.slice();
        for (let i = a.length - 1; i > 0; i--) { const j = rint(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
        if (a.every((t, i) => t === S.teams[i])) a.push(a.shift()); // always visibly change the order
        S.teams = a;
      },
    },
    'host:soundTest': {
      guard: () => ok,
      run: () => { fx('soundTest', {}); },
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
        if (p.winner === 'tie') moment('showdownTie', { team: teamName(act), other: teamName(c.rival.teamId) });
        else {
          const [win, lose, who] = p.winner === 'rival' ? [c.rival.teamId, act, c.rival] : [act, c.rival.teamId, c.performer];
          const pts = c.awarded[win] || 0;
          moment(doubled(win) && pts > 0 ? ['showdownWin', 'doubleDown'] : ['showdownWin'],
            { player: who && who.name ? who.name : null, team: teamName(win), other: teamName(lose), points: pts }, { teamId: win });
        }
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
      run: () => { if (undo()) moment('undo', {}); },
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
    const act = activeTeamId();
    moment('pick' + level.charAt(0).toUpperCase() + level.slice(1), { team: teamName(act), points: c.points * (S.turn ? S.turn.multiplier : 1) }, { teamId: act });
  }
  function pickTarget(targetId) {
    const c = ch();
    const act = activeTeamId();
    c.eyeing = null;
    if (c.type === 'grinch') {
      const victim = team(targetId);
      const amount = Math.min(PTS.grinch * S.turn.multiplier, victim.score);
      group(`${subject(teamName(act), 'steals')} ${amount} from ${victim.name}`, () => {
        cAward(victim.id, -amount, 'Grinch Steal', { mult: 1 });
        cAward(act, amount, 'Grinch Steal', { mult: 1 });
      });
      c.steal = { from: victim.id, to: act, amount };
      fx('steal', { from: victim.id, to: act, amount });
      finish('steal');
      moment('grinchSteal', { team: teamName(act), other: victim.name, points: amount }, { teamId: act });
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
        // {team} = the stealing team, {other} = the team that missed
        moment('stealWon', { team: teamName(w.teamId), other: teamName(act), player: w.name, points: c.awarded[w.teamId] || c.stealPoints }, { teamId: w.teamId });
      } else {
        c.buzz.lockedTeamIds.push(w.teamId);
        if (!Array.isArray(c.buzz.misses)) c.buzz.misses = [];
        c.buzz.misses.push({ playerId: w.playerId, teamId: w.teamId });
        c.buzz.winner = null;
        c.buzz.eligibleTeamIds = c.buzz.eligibleTeamIds.filter((id) => id !== w.teamId);
        fx('wrong', { teamId: w.teamId, steal: true });
        if (!otherTeamIds().some((id) => !c.buzz.lockedTeamIds.includes(id))) finish('missed');
        moment('stealMissed', { team: teamName(w.teamId), player: w.name, other: teamName(act) }, { teamId: w.teamId });
      }
      return;
    }
    if (result === 'correct') {
      cAward(act, c.points, c.type === 'trivia' ? (TRIVIA_LABELS[c.category] || 'Trivia') : 'Sound It Out');
      fx('correct', { teamId: act });
      finish('correct');
      // the answer is public now (finish revealed it), so {answer} may be used
      const pts = c.awarded[act] || 0;
      const keys = [...(doubled(act) && pts > 0 ? ['doubleDown'] : []), ...(c.difficulty === 'hard' ? ['correctHard'] : []), 'correct'];
      moment(keys, { team: teamName(act), points: pts, answer: c.type === 'trivia' ? c.q.answer : c.song.title }, { teamId: act });
    } else {
      fx('wrong', { teamId: act });
      activeMiss(c, 'wrong');
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
    allPlayQuip(c);
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
      case 'sounditout': { const s = draw('songs', [c.song.id]); c.song = { id: s.id, title: s.title, artist: s.artist || '', accept: s.accept || [], hint: s.hint || '' }; c.hintShown = false; c.secretPeeked = false; c.points = PTS.sound; prepareTimer('sound', T.soundMs, false); break; }
      case 'dare': setupDare(c, drawDare([c.dare.id]), true); break;
      case 'showdown': { const s = draw('showdowns', [c.showdown.id]); c.showdown = { id: s.id, title: s.title, instructions: s.instructions, time: s.time, props: s.props || [], winner: s.winner, tags: s.tags || [] }; prepareTimer('showdown', s.time * 1000, false); break; }
      case 'rapidlist': { const l = draw('lists', [c.list.id]); c.list = { id: l.id, prompt: l.prompt, answers: l.answers.slice(), note: l.note || '' }; prepareTimer('list', T.listMs, false); break; }
      case 'hotseat': { const q = drawQuick(c.hs.questions.map((x) => x.id)); if (q) c.hs.questions[c.hs.index] = q; break; }
      case 'allplay': case 'bonus': c.q = drawQuick([c.q.id]); c.subs = {}; c.openedAt = now(); prepareTimer(c.type, c.type === 'bonus' ? T.bonusMs : T.allPlayMs, true); break;
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
  /** Role, guard and payload checks shared by dispatch() and check(). Returns {def, ctx, p} or a failure. */
  function prepare(actor, type, payload) {
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
    return { def, ctx, p };
  }
  /** Would this action be accepted right now? (no side effects) */
  function check(actor, type, payload) {
    try {
      const e = prepare(actor, type, payload);
      return e.ok === false ? e : { ok: true };
    } catch (err) {
      return fail('server-error');
    }
  }
  function dispatch(actor, type, payload) {
    try {
      const e = prepare(actor, type, payload);
      if (e.ok === false) return e;
      const { def, ctx, p } = e;
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
    for (const k of PLAYER_CAN) {
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
    if (!isObj(S.comedy)) S.comedy = { leader: null };
    used = new Set(Array.isArray(data.used) ? data.used : []);
    S.used = [];
    for (const p of Object.values(S.players)) p.connected = false;
    // re-establish transient things
    if (S.phase === 'spinning' && S.spin) land();
    if (S.timer) { S.timer.running = false; S.timer.endsAt = null; if (S.timer.remainingMs <= 0) S.timer.ended = true; }
    const c = S.challenge;
    if (c && c.buzz && c.stage === 'steal' && !c.buzz.open && c.buzz.armingUntil) armSteal();
    if (c && c.vote && c.vote.open) c.vote.endsAt = null;
    lastSig = null; // the restored quip stays on screen
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

  moment('lobbyIdle', {}, { recycle: true }); // the lobby gift tag

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
    check,
    playerCan,
    playerCanKeys: PLAYER_CAN.slice(),
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
