// Christmas Chaos — player.js  ·  "North Pole Workshop" phone controller (served at "/")
// One job per screen, rendered ONLY from the server's playerView (me, can, challenge, secret, myTeam, myVote …).
// Local state is limited to drafts and UI conveniences (typed text, the team tag you tapped, the target you are
// hovering, the wager slider, which funny line is showing).
//
// Rendering model: derive(state) -> { id, data } (plain JSON). The screen is rebuilt only when the id or the JSON
// signature of `data` changes, so typing, holding the secret present or dragging the wager slider is never
// interrupted by unrelated state pushes. Timers and countdowns are patched in place 4× a second.
// Colours that come from game data (team colours) are applied as CSS custom properties (--team-color) by hydrate().
//
// Comedy layer (docs/design/COMEDY.md): rotating funny lines on idle screens, the server's quip in small type, and
// small phone-sized gags from fx.js — confetti + a happy buzz when your team scores, a droop + lump of coal when it
// misses, and your mascot reacting to the server's {type:'react'} cues for your team. Everything is fire-and-forget.

import {
  connect, h, raw, ic, art, mascot, setHTML, toast, onPress, secretCard, bindSecretCard, timerRing, updateTimerRing,
  timerSeconds, timerWarn, formatPoints, formatDelta, plural, ordinal, listJoin, possessive, vibrate, wakeLock,
  animateNumber, qsa, peppermint, ornamentBuzz, present, stocking, slotChip, reducedMotion,
} from './client.js';
import { safeColor, hasArt } from './icons.js';
import { garland, snowfall, snowbank, starfield } from './sky.js';
import * as fx from './fx.js';

/* ================================================================== setup ===================== */

const appEl = document.getElementById('app');
const screenEl = document.getElementById('screen');
const topbarEl = document.getElementById('topbar');
const garlandEl = document.getElementById('garland');
const announcer = document.getElementById('announcer');

const client = connect('player', { banner: 'Reconnecting to the North Pole… hold tight' });

const LS_NAME = 'cc.playerName';
const NAME_MAX = 20;
const ANSWER_MAX = 80;
const EVE_PHASES = new Set(['finalIntro', 'finalWager', 'finalAnswer', 'finalReveal']);

const HAPPY = [30, 50, 30, 50, 90];
const SAD = [180];

const ui = {
  drafts: {},          // input text by data-draft key
  pickTeam: null,      // team tag tapped on the join screen
  switching: false,    // lobby: "Switch team" open
  kicked: false,       // the host removed this phone
  removedTeam: null,   // name of the team that was removed / we were moved out of
  pending: null,       // action in flight ('join', 'spin', 'buzz', …)
  voteEdit: false,     // "Change vote" pressed
  target: null,        // {cid, teamId} picker selection
  wager: null,         // {key, amount}
  peeked: new Set(),   // secrets we already reported as peeked
  pendingLevel: null,  // difficulty tapped while the pick is in flight
  rot: {},             // funny-line index per list
  seen: new Set(),     // result screens we already celebrated / commiserated
};

let S = null;          // latest playerView
let lastMe;            // previous `me` (undefined = no state yet)
let lastTeamName = null;
let cur = { id: null, sig: null, data: null };
let cleanup = null;    // unbind hook of the current screen (secret present listeners)
let headSig = null;
let headScore = null;  // {teamId, score} shown in the header (for the count-up)
let wl = null;         // wake lock handle while joined
let lightsMode = '';
let stars = null;      // Christmas Eve starfield
let lastCheer = 0;     // confetti cooldown (correct + points arrive together)
let lastGroan = 0;     // coal cooldown

try {
  ui.drafts.name = localStorage.getItem(LS_NAME) || '';
} catch {
  ui.drafts.name = '';
}

// The North Pole frame: garland across the top, snow hills at the bottom, a few flakes in the side gutters only
// (never over text being read). Reduced motion: snowfall renders nothing, the bulbs stay lit.
const lights = garland(garlandEl, { size: 'phone', className: 'app__lights' });
appEl.insertAdjacentHTML('beforeend', snowbank({ className: 'app__snowbank' }));
snowfall(appEl, { count: 14, seed: 2512, lanes: [[0, 4.5], [95.5, 100]], flakeEvery: 4 });

// Debug / test handle (read-only use): window.ccPlayer.client, .state
globalThis.ccPlayer = { client, ui, get state() { return S; }, get screen() { return cur.id; } };

/* ================================================================== words ===================== */

/** Rotating funny lines (warm, cheeky, never about the person — COMEDY.md). */
const LINES = {
  join: [
    'The elves need a name for your stocking.',
    'Name tag first. Cookies later.',
    'Pick a team. Choose wisely. Or randomly — both work.',
    'Santa is making a list. You should be on it.',
  ],
  late: [
    'Sneaking in late? The reindeer saw nothing.',
    'Pull up a chair. The cookies are still warm.',
    'Fashionably late. Very North Pole of you.',
  ],
  wait: [
    'Elves are still finding their phones…',
    'Stretch your buzzer finger. Trust us.',
    'Practise your best “I knew that!” face.',
    'The reindeer are watching. Act natural.',
    'Shouting the answer louder does not make it right.',
    'Santa is checking the list. Twice.',
    'Somebody warm up the Hot Seat.',
    'Grab a cookie. Strategy needs sugar.',
  ],
  spin: [
    'No pressure. Just the whole family watching.',
    'Spin it like you mean it.',
    'Lucky elbow recommended.',
    'Blow on it for luck. Gently.',
    'The wheel can smell fear.',
  ],
  double: [
    'Twice the points. Twice the bragging rights.',
    'Double or nothing. Mostly double.',
    'The elves just doubled the stakes.',
  ],
  spinning: [
    'Round and round it goes…',
    'Act like you planned this.',
    'Please don’t land on a dare. Please land on a dare.',
  ],
  watch: [
    'Popcorn ready? Good.',
    'Heckling is allowed. Lovingly.',
    'Stay sharp — steals come out of nowhere.',
  ],
};

const DIFF = {
  easy: { label: 'Easy', pts: 100, color: '#1F7A4A', ribbon: '#EDB321', joke: 'Nice and cosy. The reindeer may judge.' },
  medium: { label: 'Medium', pts: 200, color: '#2E6FD1', ribbon: '#FFFFFF', joke: 'Just the right amount of spicy.' },
  hard: { label: 'Hard', pts: 300, color: '#D42A2A', ribbon: '#EDB321', joke: 'For show-offs and know-it-alls.' },
};
const MEDIUM_JOKE = {
  christmas: 'You know your carols. Right?',
  movies: 'You’ve seen Elf at least twice. Right?',
  popculture: 'You know what the kids are into. Right?',
};
const FINAL_ART = { christmas: 'tree', movies: 'popcorn', popculture: 'clapper', mixed: 'sparkles' };
const AWARD_ART = { fastestFinger: 'zap', starPerformer: 'masks', lumpOfCoal: 'snowman', grinchOfTheYear: 'money', silentNight: 'moon', comebackKid: 'sled', rudolph: 'deer' };

const ERRORS = {
  offline: 'You’re offline — reconnecting…',
  timeout: 'No answer from the North Pole — try again',
  'name-required': 'Type your name first',
  'no-such-team': 'That team is gone — pick another one',
  'ask-host': 'Ask the host to move you to another team',
  'game-full': 'The workshop is full — ask the host',
  'not-your-turn': 'It’s not your team’s turn',
  'not-now': 'Too late — that moment has passed',
  arming: 'Not yet — wait for the ornament to light up!',
  'locked-out': 'Your team already had its try',
  'not-eligible': 'Your team can’t buzz on this one',
  'bad-target': 'You can’t pick that team',
  'empty-answer': 'Type an answer first',
  'bad-amount': 'That wager is out of range',
  'bad-level': 'Pick Easy, Medium or Hard',
  'bad-choice': 'Pick Nailed it or Good try',
  'slow-down': 'Whoa there, Rudolph — slow down a little!',
  'not-joined': 'Join the game first',
  'no-team': 'Pick a team first',
  'hello-first': 'Still connecting — try again',
  'no-secret': 'Your secret is gone',
  'server-error': 'Something went wrong — try again',
};
const errorText = (code) => ERRORS[code] || 'That didn’t work — try again';

/* ================================================================== data helpers ============== */

const teamLite = (t) => (t ? { id: t.id, name: t.name, color: t.color, mascot: t.mascot, score: t.score, rank: t.rank } : null);
const teamOf = (s, id) => (s.teams || []).find((t) => t.id === id) || null;
const segOf = (s, c = s.challenge) => (c && c.segmentIndex != null ? (s.segments || [])[c.segmentIndex] || null : null);
const segLite = (g) => (g ? { label: g.label, color: g.color, ink: g.ink, art: g.art, icon: g.icon, type: g.type, category: g.category, pattern: g.pattern } : null);
const chip = (g, text) => (g ? { seg: segLite(g), text: text ?? g.label } : null);
const playersOf = (s, teamId) => (s.players || []).filter((p) => p.teamId === teamId);
const isMe = (s, p) => !!p && !!s.me && p.playerId === s.me.playerId;
const mmss = (sec) => {
  const v = Math.max(0, Math.trunc(sec) || 0);
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};
const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const verbS = (name) => (/s$/i.test(String(name || '')) ? '' : 's');   // "The Grinches get" / "Team Rudolph gets"
/** The server's current quip as {text, mine} (mine = it is about your team), optionally only for some moment keys. */
const quipOf = (s, keys) => {
  const q = s.quip;
  if (!q || !q.text) return null;
  if (keys && q.key && !keys.some((k) => q.key === k || q.key.startsWith(`${k}.`))) return null;
  const myTeam = s.me && s.me.teamId;
  return { text: String(q.text), mine: !!(q.teamId && myTeam && q.teamId === myTeam) };
};
function line(key) {
  const list = LINES[key] || [];
  if (!list.length) return '';
  if (ui.rot[key] == null) ui.rot[key] = Math.floor(Math.random() * list.length);
  return list[ui.rot[key] % list.length];
}

function board(s, myId) {
  const teams = s.teams || [];
  const top = Math.max(0, ...teams.map((t) => t.score));
  return teams
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.score - a.t.score || a.i - b.i)
    .map(({ t }) => ({ ...teamLite(t), you: t.id === myId, up: t.id === s.activeTeamId, lead: teams.length > 1 && top > 0 && t.score === top }));
}
function standingNote(s, my) {
  const others = (s.teams || []).filter((t) => t.id !== my.id);
  if (!others.length) return null;
  const tied = others.some((t) => t.score === my.score);
  if (my.rank === 1) {
    if (tied) return 'Tied for 1st';
    return `1st · ${formatPoints(my.score - Math.max(...others.map((t) => t.score)))} ahead`;
  }
  const above = Math.min(...others.filter((t) => t.score > my.score).map((t) => t.score));
  return `${tied ? 'Tied ' : ''}${ordinal(my.rank)} · ${formatPoints(above - my.score)} behind`;
}
const roundText = (s) => `Round ${s.round} of ${s.totalRounds}`;
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
      elves: (s.players || []).filter((p) => p.connected && p.teamId).length,
    },
  };
}

/* ---------- waiting lobby ---------- */
function deriveLobby(s, my) {
  const mates = playersOf(s, my.id).map((p) => ({ name: p.name, you: p.id === s.me.playerId, online: p.connected }));
  mates.sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0));
  return {
    id: 'lobby',
    data: {
      team: teamLite(my),
      mates,
      teamCount: (s.teams || []).length,
      elves: (s.players || []).filter((p) => p.teamId && p.connected).length,
      quip: quipOf(s, ['lobbyIdle', 'gameStart']),
    },
  };
}

/* ---------- your turn: SPIN ---------- */
function deriveSpin(s, my, mode) {
  const spinBy = s.spin && s.spin.by ? s.spin.by.name : null;
  return {
    id: 'spin',
    data: {
      mode, // 'spin' | 'double' | 'spinning'
      round: roundText(s),
      team: teamLite(my),
      can: !!s.can.spin,
      by: spinBy,
      byMe: !!(s.spin && s.spin.by && s.me && s.spin.by.playerId === s.me.playerId),
      pending: ui.pending === 'spin',
      board: board(s, my.id),
      quip: mode === 'spinning' ? quipOf(s, ['spinStart']) : quipOf(s, ['turnIntro', 'doubleDown', 'land.doubledown']),
    },
  };
}

