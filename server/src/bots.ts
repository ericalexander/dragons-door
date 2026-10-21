/**
 * Bots: townsfolk who play every day so the realm is never empty.
 *
 * Each bot is a normal player row with a key. The runner plays it by calling the
 * same Hono routes a human's plugin would (api.request), so bots obey every rule:
 * ten fights, the same dice, they die, they lose their gold.
 *
 * Each townsperson's day is split into sessions at set Eastern times, shifted by a
 * random-but-stable amount each day. Vercel Cron wakes the runner every 15 minutes;
 * it plays whatever sessions are due and records them so nothing runs twice.
 */
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { api } from "./api.js";
import { INTERNAL_TOKEN } from "./request.js";
import { pool } from "./db.js";
import { roll } from "./combat.js";
import { createHash } from "node:crypto";
import { realmDay, realmSettings } from "./day.js";
import type { Envelope, Event } from "./game.js";

export const bots = new Hono();

type Personality = "banker" | "drunk" | "raider" | "gossip" | "pious" | "reckless" | "seer" | "braggart";

const ROSTER: { name: string; class: "warrior" | "thief" | "mage"; personality: Personality }[] = [
  { name: "Hilde", class: "warrior", personality: "banker" },
  { name: "Grimwald", class: "warrior", personality: "drunk" },
  { name: "Vesper", class: "thief", personality: "raider" },
  { name: "Old Tam", class: "mage", personality: "gossip" },
  { name: "Brother Ansel", class: "mage", personality: "pious" },
  { name: "Pip", class: "thief", personality: "reckless" },
  { name: "Madam Orsolya", class: "mage", personality: "seer" },
  { name: "Sir Pomfrey", class: "warrior", personality: "braggart" },
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
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}`, "x-dragons-door-app": "townsfolk", "x-dragons-door-internal": INTERNAL_TOKEN },
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

/** Townsfolk aren't sentimental: wear anything better, sell the rest, grab what's on the ground if it's better. */
async function tidyBag(b: Bot) {
  const r = await b.get("/bag");
  if (isErr(r)) return;
  const bagEv = r.events.find((e) => e.kind === "bag") as unknown as { items: { id: number; upgrade: boolean }[]; ground: unknown } | undefined;
  if (!bagEv) return;
  if (bagEv.ground) { const e = await b.post("/equip", { ground: true }); if (isErr(e) || !kinds(e).includes("equipped")) await b.post("/take"); }
  for (const it of bagEv.items) if (it.upgrade) await b.post("/equip", { id: it.id });
  const again = await b.get("/bag");
  if (isErr(again)) return;
  const left = (again.events.find((e) => e.kind === "bag") as unknown as { items: { id: number }[] }).items;
  for (const it of left) await b.post("/sell", { id: it.id });
}

// ---------- session building blocks ----------

interface FightStyle { runBelow?: number; useSpecial?: boolean; healBelow: number }
const STYLE: Record<Personality, FightStyle> = {
  banker: { runBelow: 0.3, healBelow: 0.5 },
  drunk: { useSpecial: true, healBelow: 0.35 },
  raider: { runBelow: 0.25, healBelow: 0.6 },
  gossip: { runBelow: 0.5, healBelow: 0.5 },
  pious: { runBelow: 0.6, useSpecial: true, healBelow: 0.8 },   // never takes a risk
  reckless: { healBelow: 0.15 },                                 // never runs, barely heals
  seer: { useSpecial: true, runBelow: 0.35, healBelow: 0.5 },
  braggart: { runBelow: 0.45, healBelow: 0.7 },                  // brave in the tavern, quick in the forest
};

async function fights(b: Bot, n: number) {
  const st = STYLE[b.personality];
  let done = 0;
  for (let i = 0; i < n; i++) {
    const r = await forestFight(b, st);
    if (!r) break;
    if (r.events.some((e) => e.kind === "no_fights_left")) break;
    done++;
    if (!r.state.alive) { b.log.push("died in the forest"); return; }
    await healIfNeeded(b, r, st.healBelow);
    await trainIfReady(b, r);
  }
  b.log.push(`${done} forest fight${done === 1 ? "" : "s"}`);
}

async function bedInn(b: Bot) {
  await tidyBag(b);
  await b.post("/inn");
  await b.post("/bank", { op: "deposit", amount: "all" });
  b.log.push("bed at the inn");
}

async function drunkNight(b: Bot) {
  // Never banks, never pays for a bed. Asleep in the fields with whatever he won.
  await tidyBag(b);
  await b.post("/flirt");
  await b.post("/bard");
  if (roll(99) < 60) {
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
  b.log.push("drinking, then the fields");
}

async function raid(b: Bot) {
  // Late at night: rob whoever went to bed in the fields with the most gold. One attempt.
  const me = await b.get("/status");
  if (isErr(me) || !me.state.alive) { b.log.push("no raid (dead)"); return; }
  await b.post("/healer", { hp: "all" });
  const target = await pool.query<{ name: string }>(
    `select name from players
     where alive and location = 'fields' and gold > 0 and name <> $1
       and abs(level - $2) <= 3 and created_at < now() - interval '24 hours'
     order by gold desc, level desc limit 1`,
    [b.name, me.state.level],
  );
  if (!target.rowCount) { b.log.push("raid: nobody worth robbing"); return; }
  const c = await b.post("/challenge", { name: target.rows[0].name });
  b.log.push(`raid on ${target.rows[0].name}: ${isErr(c) ? c.error : kinds(c).filter((k) => k.startsWith("pvp_") && k !== "pvp_log").join(",") || kinds(c).join(",")}`);
}

async function gossip(b: Bot) {
  // Reads yesterday's paper and leaves a line about it.
  const news = await b.get("/news?day=yesterday");
  let line = "Quiet night. Too quiet. Somebody go poke the forest.";
  if (!isErr(news)) {
    type NewsEvent = Event & { what: string; actor?: string; target?: string; detail: Record<string, unknown> };
    const items = news.events.filter((e) => e.kind === "news") as NewsEvent[];
    const kills = items.filter((e) => e.what === "pvp_kill");
    const deaths = items.filter((e) => e.what === "forest_death");
    const levels = items.filter((e) => e.what === "level_up");
    const loot = items.filter((e) => e.what === "loot");
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
    } else if (loot.length) {
      const l = pick(loot);
      line = `${l.actor} is walking around with a ${l.detail.item} off a dead ${l.detail.monster} like they forged it themselves.`;
    } else if (levels.length) {
      const l = pick(levels);
      line = `${l.actor} made level ${l.detail.level}. Don't let it go to your head, I remember when you fought a mosquito.`;
    }
  }
  await b.post("/tavern", { body: line.slice(0, 280) });
  b.log.push("posted in the tavern");
}


