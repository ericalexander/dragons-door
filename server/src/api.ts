import { Hono } from "hono";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { tx, type Client } from "./db.js";
import { realmDay, realmSettings, loadTurns } from "./day.js";
import {
  GAME, armor, weapon, expForLevel, master, legalActions, publicState,
  type Player, type Turns, type Monster, type Event, type Envelope,
} from "./game.js";
import { exchange, fleeSucceeds, monsterAsFighter, pickMonster, playerAsFighter, resolveFull, roll, specialMultiplier } from "./combat.js";

export const api = new Hono();

class GameError extends Error {
  constructor(public code: string, msg: string, public status = 400) { super(msg); }
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

// ---------- context ----------

interface Ctx {
  c: Client;
  p: Player;
  t: Turns;
  day: string;
  dragonAlive: boolean;
  events: Event[];
  hint?: string;
}

/** Authenticate, lock the player row, roll the day if needed, run the handler, build the envelope. */
async function withPlayer(authHeader: string | undefined, fn: (ctx: Ctx) => Promise<void>): Promise<Envelope> {
  const key = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new GameError("unauthorized", "missing api key", 401);
  return tx(async (c) => {
    const r = await c.query<Player>("select * from players where api_key_hash = $1 for update", [hash(key)]);
    if (!r.rowCount) throw new GameError("unauthorized", "unknown api key", 401);
    const settings = await realmSettings(c);
    const day = realmDay(settings.resetHourUtc);
    const loaded = await loadTurns(c, r.rows[0], day);
    const ctx: Ctx = { c, p: loaded.player, t: loaded.turns, day, dragonAlive: settings.dragonAlive, events: [] };
    if (loaded.rolled) ctx.events.push({ kind: "new_day", day });
    await drainMailbox(ctx);
    await fn(ctx);
    await c.query("update players set last_seen = now() where id = $1", [ctx.p.id]);
    const enc = await c.query("select 1 from encounters where player_id = $1", [ctx.p.id]);
    const inEnc = enc.rowCount! > 0;
    return {
      events: ctx.events,
      state: publicState(ctx.p, ctx.t, inEnc, ctx.dragonAlive),
      actions: legalActions(ctx.p, ctx.t, inEnc, ctx.dragonAlive),
      ...(ctx.hint ? { hint: ctx.hint } : {}),
    };
  });
}

async function drainMailbox(ctx: Ctx) {
  const r = await ctx.c.query<{ id: number; event: Event }>("delete from mailbox where player_id = $1 returning id, event", [ctx.p.id]);
  for (const row of r.rows) ctx.events.push({ ...row.event, kind: "while_you_were_away", what: row.event.kind });
}

async function savePlayer(ctx: Ctx, patch: Partial<Player>) {
  const keys = Object.keys(patch) as (keyof Player)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const r = await ctx.c.query<Player>(`update players set ${sets} where id = $1 returning *`, [ctx.p.id, ...keys.map((k) => patch[k])]);
  ctx.p = r.rows[0];
}

async function saveTurns(ctx: Ctx, patch: Partial<Turns>) {
  const keys = Object.keys(patch) as (keyof Turns)[];
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const r = await ctx.c.query<Turns>(`update turns set ${sets} where player_id = $1 and day = $2 returning *`, [ctx.p.id, ctx.day, ...keys.map((k) => patch[k])]);
  ctx.t = r.rows[0];
}

async function post(ctx: Ctx, kind: string, actor: string | null, target: string | null, detail: Record<string, unknown> = {}) {
  await ctx.c.query("insert into news (day, kind, actor, target, detail) values ($1,$2,$3,$4,$5)", [ctx.day, kind, actor, target, detail]);
}

function requireAlive(ctx: Ctx) {
  if (!ctx.p.alive) throw new GameError("dead", "you are dead until the realm resets");
}

async function requireNoEncounter(ctx: Ctx) {
  const r = await ctx.c.query("select 1 from encounters where player_id = $1", [ctx.p.id]);
  if (r.rowCount) throw new GameError("in_encounter", "finish or flee your current fight first");
}

// ---------- register ----------

api.post("/register", async (c) => {
  const body = z.object({ name: z.string().min(2).max(20).regex(/^[A-Za-z0-9_ ]+$/), class: z.enum(["warrior", "thief", "mage"]) }).parse(await c.req.json());
  const key = "lord_" + randomBytes(24).toString("base64url");
  const out = await tx(async (db) => {
    const dup = await db.query("select 1 from players where lower(name) = lower($1)", [body.name]);
    if (dup.rowCount) throw new GameError("name_taken", "that name is taken", 409);
    const r = await db.query<Player>("insert into players (name, api_key_hash, class) values ($1,$2,$3) returning *", [body.name, hash(key), body.class]);
    const settings = await realmSettings(db);
    const day = realmDay(settings.resetHourUtc);
    await db.query("insert into news (day, kind, actor) values ($1,'join',$2)", [day, body.name]);
    return r.rows[0];
  });
  return c.json({ api_key: key, name: out.name, class: out.class, events: [{ kind: "joined", name: out.name, class: out.class }] });
});

// ---------- read-only ----------

api.get("/status", async (c) => c.json(await withPlayer(c.req.header("authorization"), async () => {})));

api.get("/news", async (c) => {
  const which = c.req.query("day") === "yesterday" ? -1 : 0;
  const compact = c.req.query("compact") === "1";
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const day = new Date(ctx.day + "T00:00:00Z");
    day.setUTCDate(day.getUTCDate() + which);
    const d = day.toISOString().slice(0, 10);
    const r = await ctx.c.query("select kind, actor, target, detail, ts from news where day = $1 order by id", [d]);
    if (compact) {
      ctx.events.push({ kind: "news_compact", day: d, lines: r.rows.map(newsLine) });
    } else {
      for (const row of r.rows) ctx.events.push({ kind: "news", day: d, ...row });
    }
  }));
});