/* ---------- trivia: pick difficulty ---------- */
function deriveDifficulty(s, my) {
  const c = s.challenge;
  const mult = my.multiplier > 1 ? my.multiplier : 1;
  return {
    id: 'difficulty',
    data: {
      chip: chip(segOf(s), c.categoryLabel),
      mult,
      levels: Object.entries(DIFF).map(([level, d]) => ({
        level,
        label: d.label,
        pts: d.pts * mult,
        steal: d.pts / 2,
        color: d.color,
        ribbon: d.ribbon,
        joke: level === 'medium' ? MEDIUM_JOKE[c.category] || d.joke : d.joke,
      })),
      mates: teammates(s, my).map((p) => p.name),
      pending: ui.pending === 'pick' ? ui.pendingLevel : null,
      quip: quipOf(s, ['land']),
    },
  };
}

/* ---------- steal buzzer ---------- */
function deriveBuzzer(s, my) {
  const c = s.challenge;
  const b = c.buzz || { open: false, eligibleTeamIds: [], lockedTeamIds: [], winner: null };
  const act = teamOf(s, s.activeTeamId);
  const eligible = (b.eligibleTeamIds || []).includes(my.id);
  let mode;
  if (b.winner && isMe(s, b.winner)) mode = 'won';
  else if (b.winner && b.winner.teamId === my.id) mode = 'team';
  else if ((b.lockedTeamIds || []).includes(my.id)) mode = 'locked';
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
      chip: chip(segOf(s), c.type === 'trivia' ? c.categoryLabel : undefined),
      difficulty: c.difficulty ? DIFF[c.difficulty]?.label || cap(c.difficulty) : null,
      points: c.stealPoints,
      missed: act ? act.name : 'They',
      winner: b.winner ? { name: b.winner.name, team: teamLite(winTeam) } : null,
      armingUntil: b.armingUntil || null,
      pending: ui.pending === 'buzz',
    },
  };
}

/* ---------- performer: secret present ---------- */
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
  const isSong = kind === 'sound';
  return {
    id: 'secret',
    data: {
      kind,
      cid: c.id,
      chip: chip(segOf(s), isSong ? `Sound It Out · ${c.points}` : `Dare · ${c.points}`),
      name: s.me.name,
      team: my.name,
      dare: !isSong && c.dare ? c.dare.title : null,
      label: isSong ? 'Your song' : secretLabel(sec.label),
      value: sec.value,
      rule: isSong ? `No words — hum it!${sec.detail ? ` (${sec.detail})` : ''}` : sec.label,
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
      chip: chip(segOf(s), d ? `Dare · ${c.points}` : undefined),
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
      chip: chip(segOf(s), 'Room vote'),
      performer,
      team: act ? act.name : '',
      dare: c.dare ? c.dare.title : '',
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
      leader: t.rank === 1 && t.score > 0,
      eyedBy: c.eyeing && c.eyeing.teamId === t.id && c.eyeing.by && s.me && c.eyeing.by.playerId !== s.me.playerId ? c.eyeing.by.name : null,
    }));
  const sel = ui.target && ui.target.cid === c.id && targets.some((t) => t.id === ui.target.teamId) ? ui.target.teamId : null;
  const safe = kind === 'grinch' ? (s.teams || []).filter((t) => t.id !== my.id && !(c.targets || []).includes(t.id)).map(teamLite) : [];
  return {
    id: 'picker',
    data: { kind, cid: c.id, points: c.points, targets, safe, selected: sel, can: !!s.can.pickTarget, pending: ui.pending === 'target', team: my.name },
  };
}

