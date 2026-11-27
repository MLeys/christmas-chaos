'use strict';
/**
 * Role-filtered views. THE ONLY place secrets are filtered.
 * Every object here is built from an explicit whitelist of fields \u2014 internal state objects are never spread,
 * so a new secret field added to game state can never leak by accident.
 *
 *   publicView(game, extra)            TV + base of every view
 *   hostView(game, extra)              publicView + host:{...private info, can flags}
 *   playerView(game, playerId, base?)  publicView + me / secret / myTeam / myVote / can
 */

const CATEGORY_LABELS = { christmas: 'Christmas Trivia', popculture: 'Pop Culture' };

function rankMap(teams) {
  const out = {};
  for (const t of teams) out[t.id] = 1 + teams.filter((o) => o.score > t.score).length;
  return out;
}

function publicTimer(t, now) {
  if (!t) return null;
  return {
    kind: t.kind, label: t.label, running: !!t.running, endsAt: t.running ? t.endsAt : null, durationMs: t.durationMs,
    remainingMs: t.running ? Math.max(0, t.endsAt - now) : Math.max(0, t.remainingMs), started: !!t.started, ended: !!t.ended,
  };
}

const person = (p) => (p ? { playerId: p.playerId || null, name: p.name || null, teamId: p.teamId } : null);

function publicBuzz(b) {
  if (!b) return null;
  return {
    open: !!b.open, armingUntil: b.armingUntil || null, eligibleTeamIds: b.eligibleTeamIds.slice(), lockedTeamIds: b.lockedTeamIds.slice(),
    winner: b.winner ? { playerId: b.winner.playerId, name: b.winner.name, teamId: b.winner.teamId } : null,
  };
}

function publicSubmissions(game, c) {
  const S = game.state;
  return S.teams.map((t) => {
    const s = c.subs[t.id];
    const row = { teamId: t.id, answered: !!s };
    if (c.revealed && s) {
      row.text = s.text; row.name = s.name; row.correct = !!game.effCorrect(s); row.first = c.firstTeamId === t.id;
      row.delta = c.awarded[t.id] || 0;
    }
    return row;
  });
}

