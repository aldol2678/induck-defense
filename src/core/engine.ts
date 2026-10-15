// INDUCK-R0-001 R0.1 headless battle engine.
// Fixed 50 ms ticks, seeded mulberry32, atomic commands. See docs/implementation-plan.md.
import r0Rules from '../../fixtures/r0/ruleset.json' with { type: 'json' };
import {
  addMods,
  canEquip,
  cooldownWithCarry,
  CRAFT_COST,
  damageWithCarry,
  getEquipment,
  getTrait,
  NO_MODS,
  normalizeBlueprints,
  rollTrait,
  traitStreamSeed,
} from './growth';
import { buildableCells, inBounds, isBuildable, MapValidationError, validateMapDefinition } from './mapValidation';
import { isValidSeed, nextRandom } from './rng';
import type {
  CommandResult,
  DomainEvent,
  Enemy,
  EnemyView,
  GameState,
  GrowthConfig,
  Major,
  MapDefinition,
  PlayerCommand,
  Point,
  RejectReason,
  RenderSnapshot,
  Ruleset,
  StatMods,
  Star,
  Unit,
  UnitView,
} from './types';

export const R0_RULES = r0Rules as Ruleset;

export type SessionConfig = {
  map: MapDefinition;
  seed: number;
  ruleset: 'R0';
  rules?: Ruleset;
  /** Opt-in R1-B growth layer (equipment, innate traits). Omit for a plain R0 session. */
  growth?: GrowthConfig;
};

export function msToTicks(rules: Ruleset, ms: number): number {
  return Math.max(1, Math.round(ms / rules.tickMs));
}

/** Contract §5.1: damage = round(baseDamage * (1 + step * (star - 1))). */
export function unitDamage(rules: Ruleset, major: Major, star: Star): number {
  return Math.round(rules.majors[major].damage * (1 + rules.starDamageStep * (star - 1)));
}

export function createSession(config: SessionConfig): GameState {
  if (config.ruleset !== 'R0') throw new Error(`Unsupported ruleset: ${String(config.ruleset)}`);
  if (!isValidSeed(config.seed)) throw new Error(`Invalid seed: ${String(config.seed)} (expected integer 0..4294967295)`);
  const validation = validateMapDefinition(config.map);
  if (!validation.ok) throw new MapValidationError(validation);
  const rules = config.rules ?? R0_RULES;
  const state: GameState = {
    tick: 0,
    phase: 'ready',
    paused: false,
    rngState: config.seed >>> 0,
    seed: config.seed,
    nextEntityId: 1,
    mapId: config.map.id,
    wave: 0,
    totalWaves: rules.waves.length,
    plannedSpawns: 0,
    spawned: 0,
    spawnCooldownTicks: 0,
    coin: rules.startingCoin,
    baseHp: rules.baseHp,
    maxBaseHp: rules.baseHp,
    units: [],
    enemies: [],
    selectedUnitId: null,
    kills: 0,
    leaks: 0,
    map: config.map,
    rules,
  };
  if (config.growth) {
    const owned = Array.isArray(config.growth.blueprints) ? config.growth.blueprints : [];
    state.growth = {
      blueprints: normalizeBlueprints(owned),
      traitRngState: traitStreamSeed(config.seed),
      nextItemId: 1,
      inventory: [],
    };
  }
  return state;
}

/** Sum of a unit's innate trait and equipped-item modifiers (zero outside growth sessions). */
export function unitMods(state: GameState, unit: Unit): StatMods {
  if (!state.growth) return NO_MODS;
  let mods = getTrait(unit.trait)?.mods ?? NO_MODS;
  const gear = getEquipment(unit.equipment?.blueprintId);
  if (gear?.mods) mods = addMods(mods, gear.mods);
  return mods;
}

/** Effective range (tiles) used for targeting. */
export function unitRange(state: GameState, unit: Unit): number {
  return state.rules.majors[unit.major].range + unitMods(state, unit).rangeCenti / 100;
}

