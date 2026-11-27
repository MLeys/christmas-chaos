'use strict';
/**
 * Host "live directions" (coach panel) + the opening script. Pure functions of the game state, recomputed on
 * every state push, so they are never out of date.
 *
 *   buildCoach(game, pv, host) -> { headline, say, steps[], tips[], actions[], primary, progress[], punchline }
 *   buildIntroScript(game, pv) -> { title, minutes, words, joinAddress, summary, sections[], text }
 *
 * Every action that sends an event is dry-run through game.check(): if the server would reject it right now it
 * comes back `disabled:true` with a human `reason`, so the host never sees a live button that does nothing.
 * The server-level save events (host:resume / host:discardSave) are not game events: they are live while a save is offered.
 * `say` is read OUT LOUD, so it never contains an answer, song title, dare secret or list answer before the reveal.
 * The TV quip (publicView.quip, already public) is appended to `say` as a suggested punchline with a stage direction.
 */

const { isPluralTeam, subject, possessive } = require('./grammar');

const HOST = { role: 'host' };
/** Handled by server.js itself (saved games), not by game.dispatch(), so game.check() cannot dry-run them. */
const SERVER_EVENTS = new Set(['host:resume', 'host:discardSave']);
const DASH = ' — ';
const ELL = '…';
const MINUS = '−';

const REASONS = {
  'need-two-teams': 'Add at least two teams first',
  'no-hint': 'This question has no hint',
  'nothing-to-undo': 'Nothing to undo',
  'no-teams-left': 'Every team has had its try',
  'already-running': 'The timer is already running',
  'not-running': 'The timer is not running',
  'no-timer': 'No timer right now',
  'no-players': 'This team has no players',
  'no-secret': 'Nothing to swap',
  'stale-turn': 'The turn already moved on',
  'no-save': 'No saved game',
  'not-now': 'Not available right now',
};

