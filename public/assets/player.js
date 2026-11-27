// Christmas Chaos — player.js
// The phone controller served at "/". One job per screen, rendered ONLY from the server's playerView
// (me, can, challenge, secret, myTeam, myVote …). Local state is limited to drafts and UI conveniences
// (typed text, the team tile you tapped, the target you are hovering, the wager slider).
//
// Rendering model: derive(state) -> { id, data } (plain JSON). The screen is rebuilt only when the id or
// the JSON signature of `data` changes, so typing, holding the secret card or dragging the wager slider
// is never interrupted by unrelated state pushes. Timers and countdowns are patched in place 4× a second.
// Colours that come from game data (team colours, wheel-slot colours) are applied as CSS custom
// properties (--team-color, --seg, --seg-ink) by hydrate(); every other colour lives in the CSS tokens.

import {
  connect, h, raw, ic, setHTML, toast, onPress, secretCard, bindSecretCard, timerRing, updateTimerRing, timerSeconds,
  timerWarn, formatPoints, formatDelta, plural, ordinal, listJoin, possessive, vibrate, wakeLock, animateNumber, qsa,
} from './client.js';
import { hasIcon, mascotFor, safeColor } from './icons.js';
import { miniWheelMarkup } from './wheel.js';

/* ================================================================== setup ===================== */

const screenEl = document.getElementById('screen');
const topbarEl = document.getElementById('topbar');
const announcer = document.getElementById('announcer');

const client = connect('player', { banner: 'Reconnecting… hold tight' });

const LS_NAME = 'cc.playerName';
const NAME_MAX = 20;
const ANSWER_MAX = 80;

const ui = {
  drafts: {},          // input text by data-draft key
  pickTeam: null,      // team tile tapped on the join screen
  switching: false,    // lobby: "Switch team" open
  kicked: false,       // the host removed this phone
  removedTeam: null,   // name of the team that was removed / we were moved out of
  pending: null,       // action in flight ('join', 'spin', 'buzz', …)
  voteEdit: false,     // "Change vote" pressed
  target: null,        // {cid, teamId} picker selection
  wager: null,         // {key, amount}
  peeked: new Set(),   // secrets we already reported as peeked
  pendingLevel: null,  // difficulty tapped while the pick is in flight
};

let S = null;          // latest playerView
let lastMe = undefined; // previous `me` (undefined = no state yet)
let lastTeamName = null;
let cur = { id: null, sig: null, data: null };
let cleanup = null;     // unbind hook of the current screen (secret card listeners)
let headSig = null;
let headScore = null;  // {teamId, score} shown in the header (for the count-up)
let wl = null;         // wake lock handle while joined

try {
  ui.drafts.name = localStorage.getItem(LS_NAME) || '';
} catch {
  ui.drafts.name = '';
}

// Debug / test handle (read-only use): window.ccPlayer.client, .state
globalThis.ccPlayer = { client, ui, get state() { return S; } };

/* ================================================================== text & data helpers ======= */

const DIFF = {
  easy: { label: 'Easy', pts: 100, bars: 1, sub: 'A friendly warm-up' },
  medium: { label: 'Medium', pts: 200, bars: 2, sub: 'Getting trickier' },
  hard: { label: 'Hard', pts: 300, bars: 3, sub: 'Superfans only' },
};
const MEDIUM_SUB = { christmas: 'Know your carols', movies: 'Know your movies', popculture: 'Know your pop culture' };
const FINAL_ICONS = { christmas: 'tree-pine', movies: 'film', popculture: 'clapperboard', mixed: 'sparkles' };
const SEG_FALLBACK_ICON = { trivia: 'circle-help', sounditout: 'music', dare: 'drama', showdown: 'swords', rapidlist: 'list-checks', hotseat: 'flame', allplay: 'zap', grinch: 'hand-coins', doubledown: 'sparkles' };

const ERRORS = {
  offline: 'You’re offline — reconnecting…',
  timeout: 'No answer from the game — try again',
  'name-required': 'Type your name first',
  'no-such-team': 'That team is gone — pick another one',
  'ask-host': 'Ask the host to move you to another team',
  'game-full': 'The game is full — ask the host',
  'not-your-turn': 'It’s not your team’s turn',
  'not-now': 'Too late — that moment has passed',
  arming: 'Not yet — wait for the buzzers to arm!',
  'locked-out': 'Your team already had its try',
  'not-eligible': 'Your team can’t buzz on this one',
  'bad-target': 'You can’t pick that team',
  'empty-answer': 'Type an answer first',
  'bad-amount': 'That wager is out of range',
  'bad-level': 'Pick Easy, Medium or Hard',
  'bad-choice': 'Pick Nailed it or Good try',
  'slow-down': 'Whoa — slow down a little!',
  'not-joined': 'Join the game first',
  'no-team': 'Pick a team first',
  'hello-first': 'Still connecting — try again',
  'no-secret': 'Your secret is gone',
  'server-error': 'Something went wrong — try again',
};
const errorText = (code) => ERRORS[code] || 'That didn’t work — try again';

const teamLite = (t) => (t ? { id: t.id, name: t.name, color: t.color, mascot: t.mascot, score: t.score, rank: t.rank } : null);
const teamOf = (s, id) => (s.teams || []).find((t) => t.id === id) || null;
const segOf = (s, c = s.challenge) => (c && c.segmentIndex != null ? (s.segments || [])[c.segmentIndex] || null : null);
const playersOf = (s, teamId) => (s.players || []).filter((p) => p.teamId === teamId);
const isMe = (s, p) => !!p && !!s.me && p.playerId === s.me.playerId;
const mmss = (sec) => {
  const v = Math.max(0, Math.trunc(sec) || 0);
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};
const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function segIcon(seg) {
  if (!seg) return 'sparkles';
  if (hasIcon(seg.icon)) return seg.icon;
  if (seg.category === 'movies') return 'film';
  return SEG_FALLBACK_ICON[seg.type] || 'sparkles';
}
function segChip(seg, text) {
  if (!seg) return null;
  return { color: seg.color, ink: seg.ink, icon: segIcon(seg), text: text ?? seg.label };
}
function board(s, myId) {
  return (s.teams || [])
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.score - a.t.score || a.i - b.i)
    .map(({ t }) => ({ ...teamLite(t), you: t.id === myId, up: t.id === s.activeTeamId }));
}
function standingNote(s, my) {
  const others = (s.teams || []).filter((t) => t.id !== my.id);
  if (!others.length) return null;
  const tied = others.some((t) => t.score === my.score);
  if (my.rank === 1) {
    if (tied) return 'Tied for 1st';
    return `You’re 1st · ${formatPoints(my.score - Math.max(...others.map((t) => t.score)))} ahead`;
  }
  const above = Math.min(...others.filter((t) => t.score > my.score).map((t) => t.score));
  return `${tied ? 'Tied' : 'You’re'} ${ordinal(my.rank)} · ${formatPoints(above - my.score)} behind`;
}
const turnEyebrow = (s) => `Round ${s.round} · Turn ${Math.min(s.turnIndex + 1, s.turnsPerRound)} of ${s.turnsPerRound}`;
function nextUp(s, my) {
  const teams = s.teams || [];
  if (!teams.length) return null;
  if (s.turnIndex + 1 < teams.length) {
    const t = teams[s.turnIndex + 1];
    return t.id === my.id ? 'Next up: your team — get ready!' : `Next up: ${t.name}`;
  }
  if (s.round >= s.totalRounds) return 'Next up: Final Chaos!';
  const t = teams[0];
  return t.id === my.id ? `Round ${s.round + 1} opens with your team!` : `Round ${s.round + 1} opens with ${t.name}`;
}
const teammates = (s, my) => playersOf(s, my.id).filter((p) => !isMe(s, { playerId: p.id }));

/* ================================================================== derive: which screen ======= */

function derive(s) {
  const me = s.me;
  const my = me && me.teamId ? teamOf(s, me.teamId) : null;
  if (!my || (ui.switching && s.phase === 'lobby')) return deriveJoin(s, my);
  switch (s.phase) {
    case 'lobby':
      return deriveLobby(s, my);
    case 'turnIntro':
      return s.activeTeamId === my.id ? deriveSpin(s, my, 'spin') : deriveWatch(s, my);
    case 'spinning':
      return s.activeTeamId === my.id ? deriveSpin(s, my, 'spinning') : deriveWatch(s, my);
    case 'challenge':
    case 'turnResult':
      return deriveChallenge(s, my);
    case 'roundBreak':
      if (s.challenge && s.challenge.type === 'bonus') return deriveAnswer(s, my, 'bonus');
      return deriveRoundBreak(s, my);
    case 'finalIntro':
      return deriveFinalIntro(s, my);
    case 'finalWager':
      return deriveWager(s, my);
    case 'finalAnswer':
      return deriveAnswer(s, my, 'final');
    case 'finalReveal':
      return deriveFinalReveal(s, my);
    case 'podium':
      return derivePodium(s, my);
    default:
      return deriveWatch(s, my);
  }
}

function deriveChallenge(s, my) {
  const c = s.challenge;
  if (!c) return deriveWatch(s, my);
  const mine = s.activeTeamId === my.id;
  switch (c.type) {
    case 'trivia':
      if (c.stage === 'pickDifficulty' && mine && s.can.pickDifficulty) return deriveDifficulty(s, my);
      if (c.stage === 'steal' && !mine) return deriveBuzzer(s, my);
      return deriveWatch(s, my);
    case 'sounditout':
      if (c.stage === 'perform' && s.secret) return deriveSecret(s, my, 'sound');
      if (c.stage === 'perform' && isMe(s, c.performer)) return derivePerform(s, my);
      if (c.stage === 'steal' && !mine) return deriveBuzzer(s, my);
      return deriveWatch(s, my);
    case 'dare':
      if (c.stage === 'perform' && s.secret) return deriveSecret(s, my, 'dare');
      if (c.stage === 'perform' && (isMe(s, c.performer) || isMe(s, c.partner))) return derivePerform(s, my);
      if (c.stage === 'vote' && !mine && c.vote && c.vote.open && (s.can.vote || s.myVote)) return deriveVote(s, my);
      return deriveWatch(s, my);
    case 'showdown':
      if (c.stage === 'pickRival' && mine && s.can.pickTarget) return derivePicker(s, my, 'showdown');
      if (c.stage === 'battle' && (isMe(s, c.performer) || (c.rival && s.me && c.rival.playerId === s.me.playerId))) return deriveCalledUp(s, my);
      return deriveWatch(s, my);
    case 'grinch':
      if (c.stage === 'pickTarget' && mine && s.can.pickTarget) return derivePicker(s, my, 'grinch');
      return deriveWatch(s, my);
    case 'hotseat':
      if (c.stage === 'hotseat' && isMe(s, c.performer)) return deriveHotseat(s, my);
      return deriveWatch(s, my);
    case 'allplay':
    case 'bonus':
      return deriveAnswer(s, my, c.type);
    case 'doubledown':
      if (mine && c.stage === 'spinAgain') return deriveSpin(s, my, 'double');
      return deriveWatch(s, my);
    default:
      return deriveWatch(s, my);
  }
}

/* ---------- join / team picker ---------- */
function deriveJoin(s, my) {
  const me = s.me;
  const mode = me && my && ui.switching ? 'switch' : me && !my ? 'pick' : 'join';
  const teams = (s.teams || []).map((t) => ({ ...teamLite(t), players: t.playerCount }));
  if (ui.pickTeam && !teams.some((t) => t.id === ui.pickTeam)) ui.pickTeam = null;
  const late = s.phase !== 'lobby';
  return {
    id: 'join',
    data: {
      mode,
      late,
      over: s.phase === 'podium',
      round: s.round,
      total: s.totalRounds,
      teams,
      selected: ui.pickTeam,
      currentTeamId: my ? my.id : null,
      kicked: ui.kicked && !me,
      removed: mode === 'pick' ? ui.removedTeam || '' : null,
      pending: ui.pending === 'join',
      named: !!(me && me.name),
    },
  };
}

/* ---------- lobby ---------- */
function deriveLobby(s, my) {
  const mates = playersOf(s, my.id).map((p) => ({ name: p.name, initial: initial(p.name), you: p.id === s.me.playerId, online: p.connected }));
  mates.sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0));
  return { id: 'lobby', data: { team: teamLite(my), mates, teamCount: (s.teams || []).length } };
}

/* ---------- your turn: SPIN ---------- */
function deriveSpin(s, my, mode) {
  const spinBy = s.spin && s.spin.by ? s.spin.by.name : null;
  return {
    id: 'spin',
    data: {
      mode, // 'spin' | 'double' | 'spinning'
      double: my.multiplier > 1,
      round: s.round,
      total: s.totalRounds,
      team: teamLite(my),
      can: !!s.can.spin,
      by: spinBy,
      byMe: !!(s.spin && s.spin.by && s.me && s.spin.by.playerId === s.me.playerId),
      pending: ui.pending === 'spin',
      board: board(s, my.id),
      note: standingNote(s, my),
      seg: mode === 'double' ? segChip(segOf(s)) : null,
    },
  };
}

/* ---------- trivia: pick difficulty ---------- */
function deriveDifficulty(s, my) {
  const c = s.challenge;
  const mult = my.multiplier > 1 ? my.multiplier : 1;
  const mates = teammates(s, my).map((p) => p.name);
  return {
    id: 'difficulty',
    data: {
      chip: segChip(segOf(s), c.categoryLabel),
      mult,
      levels: Object.entries(DIFF).map(([level, d]) => ({
        level,
        label: d.label,
        bars: d.bars,
        pts: d.pts * mult,
        steal: d.pts / 2,
        sub: level === 'medium' ? MEDIUM_SUB[c.category] || d.sub : d.sub,
      })),
      mates,
      pending: ui.pending === 'pick' ? ui.pendingLevel : null,
    },
  };
}

