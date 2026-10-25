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
import { api, CHAT_KEEP_DAYS, settleAuctions } from "./api.js";
import { marketFor } from "./auctions.js";
import { INTERNAL_TOKEN } from "./request.js";
import { PLAN, sessionTime, type Personality } from "./schedule.js";
export { sessionTime } from "./schedule.js";
import { pool, tx } from "./db.js";
import { catchUp, writeEntry } from "./chronicle.js";
import { answerLetters } from "./letters.js";
import { settleGifts } from "./gifts.js";
import { settlePolls } from "./polls.js";
import { roll } from "./combat.js";
import { createHash } from "node:crypto";
import { realmDay, realmSettings } from "./day.js";
import { GAME, expForLevel, levelGains, type Envelope, type Event } from "./game.js";
import { DIRS, TOWN_TILES, tileAt, type Dir, type TownId } from "./world.js";
import { SUITORS, available } from "./romance.js";
import { loadLore, lore } from "./lore.js";
import { MAX_DEPTH, PICKAXE_COST, SWINGS_PER_DAY, TRINKETS, canMake, caveLevel, trinket, type Trinket } from "./caves.js";
import { awayToday, choose, doneLine, finished, fraction, goalLabel, goalTalk, pickGoal, type Activity, type Facts, type Mind } from "./minds.js";

export const bots = new Hono();


const ROSTER: { name: string; class: "warrior" | "thief" | "mage" | "priest"; personality: Personality; home?: "ironhold" | "ashford"; level?: number }[] = [
  { name: "Hilde", class: "warrior", personality: "banker" },
  { name: "Grimwald", class: "warrior", personality: "drunk" },
  { name: "Vesper", class: "thief", personality: "raider" },
  { name: "Old Tam", class: "mage", personality: "gossip" },
  { name: "Brother Ansel", class: "priest", personality: "pious" },
  { name: "Pip", class: "thief", personality: "reckless" },
  { name: "Madam Orsolya", class: "mage", personality: "seer" },
  { name: "Sir Pomfrey", class: "warrior", personality: "braggart" },
  // Ironhold's own, who start seasoned: nobody lives that far out at level 1.
  { name: "Hask the Unbowed", class: "warrior", personality: "veteran", home: "ironhold", level: 6 },
  { name: "Nell Thorne", class: "thief", personality: "scout", home: "ironhold", level: 5 },
  { name: "Sabine Ashe", class: "mage", personality: "scholar", home: "ironhold", level: 5 },
  // Ashford's own, seasoned the same way.
  { name: "Tansy Rook", class: "thief", personality: "pickpocket", home: "ashford", level: 4 },
  { name: "Lucan Strand", class: "warrior", personality: "watchman", home: "ashford", level: 6 },
  { name: "Brother Wystan", class: "priest", personality: "prelate", home: "ashford", level: 5 },
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
  /** Where they live: where they heal, sleep and go about town. */
  home: TownId = "brightwater";
  /** Where they really live, when an errand has them living somewhere else for now. */
  native: TownId | null = null;
  /** Things they might say in the tavern while an errand (theirs, or a friend's) is on. */
  errandLines: string[] = [];
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
  // Masters live in town. Out-of-town masters teach only fighters (Ashford's only thieves), so the rest walk down to Brightwater to train.
  const ownMasters = b.home === "ironhold" ? !["mage", "priest"].includes(r.state.class) : b.home === "ashford" ? r.state.class === "thief" : true;
  if (!ownMasters) await b.post("/travel", { x: 0, y: 0 });
  else if (r.state.place) await b.post("/travel", { to: "town" });
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
  // The healer is at home (Brightwater's, or Jessamy at Ironhold). Walking home is free, and so is walking back.
  const back = r.state.place ? { x: r.state.place.x, y: r.state.place.y } : null;
  const atHome = b.home !== "brightwater" ? back?.x === homeAt(b.home).x && back?.y === homeAt(b.home).y : !back;
  if (!atHome) await home(b);
  await b.post("/healer", { hp: "all" });
  if (back && !atHome) await b.post("/travel", back);
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
  // A town is never hunting ground, even one out in the wild.
  if (me.state.place && me.state.place.poi !== "town" && ok(me.state.place.level)) return 0;
  const known = (await pool.query<{ x: number; y: number }>("select x, y from explored where player_id = $1", [row.player_id])).rows
    .map((t) => tileAt(t.x, t.y)).filter((t) => t.level <= want && t.poi !== "town").sort((a, z) => z.level - a.level || Math.random() - 0.5);
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
    if (s.state.place && s.state.place.poi !== "town" && ok(s.state.place.level)) break;
    const steps = (Object.keys(DIRS) as Dir[]).map((d) => ({ d, t: tileAt(x + DIRS[d][0], y + DIRS[d][1]) }))
      .filter((o) => !(o.t.x === 0 && o.t.y === 0) && o.t.poi !== "town" && o.t.level <= want)
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
  // In town, first pick up anything the auction house is holding for them (won lots, unsold ones back).
  const where = await b.get("/status");
  const inTown = !isErr(where) && (!where.state.place || where.state.place.poi === "town");
  if (inTown) await b.post("/auction", { op: "collect" });
  const r = await b.get("/bag");
  if (isErr(r)) return;
  const bagEv = r.events.find((e) => e.kind === "bag") as unknown as { items: { id: number; upgrade: boolean }[]; ground: unknown } | undefined;
  if (!bagEv) return;
  if (bagEv.ground) { const e = await b.post("/equip", { ground: true }); if (isErr(e) || !kinds(e).includes("equipped")) await b.post("/take"); }
  for (const it of bagEv.items) if (it.upgrade) await b.post("/equip", { id: it.id });
  const again = await b.get("/bag");
  if (isErr(again)) return;
  const left = (again.events.find((e) => e.kind === "bag") as unknown as { items: BagItem[] }).items;
  // Ore is kept while they're saving it up for Odile. The rest goes up at the auction house if it's worth it
  // and the board isn't already full of the same thing; otherwise to the smith.
  const listed = inTown ? await listSpares(b, left.filter((it) => !(b.keepOre && it.slot === "ore"))) : new Set<number>();
  for (const it of left) if (!(b.keepOre && it.slot === "ore") && !listed.has(it.id) && it.slot !== "quest") await b.post("/sell", { id: it.id });
  if (inTown) await listGems(b);
}

