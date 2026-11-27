# Christmas Chaos v2 — Socket protocol (as implemented)

This is the **actual** protocol of `server.js` + `src/game.js` + `src/views.js`. It extends TECH.md §3; every
extension is marked **(ext)**. All examples at the end were generated from a real scripted game, so field names are exact.

- Transport: socket.io 4 (the server serves the client at `/socket.io/socket.io.js` and `/socket.io/socket.io.esm.min.js`).
- Times (`now`, `endsAt`, `startedAt`, `armingUntil`, `at`) are **server epoch ms**. Every view carries `now`; compute
  `offset = view.now - Date.now()` on receipt and use `Date.now() + offset` for countdowns/wheel sync.
- Pushes are coalesced (≤ 30 ms). The server sends a fresh role-filtered `state` after **every** change, then any queued `fx`.
  **Render from `state` alone**; `fx` is only for one-shot sound/animation.

---

## 1. Connecting and identity

```
socket.emit('hello', { role: 'player' | 'tv' | 'host', clientId?, hostKey? }, ack)
ack -> { ok: true, role, isHost, me: {playerId, name, teamId} | null, serverNow }
     | { ok: false, error, needPin? }
```
- Send `hello` on **every** `connect` event (socket.io reconnects with a new socket id; `hello` rebinds it). Then the
  server pushes `state` to that socket immediately.
- **Player**: `clientId` is required, `/^[A-Za-z0-9_-]{6,64}$/` (generate once, keep in `localStorage['cc.clientId']`).
  The player record is keyed by clientId; `me` is non-null if this clientId has joined before (refresh = same team).
  The public `playerId` (`p1`, `p2`…) is NOT the clientId — clientIds never appear in any view.
- **TV**: no clientId needed. Gets `publicView`.
- **Host**: sockets from loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) are hosts. Other devices must send
  `hostKey: '<4-digit PIN>'` (PIN shown in the host view as `host.pin` and in the console). Errors: `need-pin`
  (no key sent), `bad-pin`, `pin-locked` (8 wrong PINs from one address → locked 5 min). On `needPin:true` show a PIN field
  and call `hello` again with `hostKey`; remember it (e.g. sessionStorage) so re-hello after reconnect keeps working.
- A socket may re-`hello` with a different role at any time (it leaves the old role).
- Disconnect marks the player `connected:false`; players are never deleted except by `host:kickPlayer`.

## 2. Acks and errors

Every client→server event takes an ack: `(res) => res.ok ? … : showError(res.error)`. `res` is
`{ ok: true, ...extra }` or `{ ok: false, error: '<code>' }`. Handlers never throw; unknown events ack `unknown-event`.

Common codes: `hello-first`, `not-player` (event needs role player), `not-host`, `not-joined`, `no-team`, `not-your-turn`,
`not-now` (wrong phase/stage), `slow-down` (> 60 events/s from one socket), `server-error` (bug; logged), `unknown-event`.
Event-specific codes are listed with each event.

## 3. Player events (role `player`)

| Event | Payload | Valid when | Effect / extra ack fields | Errors |
|---|---|---|---|---|
| `join` | `{name, teamId}` | always; mid-game only if you have no team yet | creates/updates your player. name trimmed, control chars stripped, ≤ 20 chars. Lobby: re-join = switch team. ack `{ok, me}` | `name-required`, `no-such-team`, `ask-host` (mid-game team switch: host must `movePlayer`), `game-full` |
| `spin` | — | `can.spin`: phase `turnIntro`, or challenge `doubledown/spinAgain`; your team is active | starts a spin (accepted once per spin window) | `not-your-turn`, `not-now` |
| `pickDifficulty` | `{level:'easy'\|'medium'\|'hard'}` | trivia `pickDifficulty`, your team active; first tap wins | question drawn, 20 s timer starts | `bad-level` |
| `buzz` | — | `can.buzz`: trivia/sounditout `steal`, `buzz.open`, your team eligible & not locked | you are `buzz.winner`; buzzers close | `arming` (still in the 3 s get-ready), `locked-out`, `not-eligible`, `not-now` |
| `pickTarget` | `{teamId}` | grinch `pickTarget` or showdown `pickRival`, your team active; `teamId` ∈ `challenge.targets` | grinch: steal happens immediately; showdown: players called up | `bad-target` |
| `submitAnswer` | `{text}` | allplay `answering`, bonus `answering` (phase roundBreak), or phase `finalAnswer` | per team, **last submission wins** until time/lock; text trimmed, ≤ 80 chars (longer is truncated) | `empty-answer` |
| `wager` | `{amount}` | phase `finalWager` | per team, last lock-in wins. `amount` must be an **integer** `0..myTeam.maxWager` (= max(score,300)) | `bad-amount` |
| `vote` | `{choice:'nailed'\|'good'}` | dare `vote` stage, vote open, your team is NOT active, once per player | counted; when every connected eligible player has voted the vote closes early | `not-eligible`, `already-voted`, `bad-choice` |

## 4. Host events (role `host`, authorised)

All return `{ok:false, error:'not-host'}` from any non-host socket. "Stage" refers to `challenge.stage`.