/* ---------- steal buzzer ---------- */
function deriveBuzzer(s, my) {
  const c = s.challenge;
  const b = c.buzz || { open: false, eligibleTeamIds: [], lockedTeamIds: [], winner: null };
  const act = teamOf(s, s.activeTeamId);
  const eligible = b.eligibleTeamIds.includes(my.id);
  let mode;
  if (b.winner && isMe(s, b.winner)) mode = 'won';
  else if (b.winner && b.winner.teamId === my.id) mode = 'team';
  else if (b.lockedTeamIds.includes(my.id)) mode = 'locked';
  else if (b.winner) mode = 'lost';
  else if (!eligible) mode = 'locked';
  else if (b.armingUntil) mode = 'arming';
  else if (b.open && s.can.buzz) mode = 'armed';
  else mode = 'closed';
  const winTeam = b.winner ? teamOf(s, b.winner.teamId) : null;
  return {
    id: 'buzzer',
    data: {
      mode,
      sound: c.type === 'sounditout',
      chip: segChip(segOf(s), c.type === 'trivia' ? c.categoryLabel : undefined),
      difficulty: c.difficulty ? DIFF[c.difficulty]?.label || cap(c.difficulty) : null,
      points: c.stealPoints,
      missed: act ? act.name : 'They',
      myTeam: my.name,
      winner: b.winner ? { name: b.winner.name, team: teamLite(winTeam) } : null,
      armingUntil: b.armingUntil || null,
      pending: ui.pending === 'buzz',
    },
  };
}

/* ---------- performer: secret card ---------- */
function secretLabel(label) {
  const l = String(label || '').toLowerCase();
  if (/song|hum|tune/.test(l)) return 'Your song';
  if (/movie|film|special/.test(l)) return 'Your movie';
  if (/word/.test(l)) return 'Your word';
  if (/gift|present/.test(l)) return 'Your gift';
  if (/character/.test(l)) return 'Your character';
  return 'Your secret';
}
function deriveSecret(s, my, kind) {
  const c = s.challenge;
  const sec = s.secret;
  const seg = segOf(s);
  const isSong = kind === 'sound';
  return {
    id: 'secret',
    data: {
      kind,
      cid: c.id,
      chip: segChip(seg, isSong ? `Sound It Out · ${c.points} pts` : `Dare · ${c.dare ? c.dare.title : ''}`),
      name: s.me.name,
      team: my.name,
      label: isSong ? 'Your song' : secretLabel(sec.label),
      value: sec.value,
      rule: isSong ? `Hum it — no words!${sec.detail ? ` (${sec.detail})` : ''}` : sec.label,
      points: c.points,
      partner: c.partner && c.partner.playerId !== s.me.playerId ? c.partner.name : c.partner && c.performer && !isMe(s, c.performer) ? c.performer.name : null,
    },
  };
}

/* ---------- performer without a secret (dare) ---------- */
function derivePerform(s, my) {
  const c = s.challenge;
  const d = c.dare || null;
  const other = isMe(s, c.performer) ? c.partner : c.performer;
  return {
    id: 'perform',
    data: {
      chip: segChip(segOf(s), d ? `Dare · ${c.points} pts` : undefined),
      title: d ? d.title : segOf(s)?.label || 'Your moment',
      instructions: d ? d.instructions : c.rule,
      props: d ? d.props || [] : [],
      partner: other && other.name ? other.name : null,
      points: c.points,
      team: my.name,
    },
  };
}

/* ---------- room vote ---------- */
function deriveVote(s, my) {
  const c = s.challenge;
  const act = teamOf(s, s.activeTeamId);
  const mult = act && act.multiplier > 1 ? act.multiplier : 1;
  const performer = c.performer ? c.performer.name : act ? act.name : 'they';
  return {
    id: 'vote',
    data: {
      chip: segChip(segOf(s), `Dare · ${c.dare ? c.dare.title : ''}`),
      performer,
      team: act ? act.name : '',
      myVote: s.myVote,
      editing: ui.voteEdit && !!s.myVote,
      can: !!s.can.vote,
      nailed: 200 * mult,
      good: 100 * mult,
      pending: ui.pending === 'vote',
    },
  };
}

/* ---------- Grinch Steal / Showdown rival picker ---------- */
function derivePicker(s, my, kind) {
  const c = s.challenge;
  const targets = (c.targets || [])
    .map((id) => teamOf(s, id))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((t) => ({
      ...teamLite(t),
      take: Math.min(c.points, t.score),
      leader: t.rank === 1,
      eyedBy: c.eyeing && c.eyeing.teamId === t.id && c.eyeing.by && s.me && c.eyeing.by.playerId !== s.me.playerId ? c.eyeing.by.name : null,
    }));
  const sel = ui.target && ui.target.cid === c.id && targets.some((t) => t.id === ui.target.teamId) ? ui.target.teamId : null;
  const safe = kind === 'grinch' ? (s.teams || []).filter((t) => t.id !== my.id && !(c.targets || []).includes(t.id)).map(teamLite) : [];
  return {
    id: 'picker',
    data: {
      kind,
      cid: c.id,
      seg: segChip(segOf(s)),
      points: c.points,
      targets,
      safe,
      selected: sel,
      can: !!s.can.pickTarget,
      pending: ui.pending === 'target',
      team: my.name,
    },
  };
}

/* ---------- Showdown: you're called up ---------- */
function deriveCalledUp(s, my) {
  const c = s.challenge;
  const side = isMe(s, c.performer) ? 'active' : 'rival';
  const opp = side === 'active' ? (c.rival ? { name: c.rival.name || 'Their player', team: teamLite(teamOf(s, c.rival.teamId)) } : null)
    : c.performer ? { name: c.performer.name, team: teamLite(teamOf(s, c.performer.teamId)) } : null;
  const sd = c.showdown || {};
  return {
    id: 'calledup',
    data: {
      seg: segChip(segOf(s)),
      me: { name: s.me.name, team: teamLite(my) },
      opp,
      title: sd.title || 'Head to head',
      instructions: sd.instructions || '',
      winner: sd.winner && sd.winner.length <= 60 ? sd.winner : '',
      props: sd.props || [],
      points: c.points,
    },
  };
}

/* ---------- Hot Seat performer ---------- */
function deriveHotseat(s, my) {
  const c = s.challenge;
  const hs = c.hotseat || { index: 0, total: 6, results: [], question: null, each: 50, banked: 0 };
  return {
    id: 'hotseat',
    data: {
      seg: segChip(segOf(s)),
      name: s.me.name,
      started: !!c.started,
      question: hs.question,
      index: hs.index,
      total: hs.total,
      results: hs.results,
      banked: hs.banked || 0,
      each: hs.each,
    },
  };
}

/* ---------- typed answers: All Play, round bonus, Final Chaos ---------- */
function deriveAnswer(s, my, kind) {
  const c = kind === 'final' ? null : s.challenge;
  const sub = s.myTeam && s.myTeam.submission;
  const F = s.final || {};
  let stage;
  if (kind === 'final') stage = s.can.submitAnswer ? 'answering' : 'locked';
  else stage = c.stage === 'answering' && s.can.submitAnswer ? 'answering' : c.stage === 'done' ? 'done' : 'locked';
  const key = kind === 'final' ? `final:${s.gameNo}` : `${kind}:${c.id}`;
  const data = {
    kind,
    key,
    stage,
    question: kind === 'final' ? F.question || '' : c.question,
    sub: sub ? { text: sub.text, by: sub.by, mine: !!(s.me && sub.byPlayerId === s.me.playerId) } : null,
    pending: ui.pending === 'answer',
    max: ANSWER_MAX,
    teamColor: my.color,
  };
  if (kind === 'allplay') {
    data.points = c.points;
    data.first = c.firstBonus || 50;
  } else if (kind === 'bonus') {
    data.points = c.points;
    data.round = s.roundBreak ? s.roundBreak.round : s.round;
  } else {
    data.category = F.categoryLabel || 'Final';
    data.catIcon = FINAL_ICONS[F.category] || 'sparkles';
    data.wager = s.myTeam && s.myTeam.wager ? s.myTeam.wager.amount : 0;
  }
  if (stage === 'done' && c) {
    const row = (c.submissions || []).find((r) => r.teamId === my.id) || null;
    data.result = {
      answered: !!(row && row.answered),
      text: row && row.text != null ? row.text : null,
      by: row ? row.name || null : null,
      correct: !!(row && row.correct),
      first: !!(row && row.first),
      delta: row && row.delta ? row.delta : 0,
      answer: c.answer || '',
      fact: c.funFact || '',
      firstTeam: c.firstTeamId && c.firstTeamId !== my.id ? teamOf(s, c.firstTeamId)?.name || null : null,
    };
  }
  return { id: 'answer', data };
}

/* ---------- Final Chaos ---------- */
function deriveFinalIntro(s, my) {
  const F = s.final || {};
  const max = s.myTeam && s.myTeam.maxWager != null ? s.myTeam.maxWager : Math.max(my.score, 300);
  return { id: 'finalintro', data: { category: F.categoryLabel || 'Mystery', catIcon: FINAL_ICONS[F.category] || 'sparkles', score: my.score, max, behind: my.score < 300 } };
}
function deriveWager(s, my) {
  const F = s.final || {};
  const max = s.myTeam && s.myTeam.maxWager != null ? s.myTeam.maxWager : Math.max(my.score, 300);
  const w = s.myTeam && s.myTeam.wager;
  const key = `final:${s.gameNo}`;
  if (!ui.wager || ui.wager.key !== key) ui.wager = { key, amount: w && w.locked ? w.amount : Math.min(max, Math.round(max / 2 / 25) * 25) };
  ui.wager.amount = Math.max(0, Math.min(max, ui.wager.amount));
  return {
    id: 'wager',
    data: {
      key,
      category: F.categoryLabel || 'Mystery',
      catIcon: FINAL_ICONS[F.category] || 'sparkles',
      score: my.score,
      max,
      locked: w && w.locked ? { amount: w.amount, by: w.by, mine: !!(s.me && w.by === s.me.name) } : null,
      can: !!s.can.wager,
      pending: ui.pending === 'wager',
    },
  };
}
function deriveFinalReveal(s, my) {
  const F = s.final || {};
  const revealed = F.revealed || [];
  const rows = (F.revealOrder || []).map((id) => {
    const t = teamOf(s, id);
    const r = revealed.find((x) => x.teamId === id) || null;
    return {
      team: teamLite(t),
      you: id === my.id,
      current: F.current === id,
      revealed: !!r,
      text: r ? r.text || '' : null,
      wager: r ? r.wager : null,
      judged: !!(r && r.judged),
      correct: r ? r.correct : null,
      delta: r && r.judged ? r.delta : null,
    };
  });
  const mine = rows.find((r) => r.you) || null;
  const sub = s.myTeam && s.myTeam.submission;
  const w = s.myTeam && s.myTeam.wager;
  return {
    id: 'freveal',
    data: {
      question: F.question || '',
      answer: F.answer || null,
      rows,
      mine,
      myText: sub ? sub.text : null,
      myWager: w ? w.amount : 0,
      pos: mine ? rows.indexOf(mine) + 1 : null,
      count: rows.length,
    },
  };
}

/* ---------- round break ---------- */
function deriveRoundBreak(s, my) {
  const rb = s.roundBreak || { round: s.round, nextRound: s.round + 1, finalNext: false, standings: [] };
  const standings = (rb.standings || []).map((r) => ({ ...teamLite(teamOf(s, r.teamId)), rank: r.rank, move: r.move, places: r.places, you: r.teamId === my.id, score: r.score }));
  const me = standings.find((r) => r.you);
  return {
    id: 'roundbreak',
    data: { round: rb.round, next: rb.nextRound, total: s.totalRounds, finalNext: !!rb.finalNext, standings, me: me || null, note: standingNote(s, my), bonus: !!rb.bonusPlanned && !rb.bonusDone },
  };
}

/* ---------- podium ---------- */
function derivePodium(s, my) {
  const P = s.podium || { standings: [], awards: [] };
  const mine = (P.standings || []).find((r) => r.teamId === my.id);
  const place = mine ? mine.place : my.rank;
  return {
    id: 'podium',
    data: {
      place,
      score: mine ? mine.score : my.score,
      team: teamLite(my),
      tied: (P.standings || []).filter((r) => r.place === place).length > 1,
      awards: (P.awards || []).filter((a) => a.teamId === my.id).map((a) => ({ title: a.title, name: a.name, detail: a.detail, key: a.key, you: isMe(s, a) })),
      others: (P.awards || []).filter((a) => a.teamId !== my.id).map((a) => ({ title: a.title, name: a.name, team: teamOf(s, a.teamId)?.name || '' })),
      standings: (P.standings || []).map((r) => ({ ...teamLite(teamOf(s, r.teamId)), place: r.place, score: r.score, you: r.teamId === my.id })),
    },
  };
}

/* ---------- watching (what's happening now + mini scoreboard) ---------- */
function deriveWatch(s, my) {
  const act = teamOf(s, s.activeTeamId);
  const mine = !!act && act.id === my.id;
  const now = happening(s, my, act, mine);
  return {
    id: 'watch',
    data: {
      up: act ? { ...teamLite(act), mine } : null,
      eyebrow: act ? `Up now · ${turnEyebrow(s)}` : '',
      heading: act ? (mine ? 'Your team is up!' : act.name) : 'Watch the TV',
      now,
      callout: callout(s, my, act, mine, now),
      board: board(s, my.id),
      note: standingNote(s, my),
    },
  };
}

const RESULT_TITLE = {
  correct: 'Correct!', stolen: 'Stolen!', missed: 'Nobody got it', nailed: 'Nailed it!', valiant: 'Valiant effort', fail: 'Not this time',
  win: 'Showdown won!', tie: 'It’s a tie!', list: 'Time’s up!', hotseat: 'Hot Seat over', allplay: 'Answers revealed', bonus: 'Answers revealed',
  steal: 'Points moved', gift: 'Gift delivered', skipped: 'Skipped',
};

