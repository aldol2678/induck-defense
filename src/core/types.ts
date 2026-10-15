// INDUCK-R0-001 contract R0.1 §3–§4 types. The core is pure TypeScript:
// no DOM, no Phaser, no wall clock. UI reads RenderSnapshot and sends PlayerCommand.

export type Cell = '.' | '=' | 'S' | 'B' | '~' | 'X';
export type Point = { x: number; y: number }; // 0-based, x = column, y = row

export type MapDefinition = {
  id: string;
  name: string;
  grid: string[];
  goal: string;
  phase: string;
  width: number;
  height: number;
  paths: Point[][];
};

export type MapCatalog = { version: 'R0'; maps: MapDefinition[] };

export type ValidationErrorCode =
  | 'MAP_NOT_FOUND'
  | 'GRID_DIMENSION'
  | 'UNKNOWN_TILE'
  | 'PATH_EMPTY'
  | 'PATH_OOB'
  | 'PATH_INVALID_TILE'
  | 'PATH_NON_ADJACENT'
  | 'PATH_DUPLICATE'
  | 'PATH_REVISIT'
  | 'START_NOT_S'
  | 'END_NOT_B'
  | 'SPAWN_UNCOVERED'
  | 'GOAL_MISMATCH';

export type ValidationError = {
  code: ValidationErrorCode;
  mapId: string;
  pathIndex?: number;
  at?: Point;
};

export type ValidationResult = { ok: boolean; errors: ValidationError[] };

export type Major = 'engineering' | 'sports' | 'humanities';
export type Star = 1 | 2 | 3 | 4;

export type Unit = {
  id: string;
  major: Major;
  star: Star;
  cell: Point;
  cooldownTicks: number;
  // R1-B growth fields — present only in growth sessions (plain R0 units stay byte-identical).
  /** Innate trait id (src/core/growth.ts TRAITS). */
  trait?: string;
  /** The unit's single equipment slot. */
  equipment?: EquipmentItem | null;
  /** Fractional damage carry in 1/100 damage units. */
  damageCarry?: number;
  /** Fractional cooldown carry in 1/100 ticks. */
  cooldownCarry?: number;
};

export type TraitTier = 'normal' | 'rare' | 'epic' | 'legend';

/** Integer stat modifiers: percent for damage / attack speed, 1/100 tile for range. */
export type StatMods = { damagePct: number; attackSpeedPct: number; rangeCenti: number };

/** An in-run crafted item. `blueprintId` is a Gacha Lab equipment id (eq-…). */
export type EquipmentItem = { id: string; blueprintId: string };

/** Run-start growth snapshot. Owned blueprints are fixed for the whole run (and restarts). */
export type GrowthConfig = { blueprints: string[] };

export type GrowthState = {
  blueprints: string[];
  /** Separate mulberry32 stream for innate traits; the R0 gameplay stream is untouched. */
  traitRngState: number;
  nextItemId: number;
  /** Crafted items that are not equipped. */
  inventory: EquipmentItem[];
};

export type Enemy = {
  id: string;
  kind: string;
  pathIndex: number;
  segmentIndex: number;
  segmentT: number;
  hp: number;
  maxHp: number;
  speedCellsPerSecond: number;
  baseDamage: number;
  spawnOrder: number;
  /** Remaining ticks of the humanities "expose" debuff (0 = none). */
  exposedTicks: number;
};

export type Phase = 'ready' | 'wave' | 'intermission' | 'victory' | 'defeat';

export type MajorRule = {
  label: string;
  role: string;
  range: number;
  damage: number;
  attackMs: number;
  effect: null | { type: 'expose'; damageTakenMultiplier: number; durationMs: number };
};

export type EnemyKindRule = {
  label: string;
  hp: number;
  speedCellsPerSecond: number;
  baseDamage: number;
};

export type WaveRule = {
  /** Enemy kinds spawned in order; the wave's planned spawns = pattern length. */
  pattern: string[];
  spawnIntervalMs: number;
  hpMultiplier: number;
};

export type Ruleset = {
  ruleset: 'R0';
  tickMs: number;
  summonCost: number;
  startingCoin: number;
  baseHp: number;
  killReward: number;
  waveClearBonus: number;
  maxStar: Star;
  starDamageStep: number;
  majorOrder: Major[];
  majors: Record<Major, MajorRule>;
  enemyKinds: Record<string, EnemyKindRule>;
  waves: WaveRule[];
};

