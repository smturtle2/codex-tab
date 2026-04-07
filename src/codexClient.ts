import type {
  AuthStore,
  AuthSnapshot,
  CompletionRequest,
  CompletionResult,
  HttpClient,
  HttpResponse,
  LoggerLike,
  ModelAvailabilityResponse,
} from "./types";
import {
  DEFAULT_TIMEOUT_MS,
  REQUIRED_MODEL,
  REQUIRED_REASONING_EFFORT,
  RESPONSES_BASE_URL,
} from "./types";
import { assertOk, parseJsonResponse } from "./http";
import { buildPrompt } from "./prompts";
import { parseStructuredCompletion } from "./util";

interface ModelRecord {
  id?: string;
  model?: string;
  slug?: string;
}

interface CompletionPayload {
  output_text?: string;
  output?: Array<Record<string, unknown>>;
}

export class CodexResponsesClient {
  private readonly authStore: AuthStore;
  private readonly httpClient: HttpClient;
  private readonly logger: LoggerLike;
  private timeoutMs: number;
  private modelValidation: Promise<ModelAvailabilityResponse> | undefined;

  public constructor(
    authStore: AuthStore,
    httpClient: HttpClient,
    logger: LoggerLike,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.authStore = authStore;
    this.httpClient = httpClient;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
  }

  public invalidate(): void {
    this.authStore.invalidate();
    this.modelValidation = undefined;
  }

  public updateConfig(
    authFilePath: string,
    timeoutMs: number,
  ): void {
    if (typeof this.authStore.updateAuthFilePath === "function") {
      this.authStore.updateAuthFilePath(authFilePath);
    } else {
      this.authStore.invalidate();
    }
    this.timeoutMs = timeoutMs;
    this.modelValidation = undefined;
  }

  public async ensureModelAvailable(signal?: AbortSignal): Promise<void> {
    this.modelValidation ??= this.fetchModelAvailability(signal).catch((error: unknown) => {
      this.modelValidation = undefined;
      throw error;
    });
    const availability = await this.modelValidation;
    if (!availability.available) {
      throw new Error(
        `required model ${REQUIRED_MODEL} is unavailable; saw: ${availability.modelIds.join(", ")}`,
      );
    }
  }

  public async complete(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    await this.ensureModelAvailable(signal);
    const prompt = buildPrompt(request);

    const response = await this.withAuthRetry(
      async (snapshot) =>
        await this.httpClient.request({
          method: "POST",
          url: `${RESPONSES_BASE_URL}/responses`,
          headers: buildAuthHeaders(snapshot),
          jsonBody: {
            model: REQUIRED_MODEL,
            instructions: prompt.instructions,
            input: [{ role: "user", content: prompt.input }],
            tools: [],
            tool_choice: "none",
            parallel_tool_calls: false,
            reasoning: {
              effort: REQUIRED_REASONING_EFFORT,
              summary: "none",
            },
            store: false,
            stream: false,
            include: [],
            max_output_tokens: 160,
            text: {
              verbosity: "low",
              format: {
                type: "json_schema",
                name: "completion_payload",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    completion: {
                      type: "string",
                    },
                  },
                  required: ["completion"],
                },
              },
            },
          },
          timeoutMs: this.timeoutMs,
          signal,
        }),
      signal,
    );

    assertOk(response, "completion request failed");
    const payload = parseJsonResponse<CompletionPayload>(response);
    const outputText = extractOutputText(payload);
    return parseStructuredCompletion(outputText);
  }

  private async fetchModelAvailability(
    signal?: AbortSignal,
  ): Promise<ModelAvailabilityResponse> {
    const response = await this.withAuthRetry(
      async (snapshot) =>
        await this.httpClient.request({
          method: "GET",
          url: `${RESPONSES_BASE_URL}/models?client_version=0.0.1`,
          headers: buildAuthHeaders(snapshot),
          timeoutMs: this.timeoutMs,
          signal,
        }),
      signal,
    );
    assertOk(response, "model discovery failed");
    const payload = parseJsonResponse<Record<string, unknown>>(response);
    const modelIds = parseModelIds(payload);
    this.logger.info(`Model discovery returned: ${modelIds.join(", ")}`);
    return {
      available: modelIds.includes(REQUIRED_MODEL),
      modelIds,
    };
  }

  private async withAuthRetry(
    fn: (snapshot: AuthSnapshot) => Promise<HttpResponse>,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    const current = await this.authStore.ensureValid(signal);
    const first = await fn(current);
    if (first.status !== 401) {
      return first;
    }

    this.logger.warn("Received 401 from Codex backend, forcing token refresh");
    const refreshed = await this.authStore.forceRefresh(signal);
    return await fn(refreshed);
  }
}

function buildAuthHeaders(snapshot: AuthSnapshot): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${snapshot.accessToken}`,
  };

  if (snapshot.accountId) {
    headers["ChatGPT-Account-ID"] = snapshot.accountId;
  }

  return headers;
}

function parseModelIds(payload: Record<string, unknown>): string[] {
  const candidates =
    (Array.isArray(payload.data) ? payload.data : undefined) ??
    (Array.isArray(payload.models) ? payload.models : undefined) ??
    [];

  const modelIds: string[] = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const model = entry as ModelRecord;
    const id =
      typeof model.id === "string"
        ? model.id
        : typeof model.model === "string"
          ? model.model
          : typeof model.slug === "string"
            ? model.slug
            : undefined;
    if (id) {
      modelIds.push(id);
    }
  }
  return [...new Set(modelIds)];
}

function extractOutputText(payload: CompletionPayload): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const chunks: string[] = [];
  if (!Array.isArray(payload.output)) {
    return "";
  }

  for (const item of payload.output) {
    const text = item.text;
    if (typeof text === "string") {
      chunks.push(text);
    }

    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const entry of content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.text === "string") {
        chunks.push(candidate.text);
      }
    }
  }

  return chunks.join("");
}
