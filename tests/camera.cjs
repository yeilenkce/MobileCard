// 사용법: node tests/camera.cjs [URL]   (필요: Playwright, ffmpeg)
// Chromium 가짜 카메라 장치에 QR 영상을 흘려 보내 getUserMedia 와 jsQR 스캔 경로를 실제로 통과시킨다.
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const URL = process.argv[2] || 'file://' + path.resolve(__dirname, '../docs/index.html');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cam-'));
const profile = path.join(dir, 'profile');

(async () => {
  // 1) 같은 프로필로 발급만 하고 QR 이미지를 저장한다.
  let ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1100, height: 900 } });
  let p = ctx.pages()[0] || await ctx.newPage();
  await p.goto(URL); await p.waitForSelector('html[data-ready="1"]');
  for (const d of '123456') await p.click(`#keypad .key:text-is("${d}")`);
  await p.waitForSelector('.step[data-step="2"]:not([hidden])');
  await p.click('.check .box'); await p.click('#issueBtn');
  await p.waitForSelector('.step[data-step="3"]:not([hidden])');
  await p.click('#toTicket'); await p.waitForSelector('#ticketBody:not([hidden])');
  const b64 = await p.evaluate(async () => {
    const blob = await SP.ui.qrPNG(SP.ticket.current().qr, 8);
    return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
  });
  fs.writeFileSync(path.join(dir, 'qr.png'), Buffer.from(b64, 'base64'));
  await ctx.close();

  // 2) QR 이미지를 3초짜리 가짜 카메라 영상(y4m)으로 바꾼다.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(dir, 'qr.png'), '-t', '3', '-r', '10',
    '-vf', 'scale=480:480,pad=640:480:80:0:white,format=yuv420p', path.join(dir, 'cam.y4m')]);

  // 3) 가짜 카메라가 켜진 브라우저로 감독관 화면에서 스캔한다.
  ctx = await chromium.launchPersistentContext(profile, {
    viewport: { width: 1100, height: 900 }, permissions: ['camera'],
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=' + path.join(dir, 'cam.y4m')]
  });
  p = ctx.pages()[0] || await ctx.newPage();
  await p.addInitScript(() => {
    window.__gum = 0;
    const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
    md.getUserMedia = (...a) => { window.__gum++; return orig(...a); };
  });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(URL + '#supervisor'); await p.waitForSelector('html[data-ready="1"]'); await p.waitForSelector('#supBody:not([hidden])');
  // 시작과 끄기를 빠르게 번갈아 눌러도 오류가 없어야 한다(play() 가 중단되었다는 메시지 등).
  for (let i = 0; i < 8; i++) {
    if (await p.isVisible('#camStart') && await p.isEnabled('#camStart')) await p.click('#camStart');
    await p.waitForTimeout(20 + (i * 37) % 160);
    if (await p.isVisible('#camStop')) await p.click('#camStop');
  }
  await p.waitForTimeout(400);
  const msg = (await p.textContent('#inputMsg')) || '';
  assert.ok(!/play\(\)|interrupted/i.test(msg), '화면에 play() 오류가 보임: ' + msg);
  assert.deepEqual(errs, [], '연타 중 오류: ' + errs.join('\n'));
  await p.waitForFunction(() => !document.querySelector('#camStart').hidden || !document.querySelector('#camStop').hidden);
  if (await p.isVisible('#camStop')) await p.click('#camStop');
  await p.waitForSelector('#camStart:not([hidden])');
  console.log('카메라 시작·끄기 연타 8회: 오류 없음');

  await p.click('#camStart');
  const t0 = Date.now();
  await p.waitForSelector('#decide:not([hidden])', { timeout: 15000 });
  const ms = Date.now() - t0;
  assert.equal((await p.textContent('#idnName')).trim(), '김시험');
  assert.deepEqual(await p.$$eval('#steps .step-row', (r) => r.map((x) => x.dataset.state)), ['pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(errs, []);
  // 스캔 사이에는 카메라를 다시 켜지 않고 이어서 스캔한다.
  await p.click('#btnPass');
  await p.waitForSelector('#after:not([hidden])');
  const gumBefore = await p.evaluate(() => window.__gum);
  const t1 = Date.now();
  await p.click('#btnNext');
  await p.waitForSelector('#verdict:not([hidden])', { timeout: 5000 });
  const again = Date.now() - t1;
  assert.equal(await p.evaluate(() => window.__gum), gumBefore, '다음 스캔에서 getUserMedia 를 다시 부르면 안 됨');
  assert.ok(await p.evaluate(() => !!document.querySelector('#video').srcObject));
  console.log('다음 응시자 스캔: 카메라를 다시 켜지 않고 ' + again + 'ms 만에 다음 결과 (getUserMedia 추가 호출 0회)');
  console.log('카메라 스캔 통과: 카메라를 켠 뒤 QR 인식과 4단계 검증, 사진 표시까지 ' + ms + 'ms (가짜 카메라 장치, 이 PC 기준)');
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('카메라 테스트 실패:', e); process.exit(1); });
