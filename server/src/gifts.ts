/**
 * Gifts by courier. A letter can carry gold, gems or one item from the bag to another player, a townsperson
 * or one of the realm's characters. The courier takes a fee, and the gift arrives at the next dawn: players
 * collect it from their mail, townsfolk and characters take it when the day turns (gold toward a
 * townsperson's goal, and sometimes something sent back). Unclaimed gifts go home after a week.
 *
 * Limits keep a generous friend from carrying a new player up the levels: you can send from level 3, gold
 * up to GOLD_PER_LEVEL a day per level of yours, a couple of items a day, and nothing between a test
 * character and a real one. Every gift is a row here, so the keeper can see who's feeding whom.
 */
import type { Client } from "./db.js";
import { TOWN_TILES, townAt, type TownId } from "./world.js";
import { homeOf } from "./towns.js";

export const GIFT_MIN_LEVEL = 3;
/** Gold you can send in a realm day, per level of yours. Tuned in the simulator (GIFT=). */
export const GOLD_PER_LEVEL = 200;
export const ITEMS_PER_DAY = 2;
/** Weapons and armor can go to a player only up to this many tiers above their level. */
export const GEAR_ABOVE_LEVEL = 3;
export const KEEP_DAYS = 7;
/** A townsperson sends something back about this often. */
export const SEND_BACK = 0.25;

/** The courier's fee: a twentieth of what's carried (at least 10), twice that between towns. */
export function courierFee(worth: number, between: boolean): number {
  return Math.max(10, Math.ceil(worth * 0.05)) * (between ? 2 : 1);
}

/** Where someone is for the courier: their town, or home for townsfolk out in the wild. */
export function townOfPlayer(p: { pos_x: number | null; pos_y: number | null; start_town?: string | null }, botHome?: string | null): TownId {
  if (botHome) return botHome as TownId;
  if (p.pos_x === null || p.pos_x === undefined) return "brightwater";
  return townAt(p.pos_x, p.pos_y!) ?? ((p.start_town as TownId) || "brightwater");
}
export function townOfCharacter(name: string): TownId { return homeOf(name)?.id ?? "brightwater"; }
export const townName = (t: TownId) => (t === "brightwater" ? "Brightwater" : TOWN_TILES[t as keyof typeof TOWN_TILES]?.name ?? t);

export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
}

export interface GiftRow { id: string; from_player: string | null; to_player: string; gold: number; gems: number; slot: string | null; item_id: number | null; rarity: number; arrives_day: string; returned: boolean; message_id: string | null }

/**
 * At the turn of the day: townsfolk and characters take what's arrived for them, and players' gifts that sat
 * unclaimed for a week go home (and a returned one nobody claims in another week is lost).
 */
export async function settleGifts(c: Client, day: string): Promise<string[]> {
  const out: string[] = [];
  const arrived = (await c.query<GiftRow & { role: string; to_name: string; from_name: string | null; from_level: number | null; from_role: string | null }>(
    `select g.*, g.arrives_day::text, t.role, t.name as to_name, f.name as from_name, f.level as from_level, f.role as from_role
     from gifts g join players t on t.id = g.to_player left join players f on f.id = g.from_player
     where g.state = 'sent' and g.arrives_day <= $1 and t.role in ('townsfolk', 'npc') for update of g`, [day])).rows;
  for (const g of arrived) {
    if (g.role === "townsfolk") {
      // Gold goes in the bank, where a saver's goal counts it; gems in the pouch; an item into the bag.
      await c.query("update players set bank = bank + $2, gems = gems + $3 where id = $1", [g.to_player, g.gold, g.gems]);
      if (g.slot && g.item_id !== null) await c.query("insert into inventory (player_id, slot, item_id, rarity) values ($1,$2,$3,$4)", [g.to_player, g.slot, g.item_id, g.rarity]);
      await c.query("update bots set mind = jsonb_set(coalesce(mind, '{}'::jsonb), '{mood}', to_jsonb(least(3, coalesce((mind->>'mood')::int, 0) + 1))) where player_id = $1", [g.to_player]);
    }
    await c.query("update gifts set state = 'kept', settled_at = now() where id = $1", [g.id]);
    out.push(`${g.to_name} kept a gift from ${g.from_name ?? "someone"}`);
    // Now and then they send something back with the courier: a gem, or a little gold.
    if (g.from_player && g.from_role === "player" && Math.random() < SEND_BACK) {
      const gem = Math.random() < 0.5;
      await c.query("insert into gifts (from_player, to_player, gold, gems, sent_day, arrives_day) values ($1,$2,$3,$4,$5,$6)",
        [g.to_player, g.from_player, gem ? 0 : 10 * Math.max(1, g.from_level ?? 1), gem ? 1 : 0, day, nextDay(day)]);
      out.push(`${g.to_name} sent something back to ${g.from_name}`);
    }
  }
  // A week unclaimed: back to the sender, who has a week to collect it before it's gone.
  const stale = (await c.query<GiftRow>(
    `select g.*, g.arrives_day::text from gifts g join players t on t.id = g.to_player
     where g.state = 'sent' and t.role = 'player' and g.arrives_day <= ($1::date - $2::int) for update of g`, [day, KEEP_DAYS])).rows;
  for (const g of stale) {
    if (g.returned || !g.from_player) { await c.query("update gifts set state = 'lost', settled_at = now() where id = $1", [g.id]); out.push(`gift ${g.id} lost`); continue; }
    await c.query("update gifts set from_player = to_player, to_player = from_player, returned = true, arrives_day = $2 where id = $1", [g.id, day]);
    out.push(`gift ${g.id} returned`);
  }
  return out;
}
