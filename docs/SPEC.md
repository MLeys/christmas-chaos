# Christmas Chaos — Master Spec (v2)

A TV + phones party game for a family Christmas party. Mixed-age adults, 2–8 teams (sweet spot 4–6), 60–75 minutes.
One laptop runs the server and the **Host** screen; a TV shows the **Big Screen**; everyone plays on their **Phone** over the same Wi-Fi.
Learnable in 60 seconds: *"Your team spins the wheel from your phone. Do what it lands on. Most points at the end wins."*

---

## 1. Game flow

1. **Lobby** — TV shows a QR code + URL. Players scan, type a name, tap a team. Host creates teams (name + mascot), sets rounds, presses Start.
2. **Rounds** — every team takes one turn per round, in a fixed order. Default rounds = clamp(round(20 / teams), 3, 6) → 2–3 teams 6, 4 teams 5, 5 teams 4, 6–8 teams 3 (host can change 1–8; host lobby shows "≈ N min" = 5 + teams×rounds×2.6 + 9). The host's manual choice is never overwritten when teams are added/removed.
3. **A turn**
   1. *Turn intro* — TV: "Team Rudolph, you're up! Spin from your phone." Active team's phones show a giant SPIN button.
   2. *Spin* — any active-team player taps SPIN. Wheel spins ~5 s on TV with ticking sound, lands with a sting.
   3. *Result* — the segment's mini-game plays out (below). Host judges with one tap.
   4. *Points* — "+300" flies to the team's score tile; scoreboard re-ranks; host taps **Next turn**.
4. **Round break** — after each round: standings, "Round 2 of 3 starts now". (~10 s, host taps Continue.)
5. **Final Chaos** (finale) — every team secretly wagers, then types an answer to one final question on a phone. Answers revealed team by team; wagers won or lost.
6. **Podium** — 1st/2nd/3rd, confetti, fanfare, fun awards (Fastest Finger, Star Performer).

Pacing target: ~2.5 min per turn. 6 teams × 3 rounds = 18 turns ≈ 45 min + finale 8 min + lobby 5 min ≈ 60 min.

## 2. The wheel (12 equal slots, clockwise from top)

| # | Slot | Colour | Ink | Icon (Lucide) |
|---|------|--------|-----|------|
| 0 | Christmas Trivia | `#C8232C` | cream | tree-pine |
| 1 | Dare | `#F5B82E` | `#1A1206` | drama |
| 2 | Pop Culture | `#1F6FD1` | cream | clapperboard |
| 3 | Hot Seat | `#D63384` | cream | flame |
| 4 | Christmas Movies | `#8E1B3A` | cream | popcorn |
| 5 | Sound It Out | `#7A4FD3` | cream | music |
| 6 | Grinch Steal | `#FFF6E5` | `#0B1F17` | hand-coins |
| 7 | Showdown | `#8FD8FF` | `#0B1F17` | swords |
| 8 | Dare | `#F5B82E` | `#1A1206` | drama |
| 9 | Rapid List | `#0B8A75` | cream | list-checks |
| 10 | All Play | `#F2731D` | `#0B1F17` | zap |
| 11 | Double Down | `#1E8A4C` | cream | sparkles |

Labels are tangential (upright when the slot is at the top pointer). The pointer is at 12 o'clock. Gold rim with marquee bulbs; when stopped, every other slot dims to ~50% and the winner gets a cream outline.

## 3. Mini-games and points

