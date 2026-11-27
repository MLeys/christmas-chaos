# Midnight Premiere: the shared foundation

Direction A from the design brief: Christmas Eve at the movie palace. A snowy midnight-blue night lit by warm gold marquee bulbs and cranberry velvet. **Surfaces are the cool night. Everything you can touch or celebrate is a warm light.**

This file is the contract for the page builders (TV, host, phone). Everything below is in `public/assets/`:

| File | What it gives you |
|---|---|
| `tokens.css` | Fonts, tokens, base styles and every shared component |
| `sky.js` | Snowfall, star field, bulb string, marquee bulbs, letterboard (new module) |
| `wheel.js` | The marquee wheel (same API as before) |
| `sound.js` | The A13 sound palette (same exports, plus new ones) |
| `icons.js` | Lucide icons, the A7 team palette, `teamDisc()` ornaments |
| `client.js` | `slotChip()`, `timerRing()`, `toast()`, `showBanner()` and the rest, all re-skinned |

The live showcase is **`/assets/kitchen-sink.html`**. It opens with a 1920×1080 TV frame assembled only from these pieces, which you can compare with `DirA-TV`. Every component, the wheel lab, two phone frames and a sound board follow.

---

## 1. Rules that shape every screen

These come from brief §3 and A14.

- **Every TV screen shows red and gold.** Navy on its own reads as "winter".
- **Green (`--holly`) only means Correct**, always with a ✓ and a word. **Chartreuse (`--grinch`) only means Grinch Steal.**
- **Never put cranberry `#C8102E` text on navy** (3.1:1). Use `--berry-hi` for red text on dark.
- **No pure white.** Use `--snow` `#FFF7EA`. `--white` is now an alias of it.
- **Use one cinema device per moment** (marquee, letterbox, ticket, silver screen and so on). Keep snow and bulbs out of the reading column.
- **Glass is only for the score strip and toasts.** Body text always sits on a solid surface.
- **Scores and timers use Figtree 800 with `tabular-nums`** (`.num`). Fraunces and Big Shoulders have proportional digits, so use them only for static numbers.
- **TV minimum text size is 28 px.** 24 px is for decoration only.
- **Never use colour alone.** Show a team as colour plus mascot, and a state as colour plus icon plus word.

---

## 2. Fonts

These are served locally by `server.js` from `node_modules`, so they work offline. All are variable fonts.

| Family (CSS) | Route | Use |
|---|---|---|
| `'Fraunces Display'` = **`var(--font-display)`** | `/fonts/fraunces/fraunces-latin-full-normal.woff2` | Display. The weight is **clamped to 800–900**, so anything set in `--font-display` is the heavy cut whatever weight the old CSS asks for. |
| `'Fraunces'` = `var(--font-serif)` | same files, plus `…-full-italic.woff2` | Any weight, and italic (the giant hanging quote marks) |
| `'Figtree'` = **`var(--font-ui)`** | `/fonts/figtree/figtree-latin-wght-normal.woff2` | UI, questions, body, buttons, **scores and timers** |
| `'Big Shoulders Display'` = **`var(--font-marquee)`** | `/fonts/big-shoulders-display/big-shoulders-display-latin-wght-normal.woff2` | Eyebrows, chips, letterboard, wheel labels, credits |

- Latin-ext faces are declared for all three. Lilita One and Fredoka are still mounted at `/fonts/lilita-one` and `/fonts/fredoka`, but nothing uses them any more.
- **Fraunces axes:**
  - `--display-axes` is `'opsz' 144, 'SOFT' 100, 'WONK' 0`.
  - `--display-axes-wonk` sets `WONK 1`; use it on splash words only.
  - Apply either with `font-variation-settings: var(--display-axes)`.
- **TV type scale:** `--fs-24` `--fs-28` `--fs-36` `--fs-48` `--fs-60` `--fs-96` `--fs-144` `--fs-splash` (160). Values are in rem, and the TV root scales them.

### Type classes

| Class | Style |
|---|---|
| `.display` (+ `.display--wonk`) | Fraunces 900, `opsz` 144, SOFT 100 |
| `.wordmark` | Fraunces 900 at 40 px, with a gold star icon in front |
| `.question` | Figtree 700, 60/1.15 |
| `.num` | Figtree 800, tabular |
| `.eyebrow` (16 px) / `.eyebrow--tv` (28 px) | Big Shoulders 800, caps, +0.12em, tinsel |
| `.marquee-text` | Big Shoulders 800 caps |
| `.lede` | Frost body |
| `.quote-marks` | Fraunces italic in tinsel |

