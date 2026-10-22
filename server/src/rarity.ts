/**
 * Gear rarity: Common, Uncommon, Rare, Epic, Mythic. Every weapon and piece of armor starts Common
 * (from the smith, a drop, or a find); the forge at Ironhold takes it up a step at a time, for gold and
 * ore. A step multiplies the piece's power (weapons) or defense (armor), and what it's worth.
 * Casters' spells aren't things and can't be forged; their armor can.
 */
export interface Rarity { name: string; mult: number; value: number }

// Tuned in the simulator: forging is about a day's edge on the road to the dragon, not a shortcut.
const M = (process.env.RARITY_MULTS ?? "1,1.1,1.2,1.3,1.45").split(",").map(Number);
export const RARITY: Rarity[] = [
  { name: "Common", mult: M[0], value: 1 },
  { name: "Uncommon", mult: M[1], value: 2 },
  { name: "Rare", mult: M[2], value: 4 },
  { name: "Epic", mult: M[3], value: 8 },
  { name: "Mythic", mult: M[4], value: 16 },
];
export const MAX_RARITY = RARITY.length - 1;

const clamp = (r: number | null | undefined) => Math.max(0, Math.min(MAX_RARITY, r ?? 0));
export const rarity = (r: number | null | undefined) => RARITY[clamp(r)];
/** "Rare Long Sword"; Common pieces keep their plain name. */
export const withRarity = (name: string, r: number | null | undefined) => (clamp(r) > 0 ? `${RARITY[clamp(r)].name} ${name}` : name);
/** A stat after rarity: power for a weapon, defense for armor. */
export const boosted = (base: number, r: number | null | undefined) => Math.round(base * RARITY[clamp(r)].mult);

/** What the forge asks to take a piece from one step to the next: gold (a share of the piece's price new), ore and gems. */
const STEP: { gold: number; ore: Partial<Record<number, number>>; gems: number }[] = [
  { gold: 1, ore: { 0: 3 }, gems: 0 },       // to Uncommon: the piece's price again, and copper
  { gold: 2, ore: { 1: 3 }, gems: 0 },       // to Rare: silver
  { gold: 4, ore: { 2: 3 }, gems: 0 },       // to Epic: gold
  { gold: 8, ore: { 2: 4 }, gems: 3 },       // to Mythic: more gold, and gems
];
export function forgeCost(baseCost: number, from: number): { gold: number; ore: Partial<Record<number, number>>; gems: number } | null {
  if (from >= MAX_RARITY) return null;
  const s = STEP[clamp(from)];
  const gold = Number(process.env.FORGE_GOLD ?? 1);
  return { gold: Math.max(25, Math.ceil(baseCost * s.gold * gold)), ore: s.ore, gems: s.gems };
}
