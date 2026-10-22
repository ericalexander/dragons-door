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
import { PLAN, sessionTime, type Personality } from "./schedule.js";
export { sessionTime } from "./schedule.js";
import { pool } from "./db.js";
import { catchUp, writeEntry } from "./chronicle.js";
import { answerLetters } from "./letters.js";
import { roll } from "./combat.js";
import { createHash } from "node:crypto";
import { realmDay, realmSettings } from "./day.js";
import { GAME, type Envelope, type Event } from "./game.js";
import { DIRS, tileAt, type Dir } from "./world.js";
import { SUITORS, available } from "./romance.js";
import { MAX_DEPTH, PICKAXE_COST, SWINGS_PER_DAY, TRINKETS, canMake, caveLevel, trinket, type Trinket } from "./caves.js";
import { awayToday, choose, doneLine, finished, fraction, goalLabel, goalTalk, pickGoal, type Activity, type Facts, type Mind } from "./minds.js";

export const bots = new Hono();


const ROSTER: { name: string; class: "warrior" | "thief" | "mage" | "priest"; personality: Personality }[] = [
  { name: "Hilde", class: "warrior", personality: "banker" },
  { name: "Grimwald", class: "warrior", personality: "drunk" },
  { name: "Vesper", class: "thief", personality: "raider" },
  { name: "Old Tam", class: "mage", personality: "gossip" },
  { name: "Brother Ansel", class: "priest", personality: "pious" },
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
  /** Saving ore for jewelry: don't sell it. */
  keepOre = false;
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
    let action: "attack" | "special" | "heal" | "run" = "attack";
    // A priest prays before running.
    if (r.actions.includes("fight heal") && s.hp / s.max_hp < 0.4 && (s.mana ?? 0) >= 3) action = "heal";
    else if (opts.runBelow !== undefined && s.hp / s.max_hp < opts.runBelow && i > 0) action = "run";
    else if (opts.useSpecial && (s.mana_max !== undefined ? (s.mana ?? 0) >= 4 : s.specials > 0) && roll(99) < 50) action = "special";
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
  if (!r || !r.state.alive || r.state.exp_next === null || r.state.exp < r.state.exp_next) return;
  // Masters live in town, like everyone's.
  if (r.state.place) await b.post("/travel", { to: "town" });
  const t = await b.post("/train");
  if (isErr(t) || !kinds(t).includes("master_challenge")) return;
  for (let i = 0; i < 80; i++) {
    const f = await b.post("/fight", { action: "attack" });
    if (isErr(f) || !f.state.in_encounter) { if (!isErr(f) && kinds(f).includes("level_up")) b.log.push("leveled up"); break; }
  }
}

async function healIfNeeded(b: Bot, r: Envelope | null, below: number) {
  if (!r || !r.state.alive) return;
  if (r.state.hp / r.state.max_hp >= below) return;
  // The healer is in town. Walking home is free, and so is walking back to a place you know.
  const back = r.state.place ? { x: r.state.place.x, y: r.state.place.y } : null;
  if (back) await b.post("/travel", { to: "town" });
  await b.post("/healer", { hp: "all" });
  if (back) await b.post("/travel", back);
}

/**
 * Get to land that suits them, by the same rules as anyone: free to a place they know, a forest fight
 * a step into land they don't. Aims for a tile at or a level under their own (a bold one goes a level
 * over). Returns how many fights the walk cost.
 */
