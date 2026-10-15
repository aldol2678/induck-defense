// INDUCK-GROWTH-INTEGRATION-R1 · R1-B in-run growth layer (opt-in, test values).
// Pure data + helpers. The R0 engine only consults this when a session is created
// with a `growth` config; plain R0 sessions never touch it.
import { nextRandom } from './rng';
import type { Major, StatMods, TraitTier } from './types';

export const NO_MODS: StatMods = { damagePct: 0, attackSpeedPct: 0, rangeCenti: 0 };

export function addMods(a: StatMods, b: StatMods): StatMods {
  return {
    damagePct: a.damagePct + b.damagePct,
    attackSpeedPct: a.attackSpeedPct + b.attackSpeedPct,
    rangeCenti: a.rangeCenti + b.rangeCenti,
  };
}

// ---------------------------------------------------------------------------
// Innate traits

/** Tier weights out of 100 — NOT approved balance (70/22/7/1 test values). */
export const TRAIT_TIER_WEIGHTS: ReadonlyArray<readonly [TraitTier, number]> = [
  ['normal', 70],
  ['rare', 22],
  ['epic', 7],
  ['legend', 1],
];

export type TraitDef = { id: string; tier: TraitTier; label: string; desc: string; mods: StatMods };

const trait = (id: string, tier: TraitTier, label: string, desc: string, mods: Partial<StatMods>): TraitDef => ({
  id,
  tier,
  label,
  desc,
  mods: { ...NO_MODS, ...mods },
});

/** Order inside a tier is part of the replay contract (index = second trait-RNG draw). */
export const TRAITS: readonly TraitDef[] = [
  trait('diligent', 'normal', '성실한', '공격력 +4%', { damagePct: 4 }),
  trait('quick', 'normal', '재빠른', '공격속도 +4%', { attackSpeedPct: 4 }),
  trait('attentive', 'normal', '꼼꼼한', '사거리 +0.1칸', { rangeCenti: 10 }),
  trait('passionate', 'rare', '열정적인', '공격력 +8%', { damagePct: 8 }),
  trait('agile', 'rare', '민첩한', '공격속도 +8%', { attackSpeedPct: 8 }),
  trait('farsighted', 'rare', '시야가 넓은', '사거리 +0.2칸', { rangeCenti: 20 }),
  trait('ace', 'epic', '에이스', '공격력 +12% · 공격속도 +5%', { damagePct: 12, attackSpeedPct: 5 }),
  trait('strategist', 'epic', '전략가', '사거리 +0.3칸 · 공격력 +5%', { rangeCenti: 30, damagePct: 5 }),
  trait('prodigy', 'legend', '천재', '공격력 +15% · 공격속도 +10% · 사거리 +0.2칸', {
    damagePct: 15,
    attackSpeedPct: 10,
    rangeCenti: 20,
  }),
];

export const TRAIT_TIER_LABEL: Record<TraitTier, string> = { normal: '일반', rare: '희귀', epic: '영웅', legend: '전설' };

const TRAIT_BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

export function getTrait(id: string | null | undefined): TraitDef | undefined {
  return id ? TRAIT_BY_ID.get(id) : undefined;
}

/** Trait stream seed: independent of the R0 gameplay stream so summon majors/cells are unchanged. */
export function traitStreamSeed(seed: number): number {
  return (Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ 0x27d4eb2f) >>> 0;
}

export function tierFromRoll(value: number): TraitTier {
  let acc = 0;
  const pick = value * 100;
  for (const [tier, weight] of TRAIT_TIER_WEIGHTS) {
    acc += weight;
    if (pick < acc) return tier;
  }
  return TRAIT_TIER_WEIGHTS[TRAIT_TIER_WEIGHTS.length - 1]![0];
}

/** Always consumes exactly two draws from the trait stream: 1) tier, 2) trait within tier. */
export function rollTrait(rngState: number): { state: number; traitId: string } {
  const a = nextRandom(rngState);
  const tier = tierFromRoll(a.value);
  const b = nextRandom(a.state);
  const pool = TRAITS.filter((t) => t.tier === tier);
  return { state: b.state, traitId: pool[Math.floor(b.value * pool.length)]!.id };
}

// ---------------------------------------------------------------------------
// Equipment (mirrors the Gacha Lab v0.4.1 blueprint list in public/gacha.html)

export type Rarity = 'normal' | 'rare' | 'epic' | 'legend';
export type UnsupportedKind = 'skill' | 'status' | 'conditional' | 'economy' | 'support';

export const UNSUPPORTED_LABEL: Record<UnsupportedKind, string> = {
  skill: '스킬형 효과',
  status: '상태이상 효과',
  conditional: '조건부 효과',
  economy: '경제 효과',
  support: '지원·오라 효과',
};

export type EquipmentDef = {
  id: string;
  name: string;
  emoji: string;
  rarity: Rarity;
  major: Major | 'shared';
  desc: string;
  /** Present when the option is implemented in real combat (damage / attack speed / range only). */
  mods: StatMods | null;
  unsupported: UnsupportedKind | null;
};

