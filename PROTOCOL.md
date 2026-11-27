# Christmas Chaos v2 — Socket protocol (as implemented)

This is the **actual** protocol of `server.js` + `src/game.js` + `src/views.js` + `src/coach.js`. It extends TECH.md §3;
every extension is marked **(ext)**. All examples in §11 were generated from a real scripted game, so field names are exact.

- Transport: socket.io 4 (the server serves the client at `/socket.io/socket.io.js` and `/socket.io/socket.io.esm.min.js`).
- Times (`now`, `endsAt`, `startedAt`, `armingUntil`, `at`) are **server epoch ms**. Every view carries `now`; compute
  `offset = view.now - Date.now()` on receipt and use `Date.now() + offset` for countdowns/wheel sync.
- Pushes are coalesced (≤ 30 ms). The server sends a fresh role-filtered `state` after **every** change, then any queued `fx`.
  **Render from `state` alone**; `fx` is only for one-shot sound/animation.
- All user text (team/player names, typed answers, and therefore coach `say`/`tips` that quote them) is raw text:
  **always escape** when rendering.

---

## 1. Connecting and identity

```
socket.emit('hello', { role: 'player' | 'tv' | 'host', clientId?, hostKey? }, ack)
ack -> { ok: true, role, isHost, me: {playerId, name, teamId} | null, serverNow,
         hostKey?,            // host via PIN/key: the key to remember (localStorage['cc.hostKey'])
         needPin?, pinError?  // host that is not (yet) authorised, see below
       }
     | { ok: false, error: 'bad-role' | 'bad-client-id' }
```
- Send `hello` on **every** `connect` event (socket.io reconnects with a new socket id; `hello` rebinds it). The server
  then pushes `state` to that socket immediately.
- **Player**: `clientId` is required, `/^[A-Za-z0-9_-]{6,64}$/` (generate once, keep in `localStorage['cc.clientId']`;
  `crypto.randomUUID` is unavailable on plain-http LAN pages). The player record is keyed by clientId; `me` is non-null if
  this clientId has joined before (refresh = same team). The public `playerId` (`p1`, `p2`…) is NOT the clientId —
  clientIds never appear in any view.
- **TV**: no clientId needed. Gets `publicView`.
- **Host** (TECH §3 host auth flow):
  - Sockets from the laptop running the server are hosts automatically: loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1)
    or one of the laptop's own interface addresses (so `http://<LAN IP>:3000/host` opened ON the laptop also works):
    `{ok:true, isHost:true}` (no `hostKey` needed or returned).
  - Any other device: `hello {role:'host', hostKey}` with a valid key → `{ok:true, isHost:true, hostKey}`.
  - Without a key, or with a stale/wrong one → **`{ok:true, isHost:false, needPin:true, pinError?}`** (`pinError`:
    `'bad-pin'` stale key, `'too-many-tries'` rate limited). The socket is a *pending host*: its `state` is the minimal
    **login view** (§8.5, never the PIN, never game secrets) and every `host:*` event answers `not-host`.
  - **`hostLogin {pin}`** (ext name per TECH) → `{ok:true, isHost:true, hostKey}`; the socket is promoted and receives the
    full hostView. Store `hostKey` in `localStorage['cc.hostKey']` and send it in every later `hello` (auto re-login after
    refresh/reconnect). Wrong PIN → `{ok:false, error:'bad-pin', triesLeft}` (5 tries per minute per socket, 20 per minute
    per address); over the limit → `{ok:false, error:'too-many-tries', retryInMs}`. `hostLogin` before a host `hello` →
    `hello-first`. `pin` may be a 4-digit string (or integer).
  - "Sign out of this device" = forget `cc.hostKey` and `hello {role:'host'}` again (back to the login view).
  - The PIN is in `host.pin` (laptop host screen) and the console banner. It is never in publicView/playerView/login view.
  - Several host devices can be signed in at once; all get the same hostView. `host.connections.hosts` counts them.
- A socket may re-`hello` with a different role at any time (it leaves the old role).
- Disconnect marks the player `connected:false`; players are never deleted except by `host:kickPlayer`.

## 2. Acks and errors

Every client→server event takes an ack: `(res) => res.ok ? … : showError(res.error)`. `res` is
`{ ok: true, ...extra }` or `{ ok: false, error: '<code>' }`. Handlers never throw; unknown events ack `unknown-event`.

Common codes: `hello-first`, `not-player` (event needs role player), `not-host`, `not-joined`, `no-team`, `not-your-turn`,
`not-now` (wrong phase/stage), `slow-down` (> 60 events/s from one socket), `server-error` (bug; logged), `unknown-event`.
Event-specific codes are listed with each event.

## 3. Player events (role `player`)

| Event | Payload | Valid when (`can.<event>`) | Effect / extra ack fields | Errors |
|---|---|---|---|---|
| `join` | `{name, teamId}` | always; mid-game only if you have no team yet | creates/updates your player. name trimmed, control chars stripped, ≤ 20 chars. Lobby: re-join = switch team. ack `{ok, me}` | `name-required`, `no-such-team`, `ask-host` (mid-game team switch: host must `movePlayer`), `game-full` |
| `spin` | — | phase `turnIntro`, or challenge `doubledown/spinAgain`; your team is active | starts a spin (accepted once per spin window) | `not-your-turn`, `not-now` |
| `pickDifficulty` | `{level:'easy'\|'medium'\|'hard'}` | trivia `pickDifficulty`, your team active; first tap wins | question drawn, 20 s timer starts | `bad-level` |
| `buzz` | — | trivia/sounditout `steal`, `buzz.open`, your team eligible & not locked | you are `buzz.winner`; buzzers close | `arming` (still in the 3 s get-ready), `locked-out`, `not-eligible`, `not-now` |
| `previewTarget` **(ext)** | `{teamId \| null}` | same as `pickTarget` | highlights a target before confirming: `challenge.eyeing = {teamId, by}` so the TV can show "Mia is eyeing Team Rudolph…". `null` clears it | `bad-target` |
| `pickTarget` | `{teamId}` | grinch `pickTarget` or showdown `pickRival`, your team active; `teamId` ∈ `challenge.targets` | grinch: steal happens immediately; showdown: players called up | `bad-target` |
| `submitAnswer` | `{text}` | allplay `answering`, bonus `answering` (phase roundBreak), or phase `finalAnswer` | per team, **last submission wins** until time/lock; text trimmed, ≤ 80 chars (longer is truncated). A changed answer resets the host's manual mark | `empty-answer` |
| `wager` | `{amount}` | phase `finalWager` | per team, last lock-in wins. `amount` must be an **integer** `0..myTeam.maxWager` (= max(score,300)) | `bad-amount` |
| `vote` | `{choice:'nailed'\|'good'}` | dare `vote` stage, vote open, your team is NOT active | **one vote per player; voting again while open changes it (ext)** — ack `{ok, changed}`. When every connected eligible player has voted (first votes), the vote closes early | `not-eligible`, `bad-choice` |
| `peek` **(ext)** | — | you have a `secret` (performer of sounditout / dare with a secret) | tells the host you looked ("Aunt Linda has peeked": `host.secretPeeked`). ack `{ok, first}` | `no-secret` |

`can` = `{spin, pickDifficulty, buzz, pickTarget, previewTarget, submitAnswer, wager, vote, peek}` — computed by the server
from the exact same guards, so the phone shows exactly the actions it can take.

## 4. Host events (role `host`, authorised)

All return `{ok:false, error:'not-host'}` from any non-host or pending-host socket. "Stage" = `challenge.stage`.
`host.can.<name>` (name without `host:`) says whether an event is valid right now; the coach (§7) builds on it.

