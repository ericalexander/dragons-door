import { test } from "node:test";
import assert from "node:assert/strict";
import { rollsOf } from "./trial.js";

test("a turn's fight events become the dice the page shows", () => {
  const r = rollsOf([
    { kind: "encounter", monster: "Wild Boar" },
    { kind: "hit", attacker: "Ana", defender: "Wild Boar", damage: 7, crit: true },
    { kind: "miss", attacker: "Wild Boar", defender: "Ana" },
    { kind: "monster_slain", monster: "Wild Boar", gold: 5 },
    { kind: "loot", item: "Hide Vest" },
  ]);
  assert.deepEqual(r, [
    { k: "hit", by: "Ana", at: "Wild Boar", dmg: 7, crit: true },
    { k: "miss", by: "Wild Boar", at: "Ana" },
    { k: "slain", at: "Wild Boar" },
    { k: "loot", item: "Hide Vest" },
  ]);
});
