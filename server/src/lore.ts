/**
 * The realm's lore: its history, its people's pasts, journals left lying about, and quests that grow
 * out of them. The words live only in the database (the lore table), never in this code or on the
 * website, because players are meant to find them in play. This module loads them, caches them for a
 * few minutes, and hands out what the rest of the server needs. With no lore loaded, everything that
 * uses it quietly does nothing.
 *
 * A person's past comes in pieces, heard in order (what anyone could tell you, something personal, a
 * secret), at most one new piece from each person a day. Journals turn up in the wild, in caves and
 * around town, at most one every few days. What each player has learned is in player_lore.
 */
import type pg from "pg";
import { pool } from "./db.js";
import { QUESTS, type QuestDef } from "./quests.js";
import { setPlaces, type Place } from "./world.js";

export interface Journal { key: string; title: string; text: string; where: "wild" | "cave" | "town" | "ironhold" | "ashford"; author: string | null; min_ring: number }
export interface Lore {
  /** What anyone in town knows about the realm. Safe for the narrator, letters and the public Chronicle. */
  world: string;
  people: Record<string, { pieces: string[]; mentions: string[] }>;
  masters: Record<number, { name: string; about: string }>;
  /** Ironhold's training yard: masters for those who fight with steel. */
  ironMasters: Record<number, { name: string; about: string }>;
  /** Ashford's Undercroft: masters for the Shadow path. */
  ashMasters: Record<number, { name: string; about: string }>;
  journals: Journal[];
  /** How people look, which anyone would see, and for a few, how something they live with shapes how they move or talk. */
  looks: Record<string, { look: string; manner?: string }>;
}

const EMPTY: Lore = { world: "", people: {}, masters: {}, ironMasters: {}, ashMasters: {}, journals: [], looks: {} };
const TTL = 5 * 60_000;
let current: Lore = EMPTY;
let loadedAt = 0;

interface Row { key: string; kind: string; subject: string | null; piece: number | null; body: string; data: Record<string, unknown> }

/** Load (or reuse) the lore. Never throws: before the table exists, or with no rows, the realm just has no lore yet. */
export async function loadLore(force = false): Promise<Lore> {
  if (!force && Date.now() - loadedAt < TTL) return current;
  let rows: Row[];
  try {
    rows = (await pool.query<Row>("select key, kind, subject, piece, body, data from lore order by kind, subject, piece, key")).rows;
  } catch {
    loadedAt = Date.now();
    return current;
  }
  const next: Lore = { world: "", people: {}, masters: {}, ironMasters: {}, ashMasters: {}, journals: [], looks: {} };
  const person = (name: string) => (next.people[name] ??= { pieces: [], mentions: [] });
  const places: Place[] = [];
  for (const r of rows) {
    if (r.kind === "world") next.world = r.body;
    else if (r.kind === "person" && r.subject) person(r.subject).pieces[r.piece ?? 0] = r.body;
    else if (r.kind === "mention" && r.subject) person(r.subject).mentions.push(r.body);
    else if (r.kind === "look" && r.subject) next.looks[r.subject] = { look: r.body, ...((r.data as { manner?: string }).manner ? { manner: (r.data as { manner: string }).manner } : {}) };
    else if (r.kind === "master" && r.piece) ((r.data as { town?: string }).town === "ironhold" ? next.ironMasters : (r.data as { town?: string }).town === "ashford" ? next.ashMasters : next.masters)[r.piece] = { name: r.subject ?? "", about: r.body };
    else if (r.kind === "journal") {
      const d = r.data as { where?: Journal["where"]; author?: string | null; min_ring?: number };
      next.journals.push({ key: r.key, title: r.subject ?? "", text: r.body, where: d.where ?? "wild", author: d.author ?? null, min_ring: d.min_ring ?? 0 });
    } else if (r.kind === "place" && r.subject) {
      const d = r.data as { x: number; y: number; poi: "shrine"; meeting?: number };
      places.push({ key: r.subject, x: d.x, y: d.y, name: (r.data as { name?: string }).name ?? r.subject, poi: d.poi, about: r.body, ...(d.meeting ? { meeting: d.meeting } : {}) });
    } else if (r.kind === "quest") {
      // Quests written into the lore join the ones in code; a later load replaces the earlier copy.
      const q = r.data as unknown as QuestDef;
      const at = QUESTS.findIndex((x) => x.id === q.id);
      if (at >= 0) QUESTS[at] = q; else QUESTS.push(q);
    }
  }
  for (const p of Object.values(next.people)) p.pieces = p.pieces.filter((x) => typeof x === "string");
  setPlaces(places);
  current = next;
  loadedAt = Date.now();
  return current;
}

/** What the narrator gets about how someone looks: the description, and their manner if they have one. Nothing if there's none. */
export function looksOf(name: string): { looks?: string; manner?: string } {
  const l = current.looks[name];
  return l ? { looks: l.look, ...(l.manner ? { manner: l.manner } : {}) } : {};
}

/** The lore as last loaded. Call loadLore() first in anything that isn't inside a request. */
export const lore = (): Lore => current;
export const PIECE_NAMES = ["past", "personal", "secret"] as const;
export const personKey = (name: string, n: number) => `person:${name}:${n}`;

/** How many pieces of this person's past the player has heard, and whether one came today. */
export async function heardOf(c: pg.PoolClient | pg.Pool, playerId: string, name: string, day: string): Promise<{ n: number; today: boolean }> {
  const r = (await c.query<{ n: string; today: boolean }>(
    "select count(*)::text as n, coalesce(bool_or(day = $3::date), false) as today from player_lore where player_id = $1 and key like $2",
    [playerId, `person:${name.replace(/[%_]/g, "\\$&")}:%`, day])).rows[0];
  return { n: Number(r?.n ?? 0), today: Boolean(r?.today) };
}

/** Chance that a first talk of the day lets the next piece slip, and that a journal turns up where one could. */
export const PAST_CHANCE = Number(process.env.DRAGONS_DOOR_PAST_CHANCE ?? 0.5);
/** Days between journal finds, at least. */
export const JOURNAL_EVERY_DAYS = Number(process.env.DRAGONS_DOOR_JOURNAL_DAYS ?? 3);
export const JOURNAL_CHANCE = { wild: 0.05, cave: 0.06, town: 0.04, ironhold: 0.08, ashford: 0.08, scale: Number(process.env.DRAGONS_DOOR_JOURNAL_SCALE ?? 1) };
