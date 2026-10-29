import { test } from "node:test";
import assert from "node:assert/strict";
import { affinity } from "./bonds.js";

test("temperaments: some click, some clash, and it doesn't matter who's asking", () => {
  assert.equal(affinity("drunk", "gossip"), affinity("gossip", "drunk"));
  assert.ok(affinity("drunk", "gossip") > affinity("banker", "raider") * 5);
  assert.ok(affinity("seer", "seer") > 0 && affinity("seer", "seer") < 1);
});