function happening(s, my, act, mine) {
  const c = s.challenge;
  const seg = segOf(s);
  const out = { label: 'Happening now', chip: null, chip2: null, title: '', question: false, body: '', lines: [], vs: null, dots: null, ticks: null, tally: null, result: null, timer: false, tone: 'pine' };
  const actName = act ? act.name : 'The team';
  if (s.phase === 'turnIntro') {
    out.label = 'Coming up';
    out.title = 'Spin coming up…';
    out.body = mine ? 'Anyone on your team can spin.' : `Someone on ${actName} spins from their phone — watch the wheel on the TV.`;
    return out;
  }
  if (s.phase === 'spinning') {
    out.title = 'The wheel is spinning…';
    out.body = s.spin && s.spin.by ? `${s.spin.by.name} spun for ${actName}.` : `${actName} spun the wheel.`;
    return out;
  }
  if (!c) {
    out.title = 'Watch the TV';
    return out;
  }
  out.timer = true;
  out.tone = 'seg';
  const pts = c.points;
  switch (c.type) {
    case 'trivia': {
      out.chip = segChip(seg, c.categoryLabel);
      if (c.difficulty) out.chip2 = `${DIFF[c.difficulty]?.label || c.difficulty} · ${pts}`;
      if (c.stage === 'pickDifficulty') {
        out.title = 'Picking a difficulty';
        out.body = `${mine ? 'Your team chooses' : `${actName} chooses`} Easy 100, Medium 200 or Hard 300.`;
        out.timer = false;
      } else {
        out.title = c.question || '';
        out.question = true;
        if (c.movie) out.lines.push({ icon: 'film', text: `From ${c.movie}${c.movieYear ? ` (${c.movieYear})` : ''}` });
        if (c.hint) out.lines.push({ icon: 'lightbulb', text: `Hint: ${c.hint}` });
        if (c.stage === 'question') out.body = mine ? 'Answer out loud — the host is listening.' : `If ${actName} misses, you can steal it for ${c.stealPoints}.`;
        if (c.stage === 'steal') out.body = c.buzz && c.buzz.winner ? `${c.buzz.winner.name} buzzed first to steal for ${c.stealPoints}.` : `Steal! Other teams can buzz in for ${c.stealPoints}.`;
      }
      break;
    }
    case 'sounditout': {
      out.chip = segChip(seg, `Sound It Out · ${pts}`);
      const who = c.performer ? c.performer.name : 'Someone';
      if (c.stage === 'perform') {
        out.title = `${who} is humming a song`;
        out.body = mine ? 'Shout out the title — no words from the hummer!' : `${actName} has 30 seconds to name it. Miss it and you can steal for ${c.stealPoints}.`;
      } else if (c.stage === 'steal') {
        out.title = 'Name that tune — steal!';
        out.body = c.buzz && c.buzz.winner ? `${c.buzz.winner.name} buzzed first.` : `Other teams can buzz in for ${c.stealPoints}.`;
      } else {
        out.title = c.answer ? `“${c.answer}”` : 'Name that tune';
        if (c.artist) out.body = `by ${c.artist}`;
      }
      break;
    }
    case 'dare': {
      const d = c.dare || {};
      out.chip = segChip(seg, `Dare · ${pts} pts`);
      out.title = d.title || 'Dare';
      out.body = d.instructions || '';
      const perf = [c.performer && c.performer.name, c.partner && c.partner.name].filter(Boolean);
      if (perf.length) out.lines.push({ icon: 'drama', text: `Performing: ${listJoin(perf, 'and')}` });
      if (d.hasSecret && c.stage !== 'done') out.lines.push({ icon: 'eye-off', text: 'The secret is on the performer’s phone' });
      if (c.stage === 'vote' && c.vote) out.tally = { nailed: c.vote.nailed, good: c.vote.good, voters: c.vote.voters, eligible: c.vote.eligible };
      if (c.answer) out.lines.push({ icon: 'eye', text: `The secret: ${c.answer}` });
      break;
    }
    case 'showdown': {
      out.chip = segChip(seg, `Showdown · ${pts} to win`);
      if (c.stage === 'pickRival') {
        out.title = mine ? 'Your team is picking a rival' : `${actName} is picking a rival`;
        out.body = 'One player from each team goes head to head.';
        if (c.eyeing) {
          const eyed = teamOf(s, c.eyeing.teamId);
          out.lines.push({ icon: 'crosshair', text: `${c.eyeing.by.name} is eyeing ${eyed && eyed.id === my.id ? 'YOUR team' : eyed ? eyed.name : 'a team'}…` });
        }
        out.timer = false;
      } else {
        const sd = c.showdown || {};
        out.title = sd.title || 'Showdown';
        out.body = sd.instructions || '';
        if (c.performer && c.rival) {
          out.vs = {
            a: { name: c.performer.name, team: teamLite(teamOf(s, c.performer.teamId)) },
            b: { name: c.rival.name || '?', team: teamLite(teamOf(s, c.rival.teamId)) },
          };
        }
      }
      break;
    }
    case 'rapidlist': {
      const L = c.list || { prompt: '', ticked: [], count: 0, max: 6, each: 50 };
      out.chip = segChip(seg, `Rapid List · ${L.each} each`);
      out.title = L.prompt;
      out.question = true;
      out.body = `${L.count} of ${L.max} so far · ${formatPoints(Math.min(L.count, L.max) * L.each)} pts`;
      out.ticks = L.ticked.slice(-12);
      break;
    }
    case 'hotseat': {
      const hs = c.hotseat || { index: 0, total: 6, results: [], question: null, banked: 0, each: 50 };
      out.chip = segChip(seg, `Hot Seat · ${hs.each} each`);
      out.title = `${c.performer ? c.performer.name : 'Someone'} is in the Hot Seat`;
      out.body = hs.question ? `Q${Math.min(hs.index + 1, hs.total)}: ${hs.question}` : c.stage === 'done' ? `Banked ${formatPoints(hs.banked)} points.` : 'Up to 6 quick questions in 45 seconds.';
      out.dots = { results: hs.results, total: hs.total, index: hs.index };
      break;
    }
    case 'grinch': {
      out.chip = segChip(seg, `Grinch Steal · ${pts}`);
      out.timer = false;
      if (c.stage === 'pickTarget') {
        out.title = 'Grinch Steal!';
        out.body = `${mine ? 'Your team is' : `${actName} is`} choosing a team to rob…`;
        if (c.eyeing) {
          const eyed = teamOf(s, c.eyeing.teamId);
          out.lines.push({ icon: 'crosshair', text: `${c.eyeing.by.name} is eyeing ${eyed && eyed.id === my.id ? 'YOUR team!' : eyed ? eyed.name : 'a team'}` });
        }
      } else if (c.steal) {
        const from = teamOf(s, c.steal.from);
        const to = teamOf(s, c.steal.to);
        out.title = `${to ? to.name : 'They'} stole ${formatPoints(c.steal.amount)}!`;
        out.body = `Taken from ${from ? (from.id === my.id ? 'your team' : from.name) : 'a team'}.`;
      } else if (c.gift) {
        const to = teamOf(s, c.gift.toTeamId);
        out.title = 'The Grinch’s heart grew!';
        out.body = `${actName} is in the lead, so ${formatPoints(c.gift.amount)} goes to ${to ? (to.id === my.id ? 'your team' : to.name) : 'last place'} instead.`;
      }
      break;
    }
    case 'doubledown':
      out.chip = segChip(seg, 'Double Down · ×2');
      out.title = 'Double Down!';
      out.body = `${mine ? 'Your team spins' : `${actName} spins`} again — everything ${mine ? 'you win' : 'they win'} this turn is doubled.`;
      out.timer = false;
      break;
    case 'allplay':
    case 'bonus':
      out.chip = segChip(seg, 'All Play');
      out.title = c.question || '';
      out.question = true;
      break;
    default:
      out.title = seg ? seg.label : 'Watch the TV';
  }
  if (c.result) {
    const kind = c.result.kind;
    let title = RESULT_TITLE[kind] || 'Done';
    if (kind === 'win' && c.winnerSide) {
      const t = c.winnerSide === 'active' ? act : c.rival ? teamOf(s, c.rival.teamId) : null;
      if (t) title = `${t.id === my.id ? 'Your team' : t.name} won the Showdown!`;
    }
    if (kind === 'stolen' && c.buzz && c.buzz.winner) title = `${c.buzz.winner.name} stole it!`;
    out.result = {
      kind,
      title,
      good: ['correct', 'stolen', 'nailed', 'win', 'tie', 'list', 'hotseat', 'valiant', 'gift', 'steal', 'allplay', 'bonus'].includes(kind),
      answer: c.type === 'trivia' ? c.answer || '' : '',
      fact: c.type === 'trivia' ? c.funFact || '' : '',
      deltas: (c.result.awards || []).filter((a) => a.delta).map((a) => ({ team: teamLite(teamOf(s, a.teamId)), delta: a.delta, you: a.teamId === my.id })),
    };
    out.timer = false;
    out.label = 'Result';
  }
  return out;
}

function callout(s, my, act, mine, now) {
  const c = s.challenge;
  if (now.result) {
    const d = now.result.deltas.find((x) => x.you);
    if (d && d.delta > 0) return { tone: 'good', icon: 'party-popper', title: `${formatDelta(d.delta)} for your team!`, sub: nextUp(s, my) };
    if (d && d.delta < 0) return { tone: 'warn', icon: 'hand-coins', title: `${formatDelta(d.delta)} — ouch!`, sub: nextUp(s, my) };
    return { tone: 'tv', icon: 'tv', title: 'Watch the TV!', sub: nextUp(s, my) };
  }
  if (mine && c) {
    const perf = c.performer ? c.performer.name : null;
    switch (c.type) {
      case 'trivia':
        if (c.stage === 'question') return { tone: 'team', icon: 'mic', title: 'Answer out loud!', sub: 'Agree on one answer — the host is listening.' };
        if (c.stage === 'steal') return { tone: 'warn', icon: 'bell-ring', title: 'The other teams can steal', sub: 'Fingers crossed nobody knows it…' };
        if (c.stage === 'pickDifficulty') return { tone: 'team', icon: 'pointer', title: 'Pick a difficulty', sub: 'A teammate is choosing on their phone.' };
        break;
      case 'sounditout':
        if (c.stage === 'perform') return { tone: 'team', icon: 'music', title: 'Guess the song!', sub: `${perf || 'Your performer'} is humming — shout out titles.` };
        if (c.stage === 'steal') return { tone: 'warn', icon: 'bell-ring', title: 'The other teams can steal', sub: 'Fingers crossed…' };
        break;
      case 'dare':
        if (c.stage === 'vote') return { tone: 'team', icon: 'users', title: 'The room is voting', sub: 'Nailed it or good try? The other teams decide.' };
        if (c.dare && (c.dare.who === 'team' || c.dare.who === 'everyone')) return { tone: 'team', icon: 'users', title: 'Everyone on your team plays!', sub: 'Watch the TV for the rules.' };
        return { tone: 'team', icon: 'heart', title: `Cheer on ${perf || 'your performer'}!`, sub: c.dare && c.dare.hasSecret ? 'Guess what they are acting out.' : 'Help them nail it for 200.' };
      case 'showdown':
        if (c.stage === 'battle') return { tone: 'team', icon: 'megaphone', title: `Cheer for ${perf || 'your player'}!`, sub: 'Winner takes 200.' };
        break;
      case 'rapidlist':
        return { tone: 'team', icon: 'megaphone', title: 'Shout your answers!', sub: '50 points each, up to 6 — the host ticks them off.' };
      case 'hotseat':
        return { tone: 'team', icon: 'volume-x', title: 'No helping!', sub: `${perf || 'Your player'} is on their own.` };
      case 'grinch':
        if (c.stage === 'pickTarget') return { tone: 'team', icon: 'hand-coins', title: 'A teammate is picking', sub: 'Choose wisely…' };
        break;
      default:
        break;
    }
    return { tone: 'team', icon: 'tv', title: 'It’s your team’s turn', sub: 'Watch the TV for what happens next.' };
  }
  if (c && c.type === 'grinch' && c.stage === 'pickTarget' && (c.targets || []).includes(my.id)) {
    return { tone: 'warn', icon: 'triangle-alert', title: 'Your team could be robbed!', sub: `${act ? act.name : 'They'} can take up to ${formatPoints(Math.min(c.points, my.score))} from you.` };
  }
  if (c && c.type === 'showdown' && c.stage === 'pickRival') {
    return { tone: 'warn', icon: 'swords', title: 'Will they pick you?', sub: 'If they do, one of you gets called up.' };
  }
  if (c && c.type === 'hotseat' && c.performer) return { tone: 'tv', icon: 'volume-x', title: 'Shh — no helping!', sub: nextUp(s, my) };
  if (c && (c.type === 'trivia' || c.type === 'sounditout') && (c.stage === 'question' || c.stage === 'perform')) {
    return { tone: 'tv', icon: 'bell-ring', title: 'Get ready to steal!', sub: 'If they miss, your buzzer lights up.' };
  }
  return { tone: 'tv', icon: 'tv', title: 'Watch the TV!', sub: nextUp(s, my) };
}

/* ================================================================== header ==================== */

function deriveHeader(s) {
  const me = s.me;
  const my = me && me.teamId ? teamOf(s, me.teamId) : null;
  if (!my || (ui.switching && s.phase === 'lobby')) {
    const live = s.phase !== 'lobby' && s.phase !== 'podium';
    return { kind: 'brand', players: (s.players || []).filter((p) => p.connected && p.teamId).length, live, round: s.round, total: s.totalRounds };
  }
  return { kind: 'team', team: teamLite(my), leader: my.rank === 1 && my.score > 0 && (s.teams || []).length > 1, x2: my.multiplier > 1 };
}