| Event | Payload | Valid when | Effect | Errors |
|---|---|---|---|---|
| `host:createTeam` | `{name, mascot?, color?}` | lobby, < 8 teams | team id `t<n>` (never reused). mascot ∈ `star bell candy-cane tree-pine gift cookie moon snowflake` (default first free); color defaults to the mascot's paired colour **(ext: optional `color` from the 8-colour palette)**. ack `{ok, teamId}` | `name-required`, `name-taken`, `bad-mascot`, `mascot-taken`, `bad-color`, `too-many-teams` |
| `host:updateTeam` | `{teamId, name?, mascot?, color?}` | always (rename mid-game OK) | | `no-such-team`, `name-required`, `name-taken`, `bad-mascot`, `bad-color` |
| `host:removeTeam` | `{teamId}` | lobby | its players get `teamId:null` (phone shows the team picker; fx `teamRemoved`) | `no-such-team` |
| `host:movePlayer` | `{playerId, teamId\|null}` | always | | `no-such-player`, `no-such-team` |
| `host:kickPlayer` | `{playerId}` | always | deletes the player; that phone gets `me:null` | `no-such-player` |
| `host:setRounds` | `{n}` integer 1..8 | lobby / in turn / roundBreak; `n ≥ round` once started | `settings.autoRounds=false` (never overwritten again) | `bad-rounds`, `below-current-round` |
| `host:setOption` | `{key, value}` | always | `roundBonus` (bool, stops auto), `sound` (bool), `joinIp` (string ∈ `host.candidates[].address`; changes `joinUrl` + QR) | `bad-option`, `bad-ip` |
| `host:start` | — | lobby, ≥ 2 teams | scores 0, round 1, first team's `turnIntro`; discards a pending saved game | `need-two-teams` |
| `host:spin` | — | like player `spin` | spin on behalf of the active team | |
| `host:forceSegment` | `{index}` 0..11 | like `spin` | spin that lands on `index` (debug / tests) | `bad-index` |
| `host:pickDifficulty` **(ext)** | `{level}` | trivia `pickDifficulty` | on behalf of the team | `bad-level` |
| `host:pickTarget` **(ext)** | `{teamId}` | grinch `pickTarget` / showdown `pickRival` | on behalf of the team | `bad-target` |
| `host:judge` | `{result:'correct'\|'wrong'}` | trivia `question`, sounditout `perform`, or `steal` with a `buzz.winner` | correct: points + `done`. wrong (active team): steal opens (3 s arm). wrong (stealer): that team is locked out; buzzers stay closed until `openSteal`; when no team is left → `done` | `bad-result` |
| `host:openSteal` | — | trivia `question` / sounditout `perform` (= judge wrong), or `steal` stage with buzzers closed, no winner, not arming, teams left | (re)arms the steal for the remaining teams | `no-teams-left` |
| `host:reveal` | — | trivia/sounditout not yet revealed (ends it, no more points); dare with an unrevealed secret (shows it, dare continues); rapidlist (shows all valid answers, ends the list) | | |
| `host:showHint` | — | trivia `question` / sounditout `perform`, hint exists, not shown | hint becomes public; `points` halved (steal = half of that) | `no-hint` |
| `host:timer` | `{action:'start'\|'pause'\|'resume'\|'add', seconds?}` | a timer exists | start (also restarts an ended timer), pause, resume (paused only), add `seconds` 1..300 (default 10; adding to an ended timer restarts it) | `no-timer`, `already-running`, `not-running`, `not-paused`, `bad-seconds`, `bad-action` |
| `host:rerollPerformer` | `{side?:'active'\|'rival'}` | dare/sounditout `perform`, hotseat before Q1, showdown `battle` (side: re-roll one; default both) | new random player (fewest picks first); dare secret is re-drawn | `no-players`, `bad-side` |
| `host:swapQuestion` | — | trivia `question` (same category+difficulty, timer restarts), sounditout/dare `perform`, showdown `battle`, rapidlist `list` (no ticks yet), hotseat (current question), allplay/bonus `answering` (clears answers), `finalIntro`/`finalWager` | draws an unused replacement | |
| `host:endChallenge` **(ext)** | — | phase `challenge`, not doubledown, not done | ends the mini-game with no further points (`result.kind:'skipped'`) | |
| `host:dareResult` | `{result:'nailed'\|'valiant'\|'fail', bonus?:bool}` | dare `perform`/`vote`/`done` | 200/100/0 (+50 crowd favourite), ×2 under Double Down. In `done` it **re-judges** (overrides the room vote / adds the bonus): the team's dare points are moved to the new total. `bonus` omitted = keep previous | `bad-result` |
| `host:openVote` | — | dare `perform` | stage `vote`, 15 s `vote` timer, other teams' phones get `can.vote` | |
| `host:closeVote` | — | dare `vote`, open | majority sets the result (tie → nailed; no votes → valiant) and scores it | |
| `host:showdownResult` | `{winner:'active'\|'rival'\|'tie'}` | showdown `battle` | winner 200 (active ×2 under DD), tie 100 each | `bad-winner` |
| `host:listTick` | `{answer}` (exact string from `host.listAnswers`) | rapidlist `list`/`done` | live: team total = min(count,6)×50 (auto-starts the timer if not started) | `bad-answer`, `already-ticked` |
| `host:listUntick` | `{answer}` (a ticked string, incl. `"Other answer"`) | rapidlist `list`/`done` | removes the last matching tick, re-settles points | `bad-answer` |
| `host:listOther` | — | rapidlist `list`/`done` | adds an `"Other answer"` chip (counts like a tick) | |
| `host:hotseatMark` | `{result:'correct'\|'wrong'\|'pass', index?}` | hotseat `hotseat`, questions left | +50 on correct, next question; after Q6 → `done`. **Send `index: challenge.hotseat.index`** so a double click cannot mark two questions. First mark auto-starts the clock | `bad-result`, `stale-question` |
| `host:markAnswer` | `{teamId, correct:bool}` | allplay/bonus `answering`/`marking`/`done`; `finalAnswer`; `finalReveal` | overrides the auto-mark. In `done` (allplay) it re-settles points (+50 first may move). In `finalReveal`: unrevealed row = pre-mark; revealed row = judge it now (±wager) or flip it | `no-such-team`, `bad-correct`, `no-answer` |
| `host:revealAnswers` | — | allplay/bonus `answering`/`marking` | stage `done`, answers + ✓/✗ public, points: 100 each correct, +50 first correct (allplay only; first = earliest final submission) | |
| `host:finalStartAnswering` | — | `finalWager` | missing wagers = 0; phase `finalAnswer`, 45 s timer | |
| `host:finalRevealNext` | — | `finalReveal` | step: if the current row is revealed but unjudged → judge it (host mark or auto-mark); else reveal the next team (lowest pre-final score first); when all judged → `podium` | |
| `host:adjustScore` | `{teamId, delta}` integer, ≠0, abs ≤ 10000 | not lobby | manual ±, never doubled, floor 0 | `no-such-team`, `bad-delta` |
| `host:undo` | — | undo stack not empty | restores the exact scores before the last score change (multi-level; grouped actions such as a steal or an All Play reveal are one step) | `nothing-to-undo` |
| `host:nextTurn` | `{turnId}` (= `state.turnId`) | `turnIntro`/`spinning`/`challenge`/`turnResult` | cancels anything pending (spin, timers), next team's `turnIntro`, or `roundBreak` after the last team, or `finalIntro` after the last round | `stale-turn`, `not-now` |
| `host:continue` | — | see §5 "continue" | the one generic "next step" button | `not-now` |
| `host:resetGame` | `{keepTeams:boolean}` (default true) | always | back to lobby; keepTeams keeps teams (score 0) **and players**; false removes teams and unassigns players. Content bags continue (no repeats in the next game) | `bad-option` |
| `host:resume` | — | a saved game is offered (`savedGame` non-null) | restores it (timers come back paused; a spin in flight lands) | `no-save`, `bad-save` |
| `host:discardSave` | — | a saved game is offered | forget it | `no-save` |

## 5. Phases, stages and transitions

```
lobby --start--> turnIntro --spin--> spinning --(spinMs, 5 s)--> challenge --(mini-game ends)--> turnResult
   ^                ^  |                                            |   ^                          |
   |                |  +-------------- nextTurn (any of these 4 phases, needs turnId) -------------+
   |                |                                                    (doubledown: spin again from challenge)
   |                +-- next team ----------------------------------------------------------------+
   |                +-- roundBreak --continue--> [bonus answering --continue--> marking --continue--> done] --continue--> turnIntro (next round)
   |                                                     (after the last round: finalIntro instead of roundBreak)
   |  finalIntro --continue--> finalWager --(30 s | finalStartAnswering | continue)--> finalAnswer --(45 s | continue)--> finalReveal
   |  finalReveal --finalRevealNext/markAnswer ... --> podium
   +---------------------------------------------- resetGame (from anywhere) ---------------------------------------------------+
```

