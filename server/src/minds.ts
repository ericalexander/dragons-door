/**
 * What the townsfolk want. Each townsperson carries one big goal at a time, picked to suit them
 * (Hilde saves, Pip wants to outrank somebody, Brother Ansel raises money for the shrine), and a few
 * needs read fresh from their state (hurt, broke, out of fights). Every session they choose what to
 * do by weighing those against their nature, with some dice, so no two days run quite the same.
 *
 * Their timetable (schedule.ts) still says when they're awake. This decides what they do with it.
 * Everything here is pure: the runner in bots.ts gathers the facts and carries out the choices.
 */
import { createHash } from "node:crypto";
import type { Personality, Doing } from "./schedule.js";
import { GAME } from "./game.js";

export type GoalKind = "save" | "gear" | "level" | "explore" | "far" | "cave" | "wed" | "shrine" | "rich" | "outrank" | "jewel";
export type Activity = "hunt" | "explore" | "tavern" | "shop" | "bank" | "flirt" | "bard" | "donate" | "raid" | "rest" | "mine" | "craft";

/** Jewelry tier: 0 none, 1 copper, 2 silver, 3 gold (by recipe id, see caves.ts). */
export const jewelTier = (trinketId: number) => (trinketId >= 7 ? 3 : trinketId >= 4 ? 2 : trinketId >= 1 ? 1 : 0);

export interface Goal {
  kind: GoalKind;
  /** Gold, a level, a tile count, a ring or a gear id, depending on the kind. */
  target: number;
  /** For gear: which slot. For outrank: who. */
  slot?: "weapon" | "armor";
  rival?: string;
  since: string;
  /** Progress when the goal was picked, so "halfway" means halfway from there. */
  start: number;
}

export interface Mind {
  goal?: Goal;
  /** Goals they've finished, newest first. */
  done?: { kind: GoalKind; line: string; day: string }[];
  /** Gold given to the shrine so far (Brother Ansel). */
  given?: number;
  /** Someone who robbed them, and when. */
  grudge?: { name: string; day: string };
  /** -2 (shaken) to +2 (full of themselves). Deaths knock it down, good days lift it. */
  mood?: number;
  /** The last progress milestone they've talked about (0, 1 = halfway, 2 = nearly there). */
  told?: number;
  /** What they actually did in each session today, so the square tells the truth. */
  today?: { day: string; sessions: Record<string, Activity[]> };
  /** What they were up to on their latest outing in the wild, for the square. */
  last_trip?: { day: string; place: string; steps: number };
}

export interface Facts {
  name: string;
  personality: Personality;
  level: number;
  gold: number;
  bank: number;
  weapon_id: number;
  armor_id: number;
  married: boolean;
  /** Tiles they've explored, and the farthest ring they've reached. */
  explored: number;
  farthest: number;
  found_cave: string | null;
  trinket_id: number;
  /** The highest-ranked other townsperson, for outranking. */
  top_rival: { name: string; level: number } | null;
  rival_level: number | null;
}

// ---------- choosing and tracking a goal ----------

const LEANS: Record<Personality, [GoalKind, number][]> = {
  banker:   [["save", 5], ["gear", 2], ["level", 2], ["jewel", 1]],
  drunk:    [["wed", 3], ["explore", 3], ["level", 1]],
  raider:   [["rich", 4], ["gear", 2], ["level", 1]],
  gossip:   [["wed", 2], ["save", 2], ["explore", 2], ["jewel", 1]],
  pious:    [["shrine", 5], ["level", 1]],
  reckless: [["outrank", 4], ["far", 3], ["level", 1]],
  seer:     [["cave", 4], ["jewel", 3], ["save", 2], ["explore", 1]],
  braggart: [["gear", 5], ["jewel", 2], ["outrank", 2], ["wed", 2]],
  veteran:  [["level", 3], ["rich", 2], ["far", 1]],
  scout:    [["far", 4], ["cave", 3], ["explore", 2]],
  scholar:  [["explore", 3], ["cave", 2], ["level", 2]],
};

const round100 = (n: number) => Math.max(100, Math.round(n / 100) * 100);
const gearCost = (slot: "weapon" | "armor", id: number) => (slot === "weapon" ? GAME.weapons : GAME.armor).find((g) => g.id === id)?.cost ?? Infinity;
const gearName = (slot: "weapon" | "armor", id: number) => (slot === "weapon" ? GAME.weapons : GAME.armor).find((g) => g.id === id)?.name ?? "something fine";