/* ---------- Showdown: you're called up ---------- */
function deriveCalledUp(s, my) {
  const c = s.challenge;
  const side = isMe(s, c.performer) ? 'active' : 'rival';
  const opp = side === 'active'
    ? c.rival ? { name: c.rival.name || 'Their player', team: teamLite(teamOf(s, c.rival.teamId)) } : null
    : c.performer ? { name: c.performer.name, team: teamLite(teamOf(s, c.performer.teamId)) } : null;
  const sd = c.showdown || {};
  return {
    id: 'calledup',
    data: {
      chip: chip(segOf(s), `Showdown · ${formatPoints(c.points)} to win`),
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
      chip: chip(segOf(s), `Hot Seat · ${hs.each || 50} each`),
      name: s.me.name,
      team: my.name,
      started: !!c.started,
      question: hs.question,
      index: hs.index,
      total: hs.total,
      results: hs.results,
      banked: hs.banked || 0,
      each: hs.each,
      color: my.color,
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
    team: my.name,
  };
  if (kind === 'allplay') {
    data.chip = chip(segOf(s), 'All Play');
    data.points = c.points;
    data.first = c.firstBonus || 50;
  } else if (kind === 'bonus') {
    data.points = c.points;
    data.round = s.roundBreak ? s.roundBreak.round : s.round;
  } else {
    data.category = F.categoryLabel || 'Mystery';
    data.catArt = FINAL_ART[F.category] || 'sparkles';
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

/* ---------- Final Chaos (Christmas Eve) ---------- */
function deriveFinalIntro(s, my) {
  const F = s.final || {};
  const max = s.myTeam && s.myTeam.maxWager != null ? s.myTeam.maxWager : Math.max(my.score, 300);
  return { id: 'finalintro', data: { category: F.categoryLabel || 'Mystery', catArt: FINAL_ART[F.category] || 'sparkles', score: my.score, max, behind: my.score < 300, quip: quipOf(s, ['finalIntro']) } };
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
      catArt: FINAL_ART[F.category] || 'sparkles',
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
      key: `final:${s.gameNo}`,
      question: F.question || '',
      answer: F.answer || null,
      rows,
      mine,
      myText: sub ? sub.text : null,
      myWager: w ? w.amount : 0,
      pos: mine ? rows.indexOf(mine) + 1 : null,
      count: rows.length,
      quip: quipOf(s, ['finalCorrect', 'finalWrong', 'finalAllIn', 'finalZeroBet']),
    },
  };
}

/* ---------- round break ---------- */
function deriveRoundBreak(s, my) {
  const rb = s.roundBreak || { round: s.round, nextRound: s.round + 1, finalNext: false, standings: [] };
  const standings = (rb.standings || []).map((r) => ({ ...teamLite(teamOf(s, r.teamId)), rank: r.rank, move: r.move, places: r.places, you: r.teamId === my.id, score: r.score }));
  const me = standings.find((r) => r.you);
  const last = standings.length > 1 && me && me.rank === Math.max(...standings.map((r) => r.rank));
  return {
    id: 'roundbreak',
    data: {
      round: rb.round,
      next: rb.nextRound,
      total: s.totalRounds,
      finalNext: !!rb.finalNext,
      standings,
      me: me || null,
      note: standingNote(s, my),
      bonus: !!rb.bonusPlanned && !rb.bonusDone,
      roast: me ? (me.rank === 1 && standings.length > 1 ? 'Don’t get comfy — the Grinch is watching.' : last ? 'Plenty of time for a Christmas miracle.' : 'Right in the cosy middle. Like the jam in a jammy dodger.') : '',
      quip: quipOf(s, ['roundBreak', 'leadChange', 'bigComeback', 'lastPlaceCheer']),
    },
  };
}

/* ---------- podium / game over ---------- */
function derivePodium(s, my) {
  const P = s.podium || { standings: [], awards: [] };
  const mine = (P.standings || []).find((r) => r.teamId === my.id);
  const place = mine ? mine.place : my.rank;
  const meName = s.me ? s.me.name : '';
  const namesOf = (a) => String(a.name || '').split(/,\s*|\s+and\s+|\s*&\s*/).map((x) => x.trim()).filter(Boolean);
  const isMine = (a) => a.teamId === my.id || (s.me && a.playerId === s.me.playerId) || (!a.teamId && (namesOf(a).includes(meName) || namesOf(a).includes(my.name)));
  const awards = Array.isArray(P.awards) ? P.awards.filter((a) => a && a.title) : [];
  const awardArt = (a) => (a.art && hasArt(a.art) ? a.art : AWARD_ART[a.key] || 'trophy');
  return {
    id: 'podium',
    data: {
      place,
      score: mine ? mine.score : my.score,
      team: teamLite(my),
      tied: (P.standings || []).filter((r) => r.place === place).length > 1,
      awards: awards.filter(isMine).map((a) => ({ key: a.key || '', title: a.title, name: a.name || '', detail: a.detail || '', art: awardArt(a), you: !!(s.me && a.playerId === s.me.playerId) || (!a.playerId && namesOf(a).includes(meName)) })),
      others: awards.filter((a) => !isMine(a)).map((a) => ({ title: a.title, name: a.name || '', art: awardArt(a), team: a.teamId ? teamOf(s, a.teamId)?.name || '' : '' })),
      standings: (P.standings || []).map((r) => ({ ...teamLite(teamOf(s, r.teamId)), place: r.place, score: r.score, you: r.teamId === my.id })),
      quip: quipOf(s, ['podium']),
    },
  };
}

/* ---------- watching (what's happening now + mini score tags + the quip) ---------- */
function deriveWatch(s, my) {
  const act = teamOf(s, s.activeTeamId);
  const mine = !!act && act.id === my.id;
  const now = happening(s, my, act, mine);
  return {
    id: 'watch',
    data: {
      up: act ? { ...teamLite(act), mine } : null,
      round: s.round ? roundText(s) : '',
      now,
      callout: callout(s, my, act, mine, now),
      board: board(s, my.id),
      quip: quipOf(s),
    },
  };
}

const RESULT_TITLE = {
  correct: 'Correct!', stolen: 'Stolen!', missed: 'Nobody got it', nailed: 'Nailed it!', valiant: 'Valiant effort!', fail: 'Not this time',
  win: 'Showdown won!', tie: 'It’s a tie!', list: 'Time’s up!', hotseat: 'Hot Seat over', allplay: 'Answers revealed', bonus: 'Answers revealed',
  steal: 'Points swiped!', gift: 'Gift delivered!', skipped: 'Skipped',
};
const GOOD_RESULTS = ['correct', 'stolen', 'nailed', 'win', 'tie', 'list', 'hotseat', 'valiant', 'gift', 'steal', 'allplay', 'bonus'];

function happening(s, my, act, mine) {
  const c = s.challenge;
  const seg = segOf(s);
  const out = { chip: null, chip2: null, title: '', question: false, body: '', lines: [], vs: null, dots: null, ticks: null, tally: null, result: null, timer: false, spinning: false };
  const actName = act ? act.name : 'The team';
  if (s.phase === 'turnIntro') {
    out.title = 'Spin coming up!';
    out.body = `Somebody on ${actName} taps the peppermint. Watch the wheel on the TV!`;
    return out;
  }
  if (s.phase === 'spinning') {
    out.title = 'Eyes on the big screen!';
    out.body = s.spin && s.spin.by ? `${s.spin.by.name} spun for ${actName}. Where will it land?` : `${actName} spun the wheel. Where will it land?`;
    out.spinning = true;
    return out;
  }
  if (!c) {
    out.title = 'Watch the TV';
    return out;
  }
  out.timer = true;
  const pts = c.points;
  switch (c.type) {
    case 'trivia': {
      out.chip = chip(seg, c.categoryLabel);
      if (c.difficulty) out.chip2 = `${DIFF[c.difficulty]?.label || cap(c.difficulty)} · ${pts}`;
      if (c.stage === 'pickDifficulty') {
        out.title = mine ? 'Your team is picking a present' : 'Picking a present…';
        out.body = 'Easy 100, Medium 200 or Hard 300. Bigger present, bigger points.';
        out.timer = false;
      } else {
        out.title = c.question || '';
        out.question = true;
        if (c.movie) out.lines.push({ icon: 'film', text: `From ${c.movie}${c.movieYear ? ` (${c.movieYear})` : ''}` });
        if (c.hint) out.lines.push({ icon: 'lightbulb', text: `Hint: ${c.hint}` });
        if (c.stage === 'question') out.body = mine ? 'Answer out loud — the host is listening.' : `If ${actName} miss${verbS(actName) ? 'es' : ''} it, you can steal it for ${c.stealPoints}.`;
        if (c.stage === 'steal') out.body = c.buzz && c.buzz.winner ? `${c.buzz.winner.name} buzzed first to steal it for ${c.stealPoints}.` : `Steal! The other teams can buzz in for ${c.stealPoints}.`;
      }
      break;
    }
    case 'sounditout': {
      out.chip = chip(seg, `Sound It Out · ${pts}`);
      const who = c.performer ? c.performer.name : 'Someone';
      if (c.stage === 'perform') {
        out.title = `${who} is humming a song`;
        out.body = mine ? 'Shout out the title! No words from the hummer.' : `${actName} ha${verbS(actName) ? 's' : 've'} 30 seconds to name it. Miss it and you can steal it for ${c.stealPoints}.`;
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
      out.chip = chip(seg, `Dare · ${pts}`);
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
      out.chip = chip(seg, `Showdown · ${pts} to win`);
      if (c.stage === 'pickRival') {
        out.title = mine ? 'Your team is picking a rival' : 'Picking a rival…';
        out.body = 'One player from each team goes head to head.';
        if (c.eyeing && c.eyeing.by) {
          const eyed = teamOf(s, c.eyeing.teamId);
          out.lines.push({ icon: 'crosshair', text: `${c.eyeing.by.name} is eyeing ${eyed && eyed.id === my.id ? 'your team' : eyed ? eyed.name : 'a team'}…` });
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
      out.chip = chip(seg, `Rapid List · ${L.each} each`);
      out.title = L.prompt;
      out.question = true;
      out.body = `${L.count} of ${L.max} so far · ${formatPoints(Math.min(L.count, L.max) * L.each)} points`;
      out.ticks = L.ticked.slice(-12);
      break;
    }
    case 'hotseat': {
      const hs = c.hotseat || { index: 0, total: 6, results: [], question: null, banked: 0, each: 50 };
      out.chip = chip(seg, `Hot Seat · ${hs.each} each`);
      out.title = `${c.performer ? c.performer.name : 'Someone'} is in the Hot Seat`;
      out.body = hs.question ? `Q${Math.min(hs.index + 1, hs.total)}: ${hs.question}` : c.stage === 'done' ? `Banked ${formatPoints(hs.banked)} points.` : 'Up to 6 quick questions in 45 seconds. No helping!';
      out.dots = { results: hs.results, total: hs.total, index: hs.index, color: act ? act.color : null };
      break;
    }
    case 'grinch': {
      out.chip = chip(seg, `Grinch Steal · ${pts}`);
      out.timer = false;
      if (c.stage === 'pickTarget') {
        out.title = 'Grinch Steal!';
        out.body = `${mine ? 'Your team is' : `${actName} ${/s$/i.test(actName) ? 'are' : 'is'}`} choosing a team to rob…`;
        if (c.eyeing && c.eyeing.by) {
          const eyed = teamOf(s, c.eyeing.teamId);
          out.lines.push({ icon: 'crosshair', text: `${c.eyeing.by.name} is eyeing ${eyed && eyed.id === my.id ? 'your team!' : eyed ? eyed.name : 'a team'}` });
        }
      } else if (c.steal) {
        const from = teamOf(s, c.steal.from);
        const to = teamOf(s, c.steal.to);
        out.title = `${to ? (to.id === my.id ? 'Your team' : to.name) : 'They'} swiped ${formatPoints(c.steal.amount)}!`;
        out.body = `Taken from ${from ? (from.id === my.id ? 'your team. Rude.' : `${from.name}.`) : 'a team.'}`;
      } else if (c.gift) {
        const to = teamOf(s, c.gift.toTeamId);
        out.title = 'The Grinch’s heart grew three sizes!';
        out.body = `${actName} ${/s$/i.test(actName) ? 'are' : 'is'} in the lead, so ${formatPoints(c.gift.amount)} goes to ${to ? (to.id === my.id ? 'your team' : to.name) : 'last place'} instead.`;
      }
      break;
    }
    case 'doubledown':
      out.chip = chip(seg, 'Double Down · ×2');
      out.title = 'Double Down!';
      out.body = `${mine ? 'Your team spins' : `${actName} spin${verbS(actName)}`} again — everything ${mine ? 'you win' : 'they win'} this turn is doubled.`;
      out.timer = false;
      break;
    case 'allplay':
    case 'bonus':
      out.chip = chip(seg, 'All Play');
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
      good: resultIsGood(s, c, my),
      answer: c.type === 'trivia' || c.type === 'sounditout' ? c.answer || '' : '',
      fact: c.type === 'trivia' ? c.funFact || '' : '',
      deltas: (c.result.awards || []).filter((a) => a.delta).map((a) => ({ team: teamLite(teamOf(s, a.teamId)), delta: a.delta, you: a.teamId === my.id })),
    };
    out.timer = false;
  }
  return out;
}

/** A result is "good" from THIS phone's point of view: your team losing a showdown or being robbed is not a party. */
function resultIsGood(s, c, my) {
  if (!GOOD_RESULTS.includes(c.result.kind)) return false;
  const awards = c.result.awards || [];
  const mine = awards.filter((a) => a.teamId === my.id).reduce((n, a) => n + (a.delta || 0), 0);
  if (mine < 0) return false;
  const involved = my.id === s.activeTeamId || (c.rival && c.rival.teamId === my.id) || (c.steal && c.steal.from === my.id);
  const othersGained = awards.some((a) => a.teamId !== my.id && a.delta > 0);
  return !(involved && mine <= 0 && othersGained);
}

function callout(s, my, act, mine, now) {
  const c = s.challenge;
  if (now.result) {
    const d = now.result.deltas.find((x) => x.you);
    if (d && d.delta > 0) return { tone: 'good', art: 'party', title: `${formatDelta(d.delta)} for your team!`, sub: nextUp(s, my) };
    if (d && d.delta < 0) return { tone: 'warn', art: 'money', title: `${formatDelta(d.delta)} — ouch!`, sub: nextUp(s, my) };
    return { tone: 'tv', art: 'popcorn', title: 'Watch the TV!', sub: nextUp(s, my) };
  }
  if (now.spinning) return { tone: 'tv', art: 'popcorn', title: line('spinning'), sub: mine ? 'Your team spun it!' : 'Fingers crossed for a steal.' };
  if (mine && c) {
    const perf = c.performer ? c.performer.name : null;
    switch (c.type) {
      case 'trivia':
        if (c.stage === 'question') return { tone: 'team', art: 'bell', title: 'Answer out loud!', sub: 'Agree on one answer — the host is listening.' };
        if (c.stage === 'steal') return { tone: 'warn', art: 'bell', title: 'The other teams can steal', sub: 'Fingers crossed nobody knows it…' };
        if (c.stage === 'pickDifficulty') return { tone: 'team', art: 'gift', title: 'A teammate is picking', sub: 'Small, medium or big present?' };
        break;
      case 'sounditout':
        if (c.stage === 'perform') return { tone: 'team', art: 'music', title: 'Guess the song!', sub: `${perf || 'Your performer'} is humming — shout out titles.` };
        if (c.stage === 'steal') return { tone: 'warn', art: 'bell', title: 'The other teams can steal', sub: 'Fingers crossed…' };
        break;
      case 'dare':
        if (c.stage === 'vote') return { tone: 'team', art: 'star', title: 'The room is voting', sub: 'Nailed it or good try? The other teams decide.' };
        if (c.dare && (c.dare.who === 'team' || c.dare.who === 'everyone')) return { tone: 'team', art: 'masks', title: 'Everyone on your team plays!', sub: 'Watch the TV for the rules.' };
        return { tone: 'team', art: 'party', title: `Cheer on ${perf || 'your performer'}!`, sub: c.dare && c.dare.hasSecret ? 'Guess what they are acting out.' : 'Loud cheering is worth at least 3 bonus points. (Emotionally.)' };
      case 'showdown':
        if (c.stage === 'battle') return { tone: 'team', art: 'boxing', title: `Cheer for ${perf || 'your player'}!`, sub: `Winner takes ${c.points}.` };
        break;
      case 'rapidlist':
        return { tone: 'team', art: 'list', title: 'Shout your answers!', sub: '50 points each, up to 6. The host ticks them off.' };
      case 'hotseat':
        return { tone: 'team', art: 'mitten', title: 'Mittens over mouths!', sub: `${perf || 'Your player'} is on their own. No helping!` };
      case 'grinch':
        if (c.stage === 'pickTarget') return { tone: 'team', art: 'money', title: 'A teammate is picking', sub: 'Choose wisely… mwahaha.' };
        break;
      default:
        break;
    }
    return { tone: 'team', art: 'star', title: 'It’s your team’s turn', sub: 'Watch the TV for what happens next.' };
  }
  if (c && c.type === 'grinch' && c.stage === 'pickTarget' && (c.targets || []).includes(my.id)) {
    return { tone: 'warn', art: 'money', title: 'Hide your points!', sub: `${act ? act.name : 'They'} could swipe up to ${formatPoints(Math.min(c.points, my.score))} from you.` };
  }
  if (c && c.type === 'showdown' && c.stage === 'pickRival') {
    return { tone: 'warn', art: 'boxing', title: 'Will they pick you?', sub: 'If they do, one of you gets called up.' };
  }
  if (c && c.type === 'hotseat' && c.performer) return { tone: 'tv', art: 'mitten', title: 'Shh — no helping!', sub: nextUp(s, my) };
  if (c && (c.type === 'trivia' || c.type === 'sounditout') && (c.stage === 'question' || c.stage === 'perform')) {
    return { tone: 'steal', art: 'bell', title: 'Get ready to steal!', sub: 'If they miss, your ornament lights up. First tap wins.' };
  }
  return { tone: 'tv', art: 'popcorn', title: 'Watch the TV!', sub: nextUp(s, my) };
}

/* ================================================================== header ==================== */

function deriveHeader(s) {
  const me = s.me;
  const my = me && me.teamId ? teamOf(s, me.teamId) : null;
  if (!my || (ui.switching && s.phase === 'lobby')) {
    return { kind: 'brand' };
  }
  return { kind: 'team', team: teamLite(my), me: me.name, leader: my.rank === 1 && my.score > 0 && (s.teams || []).length > 1, x2: my.multiplier > 1 };
}

function renderHeader(hd) {
  if (hd.kind === 'brand') {
    headScore = null;
    topbarEl.dataset.key = '';
    topbarEl.className = 'phone-head phone-head--brand';
    setHTML(topbarEl, h`<span class="wordmark wordmark--sm">${art('tree', { size: 36, eager: true })}Christmas Chaos</span>`);
    return;
  }
  const t = hd.team;
  const key = `${t.id}|${t.name}|${t.mascot}|${t.color}|${hd.me}`;
  if (topbarEl.dataset.key !== key || !headScore) {
    topbarEl.dataset.key = key;
    topbarEl.className = 'phone-head';
    setHTML(
      topbarEl,
      h`<div class="gift-tag gift-tag--sm gift-tag--twine phone-tag" data-tc="${t.color}">
        <span class="phone-tag__mascot" data-my-mascot>${mascot(t, { size: 52, alt: '' })}<span class="phone-tag__star" data-lead hidden>${art('glowing-star', { size: 28, alt: 'In the lead', eager: true })}</span><span class="phone-tag__x2" data-x2 hidden title="Double Down">×2</span></span>
        <div class="tag-head__who"><div class="tag-head__team">${t.name}</div><div class="tag-head__me">You’re ${hd.me}</div></div>
        <div class="tag-head__pts"><span data-score>${formatPoints(t.score)}</span><span class="phone-tag__unit">pts</span></div>
      </div>`
    );
    hydrate(topbarEl);
    headScore = { teamId: t.id, score: t.score };
  }
  topbarEl.querySelector('[data-lead]').hidden = !hd.leader;
  topbarEl.querySelector('[data-x2]').hidden = !hd.x2;
  if (headScore.score !== t.score) {
    const el = topbarEl.querySelector('[data-score]');
    animateNumber(el, t.score, { from: headScore.score });
    const tag = topbarEl.querySelector('.phone-tag');
    tag.classList.remove('is-bump', 'is-drop');
    void tag.offsetWidth;
    tag.classList.add(t.score > headScore.score ? 'is-bump' : 'is-drop');
    setTimeout(() => tag.classList.remove('is-bump', 'is-drop'), 800);
    headScore = { teamId: t.id, score: t.score };
  }
}

/* ================================================================== markup helpers ============ */

const myMascotEl = () => topbarEl.querySelector('[data-my-mascot] > img');

function chipH(c) {
  return c ? slotChip(c.seg, { size: 'sm', text: c.text }) : '';
}
/** A row of chips on the left (they wrap) with the ornament timer hanging on the right. */
function rowH(chips, timer = '', { center = false, className = '' } = {}) {
  return h`<div class="ph-chips${center ? ' ph-chips--center' : ''}${className ? ` ${className}` : ''}"><div class="ph-chips__list">${chips}</div>${timer}</div>`;
}
/** The ornament timer, hidden until a timer is running; patched in place by tick(). */
function timerH(size = 64, label = 'Seconds left') {
  const t = S && S.timer;
  return h`<span class="ph-timer" data-timer-wrap role="group" aria-label="${label}" hidden>${timerRing(t, client.serverNow(), { size })}</span>`;
}
function titleH(title, sub) {
  return h`<h1 class="ph-title">${title}</h1>${sub ? h`<p class="ph-sub">${sub}</p>` : ''}`;
}
/** A rotating funny line (local list) or a fixed one (server quip). */
function jokeH(key, fixed) {
  const text = fixed && typeof fixed === 'object' ? fixed.text : fixed;
  if (text) return h`<p class="ph-joke">${art('sparkles', { size: 26 })}<span>${text}</span></p>`;
  return h`<p class="ph-joke">${art('sparkles', { size: 26 })}<span data-rotate="${key}">${line(key)}</span></p>`;
}
/** The server's current TV quip, in small type: Santa says… (about your team: Santa leans in and names you). */
function quipH(q) {
  if (!q) return '';
  const text = typeof q === 'object' ? q.text : q;
  const mine = typeof q === 'object' && q.mine;
  return h`<figure class="quip${mine ? ' quip--mine' : ''}" aria-label="${mine ? 'Santa says, about your team' : 'Santa says'}">${art('santa', { size: 44 })}<blockquote class="quip__bubble">${mine ? h`<span class="quip__tag">About your team</span>` : ''}${text}</blockquote></figure>`;
}
function miniBoardH(rows) {
  if (!rows || rows.length < 2) return '';
  return h`<section class="mini-board" aria-label="Scores">
    <ol class="score-mini" role="list">${rows.map(
      (r) => h`<li class="score-mini__item${r.you ? ' is-me' : ''}${r.up ? ' is-up' : ''}" data-tc="${r.color}">
        ${mascot(r, { size: 28, alt: '' })}<span class="score-mini__name">${r.name}${r.you ? h`<span class="sr-only"> (your team)</span>` : ''}</span>
        ${r.lead ? art('glowing-star', { size: 20, alt: 'Leader', className: 'mini-board__star' }) : ''}<span class="score-mini__pts">${formatPoints(r.score)}</span>
      </li>`
    )}</ol>
  </section>`;
}
function noteH(artId, html, tone = '') {
  return h`<aside class="ph-note-card ${tone}">${art(artId, { size: 44 })}<p>${html}</p></aside>`;
}
function calloutH(c, tc) {
  return h`<div class="callout callout--${c.tone}" ${tc ? h`data-tc="${tc}"` : ''}>${art(c.art, { size: 48 })}<div class="callout__text"><span class="callout__title">${c.title}</span>${c.sub ? h`<span class="callout__sub">${c.sub}</span>` : ''}</div></div>`;
}
function stockingRow(results, total, index, started, color) {
  return h`<ol class="stocking-row hot-row" role="list" aria-label="Progress">${Array.from({ length: total }, (_, i) => {
    const r = results[i];
    const st = r === 'correct' ? 'full' : r === 'wrong' ? 'coal' : r === 'pass' ? 'coal' : 'empty';
    const cls = !r && i === index && started ? ' is-current' : '';
    return h`<li class="hot-row__item${cls}">${stocking({ color: color || '#D42A2A', state: st, size: 44, ariaLabel: `Question ${i + 1}: ${r || 'to come'}` })}</li>`;
  })}</ol>`;
}

/* ================================================================== screens =================== */

const RENDER = {};
const BIND = {};
/** PATCH[id](root, data, prev): update the live screen in place (keeps focus, keyboard and drags); false = rebuild. */
const PATCH = {};

/* ---------- connecting ---------- */
RENDER.connecting = () => h`<div class="hello">
  ${art('sled', { size: 150, className: 'hello__art', eager: true })}
  <h1 class="ph-title">Christmas Chaos</h1>
  <p class="ph-sub">Warming up the sleigh <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
</div>`;

/* ---------- join ---------- */
RENDER.join = (d) => {
  const sel = d.teams.find((t) => t.id === d.selected) || null;
  const heading = d.mode === 'switch' ? 'Switch team' : d.mode === 'pick' ? 'Pick a new team' : d.late ? 'Jump in!' : 'Join the workshop';
  let btnLabel;
  if (!d.teams.length) btnLabel = 'Waiting for teams…';
  else if (!sel) btnLabel = 'Pick a team to join';
  else if (d.mode === 'switch' && sel.id === d.currentTeamId) btnLabel = `Stay on ${sel.name}`;
  else btnLabel = `${d.mode === 'switch' ? 'Move to' : 'Join'} ${sel.name}`;
  return h`
  ${d.mode !== 'switch' && (d.late || d.elves) ? rowH(h`<span class="tag tag--snow">${d.over ? 'Game over' : d.late ? `Game in progress · Round ${d.round} of ${d.total}` : `${plural(d.elves, 'elf', 'elves')} already in`}</span>`, '', { center: true }) : ''}
  <h1 class="ph-title">${heading}</h1>
  ${d.mode === 'join' && !d.kicked ? jokeH(d.late ? 'late' : 'join') : ''}
  ${d.kicked ? noteH('snowman', h`<strong>The host sent you back to the workshop door.</strong> No hard feelings — you can join again below.`, 'is-alert') : ''}
  ${d.removed != null ? noteH('snowflake', d.removed ? h`<strong>${d.removed} melted away.</strong> Pick another team to keep playing.` : h`<strong>You’re not on a team right now.</strong> Pick one to keep playing.`, 'is-warn') : ''}
  <section class="name-card" aria-label="Your name">
    <div class="name-card__row"><label class="label" for="player-name">Your name</label><span class="name-card__hint">Shown on the TV</span></div>
    <input id="player-name" class="input input--lg" type="text" data-draft="name" value="${ui.drafts.name || ''}" maxlength="${NAME_MAX}" autocomplete="nickname" autocapitalize="words" enterkeyhint="done" spellcheck="false" placeholder="e.g. Aunt Linda" required>
  </section>
  <section class="join-teams" aria-labelledby="team-h">
    <h2 class="ph-h2" id="team-h">Pick your team</h2>
    ${d.teams.length
      ? h`<div class="team-tags" role="group" aria-labelledby="team-h">${d.teams.map(
          (t) => h`<button type="button" class="team-tag${t.id === d.selected ? ' is-selected' : ''}" data-team="${t.id}" data-tc="${t.color}" aria-pressed="${t.id === d.selected ? 'true' : 'false'}">
            <span class="team-tag__hole" aria-hidden="true"></span>
            <span class="team-tag__art">${mascot(t, { size: 64, alt: '' })}</span>
            <span class="team-tag__name">${t.name}</span>
            <span class="team-tag__meta">${tileMeta(d, t)}</span>
            ${t.id === d.currentTeamId ? h`<span class="team-tag__now">Your team</span>` : ''}
            <span class="team-tag__check" aria-hidden="true">${ic('check', { size: 20, stroke: 3.4 })}</span>
          </button>`
        )}</div>`
      : h`<div class="empty">${art('snowman', { size: 96 })}<p><strong>No teams yet.</strong> The host is still building them <span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p></div>`}
  </section>
  <div class="ph-actions ph-actions--sticky">
    <button type="button" class="btn btn--lg btn--block ${sel ? 'btn--primary' : 'btn--secondary'}" data-join aria-disabled="${!sel || d.pending ? 'true' : 'false'}" data-needs-online>
      ${d.pending ? h`<span>Joining…</span>` : h`<span>${btnLabel}</span>${sel ? ic('arrow-right', { size: 26 }) : ''}`}
    </button>
    ${d.mode === 'switch' ? h`<button type="button" class="btn btn--link ph-cancel" data-cancel>Cancel — keep my team</button>` : ''}
  </div>`;
};
function tileMeta(d, t) {
  const who = t.players ? plural(t.players, 'elf', 'elves') : 'Be the first elf!';
  return d.late ? `${formatPoints(t.score)} pts · ${who}` : who;
}
PATCH.join = (root, d, prev) => {
  const same = ['mode', 'late', 'over', 'selected', 'currentTeamId', 'kicked', 'removed', 'pending'].every((k) => d[k] === prev[k]);
  if (!same || d.teams.length !== prev.teams.length) return false;
  if (d.teams.some((t, i) => ['id', 'name', 'color', 'mascot'].some((k) => t[k] !== prev.teams[i][k]))) return false;
  for (const t of d.teams) {
    const el = root.querySelector(`[data-team="${CSS.escape(t.id)}"] .team-tag__meta`);
    if (el) el.textContent = tileMeta(d, t);
  }
  return true;
};
BIND.join = (root, d) => {
  root.querySelectorAll('[data-team]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.pickTeam = ui.pickTeam === b.dataset.team && d.mode !== 'switch' ? null : b.dataset.team;
      vibrate(12);
      render();
      if (ui.pickTeam) fx.bounce(screenEl.querySelector(`[data-team="${CSS.escape(ui.pickTeam)}"] .team-tag__art > img`));
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
    toast('Type your name first — the elves need it for your stocking', { tone: 'warn' });
    return;
  }
  if (!ui.pickTeam) {
    shake(screenEl.querySelector('.team-tags'));
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
    setTimeout(() => fx.bounce(myMascotEl()), 120);
  }
}

/* ---------- waiting lobby: your stocking ---------- */
RENDER.lobby = (d) => h`
  ${titleH('You’re in!', `Your stocking is hung by the chimney with care.`)}
  <section class="mantel" data-tc="${d.team.color}" aria-label="${d.team.name}: ${plural(d.mates.length, 'player')}">
    <div class="mantel__shelf" aria-hidden="true"></div>
    <div class="mantel__hang">${stocking({ team: d.team, size: 128, hung: true })}</div>
    <h2 class="mantel__team">${d.team.name}</h2>
    <ul class="name-tags" role="list">${d.mates.map(
      (m) => h`<li class="name-tag${m.you ? ' is-you' : ''}${m.online ? '' : ' is-offline'}">${m.name}${m.you ? ' (you)' : ''}${m.online ? '' : h` <span class="name-tag__off">· offline</span>`}</li>`
    )}</ul>
  </section>
  <div class="wait-status" role="status"><span class="wait-status__bulbs" aria-hidden="true"><i class="bulb" style="--c:var(--bulb-red)"></i><i class="bulb" style="--c:var(--bulb-gold)"></i><i class="bulb" style="--c:var(--bulb-green)"></i></span><span>Waiting for the host to start</span></div>
  ${jokeH('wait', d.quip)}
  <div class="ph-foot">
    ${d.teamCount > 1 ? h`<button type="button" class="btn btn--link" data-switch>Switch team</button>` : ''}
    <p class="ph-small">Keep this page open. If your screen locks, you’ll rejoin automatically.</p>
  </div>`;
BIND.lobby = (root) => {
  root.querySelector('[data-switch]')?.addEventListener('click', () => {
    ui.switching = true;
    ui.pickTeam = S && S.me ? S.me.teamId : null;
    render();
  });
};

/* ---------- your turn: the peppermint SPIN ---------- */
RENDER.spin = (d) => {
  const spinning = d.mode === 'spinning' || d.pending;
  const title = d.mode === 'spinning' ? 'Eyes on the big screen!' : d.mode === 'double' ? 'Spin again!' : 'Your team is up!';
  const sub = d.mode === 'spinning'
    ? d.byMe ? 'You spun it! Watch the wheel on the TV.' : d.by ? `${d.by} spun it! Watch the wheel on the TV.` : 'Watch the wheel on the TV.'
    : d.mode === 'double' ? 'Everything you win this turn is doubled.' : 'Tap the peppermint to spin the wheel on the TV.';
  const live = d.mode !== 'spinning' && d.can && !d.pending;
  return h`
  ${rowH(d.mode === 'double' ? h`<span class="chip chip--sm chip--candy">${art('sparkles', { size: 26 })}Double Down · ×2</span>` : h`<span class="pill pill--sm">${d.round}</span>`, '', { center: true })}
  ${titleH(title, sub)}
  <div class="spin-stage">
    ${peppermint({ live, spinning, disabled: !live, label: 'Spin', ariaLabel: d.mode === 'spinning' ? 'The wheel is spinning' : 'Spin the wheel', className: d.pending ? 'is-pressed' : '', attrs: raw('data-spin data-needs-online') })}
  </div>
  ${jokeH(d.mode === 'spinning' ? 'spinning' : d.mode === 'double' ? 'double' : 'spin', d.quip)}
  ${miniBoardH(d.board)}`;
};
BIND.spin = (root, d) => {
  const b = root.querySelector('[data-spin]');
  if (b && d.mode !== 'spinning') onPress(b, () => act('spin', 'spin', {}, { quiet: ['not-now'] }), { haptic: 30 });
};

/* ---------- pick difficulty: three presents ---------- */
RENDER.difficulty = (d) => h`
  ${rowH(h`${chipH(d.chip)}${d.mult > 1 ? h`<span class="chip chip--sm chip--candy">×2 points</span>` : ''}`)}
  ${titleH('Pick a present', 'Bigger present, bigger points. Answer out loud as a team!')}
  <div class="gifts" role="group" aria-label="Difficulty">${d.levels.map(
    (l) => h`<button type="button" class="gift-row gift-row--${l.level}${d.pending === l.level ? ' is-picked' : ''}" data-level="${l.level}" aria-label="${l.label}, ${l.pts} points" aria-disabled="${d.pending ? 'true' : 'false'}" data-needs-online>
      <span class="gift-row__art">${present({ size: 'sm', color: l.color, ribbon: l.ribbon, state: d.pending === l.level ? 'unwrapping' : 'closed', inside: d.pending === l.level ? 'sparkles' : '' })}</span>
      <span class="gift-row__text">
        <span class="gift-row__top"><span class="gift-row__name">${l.label}</span><span class="gift-row__pts">${l.pts}</span></span>
        <span class="gift-row__joke">${l.joke}</span>
        <span class="gift-row__steal">Miss it? Others steal ${l.steal}</span>
      </span>
    </button>`
  )}</div>
  <p class="ph-small ph-small--center">${d.mates.length ? `First tap on your team decides — ${listJoin(d.mates, 'and')} can tap too.` : 'It’s all you! Your tap decides.'}</p>`;
BIND.difficulty = (root) => {
  root.querySelectorAll('[data-level]').forEach((b) =>
    b.addEventListener('click', () => {
      if (ui.pending) return;
      ui.pendingLevel = b.dataset.level;
      vibrate(25);
      act('pick', 'pickDifficulty', { level: b.dataset.level });
    })
  );
};

/* ---------- the steal buzzer: a red ornament ---------- */
RENDER.buzzer = (d) => {
  let title;
  let sub;
  let orn;
  let foot = '';
  const steal = d.sound ? 'name that tune' : 'steal it';
  switch (d.mode) {
    case 'armed':
      title = `Steal it for ${d.points}!`;
      sub = `${d.missed} ${d.sound ? 'ran out of time' : 'missed it'}. Know it? Tap the ornament first!`;
      orn = ornamentBuzz({ state: 'armed', ariaLabel: `Buzz in to steal for ${d.points}`, className: d.pending ? 'is-pressed' : '', attrs: raw('data-buzz data-needs-online') });
      foot = 'Any phone on your team can buzz.';
      break;
    case 'arming':
      title = 'Steal coming up…';
      sub = `${d.missed} ${d.sound ? 'ran out of time' : 'missed it'}! Fingers on the ornament — wait for it…`;
      orn = h`<div class="buzz-arming" data-countdown="${d.armingUntil}">${ornamentBuzz({ state: 'armed', word: '3', sub: 'Get ready', className: 'is-arming', ariaLabel: 'The buzzers arm in a moment', attrs: raw('aria-disabled="true" tabindex="-1"') })}</div>
        <div class="arm-bulbs" data-arm="${d.armingUntil}" aria-hidden="true"><i class="bulb" style="--c:var(--bulb-red)"></i><i class="bulb" style="--c:var(--bulb-gold)"></i><i class="bulb" style="--c:var(--bulb-green)"></i></div>`;
      foot = 'Don’t jump the gun!';
      break;
    case 'won':
      title = 'Quick — answer!';
      sub = `You beat everyone to it. ${d.points} points on the line!`;
      orn = ornamentBuzz({ state: 'first' });
      foot = 'The host is listening. Speak up!';
      break;
    case 'team':
      title = `${d.winner.name} got there first!`;
      sub = `Your team has the steal. Help ${d.winner.name} answer out loud!`;
      orn = ornamentBuzz({ state: 'first', word: 'Your team!', sub: `${d.winner.name} buzzed` });
      foot = 'One answer, out loud.';
      break;
    case 'lost':
      title = 'So close!';
      sub = `${d.winner.name}${d.winner.team ? ` on ${d.winner.team.name}` : ''} beat you to it. By a whisker.`;
      orn = ornamentBuzz({ state: 'other', name: d.winner.name });
      foot = `Watch the TV for ${possessive(d.winner.name)} answer.`;
      break;
    case 'locked':
      title = 'Your team had its try';
      sub = 'One shot per team. Them’s the rules.';
      orn = ornamentBuzz({ state: 'locked' });
      foot = 'Other teams may still steal — watch the TV.';
      break;
    default:
      title = 'Buzzers are resting';
      sub = 'The host may open them again. Stay ready!';
      orn = ornamentBuzz({ state: 'locked', word: 'Hold on', ariaLabel: 'Buzzers closed' });
      foot = 'Watch the TV.';
  }
  return h`<div class="buzz-screen buzz-screen--${d.mode}">
    ${rowH(h`${chipH(d.chip)}${d.difficulty ? h`<span class="chip chip--sm chip--outline">${d.difficulty}</span>` : ''}`, timerH(64, 'Seconds left to steal'))}
    <div class="buzz-head" aria-live="polite">${titleH(title, sub)}</div>
    <div class="buzz-stage">${orn}</div>
    <p class="ph-small ph-small--center">${foot || steal}</p>
  </div>`;
};
BIND.buzzer = (root, d) => {
  const b = root.querySelector('[data-buzz]');
  if (b && d.mode === 'armed') onPress(b, () => act('buzz', 'buzz', {}, { quiet: ['not-now'] }), { haptic: 40 });
};

/* ---------- performer: secret present (press and hold to peek) ---------- */
RENDER.secret = (d) => h`
  ${rowH(chipH(d.chip), timerH(64))}
  ${titleH(d.kind === 'sound' ? 'You’re humming!' : 'Top secret!',
    d.kind === 'sound'
      ? `${d.name}, hold the present to see your song. Don’t let ${d.team} peek!`
      : d.partner ? `You and ${d.partner} are performing. Hold the present to see your secret — no peeking, teammates!` : `${d.name}, hold the present to see your secret. Keep it away from ${d.team}!`)}
  ${secretCard({ label: d.label, value: d.value, rule: d.rule, tone: d.kind === 'sound' ? 'violet' : 'candy', hint: 'Tilt your phone toward you first' })}
  <div class="info-row">
    ${art(d.kind === 'sound' ? 'music' : 'masks', { size: 44 })}
    <span class="info-row__text">
      <span class="info-row__main" data-timer-show="idle">Ready? Tell the host to start the clock.</span>
      <span class="info-row__main" data-timer-show="started" hidden>The clock is running — go, go, go!</span>
      <span class="info-row__sub">${d.kind === 'sound' ? `Your team names it for ${d.points}` : `Nail it for ${d.points} points`}</span>
    </span>
  </div>
  <p class="ph-small ph-small--center">Hold to peek as often as you like.</p>`;
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
  ${rowH(chipH(d.chip), timerH(64))}
  ${titleH('You’re on, superstar!', d.partner ? `You and ${d.partner} are up for ${d.team}.` : `All eyes on you. Do it for ${d.team}!`)}
  <section class="stage-card candy-frame candy-frame--sm">
    ${art('masks', { size: 72, className: 'stage-card__art' })}
    <span class="label">The dare</span>
    <h2 class="stage-card__title">${d.title}</h2>
    <p class="stage-card__text">${d.instructions}</p>
    ${d.props.length ? h`<div class="props"><span class="label">You’ll need</span><ul class="props__list" role="list">${d.props.map((p) => h`<li class="prop-tag">${p}</li>`)}</ul></div>` : ''}
  </section>
  <div class="info-row">
    ${art('star', { size: 44 })}
    <span class="info-row__text">
      <span class="info-row__main" data-timer-show="idle">Ready? Tell the host to start the clock.</span>
      <span class="info-row__main" data-timer-show="started" hidden>The clock is running — go!</span>
      <span class="info-row__sub">Nail it for ${d.points} points</span>
    </span>
  </div>`;

/* ---------- room vote ---------- */
RENDER.vote = (d) => {
  const voting = d.can && (!d.myVote || d.editing);
  return h`
  ${rowH(chipH(d.chip), timerH(64, 'Seconds left to vote'))}
  ${titleH(`How did ${d.performer} do?`, 'Be honest. Be kind. Be quick.')}
  ${voting
    ? h`<div class="vote-btns" role="group" aria-label="Vote on ${possessive(d.performer)} dare">
        <button type="button" class="vote-btn vote-btn--nailed${d.myVote === 'nailed' ? ' is-current' : ''}" data-vote="nailed" aria-disabled="${d.pending ? 'true' : 'false'}" data-needs-online>
          ${art('star', { size: 72 })}<span class="vote-btn__text"><span class="vote-btn__label">Nailed it!</span><span class="vote-btn__sub">Worth ${d.nailed} points</span></span>
        </button>
        <button type="button" class="vote-btn vote-btn--good${d.myVote === 'good' ? ' is-current' : ''}" data-vote="good" aria-disabled="${d.pending ? 'true' : 'false'}" data-needs-online>
          ${art('cookie', { size: 72 })}<span class="vote-btn__text"><span class="vote-btn__label">Good try</span><span class="vote-btn__sub">Worth ${d.good} — and a cookie</span></span>
        </button>
      </div>`
    : h`<section class="vote-sent" role="status">
        ${art(d.myVote === 'good' ? 'cookie' : 'star', { size: 96, className: 'vote-sent__art' })}
        <h2 class="vote-sent__title">Vote sent!</h2>
        <p class="vote-sent__mine">You said <strong>${d.myVote === 'good' ? 'Good try' : 'Nailed it'}</strong></p>
        ${d.can ? h`<button type="button" class="btn btn--link" data-change>Change my vote</button>` : ''}
      </section>`}
  <p class="ph-small ph-small--center">Majority wins. The host has the final say.</p>`;
};
BIND.vote = (root) => {
  root.querySelectorAll('[data-vote]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await act('vote', 'vote', { choice: b.dataset.vote });
      if (res && res.ok) {
        ui.voteEdit = false;
        vibrate(25);
        render();
        fx.bounce(screenEl.querySelector('.vote-sent__art'));
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
  return h`<div class="picker picker--${d.kind}">
  <div class="pick-hero">
    ${art(grinch ? 'money' : 'boxing', { size: 84, className: 'pick-hero__art' })}
    <h1 class="pick-hero__title">${grinch ? 'Grinch Steal!' : 'Showdown!'}</h1>
  </div>
  <p class="ph-sub">${grinch
    ? h`Who’s been a little too nice? Pick a team ahead of you and swipe up to <strong>${formatPoints(d.points)}</strong> points. Mwahaha.`
    : h`Pick a rival team. One player from each side goes head to head — <strong>winner takes ${formatPoints(d.points)}</strong>.`}</p>
  <div class="targets" role="group" aria-labelledby="targets-h">
    <h2 class="ph-h2" id="targets-h">${grinch ? 'Teams ahead of you' : 'Choose your rival'}</h2>
    ${d.targets.map(
      (t) => h`<button type="button" class="target-tag${t.id === d.selected ? ' is-selected' : ''}" data-target="${t.id}" data-tc="${t.color}" aria-pressed="${t.id === d.selected ? 'true' : 'false'}" ${d.can ? '' : raw('aria-disabled="true"')}>
        <span class="target-tag__art">${mascot(t, { size: 56, alt: '' })}</span>
        <span class="target-tag__text">
          <span class="target-tag__name">${t.name}${t.leader ? art('glowing-star', { size: 22, alt: 'Leader' }) : ''}</span>
          <span class="target-tag__meta"><b>${formatPoints(t.score)}</b> pts${grinch ? ` · you’d take ${formatPoints(t.take)}` : ''}</span>
          ${t.eyedBy ? h`<span class="target-tag__eyed">${t.eyedBy} is eyeing them…</span>` : ''}
        </span>
        <span class="target-tag__radio" aria-hidden="true">${ic('check', { size: 20, stroke: 3.4 })}</span>
      </button>`
    )}
  </div>
  ${d.safe.length ? h`<p class="ph-small">${listJoin(d.safe.map((t) => t.name), 'and')} ${d.safe.length === 1 ? 'is' : 'are'} not ahead of you, so ${d.safe.length === 1 ? 'they’re' : 'they’re'} safe. For now.</p>` : ''}
  <div class="ph-actions ph-actions--sticky">
    <button type="button" class="btn btn--lg btn--block ${grinch ? 'btn--grinch' : 'btn--primary'}" data-confirm aria-disabled="${!sel || !d.can || d.pending ? 'true' : 'false'}" data-needs-online>
      <span>${d.pending ? 'Sending…' : sel ? `${grinch ? 'Steal from' : 'Challenge'} ${sel.name}` : 'Tap a team first'}</span>
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
    // mouse hover previews only until a team is picked (a re-render under a still cursor must not steal the pick)
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !(ui.target && ui.target.cid === d.cid)) preview(id); });
    b.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') preview(ui.target && ui.target.cid === d.cid ? ui.target.teamId : null); });
    b.addEventListener('click', () => {
      if (!S || !S.can.previewTarget) return;
      const next = ui.target && ui.target.cid === d.cid && ui.target.teamId === id ? null : id;
      ui.target = next ? { cid: d.cid, teamId: next } : null;
      preview(next);
      vibrate(10);
      render();
      if (next) fx.wobble(screenEl.querySelector(`[data-target="${CSS.escape(next)}"] .target-tag__art > img`));
    });
  });
  root.querySelector('[data-confirm]')?.addEventListener('click', async () => {
    if (!d.selected) {
      toast('Tap a team first', { tone: 'warn' });
      return;
    }
    const from = screenEl.querySelector(`[data-target="${CSS.escape(d.selected)}"]`);
    const res = await act('target', 'pickTarget', { teamId: d.selected });
    if (res && res.ok) {
      ui.target = null;
      if (d.kind === 'grinch') fx.sneak('money', { from: from || undefined });
    }
  });
};

