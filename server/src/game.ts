import { tileAt } from "./world.js";
import { SWINGS_PER_DAY, trinket, bonusText } from "./caves.js";
import data from "./data/game.json" with { type: "json" };

export const GAME = data;
// Test hook: force the drop rate (e.g. DRAGONS_DOOR_DROP_CHANCE=1 locally). Unset in production.
const forcedDrop = process.env.DRAGONS_DOOR_DROP_CHANCE ?? process.env.LORD_DROP_CHANCE;
if (forcedDrop) GAME.drops.chance = Number(forcedDrop);

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
  bag_id: number;
  ground: { slot: "weapon" | "armor"; item_id: number } | null;
  mail_notified_upto: number;
  news_seen_upto: number;
  client: unknown;
  weather_off: boolean;
  is_bot: boolean;
  role: "player" | "townsfolk" | "npc";
  spouse_id: string | null;
  pos_x: number | null;
  pos_y: number | null;
  /** Jewelry worn (0 = none), whether they own a pickaxe, and how deep in a cave they are (null = not in one). */
  trinket_id: number;
  pickaxe: boolean;
  cave_depth: number | null;
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
  messages_sent: number;
  bard_heard: boolean;
  visitor_talked: boolean;
  /** Swings of the pick taken today. */
  swings: number;
}

export interface Monster {
  name: string;
  level?: number;
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
  bag: string;
  bag_used: number;
  bag_capacity: number;
  ground: string | null;
  unread_mail: number;
  unread_news: number;
  /** What things cost right now, so the narrator can quote before the player commits. */
  prices: { inn: number; heal_per_hp: number; heal_all: number };
  bank_trips_left: number;
  /** Swings of the pick left today (only matters with a pickaxe). */
  swings_left: number;
  /** Who they're married to, if anyone. */
  spouse: string | null;
  /** People you could court who are around right now, and where. */
  suitors_around: { name: string; pronouns: string; where: string }[];
  /** Where they stand: null in town, otherwise the place in the wild. */
  place: { x: number; y: number; name: string; terrain: string; level: number; poi: string | null } | null;
  /** Jewelry worn, with what it does; whether they carry a pickaxe; how deep in a cave (null = not in one). */
  jewelry: string | null;
  pickaxe: boolean;
  cave_depth: number | null;
  /** The sky over the player, roughly. Only on status, forest and news, and only if they haven't turned it off. */
  weather?: import("./weather.js").Weather;
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
  const j = trinket(p.trinket_id ?? 0);
  return { str: p.str + weapon(p.weapon_id).str + j.str, def: p.def + armor(p.armor_id).def + j.def };
}

/** Charm as others feel it: your own, plus whatever your jewelry adds. */
export const charmOf = (p: Player) => p.charm + trinket(p.trinket_id ?? 0).charm;

/** A room costs 100 a level; half that for anyone married to Violet, who keeps one aside. */
export function innCost(p: Player, spouse: string | null = null): number {
  return Math.floor(GAME.innCostPerLevel * p.level * (spouse === "Violet" ? 0.5 : 1));
}

/** Healing costs a little per HP per level; a quarter less for anyone married to Rowan. */
export function healCost(p: Player, hp: number, spouse: string | null = null): number {
  return Math.ceil(hp * GAME.healerCostPerHpPerLevel * p.level * (spouse === "Rowan" ? 0.75 : 1));
}

export function publicState(p: Player, t: Turns, inEncounter: boolean, dragonAlive: boolean, bagUsed = 0, unreadMail = 0, unreadNews = 0, spouse: string | null = null, suitorsAround: { name: string; pronouns: string; where: string }[] = []): PublicState {
  const b = GAME.bags.find((x) => x.id === p.bag_id) ?? GAME.bags[0];
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
    bag: b.name,
    bag_used: bagUsed,
    bag_capacity: b.capacity,
    ground: p.ground ? (p.ground.slot === "weapon" ? weapon(p.ground.item_id) : armor(p.ground.item_id)).name : null,
    unread_mail: unreadMail,
    unread_news: unreadNews,
    prices: {
      inn: innCost(p, spouse),
      heal_per_hp: healCost(p, 1, spouse),
      heal_all: healCost(p, p.max_hp - p.hp, spouse),
    },
    bank_trips_left: Math.max(0, GAME.bankTxPerDay - t.bank_tx),
    swings_left: Math.max(0, SWINGS_PER_DAY - (t.swings ?? 0)),
    spouse,
    suitors_around: suitorsAround,
    jewelry: p.trinket_id ? `${trinket(p.trinket_id).name} (${bonusText(trinket(p.trinket_id))})` : null,
    pickaxe: Boolean(p.pickaxe),
    cave_depth: p.cave_depth ?? null,
    place: p.pos_x === null || p.pos_x === undefined ? null : (() => { const t = tileAt(p.pos_x!, p.pos_y!); return { x: t.x, y: t.y, name: t.name, terrain: t.terrain, level: t.level, poi: t.poi }; })(),
  };
}

/** Legal next actions given current state. The narrator only offers these. */
export function legalActions(p: Player, t: Turns, inEncounter: boolean, dragonAlive: boolean): string[] {
  if (!p.alive) return ["news", "tavern", "rankings", "status", "mail"];
  if (inEncounter) return ["fight attack", "fight special", "fight run"];
  // Out in the wild: hunt where you stand, walk on, or head home. Town's services are back in town.
  if (p.pos_x !== null && p.pos_x !== undefined) {
    const w: string[] = ["map", "return", "status", "bag", "news", "rankings", "mail"];
    if (p.ground) w.unshift("take", "equip ground");
    if (p.cave_depth) {
      // Underground: hunt, mine, go deeper, or climb out. Walking anywhere means climbing out first.
      w.splice(0, 2, "climb", "return");
      if (p.pickaxe && (t.swings ?? 0) < SWINGS_PER_DAY) w.unshift("mine");
      if (t.forest_fights > 0) w.unshift("forest", ...(p.cave_depth < 3 ? ["deeper"] : []));
      return w;
    }
    if (t.forest_fights > 0) w.unshift("forest", "move");
    if (tileAt(p.pos_x, p.pos_y!).poi === "cave") w.unshift("descend");
    return w;
  }
  const a: string[] = ["status", "news", "tavern", "rankings", "healer", "shop", "bank", "bag", "mail", "map", "workshop"];
  if (p.ground) a.unshift("take", "equip ground");
  // Players head out into the world; townsfolk (who don't explore) still use the old forest.
  if (p.role === "player") { a.unshift("explore"); } else if (t.forest_fights > 0) a.unshift("forest");
  if (t.player_fights > 0) a.push("challenge");
  if (!t.flirted) a.push("flirt");
  if (!t.inn_used) a.push("inn");
  if (!t.bard_heard) a.push("bard");
  const next = expForLevel(p.level + 1);
  if (next !== null && p.exp >= next) a.unshift("train");
  if (p.level >= 12 && dragonAlive && t.forest_fights > 0) a.unshift("dragon");
  return a;
}
