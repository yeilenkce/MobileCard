/*
 * 2. 수험표 (시험 당일): 종이 수험표에 인쇄된 QR, QR 안팎의 정보 구분
 */
(function (g) {
  'use strict';
  var SP = g.SP, ui = SP.ui, $ = ui.$;
  var view = (SP.ticket = {});
  var passes = [], current = null;

  var dateFmt = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full', timeZone: 'UTC' });
  function dateText(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    return dateFmt.format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  }

  function render(p) {
    current = p;
    var exam = SP.examById(p.examId);
    $('#tExam').textContent = exam.name;
    $('#tDate').textContent = dateText(p.examDate);
    $('#tEnter').textContent = exam.enter + '까지';
    $('#tPlace').textContent = exam.place;
    $('#tCand').textContent = p.candNo;
    var box = $('#qrBox');
    ui.clear(box);
    box.appendChild(ui.qrSVG(p.qr));

    // 위 QR 문자열을 실제로 해독한 값
    var parsed = SP.parseQR(p.qr), d = SP.decodePayload(parsed.payloadBytes);
    var rows = [
      ['버전', String(d.version)],
      ['발급기관 키ID', SP.fmtKid(d.kid)],
      ['시험ID', d.examId],
      ['시험일', d.examDate],
      ['수험번호', d.candNo],
      ['토큰ID', d.tokenId],
      ['발급시각', SP.time.stamp(d.issuedAt * 1000)],
      ['만료시각', SP.time.stamp(d.expiresAt * 1000)],
      ['전자서명', 'ECDSA P-256, ' + parsed.sig.length + '바이트']
    ];
    var dl = $('#inList');
    ui.clear(dl);
    rows.forEach(function (r) {
      dl.appendChild(ui.el('div', null, [ui.el('dt', { text: r[0] }), ui.el('dd', { class: r[0] === '토큰ID' || r[0] === '수험번호' ? 'mono' : '', text: r[1] })]));
    });
    $('#qrBox').setAttribute('aria-label', '수험표에 인쇄된 시험패스 QR, ' + p.qr.length + '자, 모듈 ' + $('#qrBox svg').dataset.modules + '칸');
  }

  // 이전 형식(버전)으로 발급한 시험패스는 지금 QR 형식과 달라 쓸 수 없으므로 목록에서 빼고 알려 준다.
  var stale = [];

  view.refresh = async function (preferId) {
    var all = await SP.svc.listPasses();
    passes = all.filter(function (p) { return SP.isCurrentQR(p.qr); });
    stale = all.filter(function (p) { return !SP.isCurrentQR(p.qr); });
    $('#ticketStale').hidden = !stale.length;
    if (stale.length) $('#ticketStaleText').textContent = '이전 버전에서 발급한 시험패스 ' + stale.length + '개는 QR 형식이 달라 더 이상 쓸 수 없어 목록에서 뺐습니다. 응시자 앱에서 새로 발급하세요.';
    var empty = !passes.length;
    $('#ticketEmpty').hidden = !empty;
    $('#ticketBody').hidden = empty;
    if (empty) return;
    var sel = $('#passSelect');
    ui.clear(sel);
    passes.forEach(function (p) {
      sel.appendChild(ui.el('option', { value: p.tokenId, text: p.candNo + ' ' + p.holder + ', ' + p.examDate }));
    });
    var pick = passes.filter(function (p) { return p.tokenId === (preferId || (current && current.tokenId)); })[0] || passes[0];
    sel.value = pick.tokenId;
    render(pick);
  };

  view.current = function () { return current; };

  async function copyText(text) {
    try { await g.navigator.clipboard.writeText(text); return true; }
    catch (e) {
      var ta = ui.el('textarea', { class: 'visually-hidden', 'aria-hidden': 'true' });
      ta.value = text; g.document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = g.document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  view.init = function () {
    $('#passSelect').addEventListener('change', function (e) {
      var p = passes.filter(function (x) { return x.tokenId === e.target.value; })[0];
      if (p) render(p);
    });
    $('#emptyGo').addEventListener('click', function () { SP.app.go('applicant'); });
    $('#staleClear').addEventListener('click', async function () {
      for (var i = 0; i < stale.length; i++) await SP.db.del('passes', stale[i].tokenId);
      await view.refresh();
    });
    $('#copyQR').addEventListener('click', async function () {
      if (!current) return;
      ui.toast((await copyText(current.qr)) ? 'QR 문자열을 복사했습니다' : '복사하지 못했습니다. 직접 선택해 주세요');
    });
    $('#savePNG').addEventListener('click', async function () {
      if (!current) return;
      var blob = await ui.qrPNG(current.qr, 10);
      var url = URL.createObjectURL(blob);
      var a = ui.el('a', { href: url, download: 'siheompass-' + current.candNo + '.png' });
      g.document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
    $('#printBtn').addEventListener('click', function () { g.print(); });
    $('#sendToSup').addEventListener('click', function () { if (current) SP.app.go('supervisor', { paste: current.qr }); });
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