/** How far along a goal is, in its own units. */
export function progress(g: Goal, f: Facts, mind: Mind): number {
  switch (g.kind) {
    case "save": return f.bank;
    case "rich": return f.gold + f.bank;
    case "gear": return (g.slot === "weapon" ? f.weapon_id : f.armor_id) >= g.target ? g.target : 0;
    case "level": return f.level;
    case "explore": return f.explored;
    case "far": return f.farthest;
    case "cave": return f.found_cave ? 1 : 0;
    case "wed": return f.married ? 1 : 0;
    case "shrine": return mind.given ?? 0;
    case "outrank": return f.rival_level !== null && f.level > f.rival_level ? 1 : 0;
    case "jewel": return jewelTier(f.trinket_id);
  }
}

/** 0 to 1. Gear counts the gold saved toward it, so a purse filling up reads as progress. */
export function fraction(g: Goal, f: Facts, mind: Mind): number {
  if (g.kind === "gear") {
    if (progress(g, f, mind) >= g.target) return 1;
    return Math.min(0.99, (f.gold + f.bank) / gearCost(g.slot!, g.target));
  }
  if (["cave", "wed", "outrank", "jewel"].includes(g.kind)) return progress(g, f, mind) >= g.target ? 1 : 0;
  const p = progress(g, f, mind);
  if (p >= g.target) return 1;
  return Math.max(0, Math.min(0.99, (p - g.start) / Math.max(1, g.target - g.start)));
}

export const finished = (g: Goal, f: Facts, mind: Mind) => fraction(g, f, mind) >= 1;

export function pickGoal(f: Facts, mind: Mind, day: string, r: () => number): Goal {
  const last = mind.done?.[0]?.kind;
  const options = LEANS[f.personality].filter(([k]) => {
    if (k === last && LEANS[f.personality].length > 1) return false; // something new for a change
    if (k === "wed" && f.married) return false;
    if (k === "outrank" && !f.top_rival) return false;
    if (k === "cave" && f.found_cave) return false;
    if (k === "jewel" && jewelTier(f.trinket_id) >= 3) return false;
    if (k === "gear" && Math.min(f.weapon_id, f.armor_id) >= GAME.weapons.length - 1) return false;
    return true;
  });
  const total = options.reduce((n, [, w]) => n + w, 0);
  let x = r() * total;
  let kind: GoalKind = options[0]?.[0] ?? "level";
  for (const [k, w] of options) { if (x < w) { kind = k; break; } x -= w; }
  const g = (target: number, extra: Partial<Goal> = {}): Goal => {
    const goal: Goal = { kind, target, since: day, start: 0, ...extra };
    goal.start = Math.min(progress(goal, f, mind), target - 1);
    return goal;
  };
  switch (kind) {
    case "save": return g(round100(f.bank + 400 * f.level + 300));
    case "rich": return g(round100(f.gold + f.bank + 500 * f.level + 500));
    case "gear": {
      const slot = f.weapon_id <= f.armor_id ? "weapon" : "armor";
      return g((slot === "weapon" ? f.weapon_id : f.armor_id) + 1, { slot });
    }
    case "level": return g(f.level + 2);
    case "explore": return g(f.explored + 8 + Math.floor(r() * 6));
    case "far": return g(Math.max(f.farthest + 2, 3));
    case "cave": return g(1);
    case "wed": return g(1);
    case "shrine": return g(round100((mind.given ?? 0) + 300 * f.level + 300));
    case "outrank": return g(1, { rival: f.top_rival!.name });
    case "jewel": return g(jewelTier(f.trinket_id) + 1);
  }
}

// ---------- what a goal sounds like ----------

const PRONOUN: Record<string, ["he" | "she" | "they", "his" | "her" | "their"]> = {
  Hilde: ["she", "her"], Vesper: ["she", "her"], "Madam Orsolya": ["she", "her"],
};
const pro = (name: string) => PRONOUN[name] ?? ["he", "his"];
const fmt = (n: number) => n.toLocaleString("en-US");
const METAL = ["", "copper", "silver", "gold"];

