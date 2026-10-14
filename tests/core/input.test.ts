import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, logicalState } from '../../src/core/engine';
import type { GameState, Major, Point, Star } from '../../src/core/types';
import { expectAccepted, newRun, PLAZA } from '../helpers';

function place(s: GameState, major: Major, x: number, y: number, star: Star = 1, cooldownTicks = 0): string {
  const id = `u${s.nextEntityId++}`;
  s.units.push({ id, major, star, cell: { x, y }, cooldownTicks });
  return id;
}
const unit = (s: GameState, id: string) => s.units.find((u) => u.id === id);

function expectRejectedNoMutation(s: GameState, cmd: Parameters<typeof applyCommand>[1], reason: string) {
  const before = logicalState(s);
  const r = applyCommand(s, cmd);
  expect(r).toEqual({ accepted: false, reason, events: [] });
  expect(logicalState(s)).toEqual(before);
}

describe('summon', () => {
  it('costs 20, spawns a ★1 unit on an empty "." cell, RNG order = major then cell', () => {
    const s = newRun();
    const r = applyCommand(s, { type: 'SUMMON' });
    expect(r.accepted).toBe(true);
    expect(r.events).toEqual([{ type: 'UNIT_SUMMONED', tick: 0, unitId: 'u1' }]);
    expect(s.coin).toBe(100);
    const u = s.units[0]!;
    expect(u.star).toBe(1);
    expect(PLAZA.grid[u.cell.y]![u.cell.x]).toBe('.');
    // pinned for seed 20261015 (first two RNG draws 0.401…, 0.508…)
    expect(u.major).toBe('sports');
    expect(u.cell).toEqual({ x: 0, y: 4 });
  });
});

describe('INPUT-01 · drop onto empty / same / different unit', () => {
  it('empty "." → move', () => {
    const s = newRun();
    const a = place(s, 'engineering', 0, 0);
    const r = applyCommand(s, { type: 'DROP_UNIT', unitId: a, to: { x: 2, y: 2 } });
    expect(r.events.map((e) => e.type)).toEqual(['UNIT_MOVED']);
    expect(unit(s, a)!.cell).toEqual({ x: 2, y: 2 });
  });

  it('same major + same ★ → merge: target id survives at ★+1 with cooldown reset; dragged unit removed', () => {
    const s = newRun();
    const a = place(s, 'sports', 0, 0, 2, 5);
    const b = place(s, 'sports', 3, 2, 2, 7);
    const r = applyCommand(s, { type: 'DROP_UNIT', unitId: a, to: { x: 3, y: 2 } });
    expect(r.events).toEqual([{ type: 'UNIT_MERGED', tick: 0, unitId: b, otherUnitId: a }]);
    expect(s.units).toEqual([{ id: b, major: 'sports', star: 3, cell: { x: 3, y: 2 }, cooldownTicks: 0 }]);
  });

  it('different major or different ★ → swap', () => {
    const s = newRun();
    const a = place(s, 'sports', 0, 0, 1);
    const b = place(s, 'humanities', 3, 2, 1);
    const c = place(s, 'sports', 4, 2, 2);
    expect(applyCommand(s, { type: 'DROP_UNIT', unitId: a, to: { x: 3, y: 2 } }).events[0]?.type).toBe('UNIT_SWAPPED');
    expect(unit(s, a)!.cell).toEqual({ x: 3, y: 2 });
    expect(unit(s, b)!.cell).toEqual({ x: 0, y: 0 });
    expect(applyCommand(s, { type: 'DROP_UNIT', unitId: a, to: { x: 4, y: 2 } }).events[0]?.type).toBe('UNIT_SWAPPED');
    expect(unit(s, c)!.cell).toEqual({ x: 3, y: 2 });
    expect(s.units).toHaveLength(3);
  });

  it('drop on its own cell is a no-op success', () => {
    const s = newRun();
    const a = place(s, 'sports', 0, 0);
    const before = logicalState(s);
    expect(applyCommand(s, { type: 'DROP_UNIT', unitId: a, to: { x: 0, y: 0 } })).toEqual({ accepted: true, events: [] });
    expect(logicalState(s)).toEqual(before);
  });

  it('tap path: SELECT_UNIT then DROP_UNIT uses the same rules and clears the selection', () => {
    const s = newRun();
    const a = place(s, 'engineering', 0, 0);
    expectAccepted(applyCommand(s, { type: 'SELECT_UNIT', unitId: a }));
    expect(s.selectedUnitId).toBe(a);
    expectAccepted(applyCommand(s, { type: 'DROP_UNIT', unitId: a, to: { x: 1, y: 0 } }));
    expect(s.selectedUnitId).toBeNull();
  });
});