function random(state: GameState): number {
  const r = nextRandom(state.rngState);
  state.rngState = r.state;
  return r.value;
}

function entityNumber(id: string): number {
  return Number(id.slice(1));
}

function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function unitAt(state: GameState, p: Point): Unit | undefined {
  return state.units.find((u) => samePoint(u.cell, p));
}

function emptyBuildableCells(state: GameState): Point[] {
  return buildableCells(state.map).filter((c) => !unitAt(state, c));
}

const ACTIVE_PHASES = new Set(['intermission', 'wave']);

function reject(reason: RejectReason): CommandResult {
  return { accepted: false, reason, events: [] };
}

/**
 * Applies one player command. Rejected commands never mutate the state
 * (units, coins, cooldowns and RNG stay identical).
 */
export function applyCommand(state: GameState, command: PlayerCommand): CommandResult {
  const events: DomainEvent[] = [];
  const ok = (): CommandResult => ({ accepted: true, events });

  switch (command.type) {
    case 'RESTART': {
      if (!isValidSeed(command.seed)) return reject('INVALID_STATE');
      const growth = state.growth ? { blueprints: state.growth.blueprints } : undefined;
      Object.assign(state, createSession({ map: state.map, seed: command.seed, ruleset: 'R0', rules: state.rules, growth }));
      return ok();
    }
    case 'PAUSE':
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      if (state.paused) return reject('INVALID_STATE');
      state.paused = true;
      state.selectedUnitId = null;
      return ok();
    case 'RESUME':
      if (!state.paused) return reject('INVALID_STATE');
      state.paused = false;
      return ok();
    default:
      break;
  }

  if (state.paused) return reject('PHASE_BLOCKED');

  switch (command.type) {
    case 'START_RUN':
      if (state.phase !== 'ready') return reject('PHASE_BLOCKED');
      state.phase = 'intermission';
      return ok();

    case 'START_WAVE': {
      if (state.phase !== 'intermission' || state.wave >= state.totalWaves) return reject('PHASE_BLOCKED');
      const wave = state.rules.waves[state.wave]!;
      state.wave += 1;
      state.phase = 'wave';
      state.plannedSpawns = wave.pattern.length;
      state.spawned = 0;
      state.spawnCooldownTicks = 0;
      events.push({ type: 'WAVE_STARTED', tick: state.tick, wave: state.wave });
      return ok();
    }

    case 'SUMMON': {
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      if (state.coin < state.rules.summonCost) return reject('NO_FUNDS');
      const empty = emptyBuildableCells(state);
      if (empty.length === 0) return reject('BOARD_FULL');
      // RNG consumption order is fixed: 1) major, 2) cell (row-major list of empty '.' cells).
      const majors = state.rules.majorOrder;
      const major = majors[Math.floor(random(state) * majors.length)]!;
      const cell = empty[Math.floor(random(state) * empty.length)]!;
      const unit: Unit = { id: `u${state.nextEntityId++}`, major, star: 1, cell: { ...cell }, cooldownTicks: 0 };
      if (state.growth) {
        // Separate stream: the gameplay RNG above is consumed exactly as in R0.
        const t = rollTrait(state.growth.traitRngState);
        state.growth.traitRngState = t.state;
        unit.trait = t.traitId;
        unit.equipment = null;
        unit.damageCarry = 0;
        unit.cooldownCarry = 0;
      }
      state.units.push(unit);
      state.coin -= state.rules.summonCost;
      events.push({ type: 'UNIT_SUMMONED', tick: state.tick, unitId: unit.id });
      return ok();
    }

    case 'SELECT_UNIT': {
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      if (!state.units.some((u) => u.id === command.unitId)) return reject('NO_UNIT');
      state.selectedUnitId = command.unitId;
      return ok();
    }

    case 'CANCEL_SELECTION':
      state.selectedUnitId = null;
      return ok();

    case 'DROP_UNIT': {
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      const unit = state.units.find((u) => u.id === command.unitId);
      if (!unit) return reject('NO_UNIT');
      const to = command.to;
      if (!to || !inBounds(state.map, to)) return reject('OUT_OF_BOUNDS');
      if (!isBuildable(state.map, to)) return reject('FORBIDDEN_TERRAIN');
      if (samePoint(unit.cell, to)) {
        state.selectedUnitId = null;
        return ok(); // dropping on its own cell: no-op success
      }
      const other = unitAt(state, to);
      if (!other) {
        unit.cell = { x: to.x, y: to.y };
        events.push({ type: 'UNIT_MOVED', tick: state.tick, unitId: unit.id });
      } else if (other.major === unit.major && other.star === unit.star) {
        if (other.star >= state.rules.maxStar) return reject('MAX_STAR');
        const growth = state.growth;
        let keptTrait = other.trait;
        if (growth && unit.trait !== other.trait) {
          // Rejected (state untouched) until the player picks which trait the result keeps.
          if (command.inherit !== 'target' && command.inherit !== 'source') return reject('CHOICE_REQUIRED');
          if (command.inherit === 'source') keptTrait = unit.trait;
        }
        // The target (to) unit survives with its id; the dragged unit is consumed.
        other.star = (other.star + 1) as Star;
        other.cooldownTicks = 0;
        state.units = state.units.filter((u) => u.id !== unit.id);
        events.push({ type: 'UNIT_MERGED', tick: state.tick, unitId: other.id, otherUnitId: unit.id });
        if (growth) {
          other.trait = keptTrait;
          other.cooldownCarry = 0;
          // The result keeps its own item; the material's item goes back to the run inventory.
          if (unit.equipment) {
            growth.inventory.push(unit.equipment);
            events.push({ type: 'EQUIPMENT_RETURNED', tick: state.tick, itemId: unit.equipment.id, unitId: unit.id });
          }
        }
      } else {
        const from = unit.cell;
        unit.cell = other.cell;
        other.cell = from;
        events.push({ type: 'UNIT_SWAPPED', tick: state.tick, unitId: unit.id, otherUnitId: other.id });
      }
      state.selectedUnitId = null;
      return ok();
    }

    case 'CRAFT_EQUIPMENT': {
      const growth = state.growth;
      if (!growth) return reject('GROWTH_DISABLED');
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      if (typeof command.blueprintId !== 'string' || !growth.blueprints.includes(command.blueprintId)) return reject('NOT_OWNED');
      const def = getEquipment(command.blueprintId);
      if (!def?.mods) return reject('UNSUPPORTED_OPTION');
      const cost = CRAFT_COST[def.rarity];
      if (state.coin < cost) return reject('NO_FUNDS');
      const item = { id: `g${growth.nextItemId++}`, blueprintId: def.id };
      growth.inventory.push(item);
      state.coin -= cost;
      events.push({ type: 'EQUIPMENT_CRAFTED', tick: state.tick, itemId: item.id });
      return ok();
    }

    case 'EQUIP': {
      const growth = state.growth;
      if (!growth) return reject('GROWTH_DISABLED');
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      const unit = state.units.find((u) => u.id === command.unitId);
      if (!unit) return reject('NO_UNIT');
      const index = growth.inventory.findIndex((i) => i.id === command.itemId);
      if (index < 0) return reject('NO_ITEM');
      const item = growth.inventory[index]!;
      const def = getEquipment(item.blueprintId);
      if (!def?.mods) return reject('UNSUPPORTED_OPTION');
      if (!canEquip(def, unit.major)) return reject('MAJOR_MISMATCH');
      growth.inventory.splice(index, 1);
      if (unit.equipment) {
        growth.inventory.push(unit.equipment);
        events.push({ type: 'EQUIPMENT_UNEQUIPPED', tick: state.tick, itemId: unit.equipment.id, unitId: unit.id });
      }
      unit.equipment = item;
      events.push({ type: 'EQUIPMENT_EQUIPPED', tick: state.tick, itemId: item.id, unitId: unit.id });
      return ok();
    }

    case 'UNEQUIP': {
      const growth = state.growth;
      if (!growth) return reject('GROWTH_DISABLED');
      if (!ACTIVE_PHASES.has(state.phase)) return reject('PHASE_BLOCKED');
      const unit = state.units.find((u) => u.id === command.unitId);
      if (!unit) return reject('NO_UNIT');
      if (!unit.equipment) return reject('NOT_EQUIPPED');
      const item = unit.equipment;
      growth.inventory.push(item);
      unit.equipment = null;
      events.push({ type: 'EQUIPMENT_UNEQUIPPED', tick: state.tick, itemId: item.id, unitId: unit.id });
      return ok();
    }
  }
  return reject('INVALID_STATE');
}