// ---------- the auction house ----------

interface BagItem { id: number; slot: string; name: string; sells_for: number; item_id?: number; rarity_level?: number }
interface Lot { id: number; slot: string; tier: number; item: string; worth: number; seller: string; buy_now?: number; next_bid: number; min_bid?: number; high_bid?: number | null; days_left?: number; yours?: boolean; you_lead?: boolean; market?: { each: number; sold_this_week: number; trend?: string } }

/** How each kind of townsperson prices what they sell: Vesper asks high, Hilde sells cheap and sure, Pomfrey overprices everything. */
const ASKS: Partial<Record<Personality, number>> = { raider: 1.15, braggart: 1.25, banker: 0.92, pious: 0.9, gossip: 1.05, pickpocket: 1.1, veteran: 0.97 };
const jitter = (spread: number) => 1 + (Math.random() * 2 - 1) * spread;

/**
 * A townsperson's asking price for a lot, from the market: the going price this week if there is one (else half
 * way between the smith and the shop), raised after a sale at buy-now, lowered after a lot that didn't sell or when
 * the board's already full of the same thing, and tilted by who they are. Never below what the smith would pay.
 */
async function askingPrice(b: Bot, it: BagItem, qty: number): Promise<{ min_bid: number; buy_now: number } | null> {
  const smith = it.sells_for * qty, shop = it.sells_for * 2 * qty;
  const m = it.item_id === undefined ? null : await marketFor(pool, it.slot, it.item_id, it.rarity_level ?? 0);
  let base = m?.unit != null ? m.unit * qty : (smith + shop) / 2;
  if (m?.last === "sold_at_buy_now") base *= 1.12;
  if (m?.last === "expired") base *= 0.9 ** m.unsold_run; // each lot in a row that didn't sell pulls the price down again
  if ((m?.on_board ?? 0) >= 2) base *= 0.93;
  base *= (ASKS[b.personality] ?? 1) * jitter(0.06);
  // Keep it sane: never under the smith, never past three times the shop (the house's own ceiling).
  // Three lots in a row went unsold and it's down to what the smith pays anyway: take it to the smith.
  if ((m?.unsold_run ?? 0) >= 3 && base <= smith * 1.1) return null;
  base = Math.max(smith * 1.1, Math.min(shop * 2.5, base));
  const min_bid = Math.max(Math.ceil(smith * 1.05), Math.ceil(base * 0.75));
  return { min_bid, buy_now: Math.max(min_bid + 1, Math.ceil(base * 1.3)) };
}
/** How many lots of their own a townsperson keeps up at once. */
const BOT_LOTS = 2;