async function toHuntingGround(b: Bot, row: Row, mind: Mind, budget: number): Promise<number> {
  const me = await b.get("/status");
  if (isErr(me) || !me.state.alive) return 0;
  const level = me.state.level;
  const want = Math.max(1, level + ((mind.mood ?? 0) > 0 || row.personality === "reckless" ? 1 : 0));
  const ok = (l: number) => l >= Math.max(1, level - 1) && l <= want;
  if (me.state.place && ok(me.state.place.level)) return 0;
  const known = (await pool.query<{ x: number; y: number }>("select x, y from explored where player_id = $1", [row.player_id])).rows
    .map((t) => tileAt(t.x, t.y)).filter((t) => t.level <= want).sort((a, z) => z.level - a.level || Math.random() - 0.5);
  const best = known[0];
  if (best && ok(best.level)) { await b.post("/travel", { x: best.x, y: best.y }); return 0; }
  // Nowhere known is right: start from the best they know and walk out.
  if (best) await b.post("/travel", { x: best.x, y: best.y });
  const seen = new Set(known.map((t) => `${t.x},${t.y}`));
  let used = 0;
  for (; used < budget; ) {
    const s = await b.get("/status");
    if (isErr(s) || !s.state.alive || s.state.forest_fights <= 0) break;
    const [x, y] = s.state.place ? [s.state.place.x, s.state.place.y] : [0, 0];
    if (s.state.place && ok(s.state.place.level)) break;
    const steps = (Object.keys(DIRS) as Dir[]).map((d) => ({ d, t: tileAt(x + DIRS[d][0], y + DIRS[d][1]) }))
      .filter((o) => !(o.t.x === 0 && o.t.y === 0) && o.t.level <= want)
      .sort((a, z) => z.t.level - a.t.level || Number(seen.has(`${a.t.x},${a.t.y}`)) - Number(seen.has(`${z.t.x},${z.t.y}`)) || Math.random() - 0.5);
    if (!steps.length) break;
    const m = await b.post("/move", { dir: steps[0].d });
    if (isErr(m) || m.events.some((e) => e.kind === "no_fights_left")) break;
    used++;
    seen.add(`${steps[0].t.x},${steps[0].t.y}`);
  }
  return used;
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
  const left = (again.events.find((e) => e.kind === "bag") as unknown as { items: { id: number; slot: string }[] }).items;
  // Ore is kept while they're saving it up for Odile; otherwise everything goes.
  for (const it of left) if (!(b.keepOre && it.slot === "ore")) await b.post("/sell", { id: it.id });
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

async function fights(b: Bot, n: number, row?: Row, mind?: Mind) {
  const st = STYLE[b.personality];
  let done = 0;
  if (row) n -= await toHuntingGround(b, row, mind ?? {}, Math.max(0, n - 1));
  for (let i = 0; i < n; i++) {
    const r = await forestFight(b, st);
    if (!r) break;
    if (r.events.some((e) => e.kind === "no_fights_left")) break;
    done++;
    if (!r.state.alive) { b.log.push("died in the forest"); return; }
    await healIfNeeded(b, r, st.healBelow);
    const before = r.state.place;
    await trainIfReady(b, r);
    // Back out to the same spot after a trip to their master.
    if (before) { const now = await b.get("/status"); if (!isErr(now) && !now.state.place && now.state.alive) await b.post("/travel", { x: before.x, y: before.y }); }
  }
  const where = await b.get("/status");
  b.log.push(`${done} fight${done === 1 ? "" : "s"}${!isErr(where) && where.state.place ? ` near ${where.state.place.name}` : ""}`);
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
     where role <> 'npc' and not is_test and alive and location = 'fields' and gold > 0 and name <> $1
       and abs(level - $2) <= 3 and created_at < now() - interval '24 hours'
     order by gold desc, level desc limit 1`,
    [b.name, me.state.level],
  );
  if (!target.rowCount) { b.log.push("raid: nobody worth robbing"); return; }
  const c = await b.post("/challenge", { name: target.rows[0].name });
  b.log.push(`raid on ${target.rows[0].name}: ${isErr(c) ? c.error : kinds(c).filter((k) => k.startsWith("pvp_") && k !== "pvp_log").join(",") || kinds(c).join(",")}`);
}

async function gossip(b: Bot) {
  // Old Tam reads yesterday's paper and has something to say about it. Never the same line twice in a row of five.
  const news = await b.get("/news?day=yesterday");
  type NewsEvent = Event & { what: string; actor?: string; target?: string; detail: Record<string, unknown> };
  const items = isErr(news) ? [] : (news.events.filter((e) => e.kind === "news") as NewsEvent[]);
  const of = (what: string) => items.filter((e) => e.what === what);
  const pick = <T,>(a: T[]) => a[roll(a.length - 1)];
  const candidates: string[] = [];
  const add = (lines: string[]) => candidates.push(...lines);
  const a = (item: unknown) => { const t = String(item); return /'s |(Armor|Mail|Protection)$/.test(t) ? t : (/^[AEIOU]/i.test(t) ? "an " : "a ") + t; };

  for (const k of of("pvp_kill")) add([
    `Heard ${k.actor} found ${k.target} asleep in the fields. ${k.detail.gold} gold lighter this morning. Bank it, children.`,
    `${k.target} owes me a drink and now can't pay. Thank ${k.actor} for that.`,
    `${k.actor} walked off with ${k.detail.gold} of ${k.target}'s gold last night. In my day we at least said good evening first.`,
    `If you're wondering why ${k.target} is limping, ask ${k.actor}. Actually, don't. Just sleep at the inn.`,
  ]);
  for (const k of of("pvp_survived")) add([
    `${k.actor} went after ${k.target} in the night and came home flat on a plank. Good for ${k.target}.`,
    `Somebody tell ${k.actor} that ${k.target} sleeps with one eye open. Too late, I suppose.`,
  ]);
  for (const d of of("forest_death")) add([
    `A ${d.detail.monster} got ${d.actor}. The ${d.detail.monster}. I've shooed worse off my porch.`,
    `Pour one out for ${d.actor}. Then pour one for the ${d.detail.monster}, it earned it.`,
    `${d.actor} went into the woods with a plan. The ${d.detail.monster} had a better one.`,
    `They'll be back tomorrow, ${d.actor} will. They always are. The ${d.detail.monster} should be worried.`,
  ]);
  for (const m of of("married")) add([
    `${m.actor} married Violet. Again, someone. Every week it's someone. She's never once mentioned it to me.`,
    `Congratulations to ${m.actor} and Violet. I give it until the next pretty face walks in.`,
  ]);
  for (const l of of("loot")) add([
    `${l.actor} is walking around with ${a(l.detail.item)} off a dead ${l.detail.monster} like they forged it themselves.`,
    `${l.actor} pried ${a(l.detail.item)} off a ${l.detail.monster}. Washed it first, I hope.`,
  ]);
  for (const l of of("level_up")) add([
    `${l.actor} made level ${l.detail.level}. Don't let it go to your head, I remember when you fought a mosquito.`,
    `Level ${l.detail.level}, ${l.actor}. Your master must be getting soft.`,
    `${l.actor} came back from their master with a new swagger and a black eye. Level ${l.detail.level}, they tell me.`,
  ]);
  for (const d of of("dragon")) add([
    `${d.actor} killed the dragon. THE dragon. I'm going to need a minute, and a drink.`,
    `The dragon's dead and ${d.actor} did it. It'll be back by morning, mind. They always come back.`,
  ]);
  for (const d of of("dragon_death")) add([
    `${d.actor} went to see the dragon. The dragon saw them first.`,
  ]);
  if (!candidates.length) add([
    "Quiet night. Too quiet. Somebody go poke the forest.",
    "Nothing in the paper. Either everyone's behaving or the paper's lying. I know which I'd bet on.",
    "Not a single robbery last night. I'm almost disappointed in you all.",
    "Slow day yesterday. I spent most of it watching Grimwald try to find his other boot.",
    "No news is good news, my mother said. She never lived here.",
    "I've been in this chair since before the dragon had teeth, and I've never seen a duller day than yesterday.",
  ]);

  // Don't repeat any of his last five posts.
  const recent = await pool.query<{ body: string }>("select body from tavern where author = $1 order by id desc limit 5", [b.name]);
  const said = new Set(recent.rows.map((r) => r.body));
  const fresh = candidates.map((l) => l.slice(0, 280)).filter((l) => !said.has(l));
  const line = pick(fresh.length ? fresh : candidates).slice(0, 280);
  await b.post("/tavern", { body: line });
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
    `select name, gold::text from players where role <> 'npc' and not is_test and alive and location = 'fields' and gold > 0 and name <> $1
     order by gold desc limit 1`, [b.name]);
  const top = await pool.query<{ name: string }>("select name from players where role <> 'npc' and not is_test and name <> $1 order by level desc, exp desc limit 1", [b.name]);
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

