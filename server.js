'use strict';
/**
 * Christmas Chaos v2 \u2014 server entry.
 * Express (pages, fonts, QR, /api/info) + socket.io (hello / player events / host:* events / state + fx pushes),
 * host authorisation (loopback or PIN), autosave/resume, LAN address picking and the startup banner.
 * The game rules live in src/game.js; what each screen may see lives in src/views.js.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const { createGame } = require('./src/game');
const { loadContent } = require('./src/content');
const { publicView, hostView, playerView, hostLoginView } = require('./src/views');
const { pickLanAddress } = require('./src/net');
const { createScheduler } = require('./src/scheduler');

const PLAYER_EVENTS = ['join', 'spin', 'pickDifficulty', 'buzz', 'pickTarget', 'previewTarget', 'submitAnswer', 'wager', 'vote', 'peek'];
const HOST_GAME_EVENTS = [
  'createTeam', 'updateTeam', 'removeTeam', 'reorderTeams', 'shuffleTeams', 'movePlayer', 'kickPlayer', 'setRounds', 'setOption',
  'start', 'spin', 'forceSegment', 'pickDifficulty', 'pickTarget', 'judge', 'openSteal', 'reveal', 'showHint', 'timer',
  'rerollPerformer', 'swapQuestion', 'swapSecret', 'endChallenge', 'dareResult', 'openVote', 'closeVote', 'showdownResult',
  'listTick', 'listUntick', 'listOther', 'hotseatMark', 'markAnswer', 'revealAnswers', 'finalStartAnswering', 'finalRevealNext',
  'adjustScore', 'undo', 'nextTurn', 'continue', 'resetGame', 'soundTest',
].map((e) => 'host:' + e);
const HOST_SERVER_EVENTS = ['host:resume', 'host:discardSave'];
const OTHER_EVENTS = ['hello', 'hostLogin'];
const ROLES = ['player', 'tv', 'host'];
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const PIN_TRIES_PER_SOCKET = 5;   // per minute
const PIN_TRIES_PER_ADDRESS = 20; // per minute (stops "reconnect and try again")
const PIN_WINDOW_MS = 60 * 1000;

const isLoopback = (addr) => typeof addr === 'string' && (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.') || addr === '::ffff:127.0.0.1' || addr.startsWith('::ffff:127.'));
/**
 * Is this socket address the machine running the server? Loopback, or one of this machine's own interface
 * addresses (the laptop opening http://<its LAN IP>:3000/host is still "the laptop").
 */
