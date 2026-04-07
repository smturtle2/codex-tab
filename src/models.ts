import { parseJsonResponse } from "./http";
import type {
  HttpResponse,
  ModelAvailabilityConfig,
  ModelCatalogSource,
  ModelDescriptor,
  ReasoningEffort,
} from "./types";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_VALUES,
} from "./types";

const COMMON_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const GPT5_REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const GPT51_REASONING_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high"];
const CODEX_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

interface ModelCandidate {
  path: string;
  value: unknown;
}

interface ModelIdentifier {
  id: string;
  source: "id" | "model" | "slug" | "name";
}

export function normalizeReasoningEffort(value: string | undefined): ReasoningEffort {
  const normalized = value?.trim().toLowerCase();
  return isReasoningEffort(normalized) ? normalized : DEFAULT_REASONING_EFFORT;
}

export function normalizeModelId(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ?? "";
}

export function isAutomaticModelSelection(value: string | undefined): boolean {
  return normalizeModelId(value).length === 0;
}

export function createSyntheticModelDescriptor(modelId: string): ModelDescriptor {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    throw new Error("Cannot create a model descriptor from an empty model id.");
  }

  return {
    id: normalized,
    label: normalized,
    supportedReasoningEfforts: inferReasoningEffortsForModel(normalized),
    reasoningEffortSource: "inferred",
    source: "synthetic",
  };
}

export function resolveDefaultModel(
  models: ModelDescriptor[],
  availabilityConfig?: ModelAvailabilityConfig,
): ModelDescriptor {
  const configuredDefaultModel = normalizeModelId(availabilityConfig?.defaultModel);
  const defaultModel =
    models.find((model) => model.isDefault)
    ?? (configuredDefaultModel
      ? findModelDescriptor(models, configuredDefaultModel)
      : undefined)
    ?? models[0];
  if (!defaultModel) {
    throw new Error("No live models were available to resolve the account default model.");
  }
  return defaultModel;
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

  return validateModelReasoning(model, reasoningEffort);
}

