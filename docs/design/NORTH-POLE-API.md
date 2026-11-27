# North Pole Workshop — the shared foundation API

The contract for the page builders (TV, host, phone). The look is specified in `NORTH-POLE.md` (approved) and drawn in
`public/concepts/north-pole-tv.html` + `north-pole-phone.html`; the comedy layer in `COMEDY.md`. Everything below lives in
`public/assets/` and is showcased live at **`/assets/kitchen-sink.html`** (a 1920×1080 TV built only from these pieces,
the wheel lab, every component, three phone frames, the comedy kit and the sound board).

| File | What it gives you |
|---|---|
| `tokens.css` | Fonts, tokens, base styles, every shared component, the comedy keyframes |
| `sky.js` | `garland()` (pine rope + C9 bulbs), `snowfall()`, `snowbank()`, `starfield()` (Christmas Eve) |
| `wheel.js` | The candy-cane wheel: `createWheel()` (exact landing, ticks, tease, drives the garland) |
| `icons.js` | Lucide `icon()` for small UI glyphs, the 3D art (`ART`, `artSrc`, `artImg`), `MASCOTS`, `mascotImg()`, `teamDisc()` |
| `client.js` | Markup helpers (`slotChip`, `scoreTag`, `timerRing`, `peppermint`, `ornamentBuzz`, `present`, `stocking`, `bellMeter`, `santaList`, `secretCard`, `toast`, `showBanner`…) plus the connection/identity code |
| `fx.js` | **new** — the comedy kit: `bounce`, `droop`, `wobble`, `shake`, `splat`, `coalDrop`, `dash`, `sneak`, `melt`, `peek`, `confetti`, `heartGrow` |
| `sound.js` | Synth sounds; now also `slideWhistle`, `sadTrombone`, `sleighRun`, `hoHoHo`, `boing`, `splat`, `kaChing`, `cymbal`, `crowdOoh` |

---

## 1. Rules that shape every screen

- **Snow-white pages** (`--snow` `#F6F9FD` + the sky wash), white paper cards. The only dark screen is Final Chaos (`.night-sky`).
- **Text is ink on light, or white on candy / holly.** Never red text under 24 px on white (use `--candy-deep`), never tinsel text on white.
- **Sentence case everywhere** ("Up now", "Round 2 of 3"); no tracked caps, no "A · B · C" meta strings — use separate chips.
- **3D art is the illustration system** (`/assets/art/*.png`, Fluent Emoji 3D, MIT). Big characters only at big moments; everyday screens use small mascots. Lucide icons only for small UI glyphs (lock, check, settings…). No emoji characters in text.
- **No snow over text being read** (`snowfall({ avoid })`). Reduced motion = no snow, bulbs static and lit, gags fade.
- TV minimum reading size 28 px; the question is Figtree 800 62 px. tokens.css enforces it for chips, the film cue and
  score-tag names / "Up now" under `html[data-surface='tv']`, so the TV needs no overrides.
- Red text under 24 px uses `--candy-deep` (e.g. `.tag-head__team`).

## 2. Fonts and type

Served locally: `/fonts/bagel-fat-one/bagel-fat-one-latin-400-normal.woff2` (+ latin-ext) and Figtree variable. Preload
both in page heads (the current `tv.html` / `host.html` / `index.html` still preload Fraunces / Big Shoulders — swap them).

| Family | Token | Use |
|---|---|---|
| Bagel Fat One (400 only) | `--font-display` | wordmark, headlines, splash words, scores, timer numbers, wheel labels, SPIN / BUZZ |
| Figtree 300–900 | `--font-ui` | questions, body, buttons, chips, labels |
| Figtree italic 600 | `--font-hand` + `.hand` | Santa's handwriting (Rapid List) |

`--font-marquee` and `--font-serif` are old names (now Figtree / Bagel). `body` has `font-synthesis: none`, so asking Bagel
for weight 800 still renders the real 400 cut.

| Class | Style |
|---|---|
| `.display` | Bagel Fat One, line-height 1 |
| `.headline` (`--ink`, `--holly`, `--phone`) | Bagel 60 px candy with the white lip shadow of the concept's wordmark |
| `.wordmark` (`--sm`) | `<span class="wordmark">${art('tree',{size:64})}Christmas Chaos</span>` — 52 px candy |
| `.question` | Figtree 800 62/1.12, max 30ch |
| `.lede`, `.muted`, `.eyebrow` (`--tv`) | ink-soft helper text (sentence case, no tracking) |
| `.num` | Figtree 800 tabular (counting numbers) · `.score-num` = Bagel score |
| `.quote-marks` | Bagel candy (Christmas Movies quote questions) |

