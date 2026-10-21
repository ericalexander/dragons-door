/**
 * How long does it take to kill the Red Dragon?
 * Simulates a careful solo player: 10 forest fights a day, heals between fights,
 * buys the best gear they can afford, trains when ready, inn every night, no PvP.
 * Uses the real combat functions and data. Run: npx tsx src/sim.ts [class] [trials]
 */
import { GAME, armor, weapon, expForLevel, master, levelGains, type Player, type Monster } from "./game.js";
import { bardFor, pickGift } from "./bards.js";
import { visitorFor, pickVisitorGift } from "./square.js";
import { charmDiscount, charmLucky, flirtOutcome, spousePerk, suitor } from "./romance.js";
import { exchange, monsterAsFighter, pickMonster, playerAsFighter, roll, rollDrop, specialDodges, specialMultiplier } from "./combat.js";


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
const LEVEL_DAY: Record<number, number> = {}; const LEVEL_N: Record<number, number> = {}; const DEATH_L: Record<number, number> = {};
type Cls = "warrior" | "thief" | "mage";

function fresh(cls: Cls): Player {
  return { id: "", name: "sim", class: cls, level: 1, exp: 0, hp: 20, max_hp: 20, str: 10, def: 1, gold: 100, bank: 0, gems: 0, charm: 0, weapon_id: 0, armor_id: 0, alive: true, location: "inn", dragon_kills: 0, bag_id: 0, ground: null, mail_notified_upto: 0, news_seen_upto: 0, client: null, weather_off: false, is_bot: false, role: "player", spouse_id: null, pos_x: null, pos_y: null };
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
    if (specials.n > 0 && mf.hp > pf.str * 1.5) { mult = specialMultiplier(p); dodge = specialDodges(p); specials.n--; }
    if (mult > 1 && p.class === "mage" && MAGE.pierce > 0) {
      const armour = mf.def; mf.def = Math.round(armour * (1 - MAGE.pierce));
      exchange(pf, mf, mult, dodge); mf.def = armour;
    } else exchange(pf, mf, mult, dodge);
    if (mf.hp <= 0) { p.hp = pf.hp; return "won"; }
    if (pf.hp <= 0) { p.hp = 0; return "died"; }
  }
  p.hp = pf.hp;
  return "fled";
}

function shop(p: SimPlayer) {
  // Buy the best weapon we can afford out of gold+bank, then armor. Withdraw only what the purchase costs.
  const reserve = GAME.innCostPerLevel * p.level + 50;
  for (const kind of ["weapon", "armor"] as const) {
    const list = kind === "weapon" ? GAME.weapons : GAME.armor;
    const cur = kind === "weapon" ? weapon(p.weapon_id) : armor(p.armor_id);
    let best = cur;
    for (const it of list) if (it.id > cur.id && shopPrice(p, it.cost - Math.floor(cur.cost / 2)) <= p.gold + p.bank - reserve) best = it;
    if (best.id !== cur.id) {
      const price = shopPrice(p, best.cost - Math.floor(cur.cost / 2));
      if (p.gold < price) { p.bank -= price - p.gold; p.gold = price; }
      p.gold -= price;
      if (kind === "weapon") p.weapon_id = best.id; else p.armor_id = best.id;
    }
  }
}

function simulate(cls: Cls, maxDays = 365): { days: number; deaths: number; killedDragon: boolean; level?: number } {
  const p: SimPlayer = fresh(cls);
  let deaths = 0;
  let farthest = 0; // ring reached so far
  for (let day = 1; day <= maxDays; day++) {
    // morning: inn heal (we always sleep at the inn if we could afford it)
    if (p.location === "inn" || !p.alive) p.hp = p.max_hp;
    p.alive = true;
    p.gold += 0; // bank -> withdraw happens below
    const specials = { n: GAME.classes[p.class].specialsPerDay };
    const extra = { n: 0 };
    dailyExtras(p, day, extra);
    let fights = 10 + extra.n;
    CHARM.total += p.charm;

    shop(p);

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
      // heal if under 80%
      if (p.hp / p.max_hp < 0.8) {
        const want = p.max_hp - p.hp;
        const cost = healCost(p, want);
        if (p.gold >= cost) { p.gold -= cost; p.hp = p.max_hp; }
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

console.log(`  drops per run: ${(DROPS.n / trials).toFixed(1)} (${(DROPS.equipped / trials).toFixed(1)} equipped)`);
if (EXTRAS) console.log(`  married ${CHARM.married}/${trials} runs (avg day ${CHARM.married ? (CHARM.marriedDay / CHARM.married).toFixed(0) : "-"}); avg charm across days ${(CHARM.total / runs.reduce((a, r) => a + r.days, 0)).toFixed(0)}`);
