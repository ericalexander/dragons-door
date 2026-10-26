import { test } from "node:test";
import assert from "node:assert/strict";
import { wholeSentences } from "./llm.js";

test("a cut-off reply keeps only its complete sentences", () => {
  assert.equal(wholeSentences("The lamp should burn. It always did. And if the hill"), "The lamp should burn. It always did.");
  assert.equal(wholeSentences("“Light it,” she said. Then we'll"), "“Light it,” she said.");
  assert.equal(wholeSentences("Nothing whole here"), "");
  assert.equal(wholeSentences("Is it? It is!"), "Is it? It is!");
});