async function readBoard(b: Bot): Promise<{ listings: Lot[]; mine: Lot[]; purse: number; bank: number } | null> {
  const r = await b.get("/auction");
  if (isErr(r)) return null;
  const ev = r.events.find((e) => e.kind === "auction_house") as unknown as { listings: Lot[]; your_lots: Lot[]; purse: number; bank: number } | undefined;
  return ev ? { listings: ev.listings, mine: ev.your_lots ?? [], purse: ev.purse, bank: ev.bank } : null;
}

/** Put spare gear and ore up for sale, priced from the market (askingPrice). Returns what got listed. */
async function listSpares(b: Bot, items: BagItem[]): Promise<Set<number>> {
  const done = new Set<number>();
  const board = await readBoard(b);
  if (!board) return done;
  let open = board.mine.length;
  const seen = new Set<string>();
  for (const it of items) {
    if (open >= BOT_LOTS) break;
    if (!["weapon", "armor", "ore", "trinket"].includes(it.slot) || it.sells_for < 20) continue;
    if (seen.has(`${it.slot}:${it.name}`)) continue;
    seen.add(`${it.slot}:${it.name}`);
    // Don't flood the board: two lots of the same thing already up and they sell to the smith instead.
    if (board.listings.filter((l) => l.slot === it.slot && l.item.startsWith(it.name.replace(/^Scroll of /, ""))).length >= 2) continue;
    const same = it.slot === "ore" ? items.filter((x) => x.slot === "ore" && x.name === it.name) : [it];
    const qty = Math.min(3, same.length);
    const ask = await askingPrice(b, it, qty);
    if (!ask) continue;
    const r = await b.post("/auction", { op: "list", id: it.id, ...(it.slot === "ore" ? { qty } : {}), min_bid: ask.min_bid, buy_now: ask.buy_now, days: 3, confirm: true });
    if (!isErr(r) && kinds(r).includes("auction_listed")) {
      for (const x of same.slice(0, qty)) done.add(x.id);
      open++;
      b.log.push(`put ${qty > 1 ? `${qty} ${it.name}` : it.name} up at auction`);
    }
  }
  return done;
}

/** A pouch with more gems than they've a use for: one or two go up at auction. Anyone saving for jewelry keeps theirs. */
async function listGems(b: Bot) {
  if (b.keepOre) return;
  const s = await b.get("/status");
  if (isErr(s) || (s.state.gems ?? 0) < 3) return;
  const board = await readBoard(b);
  if (!board || board.mine.length >= BOT_LOTS || board.listings.filter((l) => l.slot === "gem").length >= 2) return;
  const n = Math.min(2, (s.state.gems ?? 0) - 1);
  // Gems price like everything else: the going rate, nudged by the last lot, never under 40 a stone.
  const m = await marketFor(pool, "gem", 0, 0);
  let each = (m.unit ?? 75) * (m.last === "sold_at_buy_now" ? 1.12 : 0.9 ** m.unsold_run) * (ASKS[b.personality] ?? 1) * jitter(0.06);
  each = Math.max(40, Math.min(150, each));
  const min_bid = Math.ceil(each * 0.8 * n), buy_now = Math.max(min_bid + 1, Math.ceil(each * 1.2 * n));
  const r = await b.post("/auction", { op: "list", gems: n, min_bid, buy_now, days: 3, confirm: true });
  if (!isErr(r) && kinds(r).includes("auction_listed")) b.log.push(`put ${n} gem${n > 1 ? "s" : ""} up at auction`);
}

/** Buy a lot outright, if it's still there. True if they got it. */
async function buyLot(b: Bot, lot: Lot): Promise<boolean> {
  const r = await b.post("/auction", { op: "buy", lot: lot.id, confirm: true });
  const ok = !isErr(r) && kinds(r).includes("auction_bought");
  if (ok) b.log.push(`bought ${lot.item} at auction for ${lot.buy_now}`);
  return ok;
}

/**
 * Materials from the board: an Ironholder short of ore for the forge, or anyone saving up for Odile's jewelry,
 * goes after what's for sale. Each has their own sense of what it's worth to them: someone who needs it pays up to
 * a little over shop price, anyone else only takes a bargain. They bid while there's time and take buy-now only
 * when it's a steal or the lot closes tomorrow, so two of them after the same copper push the price up.
 */
