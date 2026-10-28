/*
 * 1. 응시자 앱 (시험 전날): 본인확인 연출, 제공 항목 동의, 시험패스 발급
 */
(function (g) {
  'use strict';
  var SP = g.SP, ui = SP.ui, $ = ui.$;
  var view = (SP.applicant = {});

  var state = {
    step: 1,
    pin: '',
    busy: false,
    identity: { name: '김시험', birth: '2001-03-14', photo: '', custom: false },
    last: null
  };

  function birthText(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? m[1] + '년 ' + parseInt(m[2], 10) + '월 ' + parseInt(m[3], 10) + '일생' : '생년월일 미입력';
  }

  function paintId() {
    var id = state.identity;
    $('#idName').textContent = id.name || '이름 미입력';
    $('#idBirth').textContent = birthText(id.birth);
    var img = $('#idPhoto');
    img.src = id.photo;
    img.alt = '가상 증명사진';
    $('#photoReset').hidden = !id.custom;
    ui.$$('#avatarPick input').forEach(function (r) { r.checked = !id.custom && ui.AVATARS[+r.value] === id.photo; });
  }

  function setStep(n) {
    state.step = n;
    ui.$$('.step').forEach(function (s) { s.hidden = +s.dataset.step !== n; });
    ui.$$('.stepper li').forEach(function (li) {
      var d = +li.dataset.dot;
      li.classList.toggle('done', d < n);
      li.classList.toggle('now', d === n);
      if (d === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    var h = $('.step[data-step="' + n + '"] h2');
    if (h) { h.setAttribute('tabindex', '-1'); if (state.stepFocus) h.focus({ preventScroll: false }); }
    state.stepFocus = true;
  }

  function dates() {
    var today = SP.time.ymd(Date.now());
    return [
      { v: SP.time.addDays(today, 1), t: '내일, ' + SP.time.addDays(today, 1) },
      { v: SP.time.addDays(today, 2), t: '모레, ' + SP.time.addDays(today, 2) }
    ];
  }

  function paintPin() {
    var dots = ui.$$('#pinDots i');
    dots.forEach(function (d, i) { d.classList.toggle('on', i < state.pin.length); });
    $('#pinDots').setAttribute('aria-label', '입력한 자리 ' + state.pin.length + '개');
  }

  async function pressDigit(d) {
    if (state.busy || state.pin.length >= 6) return;
    state.pin += d;
    paintPin();
    if (state.pin.length === 6) {
      state.busy = true;
      $('#pinLabel').textContent = '본인확인 중입니다';
      $('#pin').classList.add('checking');
      await ui.sleep(ui.reducedMotion() ? 0 : 450);
      state.busy = false;
      state.pin = '';
      paintPin();
      $('#pin').classList.remove('checking');
      $('#pinLabel').textContent = 'PIN 6자리를 입력하세요';
      enterConsent();
    }
  }
  function pressDelete() {
    if (state.busy) return;
    state.pin = state.pin.slice(0, -1);
    paintPin();
  }

  function enterConsent() {
    var exam = SP.examById($('#exam').value), date = $('#examDate').value;
    $('#cPurpose').textContent = exam.name + ' 입실 때 본인 확인 1회';
    $('#cValid').textContent = date + ' 하루, ' + exam.until + '까지';
    $('#agree').checked = false;
    $('#issueBtn').disabled = true;
    $('#issueError').hidden = true;
    setStep(2);
  }

  async function issue() {
    if (state.busy) return;
    state.busy = true;
    var btn = $('#issueBtn');
    btn.disabled = true;
    btn.textContent = '서명하는 중';
    $('#issueError').hidden = true;
    try {
      var id = state.identity;
      var pass = await SP.svc.issue({
        examId: $('#exam').value, examDate: $('#examDate').value,
        identity: { name: id.name.trim() || '이름 미입력', birth: id.birth, photo: id.photo }
      });
      state.last = pass;
      renderDone(pass);
      setStep(3);
      SP.app.refresh({ ticketId: pass.tokenId });
    } catch (e) {
      var m = $('#issueError');
      m.textContent = '발급하지 못했습니다: ' + e.message;
      m.hidden = false;
      btn.disabled = false;
    } finally {
      btn.textContent = '시험패스 발급';
      state.busy = false;
    }
  }

  function renderDone(p) {
    var exam = SP.examById(p.examId);
    $('#doneLead').textContent = '이 QR은 ' + exam.name + ', ' + p.examDate + ' 하루에만 쓸 수 있습니다. 수험표에 인쇄하세요.';
    var dl = $('#doneFacts');
    ui.clear(dl);
    [
      ['수험번호', p.candNo],
      ['토큰ID', p.tokenId],
      ['만료', SP.time.stamp(p.expiresAt * 1000)],
      ['서명', 'ECDSA P-256, SHA-256'],
      ['발급기관 공개키 지문', p.pubFingerprint],
      ['QR 길이', p.qr.length + '자, 개인정보 0항목']
    ].forEach(function (kv) {
      dl.appendChild(ui.el('div', null, [ui.el('dt', { text: kv[0] }), ui.el('dd', { class: kv[0] === '수험번호' || kv[0] === '토큰ID' || kv[0].indexOf('지문') > -1 ? 'mono' : '', text: kv[1] })]));
    });
  }

  view.init = function () {
    var exam = $('#exam'), date = $('#examDate');
    SP.EXAMS.forEach(function (e) { exam.appendChild(ui.el('option', { value: e.id, text: e.name })); });
    dates().forEach(function (d) { date.appendChild(ui.el('option', { value: d.v, text: d.t })); });

    // 가상 사진 고르기
    var pick = $('#avatarPick');
    ui.AVATARS.forEach(function (src, i) {
      var id = 'av' + i;
      var input = ui.el('input', { type: 'radio', name: 'avatar', id: id, value: String(i), class: 'visually-hidden' });
      var label = ui.el('label', { for: id, class: 'av' }, [ui.el('img', { src: src, width: '64', height: '80', alt: '일러스트 ' + (i + 1) })]);
      input.addEventListener('change', function () { state.identity.photo = src; state.identity.custom = false; paintId(); });
      pick.appendChild(input);
      pick.appendChild(label);
    });
    state.identity.photo = ui.AVATARS[0];

    $('#inName').value = state.identity.name;
    $('#inBirth').value = state.identity.birth;
    $('#inName').addEventListener('input', function (e) { state.identity.name = e.target.value; paintId(); });
    $('#inBirth').addEventListener('input', function (e) { state.identity.birth = e.target.value; paintId(); });
    $('#inPhoto').addEventListener('change', async function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        state.identity.photo = await ui.resizePhoto(f);
        state.identity.custom = true;
        paintId();
        ui.toast('사진을 이 브라우저 안에서만 사용합니다');
      } catch (err) { ui.toast('이미지를 읽지 못했습니다'); }
      e.target.value = '';
    });
    $('#photoReset').addEventListener('click', function () {
      state.identity.photo = ui.AVATARS[0]; state.identity.custom = false; paintId();
    });

    // PIN 키패드
    var pad = $('#keypad');
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].forEach(function (k) {
      if (k === '') { pad.appendChild(ui.el('span')); return; }
      var b = ui.el('button', { type: 'button', class: 'key' + (k === 'del' ? ' key-del' : ''), 'aria-label': k === 'del' ? '한 자리 지우기' : k });
      if (k === 'del') b.appendChild(ui.icon('delete')); else b.textContent = k;
      b.addEventListener('click', function () { if (k === 'del') pressDelete(); else pressDigit(k); });
      pad.appendChild(b);
    });
    g.document.addEventListener('keydown', function (e) {
      if (state.step !== 1 || $('#view-applicant').hidden) return;
      var t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) pressDigit(e.key);
      else if (e.key === 'Backspace') pressDelete();
    });

    $('#agree').addEventListener('change', function (e) { $('#issueBtn').disabled = !e.target.checked; });
    $('#issueBtn').addEventListener('click', issue);
    $('#backTo1').addEventListener('click', function () { setStep(1); });
    $('#toTicket').addEventListener('click', function () { SP.app.go('ticket', { tokenId: state.last && state.last.tokenId }); });
    $('#again').addEventListener('click', function () { setStep(1); });

    paintId();
    paintPin();
    state.stepFocus = false;
    setStep(1);
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
