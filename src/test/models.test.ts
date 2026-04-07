import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSyntheticModelDescriptor,
  filterModelCatalog,
  formatReasoningEffortLabel,
  getReasoningEffortsForModel,
  isAutomaticModelSelection,
  normalizeModelId,
  normalizeReasoningEffort,
  parseModelAvailabilityConfig,
  parseModelCatalogResponse,
  parseModelListResponse,
  resolveDefaultModel,
  validateConfiguredModel,
  validateModelReasoning,
} from "../models";
import type { HttpResponse, ModelDescriptor } from "../types";

test("normalizeReasoningEffort falls back to low for unknown values", () => {
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort("unknown"), "low");
});

test("normalizeModelId trims values and keeps empty values for auto mode", () => {
  assert.equal(normalizeModelId("  gpt-5.4-mini  "), "gpt-5.4-mini");
  assert.equal(normalizeModelId(""), "");
  assert.equal(isAutomaticModelSelection(""), true);
  assert.equal(isAutomaticModelSelection("gpt-5.3-codex"), false);
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

test("resolveDefaultModel prefers backend defaults, then availability config, and synthetic models infer capabilities", () => {
  const backendDefault = resolveDefaultModel([
    {
      id: "gpt-5.2-codex",
      label: "GPT-5.2 Codex",
      isDefault: false,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      reasoningEffortSource: "backend",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      isDefault: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortSource: "backend",
    },
  ]);
  assert.equal(backendDefault.id, "gpt-5.3-codex");

  const configDefault = resolveDefaultModel(
    [
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
        reasoningEffortSource: "backend",
      },
      {
        id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortSource: "backend",
      },
    ],
    {
      availableModels: ["gpt-5.4", "gpt-5.3-codex"],
      useHiddenModels: true,
      defaultModel: "gpt-5.4",
    },
  );
  assert.equal(configDefault.id, "gpt-5.4");

  assert.deepEqual(createSyntheticModelDescriptor("gpt-5.4-mini"), {
    id: "gpt-5.4-mini",
    label: "gpt-5.4-mini",
    supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
    reasoningEffortSource: "inferred",
    source: "synthetic",
  });
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

  assert.deepEqual(parseModelListResponse(response), [
    {
      id: "gpt-5.2-codex",
      label: "gpt-5.2-codex",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      reasoningEffortSource: "inferred",
      source: "backend_fallback",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortSource: "inferred",
      source: "backend_fallback",
    },
  ]);
});

test("parseModelCatalogResponse parses official catalog records with richer metadata", () => {
  const response: HttpResponse = {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    bodyText: JSON.stringify({
      data: [
        {
          model: "gpt-5.3-codex",
          displayName: "GPT-5.3 Codex",
          isDefault: true,
          hidden: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "xhigh", description: "Deep" },
          ],
        },
      ],
    }),
  };

  assert.deepEqual(parseModelCatalogResponse(response, "official"), [
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      defaultReasoningEffort: "medium",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: ["low", "medium", "xhigh"],
      reasoningEffortSource: "backend",
      source: "official",
    },
  ]);
});

test("parseModelListResponse handles deeper wrapper objects and slug-based ids", () => {
  const response: HttpResponse = {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    bodyText: JSON.stringify({
      payload: {
        page: {
          groups: [
            {
              entry: {
                slug: "gpt-5.4",
                display_name: "GPT-5.4",
                reasoning: {
                  supportedReasoningEfforts: [
                    { reasoningEffort: "minimal" },
                    { reasoningEffort: "high" },
                  ],
                  defaultReasoningEffort: "high",
                },
              },
            },
          ],
        },
      },
    }),
  };

  assert.deepEqual(parseModelListResponse(response), [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: ["minimal", "high"],
      reasoningEffortSource: "backend",
      source: "backend_fallback",
    },
  ]);
});

test("parseModelAvailabilityConfig and filterModelCatalog apply official visibility rules", () => {
  const availabilityConfig = parseModelAvailabilityConfig({
    dynamic_configs: {
      "codex-app-vscode-model-availability": {
        value: {
          available_models: ["gpt-5.4", "gpt-5.3-codex"],
          use_hidden_models: true,
          default_model: "gpt-5.4",
        },
      },
    },
  });

  assert.deepEqual(availabilityConfig, {
    availableModels: ["gpt-5.4", "gpt-5.3-codex"],
    useHiddenModels: true,
    defaultModel: "gpt-5.4",
  });

  const models: ModelDescriptor[] = [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      hidden: true,
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortSource: "backend",
      source: "official",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortSource: "backend",
      source: "official",
    },
    {
      id: "gpt-4.1",
      label: "GPT-4.1",
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortSource: "backend",
      source: "official",
    },
  ];

  assert.deepEqual(
    filterModelCatalog(models, availabilityConfig).map((model) => model.id),
    ["gpt-5.4", "gpt-5.3-codex"],
  );
  assert.deepEqual(
    filterModelCatalog(models).map((model) => model.id),
    ["gpt-5.3-codex", "gpt-4.1"],
  );
});

test("validateConfiguredModel rejects unavailable models and invalid backend reasoning", () => {
  const models: ModelDescriptor[] = [
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      defaultReasoningEffort: "minimal",
      isDefault: false,
      supportedReasoningEfforts: ["minimal", "low"],
      reasoningEffortSource: "backend",
      source: "backend_fallback",
    },
  ];

  assert.throws(() => {
    validateConfiguredModel(models, "gpt-5.4", "low");
  }, /not available/i);

  assert.throws(() => {
    validateConfiguredModel(models, "gpt-5.4-mini", "high");
  }, /recommended: minimal/i);

  assert.equal(
    validateConfiguredModel(models, "gpt-5.4-mini", "low").id,
    "gpt-5.4-mini",
  );

  assert.equal(
    validateModelReasoning(createSyntheticModelDescriptor("gpt-5.4-mini"), "high").id,
    "gpt-5.4-mini",
  );
});

test("parseModelListResponse rejects unusable payloads", () => {
  const response: HttpResponse = {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    bodyText: JSON.stringify({
      payload: {
        models: [
          {
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      },
    }),
  };

  assert.throws(
    () => parseModelListResponse(response),
    /model list response did not include any usable models/i,
  );
});

test("parseModelCatalogResponse reports unusable official payloads", () => {
  const response: HttpResponse = {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
    bodyText: JSON.stringify({
      meta: {
        id: "request-123",
      },
      payload: {
        status: "ok",
      },
    }),
  };

  assert.throws(
    () => parseModelCatalogResponse(response, "official"),
    /official model catalog response did not include any usable models/i,
  );
});

test("formatReasoningEffortLabel renders readable text", () => {
  assert.equal(formatReasoningEffortLabel("minimal"), "Minimal");
  assert.equal(formatReasoningEffortLabel("xhigh"), "X-High");
});
