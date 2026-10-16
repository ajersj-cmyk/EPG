// Cave Trivia: frame/line vs text check. Paste into the TV page (or inject via
// puppeteer) and call window.ctLineCheck(rootSelector). Returns a list of
// places where a border, glow line or decorative pseudo-element edge crosses
// rendered text, plus any text box that overflows its container.
window.ctLineCheck = function (rootSel) {
  var root = document.querySelector(rootSel || 'body');
  if (!root) return [];
  var GLOW = 6; // px allowance for glow beyond the border edge
  function vis(el) {
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || +cs.opacity === 0 || cs.display === 'none') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest('[hidden],[aria-hidden=true],.ticker');
  }
  // text line boxes (precise, per line)
  var texts = [];
  var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    var n = tw.currentNode;
    if (!n.textContent.trim() || !n.parentElement || !vis(n.parentElement)) continue;
    var rg = document.createRange(); rg.selectNodeContents(n);
    [].forEach.call(rg.getClientRects(), function (r) {
      if (r.width > 2 && r.height > 2) texts.push({ r: r, el: n.parentElement, t: n.textContent.trim().slice(0, 30) });
    });
  }
  // line segments from borders on elements and their ::before/::after
  var segs = [];
  function addBox(r, cs, owner, tag) {
    ['Top', 'Right', 'Bottom', 'Left'].forEach(function (side) {
      var w = parseFloat(cs['border' + side + 'Width']) || 0;
      if (w <= 0 || cs['border' + side + 'Style'] === 'none') return;
      var g = w + GLOW, s;
      if (side === 'Top') s = { l: r.left, r: r.right, t: r.top - GLOW, b: r.top + g };
      if (side === 'Bottom') s = { l: r.left, r: r.right, t: r.bottom - g, b: r.bottom + GLOW };
      if (side === 'Left') s = { l: r.left - GLOW, r: r.left + g, t: r.top, b: r.bottom };
      if (side === 'Right') s = { l: r.right - g, r: r.right + GLOW, t: r.top, b: r.bottom };
      segs.push({ s: s, owner: owner, tag: tag + ':' + side });
    });
  }
  [].forEach.call(root.querySelectorAll('*'), function (el) {
    if (!vis(el)) return;
    var r = el.getBoundingClientRect();
    addBox(r, getComputedStyle(el), el, (el.id || el.className || el.tagName));
    ['::before', '::after'].forEach(function (p) {
      var cs = getComputedStyle(el, p);
      if (cs.content === 'none' || cs.display === 'none' || cs.position !== 'absolute') return;
      var L = parseFloat(cs.left), T = parseFloat(cs.top), W = parseFloat(cs.width), H = parseFloat(cs.height);
      if (isNaN(L) || isNaN(T) || isNaN(W) || isNaN(H)) return;
      var pr = { left: r.left + L, top: r.top + T, right: r.left + L + W, bottom: r.top + T + H };
      // thin pseudo bars (e.g. underline/glow lines) count as a line themselves
      if ((H <= 6 || W <= 6) && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none' && (H <= 6 || W <= 6))
        segs.push({ s: { l: pr.left, r: pr.right, t: pr.top - GLOW, b: pr.bottom + GLOW }, owner: el, tag: (el.id || el.className) + p + ':bar' });
      addBox(pr, cs, el, (el.id || el.className) + p);
    });
  });
  var out = [];
  texts.forEach(function (t) {
    segs.forEach(function (sg) {
      var s = sg.s, r = t.r;
      var w = Math.min(s.r, r.right) - Math.max(s.l, r.left), h = Math.min(s.b, r.bottom) - Math.max(s.t, r.top);
      if (w > 1 && h > 1) out.push('LINE ' + sg.tag + ' crosses "' + t.t + '"');
    });
    var c = t.el.closest('.q-inner,.q-opt,.wager-card,.reveal-card');
    if (c) { var cr = c.getBoundingClientRect(); if (t.r.bottom > cr.bottom + 1 || t.r.top < cr.top - 1) out.push('OVERFLOW "' + t.t + '" outside ' + c.className); }
  });
  return out.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 30);
};