// ---------------------------------------------------------------------------
// Simulation

export function enemyWorldPosition(map: MapDefinition, enemy: Enemy): { x: number; y: number } {
  const path = map.paths[enemy.pathIndex]!;
  const a = path[enemy.segmentIndex]!;
  const b = path[Math.min(enemy.segmentIndex + 1, path.length - 1)]!;
  return { x: a.x + 0.5 + (b.x - a.x) * enemy.segmentT, y: a.y + 0.5 + (b.y - a.y) * enemy.segmentT };
}

/** Remaining path length (tiles) until the centre of B. */
export function remainingPath(map: MapDefinition, enemy: Enemy): number {
  const path = map.paths[enemy.pathIndex]!;
  return path.length - 1 - enemy.segmentIndex - enemy.segmentT;
}

function selectTarget(state: GameState, unit: Unit, range: number): Enemy | undefined {
  const cx = unit.cell.x + 0.5;
  const cy = unit.cell.y + 0.5;
  let best: Enemy | undefined;
  let bestRemaining = Infinity;
  for (const enemy of state.enemies) {
    const pos = enemyWorldPosition(state.map, enemy);
    if (Math.hypot(pos.x - cx, pos.y - cy) > range + 1e-9) continue;
    const rem = remainingPath(state.map, enemy);
    if (
      !best ||
      rem < bestRemaining - 1e-9 ||
      (Math.abs(rem - bestRemaining) <= 1e-9 &&
        (enemy.spawnOrder < best.spawnOrder ||
          (enemy.spawnOrder === best.spawnOrder && entityNumber(enemy.id) < entityNumber(best.id))))
    ) {
      best = enemy;
      bestRemaining = rem;
    }
  }
  return best;
}