describe('INPUT-02 · forbidden or out-of-board drops are atomic failures', () => {
  const forbidden: [string, Point][] = [
    ['road =', { x: 3, y: 1 }],
    ['spawn S', { x: 0, y: 1 }],
    ['base B', { x: 6, y: 5 }],
  ];
  it.each(forbidden)('%s → FORBIDDEN_TERRAIN, state unchanged', (_n, to) => {
    const s = newRun();
    const a = place(s, 'engineering', 0, 0, 1, 3);
    expectRejectedNoMutation(s, { type: 'DROP_UNIT', unitId: a, to }, 'FORBIDDEN_TERRAIN');
  });
  it.each([[{ x: -1, y: 0 }], [{ x: 7, y: 3 }], [{ x: 2, y: 9 }], [{ x: 1.5, y: 2 }]])('outside %j → OUT_OF_BOUNDS', (to) => {
    const s = newRun();
    const a = place(s, 'engineering', 0, 0);
    expectRejectedNoMutation(s, { type: 'DROP_UNIT', unitId: a, to }, 'OUT_OF_BOUNDS');
  });
  it('water "~" and wall "X" tiles are forbidden drop targets (engine rule is tile-based)', () => {
    // plaza has no water/walls; reuse its session with a lake-style terrain mutation of non-path cells.
    const map = structuredClone(PLAZA);
    map.grid[0] = '~X.....';
    const s = createSession({ map, seed: 1, ruleset: 'R0' });
    expectAccepted(applyCommand(s, { type: 'START_RUN' }));
    const a = place(s, 'sports', 2, 0);
    expectRejectedNoMutation(s, { type: 'DROP_UNIT', unitId: a, to: { x: 0, y: 0 } }, 'FORBIDDEN_TERRAIN');
    expectRejectedNoMutation(s, { type: 'DROP_UNIT', unitId: a, to: { x: 1, y: 0 } }, 'FORBIDDEN_TERRAIN');
  });
  it('unknown unit → NO_UNIT', () => {
    const s = newRun();
    expectRejectedNoMutation(s, { type: 'DROP_UNIT', unitId: 'u999', to: { x: 0, y: 0 } }, 'NO_UNIT');
  });
});

describe('INPUT-03 · ★4 merge, full board, no funds — reason + resources + RNG unchanged', () => {
  it('★4 + ★4 same major → MAX_STAR and no swap', () => {
    const s = newRun();
    const a = place(s, 'humanities', 0, 0, 4);
    place(s, 'humanities', 2, 2, 4);
    expectRejectedNoMutation(s, { type: 'DROP_UNIT', unitId: a, to: { x: 2, y: 2 } }, 'MAX_STAR');
  });
  it('no funds → NO_FUNDS', () => {
    const s = newRun();
    s.coin = 19;
    expectRejectedNoMutation(s, { type: 'SUMMON' }, 'NO_FUNDS');
  });
  it('28 buildable cells full → BOARD_FULL', () => {
    const s = newRun();
    s.coin = 10_000;
    for (let i = 0; i < 28; i++) expectAccepted(applyCommand(s, { type: 'SUMMON' }));
    expect(s.units).toHaveLength(28);
    expect(new Set(s.units.map((u) => `${u.cell.x},${u.cell.y}`)).size).toBe(28);
    expectRejectedNoMutation(s, { type: 'SUMMON' }, 'BOARD_FULL');
  });
  it('commands are blocked before START_RUN, while paused and after the game ends', () => {
    const s = createSession({ map: PLAZA, seed: 7, ruleset: 'R0' });
    expectRejectedNoMutation(s, { type: 'SUMMON' }, 'PHASE_BLOCKED');
    expectAccepted(applyCommand(s, { type: 'START_RUN' }));
    expectAccepted(applyCommand(s, { type: 'PAUSE' }));
    expectRejectedNoMutation(s, { type: 'SUMMON' }, 'PHASE_BLOCKED');
    expectRejectedNoMutation(s, { type: 'START_WAVE' }, 'PHASE_BLOCKED');
    expectAccepted(applyCommand(s, { type: 'RESUME' }));
    s.phase = 'defeat';
    expectRejectedNoMutation(s, { type: 'SUMMON' }, 'PHASE_BLOCKED');
    expectRejectedNoMutation(s, { type: 'RESTART', seed: -5 }, 'INVALID_STATE');
  });
});
