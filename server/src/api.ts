import { Hono } from "hono";
import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pool, tx, type Client } from "./db.js";
import { realmDay, realmSettings, loadTurns } from "./day.js";
import {
  GAME, armor, weapon, effective, armorName, armorFamilyOf, weaponFamilyOf, carriedId, carriedName, familyLabel, familyOf, familyUsers, fits, itemName, tierOf, charmOf, attributeName, casts, spellVendor, manaMax, manaRules, weaponName, specialName, expForLevel, master, levelGains, legalActions, publicState, innCost, healCost, isNight, timeOfDayNow, needsSpec, casterItemName,
  type Player, type PlayerClass, type Turns, type Monster, type Event, type Envelope,
  expInFights, fightExp, NEW_GROUND,
} from "./game.js";
import * as Bag from "./bag.js";
import { TOWNS as TOWN_INFO, homeOf } from "./towns.js";
import { VOTE_MIN_LEVEL, openPolls, tally, type Poll } from "./polls.js";
import { boosted, forgeCost, MAX_RARITY, rarity, RARITY, withRarity } from "./rarity.js";
import { AUCTION, TOWNS, bidCeiling, marketFor, type Market, houseCut, listingFee, nextBid, priceProblem, worth, type ListSlot, type Town } from "./auctions.js";
import { current, fromHeaders, older, runWith } from "./request.js";
import { weatherAt } from "./weather.js";
import { bardFor, pickGift } from "./bards.js";
import { pickVisitorGift, timeOfDay, visitorFor, type Rumor } from "./square.js";
import { realmHour, whereabouts, type Personality } from "./schedule.js";
import { SUITORS, available, charmDiscount, charmLucky, flirtOutcome, spousePerk, suitor, townOfSuitor, weddingChance } from "./romance.js";
import { draw } from "./luck.js";
import { GEAR_ABOVE_LEVEL, GIFT_MIN_LEVEL, GOLD_PER_LEVEL, ITEMS_PER_DAY, courierFee, nextDay, townName, townOfCharacter, townOfPlayer } from "./gifts.js";
import { CLASSES, CLASS_HOME, PATHS, SPECIALIZE_AT, SPECS, SPEC_SWITCH_DAYS, SPEC_SWITCH_PER_LEVEL, pathOfClass, specsOf, type Path, type Spec } from "./paths.js";
import { countryOf, regionAt, rollFind } from "./bestiary.js";
import { DIRS, LEGEND, SYMBOL, placeAt, renderMap, tileAt, townAt, TOWN_TILES, type Dir, type Tile, type TownId } from "./world.js";
import { awayToday, goalLabel, type Mind } from "./minds.js";
import { EVENTS_PER_DAY, EVENT_CHANCE, ROAD_EVENT_MAX, ROAD_EVENT_PER_STEP, eventById, eventsFor, rollOutcome, type Effect } from "./events.js";
import { judge, pickRiddle, MAX_ANSWER_WORDS } from "./riddles.js";
import { HOW, PRICE_CUT, pastChance, standingWith, type Standing } from "./standing.js";
import { bondsOf, cold as coldBond, warm as warmBond } from "./bonds.js";
import { loadLore, looksOf, lore, heardOf, personKey, PIECE_NAMES, PAST_CHANCE, JOURNAL_CHANCE, JOURNAL_EVERY_DAYS } from "./lore.js";
import { QUESTS, questById, questByIndex, questIndex, stepOf, type QEffect, type QStep, type QuestDef } from "./quests.js";
import { CAVE_FINDS_PER_DAY, FINDS_PER_PERSON, GEM_SELL, MAX_DEPTH, PICKAXE_COST, SWINGS_PER_DAY, TRINKETS, bonusText, canMake, caveLevel, ore as oreOf, swing, trinket } from "./caves.js";
import { OATH, incantation, oathLine } from "./flair.js";
import { FORAGE, FORAGES_PER_DAY, HERBS, POTIONS, SPOT_CHANCE, TEACHERS, boostAmount, extraChance, herb, herbsAt, pickHerb, potion } from "./herbs.js";
import { blow, exchange, fleeSucceeds, monsterAsFighter, pickMonster, playerAsFighter, resolveDuel, roll, type Duelist, dropChance, rollDrop, specialDodges, specialMultiplier } from "./combat.js";

export const api = new Hono();

// Who's calling and roughly from where, for the code below that needs it.
api.use("*", (c, next) => runWith(fromHeaders((n) => c.req.header(n)), next));

class GameError extends Error {
  constructor(public code: string, msg: string, public status = 400) { super(msg); }
}

export const hash = (key: string) => createHash("sha256").update(key).digest("hex");

// ---------- context ----------

interface Ctx {
  c: Client;
  p: Player;
  t: Turns;
  day: string;
  dragonAlive: boolean;
  events: Event[];
  hint?: string;
  /** Name of who they're married to, if anyone. */
  spouse: string | null;
}

/** Authenticate, lock the player row, roll the day if needed, run the handler, build the envelope. */
async function withPlayer(authHeader: string | undefined, fn: (ctx: Ctx) => Promise<void>, opts: { quiet?: boolean; weather?: boolean; surroundings?: boolean } = {}): Promise<Envelope> {
  const key = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new GameError("unauthorized", "missing api key", 401);
  await loadLore();
  const info = current();
  // Off unless MIN_PLUGIN_VERSION is set: only raised for releases that old plugins can't play against.
  const min = process.env.MIN_PLUGIN_VERSION;
  if (min && info && !info.townsfolk && !info.trial && (!info.plugin || older(info.plugin, min))) {
    throw new GameError("update_required", `This realm needs Dragon's Door ${min} or newer (you have ${info.plugin ?? "an older version"}).`, 426);
  }
  // The sky is looked up once the key checks out, alongside the rest of the work; dropped if weather is off.
  let sky: ReturnType<typeof weatherAt> | null = null;
  let weatherOff = true;
  const env = await tx(async (c) => {
    const r = await c.query<Player>("select * from players where api_key_hash = $1 for update", [hash(key)]);
    if (!r.rowCount) throw new GameError("unauthorized", "unknown api key", 401);
    if (opts.weather && info && !info.townsfolk) sky = weatherAt(info.lat, info.lon);
    const settings = await realmSettings(c);
    const day = realmDay(settings.resetHourUtc);
    const loaded = await loadTurns(c, r.rows[0], day);
    const ctx: Ctx = { c, p: numify(loaded.player), t: loaded.turns, day, dragonAlive: settings.dragonAlive, events: [], spouse: null };
    // A trial character plays only through the website's narrator, never straight from outside.
    if (ctx.p.trial && !info?.trial) throw new GameError("trial_only", "this character lives on the website's trial; install the game to play for real", 403);
    if (ctx.p.banned_at) throw new GameError("banned", "The gate is barred to you. The realm's keeper has turned this character away.", 403);
    // Renamed by the keeper: say so once.
    if (ctx.p.renamed_from) {
      ctx.events.push({ kind: "renamed", from: ctx.p.renamed_from, to: ctx.p.name });
      await c.query("update players set renamed_from = null where id = $1", [ctx.p.id]);
    }
    if (ctx.p.spouse_id) ctx.spouse = (await c.query<{ name: string }>("select name from players where id = $1", [ctx.p.spouse_id])).rows[0]?.name ?? null;
    weatherOff = ctx.p.weather_off;
    if (info && !info.townsfolk && info.plugin) {
      // Only the plugin version is kept: old-plugin support needs it.
      const prev = ctx.p.client as { plugin?: string } | null;
      if (prev?.plugin !== info.plugin) {
        const client = { plugin: info.plugin, since: new Date().toISOString() };
        await c.query("update players set client = $2 where id = $1", [ctx.p.id, JSON.stringify(client)]);
        ctx.p.client = client;
      }
    }
    if (loaded.rolled) {
      ctx.events.push({ kind: "new_day", day });
      if (spousePerk(ctx.spouse) === "charm") {
        await savePlayer(ctx, { charm: ctx.p.charm + 1 });
        ctx.events.push({ kind: "spouse_gift", spouse: ctx.spouse, charm: 1 });
      }
      // Corra's songs: one more special today (for casters, a Fireball's worth of mana).
      if (spousePerk(ctx.spouse) === "specials") {
        const mr = manaRules(ctx.p.class);
        if (mr) { await saveTurns(ctx, { mana: (ctx.t.mana ?? 0) + mr.fireball }); ctx.events.push({ kind: "spouse_gift", spouse: ctx.spouse, mana: mr.fireball }); }
        else { await saveTurns(ctx, { specials: ctx.t.specials + 1 }); ctx.events.push({ kind: "spouse_gift", spouse: ctx.spouse, specials: 1 }); }
      }
      // Linnet hears everything: one place a morning, somewhere they've never been.
      if (spousePerk(ctx.spouse) === "rumor") {
        const spot = (await c.query<{ x: number; y: number; name: string }>(
          `select d.x, d.y, d.name from discoveries d where d.poi is not null and d.poi <> 'town'
             and not exists (select 1 from explored e where e.player_id = $1 and e.x = d.x and e.y = d.y)
             and not exists (select 1 from rumors r where r.player_id = $1 and r.x = d.x and r.y = d.y)
           order by random() limit 1`, [ctx.p.id])).rows[0];
        if (spot && await hearOf(ctx, spot.x, spot.y, ctx.spouse!)) ctx.events.push({ kind: "spouse_gift", spouse: ctx.spouse, rumor: { place: spot.name, where: directions(spot.x, spot.y) } });
      }
      await logEvent(ctx, "day_start", { hp: ctx.p.hp, max_hp: ctx.p.max_hp, gold: ctx.p.gold, bank: ctx.p.bank, exp: ctx.p.exp });
      if (ctx.p.ground) await savePlayer(ctx, { ground: null });
    }
    // A quiet call (the session-start news line) reads only; it must not consume mail or robbery reports.
    if (!opts.quiet) {
      await drainMailbox(ctx);
      await noticeMail(ctx);
      await expireQuests(ctx);
    }
    const startedAt = `${ctx.p.pos_x},${ctx.p.pos_y},${ctx.p.cave_depth}`;
    await fn(ctx);
    await c.query("update players set last_seen = now() where id = $1", [ctx.p.id]);
    // For the side pane: when the player moved (or asked for their status), the map around them comes along,
    // so the pane never has to ask for it. Plugins from before the pane (0.18.6) don't get it.
    if (ctx.p.role === "player" && info?.plugin && !older(info.plugin, "0.18.6") && !ctx.events.some((x) => x.kind === "map")
        && (opts.surroundings || startedAt !== `${ctx.p.pos_x},${ctx.p.pos_y},${ctx.p.cave_depth}`)) {
      const explored = await exploredSet(ctx);
      const seen = new Set([...explored, ...(await heardSet(ctx)).keys()]);
      const [x, y] = inWild(ctx.p) ? [ctx.p.pos_x!, ctx.p.pos_y!] : [0, 0];
      // Places they could travel straight back to (towns and caves they've been to), nearest first, for the pane's buttons.
      // Home is always somewhere they know the way back to, explored or not.
      if ((ctx.p.start_town ?? "brightwater") === "brightwater") explored.add("0,0");
      const places = [...explored].map((k) => k.split(",").map(Number) as [number, number])
        .map(([px, py]) => tileAt(px, py))
        .filter((t) => (t.x === 0 && t.y === 0) || t.poi === "town" || t.poi === "cave" || t.poi === "shrine")
        .filter((t) => !(t.x === x && t.y === y && !ctx.p.cave_depth))
        .sort((a, b) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) - Math.max(Math.abs(b.x - x), Math.abs(b.y - y)))
        .slice(0, 8).map((t) => ({ name: t.name, x: t.x, y: t.y, kind: t.x === 0 && t.y === 0 ? "town" : t.poi }));
      ctx.events.push({ kind: "surroundings", for: "side pane", map: renderMap(x, y, seen), places });
    }
    const enc = await c.query("select 1 from encounters where player_id = $1", [ctx.p.id]);
    const inEnc = enc.rowCount! > 0;
    const bagUsed = await Bag.used(c, ctx.p.id);
    const unreadMail = await unreadCount(ctx);
    const newsUnread = await unreadNews(ctx);
    const journal = ctx.p.role === "player" ? await questJournal(ctx) : [];
    const potionRows = (await c.query<{ item_id: number; n: string }>("select item_id, count(*)::text as n from inventory where player_id = $1 and slot = 'potion' group by item_id order by item_id", [ctx.p.id])).rows;
    const potions = potionRows.map((r) => ({ id: r.item_id, name: potion(r.item_id).name, count: Number(r.n) }));
    const drankThisFight = inEnc && Boolean((await c.query("select 1 from encounters where player_id = $1 and drank", [ctx.p.id])).rowCount);
    const giftsWaiting = ctx.p.role === "player" ? Number((await c.query<{ n: string }>("select count(*)::text as n from gifts where to_player = $1 and state = 'sent' and arrives_day <= $2", [ctx.p.id, ctx.day])).rows[0].n) : 0;
    return {
      events: ctx.events,
      state: { ...publicState(ctx.p, ctx.t, inEnc, ctx.dragonAlive, bagUsed, unreadMail, newsUnread, ctx.spouse, SUITORS.filter((x) => available(x) && townOfSuitor(x) === (townAt(ctx.p.pos_x, ctx.p.pos_y) ?? "")).map((x) => ({ name: x.name, pronouns: x.pronouns, where: x.where }))), quests: journal, ...(giftsWaiting ? { gifts_waiting: giftsWaiting } : {}), ...(potions.length ? { potions } : {}) },
      actions: (() => {
        let a = legalActions(ctx.p, ctx.t, inEnc, ctx.dragonAlive);
        if (!potions.length || drankThisFight) a = a.filter((x) => x !== "drink");
        // Herbs and potions came with 0.25.0; older plugins have no tools for them.
        if (info?.plugin && older(info.plugin, "0.25.0")) a = a.filter((x) => x !== "drink" && x !== "forage" && x !== "apothecary");
        // Plugins from before exploration have no way out of town: keep offering them the old forest.
        const v = info?.plugin;
        if (!info?.townsfolk && (!v || older(v, "0.5.0")) && a.includes("explore")) return a.map((x) => (x === "explore" ? "forest" : x)).filter((x) => x !== "map");
        if (journal.some((j) => j.waiting_on_you)) a.push("quest");
        return a;
      })(),
      // How to tell each result lives in the narrator skill now; only plugins from before that (0.22.0) still get a hint.
      ...(ctx.hint && info?.plugin && older(info.plugin, "0.22.0") ? { hint: ctx.hint } : {}),
    };
  });
  if (sky && !weatherOff) {
    const w = await sky;
    if (w) env.state.weather = w;
  }
  return env;
}

async function drainMailbox(ctx: Ctx) {
  const r = await ctx.c.query<{ id: number; event: Event }>("delete from mailbox where player_id = $1 returning id, event", [ctx.p.id]);
  for (const row of r.rows) ctx.events.push({ ...row.event, kind: "while_you_were_away", what: row.event.kind });
}

/** pg returns bigint columns as strings; the game wants numbers. */
/**
 * Mail never opens itself. If anything new has arrived since the player was last told,
 * say so once ("a letter is waiting"); reading is an explicit (M)ail.
 */
async function noticeMail(ctx: Ctx) {
  const r = await ctx.c.query<{ max_id: string | null; senders: string[] | null; fresh: string }>(
    `select max(m.id)::text as max_id, array_agg(distinct f.name) as senders, count(*)::text as fresh
     from messages m join players f on f.id = m.from_player
     where m.to_player = $1 and m.read_at is null and m.id > $2`, [ctx.p.id, ctx.p.mail_notified_upto]);
  const row = r.rows[0];
  if (!row.max_id) return;
  const unread = await unreadCount(ctx);
  const from = row.senders ?? [];
  ctx.events.push({ kind: "mail_waiting", new: Number(row.fresh), unread, from: from.slice(0, 5), ...(from.length > 5 ? { and_others: from.length - 5 } : {}) });
  await savePlayer(ctx, { mail_notified_upto: Number(row.max_id) });
}

async function unreadNews(ctx: Ctx): Promise<number> {
  const r = await ctx.c.query<{ n: string }>(
    "select count(*)::text as n from news where id > $1 and actor is distinct from $2", [ctx.p.news_seen_upto, ctx.p.name]);
  return Number(r.rows[0].n);
}

async function unreadCount(ctx: Ctx): Promise<number> {
  const r = await ctx.c.query<{ n: string }>("select count(*)::text as n from messages where to_player = $1 and read_at is null", [ctx.p.id]);
  return Number(r.rows[0].n);
}

function numify(p: Player): Player {
  return { ...p, gold: Number(p.gold), bank: Number(p.bank), exp: Number(p.exp), mail_notified_upto: Number(p.mail_notified_upto ?? 0), news_seen_upto: Number(p.news_seen_upto ?? 0) };
}

async function savePlayer(ctx: Ctx, patch: Partial<Player>) {
  const keys = Object.keys(patch) as (keyof Player)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const r = await ctx.c.query<Player>(`update players set ${sets} where id = $1 returning *`, [ctx.p.id, ...keys.map((k) => ((k === "ground" || k === "pending_event" || k === "boost") && patch[k] !== null ? JSON.stringify(patch[k]) : patch[k]))]);
  ctx.p = numify(r.rows[0]);
}

async function saveTurns(ctx: Ctx, patch: Partial<Turns>) {
  const keys = Object.keys(patch) as (keyof Turns)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const r = await ctx.c.query<Turns>(`update turns set ${sets} where player_id = $1 and day = $2 returning *`, [ctx.p.id, ctx.day, ...keys.map((k) => patch[k])]);
  ctx.t = r.rows[0];
}

async function post(ctx: Ctx, kind: string, actor: string | null, target: string | null, detail: Record<string, unknown> = {}) {
  // Test characters leave no mark on the paper.
  if (ctx.p.is_test) return;
  await ctx.c.query("insert into news (day, kind, actor, target, detail) values ($1,$2,$3,$4,$5)", [ctx.day, kind, actor, target, detail]);
}

function requireAlive(ctx: Ctx) {
  if (!ctx.p.alive) throw new GameError("dead", "you are dead until the realm resets");
}

/** Player-written text goes to other players' Claude. One plain line: no control or invisible characters, no line breaks. */
export function cleanText(t: string): string {
  return t.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}

/** New characters earn a voice: posting, mail and attacks open at level 2. Townsfolk are exempt. */
const SEASONED_LEVEL = 2;
function seasoned(ctx: Ctx, what: string): boolean {
  if (ctx.p.is_bot || ctx.p.level >= SEASONED_LEVEL) return true;
  ctx.events.push({ kind: "too_new", what, needed_level: SEASONED_LEVEL });
  return false;
}

/** Names that would pass for a local. Compared after folding lookalike characters. */
const RESERVED = ["mags pell", "margery pell", "hilde", "grimwald", "vesper", "old tam", "brother ansel", "pip", "madam orsolya", "orsolya", "sir pomfrey", "pomfrey",
  "violet", "odile", "mother quill", "quill", "prior hale", "rowan", "rosalind", "mara", "jory", "fennick reed", "fennick", "dunstan the unfinished", "dunstan", "corwin lark", "corwin", "wren", "the red dragon", "red dragon", "the dark dragon", "dark dragon", "vael", "vael the watchful", "the watchful",
  "townsfolk", "narrator", "system", "server", "admin", "sysop", "claude", "anthropic", "della moss", "goldie teague", "tilly brook", "piers calloway",
  "rufus kell", "mirela sorn", "lew tanner", "sister junia", "sister orla", "bess tolley", "ione vash", "jem arkwright"];
// i, l, 1, | and ! all fold to "l" (so "HiIde" and "Hi1de" read as "Hilde"); 0→o, 3→e, 5→s, rn→m, vv→w.
const fold = (n: string) => n.toLowerCase().replace(/rn/g, "m").replace(/vv/g, "w").replace(/[il1|!]/g, "l").replace(/0/g, "o").replace(/3/g, "e").replace(/5/g, "s").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const RESERVED_FOLDED = new Set(RESERVED.map(fold));
export function reservedName(n: string): boolean {
  const f = fold(n);
  return RESERVED_FOLDED.has(f) || RESERVED_FOLDED.has(f.replace(/ /g, "")) || [...RESERVED_FOLDED].some((r) => r.replace(/ /g, "") === f.replace(/ /g, ""));
}

export const SIGNUPS_PER_ADDRESS_PER_DAY = 3;
/** What a character's name may be made of. */
export const NAME_RE = /^[A-Za-z0-9_.'-]+( [A-Za-z0-9_.'-]+)*$/;

/**
 * A rare roll a player feels, drawn from their own bag of marbles for that kind of luck (luck.ts) instead of a
 * plain die, and logged so the game log shows how it's landing.
 */
async function luck(ctx: Ctx, kind: string, p: number): Promise<boolean> {
  const d = await draw(ctx.c, ctx.p.id, kind, p);
  if (p > 0 && p < 1) await logEvent(ctx, "luck", { kind: kind.split(":")[0], p: Math.round(p * 1000) / 1000, hit: d.hit, bag: d.size, left: d.left });
  return d.hit;
}

/** One line in the game event log: game facts only, for balance checks. Never names or player-written text. */
async function logEvent(ctx: Ctx, kind: string, data: Record<string, unknown> = {}) {
  if (ctx.p.is_test) return; // keeps the balance numbers about real play
  await ctx.c.query(
    "insert into game_events (day, player_id, class, level, is_bot, plugin, kind, data) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [ctx.day, ctx.p.id, ctx.p.class, ctx.p.level, Boolean(ctx.p.is_bot), current()?.plugin ?? null, kind, JSON.stringify(data)]);
}

/** Totals for a finished fight, from its saved rounds plus the last one. */
function fightSummary(log: Event[], last: Event[], me: string) {
  const all = [...log, ...last];
  const mine = all.filter((e) => e.attacker === me && (e.kind === "hit" || e.kind === "miss"));
  return {
    rounds: mine.length,
    crits: all.filter((e) => e.attacker === me && e.crit).length,
    crits_taken: all.filter((e) => e.defender === me && e.crit).length,
    specials: mine.filter((e) => e.special).length,
    dodges: all.filter((e) => e.kind === "dodged" && e.defender === me).length,
    // What armor did: swings at them, the ones that did nothing, and the damage that got through.
    blows_taken: all.filter((e) => e.defender === me && (e.kind === "hit" || e.kind === "miss")).length,
    blanks_taken: all.filter((e) => e.defender === me && e.kind === "miss").length,
    damage_taken: all.filter((e) => e.defender === me && e.kind === "hit").reduce((n, e) => n + Number(e.damage ?? 0), 0),
  };
}

/** Town's services are in town. Out in the wild you have to walk back first (which is free). */
function requireInTown(ctx: Ctx, what: string) {
  if (ctx.p.pos_x !== null && ctx.p.pos_x !== undefined) throw new GameError("not_in_town", `${what} is back in town; return to town first (it costs nothing)`, 409);
}
const inWild = (p: Player) => p.pos_x !== null && p.pos_x !== undefined;
/** Services some towns have: you must be in one of them. Returns which town you're in. */
function requireTown(ctx: Ctx, what: string, towns: TownId[]): TownId {
  const here = townAt(ctx.p.pos_x, ctx.p.pos_y);
  if (here && towns.includes(here)) return here;
  if (towns.length === 1 && towns[0] === "brightwater") requireInTown(ctx, what);
  // Never names a town the player may not have found.
  throw new GameError("not_here", towns.includes("brightwater") ? `${what} is back in town; return to town first (it costs nothing)` : `${what} isn't here`, 409);
}

/** Every town with services: an inn, a healer, a shop, a bank, a tavern and an auction house. */
const ALL_TOWNS: TownId[] = ["brightwater", "ironhold", "ashford"];
/** Where a player's masters are: Brightwater's teach everyone; Ironhold's those who fight with blades and bows; Ashford's the Shadow path, and bards under Mags Pell. */
export function trainsAt(p: { class: Player["class"]; path: string }): TownId[] {
  if (p.class === "bard") return ["brightwater", "ashford"];
  if (casts(p.class)) return ["brightwater"];
  return p.path === "shadow" ? ["brightwater", "ironhold", "ashford"] : ["brightwater", "ironhold"];
}

/** Going out to fight means leaving your room: you're back in the fields and fair game tonight. */
async function leaveInn(ctx: Ctx) {
  if (ctx.p.location !== "inn") return;
  await savePlayer(ctx, { location: "fields" });
  ctx.events.push({ kind: "left_inn" });
}

async function requireNoEncounter(ctx: Ctx) {
  const r = await ctx.c.query("select 1 from encounters where player_id = $1", [ctx.p.id]);
  if (r.rowCount) throw new GameError("in_encounter", "finish or flee your current fight first");
}

// ---------- register ----------

api.post("/register", async (c) => {
  const body = z.object({
    name: z.string().trim().min(2).max(20).regex(NAME_RE, "letters, digits, apostrophes, periods, hyphens, single spaces"),
    // Every class is open from the start. Plugins from when paths came first send a path instead: they get its
    // main class (Steel a warrior, Shadow a thief, the gift a mage).
    class: z.enum(CLASSES as [Spec, ...Spec[]]).optional(),
    path: z.enum(["steel", "shadow", "gift"]).optional(),
    invite: z.string().optional(),
  }).refine((b) => b.path || b.class, { message: "choose a class: warrior, guardian, thief, mage, priest or bard" }).parse(await c.req.json());
  const cls: Spec = body.class ?? PATHS[body.path!].base;
  const path: Path = pathOfClass(cls);
  const specialized = true;
  // A friends realm: when REALM_INVITE is set, you need the word to get in.
  const invite = process.env.REALM_INVITE;
  if (invite) {
    const given = body.invite ?? "";
    const ok = given.length === invite.length && timingSafeEqual(Buffer.from(given), Buffer.from(invite));
    if (!ok) throw new GameError("invite_required", "this realm is invite-only; ask whoever runs it for the word", 403);
  }
  const info = current();
  // An admin making a test character: sign in with their own key. Test characters skip the sign-up limit
  // and stay out of rankings, news, the chronicle and the balance log.
  const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const maker = auth ? (await pool.query<{ admin: boolean }>("select admin from players where api_key_hash = $1", [hash(auth)])).rows[0] : undefined;
  const testChar = Boolean(maker?.admin);
  if (auth && !testChar) throw new GameError("already_registered", "you already have a character", 409);
  if (!info?.townsfolk && reservedName(body.name)) throw new GameError("name_taken", "that name belongs to someone in town already", 409);
  const key = "door_" + randomBytes(24).toString("base64url");
  const out = await tx(async (db) => {
    const dup = await db.query("select 1 from players where lower(name) = lower($1)", [body.name]);
    if (dup.rowCount) throw new GameError("name_taken", "that name is taken", 409);
    if (info?.addr && !info.townsfolk && !testChar) {
      const today = realmDay((await realmSettings(db)).resetHourUtc);
      const salt = process.env.SIGNUP_SALT ?? process.env.CRON_SECRET ?? "dragons-door";
      const addrHash = createHash("sha256").update(`${today}|${salt}|${info.addr}`).digest("hex");
      await db.query("delete from signups where day < $1", [today]);
      const n = await db.query<{ n: number }>(
        `insert into signups (addr_hash, day, n) values ($1, $2, 1)
         on conflict (addr_hash, day) do update set n = signups.n + 1 returning n`, [addrHash, today]);
      if (n.rows[0].n > SIGNUPS_PER_ADDRESS_PER_DAY) throw new GameError("too_many_signups", "the gatekeeper has let enough newcomers in from your road today; try again tomorrow", 429);
    }
    const r = await db.query<Player>(
      "insert into players (name, api_key_hash, class, path, specialized, news_seen_upto, is_test) values ($1,$2,$3,$4,$5,(select coalesce(max(id), 0) from news),$6) returning *",
      [body.name, hash(key), cls, path, specialized, testChar]);
    const settings = await realmSettings(db);
    const day = realmDay(settings.resetHourUtc);
    if (!testChar) await db.query("insert into news (day, kind, actor) values ($1,'join',$2)", [day, body.name]);
    // Each class has a home town (CLASS_HOME). Plugins from before other towns start everyone in Brightwater.
    const home = CLASS_HOME[cls];
    if (home !== "brightwater" && !info?.townsfolk && info?.plugin && !older(info.plugin, "0.15.0")) {
      const t = TOWN_TILES[home as keyof typeof TOWN_TILES];
      await db.query("update players set start_town = $4, pos_x = $2, pos_y = $3 where id = $1", [r.rows[0].id, t.x, t.y, home]);
      await db.query("insert into explored (player_id, x, y) values ($1,$2,$3) on conflict do nothing", [r.rows[0].id, t.x, t.y]);
      r.rows[0].start_town = home;
    }
    return r.rows[0];
  });
  const startsIn = out.start_town && out.start_town !== "brightwater" ? TOWN_TILES[out.start_town as keyof typeof TOWN_TILES].name : "Brightwater";
  return c.json({ api_key: key, name: out.name, class: out.class, ...(testChar ? { test: true } : {}), events: [{
    kind: "joined", name: out.name, class: out.class, path: PATHS[path].name, starts_in: startsIn,
  }] });
});

// ---------- Mother Quill's library (spells for casters) ----------

/** Where a caster's teacher keeps shop: Brightwater, and for bards Ashford too, where Mags Pell sells instruments. */
const vendorTowns = (cls: Player["class"]): TownId[] => (cls === "bard" ? ["brightwater", "ashford"] : ["brightwater"]);
const myVendor = (ctx: Ctx) => vendorIn(ctx.p.class, townAt(ctx.p.pos_x, ctx.p.pos_y) ?? "brightwater");
function vendorIn(cls: Player["class"], town: TownId): { name: string; place: string } {
  if (cls === "bard" && town === "ashford") return { name: "Mags Pell", place: "music room" };
  return spellVendor(cls) ?? { name: "a teacher", place: "library" };
}

/** The spells for sale, tier for tier with the smith's weapons: each needs a level and costs gold, and your old spellbook trades in at half. */
api.get("/library", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  // ?place=library|chapel picks whose door you walk through; your own class's teacher by default.
  const want = c.req.query("place");
  const own = spellVendor(ctx.p.class);
  const place = want ?? own?.place;
  const cls = place ? (Object.keys(GAME.classes) as Player["class"][]).find((k) => spellVendor(k)?.place === place) ?? null : null;
  if (!cls) { ctx.events.push({ kind: "not_for_you", reason: "there's no such teacher in town", places: ["library", "chapel"] }); return; }
  const town = requireTown(ctx, `the ${spellVendor(cls)!.place}`, vendorTowns(cls));
  const v = vendorIn(cls, town);
  const mine = cls === ctx.p.class;
  const friend = mine ? await friendCut(ctx, v.name) : { cut: 0 };
  const discount = charmDiscount(charmOf(ctx.p));
  const mr = manaRules(cls)!;
  ctx.events.push({
    kind: "library", teacher: v.name, place: v.place, teaches: cls, ...(cls === "bard" ? { sells: "instruments (each comes with its Opus)" } : {}),
    // A visitor of another class can look and talk, not learn.
    ...(mine ? { known: weaponName(cls, ctx.p.weapon_id) } : { visitor: true, note: `only a ${cls} can learn here; ${v.name} will talk to anyone` }),
    mana: { per_day: mine ? manaMax(ctx.p) : manaMax({ class: cls, level: ctx.p.level }), cast: mr.cast, greater: mr.fireball, ...(mr.heal ? { heal: mr.heal } : {}) },
    spells: GAME.weapons.map((w) => ({ id: w.id, name: weaponName(cls, w.id), special: specialName(cls, w.id), power: w.str, cost: w.cost, needs_level: Math.max(1, w.id),
      ...(mine ? { known: w.id === ctx.p.weapon_id, learnable: w.id > ctx.p.weapon_id && ctx.p.level >= Math.max(1, w.id) } : {}) })),
    ...(mine ? { charm_discount_pct: Math.round(discount * 100) } : {}),
    ...(friend.cut ? { friend_discount_pct: Math.round(friend.cut * 100), teacher_feels: (friend as { feels?: string }).feels } : {}),
  });
})));

api.post("/library", async (c) => {
  const body = z.object({ id: z.number().int(), keep_old: z.boolean().optional(), confirm: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const vendorTown = requireTown(ctx, `the ${spellVendor(ctx.p.class)?.place ?? "library"}`, vendorTowns(ctx.p.class));
    // Like the smith: without confirm this only quotes. Plugins from before teacher quotes (0.16.6) and townsfolk go straight through.
    const plugin = current()?.plugin;
    const confirmed = body.confirm === true || ctx.p.is_bot || (plugin !== undefined && plugin !== null && older(plugin, "0.16.6"));
    await requireNoEncounter(ctx);
    if (!casts(ctx.p.class)) { ctx.events.push({ kind: "not_for_you", reason: "only those with the gift learn spells here" }); return; }
    const w = GAME.weapons.find((x) => x.id === body.id);
    if (!w || w.id === 0) throw new GameError("no_such_item", "no such spell");
    if (w.id <= ctx.p.weapon_id) { ctx.events.push({ kind: "already_known", spell: weaponName(ctx.p.class, ctx.p.weapon_id) }); return; }
    if (ctx.p.level < w.id) { ctx.events.push({ kind: "too_soon", spell: weaponName(ctx.p.class, w.id), needs_level: w.id }); return; }
    const tradeIn = Math.floor(weapon(ctx.p.weapon_id).cost / 2);
    const friend = await friendCut(ctx, vendorIn(ctx.p.class, vendorTown).name);
    const discount = Math.min(0.4, charmDiscount(charmOf(ctx.p)) + friend.cut);
    const costTrading = Math.ceil((w.cost - tradeIn) * (1 - discount));
    const costKeeping = Math.ceil(w.cost * (1 - discount));
    // The old spell or instrument is a thing now: trade it in, or keep it (as a scroll, or the instrument) to sell or auction.
    const oldCarried = ctx.p.weapon_id > 0 ? carriedId("weapon", ctx.p.class, ctx.p.weapon_id) : 0;
    const room = Bag.bag(ctx.p.bag_id).capacity - await Bag.used(ctx.c, ctx.p.id);
    const canKeep = oldCarried > 0 && Bag.item("weapon", oldCarried).weight <= room;
    if (!confirmed) {
      ctx.events.push({ kind: "learn_quote", teacher: casts(ctx.p.class) ? vendorIn(ctx.p.class, vendorTown).name : null, item: weaponName(ctx.p.class, w.id), special: specialName(ctx.p.class, w.id), power: w.str,
        replaces: weaponName(ctx.p.class, ctx.p.weapon_id), trade_in: tradeIn, cost: costTrading, gold: ctx.p.gold, bank: ctx.p.bank, ...(ctx.p.gold < costTrading ? { short_by: costTrading - ctx.p.gold } : {}),
        ...(oldCarried ? { keep: canKeep ? { as: Bag.item("weapon", oldCarried).name, cost: costKeeping, sells_for: Bag.sellPrice("weapon", oldCarried), ...(ctx.p.gold < costKeeping ? { short_by: costKeeping - ctx.p.gold } : {}) } : { possible: false, why: "no room in the bag" } } : {}),
        ...(discount ? { charm_discount_pct: Math.round(discount * 100) } : {}) });
      ctx.hint = oldCarried ? "Show the price both ways: trade the old one in (cheaper), or keep it in the bag to sell, auction or give away (full price). Ask which, then call again with confirm: true, and keep_old: true if they keep it." : undefined;
      return;
    }
    const keep = body.keep_old === true && canKeep;
    const cost = keep ? costKeeping : costTrading;
    if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold, trade_in: keep ? 0 : tradeIn }); return; }
    await savePlayer(ctx, { gold: ctx.p.gold - cost, weapon_id: w.id });
    if (keep) await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,'weapon',$2)", [ctx.p.id, oldCarried]);
    ctx.events.push({ kind: "learned", spell: weaponName(ctx.p.class, w.id), special: specialName(ctx.p.class, w.id), power: w.str, cost, ...(keep ? { kept: Bag.item("weapon", oldCarried).name } : { trade_in: tradeIn }), ...(discount ? { charm_discount_pct: Math.round(discount * 100) } : {}) });
    await logEvent(ctx, "spend", { on: "spell", item: weaponName(ctx.p.class, w.id), tier: w.id, gold: cost });
  }));
});

// ---------- starting over in a new class ----------

const RESPEC_DAYS = 7;
const RESPEC_PER_LEVEL = 250;
const PUT_DOWN: Record<string, string> = { warrior: "put down the sword", thief: "put away the lockpicks", mage: "put down the staff", priest: "laid aside the vestments", guardian: "set down the shield", bard: "put away the lute" };
const TAKE_UP: Record<string, string> = { warrior: "taken up the sword", thief: "taken to the shadows", mage: "taken up the staff", priest: "taken holy orders", guardian: "taken up the shield", bard: "taken up the lute" };

/**
 * Change class for gold: back to level 1 in the new class. Keeps the bank (less the fee), charm, gems,
 * jewelry, pickaxe, marriage, map, quests and mail. The smith buys back weapons and armor (worn and carried)
 * at half price into the bank, so nobody restarts at level 1 in late-game gear. Once a week. Without
 * confirm: true it only quotes.
 */
