import catalogJson from '../data/maps/induck_defense_map_samples_R0.json' with { type: 'json' };
import type { MapCatalog, MapDefinition } from './types';

/** Contract input snapshot (byte SHA-256 is asserted in tests/core/mapValidation.test.ts). */
export const MAP_CATALOG_SHA256 = '7e79062e2fe0abeb546a6dc25a7caa71c8a44467d5237bafd8371e9f8195a99b';
export const MAP_CATALOG = catalogJson as MapCatalog;

/** R0 runtime map. lake/building5 are data-validated only (R1 scope). */
export const R0_MAP_ID = 'plaza';

export function getMap(mapId: string): MapDefinition {
  const map = MAP_CATALOG.maps.find((m) => m.id === mapId);
  if (!map) throw new Error(`Map not found: ${mapId}`);
  return map;
}
