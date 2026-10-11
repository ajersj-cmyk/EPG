'use strict';
/*
 * Remote question provider — LIVE-FIRST trivia sources with a prefetch buffer.
 *
 * Design (live-first, never-stall):
 *   - Questions stream from live APIs at game time into an in-memory
 *     prefetch buffer (target ~40, refill when below ~15).
 *   - Sources are pulled round-robin in the background. Every fetch has an
 *     ~8s timeout; on failure we fall through to the next source. If the
 *     buffer is momentarily empty, the game engine serves the baked-in bank
 *     (local provider) instantly and the buffer keeps refilling behind it.
 *   - The game NEVER blocks on the network. If the internet drops mid-party,
 *     play continues seamlessly from the baked-in bank.
 *   - jservice is attempted exactly ONCE at startup (opportunistic bulk
 *     import). It was unreachable in testing — a failure is logged and
 *     silently skipped; the game does not depend on it.
 *
 * Sources (all keyless, no auth):
 *   1. The Trivia API (https://the-trivia-api.com) — the 90s workhorse.
 *      ?tags=1990's returns genuine 90s questions. Categories rotate across
 *      calls. Non-commercial home use.
 *   2. Open Trivia DB (https://opentdb.com) — free, no key. HARD RULE:
 *      max 1 request per 5 seconds per IP (serialized through a throttle),
 *      session tokens used to avoid repeats. Responses are HTML-entity
 *      encoded — decoded at ingest. License CC BY-SA 4.0 (attributed in
 *      the app footer and README).
 *   3. jservice (https://jservice.io) — 150k+ Jeopardy! clues; filtered to
 *      1990-1999 air dates. Quirk: their "question" field is the clue and
 *      "answer" is the response, so we use clue-as-question and generate
 *      3 distractors from other answers in the same category.
 *
 * Interface (same as local provider):
 *   getQuestions({ count, categories, difficulty, excludeIds }) -> Question[]
 * plus:
 *   init(log)    — one-shot startup: jservice attempt + initial buffer fill
 *                  (call once, do NOT await before listening)
 *   refill(log)  — background buffer top-up (safe to call any time)
 *   info()       — { name, buffered, sources }
 */

const https = require('https');

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const ENTITY_MAP = {
  quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', uuml: 'ü', ntilde: 'ñ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  hellip: '…', mdash: '—', ndash: '–',
};

function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (_, name) => (ENTITY_MAP[name] !== undefined ? ENTITY_MAP[name] : '&' + name + ';'));
}

function fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'cave-trivia/1.0 (private home LAN party box)',
          Accept: 'application/json',
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url.split('?')[0]));
          return;
        }
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > 3_000_000) {
            req.destroy(new Error('response too large'));
          }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('invalid JSON from ' + url.split('?')[0]));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')));
  });
}

// ---------------------------------------------------------------------------
// buffer state
// ---------------------------------------------------------------------------

const BUFFER_TARGET = 40;
const BUFFER_LOW = 15;

let buffer = []; // normalized Question[] waiting to be drawn
const seenIds = new Set(); // dedupe across refills
let refilling = false;
let sourceCursor = 0;

// ---------------------------------------------------------------------------
// source 1: The Trivia API (90s workhorse)
// ---------------------------------------------------------------------------

const TTA_CATEGORY_GROUPS = [
  'music,film_and_tv,sport_and_leisure',
  'general_knowledge,geography,history',
  'arts_and_literature,science,society_and_culture,food_and_drink',
];
let ttaGroupCursor = 0;

function mapTtaCategory(c) {
  const m = {
    music: 'music',
    film_and_tv: 'movies',
    sport_and_leisure: 'sports',
  };
  return m[c] || 'mixed';
}