api.post("/respec", async (c) => {
  // Start over as any class. Plugins from when paths came first name a path: its main class.
  const body = z.object({
    class: z.enum(CLASSES as [Spec, ...Spec[]]).optional(),
    path: z.enum(["steel", "shadow", "gift"]).optional(),
    confirm: z.boolean().optional(),
  }).refine((b) => b.path || b.class, { message: "choose a class: warrior, guardian, thief, mage, priest or bard" }).parse(await c.req.json());
  const toClass: Spec = body.class ?? PATHS[body.path!].base;
  const toPath: Path = pathOfClass(toClass);
  const toSpecialized = true;
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    requireTown(ctx, "the town", ALL_TOWNS);
    await requireNoEncounter(ctx);
    if (ctx.p.role !== "player") { ctx.events.push({ kind: "not_for_you", reason: "townsfolk are who they are" }); return; }
    if (toClass === ctx.p.class && ctx.p.specialized !== false) { ctx.events.push({ kind: "already_that_class", class: toClass }); return; }
    const last = ctx.p.respec_at ? new Date(ctx.p.respec_at) : null;
    if (last && Date.now() - last.getTime() < RESPEC_DAYS * 86_400_000) {
      ctx.events.push({ kind: "respec_too_soon", next: new Date(last.getTime() + RESPEC_DAYS * 86_400_000).toISOString().slice(0, 10), every_days: RESPEC_DAYS });
      return;
    }
    const fee = Math.max(100, RESPEC_PER_LEVEL * (ctx.p.level - 1));
    const items = await Bag.contents(ctx.c, ctx.p.id);
    const gear = items.filter((x) => x.slot === "weapon" || x.slot === "armor");
    const buyback = gear.reduce((n, x) => n + Bag.sellPrice(x.slot, x.item_id, x.rarity), 0)
      + (ctx.p.weapon_id && !casts(ctx.p.class) ? Bag.sellPrice("weapon", ctx.p.weapon_id, ctx.p.weapon_rarity ?? 0) : ctx.p.weapon_id ? Bag.sellPrice("weapon", ctx.p.weapon_id) : 0)
      + (ctx.p.armor_id ? Bag.sellPrice("armor", ctx.p.armor_id, ctx.p.armor_rarity ?? 0) : 0);
    const have = ctx.p.gold + ctx.p.bank + buyback;
    const quote = {
      from: ctx.p.class, to: toClass, path: PATHS[toPath].name, from_level: ctx.p.level, fee, buyback, can_afford: have >= fee,
      keeps: ["bank (less the fee)", "charm", "gems", "jewelry", "pickaxe", "marriage", "map", "quests", "mail"],
      resets: ["level 1", "experience", "HP, attribute and defense to a beginner's", "weapon or spell, and armor (sold back at half price into the bank)"],
      every_days: RESPEC_DAYS,
    };
    if (!body.confirm) { ctx.events.push({ kind: "respec_quote", ...quote }); return; }
    if (have < fee) { ctx.events.push({ kind: "too_poor", cost: fee, gold: ctx.p.gold, bank: ctx.p.bank, buyback }); return; }
    // Buyback into the bank, then the fee from the purse first and the bank after.
    let gold = ctx.p.gold, bank = ctx.p.bank + buyback;
    const fromGold = Math.min(gold, fee); gold -= fromGold; bank -= fee - fromGold;
    await ctx.c.query("delete from inventory where player_id = $1 and slot in ('weapon','armor')", [ctx.p.id]);
    // What the smith bought back goes on his shelf: bagged gear, worn armor, and a worn weapon (a caster's "weapon" is a spell, not a thing).
    if (!ctx.p.is_test) await toStorehouse(ctx.c, [...gear, { slot: "armor", item_id: carriedId("armor", ctx.p.class, ctx.p.armor_id), rarity: ctx.p.armor_rarity ?? 0 }, ...(casts(ctx.p.class) ? [] : [{ slot: "weapon", item_id: carriedId("weapon", ctx.p.class, ctx.p.weapon_id), rarity: ctx.p.weapon_rarity ?? 0 }])]);
    const old = ctx.p.class;
    await savePlayer(ctx, { class: toClass, path: toPath, specialized: toSpecialized, level: 1, exp: 0, hp: 20, max_hp: 20, str: 10, def: 1, weapon_id: 0, armor_id: 0, weapon_rarity: 0, armor_rarity: 0, gold, bank, ground: null, respec_at: new Date().toISOString() });
    await saveTurns(ctx, { specials: GAME.classes[toClass].specialsPerDay, mana: manaMax(ctx.p) });
    await post(ctx, "respec", ctx.p.name, null, { from: old, to: toClass, line: `${ctx.p.name} has ${PUT_DOWN[old]} and ${TAKE_UP[toClass]}.` });
    await logEvent(ctx, "respec", { from: old, to: toClass, path: toPath, from_level: quote.from_level, fee, buyback });
    ctx.events.push({ kind: "respec_done", ...quote, gold, bank });
    ctx.hint = "A new beginning: tell it as a turning point in two or three sentences, from the old life to the new, then the new class's basics (their attribute, their first spell or fists, their special) and the Town menu.";
  }));
});

// ---------- specializations ----------

/** The specializations on this player's path: who teaches each, where, whether it's taught yet, and whether here. */
function specChoices(ctx: Ctx) {
  const here = ctx.p.pos_x === null || ctx.p.pos_x === undefined ? "brightwater" : townAt(ctx.p.pos_x, ctx.p.pos_y!);
  return specsOf(ctx.p.path).map(([id, s]) => ({
    spec: id, teacher: s.teacher, where: s.where, towns: s.towns.map((t) => t === "brightwater" ? "Brightwater" : TOWN_TILES[t as keyof typeof TOWN_TILES].name),
    about: s.about, taught: s.open, here: s.open && here !== null && s.towns.includes(here), current: ctx.p.specialized && ctx.p.class === id,
  }));
}

/** What the player's path offers, and what choosing (or switching) would cost. */
api.get("/specialize", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  if (ctx.p.specialized !== false) { ctx.events.push({ kind: "no_specializations", class: ctx.p.class, reason: "every class is open from the start now; to become a different class, start over (respec)" }); return; }
  const switching = ctx.p.specialized;
  ctx.events.push({
    kind: "specializations", path: PATHS[ctx.p.path].name, level: ctx.p.level, specialize_at: SPECIALIZE_AT, specialized: ctx.p.specialized,
    class: ctx.p.class, choices: specChoices(ctx),
    ...(switching ? { switch_fee: SPEC_SWITCH_PER_LEVEL * ctx.p.level, switch_every_days: SPEC_SWITCH_DAYS } : { first_choice: "free" }),
  });
  ctx.hint = "List the choices with their teachers and where to find them; mark the ones not taught yet as coming later, without inventing details.";
})));

/**
 * A character still on a beginner's class from when paths came first chooses its class on that path, once and
 * free, from its teacher, keeping everything. Nobody else specializes. Without confirm: true it only quotes.
 */
api.post("/specialize", async (c) => {
  const body = z.object({ spec: z.enum(["warrior", "thief", "mage", "priest", "guardian", "bard"]), confirm: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    if (ctx.p.role !== "player") { ctx.events.push({ kind: "not_for_you", reason: "townsfolk are who they are" }); return; }
    // Every class is open from the start now. Only a character made while paths came first, still on its
    // beginner's class, gets this: one free choice within its path, at any level.
    if (ctx.p.specialized !== false) { ctx.events.push({ kind: "no_specializations", class: ctx.p.class, reason: "every class is open from the start now; to become a different class, start over (respec)" }); return; }
    const spec = body.spec as Spec, def = SPECS[spec];
    if (def.path !== ctx.p.path) { ctx.events.push({ kind: "not_your_path", spec, path: PATHS[ctx.p.path].name, choices: specChoices(ctx), instead: "a different path means starting over (respec)" }); return; }
    if (!def.open) { ctx.events.push({ kind: "not_taught_yet", spec, teacher: def.teacher }); return; }
    if (ctx.p.specialized && ctx.p.class === spec) { ctx.events.push({ kind: "already_that_class", class: spec }); return; }
    requireTown(ctx, def.teacher, def.towns);
    const switching = ctx.p.specialized;
    const fee = switching ? SPEC_SWITCH_PER_LEVEL * ctx.p.level : 0;
    if (switching) {
      const last = ctx.p.respec_at ? new Date(ctx.p.respec_at) : null;
      if (last && Date.now() - last.getTime() < SPEC_SWITCH_DAYS * 86_400_000) {
        ctx.events.push({ kind: "respec_too_soon", next: new Date(last.getTime() + SPEC_SWITCH_DAYS * 86_400_000).toISOString().slice(0, 10), every_days: SPEC_SWITCH_DAYS });
        return;
      }
    }
    const quote = {
      from: ctx.p.class, to: spec, teacher: def.teacher, about: def.about, level: ctx.p.level, fee,
      keeps: ["level", "experience", "HP, attribute and defense", "weapon or spell tier, and armor", "everything else"],
      ...(switching ? { every_days: SPEC_SWITCH_DAYS } : { first_choice: "free" }),
    };
    if (!body.confirm) {
      ctx.events.push({ kind: "specialize_quote", ...quote, gold: ctx.p.gold, ...(ctx.p.gold < fee ? { short_by: fee - ctx.p.gold } : {}) });
      ctx.hint = "Say what they'd become and what it costs, then ask Confirm? (Y)es / (N)o. Only on a yes call again with confirm: true.";
      return;
    }
    if (ctx.p.gold < fee) { ctx.events.push({ kind: "too_poor", cost: fee, gold: ctx.p.gold }); return; }
    const old = ctx.p.class;
    await savePlayer(ctx, { class: spec as PlayerClass, specialized: true, gold: ctx.p.gold - fee, ...(switching ? { respec_at: new Date().toISOString() } : {}) });
    const as = { ...ctx.p, class: spec as PlayerClass };
    await saveTurns(ctx, { specials: GAME.classes[spec as PlayerClass].specialsPerDay, mana: casts(as.class) ? manaMax(as) : 0 });
    await post(ctx, "specialize", ctx.p.name, null, { from: old, to: spec, line: switching ? `${ctx.p.name} has ${PUT_DOWN[old]} and ${TAKE_UP[spec]}.` : `${ctx.p.name} has ${TAKE_UP[spec]}, under ${def.teacher}.` });
    await logEvent(ctx, "specialize", { from: old, to: spec, level: ctx.p.level, fee, first: !switching });
    ctx.events.push({ kind: "specialized", ...quote, gold: ctx.p.gold - fee });
    ctx.hint = "A turning point: the teacher, a sentence or two of what changes in how they fight, then the new special and the Town menu.";
  }));
});

// ---------- the keeper's tools (admins only) ----------

function requireAdmin(ctx: Ctx) {
  if (!ctx.p.admin) throw new GameError("not_found", "no such thing here", 404);
}
async function audit(ctx: Ctx, action: string, target: string | null, detail: Record<string, unknown> = {}) {
  await ctx.c.query("insert into admin_log (admin, action, target, detail) values ($1,$2,$3,$4)", [ctx.p.name, action, target, JSON.stringify(detail)]);
}
const NAME_RULE = z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_.'-]+( [A-Za-z0-9_.'-]+)*$/, "letters, digits, apostrophes, periods, hyphens, single spaces");

/**
 * Carry your characters to another machine. The plugin seals its keys with a code it makes up and shows the
 * maintainer; we keep only the sealed bundle and the code's hash, hand it over once, and forget it.
 */
api.post("/admin/share", async (c) => {
  const body = z.object({ code_hash: z.string().regex(/^[0-9a-f]{64}$/), sealed: z.string().min(16).max(20000) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    await ctx.c.query("delete from key_shares where expires_at < now() or claimed_at is not null");
    await ctx.c.query("insert into key_shares (code_hash, sealed, created_by) values ($1,$2,$3)", [body.code_hash, body.sealed, ctx.p.id]);
    await audit(ctx, "share_keys", null, {});
    ctx.events.push({ kind: "keys_shared", expires_in_minutes: 15 });
  }));
});
api.post("/admin/claim", async (c) => {
  const body = z.object({ code_hash: z.string().regex(/^[0-9a-f]{64}$/) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const r = await ctx.c.query<{ sealed: string }>(
      "update key_shares set claimed_at = now(), claimed_by = $2 where code_hash = $1 and claimed_at is null and expires_at > now() returning sealed", [body.code_hash, ctx.p.id]);
    if (!r.rowCount) { ctx.events.push({ kind: "no_such_share", reason: "wrong code, already used, or more than 15 minutes old" }); return; }
    await audit(ctx, "claim_keys", null, {});
    ctx.events.push({ kind: "keys_claimed", sealed: r.rows[0].sealed });
  }));
});

/** Find players by name, newest first: who they are, when they were last seen, and their standing. */
api.get("/admin/players", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAdmin(ctx);
  const q = (c.req.query("q") ?? "").trim();
  const r = await ctx.c.query(
    `select name, class, level, role, is_test, banned_at, created_at, last_seen, client->>'plugin' as plugin,
       (select count(*) from tavern t where t.author = p.name)::int as posts
     from players p where role = 'player' and ($1 = '' or name ilike '%' || $1 || '%') order by created_at desc limit 30`, [q]);
  ctx.events.push({ kind: "admin_players", players: r.rows });
})));

/** Give a player a new name. Their history (news, tavern, chronicle) follows the new name; they're told once. */
api.post("/admin/rename", async (c) => {
  const body = z.object({ name: z.string().trim().min(1).max(40), to: NAME_RULE }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const who = (await ctx.c.query<{ id: string; name: string; role: string }>("select id, name, role from players where lower(name) = lower($1)", [body.name])).rows[0];
    if (!who || who.role !== "player") { ctx.events.push({ kind: "admin_error", error: "no_such_player", name: body.name }); return; }
    if (reservedName(body.to)) { ctx.events.push({ kind: "admin_error", error: "reserved_name", to: body.to }); return; }
    const taken = await ctx.c.query("select 1 from players where lower(name) = lower($1) and id <> $2", [body.to, who.id]);
    if (taken.rowCount) { ctx.events.push({ kind: "admin_error", error: "name_taken", to: body.to }); return; }
    const old = who.name;
    await ctx.c.query("update players set name = $2, renamed_from = $3 where id = $1", [who.id, body.to, old]);
    await ctx.c.query("update news set actor = $2 where actor = $1", [old, body.to]);
    await ctx.c.query("update news set target = $2 where target = $1", [old, body.to]);
    await ctx.c.query("update news set detail = jsonb_set(detail, '{stole_from}', to_jsonb($2::text)) where detail->>'stole_from' = $1", [old, body.to]);
    await ctx.c.query("update news set detail = jsonb_set(detail, '{left}', to_jsonb($2::text)) where detail->>'left' = $1", [old, body.to]);
    await ctx.c.query("update tavern set author = $2 where author = $1", [old, body.to]);
    await ctx.c.query("update bots set mind = jsonb_set(mind, '{grudge,name}', to_jsonb($2::text)) where mind->'grudge'->>'name' = $1", [old, body.to]);
    // The chronicle is prose: swap the old name wherever it stands as a whole word.
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await ctx.c.query("update chronicle set body = regexp_replace(body, $1, $2, 'g') where body ~ $1", [`\\m${esc}\\M`, body.to]);
    await audit(ctx, "rename", old, { to: body.to });
    ctx.events.push({ kind: "admin_done", action: "rename", from: old, to: body.to });
  }));
});

/** Bar a player from the realm (their key stops working) and take them off everything public. Unban reverses it. */
api.post("/admin/ban", async (c) => {
  const body = z.object({ name: z.string().trim().min(1).max(40), reason: z.string().max(200).optional(), hide_posts: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const who = (await ctx.c.query<{ id: string; name: string; role: string; admin: boolean }>("select id, name, role, admin from players where lower(name) = lower($1)", [body.name])).rows[0];
    if (!who || who.role !== "player") { ctx.events.push({ kind: "admin_error", error: "no_such_player", name: body.name }); return; }
    if (who.admin) { ctx.events.push({ kind: "admin_error", error: "cannot_ban_admin" }); return; }
    await ctx.c.query("update players set banned_at = now(), is_test = true where id = $1", [who.id]);
    let hidden = 0;
    if (body.hide_posts !== false) hidden = (await ctx.c.query("update tavern set hidden_at = now() where author = $1 and hidden_at is null", [who.name])).rowCount ?? 0;
    await audit(ctx, "ban", who.name, { reason: body.reason ?? null, posts_hidden: hidden });
    ctx.events.push({ kind: "admin_done", action: "ban", name: who.name, posts_hidden: hidden });
  }));
});

api.post("/admin/unban", async (c) => {
  const body = z.object({ name: z.string().trim().min(1).max(40) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const r = await ctx.c.query<{ name: string }>("update players set banned_at = null, is_test = false where lower(name) = lower($1) and banned_at is not null returning name", [body.name]);
    if (!r.rowCount) { ctx.events.push({ kind: "admin_error", error: "not_banned", name: body.name }); return; }
    await audit(ctx, "unban", r.rows[0].name);
    ctx.events.push({ kind: "admin_done", action: "unban", name: r.rows[0].name, note: "their tavern posts stay hidden; unhide any you want back" });
  }));
});

/** Recent tavern posts with their ids, hidden ones included, to find something to hide. */
api.get("/admin/posts", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAdmin(ctx);
  const days = Math.min(14, Math.max(1, Number(c.req.query("days") ?? 2)));
  const who = (c.req.query("author") ?? "").trim();
  const r = await ctx.c.query(
    `select id::int, day::text, author, body, hidden_at is not null as hidden from tavern
     where day > current_date - $1::int and ($2 = '' or lower(author) = lower($2)) order by id desc limit 50`, [days, who]);
  ctx.events.push({ kind: "admin_posts", posts: r.rows });
})));

/** Hide a tavern post from the board and the chronicle (or bring it back with hidden: false). */
api.post("/admin/hide_post", async (c) => {
  const body = z.object({ id: z.number().int(), hidden: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const hide = body.hidden !== false;
    const r = await ctx.c.query<{ author: string; body: string; day: string }>(
      "update tavern set hidden_at = $2 where id = $1 returning author, body, day::text", [body.id, hide ? new Date() : null]);
    if (!r.rowCount) { ctx.events.push({ kind: "admin_error", error: "no_such_post", id: body.id }); return; }
    await audit(ctx, hide ? "hide_post" : "unhide_post", r.rows[0].author, { id: body.id, body: r.rows[0].body });
    ctx.events.push({ kind: "admin_done", action: hide ? "hide_post" : "unhide_post", id: body.id, author: r.rows[0].author, day: r.rows[0].day,
      note: "If this day already has a chronicle entry that quotes it, rewrite that day with the chronicle tool." });
  }));
});

// ---------- public (no auth) ----------

/** What the website shows: player count, headlines, top of the board. Names only, nothing private. */
api.get("/public/realm", async (c) => {
  const out = await tx(async (db) => {
    const settings = await realmSettings(db);
    const today = realmDay(settings.resetHourUtc);
    const y = new Date(today + "T00:00:00Z"); y.setUTCDate(y.getUTCDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    const players = await db.query<{ n: string }>("select count(*)::text as n from players where role = 'player' and not is_test");
    const news = await db.query<{ day: string; kind: string; actor: string | null; target: string | null; detail: Record<string, unknown> }>(
      "select day::text, kind, actor, target, detail from news where day in ($1, $2) and kind <> 'join' order by id desc limit 12", [today, yesterday]);
    const top = await db.query("select name, class, level, is_bot as bot, dragon_kills from players where role <> 'npc' and not is_test order by level desc, exp desc limit 10");
    return {
      day: today,
      dragon_alive: settings.dragonAlive,
      players: Number(players.rows[0].n),
      news: news.rows.map((n) => ({ day: n.day, line: newsLine(n) })),
      top: top.rows,
    };
  });
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
  return c.json(out);
});

/** Everyone on the board, for the website's rankings page: adventurers and townsfolk, never test or trial characters. Names only. */
api.get("/public/rankings", async (c) => {
  const out = await tx(async (db) => {
    const today = realmDay((await realmSettings(db)).resetHourUtc);
    const r = await db.query<{ name: string; class: string; level: number; bot: boolean; town: string; dragon_kills: number; days: number | null; wed: boolean }>(
      `select p.name, p.class, p.level, p.is_bot as bot, coalesce(b.home, p.start_town, 'brightwater') as town, p.dragon_kills,
              (current_date - p.last_seen::date) as days, p.spouse_id is not null as wed
       from players p left join bots b on b.player_id = p.id
       where p.role <> 'npc' and not p.is_test order by p.level desc, p.exp desc, p.name limit 1000`);
    return {
      day: today,
      rankings: r.rows.map((x) => ({ name: x.name, class: x.class, level: x.level, bot: x.bot, town: x.town, dragon_kills: x.dragon_kills, married: x.wed,
        seen: x.days === null ? "a while ago" : x.days <= 0 ? "today" : x.days <= 7 ? "this week" : x.days <= 31 ? "this month" : "a while ago" })),
    };
  });
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
  return c.json(out);
});

/** For the website's auction page: what kind of gear a lot is and which classes can use it, for its filters. Anyone can use everything else. */
const FAMILY_CLASSES: Record<string, string[]> = { steel: ["warrior", "guardian"], shadow: ["thief"], mage: ["mage"], priest: ["priest"], bard: ["bard"],
  heavy: ["warrior", "guardian"], leathers: ["thief"], robes: ["mage", "priest"], performer: ["bard"] };
function whoFor(slot: ListSlot, id: number): { kind?: string; for?: string; classes?: string[] } {
  if (slot !== "weapon" && slot !== "armor") return {};
  const f = familyOf(slot, id);
  return f ? { kind: familyLabel(slot, id) ?? undefined, for: familyUsers(slot, id) ?? undefined, classes: FAMILY_CLASSES[f] } : {};
}

/** The auction house, for the website: what's on the board, what sold lately, and prices over time. Names only. */
api.get("/public/auctions", async (c) => {
  const out = await tx(async (db) => {
    const today = realmDay((await realmSettings(db)).resetHourUtc);
    await settleAuctions(db, today);
    const stats = (slot: ListSlot, id: number, r = 0) =>
      slot === "weapon" ? { power: boosted(weapon(id).str, r), ...(r ? { rarity: rarity(r).name } : {}) } : slot === "armor" ? { def: boosted(armor(id).def, r), ...(r ? { rarity: rarity(r).name } : {}) } : slot === "trinket" ? { bonus: bonusText(trinket(id)) } : slot === "potion" ? { bonus: potion(id).what } : {};
    const open = (await db.query<ARow>(`${A_SELECT} where a.status = 'open' and s.is_test is not true order by a.ends_day, a.id limit 60`)).rows;
    const sold = (await db.query<ARow & { day: string }>(
      `${A_SELECT.replace("a.collected,", "a.collected, a.settled_at::date::text as day,")} where a.status = 'sold' and s.is_test is not true and b.is_test is not true order by a.settled_at desc limit 25`)).rows;
    // Every sale in the last 30 days, per item, priced per unit.
    const hist = (await db.query<{ slot: ListSlot; item_id: number; rarity: number; day: string; n: string; unit: string; lo: string; hi: string }>(
      `select a.slot, a.item_id, a.rarity, a.settled_at::date::text as day, count(*)::text as n,
              round(avg(a.high_bid::numeric / a.qty))::text as unit, min(a.high_bid / a.qty)::text as lo, max(a.high_bid / a.qty)::text as hi
       from auctions a left join players s on s.id = a.seller_id left join players b on b.id = a.high_bidder
       where a.status = 'sold' and a.settled_at > now() - interval '30 days' and s.is_test is not true and b.is_test is not true
       group by 1, 2, 3, 4 order by 1, 2, 3, 4`)).rows;
    const items = new Map<string, { item: string; slot: ListSlot; worth: number; days: { day: string; sales: number; avg: number; low: number; high: number }[] }>();
    for (const h of hist) {
      const k = `${h.slot}:${h.item_id}:${h.rarity}`;
      if (!items.has(k)) items.set(k, { item: worth(h.slot, h.item_id, h.rarity).name, slot: h.slot, worth: worth(h.slot, h.item_id, h.rarity).value, days: [] });
      items.get(k)!.days.push({ day: h.day, sales: Number(h.n), avg: Number(h.unit), low: Number(h.lo), high: Number(h.hi) });
    }
    const trends = [...items.values()].map((t) => {
      const sales = t.days.reduce((n, d) => n + d.sales, 0);
      return { ...t, sales, avg: Math.round(t.days.reduce((n, d) => n + d.avg * d.sales, 0) / sales), low: Math.min(...t.days.map((d) => d.low)), high: Math.max(...t.days.map((d) => d.high)), last: t.days[t.days.length - 1].avg };
    }).sort((a, z) => z.sales - a.sales || a.item.localeCompare(z.item));
    return {
      day: today,
      open: open.map((r) => ({ lot: Number(r.id), item: lotName(r), slot: r.slot, ...stats(r.slot, r.item_id, r.rarity), ...whoFor(r.slot, r.item_id), worth: worth(r.slot, r.item_id, r.rarity).value * r.qty,
        seller: r.seller ?? "the house", town: TOWNS[r.town as Town] ?? r.town, min_bid: r.min_bid, high_bid: r.high_bid, buy_now: r.buy_now, closes_after: r.ends_day })),
      sold: sold.map((r) => ({ item: lotName(r), slot: r.slot, ...whoFor(r.slot, r.item_id), price: r.high_bid, seller: r.seller ?? "the house", buyer: r.bidder, day: r.day, bought_outright: r.buy_now !== null && r.high_bid === r.buy_now })),
      trends,
    };
  });
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
  return c.json(out);
});

// ---------- read-only ----------

api.get("/status", async (c) => c.json(await withPlayer(c.req.header("authorization"), async () => {}, { weather: true, surroundings: true })));

// Fights told with each class's flair, or plainly.
api.post("/fight_style", async (c) => {
  const body = z.object({ plain: z.boolean() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    await savePlayer(ctx, { plain_fights: body.plain });
    ctx.events.push({ kind: "fight_style", plain: body.plain });
  }));
});

// Weather on or off for this player. Nothing about their location is kept either way.
api.post("/weather", async (c) => {
  const body = z.object({ on: z.boolean() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    await savePlayer(ctx, { weather_off: !body.on });
    ctx.events.push({ kind: "weather_setting", on: body.on });
  }, { weather: true }));
});

api.get("/news", async (c) => {
  const which = c.req.query("day") === "yesterday" ? -1 : 0;
  const compact = c.req.query("compact") === "1";
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const day = new Date(ctx.day + "T00:00:00Z");
    day.setUTCDate(day.getUTCDate() + which);
    const d = day.toISOString().slice(0, 10);
    // The last 40 happenings, with arrivals collapsed into one line so a flood of sign-ups can't bury the news.
    const r = await ctx.c.query<{ kind: string; actor: string | null; target: string | null; detail: Record<string, unknown>; ts: string }>(
      "select * from (select kind, actor, target, detail, ts, id from news where day = $1 and kind <> 'join' order by id desc limit 40) x order by id", [d]);
    const joins = await ctx.c.query<{ n: string; names: string[] | null }>(
      "select count(*)::text as n, (array_agg(actor order by id desc))[1:5] as names from news where day = $1 and kind = 'join'", [d]);
    const joinCount = Number(joins.rows[0].n);
    if (joinCount) {
      const names = joins.rows[0].names ?? [];
      const extra = joinCount - names.length;
      r.rows.unshift({ kind: "joins", actor: null, target: null, detail: { names, count: joinCount, line: `${names.join(", ")}${extra > 0 ? ` and ${extra} other${extra === 1 ? "" : "s"}` : ""} entered the realm.` }, ts: "" });
    }
    if (compact) {
      const unread = await ctx.c.query<{ n: string }>("select count(*)::text as n from messages where to_player = $1 and read_at is null", [ctx.p.id]);
      ctx.events.push({ kind: "news_compact", day: d, lines: r.rows.map(newsLine), unread_mail: Number(unread.rows[0].n) });
    } else {
      const top = await ctx.c.query<{ m: string }>("select coalesce(max(id), 0)::text as m from news");
      await savePlayer(ctx, { news_seen_upto: Number(top.rows[0].m) });
      for (const row of r.rows) ctx.events.push({ kind: "news", day: d, what: row.kind, actor: row.actor, target: row.target, detail: row.detail, line: newsLine(row), ts: row.ts });
    }
  }, { quiet: compact, weather: !compact }));
});

function aOrAn(item: string): string {
  if (/'s /.test(item) || /(Armor|Mail|Protection)$/.test(item)) return item; // possessives and armor read without an article
  return (/^[AEIOU]/i.test(item) ? "an " : "a ") + item;
}

export function newsLine(n: { kind: string; actor: string | null; target: string | null; detail: Record<string, unknown> }): string {
  switch (n.kind) {
    case "joins": return String(n.detail.line);
    case "gate_won": return `${n.actor} fought past ${n.detail.monster} on the road and walked into ${n.detail.place}.`;
    case "discovery": return n.detail.poi === "town"
      ? (n.detail.place === "Ashford" ? `${n.actor} made it to Ashford, down the south road, past Nan Silt at the ford.` : `${n.actor} made it to ${n.detail.place}, the hillfort few in Brightwater have ever seen, past Old Grudge on the road below the walls.`)
      : `${n.actor} discovered ${n.detail.place}${n.detail.poi === "cave" ? ", a cave in the hills" : n.detail.poi === "shrine" ? ", the old shrine up in the hills" : ""}.`;
    case "join": return `${n.actor} has entered the realm.`;
    case "meeting_called": return `${n.detail.where ?? "The town"} meets on a question: ${n.detail.question} Every voice counts until ${n.detail.closes_on ?? "the meeting closes"}.`;
    case "meeting_result": return `${n.detail.town ? (n.detail.town === "brightwater" ? "Brightwater" : n.detail.town === "ironhold" ? "Ironhold" : "Ashford") : "The realm"} has decided: ${n.detail.winner}. (${n.detail.question})${n.detail.tie_broken_by_town ? " The adventurers were split; the townsfolk settled it." : ""}`;
    case "pvp_kill": return `${n.actor} slew ${n.target} in the fields and took ${n.detail.gold} gold.`;
    case "pvp_survived": return `${n.target} fought off an attack from ${n.actor}.`;
    case "forest_death": return `${n.actor} was killed in the forest by a ${n.detail.monster}.`;
    case "level_up": return `${n.actor} reached level ${n.detail.level}.`;
    case "dragon": return `${n.actor} slew Vael the Watchful!`;
    case "dragon_death": return `${n.actor} was eaten by Vael the Watchful.`;
    case "married": {
      const to = n.target ?? "Violet";
      if (n.detail?.stole_from) return `${n.actor} won ${to}'s heart from ${n.detail.stole_from}.`;
      if (n.detail?.left) return `${n.actor} left ${n.detail.left} for ${to}.`;
      return `${n.actor} married ${to}.`;
    }
    case "goal": return String(n.detail.line);
    case "bond": return String(n.detail.line);
    case "respec": return String(n.detail.line);
    case "quest_news": return String(n.detail.line);
    case "forged": return `${n.actor} had Brannagh Steel forge ${/^[AEIOU]/.test(String(n.detail.item)) ? "an" : "a"} ${n.detail.item} in Ironhold.`;
    case "auction_sale": return `${n.actor} sold ${n.detail.item} at auction to ${n.target} for ${n.detail.price} gold.`;
    case "mined_out": return `${n.detail.place} was mined out today; ${n.actor} took the last of it.`;
    case "crafted": return `Odile made ${n.actor} ${aOrAn(String(n.detail.item))}.`;
    case "loot": return `${n.actor} pried ${aOrAn(String(n.detail.item))} off a dead ${n.detail.monster}.`;
    default: return `${n.actor ?? "Someone"} did something (${n.kind}).`;
  }
}

api.get("/rankings", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  // Online means they've done something in the last fifteen minutes (every call stamps last_seen), people and townsfolk alike.
  const r = await ctx.c.query("select name, class, level, exp, alive, dragon_kills, is_bot as bot, (last_seen > now() - interval '15 minutes') as online from players where role <> 'npc' and not is_test order by level desc, exp desc limit 20");
  ctx.events.push({ kind: "rankings", players: r.rows });
})));

/**
 * Who sells you what, where you are: the shop is the same for everyone (your own path's gear), but the counter
 * isn't. Brightwater's smith does weapons and heavy armor, and Della Moss, the clothier, everything softer and the
 * bags; Ironhold's Brannagh does weapons and Tobin Harrow the rest; Ashford's Haverly's does the Shadow path's gear.
 */
function soldBy(ctx: Ctx, kind: "weapon" | "armor" | "bag"): { keeper: string | null; where: string } {
  const town = townAt(ctx.p.pos_x, ctx.p.pos_y) ?? "brightwater";
  const fam = kind === "weapon" ? "weapon" : kind === "armor" ? armorFamilyOf(ctx.p.class) : "bag";
  if (town === "ironhold") {
    if (fam === "weapon") return { keeper: "Brannagh Steel", where: "the weaponry at the forge" };
    if (fam === "robes" || fam === "performer") return { keeper: "Tobin Harrow", where: "the rack at the back of the armory he keeps for visitors" };
    return { keeper: "Tobin Harrow", where: "the armory" };
  }
  if (town === "ashford") {
    if (fam === "performer") return { keeper: "Mags Pell", where: "the rail of stage clothes at the back of Pell's Music Room" };
    if (fam === "robes") return { keeper: null, where: "a cloth-seller's stall on the Exchange" };
    if (fam === "heavy" || (fam === "weapon" && weaponFamilyOf(ctx.p.class) === "steel")) return { keeper: "Sim Haverly", where: "Haverly's, from the few pieces he keeps for soldiers passing through" };
    return { keeper: "Sim Haverly", where: "Haverly's on the Exchange" };
  }
  if (fam === "weapon" || fam === "heavy") return { keeper: "the smith", where: "the smithy on Market Row" };
  return { keeper: "Della Moss", where: "her clothier's on Market Row" };
}

api.get("/shop", async (c) => {
  const q = c.req.query("kind");
  const kind = q === "armor" ? "armor" : q === "bag" ? "bag" : "weapon";
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const friend = await friendCut(ctx, soldBy(ctx, kind).keeper);
    const friendPct = friend.cut ? { friend_discount_pct: Math.round(friend.cut * 100), keeper_feels: friend.feels } : {};
    if (kind === "bag") { ctx.events.push({ kind: "catalog", shop: "bag", sold_by: soldBy(ctx, "bag"), owned: ctx.p.bag_id, items: GAME.bags, charm_discount_pct: Math.round(charmDiscount(charmOf(ctx.p)) * 100), ...friendPct }); return; }
    if (kind === "weapon" && casts(ctx.p.class)) { ctx.events.push({ kind: "not_for_you", reason: `the smith doesn't sell ${ctx.p.class === "bard" ? "instruments" : "spells"}; ${myVendor(ctx).name} does, at the ${myVendor(ctx).place}`, go: myVendor(ctx).place }); return; }
    const items = kind === "armor" ? GAME.armor : GAME.weapons;
    const owned = kind === "armor" ? ctx.p.armor_id : ctx.p.weapon_id;
    // A weapon's str is its power (a bonus on top of the class's attribute), so call it that.
    const named = (items as { id: number; name: string }[]).map((x) => ({ ...x, name: itemName(kind, x.id, ctx.p.class) }));
    const listed = kind === "weapon" ? (named as unknown as { str: number }[]).map(({ str, ...rest }) => ({ ...rest, power: str })) : named;
    ctx.events.push({ kind: "catalog", shop: kind, sold_by: soldBy(ctx, kind), owned, items: listed, charm_discount_pct: Math.round(charmDiscount(charmOf(ctx.p)) * 100), ...friendPct });
  }));
});

/** A weapon drop reads as a spell scroll to a caster: reading it (equip) teaches the spell. */
function lootName(p: Player, drop: { kind: string; item: string; tier: number }): string {
  return drop.kind === "weapon" && casts(p.class) ? casterItemName(p.class, drop.tier) : drop.item;
}

// ---------- forest ----------

api.post("/forest", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  await requireNoEncounter(ctx);
  await dropEvent(ctx);
  if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left" }); return; }
  if (inWild(ctx.p) && townAt(ctx.p.pos_x, ctx.p.pos_y)) throw new GameError("in_town", "there's nothing to hunt inside the walls: step outside first", 409);
  await leaveInn(ctx);
  if (ctx.p.ground) {
    ctx.events.push({ kind: "left_behind", item: Bag.item(ctx.p.ground.slot, ctx.p.ground.item_id).name });
    await savePlayer(ctx, { ground: null });
  }
  // Out in the wild, what you meet depends on where you stand. In town, players head out first;
  // Only plugins from before exploration still get the old forest at their own level; everyone else,
  // townsfolk included, hunts out in the wild.
  const here = inWild(ctx.p) ? tileAt(ctx.p.pos_x!, ctx.p.pos_y!) : null;
  const plugin = current()?.plugin;
  if (!here && (ctx.p.role !== "player" || (plugin && !older(plugin, "0.5.0")))) {
    throw new GameError("in_town", "the wild starts at the town gate: explore first", 409);
  }
  const depth = here ? ctx.p.cave_depth ?? 0 : 0;
  const level = here ? caveLevel(here.level, depth) : ctx.p.level;
  await saveTurns(ctx, { forest_fights: ctx.t.forest_fights - 1 });
  if (roll(99) < 10) {
    // found something instead of a fight
    const gold = roll(10 * level) + 5;
    await savePlayer(ctx, { gold: ctx.p.gold + gold });
    ctx.events.push({ kind: "found_gold", gold });
    return;
  }
  // Night where the player is makes the wild worse (and more rewarding). Caves are dark either way, and the same.
  const m = pickMonster(level, regionHere(ctx), Boolean(here) && !ctx.p.cave_depth && isNight());
  await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, m]);
  ctx.events.push({ kind: "encounter", monster: m, ...(here ? { place: here.name, terrain: here.terrain } : {}), ...(depth ? { in_cave: true, depth } : {}) });
}, { weather: true })));