// ---------- the townsfolk's day ----------
//
// The timetable (PLAN in schedule.ts) says when each of them is up and about. What they do in each
// session is their own choice, made fresh from their goal, their needs and their mood (minds.ts).

/** Roughly how many forest fights each session is good for, index for index with PLAN. */
export const FIGHTS: Record<Personality, number[]> = {
  banker: [4, 3, 3],
  gossip: [2, 3, 2],
  drunk: [5, 5, 2],
  raider: [5, 5, 2],
  pious: [3, 2, 4, 3],
  reckless: [10],
  seer: [5, 5],
  braggart: [3, 3, 4],
};

interface Row { player_id: string; name: string; personality: Personality; api_key: string; mind: Mind }

type Gathered = Facts & { pos: [number, number] | null; location: string; class: string; pickaxe: boolean; gems: number; ore: Record<number, number>; cave: { name: string; x: number; y: number } | null };
async function gatherFacts(row: Row, mind: Mind): Promise<Gathered> {
  const p = (await pool.query<{ level: number; gold: string; bank: string; weapon_id: number; armor_id: number; married: boolean; pos_x: number | null; pos_y: number | null; location: string; class: string; trinket_id: number; pickaxe: boolean; gems: number }>(
    "select level, gold::text, bank::text, weapon_id, armor_id, spouse_id is not null as married, pos_x, pos_y, location, class, trinket_id, pickaxe, gems from players where id = $1", [row.player_id])).rows[0];
  const ex = (await pool.query<{ n: string; far: number }>(
    "select count(*)::text as n, coalesce(max(greatest(abs(x), abs(y))), 0) as far from explored where player_id = $1", [row.player_id])).rows[0];
  const cave = (await pool.query<{ name: string; x: number; y: number }>(
    "select d.name, d.x, d.y from explored e join discoveries d on d.x = e.x and d.y = e.y where e.player_id = $1 and d.poi = 'cave' order by abs(d.x) + abs(d.y) limit 1", [row.player_id])).rows[0];
  const rival = (await pool.query<{ name: string; level: number }>(
    "select p.name, p.level from bots b join players p on p.id = b.player_id where p.id <> $1 order by p.level desc, p.exp desc limit 1", [row.player_id])).rows[0];
  const rivalLevel = mind.goal?.rival
    ? (await pool.query<{ level: number }>("select level from players where name = $1", [mind.goal.rival])).rows[0]?.level ?? null
    : null;
  const ore: Record<number, number> = {};
  for (const r of (await pool.query<{ item_id: number; n: string }>("select item_id, count(*)::text as n from inventory where player_id = $1 and slot = 'ore' group by item_id", [row.player_id])).rows) ore[r.item_id] = Number(r.n);
  return {
    trinket_id: p.trinket_id, pickaxe: p.pickaxe, gems: p.gems, ore, cave: cave ?? null,
    name: row.name, personality: row.personality, level: p.level, gold: Number(p.gold), bank: Number(p.bank),
    weapon_id: p.weapon_id, armor_id: p.armor_id, married: p.married, explored: Number(ex.n), farthest: Number(ex.far),
    found_cave: cave?.name ?? null, top_rival: rival ?? null, rival_level: rivalLevel,
    pos: p.pos_x === null ? null : [p.pos_x, p.pos_y!], location: p.location, class: p.class,
  };
}

