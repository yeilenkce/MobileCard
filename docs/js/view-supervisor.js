/*
 * 3. 감독관 단말 (오프라인): QR 입력, 4단계 검증, 사진 대조, 통과 처리, 측정, 테스트, 파기
 */
(function (g) {
  'use strict';
  var SP = g.SP, ui = SP.ui, $ = ui.$;
  var view = (SP.supervisor = {});
  var perf = function () { return g.performance.now(); };
  // 화면 녹화용: 주소 끝에 ?pace=slow 를 붙이면 단계 표시가 느려진다. 측정값(기기 검증 시간)에는 영향이 없다.
  var PACE = /[?&]pace=slow\b/.test(g.location.search) ? 480 : 110;

  var S = {
    pkg: null,
    input: 'camera',
    camera: null,
    run: null,
    busy: false,
    clockTimer: 0
  };

  /* ---------- 작은 도구 ---------- */
  function birthText(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    return m ? m[1] + '년 ' + parseInt(m[2], 10) + '월 ' + parseInt(m[3], 10) + '일생' : '';
  }
  function setMsg(node, text, kind) {
    node.textContent = text || '';
    node.hidden = !text;
    node.className = 'msg' + (kind ? ' msg-' + kind : '');
  }
  function netCount() {
    try { return g.performance.getEntriesByType('resource').length; } catch (e) { return 0; }
  }
  function metricOn() { return $('#metricOn').checked; }

  /* ---------- 상단 상태 ---------- */
  function paintClock() {
    var t = SP.clock.now();
    $('#clockState').textContent = SP.time.stamp(t) + (SP.clock.mode() === 'exam' ? ' (시연용 이동)' : '');
  }
  function paintNet(base) {
    var n = base == null ? 0 : netCount() - base;
    $('#netState').textContent = '검증 중 요청 ' + Math.max(0, n) + '건';
  }

  async function packageLabel(meta, entries) {
    var exam = SP.examById(meta.examId);
    var n = entries.filter(function (e) { return e.pkgId === meta.pkgId; }).length;
    return exam.name + ', ' + meta.examDate.slice(5) + ' (' + n + '명)';
  }

  view.refresh = async function () {
    var list = await SP.svc.listPackages();
    var empty = !list.length;
    $('#supEmpty').hidden = !empty;
    $('#supBody').hidden = empty;
    if (empty) {
      S.pkg = null;
      $('#pkgState').textContent = '없음';
      stopCamera();
      return;
    }
    var entries = await SP.db.all('entries');
    var sel = $('#pkgSelect'), keep = S.pkg && S.pkg.meta.pkgId;
    ui.clear(sel);
    for (var i = 0; i < list.length; i++) {
      sel.appendChild(ui.el('option', { value: list[i].pkgId, text: await packageLabel(list[i], entries) }));
    }
    var want = list.filter(function (p) { return p.pkgId === keep; })[0] || list[0];
    sel.value = want.pkgId;
    await selectPackage(want.pkgId, !keep || keep !== want.pkgId);
  };

  async function selectPackage(pkgId, resetClock) {
    S.pkg = await SP.svc.openPackage(pkgId);
    var meta = S.pkg.meta, exam = SP.examById(meta.examId);
    var entries = (await SP.db.all('entries')).filter(function (e) { return e.pkgId === pkgId; }).length;
    $('#pkgState').textContent = exam.name + ', ' + meta.examDate;
    $('#pkgHint').textContent = '발급기관 공개키 지문 ' + S.pkg.fingerprint + '. 암호화된 응시자 ' + entries + '명. 서명은 이 공개키로만 확인하고, 이름과 사진은 QR을 검증한 뒤에만 복호화합니다.';
    if (resetClock) {
      var today = SP.time.ymd(Date.now());
      if (meta.examDate !== today) { SP.clock.setExamMorning(meta.examDate); $('#clockMode').value = 'exam'; }
      else { SP.clock.setReal(); $('#clockMode').value = 'real'; }
    }
    paintClock();
    await paintHistory();
    await paintMetrics();
    resetRun();
  }

  /* ---------- 입력 방식 ---------- */
  function setInput(mode, focus) {
    S.input = mode;
    ['camera', 'image', 'paste'].forEach(function (m) {
      var b = $('#seg-' + m), on = m === mode;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('#in-' + m).hidden = !on;
      if (on && focus) b.focus();
    });
    if (mode !== 'camera') stopCamera();
    setMsg($('#inputMsg'), '');
  }

  // 카메라를 완전히 끈다(스트림 해제). 시작하는 중이면 취소한다.
  function stopCamera() {
    if (S.camera) S.camera.stop();
    $('#camStart').hidden = false;
    $('#camStart').disabled = false;
    $('#camStart').textContent = '스캔 시작';
    $('#camStop').hidden = true;
    $('#viewfinder').classList.remove('live', 'paused');
    $('#vfMsg').hidden = false;
    $('#vfMsg').textContent = '카메라가 꺼져 있습니다';
  }

  // QR 을 읽은 뒤에는 스캔만 멈추고 카메라는 켜 둔다. 다음 응시자는 곧바로 이어서 스캔한다.
  function pauseCamera() {
    $('#viewfinder').classList.add('paused');
    $('#vfMsg').hidden = false;
    $('#vfMsg').textContent = '스캔을 멈췄습니다. 결과를 처리하면 이어서 스캔합니다';
  }

  async function startCamera() {
    if (S.busy || !S.pkg || S.camStarting) return;
    resetRun(true);
    setMsg($('#inputMsg'), '');
    var video = $('#video');
    if (!S.camera) S.camera = SP.scanner.camera(video, { onFound: function (text) { onQR(text, 'camera', S.run ? S.run.t0 : perf()); } });
    S.run = { t0: perf(), input: 'camera' };
    S.camStarting = true;
    var startBtn = $('#camStart');
    startBtn.disabled = true;
    startBtn.textContent = '카메라 켜는 중…';
    $('#vfMsg').hidden = false;
    $('#vfMsg').textContent = '카메라를 켜는 중입니다. 처음에는 권한 허용이 필요합니다';
    try {
      var started = await S.camera.start();
      if (started) {
        $('#viewfinder').classList.remove('paused');
        $('#viewfinder').classList.add('live');
        $('#vfMsg').hidden = true;
        startBtn.hidden = true;
        $('#camStop').hidden = false;
      } else {
        S.run = null; // 시작하는 동안 끄거나 화면을 떠나 취소됨
      }
    } catch (e) {
      stopCamera();
      var why = e && e.name === 'NotAllowedError' ? '카메라 권한이 거부되었습니다. 브라우저 주소창의 권한 설정에서 허용하거나, 이미지·붙여넣기 방식을 쓰세요.'
        : e && e.name === 'NotFoundError' ? '사용할 수 있는 카메라가 없습니다. 이미지·붙여넣기 방식을 쓰세요.'
        : e && e.name === 'NotReadableError' ? '카메라를 다른 앱이 쓰고 있습니다. 그 앱을 닫고 다시 시도하세요.'
        : (e && e.message) || '카메라를 켜지 못했습니다.';
      setMsg($('#inputMsg'), why, 'bad');
      S.run = null;
    } finally {
      S.camStarting = false;
      startBtn.disabled = false;
      startBtn.textContent = '스캔 시작';
    }
  }

  async function fromImage(file) {
    if (!file || S.busy) return;
    resetRun(true);
    var t0 = perf();
    setMsg($('#inputMsg'), '이미지에서 QR을 찾는 중입니다', '');
    try {
      var text = await SP.scanner.decodeBlob(file);
      if (!text) { setMsg($('#inputMsg'), 'QR을 찾지 못했습니다. QR이 이미지 안에 크고 선명하게 들어 있는지 확인하세요.', 'bad'); return; }
      setMsg($('#inputMsg'), '');
      onQR(text, 'image', t0);
    } catch (e) { setMsg($('#inputMsg'), '이미지를 읽지 못했습니다.', 'bad'); }
  }

  function fromPaste() {
    var text = $('#pasteText').value;
    if (!text.trim()) { setMsg($('#inputMsg'), '검증할 QR 문자열을 붙여넣으세요.', 'bad'); return; }
    resetRun(true);
    setMsg($('#inputMsg'), '');
    onQR(text, 'paste', perf());
  }

  /* ---------- 검증 흐름 ---------- */
  function resetRun(keepInput) {
    S.run = keepInput ? S.run : null;
    $('#resultIdle').hidden = false;
    $('#resultLive').hidden = true;
    $('#verdict').hidden = true;
    $('#identity').hidden = true;
    $('#decide').hidden = true;
    $('#after').hidden = true;
    $('#btnToTransfer').hidden = true;
    ui.clear($('#steps'));
    $('#resultIdle').classList.remove('hush');
    paintNet(null);
  }

  var ICON = { pass: 'check', fail: 'x', skip: 'minus', pending: '', running: '' };

  function buildSteps() {
    var ol = $('#steps');
    ui.clear(ol);
    SP.STEP_TITLES.forEach(function (t, i) {
      ol.appendChild(ui.el('li', { class: 'step-row', 'data-state': 'pending', id: 'srow' + i }, [
        ui.el('span', { class: 's-ic' }),
        ui.el('div', { class: 's-main' }, [
          ui.el('p', { class: 's-t' }, [ui.el('span', { class: 's-n', text: String(i + 1) }), t]),
          ui.el('p', { class: 's-d', text: '' })
        ]),
        ui.el('span', { class: 's-ms', text: '' })
      ]));
    });
  }
  function paintRow(i, st) {
    var li = $('#srow' + i);
    li.setAttribute('data-state', st.status);
    var ic = $('.s-ic', li);
    ui.clear(ic);
    if (ICON[st.status]) ic.appendChild(ui.icon(ICON[st.status]));
    $('.s-d', li).textContent = st.status === 'running' ? '확인하는 중' : (st.detail || '');
    $('.s-ms', li).textContent = (st.status === 'pass' || st.status === 'fail') ? ui.fmtMs(st.ms) : '';
  }

  function verdict(kind, title, body) {
    var v = $('#verdict');
    v.hidden = false;
    v.setAttribute('data-kind', kind);
    ui.clear(v);
    v.appendChild(ui.icon(kind === 'ok' || kind === 'done' ? 'check' : kind === 'warn' ? 'alert' : 'x'));
    v.appendChild(ui.el('div', null, [ui.el('p', { class: 'v-t', text: title }), ui.el('p', { class: 'v-d', text: body })]));
  }

  async function onQR(text, input, t0) {
    if (S.busy || !S.pkg) return;
    S.busy = true;
    var netBase = netCount();
    var run = { t0: t0, input: input, netBase: netBase, tQR: perf(), decided: false };
    S.run = run;
    if (input === 'camera') pauseCamera(); else stopCamera();

    $('#resultIdle').hidden = true;
    $('#resultLive').hidden = false;
    $('#verdict').hidden = true;
    $('#identity').hidden = true;
    $('#decide').hidden = true;
    $('#after').hidden = true;
    buildSteps();

    // 기기 안에서 실제 검증. 아래 단계별 표시는 눈으로 따라가기 위한 연출일 뿐 시간 측정에 넣지 않는다.
    var res = await SP.svc.verify(text, S.pkg);
    run.tVerified = perf();
    run.deviceMs = res.totalMs;
    run.res = res;

    var gap = ui.reducedMotion() ? 0 : PACE;
    for (var i = 0; i < res.steps.length; i++) {
      var st = res.steps[i];
      if (st.status === 'skip') { paintRow(i, st); continue; }
      if (gap) { paintRow(i, { status: 'running', detail: '' }); await ui.sleep(gap); }
      paintRow(i, st);
    }

    if (!res.ok) {
      var step = res.steps[res.failedAt - 1];
      var replay = step.code === 'REPLAY', foreign = step.code === 'KEY_MISMATCH';
      if (foreign) verdict('warn', '다른 기기에서 발급한 QR입니다', '이 단말의 패키지와 발급기관 키가 달라 서명을 확인할 수 없습니다. 발급한 기기에서 시험장 패키지를 내보내 이 단말에 가져오면 검증할 수 있습니다.');
      else verdict(replay ? 'warn' : 'bad', replay ? '같은 QR을 다시 스캔했습니다' : '거절: ' + res.failedAt + '단계(' + step.title + ')에서 중단',
        replay ? '복제된 수험표일 수 있습니다. 입실시키지 말고 감독관 확인을 받으세요.' : '입실을 보류하고 감독관 확인을 받으세요. 이름과 사진은 표시하지 않습니다.');
      $('#btnToTransfer').hidden = !foreign;
      await SP.svc.addHistory(S.pkg, { result: 'reject', candNo: res.payload ? res.payload.candNo : '', tokenId: res.payload ? res.payload.tokenId : '', failedAt: res.failedAt, code: step.code });
      await paintHistory();
      paintNet(netBase);
      run.decided = true;
      $('#after').hidden = false;
      S.busy = false;
      return;
    }

    var idn = null;
    try { idn = await SP.svc.lookupIdentity(S.pkg, res.payload.tokenId); }
    catch (e) { idn = null; }
    if (!idn) {
      verdict('bad', '검증 패키지에서 이 토큰을 찾지 못했습니다', '서명은 맞지만 이 시험장 패키지에 등록되지 않은 토큰입니다. 입실을 보류하세요.');
      await SP.svc.addHistory(S.pkg, { result: 'reject', candNo: res.payload.candNo, tokenId: res.payload.tokenId, failedAt: 5, code: 'NO_ENTRY' });
      await paintHistory();
      paintNet(netBase);
      run.decided = true;
      $('#after').hidden = false;
      S.busy = false;
      return;
    }

    run.identity = idn;
    verdict('ok', '네 단계를 모두 통과했습니다', '아래 사진과 이름을 눈앞의 응시자와 직접 대조한 뒤 결정하세요.');
    var ph = $('#idnPhoto');
    ph.src = idn.photo || '';
    ph.alt = '응시자 사진';
    $('#idnName').textContent = idn.name;
    $('#idnSub').textContent = '수험번호 ' + res.payload.candNo + (idn.birth ? ', ' + birthText(idn.birth) : '');
    $('#identity').hidden = false;
    $('#decide').hidden = false;
    paintNet(netBase);
    $('#btnPass').focus({ preventScroll: true });
    S.busy = false;
  }

  async function decide(kind) {
    var run = S.run;
    if (!run || run.decided || !run.res || !run.res.ok) return;
    run.decided = true;
    var tDecided = perf();
    var total = tDecided - run.t0;
    $('#decide').hidden = true;
    var extra = { input: run.input, totalMs: Math.round(total), deviceMs: Math.round(run.deviceMs * 10) / 10 };
    if (kind === 'pass') {
      var rec = await SP.svc.markPassed(S.pkg, run.res.payload, extra);
      var body = SP.time.hms(rec.usedAt) + '에 통과 처리했습니다. 같은 QR은 이 단말에서 다시 쓸 수 없습니다.';
      if (metricOn()) body += ' 스캔 시작부터 통과 처리까지 ' + ui.fmtMs(total) + '.';
      verdict('done', '통과 처리됨', body);
    } else {
      await SP.svc.markHold(S.pkg, run.res.payload, extra);
      verdict('warn', '보류로 기록했습니다', '토큰은 사용 처리하지 않았습니다. 감독관 확인 뒤 다시 스캔할 수 있습니다.');
    }
    if (metricOn()) {
      await SP.svc.addMetric({
        pkgId: S.pkg.meta.pkgId, input: run.input, decision: kind,
        startToQrMs: Math.round(run.tQR - run.t0), deviceMs: Math.round(run.deviceMs * 10) / 10, totalMs: Math.round(total)
      });
      await paintMetrics();
    }
    await paintHistory();
    $('#after').hidden = false;
    $('#btnNext').focus({ preventScroll: true });
  }

  function next() {
    resetRun();
    if (S.input !== 'camera') return;
    if (S.camera && S.camera.alive()) {
      // 카메라가 켜져 있으므로 다시 켜지 않고 이어서 스캔한다.
      S.run = { t0: perf(), input: 'camera' };
      $('#viewfinder').classList.remove('paused');
      $('#vfMsg').hidden = true;
      S.camera.resume();
    } else startCamera();
  }

  /* ---------- 이력, 측정 ---------- */
  async function paintHistory() {
    var rows = S.pkg ? await SP.svc.history(S.pkg.meta.pkgId) : [];
    $('#histEmpty').hidden = rows.length > 0;
    $('#histTable').hidden = !rows.length;
    var body = $('#histBody');
    ui.clear(body);
    rows.slice(0, 12).forEach(function (r) {
      var label = r.result === 'pass' ? '통과' : r.result === 'hold' ? '보류' : (r.failedAt === 5 ? '거절, 패키지에 없음' : '거절, ' + r.failedAt + '단계');
      body.appendChild(ui.el('tr', null, [
        ui.el('td', { text: SP.time.hms(r.ts), class: 'mono' }),
        ui.el('td', { text: r.candNo || '확인 전', class: 'mono' }),
        ui.el('td', null, [ui.el('span', { class: 'chip chip-' + (r.result === 'pass' ? 'ok' : r.result === 'hold' ? 'warn' : 'bad'), text: label })])
      ]));
    });
  }

  async function paintMetrics() {
    var on = metricOn();
    $('#metricBody').hidden = !on;
    if (!on) return;
    var s = SP.svc.summarize(await SP.svc.metrics());
    $('#metricNone').hidden = s.passed > 0;
    var dl = $('#metricStats');
    dl.hidden = s.passed === 0;
    ui.clear(dl);
    if (!s.passed) return;
    [
      ['통과 건수', s.passed + '건'],
      ['총 소요 평균', ui.fmtMs(s.total.mean)],
      ['총 소요 중앙값', ui.fmtMs(s.total.median)],
      ['가장 빠름과 느림', ui.fmtMs(s.total.min) + ', ' + ui.fmtMs(s.total.max)],
      ['기기 검증 평균', ui.fmtMs(s.device.mean)]
    ].forEach(function (kv) { dl.appendChild(ui.el('div', null, [ui.el('dt', { text: kv[0] }), ui.el('dd', { text: kv[1] })])); });
  }

  async function exportCsv() {
    var rows = await SP.svc.metrics();
    var head = 'time_iso,pkg,input,decision,start_to_qr_ms,device_ms,total_ms';
    var lines = rows.map(function (r) { return [new Date(r.ts).toISOString(), r.pkgId, r.input, r.decision, r.startToQrMs, r.deviceMs, r.totalMs].join(','); });
    var blob = new Blob([head + '\n' + lines.join('\n') + '\n'], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = ui.el('a', { href: url, download: 'siheompass-metrics.csv' });
    g.document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- 자체 검증 테스트 ---------- */
  async function runTests() {
    var out = $('#testOut'), btn = $('#runTests');
    btn.disabled = true;
    ui.clear(out);
    out.appendChild(ui.el('p', { class: 'hint', text: '임시 키를 만들어 확인하는 중입니다' }));
    try {
      var results = await SP.svc.selfTest();
      ui.clear(out);
      var okCount = results.filter(function (r) { return r.passed; }).length;
      out.appendChild(ui.el('p', { class: 'test-sum ' + (okCount === results.length ? 'ok' : 'bad'), text: results.length + '건 중 ' + okCount + '건이 기대한 대로 동작했습니다.' }));
      var list = ui.el('ol', { class: 'test-list' });
      results.forEach(function (t) {
        var r = t.result;
        var expect = t.expectOk ? '4단계 모두 통과' : t.expectStep + '단계(' + SP.STEP_TITLES[t.expectStep - 1] + ')에서 거절';
        var actual = r.ok ? '4단계 모두 통과' : r.failedAt + '단계(' + SP.STEP_TITLES[r.failedAt - 1] + ')에서 거절';
        var dots = ui.el('span', { class: 'mini-steps', role: 'img', 'aria-label': r.steps.map(function (s, i) { return (i + 1) + '단계 ' + ({ pass: '통과', fail: '실패', skip: '건너뜀' })[s.status]; }).join(', ') },
          r.steps.map(function (s) { return ui.el('i', { 'data-s': s.status }, [s.status === 'pass' ? ui.icon('check') : s.status === 'fail' ? ui.icon('x') : ui.icon('minus')]); }));
        var failStep = r.ok ? null : r.steps[r.failedAt - 1];
        list.appendChild(ui.el('li', { class: 'test-row', 'data-ok': String(t.passed) }, [
          ui.el('span', { class: 't-no', text: String(t.id) }),
          ui.el('div', { class: 't-main' }, [
            ui.el('p', { class: 't-title', text: t.title }),
            ui.el('p', { class: 't-how', text: t.how }),
            failStep ? ui.el('p', { class: 't-why', text: failStep.detail }) : null,
            t.note ? ui.el('p', { class: 't-why', text: t.note }) : null
          ]),
          ui.el('div', { class: 't-side' }, [
            dots,
            ui.el('p', { class: 't-exp' }, ['기대: ' + expect]),
            ui.el('p', { class: 't-act' }, ['결과: ' + actual]),
            ui.el('span', { class: 'chip ' + (t.passed ? 'chip-ok' : 'chip-bad'), text: t.passed ? '기대와 일치' : '기대와 다름' })
          ])
        ]));
      });
      out.appendChild(list);
    } catch (e) {
      ui.clear(out);
      out.appendChild(ui.el('p', { class: 'msg msg-bad', text: '테스트를 실행하지 못했습니다: ' + e.message }));
    }
    btn.disabled = false;
  }

  /* ---------- 시험장 패키지 옮기기 ---------- */
  async function exportPkg() {
    if (!S.pkg) { setMsg($('#xferMsg'), '내보낼 시험장 패키지가 없습니다. 먼저 응시자 앱에서 시험패스를 발급하세요.', 'bad'); return; }
    try {
      var r = await SP.svc.exportPackage(S.pkg.meta.pkgId);
      var url = URL.createObjectURL(new Blob([r.json], { type: 'application/json' }));
      var a = ui.el('a', { href: url, download: 'siheompass-package-' + S.pkg.meta.examId + '-' + S.pkg.meta.examDate + '.json' });
      g.document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      $('#xferCode').value = r.code;
      $('#xferCodeBox').hidden = false;
      setMsg($('#xferMsg'), '응시자 ' + r.count + '명의 암호화된 항목을 저장했습니다. 해제 코드는 파일과 다른 경로로 전달하세요.', 'ok');
    } catch (e) { setMsg($('#xferMsg'), '내보내지 못했습니다: ' + e.message, 'bad'); }
  }

  async function importPkg() {
    var file = $('#xferFile').files[0], code = $('#xferIn').value;
    if (!file) { setMsg($('#xferMsg'), '패키지 파일을 선택하세요.', 'bad'); return; }
    if (!code.trim()) { setMsg($('#xferMsg'), '해제 코드를 입력하세요.', 'bad'); return; }
    try {
      var r = await SP.svc.importPackage(await file.text(), code);
      $('#xferFile').value = '';
      $('#xferIn').value = '';
      await view.refresh();
      setMsg($('#xferMsg'), '가져왔습니다. 응시자 ' + r.count + '명의 항목이 이 단말에 암호화된 채로 저장되었습니다.', 'ok');
    } catch (e) { setMsg($('#xferMsg'), '가져오지 못했습니다: ' + e.message, 'bad'); }
  }

  /* ---------- 시험 종료: 파기 ---------- */
  async function wipe() {
    var c = await SP.svc.counts();
    var ok = await ui.confirm('검증 패키지를 파기할까요?',
      '패키지 ' + c.packages + '건, 암호화된 응시자 정보 ' + c.entries + '건, 사용 기록 ' + c.used + '건, 검증 이력 ' + c.history + '건을 지웁니다. 되돌릴 수 없습니다.', '파기');
    if (!ok) return;
    stopCamera();
    var r = await SP.svc.wipePackages();
    view.lastWipe = r;
    var msg = '파기했습니다. 저장소를 다시 세어 확인한 결과: 패키지 ' + r.before.packages + '건에서 ' + r.after.packages +
      '건, 암호화된 응시자 정보 ' + r.before.entries + '건에서 ' + r.after.entries + '건, 사용 기록 ' + r.before.used + '건에서 ' + r.after.used +
      '건, 검증 이력 ' + r.before.history + '건에서 ' + r.after.history + '건.';
    await SP.app.refresh();
    var echo = $('#wipeEcho');
    echo.textContent = msg;
    echo.hidden = false;
  }

  /* ---------- 초기화 ---------- */
  view.prefill = function (text) {
    setInput('paste', false);
    $('#pasteText').value = text;
    $('#pasteText').focus({ preventScroll: true });
  };
  view.leave = function () { stopCamera(); clearInterval(S.clockTimer); };
  view.enter = function () {
    paintClock();
    clearInterval(S.clockTimer);
    S.clockTimer = setInterval(paintClock, 1000);
  };

  view.init = function () {
    ['camera', 'image', 'paste'].forEach(function (m, idx, arr) {
      $('#seg-' + m).addEventListener('click', function () { setInput(m, false); });
      $('#seg-' + m).addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); setInput(arr[(idx + d + arr.length) % arr.length], true); }
      });
    });
    $('#camStart').addEventListener('click', startCamera);
    g.document.addEventListener('visibilitychange', function () { if (g.document.hidden) { stopCamera(); S.run = null; } });
    $('#camStop').addEventListener('click', function () { stopCamera(); S.run = null; });
    $('#imgFile').addEventListener('change', function (e) { fromImage(e.target.files[0]); e.target.value = ''; });
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) fromImage(f); });
    g.document.addEventListener('paste', function (e) {
      if ($('#view-supervisor').hidden || !S.pkg) return;
      if (e.target && e.target.id === 'pasteText') return;
      var cd = e.clipboardData;
      if (!cd) return;
      var item = Array.prototype.filter.call(cd.items || [], function (i) { return i.type.indexOf('image/') === 0; })[0];
      if (item) { e.preventDefault(); setInput('image', false); fromImage(item.getAsFile()); return; }
      var t = cd.getData('text');
      if (t && /^\s*SP1\./.test(t)) { e.preventDefault(); setInput('paste', false); $('#pasteText').value = t; fromPaste(); }
    });
    $('#pasteGo').addEventListener('click', fromPaste);
    $('#pasteText').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) fromPaste(); });

    $('#pkgSelect').addEventListener('change', function (e) { selectPackage(e.target.value, true); });
    $('#clockMode').addEventListener('change', function (e) {
      if (!S.pkg) return;
      if (e.target.value === 'exam') SP.clock.setExamMorning(S.pkg.meta.examDate); else SP.clock.setReal();
      paintClock();
      resetRun();
    });
    $('#supEmptyGo').addEventListener('click', function () { SP.app.go('applicant'); });

    $('#btnPass').addEventListener('click', function () { decide('pass'); });
    $('#btnHold').addEventListener('click', function () { decide('hold'); });
    $('#btnNext').addEventListener('click', next);
    $('#btnToTransfer').addEventListener('click', function () {
      $('#transfer').scrollIntoView({ behavior: ui.reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      $('#xferFile').focus({ preventScroll: true });
    });

    try { $('#metricOn').checked = g.localStorage.getItem('sp-metric') === '1'; } catch (e) { /* 무시 */ }
    $('#metricOn').addEventListener('change', function (e) {
      try { g.localStorage.setItem('sp-metric', e.target.checked ? '1' : '0'); } catch (err) { /* 무시 */ }
      paintMetrics();
    });
    $('#metricCsv').addEventListener('click', exportCsv);
    $('#metricReset').addEventListener('click', async function () {
      if (await ui.confirm('측정 기록을 지울까요?', '지금까지 쌓인 소요시간 기록이 모두 사라집니다.', '지우기')) { await SP.svc.clearMetrics(); paintMetrics(); }
    });

    $('#xferExport').addEventListener('click', exportPkg);
    $('#xferImport').addEventListener('click', importPkg);
    $('#xferCode').addEventListener('focus', function (e) { e.target.select(); });

    $('#runTests').addEventListener('click', runTests);
    $('#wipeBtn').addEventListener('click', wipe);
    paintClock();
  };

  // 화면 밖 상태 확인용
  view.debug = function () { return { run: S.run, busy: S.busy, pkg: S.pkg && S.pkg.meta.pkgId }; };
})(typeof globalThis !== 'undefined' ? globalThis : self);
