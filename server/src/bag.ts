/**
 * Bags. Gear you carry but aren't using. Weight-limited; equipped pieces don't count.
 * Lose one random carried item when you die.
 */
import type { Client } from "./db.js";
import { GAME, armor, weapon, type Player } from "./game.js";
import { roll } from "./combat.js";
import { ore, trinket, bonusText } from "./caves.js";

/** Gear you can wear (weapon, armor, jewelry), plus ore, which you can only carry and sell. */
export type Slot = "weapon" | "armor" | "ore" | "trinket";
export type GearSlot = "weapon" | "armor";

export function item(slot: Slot, id: number): { name: string; weight: number; cost: number } {
  if (slot === "ore") return ore(id);
  if (slot === "trinket") return trinket(id);
  return slot === "weapon" ? weapon(id) : armor(id);
}
export function bag(id: number) {
  return GAME.bags.find((b) => b.id === id) ?? GAME.bags[0];
}
export function sellPrice(slot: Slot, id: number) {
  return Math.floor(item(slot, id).cost * GAME.sellFraction);
}

export interface Carried { id: number; slot: Slot; item_id: number; }

export async function contents(c: Client, playerId: string): Promise<Carried[]> {
  const r = await c.query<{ id: string; slot: Slot; item_id: number }>(
    "select id, slot, item_id from inventory where player_id = $1 order by slot, item_id desc, id", [playerId]);
  return r.rows.map((x) => ({ id: Number(x.id), slot: x.slot, item_id: x.item_id }));
}

export function weightOf(items: { slot: Slot; item_id: number }[]): number {
  return items.reduce((n, x) => n + item(x.slot, x.item_id).weight, 0);
}

export async function used(c: Client, playerId: string): Promise<number> {
  return weightOf(await contents(c, playerId));
}

/** What the narrator sees when it opens the bag. */
export async function describe(c: Client, p: Player) {
  const items = await contents(c, p.id);
  const b = bag(p.bag_id);
  return {
    bag: b.name,
    capacity: b.capacity,
    used: weightOf(items),
    items: items.map((x) => {
      const it = item(x.slot, x.item_id);
      const stats = x.slot === "weapon" ? { str: weapon(x.item_id).str }
        : x.slot === "armor" ? { def: armor(x.item_id).def }
        : x.slot === "trinket" ? { bonus: bonusText(trinket(x.item_id)) } : {};
      const upgrade = x.slot === "weapon" ? x.item_id > p.weapon_id
        : x.slot === "armor" ? x.item_id > p.armor_id
        : x.slot === "trinket" ? p.trinket_id === 0 : false;
      return { id: x.id, slot: x.slot, name: it.name, ...stats, weight: it.weight, sells_for: sellPrice(x.slot, x.item_id), upgrade };
    }),
    equipped: { weapon: weapon(p.weapon_id).name, armor: armor(p.armor_id).name, jewelry: p.trinket_id ? `${trinket(p.trinket_id).name} (${bonusText(trinket(p.trinket_id))})` : null },
    gems: p.gems,
    pickaxe: p.pickaxe,
    ground: p.ground ? { slot: p.ground.slot, name: item(p.ground.slot, p.ground.item_id).name, weight: item(p.ground.slot, p.ground.item_id).weight } : null,
  };
}

/** On death: one random carried item is gone. Returns its name, or null if the bag was empty. */
export async function loseRandom(c: Client, playerId: string): Promise<string | null> {
  const items = await contents(c, playerId);
  if (!items.length) return null;
  const x = items[roll(items.length - 1)];
  await c.query("delete from inventory where id = $1", [x.id]);
  return item(x.slot, x.item_id).name;
}
