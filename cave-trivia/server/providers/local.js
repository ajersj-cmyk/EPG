'use strict';
/*
 * Local question provider — serves the baked-in 90s question bank.
 *
 * This module implements the provider interface used by the game engine:
 *
 *   getQuestions({ count, categories, difficulty, excludeIds }) -> Question[]
 *
 *   - count:       maximum number of questions to return (default 1)
 *   - categories:  array of category slugs to include; empty = all
 *   - difficulty:  'easy' | 'medium' | 'hard' | null (null = any)
 *   - excludeIds:  question ids to skip (used for non-repeating draws)
 *
 * A Question looks like:
 *   { id, category, difficulty, question, options[4], answer, source }
 * where `answer` is the index (0-3) of the correct entry in `options`,
 * and `source` is a short string naming where the question came from.
 *
 * The game engine (server.js) must ONLY talk to providers through this
 * interface — it never reads the bank file directly. To add another source
 * (e.g. a live trivia API), implement the same interface in a new module
 * under server/providers/ and register it in server.js.
 */

/*
 * The baked-in bank is a FIRST-CLASS provider (not just a failure fallback).
 * It holds dedicated collections for the topics live APIs can't filter —
 * Pokémon, Disney animated films, Disney parks — plus the core 90s sets.
 * The game engine blends these with live questions every round, weighted
 * toward the household's favorite topics.
 */
function loadBank(rel) {
  try {
    return require(rel);
  } catch (e) {
    return []; // e.g. questions-daily.json before the first ingest run
  }
}

// Drop questions whose local image file is missing (e.g. mashups not yet
// generated on this host) so the TV never shows a broken image.
function withValidImages(questions) {
  const path = require('path');
  const fs = require('fs');
  return questions.filter(q => {
    if (typeof q.image === 'string' && q.image.startsWith('/')) {
      const full = path.join(__dirname, '..', '..', 'public', q.image.slice(1));
      if (!fs.existsSync(full)) return false;
    }
    return true;
  });
}

const BANK = withValidImages([
  ...loadBank('../../data/questions.json'), // core 90s sets: movies, music, tv, sports, games, toys
  ...loadBank('../../data/questions-pokemon.json'), // Pokémon: games, anime, cards
  ...loadBank('../../data/questions-disney.json'), // Disney animated films (all eras)
  ...loadBank('../../data/questions-parks.json'), // Disney parks: rides, lands, history
  ...loadBank('../../data/questions-pixar.json'), // Pixar films
  ...loadBank('../../data/questions-familymovies.json'), // family movies: Disney, DreamWorks, Illumination
  ...loadBank('../../data/questions-video.json'), // video questions (YouTube)
  ...loadBank('../../data/questions-daily.json'), // daily-fresh ingest (quizbowl, pictures, APIs)
]);

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getQuestions({ count = 1, categories = [], difficulty = null, excludeIds = [], videoOnly = false } = {}) {
  const excluded = new Set(excludeIds || []);
  const pool = BANK.filter((q) => {
    if (excluded.has(q.id)) return false;
    if (videoOnly && !q.video) return false;
    if (categories && categories.length > 0 && !categories.includes(q.category)) return false;
    if (difficulty && q.difficulty !== difficulty) return false;
    return true;
  });
  shuffleInPlace(pool);
  return pool.slice(0, Math.max(0, count)).map((q) => ({
    id: q.id,
    category: q.category,
    difficulty: q.difficulty,
    question: q.question,
    options: q.options.slice(),
    answer: q.answer,
    image: q.image || null,
    video: q.video || null,
    kid_safe: q.kid_safe !== false,
    source: 'local',
  }));
}

function info() {
  const categories = [...new Set(BANK.map((q) => q.category))].sort();
  return { name: 'local', questions: BANK.length, categories };
}

module.exports = { getQuestions, info };
