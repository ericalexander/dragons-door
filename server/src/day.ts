import type { Client } from "./db.js";
import { GAME, type Player, type Turns } from "./game.js";

/** Realm-day: UTC date after subtracting the reset hour. One clock for the whole realm. */
export function realmDay(resetHourUtc: number, now = new Date()): string {
  const shifted = new Date(now.getTime() - resetHourUtc * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

export async function realmSettings(c: Client): Promise<{ resetHourUtc: number; dragonAlive: boolean }> {
  const r = await c.query<{ key: string; value: unknown }>("select key, value from realm");
  const m = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  return { resetHourUtc: Number(m.reset_hour_utc ?? 5), dragonAlive: Boolean(m.dragon_alive ?? true) };
}

/**
 * Load the player's turns row for today, creating it if missing.
 * Creating it is the day rollover: resurrect, heal if they slept at the inn, kick them to the fields.
 */
export async function loadTurns(c: Client, p: Player, day: string): Promise<{ turns: Turns; player: Player; rolled: boolean }> {
  const existing = await c.query<Turns>("select * from turns where player_id = $1 and day = $2", [p.id, day]);
  if (existing.rowCount) return { turns: existing.rows[0], player: p, rolled: false };

  const ins = await c.query<Turns>("insert into turns (player_id, day, specials) values ($1, $2, $3) returning *", [p.id, day, GAME.classes[p.class].specialsPerDay]);
  const healed = p.location === "inn" || !p.alive;
  const upd = await c.query<Player>(
    `update players set alive = true, hp = case when $2 then max_hp else greatest(hp, 1) end, location = 'fields', last_seen = now()
     where id = $1 returning *`,
    [p.id, healed],
  );
  return { turns: ins.rows[0], player: upd.rows[0], rolled: true };
}