api.post("/fight", async (c) => {
  const body = z.object({ action: z.enum(["attack", "special", "staff", "heal", "run"]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const was = { fighting: false };
    try { await fightRound(ctx, body, was); } finally { if (was.fighting) await draughtWearsOff(ctx); }
  }));
});

async function fightRound(ctx: Ctx, body: { action: "attack" | "special" | "staff" | "heal" | "run" }, was: { fighting: boolean }) {
  {
    requireAlive(ctx);
    const r = await ctx.c.query<{ id: string; kind: string; monster: Monster; round: number; log: Event[] }>("select id, kind, monster, round, log from encounters where player_id = $1", [ctx.p.id]);
    if (!r.rowCount) throw new GameError("no_encounter", "you are not in a fight");
    was.fighting = true;
    const enc = r.rows[0];
    const m = enc.monster;

    if (body.action === "run") {
      if (enc.kind === "master") { ctx.events.push({ kind: "cannot_run", reason: "your master will not let you leave" }); return; }
      if (enc.kind === "gate") { ctx.events.push({ kind: "cannot_run", reason: "it has the road, and there's no way round it" }); return; }
      if (fleeSucceeds(ctx.p)) {
        await ctx.c.query("delete from encounters where id = $1", [enc.id]);
        ctx.events.push({ kind: "fled", monster: m.name });
        await logEvent(ctx, "fight_end", { encounter: enc.kind, monster: m.name, monster_level: m.level ?? null, outcome: "fled", hp_left: ctx.p.hp, max_hp: ctx.p.max_hp, ...fightSummary(enc.log ?? [], [], ctx.p.name) });
        return;
      }
      // failed to flee: monster gets a free swing
      const pf = fighterOf(ctx.p);
      const dmg = Math.max(0, Math.round(blow(m.str, pf.def)));
      await savePlayer(ctx, { hp: Math.max(0, ctx.p.hp - dmg) });
      ctx.events.push({ kind: "flee_failed", monster: m.name, damage: dmg, hp: ctx.p.hp });
      if (ctx.p.hp <= 0) {
        await ctx.c.query("delete from encounters where id = $1", [enc.id]);
        await logEvent(ctx, "fight_end", { encounter: enc.kind, monster: m.name, monster_level: m.level ?? null, outcome: enc.kind === "master" ? "master_won" : "died", while: "fleeing", hp_left: 0, max_hp: ctx.p.max_hp, ...fightSummary(enc.log ?? [], [], ctx.p.name) });
        await lose(ctx, enc.kind, m);
      }
      return;
    }

    let mult = 1;
    let dodge = false;
    const mr = manaRules(ctx.p.class);
    let staff = false;
    if (body.action === "heal") {
      // A healer's prayer: mana for health, and the monster still gets its swing.
      if (!mr?.heal) { ctx.events.push({ kind: "cannot_heal", reason: "your class has no healing prayers" }); return; }
      const mana = ctx.t.mana ?? 0;
      if (mana < mr.heal) { ctx.events.push({ kind: "no_mana", need: mr.heal, mana }); return; }
      await saveTurns(ctx, { mana: mana - mr.heal });
      const healed = Math.min(ctx.p.max_hp - ctx.p.hp, Math.ceil(ctx.p.max_hp * (mr.healPct ?? 0.3)));
      await savePlayer(ctx, { hp: ctx.p.hp + healed });
      flair(ctx, enc.round, false, "plea");
      ctx.events.push({ kind: "healed_self", healed, hp: ctx.p.hp, mana: ctx.t.mana, mana_max: manaMax(ctx.p) });
      const pf0 = fighterOf(ctx.p);
      const dmg = Math.max(0, Math.round(blow(m.str, pf0.def)));
      await savePlayer(ctx, { hp: Math.max(0, ctx.p.hp - dmg) });
      ctx.events.push(dmg > 0 ? { kind: "hit", attacker: m.name, defender: ctx.p.name, damage: dmg, defender_hp: ctx.p.hp } : { kind: "miss", attacker: m.name, defender: ctx.p.name });
      if (ctx.p.hp <= 0) {
        await ctx.c.query("delete from encounters where id = $1", [enc.id]);
        await logEvent(ctx, "fight_end", { encounter: enc.kind, monster: m.name, monster_level: m.level ?? null, outcome: enc.kind === "master" ? "master_won" : "died", while: "praying", hp_left: 0, max_hp: ctx.p.max_hp, ...fightSummary(enc.log ?? [], [], ctx.p.name) });
        await lose(ctx, enc.kind, m);
      } else {
        await ctx.c.query("update encounters set round = round + 1 where id = $1", [enc.id]);
      }
      return;
    }
    if (mr) {
      // Casters: a spell costs mana, Fireball costs more, and the staff costs nothing but hits soft.
      const mana = ctx.t.mana ?? 0;
      if (body.action === "special") {
        if (mana < mr.fireball) { ctx.events.push({ kind: "no_mana", need: mr.fireball, mana }); return; }
        await saveTurns(ctx, { mana: mana - mr.fireball });
        mult = specialMultiplier(ctx.p);
        dodge = specialDodges(ctx.p); // a bard's Opus can lull what it's played at, so it doesn't swing back
        ctx.events.push({ kind: "cast", spell: specialName(ctx.p.class, ctx.p.weapon_id), special: true, ...(ctx.p.class === "bard" ? { verse: "opus", instrument: weaponName(ctx.p.class, ctx.p.weapon_id) } : {}), mana: ctx.t.mana, mana_max: manaMax(ctx.p) });
      } else if (body.action === "attack" && mana >= mr.cast) {
        await saveTurns(ctx, { mana: mana - mr.cast });
        ctx.events.push({ kind: "cast", spell: weaponName(ctx.p.class, ctx.p.weapon_id), ...(ctx.p.class === "bard" ? { verse: "haiku" } : {}), mana: ctx.t.mana, mana_max: manaMax(ctx.p) });
      } else {
        staff = true;
        ctx.events.push({ kind: "staff", ...(body.action === "attack" ? { out_of_mana: true } : {}), mana, mana_max: manaMax(ctx.p) });
      }
    } else if (body.action === "special") {
      if (ctx.t.specials <= 0) { ctx.events.push({ kind: "no_specials_left" }); return; }
      await saveTurns(ctx, { specials: ctx.t.specials - 1 });
      mult = specialMultiplier(ctx.p);
      dodge = specialDodges(ctx.p);
    }

    flair(ctx, enc.round, mult > 1, staff ? "staff" : undefined);
    const pf = fighterOf(ctx.p);
    if (staff) { pf.kFrom = pf.str; pf.str = Math.round(pf.str * mr!.staff); }
    const mf = monsterAsFighter(m);
    const evs = exchange(pf, mf, mult, dodge);
    // A thief slips the counter, a guardian takes it on the shield, a bard's tune lulls it.
    for (const e of evs) if (e.kind === "dodged") e.how = ctx.p.class === "guardian" ? "blocked" : ctx.p.class === "bard" ? "lulled" : "slipped";
    ctx.events.push(...evs);
    m.hp = mf.hp;
    await savePlayer(ctx, { hp: pf.hp });

    const ended = (outcome: string) => logEvent(ctx, "fight_end", { encounter: enc.kind, monster: m.name, monster_level: m.level ?? null, outcome, hp_left: pf.hp, max_hp: ctx.p.max_hp, ...fightSummary(enc.log ?? [], evs, ctx.p.name) });
    if (mf.hp <= 0) {
      await ctx.c.query("delete from encounters where id = $1", [enc.id]);
      await ended("won");
      await win(ctx, enc.kind, m);
    } else if (pf.hp <= 0) {
      await ctx.c.query("delete from encounters where id = $1", [enc.id]);
      await ended(enc.kind === "master" ? "master_won" : "died");
      await lose(ctx, enc.kind, m);
    } else {
      await ctx.c.query("update encounters set monster = $2, round = round + 1, log = log || $3::jsonb where id = $1", [enc.id, m, JSON.stringify(evs)]);
    }
  }
}

/**
 * How each class's rounds are told: a warrior's in comic-book sound effects, a thief's in a hardboiled inner voice,
 * a mage's in the spell's own words, a priest's as prayers, a guardian's as the lines of their oath. Bards sing
 * (their casts carry verse). The narrator writes them; nothing here changes a roll. Players can turn it off.
 */
const FLAIR: Partial<Record<PlayerClass, string>> = { warrior: "comic", thief: "noir", mage: "incantation", priest: "prayer", guardian: "oath" };
function flair(ctx: Ctx, round: number, big: boolean, as?: "plea" | "staff") {
  const form = FLAIR[ctx.p.class];
  if (!form || ctx.p.plain_fights) return;
  const extra = form === "incantation" && as !== "staff" ? { words: incantation(big ? specialName(ctx.p.class, ctx.p.weapon_id) : weaponName(ctx.p.class, ctx.p.weapon_id), big) }
    : form === "oath" ? { line: big ? OATH[OATH.length - 1] : oathLine(round + 1) } : {};
  ctx.events.push({ kind: "flair", form, round: round + 1, ...(big ? { big: true } : {}), ...(as ? { as } : {}), ...extra });
  // Plugins from before 0.26.0 have no instructions for it; tell their narrator here, until they update.
  const plugin = current()?.plugin;
  if (plugin && older(plugin, "0.26.0") && !ctx.hint) ctx.hint = FLAIR_HINT[form] + " Then the result, with the real damage, in a plain sentence; the monster's swing back stays plain prose.";
}
const FLAIR_HINT: Record<string, string> = {
  comic: "Tell this round like the 1966 Batman show: the player's hit gets one comic-book sound effect on its own line in bold caps (**THWACK!**, **KRUNCH!**, fitted to the weapon and the monster, never the same one twice in a fight), a miss something deflating in plain lowercase italics (*whiff.*), never an HTML tag; with big, three stacked sounds, each bigger; a crit opens with an italic caption, *Meanwhile, at <place>…*. Faces, at most one a round, only on big moments, always in backticks: special wind-up `(ง •̀_•́)ง`, crit `ᕦ(ò_óˇ)ᕤ`, missed special `(╯°□°)╯︵ ┻━┻`, killing blow `(⌐■_■)`, a hard hit taken `(×_×)`; ordinary rounds get none.",
  noir: "Tell this round in the thief's hardboiled inner voice: one line, first person, past tense, in italics, before the result (*The rat had two problems. I was both of them.*); with big, three short lines; a dodged gets a line about never having been there. Dry, never cruel.",
  incantation: "Print the flair's words exactly, in italics, on their own line: the spell's incantation, the same every time. With big, add a loose gloss in brackets. With as: staff there are no words, just a sheepish aside.",
  prayer: "Tell this round as a prayer to the Lamp, in italics: a one-line invocation; with big, a four-line psalm; with as: plea, two earnest lines asking for help. Light, never fire.",
  oath: "Print the flair's line exactly, in italics, on its own line: the next line of the guardian's oath. A dodged with how: blocked gets just **HOLD.** on its own line.",
};

/** A player as they fight right now: their gear, and whatever draught they've had for this fight. */
function fighterOf(p: Player) {
  const f = playerAsFighter(p);
  if (p.boost) { f.str += p.boost.str ?? 0; f.def += p.boost.def ?? 0; }
  return f;
}

/** A draught lasts the fight it was drunk for (or the next, drunk between fights). Once that fight's over, it's gone. */
async function draughtWearsOff(ctx: Ctx) {
  if (!ctx.p.boost) return;
  const still = await ctx.c.query("select 1 from encounters where player_id = $1", [ctx.p.id]);
  if (still.rowCount) return;
  ctx.events.push({ kind: "draught_worn_off", draught: ctx.p.boost.name });
  await savePlayer(ctx, { boost: null });
}

async function win(ctx: Ctx, kind: string, m: Monster) {
  if (kind === "gate" && m.name === GATE_GUARDS.brightwater?.name) {
    await savePlayer(ctx, { gold: ctx.p.gold + m.gold, exp: ctx.p.exp + m.exp, pos_x: null, pos_y: null, cave_depth: null });
    await ctx.c.query("insert into explored (player_id, x, y) values ($1, 0, 0) on conflict do nothing", [ctx.p.id]);
    ctx.events.push({ kind: "gate_won", monster: m.name, gold: m.gold, exp: m.exp, town: "Brightwater" });
    await post(ctx, "gate_won", ctx.p.name, null, { monster: m.name, place: "Brightwater" });
    await logEvent(ctx, "gate", { town: "brightwater", monster: m.name });
    ctx.events.push({ kind: "arrived", place: "town", first_for_you: true });
    ctx.hint = "They've come down out of the hills into Brightwater for the first time. Call `square` and show them the town properly.";
    return;
  }
  if (kind === "gate") {
    // Through: into the town, which counts as found (and the first ever to get there makes the news).
    const id = ((Object.keys(GATE_GUARDS) as (keyof typeof TOWN_TILES)[]).find((t) => GATE_GUARDS[t]?.name === m.name) ?? "ironhold");
    const at = TOWN_TILES[id];
    await savePlayer(ctx, { gold: ctx.p.gold + m.gold, exp: ctx.p.exp + m.exp, pos_x: at.x, pos_y: at.y, cave_depth: null });
    ctx.events.push({ kind: "gate_won", monster: m.name, gold: m.gold, exp: m.exp, town: at.name });
    const t = tileAt(at.x, at.y);
    await ctx.c.query("insert into explored (player_id, x, y) values ($1,$2,$3) on conflict do nothing", [ctx.p.id, at.x, at.y]);
    const first = ctx.p.is_test ? { rowCount: 0 } : await ctx.c.query(
      "insert into discoveries (x, y, name, terrain, poi, found_by) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning 1", [at.x, at.y, t.name, t.terrain, t.poi, ctx.p.id]);
    if (first.rowCount) await post(ctx, "discovery", ctx.p.name, null, { place: t.name, poi: t.poi });
    else await post(ctx, "gate_won", ctx.p.name, null, { monster: m.name, place: t.name });
    await logEvent(ctx, "gate", { town: id, monster: m.name });
    ctx.events.push({ kind: "arrived", place: t.name, terrain: t.terrain, level: t.level, ring: t.ring, poi: t.poi, first_for_you: true, first_ever: Boolean(first.rowCount) });
    await arriveInTown(ctx, t);
    return;
  }
  if (kind === "forest") {
    const next = expForLevel(ctx.p.level + 1);
    await savePlayer(ctx, { gold: ctx.p.gold + m.gold, exp: ctx.p.exp + m.exp });
    ctx.events.push({ kind: "monster_slain", monster: m.name, gold: m.gold, exp: m.exp });
    await questTriggers(ctx, { win: true });
    const drop = rollDrop(m.level ?? ctx.p.level, ctx.p.class, await luck(ctx, "drop", dropChance(ctx.p.class)));
    if (drop) {
      // A find is of the finder's own family: what the land gives up, it gives up for you.
      const carried = carriedId(drop.kind, ctx.p.class, drop.tier);
      drop.item = carriedName(drop.kind, carried);
      const w = Bag.item(drop.kind, drop.tier).weight;
      const usedNow = await Bag.used(ctx.c, ctx.p.id);
      const cap = Bag.bag(ctx.p.bag_id).capacity;
      const upgrade = drop.tier > (drop.kind === "weapon" ? ctx.p.weapon_id : ctx.p.armor_id);
      if (usedNow + w <= cap) {
        await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,$2,$3)", [ctx.p.id, drop.kind, carried]);
        ctx.events.push({ kind: "loot", monster: m.name, item: lootName(ctx.p, drop), slot: drop.kind, weight: w, stored: true, upgrade, bag_used: usedNow + w, bag_capacity: cap });
      } else {
        await savePlayer(ctx, { ground: { slot: drop.kind, item_id: carried } });
        ctx.events.push({ kind: "loot", monster: m.name, item: lootName(ctx.p, drop), slot: drop.kind, weight: w, stored: false, upgrade, bag_used: usedNow, bag_capacity: cap });
      }
      await post(ctx, "loot", ctx.p.name, null, { item: drop.item, monster: m.name });
      await logEvent(ctx, "loot", { item: drop.item, slot: drop.kind, tier: drop.tier, monster_level: m.level ?? null, stored: usedNow + w <= cap, upgrade });
      ctx.hint = "A rare drop. Give it a beat: what it looks like, how it feels. If stored is false the bag is full and it's lying on the ground: offer (E)quip it now, or make room (sell or drop something) and Ta(k)e it, or leave it. It's gone if they walk back into the forest.";
    }
    // The land itself: ore off monsters in stone country, gems in the lowlands. Not in caves; there's the pick for that.
    const region = regionHere(ctx);
    const find = region ? rollFind(region, m.level ?? ctx.p.level) : null;
    if (find?.kind === "gem") {
      await savePlayer(ctx, { gems: ctx.p.gems + 1 });
      ctx.events.push({ kind: "found_material", monster: m.name, item: "a gem", gems: ctx.p.gems });
      await logEvent(ctx, "find", { item: "gem", region });
    } else if (find?.kind === "ore") {
      const o = oreOf(find.ore);
      const usedNow = await Bag.used(ctx.c, ctx.p.id);
      const cap = Bag.bag(ctx.p.bag_id).capacity;
      const fits = usedNow + o.weight <= cap;
      if (fits) await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,'ore',$2)", [ctx.p.id, o.id]);
      ctx.events.push({ kind: "found_material", monster: m.name, item: o.name, weight: o.weight, stored: fits, ...(fits ? {} : { reason: "bag_full" }), bag_used: usedNow + (fits ? o.weight : 0), bag_capacity: cap });
      await logEvent(ctx, "find", { item: o.name, region, stored: fits });
    }
    if (next !== null && ctx.p.exp >= next) ctx.events.push({ kind: "level_ready", level: ctx.p.level + 1 });
  } else if (kind === "master") {
    const lvl = ctx.p.level + 1;
    const g = levelGains(ctx.p.class, lvl);
    await savePlayer(ctx, {
      level: lvl,
      max_hp: ctx.p.max_hp + g.hp,
      hp: ctx.p.max_hp + g.hp,
      str: ctx.p.str + g.str,
      def: ctx.p.def + g.def,
    });
    const mrLvl = manaRules(ctx.p.class);
    if (mrLvl) await saveTurns(ctx, { mana: (ctx.t.mana ?? 0) + mrLvl.perLevel });
    await post(ctx, "level_up", ctx.p.name, null, { level: lvl });
    await logEvent(ctx, "level_up", { to: lvl, exp: ctx.p.exp });
    ctx.events.push({ kind: "level_up", level: lvl, max_hp: ctx.p.max_hp, str: ctx.p.str, attribute: attributeName(ctx.p.class), def: ctx.p.def });
  } else if (kind === "dragon") {
    await savePlayer(ctx, { dragon_kills: ctx.p.dragon_kills + 1, level: 1, exp: 0, hp: 20, max_hp: 20, str: 10, def: 1, weapon_id: 0, armor_id: 0, gold: 0, charm: ctx.p.charm + 10 });
    await ctx.c.query("insert into realm (key, value) values ('dragon_slain_day', $1::jsonb) on conflict (key) do update set value = excluded.value", [JSON.stringify(ctx.day)]);
    ctx.dragonAlive = false;
    // A fresh start keeps the bank, not the bag: nobody begins again at level 1 in endgame gear.
    await ctx.c.query("delete from inventory where player_id = $1", [ctx.p.id]);
    await savePlayer(ctx, { ground: null });
    await post(ctx, "dragon", ctx.p.name, null, {});
    await logEvent(ctx, "dragon_slain", { kills: ctx.p.dragon_kills });
    ctx.events.push({ kind: "dragon_slain", dragon_kills: ctx.p.dragon_kills });
    ctx.hint = "This is the climax of the game. Go big, then explain they start over at level 1 with their dragon kill recorded, their bank intact and their bag emptied. The dragon is gone for the rest of today and returns at the reset.";
  }
}

/** Losing to your master is a lesson, not a death: they send you off bruised, at 1 HP, with nothing taken. */
async function lose(ctx: Ctx, kind: string, m: Monster) {
  if (kind === "master") {
    await savePlayer(ctx, { hp: 1 });
    ctx.events.push({ kind: "master_won", master: m.name, hp: 1 });
    ctx.hint = "The master beat them but it's a lesson, not a death. Nothing is lost; they're at 1 HP and can try again after healing.";
    return;
  }
  await die(ctx, kind, m);
}

async function die(ctx: Ctx, kind: string, m: Monster) {
  const lost = ctx.p.gold;
  const expLoss = Math.floor(ctx.p.exp * 0.1);
  // You wake in your home town, however far out you fell.
  const home = homeTile(ctx.p);
  const atHome = home.x === 0 && home.y === 0 ? { pos_x: null, pos_y: null } : { pos_x: home.x, pos_y: home.y };
  await savePlayer(ctx, { alive: false, hp: 0, gold: 0, exp: ctx.p.exp - expLoss, ground: null, ...atHome, cave_depth: null });
  const itemLost = await Bag.loseRandom(ctx.c, ctx.p.id);
  if (kind === "dragon") await post(ctx, "dragon_death", ctx.p.name, null, {});
  else await post(ctx, "forest_death", ctx.p.name, null, { monster: m.name });
  ctx.events.push({ kind: "player_died", killer: m.name, gold_lost: lost, exp_lost: expLoss, item_lost: itemLost });
  await logEvent(ctx, "death", { by: kind, monster: m.name, gold_lost: lost, exp_lost: expLoss, item_lost: Boolean(itemLost) });
}

// ---------- train / dragon ----------

api.post("/train", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  // Brightwater's masters teach everyone; Ironhold's teach those who fight with blades and bows, Ashford's only the Shadow path.
  const trainTown = requireTown(ctx, "your master", trainsAt(ctx.p));
  await requireNoEncounter(ctx);
  const next = expForLevel(ctx.p.level + 1);
  if (next === null) { ctx.events.push({ kind: "max_level" }); return; }
  if (ctx.p.exp < next) { ctx.events.push({ kind: "not_ready", exp: ctx.p.exp, needed: next }); return; }
  if (needsSpec(ctx.p)) {
    ctx.events.push({ kind: "choose_specialization", level: ctx.p.level, path: PATHS[ctx.p.path].name, choices: specChoices(ctx) });
    ctx.hint = "The masters won't take them past this without a specialization. Say so in a line, then offer the choices (see specialize).";
    return;
  }
  await leaveInn(ctx);
  const ms = master(ctx.p.level)!;
  const known = (trainTown === "ironhold" ? lore().ironMasters : trainTown === "ashford" ? lore().ashMasters : lore().masters)[ms.level];
  const m: Monster = { name: known?.name || ms.name, hp: ms.hp, max_hp: ms.hp, str: ms.str, def: ms.def, gold: 0, exp: 0 };
  await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'master',$2)", [ctx.p.id, m]);
  // In Ashford a bard's test is Mags Pell's to arrange: she finds them someone worth playing against.
  const arranged = ctx.p.class === "bard" && trainTown === "ashford" ? { arranged_by: "Mags Pell, of the music room on the Exchange" } : {};
  ctx.events.push({ kind: "master_challenge", master: m, about: known?.about ?? null, level: ctx.p.level + 1, ...arranged });
  ctx.hint = "The master is testing them: introduce the master with `about`, in a sentence. Losing to a master is not fatal in the fiction; the server handles it.";
})));

api.post("/dragon", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
    requireInTown(ctx, "the dragon's lair");
  await requireNoEncounter(ctx);
  if (ctx.p.level < 12) { ctx.events.push({ kind: "too_weak", needed_level: 12 }); return; }
  if (!ctx.dragonAlive) { ctx.events.push({ kind: "dragon_dead" }); return; }
  if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left" }); return; }
  await leaveInn(ctx);
  await saveTurns(ctx, { forest_fights: ctx.t.forest_fights - 1 });
  const d = GAME.dragon;
  const m: Monster = { name: d.name, hp: d.hp, max_hp: d.hp, str: d.str, def: d.def, gold: 0, exp: 0 };
  await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'dragon',$2)", [ctx.p.id, m]);
  ctx.events.push({ kind: "encounter", monster: m, dragon: true });
})));

// ---------- town ----------

api.post("/healer", async (c) => {
  const body = z.object({ hp: z.union([z.literal("all"), z.number().int().positive()]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    requireTown(ctx, "the healer", ALL_TOWNS);
    await requireNoEncounter(ctx);
    const missing = ctx.p.max_hp - ctx.p.hp;
    const want = Math.min(missing, body.hp === "all" ? missing : body.hp);
    if (want <= 0) { ctx.events.push({ kind: "already_healthy" }); return; }
    const cost = healCost(ctx.p, want, ctx.spouse);
    if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold }); return; }
    await savePlayer(ctx, { hp: ctx.p.hp + want, gold: ctx.p.gold - cost });
    ctx.events.push({ kind: "healed", hp: want, cost });
    await logEvent(ctx, "spend", { on: "healer", gold: cost, hp: want });
  }));
});

api.post("/buy", async (c) => {
  const body = z.object({ kind: z.enum(["weapon", "armor", "bag"]), id: z.number().int(), keep_old: z.boolean().optional(), confirm: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const shopTown = requireTown(ctx, "the shop", ALL_TOWNS);
    await requireNoEncounter(ctx);
    // Gold changes hands only on a confirmed call: without confirm this returns a quote and does nothing.
    // Plugins from before buy quotes (0.15.1) and townsfolk go straight through, trading in as before.
    const plugin = current()?.plugin;
    const confirmed = body.confirm === true || ctx.p.is_bot || (plugin !== undefined && plugin !== null && older(plugin, "0.15.1"));
    const charm = charmDiscount(charmOf(ctx.p));
    const friend = await friendCut(ctx, soldBy(ctx, body.kind).keeper);
    const discount = Math.min(0.4, charm + friend.cut);
    const pct = { ...(charm ? { charm_discount_pct: Math.round(charm * 100) } : {}), ...(friend.cut ? { friend_discount_pct: Math.round(friend.cut * 100), keeper_feels: friend.feels } : {}) };
    if (body.kind === "bag") {
      const nb = Bag.bag(body.id);
      if (nb.id !== body.id) throw new GameError("no_such_item", "no such bag");
      if (nb.id <= ctx.p.bag_id) { ctx.events.push({ kind: "already_have_bigger", bag: Bag.bag(ctx.p.bag_id).name }); return; }
      const bagCost = Math.ceil(nb.cost * (1 - discount));
      if (!confirmed) {
        ctx.events.push({ kind: "buy_quote", shop: "bag", sold_by: soldBy(ctx, "bag"), item: nb.name, capacity: nb.capacity, cost: bagCost, gold: ctx.p.gold, bank: ctx.p.bank, ...(ctx.p.gold < bagCost ? { short_by: bagCost - ctx.p.gold } : {}), ...pct });
        ctx.hint = "Say what it costs, then ask Confirm? (Y)es / (N)o. Only on a yes call buy again with confirm: true. If they're short, say so; never take gold from the bank unless they ask.";
        return;
      }
      if (ctx.p.gold < bagCost) { ctx.events.push({ kind: "too_poor", cost: bagCost, gold: ctx.p.gold }); return; }
      await savePlayer(ctx, { gold: ctx.p.gold - bagCost, bag_id: nb.id });
      ctx.events.push({ kind: "bought", shop: "bag", item: nb.name, cost: bagCost, capacity: nb.capacity });
      await logEvent(ctx, "spend", { on: "bag", item: nb.name, gold: bagCost });
      return;
    }
    if (body.kind === "weapon" && casts(ctx.p.class)) { ctx.events.push({ kind: "not_for_you", reason: `the smith doesn't sell ${ctx.p.class === "bard" ? "instruments" : "spells"}; ${myVendor(ctx).name} does, at the ${myVendor(ctx).place}`, go: myVendor(ctx).place }); return; }
    const item = body.kind === "weapon" ? weapon(body.id) : armor(body.id);
    if (item.id !== body.id) throw new GameError("no_such_item", "no such item");
    const current_ = body.kind === "weapon" ? weapon(ctx.p.weapon_id) : armor(ctx.p.armor_id);
    const curRar = body.kind === "weapon" ? ctx.p.weapon_rarity ?? 0 : ctx.p.armor_rarity ?? 0;
    const old = Bag.item(body.kind, carriedId(body.kind, ctx.p.class, current_.id), curRar);
    const itemLabel = itemName(body.kind, item.id, ctx.p.class);
    const hasOld = current_.id > 0;
    const tradeIn = hasOld ? Math.floor(old.cost / 2) : 0;
    const costTrading = Math.ceil((item.cost - tradeIn) * (1 - discount));
    const costKeeping = Math.ceil(item.cost * (1 - discount));
    // Keeping the old piece means carrying it: it goes into the bag, so it has to fit.
    const room = Bag.bag(ctx.p.bag_id).capacity - await Bag.used(ctx.c, ctx.p.id);
    const canKeep = hasOld && old.weight <= room;
    const stat = (x: { str?: number; def?: number }) => body.kind === "weapon" ? { power: x.str ?? 0 } : { defense: x.def ?? 0 };
    if (!confirmed) {
      ctx.events.push({
        kind: "buy_quote", shop: body.kind, sold_by: soldBy(ctx, body.kind), item: itemLabel, ...stat(item), gold: ctx.p.gold, bank: ctx.p.bank, ...pct,
        ...(hasOld ? {
          old: { item: old.name, ...stat(current_) },
          trade_in: { value: tradeIn, cost: costTrading, ...(ctx.p.gold < costTrading ? { short_by: costTrading - ctx.p.gold } : {}) },
          keep: canKeep
            ? { cost: costKeeping, weight: old.weight, sells_to_smith_for: Bag.sellPrice(body.kind, current_.id, curRar), ...(ctx.p.gold < costKeeping ? { short_by: costKeeping - ctx.p.gold } : {}) }
            : { possible: false, why: `no room in the bag (it weighs ${old.weight}, ${Math.max(0, room)} free)` },
        } : { cost: costTrading, ...(ctx.p.gold < costTrading ? { short_by: costTrading - ctx.p.gold } : {}) }),
      });
      ctx.hint = hasOld
        ? "Show the price both ways: trade the old piece in (cheaper) or keep it in the bag to sell or auction (full price). Ask which, e.g. (T)rade in / (K)eep it / (N)o. Then call buy again with confirm: true, and keep_old: true if they chose to keep it. If they're short, say so; never take gold from the bank unless they ask."
        : "Say what it costs, then ask Confirm? (Y)es / (N)o. Only on a yes call buy again with confirm: true. If they're short, say so; never take gold from the bank unless they ask.";
      return;
    }
    const keep = body.keep_old === true && hasOld;
    if (keep && !canKeep) { ctx.events.push({ kind: "bag_full", need: old.weight - Math.max(0, room), holding: old.name }); return; }
    const cost = keep ? costKeeping : costTrading;
    if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold, trade_in: keep ? 0 : tradeIn }); return; }
    await savePlayer(ctx, { gold: ctx.p.gold - cost, ...(body.kind === "weapon" ? { weapon_id: item.id, weapon_rarity: 0 } : { armor_id: item.id, armor_rarity: 0 }) });
    const oldCarried = carriedId(body.kind, ctx.p.class, current_.id);
    if (keep) await ctx.c.query("insert into inventory (player_id, slot, item_id, rarity) values ($1,$2,$3,$4)", [ctx.p.id, body.kind, oldCarried, curRar]);
    else if (hasOld && !ctx.p.is_test) await toStorehouse(ctx.c, [{ slot: body.kind, item_id: oldCarried, rarity: curRar }]);
    ctx.events.push({ kind: "bought", shop: body.kind, item: itemLabel, cost, ...(keep ? { kept: old.name } : { trade_in: tradeIn }), ...pct });
    await logEvent(ctx, "spend", { on: body.kind, item: itemLabel, tier: item.id, gold: cost });
  }));
});

api.post("/bank", async (c) => {
  const body = z.object({ op: z.enum(["deposit", "withdraw"]), amount: z.union([z.literal("all"), z.number().int().positive()]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    requireTown(ctx, "the bank", ALL_TOWNS);
    await requireNoEncounter(ctx);
    if (ctx.t.bank_tx >= GAME.bankTxPerDay) { ctx.events.push({ kind: "bank_closed", reason: "daily transaction limit" }); return; }
    const from = body.op === "deposit" ? ctx.p.gold : ctx.p.bank;
    const amt = body.amount === "all" ? from : Math.min(from, body.amount);
    if (amt <= 0) { ctx.events.push({ kind: "nothing_to_move" }); return; }
    const patch = body.op === "deposit" ? { gold: ctx.p.gold - amt, bank: ctx.p.bank + amt } : { gold: ctx.p.gold + amt, bank: ctx.p.bank - amt };
    await savePlayer(ctx, patch);
    await saveTurns(ctx, { bank_tx: ctx.t.bank_tx + 1 });
    ctx.events.push({ kind: "bank_tx", op: body.op, amount: amt, gold: ctx.p.gold, bank: ctx.p.bank });
  }));
});

api.post("/inn", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
    const innTown = requireTown(ctx, "a bed for the night", ALL_TOWNS);
  await requireNoEncounter(ctx);
  if (ctx.t.inn_used) { ctx.events.push({ kind: "already_at_inn" }); return; }
  const cost = innCost(ctx.p, ctx.spouse);
  if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold }); return; }
  await savePlayer(ctx, { gold: ctx.p.gold - cost, location: "inn" });
  await saveTurns(ctx, { inn_used: true });
  ctx.events.push({ kind: "inn_sleep", cost, ...(innTown !== "brightwater" ? { where: TOWN_INFO[innTown]!.inn, wake_here: true } : {}) });
  await logEvent(ctx, "spend", { on: "inn", gold: cost });
  ctx.hint = "They are safe from other players until the realm resets, and will wake fully healed.";
})));

// ---------- town meetings ----------

/** Cast a vote in a town meeting: once, from level 2, while standing in that town (a realm-wide meeting, in any town). */
api.post("/vote", async (c) => {
  const body = z.object({ poll: z.number().int(), choice: z.string().trim().min(1).max(40) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const here = requireTown(ctx, "the town meeting", ALL_TOWNS);
    const p = (await openPolls(ctx.c, ctx.day, here)).find((x) => x.id === body.poll);
    if (!p) { ctx.events.push({ kind: "no_such_meeting", note: "there's no meeting on that here, or it has closed" }); return; }
    if (ctx.p.is_test || ctx.p.role !== "player") { ctx.events.push({ kind: "not_for_you", reason: "only the realm's adventurers vote" }); return; }
    if (ctx.p.level < VOTE_MIN_LEVEL) { ctx.events.push({ kind: "too_new", what: "vote", needed_level: VOTE_MIN_LEVEL }); return; }
    const o = p.options.find((x) => x.id === body.choice || x.label.toLowerCase() === body.choice.toLowerCase());
    if (!o) { ctx.events.push({ kind: "no_such_choice", choices: p.options.map((x) => ({ id: x.id, label: x.label })) }); return; }
    const r = await ctx.c.query("insert into poll_votes (poll_id, player_id, choice, townsfolk, day) values ($1,$2,$3,false,$4) on conflict do nothing returning 1", [p.id, ctx.p.id, o.id, ctx.day]);
    if (!r.rowCount) { const was = (await ctx.c.query<{ choice: string }>("select choice from poll_votes where poll_id = $1 and player_id = $2", [p.id, ctx.p.id])).rows[0]; ctx.events.push({ kind: "already_voted", your_vote: p.options.find((x) => x.id === was?.choice)?.label ?? was?.choice }); return; }
    ctx.events.push({ kind: "voted", question: p.question, choice: o.label, last_day: p.closes });
    await logEvent(ctx, "vote", { poll: p.id });
  }));
});