async function buyMaterials(b: Bot, mind: Mind, spare: number) {
  const native = b.native ?? b.home;
  const forge = native === "ironhold";
  const jewel = mind.goal?.kind === "jewel";
  if (!forge && !jewel) return;
  const board = await readBoard(b);
  if (!board) return;
  const need = (l: Lot) => (l.slot === "ore" ? forge || jewel : l.slot === "gem" ? jewel : false);
  const value = (l: Lot) => Math.floor(l.worth * (need(l) ? 1.1 : 0.7) * jitter(0.08));
  const lots = board.listings.filter((l) => !l.yours && need(l)).sort((a, z) => a.next_bid / a.worth - z.next_bid / z.worth);
  for (const l of lots) {
    const v = Math.min(value(l), spare);
    if (l.buy_now !== undefined && (l.buy_now <= v * 0.8 || ((l.days_left ?? 3) <= 1 && l.buy_now <= v))) {
      if (await buyLot(b, l)) return; // one purchase a day is plenty
    } else if (!l.you_lead && l.next_bid <= v) {
      const r = await b.post("/auction", { op: "bid", lot: l.id });
      if (!isErr(r) && kinds(r).some((k) => k === "auction_bid" || k === "auction_bought")) { b.log.push(`bid ${l.next_bid} on ${l.item} at auction`); return; }
    }
  }
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
  veteran: { useSpecial: true, runBelow: 0.2, healBelow: 0.45 },
  scout: { runBelow: 0.4, useSpecial: true, healBelow: 0.55 },
  scholar: { useSpecial: true, runBelow: 0.45, healBelow: 0.6 },
  pickpocket: { runBelow: 0.4, healBelow: 0.55 },
  watchman: { useSpecial: true, runBelow: 0.25, healBelow: 0.5 },
  prelate: { useSpecial: true, runBelow: 0.5, healBelow: 0.7 },
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
       and abs(level - $2) <= 1 and created_at < now() - interval '24 hours'
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
/** Say something in the tavern, unless they've already said exactly that lately: nobody repeats themselves word for word on the board. */
const say = async (b: Bot, line: string) => {
  const body = line.slice(0, 280);
  const said = await pool.query("select 1 from tavern where author = $1 and body = $2 and ts > now() - interval '3 days' limit 1", [b.name, body]);
  if (said.rowCount) { b.log.push("had nothing new to say"); return; }
  await b.post("/tavern", { body });
};

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
    const ev = cat.events.find((e) => e.kind === "catalog") as unknown as { owned: number; items: { id: number; cost: number; name: string }[] } | undefined;
    if (!ev) continue;
    const owned = ev.items.find((i) => i.id === ev.owned);
    const tradeIn = Math.floor((owned?.cost ?? 0) / 2);
    const gold = cat.state.gold;
    const best = ev.items.filter((i) => i.id > ev.owned && i.cost - tradeIn <= gold).sort((a, z) => z.id - a.id)[0];
    if (best) {
      const r = await b.post("/buy", { kind, id: best.id });
      if (!isErr(r) && kinds(r).includes("bought")) b.log.push(`bought ${best.name}`);
    }
  }
  await auctionBids(b);
}

/** Sir Pomfrey at the auction house: collects what he won, then bids on anything finer than what he wears, if he can spare it. */
async function auctionBids(b: Bot) {
  await b.post("/auction", { op: "collect" });
  const board = await b.get("/auction");
  if (isErr(board)) return;
  const ev = board.events.find((e) => e.kind === "auction_house") as unknown as { listings: { id: number; slot: string; tier: number; item: string; next_bid: number; buy_now?: number; yours?: boolean; you_lead?: boolean }[]; purse: number; bank: number } | undefined;
  if (!ev) return;
  const cats: Record<string, number> = {};
  for (const kind of ["weapon", "armor"] as const) {
    const cat = await b.get(`/shop?kind=${kind}`);
    const ev = isErr(cat) ? undefined : (cat.events.find((e) => e.kind === "catalog") as unknown as { owned: number } | undefined);
    if (ev) cats[kind] = ev.owned;
  }
  const spare = Math.floor((ev.purse + ev.bank) * 0.6);
  // An upgrade is worth up to a quarter over shop price to them, and no more than they can spare.
  const want = ev.listings.filter((l) => !l.yours && !l.you_lead && cats[l.slot] !== undefined && l.tier > cats[l.slot] && l.next_bid <= spare && l.next_bid <= Math.floor(((l as { worth?: number }).worth ?? Infinity) * 1.25))
    .sort((a, z) => z.tier - a.tier)[0];
  if (!want) return;
  const r = await b.post("/auction", { op: "bid", lot: want.id });
  if (!isErr(r) && kinds(r).some((k) => k === "auction_bid" || k === "auction_bought")) b.log.push(`bid ${want.next_bid} on ${want.item} at auction`);
}