`phase` ∈ `lobby | turnIntro | spinning | challenge | turnResult | roundBreak | finalIntro | finalWager | finalAnswer | finalReveal | podium`.
In `turnResult` the finished challenge stays in `state.challenge` with `stage:'done'` and a `result`.

### Challenge types and stages (`challenge.type` / `challenge.stage`)

| type (segments) | stages in order | how it moves |
|---|---|---|
| `trivia` (0,4 Christmas; 2 Pop Culture — see `category`) | `pickDifficulty` → `question` → [`steal`] → `done` | team picks (phone or host) → 20 s timer auto-starts → `judge correct` = done; `judge wrong` **or time-out** = `steal`: `buzz.armingUntil` = now+3 s, then `buzz.open` (10 s `steal` timer) → buzz → judge → correct = done (stealer gets `stealPoints`), wrong = team locked, host `openSteal` to re-arm for the rest; steal timer runs out / no teams left / `reveal` = done (`missed`) |
| `sounditout` (5) | `perform` → [`steal`] → `done` | 30 s `sound` timer is **prepared, host starts it**; performer's phone has `secret`; correct = 200; wrong or time-out = steal for 100 (same buzz mechanics) |
| `dare` (1,8) | `perform` → [`vote`] → `done` | dare timer (dare.time) prepared, host starts it; host `dareResult` directly, or `openVote` → 15 s vote → closes (timer / all voted / `closeVote`) → scored. `dareResult` again in `done` re-judges |
| `showdown` (7) | `pickRival` → `battle` → `done` | team picks a rival (phone or host) → one player from each team called up (`performer`, `rival`) → timer prepared, host starts → `showdownResult` |
| `rapidlist` (9) | `list` → `done` | 30 s timer prepared (host starts, or first tick starts it); ticks are scored live; time-out or `continue` = done; ticks still allowed in `done` |
| `hotseat` (3) | `hotseat` → `done` | 45 s timer prepared (host starts, or the first mark starts it); `hotseat.question` is public only once the clock started; done after Q6 or time-out |
| `allplay` (10) | `answering` → `marking` → `done` | 20 s timer auto-starts; time-out or `continue` = `marking` (answers locked); `revealAnswers` (or `continue` in marking) = done |
| `grinch` (6) | `pickTarget` → `done`, or straight to `done` | targets = teams with a strictly higher score. Nobody ahead (leader) → immediately `done` with `gift:{toTeamId, amount:100}` to the lowest-score team (ties: first in turn order) |
| `doubledown` (11) | `spinAgain` | the active team's multiplier becomes 2 for the rest of the turn; `can.spin` is true again; the next spin replaces the challenge. Landing it again keeps ×2 |
| `bonus` **(ext)** (round break, `segmentIndex:null`, phase stays `roundBreak`) | `answering` → `marking` → `done` | only if `settings.roundBonus`; 100 per correct team, no first bonus, never doubled |

`challenge.result.kind` ∈ `correct | stolen | missed | nailed | valiant | fail | win | tie | list | hotseat | allplay | bonus | steal | gift | skipped`.

### `host:continue` does, per phase/stage
- `roundBreak`: no challenge → start the bonus question if `settings.roundBonus` and not done yet, else next round (or `finalIntro` if rounds were shortened); bonus `answering` → `marking`; `marking` → reveal; `done` → next round.
- `challenge`: allplay `answering` → `marking`; allplay `marking` → reveal; rapidlist `list` → done; hotseat → done; dare `vote` (open) → close vote. Anything else: `not-now` (use the specific events).
- `finalIntro` → `finalWager` (30 s `wager` timer). `finalWager` → `finalAnswer`. `finalAnswer` → `finalReveal`. `finalReveal` → same as `finalRevealNext`.
- `turnResult` is NOT handled by continue — use `host:nextTurn {turnId}`.
- `host.can.continue` tells whether it does anything right now.

## 6. Server → client events

### `state` — the role's view (see §7)

### `fx` — one-shots `{ type, at, ...payload }` (all public; never contain secrets)
| type | payload | when |
|---|---|---|
| `spinStart` | `segmentIndex, startedAt, durationMs, teamId, by:{playerId,name}\|null` | spin begins (TV spins to `segmentIndex`) |
| `land` | `segmentIndex, segmentType, teamId` | wheel stopped, challenge built |
| `buzz` | `teamId, name, playerId` | first buzz in a steal |
| `armed` **(ext)** | `eligibleTeamIds` | steal buzzers just armed (after the 3 s countdown) |
| `correct` | `teamId, steal?, small?` | a correct judgement (small = hot seat tick) |
| `wrong` | `teamId, steal?, timeUp?, small?` | wrong judgement / time-up |
| `points` | `teamId, delta, reason, doubled` | every score change (also undo: reason `"Undo"`) |
| `timerWarn` | `kind` | 5 s left on a running timer |
| `timerEnd` | `kind` | a timer hit 0 |
| `vote` | `nailed, good, voters` (+ `opened` / `closed, result`) | room vote opened / a vote came in / closed |
| `steal` | `from, to, amount` | Grinch steal executed |
| `round` | `round` | a round starts (1 at game start) |
| `podium` | — | podium reached |
| `turn` **(ext)** | `teamId, turnId, round` | a team's turn starts (phones vibrate if it's theirs) |
| `doubleDown` **(ext)** | `teamId` | Double Down landed |
| `calledUp` **(ext)** | `playerIds, kind` | performer(s)/showdown players picked (vibrate those phones) |
| `teamRemoved` **(ext)** | `teamId, name` | lobby team removed (its phones show a toast + team picker) |
| `joined` / `answered` / `wagered` **(ext)** | `playerId, teamId` / `teamId` / `teamId` | for little "ding"s |
| `reveal` **(ext)** | `teamId?` | answer revealed / final row revealed |
| `final` **(ext)** | — | Final Chaos intro |

## 7. Views

Every view = `publicView` (+ role extras). Objects are built field by field from whitelists in `src/views.js`.