/** Town meetings for the website: open ones (question, choices, how many have voted) and settled ones with their results. */
api.get("/public/polls", async (c) => {
  const out = await tx(async (db) => {
    const rows = (await db.query<Poll & { voters: string; art: string | null; interviews: Record<string, { name: string; said: string }> }>(
      `select p.id::int, p.town, p.question, p.about, p.options, p.opens::text, p.closes::text, p.status, p.result, p.art, p.interviews,
              (select count(*) from poll_votes v where v.poll_id = p.id and not v.townsfolk)::text as voters
       from polls p order by p.status = 'open' desc, p.closes desc limit 30`)).rows;
    // Who could vote: adventurers from level 2 (anywhere; they can walk to the meeting), and the townsfolk of that town.
    const canVote = Number((await db.query<{ n: string }>("select count(*)::text n from players where role = 'player' and not is_test and level >= $1", [VOTE_MIN_LEVEL])).rows[0].n);
    const folkIn = (await db.query<{ home: string; n: string }>("select b.home, count(*)::text n from bots b join players p on p.id = b.player_id group by b.home")).rows;
    const folkFor = (town: string | null) => folkIn.filter((f) => !town || f.home === town).reduce((a, f) => a + Number(f.n), 0);
    const counts = (await db.query<{ poll_id: string; choice: string; townsfolk: boolean; n: string }>("select poll_id::text, choice, townsfolk, count(*)::text n from poll_votes group by 1, 2, 3")).rows;
    const folkVoted = (await db.query<{ poll_id: string; n: string }>("select poll_id::text, count(*)::text n from poll_votes where townsfolk group by poll_id")).rows;
    const said = (await db.query<{ poll_id: string; name: string; why: string }>(
      "select v.poll_id::text, pl.name, v.why from poll_votes v join players pl on pl.id = v.player_id where v.townsfolk and v.why is not null order by v.day, pl.name")).rows;
    return rows.map((p) => ({
      id: p.id, town: p.town, question: p.question, about: p.about, ...(p.art ? { art: p.art } : {}), options: p.options.map((o) => ({ id: o.id, label: o.label })), opens: p.opens, last_day: p.closes,
      status: p.status, voters: Number(p.voters), can_vote: canVote,
      // Running count, shown live like an election night: adventurers decide, townsfolk break a tie.
      tally: p.status === "closed" && p.result ? p.result : tally(p, counts.filter((v) => Number(v.poll_id) === p.id).flatMap((v) => Array(Number(v.n)).fill({ choice: v.choice, townsfolk: v.townsfolk }))),
      townsfolk_voted: Number(folkVoted.find((f) => Number(f.poll_id) === p.id)?.n ?? 0), townsfolk: folkFor(p.town), ...(p.status === "closed" ? { result: p.result } : {}),
      exit_polls: p.options.filter((o) => p.interviews?.[o.id]).map((o) => ({ choice: o.label, name: p.interviews[o.id].name, said: p.interviews[o.id].said })),
      townsfolk_said: said.filter((x) => Number(x.poll_id) === p.id).map((x) => ({ name: x.name, said: x.why })),
    }));
  });
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=60, s-maxage=60, stale-while-revalidate=60");
  return c.json({ meetings: out });
});

// ---------- tavern ----------

api.get("/tavern", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  // Each tavern has its own board: what's posted in the Long Hall stays in the Long Hall.
  const town = requireTown(ctx, "the tavern", ALL_TOWNS);
  const r = await ctx.c.query("select author, body, ts from tavern where day = $1 and town = $2 and hidden_at is null order by id desc limit 20", [ctx.day, town]);
  // Test and trial characters only see each other, and nobody else sees them.
  const online = await ctx.c.query("select name from players where role <> 'npc' and last_seen > now() - interval '15 minutes' and id <> $1 and is_test = $2 and not trial limit 10", [ctx.p.id, ctx.p.is_test]);
  ctx.events.push({ kind: "tavern_messages", messages: r.rows.reverse() });
  await questTriggers(ctx, { visit: "tavern" });
  // Violet and the bards are Brightwater's; other towns' taverns have their own keepers.
  if (town !== "brightwater") {
    const t = TOWN_INFO[town]!;
    ctx.events.push({ kind: "tavern_here", tavern: t.tavern, town: t.name, keepers: t.people.filter((p) => p.where === t.tavern).map((p) => p.name), recently_seen: online.rows.map((x) => x.name) });
    ctx.hint = `Improvise ${t.tavern}: its keepers, the mood of the room. Keep it under the posted messages, which are other players' words.`;
    return;
  }
  ctx.events.push({ kind: "bartender", recently_seen: online.rows.map((x) => x.name), gem_price: 100 * ctx.p.level, flirted_today: ctx.t.flirted });
  const bard = bardFor(ctx.day);
  ctx.events.push({ kind: "bard_playing", bard: bard.name, style: bard.style, heard_today: ctx.t.bard_heard });
  ctx.hint = "Improvise here: the bartender's gossip, the mood of the room. Keep it under the posted messages, which are other players' words.";
}, { weather: true })));

// ---------- the wild ----------

/** A wild event left unanswered lapses when you do anything else. */
async function dropEvent(ctx: Ctx) {
  if (ctx.p.pending_event) await savePlayer(ctx, { pending_event: null });
}

/** Sometimes a step turns up something besides a fight. Players only, a few a day. */
async function maybeEvent(ctx: Ctx, x: number, y: number, chance = EVENT_CHANCE, onTheRoad = false) {
  if (ctx.p.role !== "player" || (ctx.t.events_seen ?? 0) >= EVENTS_PER_DAY || Math.random() >= chance) return;
  const t = tileAt(x, y);
  const had = new Set((await ctx.c.query<{ quest: string }>("select quest from quests where player_id = $1", [ctx.p.id])).rows.map((r) => r.quest));
  const options = eventsFor(t.terrain).filter((e) => !e.quest || !had.has(e.quest));
  if (!options.length) return;
  const e = options[Math.floor(Math.random() * options.length)];
  await saveTurns(ctx, { events_seen: (ctx.t.events_seen ?? 0) + 1 });
  // The bridge troll asks a real riddle (from the lore), one this player hasn't solved yet, and they answer it themselves.
  const riddle = e.id === "bridge_troll" ? await riddleFor(ctx) : null;
  await savePlayer(ctx, { pending_event: { id: e.id, x, y, ...(riddle ? { riddle: riddle.key } : {}) } });
  ctx.events.push({ kind: "wild_event", event: e.id, place: t.name, terrain: t.terrain, description: e.description, ...(onTheRoad ? { on_the_road: true } : {}),
    ...(riddle ? { riddle: riddle.text, ...(riddle.realm ? { about_the_realm: true } : {}) } : {}),
    choices: e.choices.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, ...(c.cost ? { costs_gold: c.cost * t.level } : {}), ...(riddle && c.id === "answer" ? { needs: "their own answer" } : {}) })) });
  ctx.hint = "Something besides a fight. Describe it in two or three sentences from `description`, then offer its choices numbered (1), (2)… with their labels (and any gold cost), plus the usual Wild menu below. Call `event` with the choice id only when they pick one; anything else they do walks away from it."
    + (riddle ? " The troll asks his riddle: quote `riddle` word for word, in his voice, before the choices. If they pick Answer the riddle and haven't said an answer yet, ask what their answer is and wait. Then call `event` with choice 'answer' and `answer` set to exactly what they typed. Never answer it for them, hint at it, or say whether they're right before the server does." : "");
}

/** A riddle for the bridge troll: one this player hasn't solved, from the lore. None if the lore has none. */
async function riddleFor(ctx: Ctx) {
  const all = (await loadLore()).riddles;
  if (!all.length) return null;
  const solved = new Set((await ctx.c.query<{ key: string }>("select key from player_lore where player_id = $1 and key like 'riddle:%'", [ctx.p.id])).rows.map((r) => r.key));
  return pickRiddle(all, solved);
}

/** Now and then an old journal, a letter or a page turns up: one every few days at most, each found once. The words come from the lore. */
async function maybeJournal(ctx: Ctx, where: "wild" | "cave" | "town" | "ironhold" | "ashford", ring = 0) {
  if (ctx.p.role !== "player") return;
  if (Math.random() >= JOURNAL_CHANCE[where] * JOURNAL_CHANCE.scale) return;
  const pool = lore().journals.filter((j) => j.where === where && j.min_ring <= ring);
  if (!pool.length) return;
  const mine = (await ctx.c.query<{ key: string; day: string }>("select key, day::text from player_lore where player_id = $1 and key like 'journal:%'", [ctx.p.id])).rows;
  // One every few days at most: the last find has to be at least JOURNAL_EVERY_DAYS old.
  const last = mine.reduce((d, r) => (r.day > d ? r.day : d), "");
  if (last && (Date.parse(ctx.day) - Date.parse(last)) / 86_400_000 < JOURNAL_EVERY_DAYS) return;
  const have = new Set(mine.map((r) => r.key));
  const left = pool.filter((j) => !have.has(j.key)).sort((a, z) => a.min_ring - z.min_ring || Math.random() - 0.5);
  const j = left[0];
  if (!j) return;
  await ctx.c.query("insert into player_lore (player_id, key, day, how) values ($1, $2, $3, $4) on conflict do nothing", [ctx.p.id, j.key, ctx.day, where]);
  ctx.events.push({ kind: "journal_found", title: j.title, author: j.author, text: j.text, where });
  await logEvent(ctx, "journal", { key: j.key, where });
}

/** Whatever's lying on the ground stays where it is when you walk off. */
async function leaveGround(ctx: Ctx) {
  if (!ctx.p.ground) return;
  ctx.events.push({ kind: "left_behind", item: Bag.item(ctx.p.ground.slot, ctx.p.ground.item_id).name });
  await savePlayer(ctx, { ground: null });
}

async function exploredSet(ctx: Ctx): Promise<Set<string>> {
  const r = await ctx.c.query<{ x: number; y: number }>("select x, y from explored where player_id = $1", [ctx.p.id]);
  return new Set(r.rows.map((t) => `${t.x},${t.y}`));
}

function describeTile(x: number, y: number, explored: Set<string>) {
  if (x === 0 && y === 0) return { x, y, name: "Brightwater", terrain: "town", level: 0, poi: null, explored: true };
  const t = tileAt(x, y);
  return explored.has(`${x},${y}`) ? { x, y, name: t.name, terrain: t.terrain, level: t.level, poi: t.poi, explored: true } : { x, y, explored: false };
}

/** Anyone else standing on this tile: townsfolk out walking or camped, and other players. */
async function othersHere(ctx: Ctx, x: number, y: number) {
  const r = await ctx.c.query<{ name: string; class: string; level: number; townsfolk: boolean; personality: Personality | null; mind: Mind | null }>(
    `select p.name, p.class, p.level, p.role = 'townsfolk' as townsfolk, b.personality, b.mind
     from players p left join bots b on b.player_id = p.id
     where p.pos_x = $1 and p.pos_y = $2 and p.id <> $3 and p.alive and p.role <> 'npc' and (p.role = 'townsfolk' or (p.is_test = $4 and not p.trial)) limit 4`, [x, y, ctx.p.id, ctx.p.is_test]);
  return r.rows.map((o) => ({ name: o.name, class: o.class, level: o.level, townsfolk: o.townsfolk,
    ...(o.personality && o.mind?.goal ? { on_mind: goalLabel(o.name, o.personality, o.mind.goal) } : {}) }));
}

/** Places they've heard of but not yet been: drawn on the map, but they still have to walk there. */
async function heardSet(ctx: Ctx): Promise<Map<string, string | null>> {
  const r = await ctx.c.query<{ x: number; y: number; heard_from: string | null }>("select x, y, heard_from from rumors where player_id = $1", [ctx.p.id]);
  return new Map(r.rows.map((t) => [`${t.x},${t.y}`, t.heard_from]));
}

/** "3 east and 1 north of town". */
export function directions(x: number, y: number): string {
  const parts = [x ? `${Math.abs(x)} ${x > 0 ? "east" : "west"}` : "", y ? `${Math.abs(y)} ${y > 0 ? "south" : "north"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} of town` : "town";
}

/** Mark a place on their map as heard of. Returns false if they already knew it. */
async function hearOf(ctx: Ctx, x: number, y: number, from: string): Promise<boolean> {
  if (x === 0 && y === 0) return false;
  const known = await ctx.c.query("select 1 from explored where player_id = $1 and x = $2 and y = $3", [ctx.p.id, x, y]);
  if (known.rowCount) return false;
  const r = await ctx.c.query("insert into rumors (player_id, x, y, heard_from) values ($1,$2,$3,$4) on conflict do nothing returning 1", [ctx.p.id, x, y, from]);
  return Boolean(r.rowCount);
}

/** The map around you, where each way leads, and the places you know or have heard of. */
api.get("/map", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const ex = await exploredSet(ctx);
  const heard = await heardSet(ctx);
  const seen = new Set([...ex, ...heard.keys()]);
  const [x, y] = inWild(ctx.p) ? [ctx.p.pos_x!, ctx.p.pos_y!] : [0, 0];
  const ways = Object.fromEntries((Object.keys(DIRS) as Dir[]).map((d) => {
    const t = describeTile(x + DIRS[d][0], y + DIRS[d][1], seen);
    const k = `${x + DIRS[d][0]},${y + DIRS[d][1]}`;
    return [d, heard.has(k) && !ex.has(k) ? { ...t, heard_of: true } : t];
  }));
  const known = await ctx.c.query<{ x: number; y: number }>(
    "select e.x, e.y from explored e where e.player_id = $1 order by abs(e.x) + abs(e.y), e.at limit 40", [ctx.p.id]);
  const places = known.rows.map((t) => { const k = tileAt(t.x, t.y); return { x: t.x, y: t.y, name: k.name, terrain: k.terrain, level: k.level, poi: k.poi }; });
  const heardOf = [...heard.entries()].filter(([k]) => !ex.has(k)).slice(0, 12).map(([k, from]) => {
    const [hx, hy] = k.split(",").map(Number);
    const t = tileAt(hx, hy);
    return { x: hx, y: hy, name: t.name, terrain: t.terrain, poi: t.poi, where: directions(hx, hy), heard_from: from };
  });
  // Everything they've walked, for a picture of the whole known world (the side pane draws it): rows of the ASCII
  // map's symbols over the box they've explored (a space where they haven't been), plus the names of its towns,
  // caves and shrine and of the places they've only heard of.
  const chart = chartOf(ex, [x, y], heardOf.map((h) => [h.x, h.y, h.name] as [number, number, string]));
  ctx.events.push({ kind: "map", here: describeTile(x, y, new Set([...seen, `${x},${y}`])), ways, map: renderMap(x, y, seen), legend: LEGEND, known_places: places, heard_of: heardOf, chart });
})));

/** The widest and tallest the known-world chart gets, in tiles, around where you stand. */
const CHART_MAX = 61;

function chartOf(ex: Set<string>, you: [number, number], heard: [number, number, string][]) {
  const pts = [...ex].map((k) => k.split(",").map(Number) as [number, number]);
  pts.push([0, 0], you);
  const half = (CHART_MAX - 1) / 2;
  const within = pts.filter(([px, py]) => Math.abs(px - you[0]) <= half && Math.abs(py - you[1]) <= half);
  const x0 = Math.min(...within.map((p) => p[0])), x1 = Math.max(...within.map((p) => p[0]));
  const y0 = Math.min(...within.map((p) => p[1])), y1 = Math.max(...within.map((p) => p[1]));
  const names: [number, number, string][] = [];
  const rows: string[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    let row = "";
    for (let tx = x0; tx <= x1; tx++) {
      if (!(tx === 0 && ty === 0) && !ex.has(`${tx},${ty}`)) { row += " "; continue; }
      const t = tileAt(tx, ty);
      const sym = tx === 0 && ty === 0 ? SYMBOL.town : t.poi === "cave" ? SYMBOL.cave : t.poi === "shrine" ? SYMBOL.shrine : SYMBOL[t.terrain];
      if (sym === SYMBOL.town || sym === SYMBOL.cave || sym === SYMBOL.shrine) names.push([tx, ty, tx === 0 && ty === 0 ? "Brightwater" : t.name]);
      row += sym;
    }
    rows.push(row.trimEnd());
  }
  return { origin: [x0, y0], you, rows, names, heard: heard.filter(([hx, hy]) => hx >= x0 - 8 && hx <= x1 + 8 && hy >= y0 - 8 && hy <= y1 + 8) };
}

/** One step north, south, east or west. A step into the wild costs a fight; walking into town is free. */
api.post("/move", async (c) => {
  const body = z.object({ dir: z.enum(["north", "south", "east", "west"]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    await dropEvent(ctx);
    const [x0, y0] = inWild(ctx.p) ? [ctx.p.pos_x!, ctx.p.pos_y!] : [0, 0];
    const [x, y] = [x0 + DIRS[body.dir][0], y0 + DIRS[body.dir][1]];
    if (x === 0 && y === 0) {
      // Someone from another town walking into Brightwater for the first time meets whatever holds its road.
      if (!ctx.p.is_bot && !(await passedGate(ctx, 0, 0))) {
        if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left", why: "too tired to go further today" }); return; }
        await saveTurns(ctx, { forest_fights: ctx.t.forest_fights - 1 });
        await startGateFight(ctx, "brightwater");
        return;
      }
      await leaveGround(ctx);
      await savePlayer(ctx, { pos_x: null, pos_y: null, cave_depth: null });
      ctx.events.push({ kind: "arrived", place: "town" });
      return;
    }
    if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left", why: "too tired to go further today" }); return; }
    await leaveInn(ctx);
    if (ctx.p.ground) {
      ctx.events.push({ kind: "left_behind", item: Bag.item(ctx.p.ground.slot, ctx.p.ground.item_id).name });
      await savePlayer(ctx, { ground: null });
    }
    await saveTurns(ctx, { forest_fights: ctx.t.forest_fights - 1 });
    // The first time anyone walks up to a town out in the world, something on the road stops them. No way round it.
    const gateTown = townAt(x, y);
    if (gateTown && gateTown !== "brightwater" && !ctx.p.is_bot && !(await passedGate(ctx, x, y))) {
      await startGateFight(ctx, gateTown);
      return;
    }
    await savePlayer(ctx, { pos_x: x, pos_y: y, cave_depth: null });
    const t = tileAt(x, y);
    const mine = await ctx.c.query("insert into explored (player_id, x, y) values ($1,$2,$3) on conflict do nothing returning 1", [ctx.p.id, x, y]);
    const firstForYou = Boolean(mine.rowCount);
    const anyone = ctx.p.is_test ? { rowCount: 0 } : await ctx.c.query(
      "insert into discoveries (x, y, name, terrain, poi, found_by) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning 1",
      [x, y, t.name, t.terrain, t.poi, ctx.p.id]);
    const firstEver = Boolean(anyone.rowCount);
    if (firstEver && t.poi) await post(ctx, "discovery", ctx.p.name, null, { place: t.name, poi: t.poi });
    // New ground is worth the turn it took: a share of a fight's experience, at the tile's level (never above yours).
    const groundExp = firstForYou && t.poi !== "town" ? Math.round(NEW_GROUND * fightExp(Math.min(t.level, ctx.p.level))) : 0;
    if (groundExp) await savePlayer(ctx, { exp: ctx.p.exp + groundExp });
    if (firstForYou) await logEvent(ctx, "explore", { x, y, ring: t.ring, terrain: t.terrain, level: t.level, poi: t.poi, first_ever: firstEver, ...(groundExp ? { exp: groundExp } : {}) });
    const others = await othersHere(ctx, x, y);
    ctx.events.push({ kind: "arrived", place: t.name, terrain: t.terrain, level: t.level, ring: t.ring, poi: t.poi, first_for_you: firstForYou, first_ever: firstEver, ...(groundExp ? { new_ground_exp: groundExp } : {}),
      ...(others.length ? { others_here: others } : {}),
      ...(firstEver ? {} : { found_by: (await ctx.c.query<{ name: string }>("select p.name from discoveries d left join players p on p.id = d.found_by where d.x = $1 and d.y = $2", [x, y])).rows[0]?.name ?? null }) });
    await questTriggers(ctx, { arrive: { x, y } });
    if (t.poi === "town") { await arriveInTown(ctx, t); return; }
    if (t.poi === "shrine") await atShrine(ctx, t);
    if (!ctx.events.some((e) => e.kind === "quest")) await maybeEvent(ctx, x, y);
    if (!ctx.events.some((e) => e.kind === "quest" || e.kind === "wild_event")) await maybeJournal(ctx, "wild", t.ring);
    if (!t.poi) await maybeSpotHerb(ctx);
  }));
});

/** Walk home, or back out to somewhere you've already been. You know the way, so it's free. */
api.post("/travel", async (c) => {
  const body = z.union([z.object({ to: z.literal("town") }), z.object({ x: z.number().int(), y: z.number().int() })]).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    await dropEvent(ctx);
    // "town" means home: where they started. Brightwater by its tile works too, once they've been.
    const goHome = "to" in body;
    const toBrightwater = goHome ? (ctx.p.start_town ?? "brightwater") === "brightwater" : body.x === 0 && body.y === 0;
    if (toBrightwater) {
      if (!ctx.p.is_bot && !(await passedGate(ctx, 0, 0))) { ctx.events.push({ kind: "unknown_place", x: 0, y: 0, why: "you've never been to Brightwater; walk there the first time" }); return; }
      await leaveGround(ctx);
      await savePlayer(ctx, { pos_x: null, pos_y: null, cave_depth: null });
      ctx.events.push({ kind: "arrived", place: "town" });
      return;
    }
    if (goHome) {
      const h = homeTile(ctx.p);
      await leaveGround(ctx);
      await savePlayer(ctx, { pos_x: h.x, pos_y: h.y, cave_depth: null });
      const t = tileAt(h.x, h.y);
      ctx.events.push({ kind: "arrived", place: t.name, terrain: t.terrain, level: t.level, ring: t.ring, poi: t.poi, first_for_you: false, by_known_paths: true });
      await arriveInTown(ctx, t);
      return;
    }
    const known = await ctx.c.query("select 1 from explored where player_id = $1 and x = $2 and y = $3", [ctx.p.id, body.x, body.y]);
    if (!known.rowCount) {
      const heard = await ctx.c.query("select 1 from rumors where player_id = $1 and x = $2 and y = $3", [ctx.p.id, body.x, body.y]);
      ctx.events.push({ kind: "unknown_place", x: body.x, y: body.y, ...(heard.rowCount ? { heard_of: true, why: "you've only heard of it; walk there the first time" } : {}) });
      return;
    }
    await leaveInn(ctx);
    await leaveGround(ctx);
    // The road between: the farther you go over known land, the likelier something turns up on the way.
    const [fx, fy] = inWild(ctx.p) ? [ctx.p.pos_x!, ctx.p.pos_y!] : [0, 0];
    const distance = Math.abs(body.x - fx) + Math.abs(body.y - fy);
    await savePlayer(ctx, { pos_x: body.x, pos_y: body.y, cave_depth: null });
    const t = tileAt(body.x, body.y);
    const others = await othersHere(ctx, body.x, body.y);
    ctx.events.push({ kind: "arrived", place: t.name, terrain: t.terrain, level: t.level, ring: t.ring, poi: t.poi, first_for_you: false, by_known_paths: true, distance, ...(others.length ? { others_here: others } : {}) });
    await questTriggers(ctx, { arrive: { x: body.x, y: body.y } });
    if (t.poi === "town") { await arriveInTown(ctx, t); return; }
    if (t.poi === "shrine") await atShrine(ctx, t);
    if (!ctx.events.some((e) => e.kind === "quest")) await maybeEvent(ctx, body.x, body.y, Math.min(ROAD_EVENT_MAX, ROAD_EVENT_PER_STEP * distance), true);
  }));
});

// ---------- side quests ----------

interface QRow { id: string; quest: string; step: string; data: { target?: { x: number; y: number }; pending?: boolean; wins?: number }; started_day: string; step_day: string; deadline: string }