/** A phrase for the square and the narrator: what's on their mind. */
export function goalLabel(name: string, p: Personality, g: Goal): string {
  const [he, his] = pro(name);
  const n = fmt(g.target);
  const item = g.slot ? gearName(g.slot, g.target) : "";
  switch (g.kind) {
    case "save":
      if (p === "banker") return `saving ${n} gold to retire to a cottage by the river`;
      if (p === "gossip") return `putting ${n} gold by for a proper funeral, though ${he}'s in no hurry`;
      if (p === "seer") return `saving ${n} gold for a crystal ball that actually works`;
      return `trying to get ${n} gold in the bank`;
    case "rich": return p === "raider" ? `set on having ${n} gold to ${his} name, by any means` : `wants to be worth ${n} gold`;
    case "gear": return p === "braggart" ? `set on buying a ${item}, and telling everyone so` : `saving for a ${item}`;
    case "level": return `determined to reach level ${g.target}`;
    case "explore":
      if (p === "drunk") return `looking for ${his} other boot, which ${he}'s sure is somewhere past the gate`;
      if (p === "gossip") return `wants to see the hills once more before ${his} knees give out`;
      return `walking the land past the gate to see what's there`;
    case "far": return `wants to go farther from town than ever before`;
    case "cave": return p === "seer" ? `the cards keep showing ${his} a cave in the hills, and ${he} means to find it` : `looking for a cave in the hills`;
    case "wed":
      if (p === "drunk") return `has decided to get married, and has told everyone`;
      if (p === "gossip") return `sweet on someone and too shy to say who`;
      if (p === "braggart") return `means to marry, and has written the speech already`;
      return `hoping to marry`;
    case "shrine": return `raising ${n} gold to mend the old shrine on the hill`;
    case "jewel": return p === "seer" ? `wants a piece of ${METAL[g.target]} jewelry from Odile, and swears it will sharpen the sight` : p === "braggart" ? `has commissioned ${METAL[g.target]} jewelry from Odile, once he digs up the ore` : `saving ore for a piece of ${METAL[g.target]} jewelry from Odile`;
    case "outrank": return p === "reckless" ? `wants to outrank ${g.rival}, and won't shut up about it` : `can't abide that ${g.rival} outranks ${his === "her" ? "her" : "him"}`;
  }
}

/** A headline when they get there. */
export function doneLine(name: string, p: Personality, g: Goal, f: Facts): string {
  const [he] = pro(name);
  const n = fmt(g.target);
  switch (g.kind) {
    case "save": return p === "banker" ? `${name} has ${n} gold in the bank. The cottage by the river is nearly ${pro(name)[1] === "her" ? "hers" : "his"}.` : `${name} has ${n} gold in the bank and is telling everyone.`;
    case "rich": return `${name} is worth ${n} gold. Nobody asks how.`;
    case "gear": return `${name} bought a ${gearName(g.slot!, g.target)} and won't stop showing it off.`;
    case "level": return `${name} reached level ${g.target}, just as ${he} said ${he} would.`;
    case "explore": return p === "drunk" ? `${name} found a boot out past the gate. ${he[0].toUpperCase() + he.slice(1)} says it's ${pro(name)[1] === "her" ? "hers" : "his"}. It isn't.` : `${name} walked the land past the gate and came home with stories.`;
    case "far": return `${name} went farther from town than ${he} ever has and came back to brag about it.`;
    case "cave": return `${name} found the cave ${p === "seer" ? "the cards showed her" : "they'd been looking for"}: ${f.found_cave}.`;
    case "wed": return `${name} is married at last.`;
    case "shrine": return `${name} raised ${n} gold, and the old shrine on the hill has a new roof.`;
    case "outrank": return `${name} now outranks ${g.rival}, and ${g.rival} has heard about it.`;
    case "jewel": return `${name} is wearing new ${METAL[g.target]} jewelry from Odile and catching the light on purpose.`;
  }
}