function isLocalAddress(addr, ifaces) {
  if (isLoopback(addr)) return true;
  if (typeof addr !== 'string' || !addr) return false;
  const a = addr.replace(/^::ffff:/i, '').toLowerCase();
  let list;
  try { list = ifaces || require('os').networkInterfaces(); } catch { return false; }
  for (const entries of Object.values(list || {})) {
    for (const e of entries || []) if (e && typeof e.address === 'string' && e.address.toLowerCase() === a) return true;
  }
  return false;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function makePin() { return String(Math.floor(1000 + Math.random() * 9000)); }

function fontDir(pkg) {
  try { return path.join(path.dirname(require.resolve(pkg + '/package.json')), 'files'); } catch { return null; }
}

/**
 * Start the server. Resolves with a handle once listening.
 * @param {object} o
 *   port (env PORT || 3000; 0 = random), host ('0.0.0.0'), dataDir, saveDir, publicDir, pin (env HOST_PIN or random),
 *   trustLoopback (true), timing (game timing overrides), rng, autosave (true), saveDebounceMs (1000),
 *   coalesceMs (30), rateLimit (events/sec/socket, 60; 0 = off), quiet (false), env (process.env)
 */
function startServer(o = {}) {
  const env = o.env || process.env;
  const log = o.quiet ? () => {} : (...a) => console.log(...a);
  const warn = (...a) => console.warn(...a);
  const dataDir = o.dataDir || path.join(__dirname, 'data');
  const saveDir = o.saveDir || env.CC_SAVE_DIR || path.join(__dirname, 'saves');
  const publicDir = o.publicDir || path.join(__dirname, 'public');
  const savePath = path.join(saveDir, 'autosave.json');
  const pin = String(o.pin || env.HOST_PIN || makePin());
  const trustLoopback = o.trustLoopback !== false;
  const coalesceMs = o.coalesceMs != null ? o.coalesceMs : 30;
  const rateLimit = o.rateLimit != null ? o.rateLimit : 60;
  const autosave = o.autosave !== false;
  const saveDebounceMs = o.saveDebounceMs != null ? o.saveDebounceMs : 1000;
  let port = o.port != null ? Number(o.port) : Number(env.PORT || 3000);

  const content = loadContent(dataDir);
  if (content.problems.length) {
    warn(`[content] ${content.problems.length} problem(s) in data/*.json (bad items are skipped):`);
    for (const p of content.problems.slice(0, 15)) warn(`  - ${p.file}${p.id ? ' ' + p.id : ''}: ${p.error}`);
  }

  // ------------------------------------------------------------- LAN address
  const lan = pickLanAddress(undefined, env);
  let joinIp = lan.address;
  const joinUrlFor = (ip) => `http://${ip}:${port}/`;

  // ------------------------------------------------------------- game
  const fxQueue = [];
  let flushTimer = null;
  let io = null;
  const scheduler = createScheduler({ onError: (e) => console.error('[timer]', e) });
  const game = createGame({
    content,
    rng: o.rng,
    timing: o.timing,
    scheduler,
    onChange: () => scheduleFlush(),
    onFx: (e) => { fxQueue.push(e); scheduleFlush(); },
  });

  // ------------------------------------------------------------- autosave / resume
  let pendingSave = null; // { data, summary }
  let saveTimer = null;
  function readSave() {
    try {
      const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      return game.isValidSave(data) ? data : null;
    } catch { return null; }
  }
  function writeSaveNow() {
    if (!autosave) return;
    if (pendingSave && game.state.phase === 'lobby') return; // don't clobber a resumable game with an empty lobby
    try {
      fs.mkdirSync(saveDir, { recursive: true });
      const tmp = savePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(game.serialize()));
      fs.renameSync(tmp, savePath);
    } catch (e) { warn('[autosave] failed:', e.message); }
  }
  function scheduleSave() {
    if (!autosave || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeSaveNow(); }, saveDebounceMs);
  }
  if (autosave) {
    const saved = readSave();
    if (saved && saved.phase !== 'lobby') pendingSave = { data: saved, summary: game.summary(saved) };
    else if (saved && saved.phase === 'lobby') game.restore(saved); // lobby setup survives a restart silently
  }

  // ------------------------------------------------------------- views / broadcast
  const clientSockets = new Map(); // clientId -> Set(socket.id)
  function connections() {
    let tv = 0;
    let hosts = 0;
    if (io) for (const s of io.of('/').sockets.values()) { if (s.data.role === 'tv') tv++; else if (s.data.role === 'host' && s.data.isHost) hosts++; }
    return { tv, hosts };
  }
  function extra() {
    return { savedGame: pendingSave ? pendingSave.summary : null, pin, candidates: lan.candidates, joinIp, connections: connections() };
  }
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, coalesceMs);
  }
  function viewFor(s, pv, cache) {
    const role = s.data.role;
    if (role === 'tv') return pv;
    if (role === 'host' && !s.data.isHost) return cache.lv || (cache.lv = hostLoginView(game));
    if (role === 'host') return cache.hv || (cache.hv = hostView(game, cache.extra || (cache.extra = extra()), pv));
    if (role === 'player') return playerView(game, game.playerIdForClient(s.data.clientId), pv);
    return null;
  }
  function flush() {
    flushTimer = null;
    if (!io) return;
    try {
      const ex = extra();
      const pv = publicView(game, ex);
      const cache = { extra: ex };
      const fxs = fxQueue.splice(0, fxQueue.length);
      for (const s of io.of('/').sockets.values()) {
        const v = viewFor(s, pv, cache);
        if (!v) continue;
        s.emit('state', v);
        for (const e of fxs) s.emit('fx', e);
      }
    } catch (e) { console.error('[broadcast]', e); }
    scheduleSave();
  }
  function pushTo(s) {
    try {
      const ex = extra();
      const v = viewFor(s, publicView(game, ex), { extra: ex });
      if (v) s.emit('state', v);
    } catch (e) { console.error('[push]', e); }
  }

  // ------------------------------------------------------------- http
  const app = express();
  app.disable('x-powered-by');
  const noCache = (res) => res.set('Cache-Control', 'no-cache');
  const page = (file) => (req, res) => {
    const fp = path.join(publicDir, file);
    noCache(res);
    if (fs.existsSync(fp)) return res.sendFile(fp);
    res.status(200).type('html').send(`<!doctype html><meta charset="utf-8"><title>Christmas Chaos</title><body style="background:#0B1F17;color:#FFF6E5;font-family:sans-serif;padding:40px"><h1>Christmas Chaos</h1><p>${file} is not built yet.</p>`);
  };
  app.get('/', page('index.html'));
  app.get('/index.html', page('index.html'));
  app.get('/tv', page('tv.html'));
  app.get('/host', page('host.html'));
  app.get(['/player', '/player.html'], (req, res) => res.redirect(302, '/'));
  const lilita = fontDir('@fontsource/lilita-one');
  const fredoka = fontDir('@fontsource/fredoka');
  if (lilita) app.use('/fonts/lilita-one', express.static(lilita, { maxAge: '30d', immutable: true, fallthrough: false }));
  if (fredoka) app.use('/fonts/fredoka', express.static(fredoka, { maxAge: '30d', immutable: true, fallthrough: false }));
  app.get('/api/info', (req, res) => {
    noCache(res);
    res.json({ joinUrl: joinUrlFor(joinIp), candidates: lan.candidates.map((c) => ({ address: c.address, iface: c.iface, joinUrl: joinUrlFor(c.address) })), port, tvUrl: `http://localhost:${port}/tv`, hostUrl: `http://localhost:${port}/host` });
  });
  let qrCache = { url: null, svg: null };
  app.get('/api/qr.svg', async (req, res) => {
    try {
      const url = joinUrlFor(joinIp);
      if (qrCache.url !== url) qrCache = { url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B1F17', light: '#FFF6E5' } }) };
      res.set('Cache-Control', 'no-store').type('image/svg+xml').send(qrCache.svg);
    } catch (e) { res.status(500).type('text').send('qr failed'); }
  });
  app.use(express.static(publicDir, { index: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { if (err && err.status === 404) return res.status(404).type('text').send('Not found'); console.error('[http]', err && err.message); res.status(500).type('text').send('Server error'); });

  const server = http.createServer(app);
  io = new Server(server, { maxHttpBufferSize: 64 * 1024, pingInterval: 10000, pingTimeout: 8000, serveClient: true });

  // ------------------------------------------------------------- sockets
  const pinFailures = new Map(); // address -> [timestamps of wrong PINs in the last minute]
  const recent = (arr, t) => arr.filter((x) => t - x < PIN_WINDOW_MS);
  io.on('connection', (socket) => {
    socket.data = { role: null, clientId: null, isHost: false, pinTries: [] };
    const addr = socket.handshake.address || (socket.conn && socket.conn.remoteAddress) || '';
    const loopback = isLocalAddress(addr); // this laptop (loopback or one of its own addresses)
    let bucket = { t: 0, n: 0 };
    const limited = () => {
      if (!rateLimit) return false;
      const sec = Math.floor(Date.now() / 1000);
      if (bucket.t !== sec) bucket = { t: sec, n: 0 };
      return ++bucket.n > rateLimit;
    };
    /** Wrap a handler: never throws, always acks {ok, error?} when an ack callback was given. */
    const handle = (name, fn) => socket.on(name, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let res;
      try {
        if (limited()) res = { ok: false, error: 'slow-down' };
        else res = fn(args[0]);
      } catch (e) {
        console.error(`[socket] ${name} failed:`, e && e.stack || e);
        res = { ok: false, error: 'server-error' };
      }
      if (ack) { try { ack(res || { ok: true }); } catch { /* ignore */ } }
    });

    function unbindPlayer() {
      const cid = socket.data.clientId;
      if (socket.data.role !== 'player' || !cid) return;
      const set = clientSockets.get(cid);
      if (set) { set.delete(socket.id); if (!set.size) { clientSockets.delete(cid); game.setClientConnected(cid, false); } }
    }

    /** PIN rate limit: 5 wrong tries per minute per socket and 20 per minute per address. Returns ms to wait (0 = ok). */
    function pinWait(perSocket) {
      const t = Date.now();
      const byAddr = recent(pinFailures.get(addr) || [], t);
      pinFailures.set(addr, byAddr);
      socket.data.pinTries = recent(socket.data.pinTries, t);
      const lists = [[byAddr, PIN_TRIES_PER_ADDRESS]];
      if (perSocket) lists.push([socket.data.pinTries, PIN_TRIES_PER_SOCKET]);
      let wait = 0;
      for (const [list, max] of lists) if (list.length >= max) wait = Math.max(wait, PIN_WINDOW_MS - (t - list[list.length - max]));
      return wait;
    }
    function pinFailed(perSocket) {
      const t = Date.now();
      pinFailures.set(addr, [...recent(pinFailures.get(addr) || [], t), t]);
      if (perSocket) socket.data.pinTries.push(t);
    }
    const validPin = (v) => typeof v === 'string' && v.length <= 12 && v === pin;

    handle('hello', (p) => {
      if (!isObj(p) || !ROLES.includes(p.role)) return { ok: false, error: 'bad-role' };
      if (p.role === 'player' && (typeof p.clientId !== 'string' || !CLIENT_ID_RE.test(p.clientId))) return { ok: false, error: 'bad-client-id' };
      let isHost = false;
      let pinError = null;
      if (p.role === 'host') {
        if (trustLoopback && loopback) isHost = true;
        else if (p.hostKey !== undefined && p.hostKey !== null && p.hostKey !== '') {
          // a remembered key from localStorage (cc.hostKey); a stale one (server restarted with a new PIN) just asks again
          if (pinWait(false)) pinError = 'too-many-tries';
          else if (validPin(p.hostKey)) isHost = true;
          else { pinFailed(false); pinError = 'bad-pin'; }
        }
      }
      const wasCounted = socket.data.role === 'tv' || (socket.data.role === 'host' && socket.data.isHost);
      unbindPlayer();
      for (const r of ROLES) socket.leave(r);
      socket.data.role = p.role;
      socket.data.isHost = isHost;
      socket.data.clientId = p.role === 'player' ? p.clientId : null;
      socket.join(p.role);
      if (p.role === 'player') {
        if (!clientSockets.has(p.clientId)) clientSockets.set(p.clientId, new Set());
        clientSockets.get(p.clientId).add(socket.id);
        game.setClientConnected(p.clientId, true);
      }
      // host screens show "TV connected" / "2 host screens": a TV/host (dis)appearing re-renders everyone (incl. this
      // socket); otherwise only this socket gets its first state.
      if (wasCounted || p.role === 'tv' || isHost) scheduleFlush();
      else setImmediate(() => pushTo(socket));
      const pid = p.role === 'player' ? game.playerIdForClient(p.clientId) : null;
      const pl = pid ? game.state.players[pid] : null;
      const res = { ok: true, role: p.role, isHost, me: pl ? { playerId: pl.id, name: pl.name, teamId: pl.teamId || null } : null, serverNow: Date.now() };
      if (p.role === 'host') {
        if (isHost) { if (!(trustLoopback && loopback)) res.hostKey = pin; } else { res.needPin = true; if (pinError) res.pinError = pinError; }
      }
      return res;
    });

    // Second host device: type the PIN shown on the laptop. ack {ok, isHost, hostKey} -> keep hostKey in localStorage['cc.hostKey'].
    handle('hostLogin', (p) => {
      if (socket.data.role !== 'host') return { ok: false, error: 'hello-first' };
      if (socket.data.isHost) return { ok: true, isHost: true, hostKey: pin };
      const wait = pinWait(true);
      if (wait) return { ok: false, error: 'too-many-tries', retryInMs: wait };
      const v = isObj(p) ? p.pin : undefined;
      const given = typeof v === 'number' && Number.isInteger(v) ? String(v) : v;
      if (!validPin(given)) {
        pinFailed(true);
        const left = Math.max(0, PIN_TRIES_PER_SOCKET - socket.data.pinTries.length);
        return { ok: false, error: 'bad-pin', triesLeft: left };
      }
      socket.data.isHost = true;
      socket.data.pinTries = [];
      scheduleFlush(); // this socket gets the full hostView; the other hosts see one more host screen
      return { ok: true, isHost: true, hostKey: pin };
    });

    for (const ev of PLAYER_EVENTS) {
      handle(ev, (p) => {
        if (socket.data.role !== 'player') return { ok: false, error: socket.data.role ? 'not-player' : 'hello-first' };
        const res = game.dispatch({ role: 'player', clientId: socket.data.clientId }, ev, p);
        if (ev === 'join' && res.ok) game.setClientConnected(socket.data.clientId, true);
        return res;
      });
    }
    for (const ev of HOST_GAME_EVENTS) {
      handle(ev, (p) => {
        if (!socket.data.isHost) return { ok: false, error: 'not-host' };
        if (ev === 'host:setOption' && isObj(p) && p.key === 'joinIp') {
          if (typeof p.value !== 'string' || !lan.candidates.some((c) => c.address === p.value)) return { ok: false, error: 'bad-ip' };
          joinIp = p.value;
          game.setJoinUrl(joinUrlFor(joinIp));
          return { ok: true };
        }
        if (ev === 'host:start' && pendingSave) {
          const r = game.dispatch({ role: 'host' }, ev, p);
          if (r.ok) { pendingSave = null; scheduleFlush(); }
          return r;
        }
        return game.dispatch({ role: 'host' }, ev, p);
      });
    }
    handle('host:resume', () => {
      if (!socket.data.isHost) return { ok: false, error: 'not-host' };
      if (!pendingSave) return { ok: false, error: 'no-save' };
      if (!game.restore(pendingSave.data)) return { ok: false, error: 'bad-save' };
      pendingSave = null;
      for (const cid of clientSockets.keys()) game.setClientConnected(cid, true);
      game.setJoinUrl(joinUrlFor(joinIp));
      scheduleFlush();
      return { ok: true };
    });
    handle('host:discardSave', () => {
      if (!socket.data.isHost) return { ok: false, error: 'not-host' };
      if (!pendingSave) return { ok: false, error: 'no-save' };
      pendingSave = null;
      scheduleFlush();
      writeSaveNow();
      return { ok: true };
    });
    socket.onAny((name, ...args) => {
      if (OTHER_EVENTS.includes(name) || PLAYER_EVENTS.includes(name) || HOST_GAME_EVENTS.includes(name) || HOST_SERVER_EVENTS.includes(name)) return;
      const ack = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (ack) { try { ack({ ok: false, error: 'unknown-event' }); } catch { /* ignore */ } }
    });
    socket.on('disconnect', () => {
      try {
        unbindPlayer();
        if (socket.data.role === 'tv' || (socket.data.role === 'host' && socket.data.isHost)) scheduleFlush();
      } catch (e) { console.error('[socket] disconnect', e); }
    });
    socket.on('error', (e) => console.error('[socket] error', e && e.message));
  });

  // ------------------------------------------------------------- listen
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') e.friendly = `Port ${port} is already in use. Close the other Christmas Chaos window, or start with a different port:  set PORT=3001 && npm start`;
      reject(e);
    });
    server.listen(port, o.host || '0.0.0.0', () => {
      port = server.address().port;
      game.setJoinUrl(joinUrlFor(joinIp));
      const handleObj = {
        app, io, server, game, pin, scheduler,
        get port() { return port; },
        get joinUrl() { return joinUrlFor(joinIp); },
        candidates: lan.candidates,
        get pendingSave() { return pendingSave; },
        flushNow: () => { if (flushTimer) { clearTimeout(flushTimer); flush(); } },
        saveNow: writeSaveNow,
        close: () => new Promise((res) => {
          scheduler.bump();
          if (flushTimer) clearTimeout(flushTimer);
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; writeSaveNow(); }
          io.close(() => res());
          server.close();
          setTimeout(res, 500);
        }),
      };
      if (!o.quiet) printBanner(handleObj, log);
      resolve(handleObj);
    });
  });
}

