import { describe, expect, it } from 'vitest';
import { MAP_CATALOG_SHA256 } from '../../src/core/catalog';
import { GameController } from '../../src/core/controller';
import { logicalState } from '../../src/core/engine';
import { replayFingerprint, runReplay, type ReplayLog } from '../../src/core/replay';
import { PLAZA, QA_SEED } from '../helpers';

/** A scripted session: summon, rearrange, merge attempts, pause/resume mid-wave, three waves. */
function scriptedLog(seed: number): ReplayLog {
  const entries: ReplayLog['entries'] = [
    { tick: 0, command: { type: 'START_RUN' } },
    ...Array.from({ length: 6 }, () => ({ tick: 0, command: { type: 'SUMMON' } as const })),
    { tick: 0, command: { type: 'DROP_UNIT', unitId: 'u1', to: { x: 2, y: 2 } } },
    { tick: 0, command: { type: 'DROP_UNIT', unitId: 'u2', to: { x: 3, y: 2 } } },
    { tick: 0, command: { type: 'DROP_UNIT', unitId: 'u3', to: { x: 3, y: 1 } } }, // road → rejected
    { tick: 0, command: { type: 'START_WAVE' } },
    { tick: 60, command: { type: 'PAUSE' } },
    { tick: 60, command: { type: 'RESUME' } },
    { tick: 120, command: { type: 'SUMMON' } },
    { tick: 200, command: { type: 'DROP_UNIT', unitId: 'u4', to: { x: 4, y: 2 } } },
  ];
  for (let t = 400; t < 6000; t += 150) {
    entries.push({ tick: t, command: { type: 'START_WAVE' } });
    entries.push({ tick: t, command: { type: 'SUMMON' } });
  }
  return { format: 'induck-replay/1', ruleset: 'R0', mapId: 'plaza', mapSha256: MAP_CATALOG_SHA256, seed, entries, totalTicks: 6000 };
}

describe('RUN-02 · same seed + commands + ticks ⇒ identical result', () => {
  it('20 replays of the QA seed produce byte-identical state, events and command results', () => {
    const log = scriptedLog(QA_SEED);
    const prints = Array.from({ length: 20 }, () => replayFingerprint(runReplay(PLAZA, log)));
    expect(new Set(prints).size).toBe(1);
    const r = runReplay(PLAZA, log);
    expect(r.events.some((e) => e.type === 'ENEMY_KILLED')).toBe(true);
    expect(r.results.filter((x) => !x.accepted).length).toBeGreaterThan(0); // the road drop
  });

  it('a different seed changes the outcome', () => {
    const a = replayFingerprint(runReplay(PLAZA, scriptedLog(QA_SEED)));
    const b = replayFingerprint(runReplay(PLAZA, scriptedLog(QA_SEED + 1)));
    expect(a).not.toBe(b);
  });

  it('a live GameController session (irregular frame times) replays to the same logical state', () => {
    const c = new GameController(PLAZA, QA_SEED);
    c.dispatch({ type: 'START_RUN' });
    for (let i = 0; i < 6; i++) c.dispatch({ type: 'SUMMON' });
    c.dispatch({ type: 'START_WAVE' });
    const frames = [16.7, 33.4, 8, 50, 120, 16.7, 16.6, 250, 7, 16.7];
    for (let f = 0; f < 2000; f++) {
      c.advance(frames[f % frames.length]!);
      if (f === 300) c.dispatch({ type: 'SUMMON' });
      if (f === 500) c.dispatch({ type: 'DROP_UNIT', unitId: 'u1', to: { x: 2, y: 2 } });
      if (f % 400 === 399) c.dispatch({ type: 'START_WAVE' });
    }
    const log = c.exportReplay();
    const replayed = runReplay(PLAZA, log);
    expect(logicalState(replayed.state)).toEqual(logicalState(c.state));
  });
});