/** What they say in the tavern about it, in their own voice. stage: 0 just started, 1 halfway, 2 nearly there. */
export function goalTalk(name: string, p: Personality, g: Goal, stage: 0 | 1 | 2, r: () => number): string {
  const n = fmt(g.target);
  const item = g.slot ? gearName(g.slot, g.target) : "";
  const pick = (a: string[]) => a[Math.floor(r() * a.length)];
  const lines: Record<GoalKind, string[][]> = {
    save: [
      [p === "banker" ? `I'm putting ${n} gold in the bank and then I'm done. A cottage. A river. No more ogres.` : `${n} gold in the bank. That's the plan. Don't tempt me.`,
       `I've started saving. ${n} gold, then we'll see who's laughing.`],
      [`Halfway to ${n} gold. I count it every night.`, `The banker knows my name now. Halfway there.`],
      [`Nearly ${n} gold in the bank. Nobody rob me this week, please.`, `So close to ${n} I can hear the river.`],
    ],
    rich: [
      [`I'll have ${n} gold to my name before the moon turns. How is my business.`, `${n} gold. I've a list of whose pockets it's in.`],
      [`Halfway to ${n}. Sleep at the inn, all of you. Or don't.`, `The purse is getting heavy. I like heavy.`],
      [`Nearly ${n} gold. One good night and I'm there.`, `Don't count my money. I'm counting it.`],
    ],
    gear: [
      [p === "braggart" ? `I shall own a ${item}. The shopkeeper has been told to keep it for me.` : `Saving for a ${item}. Then the forest can watch out.`,
       `Has anyone else noticed the ${item} in the shop window? It's mine. Soon.`],
      [`Halfway to that ${item}. I've been to look at it twice.`, `Every coin goes to the ${item}. Every one.`],
      [`One more good day and the ${item} is mine.`, `I can almost feel the weight of that ${item}.`],
    ],
    level: [
      [`Level ${g.target}. That's where I'm going. Watch.`, `My master says I'm not ready for level ${g.target}. My master is wrong.`],
      [`Getting there. Level ${g.target} is close enough to smell.`, `I'm stronger than last week. Ask the wolves.`],
      [`Nearly level ${g.target}. One more good fight.`, `Tomorrow, I think. Level ${g.target}. Tomorrow.`],
    ],
    explore: [
      [p === "drunk" ? `My other boot is out there somewhere past the gate. I'm going to find it.` : `I'm going out past the gate to see what's there. Somebody has to.`,
       `There's a whole world out there and I've seen about four fields of it.`],
      [`Been out past the gate most days. Saw a marsh. Didn't care for it.`, p === "drunk" ? `No boot yet. Found a very good stick, though.` : `Halfway round the near hills. My feet hate me.`],
      [p === "drunk" ? `I can feel it. The boot is close.` : `Nearly seen all I meant to. Then I'm sitting down for a week.`, `One more walk and I'll have seen it all. The near bit, anyway.`],
    ],
    far: [
      [`I'm going farther out than anyone. Further than Hilde, further than anybody.`, `Everyone stops at the hills. Not me.`],
      [`Got past the hills today. Something out there looked at me funny.`, `Halfway to farther than anyone. That's a lot of farther.`],
      [`Nearly as far as I said. Don't wait up.`, `One more day's walk and nobody will have been farther than me.`],
    ],
    cave: [
      [p === "seer" ? `The cards show me a cave in the hills. Again. Fine. I'll go and find it.` : `There's a cave in the hills. I mean to find it.`, `Somewhere in the hills there's a hole in the ground with my name on it.`],
      [`Not yet. The hills have a lot of rocks and only some of them are caves.`, `I'm close. The cards say so. The cards also said that yesterday.`],
      [`Nearly. I can feel the cold air coming off it.`, `Tomorrow I find it. Or the day after.`],
    ],
    wed: [
      [p === "drunk" ? `I'm getting married. To whom is a detail.` : p === "braggart" ? `I intend to marry. I have the speech ready. It is long.` : `I've been thinking about marriage. Don't laugh.`,
       `Is it so strange to want someone to come home to?`],
      [`I think they smiled at me today. I think.`, `Bought a flower. It's wilting. So am I.`],
      [`Any day now. I can feel it.`, `I've practiced asking in the mirror. The mirror said yes.`],
    ],
    shrine: [
      [`The shrine on the hill has a hole in its roof. I mean to raise ${n} gold to mend it. Give, if you can.`, `${n} gold for the shrine. The gods are patient. The rain is not.`],
      [`Halfway to mending the shrine. Bless every one of you who gave, and the rest of you too.`, `The roof leaks a little less in my imagination already.`],
      [`Nearly enough for the shrine. One more good week of honest work.`, `The masons are ready. I nearly am.`],
    ],
    jewel: [
      [`I'm going to have Odile make me something in ${METAL[g.target]}. First I need the ore. And a pick. And a cave.`, `Odile says bring her ${METAL[g.target]} ore and she'll make something worth wearing. Right.`],
      [`Got some of the ore. My back hates me. Odile will love it.`, `Halfway there. Do you know how heavy ore is? I do now.`],
      [`One more trip underground and Odile can start work.`, `Nearly enough ore. Odile has already cleared a space on her bench.`],
    ],
    outrank: [
      [p === "reckless" ? `I'm going to outrank ${g.rival}. Write it down.` : `It is unacceptable that ${g.rival} stands above me. It will be corrected.`, `${g.rival} had better enjoy the view from up there while it lasts.`],
      [`Catching up on ${g.rival}. They know it, too.`, `${g.rival} looked worried today. Good.`],
      [`One more level and ${g.rival} is looking up at me.`, `Tell ${g.rival} to start practicing a gracious face.`],
    ],
  };
  return pick(lines[g.kind][stage]).slice(0, 280);
}