const pick = <T,>(a: T[]): T => a[roll(a.length - 1)];
type NewsEvent = Event & { what: string; actor?: string; target?: string; detail: Record<string, unknown> };
async function yesterday(b: Bot): Promise<NewsEvent[]> {
  const news = await b.get("/news?day=yesterday");
  return isErr(news) ? [] : (news.events.filter((e) => e.kind === "news") as NewsEvent[]);
}
const say = async (b: Bot, line: string) => { await b.post("/tavern", { body: line.slice(0, 280) }); };

async function prayers(b: Bot) {
  // Brother Ansel: a word for the dead, or a proverb nobody asked for.
  const dead = (await yesterday(b)).filter((e) => e.what === "forest_death" || e.what === "pvp_kill");
  if (dead.length && roll(99) < 75) {
    const d = pick(dead);
    const who = d.what === "pvp_kill" ? d.target : d.actor;
    await say(b, pick([
      `I lit a candle for ${who} this morning. The candle did better than they did.`,
      `Prayers for ${who}, who met the ground yesterday. Rise slower next time, friend.`,
      `${who} is at rest. Briefly. The realm is not known for letting people stay dead.`,
    ]));
  } else {
    await say(b, pick([
      "The patient man reaches the inn. The impatient man reaches the healer.",
      "Run when you are winning. That is what makes it a habit.",
      "Every beast in the forest was once a small beast. Remember this when it is large.",
      "Gold in the bank is gold that sleeps soundly. So do you.",
      "I have been asked to stop blessing the ale. I will not be stopping.",
      "Pride is a heavy coat. Ask Sir Pomfrey; he wears two.",
    ]));
  }
  b.log.push("a word in the tavern");
}

async function brag(b: Bot) {
  // Pip, after a day in the forest: delighted with himself, whatever happened.
  const me = await b.get("/status");
  if (isErr(me) || !me.state.alive) return;
  const s = me.state;
  await say(b, pick([
    `Did ten fights today! Hilde says that's not how you count, but it is.`,
    `Level ${s.level} now. Grimwald says that's nothing. Grimwald was asleep in a ditch.`,
    `I'm keeping my ${s.gold} gold on me. Banks are for people who are scared.`,
    `Something in the forest bit me and I bit it back. We're even.`,
    `Hit something with my ${s.weapon} so hard it said sorry. Didn't help it.`,
    `Sleeping out in the fields tonight under the stars. Nobody bothers a stable lad.`,
  ]));
  b.log.push("bragged in the tavern");
}

