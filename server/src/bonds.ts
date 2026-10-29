/**
 * How townsfolk get on with each other. The same rules as a player's standing (standing.ts), from what happens
 * between two of them: evenings in the same tavern or square (once a day a pair), a marriage, and a robbery in the
 * fields, which turns the one robbed against the robber. Time together is shared; a robbery only sours one side.
 *
 * It shows in what they say in the tavern, in whom they'd never rob, in who they mention to a player, and in the
 * news when two of them become fast friends or fall out.
 */
import { createHash } from "node:crypto";
import { pool } from "./db.js";
import { awayToday, type Mind } from "./minds.js";
import { whereabouts } from "./schedule.js";
import { score, word, type Standing } from "./standing.js";
import type { Personality } from "./schedule.js";
import { tileAt } from "./world.js";

export interface Bond { other: string; word: Standing; points: number }

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]) as [string, string];

/**
 * How readily two temperaments take to each other: the chance a shared hour becomes an evening spent together.
 * Unlisted pairs get the middle. The drunk and the gossip click; the raider and the banker don't.
 */
const AFFINITY: Record<string, number> = {
  "drunk|gossip": 0.6, "drunk|reckless": 0.55, "braggart|reckless": 0.5, "gossip|seer": 0.5, "banker|pious": 0.5, "pious|seer": 0.45,
  "drunk|raider": 0.4, "braggart|drunk": 0.4, "gossip|pious": 0.4, "banker|gossip": 0.35,
  "banker|raider": 0.08, "pious|raider": 0.1, "braggart|seer": 0.15, "banker|braggart": 0.15, "banker|reckless": 0.15, "pious|reckless": 0.2,
};
export const affinity = (p: Personality, q: Personality) => p === q ? 0.35 : AFFINITY[[p, q].sort().join("|")] ?? 0.25;
/** A bigger crowd spreads people thinner: past a handful, any one pair is less likely to get talking. */
const crowd = (n: number) => Math.min(1, 3 / Math.max(1, n - 1));
/** A pair's roll for the day, between 0 and 1. */
const dayRoll = (a: string, b: string, day: string) => createHash("sha256").update(`${a}|${b}|${day}`).digest().readUInt32BE(0) / 2 ** 32;
/** At most this many friendships or falling-outs make the news in a day. */
const TURNS_PER_DAY = 2;

/**
 * Who's together right now: townsfolk whose day puts them in the same town's tavern or square, or camped on the
 * same tile in the wild. Each pair's first
 * shared hour of the day counts as an evening together. Call once an hour (the townsfolk run).
 */
export async function recordTogether(day: string, now: Date, rand?: () => number): Promise<string[]> {
  const rows = (await pool.query<{ name: string; personality: Personality; mind: Mind | null; home: string | null; errand: { to: string; until: string } | null; alive: boolean; pos_x: number | null; pos_y: number | null; location: "inn" | "fields" }>(
    `select p.name, b.personality, b.mind, b.home, b.errand, p.alive, p.pos_x, p.pos_y, p.location
     from bots b join players p on p.id = b.player_id where p.role = 'townsfolk'`)).rows;
  const groups = new Map<string, string[]>();
  const kinds = new Map<string, Personality>();
  for (const r of rows) {
    const today = r.mind?.today?.day === day ? r.mind.today.sessions : undefined;
    const w = whereabouts(r.personality, r.name, day, now, r.alive, {
      sessions: today, away: awayToday(day, r.name, r.personality),
      wild: r.pos_x === null ? null : tileAt(r.pos_x, r.pos_y!).name, sleeps: r.location,
    });
    // In town: the same tavern or square. Out in the wild: camped on the same tile, by the same fire.
    let k: string;
    if (w.where === "wild" && r.pos_x !== null) k = `wild:${r.pos_x},${r.pos_y}`;
    else if (w.where === "tavern" || w.where === "square") k = `${r.errand && r.errand.until >= day ? r.errand.to : r.home ?? "brightwater"}:${w.where}`;
    else continue;
    groups.set(k, [...(groups.get(k) ?? []), r.name]);
    kinds.set(r.name, r.personality);
  }
  const met: string[] = [];
  for (const [where, names] of groups) {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const [a, b] = pair(names[i]!, names[j]!);
      // In the same room isn't the same as an evening together: their temperaments and the crowd decide.
      // One roll a pair a day, however many hours they share: the same answer every hour of that day.
      if ((rand ? rand() : dayRoll(a, b, day)) >= affinity(kinds.get(a)!, kinds.get(b)!) * crowd(names.length)) continue;
      const r = await pool.query(
        `insert into bonds (a, b, together, last_together) values ($1, $2, 1, $3)
         on conflict (a, b) do update set together = bonds.together + 1, last_together = $3 where bonds.last_together is distinct from $3
         returning 1`, [a, b, day]);
      if (r.rowCount) met.push(`${a} & ${b} (${where.startsWith("wild:") ? "camped together" : where})`);
    }
  }
  return met;
}

