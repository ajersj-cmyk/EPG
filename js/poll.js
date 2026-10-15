/* Cave Trivia (web) — realtime-with-polling-fallback for Firebase RTDB.
   Some networks block Firebase's websocket; the REST API still works fine.
   CT.poll.listen(db, path, cb, opts) attaches a normal .on('value') listener,
   but if no data arrives within graceMs it detaches and silently switches to
   REST polling every pollMs. The callback always receives a snapshot-like
   object with a .val() method, so existing handlers work unchanged.
   Writes are untouched (SDK writes work even when the read stream is dead). */
(function () {
  'use strict';

  var lastOkAt = 0;      // last time ANY data arrived (realtime or poll)
  var connMode = 'init'; // 'live' | 'polling' | 'init'

  function snapOf(data) {
    return { val: function () { return data; } };
  }

  function setConnMode(mode) {
    connMode = mode;
    try {
      var el = document.getElementById('connMode');
      if (el) {
        el.hidden = false;
        el.textContent = (mode === 'polling') ? 'POLLING' : 'LIVE';
        if (el.classList) el.classList.toggle('polling', mode === 'polling');
      }
    } catch (e) { /* indicator is cosmetic */ }
  }

  function fetchJson(url, cb) {
    try {
      fetch(url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        cb(null, d == null ? null : d);
      }).catch(function (e) {
        cb(e || new Error('fetch failed'));
      });
    } catch (e) {
      cb(e);
    }
  }

  // db: firebase.database(), path: 'rooms/cave/state' (no leading slash),
  // cb: function (snapshotLike), opts: { databaseURL, graceMs, pollMs }
  function listen(db, path, cb, opts) {
    opts = opts || {};
    var graceMs = opts.graceMs || 5000;
    var pollMs = opts.pollMs || 1500;
    var dbUrl = String(opts.databaseURL || '').replace(/\/+$/, '');
    var stopped = false;
    var gotData = false;  // realtime delivered at least once
    var hasLast = false;
    var lastJson = null;
    var timer = null;
    var iv = null;
    var ref = null;

    // Heartbeat: record arrival on EVERY successful receipt, but only invoke
    // the callback when the payload actually changed (matches realtime semantics).
    function fire(data) {
      lastOkAt = Date.now();
      var j = null;
      try { j = JSON.stringify(data == null ? null : data); } catch (e) { j = null; }
      if (hasLast && j === lastJson) return;
      hasLast = true;
      lastJson = j;
      try { cb(snapOf(data == null ? null : data)); } catch (e) { /* never throw */ }
    }

    function onVal(snap) {
      gotData = true;
      setConnMode('live');
      var v = null;
      try { v = snap.val(); } catch (e) { v = null; }
      fire(v);
    }

    function startPolling() {
      if (stopped || iv) return;
      if (!dbUrl) return; // no REST base: leave the realtime listener attached
      try { if (ref) ref.off('value', onVal); } catch (e) {}
      setConnMode('polling');
      var url = dbUrl + '/' + path + '.json';
      fetchJson(url, function (err, d) { if (!err && !stopped) fire(d); });
      iv = setInterval(function () {
        if (stopped) return;
        fetchJson(url, function (err, d) { if (!err && !stopped) fire(d); });
      }, pollMs);
    }

    function api() {
      return {
        stop: function () {
          stopped = true;
          if (timer) clearTimeout(timer);
          if (iv) clearInterval(iv);
          try { if (ref) ref.off('value', onVal); } catch (e) {}
        }
      };
    }

    try {
      ref = db.ref(path);
      ref.on('value', onVal);
    } catch (e) {
      startPolling(); // realtime attach itself failed -> poll immediately
      return api();
    }

    timer = setTimeout(function () {
      if (!gotData && !stopped) startPolling();
    }, graceMs);

    return api();
  }

  window.CT = window.CT || {};
  window.CT.poll = {
    listen: listen,
    setConnMode: setConnMode,
    lastOkAt: function () { return lastOkAt; },
    mode: function () { return connMode; }
  };
})();
