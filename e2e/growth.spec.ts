import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { getMap } from '../src/core/catalog';
import { getSnapshot } from '../src/core/engine';
import { runReplay, type ReplayLog } from '../src/core/replay';
import type { PlayerCommand, Point, RenderSnapshot } from '../src/core/types';

// R1-B growth test mode (?r1=1): equipment workshop + innate-trait merge choice through the real UI.
const SHOTS = 'docs/qa/screenshots';
mkdirSync(SHOTS, { recursive: true });
const SEED = 20261015;
const GACHA_KEY = 'induck_gacha_demo_v01_20261015';

type QA = {
  snapshot(): RenderSnapshot;
  dispatch(c: PlayerCommand): { accepted: boolean; reason?: string };
  replay(): ReplayLog;
  cellToClient(x: number, y: number): { x: number; y: number };
  overlayOpen(): boolean;
};
const snap = (page: Page) => page.evaluate(() => (window.__INDUCK_QA__ as QA).snapshot());
const cell = (page: Page, p: Point) => page.evaluate(([x, y]) => (window.__INDUCK_QA__ as QA).cellToClient(x, y), [p.x, p.y] as const);

async function boot(page: Page, query: string, owned: string[] | null) {
  if (owned) {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [GACHA_KEY, JSON.stringify({ version: 1, ic: 170, rc: 320, owned })] as const,
    );
  }
  await page.goto(`/?seed=${SEED}${query}`);
  await page.waitForFunction(() => !!window.__INDUCK_QA__);
  await page.waitForTimeout(400);
  await page.click('[data-act=start]');
  await expect(page.locator('#overlay')).toBeHidden();
}