### 7.1 publicView (TV, and the base of everything)
```
now, phase, gameNo, joinUrl,
settings: {rounds, autoRounds, roundBonus, roundBonusAuto, sound, estimatedMinutes},
round, totalRounds, turnIndex, turnsPerRound, turnId,
teams: [{id, name, mascot, color, score, rank, connectedCount, playerCount, multiplier}]   // turn order; rank shares ties (1,1,3)
players: [{id, name, teamId|null, connected}],
activeTeamId,                // null outside turnIntro/spinning/challenge/turnResult
segments: [12 x {index, type, category?, label, lines, color, ink, icon, points, rule}],
lastSegmentIndex,            // where the wheel rests
spin: {segmentIndex, startedAt, durationMs, by:{playerId,name}|null} | null   // only during phase 'spinning'
challenge: null | {...see 7.2},
timer: null | {kind, label, running, endsAt|null, durationMs, remainingMs, started, ended},
lastAwards: [{id, teamId, delta, reason, doubled}],   // last 12; animate ids you haven't seen
roundBreak: null | {round, nextRound, finalNext, bonusDone, bonusPlanned},   (ext) only in phase roundBreak
final: null | {category, categoryLabel, question|null, wagers:[{teamId, locked}], submissions:[{teamId, answered}],
               revealOrder:[teamId], revealed:[{teamId, text, by, wager, judged, correct|null, delta|null, before, after|null}],
               current: teamId|null, done, answer|null},
podium: null | {standings:[{teamId, score, place}], awards:[{key:'fastestFinger'|'starPerformer', title, playerId, name, teamId, detail}]},
savedGame: null | {summary:{savedAt, phase, round, totalRounds, teams:[{name, score}], players}}
```
Timer kinds: `trivia sound steal dare showdown list hotseat allplay bonus vote wager final`.

### 7.2 `challenge` (public)
Common: `id, type, stage, segmentIndex, rule, points, started, revealed, result:{kind, awards:[{teamId, delta}]}|null`.
- `trivia`: `category ('christmas'|'popculture'), categoryLabel, difficulty?, pickedBy?:{playerId,name}|null, question?, stealPoints?, hasHint?, hint? (only after showHint), answer? funFact? (only when revealed), buzz:null|{open, armingUntil, eligibleTeamIds, lockedTeamIds, winner:{playerId,name,teamId}|null}`
- `sounditout`: `performer:{playerId,name,teamId}|null, stealPoints, hasHint, hint?, answer? artist? (only when revealed — the song is NEVER public before), buzz`
- `dare`: `performer, partner (pair dares) , dare:{title, instructions, who:'one'|'pair'|'team'|'everyone', time, props, judge, hasSecret}, answer? (the secret, after reveal/done), vote:null|{open, endsAt, nailed, good, voters, eligible, result}, dareResult:null|{result, bonus}`
- `showdown`: `targets, performer, rival:{teamId, playerId|null, name|null}|null, showdown:{title, instructions, time, winner, props}|null, winnerSide:'active'|'rival'|'tie'|null`
- `rapidlist`: `list:{prompt, ticked:[string], count, max:6, each:50, answers? (only after host reveal)}`
- `hotseat`: `performer, hotseat:{index, total, results:['correct'|'wrong'|'pass'], question|null, each:50}`
- `allplay` / `bonus`: `question, submissions:[{teamId, answered}]` → after reveal each row also has `text, name, correct, first, delta`; plus `answer, funFact, firstTeamId`; allplay has `firstBonus:50`
- `grinch`: `targets, gift:{toTeamId, amount}|null, steal:{from, to, amount}|null`
- `doubledown`: nothing extra (see `teams[].multiplier`)

### 7.3 hostView = publicView + `host`
```
host: { isHost:true, pin, candidates:[{address, iface}], joinIp,
  answer, accept[], hint, funFact,                 // current trivia / allplay / bonus question (or song title for sounditout)
  secret:{label, value, detail}|null,              // dare secret or song
  song:{title, artist, accept[], hint}|null,
  listAnswers[]|null, listNote|null,
  hotseatQuestion, hotseatAnswer, hotseatAccept[], hotseatQuestions:[{index, question, answer, result|null}],
  submissions:[{teamId, text, by(playerId), name, at, autoCorrect, override|null, correct}],   // allplay / bonus
  final:null|{question, answer, accept[], category, categoryLabel,
              wagers:[{teamId, amount|null, locked, by(name)|null, max}],
              answers:[{teamId, text|null, by|null, autoCorrect, override|null}],          // during finalAnswer
              rows:[{teamId, text, by, wager, autoCorrect, override|null, correct, revealed, judged, delta, before, after}],  // reveal order
              current, done},
  canUndo, undoLabel, undoDepth,
  contentStats:{'christmas-easy':{total,left}, …, quick, songs, lists, dares, finals, showdowns},
  contentProblems:[{file, id, error}], warnings:[{code, text, teamId?}],
  mascots:[{mascot, color, colorName}],
  can:{ <every host event name without the 'host:' prefix>: boolean } }      // server-computed: show/enable buttons from this
```

### 7.4 playerView = publicView + extras
```
me: {playerId, name, teamId|null} | null          // null = show the join screen
secret: {label, value, detail} | null             // ONLY the current performer (sound it out / dare with a secret)
myTeam: null | {teamId, isActive, submission:{text, by(name), byPlayerId, at}|null, wager:{amount, locked, by}|null, maxWager|null}
myVote: 'nailed' | 'good' | null
can: {spin, pickDifficulty, buzz, pickTarget, submitAnswer, wager, vote}   // exactly the actions the server will accept now
```

