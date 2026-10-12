/* Cave Trivia (web) — shared game engine.
   Game parameters are ported 1:1 from server.js. No Firebase here;
   pure logic so TV host and phone client share the same rules. */
(function () {
  'use strict';

  // ---- exact parameters from server.js ----
  var QUESTION_SECONDS = 20;
  var VIDEO_QUESTION_SECONDS = 30;
  var WAGER_SECONDS = 15;       // Final-Jeopardy style wager window
  var WAGER_REVEAL_SECONDS = 12;
  var REVEAL_SECONDS = 8;       // autopilot pause on reveal before next Q
  var PODIUM_SECONDS = 8;
  var BLOCK_SIZE = 10;          // every 10th question of a block is the wager round
  var BASE_POINTS = { easy: 100, medium: 200, hard: 300 };
  var SPEED_BONUS_MAX = 100;
  var VIDEO_DRAW_CHANCE = 0.12;

  var BANK_WEIGHTS = {
    sports: 3, games: 3, pokemon: 3,
    disney: 2.5, pixar: 2.5, parks: 2, jeopardy: 2.5,
    movies: 1.5, tv: 1.5, music: 1.5, toons: 1.5,
    toys: 1, mixed: 1,
  };
  var ALL_CATS = ['movies', 'music', 'tv', 'sports', 'games', 'toys', 'pokemon',
    'disney', 'pixar', 'parks', 'toons', 'jeopardy', 'mixed', 'marvel'];

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
    return Promise.all(parts.map(function (u) {
      return fetch(u).then(function (r) {
        if (!r.ok) throw new Error('question bank failed to load: ' + u);
        return r.json();
      });
    })).then(function (chunks) {
      return [].concat.apply([], chunks);
    });
  }

  function drawBankQuestion(bank, avoidCats, askedIds, disabled, familyMode) {
    var dis = {};
    (disabled || []).forEach(function (c) { dis[c] = true; });
    // Only consider categories that still have drawable questions. (The Node
    // server could fall back to live API providers when a small category ran
    // dry; the static web build has no such safety net, so we check first.)
    var cats = Object.keys(BANK_WEIGHTS).filter(function (c) {
      if (avoidCats[c] || dis[c]) return false;
      for (var i = 0; i < bank.length; i++) {
        var q = bank[i];
        if (q.category === c && !askedIds[q.id] && familyOk(q, familyMode)) return true;
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
      return q.category === pick && !askedIds[q.id] && familyOk(q, familyMode);
    });
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Mirror of server.js drawQuestion(): ~1-in-8 video draws, no category runs,
  // weighted bank picks, disabled-category + family filters, asked-id tracking.
  // opts: { bank, askedIds (object map), recentCats (array), disabledCats, familyMode }
  // Returns { q, askedIds, recentCats } or null.
  function drawQuestion(opts) {
    var bank = opts.bank, askedIds = opts.askedIds || {}, recentCats = opts.recentCats || [];
    var disabled = opts.disabledCats || [], familyMode = !!opts.familyMode;

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
      var q = drawBankQuestion(bank, avoid, askedIds, disabled, familyMode)
        || drawBankQuestion(bank, {}, askedIds, disabled, familyMode);
      if (!q) break;
      if (familyOk(q, familyMode)) {
        askedIds[q.id] = true;
        recentCats.push(q.category);
        if (recentCats.length > 8) recentCats = recentCats.slice(-8);
        return { q: q, askedIds: askedIds, recentCats: recentCats };
      }
      askedIds[q.id] = true; // rejected — burn the id so we don't loop on it
    }
    return null;
  }

  // Mirror of server.js revealQuestion() scoring for one answer.
  // args: { difficulty, choice, correctIndex, answeredAt, deadlineTs, seconds, wager }
  // returns { correct, points } where points may be negative (lost wager).
  function scoreAnswer(a) {
    var total = a.seconds * 1000;
    var wager = a.wager || 0;
    if (a.choice === a.correctIndex) {
      var speed = Math.max(0, Math.min(1, (a.deadlineTs - a.answeredAt) / total));
      var pts = (BASE_POINTS[a.difficulty] || 100) + Math.round(SPEED_BONUS_MAX * speed);
      if (wager > 0) pts += wager;
      return { correct: true, points: pts };
    }
    if (wager > 0) return { correct: false, points: -wager };
    return { correct: false, points: 0 };
  }

  function clampScore(s) { return Math.max(0, s); }

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

  function fmtCategory(c) { return String(c || '').replace(/-/g, ' ').toUpperCase(); }
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
    clampScore: clampScore,
    leaderboard: leaderboard,
    sanitizeName: sanitizeName,
    fmtCategory: fmtCategory,
    fmtNum: fmtNum,
    fmtDelta: fmtDelta,
    escapeHtml: escapeHtml,
  };
})();