/* ---------- Showdown: called up ---------- */
RENDER.calledup = (d) => h`
  ${rowH(chipH(d.chip), timerH(64))}
  ${titleH('You’re in the Showdown!', 'Run to the front — the host starts the clock.')}
  <div class="versus" role="group" aria-label="${d.me.name} versus ${d.opp ? d.opp.name : 'a rival'}">
    <div class="versus__side is-you" data-tc="${d.me.team.color}">${mascot(d.me.team, { size: 84, alt: '', className: 'versus__mascot' })}<span class="versus__name">${d.me.name}</span><span class="versus__team">${d.me.team.name}</span></div>
    <span class="versus__vs" aria-hidden="true">VS</span>
    ${d.opp ? h`<div class="versus__side" data-tc="${d.opp.team ? d.opp.team.color : ''}">${d.opp.team ? mascot(d.opp.team, { size: 84, alt: '', className: 'versus__mascot versus__mascot--flip' }) : ''}<span class="versus__name">${d.opp.name}</span><span class="versus__team">${d.opp.team ? d.opp.team.name : ''}</span></div>` : h`<div class="versus__side"></div>`}
  </div>
  <section class="gift-tag gift-tag--md challenge-card">
    <span class="label">The challenge</span>
    <h2 class="challenge-card__title">${d.title}</h2>
    ${d.instructions ? h`<p class="challenge-card__text">${d.instructions}</p>` : ''}
    <div class="holly-ribbon">${d.winner ? `${d.winner} · ` : ''}Winner takes <strong>${formatPoints(d.points)}</strong> · a tie is ${formatPoints(Math.round(d.points / 2))} each</div>
  </section>
  <p class="ph-small ph-small--center">Phone down — you’ll need both hands.</p>`;

