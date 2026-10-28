/**
 * Classes and the paths they belong to. Every class is open from the first day: you choose it when you make
 * your character, and it decides your home town. The three paths (Steel, Shadow, the gift) are only how the
 * classes are grouped: by how they fight, which gear is theirs, and which masters will train them.
 *
 * A few characters were made while paths came first and classes at level 5. Any still on a beginner's class
 * (specialized false) get one free choice within their path, at any level; nobody else specializes.
 */
import type { TownId } from "./world.js";

export type Path = "steel" | "shadow" | "gift";
export type Spec = "warrior" | "thief" | "mage" | "priest" | "guardian" | "bard";

export const SPECIALIZE_AT = 5;
export const SPEC_SWITCH_DAYS = 7;
export const SPEC_SWITCH_PER_LEVEL = 100;

export const PATHS: Record<Path, { name: string; base: "warrior" | "thief" | "mage"; home: TownId; fights: string }> = {
  steel: { name: "Steel", base: "warrior", home: "ironhold", fights: "up front, with blades and maces and heavy armor" },
  shadow: { name: "Shadow", base: "thief", home: "ashford", fights: "quick and at range, with bows and daggers and light armor" },
  gift: { name: "the gift", base: "mage", home: "brightwater", fights: "with magic" },
};

export interface SpecDef {
  path: Path;
  /** Who teaches it, and where. */
  teacher: string;
  where: string;
  towns: TownId[];
  /** Shown when choosing: what it's like, in a line. */
  about: string;
  /** Open to choose. A specialization being built stays closed until it's ready. */
  open: boolean;
}

export const SPECS: Record<Spec, SpecDef> = {
  warrior: { path: "steel", teacher: "the masters of the training yard", where: "the training yard", towns: ["brightwater", "ironhold"], about: "the straightforward fighter: hits hardest, takes the most punishment", open: true },
  guardian: { path: "steel", teacher: "Sergeant Rusk", where: "Ironhold's gate", towns: ["ironhold"], about: "shield and defense: hard to bring down, and better at holding than hitting", open: true },
  thief: { path: "shadow", teacher: "the quiet corner of the tavern, or the Magpie in Ashford's Undercroft", where: "the tavern, or the Undercroft", towns: ["brightwater", "ironhold", "ashford"], about: "the opportunist: quick, slippery, and finds more loot", open: true },
  mage: { path: "gift", teacher: "Mother Quill", where: "the library", towns: ["brightwater"], about: "spells and mana, and a Fireball when it counts", open: true },
  priest: { path: "gift", teacher: "Prior Hale", where: "the chapel", towns: ["brightwater"], about: "the Lamp's servant: modest blows, strong healing", open: true },
  bard: { path: "gift", teacher: "Mags Pell, or Dunstan the Unfinished", where: "Pell's Music Room in Ashford, or Brightwater's tavern", towns: ["ashford", "brightwater"], about: "songs instead of blows: verses in a fight, sets in the tavern", open: true },
};

/** Where each class starts: blades in Ironhold, the quick and the singers in Ashford, magic in Brightwater. */
export const CLASS_HOME: Record<Spec, TownId> = { warrior: "ironhold", guardian: "ironhold", thief: "ashford", bard: "ashford", mage: "brightwater", priest: "brightwater" };
export const CLASSES = Object.keys(CLASS_HOME) as Spec[];

export const pathOfClass = (cls: string): Path => (SPECS[cls as Spec]?.path ?? "gift");
export const specsOf = (path: Path) => (Object.entries(SPECS) as [Spec, SpecDef][]).filter(([, s]) => s.path === path);
