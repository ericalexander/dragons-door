/**
 * Town meetings. Eric puts a story question to a town (or the realm); players vote once each (level 2 and up,
 * no test characters), and the townsfolk vote in character, by what each of them cares about. The players'
 * votes decide; the townsfolk's are the town's mood, and break a tie. A meeting closes at the reset after its
 * last day, and the result goes in the news.
 */
import type { PoolClient } from "pg";
import type { Personality } from "./schedule.js";
import type { TownId } from "./world.js";
import { TOWNSFOLK } from "./letters.js";
import { plain, write } from "./llm.js";

export type Appeal = "careful" | "bold" | "faith" | "profit" | "kin" | "curiosity" | "order" | "mercy";
export interface PollOption { id: string; label: string; appeals?: Appeal[]; line?: string }
export interface Poll { id: number; town: TownId | null; question: string; about: string; options: PollOption[]; opens: string; closes: string; status: "open" | "closed"; result: PollResult | null }
export interface PollResult { winner: string; players: Record<string, number>; townsfolk: Record<string, number>; tie_broken_by_town?: boolean }

export const VOTE_MIN_LEVEL = 2;

/** What each kind of townsperson cares about, and how much. */
const CARES: Record<Personality, Partial<Record<Appeal, number>>> = {
  banker: { careful: 3, profit: 2, kin: 2 },
  drunk: { bold: 2, mercy: 2, kin: 1 },
  raider: { profit: 3, bold: 2 },
  gossip: { curiosity: 3, kin: 1 },
  pious: { faith: 3, mercy: 3 },
  reckless: { bold: 3, curiosity: 2 },
  seer: { curiosity: 2, faith: 2 },
  braggart: { order: 3, profit: 1, bold: 1 },
  veteran: { order: 2, careful: 2, kin: 1 },
  scout: { curiosity: 3, bold: 2 },
  scholar: { curiosity: 3, careful: 1 },
  pickpocket: { profit: 3, bold: 1 },
  watchman: { order: 3, mercy: 1 },
  prelate: { faith: 3, order: 2 },
};

/** Why they'd say they voted that way, by what swayed them. {choice} is the option's label. */
const WHY: Record<Appeal, string[]> = {
  careful: ["I voted for {choice}. Careful is how you get old.", "{choice}. Somebody has to think before they leap."],
  bold: ["{choice}, and I'd vote it twice. Nothing ever got better by waiting.", "I said {choice}. Fortune likes a loud voice."],
  faith: ["{choice}. The Lamp would have it so, I think.", "I voted {choice}, and I'll pray it was right."],
  profit: ["{choice}. Follow the coin; it knows the way.", "I voted {choice}. Someone's getting rich off this, and it may as well be us."],
  kin: ["{choice}. Look after your own first.", "I voted {choice}, for the people I'd miss."],
  curiosity: ["{choice}. I want to see what happens.", "I said {choice}. You don't learn anything by leaving it be."],
  order: ["{choice}. Rules are what keep the wall standing.", "I voted {choice}. Somebody has to keep the place in order."],
  mercy: ["{choice}. Be kind; it costs less than you'd think.", "I voted {choice}, because somebody ought to be gentle about it."],
};

const hash = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

/** A townsperson's vote: the option that appeals most to what they care about; ties settled by their name, so it's stable. */
export function townsfolkVote(name: string, p: Personality, poll: Pick<Poll, "id" | "options">): { choice: string; why: string } {
  const cares = CARES[p] ?? {};
  let best: { o: PollOption; score: number; swayed: Appeal | null } | null = null;
  for (const o of poll.options) {
    let score = 0, swayed: Appeal | null = null, top = 0;
    for (const a of o.appeals ?? []) { const w = cares[a] ?? 0; score += w; if (w > top) { top = w; swayed = a; } }
    score += (hash(`${poll.id}|${name}|${o.id}`) % 100) / 1000; // a whisker of personal taste
    if (!best || score > best.score) best = { o, score, swayed };
  }
  const o = best!.o;
  const lines = best!.swayed ? WHY[best!.swayed] : ["I voted {choice}. Don't ask me why."];
  const why = (o.line ?? lines[hash(`${poll.id}|${name}`) % lines.length]).replace("{choice}", o.label);
  return { choice: o.id, why };
}

/** Count a meeting's votes: players decide, the town breaks a tie. */
export function tally(poll: Pick<Poll, "options">, votes: { choice: string; townsfolk: boolean }[]): PollResult {
  const players: Record<string, number> = {}, townsfolk: Record<string, number> = {};
  for (const o of poll.options) { players[o.id] = 0; townsfolk[o.id] = 0; }
  for (const v of votes) (v.townsfolk ? townsfolk : players)[v.choice] = ((v.townsfolk ? townsfolk : players)[v.choice] ?? 0) + 1;
  const ids = poll.options.map((o) => o.id);
  const top = Math.max(...ids.map((i) => players[i]));
  let leaders = ids.filter((i) => players[i] === top);
  const tied = leaders.length > 1;
  if (tied) { const t = Math.max(...leaders.map((i) => townsfolk[i])); leaders = leaders.filter((i) => townsfolk[i] === t); }
  return { winner: leaders[0], players, townsfolk, ...(tied ? { tie_broken_by_town: true } : {}) };
}

