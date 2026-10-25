/**
 * Bags of marbles, for the rare rolls a player feels personally. A 1-in-N chance is a bag of N marbles with one
 * red among them, drawn without putting the white ones back; when the bag is empty it's filled again. The long-run
 * odds are exactly the same as a die, but nobody goes fifty tries without it: the red marble always turns up
 * within the bag. (Refilling the moment the red one comes out would quietly double the odds, so the bag runs out.)
 * If the odds change while a bag is half drawn (more charm, say), the bag is resized to match, keeping how far
 * through it they are. Combat stays on plain dice: its streaks are part of the drama.
 */
import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";

/** The bag that matches a chance: a 9% chance is a bag of 11. Capped so a near-impossible roll doesn't make a bag of thousands. */
export const bagSize = (p: number) => Math.max(1, Math.min(1000, Math.round(1 / p)));

/** Draw one marble. Returns whether it was the red one, and the bag as it now stands (for the log). */
export async function draw(c: PoolClient, playerId: string, kind: string, p: number): Promise<{ hit: boolean; size: number; left: number }> {
  if (p <= 0) return { hit: false, size: 0, left: 0 };
  if (p >= 1) return { hit: true, size: 1, left: 0 };
  const want = bagSize(p);
  const row = (await c.query<{ size: number; left_: number; reds: number }>("select size, left_, reds from luck_bags where player_id = $1 and kind = $2 for update", [playerId, kind])).rows[0];
  let size = want, left = want, reds = 1;
  if (row && row.left_ > 0) {
    size = row.size; left = row.left_; reds = row.reds;
    if (size !== want) {
      // The odds moved: keep the same share of the bag still to draw, at the new size.
      left = Math.max(reds, Math.round((left / size) * want)); size = want;
    }
  }
  const hit = reds > 0 && randomInt(0, left) < reds;
  left -= 1; if (hit) reds -= 1;
  if (left <= 0) { size = want; left = want; reds = 1; } // empty: a fresh bag for next time
  await c.query(
    `insert into luck_bags (player_id, kind, size, left_, reds) values ($1, $2, $3, $4, $5)
     on conflict (player_id, kind) do update set size = $3, left_ = $4, reds = $5`, [playerId, kind, size, left, reds]);
  return { hit, size, left };
}
