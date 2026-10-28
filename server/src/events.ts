/**
 * Things that happen out in the wild besides fights: a wounded traveler, a fairy ring, a troll at a
 * bridge. Stepping onto a tile sometimes turns one up (a few a day at most). Each offers a choice,
 * and the server rolls what comes of it. The narrator only tells it.
 *
 * Outcomes scale with the tile's level, so the wild stays worth it as you go farther out.
 */
import type { Terrain } from "./world.js";

export type Effect =
  | { gold: number }            // times tile level (negative: they lose it, never below zero)
  | { lose_gold_pct: number }   // share of gold on hand
  | { heal_pct: number }        // share of max HP restored
  | { hurt_pct: number }        // share of max HP lost (never kills: leaves at least 1)
  | { charm: number }
  | { gem: number }
  | { fights: number }          // forest fights gained (or lost, if negative)
  | { exp: number }             // in fights: 10 is one fight's worth at the tile's level (never above yours); see expInFights
  | { map: number }             // places nearby marked on their map
  | { monster: number }         // a fight, at tile level plus this
  | { quest: string }           // starts a side quest (quests.ts)
  | { nothing: true };

export interface Outcome { key: string; weight: number; effects: Effect[] }
export interface Choice { id: string; label: string; outcomes: Outcome[]; /** gold it costs to pick, times tile level */ cost?: number }
export interface WildEvent {
  id: string;
  /** Only turns up for someone who hasn't had this quest before. */
  quest?: string;
  /** For the narrator: what they come upon. */
  description: string;
  terrains: Terrain[] | "any";
  choices: Choice[];
}

const o = (key: string, weight: number, ...effects: Effect[]): Outcome => ({ key, weight, effects });

