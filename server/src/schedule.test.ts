import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTime } from "./bots.js";
import { realmDay } from "./day.js";

const mins = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

test("summer: 7am Eastern is 11:00Z, within the jitter", () => {
  const t = sessionTime("2026-07-15", "07:00", "Hilde", 0);
  assert.ok(mins(t, new Date("2026-07-15T11:00:00Z")) <= 30, t.toISOString());
});

test("winter: 7am Eastern is 12:00Z, within the jitter", () => {
  const t = sessionTime("2026-12-15", "07:00", "Hilde", 0);
  assert.ok(mins(t, new Date("2026-12-15T12:00:00Z")) <= 30, t.toISOString());
});

test("Vesper's 11pm raid stays in the same realm day, summer and winter", () => {
  for (const day of ["2026-07-15", "2026-12-15", "2026-11-01", "2026-03-08"]) {
    for (let k = 0; k < 20; k++) {
      const t = sessionTime(day, "23:00", "Vesper" + k, 2);
      assert.equal(realmDay(5, t), day, `${day} ${t.toISOString()}`);
    }
  }
});

test("the shift is stable for a given day and different across days", () => {
  const a = sessionTime("2026-10-20", "12:00", "Hilde", 1).getTime();
  assert.equal(sessionTime("2026-10-20", "12:00", "Hilde", 1).getTime(), a);
  const days = new Set(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"].map((d) => sessionTime(d, "12:00", "Hilde", 1).getUTCMinutes()));
  assert.ok(days.size > 1, "jitter should vary day to day");
});

test("every townsperson's steps line up with their timetable", async () => {
  const { STEPS } = await import("./bots.js");
  const { PLAN } = await import("./schedule.js");
  for (const p of Object.keys(PLAN) as (keyof typeof PLAN)[]) assert.equal(STEPS[p].length, PLAN[p].length, p);
});

test("whereabouts follow the timetable", async () => {
  const { whereabouts, sessionTime } = await import("./schedule.js");
  const day = "2026-10-21";
  const t0 = sessionTime(day, "07:00", "Hilde", 0);
  assert.equal(whereabouts("banker", "Hilde", day, new Date(t0.getTime() - 3 * 3600_000), true).where, "asleep");
  assert.equal(whereabouts("banker", "Hilde", day, new Date(t0.getTime() - 10 * 60_000), true).where, "heading");
  assert.equal(whereabouts("banker", "Hilde", day, new Date(t0.getTime() + 10 * 60_000), true).where, "forest");
  assert.equal(whereabouts("banker", "Hilde", day, new Date(t0.getTime() + 2 * 3600_000), true).where, "square");
  assert.equal(whereabouts("banker", "Hilde", day, new Date(t0.getTime() + 2 * 3600_000), false).where, "dead");
});