function publicChallenge(game) {
  const S = game.state;
  const c = S.challenge;
  if (!c) return null;
  const out = {
    id: c.id, type: c.type, stage: c.stage, segmentIndex: c.segmentIndex, rule: c.rule, points: c.points,
    started: !!c.started, revealed: !!c.revealed,
  };
  switch (c.type) {
    case 'trivia':
      out.category = c.category;
      out.categoryLabel = CATEGORY_LABELS[c.category] || c.category;
      if (c.difficulty) out.difficulty = c.difficulty;
      if (c.pickedBy !== undefined) out.pickedBy = c.pickedBy ? { playerId: c.pickedBy.playerId, name: c.pickedBy.name } : null;
      if (c.q) {
        out.question = c.q.question;
        out.stealPoints = c.stealPoints != null ? c.stealPoints : Math.round(c.points / 2);
        out.hasHint = !!c.q.hint;
        if (c.hintShown) out.hint = c.q.hint;
        if (c.revealed) { out.answer = c.q.answer; out.funFact = c.q.funFact || ''; }
      }
      out.buzz = publicBuzz(c.buzz);
      break;
    case 'sounditout':
      out.performer = person(c.performer);
      out.stealPoints = c.stealPoints != null ? c.stealPoints : Math.round(c.points / 2);
      out.hasHint = !!c.song.hint;
      if (c.hintShown) out.hint = c.song.hint;
      if (c.revealed) { out.answer = c.song.title; out.artist = c.song.artist || ''; }
      out.buzz = publicBuzz(c.buzz);
      break;
    case 'dare': {
      const d = c.dare;
      out.performer = person(c.performer);
      out.partner = person(c.partner);
      out.dare = { title: d.title, instructions: d.instructions, who: d.who, time: d.time, props: d.props.slice(), judge: d.judge, hasSecret: !!c.secretValue };
      if (c.revealed && c.secretValue) out.answer = c.secretValue;
      if (c.vote) {
        const tally = game.voteTally();
        out.vote = { open: !!c.vote.open, endsAt: c.vote.open ? (S.timer && S.timer.kind === 'vote' && S.timer.running ? S.timer.endsAt : null) : null, nailed: tally.nailed, good: tally.good, voters: tally.voters, eligible: game.eligibleVoters(), result: c.vote.result || null };
      } else out.vote = null;
      out.dareResult = c.dareResult ? { result: c.dareResult.result, bonus: !!c.dareResult.bonus } : null;
      break;
    }
    case 'showdown':
      out.targets = (c.targets || []).slice();
      out.performer = person(c.performer);
      out.rival = c.rival ? { teamId: c.rival.teamId, playerId: c.rival.playerId || null, name: c.rival.name || null } : null;
      out.showdown = c.showdown ? { title: c.showdown.title, instructions: c.showdown.instructions, time: c.showdown.time, winner: c.showdown.winner, props: c.showdown.props.slice() } : null;
      out.winnerSide = c.winnerSide || null;
      break;
    case 'rapidlist':
      out.list = { prompt: c.list.prompt, ticked: c.ticked.slice(), count: c.ticked.length, max: game.points.listMax, each: game.points.listEach };
      if (c.listRevealed) out.list.answers = c.list.answers.slice();
      break;
    case 'hotseat': {
      const hs = c.hs;
      const showQ = c.stage === 'hotseat' && c.started && hs.index < hs.questions.length;
      out.performer = person(c.performer);
      out.hotseat = { index: hs.index, total: hs.questions.length, results: hs.results.slice(), question: showQ ? hs.questions[hs.index].question : null, each: game.points.hotseatEach };
      break;
    }
    case 'allplay':
    case 'bonus':
      out.question = c.q.question;
      out.submissions = publicSubmissions(game, c);
      if (c.revealed) { out.answer = c.q.answer; out.funFact = c.q.funFact || ''; out.firstTeamId = c.firstTeamId || null; }
      if (c.type === 'allplay') out.firstBonus = game.points.allPlayFirst;
      break;
    case 'grinch':
      out.targets = (c.targets || []).slice();
      out.gift = c.gift ? { toTeamId: c.gift.toTeamId, amount: c.gift.amount } : null;
      out.steal = c.steal ? { from: c.steal.from, to: c.steal.to, amount: c.steal.amount } : null;
      break;
    default:
      break;
  }
  out.result = c.result ? { kind: c.result.kind, awards: c.result.awards.map((a) => ({ teamId: a.teamId, delta: a.delta })), ...(c.result.text ? { text: c.result.text } : {}) } : null;
  return out;
}

function publicFinal(game) {
  const S = game.state;
  const F = S.final;
  if (!F) return null;
  const showQ = S.phase === 'finalAnswer' || S.phase === 'finalReveal' || S.phase === 'podium';
  return {
    category: F.q.category,
    categoryLabel: F.categoryLabel,
    question: showQ ? F.q.question : null,
    wagers: S.teams.map((t) => ({ teamId: t.id, locked: !!(F.wagers[t.id] && F.wagers[t.id].locked) })),
    submissions: S.teams.map((t) => ({ teamId: t.id, answered: !!F.subs[t.id] })),
    revealOrder: F.order.slice(),
    revealed: F.order.filter((id) => F.rows[id] && F.rows[id].revealed).map((id) => {
      const r = F.rows[id];
      return { teamId: id, text: r.text, by: r.by, wager: r.wager, judged: !!r.judged, correct: r.judged ? !!r.correct : null, delta: r.judged ? r.delta : null, before: r.before, after: r.judged ? r.after : null };
    }),
    current: F.current || null,
    done: !!F.done,
    answer: F.done ? F.q.answer : null,
  };
}