function renderHeader(hd) {
  if (hd.kind === 'brand') {
    headScore = null;
    setHTML(
      topbarEl,
      h`<div class="topbar__brand">${ic('snowflake', { size: 28 })}<span class="topbar__word">Christmas Chaos</span></div>
        <span class="topbar__pill">${hd.live ? `Round ${hd.round} of ${hd.total}` : `${plural(hd.players, 'player')} in`}</span>`
    );
    return;
  }
  const t = hd.team;
  const from = headScore && headScore.teamId === t.id ? headScore.score : t.score;
  setHTML(
    topbarEl,
    h`<div class="topbar__team" data-tc="${t.color}">${discH(t, 'sm')}<span class="topbar__name">${t.name}</span></div>
      <div class="topbar__score">
        ${hd.x2 ? h`<span class="topbar__x2" title="Double Down">×2</span>` : ''}
        ${hd.leader ? h`<span class="topbar__crown" title="In the lead">${ic('crown', { size: 20, label: 'In the lead' })}</span>` : ''}
        <span class="topbar__pts num" data-score>${formatPoints(from)}</span><span class="topbar__unit">pts</span>
      </div>`
  );
  hydrate(topbarEl);
  const el = topbarEl.querySelector('[data-score]');
  if (from !== t.score) {
    animateNumber(el, t.score, { from });
    el.classList.add('is-bump');
    setTimeout(() => el.classList.remove('is-bump'), 700);
  }
  headScore = { teamId: t.id, score: t.score };
}

/* ================================================================== markup helpers ============ */

function discH(t, size = 'sm') {
  if (!t) return '';
  return h`<span class="disc disc--${size}" data-tc="${t.color}" aria-hidden="true">${ic(mascotFor(t.mascot).icon, { size: '53%', stroke: 2.4 })}</span>`;
}
function chipH(chip, extra = '') {
  if (!chip) return '';
  return h`<span class="chip chip--sm seg-chip ${extra}" data-sc="${chip.color}" data-si="${chip.ink}">${ic(chip.icon, { size: 18 })}<span class="truncate">${chip.text}</span></span>`;
}
/** Timer pill (tiny ring + m:ss). Hidden until a timer is running; patched by tick(). */
function timerPillH(label = 'seconds left') {
  const t = S && S.timer;
  return h`<span class="tpill" data-timer-wrap data-unit="" role="timer" aria-label="${label}" hidden>${timerRing(t, client.serverNow(), { size: 30 })}<span class="tpill__text num" data-timer-text>${mmss(timerSeconds(t, client.serverNow()))}</span></span>`;
}
function timerRingH(size = 72) {
  const t = S && S.timer;
  return h`<span class="tring" data-timer-wrap data-unit="SEC" hidden>${timerRing(t, client.serverNow(), { size, unit: 'SEC' })}</span>`;
}
function boardH(rows, note, { title = 'Scoreboard', compact = false } = {}) {
  if (!rows || !rows.length) return '';
  if (compact) {
    return h`<section class="panel board board--grid" aria-labelledby="board-h">
      <div class="board__head"><h2 class="label" id="board-h">${title}</h2>${note ? h`<span class="board__note">${note}</span>` : ''}</div>
      <ol class="board__grid" role="list">${rows.map(
        (r) => h`<li class="board__cell${r.you ? ' is-you' : ''}" data-tc="${r.color}">${discH(r, 'xs')}<span class="sr-only">${r.name}${r.you ? ' (you)' : ''}</span><span class="num">${formatPoints(r.score)}</span></li>`
      )}</ol>
    </section>`;
  }
  return h`<section class="panel board" aria-labelledby="board-h">
    <div class="board__head"><h2 class="label" id="board-h">${title}</h2>${note ? h`<span class="board__note">${note}</span>` : ''}</div>
    <ol class="board__list" role="list">${rows.map(
      (r) => h`<li class="board__row${r.you ? ' is-you' : ''}${r.up ? ' is-up' : ''}" data-tc="${r.color}">
        <span class="board__rank num">${r.rank}</span>${discH(r, 'xs')}
        <span class="board__name"><span class="truncate">${r.name}</span>${r.you ? h`<span class="mini-tag mini-tag--you">You</span>` : ''}${r.up && !r.you ? h`<span class="mini-tag mini-tag--up">Up now</span>` : ''}</span>
        <span class="board__score num">${formatPoints(r.score)}</span>
      </li>`
    )}</ol>
  </section>`;
}
function noteH(icon, html, tone = '') {
  return h`<aside class="note ${tone}">${ic(icon, { size: 26 })}<p>${html}</p></aside>`;
}
function bars(n) {
  return h`<span class="diff__bars" aria-hidden="true">${[1, 2, 3].map((i) => h`<i class="${i <= n ? 'on' : ''}"></i>`)}</span>`;
}

/* ================================================================== screens =================== */

const RENDER = {};
const BIND = {};
/** PATCH[id](root, data, prev): update the live screen in place (keeps focus, keyboard and drags); false = rebuild. */
const PATCH = {};

/* ---------- connecting ---------- */
RENDER.connecting = () => h`<div class="center-stage">
  <span class="center-stage__icon">${ic('snowflake', { size: 64 })}</span>
  <h1 class="title">Christmas Chaos</h1>
  <p class="lede">Connecting to the party <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
</div>`;

/* ---------- join ---------- */
RENDER.join = (d) => {
  const sel = d.teams.find((t) => t.id === d.selected) || null;
  const heading = d.mode === 'switch' ? 'Switch team' : d.mode === 'pick' ? 'Pick a new team' : d.late ? 'Jump in!' : 'Join the game';
  let btnLabel;
  if (!d.teams.length) btnLabel = 'Waiting for teams…';
  else if (!sel) btnLabel = 'Pick a team to join';
  else if (d.mode === 'switch' && sel.id === d.currentTeamId) btnLabel = `Stay on ${sel.name}`;
  else btnLabel = `${d.mode === 'switch' ? 'Move to' : 'Join'} ${sel.name}`;
  return h`
  ${d.late && d.mode !== 'switch' ? h`<span class="tag tag--ghost join__live">${ic('radio', { size: 16 })}${d.over ? 'Game over' : 'Game in progress'}</span>` : ''}
  <h1 class="title">${heading}</h1>
  ${d.kicked ? noteH('user-x', h`<strong>You were taken out of the game.</strong> You can join again below.`, 'note--alert') : ''}
  ${d.removed != null ? noteH('triangle-alert', d.removed ? h`<strong>${d.removed} was removed.</strong> Pick another team to keep playing.` : h`<strong>You’re not on a team right now.</strong> Pick one to keep playing.`, 'note--warn') : ''}
  ${d.late && d.mode === 'join' && !d.kicked ? h`<p class="lede">The game has started — pick a team and you’re in.</p>` : ''}
  <div class="field">
    <div class="field__row"><label class="label" for="player-name">Your name</label><span class="field__hint">Shown on the TV</span></div>
    <input id="player-name" class="input" type="text" data-draft="name" value="${ui.drafts.name || ''}" maxlength="${NAME_MAX}" autocomplete="nickname" autocapitalize="words" enterkeyhint="done" spellcheck="false" placeholder="e.g. Aunt Linda" required>
  </div>
  <section class="join__teams" aria-labelledby="team-h">
    <h2 class="join__h" id="team-h">Pick your team</h2>
    ${d.teams.length
      ? h`<div class="team-grid${d.teams.length > 6 ? ' team-grid--dense' : ''}" role="group" aria-labelledby="team-h">${d.teams.map(
          (t) => h`<button type="button" class="tile" data-team="${t.id}" data-tc="${t.color}" aria-pressed="${t.id === d.selected ? 'true' : 'false'}">
            <span class="tile__icon">${ic(mascotFor(t.mascot).icon, { size: 26, stroke: 2.4 })}</span>
            <span class="tile__text"><span class="tile__name">${t.name}</span><span class="tile__meta">${tileMeta(d, t)}</span></span>
            ${t.id === d.currentTeamId ? h`<span class="tile__now">Now</span>` : ''}
            <span class="tile__check" aria-hidden="true">${ic('check', { size: 18, stroke: 3.2 })}</span>
          </button>`
        )}</div>`
      : h`<div class="empty">${ic('users', { size: 40 })}<p><strong>No teams yet.</strong> The host is setting them up <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p></div>`}
  </section>
  <div class="actions">
    <button type="button" class="btn btn--lg btn--block join__go${sel ? ' btn--team' : ' btn--secondary'}" data-join ${sel ? h`data-tc="${sel.color}"` : ''} aria-disabled="${!sel || d.pending ? 'true' : 'false'}" data-needs-online>
      ${d.pending ? h`<span>Joining…</span>` : h`<span>${btnLabel}</span>${sel ? ic('arrow-right', { size: 26 }) : ''}`}
    </button>
    ${d.mode === 'switch' ? h`<button type="button" class="btn btn--link join__cancel" data-cancel>Cancel — keep my team</button>` : ''}
  </div>`;
};
function tileMeta(d, t) {
  return `${d.late ? `${formatPoints(t.score)} pts · ` : ''}${t.players ? plural(t.players, 'player') : 'Be the first!'}`;
}
PATCH.join = (root, d, prev) => {
  const same = ['mode', 'late', 'over', 'selected', 'currentTeamId', 'kicked', 'removed', 'pending'].every((k) => d[k] === prev[k]);
  if (!same || d.teams.length !== prev.teams.length) return false;
  if (d.teams.some((t, i) => ['id', 'name', 'color', 'mascot'].some((k) => t[k] !== prev.teams[i][k]))) return false;
  for (const t of d.teams) {
    const el = root.querySelector(`[data-team="${CSS.escape(t.id)}"] .tile__meta`);
    if (el) el.textContent = tileMeta(d, t);
  }
  return true;
};
BIND.join = (root, d) => {
  root.querySelectorAll('[data-team]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.pickTeam = ui.pickTeam === b.dataset.team && d.mode !== 'switch' ? null : b.dataset.team;
      render();
    })
  );
  const name = root.querySelector('#player-name');
  name?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      name.blur();
    }
  });
  root.querySelector('[data-join]')?.addEventListener('click', doJoin);
  root.querySelector('[data-cancel]')?.addEventListener('click', () => {
    ui.switching = false;
    ui.pickTeam = null;
    render();
  });
};
async function doJoin() {
  if (!S || ui.pending) return;
  const nameEl = screenEl.querySelector('#player-name');
  const name = String(ui.drafts.name || '').trim();
  if (!name) {
    nameEl?.focus();
    shake(nameEl);
    toast('Type your name first', { tone: 'warn' });
    return;
  }
  if (!ui.pickTeam) {
    shake(screenEl.querySelector('.team-grid'));
    toast('Tap a team to join', { tone: 'warn' });
    return;
  }
  if (ui.switching && S.me && ui.pickTeam === S.me.teamId && name === S.me.name) {
    ui.switching = false;
    render();
    return;
  }
  const res = await act('join', 'join', { name, teamId: ui.pickTeam });
  if (res && res.ok) {
    try {
      localStorage.setItem(LS_NAME, name);
    } catch {
      /* private mode */
    }
    ui.kicked = false;
    ui.removedTeam = null;
    ui.switching = false;
    ui.pickTeam = null;
    vibrate(30);
    render();
  }
}

/* ---------- waiting lobby ---------- */
RENDER.lobby = (d) => h`
  <div class="lobby__hero" data-tc="${d.team.color}">
    ${discH(d.team, 'hero')}
    <h1 class="lobby__title"><span class="lobby__on">You’re on</span><span class="lobby__team">${d.team.name}</span></h1>
  </div>
  <div class="status-pill" role="status"><span>Waiting for the host to start</span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
  <section class="panel mates" aria-labelledby="mates-h" data-tc="${d.team.color}">
    <div class="mates__head">
      <h2 class="label" id="mates-h">Your team · ${d.mates.length}</h2>
      ${d.teamCount > 1 ? h`<button type="button" class="btn btn--link" data-switch>Switch team</button>` : ''}
    </div>
    <ul class="mates__list" role="list">${d.mates.map(
      (m) => h`<li class="mate${m.you ? ' is-you' : ''}${m.online ? '' : ' is-offline'}"><span class="mate__avatar" aria-hidden="true">${m.initial}</span><span class="mate__name">${m.name}${m.you ? h` <span class="mate__you">(you)</span>` : ''}${m.online ? '' : h` <span class="mate__off">· offline</span>`}</span></li>`
    )}</ul>
  </section>
  ${noteH('smartphone', h`<strong>Keep this page open.</strong> If your screen locks, you’ll rejoin automatically.`, 'note--end')}`;
BIND.lobby = (root) => {
  root.querySelector('[data-switch]')?.addEventListener('click', () => {
    ui.switching = true;
    ui.pickTeam = S && S.me ? S.me.teamId : null;
    render();
  });
};

/* ---------- SPIN ---------- */
RENDER.spin = (d) => {
  const spinning = d.mode === 'spinning';
  const tag = d.mode === 'double' ? 'Double Down · ×2' : `Your turn · Round ${d.round} of ${d.total}`;
  const title = spinning ? 'Spinning…' : d.mode === 'double' ? 'Spin again!' : 'Your team is up!';
  const lede = spinning
    ? d.byMe ? 'You spun it! Watch the TV.' : d.by ? `${d.by} spun it! Watch the TV.` : 'Watch the TV!'
    : d.mode === 'double' ? 'Everything you win this turn is doubled.' : 'Tap to spin the wheel on the TV.';
  const live = !spinning && d.can && !d.pending;
  return h`
  <div class="spin">
    <span class="tag ${d.mode === 'double' ? 'tag--holly' : ''}">${d.mode === 'double' ? ic('sparkles', { size: 16 }) : ''}${tag}</span>
    <h1 class="title title--xl">${title}</h1>
    <p class="lede">${lede}</p>
    <div class="spin__stage">
      <div class="btn-halo${live ? ' is-live' : ''}">
        <button type="button" class="btn-round btn-round--spin spin__btn${spinning || d.pending ? ' is-spinning' : ''}" data-spin aria-label="Spin the wheel" aria-disabled="${live ? 'false' : 'true'}" data-needs-online>
          ${raw(miniWheelMarkup(S ? S.segments : undefined))}<span>SPIN</span>
        </button>
      </div>
    </div>
    <p class="spin__who">${ic('users', { size: 24 })}<span>${spinning ? 'Good luck!' : 'Anyone on your team can spin'}</span></p>
  </div>
  ${boardH(d.board, d.note, { compact: true })}`;
};
BIND.spin = (root, d) => {
  const b = root.querySelector('[data-spin]');
  if (b && d.mode !== 'spinning') onPress(b, () => act('spin', 'spin', {}, { quiet: ['not-now'] }), { haptic: 30 });
};

