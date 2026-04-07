import { parseJsonResponse } from "./http";
import type {
  HttpResponse,
  ModelDescriptor,
  ReasoningEffort,
} from "./types";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_VALUES,
} from "./types";

const COMMON_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const GPT5_REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const GPT51_REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const CODEX_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function normalizeReasoningEffort(value: string | undefined): ReasoningEffort {
  const normalized = value?.trim().toLowerCase();
  return isReasoningEffort(normalized) ? normalized : DEFAULT_REASONING_EFFORT;
}

export function normalizeModelId(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DEFAULT_MODEL;
}

export function getReasoningEffortsForModel(
  model: ModelDescriptor | undefined,
  modelId = model?.id,
): ReasoningEffort[] {
  const efforts = normalizeReasoningEffortList(model?.supportedReasoningEfforts);
  if (efforts?.length) {
    return efforts;
  }
  return inferReasoningEffortsForModel(modelId);
}

export function validateConfiguredModel(
  models: ModelDescriptor[],
  modelId: string,
  reasoningEffort: ReasoningEffort,
): ModelDescriptor {
  const model = findModelDescriptor(models, modelId);
  if (!model) {
    throw new Error(`Configured model "${modelId}" is not available for this account.`);
  }

  const supportedEfforts = normalizeReasoningEffortList(model.supportedReasoningEfforts);
  if (
    model.reasoningEffortSource === "backend" &&
    supportedEfforts?.length &&
    !supportedEfforts.includes(reasoningEffort)
  ) {
    throw new Error(
      `Reasoning effort "${reasoningEffort}" is not supported by "${modelId}". Choose one of: ${supportedEfforts.join(", ")}.`,
    );
  }

  return model;
}

export function findModelDescriptor(
  models: ModelDescriptor[],
  modelId: string,
): ModelDescriptor | undefined {
  return models.find((candidate) => candidate.id === modelId);
}

export function parseModelListResponse(response: HttpResponse): ModelDescriptor[] {
  const payload = parseJsonResponse<unknown>(response);
  return parseModelListPayload(payload);
}

export function formatReasoningEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "X-High";
  }
}

function parseModelListPayload(payload: unknown): ModelDescriptor[] {
  const entries = extractModelEntries(payload);
  const models = new Map<string, ModelDescriptor>();

  for (const entry of entries) {
    const model = normalizeModel(entry);
    if (model) {
      models.set(model.id, model);
    }
  }

  if (models.size === 0) {
    throw new Error("model list response did not include any usable models");
  }

  return [...models.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function extractModelEntries(payload: unknown): unknown[] {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (Array.isArray(current.value) && current.value.some(looksLikeModelEntry)) {
      return current.value;
    }

    if (!current.value || typeof current.value !== "object" || current.depth >= 3) {
      continue;
    }

    const record = current.value as Record<string, unknown>;
    for (const key of ["data", "models", "items", "results"]) {
      if (key in record) {
        queue.push({ value: record[key], depth: current.depth + 1 });
      }
    }
  }

  return [];
}

function normalizeModel(value: unknown): ModelDescriptor | undefined {
  if (typeof value === "string") {
    return {
      id: value,
      label: value,
      supportedReasoningEfforts: inferReasoningEffortsForModel(value),
      reasoningEffortSource: "inferred",
    };
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = firstString(record, ["id", "model", "name"]);
  if (!id) {
    return undefined;
  }

  const label =
    firstString(record, ["label", "display_name", "displayName", "title", "name"]) ?? id;
  const supportedReasoningEfforts = extractReasoningEffortList(record);
  const reasoningEffortSource = supportedReasoningEfforts ? "backend" : "inferred";

  return {
    id,
    label,
    supportedReasoningEfforts:
      supportedReasoningEfforts ?? inferReasoningEffortsForModel(id),
    reasoningEffortSource,
  };
}

function extractReasoningEffortList(
  record: Record<string, unknown>,
): ReasoningEffort[] | undefined {
  const direct = normalizeReasoningEffortList(
    firstArray(record, [
      "supported_reasoning_efforts",
      "reasoning_efforts",
      "supportedReasoningEfforts",
      "reasoningEfforts",
    ]),
  );
  if (direct?.length) {
    return direct;
  }

  for (const key of ["reasoning", "capabilities", "metadata"]) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }

    const nestedRecord = nested as Record<string, unknown>;
    const efforts = normalizeReasoningEffortList(
      firstArray(nestedRecord, [
        "supported_efforts",
        "supported_reasoning_efforts",
        "efforts",
        "effort_options",
        "reasoning_efforts",
        "supportedReasoningEfforts",
      ]),
    );
    if (efforts?.length) {
      return efforts;
    }
  }

  return undefined;
}

function firstArray(
  record: Record<string, unknown>,
  keys: string[],
): unknown[] | undefined {
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  return undefined;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key] as string;
    }
  }
  return undefined;
}

function looksLikeModelEntry(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return ["id", "model", "name"].some(
    (key) => typeof record[key] === "string" && Boolean(record[key]),
  );
}

function normalizeReasoningEffortList(
  values: readonly unknown[] | undefined,
): ReasoningEffort[] | undefined {
  const normalized = values
    ?.map((value) => (typeof value === "string" ? value.trim().toLowerCase() : undefined))
    .filter((value): value is ReasoningEffort => isReasoningEffort(value));

  if (!normalized?.length) {
    return undefined;
  }

  return [...new Set(normalized)];
}

function inferReasoningEffortsForModel(modelId: string | undefined): ReasoningEffort[] {
  const normalized = modelId?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return [...COMMON_REASONING_EFFORTS];
  }
  if (normalized.includes("codex")) {
    return [...CODEX_REASONING_EFFORTS];
  }
  if (normalized.startsWith("gpt-5.1")) {
    return [...GPT51_REASONING_EFFORTS];
  }
  if (normalized.startsWith("gpt-5")) {
    return [...GPT5_REASONING_EFFORTS];
  }
  return [...COMMON_REASONING_EFFORTS];
}

function isReasoningEffort(value: string | undefined): value is ReasoningEffort {
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(value ?? "");
}