function spawnEnemy(state: GameState, events: DomainEvent[]): void {
  const wave = state.rules.waves[state.wave - 1]!;
  const kindId = wave.pattern[state.spawned]!;
  const kind = state.rules.enemyKinds[kindId];
  if (!kind) throw new Error(`Unknown enemy kind in fixture: ${kindId}`);
  const hp = Math.round(kind.hp * wave.hpMultiplier);
  const enemy: Enemy = {
    id: `e${state.nextEntityId++}`,
    kind: kindId,
    pathIndex: 0, // R0 runtime uses plaza.paths[0] only (contract §3.1)
    segmentIndex: 0,
    segmentT: 0,
    hp,
    maxHp: hp,
    speedCellsPerSecond: kind.speedCellsPerSecond,
    baseDamage: kind.baseDamage,
    spawnOrder: state.spawned,
    exposedTicks: 0,
  };
  state.spawned += 1;
  state.enemies.push(enemy);
  events.push({ type: 'ENEMY_SPAWNED', tick: state.tick, enemyId: enemy.id });
}

/** Advances along the path; returns true when the enemy reaches the centre of B. */
function moveEnemy(state: GameState, enemy: Enemy): boolean {
  const path = state.map.paths[enemy.pathIndex]!;
  let dist = (enemy.speedCellsPerSecond * state.rules.tickMs) / 1000;
  while (dist > 0) {
    const left = 1 - enemy.segmentT;
    if (dist >= left - 1e-12) {
      dist -= left;
      enemy.segmentIndex += 1;
      enemy.segmentT = 0;
      if (enemy.segmentIndex >= path.length - 1) return true;
    } else {
      enemy.segmentT += dist;
      dist = 0;
    }
  }
  return false;
}

