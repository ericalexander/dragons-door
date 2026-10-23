/**
 * Paths and specializations. Everyone starts on one of three paths, named for how they fight, and plays it as
 * its base class (Steel as a warrior, Shadow as a thief, the gift as a mage) until level 5. Then they choose a
 * specialization from its teacher, and that's their class from then on. Masters won't test anyone for level 6
 * until they've chosen. Changing specialization within a path keeps your level (once a week, for a fee);
 * changing path starts you over, through the old class change at a teacher.
 *
 * Characters made before paths, by older plugins, and the townsfolk are already specialized: their class is
 * their specialization.
 */
import type { TownId } from "./world.js";

export type Path = "steel" | "shadow" | "gift";
export type Spec = "warrior" | "thief" | "mage" | "priest" | "guardian" | "bard";

export const SPECIALIZE_AT = 5;
export const SPEC_SWITCH_DAYS = 7;
export const SPEC_SWITCH_PER_LEVEL = 100;

export const PATHS: Record<Path, { name: string; base: "warrior" | "thief" | "mage"; home: TownId; fights: string }> = {
  steel: { name: "Steel", base: "warrior", home: "ironhold", fights: "up front, with blades and maces and heavy armor" },
  shadow: { name: "Shadow", base: "thief", home: "ironhold", fights: "quick and at range, with bows and daggers and light armor" },
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
  guardian: { path: "steel", teacher: "Sergeant Rusk", where: "Ironhold's gate", towns: ["ironhold"], about: "shield and defense: hard to bring down, and better at holding than hitting", open: false },
  thief: { path: "shadow", teacher: "the quiet corner of the tavern", where: "the tavern", towns: ["brightwater", "ironhold"], about: "the opportunist: quick, slippery, and finds more loot", open: true },
  mage: { path: "gift", teacher: "Mother Quill", where: "the library", towns: ["brightwater"], about: "spells and mana, and a Fireball when it counts", open: true },
  priest: { path: "gift", teacher: "Prior Hale", where: "the chapel", towns: ["brightwater"], about: "the Lamp's servant: modest blows, strong healing", open: true },
  bard: { path: "gift", teacher: "Dunstan the Unfinished", where: "the tavern", towns: ["brightwater"], about: "songs instead of blows: verses in a fight, sets in the tavern", open: false },
};

export const pathOfClass = (cls: string): Path => (SPECS[cls as Spec]?.path ?? "gift");
export const specsOf = (path: Path) => (Object.entries(SPECS) as [Spec, SpecDef][]).filter(([, s]) => s.path === path);
