import type {
  AuthSnapshot,
  AuthStore,
  CompletionRequest,
  CompletionResult,
  ExtensionSettings,
  HttpClient,
  HttpResponse,
  LoggerLike,
  ModelDescriptor,
} from "./types";
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REASONING_SUMMARY,
  DEFAULT_TIMEOUT_MS,
  RESPONSES_BASE_URL,
} from "./types";
import { assertOk } from "./http";
import { normalizeModelId, parseModelListResponse } from "./models";
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
  model: ExtensionSettings["model"];
  reasoningEffort: ExtensionSettings["reasoningEffort"];
  requestTimeoutMs: ExtensionSettings["requestTimeoutMs"];
  clientVersion?: string | undefined;
}

export class CodexResponsesClient {
  private readonly authStore: AuthStore;
  private readonly httpClient: HttpClient;
  private readonly logger: LoggerLike;
  private timeoutMs: number;
  private model: string;
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
    this.model = normalizeModelId(settings?.model ?? DEFAULT_MODEL);
    this.reasoningEffort = settings?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    this.clientVersion = normalizeClientVersion(settings?.clientVersion);
  }

  public invalidate(): void {
    this.authStore.invalidate();
  }

  public updateConfig(
    settings: Pick<ExtensionSettings, "model" | "reasoningEffort" | "requestTimeoutMs">,
  ): void {
    this.timeoutMs = settings.requestTimeoutMs;
    this.model = normalizeModelId(settings.model);
    this.reasoningEffort = settings.reasoningEffort;
    this.invalidate();
  }

  public async listModels(signal?: AbortSignal): Promise<ModelDescriptor[]> {
    const response = await this.withAuthRetry(
      async (snapshot) =>
        await this.httpClient.request({
          method: "GET",
          url: this.buildCodexUrl("/models"),
          headers: {
            ...buildAuthHeaders(snapshot),
            Accept: "application/json",
          },
          timeoutMs: this.timeoutMs,
          signal,
        }),
      signal,
    );

    assertOk(response, "model list request failed");
    return parseModelListResponse(response);
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

  public async probeReady(signal?: AbortSignal): Promise<void> {
    await this.requestStreamedText(
      {
        model: this.model,
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
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const prompt = buildPrompt(request);
    const rawText = await this.requestStreamedText(
      {
        model: this.model,
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

  private buildCodexUrl(pathname: string): string {
    const url = new URL(`${RESPONSES_BASE_URL}${pathname}`);
    url.searchParams.set("client_version", this.clientVersion);
    return url.toString();
  }
}

function normalizeClientVersion(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : "0.0.0";
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
