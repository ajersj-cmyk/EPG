/* Cave Trivia (web) — TV display + HOST.
   THIS TAB IS THE HOST: it runs the autopilot game loop in JS and writes
   all state to Firebase Realtime Database (rooms/cave/*).
   Game parameters and flow are ported 1:1 from server.js. */
(function () {
  'use strict';

  var E = window.CT.engine;
  var $ = function (s) { return document.querySelector(s); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var ROOM = 'rooms/cave';

  var db = null;                 // firebase.database()
  var refs = {};                 // cached refs
  var bank = [];                 // question bank
  var players = {};              // local mirror of players node
  var settings = null;           // local mirror of settings node
  var serverOffset = 0;          // .info/serverTimeOffset ms

  // ---- game loop state (in-memory, like server.js db.*) ----
  var askedIds = {};             // qid -> true (this host session)
  var recentCats = [];
  var blockNum = 1;
  var blockDealt = 0;            // normal questions dealt this block (0..9); wager closes it
  var round = 0;
  var pendingWagerQ = null;      // stashed question between wager phase and deal
  var pendingWagerUp = false;    // true if pending wager is mid-block (not final)
  var pendingWagerQib = 10;     // question-in-block for pending wager
  var currentQ = null;           // {q, deadlineTs, seconds, isWager, wagers:{pid:amt}}
  var questionTimer = null;
  var statsCache = {};           // mirror of ROOM/playerStats for lifetime/month/day
  var lastPhase = '';
  var lastQid = '';
  var lastBoardJson = '';
  var lastStateDoc = null;
  var lastQuestionDoc = null;
  var lastHighlight = null;      // {type:'wager'|'streak', name, amount, ts} for attract ticker
  var lastPhaseChangeTs = Date.now();  // watchdog: when we last saw a phase change
  var lastPhaseSeen = '';

  // Watchdog: if the game gets stuck in a phase (Firebase write hung, timer lost),
  // force it forward. Runs every 5s. This is the anti-freeze safety net.
  // Also restarts the game if players are waiting but no game is running.
  setInterval(function () {
    try {
      var st = lastStateDoc;
      var waiting = activePlayerCount() > 0;
      // Players waiting but no active game: (re)start it.
      if (waiting && (!st || !st.phase || st.phase === 'idle')) {
        kickstartGame(2000);
        return;
      }
      if (!st || !st.phase) return;
      if (st.phase !== lastPhaseSeen) {
        lastPhaseSeen = st.phase;
        lastPhaseChangeTs = Date.now();
        return;
      }
      var stuckMs = Date.now() - lastPhaseChangeTs;
      var now = serverNow();
      if (st.phase === 'question' && st.deadlineTs && now > st.deadlineTs + 15000 && stuckMs > 20000) {
        console.warn('[watchdog] question stuck, forcing reveal');
        revealQuestion();
      } else if (st.phase === 'wager' && st.wagerDeadlineTs && now > st.wagerDeadlineTs + 15000 && stuckMs > 20000) {
        console.warn('[watchdog] wager stuck, forcing deal');
        dealWagerQuestion();
      } else if (st.phase === 'reveal' && stuckMs > 45000) {
        console.warn('[watchdog] reveal stuck, forcing advance');
        advanceGame();
      } else if (st.phase === 'podium' && stuckMs > 60000) {
        console.warn('[watchdog] podium stuck, forcing advance');
        advanceGame();
      }
    } catch (e) { /* watchdog never throws */ }
  }, 5000);

  function serverNow() { return Date.now() + serverOffset; }
  function clearTimer() {
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
  }

  // Players currently in the room: present flag set and seen recently.
  function activePlayerCount() {
    var now = serverNow();
    return Object.keys(players).filter(function (pid) {
      var p = players[pid];
      return p && p.present !== false && (now - (p.lastSeen || 0) < 15 * 60 * 1000);
    }).length;
  }

  // Start the game loop, de-duplicated: rapid triggers (join + watchdog)
  // must not double-start and skip a question.
  var lastKickstartTs = 0;
  function kickstartGame(delayMs) {
    var now = Date.now();
    if (now - lastKickstartTs < 10000) return;
    lastKickstartTs = now;
    console.warn('[runner] starting game');
    clearTimer();
    questionTimer = setTimeout(advanceGame, delayMs);
  }

  /* ---------------- audio : WebAudio oscillators only, zero assets ---------------- */
  var actx = null, master = null;
  var soundOn = true;
  try { soundOn = localStorage.getItem('ctv-sound') !== 'off'; } catch (e) {}

  function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') { actx.resume().catch(function () {}); } return; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = soundOn ? 0.16 : 0;
      master.connect(actx.destination);
    } catch (e) { actx = null; }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, ensureAudio, { passive: true });
  });

  function tone(freq, dur, type, delay, vol, slideTo) {
    if (!actx || !master || !soundOn) return;
    try {
      var t0 = actx.currentTime + (delay || 0);
      var o = actx.createOscillator();
      var g = actx.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.6, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) {}
  }
  function sTick() { tone(880, 0.07, 'square', 0, 0.35); }
  function sQuestionSting() { tone(659.25, 0.12, 'triangle', 0, 0.6); tone(880, 0.2, 'triangle', 0.12, 0.6); }
  function sRevealHit() { tone(160, 0.42, 'sine', 0, 0.9, 52); tone(1244, 0.09, 'triangle', 0, 0.22); }
  function sWagerSwell() {
    tone(180, 1.5, 'sawtooth', 0, 0.28, 740);
    tone(90, 1.5, 'sine', 0, 0.4, 370);
    tone(880, 0.25, 'triangle', 1.5, 0.55);
  }
  function sFanfare() {
    var seq = [523.25, 659.25, 783.99, 1046.5];
    seq.forEach(function (f, i) { tone(f, 0.16, 'triangle', i * 0.13, 0.6); });
    tone(1046.5, 0.6, 'triangle', 0.55, 0.55);
    tone(1318.5, 0.6, 'sine', 0.55, 0.3);
  }
  // rising tension sweep before a reveal lands (~1.4s)
  function sTensionRiser() {
    tone(140, 1.4, 'sawtooth', 0, 0.22, 880);
    tone(70, 1.4, 'sine', 0, 0.35, 440);
    tone(1760, 0.12, 'triangle', 1.4, 0.4);
  }
  // streak callout: ascending arp, brighter/longer with streak length
  function sStreak(n) {
    var base = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568];
    var count = Math.min(6, 3 + Math.floor((n || 3) / 5));
    for (var i = 0; i < count; i++) tone(base[i], 0.14, 'triangle', i * 0.09, 0.55);
    tone(base[count - 1] * 2, 0.5, 'sine', count * 0.09, 0.3);
  }
  // big wager win: deep hit + gold shimmer
  function sBigWin() {
    tone(98, 0.5, 'sine', 0, 0.9, 49);
    [1046.5, 1318.5, 1568, 2093].forEach(function (f, i) {
      tone(f, 0.3, 'triangle', 0.15 + i * 0.1, 0.35);
    });
  }
  // wager-risked beat: low drum + rising tension (drama either way)
  function sRiskBeat() {
    tone(82, 0.55, 'sine', 0, 0.9, 41);
    tone(164, 0.4, 'sawtooth', 0.12, 0.22, 492);
    tone(82, 0.4, 'sine', 0.65, 0.7, 55);
    tone(880, 0.22, 'triangle', 1.05, 0.4);
  }
  // streak snapped: descending line, cinematic not punishing
  function sStreakLost() {
    var seq = [523.25, 415.3, 349.23, 293.66];
    seq.forEach(function (f, i) { tone(f, 0.24, 'triangle', i * 0.17, 0.5); });
    tone(146.8, 0.7, 'sine', 0.55, 0.45, 73);
  }
  // player sendoff: warm little major arp
  function sSendoff() {
    [392, 523.25, 659.25, 783.99].forEach(function (f, i) {
      tone(f, 0.2, 'sine', i * 0.13, 0.4);
    });
  }

  /* ---------------- setup screen (first run) ---------------- */

  function showSetup() {
    $('#setupOverlay').hidden = false;
    setPhase('idle');
  }

  function wireSetup() {
    $('#btnSaveConfig').addEventListener('click', function () {
      var raw = $('#configInput').value.trim();
      var err = $('#configError');
      try {
        var cfg = JSON.parse(raw);
        if (!window.CT.config.isValid(cfg)) throw new Error('missing apiKey, projectId or databaseURL');
        window.CT.config.save(cfg);
        $('#setupOverlay').hidden = true;
        boot(cfg);
      } catch (e) {
        err.hidden = false;
        err.textContent = 'That JSON didn\u2019t parse: ' + e.message;
      }
    });
  }

  /* ---------------- game runner (no host election) ----------------
     The TV is always the game runner. Jordan's rule:
       - 0 players  -> attract mode (phase 'idle', attract loop runs)
       - 1+ players -> game runs immediately, no waiting, no election
  */

  function seedSettingsIfEmpty() {
    // first-ever boot: seed default settings if the node is empty
    refs.settings.once('value').then(function (snap) {
      if (!snap.val()) {
        refs.settings.set({
          theme: 'midnight-gold', title: 'CAVE TRIVIA',
          disabledCats: [], familyMode: false,
        });
      }
    }).catch(function () {});
  }

  function clearStaleStateOnBoot() {
    // If a previous session died mid-game, its state is stale (deadline passed).
    // Clear it so we never resume a dead question — start fresh instead.
    refs.state.once('value').then(function (snap) {
      var st = snap.val();
      var stale = st && st.phase && st.phase !== 'idle' && st.deadlineTs && (Date.now() - st.deadlineTs > 10000);
      if (stale) {
        console.warn('[runner] clearing stale state from previous session');
        return Promise.all([refs.state.remove(), refs.question.remove(), refs.reveal.remove()]).catch(function () {});
      }
    }).catch(function () {});
  }

  /* ---------------- game loop (ported from server.js) ---------------- */

  // ---- lifetime / monthly / daily stats ----
  function statsKey(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'anon';
  }
  function todayKeys() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return { month: d.getFullYear() + '-' + mm, day: d.getFullYear() + '-' + mm + '-' + dd };
  }
  // Build Firebase updates for a player's lifetime/month/day stats.
  // delta: score change (can be negative from lost wagers). correct: 1/0.
  function statsUpdatesFor(name, delta, correct, upd) {
    if (!name) return;
    var key = statsKey(name);
    var tk = todayKeys();
    var cur = statsCache[key] || {};
    var lifetime = (cur.lifetime || 0) + delta;
    var month = (cur.monthKey === tk.month ? (cur.month || 0) : 0) + delta;
    var day = (cur.dayKey === tk.day ? (cur.day || 0) : 0) + delta;
    // streaks: consecutive correct answers. Wrong answer (or no answer) resets.
    var streak = correct ? ((cur.streak || 0) + 1) : 0;
    var bestStreak = Math.max(cur.bestStreak || 0, streak);
    var base = ROOM + '/playerStats/' + key;
    upd[base + '/name'] = String(name).slice(0, 24);
    upd[base + '/lifetime'] = lifetime;
    upd[base + '/month'] = month;
    upd[base + '/monthKey'] = tk.month;
    upd[base + '/day'] = day;
    upd[base + '/dayKey'] = tk.day;
    upd[base + '/streak'] = streak;
    upd[base + '/bestStreak'] = bestStreak;
    upd[base + '/correct'] = (cur.correct || 0) + (correct ? 1 : 0);
    upd[base + '/answered'] = (cur.answered || 0) + 1;
    upd[base + '/lastSeen'] = firebase.database.ServerValue.TIMESTAMP;
  }

  function writeState(patch) {
    var base = {
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
    };
    var full = {};
    Object.keys(base).forEach(function (k) { full[k] = base[k]; });
    Object.keys(patch || {}).forEach(function (k) { full[k] = patch[k]; });
    return refs.state.update(full);
  }

  function questionDoc(q, seconds, deadlineTs, isWager) {
    var isNum = q.answerType === 'number';
    var isTxt = !isNum && E.isTextQuestion(q);
    var doc = {
      id: q.id,
      text: q.question,
      options: isTxt ? [] : (isNum ? [] : q.options.slice()),
      answerType: isNum ? 'number' : (isTxt ? 'text' : 'choice'),
      answerText: isNum ? null : (isTxt ? E.answerTextOf(q) : null),
      answerNumber: isNum ? q.answerNumber : null,
      category: q.category,
      difficulty: q.difficulty,
      image: q.image || null,
      video: q.video || null,
      isWager: !!isWager,
      isLightning: !!q._lightning,
      seconds: seconds,
      deadlineTs: deadlineTs,
    };
    return refs.question.set(doc);
  }

  // Clear per-question fields on every player record (new question = fresh).
  function clearPlayerFields() {
    var upd = {};
    Object.keys(players).forEach(function (pid) {
      upd[ROOM + '/players/' + pid + '/answer'] = null;
      upd[ROOM + '/players/' + pid + '/wager'] = 0;
      upd[ROOM + '/players/' + pid + '/wagerPlaced'] = false;
    });
    return Object.keys(upd).length ? db.ref().update(upd) : Promise.resolve();
  }

  function drawSettings() {
    return {
      disabledCats: (settings && settings.disabledCats) || [],
      familyMode: !!(settings && settings.familyMode),
    };
  }

  function dealQuestion() {
    var st = drawSettings();
    var drawn = E.drawQuestion({
      bank: bank, askedIds: askedIds, recentCats: recentCats,
      disabledCats: st.disabledCats, familyMode: st.familyMode,
    });
    if (!drawn) {
      // Bank exhausted — reset asked history and try again (allows repeats after full cycle).
      askedIds = {};
      drawn = E.drawQuestion({
        bank: bank, askedIds: askedIds, recentCats: [],
        disabledCats: st.disabledCats, familyMode: st.familyMode,
      });
      if (!drawn) return; // truly empty bank
    }
    var q = drawn.q;
    askedIds = drawn.askedIds; recentCats = drawn.recentCats;
    clearTimer();
    blockDealt += 1; // 1..9 — the 10th question of the block is the wager round
    round += 1;
    var qib = blockDealt;
    // Lightning round: every 4th block, Q1-Q5 get 10s timer and double points
    var isLightning = E.isLightningQuestion(blockNum, qib);
    if (isLightning) q._lightning = true;
    var secs = isLightning ? E.LIGHTNING_SECONDS : (q.video ? E.VIDEO_QUESTION_SECONDS : E.QUESTION_SECONDS);
    var deadlineTs = Date.now() + secs * 1000;
    currentQ = { q: q, deadlineTs: deadlineTs, seconds: secs, isWager: false, isLightning: isLightning, wagers: {} };
    clearPlayerFields().then(function () {
      return questionDoc(q, secs, deadlineTs, false);
    }).then(function () {
      return writeState({
        phase: 'question', questionInBlock: qib, blockNum: blockNum,
        round: round, deadlineTs: deadlineTs,
        wagerDeadlineTs: null, wagerCategory: null, podium: null,
      });
    }).then(function () {
      questionTimer = setTimeout(revealQuestion, secs * 1000 + 400);
    });
  }

  // Every 10th question is Final-Jeopardy style: the category is announced
  // first, players wager 0..their score, then the question drops.
  // Mid-block (Q3/Q6/Q9): "Wager Up" — same flow on a hard question, shorter window.
  function startWager(isWagerUp, qib) {
    var st = drawSettings();
    var drawn = E.drawQuestion({
      bank: bank, askedIds: askedIds, recentCats: recentCats,
      disabledCats: st.disabledCats, familyMode: st.familyMode,
      hardOnly: !!isWagerUp,
    });
    if (!drawn) {
      askedIds = {};
      drawn = E.drawQuestion({
        bank: bank, askedIds: askedIds, recentCats: [],
        disabledCats: st.disabledCats, familyMode: st.familyMode,
        hardOnly: !!isWagerUp,
      });
      if (!drawn) return;
    }
    pendingWagerQ = drawn.q;
    pendingWagerUp = !!isWagerUp;
    pendingWagerQib = qib || E.BLOCK_SIZE;
    askedIds = drawn.askedIds; recentCats = drawn.recentCats;
    clearTimer();
    var secs = isWagerUp ? E.WAGER_UP_SECONDS : E.WAGER_SECONDS;
    var deadlineTs = Date.now() + secs * 1000;
    clearPlayerFields().then(function () {
      return writeState({
        phase: 'wager', questionInBlock: pendingWagerQib, blockNum: blockNum,
        round: round, deadlineTs: null,
        wagerDeadlineTs: deadlineTs, wagerCategory: pendingWagerQ.category,
        wagerUp: !!isWagerUp,
        podium: null,
      });
    }).then(function () {
      questionTimer = setTimeout(dealWagerQuestion, secs * 1000 + 400);
    });
  }

  function dealWagerQuestion() {
    if (!pendingWagerQ) return advanceGame();
    var q = pendingWagerQ;
    var isWagerUp = pendingWagerUp;
    var qib = pendingWagerQib;
    pendingWagerQ = null;
    pendingWagerUp = false;
    clearTimer();
    var secs = q.video ? E.VIDEO_QUESTION_SECONDS : E.QUESTION_SECONDS;
    var deadlineTs = Date.now() + secs * 1000;
    // snapshot wagers players placed during the wager window
    var wagers = {};
    Object.keys(players).forEach(function (pid) {
      var w = players[pid].wager || 0;
      if (w > 0) wagers[pid] = w;
    });
    currentQ = { q: q, deadlineTs: deadlineTs, seconds: secs, isWager: true, isWagerUp: isWagerUp, wagers: wagers };
    if (!isWagerUp) {
      blockDealt = E.BLOCK_SIZE; // the final wager question closes out the block
    } else {
      blockDealt = qib; // wager-up: continue the block
    }
    round += 1;
    // clear answers but KEEP wagers for the wager question
    var upd = {};
    Object.keys(players).forEach(function (pid) {
      upd[ROOM + '/players/' + pid + '/answer'] = null;
    });
    db.ref().update(upd).then(function () {
      return questionDoc(q, secs, deadlineTs, true);
    }).then(function () {
      return writeState({
        phase: 'question', questionInBlock: qib, blockNum: blockNum,
        round: round, deadlineTs: deadlineTs,
        wagerDeadlineTs: null, wagerCategory: null, wagerUp: !!isWagerUp, podium: null,
      });
    }).then(function () {
      questionTimer = setTimeout(revealQuestion, secs * 1000 + 400);
    });
  }

  function revealQuestion() {
    if (!currentQ) return;
    clearTimer();
    var cq = currentQ;
    currentQ = null;
    var q = cq.q;
    var upd = {};
    var results = [];
    var streakCallouts = [];
    var streaksLost = [];
    var highScoreCelebrations = [];
    var correctCount = 0, answeredCount = 0;
    var isNumQ = q.answerType === 'number';
    var numAnswer = isNumQ ? Number(q.answerNumber) : NaN;
    // Closest-wins pre-pass: find the smallest absolute difference among all guesses
    var closestDiff = Infinity;
    var numGuesses = {}; // pid -> {guess, diff}
    if (isNumQ && !isNaN(numAnswer)) {
      Object.keys(players).forEach(function (pid) {
        var a = players[pid].answer;
        if (a && typeof a.number === 'number' && !isNaN(a.number)) {
          var diff = Math.abs(a.number - numAnswer);
          numGuesses[pid] = { guess: a.number, diff: diff };
          if (diff < closestDiff) closestDiff = diff;
        }
      });
    }

    Object.keys(players).forEach(function (pid) {
      var p = players[pid];
      var a = p.answer;
      var wager = (cq.wagers && cq.wagers[pid]) || 0;
      var isTextQ = !isNumQ && E.isTextQuestion(q);
      var hasAnswer = a && (isNumQ ? (typeof a.number === 'number' && !isNaN(a.number))
        : (isTextQ ? (typeof a.text === 'string' && a.text.trim() !== '') : (typeof a.choice === 'number')));
      if (!hasAnswer) {
        // wagered but never answered: lose the wager
        if (cq.isWager && wager > 0) {
          var ns = E.clampScore((p.score || 0) - wager);
          var nbs = E.clampScore((p.blockScore || 0) - wager);
          upd[ROOM + '/players/' + pid + '/score'] = ns;
          upd[ROOM + '/players/' + pid + '/blockScore'] = nbs;
          upd[ROOM + '/players/' + pid + '/wagersLost'] = (p.wagersLost || 0) + 1;
          results.push({ pid: pid, name: p.name, delta: -(p.score - ns), wager: wager, correct: false });
        }
        return;
      }
      answeredCount += 1;
      var scoreArgs = {
        difficulty: q.difficulty,
        answeredAt: a.at, deadlineTs: cq.deadlineTs, seconds: cq.seconds, wager: wager,
      };
      if (cq.isLightning) scoreArgs.basePoints = E.LIGHTNING_POINTS;
      if (isNumQ) {
        // Closest wins: tied-for-closest players win 150, everyone else gets 0
        var myDiff = (numGuesses[pid] || {}).diff;
        var isWinner = (myDiff !== undefined && myDiff === closestDiff);
        scoreArgs.textCorrect = false; // bypass normal path
        scoreArgs._closestWin = isWinner;
        scoreArgs._closestDiff = myDiff;
      } else if (isTextQ) {
        var correctText = q.answerText || q.options[q.answer] || '';
        scoreArgs.textCorrect = E.textMatch(a.text, correctText);
      } else {
        scoreArgs.choice = a.choice;
        scoreArgs.correctIndex = q.answer;
      }
      var r;
      if (isNumQ && scoreArgs._closestWin) {
        r = { correct: true, points: 150 + (wager > 0 ? wager : 0) };
      } else if (isNumQ) {
        r = { correct: false, points: 0 };
      } else {
        r = E.scoreAnswer(scoreArgs);
      }
      var delta = r.points;
      // spectacle: streak milestones + snapped streaks (from pre-update statsCache)
      var sKey = statsKey(p.name);
      var oldStreak = ((statsCache[sKey] || {}).streak || 0);
      var newStreak = r.correct ? oldStreak + 1 : 0;
      if (r.correct && p.name && (newStreak === 3 || newStreak === 5 || (newStreak >= 10 && newStreak % 5 === 0))) {
        streakCallouts.push({ name: p.name, streak: newStreak });
      }
      if (!r.correct && p.name && oldStreak >= 3) {
        streaksLost.push({ name: p.name, streak: oldStreak });
      }
      var newScore, newBlock;
      if (r.correct) {
        correctCount += 1;
        newScore = (p.score || 0) + delta;
        newBlock = (p.blockScore || 0) + delta;
        upd[ROOM + '/players/' + pid + '/correct'] = (p.correct || 0) + 1;
        if (wager > 0) upd[ROOM + '/players/' + pid + '/wagersWon'] = (p.wagersWon || 0) + 1;
      } else {
        newScore = E.clampScore((p.score || 0) + delta); // delta negative or 0
        newBlock = E.clampScore((p.blockScore || 0) + delta);
        if (wager > 0) upd[ROOM + '/players/' + pid + '/wagersLost'] = (p.wagersLost || 0) + 1;
      }
      upd[ROOM + '/players/' + pid + '/score'] = newScore;
      upd[ROOM + '/players/' + pid + '/blockScore'] = newBlock;
      upd[ROOM + '/players/' + pid + '/answered'] = (p.answered || 0) + 1;
      upd[ROOM + '/players/' + pid + '/answer'] = null;
      // lifetime / month / day running totals
      // milestone check: did day score cross a threshold? (for NEW HIGH SCORE celebration)
      var msKey = statsKey(p.name);
      var msCur = statsCache[msKey] || {};
      var msTk = todayKeys();
      var oldDay = (msCur.dayKey === msTk.day) ? (msCur.day || 0) : 0;
      var deltaScore = newScore - (p.score || 0);
      var newDay = oldDay + deltaScore;
      var MILESTONES = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
      for (var mi = 0; mi < MILESTONES.length; mi++) {
        if (oldDay < MILESTONES[mi] && newDay >= MILESTONES[mi]) {
          highScoreCelebrations.push({ name: p.name, score: MILESTONES[mi], dayTotal: newDay });
          break;
        }
      }
      statsUpdatesFor(p.name, deltaScore, r.correct, upd);
      var resEntry = {
        pid: pid, name: p.name,
        delta: newScore - (p.score || 0),
        wager: wager, correct: r.correct,
      };
      if (isNumQ && numGuesses[pid]) {
        resEntry.guess = numGuesses[pid].guess;
        resEntry.offBy = numGuesses[pid].diff;
      }
      results.push(resEntry);
    });
    results.sort(function (a, b) { return b.delta - a.delta; });

    // attract-mode fuel: remember the biggest wager win + latest streak milestone
    (function () {
      var bw = null;
      results.forEach(function (row) {
        if (row.wager > 0 && row.correct && row.delta >= 400 && (!bw || row.delta > bw.delta)) bw = row;
      });
      if (bw) lastHighlight = { type: 'wager', name: bw.name, amount: bw.delta, ts: Date.now() };
      else if (streakCallouts.length) {
        var sc = streakCallouts[streakCallouts.length - 1];
        lastHighlight = { type: 'streak', name: sc.name, amount: sc.streak, ts: Date.now() };
      }
    })();

    db.ref().update(upd).then(function () {
      var isTextQ = E.isTextQuestion(q);
      return refs.reveal.set({
        correctIndex: isTextQ ? -1 : q.answer,
        correctText: isTextQ ? (q.answerText || q.options[q.answer] || '') : q.options[q.answer],
        answerType: q.answerType || 'choice',
        answerNumber: isNumQ ? numAnswer : null,
        closestDiff: isNumQ ? (closestDiff === Infinity ? null : closestDiff) : null,
        ts: firebase.database.ServerValue.TIMESTAMP,
        isWager: cq.isWager,
        wagerUp: !!cq.isWagerUp,
        isLightning: !!cq.isLightning,
        answeredCount: answeredCount,
        correctCount: correctCount,
        results: results.slice(0, 50),
        streakCallouts: streakCallouts.slice(0, 3),
        streaksLost: streaksLost.slice(0, 3),
        highScoreCelebrations: highScoreCelebrations.slice(0, 1),
      });
    }).then(function () {
      return writeState({ phase: 'reveal', podium: null });
    }).then(function () {
      // High-score celebrations now ride the reveal doc so every screen shows
      // them in the moment queue (see renderRevealFinal).
      var pause = cq.isWager ? E.WAGER_REVEAL_SECONDS : E.REVEAL_SECONDS;
      questionTimer = setTimeout(function () {
        if (cq.isWager) showPodium(); else advanceGame();
      }, pause * 1000);
    });
  }

  /* ---------------- big-deal moments : one FIFO overlay, never overlapping ----------------
     Sendoffs, snapped streaks, wager-risked beats, streak milestones and high-score
     celebrations all queue here so they play back-to-back instead of colliding. */
  var momentQueue = [];
  var momentBusy = false;
  var momentToken = 0; // invalidates pending moment timeouts after a cut

  function momentIdle() { return !momentBusy && momentQueue.length === 0; }

  function queueMoment(m) {
    // m: { cls, html, dur, sound }
    momentQueue.push(m);
    pumpMoments();
  }

  function pumpMoments() {
    if (momentBusy) return;
    var m = momentQueue.shift();
    if (!m) return;
    var ov = $('#momentOverlay');
    if (!ov) return;
    momentBusy = true;
    var tok = ++momentToken;
    ov.innerHTML = '<div class="moment-inner ' + (m.cls || '') + '">' + m.html + '</div>';
    ov.hidden = false;
    ov.classList.remove('show');
    void ov.offsetWidth;
    ov.classList.add('show');
    if (m.sound) { try { m.sound(); } catch (e) {} }
    setTimeout(function () {
      if (tok !== momentToken) return;
      ov.classList.remove('show');
      setTimeout(function () {
        if (tok !== momentToken) return;
        ov.hidden = true;
        ov.innerHTML = '';
        momentBusy = false;
        pumpMoments();
      }, 320);
    }, m.dur || 2600);
  }

  // A new segment cuts big-deal moments short (called when leaving the reveal phase).
  function cutMoments() {
    momentToken++;
    momentQueue.length = 0;
    momentBusy = false;
    var ov = $('#momentOverlay');
    if (ov) { ov.classList.remove('show'); ov.hidden = true; ov.innerHTML = ''; }
  }

  function escName(n) { return E.escapeHtml(String(n || 'Player').slice(0, 24)); }

  // warm classy sendoff when a player disconnects
  function sendoffMoment(name) {
    return {
      cls: 'sendoff', dur: 3000, sound: sSendoff,
      html: '<div class="moment-kicker">Thanks for playing</div>' +
        '<div class="moment-name">' + escName(name) + '</div>' +
        '<div class="moment-sub">The cave salutes you &#127866;</div>'
    };
  }

  // streak snapped: cinematic, not punishing
  function snappedMoment(name, n) {
    return {
      cls: 'snapped', dur: 2800, sound: sStreakLost,
      html: '<div class="moment-kicker">Streak snapped</div>' +
        '<div class="moment-flame">&#128293;</div>' +
        '<div class="moment-name">' + escName(name) + '</div>' +
        '<div class="moment-line">' + n + ' in a row</div>' +
        '<div class="moment-sub">Hell of a run</div>'
    };
  }

  // big wager loss: "{name} risked {x}" beat before the result lands
  function wagerBeatMoment(losses) {
    var label = losses.length === 1 ? escName(losses[0].name) : losses.length + ' players';
    var amt = Math.max.apply(null, losses.map(function (x) { return x.wager; }));
    return {
      cls: 'wagerbeat', dur: 2400, sound: sRiskBeat,
      html: '<div class="moment-kicker">Big risk</div>' +
        '<div class="moment-name">' + label + '</div>' +
        '<div class="moment-line chrome-text">Risked ' + E.fmtNum(amt) + '</div>'
    };
  }

  // streak milestones with escalating treatment: 3/5, 10, 15, 20+
  function streakMoment(name, n) {
    var tier = n >= 20 ? 't4' : n >= 15 ? 't3' : n >= 10 ? 't2' : 't1';
    var kicker = n >= 20 ? 'Legendary' : n >= 15 ? 'Unstoppable' : n >= 10 ? 'Double digits' : 'On fire';
    return {
      cls: 'streak ' + tier,
      dur: n >= 20 ? 3400 : 2600,
      sound: function () { sStreak(n); if (n >= 20) setTimeout(sBigWin, 700); },
      html: '<div class="moment-kicker">' + kicker + '</div>' +
        '<div class="moment-flame">' + (n >= 15 ? '&#128293;&#128293;' : '&#128293;') + '</div>' +
        '<div class="moment-name">' + escName(name) + '</div>' +
        '<div class="moment-line chrome-text">' + n + ' in a row</div>'
    };
  }

  // "NEW HIGH SCORE — REESE GETS TO 400"
  function celebrationMoment(name, score) {
    return {
      cls: 'celebration', dur: 3500, sound: sBigWin,
      html: '<div class="moment-kicker glow">New high score</div>' +
        '<div class="moment-name huge">' + escName(name) + '</div>' +
        '<div class="moment-line">Gets to ' + E.fmtNum(score) + '</div>'
    };
  }

  // biggest wager losses in a reveal (wager >= 200 and lost) — top 2
  function topWagerLosses(r) {
    return (r.results || [])
      .filter(function (x) { return x.wager >= 200 && x.delta < 0; })
      .sort(function (a, b) { return b.wager - a.wager; })
      .slice(0, 2)
      .map(function (x) { return { name: x.name, wager: x.wager }; });
  }

  // Block-capping ceremony after the wager reveal: top 3 of the block.
  function showPodium() {
    clearTimer();
    var top = E.leaderboard(players, 'block').slice(0, 3).map(function (r) {
      return { name: r.name, score: r.score };
    });
    writeState({ phase: 'podium', questionInBlock: E.BLOCK_SIZE, podium: { top: top } })
      .then(function () {
        questionTimer = setTimeout(function () {
          var upd = {};
          Object.keys(players).forEach(function (pid) {
            upd[ROOM + '/players/' + pid + '/blockScore'] = 0;
          });
          blockNum += 1;
          blockDealt = 0;
          db.ref().update(upd).then(function () {
            return writeState({ podium: null });
          }).then(advanceGame);
        }, E.PODIUM_SECONDS * 1000);
      });
  }

  // The always-on runner: decide what comes next.
  function advanceGame() {
    clearTimer();
    currentQ = null;
    pendingWagerQ = null;
    // Jordan's rule: no players -> attract mode. We only get here between
    // questions, so the current question always finishes first. Fresh block
    // for whoever joins next.
    if (activePlayerCount() === 0) {
      blockDealt = 0;
      writeState({ phase: 'idle', questionInBlock: 0, podium: null });
      return;
    }
    if (blockDealt >= E.BLOCK_SIZE) return showPodium();
    if (blockDealt >= E.BLOCK_SIZE - 1) return startWager(false);
    var nextQib = blockDealt + 1;
    if (E.isWagerUpSlot(nextQib)) return startWager(true, nextQib);
    return dealQuestion();
  }

  /* ---------------- listeners ---------------- */

  function onPlayers(snap) {
    var next = snap.val() || {};
    var wasEmpty = activePlayerCount() === 0;
    detectLeaves(players, next);
    players = next;
    var nowEmpty = activePlayerCount() === 0;
    renderBoard();
    renderPlayerCount();
    pushBoardToState();
    // Jordan's rule: the moment someone joins, the game starts immediately.
    // (If a game is already running, do nothing — kickstartGame dedups anyway.)
    if (wasEmpty && !nowEmpty) {
      var st = lastStateDoc;
      var gameRunning = st && st.phase && st.phase !== 'idle';
      if (!gameRunning) kickstartGame(500);
    }
  }

  // Warm sendoff when a present player disconnects (phone registers
  // onDisconnect -> present:false; see client.js join()).
  function detectLeaves(oldP, newP) {
    oldP = oldP || {};
    Object.keys(oldP).forEach(function (pid) {
      var was = oldP[pid].present !== false;
      var rec = newP[pid];
      var gone = !rec || rec.present === false;
      if (was && gone && oldP[pid].name) {
        queueMoment(sendoffMoment(oldP[pid].name));
      }
    });
  }

  function onSettings(snap) {
    settings = snap.val() || {};
    var changed = false;
    if (!settings.theme) { settings.theme = 'midnight-gold'; changed = true; }
    if (!settings.title) { settings.title = 'CAVE TRIVIA'; changed = true; }
    if (!Array.isArray(settings.disabledCats)) { settings.disabledCats = []; changed = true; }
    if (settings.familyMode === undefined) { settings.familyMode = false; changed = true; }
    if (changed) refs.settings.update(settings);
    applySettings();
  }

  function onState(snap) {
    var st = snap.val() || { phase: 'idle' };
    lastStateDoc = st;
    render(st);
  }

  function onQuestion(snap) {
    var q = snap.val();
    lastQuestionDoc = q;
    if (q) renderQuestionDoc(q);
  }

  function onReveal(snap) {
    var r = snap.val();
    if (r) renderRevealDoc(r);
  }

  // Keep the state's leaderboard copies fresh (phones read them).
  // Writes only when the serialized board actually changed.
  function pushBoardToState() {
    var board = E.leaderboard(players, 'all').slice(0, 10).map(function (r) {
      return { name: r.name, score: r.score };
    });
    var blockBoard = E.leaderboard(players, 'block').slice(0, 10).map(function (r) {
      return { name: r.name, score: r.score };
    });
    var payload = {
      board: board, blockBoard: blockBoard,
      playersTotal: Object.keys(players).length, playersActive: activePlayerCount(),
    };
    var json = JSON.stringify(payload);
    if (json === lastBoardJson) return;
    lastBoardJson = json;
    refs.state.update(payload);
  }

  /* ---------------- rail : progress, leaderboard, QR ---------------- */

  var pipsBuilt = false;
  function renderProgress(qib, bnum) {
    $('#qibNum').textContent = qib || '\u2013';
    $('#blockNum').textContent = bnum || '\u2013';
    var pips = $('#pips');
    if (!pipsBuilt) {
      for (var i = 0; i < 10; i++) {
        var p = document.createElement('i');
        if (i === 9) p.className = 'wager';
        else if (E.isWagerUpSlot(i + 1)) p.className = 'wup';
        pips.appendChild(p);
      }
      pipsBuilt = true;
    }
    Array.prototype.forEach.call(pips.children, function (el, i) {
      el.classList.toggle('done', i < (qib || 1) - 1);
      el.classList.toggle('now', i === (qib || 1) - 1);
    });
  }

  function renderStatsBoard() {
    // Full timeframe leaderboard UI lands in the spectacle pass.
    // For now, just ensure the function exists and doesn't crash.
    return;
  }

  function streakFlame(name) {
    var st = statsCache[statsKey(name)] || {};
    var n = st.streak || 0;
    if (n < 3) return '';
    var tier = n >= 10 ? 't3' : n >= 5 ? 't2' : 't1';
    return '<span class="sflame ' + tier + '">&#128293;<span class="n">' + n + '</span></span>';
  }

  function renderBoard() {
    var board = E.leaderboard(players, 'block').slice(0, 10);
    var el = $('#blockBoard');
    el.innerHTML = '';
    if (!board.length) {
      el.innerHTML = '<div class="board-empty">No scores yet &mdash; be the first legend of the cave.</div>';
      return;
    }
    board.forEach(function (r, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="nm">' + E.escapeHtml(r.name) + streakFlame(r.name) + '</span>' +
        '<span class="sc">' + E.fmtNum(r.score) + '</span>';
      el.appendChild(li);
    });
  }

  function renderPlayerCount() {
    var now = serverNow();
    var active = Object.keys(players).filter(function (pid) {
      return now - (players[pid].lastSeen || 0) < 15 * 60 * 1000;
    }).length;
    $('#playerCount').textContent = active;
  }

  var lastQrUrl = '';
  function renderQr() {
    var base = location.href.split('#')[0].split('?')[0];
    var playUrl = /index\.html$/.test(base)
      ? base.replace(/index\.html$/, 'play.html')
      : base.replace(/\/?$/, '/') + 'play.html';
    $('#joinUrl').textContent = playUrl;
    var cfg = window.CT.config.readStored();
    if (!cfg) return;
    var qrUrl = playUrl + '#c=' + window.CT.config.encodeForQr(cfg);
    if (qrUrl === lastQrUrl) return;
    lastQrUrl = qrUrl;
    try {
      var qr = qrcode(0, 'M');
      qr.addData(qrUrl);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    } catch (e) { /* leave the URL text */ }
  }

  /* ---------------- phase renderers ---------------- */

  function setPhase(name) {
    ['idle', 'wager', 'question', 'reveal', 'podium'].forEach(function (p) {
      var el = document.getElementById('phase-' + p);
      if (el) el.classList.toggle('active', p === name);
    });
  }

  function sweepStreak() {
    var s = $('#streak');
    s.classList.remove('sweep');
    void s.offsetWidth;
    s.classList.add('sweep');
  }

  function onPhaseChange(phase) {
    sweepStreak();
    if (phase === 'question') sQuestionSting();
    else if (phase === 'reveal') sRevealHit();
    else if (phase === 'wager') sWagerSwell();
    else if (phase === 'podium') sFanfare();
  }

  function buildOptions(container, options, correctIndex, revealed) {
    container.innerHTML = '';
    options.forEach(function (text, i) {
      var d = document.createElement('div');
      d.className = 'q-opt';
      if (revealed) d.classList.add(i === correctIndex ? 'correct' : 'dim');
      var l = document.createElement('span');
      l.className = 'letter';
      l.textContent = LETTERS[i];
      var t = document.createElement('span');
      t.textContent = text;
      d.appendChild(l); d.appendChild(t);
      container.appendChild(d);
    });
  }

  /* ---------------- attract loop : casino-style cycling cards ---------------- */
  // Rotates every 9s between teaser / join / leaderboard / legends.
  // Only runs while phase is 'idle'. Killed immediately on phase change.
  var arTimer = null, arIdx = 0, arTeaserTimer = null;

  function arQrSvg() {
    var base = location.href.split('#')[0].split('?')[0];
    var playUrl = /index\.html$/.test(base)
      ? base.replace(/index\.html$/, 'play.html')
      : base.replace(/\/?$/, '/') + 'play.html';
    var cfg = window.CT.config.readStored();
    if (!cfg) return '';
    try {
      var qr = qrcode(0, 'M');
      qr.addData(playUrl + '#c=' + window.CT.config.encodeForQr(cfg));
      qr.make();
      return qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
    } catch (e) { return ''; }
  }

  // Pick a short punchy teaser question, preferring ones with images.
  var arLastTeaser = null;
  function arPickTeaser() {
    if (!bank || !bank.length) return null;
    var withImg = [], short = [];
    for (var i = 0; i < bank.length; i++) {
      var q = bank[i];
      var len = (q.question || q.text || '').length;
      if (len > 140 || len < 15) continue;
      if (q.image) withImg.push(q); else short.push(q);
    }
    var pool = withImg.length ? withImg : short;
    if (!pool.length) return null;
    arLastTeaser = pool[Math.floor(Math.random() * pool.length)];
    return arLastTeaser;
  }

  function arTeaserHtml() {
    var q = arPickTeaser();
    if (!q) return '<div class="ar-eyebrow">Cave Trivia</div><div class="ar-big chrome-text">SCAN TO PLAY</div>';
    var text = q.question || q.text || '';
    var cat = E.fmtCategory(q.category);
    var img = q.image ? '<div class="ar-teaser-img" style="background-image:url(' + E.escapeHtml(q.image) + ')"></div>' : '';
    return img +
      '<div class="ar-eyebrow">Teaser &middot; ' + E.escapeHtml(cat) + '</div>' +
      '<div class="ar-question">' + E.escapeHtml(text) + '</div>' +
      '<div class="ar-cta-line">Think you know it? <b>Scan to play</b></div>';
  }

  function arTeaserAnswerHtml(q) {
    var ans = E.answerTextOf(q);
    var img = q.image ? '<div class="ar-teaser-img dim" style="background-image:url(' + E.escapeHtml(q.image) + ')"></div>' : '';
    return img +
      '<div class="ar-eyebrow gold">The answer was</div>' +
      '<div class="ar-answer chrome-text">' + E.escapeHtml(ans) + '</div>' +
      '<div class="ar-cta-line">Knew it? <b>Scan to prove it</b></div>';
  }

  function arJoinHtml() {
    var svg = arQrSvg();
    return '<div class="ar-eyebrow">Free &middot; no app needed &middot; jump in anytime</div>' +
      '<div class="ar-join-row">' +
      (svg ? '<div class="ar-qr">' + svg + '</div>' : '') +
      '<div class="ar-join-text"><div class="ar-big chrome-text">SCAN<br>TO JOIN</div>' +
      '<div class="ar-sub">Your phone is the controller</div></div>' +
      '</div>';
  }

  function arBoardHtml() {
    var rows = '';
    var money = Object.keys(statsCache).map(function (k) { return statsCache[k]; })
      .filter(function (s) { return (s.lifetime || 0) > 0; })
      .sort(function (a, b) { return (b.lifetime || 0) - (a.lifetime || 0); })
      .slice(0, 5);
    if (money.length) {
      rows += '<div class="ar-board-title">&#128176; All-time money</div><div class="ar-rows">';
      money.forEach(function (s, i) {
        rows += '<div class="ar-row' + (i === 0 ? ' first' : '') + '"><span class="ar-rank">' + (i + 1) + '</span>' +
          '<span class="ar-name">' + E.escapeHtml(s.name || '?') + '</span>' +
          '<span class="ar-score">' + E.fmtNum(s.lifetime) + '</span></div>';
      });
      rows += '</div>';
    }
    var streaks = Object.keys(statsCache).map(function (k) { return statsCache[k]; })
      .filter(function (s) { return (s.bestStreak || 0) >= 2; })
      .sort(function (a, b) { return (b.bestStreak || 0) - (a.bestStreak || 0); })
      .slice(0, 3);
    if (streaks.length) {
      rows += '<div class="ar-board-title">&#128293; Best streaks</div><div class="ar-rows">';
      streaks.forEach(function (s, i) {
        rows += '<div class="ar-row' + (i === 0 ? ' first' : '') + '"><span class="ar-rank">' + (i + 1) + '</span>' +
          '<span class="ar-name">' + E.escapeHtml(s.name || '?') + '</span>' +
          '<span class="ar-score">' + (s.bestStreak || 0) + ' in a row</span></div>';
      });
      rows += '</div>';
    }
    if (!rows) rows = '<div class="ar-sub">No legends yet &mdash; be the first</div>';
    return '<div class="ar-eyebrow">The Cave leaderboards</div>' +
      '<div class="ar-big chrome-text">HALL<br>OF FAME</div>' + rows;
  }

  function arLegendsHtml() {
    var best = null, rich = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      if ((s.bestStreak || 0) >= 3 && (!best || s.bestStreak > best.bestStreak)) best = s;
      if ((s.lifetime || 0) > 0 && (!rich || s.lifetime > rich.lifetime)) rich = s;
    });
    var bits = '';
    if (best) bits += '<div class="ar-legend"><div class="ar-legend-kicker">&#128293; Longest streak ever</div>' +
      '<div class="ar-legend-name chrome-text">' + E.escapeHtml(best.name) + '</div>' +
      '<div class="ar-legend-line">' + best.bestStreak + ' correct in a row</div></div>';
    if (rich && (!best || rich.name !== best.name)) bits += '<div class="ar-legend"><div class="ar-legend-kicker">&#128176; Richest player ever</div>' +
      '<div class="ar-legend-name chrome-text">' + E.escapeHtml(rich.name) + '</div>' +
      '<div class="ar-legend-line">' + E.fmtNum(rich.lifetime) + ' lifetime</div></div>';
    if (lastHighlight && Date.now() - lastHighlight.ts < 24 * 60 * 60 * 1000) {
      var h = lastHighlight;
      bits += '<div class="ar-legend"><div class="ar-legend-kicker">&#9889; Latest big moment</div>' +
        '<div class="ar-legend-name">' + E.escapeHtml(h.name) + '</div>' +
        '<div class="ar-legend-line">' + (h.type === 'wager' ? 'banked +' + E.fmtNum(h.amount) + ' on a wager' : h.amount + ' in a row') + '</div></div>';
    }
    if (!bits) bits = '<div class="ar-sub">The cave is waiting for its first legend</div>';
    return '<div class="ar-eyebrow gold">The Cave&rsquo;s finest</div>' +
      '<div class="ar-big chrome-text">LEGENDS</div>' + bits +
      '<div class="ar-cta-line">Your name could be here &mdash; <b>scan to play</b></div>';
  }

  var AR_CARDS = [
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'join', html: arJoinHtml },
    { name: 'board', html: arBoardHtml },
    { name: 'legends', html: arLegendsHtml },
  ];

  function arShow(idx) {
    var card = AR_CARDS[idx % AR_CARDS.length];
    var el = $('#arCard');
    if (!el) return;
    if (arTeaserTimer) { clearTimeout(arTeaserTimer); arTeaserTimer = null; }
    el.classList.add('fade');
    setTimeout(function () {
      var html = card.html();
      el.innerHTML = html;
      el.classList.remove('fade');
      // teaser card flips to the answer after 4s
      if (card.teaser) {
        arTeaserTimer = setTimeout(function () {
          if (lastPhase !== 'idle') return;
          var qq = arLastTeaser;
          if (!qq) return;
          el.classList.add('fade');
          setTimeout(function () {
            el.innerHTML = arTeaserAnswerHtml(qq);
            el.classList.remove('fade');
          }, 450);
        }, 4000);
      }
    }, 450);
  }

  function startAttractLoop() {
    if (arTimer) return;
    arIdx = 0;
    arShow(0);
    arTimer = setInterval(function () {
      if (lastPhase !== 'idle') { stopAttractLoop(); return; }
      arIdx = (arIdx + 1) % AR_CARDS.length;
      arShow(arIdx);
    }, 9000);
  }

  function stopAttractLoop() {
    if (arTimer) { clearInterval(arTimer); arTimer = null; }
    if (arTeaserTimer) { clearTimeout(arTeaserTimer); arTeaserTimer = null; }
  }

  function renderIdle() {
    startAttractLoop();
    pokeAttractTicker();
  }

  // ---- attract ticker: rotating social-proof highlights ----
  var tickerIdx = 0, tickerTimer = null;
  function attractHighlights() {
    var out = [];
    var tk = todayKeys();
    // hottest live streak
    var hot = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      if ((s.streak || 0) >= 3 && (!hot || s.streak > hot.streak)) hot = s;
    });
    if (hot) out.push('<span class="tk-flame">&#128293;</span> <b>' + E.escapeHtml(hot.name) + '</b> is on a <b>' + hot.streak + '-streak</b>');
    // biggest day total
    var rich = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      if (s.dayKey === tk.day && (s.day || 0) > 0 && (!rich || s.day > rich.day)) rich = s;
    });
    if (rich && (!hot || rich.name !== hot.name)) out.push('&#128176; <b>' + E.escapeHtml(rich.name) + '</b> is up <b>' + E.fmtNum(rich.day) + '</b> today');
    // latest big moment (30 min window)
    if (lastHighlight && Date.now() - lastHighlight.ts < 30 * 60 * 1000) {
      var h = lastHighlight;
      out.push(h.type === 'wager'
        ? '&#9889; <b>' + E.escapeHtml(h.name) + '</b> just banked <b>+' + E.fmtNum(h.amount) + '</b> on a wager'
        : '<span class="tk-flame">&#128293;</span> <b>' + E.escapeHtml(h.name) + '</b> hit <b>' + h.amount + ' in a row</b>');
    }
    // social proof: players in right now
    var now = serverNow();
    var active = Object.keys(players).filter(function (pid) {
      return now - (players[pid].lastSeen || 0) < 15 * 60 * 1000;
    }).length;
    if (active > 0) out.push('&#128101; <b>' + active + '</b> playing right now &mdash; jump in');
    else out.push('&#127919; No one playing &mdash; be the first legend of the cave');
    return out;
  }
  function pokeAttractTicker() {
    if (tickerTimer) return; // already running
    var tick = function () {
      if (lastPhase !== 'idle') return; // only animate on the attract screen
      var items = attractHighlights();
      if (!items.length) return;
      tickerIdx = (tickerIdx + 1) % items.length;
      var el = $('#attractTicker');
      if (!el) return;
      el.classList.add('fade');
      setTimeout(function () {
        el.innerHTML = items[tickerIdx % items.length];
        el.classList.remove('fade');
      }, 480);
    };
    tickerTimer = setInterval(tick, 6000);
    tick();
  }

  var lastWagerKey = '';
  function renderWagerState(st) {
    var isUp = !!st.wagerUp;
    var phase = $('#phase-wager');
    phase.classList.toggle('wager-up', isUp);
    var qib = st.questionInBlock || 10;
    $('#wagerEyebrow').innerHTML = isUp
      ? 'Wager up &middot; question ' + qib + ' of 10 &middot; hard'
      : 'Final wager &middot; question 10 of 10';
    $('#wagerTitle').innerHTML = isUp ? 'WAGER<br>UP' : 'FINAL<br>WAGER';
    $('#wagerHint').innerHTML = isUp
      ? 'Hard question &mdash; risk it all on your phone, <b>now</b>'
      : 'Wager <b>0</b> up to your whole score &mdash; on your phone, now';
    $('#wagerCat').textContent = E.fmtCategory(st.wagerCategory) || 'MYSTERY';
    // players who placed any wager (0 = pass counts as placed)
    var n = Object.keys(players).filter(function (pid) { return players[pid].wagerPlaced; }).length;
    var el = $('#wagerCount');
    el.hidden = n <= 0;
    el.textContent = n === 1 ? '1 player has wagered' : n + ' players have wagered';
  }

  function renderQuestionDoc(q) {
    var media = $('#qMedia'), img = $('#qImg'), frame = $('#qVideoFrame'), vid = $('#qVideo');
    if (lastQid !== 'q' + q.id) {
      lastQid = 'q' + q.id;
      // re-trigger the cinematic entrance on fresh content
      var qp = $('#phase-question');
      qp.classList.remove('q-enter');
      void qp.offsetWidth;
      qp.classList.add('q-enter');
      $('#qCat').textContent = E.fmtCategory(q.category);
      $('#qDiff').textContent = q.difficulty || '';
      $('#qWagerBadge').hidden = !q.isWager;
      var qlb = $('#qLightningBadge');
      if (qlb) qlb.hidden = !q.isLightning;
      var qp2 = $('#phase-question');
      if (qp2) qp2.classList.toggle('lightning', !!q.isLightning);
      var qTextEl = $('#qText');
      qTextEl.textContent = q.text;
      // Scale font down for long questions so they don't look jumbled
      var qlen = (q.text || '').length;
      qTextEl.classList.remove('q-long', 'q-xlong');
      if (qlen > 280) qTextEl.classList.add('q-xlong');
      else if (qlen > 150) qTextEl.classList.add('q-long');
      if (q.answerType === 'text') {
        var box = $('#qOptions');
        box.innerHTML = '<div class="q-text-hint">TYPE YOUR ANSWER ON YOUR PHONE</div>';
      } else {
        buildOptions($('#qOptions'), q.options, -1, false);
      }
      media.classList.remove('bleed');
      img.removeAttribute('src');
      frame.hidden = true;
      vid.src = 'about:blank';
      // Prefer still image over video embed: images are reliable, video iframes
      // cause freezes/hangs on TV browsers and autoplay is blocked anyway.
      if (q.image) {
        media.hidden = false;
        media.classList.add('bleed');
        img.src = q.image;
      } else if (q.video && q.video.youtubeId) {
        media.hidden = false;
        frame.hidden = false;
        vid.src = 'https://www.youtube.com/embed/' + encodeURIComponent(q.video.youtubeId) +
          '?autoplay=1&rel=0&start=' + (q.video.start || 0) + '&end=' + (q.video.end || 0);
      } else {
        media.hidden = true;
      }
    }
    // locked-in count, computed locally from the players mirror
    var locked = Object.keys(players).filter(function (pid) {
      var a = players[pid].answer;
      if (!a) return false;
      if (q.answerType === 'text') return typeof a.text === 'string' && a.text.trim() !== '';
      return typeof a.choice === 'number';
    }).length;
    $('#qLocked').textContent = locked;
  }

  // ---- reveal: 1.7s tension beat, then the answer lands ----
  // (big wager losses steal the tension window for their own beat first)
  var revealToken = 0;
  function renderRevealDoc(r) {
    var key = 'r' + r.ts;
    if (lastQid === key) return;
    lastQid = key;
    var myToken = ++revealToken;
    var losses = topWagerLosses(r);
    var beatMs = 0;
    if (losses.length && momentIdle()) {
      // the risked-it beat replaces the REVEALING veil; reveal lands after it
      beatMs = 2500;
      renderRevealTension(r, true);
      queueMoment(wagerBeatMoment(losses));
    } else {
      renderRevealTension(r, false);
      sTensionRiser();
    }
    setTimeout(function () {
      if (myToken !== revealToken) return; // superseded by a newer reveal
      if (lastPhase !== 'reveal') return;  // phase already moved on
      renderRevealFinal(r);
    }, 1700 + beatMs);
  }

  function renderRevealTension(r, quiet) {
    var phase = $('#phase-reveal');
    phase.classList.add('tension');
    phase.classList.remove('resolved');
    var qd = lastQuestionDoc || {};
    $('#rCat').textContent = E.fmtCategory(qd.category);
    $('#rWagerBadge').hidden = !r.isWager;
    $('#rText').textContent = qd.text || '';
    // options shown dimmed, correct answer NOT highlighted yet
    if (r.answerType === 'text') {
      $('#rOptions').innerHTML = '<div class="q-text-hint">THE ANSWER WAS</div>';
    } else {
      buildOptions($('#rOptions'), qd.options || [], -1, false);
    }
    $('#rNote').innerHTML = '';
    $('#rResults').innerHTML = quiet ? '' : '<div class="tension-veil">REVEALING</div>';
  }

  function renderRevealFinal(r) {
    var phase = $('#phase-reveal');
    phase.classList.remove('tension');
    phase.classList.add('resolved');
    var qd = lastQuestionDoc || {};
    $('#rCat').textContent = E.fmtCategory(qd.category);
    $('#rWagerBadge').hidden = !r.isWager;
    $('#rText').textContent = qd.text || '';
    var isNumR = r.answerType === 'number';
    if (isNumR) {
      $('#rOptions').innerHTML = '<div class="q-text-hint">THE ANSWER WAS ' + E.fmtNum(r.answerNumber) + '</div>';
    } else if (r.answerType === 'text') {
      $('#rOptions').innerHTML = '<div class="q-text-hint">THE ANSWER WAS</div>';
    } else {
      buildOptions($('#rOptions'), qd.options || [], r.correctIndex, true);
    }
    var note;
    if (isNumR) {
      var winners = (r.results || []).filter(function (x) { return x.correct; });
      var wnames = winners.slice(0, 3).map(function (x) { return E.escapeHtml(x.name); }).join(', ');
      note = '<b>Closest wins</b> &mdash; ' + E.fmtNum(r.answerNumber) +
        (wnames ? ' &nbsp;<span style="color:var(--gold)">&#9733; ' + wnames + '</span>' : '');
    } else {
      note = '<b>' + (r.correctCount || 0) + '</b> of <b>' + (r.answeredCount || 0) +
        '</b> answered correctly &mdash; ' + E.escapeHtml(r.correctText || '');
    }
    if (r.streaksLost && r.streaksLost.length) {
      var sl = r.streaksLost[0];
      note += ' &nbsp;<span style="color:#ff8f7d">&hearts; ' + E.escapeHtml(sl.name) +
        '&rsquo;s ' + sl.streak + '-streak snapped</span>';
    }
    $('#rNote').innerHTML = note;
    var list = $('#rResults');
    list.innerHTML = '';
    var hasBigWin = false;
    (r.results || []).slice(0, 8).forEach(function (row) {
      var li = document.createElement('li');
      var d = Number(row.delta || 0);
      var wagerNote = (r.isWager && row.wager > 0)
        ? '<span class="wg">risked ' + E.fmtNum(row.wager) + '</span>' : '';
      if (isNumR && row.guess !== undefined) {
        wagerNote = '<span class="wg">guessed ' + E.fmtNum(row.guess) + '</span>';
      }
      if (r.isWager && row.correct && d >= 800) { li.classList.add('bigwin'); hasBigWin = true; }
      li.innerHTML = '<span class="nm">' + E.escapeHtml(row.name) + '</span>' + wagerNote +
        '<span class="delta ' + (d >= 0 ? 'pos' : 'neg') + '">' + E.fmtDelta(d) + '</span>';
      list.appendChild(li);
    });
    if (hasBigWin) sBigWin();
    // big-deal moments, queued in broadcast order (capped so they fit the pause):
    // celebration, then top streak milestones, then the biggest snapped streak.
    if (r.highScoreCelebrations && r.highScoreCelebrations.length) {
      var hc = r.highScoreCelebrations[0];
      queueMoment(celebrationMoment(hc.name, hc.score));
    }
    (r.streakCallouts || []).slice()
      .sort(function (a, b) { return b.streak - a.streak; })
      .slice(0, 2)
      .forEach(function (sc) { queueMoment(streakMoment(sc.name, sc.streak)); });
    var snaps = (r.streaksLost || []).slice()
      .sort(function (a, b) { return b.streak - a.streak; })
      .slice(0, 1);
    snaps.forEach(function (sl) { queueMoment(snappedMoment(sl.name, sl.streak)); });
  }

  function renderPodiumState(st) {
    var p = st.podium;
    $('#podiumBlock').textContent = st.blockNum || '';
    var steps = $('#podiumSteps');
    if (!p || !p.top) { steps.innerHTML = ''; return; }
    var sig = JSON.stringify(p.top);
    if (steps.dataset.sig === sig) return;
    steps.dataset.sig = sig;
    steps.innerHTML = '';
    var order = [1, 0, 2], cls = ['second', 'first', 'third'], medals = ['2', '1', '3'];
    order.forEach(function (idx, k) {
      var row = p.top[idx];
      if (!row) return;
      var d = document.createElement('div');
      d.className = 'podium-step ' + cls[k];
      d.innerHTML = '<div class="p-name">' + E.escapeHtml(row.name) + '</div>' +
        '<div class="p-score">' + E.fmtNum(row.score) + '</div>' +
        '<div class="p-block">' + medals[k] + '</div>';
      steps.appendChild(d);
    });
  }

  function stopVideo() {
    var vid = $('#qVideo');
    if (vid && vid.src && vid.src !== 'about:blank') vid.src = 'about:blank';
  }

  function render(st) {
    if (!st) return;
    var phase = st.phase || 'idle';
    renderProgress(st.questionInBlock, st.blockNum);
    if (phase !== lastPhase) {
      if (lastPhase === 'question') stopVideo();
      if (lastPhase === 'reveal') cutMoments(); // new segment cuts big-deal moments
      onPhaseChange(phase);
      lastPhase = phase;
      if (phase !== 'question' && phase !== 'reveal') lastQid = '';
    }
    setPhase(phase);
    // gold frame around the stage during wager-up moments
    var stage = document.querySelector('.tv-stage');
    if (stage) stage.classList.toggle('wagerup-frame', !!st.wagerUp && phase !== 'idle' && phase !== 'podium');
    if (phase === 'idle') renderIdle();
    else {
      stopAttractLoop();
      if (phase === 'wager') renderWagerState(st);
      else if (phase === 'podium') renderPodiumState(st);
    }
    tickTimers(true, st);
  }

  /* ---------------- timers + countdown ticks ---------------- */
  var RING_C = 2 * Math.PI * 54;
  var tickKey = '', tickSec = -1;

  function timeLeftMs(deadlineTs) {
    if (!deadlineTs) return 0;
    return Math.max(0, deadlineTs - serverNow());
  }

  function tickTimers(force, st) {
    st = st || {};
    var ms = 0, total = 1, key = '';
    if (st.phase === 'question' && st.deadlineTs) {
      ms = timeLeftMs(st.deadlineTs);
      var qsecs = (lastQuestionDoc && lastQuestionDoc.seconds) || E.QUESTION_SECONDS;
      total = qsecs * 1000;
      key = 'q:' + st.round;
      var frac = total > 0 ? ms / total : 0;
      var fill = $('#qTimerFill');
      if (fill) {
        fill.style.width = (100 * Math.max(0, Math.min(1, frac))) + '%';
        fill.parentElement.classList.toggle('low', ms < 5000);
      }
      $('#qSecs').textContent = Math.ceil(ms / 1000);
      var qd = $('#qRound');
      if (qd) qd.textContent = 'Q' + (st.questionInBlock || '?') + ' / Block ' + (st.blockNum || '?');
    } else if (st.phase === 'wager' && st.wagerDeadlineTs) {
      ms = timeLeftMs(st.wagerDeadlineTs);
      total = (st.wagerUp ? E.WAGER_UP_SECONDS : E.WAGER_SECONDS) * 1000;
      key = 'w:' + (st.wagerCategory || '');
      var ring = $('#wagerRingFg');
      ring.style.strokeDasharray = RING_C.toFixed(1);
      ring.style.strokeDashoffset = (RING_C * (1 - Math.max(0, Math.min(1, ms / total)))).toFixed(1);
      $('#wagerSecs').textContent = Math.ceil(ms / 1000);
    }
    if (!key) { tickKey = ''; tickSec = -1; return; }
    var secs = Math.ceil(ms / 1000);
    if (key !== tickKey) { tickKey = key; tickSec = -1; }
    if (secs >= 1 && secs <= 5 && secs !== tickSec) {
      tickSec = secs;
      if (!force) sTick();
    }
  }

  /* ---------------- clock ---------------- */
  function tickClock() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    $('#clock').textContent = h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }

  /* ---------------- settings ---------------- */

  function applySettings() {
    if (!settings) return;
    var theme = settings.theme || 'midnight-gold';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    $('#venueName').textContent = (settings.title || 'CAVE TRIVIA').toUpperCase();
    $('#venueTagline').textContent = (settings.tagline || 'ALWAYS-ON LEAGUE').toUpperCase();
    $('#familyBadge').hidden = !settings.familyMode;
    $('#famToggle').classList.toggle('on', !!settings.familyMode);
    document.querySelectorAll('.theme-swatch').forEach(function (el) {
      el.classList.toggle('active', el.dataset.theme === theme);
    });
    var ti = $('#gameTitleInput');
    if (ti && document.activeElement !== ti) ti.value = settings.title || '';
    var gi = $('#gameTaglineInput');
    if (gi && document.activeElement !== gi) gi.value = settings.tagline || '';
    renderCatGrid();
    renderIdle();
  }

  var lastDisabledJson = '';
  function renderCatGrid() {
    var disabled = settings.disabledCats || [];
    var json = JSON.stringify(disabled);
    if (json === lastDisabledJson) return;
    lastDisabledJson = json;
    var grid = $('#catGrid');
    grid.innerHTML = '';
    E.ALL_CATS.forEach(function (cat) {
      var off = disabled.indexOf(cat) >= 0;
      var label = document.createElement('label');
      label.className = 'cat-toggle' + (off ? ' off' : '');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !off;
      cb.addEventListener('change', function () {
        var d = (settings.disabledCats || []).slice();
        var i = d.indexOf(cat);
        if (cb.checked && i >= 0) d.splice(i, 1);
        if (!cb.checked && i < 0) d.push(cat);
        refs.settings.update({ disabledCats: d });
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(cat));
      grid.appendChild(label);
    });
  }

  function wireSettingsPanel() {
    $('#btnSettings').addEventListener('click', function () {
      $('#settingsOverlay').hidden = false;
    });
    $('#btnSettingsClose').addEventListener('click', function () {
      $('#settingsOverlay').hidden = true;
    });
    $('#settingsOverlay').addEventListener('click', function (e) {
      if (e.target === this) this.hidden = true;
    });
    document.querySelectorAll('.theme-swatch').forEach(function (el) {
      el.addEventListener('click', function () {
        refs.settings.update({ theme: el.dataset.theme });
      });
    });
    $('#btnTitleSave').addEventListener('click', function () {
      var v = $('#gameTitleInput').value.trim().slice(0, 30);
      if (v) refs.settings.update({ title: v });
    });
    $('#gameTitleInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#btnTitleSave').click();
      e.stopPropagation();
    });
    $('#btnTaglineSave').addEventListener('click', function () {
      var v = $('#gameTaglineInput').value.trim().slice(0, 40);
      refs.settings.update({ tagline: v });
    });
    $('#gameTaglineInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#btnTaglineSave').click();
      e.stopPropagation();
    });
    $('#famToggle').addEventListener('click', function () {
      refs.settings.update({ familyMode: !settings.familyMode });
    });
  }

  function paintSoundBtn() {
    var b = $('#btnSound');
    b.textContent = soundOn ? 'Sound on' : 'Sound off';
    b.classList.toggle('off', !soundOn);
  }

  /* ---------------- boot ---------------- */

  function boot(cfg) {
    try {
      db = window.CT.config.init(cfg);
    } catch (e) {
      $('#setupOverlay').hidden = false;
      var err = $('#configError');
      err.hidden = false;
      err.textContent = 'Couldn\u2019t connect: ' + e.message;
      return;
    }
    refs.state = db.ref(ROOM + '/state');
    refs.question = db.ref(ROOM + '/question');
    refs.players = db.ref(ROOM + '/players');
    refs.settings = db.ref(ROOM + '/settings');
    refs.reveal = db.ref(ROOM + '/reveal');
    refs.stats = db.ref(ROOM + '/playerStats');

    db.ref('.info/serverTimeOffset').on('value', function (snap) {
      serverOffset = snap.val() || 0;
    });

    refs.players.on('value', onPlayers);
    refs.settings.on('value', onSettings);
    refs.state.on('value', onState);
    refs.question.on('value', onQuestion);
    refs.reveal.on('value', onReveal);
    refs.stats.on('value', function (snap) {
      statsCache = snap.val() || {};
      renderStatsBoard();
    });

    // The TV is always the game runner — no election, no takeover.
    seedSettingsIfEmpty();
    clearStaleStateOnBoot();
    wireSettingsPanel();

    $('#btnSound').addEventListener('click', function () {
      soundOn = !soundOn;
      try { localStorage.setItem('ctv-sound', soundOn ? 'on' : 'off'); } catch (e) {}
      if (master) master.gain.value = soundOn ? 0.16 : 0;
      ensureAudio();
      paintSoundBtn();
    });
    paintSoundBtn();

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = String(e.key || '').toLowerCase();
      if (k === 'f' && settings) refs.settings.update({ familyMode: !settings.familyMode });
    });

    // countdown ticks driven by a local interval against the last state doc
    setInterval(function () {
      if (lastStateDoc) tickTimers(false, lastStateDoc);
    }, 200);

    tickClock();
    setInterval(tickClock, 10000);
    renderQr();
    setPhase('idle');
    renderIdle();

    E.loadBank().then(function (b) {
      bank = b;
    }).catch(function () {
      var ac = $('#arCard');
      if (ac) ac.innerHTML = '<div class="ar-eyebrow gold">Error</div><div class="ar-big">QUESTION BANK<br>FAILED TO LOAD</div>';
    });
  }

  wireSetup();
  var stored = window.CT.config.readStored();

  // One-tap video unlock: browsers block autoplay with sound until user interacts.
  // Game autoruns regardless — this only unlocks video audio. First tap anywhere hides the hint.
  // (Browsers require a fresh gesture per page load, so the hint shows on every load until tapped.)
  var videoUnlocked = false;
  function paintVideoHint() {
    var h = document.getElementById('videoUnlockHint');
    if (h) h.hidden = videoUnlocked;
  }
  paintVideoHint();
  var unlockVideo = function () {
    videoUnlocked = true;
    paintVideoHint();
    document.removeEventListener('click', unlockVideo);
    document.removeEventListener('touchstart', unlockVideo);
  };
  document.addEventListener('click', unlockVideo);
  document.addEventListener('touchstart', unlockVideo);

  if (stored) boot(stored);
  else showSetup();
})();
