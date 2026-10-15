// Captures the same scenes for before/after comparison (STABILIZE-001 P2).
import { chromium } from '@playwright/test';
const [base, out] = process.argv.slice(2);
const browser = await chromium.launch();
const result = {};
for (const [w, h] of [[320, 568], [360, 640], [390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.goto(`${base}/?seed=20261015`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${w}x${h}-title.png` });
  await page.waitForTimeout(100);
  await page.click('[data-act=start]');
  for (let i = 0; i < 6; i++) await page.click('#summonBtn');
  // move a unit to the left column and select it to show its range circle
  await page.evaluate(() => {
    const qa = window.__INDUCK_QA__; const s = qa.snapshot();
    const u = s.units.find((x) => x.major === 'engineering') ?? s.units[0];
    qa.dispatch({ type: 'DROP_UNIT', unitId: u.id, to: { x: 0, y: 2 } });
    qa.dispatch({ type: 'SELECT_UNIT', unitId: u.id });
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${w}x${h}-range-left.png` });
  result[`${w}x${h}`] = await page.evaluate(() => {
    const px = (sel) => [...document.querySelectorAll(sel)].map((e) => parseFloat(getComputedStyle(e).fontSize));
    const clip = (sel) => [...document.querySelectorAll(sel)].some((e) => e.scrollWidth > e.clientWidth + 0.5);
    const el = document.scrollingElement;
    return {
      scroll: [el.scrollHeight, el.clientHeight],
      font: { logoSmall: px('.logo small')[0], waveInfo: px('#waveInfo')[0], note: px('#note')[0], chip: px('.major-chip')[0], chipSmall: px('.major-chip small')[0], pill: px('.pill')[0], action: px('.action')[0] },
      clipped: { note: clip('#note'), chips: clip('.major-chip'), waveInfo: clip('#waveInfo') },
      noteText: document.getElementById('note').textContent,
    };
  });
  await page.close();
}
console.log(JSON.stringify(result, null, 1));
await browser.close();
