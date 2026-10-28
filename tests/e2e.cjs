// 사용법: node tests/e2e.cjs [URL]   (기본값: docs/index.html 을 file:// 로 연다)
// 필요: Playwright + Chromium. 브라우저에서 실제 서명·검증·암호화·파기가 동작하는지 확인한다.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const URL = process.argv[2] || 'file://' + path.resolve(__dirname, '../docs/index.html');
let pass = 0;
const ok = (name) => { pass++; console.log('  통과  ' + name); };

async function issue(p, name) {
  await p.click('#tab-applicant');
  if (name) { await p.click('#idEdit summary'); await p.fill('#inName', name); await p.click('#idEdit summary'); }
  for (const d of '123456') await p.click(`#keypad .key:text-is("${d}")`);
  await p.waitForSelector('.step[data-step="2"]:not([hidden])');
  await p.click('.check .box');
  await p.click('#issueBtn');
  await p.waitForSelector('.step[data-step="3"]:not([hidden])');
  await p.click('#again');
}
async function qrOf(p) {
  await p.click('#tab-ticket');
  await p.waitForSelector('#ticketBody:not([hidden])');
  return p.evaluate(() => SP.ticket.current().qr);
}
async function qrPng(p, text) {
  const b64 = await p.evaluate(async (t) => {
    const blob = await SP.ui.qrPNG(t, 8);
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  }, text);
  return Buffer.from(b64, 'base64');
}
async function steps(p) {
  return p.$$eval('#steps .step-row', (rows) => rows.map((r) => r.dataset.state));
}
async function pasteVerify(p, qr) {
  await p.click('#seg-paste');
  await p.fill('#pasteText', qr);
  await p.click('#pasteGo');
  await p.waitForSelector('#verdict:not([hidden])');
}
async function nextRun(p) { if (await p.isVisible('#btnNext')) await p.click('#btnNext'); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  const reqs = [];
  p.on('request', (r) => reqs.push(r.url()));

  console.log('대상', URL);
  await p.goto(URL);
  await p.waitForSelector('html[data-ready="1"]');

  // 1. 발급과 수험표
  await issue(p, '검증용');
  const qr1 = await qrOf(p);
  assert.ok(qr1.startsWith('SP1.') && !qr1.includes('검증용'));
  assert.ok(await p.isVisible('#qrBox svg'));
  const inList = await p.textContent('#inList');
  assert.ok(inList.includes('DEMO-A') && inList.includes('A-0001'));
  ok('시험패스 발급, 수험표에 실제 QR 표시, QR 안 정보 해독');

  // 1b. 이전 버전(v1)에서 발급해 저장소에 남은 시험패스가 있어도 앱이 시작되어야 한다.
  await p.evaluate(async () => {
    const cur = SP.ticket.current();
    const parsed = SP.parseQR(cur.qr), bytes = new Uint8Array(parsed.payloadBytes);
    bytes[0] = 1;
    await SP.db.put('passes', { tokenId: 'STALEstaleSTALE1', qr: SP.packQR(bytes, parsed.sig), examId: cur.examId, examDate: cur.examDate,
      candNo: 'A-0000', issuedAt: cur.issuedAt - 5, expiresAt: cur.expiresAt, holder: '이전버전', pubFingerprint: cur.pubFingerprint });
  });
  await p.reload();
  await p.waitForSelector('html[data-ready="1"]');
  await p.click('#tab-ticket');
  await p.waitForSelector('#ticketStale:not([hidden])');
  assert.ok((await p.textContent('#ticketStaleText')).includes('1개'));
  assert.ok(await p.isVisible('#qrBox svg'), '남은 시험패스는 정상 표시');
  assert.ok(!(await p.textContent('#passSelect')).includes('이전버전'));
  await p.click('#staleClear');
  await p.waitForSelector('#ticketStale', { state: 'hidden' });
  assert.equal(await p.evaluate(() => SP.db.count('passes')), 1);
  ok('이전 버전 시험패스가 남아 있어도 앱이 시작되고, 목록에서 빼고 안내하며, 지우기로 정리됨');

  // 2. 감독관: 붙여넣기 검증. 브라우저를 오프라인으로 바꾸고, 이 시점부터 네트워크 요청을 센다.
  await ctx.setOffline(true);
  await p.click('#tab-supervisor');
  await p.waitForSelector('#supBody:not([hidden])');
  const mark = reqs.length;
  const t0 = Date.now();
  await pasteVerify(p, qr1);
  assert.deepEqual(await steps(p), ['pass', 'pass', 'pass', 'pass']);
  assert.equal((await p.textContent('#idnName')).trim(), '검증용');
  await p.click('#btnPass');
  await p.waitForSelector('#after:not([hidden])');
  const verifyReqs = reqs.slice(mark);
  assert.equal(verifyReqs.length, 0, '검증 중 네트워크 요청: ' + verifyReqs.join(', '));
  assert.ok((await p.textContent('#netState')).includes('0건'));
  ok('오프라인 상태에서 붙여넣기 검증 4단계 통과, 사진·이름 표시, 통과 처리 (검증 구간 네트워크 요청 0건, ' + (Date.now() - t0) + 'ms)');

  // 3. 같은 QR 재스캔 -> 4단계 거절
  await nextRun(p);
  await pasteVerify(p, qr1);
  assert.deepEqual(await steps(p), ['pass', 'pass', 'pass', 'fail']);
  assert.ok(!(await p.isVisible('#identity')), '거절 시 신원이 보이면 안 됨');
  assert.ok((await p.textContent('#verdict')).includes('다시 스캔'));
  ok('복제 QR 재스캔은 4단계에서 거절, 이름·사진 비공개');

  // 4. 이미지 업로드 (새 패스)
  await issue(p, '이미지');
  const qr2 = await qrOf(p);
  await p.click('#tab-supervisor');
  await nextRun(p);
  await p.click('#seg-image');
  await p.setInputFiles('#imgFile', { name: 'qr.png', mimeType: 'image/png', buffer: await qrPng(p, qr2) });
  await p.waitForSelector('#decide:not([hidden])');
  assert.equal((await p.textContent('#idnName')).trim(), '이미지');
  ok('QR 이미지 업로드로 인식·검증');

  // 5. 보류는 토큰을 소모하지 않음
  await p.click('#btnHold');
  await p.waitForSelector('#after:not([hidden])');
  await nextRun(p);
  await pasteVerify(p, qr2);
  assert.deepEqual(await steps(p), ['pass', 'pass', 'pass', 'pass']);
  ok('보류 처리한 토큰은 사용 처리되지 않아 다시 검증 가능');
  await p.click('#btnPass');
  await p.waitForSelector('#after:not([hidden])');

  // 6. 변조·형식 오류
  await nextRun(p);
  const bad = qr1.slice(0, -3) + (qr1.endsWith('AAA') ? 'BBB' : 'AAA');
  await pasteVerify(p, bad);
  assert.equal((await steps(p))[0], 'fail');
  await nextRun(p);
  await pasteVerify(p, 'https://example.com');
  assert.equal((await steps(p))[0], 'fail');
  ok('변조된 서명, 관계없는 QR 내용은 1단계에서 거절');

  // 6b. 다른 기기(새 브라우저 프로필)로 패키지 옮기기
  await ctx.setOffline(false);
  await issue(p, '옮김');
  const qr4 = await qrOf(p);
  await p.click('#tab-supervisor');
  await p.waitForSelector('#supBody:not([hidden])');
  const [dlPkg] = await Promise.all([p.waitForEvent('download'), p.click('#xferExport')]);
  const pkgFile = await dlPkg.path();
  const code = await p.inputValue('#xferCode');
  assert.ok(code.length === 43);
  const pkgText = fs.readFileSync(pkgFile, 'utf8');
  assert.ok(!pkgText.includes('옮김') && !pkgText.includes('이미지') && !pkgText.includes(code), '파일에는 평문 이름과 해제 코드가 없어야 함');
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const b = await ctxB.newPage();
  const errsB = [];
  b.on('pageerror', (e) => errsB.push(e.message));
  await b.goto(URL + '#supervisor');
  await b.waitForSelector('html[data-ready="1"]');
  assert.ok(await b.isVisible('#supEmpty'));
  // 다른 기기에서 자기 키로 패키지를 만들어 둔 상태에서 첫 기기의 QR을 검증하면, 변조가 아니라 키 불일치로 안내한다.
  await issue(b, 'B측');
  await b.click('#tab-supervisor');
  await b.waitForSelector('#supBody:not([hidden])');
  await pasteVerify(b, qr4);
  assert.deepEqual(await steps(b), ['fail', 'skip', 'skip', 'skip']);
  assert.ok((await b.textContent('#steps')).includes('다른 발급기관 키'));
  assert.ok(!(await b.textContent('#steps')).includes('내용이 바뀌었'));
  assert.ok(await b.isVisible('#btnToTransfer'));
  await b.click('#btnNext');
  await b.setInputFiles('#xferFile', pkgFile);
  await b.fill('#xferIn', 'x'.repeat(43));
  await b.click('#xferImport');
  await b.waitForFunction(() => document.querySelector('#xferMsg').textContent.includes('맞지 않습니다'));
  await b.fill('#xferIn', code);
  await b.click('#xferImport');
  await b.waitForSelector('#supBody:not([hidden])');
  await pasteVerify(b, qr4);
  assert.deepEqual(await steps(b), ['pass', 'pass', 'pass', 'pass']);
  assert.equal((await b.textContent('#idnName')).trim(), '옮김');
  await b.click('#btnPass');
  await b.waitForSelector('#after:not([hidden])');
  // 한계 확인: 이미 첫 기기에서 통과 처리된 QR(qr1)도 두 번째 기기는 모른다. 단말 간 사용 기록은 공유되지 않는다.
  await b.click('#btnNext');
  await pasteVerify(b, qr1);
  assert.deepEqual(await steps(b), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(errsB, []);
  await ctxB.close();
  ok('다른 기기 QR은 키 불일치로 안내, 패키지 옮기기: 틀린 해제 코드 거절, 올바른 코드로 가져온 뒤 검증 통과 (알려진 한계: 단말 간 사용 기록은 공유되지 않음)');

  // 6c. 화면 폭별 가로 넘침 확인
  for (const w of [320, 360, 400, 768, 1920]) {
    await p.setViewportSize({ width: w, height: 900 });
    for (const tab of ['applicant', 'ticket', 'supervisor']) {
      await p.click('#tab-' + tab);
      await p.waitForTimeout(60);
      const over = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      assert.ok(over.sw <= over.iw + 1, w + 'px ' + tab + ' 가로 스크롤 발생 ' + over.sw);
    }
  }
  await p.setViewportSize({ width: 1100, height: 900 });
  ok('320, 360, 400, 768, 1920px 폭에서 세 화면 모두 가로 스크롤 없음');

  // 7. 검증 테스트 5종
  await p.click('#runTests');
  await p.waitForSelector('.test-row');
  const rows = await p.$$eval('.test-row', (r) => r.map((x) => x.dataset.ok));
  assert.deepEqual(rows, ['true', 'true', 'true', 'true', 'true']);
  ok('검증 테스트 5종이 모두 기대한 대로 동작');

  // 8. 측정 모드
  await p.check('#metricOn', { force: true }).catch(() => p.click('.switch .track'));
  await issue(p, '측정');
  const qr3 = await qrOf(p);
  await p.click('#tab-supervisor');
  await nextRun(p);
  await pasteVerify(p, qr3);
  await p.click('#btnPass');
  await p.waitForSelector('#metricStats:not([hidden])');
  const stats = await p.textContent('#metricStats');
  assert.ok(stats.includes('통과 건수') && stats.includes('1건'));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#metricCsv')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.equal(csv.trim().split('\n').length, 2);
  ok('측정 모드: 통과 1건 기록, 통계와 CSV 출력');

  // 9. 파기
  const before = await p.evaluate(() => SP.svc.counts());
  assert.ok(before.packages >= 1 && before.entries >= 4 && before.used >= 2);
  await p.click('#nextRunPlaceholder').catch(() => {});
  await p.click('#wipeBtn');
  await p.click('#dlgOk');
  await p.waitForSelector('#wipeEcho:not([hidden])');
  const after = await p.evaluate(() => SP.svc.counts());
  assert.deepEqual(after, { packages: 0, entries: 0, used: 0, history: 0 });
  const metricsLeft = await p.evaluate(() => SP.db.count('metrics'));
  assert.equal(metricsLeft, 1);
  assert.ok((await p.textContent('#wipeEcho')).includes('0건'));
  // 파기 후 같은 QR은 검증 불가 (패키지 없음)
  assert.ok(await p.isVisible('#supEmpty'));
  ok('시험 종료 파기: 패키지·암호화 항목·사용 기록·이력이 저장소에서 실제로 0건 (측정 기록만 보존)');

  assert.deepEqual(errs, [], '콘솔 오류: ' + errs.join('\n'));
  ok('콘솔 오류 없음');

  await browser.close();
  console.log('E2E ' + pass + '개 항목 통과');
})().catch((e) => { console.error('E2E 실패:', e); process.exit(1); });