// ---------- needs and choices ----------

export interface Situation {
  hp: number;
  max_hp: number;
  fights_left: number;
  gold: number;
  /** Can afford the next weapon or armor upgrade right now (gold + bank). */
  can_upgrade: boolean;
  /** What the timetable says this session is for. */
  hint: Doing[];
  last_session: boolean;
  night: boolean;
  /** Robbed by someone in the last few days and they're within reach. */
  grudge_target: string | null;
  /** They know a cave and have a pickaxe (or can buy one), with swings left today. */
  can_mine?: boolean;
  /** Odile could make them something better than what they wear, from what they carry. */
  can_craft?: boolean;
}

const BASE: Record<Personality, Partial<Record<Activity, number>>> = {
  banker:   { hunt: 3, explore: 0.6, tavern: 0.4, shop: 0.3, bank: 0.5, flirt: 0.1, bard: 0.1, rest: 0.1 },
  drunk:    { hunt: 3, explore: 1.2, tavern: 2, flirt: 0.6, bard: 0.6, rest: 0.2 },
  raider:   { hunt: 3, explore: 1, tavern: 0.4, shop: 0.4, rest: 0.1 },
  gossip:   { hunt: 1.2, explore: 0.4, tavern: 3, flirt: 0.4, bard: 0.6, rest: 0.3 },
  pious:    { hunt: 2, explore: 0.4, tavern: 1.2, bard: 0.3, rest: 0.2 },
  reckless: { hunt: 3, explore: 2, tavern: 0.8, flirt: 0.3, rest: 0.05 },
  seer:     { hunt: 2, explore: 1, tavern: 2, bard: 0.3, rest: 0.15 },
  braggart: { hunt: 2, explore: 0.6, tavern: 2, shop: 1.2, flirt: 0.5, bard: 0.6, rest: 0.1 },
  veteran:  { hunt: 3, explore: 0.5, tavern: 0.8, shop: 1, rest: 0.1 },
  scout:    { hunt: 2, explore: 3, tavern: 0.3, rest: 0.1 },
  scholar:  { hunt: 1.5, explore: 2, tavern: 1.5, shop: 0.3, rest: 0.2 },
};

const FIGHTING: Activity[] = ["hunt", "explore", "mine"];

/** Weigh what they could do this session. Returns the weights, for testing and for the log. */
export function weigh(p: Personality, mind: Mind, s: Situation): Partial<Record<Activity, number>> {
  const w: Partial<Record<Activity, number>> = { ...BASE[p] };
  const add = (a: Activity, n: number) => { w[a] = Math.max(0, (w[a] ?? 0) + n); };
  const mood = mind.mood ?? 0;
  // the timetable is a habit, not a rule
  for (const d of s.hint) {
    if (d === "forest") { add("hunt", 2); add("explore", 0.5); }
    if (d === "tavern") add("tavern", 2.5);
    if (d === "shop") add("shop", 2);
    if (d === "fields") add("raid", 4);
  }
  switch (mind.goal?.kind) {
    case "save": add("hunt", 1); add("bank", 1); break;
    case "rich": add("hunt", 1); if (s.night) add("raid", 1.5); break;
    case "gear": add("hunt", 1); if (s.can_upgrade) add("shop", 6); break;
    case "level": add("hunt", 2); add("explore", 0.8); break;
    case "explore": case "far": case "cave": add("explore", 4); break;
    case "wed": add("flirt", 2.5); add("bard", 0.5); break;
    case "shrine": add("hunt", 1); if (s.gold >= 50) add("donate", 3); break;
    case "outrank": add("hunt", 2); add("explore", 1); break;
    case "jewel": if (s.can_mine) add("mine", 4); else add("explore", 2); break;
  }
  if (s.can_mine) add("mine", 0.4 + (mind.goal?.kind === "save" || mind.goal?.kind === "rich" ? 0.6 : 0));
  else w.mine = 0;
  if (s.can_craft) add("craft", 5); else w.craft = 0;
  if (mood > 0) add("explore", 0.5 * mood);
  if (mood < 0) { add("explore", mood); add("rest", -0.5 * mood); add("tavern", -0.3 * mood); }
  const hurt = 1 - s.hp / Math.max(1, s.max_hp);
  if (hurt > 0.6) { add("rest", hurt); add("tavern", 0.5); }
  if (s.fights_left <= 0) { w.hunt = 0; w.explore = 0; }
  if (!s.can_upgrade && mind.goal?.kind !== "gear") w.shop = Math.min(w.shop ?? 0, 0.2);
  if (s.can_upgrade) add("shop", 0.5);
  if (s.grudge_target && s.night) add("raid", 3);
  if (!s.night && !s.hint.includes("fields")) w.raid = 0;
  if (!s.grudge_target && p !== "raider") w.raid = 0;
  return w;
}

