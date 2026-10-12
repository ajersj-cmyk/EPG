'use strict';
/*
 * Cave Trivia — daily fresh-question ingest.
 *
 * Pulls ~100 new questions a day into data/questions-daily.json:
 *   1. Quizbowl tossups (qbreader API, no key) → converted to 4-option MCQ.
 *      Dozen-adjacent flavor: Trash (pop culture/sports), Current Events, etc.
 *   2. Wikimedia Commons picture questions ("Who is pictured?") — endless,
 *      openly licensed, generated from Commons sports-photo categories.
 *   3. Open Trivia DB top-up (respects the 5s/request throttle).
 *
 * Dedupes against every bank + the existing daily bank, caps the daily bank
 * at 3000 (oldest rotate out). Safe to run via cron:
 *
 *   0 6 * * * cd /path/to/cave-trivia && node scripts/fetch-daily.js >> data/ingest.log 2>&1
 *
 * Usage: node scripts/fetch-daily.js [--count N] [--dry]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DAILY_PATH = path.join(DATA_DIR, 'questions-daily.json');
const DAILY_CAP = 3000;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const countIdx = args.indexOf('--count');
const TARGET = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) || 100 : 100;

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function fetchJson(url, timeoutMs = 15000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'cave-trivia-daily/1.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJson(res.headers.location, timeoutMs, headers));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('bad json from ' + url)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + url)); });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ---------------------------------------------------------------------------
// existing banks (for dedupe)
// ---------------------------------------------------------------------------

function loadBank(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), 'utf8')); }
  catch (e) { return []; }
}

function existingNorms() {
  const set = new Set();
  for (const f of ['questions.json', 'questions-pokemon.json', 'questions-disney.json', 'questions-parks.json', 'questions-video.json', 'questions-daily.json']) {
    for (const q of loadBank(f)) set.add(norm(q.question));
  }
  return set;
}

// ---------------------------------------------------------------------------
// source 1: quizbowl tossups -> MCQ
// ---------------------------------------------------------------------------

const QB_CAT_MAP = [
  [/sport|football|baseball|basketball|hockey|soccer|tennis|golf|olympic|wrestling/i, 'sports'],
  [/music|song|band|album/i, 'music'],
  [/film|movie|cinema/i, 'movies'],
  [/television|^tv$/i, 'tv'],
  [/video ?game|gaming/i, 'games'],
];

function qbCategory(subcat, cat) {
  const s = (subcat || '') + ' ' + (cat || '');
  for (const [re, slug] of QB_CAT_MAP) if (re.test(s)) return slug;
  return 'mixed';
}

function cleanAnswer(a) {
  let s = String(a || '').trim();
  s = s.split('(')[0].split('[')[0].trim(); // drop "(accept ...)" alternates
  s = s.replace(/\s+/g, ' ');
  return s;
}

// Tossups build hard→easy, so the giveaway lives at the END. Take the last
// ~300 chars cut at a sentence boundary: the most answerable chunk.
function tossupGiveaway(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 320) return t;
  const tail = t.slice(-320);
  const m = tail.match(/[.!?]\s+[A-Z0-9"']/);
  const chunk = m ? tail.slice(tail.indexOf(m[0]) + m[0].length - 1).trim() : tail.trim();
  return '⚡ ' + chunk;
}

// Shared tossup -> MCQ converter. `catFn` maps a tossup to our category;
// `poolFn` (optional) picks the distractor pool — defaults to catFn.
function convertTossups(tossups, n, idPrefix, catFn, log, label, poolFn) {
  const out = [];
  const poolKey = poolFn || catFn;
  const clean = tossups.filter((t) => {
    const a = cleanAnswer(t.answer_sanitized || t.answer);
    return a && a.length >= 2 && a.length <= 60 && !/[*_<>]/.test(a);
  });
  const byCat = {};
  const allAnswers = [];
  for (const t of clean) {
    const a = cleanAnswer(t.answer_sanitized || t.answer);
    const c = poolKey(t.subcategory, t.category);
    (byCat[c] = byCat[c] || []).push(a);
    allAnswers.push(a);
  }
  for (const t of clean) {
    if (out.length >= n) break;
    const answer = cleanAnswer(t.answer_sanitized || t.answer);
    const cat = catFn(t.subcategory, t.category);
    // same-flavor distractors first, then top up from the broader pool
    const fine = (byCat[poolKey(t.subcategory, t.category)] || []).filter((a) => norm(a) !== norm(answer));
    shuffleInPlace(fine);
    const broad = shuffleInPlace(allAnswers.filter((a) => norm(a) !== norm(answer) && !fine.includes(a)));
    const distract = [...fine, ...broad].slice(0, 3);
    if (distract.length < 3) continue;
    const options = shuffleInPlace([answer, ...distract]);
    out.push({
      id: idPrefix + hashStr(answer + t.question_sanitized),
      category: cat,
      difficulty: t.difficulty <= 2 ? 'easy' : t.difficulty === 3 ? 'medium' : 'hard',
      question: tossupGiveaway(t.question_sanitized || t.question),
      options,
      answer: options.indexOf(answer),
      kid_safe: true,
      source: 'quizbowl',
    });
  }
  log('  ' + label + ': ' + out.length + ' converted');
  return out;
}

async function fetchQuizbowl(n, log) {
  try {
    const data = await fetchJson(
      'https://www.qbreader.org/api/random-tossup?number=' + Math.min(100, n + 20) + '&difficulties=1,2,3,4'
    );
    return convertTossups(data.tossups || [], n, 'daily-qb-', qbCategory, log, 'quizbowl');
  } catch (e) {
    log('  quizbowl FAILED: ' + e.message);
    return [];
  }
}

// Dozen-flavor goldmine: quizbowl's "Pop Culture" category is human-written
// sports / movies / TV / music / pop-culture questions. We over-fetch and
// filter client-side since Pop Culture is a small slice of the database.
const POP_CULTURE_MAP = [
  [/sport|football|baseball|basketball|hockey|soccer|olympic|wrestling|golf|tennis/i, 'sports'],
  [/film|movie|cinema/i, 'movies'],
  [/television|^tv$|sitcom/i, 'tv'],
  [/music|song|band|album|rapper/i, 'music'],
  [/video ?game|gaming/i, 'games'],
  [/comic|superhero/i, 'toons'],
];

function popCultureCategory(subcat) {
  const s = subcat || '';
  for (const [re, slug] of POP_CULTURE_MAP) if (re.test(s)) return slug;
  return 'mixed';
}

async function fetchQuizbowlPopCulture(n, log) {
  try {
    const all = [];
    // Pop Culture is ~5-10% of the db; pull 2x100 and filter
    for (let r = 0; r < 2; r++) {
      const data = await fetchJson(
        'https://www.qbreader.org/api/random-tossup?number=100&difficulties=1,2,3'
      );
      all.push(...(data.tossups || []));
      await sleep(800);
    }
    const pop = all.filter((t) => t.category === 'Pop Culture');
    log('  pop-culture: ' + pop.length + ' candidates from ' + all.length + ' tossups');
    // distractors pooled across all pop culture (same flavor); the question
    // keeps its fine-grained sports/movies/tv/music category
    return convertTossups(pop, n, 'daily-qbpop-', popCultureCategory, log, 'quizbowl-pop', () => 'pop');
  } catch (e) {
    log('  quizbowl-pop FAILED: ' + e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// source 2: Wikimedia Commons picture questions ("Who is pictured?")
// ---------------------------------------------------------------------------

const PICTURE_CATS = [
  { commons: 'Category:National Football League players', label: 'NFL' },
  { commons: 'Category:National Basketball Association players', label: 'NBA' },
  { commons: 'Category:Major League Baseball players', label: 'MLB' },
];

const JUNK_FILE = /logo|stadium|field|trophy|team photo|draft|cheerleader|mascot|jersey(?!\s*\d)|\bpress\b/i;

function parseAthleteName(title) {
  let s = String(title || '').replace(/^File:/i, '');
  s = s.replace(/\.(jpe?g|png|webp|gif|svg)$/i, '');
  s = s.replace(/\s*\(.*?\)\s*/g, ' ');      // parentheticals
  s = s.replace(/^\d+[\s._-]+/, '');          // leading catalog numbers
  s = s.replace(/[\s._-]+(19|20)\d{2}.*$/, ''); // trailing years ("in 2026", "2019")
  s = s.replace(/\s+(in|at|during|from)$/i, ''); // dangling preposition left by year-strip
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+-\s+.*$/, '');            // "Name - description"
  if (s.length < 4 || s.length > 42) return null;
  if (/\d/.test(s)) return null;
  if (!/^[A-Z][a-z]+ [A-Z]/.test(s)) return null; // "Firstname Lastname"
  return s;
}

