/* Cave Trivia (web) — shared game engine.
   Game parameters are ported 1:1 from server.js. No Firebase here;
   pure logic so TV host and phone client share the same rules. */
(function () {
  'use strict';

  // ---- exact parameters from server.js ----
  var QUESTION_SECONDS = 20;
  var VIDEO_QUESTION_SECONDS = 30;
  var WAGER_SECONDS = 15;       // Final-Jeopardy style wager window
  var WAGER_UP_SECONDS = 10;    // mid-block wager window (Q3, Q6, Q9)
  var WAGER_REVEAL_SECONDS = 12;
  var REVEAL_SECONDS = 8;       // autopilot pause on reveal before next Q
  var PODIUM_SECONDS = 8;
  var BLOCK_SIZE = 10;          // every 10th question of a block is the wager round
  var WAGER_UP_SLOTS = [3, 6, 9]; // 1-indexed: questions 3, 6, 9 are wager-up rounds
  var BASE_POINTS = 100;        // flat 100 per question
  var SPEED_BONUS_MAX = 100;
  var VIDEO_DRAW_CHANCE = 0.12;
  var LIGHTNING_SECONDS = 10;   // lightning round timer (every 4th block, Q1-Q5)
  var LIGHTNING_POINTS = 200;   // lightning round base points (double)
  var LIGHTNING_BLOCK_EVERY = 4;

  var BANK_WEIGHTS = {
    sports: 3, games: 3, pokemon: 3,
    disney: 2.5, pixar: 2.5, parks: 2, jeopardy: 2.5,
    movies: 1.5, tv: 1.5, music: 1.5, toons: 1.5,
    toys: 1, mixed: 1,
    dozen: 3, millionaire: 2.5, mario: 3, kidsmovies: 2.5,
  };
  var ALL_CATS = ['movies', 'music', 'tv', 'sports', 'games', 'toys', 'pokemon',
    'disney', 'pixar', 'parks', 'toons', 'jeopardy', 'mixed', 'marvel',
    'dozen', 'millionaire', 'mario', 'kidsmovies'];

  var FAMILY_BLOCK = /\b(damn|bitch|bastard|shit|fuck|porn|nude|naked|cocaine|marijuana|whore|slut)\b/i;

  // ---- helpers ----

  function shuffleInPlace(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function familyOk(q, familyMode) {
    if (!familyMode) return true;
    if (q.kid_safe === false) return false;
    if (FAMILY_BLOCK.test(q.question + ' ' + (q.options || []).join(' '))) return false;
    return true;
  }

  function loadBank() {
    var parts = [];
    for (var i = 1; i <= 27; i++) parts.push('data/questions-' + i + '.json');
    parts.push('data/questions-video.json');
    parts.push('data/questions-pics.json');
    parts.push('data/questions-closest.json');
    parts.push('data/questions-dozen.json');
    parts.push('data/questions-millionaire.json');
    parts.push('data/questions-jeopardy-style.json');
    parts.push('data/questions-real.json');
    parts.push('data/questions-real2.json');
    return Promise.all(parts.map(function (u) {
      // One missing/broken chunk must never take down the whole bank.
      return fetch(u).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (arr) {
        return Array.isArray(arr) ? arr : [];
      }).catch(function (e) {
        console.warn('[bank] skipped ' + u + ': ' + (e && e.message));
        return [];
      });
    })).then(function (chunks) {
      var all = [].concat.apply([], chunks);
      if (!all.length) throw new Error('question bank is empty');
      return all;
    });
  }

  function drawBankQuestion(bank, avoidCats, askedIds, disabled, familyMode, wantDiff) {
    var dis = {};
    (disabled || []).forEach(function (c) { dis[c] = true; });
    // Only consider categories that still have drawable questions. (The Node
    // server could fall back to live API providers when a small category ran
    // dry; the static web build has no such safety net, so we check first.)
    var cats = Object.keys(BANK_WEIGHTS).filter(function (c) {
      if (avoidCats[c] || dis[c]) return false;
      for (var i = 0; i < bank.length; i++) {
        var q = bank[i];
        if (q.category === c && !askedIds[q.id] && familyOk(q, familyMode) &&
            (!wantDiff || q.difficulty === wantDiff)) return true;
      }
      return false;
    });
    if (!cats.length) return null;
    var total = cats.reduce(function (s, c) { return s + BANK_WEIGHTS[c]; }, 0);
    var r = Math.random() * total, pick = cats[0];
    for (var j = 0; j < cats.length; j++) {
      r -= BANK_WEIGHTS[cats[j]];
      if (r <= 0) { pick = cats[j]; break; }
    }
    var pool = bank.filter(function (q) {
      return q.category === pick && !askedIds[q.id] && familyOk(q, familyMode) &&
        (!wantDiff || q.difficulty === wantDiff);
    });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Mirror of server.js drawQuestion(): ~1-in-8 video draws, no category runs,
  // weighted bank picks, disabled-category + family filters, asked-id tracking.
  // opts: { bank, askedIds (object map), recentCats (array), disabledCats, familyMode, hardOnly, difficulty }
  // difficulty: 'easy' | 'medium' | 'hard' — prefers questions of that difficulty tier.
  // Returns { q, askedIds, recentCats } or null.
  function drawQuestion(opts) {
    var bank = opts.bank, askedIds = opts.askedIds || {}, recentCats = opts.recentCats || [];
    var disabled = opts.disabledCats || [], familyMode = !!opts.familyMode;
    var hardOnly = !!opts.hardOnly;
    var wantDiff = opts.difficulty || null; // difficulty curve preference

    function diffOk(q) {
      if (hardOnly) return q.difficulty === 'hard';
      if (!wantDiff) return true;
      return q.difficulty === wantDiff;
    }

    function recentSet(n) {
      var s = {};
      recentCats.slice(-n).forEach(function (c) { s[c] = true; });
      return s;
    }

    // headline video draws (~1 in 8)
    if (Math.random() < VIDEO_DRAW_CHANCE && !recentSet(3).disney) {
      var vids = bank.filter(function (q) {
        return q.video && !askedIds[q.id] && familyOk(q, familyMode);
      });
      if (vids.length) {
        var v = vids[Math.floor(Math.random() * vids.length)];
        askedIds[v.id] = true;
        recentCats.push(v.category);
        return { q: v, askedIds: askedIds, recentCats: recentCats };
      }
    }

    for (var attempt = 0; attempt < 12; attempt++) {
      var avoid = recentSet(3);
      var q = drawBankQuestion(bank, avoid, askedIds, disabled, familyMode, wantDiff)
        || drawBankQuestion(bank, {}, askedIds, disabled, familyMode, wantDiff);
      if (!q) break;
      if (familyOk(q, familyMode) && diffOk(q)) {
        askedIds[q.id] = true;
        recentCats.push(q.category);
        if (recentCats.length > 8) recentCats = recentCats.slice(-8);
        return { q: q, askedIds: askedIds, recentCats: recentCats };
      }
      askedIds[q.id] = true; // rejected — burn the id so we don't loop on it
    }
    // Fallback: if no question matched the difficulty tier, try without the filter
    if (wantDiff && !hardOnly) {
      return drawQuestion({
        bank: bank, askedIds: askedIds, recentCats: recentCats,
        disabledCats: disabled, familyMode: familyMode,
      });
    }
    return null;
  }

  // Normalize text for case-insensitive answer comparison.
  // Lowercases, trims, strips punctuation, collapses whitespace.
  function normText(s) {
    return String(s || '').toLowerCase().trim()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ');
  }

  // Levenshtein edit distance between two strings.
  function levenshtein(a, b) {
    if (a === b) return 0;
    var al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    var prev = [], cur = [];
    for (var i = 0; i <= bl; i++) prev[i] = i;
    for (var j = 1; j <= al; j++) {
      cur[0] = j;
      for (var k = 1; k <= bl; k++) {
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[j - 1] === b[k - 1] ? 0 : 1));
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[bl];
  }

  // Fuzzy text match: exact after normalization, or close spelling.
  // Allows ~1 typo per 5 chars (min 1, max 4). "Massachusets" matches "Massachusetts".
  function textMatch(userText, correctText) {
    var u = normText(userText);
    var c = normText(correctText);
    if (!u || !c) return false;
    if (u === c) return true;
    // Also accept if user typed a distinctive substring (e.g. last name only)
    // — but only if it's at least 4 chars to avoid false positives.
    if (u.length >= 4 && c.indexOf(u) >= 0) return true;
    if (c.length >= 4 && u.indexOf(c) >= 0) return true;
    var dist = levenshtein(u, c);
    var allowed = Math.max(1, Math.min(4, Math.floor(Math.max(u.length, c.length) / 5)));
    return dist <= allowed;
  }

  // Returns true if this question should use text input instead of multiple choice.
  // True when: explicitly flagged, OR from a source with invented distractors
  // (Jeopardy imports, quizbowl tossups, TriviaQA all generate fake wrong answers).
  function isTextQuestion(q) {
    if (!q) return false;
    if (q.answerType === 'text') return true;
    if (q.answerType === 'choice') return false;
    if (q.category === 'jeopardy') return true;
    var src = String(q.source || '').toLowerCase();
    if (src === 'quizbowl' || src === 'triviaqa') return true;
    return false;
  }

  // Returns the correct answer text for a question.
  function answerTextOf(q) {
    if (!q) return '';
    if (q.answerText) return q.answerText;
    if (q.options && typeof q.answer === 'number') return q.options[q.answer] || '';
    return '';
  }

  // Mirror of server.js revealQuestion() scoring for one answer.
  // args: { difficulty, choice, correctIndex, textCorrect, answeredAt, deadlineTs, seconds, wager, basePoints }
  // For text questions, pass textCorrect (boolean from normText comparison) instead of choice/correctIndex.
  // basePoints overrides BASE_POINTS (used by lightning rounds).
  // returns { correct, points } where points may be negative (lost wager).
  function scoreAnswer(a) {
    var total = a.seconds * 1000;
    var wager = a.wager || 0;
    var base = (typeof a.basePoints === 'number') ? a.basePoints : cashFor(a.difficulty);
    var isCorrect = (typeof a.textCorrect === 'boolean') ? a.textCorrect : (a.choice === a.correctIndex);
    if (isCorrect) {
      // Flat cash plus a round speed tier: first third of the clock +$50, middle third +$25.
      var left = (a.deadlineTs - a.answeredAt) / total;
      var speedCash = left >= 2 / 3 ? 50 : (left >= 1 / 3 ? 25 : 0);
      var pts = base + speedCash;
      if (wager > 0) pts += wager;
      return { correct: true, points: pts, speed: speedCash };
    }
    if (wager > 0) return { correct: false, points: -wager };
    return { correct: false, points: 0 };
  }

  // True if the given 1-indexed question number in the block is a wager-up slot.
  function isWagerUpSlot(qib) {
    return WAGER_UP_SLOTS.indexOf(qib) >= 0;
  }

  // True if this block number gets a lightning round (every 4th block).
  function isLightningBlock(blockNum) {
    return blockNum > 0 && blockNum % LIGHTNING_BLOCK_EVERY === 0;
  }

  // True if this question-in-block is part of the lightning round (Q1-Q5 of a lightning block).
  function isLightningQuestion(blockNum, qib) {
    return isLightningBlock(blockNum) && qib >= 1 && qib <= 5;
  }

  function clampScore(s) { return Math.max(0, s); }
  // Cash per question: easy $100, medium/hard $200 (lightning and closest-number use $200 too).
  var CASH_EASY = 100, CASH_HARD = 200, CASH_STEP = 25;
  function cashFor(difficulty) { return difficulty === 'easy' ? CASH_EASY : CASH_HARD; }
  // Wagers are whole $25s, never more than the player's cash.
  function roundWager(w, score) {
    var cap = Math.max(0, Math.floor(Number(score) || 0));
    var n = Math.max(0, Math.min(Math.floor(Number(w) || 0), cap));
    return Math.floor(n / CASH_STEP) * CASH_STEP;
  }
  function fmtCash(n) { n = Number(n || 0); return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US'); }
  function fmtCashDelta(d) { d = Number(d || 0); return (d > 0 ? '+' : '') + fmtCash(d); }

  // Leaderboard rows from a players map. mode: 'all' | 'block'.
  function leaderboard(players, mode) {
    var rows = Object.keys(players || {}).map(function (id) {
      var p = players[id];
      return {
        id: id,
        name: p.name,
        score: mode === 'block' ? (p.blockScore || 0) : (p.score || 0),
        correct: p.correct || 0,
      };
    });
    rows.sort(function (a, b) {
      return b.score - a.score || String(a.name).localeCompare(String(b.name));
    });
    return rows;
  }

  function sanitizeName(n) {
    return String(n || '').trim().replace(/[<>&"']/g, '').slice(0, 18);
  }

  var CAT_LABELS = { disney: 'DISNEY', pixar: 'PIXAR', parks: 'DISNEY PARKS', mario: 'SUPER MARIO',
    kidsmovies: "KIDS' MOVIES", dozen: 'THE DOZEN', millionaire: 'MILLIONAIRE', jeopardy: 'JEOPARDY' };
  function fmtCategory(c) { var k = String(c || ''); return CAT_LABELS[k] || k.replace(/-/g, ' ').toUpperCase(); }
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtDelta(d) { d = Number(d || 0); return (d > 0 ? '+' : '') + fmtNum(d); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.CT = window.CT || {};
  window.CT.engine = {
    QUESTION_SECONDS: QUESTION_SECONDS,
    VIDEO_QUESTION_SECONDS: VIDEO_QUESTION_SECONDS,
    WAGER_SECONDS: WAGER_SECONDS,
    LIGHTNING_SECONDS: LIGHTNING_SECONDS,
    LIGHTNING_POINTS: LIGHTNING_POINTS,
    LIGHTNING_BLOCK_EVERY: LIGHTNING_BLOCK_EVERY,
    isLightningBlock: isLightningBlock,
    isLightningQuestion: isLightningQuestion,
    WAGER_UP_SECONDS: WAGER_UP_SECONDS,
    WAGER_UP_SLOTS: WAGER_UP_SLOTS,
    isWagerUpSlot: isWagerUpSlot,
    WAGER_REVEAL_SECONDS: WAGER_REVEAL_SECONDS,
    REVEAL_SECONDS: REVEAL_SECONDS,
    PODIUM_SECONDS: PODIUM_SECONDS,
    BLOCK_SIZE: BLOCK_SIZE,
    BASE_POINTS: BASE_POINTS,
    SPEED_BONUS_MAX: SPEED_BONUS_MAX,
    ALL_CATS: ALL_CATS,
    shuffle: shuffleInPlace,
    loadBank: loadBank,
    familyOk: familyOk,
    drawQuestion: drawQuestion,
    scoreAnswer: scoreAnswer,
    normText: normText,
    textMatch: textMatch,
    isTextQuestion: isTextQuestion,
    answerTextOf: answerTextOf,
    clampScore: clampScore,
    leaderboard: leaderboard,
    sanitizeName: sanitizeName,
    fmtCategory: fmtCategory,
    fmtNum: fmtNum,
    fmtCash: fmtCash,
    fmtCashDelta: fmtCashDelta,
    cashFor: cashFor,
    roundWager: roundWager,
    CASH_STEP: 25,
    CLOSEST_CASH: 200,
    fmtDelta: fmtDelta,
    escapeHtml: escapeHtml,
  };
})();
