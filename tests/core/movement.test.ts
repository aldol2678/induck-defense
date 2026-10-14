import { describe, expect, it } from 'vitest';
import { applyCommand, enemyWorldPosition, stepWithEvents } from '../../src/core/engine';
import type { DomainEvent } from '../../src/core/types';
import { expectAccepted, newRun, PLAZA } from '../helpers';

const PATH = PLAZA.paths[0]!;

describe('RUN-01 · plaza single S→B, no attacks', () => {
  it('enemies stay on the path centreline, visit every path tile in order and hit the base once each', () => {
    const s = newRun();
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    const events: DomainEvent[] = [];
    const visited = new Map<string, string[]>();
    const spawnTick = new Map<string, number>();
    while (s.phase === 'wave') {
      events.push(...stepWithEvents(s, 1));
      for (const e of s.enemies) {
        if (!spawnTick.has(e.id)) spawnTick.set(e.id, s.tick);
        const pos = enemyWorldPosition(PLAZA, e);
        const a = PATH[e.segmentIndex]!;
        const b = PATH[e.segmentIndex + 1]!;
        // On the axis-aligned segment between the two tile centres.
        const minX = Math.min(a.x, b.x) + 0.5, maxX = Math.max(a.x, b.x) + 0.5;
        const minY = Math.min(a.y, b.y) + 0.5, maxY = Math.max(a.y, b.y) + 0.5;
        expect(pos.x).toBeGreaterThanOrEqual(minX - 1e-9);
        expect(pos.x).toBeLessThanOrEqual(maxX + 1e-9);
        expect(pos.y).toBeGreaterThanOrEqual(minY - 1e-9);
        expect(pos.y).toBeLessThanOrEqual(maxY + 1e-9);
        // Never on a forbidden tile.
        const tile = PLAZA.grid[Math.floor(pos.y)]![Math.floor(pos.x)];
        expect(['S', '=', 'B']).toContain(tile);
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)}`;
        const seq = visited.get(e.id) ?? [];
        if (seq[seq.length - 1] !== key) seq.push(key);
        visited.set(e.id, seq);
      }
    }
    const expectedTiles = PATH.map((p) => `${p.x},${p.y}`); // every tile S → … → B, in order
    for (const seq of visited.values()) expect(seq).toEqual(expectedTiles);

    const reached = events.filter((e) => e.type === 'ENEMY_REACHED_BASE');
    const ids = reached.map((e) => (e as { enemyId: string }).enemyId);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6); // no double settlement
    const hpChanges = events.filter((e) => e.type === 'BASE_HP_CHANGED');
    expect(hpChanges).toHaveLength(6);
    expect(s.baseHp).toBe(10 - 6);
    expect(s.phase).toBe('intermission');

    // speed 1.0 tile/s over 20 tiles = 20 s = 400 ticks
    const first = reached[0]!;
    expect(first.tick - spawnTick.get(ids[0]!)!).toBeGreaterThanOrEqual(399);
    expect(first.tick - spawnTick.get(ids[0]!)!).toBeLessThanOrEqual(401);
  });
});
