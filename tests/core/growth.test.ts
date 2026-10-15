import { describe, expect, it } from 'vitest';
import { MAP_CATALOG_SHA256 } from '../../src/core/catalog';
import { GameController } from '../../src/core/controller';
import { applyCommand, createSession, getSnapshot, logicalState, stepWithEvents, unitRange } from '../../src/core/engine';
import {
  cooldownWithCarry,
  CRAFT_COST,
  damageWithCarry,
  EQUIPMENT,
  normalizeBlueprints,
  rollTrait,
  tierFromRoll,
  TRAITS,
  traitStreamSeed,
} from '../../src/core/growth';
import { replayFingerprint, runReplay, type ReplayLog } from '../../src/core/replay';
import type { DomainEvent, GameState, TraitTier, Unit } from '../../src/core/types';
import { botTurn, expectAccepted, newRun, PLAZA, QA_SEED } from '../helpers';

const ALL_USABLE = EQUIPMENT.filter((e) => e.mods).map((e) => e.id);

function growthRun(seed = QA_SEED, blueprints: string[] = ALL_USABLE): GameState {
  const s = createSession({ map: PLAZA, seed, ruleset: 'R0', growth: { blueprints } });
  expectAccepted(applyCommand(s, { type: 'START_RUN' }));
  return s;
}

const frozen = (s: GameState) => JSON.stringify(logicalState(s));
const unit = (s: GameState, id: string): Unit => s.units.find((u) => u.id === id)!;

describe('R1-B · innate traits on a separate RNG stream', () => {
  it('growth summons pick the exact same majors/cells/RNG state as R0 for the same seed', () => {
    for (const seed of [QA_SEED, 1, 7, 99]) {
      const r0 = newRun(seed);
      const g = growthRun(seed);
      for (let i = 0; i < 6; i++) {
        applyCommand(r0, { type: 'SUMMON' });
        applyCommand(g, { type: 'SUMMON' });
      }
      expect(g.rngState).toBe(r0.rngState);
      expect(g.units.map((u) => [u.id, u.major, u.cell])).toEqual(r0.units.map((u) => [u.id, u.major, u.cell]));
      expect(g.units.every((u) => TRAITS.some((t) => t.id === u.trait))).toBe(true);
      expect(g.units.every((u) => u.equipment === null && u.damageCarry === 0 && u.cooldownCarry === 0)).toBe(true);
    }
  });

  it('trait stream is seed-derived, deterministic and not the gameplay stream', () => {
    expect(traitStreamSeed(QA_SEED)).not.toBe(QA_SEED);
    expect(traitStreamSeed(QA_SEED)).toBe(traitStreamSeed(QA_SEED));
    const a = growthRun(QA_SEED);
    const b = growthRun(QA_SEED);
    for (let i = 0; i < 6; i++) {
      applyCommand(a, { type: 'SUMMON' });
      applyCommand(b, { type: 'SUMMON' });
    }
    expect(a.units.map((u) => u.trait)).toEqual(b.units.map((u) => u.trait));
  });

  it('tier weights are 70/22/7/1 at the boundaries and over 100k rolls', () => {
    expect([0, 0.6999, 0.7, 0.9199, 0.92, 0.9899, 0.99, 0.999999].map(tierFromRoll)).toEqual([
      'normal', 'normal', 'rare', 'rare', 'epic', 'epic', 'legend', 'legend',
    ]);
    const count: Record<TraitTier, number> = { normal: 0, rare: 0, epic: 0, legend: 0 };
    let state = 12345;
    for (let i = 0; i < 100_000; i++) {
      const r = rollTrait(state);
      state = r.state;
      count[TRAITS.find((t) => t.id === r.traitId)!.tier]++;
    }
    expect(count.normal / 1000).toBeCloseTo(70, 0);
    expect(count.rare / 1000).toBeCloseTo(22, 0);
    expect(Math.abs(count.epic / 1000 - 7)).toBeLessThan(0.5);
    expect(Math.abs(count.legend / 1000 - 1)).toBeLessThan(0.2);
  });
});