const eq = (
  id: string,
  name: string,
  rarity: Rarity,
  major: Major | 'shared',
  emoji: string,
  desc: string,
  effect: Partial<StatMods> | UnsupportedKind,
): EquipmentDef => ({
  id: 'eq-' + id,
  name,
  emoji,
  rarity,
  major,
  desc,
  mods: typeof effect === 'string' ? null : { ...NO_MODS, ...effect },
  unsupported: typeof effect === 'string' ? effect : null,
});

export const EQUIPMENT: readonly EquipmentDef[] = [
  eq('eng-basic', '규격 드라이버', 'normal', 'engineering', '🔧', '공대 공격력 +8%', { damagePct: 8 }),
  eq('eng-rare', '정밀 렌즈', 'rare', 'engineering', '🔭', '공대 사거리 +0.25칸', { rangeCenti: 25 }),
  eq('eng-epic', '병렬 연산 칩', 'epic', 'engineering', '💠', '5번째 공격마다 추가 타격', 'skill'),
  eq('eng-leg', '자율 연구 코어', 'legend', 'engineering', '🤖', '주기적으로 두 번째 적 자동 공격', 'skill'),
  eq('sport-basic', '근력 보호대', 'normal', 'sports', '🥊', '체대 공격력 +8%', { damagePct: 8 }),
  eq('sport-rare', '초경량 운동화', 'rare', 'sports', '👟', '체대 공격속도 +12%', { attackSpeedPct: 12 }),
  eq('sport-epic', '충격 흡수 장갑', 'epic', 'sports', '🧤', '일정 공격마다 적 둔화', 'status'),
  eq('sport-leg', '불굴의 메달', 'legend', 'sports', '🏅', '본부 HP가 낮을 때 공격력 증가', 'conditional'),
  eq('human-basic', '형광펜', 'normal', 'humanities', '🖍️', '약점 노출 지속시간 증가', 'status'),
  eq('human-rare', '논리 분석 노트', 'rare', 'humanities', '📖', '약점 대상 추가 피해', 'conditional'),
  eq('human-epic', '토론 마이크', 'epic', 'humanities', '🎙️', '인접 다른 전공 지원', 'support'),
  eq('human-leg', '결정적 논증서', 'legend', 'humanities', '📜', '약점 적 처치 시 효과 전파', 'skill'),
  eq('shared-basic1', '튼튼한 필통', 'normal', 'shared', '🖊️', '모든 전공 공격력 +6%', { damagePct: 6 }),
  eq('shared-basic2', '사거리 측정 도구', 'normal', 'shared', '📏', '모든 전공 사거리 +0.15칸', { rangeCenti: 15 }),
  eq('shared-rare1', '학생증 목걸이', 'rare', 'shared', '🪪', '처치 시 전투 코인 추가 획득', 'economy'),
  eq('shared-rare2', '스터디 타이머', 'rare', 'shared', '⏱️', '웨이브 시작 직후 공격속도 증가', 'conditional'),
  eq('shared-epic', '학술 네트워크', 'epic', 'shared', '🔗', '다른 전공과 인접 시 피해 증가', 'support'),
  eq('shared-leg', '야간 연구등', 'legend', 'shared', '🏮', '주변 적에게 주기적 추가 피해', 'skill'),
];

/** In-run crafting cost in battle coins (test values). */
export const CRAFT_COST: Record<Rarity, number> = { normal: 30, rare: 45, epic: 60, legend: 80 };

const EQUIPMENT_BY_ID = new Map(EQUIPMENT.map((e) => [e.id, e]));

export function getEquipment(id: string | null | undefined): EquipmentDef | undefined {
  return id ? EQUIPMENT_BY_ID.get(id) : undefined;
}

export function canEquip(def: EquipmentDef, major: Major): boolean {
  return def.major === 'shared' || def.major === major;
}

/** Canonical blueprint snapshot: known ids only, deduped, catalog order. */
export function normalizeBlueprints(ids: readonly unknown[]): string[] {
  const owned = new Set(ids.filter((x): x is string => typeof x === 'string'));
  return EQUIPMENT.filter((e) => owned.has(e.id)).map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Fixed-point combat helpers (no float accumulation, no rounding loss)

/**
 * Damage with a fractional carry kept in 1/100 units. With 0% bonus and 0 carry
 * the result equals `baseDamage` exactly (R0 parity).
 */
export function damageWithCarry(baseDamage: number, damagePct: number, carry: number): { damage: number; carry: number } {
  const total = baseDamage * (100 + damagePct) + carry;
  const damage = Math.floor(total / 100);
  return { damage, carry: total - damage * 100 };
}

/**
 * Attack cooldown in whole ticks with a 1/100-tick carry. For R0 attack periods
 * (multiples of the tick) and 0% bonus this equals msToTicks exactly.
 */
export function cooldownWithCarry(
  attackMs: number,
  tickMs: number,
  attackSpeedPct: number,
  carry: number,
): { ticks: number; carry: number } {
  const centiTicks = Math.floor((attackMs * 10000) / (tickMs * (100 + attackSpeedPct)));
  const total = centiTicks + carry;
  const ticks = Math.floor(total / 100);
  return { ticks: Math.max(1, ticks), carry: ticks >= 1 ? total - ticks * 100 : 0 };
}