async function postNews(kind: string, actor: string, detail: Record<string, unknown>, day: string) {
  await pool.query("insert into news (day, kind, actor, detail) values ($1,$2,$3,$4)", [day, kind, actor, JSON.stringify(detail)]);
}

/** Back to town if they're out in the wild. Walking home is free. */
async function home(b: Bot) {
  const s = await b.get("/status");
  if (!isErr(s) && s.state.place) await b.post("/travel", { to: "town" });
}

/** How far they'll go: a level or so past their own, more if they're bold, less if they're shaken. */
function comfort(p: Personality, level: number, mood: number) {
  return level + (p === "reckless" ? 2 : 1) + (mood > 0 ? 1 : 0) - (mood < 0 ? 1 : 0);
}

/** A walk out past the gate: a step costs a fight, and now and then they hunt where they stand. */
async function exploreTrip(b: Bot, row: Row, mind: Mind, budget: number, day: string) {
  const st = STYLE[row.personality];
  const known = new Set((await pool.query<{ x: number; y: number }>("select x, y from explored where player_id = $1", [row.player_id])).rows.map((t) => `${t.x},${t.y}`));
  let used = 0, steps = 0, place = "";
  const goal = mind.goal?.kind;
  for (let guard = 0; used < budget && guard < 30; guard++) {
    const s = await b.get("/status");
    if (isErr(s) || !s.state.alive || s.state.forest_fights <= 0) break;
    if (s.state.hp / s.state.max_hp < Math.max(st.healBelow, 0.35)) break;
    const [x, y] = s.state.place ? [s.state.place.x, s.state.place.y] : [0, 0];
    const limit = comfort(row.personality, s.state.level, mind.mood ?? 0);
    const options = (Object.keys(DIRS) as Dir[]).map((d) => {
      const [nx, ny] = [x + DIRS[d][0], y + DIRS[d][1]];
      if (nx === 0 && ny === 0) return null;
      const t = tileAt(nx, ny);
      if (t.level > limit) return null;
      let score = 1 + Math.random() * 1.5;
      if (!known.has(`${nx},${ny}`)) score += 3;
      if (t.ring > Math.max(Math.abs(x), Math.abs(y))) score += goal === "far" ? 3 : 0.8;
      if (goal === "cave" && (t.terrain === "hills" || t.terrain === "crags")) score += 2;
      if (goal === "cave" && t.poi === "cave") score += 10;
      return { d, score, t };
    }).filter((o): o is NonNullable<typeof o> => o !== null).sort((a, z) => z.score - a.score);
    if (!options.length) break;
    const go = options[0];
    const m = await b.post("/move", { dir: go.d });
    if (isErr(m) || m.events.some((e) => e.kind === "no_fights_left")) break;
    used++; steps++; place = go.t.name; known.add(`${go.t.x},${go.t.y}`);
    if (used < budget && Math.random() < 0.5) {
      const r = await forestFight(b, st);
      used++;
      if (r && !r.state.alive) { b.log.push(`died out at ${place}`); mind.last_trip = { day, place, steps }; return; }
    }
  }
  if (steps) { mind.last_trip = { day, place, steps }; b.log.push(`walked ${steps} step${steps === 1 ? "" : "s"} out to ${place}`); }
  else b.log.push("meant to explore, thought better of it");
}

