/**
 * Bots: townsfolk who play every day so the realm is never empty.
 *
 * Each bot is a normal player row with a key. The runner plays it by calling the
 * same Hono routes a human's plugin would (api.request), so bots obey every rule:
 * ten fights, the same dice, they die, they lose their gold.
 *
 * Triggered once a day by Vercel Cron shortly after the realm reset.
 */
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { api } from "./api.js";
import { pool } from "./db.js";
import { roll } from "./combat.js";
import type { Envelope, Event } from "./game.js";

export const bots = new Hono();

type Personality = "banker" | "drunk" | "raider" | "gossip";

const ROSTER: { name: string; class: "warrior" | "thief" | "mage"; personality: Personality }[] = [
  { name: "Hilde", class: "warrior", personality: "banker" },
  { name: "Grimwald", class: "warrior", personality: "drunk" },
  { name: "Vesper", class: "thief", personality: "raider" },
  { name: "Old Tam", class: "mage", personality: "gossip" },
];

// ---------- auth ----------

function authorized(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = header?.replace(/^Bearer\s+/i, "") ?? "";
  if (given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

// ---------- calling the game as a bot ----------

class Bot {
  log: string[] = [];
  constructor(public name: string, public personality: Personality, private key: string) {}

  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Envelope | { error: string; message?: string }> {
    const res = await api.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Envelope | { error: string };
  }

  async get(path: string) { return this.call("GET", path); }
  async post(path: string, body?: unknown) { return this.call("POST", path, body); }
}

const isErr = (r: unknown): r is { error: string } => typeof r === "object" && r !== null && "error" in r;
const kinds = (r: Envelope) => r.events.map((e) => e.kind);

/** Run one forest fight to the end. Returns the final envelope or null if the bot couldn't fight. */
async function forestFight(b: Bot, opts: { runBelow?: number; useSpecial?: boolean }): Promise<Envelope | null> {
  let r = await b.post("/forest");
  if (isErr(r)) return null;
  if (!kinds(r).includes("encounter")) return r; // found gold, or no fights left
  for (let i = 0; i < 60; i++) {
    const s = r.state;
    let action: "attack" | "special" | "run" = "attack";
    if (opts.runBelow !== undefined && s.hp / s.max_hp < opts.runBelow && i > 0) action = "run";
    else if (opts.useSpecial && s.specials > 0 && roll(99) < 50) action = "special";
    const next = await b.post("/fight", { action });
    if (isErr(next)) return r;
    r = next;
    const k = kinds(r);
    if (k.some((x) => ["monster_slain", "player_died", "fled", "level_up", "dragon_slain"].includes(x))) break;
    if (!r.state.in_encounter) break;
  }
  return r;
}

async function trainIfReady(b: Bot, r: Envelope | null) {
  if (!r || !r.actions.includes("train")) return;
  const t = await b.post("/train");
  if (isErr(t) || !kinds(t).includes("master_challenge")) return;
  for (let i = 0; i < 80; i++) {
    const f = await b.post("/fight", { action: "attack" });
    if (isErr(f) || !f.state.in_encounter) { if (!isErr(f) && kinds(f).includes("level_up")) b.log.push("leveled up"); break; }
  }
}

async function healIfNeeded(b: Bot, r: Envelope | null, below: number) {
  if (!r || !r.state.alive) return;
  if (r.state.hp / r.state.max_hp < below) await b.post("/healer", { hp: "all" });
}

// ---------- personalities ----------

async function playBanker(b: Bot) {
  // Grinds carefully, banks everything, always sleeps at the inn. The one to catch.
  let r: Envelope | null = null;
  for (let i = 0; i < 10; i++) {
    r = await forestFight(b, { runBelow: 0.3 });
    if (!r || !r.state.alive || r.state.forest_fights === 0) break;
    await healIfNeeded(b, r, 0.5);
    await trainIfReady(b, r);
  }
  await b.post("/inn");
  await b.post("/bank", { op: "deposit", amount: "all" });
}

async function playDrunk(b: Bot, day: string) {
  // Fights hard, drinks harder, never banks, sleeps in the fields. A gold piñata.
  let r: Envelope | null = null;
  for (let i = 0; i < 10; i++) {
    r = await forestFight(b, { useSpecial: true });
    if (!r || !r.state.alive || r.state.forest_fights === 0) break;
    await healIfNeeded(b, r, 0.35);
    await trainIfReady(b, r);
  }
  await b.post("/flirt");
  if (roll(99) < 50) {
    const lines = [
      "Anyone seen my boots? Woke up in the fields again.",
      "The mosquitoes out there are getting ideas above their station.",
      "I don't need a bank. I need another round.",
      "If you find a warrior asleep under the oak, that's me. Don't.",
      "Violet says I've had enough. Violet is not the boss of me.",
      "Bought a Stick today. Big day.",
    ];
    await b.post("/tavern", { body: lines[roll(lines.length - 1)] });
  }
  void day;
}

async function playRaider(b: Bot) {
  // Grinds, then robs whoever is sleeping in the fields with the most gold. One kill a day at most.
  let r: Envelope | null = null;
  for (let i = 0; i < 10; i++) {
    r = await forestFight(b, { runBelow: 0.25 });
    if (!r || !r.state.alive || r.state.forest_fights === 0) break;
    await healIfNeeded(b, r, 0.6);
    await trainIfReady(b, r);
  }
  if (r && r.state.alive) {
    await b.post("/healer", { hp: "all" });
    const me = await b.get("/status");
    if (!isErr(me)) {
      const lvl = me.state.level;
      const target = await pool.query<{ name: string }>(
        `select name from players
         where alive and location = 'fields' and gold > 0 and name <> $1
           and abs(level - $2) <= 3
         order by gold desc, level desc limit 1`,
        [b.name, lvl],
      );
      if (target.rowCount) {
        const c = await b.post("/challenge", { name: target.rows[0].name });
        if (!isErr(c)) b.log.push(`challenged ${target.rows[0].name}: ${kinds(c).filter((k) => k.startsWith("pvp_") && k !== "pvp_log").join(",")}`);
      }
    }
  }
  await b.post("/inn");
  await b.post("/bank", { op: "deposit", amount: "all" });
}

async function playGossip(b: Bot) {
  // Fights a little, talks a lot. Reads yesterday's news and leaves a line about it.
  for (let i = 0; i < 3; i++) {
    const r = await forestFight(b, { runBelow: 0.5 });
    if (!r || !r.state.alive) break;
    await healIfNeeded(b, r, 0.5);
    await trainIfReady(b, r);
  }
  const news = await b.get("/news?day=yesterday");
  let line = "Quiet night. Too quiet. Somebody go poke the forest.";
  if (!isErr(news)) {
    type NewsEvent = Event & { what: string; actor?: string; target?: string; detail: Record<string, unknown> };
    const items = news.events.filter((e) => e.kind === "news") as NewsEvent[];
    const kills = items.filter((e) => e.what === "pvp_kill");
    const deaths = items.filter((e) => e.what === "forest_death");
    const levels = items.filter((e) => e.what === "level_up");
    const pick = <T,>(a: T[]) => a[roll(a.length - 1)];
    if (kills.length) {
      const k = pick(kills);
      line = pick([
        `Heard ${k.actor} found ${k.target} asleep in the fields. ${k.detail.gold} gold lighter this morning. Bank it, children.`,
        `${k.target} owes me a drink and now can't pay. Thank ${k.actor} for that.`,
      ]);
    } else if (deaths.length) {
      const d = pick(deaths);
      line = pick([
        `A ${d.detail.monster} got ${d.actor}. The ${d.detail.monster}. I've shooed worse off my porch.`,
        `Pour one out for ${d.actor}. Then pour one for the ${d.detail.monster}, it earned it.`,
      ]);
    } else if (levels.length) {
      const l = pick(levels);
      line = `${l.actor} made level ${l.detail.level}. Don't let it go to your head, I remember when you fought a mosquito.`;
    }
  }
  await b.post("/tavern", { body: line.slice(0, 280) });
  await b.post("/flirt");
  await b.post("/inn");
  await b.post("/bank", { op: "deposit", amount: "all" });
}

// ---------- seeding and running ----------

async function ensureRoster(): Promise<{ player_id: string; name: string; personality: Personality; api_key: string }[]> {
  const existing = await pool.query<{ player_id: string; name: string; personality: Personality; api_key: string }>(
    "select b.player_id, p.name, b.personality, b.api_key from bots b join players p on p.id = b.player_id",
  );
  const have = new Set(existing.rows.map((r) => r.name));
  for (const spec of ROSTER) {
    if (have.has(spec.name)) continue;
    const res = await api.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: spec.name, class: spec.class }),
    });
    const j = (await res.json()) as { api_key?: string; error?: string };
    if (!j.api_key) continue; // name taken by a human, or similar; skip rather than fight over it
    const p = await pool.query<{ id: string }>("update players set is_bot = true where name = $1 returning id", [spec.name]);
    await pool.query("insert into bots (player_id, personality, api_key) values ($1,$2,$3)", [p.rows[0].id, spec.personality, j.api_key]);
    existing.rows.push({ player_id: p.rows[0].id, name: spec.name, personality: spec.personality, api_key: j.api_key });
  }
  return existing.rows;
}

