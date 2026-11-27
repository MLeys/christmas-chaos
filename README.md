# 🎄 Christmas Chaos

A Christmas party game show for the whole family. The **wheel spins on the TV**, every team plays from their **phones**, and the **host** runs it all from a laptop (or their own phone) with live "say this / do this" directions. Trivia, Christmas-movie questions, dares, showdowns, humming songs, steals, a Final Chaos wager — and lots of laughs.

- **Players:** 2–8 teams (sweet spot 4–6), any age. Phones only, nothing to install.
- **Length:** about 60–75 minutes (rounds adjust to the number of teams).
- **Runs on your own Wi-Fi.** No account, no internet needed once installed.

---

## 1. What you need

- A **Windows laptop** (Mac/Linux work too) with **Node.js 18 or newer** — get it from <https://nodejs.org> (choose "LTS").
- A **TV** connected to the laptop (HDMI cable or screen casting).
- Everyone's **phones on the same Wi-Fi** as the laptop.

## 2. Install (one time)

Open **PowerShell** (or Terminal) and run:

```powershell
git clone https://github.com/MLeys/christmas-chaos.git
cd christmas-chaos
npm install
```

No git? On the GitHub page click **Code → Download ZIP**, unzip it, open PowerShell in that folder and run `npm install`.

**Let phones through the firewall (Windows, one time, needs admin):**

```powershell
npm run firewall
```

Click **Yes** when Windows asks for permission. (This adds one inbound rule for port 3000 so phones can reach the laptop. Run `powershell -ExecutionPolicy Bypass -File scripts\setup-firewall.ps1 -Remove` to take it out again.)

## 3. Start the game

```powershell
npm start
```

The window prints everything you need:

```
CHRISTMAS CHAOS is running!
  Phones join at:  http://<laptop-ip>:3000/
  TV screen:       http://localhost:3000/tv
  Host screen:     http://localhost:3000/host
  Host PIN:        4821   (only needed to host from a second device, e.g. your phone)
```

Then:

| Who | Opens | Notes |
|---|---|---|
| **TV** | `http://localhost:3000/tv` on the laptop, shown on the TV | Click once on **"Click to start the show"** — that turns on the sound and full screen. |
| **Host** | `http://localhost:3000/host` on the laptop | Signed in automatically on the laptop. To host from your phone instead, open `http://<laptop-ip>:3000/host` and type the **Host PIN**. |
| **Players** | Scan the **QR code on the TV** (or type the address shown) | Type a name, tap a team. That's it. If a phone locks or refreshes, it rejoins by itself. |

Leave the PowerShell window open during the party — closing it stops the game. (Progress is auto-saved; if the laptop restarts, `npm start` again and the host screen offers to resume.)

## 3b. Play online instead (no firewall, works on any phone)

If phones can't reach the laptop (work/school laptops often block this, and some Wi-Fi networks isolate devices), host the
game online for free. Everyone — TV, host and every phone — just opens one web link, on any Wi-Fi or mobile data.

1. Go to <https://render.com> and **sign up with your GitHub account** (free, no card needed).
2. Click **New → Blueprint**, pick the **christmas-chaos** repository, and click **Apply**. When asked for `HOST_PIN`,
   type any 4 digits (e.g. `2512`) — that's your host password.
3. Wait 2–3 minutes until it says **Live**. Your game address looks like `https://christmas-chaos-xxxx.onrender.com`.
4. On the laptop connected to the TV open `https://<your-address>/tv` and click **"Click to start the show"**.
   Host: open `https://<your-address>/host` (on the laptop or your phone) and type your PIN.
   Players: scan the QR code on the TV.

The free plan goes to sleep after 15 minutes without visitors — open the TV page a minute before the party to wake it up.

## 4. Party-day checklist

