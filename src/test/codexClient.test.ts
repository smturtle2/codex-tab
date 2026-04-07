import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexResponsesClient } from "../codexClient";
import type {
  AuthSnapshot,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  LoggerLike,
} from "../types";

class FakeAuthStore {
  public constructor(private readonly snapshot: AuthSnapshot) {}

  public invalidate(): void {}

  public async hasSession(): Promise<boolean> {
    return true;
  }

  public async ensureValid(): Promise<AuthSnapshot> {
    return this.snapshot;
  }

  public async forceRefresh(): Promise<AuthSnapshot> {
    return this.snapshot;
  }

  public async signIn(): Promise<AuthSnapshot> {
    return this.snapshot;
  }

  public async signOut(): Promise<void> {}
}

test("CodexResponsesClient creates streamed completion requests and parses deltas", async () => {
  const requests: HttpRequestOptions[] = [];
  const httpClient: HttpClient = {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      requests.push(options);
      return {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
        bodyText: [
          'event: response.created',
          'data: {"type":"response.created"}',
          "",
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"foo()"}',
          "",
          'event: response.completed',
          'data: {"type":"response.completed","response":{"error":null}}',
          "",
        ].join("\n"),
      };
    },
  };

  const client = createClient(httpClient, {
    accessToken: "access",
    refreshToken: "refresh",
    accountId: "acct",
    idToken: undefined,
    expiresAt: undefined,
    lastRefresh: undefined,
  });

  const result = await client.complete(
    {
      languageId: "typescript",
      relativePath: "src/example.ts",
      prefix: "const x = ",
      suffix: "\n",
      linePrefix: "const x = ",
      lineSuffix: "",
      cursorLine: 1,
      cursorCharacter: 11,
    },
    "gpt-5.4-mini",
  );

  assert.equal(result.completion, "foo()");
  assert.equal(requests.length, 1);
  const body = requests[0]!.jsonBody as {
    model: string;
    stream: boolean;
    reasoning: { effort: string; summary: string };
  };
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.stream, true);
  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.reasoning.summary, "auto");
  assert.match(requests[0]!.url, /\/responses\?client_version=1\.2\.3$/);
});

test("CodexResponsesClient probe uses the required model without catalog preflight", async () => {
  const requests: HttpRequestOptions[] = [];
  const client = createClient(
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        requests.push(options);
        return {
          status: 200,
          headers: {},
          bodyText: [
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"OK"}',
            "",
            'event: response.completed',
            'data: {"type":"response.completed","response":{"error":null}}',
            "",
          ].join("\n"),
        };
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  await client.probeReady("gpt-5.4-mini");

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/responses\?client_version=1\.2\.3$/);
});