export async function runBots(): Promise<{ day: string; results: Record<string, string[]> }> {
  const roster = await ensureRoster();
  const results: Record<string, string[]> = {};
  let day = "";
  for (const row of roster) {
    const b = new Bot(row.name, row.personality, row.api_key);
    const s = await b.get("/status");
    if (isErr(s)) { results[row.name] = [`status failed: ${s.error}`]; continue; }
    const today = (s.events.find((e) => e.kind === "new_day") as { day?: string } | undefined)?.day;
    const already = await pool.query("select 1 from bots where player_id = $1 and last_run_day = current_date", [row.player_id]);
    if (already.rowCount && !today) { results[row.name] = ["already ran today"]; continue; }
    if (!s.state.alive) { results[row.name] = ["dead today"]; continue; }
    try {
      switch (row.personality) {
        case "banker": await playBanker(b); break;
        case "drunk": await playDrunk(b, today ?? ""); break;
        case "raider": await playRaider(b); break;
        case "gossip": await playGossip(b); break;
      }
      const end = await b.get("/status");
      if (!isErr(end)) {
        day = day || today || "";
        b.log.push(`L${end.state.level} hp ${end.state.hp}/${end.state.max_hp} gold ${end.state.gold} bank ${end.state.bank} ${end.state.location} alive=${end.state.alive}`);
      }
    } catch (e) {
      b.log.push(`error: ${(e as Error).message}`);
    }
    await pool.query("update bots set last_run_day = current_date where player_id = $1", [row.player_id]);
    results[row.name] = b.log;
  }
  return { day, results };
}

// Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET". Manual runs can POST the same header.
bots.on(["GET", "POST"], "/bots/run", async (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "forbidden" }, 403);
  const out = await runBots();
  return c.json(out);
});