/** A word in the tavern: about their goal, or whatever's on their mind as usual. */
async function tavernTalk(b: Bot, row: Row, mind: Mind, f: Facts) {
  const g = mind.goal;
  const flavor: Partial<Record<Personality, Step>> = { gossip, pious: prayers, seer: fortune, braggart: boast, reckless: brag };
  const own = flavor[row.personality];
  const grudge = mind.grudge;
  if (grudge && Math.random() < 0.3) {
    await say(b, pick([
      `${grudge.name} robbed me in the fields. I haven't forgotten. I'm not the forgetting sort.`,
      `If anyone sees ${grudge.name} asleep out there, let me know. No reason.`,
      `${grudge.name} owes me. Tell them I said so.`,
    ]));
    b.log.push("muttered about a grudge");
    return;
  }
  if (g && (!own || Math.random() < 0.5)) {
    const frac = fraction(g, f, mind);
    const stage = (frac >= 0.8 ? 2 : frac >= 0.5 ? 1 : 0) as 0 | 1 | 2;
    await say(b, goalTalk(row.name, row.personality, g, stage, Math.random));
    mind.told = Math.max(mind.told ?? 0, stage);
    b.log.push("talked about their goal");
    return;
  }
  if (own) return own(b);
  if (row.personality === "drunk") { await say(b, pick(["Anyone seen my boots?", "Violet says I've had enough. Violet is not the boss of me.", "Another round. For me. I'm the round."])); return; }
  b.log.push("kept to themselves in the tavern");
}

async function donate(b: Bot, row: Row, mind: Mind) {
  // Brother Ansel gives most of what he carries to the shrine fund. It leaves the realm; it doesn't go to anyone.
  const s = await b.get("/status");
  if (isErr(s)) return;
  const amt = Math.floor(s.state.gold * 0.6);
  if (amt < 10) return;
  await pool.query("update players set gold = gold - $2 where id = $1 and gold >= $2", [row.player_id, amt]);
  mind.given = (mind.given ?? 0) + amt;
  b.log.push(`gave ${amt} gold to the shrine`);
}

async function flirtSomeone(b: Bot) {
  const around = SUITORS.filter((s) => available(s));
  const who = around.length ? pick(around).name : "Violet";
  const r = await b.post("/flirt", { with: who });
  if (!isErr(r)) {
    const out = r.events.find((e) => e.kind === "flirt") as { outcome?: string } | undefined;
    b.log.push(`flirted with ${who}${out?.outcome ? ` (${out.outcome})` : ""}`);
  }
}

async function revenge(b: Bot, target: string) {
  const me = await b.get("/status");
  if (isErr(me) || !me.state.alive) return;
  await b.post("/healer", { hp: "all" });
  const c = await b.post("/challenge", { name: target });
  b.log.push(`went after ${target}: ${isErr(c) ? c.error : kinds(c).filter((k) => k.startsWith("pvp_") && k !== "pvp_log").join(",") || kinds(c).join(",")}`);
}

const INN_SLEEPERS: Personality[] = ["banker", "gossip", "raider", "pious", "seer", "braggart"];

/** Settle the mood once a day from yesterday's news: a death shakes them, a robbery leaves a grudge. */
async function morning(b: Bot, row: Row, mind: Mind, day: string) {
  if (mind.today?.day === day) return;
  const news = await yesterday(b);
  let mood = Math.trunc((mind.mood ?? 0) * 0.5);
  for (const n of news) {
    if (n.what === "forest_death" && n.actor === row.name) mood -= 2;
    if (n.what === "pvp_kill" && n.target === row.name) { mood -= 1; if (n.actor) mind.grudge = { name: n.actor, day }; }
    if (n.what === "pvp_kill" && n.actor === row.name) mood += 1;
    if (n.what === "level_up" && n.actor === row.name) mood += 1;
    if (n.what === "goal" && n.actor === row.name) mood += 1;
  }
  mind.mood = Math.max(-2, Math.min(2, mood));
  if (mind.grudge && (Date.parse(day) - Date.parse(mind.grudge.day)) / 86_400_000 > 3) delete mind.grudge;
  mind.today = { day, sessions: {} };
}

