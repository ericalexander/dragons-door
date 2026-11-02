/**
 * Hidden hands: townsfolk who do harm in secret. Who they are, what they do and every word of it live in the
 * private lore (kind 'shadow'), never here: this module only knows that some townsperson, named in the lore,
 * does deeds of two kinds.
 *
 * - A killer: every so often, on a day they're away from town, a traveller is found dead the next morning.
 *   The victims are strangers on the road, never the realm's own people. It reaches the news.
 * - Mischief: every few days, something goes wrong in one town. A foul well makes its healer dearer for the
 *   day; spoiled stores put its shops' prices up; a whisper sours two of its townsfolk toward each other; a
 *   cart is sent out early and robbed.
 *
 * Nobody is ever told who did it. Players find out the way they find out anything: from what people let slip
 * once they trust you, and from journals.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { pool } from "./db.js";
import { lore } from "./lore.js";

export type Deed = "well" | "stores" | "sour" | "cart";
export interface KillerShadow {
  key: string; kind: "killer"; who: string; every_days: number; away: string;
  trades: string[]; victims: string[]; first_lines: string[]; lines: string[];
}
export interface MischiefShadow {
  key: string; kind: "mischief"; who: string; town: string; every_days: number;
  deeds: Partial<Record<Deed, { lines: string[]; victim?: string }>>;
}
export type Shadow = KillerShadow | MischiefShadow;

/** What a day's trouble does to a town's prices: the healer's, and the shops'. */
export const TROUBLE = { healer: 1.5, shop: 0.1 } as const;
/** A whisper's harm between two townsfolk, fading over this many days. */
export const SOUR = { points: -4, days: 30 } as const;
/** Deeds happen in the morning, Eastern: the body is found at first light, the well is foul by breakfast. */
const MORNING_HOUR = 6;

const roll = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0) / 2 ** 32;
const pickBy = <T>(xs: T[], ...parts: string[]): T => xs[Math.floor(roll("pick", ...parts) * xs.length) % xs.length]!;
const shadows = (): Shadow[] => lore().shadows ?? [];
const before = (day: string, n: number) => new Date(Date.parse(day) - n * 86_400_000).toISOString().slice(0, 10);

/** Whether this is one of the shadow's days for a deed. The same answer every time it's asked. */
export function deedDay(s: Shadow, day: string): boolean {
  const every = Math.max(1, s.every_days);
  const hit = (d: string) => roll("deed", s.key, d) < 1 / every;
  if (!hit(day)) return false;
  // Never two close together: a day counts only if none of the few before it rolled a hit.
  for (let i = 1; i <= Math.floor(every / 2); i++) if (hit(before(day, i))) return false;
  return true;
}

/** If someone is away today because of what they do at night, the reason anyone would give. */
export function shadowAway(day: string, name: string): string | null {
  for (const s of shadows()) if (s.kind === "killer" && s.who === name && deedDay(s, day)) return s.away;
  return null;
}

const fill = (line: string, v: Record<string, string | number>) => line.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/** The hour in Eastern time. */
function easternHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit" }).format(now));
}

/**
 * Once a day, after first light: whatever the shadows did. Each shadow acts at most once a day (the row in
 * shadow_deeds is the lock). Returns lines for the run's log.
 */
export async function runShadows(day: string, now: Date): Promise<string[]> {
  if (easternHour(now) < MORNING_HOUR) return [];
  const out: string[] = [];
  for (const s of shadows()) {
    if (s.kind === "killer") {
      // Found this morning: the deed was the day before, while they were away.
      if (!deedDay(s, before(day, 1))) continue;
      const done = (await pool.query<{ name: string }>("select detail->>'name' as name from shadow_deeds where key = $1", [s.key])).rows.map((r) => r.name);
      const left = s.victims.filter((v) => !done.includes(v));
      const name = left.length ? pickBy(left, s.key, day) : `${pickBy(s.victims, s.key, day)} the younger`;
      const trade = pickBy(s.trades, s.key, day, "trade");
      const line = fill(pickBy(done.length ? s.lines : s.first_lines, s.key, day, "line"), { name, trade });
      if (await claim(s, day, "found", { name, trade, line })) { await news(day, s, "found", line); out.push(line); }
    } else {
      if (!deedDay(s, day)) continue;
      const kinds = (Object.keys(s.deeds) as Deed[]).filter((k) => s.deeds[k]?.lines.length);
      if (!kinds.length) continue;
      let deed = pickBy(kinds, s.key, day, "deed");
      let vars: Record<string, string | number> = {};
      if (deed === "sour") {
        const pair = await sourPair(s, day);
        if (pair) vars = { a: pair[0], b: pair[1] }; else deed = "well";
      }
      if (deed === "cart") {
        const who = s.deeds.cart?.victim ?? "";
        const p = (await pool.query<{ gold: string }>("select gold::text from players where name = $1 and alive", [who])).rows[0];
        const gold = p ? Math.floor(Number(p.gold) * 0.3) : 0;
        if (gold >= 10) vars = { who, gold }; else deed = "stores";
      }
      const lines = s.deeds[deed]?.lines ?? s.deeds.well?.lines ?? [];
      if (!lines.length) continue;
      const line = fill(pickBy(lines, s.key, day, "line"), vars);
      if (!await claim(s, day, deed, { ...vars, line, town: s.town })) continue;
      if (deed === "cart") await pool.query("update players set gold = greatest(0, gold - $2) where name = $1", [vars.who, vars.gold]);
      await news(day, s, deed, line);
      out.push(`${deed}: ${line}`);
    }
  }
  return out;
}