/** Vesper fences a gem now and then. Nobody asks where it came from. */
async function fence(b: Bot) {
  const s = await b.get("/status");
  if (isErr(s) || !s.state.alive || (s.state.gems ?? 0) < 2) return;
  await b.post("/auction", { op: "collect" });
  const r = await b.post("/auction", { op: "list", gems: 1, min_bid: 70, buy_now: 120, days: 2 });
  if (!isErr(r) && kinds(r).includes("auction_listed")) b.log.push("put a gem up at auction");
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
  veteran: [4, 3, 3],
  scout: [5, 5],
  scholar: [3, 3, 2],
  pickpocket: [4, 4, 2],
  watchman: [4, 3, 3],
  prelate: [3, 3, 2],
};

interface Errand { to: TownId; until: string; why: string; lines?: Record<string, string[]> }
interface Row { player_id: string; name: string; personality: Personality; api_key: string; mind: Mind; home?: string; errand?: Errand | null }

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
const homeAt = (t: TownId) => (t === "brightwater" ? { x: 0, y: 0 } : TOWN_TILES[t]);
async function home(b: Bot) {
  const s = await b.get("/status");
  if (isErr(s)) return;
  if (b.home !== "brightwater") { const at = homeAt(b.home); if (s.state.place?.x !== at.x || s.state.place?.y !== at.y) await b.post("/travel", { x: at.x, y: at.y }); return; }
  // Brightwater: "town" is their own home, unless they're from another town, down on an errand.
  if (b.native && b.native !== "brightwater") { if (s.state.place) await b.post("/travel", { x: 0, y: 0 }); return; }
  if (s.state.place) await b.post("/travel", { to: "town" });
}

/** Lines for the tavern from any errand that's on and names this townsperson: their own, or a friend's who's come to them. */
function errandLines(roster: Row[], row: Row, day: string): string[] {
  const out: string[] = [];
  for (const r of roster) if (r.errand && r.errand.until >= day) out.push(...(r.errand.lines?.[row.name] ?? []));
  return out;
}

