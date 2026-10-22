/**
 * The auction house: the rules, kept apart from the routes so they're easy to read and change.
 *
 * Players list gear, ore, jewelry or gems for a few days with a minimum bid and, if they like, a
 * buy-now price. The house holds the item and the high bid (taken from the bidder's purse and bank),
 * refunds anyone outbid by mail, and settles at the daily reset: the seller is paid, less the house's
 * cut, and the item waits at the house for the buyer to collect. Unsold items go back the same way.
 *
 * The house's own lots come only from its storeroom: whatever players and townsfolk sold to the smith or
 * to Odile. Nothing is made up, house lots never start below shop worth, and the house steps back when
 * players are selling.
 *
 * Against rigged sales (passing gold between friends through a fake sale), for now: a buy-now price
 * can't be lower than the smith would pay for the item, and no price can go above three times what
 * the item is worth. Expect to tune these once it's seen real use.
 */
import { GAME } from "./game.js";
import * as Bag from "./bag.js";
import { GEM_SELL } from "./caves.js";

export type ListSlot = "weapon" | "armor" | "ore" | "trinket" | "gem";
export const TOWNS = { brightwater: "Brightwater", ironhold: "Ironhold" } as const;
export type Town = keyof typeof TOWNS;

export const AUCTION = {
  /** How long a listing can run, in realm days. It closes at the reset after its last day. */
  minDays: 1, maxDays: 3,
  /** Open listings one seller can have at once. */
  maxOpen: 5,
  /** Listing fee: a share of the minimum bid, at least this much gold. Not refunded. */
  feeShare: 0.05, feeMin: 5,
  /** The house keeps this share of every sale. */
  cut: 0.1,
  /** A new bid must beat the last by this share (at least 1 gold). */
  raise: 0.05,
  /** No price above this many times what the item is worth. */
  ceiling: 3,
  /** The house lists from its storeroom (what's been sold to the smith and Odile), up to this many lots of its own,
   *  one per kind of item, and only while players have fewer than playerQuiet lots up. */
  houseLots: 3, playerQuiet: 5,
  /** House lots start at full shop worth, so a player can always undercut them; buy-now is a quarter above. */
  houseBuyNow: 1.25,
  /** Most of one thing the house puts in a single lot. */
  houseLotMax: { ore: 3, gem: 2 } as Partial<Record<ListSlot, number>>,
};

/** What one of the item is worth at the shop, and what the smith (or Odile, for gems) pays for it. */
export function worth(slot: ListSlot, id: number, r = 0): { value: number; smith: number; name: string; weight: number } {
  if (slot === "gem") return { value: GEM_SELL * 2, smith: GEM_SELL, name: "Gem", weight: 0 };
  const it = Bag.item(slot, id, r);
  return { value: it.cost, smith: Bag.sellPrice(slot, id, r), name: it.name, weight: it.weight };
}

export const listingFee = (minBid: number) => Math.max(AUCTION.feeMin, Math.ceil(minBid * AUCTION.feeShare));
export const houseCut = (price: number) => Math.floor(price * AUCTION.cut);
export const nextBid = (minBid: number, high: number | null) => high === null ? minBid : high + Math.max(1, Math.ceil(high * AUCTION.raise));

/** Why a listing's prices aren't allowed, or null if they are. */
export function priceProblem(slot: ListSlot, id: number, qty: number, minBid: number, buyNow: number | null, r = 0): string | null {
  const w = worth(slot, id, r);
  const cap = Math.max(10, w.value * qty * AUCTION.ceiling);
  if (minBid < 1) return "the minimum bid has to be at least 1 gold";
  if (minBid > cap) return `no price can go above ${cap} gold for that (three times what it's worth)`;
  if (buyNow !== null) {
    if (buyNow < minBid) return "the buy-now price can't be below the minimum bid";
    if (buyNow < w.smith * qty) return `the buy-now price can't be below what the smith would pay: ${w.smith * qty} gold`;
    if (buyNow > cap) return `no price can go above ${cap} gold for that (three times what it's worth)`;
  }
  return null;
}
export const bidCeiling = (slot: ListSlot, id: number, qty: number, r = 0) => Math.max(10, worth(slot, id, r).value * qty * AUCTION.ceiling);

export const sellFraction = GAME.sellFraction;
