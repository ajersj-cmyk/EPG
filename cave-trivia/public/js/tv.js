/* Cave Trivia — TV display logic. Always-on living game, SSE-driven.
   Contract: CONTRACT.md v2. Broadcast-smooth, never a dead screen. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var LETTERS = ['A', 'B', 'C', 'D'];
  var PHASES = ['idle', 'wager', 'question', 'reveal', 'podium'];

  var lastJoinUrl = '';
  var lastState = null;
  var lastPhase = '';
  var lastQid = '';
  var skew = 0; // Date.now() - serverTime at last render

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

  /* ---------------- helpers ---------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
  function fmtDelta(d) { d = Number(d || 0); return (d > 0 ? '+' : '') + fmtNum(d); }
  function fmtCategory(c) { return String(c || '').replace(/-/g, ' ').toUpperCase(); }

  function timeLeftMs(obj) {
    if (!obj || !obj.endsAt) return 0;
    return Math.max(0, obj.endsAt - (Date.now() - skew));
  }

  function renderQr(url) {
    if (!url || url === lastJoinUrl) return;
    lastJoinUrl = url;
    try {
      var qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
      $('#joinUrl').textContent = url;
    } catch (e) {
      $('#joinUrl').textContent = url;
    }
  }

  function sweepStreak() {
    var s = $('#streak');
    s.classList.remove('sweep');
    void s.offsetWidth; // restart the animation
    s.classList.add('sweep');
  }

  function setPhase(name) {
    PHASES.forEach(function (p) {
      var el = document.getElementById('phase-' + p);
      if (el) el.classList.toggle('active', p === name);
    });
  }

  function onPhaseChange(phase) {
    sweepStreak();
    if (phase === 'question') sQuestionSting();
    else if (phase === 'reveal') sRevealHit();
    else if (phase === 'wager') sWagerSwell();
    else if (phase === 'podium') sFanfare();
  }

  /* ---------------- rail : progress, leaderboard, QR ---------------- */
  var pipsBuilt = false;
  function renderProgress(block) {
    var b = block || {};
    var num = b.number || 1, qib = b.questionInBlock || 1;
    $('#qibNum').textContent = qib;
    $('#blockNum').textContent = num;
    var pips = $('#pips');
    if (!pipsBuilt) {
      for (var i = 0; i < 10; i++) {
        var p = document.createElement('i');
        if (i === 9) p.className = 'wager';
        pips.appendChild(p);
      }
      pipsBuilt = true;
    }
    Array.prototype.forEach.call(pips.children, function (el, i) {
      el.classList.toggle('done', i < qib - 1);
      el.classList.toggle('now', i === qib - 1);
    });
  }

  function renderBoard(board) {
    var el = $('#blockBoard');
    el.innerHTML = '';
    if (!board || !board.length) {
      el.innerHTML = '<div class="board-empty">No scores yet &mdash; be the first legend of the cave.</div>';
      return;
    }
    board.slice(0, 10).forEach(function (r, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="nm">' + escapeHtml(r.name) + '</span>' +
        '<span class="sc">' + fmtNum(r.score) + '</span>';
      el.appendChild(li);
    });
  }

  /* ---------------- phase renderers ---------------- */
  function renderIdle(state) {
    $('#attractVenue').textContent = state.venueName || 'CAVE TRIVIA';
    var src = (state.blockBoard && state.blockBoard.length ? state.blockBoard : state.leaderboard) || [];
    var el = $('#attractBoard');
    el.innerHTML = '';
    src.slice(0, 5).forEach(function (r, i) {
      var c = document.createElement('span');
      c.className = 'attract-chip';
      c.innerHTML = '<b>' + (i + 1) + '</b>' + escapeHtml(r.name) + ' &middot; ' + fmtNum(r.score);
      el.appendChild(c);
    });
  }

  function renderWager(state) {
    var w = state.wager || {};
    $('#wagerCat').textContent = fmtCategory(w.category) || 'MYSTERY';
    var n = w.wagersPlaced || 0;
    var el = $('#wagerCount');
    el.hidden = n <= 0;
    el.textContent = n === 1 ? '1 player has wagered' : n + ' players have wagered';
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

  function renderQuestion(state) {
    var q = state.question;
    if (!q) return;
    var media = $('#qMedia'), img = $('#qImg'), frame = $('#qVideoFrame'), vid = $('#qVideo');
    if (lastQid !== q.id) {
      lastQid = q.id;
      var b = state.block || {};
      $('#qCat').textContent = fmtCategory(q.category);
      $('#qDiff').textContent = q.difficulty || '';
      $('#qRound').textContent = 'Q' + (b.questionInBlock || '?') + ' / Block ' + (b.number || '?');
      $('#qWagerBadge').hidden = !q.isWager;
      $('#qText').textContent = q.text;
      buildOptions($('#qOptions'), q.options, -1, false);
      // media: video wins over image; image goes full-bleed behind the text
      media.classList.remove('bleed');
      img.removeAttribute('src');
      frame.hidden = true;
      vid.src = 'about:blank';
      if (q.video && q.video.youtubeId) {
        media.hidden = false;
        frame.hidden = false;
        vid.src = 'https://www.youtube.com/embed/' + encodeURIComponent(q.video.youtubeId) +
          '?autoplay=1&rel=0&start=' + (q.video.start || 0) + '&end=' + (q.video.end || 0);
      } else if (q.image) {
        media.hidden = false;
        media.classList.add('bleed');
        img.src = q.image;
      } else {
        media.hidden = true;
      }
    }
    $('#qLocked').textContent = q.answeredCount || 0;
  }

  function renderReveal(state) {
    var q = state.question, r = state.reveal;
    if (!q || !r) return;
    var b = state.block || {};
    if (lastQid !== 'r' + q.id) {
      lastQid = 'r' + q.id;
      $('#rCat').textContent = fmtCategory(q.category);
      $('#rRound').textContent = 'Q' + (b.questionInBlock || '?') + ' / Block ' + (b.number || '?');
      $('#rWagerBadge').hidden = !r.isWager;
      $('#rText').textContent = q.text;
      buildOptions($('#rOptions'), q.options, r.correctIndex, true);
      $('#rNote').innerHTML = '<b>' + r.correctCount + '</b> of <b>' + r.answeredCount +
        '</b> answered correctly &mdash; ' + escapeHtml(r.correctText || '');
      var list = $('#rResults');
      list.innerHTML = '';
      (r.results || []).slice(0, 8).forEach(function (row) {
        var li = document.createElement('li');
        var d = Number(row.delta || 0);
        var wagerNote = (r.isWager && row.wager > 0)
          ? '<span class="wg">risked ' + fmtNum(row.wager) + '</span>' : '';
        li.innerHTML = '<span class="nm">' + escapeHtml(row.name) + '</span>' + wagerNote +
          '<span class="delta ' + (d >= 0 ? 'pos' : 'neg') + '">' + fmtDelta(d) + '</span>';
        list.appendChild(li);
      });
    }
  }

  function renderPodium(state) {
    var p = state.podium;
    if (!p || !p.top) return;
    var b = state.block || {};
    $('#podiumBlock').textContent = b.number || '';
    var steps = $('#podiumSteps');
    if (steps.dataset.n !== String(p.top.length) || !steps.children.length) {
      steps.innerHTML = '';
      steps.dataset.n = String(p.top.length);
      var order = [1, 0, 2]; // silver, gold, bronze
      var cls = ['second', 'first', 'third'];
      var medals = ['2', '1', '3'];
      order.forEach(function (idx, k) {
        var row = p.top[idx];
        if (!row) return;
        var d = document.createElement('div');
        d.className = 'podium-step ' + cls[k];
        d.innerHTML = '<div class="p-name">' + escapeHtml(row.name) + '</div>' +
          '<div class="p-score">' + fmtNum(row.score) + '</div>' +
          '<div class="p-block">' + medals[k] + '</div>';
        steps.appendChild(d);
      });
    }
  }

  function stopVideo() {
    var vid = $('#qVideo');
    if (vid && vid.src && vid.src !== 'about:blank') vid.src = 'about:blank';
  }

  /* ---------------- master render ---------------- */
  function render(state) {
    if (!state) return;
    lastState = state;
    skew = Date.now() - (state.serverTime || Date.now());

    $('#venueName').textContent = (state.venueName || 'CAVE TRIVIA').toUpperCase();
    $('#familyBadge').hidden = !state.familyMode;
    $('#playerCount').textContent = state.playersActive || 0;
    if (state.attribution) $('#attrib').textContent = state.attribution;
    $('#apToggle').classList.toggle('on', !!state.autoPilot);
    $('#famToggle').classList.toggle('on', !!state.familyMode);
    renderSettings(state);

    renderQr(state.joinUrl);
    renderProgress(state.block);
    renderBoard(state.blockBoard);

    var phase = state.phase || 'idle';
    if (phase !== lastPhase) {
      if (lastPhase === 'question') stopVideo();
      onPhaseChange(phase);
      lastPhase = phase;
      if (phase !== 'question' && phase !== 'reveal') lastQid = '';
    }
    setPhase(phase);

    if (phase === 'idle') renderIdle(state);
    else if (phase === 'wager') renderWager(state);
    else if (phase === 'question') renderQuestion(state);
    else if (phase === 'reveal') renderReveal(state);
    else if (phase === 'podium') renderPodium(state);

    tickTimers(true);
  }

  /* ---------------- timers + countdown ticks ---------------- */
  var RING_C = 2 * Math.PI * 54;
  var tickKey = '', tickSec = -1;

  function tickTimers(force) {
    var st = lastState;
    if (!st) return;
    var ms = 0, total = 1, key = '';
    if (st.phase === 'question' && st.question) {
      ms = timeLeftMs(st.question);
      total = (st.question.seconds || 20) * 1000;
      key = 'q:' + st.question.id;
      var frac = total > 0 ? ms / total : 0;
      $('#qTimerFill').style.width = (100 * Math.max(0, Math.min(1, frac))) + '%';
      $('#qTimerFill').parentElement.classList.toggle('low', ms < 5000);
      $('#qSecs').textContent = Math.ceil(ms / 1000);
    } else if (st.phase === 'wager' && st.wager) {
      ms = timeLeftMs(st.wager);
      total = 15000;
      key = 'w:' + (st.wager.category || '');
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
  setInterval(function () { tickTimers(false); }, 200);

  /* ---------------- clock ---------------- */
  function tickClock() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    $('#clock').textContent = h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  tickClock();
  setInterval(tickClock, 10000);

  /* ---------------- host controls ---------------- */
  function host(action, body) {
    try {
      fetch('/api/host/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).catch(function () {});
    } catch (e) {}
  }
  $('#btnNext').addEventListener('click', function () { host('next'); });
  $('#btnReveal').addEventListener('click', function () { host('reveal'); });
  $('#apToggle').addEventListener('click', function () {
    host('autopilot', { on: !$('#apToggle').classList.contains('on') });
  });
  $('#famToggle').addEventListener('click', function () {
    host('family', { on: !$('#famToggle').classList.contains('on') });
  });

  /* ---------------- settings panel ---------------- */
  var CATS = ['movies', 'music', 'tv', 'sports', 'games', 'toys', 'pokemon', 'disney', 'pixar', 'parks', 'toons', 'jeopardy', 'mixed'];
  var lastDisabled = [];
  function renderSettings(state) {
    // theme
    var theme = state.theme || 'midnight-gold';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
    document.querySelectorAll('.theme-swatch').forEach(function (el) {
      el.classList.toggle('active', el.dataset.theme === theme);
    });
    // title
    var ti = $('#gameTitleInput');
    if (ti && document.activeElement !== ti) ti.value = state.venueName || '';
    // categories
    var disabled = state.disabledCats || [];
    if (JSON.stringify(disabled) !== JSON.stringify(lastDisabled)) {
      lastDisabled = disabled.slice();
      var grid = $('#catGrid');
      grid.innerHTML = '';
      CATS.forEach(function (cat) {
        var off = disabled.indexOf(cat) >= 0;
        var label = document.createElement('label');
        label.className = 'cat-toggle' + (off ? ' off' : '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !off;
        cb.addEventListener('change', function () { host('toggleCat', { cat: cat }); });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(cat));
        grid.appendChild(label);
      });
    }
  }
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
    el.addEventListener('click', function () { host('theme', { theme: el.dataset.theme }); });
  });
  $('#btnTitleSave').addEventListener('click', function () {
    var v = $('#gameTitleInput').value.trim();
    if (v) host('venue', { name: v });
  });
  $('#gameTitleInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('#btnTitleSave').click();
    e.stopPropagation();
  });

  function paintSoundBtn() {
    var b = $('#btnSound');
    b.textContent = soundOn ? 'Sound on' : 'Sound off';
    b.classList.toggle('off', !soundOn);
  }
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
    if (k === 'n') host('next');
    else if (k === 'r') host('reveal');
    else if (k === 'f') host('family', { on: !$('#famToggle').classList.contains('on') });
    else if (k === 'a') host('autopilot', { on: !$('#apToggle').classList.contains('on') });
  });

  /* ---------------- SSE with graceful reconnect : never a raw error ---------------- */
  var es = null;
  var pill = $('#reconnect');
  function showPill() { pill.hidden = false; }
  function hidePill() { pill.hidden = true; }

  function connect() {
    try { if (es) es.close(); } catch (e) {}
    try {
      es = new EventSource('/api/events');
      es.onopen = function () { hidePill(); };
      es.onmessage = function (e) {
        hidePill();
        try { render(JSON.parse(e.data)); } catch (err) { /* ignore malformed */ }
      };
      es.onerror = function () {
        if (!es || es.readyState !== 1) showPill(); // 1 = OPEN
      };
    } catch (e) { showPill(); }
  }
  connect();
  // watchdog: EventSource retries natively; if it ever fully closes, reconnect + poll once
  setInterval(function () {
    if (!es || es.readyState === 2) { // 2 = CLOSED
      showPill();
      connect();
      fetch('/api/state').then(function (r) { return r.json(); })
        .then(function (s) { hidePill(); render(s); })
        .catch(function () {});
    }
  }, 3000);

  // initial paint in case SSE is slow
  fetch('/api/state').then(function (r) { return r.json(); }).then(render).catch(function () {});
})();