/* ---------- pick difficulty ---------- */
RENDER.difficulty = (d) => h`
  ${chipH(d.chip)}
  <h1 class="title">Pick your risk</h1>
  <p class="lede">Answer out loud as a team. Miss it and the other teams can steal.</p>
  ${d.mult > 1 ? h`<p class="x2-note">${ic('sparkles', { size: 20 })}Double Down — every value is doubled!</p>` : ''}
  <div class="diff-list" role="group" aria-label="Difficulty">${d.levels.map(
    (l) => h`<button type="button" class="diff diff--${l.level}${d.pending === l.level ? ' is-picked' : ''}" data-level="${l.level}" aria-disabled="${d.pending ? 'true' : 'false'}" data-needs-online>
      <span class="diff__main">
        <span class="diff__label"><span class="diff__name">${l.label}</span>${bars(l.bars)}</span>
        <span class="diff__sub">${l.sub}</span>
        <span class="diff__steal">Miss it? Others steal ${l.steal}</span>
      </span>
      <span class="diff__pts"><span class="num">${l.pts}</span><span class="diff__unit">points</span></span>
    </button>`
  )}</div>
  ${noteH('pointer', d.mates.length ? h`<strong>First tap on your team decides.</strong> ${listJoin(d.mates, 'and')} ${d.mates.length === 1 ? 'sees' : 'see'} these buttons too.` : h`<strong>It’s all you!</strong> Your tap decides.`, 'note--end')}`;
BIND.difficulty = (root) => {
  root.querySelectorAll('[data-level]').forEach((b) =>
    b.addEventListener('click', () => {
      if (ui.pending) return;
      ui.pendingLevel = b.dataset.level;
      act('pick', 'pickDifficulty', { level: b.dataset.level });
    })
  );
};

/* ---------- buzzer ---------- */
RENDER.buzzer = (d) => {
  const chips = h`<div class="chip-row">${chipH(d.chip)}${d.difficulty ? h`<span class="chip chip--sm chip--outline">${d.difficulty}</span>` : ''}</div>`;
  let head;
  let circle;
  let foot;
  switch (d.mode) {
    case 'armed':
      head = h`<h1 class="buzz__big">STEAL!</h1><p class="buzz__line">Buzz in for ${d.points}</p><p class="buzz__sub">${d.sound ? `${d.missed} ran out of time — name that tune!` : `${d.missed} missed it — steal it!`}</p>`;
      circle = h`<div class="btn-halo btn-halo--buzz is-live"><button type="button" class="btn-round btn-round--buzz" data-buzz aria-label="Buzz in to steal for ${d.points}" data-needs-online>${ic('bell-ring', { size: 88 })}<span>BUZZ</span></button></div>`;
      foot = h`<p class="buzz__foot-main">Know it? Hit the buzzer!</p><p class="buzz__foot-sub">Any ${d.myTeam} phone can buzz.</p>`;
      break;
    case 'arming':
      head = h`<h1 class="buzz__big">STEAL!</h1><p class="buzz__line">Get ready…</p><p class="buzz__sub">${d.missed} ${d.sound ? 'ran out of time' : 'missed it'} — steal for ${d.points}.</p>`;
      circle = h`<div class="btn-round btn-round--closed buzz__arming" role="img" aria-label="Buzzers arm in a moment"><span class="buzz__count num" data-countdown="${d.armingUntil}">3</span><span class="buzz__ready">GET READY</span></div>`;
      foot = h`<p class="buzz__foot-main">Buzzers arm in a moment</p><p class="buzz__foot-sub">Don’t jump the gun — wait for the red button!</p>`;
      break;
    case 'won':
      head = h`<h1 class="buzz__big buzz__big--won">You buzzed first!</h1><p class="buzz__sub">${d.myTeam} has the steal —<br>${d.points} points on the line.</p>`;
      circle = h`<div class="btn-halo is-live"><div class="btn-round btn-round--won" role="img" aria-label="Buzzed in first">${ic('check', { size: 96, stroke: 3 })}<span>FIRST!</span></div></div>`;
      foot = h`<p class="buzz__foot-main buzz__foot-main--big">${ic('mic', { size: 28 })}Answer out loud now</p><p class="buzz__foot-sub">The host is listening — speak up!</p>`;
      break;
    case 'team':
      head = h`<h1 class="buzz__big buzz__big--won">${d.winner.name} buzzed first!</h1><p class="buzz__sub">Your team has the steal — ${d.points} points on the line.</p>`;
      circle = h`<div class="btn-halo is-live"><div class="btn-round btn-round--won buzz__team" role="img" aria-label="Your team buzzed first">${ic('users', { size: 88, stroke: 2.6 })}<span>YOUR TEAM!</span></div></div>`;
      foot = h`<p class="buzz__foot-main buzz__foot-main--big">${ic('mic', { size: 28 })}Help ${d.winner.name} answer</p><p class="buzz__foot-sub">One answer, out loud — the host is listening.</p>`;
      break;
    case 'lost':
      head = h`${discH(d.winner.team, 'md')}<h1 class="buzz__big buzz__big--lost">${d.winner.name} buzzed first</h1><p class="buzz__sub">${d.winner.team ? d.winner.team.name : 'They'} ${d.winner.team && /s$/i.test(d.winner.team.name) ? 'get' : 'gets'} the shot at the steal.</p>`;
      circle = h`<div class="btn-round btn-round--closed" role="img" aria-label="Buzzer closed">${ic('hourglass', { size: 80 })}<span>SO CLOSE</span></div>`;
      foot = h`<p class="buzz__foot-main">Stay sharp for the next one!</p><p class="buzz__foot-sub">Watch the TV for ${d.winner.name}’s answer.</p>`;
      break;
    case 'locked':
      head = h`<span class="buzz__lock-icon">${ic('lock', { size: 26 })}</span><h1 class="buzz__big buzz__big--lost">Your team had its try</h1><p class="buzz__sub">Each team gets one shot at a steal.</p>`;
      circle = h`<div class="btn-round btn-round--closed" role="img" aria-label="Buzzer locked">${ic('lock', { size: 80 })}<span>LOCKED</span></div>`;
      foot = h`<p class="buzz__foot-main">Hang tight!</p><p class="buzz__foot-sub">Other teams may still steal — watch the TV.</p>`;
      break;
    default:
      head = h`<h1 class="buzz__big buzz__big--lost">Buzzers closed</h1><p class="buzz__sub">The host may open them again.</p>`;
      circle = h`<div class="btn-round btn-round--closed" role="img" aria-label="Buzzer closed">${ic('hourglass', { size: 80 })}<span>WAIT</span></div>`;
      foot = h`<p class="buzz__foot-main">Hold on…</p><p class="buzz__foot-sub">Watch the TV.</p>`;
  }
  return h`<div class="buzz buzz--${d.mode}">
    ${chips}
    <div class="buzz__head" aria-live="polite">${head}</div>
    <div class="buzz__stage">${circle}</div>
    <div class="buzz__foot">${foot}</div>
    <div class="buzz__timer">${timerPillH('seconds left to steal')}</div>
  </div>`;
};
BIND.buzzer = (root, d) => {
  const b = root.querySelector('[data-buzz]');
  if (b && d.mode === 'armed') onPress(b, () => act('buzz', 'buzz', {}, { quiet: ['not-now'] }), { haptic: 40 });
};

/* ---------- secret card ---------- */
RENDER.secret = (d) => h`
  ${chipH(d.chip)}
  <div class="stack-tight">
    <h1 class="title">Only you can see this</h1>
    <p class="lede">${d.kind === 'sound'
      ? `${d.name}, hum this song for ${d.team}. No words — hum, whistle or la-la-la!`
      : d.partner ? `${d.name}, you and ${d.partner} are performing. Keep your screen away from your team.` : `${d.name}, you’re the performer. Keep your screen turned away from your team.`}</p>
  </div>
  ${secretCard({ label: d.label, value: d.value, rule: d.rule, tone: d.kind === 'sound' ? 'violet' : 'gold' })}
  <div class="info-row">
    <span class="info-row__icon">${ic('timer', { size: 24 })}</span>
    <span class="info-row__text">
      <span class="info-row__main" data-timer-show="idle">When you’re ready, tell the host to start the timer</span>
      <span class="info-row__main" data-timer-show="started" hidden>The clock is running — go, go, go!</span>
      <span class="info-row__sub">${d.kind === 'sound' ? `Your team names it for ${d.points}` : `Nail it for ${d.points} points`}</span>
    </span>
    ${timerPillH()}
  </div>
  <p class="foot-hint">${ic('eye', { size: 20 })}Hold to peek as often as you need</p>`;
BIND.secret = (root, d) => {
  cleanup = bindSecretCard(root, {
    onReveal: () => {
      const k = `${d.cid}:${d.value}`;
      if (ui.peeked.has(k)) return;
      ui.peeked.add(k);
      client.emit('peek').then((r) => {
        if (!r.ok) ui.peeked.delete(k);
      });
    },
  });
};

/* ---------- dare performer without a secret ---------- */
RENDER.perform = (d) => h`
  ${chipH(d.chip)}
  <div class="stack-tight">
    <h1 class="title">You’re performing!</h1>
    <p class="lede">${d.partner ? `You and ${d.partner} are up for ${d.team}.` : `All eyes on you — do it for ${d.team}!`}</p>
  </div>
  <section class="panel panel--accent perform" data-sc="${d.chip ? d.chip.color : ''}">
    <span class="label">The dare</span>
    <h2 class="perform__title">${d.title}</h2>
    <p class="perform__text">${d.instructions}</p>
    ${d.props.length ? h`<div class="props"><span class="props__label">${ic('gift', { size: 18 })}You’ll need</span><ul class="props__list" role="list">${d.props.map((p) => h`<li>${p}</li>`)}</ul></div>` : ''}
  </section>
  <div class="info-row">
    <span class="info-row__icon">${ic('timer', { size: 24 })}</span>
    <span class="info-row__text">
      <span class="info-row__main" data-timer-show="idle">When you’re ready, tell the host to start the timer</span>
      <span class="info-row__main" data-timer-show="started" hidden>The clock is running — go!</span>
      <span class="info-row__sub">Nail it for ${d.points} points</span>
    </span>
    ${timerPillH()}
  </div>`;

/* ---------- room vote ---------- */
RENDER.vote = (d) => {
  const voting = d.can && (!d.myVote || d.editing);
  return h`
  ${chipH(d.chip)}
  <div class="vote__head">
    <h1 class="title">How did ${d.performer} do?</h1>
    ${timerPillH('seconds left to vote')}
  </div>
  <p class="lede">${d.team ? `${possessive(d.team)} performer just took a bow.` : ''} Be honest — and be kind!</p>
  ${voting
    ? h`<div class="vote__choices" role="group" aria-label="Vote on ${d.performer}’s dare">
        <button type="button" class="vote-btn vote-btn--nailed${d.myVote === 'nailed' ? ' is-current' : ''}" data-vote="nailed" aria-disabled="${d.pending ? 'true' : 'false'}" data-needs-online>
          <span class="vote-btn__icon">${ic('thumbs-up', { size: 46 })}</span>
          <span class="vote-btn__text"><span class="vote-btn__label">Nailed it</span><span class="vote-btn__sub">Worth ${d.nailed} points</span></span>
        </button>
        <button type="button" class="vote-btn vote-btn--good${d.myVote === 'good' ? ' is-current' : ''}" data-vote="good" aria-disabled="${d.pending ? 'true' : 'false'}" data-needs-online>
          <span class="vote-btn__icon">${ic('hand-metal', { size: 46 })}</span>
          <span class="vote-btn__text"><span class="vote-btn__label">Good try</span><span class="vote-btn__sub">Worth ${d.good} points</span></span>
        </button>
      </div>`
    : h`<div class="panel vote__sent vote__sent--${d.myVote || 'none'}" role="status">
        <span class="vote__sent-icon">${ic('check', { size: 60, stroke: 3 })}</span>
        <h2 class="vote__sent-title">Vote sent — thanks!</h2>
        <div class="vote__mine">
          <span class="vote__mine-icon">${ic(d.myVote === 'good' ? 'hand-metal' : 'thumbs-up', { size: 28 })}</span>
          <span class="vote__mine-text"><span class="label">You voted</span><span class="vote__mine-label">${d.myVote === 'good' ? 'Good try' : 'Nailed it'}</span></span>
        </div>
        ${d.can ? h`<button type="button" class="btn btn--link vote__change" data-change>${ic('undo-2', { size: 20 })}Change vote</button>` : ''}
      </div>`}
  <p class="foot-hint foot-hint--end">${ic('users', { size: 18 })}Majority wins — the host has the final say</p>`;
};
BIND.vote = (root) => {
  root.querySelectorAll('[data-vote]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await act('vote', 'vote', { choice: b.dataset.vote });
      if (res && res.ok) {
        ui.voteEdit = false;
        vibrate(25);
        render();
      }
    })
  );
  root.querySelector('[data-change]')?.addEventListener('click', () => {
    ui.voteEdit = true;
    render();
  });
};