| Slot | How it plays | Points |
|------|--------------|--------|
| **Christmas Trivia / Christmas Movies / Pop Culture** | (Christmas Movies draws from `data/trivia-movies.json`: the classic Christmas films — It's a Wonderful Life, Christmas Vacation, Elf, Home Alone 1 & 2, Die Hard, The Polar Express, the Grinch (1966/2000/2018), The Santa Clause, A Christmas Story, Miracle on 34th Street, The Nightmare Before Christmas, Jingle All the Way, Scrooged, Christmas with the Kranks, Jack Frost, Rudolph (1964), Santa Claus Is Comin' to Town (1970), A Charlie Brown Christmas — incl. "finish the quote" and "who said it?". The TV shows the movie title as a sub-chip once the question is revealed.) Active team's phones show **Easy 100 / Medium 200 / Hard 300**; first tap on the team decides. TV shows the question; the team answers **out loud** (20 s timer). Host taps Correct/Wrong. On Wrong (or time-out) a **Steal** opens for all OTHER teams at half value: after a 3-second "get ready" countdown the BUZZ buttons arm; first buzz answers; a wrong steal locks that team out and the host may reopen for the rest (each team one try). | 100 / 200 / 300; steal 50 / 100 / 150 |
| **All Play** (typed) | Question to the whole room. EVERY team types an answer on any teammate's phone within 20 s (last submission per team counts). The server auto-marks answers that match the answer/accept list (case/punctuation-insensitive); the host confirms or flips any. TV reveals all teams' answers at once. | 100 to each correct team, +50 to the first correct |
| **Dare** | TV shows the dare. A **performer** is picked at random from the active team (host can re-roll). If the dare has a **secret** (movie to mime, gift to describe…), only the performer's phone shows it (press-and-hold to peek). Host starts the timer, then either judges directly — **Nailed it / Valiant effort / Not this time** — or taps **Let the room vote**: every OTHER team's phones show 👍 Nailed it / 👌 Good try for 15 s, the TV shows a live applause meter, majority sets the result (host can override). Optional **+50 crowd favourite**. | 200 / 100 / 0 (+50) |
| **Showdown** | Active team picks a rival team on their phones. One random player from each team is called up; the TV shows a head-to-head mini challenge (e.g. "Candy-cane hook race", "Ho-ho-ho count in 15 s", "Longest Santa laugh") with a timer. Host taps the winner or Tie. | Winner 200; tie 100 each |
| **Sound It Out** | Random performer's phone secretly shows a song. They hum/whistle (no words); teammates guess within 30 s. On time-out, other teams may buzz to steal (3 s arm delay). | 200; steal 100 |
| **Rapid List** | TV shows a prompt ("Name Santa's reindeer"). 30 s. Team shouts answers; host ticks a checklist; TV shows a live counter and the ticked answers. | 50 each, max 300 |
| **Hot Seat** | Random performer alone answers up to 6 quick questions in 45 s (pass allowed). Host taps ✓ / ✗ / pass per question. TV shows question + progress dots. | 50 each, max 300 |
| **Double Down** | Fanfare. The team spins again immediately; all of THIS team's positive points for the rest of this turn are ×2 (expires at Next turn; penalties and other teams' points are never doubled). Landing it again just keeps ×2. | ×2 this turn |
| **Grinch Steal** | Active team's phones list only the teams AHEAD of them; they pick one; 150 points move (capped at the victim's score). If the active team is in 1st place (nobody ahead), the Grinch's heart grows: they gift 100 to the last-place team instead. | 150 / gift 100 |
| **Round break bonus** | (Host option, default on for 5+ teams.) Between rounds: one typed All Play question for every team. | 100 each correct |
| **Final Chaos** | Category revealed. Each team wagers 0–max(score, 300) on a phone (any teammate; last lock-in wins). Question shown; 45 s to type an answer. Host reveals teams from lowest score to highest; marks each; ±wager (floor 0). Ties share a place. | ±wager |

Host always has: **Undo last score change** (multi-level), manual ± on any team, re-roll performer, skip/swap question, show hint (halves the points), +10 s / pause timer.

## 4. Screen-by-screen

### Big Screen (TV, 1920×1080, viewed from 3–5 m)
Persistent: top bar (wordmark left · "ROUND 2 OF 3" pill + turn dots centre · "Join at 10.0.0.235:3000" right) and the **score strip** (one tile per team in turn order: mascot disc, name, score; active tile raised with gold border + "UP NOW" tag; leader gets a crown). Big moments may hide the strip.

