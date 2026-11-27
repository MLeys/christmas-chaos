# Christmas Chaos v2 — Technical blueprint

Read with `SPEC.md` (game rules, stages, design system). The canvas artboards in
`scratchpad/canvas/project/*.dc.html` are the visual reference for every screen and stage.
Old v1 review findings (all must be fixed): `scratchpad/review/code-review-results.json`
(keys playtest, visual, server-code, client-code, game-design).

## 1. Layout

```
christmas-chaos/
  server.js            entry: express + socket.io wiring, routes, host auth, autosave, startup banner
  src/
    game.js            PURE state machine (no sockets, no fs). createGame({content, rng, now, onChange, schedule})
    content.js         load + validate data/*.json; "bags" that never repeat until exhausted (per category+difficulty)
    views.js           publicView(game), hostView(game), playerView(game, clientId)  — the ONLY place secrets are filtered
    match.js           normalize + fuzzy-match typed answers against answer/accept (case, punctuation, articles, small typos)
    net.js             pickLanAddress() + candidates
    scheduler.js       cancellable timers with generation tokens (reset / next turn cancel everything pending)
  data/                trivia-christmas.json trivia-popculture.json songs.json lists.json dares.json showdowns.json finals.json
  public/
    index.html         PLAYER (phone) — served at "/" (the QR code points here)
    tv.html            BIG SCREEN — "/tv"
    host.html          HOST — "/host"
    assets/
      tokens.css       design tokens, fonts, base, shared components (buttons, chips, team disc, timer ring, toast…)
      tv.css host.css player.css
      icons.js         Lucide icon inner-SVG strings + icon(name, {size, stroke, color, label})
      wheel.js         createWheel(svgEl, segments) → {spinTo(index, ms, onTick), restOn(index), highlight(index|null)}
      sound.js         Web Audio synth: unlock(), tick(), land(), buzz(), correct(), wrong(), beep(), fanfare(), applause(), whoosh(); setVolume(); mute
      client.js        connect(role) with clientId identity + auto re-hello on every (re)connect, server clock offset,
                       esc() HTML escaping, h`` tagged-template helper that escapes by default, toast(), timerText(), wakeLock(), vibrate()
      tv.js host.js player.js
  test/
    game.test.js       node:test unit tests of src/game.js (+ content, match, views)
    e2e.test.js        boots server on a random port; socket.io-client host/tv/6–8 players play complete games
    ui-smoke.mjs       playwright-core + msedge: drives a scripted game, screenshots every stage of every screen,
                       asserts no console errors / no horizontal overflow; screenshots → test/screens/ (gitignored)
  scripts/setup-firewall.ps1   self-elevating; inbound TCP rule for the port on Private+Public profiles
  saves/               autosave (gitignored)
  README.md            setup, party-day checklist, troubleshooting (firewall, VPN, Wi-Fi isolation), how to edit content
```
Dependencies (ALREADY INSTALLED — do not reinstall or change versions): `express`, `socket.io`, `qrcode`, `@fontsource/lilita-one`, `@fontsource/fredoka`.
Fonts are served locally (TV works with no internet): server mounts `node_modules/@fontsource/lilita-one/files` at `/fonts/lilita-one/`
and `node_modules/@fontsource/fredoka/files` at `/fonts/fredoka/`. Files: `/fonts/lilita-one/lilita-one-latin-400-normal.woff2`,
`/fonts/fredoka/fredoka-latin-{400,500,600,700}-normal.woff2`. tokens.css declares the @font-face rules (font-display: swap) with system fallbacks. Dev: `socket.io-client`, `playwright-core`.
Scripts: `npm start`, `npm test` (unit + e2e), `npm run test:ui`, `npm run firewall`.
Node ≥ 18, no build step, no frontend framework (vanilla ES modules).

