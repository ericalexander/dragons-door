/**
 * Bags. Gear you carry but aren't using. Weight-limited; equipped pieces don't count.
 * Lose one random carried item when you die.
 */
import type { Client } from "./db.js";
import { GAME, armor, weapon, weaponName, casts, attributeName, type Player } from "./game.js";
import { roll } from "./combat.js";
import { ore, trinket, bonusText } from "./caves.js";
import { QUESTS } from "./quests.js";

/** Gear you can wear (weapon, armor, jewelry), plus ore, which you can only carry and sell. */
export type Slot = "weapon" | "armor" | "ore" | "trinket" | "quest";
export type GearSlot = "weapon" | "armor";

export function item(slot: Slot, id: number): { name: string; weight: number; cost: number } {
  if (slot === "ore") return ore(id);
  if (slot === "trinket") return trinket(id);
  if (slot === "quest") { const q = QUESTS[id]; return { name: q?.item?.name ?? "something odd", weight: 1, cost: (q?.item?.sell ?? 0) * 2 }; }
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
        : x.slot === "trinket" ? { bonus: bonusText(trinket(x.item_id), attributeName(p.class)) }
        : x.slot === "quest" ? { quest_item: true } : {};
      const upgrade = x.slot === "weapon" ? x.item_id > p.weapon_id
        : x.slot === "armor" ? x.item_id > p.armor_id
        : x.slot === "trinket" ? p.trinket_id === 0 : false;
      const name = x.slot === "weapon" && casts(p.class) ? `Scroll of ${weaponName(p.class, x.item_id)}` : it.name;
      return { id: x.id, slot: x.slot, name, ...stats, weight: it.weight, sells_for: sellPrice(x.slot, x.item_id), upgrade };
    }),
    equipped: { [casts(p.class) ? "spell" : "weapon"]: weaponName(p.class, p.weapon_id), armor: armor(p.armor_id).name, jewelry: p.trinket_id ? `${trinket(p.trinket_id).name} (${bonusText(trinket(p.trinket_id), attributeName(p.class))})` : null },
    gems: p.gems,
    pickaxe: p.pickaxe,
    ground: p.ground ? { slot: p.ground.slot, name: item(p.ground.slot, p.ground.item_id).name, weight: item(p.ground.slot, p.ground.item_id).weight } : null,
  };
}

/** On death: one random carried item is gone. Returns its name, or null if the bag was empty. */
export async function loseRandom(c: Client, playerId: string): Promise<string | null> {
  // Quest items aren't lost this way; a quest should end by a choice, not a bad fight.
  const items = (await contents(c, playerId)).filter((x) => x.slot !== "quest");
  if (!items.length) return null;
  const x = items[roll(items.length - 1)];
  await c.query("delete from inventory where id = $1", [x.id]);
  return item(x.slot, x.item_id).name;
}