const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? MINUS : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
const signed = (n) => (n > 0 ? '+' + fmt(n) : n < 0 ? fmt(n) : '0');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
function names(list) {
  const a = list.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
/** "http://10.0.0.235:3000/" -> "10.0.0.235:3000" (what people type) */
function displayUrl(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }

const TAGLINES = {
  'Christmas Trivia': 'get it right or get robbed.',
  Dare: 'perform it for the room.',
  'Pop Culture': 'same rules, more celebrities.',
  'Hot Seat': 'one player, quick-fire questions.',
  'Christmas Movies': 'the classic Christmas films, quotes and all.',
  'Sound It Out': 'hum it. No words!',
  'Grinch Steal': 'rob a team that’s ahead.',
  Showdown: 'a head-to-head with a rival.',
  'Rapid List': 'shout answers, beat the clock.',
  'All Play': 'everybody types an answer.',
  'Double Down': 'spin again, double points.',
};

// Comedy (docs/design/COMEDY.md §4): a light stage direction for the suggested punchline.
const TONE_CUES = { cheer: '(big smile, arms up)', tease: '(with a wink)', drama: '(pause for effect)', pun: '(deadpan, then wait for the groan)' };
const KEY_CUES = {
  wrong: '(sad trombone face)', wrongEasy: '(slow head shake)', timeUp: '(tap your wrist)', nobodyBuzzed: '(cup a hand to your ear)',
  undo: '(mime pressing rewind)', voteClose: '(lean in)', finalZeroBet: '(raise one eyebrow)', finalIntro: '(dramatic whisper)',
  spinStart: '(follow the wheel with your finger)', podium: '(say it with feeling)', stealOpen: '(rub your hands together)',
};
const POINT_AT = new Set(['stealWon', 'grinchSteal', 'leadChange', 'bigComeback', 'correctHard', 'showdownWin', 'finalAllIn', 'hotseatPerfect', 'listBig', 'dareNailed', 'doubleDown']);
const WARMLY = new Set(['lastPlaceCheer', 'grinchGift', 'hotseatZero', 'dareFail', 'dareValiant', 'stealMissed', 'finalWrong']);
/** Playful nudges for the host, by quip moment. */
const KEY_TIPS = {
  wrongEasy: 'Missed an Easy one: a gentle roast is fair game. Tease the play, never the person.',
  stealWon: 'Give the room a beat to gasp before you move on.',
  grinchSteal: 'Boo the Grinch (affectionately), then move on.',
  dareFail: 'Lead a round of applause for the brave attempt.',
  dareValiant: 'Applause for the effort: it keeps the next performer brave.',
  leadChange: 'New leader: point at them. It fires everybody else up.',
  lastPlaceCheer: 'Pep-talk time: get the whole room cheering for the underdog.',
  roundBreak: 'Roast the leader gently, then give last place a pep talk.',
  bigComeback: 'Big climb! Make them stand up and take a bow.',
  finalAllIn: 'All in! Slow right down: wager, answer, pause, verdict.',
  undo: 'Own the undo: “The elves have reviewed the tape.”',
  nobodyBuzzed: 'Nobody buzzed: enjoy one second of silence, then move on.',
  voteClose: 'Too close to call: let the room shout their votes in.',
  hotseatPerfect: 'Perfect Hot Seat! A standing ovation is mandatory.',
};

// Turn progress tracker: the steps of each mini-game, keyed by challenge stage.
const FLOW = {
  trivia: [['Pick difficulty', ['pickDifficulty']], ['Answer & judge', ['question']], ['Steal, if they miss', ['steal']]],
  sounditout: [['Hum & guess', ['perform']], ['Steal, if they miss', ['steal']]],
  dare: [['Perform & judge', ['perform']], ['Room vote (optional)', ['vote']]],
  showdown: [['Pick a rival', ['pickRival']], ['Head to head', ['battle']]],
  rapidlist: [['Shout & tick', ['list']]],
  hotseat: [['Quick-fire questions', ['hotseat']]],
  allplay: [['Everyone types', ['answering']], ['Mark & reveal', ['marking']]],
  grinch: [['Pick a victim', ['pickTarget']]],
  doubledown: [['Spin again', ['spinAgain']]],
};

function buildCoach(game, pv, h) {
  const S = game.state;
  const out = { headline: '', say: null, steps: [], tips: [], actions: [], primary: null, progress: [], punchline: null };
  const teams = pv.teams;
  const T = (id) => teams.find((t) => t.id === id) || null;
  const tn = (id) => (T(id) ? T(id).name : 'a team');
  /** "<team> <verb>" with the verb agreeing ("The Grinches are", "Team Rudolph is"); pass the singular verb. */
  const tnv = (id, v) => subject(tn(id), v);
  /** Several names, or one plural team name, take a plural verb. */
  const many = (list) => list.length > 1 || (list.length === 1 && isPluralTeam(list[0]));
  const pname = (p) => (p && p.name ? p.name : 'Someone');
  const act = pv.activeTeamId;
  const c = pv.challenge;
  const ic = S.challenge;
  const timer = pv.timer;
  const mult = act && T(act) ? T(act).multiplier : 1;
  const A = (id, label, event, payload, kind, shortcut, more) => {
    out.actions.push({ id, label, event: event || null, payload: payload || null, kind: kind || 'secondary', shortcut: shortcut || null, ...(more || {}) });
  };
  const tip = (s) => { if (s) out.tips.push(s); };
  const playerOnline = (playerId) => { const p = pv.players.find((x) => x.id === playerId); return !!(p && p.connected); };

  const nextDetail = () => {
    if (pv.turnIndex + 1 < teams.length) return `${subject(teams[pv.turnIndex + 1].name, 'is')} up next`;
    if (pv.round < pv.totalRounds) return `Then the end of Round ${pv.round}`;
    return 'Then the Final Chaos finale';
  };
  const nextTurn = (kind) => A('nextTurn', 'Next turn', 'host:nextTurn', { turnId: pv.turnId }, kind || 'primary', 'N', { detail: nextDetail() });
  const skipChallenge = (what) => A('skip', `Skip ${what || 'this'}`, 'host:endChallenge', null, 'danger', null, { confirm: `Skip ${what || 'this'}? Nobody scores.` });
  const timerStart = (label) => {
    if (timer && !timer.started) A('timerStart', label || `Start ${Math.round(timer.durationMs / 1000)} s timer`, 'host:timer', { action: 'start' }, 'primary', 'T');
  };
  const timerStarted = () => !!(timer && timer.started);

  // ------------------------------------------------------------------ per phase
  switch (pv.phase) {
    case 'lobby': lobby(); break;
    case 'turnIntro': {
      const t = T(act);
      const nobody = t && t.connectedCount === 0;
      out.headline = `${tnv(act, 'is')} up${DASH}waiting for their spin`;
      out.say = (pv.round === 1 && pv.turnIndex === 0 ? 'Here we go! ' : '') + `${tn(act)}, you’re up! Spin from any of your phones.`;
      out.steps = [`Wait for someone on ${tn(act)} to tap SPIN`, 'Watch the wheel on the TV, then follow the directions here'];
      A('spinFor', `Spin for ${tn(act)}`, 'host:spin', null, nobody ? 'primary' : 'secondary', 'S');
      A('skipTurn', 'Skip this turn', 'host:nextTurn', { turnId: pv.turnId }, 'danger', null, { confirm: `Skip ${possessive(tn(act))} turn? They won’t spin this round.` });
      if (nobody) tip(`${tnv(act, 'has')} nobody online${DASH}spin for them, or move a player onto the team.`);
      if (pv.round === 1 && pv.turnIndex === 0) tip('First turn of the night: “Your team spins from your phone. Do what it lands on. Most points wins.”');
      break;
    }
    case 'spinning': {
      const by = pv.spin && pv.spin.by;
      out.headline = by ? `${by.name} spun the wheel${ELL}` : `The wheel is spinning${ELL}`;
      out.steps = ['Watch the TV: the wheel lands in a few seconds'];
      A('skipTurn', 'Skip this turn', 'host:nextTurn', { turnId: pv.turnId }, 'danger', null, { confirm: `Skip ${possessive(tn(act))} turn?` });
      break;
    }
    case 'challenge': challenge(); break;
    case 'turnResult': turnResult(); break;
    case 'roundBreak': roundBreak(); break;
    case 'finalIntro': {
      const F = h.final;
      out.headline = 'Final Chaos!';
      out.say = `It’s time for FINAL CHAOS! Tonight’s final category is${ELL} ${F ? F.categoryLabel : ''}! Every team: wager any amount up to your score${DASH}or up to 300 if you’re behind. Right answer wins it, wrong answer loses it.`;
      out.steps = ['Read the category out loud', 'Open the wagers'];
      A('openWagers', 'Open wagers', 'host:continue', null, 'primary', 'Enter', { detail: 'Phones show the wager slider' });
      A('swapFinal', 'Swap question', 'host:swapQuestion', null, 'secondary');
      tip('The question and answer are on your private card. The TV shows only the category for now.');
      break;
    }
    case 'finalWager': {
      const locked = pv.final ? pv.final.wagers.filter((w) => w.locked).length : 0;
      const missing = teams.length - locked;
      out.headline = `Teams are wagering${DASH}${locked} of ${teams.length} locked in`;
      out.say = 'Lock in your wager on any phone. The last lock-in counts!';
      out.steps = ['Wait for every team to lock in', 'Show the question'];
      A('showQuestion', 'Show the question', 'host:finalStartAnswering', null, 'primary', 'Enter', missing > 0
        ? { detail: `${plural(missing, 'team')} still wagering`, confirm: `${plural(missing, 'team')} ${missing === 1 ? 'hasn’t' : 'haven’t'} locked in${DASH}they will wager 0. Show the question?` }
        : { detail: 'Everyone is locked in' });
      A('swapFinal', 'Swap question', 'host:swapQuestion', null, 'secondary');
      tip('Wagers stay secret on the TV until the reveal.');
      break;
    }
    case 'finalAnswer': {
      const n = pv.final ? pv.final.submissions.filter((s) => s.answered).length : 0;
      const missing = teams.length - n;
      out.headline = `Final answers${DASH}${n} of ${teams.length} teams in`;
      out.say = `${pv.final && pv.final.question ? pv.final.question : ''}\nYou have 45 seconds${DASH}type your answer on any phone!`;
      out.steps = ['Read the question out loud', 'Wait for the answers', 'Start the reveal'];
      A('startReveal', 'Lock answers & start the reveal', 'host:continue', null, 'primary', 'Enter', missing > 0
        ? { detail: `${plural(missing, 'team')} still typing`, confirm: `${plural(missing, 'team')} ${missing === 1 ? 'has' : 'have'} no answer yet. Lock answers now?` }
        : { detail: 'Every team has answered' });
      break;
    }
    case 'finalReveal': finalReveal(); break;
    case 'podium': {
      const pd = pv.podium;
      const winners = pd ? pd.standings.filter((s) => s.place === 1).map((s) => tn(s.teamId)) : [];
      out.headline = winners.length ? `${names(winners)} ${many(winners) ? 'win' : 'wins'} Christmas!` : 'Game over';
      // the awards ceremony: drumroll, pause, name (the Lump of Coal comes last: it is the biggest laugh)
      const awards = pd ? pd.awards.map((a) => `The ${a.title}${/award/i.test(a.title) ? '' : ' award'} goes to${ELL} ${a.name}!${a.detail ? ' (' + a.detail + ')' : ''}`) : [];
      const q = pv.quip && pv.quip.key === 'podium' ? pv.quip : null;
      if (q) { out.punchline = { id: q.id, key: q.key, text: q.text, cue: cueFor(q) }; }
      out.say = winners.length
        ? [`Congratulations, ${names(winners)}!`, ...(q ? [`${out.punchline.cue} “${q.text}”`] : []), ...(awards.length ? ['Now, the awards!', ...awards] : []), 'Thanks for playing, and Merry Christmas!'].join('\n')
        : null;
      out.steps = ['Read out the winners and the awards', 'Play again, or call it a night'];
      if (awards.length) tip(`Read the awards slowly: drumroll, pause, then the name${pd.awards.some((a) => a.key === 'lumpOfCoal') ? '. The Lump of Coal goes last: it is the biggest laugh' : ''}.`);
      A('playAgain', 'Play again (same teams)', 'host:resetGame', { keepTeams: true }, 'primary', null, { confirm: 'Start a new game with the same teams and players? Scores go back to 0. No question repeats.' });
      A('newTeams', 'New game, new teams', 'host:resetGame', { keepTeams: false }, 'danger', null, { confirm: 'Start over with new teams? Everyone picks a team again.' });
      break;
    }
    default:
      out.headline = '';
  }

  // ------------------------------------------------------------------ comedy: the TV quip as a suggested punchline
  punchline();

  // ------------------------------------------------------------------ shared tips
  if (act && mult > 1 && ['challenge', 'turnResult', 'spinning'].includes(pv.phase)) tip(`Double Down active: ${possessive(tn(act))} points are ×2 this turn.`);
  if (h && h.canUndo && h.undoLabel && ['turnResult', 'roundBreak', 'finalReveal', 'podium'].includes(pv.phase)) tip(`Last change: ${h.undoLabel}. Wrong? Press Undo (U).`);
  out.progress = progress();

  // ------------------------------------------------------------------ validate every action against the server rules
  for (const a of out.actions) {
    if (!a.event || a.disabled) continue;
    // server-level events (handled by server.js, not the game engine): live exactly while a save is on offer
    if (SERVER_EVENTS.has(a.event)) {
      if (!pv.savedGame) { a.disabled = true; a.reason = a.reason || REASONS['no-save']; }
      continue;
    }
    const r = game.check(HOST, a.event, a.payload || {});
    if (!r.ok) { a.disabled = true; a.reason = a.reason || REASONS[r.error] || r.error; }
  }
  const firstPrimary = out.actions.find((a) => a.kind === 'primary' && !a.disabled);
  const designated = out.primary ? out.actions.find((a) => a.id === out.primary && !a.disabled) : null;
  out.primary = designated ? designated.id : firstPrimary ? firstPrimary.id : null;
  return out;

  // ================================================================== sections
  function cueFor(q) {
    if (q.teamId && POINT_AT.has(q.key)) return `(point at ${tn(q.teamId)})`;
    if (q.teamId && WARMLY.has(q.key)) return `(warmly, to ${tn(q.teamId)})`;
    return KEY_CUES[q.key] || TONE_CUES[q.tone] || '(say it with feeling)';
  }
  /** Append the TV quip (public text) as a suggested punchline with a stage direction, plus a playful tip. */
  function punchline() {
    const q = pv.quip;
    if (!q || !q.text) return;
    if (!out.punchline) {
      out.punchline = { id: q.id, key: q.key, text: q.text, cue: cueFor(q) };
      out.say = (out.say ? out.say + '\n' : '') + `${out.punchline.cue} “${q.text}”`;
    }
    if (KEY_TIPS[q.key]) tip(KEY_TIPS[q.key]);
  }

  function lobby() {
    const addr = displayUrl(pv.joinUrl);
    if (pv.savedGame) {
      const sg = pv.savedGame.summary || {};
      out.headline = 'A saved game was found';
      out.steps = [`Resume Round ${sg.round || '?'} of ${sg.totalRounds || '?'} (${plural((sg.teams || []).length, 'team')}), or start fresh`];
      A('resume', 'Resume saved game', 'host:resume', null, 'primary', 'Enter', { detail: (sg.teams || []).map((t) => `${t.name} ${fmt(t.score)}`).join(' · ') });
      A('discardSave', 'Start fresh', 'host:discardSave', null, 'danger', null, { confirm: 'Throw away the saved game? This cannot be undone.' });
      tip('Phones rejoin the saved game automatically when you resume.');
      return;
    }
    const joined = pv.players.length;
    const empty = teams.filter((t) => !t.playerCount);
    const unassigned = pv.players.filter((p) => !p.teamId).length;
    out.headline = teams.length < 2 ? 'Set up the teams' : joined ? `Waiting for players${DASH}${joined} joined` : 'Waiting for players to join';
    out.say = `Grab your phones! Scan the code on the TV, type your name and pick a team. Can’t scan? Type ${addr} into your browser.`;
    out.steps = [
      teams.length >= 2 ? `Make the teams${DASH}done, ${teams.length} teams ready` : 'Make the teams: add at least 2 (4 to 6 plays best)',
      empty.length ? `Check everyone’s on a team${DASH}${names(empty.map((t) => t.name))} ${many(empty.map((t) => t.name)) ? 'are' : 'is'} still empty` : 'Check everyone’s on a team',
      'Read the opening script, then press Start',
    ];
    const startMore = teams.length ? { detail: `Round 1 opens with ${teams[0].name} at the wheel` } : {};
    if (empty.length && teams.length >= 2) startMore.confirm = `${names(empty.map((t) => t.name))} ${many(empty.map((t) => t.name)) ? 'have' : 'has'} no players yet. Start anyway?`;
    A('start', 'Start game', 'host:start', null, 'primary', 'S', startMore);
    A('introScript', 'Read the opening script', null, null, 'secondary', null, { local: 'introScript', detail: '60-second welcome' });
    A('soundTest', 'Play test sound', 'host:soundTest', null, 'secondary', null, { detail: 'Plays a jingle on the TV' });
    for (const t of empty) tip(`${subject(t.name, 'has')} no players yet. Ask someone to switch, or remove the team.`);
    if (unassigned) tip(`${plural(unassigned, 'player')} ${unassigned === 1 ? 'hasn’t' : 'haven’t'} picked a team yet.`);
    if (h && h.connections && !h.connections.tv) tip('The TV screen isn’t open yet, so nobody can see the join code. Open /tv on the TV.');
    if (!joined) tip('Phones must be on the same Wi-Fi as this laptop (not a guest network).');
    if (h && h.contentProblems && h.contentProblems.length) tip(`${plural(h.contentProblems.length, 'content problem')} found${DASH}bad items are skipped (see the content list).`);
  }

  function challenge() {
    if (!c) return;
    const segLabel = c.segmentIndex != null && pv.segments[c.segmentIndex] ? pv.segments[c.segmentIndex].label : 'Bonus';
    switch (c.type) {
      case 'trivia': return trivia(segLabel);
      case 'sounditout': return soundItOut();
      case 'dare': return dare();
      case 'showdown': return showdown();
      case 'rapidlist': return rapidList();
      case 'hotseat': return hotSeat();
      case 'allplay': return allPlay(false);
      case 'grinch': return grinch();
      case 'doubledown': {
        out.headline = `Double Down! ${tnv(act, 'spins')} again`;
        out.say = `Double Down! ${tn(act)}, spin again${DASH}everything you win this turn is doubled!`;
        out.steps = [`Wait for ${tn(act)} to spin again`];
        A('spinFor', `Spin for ${tn(act)}`, 'host:spin', null, 'secondary', 'S');
        return undefined;
      }
      default: return undefined;
    }
  }

  function trivia(label) {
    const pts = c.points * mult;
    if (c.stage === 'pickDifficulty') {
      out.headline = `${tnv(act, 'is')} picking a difficulty`;
      out.say = c.firstTime
        ? `${label}! ${tn(act)}, pick Easy for 100, Medium for 200 or Hard for 300, then answer out loud in 20 seconds. Miss it, and the other teams can steal half.`
        : `${label}! ${tn(act)}: Easy for 100, Medium for 200, or Hard for 300?`;
      out.steps = [`Let ${tn(act)} pick on their phones`, 'Stuck? Pick for them'];
      [['easy', 100, '1'], ['medium', 200, '2'], ['hard', 300, '3']].forEach(([level, p, key]) => A('pick-' + level, `${cap(level)} · ${p * mult}`, 'host:pickDifficulty', { level }, 'secondary', key));
      if (c.firstTime) tip(`First ${label} of the night${DASH}explain the steal: a miss lets the other teams buzz in for half.`);
      return;
    }
    if (c.stage === 'question') {
      out.headline = `${tnv(act, 'is')} answering (${cap(c.difficulty)} · ${fmt(pts)})`;
      out.say = `${c.question}\n${tn(act)}${DASH}20 seconds, go!`;
      out.steps = ['Read the question out loud', 'Listen for one answer (it’s on your private card)', 'Tap Correct or Wrong'];
      A('correct', `Correct +${fmt(pts)}`, 'host:judge', { result: 'correct' }, 'success', 'C', { detail: `Points fly to ${tn(act)}` });
      A('wrong', 'Wrong', 'host:judge', { result: 'wrong' }, 'danger', 'W', { detail: `Steal for ${fmt(c.stealPoints)} comes next` });
      A('hint', 'Show hint', 'host:showHint', null, 'secondary', 'H', { detail: 'Halves the points' });
      A('reveal', 'Reveal answer', 'host:reveal', null, 'secondary', 'R', { detail: 'Ends it, no points', confirm: 'Reveal the answer on the TV? Nobody scores.' });
      A('swap', 'Swap question', 'host:swapQuestion', null, 'secondary');
      out.primary = 'correct';
      tip(`Wrong opens a steal${DASH}the other teams can buzz in for ${fmt(c.stealPoints)}.`);
      if (c.hint) tip(`Hint is on the TV${DASH}this question is now worth ${fmt(pts)}.`);
      if (c.movie) tip(`From ${c.movie}${c.movieYear ? ' (' + c.movieYear + ')' : ''}${DASH}the TV shows the film title.`);
      return;
    }
    if (c.stage === 'steal') steal(label);
  }

  function steal(label) {
    const b = c.buzz;
    const sp = fmt(c.stealPoints);
    if (b.winner) {
      out.headline = `${b.winner.name} (${tn(b.winner.teamId)}) buzzed first`;
      out.say = `${b.winner.name}, your answer?`;
      out.steps = ['Listen to their answer', 'Tap Correct or Wrong'];
      A('correct', `Correct +${sp}`, 'host:judge', { result: 'correct' }, 'success', 'C', { detail: `${tnv(b.winner.teamId, 'steals')} it` });
      A('wrong', 'Wrong', 'host:judge', { result: 'wrong' }, 'danger', 'W', { detail: `Locks out ${tn(b.winner.teamId)}` });
      out.primary = 'correct';
      return;
    }
    if (b.armingUntil) {
      out.headline = 'Steal! Buzzers arm in 3 seconds';
      out.say = `${b.lockedTeamIds.length ? 'Still up for grabs' : 'No luck'}! Other teams${DASH}get ready to steal for ${sp}${ELL} buzzers are armed${ELL} now!`;
      out.steps = ['Wait for the buzzers to arm', 'Listen to whoever buzzes first', 'Tap Correct or Wrong'];
      A('reveal', 'Reveal answer', 'host:reveal', null, 'secondary', 'R', { detail: 'Ends it, no points', confirm: 'Reveal the answer? Nobody scores.' });
      return;
    }
    if (b.open) {
      out.headline = `Steal is open${DASH}waiting for a buzz`;
      out.say = `Other teams${DASH}buzz in to steal for ${sp}!`;
      out.steps = ['Wait for a buzz', 'Listen to whoever buzzes first', 'Tap Correct or Wrong'];
      A('reveal', 'Reveal answer', 'host:reveal', null, 'secondary', 'R', { detail: 'Nobody knows? End it', confirm: 'Reveal the answer? Nobody scores.' });
      tip(`Still eligible: ${names(b.eligibleTeamIds.map(tn))}.`);
      return;
    }
    const locked = b.lockedTeamIds.length ? b.lockedTeamIds[b.lockedTeamIds.length - 1] : null;
    out.headline = locked ? `Wrong steal${DASH}${tnv(locked, 'is')} locked out` : 'Steal closed';
    out.say = null;
    out.steps = ['Reopen the steal for the teams that are left, or reveal the answer'];
    A('reopen', 'Reopen the steal', 'host:openSteal', null, 'primary', 'O', { detail: `For ${names(teams.filter((t) => t.id !== act && !b.lockedTeamIds.includes(t.id)).map((t) => t.name))}` });
    A('reveal', 'Reveal answer', 'host:reveal', null, 'secondary', 'R', { detail: 'Ends it, no points' });
    tip('Each team gets one try at the steal.');
    void label;
  }

  function soundItOut() {
    const p = c.performer;
    if (c.stage === 'steal') return steal('Sound It Out');
    out.headline = p ? `${p.name} is humming for ${tn(act)}` : `${tnv(act, 'has')} no players for Sound It Out`;
    out.say = !timerStarted()
      ? `${pname(p)}, your song is on your phone${DASH}press and hold to peek. Hum or whistle it, no words! ${tn(act)}, you’ll have 30 seconds to name that tune.`
      : `${tn(act)}${DASH}name that tune!`;
    out.steps = [`Make sure ${pname(p)} has peeked at the song${h && h.secretPeeked ? ' (done)' : ''}`, 'Start the timer', 'Tap Correct or Wrong'];
    timerStart();
    A('correct', `Correct +${fmt(c.points * mult)}`, 'host:judge', { result: 'correct' }, 'success', 'C');
    A('wrong', 'Wrong', 'host:judge', { result: 'wrong' }, 'danger', 'W', { detail: `Steal for ${fmt(c.stealPoints)} comes next` });
    A('reroll', 'Re-roll performer', 'host:rerollPerformer', null, 'secondary', 'P');
    A('hint', 'Show hint', 'host:showHint', null, 'secondary', 'H', { detail: 'Halves the points' });
    A('swapSong', 'Swap song', 'host:swapSecret', null, 'secondary', null, { detail: `Keeps ${pname(p)} as the performer` });
    skipChallenge('Sound It Out');
    if (timerStarted()) out.primary = 'correct';
    if (p && !playerOnline(p.playerId)) tip(`${p.name}’s phone is offline${DASH}re-roll the performer.`);
    if (c.firstTime) tip('First Sound It Out: only the performer sees the song. No words allowed!');
    if (h && h.secretPeeked) tip(`${pname(p)} has peeked at the song.`);
  }

  function dare() {
    const d = c.dare;
    const who = names([c.performer, c.partner].filter(Boolean).map((x) => x.name)) || tn(act);
    const whoMany = c.performer ? !!c.partner : isPluralTeam(tn(act)); // two performers, or a plural team name
    if (c.stage === 'vote') {
      const v = c.vote;
      out.headline = `The room is voting on the dare (${v.voters} of ${v.eligible})`;
      out.say = `Everyone else${DASH}vote on your phones: Nailed it, or Good try!`;
      out.steps = ['Votes close after 15 seconds, or when everyone has voted', 'Majority wins (Good try pays as Valiant effort); you can still override'];
      A('closeVote', 'Close the vote now', 'host:closeVote', null, 'primary', 'V', { detail: `Nailed it ${v.nailed} · Good try ${v.good}` });
      darePicks('Override: ');
      tip(`${tn(act)} can’t vote on their own dare.`);
      if (!v.eligible) tip('Nobody else is online to vote. Judge it yourself.');
      return;
    }
    const teamDare = d.who === 'team' || d.who === 'everyone';
    out.headline = teamDare
      ? `Dare: ${d.title}${DASH}${d.who === 'everyone' ? 'everyone plays' : tnv(act, 'performs')}${d.hasSecret && c.performer ? ` (${c.performer.name} has the secret)` : ''}`
      : `Dare: ${d.title}${DASH}${who} ${whoMany ? 'perform' : 'performs'}`;
    const lead = teamDare
      ? `${tn(act)}${d.hasSecret && c.performer ? `, ${c.performer.name} has the secret on their phone` : ''}: `
      : `${who}${d.hasSecret ? ', your secret is on your phone. Press and hold to peek. ' : ': '}`;
    out.say = lead + d.instructions;
    out.steps = [`Wait until ${who} ${whoMany ? 'are' : 'is'} ready`, `Start the ${d.time} s timer`, 'Judge it yourself, or let the room vote'];
    timerStart(`Start ${d.time} s timer`);
    const locked = !timerStarted();
    darePicks('', locked);
    A('vote', 'Let the room vote', 'host:openVote', null, 'secondary', 'V', locked ? { disabled: true, reason: 'Unlocks when the timer starts' } : { detail: 'Other teams vote for 15 s' });
    A('reroll', 'Re-roll performer', 'host:rerollPerformer', null, 'secondary', 'P');
    if (d.hasSecret) A('swapSecret', 'Swap secret', 'host:swapSecret', null, 'secondary', null, { detail: `Use it if ${pname(c.performer)} doesn’t know this one` });
    A('swapDare', 'Swap dare', 'host:swapQuestion', null, 'secondary', null, { detail: `Keeps ${pname(c.performer)} as the performer` });
    skipChallenge('dare');
    if (!locked) out.primary = 'nailed';
    if (c.firstTime) tip('First dare of the night: keep it moving!');
    if (d.props && d.props.length) tip(`Props: ${d.props.join(', ')}.`);
    if (d.judge) tip(`How to judge: ${d.judge}`);
    if (c.performer && !playerOnline(c.performer.playerId) && d.hasSecret) tip(`${c.performer.name}’s phone is offline, so they can’t see the secret. Re-roll the performer.`);
    if (d.hasSecret && h && h.secretPeeked) tip(`${pname(c.performer)} has peeked at the secret.`);
  }
  function darePicks(prefix, locked) {
    const lockMore = locked ? { disabled: true, reason: 'Unlocks when the timer starts' } : {};
    A('nailed', `${prefix}Nailed it +${fmt(200 * mult)}`, 'host:dareResult', { result: 'nailed' }, 'success', '1', lockMore);
    A('valiant', `${prefix}Valiant effort +${fmt(100 * mult)}`, 'host:dareResult', { result: 'valiant' }, 'secondary', '2', lockMore);
    A('fail', `${prefix}Not this time`, 'host:dareResult', { result: 'fail' }, 'secondary', '3', { detail: '0 points', ...lockMore });
  }

  function showdown() {
    if (c.stage === 'pickRival') {
      out.headline = `${tnv(act, 'is')} picking a rival`;
      out.say = c.firstTime
        ? `Showdown! ${tn(act)}, pick a team to challenge. One player from each team goes head to head${DASH}winner takes 200.`
        : `Showdown! ${tn(act)}, pick your rival on your phones.`;
      out.steps = [`Let ${tn(act)} pick a rival team on their phones`, 'Or pick for them'];
      for (const id of c.targets) A('rival-' + id, `Pick ${tn(id)}`, 'host:pickTarget', { teamId: id }, 'secondary');
      if (c.eyeing) tip(`${c.eyeing.by.name} is eyeing ${tn(c.eyeing.teamId)}${ELL}`);
      return;
    }
    const s = c.showdown;
    const a = pname(c.performer);
    const b = c.rival ? pname(c.rival) : 'someone';
    const rivalTeam = c.rival ? c.rival.teamId : null;
    out.headline = `Showdown: ${a} vs ${b}`;
    out.say = `${a} and ${b}${DASH}get to the front! ${s.title}: ${s.instructions}`;
    out.steps = ['Get both players to the front', `Start the ${s.time} s timer`, 'Tap the winner, or Tie'];
    timerStart(`Start ${s.time} s timer`);
    A('winActive', `${tnv(act, 'wins')} +${fmt(200 * mult)}`, 'host:showdownResult', { winner: 'active' }, 'success', '1', { detail: a });
    A('winRival', `${tnv(rivalTeam, 'wins')} +200`, 'host:showdownResult', { winner: 'rival' }, 'success', '2', { detail: b });
    A('tie', 'Tie', 'host:showdownResult', { winner: 'tie' }, 'secondary', '3', { detail: '+100 each' });
    A('reroll', 'Re-roll players', 'host:rerollPerformer', null, 'secondary', 'P');
    A('swap', 'Swap challenge', 'host:swapQuestion', null, 'secondary');
    skipChallenge('showdown');
    if (s.winner) tip(`How to win: ${s.winner}`);
    if (s.props && s.props.length) tip(`Props: ${s.props.join(', ')}.`);
    if (c.firstTime) tip('First Showdown: winner takes 200, a tie is 100 each.');
  }

  function rapidList() {
    const l = c.list;
    const pts = Math.min(l.count, l.max) * l.each * mult;
    out.headline = `Rapid List${DASH}${tnv(act, 'has')} 30 seconds`;
    out.say = timerStarted() ? null : `${l.prompt}! 30 seconds${ELL} go!`;
    out.steps = ['Start the timer', 'Tap each valid answer you hear', 'Award when time’s up'];
    timerStart();
    A('award', `Done${DASH}award ${fmt(pts)}`, 'host:continue', null, timerStarted() ? 'primary' : 'secondary', 'Enter', { detail: `${l.count} of ${l.max} ticked` });
    A('other', 'Other valid answer', 'host:listOther', null, 'secondary', 'O', { detail: 'Counts as one more' });
    A('swap', 'Swap prompt', 'host:swapQuestion', null, 'secondary');
    tip(`Repeats don’t count. Up to ${l.max} answers count (${fmt(l.max * l.each)} max). The TV shows every tick.`);
    if (h && h.listNote) tip(h.listNote);
    if (c.firstTime) tip('First Rapid List: explain it! Shout as many answers as you can.');
  }

  function hotSeat() {
    const hs = c.hotseat;
    const p = c.performer;
    const started = timerStarted();
    out.headline = started ? `Hot Seat${DASH}${pname(p)}, question ${Math.min(hs.index + 1, hs.total)} of ${hs.total}` : `${pname(p)} is in the Hot Seat`;
    out.say = started && h && h.hotseatQuestion ? h.hotseatQuestion
      : `${pname(p)}, you’re in the Hot Seat! Up to ${hs.total} quick questions in 45 seconds, ${hs.each} points each. Say “pass” to skip. Teammates, no helping!`;
    out.steps = ['Start the clock', 'Read each question; tap Correct, Wrong or Pass', `It ends after question ${hs.total} or when time runs out`];
    timerStart('Start the clock');
    const idx = { index: hs.index };
    A('correct', `Correct +${fmt(hs.each * mult)}`, 'host:hotseatMark', { result: 'correct', ...idx }, 'success', 'C');
    A('wrong', 'Wrong', 'host:hotseatMark', { result: 'wrong', ...idx }, 'danger', 'W');
    A('pass', 'Pass', 'host:hotseatMark', { result: 'pass', ...idx }, 'secondary', 'P');
    A('reroll', 'Re-roll player', 'host:rerollPerformer', null, 'secondary', null);
    A('swap', 'Swap question', 'host:swapQuestion', null, 'secondary');
    A('end', 'End the Hot Seat', 'host:continue', null, 'secondary', null, { detail: `Banks ${fmt(hs.banked)}` });
    if (started) out.primary = 'correct';
    tip('Your first mark starts the clock if you forget.');
    if (c.firstTime) tip('First Hot Seat: one player, alone, no help from the team.');
  }

  function allPlay(isBonus) {
    const subs = c.submissions || [];
    const n = subs.filter((s) => s.answered).length;
    if (c.stage === 'answering') {
      out.headline = `${isBonus ? 'Bonus question' : 'All Play'}${DASH}${n} of ${teams.length} teams answered`;
      out.say = c.firstTime && !isBonus
        ? `ALL PLAY! Every team, type your answer on any phone: 100 for each right answer, 50 extra for the first. ${c.question}`
        : `${isBonus ? 'Bonus question for every team! ' : 'All Play! '}${c.question}\nType it in${DASH}20 seconds!`;
      out.steps = ['Read the question out loud', 'Wait for every team to type an answer', 'Check the auto-marks, then reveal'];
      A('lock', 'Lock answers now', 'host:continue', null, 'secondary', null, { detail: n < teams.length ? `${plural(teams.length - n, 'team')} still typing` : 'Everyone has answered' });
      A('swap', 'Swap question', 'host:swapQuestion', null, 'secondary', null, { detail: 'Clears every answer' });
      tip('The last answer from each team counts.');
      return;
    }
    if (c.stage === 'marking') {
      const close = (h.submissions || []).filter((s) => s.match === 'close' && s.override == null);
      out.headline = close.length ? `Check ${names(close.map((s) => tn(s.teamId)))}, then reveal` : 'Answers are in: check the marks, then reveal';
      out.steps = ['Flip any auto-mark you disagree with (Accept / Reject)', 'Reveal all answers on the TV'];
      A('revealAll', 'Reveal all answers on TV', 'host:revealAnswers', null, 'primary', 'R', { detail: `Pays out ${fmt(h.payout || 0)}` });
      for (const s of close) tip(`${possessive(tn(s.teamId))} “${s.text}” is a close spelling${DASH}accepted for now. Check it.`);
      tip('Revealing locks every phone.');
      return;
    }
    if (c.stage === 'done' && isBonus) {
      const rb = pv.roundBreak;
      const right = subs.filter((s) => s.correct).length;
      out.headline = `Bonus: ${right} of ${teams.length} teams got it`;
      out.say = `The answer: ${c.answer}.${c.funFact ? ' ' + c.funFact : ''}`;
      out.steps = ['Points are on the scoreboard', rb ? `Start Round ${rb.nextRound}` : 'Continue'];
      A('nextRound', rb ? `Start Round ${rb.nextRound}${rb.finalNext ? DASH + 'the final round' : ''}` : 'Continue', 'host:continue', null, 'primary', 'Enter');
    }
  }

  function grinch() {
    out.headline = `Grinch Steal${DASH}${tnv(act, 'is')} picking a victim`;
    out.say = `Grinch Steal! ${tn(act)}, pick a team that’s ahead of you and steal up to ${fmt(c.points)} points!`;
    out.steps = [`Let ${tn(act)} pick on their phones`, 'Or pick for them'];
    for (const id of c.targets || []) {
      const amount = Math.min(c.points, T(id) ? T(id).score : 0);
      A('steal-' + id, `Steal from ${tn(id)}`, 'host:pickTarget', { teamId: id }, 'secondary', null, { detail: `${fmt(amount)} points` });
    }
    if (c.eyeing) tip(`${c.eyeing.by.name} is eyeing ${tn(c.eyeing.teamId)}${ELL}`);
    if (c.firstTime) tip('First Grinch Steal: only teams ahead of them can be robbed.');
  }

  function turnResult() {
    if (!c) { nextTurn(); return; }
    const res = c.result || { kind: 'skipped', awards: [] };
    const gain = (id) => (res.awards.find((a) => a.teamId === id) || { delta: 0 }).delta;
    const winnerTeam = c.buzz && c.buzz.winner ? c.buzz.winner.teamId : null;
    switch (res.kind) {
      case 'correct': out.headline = `${tn(act)} got it! ${signed(gain(act))}`; break;
      case 'stolen': out.headline = `${tn(winnerTeam)} stole it! ${signed(gain(winnerTeam))}`; break;
      case 'missed': out.headline = 'Nobody got it'; break;
      case 'skipped': out.headline = 'Skipped: no points'; break;
      case 'nailed': out.headline = `${tn(act)} nailed the dare! ${signed(gain(act))}`; break;
      case 'valiant': out.headline = `Valiant effort! ${signed(gain(act))}`; break;
      case 'fail': out.headline = 'Not this time'; break;
      case 'win': { const w = c.winnerSide === 'rival' && c.rival ? c.rival.teamId : act; out.headline = `${tnv(w, 'wins')} the showdown! ${signed(gain(w))}`; break; }
      case 'tie': out.headline = 'A tie! 100 each'; break;
      case 'list': out.headline = `Rapid List: ${plural(c.list.count, 'answer')}${DASH}${signed(gain(act))}`; break;
      case 'hotseat': out.headline = `Hot Seat: ${c.hotseat.results.filter((r) => r === 'correct').length} right${DASH}${signed(gain(act))}`; break;
      case 'allplay': out.headline = `All Play: ${(c.submissions || []).filter((s) => s.correct).length} of ${teams.length} teams got it`; break;
      case 'steal': out.headline = c.steal ? `${tn(c.steal.to)} stole ${fmt(c.steal.amount)} from ${tn(c.steal.from)}!` : 'Grinch Steal!'; break;
      case 'gift': out.headline = `${possessive(tn(act))} heart grew three sizes!`; break;
      default: out.headline = 'Turn over';
    }
    // what to read out loud (everything here is public by now)
    if (c.type === 'trivia' && c.answer) out.say = `The answer: ${c.answer}.${c.funFact ? ' ' + c.funFact : ''}`;
    else if (c.type === 'sounditout' && c.answer) out.say = `It was “${c.answer}”${c.artist ? ' by ' + c.artist : ''}.`;
    else if (c.type === 'allplay' && c.answer) out.say = `The answer: ${c.answer}.${c.funFact ? ' ' + c.funFact : ''}`;
    else if (c.type === 'dare' && c.answer) out.say = `The secret was: ${c.answer}.`;
    else if (c.type === 'grinch' && c.gift) out.say = `${tnv(act, 'is')} in the lead, so the Grinch’s heart grew three sizes${DASH}they gift ${fmt(c.gift.amount)} to ${tn(c.gift.toTeamId)}!`;
    else if (c.type === 'grinch' && c.steal) out.say = `${tnv(c.steal.to, 'steals')} ${fmt(c.steal.amount)} points from ${tn(c.steal.from)}!`;
    out.steps = ['Points are on the scoreboard (fix anything with ± or Undo)', 'Press Next turn when the room is ready'];
    nextTurn();
    if (c.type === 'dare' && c.dareResult) {
      const r = c.dareResult;
      A('crowd', r.bonus ? 'Remove crowd favourite' : '+50 crowd favourite', 'host:dareResult', { result: r.result, bonus: !r.bonus }, 'secondary', 'F', { detail: r.bonus ? `${MINUS}50` : 'Room went wild? Add it on top' });
      for (const [k, label] of [['nailed', 'Nailed it'], ['valiant', 'Valiant effort'], ['fail', 'Not this time']]) {
        if (k !== r.result) A('change-' + k, `Change to ${label}`, 'host:dareResult', { result: k }, 'secondary');
      }
    }
    if (c.type === 'rapidlist') A('other', 'Other valid answer', 'host:listOther', null, 'secondary', 'O', { detail: 'Missed one? Ticks still count' });
  }

  function roundBreak() {
    const rb = pv.roundBreak;
    if (!rb) return;
    if (c && c.type === 'bonus') { allPlay(true); return; }
    const top = rb.standings.filter((s) => s.rank === 1).map((s) => tn(s.teamId));
    const leadScore = rb.standings.length ? rb.standings[0].score : 0;
    const bonusNext = rb.bonusPlanned && !rb.bonusDone;
    out.headline = `End of Round ${rb.round}`;
    const nextLine = rb.finalNext ? `Round ${rb.nextRound}${DASH}the final round!` : `Round ${rb.nextRound} starts now.`;
    out.say = `That’s the end of Round ${rb.round}! ${names(top)} ${many(top) ? 'lead' : 'leads'} with ${fmt(leadScore)}${top.length === 1 && rb.leadBy > 0 ? `, ${fmt(rb.leadBy)} ahead` : ''}. `
      + (bonusNext ? 'But first: a bonus question for every team!' : nextLine);
    out.steps = ['Read out the standings', bonusNext ? 'Start the bonus question' : `Start Round ${rb.nextRound}`];
    if (bonusNext) {
      A('bonus', 'Start the bonus question', 'host:continue', null, 'primary', 'Enter', { detail: '100 for every team that gets it' });
      A('skipBonus', 'Skip bonus questions', 'host:setOption', { key: 'roundBonus', value: false }, 'secondary');
    } else {
      A('nextRound', `Start Round ${rb.nextRound}${rb.finalNext ? DASH + 'the final round' : ''}`, 'host:continue', null, 'primary', 'Enter', { detail: teams[0] ? `${subject(teams[0].name, 'spins')} first` : '' });
    }
  }

  function finalReveal() {
    const F = h.final;
    if (!F) return;
    const rows = F.rows;
    const k = rows.filter((r) => r.revealed).length;
    const cur = F.current ? rows.find((r) => r.teamId === F.current) : null;
    if (cur && !cur.judged) {
      out.headline = `Final reveal${DASH}${tn(cur.teamId)} (${k} of ${rows.length})`;
      out.say = `${tn(cur.teamId)} wagered${ELL} ${fmt(cur.wager)} points. Their answer: “${cur.text || 'nothing'}”${ELL} that is${ELL} ${cur.correct ? 'CORRECT!' : 'WRONG!'}`;
      const how = cur.override != null ? 'you marked it' : cur.match === 'exact' ? 'exact match' : cur.match === 'match' ? 'matches the answer' : cur.match === 'close' ? 'close spelling' : 'no match';
      out.steps = ['Read the answer out loud', `It’s marked ${cur.correct ? 'correct' : 'wrong'} (${how}). Disagree? Accept or Reject`, 'Then reveal the next team'];
      A('confirm', `Confirm: ${cur.correct ? 'correct' : 'wrong'} ${cur.correct ? '+' : MINUS}${fmt(cur.wager)}`, 'host:finalRevealNext', null, 'primary', 'N');
      A('accept', `Accept +${fmt(cur.wager)}`, 'host:markAnswer', { teamId: cur.teamId, correct: true }, 'success', 'A');
      A('reject', `Reject ${MINUS}${fmt(cur.wager)}`, 'host:markAnswer', { teamId: cur.teamId, correct: false }, 'danger', 'X');
      if (cur.match === 'close') tip(`“${cur.text}” is a close spelling of the answer${DASH}accepted unless you reject it.`);
      return;
    }
    const next = rows.find((r) => !r.revealed);
    out.headline = next ? `Final reveal${DASH}${k} of ${rows.length} revealed` : 'Every answer is in!';
    out.say = next ? (k === 0 ? `Let’s see those answers, lowest score first. ${tn(next.teamId)}${ELL}` : `Next up: ${tn(next.teamId)}${ELL}`) : `And the winner of Christmas Chaos is${ELL}`;
    out.steps = next ? [`Reveal ${tn(next.teamId)} on the TV`, 'Read their wager and answer', 'Mark it'] : ['Show the podium'];
    A('revealNext', next ? `Reveal ${tn(next.teamId)}` : 'Show the podium', 'host:finalRevealNext', null, 'primary', 'N', next ? { detail: `${fmt(next.wager)} riding on it` } : {});
    if (cur && cur.judged) A('flip', `Change ${tn(cur.teamId)} to ${cur.correct ? 'wrong' : 'correct'}`, 'host:markAnswer', { teamId: cur.teamId, correct: !cur.correct }, 'secondary');
    tip('The correct answer is on your private card.');
  }

  function progress() {
    const phase = pv.phase;
    if (['finalIntro', 'finalWager', 'finalAnswer', 'finalReveal'].includes(phase)) {
      const idx = { finalIntro: 0, finalWager: 0, finalAnswer: 1, finalReveal: 2 }[phase];
      return ['Wager', 'Answer', 'Reveal'].map((label, i) => ({ label, state: i < idx ? 'done' : i === idx ? 'current' : 'todo' }));
    }
    if (!['turnIntro', 'spinning', 'challenge', 'turnResult'].includes(phase)) return [];
    const steps = [{ label: phase === 'turnIntro' || phase === 'spinning' ? 'Spin' : `Spun ${c && c.segmentIndex != null ? pv.segments[c.segmentIndex].label : ''}`, state: phase === 'turnIntro' || phase === 'spinning' ? 'current' : 'done' }];
    const flow = c && FLOW[c.type] ? FLOW[c.type] : [['Play it', []]];
    const curIdx = phase === 'challenge' && c ? flow.findIndex(([, stages]) => stages.includes(c.stage)) : -1;
    flow.forEach(([label], i) => {
      let state = 'todo';
      if (phase === 'turnResult') state = 'done';
      else if (phase === 'challenge') state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo';
      const step = { label, state };
      if (c && c.type === 'trivia' && i === 0 && c.difficulty) step.detail = `${cap(c.difficulty)} · ${c.points}`;
      steps.push(step);
    });
    steps.push({ label: 'Next turn', state: phase === 'turnResult' ? 'current' : 'todo' });
    return steps;
  }
}

/** The 60-second "Read this to the room" welcome script (lobby). Parts: say = read it, em = read it big, cue = stage direction. */
function buildIntroScript(game, pv) {
  const addr = displayUrl(pv.joinUrl);
  const say = (text) => ({ kind: 'say', text });
  const em = (text) => ({ kind: 'em', text });
  const cue = (text) => ({ kind: 'cue', text });
  const labels = [];
  for (const s of pv.segments) if (!labels.includes(s.label)) labels.push(s.label);
  const wheel = [say('Here’s the wheel: ')];
  labels.forEach((l) => { wheel.push(em(l)); wheel.push(say(`${DASH}${TAGLINES[l] || ''} `)); });
  const sections = [
    { title: 'Welcome', parts: [say('Evening, everyone, and welcome to '), em('Christmas Chaos'), say(': the only game show where Grandma can legally steal your points.')] },
    { title: 'Join in', parts: [em('Phones out! '), cue('point at the TV'), say(' Scan the code on the TV, or type '), em(addr), say(' '), cue('say it slowly, dot by dot'), say(' Add your name, pick a team, and you’re in. Same Wi-Fi as me, not the guest one.')] },
    { title: 'How a turn works', parts: [say('Each round, every team gets a turn. Anyone on your team taps '), em('Spin'), say(', and wherever the wheel lands, you do it. I’ll judge, and the points roll in.')] },
    { title: 'The wheel', parts: wheel },
    { title: 'The finale', parts: [say('Then comes '), em('Final Chaos'), say(': bet your points on one last question. '), cue('dramatic pause'), say(' So whoever’s winning now: don’t get comfy.')] },
    { title: 'Let’s play', parts: [say('Most points wins Christmas. My rulings are final, and bribes are accepted in cookies. '), em('Let’s play!'), say(' '), cue('then press Start')] },
  ];
  const text = sections.map((s) => s.parts.map((p) => (p.kind === 'cue' ? `[${p.text}]` : p.text)).join('').replace(/\s+/g, ' ').trim()).join('\n\n');
  const words = sections.flatMap((s) => s.parts.filter((p) => p.kind !== 'cue').map((p) => p.text)).join(' ').split(/\s+/).filter(Boolean).length;
  const players = pv.players.filter((p) => p.teamId).length;
  return {
    title: 'Read this to the room',
    minutes: Math.max(1, Math.round(words / 150)),
    words,
    joinAddress: addr,
    summary: pv.teams.length ? `${plural(players, 'player')} on ${plural(pv.teams.length, 'team')} are in. Round 1 opens with ${pv.teams[0].name} at the wheel.` : 'Add teams before you start.',
    sections,
    text,
  };
}

module.exports = { buildCoach, buildIntroScript, displayUrl };