async function claim(s: Shadow, day: string, deed: string, detail: Record<string, unknown>): Promise<boolean> {
  const r = await pool.query("insert into shadow_deeds (day, key, deed, town, detail) values ($1,$2,$3,$4,$5) on conflict do nothing returning 1",
    [day, s.key, deed, s.kind === "mischief" ? s.town : null, JSON.stringify(detail)]);
  return Boolean(r.rowCount);
}

/** Trouble in the news names nobody: it's something that happened, not something someone did. */
async function news(day: string, s: Shadow, deed: string, line: string) {
  await pool.query("insert into news (day, kind, actor, detail) values ($1, 'trouble', null, $2)",
    [day, JSON.stringify({ deed, line, where: s.kind === "mischief" ? s.town : "the south road" })]);
}

/** Two of the town's own to set against each other: never the one doing it, and preferably two who get on. */
async function sourPair(s: MischiefShadow, day: string): Promise<[string, string] | null> {
  const people = (await pool.query<{ name: string }>(
    "select p.name from bots b join players p on p.id = b.player_id where p.role = 'townsfolk' and b.home = $1 and p.name <> $2 order by p.name", [s.town, s.who])).rows.map((r) => r.name);
  if (people.length < 2) return null;
  const close = (await pool.query<{ a: string; b: string }>("select a, b from bonds where a = any($1) and b = any($1) and together > 0 order by together desc limit 6", [people])).rows;
  if (close.length) { const c = pickBy(close, s.key, day, "pair"); return roll("order", day) < 0.5 ? [c.a, c.b] : [c.b, c.a]; }
  const a = pickBy(people, s.key, day, "a");
  const b = pickBy(people.filter((x) => x !== a), s.key, day, "b");
  return [a, b];
}

/** Today's trouble in a town: which deeds touch its prices. */
export async function troubleToday(c: pg.PoolClient | pg.Pool, town: string, day: string): Promise<Set<Deed>> {
  const r = await c.query<{ deed: Deed }>("select deed from shadow_deeds where town = $1 and day = $2", [town, day]);
  return new Set(r.rows.map((x) => x.deed));
}

/** What's gone wrong lately where the player is, for people to grumble about. The south road's news reaches every town. */
export async function recentTrouble(c: pg.PoolClient | pg.Pool, town: string, day: string): Promise<string[]> {
  const r = await c.query<{ line: string }>(
    "select detail->>'line' as line from shadow_deeds where (town = $1 or town is null) and day > $2::date - 3 order by day desc limit 3", [town, day]);
  return r.rows.map((x) => x.line);
}

/** Whispers between two townsfolk: days since each, for the bond between them. */
export async function whispersBetween(name: string, day: string): Promise<Map<string, number[]>> {
  const r = await pool.query<{ a: string; b: string; ago: number }>(
    `select detail->>'a' as a, detail->>'b' as b, ($2::date - day) as ago from shadow_deeds
     where deed = 'sour' and (detail->>'a' = $1 or detail->>'b' = $1) and day > $2::date - $3::int`, [name, day, SOUR.days]);
  const out = new Map<string, number[]>();
  for (const x of r.rows) { const other = x.a === name ? x.b : x.a; out.set(other, [...(out.get(other) ?? []), x.ago]); }
  return out;
}

/** What whispers take off a bond: a fresh one is enough on its own to turn two strangers hostile. */
export const sourness = (agos: number[]) => agos.reduce((n, d) => n + SOUR.points * Math.max(0, 1 - d / SOUR.days), 0);
