import { current } from "./request.js";
import { tileAt, townAt } from "./world.js";
import { PATHS, SPECIALIZE_AT, pathOfClass } from "./paths.js";
import { SWINGS_PER_DAY, trinket, bonusText } from "./caves.js";
import { boosted, withRarity } from "./rarity.js";
import { FORAGES_PER_DAY } from "./herbs.js";
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
  /** Steel, Shadow or the gift: how they fight. Their class is the path's base class until they specialize. */
  path: import("./paths.js").Path;
  /** Chosen a specialization yet (at level 5). Everyone from before paths has. */
  specialized: boolean;
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
  /** Rarity of what's worn (0 Common .. 4 Mythic); see rarity.ts. */
  weapon_rarity?: number;
  armor_rarity?: number;
  armor_id: number;
  alive: boolean;
  location: "inn" | "fields";
  dragon_kills: number;
  bag_id: number;
  ground: { slot: "weapon" | "armor"; item_id: number; rarity?: number } | null;
  /** A draught drunk for the fight: what it adds, until that fight is over. */
  boost?: { name: string; str?: number; def?: number } | null;
  /** Fights told plainly, without the class's flair. */
  plain_fights?: boolean;
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
  /** A wild event waiting for an answer, where it happened. */
  pending_event: { id: string; x: number; y: number; riddle?: string } | null;
  /** Can make test characters; and whether this one is a test character (kept out of everything public). */
  admin: boolean;
  is_test: boolean;
  /** A try-it-in-the-browser character: driven only by the website's narrator, deleted after a day. */
  trial: boolean;
  /** Barred from the realm by its keeper; and the name they had before the keeper renamed them (told once). */
  banned_at: string | null;
  renamed_from: string | null;
  /** When they last changed class (once a week at most). */
  respec_at: string | null;
  /** Where they started, and where they return and wake up after dying: brightwater or ironhold. */
  start_town?: string;
}

export interface Turns {
  player_id: string;
  day: string;
  forest_fights: number;
  player_fights: number;
  specials: number;
  inn_used: boolean;
  flirted: boolean;
  /** A bard has played their set today. */
  performed?: boolean;
  bank_tx: number;
  tavern_posts: number;
  messages_sent: number;
  bard_heard: boolean;
  visitor_talked: boolean;
  /** Swings of the pick taken today. */
  swings: number;
  /** Who they've talked to today, and whether anyone's let slip a place yet. */
  talked: string[];
  gossip_heard: boolean;
  /** Wild events turned up today. */
  events_seen: number;
  /** Mana left today (casters only). */
  mana: number;
  /** Times they've searched the ground for herbs today. */
  forages?: number;
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
  /** Met in the dark: tougher, and worth more. */
  night?: boolean;
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
  /** The realm's time of day right now (Eastern time), so the narrator never guesses. */
  time_of_day: string;
  name: string;
  class: PlayerClass;
  /** Steel, Shadow or the gift. */
  path: string;
  /** Present (false) only for someone who hasn't chosen a specialization yet. */
  specialized?: boolean;
  specialize_at?: number;
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
  /** What `str` is called for their class: Strength, Dexterity or Intelligence. */
  attribute: string;
  /** The name of their special: a caster's is named for the spell they know. */
  special: string;
  /** Casters: mana left today out of the day's pool. */
  mana?: number;
  mana_max?: number;
  /** Swings of the pick left today (only matters with a pickaxe). */
  swings_left: number;
  forages_left: number;
  draught?: { name: string; str?: number; def?: number };
  plain_fights?: boolean;
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
  /** Side quests under way: title, what they know, days left, and whether one is waiting on their choice. */
  quests?: { title: string; know: string; days_left: number; waiting_on_you?: boolean }[];
  /** The sky over the player, roughly. Only on status, forest and news, and only if they haven't turned it off. */
  weather?: import("./weather.js").Weather;
}

// ---------- item families ----------
/**
 * Every weapon and piece of armor belongs to a family, and it's that family for good: a Long Sword is a Steel
 * weapon, a Silver Flute a bard's instrument, a Wool Robe a caster's robe. A carried item's id says both:
 * family × 100 + tier (tier 0 to 12). What a character wears is a plain tier, always of their own family.
 * Stats go by tier, so a tier is as strong in every family; how armor fights differs (armorProfiles).
 */
