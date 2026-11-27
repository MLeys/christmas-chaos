# Christmas Chaos — Handoff

> Paste the **"Prompt for the next chat"** below into a new Claude Code chat opened in
> `C:\Users\mleys\code_user\christmas-chaos`.

## Prompt for the next chat

```
You're continuing "Christmas Chaos", my family Christmas party game (Node + Express + Socket.io,
vanilla ES modules): a TV big screen (/tv), phones as controllers (/), and a host screen (/host)
with live "say this / do this" directions and PIN login for a second device.
Repo: C:\Users\mleys\code_user\christmas-chaos — GitHub: https://github.com/MLeys/christmas-chaos
ALWAYS push to my PERSONAL account MLeys, NEVER the FloridaPoly org
(check: gh repo view MLeys/christmas-chaos --json owner,isInOrganization).

The v2 rebuild is DONE and tested. Read first: HANDOFF.md (status), README.md (how to run),
docs/design/NORTH-POLE.md + NORTH-POLE-API.md (the approved look and components),
docs/design/COMEDY.md (the comedy layer — the game must make people laugh), docs/SPEC.md (rules),
PROTOCOL.md (server/socket protocol).

Tests: npm test (server, 67), node --test test/assets.test.js (front end, 39),
npm run test:ui (whole game in headless Edge, ~8 min, screenshots in test/screens/).
Keep all three green. My taste: bright snowy "North Pole Workshop" Christmas look (garland,
candy canes, presents, Santa/reindeer/snowmen 3D art), modern, uncluttered, FUNNY.

What I want next: <describe the change>
```

## Status (2026-11-27)

**Done and pushed** (branch `v2-redesign`, merged into `master` once the final browser test passed):
- **Server / game engine** (`src/`): every phase and mini-game (Christmas Trivia, Christmas Movies, Pop Culture with
  Easy/Medium/Hard + steals, Dare + room vote, Showdown, Sound It Out, Rapid List, Hot Seat, typed All Play, Double Down,
  Grinch Steal, round-break bonus, Final Chaos wager, podium), host PIN auth, never-crash handlers, auto-rejoin, autosave/resume,
  undo, server-generated host coach, quips at every moment, reaction cues, funny awards, plural-name grammar (`src/grammar.js`).
- **Content** (`data/`): 110 Christmas trivia (incl. 20 weird-but-true), 118 Christmas-movie questions across 20 films
  (18 from Rudolph 1964), 75 pop culture, 50 songs, 36 rapid lists, 43 dares, 24 showdowns, 15 finals, 556 quips — all
  fact-checked and given a comedy pass.
- **Look**: "North Pole Workshop" (client-approved) — snowy white, pine garland with C9 bulbs, candy-cane prize wheel with a
  gold star pointer, gift-tag cards, ornament timer, peppermint SPIN, ornament BUZZ, Microsoft Fluent Emoji 3D art (MIT).
- **Comedy layer**: reindeer dash, coal drop + slide whistle, Grinch sneak + ka-ching, snowball splat, melting timer, Santa
  peek, wheel tease, awards ceremony with drumroll (Lump of Coal Award last), punchlines with stage cues on the host card.
- **Pages**: TV (`public/tv.html`, `assets/tv.*`), phone (`public/index.html`, `assets/player.*`), host (`public/host.html`,
  `assets/host.*`) on shared modules (`tokens.css`, `wheel.js`, `sky.js`, `fx.js`, `sound.js`, `icons.js`, `client.js`).
- **Tests**: `npm test` 67/67, assets 39/39, `npm run test:ui` full game green (≈400 screenshots).
- **README.md**: install, start, party-day checklist, how to play, troubleshooting, editing content.

**Not done / known gaps**
- Not yet tested with **real phones on the party Wi-Fi** (do a one-phone test; run `npm run firewall` once as admin; VPN off).
- The claude.ai **design canvas** (https://claude.ai/artifact/8PAdtiMwUp1DUu1ZgrLQNq) still shows the older rejected looks;
  the real app is the source of truth now (`public/concepts/` holds the approved concept pages; `public/assets/kitchen-sink.html`
  shows every component).
- `docs/design/artboards/` and `MIDNIGHT-PREMIERE.md` are historical (superseded by NORTH-POLE*.md).
- Ideas if there's time: a "practice round", per-family custom questions (inside jokes) via a simple host editor, and
  replacing the synthesized sounds with recorded ones.