function stepOnce(state: GameState, events: DomainEvent[]): void {
  // Time is frozen before START_RUN, while paused and after the game ends.
  if (state.paused || state.phase === 'ready' || state.phase === 'victory' || state.phase === 'defeat') return;
  state.tick += 1;
  if (state.phase !== 'wave') return;
  const rules = state.rules;

  // 1) spawn
  if (state.spawned < state.plannedSpawns) {
    if (state.spawnCooldownTicks <= 0) {
      spawnEnemy(state, events);
      state.spawnCooldownTicks = msToTicks(rules, rules.waves[state.wave - 1]!.spawnIntervalMs);
    }
    state.spawnCooldownTicks -= 1;
  }

  // 2) unit attacks (hitscan, units in creation order), immediate damage/kill settlement
  for (const enemy of state.enemies) if (enemy.exposedTicks > 0) enemy.exposedTicks -= 1;
  for (const unit of state.units) {
    if (unit.cooldownTicks > 0) unit.cooldownTicks -= 1;
    if (unit.cooldownTicks > 0) continue;
    const rule = rules.majors[unit.major];
    const mods = unitMods(state, unit);
    const target = selectTarget(state, unit, rule.range + mods.rangeCenti / 100);
    if (!target) continue;
    let damage = unitDamage(rules, unit.major, unit.star);
    if (state.growth) {
      // Fixed-point bonus damage: a +8% on a 3-damage unit is not rounded away.
      const d = damageWithCarry(damage, mods.damagePct, unit.damageCarry ?? 0);
      damage = d.damage;
      unit.damageCarry = d.carry;
    }
    if (target.exposedTicks > 0) {
      const mult = rules.majors.humanities.effect?.damageTakenMultiplier ?? 1;
      damage = Math.round(damage * mult);
    }
    target.hp -= damage;
    if (state.growth) {
      const cd = cooldownWithCarry(rule.attackMs, rules.tickMs, mods.attackSpeedPct, unit.cooldownCarry ?? 0);
      unit.cooldownTicks = cd.ticks;
      unit.cooldownCarry = cd.carry;
    } else {
      unit.cooldownTicks = msToTicks(rules, rule.attackMs);
    }
    events.push({ type: 'ENEMY_DAMAGED', tick: state.tick, enemyId: target.id, unitId: unit.id, amount: damage });
    if (rule.effect?.type === 'expose') target.exposedTicks = msToTicks(rules, rule.effect.durationMs);
    if (target.hp <= 0) {
      state.enemies = state.enemies.filter((e) => e !== target);
      state.coin += rules.killReward;
      state.kills += 1;
      events.push({ type: 'ENEMY_KILLED', tick: state.tick, enemyId: target.id, unitId: unit.id, amount: rules.killReward });
    }
  }

  // 3) movement, 4) base arrival
  const arrived: Enemy[] = [];
  for (const enemy of state.enemies) if (moveEnemy(state, enemy)) arrived.push(enemy);
  if (arrived.length) {
    state.enemies = state.enemies.filter((e) => !arrived.includes(e));
    for (const enemy of arrived) {
      events.push({ type: 'ENEMY_REACHED_BASE', tick: state.tick, enemyId: enemy.id });
      const from = state.baseHp;
      state.baseHp = Math.max(0, state.baseHp - enemy.baseDamage);
      state.leaks += 1;
      if (from !== state.baseHp) events.push({ type: 'BASE_HP_CHANGED', tick: state.tick, from, to: state.baseHp });
    }
  }

  // 5) wave end / win / loss — defeat has priority over a cleared wave
  if (state.baseHp <= 0) {
    state.phase = 'defeat';
    state.selectedUnitId = null;
    events.push({ type: 'GAME_LOST', tick: state.tick, wave: state.wave });
    return;
  }
  if (state.spawned === state.plannedSpawns && state.enemies.length === 0) {
    events.push({ type: 'WAVE_CLEARED', tick: state.tick, wave: state.wave });
    state.coin += rules.waveClearBonus;
    if (state.wave >= state.totalWaves) {
      state.phase = 'victory';
      state.selectedUnitId = null;
      events.push({ type: 'GAME_WON', tick: state.tick, wave: state.wave });
    } else {
      state.phase = 'intermission';
    }
  }
}

