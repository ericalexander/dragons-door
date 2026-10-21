/**
 * The town square: who's about (from the townsfolk timetable) and a visitor of the day.
 * One visitor a realm day, chosen from the date so everyone meets the same one; some days nobody comes.
 * Talking to them once a day gets a rumor drawn from real realm facts, and sometimes a small gift.
 */
import { createHash } from "node:crypto";
import { roll } from "./combat.js";

export type Rumor = "next_bard" | "top_player" | "forest_danger" | "heavy_purse" | "recent_loot" | "newest_arrival" | "dragon";
export type VisitorGift = "nothing" | "gold" | "charm" | "heal" | "fight" | "map";

export interface Visitor {
  name: string;
  /** For the narrator: who they are and how they talk. */
  description: string;
  /** Rumors they tend to carry, in order of preference; the first with real facts behind it is used. */
  rumors: Rumor[];
  gifts: [VisitorGift, number][];
}

export const VISITORS: Visitor[] = [
  { name: "Tinker Moss", description: "a tinker with a squeaking cart of odd trinkets and an opinion on everything; never stops talking",
    rumors: ["recent_loot", "heavy_purse", "next_bard"], gifts: [["nothing", 30], ["gold", 20], ["charm", 10]] },
  { name: "Sister Agathe", description: "a pilgrim in a dusty grey habit, walking to a shrine in the mountains; gentle, and notices when someone's hurt",
    rumors: ["forest_danger", "dragon"], gifts: [["heal", 40], ["charm", 15], ["nothing", 25]] },
  { name: "Bram the Lost", description: "a merchant who took a wrong turn three towns ago and is too proud to admit it; pays well for directions",
    rumors: ["newest_arrival", "top_player"], gifts: [["gold", 45], ["nothing", 25]] },
  { name: "The Cartographer", description: "a thin woman sketching the roads in a leather book, asking everyone what lies past the forest",
    rumors: ["forest_danger", "dragon"], gifts: [["map", 50], ["nothing", 20], ["fight", 10]] },
  { name: "Old Kell", description: "a retired adventurer with one eye and a hundred war stories, most of them true; makes you want to go and do something",
    rumors: ["dragon", "top_player", "forest_danger"], gifts: [["fight", 25], ["nothing", 45]] },
  { name: "The Herald of Ashford", description: "a herald in faded livery from a town down the road, reading proclamations nobody asked for",
    rumors: ["top_player", "newest_arrival", "dragon"], gifts: [["nothing", 70], ["charm", 10]] },
  { name: "Nettle the Goatherd", description: "a goatherd whose best goat ran into the forest this morning; frantic, grateful for any help",
    rumors: ["forest_danger", "heavy_purse"], gifts: [["charm", 35], ["gold", 25], ["nothing", 20]] },
  { name: "Hesper the Collector", description: "a collector of oddities with rings on every finger, who knows who found what and where",
    rumors: ["recent_loot", "heavy_purse"], gifts: [["gold", 30], ["nothing", 40]] },
  { name: "Two Arguing Dwarves", description: "two dwarves arguing loudly about a cave in the hills and whose turn it is to carry the pick",
    rumors: ["forest_danger", "recent_loot"], gifts: [["nothing", 55], ["gold", 15]] },
  { name: "A Cloaked Stranger", description: "a stranger in a dark cloak who speaks in riddles, then is simply gone",
    rumors: ["next_bard", "dragon"], gifts: [["nothing", 70], ["charm", 10]] },
];

/** One visitor per realm day, or none about one day in six. */
export function visitorFor(day: string): Visitor | null {
  const h = createHash("sha256").update(`visitor|${day}`).digest();
  if (h.readUInt8(4) % 6 === 0) return null;
  return VISITORS[h.readUInt32BE(0) % VISITORS.length];
}

export function pickVisitorGift(v: Visitor): VisitorGift {
  const total = v.gifts.reduce((n, [, w]) => n + w, 0);
  let r = roll(total - 1);
  for (const [g, w] of v.gifts) { if (r < w) return g; r -= w; }
  return "nothing";
}

export function timeOfDay(hour: number): "early morning" | "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 8) return "early morning";
  if (hour >= 8 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}
