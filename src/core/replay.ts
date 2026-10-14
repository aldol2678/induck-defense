// Contract R0.1 §6: replay log = seed + timestamped commands + map hash + ruleset version.
import { applyCommand, createSession, logicalState, stepWithEvents } from './engine';
import type { CommandResult, DomainEvent, GameState, MapDefinition, PlayerCommand, Ruleset } from './types';

export type ReplayEntry = { tick: number; command: PlayerCommand };

export type ReplayLog = {
  format: 'induck-replay/1';
  ruleset: 'R0';
  mapId: string;
  mapSha256: string;
  seed: number;
  /** Commands are applied before the tick with number `tick + 1` is simulated. */
  entries: ReplayEntry[];
  totalTicks: number;
};

export type ReplayResult = {
  state: GameState;
  events: DomainEvent[];
  results: CommandResult[];
};

export function runReplay(map: MapDefinition, log: ReplayLog, rules?: Ruleset): ReplayResult {
  const state = createSession({ map, seed: log.seed, ruleset: log.ruleset, rules });
  // Stable sort by tick keeps the input-queue order of commands sharing a tick.
  const entries = log.entries.map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || a.i - b.i);
  const events: DomainEvent[] = [];
  const results: CommandResult[] = [];
  let i = 0;
  for (;;) {
    while (i < entries.length && entries[i]!.tick <= state.tick) {
      const r = applyCommand(state, entries[i]!.command);
      results.push(r);
      events.push(...r.events);
      i++;
    }
    if (state.tick >= log.totalTicks) break;
    const before = state.tick;
    events.push(...stepWithEvents(state, 1));
    if (state.tick === before) {
      // Paused or finished: time is frozen. Only further commands can unfreeze it.
      if (i >= entries.length) break;
      const next = entries[i]!;
      if (next.tick > state.tick) {
        // Commands logged while frozen carry the frozen tick; anything later is unreachable.
        break;
      }
    }
  }
  return { state, events, results };
}

/** Serializable fingerprint of a replay outcome for equality checks. */
export function replayFingerprint(r: ReplayResult): string {
  return JSON.stringify({ state: logicalState(r.state), events: r.events, results: r.results });
}
