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

  var db = null;                 // CT.rest.db() shim (pure REST, no SDK)
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

  /* ---------------- customizable text ----------------
     Every user-facing string on the attract screen, ticker, celebrations and
     site chrome lives here. Overrides persist at rooms/cave/settings/customText.
     {category} and {n} are placeholders filled at render time. */

  var CUSTOM_TEXT_DEFAULTS = {
    // question teaser card
    teaserEyebrow: '{category}',
    teaserCta: '<b>SCAN TO PLAY</b>',
    teaserAnswerEyebrow: 'ANSWER',
    teaserAnswerCta: '<b>SCAN TO PLAY</b>',
    // join card
    joinEyebrow: 'No app needed',
    joinTitle: 'SCAN<br>TO PLAY',
    joinSub: 'Play on your phone',
    // money board card (3 views: today / month / all time)
    moneyEyebrow: 'Leaderboard',
    moneyTitle: 'MONEY<br>BOARD',
    moneyTabDay: 'Today',
    moneyTabMonth: 'This month',
    moneyTabAll: 'All time',
    moneyEmpty: 'No scores yet',
    // streak board card
    streakEyebrow: 'Streaks',
    streakTitle: 'HOT<br>STREAKS',
    streakColNow: 'Now',
    streakColBest: 'Best',
    streakEmpty: 'No streaks yet',
    // legends card
    legendsEyebrow: 'Hall of fame',
    legendsTitle: 'LEGENDS',
    legendsEmpty: 'No legends yet',
    legendsCta: '<b>SCAN TO PLAY</b>',
    // attract ticker
    tickerPlaying: '{n} PLAYING',
    tickerEmpty: 'SCAN TO PLAY',
    // new challenger celebration
    challengerKicker: 'NEW CHALLENGER',
    challengerLine: '',
    // sendoff when a player leaves
    sendoffKicker: 'GAME OVER',
    sendoffSub: '',
    // streak snapped
    snappedKicker: 'STREAK OVER',
    snappedSub: '',
    // big wager loss beat
    wagerBeatKicker: 'Big risk',
    // streak milestone tiers
    streakT1: 'On fire',
    streakT2: 'Double digits',
    streakT3: 'Unstoppable',
    streakT4: 'Legendary',
    // high score celebration
    celebrationKicker: 'New high score',
    // milestone tiers (named)
    milestoneT1: 'Warming up',
    milestoneT2: 'Heating up',
    milestoneT3: 'On fire',
    milestoneT4: 'Unstoppable',
    milestoneT5: 'Cave legend',
    milestoneT6: 'Cave royalty',
    // king of the hill dethroning
    kingKicker: 'New king of the hill',
    kingLine: 'DETHRONES {old} AT {amount}',
    dethronedKicker: 'DETHRONED',
    dethronedSub: '',
    // record chase (on money board)
    chaseLabel: '{n} from the record',
    // reigning champ ticker
    tickerChamp: 'CHAMP: {name} \u00B7 {amount}',
    // site chrome
    railLeaderboard: 'Live leaderboard',
    railScan: 'Scan to play',
    podiumTitle: 'CHAMPIONS',
    podiumEyebrow: 'Block {n} final',
    footerNote: 'Cave Trivia'
  };

  // Plain-text value (for textContent).
  function ct(key) {
    var custom = settings && settings.customText;
    if (custom && typeof custom[key] === 'string' && custom[key] !== '') return custom[key];
    return CUSTOM_TEXT_DEFAULTS[key] || '';
  }

  // HTML-safe value: escapes everything, then re-allows <b>, <i>, <br>.
  function ctHtml(key) {
    var esc = E.escapeHtml(ct(key));
    return esc
      .replace(/&lt;(b|i)&gt;/g, '<$1>')
      .replace(/&lt;\/(b|i)&gt;/g, '</$1>')
      .replace(/&lt;br\s*\/?&gt;/g, '<br>');
  }

  // Fill {token} placeholders with escaped values.
  function fillTokens(html, map) {
    return String(html).replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(map, name) ? E.escapeHtml(String(map[name])) : m;
    });
  }

  // Watchdog: if the game gets stuck in a phase (Firebase write hung, timer lost),
  // force it forward. Runs every 5s. This is the anti-freeze safety net.
  // Also restarts the game if players are waiting but no game is running.
  setInterval(function () {
    try {
      var st = lastStateDoc;
      var waiting = activePlayerCount() > 0;
      // Players waiting but no active game: (re)start it.
      if (waiting && (!st || !st.phase || st.phase === 'idle') && !currentQ && !pendingWagerQ && !imgChecking) {
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
      var now = Date.now(); // deadlines are stamped with this TV's clock
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
      return p && (now - (p.lastSeen || 0) < 3 * 60 * 1000);
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
      // Covers question/reveal (deadlineTs), wager (wagerDeadlineTs) and podium (no deadline).
      var dl = st ? (st.deadlineTs || st.wagerDeadlineTs || 0) : 0;
      var stale = st && st.phase && st.phase !== 'idle' && (Date.now() - dl > 10000);
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
    var lifetime = Math.max(0, (cur.lifetime || 0) + delta);
    var month = Math.max(0, (cur.monthKey === tk.month ? (cur.month || 0) : 0) + delta);
    var day = Math.max(0, (cur.dayKey === tk.day ? (cur.day || 0) : 0) + delta);
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
    upd[base + '/lastSeen'] = CT.rest.ts();
  }

  function writeState(patch) {
    var base = {
      updatedAt: CT.rest.ts(),
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
      tag: q.tag || null,
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

  // Difficulty curve: questions get harder through the 10-question block.
  // Q1-Q2: easy warmup · Q3: hard (wager-up) · Q4-Q5: medium · Q6: hard (wager-up)
  // Q7: medium · Q8-Q9: hard (Q9 wager-up) · Q10: Final Wager (own draw)
  function difficultyForQib(qib) {
    if (qib <= 2) return 'easy';
    if (qib === 3) return 'hard'; // wager-up
    if (qib <= 5) return 'medium';
    if (qib === 6) return 'hard'; // wager-up
    if (qib === 7) return 'medium';
    return 'hard'; // Q8-Q9
  }

  /* ---- bank readiness: retry the load instead of silently stalling ---- */
  var bankLoading = null;
  function bankReady() { return bank && bank.length > 0; }
  function ensureBank() {
    if (bankReady()) return Promise.resolve(bank);
    if (bankLoading) return bankLoading;
    bankLoading = E.loadBank().then(function (b) {
      bank = b;
      mergeCustomIntoBank();
      return bank;
    }).catch(function (e) {
      console.warn('[bank] load failed, will retry: ' + (e && e.message));
      return null;
    }).then(function (b) { bankLoading = null; return b; });
    return bankLoading;
  }
  // Shown in the attract card slot (never on top of it) while the bank loads.
  function showLoadingCard() {
    stopAttractLoop();
    var ac = $('#arCard');
    if (ac) ac.innerHTML = '<div class="ar-eyebrow gold">Get ready</div><div class="ar-big chrome-text">LOADING<br>QUESTIONS</div>';
  }
  var bankRetryTimer = null;
  function waitForBankThenAdvance() {
    showLoadingCard();
    if (bankRetryTimer) return;
    ensureBank().then(function () {
      bankRetryTimer = setTimeout(function () {
        bankRetryTimer = null;
        if (bankReady()) advanceGame(); else waitForBankThenAdvance();
      }, bankReady() ? 50 : 5000);
    });
  }

  /* ---- picture questions: preload the image; a broken image = skip it ---- */
  var imgOk = {};
  var imgChecking = false;
  var pendingImgQ = null;
  function preloadImage(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var im = new Image();
      var t = setTimeout(function () { finish(false); }, timeoutMs || 5000);
      function finish(ok) { if (done) return; done = true; clearTimeout(t); im.onload = im.onerror = null; resolve(ok); }
      im.onload = function () { finish(im.naturalWidth > 0); };
      im.onerror = function () { finish(false); };
      im.src = url;
    });
  }
  function dropImageQuestions(url) {
    bank = bank.filter(function (x) { return x.image !== url; });
  }

  function dealQuestion() {
    if (!bankReady()) return waitForBankThenAdvance();
    if (imgChecking) return;
    var st = drawSettings();
    var qibPreview = blockDealt + 1; // what the next question-in-block will be
    var drawn = pendingImgQ ? { q: pendingImgQ, askedIds: askedIds, recentCats: recentCats } : E.drawQuestion({
      bank: bank, askedIds: askedIds, recentCats: recentCats,
      disabledCats: st.disabledCats, familyMode: st.familyMode,
      difficulty: difficultyForQib(qibPreview),
    });
    pendingImgQ = null;
    if (!drawn) {
      // Bank exhausted — reset asked history and try again (allows repeats after full cycle).
      askedIds = {};
      drawn = E.drawQuestion({
        bank: bank, askedIds: askedIds, recentCats: [],
        disabledCats: st.disabledCats, familyMode: st.familyMode,
        difficulty: difficultyForQib(qibPreview),
      });
      if (!drawn) return; // truly empty bank
    }
    var q = drawn.q;
    askedIds = drawn.askedIds; recentCats = drawn.recentCats;
    if (q.image && !imgOk[q.image]) {
      imgChecking = true;
      preloadImage(q.image, 5000).then(function (ok) {
        imgChecking = false;
        if (ok) { imgOk[q.image] = true; pendingImgQ = q; }
        else { console.warn('[bank] skipping picture question, image failed: ' + q.image); dropImageQuestions(q.image); }
        dealQuestion();
      });
      return;
    }
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
  var wagerToken = 0;
  function startWager(isWagerUp, qib) {
    if (!bankReady()) return waitForBankThenAdvance();
    // Guard: a wager window is already open (double advance or watchdog re-entry).
    // Re-entering would draw a new question and restart the countdown.
    if (pendingWagerQ) { console.warn('[wager] startWager ignored: wager already pending'); return; }
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
    var myToken = ++wagerToken;
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
      if (myToken !== wagerToken || !pendingWagerQ) return; // superseded
      clearTimer();
      questionTimer = setTimeout(dealWagerQuestion, secs * 1000 + 400);
    });
  }

  function dealWagerQuestion() {
    if (!pendingWagerQ) {
      // Nothing pending (already dealt). If the screen still says wager, close the slot
      // instead of letting advanceGame open a fresh wager window.
      var ls = lastStateDoc;
      if (ls && ls.phase === 'wager') blockDealt = Math.max(blockDealt, ls.questionInBlock || 0);
      return advanceGame();
    }
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
      // optional wager, capped at the player's current score (never forced, never negative)
      var w = Math.floor(Number(players[pid].wager) || 0);
      w = Math.max(0, Math.min(w, Math.floor(players[pid].score || 0)));
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
    var dethrones = [];
    // King of the Hill: snapshot the day-board #1 BEFORE scores update
    var preKing = dayLeader();
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
        var correctText = q.answerText || (q.options || [])[q.answer] || '';
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
      // Named tiers with escalating visuals: 100/500/1000/2500/5000/10000+
      var msKey = statsKey(p.name);
      var msCur = statsCache[msKey] || {};
      var msTk = todayKeys();
      var oldDay = (msCur.dayKey === msTk.day) ? (msCur.day || 0) : 0;
      var deltaScore = newScore - (p.score || 0);
      var newDay = oldDay + deltaScore;
      var MILESTONES = [
        { at: 100, tier: 1 }, { at: 500, tier: 2 }, { at: 1000, tier: 3 },
        { at: 2500, tier: 4 }, { at: 5000, tier: 5 }, { at: 10000, tier: 6 }
      ];
      for (var mi = 0; mi < MILESTONES.length; mi++) {
        if (oldDay < MILESTONES[mi].at && newDay >= MILESTONES[mi].at) {
          highScoreCelebrations.push({
            name: p.name, score: MILESTONES[mi].at,
            tier: MILESTONES[mi].tier, dayTotal: newDay
          });
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

    // King of the Hill: did the day-board #1 change? Compute post-update
    // day totals from statsCache + this round's deltas.
    (function () {
      if (!preKing) return; // no reigning champ, nothing to dethrone
      var tk = todayKeys();
      var postBest = null;
      Object.keys(statsCache).forEach(function (k) {
        var s = statsCache[k] || {};
        var v = moneyVal(s, 'day', tk);
        // add this round's delta for players who scored
        results.forEach(function (r) {
          if (r.name && statsKey(r.name) === k) v += r.delta;
        });
        if (v > 0 && (!postBest || v > postBest.val)) postBest = { name: s.name || '?', val: v };
      });
      // Also account for players not yet in statsCache
      results.forEach(function (r) {
        if (!r.name || !r.delta || r.delta <= 0) return;
        var k = statsKey(r.name);
        if (statsCache[k]) return; // already counted above
        var v = r.delta; // brand new player, day total = this delta
        if (!postBest || v > postBest.val) postBest = { name: r.name, val: v };
      });
      if (postBest && postBest.name !== preKing.name && postBest.val > preKing.val) {
        dethrones.push({
          newKing: postBest.name, oldKing: preKing.name,
          amount: postBest.val, oldAmount: preKing.val
        });
      }
    })();

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
        correctText: isTextQ ? (q.answerText || (q.options || [])[q.answer] || '') : ((q.options || [])[q.answer] || (isNumQ ? String(numAnswer) : "")),
        answerType: q.answerType || 'choice',
        answerNumber: isNumQ ? numAnswer : null,
        closestDiff: isNumQ ? (closestDiff === Infinity ? null : closestDiff) : null,
        ts: CT.rest.ts(),
        isWager: cq.isWager,
        wagerUp: !!cq.isWagerUp,
        isLightning: !!cq.isLightning,
        answeredCount: answeredCount,
        correctCount: correctCount,
        results: results.slice(0, 50),
        streakCallouts: streakCallouts.slice(0, 3),
        streaksLost: streaksLost.slice(0, 3),
        highScoreCelebrations: highScoreCelebrations.slice(0, 1),
        dethrones: dethrones.slice(0, 1),
      });
    }).then(function () {
      return writeState({ phase: 'reveal', podium: null });
    }).then(function () {
      // High-score celebrations now ride the reveal doc so every screen shows
      // them in the moment queue (see renderRevealFinal).
      var pause = cq.isWager ? E.WAGER_REVEAL_SECONDS : E.REVEAL_SECONDS;
      questionTimer = setTimeout(function () {
        if (cq.isWager && !cq.isWagerUp) showPodium(); else advanceGame();
      }, pause * 1000);
    });
  }

  /* ---------------- big-deal moments : one FIFO overlay, never overlapping ----------------
     Sendoffs, snapped streaks, wager-risked beats, streak milestones and high-score
     celebrations all queue here so they play back-to-back instead of colliding. */
  var momentQueue = [];
  var momentBusy = false;
  var momentToken = 0; // invalidates pending moment timeouts after a cut

  // After a pop-up clears, bring attract back only if nothing started meanwhile.
  function resumeAttractIfIdle() {
    var phase = (lastStateDoc && lastStateDoc.phase) || 'idle';
    if (phase === 'idle' && !questionTimer && !arRunning) startAttractLoop();
  }
  function momentIdle() { return !momentBusy && momentQueue.length === 0; }

  function queueMoment(m) {
    // m: { cls, html, dur, sound }
    // Jordan's rule: ANY popup/moment immediately stops attract mode.
    // The moment REPLACES the attract card, never overlays it.
    stopAttractLoop();
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
    document.body.classList.add('moment-on');
    stopAttractLoop();
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
        if (!momentQueue.length) { document.body.classList.remove('moment-on'); resumeAttractIfIdle(); }
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
    document.body.classList.remove('moment-on');
  }

  function escName(n) { return E.escapeHtml(String(n || 'Player').slice(0, 24)); }

  // warm classy sendoff when a player disconnects
  function sendoffMoment(name) {
    return {
      cls: 'sendoff', dur: 3000, sound: sSendoff,
      html: '<div class="moment-kicker">' + E.escapeHtml(ct('sendoffKicker')) + '</div>' +
        '<div class="moment-name">' + escName(name) + '</div>' +
        '<div class="moment-sub">' + E.escapeHtml(ct('sendoffSub')) + '</div>'
    };
  }

  // new player joins: full-screen hype BEFORE the game starts
  function challengerMoment(name) {
    return {
      cls: 'challenger', dur: 2200, sound: sFanfare,
      html: '<div class="moment-kicker glow">' + E.escapeHtml(ct('challengerKicker')) + '</div>' +
        '<div class="moment-name huge">' + escName(name) + '</div>' +
        '<div class="moment-line">' + E.escapeHtml(ct('challengerLine')) + '</div>'
    };
  }

  // streak snapped: cinematic, not punishing
  function snappedMoment(name, n) {
    return {
      cls: 'snapped', dur: 2800, sound: sStreakLost,
      html: '<div class="moment-kicker">' + E.escapeHtml(ct('snappedKicker')) + '</div>' +
        '<div class="moment-flame css"></div>' +
        '<div class="moment-name">' + escName(name) + '</div>' +
        '<div class="moment-line">' + n + ' in a row</div>' +
        '<div class="moment-sub">' + E.escapeHtml(ct('snappedSub')) + '</div>'
    };
  }

  // big wager loss: "{name} risked {x}" beat before the result lands
  function wagerBeatMoment(losses) {
    var label = losses.length === 1 ? escName(losses[0].name) : losses.length + ' players';
    var amt = Math.max.apply(null, losses.map(function (x) { return x.wager; }));
    return {
      cls: 'wagerbeat', dur: 2400, sound: sRiskBeat,
      html: '<div class="moment-kicker">' + E.escapeHtml(ct('wagerBeatKicker')) + '</div>' +
        '<div class="moment-name">' + label + '</div>' +
        '<div class="moment-line chrome-text">Risked ' + E.fmtNum(amt) + '</div>'
    };
  }

  // streak milestones with escalating treatment: 3/5, 10, 15, 20+
  function streakMoment(name, n) {
    var tier = n >= 20 ? 't4' : n >= 15 ? 't3' : n >= 10 ? 't2' : 't1';
    var kicker = n >= 20 ? ct('streakT4') : n >= 15 ? ct('streakT3') : n >= 10 ? ct('streakT2') : ct('streakT1');
    return {
      cls: 'streak ' + tier,
      dur: n >= 20 ? 3400 : 2600,
      sound: function () { sStreak(n); if (n >= 20) setTimeout(sBigWin, 700); },
      html: '<div class="moment-kicker">' + E.escapeHtml(kicker) + '</div>' +
        '<div class="moment-flame">' + (n >= 15 ? '<span class="css-flame"></span><span class="css-flame"></span>' : '<span class="css-flame"></span>') + '</div>' +
        '<div class="moment-name">' + escName(name) + '</div>' +
        '<div class="moment-line chrome-text">' + n + ' in a row</div>'
    };
  }

  // "NEW HIGH SCORE — REESE GETS TO 400" with named milestone tiers
  // Tier visuals escalate: t1 gold burst → t3 screen shake → t6 confetti rain
  function celebrationMoment(name, score, tier) {
    tier = tier || 1;
    var tierKey = 'milestoneT' + Math.min(6, Math.max(1, tier));
    var tierName = ct(tierKey);
    var cls = 'celebration mt' + tier;
    var dur = tier >= 5 ? 4000 : tier >= 3 ? 3500 : 3000;
    var sound = function () {
      sBigWin();
      if (tier >= 4) setTimeout(sFanfare, 600);
    };
    return {
      cls: cls, dur: dur, sound: sound,
      html: '<div class="moment-kicker glow">' + E.escapeHtml(ct('celebrationKicker')) + '</div>' +
        '<div class="moment-tier">' + E.escapeHtml(tierName) + '</div>' +
        '<div class="moment-name huge">' + escName(name) + '</div>' +
        '<div class="moment-line">Gets to ' + E.fmtNum(score) + '</div>' +
        (tier >= 6 ? '<div class="confetti-rain"></div>' : '')
    };
  }

  // KING OF THE HILL: full-screen takeover when #1 is dethroned
  function kingMoment(d) {
    var line = fillTokens(ctHtml('kingLine'), { old: d.oldKing, amount: E.fmtNum(d.amount) });
    return {
      cls: 'king', dur: 3800, sound: function () { sFanfare(); setTimeout(sBigWin, 500); },
      html: '<div class="moment-kicker glow">' + E.escapeHtml(ct('kingKicker')) + '</div>' +
        '<div class="moment-name huge">' + escName(d.newKing) + '</div>' +
        '<div class="moment-line">' + line + '</div>'
    };
  }

  // Dethroned drama: the loser gets a comedic moment too
  function dethronedMoment(d) {
    return {
      cls: 'dethroned', dur: 2800, sound: sStreakLost,
      html: '<div class="moment-kicker">' + E.escapeHtml(ct('dethronedKicker')) + '</div>' +
        '<div class="moment-name">' + escName(d.oldKing) + '</div>' +
        '<div class="moment-sub">' + E.escapeHtml(ct('dethronedSub')) + '</div>'
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
    // Fallback: if activePlayerCount is 0 but player records exist with names,
    // treat as players present (handles lastSeen clock-skew issues).
    var pCount = activePlayerCount();
    if (pCount === 0) {
      var hasNames = Object.keys(players).some(function (pid) {
        var p = players[pid];
        return p && p.name && p.present !== false;
      });
      if (hasNames) pCount = 1;
    }
    if (pCount === 0) {
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

  // First players snapshot is silent: on TV reload, existing players must
  // not trigger NEW CHALLENGER spam.
  var playersSnapSeen = false;

  // Names of players who freshly joined in this snapshot (not present before,
  // or returning after a disconnect). Empty on the first snapshot.
  function detectJoins(oldP, newP) {
    var out = [];
    if (!playersSnapSeen) return out;
    oldP = oldP || {};
    Object.keys(newP || {}).forEach(function (pid) {
      var rec = newP[pid];
      if (!rec || !rec.name) return;
      var was = oldP[pid] && oldP[pid].present !== false;
      var isNow = rec.present !== false;
      if (isNow && !was) out.push(String(rec.name).slice(0, 24));
    });
    return out.slice(0, 3); // cap: never queue a parade
  }

  function onPlayers(snap) {
    var next = snap.val() || {};
    var wasEmpty = activePlayerCount() === 0;
    detectLeaves(players, next);
    var newJoins = detectJoins(players, next);
    players = next;
    playersSnapSeen = true;
    var nowEmpty = activePlayerCount() === 0;
    renderBoard();
    renderPlayerCount();
    pushBoardToState();
    var st = lastStateDoc;
    var gameRunning = st && st.phase && st.phase !== 'idle';
    if (newJoins.length && !gameRunning) {
      // Jordan's rule: NEW CHALLENGER celebration plays FIRST, then the game
      // starts immediately after. Re-arm the timer directly so a second quick
      // join extends the wait instead of overlapping the question.
      newJoins.forEach(function (nm) { queueMoment(challengerMoment(nm)); });
      var delay = 2500 * newJoins.length + 400;
      lastKickstartTs = Date.now();
      clearTimer();
      questionTimer = setTimeout(function () { advanceGame(); }, delay);
    } else if (wasEmpty && !nowEmpty && !gameRunning) {
      // fallback: players waiting but no discrete join detected (e.g. TV boot)
      kickstartGame(500);
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
    onCustomQuestionsChanged();
    renderCustomQuestions();
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
    return '<span class="sflame css ' + tier + '"><span class="n">' + n + '</span></span>';
  }

  function renderBoard() {
    var board = E.leaderboard(players, 'block').slice(0, 10);
    var el = $('#blockBoard');
    el.innerHTML = '';
    if (!board.length) {
      el.innerHTML = '<div class="board-empty">No scores yet</div>';
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
      return now - (players[pid].lastSeen || 0) < 3 * 60 * 1000;
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
    document.body.classList.toggle('in-attract', name === 'idle');
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

  // Pick a size class by length so short questions read big and long ones never overflow.
  function fitText(el) {
    if (!el) return;
    var n = (el.textContent || '').length;
    el.classList.remove('fit-s', 'fit-m', 'fit-l', 'fit-xl');
    el.classList.add(n <= 50 ? 'fit-s' : n <= 95 ? 'fit-m' : n <= 170 ? 'fit-l' : 'fit-xl');
  }

  // ---- Look (Arcade Cyan default / Millionaire Blue), saved on this TV ----
  var LOOKS = ['look-cyan', 'look-blue'];
  function applyLook(look) {
    if (LOOKS.indexOf(look) < 0) look = 'look-cyan';
    LOOKS.forEach(function (c) { document.body.classList.toggle(c, c === look); });
    try { localStorage.setItem('ct-look', look); } catch (e) {}
    var bs = document.querySelectorAll('.look-btn');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('active', bs[i].getAttribute('data-look') === look);
  }
  (function initLook() {
    var saved = null;
    try { saved = localStorage.getItem('ct-look'); } catch (e) {}
    applyLook(saved || 'look-cyan');
    var bs = document.querySelectorAll('.look-btn');
    for (var i = 0; i < bs.length; i++) bs[i].addEventListener('click', function () { applyLook(this.getAttribute('data-look')); });
  })();

  // ---- D-pad navigation: arrows move focus to the nearest button in that direction ----
  document.addEventListener('keydown', function (e) {
    var dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!dir) return;
    var t = document.activeElement;
    if (t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    var ov = document.getElementById('settingsOverlay');
    var scope = (ov && !ov.hidden) ? ov : document;
    var els = Array.prototype.filter.call(scope.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])'), function (el) {
      return !el.disabled && el.offsetParent !== null;
    });
    if (!els.length) return;
    e.preventDefault();
    if (!t || els.indexOf(t) < 0) { (scope === document ? (document.getElementById('btnSettings') || els[0]) : els[0]).focus(); return; }
    var a = t.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, best = null, bestD = 1e9;
    els.forEach(function (el) {
      if (el === t) return;
      var b = el.getBoundingClientRect(), dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
      var along = dx * dir[0] + dy * dir[1];
      if (along <= 4) return;
      var d = along + 2.5 * Math.abs(dx * dir[1] + dy * dir[0]);
      if (d < bestD) { bestD = d; best = el; }
    });
    if (best) { best.focus(); if (best.scrollIntoView) best.scrollIntoView({ block: 'nearest' }); }
  });

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

  // ---- attract teaser pool: REAL questions from the bank ----
  // Rebuilt lazily when the bank loads/changes. Short (<140 char), kid-safe,
  // resolvable answer. Image questions preferred on the big screen.
  var arPool = [];
  var arPoolImg = [];
  var arPoolSig = '';
  var arRecentIds = []; // avoid immediate repeats

  // 50-question hardcoded fallback — used only when the bank hasn't loaded
  // or fails. No empty states, no "coming soon".
  var AR_FALLBACK = [
    { q: "What planet is known as the Red Planet?", a: "Mars", cat: "Science" },
    { q: "Who painted the Mona Lisa?", a: "Leonardo da Vinci", cat: "Art" },
    { q: "What is the largest ocean on Earth?", a: "Pacific Ocean", cat: "Geography" },
    { q: "In what year did the Titanic sink?", a: "1912", cat: "History" },
    { q: "Who wrote 'Romeo and Juliet'?", a: "William Shakespeare", cat: "Literature" },
    { q: "What is the capital of Japan?", a: "Tokyo", cat: "Geography" },
    { q: "How many sides does a hexagon have?", a: "6", cat: "Math" },
    { q: "What gas do plants absorb from the atmosphere?", a: "Carbon dioxide", cat: "Science" },
    { q: "Who was the first person to walk on the moon?", a: "Neil Armstrong", cat: "History" },
    { q: "What is the largest mammal in the world?", a: "Blue whale", cat: "Nature" },
    { q: "How many players does a baseball team field?", a: "9", cat: "Sports" },
    { q: "Which cowboy stars in Toy Story?", a: "Woody", cat: "Movies" },
    { q: "Which band sang 'Yellow Submarine'?", a: "The Beatles", cat: "Music" },
    { q: "What is H2O commonly known as?", a: "Water", cat: "Science" },
    { q: "On which continent is the Sahara Desert?", a: "Africa", cat: "Geography" },
    { q: "Who was the first U.S. president?", a: "George Washington", cat: "History" },
    { q: "Pizza originated in which country?", a: "Italy", cat: "Food" },
    { q: "What is the fastest land animal?", a: "Cheetah", cat: "Nature" },
    { q: "What is the largest planet in our solar system?", a: "Jupiter", cat: "Space" },
    { q: "How many points is a touchdown worth?", a: "6", cat: "Sports" },
    { q: "'Let It Go' is from which Disney movie?", a: "Frozen", cat: "Movies" },
    { q: "Who is known as the King of Pop?", a: "Michael Jackson", cat: "Music" },
    { q: "Water boils at how many degrees Celsius?", a: "100", cat: "Science" },
    { q: "What is the capital of France?", a: "Paris", cat: "Geography" },
    { q: "In what year did the Berlin Wall fall?", a: "1989", cat: "History" },
    { q: "How many legs does a spider have?", a: "8", cat: "Nature" },
    { q: "How many rings are on the Olympic flag?", a: "5", cat: "Sports" },
    { q: "What is the lion's name in The Lion King?", a: "Simba", cat: "Movies" },
    { q: "Who wrote the Harry Potter books?", a: "J.K. Rowling", cat: "Literature" },
    { q: "Which planet is famous for its rings?", a: "Saturn", cat: "Space" },
    { q: "In which country are the ancient pyramids of Giza?", a: "Egypt", cat: "History" },
    { q: "Hamburgers are named after which German city?", a: "Hamburg", cat: "Food" },
    { q: "What is the largest bird that cannot fly?", a: "Ostrich", cat: "Nature" },
    { q: "What galaxy do we live in?", a: "Milky Way", cat: "Space" },
    { q: "In tennis, what is a zero score called?", a: "Love", cat: "Sports" },
    { q: "What kind of fish is Nemo?", a: "Clownfish", cat: "Movies" },
    { q: "How many strings does a standard guitar have?", a: "6", cat: "Music" },
    { q: "What force pulls objects toward Earth?", a: "Gravity", cat: "Science" },
    { q: "What is the capital of the United States?", a: "Washington, D.C.", cat: "Geography" },
    { q: "In what year did humans first land on the moon?", a: "1969", cat: "History" },
    { q: "What is the tallest land animal?", a: "Giraffe", cat: "Nature" },
    { q: "How high is a basketball hoop, in feet?", a: "10", cat: "Sports" },
    { q: "Who is Shrek's wisecracking sidekick?", a: "Donkey", cat: "Movies" },
    { q: "Moby Dick is what kind of animal?", a: "Whale", cat: "Literature" },
    { q: "How many bones are in the adult human body?", a: "206", cat: "Science" },
    { q: "On which continent is Brazil?", a: "South America", cat: "Geography" },
    { q: "Who is credited with inventing the light bulb?", a: "Thomas Edison", cat: "History" },
    { q: "What do giant pandas mainly eat?", a: "Bamboo", cat: "Nature" },
    { q: "How many moons does Earth have?", a: "1", cat: "Space" },
    { q: "What do you call a group of wolves?", a: "Pack", cat: "Nature" }
  ];
  var arTeaserIdx = 0;
  var bankFailed = false;
  var arLastTeaser = null;

  // Resolve a displayable answer for any bank question shape:
  // options+answer index, answerText, or numeric (closest-wins).
  function arAnswerFor(q) {
    if (!q) return '';
    if (q.answerType === 'number' && q.answerNumber != null) return String(q.answerNumber);
    try { var t = E.answerTextOf(q); if (t) return t; } catch (e) {}
    return '';
  }

  // Attract teasers: ONE shuffled no-repeat queue over the whole eligible
  // bank. Order is a seeded shuffle; {seed, cursor} persists in localStorage
  // so a reload picks up where it left off instead of replaying the same few.
  var AR_Q_KEY = 'ct-attract-queue';
  var arOrder = [];
  var arQ = { seed: 0, idx: 0, sig: '' };
  function arHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function arRng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function arSaveQ() { try { localStorage.setItem(AR_Q_KEY, JSON.stringify(arQ)); } catch (e) {} }
  function arShuffle() {
    var r = arRng(arQ.seed);
    for (var i = arOrder.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var t = arOrder[i]; arOrder[i] = arOrder[j]; arOrder[j] = t;
    }
  }
  function arBuildPool() {
    var sig = (bank ? bank.length : 0) + ':' + (bank && bank.length ? (bank[0].id || '') : '');
    if (sig === arPoolSig && arOrder.length) return;
    arPoolSig = sig;
    arPool = []; arPoolImg = []; arOrder = [];
    if (!bank || !bank.length) return;
    for (var i = 0; i < bank.length; i++) {
      var q = bank[i];
      if (!q) continue;
      var text = q.question || q.text || '';
      if (text.length > 140 || text.length < 15) continue;
      if (q.kid_safe === false) continue;
      if (!arAnswerFor(q)) continue;
      // Favor easy/medium; keep ~15% of hard ones (deterministic per id).
      var diff = q.difficulty || 'medium';
      if (diff === 'hard' && (arHash(String(q.id || text)) % 100) >= 15) continue;
      arOrder.push(q);
    }
    arOrder.sort(function (x, y) { return String(x.id || x.question) < String(y.id || y.question) ? -1 : 1; });
    try { var saved = JSON.parse(localStorage.getItem(AR_Q_KEY) || 'null'); if (saved) arQ = saved; } catch (e) {}
    var poolSig = arOrder.length + ':' + String(arOrder[0] && (arOrder[0].id || ''));
    if (arQ.sig !== poolSig || !arQ.seed) { arQ = { seed: (Math.random() * 4294967296) >>> 0, idx: 0, sig: poolSig }; }
    arShuffle();
    arSaveQ();
  }

  function arPickTeaser() {
    arBuildPool();
    if (arOrder.length) {
      if (arQ.idx >= arOrder.length) {          // full pass done: reshuffle
        arQ.seed = (arQ.seed * 1103515245 + 12345) >>> 0 || 1;
        arQ.idx = 0;
        arShuffle();
      }
      var picked = arOrder[arQ.idx++];
      arSaveQ();
      arLastTeaser = picked;
      return picked;
    }
    // bank still loading: don't burn a fallback teaser (it would repeat on every boot)
    if (!bankFailed) return null;
    // bank failed: cycle the 50 hardcoded (no repeats within a cycle)
    var f = AR_FALLBACK[arTeaserIdx % AR_FALLBACK.length];
    arTeaserIdx++;
    arLastTeaser = { question: f.q, text: f.q, category: f.cat, answerText: f.a };
    return arLastTeaser;
  }

  function arTeaserHtml() {
    var q = arPickTeaser();
    if (!q) return '<div class="ar-eyebrow">Cave Trivia</div><div class="ar-big chrome-text">SCAN TO PLAY</div>';
    var text = q.question || q.text || '';
    var cat = E.fmtCategory(q.category);
    var img = q.image ? '<div class="ar-teaser-img" style="background-image:url(' + E.escapeHtml(q.image) + ')"></div>' : '';
    return img +
      '<div class="ar-eyebrow">' + fillTokens(ctHtml('teaserEyebrow'), { category: cat }) + '</div>' +
      '<div class="ar-question">' + E.escapeHtml(text) + '</div>' +
      '<div class="ar-cta-line">' + ctHtml('teaserCta') + '</div>';
  }

  function arTeaserAnswerHtml(q) {
    var ans = arAnswerFor(q);
    var img = q.image ? '<div class="ar-teaser-img dim" style="background-image:url(' + E.escapeHtml(q.image) + ')"></div>' : '';
    return img +
      '<div class="ar-eyebrow gold">' + E.escapeHtml(ct('teaserAnswerEyebrow')) + '</div>' +
      '<div class="ar-answer chrome-text">' + E.escapeHtml(ans) + '</div>' +
      '<div class="ar-cta-line">' + ctHtml('teaserAnswerCta') + '</div>';
  }

  function arJoinHtml() {
    var svg = arQrSvg();
    return '<div class="ar-eyebrow">' + ctHtml('joinEyebrow') + '</div>' +
      '<div class="ar-join-row">' +
      (svg ? '<div class="ar-qr">' + svg + '</div>' : '') +
      '<div class="ar-join-text"><div class="ar-big chrome-text">' + ctHtml('joinTitle') + '</div>' +
      '<div class="ar-sub">' + E.escapeHtml(ct('joinSub')) + '</div></div>' +
      '</div>';
  }

  // ---- money board: ranked by winnings, three views (day / month / all time) ----
  // Each view gets its own card slot in the rotation; the tab strip shows
  // which view is active.

  function moneyVal(s, view, tk) {
    if (view === 'day') return (s.dayKey === tk.day) ? (s.day || 0) : 0;
    if (view === 'month') return (s.monthKey === tk.month) ? (s.month || 0) : 0;
    return s.lifetime || 0;
  }

  // Current #1 on the day money board (for King of the Hill dethrone detection).
  function dayLeader() {
    var tk = todayKeys();
    var best = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      var v = moneyVal(s, 'day', tk);
      if (v > 0 && (!best || v > best.val)) best = { name: s.name || '?', val: v };
    });
    return best;
  }

  function arMoneyTabs(activeView) {
    var tabs = [
      ['day', ct('moneyTabDay')],
      ['month', ct('moneyTabMonth')],
      ['all', ct('moneyTabAll')]
    ];
    var html = '<div class="ar-tabs" role="tablist">';
    tabs.forEach(function (t) {
      html += '<span class="ar-tab' + (t[0] === activeView ? ' active' : '') + '">' +
        E.escapeHtml(t[1]) + '</span>';
    });
    return html + '</div>';
  }

  function arMoneyHtml(view) {
    var tk = todayKeys();
    var list = Object.keys(statsCache).map(function (k) { return statsCache[k]; })
      .filter(function (s) { return moneyVal(s, view, tk) > 0; })
      .sort(function (a, b) { return moneyVal(b, view, tk) - moneyVal(a, view, tk); })
      .slice(0, 5);
    var rows;
    if (list.length) {
      rows = '<div class="ar-rows money-rows">';
      // Record-chase: #1's score for the "X from the record" labels
      var topScore = list.length ? moneyVal(list[0], view, tk) : 0;
      list.forEach(function (s, i) {
        var val = moneyVal(s, view, tk);
        var chase = '';
        if (i > 0 && topScore > val) {
          var behind = topScore - val;
          chase = '<div class="ar-chase">' + fillTokens(E.escapeHtml(ct('chaseLabel')), {
            n: E.fmtNum(behind)
          }) + '</div>';
        }
        rows += '<div class="ar-row money-row' + (i === 0 ? ' first' : '') + '">' +
          '<span class="ar-rank">' + (i + 1) + '</span>' +
          '<span class="ar-name">' + E.escapeHtml(s.name || '?') + chase + '</span>' +
          '<span class="ar-score money-score">$' + E.fmtNum(val) + '</span></div>';
      });
      rows += '</div>';
    } else {
      rows = '<div class="ar-sub">' + E.escapeHtml(ct('moneyEmpty')) + '</div>';
    }
    return '<div class="ar-eyebrow money-eyebrow">' + E.escapeHtml(ct('moneyEyebrow')) + '</div>' +
      '<div class="ar-big chrome-text">' + ctHtml('moneyTitle') + '</div>' +
      arMoneyTabs(view) + rows;
  }

  // ---- streak board: ranked by best streak, shows current + best ----

  function arStreaksHtml() {
    var list = Object.keys(statsCache).map(function (k) { return statsCache[k]; })
      .filter(function (s) { return (s.bestStreak || 0) >= 2; })
      .sort(function (a, b) { return (b.bestStreak || 0) - (a.bestStreak || 0); })
      .slice(0, 5);
    var rows;
    if (list.length) {
      rows = '<div class="ar-rows streak-rows">' +
        '<div class="ar-colheads"><span class="ar-ch-rank"></span>' +
        '<span class="ar-ch-name"></span>' +
        '<span class="ar-colhead">' + E.escapeHtml(ct('streakColNow')) + '</span>' +
        '<span class="ar-colhead">' + E.escapeHtml(ct('streakColBest')) + '</span></div>';
      list.forEach(function (s, i) {
        var now = s.streak || 0;
        var fire = now >= 3 ? '<span class="streak-fire" aria-hidden="true"></span>' : '';
        rows += '<div class="ar-row streak-row' + (i === 0 ? ' first' : '') + '">' +
          '<span class="ar-rank">' + (i + 1) + '</span>' +
          '<span class="ar-name">' + E.escapeHtml(s.name || '?') + '</span>' +
          '<span class="ar-streak-now">' + fire + now + '</span>' +
          '<span class="ar-streak-best">' + (s.bestStreak || 0) + '</span></div>';
      });
      rows += '</div>';
    } else {
      rows = '<div class="ar-sub">' + E.escapeHtml(ct('streakEmpty')) + '</div>';
    }
    return '<div class="ar-eyebrow streak-eyebrow">' + E.escapeHtml(ct('streakEyebrow')) + '</div>' +
      '<div class="ar-big chrome-text">' + ctHtml('streakTitle') + '</div>' + rows;
  }

  function arLegendsHtml() {
    var best = null, rich = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      if ((s.bestStreak || 0) >= 3 && (!best || s.bestStreak > best.bestStreak)) best = s;
      if ((s.lifetime || 0) > 0 && (!rich || s.lifetime > rich.lifetime)) rich = s;
    });
    var bits = '';
    if (best) bits += '<div class="ar-legend"><div class="ar-legend-kicker">Longest streak ever</div>' +
      '<div class="ar-legend-name chrome-text">' + E.escapeHtml(best.name) + '</div>' +
      '<div class="ar-legend-line">' + best.bestStreak + ' correct in a row</div></div>';
    if (rich && (!best || rich.name !== best.name)) bits += '<div class="ar-legend"><div class="ar-legend-kicker">Richest player ever</div>' +
      '<div class="ar-legend-name chrome-text">' + E.escapeHtml(rich.name) + '</div>' +
      '<div class="ar-legend-line">' + E.fmtNum(rich.lifetime) + ' lifetime</div></div>';
    if (lastHighlight && Date.now() - lastHighlight.ts < 24 * 60 * 60 * 1000) {
      var h = lastHighlight;
      bits += '<div class="ar-legend"><div class="ar-legend-kicker">Latest big moment</div>' +
        '<div class="ar-legend-name">' + E.escapeHtml(h.name) + '</div>' +
        '<div class="ar-legend-line">' + (h.type === 'wager' ? 'banked +' + E.fmtNum(h.amount) + ' on a wager' : h.amount + ' in a row') + '</div></div>';
    }
    if (!bits) bits = '<div class="ar-sub">' + E.escapeHtml(ct('legendsEmpty')) + '</div>';
    return '<div class="ar-eyebrow gold">' + E.escapeHtml(ct('legendsEyebrow')) + '</div>' +
      '<div class="ar-big chrome-text">' + ctHtml('legendsTitle') + '</div>' + bits +
      '<div class="ar-cta-line">' + ctHtml('legendsCta') + '</div>';
  }

  // Teasers appear often: Jordan wants TONS of questions on attract.
  // Money board gets 3 slots (one per view: day / month / all time), each
  // with a tab strip showing the active view. Streaks gets its own slot.
  var AR_CARDS = [
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'join', html: arJoinHtml },
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'money-day', html: function () { return arMoneyHtml('day'); } },
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'money-month', html: function () { return arMoneyHtml('month'); } },
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'money-all', html: function () { return arMoneyHtml('all'); } },
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'streaks', html: arStreaksHtml },
    { name: 'teaser', html: arTeaserHtml, teaser: true },
    { name: 'legends', html: arLegendsHtml },
  ];

  function arShow(idx) {
    var card = AR_CARDS[idx % AR_CARDS.length];
    var el = $('#arCard');
    if (!el) return;
    if (arTeaserTimer) { clearTimeout(arTeaserTimer); arTeaserTimer = null; }
    el.classList.add('fade');
    setTimeout(function () {
      var html;
      try { html = card.html(); }
      catch (e) { html = '<div class="ar-eyebrow">Cave Trivia</div><div class="ar-big chrome-text">SCAN TO PLAY</div>'; }
      el.innerHTML = html;
      el.classList.remove('fade');
      // teaser card flips to the answer after 6s (readable pace)
      if (card.teaser) {
        arTeaserTimer = setTimeout(function () {
          if (!arRunning) return;
          var qq = arLastTeaser;
          if (!qq) return;
          el.classList.add('fade');
          setTimeout(function () {
            try { el.innerHTML = arTeaserAnswerHtml(qq); } catch (e) { /* keep question */ }
            el.classList.remove('fade');
          }, 450);
        }, 6000);
      }
    }, 450);
  }

  // Dedicated liveness flag: the old code gated the interval on
  // `lastPhase === 'idle'`, but lastPhase starts as '' and is only set when
  // the Firebase state listener fires cleanly. If that chain hiccups, the
  // first tick killed the loop forever. arRunning is set/cleared only by
  // start/stop, so the loop is self-consistent.
  var arRunning = false;
  function startAttractLoop() {
    if (arTimer) return;
    arRunning = true;
    arIdx = 0;
    arShow(0);
    arTimer = setInterval(function () {
      if (!arRunning) { stopAttractLoop(); return; }
      arIdx = (arIdx + 1) % AR_CARDS.length;
      arShow(arIdx);
    }, 12000);
  }

  function stopAttractLoop() {
    arRunning = false;
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
    if (hot) out.push('<b>' + E.escapeHtml(hot.name) + '</b> is on a <b>' + hot.streak + '-streak</b>');
    // biggest day total
    var rich = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      if (s.dayKey === tk.day && (s.day || 0) > 0 && (!rich || s.day > rich.day)) rich = s;
    });
    if (rich && (!hot || rich.name !== hot.name)) out.push('<b>' + E.escapeHtml(rich.name) + '</b> is up <b>' + E.fmtNum(rich.day) + '</b> today');
    // reigning champ: all-time #1 (storyline for non-players)
    var champ = null;
    Object.keys(statsCache).forEach(function (k) {
      var s = statsCache[k] || {};
      if ((s.lifetime || 0) > 0 && (!champ || s.lifetime > champ.lifetime)) champ = s;
    });
    if (champ) out.push(fillTokens(ctHtml('tickerChamp'), {
      name: champ.name || '?', amount: E.fmtNum(champ.lifetime || 0)
    }));
    // latest big moment (30 min window)
    if (lastHighlight && Date.now() - lastHighlight.ts < 30 * 60 * 1000) {
      var h = lastHighlight;
      out.push(h.type === 'wager'
        ? '<b>' + E.escapeHtml(h.name) + '</b> just banked <b>+' + E.fmtNum(h.amount) + '</b> on a wager'
        : '<b>' + E.escapeHtml(h.name) + '</b> hit <b>' + h.amount + ' in a row</b>');
    }
    // social proof: players in right now
    var now = serverNow();
    var active = Object.keys(players).filter(function (pid) {
      return now - (players[pid].lastSeen || 0) < 3 * 60 * 1000;
    }).length;
    if (active > 0) out.push(fillTokens(ctHtml('tickerPlaying'), { n: active }));
    else out.push(E.escapeHtml(ct('tickerEmpty')));
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
      ? 'Hard one. Bet it on your phone.'
      : 'Bet up to your score. On your phone.';
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
      $('#qCat').textContent = E.fmtCategory(q.category) + (q.tag ? ' \u00B7 ' + String(q.tag).toUpperCase() : '');
      // Millionaire questions show the money-ladder rung for this slot.
      var LADDER = ['$100', '$500', '$1,000', '$5,000', '$10,000', '$50,000', '$100,000', '$250,000', '$500,000', '$1 MILLION'];
      var qibNow = (lastStateDoc && lastStateDoc.questionInBlock) || 1;
      $('#qDiff').textContent = q.category === 'millionaire'
        ? LADDER[Math.max(0, Math.min(9, qibNow - 1))]
        : (q.isLightning ? E.LIGHTNING_POINTS : E.BASE_POINTS) + ' PTS';
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
      fitText(qTextEl);
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
        img.onerror = function () { img.removeAttribute('src'); media.hidden = true; media.classList.remove('bleed'); };
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
    $('#rText').textContent = qd.text || ''; fitText($('#rText'));
    // options shown dimmed, correct answer NOT highlighted yet
    if (r.answerType === 'text') {
      $('#rOptions').innerHTML = '<div class="q-text-hint">ANSWER</div>';
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
    $('#rText').textContent = qd.text || ''; fitText($('#rText'));
    var isNumR = r.answerType === 'number';
    if (isNumR) {
      $('#rOptions').innerHTML = '<div class="q-text-hint"><span class="hint-kicker">ANSWER</span>' +
        '<span class="answer-hero">' + E.fmtNum(r.answerNumber) + '</span></div>';
    } else if (r.answerType === 'text') {
      $('#rOptions').innerHTML = '<div class="q-text-hint">ANSWER</div>';
    } else {
      buildOptions($('#rOptions'), qd.options || [], r.correctIndex, true);
    }
    var note;
    if (isNumR) {
      var winners = (r.results || []).filter(function (x) { return x.correct; });
      var wnames = winners.slice(0, 3).map(function (x) { return E.escapeHtml(x.name); }).join(', ');
      note = '<b>Closest wins</b> &middot; ' + E.fmtNum(r.answerNumber) +
        (wnames ? ' &nbsp;<span style="color:var(--gold)">&#9733; ' + wnames + '</span>' : '');
    } else {
      note = '<span class="answer-hero">' + E.escapeHtml(r.correctText || '') + '</span>' +
        '<span class="answer-meta"><b>' + (r.correctCount || 0) + '</b> of <b>' + (r.answeredCount || 0) +
        '</b> answered correctly</span>';
    }
    if (r.streaksLost && r.streaksLost.length) {
      var sl = r.streaksLost[0];
      note += ' &nbsp;<span style="color:#ff8f7d">' + E.escapeHtml(sl.name) +
        ' streak over (' + sl.streak + ')</span>';
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
    // dethrone first (biggest), then celebration, then top streak milestones,
    // then the biggest snapped streak, then dethroned drama.
    if (r.dethrones && r.dethrones.length) {
      var dt = r.dethrones[0];
      queueMoment(kingMoment(dt));
    }
    if (r.highScoreCelebrations && r.highScoreCelebrations.length) {
      var hc = r.highScoreCelebrations[0];
      queueMoment(celebrationMoment(hc.name, hc.score, hc.tier));
    }
    (r.streakCallouts || []).slice()
      .sort(function (a, b) { return b.streak - a.streak; })
      .slice(0, 2)
      .forEach(function (sc) { queueMoment(streakMoment(sc.name, sc.streak)); });
    var snaps = (r.streaksLost || []).slice()
      .sort(function (a, b) { return b.streak - a.streak; })
      .slice(0, 1);
    snaps.forEach(function (sl) { queueMoment(snappedMoment(sl.name, sl.streak)); });
    if (r.dethrones && r.dethrones.length) {
      queueMoment(dethronedMoment(r.dethrones[0]));
    }
  }

  function renderPodiumState(st) {
    var p = st.podium;
    var pe = $('#podiumEyebrow');
    if (pe) pe.innerHTML = fillTokens(ctHtml('podiumEyebrow'), { n: st.blockNum || '' });
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
    return Math.max(0, deadlineTs - Date.now());
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
    syncCustomTextInputs();
    applyCustomChrome();
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

  /* ---------------- customize text ---------------- */

  var CUSTOM_TEXT_SCHEMA = [
    { group: 'Question teasers', keys: [
      { key: 'teaserEyebrow', label: 'Teaser eyebrow', hint: '{category} = question category' },
      { key: 'teaserCta', label: 'Teaser call to action' },
      { key: 'teaserAnswerEyebrow', label: 'Answer reveal eyebrow' },
      { key: 'teaserAnswerCta', label: 'Answer reveal call to action' }
    ] },
    { group: 'Join card', keys: [
      { key: 'joinEyebrow', label: 'Eyebrow' },
      { key: 'joinTitle', label: 'Title' },
      { key: 'joinSub', label: 'Subtitle' }
    ] },
    { group: 'Money board', keys: [
      { key: 'moneyEyebrow', label: 'Eyebrow' },
      { key: 'moneyTitle', label: 'Title' },
      { key: 'moneyTabDay', label: 'Today tab' },
      { key: 'moneyTabMonth', label: 'Month tab' },
      { key: 'moneyTabAll', label: 'All-time tab' },
      { key: 'moneyEmpty', label: 'Empty state text' }
    ] },
    { group: 'Streak board', keys: [
      { key: 'streakEyebrow', label: 'Eyebrow' },
      { key: 'streakTitle', label: 'Title' },
      { key: 'streakColNow', label: 'Current column header' },
      { key: 'streakColBest', label: 'Best column header' },
      { key: 'streakEmpty', label: 'Empty state text' }
    ] },
    { group: 'Legends card', keys: [
      { key: 'legendsEyebrow', label: 'Eyebrow' },
      { key: 'legendsTitle', label: 'Title' },
      { key: 'legendsEmpty', label: 'Empty state text' },
      { key: 'legendsCta', label: 'Call to action' }
    ] },
    { group: 'Ticker', keys: [
      { key: 'tickerPlaying', label: 'Players active', hint: '{n} = player count' },
      { key: 'tickerEmpty', label: 'Nobody playing' }
    ] },
    { group: 'Arrivals & farewells', keys: [
      { key: 'challengerKicker', label: 'New player kicker' },
      { key: 'challengerLine', label: 'New player headline' },
      { key: 'sendoffKicker', label: 'Leaving kicker' },
      { key: 'sendoffSub', label: 'Leaving subline' }
    ] },
    { group: 'Streaks & big moments', keys: [
      { key: 'streakT1', label: 'Streak tier 1 (3\u20135)' },
      { key: 'streakT2', label: 'Streak tier 2 (10+)' },
      { key: 'streakT3', label: 'Streak tier 3 (15+)' },
      { key: 'streakT4', label: 'Streak tier 4 (20+)' },
      { key: 'snappedKicker', label: 'Streak snapped kicker' },
      { key: 'snappedSub', label: 'Streak snapped subline' },
      { key: 'wagerBeatKicker', label: 'Big wager kicker' },
      { key: 'celebrationKicker', label: 'High score kicker' }
    ] },
    { group: 'Milestones & crowns', keys: [
      { key: 'milestoneT1', label: 'Milestone 100' },
      { key: 'milestoneT2', label: 'Milestone 500' },
      { key: 'milestoneT3', label: 'Milestone 1,000' },
      { key: 'milestoneT4', label: 'Milestone 2,500' },
      { key: 'milestoneT5', label: 'Milestone 5,000' },
      { key: 'milestoneT6', label: 'Milestone 10,000+' },
      { key: 'kingKicker', label: 'Dethrone kicker' },
      { key: 'kingLine', label: 'Dethrone headline', hint: '{old} = dethroned, {amount} = score' },
      { key: 'dethronedKicker', label: 'Dethroned kicker' },
      { key: 'dethronedSub', label: 'Dethroned subline' },
      { key: 'chaseLabel', label: 'Record chase label', hint: '{n} = amount behind' },
      { key: 'tickerChamp', label: 'Champ ticker', hint: '{name}, {amount}' }
    ] },
    { group: 'Site chrome', keys: [
      { key: 'railLeaderboard', label: 'Leaderboard heading' },
      { key: 'railScan', label: 'Join prompt' },
      { key: 'podiumTitle', label: 'Podium title' },
      { key: 'podiumEyebrow', label: 'Podium eyebrow', hint: '{n} = block number' },
      { key: 'footerNote', label: 'Footer text' }
    ] }
  ];

  function renderCustomText() {
    var host = $('#customTextGroups');
    if (!host) return;
    var custom = (settings && settings.customText) || {};
    host.innerHTML = '';
    CUSTOM_TEXT_SCHEMA.forEach(function (sec) {
      var det = document.createElement('details');
      det.className = 'ct-group';
      var sum = document.createElement('summary');
      sum.textContent = sec.group;
      det.appendChild(sum);
      sec.keys.forEach(function (k) {
        var row = document.createElement('div');
        row.className = 'ct-row';
        var lab = document.createElement('label');
        lab.textContent = k.label;
        if (k.hint) {
          var h = document.createElement('span');
          h.className = 'ct-hint';
          h.textContent = k.hint;
          lab.appendChild(document.createTextNode(' '));
          lab.appendChild(h);
        }
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.dataset.ctKey = k.key;
        inp.placeholder = CUSTOM_TEXT_DEFAULTS[k.key] || '';
        var cur = custom[k.key];
        if (typeof cur === 'string' && cur !== '') inp.value = cur;
        inp.addEventListener('change', function () {
          var v = inp.value;
          if (v === '') refs.settings.child('customText').child(k.key).remove();
          else refs.settings.child('customText').child(k.key).set(v.slice(0, 120));
        });
        inp.addEventListener('keydown', function (e) { e.stopPropagation(); });
        row.appendChild(lab);
        row.appendChild(inp);
        det.appendChild(row);
      });
      host.appendChild(det);
    });
  }

  function wireCustomText() {
    var btn = $('#btnTextReset');
    if (btn) btn.addEventListener('click', function () {
      if (window.confirm('Reset all custom text to defaults?')) {
        refs.settings.child('customText').remove();
      }
    });
  }

  // Sync input values with Firebase when settings change elsewhere (skip focused input).
  function syncCustomTextInputs() {
    var custom = (settings && settings.customText) || {};
    document.querySelectorAll('#customTextGroups input[data-ct-key]').forEach(function (inp) {
      if (document.activeElement === inp) return;
      var cur = custom[inp.dataset.ctKey];
      inp.value = (typeof cur === 'string' && cur !== '') ? cur : '';
    });
  }

  // Apply customizable site-chrome strings (rail, footer, podium, video hint).
  function applyCustomChrome() {
    var rb = $('#railBoardTitle');
    if (rb) rb.innerHTML = '<span class="live-dot"></span>' + E.escapeHtml(ct('railLeaderboard'));
    var rs = $('#railScanText');
    if (rs) rs.textContent = ct('railScan');
    var fn = $('#footerNote');
    if (fn) fn.innerHTML = ctHtml('footerNote');
    var pt = $('#podiumTitle');
    if (pt) pt.textContent = ct('podiumTitle');
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
    renderCustomText();
    wireCustomText();
    wireCustomQuestions();
    renderCustomQuestions();
  }

  // ---- custom questions: Jordan's own questions via Settings ----
  // Stored at rooms/cave/settings/customQuestions (array of question objects).
  // Mixed into game rotation and attract teasers.

  function getCustomQuestions() {
    var cq = (settings && settings.customQuestions) || [];
    return Array.isArray(cq) ? cq : [];
  }

  // ---- custom questions merged into bank ----
  // Custom questions live in settings.customQuestions; they're merged into
  // the working bank so they flow through game rotation, teasers, etc.
  var customMerged = false;

  function mergeCustomIntoBank() {
    if (!bank || !bank.length) return;
    // Remove previously merged custom questions (avoid duplicates on re-merge)
    bank = bank.filter(function (q) { return !q.custom; });
    var cq = getCustomQuestions();
    if (cq.length) {
      // Tag with ids if missing (for askedIds tracking)
      cq.forEach(function (q) {
        if (!q.id) q.id = 'custom-' + Math.random().toString(36).slice(2);
      });
      bank = bank.concat(cq);
    }
    customMerged = true;
    // Force teaser pool rebuild to include/exclude customs
    arPoolSig = '';
  }

  // Called when settings.customQuestions changes via Firebase
  function onCustomQuestionsChanged() {
    if (!bank || !bank.length) return;
    mergeCustomIntoBank();
  }

  function wireCustomQuestions() {
    var typeSel = $('#cqType');
    if (typeSel) typeSel.addEventListener('change', function () {
      $('#cqOptions').hidden = (typeSel.value !== 'choice');
    });
    var addBtn = $('#btnCqAdd');
    if (addBtn) addBtn.addEventListener('click', addCustomQuestion);
    // Enter key on inputs adds the question
    ['cqQuestion', 'cqAnswer'].forEach(function (id) {
      var el = $('#' + id);
      if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addCustomQuestion(); }
        e.stopPropagation();
      });
    });
  }

  function cqShowError(msg) {
    var el = $('#cqError');
    if (!el) return;
    if (msg) { el.textContent = msg; el.hidden = false; }
    else el.hidden = true;
  }

  function addCustomQuestion() {
    cqShowError(null);
    var qText = ($('#cqQuestion') || {}).value || '';
    qText = qText.trim();
    var aText = ($('#cqAnswer') || {}).value || '';
    aText = aText.trim();
    var cat = ($('#cqCategory') || {}).value || 'mixed';
    var type = ($('#cqType') || {}).value || 'text';

    if (!qText) { cqShowError('Enter a question.'); return; }
    if (!aText) { cqShowError('Enter the correct answer.'); return; }

    var existing = getCustomQuestions();
    // duplicate check (case-insensitive question match)
    var dup = existing.some(function (q) {
      return String(q.question || '').toLowerCase().trim() === qText.toLowerCase();
    });
    if (dup) { cqShowError('That question is already added.'); return; }

    var qObj = {
      id: 'custom-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
      question: qText.slice(0, 280),
      category: cat,
      difficulty: 'medium',
      kid_safe: true,
      source: 'custom',
      custom: true,
    };
    if (type === 'choice') {
      var opts = [];
      var optEls = document.querySelectorAll('.cq-opt');
      for (var i = 0; i < optEls.length; i++) {
        var v = (optEls[i].value || '').trim().slice(0, 80);
        if (!v) { cqShowError('Fill in all 4 options for multiple choice.'); return; }
        opts.push(v);
      }
      // Shuffle options so the correct answer isn't always first.
      // Track the correct index after shuffling.
      var correctText = opts[0]; // Option A is the correct answer as entered
      for (var s = opts.length - 1; s > 0; s--) {
        var r = Math.floor(Math.random() * (s + 1));
        var tmp = opts[s]; opts[s] = opts[r]; opts[r] = tmp;
      }
      var correctIdx = opts.indexOf(correctText);
      qObj.options = opts;
      qObj.answer = correctIdx;
      qObj.answerType = 'choice';
      qObj.answerText = correctText;
    } else {
      qObj.answerText = aText.slice(0, 120);
      qObj.answerType = 'text';
    }

    existing.push(qObj);
    refs.settings.child('customQuestions').set(existing).then(function () {
      // clear form
      $('#cqQuestion').value = '';
      $('#cqAnswer').value = '';
      document.querySelectorAll('.cq-opt').forEach(function (el) { el.value = ''; });
      renderCustomQuestions();
      arPoolSig = ""; // include in attract teasers immediately
    }).catch(function (err) {
      cqShowError('Could not save: ' + (err && err.message || 'unknown error'));
    });
  }

  function deleteCustomQuestion(id) {
    var existing = getCustomQuestions();
    var filtered = existing.filter(function (q) { return q.id !== id; });
    refs.settings.child('customQuestions').set(filtered.length ? filtered : null).then(function () {
      renderCustomQuestions();
      arPoolSig = "";
    });
  }

  function renderCustomQuestions() {
    var host = $('#cqList');
    if (!host) return;
    var list = getCustomQuestions();
    host.innerHTML = '';
    if (!list.length) {
      host.innerHTML = '<p class="settings-hint">No custom questions yet. Add your first above.</p>';
      return;
    }
    list.forEach(function (q) {
      var row = document.createElement('div');
      row.className = 'ct-row';
      row.style.alignItems = 'flex-start';
      var txt = document.createElement('div');
      txt.style.flex = '1';
      var qt = document.createElement('div');
      qt.style.fontWeight = '700';
      qt.textContent = q.question;
      var meta = document.createElement('div');
      meta.className = 'settings-hint';
      meta.style.margin = '0.2rem 0 0';
      var ansPreview = q.answerText || (q.options && q.options[q.answer]) || '';
      meta.textContent = (q.category || 'mixed').toUpperCase() + ' · ' +
        (q.answerType === 'choice' ? 'Multiple choice' : 'Text') +
        (ansPreview ? ' · Answer: ' + ansPreview.slice(0, 40) : '');
      txt.appendChild(qt);
      txt.appendChild(meta);
      var del = document.createElement('button');
      del.className = 'btn ghost';
      del.textContent = 'Delete';
      del.style.flexShrink = '0';
      del.addEventListener('click', function () {
        if (window.confirm('Delete this custom question?')) deleteCustomQuestion(q.id);
      });
      row.appendChild(txt);
      row.appendChild(del);
      host.appendChild(row);
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

    // Pure REST polling reads (js/poll.js): no websockets, no Firebase SDK.
    // Works on any network that can fetch https URLs.
    var DBURL = cfg.databaseURL;
    function liveListen(path, cb, pollMs) {
      return CT.poll.listen(path, cb, { databaseURL: DBURL, pollMs: pollMs });
    }
    // REST has no .info/serverTimeOffset, so measure it: write a server timestamp and read it back.
    // Phones stamp lastSeen with server time, so a TV clock that is minutes off would
    // otherwise count everyone as gone.
    function syncServerClock() {
      var t0 = Date.now();
      fetch(DBURL.replace(/\/$/, '') + '/' + ROOM + '/tvClock.json', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{".sv":"timestamp"}'
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (ts) {
        if (typeof ts !== 'number') return;
        var t1 = Date.now();
        if (t1 - t0 < 5000) serverOffset = ts - (t0 + t1) / 2;
      }).catch(function () {});
    }
    syncServerClock();
    setInterval(syncServerClock, 10 * 60 * 1000);

    liveListen(ROOM + '/players', onPlayers, 1500);
    liveListen(ROOM + '/settings', onSettings, 5000);
    liveListen(ROOM + '/state', onState, 1000);
    liveListen(ROOM + '/question', onQuestion, 1000);
    liveListen(ROOM + '/reveal', onReveal, 1000);
    liveListen(ROOM + '/playerStats', function (snap) {
      statsCache = snap.val() || {};
      renderStatsBoard();
    }, 3000);

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

    // GAME START WATCHDOG (Jordan's rule: one person in, game is LIVE).
    // If players are present but phase is stuck at 'idle', force the game
    // to start. This catches the case where onPlayers fired but the
    // kickstart timer was lost, or state is stale.
    setInterval(function () {
      try {
        var st = lastStateDoc;
        var phase = (st && st.phase) || 'idle';
        if (phase === 'idle' && activePlayerCount() > 0 && momentIdle() && !currentQ && !pendingWagerQ && !imgChecking && !questionTimer) {
          console.warn('[watchdog] players waiting in idle, forcing game start');
          clearTimer();
          advanceGame();
        }
      } catch (e) {}
    }, 5000);

    tickClock();
    setInterval(tickClock, 10000);
    renderQr();
    setPhase('idle');
    renderIdle();

    ensureBank().then(function (b) {
      if (!b) throw new Error('empty');
    }).catch(function () {
      bankFailed = true;
      var ac = $('#arCard');
      if (ac) ac.innerHTML = '<div class="ar-eyebrow gold">Error</div><div class="ar-big">QUESTION BANK<br>FAILED TO LOAD</div>';
    });
  }

  wireSetup();
  var stored = window.CT.config.readStored();

  // One-tap video unlock: browsers block autoplay with sound until user interacts.
  // Game autoruns regardless — this only unlocks video audio. First tap anywhere hides the hint.
  // (Browsers require a fresh gesture per page load, so the hint shows on every load until tapped.)
  if (stored) boot(stored);
  else showSetup();
})();
