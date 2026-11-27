'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/questions.json'), 'utf8'));
const dares = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/dares.json'), 'utf8'));

const WHEEL_SEGMENTS = [
  { id: 'w0',  label: 'Christmas\nTrivia',  color: '#9b1e1e', emoji: '🎄', type: 'trivia',    category: 'christmas',  points: 100 },
  { id: 'w1',  label: 'Pop Culture',        color: '#1a6e3c', emoji: '🎬', type: 'trivia',    category: 'popculture', points: 100 },
  { id: 'w2',  label: 'Dare Card',          color: '#c0392b', emoji: '😱', type: 'dare',      category: null,         points: 150 },
  { id: 'w3',  label: 'Christmas\nTrivia',  color: '#7a1515', emoji: '🎅', type: 'trivia',    category: 'christmas',  points: 100 },
  { id: 'w4',  label: 'Sound It Out',       color: '#5b3486', emoji: '🎵', type: 'sounditout',category: 'sounditout', points: 100 },
  { id: 'w5',  label: 'Pop Culture',        color: '#145a32', emoji: '⭐', type: 'trivia',    category: 'popculture', points: 100 },
  { id: 'w6',  label: 'Dare Card',          color: '#a93226', emoji: '🤪', type: 'dare',      category: null,         points: 150 },
  { id: 'w7',  label: 'ALL PLAY!',          color: '#b7950b', emoji: '⚡', type: 'allplay',   category: 'christmas',  points: 150 },
  { id: 'w8',  label: 'Christmas\nTrivia',  color: '#6e1515', emoji: '🦌', type: 'trivia',    category: 'christmas',  points: 100 },
  { id: 'w9',  label: 'Hot Seat',           color: '#a04000', emoji: '🔥', type: 'hotseat',   category: null,         points: 25  },
  { id: 'w10', label: 'Double Down!',       color: '#1a5276', emoji: '💫', type: 'special',   effect: 'doubledown',   points: 0   },
  { id: 'w11', label: 'STEAL!',             color: '#0e6655', emoji: '🎁', type: 'special',   effect: 'steal',        points: 100 },
];

const TEAM_COLORS = ['#c0392b','#1a7a3c','#2471a3','#8e44ad','#d35400','#117a65','#7D6608','#1a5276'];

function makeState() {
  return {
    phase: 'lobby',
    teams: [],
    players: {},
    currentTeamIndex: 0,
    round: 1,
    totalRounds: 3,
    turnsInRound: 0,
    currentChallenge: null,
    currentSegment: null,
    usedQuestionIds: [],
    usedDareIds: [],
    doubleDownActive: false,
    buzzerOpen: false,
    buzzerWinner: null,
    hotSeatQuestions: [],
    hotSeatIndex: 0,
    answerRevealed: false,
  };
}

let state = makeState();

