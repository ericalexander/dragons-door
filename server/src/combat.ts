import { randomInt } from "node:crypto";
import { BESTIARY, type Region } from "./bestiary.js";
import { GAME, armor, effective, manaRules, specialName, weapon, weaponName, type Event, type Monster, type Player } from "./game.js";

/** rand in [0, n], inclusive. Server RNG only; never trust the client. */
export function roll(n: number): number {
  if (n <= 0) return 0;
  return randomInt(0, n + 1);
}

export interface Fighter {
  name: string;
  hp: number;
  str: number;
  def: number;
  /** Chance each swing lands as a critical hit. Players only; monsters never crit. */
  crit?: number;
}

export function playerAsFighter(p: Player): Fighter {
  const e = effective(p);
  return { name: p.name, hp: p.hp, str: e.str, def: e.def, crit: (GAME.classes[p.class] as { critChance?: number }).critChance ?? 0 };
}

const crits = (f: Fighter) => (f.crit ?? 0) > 0 && roll(9999) < Math.round((f.crit ?? 0) * 10000);

export function monsterAsFighter(m: Monster): Fighter {
  return { name: m.name, hp: m.hp, str: m.str, def: m.def };
}

/**
 * One exchange: attacker swings, then defender swings back if still standing.
 * Mutates hp on both fighters, returns the events in order.
 */
export function exchange(att: Fighter, def: Fighter, attMult = 1, dodge = false): Event[] {
  const events: Event[] = [];
  const crit = crits(att);
  const dmg = Math.max(0, Math.round((roll(att.str) - roll(def.def)) * attMult * (crit ? GAME.critMultiplier : 1)));
  if (dmg > 0) {
    def.hp = Math.max(0, def.hp - dmg);
    events.push({ kind: "hit", attacker: att.name, defender: def.name, damage: dmg, defender_hp: def.hp, special: attMult > 1, ...(crit ? { crit: true } : {}) });
  } else {
    events.push({ kind: "miss", attacker: att.name, defender: def.name, special: attMult > 1 });
  }
  if (def.hp <= 0) return events;
  if (dodge) {
    events.push({ kind: "dodged", attacker: def.name, defender: att.name });
    return events;
  }

  const backCrit = crits(def);
  const back = Math.max(0, (roll(def.str) - roll(att.def)) * (backCrit ? GAME.critMultiplier : 1));
  if (back > 0) {
    att.hp = Math.max(0, att.hp - back);
    events.push({ kind: "hit", attacker: def.name, defender: att.name, damage: back, defender_hp: att.hp, ...(backCrit ? { crit: true } : {}) });
  } else {
    events.push({ kind: "miss", attacker: def.name, defender: att.name });
  }
  return events;
}

/** Can the player escape? Thieves are slippery. */
export function fleeSucceeds(p: Player): boolean {
  const chance = p.class === "thief" ? 85 : 65;
  return roll(99) < chance;
}

export function specialMultiplier(p: Player): number {
  return GAME.classes[p.class].specialMult;
}

/** Does this special also slip the counterattack? Thieves' Sneak Attack does, at the class's dodge chance. */
export function specialDodges(p: Player): boolean {
  const chance = (GAME.classes[p.class] as { specialDodge?: number }).specialDodge ?? 0;
  return chance > 0 && roll(99) < Math.round(chance * 100);
}

/** Pick a forest monster at or near the player's level. */
export function pickMonster(level: number, region?: Region): Monster {
  // Mostly your level. Sometimes easier. Rarely one up, and never at level 1.
  const r = roll(99);
  let want = level;
  if (r < 20 && level > 1) want = level - 1;
  else if (r >= 95 && level > 1) want = level + 1;
  want = Math.max(1, Math.min(12, want));
  const pool = GAME.monsters.filter((m) => m.level === want);
  // Where you are decides who it is; the old monster at the same place in the level's list decides how it fights.
  const names = region && region !== "forest" ? BESTIARY[region][want] : undefined;
  const i = roll((names?.length ?? pool.length) - 1);
  const m = pool[i % pool.length];
  // jitter so two fights are never identical
  const hp = Math.round(m.hp * (0.9 + roll(20) / 100));
  return { name: names?.[i] ?? m.name, level: m.level, hp, max_hp: hp, str: m.str, def: m.def, gold: m.gold, exp: m.exp };
}

/**
 * Resolve a full fight to the end with no choices (PvP vs an offline defender, or any
 * fight where the attacker just attacks every round). Caps rounds to stop stalemates.
 */
export function resolveFull(att: Fighter, def: Fighter, maxRounds = 50): { log: Event[]; winner: "attacker" | "defender" | "draw" } {
  const log: Event[] = [];
  for (let r = 1; r <= maxRounds; r++) {
    log.push(...exchange(att, def));
    if (def.hp <= 0) return { log, winner: "attacker" };
    if (att.hp <= 0) return { log, winner: "defender" };
  }
  return { log, winner: "draw" };
}

