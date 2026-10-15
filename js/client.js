/* Cave Trivia (web) — phone client.
   Join once, play forever. Phase-driven from Firebase (rooms/cave/*).
   Ported from public/js/play.js; server calls replaced with RTDB reads/writes. */
(function () {
  'use strict';

  var E = window.CT.engine;
  var $ = function (s) { return document.querySelector(s); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var ROOM = 'rooms/cave';
  var PID_KEY = 'ct-player-id';
  var NAME_KEY = 'ct-player-name';
  var WAGER_SECONDS = 15;

  var db = null;
  var dbUrl = ''; // Firebase databaseURL (for the REST polling fallback)
  var refs = {};
  var playerId = null;
  var playerName = '';
  var serverOffset = 0;

  var lastState = null;
  var lastQuestion = null;
  var lastReveal = null;
  var lastSettings = null;
  var myPlayer = null;       // my player record mirror
  var answeredQid = null;    // question id I answered (locked state)
  var myWager = 0;
  var wagerPhaseKey = null;
  var lastMsgAt = 0;

  function serverNow() { return Date.now() + serverOffset; }

  // Pure REST polling reads (js/poll.js): no websockets, no Firebase SDK.
  function liveListen(path, cb, pollMs) {
    return CT.poll.listen(path, cb, { databaseURL: dbUrl, pollMs: pollMs });
  }

  function setPhase(name) {
    ['join', 'wager', 'question', 'locked', 'reveal', 'board', 'stats'].forEach(function (p) {
      var el = document.getElementById('p-' + p);
      if (el) el.classList.toggle('active', p === name);
    });
  }

  /* ---------------- player stats profile ---------------- */

  var lastStatsPhase = 'board'; // where to return after viewing stats
  function myStatsKey() {
    return String(playerName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'anon';
  }
  function renderMyStats(s) {
    s = s || {};
    $('#statsName').textContent = playerName || '—';
    $('#statsStreak').textContent = s.streak || 0;
    $('#statsBestStreak').textContent = s.bestStreak || 0;
    var acc = (s.answered > 0) ? Math.round(100 * (s.correct || 0) / s.answered) + '%' : '—';
    $('#statsAccuracy').textContent = acc;
    $('#statsDay').textContent = fmt(s.day || 0);
    $('#statsMonth').textContent = fmt(s.month || 0);
    $('#statsLifetime').textContent = fmt(s.lifetime || 0);
    $('#statsAnswered').textContent = fmt(s.answered || 0);
  }
  function openStats() {
    lastStatsPhase = 'board';
    // pull latest snapshot once, then go
    db.ref(ROOM + '/playerStats/' + myStatsKey()).once('value').then(function (snap) {
      renderMyStats(snap.val());
      setPhase('stats');
    }).catch(function () {
      renderMyStats(null);
      setPhase('stats');
    });
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function fmt(n) { return E.fmtNum(n); }

  /* ---------------- config ---------------- */

  function ensureConfig() {
    var fromHash = window.CT.config.readFromHash();
    if (fromHash) {
      window.CT.config.save(fromHash);
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      return fromHash;
    }
    return window.CT.config.readStored();
  }

  /* ---------------- player identity ---------------- */

  function loadIdentity() {
    try {
      playerId = localStorage.getItem(PID_KEY) || null;
      playerName = localStorage.getItem(NAME_KEY) || '';
    } catch (e) {}
  }
  function saveIdentity() {
    try {
      if (playerId) localStorage.setItem(PID_KEY, playerId);
      if (playerName) localStorage.setItem(NAME_KEY, playerName);
    } catch (e) {}
  }
  function newPlayerId() {
    return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function touchLastSeen() {
    if (!db || !playerId || !refs.player) return;
    refs.player.update({ lastSeen: CT.rest.ts(), present: true });
  }

  /* ---------------- join ---------------- */

  function join(name) {
    name = E.sanitizeName(name);
    if (!name) return Promise.reject(new Error('name required'));
    // reclaim by name (case-insensitive), like the Node server
    return refs.players.once('value').then(function (snap) {
      var all = snap.val() || {};
      var foundId = null;
      Object.keys(all).forEach(function (pid) {
        if (String(all[pid].name || '').toLowerCase() === name.toLowerCase()) foundId = pid;
      });
      var now = CT.rest.ts();
      if (foundId) {
        playerId = foundId;
        return db.ref(ROOM + '/players/' + foundId).update({ lastSeen: now, present: true }).then(function () { return foundId; });
      }
      playerId = newPlayerId();
      var rec = {
        name: name, score: 0, blockScore: 0, correct: 0, answered: 0,
        wagersWon: 0, wagersLost: 0, wager: 0, wagerPlaced: false, answer: null,
        joinedAt: now, lastSeen: now, present: true,
      };
      return db.ref(ROOM + '/players/' + playerId).set(rec).then(function () { return playerId; });
    }).then(function () {
      playerName = name;
      saveIdentity();
      refs.player = db.ref(ROOM + '/players/' + playerId);
      // No onDisconnect in REST mode: the 30s heartbeat keeps lastSeen fresh
      // while the app is open; the TV counts players out after 3 min idle.
      liveListen(ROOM + '/players/' + playerId, function (snap) {
        myPlayer = snap.val();
        renderScoreBox();
        renderFoot();
      }, 1500);
      touchLastSeen();
    });
  }

  /* ---------------- score helpers ---------------- */

  function myScore() { return (myPlayer && myPlayer.score) || 0; }

  function myRank() {
    var board = (lastState && lastState.board) || [];
    var nm = playerName.toLowerCase();
    for (var i = 0; i < board.length; i++) {
      if (String(board[i].name).toLowerCase() === nm) return i + 1;
    }
    return -1;
  }
  function myBlockPos() {
    var board = (lastState && lastState.blockBoard) || [];
    var nm = playerName.toLowerCase();
    for (var i = 0; i < board.length; i++) {
      if (String(board[i].name).toLowerCase() === nm) return i + 1;
    }
    return -1;
  }

  function renderScoreBox() {
    if (!playerId) { $('#scoreBox').hidden = true; return; }
    $('#scoreBox').hidden = false;
    var rk = myRank();
    $('#myScore').textContent = fmt(myScore());
    $('#myRank').textContent = rk > 0 ? 'Rank #' + rk : 'Unranked';
  }

  function renderFoot() {
    if (!playerId) { $('#playFoot').hidden = true; return; }
    $('#playFoot').hidden = false;
    $('#footName').textContent = playerName;
    $('#footScore').textContent = fmt(myScore()) + ' pts';
    var bp = myBlockPos();
    var bnum = (lastState && lastState.blockNum) || 1;
    $('#footBlock').textContent = bp > 0 ? 'Block #' + bp : 'Block ' + bnum;
  }

  /* ---------------- render dispatch ---------------- */

  function render() {
    if (!lastState) return;
    var st = lastState;
    lastMsgAt = Date.now();
    $('#reconnect').hidden = true;
    $('#familyBadge').hidden = !(lastSettings && lastSettings.familyMode);
    if (!playerId) { setPhase('join'); return; }
    renderScoreBox();
    renderFoot();

    var phase = st.phase || 'idle';
    if (phase === 'wager') {
      renderWager(st);
    } else if (phase === 'question' && lastQuestion) {
      if (answeredQid === lastQuestion.id) setPhase('locked');
      else renderQuestion(st, lastQuestion);
    } else if (phase === 'reveal' && lastReveal) {
      renderReveal(st, lastReveal);
      checkPhoneCelebration(lastReveal);
      setPhase('reveal');
    } else {
      renderBoard(st); // idle or podium
    }
    tickTimers();
  }

  /* ---------------- wager phase ---------------- */

  function wagerMax() { return Math.max(0, Math.floor(myScore())); }

  function updateWagerAmount() {
    var s = $('#wagerSlider');
    $('#wagerAmount').textContent = fmt(s.value);
    $('#wagerMax').textContent = fmt(s.max);
  }

  function renderWager(st) {
    var key = 'b' + st.blockNum + 'w' + (st.wagerCategory || '');
    var max = wagerMax();
    if (wagerPhaseKey !== key) {
      wagerPhaseKey = key;
      myWager = 0;
      var s = $('#wagerSlider');
      s.max = max;
      s.value = 0;
      s.disabled = max <= 0;
      var btn = $('#wagerBtn');
      btn.disabled = max <= 0;
      btn.textContent = 'Place wager';
      $('#wagerNote').hidden = true;
    } else {
      var s2 = $('#wagerSlider');
      if (Number(s2.max) !== max) s2.max = max;
    }
    $('#wagerCat').textContent = E.fmtCategory(st.wagerCategory) || 'MYSTERY';
    $('#wagerSub').textContent = max <= 0
      ? 'No points in your stack yet \u2014 build it up and wager next block!'
      : 'How much of your stack are you risking?';
    updateWagerAmount();
    setPhase('wager');
  }

  function placeWager() {
    if (!playerId || !lastState || lastState.phase !== 'wager') return;
    if (serverNow() > (lastState.wagerDeadlineTs || 0)) {
      toast('Wager window closed \u2014 too slow!');
      return;
    }
    var amount = Math.max(0, Math.min(parseInt($('#wagerSlider').value, 10) || 0, wagerMax()));
    var btn = $('#wagerBtn');
    btn.disabled = true;
    btn.textContent = 'Locking in\u2026';
    refs.player.update({
      wager: amount,
      wagerPlaced: true,
      lastSeen: CT.rest.ts(),
    }).then(function () {
      myWager = amount;
      btn.disabled = false;
      btn.textContent = 'Update wager';
      var note = $('#wagerNote');
      note.hidden = false;
      note.textContent = 'Wager locked: ' + fmt(myWager) + '. No take-backs.';
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Update wager';
      toast('Connection hiccup \u2014 try again.');
    });
  }

  /* ---------------- question phase ---------------- */

  function buildOptions(options) {
    var box = $('#pqOptions');
    box.innerHTML = '';
    options.forEach(function (text, i) {
      var b = document.createElement('button');
      b.className = 'pq-opt';
      b.type = 'button';
      var l = document.createElement('span');
      l.className = 'letter';
      l.textContent = LETTERS[i];
      var t = document.createElement('span');
      t.textContent = text;
      b.appendChild(l);
      b.appendChild(t);
      b.addEventListener('click', function () { answer(i); });
      box.appendChild(b);
    });
  }

  function renderQuestion(st, q) {
    if ($('#pqOptions').dataset.qid !== q.id) {
      answeredQid = null;
      $('#pqOptions').dataset.qid = q.id;
      $('#pqCat').textContent = E.fmtCategory(q.category);
      $('#pqDiff').textContent = q.difficulty || '';
      var pqEl = $('#pqText');
      pqEl.textContent = q.text;
      var pqlen = (q.text || '').length;
      pqEl.classList.remove('pq-long', 'pq-xlong');
      if (pqlen > 280) pqEl.classList.add('pq-xlong');
      else if (pqlen > 150) pqEl.classList.add('pq-long');
      $('#watchTv').hidden = !(q.image || q.video);
      var wb = $('#wagerQBadge');
      if (q.isWager) {
        wb.hidden = false;
        $('#wagerQAmount').textContent = myWager > 0 ? ('you risked ' + fmt(myWager)) : 'no wager placed';
      } else {
        wb.hidden = true;
      }
      var isText = q.answerType === 'text';
      var isNum = q.answerType === 'number';
      $('#pqOptions').hidden = isText || isNum;
      $('#pqTextAnswer').hidden = !isText;
      $('#pqNumAnswer').hidden = !isNum;
      // Lightning indicator
      var lb = $('#lightningBadge');
      if (lb) lb.hidden = !q.isLightning;
      if (isText) {
        var ti = $('#pqTextInput');
        ti.value = '';
        ti.disabled = false;
        $('#pqTextSubmit').disabled = false;
        setTimeout(function () { try { ti.focus(); } catch (e) {} }, 300);
      } else if (isNum) {
        var ni = $('#pqNumInput');
        ni.value = '';
        ni.disabled = false;
        $('#pqNumSubmit').disabled = false;
        setTimeout(function () { try { ni.focus(); } catch (e) {} }, 300);
      } else {
        buildOptions(q.options);
      }
    }
    setPhase('question');
  }

  function answer(choice) {
    if (!playerId || !lastQuestion) return;
    var qid = lastQuestion.id;
    if (answeredQid === qid) return;
    if (serverNow() > (lastQuestion.deadlineTs || 0)) {
      toast('Too slow \u2014 that question moved on!');
      return;
    }
    var btns = $('#pqOptions').querySelectorAll('.pq-opt');
    btns.forEach(function (b) { b.disabled = true; });
    if (btns[choice]) btns[choice].classList.add('picked');
    refs.player.update({
      answer: { choice: choice, at: CT.rest.ts() },
      lastSeen: CT.rest.ts(),
    }).then(function () {
      answeredQid = qid;
      setPhase('locked');
    }).catch(function () {
      toast('Hmm, that didn\u2019t land. Tap again.');
      btns.forEach(function (b) { b.disabled = false; b.classList.remove('picked'); });
    });
  }

  function answerText() {
    if (!playerId || !lastQuestion) return;
    var qid = lastQuestion.id;
    if (answeredQid === qid) return;
    var ti = $('#pqTextInput');
    var text = ti.value.trim();
    if (!text) {
      toast('Type an answer first!');
      return;
    }
    if (serverNow() > (lastQuestion.deadlineTs || 0)) {
      toast('Too slow \u2014 that question moved on!');
      return;
    }
    ti.disabled = true;
    $('#pqTextSubmit').disabled = true;
    refs.player.update({
      answer: { text: text.slice(0, 120), at: CT.rest.ts() },
      lastSeen: CT.rest.ts(),
    }).then(function () {
      answeredQid = qid;
      setPhase('locked');
    }).catch(function () {
      toast('Hmm, that didn\u2019t land. Try again.');
      ti.disabled = false;
      $('#pqTextSubmit').disabled = false;
    });
  }

  function answerNumber() {
    if (!playerId || !lastQuestion) return;
    var qid = lastQuestion.id;
    if (answeredQid === qid) return;
    var ni = $('#pqNumInput');
    var raw = ni.value.trim().replace(/,/g, '');
    var num = Number(raw);
    if (raw === '' || isNaN(num)) {
      toast('Enter a number first!');
      return;
    }
    if (serverNow() > (lastQuestion.deadlineTs || 0)) {
      toast('Too slow \u2014 that question moved on!');
      return;
    }
    ni.disabled = true;
    $('#pqNumSubmit').disabled = true;
    refs.player.update({
      answer: { number: num, at: CT.rest.ts() },
      lastSeen: CT.rest.ts(),
    }).then(function () {
      answeredQid = qid;
      setPhase('locked');
    }).catch(function () {
      toast('Hmm, that didn\u2019t land. Try again.');
      ni.disabled = false;
      $('#pqNumSubmit').disabled = false;
    });
  }

  /* ---------------- reveal phase ---------------- */

  function renderReveal(st, r) {
    var me = null;
    (r.results || []).forEach(function (x) {
      if (x.pid === playerId) me = x;
    });
    var isNum = r.answerType === 'number';
    var pts = $('#rvPoints');
    pts.classList.remove('neg');
    if (isNum) {
      // Closest-wins reveal
      $('#rvKicker').textContent = 'Closest wins';
      var myGuess = (me && me.guess !== undefined) ? me.guess : null;
      if (me && me.correct) {
        pts.hidden = false;
        pts.textContent = '+' + fmt(me.delta);
        $('#rvTitle').textContent = 'CLOSEST! You take it.';
      } else if (me) {
        pts.hidden = true;
        $('#rvTitle').textContent = 'Not the closest this time.';
      } else {
        pts.hidden = true;
        $('#rvTitle').textContent = 'You sat this one out.';
      }
      var sub = 'The answer was ' + fmt(r.answerNumber) + '.';
      if (myGuess !== null) sub += ' You guessed ' + fmt(myGuess) + ' (off by ' + fmt(Math.abs(myGuess - r.answerNumber)) + ').';
      $('#rvSub').textContent = sub;
    } else if (me) {
      var correct = !!me.correct;
      $('#rvKicker').textContent = r.isWager ? 'Wager result' : (correct ? 'Correct' : 'The answer');
      if (me.delta > 0) {
        pts.hidden = false;
        pts.textContent = '+' + fmt(me.delta);
      } else if (me.delta < 0) {
        pts.hidden = false;
        pts.textContent = fmt(me.delta);
        pts.classList.add('neg');
      } else {
        pts.hidden = true;
      }
      $('#rvTitle').textContent = correct
        ? (r.isWager ? 'BOOM. Wager paid off.' : 'BOOM. Nice one.')
        : (r.isWager ? 'Ouch. There goes the wager.' : 'Not this time.');
      $('#rvSub').textContent = 'Correct answer: ' + (r.correctText || '') +
        (correct ? '' : '. You\u2019ll get the next one.');
    } else {
      pts.hidden = true;
      $('#rvKicker').textContent = 'The answer';
      $('#rvTitle').textContent = 'You sat this one out.';
      $('#rvSub').textContent = 'Correct answer: ' + (r.correctText || '') + '. Next one\u2019s yours.';
    }
    // reset flag button
    var fb = $('#flagBtn');
    fb.disabled = false;
    fb.textContent = 'Flag bad question';
    fb.onclick = function () {
      if (!lastQuestion || !playerId) return;
      fb.disabled = true;
      fb.textContent = 'Flagged. Thanks!';
      db.ref(ROOM + '/flagged/' + lastQuestion.id).set({
        qid: lastQuestion.id,
        text: (lastQuestion.text || '').slice(0, 200),
        by: playerName || 'anon',
        at: CT.rest.ts(),
      }).catch(function () {});
    };
  }

  /* ---------------- phone-side celebration mirror ----------------
     When the TV fires a big moment for THIS player, show it on the phone too. */
  var lastCelebrationKey = '';
  function checkPhoneCelebration(r) {
    var pc = $('#phoneCelebration');
    if (!pc || !playerId || !r) return;
    var me = null;
    (r.results || []).forEach(function (x) {
      if (x.pid === playerId) me = x;
    });
    if (!me || !me.name) { pc.hidden = true; return; }
    var myName = me.name;
    var shown = false;
    var key = '';
    // dethrone: am I the new king?
    if (r.dethrones && r.dethrones.length) {
      var dt = r.dethrones[0];
      key = 'king-' + dt.newKing + '-' + dt.amount;
      if (dt.newKing === myName && key !== lastCelebrationKey) {
        $('#pcKicker').textContent = 'NEW KING OF THE HILL';
        $('#pcTitle').textContent = 'You dethroned ' + dt.oldKing + '!';
        $('#pcSub').textContent = 'At ' + fmt(dt.amount) + ' — the crown is yours';
        shown = true;
      }
    }
    // milestone: did I hit one?
    if (!shown && r.highScoreCelebrations && r.highScoreCelebrations.length) {
      var hc = r.highScoreCelebrations[0];
      key = 'ms-' + hc.name + '-' + hc.score;
      if (hc.name === myName && key !== lastCelebrationKey) {
        $('#pcKicker').textContent = 'NEW HIGH SCORE';
        $('#pcTitle').textContent = 'You hit ' + fmt(hc.score) + '!';
        $('#pcSub').textContent = 'Day total: ' + fmt(hc.dayTotal || hc.score);
        shown = true;
      }
    }
    if (shown) {
      lastCelebrationKey = key;
      pc.hidden = false;
      pc.classList.remove('show');
      void pc.offsetWidth;
      pc.classList.add('show');
      setTimeout(function () {
        pc.classList.remove('show');
        setTimeout(function () { pc.hidden = true; }, 400);
      }, 3500);
    }
  }

  /* ---------------- idle / podium mini board ---------------- */

  function renderBoard(st) {
    var isPodium = st.phase === 'podium' && st.podium;
    $('#boardKicker').textContent = isPodium ? ('Block ' + (st.blockNum || '') + ' podium') : 'Live board';
    $('#boardTitle').textContent = isPodium ? 'Block champions' : 'Top players';
    var rows = isPodium ? (st.podium.top || []) : (st.board || []).slice(0, 5);
    var ol = $('#miniBoard');
    ol.innerHTML = '';
    if (!rows.length) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="mb-name">No scores yet \u2014 be the first legend.</span>';
      ol.appendChild(li);
    }
    rows.forEach(function (r, i) {
      var li2 = document.createElement('li');
      var isMe = playerName && String(r.name).toLowerCase() === playerName.toLowerCase();
      if (isMe) li2.className = 'me';
      var pos = document.createElement('span');
      pos.className = 'mb-pos';
      pos.textContent = (i + 1);
      var nm = document.createElement('span');
      nm.className = 'mb-name';
      nm.textContent = r.name + (isMe ? ' (you)' : '');
      var sc = document.createElement('span');
      sc.className = 'mb-score';
      sc.textContent = fmt(r.score);
      li2.appendChild(pos);
      li2.appendChild(nm);
      li2.appendChild(sc);
      ol.appendChild(li2);
    });
    $('#boardMsg').textContent = isPodium
      ? 'New block starting \u2014 fresh scores, same legends.'
      : ('Block ' + (st.blockNum || 1) + ' \u00b7 question ' + (st.questionInBlock || 1) + ' of 10 \u00b7 next up soon.');
    setPhase('board');
  }

  /* ---------------- timers ---------------- */

  function tickTimers() {
    if (!lastState) return;
    var now = serverNow();
    if (lastState.phase === 'question' && lastQuestion && lastQuestion.deadlineTs) {
      var total = ((lastQuestion.seconds || 20) * 1000);
      var w = Math.max(0, Math.min(100, 100 * (lastQuestion.deadlineTs - now) / total));
      var el = $('#pqTimerFill');
      if (el) el.style.width = w + '%';
    }
    if (lastState.phase === 'wager' && lastState.wagerDeadlineTs) {
      var w2 = Math.max(0, Math.min(100, 100 * (lastState.wagerDeadlineTs - now) / (WAGER_SECONDS * 1000)));
      var el2 = $('#wagerTimerFill');
      if (el2) el2.style.width = w2 + '%';
    }
  }
  setInterval(tickTimers, 200);

  /* ---------------- host liveness ---------------- */

  /* ---------------- join form ---------------- */

  function showJoinError(msg) {
    var e = $('#joinError');
    e.textContent = msg;
    e.hidden = false;
  }

  function wireJoin() {
    $('#joinBtn').addEventListener('click', function () {
      var name = $('#nameInput').value.trim();
      $('#joinError').hidden = true;
      if (!name) { $('#nameInput').focus(); return; }
      var btn = $('#joinBtn');
      btn.disabled = true;
      btn.textContent = 'Joining\u2026';
      join(name).then(function () {
        render();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Let\u2019s go';
        showJoinError((err && err.message) || 'Couldn\u2019t join. Try again.');
        $('#nameInput').focus();
      });
    });
    $('#nameInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#joinBtn').click();
    });
  }

  /* ---------------- boot ---------------- */

  function boot(cfg) {
    try {
      db = window.CT.config.init(cfg);
    } catch (e) {
      setPhase('join');
      showJoinError('Couldn\u2019t connect to the game: ' + e.message);
      return;
    }
    dbUrl = cfg.databaseURL || '';
    refs.players = db.ref(ROOM + '/players');
    refs.state = db.ref(ROOM + '/state');
    refs.question = db.ref(ROOM + '/question');
    refs.reveal = db.ref(ROOM + '/reveal');
    refs.settings = db.ref(ROOM + '/settings');

    // No server clock in REST mode — serverNow() uses the local clock.

    liveListen(ROOM + '/state', function (snap) {
      lastState = snap.val() || { phase: 'idle' };
      render();
    }, 1500);
    liveListen(ROOM + '/question', function (snap) {
      lastQuestion = snap.val();
      render();
    }, 1500);
    liveListen(ROOM + '/reveal', function (snap) {
      lastReveal = snap.val();
      render();
    }, 1500);
    liveListen(ROOM + '/settings', function (snap) {
      lastSettings = snap.val() || {};
      var theme = lastSettings.theme || 'midnight-gold';
      if (document.documentElement.dataset.theme !== theme) {
        document.documentElement.dataset.theme = theme;
      }
      var wm = document.querySelector('.play-top .wordmark');
      if (wm) wm.textContent = (lastSettings.title || 'CAVE TRIVIA').toUpperCase();
      render();
    }, 5000);
    // keep-alive: stay "active" on the TV's player count
    setInterval(touchLastSeen, 30000);
    // watchdog: if polls stop succeeding, show the reconnect pill.
    // CT.poll.lastOkAt() tracks every successful poll receipt.
    setInterval(function () {
      if (!playerId) return;
      var lastOk = (window.CT && CT.poll && typeof CT.poll.lastOkAt === 'function' && CT.poll.lastOkAt()) || lastMsgAt;
      $('#reconnect').hidden = (Date.now() - lastOk <= 8000);
    }, 2000);

    wireJoin();
    $('#wagerSlider').addEventListener('input', updateWagerAmount);
    $('#wagerBtn').addEventListener('click', placeWager);
    $('#pqTextSubmit').addEventListener('click', answerText);
    $('#pqTextInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') answerText();
      e.stopPropagation();
    });
    $('#pqNumSubmit').addEventListener('click', answerNumber);
    $('#pqNumInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') answerNumber();
      e.stopPropagation();
    });
    $('#statsBtn').addEventListener('click', openStats);
    $('#statsBackBtn').addEventListener('click', function () { setPhase(lastStatsPhase); });
    // live-update stats while viewing
    liveListen(ROOM + '/playerStats/' + myStatsKey(), function (snap) {
      if (document.getElementById('p-stats').classList.contains('active')) {
        renderMyStats(snap.val());
      }
    }, 3000);
    $('#wagerHalf').addEventListener('click', function () {
      var s = $('#wagerSlider');
      s.value = Math.floor(Number(s.max) / 2);
      updateWagerAmount();
    });
    $('#wagerFull').addEventListener('click', function () {
      var s = $('#wagerSlider');
      s.value = s.max;
      updateWagerAmount();
    });

    loadIdentity();
    if (playerName) {
      // auto-rejoin with the saved name
      join(playerName).then(render).catch(function () {
        playerId = null;
        setPhase('join');
      });
    } else {
      setPhase('join');
    }
    render();
  }

  var cfg = ensureConfig();
  if (!cfg) {
    // No config and none in the QR hash: tell them to scan the TV's code.
    setPhase('join');
    document.addEventListener('DOMContentLoaded', function () {
      var hero = document.querySelector('.join-hero');
      if (hero) {
        hero.innerHTML = '<div class="eyebrow">Not connected</div>' +
          '<h1>Scan the QR code<br><em>on the TV.</em></h1>' +
          '<p>That code carries everything your phone needs to join the game \u2014 no typing, no setup.</p>';
      }
    });
  } else {
    loadIdentity();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { boot(cfg); });
    } else {
      boot(cfg);
    }
  }
})();
