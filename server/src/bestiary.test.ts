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
  const a = TOWN_TILES.ashford;
  assert.equal(regionAt(a.x + 1, a.y - 2), "riverside");
  for (let i = 0; i < 50; i++) assert.ok(BESTIARY.riverside[pickMonster(3, "riverside").level].length > 0);
  assert.equal(regionAt(2, 0, true), "cave");
  const old = new Set(GAME.monsters.map((m) => m.name));
  for (let i = 0; i < 50; i++) assert.ok(old.has(pickMonster(2, "forest").name));
  for (let i = 0; i < 50; i++) assert.ok(old.has(pickMonster(2).name));
});

test("a region with no one at a level falls back to the old monsters", () => {
  const old = new Set(GAME.monsters.map((m) => m.name));
  for (let i = 0; i < 50; i++) { const m = pickMonster(1, "crags"); if (m.level === 1) assert.ok(old.has(m.name)); }
});

import { countryOf, rollFind } from "./bestiary.js";

test("stone country gives ore, the lowlands gems, caves nothing off a kill", () => {
  const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };
  assert.deepEqual(rollFind("highland", 2, seq(0.01, 0.5)), { kind: "ore", ore: 0 });
  assert.deepEqual(rollFind("crags", 10, seq(0.01, 0.1)), { kind: "ore", ore: 2 });
  assert.deepEqual(rollFind("hills", 6, seq(0.01, 0.2)), { kind: "ore", ore: 1 });
  assert.deepEqual(rollFind("meadow", 3, seq(0.01)), { kind: "gem" });
  assert.equal(rollFind("cave", 5, seq(0.0)), null);
  assert.equal(rollFind("forest", 1, seq(0.5)), null);
});

test("each place belongs to the nearer town", () => {
  assert.equal(countryOf(2, 0), "brightwater");
  assert.equal(countryOf(0, -12), "ironhold");
  assert.equal(countryOf(-4, -11), "ironhold");
});
