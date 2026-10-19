import { test } from "node:test";
import assert from "node:assert/strict";
import { exchange, pickMonster, resolveFull, roll } from "./combat.js";
import { realmDay } from "./day.js";

test("roll is inclusive and never negative", () => {
  for (let i = 0; i < 1000; i++) {
    const r = roll(5);
    assert.ok(r >= 0 && r <= 5);
  }
  assert.equal(roll(0), 0);
  assert.equal(roll(-3), 0);
});

test("exchange never drops hp below zero and stops when defender dies", () => {
  const a = { name: "a", hp: 1, str: 100, def: 0 };
  const d = { name: "d", hp: 1, str: 100, def: 0 };
  const evs = exchange(a, d);
  assert.ok(a.hp >= 0 && d.hp >= 0);
  if (d.hp === 0) assert.equal(evs.length, 1, "defender died, no swing back");
});

test("resolveFull returns a winner for a lopsided fight", () => {
  const strong = { name: "s", hp: 100, str: 50, def: 10 };
  const weak = { name: "w", hp: 10, str: 1, def: 0 };
  const r = resolveFull(strong, weak);
  assert.equal(r.winner, "attacker");
  assert.ok(r.log.length > 0);
});

test("pickMonster stays near the player's level", () => {
  for (let lvl = 1; lvl <= 12; lvl++) {
    const m = pickMonster(lvl);
    assert.ok(m.hp > 0 && m.max_hp === m.hp);
  }
});

test("realmDay shifts by the reset hour", () => {
  // 04:00 UTC with a 05:00 reset is still "yesterday"
  assert.equal(realmDay(5, new Date("2026-10-19T04:00:00Z")), "2026-10-18");
  assert.equal(realmDay(5, new Date("2026-10-19T05:00:00Z")), "2026-10-19");
  assert.equal(realmDay(0, new Date("2026-10-19T00:00:00Z")), "2026-10-19");
});