function newsLine(n: { kind: string; actor: string | null; target: string | null; detail: Record<string, unknown> }): string {
  switch (n.kind) {
    case "join": return `${n.actor} has entered the realm.`;
    case "pvp_kill": return `${n.actor} slew ${n.target} in the fields and took ${n.detail.gold} gold.`;
    case "pvp_survived": return `${n.target} fought off an attack from ${n.actor}.`;
    case "forest_death": return `${n.actor} was killed in the forest by a ${n.detail.monster}.`;
    case "level_up": return `${n.actor} reached level ${n.detail.level}.`;
    case "dragon": return `${n.actor} slew the Red Dragon!`;
    case "dragon_death": return `${n.actor} was eaten by the Red Dragon.`;
    case "married": return `${n.actor} married Violet.`;
    default: return `${n.actor ?? "Someone"} did something (${n.kind}).`;
  }
}

api.get("/rankings", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const r = await ctx.c.query("select name, class, level, exp, alive, dragon_kills from players order by level desc, exp desc limit 20");
  ctx.events.push({ kind: "rankings", players: r.rows });
})));

api.get("/shop", async (c) => {
  const kind = c.req.query("kind") === "armor" ? "armor" : "weapon";
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    const items = kind === "armor" ? GAME.armor : GAME.weapons;
    const owned = kind === "armor" ? ctx.p.armor_id : ctx.p.weapon_id;
    ctx.events.push({ kind: "catalog", shop: kind, owned, items });
  }));
});

// ---------- forest ----------

api.post("/forest", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  await requireNoEncounter(ctx);
  if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left" }); return; }
  await saveTurns(ctx, { forest_fights: ctx.t.forest_fights - 1 });
  if (roll(99) < 10) {
    // found something instead of a fight
    const gold = roll(10 * ctx.p.level) + 5;
    await savePlayer(ctx, { gold: ctx.p.gold + gold });
    ctx.events.push({ kind: "found_gold", gold });
    return;
  }
  const m = pickMonster(ctx.p.level);
  await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'forest',$2)", [ctx.p.id, m]);
  ctx.events.push({ kind: "encounter", monster: m });
})));