async function activeQuests(ctx: Ctx): Promise<QRow[]> {
  return (await ctx.c.query<QRow>(
    "select id::text, quest, step, data, started_day::text, step_day::text, deadline::text from quests where player_id = $1 and status = 'active' order by id", [ctx.p.id])).rows;
}
const areaOf = (t: { x: number; y: number }) => `near ${tileAt(t.x, t.y).name}, ${directions(t.x, t.y)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function knowLine(q: QuestDef, row: QRow): string {
  const st = stepOf(q, row.step);
  return (st?.know ?? "").replace("{area}", row.data.target ? areaOf(row.data.target) : "somewhere out there");
}

/** The journal, for the status: what they're in the middle of and how long it has. */
async function questJournal(ctx: Ctx) {
  return (await activeQuests(ctx)).map((r) => {
    const q = questById(r.quest)!;
    return { title: q.title, know: knowLine(q, r), days_left: Math.max(0, daysBetween(ctx.day, r.deadline)), ...(r.data.pending ? { waiting_on_you: true } : {}) };
  });
}

async function questItem(ctx: Ctx, q: QuestDef, give: boolean) {
  const idx = questIndex(q.id);
  if (give) await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,'quest',$2)", [ctx.p.id, idx]);
  else await ctx.c.query("delete from inventory where id in (select id from inventory where player_id = $1 and slot = 'quest' and item_id = $2 limit 1)", [ctx.p.id, idx]);
}

/** Begin a quest unless they've had it before. Found-item quests start with the item in the bag. */
async function startQuest(ctx: Ctx, id: string, withItem: boolean): Promise<boolean> {
  const q = questById(id);
  if (!q || ctx.p.role !== "player") return false;
  const had = await ctx.c.query("select 1 from quests where player_id = $1 and quest = $2", [ctx.p.id, id]);
  if (had.rowCount) return false;
  const deadline = new Date(ctx.day + "T00:00:00Z"); deadline.setUTCDate(deadline.getUTCDate() + q.days);
  const r = await ctx.c.query<QRow>(
    "insert into quests (player_id, quest, step, started_day, step_day, deadline) values ($1,$2,$3,$4,$4,$5) returning id::text, quest, step, data, started_day::text, step_day::text, deadline::text",
    [ctx.p.id, id, q.steps[0].id, ctx.day, deadline.toISOString().slice(0, 10)]);
  if (withItem && q.item) await questItem(ctx, q, true);
  await logEvent(ctx, "quest", { quest: id, step: "start" });
  const first = q.steps[0];
  if (!first.on) await fireStep(ctx, q, r.rows[0], first);
  else ctx.events.push({ kind: "quest_started", quest: q.id, title: q.title, know: knowLine(q, r.rows[0]), ...(withItem && q.item ? { item: q.item.name } : {}) });
  return true;
}

async function endQuest(ctx: Ctx, q: QuestDef, row: QRow, outcome: string, status = "done") {
  await ctx.c.query("update quests set status = $2, outcome = $3, ended_at = now() where id = $1", [row.id, status, outcome]);
  ctx.events.push({ kind: "quest_done", quest: q.id, title: q.title, outcome });
  await logEvent(ctx, "quest", { quest: q.id, outcome });
}

async function moveTo(ctx: Ctx, q: QuestDef, row: QRow, to?: string, end?: string) {
  if (end) return endQuest(ctx, q, row, end);
  if (!to) return;
  row.step = to; row.step_day = ctx.day; row.data.pending = false;
  await ctx.c.query("update quests set step = $2, step_day = $3, data = $4 where id = $1", [row.id, to, ctx.day, JSON.stringify(row.data)]);
  if (to !== stepOf(q, to)?.id) return;
  // A song step with no song to be had today goes straight on, without a word.
  const next = stepOf(q, to)!;
  if (next.skip_if_heard && ctx.t.bard_heard) return moveTo(ctx, q, row, next.then, next.end);
  ctx.events.push({ kind: "quest_progress", quest: q.id, title: q.title, know: knowLine(q, row) });
}

/** Quest effects plus the ones only quests have (the item, a target spot). */
async function questEffects(ctx: Ctx, q: QuestDef, row: QRow, effects: QEffect[]) {
  const plain: (Effect | QEffect)[] = [];
  const gear: string[] = [];
  for (const fx of effects) {
    if ("give_item" in fx) await questItem(ctx, q, true);
    else if ("take_item" in fx) await questItem(ctx, q, false);
    else if ("place_target" in fx) {
      const ex = await exploredSet(ctx);
      const far = Math.max(1, ...[...ex].map((k) => { const [a, b] = k.split(",").map(Number); return Math.max(Math.abs(a), Math.abs(b)); }));
      const ring = Math.max(1, far + fx.place_target.near + Math.floor(Math.random() * (fx.place_target.far - fx.place_target.near + 1)));
      // A spot on that ring, not in town and not too dangerous for them.
      // A quest can ask for a kind of land or a side of town; it gets them when there's such a spot on the ring.
      const want = fx.place_target;
      const sides = ["north", "east", "south", "west"];
      const score = (t: Tile) => Math.abs(t.level - ctx.p.level) + (want.terrain && t.terrain !== want.terrain ? 10 : 0);
      let best: Tile | null = null;
      for (let k = 0; k < 60; k++) {
        const side = want.side ? sides.indexOf(want.side) : Math.floor(Math.random() * 4), off = Math.floor(Math.random() * (2 * ring + 1)) - ring;
        const [x, y] = side === 0 ? [off, -ring] : side === 1 ? [ring, off] : side === 2 ? [off, ring] : [-ring, off];
        const t = tileAt(x, y);
        if (t.level <= ctx.p.level + 1 && (!best || score(t) < score(best))) best = t;
      }
      best ??= tileAt(ring, 0);
      row.data.target = { x: best.x, y: best.y };
      await ctx.c.query("update quests set data = $2 where id = $1", [row.id, JSON.stringify(row.data)]);
    } else if ("gear" in fx) {
      const { slot, tier } = fx.gear;
      const carried = carriedId(slot, ctx.p.class, tier);
      await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,$2,$3)", [ctx.p.id, slot, carried]);
      gear.push(Bag.item(slot, carried).name);
    } else if ("mark_target" in fx) {
      if (row.data.target) await hearOf(ctx, row.data.target.x, row.data.target.y, q.title);
    } else if ("errand" in fx && ctx.p.trial) {
      // A trial is a visit, not a life: nobody in town sets off on its account.
    } else if ("errand" in fx) {
      // The townsperson sets off: they know the way to where they're going, and they're back after `days`.
      const e = fx.errand;
      const until = new Date(Date.parse(ctx.day + "T00:00:00Z") + e.days * 86_400_000).toISOString().slice(0, 10);
      const to = e.to === "brightwater" ? { x: 0, y: 0 } : TOWN_TILES[e.to as keyof typeof TOWN_TILES];
      const who = (await ctx.c.query<{ id: string }>(
        "update bots b set errand = $2 from players p where p.id = b.player_id and p.name = $1 returning b.player_id as id",
        [e.who, JSON.stringify({ to: e.to, until, why: e.why, lines: e.lines ?? {} })])).rows[0];
      if (who) await ctx.c.query("insert into explored (player_id, x, y) values ($1,$2,$3) on conflict do nothing", [who.id, to.x, to.y]);
    } else plain.push(fx);
  }
  const { got, monster } = await applyEffects(ctx, plain, Math.max(1, ctx.p.level), null, q.title);
  return { got: gear.length ? { ...got, gear } : got, monster };
}

/** A brand-new character's first look round their home town starts that town's intro quest, once. */
async function introQuest(ctx: Ctx, town: TownId) {
  if (ctx.p.role !== "player" || ctx.p.level !== 1 || ctx.p.exp !== 0 || (ctx.p.start_town ?? "brightwater") !== town) return;
  const q = QUESTS.find((x) => x.intro_for === town);
  if (!q) return;
  if ((await ctx.c.query("select 1 from quests where player_id = $1 limit 1", [ctx.p.id])).rowCount) return;
  await startQuest(ctx, q.id, false);
}

/** What lives where the player is standing, if they're out in the wild (in town, the old familiar ones). */
function regionHere(ctx: Ctx) {
  return inWild(ctx.p) ? regionAt(ctx.p.pos_x!, ctx.p.pos_y!, ctx.p.cave_depth !== null && ctx.p.cave_depth !== undefined) : undefined;
}

/** A step's moment has come: tell it, apply what it does, and either offer its choices or move on. */
async function fireStep(ctx: Ctx, q: QuestDef, row: QRow, st: QStep) {
  const { got, monster } = st.effects ? await questEffects(ctx, q, row, st.effects) : { got: {}, monster: null };
  const lvl = Math.max(1, ctx.p.level);
  ctx.events.push({
    kind: "quest", quest: q.id, title: q.title, step: st.id, cue: st.cue, ...(Object.keys(got).length ? { got } : {}),
    ...(st.choices ? { choices: st.choices.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, ...(c.cost ? { costs_gold: c.cost * lvl } : {}) })) } : {}),
  });
  ctx.hint = `A side quest moves: tell the cue in two to four sentences, in the scene.${st.choices ? " Then offer its choices numbered (1), (2)… and call `quest` with the choice id only when they pick." : ""}`;
  if (monster !== null) {
    const m = pickMonster(ctx.p.level + monster, regionHere(ctx));
    await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, m]);
    ctx.events.push({ kind: "encounter", monster: m, from_quest: q.id });
  }
  if (st.choices) {
    row.data.pending = true;
    await ctx.c.query("update quests set data = $2 where id = $1", [row.id, JSON.stringify(row.data)]);
  } else await moveTo(ctx, q, row, st.then, st.end);
}

/** Check whether anything they just did moves a quest along. */
async function questTriggers(ctx: Ctx, what: { talk?: { name: string; townsfolk: boolean } } | { arrive: { x: number; y: number } } | { visit: "tavern" } | { song: true } | { win: true }) {
  for (const row of await activeQuests(ctx)) {
    if (row.data.pending) continue;
    const q = questById(row.quest); const st = q && stepOf(q, row.step);
    if (!q || !st?.on) continue;
    if (st.after_days && daysBetween(row.step_day, ctx.day) < st.after_days) continue;
    if ("talk" in what && what.talk && "talk" in st.on) {
      const on = st.on;
      const fits = on.talk === "townsfolk" ? what.talk.townsfolk : on.talk.includes(what.talk.name);
      if (!fits || (on.chance !== undefined && Math.random() >= on.chance)) continue;
      await fireStep(ctx, q, row, st);
      return; // one quest moment per conversation
    }
    if ("visit" in what && "visit" in st.on) { await fireStep(ctx, q, row, st); continue; }
    if ("song" in what && "song" in st.on) { await fireStep(ctx, q, row, st); continue; }
    if ("win" in what && "wins" in st.on) {
      row.data.wins = (row.data.wins ?? 0) + 1;
      if (row.data.wins >= st.on.wins) { row.data.wins = 0; await fireStep(ctx, q, row, st); }
      else await ctx.c.query("update quests set data = $2 where id = $1", [row.id, JSON.stringify(row.data)]);
      continue;
    }
    if ("arrive" in what && "arrive" in st.on && row.data.target && row.data.target.x === what.arrive.x && row.data.target.y === what.arrive.y) {
      await fireStep(ctx, q, row, st);
    }
  }
}

/** Strangers who've come to town for this player's quest, if any are due. */
async function questVisitors(ctx: Ctx): Promise<{ name: string; quest: string; row: QRow; step: QStep }[]> {
  const out: { name: string; quest: string; row: QRow; step: QStep }[] = [];
  for (const row of await activeQuests(ctx)) {
    const q = questById(row.quest); const st = q && stepOf(q, row.step);
    if (!q || !st?.on || !("meet" in st.on) || row.data.pending) continue;
    if (st.after_days && daysBetween(row.step_day, ctx.day) < st.after_days) continue;
    out.push({ name: st.on.meet, quest: q.id, row, step: st });
  }
  return out;
}

/** Quests left hanging past their deadline close on their own. */
async function expireQuests(ctx: Ctx) {
  const r = await ctx.c.query<QRow>("select id::text, quest, step, data, started_day::text, step_day::text, deadline::text from quests where player_id = $1 and status = 'active' and deadline < $2", [ctx.p.id, ctx.day]);
  for (const row of r.rows) {
    const q = questById(row.quest);
    if (!q) continue;
    await ctx.c.query("update quests set status = 'expired', outcome = 'expired', ended_at = now() where id = $1", [row.id]);
    ctx.events.push({ kind: "quest_expired", quest: q.id, title: q.title, line: q.expired[row.step] ?? q.expired.default });
  }
}

/** Selling or dropping a quest's item ends that quest, quietly. */
async function questItemGone(ctx: Ctx, idx: number, how: string) {
  const q = questByIndex(idx);
  if (!q) return;
  const row = (await activeQuests(ctx)).find((r) => r.quest === q.id);
  if (row) await endQuest(ctx, q, row, how, "abandoned");
}

/** Everything they've learned of the realm: pieces of people's pasts they've been told, and journals they've found. */
api.get("/journal", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const rows = (await ctx.c.query<{ key: string; day: string; how: string | null }>(
    "select key, day::text, how from player_lore where player_id = $1 order by day, key", [ctx.p.id])).rows;
  const L = lore();
  const people: Record<string, string[]> = {};
  for (const r of rows) {
    const m = /^person:(.+):(\d+)$/.exec(r.key);
    if (!m) continue;
    const text = L.people[m[1]]?.pieces[Number(m[2])];
    if (text) (people[m[1]] ??= [])[Number(m[2])] = text;
  }
  const journals = rows.filter((r) => r.key.startsWith("journal:")).map((r) => {
    const j = L.journals.find((x) => x.key === r.key);
    return j ? { title: j.title, author: j.author, text: j.text, found: r.day, where: r.how } : null;
  }).filter(Boolean);
  // Everyone they've talked to, and how each feels about them now: a word, never a number.
  const met = (await ctx.c.query<{ id: string; name: string }>(
    "select p.id, p.name from npc_memory m join players p on lower(p.name) = lower(m.npc) and p.role in ('townsfolk', 'npc') where m.player_id = $1 order by m.last_talk desc limit 40", [ctx.p.id])).rows;
  const known = [];
  for (const w of met) known.push({ name: w.name, feels: (await standingWith(ctx.c, ctx.p, w, ctx.day)).word });
  ctx.events.push({ kind: "journal", pasts: Object.entries(people).map(([name, pieces]) => ({ name, told: pieces.filter(Boolean) })), journals, people_you_know: known,
    ...(rows.length ? {} : { empty: true }) });
  ctx.hint = "Show what they've learned as their own notebook: people first (a few lines each, in your words, and from people_you_know how each seems to feel about them, as a phrase in the notebook's voice, e.g. 'warm to me lately', 'still cold since the fields'; never a score), then the journals they've found, quoted exactly under their titles. Nothing beyond what's here.";
}, { quiet: true })));

/** Answer the choice a quest is waiting on. */
api.post("/quest", async (c) => {
  const body = z.object({ choice: z.string().trim().min(1).max(40), answer: z.string().trim().max(120).optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    const rows = (await activeQuests(ctx)).filter((r) => r.data.pending);
    for (const row of rows) {
      const q = questById(row.quest)!; const st = stepOf(q, row.step)!;
      const ch = st.choices?.find((x, i) => x.id === body.choice || String(i + 1) === body.choice || x.label.toLowerCase() === body.choice.toLowerCase());
      if (!ch) continue;
      const cost = (ch.cost ?? 0) * Math.max(1, ctx.p.level);
      if (cost > ctx.p.gold) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold, note: "the quest waits; come back with the gold" }); return; }
      if (cost) await savePlayer(ctx, { gold: ctx.p.gold - cost });
      const { got, monster } = await questEffects(ctx, q, row, ch.effects);
      ctx.events.push({ kind: "quest_choice", quest: q.id, title: q.title, choice: ch.id, label: ch.label, ...(cost ? { paid: cost } : {}), got });
      if (ch.news) await post(ctx, "quest_news", ctx.p.name, null, { line: ch.news.replaceAll("{name}", ctx.p.name) });
      if (monster !== null) {
        const m = pickMonster(ctx.p.level + monster, regionHere(ctx));
        await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, m]);
        ctx.events.push({ kind: "encounter", monster: m, from_quest: q.id });
      }
      // "Think about it" goes back to the same step, waiting for the same moment again.
      if (ch.then === st.id) {
        row.data.pending = false;
        await ctx.c.query("update quests set data = $2 where id = $1", [row.id, JSON.stringify(row.data)]);
        ctx.events.push({ kind: "quest_progress", quest: q.id, title: q.title, know: knowLine(q, row) });
      } else await moveTo(ctx, q, row, ch.then, ch.end);
      ctx.hint = "Tell how it went in two to four sentences, with the real numbers in got; then the journal line if the quest goes on, or a beat of closure if it's done.";
      return;
    }
    ctx.events.push({ kind: "no_quest_choice", waiting: rows.map((r) => ({ quest: r.quest, choices: stepOf(questById(r.quest)!, r.step)?.choices?.map((x) => x.id) ?? [] })) });
  }));
});

// ---------- wild events ----------

/** Apply event or quest effects. Gold and experience scale by lvl. Returns what changed, any monster level offset, and any quest to start. */
async function applyEffects(ctx: Ctx, effects: (Effect | QEffect)[], lvl: number, around: [number, number] | null, from: string) {
  const got: Record<string, unknown> = {};
  let monster: number | null = null;
  let quest: string | null = null;
  for (const fx of effects) {
    if ("gold" in fx) { const g = fx.gold * lvl; await savePlayer(ctx, { gold: Math.max(0, ctx.p.gold + g) }); got.gold = g; }
    else if ("lose_gold_pct" in fx) { const g = Math.floor(ctx.p.gold * fx.lose_gold_pct / 100); await savePlayer(ctx, { gold: ctx.p.gold - g }); got.gold_lost = g; }
    else if ("heal_pct" in fx) { const h = Math.min(ctx.p.max_hp - ctx.p.hp, Math.ceil(ctx.p.max_hp * fx.heal_pct / 100)); await savePlayer(ctx, { hp: ctx.p.hp + h }); got.healed = h; }
    else if ("hurt_pct" in fx) { const h = Math.min(ctx.p.hp - 1, Math.ceil(ctx.p.max_hp * fx.hurt_pct / 100)); await savePlayer(ctx, { hp: ctx.p.hp - Math.max(0, h) }); got.hurt = Math.max(0, h); }
    else if ("charm" in fx) { const n = Math.max(-ctx.p.charm, fx.charm); await savePlayer(ctx, { charm: ctx.p.charm + n }); got.charm = n; }
    else if ("gem" in fx) { await savePlayer(ctx, { gems: ctx.p.gems + fx.gem }); got.gems = fx.gem; }
    else if ("fights" in fx) { const n = Math.max(-ctx.t.forest_fights, fx.fights); await saveTurns(ctx, { forest_fights: ctx.t.forest_fights + n }); got.forest_fights = n; }
    else if ("exp" in fx) { const n = expInFights(fx.exp, lvl, ctx.p.level); await savePlayer(ctx, { exp: ctx.p.exp + n }); got.exp = n; }
    else if ("map" in fx) { got.marked = await sketchNearby(ctx, from, fx.map, around ?? undefined); }
    else if ("monster" in fx) { monster = fx.monster; }
    else if ("quest" in fx) { quest = fx.quest; }
    else if ("trinket" in fx) {
      const x = trinket(fx.trinket);
      if (ctx.p.trinket_id === 0) await savePlayer(ctx, { trinket_id: x.id });
      else await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,'trinket',$2)", [ctx.p.id, x.id]);
      got.jewelry = { name: x.name, bonus: bonusText(x, attributeName(ctx.p.class)), worn: ctx.p.trinket_id === x.id };
    }
  }
  return { got, monster, quest };
}

/** Answer the event in front of you. The server rolls what comes of it. */
api.post("/event", async (c) => {
  const body = z.object({ choice: z.string().trim().min(1).max(40), answer: z.string().trim().max(120).optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    const pe = ctx.p.pending_event;
    if (!pe || !inWild(ctx.p) || pe.x !== ctx.p.pos_x || pe.y !== ctx.p.pos_y) { ctx.events.push({ kind: "no_event" }); return; }
    const e = eventById(pe.id);
    const choice = e?.choices.find((x) => x.id === body.choice || x.label.toLowerCase() === body.choice.toLowerCase() || String(e.choices.indexOf(x) + 1) === body.choice);
    if (!e || !choice) { ctx.events.push({ kind: "no_such_choice", choices: e?.choices.map((x) => x.id) ?? [] }); return; }
    const t = tileAt(pe.x, pe.y);
    const lvl = Math.max(1, t.level);
    const cost = (choice.cost ?? 0) * lvl;
    if (cost > ctx.p.gold) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold, note: "the event is still there; pick something else or walk on" }); return; }
    // A riddle is judged on their own words. Plugins from before riddles (0.30.0) can't send any, so theirs is rolled as before.
    const riddle = choice.id === "answer" && pe.riddle ? (await loadLore()).riddles.find((r) => r.key === pe.riddle) ?? null : null;
    const info = current();
    const rolled = !riddle || (!info?.trial && info?.plugin !== undefined && info?.plugin !== null && older(info.plugin, "0.30.0"));
    if (riddle && !rolled && !body.answer) {
      ctx.events.push({ kind: "needs_answer", event: e.id, riddle: riddle.text, max_words: MAX_ANSWER_WORDS });
      ctx.hint = "Ask them for their answer to the riddle (quote it again) and wait. Then call `event` with choice 'answer' and `answer` set to exactly what they typed. Don't answer it for them.";
      return;
    }
    await savePlayer(ctx, { pending_event: null, ...(cost ? { gold: ctx.p.gold - cost } : {}) });
    const right = riddle && !rolled ? judge(body.answer!, riddle.answers) : null;
    const out = right === null ? rollOutcome(choice)
      : right ? { key: riddle!.realm ? "right_about_the_realm" : "right", weight: 1, effects: riddle!.realm ? [{ exp: 18 }, { gold: 8 }] as Effect[] : choice.outcomes.find((x) => x.key === "right")!.effects }
      : choice.outcomes.find((x) => x.key === "wrong")!;
    if (right) await ctx.c.query("insert into player_lore (player_id, key, day, how) values ($1, $2, $3, 'riddle') on conflict do nothing", [ctx.p.id, riddle!.key, ctx.day]);
    const { got, monster: m0, quest } = await applyEffects(ctx, out.effects, lvl, [pe.x, pe.y], e.id === "hermit" ? "a hermit" : "what you saw");
    const monster = m0 !== null ? pickMonster(t.level + m0, regionAt(t.x, t.y)) : null;
    ctx.events.push({ kind: "event_outcome", event: e.id, choice: choice.id, chose: choice.label, outcome: out.key, scene: e.description, ...(cost ? { paid: cost } : {}), got, ...(monster ? { fight: true } : {}),
      ...(right !== null ? { riddle: riddle!.text, they_said: body.answer, ...(right ? {} : { note: "don't tell them the answer; they can try another day" }) } : {}) });
    if (quest) await startQuest(ctx, quest, true);
    if (monster) {
      await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, monster]);
      ctx.events.push({ kind: "encounter", monster, place: t.name, terrain: t.terrain, from_event: e.id });
    }
    ctx.hint = `Tell what happened in two to four sentences: the outcome '${out.key}' of choosing '${choice.label}', in the scene of ${e.description}. Give the real numbers in got (gold, healing, hurt, charm, gems, fights, exp, places marked on the map).${right === true ? " They answered the troll's riddle themselves and got it right: let him take it badly, with grudging respect." : right === false ? " They answered the troll's riddle and got it wrong: he's delighted. Never say what the right answer was." : ""}${monster ? " Then it's a fight: show the fight menu." : " Then the Wild menu."}`;
    await logEvent(ctx, "wild_event", { event: e.id, choice: choice.id, outcome: out.key, level: t.level, ...got, marked: undefined, ...(right !== null ? { riddle: riddle!.key } : {}) });
  }));
});

// ---------- caves ----------

function requireCave(ctx: Ctx) {
  if (!inWild(ctx.p) || !ctx.p.cave_depth) throw new GameError("not_in_cave", "you need to be inside a cave", 409);
}

/** Go down into a cave from its mouth, go deeper, or climb back out to the surface. */
api.post("/cave", async (c) => {
  const body = z.object({ op: z.enum(["descend", "deeper", "climb"]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    if (!inWild(ctx.p)) throw new GameError("not_in_cave", "there are no caves in town; find one out in the hills", 409);
    await dropEvent(ctx);
    const t = tileAt(ctx.p.pos_x!, ctx.p.pos_y!);
    const depth = ctx.p.cave_depth ?? 0;
    if (body.op === "climb") {
      if (!depth) { ctx.events.push({ kind: "not_in_cave" }); return; }
      await leaveGround(ctx);
      await savePlayer(ctx, { cave_depth: null });
      ctx.events.push({ kind: "climbed_out", place: t.name });
      return;
    }
    if (t.poi !== "cave") { ctx.events.push({ kind: "no_cave_here", place: t.name }); return; }
    if (body.op === "descend" && depth) { ctx.events.push({ kind: "already_in_cave", depth }); return; }
    if (body.op === "deeper") {
      if (!depth) { ctx.events.push({ kind: "not_in_cave" }); return; }
      if (depth >= MAX_DEPTH) { ctx.events.push({ kind: "cave_bottom", depth }); return; }
      if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left", why: "too tired to climb down any further today" }); return; }
      await saveTurns(ctx, { forest_fights: ctx.t.forest_fights - 1 });
    }
    await leaveGround(ctx);
    const next = depth + 1;
    await savePlayer(ctx, { cave_depth: next });
    const left = await caveFindsLeft(ctx, t.x, t.y);
    ctx.events.push({ kind: "in_cave", place: t.name, depth: next, max_depth: MAX_DEPTH, level: caveLevel(t.level, next), pickaxe: ctx.p.pickaxe, seams: left.cave > 0 ? (left.cave > CAVE_FINDS_PER_DAY / 2 ? "rich" : "thinning") : "picked clean" });
    if (next === 1) await logEvent(ctx, "cave", { x: t.x, y: t.y, level: t.level });
  }));
});

async function caveFindsLeft(ctx: Ctx, x: number, y: number) {
  const r = await ctx.c.query<{ total: string; mine: string }>(
    "select coalesce(sum(n), 0)::text as total, coalesce(sum(n) filter (where player_id = $4), 0)::text as mine from mining where day = $1 and x = $2 and y = $3",
    [ctx.day, x, y, ctx.p.id]);
  const cap = ctx.p.role === "player" ? FINDS_PER_PERSON.player : FINDS_PER_PERSON.townsfolk;
  return { cave: Math.max(0, CAVE_FINDS_PER_DAY - Number(r.rows[0].total)), yours: Math.max(0, cap - Number(r.rows[0].mine)), cap };
}

/** One swing of the pick. Costs a forest fight. Ore goes in the bag, gems in the pouch; sometimes something lives in the dark. */
api.post("/mine", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  await requireNoEncounter(ctx);
  requireCave(ctx);
  if (!ctx.p.pickaxe) { ctx.events.push({ kind: "no_pickaxe", sold_by: "Odile, at her workshop in town", cost: PICKAXE_COST }); return; }
  if ((ctx.t.swings ?? 0) >= SWINGS_PER_DAY) { ctx.events.push({ kind: "no_swings_left", per_day: SWINGS_PER_DAY, refills: "at the reset" }); return; }
  const t = tileAt(ctx.p.pos_x!, ctx.p.pos_y!);
  const depth = ctx.p.cave_depth!;
  const left = await caveFindsLeft(ctx, t.x, t.y);
  if (left.cave <= 0) { ctx.events.push({ kind: "mined_out", place: t.name, refills: "at the reset" }); return; }
  if (left.yours <= 0) { ctx.events.push({ kind: "your_share", place: t.name, limit: left.cap, refills: "at the reset" }); return; }
  await saveTurns(ctx, { swings: (ctx.t.swings ?? 0) + 1 });
  const r = swing(depth, countryOf(t.x, t.y));
  const take = async () => {
    await ctx.c.query("insert into mining (day, x, y, player_id, n) values ($1,$2,$3,$4,1) on conflict (day, x, y, player_id) do update set n = mining.n + 1",
      [ctx.day, t.x, t.y, ctx.p.id]);
    if (left.cave === 1) await post(ctx, "mined_out", ctx.p.name, null, { place: t.name });
  };
  if (r.kind === "ambush") {
    const m = pickMonster(caveLevel(t.level, depth), "cave");
    await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, m]);
    ctx.events.push({ kind: "encounter", monster: m, place: t.name, in_cave: true, depth, ambush: true });
    await logEvent(ctx, "mine", { x: t.x, y: t.y, depth, found: "ambush" });
    return;
  }
  if (r.kind === "nothing") {
    ctx.events.push({ kind: "mined", found: null, depth, finds_left_today: left.yours, swings_left: SWINGS_PER_DAY - ctx.t.swings });
    await logEvent(ctx, "mine", { x: t.x, y: t.y, depth, found: "nothing" });
    await maybeJournal(ctx, "cave", t.ring);
    return;
  }
  if (r.kind === "gem") {
    await savePlayer(ctx, { gems: ctx.p.gems + 1 });
    await take();
    ctx.events.push({ kind: "mined", found: "gem", gems: ctx.p.gems, depth, finds_left_today: left.yours - 1, swings_left: SWINGS_PER_DAY - ctx.t.swings });
    await logEvent(ctx, "mine", { x: t.x, y: t.y, depth, found: "gem" });
    return;
  }
  const usedNow = await Bag.used(ctx.c, ctx.p.id);
  const cap = Bag.bag(ctx.p.bag_id).capacity;
  if (usedNow + r.ore.weight > cap) {
    ctx.events.push({ kind: "mined", found: r.ore.name, weight: r.ore.weight, left_behind: true, reason: "bag_full", bag_used: usedNow, bag_capacity: cap, depth });
    await logEvent(ctx, "mine", { x: t.x, y: t.y, depth, found: r.ore.name, kept: false });
    return;
  }
  await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,'ore',$2)", [ctx.p.id, r.ore.id]);
  await take();
  ctx.events.push({ kind: "mined", found: r.ore.name, weight: r.ore.weight, bag_used: usedNow + r.ore.weight, bag_capacity: cap, depth, finds_left_today: left.yours - 1, swings_left: SWINGS_PER_DAY - ctx.t.swings });
  await logEvent(ctx, "mine", { x: t.x, y: t.y, depth, found: r.ore.name, kept: true });
})));

// ---------- herbs and potions ----------

/** How many of each herb (or potion) they carry, by id. */
async function countOf(ctx: Ctx, slot: "herb" | "potion") {
  const n: Record<number, number> = {};
  for (const x of await Bag.contents(ctx.c, ctx.p.id)) if (x.slot === slot) n[x.item_id] = (n[x.item_id] ?? 0) + 1;
  return n;
}
async function takeOut(ctx: Ctx, slot: "herb" | "potion", id: number, k: number) {
  await ctx.c.query(`delete from inventory where id in (select id from inventory where player_id = $1 and slot = $2 and item_id = $3 order by id limit $4)`, [ctx.p.id, slot, id, k]);
}
/** Into the bag if there's room for it. */
async function pocket(ctx: Ctx, slot: "herb" | "potion", id: number, k = 1) {
  const w = Bag.item(slot, id).weight;
  const usedNow = await Bag.used(ctx.c, ctx.p.id);
  const cap = Bag.bag(ctx.p.bag_id).capacity;
  const fit = Math.max(0, Math.min(k, Math.floor((cap - usedNow) / Math.max(1, w))));
  for (let i = 0; i < fit; i++) await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,$2,$3)", [ctx.p.id, slot, id]);
  return { kept: fit, bag_used: usedNow + fit * w, bag_capacity: cap };
}
const herbsHere = (ctx: Ctx) => { const t = tileAt(ctx.p.pos_x!, ctx.p.pos_y!); return herbsAt(t.terrain, regionHere(ctx), t.ring); };

/** Walking onto new ground: now and then something worth picking catches the eye. Free, and doesn't count as a search. */
async function maybeSpotHerb(ctx: Ctx) {
  if (ctx.p.role !== "player" || roll(99) >= SPOT_CHANCE) return;
  const h = pickHerb(herbsHere(ctx));
  if (!h) return;
  const r = await pocket(ctx, "herb", h.id);
  ctx.events.push({ kind: "spotted_herb", herb: h.name, stored: r.kept > 0, ...(r.kept ? {} : { reason: "bag_full" }), bag_used: r.bag_used, bag_capacity: r.bag_capacity });
  await logEvent(ctx, "forage", { herb: h.name, spotted: true, kept: r.kept > 0 });
}

/** Search the ground where you stand for herbs. A few times a day, apart from turns; now and then something was watching. */
api.post("/forage", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  await requireNoEncounter(ctx);
  if (!inWild(ctx.p) || townAt(ctx.p.pos_x, ctx.p.pos_y)) { ctx.events.push({ kind: "cannot_forage", reason: "nothing worth picking grows in the streets; go out into the wild" }); return; }
  if (ctx.p.cave_depth) { ctx.events.push({ kind: "cannot_forage", reason: "nothing grows down here in the dark" }); return; }
  const done = ctx.t.forages ?? 0;
  if (done >= FORAGES_PER_DAY) { ctx.events.push({ kind: "no_forages_left", per_day: FORAGES_PER_DAY, refills: "at the reset" }); return; }
  await saveTurns(ctx, { forages: done + 1 });
  const left = FORAGES_PER_DAY - done - 1;
  const t = tileAt(ctx.p.pos_x!, ctx.p.pos_y!);
  const here = herbsHere(ctx);
  const r = roll(99);
  if (r < FORAGE.ambush) {
    const m = pickMonster(t.level, regionHere(ctx), isNight());
    await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, m]);
    ctx.events.push({ kind: "encounter", monster: m, place: t.name, terrain: t.terrain, while_foraging: true });
    await logEvent(ctx, "forage", { found: "ambush", terrain: t.terrain });
    return;
  }
  const h = r < FORAGE.ambush + FORAGE.find ? pickHerb(here) : null;
  if (!h) {
    ctx.events.push({ kind: "foraged", found: null, grows_here: here.map((x) => x.name), forages_left: left });
    await logEvent(ctx, "forage", { found: null, terrain: t.terrain });
    return;
  }
  const got = await pocket(ctx, "herb", h.id);
  ctx.events.push({ kind: "foraged", found: h.name, stored: got.kept > 0, ...(got.kept ? {} : { reason: "bag_full" }), bag_used: got.bag_used, bag_capacity: got.bag_capacity, grows_here: here.map((x) => x.name), forages_left: left });
  await logEvent(ctx, "forage", { found: h.name, terrain: t.terrain, kept: got.kept > 0 });
})));

/** The healer's bench in whatever town you're in: recipes taught there, what you know, and what you could brew now. */
api.get("/apothecary", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const town = requireTown(ctx, "The healer's bench", ALL_TOWNS);
  const teacher = TEACHERS[town];
  const known = new Set((await ctx.c.query<{ potion: number }>("select potion from recipes where player_id = $1", [ctx.p.id])).rows.map((x) => x.potion));
  const herbs = await countOf(ctx, "herb");
  const potions = await countOf(ctx, "potion");
  ctx.events.push({
    kind: "apothecary", healer: teacher.name, bench: teacher.bench,
    recipes: POTIONS.map((p) => {
      const can = Math.min(...Object.entries(p.needs).map(([h, k]) => Math.floor((herbs[Number(h)] ?? 0) / k)));
      const taught = teacher.teaches.includes(p.id);
      if (!taught && !known.has(p.id)) return null;
      return { id: p.id, name: p.name, does: p.what, needs: Object.entries(p.needs).map(([h, k]) => `${k} ${herb(Number(h)).name}`).join(", "), fee: p.fee * ctx.p.level,
        known: known.has(p.id), ...(known.has(p.id) ? { can_brew_now: can } : { price: p.price }) };
    }).filter(Boolean),
    elsewhere: POTIONS.filter((p) => !teacher.teaches.includes(p.id) && !known.has(p.id)).length ? "other healers teach other recipes" : undefined,
    your_herbs: Object.entries(herbs).map(([id, n]) => ({ name: herb(Number(id)).name, count: n })),
    your_potions: Object.entries(potions).map(([id, n]) => ({ id: Number(id), name: potion(Number(id)).name, count: n })),
  });
})));

api.post("/apothecary", async (c) => {
  const body = z.object({ op: z.enum(["learn", "brew"]), potion: z.number().int(), count: z.number().int().min(1).max(10).optional(), confirm: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    const town = requireTown(ctx, "The healer's bench", ALL_TOWNS);
    const teacher = TEACHERS[town];
    const p = POTIONS.find((x) => x.id === body.potion);
    if (!p) throw new GameError("what", "no such recipe");
    const row = (await ctx.c.query<{ brewed: number }>("select brewed from recipes where player_id = $1 and potion = $2", [ctx.p.id, p.id])).rows[0];
    if (body.op === "learn") {
      if (row) { ctx.events.push({ kind: "already_known", recipe: p.name }); return; }
      if (!teacher.teaches.includes(p.id)) { ctx.events.push({ kind: "not_taught_here", recipe: p.name, healer: teacher.name, reason: "another healer teaches that one" }); return; }
      if (!body.confirm) {
        ctx.events.push({ kind: "recipe_quote", recipe: p.name, does: p.what, needs: Object.entries(p.needs).map(([h, k]) => `${k} ${herb(Number(h)).name}`).join(", "), price: p.price, purse: ctx.p.gold, healer: teacher.name });
        ctx.hint = "A quote, nothing paid yet: say what the recipe does, what it needs, and the price, and ask them to confirm. Call again with confirm: true only on a yes.";
        return;
      }
      // Paid over the counter, from the purse, like the healer's own fees.
      if (ctx.p.gold < p.price) { ctx.events.push({ kind: "too_poor", cost: p.price, gold: ctx.p.gold, ...(ctx.p.bank >= p.price - ctx.p.gold ? { bank: ctx.p.bank, hint: "withdraw it from the bank first" } : {}) }); return; }
      await savePlayer(ctx, { gold: ctx.p.gold - p.price });
      await ctx.c.query("insert into recipes (player_id, potion, learned_day) values ($1,$2,$3) on conflict do nothing", [ctx.p.id, p.id, ctx.day]);
      ctx.events.push({ kind: "recipe_learned", recipe: p.name, healer: teacher.name, price: p.price, gold: ctx.p.gold, needs: Object.entries(p.needs).map(([h, k]) => `${k} ${herb(Number(h)).name}`).join(", ") });
      await logEvent(ctx, "spend", { on: "recipe", recipe: p.name, gold: p.price });
      return;
    }
    // Brewing: any healer's bench will do for a recipe you know.
    if (!row) { ctx.events.push({ kind: "recipe_unknown", recipe: p.name, ...(teacher.teaches.includes(p.id) ? { price: p.price, taught_here: true } : { taught_here: false }) }); return; }
    const herbs = await countOf(ctx, "herb");
    const want = body.count ?? 1;
    const can = Math.min(...Object.entries(p.needs).map(([h, k]) => Math.floor((herbs[Number(h)] ?? 0) / k)));
    if (can < 1) { ctx.events.push({ kind: "missing_herbs", recipe: p.name, needs: Object.entries(p.needs).map(([h, k]) => ({ herb: herb(Number(h)).name, need: k, have: herbs[Number(h)] ?? 0 })) }); return; }
    const n = Math.min(want, can);
    const fee = p.fee * ctx.p.level * n;
    if (ctx.p.gold < fee) { ctx.events.push({ kind: "too_poor", cost: fee, gold: ctx.p.gold, reason: "the bench fee", ...(ctx.p.bank >= fee - ctx.p.gold ? { bank: ctx.p.bank, hint: "withdraw it from the bank first" } : {}) }); return; }
    await savePlayer(ctx, { gold: ctx.p.gold - fee });
    for (const [h, k] of Object.entries(p.needs)) await takeOut(ctx, "herb", Number(h), k * n);
    // Practice: each pot brewed makes the next a little likelier to give a draught more. Nobody tells you the odds.
    let extra = 0;
    for (let i = 0; i < n; i++) if (roll(9999) < Math.round(extraChance(row.brewed + i) * 10000)) extra++;
    await ctx.c.query("update recipes set brewed = brewed + $3 where player_id = $1 and potion = $2", [ctx.p.id, p.id, n]);
    const got = await pocket(ctx, "potion", p.id, n + extra);
    ctx.events.push({ kind: "brewed", recipe: p.name, made: n + extra, ...(extra ? { extra, why: "practice: a steadier hand, less wasted" } : {}), fee, kept: got.kept,
      ...(got.kept < n + extra ? { left_on_bench: n + extra - got.kept, reason: "bag_full" } : {}), ...(want > n ? { short_of_herbs_for: want - n } : {}),
      bag_used: got.bag_used, bag_capacity: got.bag_capacity, healer: teacher.name });
    await logEvent(ctx, "brew", { potion: p.name, n, extra, fee });
  }));
});

/** Drink a potion from the bag: between fights, or in one (one a fight, and the thing you're fighting gets its swing). */
api.post("/drink", async (c) => {
  const body = z.object({ potion: z.number().int() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const p = POTIONS.find((x) => x.id === body.potion);
    if (!p) throw new GameError("what", "no such potion");
    if (!(await countOf(ctx, "potion"))[p.id]) { ctx.events.push({ kind: "no_potion", potion: p.name }); return; }
    const enc = (await ctx.c.query<{ id: string; kind: string; monster: Monster; drank: boolean; log: Event[] }>("select id, kind, monster, drank, log from encounters where player_id = $1", [ctx.p.id])).rows[0];
    if (enc?.drank) { ctx.events.push({ kind: "already_drank", reason: "one draught a fight; any more and you'd be sick on your boots" }); return; }
    if ((p.effect === "str" || p.effect === "def") && ctx.p.boost) { ctx.events.push({ kind: "already_drank", draught: ctx.p.boost.name, reason: "you've a draught in you already, waiting on the fight" }); return; }
    if (p.effect === "mana" && !manaRules(ctx.p.class)) { ctx.events.push({ kind: "not_for_you", reason: "it'd taste of mint and do nothing; only those with the gift have mana" }); return; }
    if (p.effect === "heal" && ctx.p.hp >= ctx.p.max_hp) { ctx.events.push({ kind: "no_need", reason: "you're whole already; save it" }); return; }
    if (p.effect === "mana" && (ctx.t.mana ?? 0) >= manaMax(ctx.p)) { ctx.events.push({ kind: "no_need", reason: "your mana's full already; save it" }); return; }
    await takeOut(ctx, "potion", p.id, 1);
    if (p.effect === "heal") {
      const healed = Math.min(ctx.p.max_hp - ctx.p.hp, Math.ceil(ctx.p.max_hp * p.amount));
      await savePlayer(ctx, { hp: ctx.p.hp + healed });
      ctx.events.push({ kind: "drank", potion: p.name, healed, hp: ctx.p.hp, max_hp: ctx.p.max_hp });
    } else if (p.effect === "mana") {
      const max = manaMax(ctx.p);
      const before = ctx.t.mana ?? 0;
      const back = Math.min(max - before, Math.ceil(max * p.amount));
      await saveTurns(ctx, { mana: before + back });
      ctx.events.push({ kind: "drank", potion: p.name, mana_back: back, mana: ctx.t.mana, mana_max: max });
    } else {
      const e = effective(ctx.p);
      const add = boostAmount(p, p.effect === "str" ? e.str : e.def);
      await savePlayer(ctx, { boost: { name: p.name, [p.effect]: add } });
      ctx.events.push({ kind: "drank", potion: p.name, [p.effect === "str" ? "strength_added" : "defense_added"]: add, lasts: enc ? "the rest of this fight" : "your next fight" });
    }
    await logEvent(ctx, "drink", { potion: p.name, in_fight: Boolean(enc) });
    if (!enc) return;
    // In a fight, drinking is your round: the monster swings.
    await ctx.c.query("update encounters set drank = true where id = $1", [enc.id]);
    const m = enc.monster;
    const pf = fighterOf(ctx.p);
    const dmg = Math.max(0, Math.round(blow(m.str, pf.def)));
    await savePlayer(ctx, { hp: Math.max(0, ctx.p.hp - dmg) });
    ctx.events.push(dmg > 0 ? { kind: "hit", attacker: m.name, defender: ctx.p.name, damage: dmg, defender_hp: ctx.p.hp } : { kind: "miss", attacker: m.name, defender: ctx.p.name });
    if (ctx.p.hp <= 0) {
      await ctx.c.query("delete from encounters where id = $1", [enc.id]);
      await logEvent(ctx, "fight_end", { encounter: enc.kind, monster: m.name, monster_level: m.level ?? null, outcome: enc.kind === "master" ? "master_won" : "died", while: "drinking", hp_left: 0, max_hp: ctx.p.max_hp, ...fightSummary(enc.log ?? [], [], ctx.p.name) });
      await lose(ctx, enc.kind, m);
      await draughtWearsOff(ctx);
    } else {
      await ctx.c.query("update encounters set round = round + 1 where id = $1", [enc.id]);
    }
  }));
});

// ---------- Odile's workshop ----------

async function materials(ctx: Ctx) {
  const items = await Bag.contents(ctx.c, ctx.p.id);
  const oreCount: Record<number, number> = {};
  for (const x of items) if (x.slot === "ore") oreCount[x.item_id] = (oreCount[x.item_id] ?? 0) + 1;
  return { items, ore: oreCount };
}

/** Odile's workshop: a pickaxe for sale, what she can make from what you're carrying, and what you're wearing. */
api.get("/workshop", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireInTown(ctx, "Odile's workshop");
  const m = await materials(ctx);
  ctx.events.push({
    kind: "workshop",
    pickaxe: { owned: ctx.p.pickaxe, cost: PICKAXE_COST },
    wearing: ctx.p.trinket_id ? { name: trinket(ctx.p.trinket_id).name, bonus: bonusText(trinket(ctx.p.trinket_id), attributeName(ctx.p.class)) } : null,
    your_ore: Object.entries(m.ore).map(([id, n]) => ({ name: oreOf(Number(id)).name, count: n })),
    gems: ctx.p.gems,
    gem_sells_for: GEM_SELL,
    recipes: TRINKETS.filter((x) => x.id > 0 && !x.quest).map((x) => ({
      id: x.id, name: x.name, bonus: bonusText(x, attributeName(ctx.p.class)),
      needs: { ore: Object.entries(x.needs.ore).map(([id, n]) => `${n} ${oreOf(Number(id)).name}`), gems: x.needs.gems, fee: x.needs.fee },
      can_make: canMake(x, { ore: m.ore, gems: ctx.p.gems, gold: ctx.p.gold }),
    })),
  });
})));

api.post("/workshop", async (c) => {
  const body = z.union([
    z.object({ op: z.literal("pickaxe") }),
    z.object({ op: z.literal("craft"), id: z.number().int() }),
    z.object({ op: z.literal("sell_gems"), count: z.number().int().positive().optional() }),
  ]).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    requireInTown(ctx, "Odile's workshop");
    await requireNoEncounter(ctx);
    if (body.op === "pickaxe") {
      if (ctx.p.pickaxe) { ctx.events.push({ kind: "already_have", item: "pickaxe" }); return; }
      if (ctx.p.gold < PICKAXE_COST) { ctx.events.push({ kind: "too_poor", cost: PICKAXE_COST, gold: ctx.p.gold }); return; }
      await savePlayer(ctx, { gold: ctx.p.gold - PICKAXE_COST, pickaxe: true });
      ctx.events.push({ kind: "bought", shop: "workshop", item: "Pickaxe", cost: PICKAXE_COST });
      await logEvent(ctx, "spend", { on: "pickaxe", gold: PICKAXE_COST });
      return;
    }
    if (body.op === "sell_gems") {
      const n = Math.min(ctx.p.gems, body.count ?? ctx.p.gems);
      if (n <= 0) { ctx.events.push({ kind: "no_gems" }); return; }
      await savePlayer(ctx, { gems: ctx.p.gems - n, gold: ctx.p.gold + n * GEM_SELL });
      if (!ctx.p.is_test) await toStorehouse(ctx.c, [{ slot: "gem", item_id: 0, qty: n }]);
      ctx.events.push({ kind: "sold", item: n === 1 ? "a gem" : `${n} gems`, gold: n * GEM_SELL });
      return;
    }
    const x = trinket(body.id);
    if (x.id === 0) { ctx.events.push({ kind: "no_such_recipe", id: body.id }); return; }
    const m = await materials(ctx);
    if (!canMake(x, { ore: m.ore, gems: ctx.p.gems, gold: ctx.p.gold })) {
      ctx.events.push({ kind: "cannot_make", item: x.name, needs: { ore: Object.entries(x.needs.ore).map(([id, n]) => `${n} ${oreOf(Number(id)).name}`), gems: x.needs.gems, fee: x.needs.fee },
        have: { ore: Object.entries(m.ore).map(([id, n]) => `${n} ${oreOf(Number(id)).name}`), gems: ctx.p.gems, gold: ctx.p.gold } });
      return;
    }
    for (const [o, k] of Object.entries(x.needs.ore)) {
      await ctx.c.query("delete from inventory where id in (select id from inventory where player_id = $1 and slot = 'ore' and item_id = $2 order by id limit $3)", [ctx.p.id, Number(o), k]);
    }
    // Worn straight away if nothing's on; otherwise it goes in the bag (it weighs almost nothing).
    const wearNow = ctx.p.trinket_id === 0;
    await savePlayer(ctx, { gems: ctx.p.gems - x.needs.gems, gold: ctx.p.gold - x.needs.fee, ...(wearNow ? { trinket_id: x.id } : {}) });
    if (!wearNow) await ctx.c.query("insert into inventory (player_id, slot, item_id) values ($1,'trinket',$2)", [ctx.p.id, x.id]);
    ctx.events.push({ kind: "crafted", item: x.name, bonus: bonusText(x, attributeName(ctx.p.class)), fee: x.needs.fee, worn: wearNow, ...(wearNow ? {} : { in_bag: true, wearing: trinket(ctx.p.trinket_id).name }) });
    await logEvent(ctx, "craft", { item: x.name, fee: x.needs.fee });
    if (x.id >= 7) await post(ctx, "crafted", ctx.p.name, null, { item: x.name });
  }));
});

// ---------- the town square ----------

/** Who's about in the square right now: townsfolk by their timetable, and real players seen in the last 15 minutes. */
api.get("/square", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireInTown(ctx, "the town square");
  const now = new Date();
  const folk = await ctx.c.query<{ name: string; personality: Personality; alive: boolean; mind: Mind; pos_x: number | null; pos_y: number | null; location: "inn" | "fields" }>(
    "select p.name, b.personality, p.alive, b.mind, p.pos_x, p.pos_y, p.location from bots b join players p on p.id = b.player_id where coalesce(case when b.errand->>'until' >= $1 then b.errand->>'to' end, b.home) = 'brightwater' order by p.name", [ctx.day]);
  const about: { name: string; doing: string; on_mind?: string }[] = [];
  const elsewhere: { name: string; where: string; on_mind?: string }[] = [];
  for (const f of folk.rows) {
    const today = f.mind?.today?.day === ctx.day ? f.mind.today.sessions : undefined;
    const w = whereabouts(f.personality, f.name, ctx.day, now, f.alive, {
      sessions: today,
      away: awayToday(ctx.day, f.name, f.personality),
      wild: f.pos_x === null ? null : tileAt(f.pos_x, f.pos_y!).name,
      sleeps: f.location,
    });
    const on_mind = f.mind?.goal ? goalLabel(f.name, f.personality, f.mind.goal) : undefined;
    const grudge = f.mind?.grudge ? { grudge_against: f.mind.grudge.name } : {};
    if (w.where === "square") about.push({ name: f.name, doing: "about the square", on_mind, ...grudge, ...looksOf(f.name) });
    else if (w.where === "heading") about.push({ name: f.name, doing: w.to === "forest" ? "heading out to hunt" : `heading for the ${w.to}`, on_mind, ...grudge, ...looksOf(f.name) });
    else if (w.where === "asleep") elsewhere.push({ name: f.name, where: w.at === "inn" ? "asleep at the inn" : "asleep in the fields" });
    else if (w.where === "dead") elsewhere.push({ name: f.name, where: "dead until morning" });
    else if (w.where === "unseen") elsewhere.push({ name: f.name, where: "nowhere to be seen" });
    else if (w.where === "away") elsewhere.push({ name: f.name, where: `away for the day: ${w.why}` });
    else if (w.where === "wild") elsewhere.push({ name: f.name, where: `out in the wild, last seen near ${w.place}`, on_mind });
    else elsewhere.push({ name: f.name, where: w.where === "forest" ? "out hunting" : w.where === "tavern" ? "in the tavern" : w.where === "shop" ? "at the shop" : "out in the fields", on_mind });
  }
  for (const v of await questVisitors(ctx)) about.push({ name: v.name, doing: v.step.cue, on_mind: "here about your quest", ...({ quest: v.quest } as Record<string, string>) });
  const people = await ctx.c.query<{ name: string; class: string; level: number }>(
    "select name, class, level from players where not is_bot and not is_test and id <> $1 and alive and pos_x is null and last_seen > now() - interval '15 minutes' order by last_seen desc limit 3", [ctx.p.id]);
  const v = visitorFor(ctx.day);
  const hour = realmHour(now);
  ctx.events.push({
    kind: "square",
    time_of_day: timeOfDayNow(),
    about,
    players_about: people.rows,
    elsewhere,
    visitor: v ? { name: v.name, description: v.description, talked_today: ctx.t.visitor_talked } : null,
    ...(lore().world ? { realm: lore().world } : {}),
  });
  await meetingsHere(ctx, "brightwater");
  await introQuest(ctx, "brightwater");
  await maybeJournal(ctx, "town");
}, { weather: true })));

// ---------- the forge (Ironhold) ----------

type ForgeTarget = { target: "weapon" | "armor" | number; slot: "weapon" | "armor"; item_id: number; rarity: number; row?: number };

/** Everything they could take to the forge: what they're wearing (not a caster's spell) and gear in the bag. */
async function forgeables(ctx: Ctx): Promise<ForgeTarget[]> {
  const out: ForgeTarget[] = [];
  if (ctx.p.weapon_id > 0 && !casts(ctx.p.class)) out.push({ target: "weapon", slot: "weapon", item_id: ctx.p.weapon_id, rarity: ctx.p.weapon_rarity ?? 0 });
  if (ctx.p.armor_id > 0) out.push({ target: "armor", slot: "armor", item_id: ctx.p.armor_id, rarity: ctx.p.armor_rarity ?? 0 });
  // Spells and instruments aren't the forge's business, whoever's carrying them.
  const magic = (x: { slot: string; item_id: number }) => x.slot === "weapon" && ["mage", "priest", "bard"].includes(String(familyOf("weapon", x.item_id)));
  for (const x of await Bag.contents(ctx.c, ctx.p.id)) if ((x.slot === "weapon" || x.slot === "armor") && !magic(x)) out.push({ target: x.id, slot: x.slot, item_id: x.item_id, rarity: x.rarity ?? 0, row: x.id });
  return out;
}
/** Married to Brannagh: the forge's gold costs a fifth less (the ore and gems are what they are). */
function forgeDeal<T extends { gold: number } | null>(ctx: Ctx, cost: T): T {
  return cost && spousePerk(ctx.spouse) === "forge" ? { ...cost, gold: Math.ceil(cost.gold * 0.8) } : cost;
}
async function forgeQuote(ctx: Ctx, f: ForgeTarget, ore: Record<number, number>) {
  const base = f.slot === "weapon" ? weapon(f.item_id) : armor(f.item_id);
  const baseName = f.row ? carriedName(f.slot, f.item_id) : itemName(f.slot, f.item_id, ctx.p.class);
  const stat = (r: number) => f.slot === "weapon" ? { power: boosted((base as { str: number }).str, r) } : { def: boosted((base as { def: number }).def, r) };
  const cost = forgeDeal(ctx, forgeCost(base.cost, f.rarity));
  const missing: string[] = [];
  if (cost) {
    if (ctx.p.gold + ctx.p.bank < cost.gold) missing.push(`${cost.gold - ctx.p.gold - ctx.p.bank} more gold`);
    for (const [o, n] of Object.entries(cost.ore)) if ((ore[Number(o)] ?? 0) < (n ?? 0)) missing.push(`${(n ?? 0) - (ore[Number(o)] ?? 0)} more ${oreOf(Number(o)).name}`);
    if (ctx.p.gems < cost.gems) missing.push(`${cost.gems - ctx.p.gems} more gems`);
  }
  return {
    target: f.target, worn: typeof f.target === "string", item: withRarity(baseName, f.rarity), rarity: rarity(f.rarity).name, ...stat(f.rarity),
    ...(cost ? {
      next: { rarity: RARITY[f.rarity + 1].name, ...stat(f.rarity + 1), item: withRarity(baseName, f.rarity + 1) },
      cost: { gold: cost.gold, ore: Object.entries(cost.ore).map(([o, n]) => `${n} ${oreOf(Number(o)).name}`), ...(cost.gems ? { gems: cost.gems } : {}) },
      can_forge: missing.length === 0, ...(missing.length ? { missing } : {}),
    } : { at_the_top: "Mythic is as far as any forge can take it" }),
  };
}
async function oreCounts(ctx: Ctx) {
  const ore: Record<number, number> = {};
  for (const x of await Bag.contents(ctx.c, ctx.p.id)) if (x.slot === "ore") ore[x.item_id] = (ore[x.item_id] ?? 0) + 1;
  return ore;
}

api.get("/forge", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  requireTown(ctx, "The forge", ["ironhold"]);
  const ore = await oreCounts(ctx);
  const pieces = [];
  for (const f of await forgeables(ctx)) pieces.push(await forgeQuote(ctx, f, ore));
  ctx.events.push({ kind: "forge", smith: "Brannagh Steel", pieces, have: { gold: ctx.p.gold, bank: ctx.p.bank, gems: ctx.p.gems, ore: Object.entries(ore).map(([o, n]) => `${n} ${oreOf(Number(o)).name}`) },
    tiers: RARITY.map((r) => ({ name: r.name, stat: `x${r.mult}` })), note: casts(ctx.p.class) ? "spells and instruments aren't the forge's business; armor can be forged" : undefined });
})));

api.post("/forge", async (c) => {
  const body = z.object({ target: z.union([z.literal("weapon"), z.literal("armor"), z.number().int()]), confirm: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    requireTown(ctx, "The forge", ["ironhold"]);
    await requireNoEncounter(ctx);
    const f = (await forgeables(ctx)).find((x) => x.target === body.target);
    if (!f) { ctx.events.push({ kind: "forge_refused", reason: body.target === "weapon" && casts(ctx.p.class) ? "a spell isn't something you can put on an anvil" : "you don't have that to forge" }); return; }
    const ore = await oreCounts(ctx);
    const q = await forgeQuote(ctx, f, ore);
    if (!("next" in q) || !q.next) { ctx.events.push({ kind: "forge_refused", reason: "it's already Mythic" }); return; }
    if (!q.can_forge) { ctx.events.push({ kind: "forge_refused", reason: "not enough to pay for it", missing: q.missing, quote: q }); return; }
    if (!body.confirm && !ctx.p.is_bot) {
      ctx.events.push({ kind: "forge_quote", ...q });
      ctx.hint = "A quote, nothing done yet: say what Brannagh will do to the piece, the stat it goes to, and the cost, then ask them to confirm (y/n). Call again with confirm: true only on a yes.";
      return;
    }
    const base = f.slot === "weapon" ? weapon(f.item_id) : armor(f.item_id);
    const cost = forgeDeal(ctx, forgeCost(base.cost, f.rarity))!;
    if (!(await payFrom(ctx, cost.gold))) { ctx.events.push({ kind: "forge_refused", reason: "not enough gold" }); return; }
    for (const [o, n] of Object.entries(cost.ore))
      await ctx.c.query("delete from inventory where id in (select id from inventory where player_id = $1 and slot = 'ore' and item_id = $2 order by id limit $3)", [ctx.p.id, Number(o), n]);
    if (cost.gems) await savePlayer(ctx, { gems: ctx.p.gems - cost.gems });
    const to = f.rarity + 1;
    if (f.row) await ctx.c.query("update inventory set rarity = $2 where id = $1", [f.row, to]);
    else await savePlayer(ctx, f.slot === "weapon" ? { weapon_rarity: to } : { armor_rarity: to });
    const made = withRarity(f.row ? carriedName(f.slot, f.item_id) : itemName(f.slot, f.item_id, ctx.p.class), to);
    ctx.events.push({ kind: "forged", ...q.next, item: made, from: q.item, rarity: RARITY[to].name, paid: q.cost, worn: !f.row });
    await logEvent(ctx, "forge", { slot: f.slot, item_id: f.item_id, to, gold: cost.gold });
    if (to >= 3) await post(ctx, "forged", ctx.p.name, null, { item: made });
  }));
});

// ---------- other towns ----------

/** What waits on the road below a town's walls the first time. Tough for level 5, a real fight at 6, safe by 7 (simulated). */
const GATE_GUARDS: Partial<Record<TownId, Monster>> = {
  ironhold: { name: "Old Grudge", level: 7, hp: 360, max_hp: 360, str: 70, def: 18, gold: 12000, exp: 9000 },
  ashford: { name: "Nan Silt", level: 7, hp: 340, max_hp: 340, str: 68, def: 17, gold: 11000, exp: 8500 },
  brightwater: { name: "Grey Hob", level: 7, hp: 360, max_hp: 360, str: 70, def: 18, gold: 12000, exp: 9000 },
};
const GATE_LINES: Partial<Record<TownId, { note: string; scene: string; hint: string }>> = {
  ironhold: { note: "the road to the gate runs under a broken bridge, and something lives there; it won't let anyone through who hasn't beaten it, and there's no running",
    scene: "the road below Ironhold's walls; Old Grudge, the troll under the broken bridge, comes up out of the gully",
    hint: "A set piece: they've reached the road below the town's walls, and Old Grudge, the troll under the broken bridge, comes up out of the gully. No running, no way round. Make it big, then the fight menu without (R)un." },
  ashford: { note: "the south road comes down to the river Ash at a wide stone ford below the town, and something has taken a toll at the crossing since before the walls went up; it won't let anyone cross who hasn't beaten it, and there's no running",
    scene: "Ashford's roofs and the Lamphouse tower across the river; Nan Silt, the river hag who keeps the ford, rises out of the shallows wanting her toll, riddling about it",
    hint: "A set piece: Ashford's roofs and the Lamphouse tower are across the river, and Nan Silt, the river hag who keeps the ford, rises out of the shallows wanting her toll, riddling about it. No running, no way round. Make it big, then the fight menu without (R)un." },
  brightwater: { note: "the old north road into Brightwater crosses a toll-bridge nobody has kept since the Siege, and something keeps it now; it won't let a stranger by until they've beaten it, and there's no running",
    scene: "Brightwater's roofs in sight; Grey Hob, the hobgoblin who keeps the old toll-bridge on the north road, steps out to collect",
    hint: "A set piece: Brightwater's roofs are in sight, and Grey Hob, the hobgoblin who keeps the old toll-bridge on the north road, steps out to collect. No running, no way round. Make it big, then the fight menu without (R)un." },
};
/** Where someone returns to and wakes up: their start town's tile (Brightwater is 0, 0). */
function homeTile(p: Player): { x: number; y: number } {
  const t = p.start_town && p.start_town !== "brightwater" ? TOWN_TILES[p.start_town as keyof typeof TOWN_TILES] : null;
  return t ? { x: t.x, y: t.y } : { x: 0, y: 0 };
}
/** You're through once you've stood inside: the town tile is in your explored map. */
async function passedGate(ctx: Ctx, x: number, y: number): Promise<boolean> {
  const home = homeTile(ctx.p);
  if (home.x === x && home.y === y) return true;
  return Boolean((await ctx.c.query("select 1 from explored where player_id = $1 and x = $2 and y = $3", [ctx.p.id, x, y])).rowCount);
}
async function startGateFight(ctx: Ctx, town: TownId) {
  const g = GATE_GUARDS[town];
  if (!g) return;
  const m: Monster = { ...g };
  await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'gate',$2)", [ctx.p.id, m]);
  ctx.events.push({ kind: "gate_ambush", monster: m, town: town === "brightwater" ? "Brightwater" : TOWN_TILES[town as keyof typeof TOWN_TILES].name, note: GATE_LINES[town]!.note, scene: GATE_LINES[town]!.scene });
  ctx.hint = GATE_LINES[town]!.hint;
}

/** A hand-placed place out in the wild (the hill shrine): what it is, and what the town decided it should be, or that it's still deciding. */
async function atShrine(ctx: Ctx, t: Tile) {
  const p = placeAt(t.x, t.y);
  if (!p) return;
  let decided: string | null = null, deciding: { question: string; last_day: string } | null = null;
  if (p.meeting) {
    const m = (await ctx.c.query<Poll>("select id::int, question, options, closes::text, status, result from polls where id = $1", [p.meeting])).rows[0];
    if (m?.status === "closed" && m.result) decided = m.options.find((o) => o.id === m.result!.winner)?.label ?? null;
    else if (m) deciding = { question: m.question, last_day: m.closes };
  }
  ctx.events.push({ kind: "shrine", name: p.name, about: p.about ?? "", ...(decided ? { the_town_decided: decided } : {}), ...(deciding ? { the_town_is_deciding: deciding } : {}) });
}

/** Any town meeting open here: the question, its choices, whether this player has voted, and how many players have. Votes stay secret until it closes. */
async function meetingsHere(ctx: Ctx, town: TownId) {
  const polls = await openPolls(ctx.c, ctx.day, town);
  for (const p of polls) {
    const mine = (await ctx.c.query<{ choice: string }>("select choice from poll_votes where poll_id = $1 and player_id = $2", [p.id, ctx.p.id])).rows[0];
    const n = (await ctx.c.query<{ n: string }>("select count(*)::text n from poll_votes where poll_id = $1 and not townsfolk", [p.id])).rows[0].n;
    ctx.events.push({ kind: "town_meeting", id: p.id, question: p.question, about: p.about, options: p.options.map((o) => ({ id: o.id, label: o.label })),
      last_day: p.closes, players_voted: Number(n), ...(mine ? { your_vote: mine.choice } : {}), ...(ctx.p.level < VOTE_MIN_LEVEL ? { can_vote_from_level: VOTE_MIN_LEVEL } : {}) });
  }
}

/** What's in a town away from Brightwater, and who's about: its fixed characters, the townsfolk who live there, players seen lately. */
async function townView(ctx: Ctx, id: TownId) {
  const town = TOWN_INFO[id]!;
  const at = TOWN_TILES[id as keyof typeof TOWN_TILES];
  const folk = (await ctx.c.query<{ name: string; class: string; level: number; mind: Mind | null; personality: Personality }>(
    `select p.name, p.class, p.level, b.mind, b.personality from players p join bots b on b.player_id = p.id
     where p.pos_x = $1 and p.pos_y = $2 and p.alive and p.cave_depth is null order by p.name`, [at.x, at.y])).rows;
  const players = (await ctx.c.query<{ name: string; class: string; level: number }>(
    `select name, class, level from players where role = 'player' and not is_test and id <> $3 and alive and pos_x = $1 and pos_y = $2
     and last_seen > now() - interval '30 minutes' order by last_seen desc limit 3`, [at.x, at.y, ctx.p.id])).rows;
  return {
    kind: "town", town: town.name, blurb: town.blurb, time_of_day: timeOfDayNow(),
    people: town.people.map((p) => ({ ...p, ...looksOf(p.name) })),
    townsfolk_here: folk.map((f) => ({ name: f.name, class: f.class, level: f.level, ...(f.mind?.goal ? { on_mind: goalLabel(f.name, f.personality, f.mind.goal) } : {}), ...looksOf(f.name) })),
    players_here: players,
    tavern: town.tavern, services: town.services,
    masters: town.trains === "shadow"
      ? (ctx.p.path === "shadow" ? "the Undercroft: masters for those on the Shadow path" : "the Undercroft teaches only those on the Shadow path; Brightwater's masters teach everyone")
      : (casts(ctx.p.class) ? "the training yard teaches only those who fight with steel; magic is taught in Brightwater" : "the training yard: masters for those who fight with steel"),
  };
}

/** Walking in through the gate. The first player ever to find the town makes the news (the discovery is recorded where they stepped in). */
async function arriveInTown(ctx: Ctx, t: Tile) {
  const id = townAt(t.x, t.y)!;
  ctx.events.push(await townView(ctx, id));
  await meetingsHere(ctx, id);
  await maybeJournal(ctx, id === "ashford" ? "ashford" : "ironhold");
  ctx.hint = `They're inside ${t.name}'s walls. Describe it from \`blurb\` and who's about, then its menu. There's no hunting inside the walls.`;
}

