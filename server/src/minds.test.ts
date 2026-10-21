import { test } from "node:test";
import assert from "node:assert/strict";
import { awayToday, choose, finished, fraction, goalLabel, goalTalk, pickGoal, type Facts, type Mind } from "./minds.js";
import { PLAN, type Personality } from "./schedule.js";

const facts = (p: Personality, over: Partial<Facts> = {}): Facts => ({
  name: "Hilde", personality: p, level: 3, gold: 200, bank: 300, weapon_id: 0, armor_id: 0, married: false,
  explored: 0, farthest: 0, found_cave: null, top_rival: { name: "Pomfrey", level: 4 }, rival_level: 4, ...over,
});

test("every personality can pick a goal it hasn't finished yet, with words to go with it", () => {
  for (const p of Object.keys(PLAN) as Personality[]) {
    for (let i = 0; i < 30; i++) {
      const f = facts(p);
      const mind: Mind = {};
      const g = pickGoal(f, mind, "2026-10-21", Math.random);
      assert.ok(!finished(g, f, mind), `${p} ${g.kind} starts finished`);
      assert.ok(fraction(g, f, mind) < 1);
      assert.ok(goalLabel("Hilde", p, g).length > 5);
      for (const stage of [0, 1, 2] as const) assert.ok(goalTalk("Hilde", p, g, stage, Math.random).length > 5);
    }
  }
});

test("saving finishes when the bank gets there", () => {
  const f = facts("banker");
  const mind: Mind = {};
  const g = pickGoal(f, mind, "2026-10-21", () => 0);
  assert.equal(g.kind, "save");
  assert.ok(finished(g, { ...f, bank: g.target }, mind));
});

test("choices vary from day to day but stay in character", () => {
  const seen = new Map<string, number>();
  for (let i = 0; i < 400; i++) {
    const acts = choose("banker", { goal: pickGoal(facts("banker"), {}, "2026-10-21", () => 0) }, {
      hp: 30, max_hp: 30, fights_left: 10, gold: 100, can_upgrade: false, hint: ["forest"], last_session: false, night: false, grudge_target: null,
    }, Math.random);
    assert.ok(acts.filter((a) => a === "hunt" || a === "explore").length <= 1);
    seen.set(acts[0], (seen.get(acts[0]) ?? 0) + 1);
  }
  assert.ok(seen.size >= 3, `only ${[...seen.keys()]}`);
  assert.ok((seen.get("hunt") ?? 0) > 200, "Hilde still mostly hunts on a forest morning");
});

test("no fights left means no fighting", () => {
  for (let i = 0; i < 100; i++) {
    const acts = choose("reckless", {}, { hp: 30, max_hp: 30, fights_left: 0, gold: 0, can_upgrade: false, hint: ["forest"], last_session: true, night: false, grudge_target: null }, Math.random);
    assert.ok(!acts.includes("hunt") && !acts.includes("explore"));
  }
});

test("days away are rare and stable", () => {
  let away = 0;
  for (let d = 1; d <= 300; d++) {
    const day = `2027-01-${String((d % 28) + 1).padStart(2, "0")}-${d}`;
    const a = awayToday(day, "Hilde", "banker");
    assert.equal(a, awayToday(day, "Hilde", "banker"));
    if (a) away++;
  }
  assert.ok(away > 0 && away < 30, `away ${away} of 300`);
});
