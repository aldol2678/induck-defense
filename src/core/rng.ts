// Contract R0.1 §6: single gameplay RNG source, mulberry32 reference algorithm.

export const MAX_SEED = 4294967295;

export function nextRandom(state: number): { state: number; value: number } {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: a, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** Seeds must be unsigned 32-bit integers; strings, negatives and NaN are rejected. */
export function isValidSeed(seed: unknown): seed is number {
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED;
}