/** Check on the goal: finished means a headline and a new goal; a stale one gets dropped. */
async function reviewGoal(b: Bot, row: Row, mind: Mind, f: Facts, day: string, inTown: boolean) {
  const g = mind.goal;
  if (g && finished(g, f, mind)) {
    const line = doneLine(row.name, row.personality, g, f);
    if (g.kind !== "wed" && g.kind !== "level") await postNews("goal", row.name, { goal: g.kind, line }, day);
    mind.done = [{ kind: g.kind, line, day }, ...(mind.done ?? [])].slice(0, 5);
    b.log.push(`goal done: ${g.kind}`);
    delete mind.goal;
  } else if (g && (Date.parse(day) - Date.parse(g.since)) / 86_400_000 > 21) {
    b.log.push(`gave up on ${g.kind}`);
    delete mind.goal;
  }
  if (!mind.goal) {
    mind.goal = pickGoal(f, mind, day, Math.random);
    mind.told = -1;
    b.log.push(`new goal: ${goalLabel(row.name, row.personality, mind.goal)}`);
  }
  // A new goal gets announced the next time they're in town.
  if (inTown && (mind.told ?? -1) < 0) {
    await say(b, goalTalk(row.name, row.personality, mind.goal, 0, Math.random));
    mind.told = 0;
  }
}

/** What a townsperson would like Odile to make: strength for most, defense for the careful, charm for the romantic. */
function wants(p: Personality): "str" | "def" | "charm" {
  if (p === "banker" || p === "pious") return "def";
  if (p === "seer" || p === "gossip") return "charm";
  return "str";
}
const worth = (x: Trinket, p: Personality) => x[wants(p)] * 2 + x.str + x.def + x.charm;

/** The best piece they could have made right now that beats what they wear, if any. */
function bestCraft(f: Gathered, p: Personality): Trinket | null {
  const worn = trinket(f.trinket_id);
  return TRINKETS.filter((x) => x.id > 0 && worth(x, p) > worth(worn, p) && canMake(x, { ore: f.ore, gems: f.gems, gold: f.gold + f.bank }))
    .sort((a, z) => worth(z, p) - worth(a, p))[0] ?? null;
}

/** Off to the cave they know: buy a pick first if need be, go down as far as feels safe, swing until done. */
async function mineTrip(b: Bot, row: Row, mind: Mind, f: Gathered) {
  if (!f.cave) return;
  if (!f.pickaxe) {
    await home(b);
    await b.post("/bank", { op: "withdraw", amount: PICKAXE_COST });
    const r = await b.post("/workshop", { op: "pickaxe" });
    if (isErr(r) || !kinds(r).includes("bought")) { b.log.push("couldn't afford a pickaxe"); return; }
    b.log.push("bought a pickaxe from Odile");
  }
  const st = STYLE[row.personality];
  const t = await b.post("/travel", { x: f.cave.x, y: f.cave.y });
  if (isErr(t)) return;
  await b.post("/cave", { op: "descend" });
  const tile = tileAt(f.cave.x, f.cave.y);
  let depth = 1;
  while (depth < MAX_DEPTH && caveLevel(tile.level, depth + 1) <= comfort(row.personality, f.level, mind.mood ?? 0) && Math.random() < 0.6) {
    const d = await b.post("/cave", { op: "deeper" });
    if (isErr(d) || !kinds(d).includes("in_cave")) break;
    depth++;
  }
  let finds = 0;
  for (let k = 0; k < SWINGS_PER_DAY; k++) {
    const r = await b.post("/mine");
    if (isErr(r)) break;
    const ks = kinds(r);
    if (ks.some((x) => ["mined_out", "your_share", "no_swings_left", "no_pickaxe"].includes(x))) break;
    if (ks.includes("encounter")) {
      let e: Envelope | null = r;
      for (let i = 0; i < 60 && e && e.state.in_encounter; i++) {
        const action = st.runBelow !== undefined && e.state.hp / e.state.max_hp < st.runBelow ? "run" : "attack";
        const n = await b.post("/fight", { action });
        e = isErr(n) ? null : n;
      }
      if (e && !e.state.alive) { b.log.push(`killed in ${tile.name}`); return; }
    }
    const m = r.events.find((x) => x.kind === "mined") as { found?: string | null; left_behind?: boolean } | undefined;
    if (m?.found && !m.left_behind) finds++;
    if (m?.left_behind) break; // bag's full
    const now = await b.get("/status");
    if (isErr(now) || now.state.hp / now.state.max_hp < Math.max(st.healBelow, 0.35)) break;
  }
  await b.post("/cave", { op: "climb" });
  await b.post("/travel", { to: "town" });
  b.log.push(`mined ${tile.name} (depth ${depth}): ${finds} find${finds === 1 ? "" : "s"}`);
}

