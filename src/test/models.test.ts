import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatReasoningEffortLabel,
  getReasoningEffortsForModel,
  normalizeModelId,
  normalizeReasoningEffort,
  parseModelListResponse,
  validateConfiguredModel,
} from "../models";
import type { HttpResponse, ModelDescriptor } from "../types";

test("normalizeReasoningEffort falls back to low for unknown values", () => {
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort("unknown"), "low");
});

test("normalizeModelId trims values and falls back to the default model", () => {
  assert.equal(normalizeModelId("  gpt-5.4-mini  "), "gpt-5.4-mini");
  assert.equal(normalizeModelId(""), "gpt-5.4-mini");
});

test("getReasoningEffortsForModel infers codex and GPT-5 families", () => {
  assert.deepEqual(getReasoningEffortsForModel(undefined, "gpt-5.4-mini"), [
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(getReasoningEffortsForModel(undefined, "gpt-5.2-codex"), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(getReasoningEffortsForModel(undefined, "gpt-5.1"), [
    "none",
    "low",
    "medium",
    "high",
  ]);
});

test("parseModelListResponse handles nested model arrays and infers reasoning when absent", () => {
  const response: HttpResponse = {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    bodyText: JSON.stringify({
      data: {
        items: [
          {
            id: "gpt-5.4-mini",
            display_name: "GPT-5.4 Mini",
          },
          "gpt-5.2-codex",
        ],
      },
    }),
  };

  const models = parseModelListResponse(response);

  assert.deepEqual(models, [
    {
      id: "gpt-5.2-codex",
      label: "gpt-5.2-codex",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      reasoningEffortSource: "inferred",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortSource: "inferred",
    },
  ]);
});

test("validateConfiguredModel rejects unavailable models and invalid backend reasoning", () => {
  const models: ModelDescriptor[] = [
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      supportedReasoningEfforts: ["minimal", "low"],
      reasoningEffortSource: "backend",
    },
  ];

  assert.throws(() => {
    validateConfiguredModel(models, "gpt-5.4", "low");
  }, /not available/i);

  assert.throws(() => {
    validateConfiguredModel(models, "gpt-5.4-mini", "high");
  }, /not supported/i);

  assert.equal(
    validateConfiguredModel(models, "gpt-5.4-mini", "low").id,
    "gpt-5.4-mini",
  );
});

test("formatReasoningEffortLabel renders readable text", () => {
  assert.equal(formatReasoningEffortLabel("minimal"), "Minimal");
  assert.equal(formatReasoningEffortLabel("xhigh"), "X-High");
});
