// Contract R0.1 §3.1/§3.3: map validation. Broken maps fail loudly; the engine never
// invents a road or lets enemies cross water or walls.
import type { Cell, MapCatalog, MapDefinition, Point, ValidationError, ValidationResult } from './types';

const KNOWN_TILES: ReadonlySet<string> = new Set<Cell>(['.', '=', 'S', 'B', '~', 'X']);
const PATH_TILES: ReadonlySet<string> = new Set<Cell>(['S', '=', 'B']);

export function tileAt(map: MapDefinition, p: Point): string | undefined {
  return map.grid[p.y]?.[p.x];
}

export function inBounds(map: MapDefinition, p: Point): boolean {
  return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < map.width && p.y < map.height;
}

export function isBuildable(map: MapDefinition, p: Point): boolean {
  return inBounds(map, p) && tileAt(map, p) === '.';
}

/** All '.' cells in row-major order (y, then x) — the explicit order RNG picks from. */
export function buildableCells(map: MapDefinition): Point[] {
  const cells: Point[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) if (map.grid[y]?.[x] === '.') cells.push({ x, y });
  }
  return cells;
}

function findTiles(map: MapDefinition, tile: Cell): Point[] {
  const out: Point[] = [];
  map.grid.forEach((row, y) => [...row].forEach((c, x) => c === tile && out.push({ x, y })));
  return out;
}

export function validateMapDefinition(map: MapDefinition): ValidationResult {
  const errors: ValidationError[] = [];
  const mapId = map.id;

  const dimsOk =
    Number.isInteger(map.width) &&
    Number.isInteger(map.height) &&
    map.width > 0 &&
    map.height > 0 &&
    Array.isArray(map.grid) &&
    map.grid.length === map.height &&
    map.grid.every((row) => typeof row === 'string' && [...row].length === map.width);
  if (!dimsOk) {
    errors.push({ code: 'GRID_DIMENSION', mapId });
    return { ok: false, errors };
  }

  map.grid.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (!KNOWN_TILES.has(c)) errors.push({ code: 'UNKNOWN_TILE', mapId, at: { x, y } });
    }),
  );

  const bases = findTiles(map, 'B');
  if (bases.length !== 1) errors.push({ code: 'GOAL_MISMATCH', mapId });
  const base = bases[0];

  const paths = Array.isArray(map.paths) ? map.paths : [];
  if (paths.length === 0) errors.push({ code: 'PATH_EMPTY', mapId });

  paths.forEach((path, pathIndex) => {
    if (!Array.isArray(path) || path.length < 2) {
      errors.push({ code: 'PATH_EMPTY', mapId, pathIndex });
      return;
    }
    path.forEach((p, i) => {
      if (!inBounds(map, p)) {
        errors.push({ code: 'PATH_OOB', mapId, pathIndex, at: p });
        return;
      }
      if (!PATH_TILES.has(tileAt(map, p)!)) errors.push({ code: 'PATH_INVALID_TILE', mapId, pathIndex, at: p });
      if (i > 0) {
        const q = path[i - 1]!;
        if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) !== 1) {
          errors.push({ code: 'PATH_NON_ADJACENT', mapId, pathIndex, at: p });
        }
      }
    });
    const first = path[0]!;
    const last = path[path.length - 1]!;
    if (!inBounds(map, first) || tileAt(map, first) !== 'S') errors.push({ code: 'START_NOT_S', mapId, pathIndex, at: first });
    if (!inBounds(map, last) || tileAt(map, last) !== 'B') errors.push({ code: 'END_NOT_B', mapId, pathIndex, at: last });
    else if (base && (last.x !== base.x || last.y !== base.y)) errors.push({ code: 'GOAL_MISMATCH', mapId, pathIndex, at: last });
  });

  for (const s of findTiles(map, 'S')) {
    const covered = paths.some((p) => Array.isArray(p) && p[0] && p[0].x === s.x && p[0].y === s.y);
    if (!covered) errors.push({ code: 'SPAWN_UNCOVERED', mapId, at: s });
  }

  return { ok: errors.length === 0, errors };
}

export function validateMap(catalog: MapCatalog, mapId: string): ValidationResult {
  const map = catalog.maps.find((m) => m.id === mapId);
  if (!map) return { ok: false, errors: [{ code: 'MAP_NOT_FOUND', mapId }] };
  return validateMapDefinition(map);
}

export class MapValidationError extends Error {
  constructor(public readonly result: ValidationResult) {
    super(`Map validation failed: ${result.errors.map((e) => e.code).join(', ')}`);
    this.name = 'MapValidationError';
  }
}