/** Pick one to three things to do this session. At most one of them is fighting. */
export function choose(p: Personality, mind: Mind, s: Situation, r: () => number): Activity[] {
  const w = weigh(p, mind, s);
  const draw = (pool: Partial<Record<Activity, number>>): Activity | null => {
    const entries = Object.entries(pool).filter(([, v]) => (v ?? 0) > 0) as [Activity, number][];
    const total = entries.reduce((n, [, v]) => n + v, 0);
    if (!total) return null;
    let x = r() * total;
    for (const [a, v] of entries) { if (x < v) return a; x -= v; }
    return entries[entries.length - 1][0];
  };
  const first = draw(w) ?? "rest";
  const out: Activity[] = [first];
  const rest = { ...w };
  delete rest[first];
  if (FIGHTING.includes(first)) for (const a of FIGHTING) delete rest[a];
  delete rest.rest;
  // a second, smaller thing now and then: a drink after the forest, the shop on the way home
  if (first !== "rest" && r() < 0.45) {
    const second = draw(rest);
    if (second) {
      out.push(second);
      if (FIGHTING.includes(second)) for (const a of FIGHTING) delete rest[a];
      delete rest[second];
      if (r() < 0.2) { const third = draw(rest); if (third) out.push(third); }
    }
  }
  // fighting comes before talking about it
  out.sort((a, b) => Number(FIGHTING.includes(b)) - Number(FIGHTING.includes(a)));
  return out;
}

// ---------- days away ----------

const AWAY: Record<Personality, string[]> = {
  banker: ["gone to Ashford to look at cottages", "visiting her sister down the river"],
  drunk: ["sleeping off something in a barn two villages over", "gone to a wedding he wasn't invited to"],
  raider: ["away on business she won't discuss", "gone to Ashford; the Ashford watch hasn't noticed yet"],
  gossip: ["visiting an old friend who is even older", "gone to Ashford for the market and the gossip"],
  pious: ["on retreat at the monastery in the hills", "walking to a shrine with Sister Agathe's pilgrims"],
  reckless: ["sent to Ashford with a cart of turnips", "helping at his uncle's farm for the day"],
  seer: ["reading cards at a fair in another town", "communing with something, she says; the door is locked"],
  braggart: ["at a tournament in Ashford, by his own account", "having his armor fitted in the city"],
  veteran: ["up on the wall all day; it's his watch", "gone hunting alone, the way he does once a month"],
  scout: ["off somewhere past the ridge; she didn't say where", "mapping a valley nobody's named yet"],
  scholar: ["copying an inscription in a ruin two days' walk away", "shut in with her notes; the door has a sign on it"],
};

/** About one day in thirty, each townsperson is simply gone for the day. Stable per day, so the square agrees. */
export function awayToday(day: string, name: string, p: Personality): string | null {
  const h = createHash("sha256").update(`away|${day}|${name}`).digest();
  if (h.readUInt16BE(0) % 30 !== 0) return null;
  const reasons = AWAY[p];
  return reasons[h.readUInt8(2) % reasons.length];
}

/** A small random number source the runner can seed from Math.random; pure functions take it as an argument. */
export const rng = () => Math.random();