| Event | Payload | Valid when | Effect | Errors |
|---|---|---|---|---|
| `host:createTeam` | `{name, mascot?, color?}` | lobby, < 8 teams | team id `t<n>` (never reused). mascot ∈ `star bell candy-cane tree-pine gift cookie moon snowflake` (default first free); color defaults to the mascot's paired colour **(ext: optional `color` from the 8-colour palette)**. ack `{ok, teamId}` | `name-required`, `name-taken`, `bad-mascot`, `mascot-taken`, `bad-color`, `too-many-teams` |
| `host:updateTeam` | `{teamId, name?, mascot?, color?}` | always (rename mid-game OK) | | `no-such-team`, `name-required`, `name-taken`, `bad-mascot`, `bad-color` |
| `host:removeTeam` | `{teamId}` | lobby | its players get `teamId:null` (phone shows the team picker; fx `teamRemoved`) | `no-such-team` |
| `host:reorderTeams` **(ext)** | `{order:[teamId…]}` (every team exactly once) | lobby | sets the turn order | `bad-order` |
| `host:shuffleTeams` **(ext)** | — | lobby, ≥ 2 teams | random turn order (always changes it); ids stay the same | `need-two-teams` |
| `host:movePlayer` | `{playerId, teamId\|null}` | always | | `no-such-player`, `no-such-team` |
| `host:kickPlayer` | `{playerId}` | always | deletes the player; that phone gets `me:null` | `no-such-player` |
| `host:setRounds` | `{n}` integer 1..8 | lobby / in turn / roundBreak; `n ≥ round` once started | `settings.autoRounds=false` (never overwritten again) | `bad-rounds`, `below-current-round` |
| `host:setOption` | `{key, value}` | always | `roundBonus` (bool, stops auto), `sound` (bool), `joinIp` (string ∈ `host.candidates[].address`; changes `joinUrl` + QR) | `bad-option`, `bad-ip` |
| `host:start` | — | lobby, ≥ 2 teams | scores 0, round 1, first team's `turnIntro`; discards a pending saved game | `need-two-teams` |
| `host:soundTest` **(ext)** | — | always | fx `soundTest` (the TV plays a test jingle) | |
| `host:spin` | — | like player `spin` | spin on behalf of the active team | |
| `host:forceSegment` | `{index}` 0..11 | like `spin` | spin that lands on `index` (debug / tests; "More" menu) | `bad-index` |
| `host:pickDifficulty` **(ext)** | `{level}` | trivia `pickDifficulty` | on behalf of the team | `bad-level` |
| `host:pickTarget` **(ext)** | `{teamId}` | grinch `pickTarget` / showdown `pickRival` | on behalf of the team | `bad-target` |
| `host:judge` | `{result:'correct'\|'wrong'}` | trivia `question`, sounditout `perform`, or `steal` with a `buzz.winner` | correct: points + `done`. wrong (active team): steal opens (3 s arm). wrong (stealer): that team is locked out; buzzers stay closed until `openSteal`; when no team is left → `done` | `bad-result` |
| `host:openSteal` | — | trivia `question` / sounditout `perform` (= judge wrong), or `steal` stage with buzzers closed, no winner, not arming, teams left | (re)arms the steal for the remaining teams | `no-teams-left` |
| `host:reveal` | — | trivia/sounditout not yet revealed (ends it, no more points); dare with an unrevealed secret (shows it, dare continues); rapidlist (shows all valid answers, ends the list) | | |
| `host:showHint` | — | trivia `question` / sounditout `perform`, hint exists, not shown | hint becomes public; `points` halved (steal = half of that) | `no-hint` |
| `host:timer` | `{action:'start'\|'pause'\|'resume'\|'add', seconds?}` | a timer exists | start (also restarts an ended timer), pause, resume (paused only), add `seconds` 1..300 (default 10; adding to an ended timer restarts it) | `no-timer`, `already-running`, `not-running`, `not-paused`, `bad-seconds`, `bad-action` |
| `host:rerollPerformer` | `{side?:'active'\|'rival'}` | dare/sounditout `perform`, hotseat before Q1, showdown `battle` (side: re-roll one; default both) | new random player (fewest picks first); dare secret is re-drawn | `no-players`, `bad-side` |
| `host:swapQuestion` | — | trivia `question` (same category+difficulty, timer restarts), sounditout `perform` (new song, same performer), dare `perform` (**new dare, same performer**), showdown `battle`, rapidlist `list` (no ticks yet), hotseat (current question), allplay/bonus `answering` (clears answers), `finalIntro`/`finalWager` | draws an unused replacement ("Swap question / dare / prompt / challenge") | |
| `host:swapSecret` **(ext)** | — | dare `perform` with a secret that has ≥ 2 options; sounditout `perform` | new secret for the **same** performer ("Swap secret movie" / "Swap song"); resets `secretPeeked` | `no-secret` |
| `host:endChallenge` **(ext)** | — | phase `challenge`, not doubledown, not done | "Skip": ends the mini-game with no further points (`result.kind:'skipped'`) | |
| `host:dareResult` | `{result:'nailed'\|'valiant'\|'fail', bonus?:bool}` | dare `perform`/`vote`/`done` | 200/100/0 (+50 crowd favourite), ×2 under Double Down. In `done` it **re-judges** (overrides the room vote / toggles the bonus): the team's dare points are moved to the new total. `bonus` omitted = keep previous | `bad-result` |
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
| `host:nextTurn` | `{turnId}` (= `state.turnId`) | `turnIntro`/`spinning`/`challenge`/`turnResult` | cancels anything pending (spin, timers), next team's `turnIntro`, or `roundBreak` after the last team, or `finalIntro` after the last round. A stale `turnId` (double click) is rejected | `stale-turn`, `not-now` |
| `host:continue` | — | see §5 "continue" | the one generic "next step" button | `not-now` |
| `host:resetGame` | `{keepTeams:boolean}` (default true) | always | back to lobby; keepTeams keeps teams (score 0) **and players**; false removes teams and unassigns players. Content bags continue (no repeats in the next game) | `bad-option` |
| `host:resume` | — | a saved game is offered (`savedGame` non-null) | restores it (timers come back paused; a spin in flight lands) | `no-save`, `bad-save` |
| `host:discardSave` | — | a saved game is offered | forget it | `no-save` |

Non-`host:` event for host sockets: **`hostLogin {pin}`** (§1).

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
| `trivia` (0 Christmas Trivia `category:'christmas'`; 2 Pop Culture `'popculture'`; **4 Christmas Movies `'movies'`**) | `pickDifficulty` → `question` → [`steal`] → `done` | team picks (phone or host) → 20 s timer auto-starts → `judge correct` = done; `judge wrong` **or time-out** = `steal`: `buzz.armingUntil` = now+3 s, then `buzz.open` (10 s `steal` timer) → buzz → judge → correct = done (stealer gets `stealPoints`), wrong = team locked, host `openSteal` to re-arm for the rest; steal timer runs out / no teams left / `reveal` = done (`missed`). Movies questions carry `movie` (+ `movieYear`) once the question is shown (TV sub-chip) |
| `sounditout` (5) | `perform` → [`steal`] → `done` | 30 s `sound` timer is **prepared, host starts it**; performer's phone has `secret`; correct = 200; wrong or time-out = steal for 100 (same buzz mechanics) |
| `dare` (1,8) | `perform` → [`vote`] → `done` | dare timer (dare.time) prepared, host starts it; host `dareResult` directly, or `openVote` → 15 s vote → closes (timer / all voted / `closeVote`) → scored. `dareResult` again in `done` re-judges |
| `showdown` (7) | `pickRival` → `battle` → `done` | team picks a rival (phone or host; `previewTarget` → `eyeing`) → one player from each team called up (`performer`, `rival`) → timer prepared, host starts → `showdownResult` |
| `rapidlist` (9) | `list` → `done` | 30 s timer prepared (host starts, or first tick starts it); ticks are scored live; time-out or `continue` = done; ticks still allowed in `done` |
| `hotseat` (3) | `hotseat` → `done` | 45 s timer prepared (host starts, or the first mark starts it); `hotseat.question` is public only once the clock started; done after Q6 or time-out (or `continue`) |
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

## 6. Server → client events

### `state` — the role's view (see §8)

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
| `vote` | `nailed, good, voters` (+ `opened` / `closed, result` / `choice, changed`) | room vote opened / a vote came in or changed / closed |
| `steal` | `from, to, amount` | Grinch steal executed |
| `round` | `round` | a round starts (1 at game start) |
| `roundBreak` **(ext)** | `round` | a round just ended (round break screen) |
| `podium` | — | podium reached |
| `turn` **(ext)** | `teamId, turnId, round` | a team's turn starts (phones vibrate if it's theirs) |
| `doubleDown` **(ext)** | `teamId` | Double Down landed |
| `calledUp` **(ext)** | `playerIds, kind` | performer(s)/showdown players picked (vibrate those phones) |
| `teamRemoved` **(ext)** | `teamId, name` | lobby team removed (its phones show a toast + team picker) |
| `joined` / `answered` / `wagered` **(ext)** | `playerId, teamId` / `teamId, changed` / `teamId` | for little "ding"s |
| `reveal` **(ext)** | `teamId?` | answer revealed / final row revealed |
| `final` **(ext)** | — | Final Chaos intro |
| `soundTest` **(ext)** | — | host pressed "Play test sound" (TV plays a jingle) |

## 7. The coach panel — `hostView.host.coach` (live directions)