```html
<span class="wordmark">${ic('star', { size: 30, stroke: 1.6, color: '#C9962E', className: 'icon--filled' })}Christmas Chaos</span>
```

---

## 3. Tokens (`:root`)

### Surfaces and text

| Token | Value | Role |
|---|---|---|
| `--night` | `#0B1430` | Page. Also the glyph colour on team discs. |
| `--night-2` | `#15204A` | Cards |
| `--night-3` | `#1F2C5E` | Raised surfaces, pills, chips |
| `--night-edge` | `#0A1128` | Bottom of the page gradient |
| `--night-deep` | `#070C1E` | "House lights down" (Final Chaos) |
| `--line`, `--line-soft`, `--line-strong`, `--line-bold`, `--track` | — | Hairlines |
| `--hilite` | — | The 1 px inner top highlight on cards |
| `--snow` | `#FFF7EA` | Primary text |
| `--frost` | `#C3CDE6` | Secondary text |
| `--muted` | `#8A97BD` | Tertiary text, 28 px and up only |
| `--ink` | `#0B1430` | Text on light fills |
| `--gold-ink` | `#1A1206` | Text on tinsel, dare and ember fills |
| `--foil-ink` | `#2A1B00` | Text on foil |

### Warm lights

| Token | Value |
|---|---|
| `--cranberry` | `#C8102E` |
| `--cranberry-hi` | `#D8213E` |
| `--cranberry-edge` | `#8E0B22` |
| `--berry-hi` | `#FF6B78` (red text on dark) |
| `--tinsel` | `#F6C453` |
| `--tinsel-hi` | `#FFE08A` |
| `--brass` | `#C9962E` |
| `--brass-deep` | `#8A6416` |
| `--bulb` | `#FFE6A8` |
| `--bulb-hot` | `#FFF6D6` |
| `--bulb-halo` | `rgba(255,185,56,.55)` |
| `--bulb-off` | `#6B4A0E` |
| `--velvet` | `#7E0B22` |
| `--velvet-deep` | `#2B0A14` |
| `--velvet-folds` | A gradient |
| `--screen` | `#1B1B1F` |
| `--red-nose` | `#FF2A2A` |
| `--foil` | Gradient. **Golden ticket and podium only.** |
| `--foil-light`, `--foil-silver` | Gradients |
| `--candy` | Wide 45° stripes |
| `--candy-fine` | 135° stripes, for ribbon tails and chip rims |

### Accents (at most two per screen)

| Token | Value | Use |
|---|---|---|
| `--peppermint` | `#9FE3D2` | Info, Showdown |
| `--holly` | `#3CC27A` | Correct only |
| `--ember` | `#FF9A3C` | Steal, All Play |
| `--grinch` | `#9BD13B` | Grinch Steal only |
| `--who-pink` | `#FF8FB1` | — |

### Teams (A7, in offer order)

| Token | Value | Mascot |
|---|---|---|
| `--team-red` | `#FF5F6D` | candy-cane |
| `--team-gold` | `#F6C453` | star |
| `--team-sky` | `#6CB8FF` | snowflake |
| `--team-mint` | `#5FE0C1` | tree-pine |
| `--team-pink` | `#FF8AD0` | gift |
| `--team-silver` | `#DCE3F2` | moon |
| `--team-orange` | `#FF9A3C` | cookie |
| `--team-violet` | `#B794FF` | bell |

Orange and violet each have a colour-blind lookalike, so they are offered last. The server's `MASCOTS` (src/game.js) and `icons.js` `MASCOTS` hold the same eight pairs in this order.

### Wheel slots

Each slot has a fill token and an ink token, `--slot-*` and `--slot-*-ink`. The server sends the same values in `state.segments[i].color/.ink`.

