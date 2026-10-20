/**
 * The tavern's bards. One plays each realm day, chosen from the date, so the whole realm
 * hears the same one. Each player may ask for one song a day. The server picks the reward;
 * the narrator writes the song.
 */
import { createHash } from "node:crypto";
import { roll } from "./combat.js";

export type Gift = "nothing" | "gold" | "charm" | "fight" | "heal" | "gem";

export interface Bard {
  name: string;
  /** For the narrator: who they are and how they sing. */
  style: string;
  /** What the song is about. */
  sings_about: "you" | "the news" | "himself" | "nothing you can name";
  /** Weighted gifts. `fights` is how many extra forest fights a "fight" gift gives. */
  gifts: [Gift, number][];
  fights: number;
}

export const BARDS: Bard[] = [
  {
    name: "Fennick Reed",
    style: "a cheerful pipe player who makes up a song on the spot about whoever asked, usually unflattering, always catchy",
    sings_about: "you",
    gifts: [["gold", 35], ["charm", 30], ["fight", 15], ["nothing", 20]],
    fights: 1,
  },
  {
    name: "Dunstan the Unfinished",
    style: "twenty years into one epic ballad of the realm; he plays you whichever verse he wrote last night, grand and slightly out of breath",
    sings_about: "the news",
    gifts: [["fight", 50], ["heal", 20], ["gold", 10], ["nothing", 20]],
    fights: 1,
  },
  {
    name: "Corwin Lark",
    style: "a wandering minstrel, handsome and aware of it, forever passing through and somehow never leaving; his songs are mostly about Corwin Lark",
    sings_about: "himself",
    gifts: [["charm", 40], ["heal", 30], ["gold", 10], ["nothing", 20]],
    fights: 1,
  },
  {
    name: "Wren",
    style: "quiet, a battered lute in the corner, barely speaks; when she sings the room goes still, and you're not sure afterward what the song was about",
    sings_about: "nothing you can name",
    gifts: [["nothing", 40], ["fight", 25], ["gem", 20], ["heal", 15]],
    fights: 2,
  },
];

export function bardFor(day: string): Bard {
  const h = createHash("sha256").update(`bard|${day}`).digest();
  return BARDS[h.readUInt32BE(0) % BARDS.length];
}

export function pickGift(b: Bard): Gift {
  const total = b.gifts.reduce((n, [, w]) => n + w, 0);
  let r = roll(total - 1);
  for (const [g, w] of b.gifts) { if (r < w) return g; r -= w; }
  return "nothing";
}