async function fortune(b: Bot) {
  // Madam Orsolya reads the cards for whoever sleeps richest in the fields. Vesper reads the same cards.
  const r = await pool.query<{ name: string; gold: string }>(
    `select name, gold::text from players where alive and location = 'fields' and gold > 0 and name <> $1
     order by gold desc limit 1`, [b.name]);
  const top = await pool.query<{ name: string }>("select name from players where name <> $1 order by level desc, exp desc limit 1", [b.name]);
  if (r.rowCount && roll(99) < 70) {
    const t = r.rows[0].name;
    await say(b, pick([
      `The cards turned up ${t} and the Tower. I would sleep at the inn tonight, dear. I would.`,
      `I see gold leaving ${t}'s pockets before the moon is down. I do not see it coming back.`,
      `${t}. A knife. A field. I'm only the messenger.`,
    ]));
  } else if (top.rowCount && roll(99) < 60) {
    const t = top.rows[0].name;
    await say(b, pick([
      `${t} stands at the top of the board. The cards have seen many people stand there. Briefly.`,
      `I drew the Wheel for ${t}. It goes round. That's the whole point of a wheel.`,
    ]));
  } else {
    await say(b, pick([
      "The cards are quiet tonight. That's never good.",
      "Someone in this room will meet a dragon. Someone in this room will not enjoy it.",
      "Cross my palm with gold and I'll tell you your future. Don't, and I'll tell you anyway.",
      "I see a stranger arriving soon. Be kind. Then rob them, if you must.",
    ]));
  }
  b.log.push("told a fortune");
}

async function shop(b: Bot) {
  // Sir Pomfrey: buys the finest thing he can afford, every time. Then the next finest.
  await b.post("/bank", { op: "withdraw", amount: "all" });
  for (const kind of ["weapon", "armor"] as const) {
    const cat = await b.get(`/shop?kind=${kind}`);
    if (isErr(cat)) continue;
    const ev = cat.events.find((e) => e.kind === "catalog") as unknown as { owned: number; items: { id: number; cost: number; name: string }[] };
    const owned = ev.items.find((i) => i.id === ev.owned);
    const tradeIn = Math.floor((owned?.cost ?? 0) / 2);
    const gold = cat.state.gold;
    const best = ev.items.filter((i) => i.id > ev.owned && i.cost - tradeIn <= gold).sort((a, z) => z.id - a.id)[0];
    if (best) {
      const r = await b.post("/buy", { kind, id: best.id });
      if (!isErr(r) && kinds(r).includes("bought")) b.log.push(`bought ${best.name}`);
    }
  }
}

async function boast(b: Bot) {
  const me = await b.get("/status");
  if (isErr(me) || !me.state.alive) return;
  const s = me.state;
  await say(b, pick([
    `Some of you may have noticed my ${s.weapon}. You may continue noticing it.`,
    `My ${s.armor} was fitted by a man who fitted a duke. A minor duke. Still.`,
    `Level ${s.level}, and I've not run from a single fight I couldn't have won.`,
    `A Pomfrey does not flee. A Pomfrey repositions with dignity.`,
    `Violet laughed at my joke today. Violet laughs at everyone's jokes, she says. Mine was different.`,
    `I'd challenge the dragon myself, but it would be unsporting. To the dragon.`,
  ]));
  b.log.push("boasted in the tavern");
}

async function sleepRough(b: Bot) {
  // Pip never banks and never pays for a bed.
  await tidyBag(b);
  b.log.push("asleep in the fields");
}

// ---------- the townsfolk's day (Eastern time) ----------

type Step = (b: Bot) => Promise<void>;
interface Session { at: string; steps: Step[] }
const f = (n: number): Step => (b) => fights(b, n);
const flirt: Step = async (b) => { await b.post("/flirt"); };
const song: Step = async (b) => { await b.post("/bard"); };