| Slot | Fill | Ink |
|---|---|---|
| christmas | `#C8102E` | `#FFF7EA` |
| dare | `#F6C453` | `#1A1206` |
| pop | `#2450D0` | `#FFF7EA` |
| **hotseat** | `#FF8FB1` | `#2A0A18` |
| **movies** | `#7E0B22` (+ `trim`) | `#FFF7EA` |
| sound | `#7B4CE0` | `#FFF7EA` |
| **grinch** | `#9BD13B` | `#0B1430` |
| **showdown** | `#5AA9E6` | `#0B1430` |
| rapid | `#0E7C74` | `#FFF7EA` |
| allplay | `#FF9A3C` | `#1A1206` |
| **double** | `#FFF7EA` + `pattern: 'candy'` | `#0B1430` |

Segment 4 carries `trim: '#F6C453'`. Segment 11 carries `pattern: 'candy', stripe: '#C8102E'`. Showdown's `lines` are now `['Show', 'Down']`, as in the mockup.

### Shape, depth and motion

| Group | Tokens |
|---|---|
| Radii | `--r-card` 28, `--r-tile` 22, `--r-btn` 20, `--r-sm` 14, `--r-chip` |
| TV safe area | `--safe-x` 80, `--safe-y` 64 |
| Depth | `--shadow-card`, `--shadow-pop`, `--glow-gold`, `--glow-berry`, `--hairline-gold` |
| Button lip | `--lip` 4, `--lip-hover` 6, `--lip-pressed` 2 |
| Easing | `--ease-out`, `--ease-spring`, `--ease-push` (button release) |
| Durations | `--dur-press` 34ms, `--dur-release` 600, `--dur-fast`, `--dur-splash` 400, `--dur-points` 700, `--dur-wipe` 600, `--dur-curtain` 1200, `--dur-letterbox` 400, `--dur-ticket` 900, `--bulb-cycle` 1.2s |

### Textures (SVG data-URIs)

`--tex-grain`, `--tex-sprocket`, `--tex-deco-frame`, `--tex-wrap` (wrapping-paper mask), `--tex-star`, `--tex-spin-ring`, `--tex-spin-lit`.

### Old names kept as aliases (so the current pages keep working)

| Old name | Now points at |
|---|---|
| `--pine` | `--night-2` |
| `--pine-2` | `--night-3` |
| `--pine-glow` | `#1A2756` |
| `--pine-lip` | `#0E1736` |
| `--cream-2` | `#F3E7CF` |
| `--berry` | `--cranberry` |
| `--berry-lip` | `--cranberry-edge` |
| `--berry-text` | `--berry-hi` |
| `--tinsel-lip` | `--brass` |
| `--tinsel-deep` | `--brass-deep` |
| `--holly-lip` | `#258A55` |
| `--ember-lip` | `#B5601C` |
| `--closed` / `--closed-lip` | `#4A5272` / `#2E3450` |
| `--rim` | `--tinsel` |
| `--white` | `--snow` |
| `--team-lime`, `--team-teal` | `--team-mint` |

`--font-display` is now Fraunces Display and `--font-ui` is now Figtree. Prefer the new names in new CSS.

---

## 4. Background, snow and stars (A1)

```html
<body class="night-sky night-sky--fixed">   <!-- or put .night-sky on any full-screen container -->
```

- `.night-sky` gives you the navy gradient, the cranberry stage glow (`--glow-red`), the gold floor bounce (`--glow-gold-floor`), static grain at 4.5% (`::before`) and a 35% corner vignette (`::after`).
  - It creates a stacking context, so snow, stars and the vignette sit **behind** your content.
  - It has phone-sized glows under 600 px.
- `.night-sky--house-down` is the darkened Final Chaos variant.

```js
import { snowfall, starfield } from '/assets/sky.js';
const snow = snowfall(stageEl, { count: 50, avoid: ['.question-card'] }); // margins only
starfield(stageEl, { count: 30 });                                          // top third, 2 twinkle
snow.refresh(); snow.destroy();
```

- **`snowfall(container, opts)`**
  - It draws 2–6 px flakes, with about 1 in 10 a Lucide snowflake, using a pure CSS fall.
  - `avoid` takes elements or selectors whose columns, plus a `margin` in %, stay clear. `lanes: [[0,8],[92,100]]` limits the flakes to explicit bands.
  - Flakes are positioned in %, and their sizes are in rem so they scale on the TV.
  - Reduced motion hides the snow.
  - The container must be positioned. A `.night-sky` already is.
