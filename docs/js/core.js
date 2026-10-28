/*
 * 시험패스 PoC: 서명·검증 핵심 로직 (DOM과 저장소에 의존하지 않음)
 * - ECDSA P-256 / SHA-256 (WebCrypto)
 * - 개인정보 없는 QR 페이로드, 시험장 단위 AES-GCM 검증 패키지
 * 시연용 가상 데이터입니다. 실제 서비스가 아닙니다.
 */
(function (g) {
  'use strict';
  var SP = (g.SP = g.SP || {});
  var te = new TextEncoder();
  var td = new TextDecoder('utf-8', { fatal: true });
  var subtle = g.crypto.subtle;
  var perf = function () { return (g.performance || Date).now(); };

  /* ---------- base64url ---------- */
  SP.b64u = {
    enc: function (bytes) {
      var u = new Uint8Array(bytes), s = '';
      for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec: function (str) {
      if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('base64url 형식이 아닙니다');
      var s = str.replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      var bin = atob(s), out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  };

  /* ---------- 시각 (한국 표준시 고정) ---------- */
  var KST = 9 * 3600 * 1000;
  SP.time = {
    ymd: function (ms) { return new Date(ms + KST).toISOString().slice(0, 10); },
    hms: function (ms) { return new Date(ms + KST).toISOString().slice(11, 19); },
    hm: function (ms) { return new Date(ms + KST).toISOString().slice(11, 16); },
    stamp: function (ms) { return SP.time.ymd(ms) + ' ' + SP.time.hms(ms); },
    // 'YYYY-MM-DD' 의 KST h시 m분 -> epoch ms
    at: function (ymd, h, m) {
      var p = ymd.split('-').map(Number);
      return Date.UTC(p[0], p[1] - 1, p[2], h, m || 0, 0) - KST;
    },
    addDays: function (ymd, n) {
      var p = ymd.split('-').map(Number);
      return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
    }
  };

  /* ---------- 가상 시험 (실존 시험·기관과 무관) ---------- */
  SP.EXAMS = [
    { id: 'DEMO-A', letter: 'A', name: '가상 국가자격시험 A', place: '가상고등학교 본관', enter: '08:10', until: '18:00' },
    { id: 'DEMO-B', letter: 'B', name: '가상 어학능력시험 B', place: '가상대학교 3호관', enter: '09:20', until: '18:00' }
  ];
  SP.examById = function (id) {
    for (var i = 0; i < SP.EXAMS.length; i++) if (SP.EXAMS[i].id === id) return SP.EXAMS[i];
    return null;
  };

  /* ---------- QR 페이로드 (이진 직렬화) ----------
   * ver(1) | kid(4) | examIdLen(1) examId | examDate yyyymmdd(u32) | candLen(1) candNo |
   * tokenId(12) | issuedAt(u32 sec) | expiresAt(u32 sec)
   * kid 는 발급기관 공개키 SHA-256 의 앞 4바이트(키 ID)다. 서명 대상에 포함되며, 검증 키가 서로 다를 때
   * 원인을 알려 주는 용도로만 쓴다. 이름·생년월일·사진 등 개인정보는 들어가지 않는다.
   */
  SP.VERSION = 2;
  SP.PREFIX = 'SP1';

  function ymdToInt(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error('시험일 형식 오류');
    return parseInt(ymd.replace(/-/g, ''), 10);
  }
  function intToYmd(n) {
    var s = String(n);
    if (s.length !== 8) throw new Error('시험일 값 오류');
    return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }

  SP.encodePayload = function (p) {
    var exam = te.encode(p.examId), cand = te.encode(p.candNo);
    var tid = SP.b64u.dec(p.tokenId);
    if (exam.length < 1 || exam.length > 32 || cand.length < 1 || cand.length > 32) throw new Error('필드 길이 오류');
    if (tid.length !== 12) throw new Error('토큰ID는 12바이트여야 합니다');
    if (!/^[0-9a-f]{8}$/.test(p.kid || '')) throw new Error('키 ID 형식 오류');
    var buf = new Uint8Array(1 + 4 + 1 + exam.length + 4 + 1 + cand.length + 12 + 4 + 4);
    var dv = new DataView(buf.buffer), o = 0;
    buf[o++] = p.version;
    for (var k = 0; k < 4; k++) buf[o++] = parseInt(p.kid.substr(k * 2, 2), 16);
    buf[o++] = exam.length; buf.set(exam, o); o += exam.length;
    dv.setUint32(o, ymdToInt(p.examDate)); o += 4;
    buf[o++] = cand.length; buf.set(cand, o); o += cand.length;
    buf.set(tid, o); o += 12;
    dv.setUint32(o, p.issuedAt); o += 4;
    dv.setUint32(o, p.expiresAt);
    return buf;
  };

  SP.decodePayload = function (buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), o = 0;
    function need(n) { if (o + n > buf.length) throw new Error('페이로드가 짧습니다'); }
    need(6);
    var version = buf[o++];
    if (version !== SP.VERSION) throw new Error('지원하지 않는 버전 ' + version);
    var kid = '';
    for (var k = 0; k < 4; k++) { var bt = buf[o++]; kid += (bt < 16 ? '0' : '') + bt.toString(16); }
    var el = buf[o++]; need(el);
    var examId = td.decode(buf.subarray(o, o + el)); o += el;
    need(5);
    var examDate = intToYmd(dv.getUint32(o)); o += 4;
    var cl = buf[o++]; need(cl);
    var candNo = td.decode(buf.subarray(o, o + cl)); o += cl;
    need(20);
    var tokenId = SP.b64u.enc(buf.subarray(o, o + 12)); o += 12;
    var issuedAt = dv.getUint32(o); o += 4;
    var expiresAt = dv.getUint32(o); o += 4;
    if (o !== buf.length) throw new Error('페이로드 뒤에 불필요한 바이트가 있습니다');
    return { version: version, kid: kid, examId: examId, examDate: examDate, candNo: candNo, tokenId: tokenId, issuedAt: issuedAt, expiresAt: expiresAt };
  };

  /* ---------- QR 문자열: SP1.<payload>.<signature> ---------- */
  SP.packQR = function (payloadBytes, sig) {
    return SP.PREFIX + '.' + SP.b64u.enc(payloadBytes) + '.' + SP.b64u.enc(sig);
  };

  SP.parseQR = function (text) {
    var t = String(text || '').replace(/\s+/g, '');
    var m = /^SP1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(t);
    if (!m) { var e = new Error('시험패스 형식의 QR이 아닙니다'); e.code = 'FORMAT'; throw e; }
    var payloadBytes, sig;
    try { payloadBytes = SP.b64u.dec(m[1]); sig = SP.b64u.dec(m[2]); }
    catch (err) { err.code = 'FORMAT'; throw err; }
    if (sig.length !== 64) { var e2 = new Error('서명 길이가 올바르지 않습니다'); e2.code = 'FORMAT'; throw e2; }
    return { payloadBytes: payloadBytes, sig: sig };
  };

  /* ---------- 키 ---------- */
  var ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  var ECDSA_ALG = { name: 'ECDSA', hash: 'SHA-256' };

  SP.generateIssuerKey = async function () {
    var pair = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    var raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicRaw: raw };
  };
  SP.importPublic = function (raw) {
    return subtle.importKey('raw', raw, ECDSA, true, ['verify']);
  };
  SP.fingerprint = async function (raw) {
    var h = new Uint8Array(await subtle.digest('SHA-256', raw)), s = '';
    for (var i = 0; i < 6; i++) s += (h[i] < 16 ? '0' : '') + h[i].toString(16);
    return s.replace(/(.{4})/g, '$1 ').trim();
  };
  // 발급기관 공개키의 키 ID: SHA-256 의 앞 4바이트(16진수 8자)
  SP.keyId = async function (raw) {
    var h = new Uint8Array(await subtle.digest('SHA-256', raw)), s = '';
    for (var i = 0; i < 4; i++) s += (h[i] < 16 ? '0' : '') + h[i].toString(16);
    return s;
  };
  SP.fmtKid = function (kid) { return kid.replace(/(.{4})/, '$1 '); };
  SP.randomTokenId = function () {
    return SP.b64u.enc(g.crypto.getRandomValues(new Uint8Array(12)));
  };

  SP.sign = async function (privateKey, bytes) {
    return new Uint8Array(await subtle.sign(ECDSA_ALG, privateKey, bytes));
  };

  // 페이로드 객체를 서명해 QR 문자열을 만든다.
  SP.signToken = async function (privateKey, payload) {
    var bytes = SP.encodePayload(payload);
    var sig = await SP.sign(privateKey, bytes);
    return SP.packQR(bytes, sig);
  };

  // 서명은 그대로 두고 페이로드 한 필드만 바꾼다(변조 시나리오용).
  SP.tamper = function (qrText, mutate) {
    var parsed = SP.parseQR(qrText);
    var p = SP.decodePayload(parsed.payloadBytes);
    mutate(p);
    return SP.packQR(SP.encodePayload(p), parsed.sig);
  };

  /* ---------- 검증 패키지 (AES-GCM) ---------- */
  SP.generatePackageKey = function () {
    return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  };
  function aad(pkgId, tokenId) { return te.encode(pkgId + '|' + tokenId); }

  SP.sealIdentity = async function (key, pkgId, tokenId, identity) {
    var iv = g.crypto.getRandomValues(new Uint8Array(12));
    var ct = await subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(pkgId, tokenId) }, key, te.encode(JSON.stringify(identity)));
    return { iv: iv, ct: new Uint8Array(ct) };
  };
  SP.openIdentity = async function (key, pkgId, tokenId, entry) {
    var pt = await subtle.decrypt({ name: 'AES-GCM', iv: entry.iv, additionalData: aad(pkgId, tokenId) }, key, entry.ct);
    return JSON.parse(td.decode(pt));
  };

  /* ---------- 4단계 검증 ----------
   * ctx = { pub: CryptoKey, kid: 키 ID(선택), examId, examDate, now(): ms, isUsed(tokenId): Promise<record|null> }
   * 한 단계라도 실패하면 이후 단계는 'skip'. 서명이 맞기 전에는 페이로드를 신뢰하지 않으므로
   * result.payload 는 1단계를 통과했을 때만 채워진다.
   */
  var CLOCK_SKEW = 120; // 초

  SP.STEP_TITLES = ['전자서명', '시험·일자 일치', '유효시간', '미사용 여부'];

  SP.verify = async function (text, ctx) {
    var steps = SP.STEP_TITLES.map(function (t, i) { return { id: i + 1, title: t, status: 'pending', detail: '', ms: 0, code: '' }; });
    var res = { ok: false, steps: steps, failedAt: 0, payload: null, nowMs: ctx.now(), totalMs: 0 };
    var t0 = perf();
    var parsed = null, payload = null;

    var checks = [
      async function () {
        try { parsed = SP.parseQR(text); }
        catch (e) { return { ok: false, code: 'FORMAT', msg: e.message }; }
        var valid = false;
        try { valid = await subtle.verify(ECDSA_ALG, ctx.pub, parsed.sig, parsed.payloadBytes); }
        catch (e) { return { ok: false, code: 'SIG_ERROR', msg: '서명을 검증하지 못했습니다' }; }
        if (!valid) {
          // 서명이 맞지 않으면 페이로드를 신뢰할 수 없다. 키 ID 는 원인 안내에만 쓰고 판정에는 쓰지 않는다.
          var claimed = null;
          try { claimed = SP.decodePayload(parsed.payloadBytes).kid; } catch (e) { claimed = null; }
          if (claimed && ctx.kid && claimed !== ctx.kid) {
            res.foreignKid = claimed;
            return { ok: false, code: 'KEY_MISMATCH', msg: '다른 발급기관 키(키 ID ' + SP.fmtKid(claimed) + ')로 서명된 QR입니다. 이 단말의 패키지는 키 ID ' + SP.fmtKid(ctx.kid) + ' 를 씁니다. 다른 기기에서 발급한 QR이라면 그 기기의 시험장 패키지를 가져와야 합니다.' };
          }
          return { ok: false, code: 'SIG_INVALID', msg: '서명이 맞지 않습니다. 같은 발급기관 키로 서명했는데 내용이 바뀌었거나, 발급기관이 만든 QR이 아닙니다.' };
        }
        try { payload = SP.decodePayload(parsed.payloadBytes); }
        catch (e) { return { ok: false, code: 'PAYLOAD', msg: '서명은 맞지만 내용을 읽을 수 없습니다: ' + e.message }; }
        return { ok: true, code: 'OK', msg: '발급기관 공개키로 서명이 확인되었습니다.' };
      },
      async function () {
        var today = SP.time.ymd(ctx.now());
        var bad = [];
        if (payload.examId !== ctx.examId) bad.push('이 QR은 ' + payload.examId + ' 시험용이고, 이 단말은 ' + ctx.examId + ' 시험장입니다.');
        if (payload.examDate !== ctx.examDate) bad.push('QR의 시험일 ' + payload.examDate + '은 이 시험장의 시험일 ' + ctx.examDate + '과 다릅니다.');
        else if (payload.examDate !== today) bad.push('QR의 시험일 ' + payload.examDate + '은 오늘(' + today + ')이 아닙니다.');
        if (bad.length) return { ok: false, code: 'EXAM_MISMATCH', msg: bad.join(' ') };
        return { ok: true, code: 'OK', msg: payload.examId + ', ' + payload.examDate + ' 일치' };
      },
      async function () {
        var nowSec = Math.floor(ctx.now() / 1000);
        if (nowSec + CLOCK_SKEW < payload.issuedAt) return { ok: false, code: 'NOT_YET', msg: '발급 시각(' + SP.time.stamp(payload.issuedAt * 1000) + ')이 단말 시각보다 뒤입니다.' };
        if (nowSec > payload.expiresAt) return { ok: false, code: 'EXPIRED', msg: SP.time.stamp(payload.expiresAt * 1000) + '에 만료되었습니다.' };
        return { ok: true, code: 'OK', msg: SP.time.hm(payload.expiresAt * 1000) + '까지 유효' };
      },
      async function () {
        var used = await ctx.isUsed(payload.tokenId);
        if (used) return { ok: false, code: 'REPLAY', msg: SP.time.hms(used.usedAt) + '에 이 단말에서 이미 통과 처리된 토큰입니다. 복제된 QR일 수 있습니다.' };
        return { ok: true, code: 'OK', msg: '이 단말에서 처음 사용되는 토큰입니다.' };
      }
    ];

    for (var i = 0; i < checks.length; i++) {
      var a = perf(), r;
      try { r = await checks[i](); } catch (e) { r = { ok: false, code: 'ERROR', msg: '검증 중 오류: ' + e.message }; }
      steps[i].ms = perf() - a;
      steps[i].status = r.ok ? 'pass' : 'fail';
      steps[i].detail = r.msg;
      steps[i].code = r.code;
      if (!r.ok) {
        for (var j = i + 1; j < steps.length; j++) { steps[j].status = 'skip'; steps[j].detail = '앞 단계에서 중단되어 확인하지 않았습니다.'; }
        res.failedAt = i + 1;
        break;
      }
      if (i === 0) res.payload = payload;
    }
    if (!res.failedAt) res.ok = true;
    res.totalMs = perf() - t0;
    return res;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