export const EVENTS: WildEvent[] = [
  {
    id: "wounded_traveler", terrains: "any",
    description: "a traveler sitting against a rock, clutching a bloody leg, their pack spilled beside them",
    choices: [
      { id: "help", label: "Bind the wound", outcomes: [o("grateful", 55, { charm: 1 }, { gold: 8 }), o("blessing", 30, { charm: 1 }, { heal_pct: 30 }), o("bandit", 15, { monster: 0 })] },
      { id: "rob", label: "Go through their pack", outcomes: [o("coins", 60, { gold: 15 }), o("nothing_worth", 25, { nothing: true }), o("feigned", 15, { monster: 1 })] },
      { id: "leave", label: "Leave them be", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "roadside_shrine", terrains: ["meadow", "hills", "forest"],
    description: "a mossy roadside shrine with a stone bowl, a few old coins green in the bottom",
    choices: [
      { id: "pray", label: "Kneel and pray", outcomes: [o("warmth", 50, { heal_pct: 50 }), o("silence", 40, { nothing: true }), o("vision", 10, { map: 2 })] },
      { id: "offer", label: "Leave a coin", cost: 5, outcomes: [o("luck", 50, { fights: 1 }), o("favor", 35, { charm: 1 }), o("silence", 15, { nothing: true })] },
      { id: "take", label: "Take the old coins", outcomes: [o("coins", 60, { gold: 6 }), o("cursed", 40, { hurt_pct: 25 }, { charm: -1 })] },
    ],
  },
  {
    id: "bridge_troll", terrains: ["forest", "marsh"],
    description: "a narrow bridge over black water, and under it a troll who wants a toll or an answer to his riddle",
    choices: [
      { id: "answer", label: "Answer the riddle", outcomes: [o("right", 55, { exp: 12 }, { gold: 5 }), o("wrong", 45, { monster: 2 })] },
      { id: "pay", label: "Pay the toll", cost: 6, outcomes: [o("waved_through", 85, { nothing: true }), o("tip", 15, { map: 1 })] },
      { id: "fight", label: "Fight him", outcomes: [o("fight", 100, { monster: 2 })] },
    ],
  },
  {
    id: "fairy_ring", terrains: ["forest", "meadow"],
    description: "a ring of pale mushrooms in the grass, humming faintly, the air inside it glittering",
    choices: [
      { id: "step_in", label: "Step into the ring", outcomes: [o("dance", 35, { charm: 1 }, { heal_pct: 100 }), o("gift", 25, { gem: 1 }), o("lost_time", 30, { fights: -1 }), o("mischief", 10, { lose_gold_pct: 20 })] },
      { id: "around", label: "Walk around it", outcomes: [o("passed", 100, { nothing: true })] },
    ],
  },
  {
    id: "lost_purse", terrains: "any",
    description: "a leather purse lying in the path, still heavy",
    choices: [
      { id: "take", label: "Pick it up", outcomes: [o("gold", 70, { gold: 12 }), o("snake", 20, { hurt_pct: 20 }), o("empty", 10, { nothing: true })] },
      { id: "leave", label: "Leave it", outcomes: [o("left", 85, { nothing: true }), o("watched", 15, { charm: 1 })] },
    ],
  },
  {
    id: "will_o_wisp", terrains: ["marsh"],
    description: "a small blue light bobbing over the reeds, drifting away from the path as if it wants to be followed",
    choices: [
      { id: "follow", label: "Follow the light", outcomes: [o("shown", 45, { map: 3 }), o("bog", 40, { hurt_pct: 30 }, { fights: -1 }), o("treasure", 15, { gem: 1 }, { gold: 10 })] },
      { id: "ignore", label: "Stay on the path", outcomes: [o("stayed", 100, { nothing: true })] },
    ],
  },
  {
    id: "hermit", terrains: ["hills", "crags"],
    description: "a hermit in a rock shelter, cooking something over a tiny fire, who looks up without surprise",
    choices: [
      { id: "share", label: "Share a meal", cost: 3, outcomes: [o("teaches", 60, { exp: 10 }, { heal_pct: 40 }), o("stories", 40, { map: 2 })] },
      { id: "ask", label: "Ask about the land", outcomes: [o("directions", 70, { map: 2 }), o("grumble", 30, { nothing: true })] },
      { id: "leave", label: "Nod and move on", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "abandoned_camp", terrains: ["forest", "hills", "meadow"],
    description: "an abandoned camp: a cold fire pit, a torn tent, and a pack nobody came back for",
    choices: [
      { id: "search", label: "Search the camp", outcomes: [o("supplies", 45, { gold: 10 }, { heal_pct: 20 }), o("gem", 15, { gem: 1 }), o("owner_returns", 25, { monster: 1 }), o("nothing", 15, { nothing: true })] },
      { id: "rest", label: "Rest by the fire pit", outcomes: [o("rested", 70, { heal_pct: 40 }), o("ambushed", 30, { monster: 0 })] },
      { id: "leave", label: "Move on", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "snared_fox", terrains: ["forest", "meadow"],
    description: "a fox caught in a hunter's snare, too tired to struggle, watching you",
    choices: [
      { id: "free", label: "Free it", outcomes: [o("grateful", 70, { charm: 1 }), o("bitten", 30, { hurt_pct: 10 }, { charm: 1 })] },
      { id: "leave", label: "Leave it", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "watchtower", terrains: ["hills", "crags"],
    description: "a ruined watchtower, half its stair still clinging to the wall, with a view of everything from the top",
    choices: [
      { id: "climb", label: "Climb to the top", outcomes: [o("view", 65, { map: 4 }), o("fall", 35, { hurt_pct: 35 })] },
      { id: "search", label: "Search the base", outcomes: [o("cache", 40, { gold: 10 }), o("nest", 30, { monster: 1 }), o("nothing", 30, { nothing: true })] },
      { id: "leave", label: "Leave it", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "spring", terrains: ["meadow", "hills", "forest"],
    description: "a clear spring bubbling out of the rocks, the water so cold it aches",
    choices: [
      { id: "drink", label: "Drink deep", outcomes: [o("restored", 60, { heal_pct: 60 }), o("bracing", 30, { fights: 1 }), o("chill", 10, { hurt_pct: 10 })] },
      { id: "leave", label: "Keep walking", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "wild_peddler", terrains: "any",
    description: "a peddler with a mule, far from any road, selling tonics out of a crate with suspicious enthusiasm",
    choices: [
      { id: "tonic", label: "Buy a tonic", cost: 6, outcomes: [o("works", 65, { heal_pct: 100 }), o("strong", 20, { heal_pct: 50 }, { fights: 1 }), o("swindle", 15, { nothing: true })] },
      { id: "chat", label: "Pass the time", outcomes: [o("gossip", 50, { map: 1 }), o("sales_pitch", 50, { nothing: true })] },
      { id: "leave", label: "Wave and walk on", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "glint", terrains: ["forest", "meadow", "marsh"], quest: "lost_ring",
    description: "something glinting in the mud at the edge of the path: a small silver ring, tarnished almost black",
    choices: [
      { id: "take", label: "Pick it up", outcomes: [o("pocketed", 100, { quest: "lost_ring" })] },
      { id: "leave", label: "Leave it in the mud", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
  {
    id: "torn_scrap", terrains: ["hills", "forest", "crags"], quest: "torn_map",
    description: "a scrap of old vellum caught on a thornbush, inked with a river, a cairn and half of an X",
    choices: [
      { id: "take", label: "Take the scrap", outcomes: [o("kept", 100, { quest: "torn_map" })] },
      { id: "leave", label: "Let the wind have it", outcomes: [o("left", 100, { nothing: true })] },
    ],
  },
];

/** Chance a step turns up an event, and how many a day at most. */
// DRAGONS_DOOR_EVENT_CHANCE=1 forces one on every step, for local testing.
export const EVENT_CHANCE = Number(process.env.DRAGONS_DOOR_EVENT_CHANCE ?? 0.15);
export const EVENTS_PER_DAY = 3;
/** Travel over known land is free, but the road can still surprise you: this much per step of distance, up to a cap. */
export const ROAD_EVENT_PER_STEP = 0.05;
export const ROAD_EVENT_MAX = 0.4;

export function eventsFor(terrain: Terrain): WildEvent[] {
  return EVENTS.filter((e) => e.terrains === "any" || e.terrains.includes(terrain));
}

export const eventById = (id: string) => EVENTS.find((e) => e.id === id) ?? null;

export function rollOutcome(c: Choice, r = Math.random): Outcome {
  const total = c.outcomes.reduce((n, x) => n + x.weight, 0);
  let x = r() * total;
  for (const out of c.outcomes) { if (x < out.weight) return out; x -= out.weight; }
  return c.outcomes[c.outcomes.length - 1];
}
