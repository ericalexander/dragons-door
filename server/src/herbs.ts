/**
 * Herbs and potions. Herbs grow by kind of land: you forage a few times a day out in the wild (apart from
 * turns), and now and then you spot one just walking. Each town's healer sells recipes; you brew at their
 * bench from herbs and a small fee. The more of a recipe you've brewed, the likelier the pot gives an extra
 * draught; nobody tells you a number, it just starts happening. A potion is drunk between fights or in one
 * (one a fight, and it costs you the round).
 */
import { randomInt } from "node:crypto";
import type { Region } from "./bestiary.js";
import type { Terrain } from "./world.js";
import type { TownId } from "./world.js";

export const FORAGES_PER_DAY = 4;
/** Per forage: a find, an ambush, or nothing (the rest). Percent. */
export const FORAGE = { find: 70, ambush: 7 };
/** Walking onto a tile in the wild: the chance of noticing something worth picking. Percent. */
export const SPOT_CHANCE = 10;

export interface Herb { id: number; name: string; grows: Terrain[]; also?: Region[]; minRing?: number; weight: number; cost: number; rare?: boolean }

export const HERBS: Herb[] = [
  { id: 0, name: "Woundwort", grows: ["meadow", "forest"], also: ["highland", "riverside"], weight: 1, cost: 10 },
  { id: 1, name: "Bog Myrtle", grows: ["marsh"], weight: 1, cost: 14 },
  { id: 2, name: "Rockrose", grows: ["hills", "crags"], also: ["highland"], weight: 1, cost: 14 },
  { id: 3, name: "Watermint", grows: ["marsh"], also: ["riverside"], weight: 1, cost: 14 },
  { id: 4, name: "Shadecap", grows: ["forest"], minRing: 4, weight: 1, cost: 30, rare: true },
];
export const herb = (id: number) => HERBS.find((h) => h.id === id) ?? HERBS[0];

/** What grows where you're standing. */
export function herbsAt(terrain: Terrain, region: Region | undefined, ring: number): Herb[] {
  return HERBS.filter((h) => (h.grows.includes(terrain) || (region && h.also?.includes(region))) && ring >= (h.minRing ?? 0));
}

/** Pick one of what grows here; the rare ones turn up half as often. */
export function pickHerb(here: Herb[]): Herb | null {
  if (!here.length) return null;
  const w = here.map((h) => (h.rare ? 1 : 2));
  let r = randomInt(0, w.reduce((a, b) => a + b, 0));
  for (let i = 0; i < here.length; i++) { if (r < w[i]) return here[i]; r -= w[i]; }
  return here[here.length - 1];
}

export type Effect = "heal" | "mana" | "def" | "str";
export interface Potion { id: number; name: string; needs: Record<number, number>; fee: number; effect: Effect; amount: number; price: number; what: string; weight: number }

/**
 * amount: heal and mana are a share of the maximum; def and str are a share of what you fight with (at least 2),
 * and last until the end of the fight (or the next one, drunk between fights).
 * fee: per level, paid at the bench. price: what the healer charges to teach it, once.
 */
export const POTIONS: Potion[] = [
  { id: 0, name: "Healing Draught", needs: { 0: 3 }, fee: 4, effect: "heal", amount: 0.25, price: 60, weight: 1, what: "heals a quarter of your health" },
  { id: 1, name: "Mana Tonic", needs: { 3: 2 }, fee: 5, effect: "mana", amount: 0.3, price: 120, weight: 1, what: "gives back three tenths of your mana" },
  { id: 2, name: "Stoneskin Draught", needs: { 2: 2, 1: 1 }, fee: 6, effect: "def", amount: 0.2, price: 200, weight: 1, what: "a fifth more defense, for one fight" },
  { id: 3, name: "Ox Draught", needs: { 4: 1, 0: 2 }, fee: 8, effect: "str", amount: 0.15, price: 300, weight: 1, what: "a little more strength (about a seventh), for one fight" },
];
export const potion = (id: number) => POTIONS.find((p) => p.id === id) ?? POTIONS[0];

/** What a potion's worth at the shop: its herbs and a level-1 fee, doubled for the work. */
export const potionCost = (p: Potion) => Object.entries(p.needs).reduce((n, [h, k]) => n + herb(Number(h)).cost * k, 0) * 2 + p.fee * 5;

/** Who teaches what. Every healer knows the Healing Draught; the rest depends on the town. */
export const TEACHERS: Record<TownId, { name: string; bench: string; teaches: number[] }> = {
  brightwater: { name: "Rowan", bench: "Rowan's bench at the healer's", teaches: [0, 1] },
  ironhold: { name: "Jessamy Crane", bench: "Jessamy's still in the Long Hall kitchen", teaches: [0, 2] },
  ashford: { name: "Doctor Aurel Imre", bench: "the dispensary behind Doctor Imre's surgery", teaches: [0, 1, 3] },
} as Record<TownId, { name: string; bench: string; teaches: number[] }>;

/** The chance of an extra draught from one brewing, after this many of that recipe brewed. Grows with practice, tops out. */
export const extraChance = (brewed: number) => Math.min(0.4, brewed * 0.02);

/** A boost for one fight: how much it adds, given what you fight with now. */
export const boostAmount = (p: Potion, base: number) => Math.max(2, Math.round(base * p.amount));
