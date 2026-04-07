import { test } from "node:test";
import assert from "node:assert/strict";

import { AuthRequiredError, CodexAuthStore } from "../auth";
import { DISCOVERY_ENDPOINT, TOKEN_ENDPOINT } from "../types";
import type {
  AuthUi,
  HttpClient,
  HttpRequestOptions,
  HttpResponse,
  SecretStore,
} from "../types";

test("CodexAuthStore refreshes expired tokens and persists secret storage", async () => {
  const secrets = new InMemorySecretStore();
  await secrets.store(
    "codexAutocomplete.oauthSession",
    JSON.stringify({
      access_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
      refresh_token: "refresh-old",
      id_token: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_123",
        },
      }),
    }),
  );

  const requests: HttpRequestOptions[] = [];
  const httpClient: HttpClient = {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      requests.push(options);
      if (options.url === DISCOVERY_ENDPOINT) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            authorization_endpoint: "https://auth.example.test/oauth/authorize",
            token_endpoint: TOKEN_ENDPOINT,
          }),
        };
      }

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

  const store = new CodexAuthStore(secrets, createAuthUi(), httpClient, createLogger());
  const snapshot = await store.ensureValid();

  assert.equal(snapshot.refreshToken, "refresh-new");
  assert.equal(snapshot.accountId, "acct_123");
  assert.equal(requests.length, 2);

  const written = JSON.parse((await secrets.get("codexAutocomplete.oauthSession")) ?? "{}") as {
    refresh_token: string;
  };
  assert.equal(written.refresh_token, "refresh-new");
});

test("CodexAuthStore signs in through PKCE and stores the exchanged tokens", async () => {
  const secrets = new InMemorySecretStore();
  const httpClient: HttpClient = {
    async request(options: HttpRequestOptions): Promise<HttpResponse> {
      if (options.url === DISCOVERY_ENDPOINT) {
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({
            authorization_endpoint: "https://auth.example.test/oauth/authorize",
            token_endpoint: TOKEN_ENDPOINT,
          }),
        };
      }

      assert.equal(options.url, TOKEN_ENDPOINT);
      assert.match(options.bodyText ?? "", /grant_type=authorization_code/);
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          access_token: createJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_sign_in",
            },
          }),
          refresh_token: "refresh-sign-in",
        }),
      };
    },
  };

  const store = new CodexAuthStore(
    secrets,
    {
      async authorize(authorizeUrl: string): Promise<string> {
        const url = new URL(authorizeUrl);
        const state = url.searchParams.get("state");
        assert.ok(state);
        assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
        assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
        assert.equal(url.searchParams.get("originator"), "codex_cli_rs");
        return `http://localhost:1455/auth/callback?code=code-123&state=${state}`;
      },
    },
    httpClient,
    createLogger(),
  );

  const snapshot = await store.signIn();
  assert.equal(snapshot.refreshToken, "refresh-sign-in");
  assert.equal(snapshot.accountId, "acct_sign_in");
  assert.equal(await store.hasSession(), true);
});

test("CodexAuthStore throws AuthRequiredError without a stored session", async () => {
  const store = new CodexAuthStore(
    new InMemorySecretStore(),
    createAuthUi(),
    {
      async request(): Promise<HttpResponse> {
        throw new Error("should not request");
      },
    },
    createLogger(),
  );

  await assert.rejects(async () => {
    await store.ensureValid();
  }, AuthRequiredError);
});

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url")
      .replace(/=/g, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

function createAuthUi(): AuthUi {
  return {
    async authorize(): Promise<string | undefined> {
      return undefined;
    },
  };
}

function createLogger() {
  return {
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