## 3. Tokens (`:root`)

**Palette** — `--snow #F6F9FD` page · `--snowbank #E3ECF6` secondary surfaces, neutral chips · `--snow-shade #C9D8EA` hairlines,
disabled · `--paper #FFFFFF` cards · `--candy #D42A2A` / `--candy-deep #A51D1F` / `--candy-hi` · `--holly #1F7A4A` /
`--holly-deep #155C37` / `--holly-hi` · `--tinsel #EDB321` / `--tinsel-deep #C48A0A` / `--tinsel-hi #FFE38A` · `--ink #1C2333` /
`--ink-soft #4A5568` / `--ink-faint #677287` · `--cocoa #7A4A2A` · `--cream #FFF8E8` · `--grinch #7CB518` (Grinch only) ·
`--ember #F28C28` (steal / All Play) · `--sky #2E6FD1` · `--violet #7B4BC9` · `--pink #E9558A` · `--teal #0F8C8C` · `--ice #8ECAE6` ·
`--movie #9E1B32` · `--silver #D5DDE8` / `--silver-deep` · `--coal #2B2F3A` · `--flake #BFD3EA` · `--hairline #E2E9F2`.

**Semantic text** — `--text` / `--text-soft` (ink / ink-soft; flipped to snow / snow-shade inside `.on-dark` and `.night-sky`).
`--paper-ink` is a constant `#1C2333` that the components use for text on light fills (so a page that redefines `--ink`
locally can't turn component text white).

**Team accents** (offer order, paired with the mascots) — `--team-red #D42A2A` deer · `--team-green #1F7A4A` tree ·
`--team-gold #EDB321` bell · `--team-sky #2E6FD1` gift · `--team-violet #7B4BC9` santa · `--team-orange #F28C28` snowman ·
`--team-pink #E9558A` cookie · `--team-teal #0F8C8C` star. Use the team colour as an accent (stocking, tile bar, splash),
never as small text on white (gold / orange / pink are under 4.5:1).

**Wheel slots** — `--slot-<name>` + `--slot-<name>-ink`, same values as `state.segments[i].color/.ink`:

| Slot | Fill | Ink | Art |
|---|---|---|---|
| christmas | `#D42A2A` | white | tree |
| dare | `#EDB321` | ink | masks |
| pop | `#2E6FD1` | white | clapper |
| hotseat | `#E9558A` | white | fire |
| movies | `#9E1B32` | white | popcorn |
| sound | `#7B4BC9` | white | music |
| grinch | `#7CB518` | ink | money |
| showdown | `#8ECAE6` | ink | boxing |
| rapid | `#1F7A4A` | white | list |
| allplay | `#F28C28` | ink | zap |
| double | `#FFFFFF` + `pattern:'candy'`, `stripe:'#D42A2A'` | ink | sparkles |

**Stripes** — `--candy-stripes` (wide 45°), `--candy-fine` (rims), `--candy-twine` (vertical, the gift-tag twine).
**Bulbs** — `--bulb-red/gold/blue/green/orange/magenta`.
**Backgrounds** — `--sky-wash` (TV), `--sky-wash-phone`.
**Shape** — `--r-card 28`, `--r-tile 22`, `--r-btn 20`, `--r-sm 14`, `--r-chip`; `--safe-x 72` (the concept margin), `--safe-y 64`;
`--s-1…--s-9`; TV type scale `--fs-24 … --fs-splash`, `--fs-question 62`.
**Depth** — `--shadow-paper` (cards), `--shadow-tile` (score tags), `--shadow-soft`, `--shadow-pop`, `--glow-gold`, `--glow-candy`.
**Buttons** — `--lip 6`, `--lip-hover 8`, `--lip-pressed 2`. **Motion** — `--ease-out`, `--ease-spring`, `--ease-push`,
`--ease-bounce`, `--dur-press 60`, `--dur-release`, `--dur-fast`, `--dur-splash`, `--dur-points`, `--dur-unwrap 900`, `--bulb-cycle 1.2s`.
**Art as CSS** — `--art-star` (glowing star), `--art-bell`.

### Interim aliases (old names, so unre-styled pages keep working)

Old dark-surface names stay **dark** (ink family) with light text until the page is restyled; new CSS should not use them.

| Old | Now |
|---|---|
| `--night` | `#1C2333` (= ink — also right for text on tinsel) |
| `--night-2` / `--pine` · `--night-3` / `--pine-2` · `--night-edge` · `--night-deep` | `#262F45` · `#323C56` · `#151B29` · `#0B1226` |
| `--line`, `--line-soft`, `--line-strong`, `--line-bold`, `--track`, `--hilite` | white alphas (for dark surfaces) |
| `--frost` / `--muted` | `#C9D8EA` / `#9AA8BF` |
| `--white` | `#FFFFFF` |
| `--cranberry*`, `--berry`, `--berry-lip`, `--red-nose` | candy / candy-deep |
| `--berry-hi`, `--berry-text` | `#FF7A7A` (red text on dark only; on light use `--candy-deep`) |
| `--brass`, `--tinsel-lip` · `--holly-lip` · `--ember-lip` | tinsel-deep · holly-deep · ember-deep |
| `--gold-ink`, `--foil-ink` | ink |
| `--closed` / `--closed-lip` | silver-deep / `#6B778C` |
| `--rim`, `--bulb*`, `--peppermint`, `--who-pink`, `--velvet`, `--cream-2` | tinsel, tinsel-hi…, ice, pink, movie, `#FFF1D6` |
| `--team-mint`, `--team-lime` / `--team-silver` | team-green / team-teal |

## 4. Backgrounds, snow, snowbank

```html
<body class="snow-page">            <!-- body already gets the sky wash; .snow-page puts it on any container (+ stacking context) -->
<section class="night-sky">…</section>   <!-- Christmas Eve (Final Chaos) only; flips --text to snow -->
```
```js
import { garland, snowfall, snowbank, starfield } from '/assets/sky.js';
const snow = snowfall(stageEl, { count: 46, avoid: ['.gift-tag'], margin: 1 }); // pale-blue 4–12 px flakes, never over the card column
snow.refresh(); snow.destroy();
stageEl.insertAdjacentHTML('beforeend', snowbank());   // <svg class="snowbank"> two-layer hills, absolute bottom, 250 px tall
starfield(nightEl, { count: 30 });                      // Christmas Eve sparkles
```
`snowfall` needs a positioned container; reduced motion renders no flakes.

## 5. Garland (`sky.js`)

```js
const lights = garland(containerEl, { size: 'tv' });   // 'tv' 1 | 'host' 0.5 | 'phone' 0.53 | number scale; renders at the container's width
lights.twinkle();            // idle: gentle per-bulb twinkle (default)
lights.chase(1.2);           // 3-phase chase, seconds per cycle (0.45 = fast)
lights.flash(3);             // flash ×3 then back to the last steady mode → Promise
lights.blink('#1F9D57', 3);  // every bulb blinks one colour (correct = green) → Promise
lights.lit(); lights.off(); lights.mode('spin'); lights.phase(k);   // the wheel uses these
lights.refresh(); lights.destroy(); lights.el                       // the <svg class="garland">
```
- Geometry follows the concept: rope at 18, swags dip to 76, 3 greens (30/26/18 px), C9 bulbs (red, gold, blue, green, orange,
  magenta) with halos; swags ≈ width/280, bulbs ≈ width/65 (30 across a 1960 px TV). It re-renders on resize and never stretches.
- Hang it across the top: put the container at `left:-20px; top:-18px; width: calc(100% + 40px)` (the `.garland--top` /
  `.garland--phone` classes do this when applied to the container) — or pass `className: 'garland--top'`.
- **TV note:** the helper measures the container in design px (it divides by the TV root scale). Inside a CSS `transform:scale()`
  frame (like the kitchen sink) pass `{ width: 1960 }` explicitly.
- Pure helpers for tests / static markup: `garlandGeometry(opts)`, `garlandMarkup(opts)`, `BULB_COLORS`, `GARLAND_MODES`.
- All animation is CSS on `svg[data-mode]` / `[data-phase]` (opacity only).

## 6. Wheel (`wheel.js`)

```js
import { createWheel } from '/assets/wheel.js';
const wheel = createWheel(svgEl, state.segments, { lights });        // lights: a garland (or array) — optional
wheel.restOn(state.lastSegmentIndex);                                // refresh-safe rest
wheel.restOn(i, { highlight: true });                                // landed screen after a refresh
await wheel.spinTo(spin.segmentIndex, spin.durationMs, {
  startedAt: spin.startedAt, clockOffset: client.clockOffset,
  onTick: () => sound.tick(), onDone: () => sound.land(),
  tease: Math.random() < 0.25,                                       // COMEDY.md: creep, hang on the peg, tip over
});
wheel.idle(true);  wheel.highlight(i | null);  wheel.bulbs('rest'|'chase'|'spin'|'lit'|'blink'|'off');
const detach = wheel.attachLights(otherGarland);
wheel.setSegments(next); wheel.cancel(); wheel.destroy(); wheel.rotation; wheel.index; wheel.spinning;
```
- **Drawing** (viewBox `-380 -380 760 760`, 1 unit = 1 px at 760 px): candy-cane rim r 308–334 with a white edge, white gutter
  r=308, slots r=300 with 4 px white seams, 54 px 3D art at r 234–288 (`segment.art`, Lucide `icon` fallback), **radial** Bagel
  Fat One 25 px labels from r=222 towards the centre (2 lines ±13/15 off the centre line; long words shrink; re-fitted once fonts
  load), `pattern:'candy'` = stripes + a white label pill, peppermint hub (stripes turn with the wheel) with Santa, the 3D gold
  star pointer at 12 o'clock (rocks back on every tick, teeters during a tease, glints when the lights flash).
- **Stopped:** the other slots wash out (white at 18% = opacity .82 on white, plus 25% desaturate) and the winner gets an 8 px white outline.
- **Landing** is exact (`restRotation(i)`) for every index, late joins (`startedAt` in the past), hidden tabs and the tease.
  Landing = 150 ms hit-stop (lights lit) → lights flash ×3 → lit (or chase if `idle(true)`).
- **Tease** (`TEASE` = `{stopAt:.74, hangAt:.9, stopSlots:.66, hangSlots:.53}`): the wheel stops in the slot before the winner,
  creeps to the peg, hangs, then tips in. `svg.is-teasing` is set for that stretch. Purely visual; ticks still fire once per boundary.
- **Lights:** the wheel has no rim bulbs; `bulbs(mode)` sets `svg[data-bulbs]` and maps to the garland
  (`LIGHT_MODES`: rest→twinkle, chase→chase, spin→spin (phase follows the wheel speed), lit→lit, blink→flash, off→off).
- Exports for tests/tools: `planSpin`, `rotationAt`, `speedAt`, `restRotation`, `indexAtRotation`, `tickCount`, `spinTarget`,
  `labelLines` (keeps sentence case), `labelLayout`, `labelRoom`, `textWidthEm` / `labelWidthEm` / `displayWidthEm` (Bagel Fat
  One metrics, both cases), `wheelMarkup(segs, {id})`, `miniWheelMarkup()`, `POINTER_PATH`, `VIEWBOX`, `R_SLOT`, `R_GUTTER`,
  `R_RIM`, `LABEL_START`, `chaseRate`, `HIT_STOP_MS`, `FLASH_MS`.
- Size the svg like the concept: a **676 px** square on the TV gives the concept's 594 px rim (`.wheel-wrap` / `.wheel` fill their box).

## 7. 3D art and mascots

```js
import { ART, artSrc, artImg, hasArt, MASCOTS, mascotFor, mascotImg, teamDisc, icon } from '/assets/icons.js';
import { art, mascot, disc, slotArt, slotArtId, ic } from '/assets/client.js';   // raw()-wrapped for h``

artImg('popcorn', { size: 40 })               // <img class="art" src="/assets/art/popcorn.png" …> decorative (alt="")
artImg('trophy', { size: 120, alt: 'Trophy' })
mascotImg(team, 64)                           // the team's 3D mascot, alt = team name
mascotImg(team, { size: 'sm', alt: '' })      // decorative when the name is printed beside it (sizes: xs 26 sm 36 md 64 lg 84 xl 104 hero 240)
teamDisc(team, { size: 64, leader, beacon, halo, label: true })   // <span class="disc disc--art"><img></span>
slotArt(segment, { size: 54 })                // segment.art (else by type/category), Lucide fallback
```
- Small art (≤ 96 px) loads eagerly by default (no pop-in after a screen change); bigger art is lazy unless `eager: true`.
- `ART` whitelist: santa, mrs-claus, deer, snowman, tree, gift, bell, star, glowing-star, cookie, candy, lollipop, ribbon, sled,
  snowflake, moon, mitten, scarf, cocoa, popcorn, film, clapper, music, fire, zap, sparkles, money, boxing, list, masks, trophy,
  party, medal1/2/3. Unknown ids (and the fantasy elves) fall back to sparkles. All sizes are design px emitted in rem.
- `MASCOTS` (same order/colours as the server): `{id, art, icon, color, ink, colorName, noun}` — deer/Red, tree/Green, bell/Gold,
  gift/Blue, santa/Violet, snowman/Orange, cookie/Pink, star/Teal. `ink` = text colour on that accent. `icon` is a small Lucide
  fallback for old code paths. `mascotFor()` maps old saved ids (candy-cane, tree-pine, snowflake, moon) to the new ones.
- `.disc` modifiers: `--leader` (glowing-star sticker top-right), `--beacon` (soft candy glow, the team that is up), `--halo`
  (white snowball + tinsel ring), `--ring`, `--hero` (big snowball backdrop for the turn intro / podium), `.is-offline` (greyed).
  Old Lucide discs without an `<img>` still render a team-colour ball.

## 8. Components (`tokens.css` + `client.js` helpers)

All helpers return `h``…`` markup (escaped) that you can drop into `h```.

### Buttons
```html
<button class="btn btn--primary">Start the game</button>      <!-- candy, white text, 6 px candy-deep lip -->
<button class="btn btn--holly">Correct</button> <button class="btn btn--gold">Award</button>
<button class="btn btn--secondary">Skip</button> <button class="btn btn--danger">Remove team</button>
<button class="btn btn--ember">…</button> --ghost --dashed --link · sizes --sm 44 --md 48 (host) --lg 68 (phone) --xl 80 (TV) · --block --icon
<button class="btn btn--primary btn--sm">Next <kbd class="kbd">N</kbd></button>
```
Hover lifts to an 8 px lip, press drops to 2 px (60 ms in, 500 ms out). `.is-pressed`, `.is-selected`, `:disabled`.
Focus: 3 px tinsel ring, 3 px offset (`:focus-visible`, `.focus-ring`).

### Peppermint SPIN (phone)
```js
peppermint({ label: 'Spin', live: true, spinning: false, disabled: false, attrs: raw('data-spin data-needs-online') })
```
```html
<button class="peppermint is-live"><span class="peppermint__candy"></span><span class="peppermint__shine"></span>
  <span class="peppermint__core"><span class="peppermint__word">Spin</span></span></button>
```
260–280 px (`--size: max(16.25rem, min(17.5rem, 100vw − 3.5rem))` — never under 260 on any phone; `.peppermint--sm` 132), presses
to .95, `.is-spinning` turns the swirl, `.is-live` breathes, disabled desaturates.

### Ornament BUZZ (phone)
```js
ornamentBuzz({ state: 'armed', attrs: raw('data-buzz data-needs-online') })   // <button>: sway + glint
ornamentBuzz({ state: 'first' })                 // holly, check, "You’re first!" / "Answer out loud" (vibrate yourself)
ornamentBuzz({ state: 'other', name: team.name }) // silver + "<name> buzzed first"
ornamentBuzz({ state: 'locked' })                 // dim silver + lock, "Locked out"
ornamentBuzz({ state: 'arming', count: 3 })       // the 3-2-1 before the steal arms: still, dim, a big count (role="img");
                                                  // patch .ornament-btn__word in place as it counts down
```
Classes: `.ornament-btn` + `.is-armed|.is-arming|.is-first|.is-other|.is-locked`, parts `__loop __cap __ball __word __sub __name`,
`--size` (260–272, never under 260; `.ornament-btn--sm` 120). Only `armed` is a button; the rest are `role="img"`.
Old `.btn-round` (`--spin`, `--buzz`, `--won`, `--closed`, `--ember`) markup now renders as the peppermint / ornament (labels
shown in sentence case via CSS) — swap to the helpers when you restyle.

### Gift tags, cards, ribbons
```html
<section class="gift-tag gift-tag--twine">           <!-- white card, punched hole + gold eyelet, candy twine (TV question card) -->
  …<div class="holly-ribbon">Miss it? The other teams can buzz in and <strong>steal it for 100</strong>.</div>
</section>
<div class="gift-tag gift-tag--md">…</div>           <!-- smaller tag (lobby join tag, awards) -->
<div class="gift-tag gift-tag--md gift-tag--phone">  <!-- phone tag: the hole in the top-left corner, full-width text -->
<div class="gift-tag gift-tag--sm gift-tag--twine">  <!-- phone header: mascot · team / “You’re Aunt Linda” · score -->
  ${mascot(team,{size:52,alt:''})}<div class="tag-head__who"><div class="tag-head__team">Team Rudolph</div>
  <div class="tag-head__me">You’re Aunt Linda</div></div><div class="tag-head__pts">1,150</div></div>
<div class="card">…</div>  .card--sm --md --raised --inset --hero --note (host cream note card) --slot (style="--slot-color;--slot-ink")
<div class="candy-frame">…</div>                     <!-- Dare stage card (--sm: thinner) -->
```
- Card padding is variables (`--card-pt --card-px --card-pb --card-pl`); a `.holly-ribbon` that is a direct child bleeds to the
  card's edges automatically. Ribbon variants: `--plain` (standalone, rounded), `--candy`, `--ember` (steal).
  The bell art sits at its left. `.gift-tag--hole-right` moves the hole. The twine sticks out 62 px above the tag.
- `.film-cue`: `<div class="film-cue">${art('film',{size:34})}Rudolph the Red-Nosed Reindeer (1964)</div>`.

### Chips, tags, pills
```js
slotChip(segment)                 // category chip: slot colour + ink + 3D art (lg 26/40 · { size:'md' } 20/32 · 'sm' 16/26)
```
```html
<span class="chip chip--level">Medium</span> <span class="chip chip--points">200 points</span> <span class="chip chip--outline">…</span>
<span class="pill">Round 2 of 3 ${turnDots(2, 6)}</span>     <!-- holly pill; .pill--snow = white; .pill--sm -->
<span class="up-now">Up now</span>                           <!-- tinsel pill (also the old .ribbon) -->
<span class="tag">…</span> --holly --berry/--candy --ember --snow/--pine --ghost
<span class="player-chip is-you">You</span>  <span class="delta delta--up">+300</span>  <i class="bulb" style="--c:var(--bulb-red)"></i>
```

### Score tags (TV)
```js
el.innerHTML = h`<div class="score-tags">${teams.map((t) => scoreTag(t, { active: t.id === activeId, leader: t.rank === 1, badge: t.multiplier > 1 ? '×2' : '' }))}</div>`;
```
White tiles 138 px tall: name on top (one line, ellipsis), 64 px mascot + Bagel score below. Active = candy tile raised 16 px
with the "Up now" pill; leader = glowing-star sticker; `.is-bump` (+ `--team`) flashes the tile on points; 7–8 teams compact
automatically; the score shrinks with the tile width (container units). Score text is `[data-score]` (use `animateNumber`).
Old `.score-strip > .score-tile` markup renders the same way. Phone mini list: `.score-mini > .score-mini__item(.is-me)`.

### Ornament timer
```js
timerRing(state.timer, client.serverNow(), { size: 150 })     // TV concept size; default 124; < 90 = compact
timerRing(t, now, { tone: 'holly' | 'gold', unit: 'seconds', readyUnit: 'Ready' })
timerState(t, now)                                            // 'ready' | 'run' | 'paused' | 'over' | 'idle'
updateTimerRing(el, state.timer, now)                         // in place, returns whole seconds (beep on change)
```
Red bauble + gold cap & loop (they stick out ~20% above the ball — leave headroom), Bagel number, gold ring; `.is-warn` (≤ 5 s)
pulses fast, `.is-paused` desaturates, `.is-ready` = a prepared timer the host has not started (`started:false`: full ring, the
full seconds, "ready"; `updateTimerRing` returns 0 for it so nothing beeps), `.is-over` = ran out. Unit text is lower-cased by CSS.

### Presents, stockings, meters, the list, stamps
```js
present({ size: 'sm'|'md'|'lg'|72, label: 'Easy', points: 100, color, ribbon, bow, inside: 'popcorn', button: true, state: 'closed'|'unwrapping'|'open'|'sealed' })
                                                              // a number = width in design px (--w); or size it in CSS: .x .present { --w }
stocking({ team, label: team.name, hung: true })              // lobby: mascot peeks out of the cuff; label hangs below (reserve ~1.5rem)
stocking({ state: 'full' | 'coal' | 'empty', size: 56 })      // Hot Seat progress; 'coal' = a charcoal stocking + ✗
                                                              // size is only a default (--stocking-w): .row .stocking { --w: 2.75rem } wins
bellMeter({ label: 'Nailed it', count: 7, fill: 0.7, tone: 'holly' | 'tinsel', ringing, size: 'sm' })   // sm = compact (host, phone)
santaList({ items: ['Dasher', { text: 'Dancer', done: true }], total: 6 })   // "4 of 6", holly checks
```
- Presents: bigger bow = harder; add `.is-unwrapping` to pop the lid (900 ms), `.is-open` for the refresh-safe end state,
  `.is-sealed` pops the bow (wager locked). Difficulty picker = `button: true`.
- `.stamp` / `.coal-stamp`: `<span class="stamp is-in">Not this time</span>` — coal lump + rubber stamp at −6° (`--sm`).
- `.points-pop` (`--down`): the "+200" gift tag that flies to a score tag.

### Splash
```html
<div class="splash" style="--splash-bg:var(--slot-grinch);--splash-ink:var(--slot-grinch-ink)">
  <span class="splash__eyebrow">${art('money',{size:40})}The wheel landed on</span>
  <h1 class="splash__word">Grinch Steal!</h1><p class="splash__sub">…</p></div>
```
`.splash--candy` (Double Down: stripes + white word plate), `--light`, `--contained`; `.splash__art` for a big 3D character.

### Team names, grammar and the awards ceremony
```js
import { isPluralTeam, verb, isAre, hasHave, subject, possessive, AWARD_CEREMONY, awardsRevealed } from '/assets/client.js';
subject('The Grinches', 'is')        // "The Grinches are"   (team names can be plural: never write `${name} is`)
verb(team.name, 'wins', 'win')        // "win" for "Jingle Bell Rockers", "wins" for "Team Rudolph"
possessive('The Grinches')           // "The Grinches’"
awardsRevealed(msSincePodium, n)     // how many awards the TV has revealed (AWARD_CEREMONY {lead, each, drum})
```
The same grammar helpers live in `src/grammar.js` for the server (coach lines, quips: `{teamVerb:wins|win}`). The TV runs
the podium awards ceremony on `AWARD_CEREMONY`; phones use the same clock so no phone spoils an award before the TV's
drumroll (a phone that joins or refreshes later shows them all).

### Toast, banner, inputs, secret
- `toast(msg, { tone: 'gold'|'success'|'error'|'info' })` — white pill with a coloured rim and lip. While a modal is open
  (`html.has-modal` or any visible `[aria-modal]`) top toasts move to the bottom so they never cover the modal's header.
- `showBanner('connection', 'Reconnecting…')` / `hideBanner()` — tinsel strip with C9 dots; `--error` candy, `--info` white.
- `.field > .label + .input` (`--lg`, `--sm`) — white well, snow-shade border, tinsel focus ring.
- `secretCard({ label, value, rule, tone: 'candy'|'violet' })` + `bindSecretCard(el)` — a wrapped present (paper, ribbon, bow);
  press and hold shows the white card.

## 9. Comedy kit (`fx.js`) and sounds

```js
import * as fx from '/assets/fx.js';
import * as sound from '/assets/sound.js';
sound.sleighRun(); await fx.dash('deer');           // correct
sound.slideWhistle(); fx.coalDrop(cardEl);          // wrong
sound.sadTrombone(); fx.melt(timerEl);              // time's up (keeps the melted look until you re-render)
sound.kaChing(); fx.sneak('money', { from: tagEl }); // steal
sound.hoHoHo(); fx.peek('santa', 'bottom-right', { say: 'Ho ho ho!' });
sound.boing(); fx.bounce(mascotEl);                 // cheer   ·  fx.droop(mascotEl) sad  ·  fx.wobble / fx.shake
sound.splat(); fx.splat(cardEl);                    // snowball
fx.confetti({ count: 90, snow: 0.4 });              // snow + gold
fx.heartGrow(el);                                   // Grinch gift: the heart grows three sizes
fx.play('dash', 'deer');  sound.play(sound.GAG_SOUNDS.dash);   // by name (server 'react' cues: cheer / groan / gasp / laugh)
fx.setScale('root');                                // TV: sprite size limits follow the scaled root font (720p … 4K)
```
- Every gag returns `Promise<boolean>`, lasts ≤ 2.5 s (`fx.MAX_MS`), cleans up its sprites, and is a 220–420 ms fade under
  reduced motion. Overlay gags draw in a fixed `.fx-layer` (z-index 900); element gags use `.fx-bounce`, `.fx-droop`,
  `.fx-wobble`, `.fx-shake`, `.fx-melt`. Nothing in fx.js plays sound — pair them with `sound.GAG_SOUNDS`.
- New sounds: `slideWhistle()`, `sadTrombone()`, `sleighRun()`, `hoHoHo()`, `boing()`, `splat()`, `kaChing()`, `cymbal()`,
  `crowdOoh(ms)`; `drumroll(ms)` ends on a cymbal crash (or `{ crash:false }` + `cymbal()` on the reveal). All old exports work.

## 10. Server palette (`src/game.js`)

`SEGMENTS[i]` = `{index, type, category?, label, lines, color, ink, icon, art, points, rule, pattern?, stripe?}` with the
fills / inks / art in §3 (Christmas Movies no longer has `trim`). `MASCOTS` = `deer tree bell gift santa snowman cookie star`
with the team accents in §3; `createTeam`/`updateTeam` validate `mascot ∈ MASCOTS` and `color ∈` that palette. The QR is
ink `#1C2333` on white. PROTOCOL.md is updated.

## 11. Notes for the page builders

1. **The pages are still dark** (tv.css / host.css / player.css set `background: var(--night)` and light text). The old tokens
   are aliased so nothing breaks, but shared components are now light: a `.card` is white paper with ink text. Restyle onto
   `--snow` / `--paper` / `--ink`, then delete the page-local overrides (e.g. player.css sets `--ink: var(--snow)` and `--page: var(--night)`).
2. Swap the font preloads in `tv.html` / `host.html` / `index.html` to Bagel Fat One + Figtree.
3. Replace Lucide mascots (`ic(mascotFor(t.mascot).icon)`, player.js's hand-built `.disc`) with `mascot(team, size)` /
   `disc(team)`. Replace uppercase copy ("SPIN", "BUZZ", "SECONDS LEFT", "UP NOW") with sentence case.
4. TV layout from the concept: garland container `left:-20 top:-18 width:1960`; top bar at y 112 (`.wordmark`, `.pill`, join
   line); wheel svg 676 px at (54, 258); question `.gift-tag.gift-tag--twine` at (776, 235) 1072×560 with `timerRing(…,{size:150})`;
   `snowbank()`; `.score-tags` at left/right 72, bottom 40. Snow: `snowfall(stage, { avoid: ['.gift-tag'] })`.
5. Hook the wheel to the garland: `createWheel(svg, segs, { lights: garland(topEl, { size: 'tv' }) })`; on Correct call
   `lights.blink('#1F9D57')`. Phones/host get a short garland: `garland(el, { size: 'phone' | 'host' })`.
6. Use `slotChip(seg)` for every category label (it carries the 3D art), `scoreTag()` for scores, `present()` for the
   difficulty picker and the wheel-land unwrap, `stocking()` in the lobby, `bellMeter()` for votes, `santaList()` for Rapid List.
7. Comedy: pick gags + sounds per COMEDY.md §4; keep each moment to one gag; never block input on a gag (they are fire-and-forget,
   but you can `await` them to sequence).
8. Christmas Eve (Final Chaos) is the only dark screen: wrap it in `.night-sky` (+ `starfield()`); `--text` flips automatically.
9. `.btn-round*`, `.marquee`, `.letterboard`, `.bulb-string`, `.ribbon`, `.card__hint`, `.score-strip/.score-tile` are kept only so
   old markup renders; prefer the new helpers. Tickets, velvet, silver screen and letterbox CSS were removed (unused by the pages).