/** In one duel, at most this many big moves (a special, or a caster's big spell) and prayers for healing each. */
export const DUEL_LIMITS = { big: Number(process.env.DUEL_BIG ?? 3), heals: Number(process.env.DUEL_HEALS ?? 1) };

/** One side of a duel: the player, and what they have left today to fight with. */
export interface Duelist { p: Player; specials: number; mana: number }

/**
 * A fight between two players, both fighting the way a careful player would with what they have
 * left today: a priest prays when it's going badly, a caster throws its big spell while the mana
 * lasts and its ordinary one after that, then the staff; a warrior or thief spends a special each
 * round until they're gone (a thief's Sneak Attack can slip the swing back). The attacker acts
 * first each round, then the defender. Mutates hp, specials and mana on both sides.
 */
export function resolveDuel(a: Duelist, d: Duelist, limits = DUEL_LIMITS, maxRounds = 50): { log: Event[]; winner: "attacker" | "defender" | "draw"; a: Fighter; d: Fighter } {
  const af = playerAsFighter(a.p), df = playerAsFighter(d.p);
  const log: Event[] = [];
  let skip: "a" | "d" | null = null;
  const used = { a: { big: 0, heals: 0 }, d: { big: 0, heals: 0 } };
  const act = (me: Duelist, mf: Fighter, foe: Fighter, side: "a" | "d") => {
    if (skip === side) { skip = null; log.push({ kind: "dodged", attacker: mf.name, defender: foe.name }); return; }
    const mr = manaRules(me.p.class);
    if (mr?.heal && me.mana >= mr.heal && used[side].heals < limits.heals && mf.hp / me.p.max_hp < 0.4) {
      me.mana -= mr.heal; used[side].heals++;
      const healed = Math.min(me.p.max_hp - mf.hp, Math.ceil(me.p.max_hp * (mr.healPct ?? 0.3)));
      mf.hp += healed;
      log.push({ kind: "healed_self", who: mf.name, healed, hp: mf.hp });
      return;
    }
    let mult = 1, dodge = false, str = mf.str, move: string | undefined;
    if (mr) {
      if (me.mana >= mr.fireball && used[side].big < limits.big) { me.mana -= mr.fireball; used[side].big++; mult = specialMultiplier(me.p); move = specialName(me.p.class, me.p.weapon_id); }
      else if (me.mana >= mr.cast) { me.mana -= mr.cast; move = weaponName(me.p.class, me.p.weapon_id); }
      else { str = Math.round(mf.str * mr.staff); move = "staff"; }
    } else if (me.specials > 0 && used[side].big < limits.big) {
      me.specials--; used[side].big++; mult = specialMultiplier(me.p); dodge = specialDodges(me.p); move = GAME.classes[me.p.class].special;
    }
    const crit = crits(mf);
    const dmg = Math.max(0, Math.round((roll(str) - roll(foe.def)) * mult * (crit ? GAME.critMultiplier : 1)));
    if (dmg > 0) {
      foe.hp = Math.max(0, foe.hp - dmg);
      log.push({ kind: "hit", attacker: mf.name, defender: foe.name, damage: dmg, defender_hp: foe.hp, special: mult > 1, ...(move ? { move } : {}), ...(crit ? { crit: true } : {}) });
    } else log.push({ kind: "miss", attacker: mf.name, defender: foe.name, special: mult > 1, ...(move ? { move } : {}) });
    if (dodge && foe.hp > 0) skip = side === "a" ? "d" : "a";
  };
  for (let r = 1; r <= maxRounds; r++) {
    act(a, af, df, "a");
    if (df.hp <= 0) return { log, winner: "attacker", a: af, d: df };
    act(d, df, af, "d");
    if (af.hp <= 0) return { log, winner: "defender", a: af, d: df };
  }
  return { log, winner: "draw", a: af, d: df };
}

export interface Drop {
  kind: "weapon" | "armor";
  item: string;
  tier: number;
}

/** Rare drop after a forest kill: a piece of gear one tier above the monster's level. Pure; the caller decides where it goes. */
export function rollDrop(monsterLevel: number, cls?: Player["class"]): Drop | null {
  const cfg = GAME.drops;
  const chance = (cls && (GAME.classes[cls] as { dropChance?: number }).dropChance) || cfg.chance;
  if (roll(9999) >= Math.round(chance * 10000)) return null;
  const kind: Drop["kind"] = roll(1) === 0 ? "weapon" : "armor";
  const tier = Math.min(12, Math.max(1, monsterLevel + cfg.tierAbove));
  return { kind, item: (kind === "weapon" ? weapon(tier) : armor(tier)).name, tier };
}