const SCHEDULE: Record<Personality, Session[]> = {
  banker: [ // Hilde: steady all day, banks and beds down at dinner
    { at: "07:00", steps: [f(4)] },
    { at: "12:00", steps: [f(3)] },
    { at: "18:00", steps: [f(3), bedInn] },
  ],
  gossip: [ // Old Tam: paper first, a little fighting, early to bed
    { at: "08:00", steps: [gossip] },
    { at: "14:00", steps: [f(3)] },
    { at: "21:00", steps: [flirt, bedInn] },
  ],
  drunk: [ // Grimwald: late riser, fights hard, ends up in the fields
    { at: "11:00", steps: [f(5)] },
    { at: "15:00", steps: [f(5)] },
    { at: "20:00", steps: [drunkNight] },
  ],
  raider: [ // Vesper: fights by day, robs the fields late at night
    { at: "10:00", steps: [f(5)] },
    { at: "14:00", steps: [f(5)] },
    { at: "23:00", steps: [raid, bedInn] },
  ],
  pious: [ // Brother Ansel: up before dawn, careful all day, in bed by evening prayers
    { at: "05:30", steps: [f(3)] },
    { at: "09:00", steps: [prayers] },
    { at: "13:00", steps: [f(4)] },
    { at: "19:00", steps: [f(3), bedInn] },
  ],
  reckless: [ // Pip: chores all day, then every fight at once, then the fields
    { at: "16:00", steps: [f(10), brag, sleepRough] },
  ],
  seer: [ // Madam Orsolya: wakes at dusk, reads the cards for the night ahead
    { at: "17:00", steps: [f(5)] },
    { at: "22:30", steps: [fortune, f(5), bedInn] },
  ],
  braggart: [ // Sir Pomfrey: shopping first, a little fighting, a lot of talking
    { at: "09:30", steps: [shop, f(3)] },
    { at: "13:00", steps: [f(3), boast] },
    { at: "17:30", steps: [f(4), shop, flirt, song, bedInn] },
  ],
};

const JITTER_MIN = 30;
const TZ = "America/New_York";

/** Stable per-day shift in minutes, in [-JITTER_MIN, +JITTER_MIN], so a rerun picks the same time. */
function jitter(day: string, name: string, i: number): number {
  const h = createHash("sha256").update(`${day}|${name}|${i}`).digest();
  return (h.readUInt16BE(0) % (2 * JITTER_MIN + 1)) - JITTER_MIN;
}

/** Offset of TZ from UTC at instant t, in ms. */
function tzOffset(t: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - t;
}

/** The instant a session happens on a given realm day: `at` Eastern on that calendar date, plus jitter. */
export function sessionTime(day: string, at: string, name: string, i: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = at.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const utc = guess - tzOffset(guess);
  return new Date(utc + jitter(day, name, i) * 60_000);
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
      headers: { "content-type": "application/json", "x-dragons-door-internal": INTERNAL_TOKEN },
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

export async function runBots(now = new Date()): Promise<{ day: string; now: string; results: Record<string, string[]> }> {
  const roster = await ensureRoster();
  const c = await pool.connect();
  let day: string;
  try { day = realmDay((await realmSettings(c)).resetHourUtc, now); } finally { c.release(); }
  const results: Record<string, string[]> = {};
  for (const row of roster) {
    const st = await pool.query<{ sessions: { day?: string; done?: number[] } }>("select sessions from bots where player_id = $1", [row.player_id]);
    const rec = st.rows[0]?.sessions ?? {};
    const done = new Set(rec.day === day ? rec.done ?? [] : []);
    const plan = SCHEDULE[row.personality];
    const due = plan.map((s, i) => ({ s, i, at: sessionTime(day, s.at, row.name, i) })).filter((x) => !done.has(x.i) && x.at <= now);
    if (!due.length) continue;
    const b = new Bot(row.name, row.personality, row.api_key);
    for (const { s, i, at } of due) {
      b.log.push(`session ${i + 1} (${at.toISOString().slice(11, 16)}Z)`);
      try {
        const status = await b.get("/status");
        if (isErr(status)) { b.log.push(`status failed: ${status.error}`); }
        else if (!status.state.alive) { b.log.push("dead until the reset"); }
        else for (const step of s.steps) await step(b);
      } catch (e) {
        b.log.push(`error: ${(e as Error).message}`);
      }
      done.add(i);
      await pool.query("update bots set sessions = $2, last_run_day = $3 where player_id = $1", [row.player_id, JSON.stringify({ day, done: [...done].sort() }), day]);
    }
    results[row.name] = b.log;
  }
  return { day, now: now.toISOString(), results };
}

// Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET". Manual runs can POST the same header.
bots.on(["GET", "POST"], "/bots/run", async (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "forbidden" }, 403);
  // A fake clock is for local testing only.
  const fake = (process.env.DRAGONS_DOOR_ALLOW_FAKE_CLOCK ?? process.env.LORD_ALLOW_FAKE_CLOCK) ? c.req.query("now") : undefined;
  const out = await runBots(fake ? new Date(fake) : new Date());
  return c.json(out);
});