function publicView(game, extra = {}) {
  const S = game.state;
  const now = game.now();
  const act = game.activeTeamId();
  const ranks = rankMap(S.teams);
  const players = Object.values(S.players);
  return {
    now,
    phase: S.phase,
    gameNo: S.gameNo,
    joinUrl: game.joinUrl,
    settings: {
      rounds: S.settings.rounds, autoRounds: !!S.settings.autoRounds, roundBonus: !!S.settings.roundBonus,
      roundBonusAuto: !!S.settings.roundBonusAuto, sound: !!S.settings.sound, estimatedMinutes: game.estimateMinutes(),
    },
    round: S.round,
    totalRounds: S.settings.rounds,
    turnIndex: S.turnIndex,
    turnsPerRound: S.teams.length,
    turnId: S.turnId,
    teams: S.teams.map((t) => {
      const mine = players.filter((p) => p.teamId === t.id);
      return {
        id: t.id, name: t.name, mascot: t.mascot, color: t.color, score: t.score, rank: ranks[t.id],
        connectedCount: mine.filter((p) => p.connected).length, playerCount: mine.length,
        multiplier: t.id === act && S.turn ? S.turn.multiplier : 1,
      };
    }),
    players: players.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId || null, connected: !!p.connected })),
    activeTeamId: act,
    segments: game.segments,
    lastSegmentIndex: S.lastSegmentIndex,
    spin: S.phase === 'spinning' && S.spin ? { segmentIndex: S.spin.segmentIndex, startedAt: S.spin.startedAt, durationMs: S.spin.durationMs, by: S.spin.by ? { playerId: S.spin.by.playerId, name: S.spin.by.name } : null } : null,
    challenge: publicChallenge(game),
    timer: publicTimer(S.timer, now),
    lastAwards: S.lastAwards.map((a) => ({ id: a.id, teamId: a.teamId, delta: a.delta, reason: a.reason, doubled: !!a.doubled })),
    roundBreak: S.phase === 'roundBreak' && S.roundBreak ? { round: S.roundBreak.round, nextRound: S.roundBreak.nextRound, finalNext: !!S.roundBreak.finalNext, bonusDone: !!S.roundBreak.bonusDone, bonusPlanned: !!S.settings.roundBonus } : null,
    final: publicFinal(game),
    podium: S.phase === 'podium' && S.podium ? {
      standings: S.podium.standings.map((s) => ({ teamId: s.teamId, score: s.score, place: s.place })),
      awards: S.podium.awards.map((a) => ({ key: a.key, title: a.title, playerId: a.playerId, name: a.name, teamId: a.teamId, detail: a.detail })),
    } : null,
    savedGame: extra.savedGame ? { summary: extra.savedGame } : null,
  };
}

