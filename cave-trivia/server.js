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
const REVEAL_SECONDS = 8; // autopilot: pause on the reveal screen before next Q
const BASE_POINTS = { easy: 100, medium: 200, hard: 300 };
const SPEED_BONUS_MAX = 100;
const MAX_ASKED_IDS = 3000;

// Bank category weights — household favorites first: sports, video games,
// Pokémon, Disney films, parks, then the 90s sets and everything else.
const BANK_WEIGHTS = {
  sports: 3, games: 3, pokemon: 3,
  disney: 2.5, parks: 2,
  movies: 1.5, tv: 1.5, music: 1.5, toons: 1.5,
  toys: 1, mixed: 1,
};
const ALL_CATS = ['movies', 'music', 'tv', 'sports', 'games', 'toys', 'pokemon', 'disney', 'parks', 'toons', 'mixed'];

const localProvider = require('./server/providers/local');
const remoteProvider = require('./server/providers/remote');
const BANK_CATS = new Set(localProvider.info().categories);

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

function defaultDb() {
  return {
    players: {}, // id -> {id,name,token,score,sessionScore,correct,answered,joinedAt,lastSeen}
    askedIds: [],
    recentCats: [],
    session: { active: false, startedAt: null, round: 0 },
    phase: 'idle', // idle | question | reveal
    current: null, // {qid,category,difficulty,text,options,answerIndex,endsAt,answers,revealed}
    autoPilot: false,
  };
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
    score: mode === 'session' ? p.sessionScore : p.score,
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
    session: { active: db.session.active },
    autoPilot: db.autoPilot,
    serverTime: now,
    question: null,
    reveal: null,
    leaderboard: leaderboard('all').slice(0, 10),
    sessionBoard: leaderboard('session').slice(0, 10),
    playersTotal: Object.keys(db.players).length,
    playersActive: Object.values(db.players).filter((p) => now - (p.lastSeen || 0) < 5 * 60 * 1000).length,
    providers: { local: localProvider.info(), remote: remoteProvider.info() },
    attribution: 'Questions: Open Trivia DB · the-trivia-api.com · Jeopardy! clues via jservice',
  };
  if (c) {
    st.question = {
      id: c.qid,
      category: c.category,
      difficulty: c.difficulty,
      text: c.text,
      options: c.options.slice(),
      endsAt: c.endsAt,
      timeLeftMs: Math.max(0, c.endsAt - now),
      answeredCount: Object.keys(c.answers).length,
    };
  }
  if (db.phase === 'reveal' && c) {
    const answers = Object.values(c.answers);
    st.reveal = {
      correctIndex: c.answerIndex,
      correctText: c.options[c.answerIndex],
      answeredCount: answers.length,
      correctCount: answers.filter((a) => a.correct).length,
    };
  }
  return st;
}

// ---------------------------------------------------------------------------
// game engine + mixer
// ---------------------------------------------------------------------------

function drawBankQuestion(avoidCats, askedIds) {
  const cats = Object.keys(BANK_WEIGHTS).filter((c) => BANK_CATS.has(c) && !avoidCats.has(c));
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

function drawQuestion() {
  const askedIds = db.askedIds;
  const avoid = new Set((db.recentCats || []).slice(-3)); // no category runs
  let q = null;

  // ~50/50 blend: live buffer first, baked-in bank is a first-class source
  if (Math.random() < 0.5) {
    const allowed = ALL_CATS.filter((c) => !avoid.has(c));
    const live = remoteProvider.getQuestions({ count: 1, categories: allowed, excludeIds: askedIds });
    q = live[0] || remoteProvider.getQuestions({ count: 1, excludeIds: askedIds })[0] || null;
  }
  if (!q) q = drawBankQuestion(avoid, askedIds) || drawBankQuestion(new Set(), askedIds);

  if (!q && askedIds.length > 0) {
    // everything exhausted — reshuffle and try once more
    db.askedIds = [];
    db.recentCats = [];
    return drawQuestion();
  }
  return q;
}

function dealQuestion() {
  const q = drawQuestion();
  if (!q) return false;
  clearTimer();
  db.current = {
    qid: q.id,
    category: q.category,
    difficulty: q.difficulty,
    text: q.question,
    options: q.options.slice(),
    answerIndex: q.answer,
    endsAt: Date.now() + QUESTION_SECONDS * 1000,
    answers: {},
    revealed: false,
  };
  db.phase = 'question';
  db.session.round += 1;
  db.askedIds.push(q.id);
  if (db.askedIds.length > MAX_ASKED_IDS) db.askedIds = db.askedIds.slice(-MAX_ASKED_IDS);
  db.recentCats.push(q.category);
  if (db.recentCats.length > 8) db.recentCats = db.recentCats.slice(-8);
  questionTimer = setTimeout(() => revealQuestion(), QUESTION_SECONDS * 1000 + 400);
  saveDb();
  broadcast();
  return true;
}

function revealQuestion() {
  const c = db.current;
  if (db.phase !== 'question' || !c || c.revealed) return false;
  clearTimer();
  c.revealed = true;
  const total = QUESTION_SECONDS * 1000;
  for (const [pid, a] of Object.entries(c.answers)) {
    const p = db.players[pid];
    if (!p) continue;
    p.answered += 1;
    p.lastSeen = Date.now();
    if (a.choice === c.answerIndex) {
      const speed = Math.max(0, Math.min(1, (c.endsAt - a.at) / total));
      const pts = (BASE_POINTS[c.difficulty] || 100) + Math.round(SPEED_BONUS_MAX * speed);
      a.points = pts;
      a.correct = true;
      p.correct += 1;
      p.score += pts;
      p.sessionScore += pts;
    } else {
      a.points = 0;
      a.correct = false;
    }
  }
  db.phase = 'reveal';
  saveDb();
  broadcast();
  if (db.autoPilot) {
    clearTimer();
    questionTimer = setTimeout(() => dealQuestion(), REVEAL_SECONDS * 1000);
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
        score: 0, sessionScore: 0, correct: 0, answered: 0,
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

  // ---- host controls (no auth: this box is meant for a trusted home LAN) ----
  const isHost = urlPath.startsWith('/api/host/');
  if (isHost && (method === 'POST' || method === 'GET')) {
    const action = urlPath.slice('/api/host/'.length);
    if (action === 'start') {
      clearTimer();
      for (const p of Object.values(db.players)) p.sessionScore = 0;
      db.session = { active: true, startedAt: Date.now(), round: 0 };
      const ok = dealQuestion();
      saveDb();
      return json(res, 200, { ok, state: publicState() });
    }
    if (action === 'next') {
      clearTimer();
      if (db.phase === 'question' && db.current && !db.current.revealed) {
        revealQuestion();
        questionTimer = setTimeout(() => dealQuestion(), 4000);
      } else {
        dealQuestion();
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
      db.session = { active: false, startedAt: null, round: 0 };
      for (const p of Object.values(db.players)) p.sessionScore = 0;
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, state: publicState() });
    }
    if (action === 'autopilot') {
      const body = method === 'POST' ? await readBody(req) : {};
      const on = body && typeof body.on === 'boolean' ? body.on : !db.autoPilot;
      db.autoPilot = on;
      clearTimer();
      if (on && db.phase === 'reveal') questionTimer = setTimeout(() => dealQuestion(), REVEAL_SECONDS * 1000);
      saveDb();
      broadcast();
      return json(res, 200, { ok: true, autoPilot: db.autoPilot });
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
