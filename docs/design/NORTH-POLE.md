# Christmas Chaos — "North Pole Workshop" design system (APPROVED by the client)

Supersedes `MIDNIGHT-PREMIERE.md` (rejected: "doesn't represent Christmas"). The client chose a **bright, snowy, playful
North Pole workshop** look (think the movie *Elf*), with **string lights & garland, Christmas tree & ornaments, presents &
ribbons, Santa / reindeer / snowmen**, and classic American Christmas themes. Modern, fun, uncluttered, legible on a TV from 4 m.

**Approved reference concepts (source of truth for the look):**
- TV: `public/concepts/north-pole-tv.html` (1920×1080 question-in-play)
- Phone: `public/concepts/north-pole-phone.html` (390×844 your-turn SPIN)
Open them in the browser (served at `/concepts/...`) and match them.

## 1. Palette
| Token | Hex | Use |
|---|---|---|
| `--snow` | `#F6F9FD` | page background (cool snow white, never pure white for the page) |
| sky wash | `#EAF2FB → #F6F9FD` | top-of-page gradient |
| `--snowbank` | `#E3ECF6` | secondary surfaces, neutral chips, snow hills |
| `--snow-shade` | `#C9D8EA` | snowflakes on white, hairlines, disabled |
| `--paper` | `#FFFFFF` | cards / gift tags (with shadow `0 2px 0 #E2E9F2, 0 26px 60px rgba(28,35,51,.14)`) |
| `--candy` / `--candy-deep` | `#D42A2A` / `#A51D1F` | primary buttons, candy-cane stripes, active team, headlines (white on candy 5.0:1) |
| `--holly` / `--holly-deep` | `#1F7A4A` / `#155C37` | correct, ribbons, round pill, secondary emphasis (white on holly 5.3:1) |
| `--tinsel` / `--tinsel-deep` | `#EDB321` / `#C48A0A` | stars, points chips, bulbs, "Up now", leader (ink on tinsel only — never tinsel text on white) |
| `--ink` / `--ink-soft` | `#1C2333` / `#4A5568` | all reading text (ink on snow ≈ 15:1) |
| `--cocoa` | `#7A4A2A` | sparing wood/gingerbread accents |
| `--grinch` | `#7CB518` | Grinch Steal only |
| `--ember` | `#F28C28` | steal / All Play energy |
Text is always ink on light, or white on candy/holly. Never red text smaller than 24 px on white (use ink).

## 2. Type
- **Bagel Fat One** (`/fonts/bagel-fat-one/bagel-fat-one-latin-400-normal.woff2`) — display: wordmark, headlines, splash words, scores, timer numbers, wheel labels, button words (SPIN / BUZZ).
- **Figtree** variable (`/fonts/figtree/figtree-latin-wght-normal.woff2`) — questions (TV 60–64 px / 800 / 1.12), body, buttons, labels.
- Sentence case everywhere ("Up now", "Round 2 of 3"); no tracked ALL-CAPS eyebrows; no "A · B · C" meta strings — use separate chips.

## 3. Illustrations (Microsoft Fluent Emoji 3D, MIT — `public/assets/art/*.png`, licence in `LICENSE-fluent-emoji.txt`)
santa, mrs-claus, deer, snowman, tree, gift, bell, star, glowing-star, cookie, candy, lollipop, ribbon, sled, snowflake, moon,
mitten, scarf, cocoa, popcorn, film, clapper, music, fire, zap, sparkles, money, boxing, list, masks, trophy, party, medal1/2/3.
(`elf.png`/`elf-man.png` are fantasy elves — do not use.)
**Team mascots (replace the Lucide glyph mascots):** `deer, tree, bell, gift, santa, snowman, cookie, star` — shown as the 3D
image (no colour disc needed; team colour appears as the tag/tile accent). Lucide line icons stay for small UI glyphs only.
**Wheel slot art:** Christmas Trivia `tree` · Dare `masks` · Pop Culture `clapper` · Hot Seat `fire` · Christmas Movies `popcorn` ·
Sound It Out `music` · Grinch Steal `money` · Showdown `boxing` · Rapid List `list` · All Play `zap` · Double Down `sparkles`.
Restraint: big characters (Santa, reindeer, snowman, tree…) appear at BIG moments only — turn intro, wheel lands, correct, round
break, podium. Everyday screens use small mascots only.

## 4. Signature elements
- **Pine garland with C9 bulbs** across the top of every TV screen (swagged rope in 3 greens, bulbs red/gold/blue/green/orange/magenta with soft halos). Bulbs twinkle gently on idle; chase while the wheel spins; flash 3× on landing; blink green on correct. A short version tops the phone and host.
- **Candy-cane prize wheel**: red/white striped rim, white gutter, 12 bright slots with the 3D art near the rim and **radial** labels (Bagel Fat One, from rim to centre), peppermint hub with Santa, **gold 3D star** as the pointer at 12 o'clock. Stopped: other slots desaturate slightly (opacity .82) and the winner gets a white outline.
- **Gift tags** for cards: white card, punched hole with gold eyelet + candy-striped twine. **Holly ribbon** strip across the bottom of a card for rules/hints.
- **Ornament timer**: shiny red bauble with gold cap + loop, number in Bagel Fat One white, gold progress ring; turns into a fast pulse under 5 s.
- **Score tags**: white tiles on a snowbank, team name on top (one line), 3D mascot + score (Bagel Fat One) below. Active team = candy-red tile raised with a tinsel "Up now" pill; leader gets a glowing-star sticker.
- Gentle **snowfall** of pale-blue flakes (never over text being read); reduced motion = no snow, bulbs static.