/* ---------- target picker (Grinch Steal / Showdown) ---------- */
RENDER.picker = (d) => {
  const grinch = d.kind === 'grinch';
  const sel = d.targets.find((t) => t.id === d.selected) || null;
  return h`<div class="picker picker--${d.kind}" data-sc="${d.seg ? d.seg.color : ''}" data-si="${d.seg ? d.seg.ink : ''}">
  <div class="picker__hero">
    <span class="picker__badge">${ic(grinch ? 'hand-coins' : 'swords', { size: 42 })}</span>
    <h1 class="picker__title">${grinch ? h`<span>GRINCH</span><span class="picker__accent">STEAL!</span>` : h`<span>SHOW</span><span class="picker__accent">DOWN!</span>`}</h1>
  </div>
  <div class="stack-tight">
    <p class="picker__ask">${grinch ? 'Pick a team ahead of you' : 'Pick your rival'}</p>
    <p class="lede lede--sm">${grinch ? h`<strong>${formatPoints(d.points)} points</strong> jump from their score to yours.` : h`One player from each team goes head to head. <strong>Winner takes ${formatPoints(d.points)}.</strong>`}</p>
  </div>
  <div class="targets" role="group" aria-labelledby="targets-h">
    <span class="label" id="targets-h">${grinch ? 'Teams ahead of you' : 'Choose a team'}</span>
    ${d.targets.map(
      (t) => h`<button type="button" class="target${t.id === d.selected ? ' is-selected' : ''}" data-target="${t.id}" data-tc="${t.color}" aria-pressed="${t.id === d.selected ? 'true' : 'false'}" ${d.can ? '' : 'aria-disabled="true"'}>
        ${discH(t, 'md')}
        <span class="target__text">
          <span class="target__name"><span class="truncate">${t.name}</span>${t.leader ? ic('crown', { size: 18, label: 'Leader' }) : ''}</span>
          <span class="target__meta"><strong class="num">${formatPoints(t.score)}</strong>pts${grinch ? ` · you’d take ${formatPoints(t.take)}` : ''}</span>
          ${t.eyedBy ? h`<span class="target__eyed">${ic('crosshair', { size: 14 })}${t.eyedBy} is eyeing them</span>` : ''}
        </span>
        <span class="target__radio" aria-hidden="true">${t.id === d.selected ? ic('check', { size: 18, stroke: 3 }) : ''}</span>
      </button>`
    )}
  </div>
  ${d.safe.length ? h`<p class="safe">${ic('shield-check', { size: 20 })}<span>${listJoin(d.safe.map((t) => t.name), 'and')} ${d.safe.length === 1 ? 'is' : 'are'} not ahead of you, so ${d.safe.length === 1 ? 'they’re' : 'they’re'} safe</span></p>` : ''}
  <div class="actions">
    <button type="button" class="btn btn--lg btn--block picker__go" data-confirm aria-disabled="${!sel || !d.can || d.pending ? 'true' : 'false'}" data-needs-online>
      ${ic(grinch ? 'hand-coins' : 'swords', { size: 26 })}<span>${d.pending ? 'Sending…' : sel ? `${grinch ? 'Steal from' : 'Challenge'} ${sel.name}` : 'Tap a team first'}</span>
    </button>
  </div></div>`;
};
let lastPreview;
function preview(teamId) {
  if (!S || !S.can.previewTarget || lastPreview === teamId) return;
  lastPreview = teamId;
  client.emit('previewTarget', { teamId });
}
BIND.picker = (root, d) => {
  lastPreview = d.selected;
  root.querySelectorAll('[data-target]').forEach((b) => {
    const id = b.dataset.target;
    // the TV shows "Mia is eyeing …" as soon as a finger lands on a team (or a mouse hovers it)
    b.addEventListener('pointerdown', () => preview(id));
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') preview(id); });
    b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') preview(ui.target && ui.target.cid === d.cid ? ui.target.teamId : null); });
    b.addEventListener('click', () => {
      if (!S || !S.can.previewTarget) return;
      const next = ui.target && ui.target.cid === d.cid && ui.target.teamId === id ? null : id;
      ui.target = next ? { cid: d.cid, teamId: next } : null;
      preview(next);
      vibrate(10);
      render();
    });
  });
  root.querySelector('[data-confirm]')?.addEventListener('click', async () => {
    if (!d.selected) {
      toast('Tap a team first', { tone: 'warn' });
      return;
    }
    const res = await act('target', 'pickTarget', { teamId: d.selected });
    if (res && res.ok) ui.target = null;
  });
};

/* ---------- Showdown: called up ---------- */
RENDER.calledup = (d) => h`<div class="called" data-sc="${d.seg ? d.seg.color : ''}" data-si="${d.seg ? d.seg.ink : ''}">
  <div class="called__hero">
    <span class="picker__badge">${ic('swords', { size: 44 })}</span>
    <div class="stack-tight">
      <span class="called__eyebrow">Showdown · ${formatPoints(d.points)} to win</span>
      <h1 class="title title--sm">You’re in the Showdown!</h1>
    </div>
  </div>
  <div class="versus panel" role="group" aria-label="${d.me.name} vs ${d.opp ? d.opp.name : 'rival'}">
    <div class="versus__side is-you" data-tc="${d.me.team.color}">${discH(d.me.team, 'lg')}<span class="versus__name">${d.me.name}</span><span class="versus__team">${d.me.team.name}</span><span class="mini-tag mini-tag--you">You</span></div>
    <span class="versus__vs" aria-hidden="true">VS</span>
    ${d.opp ? h`<div class="versus__side" data-tc="${d.opp.team ? d.opp.team.color : ''}">${discH(d.opp.team, 'lg')}<span class="versus__name">${d.opp.name}</span><span class="versus__team">${d.opp.team ? d.opp.team.name : ''}</span></div>` : h`<div class="versus__side"></div>`}
  </div>
  <div class="go-front">
    <span class="go-front__icon">${ic('megaphone', { size: 32 })}</span>
    <span class="go-front__text"><span class="go-front__title">Get to the front!</span><span class="go-front__sub">Stand by the TV — the host starts the clock</span></span>
  </div>
  <section class="panel panel--accent challenge">
    <div class="challenge__top"><span class="chip chip--sm seg-chip">${ic('swords', { size: 16 })}The challenge</span>${timerPillH()}</div>
    <h2 class="challenge__title">${d.title}</h2>
    ${d.instructions ? h`<p class="challenge__text">${d.instructions}</p>` : ''}
    <p class="challenge__win">${ic('trophy', { size: 18 })}<span>${d.winner ? `${d.winner} · ` : ''}Winner takes ${formatPoints(d.points)} · a tie is ${formatPoints(Math.round(d.points / 2))} each</span></p>
  </section>
  <p class="foot-hint foot-hint--dashed">${ic('smartphone', { size: 24 })}<span><strong>Felt the buzz?</strong> That’s your cue. Phone down — you’ll need both hands.</span></p>
</div>`;

/* ---------- Hot Seat performer ---------- */
RENDER.hotseat = (d) => h`
  <div class="hot__head">
    ${chipH(d.seg)}
    ${timerPillH()}
  </div>
  <div class="stack-tight">
    <h1 class="title">You’re in the Hot Seat!</h1>
    <p class="lede">${d.started ? 'Answer out loud — or say “pass” to skip.' : `${d.total} quick questions, ${d.each} points each. No help from your team!`}</p>
  </div>
  ${d.started && d.question
    ? h`<section class="panel panel--accent hot__q" data-sc="${d.seg ? d.seg.color : ''}" aria-live="polite"><span class="label">Question ${Math.min(d.index + 1, d.total)} of ${d.total}</span><p class="question">${d.question}</p></section>`
    : h`<section class="panel hot__ready"><span class="hot__flame">${ic('flame', { size: 48 })}</span><p class="hot__ready-title">${d.index >= d.total ? 'All done — great job!' : 'Get ready…'}</p><p class="lede lede--sm">${d.index >= d.total ? 'Watch the TV for your total.' : 'The host starts the 45-second clock. Questions appear here and on the TV.'}</p></section>`}
  <div class="hot__progress">
    <ol class="dots-row" role="list" aria-label="Progress">${Array.from({ length: d.total }, (_, i) => {
      const r = d.results[i];
      const cls = r ? `is-${r}` : i === d.index && d.started ? 'is-current' : '';
      return h`<li class="${cls}">${r === 'correct' ? ic('check', { size: 16, stroke: 3 }) : r === 'wrong' ? ic('x', { size: 16, stroke: 3 }) : r === 'pass' ? ic('skip-forward', { size: 14 }) : ''}<span class="sr-only">${r || 'pending'}</span></li>`;
    })}</ol>
    <span class="hot__banked"><span class="num">${formatPoints(d.banked)}</span> banked</span>
  </div>
  ${noteH('volume-x', h`<strong>Your team must stay quiet.</strong> Only you answer in the Hot Seat.`, 'note--end')}`;

/* ---------- typed answers ---------- */
RENDER.answer = (d) => {
  const final = d.kind === 'final';
  const eyebrow = final ? null : d.kind === 'bonus' ? h`${ic('sparkles', { size: 18 })}Round ${d.round} bonus · ${d.points} each` : h`${ic('zap', { size: 18 })}All Play · ${d.points} + ${d.first} first`;
  const head = final
    ? h`<div class="stack-tight"><div class="answer__top"><span class="answer__eyebrow answer__eyebrow--muted">${ic('sparkle', { size: 18 })}Final answer</span>${d.stage === 'answering' ? timerPillH('seconds left to answer') : ''}</div><span class="final-word final-word--lg">FINAL CHAOS</span></div>
       <div class="chip-row"><span class="chip chip--sm final-chip">${ic(d.catIcon, { size: 18 })}${d.category}</span><span class="chip chip--sm chip--locked">${ic('lock', { size: 16 })}Wager ${formatPoints(d.wager)}</span></div>`
    : h`<div class="stack-tight"><span class="answer__eyebrow">${eyebrow}</span>
       <div class="answer__top"><h1 class="title">${d.stage === 'done' ? 'The reveal' : d.stage === 'locked' ? 'Answers are in' : 'Type it in!'}</h1>${d.stage === 'answering' ? timerPillH('seconds left to answer') : ''}</div></div>`;
  const q = h`<section class="panel ${final ? '' : 'panel--accent panel--ember'} answer__q" aria-label="The question"><span class="label">${final ? 'The question' : 'Question for every team'}</span><p class="question">${d.question}</p></section>`;
  if (d.stage === 'done' && d.result) {
    const r = d.result;
    return h`${head}${q}
      <section class="panel result-card ${r.correct ? 'is-good' : 'is-bad'}" role="status">
        <span class="result-card__icon">${ic(r.correct ? 'check' : r.answered ? 'x' : 'circle-help', { size: 34, stroke: 3 })}</span>
        <div class="result-card__body">
          <span class="result-card__title">${r.correct ? (r.first ? 'Correct — and first!' : 'Correct!') : r.answered ? 'Not this time' : 'No answer from your team'}</span>
          ${r.answered ? h`<span class="result-card__sub">Your team said “${r.text}”${r.by ? ` (${r.by})` : ''}</span>` : ''}
        </div>
        ${r.delta ? h`<span class="delta delta--up result-card__delta">${formatDelta(r.delta)}</span>` : ''}
      </section>
      <section class="panel reveal-answer"><span class="label">The answer</span><p class="reveal-answer__text">${r.answer}</p>${r.fact ? h`<p class="reveal-answer__fact">${r.fact}</p>` : ''}${r.firstTeam ? h`<p class="reveal-answer__fact">${ic('zap', { size: 16 })}${r.firstTeam} got it first.</p>` : ''}</section>
      <p class="foot-hint foot-hint--end">${ic('tv', { size: 18 })}Watch the TV for every team’s answer</p>`;
  }
  if (d.stage !== 'answering') {
    return h`${head}${q}
      <section class="panel locked-card" role="status">
        <span class="locked-card__icon">${ic('lock', { size: 30 })}</span>
        <div><span class="label">${final ? 'Answers locked' : 'Answers locked'}</span>
        ${d.sub ? h`<p class="locked-card__text">Your team’s answer: <strong>“${d.sub.text}”</strong> <span class="muted">${d.sub.mine ? '(you)' : `(${d.sub.by})`}</span></p>` : h`<p class="locked-card__text">Your team didn’t send an answer.</p>`}</div>
      </section>
      <div class="callout callout--tv">${ic('tv', { size: 34 })}<div><span class="callout__title">Watch the TV!</span><span class="callout__sub">The answers are revealed there.</span></div></div>`;
  }
  const draftKey = d.key;
  const val = ui.drafts[draftKey] ?? '';
  return h`${head}${q}
    <form class="answer__form" data-answer-form data-tc="${d.teamColor}" novalidate>
      <div class="field">
        <label class="answer__label" for="answer-input">Your team’s answer</label>
        <input id="answer-input" class="input input--answer ${final ? 'input--gold' : 'input--ember'}" type="text" data-draft="${draftKey}" value="${val}" maxlength="${d.max}" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" spellcheck="false" placeholder="Type your answer" aria-describedby="answer-hint">
        <div class="field__row field__row--hint" id="answer-hint"><span>${final ? 'Close spelling still counts' : 'The host checks every answer'}</span><span data-count>${val.length} / ${d.max}</span></div>
      </div>
      <div data-sent>${sentH(d)}</div>
      <div class="actions">
        <button type="submit" class="btn btn--lg btn--block ${final ? 'btn--primary' : 'btn--ember'}" data-needs-online ${d.pending ? 'aria-disabled="true"' : ''}>${ic('lock', { size: 26 })}<span data-answer-label>${answerLabel(d)}</span></button>
        <p class="foot-hint">${ic(final ? 'pencil' : 'info', { size: 18 })}${final ? 'You can change it until time runs out' : 'Last answer from your team counts'}</p>
      </div>
    </form>`;
};
function sentH(d) {
  if (!d.sub) return h`<div class="sent sent--none" role="status" aria-live="polite"><span class="sent__avatar" aria-hidden="true">${ic('pencil', { size: 18 })}</span><span class="sent__text">No answer from your team yet — anyone can send it.</span></div>`;
  return h`<div class="sent ${d.sub.mine ? 'sent--mine' : ''}" role="status" aria-live="polite"><span class="sent__avatar" aria-hidden="true">${d.sub.mine ? ic('check', { size: 20, stroke: 3 }) : initial(d.sub.by)}</span><span class="sent__text">${d.sub.mine ? h`<strong>You sent</strong> “${d.sub.text}” — you can change it until time runs out` : h`<strong>${d.sub.by}</strong> answered “${d.sub.text}” — your answer will replace it`}</span></div>`;
}
function answerLabel(d) {
  return d.pending ? 'Sending…' : d.sub ? 'Lock in new answer' : 'Lock in answer';
}
PATCH.answer = (root, d, prev) => {
  if (d.stage !== 'answering' || prev.stage !== 'answering' || d.key !== prev.key || d.question !== prev.question || d.pending !== prev.pending) return false;
  const box = root.querySelector('[data-sent]');
  const label = root.querySelector('[data-answer-label]');
  if (!box || !label) return false;
  setHTML(box, sentH(d));
  label.textContent = answerLabel(d);
  return true;
};
BIND.answer = (root, d) => {
  const form = root.querySelector('[data-answer-form]');
  if (!form) return;
  const input = form.querySelector('input');
  const count = form.querySelector('[data-count]');
  input.addEventListener('input', () => {
    if (count) count.textContent = `${input.value.length} / ${d.max}`;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      shake(input);
      input.focus();
      toast('Type an answer first', { tone: 'warn' });
      return;
    }
    const res = await act('answer', 'submitAnswer', { text });
    if (res && res.ok) {
      vibrate(25);
      toast('Answer locked in!', { tone: 'success', duration: 2200 });
      ui.drafts[d.key] = '';
      document.activeElement?.blur?.();
      render(true);
    }
  });
};