/** The town you're standing in, if it isn't Brightwater (whose square is /square). Generic on purpose: the plugin never names towns players haven't found. */
api.get("/town", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const here = townAt(ctx.p.pos_x, ctx.p.pos_y);
  if (!here || here === "brightwater") { ctx.events.push({ kind: "no_town_here", note: here === "brightwater" ? "this is Brightwater; use square" : "there's no town here" }); return; }
  ctx.events.push(await townView(ctx, here));
  await meetingsHere(ctx, here);
  await introQuest(ctx, here);
  await maybeJournal(ctx, here === "ashford" ? "ashford" : "ironhold");
}, { weather: true })));

/** Facts behind a rumor, straight from the realm. Null when there's nothing to tell. */
async function rumorFacts(ctx: Ctx, kind: Rumor): Promise<Record<string, unknown> | null> {
  const one = async <T,>(sql: string, args: unknown[] = []) => (await ctx.c.query<T & Record<string, unknown>>(sql, args)).rows[0] ?? null;
  switch (kind) {
    case "next_bard": {
      const d = new Date(ctx.day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
      return { bard: bardFor(d.toISOString().slice(0, 10)).name, when: "tomorrow" };
    }
    case "top_player": return one("select name, class, level from players where role <> 'npc' and not is_test order by level desc, exp desc limit 1");
    case "forest_danger": {
      const m = await one<{ monster: string; n: string }>(
        "select detail->>'monster' as monster, count(*)::text as n from news where kind = 'forest_death' and ts > now() - interval '2 days' group by 1 order by count(*) desc limit 1");
      return m ? { monster: m.monster, deaths: Number(m.n), recently: true } : null;
    }
    case "heavy_purse": return one(
      "select name, level from players where role <> 'npc' and not is_test and alive and location = 'fields' and gold > 0 and id <> $1 and created_at < now() - interval '24 hours' order by gold desc limit 1", [ctx.p.id]);
    case "recent_loot": return one("select actor as name, detail->>'item' as item, detail->>'monster' as monster from news where kind = 'loot' order by id desc limit 1");
    case "newest_arrival": return one("select actor as name from news where kind = 'join' order by id desc limit 1");
    case "dragon": {
      const last = await one<{ name: string }>("select actor as name from news where kind = 'dragon' order by id desc limit 1");
      return { alive: ctx.dragonAlive, last_slayer: last?.name ?? null };
    }
  }
}

/** How many notes of what you said each person keeps, and how long a note can be. */
export const NOTES_KEPT = 5;
export const NOTE_MAX = 100;

/** "yesterday", "3 days ago": how long since a day, said the way a person would. */
export function sinceDay(today: string, day: string): string {
  const n = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) / 86_400_000);
  return n <= 0 ? "earlier today" : n === 1 ? "yesterday" : n < 7 ? `${n} days ago` : n < 14 ? "last week" : n < 45 ? `${Math.round(n / 7)} weeks ago` : "a long while back";
}

/** What someone remembers of this player: when they met, how often they've talked, what the player said, gifts kept, quests done together. Null on a first meeting. */
/** How a townsperson or character feels about this player, by name. Stranger if there's no such person. */
async function feels(ctx: Ctx, name: string | null): Promise<{ word: Standing; points: number } | null> {
  if (!name || ctx.p.role !== "player") return null;
  const who = (await ctx.c.query<{ id: string; name: string }>("select id, name from players where lower(name) = lower($1) and role in ('townsfolk', 'npc')", [name])).rows[0];
  return who ? standingWith(ctx.c, ctx.p, who, ctx.day) : null;
}

/** What a shopkeeper's liking takes off: nothing unless they're friendly or better. */
async function friendCut(ctx: Ctx, keeper: string | null): Promise<{ cut: number; keeper?: string; feels?: Standing }> {
  const f = await feels(ctx, keeper);
  const cut = f ? PRICE_CUT[f.word] ?? 0 : 0;
  return cut ? { cut, keeper: keeper!, feels: f!.word } : { cut: 0 };
}

async function recall(ctx: Ctx, whoId: string, name: string) {
  const m = (await ctx.c.query<{ first_met: string; last_talk: string; talks: number; notes: { day: string; line: string }[] }>(
    "select first_met::text, last_talk::text, talks, notes from npc_memory where player_id = $1 and npc = $2", [ctx.p.id, name])).rows[0];
  const gifts = (await ctx.c.query<{ gold: number; gems: number; slot: string | null; item_id: number | null; rarity: number; sent_day: string }>(
    "select gold, gems, slot, item_id, rarity, sent_day::text from gifts where from_player = $1 and to_player = $2 and state = 'kept' order by id desc limit 3", [ctx.p.id, whoId])).rows;
  const mine = (await ctx.c.query<{ quest: string; status: string; outcome: string | null }>(
    "select quest, status, outcome from quests where player_id = $1 and status in ('active', 'done')", [ctx.p.id])).rows;
  const quests = mine.map((q) => ({ q, def: questById(q.quest) })).filter(({ def }) => def && (def.start_on?.talk.includes(name) || def.steps.some((st) => st.on && "talk" in st.on && Array.isArray(st.on.talk) && st.on.talk.includes(name))))
    .map(({ q, def }) => ({ quest: def!.title, ...(q.status === "done" ? { how_it_ended: q.outcome } : { still_going: true }) }));
  if (!m && !gifts.length) return null;
  return {
    ...(m ? { first_met: sinceDay(ctx.day, m.first_met), times_talked: m.talks, last_time: sinceDay(ctx.day, m.last_talk) } : {}),
    ...(m?.notes.length ? { you_said: m.notes.map((n) => ({ when: sinceDay(ctx.day, n.day), line: n.line })) } : {}),
    ...(gifts.length ? { gifts_from_you: gifts.map((g) => ({ when: sinceDay(ctx.day, g.sent_day), gold: g.gold || undefined, gems: g.gems || undefined,
      item: g.slot && g.item_id !== null ? Bag.item(g.slot as Bag.Slot, g.item_id, g.rarity).name : undefined })) } : {}),
    ...(quests.length ? { quests_together: quests } : {}),
  };
}

/** Count the talk and keep a note of what the player said: one plain line per person per day (a later talk that day replaces it), the newest few days. */
async function remember(ctx: Ctx, name: string, again: boolean, said?: string) {
  const line = said ? cleanText(said).slice(0, NOTE_MAX).trim() : "";
  const note = line ? JSON.stringify([{ day: ctx.day, line }]) : "[]";
  await ctx.c.query(
    `insert into npc_memory (player_id, npc, first_met, last_talk, talks, notes) values ($1, $2, $3, $3, 1, $4::jsonb)
     on conflict (player_id, npc) do update set last_talk = $3, talks = npc_memory.talks + $5,
       notes = (select coalesce(jsonb_agg(x order by i), '[]'::jsonb) from (
         select x, i from jsonb_array_elements(
           case when $4::jsonb = '[]'::jsonb then npc_memory.notes
                else coalesce((select jsonb_agg(o order by n) from jsonb_array_elements(npc_memory.notes) with ordinality e(o, n) where o->>'day' <> $3::text), '[]'::jsonb) || $4::jsonb end
         ) with ordinality as t(x, i)
         order by i desc limit $6) k)`,
    [ctx.p.id, name, ctx.day, note, again ? 0 : 1, NOTES_KEPT]);
}

/**
 * Talk to someone who's about: a townsperson in the square, the tavern or the same spot in the wild,
 * or one of the fixed characters where they keep. The narrator plays the conversation. Now and then
 * (at most once a day) they let slip a place someone found, and it's marked on your map.
 */
api.post("/talk", async (c) => {
  const body = z.object({ to: z.string().trim().min(1).max(40), said: z.string().max(300).optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    // A stranger in town for this player's quest.
    const visitor = (await questVisitors(ctx)).find((v) => v.name.toLowerCase() === body.to.toLowerCase());
    if (visitor) {
      requireInTown(ctx, visitor.name);
      ctx.events.push({ kind: "talk", name: visitor.name, where: "the square", quest_visitor: true });
      await fireStep(ctx, questById(visitor.quest)!, visitor.row, visitor.step);
      return;
    }
    const r = await ctx.c.query<{ id: string; name: string; role: string; class: string; level: number; alive: boolean; pos_x: number | null; pos_y: number | null; location: "inn" | "fields"; personality: Personality | null; mind: Mind | null }>(
      `select p.id, p.name, p.role, p.class, p.level, p.alive, p.pos_x, p.pos_y, p.location, b.personality, b.mind
       from players p left join bots b on b.player_id = p.id where lower(p.name) = lower($1) and p.role in ('townsfolk', 'npc')`, [body.to]);
    const who = r.rows[0];
    if (!who) { ctx.events.push({ kind: "no_such_person", name: body.to, note: "only townsfolk and the realm's characters can be talked to this way; players get mail" }); return; }

    // Are they here?
    let where = "";
    if (who.role === "townsfolk") {
      if (inWild(ctx.p)) {
        if (who.pos_x !== ctx.p.pos_x || who.pos_y !== ctx.p.pos_y) { ctx.events.push({ kind: "not_around", name: who.name, where: "not out here" }); return; }
        where = "here in the wild";
      } else {
        const today = who.mind?.today?.day === ctx.day ? who.mind.today.sessions : undefined;
        const w = whereabouts(who.personality!, who.name, ctx.day, new Date(), who.alive, {
          sessions: today, away: awayToday(ctx.day, who.name, who.personality!),
          wild: who.pos_x === null ? null : tileAt(who.pos_x, who.pos_y!).name, sleeps: who.location,
        });
        if (!["square", "heading", "tavern"].includes(w.where)) {
          const said = w.where === "asleep" ? "asleep" : w.where === "dead" ? "dead until morning" : w.where === "away" ? `away for the day: ${w.why}` : w.where === "wild" ? "out in the wild" : w.where === "unseen" ? "nowhere to be seen" : `busy (${w.where})`;
          ctx.events.push({ kind: "not_around", name: who.name, where: said }); return;
        }
        where = w.where === "tavern" ? "the tavern" : "the square";
      }
    } else if (homeOf(who.name)) {
      const t = homeOf(who.name)!;
      if (townAt(ctx.p.pos_x, ctx.p.pos_y) !== t.id) { ctx.events.push({ kind: "not_around", name: who.name, where: "nowhere you can see" }); return; }
      where = t.people.find((x) => x.name === who.name)!.where;
    } else {
      requireInTown(ctx, who.name);
      const s = suitor(who.name);
      if (s && !available(s)) { ctx.events.push({ kind: "not_around", name: who.name, hours: s.hours ?? null, days: s.days ?? null }); return; }
      const bardNames = ["Fennick Reed", "Dunstan the Unfinished", "Corwin Lark", "Wren"];
      if (bardNames.includes(who.name) && bardFor(ctx.day).name !== who.name) { ctx.events.push({ kind: "not_around", name: who.name, where: "not playing tonight" }); return; }
      where = who.name === "Odile" ? "her workshop" : who.name === "Mother Quill" ? "the library" : who.name === "Prior Hale" ? "the chapel" : who.name === "Cass Marrow" ? "the auction house" : who.name === "Della Moss" ? "her clothier's on Market Row" : s ? s.where : "the tavern";
    }

    const talked = (ctx.t.talked ?? []) as string[];
    const again = talked.includes(who.name);
    if (!again) await saveTurns(ctx, { talked: [...talked, who.name] });

    // A little gossip, now and then: a place someone found, preferably one they found themselves.
    let gossip: Record<string, unknown> | null = null;
    // How they feel about the player, from everything between them so far (standing.ts).
    const stand = await standingWith(ctx.c, ctx.p, who, ctx.day);
    const cold = ctx.p.role === "player" && (stand.word === "hostile" || stand.word === "wary");
    if (!again && !cold && !ctx.t.gossip_heard && await luck(ctx, "gossip", 0.3)) {
      const ex = await exploredSet(ctx);
      const far = Math.max(2, ...[...ex].map((k) => { const [a, b] = k.split(",").map(Number); return Math.max(Math.abs(a), Math.abs(b)); }));
      const g = (await ctx.c.query<{ x: number; y: number; name: string; terrain: string; poi: string | null; found_by: string | null }>(
        `select d.x, d.y, d.name, d.terrain, d.poi, p.name as found_by
         from discoveries d left join players p on p.id = d.found_by
         where not exists (select 1 from explored e where e.player_id = $1 and e.x = d.x and e.y = d.y)
           and not exists (select 1 from rumors r where r.player_id = $1 and r.x = d.x and r.y = d.y)
           and greatest(abs(d.x), abs(d.y)) <= $2
         order by (d.found_by = $3) desc nulls last, (d.poi is not null) desc, random() limit 1`, [ctx.p.id, far + 3, who.id])).rows[0];
      if (g && await hearOf(ctx, g.x, g.y, who.name)) {
        await saveTurns(ctx, { gossip_heard: true });
        gossip = { place: g.name, terrain: g.terrain, poi: g.poi, where: directions(g.x, g.y), found_by: g.found_by, they_found_it: g.found_by === who.name };
        await logEvent(ctx, "gossip", { from: who.name, x: g.x, y: g.y, poi: g.poi });
      }
    }

    const mind = who.mind ?? {};
    // A piece of their past, now and then: the next one in order, at most one a day from each person.
    // Nobody tells anything to someone they hold a grudge against or are wary of; secrets go only to those they trust.
    let past: { piece: string; told: string; you_already_know?: string[] } | null = null;
    const pieces = lore().people[who.name]?.pieces ?? [];
    let heardPieces = 0;
    if (pieces.length) {
      const h = await heardOf(ctx.c, ctx.p.id, who.name, ctx.day);
      heardPieces = Math.min(h.n, pieces.length);
      const sore = mind.grudge?.name.toLowerCase() === ctx.p.name.toLowerCase();
      // A recent gift warms them a little toward telling you more (never enough to buy a secret on its own).
      const fond = (await ctx.c.query("select 1 from gifts where from_player = $1 and to_player = $2 and state = 'kept' and sent_day > $3::date - 7 limit 1", [ctx.p.id, who.id, ctx.day])).rowCount;
      const chance = pastChance(fond ? Math.min(0.75, PAST_CHANCE + 0.2) : PAST_CHANCE, stand.word, PIECE_NAMES[heardPieces] === "secret")
      if (!again && !sore && chance > 0 && heardPieces < pieces.length && !h.today && await luck(ctx, `past:${who.name}`, chance)) {
        await ctx.c.query("insert into player_lore (player_id, key, day, how) values ($1, $2, $3, 'talk') on conflict do nothing", [ctx.p.id, personKey(who.name, heardPieces), ctx.day]);
        past = { piece: PIECE_NAMES[heardPieces] ?? "more", told: pieces[heardPieces], ...(heardPieces ? { you_already_know: pieces.slice(0, heardPieces) } : {}) };
        heardPieces++;
        await logEvent(ctx, "past", { from: who.name, piece: heardPieces });
      }
    }
    const remembers = await recall(ctx, who.id, who.name);
    await remember(ctx, who.name, again, body.said);
    ctx.events.push({
      kind: "talk", name: who.name, where, again, ...looksOf(who.name), feels: stand.word,
      ...(remembers ? { remembers } : { first_meeting: true }),
      ...(who.role === "townsfolk" ? {
        townsfolk: true, class: who.class, level: who.level,
        ...(mind.goal && who.personality ? { on_mind: goalLabel(who.name, who.personality, mind.goal) } : {}),
        mood: (mind.mood ?? 0) > 0 ? "in good spirits" : (mind.mood ?? 0) < 0 ? "out of sorts" : "as usual",
        ...(mind.grudge?.name.toLowerCase() === ctx.p.name.toLowerCase() ? { grudge_against_you: true } : {}),
        ...(mind.done?.[0] ? { last_achievement: mind.done[0].line } : {}),
        ...(await (async () => {
          // Who they've been spending their evenings with, and who they've fallen out with: what anyone in town could see.
          const bonds = await bondsOf(who.name, ctx.day);
          const friends = bonds.filter((x) => warmBond(x.word)).slice(0, 3).map((x) => x.other);
          const foes = bonds.filter((x) => coldBond(x.word)).slice(0, 2).map((x) => x.other);
          return { ...(friends.length ? { friends } : {}), ...(foes.length ? { at_odds_with: foes } : {}) };
        })()),
      } : { character: true }),
      ...(gossip ? { gossip } : {}),
      ...(past ? { past } : heardPieces ? { you_know_of_their_past: pieces.slice(0, heardPieces) } : {}),
    });
    const pastHint = !past ? "" : past.piece === "secret"
      ? " They also tell you their secret (past.told), in their own words: it costs them something, they lower their voice, and it's plainly not for repeating."
      : ` Somewhere in it they let you in on a piece of their past (past.told), in their own words, only as much as fits the moment.`;
    ctx.hint = `Play ${who.name} in their own voice: a short exchange, in character, about whatever's on their mind. How they feel about the player (feels: ${stand.word}): ${HOW[stand.word]} Show it in how they act, never as a word or a number.${gossip ? " Somewhere in it they let slip the gossip, as an aside, not a quest; it's now marked on the player's map as a place they've heard of." : ""}${pastHint}${again ? " You've already talked today; keep it brief." : ""}${remembers ? " They remember the player (remembers): at most one callback, only if it fits, as they'd naturally bring it up; never list it." : ""}`;
    const before = ctx.hint;
    // Talking can move a quest along, or a townsperson might ask a favor.
    await questTriggers(ctx, { talk: { name: who.name, townsfolk: who.role === "townsfolk" } });
    if (!ctx.events.some((e) => e.kind === "quest") && !again) {
      for (const q of QUESTS) {
        const s = q.start_on;
        if (!s?.talk.includes(who.name)) continue;
        if (s.needs_secret && !(pieces.length > 0 && heardPieces >= pieces.length)) continue;
        if (s.needs_pieces && heardPieces < s.needs_pieces) continue;
        if (s.after) {
          const prior = (await ctx.c.query<{ outcome: string | null }>("select outcome from quests where player_id = $1 and quest = $2 and status = 'done'", [ctx.p.id, s.after.quest])).rows[0];
          if (!prior || (s.after.outcomes && !s.after.outcomes.includes(prior.outcome ?? ""))) continue;
        }
        // What's on their mind right now can make them ask: Grimwald out looking for his boot asks about it.
        const onMind = s.on_goal && mind.goal?.kind === s.on_goal.kind;
        if (past && !onMind) continue;
        if (await luck(ctx, `quest:${q.id}`, onMind ? s.on_goal!.chance : s.chance) && await startQuest(ctx, q.id, false)) break;
      }
    }
    if (ctx.events.some((e) => e.kind === "quest")) ctx.hint = `${before} Then the quest moment, in the same conversation: tell its cue, and offer any choices numbered (1), (2)…; call \`quest\` with the choice id only when they pick.`;
  }));
});

/** The Cartographer's gift: a few places just past the edge of what you know, sketched into your map. A cave if one's near. */
async function sketchNearby(ctx: Ctx, from: string, n: number, around?: [number, number]) {
  const ex = await exploredSet(ctx);
  const heard = await heardSet(ctx);
  const far = Math.max(1, ...[...ex].map((k) => { const [a, b] = k.split(",").map(Number); return Math.max(Math.abs(a), Math.abs(b)); }));
  // From town: just past the edge of what they know. From a spot in the wild: the land within a few steps.
  const [cx, cy, reach] = around ? [around[0], around[1], 3] : [0, 0, far + 2];
  const pool: Tile[] = [];
  for (let yy = cy - reach; yy <= cy + reach; yy++) for (let xx = cx - reach; xx <= cx + reach; xx++) {
    if (!xx && !yy) continue;
    const k = `${xx},${yy}`;
    if (ex.has(k) || heard.has(k)) continue;
    pool.push(tileAt(xx, yy));
  }
  const dist = (t: Tile) => around ? Math.abs(t.x - cx) + Math.abs(t.y - cy) : t.ring;
  pool.sort((a, z) => (a.poi ? -10 : 0) - (z.poi ? -10 : 0) || dist(a) - dist(z) || Math.random() - 0.5);
  const out: { name: string; terrain: string; poi: string | null; where: string }[] = [];
  for (const t of pool) {
    if (out.length >= n) break;
    if (await hearOf(ctx, t.x, t.y, from)) out.push({ name: t.name, terrain: t.terrain, poi: t.poi, where: directions(t.x, t.y) });
  }
  return out;
}

