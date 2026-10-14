import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { getMap } from '../src/core/catalog';
import { getSnapshot } from '../src/core/engine';
import { runReplay, type ReplayLog } from '../src/core/replay';
import type { PlayerCommand, Point, RenderSnapshot } from '../src/core/types';

const SHOTS = 'docs/qa/screenshots';
mkdirSync(SHOTS, { recursive: true });
const SEED = 20261015;
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];

type QA = {
  snapshot(): RenderSnapshot;
  dispatch(c: PlayerCommand): { accepted: boolean; reason?: string };
  replay(): ReplayLog;
  cellToClient(x: number, y: number): { x: number; y: number };
  overlayOpen(): boolean;
};
const snap = (page: Page) => page.evaluate(() => (window.__INDUCK_QA__ as QA).snapshot());
const cell = (page: Page, p: Point) => page.evaluate(([x, y]) => (window.__INDUCK_QA__ as QA).cellToClient(x, y), [p.x, p.y] as const);

async function boot(page: Page, start = true) {
  await page.goto(`/?seed=${SEED}`);
  await page.waitForFunction(() => !!window.__INDUCK_QA__);
  await page.waitForTimeout(400);
  if (start) {
    await page.click('[data-act=start]');
    await expect(page.locator('#overlay')).toBeHidden();
  }
}