function hostView(game, extra = {}, base) {
  const pv = base || publicView(game, extra);
  const S = game.state;
  const c = S.challenge;
  const u = game.undoInfo();
  const h = {
    isHost: true,
    pin: extra.pin || null,
    candidates: (extra.candidates || []).map((x) => ({ address: x.address, iface: x.iface })),
    joinIp: extra.joinIp || null,
    answer: null, accept: [], hint: null, funFact: null,
    secret: null, song: null,
    listAnswers: null, listNote: null,
    hotseatQuestion: null, hotseatAnswer: null, hotseatAccept: [], hotseatQuestions: [],
    submissions: [],
    final: null,
    canUndo: u.canUndo, undoLabel: u.label, undoDepth: u.depth,
    contentStats: game.contentStats(),
    contentProblems: (game.content.problems || []).slice(0, 50).map((p) => ({ file: p.file, id: p.id, error: p.error })),
    warnings: [],
    mascots: game.mascots.map((m) => ({ mascot: m.mascot, color: m.color, colorName: m.colorName })),
    can: game.hostCan(),
  };
  if (c) {
    if ((c.type === 'trivia' || c.type === 'allplay' || c.type === 'bonus') && c.q) {
      h.answer = c.q.answer; h.accept = c.q.accept.slice(); h.hint = c.q.hint || null; h.funFact = c.q.funFact || null;
    }
    if (c.type === 'sounditout') {
      h.song = { title: c.song.title, artist: c.song.artist, accept: c.song.accept.slice(), hint: c.song.hint || null };
      h.answer = c.song.title; h.accept = c.song.accept.slice(); h.hint = c.song.hint || null;
      h.secret = { label: 'Hum this song. No words!', value: c.song.title, detail: c.song.artist };
    }
    if (c.type === 'dare' && c.secretValue) h.secret = { label: c.dare.secret.label, value: c.secretValue, detail: '' };
    if (c.type === 'rapidlist') { h.listAnswers = c.list.answers.slice(); h.listNote = c.list.note || null; }
    if (c.type === 'hotseat') {
      const q = c.hs.questions[c.hs.index];
      if (q) { h.hotseatQuestion = q.question; h.hotseatAnswer = q.answer; h.hotseatAccept = q.accept.slice(); }
      h.hotseatQuestions = c.hs.questions.map((x, i) => ({ index: i, question: x.question, answer: x.answer, result: c.hs.results[i] || null }));
    }
    if (c.subs) {
      h.submissions = S.teams.filter((t) => c.subs[t.id]).map((t) => {
        const s = c.subs[t.id];
        return { teamId: t.id, text: s.text, by: s.by, name: s.name, at: s.at, autoCorrect: !!s.autoCorrect, override: s.override == null ? null : !!s.override, correct: !!game.effCorrect(s) };
      });
    }
  }
  if (S.final) {
    const F = S.final;
    h.final = {
      question: F.q.question, answer: F.q.answer, accept: F.q.accept.slice(), category: F.q.category, categoryLabel: F.categoryLabel,
      wagers: S.teams.map((t) => {
        const w = F.wagers[t.id];
        return { teamId: t.id, amount: w ? w.amount : null, locked: !!(w && w.locked), by: w ? w.name : null, max: game.maxWager(t.id) };
      }),
      answers: S.teams.map((t) => {
        const s = F.subs[t.id];
        return { teamId: t.id, text: s ? s.text : null, by: s ? s.name : null, autoCorrect: s ? !!s.autoCorrect : false, override: s && s.override != null ? !!s.override : null };
      }),
      rows: F.order.map((id) => {
        const r = F.rows[id];
        return { teamId: id, text: r.text, by: r.by, wager: r.wager, autoCorrect: !!r.autoCorrect, override: r.override == null ? null : !!r.override, correct: r.override != null ? !!r.override : !!r.autoCorrect, revealed: !!r.revealed, judged: !!r.judged, delta: r.delta, before: r.before, after: r.after };
      }),
      current: F.current || null,
      done: !!F.done,
    };
  }
  if (S.phase === 'lobby') {
    for (const t of pv.teams) if (!t.playerCount) h.warnings.push({ code: 'empty-team', teamId: t.id, text: `${t.name} has no players yet` });
    if (pv.teams.length < 2) h.warnings.push({ code: 'need-two-teams', text: 'Add at least two teams to start' });
  }
  if (h.contentProblems.length) h.warnings.push({ code: 'content', text: `${(game.content.problems || []).length} content problem(s) \u2014 see contentProblems` });
  return { ...pv, host: h };
}

function playerView(game, playerId, base) {
  const pv = base || publicView(game);
  const S = game.state;
  const pl = playerId && Object.prototype.hasOwnProperty.call(S.players, playerId) ? S.players[playerId] : null;
  const me = pl ? { playerId: pl.id, name: pl.name, teamId: pl.teamId || null } : null;
  const teamId = me && me.teamId && S.teams.some((t) => t.id === me.teamId) ? me.teamId : null;
  let myTeam = null;
  if (teamId) {
    const c = S.challenge;
    let sub = null;
    if (S.final && (S.phase === 'finalAnswer' || S.phase === 'finalReveal' || S.phase === 'podium')) sub = S.final.subs[teamId] || null;
    else if (c && c.subs) sub = c.subs[teamId] || null;
    const w = S.final ? S.final.wagers[teamId] : null;
    myTeam = {
      teamId,
      isActive: teamId === game.activeTeamId(),
      submission: sub ? { text: sub.text, by: sub.name, byPlayerId: sub.by, at: sub.at } : null,
      wager: w ? { amount: w.amount, locked: !!w.locked, by: w.name || null } : null,
      maxWager: S.final ? game.maxWager(teamId) : null,
    };
  }
  const c = S.challenge;
  const myVote = pl && c && c.vote && Object.prototype.hasOwnProperty.call(c.vote.votes, pl.id) ? c.vote.votes[pl.id] : null;
  const can = pl ? game.playerCan(pl.id) : { spin: false, pickDifficulty: false, buzz: false, pickTarget: false, submitAnswer: false, wager: false, vote: false };
  return { ...pv, me, secret: pl ? game.playerSecret(pl.id) : null, myTeam, myVote, can };
}

module.exports = { publicView, hostView, playerView, publicChallenge, publicFinal };