api.post("/fight", async (c) => {
  const body = z.object({ action: z.enum(["attack", "special", "run"]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const r = await ctx.c.query<{ id: string; kind: string; monster: Monster; round: number }>("select id, kind, monster, round from encounters where player_id = $1", [ctx.p.id]);
    if (!r.rowCount) throw new GameError("no_encounter", "you are not in a fight");
    const enc = r.rows[0];
    const m = enc.monster;

    if (body.action === "run") {
      if (enc.kind === "master") { ctx.events.push({ kind: "cannot_run", reason: "your master will not let you leave" }); return; }
      if (fleeSucceeds(ctx.p)) {
        await ctx.c.query("delete from encounters where id = $1", [enc.id]);
        ctx.events.push({ kind: "fled", monster: m.name });
        return;
      }
      // failed to flee: monster gets a free swing
      const pf = playerAsFighter(ctx.p);
      const dmg = Math.max(0, roll(m.str) - roll(pf.def));
      await savePlayer(ctx, { hp: Math.max(0, ctx.p.hp - dmg) });
      ctx.events.push({ kind: "flee_failed", monster: m.name, damage: dmg, hp: ctx.p.hp });
      if (ctx.p.hp <= 0) await die(ctx, enc.kind, m);
      return;
    }

    let mult = 1;
    if (body.action === "special") {
      if (ctx.t.specials <= 0) { ctx.events.push({ kind: "no_specials_left" }); return; }
      await saveTurns(ctx, { specials: ctx.t.specials - 1 });
      mult = specialMultiplier(ctx.p);
    }

    const pf = playerAsFighter(ctx.p);
    const mf = monsterAsFighter(m);
    const evs = exchange(pf, mf, mult);
    ctx.events.push(...evs);
    m.hp = mf.hp;
    await savePlayer(ctx, { hp: pf.hp });

    if (mf.hp <= 0) {
      await ctx.c.query("delete from encounters where id = $1", [enc.id]);
      await win(ctx, enc.kind, m);
    } else if (pf.hp <= 0) {
      await ctx.c.query("delete from encounters where id = $1", [enc.id]);
      await die(ctx, enc.kind, m);
    } else {
      await ctx.c.query("update encounters set monster = $2, round = round + 1, log = log || $3::jsonb where id = $1", [enc.id, m, JSON.stringify(evs)]);
    }
  }));
});

async function win(ctx: Ctx, kind: string, m: Monster) {
  if (kind === "forest") {
    const next = expForLevel(ctx.p.level + 1);
    await savePlayer(ctx, { gold: ctx.p.gold + m.gold, exp: ctx.p.exp + m.exp });
    ctx.events.push({ kind: "monster_slain", monster: m.name, gold: m.gold, exp: m.exp });
    if (next !== null && ctx.p.exp >= next) ctx.events.push({ kind: "level_ready", level: ctx.p.level + 1 });
  } else if (kind === "master") {
    const cls = GAME.classes[ctx.p.class];
    const lvl = ctx.p.level + 1;
    await savePlayer(ctx, {
      level: lvl,
      max_hp: ctx.p.max_hp + cls.hpPerLevel,
      hp: ctx.p.max_hp + cls.hpPerLevel,
      str: ctx.p.str + cls.strPerLevel,
      def: ctx.p.def + cls.defPerLevel,
    });
    await post(ctx, "level_up", ctx.p.name, null, { level: lvl });
    ctx.events.push({ kind: "level_up", level: lvl, max_hp: ctx.p.max_hp, str: ctx.p.str, def: ctx.p.def });
  } else if (kind === "dragon") {
    await savePlayer(ctx, { dragon_kills: ctx.p.dragon_kills + 1, level: 1, exp: 0, hp: 20, max_hp: 20, str: 10, def: 1, weapon_id: 0, armor_id: 0, gold: 0, charm: ctx.p.charm + 10 });
    await ctx.c.query("update realm set value = 'false' where key = 'dragon_alive'");
    ctx.dragonAlive = false;
    await post(ctx, "dragon", ctx.p.name, null, {});
    ctx.events.push({ kind: "dragon_slain", dragon_kills: ctx.p.dragon_kills });
    ctx.hint = "This is the climax of the game. Go big, then explain they start over at level 1 with their dragon kill recorded.";
  }
}

async function die(ctx: Ctx, kind: string, m: Monster) {
  const lost = ctx.p.gold;
  const expLoss = Math.floor(ctx.p.exp * 0.1);
  await savePlayer(ctx, { alive: false, hp: 0, gold: 0, exp: ctx.p.exp - expLoss });
  if (kind === "dragon") await post(ctx, "dragon_death", ctx.p.name, null, {});
  else await post(ctx, "forest_death", ctx.p.name, null, { monster: m.name });
  ctx.events.push({ kind: "player_died", killer: m.name, gold_lost: lost, exp_lost: expLoss });
}

// ---------- train / dragon ----------

