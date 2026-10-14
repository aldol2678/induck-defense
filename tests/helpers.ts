import { getMap, R0_MAP_ID } from '../src/core/catalog';
import { applyCommand, createSession, stepWithEvents } from '../src/core/engine';
import { buildableCells } from '../src/core/mapValidation';
import type { DomainEvent, GameState, Point } from '../src/core/types';

export const PLAZA = getMap(R0_MAP_ID);
export const QA_SEED = 20261015;

export function newRun(seed = QA_SEED): GameState {
  const s = createSession({ map: PLAZA, seed, ruleset: 'R0' });
  expectAccepted(applyCommand(s, { type: 'START_RUN' }));
  return s;
}

export function expectAccepted(r: { accepted: boolean; reason?: string }): void {
  if (!r.accepted) throw new Error(`command rejected: ${r.reason}`);
}

/** Runs ticks until the wave leaves the 'wave' phase (or maxTicks). */
export function runWave(s: GameState, maxTicks = 20 * 60 * 5): DomainEvent[] {
  const events: DomainEvent[] = [];
  let n = 0;
  while (s.phase === 'wave' && n++ < maxTicks) events.push(...stepWithEvents(s, 1));
  return events;
}

/** Cells by distance to the nearest path tile centre (closest first, then row-major). */
export function cellsNearPath(): Point[] {
  const path = PLAZA.paths[0]!;
  const score = (c: Point) => {
    let near = 0;
    for (const p of path) if (Math.hypot(p.x - c.x, p.y - c.y) <= 1.5) near++;
    return -near;
  };
  return buildableCells(PLAZA).sort((a, b) => score(a) - score(b) || a.y - b.y || a.x - b.x);
}

/** Simple player bot: summon everything, merge pairs, move units next to the road. */
export function botTurn(s: GameState, smart = true): void {
  while (applyCommand(s, { type: 'SUMMON' }).accepted) {
    /* spend all coins */
  }
  let merged = true;
  while (merged) {
    merged = false;
    for (const a of s.units) {
      const b = s.units.find((u) => u !== a && u.major === a.major && u.star === a.star && u.star < 4);
      if (b && applyCommand(s, { type: 'DROP_UNIT', unitId: a.id, to: b.cell }).accepted) {
        merged = true;
        break;
      }
    }
  }
  if (!smart) return;
  const good = cellsNearPath();
  const ranked = [...s.units].sort((a, b) => b.star - a.star);
  ranked.forEach((u, i) => {
    const target = good[i];
    if (target) applyCommand(s, { type: 'DROP_UNIT', unitId: u.id, to: target });
  });
}

export function playFullGame(seed: number, smart = true): GameState {
  const s = newRun(seed);
  while (s.phase === 'intermission') {
    botTurn(s, smart);
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    let n = 0;
    while ((s.phase as string) === 'wave' && n++ < 20 * 600) {
      stepWithEvents(s, 1);
      if (n % 20 === 0) botTurn(s, smart);
    }
  }
  return s;
}