/** Ironhold's townsfolk at the forge: take the best piece they can afford up a step. */
async function forgeVisit(b: Bot) {
  const r = await b.get("/forge");
  if (isErr(r)) return;
  const ev = r.events.find((e) => e.kind === "forge") as unknown as { pieces: { target: string | number; item: string; can_forge?: boolean; next?: { item: string } }[] } | undefined;
  const pick = ev?.pieces.filter((p) => p.can_forge).sort((a, z) => Number(z.target === "weapon") - Number(a.target === "weapon"))[0];
  if (!pick) return;
  const f = await b.post("/forge", { target: pick.target, confirm: true });
  if (!isErr(f) && kinds(f).includes("forged")) b.log.push(`had Brannagh forge ${pick.next?.item ?? pick.item}`);
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
  // Something's happened: an old friend in town, an errand of their own. It's on their mind more than most things.
  if (b.errandLines.length && Math.random() < 0.5) {
    await say(b, pick(b.errandLines));
    b.log.push("talked about what's happened");
    return;
  }
  // Now and then the past comes up: never the secret, just what they'd say over a drink.
  const mentions = lore().people[row.name]?.mentions;
  if (mentions?.length && Math.random() < 0.15) {
    await say(b, pick(mentions));
    b.log.push("talked about the old days");
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
  if (row.personality === "raider" && Math.random() < 0.3) await fence(b);
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
    // Away on an errand, they stay where they went: no trips back to a cave by home.
    can_mine: !b.native && Boolean(f.cave) && (f.pickaxe || f.gold + f.bank >= PICKAXE_COST + 100) && s.swings_left > 0,
    can_craft: b.home === "brightwater" && bestCraft(f, row.personality) !== null,
  }, Math.random);
  // Ironhold's own feed the forge, so they hold on to ore rather than sell it and buy it back.
  b.keepOre = mind.goal?.kind === "jewel" || (b.native ?? b.home) === "ironhold";
  mind.today!.sessions[String(i)] = acts;
  b.log.push(`chose ${acts.join(" + ")}`);

  // Fights for this session; the last one uses whatever's left.
  const share = last ? s.forest_fights : Math.max(1, Math.min(s.forest_fights, (FIGHTS[row.personality][i] ?? 3) + Math.floor(Math.random() * 3) - 1));
  for (const a of acts) {
    // Other towns' own do their town things there: the tavern for company, the forge (Ironhold) and the auction house for shopping.
    if (b.home !== "brightwater" && !["hunt", "explore", "mine", "rest"].includes(a)) {
      await home(b);
      const hall = b.home === "ashford" ? "the Ford House" : "the Long Hall";
      if (a === "shop") { if (b.home === "ironhold") await forgeVisit(b); await auctionBids(b); b.log.push(`looked round the shops`); }
      else if (a === "bank") { await b.post("/bank", { op: "deposit", amount: "all" }); b.log.push("banked"); }
      else if (a === "tavern" && b.errandLines.length && Math.random() < 0.5) { await say(b, pick(b.errandLines)); b.log.push(`said something in ${hall} about what's happened`); }
      // Each town's tavern has its own board, so they say their piece there like anyone in Brightwater's tavern.
      else if (a === "tavern" && Math.random() < 0.5) { f = await gatherFacts(row, mind); await tavernTalk(b, row, mind, f); }
      else if (a === "tavern") b.log.push(pick(b.home === "ashford"
        ? ["ate at the Ford House", "drank at the Ford House", "heard the herald's proclamations over breakfast"]
        : ["ate in the Long Hall", "drank with the garrison in the Long Hall", "listened to Corra Bell in the Long Hall"]));
      else b.log.push(`kept to ${TOWN_TILES[b.home].name}`);
      const after = await b.get("/status");
      if (isErr(after) || !after.state.alive) return;
      continue;
    }
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
  await kitOut(b, row, mind, day);
  if (b.home !== "brightwater") { await tidyBag(b); await b.post("/inn"); b.log.push(b.home === "ashford" ? "a room at the Ford House" : "a bunk in the Long Hall"); return; }
  if (row.personality === "drunk") return drunkNight(b);
  if (row.personality === "reckless") return sleepRough(b);
  if (INN_SLEEPERS.includes(row.personality) && Math.random() < 0.95) return bedInn(b);
  await tidyBag(b);
  b.log.push("couldn't be bothered with the inn tonight");
}

/** Of everything they have, what share they won't spend on gear. Savers keep a lot back; Pomfrey keeps nothing. */
const GEAR_RESERVE: Record<Personality, number> = {
  banker: 0.5, drunk: 0.1, raider: 0.25, gossip: 0.3, pious: 0.3, reckless: 0.1, seer: 0.3, braggart: 0, veteran: 0.2, scout: 0.25, scholar: 0.3,
  pickpocket: 0.2, watchman: 0.25, prelate: 0.15,
};

/**
 * Once a day, back in town at bedtime: if they can afford better kit, they buy it. A weapon (or, for the
 * gifted, the next spell at the library or chapel) and armor, the best they can manage while keeping their
 * reserve and enough for the healer. Without this, buying gear only happened when "shop" came up by chance,
 * and most of them went for days fighting with their fists.
 */