/* ---------- Final Chaos intro ---------- */
RENDER.finalintro = (d) => h`
  <div class="final-hero">
    <span class="final-hero__eyebrow">${ic('sparkle', { size: 18 })}The finale</span>
    <h1 class="final-word final-word--xl">FINAL CHAOS</h1>
    <span class="chip chip--sm final-chip">${ic(d.catIcon, { size: 18 })}Category: ${d.category}</span>
  </div>
  <section class="panel final-steps">
    <p class="final-steps__lead">Your team has <strong class="num">${formatPoints(d.score)}</strong> points.</p>
    <ol class="steps" role="list">
      <li><span class="steps__n num">1</span><span><strong>Wager</strong> up to ${formatPoints(d.max)}${d.behind ? ' (everyone can bet at least 300)' : ''}.</span></li>
      <li><span class="steps__n num">2</span><span><strong>Answer</strong> the final question on your phone.</span></li>
      <li><span class="steps__n num">3</span><span><strong>Win or lose</strong> your wager in the big reveal.</span></li>
    </ol>
  </section>
  <div class="callout callout--tv callout--end">${ic('tv', { size: 34 })}<div><span class="callout__title">Watch the TV!</span><span class="callout__sub">Wagers open in a moment.</span></div></div>`;

/* ---------- Final wager ---------- */
function stepFor(max) {
  return max % 25 === 0 ? 25 : 1;
}
RENDER.wager = (d) => {
  const amount = ui.wager ? ui.wager.amount : 0;
  const half = Math.floor(d.max / 2);
  const pct = d.max ? (amount / d.max) * 100 : 0;
  return h`
  <div class="stack-tight">
    <div class="answer__top"><span class="answer__eyebrow answer__eyebrow--muted">${ic('sparkle', { size: 18 })}Place your bet</span>${timerPillH('seconds left to wager')}</div>
    <span class="final-word final-word--lg">FINAL CHAOS</span>
  </div>
  <div class="stack-tight">
    <span class="chip chip--sm final-chip">${ic(d.catIcon, { size: 18 })}Category: ${d.category}</span>
    <p class="wager__have">Your team has <strong class="num">${formatPoints(d.score)}</strong>. How much will you risk?</p>
  </div>
  <section class="panel wager" data-wager>
    <div class="wager__readout">
      <label class="label" for="wager-range">Your wager</label>
      <span class="wager__amount"><span class="num" data-w-amount>${formatPoints(amount)}</span><span class="wager__unit">pts</span></span>
    </div>
    <input id="wager-range" class="range" type="range" min="0" max="${d.max}" step="${stepFor(d.max)}" value="${amount}" aria-valuetext="${formatPoints(amount)} points" data-w-range ${d.can ? '' : 'disabled'} data-pct="${pct.toFixed(2)}">
    <div class="wager__ends" aria-hidden="true"><span>0</span><span>${formatPoints(d.max)} max</span></div>
    <div class="wager__chips" role="group" aria-label="Quick wagers">
      <button type="button" class="qchip" data-w-set="0" aria-label="Wager nothing"><span class="qchip__main">0</span><span class="qchip__sub">play it safe</span></button>
      <button type="button" class="qchip" data-w-set="${half}" aria-label="Wager half, ${formatPoints(half)}"><span class="qchip__main">Half</span><span class="qchip__sub">${formatPoints(half)}</span></button>
      <button type="button" class="qchip" data-w-set="${d.max}" aria-label="Go all in, ${formatPoints(d.max)}"><span class="qchip__main">All in</span><span class="qchip__sub">${formatPoints(d.max)}</span></button>
    </div>
  </section>
  <div class="outcomes">
    <div class="outcome outcome--right"><span class="outcome__icon">${ic('check', { size: 18, stroke: 3 })}</span><span class="outcome__text"><span class="outcome__label">If right</span><span class="num" data-w-right>${formatPoints(d.score + amount)}</span></span></div>
    <div class="outcome outcome--wrong"><span class="outcome__icon">${ic('x', { size: 18, stroke: 3 })}</span><span class="outcome__text"><span class="outcome__label">If wrong</span><span class="num" data-w-wrong>${formatPoints(Math.max(0, d.score - amount))}</span></span></div>
  </div>
  <div class="actions">
    <button type="button" class="btn btn--lg btn--block ${d.locked && d.locked.amount === amount ? 'btn--holly' : 'btn--primary'}" data-w-lock data-needs-online aria-disabled="${!d.can || d.pending ? 'true' : 'false'}"><span data-w-icon>${ic(d.locked && d.locked.amount === amount ? 'check' : 'lock', { size: 26 })}</span><span data-w-label>${wagerLabel(d, amount)}</span></button>
    <p class="foot-hint" role="status" data-w-hint>${wagerHintH(d)}</p>
  </div>`;
};
function wagerHintH(d) {
  return h`${ic(d.locked ? 'lock' : 'users', { size: 18 })}<span>${d.locked ? `Locked in ${formatPoints(d.locked.amount)} by ${d.locked.mine ? 'you' : d.locked.by} — slide to change it` : 'Any teammate can lock in; the last lock wins'}</span>`;
}
PATCH.wager = (root, d, prev) => {
  if (['key', 'max', 'score', 'can', 'category'].some((k) => d[k] !== prev[k]) || !root._wagerUpdate) return false;
  Object.assign(prev, d); // BIND.wager's handlers read this same object
  setHTML(root.querySelector('[data-w-hint]'), wagerHintH(prev));
  root.querySelector('[data-w-lock]').setAttribute('aria-disabled', !prev.can || prev.pending ? 'true' : 'false');
  root._wagerUpdate(ui.wager.amount, false);
  return true;
};
function wagerLabel(d, amount) {
  if (d.pending) return 'Locking in…';
  if (d.locked && d.locked.amount === amount) return `Locked in ${formatPoints(amount)}`;
  if (d.locked) return `Change to ${formatPoints(amount)}`;
  return `Lock in ${formatPoints(amount)}`;
}
BIND.wager = (root, d) => {
  const range = root.querySelector('[data-w-range]');
  const update = (amount, fromRange) => {
    const a = Math.max(0, Math.min(d.max, Math.round(Number(amount) || 0)));
    ui.wager.amount = a;
    if (!fromRange) range.value = String(a);
    range.style.setProperty('--fill', `${d.max ? (a / d.max) * 100 : 0}%`);
    range.setAttribute('aria-valuetext', `${formatPoints(a)} points`);
    root.querySelector('[data-w-amount]').textContent = formatPoints(a);
    root.querySelector('[data-w-right]').textContent = formatPoints(d.score + a);
    root.querySelector('[data-w-wrong]').textContent = formatPoints(Math.max(0, d.score - a));
    root.querySelector('[data-w-label]').textContent = wagerLabel(d, a);
    const same = !!(d.locked && d.locked.amount === a);
    const lockBtn = root.querySelector('[data-w-lock]');
    lockBtn.classList.toggle('btn--holly', same);
    lockBtn.classList.toggle('btn--primary', !same);
    const iconEl = root.querySelector('[data-w-icon]');
    if (iconEl && iconEl.dataset.k !== String(same)) {
      iconEl.dataset.k = String(same);
      setHTML(iconEl, ic(same ? 'check' : 'lock', { size: 26 }));
    }
    root.querySelectorAll('[data-w-set]').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.wSet) === a));
  };
  root._wagerUpdate = update;
  update(ui.wager.amount, false);
  range.addEventListener('input', () => update(range.value, true));
  root.querySelectorAll('[data-w-set]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!d.can) return;
      update(b.dataset.wSet, false);
      vibrate(10);
    })
  );
  root.querySelector('[data-w-lock]').addEventListener('click', async () => {
    if (!d.can) return;
    const amount = ui.wager.amount;
    const res = await act('wager', 'wager', { amount });
    if (res && res.ok) {
      vibrate(30);
      toast(`Wager locked: ${formatPoints(amount)}`, { tone: 'success', icon: 'lock', duration: 2200 });
    }
  });
};

/* ---------- Final reveal ---------- */
RENDER.freveal = (d) => {
  const m = d.mine;
  let status;
  if (m && m.judged) status = m.correct ? h`<span class="delta delta--up">${formatDelta(m.delta)}</span>` : h`<span class="delta delta--down">${m.delta ? formatDelta(m.delta) : '±0'}</span>`;
  return h`
  <div class="stack-tight"><span class="answer__eyebrow answer__eyebrow--muted">${ic('sparkle', { size: 18 })}The big reveal</span><span class="final-word final-word--lg">FINAL CHAOS</span></div>
  <section class="panel answer__q"><span class="label">The question</span><p class="question question--sm">${d.question}</p>${d.answer ? h`<p class="freveal__answer">${ic('check', { size: 18, stroke: 3 })}${d.answer}</p>` : ''}</section>
  <section class="panel freveal__mine ${m && m.judged ? (m.correct ? 'is-good' : 'is-bad') : ''}">
    <span class="label">Your team</span>
    <div class="freveal__row">
      <div class="freveal__what">
        <span class="freveal__text">${d.myText ? `“${d.myText}”` : 'No answer'}</span>
        <span class="freveal__wager">Wagered ${formatPoints(d.myWager)}</span>
      </div>
      ${status || h`<span class="freveal__wait">${m && m.revealed ? 'Judging…' : d.pos ? `Revealed ${ordinal(d.pos)} of ${d.count}` : 'Waiting'}</span>`}
    </div>
  </section>
  <ol class="panel freveal__list" role="list" aria-label="Reveal order">${d.rows.map(
    (r) => h`<li class="freveal__item${r.current ? ' is-current' : ''}${r.you ? ' is-you' : ''}" data-tc="${r.team ? r.team.color : ''}">
      ${discH(r.team, 'xs')}<span class="freveal__name truncate">${r.team ? r.team.name : ''}</span>
      <span class="freveal__res">${r.judged ? h`<span class="freveal__mark ${r.correct ? 'is-good' : 'is-bad'}">${ic(r.correct ? 'check' : 'x', { size: 16, stroke: 3 })}</span><span class="num">${r.delta ? formatDelta(r.delta) : '±0'}</span>` : r.revealed ? h`<span class="muted">judging…</span>` : h`<span class="muted">${r.current ? 'up now' : 'waiting'}</span>`}</span>
    </li>`
  )}</ol>`;
};

/* ---------- round break ---------- */
RENDER.roundbreak = (d) => h`
  <div class="rb__hero">
    <span class="tag">End of Round ${d.round}</span>
    <h1 class="title title--xl">${d.finalNext ? 'Final Chaos next!' : d.next >= d.total ? 'Final round next!' : `Round ${d.next} of ${d.total} next`}</h1>
    <p class="lede">${d.bonus ? 'First, a bonus question for every team!' : 'Grab a mince pie — the host starts the next round soon.'}</p>
  </div>
  ${d.me ? h`<section class="panel rb__me" data-tc="${d.me.color}">${discH(d.me, 'lg')}<div><span class="label">Your team</span><span class="rb__place">${ordinal(d.me.rank)} place</span><span class="rb__note">${d.note || ''}</span></div>${d.me.move === 'up' ? h`<span class="rb__move is-up">${ic('arrow-up', { size: 20, stroke: 3 })}${d.me.places}</span>` : d.me.move === 'down' ? h`<span class="rb__move is-down">${ic('arrow-down', { size: 20, stroke: 3 })}${d.me.places}</span>` : ''}</section>` : ''}
  <section class="panel board" aria-labelledby="rb-h">
    <div class="board__head"><h2 class="label" id="rb-h">Standings</h2></div>
    <ol class="board__list" role="list">${d.standings.map(
      (r) => h`<li class="board__row${r.you ? ' is-you' : ''}" data-tc="${r.color}"><span class="board__rank num">${r.rank}</span>${discH(r, 'xs')}<span class="board__name"><span class="truncate">${r.name}</span>${r.you ? h`<span class="sr-only">(your team)</span>` : ''}</span>${r.move === 'up' && r.places ? h`<span class="board__move is-up" title="Up ${r.places}">${ic('arrow-up', { size: 14, stroke: 3 })}${r.places}</span>` : r.move === 'down' && r.places ? h`<span class="board__move is-down" title="Down ${r.places}">${ic('arrow-down', { size: 14, stroke: 3 })}${r.places}</span>` : ''}<span class="board__score num">${formatPoints(r.score)}</span></li>`
    )}</ol>
  </section>`;

