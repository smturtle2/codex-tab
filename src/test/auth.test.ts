import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { CodexAuthStore } from "../auth";
import type { HttpClient, HttpRequestOptions, HttpResponse } from "../types";

test("CodexAuthStore refreshes expired tokens and persists auth.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tab-auth-"));
  const authFile = path.join(tempDir, "auth.json");
  await fs.writeFile(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        refresh_token: "refresh-old",
        id_token: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_123",
          },
        }),
      },
    }),
    "utf8",
  );

  const requests: HttpRequestOptions[] = [];
  const httpClient: HttpClient = {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      requests.push(options);
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "refresh-new",
        }),
      };
    },
  };

  const store = new CodexAuthStore(authFile, httpClient, createLogger());
  const snapshot = await store.ensureValid();

  assert.equal(snapshot.refreshToken, "refresh-new");
  assert.equal(snapshot.accountId, "acct_123");
  assert.equal(requests.length, 1);

  const written = JSON.parse(await fs.readFile(authFile, "utf8")) as {
    tokens: { refresh_token: string };
  };
  assert.equal(written.tokens.refresh_token, "refresh-new");
});

test("CodexAuthStore reads account id from access token claims", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tab-auth-"));
  const authFile = path.join(tempDir, "auth.json");
  await fs.writeFile(
    authFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: createJwt({
          exp: Math.floor(Date.now() / 1000) + 3600,
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_from_access",
          },
        }),
        refresh_token: "refresh-token",
      },
    }),
    "utf8",
  );

  const store = new CodexAuthStore(
    authFile,
    {
      async request(): Promise<HttpResponse> {
        throw new Error("should not refresh");
      },
    },
    createLogger(),
  );

  const snapshot = await store.ensureValid();
  assert.equal(snapshot.accountId, "acct_from_access");
});

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url")
      .replace(/=/g, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function createLogger() {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}
