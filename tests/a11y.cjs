// 사용법: npm install --no-save axe-core && node tests/a11y.cjs [URL]
// 세 화면의 주요 상태를 라이트와 다크에서 axe-core 로 검사한다. 위반이 하나라도 있으면 실패한다.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
let axePath;
try { axePath = require.resolve('axe-core/axe.min.js'); } catch (e) { console.error('axe-core 가 없습니다. 먼저 `npm install --no-save axe-core` 를 실행하세요.'); process.exit(2); }
const axeSrc = fs.readFileSync(axePath, 'utf8');
const URL = process.argv[2] || 'file://' + path.resolve(__dirname, '../docs/index.html');
let bad = 0;

async function check(p, label) {
  await p.evaluate(axeSrc);
  const v = await p.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, sample: x.nodes[0].target.join(' '), help: x.help })));
  if (v.length) { bad += v.length; console.log('  위반  ' + label + ': ' + JSON.stringify(v)); } else console.log('  통과  ' + label);
}

(async () => {
  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: scheme });
    const p = await ctx.newPage();
    await p.goto(URL); await p.waitForSelector('html[data-ready="1"]');
    await check(p, scheme + ' 응시자 1단계');
    for (const d of '123456') await p.click(`#keypad .key:text-is("${d}")`);
    await p.waitForSelector('.step[data-step="2"]:not([hidden])'); await check(p, scheme + ' 동의');
    await p.click('.check .box'); await p.click('#issueBtn');
    await p.waitForSelector('.step[data-step="3"]:not([hidden])'); await check(p, scheme + ' 발급 완료');
    await p.click('#toTicket'); await p.waitForSelector('#ticketBody:not([hidden])'); await check(p, scheme + ' 수험표');
    await p.click('#sendToSup'); await p.waitForSelector('#supBody:not([hidden])'); await check(p, scheme + ' 감독관 입력');
    await p.click('#pasteGo'); await p.waitForSelector('#decide:not([hidden])'); await check(p, scheme + ' 감독관 검증 결과');
    await p.click('#btnPass'); await p.waitForSelector('#after:not([hidden])');
    await p.click('#runTests'); await p.waitForSelector('.test-row'); await check(p, scheme + ' 검증 테스트 결과');
    await ctx.close();
  }
  await browser.close();
  if (bad) { console.error('접근성 위반 ' + bad + '건'); process.exit(1); }
  console.log('접근성 검사 통과');
})().catch((e) => { console.error(e); process.exit(1); });
