// Real-time driver for the fixed-tick core. Owns the replay log; no DOM / Phaser.
import { MAP_CATALOG_SHA256 } from './catalog';
import { applyCommand, createSession, enemyWorldPosition, getSnapshot, stepWithEvents } from './engine';
import type { ReplayEntry, ReplayLog } from './replay';
import type { CommandResult, DomainEvent, GameState, GrowthConfig, MapDefinition, PlayerCommand, RenderSnapshot } from './types';

export type EventListener = (events: DomainEvent[], snapshot: RenderSnapshot) => void;

const MAX_CATCH_UP_TICKS = 8;

export class GameController {
  state: GameState;
  private log: ReplayEntry[] = [];
  private accumulatorMs = 0;
  private listeners = new Set<EventListener>();
  /** Enemy positions at the previous tick, used only for render interpolation. */
  private prevPositions = new Map<string, { x: number; y: number }>();

  constructor(
    private readonly map: MapDefinition,
    seed: number,
    growth?: GrowthConfig,
  ) {
    this.state = createSession({ map, seed, ruleset: 'R0', growth });
  }

  onEvents(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(events: DomainEvent[]): void {
    if (!events.length) return;
    const snap = getSnapshot(this.state);
    for (const l of this.listeners) l(events, snap);
  }

  dispatch(command: PlayerCommand): CommandResult {
    if (command.type === 'RESTART') {
      // A restart starts a fresh replay segment (tick resets to 0).
      const result = applyCommand(this.state, command);
      if (result.accepted) {
        this.log = [];
        this.accumulatorMs = 0;
        this.prevPositions.clear();
      }
      this.emit(result.events);
      return result;
    }
    this.log.push({ tick: this.state.tick, command: structuredClone(command) });
    const result = applyCommand(this.state, command);
    this.emit(result.events);
    return result;
  }

  /** Feeds wall-clock time; simulation only ever advances in whole 50 ms ticks. */
  advance(deltaMs: number): void {
    const tickMs = this.state.rules.tickMs;
    this.accumulatorMs += Math.max(0, Math.min(deltaMs, 250));
    let ticks = Math.floor(this.accumulatorMs / tickMs);
    if (ticks > MAX_CATCH_UP_TICKS) {
      ticks = MAX_CATCH_UP_TICKS;
      this.accumulatorMs = ticks * tickMs;
    }
    this.accumulatorMs -= ticks * tickMs;
    if (ticks > 0) this.stepTicks(ticks);
  }

  stepTicks(ticks: number): void {
    const events: DomainEvent[] = [];
    for (let i = 0; i < ticks; i++) {
      this.prevPositions.clear();
      for (const e of this.state.enemies) this.prevPositions.set(e.id, enemyWorldPosition(this.map, e));
      events.push(...stepWithEvents(this.state, 1));
    }
    this.emit(events);
  }

  /** 0..1 progress into the current tick, for render interpolation only. */
  get alpha(): number {
    if (this.state.paused || this.state.phase !== 'wave') return 1;
    return Math.min(1, this.accumulatorMs / this.state.rules.tickMs);
  }

  previousPosition(enemyId: string): { x: number; y: number } | undefined {
    return this.prevPositions.get(enemyId);
  }

  getSnapshot(): RenderSnapshot {
    return getSnapshot(this.state);
  }

  exportReplay(): ReplayLog {
    return {
      format: 'induck-replay/1',
      ruleset: 'R0',
      mapId: this.map.id,
      mapSha256: MAP_CATALOG_SHA256,
      seed: this.state.seed,
      entries: structuredClone(this.log),
      totalTicks: this.state.tick,
      ...(this.state.growth ? { growth: { blueprints: [...this.state.growth.blueprints] } } : {}),
    };
  }
}