- **`starfield(container, opts)`** draws static sparkles.
- **`starfieldMarkup()`** returns the same field as a string.

---

## 5. Components (tokens.css)

### Buttons (A10): three-layer pushable

```html
<button class="btn btn--primary btn--xl">Start the show</button>   <!-- TV: 80 px / 28 px 800 -->
<button class="btn btn--gold">…</button> <button class="btn btn--secondary">…</button> <button class="btn btn--danger">…</button>
```

- **How it works:** a blurred shadow, a darker edge (`--btn-lip`) and a bright gradient front. The front rests 4 px up. On press it drops to 2 px in 34 ms; on release it eases back over 600 ms. Hover lifts it to 6 px.
- **Variants:** `--primary` (cranberry), `--gold` (tinsel/brass), `--secondary` (night-3), `--danger` / `--destructive` (berry-hi outline), `--holly` (Correct only), `--ember`, `--ghost`, `--dashed`, `--link`.
- **Sizes:** `--sm` 44, `--md` 48, default 64, `--lg` 68, `--xl` 80. Modifiers: `--block`, `--icon`. The press state is also available as `.is-pressed`.
- **Round discs (A11):**
  - `.btn-round--spin` is tinsel with 16 chasing bulbs. `.btn-round--buzz` is cranberry and also has the armed bulb ring.
  - Other states: `.btn-round--won` (holly) and `.btn-round--closed` (sunk).
  - The disc is 280 px by default.
  - Wrap a disc in `.btn-halo` (or `.btn-halo--buzz`, plus `.is-live`) for the glow. The glow extends **26% beyond the disc**, so give it room or set `overflow-x: clip` on an ancestor.

### Cards (A9)

```html
<div class="card">…</div>            <div class="card card--hero">…</div>       <!-- 2 px inner gold hairline -->
<div class="card title-card">…</div> <!-- double gold rule + art-deco notches (9-slice border-image) -->
<section class="silver-screen title-card">…</section>  <!-- Christmas Movies: #1B1B1F, vignette, grain, sprockets -->
<div class="card card--slot is-dark" style="--slot-color:…;--slot-ink:…">…</div>  <!-- dark slot colours get a tinsel rim -->
<div class="card__hint">${ic('bell-ring',{size:32,color:'var(--ember)'})}<span>Miss it? … <strong>steal it for 100</strong>.</span></div>
```

- `.title-card` draws its frame on `::after`. Use `--frame-inset` to move it.
- `.silver-screen` has 72 px vertical padding for the sprocket strips (`::before`).
- Size modifiers: `--sm`, `--md`, `--raised`, `--inset`.

### Chips, tags, pills

```js
slotChip(seg)                     // .chip — slot colour, icon, Big Shoulders caps (lg 28 / md 22 / sm 16)
```

- `slotChip()` adds `.chip--rimmed` (2 px tinsel rim) automatically for velvet, royal, violet and teal. It adds `.chip--velvet` when the segment has `trim`, and `.chip--candy` (an ivory pill with a candy-cane rim) when it has `pattern: 'candy'`.
- `isDarkSlot(color)` is exported if you need the same test elsewhere.
- **Other chips and pills:**
  - `.chip--outline` for difficulty.
  - `.tag` (tinsel) with `--holly`, `--ember`, `--berry`, `--pine` and `--ghost` variants.
  - `.pill`, the "ROUND 2 OF 3" pill. Put `turnDots(i, n)` inside it; the dots are drawn as bulbs (lit, current pulsing, outline).
  - `.player-chip` (`.is-you`, `.is-offline`), `.delta--up` / `.delta--down`, and `.bulb` (`.is-off`).

```html
<span class="stub-chip" style="--chip-bg:#E9B949;--chip-ink:#0B1430">${ic('train-front')}<span class="stub-chip__rule"></span>The Polar Express</span>
```

- `.stub-chip` is the ticket-stub film chip, with notched ends and halftone dots.
- Add `.stub-chip--dark` for charcoal or navy films. Use `--sm` on phones.

### Tickets