- [ ] Laptop **plugged in**, sleep turned off, connected to the TV.
- [ ] Laptop and phones on the **same Wi-Fi** (not a guest network that isolates devices).
- [ ] **VPN off** on the laptop.
- [ ] `npm run firewall` has been run once.
- [ ] Do a **test with one phone** before guests arrive.
- [ ] TV: click **"Click to start the show"**, turn the volume up.
- [ ] Host: make the teams in the lobby (name + mascot), then tap **"Read the opening script"** and read it to the room.

## 5. How a game works

1. **Lobby** — everyone joins on their phone; the host sets up teams and taps **Start**.
2. **Turns** — each team takes a turn per round. Any player on the active team taps the **peppermint SPIN** button; the wheel spins on the TV.
3. **The wheel** lands on one of: **Christmas Trivia**, **Christmas Movies**, **Pop Culture** (pick Easy 100 / Medium 200 / Hard 300; miss it and other teams can **steal** with the red ornament **BUZZ** button), **Dare**, **Showdown** (head-to-head vs a rival), **Sound It Out** (hum the secret song), **Rapid List**, **Hot Seat**, **All Play** (every team types an answer), **Double Down**, or **Grinch Steal**.
4. **Round breaks** — a hot-cocoa break with the standings (and an optional bonus question).
5. **Final Chaos** — every team secretly wagers points, then types an answer to one final question.
6. **Podium + awards** — including the Fastest Finger, Grinch of the Year and the infamous **Lump of Coal Award**.

The **host screen tells you exactly what to say and which button to press at every moment** — just follow the note card and press the big highlighted button. Handy keys: **C** correct, **W** wrong, **R** reveal, **T** timer, **U** undo.

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| Phones can't open the page | Same Wi-Fi? Run `npm run firewall`. Turn off VPN. In the host lobby, try another address if several are listed. |
| No sound on the TV | Click **"Click to start the show"** on the TV page; check the TV volume and the mute button. |
| Port already in use | Close the other game window, or start on another port: `$env:PORT=3001; npm start` (then use :3001 in the addresses and run the firewall script with `-Port 3001`). |
| Someone pressed the wrong button | Host: **Undo** (U). Scores can also be adjusted with − / +. |
| A phone shows "Reconnecting…" | It will rejoin automatically; if not, refresh the page — it remembers the player. |

Optional settings (set before `npm start`): `PORT` (default 3000), `HOST_PIN` (fixed host PIN), `HOST_IP` (force the address shown for phones), `CC_SAVE_DIR` (where auto-saves go).

## 7. Make it yours

All content is plain JSON in `data/` — edit with any text editor and restart:

- `trivia-christmas.json`, `trivia-movies.json`, `trivia-popculture.json` — questions (`question`, `answer`, `accept` alternatives, `difficulty`, `hint`, `funFact`).
- `dares.json`, `showdowns.json`, `songs.json`, `lists.json`, `finals.json`.
- `quips.json` — the funny lines the TV and host use at each moment.

## 8. For developers

```powershell
npm test                          # game engine + end-to-end socket tests
node --test test/assets.test.js   # front-end helpers (wheel, timers, fx)
npm run test:ui                   # plays a whole game in headless Edge and screenshots every screen
```

`npm run test:ui` needs Microsoft Edge installed and takes about 8 minutes; screenshots land in `test/screens/`. Set `UI_HEADED=1` to watch the browsers, `UI_QUICK=0` to skip the 720p / small-phone pass. Quip authors can write `{teamVerb:wins|win}` so plural team names read correctly.

Architecture, protocol and design docs: `PROTOCOL.md`, `docs/SPEC.md`, `docs/TECH.md`, `docs/design/`. Continuing work in a new chat: see `HANDOFF.md`.

## Credits

3D illustrations: [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (MIT licence, see `public/assets/art/LICENSE-fluent-emoji.txt`). Line icons: [Lucide](https://lucide.dev) (ISC). Fonts: Bagel Fat One and Figtree via [Fontsource](https://fontsource.org) (SIL Open Font License).
