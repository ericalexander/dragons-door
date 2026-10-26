/**
 * The words that go with a fight: the same every time, so players come to know them. A mage's spell always has
 * the same incantation (made from its name, in a tongue nobody's spoken in a long while), and a guardian says the
 * same oath, a line a round. The narrator writes everything else; nothing here touches a roll (see FLAIR in api.ts).
 */
import { createHash } from "node:crypto";

const OPEN = ["ka", "vel", "sor", "ith", "mar", "ul", "zeh", "an", "ory", "tal", "ne", "esh", "vor", "ira", "keth", "lu", "dra", "om", "sae", "thul"];
const CLOSE = ["ith", "ar", "esh", "on", "ael", "uun", "os", "ra", "is", "ent", "ak", "ume", "oth", "ia"];

/** Deterministic: n words for this spell, built from its name. */
function words(name: string, n: number, salt = ""): string[] {
  const h = createHash("sha256").update(name.toLowerCase() + salt).digest();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = OPEN[h[i * 3] % OPEN.length], b = OPEN[h[i * 3 + 1] % OPEN.length], c = CLOSE[h[i * 3 + 2] % CLOSE.length];
    const w = (h[i * 3 + 1] % 4 === 0 && b.slice(0, 2) !== a.slice(0, 2) ? a + b.slice(0, 2) + c : a + c).replace(/(.)\1+/g, "$1");
    out.push(i === 0 ? w[0].toUpperCase() + w.slice(1) : w);
  }
  return out;
}

/** A spell's words: three for an ordinary cast; the big one gets a second, longer line. */
export function incantation(spell: string, big: boolean): string {
  const first = words(spell, 3).join(" ");
  if (!big) return `${first}.`;
  return `${first}, ${words(spell, 4, "+").join(" ").toLowerCase()}!`;
}

/** The guardian's oath, one line a round, from the top again after the last. */
export const OATH = [
  "I stand where the road narrows.",
  "What comes for them comes through me.",
  "I do not ask the weight. I carry it.",
  "My shield is a door, and it is shut.",
  "I have been struck before. I am still here.",
  "Let them run. I am not going anywhere.",
  "When I fall, I fall forward.",
  "No one passes.",
];
export const oathLine = (round: number) => OATH[(Math.max(1, round) - 1) % OATH.length];
