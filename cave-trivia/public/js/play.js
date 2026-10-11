/* Cave Trivia — phone client. Join once, play forever. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var STORE_KEY = 'cave-trivia-player';

  var session = null;      // {playerId, token, name}
  var lastState = null;
  var lastAnsweredQid = null;
  var lastChoice = -1;
  var scoreAtQuestionStart = 0;

  function setPhase(name) {
    ['join', 'lobby', 'question', 'locked', 'reveal'].forEach(function (p) {
      $('#p-' + p).classList.toggle('active', p === name);
    });
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function myRank(board) {
    if (!session || !board) return -1;
    for (var i = 0; i < board.length; i++) {
      if (board[i].name === session.name) return i + 1;
    }
    return -1;
  }
  function myScore(board) {
    if (!session || !board) return 0;
    for (var i = 0; i < board.length; i++) {
      if (board[i].name === session.name) return board[i].score;
    }
    return 0;
  }

  function renderScoreBox(state) {
    if (!session) { $('#scoreBox').hidden = true; return; }
    $('#scoreBox').hidden = false;
    var sc = myScore(state.leaderboard);
    var rk = myRank(state.leaderboard);
    $('#myScore').textContent = Number(sc).toLocaleString();
    $('#myRank').textContent = rk > 0 ? 'Rank #' + rk : 'Unranked';
  }

  function render(state) {
    lastState = state;
    if (!session) { setPhase('join'); return; }
    renderScoreBox(state);

    var phase = state.phase || 'idle';
    var q = state.question;

    if (phase === 'question' && q) {
      if (lastAnsweredQid === q.id) {
        setPhase('locked');
      } else {
        if ($('#pqOptions').dataset.qid !== q.id) {
          scoreAtQuestionStart = myScore(state.leaderboard);
          lastChoice = -1;
          $('#pqOptions').dataset.qid = q.id;
          $('#pqCat').textContent = String(q.category || '').replace(/-/g, ' ').toUpperCase();
          $('#pqDiff').textContent = q.difficulty;
          $('#pqText').textContent = q.text;
          buildOptions(q.options);
        }
        setPhase('question');
      }
    } else if (phase === 'reveal' && state.reveal) {
      renderReveal(state);
      setPhase('reveal');
    } else {
      // idle (attract) — lobby
      $('#lobbyName').textContent = session.name;
      $('#stScore').textContent = Number(myScore(state.leaderboard)).toLocaleString();
      var rk = myRank(state.leaderboard);
      $('#stRank').textContent = rk > 0 ? '#' + rk : '—';
      var me = (state.leaderboard || []).filter(function (r) { return r.name === session.name; })[0];
      $('#stCorrect').textContent = me ? me.correct : 0;
      $('#lobbyMsg').textContent = state.session && state.session.active
        ? 'Round is live — next question is coming up.'
        : 'Next question is coming up — keep your eyes on the big screen.';
      setPhase('lobby');
    }
    tickTimer();
  }

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

  function answer(choice) {
    if (!session || !lastState || !lastState.question) return;
    var qid = lastState.question.id;
    if (lastAnsweredQid === qid) return;
    var btns = $('#pqOptions').querySelectorAll('.pq-opt');
    btns.forEach(function (b) { b.disabled = true; });
    fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: session.playerId, token: session.token, choice: choice }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) {
          lastAnsweredQid = qid;
          lastChoice = choice;
          setPhase('locked');
        } else {
          btns.forEach(function (b) { b.disabled = false; });
        }
      })
      .catch(function () {
        btns.forEach(function (b) { b.disabled = false; });
      });
  }

  function renderReveal(state) {
    var r = state.reveal;
    var correct = lastChoice === r.correctIndex;
    var gained = myScore(state.leaderboard) - scoreAtQuestionStart;
    $('#rvKicker').textContent = correct ? 'Correct' : 'The answer';
    var pts = $('#rvPoints');
    if (correct && gained > 0) {
      pts.hidden = false;
      pts.textContent = '+' + gained;
    } else {
      pts.hidden = true;
    }
    $('#rvTitle').textContent = correct ? 'Nice one.' : 'Not this time.';
    $('#rvSub').textContent = correct
      ? 'That was worth ' + gained + ' points.'
      : 'Correct answer: ' + (r.correctText || '') + '. You’ll get the next one.';
  }

  function tickTimer() {
    if (!lastState || lastState.phase !== 'question' || !lastState.question) return;
    var ms = Math.max(0, lastState.question.endsAt - Date.now());
    var el = $('#pqTimerFill');
    if (el) el.style.width = (100 * ms / (20 * 1000)) + '%';
  }
  setInterval(tickTimer, 200);

  function join(name) {
    return fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error((res.j && res.j.error) || 'join failed');
        session = { playerId: res.j.playerId, token: res.j.token, name: res.j.name };
        saveSession(session);
        lastAnsweredQid = null;
        connect();
        return true;
      });
  }

  $('#joinBtn').addEventListener('click', function () {
    var name = $('#nameInput').value.trim();
    if (!name) { $('#nameInput').focus(); return; }
    $('#joinBtn').disabled = true;
    $('#joinBtn').textContent = 'Joining…';
    join(name).catch(function () {
      $('#joinBtn').disabled = false;
      $('#joinBtn').textContent = 'Join the game';
      $('#nameInput').focus();
    });
  });
  $('#nameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#joinBtn').click();
  });

  var es = null;
  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource('/api/events');
    es.onmessage = function (e) {
      try { render(JSON.parse(e.data)); } catch (err) {}
    };
  }

  // reclaim previous session if present
  var stored = loadSession();
  if (stored && stored.name) {
    join(stored.name).catch(function () {
      session = null;
      setPhase('join');
    });
  } else {
    setPhase('join');
  }
  fetch('/api/state').then(function (r) { return r.json(); }).then(function (s) {
    if (session) render(s);
  }).catch(function () {});
})();