describe('R1-B · blueprint-gated in-run crafting', () => {
  it('normalizes the owned-blueprint snapshot (known ids, deduped, catalog order)', () => {
    expect(normalizeBlueprints(['eq-shared-basic1', 'eq-eng-basic', 'eq-eng-basic', 'skin-x', 'eq-nope', 3])).toEqual([
      'eq-eng-basic',
      'eq-shared-basic1',
    ]);
  });

  it('crafts only owned + implemented blueprints and spends battle coins', () => {
    const s = growthRun(QA_SEED, ['eq-eng-basic', 'eq-eng-epic']);
    let before = frozen(s);
    expect(applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-sport-basic' }).reason).toBe('NOT_OWNED');
    expect(applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-epic' }).reason).toBe('UNSUPPORTED_OPTION');
    expect(frozen(s)).toBe(before);
    const r = applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-basic' });
    expect(r.accepted).toBe(true);
    expect(r.events).toEqual([{ type: 'EQUIPMENT_CRAFTED', tick: 0, itemId: 'g1' }]);
    expect(s.coin).toBe(120 - CRAFT_COST.normal);
    expect(s.growth!.inventory).toEqual([{ id: 'g1', blueprintId: 'eq-eng-basic' }]);
    s.coin = 10;
    before = frozen(s);
    expect(applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-basic' }).reason).toBe('NO_FUNDS');
    expect(frozen(s)).toBe(before);
  });

  it('crafting is blocked before START_RUN and while paused', () => {
    const s = createSession({ map: PLAZA, seed: 1, ruleset: 'R0', growth: { blueprints: ALL_USABLE } });
    expect(applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-basic' }).reason).toBe('PHASE_BLOCKED');
    applyCommand(s, { type: 'START_RUN' });
    applyCommand(s, { type: 'PAUSE' });
    expect(applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-basic' }).reason).toBe('PHASE_BLOCKED');
  });

  it('crafting does not touch the gameplay RNG or entity ids', () => {
    const a = growthRun(QA_SEED);
    const b = growthRun(QA_SEED);
    applyCommand(b, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' });
    applyCommand(a, { type: 'SUMMON' });
    applyCommand(b, { type: 'SUMMON' });
    expect(b.units[0]).toEqual(a.units[0]);
    expect(b.rngState).toBe(a.rngState);
  });
});

describe('R1-B · one equipment slot per unit', () => {
  function setup(): GameState {
    const s = growthRun(QA_SEED);
    s.coin = 1000;
    for (let i = 0; i < 4; i++) applyCommand(s, { type: 'SUMMON' });
    return s;
  }

  it('equip / swap / unequip keep exactly one item per unit and return items to inventory', () => {
    const s = setup();
    const u = s.units[0]!;
    applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' }); // g1
    applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic2' }); // g2
    expect(applyCommand(s, { type: 'EQUIP', unitId: u.id, itemId: 'g1' }).events.map((e) => e.type)).toEqual([
      'EQUIPMENT_EQUIPPED',
    ]);
    expect(u.equipment).toEqual({ id: 'g1', blueprintId: 'eq-shared-basic1' });
    expect(s.growth!.inventory.map((i) => i.id)).toEqual(['g2']);
    const swap = applyCommand(s, { type: 'EQUIP', unitId: u.id, itemId: 'g2' });
    expect(swap.events.map((e) => [e.type, (e as { itemId: string }).itemId])).toEqual([
      ['EQUIPMENT_UNEQUIPPED', 'g1'],
      ['EQUIPMENT_EQUIPPED', 'g2'],
    ]);
    expect(s.growth!.inventory.map((i) => i.id)).toEqual(['g1']);
    expect(applyCommand(s, { type: 'UNEQUIP', unitId: u.id }).accepted).toBe(true);
    expect(u.equipment).toBeNull();
    expect(s.growth!.inventory.map((i) => i.id).sort()).toEqual(['g1', 'g2']);
    const before = frozen(s);
    expect(applyCommand(s, { type: 'UNEQUIP', unitId: u.id }).reason).toBe('NOT_EQUIPPED');
    expect(applyCommand(s, { type: 'EQUIP', unitId: u.id, itemId: 'g9' }).reason).toBe('NO_ITEM');
    expect(applyCommand(s, { type: 'EQUIP', unitId: 'u99', itemId: 'g1' }).reason).toBe('NO_UNIT');
    expect(frozen(s)).toBe(before);
  });

  it('major-specific gear only fits its own major', () => {
    const s = setup();
    const other = s.units.find((u) => u.major !== 'engineering')!;
    applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-basic' });
    const before = frozen(s);
    expect(applyCommand(s, { type: 'EQUIP', unitId: other.id, itemId: 'g1' }).reason).toBe('MAJOR_MISMATCH');
    expect(frozen(s)).toBe(before);
  });
});

describe('R1-B · merge with trait inheritance choice', () => {
  /** Two same-major ★1 units with different traits; the material (source) carries an item. */
  function pair(): { s: GameState; source: Unit; target: Unit } {
    const s = growthRun(QA_SEED);
    s.coin = 1000;
    for (let i = 0; i < 8; i++) applyCommand(s, { type: 'SUMMON' });
    const [source, target] = s.units.filter((u) => u.major === s.units[0]!.major);
    if (!source || !target) throw new Error('fixture: need two same-major units');
    source.trait = 'agile';
    target.trait = 'diligent';
    applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' }); // g1 → source
    applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic2' }); // g2 → target
    expectAccepted(applyCommand(s, { type: 'EQUIP', unitId: source.id, itemId: 'g1' }));
    expectAccepted(applyCommand(s, { type: 'EQUIP', unitId: target.id, itemId: 'g2' }));
    return { s, source, target };
  }

  it('without a choice the merge is rejected and NOTHING changes (units, items, coins, RNG)', () => {
    const { s, source, target } = pair();
    const before = frozen(s);
    const r = applyCommand(s, { type: 'DROP_UNIT', unitId: source.id, to: target.cell });
    expect(r).toEqual({ accepted: false, reason: 'CHOICE_REQUIRED', events: [] });
    expect(frozen(s)).toBe(before);
    // "Cancel" in the UI = simply not sending the choice; a later normal action still works.
    expectAccepted(applyCommand(s, { type: 'SUMMON' }));
  });

  it.each([
    ['target', 'diligent'],
    ['source', 'agile'],
  ] as const)('inherit=%s keeps trait %s; result keeps its item, the material item returns', (inherit, kept) => {
    const { s, source, target } = pair();
    const coin = s.coin;
    const rng = [s.rngState, s.growth!.traitRngState];
    const r = applyCommand(s, { type: 'DROP_UNIT', unitId: source.id, to: target.cell, inherit });
    expect(r.accepted).toBe(true);
    expect(r.events.map((e) => e.type)).toEqual(['UNIT_MERGED', 'EQUIPMENT_RETURNED']);
    const merged = unit(s, target.id);
    expect(merged.star).toBe(2);
    expect(merged.trait).toBe(kept);
    expect(merged.equipment).toEqual({ id: 'g2', blueprintId: 'eq-shared-basic2' });
    expect(s.units.some((u) => u.id === source.id)).toBe(false);
    expect(s.growth!.inventory).toEqual([{ id: 'g1', blueprintId: 'eq-shared-basic1' }]);
    expect(s.coin).toBe(coin);
    expect([s.rngState, s.growth!.traitRngState]).toEqual(rng);
  });

  it('identical traits merge without a choice; MAX_STAR wins over CHOICE_REQUIRED', () => {
    const { s, source, target } = pair();
    source.trait = target.trait;
    expect(applyCommand(s, { type: 'DROP_UNIT', unitId: source.id, to: target.cell }).accepted).toBe(true);
    const t2 = growthRun(1);
    for (let i = 0; i < 8; i++) applyCommand(t2, { type: 'SUMMON' });
    const [a, b] = t2.units.filter((u) => u.major === t2.units[0]!.major);
    a!.star = 4;
    b!.star = 4;
    a!.trait = 'agile';
    b!.trait = 'quick';
    expect(applyCommand(t2, { type: 'DROP_UNIT', unitId: a!.id, to: b!.cell }).reason).toBe('MAX_STAR');
  });
});

describe('R1-B · real combat options: damage / attack speed / range', () => {
  it('fixed-point damage removes rounding loss (+8% on 3 dmg ⇒ 324 over 100 hits, R0 parity at 0%)', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const d = damageWithCarry(3, 8, carry);
      total += d.damage;
      carry = d.carry;
      expect([3, 4]).toContain(d.damage);
    }
    expect(total).toBe(324);
    expect(Math.round(3 * 1.08) * 100).toBe(300); // what naive per-hit rounding would deal
    for (const base of [3, 4, 5, 6, 7, 11, 17]) expect(damageWithCarry(base, 0, 0)).toEqual({ damage: base, carry: 0 });
  });

  it('cooldown with carry matches R0 at 0% and averages the exact faster period', () => {
    for (const ms of [700, 900, 1000]) expect(cooldownWithCarry(ms, 50, 0, 0)).toEqual({ ticks: ms / 50, carry: 0 });
    let carry = 0;
    let ticks = 0;
    for (let i = 0; i < 112; i++) {
      const c = cooldownWithCarry(1000, 50, 12, carry);
      ticks += c.ticks;
      carry = c.carry;
    }
    // 112 attacks at 1000ms/1.12 ≈ 100 s = 2000 ticks (±1 tick of carried remainder)
    expect(Math.abs(ticks - 2000)).toBeLessThanOrEqual(1);
  });

  it('equipped range bonus is used for targeting and shown in the snapshot', () => {
    const s = growthRun(QA_SEED, ['eq-eng-rare']);
    s.coin = 1000;
    for (let i = 0; i < 6 && !s.units.some((u) => u.major === 'engineering'); i++) applyCommand(s, { type: 'SUMMON' });
    const eng = s.units.find((u) => u.major === 'engineering')!;
    eng.trait = 'diligent'; // no range from the trait
    const base = unitRange(s, eng);
    applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-eng-rare' });
    applyCommand(s, { type: 'EQUIP', unitId: eng.id, itemId: 'g1' });
    expect(unitRange(s, eng)).toBeCloseTo(base + 0.25, 9);
    expect(getSnapshot(s).units.find((u) => u.id === eng.id)!.range).toBeCloseTo(2.75, 9);
  });

  it('a damage item changes the actual battle: more total damage dealt in the same wave', () => {
    const play = (equip: boolean): number => {
      const s = growthRun(QA_SEED, ['eq-shared-basic1']);
      s.coin = 1000;
      for (let i = 0; i < 3; i++) applyCommand(s, { type: 'SUMMON' });
      for (const u of s.units) u.trait = 'quick'; // isolate the item effect from rolled damage traits
      if (equip) {
        applyCommand(s, { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' });
        for (const u of s.units.slice(0, 1)) applyCommand(s, { type: 'EQUIP', unitId: u.id, itemId: 'g1' });
      }
      applyCommand(s, { type: 'START_WAVE' });
      const events: DomainEvent[] = [];
      for (let i = 0; i < 400; i++) events.push(...stepWithEvents(s, 1));
      return events.reduce((a, e) => a + (e.type === 'ENEMY_DAMAGED' && e.unitId === s.units[0]?.id ? e.amount ?? 0 : 0), 0);
    };
    expect(play(true)).toBeGreaterThan(play(false));
  });
});

describe('R1-B · determinism and replay', () => {
  function growthLog(seed: number): ReplayLog {
    const entries: ReplayLog['entries'] = [
      { tick: 0, command: { type: 'START_RUN' } },
      ...Array.from({ length: 6 }, () => ({ tick: 0, command: { type: 'SUMMON' } as const })),
      { tick: 0, command: { type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' } },
      { tick: 0, command: { type: 'EQUIP', unitId: 'u1', itemId: 'g1' } },
      { tick: 0, command: { type: 'DROP_UNIT', unitId: 'u2', to: { x: 2, y: 2 }, inherit: 'source' } },
      { tick: 0, command: { type: 'START_WAVE' } },
      { tick: 120, command: { type: 'UNEQUIP', unitId: 'u1' } },
      { tick: 121, command: { type: 'EQUIP', unitId: 'u3', itemId: 'g1' } },
    ];
    for (let t = 400; t < 6000; t += 150) {
      entries.push({ tick: t, command: { type: 'START_WAVE' } });
      entries.push({ tick: t, command: { type: 'SUMMON' } });
    }
    return {
      format: 'induck-replay/1', ruleset: 'R0', mapId: 'plaza', mapSha256: MAP_CATALOG_SHA256,
      seed, entries, totalTicks: 6000, growth: { blueprints: ['eq-shared-basic1'] },
    };
  }

  it('20 growth replays are byte-identical; another seed differs', () => {
    const prints = Array.from({ length: 20 }, () => replayFingerprint(runReplay(PLAZA, growthLog(QA_SEED))));
    expect(new Set(prints).size).toBe(1);
    expect(replayFingerprint(runReplay(PLAZA, growthLog(QA_SEED + 1)))).not.toBe(prints[0]);
  });

  it('live controller growth session (with RESTART) replays to the same logical state', () => {
    const c = new GameController(PLAZA, QA_SEED, { blueprints: ['eq-shared-basic1', 'eq-eng-basic'] });
    c.dispatch({ type: 'RESTART', seed: 77 });
    expect(c.state.growth!.blueprints).toEqual(['eq-eng-basic', 'eq-shared-basic1']);
    c.dispatch({ type: 'START_RUN' });
    for (let i = 0; i < 6; i++) c.dispatch({ type: 'SUMMON' });
    c.dispatch({ type: 'CRAFT_EQUIPMENT', blueprintId: 'eq-shared-basic1' });
    c.dispatch({ type: 'EQUIP', unitId: 'u1', itemId: 'g1' });
    c.dispatch({ type: 'START_WAVE' });
    const frames = [16.7, 33.4, 8, 50, 120];
    for (let f = 0; f < 1500; f++) {
      c.advance(frames[f % frames.length]!);
      if (f === 300) c.dispatch({ type: 'UNEQUIP', unitId: 'u1' });
      if (f % 400 === 399) c.dispatch({ type: 'START_WAVE' });
    }
    const log = c.exportReplay();
    expect(log.growth).toEqual({ blueprints: ['eq-eng-basic', 'eq-shared-basic1'] });
    expect(logicalState(runReplay(PLAZA, log).state)).toEqual(logicalState(c.state));
  });

  it('a bot full growth game is deterministic and ends in a terminal phase', () => {
    const play = () => {
      const s = growthRun(QA_SEED);
      while (s.phase === 'intermission') {
        botTurn(s); // summons; trait-differing merges are rejected (CHOICE_REQUIRED) without effect
        for (let merged = true; merged; ) {
          merged = false;
          for (const u of s.units) {
            const o = s.units.find((x) => x !== u && x.major === u.major && x.star === u.star && x.star < 4);
            if (o && applyCommand(s, { type: 'DROP_UNIT', unitId: u.id, to: o.cell, inherit: 'source' }).accepted) {
              merged = true;
              break;
            }
          }
        }
        applyCommand(s, { type: 'START_WAVE' });
        let n = 0;
        while ((s.phase as string) === 'wave' && n++ < 20 * 600) stepWithEvents(s, 1);
      }
      return s;
    };
    const a = play();
    expect(['victory', 'defeat']).toContain(a.phase);
    expect(frozen(play())).toBe(frozen(a));
  });
});
