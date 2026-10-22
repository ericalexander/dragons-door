/**
 * Side quests: short chains of situations that play out over a few days.
 *
 * Borrowing the shape of a plot-building system (a situation leads to the next, and a choice decides
 * which), each quest is data: a way to start, a few steps, and endings. A step waits for something to
 * happen (talking to someone, arriving at a place, meeting a stranger in the square), sometimes not before
 * a day or two has passed, and then either moves on or offers a choice. The server owns every step and
 * reward; the narrator gets a cue and tells it.
 *
 * Quests belong to the player who started them. Each one closes by a deadline if it's left hanging.
 * Quests tied to the realm's lore aren't here: they live in the lore table and are added at load (lore.ts).
 */
import type { Effect } from "./events.js";

export type Trigger =
  | { talk: string[] | "townsfolk"; chance?: number }   // talking to one of these (or any townsperson)
  | { arrive: true }                                     // stepping onto the quest's target tile
  | { meet: string };                                    // a stranger who appears in the square for this player

export type QEffect =
  | Effect
  | { give_item: true }          // the quest item goes in the bag
  | { take_item: true }          // and comes out again
  | { trinket: number }          // a piece of jewelry, straight onto them or into the bag
  | { place_target: { near: number; far: number; terrain?: string; side?: "north" | "east" | "south" | "west" } }  // pick a spot this many rings out (relative to their farthest), of a kind of land or on one side of town if it can
  | { mark_target: true };       // and mark it on their map

export interface QChoice { id: string; label: string; cost?: number; effects: QEffect[]; then?: string; end?: string;
  /** A line for the news when this choice is made. {name} is the player. */
  news?: string }

export interface QStep {
  id: string;
  /** The journal line: what the player knows at this point. {area} is the target's rough whereabouts. */
  know: string;
  on?: Trigger;
  /** The trigger can't fire until this many days after the step began. */
  after_days?: number;
  /** For the narrator when the trigger fires: what happens, in plain words. */
  cue: string;
  effects?: QEffect[];
  choices?: QChoice[];
  then?: string;
  end?: string;
}

export interface QuestDef {
  id: string;
  /** Fixed number for its quest item in bags. Quests in code use their place in the list; quests from the lore set one (100 and up). */
  index?: number;
  title: string;
  item?: { name: string; sell: number };
  /** Days before it closes on its own, from the start. */
  days: number;
  /** How it can start. Events start quests with a { quest } effect; a talk start offers it. */
  start_on?: { talk: string[]; chance: number; needs_secret?: boolean; /** Or: at least this many pieces of their past heard. */ needs_pieces?: number };
  steps: QStep[];
  /** What the narrator says if it runs out of time, by the step it was on (or "default"). */
  expired: Record<string, string>;
}

