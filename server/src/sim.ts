/**
 * How long does it take to kill the Red Dragon?
 * Simulates a careful solo player: 10 forest fights a day, heals between fights,
 * buys the best gear they can afford, trains when ready, inn every night, no PvP.
 * Uses the real combat functions and data. Run: npx tsx src/sim.ts [class] [trials]
 */
import { GAME, armor, weapon, expForLevel, master, levelGains, manaMax, manaRules, type Player, type Monster } from "./game.js";
import { bardFor, pickGift } from "./bards.js";
import { visitorFor, pickVisitorGift } from "./square.js";
import { charmDiscount, charmLucky, flirtOutcome, spousePerk, suitor } from "./romance.js";
import { exchange, monsterAsFighter, pickMonster, playerAsFighter, roll, rollDrop, specialDodges, specialMultiplier } from "./combat.js";
import { boosted, forgeCost, rarity as rarityOf, RARITY } from "./rarity.js";
import { FINDS_PER_PERSON, SWINGS_PER_DAY, GEM_SELL, ORES, PICKAXE_COST, TRINKETS, canMake, caveLevel, swing, trinket } from "./caves.js";


// ---- tuning knobs (env) so the curve can be searched without editing data ----
const K = {
  mstr: Number(process.env.MSTR ?? 1),    // monster strength multiplier
  mhp: Number(process.env.MHP ?? 1),      // monster hp multiplier
  mgold: Number(process.env.MGOLD ?? 1),  // monster gold multiplier
  mexp: Number(process.env.MEXP ?? 1),    // monster exp multiplier
  pstr: Number(process.env.PSTR ?? 1),    // player str-per-level multiplier
  phpk: Number(process.env.PHP ?? 1),     // player hp-per-level multiplier
  pdef: Number(process.env.PDEF ?? 1),    // player def-per-level multiplier
  ghp: process.env.GHP, gstr: process.env.GSTR, gdef: process.env.GDEF, // growth overrides
};
if (process.env.DROP !== undefined) GAME.drops.chance = Number(process.env.DROP);
if (process.env.TDROP !== undefined) (GAME.classes.thief as { dropChance?: number }).dropChance = Number(process.env.TDROP);
if (process.env.DODGE !== undefined) (GAME.classes.thief as { specialDodge?: number }).specialDodge = Number(process.env.DODGE);
// mage experiments
const MAGE = {
  pierce: Number(process.env.PIERCE ?? 0),   // share of the target's defense a Fireball ignores
  regen: Number(process.env.REGEN ?? 0),     // share of max HP a mage gets back after each forest win
  expb: Number(process.env.MEXPB ?? 1),      // mage experience multiplier
};
// crit chances per class, and the crit multiplier, override game.json
for (const [k, cls] of [["WCRIT", "warrior"], ["TCRIT", "thief"], ["MCRIT", "mage"]] as const)
  if (process.env[k] !== undefined) (GAME.classes[cls] as { critChance?: number }).critChance = Number(process.env[k]);
if (process.env.CRITX) (GAME as { critMultiplier: number }).critMultiplier = Number(process.env.CRITX);
if (process.env.MAGE_HP) GAME.classes.mage.hpPerLevel = Number(process.env.MAGE_HP);
if (process.env.MAGE_DEF) GAME.classes.mage.defPerLevel = Number(process.env.MAGE_DEF);
if (process.env.MAGE_STR) GAME.classes.mage.strPerLevel = Number(process.env.MAGE_STR);
if (process.env.MAGE_MULT) GAME.classes.mage.specialMult = Number(process.env.MAGE_MULT);
if (process.env.MAGE_SPD) GAME.classes.mage.specialsPerDay = Number(process.env.MAGE_SPD);
// priest knobs: HEAL (mana), HEALPCT, HEALAT (heal below this share of HP), PR_HP/PR_STR/PR_DEF per level, PMULT
{ const pr = GAME.classes.priest as unknown as { mana: Record<string, number>; hpPerLevel: number; strPerLevel: number; defPerLevel: number; specialMult: number };
  if (process.env.HEAL) pr.mana.heal = Number(process.env.HEAL);
  if (process.env.HEALPCT) pr.mana.healPct = Number(process.env.HEALPCT);
  if (process.env.PR_HP) pr.hpPerLevel = Number(process.env.PR_HP);
  if (process.env.PR_STR) pr.strPerLevel = Number(process.env.PR_STR);
  if (process.env.PR_DEF) pr.defPerLevel = Number(process.env.PR_DEF);
  if (process.env.PMULT) pr.specialMult = Number(process.env.PMULT);
  if (process.env.PMANA_BASE) pr.mana.base = Number(process.env.PMANA_BASE);
  if (process.env.PMANA_LVL) pr.mana.perLevel = Number(process.env.PMANA_LVL); }
