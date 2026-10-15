/* Cave Trivia (web) — pure REST data layer for Firebase RTDB.
   No websockets, no Firebase SDK. Every read is a REST GET poll, every
   write is a REST PUT/PATCH/DELETE via fetch. Works on any network that
   can fetch https URLs — bulletproof where websockets are blocked.

   CT.poll.listen(path, cb, opts) polls <databaseURL>/<path>.json every
   pollMs and invokes cb with a snapshot-like { val() } only when the
   payload actually changed.

   CT.rest.db(databaseURL) returns a tiny db shim with .ref(path) exposing
   .set()/.update()/.remove()/.once('value')/.child() — all via REST — so
   existing SDK-style call sites keep working with minimal changes.
   CT.rest.ts() returns the REST server-timestamp sentinel {".sv":"timestamp"}. */
(function () {
  'use strict';

  var lastOkAt = 0;      // last time ANY poll succeeded
  var connMode = 'polling';

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

  function cleanUrl(dbUrl) { return String(dbUrl || '').replace(/\/+$/, ''); }
  function cleanPath(p) { return String(p || '').replace(/^\/+/, ''); }
  function urlFor(dbUrl, path) {
    var u = cleanUrl(dbUrl);
    var p = cleanPath(path);
    return u + (p ? '/' + p : '/') + '.json';
  }

  function req(method, url, data) {
    var opts = { method: method, cache: 'no-store' };
    if (method === 'PUT' || method === 'PATCH') {
      opts.headers = { 'Content-Type': 'application/json' };
      try { opts.body = JSON.stringify(data === undefined ? null : data); }
      catch (e) { return Promise.reject(e); }
    }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + method);
      return r.text().then(function (t) {
        if (!t) return null;
        try { return JSON.parse(t); } catch (e) { return null; }
      });
    });
  }

  var rest = {
    // Server-timestamp sentinel for writes (REST equivalent of ServerValue.TIMESTAMP).
    ts: function () { return { '.sv': 'timestamp' }; },

    get: function (dbUrl, path) { return req('GET', urlFor(dbUrl, path)); },
    set: function (dbUrl, path, data) { return req('PUT', urlFor(dbUrl, path), data); },
    patch: function (dbUrl, path, data) { return req('PATCH', urlFor(dbUrl, path), data); },
    del: function (dbUrl, path) { return req('DELETE', urlFor(dbUrl, path)); },

    // Minimal SDK-compatible handle. Multi-path PATCH keys (e.g. 'rooms/cave/state')
    // are honored by the REST API when PATCHing a parent path.
    db: function (dbUrl) {
      var base = cleanUrl(dbUrl);
      function ref(path) {
        var p = cleanPath(path);
        var url = urlFor(base, p);
        return {
          set: function (data) { return req('PUT', url, data); },
          update: function (data) { return req('PATCH', url, data); },
          remove: function () { return req('DELETE', url); },
          once: function () {
            return req('GET', url).then(function (d) { return snapOf(d); });
          },
          child: function (c) { return ref(p ? p + '/' + cleanPath(c) : cleanPath(c)); },
          on: function () { throw new Error('realtime .on() is not supported in REST mode'); },
          off: function () {},
          onDisconnect: function () {
            var noop = function () { return Promise.resolve(); };
            return { set: noop, update: noop, remove: noop };
          }
        };
      }
      return { ref: ref };
    }
  };

  // path: 'rooms/cave/state' (no leading slash),
  // cb: function (snapshotLike), opts: { databaseURL, pollMs }
  function listen(path, cb, opts) {
    opts = opts || {};
    var pollMs = opts.pollMs || 1500;
    var dbUrl = cleanUrl(opts.databaseURL);
    var stopped = false;
    var hasLast = false;
    var lastJson = null;
    var iv = null;

    // Only invoke the callback when the payload actually changed
    // (matches realtime 'value' semantics for our renderers).
    function fire(data) {
      lastOkAt = Date.now();
      var j = null;
      try { j = JSON.stringify(data === undefined ? null : data); } catch (e) { j = null; }
      if (hasLast && j === lastJson) return;
      hasLast = true;
      lastJson = j;
      try { cb(snapOf(data === undefined ? null : data)); } catch (e) { /* never throw */ }
    }

    function tick() {
      if (stopped || !dbUrl) return;
      req('GET', urlFor(dbUrl, path)).then(function (d) {
        if (!stopped) fire(d);
      }).catch(function () { /* silent; next tick retries */ });
    }

    setConnMode('polling');
    tick();
    iv = setInterval(tick, pollMs);

    return {
      stop: function () {
        stopped = true;
        if (iv) clearInterval(iv);
      }
    };
  }

  window.CT = window.CT || {};
  window.CT.poll = {
    listen: listen,
    setConnMode: setConnMode,
    lastOkAt: function () { return lastOkAt; },
    mode: function () { return connMode; }
  };
  window.CT.rest = rest;
})();
