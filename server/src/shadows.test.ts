import { test } from "node:test";
import assert from "node:assert/strict";
import { SOUR, deedDay, sourness, type Shadow } from "./shadows.js";

// A made-up shadow: the real ones live only in the private lore.
const s: Shadow = { key: "test", kind: "mischief", who: "Nobody", town: "nowhere", every_days: 4, deeds: { well: { lines: ["x"] } } };
const days = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));

test("a shadow acts every so often, never twice close together, and the same days every time you ask", () => {
  const hits = days.filter((d) => deedDay(s, d));
  // Once in every_days at most, a little less for the spacing: about one in seven here.
  assert.ok(hits.length > 35 && hits.length < 90, `hits ${hits.length}`);
  for (let i = 1; i < hits.length; i++) assert.ok(Date.parse(hits[i]!) - Date.parse(hits[i - 1]!) > 2 * 86_400_000, `${hits[i - 1]} then ${hits[i]}`);
  assert.deepEqual(days.map((d) => deedDay(s, d)), days.map((d) => deedDay(s, d)));
  // Two shadows don't share a calendar.
  const other = { ...s, key: "other" };
  assert.notDeepEqual(days.map((d) => deedDay(s, d)), days.map((d) => deedDay(other, d)));
});

test("a fresh whisper is enough to set two strangers against each other, and it fades in a month", () => {
  assert.equal(sourness([0]), SOUR.points);
  assert.ok(sourness([0]) <= -4);
  assert.ok(sourness([15]) > sourness([0]) && sourness([15]) < 0);
  assert.equal(sourness([SOUR.days]), 0);
  assert.equal(sourness([]), 0);
});