const HEALAT = Number(process.env.HEALAT ?? 0.4);
// Praying outside a fight: OOC_PRAY=1 turns it on; OOC_COST multiplies the mana cost; OOC_MAX caps prayers a day.
const OOC = { on: process.env.OOC_PRAY === "1", costMult: Number(process.env.OOC_COST ?? 1), max: Number(process.env.OOC_MAX ?? 99), prayers: 0 };
// mana knobs: MANA_BASE, MANA_LVL, CAST, FIREBALL, STAFF; MANA=0 plays the old mage (dagger and specials)
const MANA_ON = process.env.MANA !== "0";
{ const m = (GAME.classes.mage as { mana?: Record<string, number> }).mana!;
  for (const [k, f] of [["MANA_BASE", "base"], ["MANA_LVL", "perLevel"], ["CAST", "cast"], ["FIREBALL", "fireball"], ["STAFF", "staff"]] as const) if (process.env[k]) m[f] = Number(process.env[k]);
  if (!MANA_ON) delete (GAME.classes.mage as { mana?: unknown }).mana; }
if (process.env.DHP) GAME.dragon.hp = Number(process.env.DHP); if (process.env.DSTR) GAME.dragon.str = Number(process.env.DSTR); if (process.env.DDEF) GAME.dragon.def = Number(process.env.DDEF);
if (K.ghp) GAME.growth.hp = Number(K.ghp); if (K.gstr) GAME.growth.str = Number(K.gstr); if (K.gdef) GAME.growth.def = Number(K.gdef);
for (const m of GAME.monsters) { m.str = Math.round(m.str * K.mstr); m.hp = Math.round(m.hp * K.mhp); m.gold = Math.round(m.gold * K.mgold); m.exp = Math.round(m.exp * K.mexp); }
for (const m of GAME.masters) { m.str = Math.round(m.str * K.mstr); m.hp = Math.round(m.hp * K.mhp); }
for (const c of Object.values(GAME.classes)) { c.strPerLevel = Math.round(c.strPerLevel * K.pstr); c.hpPerLevel = Math.round(c.hpPerLevel * K.phpk); c.defPerLevel = Math.round(c.defPerLevel * K.pdef); }

// The daily extras a real player gets: a flirt, a bard's song, a word with the visitor. EXTRAS=0 turns them off.
const EXTRAS = process.env.EXTRAS !== "0";
// ROMANCE=1: charm discounts and luck, plus the chosen suitor's marriage perk. SUITOR picks who the player courts.
const ROMANCE = process.env.ROMANCE === "1";
const SUITOR = process.env.SUITOR ?? "Violet";
const CHARM = { total: 0, married: 0, marriedDay: 0 };
const simDate = (day: number) => new Date(Date.UTC(2026, 9, 1) + day * 86_400_000).toISOString().slice(0, 10);
type SimPlayer = Player & { spouse?: string };
const perkOf = (p: SimPlayer) => (p.spouse ? spousePerk(p.spouse) : null);
const healCost = (p: SimPlayer, hp: number) => Math.ceil(hp * GAME.healerCostPerHpPerLevel * p.level * (ROMANCE && perkOf(p) === "healer" ? 0.75 : 1));
const innCostSim = (p: SimPlayer) => Math.floor(GAME.innCostPerLevel * p.level * (perkOf(p) === "inn" ? 0.5 : 1));
const shopPrice = (p: SimPlayer, price: number) => (ROMANCE ? Math.ceil(price * (1 - charmDiscount(p.charm))) : price);