```html
<div class="drop"><!-- notches are a mask, so the shadow goes on a wrapper -->
  <div class="ticket" style="--perf-x:66%">
    <div class="ticket__main"><span class="ticket__admit">Admit one · Tonight’s feature</span>
      <span class="ticket__title">Scan to get your ticket</span><span class="ticket__fine">…</span></div>
    <div class="ticket__stub">…QR…<span class="ticket__num">No. 001225</span></div>
  </div>
</div>
```

- **Foil grades:**
  - `.ticket--silver` is Easy, `.ticket--light-gold` is Medium, and `.ticket--gold` is Hard and the golden ticket.
  - `.ticket--sealed` is the locked wager.
  - `.ticket--plain` has no perforation.
- **Sheen:** add `.is-sheen` to play the 900 ms sweep once, or `.is-shimmer` to loop it.
- **Punched points:** `<span class="punched">+300</span>` draws dot-matrix holes in the night colour.
- **Variables:** `--notch` sets the corner radius, `--perf-r` the perforation radius, `--perf-x` the stub position, and `--ticket-bg` / `--ticket-ink` the colours.

### Ornament team discs (A4/A7)

```js
teamDisc(team, { size: 56, ornament: true })            // brass cap + loop
teamDisc(team, { size: 56, leader: true })              // gold star topper (replaces the crown)
teamDisc(team, { size: 56, ornament: true, beacon: true }) // pulsing red-nose beacon (team that is up)
```

- **Every `.disc` is glossy.** The cap, loop and star stick out **above** the disc (about 30% of its size, or 56% for the star), so leave headroom or the parent clips them.
- **In score tiles you get these automatically:** `.score-tile .disc` always draws cap and loop, and `.score-tile.is-active .disc` adds the beacon. You still need to pass `leader: true` for the leader.
- **Ring colour:** `--beacon-ring` sets the colour of the ring around the beacon.

### UP NOW ribbon and score strip (A8)

```html
<span class="ribbon">Up now</span>  <span class="ribbon ribbon--sm">Your turn · Round 2 of 3</span>
<div class="score-strip">
  <div class="score-tile is-active" style="--team:#FF5F6D">
    <span class="tag score-tile__tag">Up now</span>           <!-- renders as the ribbon -->
    ${disc(team, { size: 56, leader: isLeader })}
    <div class="score-tile__body"><span class="score-tile__name">Team Rudolph</span>
      <span class="score-tile__score"><span class="num">1,150</span></span></div>
  </div>…
</div>
```

- **The strip** is frosted glass with a 1 px top highlight.
- **Tiles size to their names.** A name clamps to one line with an ellipsis but never squeezes the score. With 7 or more tiles the strip switches to a compact size by itself.
- **The active tile** scales to 1.06 with a tinsel border, a gold glow, a tinsel score, the ribbon and the beacon.
- **Flash on points:** add `.is-bump` (and set `--team`) to flash the tile in the team colour over 700 ms.
- **Doubled turn:** `.score-tile__badge` is the candy-striped ×2 badge.

### Marquee, letterboard and bulb string

```js
import { marqueeBulbs, letterboard, bulbString } from '/assets/sky.js';
el.innerHTML = h`<div class="marquee is-chase">${raw(marqueeBulbs())}<span class="marquee__eyebrow">Now showing</span>${raw(letterboard('Team Rudolph'))}</div>`;
topBarEl.insertAdjacentHTML('afterend', bulbString({ count: 16 }));
```

- **Marquee:** add `.is-chase` (3-phase, 1.2 s, or set `--chase`) or `.is-flash` (3×).
- **Letters:** they drop one every 40 ms. Use `delay` to wait N letters first.
- **Bulb string:** add `.is-chase`, `.is-flash`, `.is-off` or `.is-plugin` (flicker twice, die, then blaze, the plug-in gag). `.bulb-string--c9` makes multicolour C9 bulbs for Double Down.
- **Padding:** `--bulb-pad` and `--wire-pad` (default 80/60 px) control the side padding.

### Letterbox, velvet, stamp, points

```html
<div class="letterbox is-on" aria-hidden="true"></div>   <!-- fixed 2.39:1 bars, 400 ms slide; .letterbox--contained inside a box -->
<div class="velvet velvet--fringe">…</div>                 <!-- curtain folds (+ gold fringe) -->
<span class="stamp is-in">Not this time</span>             <!-- berry rubber stamp at −6° -->
<span class="points-pop">+300</span>                       <!-- foil pill; --down is berry -->
<div class="candy-stripe">…</div>
```