async function kitOut(b: Bot, row: Row, mind: Mind, day: string) {
  if (mind.kitted === day) return;
  mind.kitted = day;
  const st = await b.get("/status");
  if (isErr(st) || !st.state.alive) return;
  const inTown = b.home !== "brightwater" ? st.state.place?.x === homeAt(b.home).x && st.state.place?.y === homeAt(b.home).y : !st.state.place;
  if (!inTown) return;
  const saving = mind.goal?.kind === "save" || mind.goal?.kind === "rich";
  const reserve = Math.min(0.8, GEAR_RESERVE[row.personality] + (saving ? 0.3 : 0));
  let budget = Math.floor((st.state.gold + st.state.bank) * (1 - reserve)) - 20 * st.state.level;
  if (budget <= 0) return;
  const caster = ["mage", "priest"].includes(st.state.class);
  // What to buy, cheapest need first: the weapon or spell, then armor.
  type Pick = { kind: "weapon" | "armor" | "spell"; id: number; name: string; net: number };
  const picks: Pick[] = [];
  if (caster) {
    const lib = await b.get("/library");
    const ev = isErr(lib) ? undefined : lib.events.find((e) => e.kind === "library") as unknown as { spells: { id: number; name: string; cost: number; known?: boolean; learnable?: boolean }[] } | undefined;
    if (ev) {
      const known = ev.spells.find((x) => x.known);
      const tradeIn = Math.floor((known?.cost ?? 0) / 2);
      const best = ev.spells.filter((x) => x.learnable && x.cost - tradeIn <= budget).sort((a, z) => z.id - a.id)[0];
      if (best) { picks.push({ kind: "spell", id: best.id, name: best.name, net: best.cost - tradeIn }); budget -= best.cost - tradeIn; }
    }
  }
  // The auction board first: a piece someone else is selling can beat the smith's price.
  const board = await readBoard(b);
  const lots: Lot[] = [];
  for (const kind of (caster ? ["armor"] : ["weapon", "armor"]) as ("weapon" | "armor")[]) {
    const cat = await b.get(`/shop?kind=${kind}`);
    const ev = isErr(cat) ? undefined : cat.events.find((e) => e.kind === "catalog") as unknown as { owned: number; items: { id: number; cost: number; name: string }[] } | undefined;
    if (!ev) continue;
    const tradeIn = Math.floor((ev.items.find((i) => i.id === ev.owned)?.cost ?? 0) / 2);
    const best = ev.items.filter((i) => i.id > ev.owned && i.cost - tradeIn <= budget).sort((a, z) => z.id - a.id)[0];
    // On the board: the same slot, better than what they wear, bought outright for less than the smith's full price
    // (their old piece then goes to the smith or the board, which comes to the same as a trade-in).
    const lot = (board?.listings ?? []).filter((l) => l.slot === kind && !l.yours && l.buy_now !== undefined && l.tier > ev.owned
      && l.buy_now <= budget && l.buy_now < (ev.items.find((i) => i.id === l.tier)?.cost ?? 0))
      .sort((a, z) => z.tier - a.tier || (a.buy_now ?? 0) - (z.buy_now ?? 0))[0];
    if (lot && (!best || lot.tier >= best.id)) { lots.push(lot); budget -= lot.buy_now!; }
    else if (best) { picks.push({ kind, id: best.id, name: best.name, net: best.cost - tradeIn }); budget -= best.cost - tradeIn; }
    else {
      // Nothing they can buy outright: a bid on an upgrade they can afford, if it's under the smith's price.
      // The house holds the gold; it settles at the reset and they pick it up next time they're in town.
      const bid = (board?.listings ?? []).filter((l) => l.slot === kind && !l.yours && !l.you_lead && l.tier > ev.owned
        && l.next_bid <= budget && l.next_bid < (ev.items.find((i) => i.id === l.tier)?.cost ?? 0))
        .sort((a, z) => z.tier - a.tier || a.next_bid - z.next_bid)[0];
      if (bid) {
        const r = await b.post("/auction", { op: "bid", lot: bid.id, confirm: true });
        if (!isErr(r) && kinds(r).some((k) => k === "auction_bid" || k === "auction_bought")) { b.log.push(`bid ${bid.next_bid} on ${bid.item} at auction`); budget -= bid.next_bid; }
      }
    }
  }
  // Lots are paid from the bank first, so no trip to the counter for those.
  let boughtLot = false;
  for (const lot of lots) if (await buyLot(b, lot)) boughtLot = true;
  if (boughtLot) await tidyBag(b);
  await buyMaterials(b, mind, Math.max(0, budget));
  if (!picks.length) return;
  // Draw what's needed from the bank, buy, and put the rest back.
  const need = picks.reduce((n, p) => n + p.net, 0) + 20;
  if (st.state.gold < need) await b.post("/bank", { op: "withdraw", amount: Math.min(st.state.bank, need - st.state.gold) });
  for (const p of picks) {
    if (p.kind === "spell") {
      // Spells are taught in Brightwater; someone from another town walks there for it and back after.
      if (b.home !== "brightwater") await b.post("/travel", { x: 0, y: 0 });
      const r = await b.post("/library", { id: p.id });
      if (!isErr(r) && kinds(r).includes("learned")) b.log.push(`learned ${p.name}`);
      if (b.home !== "brightwater") await home(b);
    } else {
      const r = await b.post("/buy", { kind: p.kind, id: p.id });
      if (!isErr(r) && kinds(r).includes("bought")) b.log.push(`bought ${p.name}`);
    }
  }
  const after = await b.get("/status");
  if (!isErr(after) && after.state.gold > 40 * after.state.level) await b.post("/bank", { op: "deposit", amount: after.state.gold - 20 * after.state.level });
}