async function mouseDrag(page: Page, from: Point, to: Point) {
  const a = await cell(page, from);
  const b = await cell(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(350);
}

/** Modal buttons ignore activations in the first 250 ms after a dialog opens. */
async function modalClick(page: Page, selector: string) {
  await page.waitForTimeout(300);
  await page.click(selector);
}

const brief = (s: RenderSnapshot) => JSON.stringify({ units: s.units, coin: s.coin, growth: s.growth });

test.describe('R1-B growth test mode (360x640)', () => {
  test.use({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, hasTouch: true });

  test('workshop: owned blueprint crafted with battle coins and equipped on the selected unit; unsupported shown as unusable', async ({ page }) => {
    await boot(page, '&r1=1', ['eq-shared-basic1', 'eq-eng-epic', 'skin-campus']);
    let s = await snap(page);
    expect(s.growth).toEqual({ blueprints: ['eq-eng-epic', 'eq-shared-basic1'], inventory: [] });

    for (let i = 0; i < 4; i++) await page.click('#summonBtn');
    s = await snap(page);
    expect(s.units).toHaveLength(4);
    expect(s.units.every((u) => typeof u.trait === 'string')).toBe(true);

    // select a unit by tapping it on the canvas, then open the workshop
    const target = s.units[0]!;
    const p = await cell(page, target.cell);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
    expect((await snap(page)).selectedUnitId).toBe(target.id);
    await page.click('#researchBtn');
    const modal = page.locator('#modal');
    await expect(modal).toContainText('장비 공방');
    await expect(modal).toContainText('사용불가 · 미구현(스킬형 효과)');
    await expect(page.locator('[data-act=craft][data-bp=eq-eng-epic]')).toHaveCount(0);

    // 4 summons left 40 coins: craft one 30-coin item
    await modalClick(page, '[data-act=craft][data-bp=eq-shared-basic1]');
    s = await snap(page);
    expect(s.coin).toBe(10);
    expect(s.growth!.inventory).toEqual([{ id: 'g1', blueprintId: 'eq-shared-basic1' }]);
    await expect(page.locator('[data-act=craft][data-bp=eq-shared-basic1]')).toBeDisabled(); // 10 < 30

    await modalClick(page, '[data-act=equip][data-item=g1]');
    s = await snap(page);
    const equipped = s.units.find((u) => u.id === target.id)!;
    expect(equipped.equipment).toEqual({ id: 'g1', blueprintId: 'eq-shared-basic1' });
    expect(s.growth!.inventory).toEqual([]);
    await expect(modal).toContainText('장비 해제');
    await page.screenshot({ path: `${SHOTS}/r1b-workshop-360x640.png` });

    await modalClick(page, '[data-act=unequip]');
    s = await snap(page);
    expect(s.units.find((u) => u.id === target.id)!.equipment).toBeNull();
    expect(s.growth!.inventory).toEqual([{ id: 'g1', blueprintId: 'eq-shared-basic1' }]);
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight)).toBe(true);
    await modalClick(page, '[data-act=resume]');
    await expect(page.locator('#overlay')).toBeHidden();

    // the gacha demo wallet was only read
    const wallet = await page.evaluate((k) => localStorage.getItem(k), GACHA_KEY);
    expect(JSON.parse(wallet!)).toMatchObject({ ic: 170, rc: 320 });
  });

  test('merge with differing traits asks for inheritance; cancel changes nothing; choice applies; replay matches', async ({ page }) => {
    await boot(page, '&r1=1', ['eq-shared-basic1']);
    await page.evaluate(() => (window.__INDUCK_QA__ as QA).dispatch({ type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' }));
    for (let i = 0; i < 4; i++) await page.click('#summonBtn');
    let s = await snap(page);
    // QA seed fixture: u1 and u2 are both sports ★1 with different innate traits
    const u1 = s.units.find((u) => u.id === 'u1')!;
    const u2 = s.units.find((u) => u.id === 'u2')!;
    expect(u1.major).toBe(u2.major);
    expect(u1.trait).not.toBe(u2.trait);
    await page.evaluate(() => (window.__INDUCK_QA__ as QA).dispatch({ type: 'EQUIP', unitId: 'u1', itemId: 'g1' }));
    s = await snap(page);
    const before = brief(s);

    await mouseDrag(page, u1.cell, u2.cell);
    await expect(page.locator('#modal')).toContainText('특성 계승');
    expect(await page.evaluate(() => (window.__INDUCK_QA__ as QA).overlayOpen())).toBe(true);
    await page.screenshot({ path: `${SHOTS}/r1b-merge-choice-360x640.png` });
    await modalClick(page, '[data-act=merge-cancel]');
    await expect(page.locator('#overlay')).toBeHidden();
    s = await snap(page);
    expect(s.paused).toBe(false);
    expect(brief(s)).toBe(before);

    await mouseDrag(page, u1.cell, u2.cell);
    await modalClick(page, '[data-act=merge-inherit][data-inherit=source]');
    s = await snap(page);
    expect(s.units.some((u) => u.id === 'u1')).toBe(false);
    const merged = s.units.find((u) => u.id === 'u2')!;
    expect(merged.star).toBe(2);
    expect(merged.trait).toBe(u1.trait);
    expect(s.growth!.inventory).toEqual([{ id: 'g1', blueprintId: 'eq-shared-basic1' }]); // material's item returned

    // UI ↔ core: the exported growth replay reproduces the browser state headlessly
    await page.click('#waveBtn');
    await page.waitForTimeout(1500);
    const { log, live } = await page.evaluate(() => {
      const qa = window.__INDUCK_QA__ as QA;
      qa.dispatch({ type: 'PAUSE' });
      return { log: qa.replay(), live: qa.snapshot() };
    });
    expect(log.growth).toEqual({ blueprints: ['eq-shared-basic1'] });
    const replayed = getSnapshot(runReplay(getMap('plaza'), log).state);
    expect(replayed).toEqual(live);
  });

  test('default R0 mode has no growth layer and offers the opt-in link', async ({ page }) => {
    await boot(page, '', ['eq-shared-basic1']);
    await page.click('#summonBtn');
    const s = await snap(page);
    expect(s.growth).toBeUndefined();
    expect(Object.keys(s.units[0]!)).not.toContain('trait');
    await page.click('#researchBtn');
    await expect(page.locator('#modal')).not.toContainText('장비 공방');
    await expect(page.locator('#modal a[href*="r1=1"]')).toBeVisible();
  });
});

test('320x568: workshop dialog stays inside the screen (no document scroll)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await boot(page, '&r1=1', ['eq-eng-basic', 'eq-eng-rare', 'eq-eng-epic', 'eq-shared-basic1', 'eq-shared-basic2', 'eq-shared-leg']);
  await page.click('#summonBtn');
  await page.click('#researchBtn');
  await expect(page.locator('#modal')).toContainText('장비 공방');
  const m = await page.evaluate(() => {
    const r = document.getElementById('modal')!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, scroll: document.scrollingElement!.scrollHeight, h: window.innerHeight };
  });
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeLessThanOrEqual(m.h);
  expect(m.scroll).toBeLessThanOrEqual(m.h);
  await page.screenshot({ path: `${SHOTS}/r1b-workshop-320x568.png` });
});
