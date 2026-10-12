# Cave Trivia — the man-cave league

A constantly-running 90s (and beyond) trivia game for the TV. The big screen
shows the game board with a QR code; guests scan it with their phones, pick a
name, and jump in any time. They answer live questions on their phones, earn
points, and climb a persistent leaderboard on the TV. Records live forever —
weeks, months, whole eras of bragging rights.

Zero dependencies. Plain Node.js. Built for a home LAN.

## Run it

Requires **Node.js 18+**. No `npm install` — there is nothing to install.

```bash
node server.js
```

The server prints everything you need:

```
  TV display:      http://192.168.1.42:1990
  Join on phones:  http://192.168.1.42:1990/play
```

Custom port: `PORT=8080 node server.js`

- **TV**: open the TV display URL in any browser (a smart TV browser, a
  Chromecast/Fire Stick browser, or a laptop plugged into the TV). Leave it
  open — the screen never goes dead (see *Attract mode* below).
- **Phones**: must be on the **same WiFi** as the server. Scan the QR code on
  the TV, or type the join URL. Pick a display name — the same name always
  reclaims the same record, even weeks later.
- **Host controls** live on the TV page (bottom bar): Start round, Next,
  Reveal, Reset, and an Auto-pilot toggle that runs rounds by itself.

### Finding the server's address

The console prints the LAN IP on boot (detected via `os.networkInterfaces()`),
and the TV page always shows the current join URL under its QR code. If you
need it manually: Windows `ipconfig`, macOS/Linux `ifconfig` / `ip addr` —
use the IPv4 address on your WiFi interface.

### Firewall

Your server's firewall must allow **inbound** connections on the port
(default **1990**) from the **private/local network** profile only:

- Windows: allow `node.exe` inbound on private networks (a prompt usually
  appears on first run), or add a rule for TCP port 1990.
- macOS: System Settings → Network → Firewall → allow Node incoming connections.
- Linux: `sudo ufw allow 1990/tcp` (only from LAN if you segment it).

Never expose this port to the internet — host controls have no password
(see *Security note*).

## Keep it running

**pm2** (recommended, any OS):
```bash
npm i -g pm2
pm2 start server.js --name cave-trivia
pm2 save
pm2 startup   # follow the printed instructions for boot persistence
```

**systemd** (Linux / Raspberry Pi), `/etc/systemd/system/cave-trivia.service`:
```ini
[Unit]
Description=Cave Trivia
After=network.target

[Service]
WorkingDirectory=/home/pi/cave-trivia
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=1990

[Install]
WantedBy=multi-user.target
```
Then `sudo systemctl enable --now cave-trivia`.

**Windows Task Scheduler**: create a task that runs `node C:\path\to\cave-trivia\server.js`
at log on (or system startup), "run whether user is logged on or not".

## Push it to GitHub

```bash
cd cave-trivia
git init
git add .
git commit -m "Cave Trivia: self-hosted man-cave trivia league"
gh repo create cave-trivia --private --source=. --push
# or without the gh CLI:
#   create an empty repo on github.com, then:
#   git remote add origin https://github.com/YOU/cave-trivia.git
#   git branch -M main
#   git push -u origin main
```

`data/db.json` (player records) is git-ignored on purpose — scores stay home.

## How the game works

**The living game.** Autopilot is ON by default — the game runs forever in
**10-question blocks** with zero host input. Anyone can join mid-game at any
time by scanning the QR; the TV never shows a dead screen.

**Flow.** A question appears on the TV and on every joined phone with a
20-second countdown (30 for video questions). Players tap an answer — it's
locked in. The timer auto-reveals: the TV highlights the correct answer,
points land, and the leaderboards update live everywhere. Then the next
question drops, forever.

**⚡ Wager rounds.** Every 10th question is Final-Jeopardy style: the TV
announces the category first, and players get 15 seconds on their phones to
wager 0 up to their entire score. Get it right: base + speed points **plus**
your wager. Get it wrong: you **lose** the wager. After the wager reveal, the
TV runs an 8-second podium ceremony for the block's top 3, block scores
reset, and the next block begins.