function dailyExtras(p: SimPlayer, day: number, fights: { n: number }) {
  if (!EXTRAS) return;
  // flirt
  if (p.spouse === SUITOR) p.charm += 1;
  else {
    const s = suitor(SUITOR)!;
    const f = flirtOutcome(p.charm, ROMANCE ? s.coy : 0);
    p.charm += f.delta;
    if (f.outcome === "married") { p.spouse = ROMANCE ? SUITOR : "Violet"; CHARM.married++; CHARM.marriedDay += day; }
  }
  if (ROMANCE && perkOf(p) === "charm") p.charm += 1;
  const apply = (gift: string, fightAmt: number) => {
    if (gift === "gold") p.gold += 25 * p.level;
    if (gift === "charm") p.charm += 1;
    if (gift === "gem") p.gems += 1;
    if (gift === "heal") p.hp = p.max_hp;
    if (gift === "fight") fights.n += fightAmt;
  };
  // the bard
  const bard = bardFor(simDate(day));
  let g: string = pickGift(bard);
  if (ROMANCE && g === "nothing" && charmLucky(p.charm)) g = pickGift(bard);
  apply(g, bard.fights);
  // the visitor
  const v = visitorFor(simDate(day));
  if (v) {
    let vg: string = pickVisitorGift(v);
    if (ROMANCE && vg === "nothing" && charmLucky(p.charm)) vg = pickVisitorGift(v);
    if (vg === "gold") p.gold += 15 * p.level; else apply(vg, 1);
  }
}

// EXPLORE=0 turns off the cost of walking out to a new ring of the map (one fight per new ring, the first time).
const EXPLORE = process.env.EXPLORE !== "0";

const DROPS = { n: 0, equipped: 0 };
const FORGE = process.env.FORGE === "1";
const FORGE_FROM = Number(process.env.FORGE_FROM ?? 5);
const FORGED = { n: 0, top: 0 };
const HEALER = { gold: 0 };
// MINE=1: from MINE_FROM onward, spend MINE_FIGHTS fights a day mining, and have Odile make the best jewelry you can.
const MINE = process.env.MINE === "1";
const MINE_FROM = Number(process.env.MINE_FROM ?? 4);
const MINE_FIGHTS = Number(process.env.MINE_FIGHTS ?? SWINGS_PER_DAY); // swings a day (not forest fights, unless SWING_COSTS_FIGHT=1)
const MINED = { trinkets: 0, best: 0 };
const LEVEL_DAY: Record<number, number> = {}; const LEVEL_N: Record<number, number> = {}; const DEATH_L: Record<number, number> = {};
type Cls = "warrior" | "thief" | "mage" | "priest";
// SNAP=path: write what each character looked like (stats and gear) the moment they reached each level, for pvp.ts.
const SNAPS: Record<string, unknown>[] | null = process.env.SNAP ? [] : null;

function fresh(cls: Cls): Player {
  return { id: "", name: "sim", class: cls, level: 1, exp: 0, hp: 20, max_hp: 20, str: 10, def: 1, gold: 100, bank: 0, gems: 0, charm: 0, weapon_id: 0, armor_id: 0, alive: true, location: "inn", dragon_kills: 0, bag_id: 0, ground: null, mail_notified_upto: 0, news_seen_upto: 0, client: null, weather_off: false, is_bot: false, role: "player", spouse_id: null, pos_x: null, pos_y: null, trinket_id: 0, pickaxe: false, cave_depth: null, pending_event: null, admin: false, is_test: false, banned_at: null, renamed_from: null, respec_at: null };
}

