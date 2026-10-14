import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, logicalState, stepWithEvents } from '../../src/core/engine';
import { expectAccepted, newRun, PLAZA, playFullGame, QA_SEED, runWave } from '../helpers';

describe('WAVE-01 · wave end, victory, defeat, restart', () => {
  it('with no defenders: wave 1 leaks 6 (HP 10→4), wave 2 drops HP to 0 → defeat once and frozen', () => {
    const s = newRun();
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    const w1 = runWave(s);
    expect(w1.filter((e) => e.type === 'WAVE_CLEARED')).toHaveLength(1);
    expect(s).toMatchObject({ phase: 'intermission', baseHp: 4, wave: 1, coin: 120 + 20 });
    expectAccepted(applyCommand(s, { type: 'START_WAVE' }));
    const w2 = runWave(s);
    expect(s.phase).toBe('defeat');
    expect(s.baseHp).toBe(0);
    expect(w2.filter((e) => e.type === 'GAME_LOST')).toHaveLength(1);
    expect(w2.some((e) => e.type === 'WAVE_CLEARED')).toBe(false);
    const frozen = logicalState(s);
    stepWithEvents(s, 100);
    expect(logicalState(s)).toEqual(frozen);
    expect(applyCommand(s, { type: 'SUMMON' }).reason).toBe('PHASE_BLOCKED');
  });

  it('RESTART resets to a fresh session for the given seed', () => {
    const s = newRun();
    applyCommand(s, { type: 'SUMMON' });
    applyCommand(s, { type: 'START_WAVE' });
    stepWithEvents(s, 300);
    expectAccepted(applyCommand(s, { type: 'RESTART', seed: 42 }));
    expect(logicalState(s)).toEqual(logicalState(createSession({ map: PLAZA, seed: 42, ruleset: 'R0' })));
  });

  it('PAUSE freezes ticks, cooldowns, spawns and movement', () => {
    const s = newRun();
    applyCommand(s, { type: 'SUMMON' });
    applyCommand(s, { type: 'START_WAVE' });
    stepWithEvents(s, 77);
    expectAccepted(applyCommand(s, { type: 'PAUSE' }));
    const before = logicalState(s);
    expect(stepWithEvents(s, 500)).toEqual([]);
    expect(logicalState(s)).toEqual(before);
    expectAccepted(applyCommand(s, { type: 'RESUME' }));
    stepWithEvents(s, 1);
    expect(s.tick).toBe(before.tick + 1);
  });

  it('the QA seed is winnable: a merge-and-place bot clears all 3 waves (GAME_WON)', () => {
    const s = playFullGame(QA_SEED, true);
    expect(s.phase).toBe('victory');
    expect(s.wave).toBe(3);
    expect(s.baseHp).toBeGreaterThan(0);
  });

  it('placement strategy matters across seeds: road-side bot wins clearly more than random-placement bot', () => {
    let smart = 0;
    let naive = 0;
    for (let seed = 1; seed <= 60; seed++) {
      if (playFullGame(seed, true).phase === 'victory') smart++;
      if (playFullGame(seed, false).phase === 'victory') naive++;
    }
    expect(smart).toBeGreaterThanOrEqual(45);
    expect(naive).toBeLessThan(smart - 20);
    console.info(`[balance] seeds 1..60 — road-side bot ${smart}/60 wins, random-placement bot ${naive}/60 wins`);
  });
});