## 2. Server rules (fixes for every v1 bug)
- **Identity:** each phone generates `clientId` (random, `localStorage['cc.clientId']`; `crypto.randomUUID` is unavailable on plain-http LAN — use Math.random/`crypto.getRandomValues`). Players are keyed by clientId, never socket.id. Disconnect sets `connected:false`; never deletes. Every (re)connect sends `hello`, which rebinds the socket. Refresh returns you to the same team automatically.
- **Teams have stable ids** (`t1`, `t2`…). Removing a team unassigns its players (they see the team picker again with a toast); nobody else is affected. Removal only in lobby; mid-game the host can rename / move players instead.
- **Host authorization:** sockets from loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) are hosts. Others must `hello` with `hostKey` = a 4-digit PIN generated at boot, printed in the console and shown on the host screen ("Add a second host device: PIN 4821"). All `host:*` events from non-hosts are rejected with `{ok:false,error:'not-host'}`.
- **Never crash:** every handler is wrapped (validate types, ranges, ids; try/catch; reply via ack `{ok, error}`). `process.on('uncaughtException'|'unhandledRejection')` logs and keeps running. Port in use → friendly message.
- **Phase guards everywhere:** each event lists the phases/stages it is valid in; anything else is rejected. `host:nextTurn` must include the current `turnId` (idempotent; a double click cannot skip a team). Spin accepted once per spin window.
- **Scheduler with generations:** spin resolution, timers, arming delays and vote deadlines are scheduled through scheduler.js; reset/next-turn/new-stage bump the generation so stale callbacks are ignored.
- **Secrets never leave the server early:** answers, accept lists, hints (until shown), song titles, dare secrets, list answers, final answers/wagers of other teams are only in hostView or the one performer's playerView.
- **Scoring through one function** `award(teamId, delta, reason)` that applies the Double Down multiplier (only active team, only positive, only this turn), floors scores at 0, pushes onto the undo stack, records `lastAwards` for animations, updates stats.
- **Autosave** the full game (not sockets) to `saves/autosave.json` (debounced 1 s). On boot, if a non-lobby save exists, host view shows "Resume saved game?" (Resume / Start fresh).
- **Rounds** default = clamp(round(20/teams),3,6) until the host changes it manually (`autoRounds:false`).
- **Content bags:** no question/dare/song/list/showdown repeats within a game, and "Play again" continues the bags (no repeats across games until exhausted). Hot Seat & All Play draw easy/medium trivia with short answers (≤ 4 words) from both categories.
- **LAN address:** skip internal, 169.254.*, and interfaces matching `/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier|VPN|TAP|Cisco|AnyConnect|GlobalProtect|Zscaler|Bluetooth/i`; prefer `/Wi-?Fi|Wireless|WLAN|Ethernet/i` and 192.168/10/172.16-31 ranges; `HOST_IP` env override. joinUrl = `http://<ip>:<port>/` (no path). Host lobby lets the host switch between candidates if there are several.
- **Startup banner:** join URL, TV URL, host URL, PIN, and a firewall/VPN tip.
- **Routes:** `/` player, `/tv`, `/host`, `/api/info` → `{joinUrl, candidates, port}`, `/api/qr.svg` → QR (cream background, night modules) of the current joinUrl. `/player` redirects to `/` for old bookmarks.

## 3. Socket protocol
Every client→server event takes an ack callback `(res) => res.ok ? … : showError(res.error)`.

**hello** `{role:'player'|'tv'|'host', clientId, hostKey?}` → `{ok, isHost, me}`. Server then pushes `state`.

Player events: `join {name, teamId}` · `spin` · `pickDifficulty {level:'easy'|'medium'|'hard'}` · `buzz` · `pickTarget {teamId}` (grinch steal / showdown rival) · `submitAnswer {text}` (all play / round bonus / final; ≤ 80 chars; per team, last one wins, allowed until time/lock) · `wager {amount}` (final; integer within bounds; per team) · `vote {choice:'nailed'|'good'}` (other teams only, once per player).