export type GameState = {
  tick: number;
  phase: Phase;
  paused: boolean;
  rngState: number;
  seed: number;
  nextEntityId: number;
  mapId: string;
  wave: number;
  totalWaves: number;
  plannedSpawns: number;
  spawned: number;
  spawnCooldownTicks: number;
  coin: number;
  baseHp: number;
  maxBaseHp: number;
  units: Unit[];
  enemies: Enemy[];
  selectedUnitId: string | null;
  kills: number;
  leaks: number;
  /** Map and rules travel with the state so a serialized state is self-contained. */
  map: MapDefinition;
  rules: Ruleset;
  /** R1-B growth layer. Absent in plain R0 sessions. */
  growth?: GrowthState;
};

export type PlayerCommand =
  | { type: 'START_RUN' }
  | { type: 'START_WAVE' }
  | { type: 'SUMMON' }
  | {
      type: 'DROP_UNIT';
      unitId: string;
      to: Point;
      /** Growth sessions: which trait the merge result keeps when the two differ. */
      inherit?: 'target' | 'source';
    }
  | { type: 'SELECT_UNIT'; unitId: string }
  | { type: 'CANCEL_SELECTION' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'RESTART'; seed: number }
  | { type: 'CRAFT_EQUIPMENT'; blueprintId: string }
  | { type: 'EQUIP'; unitId: string; itemId: string }
  | { type: 'UNEQUIP'; unitId: string };

export type RejectReason =
  | 'OUT_OF_BOUNDS'
  | 'FORBIDDEN_TERRAIN'
  | 'NO_UNIT'
  | 'NO_FUNDS'
  | 'BOARD_FULL'
  | 'PHASE_BLOCKED'
  | 'MAX_STAR'
  | 'INVALID_STATE'
  | 'GROWTH_DISABLED'
  | 'NOT_OWNED'
  | 'UNSUPPORTED_OPTION'
  | 'NO_ITEM'
  | 'NOT_EQUIPPED'
  | 'MAJOR_MISMATCH'
  | 'CHOICE_REQUIRED';

export type DomainEvent =
  | {
      type: 'UNIT_SUMMONED' | 'UNIT_MOVED' | 'UNIT_SWAPPED' | 'UNIT_MERGED';
      tick: number;
      unitId: string;
      /** Swap partner, or the dragged unit consumed by a merge. */
      otherUnitId?: string;
    }
  | {
      type: 'ENEMY_SPAWNED' | 'ENEMY_DAMAGED' | 'ENEMY_KILLED' | 'ENEMY_REACHED_BASE';
      tick: number;
      enemyId: string;
      /** Attacker for ENEMY_DAMAGED / ENEMY_KILLED. */
      unitId?: string;
      amount?: number;
    }
  | { type: 'BASE_HP_CHANGED'; tick: number; from: number; to: number }
  | { type: 'WAVE_STARTED' | 'WAVE_CLEARED' | 'GAME_WON' | 'GAME_LOST'; tick: number; wave: number }
  | {
      type: 'EQUIPMENT_CRAFTED' | 'EQUIPMENT_EQUIPPED' | 'EQUIPMENT_UNEQUIPPED' | 'EQUIPMENT_RETURNED';
      tick: number;
      itemId: string;
      /** Unit the item was put on / taken from (RETURNED: the merge material). */
      unitId?: string;
    };

export type CommandResult = {
  accepted: boolean;
  reason?: RejectReason;
  events: DomainEvent[];
};

/** range / damage / attackTicks are effective values (growth modifiers applied; may be fractional). */
export type UnitView = Unit & { range: number; damage: number; attackTicks: number };

export type GrowthView = { blueprints: string[]; inventory: EquipmentItem[] };

export type EnemyView = {
  id: string;
  kind: string;
  x: number; // world coordinates, tile centre = (col + 0.5, row + 0.5)
  y: number;
  hp: number;
  maxHp: number;
  remaining: number; // remaining path length in tiles
  exposed: boolean;
  spawnOrder: number;
};

export type RenderSnapshot = {
  tick: number;
  phase: Phase;
  paused: boolean;
  seed: number;
  mapId: string;
  wave: number;
  totalWaves: number;
  plannedSpawns: number;
  spawned: number;
  coin: number;
  baseHp: number;
  maxBaseHp: number;
  summonCost: number;
  canSummon: boolean;
  kills: number;
  leaks: number;
  selectedUnitId: string | null;
  units: UnitView[];
  enemies: EnemyView[];
  growth?: GrowthView;
};