async function fetchCommonsMembers(commonsCat, log) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers' +
    '&cmtitle=' + encodeURIComponent(commonsCat) +
    '&cmtype=file&cmlimit=500&format=json&formatversion=2';
  const data = await fetchJson(url);
  return (data.query && data.query.categorymembers) || [];
}

async function fetchPictures(n, log) {
  const out = [];
  const perCat = Math.max(4, Math.ceil(n / PICTURE_CATS.length));
  for (const { commons, label } of PICTURE_CATS) {
    try {
      const members = await fetchCommonsMembers(commons, log);
      const names = [];
      for (const m of shuffleInPlace(members)) {
        if (JUNK_FILE.test(m.title)) continue;
        const name = parseAthleteName(m.title);
        if (name && !names.some((x) => x.name === name)) {
          names.push({ name, file: m.title.replace(/^File:/i, '') });
        }
        if (names.length >= perCat + 3) break;
      }
      for (let i = 0; i < Math.min(perCat, names.length); i++) {
        const distract = names.filter((_, j) => j !== i).slice(0, 3);
        if (distract.length < 3) continue;
        const options = shuffleInPlace([names[i].name, ...distract.map((d) => d.name)]);
        out.push({
          id: 'daily-pic-' + hashStr(names[i].file),
          category: 'sports',
          difficulty: 'medium',
          question: 'Who is pictured? (' + label + ')',
          options,
          answer: options.indexOf(names[i].name),
          image: 'https://commons.wikimedia.org/wiki/Special:FilePath/' +
            encodeURIComponent(names[i].file) + '?width=900',
          kid_safe: true,
          source: 'wikimedia',
        });
      }
      log('  pictures ' + label + ': ' + names.length + ' candidates');
    } catch (e) {
      log('  pictures ' + label + ' FAILED: ' + e.message);
    }
    await sleep(1200);
  }
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// source 3: Open Trivia DB top-up (5s throttle — hard rule)
// ---------------------------------------------------------------------------

const OTDB_CAT = {
  'Sports': 'sports', 'Video Games': 'games', 'Board Games': 'games',
  'Film': 'movies', 'Television': 'tv', 'Music': 'music',
  'Cartoons & Animations': 'toons', 'Celebrities': 'mixed',
  'General Knowledge': 'mixed', 'History': 'mixed', 'Geography': 'mixed',
  'Science & Nature': 'mixed', 'Animals': 'mixed', 'Vehicles': 'mixed',
  'Comics': 'mixed', 'Gadgets': 'mixed', 'Japanese Anime & Manga': 'toons',
  'Mythology': 'mixed', 'Art': 'mixed', 'Books': 'mixed',
};

async function fetchOTDB(n, log) {
  const out = [];
  try {
    let token = '';
    try {
      const t = await fetchJson('https://opentdb.com/api_token.php?command=request');
      token = (t && t.token) || '';
    } catch (e) { /* non-fatal */ }
    for (let fetched = 0; fetched < n; fetched += 10) {
      if (fetched > 0) await sleep(5200);
      const url = 'https://opentdb.com/api.php?amount=10&type=multiple' + (token ? '&token=' + token : '');
      const data = await fetchJson(url);
      for (const r of data.results || []) {
        const options = shuffleInPlace([r.correct_answer, ...(r.incorrect_answers || [])].map(decodeEntities));
        const correct = decodeEntities(r.correct_answer);
        out.push({
          id: 'daily-otdb-' + hashStr(decodeEntities(r.question)),
          category: OTDB_CAT[r.category] || 'mixed',
          difficulty: r.difficulty === 'hard' ? 'hard' : r.difficulty === 'medium' ? 'medium' : 'easy',
          question: decodeEntities(r.question),
          options,
          answer: options.indexOf(correct),
          kid_safe: true,
          source: 'otdb',
        });
      }
    }
    log('  otdb: ' + out.length + ' fetched');
  } catch (e) {
    log('  otdb FAILED: ' + e.message);
  }
  return out.slice(0, n);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const log = (...a) => console.log('[ingest]', ...a);
  log('target ~' + TARGET + ' questions' + (DRY ? ' (dry run)' : ''));

  const known = existingNorms();
  const fresh = [];
  const seen = new Set();

  const nQb = Math.round(TARGET * 0.35);
  const nPop = Math.round(TARGET * 0.3);
  const nPic = Math.round(TARGET * 0.2);
  const nOtdb = TARGET - nQb - nPop - nPic;

  const batches = await Promise.all([
    fetchQuizbowl(nQb, log),
    fetchQuizbowlPopCulture(nPop, log),
    fetchPictures(nPic, log),
    fetchOTDB(nOtdb, log),
  ]);

  for (const q of batches.flat()) {
    const k = norm(q.question);
    if (!k || known.has(k) || seen.has(k)) continue;
    if (!Array.isArray(q.options) || q.options.length !== 4) continue;
    if (q.answer < 0 || q.answer > 3) continue;
    seen.add(k);
    known.add(k);
    fresh.push(q);
  }

  log('new unique questions: ' + fresh.length);
  if (DRY || fresh.length === 0) {
    if (fresh.length > 0) log('sample: ' + JSON.stringify(fresh[0]).slice(0, 200));
    return;
  }

  let daily = loadBank('questions-daily.json');
  if (!Array.isArray(daily)) daily = [];
  daily = daily.concat(fresh);
  if (daily.length > DAILY_CAP) daily = daily.slice(daily.length - DAILY_CAP);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DAILY_PATH, JSON.stringify(daily, null, 2));
  log('daily bank now holds ' + daily.length + ' questions');
}

main().catch((e) => {
  console.error('[ingest] fatal:', e.message);
  process.exit(1);
});