/* ---------- Hot Seat performer ---------- */
RENDER.hotseat = (d) => h`
  ${rowH(chipH(d.chip), timerH(64))}
  ${titleH('You’re in the Hot Seat!', d.started ? 'Answer out loud — or say “pass”.' : `${d.total} quick questions, ${d.each} points each. Your team has to zip it!`)}
  ${d.started && d.question
    ? h`<section class="gift-tag gift-tag--md q-card hot-q" aria-live="polite"><span class="label">Question ${Math.min(d.index + 1, d.total)} of ${d.total}</span><p class="q-card__text">${d.question}</p></section>`
    : h`<section class="hot-ready">${art('fire', { size: 96, className: 'hot-ready__art' })}<p class="hot-ready__title">${d.index >= d.total ? 'All done — take a bow!' : 'Get comfy…'}</p><p class="ph-small">${d.index >= d.total ? 'Watch the TV for your total.' : 'The host starts the 45-second clock. Questions appear here and on the TV.'}</p></section>`}
  ${stockingRow(d.results, d.total, d.index, d.started, d.color)}
  <p class="hot-banked">Banked <b>${formatPoints(d.banked)}</b> points</p>`;

/* ---------- typed answers: All Play, round bonus, Final Chaos ---------- */
RENDER.answer = (d) => {
  const final = d.kind === 'final';
  const chips = final
    ? h`<span class="chip chip--sm chip--eve">${art(d.catArt, { size: 26 })}${d.category}</span><span class="chip chip--sm chip--points">Wager ${formatPoints(d.wager)}</span>`
    : d.kind === 'bonus'
      ? h`<span class="chip chip--sm chip--holly">${art('sparkles', { size: 26 })}Round ${d.round} bonus</span><span class="chip chip--sm chip--points">${d.points} each</span>`
      : h`${chipH(d.chip)}<span class="chip chip--sm chip--points">${d.points} + ${d.first} first</span>`;
  const title = d.stage === 'done' ? 'The reveal' : d.stage === 'locked' ? 'Answers are in!' : final ? 'Final answer' : d.kind === 'bonus' ? 'Bonus round!' : 'Everybody answers!';
  const head = h`${rowH(chips, d.stage === 'answering' ? timerH(64, 'Seconds left to answer') : '')}<h1 class="ph-title ph-title--sm">${title}</h1>`;
  const q = h`<section class="gift-tag gift-tag--md q-card" aria-label="The question"><span class="label">${final ? 'The final question' : 'The question'}</span><p class="q-card__text">${d.question}</p></section>`;
  if (d.stage === 'done' && d.result) {
    const r = d.result;
    return h`${head}${q}
      <section class="result-card ${r.correct ? 'is-good' : 'is-bad'}" role="status">
        ${r.correct
          ? h`<div class="result-card__ribbon">${art('party', { size: 44 })}<span>${r.first ? 'Correct — and first!' : 'Correct!'}</span>${r.delta ? h`<b class="result-card__delta">${formatDelta(r.delta)}</b>` : ''}</div>`
          : h`<span class="coal-stamp stamp--sm is-in">${r.answered ? 'Not this time' : 'No answer'}</span>`}
        ${r.answered ? h`<p class="result-card__said">Your team said <strong>“${r.text}”</strong>${r.by ? ` (${r.by})` : ''}</p>` : h`<p class="result-card__said">Your team didn’t send an answer. The elves are disappointed.</p>`}
      </section>
      <section class="gift-tag gift-tag--md answer-card"><span class="label">The answer</span><p class="answer-card__text">${r.answer}</p>${r.fact ? h`<p class="answer-card__fact">${r.fact}</p>` : ''}${r.firstTeam ? h`<p class="answer-card__fact">${r.firstTeam} got it first.</p>` : ''}</section>
      <p class="ph-small ph-small--center">Watch the TV for every team’s answer.</p>`;
  }
  if (d.stage !== 'answering') {
    return h`${head}${q}
      <section class="locked-card" role="status">
        ${art('gift', { size: 56 })}
        <div><span class="label">Answers locked</span>
        ${d.sub ? h`<p class="locked-card__text">Your team said <strong>“${d.sub.text}”</strong> <span class="muted">— ${d.sub.mine ? 'you sent it' : `sent by ${d.sub.by}`}</span></p>` : h`<p class="locked-card__text">Your team didn’t send an answer.</p>`}</div>
      </section>
      ${calloutH({ tone: 'tv', art: 'popcorn', title: 'Watch the TV!', sub: 'The answers are revealed there.' })}`;
  }
  const val = ui.drafts[d.key] ?? '';
  return h`${head}${q}
    <form class="answer-form" data-answer-form novalidate>
      <div data-sent>${sentH(d)}</div>
      <div class="field">
        <label class="label" for="answer-input">${possessive(d.team)} answer</label>
        <input id="answer-input" class="input input--lg" type="text" data-draft="${d.key}" value="${val}" maxlength="${d.max}" autocomplete="off" autocapitalize="sentences" enterkeyhint="send" spellcheck="false" placeholder="Type your answer" aria-describedby="answer-hint">
        <div class="answer-form__hint" id="answer-hint"><span>${final ? 'Close spelling still counts' : 'The host checks every answer'}</span><span data-count>${val.length} / ${d.max}</span></div>
      </div>
      <div class="ph-actions">
        <button type="submit" class="btn btn--lg btn--block btn--primary" data-needs-online ${d.pending ? raw('aria-disabled="true"') : ''}><span data-answer-label>${answerLabel(d)}</span></button>
        <p class="ph-small ph-small--center">${final ? 'You can change it until time runs out.' : 'The last answer from your team counts.'}</p>
      </div>
    </form>`;
};
function sentH(d) {
  if (!d.sub) return h`<div class="sent sent--none" role="status" aria-live="polite">${art('mitten', { size: 36 })}<span class="sent__text">Nothing sent yet. Anyone on your team can answer.</span></div>`;
  return h`<div class="sent ${d.sub.mine ? 'sent--mine' : ''}" role="status" aria-live="polite"><span class="sent__who" aria-hidden="true">${d.sub.mine ? ic('check', { size: 20, stroke: 3.4 }) : initial(d.sub.by)}</span><span class="sent__text">${d.sub.mine ? h`<strong>You sent</strong> “${d.sub.text}”. You can still change it.` : h`<strong>${d.sub.by}</strong> sent “${d.sub.text}”. Yours will replace it.`}</span></div>`;
}
function answerLabel(d) {
  return d.pending ? 'Sending…' : d.sub ? 'Send a new answer' : 'Send our answer';
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
      toast('Answer sent! Fingers crossed.', { tone: 'success', duration: 2200 });
      ui.drafts[d.key] = '';
      document.activeElement?.blur?.();
      render(true);
    }
  });
};

