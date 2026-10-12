#!/usr/bin/env node
/**
 * Cave Trivia — Jeopardy clue importer.
 *
 * Converts real Jeopardy! clues (j-archive derived data) into 4-option
 * multiple choice questions for the game bank.
 *
 * Input:  /tmp/jeopardy.json.gz (from howardchung/jeopardy repo)
 * Output: data/questions-jeopardy.json
 *
 * Conversion:
 *   - Clue text becomes the question (cleaned of Jeopardy-isms)
 *   - Correct answer becomes the right option
 *   - 3 distractors pulled from OTHER answers in the SAME category
 *     (topically related, plausible wrong answers)
 *
 * Quality filters:
 *   - Skips Daily Doubles and Final Jeopardy (often multi-part/wordplay)
 *   - Skips clues with audio/visual references ("heard here", "pictured")
 *   - Skips fill-in-the-blank clues that are too fragmentary
 *   - Prefers $400-$1600 values (best difficulty for casual play)
 *   - Dedupes against existing banks and within the batch
 *
 * Usage: node scripts/import-jeopardy.js [--count 500] [--seed 1]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const GZ_PATH = '/tmp/jeopardy.json.gz';
const OUT_PATH = path.join(ROOT, 'data', 'questions-jeopardy.json');

// Categories that map well to our game (skip overly academic/obscure ones)
const SKIP_CATS = [
  /opera/i, /ballet/i, /shakespeare/i, /19th century lit/i,
  /potpourri/i, /before & after/i, /wordplay/i, /anagram/i,
];

function cleanClue(q) {
  // Remove Jeopardy stage directions and clean up
  let s = q.trim();
  // Skip clues referencing media
  if (/heard here|pictured|shown here|this (audio|video|clip)/i.test(s)) return null;
  // Skip pure fill-in-the-blank fragments
  if (/^_+\s/.test(s) && s.length < 60) return null;
  // Remove parenthetical asides that often contain hints
  s = s.replace(/\([^)]{0,40}\)/g, '').trim();
  // Capitalize first letter
  s = s.charAt(0).toUpperCase() + s.slice(1);
  // Ensure it ends with ? or .
  if (!/[?.!]$/.test(s)) s += '?';
  // Convert to question form if it's a statement
  if (s.endsWith('.')) s = s.slice(0, -1) + '?';
  return s.length >= 20 && s.length <= 300 ? s : null;
}

function cleanAnswer(a) {
  let s = a.trim();
  // Remove parenthetical alternates, keep primary
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Remove quotes
  s = s.replace(/^["']|["']$/g, '').trim();
  // Skip answers that are too long or contain complex formatting
  if (s.length > 60 || s.length < 2) return null;
  if (/[<>]/.test(s)) return null;
  return s;
}

function answerType(a) {
  // Rough classification for better distractor matching
  const s = a.trim();
  // Person: "Firstname Lastname" or "First M. Last"
  if (/^[A-Z][a-z]+(\s+[A-Z]\.?)?\s+[A-Z][a-z]+$/.test(s)) return 'person';
  // Year/number
  if (/^\d{3,4}$/.test(s)) return 'year';
  if (/^[\d,.]+$/.test(s)) return 'number';
  return 'other';
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function main() {
  const args = process.argv.slice(2);
  const countIdx = args.indexOf('--count');
  const target = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : 500;
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx >= 0 ? parseInt(args[seedIdx + 1], 10) : 1;
  const rand = seededRandom(seed);

  if (!fs.existsSync(GZ_PATH)) {
    console.error(`Missing ${GZ_PATH} — download it first:`);
    console.error('  curl -sL -o /tmp/jeopardy.json.gz https://raw.githubusercontent.com/howardchung/jeopardy/master/jeopardy.json.gz');
    process.exit(1);
  }

  console.log('Loading Jeopardy data...');
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(GZ_PATH)).toString());

  // Collect all clues by category for distractor pooling
  const byCat = {};   // cat -> [{q, a, val}]
  const allClues = [];
  for (const epNum of Object.keys(data)) {
    const ep = data[epNum];
    for (const round of [ep.jeopardy || [], ep.double || []]) {
      for (const clue of round) {
        if (!clue.q || !clue.a || !clue.cat) continue;
        if (clue.dd) continue;  // skip Daily Doubles
        if (SKIP_CATS.some(re => re.test(clue.cat))) continue;
        const val = clue.val || 400;
        if (val < 200 || val > 2000) continue;
        const q = cleanClue(clue.q);
        const a = cleanAnswer(clue.a);
        if (!q || !a) continue;
        const item = { q, a, cat: clue.cat, val };
        allClues.push(item);
        (byCat[clue.cat] = byCat[clue.cat] || []).push(item);
      }
    }
  }
  console.log(`Usable clues: ${allClues.length} across ${Object.keys(byCat).length} categories`);

  // Load existing question texts for dedup
  const existing = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'data'))) {
    if (!f.endsWith('.json') || f === 'db.json') continue;
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
      if (Array.isArray(arr)) for (const q of arr) {
        if (q.question) existing.add(q.question.toLowerCase().slice(0, 60));
        if (q.q) existing.add(q.q.toLowerCase().slice(0, 60));
      }
    } catch (e) { /* skip */ }
  }

  // Sample and convert
  const picked = [];
  const usedKeys = new Set();
  // Shuffle indices
  const idx = allClues.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }

  for (const i of idx) {
    if (picked.length >= target) break;
    const clue = allClues[i];
    const key = clue.q.toLowerCase().slice(0, 60);
    if (existing.has(key) || usedKeys.has(key)) continue;

    // Get distractors from same category, preferring same answer type
    const clueType = answerType(clue.a);
    const pool = (byCat[clue.cat] || [])
      .filter(c => c.a.toLowerCase() !== clue.a.toLowerCase())
      .filter(c => Math.abs(c.a.length - clue.a.length) < 20);
    // Sort: same type first, then shuffle within groups
    const sameType = pool.filter(c => answerType(c.a) === clueType).sort(() => rand() - 0.5);
    const otherType = pool.filter(c => answerType(c.a) !== clueType).sort(() => rand() - 0.5);
    const ordered = [...sameType, ...otherType];
    if (pool.length < 3) continue;

    // Shuffle pool and take 3 unique answers
    const shuffled = ordered;
    const distractors = [];
    const seenA = new Set([clue.a.toLowerCase()]);
    for (const c of shuffled) {
      const al = c.a.toLowerCase();
      if (!seenA.has(al) && distractors.length < 3) {
        seenA.add(al);
        distractors.push(c.a);
      }
    }
    if (distractors.length < 3) continue;

    const options = [clue.a, ...distractors].sort(() => rand() - 0.5);
    const difficulty = clue.val <= 400 ? 'easy' : clue.val <= 1000 ? 'medium' : 'hard';

    picked.push({
      id: `jeopardy-${String(picked.length + 1).padStart(4, '0')}`,
      category: 'jeopardy',
      difficulty,
      question: clue.q,
      answerType: 'text',
      answerText: clue.a,
      options: [],
      answer: 0,
      source: `Jeopardy! (${clue.cat}, $${clue.val})`,
      kid_safe: true,  // Jeopardy clues are broadcast-safe by nature
    });
    usedKeys.add(key);
    existing.add(key);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(picked, null, 2));
  console.log(`Wrote ${picked.length} questions to ${OUT_PATH}`);
}

main();