## 5. Buttons (phone + host)
- **SPIN** = a 280 px **peppermint candy** (conic red/white swirl, white rim, glossy shine, white core with "Spin" in Bagel Fat One red), presses to scale .95.
- **BUZZ** = a 260–280 px **red ornament** (radial red gloss, gold cap + loop, "Buzz" in white Bagel Fat One) — the only big red round thing on the phone besides SPIN's stripes; states: armed (gentle sway + glint), you're first (turns holly green, check, "You're first! Answer out loud", vibrate), someone else (silver ornament + name), locked out (dim silver + lock).
- Rectangular buttons: candy primary (white text, 6 px `--candy-deep` bottom lip that compresses on press), holly success, tinsel (ink text), white secondary with ink text and `--snowbank` lip, outline destructive. Focus ring 3 px tinsel, offset 3 px.

## 6. Stage-by-stage Christmas moments (TV; phones mirror the relevant ones)
| Stage | North Pole moment |
|---|---|
| Lobby | "Welcome to the North Pole Workshop". The QR + join URL live on a **big gift tag**. Teams are **stockings hung on a mantel / garland** (team colour stocking, 3D mascot, players' name tags pinned on), empty team = empty stocking "Needs elves". |
| Turn intro | Big 3D mascot of the active team + Santa peeking; "Team Rudolph, you're up!" in Bagel Fat One; gift tag "Spin from any Team Rudolph phone". |
| Spinning | Wheel large and centred; garland bulbs chase; "Max is spinning…" |
| Wheel lands | Present **unwraps** (lid pops, ribbon falls) revealing the slot art + name + points; snowflake confetti; bulbs flash. |
| Pick difficulty | Three **presents** of growing size: small Easy 100, medium Medium 200, big Hard 300 (bigger bow = harder). |
| Question | Gift-tag card + ornament timer (concept). Christmas Movies adds the film chip (film art) and big quote marks for quote questions. |
| Steal | Three ornaments light 3-2-1, then the card turns ember with "Steal! Buzz in for 100" + bell; on buzz the winning team's colour floods the tag and its mascot bounces. |
| Correct / wrong | Correct: holly ribbon "Correct!", answer in big type, sparkles + "+200" gift tag flying to the score tile. Wrong: a playful **lump of coal** stamp "Not this time", answer revealed. |
| Dare | Workshop "stage" card with candy-cane frame, performer name huge, masks art, ornament timer, props as little gift tags; judging hints. |
| Room vote | Two **sleigh-bell meters** filling: "Nailed it" (holly) vs "Good try" (tinsel), voter count. |
| Showdown | Split screen, two 3D mascots facing each other, "VS" in a snowball, challenge title + rules, ornament timer. |
| Sound It Out | Music art + bouncing jingle bells; "Noah is humming…"; song hidden until the host reveals. |
| Rapid List | **Santa's list** scroll that ticks off answers in handwriting-style Figtree with green checks; counter "4 of 6". |
| Hot Seat | Fire art beside the performer; 6 progress **stockings** (filled green ✓ / coal ✗ / empty). |
| All Play | A snowy **village of little houses**, one per team; each window lights warm yellow as that team answers; then the reveal grid of gift tags with typed answers. |
| Double Down | Candy-cane splash + sleigh with two reindeer; "Double Down!" — "Everything you win this turn is doubled". |
| Grinch Steal | Grinch-green field with teetering presents; "Grinch Steal!" target picker; leader variant: a heart that grows three sizes, gift 100 to last place. |
| Round break | "Hot cocoa break" — cocoa art, standings as stockings/bars with movement arrows, "Round 3 is the last round!". |
| Final Chaos | **Christmas Eve**: the only dark screen — deep night sky with stars, moon and Santa's sleigh crossing; wagers as wrapped presents that seal with a bow when locked; reveal row by row. |
| Podium | Three big presents as podium blocks (1st tallest, gold bow), snow + gold confetti, Santa + trophy, awards as gift tags ("Fastest Finger", "Star Performer"). |

## 7. Phone specifics
Gift-tag header (mascot, team name in candy, "You're Aunt Linda", score). One job per screen; headline in Bagel Fat One candy;
helper text ink-soft 18–19 px. Join: "Join the workshop" — name field + team gift tags with mascots. Waiting: your stocking with
teammates. Secret: a **wrapped present** — press and hold to peek inside. Wager: a present with a bow + slider + chips. Game over: medal art + place.

## 8. Host specifics
Same palette, calmer and denser (15–17 px body). Coach panel = a cream **note card pinned to the workshop board** ("Say this" in
large type), with a red "Live" light when the TV is mid-moment; primary action = candy button with key cap; private answer =
sealed envelope (tap to open on phone layouts).

## 9. Avoid
Dark backgrounds except Final Chaos; text over snow animation; more than one big character per screen; cramped wheel labels;
pure-white page background; tinsel text on white; Lucide mascots (use 3D art); emoji characters in text.