## 8. HTTP
- `/` player page (`public/index.html`), `/tv`, `/host`; `/player` → 302 `/`. Static files from `public/` (no-cache).
- `/fonts/lilita-one/lilita-one-latin-400-normal.woff2`, `/fonts/fredoka/fredoka-latin-{400,500,600,700}-normal.woff2` (+ every other file in the packages' `files/` folders), cached 30 days.
- `/api/info` → `{joinUrl, candidates:[{address, iface, joinUrl}], port, tvUrl, hostUrl}` (no PIN).
- `/api/qr.svg` → QR of the current `joinUrl`, modules `#0B1F17` on `#FFF6E5`, `no-store` (add `?v=<joinUrl>` to bust caches after `joinIp` changes).

## 9. Rules & numbers the UI may want
- Points: trivia 100/200/300, steal = half (hint halves first); All Play 100 + 50 first; dare 200/100/0 +50; showdown 200 / tie 100 each; Sound It Out 200, steal 100; Rapid List & Hot Seat 50 each, max 300 (6); Grinch 150 (×2 under DD, capped at victim score) / gift 100; bonus 100; Final ±wager (floor 0).
- Default timers (ms): spin 5000, steal arm 3000, trivia 20000, steal window 10000, sound 30000, list 30000, hot seat 45000, All Play 20000, bonus 20000, vote 15000, wager 30000, final answer 45000; warning fx at 5000 left.
- Rounds: `clamp(round(20/teams), 3, 6)` while `settings.autoRounds`; `settings.estimatedMinutes = round(5 + teams×rounds×2.6 + 9)`. Round bonus defaults on for ≥ 5 teams while `roundBonusAuto`.
- Double Down: `teams[i].multiplier` is 2 for the active team for the rest of the turn; applies only to that team's positive points.
- Podium places share ties (`place = 1 + number of teams with a higher score`). Awards appear only if earned (Fastest Finger = steal buzzes won + All Play first-correct answers; Star Performer = points earned as performer/called-up player).
- All user text (team/player names, typed answers) is raw text: **always escape** when rendering.

## 10. Examples (generated from a real game)

Teams: t1 Team Rudolph (Max, Aunt Linda), t2 The Grinches (Priya), t3 Frosty's Crew (Sam). Example 1 shows every base field;
later examples abbreviate repeated base fields. `host.can` lists only the `true` flags in examples 10 and 14.

### 1. Lobby — hostView (base fields shown in full once)

```json
{
  "now": 1764201600000,
  "phase": "lobby",
  "gameNo": 1,
  "joinUrl": "http://10.0.0.235:3000/",
  "settings": {"rounds": 6, "autoRounds": true, "roundBonus": false, "roundBonusAuto": true, "sound": true, "estimatedMinutes": 61},
  "round": 0,
  "totalRounds": 6,
  "turnIndex": 0,
  "turnsPerRound": 3,
  "turnId": 0,
  "teams": [
    {"id": "t1", "name": "Team Rudolph", "mascot": "star", "color": "#FF5A4E", "score": 0, "rank": 1, "connectedCount": 2, "playerCount": 2, "multiplier": 1},
    {"id": "t2", "name": "The Grinches", "mascot": "gift", "color": "#B794FF", "score": 0, "rank": 1, "connectedCount": 1, "playerCount": 1, "multiplier": 1},
    {"id": "t3", "name": "Frosty's Crew", "mascot": "snowflake", "color": "#3DDBC4", "score": 0, "rank": 1, "connectedCount": 1, "playerCount": 1, "multiplier": 1}
  ],
  "players": [
    {"id": "p1", "name": "Max", "teamId": "t1", "connected": true},
    {"id": "p2", "name": "Aunt Linda", "teamId": "t1", "connected": true},
    {"id": "p3", "name": "Priya", "teamId": "t2", "connected": true},
    {"id": "p4", "name": "Sam", "teamId": "t3", "connected": true}
  ],
  "activeTeamId": null,
  "segments": "[...12 segments, see \"Segments\"]",
  "lastSegmentIndex": 0,
  "spin": null,
  "challenge": null,
  "timer": null,
  "lastAwards": [],
  "roundBreak": null,
  "final": null,
  "podium": null,
  "savedGame": null,
  "host": {
    "isHost": true,
    "pin": "4821",
    "candidates": [
      {"address": "10.0.0.235", "iface": "Wi-Fi"}
    ],
    "joinIp": "10.0.0.235",
    "answer": null,
    "accept": [],
    "hint": null,
    "funFact": null,
    "secret": null,
    "song": null,
    "listAnswers": null,
    "listNote": null,
    "hotseatQuestion": null,
    "hotseatAnswer": null,
    "hotseatAccept": [],
    "hotseatQuestions": [],
    "submissions": [],
    "final": null,
    "canUndo": false,
    "undoLabel": null,
    "undoDepth": 0,
    "contentStats": {"...": "see contentStats"},
    "contentProblems": [],
    "warnings": [],
    "mascots": "[...8 {mascot,color,colorName}]",
    "can": {
      "createTeam": true,
      "updateTeam": true,
      "removeTeam": true,
      "movePlayer": true,
      "kickPlayer": true,
      "setRounds": true,
      "setOption": true,
      "start": true,
      "resetGame": true
    }
  }
}
```

### 2. Turn intro — playerView of a player on the active team

```json
{
  "now": 1764201600000,
  "phase": "turnIntro",
  "round": 1,
  "totalRounds": 6,
  "turnIndex": 0,
  "turnsPerRound": 3,
  "turnId": 1,
  "teams": "[... teams ...]",
  "activeTeamId": "t1",
  "lastSegmentIndex": 0,
  "spin": null,
  "challenge": null,
  "timer": null,
  "lastAwards": "[... lastAwards ...]",
  "roundBreak": null,
  "final": null,
  "podium": null,
  "savedGame": null,
  "me": {"playerId": "p1", "name": "Max", "teamId": "t1"},
  "secret": null,
  "myTeam": {"teamId": "t1", "isActive": true, "submission": null, "wager": null, "maxWager": null},
  "myVote": null,
  "can": {"spin": true, "pickDifficulty": false, "buzz": false, "pickTarget": false, "submitAnswer": false, "wager": false, "vote": false},
  "...": "base fields as in example 1 (settings, teams, players, segments, ...)"
}
```

### 3. Trivia steal, someone buzzed — publicView (TV)

```json
{
  "now": 1764201614000,
  "phase": "challenge",
  "round": 2,
  "totalRounds": 6,
  "turnIndex": 0,
  "turnsPerRound": 3,
  "turnId": 5,
  "teams": "[... teams ...]",
  "activeTeamId": "t1",
  "lastSegmentIndex": 0,
  "spin": null,
  "challenge": {
    "id": 1,
    "type": "trivia",
    "stage": "steal",
    "segmentIndex": 0,
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.",
    "points": 300,
    "started": true,
    "revealed": false,
    "category": "christmas",
    "categoryLabel": "Christmas Trivia",
    "difficulty": "hard",
    "pickedBy": {"playerId": "p2", "name": "Aunt Linda"},
    "question": "What German Christmas fruit bread, thickly dusted with powdered sugar, is celebrated with a giant version at a festival in Dresden?",
    "stealPoints": 150,
    "hasHint": true,
    "buzz": {
      "open": false,
      "armingUntil": null,
      "eligibleTeamIds": ["t2", "t3"],
      "lockedTeamIds": [],
      "winner": {"playerId": "p3", "name": "Priya", "teamId": "t2"}
    },
    "result": null
  },
  "timer": null,
  "lastAwards": "[... lastAwards ...]",
  "roundBreak": null,
  "final": null,
  "podium": null,
  "savedGame": null,
  "...": "base fields as in example 1 (settings, teams, players, segments, ...)"
}
```

### 4. Trivia steal, someone buzzed — playerView of a third team (cannot buzz any more)

```json
{
  "me": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
  "myTeam": {"teamId": "t3", "isActive": false, "submission": null, "wager": null, "maxWager": null},
  "can": {"spin": false, "pickDifficulty": false, "buzz": false, "pickTarget": false, "submitAnswer": false, "wager": false, "vote": false},
  "...": "everything else = publicView"
}
```

### 5. Trivia stolen (turnResult) — publicView

```json
{
  "now": 1764201614000,
  "phase": "turnResult",
  "round": 2,
  "totalRounds": 6,
  "turnIndex": 0,
  "turnsPerRound": 3,
  "turnId": 5,
  "teams": "[... teams ...]",
  "activeTeamId": "t1",
  "lastSegmentIndex": 0,
  "spin": null,
  "challenge": {
    "id": 1,
    "type": "trivia",
    "stage": "done",
    "segmentIndex": 0,
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.",
    "points": 300,
    "started": true,
    "revealed": true,
    "category": "christmas",
    "categoryLabel": "Christmas Trivia",
    "difficulty": "hard",
    "pickedBy": {"playerId": "p2", "name": "Aunt Linda"},
    "question": "What German Christmas fruit bread, thickly dusted with powdered sugar, is celebrated with a giant version at a festival in Dresden?",
    "stealPoints": 150,
    "hasHint": true,
    "answer": "Stollen",
    "funFact": "Its shape and white sugar coating are said to represent the baby Jesus wrapped in swaddling clothes.",
    "buzz": {
      "open": false,
      "armingUntil": null,
      "eligibleTeamIds": ["t2", "t3"],
      "lockedTeamIds": [],
      "winner": {"playerId": "p3", "name": "Priya", "teamId": "t2"}
    },
    "result": {
      "kind": "stolen",
      "awards": [
        {"teamId": "t2", "delta": 150}
      ]
    }
  },
  "timer": null,
  "lastAwards": "[... lastAwards ...]",
  "roundBreak": null,
  "final": null,
  "podium": null,
  "savedGame": null,
  "...": "base fields as in example 1 (settings, teams, players, segments, ...)"
}
```

### 6. Dare — playerView of the performer (secret only here + hostView)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 2,
    "type": "dare",
    "stage": "perform",
    "segmentIndex": 1,
    "rule": "One of you performs the dare. Nail it for 200!",
    "points": 200,
    "started": false,
    "revealed": false,
    "performer": {"playerId": "p3", "name": "Priya", "teamId": "t2"},
    "partner": null,
    "dare": {
      "title": "Slow-Mo Snowball Fight",
      "instructions": "WHOLE TEAM: stage an epic snowball fight in SLOW MOTION. Slow-motion voices, slow-motion faces, and at least one dramatic slow-motion hit. Nobody speeds up!",
      "who": "team",
      "time": 30,
      "props": [],
      "judge": "Whole team stays in slow motion for 30 s with at least one dramatic 'hit'; anyone drifting to normal speed = partial.",
      "hasSecret": false
    },
    "vote": null,
    "dareResult": null,
    "result": null
  },
  "timer": {"kind": "dare", "label": "Dare", "running": false, "endsAt": null, "durationMs": 30000, "remainingMs": 30000, "started": false, "ended": false},
  "me": {"playerId": "p3", "name": "Priya", "teamId": "t2"},
  "secret": null,
  "can": {"spin": false, "pickDifficulty": false, "buzz": false, "pickTarget": false, "submitAnswer": false, "wager": false, "vote": false},
  "...": "base fields"
}
```

### 7. Dare room vote — publicView (TV)

```json
{
  "now": 1764201629000,
  "phase": "challenge",
  "round": 2,
  "totalRounds": 6,
  "turnIndex": 1,
  "turnsPerRound": 3,
  "turnId": 6,
  "teams": "[... teams ...]",
  "activeTeamId": "t2",
  "lastSegmentIndex": 1,
  "spin": null,
  "challenge": {
    "id": 2,
    "type": "dare",
    "stage": "vote",
    "segmentIndex": 1,
    "rule": "One of you performs the dare. Nail it for 200!",
    "points": 200,
    "started": true,
    "revealed": false,
    "performer": {"playerId": "p3", "name": "Priya", "teamId": "t2"},
    "partner": null,
    "dare": {
      "title": "Slow-Mo Snowball Fight",
      "instructions": "WHOLE TEAM: stage an epic snowball fight in SLOW MOTION. Slow-motion voices, slow-motion faces, and at least one dramatic slow-motion hit. Nobody speeds up!",
      "who": "team",
      "time": 30,
      "props": [],
      "judge": "Whole team stays in slow motion for 30 s with at least one dramatic 'hit'; anyone drifting to normal speed = partial.",
      "hasSecret": false
    },
    "vote": {"open": true, "endsAt": 1764201644000, "nailed": 1, "good": 0, "voters": 1, "eligible": 3, "result": null},
    "dareResult": null,
    "result": null
  },
  "timer": {"kind": "vote", "label": "Room vote", "running": true, "endsAt": 1764201644000, "durationMs": 15000, "remainingMs": 15000, "started": true, "ended": false},
  "lastAwards": "[... lastAwards ...]",
  "roundBreak": null,
  "final": null,
  "podium": null,
  "savedGame": null,
  "...": "base fields as in example 1 (settings, teams, players, segments, ...)"
}
```

### 8. Dare room vote — playerView of a voter on another team

```json
{
  "me": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
  "myVote": null,
  "can": {"spin": false, "pickDifficulty": false, "buzz": false, "pickTarget": false, "submitAnswer": false, "wager": false, "vote": true},
  "...": "everything else = publicView"
}
```

### 9. All Play answering — playerView (teammate sees who answered for the team)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 3,
    "type": "allplay",
    "stage": "answering",
    "segmentIndex": 10,
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first.",
    "points": 100,
    "started": true,
    "revealed": false,
    "question": "Every year, a giant Christmas tree is lit above the famous ice rink at which New York City landmark?",
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": false},
      {"teamId": "t3", "answered": true}
    ],
    "firstBonus": 50,
    "result": null
  },
  "timer": {"kind": "allplay", "label": "All Play", "running": true, "endsAt": 1764201654000, "durationMs": 20000, "remainingMs": 19000, "started": true, "ended": false},
  "me": {"playerId": "p2", "name": "Aunt Linda", "teamId": "t1"},
  "myTeam": {
    "teamId": "t1",
    "isActive": false,
    "submission": {"text": "Clarence", "by": "Max", "byPlayerId": "p1", "at": 1764201635000},
    "wager": null,
    "maxWager": null
  },
  "can": {"spin": false, "pickDifficulty": false, "buzz": false, "pickTarget": false, "submitAnswer": true, "wager": false, "vote": false},
  "...": "base fields"
}
```