### Timer ring

`timerRing(timer, now, { size: 160, unit: 'SEC' })` and `updateTimerRing(el, timer, now)` keep their signatures.

- The ring is a gold arc on a 12% snow track with a glowing bulb riding the head of the arc.
- The number is Figtree 800 tabular, and the unit is Big Shoulders.
- `.is-warn` (under 5 s) turns the arc and number berry-hi. `.is-paused` turns the arc frost.
- Sizes under 90 px are compact (no unit, no head). `ink: true` is for slot-coloured cards.

### Splash (A9)

```html
<div class="splash" style="--splash-bg:#9BD13B;--splash-ink:#0B1430">
  <span class="splash__eyebrow">${ic(seg.icon)}The wheel landed on</span>
  <h1 class="splash__word">Grinch Steal!</h1><p class="splash__sub">…</p></div>
```

- The splash is the slot colour with a monoline wrapping-paper repeat at 9% in the ink colour. The word is Fraunces 900 WONK at 160 px on the TV and pops in from 0.6 to 1.08 to 1.
- **Double Down:** add `.splash--candy` for wide candy stripes with an ivory word plate.
- **Contained:** `.splash--contained` renders it inside a box instead of full screen.

### Toast, reconnect banner, focus, inputs, secret card

- **`toast()`** is a frosted pill with a gold rim. `--success`, `--error` and `--info` change the rim.
- **`showBanner()`** is a gold marquee strip with ink text. `--error` is cranberry and `--info` is night-3.
- **Focus** is a 3 px tinsel ring with a 3 px offset (`:focus-visible`, `.focus-ring`).
- **`.input`** is a night-2 well with a tinsel focus ring.
- **`secretCard()`** is now a face-down velvet ticket with a dashed gold frame. Revealed, it shows an ivory face with the value in Fraunces. `tone: 'violet'` still works.

### Wheel container

`.wheel-wrap` now draws the gold and cranberry glow behind the wheel. `.wheel` fills it at 100%.

### Utilities

`.drop`, `.icon--filled`, `.divider--gold`, plus the existing `.stack`, `.row`, `.grow`, `.truncate` and `.sr-only`.

---

## 6. `wheel.js`

The API is unchanged: `createWheel(svg, segments, opts)` returns `{ spinTo, restOn, highlight, idle, bulbs, setSegments, destroy, cancel, rotation, spinning, index }`. Landing is exact, as before (tests cover all 12 indices, late join and hidden tabs).

### Geometry

- **viewBox is now `-380 -380 760 760`**, so 1 unit is 1 px at 760 px, matching the DirA boards.
- Slots are r=308. The 6 px night gutter is r=311, the 28 px tinsel rim r=328, and the brass bevel r=345.
- There are 24 bulbs on the rim and 3 px ivory dividers at 70%.
- The peppermint hub has 8 blades, rotates with the wheel and carries a static gold cap. The gold teardrop pointer with its cranberry jewel flaps on ticks.

### Labels and fills

- **Labels** are Big Shoulders 800 caps at 30 px with a 40 px Lucide icon above. They auto-shrink to fit and are re-measured once fonts load.
- **`trim`** adds velvet folds plus a 4 px gold fringe arc.
- **`pattern: 'candy'`** fills the slot with stripes and puts an ivory label pill behind the text.

### Landed state

- Other slots dim to 45% and desaturate by 30%, and the winner gets a 4 px ivory outline.
- On a spin landing there is a 150 ms hit-stop (bulbs freeze lit), then `bulbs('blink')` flashes them 3×, then they stay lit (or chase if `idle(true)`).

### Bulb modes

`wheel.bulbs('rest' | 'chase' | 'spin' | 'lit' | 'blink' | 'off')` sets `svg[data-bulbs]`. All animation is CSS on three phase groups.

- **Chase** is the idle 1.2 s cycle.
- **Spin** follows the wheel: JS only advances `svg[data-phase]` at `chaseRate(speed)` steps per second.
- **Reduced motion:** the bulbs are static and on, and the spin uses 1 turn.

### New exports