| Stage | TV shows |
|------|----------|
| Lobby | Left: "Grab your phone and join a team", QR on cream card, 3 steps, URL in big type, sound hint. Right: team cards filling with player name chips; empty team = dashed card. |
| Turn intro | Huge team mascot + "Team Rudolph — you're up!", "Spin from any Team Rudolph phone", wheel idle at side with gentle bulb chase. |
| Spinning | Wheel large and centred, motion blur feel, "Max is spinning…". |
| Wheel lands | Wheel stopped, winner highlighted; right: "IT LANDED ON — DARE!" in slot colour, points, next step ("Picking a performer…"). |
| Difficulty pick | Category chip + three big cards Easy 100 / Medium 200 / Hard 300; "Team Rudolph is choosing…" with which phone tapped. |
| Question in play | Wheel small left; card: category/difficulty/points chips, timer ring, "Team Rudolph — answer out loud", question in 60 px, steal hint. |
| Steal buzzer | Card turns orange: "STEAL! Buzz in for 150", eligible teams listed lit; when someone buzzes: their team colour floods, "Priya (The Grinches) buzzed first!". |
| Correct / reveal | Answer panel in green "✓ The One Horse Open Sleigh", fun fact line, "+300" badge flying to the team tile. Wrong = red "✗" variant. |
| Dare in play | Gold card: dare title huge, instructions, performer name + "secret is on your phone" (if any), big timer ring, props chips, judging line. |
| Sound It Out | Violet card: "Aunt Linda is humming… Team Rudolph, name that tune!", animated music bars, timer — title NOT shown until revealed. |
| Rapid List | Teal card: prompt, giant counter "4 / 6", timer, ticked answers appear as chips as the host taps them. |
| Hot Seat | Magenta card: performer name, question, 5 progress dots (✓ ✗ pending), timer 45 s. |
| All Play | Orange card: "ALL PLAY — every team, type your answer!", question, timer, a row of team tiles flipping to "ANSWERED ✓" as submissions arrive; then the reveal: every team's typed answer with ✓/✗ and "+100 / +150 first!". |
| Dare vote | Applause meter: two big bars "Nailed it" vs "Good try" filling as phones vote, voters count, 15 s timer. |
| Showdown | Ice-blue split screen: rival A vs rival B (team discs, player names), challenge title + one-line rules, timer; then winner burst. |
| Double Down | Full-bleed green splash "DOUBLE DOWN!", "Spin again — everything you win this turn is doubled". |
| Grinch Steal | Cream splash "GRINCH STEAL!": Team Rudolph choosing among teams ahead of them (targets with scores); then "Rudolph steals 150 from The Grinches!". Leader variant: "Your heart grew three sizes — gift 100 to Frosty's Crew". |
| Round break | "End of Round 2" + ranked standings bars + "Round 3 — final round!" |
| Final wager | "FINAL CHAOS" title, category, each team tile shows "wagering…" → "LOCKED ✓" (amount hidden), timer. |
| Final reveal | Question on top, team-by-team rows: typed answer, wager, ✓/✗, score change; current row highlighted. |
| Podium | Confetti, "Team Rudolph wins Christmas!", 2-1-3 podium blocks, awards, remaining ranks. |

### Phone (390×844, one job per screen, thumb-sized controls)
Persistent mini header: team disc + team name + score; nothing else competes with the main action.

| Stage | Phone shows |
|------|-------------|
| Join | Name field, team grid (big colour tiles with mascot + player count), "Join game" primary. Remembers you on refresh. |
| Waiting lobby | "You're on Team Rudolph", teammates list, "Waiting for the host to start". |
| Your turn | Giant round SPIN button (green, 3D press), "Your team is up!". |
| Watching | "Team Frosty is up" + what's happening now (e.g. "Dare: Cookie Face") + mini scoreboard. |
| Pick difficulty | Three stacked buttons Easy 100 / Medium 200 / Hard 300 (any teammate; first tap wins). |
| Buzzer | Huge red circular BUZZ button. States: armed / you buzzed first (green, vibrate) / someone else got it (grey, name) / locked out. |
| Secret card | "Only you can see this" + press-and-hold card to reveal the secret (movie, song, gift…), "Act it out — no words!". |
| Steal pick | List of the teams ahead of you with scores; tap one; confirm. (Showdown uses the same picker: "Pick your rival".) |
| All Play answer | Question, text field, "Lock in answer" (any teammate; shows "Sam answered: Clarence — you can change it"), timer. |
| Room vote | (Other teams during a dare) two huge buttons 👍 "Nailed it" / 👌 "Good try" — rendered with Lucide icons, not emoji — and "Vote sent" state. |
| Showdown called up | "You're in the Showdown vs Priya!" with the challenge and "Get to the front!". |
| Final wager | Score shown, slider + quick chips (0, half, all), "Lock in wager". |
| Final answer | Question, text field, "Lock in answer", locked state shows what you sent. |
| Game over | Your place ("2nd!"), team score, awards you won, "Thanks for playing". |

