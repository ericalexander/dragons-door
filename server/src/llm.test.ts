import { test } from "node:test";
import assert from "node:assert/strict";
import { wholeSentences } from "./llm.js";

test("a cut-off reply keeps only its complete sentences", () => {
  assert.equal(wholeSentences("The lamp should burn. It always did. And if the hill"), "The lamp should burn. It always did.");
  assert.equal(wholeSentences("“Light it,” she said. Then we'll"), "“Light it,” she said.");
  assert.equal(wholeSentences("Nothing whole here"), "");
  assert.equal(wholeSentences("Is it? It is!"), "Is it? It is!");
});

test("short pieces ask each model not to think, in the way that model accepts", async () => {
  const { noThinking } = await import("./llm.js");
  assert.deepEqual(noThinking("claude-sonnet-5-5"), { thinking: { type: "between_tools" } });
  assert.deepEqual(noThinking("claude-sonnet-5"), { thinking: { type: "disabled" } });
  assert.deepEqual(noThinking("claude-haiku-5-5"), { thinking: { type: "disabled" } });
  assert.deepEqual(noThinking("claude-opus-5-5"), { output_config: { effort: "low" } });
  assert.deepEqual(noThinking("claude-haiku-4-5"), {});
});