Recomputed on every state push from the exact game state (`src/coach.js`), so it is never stale.

```
coach: {
  headline: string,                 // "Now:" one line, e.g. "Team Rudolph is answering (Medium · 200)"
  say: string | null,               // "Say this:" read aloud (may contain '\n' line breaks). NEVER contains an answer,
                                    //   song title, dare secret or list answer before it is revealed on the TV.
  steps: [string],                  // "Do this:" 1–3 numbered steps
  tips: [string],                   // "Heads-up:" contextual tips (empty team, TV not connected, Double Down ×2,
                                    //   first time a mini-game comes up, close spellings to check, props, how to judge…)
  actions: [{
    id: string,                     // stable per stage: 'start', 'correct', 'wrong', 'nextTurn', 'timerStart', …
    label: string,                  // button text, e.g. "Correct +200"
    event: string | null,           // the socket event to emit, e.g. 'host:judge'. null = local UI action (see `local`)
    payload: object | null,         // emit exactly this payload (e.g. {result:'correct'}, {turnId: 7})
    kind: 'primary'|'secondary'|'danger'|'success',
    shortcut: string | null,        // 'C','W','R','T','N','H','V','P','S','O','A','X','F','1'..'3','Enter'
    detail?: string,                // small second line ("Steal for 100 comes next")
    confirm?: string,               // ask this before emitting (destructive / skips)
    disabled?: true, reason?: string, // shown but not clickable (e.g. "Unlocks when the timer starts")
    local?: 'introScript'           // event:null actions: open the opening-script overlay
  }],
  primary: string | null,           // id of THE big highlighted action right now (may be a 'success' action, e.g. Correct)
  progress: [{label, state:'done'|'current'|'todo', detail?}]   // turn tracker ("Spun Christmas Trivia → Pick difficulty
                                    //   → Answer & judge → Steal, if they miss → Next turn"), or Wager → Answer → Reveal
}
```
- Every action with an `event` is dry-run against the server rules: if it would be rejected now it comes back
  `disabled:true` with a `reason`. So: render `actions` generically (primary big, others as buttons), emit
  `socket.emit(a.event, a.payload || {}, ack)`, honour `confirm`. Persistent tools (score ±, undo, timer, "More" menu)
  stay outside the coach.
- Action ids by stage (for styling/keyboard): lobby `start, introScript, soundTest` (+ `resume, discardSave` when a save is
  offered); turnIntro `spinFor, skipTurn`; spinning `skipTurn`; trivia `pick-easy|medium|hard` → `correct, wrong, hint,
  reveal, swap`; steal `correct, wrong` / `reveal` / `reopen, reveal`; sounditout `timerStart, correct, wrong, reroll, hint,
  swapSong, skip`; dare `timerStart, nailed, valiant, fail, vote, reroll, swapSecret?, swapDare, skip`; dare vote `closeVote,
  nailed, valiant, fail`; showdown `rival-<teamId>…` → `timerStart, winActive, winRival, tie, reroll, swap, skip`; rapidlist
  `timerStart, award, other, swap`; hotseat `timerStart, correct, wrong, pass, reroll, swap, end`; allplay `lock, swap` →
  `revealAll`; grinch `steal-<teamId>…`; doubledown `spinFor`; turnResult `nextTurn` (+ dare `crowd, change-<result>`,
  rapidlist `other`); roundBreak `bonus, skipBonus` or `nextRound` (bonus: `lock, swap` → `revealAll` → `nextRound`);
  finalIntro `openWagers, swapFinal`; finalWager `showQuestion, swapFinal`; finalAnswer `startReveal`; finalReveal
  `confirm, accept, reject` or `revealNext, flip`; podium `playAgain, newTeams`.

### `hostView.host.introScript` (lobby only, else null) — "Read this to the room"
`{ title, minutes, words, joinAddress, summary, sections:[{title, parts:[{kind:'say'|'em'|'cue', text}]}], text }` —
`say` = read normally, `em` = read big/bold, `cue` = stage direction shown as `[cue]`. `text` is the plain version.

## 8. Views

Every view = `publicView` (+ role extras). Objects are built field by field from whitelists in `src/views.js`.

### 8.1 publicView (TV, and the base of everything)
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
lastSpin: {segmentIndex, teamId, by:{playerId,name}|null} | null              (ext) the last landed spin ("Max pressed spin")
challenge: null | {...see 8.2},
timer: null | {kind, label, running, endsAt|null, durationMs, remainingMs, started, ended},
lastAwards: [{id, teamId, delta, reason, doubled}],   // last 12; animate ids you haven't seen
roundBreak: null | {round, nextRound, finalNext, bonusDone, bonusPlanned,                  (ext) only in phase roundBreak
                    standings:[{teamId, score, rank, prevRank|null, move:'up'|'down'|'same'|null, places}], leadBy},
                    // movement compares with the previous round break (null after round 1)
final: null | {category, categoryLabel, question|null, wagers:[{teamId, locked, max}], submissions:[{teamId, answered}],
               revealOrder:[teamId], revealed:[{teamId, text, by, wager, judged, correct|null, delta|null, before, after|null}],
               current: teamId|null, done, answer|null},
               // wagers[].max = max(score,300) (public: depends only on the score); amounts stay hidden until revealed
podium: null | {standings:[{teamId, score, place}], awards:[{key:'fastestFinger'|'starPerformer', title, playerId, name, teamId, detail}]},
savedGame: null | {summary:{savedAt, phase, round, totalRounds, teams:[{name, score}], players}}
```
Timer kinds: `trivia sound steal dare showdown list hotseat allplay bonus vote wager final`.

### 8.2 `challenge` (public)
Common: `id, type, stage, segmentIndex, rule, points, started, revealed, firstTime (ext: first time this mini-game comes up
this game — show the rules), result:{kind, awards:[{teamId, delta}]}|null`.
- `trivia`: `category ('christmas'|'popculture'|'movies'), categoryLabel ('Christmas Trivia'|'Pop Culture'|'Christmas Movies'), difficulty?, pickedBy?:{playerId,name}|null, question?, movie?|null, movieYear?|null (Christmas Movies: the film, once the question is shown), stealPoints?, hasHint?, hint? (only after showHint), answer? funFact? (only when revealed), buzz:null|{open, armingUntil, eligibleTeamIds, lockedTeamIds, winner:{playerId,name,teamId}|null}`
- `sounditout`: `performer:{playerId,name,teamId}|null, stealPoints, hasHint, hint?, answer? artist? (only when revealed — the song is NEVER public before), buzz`
- `dare`: `performer, partner (pair dares), dare:{title, instructions, who:'one'|'pair'|'team'|'everyone', time, props, judge, hasSecret}, answer? (the secret, after reveal/done), vote:null|{open, endsAt, nailed, good, voters, eligible, result}, dareResult:null|{result, bonus}`
- `showdown`: `targets, performer, rival:{teamId, playerId|null, name|null}|null, showdown:{title, instructions, time, winner, props}|null, winnerSide:'active'|'rival'|'tie'|null, eyeing:null|{teamId, by:{playerId,name}} (ext)`
- `rapidlist`: `list:{prompt, ticked:[string], count, max:6, each:50, answers? (only after host reveal)}`
- `hotseat`: `performer, hotseat:{index, total, results:['correct'|'wrong'|'pass'], question|null, each:50, banked (ext: points so far)}`
- `allplay` / `bonus`: `question, submissions:[{teamId, answered}]` → after reveal each row also has `text, name, correct, first, delta`; plus `answer, funFact, firstTeamId`; allplay has `firstBonus:50`
- `grinch`: `targets, gift:{toTeamId, amount}|null, steal:{from, to, amount}|null, eyeing (ext, as showdown)`. `points` = the most that can move (150, 300 under Double Down); the amount actually taken is capped at the victim's score
- `doubledown`: nothing extra (see `teams[].multiplier`)

### 8.3 hostView = publicView + `host`
```
host: { isHost:true, pin, candidates:[{address, iface}], joinIp,
  answer, accept[], hint, funFact,                 // current trivia / allplay / bonus question (or song title for sounditout)
  secret:{label, value, detail}|null,              // dare secret or song
  song:{title, artist, accept[], hint}|null,
  listAnswers[]|null, listNote|null,
  hotseatQuestion, hotseatAnswer, hotseatAccept[], hotseatQuestions:[{index, question, answer, result|null}],
  submissions:[{teamId, text, by(playerId), name, at, elapsedMs, autoCorrect, match:'exact'|'match'|'close'|'none',
                override|null, correct, first, preview}],   // allplay / bonus; preview = points if revealed now (incl. ×2, +50)
  payout,                                          // (ext) sum of previews ("Paying out 250")
  final:null|{question, answer, accept[], category, categoryLabel,
              wagers:[{teamId, amount|null, locked, by(name)|null, max}],
              answers:[{teamId, text|null, by|null, autoCorrect, match, override|null}],          // during finalAnswer
              rows:[{teamId, text, by, wager, autoCorrect, match, override|null, correct, revealed, judged, delta, before, after}],  // reveal order
              current, done},
  canUndo, undoLabel, undoDepth,
  contentStats:{'christmas-easy':{total,left}, …, 'movies-hard', quick, songs, lists, dares, finals, showdowns},
  contentProblems:[{file, id, error}], warnings:[{code, text, teamId?}],
  mascots:[{mascot, color, colorName}],
  connections:{tv, hosts, phones},                 // (ext) "TV connected", "2 host screens", "14 phones"
  secretPeeked: boolean,                           // (ext) the performer pressed-and-held their secret
  can:{ <every host event name without the 'host:' prefix>: boolean },   // server-computed
  coach:{...§7}, introScript:{...§7}|null }
