// node tests/logic.test.cjs  (브라우저 없이 서명·검증·암호화 로직 점검, 메모리 저장소 사용)
const assert = require('node:assert/strict');
require('../docs/js/core.js');
require('../docs/js/store.js');
require('../docs/js/service.js');
const SP = globalThis.SP;

(async () => {
  await SP.db.init();
  assert.equal(SP.db.persistent(), false);
  const tomorrow = SP.time.addDays(SP.time.ymd(Date.now()), 1);

  // 1. 발급: QR에 개인정보가 없는지
  const pass = await SP.svc.issue({ examId: 'DEMO-A', examDate: tomorrow, identity: { name: '김시험', birth: '2001-03-14', photo: 'data:image/png;base64,AAAA' } });
  assert.ok(pass.qr.startsWith('SP1.'));
  assert.ok(!pass.qr.includes('김시험'));
  const raw = Buffer.from(SP.parseQR(pass.qr).payloadBytes).toString('latin1');
  assert.ok(!raw.includes('2001') && !raw.includes('data:image'));
  console.log('QR 길이', pass.qr.length, '자, 페이로드', SP.parseQR(pass.qr).payloadBytes.length, '바이트');

  // 2. 감독관: 시험 당일로 시계를 옮긴 뒤 검증
  SP.clock.setExamMorning(tomorrow);
  const pkg = await SP.svc.openPackage(SP.svc.pkgId('DEMO-A', tomorrow));
  let r = await SP.svc.verify(pass.qr, pkg);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  const idn = await SP.svc.lookupIdentity(pkg, r.payload.tokenId);
  assert.equal(idn.name, '김시험');
  await SP.svc.markPassed(pkg, r.payload);
  r = await SP.svc.verify(pass.qr, pkg);
  assert.equal(r.failedAt, 4);

  // 3. 실제 시각(전날)에는 시험일 불일치로 거절
  SP.clock.setReal();
  const pass2 = await SP.svc.issue({ examId: 'DEMO-A', examDate: tomorrow, identity: { name: 'x', birth: '2000-01-01', photo: '' } });
  r = await SP.svc.verify(pass2.qr, pkg);
  assert.equal(r.failedAt, 2);

  // 4. 패키지 키가 다르면 복호화 실패(AES-GCM 인증)
  const wrong = await SP.generatePackageKey();
  const entry = await SP.db.get('entries', pass2.tokenId);
  await assert.rejects(SP.openIdentity(wrong, pkg.meta.pkgId, pass2.tokenId, entry));
  // AAD 바인딩: 다른 토큰ID로는 복호화 안 됨
  await assert.rejects(SP.openIdentity(pkg.meta.key, pkg.meta.pkgId, pass.tokenId, entry));

  // 5. 형식 오류/쓰레기 입력
  SP.clock.setExamMorning(tomorrow);
  for (const junk of ['', 'hello', 'SP1.abc.def', 'SP1.' + 'A'.repeat(40) + '.' + 'B'.repeat(86)]) {
    const rr = await SP.svc.verify(junk, pkg);
    assert.equal(rr.ok, false); assert.equal(rr.failedAt, 1);
  }
  // 줄바꿈이 섞인 붙여넣기도 허용
  const rr2 = await SP.svc.verify(pass2.qr.replace(/(.{40})/g, '$1\n'), pkg);
  assert.equal(rr2.ok, true);

  // 6. 자체 테스트 5종
  const tests = await SP.svc.selfTest();
  for (const t of tests) console.log(t.id, t.title, t.passed ? 'OK' : 'FAIL', '단계', t.result.failedAt, t.result.steps.map(s => s.status[0]).join(''));
  assert.ok(tests.every(t => t.passed));

  // 6b. 패키지 내보내기 -> 파기 -> 가져오기 -> 같은 QR 검증
  const ex = await SP.svc.exportPackage(pkg.meta.pkgId);
  assert.ok(!ex.json.includes('김시험') && !ex.json.includes(ex.code), '파일에 평문 이름과 해제 코드가 없어야 함');
  await SP.svc.wipePackages();
  await assert.rejects(SP.svc.importPackage(ex.json, SP.b64u.enc(new Uint8Array(32))), /맞지 않습니다/);
  const imp = await SP.svc.importPackage(ex.json, ex.code);
  assert.equal(imp.count, 2);
  const pkg2 = await SP.svc.openPackage(imp.pkgId);
  const rr3 = await SP.svc.verify(pass.qr, pkg2);
  assert.equal(rr3.ok, true, '가져온 패키지로 검증 가능');
  assert.equal((await SP.svc.lookupIdentity(pkg2, rr3.payload.tokenId)).name, '김시험');
  await assert.rejects(SP.svc.importPackage('{"x":1}', ex.code), /패키지 파일이 아닙니다/);

  // 7. 파기
  const w = await SP.svc.wipePackages();
  console.log('파기', JSON.stringify(w));
  assert.deepEqual(w.after, { packages: 0, entries: 0, used: 0, history: 0 });
  console.log('모든 로직 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
