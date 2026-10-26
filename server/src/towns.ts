/**
 * Towns besides Brightwater. Each sits on a tile of the map (world.ts) and has its own fixed
 * characters, who keep to their places like Odile or Violet, and its own townsfolk, who live there
 * and go about their goals. Who they are underneath is in the lore, not here.
 */
import type { TownId } from "./world.js";

export interface TownPerson { name: string; where: string; does: string }
export interface Town {
  id: TownId; name: string; blurb: string; people: TownPerson[]; auctioneer: string; buyer: string;
  /** Which path's masters teach in its training yard (Brightwater's teach everyone). */
  trains: "steel" | "shadow";
  /** What a stranger can find there, for the town view, and the names the narrator uses for each. */
  services: Record<string, string>;
  /** The tavern (its own board), and where a bed for the night is. */
  tavern: string; inn: string;
  /** Whose forge takes gear past what any smith makes, if the town has one. */
  forge?: boolean;
}

export const TOWNS: Partial<Record<TownId, Town>> = {
  ironhold: {
    id: "ironhold",
    name: "Ironhold",
    blurb: "a hillfort of grey stone far out in the hills, walled and gated, smoke from a great forge over everything",
    auctioneer: "Mabry Locke",
    buyer: "Brannagh Steel",
    trains: "steel",
    tavern: "the Long Hall",
    inn: "a bunk in the Long Hall at Ironhold",
    forge: true,
    services: { healer: "Jessamy Crane, in the Long Hall", inn: "a bunk in the Long Hall (wake up here)", board: "the Long Hall's own board; Brightwater's tavern has its own", bank: "Mabry's strongbox, the same accounts as Brightwater's bank",
      weaponry: "Brannagh Steel's weaponry, at the forge", armory: "Tobin Harrow's armory: armor and bags, and a rack of robes and travelling clothes at the back for visitors", forge: "Brannagh Steel's forge", auction: "Mabry Locke's auction house, on the same board as Brightwater's", sell: "Brannagh Steel buys gear" },
    people: [
      { name: "Sergeant Rusk", where: "the gate", does: "keeps the gate and the register of everyone who comes through it" },
      { name: "Brannagh Steel", where: "the forge", does: "runs the great forge; she can take a blade or a coat of mail past what any smith makes, and buys gear too" },
      { name: "Mabry Locke", where: "the auction house", does: "runs Ironhold's auction house, which shares a board with Brightwater's" },
      { name: "Jessamy Crane", where: "the Long Hall", does: "keeps the Long Hall: stew, bunks for the night, and stitches for the wounded" },
      { name: "Corra Bell", where: "the Long Hall", does: "sings in the Long Hall most nights, old marching songs with the words changed" },
      { name: "Tobin Harrow", where: "the armory", does: "keeps Ironhold's armory: armor and bags, fitted properly" },
    ],
  },
  ashford: {
    id: "ashford",
    name: "Ashford",
    blurb: "the oldest and richest town in Dragon's Door, where the south road crosses the river Ash at a wide stone ford: a merchants' council, a counting house, a Lamphouse grander than Brightwater's chapel, and a herald on the Exchange steps",
    auctioneer: "Ysolde Fairweather",
    buyer: "Sim Haverly",
    trains: "shadow",
    tavern: "the Ford House",
    inn: "a room at the Ford House in Ashford",
    services: { healer: "Doctor Aurel Imre, the council's physician", inn: "a room at the Ford House (wake up here)", board: "the Ford House's own board; Brightwater's tavern has its own", bank: "the Counting House, Octavia Strand's: the same accounts as Brightwater's bank",
      weaponry: "Haverly's on the Exchange: bows, daggers and the rest", armory: "Haverly's: leathers, armor and bags; robes and fine clothes from a cloth-seller's stall on the Exchange", auction: "Ysolde Fairweather's auction house, on the same board as Brightwater's", sell: "Sim Haverly buys gear" },
    people: [
      { name: "Herald Ambrose Kettle", where: "the Exchange steps", does: "reads the council's proclamations from the Exchange steps every morning, whether or not anyone stops" },
      { name: "Agnes Fane", where: "the Ford House", does: "keeps the Ford House, Ashford's inn and tavern, with its own board" },
      { name: "Linnet", where: "the Ford House", does: "serves at the Ford House, quick, with the best ears in Ashford" },
      { name: "Octavia Strand", where: "the Counting House", does: "keeps the Counting House, Ashford's bank, as her family has for six generations" },
      { name: "Sim Haverly", where: "Haverly's", does: "keeps Haverly's on the Exchange: bows, daggers, light armor and the best arrows in the realm; buys gear too" },
      { name: "Ysolde Fairweather", where: "the auction house", does: "runs Ashford's auction house, which shares a board with Brightwater's and Ironhold's" },
      { name: "Doctor Aurel Imre", where: "his surgery", does: "the healer, the council's physician, trained in the far south" },
      { name: "Hesper Wick", where: "the Undercroft", does: "called the Magpie; keeps the Undercroft, a cellar under the old Exchange where those on the Shadow path learn their trade" },
    ],
  },
};

/** Which town a fixed character keeps to, if not Brightwater. */
export function homeOf(name: string): Town | null {
  for (const t of Object.values(TOWNS)) if (t && t.people.some((p) => p.name === name)) return t;
  return null;
}