/** Have Odile make the best thing they can afford, and put it on. */
async function craftJewelry(b: Bot, row: Row, f: Gathered) {
  const x = bestCraft(f, row.personality);
  if (!x) return;
  await home(b);
  if (f.gold < x.needs.fee) await b.post("/bank", { op: "withdraw", amount: x.needs.fee - f.gold });
  const r = await b.post("/workshop", { op: "craft", id: x.id });
  if (isErr(r) || !kinds(r).includes("crafted")) return;
  const c = r.events.find((e) => e.kind === "crafted") as { worn?: boolean } | undefined;
  if (!c?.worn) {
    const bag = await b.get("/bag");
    const items = isErr(bag) ? [] : ((bag.events.find((e) => e.kind === "bag") as unknown as { items: { id: number; slot: string; name: string }[] }).items);
    const piece = items.find((i) => i.slot === "trinket" && i.name === x.name);
    if (piece) await b.post("/equip", { id: piece.id });
  }
  b.log.push(`had Odile make a ${x.name}`);
}

async function playSession(b: Bot, row: Row, mind: Mind, i: number, day: string) {
  const plan = PLAN[row.personality];
  const slot = plan[i];
  const last = i === plan.length - 1;
  const hour = Number(slot.at.slice(0, 2));
  const night = hour >= 20 || hour < 5;

  await morning(b, row, mind, day);
  let f = await gatherFacts(row, mind);
  await reviewGoal(b, row, mind, f, day, f.pos === null);

  let status = await b.get("/status");
  if (isErr(status)) return;
  // A fight left half-finished (a timeout, a crash) would block everything else: finish it first.
  for (let k = 0; k < 80 && status.state.in_encounter; k++) {
    const r = await b.post("/fight", { action: "attack" });
    if (isErr(r)) break;
    status = r;
  }
  if (!status.state.alive) { b.log.push("died finishing an old fight"); return; }
  const s = status.state;
  const upgradeSlot = f.weapon_id <= f.armor_id ? "weapon" : "armor";
  const nextCost = (upgradeSlot === "weapon" ? GAME.weapons : GAME.armor).find((g) => g.id === (upgradeSlot === "weapon" ? f.weapon_id : f.armor_id) + 1)?.cost ?? Infinity;
  const grudgeTarget = mind.grudge && night ? mind.grudge.name : null;

  // A lazy morning now and then: they just don't turn up.
  const lazy = plan.length > 1 && Math.random() < 0.05;
  const acts: Activity[] = lazy ? ["rest"] : choose(row.personality, mind, {
    hp: s.hp, max_hp: s.max_hp, fights_left: s.forest_fights, gold: s.gold,
    can_upgrade: f.gold + f.bank >= nextCost, hint: slot.doing, last_session: last, night, grudge_target: grudgeTarget,
    can_mine: Boolean(f.cave) && (f.pickaxe || f.gold + f.bank >= PICKAXE_COST + 100) && s.swings_left > 0,
    can_craft: bestCraft(f, row.personality) !== null,
  }, Math.random);
  b.keepOre = mind.goal?.kind === "jewel";
  mind.today!.sessions[String(i)] = acts;
  b.log.push(`chose ${acts.join(" + ")}`);

  // Fights for this session; the last one uses whatever's left.
  const share = last ? s.forest_fights : Math.max(1, Math.min(s.forest_fights, (FIGHTS[row.personality][i] ?? 3) + Math.floor(Math.random() * 3) - 1));
  for (const a of acts) {
    switch (a) {
      case "hunt": await fights(b, share, row, mind); break;
      case "explore": await exploreTrip(b, row, mind, share, day); break;
      case "tavern": await home(b); f = await gatherFacts(row, mind); await tavernTalk(b, row, mind, f); break;
      case "shop": await home(b); await shop(b); break;
      case "bank": await home(b); await b.post("/bank", { op: "deposit", amount: "all" }); b.log.push("banked"); break;
      case "flirt": await home(b); await flirtSomeone(b); break;
      case "bard": await home(b); await song(b); b.log.push("listened to the bard"); break;
      case "donate": await home(b); await donate(b, row, mind); break;
      case "mine": await mineTrip(b, row, mind, f); f = await gatherFacts(row, mind); if (bestCraft(f, row.personality)) await craftJewelry(b, row, f); break;
      case "craft": await craftJewelry(b, row, f); break;
      case "raid": await home(b); if (grudgeTarget) { await revenge(b, grudgeTarget); delete mind.grudge; } else await raid(b); break;
      case "rest": b.log.push(lazy ? "stayed in bed" : "took it easy"); { const h = await b.get("/status"); if (!isErr(h) && !h.state.place) await healIfNeeded(b, h, 0.6); } break;
    }
    const after = await b.get("/status");
    if (isErr(after) || !after.state.alive) return;
  }

  if (!last) return;
  // Bedtime. Explorers who like the fields may camp where they are; everyone else walks home.
  const now = await b.get("/status");
  if (isErr(now) || !now.state.alive) return;
  const camper = ["reckless", "drunk", "seer"].includes(row.personality);
  if (now.state.place && camper && Math.random() < 0.4) { b.log.push(`camped out at ${now.state.place.name}`); return; }
  await home(b);
  if (row.personality === "drunk") return drunkNight(b);
  if (row.personality === "reckless") return sleepRough(b);
  if (INN_SLEEPERS.includes(row.personality) && Math.random() < 0.95) return bedInn(b);
  await tidyBag(b);
  b.log.push("couldn't be bothered with the inn tonight");
}