/* ---------- Final Chaos intro (Christmas Eve) ---------- */
RENDER.finalintro = (d) => h`
  <div class="eve-hero">
    ${art('moon', { size: 96, className: 'eve-hero__art' })}
    <span class="eve-hero__eyebrow">It’s Christmas Eve…</span>
    <h1 class="ph-title">Final Chaos!</h1>
    <span class="chip chip--sm chip--eve">${art(d.catArt, { size: 26 })}Category: ${d.category}</span>
  </div>
  <section class="gift-tag gift-tag--md eve-steps">
    <p class="eve-steps__lead">Your team has <b>${formatPoints(d.score)}</b> points.</p>
    <ol class="steps" role="list">
      <li><span class="steps__n">1</span><span><strong>Bet</strong> up to ${formatPoints(d.max)}${d.behind ? ' (everyone can bet at least 300)' : ''}.</span></li>
      <li><span class="steps__n">2</span><span><strong>Answer</strong> the final question on your phone.</span></li>
      <li><span class="steps__n">3</span><span><strong>Win or lose</strong> your bet in the big reveal.</span></li>
    </ol>
  </section>
  ${d.quip ? quipH(d.quip) : ''}
  ${calloutH({ tone: 'tv', art: 'popcorn', title: 'Watch the TV!', sub: 'Bets open in a moment.' })}`;

