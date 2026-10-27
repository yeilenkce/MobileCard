// 사용법: node tools/screenshots.cjs <출력폴더> [width=1100] [theme=light|dark] [URL]
// 기획서용 스크린샷 6장(+보조 2장)을 실제 동작하는 화면에서 찍는다. 개인정보 없는 일러스트 사진만 쓴다.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const out = path.resolve(process.argv[2] || 'screenshots');
const width = parseInt(process.argv[3] || '1100', 10);
const theme = process.argv[4] || 'light';
const base = process.argv[5] || 'file://' + path.resolve(__dirname, '../docs/index.html');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width, height: 900 }, deviceScaleFactor: width < 600 ? 2 : 1.5, locale: 'ko-KR',
    colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'no-preference'
  });
  const p = await ctx.newPage();
  const shot = async (name, sel, opts) => {
    await p.waitForTimeout(350); // 전환과 등장 효과가 끝난 뒤에 찍는다
    const loc = sel ? p.locator(sel).first() : null;
    const file = path.join(out, name + '.png');
    if (opts && opts.untilBottomOf) {
      const box = await p.evaluate(([top, bottom]) => {
        const a = document.querySelector(top).getBoundingClientRect(), b = document.querySelector(bottom).getBoundingClientRect();
        return { x: 0, y: Math.max(0, a.top + scrollY - 16), w: innerWidth, h: b.bottom - a.top + 32 };
      }, [opts.from, opts.untilBottomOf]);
      await p.screenshot({ path: file, fullPage: true, clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
    } else if (loc) await loc.screenshot({ path: file });
    else await p.screenshot({ path: file, fullPage: true });
    console.log('저장', path.relative(process.cwd(), file));
  };

  await p.goto(base + (base.includes('?') ? '&' : '?') + 'pace=slow');
  await p.waitForSelector('html[data-ready="1"]');
  if (theme === 'dark') await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

  // 1. 발급 화면 (PIN 입력 중)
  for (const d of '123') await p.click(`#keypad .key:text-is("${d}")`);
  await shot('01-issue', 'main');
  for (const d of '456') await p.click(`#keypad .key:text-is("${d}")`);
  await p.waitForSelector('.step[data-step="2"]:not([hidden])');
  // 2. 동의 화면
  await p.click('.check .box');
  await shot('02-consent', 'main');
  await p.click('#issueBtn');
  await p.waitForSelector('.step[data-step="3"]:not([hidden])');
  await shot('02b-issued', 'main');
  // 3. 수험표
  await p.click('#toTicket');
  await p.waitForSelector('#ticketBody:not([hidden])');
  await shot('03-ticket', 'main');
  // 4. 감독관 검증 중
  await p.click('#sendToSup');
  await p.waitForSelector('#supBody:not([hidden])');
  await p.click('#pasteGo');
  await p.waitForFunction(() => { const r = [...document.querySelectorAll('#steps .step-row')].map((x) => x.dataset.state); return r[1] === 'running'; });
  await shot('04-verifying', '#view-supervisor', { from: '#supStatus', untilBottomOf: '.sup-grid' });
  // 5. 검증 결과 (사진·이름 대조 단계)
  await p.waitForSelector('#decide:not([hidden])');
  await shot('05-result', '#view-supervisor', { from: '#supStatus', untilBottomOf: '.sup-grid' });
  await p.click('#btnPass');
  await p.waitForSelector('#after:not([hidden])');
  await shot('05b-passed', '#view-supervisor', { from: '#supStatus', untilBottomOf: '.sup-grid' });
  // 복제 QR 재스캔
  await p.click('#btnNext');
  await p.click('#seg-paste');
  await p.click('#pasteGo');
  await p.waitForSelector('#verdict:not([hidden])');
  await p.waitForFunction(() => document.querySelector('#verdict').dataset.kind === 'warn');
  await shot('05c-replay', '#view-supervisor', { from: '#supStatus', untilBottomOf: '.sup-grid' });
  // 6. 검증 테스트 5종
  await p.click('#runTests');
  await p.waitForSelector('.test-row');
  await shot('06-tests', 'section[aria-labelledby="testTitle"]');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
