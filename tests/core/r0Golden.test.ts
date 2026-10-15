import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAP_CATALOG_SHA256 } from '../../src/core/catalog';
import { logicalState } from '../../src/core/engine';
import { replayFingerprint, runReplay, type ReplayLog } from '../../src/core/replay';
import { playFullGame, PLAZA, QA_SEED } from '../helpers';

// Hashes captured on the PR #2 base (1e37999) BEFORE the R1-B growth layer was added.
// Plain R0 sessions must stay byte-identical: state, events and command results.
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function r0Log(): ReplayLog {
  const entries: ReplayLog['entries'] = [
    { tick: 0, command: { type: 'START_RUN' } },
    ...Array.from({ length: 6 }, () => ({ tick: 0, command: { type: 'SUMMON' } as const })),
    { tick: 0, command: { type: 'DROP_UNIT', unitId: 'u1', to: { x: 2, y: 2 } } },
    { tick: 0, command: { type: 'START_WAVE' } },
  ];
  for (let t = 400; t < 6000; t += 150) {
    entries.push({ tick: t, command: { type: 'START_WAVE' } });
    entries.push({ tick: t, command: { type: 'SUMMON' } });
  }
  return { format: 'induck-replay/1', ruleset: 'R0', mapId: 'plaza', mapSha256: MAP_CATALOG_SHA256, seed: QA_SEED, entries, totalTicks: 6000 };
}

describe('R1-B regression guard · plain R0 sessions are unchanged', () => {
  it('scripted R0 replay fingerprint matches the pre-R1 golden hash', () => {
    expect(sha(replayFingerprint(runReplay(PLAZA, r0Log())))).toBe(
      '0320745745798475c50089bbe789e8a60986822fdfdf7c2f2798be95bfb16879',
    );
  });

  it.each([
    [QA_SEED, '37a79fc4b52096074f0057ff11c23269817ca97c6a1591005946575614930bc5'],
    [1, 'fc6520060b671242812c880e7136c2ccf3c0b3f252fd4eb7861216fbe4f5b429'],
    [7, '7fe776a122b586cd4a462c7694089b6e9bd96f7dfac59ad41be8f89eccdec6e0'],
    [42, '81aebe29e2196fcb850d42601f3d14ad6deb43c45670aea0f365050b51699d09'],
  ])('bot full game seed %i matches the pre-R1 golden final state', (seed, hash) => {
    expect(sha(JSON.stringify(logicalState(playFullGame(seed))))).toBe(hash);
  });

  it('R0 sessions carry no growth state and reject growth commands without mutation', async () => {
    const { applyCommand, createSession, getSnapshot } = await import('../../src/core/engine');
    const s = createSession({ map: PLAZA, seed: QA_SEED, ruleset: 'R0' });
    applyCommand(s, { type: 'START_RUN' });
    applyCommand(s, { type: 'SUMMON' });
    expect('growth' in s).toBe(false);
    expect(Object.keys(s.units[0]!).sort()).toEqual(['cell', 'cooldownTicks', 'id', 'major', 'star']);
    expect('growth' in getSnapshot(s)).toBe(false);
    const before = JSON.stringify(logicalState(s));
    for (const cmd of [
      { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-basic' },
      { type: 'EQUIP', unitId: 'u1', itemId: 'g1' },
      { type: 'UNEQUIP', unitId: 'u1' },
    ] as const) {
      expect(applyCommand(s, cmd)).toEqual({ accepted: false, reason: 'GROWTH_DISABLED', events: [] });
    }
    expect(JSON.stringify(logicalState(s))).toBe(before);
  });
});