/** Advances `fixedTicks` ticks and returns the domain events in processing order. */
export function stepWithEvents(state: GameState, fixedTicks: number): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (let i = 0; i < fixedTicks; i++) stepOnce(state, events);
  return events;
}

/** Contract API: step(state, fixedTicks) — 1 tick = 50 ms. Mutates and returns the state. */
export function step(state: GameState, fixedTicks: number): GameState {
  stepWithEvents(state, fixedTicks);
  return state;
}

export function getSnapshot(state: GameState): RenderSnapshot {
  const rules = state.rules;
  const units: UnitView[] = state.units.map((u) => {
    const view: UnitView = {
      ...u,
      cell: { ...u.cell },
      range: rules.majors[u.major].range,
      damage: unitDamage(rules, u.major, u.star),
      attackTicks: msToTicks(rules, rules.majors[u.major].attackMs),
    };
    if (state.growth) {
      const mods = unitMods(state, u);
      if (u.equipment) view.equipment = { ...u.equipment };
      view.range = unitRange(state, u);
      view.damage = (view.damage * (100 + mods.damagePct)) / 100;
      view.attackTicks = (rules.majors[u.major].attackMs * 100) / (100 + mods.attackSpeedPct) / rules.tickMs;
    }
    return view;
  });
  const enemies: EnemyView[] = state.enemies.map((e) => {
    const pos = enemyWorldPosition(state.map, e);
    return {
      id: e.id,
      kind: e.kind,
      x: pos.x,
      y: pos.y,
      hp: e.hp,
      maxHp: e.maxHp,
      remaining: remainingPath(state.map, e),
      exposed: e.exposedTicks > 0,
      spawnOrder: e.spawnOrder,
    };
  });
  return {
    tick: state.tick,
    phase: state.phase,
    paused: state.paused,
    seed: state.seed,
    mapId: state.mapId,
    wave: state.wave,
    totalWaves: state.totalWaves,
    plannedSpawns: state.plannedSpawns,
    spawned: state.spawned,
    coin: state.coin,
    baseHp: state.baseHp,
    maxBaseHp: state.maxBaseHp,
    summonCost: rules.summonCost,
    canSummon:
      !state.paused &&
      ACTIVE_PHASES.has(state.phase) &&
      state.coin >= rules.summonCost &&
      emptyBuildableCells(state).length > 0,
    kills: state.kills,
    leaks: state.leaks,
    selectedUnitId: state.selectedUnitId,
    units,
    enemies,
    ...(state.growth
      ? { growth: { blueprints: [...state.growth.blueprints], inventory: state.growth.inventory.map((i) => ({ ...i })) } }
      : {}),
  };
}

/** Logical state without the static map/rules payload — used for determinism comparisons. */
export function logicalState(state: GameState): Omit<GameState, 'map' | 'rules'> {
  const { map: _map, rules: _rules, ...rest } = state;
  return structuredClone(rest);
}