export const WEAPON_FAMILIES = ["steel", "shadow", "mage", "priest", "bard"] as const;
export const ARMOR_FAMILIES = ["heavy", "leathers", "robes", "performer"] as const;
export type WeaponFamily = typeof WEAPON_FAMILIES[number];
export type ArmorFamily = typeof ARMOR_FAMILIES[number];
const FAM = 100;
export const tierOf = (id: number) => id % FAM;
export function weaponFamilyOf(cls: PlayerClass): WeaponFamily {
  return cls === "thief" ? "shadow" : cls === "mage" || cls === "priest" || cls === "bard" ? cls : "steel";
}
export function armorFamilyOf(cls: PlayerClass): ArmorFamily {
  return cls === "thief" ? "leathers" : cls === "bard" ? "performer" : cls === "mage" || cls === "priest" ? "robes" : "heavy";
}
/** The carried id of this tier in this class's own family. */
export function carriedId(slot: "weapon" | "armor", cls: PlayerClass, tier: number): number {
  const fams = slot === "weapon" ? WEAPON_FAMILIES as readonly string[] : ARMOR_FAMILIES as readonly string[];
  return (fams.indexOf(slot === "weapon" ? weaponFamilyOf(cls) : armorFamilyOf(cls)) + 1) * FAM + tierOf(tier);
}
/** A carried item's family (null for a bare tier, which only what's worn uses). */
export function familyOf(slot: "weapon" | "armor", id: number): string | null {
  const i = Math.floor(id / FAM) - 1;
  if (i < 0) return null;
  return (slot === "weapon" ? WEAPON_FAMILIES : ARMOR_FAMILIES)[i] ?? null;
}
/** Whether this class can wear or wield it: their own family only. */
export function fits(slot: "weapon" | "armor", id: number, cls: PlayerClass): boolean {
  const f = familyOf(slot, id);
  return f === null || f === (slot === "weapon" ? weaponFamilyOf(cls) : armorFamilyOf(cls));
}
const SPELL_FAMILIES = new Set(["mage", "priest", "bard"]);
/** An item's name from its family and tier. A bare tier needs the wearer's class to say which family. */
export function itemName(slot: "weapon" | "armor", id: number, cls?: PlayerClass): string {
  const fam = familyOf(slot, id) ?? (cls ? (slot === "weapon" ? weaponFamilyOf(cls) : armorFamilyOf(cls)) : slot === "weapon" ? "steel" : "heavy");
  const t = tierOf(id);
  if (slot === "weapon") {
    if (fam === "steel") return weapon(t).name;
    if (SPELL_FAMILIES.has(fam)) return (GAME.spells as Record<string, string[]>)[fam]?.[t] ?? weapon(t).name;
    return (GAME.itemNames.weapon as Record<string, string[]>)[fam]?.[t] ?? weapon(t).name;
  }
  if (fam === "heavy") return armor(t).name;
  return (GAME.itemNames.armor as Record<string, string[]>)[fam]?.[t] ?? armor(t).name;
}
/** A carried item as it'd be named in a bag or on a board: a mage's or priest's spell comes as a scroll. */
export function carriedName(slot: "weapon" | "armor", id: number, cls?: PlayerClass): string {
  const fam = familyOf(slot, id) ?? (cls ? (slot === "weapon" ? weaponFamilyOf(cls) : armorFamilyOf(cls)) : null);
  const name = itemName(slot, id, cls);
  return slot === "weapon" && (fam === "mage" || fam === "priest") ? `Scroll of ${name}` : name;
}
/** What kind of thing it is, in a few words, for the board and the bag. */
export function familyLabel(slot: "weapon" | "armor", id: number): string | null {
  const f = familyOf(slot, id);
  return f ? ({ steel: "a Steel weapon", shadow: "a Shadow weapon", mage: "a mage's spell", priest: "a priest's prayer", bard: "a bard's instrument",
    heavy: "heavy armor", leathers: "light leathers", robes: "a caster's robes", performer: "a performer's clothes" } as Record<string, string>)[f] : null;
}
/** Who can use it, for a board or a gift: the paths and classes. */
export function familyUsers(slot: "weapon" | "armor", id: number): string | null {
  const f = familyOf(slot, id);
  return f ? ({ steel: "warriors and guardians", shadow: "thieves", mage: "mages", priest: "priests", bard: "bards",
    heavy: "warriors and guardians", leathers: "thieves", robes: "mages and priests", performer: "bards" } as Record<string, string>)[f] : null;
}

export function weapon(id: number) {
  const t = tierOf(id);
  return GAME.weapons.find((w) => w.id === t) ?? GAME.weapons[0];
}
export function armor(id: number) {
  const t = tierOf(id);
  return GAME.armor.find((a) => a.id === t) ?? GAME.armor[0];
}
/** What one ordinary fight at this level is worth in experience: the average of its monsters. */
export function fightExp(level: number): number {
  const ms = GAME.monsters.filter((m) => m.level === Math.max(1, Math.min(12, level)));
  return ms.length ? ms.reduce((a, m) => a + m.exp, 0) / ms.length : 0;
}
/**
 * Experience that isn't from a fight is counted in fights, so it stays worth having at every level: an effect's
 * exp: 10 is one fight's worth, at the level of the place (never above your own, so walking far out early doesn't pay).
 */
