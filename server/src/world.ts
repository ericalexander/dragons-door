/**
 * The world beyond town. It isn't stored: every tile is worked out from the realm's seed and its
 * coordinates, so the same place is always the same for everyone. What's stored is who has been where.
 *
 * Town is (0,0). Land rises with distance, so you pass meadow and wood before hills and crags.
 * Monsters get tougher ring by ring: a tile's level is roughly its distance from town.
 */
import { createHash } from "node:crypto";

export type Terrain = "town" | "meadow" | "forest" | "marsh" | "hills" | "crags";
export interface Tile {
  x: number;
  y: number;
  terrain: Terrain;
  /** Distance from town in rings (0 = town). */
  ring: number;
  /** Roughly the level of what lives there. */
  level: number;
  name: string;
  poi: "cave" | "town" | null;
}

export const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] } as const;
export type Dir = keyof typeof DIRS;

const SEED = process.env.DRAGONS_DOOR_WORLD_SEED ?? "dragons-door-world-1";

function hash01(...parts: (string | number)[]): number {
  const h = createHash("sha256").update([SEED, ...parts].join("|")).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}
function hashInt(n: number, ...parts: (string | number)[]): number {
  const h = createHash("sha256").update([SEED, ...parts].join("|")).digest();
  return h.readUInt32BE(4) % n;
}

/** Smooth value noise: random values on a coarse grid, blended between. */
function noise(x: number, y: number, scale: number, layer: string): number {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
  const fx = x / scale - gx, fy = y / scale - gy;
  const s = (t: number) => t * t * (3 - 2 * t);
  const v = (i: number, j: number) => hash01(layer, gx + i, gy + j);
  const a = v(0, 0) + (v(1, 0) - v(0, 0)) * s(fx);
  const b = v(0, 1) + (v(1, 1) - v(0, 1)) * s(fx);
  return a + (b - a) * s(fy);
}

export const ringOf = (x: number, y: number) => Math.max(Math.abs(x), Math.abs(y));

const LEVEL_MOD: Record<Terrain, number> = { town: 0, meadow: 0, forest: 0, marsh: 1, hills: 1, crags: 2 };

const NOUNS: Record<Exclude<Terrain, "town">, string[]> = {
  meadow: ["Meadow", "Lea", "Downs", "Fields", "Heath"],
  forest: ["Wood", "Thicket", "Holt", "Weald", "Copse"],
  marsh: ["Fen", "Mire", "Bog", "Marsh", "Slough"],
  hills: ["Hills", "Rise", "Tor", "Knolls", "Brae"],
  crags: ["Crags", "Scar", "Teeth", "Edge", "Spurs"],
};
const ADJECTIVES = ["Whispering", "Ashen", "Crooked", "Grey", "Weeping", "Old", "Black", "Briar", "Gallows", "Sunken", "Lantern",
  "Thornback", "Cold", "Wren's", "Hanging", "Bitter", "Lonely", "Red", "Howling", "Broken", "Silver", "Hollow", "Moth", "Kettle"];
const CAVE_NAMES = ["Hollow", "Grotto", "Deeps", "Cave", "Warren"];

/** Towns out in the world, by tile. Brightwater is the centre; the others sit where the land put them. */
export const TOWN_TILES = { ironhold: { x: -4, y: -11, name: "Ironhold" }, ashford: { x: 4, y: 10, name: "Ashford" } } as const;
export type TownId = "brightwater" | keyof typeof TOWN_TILES;
/** How far the gentle land around a town out in the world reaches. */
export const POCKET = 4;
/** Which town a tile is, if any. */
export function townAt(x: number | null | undefined, y: number | null | undefined): TownId | null {
  if (x === null || x === undefined) return "brightwater";
  if (x === 0 && y === 0) return "brightwater";
  for (const [id, t] of Object.entries(TOWN_TILES)) if (t.x === x && t.y === y) return id as TownId;
  return null;
}

export function tileAt(x: number, y: number): Tile {
  const ring = ringOf(x, y);
  if (ring === 0) return { x, y, terrain: "town", ring, level: 0, name: "Brightwater", poi: null };
  for (const t of Object.values(TOWN_TILES)) if (t.x === x && t.y === y) return { x, y, terrain: "town", ring, level: ring, name: t.name, poi: "town" };
  // Land rises with distance; noise makes it uneven so it never reads as neat circles.
  const height = 0.55 * noise(x, y, 5, "elev") + 0.45 * noise(x, y, 2, "rough");
  const e = height * 0.6 + Math.min(1, ring / 13) * 0.5;
  const wet = noise(x, y, 4, "wet");
  let terrain: Terrain;
  if (e < 0.36) terrain = wet > 0.66 ? "marsh" : wet > 0.42 ? "forest" : "meadow";
  else if (e < 0.58) terrain = wet > 0.7 ? "marsh" : wet > 0.36 ? "forest" : "meadow";
  else if (e < 0.78) terrain = wet > 0.74 ? "marsh" : "hills";
  else terrain = "crags";
  // Around a town out in the world there's a patch of gentle land for the people who start there, as easy
  // ring for ring as Brightwater's (whatever the terrain). Beyond it the land is as wild as its distance from
  // Brightwater, so the road between towns stays dangerous: the easiest crossing goes through level 6.
  let level = Math.max(1, Math.min(12, ring + LEVEL_MOD[terrain]));
  for (const t of Object.values(TOWN_TILES)) {
    const d = Math.max(Math.abs(x - t.x), Math.abs(y - t.y));
    if (d <= POCKET) level = Math.min(level, Math.max(1, d));
  }
  const poi = (terrain === "hills" || terrain === "crags") && hashInt(22, "cave", x, y) === 0 ? "cave" : null;
  // Names belong to small regions of the same terrain, so neighbouring tiles share them.
  const rx = Math.floor(x / 2), ry = Math.floor(y / 2);
  const adj = ADJECTIVES[hashInt(ADJECTIVES.length, "adj", terrain, rx, ry)];
  const name = poi
    ? `the ${ADJECTIVES[hashInt(ADJECTIVES.length, "cave-adj", x, y)]} ${CAVE_NAMES[hashInt(CAVE_NAMES.length, "cave-noun", x, y)]}`
    : `the ${adj} ${NOUNS[terrain][hashInt(NOUNS[terrain].length, "noun", terrain, rx, ry)]}`;
  return { x, y, terrain, ring, level, name, poi };
}

export const SYMBOL: Record<Terrain | "cave" | "you", string> = { town: "T", meadow: ".", forest: "%", marsh: "~", hills: "n", crags: "^", cave: "O", you: "@" };
export const LEGEND = "@ you  T town  . meadow  % forest  ~ marsh  n hills  ^ crags  O cave  ? unexplored";

/** An ASCII map around (cx, cy): explored tiles drawn, their unexplored neighbours as '?', the rest blank. */
export function renderMap(cx: number, cy: number, explored: Set<string>, radius = 4): string[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const lines: string[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    let line = "";
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x === cx && y === cy) { line += SYMBOL.you; continue; }
      if (x === 0 && y === 0) { line += SYMBOL.town; continue; }
      if (explored.has(key(x, y))) { const t = tileAt(x, y); line += t.poi === "cave" ? SYMBOL.cave : SYMBOL[t.terrain]; continue; }
      const near = Object.values(DIRS).some(([dx, dy]) => explored.has(key(x + dx, y + dy)) || (x + dx === 0 && y + dy === 0));
      line += near ? "?" : " ";
    }
    lines.push(line.split("").join(" ").trimEnd());
  }
  // drop empty rows at the top and bottom
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}
