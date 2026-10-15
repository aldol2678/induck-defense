import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAP_CATALOG, MAP_CATALOG_SHA256 } from '../../src/core/catalog';
import { createSession } from '../../src/core/engine';
import { buildableCells, MapValidationError, validateMap, validateMapDefinition } from '../../src/core/mapValidation';
import type { MapDefinition } from '../../src/core/types';

const RAW = readFileSync(new URL('../../src/data/maps/induck_defense_map_samples_R0.json', import.meta.url));
const mutate = (id: string, fn: (m: MapDefinition) => void): MapDefinition => {
  const m = structuredClone(MAP_CATALOG.maps.find((x) => x.id === id)!);
  fn(m);
  return m;
};
const codes = (m: MapDefinition) => validateMapDefinition(m).errors.map((e) => e.code);

describe('MAP-01 · map catalog integrity', () => {
  it('uses the contract input snapshot bytes (SHA-256)', () => {
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(MAP_CATALOG_SHA256);
    expect(MAP_CATALOG.version).toBe('R0');
  });

  it.each([
    ['plaza', 7, 7, [21], 28],
    ['lake', 8, 7, [14, 10], 28],
    ['building5', 8, 7, [10, 9], 29],
  ])('%s: %ix%i, path lengths %j, %i buildable cells, validation ok', (id, w, h, lens, build) => {
    const r = validateMap(MAP_CATALOG, id);
    expect(r).toEqual({ ok: true, errors: [] });
    const m = MAP_CATALOG.maps.find((x) => x.id === id)!;
    expect([m.width, m.height]).toEqual([w, h]);
    expect(m.paths.map((p) => p.length)).toEqual(lens);
    expect(buildableCells(m)).toHaveLength(build);
  });

  it('reports MAP_NOT_FOUND for unknown ids', () => {
    expect(validateMap(MAP_CATALOG, 'nowhere').errors[0]?.code).toBe('MAP_NOT_FOUND');
  });
});

describe('MAP-02 · mutations fail explicitly (no guessing / no detours)', () => {
  it('broken path (gap) → PATH_NON_ADJACENT', () => {
    expect(codes(mutate('plaza', (m) => m.paths[0]!.splice(5, 1)))).toContain('PATH_NON_ADJACENT');
  });
  it('path through a buildable / water / wall tile → PATH_INVALID_TILE', () => {
    expect(codes(mutate('plaza', (m) => (m.grid[1] = 'S==.===')))).toContain('PATH_INVALID_TILE');
    expect(codes(mutate('lake', (m) => (m.paths[0]![8] = { x: 5, y: 2 })))).toContain('PATH_INVALID_TILE');
    expect(codes(mutate('building5', (m) => (m.grid[3] = '.X..X.X.')))).toContain('PATH_INVALID_TILE');
  });
  it('out-of-map coordinate → PATH_OOB', () => {
    expect(codes(mutate('plaza', (m) => (m.paths[0]![3] = { x: 3, y: -1 })))).toContain('PATH_OOB');
  });
  it('start not S / end not B', () => {
    expect(codes(mutate('plaza', (m) => m.paths[0]!.shift()))).toContain('START_NOT_S');
    expect(codes(mutate('plaza', (m) => m.paths[0]!.pop()))).toContain('END_NOT_B');
  });
  it('uncovered spawn, empty path, bad dimensions, unknown tile, second base', () => {
    expect(codes(mutate('lake', (m) => m.paths.pop()))).toContain('SPAWN_UNCOVERED');
    expect(codes(mutate('plaza', (m) => (m.paths = [[]])))).toContain('PATH_EMPTY');
    expect(codes(mutate('plaza', (m) => (m.grid[2] = '......')))).toEqual(['GRID_DIMENSION']);
    expect(codes(mutate('plaza', (m) => (m.grid[0] = '...?...')))).toContain('UNKNOWN_TILE');
    expect(codes(mutate('plaza', (m) => (m.grid[6] = '......B')))).toContain('GOAL_MISMATCH');
  });
  it('an invalid map refuses to start a session with an explicit error', () => {
    const bad = mutate('plaza', (m) => m.paths[0]!.splice(5, 1));
    expect(() => createSession({ map: bad, seed: 1, ruleset: 'R0' })).toThrow(MapValidationError);
  });
});

describe('MAP-03 · duplicate paths and revisits (나루 QA D1·D2)', () => {
  it('D1: an exact duplicate of another path → PATH_DUPLICATE', () => {
    const m = mutate('plaza', (x) => x.paths.push(structuredClone(x.paths[0]!)));
    const r = validateMapDefinition(m);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual({ code: 'PATH_DUPLICATE', mapId: 'plaza', pathIndex: 1 });
  });
  it('D2: a path that revisits a cell (A→B→A) → PATH_REVISIT', () => {
    const m = mutate('plaza', (x) => {
      const p = x.paths[0]!;
      p.splice(2, 0, { x: 2, y: 1 }, { x: 1, y: 1 }); // (1,1)→(2,1)→(1,1)→(2,1)… all adjacent road tiles
    });
    const r = validateMapDefinition(m);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual({ code: 'PATH_REVISIT', mapId: 'plaza', pathIndex: 0, at: { x: 1, y: 1 } });
  });
  it('different spawns whose paths partially merge are still valid (lake / building5 originals)', () => {
    for (const id of ['plaza', 'lake', 'building5']) expect(validateMap(MAP_CATALOG, id)).toEqual({ ok: true, errors: [] });
    const b5 = MAP_CATALOG.maps.find((m) => m.id === 'building5')!;
    const shared = b5.paths[0]!.filter((p) => b5.paths[1]!.some((q) => q.x === p.x && q.y === p.y));
    expect(shared.length).toBeGreaterThan(1); // the two corridors genuinely share cells
  });
  it('original map JSON bytes are untouched', () => {
    expect(createHash('sha256').update(RAW).digest('hex')).toBe(MAP_CATALOG_SHA256);
  });
});