export const expInFights = (k: number, placeLevel: number, yourLevel: number) => Math.round(k / 10 * fightExp(Math.min(placeLevel, yourLevel)));
/** The first time you set foot on a tile in the wild: this share of a fight there, in experience. Makes new ground worth the turn. */
export const NEW_GROUND = 0.6;

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

interface Mana { base: number; perLevel: number; cast: number; fireball: number; staff: number; heal?: number; healPct?: number }
/** The class's mana rules, if it casts spells (mages, and later other magic classes). */
export const manaRules = (cls: PlayerClass): Mana | null => (GAME.classes[cls] as { mana?: Mana }).mana ?? null;
export const casts = (cls: PlayerClass) => manaRules(cls) !== null;
/** A day's mana: refills at the reset. */
export function manaMax(p: Pick<Player, "class" | "level">): number {
  const m = manaRules(p.class);
  return m ? m.base + m.perLevel * p.level : 0;
}
/** What a weapon tier is called for this class: casters know spells at the same tiers. */
export function weaponName(cls: PlayerClass, id: number): string {
  return itemName("weapon", tierOf(id), cls);
}
/** What an armor tier is called for this class's own family. */
export function armorName(cls: PlayerClass, id: number): string {
  return itemName("armor", tierOf(id), cls);
}

/** What a caster carries for a weapon tier: a spell scroll, or for a bard the instrument itself. */
export const casterItemName = (cls: PlayerClass, id: number) => carriedName("weapon", tierOf(id), cls);

/** Who teaches this class its spells, and where: Mother Quill's library for mages, Prior Hale's chapel for priests. */
export const spellVendor = (cls: PlayerClass): { name: string; place: string } | null => (GAME.classes[cls] as { vendor?: { name: string; place: string } }).vendor ?? null;

/** The big move that goes with what they know: a caster's special is named for their spell (Frost Needle → Frost Nova). */
export function specialName(cls: PlayerClass, id: number): string {
  const list = (GAME.spellSpecials as Record<string, string[]>)[cls];
  return list ? (list[id] ?? GAME.classes[cls].special) : GAME.classes[cls].special;
}

/** What a class calls its main attribute (the number the game stores as str): Strength, Dexterity, Intelligence. */
export const attributeName = (cls: PlayerClass): string => (GAME.classes[cls] as { attribute?: string }).attribute ?? "Strength";

