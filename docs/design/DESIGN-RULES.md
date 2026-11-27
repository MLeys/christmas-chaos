# How to write a Christmas Chaos artboard (.dc.html)

You are adding artboards to a design canvas. Each artboard is ONE self-contained file in
`C:/Users/mleys/AppData/Local/Temp/claude/d489c8c283eb5306/1f6a997f-d385-4b62-994e-3617bc11ff4c/scratchpad/canvas/project/`.

## Read first (they are the source of truth for the look)
- `../SPEC.md` (one folder up from `canvas/`): game rules, every stage's content, design tokens.
- Reference artboards already in `canvas/project/`: `Main.dc.html` (TV question in play — header, wheel, card, score strip), `TV-Spin.dc.html` (wheel lands), `TV-Lobby.dc.html` (lobby, QR via sc-for), `TV-Podium.dc.html` (confetti via sc-for). COPY their markup patterns exactly (header bar, score strip tiles, wheel `<g transform="rotate(..)">` slots, chips, timer ring, team discs, icons) so every board looks like the same product.
- Lucide icon SVGs (exact path data, use them, never invent icon paths, never emoji): `C:/Users/mleys/AppData/Local/Temp/claude/d489c8c283eb5306/1f6a997f-d385-4b62-994e-3617bc11ff4c/scratchpad/icons/node_modules/lucide-static/icons/<name>.svg`. Inline the inner elements (`<path>`, `<circle>`, `<line>`, `<rect>`, `<polygon>`) inside your own `<svg viewBox="0 0 24 24" fill="none" stroke="…" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">`. Close every element explicitly (`<path d="…"></path>`), never self-close.

## Skeleton (copy exactly; keep the support.js line EXACTLY)
```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TV — Dare in play</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&amp;family=Lilita+One&amp;display=swap" rel="stylesheet">
<style>
body{margin:0}
a{color:#FFC93C}a:hover{color:#FFE08A}
</style>
</helmet>
<div style="width: 1920px; height: 1080px; background: #0B1F17; color: #FFF6E5; font-family: 'Fredoka', sans-serif; ...">
  ... all markup with inline style="…" ...
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1920,"height":1080}}'>
class Component extends DCLogic {
  renderVals() {
    return {};
  }
}
</script>
</body>
</html>
```

## Rules that bite (each fails silently)
- Close every non-void element; quote every attribute. Use `&amp;` for a literal `&` in attributes/text.
- Root element FIXED at the artboard size for TV (1920×1080) and phones (390×844). Host boards are PAGES: fluid root (`width: 100%; max-width: 1440px; min-height: 900px; margin: 0 auto`), flex/grid with `flex-wrap`, no fixed px width on the root; side rail + content as a wrapping row (`flex: 999 1 560px; min-width: 0` for content).
- `$preview` in data-props = the artboard size (host: 1440×900).
- Inline `style="…"` for everything visual; `<helmet><style>` only for body margin and link colours.
- Lay out sibling groups with flex or grid + gap.
- `{{ hole }}` is a dotted lookup into `renderVals()` ONLY — never an expression. Compute in renderVals.
- Repeats: `<sc-for list="{{ items }}" as="item" hint-placeholder-count="3">…{{ item.x }}…</sc-for>` (HTML context only — inside `<svg>` write elements out literally instead).
- Conditionals: `<sc-if value="{{ flag }}" hint-placeholder-val="{{ true }}">…</sc-if>`.
- Events (for interactive phone boards only): `onClick="{{ handler }}"` where handler is returned from renderVals, state via `this.state` / `this.setState`. Initialise state in renderVals with `this.state?.x ?? default`.
- Always include the `<script type="text/x-dc" data-dc-script>` block: classic JS, `class Component extends DCLogic`, no imports, no `render()`.
- All UI is markup, never script-built (no innerHTML/appendChild/window globals). No network except the Google Fonts link. No iframes. No global keydown handlers. No emoji anywhere.
- Accessible as drawn: real `<button>`, `<input>` + `<label>`, `aria-label` on icon-only buttons, decorative svg `aria-hidden="true"`, meaningful svg `role="img" aria-label="…"`. Text contrast ≥ 4.5:1 (large ≥ 3:1). Touch targets ≥ 44 px (phones: primary actions ≥ 64 px).
- Copy: real, specific, warm, short (see SPEC voice). No lorem ipsum, no invented stats. Use the same demo cast everywhere:
  Teams (turn order): The Grinches (lime #7EE081, tree-pine) 900 · Jingle Bell Rockers (gold #FFC93C, bell) 750 · Team Rudolph (red #FF5A4E, star) 1,150 — active, leader · Elf Help (sky #5AC8FA, candy-cane) 400 · Naughty List (violet #B794FF, gift) 650 · Frosty’s Crew (teal #3DDBC4, snowflake) 300.
  Players: Team Rudolph = Aunt Linda, Sam, Noah, Max; The Grinches = Uncle Dave, Priya; Jingle Bell Rockers = Grandma Carol, Jules; Elf Help = Grandpa Joe, Mia; Naughty List = Chris, Tasha, Leo, Ava.
  Join URL: 10.0.0.235:3000. Round 2 of 3, turn 3 of 6 unless the stage says otherwise.
- Phone boards: 390×844 root, background #0B1F17, 20 px side padding, a slim header (team disc 36 px + team name + score), ONE primary action per screen, no fake status bar.
- Write ONLY your assigned files, in `canvas/project/`. Do not touch canvas.json or other boards. Do not render, screenshot, or open the files in a browser.