```
`match`: `exact` (same words), `match` (the answer plus a couple of extra words / an aside in brackets), `close` (small
typo — counts as correct but show it amber for the host to check), `none`. Everything except `none` auto-marks correct.

### 8.4 playerView = publicView + extras
```
me: {playerId, name, teamId|null} | null          // null = show the join screen
secret: {label, value, detail} | null             // ONLY the current performer (sound it out / dare with a secret)
myTeam: null | {teamId, isActive, submission:{text, by(name), byPlayerId, at}|null, wager:{amount, locked, by}|null, maxWager|null}
myVote: 'nailed' | 'good' | null
can: {spin, pickDifficulty, buzz, pickTarget, previewTarget, submitAnswer, wager, vote, peek}
```

### 8.5 Login view (pending host socket, see §1)
`{ now, phase, needPin:true, isHost:false, joinUrl, teamCount, playerCount, host:null }` — nothing else.

## 9. HTTP
- `/` player page (`public/index.html`), `/tv`, `/host`; `/player` → 302 `/`. Static files from `public/` (no-cache).
- `/fonts/lilita-one/lilita-one-latin-400-normal.woff2`, `/fonts/fredoka/fredoka-latin-{400,500,600,700}-normal.woff2` (+ every other file in the packages' `files/` folders), cached 30 days.
- `/api/info` → `{joinUrl, candidates:[{address, iface, joinUrl}], port, tvUrl, hostUrl}` (no PIN).
- `/api/qr.svg` → QR of the current `joinUrl`, modules `#0B1F17` on `#FFF6E5`, `no-store` (add `?v=<joinUrl>` to bust caches after `joinIp` changes).

## 10. Rules & numbers the UI may want
- Points: trivia 100/200/300, steal = half (hint halves first); All Play 100 + 50 first; dare 200/100/0 +50; showdown 200 / tie 100 each; Sound It Out 200, steal 100; Rapid List & Hot Seat 50 each, max 300 (6); Grinch 150 (×2 under DD, capped at victim score) / gift 100; bonus 100; Final ±wager (floor 0).
- Default timers (ms): spin 5000, steal arm 3000, trivia 20000, steal window 10000, sound 30000, list 30000, hot seat 45000, All Play 20000, bonus 20000, vote 15000, wager 30000, final answer 45000; warning fx at 5000 left.
- Rounds: `clamp(round(20/teams), 3, 6)` while `settings.autoRounds`; `settings.estimatedMinutes = round(5 + teams×rounds×2.6 + 9)`. Round bonus defaults on for ≥ 5 teams while `roundBonusAuto`.
- Double Down: `teams[i].multiplier` is 2 for the active team for the rest of the turn; applies only to that team's positive points.
- Final wager bound: `max(score, 300)` (SPEC/TECH; one TV artboard says 500 — the server uses 300; show `final.wagers[].max`).
- Podium places share ties (`place = 1 + number of teams with a higher score`). Awards appear only if earned (Fastest Finger = steal buzzes won + All Play first-correct answers; Star Performer = points earned as performer/called-up player).
- Content: Hot Seat / All Play / bonus draw easy+medium trivia with ≤ 4-word answers from all three trivia categories. Christmas Movies falls back to Christmas questions with `topic:'movies'` if `data/trivia-movies.json` is missing.

## 11. Examples (generated from a real scripted game)

Teams: t1 Team Rudolph (Max, Aunt Linda), t2 The Grinches (Priya), t3 Frosty's Crew (Sam). Example 1 shows every base
field; later examples show only the fields that matter. `host.can` lists only the `true` flags; `introScript.sections`
is shortened.

