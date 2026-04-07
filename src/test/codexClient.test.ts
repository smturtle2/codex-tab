import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexResponsesClient } from "../codexClient";
import type {
  AuthSnapshot,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
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

  const client = new CodexResponsesClient(
    new FakeAuthStore({
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct",
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    }),
    httpClient,
    createLogger(),
    {
      reasoningEffort: "low",
      requestTimeoutMs: 20_000,
      clientVersion: "1.2.3",
    },
  );

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

test("CodexResponsesClient probe uses the required model without /models preflight", async () => {
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
      clientVersion: "1.2.3",
    },
  );

  await client.probeReady("gpt-5.4-mini");

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /\/responses\?client_version=1\.2\.3$/);
});

test("CodexResponsesClient fails closed on tool-call events", async () => {
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
    createLogger(),
    {
      reasoningEffort: "low",
      requestTimeoutMs: 20_000,
      clientVersion: "1.2.3",
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

test("CodexResponsesClient lists models from the Codex backend", async () => {
  const client = new CodexResponsesClient(
    new FakeAuthStore({
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct",
      idToken: undefined,
      expiresAt: undefined,
      lastRefresh: undefined,
    }),
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
    createLogger(),
    {
      reasoningEffort: "low",
      requestTimeoutMs: 20_000,
      clientVersion: "1.2.3",
    },
  );

  const models = await client.listModels();

  assert.deepEqual(models, [
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
      reasoningEffortSource: "backend",
    },
  ]);
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
      async request(): Promise<HttpResponse> {
        throw new Error("request should not be called");
      },
    },
    createLogger(),
    {
      reasoningEffort: "low",
      requestTimeoutMs: 20_000,
      clientVersion: "1.2.3",
    },
  );

  await assert.rejects(async () => {
    await client.probeReady("");
  }, /non-empty model id/i);
});

function createLogger() {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}
