/*
 * 시험패스 PoC: 화면 공용 도구 (DOM 헬퍼, 토스트, 대화상자, 테마, QR 그리기, 가상 사진)
 */
(function (g) {
  'use strict';
  var SP = (g.SP = g.SP || {});
  var doc = g.document;
  var ui = (SP.ui = {});

  ui.$ = function (sel, root) { return (root || doc).querySelector(sel); };
  ui.$$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  // 사용자 입력은 항상 textContent 로만 넣는다.
  ui.el = function (tag, attrs, children) {
    var n = doc.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) n.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  };
  ui.icon = function (id) {
    var s = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'icon');
    s.setAttribute('aria-hidden', 'true');
    var u = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#i-' + id);
    s.appendChild(u);
    return s;
  };
  ui.clear = function (n) { while (n.firstChild) n.removeChild(n.firstChild); };
  ui.reducedMotion = function () { return g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches; };

  /* ---------- 토스트 ---------- */
  var toastTimer = 0;
  ui.toast = function (text) {
    var t = ui.$('#toast');
    t.textContent = text;
    t.hidden = false;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); t.hidden = true; }, 2600);
  };

  /* ---------- 확인 대화상자 ---------- */
  ui.confirm = function (title, text, okLabel) {
    return new Promise(function (resolve) {
      var d = ui.$('#dlg');
      ui.$('#dlgTitle').textContent = title;
      ui.$('#dlgText').textContent = text;
      ui.$('#dlgOk').textContent = okLabel || '확인';
      function done() { d.removeEventListener('close', done); resolve(d.returnValue === 'ok'); }
      d.addEventListener('close', done);
      d.returnValue = 'cancel';
      if (typeof d.showModal === 'function') d.showModal();
      else resolve(g.confirm(title + '\n' + text));
    });
  };

  /* ---------- 테마 (라이트/다크) ---------- */
  ui.initTheme = function () {
    var root = doc.documentElement, btn = ui.$('#theme-toggle');
    function current() {
      var t = root.getAttribute('data-theme');
      if (t) return t;
      return g.matchMedia && g.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function paint() {
      var dark = current() === 'dark';
      btn.setAttribute('aria-label', dark ? '밝은 화면으로 바꾸기' : '어두운 화면으로 바꾸기');
      btn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
      var m = ui.$('meta[name="theme-color"]');
      if (m) m.setAttribute('content', dark ? '#162130' : '#ffffff');
    }
    try { var saved = g.localStorage.getItem('sp-theme'); if (saved) root.setAttribute('data-theme', saved); } catch (e) { /* 저장소 사용 불가 */ }
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { g.localStorage.setItem('sp-theme', next); } catch (e) { /* 무시 */ }
      paint();
    });
    if (g.matchMedia) g.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
    paint();
  };

  /* ---------- QR 그리기 (진짜 QR, qrcode-generator) ---------- */
  ui.qrMatrix = function (text) {
    var qr = g.qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    var n = qr.getModuleCount(), rows = [];
    for (var r = 0; r < n; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(qr.isDark(r, c));
      rows.push(row);
    }
    return rows;
  };
  var SVGNS = 'http://www.w3.org/2000/svg';
  ui.qrSVG = function (text, quiet) {
    var m = ui.qrMatrix(text), n = m.length, q = quiet == null ? 4 : quiet, d = '';
    for (var r = 0; r < n; r++) {
      var c = 0;
      while (c < n) {
        if (m[r][c]) {
          var s = c;
          while (c < n && m[r][c]) c++;
          d += 'M' + (s + q) + ' ' + (r + q) + 'h' + (c - s) + 'v1h-' + (c - s) + 'z';
        } else c++;
      }
    }
    var svg = doc.createElementNS(SVGNS, 'svg');
    var size = n + q * 2;
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'qr-svg');
    var bg = doc.createElementNS(SVGNS, 'rect');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#ffffff');
    var p = doc.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', '#000000');
    svg.appendChild(bg); svg.appendChild(p);
    svg.dataset.modules = String(n);
    return svg;
  };
  ui.qrPNG = function (text, scale) {
    var m = ui.qrMatrix(text), n = m.length, q = 4, k = scale || 10;
    var cv = doc.createElement('canvas');
    cv.width = cv.height = (n + q * 2) * k;
    var cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#000';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) cx.fillRect((c + q) * k, (r + q) * k, k, k);
    return new Promise(function (resolve) { cv.toBlob(resolve, 'image/png'); });
  };

  /* ---------- 가상 증명사진 (일러스트, 실존 인물과 무관) ---------- */
  var AVATARS = [
    { bg: '#cfe0f7', skin: '#f1c9a5', hair: '#2b2118', cloth: '#35527d', style: 'short' },
    { bg: '#dcebe0', skin: '#e3b48f', hair: '#4a2f1c', cloth: '#41685a', style: 'long' },
    { bg: '#ece3f3', skin: '#f6d3b8', hair: '#1c1c22', cloth: '#5a4a7c', style: 'bun' }
  ];
  function avatarSVG(a) {
    var hair;
    if (a.style === 'short') hair = '<path d="M63 74c0-20 12-30 27-30s27 10 27 30c-6-9-14-13-27-13s-21 4-27 13z" fill="' + a.hair + '"/>';
    else if (a.style === 'long') hair = '<path d="M60 78c0-24 12-36 30-36s30 12 30 36v36c-6 3-10 0-10-6V84H70v24c0 6-4 9-10 6z" fill="' + a.hair + '"/>';
    else hair = '<circle cx="90" cy="40" r="11" fill="' + a.hair + '"/><path d="M63 76c0-20 12-30 27-30s27 10 27 30c-6-9-14-13-27-13s-21 4-27 13z" fill="' + a.hair + '"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 225">' +
      '<rect width="180" height="225" fill="' + a.bg + '"/>' +
      (a.style === 'long' ? hair : '') +
      '<path d="M26 225c2-38 28-60 64-60s62 22 64 60z" fill="' + a.cloth + '"/>' +
      '<path d="M78 150h24v22c-4 5-20 5-24 0z" fill="' + a.skin + '"/>' +
      '<ellipse cx="90" cy="102" rx="29" ry="35" fill="' + a.skin + '"/>' +
      (a.style === 'long' ? '' : hair) +
      '<circle cx="79" cy="106" r="2.6" fill="#2a2a2a"/><circle cx="101" cy="106" r="2.6" fill="#2a2a2a"/>' +
      '<path d="M82 124c5 4 11 4 16 0" stroke="#9a5b4b" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  ui.AVATARS = AVATARS.map(avatarSVG);

  // 사용자가 올린 사진은 브라우저 안에서 줄여 JPEG data URL 로 만든다.
  ui.resizePhoto = async function (file) {
    var bmp = await g.createImageBitmap(file);
    var W = 240, H = 300, cv = doc.createElement('canvas');
    cv.width = W; cv.height = H;
    var cx = cv.getContext('2d');
    var s = Math.max(W / bmp.width, H / bmp.height);
    var w = bmp.width * s, h = bmp.height * s;
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H);
    cx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
    if (bmp.close) bmp.close();
    return cv.toDataURL('image/jpeg', 0.85);
  };

  ui.fmtMs = function (ms) {
    if (ms == null || isNaN(ms)) return '-';
    if (ms < 1000) return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + '밀리초';
    var s = ms / 1000;
    return (s < 10 ? s.toFixed(2) : s.toFixed(1)) + '초';
  };
  ui.shortId = function (id) { return id.slice(0, 4) + '…' + id.slice(-4); };
  ui.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
})(typeof globalThis !== 'undefined' ? globalThis : self);