const song: Step = async (b) => { await b.post("/bard"); };
type Step = (b: Bot) => Promise<void>;

// ---------- seeding and running ----------

async function ensureRoster(): Promise<Row[]> {
  const existing = await pool.query<Row>(
    "select b.player_id, p.name, b.personality, b.api_key, b.mind, b.home, b.errand from bots b join players p on p.id = b.player_id",
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
    await pool.query("insert into bots (player_id, personality, api_key, home) values ($1,$2,$3,$4)", [p.rows[0].id, spec.personality, j.api_key, spec.home ?? "brightwater"]);
    if (spec.home) await settleIn(p.rows[0].id, spec.home, spec.class, spec.level ?? 5);
    existing.rows.push({ player_id: p.rows[0].id, name: spec.name, personality: spec.personality, api_key: j.api_key, mind: {}, home: spec.home ?? "brightwater" });
  }
  return existing.rows;
}

/** Other towns' townsfolk arrive seasoned: the levels, stats and gear of someone who has lived out there a while, and they know the land around it. */
async function settleIn(id: string, town: "ironhold" | "ashford", cls: "warrior" | "thief" | "mage" | "priest", level: number) {
  const at = TOWN_TILES[town];
  let hp = 20, str = 10, def = 1;
  for (let l = 2; l <= level; l++) { const g = levelGains(cls, l); hp += g.hp; str += g.str; def += g.def; }
  const gear = Math.max(1, level - 1);
  await pool.query(
    `update players set level = $2, exp = $3, hp = $4, max_hp = $4, str = $5, def = $6, weapon_id = $7, armor_id = $7, gold = 400, bank = 2500,
       pos_x = $8, pos_y = $9, start_town = $10, location = 'inn', created_at = now() - interval '30 days' where id = $1`,
    [id, level, expForLevel(level) ?? 0, hp, str, def, gear, at.x, at.y, town]);
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++)
    await pool.query("insert into explored (player_id, x, y) values ($1,$2,$3) on conflict do nothing", [id, at.x + dx, at.y + dy]);
}

export async function runBots(now = new Date()): Promise<{ day: string; now: string; results: Record<string, string[]> }> {
  await loadLore();
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
    if (row.home === "ironhold" || row.home === "ashford") b.home = row.home;
    // Away on an errand: they live in that town until it's done, then the errand lapses and they go home.
    if (row.errand && row.errand.until >= day) { b.native = b.home; b.home = row.errand.to; }
    else if (row.errand) await pool.query("update bots set errand = null where player_id = $1", [row.player_id]);
    b.errandLines = errandLines(roster, row, day);
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
  // Close any auctions whose time is up, even if nobody visits the house today.
  let auctions: string[] = [];
  try { auctions = await tx(async (cl) => settleAuctions(cl, realmDay((await realmSettings(cl)).resetHourUtc, when))); } catch (e) { auctions = [`error: ${(e as Error).message}`]; }
  // Chat is kept for 30 days, then gone.
  try { await pool.query(`delete from chat where created_at < now() - interval '${CHAT_KEEP_DAYS} days'`); } catch { /* next run */ }
  // The courier's morning round: townsfolk take their gifts, and a week's unclaimed ones go home.
  let gifts: string[] = [];
  try { gifts = await tx(async (cl) => settleGifts(cl, realmDay((await realmSettings(cl)).resetHourUtc, when))); } catch (e) { gifts = [`error: ${(e as Error).message}`]; }
  // Town meetings: close the ones that are over, and let the townsfolk have their say in the rest.
  let meetings: string[] = [];
  try { meetings = await tx(async (cl) => settlePolls(cl, realmDay((await realmSettings(cl)).resetHourUtc, when))); } catch (e) { meetings = [`error: ${(e as Error).message}`]; }
  const out = await runBots(when);
  // Yesterday's chronicle, once the day is over. Never lets a failure stop the townsfolk.
  let chronicle: string[] = [];
  try { chronicle = await catchUp(when); } catch (e) { chronicle = [`error: ${(e as Error).message}`]; }
  // Townsfolk and characters answer their mail.
  let letters: string[] = [];
  try { letters = await answerLetters(when); } catch (e) { letters = [`error: ${(e as Error).message}`]; }
  return c.json({ ...out, auctions, gifts, meetings, chronicle, letters });
});
