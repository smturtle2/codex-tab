import type {
  AuthSnapshot,
  AuthStore,
  CompletionRequest,
  CompletionResult,
  ExtensionSettings,
  HttpClient,
  HttpResponse,
  LoggerLike,
  ModelAvailabilityConfig,
  ModelDescriptor,
} from "./types";
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  DEFAULT_TIMEOUT_MS,
  RESPONSES_BASE_URL,
} from "./types";
import { assertOk } from "./http";
import {
  normalizeModelId,
  parseModelAvailabilityConfigResponse,
  parseModelCatalogResponse,
  parseModelListResponse,
} from "./models";
import { buildPrompt } from "./prompts";
import { normalizeCompletionText, parseSseEvents } from "./util";

interface StreamedResponsePayload {
  type?: string;
  delta?: string;
  error?: unknown;
  item?: {
    type?: string;
  };
  response?: {
    error?: unknown;
  };
}

interface CodexClientConfig {
  reasoningEffort: ExtensionSettings["reasoningEffort"];
  requestTimeoutMs: ExtensionSettings["requestTimeoutMs"];
  clientVersion?: string | undefined;
}

interface JsonRequestAttempt {
  label: string;
  method: "GET" | "POST";
  pathname: string;
  query?: Record<string, string> | undefined;
  jsonBody?: Record<string, unknown> | undefined;
}

export class CodexResponsesClient {
  private readonly authStore: AuthStore;
  private readonly httpClient: HttpClient;
  private readonly logger: LoggerLike;
  private timeoutMs: number;
  private reasoningEffort: ExtensionSettings["reasoningEffort"];
  private readonly clientVersion: string;

  public constructor(
    authStore: AuthStore,
    httpClient: HttpClient,
    logger: LoggerLike,
    settings?: CodexClientConfig,
  ) {
    this.authStore = authStore;
    this.httpClient = httpClient;
    this.logger = logger;
    this.timeoutMs = settings?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.reasoningEffort = settings?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    this.clientVersion = normalizeClientVersion(settings?.clientVersion);
  }

  public invalidate(): void {
    this.authStore.invalidate();
  }

  public updateConfig(
    settings: Pick<ExtensionSettings, "reasoningEffort" | "requestTimeoutMs">,
  ): void {
    this.timeoutMs = settings.requestTimeoutMs;
    this.reasoningEffort = settings.reasoningEffort;
    this.invalidate();
  }

  public async listOfficialModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const attempts: JsonRequestAttempt[] = [
      {
        label: "GET /model/list?includeHidden=true",
        method: "GET",
        pathname: "/model/list",
        query: { includeHidden: "true" },
      },
      {
        label: "GET /model/list?include_hidden=true",
        method: "GET",
        pathname: "/model/list",
        query: { include_hidden: "true" },
      },
      {
        label: "POST /model/list { includeHidden: true }",
        method: "POST",
        pathname: "/model/list",
        jsonBody: { includeHidden: true },
      },
      {
        label: "GET /models/list?includeHidden=true",
        method: "GET",
        pathname: "/models/list",
        query: { includeHidden: "true" },
      },
    ];