/** Meetings open today, for a town (the realm-wide ones show everywhere). */
export async function openPolls(c: PoolClient, day: string, town: TownId | null): Promise<Poll[]> {
  return (await c.query<Poll>(
    `select id::int, town, question, about, options, opens::text, closes::text, status, result from polls
     where status = 'open' and opens <= $1 and (town is null or town = $2) order by id`, [day, town])).rows;
}

/**
 * The morning round: close meetings whose last day has passed (result in the news), then let the townsfolk vote
 * in the ones still open, each saying why in their own town's tavern.
 */
export async function settlePolls(c: PoolClient, day: string): Promise<string[]> {
  const log: string[] = [];
  const due = (await c.query<Poll>("select id::int, town, question, about, options, opens::text, closes::text, status, result from polls where status = 'open' and closes < $1", [day])).rows;
  for (const p of due) {
    const votes = (await c.query<{ choice: string; townsfolk: boolean }>("select choice, townsfolk from poll_votes where poll_id = $1", [p.id])).rows;
    const result = tally(p, votes);
    await c.query("update polls set status = 'closed', result = $2 where id = $1", [p.id, JSON.stringify(result)]);
    const label = p.options.find((o) => o.id === result.winner)?.label ?? result.winner;
    const voters = votes.filter((v) => !v.townsfolk).length;
    await c.query("insert into news (day, kind, actor, detail) values ($1, 'meeting_result', null, $2)",
      [day, JSON.stringify({ poll: p.id, town: p.town, question: p.question, winner: label, voters, tie_broken_by_town: result.tie_broken_by_town ?? false })]);
    log.push(`closed meeting ${p.id}: ${label}`);
  }
  const open = (await c.query<Poll>("select id::int, town, question, about, options, opens::text, closes::text, status, result from polls where status = 'open' and opens <= $1", [day])).rows;
  for (const p of open) {
    const folk = (await c.query<{ id: string; name: string; personality: Personality; home: string }>(
      `select p.id, p.name, b.personality, b.home from bots b join players p on p.id = b.player_id
       where p.alive and not exists (select 1 from poll_votes v where v.poll_id = $1 and v.player_id = p.id) and ($2::text is null or b.home = $2)`, [p.id, p.town])).rows;
    for (const f of folk) {
      // Not everyone gets round to it on the first day.
      if (hash(`${p.id}|${f.name}|${day}`) % 3 === 0 && p.closes > day) continue;
      const v = townsfolkVote(f.name, f.personality, p);
      await c.query("insert into poll_votes (poll_id, player_id, choice, townsfolk, why, day) values ($1, $2, $3, true, $4, $5) on conflict do nothing", [p.id, f.id, v.choice, v.why, day]);
      await c.query("insert into tavern (day, author, body, town) values ($1, $2, $3, $4)", [day, f.name, v.why.slice(0, 280), f.home]);
      log.push(`${f.name} voted ${v.choice} in meeting ${p.id}`);
    }
    log.push(...await exitPolls(c, p));
  }
  return log;
}

const INTERVIEW = `You write one exit-poll interview for a town meeting in Dragon's Door, a fantasy village text game. A townsperson has just voted and stops for a word on their way out of the square. Write only what they say: two or three short sentences, first person, in their own voice. Jump straight into their opinion, the way people actually talk: don't open with "I voted", don't announce or name their choice outright, and let what they think make it plain which way they went. Plain words, no stage directions, no quotation marks, no names of other real players. Stay inside the fiction. Never reveal anyone's secrets or invent history. If what swayed them doesn't fit who they are, find a reason that does fit them.`;

/** One interview per choice: the first townsperson who voted for it, in their own voice. Written once; if the writer is away, it waits for the next run. */
async function exitPolls(c: PoolClient, p: Poll): Promise<string[]> {
  const done = ((await c.query<{ interviews: Record<string, unknown> }>("select interviews from polls where id = $1", [p.id])).rows[0]?.interviews ?? {}) as Record<string, unknown>;
  const log: string[] = [];
  for (const o of p.options) {
    if (done[o.id]) continue;
    const v = (await c.query<{ name: string; personality: Personality; why: string | null }>(
      `select pl.name, b.personality, v.why from poll_votes v join players pl on pl.id = v.player_id join bots b on b.player_id = pl.id
       where v.poll_id = $1 and v.choice = $2 and v.townsfolk order by v.day, pl.name limit 1`, [p.id, o.id])).rows[0];
    if (!v) continue;
    const facts = { who: TOWNSFOLK[v.personality] ?? v.name, question: p.question, setting: p.about, they_voted_for: o.label, the_other_choices: p.options.filter((x) => x.id !== o.id).map((x) => x.label), what_swayed_them: o.appeals ?? [], their_one_line_reason: v.why };
    const text = await write({ system: INTERVIEW, content: `Facts as JSON:\n${JSON.stringify(facts, null, 1)}\n\nWrite what ${v.name} says.`, maxTokens: 300, model: process.env.LETTERS_MODEL ?? "claude-sonnet-5-5" });
    // No writer today: try again on the next run rather than fall back to a stock line.
    if (!text) continue;
    const said = plain(text, 420).replace(/^["“]|["”]$/g, "");
    await c.query("update polls set interviews = interviews || jsonb_build_object($2::text, jsonb_build_object('name', $3::text, 'said', $4::text)) where id = $1", [p.id, o.id, v.name, said]);
    log.push(`exit poll for ${o.id}: ${v.name}`);
  }
  return log;
}
