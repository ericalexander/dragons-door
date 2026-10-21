/**
 * When each kind of townsperson does what, in Eastern time. The bot runner plays these sessions;
 * the town square reads the same timetable to say who's about right now.
 */
import { createHash } from "node:crypto";

export type Personality = "banker" | "drunk" | "raider" | "gossip" | "pious" | "reckless" | "seer" | "braggart";
export type Doing = "forest" | "tavern" | "shop" | "fields";
export interface Slot { at: string; doing: Doing[]; sleeps?: "inn" | "fields" }

export const PLAN: Record<Personality, Slot[]> = {
  banker:   [{ at: "07:00", doing: ["forest"] }, { at: "12:00", doing: ["forest"] }, { at: "18:00", doing: ["forest"], sleeps: "inn" }],
  gossip:   [{ at: "08:00", doing: ["tavern"] }, { at: "14:00", doing: ["forest"] }, { at: "21:00", doing: ["tavern"], sleeps: "inn" }],
  drunk:    [{ at: "11:00", doing: ["forest"] }, { at: "15:00", doing: ["forest"] }, { at: "20:00", doing: ["tavern"], sleeps: "fields" }],
  raider:   [{ at: "10:00", doing: ["forest"] }, { at: "14:00", doing: ["forest"] }, { at: "23:00", doing: ["fields"], sleeps: "inn" }],
  pious:    [{ at: "05:30", doing: ["forest"] }, { at: "09:00", doing: ["tavern"] }, { at: "13:00", doing: ["forest"] }, { at: "19:00", doing: ["forest"], sleeps: "inn" }],
  reckless: [{ at: "16:00", doing: ["forest"], sleeps: "fields" }],
  seer:     [{ at: "17:00", doing: ["forest"] }, { at: "22:30", doing: ["tavern", "forest"], sleeps: "inn" }],
  braggart: [{ at: "09:30", doing: ["shop", "forest"] }, { at: "13:00", doing: ["forest", "tavern"] }, { at: "17:30", doing: ["forest", "shop", "tavern"], sleeps: "inn" }],
};

/** When they get up and turn in. Default: up an hour before their first session, in bed when the last one ends. */
export const HOURS: Partial<Record<Personality, { wakes?: string; beds?: string }>> = {
  pious:    { wakes: "05:00", beds: "20:00" },
  reckless: { wakes: "06:30", beds: "21:30" },   // Pip does chores all day, fights at four, then loiters until dark
  drunk:    { beds: "23:00" },                    // drinks in the tavern until late
  seer:     { wakes: "15:00", beds: "23:50" },
  braggart: { beds: "21:30" },                    // turns in late, after holding court
  gossip:   { beds: "22:00" },
  raider:   { wakes: "09:00" },
};

const JITTER_MIN = 30;
export const TZ = "America/New_York";

/** Stable per-day shift in minutes, in [-JITTER_MIN, +JITTER_MIN], so a rerun picks the same time. */
function jitter(day: string, name: string, i: number): number {
  const h = createHash("sha256").update(`${day}|${name}|${i}`).digest();
  return (h.readUInt16BE(0) % (2 * JITTER_MIN + 1)) - JITTER_MIN;
}

/** Offset of TZ from UTC at instant t, in ms. */
function tzOffset(t: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - t;
}

/** The instant a session happens on a given realm day: `at` Eastern on that calendar date, plus jitter. */
export function sessionTime(day: string, at: string, name: string, i: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = at.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const utc = guess - tzOffset(guess);
  return new Date(utc + jitter(day, name, i) * 60_000);
}

/** Hour of the day in the realm's clock (Eastern), 0-23. */
export function realmHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "2-digit" }).format(now));
}

export type Whereabouts =
  | { where: "square" }
  | { where: "heading"; to: Doing }
  | { where: Doing }
  | { where: "asleep"; at: "inn" | "fields" }
  | { where: "unseen" }
  | { where: "dead" };

const BUSY_MIN = 45;      // how long a session keeps them away
const HEADING_MIN = 20;   // seen leaving shortly before one starts

/** Where a townsperson is right now, from the same timetable the bot runner follows. */
export function whereabouts(p: Personality, name: string, day: string, now: Date, alive: boolean): Whereabouts {
  if (!alive) return { where: "dead" };
  const plan = PLAN[p];
  const times = plan.map((s, i) => sessionTime(day, s.at, name, i).getTime());
  const t = now.getTime();
  const lastSleep = plan[plan.length - 1].sleeps ?? "inn";
  const hrs = HOURS[p] ?? {};
  const wakeT = hrs.wakes ? sessionTime(day, hrs.wakes, name, 90).getTime() : times[0] - 60 * 60_000;
  const lastEnd = times[times.length - 1] + BUSY_MIN * 60_000;
  const bedT = hrs.beds ? Math.max(sessionTime(day, hrs.beds, name, 91).getTime(), lastEnd) : lastEnd;
  if (t < wakeT || t >= bedT) return { where: "asleep", at: lastSleep };
  for (let i = 0; i < plan.length; i++) {
    const start = times[i], end = start + BUSY_MIN * 60_000;
    if (t >= start - HEADING_MIN * 60_000 && t < start) return { where: "heading", to: plan[i].doing[0] };
    if (t >= start && t < end) {
      if (plan[i].doing[0] === "fields") return { where: "unseen" }; // nobody sees Vesper at work
      return { where: plan[i].doing[0] };
    }
    const next = times[i + 1];
    // after the last session, until bedtime: still in the tavern if that's where the evening went, else about town
    if (next === undefined && t >= end) return plan[i].doing.includes("tavern") ? { where: "tavern" } : { where: "square" };
    if (next !== undefined && t >= end && t < next - HEADING_MIN * 60_000) return { where: "square" };
  }
  return { where: "square" };
}