Host events (prefix `host:`): `createTeam {name, mascot}` · `updateTeam {teamId, name?, mascot?}` · `removeTeam {teamId}` · `movePlayer {playerId, teamId|null}` · `kickPlayer {playerId}` · `setRounds {n}` · `setOption {key:'roundBonus'|'sound'|'joinIp', value}` · `start` · `spin` (on behalf of the active team) · `judge {result:'correct'|'wrong'}` (trivia / sound-it-out / steal answers) · `openSteal` · `reveal` · `showHint` · `timer {action:'start'|'pause'|'resume'|'add', seconds?}` · `rerollPerformer` · `swapQuestion` · `dareResult {result:'nailed'|'valiant'|'fail', bonus?:boolean}` · `openVote` · `closeVote` · `showdownResult {winner:'active'|'rival'|'tie'}` · `listTick {answer}` · `listUntick {answer}` · `listOther` · `hotseatMark {result:'correct'|'wrong'|'pass'}` · `markAnswer {teamId, correct}` · `revealAnswers` · `finalStartAnswering` · `finalRevealNext` · `adjustScore {teamId, delta}` · `undo` · `nextTurn {turnId}` · `continue` (round break / final intro / steps) · `resetGame {keepTeams:boolean}` (keeps players when keeping teams) · `resume` / `discardSave` · `forceSegment {index}` (debug, behind a "More" menu).

Server→client: **state** (role-specific view, pushed on every change, coalesced ≤ 30 ms) and **fx** one-shots for sound/animation: `spinStart {segmentIndex, startedAt, durationMs}`, `land {segmentIndex}`, `buzz {teamId, name}`, `correct`, `wrong`, `points {teamId, delta}`, `timerWarn`, `timerEnd`, `vote`, `steal {from, to, amount}`, `round {round}`, `podium`. Clients must render correctly from `state` alone (a refreshed TV mid-anything shows the right screen; wheel rests on the last segment).

### 3.1 publicView (TV and the base of every view)
```
{ now, phase:'lobby'|'turnIntro'|'spinning'|'challenge'|'turnResult'|'roundBreak'|'finalIntro'|'finalWager'|'finalAnswer'|'finalReveal'|'podium',
  joinUrl, settings:{rounds, autoRounds, roundBonus, sound},
  round, totalRounds, turnIndex, turnsPerRound, turnId,
  teams:[{id,name,mascot,color,score,rank,connectedCount,playerCount,multiplier}],   // turn order
  players:[{id,name,teamId,connected}],
  activeTeamId, segments:[{index,type,label,lines:[..],color,ink,icon,rule}], lastSegmentIndex,
  spin:{segmentIndex,startedAt,durationMs}|null,
  challenge:null|{ type, stage, segmentIndex, rule, points, category?, difficulty?, question?, hint?, answer?, funFact?,
     performer?:{playerId,name,teamId}, rival?:{teamId,playerId,name}, dare?:{title,instructions,who,time,props,judge,hasSecret},
     showdown?:{title,instructions,time,winner}, list?:{prompt,ticked:[...],count,max}, hotseat?:{index,total,results:[...],question},
     buzz?:{open,armingUntil,eligibleTeamIds,lockedTeamIds,winner:{playerId,name,teamId}|null},
     submissions?:[{teamId,answered,text?,correct?,first?}],          // text/correct only after reveal
     vote?:{open,endsAt,nailed,good,voters,eligible}, targets?:[teamId], gift?:{toTeamId,amount},
     result?:{kind, awards:[{teamId,delta}]} },
  timer:{running,endsAt,durationMs,remainingMs,label}|null,
  lastAwards:[{id,teamId,delta,reason}],
  final:null|{category,question?,wagers:[{teamId,locked}],submissions:[{teamId,answered}],revealOrder:[teamId],revealed:[{teamId,text,wager,correct,delta}]},
  podium:null|{standings:[{teamId,score,place}],awards:[{key,title,name,teamId,detail}]},
  savedGame:null|{summary} }
```
**hostView** = publicView + `host:{ isHost:true, pin, candidates, answer, accept, hint, funFact, secret, song:{title,artist}, listAnswers, hotseatAnswer, submissions:[{teamId,text,by,autoCorrect,correct}], final:{wagers:[{teamId,amount,locked}],rows:[{teamId,text,wager,correct}] , answer, accept}, canUndo, undoLabel, contentStats }`.
**hostView.host.coach** (server-generated live directions, recomputed on every state change — see SPEC "Host login + live directions"):
`{ headline, say: string|null, steps: [string], tips: [string], actions: [{id, label, event, payload, kind:'primary'|'secondary'|'danger'|'success', shortcut, confirm?: string, disabled?: boolean, reason?: string}] }`.
The host UI renders the action buttons generically from this list (so the host always has exactly the right buttons), plus persistent tools (score ±, undo, timer, more menu). Also `hostView.host.introScript` (welcome + how-to-play, with joinUrl) for the lobby.
Host auth flow: `hello {role:'host', hostKey?}` → `{ok, isHost}`; non-loopback without a valid key gets `{ok:true, isHost:false, needPin:true}` and only a minimal view; `hostLogin {pin}` → `{ok}` stores key in localStorage `cc.hostKey`; wrong PIN → `{ok:false, error:'bad-pin'}` with a small rate limit (5 tries / minute / socket).

