/* Cave Trivia — phone client (contract v2: always-on living game).
   Join once, play forever. Phase-driven from /api/state. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var STORE_KEY = 'cave-trivia-player';
  var WAGER_SECONDS = 15;

  var session = null;        // {playerId, token, name}
  var lastState = null;
  var lastAnsweredQid = null;
  var lastChoice = -1;
  var scoreAtQuestionStart = 0;
  var myWager = 0;
  var wagerPhaseKey = null;
  var myScoreEst = 0;        // fallback when I'm outside the top-10 boards
  var lastMsgAt = 0;

  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

  function setPhase(name) {
    ['join', 'wager', 'question', 'locked', 'reveal', 'board'].forEach(function (p) {
      var el = $('#p-' + p);
      if (el) el.classList.toggle('active', p === name);
    });
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------- session ---------- */

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function clearSession() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    session = null;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { ok: r.ok, status: r.status, j: j };
      });
    });
  }

  /* ---------- score helpers (leaderboard + local fallback) ---------- */

  function entryIn(board) {
    if (!session || !board) return null;
    var nm = session.name.toLowerCase();
    for (var i = 0; i < board.length; i++) {
      if (String(board[i].name).toLowerCase() === nm) return { entry: board[i], index: i };
    }
    return null;
  }
  function myAllScore() {
    var hit = lastState && entryIn(lastState.leaderboard);
    return hit ? hit.entry.score : myScoreEst;
  }
  function myRank() {
    var hit = lastState && entryIn(lastState.leaderboard);
    return hit ? hit.index + 1 : -1;
  }
  function myBlockPos() {
    var hit = lastState && entryIn(lastState.blockBoard);
    return hit ? hit.index + 1 : -1;
  }

  function renderScoreBox() {
    if (!session) { $('#scoreBox').hidden = true; return; }
    $('#scoreBox').hidden = false;
    var rk = myRank();
    $('#myScore').textContent = fmt(myAllScore());
    $('#myRank').textContent = rk > 0 ? 'Rank #' + rk : 'Unranked';
  }

  function renderFoot(state) {
    if (!session) { $('#playFoot').hidden = true; return; }
    $('#playFoot').hidden = false;
    $('#footName').textContent = session.name;
    $('#footScore').textContent = fmt(myAllScore()) + ' pts';
    var bp = myBlockPos();
    var b = state.block || {};
    $('#footBlock').textContent = bp > 0 ? 'Block #' + bp : 'Block ' + (b.number || 1);
  }

  /* ---------- render dispatch ---------- */

  function render(state) {
    lastState = state;
    $('#familyBadge').hidden = !state.familyMode;
    var theme = state.theme || 'midnight-gold';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    if (!session) {
      $('#scoreBox').hidden = true;
      $('#playFoot').hidden = true;
      setPhase('join');
      return;
    }
    renderScoreBox();
    renderFoot(state);

    var phase = state.phase || 'idle';
    if (phase === 'wager' && state.wager) {
      renderWager(state);
    } else if (phase === 'question' && state.question) {
      if (lastAnsweredQid === state.question.id) {
        setPhase('locked');
      } else {
        renderQuestion(state);
      }
    } else if (phase === 'reveal' && state.reveal) {
      renderReveal(state);
      setPhase('reveal');
    } else {
      renderBoard(state); // idle or podium
    }
    tickTimers();
  }

  /* ---------- wager phase ---------- */

  function wagerMax() { return Math.max(0, Math.floor(myAllScore())); }

  function updateWagerAmount() {
    var s = $('#wagerSlider');
    $('#wagerAmount').textContent = fmt(s.value);
    $('#wagerMax').textContent = fmt(s.max);
  }

  function renderWager(state) {
    var key = 'b' + (state.block && state.block.number) + 'q' + (state.block && state.block.questionInBlock);
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
      if (Number(s2.max) !== max) { s2.max = max; }
    }
    $('#wagerCat').textContent = String(state.wager.category || 'Mystery').replace(/-/g, ' ').toUpperCase();
    if (max <= 0) {
      $('#wagerSub').textContent = 'No points in your stack yet — build it up and wager next block!';
    } else {
      $('#wagerSub').textContent = 'How much of your stack are you risking?';
    }
    updateWagerAmount();
    setPhase('wager');
  }

  function placeWager() {
    if (!session || !lastState || lastState.phase !== 'wager' || !lastState.wager) return;
    var amount = Math.max(0, Math.min(parseInt($('#wagerSlider').value, 10) || 0, wagerMax()));
    var btn = $('#wagerBtn');
    btn.disabled = true;
    btn.textContent = 'Locking in…';
    post('/api/wager', { playerId: session.playerId, token: session.token, amount: amount })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Update wager';
        if (res.ok) {
          myWager = res.j.wager;
          var note = $('#wagerNote');
          note.hidden = false;
          note.textContent = 'Wager locked: ' + fmt(myWager) + '. No take-backs.';
        } else if (res.status === 409) {
          toast('Wager window closed — too slow!');
        } else if (res.status === 401) {
          expired();
        } else {
          toast('That wager didn\u2019t land. Try again.');
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Update wager';
        toast('Connection hiccup — try again.');
      });
  }

  /* ---------- question phase ---------- */

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

  function renderQuestion(state) {
    var q = state.question;
    if ($('#pqOptions').dataset.qid !== q.id) {
      scoreAtQuestionStart = myAllScore();
      lastChoice = -1;
      $('#pqOptions').dataset.qid = q.id;
      $('#pqCat').textContent = String(q.category || '').replace(/-/g, ' ').toUpperCase();
      $('#pqDiff').textContent = q.difficulty || '';
      $('#pqText').textContent = q.text;
      $('#watchTv').hidden = !(q.image || q.video);
      var wb = $('#wagerQBadge');
      if (q.isWager) {
        wb.hidden = false;
        $('#wagerQAmount').textContent = myWager > 0 ? ('you risked ' + fmt(myWager)) : 'no wager placed';
      } else {
        wb.hidden = true;
      }
      buildOptions(q.options);
    }
    setPhase('question');
  }

  function answer(choice) {
    if (!session || !lastState || !lastState.question) return;
    var qid = lastState.question.id;
    if (lastAnsweredQid === qid) return;
    var btns = $('#pqOptions').querySelectorAll('.pq-opt');
    btns.forEach(function (b) { b.disabled = true; });
    if (btns[choice]) btns[choice].classList.add('picked');
    post('/api/answer', { playerId: session.playerId, token: session.token, choice: choice })
      .then(function (res) {
        if (res.ok) {
          lastAnsweredQid = qid;
          lastChoice = choice;
          setPhase('locked');
        } else if (res.status === 409) {
          var err = String((res.j && res.j.error) || '');
          if (/already answered/i.test(err)) {
            lastAnsweredQid = qid;
            lastChoice = choice;
            setPhase('locked');
          } else {
            toast('Too slow — that question moved on!');
            btns.forEach(function (b) { b.disabled = false; b.classList.remove('picked'); });
          }
        } else if (res.status === 401) {
          expired();
        } else {
          toast('Hmm, that didn\u2019t land. Tap again.');
          btns.forEach(function (b) { b.disabled = false; b.classList.remove('picked'); });
        }
      })
      .catch(function () {
        toast('Connection hiccup — tap again.');
        btns.forEach(function (b) { b.disabled = false; b.classList.remove('picked'); });
      });
  }

  /* ---------- reveal phase ---------- */

  function renderReveal(state) {
    var r = state.reveal;
    var me = null;
    (r.results || []).forEach(function (x) {
      if (session && String(x.name).toLowerCase() === session.name.toLowerCase()) me = x;
    });
    if (me && !entryIn(lastState.leaderboard)) myScoreEst += (me.delta || 0);
    var pts = $('#rvPoints');
    pts.classList.remove('neg');
    if (me) {
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
  }

  /* ---------- idle / podium mini board ---------- */

  function renderBoard(state) {
    var isPodium = state.phase === 'podium' && state.podium;
    var b = state.block || {};
    $('#boardKicker').textContent = isPodium ? ('Block ' + (b.number || '') + ' podium') : 'Live board';
    $('#boardTitle').textContent = isPodium ? 'Block champions' : 'Top players';
    var rows = isPodium ? (state.podium.top || []) : (state.leaderboard || []).slice(0, 5);
    var ol = $('#miniBoard');
    ol.innerHTML = '';
    if (!rows.length) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="mb-name">No scores yet — be the first legend.</span>';
      ol.appendChild(li);
    }
    rows.forEach(function (r, i) {
      var li2 = document.createElement('li');
      var isMe = session && String(r.name).toLowerCase() === session.name.toLowerCase();
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
      ? 'New block starting — fresh scores, same legends.'
      : ('Block ' + (b.number || 1) + ' · question ' + (b.questionInBlock || 1) + ' of 10 · next up soon.');
    setPhase('board');
  }

  /* ---------- timers ---------- */

  function tickTimers() {
    if (!lastState) return;
    var now = Date.now();
    if (lastState.phase === 'question' && lastState.question) {
      var q = lastState.question;
      var total = (q.seconds || 20) * 1000;
      var w = Math.max(0, Math.min(100, 100 * (q.endsAt - now) / total));
      var el = $('#pqTimerFill');
      if (el) el.style.width = w + '%';
    }
    if (lastState.phase === 'wager' && lastState.wager) {
      var w2 = Math.max(0, Math.min(100, 100 * (lastState.wager.endsAt - now) / (WAGER_SECONDS * 1000)));
      var el2 = $('#wagerTimerFill');
      if (el2) el2.style.width = w2 + '%';
    }
  }
  setInterval(tickTimers, 200);

  /* ---------- join ---------- */

  function expired() {
    clearSession();
    lastAnsweredQid = null;
    myScoreEst = 0;
    wagerPhaseKey = null;
    setPhase('join');
    toast('Session expired — join again to keep playing.');
  }

  function join(name) {
    return post('/api/join', { name: name }).then(function (res) {
      if (!res.ok) throw new Error((res.j && res.j.error) || 'join failed');
      session = { playerId: res.j.playerId, token: res.j.token, name: res.j.name };
      saveSession(session);
      lastAnsweredQid = null;
      lastChoice = -1;
      myScoreEst = 0;
      myWager = 0;
      wagerPhaseKey = null;
      connect();
      return true;
    });
  }

  function showJoinError(msg) {
    var e = $('#joinError');
    e.textContent = msg;
    e.hidden = false;
  }

  $('#joinBtn').addEventListener('click', function () {
    var name = $('#nameInput').value.trim();
    $('#joinError').hidden = true;
    if (!name) { $('#nameInput').focus(); return; }
    var btn = $('#joinBtn');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    join(name).catch(function (err) {
      btn.disabled = false;
      btn.textContent = 'Let\u2019s go';
      showJoinError((err && err.message) || 'Couldn\u2019t join. Try again.');
      $('#nameInput').focus();
    });
  });
  $('#nameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#joinBtn').click();
  });

  /* ---------- wager controls ---------- */

  $('#wagerSlider').addEventListener('input', updateWagerAmount);
  $('#wagerBtn').addEventListener('click', placeWager);
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

  /* ---------- live state: SSE primary, polling watchdog fallback ---------- */

  var es = null;
  function showReconnect() { $('#reconnect').hidden = false; }
  function hideReconnect() { $('#reconnect').hidden = true; }

  function pollState() {
    fetch('/api/state')
      .then(function (r) { return r.json(); })
      .then(function (s) { lastMsgAt = Date.now(); hideReconnect(); render(s); })
      .catch(function () {});
  }

  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource('/api/events');
    es.onmessage = function (e) {
      lastMsgAt = Date.now();
      hideReconnect();
      try { render(JSON.parse(e.data)); } catch (err) {}
    };
    es.onopen = function () { hideReconnect(); };
    es.onerror = function () { showReconnect(); };
  }

  setInterval(function () {
    if (session && Date.now() - lastMsgAt > 6000) pollState();
  }, 2000);

  /* ---------- boot ---------- */

  var stored = loadSession();
  if (stored && stored.name) {
    join(stored.name).catch(function () {
      clearSession();
      setPhase('join');
    });
  } else {
    setPhase('join');
  }
  pollState();
})();