    return await this.tryJsonModelAttempts(
      attempts,
      (response) => parseModelCatalogResponse(response, "official"),
      "official model catalog unavailable",
      signal,
    );
  }

  public async listFallbackModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.requestJson(
      {
        label: "GET /models",
        method: "GET",
        pathname: "/models",
      },
      signal,
    );

    assertOk(response, "model list request failed");
    return parseModelListResponse(response);
  }

  public async loadModelAvailabilityConfig(
    signal?: AbortSignal,
  ): Promise<ModelAvailabilityConfig | undefined> {
    const attempts: JsonRequestAttempt[] = [
      {
        label: "GET /config/read?key=codex-app-vscode-model-availability",
        method: "GET",
        pathname: "/config/read",
        query: { key: "codex-app-vscode-model-availability" },
      },
      {
        label: "POST /config/read",
        method: "POST",
        pathname: "/config/read",
        jsonBody: { key: "codex-app-vscode-model-availability" },
      },
      {
        label: "GET /statsig/config?name=codex-app-vscode-model-availability",
        method: "GET",
        pathname: "/statsig/config",
        query: { name: "codex-app-vscode-model-availability" },
      },
    ];

    for (const attempt of attempts) {
      try {
        const response = await this.requestJson(attempt, signal);
        if (response.status < 200 || response.status >= 300) {
          continue;
        }

        const parsed = parseModelAvailabilityConfigResponse(response);
        if (parsed) {
          return parsed;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  public async hasSession(): Promise<boolean> {
    return await this.authStore.hasSession();
  }

  public async signIn(signal?: AbortSignal): Promise<void> {
    await this.authStore.signIn(signal);
  }

  public async signOut(): Promise<void> {
    await this.authStore.signOut();
    this.invalidate();
  }

  public async probeReady(modelId: string, signal?: AbortSignal): Promise<void> {
    await this.requestStreamedText(
      {
        model: requireModelId(modelId),
        instructions: "Reply with exactly OK.",
        input: [{ role: "user", content: "Reply with exactly OK." }],
        tools: [],
        tool_choice: "none",
        parallel_tool_calls: false,
        reasoning: {
          effort: this.reasoningEffort,
          summary: DEFAULT_REASONING_SUMMARY,
        },
        store: false,
        stream: true,
      },
      "setup probe failed",
      signal,
    );
  }

  public async complete(
    request: CompletionRequest,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const prompt = buildPrompt(request);
    const rawText = await this.requestStreamedText(
      {
        model: requireModelId(modelId),
        instructions: prompt.instructions,
        input: [{ role: "user", content: prompt.input }],
        tools: [],
        tool_choice: "none",
        parallel_tool_calls: false,
        reasoning: {
          effort: this.reasoningEffort,
          summary: DEFAULT_REASONING_SUMMARY,
        },
        store: false,
        stream: true,
      },
      "completion request failed",
      signal,
    );

    return {
      completion: normalizeCompletionText(rawText),
      rawText,
    };
  }

  private async requestStreamedText(
    jsonBody: Record<string, unknown>,
    errorPrefix: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.withAuthRetry(
      async (snapshot) =>
        await this.httpClient.request({
          method: "POST",
          url: this.buildCodexUrl("/responses"),
          headers: buildAuthHeaders(snapshot),
          jsonBody,
          timeoutMs: this.timeoutMs,
          signal,
        }),
      signal,
    );

    assertOk(response, errorPrefix);
    return parseStreamedText(response.bodyText);
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

  private async requestJson(
    attempt: JsonRequestAttempt,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    return await this.withAuthRetry(
      async (snapshot) =>
        await this.httpClient.request({
          method: attempt.method,
          url: this.buildCodexUrl(attempt.pathname, attempt.query),
          headers: buildJsonHeaders(snapshot),
          ...(attempt.jsonBody ? { jsonBody: attempt.jsonBody } : {}),
          timeoutMs: this.timeoutMs,
          signal,
        }),
      signal,
    );
  }

  private async tryJsonModelAttempts(
    attempts: JsonRequestAttempt[],
    parse: (response: HttpResponse) => ModelDescriptor[],
    failurePrefix: string,
    signal?: AbortSignal,
  ): Promise<ModelDescriptor[]> {
    const errors: string[] = [];

    for (const attempt of attempts) {
      try {
        const response = await this.requestJson(attempt, signal);
        if (response.status < 200 || response.status >= 300) {
          errors.push(`${attempt.label}: ${summarizeHttpFailure(response)}`);
          continue;
        }

        return parse(response);
      } catch (error) {
        errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(
      `${failurePrefix}: ${errors.join("; ") || "no usable request variant succeeded"}`,
    );
  }

  private buildCodexUrl(
    pathname: string,
    query?: Record<string, string> | undefined,
  ): string {
    const url = new URL(`${RESPONSES_BASE_URL}${pathname}`);
    url.searchParams.set("client_version", this.clientVersion);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

function normalizeClientVersion(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : "0.0.0";
}

function requireModelId(value: string): string {
  const normalized = normalizeModelId(value);
  if (!normalized) {
    throw new Error("A non-empty model id is required for Codex requests.");
  }
  return normalized;
}

function buildAuthHeaders(snapshot: AuthSnapshot): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    Authorization: `Bearer ${snapshot.accessToken}`,
  };

  if (snapshot.accountId) {
    headers["ChatGPT-Account-ID"] = snapshot.accountId;
  }

  return headers;
}

function buildJsonHeaders(snapshot: AuthSnapshot): Record<string, string> {
  return {
    ...buildAuthHeaders(snapshot),
    Accept: "application/json",
  };
}

function summarizeHttpFailure(response: HttpResponse): string {
  const bodyText = response.bodyText.trim();
  const preview = bodyText.length > 160 ? `${bodyText.slice(0, 160)}...` : bodyText;
  return `${response.status} ${preview || "(empty body)"}`;
}

function parseStreamedText(bodyText: string): string {
  const events = parseSseEvents(bodyText);
  if (events.length === 0) {
    throw new Error("response stream was empty");
  }

  let completed = false;
  const chunks: string[] = [];

  for (const event of events) {
    const payload = parsePayload(event.dataText);
    if (isToolEvent(event.event, payload)) {
      throw new Error("tool calls are unsupported for inline completions");
    }

    if (event.event === "response.output_text.delta") {
      if (typeof payload.delta === "string") {
        chunks.push(payload.delta);
      }
      continue;
    }

    if (event.event === "response.failed") {
      throw new Error(extractStreamError(payload.error) ?? "response stream failed");
    }

    if (event.event === "response.completed") {
      const responseError = payload.response?.error;
      if (responseError) {
        throw new Error(extractStreamError(responseError) ?? "response completed with an error");
      }
      completed = true;
    }
  }

  if (!completed) {
    throw new Error("response stream ended before completion");
  }

  return chunks.join("");
}

function parsePayload(dataText: string): StreamedResponsePayload {
  if (!dataText) {
    return {};
  }

  try {
    return JSON.parse(dataText) as StreamedResponsePayload;
  } catch {
    throw new Error(`response stream included invalid JSON: ${dataText.slice(0, 120)}`);
  }
}

function isToolEvent(eventName: string, payload: StreamedResponsePayload): boolean {
  if (eventName.includes("function_call") || eventName.includes("tool")) {
    return true;
  }
  return typeof payload.item?.type === "string" && payload.item.type.includes("function_call");
}

function extractStreamError(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.detail === "string"
        ? record.detail
        : undefined;
  return [code, message].filter(Boolean).join(": ") || undefined;
}
