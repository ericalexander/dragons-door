/**
 * Standing: how one townsperson or character feels about one player. Nothing new is stored. It's worked out each
 * time from what the realm already remembers between the two of them: how many days they've talked, gifts kept,
 * letters, quests done together, a marriage, and any time the player robbed them in the fields. Kindness fades a
 * little if you stop visiting (never below half: they remember you); a robbery fades over a couple of months.
 *
 * Players never see a number. People act on it: a word for the narrator (wary, friendly, trusted...), pasts told
 * sooner to friends and secrets only to the trusted, a better price from a shopkeeper who likes you.
 */
import type pg from "pg";
import { QUESTS } from "./quests.js";

export type Standing = "hostile" | "wary" | "stranger" | "acquaintance" | "friendly" | "trusted" | "close";

export interface StandingFacts {
  /** Days they've talked (npc_memory.talks counts one a day). */
  talkDays: number;
  /** Gifts they kept from the player: their worth in gold, each. */
  gifts: number[];
  /** Days the player wrote to them. */
  letterDays: number;
  /** Quests the player finished that this person was part of. */
  quests: number;
  /** Days since each time the player robbed them in the fields. */
  robbedDaysAgo: number[];
  /** Days since the player last talked, wrote or sent a gift. Null if never. */
  sinceContact: number | null;
  married: boolean;
}

export const STANDING = {
  talk: 1, talkFull: 5, talkAfter: 0.5, talkCap: 12,
  gift: 1, giftPerGold: 1 / 250, giftMax: 3, giftCap: 6,
  letter: 0.5, letterCap: 3,
  quest: 3, questCap: 9,
  robbed: -6, robbedForgetDays: 60,
  fadeAfter: 10, fadePerDay: 0.02, fadeFloor: 0.5,
  married: 20,
} as const;

/** The score behind the word. */
export function score(f: StandingFacts): number {
  const S = STANDING;
  const talk = Math.min(S.talkCap, Math.min(f.talkDays, S.talkFull) * S.talk + Math.max(0, f.talkDays - S.talkFull) * S.talkAfter);
  const gifts = Math.min(S.giftCap, f.gifts.reduce((n, worth) => n + S.gift + Math.min(S.giftMax, worth * S.giftPerGold), 0));
  const letters = Math.min(S.letterCap, f.letterDays * S.letter);
  const quests = Math.min(S.questCap, f.quests * S.quest);
  let kind = talk + gifts + letters + quests;
  if (f.sinceContact !== null && f.sinceContact > S.fadeAfter) kind *= Math.max(S.fadeFloor, 1 - S.fadePerDay * (f.sinceContact - S.fadeAfter));
  const hurt = f.robbedDaysAgo.reduce((n, d) => n + S.robbed * Math.max(0, 1 - d / S.robbedForgetDays), 0);
  const total = kind + hurt;
  return f.married ? Math.max(total, S.married) : total;
}

/** The word for it. Someone you've never spoken to is a stranger, however the rest adds up, unless you've hurt them. */
export function word(points: number, met: boolean): Standing {
  if (points <= -4) return "hostile";
  if (points < 0) return "wary";
  if (!met && points < 1) return "stranger";
  if (points < 3) return "acquaintance";
  if (points < 7) return "friendly";
  if (points < 13) return "trusted";
  return "close";
}

/** How the narrator should play each word. */
export const HOW: Record<Standing, string> = {
  hostile: "They want nothing to do with the player and show it: short, cold, maybe a pointed remark about what the player did. They tell nothing of themselves.",
  wary: "Guarded: polite at best, keeping it short, watching the player. They tell nothing of themselves.",
  stranger: "They don't know the player yet: civil, curious or indifferent as is their way.",
  acquaintance: "They know the player's face: friendly enough, as with any regular.",
  friendly: "They like the player: warm, glad to see them, they use the player's name.",
  trusted: "They trust the player: at ease, candid, they might confide something or ask a favour.",
  close: "The player is one of their nearest: open, affectionate in their own way, the kind who'd go out of their way for them.",
};

/** How far a shopkeeper's liking takes a price down. */
export const PRICE_CUT: Partial<Record<Standing, number>> = { friendly: 0.03, trusted: 0.06, close: 0.1 };

/** The chance of hearing the next piece of someone's past, by how they feel. Secrets only to the trusted. */
export function pastChance(base: number, w: Standing, secret: boolean): number {
  if (w === "hostile" || w === "wary") return 0;
  if (secret && w !== "trusted" && w !== "close") return 0;
  if (w === "stranger" || w === "acquaintance") return base * 0.7;
  if (w === "friendly") return base;
  return Math.min(0.8, base + 0.2);
}

/** Quests this person is part of: they start it, or a step needs talking to them. */
const questsWith = (name: string) => QUESTS.filter((q) => q.start_on?.talk.includes(name)
  || q.steps.some((st) => st.on && "talk" in st.on && Array.isArray(st.on.talk) && st.on.talk.includes(name))).map((q) => q.id);

/** What the realm remembers between this player and this person, as of today. */
export async function factsOf(c: pg.PoolClient | pg.Pool, player: { id: string; name: string; spouse_id: string | null }, who: { id: string; name: string }, day: string): Promise<StandingFacts & { met: boolean }> {
  const r = (await c.query<{ talks: number | null; last_talk: string | null; gifts: number[] | null; last_gift: string | null; letters: number; last_letter: string | null; robbed: number[] | null; quests: number }>(
    `select m.talks, m.last_talk::text,
       (select array_agg(g.gold + g.gems * 100 + case when g.slot is not null then 150 + 150 * g.rarity else 0 end) from gifts g where g.from_player = $1 and g.to_player = $2 and g.state = 'kept') as gifts,
       (select max(g.sent_day)::text from gifts g where g.from_player = $1 and g.to_player = $2) as last_gift,
       (select count(distinct (ms.created_at at time zone 'utc')::date)::int from messages ms where ms.from_player = $1 and ms.to_player = $2) as letters,
       (select max(ms.created_at)::date::text from messages ms where ms.from_player = $1 and ms.to_player = $2) as last_letter,
       (select array_agg($5::date - n.day) from news n where n.kind = 'pvp_kill' and n.actor = $3 and n.target = $4 and n.day > $5::date - 60) as robbed,
       (select count(*)::int from quests q where q.player_id = $1 and q.status = 'done' and q.quest = any($6)) as quests
     from (select 1) one left join npc_memory m on m.player_id = $1 and m.npc = $4`,
    [player.id, who.id, player.name, who.name, day, questsWith(who.name)])).rows[0]!;
  const last = [r.last_talk, r.last_gift, r.last_letter].filter((d): d is string => Boolean(d)).sort().pop() ?? null;
  return {
    talkDays: r.talks ?? 0, gifts: r.gifts ?? [], letterDays: r.letters, quests: r.quests, robbedDaysAgo: r.robbed ?? [],
    sinceContact: last ? Math.round((Date.parse(day) - Date.parse(last)) / 86_400_000) : null,
    married: player.spouse_id !== null && player.spouse_id === who.id,
    met: (r.talks ?? 0) > 0,
  };
}

/** How this person feels about this player: the word, and the score for anything that weighs it. */
export async function standingWith(c: pg.PoolClient | pg.Pool, player: { id: string; name: string; spouse_id: string | null }, who: { id: string; name: string }, day: string): Promise<{ word: Standing; points: number }> {
  const f = await factsOf(c, player, who, day);
  const points = score(f);
  return { word: word(points, f.met), points: Math.round(points * 10) / 10 };
}