function fight(p: Player, m: Monster, specials: { n: number }, runBelow: number): "won" | "fled" | "died" {
  const pf = playerAsFighter(p);
  const mf = monsterAsFighter(m);
  for (let r = 0; r < 200; r++) {
    if (r > 0 && pf.hp / p.max_hp < runBelow && runBelow > 0) {
      const chance = p.class === "thief" ? 85 : 65;
      if (roll(99) < chance) { p.hp = pf.hp; return "fled"; }
      const dmg = Math.max(0, roll(mf.str) - roll(pf.def));
      pf.hp = Math.max(0, pf.hp - dmg);
      if (pf.hp <= 0) { p.hp = 0; return "died"; }
      continue;
    }
    let mult = 1, dodge = false;
    const mr = manaRules(p.class);
    if (mr) {
      // A caster's round: Fireball on a tough target if there's mana to spare, else a spell, else the staff.
      const full = pf.str;
      // A healer patches up when it's getting bad, if there's mana; the monster still swings.
      if (mr.heal && specials.n >= mr.heal && pf.hp / p.max_hp < HEALAT) {
        specials.n -= mr.heal;
        pf.hp = Math.min(p.max_hp, pf.hp + Math.ceil(p.max_hp * (mr.healPct ?? 0.3)));
        const dmg = Math.max(0, roll(mf.str) - roll(pf.def));
        pf.hp = Math.max(0, pf.hp - dmg);
        if (pf.hp <= 0) { p.hp = 0; return "died"; }
        continue;
      }
      if (specials.n >= mr.fireball && mf.hp > full * 1.5) { mult = specialMultiplier(p); specials.n -= mr.fireball; }
      else if (specials.n >= mr.cast) specials.n -= mr.cast;
      else pf.str = Math.round(full * mr.staff);
      exchange(pf, mf, mult, false);
      pf.str = full;
    } else {
      if (specials.n > 0 && mf.hp > pf.str * 1.5) { mult = specialMultiplier(p); dodge = specialDodges(p); specials.n--; }
      if (mult > 1 && p.class === "mage" && MAGE.pierce > 0) {
        const armour = mf.def; mf.def = Math.round(armour * (1 - MAGE.pierce));
        exchange(pf, mf, mult, dodge); mf.def = armour;
      } else exchange(pf, mf, mult, dodge);
    }
    if (mf.hp <= 0) { p.hp = pf.hp; return "won"; }
    if (pf.hp <= 0) { p.hp = 0; return "died"; }
  }
  p.hp = pf.hp;
  return "fled";
}

function shop(p: SimPlayer) {
  // Buy the best weapon we can afford out of gold+bank, then armor. Withdraw only what the purchase costs.
  // A forged piece is only replaced by something stronger than it is now.
  const reserve = GAME.innCostPerLevel * p.level + 50;
  for (const kind of ["weapon", "armor"] as const) {
    const list = kind === "weapon" ? GAME.weapons : GAME.armor;
    const cur = kind === "weapon" ? weapon(p.weapon_id) : armor(p.armor_id);
    const r = kind === "weapon" ? p.weapon_rarity ?? 0 : p.armor_rarity ?? 0;
    const stat = (it: { str?: number; def?: number }, rr: number) => boosted(kind === "weapon" ? it.str ?? 0 : it.def ?? 0, rr);
    const tradeIn = Math.floor(cur.cost * rarityOf(r).value / 2);
    let best = cur;
    for (const it of list) if (stat(it, 0) > stat(cur, r) && it.id > best.id && shopPrice(p, it.cost - tradeIn) <= p.gold + p.bank - reserve) best = it;
    if (best.id !== cur.id) {
      const price = shopPrice(p, best.cost - tradeIn);
      if (p.gold < price) { p.bank -= price - p.gold; p.gold = price; }
      p.gold -= price;
      if (kind === "weapon") { p.weapon_id = best.id; p.weapon_rarity = 0; } else { p.armor_id = best.id; p.armor_rarity = 0; }
    }
  }
  // FORGE=1: from FORGE_FROM (default 5, when Ironhold is in reach), forge what's worn with gold to spare.
  // Ore is bought at its full worth (at auction, say), so a non-miner can forge too.
  if (FORGE && p.level >= FORGE_FROM) {
    for (const kind of ["weapon", "armor"] as const) {
      const id = kind === "weapon" ? p.weapon_id : p.armor_id;
      const r = kind === "weapon" ? p.weapon_rarity ?? 0 : p.armor_rarity ?? 0;
      if (!id || (kind === "weapon" && manaRules(p.class))) continue;
      const base = kind === "weapon" ? weapon(id) : armor(id);
      const c = forgeCost(base.cost, r);
      if (!c) continue;
      const oreGold = Object.entries(c.ore).reduce((n, [o, k]) => n + ORES[Number(o)].cost * (k ?? 0), 0) + c.gems * GEM_SELL * 2;
      const price = c.gold + oreGold;
      if (p.gold + p.bank - reserve * 3 < price) continue;
      if (p.gold < price) { p.bank -= price - p.gold; p.gold = price; }
      p.gold -= price;
      if (kind === "weapon") p.weapon_rarity = r + 1; else p.armor_rarity = r + 1;
      FORGED.n++; FORGED.top = Math.max(FORGED.top, r + 1);
    }
  }
}