`textWidthEm(text, 'marquee' | 'display')`, `labelWidthEm` (now Big Shoulders), `displayWidthEm` (Fraunces 900), `chaseRate`, `HIT_STOP_MS`, `FLASH_MS`, `POINTER_PATH`, `VIEWBOX`, and `wheelMarkup(segs, { id })`. The `id` gives unique gradient ids per wheel.

`miniWheelMarkup()` has been re-themed.

---

## 7. `sound.js` (A13: sleigh bells and celesta)

All previous names still work, and every effect is a no-op before `unlock()` or while muted.

| Function | Sound | Use |
|---|---|---|
| `tick()` | Wooden clack with a bell overtone (self-throttled) | Wheel ticks |
| `land()` | Timpani under a celesta arpeggio, plus a jingle | Wheel lands |
| `correct()` | Major bell arpeggio | Correct |
| `wrong()` | Soft muted-trombone "wah-wah" | Wrong |
| `buzz()` | Brass honk | Buzz-in |
| `beep(final)` | 1 kHz film-leader beep | Last 5 s |
| `leaderBeep()` | Short 1 kHz blip | 3-2-1 steal leader |
| `plugIn()` | Relay clunk, then mains hum swells | Start-game gag |
| `doubleDown()` | `plugIn()` then `fanfare()` | Double Down |
| `dingLock()` | Single bell | A wager locks in |
| `fanfare()` | Brass, with timpani and a bell | Fanfare moments |
| `podium()` | Fanfare plus an "aah" choir pad | Podium |
| `sleighBells(ms)` | Sleigh bells | Anywhere festive |
| `steam(ms)` | Breathy hiss | Steam wipe |
| `whoosh(ms)` | Swept air | Transitions |
| `applause(ms)` | Crowd claps | Applause |
| `drumroll(ms)` | Snare over a timpani roll, then crash | Returns `stop()` |
| `ambience()` | Faint projector hum plus an occasional soft jingle | Lobby bed; returns `stop()`. Stop it before anything is read aloud. |

`play(name, …args)` and `EFFECTS` include all of the above.

---

## 8. Things the page builders must know

1. **The light slots now take dark ink.** `hotseat` (`#FF8FB1`), `grinch` (`#9BD13B`), `showdown` (`#5AA9E6`) and `double` (`#FFF7EA` + candy) are light, so always pair a slot colour with its `--slot-*-ink` or `seg.ink`.
   - The old tv.css uses `--slot-*` as text colours in places. For example, the landed category word renders as cranberry text on navy, which breaks the brief's "never cranberry text on navy".
   - When you restyle, set category words in ink on a chip or in `--berry-hi`, never in a dark slot colour on navy.
2. **`--font-display` is Fraunces 900.** It is about 40% wider than Lilita was.
   - `tv.js`'s `wordFit()` now measures with `displayWidthEm`.
   - The phone topbar wordmark now ellipsizes at 390 px.
   - Scores that still use `--font-display` in old CSS are proportional. Switch them to `.num` (Figtree 800 tabular).
3. **Score tiles are content-sized** (`flex: 1 1 auto`), and the old `@container` rule is gone. With 7 or more teams, `.score-strip:has(> :nth-child(7))` compacts the strip.
4. **`.card` lost its 2 px border.** Depth now comes from the inner highlight and the drop shadow. Put a ring or `border` on state variants explicitly.
5. **Masks clip.** Tickets and stub chips are masked, so a drop shadow needs a `.drop` wrapper, and anything poking out of a `.ticket` is clipped.
6. **Wheel callers:** `idle(true)` on turn intros, `restOn(i, { highlight: true })` for refresh-safe landed screens, and play `sound.land()` from `onDone`. The flash already includes the 150 ms hit-stop.
7. **Reduced motion:** `prefers-reduced-motion` or `html.reduce-motion` hides the snow, freezes bulbs on, and cuts animations to 1 ms.
8. **New icons in `icons.js`:** `popcorn`, `projector`, `ticket`, `tickets`, `train-front`, `lamp` and `armchair`. `popcorn` is the server's Christmas Movies icon, which was missing before, so that wheel slot had no icon.
9. **Server-side changes:**
   - **QR code:** it now uses ink `#0B1430` on ivory `#FFF7EA`.
   - **Font preloads:** `tv.html`, `host.html` and `index.html` now preload the new fonts.
   - **Team order:** the first team created gets candy-cane red.
