# Christmas Chaos — Handoff

Paste the prompt below into a new AI agent session (e.g. Claude Code) opened in the project folder
(`C:\Users\mleys\code_user\christmas-chaos`, or a fresh clone of https://github.com/MLeys/christmas-chaos).

## Prompt for the next agent

```
You are continuing "Christmas Chaos", my family Christmas party game show. It's a Node.js app
(Express + Socket.io, vanilla ES modules, no build step) with three screens:
  - TV big screen:   /tv     (the wheel, questions, animations, scoreboard)
  - Phones:          /       (players join by QR code, spin, buzz, type answers, vote, wager)
  - Host:            /host   (control room with live "Say this / Do this" directions; the laptop is
                              host automatically, other devices log in with a 4-digit PIN)

Repo: https://github.com/MLeys/christmas-chaos  (branch master = current; v2-redesign = same history)
GitHub rule: ALWAYS push to my PERSONAL account MLeys, NEVER the FloridaPoly organization.
Verify before pushing: gh repo view MLeys/christmas-chaos --json owner,isInOrganization
(expect owner MLeys, isInOrganization false).

READ FIRST, in this order:
  1. HANDOFF.md                       — status, open items (this file)
  2. README.md                        — how to install/run, party checklist, online hosting (Render)
  3. docs/design/NORTH-POLE.md        — the APPROVED visual design ("North Pole Workshop")
  4. docs/design/NORTH-POLE-API.md    — shared CSS tokens/components + JS helper APIs
  5. docs/design/COMEDY.md            — the comedy layer (the game MUST make people laugh)
  6. docs/SPEC.md                     — game rules, every stage of every screen, scoring
  7. PROTOCOL.md                      — server <-> client socket protocol and view shapes
(docs/TECH.md, docs/design/MIDNIGHT-PREMIERE.md and docs/design/artboards/ are historical.)

Code map:
  server.js            express + socket.io wiring, host PIN auth, QR, fonts, LAN/public URL, autosave
  src/game.js          pure game state machine (all phases + mini-games, scoring, quips, awards)
  src/coach.js         server-generated host directions;  src/views.js role-filtered views
  src/content.js       loads/validates data/*.json;       src/grammar.js plural team-name grammar
  data/*.json          all questions, dares, showdowns, songs, lists, finals, quips (editable)
  public/assets/       tokens.css, wheel.js, sky.js (garland/snow), fx.js (gags), sound.js,
                       icons.js, client.js, art/ (Fluent Emoji 3D, MIT), tv/host/player .js/.css
  test/                game.test.js + e2e.test.js (npm test), assets.test.js, ui-smoke.mjs

Tests — keep ALL green after any change:
  npm test                          (67 server/e2e tests)
  node --test test/assets.test.js   (39 front-end tests)
  npm run test:ui                   (plays a whole game in headless Microsoft Edge via playwright-core,
                                     ~8 min, screenshots in test/screens/; UI_HEADED=1 to watch)

My taste / requirements:
  - Unmistakably CHRISTMAS: bright snowy "North Pole Workshop" — pine garland with coloured bulbs,
    candy canes, presents, ornaments, Santa/reindeer/snowmen. I REJECTED a dark green look and a
    navy "movie palace" look as "not Christmas". Modern, uncluttered, big readable text on the TV.
  - FUNNY: quips, gags, funny awards (Lump of Coal Award etc.) — family-friendly roasting.
  - Lots of classic Christmas-movie trivia (especially Rudolph the Red-Nosed Reindeer, 1964).
  - It must work on normal people's phones — most guests have iPhones (Safari).
  - Keep costs low; show me a real rendered concept before rolling out any big visual change.

OPEN ITEMS (start here):
  1. Online hosting on Render (free) so iPhones can join from anywhere. render.yaml is in the repo;
     server.js uses RENDER_EXTERNAL_URL / PUBLIC_URL for the QR code. I need to create the Render
     service (README "Play online instead"); once I give you the URL, verify /api/info, /tv, /host,
     the phone page and a real join, and fix anything that breaks behind Render's proxy
     (websockets, host PIN login since nobody is "localhost" there, cold-start sleep).
  2. My iPhone test. On my WORK laptop phones get a blank page: its IT policy ignores local firewall
     rules on "Public" Wi-Fi (AllowLocalFirewallRules=False), and PowerShell runs in Constrained
     Language Mode (whoami.exe and Playwright's WebKit download are blocked). That's why we're going
     to Render (or a personal laptop). The code itself has no iOS-incompatible JS.
  3. My sign-off on the final look after I see it on my phone; then apply any tweaks I ask for.
  4. Optional: the claude.ai design canvas (https://claude.ai/artifact/8PAdtiMwUp1DUu1ZgrLQNq) opens
     on a "final app" page of real screenshots; older pages are archived rejected looks.

What I want next: <describe the task>
```

## Status (2026-11-27)

**Done, tested and on GitHub (`master`):**
- Full v2 rebuild: server/game engine, all mini-games (Christmas Trivia, Christmas Movies, Pop Culture with
  Easy/Medium/Hard + steals, Dare + room vote, Showdown, Sound It Out, Rapid List, Hot Seat, typed All Play,
  Double Down, Grinch Steal, round-break bonus, Final Chaos wager, podium + funny awards), host PIN login,
  auto-rejoin, autosave/resume, undo, live host directions with punchlines.
- Content: 110 Christmas trivia (20 weird-but-true), 118 Christmas-movie questions over 20 films (18 Rudolph),
  75 pop culture, 50 songs, 36 rapid lists, 43 dares, 24 showdowns, 15 finals, 556 quips — fact-checked + comedy pass.
- North Pole Workshop look on TV, phone and host, with the comedy animations and sounds.
- Tests: npm test 67/67, assets 39/39, npm run test:ui full game passed (385 screenshots).
- README (install, party checklist, troubleshooting, Render hosting); firewall script works on locked-down PCs.

**Open:** Render deployment + verification, real iPhone test, user sign-off on the look (see prompt above).
