/**
 * Load the realm's lore from a private JSON file into the lore table. The file never goes in this
 * repo. Rows not in the file are removed, so the file is the whole truth.
 *
 *   npx tsx src/lore-sync.ts /path/to/lore.json          writes to DATABASE_URL
 *   npx tsx src/lore-sync.ts /path/to/lore.json --sql    prints the SQL instead (for running elsewhere)
 *
 * File shape: { world, people: { name: { pieces: [..], mentions?: [..] } }, masters: { level: { name, about } },
 *               journals: [{ key, title, text, where, author?, min_ring? }], quests: [QuestDef with index >= 100],
 *               looks: { name: { look, manner? } } }
 */
import { readFileSync } from "node:fs";

interface File {
  world?: string;
  people?: Record<string, { pieces: string[]; mentions?: string[] }>;
  masters?: Record<string, { name: string; about: string }>;
  ironMasters?: Record<string, { name: string; about: string }>;
  ashMasters?: Record<string, { name: string; about: string }>;
  places?: { key: string; x: number; y: number; name: string; poi: string; about?: string; meeting?: number }[];
  journals?: { key: string; title: string; text: string; where: string; author?: string | null; min_ring?: number }[];
  quests?: ({ id: string; index?: number } & Record<string, unknown>)[];
  looks?: Record<string, { look: string; manner?: string }>;
  riddles?: { key: string; text: string; answers: string[]; realm?: boolean }[];
}
type Row = { key: string; kind: string; subject: string | null; piece: number | null; body: string; data: Record<string, unknown> };

const [path, flag] = process.argv.slice(2);
if (!path) { console.error("usage: lore-sync.ts <lore.json> [--sql]"); process.exit(1); }
const f = JSON.parse(readFileSync(path, "utf8")) as File;
const rows: Row[] = [];
if (f.world) rows.push({ key: "world", kind: "world", subject: null, piece: null, body: f.world, data: {} });
for (const [name, p] of Object.entries(f.people ?? {})) {
  p.pieces.forEach((body, i) => rows.push({ key: `person:${name}:${i}`, kind: "person", subject: name, piece: i, body, data: {} }));
  (p.mentions ?? []).forEach((body, i) => rows.push({ key: `mention:${name}:${i}`, kind: "mention", subject: name, piece: i, body, data: {} }));
}
for (const [lvl, m] of Object.entries(f.masters ?? {})) rows.push({ key: `master:${lvl}`, kind: "master", subject: m.name, piece: Number(lvl), body: m.about, data: {} });
for (const [lvl, m] of Object.entries(f.ironMasters ?? {})) rows.push({ key: `master:ironhold:${lvl}`, kind: "master", subject: m.name, piece: Number(lvl), body: m.about, data: { town: "ironhold" } });
for (const [lvl, m] of Object.entries(f.ashMasters ?? {})) rows.push({ key: `master:ashford:${lvl}`, kind: "master", subject: m.name, piece: Number(lvl), body: m.about, data: { town: "ashford" } });
for (const pl of f.places ?? []) rows.push({ key: `place:${pl.key}`, kind: "place", subject: pl.key, piece: null, body: pl.about ?? "", data: { x: pl.x, y: pl.y, name: pl.name, poi: pl.poi, ...(pl.meeting ? { meeting: pl.meeting } : {}) } });
for (const j of f.journals ?? []) rows.push({ key: `journal:${j.key}`, kind: "journal", subject: j.title, piece: null, body: j.text, data: { where: j.where, author: j.author ?? null, min_ring: j.min_ring ?? 0 } });
for (const r of f.riddles ?? []) rows.push({ key: `riddle:${r.key}`, kind: "riddle", subject: r.key, piece: null, body: r.text, data: { answers: r.answers, ...(r.realm ? { realm: true } : {}) } });
for (const [name, l] of Object.entries(f.looks ?? {})) rows.push({ key: `look:${name}`, kind: "look", subject: name, piece: null, body: l.look, data: l.manner ? { manner: l.manner } : {} });
for (const q of f.quests ?? []) {
  if ((q.index ?? 0) < 100) throw new Error(`quest ${q.id} needs an index of 100 or more`);
  rows.push({ key: `quest:${q.id}`, kind: "quest", subject: q.id, piece: null, body: "", data: q });
}

const lit = (v: unknown) => v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const values = rows.map((r) => `(${lit(r.key)}, ${lit(r.kind)}, ${lit(r.subject)}, ${lit(r.piece)}, ${lit(r.body)}, ${lit(JSON.stringify(r.data))}::jsonb)`);
const sql = `begin;
insert into lore (key, kind, subject, piece, body, data) values
${values.join(",\n")}
on conflict (key) do update set kind = excluded.kind, subject = excluded.subject, piece = excluded.piece, body = excluded.body, data = excluded.data, updated_at = now();
delete from lore where key not in (${rows.map((r) => lit(r.key)).join(", ")});
commit;`;

if (flag === "--sql") console.log(sql);
else {
  const { pool } = await import("./db.js");
  await pool.query(sql);
  console.log(`lore: ${rows.length} rows (${rows.filter((r) => r.kind === "person").length} pieces of pasts, ${rows.filter((r) => r.kind === "journal").length} journals, ${rows.filter((r) => r.kind === "quest").length} quests)`);
  await pool.end();
}
