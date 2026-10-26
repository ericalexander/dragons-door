/**
 * Who lives where. The wild used to roll the same 28 monsters everywhere, by level alone; now each kind
 * of land has its own, the hills round Ironhold have theirs, and so do the caves. Brightwater's forest
 * keeps the old familiar ones (the realm's first monsters), and they fill any gap a region leaves.
 *
 * Only names change: each regional monster fights with the stats of one of the old monsters at the same
 * level (the nth name at a level borrows the nth old monster there), so balance and the simulator carry over.
 */
import { POCKET, TOWN_TILES, tileAt, type Terrain } from "./world.js";

export type Region = "forest" | "meadow" | "marsh" | "hills" | "crags" | "highland" | "riverside" | "cave";

/** Names by level. Order matters: it picks which old monster's stats each one borrows. */
export const BESTIARY: Record<Exclude<Region, "forest">, Record<number, string[]>> = {
  meadow: {
    1: ["Field Rat", "Hedge Robber", "Horsefly Swarm", "Loose Bull"],
    2: ["Scarecrow Thing", "Coyote Pack", "Highwayman"],
    3: ["Barrow Rat King", "Grass Ogre", "Raider Captain"],
    4: ["Will-o'-Wisp", "Barrow Troll"],
    5: ["Black Shuck", "Headless Rider"],
    6: ["Grass Wyrm", "Walking Menhir"],
    7: ["Barrow King", "Manticore"],
    8: ["Wight Lord", "Storm Giant"],
    9: ["Thunderbird", "Plague Herald"],
    10: ["Sky Wyrm", "Colossus"],
    11: ["Master of the Wild Hunt", "Storm Titan"],
    12: ["Rider of the Wild Hunt", "Blight Drake"],
  },
  marsh: {
    1: ["Bloodleech", "Marsh Frog", "Biting Midges", "Bog Hog"],
    2: ["Reed Witch", "Fen Hounds", "Mire Poacher"],
    3: ["Bog Spider", "Mudman", "Lizardfolk Chief"],
    4: ["Corpse Light", "Bog Troll"],
    5: ["Swamp Hag", "Drowned Knight"],
    6: ["Black Water Serpent", "Peat Golem"],
    7: ["Fen Vampire", "Mire Chimera"],
    8: ["Drowned Lich", "Moss Giant"],
    9: ["Fen Hydra", "Swamp Fiend"],
    10: ["Mire Wyrm", "Bog Colossus"],
    11: ["Drowned King", "Rot Behemoth"],
    12: ["Lord of the Drowned", "Black Water Dragon"],
  },
  hills: {
    1: ["Rock Rat", "Shepherd's Thief", "Stinging Gnats", "Angry Ram"],
    2: ["Hill Hermit", "Hill Wolves", "Cattle Raider"],
    3: ["Cave Spider", "Hill Ogre", "Goblin Warlord"],
    4: ["Ember Sprite", "Hill Troll"],
    5: ["Barghest", "Grave Knight"],
    6: ["Hill Wyvern", "Cairn Golem"],
    7: ["Wight of the Tor", "Hill Manticore"],
    8: ["Barrow Lich", "Hill Giant"],
    9: ["Griffon Queen", "Pit Fiend"],
    10: ["Elder Wyrm of the Tors", "Earth Titan"],
    11: ["Lich of the Tor", "Fire Fiend"],
    12: ["Cairn King", "Tor Dragon"],
  },
  crags: {
    5: ["Crag Hound", "Harpy Queen"],
    6: ["Rock Wyvern", "Granite Golem"],
    7: ["Roc", "Crag Chimera"],
    8: ["Ice Wight", "Rime Giant"],
    9: ["Crag Hydra", "Ash Fiend"],
    10: ["Scree Wyrm", "Mountain Titan"],
    11: ["Ashen Lich", "Fire Giant King"],
    12: ["Ash-Born Knight", "Cinder Drake"],
  },
  // The gentle land round Ironhold's walls: quarry spoil, slag heaps, and what's left of the Company's stragglers.
  highland: {
    1: ["Scrounger", "Feral Recruit", "Slag Fly", "Mountain Goat"],
    2: ["Old Sapper", "Grey Wolves", "Deserter"],
    3: ["Cinder Spider", "Rock Troll Whelp", "Feral Sergeant"],
    4: ["Slag Imp", "Rock Troll"],
    5: ["Rust Hound", "Hollow Soldier"],
  },
  // The gentle land round Ashford, along the Ash: wharves, weirs, mudflats, and the people who work the river crooked.
  riverside: {
    1: ["Wharf Pickpocket", "Ford Ruffian", "River Midges", "Snapping Turtle"],
    2: ["Mudlark", "Wharf Dogs", "Smuggler"],
    3: ["Giant Water Spider", "River Ogre", "Smuggler Captain"],
    4: ["Weir Sprite", "Weir Troll"],
    5: ["Ford Kelpie", "River Reaver"],
  },
  cave: {
    1: ["Cave Rat", "Blind Thief", "Cave Gnats", "Tusked Mole"],
    2: ["Lost Miner", "Ghoul Pack", "Tunnel Bandit"],
    3: ["Giant Cave Spider", "Cave Ogre", "Kobold Chief"],
    4: ["Ember Beetle", "Cave Troll"],
    5: ["Tunnel Horror", "Lost Knight"],
    6: ["Cave Wyrm", "Crystal Golem"],
    7: ["Cave Vampire", "Basilisk"],
    8: ["Deep Lich", "Stone Giant"],
    9: ["Cave Hydra", "Pit Demon"],
    10: ["Deep Wyrm", "Delve Titan"],
    11: ["Elder Deep Lich", "Magma Fiend"],
    12: ["Deep Knight", "Ember Drake"],
  },
};