/** One chat a day with the day's visitor: a rumor built on real facts, and sometimes a small gift. */
api.post("/square/talk", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
    requireInTown(ctx, "the town square");
  await requireNoEncounter(ctx);
  const v = visitorFor(ctx.day);
  if (!v) { ctx.events.push({ kind: "no_visitor" }); return; }
  if (ctx.t.visitor_talked) { ctx.events.push({ kind: "visitor_already", visitor: v.name }); return; }
  let rumor: { kind: Rumor; facts: Record<string, unknown> } | null = null;
  for (const k of v.rumors) { const f = await rumorFacts(ctx, k); if (f) { rumor = { kind: k, facts: f }; break; } }
  let gift = pickVisitorGift(v);
  const lucky = gift === "nothing" && charmLucky(charmOf(ctx.p));
  if (lucky) gift = pickVisitorGift(v);
  if (gift === "heal" && ctx.p.hp >= ctx.p.max_hp) gift = "charm";
  let amount = 0;
  const turns: Partial<Turns> = { visitor_talked: true };
  if (gift === "gold") { amount = 15 * ctx.p.level; await savePlayer(ctx, { gold: ctx.p.gold + amount }); }
  if (gift === "charm") { amount = 1; await savePlayer(ctx, { charm: ctx.p.charm + 1 }); }
  if (gift === "heal") { amount = ctx.p.max_hp - ctx.p.hp; await savePlayer(ctx, { hp: ctx.p.max_hp }); }
  if (gift === "fight") { amount = 1; turns.forest_fights = ctx.t.forest_fights + 1; }
  let sketched: { name: string; terrain: string; poi: string | null; where: string }[] = [];
  if (gift === "map") {
    sketched = await sketchNearby(ctx, v.name, 3);
    amount = sketched.length;
    if (!amount) gift = "nothing";
  }
  await saveTurns(ctx, turns);
  ctx.events.push({ kind: "visitor_talk", visitor: v.name, description: v.description, rumor, gift, amount, ...(sketched.length ? { sketched } : {}), ...(lucky ? { charm_luck: true } : {}) });
  ctx.hint = `Play ${v.name} in their own voice: a short exchange, then the rumor told as gossip using only the facts given, then the gift (if any) as something they do. Two to five sentences.`;
  await logEvent(ctx, "visitor", { visitor: v.name, rumor: rumor?.kind ?? null, gift, amount });
}, { weather: true })));

// One song a day from whichever bard is playing. The server picks the gift; the narrator writes the song.
api.post("/bard", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
    requireInTown(ctx, "the tavern");
  await requireNoEncounter(ctx);
  const bard = bardFor(ctx.day);
  if (ctx.t.bard_heard) { ctx.events.push({ kind: "bard_already", bard: bard.name }); return; }
  let gift = pickGift(bard);
  const lucky = gift === "nothing" && charmLucky(charmOf(ctx.p));
  if (lucky) gift = pickGift(bard);
  if (gift === "heal" && ctx.p.hp >= ctx.p.max_hp) gift = "charm"; // nothing to mend; he flatters you instead
  let amount = 0;
  const turns: Partial<Turns> = { bard_heard: true };
  if (gift === "gold") { amount = 25 * ctx.p.level; await savePlayer(ctx, { gold: ctx.p.gold + amount }); }
  if (gift === "charm") { amount = 1; await savePlayer(ctx, { charm: ctx.p.charm + 1 }); }
  if (gift === "gem") { amount = 1; await savePlayer(ctx, { gems: ctx.p.gems + 1 }); }
  if (gift === "heal") { amount = ctx.p.max_hp - ctx.p.hp; await savePlayer(ctx, { hp: ctx.p.max_hp }); }
  if (gift === "fight") { amount = bard.fights; turns.forest_fights = ctx.t.forest_fights + bard.fights; }
  await saveTurns(ctx, turns);
  // Material for the song: the listener, one recent headline, and (in state) tonight's weather.
  const n = await ctx.c.query<{ kind: string; actor: string | null; target: string | null; detail: Record<string, unknown> }>(
    "select kind, actor, target, detail from news order by id desc limit 15");
  const headline = n.rowCount ? n.rows[roll(n.rowCount - 1)] : null;
  const you = { name: ctx.p.name, class: ctx.p.class, level: ctx.p.level, exp: ctx.p.exp, weapon: weaponName(ctx.p.class, ctx.p.weapon_id), armor: armorName(ctx.p.class, ctx.p.armor_id), gold: ctx.p.gold, charm: ctx.p.charm };
  ctx.events.push({ kind: "song", bard: bard.name, style: bard.style, leans_toward: bard.sings_about, you, headline, gift, amount, ...(lucky ? { charm_luck: true } : {}) });
  await questTriggers(ctx, { song: true });
  await logEvent(ctx, "song", { bard: bard.name, gift, amount });
  ctx.hint = `Write the song: exactly four lines of original lyrics in ${bard.name}'s voice, printed one per line in italics, using at least one real detail from you/headline/weather. Print the lyrics themselves; don't summarize or describe the song. Then the gift.`;
}, { weather: true })));

/** What the room is like for a set, by the player's own clock: evenings are full, mornings are a few early drinkers. */
/** Tips as a share of a fight's gold at the bard's level. Tuned in the simulator (TIPS=): any steady income gets a bard to the next gear tier sooner, so this stays small. */
export const TIPS = 0.75;
const CROWD: Record<string, { mult: number; room: string }> = {
  "early morning": { mult: 0.5, room: "a few early drinkers and whoever's mopping" },
  morning: { mult: 0.6, room: "a quiet room, breakfast and hangovers" },
  afternoon: { mult: 0.85, room: "a half-full room, traders and the idle" },
  evening: { mult: 1.3, room: "a full house" },
  night: { mult: 1.05, room: "the late crowd, loud and generous" },
};

/**
 * A bard's set: once a day, in a tavern, for tips (a Sonnet, written by the narrator). Tips run about three-quarters of a fight's
 * gold at the bard's level, more in the evening, with a better instrument, and with charm.
 */
const ASHFORD_TIPS = 1.2;
api.post("/perform", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  const town = requireTown(ctx, "the tavern", ALL_TOWNS);
  await requireNoEncounter(ctx);
  if (ctx.p.class !== "bard") { ctx.events.push({ kind: "not_for_you", reason: "only bards play for the room" }); return; }
  if (ctx.t.performed) { ctx.events.push({ kind: "performed_already" }); return; }
  const tod = timeOfDayNow();
  const crowd = CROWD[tod] ?? CROWD.afternoon;
  const fightGold = GAME.monsters.filter((m) => m.level === ctx.p.level);
  const per = fightGold.length ? fightGold.reduce((n, m) => n + m.gold, 0) / fightGold.length : 25 * ctx.p.level;
  const kit = 0.7 + 0.3 * Math.min(1, ctx.p.weapon_id / Math.max(1, ctx.p.level));
  const charm = 1 + Math.min(100, charmOf(ctx.p)) / 200;
  const luck = 0.7 + roll(60) / 100;
  // Ashford's Ford House is where the money drinks: the Exchange tips better than anywhere.
  const purse = town === "ashford" ? ASHFORD_TIPS : 1;
  const tips = Math.max(1, Math.round(per * TIPS * crowd.mult * kit * charm * luck * purse));
  const won = roll(99) < 25;
  await savePlayer(ctx, { gold: ctx.p.gold + tips, ...(won ? { charm: ctx.p.charm + 1 } : {}) });
  await saveTurns(ctx, { performed: true });
  const n = await ctx.c.query<{ kind: string; actor: string | null; target: string | null; detail: Record<string, unknown> }>(
    "select kind, actor, target, detail from news order by id desc limit 15");
  const headline = n.rowCount ? n.rows[roll(n.rowCount - 1)] : null;
  ctx.events.push({
    kind: "performed", form: "Sonnet", instrument: weaponName(ctx.p.class, ctx.p.weapon_id), tavern: town === "brightwater" ? "the tavern" : TOWN_INFO[town]!.tavern,
    town: town === "brightwater" ? "Brightwater" : TOWN_INFO[town]!.name, time_of_day: tod, room: crowd.room, tips, ...(won ? { charm: 1 } : {}), headline,
    reception: luck > 1.15 ? "they want another" : luck < 0.85 ? "polite" : "warm",
  });
  await logEvent(ctx, "perform", { tips, tod, tier: ctx.p.weapon_id });
  ctx.hint = "Write the set: a sonnet of fourteen original lines (three quatrains and a couplet, rhymed ABAB CDCD EFEF GG) in the player's voice, on the instrument named, drawing on the room, the headline or the weather. Print the lines themselves, in italics. Then one line on how it lands (reception) and the tips.";
}, { weather: true })));

api.post("/tavern", async (c) => {
  const body = z.object({ body: z.string().trim().min(1).max(280).transform(cleanText).pipe(z.string().min(1)) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const town = requireTown(ctx, "the tavern", ALL_TOWNS);
    if (!seasoned(ctx, "post in the tavern")) return;
    if (ctx.t.tavern_posts >= GAME.tavernPostsPerDay) { ctx.events.push({ kind: "tavern_quiet", reason: "you've said enough for one day" }); return; }
    await ctx.c.query("insert into tavern (day, author, body, town) values ($1,$2,$3,$4)", [ctx.day, ctx.p.name, body.body, town]);
    await saveTurns(ctx, { tavern_posts: ctx.t.tavern_posts + 1 });
    ctx.events.push({ kind: "posted", posts_left: GAME.tavernPostsPerDay - ctx.t.tavern_posts });
  }));
});

api.post("/flirt", async (c) => {
  const body = z.object({ with: z.string().trim().max(40).optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const town = requireTown(ctx, "Everyone you might court", ALL_TOWNS);
    const local = SUITORS.filter((x) => townOfSuitor(x) === town);
    const who = body.with ? suitor(body.with) : (local.find((x) => available(x)) ?? local[0]);
    if (!who) { ctx.events.push({ kind: "no_such_suitor", name: body.with, here: local.map((x) => x.name) }); return; }
    // You court someone where they live.
    if (townOfSuitor(who) !== town) { ctx.events.push({ kind: "not_here", name: who.name, reason: "they live in another town", here: local.map((x) => x.name) }); return; }
    if (!available(who)) {
      ctx.events.push({ kind: "not_around", name: who.name, hours: who.hours ?? null, days: who.days ?? null });
      return;
    }
    if (ctx.t.flirted) { ctx.events.push({ kind: "already_flirted" }); return; }
    await saveTurns(ctx, { flirted: true });
    const row = (await ctx.c.query<{ id: string }>("select id from players where role = 'npc' and name = $1", [who.name])).rows[0];
    // Already theirs: no second wedding, just a good evening together.
    if (row && ctx.p.spouse_id === row.id) {
      await savePlayer(ctx, { charm: ctx.p.charm + 1 });
      ctx.events.push({ kind: "flirt", with: who.name, outcome: "spouse", charm_delta: 1, charm: ctx.p.charm });
      return;
    }
    // Townsfolk court and marry too, so Sir Pomfrey can win your spouse away, but their charm counts for at most 20
    // here (about a 5% chance a night), so a local steals a heart now and then rather than every other day.
    const flirtCharm = ctx.p.role === "player" ? charmOf(ctx.p) : Math.min(charmOf(ctx.p), 20);
    const { outcome, delta } = flirtOutcome(flirtCharm, who.coy, await luck(ctx, `wed:${who.name}`, weddingChance(flirtCharm, who.coy)));
    let stoleFrom: string | null = null;
    let left: string | null = null;
    if (outcome === "married" && row) {
      // Each of them is married to one person at a time. Winning a heart takes it from whoever had it.
      const prev = await ctx.c.query<{ id: string; name: string }>("select id, name from players where spouse_id = $1 for update", [row.id]);
      if (prev.rowCount && prev.rows[0].id !== ctx.p.id) {
        stoleFrom = prev.rows[0].name;
        await ctx.c.query("update players set spouse_id = null where id = $1", [prev.rows[0].id]);
        await ctx.c.query("insert into mailbox (player_id, event) values ($1, $2)", [prev.rows[0].id, { kind: "spouse_stolen", spouse: who.name, by: ctx.p.name }]);
      }
      // And you can only be married to one of them: a new wedding means leaving the old spouse.
      if (ctx.p.spouse_id && ctx.p.spouse_id !== row.id) { left = ctx.spouse; await savePlayer(ctx, { spouse_id: null }); }
      await savePlayer(ctx, { spouse_id: row.id });
      ctx.spouse = who.name;
      await post(ctx, "married", ctx.p.name, who.name, { ...(stoleFrom ? { stole_from: stoleFrom } : {}), ...(left ? { left } : {}) });
      await logEvent(ctx, "married", { spouse: who.name, stole: Boolean(stoleFrom), left: Boolean(left) });
    }
    await savePlayer(ctx, { charm: ctx.p.charm + delta });
    ctx.events.push({ kind: "flirt", with: who.name, pronouns: who.pronouns, outcome, charm_delta: delta, charm: ctx.p.charm,
      ...(stoleFrom ? { stole_from: stoleFrom } : {}), ...(left ? { left } : {}),
      ...(outcome === "married" ? { perk: who.perkText } : {}) });
  }));
});

// ---------- bag ----------

api.get("/bag", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  ctx.events.push({ kind: "bag", ...(await Bag.describe(ctx.c, ctx.p)) });
})));

async function ownRow(ctx: Ctx, id: number): Promise<Bag.Carried> {
  const items = await Bag.contents(ctx.c, ctx.p.id);
  const row = items.find((x) => x.id === id);
  if (!row) throw new GameError("not_in_bag", "that isn't in your bag");
  return row;
}

/** Equip from the bag (by id) or straight off the ground. Whatever you had goes into the bag. */
api.post("/equip", async (c) => {
  const body = z.union([z.object({ id: z.number().int() }), z.object({ ground: z.literal(true) })]).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    let slot: Bag.Slot; let itemId: number; let rowId: number | null = null; let rar = 0;
    if ("ground" in body) {
      if (!ctx.p.ground) { ctx.events.push({ kind: "nothing_on_ground" }); return; }
      slot = ctx.p.ground.slot; itemId = ctx.p.ground.item_id; rar = ctx.p.ground.rarity ?? 0;
    } else {
      const row = await ownRow(ctx, body.id); slot = row.slot; itemId = row.item_id; rowId = row.id; rar = row.rarity ?? 0;
    }
    // Only your own family: a bard can't play a sword, a warrior can't wear robes.
    if ((slot === "weapon" || slot === "armor") && !fits(slot, itemId, ctx.p.class)) {
      ctx.events.push({ kind: "cannot_equip", item: Bag.item(slot, itemId, rar).name, reason: `only ${familyUsers(slot, itemId)} can use it; you could sell it, put it up at auction, or send it to someone who can` });
      return;
    }
    // A caster learns a scroll's spell; the scroll's rarity doesn't carry into the spell.
    if (slot === "weapon" && casts(ctx.p.class)) rar = 0;
    const oldRar = slot === "weapon" ? ctx.p.weapon_rarity ?? 0 : slot === "armor" ? ctx.p.armor_rarity ?? 0 : 0;
    if (slot === "ore") { ctx.events.push({ kind: "cannot_equip", reason: "ore is for selling or for Odile to work" }); return; }
    if (slot === "quest") { ctx.events.push({ kind: "cannot_equip", reason: "it isn't something you wear; it belongs to a story" }); return; }
    if (slot === "herb") { ctx.events.push({ kind: "cannot_equip", reason: "herbs are for brewing at a healer's bench, or for selling" }); return; }
    if (slot === "potion") { ctx.events.push({ kind: "cannot_equip", reason: "you drink a potion, you don't wear it" }); return; }
    const oldWorn = slot === "weapon" ? ctx.p.weapon_id : slot === "armor" ? ctx.p.armor_id : ctx.p.trinket_id;
    // What comes off goes in the bag as its own family's piece.
    const oldId = (slot === "weapon" || slot === "armor") && oldWorn > 0 ? carriedId(slot, ctx.p.class, oldWorn) : oldWorn;
    const usedNow = await Bag.used(ctx.c, ctx.p.id);
    const after = usedNow - (rowId !== null ? Bag.item(slot, itemId).weight : 0) + (oldId > 0 ? Bag.item(slot, oldId).weight : 0);
    const cap = Bag.bag(ctx.p.bag_id).capacity;
    if (after > cap) { ctx.events.push({ kind: "bag_full", need: after - cap, holding: Bag.item(slot, oldId).name }); return; }
    if (rowId !== null) await ctx.c.query("delete from inventory where id = $1", [rowId]);
    if (oldId > 0) await ctx.c.query("insert into inventory (player_id, slot, item_id, rarity) values ($1,$2,$3,$4)", [ctx.p.id, slot, oldId, oldRar]);
    await savePlayer(ctx, { ...(slot === "weapon" ? { weapon_id: tierOf(itemId), weapon_rarity: rar } : slot === "armor" ? { armor_id: tierOf(itemId), armor_rarity: rar } : { trinket_id: itemId }), ...("ground" in body ? { ground: null } : {}) });
    const label = (id: number, r: number) => slot === "weapon" && casts(ctx.p.class) ? weaponName(ctx.p.class, tierOf(id)) : Bag.item(slot, id, r).name;
    ctx.events.push({ kind: "equipped", slot: slot === "weapon" && casts(ctx.p.class) ? "spell" : slot, item: label(itemId, rar), ...(slot === "weapon" && casts(ctx.p.class) ? { learned_from_scroll: true } : {}), stowed: oldId > 0 ? label(oldId, oldRar) : null });
  }));
});

api.post("/take", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  if (!ctx.p.ground) { ctx.events.push({ kind: "nothing_on_ground" }); return; }
  const g = ctx.p.ground;
  const w = Bag.item(g.slot, g.item_id).weight;
  const usedNow = await Bag.used(ctx.c, ctx.p.id);
  const cap = Bag.bag(ctx.p.bag_id).capacity;
  if (usedNow + w > cap) { ctx.events.push({ kind: "bag_full", need: usedNow + w - cap }); return; }
  await ctx.c.query("insert into inventory (player_id, slot, item_id, rarity) values ($1,$2,$3,$4)", [ctx.p.id, g.slot, g.item_id, g.rarity ?? 0]);
  await savePlayer(ctx, { ground: null });
  ctx.events.push({ kind: "taken", item: Bag.item(g.slot, g.item_id, g.rarity ?? 0).name, bag_used: usedNow + w, bag_capacity: cap });
})));

api.post("/sell", async (c) => {
  const body = z.object({ id: z.number().int() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const sellTown = requireTown(ctx, "someone to sell to", ALL_TOWNS);
    await requireNoEncounter(ctx);
    const row = await ownRow(ctx, body.id);
    const gold = Bag.sellPrice(row.slot, row.item_id, row.rarity);
    await ctx.c.query("delete from inventory where id = $1", [row.id]);
    if (!ctx.p.is_test) await toStorehouse(ctx.c, [row], sellTown);
    await savePlayer(ctx, { gold: ctx.p.gold + gold });
    ctx.events.push({ kind: "sold", item: Bag.item(row.slot, row.item_id, row.rarity).name, gold, ...(sellTown !== "brightwater" ? { to: TOWN_INFO[sellTown]!.buyer } : {}) });
    if (row.slot === "quest") await questItemGone(ctx, row.item_id, "sold");
  }));
});

api.post("/drop", async (c) => {
  const body = z.object({ id: z.number().int() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const row = await ownRow(ctx, body.id);
    await ctx.c.query("delete from inventory where id = $1", [row.id]);
    ctx.events.push({ kind: "dropped", item: Bag.item(row.slot, row.item_id, row.rarity).name });
    if (row.slot === "quest") await questItemGone(ctx, row.item_id, "dropped");
  }));
});

// ---------- mail ----------

