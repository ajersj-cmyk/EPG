/* Cave Trivia — TV display logic. SSE-driven, broadcast-smooth. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var FACTS = [
    'The World Wide Web opened to the public in 1991.',
    'The first SMS text ever sent read “Merry Christmas” — in 1992.',
    'Google was founded in a garage in 1998.',
    'The DVD launched in the United States in 1997.',
    'The Nintendo 64 arrived in the US in 1996 with Super Mario 64.',
    'The first Harry Potter book was published in 1997.',
    'Titanic became the first film to gross $1 billion in 1997.',
    'The Macarena craze peaked in the summer of 1996.',
    'Dolly the sheep, the first cloned mammal, was born in 1996.',
    'The PlayStation launched in North America in 1995.',
    'eBay began in 1995 as a site called AuctionWeb.',
    'Jurassic Park changed blockbuster CGI forever in 1993.',
    'Seinfeld’s 1998 finale drew 76 million viewers.',
    'The Channel Tunnel opened in 1994, linking England and France.',
    'The Tamagotchi digital pet took over playgrounds in 1997.',
    'Beanie Babies sparked a full-blown collecting frenzy in the late 90s.',
    'The Game Boy Camera turned heads in 1998.',
    'The Rachel haircut swept salons after Friends debuted in 1994.',
    'The first International Space Station module launched in 1998.',
    'Everyone was nervous about the Y2K bug as 1999 came to a close.'
  ];

  var LETTERS = ['A', 'B', 'C', 'D'];
  var lastJoinUrl = '';
  var lastState = null;
  var factIdx = 0;

  function fmtCategory(c) {
    return String(c || '').replace(/-/g, ' ').toUpperCase();
  }

  function renderQr(url) {
    if (!url || url === lastJoinUrl) return;
    lastJoinUrl = url;
    try {
      var qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      var svg = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
      $('#qr').innerHTML = svg;
      $('#qrSmall').innerHTML = svg;
      $('#joinUrl').textContent = url;
    } catch (e) {
      $('#joinUrl').textContent = url;
    }
  }

  function setPhase(name) {
    ['idle', 'question', 'reveal'].forEach(function (p) {
      $('#phase-' + p).classList.toggle('active', p === name);
    });
  }

  function buildOptions(container, options, correctIndex, revealed) {
    container.innerHTML = '';
    options.forEach(function (text, i) {
      var d = document.createElement('div');
      d.className = 'q-opt';
      if (revealed) {
        d.classList.add(i === correctIndex ? 'correct' : 'dim');
      }
      var l = document.createElement('span');
      l.className = 'letter';
      l.textContent = LETTERS[i];
      var t = document.createElement('span');
      t.textContent = text;
      d.appendChild(l);
      d.appendChild(t);
      container.appendChild(d);
    });
  }

  function renderTicker(board) {
    var track = $('#tickerTrack');
    var empty = !board || board.length === 0;
    track.classList.toggle('is-empty', empty);
    if (empty) {
      track.innerHTML = '<span>No scores yet — be the first legend of the cave.</span>';
      return;
    }
    var html = board.slice(0, 10).map(function (r, i) {
      return '<span><b>' + (i + 1) + '.</b>' + escapeHtml(r.name.toUpperCase()) +
        ' — ' + Number(r.score).toLocaleString() + '</span>';
    }).join('');
    track.innerHTML = html + html; // duplicated for a seamless loop
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderMiniBoard(board) {
    var el = $('#rBoard');
    el.innerHTML = '';
    board.slice(0, 5).forEach(function (r, i) {
      var c = document.createElement('span');
      c.className = 'mini-chip' + (i === 0 ? ' lead' : '');
      c.innerHTML = '<b>' + (i + 1) + '</b>' + escapeHtml(r.name) + ' · ' + Number(r.score).toLocaleString();
      el.appendChild(c);
    });
  }

  function render(state) {
    lastState = state;
    renderQr(state.joinUrl);
    $('#playerCount').textContent = state.playersActive;
    if (state.attribution) $('#attrib').textContent = state.attribution;
    renderTicker(state.leaderboard);
    $('#apToggle').classList.toggle('on', !!state.autoPilot);

    var phase = state.phase || 'idle';
    setPhase(phase);

    if (phase === 'question' && state.question) {
      var q = state.question;
      $('#qCat').textContent = fmtCategory(q.category);
      $('#qDiff').textContent = q.difficulty;
      $('#qRound').textContent = 'Round ' + (state.round || '—');
      $('#qText').textContent = q.text;
      if ($('#qOptions').dataset.qid !== q.id) {
        $('#qOptions').dataset.qid = q.id;
        buildOptions($('#qOptions'), q.options, -1, false);
      }
      $('#qLocked').textContent = q.answeredCount;
    }

    if (phase === 'reveal' && state.question && state.reveal) {
      var r = state.reveal;
      $('#rCat').textContent = fmtCategory(state.question.category);
      $('#rRound').textContent = 'Round ' + (state.round || '—');
      $('#rText').textContent = state.question.text;
      if ($('#rOptions').dataset.qid !== state.question.id) {
        $('#rOptions').dataset.qid = state.question.id;
        buildOptions($('#rOptions'), state.question.options, r.correctIndex, true);
      }
      $('#rNote').innerHTML = '<b>' + r.correctCount + '</b> of <b>' + r.answeredCount +
        '</b> players answered correctly';
      renderMiniBoard(state.sessionBoard && state.sessionBoard.length ? state.sessionBoard : state.leaderboard);
    }

    tickTimer();
  }

  function tickTimer() {
    if (!lastState || lastState.phase !== 'question' || !lastState.question) return;
    var ms = Math.max(0, lastState.question.endsAt - Date.now());
    var total = 20 * 1000;
    $('#qTimerFill').style.width = (100 * ms / total) + '%';
    $('#qSecs').textContent = Math.ceil(ms / 1000);
  }
  setInterval(tickTimer, 200);

  // clock
  function tickClock() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    $('#clock').textContent = h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  tickClock();
  setInterval(tickClock, 10000);

  // rotating facts
  var factEl = $('#factText');
  function showFact() {
    factEl.classList.add('fading');
    setTimeout(function () {
      factEl.textContent = FACTS[factIdx++ % FACTS.length];
      factEl.classList.remove('fading');
    }, 600);
  }
  showFact();
  setInterval(showFact, 9000);

  // host controls
  function host(action, body) {
    fetch('/api/host/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).catch(function () {});
  }
  $('#btnStart').addEventListener('click', function () { host('start'); });
  $('#btnNext').addEventListener('click', function () { host('next'); });
  $('#btnReveal').addEventListener('click', function () { host('reveal'); });
  $('#btnReset').addEventListener('click', function () {
    if (confirm('End the session and clear session scores? All-time records are kept.')) host('reset');
  });
  $('#apToggle').addEventListener('click', function () {
    var on = !$('#apToggle').classList.contains('on');
    host('autopilot', { on: on });
  });

  // SSE with auto-reconnect (EventSource reconnects natively)
  function connect() {
    var es = new EventSource('/api/events');
    es.onmessage = function (e) {
      try { render(JSON.parse(e.data)); } catch (err) { /* ignore */ }
    };
    es.onerror = function () {
      // EventSource will retry on its own; as a fallback, poll once
      setTimeout(function () {
        if (es.readyState === EventSource.CLOSED) {
          fetch('/api/state').then(function (r) { return r.json(); }).then(render).catch(function () {});
        }
      }, 4000);
    };
  }
  connect();
  // initial paint in case SSE is slow
  fetch('/api/state').then(function (r) { return r.json(); }).then(render).catch(function () {});
})();