**Question styles.** Beyond classic multiple-choice: **picture questions**
("Who is pictured?" with the photo big on the TV), **video questions**
(Disney-heavy YouTube clips played on the TV — "which character sings
this?"), and **lightning questions** (⚡, converted from quizbowl tossups).

**Scoring.** Base points by difficulty (easy 100 / medium 200 / hard 300) plus
a speed bonus up to 100 for fast correct answers. Two boards: **all-time**
(never resets) and **block** (resets every 10 questions, feeds the podium).

**Family mode.** A host toggle filters the pool to kid-safe questions only,
with a FAMILY badge on the TV — kids can jump in anytime.

**Venue branding.** Set your bar/cave name via the host controls; it headlines
the TV broadcast. (Built to be sellable to bars: branding + host dashboard +
session stats out of the box.)

## Question pipeline

Questions come from **pluggable providers** (`server/providers/`). The game
engine only ever calls `getQuestions({count, categories, difficulty,
excludeIds})` — it never touches a bank file directly.

**Live-first.** `server/providers/remote.js` keeps an in-memory prefetch buffer
(target ~40 questions, refilled in the background whenever it drops below ~15).
Sources are pulled round-robin; every fetch has an ~8s timeout and failures
fall through to the next source. The game never waits on the network — if the
buffer is momentarily empty (or the internet drops mid-party), questions come
from the baked-in bank instantly and the buffer keeps refilling behind it.

Live sources (all keyless, no auth):

1. **The Trivia API** (`the-trivia-api.com`) — the 90s workhorse.
   `?tags=1990's` returns genuine 90s questions; categories rotate across calls
   (music / film & TV / sports / general knowledge / science / …). Note: its
   `query=` parameter is broken and it has no Pokémon/Disney tags, so we don't
   use them.
2. **Open Trivia DB** (`opentdb.com`) — free, no key. **Rate limit: max 1
   request per 5 seconds per IP**, serialized through a throttle in the
   provider; session tokens (`/api_token.php`) avoid repeats. Responses are
   HTML-entity encoded and decoded at ingest. License **CC BY-SA 4.0** —
   credited in the TV footer and here.
3. **jservice** (`jservice.io`) — 150k+ Jeopardy! clues filtered to 1990–1999
   air dates. Attempted **once at startup** as an opportunistic bulk import;
   the service is frequently unreachable, so any failure is logged and skipped
   silently. Their "question" field is the clue and "answer" is the response —
   we use clue-as-question and generate 3 distractors from other answers in the
   same category. Never depended on at game time.

**Baked-in bank = first-class provider.** `server/providers/local.js` serves
curated collections for the topics APIs can't filter, blended into **every**
round (roughly 50/50 with live questions), weighted toward the household's
favorites — sports, video games, Pokémon, Disney films, Disney parks — with a
no-repeat category rule so you never get five sports questions in a row:

- `data/questions.json` — 126 genuine 90s questions (movies, music, TV,
  sports, video games, toys/cartoons), tagged by difficulty.
- `data/questions-pokemon.json` — 25 questions: the games, the anime, the cards.
- `data/questions-disney.json` — 25 questions: Disney animated films, all eras.
- `data/questions-parks.json` — 20 questions: rides, lands, and park history.
- `data/questions-video.json` — 8 Disney video questions (YouTube embeds:
  Frozen, Little Mermaid, Aladdin, Lion King, Toy Story, Moana, Encanto,
  Beauty and the Beast). The TV plays the clip; phones say "watch the TV".
- `data/questions-daily.json` — the **daily-fresh bank**, refilled every
  morning by `scripts/fetch-daily.js` (~100 new questions/day):
  1. **Quizbowl tossups** via the qbreader API (no key) — converted to
     4-option multiple choice using the giveaway (final clue) plus
     same-category distractors. Dozen-adjacent flavor: Trash/pop culture,
     sports, current events.
  2. **Picture questions** generated from Wikimedia Commons sports-photo
     categories (NFL/NBA/MLB) — "Who is pictured?" with openly licensed
     images. Endless and free.
  3. **Open Trivia DB top-up** (respecting the 5s/request throttle).

  The script dedupes against every bank, caps the daily bank at 3000
  (oldest rotate out), and is cron-safe:
  `0 6 * * * cd /path/to/cave-trivia && node scripts/fetch-daily.js`

Questions never repeat until the combined pool is exhausted, then it reshuffles.

## API

- `GET /api/state` — full game state. The current question is included
  **without** the correct answer.
- `GET /api/events` — Server-Sent Events stream of state updates.
- `POST /api/join` `{name}` → `{playerId, token, name}`. Same name reclaims
  the same record (new token).
- `POST /api/answer` `{playerId, token, choice}` — locks in an answer for the
  live question.
- `POST /api/wager` `{playerId, token, amount}` — places/updates a wager
  during the wager phase (clamped 0..score).
- `POST /api/host/start|next|reveal|reset` — host controls (GET also works,
  handy for Stream Deck / TV remote bookmarks).
- `POST /api/host/autopilot` `{on: true|false}` — auto-advance (default on).
- `POST /api/host/family` `{on: true|false}` — kids-mode question filter.
- `POST /api/host/venue` `{name}` — venue display name for the TV.

## Security note

Host endpoints have **no authentication** — anyone on your WiFi could press
the buttons. That's a deliberate trade-off for a party box with zero login
friction. Keep it on a trusted home network and do not port-forward it to the
internet. Player tokens are random per session and checked on every answer.

## Credits

- QR generation: vendored `lib/qrcode.js` — *QR Code Generator for
  JavaScript*, © 2009 Kazuhiko Arase, MIT License.
- Question sources: Open Trivia DB (CC BY-SA 4.0), the-trivia-api.com,
  Jeopardy! clues via jservice, quizbowl tossups via qbreader, images via
  Wikimedia Commons, video via YouTube embeds.
- Built for a 90s-themed man cave. Enjoy the league.