### 1. Lobby — hostView (every base field shown once; host block incl. coach + introScript)

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
  "lastSpin": null,
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
    "contentStats": {
      "christmas-easy": {"total": 32, "left": 32},
      "...": "one {total,left} per pool"
    },
    "contentProblems": [],
    "warnings": [],
    "mascots": "[...8 {mascot,color,colorName}]",
    "connections": {"tv": 1, "hosts": 2, "phones": 4},
    "secretPeeked": false,
    "can": {
      "createTeam": true,
      "updateTeam": true,
      "removeTeam": true,
      "movePlayer": true,
      "kickPlayer": true,
      "setRounds": true,
      "setOption": true,
      "start": true,
      "reorderTeams": true,
      "shuffleTeams": true,
      "soundTest": true,
      "resetGame": true
    },
    "coach": {
      "headline": "Waiting for players — 4 joined",
      "say": "Grab your phones! Scan the code on the TV, type your name and pick a team. Can’t scan? Type 10.0.0.235:3000 into your browser.",
      "steps": ["Make the teams — done, 3 teams ready", "Check everyone’s on a team", "Read the opening script, then press Start"],
      "tips": [],
      "actions": [
        {
          "id": "start",
          "label": "Start game",
          "event": "host:start",
          "payload": null,
          "kind": "primary",
          "shortcut": "S",
          "detail": "Round 1 opens with Team Rudolph at the wheel"
        },
        {
          "id": "introScript",
          "label": "Read the opening script",
          "event": null,
          "payload": null,
          "kind": "secondary",
          "shortcut": null,
          "local": "introScript",
          "detail": "60-second welcome"
        },
        {
          "id": "soundTest",
          "label": "Play test sound",
          "event": "host:soundTest",
          "payload": null,
          "kind": "secondary",
          "shortcut": null,
          "detail": "Plays a jingle on the TV"
        }
      ],
      "primary": "start",
      "progress": []
    },
    "introScript": {
      "title": "Read this to the room",
      "minutes": 1,
      "words": 199,
      "joinAddress": "10.0.0.235:3000",
      "summary": "4 players on 3 teams are in. Round 1 opens with Team Rudolph at the wheel.",
      "sections": [
        {
          "title": "Welcome",
          "parts": [
            {"kind": "say", "text": "Evening, everyone, and welcome to "},
            {"kind": "em", "text": "Christmas Chaos"},
            {"kind": "say", "text": ": the only game show where Grandma can legally steal your points."}
          ]
        },
        {
          "title": "Join in",
          "parts": [
            {"kind": "em", "text": "Phones out! "},
            {"kind": "cue", "text": "point at the TV"},
            {"kind": "say", "text": " Scan the code on the TV, or type "},
            {"kind": "em", "text": "10.0.0.235:3000"},
            {"kind": "say", "text": " "},
            {"kind": "cue", "text": "say it slowly, dot by dot"},
            {"kind": "say", "text": " Add your name, pick a team, and you’re in. Same Wi-Fi as me, not the guest one."}
          ]
        },
        "... 4 more sections"
      ],
      "text": "Evening, everyone, and welcome to Christmas Chaos: the only game show where Grandma can legally steal your points.\n\nPhones out! [point at the TV] Scan the code ..."
    }
  }
}
```

### 2. Second host device before the PIN — the minimal login view (`state` for an unauthorised host socket)

```json
{"now": 1764201600000, "phase": "lobby", "needPin": true, "isHost": false, "joinUrl": "http://10.0.0.235:3000/", "teamCount": 3, "playerCount": 4, "host": null}
```

### 3. Turn intro — playerView of a player on the active team

```json
{
  "phase": "turnIntro",
  "turnId": 1,
  "activeTeamId": "t1",
  "spin": null,
  "challenge": null,
  "timer": null,
  "roundBreak": null,
  "final": null,
  "podium": null,
  "me": {"playerId": "p1", "name": "Max", "teamId": "t1"},
  "secret": null,
  "myTeam": {"teamId": "t1", "isActive": true, "submission": null, "wager": null, "maxWager": null},
  "myVote": null,
  "can": {
    "spin": true,
    "pickDifficulty": false,
    "buzz": false,
    "pickTarget": false,
    "previewTarget": false,
    "submitAnswer": false,
    "wager": false,
    "vote": false,
    "peek": false
  },
  "...": "base fields as in example 1"
}
```

### 4. Spinning — publicView (TV)

```json
{
  "phase": "spinning",
  "spin": {
    "segmentIndex": 8,
    "startedAt": 1764201600000,
    "durationMs": 5000,
    "by": {"playerId": "p1", "name": "Max"}
  },
  "lastSegmentIndex": 0,
  "lastSpin": null,
  "activeTeamId": "t1",
  "challenge": null,
  "timer": null,
  "...": "other fields as usual"
}
```

### 5. Christmas Movies question — hostView (host block + coach)

```json
{
  "phase": "challenge",
  "activeTeamId": "t2",
  "challenge": {
    "id": 2,
    "type": "trivia",
    "stage": "question",
    "segmentIndex": 4,
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.",
    "points": 200,
    "started": true,
    "revealed": false,
    "firstTime": true,
    "category": "movies",
    "categoryLabel": "Christmas Movies",
    "difficulty": "medium",
    "pickedBy": {"playerId": "p3", "name": "Priya"},
    "question": "In Home Alone 2, what's the name of the toy store that Harry and Marv plan to rob on Christmas Eve?",
    "movie": "Home Alone 2: Lost in New York",
    "movieYear": 1992,
    "stealPoints": 100,
    "hasHint": true,
    "buzz": null,
    "result": null
  },
  "timer": {"kind": "trivia", "label": "Answer out loud", "running": true, "endsAt": 1764201630000, "durationMs": 20000, "remainingMs": 16000, "started": true, "ended": false},
  "host": {
    "isHost": true,
    "pin": "4821",
    "candidates": [
      {"address": "10.0.0.235", "iface": "Wi-Fi"}
    ],
    "joinIp": "10.0.0.235",
    "answer": "Duncan's Toy Chest",
    "accept": ["Duncan's", "Duncans Toy Chest", "Duncan's Toys"],
    "hint": "It's named after its kind, elderly owner.",
    "funFact": "Its kind owner, Mr. Duncan, was donating the store's Christmas proceeds to a children's hospital.",
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
    "contentStats": {
      "christmas-easy": {"total": 32, "left": 32},
      "...": "one {total,left} per pool"
    },
    "contentProblems": [],
    "warnings": [],
    "mascots": "[...8 {mascot,color,colorName}]",
    "connections": {"tv": 1, "hosts": 2, "phones": 4},
    "secretPeeked": false,
    "can": {
      "updateTeam": true,
      "movePlayer": true,
      "kickPlayer": true,
      "setRounds": true,
      "setOption": true,
      "judge": true,
      "openSteal": true,
      "reveal": true,
      "showHint": true,
      "timer": true,
      "swapQuestion": true,
      "soundTest": true,
      "endChallenge": true,
      "adjustScore": true,
      "nextTurn": true,
      "resetGame": true
    },
    "coach": {
      "headline": "The Grinches is answering (Medium · 200)",
      "say": "In Home Alone 2, what's the name of the toy store that Harry and Marv plan to rob on Christmas Eve?\nThe Grinches — 20 seconds, go!",
      "steps": ["Read the question out loud", "Listen for one answer (it’s on your private card)", "Tap Correct or Wrong"],
      "tips": ["Wrong opens a steal — the other teams can buzz in for 100.", "From Home Alone 2: Lost in New York (1992) — the TV shows the film title."],
      "actions": [
        {
          "id": "correct",
          "label": "Correct +200",
          "event": "host:judge",
          "payload": {"result": "correct"},
          "kind": "success",
          "shortcut": "C",
          "detail": "Points fly to The Grinches"
        },
        {
          "id": "wrong",
          "label": "Wrong",
          "event": "host:judge",
          "payload": {"result": "wrong"},
          "kind": "danger",
          "shortcut": "W",
          "detail": "Steal for 100 comes next"
        },
        {"id": "hint", "label": "Show hint", "event": "host:showHint", "payload": null, "kind": "secondary", "shortcut": "H", "detail": "Halves the points"},
        {
          "id": "reveal",
          "label": "Reveal answer",
          "event": "host:reveal",
          "payload": null,
          "kind": "secondary",
          "shortcut": "R",
          "detail": "Ends it, no points",
          "confirm": "Reveal the answer on the TV? Nobody scores."
        },
        {"id": "swap", "label": "Swap question", "event": "host:swapQuestion", "payload": null, "kind": "secondary", "shortcut": null}
      ],
      "primary": "correct",
      "progress": [
        {"label": "Spun Christmas Movies", "state": "done"},
        {"label": "Pick difficulty", "state": "done", "detail": "Medium · 200"},
        {"label": "Answer & judge", "state": "current"},
        {"label": "Steal, if they miss", "state": "todo"},
        {"label": "Next turn", "state": "todo"}
      ]
    },
    "introScript": null
  },
  "...": "other fields as usual"
}
```

### 6. Steal, someone buzzed — publicView (TV)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 2,
    "type": "trivia",
    "stage": "steal",
    "segmentIndex": 4,
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.",
    "points": 200,
    "started": true,
    "revealed": false,
    "firstTime": true,
    "category": "movies",
    "categoryLabel": "Christmas Movies",
    "difficulty": "medium",
    "pickedBy": {"playerId": "p3", "name": "Priya"},
    "question": "In Home Alone 2, what's the name of the toy store that Harry and Marv plan to rob on Christmas Eve?",
    "movie": "Home Alone 2: Lost in New York",
    "movieYear": 1992,
    "stealPoints": 100,
    "hasHint": true,
    "buzz": {
      "open": false,
      "armingUntil": null,
      "eligibleTeamIds": ["t1", "t3"],
      "lockedTeamIds": [],
      "winner": {"playerId": "p4", "name": "Sam", "teamId": "t3"}
    },
    "result": null
  },
  "timer": null,
  "...": "other fields as usual"
}
```

### 7. Steal, someone buzzed — playerView of the stealing team (`can` all false: buzzers closed)

```json
{
  "me": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
  "myTeam": {"teamId": "t3", "isActive": false, "submission": null, "wager": null, "maxWager": null},
  "myVote": null,
  "secret": null,
  "can": {
    "spin": false,
    "pickDifficulty": false,
    "buzz": false,
    "pickTarget": false,
    "previewTarget": false,
    "submitAnswer": false,
    "wager": false,
    "vote": false,
    "peek": false
  },
  "...": "other fields as usual"
}
```

### 8. Turn result after a steal — publicView challenge + lastAwards; and the host coach

```json
{
  "challenge": {
    "id": 2,
    "type": "trivia",
    "stage": "done",
    "segmentIndex": 4,
    "rule": "Pick Easy, Medium or Hard, then answer out loud in 20 s. Miss it and the other teams can steal.",
    "points": 200,
    "started": true,
    "revealed": true,
    "firstTime": true,
    "category": "movies",
    "categoryLabel": "Christmas Movies",
    "difficulty": "medium",
    "pickedBy": {"playerId": "p3", "name": "Priya"},
    "question": "In Home Alone 2, what's the name of the toy store that Harry and Marv plan to rob on Christmas Eve?",
    "movie": "Home Alone 2: Lost in New York",
    "movieYear": 1992,
    "stealPoints": 100,
    "hasHint": true,
    "answer": "Duncan's Toy Chest",
    "funFact": "Its kind owner, Mr. Duncan, was donating the store's Christmas proceeds to a children's hospital.",
    "buzz": {
      "open": false,
      "armingUntil": null,
      "eligibleTeamIds": ["t1", "t3"],
      "lockedTeamIds": [],
      "winner": {"playerId": "p4", "name": "Sam", "teamId": "t3"}
    },
    "result": {
      "kind": "stolen",
      "awards": [
        {"teamId": "t3", "delta": 100}
      ]
    }
  },
  "lastAwards": [
    {"id": 1, "teamId": "t3", "delta": 100, "reason": "Steal", "doubled": false}
  ],
  "host.coach": {
    "headline": "Frosty's Crew stole it! +100",
    "say": "The answer: Duncan's Toy Chest. Its kind owner, Mr. Duncan, was donating the store's Christmas proceeds to a children's hospital.",
    "steps": ["Points are on the scoreboard (fix anything with ± or Undo)", "Press Next turn when the room is ready"],
    "tips": ["Last change: Frosty's Crew +100 · Steal. Wrong? Press Undo (U)."],
    "actions": [
      {
        "id": "nextTurn",
        "label": "Next turn",
        "event": "host:nextTurn",
        "payload": {"turnId": 2},
        "kind": "primary",
        "shortcut": "N",
        "detail": "Frosty's Crew is up next"
      }
    ],
    "primary": "nextTurn",
    "progress": [
      {"label": "Spun Christmas Movies", "state": "done"},
      {"label": "Pick difficulty", "state": "done", "detail": "Medium · 200"},
      {"label": "Answer & judge", "state": "done"},
      {"label": "Steal, if they miss", "state": "done"},
      {"label": "Next turn", "state": "current"}
    ]
  }
}
```

