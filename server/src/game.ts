import data from "./data/game.json" with { type: "json" };

export const GAME = data;

export type PlayerClass = keyof typeof data.classes;

export interface Player {
  id: string;
  name: string;
  class: PlayerClass;
  level: number;
  exp: number;
  hp: number;
  max_hp: number;
  str: number;
  def: number;
  gold: number;
  bank: number;
  gems: number;
  charm: number;
  weapon_id: number;
  armor_id: number;
  alive: boolean;
  location: "inn" | "fields";
  dragon_kills: number;
}

export interface Turns {
  player_id: string;
  day: string;
  forest_fights: number;
  player_fights: number;
  specials: number;
  inn_used: boolean;
  flirted: boolean;
  bank_tx: number;
  tavern_posts: number;
}

export interface Monster {
  name: string;
  hp: number;
  max_hp: number;
  str: number;
  def: number;
  gold: number;
  exp: number;
}

/** Every tool response shares this envelope. */
export interface Envelope {
  events: Event[];
  state: PublicState;
  actions: string[];
  hint?: string;
}

export type Event = { kind: string } & Record<string, unknown>;

export interface PublicState {
  name: string;
  class: PlayerClass;
  level: number;
  exp: number;
  exp_next: number | null;
  hp: number;
  max_hp: number;
  str: number;
  def: number;
  weapon: string;
  armor: string;
  gold: number;
  bank: number;
  gems: number;
  charm: number;
  alive: boolean;
  location: "inn" | "fields";
  forest_fights: number;
  player_fights: number;
  specials: number;
  in_encounter: boolean;
  dragon_alive: boolean;
}

export function weapon(id: number) {
  return GAME.weapons.find((w) => w.id === id) ?? GAME.weapons[0];
}
export function armor(id: number) {
  return GAME.armor.find((a) => a.id === id) ?? GAME.armor[0];
}
export function expForLevel(level: number): number | null {
  return GAME.levels.find((l) => l.level === level)?.exp ?? null;
}
/** Stat gains on reaching `newLevel`. Gains grow with level so the player keeps pace with the bestiary. */
export function levelGains(cls: PlayerClass, newLevel: number): { hp: number; str: number; def: number } {
  const c = GAME.classes[cls];
  const g = GAME.growth;
  return {
    hp: Math.round(c.hpPerLevel * (1 + g.hp * (newLevel - 1))),
    str: Math.round(c.strPerLevel * (1 + g.str * (newLevel - 1))),
    def: Math.round(c.defPerLevel * (1 + g.def * (newLevel - 1))),
  };
}

export function master(level: number) {
  return GAME.masters.find((m) => m.level === level) ?? null;
}

/** Player's total strength and defense including gear. */
export function effective(p: Player) {
  return { str: p.str + weapon(p.weapon_id).str, def: p.def + armor(p.armor_id).def };
}

export function publicState(p: Player, t: Turns, inEncounter: boolean, dragonAlive: boolean): PublicState {
  return {
    name: p.name,
    class: p.class,
    level: p.level,
    exp: p.exp,
    exp_next: expForLevel(p.level + 1),
    hp: p.hp,
    max_hp: p.max_hp,
    str: p.str,
    def: p.def,
    weapon: weapon(p.weapon_id).name,
    armor: armor(p.armor_id).name,
    gold: p.gold,
    bank: p.bank,
    gems: p.gems,
    charm: p.charm,
    alive: p.alive,
    location: p.location,
    forest_fights: t.forest_fights,
    player_fights: t.player_fights,
    specials: t.specials,
    in_encounter: inEncounter,
    dragon_alive: dragonAlive,
  };
}

/** Legal next actions given current state. The narrator only offers these. */
export function legalActions(p: Player, t: Turns, inEncounter: boolean, dragonAlive: boolean): string[] {
  if (!p.alive) return ["news", "tavern", "rankings", "status"];
  if (inEncounter) return ["fight attack", "fight special", "fight run"];
  const a: string[] = ["status", "news", "tavern", "rankings", "healer", "shop", "bank"];
  if (t.forest_fights > 0) a.unshift("forest");
  if (t.player_fights > 0) a.push("challenge");
  if (!t.flirted) a.push("flirt");
  if (!t.inn_used) a.push("inn");
  const next = expForLevel(p.level + 1);
  if (next !== null && p.exp >= next) a.unshift("train");
  if (p.level >= 12 && dragonAlive && t.forest_fights > 0) a.unshift("dragon");
  return a;
}