function simulate(cls: Cls, maxDays = 365): { days: number; deaths: number; killedDragon: boolean; level?: number } {
  const p: SimPlayer = fresh(cls);
  let deaths = 0;
  let farthest = 0; // ring reached so far
  const ores: Record<number, number> = {};
  for (let day = 1; day <= maxDays; day++) {
    // morning: inn heal (we always sleep at the inn if we could afford it)
    if (p.location === "inn" || !p.alive) p.hp = p.max_hp;
    p.alive = true;
    p.gold += 0; // bank -> withdraw happens below
    // For casters this is the day's mana; for everyone else, specials.
    const specials = { n: manaRules(p.class) ? manaMax(p) : GAME.classes[p.class].specialsPerDay };
    const extra = { n: 0 };
    const oocUsed = { n: 0 };
    dailyExtras(p, day, extra);
    let fights = 10 + extra.n;
    CHARM.total += p.charm;

    shop(p);

    if (MINE && p.level >= MINE_FROM) {
      if (!p.pickaxe && p.gold + p.bank >= PICKAXE_COST + 200) { const need = PICKAXE_COST; if (p.gold < need) { p.gold += p.bank; p.bank = 0; } p.gold -= need; p.pickaxe = true; }
      if (p.pickaxe) {
        const depth = Number(process.env.MINE_DEPTH ?? 0) || (p.level >= 9 ? 3 : p.level >= 6 ? 2 : 1);
        let found = 0;
        for (let k = 0; k < MINE_FIGHTS && fights > 0 && p.alive && found < FINDS_PER_PERSON.player; k++) {
          if (process.env.SWING_COSTS_FIGHT === "1") fights--;
          const r = swing(depth);
          if (r.kind === "ambush") {
            const am = pickMonster(caveLevel(p.level, depth));
            const res = fight(p, am, specials, 0.5);
            if (res === "won") { p.gold += am.gold; p.exp += am.exp; }
            if (res === "died") { DEATH_L[p.level] = (DEATH_L[p.level] ?? 0) + 1; deaths++; p.alive = false; p.gold = 0; p.exp -= Math.floor(p.exp * 0.1); }
          } else if (r.kind === "gem") { p.gems++; found++; }
          else if (r.kind === "ore") { ores[r.ore.id] = (ores[r.ore.id] ?? 0) + 1; found++; }
        }
        // the best piece Odile can make that beats what's worn (strength first, then defense), else sell spare copper
        const worn = trinket(p.trinket_id);
        const best = TRINKETS.filter((x) => x.id > 0 && x.charm === 0 && x.str + x.def > worn.str + worn.def && canMake(x, { ore: ores, gems: p.gems, gold: p.gold + p.bank }))
          .sort((a, z) => z.str + z.def - (a.str + a.def) || z.str - a.str)[0];
        if (best) {
          for (const [o, n] of Object.entries(best.needs.ore)) ores[Number(o)] -= n ?? 0;
          p.gems -= best.needs.gems;
          if (p.gold < best.needs.fee) { p.gold += p.bank; p.bank = 0; }
          p.gold -= best.needs.fee;
          p.trinket_id = best.id;
          MINED.trinkets++; MINED.best = Math.max(MINED.best, best.id);
        }
        // sell ore you've outgrown (copper once you wear silver, and so on) and gems past a handful
        const tier = p.trinket_id >= 7 ? 2 : p.trinket_id >= 4 ? 1 : p.trinket_id >= 1 ? 0 : -1;
        for (let o = 0; o <= tier; o++) if (o < tier || tier === 2) { p.gold += Math.floor((ores[o] ?? 0) * ORES[o].cost * GAME.sellFraction); ores[o] = 0; }
        if (p.gems > 6) { p.gold += (p.gems - 6) * GEM_SELL; p.gems = 6; }
      }
      if (!p.alive) continue;
    }

    while (fights > 0 && p.alive) {
      // train first if ready
      const next = expForLevel(p.level + 1);
      if (next !== null && p.exp >= next) {
        const ms = master(p.level)!;
        { const want = p.max_hp - p.hp; const cost = healCost(p, want); const avail = p.gold + p.bank; if (avail >= cost) { if (p.gold < cost) { p.gold += p.bank; p.bank = 0; } p.gold -= cost; p.hp = p.max_hp; } }
        const res = fight(p, { name: ms.name, hp: ms.hp, max_hp: ms.hp, str: ms.str, def: ms.def, gold: 0, exp: 0 }, specials, 0);
        if (res === "won") {
          const g = levelGains(p.class, p.level + 1);
          p.level++; p.max_hp += g.hp; p.hp = p.max_hp; p.str += g.str; p.def += g.def;
          LEVEL_DAY[p.level] = (LEVEL_DAY[p.level] ?? 0) + day; LEVEL_N[p.level] = (LEVEL_N[p.level] ?? 0) + 1;
          shop(p);
          if (SNAPS) SNAPS.push({ class: p.class, level: p.level, max_hp: p.max_hp, str: p.str, def: p.def, weapon_id: p.weapon_id, armor_id: p.armor_id, trinket_id: p.trinket_id });
          continue;
        }
        if (res === "died") { DEATH_L[p.level] = (DEATH_L[p.level] ?? 0) + 1; deaths++; p.alive = false; p.gold = 0; p.exp -= Math.floor(p.exp * 0.1); break; }
      }
      // dragon at 12
      if (p.level >= 12) {
        fights--;
        const d = GAME.dragon;
        const res = fight(p, { name: d.name, hp: d.hp, max_hp: d.hp, str: d.str, def: d.def, gold: 0, exp: 0 }, specials, 0);
        if (res === "won") return { days: day, deaths, killedDragon: true };
        if (res === "died") { DEATH_L[p.level] = (DEATH_L[p.level] ?? 0) + 1; deaths++; p.alive = false; p.gold = 0; p.exp -= Math.floor(p.exp * 0.1); break; }
        // fled: heal and try again tomorrow
        p.hp = p.max_hp; continue;
      }
      // walk out to the ring that matches your level, the first time (known paths are free after that)
      if (EXPLORE && p.level > farthest) { const steps = p.level - farthest; farthest = p.level; fights -= steps; if (fights <= 0) break; }
      // ordinary forest fight
      fights--;
      if (roll(99) < 10) { p.gold += roll(10 * p.level) + 5; continue; }
      const m = pickMonster(p.level);
      const res = fight(p, m, specials, 0.5);
      if (res === "won") {
        p.gold += m.gold; p.exp += p.class === "mage" ? Math.round(m.exp * MAGE.expb) : m.exp;
        if (p.class === "mage" && MAGE.regen > 0) p.hp = Math.min(p.max_hp, p.hp + Math.round(p.max_hp * MAGE.regen));
        const drop = rollDrop(m.level ?? p.level, p.class);
        if (drop) {
          // careful player: wear it if it's better and sell the old piece, otherwise sell the drop (half price)
          DROPS.n++;
          const curId = drop.kind === "weapon" ? p.weapon_id : p.armor_id;
          const cur = drop.kind === "weapon" ? weapon(curId) : armor(curId);
          const found = drop.kind === "weapon" ? weapon(drop.tier) : armor(drop.tier);
          if (drop.tier > curId) {
            DROPS.equipped++;
            p.gold += Math.floor(cur.cost * GAME.sellFraction);
            if (drop.kind === "weapon") p.weapon_id = drop.tier; else p.armor_id = drop.tier;
          } else {
            p.gold += Math.floor(found.cost * GAME.sellFraction);
          }
        }
      }
      if (res === "died") { DEATH_L[p.level] = (DEATH_L[p.level] ?? 0) + 1; deaths++; p.alive = false; p.gold = 0; p.exp -= Math.floor(p.exp * 0.1); break; }
      // A priest can pray between fights (OOC_PRAY=1): mana for health instead of the healer's gold.
      if (OOC.on && p.class === "priest") {
        const mr = manaRules(p.class)!;
        const cost = Math.ceil((mr.heal ?? 3) * OOC.costMult);
        while (p.hp / p.max_hp < 0.8 && specials.n >= cost && oocUsed.n < OOC.max) {
          specials.n -= cost; oocUsed.n++; OOC.prayers++;
          p.hp = Math.min(p.max_hp, p.hp + Math.ceil(p.max_hp * (mr.healPct ?? 0.35)));
        }
      }
      // heal if under 80%
      if (p.hp / p.max_hp < 0.8) {
        const want = p.max_hp - p.hp;
        const cost = healCost(p, want);
        if (p.gold >= cost) { p.gold -= cost; p.hp = p.max_hp; HEALER.gold += cost; }
      }
      // bank what we don't need to carry (a careful player does this every couple of fights)
      const keep = GAME.innCostPerLevel * p.level + p.max_hp * p.level;
      if (p.gold > keep) { p.bank += p.gold - keep; p.gold = keep; }
    }
    // night: inn if affordable, bank the rest
    const inn = innCostSim(p);
    if (p.alive && p.gold >= inn) { p.gold -= inn; p.location = "inn"; } else p.location = "fields";
    p.bank += p.gold; p.gold = 0;
  }
  return { days: maxDays, deaths, killedDragon: false, level: p.level };
}