### 9. Dare with a secret — playerView of the performer (`secret` only here and in hostView)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 3,
    "type": "dare",
    "stage": "perform",
    "segmentIndex": 1,
    "rule": "One of you performs the dare. Nail it for 200!",
    "points": 200,
    "started": false,
    "revealed": false,
    "firstTime": false,
    "performer": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
    "partner": null,
    "dare": {
      "title": "Banned Words",
      "instructions": "Get your team to say the word on your phone. Don't say any part of it or any of the banned words shown with it. No gestures, no 'sounds like'.",
      "who": "one",
      "time": 30,
      "props": [],
      "judge": "Team says the exact word within 30 s; saying a banned word or part of the answer = fail.",
      "hasSecret": true
    },
    "vote": null,
    "dareResult": null,
    "result": null
  },
  "timer": {"kind": "dare", "label": "Dare", "running": false, "endsAt": null, "durationMs": 30000, "remainingMs": 30000, "started": false, "ended": false},
  "me": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
  "secret": {"label": "Get your team to say this word. Never say the banned words!", "value": "NORTH POLE (banned: Santa, Arctic, south)", "detail": ""},
  "can": {
    "spin": false,
    "pickDifficulty": false,
    "buzz": false,
    "pickTarget": false,
    "previewTarget": false,
    "submitAnswer": false,
    "wager": false,
    "vote": false,
    "peek": true
  },
  "...": "other fields as usual"
}
```

### 10. Dare before the timer — host coach (judging locked until the timer starts)

```json
{
  "headline": "Dare: Banned Words — Sam performs",
  "say": "Sam, your secret is on your phone. Press and hold to peek. Get your team to say the word on your phone. Don't say any part of it or any of the banned words shown with it. No gestures, no 'sounds like'.",
  "steps": ["Wait until Sam is ready", "Start the 30 s timer", "Judge it yourself, or let the room vote"],
  "tips": ["How to judge: Team says the exact word within 30 s; saying a banned word or part of the answer = fail."],
  "actions": [
    {
      "id": "timerStart",
      "label": "Start 30 s timer",
      "event": "host:timer",
      "payload": {"action": "start"},
      "kind": "primary",
      "shortcut": "T"
    },
    {
      "id": "nailed",
      "label": "Nailed it +200",
      "event": "host:dareResult",
      "payload": {"result": "nailed"},
      "kind": "success",
      "shortcut": "1",
      "disabled": true,
      "reason": "Unlocks when the timer starts"
    },
    {
      "id": "valiant",
      "label": "Valiant effort +100",
      "event": "host:dareResult",
      "payload": {"result": "valiant"},
      "kind": "secondary",
      "shortcut": "2",
      "disabled": true,
      "reason": "Unlocks when the timer starts"
    },
    {
      "id": "fail",
      "label": "Not this time",
      "event": "host:dareResult",
      "payload": {"result": "fail"},
      "kind": "secondary",
      "shortcut": "3",
      "detail": "0 points",
      "disabled": true,
      "reason": "Unlocks when the timer starts"
    },
    {
      "id": "vote",
      "label": "Let the room vote",
      "event": "host:openVote",
      "payload": null,
      "kind": "secondary",
      "shortcut": "V",
      "disabled": true,
      "reason": "Unlocks when the timer starts"
    },
    {"id": "reroll", "label": "Re-roll performer", "event": "host:rerollPerformer", "payload": null, "kind": "secondary", "shortcut": "P"},
    {
      "id": "swapSecret",
      "label": "Swap secret",
      "event": "host:swapSecret",
      "payload": null,
      "kind": "secondary",
      "shortcut": null,
      "detail": "Use it if Sam doesn’t know this one"
    },
    {
      "id": "swapDare",
      "label": "Swap dare",
      "event": "host:swapQuestion",
      "payload": null,
      "kind": "secondary",
      "shortcut": null,
      "detail": "Keeps Sam as the performer"
    },
    {"id": "skip", "label": "Skip dare", "event": "host:endChallenge", "payload": null, "kind": "danger", "shortcut": null, "confirm": "Skip dare? Nobody scores."}
  ],
  "primary": "timerStart",
  "progress": [
    {"label": "Spun Dare", "state": "done"},
    {"label": "Perform & judge", "state": "current"},
    {"label": "Room vote (optional)", "state": "todo"},
    {"label": "Next turn", "state": "todo"}
  ]
}
```

### 11. Dare room vote — publicView (TV)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 3,
    "type": "dare",
    "stage": "vote",
    "segmentIndex": 1,
    "rule": "One of you performs the dare. Nail it for 200!",
    "points": 200,
    "started": true,
    "revealed": false,
    "firstTime": false,
    "performer": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
    "partner": null,
    "dare": {
      "title": "Banned Words",
      "instructions": "Get your team to say the word on your phone. Don't say any part of it or any of the banned words shown with it. No gestures, no 'sounds like'.",
      "who": "one",
      "time": 30,
      "props": [],
      "judge": "Team says the exact word within 30 s; saying a banned word or part of the answer = fail.",
      "hasSecret": true
    },
    "vote": {"open": true, "endsAt": 1764201647000, "nailed": 1, "good": 0, "voters": 1, "eligible": 3, "result": null},
    "dareResult": null,
    "result": null
  },
  "timer": {"kind": "vote", "label": "Room vote", "running": true, "endsAt": 1764201647000, "durationMs": 15000, "remainingMs": 15000, "started": true, "ended": false},
  "...": "other fields as usual"
}
```

### 12. Dare room vote — playerView of a voter who already voted (can still change it)

```json
{
  "me": {"playerId": "p1", "name": "Max", "teamId": "t1"},
  "myVote": "nailed",
  "can": {
    "spin": false,
    "pickDifficulty": false,
    "buzz": false,
    "pickTarget": false,
    "previewTarget": false,
    "submitAnswer": false,
    "wager": false,
    "vote": true,
    "peek": false
  },
  "...": "other fields as usual"
}
```

### 13. Round break — publicView roundBreak (standings with movement)

```json
{
  "phase": "roundBreak",
  "round": 1,
  "totalRounds": 6,
  "roundBreak": {
    "round": 1,
    "nextRound": 2,
    "finalNext": false,
    "bonusDone": false,
    "bonusPlanned": false,
    "standings": [
      {"teamId": "t3", "score": 300, "rank": 1, "prevRank": null, "move": null, "places": 0},
      {"teamId": "t1", "score": 0, "rank": 2, "prevRank": null, "move": null, "places": 0},
      {"teamId": "t2", "score": 0, "rank": 2, "prevRank": null, "move": null, "places": 0}
    ],
    "leadBy": 300
  },
  "challenge": null,
  "...": "other fields as usual"
}
```

### 14. Grinch Steal pick — publicView challenge (the TV shows who is being eyed)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 4,
    "type": "grinch",
    "stage": "pickTarget",
    "segmentIndex": 6,
    "rule": "Steal 150 points from a team that is ahead of you.",
    "points": 150,
    "started": false,
    "revealed": false,
    "firstTime": true,
    "targets": ["t3"],
    "gift": null,
    "steal": null,
    "eyeing": {
      "teamId": "t3",
      "by": {"playerId": "p2", "name": "Aunt Linda"}
    },
    "result": null
  },
  "...": "other fields as usual"
}
```

### 15. Grinch Steal pick — playerView `can` of the active team

```json
{
  "me": {"playerId": "p2", "name": "Aunt Linda", "teamId": "t1"},
  "can": {"spin": false, "pickDifficulty": false, "buzz": false, "pickTarget": true, "previewTarget": true, "submitAnswer": false, "wager": false, "vote": false, "peek": false},
  "...": "other fields as usual"
}
```

### 16. All Play answering — playerView (a teammate sees who answered for the team)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 5,
    "type": "allplay",
    "stage": "answering",
    "segmentIndex": 10,
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first.",
    "points": 100,
    "started": true,
    "revealed": false,
    "firstTime": true,
    "question": "Which Addams Family daughter got her own Netflix series in 2022, starring Jenna Ortega?",
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": false},
      {"teamId": "t3", "answered": true}
    ],
    "firstBonus": 50,
    "result": null
  },
  "timer": {"kind": "allplay", "label": "All Play", "running": true, "endsAt": 1764201662000, "durationMs": 20000, "remainingMs": 16000, "started": true, "ended": false},
  "me": {"playerId": "p2", "name": "Aunt Linda", "teamId": "t1"},
  "myTeam": {
    "teamId": "t1",
    "isActive": false,
    "submission": {"text": "Clarence", "by": "Max", "byPlayerId": "p1", "at": 1764201646000},
    "wager": null,
    "maxWager": null
  },
  "can": {
    "spin": false,
    "pickDifficulty": false,
    "buzz": false,
    "pickTarget": false,
    "previewTarget": false,
    "submitAnswer": true,
    "wager": false,
    "vote": false,
    "peek": false
  },
  "...": "other fields as usual"
}
```