function recommendedRounds(teamCount) {
  if (teamCount <= 3) return 4;
  if (teamCount <= 5) return 3;
  return 3;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickQuestion(category) {
  let pool = questions.filter(q => q.category === category && !state.usedQuestionIds.includes(q.id));
  if (!pool.length) {
    state.usedQuestionIds = state.usedQuestionIds.filter(id =>
      !questions.find(q => q.id === id && q.category === category)
    );
    pool = questions.filter(q => q.category === category);
  }
  const q = pickRandom(pool);
  state.usedQuestionIds.push(q.id);
  return q;
}

function pickDare() {
  let pool = dares.filter(d => !state.usedDareIds.includes(d.id));
  if (!pool.length) {
    state.usedDareIds = [];
    pool = [...dares];
  }
  const d = pickRandom(pool);
  state.usedDareIds.push(d.id);
  return d;
}

function pickHotSeat(count) {
  const pool = questions.filter(q =>
    (q.category === 'christmas' || q.category === 'popculture') &&
    !state.usedQuestionIds.includes(q.id)
  );
  const picked = [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(count, shuffled.length); i++) {
    picked.push(shuffled[i]);
    state.usedQuestionIds.push(shuffled[i].id);
  }
  return picked;
}

function publicState() {
  return {
    phase: state.phase,
    teams: state.teams,
    players: Object.values(state.players),
    currentTeamIndex: state.currentTeamIndex,
    round: state.round,
    totalRounds: state.totalRounds,
    turnsInRound: state.turnsInRound,
    currentChallenge: state.currentChallenge,
    currentSegment: state.currentSegment,
    doubleDownActive: state.doubleDownActive,
    buzzerOpen: state.buzzerOpen,
    buzzerWinner: state.buzzerWinner,
    hotSeatIndex: state.hotSeatIndex,
    hotSeatTotal: state.hotSeatQuestions.length,
    answerRevealed: state.answerRevealed,
  };
}

function processSegment(seg) {
  state.answerRevealed = false;

  if (seg.type === 'trivia' || seg.type === 'allplay') {
    const q = pickQuestion(seg.category || 'christmas');
    state.currentChallenge = q;
    state.phase = 'challenge';
    state.buzzerOpen = true;
    state.buzzerWinner = null;
    io.emit('spin-result', { segment: seg, challenge: q });

  } else if (seg.type === 'dare') {
    const d = pickDare();
    state.currentChallenge = d;
    state.phase = 'challenge';
    io.emit('spin-result', { segment: seg, challenge: d });

  } else if (seg.type === 'sounditout') {
    const q = pickQuestion('sounditout');
    state.currentChallenge = q;
    state.phase = 'challenge';
    io.emit('spin-result', { segment: seg, challenge: q });

  } else if (seg.type === 'hotseat') {
    const qs = pickHotSeat(5);
    state.hotSeatQuestions = qs;
    state.hotSeatIndex = 0;
    state.currentChallenge = qs[0] || null;
    state.phase = 'hotseat';
    io.emit('spin-result', { segment: seg, challenge: state.currentChallenge, hotSeatTotal: qs.length });

  } else if (seg.type === 'special') {
    if (seg.effect === 'doubledown') {
      state.doubleDownActive = true;
      state.phase = 'playing';
      state.currentChallenge = null;
      io.emit('spin-result', { segment: seg, challenge: null });
    } else if (seg.effect === 'steal') {
      state.currentChallenge = { type: 'steal', title: 'STEAL!', description: 'Pick a team to steal 100 points from.' };
      state.phase = 'challenge';
      io.emit('spin-result', { segment: seg, challenge: state.currentChallenge });
    }
  }

  io.emit('state-update', publicState());
}

io.on('connection', (socket) => {
  socket.emit('state-update', publicState());
  socket.emit('wheel-segments', WHEEL_SEGMENTS);

  socket.on('join-game', ({ name, teamIndex }) => {
    state.players[socket.id] = { id: socket.id, name, teamIndex };
    io.emit('state-update', publicState());
  });

  socket.on('create-team', ({ teamName }) => {
    if (state.phase !== 'lobby') return;
    const idx = state.teams.length;
    state.teams.push({ name: teamName, score: 0, color: TEAM_COLORS[idx % TEAM_COLORS.length], index: idx });
    state.totalRounds = recommendedRounds(state.teams.length);
    io.emit('state-update', publicState());
  });

  socket.on('remove-team', ({ teamIndex }) => {
    if (state.phase !== 'lobby') return;
    state.teams.splice(teamIndex, 1);
    state.teams.forEach((t, i) => { t.index = i; t.color = TEAM_COLORS[i % TEAM_COLORS.length]; });
    Object.entries(state.players).forEach(([id, p]) => {
      if (p.teamIndex === teamIndex) delete state.players[id];
      else if (p.teamIndex > teamIndex) p.teamIndex--;
    });
    state.totalRounds = recommendedRounds(state.teams.length);
    io.emit('state-update', publicState());
  });

  socket.on('set-rounds', ({ rounds }) => {
    state.totalRounds = Math.max(1, Math.min(6, rounds));
    io.emit('state-update', publicState());
  });

  socket.on('start-game', () => {
    if (state.teams.length < 2) return;
    state.phase = 'playing';
    state.round = 1;
    state.currentTeamIndex = 0;
    state.turnsInRound = 0;
    io.emit('state-update', publicState());
    io.emit('game-started', { teamIndex: 0, teamName: state.teams[0].name });
  });

  socket.on('spin-wheel', () => {
    if (state.phase !== 'playing') return;
    const player = state.players[socket.id];
    if (!player || player.teamIndex !== state.currentTeamIndex) return;

    const segIndex = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
    state.currentSegment = WHEEL_SEGMENTS[segIndex];
    state.phase = 'spinning';
    io.emit('spin-start', { segmentIndex: segIndex });
    io.emit('state-update', publicState());

    setTimeout(() => processSegment(WHEEL_SEGMENTS[segIndex]), 5500);
  });

  socket.on('host-spin', () => {
    if (state.phase !== 'playing') return;
    const segIndex = Math.floor(Math.random() * WHEEL_SEGMENTS.length);
    state.currentSegment = WHEEL_SEGMENTS[segIndex];
    state.phase = 'spinning';
    io.emit('spin-start', { segmentIndex: segIndex });
    io.emit('state-update', publicState());
    setTimeout(() => processSegment(WHEEL_SEGMENTS[segIndex]), 5500);
  });

  socket.on('buzzer-press', () => {
    if (!state.buzzerOpen || state.buzzerWinner) return;
    const player = state.players[socket.id];
    if (!player) return;
    state.buzzerWinner = {
      playerId: socket.id,
      playerName: player.name,
      teamIndex: player.teamIndex,
      teamName: state.teams[player.teamIndex]?.name || 'Unknown',
    };
    state.buzzerOpen = false;
    io.emit('buzzer-winner', state.buzzerWinner);
    io.emit('state-update', publicState());
  });

  socket.on('reveal-answer', () => {
    state.answerRevealed = true;
    io.emit('answer-revealed', {
      answer: state.currentChallenge?.answer || state.currentChallenge?.songTitle || '—',
    });
    io.emit('state-update', publicState());
  });

  socket.on('award-points', ({ teamIndex, points }) => {
    if (!state.teams[teamIndex]) return;
    let pts = Number(points);
    if (state.doubleDownActive) { pts *= 2; state.doubleDownActive = false; }
    state.teams[teamIndex].score = Math.max(0, state.teams[teamIndex].score + pts);
    io.emit('state-update', publicState());
  });

  socket.on('steal-execute', ({ fromTeamIndex, toTeamIndex }) => {
    const amount = 100;
    state.teams[fromTeamIndex].score = Math.max(0, state.teams[fromTeamIndex].score - amount);
    state.teams[toTeamIndex].score += amount;
    io.emit('state-update', publicState());
  });

  socket.on('hotseat-next', () => {
    if (state.phase !== 'hotseat') return;
    state.hotSeatIndex++;
    state.answerRevealed = false;
    if (state.hotSeatIndex >= state.hotSeatQuestions.length) {
      state.phase = 'challenge';
      state.currentChallenge = null;
      io.emit('hotseat-complete');
    } else {
      state.currentChallenge = state.hotSeatQuestions[state.hotSeatIndex];
      io.emit('hotseat-question', { question: state.currentChallenge, index: state.hotSeatIndex, total: state.hotSeatQuestions.length });
    }
    io.emit('state-update', publicState());
  });

  socket.on('open-buzzer', () => {
    state.buzzerOpen = true;
    state.buzzerWinner = null;
    io.emit('state-update', publicState());
  });

  socket.on('close-buzzer', () => {
    state.buzzerOpen = false;
    io.emit('state-update', publicState());
  });

  socket.on('next-turn', () => {
    state.turnsInRound++;

    if (state.turnsInRound >= state.teams.length) {
      state.round++;
      state.turnsInRound = 0;
      if (state.round > state.totalRounds) {
        state.phase = 'gameend';
        const sorted = [...state.teams].sort((a, b) => b.score - a.score);
        io.emit('game-end', { teams: sorted });
        io.emit('state-update', publicState());
        return;
      }
      io.emit('round-start', { round: state.round, totalRounds: state.totalRounds });
    }

    state.currentTeamIndex = (state.currentTeamIndex + 1) % state.teams.length;
    state.phase = 'playing';
    state.currentChallenge = null;
    state.currentSegment = null;
    state.buzzerOpen = false;
    state.buzzerWinner = null;
    state.hotSeatQuestions = [];
    state.hotSeatIndex = 0;
    state.answerRevealed = false;

    io.emit('state-update', publicState());
    io.emit('turn-start', { teamIndex: state.currentTeamIndex, teamName: state.teams[state.currentTeamIndex]?.name });
  });

  socket.on('override-score', ({ teamIndex, score }) => {
    if (!state.teams[teamIndex]) return;
    state.teams[teamIndex].score = Math.max(0, Number(score));
    io.emit('state-update', publicState());
  });

  socket.on('reset-game', () => {
    const savedTeams = state.teams.map(t => ({ ...t, score: 0 }));
    state = makeState();
    state.teams = savedTeams;
    state.totalRounds = recommendedRounds(savedTeams.length);
    io.emit('state-update', publicState());
  });

  socket.on('full-reset', () => {
    state = makeState();
    io.emit('state-update', publicState());
  });

  socket.on('disconnect', () => {
    delete state.players[socket.id];
    io.emit('state-update', publicState());
  });
});

app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/', (req, res) => res.redirect('/host'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎄 Christmas Chaos is running!\n');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`   Network: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`   Local:   http://localhost:${PORT}\n`);
  console.log(`   TV Screen  → /tv`);
  console.log(`   Host View  → /host`);
  console.log(`   Players    → /player\n`);
});