function printBanner(h, log) {
  const line = '-'.repeat(64);
  const others = h.candidates.slice(1).map((c) => `http://${c.address}:${h.port}/  (${c.iface})`);
  log('');
  log(line);
  log('  CHRISTMAS CHAOS is running!');
  log(line);
  log(`  Phones join at:  ${h.joinUrl}`);
  log(`  TV screen:       http://localhost:${h.port}/tv   (on this laptop)  or  ${h.joinUrl}tv`);
  log(`  Host screen:     http://localhost:${h.port}/host`);
  log(`  Host PIN:        ${h.pin}   (second host device, e.g. your phone: open ${h.joinUrl}host and type it)`);
  if (others.length) log(`  Other addresses: ${others.join('\n                   ')}`);
  if (h.pendingSave) log(`  Saved game found (round ${h.pendingSave.summary.round}) - open the host screen to resume it.`);
  log('');
  log('  Phones can\'t connect?');
  log('   1. Phones must be on the SAME Wi-Fi as this laptop (not a guest network).');
  log('   2. Run "npm run firewall" once (it asks for admin) to allow the game through Windows Firewall.');
  log('   3. Turn off any VPN on this laptop. Pick another address in the host lobby if there are several.');
  log(line);
  log('');
}

module.exports = { startServer, isLoopback, isLocalAddress };

if (require.main === module) {
  process.on('uncaughtException', (e) => console.error('[uncaughtException] (still running)', e && e.stack || e));
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection] (still running)', e && e.stack || e));
  startServer().then((h) => {
    const bye = () => { try { h.saveNow(); } catch { /* ignore */ } process.exit(0); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  }).catch((e) => {
    console.error('');
    console.error(e.friendly || ('Could not start the server: ' + (e && e.message)));
    console.error('');
    process.exit(1);
  });
}