test("CodexResponsesClient fails closed on tool-call events", async () => {
  const client = createClient(
    {
      async request(): Promise<HttpResponse> {
        return {
          status: 200,
          headers: {},
          bodyText: [
            'event: response.output_item.added',
            'data: {"type":"response.output_item.added","item":{"type":"function_call"}}',
            "",
            'event: response.completed',
            'data: {"type":"response.completed","response":{"error":null}}',
            "",
          ].join("\n"),
        };
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  await assert.rejects(async () => {
    await client.complete(
      {
        languageId: "typescript",
        relativePath: "src/example.ts",
        prefix: "",
        suffix: "",
        linePrefix: "",
        lineSuffix: "",
        cursorLine: 1,
        cursorCharacter: 1,
      },
      "gpt-5.4-mini",
    );
  }, /tool calls are unsupported/i);
});

test("CodexResponsesClient lists models from the official catalog route when available", async () => {
  const requests: HttpRequestOptions[] = [];
  const client = createClient(
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        requests.push(options);
        assert.equal(options.method, "GET");
        assert.match(options.url, /\/model\/list\?client_version=1\.2\.3&includeHidden=true$/);
        assert.equal(options.headers?.Accept, "application/json");
        assert.equal(options.headers?.Authorization, "Bearer access");
        assert.equal(options.headers?.["ChatGPT-Account-ID"], "acct");
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          bodyText: JSON.stringify({
            data: [
              {
                model: "gpt-5.4",
                displayName: "GPT-5.4",
                isDefault: true,
                supportedReasoningEfforts: [
                  { reasoningEffort: "minimal" },
                  { reasoningEffort: "high" },
                ],
              },
            ],
          }),
        };
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct",
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  const models = await client.listOfficialModels();

  assert.equal(requests.length, 1);
  assert.deepEqual(models, [
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      isDefault: true,
      supportedReasoningEfforts: ["minimal", "high"],
      reasoningEffortSource: "backend",
      source: "official",
    },
  ]);
});

test("CodexResponsesClient retries alternate official catalog variants before failing over elsewhere", async () => {
  const requests: HttpRequestOptions[] = [];
  const client = createClient(
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        requests.push(options);
        if (requests.length < 3) {
          return {
            status: 404,
            headers: {
              "content-type": "application/json",
            },
            bodyText: JSON.stringify({ error: "not found" }),
          };
        }

        assert.equal(options.method, "POST");
        assert.match(options.url, /\/model\/list\?client_version=1\.2\.3$/);
        assert.deepEqual(options.jsonBody, { includeHidden: true });
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          bodyText: JSON.stringify({
            data: [
              {
                id: "gpt-5.3-codex",
                label: "GPT-5.3 Codex",
              },
            ],
          }),
        };
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  const models = await client.listOfficialModels();

  assert.equal(requests.length, 3);
  assert.deepEqual(models, [
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      reasoningEffortSource: "inferred",
      source: "official",
    },
  ]);
});

test("CodexResponsesClient lists models from the fallback Codex backend route", async () => {
  const client = createClient(
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        assert.equal(options.method, "GET");
        assert.match(options.url, /\/models\?client_version=1\.2\.3$/);
        assert.equal(options.headers?.Accept, "application/json");
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          bodyText: JSON.stringify({
            data: [
              {
                id: "gpt-5.4-mini",
                label: "GPT-5.4 Mini",
                supported_reasoning_efforts: ["minimal", "low", "medium", "high"],
              },
            ],
          }),
        };
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct",
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  const models = await client.listFallbackModels();

  assert.deepEqual(models, [
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortSource: "backend",
      source: "backend_fallback",
    },
  ]);
});

test("CodexResponsesClient loads model availability config on a best-effort basis", async () => {
  const requests: HttpRequestOptions[] = [];
  const client = createClient(
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        requests.push(options);
        if (requests.length < 2) {
          return {
            status: 404,
            headers: {
              "content-type": "application/json",
            },
            bodyText: JSON.stringify({ error: "not found" }),
          };
        }

        assert.equal(options.method, "POST");
        assert.match(options.url, /\/config\/read\?client_version=1\.2\.3$/);
        assert.deepEqual(options.jsonBody, {
          key: "codex-app-vscode-model-availability",
        });
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          bodyText: JSON.stringify({
            config: {
              value: {
                available_models: ["gpt-5.4", "gpt-5.3-codex"],
                use_hidden_models: true,
                default_model: "gpt-5.4",
              },
            },
          }),
        };
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  const config = await client.loadModelAvailabilityConfig();

  assert.deepEqual(config, {
    availableModels: ["gpt-5.4", "gpt-5.3-codex"],
    useHiddenModels: true,
    defaultModel: "gpt-5.4",
  });
});

test("CodexResponsesClient falls back to a default client version when none is provided", async () => {
  const requests: HttpRequestOptions[] = [];
  const client = new CodexResponsesClient(
    new FakeAuthStore({
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    }),
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        requests.push(options);
        return {
          status: 200,
          headers: {},
          bodyText: [
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"OK"}',
            "",
            'event: response.completed',
            'data: {"type":"response.completed","response":{"error":null}}',
            "",
          ].join("\n"),
        };
      },
    },
    createLogger(),
    {
      reasoningEffort: "low",
      requestTimeoutMs: 20_000,
    },
  );

  await client.probeReady("gpt-5.4-mini");

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/responses\?client_version=0\.0\.0$/);
});

test("CodexResponsesClient requires a non-empty model id at call time", async () => {
  const client = createClient(
    {
      async request(): Promise<HttpResponse> {
        throw new Error("request should not be called");
      },
    },
    {
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    },
  );

  await assert.rejects(async () => {
    await client.probeReady("");
  }, /non-empty model id/i);
});

function createClient(
  httpClient: HttpClient,
  snapshot: AuthSnapshot,
): CodexResponsesClient {
  return new CodexResponsesClient(
    new FakeAuthStore(snapshot),
    httpClient,
    createLogger(),
    {
      reasoningEffort: "low",
      requestTimeoutMs: 20_000,
      clientVersion: "1.2.3",
    },
  );
}

function createLogger(): LoggerLike {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}