/* ---------- Final wager: a present with a bow ---------- */
function stepFor(max) {
  return max % 25 === 0 ? 25 : 1;
}
RENDER.wager = (d) => {
  const amount = ui.wager ? ui.wager.amount : 0;
  const half = Math.floor(d.max / 2);
  const pct = d.max ? (amount / d.max) * 100 : 0;
  return h`
  ${rowH(h`<span class="chip chip--sm chip--eve">${art(d.catArt, { size: 26 })}${d.category}</span>`, timerH(64, 'Seconds left to bet'))}
  ${titleH('Place your bet', h`Your team has <strong>${formatPoints(d.score)}</strong>. How brave are you feeling?`)}
  <section class="wager-card" data-wager>
    <div class="wager-card__top">
      ${present({ size: 'sm', color: '#D42A2A', ribbon: '#EDB321', state: d.locked && d.locked.amount === amount ? 'sealed' : 'closed', className: 'wager-card__gift' })}
      <div class="wager-card__readout">
        <label class="label" for="wager-range">Your bet</label>
        <span class="wager-card__amount"><span data-w-amount>${formatPoints(amount)}</span></span>
        <span class="wager-card__unit">points</span>
      </div>
    </div>
    <input id="wager-range" class="cane-range" type="range" min="0" max="${d.max}" step="${stepFor(d.max)}" value="${amount}" aria-valuetext="${formatPoints(amount)} points" data-w-range ${d.can ? '' : raw('disabled')} data-pct="${pct.toFixed(2)}">
    <div class="wager-card__ends" aria-hidden="true"><span>0</span><span>${formatPoints(d.max)}</span></div>
    <div class="qchips" role="group" aria-label="Quick bets">
      <button type="button" class="qchip" data-w-set="0" aria-label="Bet nothing"><span class="qchip__main">0</span><span class="qchip__sub">Play it safe</span></button>
      <button type="button" class="qchip" data-w-set="${half}" aria-label="Bet half, ${formatPoints(half)}"><span class="qchip__main">Half</span><span class="qchip__sub">Sensible sweater</span></button>
      <button type="button" class="qchip" data-w-set="${d.max}" aria-label="Go all in, ${formatPoints(d.max)}"><span class="qchip__main">All in</span><span class="qchip__sub">Sleigh or bust!</span></button>
    </div>
    <div class="outcomes">
      <div class="outcome outcome--right"><span class="outcome__label">If right</span><span class="outcome__num" data-w-right>${formatPoints(d.score + amount)}</span></div>
      <div class="outcome outcome--wrong"><span class="outcome__label">If wrong</span><span class="outcome__num" data-w-wrong>${formatPoints(Math.max(0, d.score - amount))}</span></div>
    </div>
  </section>
  <div class="ph-actions ph-actions--sticky">
    <button type="button" class="btn btn--lg btn--block ${d.locked && d.locked.amount === amount ? 'btn--holly' : 'btn--primary'}" data-w-lock data-needs-online aria-disabled="${!d.can || d.pending ? 'true' : 'false'}"><span data-w-label>${wagerLabel(d, amount)}</span></button>
    <p class="ph-small ph-small--center" role="status" data-w-hint>${wagerHint(d)}</p>
  </div>`;
};
function wagerHint(d) {
  return d.locked ? `Locked in ${formatPoints(d.locked.amount)} by ${d.locked.mine ? 'you' : d.locked.by}. Slide to change it.` : 'Anyone on your team can lock it in. The last lock wins.';
}
PATCH.wager = (root, d, prev) => {
  if (['key', 'max', 'score', 'can', 'category'].some((k) => d[k] !== prev[k]) || !root._wagerUpdate) return false;
  Object.assign(prev, d); // BIND.wager's handlers read this same object
  root.querySelector('[data-w-hint]').textContent = wagerHint(prev);
  root.querySelector('[data-w-lock]').setAttribute('aria-disabled', !prev.can || prev.pending ? 'true' : 'false');
  root._wagerUpdate(ui.wager.amount, false);
  return true;
};
function wagerLabel(d, amount) {
  if (d.pending) return 'Locking in…';
  if (d.locked && d.locked.amount === amount) return `Locked in: ${formatPoints(amount)}`;
  if (d.locked) return `Change bet to ${formatPoints(amount)}`;
  return `Lock in ${formatPoints(amount)}`;
}
BIND.wager = (root, d) => {
  const range = root.querySelector('[data-w-range]');
  const gift = root.querySelector('.wager-card__gift');
  const update = (amount, fromRange) => {
    const a = Math.max(0, Math.min(d.max, Math.round(Number(amount) || 0)));
    ui.wager.amount = a;
    if (!fromRange) range.value = String(a);
    const pct = (d.max ? (a / d.max) * 100 : 0).toFixed(2);
    range.dataset.pct = pct; // hydrate() re-applies data-pct after every patch
    range.style.setProperty('--fill', `${pct}%`);
    range.setAttribute('aria-valuetext', `${formatPoints(a)} points`);
    root.querySelector('[data-w-amount]').textContent = formatPoints(a);
    root.querySelector('[data-w-right]').textContent = formatPoints(d.score + a);
    root.querySelector('[data-w-wrong]').textContent = formatPoints(Math.max(0, d.score - a));
    root.querySelector('[data-w-label]').textContent = wagerLabel(d, a);
    const same = !!(d.locked && d.locked.amount === a);
    const lockBtn = root.querySelector('[data-w-lock]');
    lockBtn.classList.toggle('btn--holly', same);
    lockBtn.classList.toggle('btn--primary', !same);
    gift?.classList.toggle('is-sealed', same);
    gift?.style.setProperty('--grow', String(0.82 + (d.max ? a / d.max : 0) * 0.36));
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
      if (Number(b.dataset.wSet) === d.max) fx.shake(gift);
    })
  );
  root.querySelector('[data-w-lock]').addEventListener('click', async () => {
    if (!d.can) return;
    const amount = ui.wager.amount;
    const res = await act('wager', 'wager', { amount });
    if (res && res.ok) {
      vibrate(30);
      toast(amount === 0 ? 'Bet locked: 0. Bold strategy.' : amount === d.max ? `All in: ${formatPoints(amount)}! Sleigh or bust!` : `Bet locked: ${formatPoints(amount)}`, { tone: 'success', duration: 2400 });
    }
  });
};

/* ---------- Final reveal ---------- */
RENDER.freveal = (d) => {
  const m = d.mine;
  const judged = !!(m && m.judged);
  const title = judged ? (m.correct ? 'You got it!' : 'Oh, crumbs.') : m && m.revealed ? 'The elves are judging…' : 'Drumroll, please…';
  return h`
  ${rowH(h`<span class="chip chip--sm chip--eve">${art('sparkles', { size: 26 })}The big reveal</span>`)}
  ${titleH(title)}
  <section class="gift-tag gift-tag--md q-card"><span class="label">The final question</span><p class="q-card__text q-card__text--sm">${d.question}</p>${d.answer ? h`<p class="q-card__answer">${ic('check', { size: 20, stroke: 3.4 })}${d.answer}</p>` : ''}</section>
  <section class="fr-mine ${judged ? (m.correct ? 'is-good' : 'is-bad') : ''}">
    <span class="label">Your team</span>
    <div class="fr-mine__row">
      <div class="fr-mine__what"><span class="fr-mine__text">${d.myText ? `“${d.myText}”` : 'No answer'}</span><span class="fr-mine__wager">Bet ${formatPoints(d.myWager)}</span></div>
      ${judged ? h`<span class="fr-mine__delta">${m.delta ? formatDelta(m.delta) : '±0'}</span>` : h`<span class="fr-mine__wait">${m && m.revealed ? 'Judging…' : d.pos ? `Revealed ${ordinal(d.pos)} of ${d.count}` : 'Waiting'}</span>`}
    </div>
    ${judged && !m.correct ? h`<span class="coal-stamp stamp--sm is-in">Not this time</span>` : ''}
  </section>
  ${d.quip ? quipH(d.quip) : ''}
  <ol class="standings" role="list" aria-label="Reveal order">${d.rows.map(
    (r) => h`<li class="standings__row${r.current ? ' is-current' : ''}${r.you ? ' is-you' : ''}" data-tc="${r.team ? r.team.color : ''}">
      ${r.team ? mascot(r.team, { size: 36, alt: '' }) : ''}<span class="standings__name">${r.team ? r.team.name : ''}</span>
      <span class="standings__res">${r.judged ? h`<span class="mark ${r.correct ? 'is-good' : 'is-bad'}">${ic(r.correct ? 'check' : 'x', { size: 16, stroke: 3.4 })}</span><span class="standings__pts">${r.delta ? formatDelta(r.delta) : '±0'}</span>` : h`<span class="standings__wait">${r.revealed ? 'judging…' : r.current ? 'up now' : 'waiting'}</span>`}</span>
    </li>`
  )}</ol>`;
};

/* ---------- round break: hot cocoa ---------- */
RENDER.roundbreak = (d) => h`
  <div class="cocoa-hero">
    ${art('cocoa', { size: 112, className: 'cocoa-hero__art' })}
    <span class="tag tag--snow">End of round ${d.round} of ${d.total}</span>
    <h1 class="ph-title">Hot cocoa break!</h1>
    <p class="ph-sub">${d.bonus ? 'First, a bonus question for every team!' : d.finalNext ? 'Final Chaos is next. Gulp.' : d.next >= d.total ? `Round ${d.next} is the last round!` : `Round ${d.next} of ${d.total} is next.`}</p>
  </div>
  ${d.me ? h`<section class="rb-me" data-tc="${d.me.color}">
    ${mascot(d.me, { size: 64, alt: '', className: 'rb-me__mascot' })}
    <div class="rb-me__text"><span class="label">Your team is</span><span class="rb-me__place">${ordinal(d.me.rank)}</span><span class="rb-me__note">${d.note || ''}</span></div>
    ${d.me.move === 'up' && d.me.places ? h`<span class="move is-up">${ic('arrow-up', { size: 20, stroke: 3.4 })}${d.me.places}</span>` : d.me.move === 'down' && d.me.places ? h`<span class="move is-down">${ic('arrow-down', { size: 20, stroke: 3.4 })}${d.me.places}</span>` : ''}
  </section>` : ''}
  ${jokeH('', d.quip || d.roast)}
  <ol class="standings" role="list" aria-label="Standings">${d.standings.map(
    (r) => h`<li class="standings__row${r.you ? ' is-you' : ''}" data-tc="${r.color}"><span class="standings__rank">${r.rank}</span>${mascot(r, { size: 36, alt: '' })}<span class="standings__name">${r.name}${r.you ? h`<span class="sr-only"> (your team)</span>` : ''}</span>${r.move === 'up' && r.places ? h`<span class="move move--sm is-up" title="Up ${r.places}">${ic('arrow-up', { size: 14, stroke: 3.4 })}${r.places}</span>` : r.move === 'down' && r.places ? h`<span class="move move--sm is-down" title="Down ${r.places}">${ic('arrow-down', { size: 14, stroke: 3.4 })}${r.places}</span>` : ''}<span class="standings__pts">${formatPoints(r.score)}</span></li>`
  )}</ol>`;

/* ---------- podium / game over ---------- */
const PLACE_ART = { 1: 'medal1', 2: 'medal2', 3: 'medal3' };
RENDER.podium = (d) => {
  const won = d.place === 1;
  const title = won ? (d.tied ? 'Tied for the win!' : 'You won!') : d.place <= 3 ? `${ordinal(d.place)} place!` : `${ordinal(d.place)} place`;
  const sub = won ? 'Santa’s putting your team on the nice list. Permanently.'
    : d.place === 2 ? 'So close you could smell the cookies.'
      : d.place === 3 ? 'Bronze! Shiny like a tree bauble.'
        : 'You won… a hot cocoa. You’ve earned it.';
  return h`
  <section class="go-hero go-hero--${Math.min(d.place, 4)}" data-tc="${d.team.color}">
    <span class="go-hero__art">${art(PLACE_ART[d.place] || 'cocoa', { size: 140, alt: d.place <= 3 ? `${ordinal(d.place)} place medal` : 'Hot cocoa' })}${mascot(d.team, { size: 64, alt: '', className: 'go-hero__mascot' })}</span>
    <span class="go-hero__eyebrow">${d.team.name}</span>
    <h1 class="ph-title">${title}</h1>
    <p class="ph-sub">${sub}</p>
    <span class="go-hero__score"><span class="label">Final score</span><b>${formatPoints(d.score)}</b></span>
  </section>
  ${d.awards.map(
    (a) => h`<div class="gift-tag gift-tag--md award-tag${a.key === 'lumpOfCoal' ? ' award-tag--coal' : ''}" role="group" aria-label="Award: ${a.title} — ${a.name}">
      ${a.key === 'lumpOfCoal' ? h`<span class="award-tag__coal" aria-hidden="true"><span class="coal"></span>${art(a.art, { size: 48, className: 'award-tag__art' })}</span>` : art(a.art, { size: 64, className: 'award-tag__art' })}
      <div class="award-tag__text"><span class="award-tag__eyebrow">${a.key === 'lumpOfCoal' ? (a.you ? 'Santa noticed you…' : 'Santa noticed your team…') : a.you ? 'You won an award!' : 'Your team won an award!'}</span><span class="award-tag__title">${a.title}</span><span class="award-tag__who">${a.name}</span>${a.detail ? h`<span class="award-tag__detail">${a.detail}</span>` : ''}</div>
    </div>`
  )}
  ${d.quip ? quipH(d.quip) : ''}
  <ol class="standings standings--final" role="list" aria-label="Final standings">${d.standings.map(
    (r) => h`<li class="standings__row${r.you ? ' is-you' : ''} place-${Math.min(r.place, 4)}" data-tc="${r.color}"><span class="standings__rank">${r.place}</span>${mascot(r, { size: 36, alt: '' })}<span class="standings__name">${r.name}${r.you ? h` <span class="you-pill">You</span>` : ''}</span><span class="standings__pts">${formatPoints(r.score)}</span></li>`
  )}</ol>
  ${d.others.length ? h`<section class="other-awards" aria-labelledby="oa-h"><h2 class="ph-h2" id="oa-h">The other awards</h2><ul role="list">${d.others.map((a) => h`<li>${art(a.art, { size: 36 })}<span><b>${a.title}</b><span>${a.name}${a.team && !a.name.includes(a.team) ? ` · ${a.team}` : ''}</span></span></li>`)}</ul></section>` : ''}
  <div class="go-end">
    <p class="go-end__thanks">Thanks for playing. Merry Christmas!</p>
    <p class="ph-small ph-small--center">Stay here — the host can start a new game.</p>
  </div>`;
};

