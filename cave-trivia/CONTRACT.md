# Cave Trivia — Client/Server Contract v2 (always-on living game)

This is the exact contract the TV client (`public/tv.html`) and phone client
(`public/play.html`) build against. The server implements exactly this.

## Game model

- The game runs forever in 10-question **blocks**. Questions 1–9 are normal,
  question 10 of every block is a **WAGER round** (Final-Jeopardy style).
- Phases: `idle | wager | question | reveal | podium`
  - `wager` (15s): TV shows "FINAL WAGER" + the category. Phones show a wager
    slider (0 .. player's current score). No question yet.
  - `question` (20s normal, 30s when the question has video): options A–D.
    Picture questions carry `image`; video questions carry `video`.
  - `reveal` (8s normal, 12s wager): correct answer + per-player results.
  - `podium` (8s, only after a wager reveal): top 3 of the block.
- Autopilot is ON by default — the game cycles with zero host input.
- Family mode (host toggle) filters the pool to `kid_safe` questions only.

## Question object (wire fields)

```js
{
  id, category, difficulty,       // difficulty: easy|medium|hard
  text, options /*[4]*/,
  image /* string URL | null */, // picture question — TV shows it big
  video /* { youtubeId, start, end } | null */,
  endsAt, timeLeftMs, answeredCount,
  isWager /* bool */, seconds    // seconds = the answer window for this Q
}
```

Phones: when `image` or `video` is present, show "WATCH THE TV" + the options.
The TV plays the YouTube embed (`https://www.youtube.com/embed/{youtubeId}?autoplay=1&rel=0&start={start}&end={end}`)
or shows the image full-bleed behind the question.

## Scoring

- Normal correct: 100/200/300 by difficulty + speed bonus up to 100.
- Wager correct: base + speed + wager amount. Wager wrong: −wager (floor 0).
  No wager placed (or 0): base + speed only.
- `score` is all-time persistent. `blockScore` resets each 10-Q block.

## GET /api/state  (and SSE /api/events pushes the same shape)

```js
{
  phase,                       // idle|wager|question|reveal|podium
  block: { number, questionInBlock },  // questionInBlock 1..10
  wager: null | { category, endsAt, timeLeftMs, wagersPlaced },
  question: null | { ...question object above... },
  reveal: null | {
    correctIndex, correctText, answeredCount, correctCount, isWager,
    results: [{ name, delta, wager, correct }]  // wager fields 0 when n/a
  },
  podium: null | { top: [{ name, score, correct }] },  // block top 3
  leaderboard: [{ name, score, correct }],   // all-time top 10
  blockBoard:  [{ name, score, correct }],   // current-block top 10 (score = blockScore)
  playersTotal, playersActive,
  familyMode /* bool */, venueName /* string */,
  stats: { questionsAsked },
  joinUrl, serverTime, autoPilot,
  providers: { local: {name, questions, categories}, remote: {...} },
  attribution
}
```

`reveal.results` is sorted by delta desc. On wager reveals it includes every
player who placed a wager (even if they didn't answer).

## Endpoints

- `POST /api/join` `{name}` → `{playerId, token, name}`
- `POST /api/answer` `{playerId, token, choice}` → `{ok:true, locked:true}`
  (409 when no active question / already answered / time up; 401 bad token)
- `POST /api/wager` `{playerId, token, amount}` → `{ok:true, wager}`
  - Only during `wager` phase (409 otherwise). `amount` clamped to
    `0 .. player.score`, integer. Re-sending overwrites the wager.
- `GET /api/state`, `GET /api/events` (SSE)
- Host (no auth, LAN box):
  - `POST /api/host/start` — reset block scores, start block 1, deal Q1
  - `POST /api/host/next` — skip ahead
  - `POST /api/host/reveal` — force reveal
  - `POST /api/host/reset` — back to idle
  - `POST /api/host/autopilot` `{on}` — toggle (default true)
  - `POST /api/host/family` `{on}` — family/kids mode filter
  - `POST /api/host/venue` `{name}` — venue display name (default CAVE TRIVIA)

## Design direction (both clients)

Million-dollar broadcast look: dark refined backdrop, gold/chrome accents,
huge couch-readable type. One motion motif everywhere (gold light streaks),
WebAudio sound on every transition (countdown ticks, question sting, reveal
hit, wager drama swell — oscillators only, zero assets). TV is projector-first:
right rail always shows the live top-10 + QR join card; the stage never shows
a dead screen. Phones are clean and thumb-friendly; wager slider is the
hero control of the wager phase. Family mode shows a FAMILY badge on the TV.
