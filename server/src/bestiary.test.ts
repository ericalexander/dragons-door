import { test } from "node:test";
import assert from "node:assert/strict";
import { BESTIARY, regionAt } from "./bestiary.js";
import { pickMonster } from "./combat.js";
import { GAME } from "./game.js";
import { TOWN_TILES } from "./world.js";

test("every regional level has one name per old monster at that level, so fights balance the same", () => {
  for (const [region, levels] of Object.entries(BESTIARY)) {
    for (const [lvl, names] of Object.entries(levels)) {
      const pool = GAME.monsters.filter((m) => m.level === Number(lvl));
      assert.equal(names.length, pool.length, `${region} level ${lvl}`);
    }
  }
});

test("a regional monster fights exactly like the old one it stands in for", () => {
  for (let i = 0; i < 400; i++) {
    const m = pickMonster(4, "marsh");
    const pool = GAME.monsters.filter((x) => x.level === m.level);
    const k = BESTIARY.marsh[m.level].indexOf(m.name);
    assert.ok(k >= 0, m.name);
    assert.equal(m.str, pool[k].str); assert.equal(m.def, pool[k].def); assert.equal(m.exp, pool[k].exp);
  }
});

test("the land round Ironhold is its own, caves are caves, and Brightwater's forest keeps the old names", () => {
  const t = TOWN_TILES.ironhold;
  assert.equal(regionAt(t.x + 1, t.y + 1), "highland");
  assert.equal(regionAt(2, 0, true), "cave");
  const old = new Set(GAME.monsters.map((m) => m.name));
  for (let i = 0; i < 50; i++) assert.ok(old.has(pickMonster(2, "forest").name));
  for (let i = 0; i < 50; i++) assert.ok(old.has(pickMonster(2).name));
});

test("a region with no one at a level falls back to the old monsters", () => {
  const old = new Set(GAME.monsters.map((m) => m.name));
  for (let i = 0; i < 50; i++) { const m = pickMonster(1, "crags"); if (m.level === 1) assert.ok(old.has(m.name)); }
});
