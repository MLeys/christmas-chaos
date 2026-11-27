# Christmas Chaos — the comedy layer (client requirement)

> "Make sure this whole game is built around being funny and getting laughs — the games, animations, questions even.
> We want this to make people laugh and have a good time." — the client

Comedy is a first-class feature, not decoration. Tone: **warm, cheeky, family-friendly roast** — tease the play, never the
person; nothing mean, crude or about bodies/age/intelligence; Christmas-movie references welcome. Every big moment should have a
chance to get a laugh, but never slow the game down (quips ≤ 2 lines, animations ≤ 2.5 s, skippable).

## 1. Quips (data/quips.json — written by the content team)
A bank of short funny lines, keyed by moment, each with `{id, text, tone:'cheer'|'tease'|'drama'|'pun', when?:{...}}`.
Placeholders: `{team}`, `{player}`, `{points}`, `{answer}`, `{other}` (another team), `{leader}`, `{last}`, `{segment}`.
Team names can be plural ("The Grinches"), so avoid a verb right after a name ("You're up, {team}!", "The lead goes to
{leader}!"); when you need one, write `{teamVerb:is|are}` (also `otherVerb`, `leaderVerb`, `lastVerb`, `playerVerb`): the
server picks the form that agrees (several joined names are plural). `{team}'s` becomes "The Grinches'" by itself.
Moments (keys): `lobbyIdle`, `gameStart`, `turnIntro`, `spinStart`, `land.<segmentType>` (trivia, movies, popculture, dare,
showdown, sounditout, rapidlist, hotseat, allplay, doubledown, grinch), `pickEasy`, `pickMedium`, `pickHard`, `correct`,
`correctHard`, `wrong`, `wrongEasy` (missed an easy one), `timeUp`, `stealOpen`, `stealWon`, `stealMissed`, `nobodyBuzzed`,
`dareNailed`, `dareValiant`, `dareFail`, `voteClose`, `showdownWin`, `showdownTie`, `hotseatPerfect`, `hotseatZero`,
`listBig`, `listSmall`, `doubleDown`, `grinchSteal`, `grinchGift`, `leadChange`, `bigComeback`, `lastPlaceCheer`,
`roundBreak`, `finalIntro`, `finalAllIn`, `finalZeroBet`, `finalCorrect`, `finalWrong`, `podium`, `undo` (host pressed undo).
At least 6 lines per key (12+ for correct/wrong/land.*), never repeat a line within a game.

## 2. Server contract (src/ — comedy server agent)
- `publicView.quip: {id, key, text}|null` — the current TV quip (placeholders already filled), chosen server-side from
  data/quips.json on each moment, never repeating within a game; cleared when the next moment starts.
- `hostView.host.coach.say` may append the quip as a suggested line (marked "(say it with feeling)" style), and
  `coach.tips` may add a playful nudge.
- Stats for awards: per player `buzzWins, wrongAnswers, steals, performances, perfectHotSeat`; per team `steals, wrong, timesLed`.
- `podium.awards[]` gains funny awards (only when earned, max 6): **Fastest Finger** (most buzz wins), **Star Performer**
  (most performances), **Lump of Coal Award** (most wrong answers — team or player, played for laughs), **Grinch of the Year**
  (most points stolen via steals + Grinch Steal), **Silent Night Award** (fewest buzzes among players who could buzz),
  **Comeback Kid** (biggest climb), **Rudolph Award** (led the most rounds). Each: `{key, title, name, teamId, detail, art}`.
- `fx` events gain `{type:'react', mood:'cheer'|'groan'|'gasp'|'laugh', teamId?}` so the TV can animate + play the sound.

## 3. Animations & sound (TV mostly; phones get small versions)
Shared kit in `public/assets/fx.js` + tokens.css keyframes (foundation): `bounce` (mascot cheer), `droop` (sad tilt + slide
down), `wobble`, `shake`, `splat` (snowball hits the card and slides), `coalDrop` (lump of coal falls and bounces with dust),
`dash` (a 3D reindeer gallops across the screen), `sneak` (the Grinch money bag tiptoes off), `melt` (ornament timer drips at
0), `peek` (Santa peeks in from a corner and winks), `confetti` (snow + gold), `heartGrow`. All ≤ 2.5 s, reduced-motion = fade.
Sounds (sound.js): slide-whistle down (wrong), sad trombone (timeUp), sleigh-bell run (correct), "ho ho ho" synth-ish laugh
(Santa peek), boing (bounce), splat, cash-register "ka-ching" (steal), drumroll + cymbal (reveals), crowd "ooh" (gasp, synthesized noise swell).
Wheel tease: on ~25% of spins the wheel creeps to the next slot in the last second, hangs, then settles (purely visual — the
server already chose the slot; landing precision must stay exact).

## 4. Where the laughs land (per stage)
- Lobby: rotating `lobbyIdle` quips on the gift tag ("Elves are still finding their phones…"); joining players' name tags pop on with a boing.
- Turn intro: `turnIntro` quip under the title; the team's mascot bounces; Santa peeks in occasionally.
- Wheel lands: present unwraps + `land.<type>` quip ("A DARE? Somebody call the elves' union.").
- Difficulty: `pickEasy` teases ("Easy? The reindeer are judging you."), `pickHard` hypes.
- Correct: reindeer dash + sleigh bells + `correct` quip. Wrong: coal drop + slide whistle + `wrong` quip. Time up: sad trombone + melting ornament.
- Steal: ka-ching; the stealing team's mascot does a sneaky tiptoe; `stealWon` quip.
- Dares / showdowns: the content itself is the comedy (absurd, performable, judgeable); applause meter; `dareFail` gets a sympathetic groan.
- Round break: "Hot cocoa break" + standings with a roast for the leader and a pep talk for last place.
- Final Chaos: dramatic drumroll, `finalAllIn` / `finalZeroBet` quips.
- Podium: awards ceremony with the funny awards as the finale ("Lump of Coal Award goes to… Uncle Dave!").
- Host coach: "Say this" includes the funny line + stage directions ("(pause for effect)", "(point at Team Rudolph)").
