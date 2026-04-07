import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrompt } from "../prompts";
import { parseStructuredCompletion, trimSuggestion } from "../util";

test("trimSuggestion removes repeated prefix overlap and suffix overlap", () => {
  const trimmed = trimSuggestion("console.", "console.log(value);", "value);");
  assert.equal(trimmed, "log(");
});

test("parseStructuredCompletion accepts fenced JSON", () => {
  const result = parseStructuredCompletion('```json\n{"completion":"hello"}\n```');
  assert.equal(result.completion, "hello");
});

test("buildPrompt includes language, file, prefix, and suffix", () => {
  const prompt = buildPrompt({
    languageId: "python",
    relativePath: "app/main.py",
    prefix: "def greet(name):\n    return ",
    suffix: "\n",
    linePrefix: "    return ",
    lineSuffix: "",
    cursorLine: 2,
    cursorCharacter: 12,
  });

  assert.match(prompt.instructions, /inline code completion engine/);
  assert.match(prompt.input, /Language: python/);
  assert.match(prompt.input, /File: app\/main.py/);
  assert.match(prompt.input, /<<PREFIX>>/);
  assert.match(prompt.input, /<<SUFFIX>>/);
});