api.post("/mail", async (c) => {
  const body = z.object({
    to: z.string().trim().min(1).max(40), body: z.string().trim().min(1).max(500).transform(cleanText).pipe(z.string().min(1)),
    // A gift by courier, optional: gold from the purse, gems, and/or one item from the bag (its bag id).
    gold: z.number().int().min(0).max(10_000_000).optional(), gems: z.number().int().min(0).max(1000).optional(), item: z.number().int().optional(),
    confirm: z.boolean().optional(),
  }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    if (!seasoned(ctx, "send mail")) return;
    if (ctx.t.messages_sent >= GAME.messagesPerDay) { ctx.events.push({ kind: "mail_limit", per_day: GAME.messagesPerDay }); return; }
    const r = await ctx.c.query<{ id: string; name: string; is_bot: boolean; role: string; is_test: boolean; trial: boolean; pos_x: number | null; pos_y: number | null; start_town: string | null; home: string | null; level: number }>(
      "select p.id, p.name, p.is_bot, p.role, p.is_test, p.trial, p.pos_x, p.pos_y, p.start_town, b.home, p.level from players p left join bots b on b.player_id = p.id where lower(p.name) = lower($1)", [body.to]);
    // Mail doesn't cross between test or trial characters and real ones.
    if (!r.rowCount || r.rows[0].trial || (r.rows[0].role === "player" && r.rows[0].is_test !== ctx.p.is_test)) { ctx.events.push({ kind: "no_such_player", name: body.to }); return; }
    const to = r.rows[0];
    if (to.id === ctx.p.id) { ctx.events.push({ kind: "mail_self" }); return; }
    // Nobody's mailbag takes more than this many letters a day, however many senders there are.
    const inbound = await ctx.c.query<{ n: string }>("select count(*)::text as n from messages where to_player = $1 and created_at > now() - interval '1 day'", [to.id]);
    if (Number(inbound.rows[0].n) >= GAME.messagesPerDay) { ctx.events.push({ kind: "mailbag_full", to: to.name }); return; }

    const gold = body.gold ?? 0, gems = body.gems ?? 0;
    const hasGift = gold > 0 || gems > 0 || body.item !== undefined;
    let gift: { gold: number; gems: number; slot: string | null; item_id: number | null; rarity: number; item_name: string | null; fee: number; worth: number; between: boolean; from_town: TownId; to_town: TownId } | null = null;
    if (hasGift) {
      requireAlive(ctx);
      await requireNoEncounter(ctx);
      // The courier works from a town, any town.
      const fromTown = requireTown(ctx, "the courier", ALL_TOWNS) as TownId;
      if (ctx.p.level < GIFT_MIN_LEVEL) { ctx.events.push({ kind: "too_new", what: "send gifts", needed_level: GIFT_MIN_LEVEL }); return; }
      if (to.role === "player" && to.is_test !== ctx.p.is_test) { ctx.events.push({ kind: "gift_refused", reason: "test characters and real ones can't send each other gifts" }); return; }
      const sentToday = (await ctx.c.query<{ gold: string; items: string }>(
        "select coalesce(sum(gold), 0)::text as gold, count(*) filter (where slot is not null)::text as items from gifts where from_player = $1 and sent_day = $2 and not returned", [ctx.p.id, ctx.day])).rows[0];
      const goldCap = GOLD_PER_LEVEL * ctx.p.level, goldLeft = Math.max(0, goldCap - Number(sentToday.gold));
      if (gold > goldLeft) { ctx.events.push({ kind: "gift_limit", what: "gold", per_day: goldCap, left_today: goldLeft }); return; }
      if (body.item !== undefined && Number(sentToday.items) >= ITEMS_PER_DAY) { ctx.events.push({ kind: "gift_limit", what: "items", per_day: ITEMS_PER_DAY, left_today: 0 }); return; }
      if (gems > ctx.p.gems) { ctx.events.push({ kind: "not_enough_gems", gems: ctx.p.gems }); return; }
      let slot: string | null = null, itemId: number | null = null, rar = 0, itemName: string | null = null, itemWorth = 0;
      if (body.item !== undefined) {
        const row = await ownRow(ctx, body.item);
        if (row.slot === "quest") { ctx.events.push({ kind: "gift_refused", reason: "that's not yours to send" }); return; }
        // Gear far beyond someone would carry them past the early climb (top-tier gear on day one halves it, in the simulator).
        if ((row.slot === "weapon" || row.slot === "armor") && to.role === "player" && tierOf(row.item_id) > to.level + GEAR_ABOVE_LEVEL) {
          ctx.events.push({ kind: "gift_refused", reason: "too fine for them yet", their_level: to.level, finest_you_can_send: to.level + GEAR_ABOVE_LEVEL }); return;
        }
        slot = row.slot; itemId = row.item_id; rar = row.rarity ?? 0; itemName = Bag.item(row.slot, row.item_id, rar).name; itemWorth = Bag.item(row.slot, row.item_id, rar).cost;
      }
      const toTown = to.role === "npc" ? townOfCharacter(to.name) : townOfPlayer(to, to.home);
      const worth = gold + gems * GEM_SELL * 2 + itemWorth;
      const between = toTown !== fromTown;
      gift = { gold, gems, slot, item_id: itemId, rarity: rar, item_name: itemName, fee: courierFee(worth, between), worth, between, from_town: fromTown, to_town: toTown };
      // Without confirm, the courier names the price and nothing moves. Townsfolk go straight through.
      if (!body.confirm && !ctx.p.is_bot) {
        ctx.events.push({ kind: "gift_quote", to: to.name, gold, gems, item: itemName, fee: gift.fee, total_gold: gold + gift.fee, purse: ctx.p.gold,
          ...(ctx.p.gold < gold + gift.fee ? { short_by: gold + gift.fee - ctx.p.gold } : {}), between_towns: between, to_town: townName(toTown), arrives: "next dawn", gold_left_today: goldLeft });
        return;
      }
      if (ctx.p.gold < gold + gift.fee) { ctx.events.push({ kind: "too_poor", cost: gold + gift.fee, gold: ctx.p.gold }); return; }
    }

    await saveTurns(ctx, { messages_sent: ctx.t.messages_sent + 1 });
    // If they've muted you, it looks sent from your side but never arrives (a gift comes back at dawn).
    const muted = await ctx.c.query("select 1 from mutes where player_id = $1 and muted_id = $2", [to.id, ctx.p.id]);
    const msg = muted.rowCount ? null : (await ctx.c.query<{ id: string }>("insert into messages (from_player, to_player, body) values ($1,$2,$3) returning id", [ctx.p.id, to.id, body.body])).rows[0];
    if (gift) {
      await savePlayer(ctx, { gold: ctx.p.gold - gift.gold - gift.fee, gems: ctx.p.gems - gift.gems });
      if (body.item !== undefined) await ctx.c.query("delete from inventory where id = $1 and player_id = $2", [body.item, ctx.p.id]);
      const arrives = nextDay(ctx.day);
      await ctx.c.query(
        `insert into gifts (message_id, from_player, to_player, gold, gems, slot, item_id, rarity, fee, sent_day, arrives_day, returned)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        muted.rowCount
          ? [null, to.id, ctx.p.id, gift.gold, gift.gems, gift.slot, gift.item_id, gift.rarity, gift.fee, ctx.day, arrives, true]
          : [msg!.id, ctx.p.id, to.id, gift.gold, gift.gems, gift.slot, gift.item_id, gift.rarity, gift.fee, ctx.day, arrives, false]);
      await logEvent(ctx, "gift", { to: to.name, role: to.role, gold: gift.gold, gems: gift.gems, item: gift.item_name, fee: gift.fee, worth: gift.worth });
      // A gift to someone you're courting warms things a little (once a day).
      if (SUITORS.some((x) => x.name === to.name) && !(await ctx.c.query("select 1 from gifts g join players t on t.id = g.to_player where g.from_player = $1 and g.sent_day = $2 and t.name = any($3::text[]) and g.message_id is distinct from $4", [ctx.p.id, ctx.day, SUITORS.map((x) => x.name), msg?.id ?? null])).rowCount) {
        await savePlayer(ctx, { charm: ctx.p.charm + 1 });
      }
    }
    ctx.events.push({ kind: "mail_sent", to: to.name, townsfolk: to.role === "townsfolk", character: to.role === "npc", sent_left: GAME.messagesPerDay - ctx.t.messages_sent,
      ...(gift ? { gift: { gold: gift.gold, gems: gift.gems, item: gift.item_name, fee: gift.fee, arrives: "next dawn", to_town: townName(gift.to_town) } } : {}) });
  }));
});

/** What's waiting for this player from the courier, and what they've sent that's still on the road. */
async function giftsFor(ctx: Ctx) {
  const rows = (await ctx.c.query<{ id: string; dir: string; other: string | null; gold: number; gems: number; slot: string | null; item_id: number | null; rarity: number; arrives_day: string; returned: boolean }>(
    `select g.id::text, case when g.to_player = $1 then 'in' else 'out' end as dir,
            case when g.to_player = $1 then f.name else t.name end as other,
            g.gold, g.gems, g.slot, g.item_id, g.rarity, g.arrives_day::text, g.returned
     from gifts g left join players f on f.id = g.from_player join players t on t.id = g.to_player
     where g.state = 'sent' and (g.to_player = $1 or (g.from_player = $1 and not g.returned))
     order by g.id`, [ctx.p.id])).rows;
  const what = (g: typeof rows[number]) => ({ gold: g.gold, gems: g.gems, item: g.slot && g.item_id !== null ? Bag.item(g.slot as Bag.Slot, g.item_id, g.rarity).name : null });
  return {
    waiting: rows.filter((g) => g.dir === "in" && g.arrives_day <= ctx.day).map((g) => ({ id: Number(g.id), from: g.returned ? "returned to you, unclaimed" : g.other, ...what(g) })),
    on_the_road_to_you: rows.filter((g) => g.dir === "in" && g.arrives_day > ctx.day).length,
    sent: rows.filter((g) => g.dir === "out").map((g) => ({ to: g.other, ...what(g), arrives: g.arrives_day > ctx.day ? "next dawn" : "waiting for them to collect" })),
  };
}

/** Collect what the courier brought: one gift by id, or everything waiting. Items need room in the bag. */
api.post("/mail/collect", async (c) => {
  const body = z.object({ id: z.number().int().optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const rows = (await ctx.c.query<{ id: string; gold: number; gems: number; slot: string | null; item_id: number | null; rarity: number; from_name: string | null; returned: boolean }>(
      `select g.id::text, g.gold, g.gems, g.slot, g.item_id, g.rarity, f.name as from_name, g.returned from gifts g left join players f on f.id = g.from_player
       where g.to_player = $1 and g.state = 'sent' and g.arrives_day <= $2 and ($3::bigint is null or g.id = $3) order by g.id for update of g`, [ctx.p.id, ctx.day, body.id ?? null])).rows;
    if (!rows.length) { ctx.events.push({ kind: "nothing_to_collect" }); return; }
    const cap = Bag.bag(ctx.p.bag_id).capacity;
    let used = await Bag.used(ctx.c, ctx.p.id), gold = 0, gems = 0;
    const got: Record<string, unknown>[] = [], left: Record<string, unknown>[] = [];
    for (const g of rows) {
      let itemName: string | null = null;
      if (g.slot && g.item_id !== null) {
        const it = Bag.item(g.slot as Bag.Slot, g.item_id, g.rarity);
        if (used + it.weight > cap) { left.push({ id: Number(g.id), item: it.name, reason: "bag_full", weight: it.weight }); continue; }
        await ctx.c.query("insert into inventory (player_id, slot, item_id, rarity) values ($1,$2,$3,$4)", [ctx.p.id, g.slot, g.item_id, g.rarity]);
        used += it.weight; itemName = it.name;
      }
      gold += g.gold; gems += g.gems;
      await ctx.c.query("update gifts set state = 'collected', settled_at = now() where id = $1", [g.id]);
      got.push({ from: g.returned ? "your own gift, back unclaimed" : g.from_name, gold: g.gold, gems: g.gems, item: itemName });
    }
    if (gold || gems) await savePlayer(ctx, { gold: ctx.p.gold + gold, gems: ctx.p.gems + gems });
    ctx.events.push({ kind: "collected", gifts: got, gold, gems, ...(left.length ? { left_waiting: left } : {}), bag_used: used, bag_capacity: cap });
  }));
});

/** Open the mailbag: unread letters first (now marked read), then the last 20 both ways. */
api.get("/mail", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const unread = await ctx.c.query<{ id: string; from_name: string; body: string; created_at: string }>(
    `update messages m set read_at = now()
     from players p
     where m.id in (select id from messages where to_player = $1 and read_at is null order by id limit 20)
       and p.id = m.from_player
     returning m.id, p.name as from_name, m.body, m.created_at`, [ctx.p.id]);
  const still = await ctx.c.query<{ n: string }>("select count(*)::text as n from messages where to_player = $1 and read_at is null", [ctx.p.id]);
  const r = await ctx.c.query<{ dir: string; other: string; body: string; created_at: string }>(
    `select case when m.to_player = $1 then 'in' else 'out' end as dir,
            case when m.to_player = $1 then f.name else t.name end as other,
            m.body, m.created_at
     from messages m join players f on f.id = m.from_player join players t on t.id = m.to_player
     where (m.to_player = $1 or m.from_player = $1) and not (m.id = any($2::bigint[]))
     order by m.id desc limit 20`, [ctx.p.id, unread.rows.map((x) => x.id)]);
  const muted = await ctx.c.query<{ name: string }>("select p.name from mutes m join players p on p.id = m.muted_id where m.player_id = $1 order by p.name", [ctx.p.id]);
  const gifts = await giftsFor(ctx);
  ctx.events.push({
    kind: "mail_inbox",
    ...(gifts.waiting.length || gifts.sent.length || gifts.on_the_road_to_you ? { gifts } : {}),
    unread: unread.rows.sort((a, b) => Number(a.id) - Number(b.id)).map((x) => ({ from: x.from_name, body: x.body, sent_at: x.created_at })),
    history: r.rows.reverse(),
    still_unread: Number(still.rows[0].n),
    muted: muted.rows.map((x) => x.name),
  });
})));

api.post("/mute", async (c) => {
  const body = z.object({ name: z.string().trim().min(1).max(40), on: z.boolean().default(true) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const r = await ctx.c.query<{ id: string; name: string }>("select id, name from players where lower(name) = lower($1)", [body.name]);
    if (!r.rowCount) { ctx.events.push({ kind: "no_such_player", name: body.name }); return; }
    if (r.rows[0].id === ctx.p.id) { ctx.events.push({ kind: "mute_self" }); return; }
    if (body.on) await ctx.c.query("insert into mutes (player_id, muted_id) values ($1,$2) on conflict do nothing", [ctx.p.id, r.rows[0].id]);
    else await ctx.c.query("delete from mutes where player_id = $1 and muted_id = $2", [ctx.p.id, r.rows[0].id]);
    ctx.events.push({ kind: body.on ? "muted" : "unmuted", name: r.rows[0].name });
  }));
});

/**
 * For the plugin's prompt hook: how much unread mail, and from whom. Deliberately outside withPlayer,
 * so peeking never rolls the day over, marks anything read, or consumes "while you were away" events.
 */
api.get("/mail/peek", async (c) => {
  const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!key) return c.json({ error: "unauthorized" }, 401);
  const r = await pool.query<{ unread: string; latest: string | null; senders: string[] | null; news: string }>(
    `select count(m.id)::text as unread, max(m.id)::text as latest, array_agg(distinct f.name) as senders,
            (select count(*) from news n where n.id > p.news_seen_upto and n.actor is distinct from p.name)::text as news
     from players p
     left join messages m on m.to_player = p.id and m.read_at is null
     left join players f on f.id = m.from_player
     where p.api_key_hash = $1 and not p.trial
     group by p.id`, [hash(key)]);
  if (!r.rowCount) return c.json({ error: "unauthorized" }, 401);
  const row = r.rows[0];
  return c.json({ unread: Number(row.unread), latest: row.latest ? Number(row.latest) : 0, from: (row.senders ?? []).filter(Boolean).slice(0, 5), news: Number(row.news) });
});

// ---------- live chat (the side pane's; the narrator never sees it) ----------

/** Which room a player is in: their town, or "the road" for anyone out in the wild. */
function chatRoom(p: { pos_x: number | null; pos_y: number | null }): { room: string; name: string } {
  if (p.pos_x === null || p.pos_x === undefined) return { room: "brightwater", name: "Brightwater" };
  const t = townAt(p.pos_x, p.pos_y!);
  return t ? { room: t, name: TOWN_TILES[t as keyof typeof TOWN_TILES]?.name ?? t } : { room: "road", name: "the road" };
}
const CHAT_MAX = 240, CHAT_GAP_MS = 2000, CHAT_PER_5MIN = 30;
/** Chat is deleted after this many days (the site's privacy note says so). */
export const CHAT_KEEP_DAYS = 30;

/** The player behind a key, for chat: light, outside withPlayer, so polling never rolls the day or reads mail. */
async function chatPlayer(c: { req: { header: (n: string) => string | undefined } }) {
  const key = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;
  const r = await pool.query<{ id: string; name: string; level: number; role: string; is_test: boolean; admin: boolean; banned_at: string | null; pos_x: number | null; pos_y: number | null }>(
    "update players set last_seen = now() where api_key_hash = $1 and not trial returning id, name, level, role, is_test, admin, banned_at, pos_x, pos_y", [hash(key)]);
  return r.rows[0] ?? null;
}

/**
 * New chat since `since` (an id; 0 for the last half hour): the player's room, and whispers to or from them.
 * Muted senders, banned ones and hidden lines are left out; test characters only see each other.
 */
api.get("/chat", async (c) => {
  const me = await chatPlayer(c);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (me.banned_at) return c.json({ error: "banned" }, 403);
  const since = Math.max(0, Number(c.req.query("since") ?? 0) || 0);
  const { room, name } = chatRoom(me);
  // New lines since the last id; on a first read, the room's last 20 lines however old and the last 20 whispers
  // to or from you, so a newcomer sees the conversation. Nothing older than the 30 days chat is kept.
  const sel = `select c.id::text, c.room, f.name as from_name, t.name as to_name, c.body, c.created_at, c.from_player as from_id
     from chat c join players f on f.id = c.from_player left join players t on t.id = c.to_player
     where c.hidden_at is null and f.banned_at is null and f.is_test = $3 and c.created_at > now() - interval '${CHAT_KEEP_DAYS} days'
       and not exists (select 1 from mutes m where m.player_id = $1 and m.muted_id = c.from_player)`;
  type Row = { id: string; room: string; from_name: string; to_name: string | null; body: string; created_at: string; from_id: string };
  const rows = since > 0
    ? (await pool.query<Row>(`${sel} and c.id > $2 and ((c.to_player is null and c.room = $4) or c.to_player = $1 or (c.from_player = $1 and c.to_player is not null))
         order by c.id desc limit 40`, [me.id, since, me.is_test, room])).rows.reverse()
    : [...(await pool.query<Row>(`${sel} and $2::bigint = 0 and c.to_player is null and c.room = $4 order by c.id desc limit 20`, [me.id, 0, me.is_test, room])).rows,
       ...(await pool.query<Row>(`${sel} and $2::bigint = 0 and $4::text is not null and (c.to_player = $1 or (c.from_player = $1 and c.to_player is not null)) order by c.id desc limit 20`, [me.id, 0, me.is_test, room])).rows]
      .sort((a, b) => Number(a.id) - Number(b.id));
  // Who else is in the room now: players (townsfolk don't chat) who did something in the last fifteen minutes, in the same town or on the road.
  const here = (await pool.query<{ name: string; pos_x: number | null; pos_y: number | null }>(
    `select name, pos_x, pos_y from players where role = 'player' and is_test = $2 and banned_at is null
       and last_seen > now() - interval '15 minutes' and id <> $1 order by last_seen desc limit 60`, [me.id, me.is_test])).rows
    .filter((x) => chatRoom(x).room === room).slice(0, 20).map((x) => x.name);
  // Everyone in the realm now, wherever they are (the same list the rankings mark online), for the side pane.
  const online = (await pool.query<{ name: string }>(
    "select name from players where role <> 'npc' and not is_test and banned_at is null and last_seen > now() - interval '15 minutes' order by level desc, exp desc limit 12")).rows.map((x) => x.name);
  return c.json({
    room, room_name: name, you: me.name, here, online,
    messages: rows.map((m) => ({ id: Number(m.id), from: m.from_name, body: m.body, at: m.created_at,
      ...(m.to_name ? { whisper: true, to: m.to_name, mine: m.from_id === me.id } : { mine: m.from_id === me.id }) })),
    last_id: rows.length ? Number(rows[rows.length - 1].id) : since,
  });
});

/** Say something in the room, or whisper to one player ({ to }). Level 2 and up; a couple of seconds apart. */
api.post("/chat", async (c) => {
  const me = await chatPlayer(c);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (me.banned_at) return c.json({ error: "banned" }, 403);
  const body = z.object({ body: z.string().max(1000).transform(cleanText).pipe(z.string().min(1).max(CHAT_MAX)), to: z.string().trim().min(1).max(40).optional() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: "bad_message", max: CHAT_MAX }, 400);
  if (me.role === "player" && me.level < SEASONED_LEVEL) return c.json({ error: "too_new", needed_level: SEASONED_LEVEL }, 403);
  const recent = (await pool.query<{ n: string; last: string | null }>(
    "select count(*)::text as n, max(created_at)::text as last from chat where from_player = $1 and created_at > now() - interval '5 minutes'", [me.id])).rows[0];
  if (Number(recent.n) >= CHAT_PER_5MIN) return c.json({ error: "slow_down", per_5_minutes: CHAT_PER_5MIN }, 429);
  if (recent.last && Date.now() - new Date(recent.last).getTime() < CHAT_GAP_MS) return c.json({ error: "slow_down", wait_ms: CHAT_GAP_MS }, 429);
  let to: { id: string; name: string } | null = null;
  if (body.data.to) {
    const r = await pool.query<{ id: string; name: string; role: string; is_test: boolean }>("select id, name, role, is_test from players where lower(name) = lower($1)", [body.data.to]);
    const t = r.rows[0];
    if (!t || t.role !== "player" || t.is_test !== me.is_test) return c.json({ error: "no_such_player", name: body.data.to }, 404);
    if (t.id === me.id) return c.json({ error: "whisper_self" }, 400);
    to = t;
    // Muted: it looks sent from here and never arrives (as with mail).
    if ((await pool.query("select 1 from mutes where player_id = $1 and muted_id = $2", [t.id, me.id])).rowCount) return c.json({ ok: true, id: 0 });
  }
  const { room } = chatRoom(me);
  const r = await pool.query<{ id: string }>("insert into chat (room, from_player, to_player, body) values ($1,$2,$3,$4) returning id", [room, me.id, to?.id ?? null, body.data.body]);
  return c.json({ ok: true, id: Number(r.rows[0].id), room, ...(to ? { to: to.name } : {}) });
});

/** The keeper tops up a character's turns for today (their own by default): logged like any hand edit. */
api.post("/admin/turns", async (c) => {
  const body = z.object({ add: z.number().int().min(1).max(100), name: z.string().trim().min(1).max(40).optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const who = body.name
      ? (await ctx.c.query<{ id: string; name: string }>("select id, name from players where lower(name) = lower($1)", [body.name])).rows[0]
      : { id: ctx.p.id, name: ctx.p.name };
    if (!who) { ctx.events.push({ kind: "admin_error", error: "no_such_player", name: body.name }); return; }
    const r = await ctx.c.query<{ forest_fights: number }>(
      "update turns set forest_fights = forest_fights + $3 where player_id = $1 and day = $2 returning forest_fights", [who.id, ctx.day, body.add]);
    if (!r.rowCount) { ctx.events.push({ kind: "admin_error", error: "not_played_today", name: who.name, note: "they get a fresh day's turns the first time they play today" }); return; }
    if (who.id === ctx.p.id) ctx.t.forest_fights = r.rows[0].forest_fights;
    await audit(ctx, "turns", who.name, { add: body.add, now: r.rows[0].forest_fights });
    ctx.events.push({ kind: "admin_done", action: "turns", name: who.name, added: body.add, turns_now: r.rows[0].forest_fights });
  }));
});

/** The keeper hides a chat line (or shows it again). */
api.post("/admin/hide_chat", async (c) => {
  const body = z.object({ id: z.number().int(), hidden: z.boolean().optional() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAdmin(ctx);
    const hide = body.hidden !== false;
    const r = await ctx.c.query<{ from_name: string; body: string }>(
      "update chat c set hidden_at = $2 from players p where c.id = $1 and p.id = c.from_player returning p.name as from_name, c.body", [body.id, hide ? new Date() : null]);
    if (!r.rowCount) { ctx.events.push({ kind: "admin_error", error: "no_such_line", id: body.id }); return; }
    await audit(ctx, hide ? "hide_chat" : "unhide_chat", r.rows[0].from_name, { id: body.id, body: r.rows[0].body });
    ctx.events.push({ kind: "admin_done", action: hide ? "hide_chat" : "unhide_chat", id: body.id, author: r.rows[0].from_name });
  }));
});

// ---------- the auction house ----------

interface ARow {
  id: string; town: string; seller_id: string | null; slot: ListSlot; item_id: number; qty: number; min_bid: number; buy_now: number | null;
  high_bid: number | null; high_bidder: string | null; status: string; listed_day: string; ends_day: string; collected: boolean; rarity: number;
  seller: string | null; seller_role: string | null; bidder: string | null;
}
const A_SELECT = `select a.id::text, a.town, a.seller_id, a.slot, a.item_id, a.qty, a.rarity, a.min_bid, a.buy_now, a.high_bid, a.high_bidder, a.status,
  a.listed_day::text, a.ends_day::text, a.collected, s.name as seller, s.role as seller_role, b.name as bidder
  from auctions a left join players s on s.id = a.seller_id left join players b on b.id = a.high_bidder`;

const lotName = (r: { slot: ListSlot; item_id: number; qty: number; rarity?: number }) => { const n = worth(r.slot, r.item_id, r.rarity ?? 0).name; return r.qty > 1 ? `${r.qty} × ${n}${r.slot === "gem" ? "s" : ""}` : n; };
/** A lot is what it is: its family, and whether the one looking can use it (anyone may buy it, to sell on or give). */
function lotStats(slot: ListSlot, id: number, cls: Player["class"], r = 0) {
  const fam = (s: "weapon" | "armor") => ({ what: familyLabel(s, id), ...(fits(s, id, cls) ? {} : { not_for_your_path: `only ${familyUsers(s, id)} can use it` }) });
  if (slot === "weapon") return { power: boosted(weapon(id).str, r), ...(r ? { rarity: rarity(r).name } : {}), ...fam("weapon") };
  if (slot === "armor") return { def: boosted(armor(id).def, r), ...(r ? { rarity: rarity(r).name } : {}), ...fam("armor") };
  if (slot === "trinket") return { bonus: bonusText(trinket(id), attributeName(cls)) };
  if (slot === "potion") return { does: potion(id).what };
  return {};
}
function listingView(ctx: Ctx, r: ARow) {
  const w = worth(r.slot, r.item_id, r.rarity);
  return {
    id: Number(r.id), item: lotName(r), slot: r.slot, tier: r.slot === "weapon" || r.slot === "armor" ? tierOf(r.item_id) : r.item_id, ...lotStats(r.slot, r.item_id, ctx.p.class, r.rarity), worth: w.value * r.qty,
    town: TOWNS[r.town as Town] ?? r.town, seller: r.seller ?? "the house",
    min_bid: r.min_bid, ...(r.buy_now ? { buy_now: r.buy_now } : {}), high_bid: r.high_bid, next_bid: nextBid(r.min_bid, r.high_bid),
    closes_after: r.ends_day, days_left: Math.max(0, daysBetween(ctx.day, r.ends_day)),
    ...(r.seller_id === ctx.p.id ? { yours: true } : {}), ...(r.high_bidder === ctx.p.id ? { you_lead: true } : {}),
  };
}

/** Each lot with the going price for one of it this week and which way it's moving (the same kind of item is looked up once). */
async function withMarket(ctx: Ctx, lots: (readonly [ARow, ReturnType<typeof listingView>])[]) {
  const seen = new Map<string, Market>();
  const out = [];
  for (const [r, v] of lots) {
    const k = `${r.slot}:${r.item_id}:${r.rarity}`;
    if (!seen.has(k)) seen.set(k, await marketFor(ctx.c, r.slot, r.item_id, r.rarity));
    const m = seen.get(k)!;
    out.push({ ...v, ...(m.unit !== null ? { market: { each: m.unit, sold_this_week: m.sales, ...(m.trend ? { trend: m.trend } : {}) } } : {}) });
  }
  return out;
}

/** Take gold for a bid or purchase: from the bank first, then the purse. False if they can't cover it. */
async function payFrom(ctx: Ctx, amount: number): Promise<boolean> {
  if (ctx.p.bank + ctx.p.gold < amount) return false;
  const fromBank = Math.min(ctx.p.bank, amount);
  await savePlayer(ctx, { bank: ctx.p.bank - fromBank, gold: ctx.p.gold - (amount - fromBank) });
  return true;
}
async function mail(c: Client, playerId: string, event: Record<string, unknown>) {
  await c.query("insert into mailbox (player_id, event) values ($1, $2)", [playerId, event]);
}
/** Give back an outbid player's gold, into their bank, with a note. */
async function refundBid(c: Client, r: ARow, why: "outbid" | "bought_out") {
  if (!r.high_bidder || !r.high_bid) return;
  await c.query("update players set bank = bank + $2 where id = $1", [r.high_bidder, r.high_bid]);
  await mail(c, r.high_bidder, { kind: "auction_outbid", item: lotName(r), refund: r.high_bid, why });
}
/** Pay a seller for a sale, less the house's cut. Characters and the house itself aren't paid: that gold leaves the realm. */
async function paySeller(c: Client, r: ARow, price: number, day: string) {
  if (!r.seller_id || r.seller_role === "npc") return;
  // Married to Ysolde: the houses take half their usual cut.
  const spouse = (await c.query<{ name: string }>("select s.name from players p join players s on s.id = p.spouse_id where p.id = $1", [r.seller_id])).rows[0]?.name;
  const cut = Math.floor(houseCut(price) * (spousePerk(spouse) === "auction" ? 0.5 : 1));
  await c.query("update players set bank = bank + $2 where id = $1", [r.seller_id, price - cut]);
  await mail(c, r.seller_id, { kind: "auction_sold", item: lotName(r), price, house_cut: cut, paid_to_bank: price - cut, buyer: r.bidder });
  if (price >= 500) await c.query("insert into news (day, kind, actor, target, detail) select $1, 'auction_sale', s.name, b.name, $4 from players s, players b where s.id = $2 and b.id = $3 and not s.is_test and not b.is_test",
    [day, r.seller_id, r.high_bidder, { item: lotName(r), price }]);
}

/** Into the house's storeroom: what's been sold to the smith or Odile (or didn't sell at the house), for Cass to list later. */
async function toStorehouse(c: Client, items: { slot: string; item_id: number; qty?: number; rarity?: number }[], town = "brightwater") {
  for (const x of items) {
    // Weapon, armor and jewelry 0 mean "none" (fists, nothing worn); ore 0 is copper and counts.
    if (!["weapon", "armor", "ore", "trinket", "gem"].includes(x.slot) || (["weapon", "armor", "trinket"].includes(x.slot) && x.item_id <= 0)) continue;
    await c.query(`insert into house_stock (town, slot, item_id, qty, rarity) values ($1,$2,$3,$4,$5)
      on conflict (town, slot, item_id, rarity) do update set qty = house_stock.qty + excluded.qty`, [town, x.slot, x.item_id, x.qty ?? 1, x.rarity ?? 0]);
  }
}

/** Close listings whose time is up, and keep a few of the house's own lots on the board. Safe to call often. */
export async function settleAuctions(c: Client, day: string): Promise<string[]> {
  const out: string[] = [];
  const due = (await c.query<ARow>(`${A_SELECT} where a.status = 'open' and a.ends_day <= $1 for update of a skip locked`, [day])).rows;
  for (const r of due) {
    if (r.high_bid && r.high_bidder) {
      await c.query("update auctions set status = 'sold', settled_at = now() where id = $1", [r.id]);
      await paySeller(c, r, r.high_bid, day);
      await mail(c, r.high_bidder, { kind: "auction_won", item: lotName(r), price: r.high_bid, collect: "at the auction house on Market Row" });
      out.push(`sold ${lotName(r)} for ${r.high_bid}`);
    } else {
      const npc = !r.seller_id || r.seller_role === "npc";
      await c.query("update auctions set status = 'expired', settled_at = now(), collected = $2 where id = $1", [r.id, npc]);
      if (npc) await toStorehouse(c, [{ slot: r.slot, item_id: r.item_id, qty: r.qty, rarity: r.rarity }], r.town);
      if (!npc) await mail(c, r.seller_id!, { kind: "auction_unsold", item: lotName(r), collect: "at the auction house on Market Row" });
      out.push(`unsold ${lotName(r)}`);
    }
  }
  // The house's own lots, from each town's storeroom: one lot per kind of item, at full shop worth, and only while players there are quiet.
  for (const [town, keeper] of [["brightwater", "Cass Marrow"], ["ironhold", "Mabry Locke"], ["ashford", "Ysolde Fairweather"]] as const) {
    const quiet = Number((await c.query<{ n: string }>(
      "select count(*)::text as n from auctions a join players s on s.id = a.seller_id where a.status = 'open' and a.town = $1 and s.role <> 'npc' and not s.is_test", [town])).rows[0].n) < AUCTION.playerQuiet;
    const house = (await c.query<{ id: string }>("select id from players where name = $1", [keeper])).rows[0];
    if (!quiet || !house) continue;
    const listed = (await c.query<{ slot: ListSlot; item_id: number; rarity: number }>("select slot, item_id, rarity from auctions where status = 'open' and seller_id = $1", [house.id])).rows;
    const room = AUCTION.houseLots - listed.length;
    if (room <= 0) continue;
    const have = new Set(listed.map((l) => `${l.slot}:${l.item_id}:${l.rarity}`));
    const stock = (await c.query<{ slot: ListSlot; item_id: number; qty: number; rarity: number }>(
      "select slot, item_id, qty, rarity from house_stock where town = $1 and qty > 0 order by random() for update", [town])).rows.filter((x) => !have.has(`${x.slot}:${x.item_id}:${x.rarity}`)).slice(0, room);
    for (const x of stock) {
      const qty = Math.min(x.qty, AUCTION.houseLotMax[x.slot] ?? 1);
      // The house prices off the board too: last week's going rate, nudged by how the last lot went, kept near shop worth.
      const base = worth(x.slot, x.item_id, x.rarity).value;
      const m = await marketFor(c, x.slot, x.item_id, x.rarity);
      const nudge = m.last === "sold_at_buy_now" ? 1.08 : 0.92 ** m.unsold_run;
      const unit = Math.min(base * 1.5, Math.max(base * 0.85, (m.unit ?? base) * nudge));
      const v = Math.round(unit * qty);
      const ends = new Date(day + "T00:00:00Z"); ends.setUTCDate(ends.getUTCDate() + 2);
      await c.query("update house_stock set qty = qty - $4 where town = $1 and slot = $2 and item_id = $3 and rarity = $5", [town, x.slot, x.item_id, qty, x.rarity]);
      await c.query("insert into auctions (town, seller_id, slot, item_id, qty, rarity, min_bid, buy_now, listed_day, ends_day) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [town, house.id, x.slot, x.item_id, qty, x.rarity, Math.max(1, v), Math.ceil(v * AUCTION.houseBuyNow), day, ends.toISOString().slice(0, 10)]);
      out.push(`${keeper} listed ${lotName({ slot: x.slot, item_id: x.item_id, qty, rarity: x.rarity })}`);
    }
  }
  return out;
}

/** Hand over everything waiting for them at the house that fits in their bag. */
async function collectLots(ctx: Ctx) {
  const rows = (await ctx.c.query<ARow>(
    `${A_SELECT} where not a.collected and ((a.status = 'sold' and a.high_bidder = $1) or (a.status in ('expired', 'cancelled') and a.seller_id = $1)) order by a.id for update of a`, [ctx.p.id])).rows;
  const got: string[] = [], waiting: string[] = [];
  let room = Bag.bag(ctx.p.bag_id).capacity - await Bag.used(ctx.c, ctx.p.id);
  for (const r of rows) {
    if (r.slot === "gem") {
      await savePlayer(ctx, { gems: ctx.p.gems + r.qty });
    } else {
      const w = worth(r.slot, r.item_id).weight * r.qty;
      if (w > room) { waiting.push(lotName(r)); continue; }
      room -= w;
      for (let i = 0; i < r.qty; i++) await ctx.c.query("insert into inventory (player_id, slot, item_id, rarity) values ($1,$2,$3,$4)", [ctx.p.id, r.slot, r.item_id, r.rarity ?? 0]);
    }
    await ctx.c.query("update auctions set collected = true where id = $1", [r.id]);
    got.push(lotName(r));
  }
  return { got, waiting };
}

async function lotFor(ctx: Ctx, id: number): Promise<ARow> {
  const r = (await ctx.c.query<ARow>(`${A_SELECT} where a.id = $1 for update of a`, [id])).rows[0];
  if (!r) throw new GameError("no_such_lot", "there's no lot with that number");
  return r;
}
const atTheHouse = (ctx: Ctx): TownId => { requireAlive(ctx); return requireTown(ctx, "the auction house", ALL_TOWNS); };

/** The board: what's up for sale, your own lots and bids, and anything waiting for you. */
api.get("/auction", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const town = atTheHouse(ctx);
  await settleAuctions(ctx.c, ctx.day);
  const slot = c.req.query("slot");
  const board = (await ctx.c.query<ARow>(
    `${A_SELECT} where a.status = 'open' and (s.is_test is not true or a.seller_id = $1) ${slot ? "and a.slot = $2" : ""} order by a.ends_day, a.id limit 30`,
    slot ? [ctx.p.id, slot] : [ctx.p.id])).rows;
  const mine = (await ctx.c.query<ARow>(`${A_SELECT} where a.seller_id = $1 and a.status = 'open' order by a.id`, [ctx.p.id])).rows;
  const waiting = Number((await ctx.c.query<{ n: string }>(
    "select count(*)::text as n from auctions where not collected and ((status = 'sold' and high_bidder = $1) or (status in ('expired','cancelled') and seller_id = $1))", [ctx.p.id])).rows[0].n);
  ctx.events.push({
    kind: "auction_house", keeper: town === "brightwater" ? "Cass Marrow" : TOWN_INFO[town]!.auctioneer, town: TOWNS[town as Town] ?? town, connected: "one board for every town's house; lots elsewhere are delivered here when you collect",
    listings: await withMarket(ctx, board.map((r) => [r, listingView(ctx, r)] as const)), your_lots: mine.map((r) => listingView(ctx, r)),
    waiting_for_you: waiting, purse: ctx.p.gold, bank: ctx.p.bank,
    rules: { days: `${AUCTION.minDays}-${AUCTION.maxDays}`, listing_fee: `${Math.round(AUCTION.feeShare * 100)}% of the minimum bid, at least ${AUCTION.feeMin} gold`, house_cut: `${Math.round(AUCTION.cut * 100)}% of the sale`, max_lots: AUCTION.maxOpen, bids_from: "bank first, then purse; outbid gold comes back to your bank" },
  });
})));

api.post("/auction", async (c) => {
  const body = z.discriminatedUnion("op", [
    z.object({ op: z.literal("list"), id: z.number().int().optional(), gems: z.number().int().min(1).optional(), qty: z.number().int().min(1).max(10).optional(), min_bid: z.number().int().min(1), buy_now: z.number().int().min(1).optional(), days: z.number().int().optional(), confirm: z.boolean().optional() }),
    z.object({ op: z.literal("bid"), lot: z.number().int(), amount: z.number().int().min(1).optional(), confirm: z.boolean().optional() }),
    z.object({ op: z.literal("buy"), lot: z.number().int(), confirm: z.boolean().optional() }),
    z.object({ op: z.literal("cancel"), lot: z.number().int() }),
    z.object({ op: z.literal("collect") }),
  ]).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const town = atTheHouse(ctx);
    await requireNoEncounter(ctx);
    await settleAuctions(ctx.c, ctx.day);
    // Money changes hands only on a confirmed call: without confirm, list, bid and buy return a quote and do nothing.
    // Plugins from before quotes existed (0.13.0) and townsfolk go straight through.
    const plugin = current()?.plugin;
    const confirmed = ("confirm" in body && body.confirm === true) || ctx.p.is_bot || (plugin !== undefined && plugin !== null && older(plugin, "0.13.1"));

    if (body.op === "collect") {
      const { got, waiting } = await collectLots(ctx);
      ctx.events.push({ kind: "auction_collected", got, ...(waiting.length ? { waiting, why: "no room in your bag" } : {}) });
      return;
    }

    if (body.op === "list") {
      if (ctx.p.role !== "player" && ctx.p.role !== "townsfolk") throw new GameError("no", "only players and townsfolk can sell here");
      const open = Number((await ctx.c.query<{ n: string }>("select count(*)::text as n from auctions where seller_id = $1 and status = 'open'", [ctx.p.id])).rows[0].n);
      if (open >= AUCTION.maxOpen) { ctx.events.push({ kind: "auction_refused", reason: `you already have ${AUCTION.maxOpen} lots up` }); return; }
      const days = Math.max(AUCTION.minDays, Math.min(AUCTION.maxDays, body.days ?? 2));
      let slot: ListSlot, itemId = 0, qty = 1, rows: number[] = [], rar = 0;
      if (body.gems) {
        if (ctx.p.gems < body.gems) { ctx.events.push({ kind: "auction_refused", reason: `you have ${ctx.p.gems} gems` }); return; }
        slot = "gem"; qty = body.gems;
      } else {
        if (body.id === undefined) throw new GameError("what", "say which item (its bag id) or how many gems");
        const row = await ownRow(ctx, body.id);
        if (row.slot === "quest") { ctx.events.push({ kind: "auction_refused", reason: "Cass won't sell that; it isn't yours to sell" }); return; }
        slot = row.slot; itemId = row.item_id; rar = row.rarity ?? 0;
        qty = Bag.STACKS.includes(row.slot) ? body.qty ?? 1 : 1;
        rows = Bag.STACKS.includes(row.slot) ? (await Bag.contents(ctx.c, ctx.p.id)).filter((x) => x.slot === row.slot && x.item_id === row.item_id).map((x) => x.id).slice(0, qty) : [row.id];
        if (rows.length < qty) { ctx.events.push({ kind: "auction_refused", reason: `you only have ${rows.length} of those` }); return; }
      }
      const problem = priceProblem(slot, itemId, qty, body.min_bid, body.buy_now ?? null, rar);
      if (problem) { ctx.events.push({ kind: "auction_refused", reason: problem }); return; }
      const fee = listingFee(body.min_bid);
      if (!confirmed) {
        ctx.events.push({ kind: "auction_quote", op: "list", item: lotName({ slot, item_id: itemId, qty, rarity: rar }), min_bid: body.min_bid, buy_now: body.buy_now ?? null, days, fee, house_cut: `${Math.round(AUCTION.cut * 100)}% of the sale`, can_pay: ctx.p.gold + ctx.p.bank >= fee });
        ctx.hint = "A quote, nothing done yet: show what they'd list, for how long, at what prices, the fee and the house's cut, and ask them to confirm (y/n). Call again with confirm: true only on a yes.";
        return;
      }
      if (!(await payFrom(ctx, fee))) { ctx.events.push({ kind: "auction_refused", reason: `the listing fee is ${fee} gold` }); return; }
      if (slot === "gem") await savePlayer(ctx, { gems: ctx.p.gems - qty });
      else await ctx.c.query("delete from inventory where id = any($1::bigint[])", [rows]);
      const ends = new Date(ctx.day + "T00:00:00Z"); ends.setUTCDate(ends.getUTCDate() + days);
      const ins = await ctx.c.query<{ id: string }>(
        "insert into auctions (town, seller_id, slot, item_id, qty, rarity, min_bid, buy_now, listed_day, ends_day) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id::text",
        [town, ctx.p.id, slot, itemId, qty, rar, body.min_bid, body.buy_now ?? null, ctx.day, ends.toISOString().slice(0, 10)]);
      ctx.events.push({ kind: "auction_listed", lot: Number(ins.rows[0].id), item: lotName({ slot, item_id: itemId, qty, rarity: rar }), min_bid: body.min_bid, buy_now: body.buy_now ?? null, fee, closes_after: ends.toISOString().slice(0, 10) });
      await logEvent(ctx, "auction", { op: "list", slot, item_id: itemId, qty, min_bid: body.min_bid, buy_now: body.buy_now ?? null });
      return;
    }

    const r = await lotFor(ctx, body.lot);
    if (r.status !== "open") { ctx.events.push({ kind: "auction_refused", reason: "that lot has closed" }); return; }

    if (body.op === "cancel") {
      if (r.seller_id !== ctx.p.id) throw new GameError("not_yours", "that isn't your lot");
      if (r.high_bid) { ctx.events.push({ kind: "auction_refused", reason: "someone has already bid; it has to run its course" }); return; }
      await ctx.c.query("update auctions set status = 'cancelled', settled_at = now() where id = $1", [r.id]);
      const { got, waiting } = await collectLots(ctx);
      ctx.events.push({ kind: "auction_cancelled", item: lotName(r), got, ...(waiting.length ? { waiting } : {}), note: "the listing fee isn't refunded" });
      return;
    }

    if (r.seller_id === ctx.p.id) { ctx.events.push({ kind: "auction_refused", reason: "you can't bid on your own lot" }); return; }
    const price = body.op === "buy" ? r.buy_now : Math.max(body.amount ?? 0, nextBid(r.min_bid, r.high_bid));
    if (price === null) { ctx.events.push({ kind: "auction_refused", reason: "that lot has no buy-now price; bid instead" }); return; }
    const buyingOut = body.op === "buy" || (r.buy_now !== null && price >= r.buy_now);
    const final = buyingOut ? r.buy_now! : price;
    if (!buyingOut && final > bidCeiling(r.slot, r.item_id, r.qty, r.rarity)) { ctx.events.push({ kind: "auction_refused", reason: `the house won't take a bid over ${bidCeiling(r.slot, r.item_id, r.qty, r.rarity)} gold for that` }); return; }
    // Raising your own bid costs only the difference.
    const owed = r.high_bidder === ctx.p.id ? final - (r.high_bid ?? 0) : final;
    if (!confirmed) {
      const fromBank = Math.min(ctx.p.bank, owed);
      ctx.events.push({ kind: "auction_quote", op: buyingOut ? "buy" : "bid", lot: Number(r.id), item: lotName(r), ...lotStats(r.slot, r.item_id, ctx.p.class, r.rarity), from: r.seller ?? "the house",
        price: final, pays: owed, can_pay: ctx.p.gold + ctx.p.bank >= owed,
        ...(ctx.p.gold + ctx.p.bank >= owed ? { after: { bank: ctx.p.bank - fromBank, purse: ctx.p.gold - (owed - fromBank) } } : {}),
        ...(buyingOut ? {} : { closes_after: r.ends_day, note: "held by the house until it closes; if you're outbid, it comes back to your bank" }) });
      ctx.hint = `A quote, nothing done yet: name the lot and what it is, the price, and what they'd have left, and ask them to confirm (y/n). If it's not_for_your_path, say plainly they couldn't use it themselves (they could sell it on or give it to someone who can). Call again with the same lot and confirm: true only on a yes.`;
      return;
    }
    if (!(await payFrom(ctx, owed))) { ctx.events.push({ kind: "auction_refused", reason: `that takes ${owed} gold and you have ${ctx.p.gold + ctx.p.bank} between purse and bank` }); return; }
    if (r.high_bidder && r.high_bidder !== ctx.p.id) await refundBid(ctx.c, r, buyingOut ? "bought_out" : "outbid");

    if (buyingOut) {
      await ctx.c.query("update auctions set status = 'sold', high_bid = $2, high_bidder = $3, settled_at = now() where id = $1", [r.id, final, ctx.p.id]);
      await paySeller(ctx.c, { ...r, high_bidder: ctx.p.id, bidder: ctx.p.name }, final, ctx.day);
      const { got, waiting } = await collectLots(ctx);
      ctx.events.push({ kind: "auction_bought", item: lotName(r), price: final, from: r.seller ?? "the house", got, ...(waiting.length ? { waiting, why: "no room in your bag; collect it later" } : {}) });
      await logEvent(ctx, "auction", { op: "buy", slot: r.slot, item_id: r.item_id, qty: r.qty, price: final });
    } else {
      await ctx.c.query("update auctions set high_bid = $2, high_bidder = $3 where id = $1", [r.id, final, ctx.p.id]);
      ctx.events.push({ kind: "auction_bid", lot: Number(r.id), item: lotName(r), bid: final, closes_after: r.ends_day, note: "held by the house until it closes; if you're outbid, it comes back to your bank" });
      await logEvent(ctx, "auction", { op: "bid", slot: r.slot, item_id: r.item_id, qty: r.qty, bid: final });
    }
  }));
});

// ---------- pvp ----------

/** How far apart in level two players can be and still fight. One level up already wins most fights. */
const PVP_LEVEL_GAP = 1;

api.post("/challenge", async (c) => {
  const body = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    requireTown(ctx, "the fields outside town", ALL_TOWNS);
    await requireNoEncounter(ctx);
    if (ctx.t.player_fights <= 0) { ctx.events.push({ kind: "no_player_fights_left" }); return; }
    if (!seasoned(ctx, "attack another player")) return;
    if (body.name.toLowerCase() === ctx.p.name.toLowerCase()) throw new GameError("self", "you cannot fight yourself");
    const r = await ctx.c.query<Player>("select * from players where lower(name) = lower($1) for update", [body.name]);
    // Test and trial characters live apart from the realm: nobody real can reach them, nor they anyone real.
    if (!r.rowCount || r.rows[0].trial || (r.rows[0].role === "player" && r.rows[0].is_test !== ctx.p.is_test)) { ctx.events.push({ kind: "no_such_player", name: body.name }); return; }
    const d = numify(r.rows[0]);
    if (d.role === "npc") { ctx.events.push({ kind: "cannot_challenge", name: d.name, reason: "not a fighter" }); return; }
    if (!d.alive) { ctx.events.push({ kind: "target_dead", name: d.name }); return; }
    if (d.location === "inn") { ctx.events.push({ kind: "target_at_inn", name: d.name }); return; }
    if (Math.abs(d.level - ctx.p.level) > PVP_LEVEL_GAP) { ctx.events.push({ kind: "level_gap", name: d.name, their_level: d.level, max_gap: PVP_LEVEL_GAP }); return; }
    // Newcomers are left alone: nobody can be attacked at level 1 (just as nobody can attack before level 2), nor in their first day.
    const age = await ctx.c.query("select created_at < now() - interval '24 hours' as old from players where id = $1", [d.id]);
    if (d.level < SEASONED_LEVEL || !age.rows[0].old) { ctx.events.push({ kind: "newcomer_grace", name: d.name, ...(d.level < SEASONED_LEVEL ? { until: `level ${SEASONED_LEVEL}` } : {}) }); return; }
    await leaveInn(ctx);

    await saveTurns(ctx, { player_fights: ctx.t.player_fights - 1 });
    // Both fight with what they have left today: your specials and mana are spent, theirs are only borrowed
    // (they weren't there to choose). Someone who hasn't started their day yet fights fresh.
    const theirs = (await ctx.c.query<{ specials: number; mana: number | null }>("select specials, mana from turns where player_id = $1 and day = $2", [d.id, ctx.day])).rows[0];
    const me: Duelist = { p: ctx.p, specials: ctx.t.specials, mana: ctx.t.mana ?? 0 };
    const them: Duelist = { p: d, specials: theirs ? Number(theirs.specials) : GAME.classes[d.class].specialsPerDay, mana: theirs ? Number(theirs.mana ?? 0) : manaMax(d) };
    const res = resolveDuel(me, them);
    const af = res.a, df = res.d;
    if (me.specials !== ctx.t.specials || me.mana !== (ctx.t.mana ?? 0)) await saveTurns(ctx, { specials: me.specials, ...(casts(ctx.p.class) ? { mana: me.mana } : {}) });
    ctx.events.push({ kind: "pvp_log", opponent: d.name, opponent_class: d.class, rounds: res.log });

    if (res.winner === "attacker") {
      // Married to Mara, the lamplighter: she gets you out of the fields with half your purse still on you.
      const theirSpouse = d.spouse_id ? (await ctx.c.query<{ name: string }>("select name from players where id = $1", [d.spouse_id])).rows[0]?.name ?? null : null;
      const guarded = spousePerk(theirSpouse) === "guard";
      const gold = guarded ? Math.floor(d.gold / 2) : d.gold;
      const exp = Math.floor(expForLevel(d.level + 1) ?? 1000) / 20 | 0;
      await savePlayer(ctx, { hp: af.hp, gold: ctx.p.gold + gold, exp: ctx.p.exp + exp });
      await ctx.c.query("update players set alive = false, hp = 0, gold = gold - $2, ground = null, pos_x = null, pos_y = null, cave_depth = null where id = $1", [d.id, gold]);
      const theirLost = await Bag.loseRandom(ctx.c, d.id);
      await ctx.c.query("insert into mailbox (player_id, event) values ($1, $2)", [d.id, { kind: "killed_by_player", by: ctx.p.name, gold_lost: gold, item_lost: theirLost }]);
      await post(ctx, "pvp_kill", ctx.p.name, d.name, { gold });
      ctx.events.push({ kind: "pvp_win", opponent: d.name, gold, exp, ...(guarded ? { guarded_by: theirSpouse } : {}) });
      await logEvent(ctx, "pvp", { outcome: "won", opponent_class: d.class, opponent_level: d.level, opponent_bot: Boolean(d.is_bot), gold, rounds: res.log.filter((e) => e.attacker === ctx.p.name).length });
    } else if (res.winner === "defender") {
      // A failed attack kills you, but your gold stays yours: losing on purpose can't funnel gold to a friend.
      await savePlayer(ctx, { hp: 0, alive: false, ground: null, pos_x: null, pos_y: null, cave_depth: null });
      const myLost = await Bag.loseRandom(ctx.c, ctx.p.id);
      await ctx.c.query("update players set hp = $2 where id = $1", [d.id, df.hp]);
      await ctx.c.query("insert into mailbox (player_id, event) values ($1, $2)", [d.id, { kind: "defended", against: ctx.p.name }]);
      await post(ctx, "pvp_survived", ctx.p.name, d.name, {});
      ctx.events.push({ kind: "pvp_loss", opponent: d.name, item_lost: myLost });
      await logEvent(ctx, "pvp", { outcome: "lost", opponent_class: d.class, opponent_level: d.level, opponent_bot: Boolean(d.is_bot), rounds: res.log.filter((e) => e.attacker === ctx.p.name).length });
    } else {
      await savePlayer(ctx, { hp: af.hp });
      await ctx.c.query("update players set hp = $2 where id = $1", [d.id, df.hp]);
      ctx.events.push({ kind: "pvp_draw", opponent: d.name });
      await logEvent(ctx, "pvp", { outcome: "draw", opponent_class: d.class, opponent_level: d.level, opponent_bot: Boolean(d.is_bot) });
    }
  }));
});

// ---------- errors ----------

api.onError((err, c) => {
  if (err instanceof GameError) return c.json({ error: err.code, message: err.message }, err.status as 400);
  if ((err as { code?: string }).code === "40P01") return c.json({ error: "busy", message: "the realm was busy; try that again" }, 409);
  if (err instanceof z.ZodError) return c.json({ error: "bad_request", message: err.issues.map((i) => i.message).join("; ") }, 400);
  console.error(err);
  return c.json({ error: "internal", message: "something broke in the realm" }, 500);
});