/* ---------- watching ---------- */
RENDER.watch = (d) => {
  const n = d.now;
  const r = n.result;
  return h`
  ${d.up ? h`<div class="up-row" data-tc="${d.up.color}">
    <span class="up-row__mascot">${mascot(d.up, { size: 64, alt: '', className: 'up-row__img' })}</span>
    <div class="up-row__text">
      <div class="up-row__pills"><span class="up-now">${d.up.mine ? 'You’re up!' : 'Up now'}</span>${d.round ? h`<span class="pill pill--sm pill--snow">${d.round}</span>` : ''}</div>
      <h1 class="up-row__name">${d.up.name}</h1>
    </div>
  </div>` : h`<h1 class="ph-title">Watch the TV</h1>`}
  <section class="gift-tag gift-tag--md now-card${r ? (r.good ? ' is-good' : ' is-bad') : ''}" aria-labelledby="now-title">
    ${n.chip || n.chip2 || n.timer ? rowH(h`${chipH(n.chip)}${n.chip2 ? h`<span class="chip chip--sm chip--outline">${n.chip2}</span>` : ''}`, n.timer ? timerH(56) : '', { className: 'now-card__chips' }) : ''}
    ${n.spinning ? h`<div class="now-card__spin" aria-hidden="true">${peppermint({ spinning: true, className: 'peppermint--sm', attrs: raw('tabindex="-1" aria-hidden="true"') })}</div>` : ''}
    <h2 class="now-card__title${n.question ? ' is-q' : ''}" id="now-title">${n.title}</h2>
    ${n.body ? h`<p class="now-card__body">${n.body}</p>` : ''}
    ${n.lines.length ? h`<ul class="now-card__lines" role="list">${n.lines.map((l) => h`<li>${ic(l.icon, { size: 20 })}<span>${l.text}</span></li>`)}</ul>` : ''}
    ${n.vs ? h`<div class="mini-vs">
      <span class="mini-vs__side">${n.vs.a.team ? mascot(n.vs.a.team, { size: 36, alt: '' }) : ''}<span>${n.vs.a.name}</span></span>
      <span class="mini-vs__vs">VS</span>
      <span class="mini-vs__side">${n.vs.b.team ? mascot(n.vs.b.team, { size: 36, alt: '' }) : ''}<span>${n.vs.b.name}</span></span>
    </div>` : ''}
    ${n.dots ? stockingRow(n.dots.results, n.dots.total, n.dots.index, true, n.dots.color) : ''}
    ${n.ticks && n.ticks.length ? h`<ul class="ticks" role="list">${n.ticks.map((t) => h`<li>${ic('check', { size: 16, stroke: 3.4 })}${t}</li>`)}</ul>` : ''}
    ${n.tally ? h`<div class="tally"><span><b>${n.tally.nailed}</b> nailed it</span><span><b>${n.tally.good}</b> good try</span><span class="muted">${n.tally.voters} of ${n.tally.eligible} voted</span></div>` : ''}
    ${r ? h`<div class="now-card__result">
      ${r.good ? h`<div class="holly-ribbon holly-ribbon--plain">${r.title}</div>`
        : r.title.length <= 16 ? h`<span class="coal-stamp stamp--sm is-in">${r.title}</span>`
          : h`<span class="coal-stamp stamp--sm is-in">Not this time</span><p class="now-card__lost">${r.title}</p>`}
      ${r.answer ? h`<p class="now-card__answer">${ic('check', { size: 20, stroke: 3.4 })}<span>${r.answer}</span></p>` : ''}
      ${r.fact ? h`<p class="now-card__fact">${r.fact}</p>` : ''}
      ${r.deltas.length ? h`<div class="deltas">${r.deltas.map((x) => h`<span class="delta-tag${x.you ? ' is-you' : ''}${x.delta < 0 ? ' is-down' : ''}">${x.team ? mascot(x.team, { size: 28, alt: '' }) : ''}<span>${x.team ? x.team.name : ''}</span><b>${formatDelta(x.delta)}</b></span>`)}</div>` : ''}
    </div>` : ''}
  </section>
  ${quipH(d.quip)}
  ${calloutH(d.callout, d.up && d.callout.tone === 'team' ? d.up.color : null)}
  ${miniBoardH(d.board)}`;
};

/* ================================================================== render loop =============== */

function hydrate(root) {
  root.querySelectorAll('[data-tc]').forEach((el) => {
    const c = safeColor(el.dataset.tc, '');
    if (c) el.style.setProperty('--team-color', c);
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

/** Page mood: Christmas Eve (Final Chaos) is the only dark screen; the garland follows the game. */
function setScene(s) {
  const joined = !!(s && s.me && s.me.teamId);
  const eve = joined && EVE_PHASES.has(s.phase);
  if (document.body.classList.contains('night-sky') !== eve) {
    document.body.classList.toggle('night-sky', eve);
    document.documentElement.classList.toggle('is-eve', eve);
    if (eve && !stars) stars = starfield(appEl, { count: 22 });
    if (!eve && stars) {
      stars.remove?.();
      stars = null;
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', eve ? '#0E1A3A' : '#EAF2FB');
  }
  let mode = 'twinkle';
  if (s && s.phase === 'spinning') mode = 'spin-fast';
  else if (eve) mode = 'lit';
  else if (s && s.phase === 'turnIntro' && joined && s.activeTeamId === s.me.teamId) mode = 'chase';
  if (mode !== lightsMode) {
    lightsMode = mode;
    if (mode === 'spin-fast') lights.chase(0.45);
    else if (mode === 'chase') lights.chase(1.2);
    else if (mode === 'lit') lights.lit();
    else lights.twinkle();
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
  setScene(S);
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
    screenEl._enterT = setTimeout(() => screenEl.classList.remove('is-entering'), 450);
  }
  cur = { id: view.id, sig, data: view.data };
  tick();
  afterRender(view);
}

/** One-shot reactions to results that arrive as state (All Play / bonus reveal, Final judgement, podium). */
function afterRender(view) {
  const d = view.data;
  if (view.id === 'answer' && d.stage === 'done' && d.result) {
    const k = `ans:${d.key}`;
    if (!ui.seen.has(k)) {
      ui.seen.add(k);
      if (d.result.correct) celebrate();
      else if (d.result.answered) commiserate(null);
    }
  } else if (view.id === 'freveal' && d.mine && d.mine.judged) {
    const k = `final:${d.key}`;
    if (!ui.seen.has(k)) {
      ui.seen.add(k);
      if (d.mine.correct) celebrate({ big: true });
      else commiserate(screenEl.querySelector('.fr-mine'));
    }
  } else if (view.id === 'podium') {
    const k = `podium:${S.gameNo}`;
    if (!ui.seen.has(k)) {
      ui.seen.add(k);
      if (d.place === 1) celebrate({ big: true, force: true });
      else if (d.place <= 3) fx.bounce(screenEl.querySelector('.go-hero__art > img'));
    }
  }
}

/* timers, countdowns and the arming bulbs, patched in place */
function tick() {
  if (!S) return;
  const now = client.serverNow();
  const t = S.timer;
  const show = !!t && (t.started || t.running);
  qsa('[data-timer-wrap]', screenEl).forEach((w) => {
    w.hidden = !show;
    if (!show) return;
    updateTimerRing(w, t, now);
    w.classList.toggle('is-warn', timerWarn(t, now));
  });
  qsa('[data-timer-show]', screenEl).forEach((el) => {
    el.hidden = (el.dataset.timerShow === 'started') !== show;
  });
  qsa('[data-countdown]', screenEl).forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.countdown) - now) / 1000));
    const v = left ? String(left) : 'Go!';
    const word = el.querySelector('.ornament-btn__word') || el;
    if (word.textContent !== v) word.textContent = v;
  });
  qsa('[data-arm]', screenEl).forEach((el) => {
    const left = Math.max(0, Math.ceil((Number(el.dataset.arm) - now) / 1000));
    const lit = Math.min(3, Math.max(0, 4 - left));
    [...el.children].forEach((b, i) => b.classList.toggle('is-off', i >= lit));
  });
}
setInterval(tick, 250);

/* the funny lines rotate in place (no re-render) */
setInterval(() => {
  qsa('[data-rotate]', screenEl).forEach((el) => {
    const key = el.dataset.rotate;
    const list = LINES[key];
    if (!list || list.length < 2) return;
    ui.rot[key] = ((ui.rot[key] ?? 0) + 1) % list.length;
    el.classList.remove('is-in');
    void el.offsetWidth;
    el.textContent = list[ui.rot[key]];
    el.classList.add('is-in');
  });
}, 6500);

/* ================================================================== comedy ==================== */

/** Your team scored: confetti burst, a happy buzz, the garland blinks green and your mascot bounces. */
function celebrate({ big = false, force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastCheer < 2500) return;
  lastCheer = now;
  const light = busyReading();
  vibrate(light ? [30, 40, 30] : HAPPY);
  lights.blink('#1F9D57', light ? 1 : 3);
  fx.bounce(myMascotEl());
  if (!light && !reducedMotion()) fx.confetti({ count: big ? 110 : 60, snow: 0.35, duration: big ? 2300 : 1800 });
}
/** Hot Seat and Rapid List score in quick ticks while people read: no confetti or coal over the question then. */
function busyReading() {
  const c = S && S.challenge;
  return !!c && (c.type === 'hotseat' || c.type === 'rapidlist') && c.stage !== 'done';
}
/** Your team missed: a sad buzz, your mascot droops, and (optionally) a lump of coal lands on the card. */
function commiserate(coalTarget) {
  const now = Date.now();
  if (now - lastGroan < 2500) return;   // a miss arrives as fx AND as state: one coal per miss
  lastGroan = now;
  vibrate(SAD);
  fx.droop(myMascotEl());
  if (coalTarget) fx.coalDrop(coalTarget);
}
/** The server's react cue for your team (COMEDY.md §2): cheer · groan · gasp · laugh. */
function reactMood(mood) {
  const el = myMascotEl();
  if (mood === 'cheer') {
    // a correct answer also sends fx 'correct' / 'points': celebrate() has a cooldown, so this never doubles up
    celebrate();
    fx.bounce(el);
  } else if (mood === 'groan') {
    vibrate(SAD);
    fx.droop(el);
  } else if (mood === 'gasp' || mood === 'laugh') {
    vibrate(25);
    fx.wobble(el);
  }
}

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
  setTimeout(() => el.classList.remove('shake'), 520);
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
    const b = e.target.closest?.('.btn, .team-tag, .gift-row, .vote-btn, .target-tag, .qchip');
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
  const meId = S.me.playerId;
  switch (type) {
    case 'turn':
      if (p.teamId && p.teamId === my) {
        vibrate([90, 60, 90]);
        announce('Your team is up! Spin the wheel.');
        lights.flash(3);
        fx.peek('santa', 'bottom-right', { say: 'Your turn!', size: Math.min(200, Math.round(innerHeight * 0.24)) });
      }
      break;
    case 'spinStart':
      lights.chase(0.45);
      break;
    case 'land':
      lights.flash(3);
      if (p.teamId === my) fx.bounce(myMascotEl());
      break;
    case 'buzz':
      if (p.playerId === meId) {
        vibrate([60, 40, 220]);
        announce('You buzzed first! Answer out loud.');
        lights.blink('#1F9D57', 2);
      } else if (p.teamId !== my) {
        vibrate(20);
      }
      break;
    case 'armed':
      if (Array.isArray(p.eligibleTeamIds) && p.eligibleTeamIds.includes(my)) {
        vibrate(40);
        announce('The ornament is live! Tap to steal.');
      }
      break;
    case 'calledUp':
      if (Array.isArray(p.playerIds) && p.playerIds.includes(meId)) {
        vibrate([140, 80, 140, 80, 260]);
        announce(p.kind === 'showdown' ? 'You are in the Showdown! Get to the front.' : 'You are the performer!');
        fx.bounce(myMascotEl());
      }
      break;
    case 'correct':
      if (p.teamId === my) celebrate();
      break;
    case 'wrong':
      if (p.teamId === my) commiserate(p.small || busyReading() ? null : screenEl.querySelector('.now-card, .q-card, .gift-tag') || topbarEl);
      break;
    case 'points':
      if (p.teamId === my && p.delta && p.reason !== 'Undo') {
        announce(`${formatDelta(p.delta)} points for your team`);
        if (p.delta > 0) celebrate();
      }
      break;
    case 'steal':
      if (p.from === my) {
        vibrate([40, 30, 40, 30, 160]);
        fx.sneak('money', { from: topbarEl.querySelector('.phone-tag') || undefined });
        fx.droop(myMascotEl());
      } else if (p.to === my) {
        fx.bounce(myMascotEl());
      }
      break;
    case 'timerEnd': {
      const ring = screenEl.querySelector('[data-timer-wrap]:not([hidden]) .timer-ring');
      if (ring) fx.melt(ring);
      break;
    }
    case 'react':
      if (p.teamId && p.teamId === my) reactMood(p.mood);
      break;
    case 'doubleDown':
      if (p.teamId === my) {
        lights.flash(4);
        fx.bounce(myMascotEl());
      }
      break;
    default:
      break;
  }
});

client.onConnection((on) => {
  document.body.classList.toggle('is-offline', !on);
});

render();