const cls = (process.argv[2] as Cls) ?? "warrior";
const trials = Number(process.argv[3] ?? 200);
const runs = Array.from({ length: trials }, () => simulate(cls));
const done = runs.filter((r) => r.killedDragon).map((r) => r.days).sort((a, b) => a - b);
const q = (f: number) => done[Math.min(done.length - 1, Math.floor(done.length * f))];
console.log(`${cls}: ${done.length}/${trials} killed the dragon within a year`);
if (done.length) console.log(`  days  min ${done[0]}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${done[done.length - 1]}`);
console.log(`  deaths along the way: avg ${(runs.reduce((a, r) => a + r.deaths, 0) / trials).toFixed(1)}`);
const stuck = runs.filter((r) => !r.killedDragon).map((r) => r.level ?? 0);
if (stuck.length) console.log(`  non-finishers ended at level: avg ${(stuck.reduce((a, b) => a + b, 0) / stuck.length).toFixed(1)}`);

if (process.env.BREAKDOWN) {
  const rows = Object.keys(LEVEL_DAY).map(Number).sort((a, b) => a - b).map((l) => `L${l}: day ${(LEVEL_DAY[l] / LEVEL_N[l]).toFixed(0)}`);
  console.log("  avg day reached:", rows.join("  "));
  console.log("  deaths by level:", Object.keys(DEATH_L).map(Number).sort((a, b) => a - b).map((l) => `L${l}:${(DEATH_L[l] / trials).toFixed(1)}`).join("  "));
}

if (MINE) console.log(`  jewelry made per run: ${(MINED.trinkets / trials).toFixed(1)}, best ever: ${trinket(MINED.best).name}`);
if (FORGE) console.log(`  forgings per run: ${(FORGED.n / trials).toFixed(1)}; best reached: ${RARITY[FORGED.top].name}`);
console.log(`  healer gold per run: ${Math.round(HEALER.gold / trials)}${OOC.on ? `; prayers outside fights per run: ${(OOC.prayers / trials).toFixed(0)}` : ""}`);
console.log(`  drops per run: ${(DROPS.n / trials).toFixed(1)} (${(DROPS.equipped / trials).toFixed(1)} equipped)`);
if (EXTRAS) console.log(`  married ${CHARM.married}/${trials} runs (avg day ${CHARM.married ? (CHARM.marriedDay / CHARM.married).toFixed(0) : "-"}); avg charm across days ${(CHARM.total / runs.reduce((a, r) => a + r.days, 0)).toFixed(0)}`);
if (SNAPS) { (await import("node:fs")).writeFileSync(process.env.SNAP!, JSON.stringify(SNAPS)); console.log(`  wrote ${SNAPS.length} level snapshots to ${process.env.SNAP}`); }
