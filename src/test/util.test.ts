import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrompt } from "../prompts";
import { normalizeCompletionText, parseSseEvents, trimSuggestion } from "../util";

test("trimSuggestion removes repeated prefix overlap and suffix overlap", () => {
  const trimmed = trimSuggestion("console.", "console.log(value);", "value);");
  assert.equal(trimmed, "log(");
});

test("normalizeCompletionText strips surrounding markdown fences", () => {
  const result = normalizeCompletionText("```ts\nhello()\n```");
  assert.equal(result, "hello()");
});

test("parseSseEvents splits event stream blocks", () => {
  const events = parseSseEvents([
    'event: response.output_text.delta',
    'data: {"delta":"foo"}',
    "",
    'event: response.completed',
    'data: {"response":{"error":null}}',
    "",
  ].join("\n"));

  assert.equal(events.length, 2);
  assert.equal(events[0]?.event, "response.output_text.delta");
  assert.match(events[0]?.dataText ?? "", /"delta":"foo"/);
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
