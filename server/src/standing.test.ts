import { test } from "node:test";
import assert from "node:assert/strict";
import { pastChance, score, word, type StandingFacts } from "./standing.js";

const none: StandingFacts = { talkDays: 0, gifts: [], letterDays: 0, quests: 0, robbedDaysAgo: [], sinceContact: null, married: false };
const w = (f: Partial<StandingFacts>, met = (f.talkDays ?? 0) > 0) => word(score({ ...none, ...f }), met);

test("standing grows with time spent together, gifts and quests", () => {
  assert.equal(w({}), "stranger");
  assert.equal(w({ talkDays: 1, sinceContact: 0 }), "acquaintance");
  assert.equal(w({ talkDays: 4, sinceContact: 0 }), "friendly");
  // A week of talking alone doesn't make someone trust you; a quest or a kindness on top does.
  assert.equal(w({ talkDays: 7, sinceContact: 0 }), "friendly");
  assert.equal(w({ talkDays: 7, quests: 1, sinceContact: 0 }), "trusted");
  assert.equal(w({ talkDays: 5, gifts: [500], letterDays: 2, sinceContact: 0 }), "trusted");
  assert.equal(w({ talkDays: 12, quests: 2, gifts: [300], sinceContact: 0 }), "close");
  assert.equal(w({ married: true }, true), "close");
});

test("kindness fades if you stop visiting, but never below half", () => {
  const near = score({ ...none, talkDays: 8, quests: 1, sinceContact: 0 });
  const later = score({ ...none, talkDays: 8, quests: 1, sinceContact: 30 });
  const long = score({ ...none, talkDays: 8, quests: 1, sinceContact: 400 });
  assert.ok(later < near && later > near / 2);
  assert.equal(long, near / 2);
});

test("robbing someone turns them against you, and it takes a couple of months to fade", () => {
  assert.equal(w({ talkDays: 3, robbedDaysAgo: [1], sinceContact: 1 }), "wary");
  assert.equal(w({ robbedDaysAgo: [0] }, false), "hostile");
  assert.equal(w({ talkDays: 4, robbedDaysAgo: [59], sinceContact: 1 }), "friendly");
});

test("pasts come faster to friends, secrets only to the trusted, nothing to the wary", () => {
  assert.equal(pastChance(0.5, "wary", false), 0);
  assert.equal(pastChance(0.5, "friendly", true), 0);
  assert.equal(pastChance(0.5, "trusted", true), 0.7);
  assert.ok(pastChance(0.5, "acquaintance", false) < pastChance(0.5, "friendly", false));
});
