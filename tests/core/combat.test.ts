import { describe, expect, it } from 'vitest';
import { applyCommand, R0_RULES, stepWithEvents, unitDamage } from '../../src/core/engine';
import type { DomainEvent, Enemy, GameState, Major, Star } from '../../src/core/types';
import { expectAccepted, newRun, runWave } from '../helpers';

function place(s: GameState, major: Major, x: number, y: number, star: Star = 1): string {
  const id = `u${s.nextEntityId++}`;
  s.units.push({ id, major, star, cell: { x, y }, cooldownTicks: 0 });
  return id;
}
const damagedBy = (events: DomainEvent[], unitId: string) =>
  events.filter((e) => e.type === 'ENEMY_DAMAGED' && 'unitId' in e && e.unitId === unitId);

describe('damage fixture (contract §5.1)', () => {
  it('round(base * (1 + 0.55 * (star-1))) is pinned per major/star', () => {
    const table = Object.fromEntries(
      (['engineering', 'sports', 'humanities'] as Major[]).map((m) => [m, [1, 2, 3, 4].map((st) => unitDamage(R0_RULES, m, st as Star))]),
    );
    expect(table).toEqual({ engineering: [4, 6, 8, 11], sports: [7, 11, 15, 19], humanities: [3, 5, 6, 8] });
  });
  it('majors differ in range / damage / attack period', () => {
    const m = R0_RULES.majors;
    expect([m.engineering.range, m.sports.range, m.humanities.range]).toEqual([2.5, 1.4, 2.0]);
    expect([m.engineering.damage, m.sports.damage, m.humanities.damage]).toEqual([4, 7, 3]);
    expect([m.engineering.attackMs, m.sports.attackMs, m.humanities.attackMs]).toEqual([900, 1000, 700]);
  });
});

describe('COMBAT-01 · placement changes the outcome (same seed, same units)', () => {
  function outcome(x: number, y: number) {
    const s = newRun();
    place(s, 'sports', x, y, 3);
    place(s, 'engineering', x === 0 ? 0 : 2, x === 0 ? 0 : 2, 2);
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    const ev = runWave(s);
    return { kills: s.kills, baseHp: s.baseHp, hits: ev.filter((e) => e.type === 'ENEMY_DAMAGED').length };
  }
  it('units hugging the road beat the same units parked in a far corner', () => {
    const near = outcome(2, 2); // (2,2) is enclosed by road on rows 1 and 3
    const far = outcome(0, 6);
    expect(near).not.toEqual(far);
    expect(near.kills).toBeGreaterThan(far.kills);
    expect(near.baseHp).toBeGreaterThan(far.baseHp);
  });
});

describe('COMBAT-02 · range, dead targets and deterministic tie-breaks', () => {
  it('a sports unit at (0,6) is 1.414 tiles from the nearest road centre and never fires (range 1.4)', () => {
    const s = newRun();
    const id = place(s, 'sports', 0, 6, 4);
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    expect(damagedBy(runWave(s), id)).toHaveLength(0);
  });

  it('no damage is ever applied to an enemy after it was killed', () => {
    const s = newRun();
    for (const [x, y] of [[2, 2], [3, 2], [4, 2], [5, 2], [2, 4], [3, 4]] as const) place(s, 'engineering', x, y, 2);
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    const ev = runWave(s);
    const dead = new Set<string>();
    for (const e of ev) {
      if (e.type === 'ENEMY_DAMAGED') expect(dead.has(e.enemyId)).toBe(false);
      if (e.type === 'ENEMY_KILLED') dead.add(e.enemyId);
    }
    expect(dead.size).toBeGreaterThan(0);
    expect(ev.filter((e) => e.type === 'ENEMY_KILLED')).toHaveLength(dead.size);
  });

  it('targets the enemy closest to the base; ties → earlier spawnOrder → lower id', () => {
    const s = newRun();
    s.phase = 'wave';
    s.wave = 1;
    s.plannedSpawns = 99;
    s.spawned = 99; // suppress spawning
    const mk = (id: string, seg: number, t: number, spawnOrder: number): Enemy => ({
      id, kind: 'assignment', pathIndex: 0, segmentIndex: seg, segmentT: t, hp: 100, maxHp: 100,
      speedCellsPerSecond: 0, baseDamage: 1, spawnOrder, exposedTicks: 0,
    });
    const shooter = place(s, 'engineering', 2, 2);
    s.enemies = [mk('e50', 2, 0, 1), mk('e51', 3, 0, 0), mk('e52', 3, 0, 2)];
    let ev = stepWithEvents(s, 1);
    expect(damagedBy(ev, shooter).map((e) => (e as { enemyId: string }).enemyId)).toEqual(['e51']);
    // equal progress and equal spawnOrder → lower numeric id (e9 < e10)
    s.enemies = [mk('e10', 3, 0, 0), mk('e9', 3, 0, 0)];
    s.units[0]!.cooldownTicks = 0;
    ev = stepWithEvents(s, 1);
    expect(damagedBy(ev, shooter).map((e) => (e as { enemyId: string }).enemyId)).toEqual(['e9']);
  });

  it('each unit fires on its own cooldown (engineering 18 ticks, sports 20, humanities 14)', () => {
    const s = newRun();
    s.phase = 'wave'; s.wave = 1; s.plannedSpawns = 1; s.spawned = 1;
    s.enemies = [{ id: 'e90', kind: 'exam', pathIndex: 0, segmentIndex: 9, segmentT: 0, hp: 1e6, maxHp: 1e6, speedCellsPerSecond: 0, baseDamage: 1, spawnOrder: 0, exposedTicks: 0 }];
    // (5,3) is on the road; units around it at distance 1
    const eng = place(s, 'engineering', 5, 2);
    const spo = place(s, 'sports', 5, 4);
    const hum = place(s, 'humanities', 4, 4);
    const ev = stepWithEvents(s, 20 * 6);
    const ticks = (id: string) => damagedBy(ev, id).map((e) => e.tick);
    const gaps = (xs: number[]) => xs.slice(1).map((v, i) => v - xs[i]!);
    expect(new Set(gaps(ticks(eng)))).toEqual(new Set([18]));
    expect(new Set(gaps(ticks(spo)))).toEqual(new Set([20]));
    expect(new Set(gaps(ticks(hum)))).toEqual(new Set([14]));
  });

  it('humanities expose: later hits deal round(damage * 1.25) while exposed', () => {
    const s = newRun();
    s.phase = 'wave'; s.wave = 1; s.plannedSpawns = 1; s.spawned = 1;
    s.enemies = [{ id: 'e90', kind: 'exam', pathIndex: 0, segmentIndex: 9, segmentT: 0, hp: 1e6, maxHp: 1e6, speedCellsPerSecond: 0, baseDamage: 1, spawnOrder: 0, exposedTicks: 0 }];
    const hum = place(s, 'humanities', 4, 4);
    const eng = place(s, 'engineering', 5, 2);
    const ev = stepWithEvents(s, 1);
    expect(damagedBy(ev, hum)[0]).toMatchObject({ amount: 3 });
    expect(damagedBy(ev, eng)[0]).toMatchObject({ amount: 5 }); // fired after humanities in the same tick
  });
});