**playerView** = publicView + `me:{playerId,name,teamId}|null`, `secret:{label,value}|null` (performer only), `myTeam:{submission:{text,by}|null, wager:{amount,locked,by}|null}`, `myVote`, `can:{spin,pickDifficulty,buzz,pickTarget,submitAnswer,wager,vote}` (server-computed — the phone shows exactly the action it can take).

## 4. Client rules
- All user-provided text rendered escaped (`esc()` / `h```). No inline handlers built from strings.
- Player: remembers identity; "Reconnecting…" banner when offline; Wake Lock while joined (when supported); vibrate on your turn / buzz win / called up; `touch-action: manipulation` (no double-tap zoom) but pinch-zoom allowed; body text ≥ 18 px; primary actions ≥ 64 px; SPIN/BUZZ ≥ 260 px circles with press feedback on pointerdown; layout works 320–430 px wide with no horizontal scroll.
- TV: designed at 1920×1080 but scales with viewport (use `vh/vw`-based root sizing so 1280×720 and 4K look identical); "Click to start the show" overlay unlocks audio + fullscreen; mute toggle; sounds per SPEC; the wheel spins via `spin.startedAt` + server clock offset so a late-joining TV syncs; `prefers-reduced-motion` honoured; aria-live region announces results.
- Host: one obvious next action per stage, keyboard shortcuts (C, W, R, T, N, U for undo, H hint, V vote), confirmation for destructive actions, works at 1024 px+ and stacks on tablets; mirrors what's on the TV.
- Match the artboards: same tokens, type, components, layouts per stage.

## 5. Acceptance tests (all must pass; each v1 bug has a test)
1. A player's socket drops and reconnects (new socket id) → same player, can spin and buzz.
2. Page refresh (new socket, same clientId) → restored to the same team with no re-typing.
3. Reset "play again keeping teams" keeps players; game 2 is playable from phones; no question repeats.
4. Removing a team in the lobby unassigns only its players; other phones keep correct teams (ids stable).
5. Every `host:*` event from a player socket is rejected; host PIN grants host from a second device.
6. 200 random/malformed payloads across all events never crash the server (process still answers `hello`).
7. Reset / nextTurn during a spin cancels it; no stale result lands; lobby not locked.
8. nextTurn with stale turnId is ignored (double-click cannot skip a team); nextTurn rejected in lobby/podium.
9. Trivia: only the active team picks difficulty; steal opens only for other teams after the 3 s arm; wrong steal locks that team; each team one try.
10. Double Down: only the active team, only positive awards, expires at nextTurn.
11. Grinch Steal: targets are only teams ahead; amount capped at victim score; single use; leader gift variant.
12. Sound It Out / dare secrets appear only in the performer's playerView and hostView; publicView never has song title / secret / answers before reveal (scan every publicView emitted during a full game for answer strings).
13. All Play typed: submissions per team (last wins), auto-match incl. accept list and small typos, +50 to first correct, host can flip.
14. Final: wager bounds 0..max(score,300); reveal order lowest→highest; ±wager floored at 0; ties share places on the podium.
15. Undo restores the exact previous scores (multi-level).
16. Rounds formula; manual rounds survive adding/removing teams.
17. Full simulated games for 2, 4, 6 and 8 teams reach the podium with every segment type exercised at least once (use forceSegment in tests).
18. Content files validate (schema, counts, unique ids, no answer text inside its question).
19. UI smoke: every stage of TV (1920×1080 and 1280×720), host (1440×900 and 1024×768) and player (390×844 and 360×740) renders with zero console errors and no horizontal overflow; screenshots saved for review.