async function fetchTheTriviaApi() {
  const cats = TTA_CATEGORY_GROUPS[ttaGroupCursor++ % TTA_CATEGORY_GROUPS.length];
  const url =
    'https://the-trivia-api.com/v2/questions?limit=50&categories=' +
    cats +
    '&tags=' +
    encodeURIComponent("1990's");
  const data = await fetchJson(url);
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const q of data) {
    if (!q || !q.question || !q.question.text || !q.correctAnswer) continue;
    const incorrect = (q.incorrectAnswers || []).filter((a) => a && a !== q.correctAnswer).slice(0, 3);
    if (incorrect.length < 3) continue;
    const options = shuffleInPlace([q.correctAnswer, ...incorrect]);
    out.push({
      id: 'tta-' + hashStr(q.question.text + '|' + q.correctAnswer),
      category: mapTtaCategory(q.category),
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      question: q.question.text.trim(),
      options: options.map((s) => String(s).trim()),
      answer: options.indexOf(q.correctAnswer),
      source: 'the-trivia-api',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// source 2: Open Trivia DB (serialized: max 1 request / 5s)
// ---------------------------------------------------------------------------

const OTDB_CATS = [15, 21, 32, 11, 14, 12, 26]; // games, sports, cartoons, film, tv, music, celebrities
const OTDB_CAT_MAP = { 15: 'games', 21: 'sports', 32: 'toons', 11: 'movies', 14: 'tv', 12: 'music', 26: 'mixed' };
let otdbCatCursor = 0;
let otdbToken = null;
let otdbLastAt = 0;

async function otdbThrottle() {
  const wait = 5200 - (Date.now() - otdbLastAt);
  if (wait > 0) await sleep(wait);
  otdbLastAt = Date.now();
}

async function otdbEnsureToken() {
  if (otdbToken) return;
  const data = await fetchJson('https://opentdb.com/api_token.php?command=request');
  if (data && data.token) otdbToken = data.token;
}

async function fetchOpenTdb() {
  await otdbEnsureToken().catch(() => {});
  const cat = OTDB_CATS[otdbCatCursor++ % OTDB_CATS.length];
  await otdbThrottle();
  let url = 'https://opentdb.com/api.php?amount=50&category=' + cat + '&type=multiple';
  if (otdbToken) url += '&token=' + encodeURIComponent(otdbToken);
  const data = await fetchJson(url);
  if (!data || data.response_code === 4) {
    // token empty — reset it and retry once without token
    otdbToken = null;
    await otdbThrottle();
    const retry = await fetchJson('https://opentdb.com/api.php?amount=50&category=' + cat + '&type=multiple');
    return normalizeOtdb(retry, cat);
  }
  return normalizeOtdb(data, cat);
}

function normalizeOtdb(data, cat) {
  if (!data || !Array.isArray(data.results)) return [];
  const out = [];
  for (const q of data.results) {
    if (!q || !q.question || !q.correct_answer) continue;
    const correct = decodeEntities(q.correct_answer).trim();
    const incorrect = (q.incorrect_answers || []).map((a) => decodeEntities(a).trim()).filter((a) => a && a !== correct);
    if (incorrect.length < 3) continue;
    const options = shuffleInPlace([correct, ...incorrect.slice(0, 3)]);
    out.push({
      id: 'otdb-' + cat + '-' + hashStr(q.question + '|' + correct),
      category: OTDB_CAT_MAP[cat] || 'mixed',
      difficulty: ['easy', 'medium', 'hard'].includes(q.difficulty) ? q.difficulty : 'medium',
      question: decodeEntities(q.question).trim(),
      options,
      answer: options.indexOf(correct),
      source: 'opentdb',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// source 3: jservice 90s bulk import (ONE attempt at startup, opportunistic)
// ---------------------------------------------------------------------------

function mapJserviceCategory(title) {
  const t = String(title || '').toLowerCase();
  if (/movie|film|cinema|oscar|actor|actress|hollywood/.test(t)) return 'movies';
  if (/music|song|band|rock|pop|rap|hip-hop|billboard/.test(t)) return 'music';
  if (/\btv\b|television|sitcom|show|series|network/.test(t)) return 'tv';
  if (/sport|baseball|football|basketball|olympic|hockey|tennis|golf|boxing/.test(t)) return 'sports';
  if (/game|nintendo|sega|playstation|arcade|video/.test(t)) return 'games';
  if (/toy|cartoon|disney|nickelodeon|kids/.test(t)) return 'toys';
  return 'mixed';
}

async function fetchJserviceOnce(log) {
  // Single bulk import. jservice uptime is spotty — any failure is swallowed.
  const url =
    'https://jservice.io/api/clues?min_date=1990-01-01T00:00:00.000Z&max_date=1999-12-31T23:59:59.000Z';
  let clues;
  try {
    clues = await fetchJson(url, 10000);
  } catch (e) {
    log('cave-trivia: jservice unreachable (' + e.message + ') — skipping, game continues without it.');
    return [];
  }
  if (!Array.isArray(clues) || clues.length === 0) {
    log('cave-trivia: jservice returned nothing usable — skipping.');
    return [];
  }
  // pool answers by category for distractor generation
  const answersByCat = new Map();
  const clean = [];
  for (const c of clues) {
    if (!c || !c.question || !c.answer) continue;
    const clue = decodeEntities(String(c.question)).trim();
    const resp = decodeEntities(String(c.answer)).trim();
    if (!clue || !resp || resp.length > 80) continue;
    const cat = mapJserviceCategory(c.category && c.category.title);
    clean.push({ clue, resp, cat, value: c.value });
    if (!answersByCat.has(cat)) answersByCat.set(cat, []);
    answersByCat.get(cat).push(resp);
  }
  const out = [];
  for (const { clue, resp, cat, value } of clean) {
    const pool = (answersByCat.get(cat) || []).filter((a, i, arr) => a !== resp && arr.indexOf(a) === i);
    shuffleInPlace(pool);
    const distractors = pool.slice(0, 3);
    if (distractors.length < 3) continue;
    const options = shuffleInPlace([resp, ...distractors]);
    const difficulty = value == null ? 'medium' : value <= 400 ? 'easy' : value <= 800 ? 'medium' : 'hard';
    out.push({
      id: 'jsv-' + hashStr(clue + '|' + resp),
      category: cat,
      difficulty,
      question: clue,
      options,
      answer: options.indexOf(resp),
      source: 'jservice',
    });
  }
  log('cave-trivia: jservice bulk import added ' + out.length + ' questions.');
  return out;
}

// ---------------------------------------------------------------------------
// buffer management
// ---------------------------------------------------------------------------

const ROUND_ROBIN_SOURCES = [
  { name: 'the-trivia-api', fetch: fetchTheTriviaApi },
  { name: 'opentrivia', fetch: fetchOpenTdb },
];

async function refill(log) {
  if (typeof log !== 'function') log = console.log;
  if (refilling) return;
  refilling = true;
  try {
    for (let i = 0; i < ROUND_ROBIN_SOURCES.length && buffer.length < BUFFER_TARGET; i++) {
      const source = ROUND_ROBIN_SOURCES[sourceCursor++ % ROUND_ROBIN_SOURCES.length];
      let batch = [];
      try {
        batch = await source.fetch();
      } catch (e) {
        log('cave-trivia: ' + source.name + ' fetch failed (' + e.message + ') — trying next source.');
      }
      for (const q of batch) {
        if (q && q.id && !seenIds.has(q.id)) {
          seenIds.add(q.id);
          buffer.push(q);
        }
      }
    }
    // keep the seen-set bounded on very long uptimes
    if (seenIds.size > 20000) {
      seenIds.clear();
      for (const q of buffer) seenIds.add(q.id);
    }
    if (buffer.length < BUFFER_LOW) {
      log('cave-trivia: live buffer low (' + buffer.length + ') — game will use the baked-in bank as needed.');
    }
  } finally {
    refilling = false;
  }
}

async function init(log) {
  if (typeof log !== 'function') log = console.log;
  // One-shot startup: opportunistic jservice import, then start filling.
  // Never awaited before listen() — the game works from the baked-in bank
  // until live questions arrive.
  const jsv = await fetchJserviceOnce(log);
  for (const q of jsv) {
    if (!seenIds.has(q.id)) {
      seenIds.add(q.id);
      buffer.push(q);
    }
  }
  await refill(log);
  log('cave-trivia: live buffer primed with ' + buffer.length + ' questions.');
}

// ---------------------------------------------------------------------------
// provider interface
// ---------------------------------------------------------------------------

function getQuestions({ count = 1, categories = [], difficulty = null, excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds || []);
  const pool = buffer.filter((q) => {
    if (excluded.has(q.id)) return false;
    if (categories && categories.length > 0 && !categories.includes(q.category)) return false;
    if (difficulty && q.difficulty !== difficulty) return false;
    return true;
  });
  shuffleInPlace(pool);
  const picked = pool.slice(0, Math.max(0, count));
  // consume from the buffer (non-repeating)
  if (picked.length > 0) {
    const pickedIds = new Set(picked.map((q) => q.id));
    buffer = buffer.filter((q) => !pickedIds.has(q.id));
  }
  // top up in the background when running low — never blocks the caller
  if (buffer.length < BUFFER_LOW) {
    refill().catch(() => {});
  }
  return picked.map((q) => ({ ...q, options: q.options.slice() }));
}

function info() {
  return {
    name: 'remote-live',
    buffered: buffer.length,
    sources: ['the-trivia-api (90s tags)', 'opentrivia (throttled, session token)', 'jservice 90s (startup-only, opportunistic)'],
  };
}

module.exports = { getQuestions, init, refill, info };
