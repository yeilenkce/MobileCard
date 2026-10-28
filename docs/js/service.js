/*
 * 시험패스 PoC: 발급, 시험장 패키지, 감독관 검증 흐름, 자체 검증 테스트 (DOM 없음)
 */
(function (g) {
  'use strict';
  var SP = (g.SP = g.SP || {});

  /* ---------- 단말 시계 (시연용으로 시험 당일로 옮길 수 있다) ---------- */
  var offset = 0, clockMode = 'real';
  SP.clock = {
    now: function () { return Date.now() + offset; },
    mode: function () { return clockMode; },
    offset: function () { return offset; },
    setReal: function () { offset = 0; clockMode = 'real'; },
    // 시험일 오전 9시로 옮긴다. 이후 시계는 그 시각부터 정상적으로 흐른다.
    setExamMorning: function (examDate) {
      offset = SP.time.at(examDate, 9, 0) - Date.now();
      clockMode = 'exam';
    }
  };

  var svc = (SP.svc = {});

  svc.pkgId = function (examId, examDate) { return examId + '|' + examDate; };

  /* ---------- 발급기관 키 (데모용, 이 브라우저에서 생성) ---------- */
  svc.getIssuer = async function () {
    var rec = await SP.db.get('kv', 'issuer');
    if (rec && rec.privateKey) return rec;
    var k = await SP.generateIssuerKey();
    rec = { k: 'issuer', privateKey: k.privateKey, publicKey: k.publicKey, publicRaw: k.publicRaw, createdAt: Date.now() };
    await SP.db.put('kv', rec);
    return rec;
  };

  /* ---------- 시험패스 발급 ----------
   * identity = { name, birth, photo }  (photo: data URL)
   * 1) 시험·일자 한정 일회용 토큰을 만들고 ECDSA 로 서명한다.
   * 2) QR에는 개인정보가 없다. 이름·생년월일·사진은 AES-GCM 검증 패키지에 암호화해 넣는다.
   */
  svc.issue = async function (opts) {
    var exam = SP.examById(opts.examId);
    if (!exam) throw new Error('알 수 없는 시험');
    var issuer = await svc.getIssuer();
    var pkgId = svc.pkgId(exam.id, opts.examDate);

    var pkg = await SP.db.get('packages', pkgId);
    if (!pkg) {
      pkg = {
        pkgId: pkgId, examId: exam.id, examDate: opts.examDate,
        issuerPub: issuer.publicRaw, key: await SP.generatePackageKey(),
        createdAt: Date.now(), seq: 0
      };
    }
    pkg.seq += 1;
    var candNo = exam.letter + '-' + String(pkg.seq).padStart(4, '0');

    var issuedAt = Math.floor(Date.now() / 1000);
    var expiresAt = Math.floor(SP.time.at(opts.examDate, parseInt(exam.until.slice(0, 2), 10), parseInt(exam.until.slice(3), 10)) / 1000);
    var payload = {
      version: SP.VERSION, kid: await SP.keyId(issuer.publicRaw), examId: exam.id, examDate: opts.examDate, candNo: candNo,
      tokenId: SP.randomTokenId(), issuedAt: issuedAt, expiresAt: expiresAt
    };
    var qr = await SP.signToken(issuer.privateKey, payload);

    var sealed = await SP.sealIdentity(pkg.key, pkgId, payload.tokenId, {
      name: opts.identity.name, birth: opts.identity.birth, photo: opts.identity.photo
    });
    await SP.db.put('entries', { tokenId: payload.tokenId, pkgId: pkgId, iv: sealed.iv, ct: sealed.ct });
    await SP.db.put('packages', pkg);

    var pass = {
      tokenId: payload.tokenId, qr: qr, examId: exam.id, examDate: opts.examDate, candNo: candNo,
      issuedAt: issuedAt, expiresAt: expiresAt, holder: opts.identity.name, pubFingerprint: await SP.fingerprint(issuer.publicRaw)
    };
    await SP.db.put('passes', pass);
    return pass;
  };

  svc.listPasses = async function () {
    var all = await SP.db.all('passes');
    return all.sort(function (a, b) { return b.issuedAt - a.issuedAt || (a.candNo < b.candNo ? 1 : -1); });
  };

  /* ---------- 감독관 단말: 시험장 패키지 ---------- */
  svc.listPackages = async function () {
    var all = await SP.db.all('packages');
    return all.sort(function (a, b) { return b.createdAt - a.createdAt; });
  };

  svc.openPackage = async function (pkgId) {
    var meta = await SP.db.get('packages', pkgId);
    if (!meta) return null;
    return { meta: meta, pub: await SP.importPublic(meta.issuerPub), kid: await SP.keyId(meta.issuerPub), fingerprint: await SP.fingerprint(meta.issuerPub) };
  };

  svc.ctxFor = function (pkg) {
    return {
      pub: pkg.pub, kid: pkg.kid, examId: pkg.meta.examId, examDate: pkg.meta.examDate,
      now: SP.clock.now,
      isUsed: function (tokenId) { return SP.db.get('used', tokenId); }
    };
  };

  svc.verify = function (qrText, pkg) { return SP.verify(qrText, svc.ctxFor(pkg)); };

  // 서명이 확인된 토큰에 대해서만 호출한다. 패키지에 없으면 null.
  svc.lookupIdentity = async function (pkg, tokenId) {
    var entry = await SP.db.get('entries', tokenId);
    if (!entry || entry.pkgId !== pkg.meta.pkgId) return null;
    return SP.openIdentity(pkg.meta.key, pkg.meta.pkgId, tokenId, entry);
  };

  svc.markPassed = async function (pkg, payload, extra) {
    var rec = { tokenId: payload.tokenId, pkgId: pkg.meta.pkgId, candNo: payload.candNo, usedAt: SP.clock.now() };
    await SP.db.put('used', rec);
    await svc.addHistory(pkg, { result: 'pass', candNo: payload.candNo, tokenId: payload.tokenId }, extra);
    return rec;
  };
  svc.markHold = function (pkg, payload, extra) {
    return svc.addHistory(pkg, { result: 'hold', candNo: payload.candNo, tokenId: payload.tokenId }, extra);
  };
  svc.addHistory = function (pkg, row, extra) {
    row.ts = SP.clock.now();
    row.pkgId = pkg.meta.pkgId;
    if (extra) Object.keys(extra).forEach(function (k) { row[k] = extra[k]; });
    return SP.db.put('history', row);
  };
  svc.history = async function (pkgId) {
    var all = await SP.db.all('history');
    return all.filter(function (r) { return r.pkgId === pkgId; }).sort(function (a, b) { return b.ts - a.ts; });
  };

  /* ---------- 시험장 패키지 옮기기 (기기 간 수동 전달) ----------
   * 파일에는 암호문과 발급기관 공개키만 들어간다. 복호화 키(해제 코드)는 파일과 따로 전달해야 한다.
   * 실제 서비스에서는 발급기관이 시험장 단말에 배포하는 구간이며, 이 PoC는 수동 전달만 구현한다.
   */
  svc.exportPackage = async function (pkgId) {
    var meta = await SP.db.get('packages', pkgId);
    if (!meta) throw new Error('패키지를 찾을 수 없습니다');
    var entries = (await SP.db.all('entries')).filter(function (e) { return e.pkgId === pkgId; });
    var raw = new Uint8Array(await g.crypto.subtle.exportKey('raw', meta.key));
    var file = {
      format: 'siheompass-package', v: 1, pkgId: pkgId, examId: meta.examId, examDate: meta.examDate,
      issuerPub: SP.b64u.enc(meta.issuerPub), createdAt: meta.createdAt,
      entries: entries.map(function (e) { return { tokenId: e.tokenId, iv: SP.b64u.enc(e.iv), ct: SP.b64u.enc(e.ct) }; })
    };
    return { json: JSON.stringify(file), code: SP.b64u.enc(raw), count: entries.length };
  };

  svc.importPackage = async function (jsonText, code) {
    var f;
    try { f = JSON.parse(jsonText); } catch (e) { throw new Error('패키지 파일을 읽을 수 없습니다'); }
    if (!f || f.format !== 'siheompass-package' || f.v !== 1 || !Array.isArray(f.entries)) throw new Error('시험패스 검증 패키지 파일이 아닙니다');
    if (!SP.examById(f.examId) || !/^\d{4}-\d{2}-\d{2}$/.test(f.examDate) || f.pkgId !== svc.pkgId(f.examId, f.examDate)) throw new Error('패키지 정보가 올바르지 않습니다');
    var keyBytes;
    try { keyBytes = SP.b64u.dec(String(code || '').trim()); } catch (e) { throw new Error('해제 코드 형식이 올바르지 않습니다'); }
    if (keyBytes.length !== 32) throw new Error('해제 코드 형식이 올바르지 않습니다');
    var pub = SP.b64u.dec(f.issuerPub);
    await SP.importPublic(pub); // 올바른 공개키인지 확인
    var key = await g.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    var entries = f.entries.map(function (e) { return { tokenId: e.tokenId, pkgId: f.pkgId, iv: SP.b64u.dec(e.iv), ct: SP.b64u.dec(e.ct) }; });
    if (entries.length) {
      try { await SP.openIdentity(key, f.pkgId, entries[0].tokenId, entries[0]); }
      catch (e) { throw new Error('해제 코드가 이 패키지와 맞지 않습니다'); }
    }
    // 같은 시험의 이전 항목은 이 키로 풀 수 없으므로 지우고 새로 받은 항목으로 바꾼다.
    var old = (await SP.db.all('entries')).filter(function (e) { return e.pkgId === f.pkgId; });
    for (var i = 0; i < old.length; i++) await SP.db.del('entries', old[i].tokenId);
    for (var j = 0; j < entries.length; j++) await SP.db.put('entries', entries[j]);
    var meta = { pkgId: f.pkgId, examId: f.examId, examDate: f.examDate, issuerPub: pub, key: key, createdAt: Date.now(), seq: entries.length, imported: true };
    await SP.db.put('packages', meta);
    return { pkgId: f.pkgId, count: entries.length };
  };

  /* ---------- 측정 모드 ---------- */
  svc.addMetric = function (row) { row.ts = Date.now(); return SP.db.put('metrics', row); };
  svc.metrics = function () { return SP.db.all('metrics'); };
  svc.clearMetrics = function () { return SP.db.clear('metrics'); };
  svc.summarize = function (rows) {
    function stats(arr) {
      if (!arr.length) return null;
      var s = arr.slice().sort(function (a, b) { return a - b; });
      var sum = s.reduce(function (a, b) { return a + b; }, 0);
      var mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
      return { n: s.length, mean: sum / s.length, median: mid, min: s[0], max: s[s.length - 1] };
    }
    var passed = rows.filter(function (r) { return r.decision === 'pass'; });
    return {
      n: rows.length,
      passed: passed.length,
      total: stats(passed.map(function (r) { return r.totalMs; })),
      device: stats(passed.map(function (r) { return r.deviceMs; }))
    };
  };

  /* ---------- 시험 종료: 검증 패키지 파기 ----------
   * 패키지(키 포함), 암호화 항목, 사용 기록, 검증 이력을 지우고 다시 세어 확인한다.
   * 측정 기록은 개인정보가 없어 남긴다.
   */
  svc.counts = async function () {
    return {
      packages: await SP.db.count('packages'),
      entries: await SP.db.count('entries'),
      used: await SP.db.count('used'),
      history: await SP.db.count('history')
    };
  };
  svc.wipePackages = async function () {
    var before = await svc.counts();
    await SP.db.clear('entries');
    await SP.db.clear('used');
    await SP.db.clear('history');
    await SP.db.clear('packages');
    var after = await svc.counts();
    return { before: before, after: after };
  };

  /* ---------- 자체 검증 테스트 5종 ----------
   * 임시 키쌍과 임시 사용 기록을 만들어 실제 SP.verify 로 돌린다.
   * 실제 패키지와 사용 기록에는 손대지 않는다.
   */
  svc.selfTest = async function () {
    var key = await SP.generateIssuerKey();
    var now = SP.clock.now();
    var examDate = SP.time.ymd(now);
    var used = new Map();
    var kid = await SP.keyId(key.publicRaw);
    var ctx = {
      pub: key.publicKey, kid: kid, examId: 'DEMO-A', examDate: examDate, now: function () { return now; },
      isUsed: async function (id) { return used.get(id) || null; }
    };
    function payload(over) {
      var p = {
        version: SP.VERSION, kid: kid, examId: 'DEMO-A', examDate: examDate, candNo: 'T-0001', tokenId: SP.randomTokenId(),
        issuedAt: Math.floor(now / 1000) - 3600, expiresAt: Math.floor(now / 1000) + 3600
      };
      Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
      return p;
    }
    var out = [];
    async function add(def, qr, note) {
      var res = await SP.verify(qr, ctx);
      var ok = def.expectOk ? res.ok : (!res.ok && res.failedAt === def.expectStep);
      out.push({ id: def.id, title: def.title, how: def.how, expectOk: def.expectOk, expectStep: def.expectStep, result: res, passed: ok, qr: qr, note: note || '' });
    }

    var good = await SP.signToken(key.privateKey, payload());
    await add({ id: 1, title: '정상 QR', how: '발급기관이 서명한 오늘 시험의 유효한 QR', expectOk: true }, good);

    var forged = SP.tamper(good, function (p) { p.expiresAt += 30 * 86400; });
    await add({ id: 2, title: '변조된 QR', how: '서명은 그대로 두고 만료시각만 30일 늘림', expectOk: false, expectStep: 1 }, forged);

    var other = await SP.signToken(key.privateKey, payload({ examId: 'DEMO-B' }));
    await add({ id: 3, title: '다른 시험의 QR', how: '서명은 유효하지만 DEMO-B 시험용', expectOk: false, expectStep: 2 }, other);

    var old = await SP.signToken(key.privateKey, payload({ expiresAt: Math.floor(now / 1000) - 60 }));
    await add({ id: 4, title: '만료된 QR', how: '서명은 유효하지만 1분 전에 만료됨', expectOk: false, expectStep: 3 }, old);

    var once = payload();
    var onceQR = await SP.signToken(key.privateKey, once);
    var first = await SP.verify(onceQR, ctx);
    used.set(once.tokenId, { tokenId: once.tokenId, usedAt: now });
    await add({ id: 5, title: '이미 사용된 QR', how: '한 번 통과 처리한 QR을 다시 스캔', expectOk: false, expectStep: 4 }, onceQR,
      first.ok ? '첫 번째 스캔은 4단계를 모두 통과했고, 통과 처리 후 두 번째 스캔에서 거절됨' : '첫 번째 스캔이 통과하지 못했습니다');
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