const BY_TERRAIN: Record<Exclude<Terrain, "town">, Region> = { meadow: "meadow", forest: "forest", marsh: "marsh", hills: "hills", crags: "crags" };

/** What kind of place this is, for what lives there. Inside a cave is the cave, wherever it is. */
export function regionAt(x: number, y: number, inCave = false): Region {
  if (inCave) return "cave";
  // Each outside town's own gentle country: Ironhold's hills, Ashford's riverbank.
  for (const [town, t] of Object.entries(TOWN_TILES)) if (Math.max(Math.abs(x - t.x), Math.abs(y - t.y)) <= POCKET) return town === "ashford" ? "riverside" : "highland";
  const terrain = tileAt(x, y).terrain;
  return terrain === "town" ? "forest" : BY_TERRAIN[terrain];
}

// ---------- what the land gives up ----------
// Stone country (the hills, the crags, and the land round Ironhold) gives up ore; the lowlands (forest,
// meadow, marsh, and the riverbank round Ashford) give up gems. Ironhold's forge wants ore and, at the top, gems;
// Odile's jewelry in Brightwater wants both. So each town has something the other needs, and the
// shared auction board is where they meet.

export type Find = { kind: "ore"; ore: number } | { kind: "gem" };
/** Chance a kill leaves something behind besides gold, by kind of land. Caves have the pick instead. */
export const FIND_CHANCE: Record<Region, number> = { riverside: 0.06, highland: 0.08, hills: 0.08, crags: 0.08, forest: 0.06, meadow: 0.06, marsh: 0.06, cave: 0 };
const STONE: Region[] = ["highland", "hills", "crags"];

/** What a kill leaves, if anything: ore in stone country (better ore off tougher monsters), a gem in the lowlands. */
export function rollFind(region: Region, level: number, r: () => number = Math.random): Find | null {
  if (r() >= FIND_CHANCE[region]) return null;
  if (!STONE.includes(region)) return { kind: "gem" };
  const x = r();
  if (level >= 9) return { kind: "ore", ore: x < 0.25 ? 2 : x < 0.6 ? 1 : 0 };
  if (level >= 5) return { kind: "ore", ore: x < 0.35 ? 1 : 0 };
  return { kind: "ore", ore: 0 };
}

/** Whose country a place is in: the nearer town's. */
export function countryOf(x: number, y: number): "brightwater" | "ironhold" {
  const b = Math.max(Math.abs(x), Math.abs(y));
  const i = Math.max(Math.abs(x - TOWN_TILES.ironhold.x), Math.abs(y - TOWN_TILES.ironhold.y));
  return i < b ? "ironhold" : "brightwater";
}