/** How one townsperson feels about each of the others they have any history with, warmest first. */
export async function bondsOf(name: string, day: string): Promise<Bond[]> {
  const rows = (await pool.query<{ other: string; together: number; last_together: string | null; robbed: number[] | null; married: boolean }>(
    `with mine as (
       select case when a = $1 then b else a end as other, together, last_together::text from bonds where a = $1 or b = $1
     ), hurt as (
       select actor as other, array_agg($2::date - day) as robbed from news
       where kind = 'pvp_kill' and target = $1 and day > $2::date - 60 and actor in (select name from players where role = 'townsfolk') group by actor
     ), names as (select other from mine union select other from hurt)
     select n.other, coalesce(m.together, 0) as together, m.last_together, h.robbed,
       coalesce((select me.spouse_id = them.id from players me, players them where me.name = $1 and them.name = n.other), false) as married
     from names n left join mine m on m.other = n.other left join hurt h on h.other = n.other`, [name, day])).rows;
  return rows.map((r) => {
    const points = score({ talkDays: r.together, gifts: [], letterDays: 0, quests: 0, robbedDaysAgo: r.robbed ?? [], married: r.married,
      sinceContact: r.last_together ? Math.round((Date.parse(day) - Date.parse(r.last_together)) / 86_400_000) : null });
    return { other: r.other, word: word(points, r.together > 0), points: Math.round(points * 10) / 10 };
  }).sort((x, y) => y.points - x.points);
}

export const warm = (w: Standing) => w === "friendly" || w === "trusted" || w === "close";
export const cold = (w: Standing) => w === "wary" || w === "hostile";

/**
 * A turn worth telling: two townsfolk who've come to trust each other (both ways), or one who's turned hostile toward another.
 * A couple a day at most; the rest wait their turn.
 * Each pair is told once per turn: the row remembers which.
 */
export async function turnsToTell(day: string): Promise<{ kind: "friends" | "feud"; a: string; b: string }[]> {
  const people = (await pool.query<{ name: string }>("select name from players where role = 'townsfolk'")).rows.map((r) => r.name);
  const out: { kind: "friends" | "feud"; a: string; b: string }[] = [];
  const seen = new Set<string>();
  const cache = new Map<string, Bond[]>();
  const of = async (n: string) => { if (!cache.has(n)) cache.set(n, await bondsOf(n, day)); return cache.get(n)!; };
  for (const name of people) {
    for (const bnd of await of(name)) {
      const [a, b] = pair(name, bnd.other);
      const key = `${a}|${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const theirs = (await of(bnd.other)).find((x) => x.other === name);
      const trust = (w?: Standing) => w === "trusted" || w === "close";
      const kind = bnd.word === "hostile" || theirs?.word === "hostile" ? "feud" : trust(bnd.word) && trust(theirs?.word) ? "friends" : null;
      if (out.length >= TURNS_PER_DAY) return out;
      if (!kind) continue;
      const r = await pool.query(
        `insert into bonds (a, b, together, told) values ($1, $2, 0, $3)
         on conflict (a, b) do update set told = $3 where bonds.told is distinct from $3 returning 1`, [a, b, kind]);
      // For a feud, the one who turned against the other comes first.
      const first = kind === "feud" ? (bnd.word === "hostile" ? name : bnd.other) : a;
      if (r.rowCount) out.push({ kind, a: first, b: first === a ? b : a });
    }
  }
  return out;
}
