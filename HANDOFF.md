# Christmas Chaos — Handoff

> Paste the **"Prompt for the next chat"** section below into a new Claude Code chat opened in
> `C:\Users\mleys\code_user\christmas-chaos` (branch `v2-redesign`).

## Prompt for the next chat

```
You are continuing the v2 rebuild of "Christmas Chaos", my family Christmas party game
(Node + Express + Socket.io; a TV "big screen", phones as controllers, and a host screen).
Repo: C:\Users\mleys\code_user\christmas-chaos — work on branch `v2-redesign`.
GitHub: https://github.com/MLeys/christmas-chaos — ALWAYS my PERSONAL account MLeys,
NEVER the FloridaPoly org (verify with `gh repo view MLeys/christmas-chaos --json owner,isInOrganization`).
`master` holds the old v1 (keep it untouched until v2 passes all tests, then merge).

Read first, in this order:
1. HANDOFF.md (this file — status + what's left)
2. docs/SPEC.md  — game rules, every stage of every screen, points, design system (v2.1)
3. docs/TECH.md  — architecture, socket protocol, view shapes, acceptance tests 1–19
4. PROTOCOL.md   — the protocol as actually implemented by the server (if present/finished)
5. docs/design/DESIGN-RULES.md + docs/design/artboards/*.dc.html — the screen designs
   (visual reference; live canvas: https://claude.ai/artifact/8PAdtiMwUp1DUu1ZgrLQNq)
6. docs/review/*.json — expert review of v1 (every bug listed must be impossible in v2)
7. docs/research/*.md — design research (game UI, modern Christmas, Christmas-movie looks)

Then continue with "What's left" in HANDOFF.md. Use workflows / parallel agents for big pieces,
test everything for real (npm test, the e2e socket tests, Playwright with headless Edge:
playwright-core + chromium.launch({channel:'msedge'})), and push progress to `v2-redesign`
on MLeys regularly. My design taste: modern but not loud, unmistakably Christmas,
NO green main background, fun, and weave in the classic Christmas-movie looks
(Home Alone, Elf, Polar Express, Grinch, Rudolph 1964, It's a Wonderful Life…).
```

## Where things stand (updated 2026-11-27)

### Done
- **Review of v1** (live playtest with socket clients + headless Edge, code reviews, visual audit,
  game-design review, content fact-check): `docs/review/`. Critical v1 bugs included phones that
  lock/refresh silently becoming dead, the TV showing the Sound It Out song title, a blank TV game-over
  screen, trivia that was just an open buzzer race, no host authorization, crashes on bad input,
  and Windows Firewall likely blocking phones.
- **v2 game design** (`docs/SPEC.md`): fairer trivia (active team picks Easy 100 / Medium 200 / Hard 300,
  answers first; others steal at half value after a 3 s arm, one try each), typed **All Play** on phones,
  **Christmas Movies** wheel slot, **Showdown** (head-to-head), **Grinch Steal** (only teams ahead;
  leader gifts 100 to last place), room voting on dares, Double Down scoped to the turn, Hot Seat, Rapid
  List, Sound It Out with a secret performer, round-break bonus, **Final Chaos** wager + typed answers,
  podium with awards, rounds = clamp(round(20/teams),3,6) (~60–75 min).
- **Host login + live directions** spec: PIN login for extra devices (laptop is auto-host), a
  server-generated "coach" panel (Now / Say this / Do this / actions / tips), phone host remote, opening
  script.
- **Technical blueprint** (`docs/TECH.md`): stable clientId identity + auto rejoin, stable team ids,
  host PIN auth, never-crash handlers with phase guards, cancellable scheduler, role-filtered views
  (secrets never leave the server early), single `award()` path, undo, autosave/resume, LAN-IP picking,
  QR code, local fonts, acceptance tests.
- **Content** in `data/` (all fact-checked + party-fit reviewed): 90 Christmas trivia, 75 pop culture,
  42 songs, 26 rapid lists, 36 dares (14 with secret prompts), 12 finals, 20 showdowns.
- **Shared front-end** in `public/assets/` (done + tested, 27/27): tokens.css, icons.js (Lucide),
  wheel.js (exact landing + late-join sync + tick events), sound.js (Web Audio synth), client.js
  (identity, reconnect, clock sync, escaping, helpers), kitchen-sink.html. NOTE: tokens.css still uses
  the OLD green palette — re-theme it to the chosen new direction.
- **Design canvas**: ~49 artboards covering every TV / phone / host stage (old green look).

### In progress when this handoff was written (may have finished — check git log / files)
- `src/*`, `server.js`, `test/game.test.js`, `test/e2e.test.js`, `PROTOCOL.md` — server/game engine
  (build workflow). Run `npm test` to see where it stands.
- `data/trivia-movies.json` — ~110 Christmas-movie questions across 20 films (10+ Rudolph 1964), plus
  movie songs/lists/charades/finals woven into the other data files.
- 3 new **modern Christmas visual directions** (research-backed, no green background, movie looks)
  to show the user on a "Directions" page of the canvas → the user picks one.
- Host phone remote + opening-script artboards.

### What's left
1. Finish/verify the server (`npm test` green for acceptance tests 1–18 in TECH.md §5), including the
   Christmas Movies slot (slot 4, category `movies`, `data/trivia-movies.json`) and the host coach
   (`hostView.host.coach`, `introScript`, PIN login flow).
2. User picks a visual direction → re-theme `public/assets/tokens.css` and restyle every artboard.
3. Build the pages: `public/index.html` (player, served at `/`), `public/tv.html`, `public/host.html`
   (+ `tv.js`, `host.js`, `player.js`, page CSS) against PROTOCOL.md + the artboards; remove v1
   `public/player.html` and `public/css/`.
4. Integration: `test/ui-smoke.mjs` (Playwright/Edge screenshots of every stage at TV 1920×1080 &
   1280×720, host 1440×900 & 1024×768, phone 390×844 & 360×740; zero console errors, no overflow),
   full simulated games for 2/4/6/8 teams, then design-QA vs artboards and fix.
5. README party-day checklist; `npm run firewall` (scripts/setup-firewall.ps1, run as admin);
   disconnect VPN; test with one real phone on the party Wi-Fi.
6. Merge `v2-redesign` → `master` and push to MLeys.

### Run it
```
npm install
npm test          # unit + e2e
npm start         # prints join URL, TV URL, host URL, host PIN
```
TV: `http://<laptop-ip>:3000/tv` · Host: `http://localhost:3000/host` · Players: scan the QR on the TV
(or open `http://<laptop-ip>:3000/`).