api.post("/train", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  await requireNoEncounter(ctx);
  const next = expForLevel(ctx.p.level + 1);
  if (next === null) { ctx.events.push({ kind: "max_level" }); return; }
  if (ctx.p.exp < next) { ctx.events.push({ kind: "not_ready", exp: ctx.p.exp, needed: next }); return; }
  const ms = master(ctx.p.level)!;
  const m: Monster = { name: ms.name, hp: ms.hp, max_hp: ms.hp, str: ms.str, def: ms.def, gold: 0, exp: 0 };
  await ctx.c.query("insert into encounters (player_id, kind, monster) values ($1,'master',$2)", [ctx.p.id, m]);
  ctx.events.push({ kind: "master_challenge", master: m, level: ctx.p.level + 1 });
  ctx.hint = "The master is testing them. Losing to a master is not fatal in the fiction; the server handles it.";
})));

api.post("/dragon", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  await requireNoEncounter(ctx);
  if (ctx.p.level < 12) { ctx.events.push({ kind: "too_weak", needed_level: 12 }); return; }
  if (!ctx.dragonAlive) { ctx.events.push({ kind: "dragon_dead" }); return; }
  if (ctx.t.forest_fights <= 0) { ctx.events.push({ kind: "no_fights_left" }); return; }
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
    const missing = ctx.p.max_hp - ctx.p.hp;
    const want = Math.min(missing, body.hp === "all" ? missing : body.hp);
    if (want <= 0) { ctx.events.push({ kind: "already_healthy" }); return; }
    const cost = want * GAME.healerCostPerHpPerLevel * ctx.p.level;
    if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold }); return; }
    await savePlayer(ctx, { hp: ctx.p.hp + want, gold: ctx.p.gold - cost });
    ctx.events.push({ kind: "healed", hp: want, cost });
  }));
});

api.post("/buy", async (c) => {
  const body = z.object({ kind: z.enum(["weapon", "armor"]), id: z.number().int() }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    const item = body.kind === "weapon" ? weapon(body.id) : armor(body.id);
    if (item.id !== body.id) throw new GameError("no_such_item", "no such item");
    const current = body.kind === "weapon" ? weapon(ctx.p.weapon_id) : armor(ctx.p.armor_id);
    const tradeIn = Math.floor(current.cost / 2);
    const cost = item.cost - tradeIn;
    if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold, trade_in: tradeIn }); return; }
    await savePlayer(ctx, { gold: ctx.p.gold - cost, ...(body.kind === "weapon" ? { weapon_id: item.id } : { armor_id: item.id }) });
    ctx.events.push({ kind: "bought", shop: body.kind, item: item.name, cost, trade_in: tradeIn });
  }));
});

api.post("/bank", async (c) => {
  const body = z.object({ op: z.enum(["deposit", "withdraw"]), amount: z.union([z.literal("all"), z.number().int().positive()]) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
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
  await requireNoEncounter(ctx);
  if (ctx.t.inn_used) { ctx.events.push({ kind: "already_at_inn" }); return; }
  const cost = GAME.innCostPerLevel * ctx.p.level;
  if (ctx.p.gold < cost) { ctx.events.push({ kind: "too_poor", cost, gold: ctx.p.gold }); return; }
  await savePlayer(ctx, { gold: ctx.p.gold - cost, location: "inn" });
  await saveTurns(ctx, { inn_used: true });
  ctx.events.push({ kind: "inn_sleep", cost });
  ctx.hint = "They are safe from other players until the realm resets, and will wake fully healed.";
})));

// ---------- tavern ----------

api.get("/tavern", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  const r = await ctx.c.query("select author, body, ts from tavern where day = $1 order by id desc limit 20", [ctx.day]);
  const online = await ctx.c.query("select name from players where last_seen > now() - interval '15 minutes' and id <> $1 limit 10", [ctx.p.id]);
  ctx.events.push({ kind: "tavern_messages", messages: r.rows.reverse() });
  ctx.events.push({ kind: "bartender", recently_seen: online.rows.map((x) => x.name), gem_price: 100 * ctx.p.level, flirted_today: ctx.t.flirted });
  ctx.hint = "Improvise here: the bartender's gossip, the mood of the room. Keep it under the posted messages, which are other players' words.";
})));

api.post("/tavern", async (c) => {
  const body = z.object({ body: z.string().trim().min(1).max(280) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    await ctx.c.query("insert into tavern (day, author, body) values ($1,$2,$3)", [ctx.day, ctx.p.name, body.body]);
    ctx.events.push({ kind: "posted" });
  }));
});

