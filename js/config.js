/* Cave Trivia (web) — Firebase config loader.
   The firebaseConfig JSON is pasted once on the TV (first-run setup screen)
   and stored in localStorage under CT_CONFIG_KEY. Phones receive it via the
   QR code (#c=<base64url> appended to the play.html URL) so they need no setup. */
(function () {
  'use strict';

  var CT_CONFIG_KEY = 'ct-firebase-config';

  // Baked-in default: the project's own Firebase (free Spark plan).
  // The TV setup screen can still override this (saved to localStorage).
  // Firebase apiKeys are public by design — access is controlled by database rules.
  var DEFAULT_CONFIG = {
    "apiKey": "AIzaSyCsOPjYQ6StRZoCJZZ6Tc3xUAhM2MFab_8",
    "authDomain": "cave-trivia.firebaseapp.com",
    "databaseURL": "https://cave-trivia-default-rtdb.firebaseio.com",
    "projectId": "cave-trivia",
    "storageBucket": "cave-trivia.firebasestorage.app",
    "messagingSenderId": "83160773290",
    "appId": "1:83160773290:web:4bc33f84450f87388716d3"
  };

  function readStored() {
    try {
      var raw = localStorage.getItem(CT_CONFIG_KEY);
      if (raw) {
        var cfg = JSON.parse(raw);
        if (isValid(cfg)) return cfg;
      }
    } catch (e) { /* fall through to default */ }
    return isValid(DEFAULT_CONFIG) ? DEFAULT_CONFIG : null;
  }

  function isValid(cfg) {
    return !!(cfg && cfg.apiKey && cfg.projectId && cfg.databaseURL);
  }

  function save(cfg) {
    localStorage.setItem(CT_CONFIG_KEY, JSON.stringify(cfg));
  }

  // Pull config from the URL hash (#c=...) — written by the TV's QR code.
  function readFromHash() {
    try {
      var m = (location.hash || '').match(/#c=([A-Za-z0-9\-_]+)/);
      if (!m) return null;
      var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var cfg = JSON.parse(decodeURIComponent(escape(atob(b64))));
      return isValid(cfg) ? cfg : null;
    } catch (e) { return null; }
  }

  function encodeForQr(cfg) {
    var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg))));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var db = null;
  var app = null;

  // Initialize the Firebase compat SDK. Returns firebase.database() or throws.
  function init(cfg) {
    if (db) return db;
    if (!window.firebase) throw new Error('Firebase SDK failed to load (check network).');
    if (!isValid(cfg)) throw new Error('Invalid Firebase config.');
    app = firebase.initializeApp(cfg);
    db = firebase.database();
    return db;
  }

  window.CT = window.CT || {};
  window.CT.config = {
    KEY: CT_CONFIG_KEY,
    readStored: readStored,
    readFromHash: readFromHash,
    save: save,
    isValid: isValid,
    encodeForQr: encodeForQr,
    init: init,
    db: function () { return db; },
  };
})();