/* ---------- podium / game over ---------- */
RENDER.podium = (d) => {
  const won = d.place === 1;
  const title = won ? (d.tied ? 'Tied for the win!' : 'You won!') : d.place === 2 ? '2nd place!' : d.place === 3 ? '3rd place!' : `${ordinal(d.place)} place`;
  return h`
  ${won ? h`<div class="confetti" aria-hidden="true">${Array.from({ length: 18 }, () => h`<i></i>`)}</div>` : ''}
  <section class="go__hero${won ? ' is-winner' : ''}" data-tc="${d.team.color}">
    <span class="go__disc">${discH(d.team, 'xl')}${won ? h`<span class="go__crown">${ic('crown', { size: 40 })}</span>` : ''}</span>
    <span class="go__eyebrow">${ordinal(d.place)} place · ${d.team.name}</span>
    <h1 class="go__title">${title}</h1>
    <span class="go__score"><span class="label">Final score</span><span class="num">${formatPoints(d.score)}</span></span>
  </section>
  ${d.awards.map(
    (a) => h`<div class="award" role="img" aria-label="Award won: ${a.title} — ${a.name}, ${a.detail}"><span class="award__icon">${ic(a.key === 'fastestFinger' ? 'zap' : 'award', { size: 28 })}</span><span class="award__text"><span class="award__eyebrow">${a.you ? 'You won an award!' : 'Award won'}</span><span class="award__title">${a.title}</span><span class="award__detail">${a.name} · ${a.detail}</span></span></div>`
  )}
  <ol class="panel go__standings" role="list" aria-label="Final standings">${d.standings.map(
    (r) => h`<li class="go__row${r.you ? ' is-you' : ''} place-${Math.min(r.place, 4)}" data-tc="${r.color}"><span class="go__place num">${r.place}</span>${discH(r, 'xs')}<span class="go__name truncate">${r.name}${r.you ? h` <span class="go__you">You</span>` : ''}</span><span class="num go__pts">${formatPoints(r.score)}</span></li>`
  )}</ol>
  ${d.others.length ? h`<p class="go__others">${ic('award', { size: 18 })}<span>${d.others.map((a) => `${a.title}: ${a.name} (${a.team})`).join(' · ')}</span></p>` : ''}
  <div class="go__end">
    <p class="go__thanks">Thanks for playing — Merry Christmas!</p>
    <p class="status-pill status-pill--soft">${ic('history', { size: 20 })}<span>Stay here — the host can start a new game</span></p>
  </div>`;
};

/* ---------- watching ---------- */
RENDER.watch = (d) => {
  const n = d.now;
  return h`
  ${d.up ? h`<div class="watch__up" data-tc="${d.up.color}">${discH(d.up, 'lg')}<div class="watch__up-text"><span class="label">${d.eyebrow}</span><h1 class="watch__heading">${d.heading}</h1></div></div>` : ''}
  <section class="panel now${n.chip ? ' now--seg' : ''}" ${n.chip ? h`data-sc="${n.chip.color}" data-si="${n.chip.ink}"` : ''} aria-labelledby="now-title">
    <div class="now__top">
      <div class="now__labels"><span class="label">${n.label}</span>${n.chip ? h`<span class="chip-row">${chipH(n.chip)}${n.chip2 ? h`<span class="chip chip--sm chip--outline">${n.chip2}</span>` : ''}</span>` : ''}</div>
      ${n.timer ? timerRingH(72) : ''}
    </div>
    <h2 class="now__title${n.question ? ' now__title--q' : ''}" id="now-title">${n.title}</h2>
    ${n.body ? h`<p class="now__body">${n.body}</p>` : ''}
    ${n.lines.length ? h`<ul class="now__lines" role="list">${n.lines.map((l) => h`<li>${ic(l.icon, { size: 18 })}<span>${l.text}</span></li>`)}</ul>` : ''}
    ${n.vs ? h`<div class="mini-vs"><span class="mini-vs__side" data-tc="${n.vs.a.team ? n.vs.a.team.color : ''}">${discH(n.vs.a.team, 'xs')}<span class="truncate">${n.vs.a.name}</span></span><span class="mini-vs__vs">VS</span><span class="mini-vs__side" data-tc="${n.vs.b.team ? n.vs.b.team.color : ''}">${discH(n.vs.b.team, 'xs')}<span class="truncate">${n.vs.b.name}</span></span></div>` : ''}
    ${n.dots ? h`<ol class="dots-row dots-row--sm" role="list" aria-label="Hot Seat progress">${Array.from({ length: n.dots.total }, (_, i) => {
      const r = n.dots.results[i];
      return h`<li class="${r ? `is-${r}` : i === n.dots.index ? 'is-current' : ''}">${r === 'correct' ? ic('check', { size: 14, stroke: 3 }) : r === 'wrong' ? ic('x', { size: 14, stroke: 3 }) : ''}</li>`;
    })}</ol>` : ''}
    ${n.ticks && n.ticks.length ? h`<div class="chip-row chip-row--wrap">${n.ticks.map((t) => h`<span class="chip chip--sm tick-chip">${ic('check', { size: 14, stroke: 3 })}${t}</span>`)}</div>` : ''}
    ${n.tally ? h`<div class="tally"><span class="tally__item">${ic('thumbs-up', { size: 18 })}${n.tally.nailed} nailed it</span><span class="tally__item">${ic('hand-metal', { size: 18 })}${n.tally.good} good try</span><span class="tally__item muted">${n.tally.voters} / ${n.tally.eligible} voted</span></div>` : ''}
    ${n.result ? h`<div class="now__result ${n.result.good ? 'is-good' : 'is-bad'}">
      <span class="now__result-title">${n.result.title}</span>
      ${n.result.answer ? h`<span class="now__answer">${ic('check', { size: 18, stroke: 3 })}${n.result.answer}</span>` : ''}
      ${n.result.fact ? h`<span class="now__fact">${n.result.fact}</span>` : ''}
      ${n.result.deltas.length ? h`<span class="now__deltas">${n.result.deltas.map((x) => h`<span class="now__delta${x.you ? ' is-you' : ''}" data-tc="${x.team ? x.team.color : ''}">${discH(x.team, 'xs')}<span class="delta ${x.delta > 0 ? 'delta--up' : 'delta--down'}">${formatDelta(x.delta)}</span></span>`)}</span>` : ''}
    </div>` : ''}
  </section>
  <div class="callout callout--${d.callout.tone}" ${d.up && d.callout.tone === 'team' ? h`data-tc="${d.up.color}"` : ''}>
    ${ic(d.callout.icon, { size: 34 })}
    <div><span class="callout__title">${d.callout.title}</span>${d.callout.sub ? h`<span class="callout__sub">${d.callout.sub}</span>` : ''}</div>
  </div>
  ${boardH(d.board, d.note)}`;
};

/* ================================================================== render loop =============== */

function hydrate(root) {
  root.querySelectorAll('[data-tc]').forEach((el) => {
    const c = safeColor(el.dataset.tc, '');
    if (c) el.style.setProperty('--team-color', c);
  });
  root.querySelectorAll('[data-sc]').forEach((el) => {
    const c = safeColor(el.dataset.sc, '');
    if (c) el.style.setProperty('--seg', c);
  });
  root.querySelectorAll('[data-si]').forEach((el) => {
    const c = safeColor(el.dataset.si, '');
    if (c) el.style.setProperty('--seg-ink', c);
  });
  root.querySelectorAll('[data-pct]').forEach((el) => el.style.setProperty('--fill', `${el.dataset.pct}%`));
}

function captureFocus() {
  const a = document.activeElement;
  if (!a || !screenEl.contains(a) || !a.matches('input[data-draft]')) return null;
  return { key: a.dataset.draft, start: a.selectionStart, end: a.selectionEnd };
}
function restoreFocus(k) {
  if (!k) return;
  const el = screenEl.querySelector(`input[data-draft="${CSS.escape(k.key)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  try {
    el.setSelectionRange(k.start, k.end);
  } catch {
    /* not a text input */
  }
}

function render(force = false) {
  if (!S) {
    if (cur.id !== 'connecting') {
      setHTML(screenEl, RENDER.connecting());
      cur = { id: 'connecting', sig: '' };
    }
    return;
  }
  const hd = deriveHeader(S);
  const hs = JSON.stringify(hd);
  if (hs !== headSig) {
    renderHeader(hd);
    headSig = hs;
  }
  const view = derive(S);
  const sig = JSON.stringify(view.data);
  if (!force && view.id === cur.id && sig === cur.sig) return;
  if (!force && view.id === cur.id && PATCH[view.id] && cur.data && PATCH[view.id](screenEl, view.data, cur.data)) {
    Object.assign(cur.data, view.data);
    cur.sig = sig;
    hydrate(screenEl);
    tick();
    return;
  }
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  screenEl._wagerUpdate = null;
  const changedScreen = view.id !== cur.id;
  const keep = changedScreen ? null : captureFocus();
  setHTML(screenEl, RENDER[view.id](view.data));
  document.body.dataset.screen = view.id;
  screenEl.className = `screen screen--${view.id}${changedScreen ? ' is-entering' : ''}`;
  hydrate(screenEl);
  BIND[view.id]?.(screenEl, view.data);
  restoreFocus(keep);
  if (changedScreen) {
    window.scrollTo(0, 0);
    if (screenEl._enterT) clearTimeout(screenEl._enterT);
    screenEl._enterT = setTimeout(() => screenEl.classList.remove('is-entering'), 400);
  }
  cur = { id: view.id, sig, data: view.data };
  tick();
}

/* timers & countdowns, patched in place */
function tick() {
  if (!S) return;
  const now = client.serverNow();
  const t = S.timer;
  const show = !!t && (t.started || t.running);
  qsa('[data-timer-wrap]', screenEl).forEach((w) => {
    w.hidden = !show;
    if (!show) return;
    updateTimerRing(w, t, now, { unit: w.dataset.unit || 'SEC' });
    w.classList.toggle('is-warn', timerWarn(t, now));
    w.classList.toggle('is-paused', !t.running && !t.ended);
    const txt = w.querySelector('[data-timer-text]');
    if (txt) {
      const v = mmss(timerSeconds(t, now));
      if (txt.textContent !== v) txt.textContent = v;
    }
  });
  qsa('[data-timer-show]', screenEl).forEach((el) => {
    el.hidden = (el.dataset.timerShow === 'started') !== show;
  });
  qsa('[data-countdown]', screenEl).forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.countdown) - now) / 1000));
    const v = left ? String(left) : '!';
    if (el.textContent !== v) el.textContent = v;
  });
}
setInterval(tick, 250);

/* ================================================================== actions =================== */

async function act(key, event, payload = {}, { quiet = [] } = {}) {
  if (ui.pending) return null;
  ui.pending = key;
  render();
  const res = await client.emit(event, payload);
  ui.pending = null;
  if (!res.ok && !quiet.includes(res.error)) toast(errorText(res.error), { tone: res.error === 'offline' ? 'warn' : 'error' });
  render();
  return res;
}

function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), 450);
}

function announce(text) {
  if (!announcer) return;
  announcer.textContent = '';
  setTimeout(() => {
    announcer.textContent = text;
  }, 30);
}

/* drafts: every input with data-draft keeps its text across re-renders */
screenEl.addEventListener('input', (e) => {
  const el = e.target;
  if (el && el.dataset && el.dataset.draft) ui.drafts[el.dataset.draft] = el.value;
});

/* pointerdown press feedback for every tappable control (SPIN/BUZZ use onPress) */
document.addEventListener(
  'pointerdown',
  (e) => {
    const b = e.target.closest?.('.btn, .tile, .diff, .vote-btn, .target, .qchip');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
    b.classList.add('is-pressed');
    const up = () => {
      b.classList.remove('is-pressed');
      b.removeEventListener('pointerup', up);
      b.removeEventListener('pointercancel', up);
      b.removeEventListener('pointerleave', up);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('pointerleave', up);
  },
  { passive: true }
);

/* ================================================================== state & fx ================ */

client.onState((state) => {
  const prevMe = lastMe;
  const me = state.me || null;
  // the host kicked this phone (it was joined, now it is not)
  if (prevMe && !me) {
    ui.kicked = true;
    ui.switching = false;
    vibrate([60, 40, 60]);
  }
  // our team was removed (lobby) or the host moved us out of a team
  if (prevMe && prevMe.teamId && me && !me.teamId) {
    const gone = !(state.teams || []).some((t) => t.id === prevMe.teamId);
    ui.removedTeam = gone ? lastTeamName || 'Your team' : '';
    ui.pickTeam = null;
    vibrate([60, 40, 60]);
  }
  if (me && me.teamId) {
    ui.removedTeam = null;
    lastTeamName = teamOf(state, me.teamId)?.name || lastTeamName;
  }
  if (me && !ui.drafts.name) ui.drafts.name = me.name;
  if (state.phase !== 'lobby') ui.switching = false;
  if (!state.challenge || state.challenge.type !== 'dare' || state.challenge.stage !== 'vote') ui.voteEdit = false;
  lastMe = me;
  S = state;
  // keep the screen awake while joined
  if (me && !wl) wl = wakeLock();
  else if (!me && wl) {
    wl.release();
    wl = null;
  }
  render();
});

client.onFx((type, p) => {
  if (!S || !S.me) return;
  const my = S.me.teamId;
  if (type === 'turn' && p.teamId && p.teamId === my) {
    vibrate([90, 60, 90]);
    announce('Your team is up! Spin the wheel.');
  } else if (type === 'buzz' && p.playerId === S.me.playerId) {
    vibrate(220);
    announce('You buzzed first! Answer out loud.');
  } else if (type === 'calledUp' && Array.isArray(p.playerIds) && p.playerIds.includes(S.me.playerId)) {
    vibrate([140, 80, 140, 80, 260]);
    announce(p.kind === 'showdown' ? 'You are in the Showdown! Get to the front.' : 'You are the performer!');
  } else if (type === 'armed' && Array.isArray(p.eligibleTeamIds) && p.eligibleTeamIds.includes(my)) {
    vibrate(40);
    announce('Buzzers are armed!');
  } else if (type === 'points' && p.teamId === my && p.delta && p.reason !== 'Undo') {
    announce(`${formatDelta(p.delta)} points for your team`);
  }
});

client.onConnection((on) => {
  document.body.classList.toggle('is-offline', !on);
});

/* theme-color and the favicon follow the tokens (no colour literals in the markup) */
try {
  const css = getComputedStyle(document.documentElement);
  const night = css.getPropertyValue('--night').trim();
  const gold = safeColor(css.getPropertyValue('--tinsel').trim(), '');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && night) meta.setAttribute('content', night);
  if (gold) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${gold}" stroke-width="2.4" stroke-linecap="round"><path d="M2 12h20M12 2v20m8-6-4-4 4-4M4 8l4 4-4 4m12-12-4 4-4-4M8 20l4-4 4 4"/></svg>`;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
} catch {
  /* ignore */
}

render();