### 17. All Play marking — hostView host block (match kinds, preview points, coach)

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 5,
    "type": "allplay",
    "stage": "marking",
    "segmentIndex": 10,
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first.",
    "points": 100,
    "started": true,
    "revealed": false,
    "firstTime": true,
    "question": "Which Addams Family daughter got her own Netflix series in 2022, starring Jenna Ortega?",
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
    "answer": "Wednesday Addams",
    "accept": ["Wednesday", "Wednesday Addams"],
    "hint": "Her brother is Pugsley.",
    "funFact": "Jenna Ortega choreographed the show's viral dance scene herself, set to The Cramps' “Goo Goo Muck.”",
    "secret": null,
    "song": null,
    "listAnswers": null,
    "listNote": null,
    "hotseatQuestion": null,
    "hotseatAnswer": null,
    "hotseatAccept": [],
    "hotseatQuestions": [],
    "submissions": [
      {
        "teamId": "t1",
        "text": "Clarence",
        "by": "p1",
        "name": "Max",
        "at": 1764201646000,
        "elapsedMs": 4000,
        "autoCorrect": false,
        "match": "none",
        "override": null,
        "correct": false,
        "first": false,
        "preview": 0
      },
      {
        "teamId": "t3",
        "text": "wednesday addams!!",
        "by": "p4",
        "name": "Sam",
        "at": 1764201644500,
        "elapsedMs": 2500,
        "autoCorrect": true,
        "match": "exact",
        "override": null,
        "correct": true,
        "first": true,
        "preview": 150
      }
    ],
    "final": null,
    "canUndo": true,
    "undoLabel": "Team Rudolph steals 150 from Frosty's Crew",
    "undoDepth": 3,
    "contentStats": {
      "christmas-easy": {"total": 32, "left": 32},
      "...": "one {total,left} per pool"
    },
    "contentProblems": [],
    "warnings": [],
    "mascots": "[...8 {mascot,color,colorName}]",
    "connections": {"tv": 1, "hosts": 2, "phones": 4},
    "secretPeeked": false,
    "can": {
      "updateTeam": true,
      "movePlayer": true,
      "kickPlayer": true,
      "setRounds": true,
      "setOption": true,
      "timer": true,
      "soundTest": true,
      "endChallenge": true,
      "markAnswer": true,
      "revealAnswers": true,
      "adjustScore": true,
      "undo": true,
      "nextTurn": true,
      "continue": true,
      "resetGame": true
    },
    "payout": 150,
    "coach": {
      "headline": "Answers are in: check the marks, then reveal",
      "say": null,
      "steps": ["Flip any auto-mark you disagree with (Accept / Reject)", "Reveal all answers on the TV"],
      "tips": ["Revealing locks every phone."],
      "actions": [
        {
          "id": "revealAll",
          "label": "Reveal all answers on TV",
          "event": "host:revealAnswers",
          "payload": null,
          "kind": "primary",
          "shortcut": "R",
          "detail": "Pays out 150"
        }
      ],
      "primary": "revealAll",
      "progress": [
        {"label": "Spun All Play", "state": "done"},
        {"label": "Everyone types", "state": "done"},
        {"label": "Mark & reveal", "state": "current"},
        {"label": "Next turn", "state": "todo"}
      ]
    },
    "introScript": null
  },
  "...": "other fields as usual"
}
```

### 18. All Play revealed — publicView challenge

```json
{
  "phase": "turnResult",
  "challenge": {
    "id": 5,
    "type": "allplay",
    "stage": "done",
    "segmentIndex": 10,
    "rule": "Every team types an answer on a phone. 100 for each right answer, +50 for the first.",
    "points": 100,
    "started": true,
    "revealed": true,
    "firstTime": true,
    "question": "Which Addams Family daughter got her own Netflix series in 2022, starring Jenna Ortega?",
    "submissions": [
      {"teamId": "t1", "answered": true, "text": "Clarence", "name": "Max", "correct": false, "first": false, "delta": 0},
      {"teamId": "t2", "answered": false},
      {"teamId": "t3", "answered": true, "text": "wednesday addams!!", "name": "Sam", "correct": true, "first": true, "delta": 150}
    ],
    "answer": "Wednesday Addams",
    "funFact": "Jenna Ortega choreographed the show's viral dance scene herself, set to The Cramps' “Goo Goo Muck.”",
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
    {"id": 1, "teamId": "t3", "delta": 100, "reason": "Steal", "doubled": false},
    {"id": 2, "teamId": "t3", "delta": 200, "reason": "Dare", "doubled": false},
    {"id": 3, "teamId": "t3", "delta": -150, "reason": "Grinch Steal", "doubled": false},
    {"id": 4, "teamId": "t1", "delta": 150, "reason": "Grinch Steal", "doubled": false},
    {"id": 5, "teamId": "t3", "delta": 150, "reason": "All Play", "doubled": false}
  ],
  "...": "other fields as usual"
}
```

### 19. Hot Seat in play — publicView challenge

```json
{
  "phase": "challenge",
  "challenge": {
    "id": 6,
    "type": "hotseat",
    "stage": "hotseat",
    "segmentIndex": 3,
    "rule": "One player, alone, 45 seconds: up to 6 quick questions. 50 points each.",
    "points": 300,
    "started": true,
    "revealed": false,
    "firstTime": true,
    "performer": {"playerId": "p4", "name": "Sam", "teamId": "t3"},
    "hotseat": {
      "index": 2,
      "total": 6,
      "results": ["correct", "pass"],
      "question": "Sally tries to ground the Pumpkin King's Christmas Eve sleigh ride by pouring out a magic potion. What weather does it create?",
      "each": 50,
      "banked": 50
    },
    "result": null
  },
  "timer": {"kind": "hotseat", "label": "Hot Seat", "running": true, "endsAt": 1764201716000, "durationMs": 45000, "remainingMs": 45000, "started": true, "ended": false},
  "...": "other fields as usual"
}
```

### 20. Final intro — host coach

```json
{
  "headline": "Final Chaos!",
  "say": "It’s time for FINAL CHAOS! Tonight’s final category is… Christmas! Every team: wager any amount up to your score — or up to 300 if you’re behind. Right answer wins it, wrong answer loses it.",
  "steps": ["Read the category out loud", "Open the wagers"],
  "tips": ["The question and answer are on your private card. The TV shows only the category for now."],
  "actions": [
    {
      "id": "openWagers",
      "label": "Open wagers",
      "event": "host:continue",
      "payload": null,
      "kind": "primary",
      "shortcut": "Enter",
      "detail": "Phones show the wager slider"
    },
    {"id": "swapFinal", "label": "Swap question", "event": "host:swapQuestion", "payload": null, "kind": "secondary", "shortcut": null}
  ],
  "primary": "openWagers",
  "progress": [
    {"label": "Wager", "state": "current"},
    {"label": "Answer", "state": "todo"},
    {"label": "Reveal", "state": "todo"}
  ]
}
```

### 21. Final wager — playerView

```json
{
  "phase": "finalWager",
  "final": {
    "category": "christmas",
    "categoryLabel": "Christmas",
    "question": null,
    "wagers": [
      {"teamId": "t1", "locked": true, "max": 300},
      {"teamId": "t2", "locked": false, "max": 300},
      {"teamId": "t3", "locked": false, "max": 350}
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
  "timer": {"kind": "wager", "label": "Wagers", "running": true, "endsAt": 1764201716000, "durationMs": 30000, "remainingMs": 30000, "started": true, "ended": false},
  "myTeam": {
    "teamId": "t1",
    "isActive": false,
    "submission": null,
    "wager": {"amount": 300, "locked": true, "by": "Max"},
    "maxWager": 300
  },
  "can": {
    "spin": false,
    "pickDifficulty": false,
    "buzz": false,
    "pickTarget": false,
    "previewTarget": false,
    "submitAnswer": false,
    "wager": true,
    "vote": false,
    "peek": false
  },
  "...": "other fields as usual"
}
```

### 22. Final reveal (2nd team revealed, awaiting the host mark) — publicView

```json
{
  "phase": "finalReveal",
  "teams": [
    {"id": "t1", "name": "Team Rudolph", "mascot": "star", "color": "#FF5A4E", "score": 150, "rank": 2, "connectedCount": 2, "playerCount": 2, "multiplier": 1},
    {"id": "t2", "name": "The Grinches", "mascot": "gift", "color": "#B794FF", "score": 0, "rank": 3, "connectedCount": 1, "playerCount": 1, "multiplier": 1},
    {"id": "t3", "name": "Frosty's Crew", "mascot": "snowflake", "color": "#3DDBC4", "score": 350, "rank": 1, "connectedCount": 1, "playerCount": 1, "multiplier": 1}
  ],
  "final": {
    "category": "christmas",
    "categoryLabel": "Christmas",
    "question": "Every year since 1947, London's Trafalgar Square Christmas tree has been a thank-you gift from which country?",
    "wagers": [
      {"teamId": "t1", "locked": true, "max": 300},
      {"teamId": "t2", "locked": true, "max": 300},
      {"teamId": "t3", "locked": true, "max": 350}
    ],
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": true},
      {"teamId": "t3", "answered": false}
    ],
    "revealOrder": ["t2", "t1", "t3"],
    "revealed": [
      {"teamId": "t2", "text": "no idea", "by": "Priya", "wager": 150, "judged": true, "correct": false, "delta": 0, "before": 0, "after": 0},
      {"teamId": "t1", "text": "Norway", "by": "Max", "wager": 300, "judged": false, "correct": null, "delta": null, "before": 150, "after": null}
    ],
    "current": "t1",
    "done": false,
    "answer": null
  },
  "...": "other fields as usual"
}
```

### 23. Final reveal — hostView host.final + coach

```json
{
  "final": {
    "question": "Every year since 1947, London's Trafalgar Square Christmas tree has been a thank-you gift from which country?",
    "answer": "Norway",
    "accept": ["Norge", "Oslo", "Oslo, Norway"],
    "category": "christmas",
    "categoryLabel": "Christmas",
    "wagers": [
      {"teamId": "t1", "amount": 300, "locked": true, "by": "Max", "max": 300},
      {"teamId": "t2", "amount": 150, "locked": true, "by": "Priya", "max": 300},
      {"teamId": "t3", "amount": 0, "locked": true, "by": null, "max": 350}
    ],
    "answers": [
      {"teamId": "t1", "text": "Norway", "by": "Max", "autoCorrect": true, "match": "exact", "override": null},
      {"teamId": "t2", "text": "no idea", "by": "Priya", "autoCorrect": false, "match": "none", "override": null},
      {"teamId": "t3", "text": null, "by": null, "autoCorrect": false, "match": "none", "override": null}
    ],
    "rows": [
      {
        "teamId": "t2",
        "text": "no idea",
        "by": "Priya",
        "wager": 150,
        "autoCorrect": false,
        "match": "none",
        "override": null,
        "correct": false,
        "revealed": true,
        "judged": true,
        "delta": 0,
        "before": 0,
        "after": 0
      },
      {
        "teamId": "t1",
        "text": "Norway",
        "by": "Max",
        "wager": 300,
        "autoCorrect": true,
        "match": "exact",
        "override": null,
        "correct": true,
        "revealed": true,
        "judged": false,
        "delta": null,
        "before": 150,
        "after": null
      },
      {
        "teamId": "t3",
        "text": "",
        "by": null,
        "wager": 0,
        "autoCorrect": false,
        "match": "none",
        "override": null,
        "correct": false,
        "revealed": false,
        "judged": false,
        "delta": null,
        "before": 350,
        "after": null
      }
    ],
    "current": "t1",
    "done": false
  },
  "coach": {
    "headline": "Final reveal — Team Rudolph (2 of 3)",
    "say": "Team Rudolph wagered… 300 points. Their answer: “Norway”… that is… CORRECT!",
    "steps": ["Read the answer out loud", "It’s marked correct (exact match). Disagree? Accept or Reject", "Then reveal the next team"],
    "tips": ["Last change: Frosty's Crew +50 · Hot Seat. Wrong? Press Undo (U)."],
    "actions": [
      {"id": "confirm", "label": "Confirm: correct +300", "event": "host:finalRevealNext", "payload": null, "kind": "primary", "shortcut": "N"},
      {
        "id": "accept",
        "label": "Accept +300",
        "event": "host:markAnswer",
        "payload": {"teamId": "t1", "correct": true},
        "kind": "success",
        "shortcut": "A"
      },
      {
        "id": "reject",
        "label": "Reject −300",
        "event": "host:markAnswer",
        "payload": {"teamId": "t1", "correct": false},
        "kind": "danger",
        "shortcut": "X"
      }
    ],
    "primary": "confirm",
    "progress": [
      {"label": "Wager", "state": "done"},
      {"label": "Answer", "state": "done"},
      {"label": "Reveal", "state": "current"}
    ]
  }
}
```

### 24. Podium — playerView

```json
{
  "phase": "podium",
  "teams": [
    {"id": "t1", "name": "Team Rudolph", "mascot": "star", "color": "#FF5A4E", "score": 450, "rank": 1, "connectedCount": 2, "playerCount": 2, "multiplier": 1},
    {"id": "t2", "name": "The Grinches", "mascot": "gift", "color": "#B794FF", "score": 0, "rank": 3, "connectedCount": 1, "playerCount": 1, "multiplier": 1},
    {"id": "t3", "name": "Frosty's Crew", "mascot": "snowflake", "color": "#3DDBC4", "score": 350, "rank": 2, "connectedCount": 1, "playerCount": 1, "multiplier": 1}
  ],
  "podium": {
    "standings": [
      {"teamId": "t1", "score": 450, "place": 1},
      {"teamId": "t3", "score": 350, "place": 2},
      {"teamId": "t2", "score": 0, "place": 3}
    ],
    "awards": [
      {"key": "fastestFinger", "title": "Fastest Finger", "playerId": "p4", "name": "Sam", "teamId": "t3", "detail": "1 buzz won · 1 first answer"},
      {"key": "starPerformer", "title": "Star Performer", "playerId": "p4", "name": "Sam", "teamId": "t3", "detail": "3 performances · 250 pts"}
    ]
  },
  "final": {
    "category": "christmas",
    "categoryLabel": "Christmas",
    "question": "Every year since 1947, London's Trafalgar Square Christmas tree has been a thank-you gift from which country?",
    "wagers": [
      {"teamId": "t1", "locked": true, "max": 450},
      {"teamId": "t2", "locked": true, "max": 300},
      {"teamId": "t3", "locked": true, "max": 350}
    ],
    "submissions": [
      {"teamId": "t1", "answered": true},
      {"teamId": "t2", "answered": true},
      {"teamId": "t3", "answered": false}
    ],
    "revealOrder": ["t2", "t1", "t3"],
    "revealed": [
      {"teamId": "t2", "text": "no idea", "by": "Priya", "wager": 150, "judged": true, "correct": false, "delta": 0, "before": 0, "after": 0},
      {"teamId": "t1", "text": "Norway", "by": "Max", "wager": 300, "judged": true, "correct": true, "delta": 300, "before": 150, "after": 450},
      {"teamId": "t3", "text": "", "by": null, "wager": 0, "judged": true, "correct": false, "delta": 0, "before": 350, "after": 350}
    ],
    "current": "t3",
    "done": true,
    "answer": "Norway"
  },
  "me": {"playerId": "p3", "name": "Priya", "teamId": "t2"},
  "myTeam": {
    "teamId": "t2",
    "isActive": false,
    "submission": {"text": "no idea", "by": "Priya", "byPlayerId": "p3", "at": 1764201686000},
    "wager": {"amount": 150, "locked": true, "by": "Priya"},
    "maxWager": 300
  },
  "...": "other fields as usual"
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
    "category": "movies",
    "label": "Christmas Movies",
    "lines": ["Christmas", "Movies"],
    "color": "#8E1B3A",
    "ink": "#FFF6E5",
    "icon": "popcorn",
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
