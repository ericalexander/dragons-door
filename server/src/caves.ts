/**
 * Caves, ore and jewelry.
 *
 * A cave is a point of interest on the map (world.ts). Inside it goes down three levels, each darker
 * and richer than the last. With a pickaxe you can mine there: ore goes in your bag (it's heavy),
 * gems go in your pouch. Each cave gives up only so much a day, shared by everyone, and refills at
 * the reset; one person can take only a few finds from a cave a day.
 *
 * Odile, the gemcutter, has a workshop in town. She sells pickaxes and works ore and gems into
 * jewelry: one piece worn at a time, adding strength, defense or charm.
 */
/** 0..n inclusive, like combat.roll (kept local so this module has no game imports). */
const roll = (n: number) => Math.floor(Math.random() * (n + 1));

export const MAX_DEPTH = 3;
/** Finds a cave gives up per realm day, shared by everyone. */
export const CAVE_FINDS_PER_DAY = 18;
/** Finds one person can take from one cave per realm day. Townsfolk take fewer, so players get the seams. */
export const FINDS_PER_PERSON = { player: 5, townsfolk: 3 } as const;
export const PICKAXE_COST = 400;
/** Swings of the pick a day. Separate from forest fights: mining is tiring, but it's a different kind of tired. */
export const SWINGS_PER_DAY = 6;
/** What a gem fetches when you sell one to Odile. */
export const GEM_SELL = 50;

export interface Ore { id: number; name: string; weight: number; cost: number }
export const ORES: Ore[] = [
  { id: 0, name: "Copper Ore", weight: 2, cost: 60 },
  { id: 1, name: "Silver Ore", weight: 3, cost: 240 },
  { id: 2, name: "Gold Ore", weight: 4, cost: 900 },
];

export interface Trinket {
  id: number;
  name: string;
  str: number;
  def: number;
  charm: number;
  weight: number;
  /** What Odile needs: ore by id and count, gems, and her fee in gold. */
  needs: { ore: Partial<Record<number, number>>; gems: number; fee: number };
  /** Notional worth, for selling (half of it, like gear). */
  cost: number;
}

const t = (id: number, name: string, bonus: { str?: number; def?: number; charm?: number }, ore: Partial<Record<number, number>>, gems: number, fee: number): Trinket => {
  const cost = Object.entries(ore).reduce((n, [o, k]) => n + ORES[Number(o)].cost * (k ?? 0), 0) + gems * 100 + fee;
  return { id, name, str: bonus.str ?? 0, def: bonus.def ?? 0, charm: bonus.charm ?? 0, weight: 1, needs: { ore, gems, fee }, cost };
};

/** id 0 is "nothing worn". */
export const TRINKETS: Trinket[] = [
  { id: 0, name: "nothing", str: 0, def: 0, charm: 0, weight: 0, needs: { ore: {}, gems: 0, fee: 0 }, cost: 0 },
  t(1, "Copper Band", { str: 3 }, { 0: 3 }, 0, 60),
  t(2, "Copper Torc", { def: 3 }, { 0: 3 }, 0, 60),
  t(3, "Garnet Pendant", { charm: 5 }, { 0: 1 }, 2, 100),
  t(4, "Silver Ring", { str: 10 }, { 1: 3 }, 1, 300),
  t(5, "Silver Amulet", { def: 10 }, { 1: 3 }, 1, 300),
  t(6, "Moonstone Brooch", { charm: 12 }, { 1: 2 }, 3, 500),
  t(7, "Gold Signet", { str: 22 }, { 2: 3 }, 2, 1200),
  t(8, "Gold Locket", { def: 22 }, { 2: 3 }, 2, 1200),
  t(9, "Starstone Circlet", { charm: 25 }, { 2: 2 }, 5, 2000),
];

export const trinket = (id: number) => TRINKETS.find((x) => x.id === id) ?? TRINKETS[0];
export const ore = (id: number) => ORES.find((x) => x.id === id) ?? ORES[0];

/** How a piece of jewelry reads in a sentence: "+10 strength". */
export function bonusText(x: Trinket): string {
  return [x.str && `+${x.str} strength`, x.def && `+${x.def} defense`, x.charm && `+${x.charm} charm`].filter(Boolean).join(", ");
}

export type MineResult =
  | { kind: "ambush" }
  | { kind: "nothing" }
  | { kind: "ore"; ore: Ore }
  | { kind: "gem" };

/** One swing of the pick at a given depth. Deeper is richer, and the chance of company is the same everywhere. */
export function swing(depth: number): MineResult {
  const r = roll(99);
  if (r < 15) return { kind: "ambush" };
  if (r < 35) return { kind: "nothing" };
  // weights for copper, silver, gold, gem by depth
  const w = depth >= 3 ? [15, 35, 30, 20] : depth === 2 ? [35, 35, 15, 15] : [60, 25, 0, 15];
  let x = roll(w.reduce((a, b) => a + b, 0) - 1);
  for (let i = 0; i < 4; i++) {
    if (x < w[i]) return i === 3 ? { kind: "gem" } : { kind: "ore", ore: ORES[i] };
    x -= w[i];
  }
  return { kind: "nothing" };
}

/** Level of what lives at a given depth of a cave on a tile of a given level. */
export const caveLevel = (tileLevel: number, depth: number) => tileLevel + depth;

/** Whether someone holding these ore counts and gems (and gold) could have Odile make this. */
export function canMake(x: Trinket, have: { ore: Record<number, number>; gems: number; gold: number }): boolean {
  if (x.id === 0) return false;
  for (const [o, k] of Object.entries(x.needs.ore)) if ((have.ore[Number(o)] ?? 0) < (k ?? 0)) return false;
  return have.gems >= x.needs.gems && have.gold >= x.needs.fee;
}