export const QUESTS: QuestDef[] = [
  {
    id: "lost_ring",
    title: "The Tarnished Ring",
    item: { name: "Tarnished Silver Ring", sell: 40 },
    days: 6,
    steps: [
      {
        id: "found",
        know: "You found a tarnished silver ring in the wild, with a worn crest inside the band. You don't know whose it is.",
        on: { talk: "townsfolk", chance: 0.6 },
        cue: "Gossip: a noblewoman from Ashford, Lady Ysolde, lost a family ring on the road and has been asking after it. She's expected through town in a day or two.",
        then: "heard",
      },
      {
        id: "heard",
        know: "The ring is Lady Ysolde's, a noblewoman from Ashford. She's expected through town soon, asking after it.",
        on: { meet: "Lady Ysolde" },
        after_days: 1,
        cue: "Lady Ysolde, travel-worn and anxious, is in the square asking everyone about a ring. She recognizes the crest the moment she sees it.",
        choices: [
          { id: "return", label: "Give it back", effects: [{ take_item: true }, { gold: 40 }, { charm: 2 }, { trinket: 10 }], end: "returned" },
          { id: "reward", label: "Ask what it's worth to her", effects: [{ take_item: true }, { gold: 90 }, { charm: -1 }], end: "haggled" },
          { id: "keep", label: "Say you've never seen it", effects: [], end: "kept" },
        ],
      },
    ],
    expired: { found: "The crest inside the ring means nothing to anyone now. It's just an old ring.", heard: "Lady Ysolde gave up and went home to Ashford without her ring.", default: "The trail went cold." },
  },
  {
    id: "grimwald_boot",
    title: "Grimwald's Other Boot",
    item: { name: "Grimwald's Boot", sell: 5 },
    days: 7,
    start_on: { talk: ["Grimwald"], chance: 0.35 },
    steps: [
      {
        id: "offered",
        know: "Grimwald lost his other boot somewhere out past the gate and would like it back.",
        cue: "Grimwald, one boot on and one foot wrapped in a sack, asks if you'd keep an eye out for his other boot. He thinks he left it out past the gate. He isn't sure which way.",
        choices: [
          { id: "accept", label: "Say you'll look for it", effects: [{ place_target: { near: 1, far: 2 } }], then: "searching" },
          { id: "decline", label: "Wish him luck", effects: [], end: "declined" },
        ],
      },
      {
        id: "searching",
        know: "Grimwald's boot is somewhere {area}. It's a very large boot.",
        on: { arrive: true },
        cue: "There, in the mud, enormous and unmistakable: Grimwald's boot. Something has been living in it.",
        effects: [{ give_item: true }],
        then: "found",
      },
      {
        id: "found",
        know: "You have Grimwald's boot. He'll be glad to see it.",
        on: { talk: ["Grimwald"] },
        cue: "Grimwald sees the boot and lets out a roar of joy that empties half the tavern.",
        choices: [
          { id: "return", label: "Hand it over", effects: [{ take_item: true }, { gold: 25 }, { exp: 20 }, { charm: 2 }], end: "returned" },
        ],
      },
    ],
    expired: { searching: "Grimwald found a different boot and declared the matter closed.", found: "Grimwald has stopped asking about the boot. It's yours now, for what that's worth.", default: "The matter of the boot was dropped." },
  },
  {
    id: "torn_map",
    title: "The Torn Map",
    item: { name: "Half a Torn Map", sell: 10 },
    days: 10,
    steps: [
      {
        id: "half",
        know: "Half of an old map, torn down the middle: a river, a cairn, and an X with nothing on your side to say where it is.",
        on: { talk: ["Old Tam"] },
        cue: "Old Tam squints at your half of the map, goes very quiet, and admits he has the other half in a drawer. He'll part with it, for a price.",
        choices: [
          { id: "buy", label: "Pay for his half", cost: 20, effects: [{ place_target: { near: 1, far: 3 } }, { mark_target: true }], then: "whole" },
          { id: "later", label: "Think about it", effects: [], then: "half" },
        ],
      },
      {
        id: "whole",
        know: "The map is whole. The X is {area}, and it's marked on your map.",
        on: { arrive: true },
        cue: "Under a cairn of flat stones, just where the X said: an iron box, rusted shut, and heavy.",
        effects: [{ take_item: true }, { gold: 60 }, { gem: 2 }, { exp: 15 }],
        end: "found_cache",
      },
    ],
    expired: { half: "The map's ink has faded past reading.", whole: "Someone else got to the cairn first. The box is gone.", default: "The map led nowhere in the end." },
  },
];

export const questById = (id: string) => QUESTS.find((q) => q.id === id) ?? null;
export const questIndex = (id: string) => { const i = QUESTS.findIndex((q) => q.id === id); return QUESTS[i]?.index ?? i; };
export const questByIndex = (n: number) => QUESTS.find((q, i) => (q.index ?? i) === n) ?? null;
export const stepOf = (q: QuestDef, id: string) => q.steps.find((s) => s.id === id) ?? null;