### Host login + live directions (coach)
- **Login:** `/host` on the laptop that runs the server signs in automatically. Any other device (e.g. the host's phone, so they can roam while the laptop drives the TV) sees a friendly login screen with a 4-digit PIN keypad. The PIN is shown only on the laptop's host screen and in the terminal — never on the TV. Remembered on that device (re-login automatic after refresh/reconnect). Several host devices can be signed in at once; all stay in sync.
- **Live directions (Coach panel)** — always visible at the top of every host screen and the main content of the phone remote. Generated by the server from the exact game state, so it is never wrong:
  - **Now:** one short headline ("Team Rudolph is picking a difficulty").
  - **Say this:** the exact words to read aloud, in large type (e.g. the question itself, "Team Rudolph, 20 seconds — go!", "Wrong! Other teams — buzzers are armed… now!", the dare instructions, the rules of the segment the first time it comes up).
  - **Do this:** 1–3 numbered steps ("Start the timer when Aunt Linda is ready", "Watch the performance", "Tap the result").
  - **Actions:** the buttons for this moment, the primary one big and highlighted, with keyboard shortcuts.
  - **Heads-up:** contextual tips (e.g. "Elf Help has nobody online — wait or move a player", "Double Down active: points ×2 this turn", "This is the first Rapid List — explain it").
- **Opening script:** before Start, the host can open "Read this to the room" — a 60-second welcome + how-to-play script, with the join URL.
- **Phone remote:** a 390-px host layout: coach panel, the big primary action, secondary actions, mini scoreboard with ± and undo, private answer card (tap to reveal so guests can't glance).

### Host (laptop, fluid page)
Left rail: live scores with ± and **Undo**. Centre: what's on TV now + the **one big next action**. Right: private info (answer, accepted alternates, hint, performer, timer controls). Keyboard shortcuts shown on buttons (C correct, W wrong, R reveal, T timer, N next).

| Stage | Host shows |
|------|-----------|
| Lobby setup | Join URL + QR, add team (name + mascot picker + colour), team list with players, rounds stepper, sound test, Start game. |
| Trivia turn | Question + **private answer**, Correct / Wrong / Open steal / Reveal / Next. |
| Dare judging | Dare, performer (re-roll), secret shown, timer Start/+10 s, Nailed it / Valiant / Not this time, +50 bonus. |
| Rapid List | Checklist of valid answers to tick (+ "other valid answer" button), live count, timer. |
| All Play marking | Every team's typed answer with auto-mark (✓/✗) and one-click flip, "Reveal all on TV", award preview. |
| Final reveal | Table of teams: wager, typed answer, accept/reject, "Reveal next" button. |

## 5. Design system — "North Pole Game Show"

**Look:** deep evergreen night, candy-cane red, tinsel gold, snow cream. Chunky friendly type. Marquee-bulb wheel. Big tactile buttons with a bottom lip. Icons are Lucide line icons (stroke 2–2.4, round caps). No emoji in UI chrome.

**Colour tokens**
- `--night #0B1F17` page background
- `--pine #123326` surface / cards
- `--pine-2 #1B4636` raised surface, chips, active tile
- `--line rgba(255,246,229,0.10)` borders
- `--snow #FFF6E5` primary text
- `--frost #B8CCBF` secondary text (10:1 on night)
- `--berry #D42F2F` primary red button (white text 4.9:1) · `--berry-hi #FF5A4E` red accents on dark
- `--tinsel #FFC93C` gold accent, highlights, "UP NOW" (dark text on it)
- `--holly #2FB36B` success / correct (dark text on it 6.4:1)
- `--ember #F2731D` steal / all-play orange (dark text)
- Team palette (8, each paired with a mascot): red `#FF5A4E` star · gold `#FFC93C` bell · sky `#5AC8FA` candy-cane · lime `#7EE081` tree-pine · violet `#B794FF` gift · orange `#FF9F43` cookie · pink `#FF7AB6` moon · teal `#3DDBC4` snowflake. Mascot glyph is drawn in `--night` on the colour disc.

**Type**
- Display: **Lilita One** (titles, scores, wheel labels, big numbers).
- UI/body: **Fredoka** 400/500/600/700.
- TV scale: question 60 px/1.14, card titles 48–56, labels 22–28 (letter-spaced 0.08–0.14em caps for eyebrow labels), score numbers 52, splash words 120–160.
- Phone scale: screen title 32–40 Lilita, body 18–20, buttons 22–28, eyebrow 13–14 caps.
- Host scale: 15–17 body, 13 labels, 24–28 headings.

**Shape & spacing**: 8-px grid. Radii — chips 999, buttons 18–22, cards 24–32, tiles 20–24. TV outer padding 56–72 px. Phone side padding 20 px.

**Buttons**: primary = solid colour with 6-px darker bottom lip that compresses on press (translateY 4px). Phone primary actions ≥ 64 px tall, full-width; SPIN/BUZZ ≥ 260 px circles. Secondary = pine-2 fill with cream text. Destructive = outline red. Focus ring = 3 px gold outline offset 3 px.

**Components**: chip (icon + caps label on slot colour), team disc (colour circle + mascot glyph), score tile, timer ring (gold arc on 12% cream track, number in Lilita, turns red under 5 s), challenge card (pine surface, slot-coloured eyebrow chip), splash (full-bleed slot colour with giant Lilita word), toast (pill, gold border), press-and-hold secret card.

**Motion**: wheel spin 5 s ease-out-quart with tick sound per slot passing; result splash scale-in 400 ms; points "+300" float to tile 900 ms; score count-up; confetti on podium. Respect `prefers-reduced-motion` (no confetti, shorter spin).

**Sound (TV only, Web Audio synthesized)**: wheel ticks, landing sting, buzzer honk, correct chime, wrong buzz, last-5-second beeps, final fanfare. TV needs one "Click to start" tap to unlock audio (also requests fullscreen).

**Voice**: warm, playful, short. Commands in second person ("Spin from your phone", "Hum it — no words!"). Never blame ("Not this time" instead of "FAILED").
