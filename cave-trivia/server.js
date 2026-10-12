'use strict';
/*
 * Cave Trivia — zero-dependency 90s trivia league server (Node 18+).
 *
 *   node server.js            # serves on http://<lan-ip>:1990
 *   PORT=8080 node server.js  # custom port
 *
 * What it does:
 *   - Serves the TV display (/) and the phone client (/play) as static files.
 *   - Runs the game engine: question rounds, countdown timer, scoring.
 *   - Pushes live state to all screens via Server-Sent Events (/api/events).
 *   - Persists players, scores, and history to data/db.json (survives restarts).
 *
 * Question sourcing (see server/providers/):
 *   - LIVE-FIRST: server/providers/remote.js keeps a prefetch buffer filled
 *     from live trivia APIs (The Trivia API 90s tags, Open Trivia DB, jservice).
 *   - The baked-in bank (server/providers/local.js) is a FIRST-CLASS provider
 *     holding the topics APIs can't filter: Pokémon, Disney films, Disney parks,
 *     plus the core 90s sets. Every round blends live + bank questions, weighted
 *     toward the household's favorites (sports, games, Pokémon, Disney).
 *   - If the network drops, the game keeps running from the baked-in bank.
 *
 * Host controls (TV page, no auth — this is a LAN party box; see README):
 *   POST /api/host/start | next | reveal | reset | autopilot
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 1990;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const QUESTION_SECONDS = 20;
const VIDEO_QUESTION_SECONDS = 30;
const WAGER_SECONDS = 15; // Final-Jeopardy style wager window
const WAGER_REVEAL_SECONDS = 12;
const PODIUM_SECONDS = 8;
const REVEAL_SECONDS = 8; // autopilot: pause on the reveal screen before next Q
const BLOCK_SIZE = 10; // every 10th question of a block is the wager round
const BASE_POINTS = { easy: 100, medium: 200, hard: 300 };
const SPEED_BONUS_MAX = 100;
const MAX_ASKED_IDS = 3000;

// Bank category weights — household favorites first: sports, video games,
// Pokémon, Disney films, parks, then the 90s sets and everything else.
const BANK_WEIGHTS = {
  sports: 3, games: 3, pokemon: 3,
  disney: 2.5, pixar: 2.5, parks: 2, jeopardy: 2.5,
  movies: 1.5, tv: 1.5, music: 1.5, toons: 1.5,
  toys: 1, mixed: 1,
};
const ALL_CATS = ['movies', 'music', 'tv', 'sports', 'games', 'toys', 'pokemon', 'disney', 'pixar', 'parks', 'toons', 'jeopardy', 'mixed'];

const localProvider = require('./server/providers/local');
const remoteProvider = require('./server/providers/remote');
const BANK_CATS = new Set(localProvider.info().categories);

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

function defaultDb() {
  return {
    players: {}, // id -> {id,name,token,score,blockScore,correct,answered,wagersWon,wagersLost,joinedAt,lastSeen}
    askedIds: [],
    recentCats: [],
    session: { active: false, startedAt: null, round: 0 },
    phase: 'idle', // idle | wager | question | reveal | podium
    current: null, // {qid,category,difficulty,text,options,image,video,answerIndex,isWager,seconds,endsAt,answers,wagers,revealed}
    wager: null, // {category,endsAt,wagers:{pid:amount}} during the wager phase
    podium: null, // {top:[{name,score,correct}]} during the podium phase
    block: { number: 1, dealt: 0 }, // dealt = normal questions dealt this block (0..9); the 10th is the wager
    familyMode: false,
    venueName: 'CAVE TRIVIA',
    theme: 'midnight-gold',
    disabledCats: [],
    stats: { questionsAsked: 0 },
    autoPilot: true,
  };
}

// Bring databases from older versions up to the current schema.
function migrateDb() {
  for (const p of Object.values(db.players)) {
    if (p.blockScore === undefined) p.blockScore = 0;
    if (p.wagersWon === undefined) p.wagersWon = 0;
    if (p.wagersLost === undefined) p.wagersLost = 0;
  }
  if (!db.block) db.block = { number: 1, dealt: 0 };
  if (!db.stats) db.stats = { questionsAsked: 0 };
  if (!db.venueName) db.venueName = 'CAVE TRIVIA';
  if (db.familyMode === undefined) db.familyMode = false;
  if (db.autoPilot === undefined) db.autoPilot = true;
  if (!db.theme) db.theme = 'midnight-gold';
  if (!Array.isArray(db.disabledCats)) db.disabledCats = [];
  db.wager = null;
  db.podium = null;
}

let db = defaultDb();

function loadDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      db = Object.assign(defaultDb(), raw);
      // a restart always lands in a clean idle state (no dangling timers)
      db.phase = 'idle';
      db.current = null;
      migrateDb();
    }
  } catch (e) {
    console.error('cave-trivia: could not load db.json, starting fresh (' + e.message + ')');
    db = defaultDb();
  }
}

function saveDb() {
  try {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('cave-trivia: db save failed (' + e.message + ')');
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return 'localhost';
}

function sanitizeName(n) {
  return String(n || '')
    .trim()
    .replace(/[<>&"']/g, '')
    .slice(0, 18);
}

let questionTimer = null;
function clearTimer() {
  if (questionTimer) {
    clearTimeout(questionTimer);
    questionTimer = null;
  }
}

// ---------------------------------------------------------------------------
// leaderboards + public state (never includes the correct answer)
// ---------------------------------------------------------------------------

function leaderboard(mode) {
  const rows = Object.values(db.players).map((p) => ({
    name: p.name,
    score: mode === 'block' ? p.blockScore || 0 : p.score,
    correct: p.correct,
  }));
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return rows;
}

function publicState() {
  const now = Date.now();
  const c = db.current;
  const st = {
    phase: db.phase,
    joinUrl: 'http://' + lanIp() + ':' + PORT + '/play',
    round: db.session.round,
    block: { number: db.block.number, questionInBlock: (db.phase === 'wager' || db.phase === 'podium' || (c && c.isWager)) ? BLOCK_SIZE : db.block.dealt },
    session: { active: db.session.active },
    autoPilot: db.autoPilot,
    familyMode: db.familyMode,
    venueName: db.venueName,
    theme: db.theme,
    disabledCats: db.disabledCats,
    stats: { questionsAsked: db.stats.questionsAsked },
    serverTime: now,
    question: null,
    wager: null,
    reveal: null,
    podium: db.podium,
    leaderboard: leaderboard('all').slice(0, 10),
    blockBoard: leaderboard('block').slice(0, 10),
    playersTotal: Object.keys(db.players).length,
    playersActive: Object.values(db.players).filter((p) => now - (p.lastSeen || 0) < 5 * 60 * 1000).length,
    providers: { local: localProvider.info(), remote: remoteProvider.info() },
    attribution: 'Questions: Open Trivia DB · the-trivia-api.com · Quizbowl via qbreader · images via Wikimedia Commons',
  };
  if (db.phase === 'wager' && db.wager) {
    st.wager = {
      category: db.wager.category,
      endsAt: db.wager.endsAt,
      timeLeftMs: Math.max(0, db.wager.endsAt - now),
      wagersPlaced: Object.keys(db.wager.wagers).length,
    };
  }
  if (c && (db.phase === 'question' || db.phase === 'reveal')) {
    st.question = {
      id: c.qid,
      category: c.category,
      difficulty: c.difficulty,
      text: c.text,
      options: c.options.slice(),
      image: c.image || null,
      video: c.video || null,
      isWager: !!c.isWager,
      seconds: c.seconds,
      endsAt: c.endsAt,
      timeLeftMs: Math.max(0, c.endsAt - now),
      answeredCount: Object.keys(c.answers).length,
    };
  }
  if (db.phase === 'reveal' && c) {
    const answers = Object.values(c.answers);
    const results = [];
    const seen = new Set();
    for (const [pid, a] of Object.entries(c.answers)) {
      const p = db.players[pid];
      if (!p) continue;
      seen.add(pid);
      results.push({
        name: p.name,
        delta: a.points || 0,
        wager: (c.wagers && c.wagers[pid]) || 0,
        correct: !!a.correct,
      });
    }
    // include players who wagered but never answered
    if (c.isWager && c.wagers) {
      for (const [pid, amt] of Object.entries(c.wagers)) {
        if (seen.has(pid)) continue;
        const p = db.players[pid];
        if (!p) continue;
        results.push({ name: p.name, delta: -amt, wager: amt, correct: false });
        seen.add(pid);
      }
    }
    results.sort((a, b) => b.delta - a.delta);
    st.reveal = {
      correctIndex: c.answerIndex,
      correctText: c.options[c.answerIndex],
      answeredCount: answers.length,
      correctCount: answers.filter((a) => a.correct).length,
      isWager: !!c.isWager,
      results: results.slice(0, 12),
    };
  }
  return st;
}

// ---------------------------------------------------------------------------
// game engine + mixer
// ---------------------------------------------------------------------------

function drawBankQuestion(avoidCats, askedIds) {
  const disabled = new Set(db.disabledCats || []);
  const cats = Object.keys(BANK_WEIGHTS).filter((c) => BANK_CATS.has(c) && !avoidCats.has(c) && !disabled.has(c));
  if (cats.length === 0) return null;
  const total = cats.reduce((s, c) => s + BANK_WEIGHTS[c], 0);
  let r = Math.random() * total;
  let pick = cats[0];
  for (const c of cats) {
    r -= BANK_WEIGHTS[c];
    if (r <= 0) {
      pick = c;
      break;
    }
  }
  const res = localProvider.getQuestions({ count: 1, categories: [pick], excludeIds: askedIds });
  return res[0] || null;
}

// Family mode: baked-in banks are tagged kid_safe; live API questions get a
// profanity prefilter as a second line of defense.
const FAMILY_BLOCK = /\b(damn|bitch|bastard|shit|fuck|porn|nude|naked|cocaine|marijuana|whore|slut)\b/i;
function familyOk(q) {
  if (!db.familyMode) return true;
  if (q.kid_safe === false) return false;
  if (q.source !== 'local' && FAMILY_BLOCK.test(q.question + ' ' + (q.options || []).join(' '))) return false;
  return true;
}

// Video questions are a headline feature (Disney-heavy) — deal one directly
// about 1 in 8 draws instead of leaving them to category weighting.
const VIDEO_DRAW_CHANCE = 0.12;

function drawQuestion() {
  const askedIds = db.askedIds;
  const recent = new Set((db.recentCats || []).slice(-3));
  if (Math.random() < VIDEO_DRAW_CHANCE && !recent.has('disney')) {
    const vids = localProvider.getQuestions({ count: 1, videoOnly: true, excludeIds: askedIds });
    if (vids[0] && familyOk(vids[0])) return vids[0];
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    const avoid = new Set((db.recentCats || []).slice(-3)); // no category runs
    let q = null;

    // ~50/50 blend: live buffer first, baked-in bank is a first-class source
    if (Math.random() < 0.5) {
      const disabled = new Set(db.disabledCats || []);
      const allowed = ALL_CATS.filter((c) => !avoid.has(c) && !disabled.has(c));
      const live = remoteProvider.getQuestions({ count: 1, categories: allowed, excludeIds: askedIds });
      q = live[0] || remoteProvider.getQuestions({ count: 1, excludeIds: askedIds })[0] || null;
    }
    if (!q) q = drawBankQuestion(avoid, askedIds) || drawBankQuestion(new Set(), askedIds);
    if (!q) break;
    if (familyOk(q)) return q;
    askedIds.push(q.id); // rejected — burn the id so we don't loop on it
  }

  if (askedIds.length > 0) {
    // everything exhausted — reshuffle and try once more
    db.askedIds = [];
    db.recentCats = [];
    return drawQuestion();
  }
  return null;
}

function trackAsked(q) {
  db.askedIds.push(q.id);
  if (db.askedIds.length > MAX_ASKED_IDS) db.askedIds = db.askedIds.slice(-MAX_ASKED_IDS);
  db.recentCats.push(q.category);
  if (db.recentCats.length > 8) db.recentCats = db.recentCats.slice(-8);
  db.session.round += 1;
  db.stats.questionsAsked += 1;
}

function dealQuestion() {
  const q = drawQuestion();
  if (!q) return false;
  clearTimer();
  const secs = q.video ? VIDEO_QUESTION_SECONDS : QUESTION_SECONDS;
  db.current = {
    qid: q.id,
    category: q.category,
    difficulty: q.difficulty,
    text: q.question,
    options: q.options.slice(),
    image: q.image || null,
    video: q.video || null,
    answerIndex: q.answer,
    isWager: false,
    seconds: secs,
    endsAt: Date.now() + secs * 1000,
    answers: {},
    wagers: {},
    revealed: false,
  };
  db.phase = 'question';
  db.block.dealt += 1; // 1..9 — the 10th question of the block is the wager round
  trackAsked(q);
  questionTimer = setTimeout(() => revealQuestion(), secs * 1000 + 400);
  saveDb();
  broadcast();
  return true;
}

// Every 10th question is Final-Jeopardy style: the category is announced
// first, players wager 0..their score, then the question drops.
function startWager() {
  const q = drawQuestion();
  if (!q) return false;
  clearTimer();
  db.current = null;
  db.wager = {
    category: q.category,
    pendingQuestion: q, // stashed so the wager round can't redraw/repeat it
    endsAt: Date.now() + WAGER_SECONDS * 1000,
    wagers: {},
  };
  db.phase = 'wager';
  questionTimer = setTimeout(() => dealWagerQuestion(), WAGER_SECONDS * 1000 + 400);
  saveDb();
  broadcast();
  return true;
}

function dealWagerQuestion() {
  const w = db.wager;
  if (db.phase !== 'wager' || !w || !w.pendingQuestion) return advanceGame();
  const q = w.pendingQuestion;
  clearTimer();
  const secs = q.video ? VIDEO_QUESTION_SECONDS : QUESTION_SECONDS;
  db.current = {
    qid: q.id,
    category: q.category,
    difficulty: q.difficulty,
    text: q.question,
    options: q.options.slice(),
    image: q.image || null,
    video: q.video || null,
    answerIndex: q.answer,
    isWager: true,
    seconds: secs,
    endsAt: Date.now() + secs * 1000,
    answers: {},
    wagers: Object.assign({}, w.wagers),
    revealed: false,
  };
  db.wager = null;
  db.phase = 'question';
  db.block.dealt = BLOCK_SIZE; // the wager question closes out the block
  trackAsked(q);
  questionTimer = setTimeout(() => revealQuestion(), secs * 1000 + 400);
  saveDb();
  broadcast();
  return true;
}

function scorePoints(p, pts) {
  p.score += pts;
  p.blockScore = (p.blockScore || 0) + pts;
  if (p.score < 0) p.score = 0;
  if (p.blockScore < 0) p.blockScore = 0;
}

// Block-capping ceremony after the wager reveal: top 3 of the block.
function showPodium() {
  clearTimer();
  db.podium = { top: leaderboard('block').slice(0, 3) };
  db.phase = 'podium';
  db.current = null;
  saveDb();
  broadcast();
  if (db.autoPilot) {
    questionTimer = setTimeout(() => {
      db.podium = null;
      for (const p of Object.values(db.players)) p.blockScore = 0;
      db.block.number += 1;
      db.block.dealt = 0;
      saveDb();
      advanceGame();
    }, PODIUM_SECONDS * 1000);
  }
  return true;
}

// The always-on heartbeat: decide what comes next.
function advanceGame() {
  clearTimer();
  db.current = null;
  db.wager = null;
  db.podium = null;
  if (db.block.dealt >= BLOCK_SIZE) {
    // wager round was dealt but the host skipped ahead — close the block out
    return showPodium();
  }
  if (db.block.dealt >= BLOCK_SIZE - 1) return startWager();
  return dealQuestion();
}

function revealQuestion() {
  const c = db.current;
  if (db.phase !== 'question' || !c || c.revealed) return false;
  clearTimer();
  c.revealed = true;
  const total = c.seconds * 1000;
  for (const [pid, a] of Object.entries(c.answers)) {
    const p = db.players[pid];
    if (!p) continue;
    p.answered += 1;
    p.lastSeen = Date.now();
    const wager = (c.wagers && c.wagers[pid]) || 0;
    if (a.choice === c.answerIndex) {
      const speed = Math.max(0, Math.min(1, (c.endsAt - a.at) / total));
      let pts = (BASE_POINTS[c.difficulty] || 100) + Math.round(SPEED_BONUS_MAX * speed);
      if (c.isWager && wager > 0) {
        pts += wager;
        p.wagersWon = (p.wagersWon || 0) + 1;
      }
      a.points = pts;
      a.correct = true;
      p.correct += 1;
      scorePoints(p, pts);
    } else {
      a.correct = false;
      if (c.isWager && wager > 0) {
        a.points = -wager;
        p.wagersLost = (p.wagersLost || 0) + 1;
        scorePoints(p, -wager);
      } else {
        a.points = 0;
      }
    }
  }
  // players who wagered but never answered lose their wager
  if (c.isWager && c.wagers) {
    for (const [pid, amt] of Object.entries(c.wagers)) {
      if (c.answers[pid] || amt <= 0) continue;
      const p = db.players[pid];
      if (!p) continue;
      p.wagersLost = (p.wagersLost || 0) + 1;
      p.lastSeen = Date.now();
      scorePoints(p, -amt);
    }
  }
  db.phase = 'reveal';
  saveDb();
  broadcast();
  if (db.autoPilot) {
    clearTimer();
    const pause = c.isWager ? WAGER_REVEAL_SECONDS : REVEAL_SECONDS;
    questionTimer = setTimeout(() => (c.isWager ? showPodium() : advanceGame()), pause * 1000);
  }
  return true;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast() {
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(res);
    }
  }
}, 25000);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

async function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  if (urlPath === '/api/state' && method === 'GET') {
    return json(res, 200, publicState());
  }

  if (urlPath === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    try {
      res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
    } catch (e) { /* ignore */ }
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (urlPath === '/api/join' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad json' });
    const name = sanitizeName(body.name);
    if (!name) return json(res, 400, { error: 'name required' });
    const now = Date.now();
    let player = Object.values(db.players).find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (player) {
      // reclaim an existing record (same name = same player, new token)
      player.token = crypto.randomBytes(16).toString('hex');
      player.lastSeen = now;
    } else {
      const id = crypto.randomBytes(8).toString('hex');
      player = {
        id, name,
        token: crypto.randomBytes(16).toString('hex'),
        score: 0, blockScore: 0, correct: 0, answered: 0,
        wagersWon: 0, wagersLost: 0,
        joinedAt: now, lastSeen: now,
      };
      db.players[id] = player;
    }
    saveDb();
    broadcast();
    return json(res, 200, { playerId: player.id, token: player.token, name: player.name });
  }

  if (urlPath === '/api/answer' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad json' });
    const player = db.players[body.playerId];
    if (!player || player.token !== body.token) return json(res, 401, { error: 'unknown player' });
    const c = db.current;
    if (db.phase !== 'question' || !c || c.revealed) return json(res, 409, { error: 'no active question' });
    if (Date.now() > c.endsAt) return json(res, 409, { error: 'time is up' });
    if (c.answers[player.id]) return json(res, 409, { error: 'already answered' });
    const choice = body.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return json(res, 400, { error: 'bad choice' });
    c.answers[player.id] = { choice, at: Date.now() };
    player.lastSeen = Date.now();
    saveDb();
    broadcast(); // updates the "locked in" count on the TV
    return json(res, 200, { ok: true, locked: true });
  }

  if (urlPath === '/api/wager' && method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'bad json' });
    const player = db.players[body.playerId];
    if (!player || player.token !== body.token) return json(res, 401, { error: 'unknown player' });
    if (db.phase !== 'wager' || !db.wager) return json(res, 409, { error: 'no wager window' });
    if (Date.now() > db.wager.endsAt) return json(res, 409, { error: 'wagers closed' });
    let amount = Math.floor(Number(body.amount));
    if (!Number.isFinite(amount)) return json(res, 400, { error: 'bad amount' });
    amount = Math.max(0, Math.min(player.score, amount)); // 0..all-in
    db.wager.wagers[player.id] = amount; // re-sending overwrites
    player.lastSeen = Date.now();
    saveDb();
    broadcast();
    return json(res, 200, { ok: true, wager: amount });
  }

  // ---- host controls (no auth: this box is meant for a trusted home LAN) ----
  const isHost = urlPath.startsWith('/api/host/');
  if (isHost && (method === 'POST' || method === 'GET')) {
    const action = urlPath.slice('/api/host/'.length);
    if (action === 'start') {
      clearTimer();
      for (const p of Object.values(db.players)) p.blockScore = 0;
      db.session = { active: true, startedAt: Date.now(), round: 0 };
      db.block = { number: 1, dealt: 0 };
      db.current = null;
      db.wager = null;
      db.podium = null;
      const ok = dealQuestion();
      saveDb();
      return json(res, 200, { ok, state: publicState() });
    }
    if (action === 'next') {
      clearTimer();
      if (db.phase === 'question' && db.current && !db.current.revealed) {
        revealQuestion();
        // revealQuestion scheduled the autopilot follow-up; supersede it with
        // a faster advance — without this clearTimer, the orphaned timer
        // would fire advanceGame() a second time (e.g. wiping a wager round).
        clearTimer();
        questionTimer = setTimeout(() => advanceGame(), 4000);
      } else if (db.phase === 'wager') {
        dealWagerQuestion();
      } else {
        advanceGame();
      }
      saveDb();
      return json(res, 200, { ok: true, state: publicState() });
    }
    if (action === 'reveal') {
      const ok = revealQuestion();
      saveDb();
      return json(res, 200, { ok, state: publicState() });
    }
    if (action === 'reset') {
      clearTimer();
      db.phase = 'idle';
      db.current = null;
      db.wager = null;
      db.podium = null;
      db.block = { number: 1, dealt: 0 };
      db.session = { active: false, startedAt: null, round: 0 };
      for (const p of Object.values(db.players)) p.blockScore = 0;
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, state: publicState() });
    }
    if (action === 'autopilot') {
      const body = method === 'POST' ? await readBody(req) : {};
      const on = body && typeof body.on === 'boolean' ? body.on : !db.autoPilot;
      const was = db.autoPilot;
      db.autoPilot = on;
      clearTimer();
      // Just turned on mid-reveal (no timer was running while it was off):
      // resume the flow, respecting wager reveals.
      if (on && !was && db.phase === 'reveal') {
        questionTimer = setTimeout(
          () => (db.current && db.current.isWager ? showPodium() : advanceGame()),
          REVEAL_SECONDS * 1000
        );
      }
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, autoPilot: db.autoPilot });
    }
    if (action === 'family') {
      const body = method === 'POST' ? await readBody(req) : {};
      const on = body && typeof body.on === 'boolean' ? body.on : !db.familyMode;
      db.familyMode = on;
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, familyMode: db.familyMode });
    }
    if (action === 'venue') {
      const body = method === 'POST' ? await readBody(req) : {};
      const name = String((body && body.name) || '').trim().slice(0, 30);
      if (name) db.venueName = name;
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, venueName: db.venueName });
    }
    if (action === 'theme') {
      const body = method === 'POST' ? await readBody(req) : {};
      const theme = String((body && body.theme) || '');
      const valid = ['midnight-gold', 'jeopardy-blue', 'neon-arcade', 'emerald'];
      if (valid.includes(theme)) db.theme = theme;
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, theme: db.theme });
    }
    if (action === 'toggleCat') {
      const body = method === 'POST' ? await readBody(req) : {};
      const cat = String((body && body.cat) || '');
      if (cat) {
        const i = db.disabledCats.indexOf(cat);
        if (i >= 0) db.disabledCats.splice(i, 1);
        else db.disabledCats.push(cat);
      }
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, disabledCats: db.disabledCats });
    }
    return json(res, 404, { error: 'unknown host action' });
  }

  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/tv.html';
  else if (urlPath === '/play') urlPath = '/play.html';
  else if (urlPath === '/tv') urlPath = '/tv.html';
  let file;
  if (urlPath.startsWith('/lib/')) {
    file = path.normalize(path.join(ROOT, urlPath));
    if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
  } else {
    file = path.normalize(path.join(PUBLIC_DIR, urlPath));
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

loadDb();

const server = http.createServer((req, res) => {
  try {
    if (req.url.startsWith('/api/')) return void handleApi(req, res).catch((e) => {
      console.error('api error:', e.message);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    });
    serveStatic(req, res);
  } catch (e) {
    console.error('request error:', e.message);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │            CAVE TRIVIA is running            │');
  console.log('  ├──────────────────────────────────────────────┤');
  console.log('  │  TV display:   http://' + ip + ':' + PORT + '            ');
  console.log('  │  Join on phones: http://' + ip + ':' + PORT + '/play    ');
  console.log('  │  (TV shows a QR code for the join URL)       │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  console.log('  Bank: ' + localProvider.info().questions + ' baked-in questions (' + localProvider.info().categories.join(', ') + ')');
  console.log('  Live providers warming up in the background…');
  console.log('');
  // Live-first: prime the remote buffer in the background. The game works
  // immediately from the baked-in bank; live questions join the mix as they arrive.
  const log = (...args) => console.log(...args);
  remoteProvider.init(log).catch((e) => console.error('cave-trivia: remote init failed:', e.message));
  setInterval(() => {
    remoteProvider.refill(log).catch((e) => console.error('cave-trivia: remote refill failed:', e.message));
  }, 10 * 60 * 1000);
  // Always-on: the living game starts itself. No host input needed.
  if (db.autoPilot) {
    console.log('  Autopilot ON — the living game starts in 3s…');
    console.log('');
    clearTimer();
    questionTimer = setTimeout(() => advanceGame(), 3000);
  }
});

process.on('SIGINT', () => {
  clearTimer();
  saveDb();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearTimer();
  saveDb();
  process.exit(0);
});