### 10. All Play marking — hostView (host block)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 3,
    "type": "allplay",
    "stage": "marking",
    "segmentIndex": 10,
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first.",
    "points": 100,
    "started": true,
    "revealed": false,
    "question": "Every year, a giant Christmas tree is lit above the famous ice rink at which New York City landmark?",
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": false},
      {"teamId": "t3", "answered": true}
    ],
    "firstBonus": 50,
    "result": null
  },
  "host": {
    "isHost": true,
    "pin": "4821",
    "candidates": [
      {"address": "10.0.0.235", "iface": "Wi-Fi"}
    ],
    "joinIp": "10.0.0.235",
    "answer": "Rockefeller Center",
    "accept": ["Rockefeller Plaza", "Rockefeller", "30 Rock"],
    "hint": "It's named after a famously rich oil family.",
    "funFact": "The tradition began in 1931, when construction workers put up a small tree decorated with cranberries, paper garlands and even tin cans.",
    "secret": null,
    "song": null,
    "listAnswers": null,
    "listNote": null,
    "hotseatQuestion": null,
    "hotseatAnswer": null,
    "hotseatAccept": [],
    "hotseatQuestions": [],
    "submissions": [
      {"teamId": "t1", "text": "Clarence", "by": "p1", "name": "Max", "at": 1764201635000, "autoCorrect": false, "override": null, "correct": false},
      {"teamId": "t3", "text": "Rockefeller Center", "by": "p4", "name": "Sam", "at": 1764201634000, "autoCorrect": true, "override": null, "correct": true}
    ],
    "final": null,
    "canUndo": true,
    "undoLabel": "The Grinches · Dare: nailed",
    "undoDepth": 2,
    "contentStats": {"...": "see contentStats"},
    "contentProblems": [],
    "warnings": [],
    "mascots": "[...8 {mascot,color,colorName}]",
    "can": {
      "updateTeam": true,
      "movePlayer": true,
      "kickPlayer": true,
      "setRounds": true,
      "setOption": true,
      "timer": true,
      "endChallenge": true,
      "markAnswer": true,
      "revealAnswers": true,
      "adjustScore": true,
      "undo": true,
      "nextTurn": true,
      "continue": true,
      "resetGame": true
    }
  },
  "...": "base fields"
}
```

### 11. All Play revealed — publicView challenge

```json
{
  "phase": "turnResult",
  "challenge": {
    "id": 3,
    "type": "allplay",
    "stage": "done",
    "segmentIndex": 10,
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first.",
    "points": 100,
    "started": true,
    "revealed": true,
    "question": "Every year, a giant Christmas tree is lit above the famous ice rink at which New York City landmark?",
    "submissions": [
      {"teamId": "t1", "answered": true, "text": "Clarence", "name": "Max", "correct": false, "first": false, "delta": 0},
      {"teamId": "t2", "answered": false},
      {"teamId": "t3", "answered": true, "text": "Rockefeller Center", "name": "Sam", "correct": true, "first": true, "delta": 150}
    ],
    "answer": "Rockefeller Center",
    "funFact": "The tradition began in 1931, when construction workers put up a small tree decorated with cranberries, paper garlands and even tin cans.",
    "firstTeamId": "t3",
    "firstBonus": 50,
    "result": {
      "kind": "allplay",
      "awards": [
        {"teamId": "t3", "delta": 150}
      ]
    }
  },
  "lastAwards": [
    {"id": 1, "teamId": "t2", "delta": 150, "reason": "Steal", "doubled": false},
    {"id": 2, "teamId": "t2", "delta": 200, "reason": "Dare", "doubled": false},
    {"id": 3, "teamId": "t3", "delta": 150, "reason": "All Play", "doubled": false}
  ]
}
```

### 12. Final wager — playerView

```json
{
  "phase": "finalWager",
  "final": {
    "category": "christmas",
    "categoryLabel": "Christmas",
    "question": null,
    "wagers": [
      {"teamId": "t1", "locked": true},
      {"teamId": "t2", "locked": false},
      {"teamId": "t3", "locked": false}
    ],
    "submissions": [
      {"teamId": "t1", "answered": false},
      {"teamId": "t2", "answered": false},
      {"teamId": "t3", "answered": false}
    ],
    "revealOrder": [],
    "revealed": [],
    "current": null,
    "done": false,
    "answer": null
  },
  "timer": {"kind": "wager", "label": "Wagers", "running": true, "endsAt": 1764201685000, "durationMs": 30000, "remainingMs": 30000, "started": true, "ended": false},
  "myTeam": {
    "teamId": "t1",
    "isActive": false,
    "submission": null,
    "wager": {"amount": 300, "locked": true, "by": "Max"},
    "maxWager": 300
  },
  "can": {"spin": false, "pickDifficulty": false, "buzz": false, "pickTarget": false, "submitAnswer": false, "wager": true, "vote": false},
  "...": "base fields"
}
```

### 13. Final reveal (2nd team revealed, awaiting the host mark) — publicView

```json
{
  "phase": "finalReveal",
  "teams": [
    {"id": "t1", "name": "Team Rudolph", "mascot": "star", "color": "#FF5A4E", "score": 300, "rank": 2, "connectedCount": 2, "playerCount": 2, "multiplier": 1},
    {"id": "t2", "name": "The Grinches", "mascot": "gift", "color": "#B794FF", "score": 350, "rank": 1, "connectedCount": 1, "playerCount": 1, "multiplier": 1},
    {"id": "t3", "name": "Frosty's Crew", "mascot": "snowflake", "color": "#3DDBC4", "score": 150, "rank": 3, "connectedCount": 1, "playerCount": 1, "multiplier": 1}
  ],
  "final": {
    "category": "christmas",
    "categoryLabel": "Christmas",
    "question": "NORAD's Santa tracking traces back to a 1955 newspaper ad inviting children to phone Santa. Which store chain placed that ad?",
    "wagers": [
      {"teamId": "t1", "locked": true},
      {"teamId": "t2", "locked": true},
      {"teamId": "t3", "locked": true}
    ],
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": true},
      {"teamId": "t3", "answered": false}
    ],
    "revealOrder": ["t1", "t3", "t2"],
    "revealed": [
      {"teamId": "t1", "text": "Sears", "by": "Max", "wager": 300, "judged": true, "correct": true, "delta": 300, "before": 0, "after": 300},
      {"teamId": "t3", "text": "", "by": null, "wager": 0, "judged": false, "correct": null, "delta": null, "before": 150, "after": null}
    ],
    "current": "t3",
    "done": false,
    "answer": null
  },
  "...": "base fields"
}
```

### 14. Final reveal — hostView host.final

```json
{
  "final": {
    "question": "NORAD's Santa tracking traces back to a 1955 newspaper ad inviting children to phone Santa. Which store chain placed that ad?",
    "answer": "Sears",
    "accept": ["Sears Roebuck", "Sears, Roebuck and Co.", "Sears Roebuck and Co", "Sears Roebuck & Co", "Sears Roebuck and Company", "Sears & Roebuck"],
    "category": "christmas",
    "categoryLabel": "Christmas",
    "wagers": [
      {"teamId": "t1", "amount": 300, "locked": true, "by": "Max", "max": 300},
      {"teamId": "t2", "amount": 150, "locked": true, "by": "Priya", "max": 350},
      {"teamId": "t3", "amount": 0, "locked": true, "by": null, "max": 300}
    ],
    "answers": [
      {"teamId": "t1", "text": "Sears", "by": "Max", "autoCorrect": true, "override": null},
      {"teamId": "t2", "text": "no idea", "by": "Priya", "autoCorrect": false, "override": null},
      {"teamId": "t3", "text": null, "by": null, "autoCorrect": false, "override": null}
    ],
    "rows": [
      {
        "teamId": "t1",
        "text": "Sears",
        "by": "Max",
        "wager": 300,
        "autoCorrect": true,
        "override": null,
        "correct": true,
        "revealed": true,
        "judged": true,
        "delta": 300,
        "before": 0,
        "after": 300
      },
      {
        "teamId": "t3",
        "text": "",
        "by": null,
        "wager": 0,
        "autoCorrect": false,
        "override": null,
        "correct": false,
        "revealed": true,
        "judged": false,
        "delta": null,
        "before": 150,
        "after": null
      },
      {
        "teamId": "t2",
        "text": "no idea",
        "by": "Priya",
        "wager": 150,
        "autoCorrect": false,
        "override": null,
        "correct": false,
        "revealed": false,
        "judged": false,
        "delta": null,
        "before": 350,
        "after": null
      }
    ],
    "current": "t3",
    "done": false
  },
  "can": {
    "updateTeam": true,
    "movePlayer": true,
    "kickPlayer": true,
    "setOption": true,
    "markAnswer": true,
    "finalRevealNext": true,
    "adjustScore": true,
    "undo": true,
    "continue": true,
    "resetGame": true
  }
}
```

### 15. Podium — playerView

```json
{
  "phase": "podium",
  "teams": [
    {"id": "t1", "name": "Team Rudolph", "mascot": "star", "color": "#FF5A4E", "score": 300, "rank": 1, "connectedCount": 2, "playerCount": 2, "multiplier": 1},
    {"id": "t2", "name": "The Grinches", "mascot": "gift", "color": "#B794FF", "score": 200, "rank": 2, "connectedCount": 1, "playerCount": 1, "multiplier": 1},
    {"id": "t3", "name": "Frosty's Crew", "mascot": "snowflake", "color": "#3DDBC4", "score": 150, "rank": 3, "connectedCount": 1, "playerCount": 1, "multiplier": 1}
  ],
  "podium": {
    "standings": [
      {"teamId": "t1", "score": 300, "place": 1},
      {"teamId": "t2", "score": 200, "place": 2},
      {"teamId": "t3", "score": 150, "place": 3}
    ],
    "awards": [
      {"key": "fastestFinger", "title": "Fastest Finger", "playerId": "p3", "name": "Priya", "teamId": "t2", "detail": "1 buzz won"},
      {"key": "starPerformer", "title": "Star Performer", "playerId": "p3", "name": "Priya", "teamId": "t2", "detail": "1 dare · 200 pts"}
    ]
  },
  "final": {
    "category": "christmas",
    "categoryLabel": "Christmas",
    "question": "NORAD's Santa tracking traces back to a 1955 newspaper ad inviting children to phone Santa. Which store chain placed that ad?",
    "wagers": [
      {"teamId": "t1", "locked": true},
      {"teamId": "t2", "locked": true},
      {"teamId": "t3", "locked": true}
    ],
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": true},
      {"teamId": "t3", "answered": false}
    ],
    "revealOrder": ["t1", "t3", "t2"],
    "revealed": [
      {"teamId": "t1", "text": "Sears", "by": "Max", "wager": 300, "judged": true, "correct": true, "delta": 300, "before": 0, "after": 300},
      {"teamId": "t3", "text": "", "by": null, "wager": 0, "judged": true, "correct": false, "delta": 0, "before": 150, "after": 150},
      {"teamId": "t2", "text": "no idea", "by": "Priya", "wager": 150, "judged": true, "correct": false, "delta": -150, "before": 350, "after": 200}
    ],
    "current": "t2",
    "done": true,
    "answer": "Sears"
  },
  "me": {"playerId": "p3", "name": "Priya", "teamId": "t2"},
  "myTeam": {
    "teamId": "t2",
    "isActive": false,
    "submission": {"text": "no idea", "by": "Priya", "byPlayerId": "p3", "at": 1764201655000},
    "wager": {"amount": 150, "locked": true, "by": "Priya"},
    "maxWager": 300
  },
  "...": "base fields"
}
```

### Segments (constant, in every view as `segments`)

```json
[
  {
    "index": 0,
    "type": "trivia",
    "category": "christmas",
    "label": "Christmas Trivia",
    "lines": ["Christmas", "Trivia"],
    "color": "#C8232C",
    "ink": "#FFF6E5",
    "icon": "tree-pine",
    "points": "100–300",
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal."
  },
  {
    "index": 1,
    "type": "dare",
    "label": "Dare",
    "lines": ["Dare"],
    "color": "#F5B82E",
    "ink": "#1A1206",
    "icon": "drama",
    "points": "200",
    "rule": "One of you performs the dare. Nail it for 200!"
  },
  {
    "index": 2,
    "type": "trivia",
    "category": "popculture",
    "label": "Pop Culture",
    "lines": ["Pop", "Culture"],
    "color": "#1F6FD1",
    "ink": "#FFF6E5",
    "icon": "clapperboard",
    "points": "100–300",
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal."
  },
  {
    "index": 3,
    "type": "hotseat",
    "label": "Hot Seat",
    "lines": ["Hot", "Seat"],
    "color": "#D63384",
    "ink": "#FFF6E5",
    "icon": "flame",
    "points": "50–300",
    "rule": "One player, alone, 45 seconds: up to 6 quick questions. 50 points each."
  },
  {
    "index": 4,
    "type": "trivia",
    "category": "christmas",
    "label": "Christmas Trivia",
    "lines": ["Christmas", "Trivia"],
    "color": "#C8232C",
    "ink": "#FFF6E5",
    "icon": "tree-pine",
    "points": "100–300",
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal."
  },
  {
    "index": 5,
    "type": "sounditout",
    "label": "Sound It Out",
    "lines": ["Sound", "It Out"],
    "color": "#7A4FD3",
    "ink": "#FFF6E5",
    "icon": "music",
    "points": "200",
    "rule": "One of you hums a secret song (no words!). Your team has 30 s to name it."
  },
  {
    "index": 6,
    "type": "grinch",
    "label": "Grinch Steal",
    "lines": ["Grinch", "Steal"],
    "color": "#FFF6E5",
    "ink": "#0B1F17",
    "icon": "hand-coins",
    "points": "150",
    "rule": "Steal 150 points from a team that is ahead of you."
  },
  {
    "index": 7,
    "type": "showdown",
    "label": "Showdown",
    "lines": ["Showdown"],
    "color": "#8FD8FF",
    "ink": "#0B1F17",
    "icon": "swords",
    "points": "200",
    "rule": "Pick a rival team. One player from each team goes head to head. Winner takes 200."
  },
  {
    "index": 8,
    "type": "dare",
    "label": "Dare",
    "lines": ["Dare"],
    "color": "#F5B82E",
    "ink": "#1A1206",
    "icon": "drama",
    "points": "200",
    "rule": "One of you performs the dare. Nail it for 200!"
  },
  {
    "index": 9,
    "type": "rapidlist",
    "label": "Rapid List",
    "lines": ["Rapid", "List"],
    "color": "#0B8A75",
    "ink": "#FFF6E5",
    "icon": "list-checks",
    "points": "50–300",
    "rule": "Shout as many answers as you can in 30 s. 50 each, up to 300."
  },
  {
    "index": 10,
    "type": "allplay",
    "label": "All Play",
    "lines": ["All", "Play"],
    "color": "#F2731D",
    "ink": "#0B1F17",
    "icon": "zap",
    "points": "100+",
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first."
  },
  {
    "index": 11,
    "type": "doubledown",
    "label": "Double Down",
    "lines": ["Double", "Down"],
    "color": "#1E8A4C",
    "ink": "#FFF6E5",
    "icon": "sparkles",
    "points": "×2",
    "rule": "Spin again! Everything your team wins this turn is doubled."
  }
]
```