/** Player's total strength and defense including gear. */
export function effective(p: Player) {
  const j = trinket(p.trinket_id ?? 0);
  // Heavy armor turns more of its rating into defense; light gives some of it up for a harder hit.
  const prof = (GAME.armorProfiles as Record<string, { def: number; str: number }>)[armorFamilyOf(p.class) === "heavy" ? "heavy" : "light"];
  const worn = boosted(armor(p.armor_id).def, p.armor_rarity);
  return { str: p.str + boosted(weapon(p.weapon_id).str, p.weapon_rarity) + j.str + Math.round(worn * prof.str), def: p.def + Math.round(worn * prof.def) + j.def };
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

/** The hour where the player is: their own time zone (from their connection, never stored), Eastern for townsfolk or if it's unknown. */
export function localHour(now = new Date(), tz = current()?.tz): number {
  const fmt = (zone: string) => Number(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit" }).format(now));
  if (tz) { try { return fmt(tz); } catch { /* not a zone Intl knows */ } }
  return fmt("America/New_York");
}

/** Same buckets as the square's: early morning, morning, afternoon, evening, night. By the player's own clock. */
export function timeOfDayNow(now = new Date(), tz = current()?.tz): string {
  const h = localHour(now, tz);
  return h >= 5 && h < 8 ? "early morning" : h < 12 && h >= 8 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "night";
}

/** Whether it's night where the player is: nine in the evening until five in the morning. */
export const isNight = (now = new Date(), tz = current()?.tz) => timeOfDayNow(now, tz) === "night";

export function publicState(p: Player, t: Turns, inEncounter: boolean, dragonAlive: boolean, bagUsed = 0, unreadMail = 0, unreadNews = 0, spouse: string | null = null, suitorsAround: { name: string; pronouns: string; where: string }[] = []): PublicState {
  const b = GAME.bags.find((x) => x.id === p.bag_id) ?? GAME.bags[0];
  return {
    name: p.name,
    class: p.class,
    path: PATHS[p.path ?? pathOfClass(p.class)].name,
    ...(p.specialized === false ? { specialized: false, choose_class: "one free choice of class on their path" } : {}),
    level: p.level,
    exp: p.exp,
    exp_next: expForLevel(p.level + 1),
    hp: p.hp,
    max_hp: p.max_hp,
    str: p.str,
    def: p.def,
    weapon: casts(p.class) ? weaponName(p.class, p.weapon_id) : withRarity(weaponName(p.class, p.weapon_id), p.weapon_rarity),
    armor: withRarity(armorName(p.class, p.armor_id), p.armor_rarity),
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
    forages_left: Math.max(0, FORAGES_PER_DAY - (t.forages ?? 0)),
    ...(p.boost ? { draught: p.boost } : {}),
    ...(p.plain_fights ? { plain_fights: true } : {}),
    ...(casts(p.class) ? { mana: t.mana ?? 0, mana_max: manaMax(p) } : {}),
    special: specialName(p.class, p.weapon_id),
    attribute: attributeName(p.class),
    spouse,
    suitors_around: suitorsAround,
    jewelry: p.trinket_id ? `${trinket(p.trinket_id).name} (${bonusText(trinket(p.trinket_id), attributeName(p.class))})` : null,
    pickaxe: Boolean(p.pickaxe),
    cave_depth: p.cave_depth ?? null,
    time_of_day: timeOfDayNow(),
    place: p.pos_x === null || p.pos_x === undefined ? null : (() => { const t = tileAt(p.pos_x!, p.pos_y!); return { x: t.x, y: t.y, name: t.name, terrain: t.terrain, level: t.level, poi: t.poi }; })(),
  };
}

/** Level 5 and still on a beginner's path: choose a specialization before training any further. */
export const needsSpec = (p: Player) => p.specialized === false && p.level >= SPECIALIZE_AT;

/** Legal next actions given current state. The narrator only offers these. */
export function legalActions(p: Player, t: Turns, inEncounter: boolean, dragonAlive: boolean): string[] {
  if (!p.alive) return ["news", "tavern", "rankings", "status", "mail"];
  if (inEncounter) {
    if (!casts(p.class)) return ["fight attack", "fight special", "drink", "fight run"];
    return ["fight attack", "fight special", ...(manaRules(p.class)?.heal ? ["fight heal"] : []), "fight staff", "drink", "fight run"];
  }
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
    // Inside another town's walls: its own services, no hunting; walking out still costs a turn.
    const town = townAt(p.pos_x, p.pos_y);
    if (town && town !== "brightwater") {
      w.unshift("town", "healer", "apothecary", "auction", ...(town === "ironhold" ? ["forge"] : []), "shop", "bank", "tavern", ...(t.inn_used ? [] : ["inn"]), ...(t.forest_fights > 0 ? ["move"] : []), ...(t.player_fights > 0 ? ["challenge"] : []));
      const nextLvl = expForLevel(p.level + 1);
      if (p.class === "bard" && !t.performed) w.push("perform");
      if (!t.flirted) w.push("flirt");
      // Ironhold's masters teach blades and bows; Ashford's the Shadow path, and Mags Pell tests her bards.
      const teachesYou = (!casts(p.class) && (town !== "ashford" || p.path === "shadow")) || (p.class === "bard" && town === "ashford");
      // Pell's Music Room, on Ashford's Exchange: anyone can look; bards buy.
      if (town === "ashford") w.push("instruments");
      if (p.specialized === false) w.unshift("specialize");
      if (needsSpec(p)) { /* trains again once they've chosen */ }
      else if (teachesYou && nextLvl !== null && p.exp >= nextLvl) w.unshift("train");
      return w;
    }
    if (t.forest_fights > 0) w.unshift("forest", "move");
    if ((t.forages ?? 0) < FORAGES_PER_DAY) w.push("forage");
    if (tileAt(p.pos_x, p.pos_y!).poi === "cave") w.unshift("descend");
    if (p.pending_event && p.pending_event.x === p.pos_x && p.pending_event.y === p.pos_y) w.unshift("event");
    return w;
  }
  const a: string[] = ["status", "news", "tavern", "rankings", "healer", "apothecary", "shop", "bank", "bag", "mail", "map", "workshop", "auction"];
  // Everyone can visit the library and the chapel; only their own class can learn there.
  a.push("library", "chapel");
  if (p.ground) a.unshift("take", "equip ground");
  // Everyone heads out into the world to hunt.
  a.unshift("explore");
  if (t.player_fights > 0) a.push("challenge");
  if (!t.flirted) a.push("flirt");
  if (!t.inn_used) a.push("inn");
  if (!t.bard_heard) a.push("bard");
  if (p.class === "bard" && !t.performed) a.push("perform");
  // Dunstan's instruments, in Brightwater's tavern: anyone can look; bards buy.
  a.push("instruments");
  const next = expForLevel(p.level + 1);
  if (p.specialized === false) a.unshift("specialize");
  if (needsSpec(p)) { /* trains again once they've chosen */ }
  else if (next !== null && p.exp >= next) a.unshift("train");
  if (p.level >= 12 && dragonAlive && t.forest_fights > 0) a.unshift("dragon");
  return a;
}
