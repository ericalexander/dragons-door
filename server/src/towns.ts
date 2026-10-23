/**
 * Towns besides Brightwater. Each sits on a tile of the map (world.ts) and has its own fixed
 * characters, who keep to their places like Odile or Violet, and its own townsfolk, who live there
 * and go about their goals. Who they are underneath is in the lore, not here.
 */
import type { TownId } from "./world.js";

export interface TownPerson { name: string; where: string; does: string }
export interface Town { id: TownId; name: string; blurb: string; people: TownPerson[]; auctioneer: string; buyer: string }

export const TOWNS: Partial<Record<TownId, Town>> = {
  ironhold: {
    id: "ironhold",
    name: "Ironhold",
    blurb: "a hillfort of grey stone far out in the hills, walled and gated, smoke from a great forge over everything",
    auctioneer: "Mabry Locke",
    buyer: "Brannagh Steel",
    people: [
      { name: "Sergeant Rusk", where: "the gate", does: "keeps the gate and the register of everyone who comes through it" },
      { name: "Brannagh Steel", where: "the forge", does: "runs the great forge; she can take a blade or a coat of mail past what any smith makes, and buys gear too" },
      { name: "Mabry Locke", where: "the auction house", does: "runs Ironhold's auction house, which shares a board with Brightwater's" },
      { name: "Jessamy Crane", where: "the Long Hall", does: "keeps the Long Hall: stew, bunks for the night, and stitches for the wounded" },
      { name: "Corra Bell", where: "the Long Hall", does: "sings in the Long Hall most nights, old marching songs with the words changed" },
      { name: "Tobin Harrow", where: "the armory", does: "keeps Ironhold's armory: armor and bags, fitted properly" },
    ],
  },
};

/** Which town a fixed character keeps to, if not Brightwater. */
export function homeOf(name: string): Town | null {
  for (const t of Object.values(TOWNS)) if (t && t.people.some((p) => p.name === name)) return t;
  return null;
}
