import { test } from "node:test";
import assert from "node:assert/strict";

import { CodexResponsesClient } from "../codexClient";
import type { AuthSnapshot, HttpClient, HttpRequestOptions, HttpResponse } from "../types";

class FakeAuthStore {
  public constructor(private readonly snapshot: AuthSnapshot) {}

  public invalidate(): void {}

  public async ensureValid(): Promise<AuthSnapshot> {
    return this.snapshot;
  }

  public async forceRefresh(): Promise<AuthSnapshot> {
    return this.snapshot;
  }
}

test("CodexResponsesClient validates model list and creates completion request", async () => {
  const requests: HttpRequestOptions[] = [];
  const httpClient: HttpClient = {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      requests.push(options);
      if (options.url.includes("/models")) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            data: [{ id: "gpt-5.4-mini" }],
          }),
        };
      }

      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          output_text: '{"completion":"foo()"}',
        }),
      };
    },
  };

  const client = new CodexResponsesClient(
    new FakeAuthStore({
      authFilePath: "/tmp/auth.json",
      accessToken: "access",
      refreshToken: "refresh",
      accountId: "acct",
      idToken: undefined,
      expiresAt: undefined,
      raw: {},
    }),
    httpClient,
    createLogger(),
  );

  const result = await client.complete({
    languageId: "typescript",
    relativePath: "src/example.ts",
    prefix: "const x = ",
    suffix: "\n",
    linePrefix: "const x = ",
    lineSuffix: "",
    cursorLine: 1,
    cursorCharacter: 11,
  });

  assert.equal(result.completion, "foo()");
  assert.equal(requests.length, 2);
  const body = requests[1]!.jsonBody as {
    model: string;
    reasoning: { effort: string };
  };
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.reasoning.effort, "low");
});

test("CodexResponsesClient accepts vendor model list shape", async () => {
  const client = new CodexResponsesClient(
    new FakeAuthStore({
      authFilePath: "/tmp/auth.json",
      accessToken: "access",
      refreshToken: "refresh",
      accountId: undefined,
      idToken: undefined,
      expiresAt: undefined,
      raw: {},
    }),
    {
      async request(options: HttpRequestOptions): Promise<HttpResponse> {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify(
            options.url.includes("/models")
              ? { models: [{ slug: "gpt-5.4-mini" }] }
              : { output_text: '{"completion":""}' },
          ),
        };
      },
    },
    createLogger(),
  );

  await assert.doesNotReject(async () => {
    await client.ensureModelAvailable();
  });
});

function createLogger() {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}