async function mouseDrag(page: Page, from: Point, to: Point | { x: number; y: number; client: true }) {
  const a = await cell(page, from);
  const b = 'client' in to ? to : await cell(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(350);
}

const emptyBuildable = (s: RenderSnapshot): Point[] => {
  const grid = getMap('plaza').grid;
  const out: Point[] = [];
  grid.forEach((row, y) => [...row].forEach((c, x) => c === '.' && !s.units.some((u) => u.cell.x === x && u.cell.y === y) && out.push({ x, y })));
  return out;
};

for (const vp of VIEWPORTS) {
  test.describe(`UI-01 viewport ${vp.width}x${vp.height}`, () => {
    test.use({ viewport: vp, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

    test('single screen, no document scroll, key controls fully visible', async ({ page }) => {
      await boot(page, false);
      await page.screenshot({ path: `${SHOTS}/${vp.width}x${vp.height}-title.png` });
      const startBox = await page.locator('[data-act=start]').boundingBox();
      expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(vp.height);
      await page.click('[data-act=start]');
      for (let i = 0; i < 6; i++) await page.click('#summonBtn');
      await page.click('#waveBtn');
      await page.waitForTimeout(6000);
      const m = await page.evaluate(() => {
        const el = document.scrollingElement!;
        window.scrollTo(0, 500);
        return { sh: el.scrollHeight, ch: el.clientHeight, sy: window.scrollY, bw: document.body.scrollWidth, cw: el.clientWidth };
      });
      expect(m.sh).toBeLessThanOrEqual(m.ch + 1);
      expect(m.bw).toBeLessThanOrEqual(m.cw + 1);
      expect(m.sy).toBe(0);
      for (const sel of ['#summonBtn', '#waveBtn', '#helpBtn', '#pauseBtn', '#hpPill', '#coin', '#waveLabel', '#game canvas', '.major-chip >> nth=2']) {
        const box = await page.locator(sel).first().boundingBox();
        expect(box, sel).not.toBeNull();
        expect(box!.x, sel).toBeGreaterThanOrEqual(0);
        expect(box!.y, sel).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, sel).toBeLessThanOrEqual(vp.width + 0.5);
        expect(box!.y + box!.height, sel).toBeLessThanOrEqual(vp.height + 0.5);
      }
      // the whole 7x7 board is inside the canvas
      const s = await snap(page);
      expect(s.phase).toBe('wave');
      const corners = [await cell(page, { x: 0, y: 0 }), await cell(page, { x: 6, y: 6 })];
      const cv = (await page.locator('#game canvas').boundingBox())!;
      for (const c of corners) {
        expect(c.x).toBeGreaterThan(cv.x);
        expect(c.y).toBeGreaterThan(cv.y);
        expect(c.x).toBeLessThan(cv.x + cv.width);
        expect(c.y).toBeLessThan(cv.y + cv.height);
      }
      const tile = (await cell(page, { x: 1, y: 0 })).x - corners[0]!.x;
      expect(tile).toBeGreaterThanOrEqual(36); // touch target ≥ 36 CSS px per cell
      await page.screenshot({ path: `${SHOTS}/${vp.width}x${vp.height}-battle.png` });
    });
  });
}

test.describe('INPUT / REG via real pointer events (360x640)', () => {
  test.use({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, hasTouch: true });

  test('INPUT-01: drag to empty cell moves; same major+★ merges; different major swaps', async ({ page }) => {
    await boot(page);
    for (let i = 0; i < 6; i++) await page.click('#summonBtn');
    let s = await snap(page);
    expect(s.units).toHaveLength(6);

    // move
    const u = s.units[0]!;
    const target = emptyBuildable(s)[0]!;
    await mouseDrag(page, u.cell, target);
    s = await snap(page);
    expect(s.units.find((x) => x.id === u.id)!.cell).toEqual(target);

    // merge (6 units over 3 majors ⇒ at least one same-major pair)
    const a = s.units.find((x) => s.units.some((y) => y.id !== x.id && y.major === x.major && y.star === x.star))!;
    const b = s.units.find((y) => y.id !== a.id && y.major === a.major && y.star === a.star)!;
    await mouseDrag(page, a.cell, b.cell);
    s = await snap(page);
    expect(s.units).toHaveLength(5);
    expect(s.units.find((x) => x.id === b.id)!.star).toBe(2);
    expect(s.units.some((x) => x.id === a.id)).toBe(false);
    await page.screenshot({ path: `${SHOTS}/input-merge.png` });

    // swap (★2 vs any ★1 is always a swap)
    const merged = s.units.find((x) => x.id === b.id)!;
    const other = s.units.find((x) => x.star === 1)!;
    const [mc, oc] = [merged.cell, other.cell];
    await mouseDrag(page, mc, oc);
    s = await snap(page);
    expect(s.units.find((x) => x.id === merged.id)!.cell).toEqual(oc);
    expect(s.units.find((x) => x.id === other.id)!.cell).toEqual(mc);
  });

  test('INPUT-02: drops on road / spawn / base / outside the board and cancelled drags return home', async ({ page }) => {
    await boot(page);
    await page.click('#summonBtn');
    const before = await snap(page);
    const u = before.units[0]!;
    for (const bad of [{ x: 3, y: 1 }, { x: 0, y: 1 }, { x: 6, y: 5 }]) {
      await mouseDrag(page, u.cell, bad);
      await expect(page.locator('#toast')).toContainText('배치할 수 없어요');
    }
    const cv = (await page.locator('#game canvas').boundingBox())!;
    // released on the HUD (outside the canvas) → cancelled, no command
    await mouseDrag(page, u.cell, { x: cv.x + cv.width / 2, y: cv.y + cv.height + 60, client: true });
    // released inside the canvas but outside the 7x7 board → OUT_OF_BOUNDS
    const corner = await cell(page, { x: 0, y: 0 });
    await mouseDrag(page, u.cell, { x: corner.x, y: Math.max(cv.y + 2, corner.y - 60), client: true });
    const after = await snap(page);
    expect(after.units).toEqual(before.units);
    expect(after.coin).toBe(before.coin);
  });

  test('tap path: tap a unit (range shown) then tap a cell → same DROP_UNIT logic', async ({ page }) => {
    await boot(page);
    await page.click('#summonBtn');
    let s = await snap(page);
    const u = s.units[0]!;
    const a = await cell(page, u.cell);
    await page.mouse.click(a.x, a.y);
    s = await snap(page);
    expect(s.selectedUnitId).toBe(u.id);
    await page.screenshot({ path: `${SHOTS}/tap-select-range.png` });
    const t = emptyBuildable(s)[3]!;
    const b = await cell(page, t);
    await page.mouse.click(b.x, b.y);
    s = await snap(page);
    expect(s.units[0]!.cell).toEqual(t);
    expect(s.selectedUnitId).toBeNull();
  });

  test('touch drag (CDP touch events) moves a unit; touchcancel returns it', async ({ page }) => {
    await boot(page);
    await page.click('#summonBtn');
    let s = await snap(page);
    const u = s.units[0]!;
    const target = emptyBuildable(s)[5]!;
    const a = await cell(page, u.cell);
    const b = await cell(page, target);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] });
    await touch('touchStart', a.x, a.y);
    for (let i = 1; i <= 10; i++) await touch('touchMove', a.x + ((b.x - a.x) * i) / 10, a.y + ((b.y - a.y) * i) / 10);
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SHOTS}/touch-drag-ghost.png` });
    await touch('touchEnd', b.x, b.y);
    await page.waitForTimeout(300);
    s = await snap(page);
    expect(s.units[0]!.cell).toEqual(target);

    const c2 = emptyBuildable(s)[0]!;
    const p2 = await cell(page, c2);
    await touch('touchStart', b.x, b.y);
    for (let i = 1; i <= 10; i++) await touch('touchMove', b.x + ((p2.x - b.x) * i) / 10, b.y + ((p2.y - b.y) * i) / 10);
    await touch('touchCancel', p2.x, p2.y);
    await page.waitForTimeout(300);
    s = await snap(page);
    expect(s.units[0]!.cell).toEqual(target);
  });

  test('pause overlay freezes the simulation; resume continues', async ({ page }) => {
    await boot(page);
    await page.click('#summonBtn');
    await page.click('#waveBtn');
    await page.waitForTimeout(1500);
    await page.click('#pauseBtn');
    const t0 = (await snap(page)).tick;
    await page.waitForTimeout(1200);
    expect((await snap(page)).tick).toBe(t0);
    await page.waitForTimeout(300);
    await page.click('[data-act=resume]');
    await page.waitForTimeout(800);
    expect((await snap(page)).tick).toBeGreaterThan(t0);
  });

  test('UI ↔ core sync: browser session replays headlessly to the identical snapshot', async ({ page }) => {
    await boot(page);
    for (let i = 0; i < 6; i++) await page.click('#summonBtn');
    let s = await snap(page);
    await mouseDrag(page, s.units[0]!.cell, emptyBuildable(s)[2]!);
    await page.click('#waveBtn');
    await page.waitForTimeout(4000);
    s = await snap(page);
    await mouseDrag(page, s.units[1]!.cell, { x: 3, y: 2 });
    await page.click('#pauseBtn');
    const [browserSnap, log] = await page.evaluate(() => {
      const qa = window.__INDUCK_QA__ as QA;
      return [qa.snapshot(), qa.replay()] as const;
    });
    const replayed = getSnapshot(runReplay(getMap('plaza'), log).state);
    expect(replayed).toEqual(browserSnap);
    expect(browserSnap.tick).toBeGreaterThan(40);
  });
});

test('WAVE-01 in browser: no defenders → defeat overlay → restart', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  await page.evaluate(() => {
    const qa = window.__INDUCK_QA__ as QA;
    qa.dispatch({ type: 'START_WAVE' });
  });
  await page.waitForFunction(() => (window.__INDUCK_QA__ as QA).snapshot().phase === 'intermission', null, { timeout: 40_000 });
  expect((await snap(page)).baseHp).toBe(4);
  await page.click('#waveBtn');
  await page.waitForFunction(() => (window.__INDUCK_QA__ as QA).snapshot().phase === 'defeat', null, { timeout: 40_000 });
  await expect(page.locator('#modal')).toContainText('본부 함락');
  await page.screenshot({ path: `${SHOTS}/390x844-defeat.png` });
  await page.waitForTimeout(300);
  await page.click('[data-act=restart-same]');
  const s = await snap(page);
  expect(s).toMatchObject({ phase: 'ready', baseHp: 10, coin: 120, wave: 0, tick: 0, seed: SEED });
  expect(s.units).toHaveLength(0);
});

test('full run in browser: QA seed, bot plays through the UI command bridge → victory overlay', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page);
  const near = [[2, 2], [3, 2], [4, 2], [5, 2], [2, 4], [3, 4], [4, 4], [5, 4], [5, 0], [4, 0], [3, 0], [0, 4], [0, 3], [2, 6], [3, 6], [4, 6], [1, 2], [6, 4]];
  let phase = 'intermission';
  for (let i = 0; i < 400 && phase !== 'victory' && phase !== 'defeat'; i++) {
    phase = await page.evaluate((near) => {
      const qa = window.__INDUCK_QA__ as QA;
      while (qa.dispatch({ type: 'SUMMON' }).accepted);
      for (let merged = true; merged; ) {
        merged = false;
        const s = qa.snapshot();
        for (const a of s.units) {
          const b = s.units.find((u) => u.id !== a.id && u.major === a.major && u.star === a.star && u.star < 4);
          if (b && qa.dispatch({ type: 'DROP_UNIT', unitId: a.id, to: b.cell }).accepted) {
            merged = true;
            break;
          }
        }
      }
      [...qa.snapshot().units]
        .sort((a, b) => b.star - a.star)
        .forEach((u, i) => near[i] && qa.dispatch({ type: 'DROP_UNIT', unitId: u.id, to: { x: near[i]![0]!, y: near[i]![1]! } }));
      const s = qa.snapshot();
      if (s.phase === 'intermission') qa.dispatch({ type: 'START_WAVE' });
      return s.phase;
    }, near);
    if (i === 60) await page.screenshot({ path: `${SHOTS}/390x844-midwave.png` });
    await page.waitForTimeout(500);
  }
  expect(phase).toBe('victory');
  await expect(page.locator('#modal')).toContainText('방어 성공');
  await page.screenshot({ path: `${SHOTS}/390x844-victory.png` });
  const s = await snap(page);
  expect(s.wave).toBe(3);
  expect(s.baseHp).toBeGreaterThan(0);
});
