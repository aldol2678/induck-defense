import { describe, expect, it } from 'vitest';
import { isValidSeed, nextRandom } from '../../src/core/rng';

describe('mulberry32 RNG (contract §6)', () => {
  it('is a pure function of the 32-bit state', () => {
    const a = nextRandom(20261015);
    const b = nextRandom(20261015);
    expect(a).toEqual(b);
    expect(a.state).toBe((20261015 + 0x6d2b79f5) >>> 0);
    expect(a.value).toBeGreaterThanOrEqual(0);
    expect(a.value).toBeLessThan(1);
  });

  it('produces the pinned reference sequence for the QA seed 20261015', () => {
    let s = 20261015;
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = nextRandom(s);
      s = r.state;
      values.push(r.value);
    }
    expect(values).toMatchInlineSnapshot(`
      [
        0.40124592115171254,
        0.5087482859380543,
        0.5477656635921448,
        0.5049111102707684,
        0.8810037593357265,
      ]
    `);
  });

  it('rejects strings, negatives, NaN, fractions and >32-bit seeds', () => {
    for (const bad of ['1', -1, Number.NaN, 1.5, 4294967296, Infinity, null, undefined]) {
      expect(isValidSeed(bad)).toBe(false);
    }
    for (const good of [0, 1, 20261015, 4294967295]) expect(isValidSeed(good)).toBe(true);
  });
});
