import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, pickRiddle } from "./riddles.js";

test("riddle answers: a little give on wording, none on hedging", () => {
  assert.equal(judge("A shadow", ["shadow"]), true);
  assert.equal(judge("it's your shadow!", ["shadow"]), true);
  assert.equal(judge("Shadows", ["shadow"]), true);
  assert.equal(judge("the Copper Kettle", ["copper kettle", "kettle"]), true);
  assert.equal(judge("blue gate", ["blue gate"]), true);
  assert.equal(judge("gate blue", ["blue gate"]), false);
  assert.equal(judge("shadow or fire", ["shadow"]), false);
  assert.equal(judge("shadow, fire, egg", ["shadow"]), false);
  assert.equal(judge("fire", ["shadow"]), false);
  assert.equal(judge("", ["shadow"]), false);
  assert.equal(judge("I think it might be a long dark shadow", ["shadow"]), true);
  assert.equal(judge("egg fire shadow river comb needle sponge towel", ["shadow"]), false);
  assert.equal(judge("glass", ["glass"]), true);
});

test("riddles: unsolved first, then any", () => {
  const all = [{ key: "a", text: "", answers: ["x"], realm: false }, { key: "b", text: "", answers: ["y"], realm: true }];
  assert.equal(pickRiddle(all, new Set(["a"]))!.key, "b");
  assert.ok(pickRiddle(all, new Set(["a", "b"])));
  assert.equal(pickRiddle([], new Set()), null);
});