export function validateModelReasoning(
  model: ModelDescriptor,
  reasoningEffort: ReasoningEffort,
): ModelDescriptor {
  const supportedEfforts = normalizeReasoningEffortList(model.supportedReasoningEfforts);
  if (
    model.reasoningEffortSource === "backend" &&
    supportedEfforts?.length &&
    !supportedEfforts.includes(reasoningEffort)
  ) {
    const recommended = getDefaultReasoningEffort(model, supportedEfforts);
    throw new Error(
      `Reasoning effort "${reasoningEffort}" is not supported by "${model.id}". Choose one of: ${supportedEfforts.join(", ")}.${recommended ? ` Recommended: ${recommended}.` : ""}`,
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
  return parseModelListPayload(payload, response.headers["content-type"], "backend_fallback");
}

export function parseModelCatalogResponse(
  response: HttpResponse,
  source: ModelCatalogSource,
): ModelDescriptor[] {
  const payload = parseJsonResponse<unknown>(response);
  return parseModelListPayload(payload, response.headers["content-type"], source);
}

export function parseModelAvailabilityConfigResponse(
  response: HttpResponse,
): ModelAvailabilityConfig | undefined {
  const payload = parseJsonResponse<unknown>(response);
  return parseModelAvailabilityConfig(payload);
}

export function parseModelAvailabilityConfig(
  payload: unknown,
): ModelAvailabilityConfig | undefined {
  const candidate = findAvailabilityConfigCandidate(payload);
  if (!candidate) {
    return undefined;
  }

  const availableModels = normalizeAvailableModels(
    firstArray(candidate, ["available_models", "availableModels"]),
  );
  const useHiddenModels =
    firstBoolean(candidate, ["use_hidden_models", "useHiddenModels"]) ?? false;
  const defaultModel = normalizeModelId(
    firstString(candidate, ["default_model", "defaultModel"]),
  );

  return {
    availableModels,
    useHiddenModels,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

export function filterModelCatalog(
  models: ModelDescriptor[],
  availabilityConfig?: ModelAvailabilityConfig,
): ModelDescriptor[] {
  if (!availabilityConfig) {
    return models.filter((model) => model.hidden !== true);
  }

  if (!availabilityConfig.useHiddenModels) {
    return models.filter((model) => model.hidden !== true);
  }

  const allowedModelIds = new Set(
    availabilityConfig.availableModels
      .map((modelId) => normalizeModelId(modelId))
      .filter((modelId) => modelId.length > 0),
  );
  if (allowedModelIds.size === 0) {
    return [...models];
  }

  return models.filter((model) => allowedModelIds.has(model.id));
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

function parseModelListPayload(
  payload: unknown,
  contentType: string | undefined,
  source: ModelCatalogSource,
): ModelDescriptor[] {
  const candidates = collectModelCandidates(payload);
  const models = new Map<string, ModelDescriptor>();

  for (const candidate of candidates) {
    const model = normalizeModel(candidate.value, source);
    if (model) {
      models.set(model.id, model);
    }
  }

  if (models.size === 0) {
    throw new Error(buildModelListError(payload, contentType, candidates, source));
  }

  return [...models.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function collectModelCandidates(payload: unknown): ModelCandidate[] {
  const queue: Array<{ value: unknown; path: string }> = [{ value: payload, path: "$" }];
  const visited = new WeakSet<object>();
  const seenPaths = new Set<string>();
  const candidates: ModelCandidate[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (Array.isArray(current.value)) {
      for (const [index, item] of current.value.entries()) {
        const path = `${current.path}[${index}]`;
        if (looksLikeModelEntry(item, path) && !seenPaths.has(path)) {
          seenPaths.add(path);
          candidates.push({ path, value: item });
        }
        if (item && (typeof item === "object" || Array.isArray(item))) {
          queue.push({ value: item, path });
        }
      }
      continue;
    }

    if (!current.value || typeof current.value !== "object") {
      continue;
    }

    if (visited.has(current.value)) {
      continue;
    }
    visited.add(current.value);

    if (looksLikeModelEntry(current.value, current.path) && !seenPaths.has(current.path)) {
      seenPaths.add(current.path);
      candidates.push({ path: current.path, value: current.value });
    }

    const record = current.value as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (!value || (typeof value !== "object" && !Array.isArray(value))) {
        continue;
      }
      queue.push({ value, path: appendPath(current.path, key) });
    }

  }

  return candidates;
}

function normalizeModel(
  value: unknown,
  source: ModelCatalogSource,
): ModelDescriptor | undefined {
  if (typeof value === "string") {
    if (!looksLikeModelString(value)) {
      return undefined;
    }
    return {
      ...createSyntheticModelDescriptor(value),
      source,
    };
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const identifier = extractModelIdentifier(record);
  if (!identifier) {
    return undefined;
  }
  const id = identifier.id;

  const label =
    firstString(record, ["label", "display_name", "displayName", "title", "name"]) ?? id;
  const supportedReasoningEfforts = extractReasoningEffortList(record);
  const defaultReasoningEffort = extractDefaultReasoningEffort(record);
  const hidden = firstBoolean(record, ["hidden", "isHidden", "is_hidden"]);
  const isDefault = firstBoolean(record, ["isDefault", "is_default", "default"]);
  const reasoningEffortSource = supportedReasoningEfforts ? "backend" : "inferred";

  return {
    id,
    label,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(hidden !== undefined ? { hidden } : {}),
    ...(isDefault !== undefined ? { isDefault } : {}),
    supportedReasoningEfforts:
      supportedReasoningEfforts ?? inferReasoningEffortsForModel(id),
    reasoningEffortSource,
    source,
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
        "supportedReasoningOptions",
      ]),
    );
    if (efforts?.length) {
      return efforts;
    }
  }

  return undefined;
}

function extractDefaultReasoningEffort(
  record: Record<string, unknown>,
): ReasoningEffort | undefined {
  const direct = normalizeReasoningEffortValue(
    firstUnknown(record, [
      "defaultReasoningEffort",
      "default_reasoning_effort",
      "reasoningEffort",
      "reasoning_effort",
    ]),
  );
  if (direct) {
    return direct;
  }

  for (const key of ["reasoning", "capabilities", "metadata"]) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }

    const nestedRecord = nested as Record<string, unknown>;
    const effort = normalizeReasoningEffortValue(
      firstUnknown(nestedRecord, [
        "default_effort",
        "default_reasoning_effort",
        "defaultReasoningEffort",
        "reasoningEffort",
      ]),
    );
    if (effort) {
      return effort;
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

function firstBoolean(
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === "boolean") {
      return record[key] as boolean;
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

function firstUnknown(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function extractModelIdentifier(
  record: Record<string, unknown>,
): ModelIdentifier | undefined {
  const model = firstString(record, ["model"]);
  if (model) {
    return { id: model, source: "model" };
  }

  const slug = firstString(record, ["slug"]);
  if (slug) {
    return { id: slug, source: "slug" };
  }

  const id = firstString(record, ["id"]);
  if (id) {
    return { id, source: "id" };
  }

  const name = firstString(record, ["name"]);
  if (name && hasModelSignals(record)) {
    return { id: name, source: "name" };
  }

  return undefined;
}

function hasModelSignals(record: Record<string, unknown>): boolean {
  if (
    firstString(record, ["displayName", "display_name", "label", "description", "title"]) ||
    firstBoolean(record, ["isDefault", "is_default", "hidden", "isHidden", "is_hidden"]) !== undefined ||
    firstArray(record, ["supportedReasoningEfforts", "supported_reasoning_efforts", "inputModalities"])
  ) {
    return true;
  }

  return ["reasoning", "capabilities", "metadata"].some((key) => {
    const nested = record[key];
    return Boolean(nested && typeof nested === "object" && !Array.isArray(nested));
  });
}

function looksLikeModelEntry(value: unknown, path: string): boolean {
  if (typeof value === "string") {
    return looksLikeModelString(value) && pathLikelyContainsModelHint(path);
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const identifier = extractModelIdentifier(record);
  if (!identifier) {
    return false;
  }
  if (!looksLikeModelString(identifier.id)) {
    return false;
  }
  if (identifier.source === "model" || identifier.source === "slug") {
    return true;
  }
  return hasModelSignals(record) || pathLikelyContainsModelHint(path);
}

function looksLikeModelString(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (isReasoningEffort(normalized.toLowerCase())) {
    return false;
  }
  return /(?:\d|[-._])/.test(normalized) || /(gpt|codex|o\d|omni)/i.test(normalized);
}

function pathLikelyContainsModelHint(path: string): boolean {
  return path === "$" || /\.(data|models?|items?|results?|entries?|groups?)\b/i.test(path);
}

function normalizeReasoningEffortList(
  values: readonly unknown[] | undefined,
): ReasoningEffort[] | undefined {
  const normalized = values
    ?.map((value) => normalizeReasoningEffortValue(value))
    .filter((value): value is ReasoningEffort => value !== undefined);

  if (!normalized?.length) {
    return undefined;
  }

  return [...new Set(normalized)];
}

function normalizeReasoningEffortValue(value: unknown): ReasoningEffort | undefined {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return isReasoningEffort(normalized) ? normalized : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const normalized = firstString(record, [
    "reasoningEffort",
    "reasoning_effort",
    "effort",
    "value",
    "id",
    "name",
  ])
    ?.trim()
    .toLowerCase();
  return isReasoningEffort(normalized) ? normalized : undefined;
}

function getDefaultReasoningEffort(
  model: ModelDescriptor,
  supportedEfforts: ReasoningEffort[],
): ReasoningEffort | undefined {
  if (model.defaultReasoningEffort && supportedEfforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return supportedEfforts[0];
}

function appendPath(basePath: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${basePath}.${key}`
    : `${basePath}[${JSON.stringify(key)}]`;
}

function findAvailabilityConfigCandidate(
  payload: unknown,
): Record<string, unknown> | undefined {
  const queue: unknown[] = [payload];
  const visited = new WeakSet<object>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    if (looksLikeAvailabilityConfig(record)) {
      return record;
    }

    for (const value of Object.values(record)) {
      if (value && (typeof value === "object" || Array.isArray(value))) {
        queue.push(value);
      }
    }
  }

  return undefined;
}

function looksLikeAvailabilityConfig(record: Record<string, unknown>): boolean {
  return (
    firstBoolean(record, ["use_hidden_models", "useHiddenModels"]) !== undefined ||
    firstArray(record, ["available_models", "availableModels"]) !== undefined ||
    firstString(record, ["default_model", "defaultModel"]) !== undefined
  );
}

function normalizeAvailableModels(values: unknown[] | undefined): string[] {
  if (!values?.length) {
    return [];
  }

  return [...new Set(
    values
      .map((value) => {
        if (typeof value === "string") {
          return normalizeModelId(value);
        }
        if (!value || typeof value !== "object") {
          return "";
        }
        const record = value as Record<string, unknown>;
        return normalizeModelId(
          firstString(record, ["model", "id", "slug", "name"]) ?? "",
        );
      })
      .filter((modelId) => modelId.length > 0),
  )];
}

function buildModelListError(
  payload: unknown,
  contentType: string | undefined,
  candidates: ModelCandidate[],
  source: ModelCatalogSource,
): string {
  const topLevelKeys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload as Record<string, unknown>).slice(0, 8)
      : [];
  const candidatePaths =
    candidates.length > 0
      ? candidates.slice(0, 5).map((candidate) => summarizeCandidate(candidate)).join("; ")
      : "none";
  const bodyPreview = createBodyPreview(payload);

  return [
    source === "official"
      ? "official model catalog response did not include any usable models"
      : "model list response did not include any usable models",
    `(content-type: ${contentType ?? "unknown"}; top-level keys: ${topLevelKeys.join(", ") || "none"}; candidate paths: ${candidatePaths}; body preview: ${bodyPreview})`,
  ].join(" ");
}

function summarizeCandidate(candidate: ModelCandidate): string {
  if (typeof candidate.value === "string") {
    return `${candidate.path}="${candidate.value}"`;
  }
  if (!candidate.value || typeof candidate.value !== "object" || Array.isArray(candidate.value)) {
    return candidate.path;
  }
  return `${candidate.path}{${Object.keys(candidate.value as Record<string, unknown>)
    .slice(0, 6)
    .join(",")}}`;
}

function createBodyPreview(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    if (!serialized) {
      return "empty";
    }
    return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
  } catch {
    return String(payload);
  }
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