const song: Step = async (b) => { await b.post("/bard"); };
type Step = (b: Bot) => Promise<void>;

// ---------- seeding and running ----------

async function ensureRoster(): Promise<Row[]> {
  const existing = await pool.query<Row>(
    "select b.player_id, p.name, b.personality, b.api_key, b.mind from bots b join players p on p.id = b.player_id",
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
    const p = await pool.query<{ id: string }>("update players set is_bot = true, role = 'townsfolk' where name = $1 returning id", [spec.name]);
    await pool.query("insert into bots (player_id, personality, api_key) values ($1,$2,$3)", [p.rows[0].id, spec.personality, j.api_key]);
    existing.rows.push({ player_id: p.rows[0].id, name: spec.name, personality: spec.personality, api_key: j.api_key, mind: {} });
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
    const plan = PLAN[row.personality];
    const due = plan.map((s, i) => ({ i, at: sessionTime(day, s.at, row.name, i) })).filter((x) => !done.has(x.i) && x.at <= now);
    if (!due.length) continue;
    const b = new Bot(row.name, row.personality, row.api_key);
    const mind: Mind = row.mind ?? {};
    const away = awayToday(day, row.name, row.personality);
    for (const { i, at } of due) {
      b.log.push(`session ${i + 1} (${at.toISOString().slice(11, 16)}Z)`);
      try {
        const status = await b.get("/status");
        if (isErr(status)) { b.log.push(`status failed: ${status.error}`); }
        else if (!status.state.alive) { b.log.push("dead until the reset"); }
        else if (away) { b.log.push(`away: ${away}`); }
        else await playSession(b, row, mind, i, day);
      } catch (e) {
        b.log.push(`error: ${(e as Error).message}`);
      }
      done.add(i);
      await pool.query("update bots set sessions = $2, last_run_day = $3, mind = $4 where player_id = $1",
        [row.player_id, JSON.stringify({ day, done: [...done].sort() }), day, JSON.stringify(mind)]);
    }
    results[row.name] = b.log;
  }
  return { day, now: now.toISOString(), results };
}

// Rewrite one day's chronicle entry by hand (e.g. after adding the API key): POST /v1/internal/chronicle/write?day=YYYY-MM-DD
bots.post("/chronicle/write", async (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "forbidden" }, 403);
  const day = c.req.query("day") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: "day=YYYY-MM-DD" }, 400);
  return c.json({ written: await writeEntry(day, true) });
});

// Vercel Cron sends GET with "Authorization: Bearer $CRON_SECRET". Manual runs can POST the same header.
bots.on(["GET", "POST"], "/bots/run", async (c) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "forbidden" }, 403);
  // A fake clock is for local testing only.
  const fake = (process.env.DRAGONS_DOOR_ALLOW_FAKE_CLOCK ?? process.env.LORD_ALLOW_FAKE_CLOCK) ? c.req.query("now") : undefined;
  const when = fake ? new Date(fake) : new Date();
  const out = await runBots(when);
  // Yesterday's chronicle, once the day is over. Never lets a failure stop the townsfolk.
  let chronicle: string[] = [];
  try { chronicle = await catchUp(when); } catch (e) { chronicle = [`error: ${(e as Error).message}`]; }
  // Townsfolk and characters answer their mail.
  let letters: string[] = [];
  try { letters = await answerLetters(when); } catch (e) { letters = [`error: ${(e as Error).message}`]; }
  return c.json({ ...out, chronicle, letters });
});
