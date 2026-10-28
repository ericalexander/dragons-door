/**
 * The bridge troll's riddles. The riddles and their answers live in the lore table (kind 'riddle'), never in
 * this code, so nobody can look them up. Some are old riddles anyone might know; some are about the realm,
 * and only someone who's listened in taverns or read what turns up in the wild will know those.
 *
 * The player types their own answer and the server judges it: a little give on wording ("a shadow",
 * "shadows", "it's your shadow"), none on guessing several things at once.
 */
export interface Riddle { key: string; text: string; answers: string[]; realm: boolean }

/** Longest answer we'll judge, in words. Long enough for "I think it's a long dark shadow", too short to list guesses. */
export const MAX_ANSWER_WORDS = 7;

const FILLER = new Set(["a", "an", "the", "my", "your", "his", "her", "its", "it", "is", "i", "think", "maybe", "perhaps", "you", "are", "am", "that", "of", "answer"]);

/** Lowercase words, apostrophes and punctuation gone, a trailing s dropped, filler words out. */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter((w) => w && !FILLER.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Right if one accepted answer's words appear, in order, in what they said, and they didn't hedge with an "or". */
export function judge(answer: string, accepted: string[]): boolean {
  const raw = answer.toLowerCase();
  if (/\b(or|and)\b|[,/]/.test(raw)) {
    // "a river, or a road" is two guesses; "salt and pepper" style answers aren't used, so any list is a hedge.
    const parts = raw.split(/\b(?:or|and)\b|[,/]/).map((x) => words(x)).filter((x) => x.length);
    if (parts.length > 1) return false;
  }
  const said = words(answer);
  if (!said.length || said.length > MAX_ANSWER_WORDS) return false;
  return accepted.some((a) => {
    const want = words(a);
    if (!want.length) return false;
    for (let i = 0; i + want.length <= said.length; i++) if (want.every((w, j) => said[i + j] === w)) return true;
    return false;
  });
}

/** One they haven't solved yet; about a third of the time, one about the realm if there's one left. */
export function pickRiddle(all: Riddle[], solved: Set<string>, r = Math.random): Riddle | null {
  const left = all.filter((x) => !solved.has(x.key));
  const pool = left.length ? left : all;
  if (!pool.length) return null;
  const realm = pool.filter((x) => x.realm), plain = pool.filter((x) => !x.realm);
  const from = realm.length && (r() < 0.35 || !plain.length) ? realm : plain;
  return from[Math.floor(r() * from.length)];
}
