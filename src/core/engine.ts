// INDUCK-R0-001 R0.1 headless battle engine.
// Fixed 50 ms ticks, seeded mulberry32, atomic commands. See docs/implementation-plan.md.
import r0Rules from '../../fixtures/r0/ruleset.json' with { type: 'json' };
import { buildableCells, inBounds, isBuildable, MapValidationError, validateMapDefinition } from './mapValidation';
import { isValidSeed, nextRandom } from './rng';
import type {
  CommandResult,
  DomainEvent,
  Enemy,
  EnemyView,
  GameState,
  Major,
  MapDefinition,
  PlayerCommand,
  Point,
  RejectReason,
  RenderSnapshot,
  Ruleset,
  Star,
  Unit,
  UnitView,
} from './types';

export const R0_RULES = r0Rules as Ruleset;

export type SessionConfig = { map: MapDefinition; seed: number; ruleset: 'R0'; rules?: Ruleset };

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
  return {
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
      Object.assign(state, createSession({ map: state.map, seed: command.seed, ruleset: 'R0', rules: state.rules }));
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
        // The target (to) unit survives with its id; the dragged unit is consumed.
        other.star = (other.star + 1) as Star;
        other.cooldownTicks = 0;
        state.units = state.units.filter((u) => u.id !== unit.id);
        events.push({ type: 'UNIT_MERGED', tick: state.tick, unitId: other.id, otherUnitId: unit.id });
      } else {
        const from = unit.cell;
        unit.cell = other.cell;
        other.cell = from;
        events.push({ type: 'UNIT_SWAPPED', tick: state.tick, unitId: unit.id, otherUnitId: other.id });
      }
      state.selectedUnitId = null;
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
    const target = selectTarget(state, unit, rule.range);
    if (!target) continue;
    let damage = unitDamage(rules, unit.major, unit.star);
    if (target.exposedTicks > 0) {
      const mult = rules.majors.humanities.effect?.damageTakenMultiplier ?? 1;
      damage = Math.round(damage * mult);
    }
    target.hp -= damage;
    unit.cooldownTicks = msToTicks(rules, rule.attackMs);
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
  const units: UnitView[] = state.units.map((u) => ({
    ...u,
    cell: { ...u.cell },
    range: rules.majors[u.major].range,
    damage: unitDamage(rules, u.major, u.star),
    attackTicks: msToTicks(rules, rules.majors[u.major].attackMs),
  }));
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
  };
}

/** Logical state without the static map/rules payload — used for determinism comparisons. */
export function logicalState(state: GameState): Omit<GameState, 'map' | 'rules'> {
  const { map: _map, rules: _rules, ...rest } = state;
  return structuredClone(rest);
}
