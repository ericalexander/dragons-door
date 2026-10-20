import { randomInt } from "node:crypto";
import { GAME, armor, effective, weapon, type Event, type Monster, type Player } from "./game.js";

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
}

export function playerAsFighter(p: Player): Fighter {
  const e = effective(p);
  return { name: p.name, hp: p.hp, str: e.str, def: e.def };
}

export function monsterAsFighter(m: Monster): Fighter {
  return { name: m.name, hp: m.hp, str: m.str, def: m.def };
}

/**
 * One exchange: attacker swings, then defender swings back if still standing.
 * Mutates hp on both fighters, returns the events in order.
 */
export function exchange(att: Fighter, def: Fighter, attMult = 1, dodge = false): Event[] {
  const events: Event[] = [];
  const dmg = Math.max(0, Math.round((roll(att.str) - roll(def.def)) * attMult));
  if (dmg > 0) {
    def.hp = Math.max(0, def.hp - dmg);
    events.push({ kind: "hit", attacker: att.name, defender: def.name, damage: dmg, defender_hp: def.hp, special: attMult > 1 });
  } else {
    events.push({ kind: "miss", attacker: att.name, defender: def.name, special: attMult > 1 });
  }
  if (def.hp <= 0) return events;
  if (dodge) {
    events.push({ kind: "dodged", attacker: def.name, defender: att.name });
    return events;
  }

  const back = Math.max(0, roll(def.str) - roll(att.def));
  if (back > 0) {
    att.hp = Math.max(0, att.hp - back);
    events.push({ kind: "hit", attacker: def.name, defender: att.name, damage: back, defender_hp: att.hp });
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
export function pickMonster(level: number): Monster {
  // Mostly your level. Sometimes easier. Rarely one up, and never at level 1.
  const r = roll(99);
  let want = level;
  if (r < 20 && level > 1) want = level - 1;
  else if (r >= 95 && level > 1) want = level + 1;
  want = Math.max(1, Math.min(12, want));
  const pool = GAME.monsters.filter((m) => m.level === want);
  const m = pool[roll(pool.length - 1)];
  // jitter so two fights are never identical
  const hp = Math.round(m.hp * (0.9 + roll(20) / 100));
  return { name: m.name, level: m.level, hp, max_hp: hp, str: m.str, def: m.def, gold: m.gold, exp: m.exp };
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
