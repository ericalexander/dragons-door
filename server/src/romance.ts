/**
 * Who can be courted, when, and what marrying them does. Anyone can court and marry anyone. Also what charm is good for.
 * Shared by the game and the simulator so they can't drift apart.
 */
import { roll } from "./combat.js";
import { TZ, realmHour } from "./schedule.js";

export type Perk = "inn" | "healer" | "guard" | "charm";
export interface Suitor {
  name: string;
  /** How the narrator refers to them. */
  pronouns: "she/her" | "he/him" | "they/them";
  /** Where to find them (for the narrator). */
  where: "tavern" | "healer" | "square";
  description: string;
  /** Realm hours (Eastern) they're around, [from, to); to may pass midnight (e.g. [19, 25] = 7pm-1am). */
  hours?: [number, number];
  /** Days of the week they're in town (0 = Sunday). */
  days?: number[];
  /** Harder (positive) or easier (negative) to win than Verity. */
  coy: number;
  perk: Perk;
  perkText: string;
}

export const SUITORS: Suitor[] = [
  { name: "Verity", pronouns: "she/her", where: "tavern", description: "the barmaid at the tavern, quick-witted and hard to impress", coy: 0, perk: "inn",
    perkText: "rooms at the inn are half price" },
  { name: "Rowan", pronouns: "he/him", where: "healer", description: "the healer's apprentice, brisk and kind, with ink-stained fingers and no patience for heroics", hours: [7, 17], coy: 5, perk: "healer",
    perkText: "healing costs a quarter less" },
  { name: "Mara", pronouns: "she/her", where: "square", description: "the lamplighter, who walks the square after dark and knows every shadow in town", hours: [19, 25], coy: 10, perk: "guard",
    perkText: "robbers who find you in the fields get only half your gold" },
  { name: "Jory", pronouns: "they/them", where: "square", description: "a traveling juggler in town at the weekends, all grins and patter", days: [5, 6, 0], coy: -5, perk: "charm",
    perkText: "+1 charm every day" },
];

export const suitor = (name: string | null | undefined) => SUITORS.find((s) => s.name.toLowerCase() === (name ?? "").toLowerCase());

function weekday(now: Date): number {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(d);
}

/** Is this person around right now? */
export function available(s: Suitor, now = new Date()): boolean {
  if (s.days && !s.days.includes(weekday(now))) return false;
  if (s.hours) {
    const h = realmHour(now);
    const [from, to] = s.hours;
    if (!(h >= from && h < to) && !(to > 24 && h < to - 24)) return false;
  }
  return true;
}

/** How much charm counts when flirting: a quarter of it, up to 20 points, so weddings stay special. */
const FLIRT_SHARE = Number(process.env.SIM_FLIRT_SHARE ?? 0.25);
const FLIRT_CAP = Number(process.env.SIM_FLIRT_CAP ?? 20);
/** The roll a flirt needs to end in a wedding (out of 99, after charm and coyness). */
const WEDDING_AT = Number(process.env.SIM_WEDDING_AT ?? 100);
export const charmInFlirting = (charm: number) => Math.min(FLIRT_CAP, Math.floor(Math.max(0, charm) * FLIRT_SHARE));

/** The flirt itself. Charm helps, a little; some people are harder to win. */
export function flirtOutcome(charm: number, coy: number): { outcome: "ignored" | "smile" | "kiss" | "married"; delta: number } {
  const r = roll(99) + charmInFlirting(charm) - coy;
  if (r < 30) return { outcome: "ignored", delta: 0 };
  if (r < 70) return { outcome: "smile", delta: 1 };
  if (r < WEDDING_AT) return { outcome: "kiss", delta: 2 };
  return { outcome: "married", delta: 5 };
}

// ---------- what charm buys ----------

/** 1% off at the shop for every 10 charm, up to 10%. */
export const charmDiscount = (charm: number) => Math.min(10, Math.floor(Math.max(0, charm) / 10)) / 100;

/** A bard's or visitor's "nothing" gets a second chance: 1% per point of charm, up to 40%. */
export const charmLucky = (charm: number) => roll(99) < Math.min(40, Math.max(0, charm));

// ---------- what marriage buys ----------

export const spousePerk = (spouse: string | null | undefined): Perk | null => suitor(spouse)?.perk ?? null;