api.post("/flirt", async (c) => c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
  requireAlive(ctx);
  if (ctx.t.flirted) { ctx.events.push({ kind: "already_flirted" }); return; }
  await saveTurns(ctx, { flirted: true });
  const r = roll(99) + ctx.p.charm;
  let outcome: string; let delta = 0;
  if (r < 30) { outcome = "ignored"; }
  else if (r < 70) { outcome = "smile"; delta = 1; }
  else if (r < 95) { outcome = "kiss"; delta = 2; }
  else { outcome = "married"; delta = 5; await post(ctx, "married", ctx.p.name, null, {}); }
  await savePlayer(ctx, { charm: ctx.p.charm + delta });
  ctx.events.push({ kind: "flirt", outcome, charm_delta: delta, charm: ctx.p.charm });
})));

// ---------- pvp ----------

api.post("/challenge", async (c) => {
  const body = z.object({ name: z.string().min(1) }).parse(await c.req.json());
  return c.json(await withPlayer(c.req.header("authorization"), async (ctx) => {
    requireAlive(ctx);
    await requireNoEncounter(ctx);
    if (ctx.t.player_fights <= 0) { ctx.events.push({ kind: "no_player_fights_left" }); return; }
    if (body.name.toLowerCase() === ctx.p.name.toLowerCase()) throw new GameError("self", "you cannot fight yourself");
    const r = await ctx.c.query<Player>("select * from players where lower(name) = lower($1) for update", [body.name]);
    if (!r.rowCount) { ctx.events.push({ kind: "no_such_player", name: body.name }); return; }
    const d = r.rows[0];
    if (!d.alive) { ctx.events.push({ kind: "target_dead", name: d.name }); return; }
    if (d.location === "inn") { ctx.events.push({ kind: "target_at_inn", name: d.name }); return; }
    if (Math.abs(d.level - ctx.p.level) > 3) { ctx.events.push({ kind: "level_gap", name: d.name, their_level: d.level }); return; }

    await saveTurns(ctx, { player_fights: ctx.t.player_fights - 1 });
    const af = playerAsFighter(ctx.p);
    const df = playerAsFighter(d);
    const res = resolveFull(af, df);
    ctx.events.push({ kind: "pvp_log", opponent: d.name, rounds: res.log });

    if (res.winner === "attacker") {
      const gold = d.gold;
      const exp = Math.floor(expForLevel(d.level + 1) ?? 1000) / 20 | 0;
      await savePlayer(ctx, { hp: af.hp, gold: ctx.p.gold + gold, exp: ctx.p.exp + exp });
      await ctx.c.query("update players set alive = false, hp = 0, gold = 0 where id = $1", [d.id]);
      await ctx.c.query("insert into mailbox (player_id, event) values ($1, $2)", [d.id, { kind: "killed_by_player", by: ctx.p.name, gold_lost: gold }]);
      await post(ctx, "pvp_kill", ctx.p.name, d.name, { gold });
      ctx.events.push({ kind: "pvp_win", opponent: d.name, gold, exp });
    } else if (res.winner === "defender") {
      const lost = ctx.p.gold;
      await savePlayer(ctx, { hp: 0, alive: false, gold: 0 });
      await ctx.c.query("update players set hp = $2, gold = gold + $3 where id = $1", [d.id, df.hp, lost]);
      await ctx.c.query("insert into mailbox (player_id, event) values ($1, $2)", [d.id, { kind: "defended", against: ctx.p.name, gold_won: lost }]);
      await post(ctx, "pvp_survived", ctx.p.name, d.name, {});
      ctx.events.push({ kind: "pvp_loss", opponent: d.name, gold_lost: lost });
    } else {
      await savePlayer(ctx, { hp: af.hp });
      await ctx.c.query("update players set hp = $2 where id = $1", [d.id, df.hp]);
      ctx.events.push({ kind: "pvp_draw", opponent: d.name });
    }
  }));
});

// ---------- errors ----------

api.onError((err, c) => {
  if (err instanceof GameError) return c.json({ error: err.code, message: err.message }, err.status as 400);
  if (err instanceof z.ZodError) return c.json({ error: "bad_request", message: err.issues.map((i) => i.message).join("; ") }, 400);
  console.error(err);
  return c.json({ error: "internal", message: "something broke in the realm" }, 500);
});
