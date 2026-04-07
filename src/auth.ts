import { createHash, randomBytes } from "node:crypto";

import { assertOk, parseJsonResponse } from "./http";
import { extractAccountId, extractExpirationMs } from "./util";
import type {
  AuthSessionRecord,
  AuthSnapshot,
  AuthStore,
  AuthUi,
  HttpClient,
  LoggerLike,
  OAuthEndpointConfig,
  RefreshTokenPayload,
  SecretStore,
} from "./types";
import {
  AUTH_SECRET_KEY,
  AUTHORIZATION_ENDPOINT,
  DISCOVERY_ENDPOINT,
  OAUTH_CLIENT_ID,
  OAUTH_ORIGINATOR,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPE,
  REFRESH_LEEWAY_MS,
  TOKEN_ENDPOINT,
} from "./types";

const REFRESH_SCOPE = "openid profile email";

export class AuthRequiredError extends Error {
  public constructor(message = 'Sign in required. Run "Codex Autocomplete: Sign In".') {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class CodexAuthStore implements AuthStore {
  private readonly secrets: SecretStore;
  private readonly ui: AuthUi;
  private readonly httpClient: HttpClient;
  private readonly logger: LoggerLike;
  private cache: AuthSnapshot | null | undefined;
  private endpoints: OAuthEndpointConfig | undefined;

  public constructor(
    secrets: SecretStore,
    ui: AuthUi,
    httpClient: HttpClient,
    logger: LoggerLike,
  ) {
    this.secrets = secrets;
    this.ui = ui;
    this.httpClient = httpClient;
    this.logger = logger;
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  public async hasSession(): Promise<boolean> {
    return (await this.loadSnapshot(false)) !== undefined;
  }

  public async ensureValid(signal?: AbortSignal): Promise<AuthSnapshot> {
    const snapshot = await this.loadSnapshot(false);
    if (!snapshot) {
      throw new AuthRequiredError();
    }
    if (!needsRefresh(snapshot)) {
      return snapshot;
    }
    return await this.refresh(snapshot, signal);
  }

  public async forceRefresh(signal?: AbortSignal): Promise<AuthSnapshot> {
    const snapshot = await this.loadSnapshot(false);
    if (!snapshot) {
      throw new AuthRequiredError();
    }
    return await this.refresh(snapshot, signal);
  }

  public async signIn(signal?: AbortSignal): Promise<AuthSnapshot> {
    const endpoints = await this.discoverEndpoints(signal);
    const state = generateState();
    const pkce = generatePkcePair();
    const authorizeUrl = buildAuthorizeUrl(endpoints.authorizationEndpoint, state, pkce.challenge);
    this.logger.info(`Starting OAuth sign-in with ${endpoints.authorizationEndpoint}`);
    this.logger.info(`Authorization URL: ${authorizeUrl}`);

    const callbackUrl = await this.ui.authorize(authorizeUrl);
    if (!callbackUrl) {
      throw new Error("sign-in cancelled");
    }

    const code = parseCallbackUrl(callbackUrl, state);
    const response = await this.httpClient.request({
      method: "POST",
      url: endpoints.tokenEndpoint,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      bodyText: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: pkce.verifier,
      }).toString(),
      timeoutMs: 15_000,
      signal,
    });
    assertOk(response, "token exchange failed");
    const payload = parseJsonResponse<RefreshTokenPayload>(response);
    const record = buildSessionRecord(payload);
    if (!record.refresh_token) {
      throw new Error("token exchange did not return a refresh token");
    }

    await this.persist(record);
    const snapshot = await this.loadSnapshot(true);
    if (!snapshot) {
      throw new Error("sign-in succeeded but no session was stored");
    }
    return snapshot;
  }

  public async signOut(): Promise<void> {
    await this.secrets.delete(AUTH_SECRET_KEY);
    this.invalidate();
  }

  private async loadSnapshot(forceReload: boolean): Promise<AuthSnapshot | undefined> {
    if (!forceReload && this.cache !== undefined) {
      return this.cache ?? undefined;
    }

    const raw = await this.secrets.get(AUTH_SECRET_KEY);
    if (!raw) {
      this.cache = null;
      return undefined;
    }

    let record: AuthSessionRecord;
    try {
      record = JSON.parse(raw) as AuthSessionRecord;
    } catch {
      this.cache = null;
      throw new AuthRequiredError("Stored Codex session is invalid. Sign in again.");
    }

    const snapshot = buildSnapshot(record);
    this.cache = snapshot;
    return snapshot;
  }

  private async refresh(
    snapshot: AuthSnapshot,
    signal?: AbortSignal,
  ): Promise<AuthSnapshot> {
    const endpoints = await this.discoverEndpoints(signal);
    this.logger.info(`Refreshing Codex auth token via ${endpoints.tokenEndpoint}`);
    const response = await this.httpClient.request({
      method: "POST",
      url: endpoints.tokenEndpoint,
      headers: {
        Accept: "application/json",
      },
      jsonBody: {
        grant_type: "refresh_token",
        refresh_token: snapshot.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: REFRESH_SCOPE,
      },
      timeoutMs: 15_000,
      signal,
    });
    assertOk(response, "token refresh failed");
    const payload = parseJsonResponse<RefreshTokenPayload>(response);
    const record = buildSessionRecord(payload, snapshot);
    await this.persist(record);
    const refreshed = await this.loadSnapshot(true);
    if (!refreshed) {
      throw new Error("token refresh succeeded but no session was stored");
    }
    return refreshed;
  }

  private async persist(record: AuthSessionRecord): Promise<void> {
    await this.secrets.store(AUTH_SECRET_KEY, JSON.stringify(record));
    this.invalidate();
  }

  private async discoverEndpoints(signal?: AbortSignal): Promise<OAuthEndpointConfig> {
    if (this.endpoints) {
      return this.endpoints;
    }

    const fallback: OAuthEndpointConfig = {
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    };

    try {
      const response = await this.httpClient.request({
        method: "GET",
        url: DISCOVERY_ENDPOINT,
        headers: {
          Accept: "application/json",
        },
        timeoutMs: 10_000,
        signal,
      });
      assertOk(response, "OAuth discovery failed");
      const payload = parseJsonResponse<Record<string, unknown>>(response);
      const authorizationEndpoint =
        typeof payload.authorization_endpoint === "string"
          ? payload.authorization_endpoint
          : fallback.authorizationEndpoint;
      const tokenEndpoint =
        typeof payload.token_endpoint === "string"
          ? payload.token_endpoint
          : fallback.tokenEndpoint;
      this.endpoints = {
        authorizationEndpoint,
        tokenEndpoint,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OAuth discovery failed, using defaults: ${message}`);
      this.endpoints = fallback;
    }

    return this.endpoints;
  }
}

function buildSnapshot(record: AuthSessionRecord): AuthSnapshot {
  if (typeof record.access_token !== "string" || !record.access_token) {
    throw new AuthRequiredError("Stored Codex session is missing an access token. Sign in again.");
  }
  if (typeof record.refresh_token !== "string" || !record.refresh_token) {
    throw new AuthRequiredError("Stored Codex session is missing a refresh token. Sign in again.");
  }

  const accountId =
    typeof record.account_id === "string"
      ? record.account_id
      : extractAccountId(record.id_token) ?? extractAccountId(record.access_token);

  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    accountId,
    idToken: typeof record.id_token === "string" ? record.id_token : undefined,
    expiresAt:
      typeof record.expires_at === "number"
        ? record.expires_at
        : extractExpirationMs(record.access_token),
    lastRefresh: typeof record.last_refresh === "number" ? record.last_refresh : undefined,
  };
}

function buildSessionRecord(
  payload: RefreshTokenPayload,
  previous?: AuthSnapshot,
): AuthSessionRecord {
  const accessToken = payload.access_token ?? previous?.accessToken;
  const refreshToken = payload.refresh_token ?? previous?.refreshToken;
  const idToken = payload.id_token ?? previous?.idToken;
  const accountId =
    payload.account_id ??
    extractAccountId(idToken) ??
    extractAccountId(accessToken) ??
    previous?.accountId;
  const expiresAt = computeExpiresAt(payload, accessToken);

  if (!accessToken || !refreshToken) {
    throw new Error("OAuth response did not include the required tokens");
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken,
    account_id: accountId,
    expires_at: expiresAt,
    token_type: payload.token_type,
    scope: payload.scope,
    last_refresh: Date.now(),
  };
}

function computeExpiresAt(
  payload: RefreshTokenPayload,
  accessToken: string | undefined,
): number | undefined {
  if (typeof payload.expires_in === "number") {
    return Date.now() + payload.expires_in * 1000;
  }
  return extractExpirationMs(accessToken);
}

function needsRefresh(snapshot: AuthSnapshot): boolean {
  if (!snapshot.expiresAt) {
    return false;
  }
  return snapshot.expiresAt - REFRESH_LEEWAY_MS <= Date.now();
}

function buildAuthorizeUrl(
  authorizationEndpoint: string,
  state: string,
  codeChallenge: string,
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: OAUTH_ORIGINATOR,
  });
  return `${authorizationEndpoint}?${query.toString()}`;
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return toBase64Url(randomBytes(24));
}

function toBase64Url(buffer: Uint8Array): string {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function parseCallbackUrl(callbackUrl: string, expectedState: string): string {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl.trim());
  } catch {
    throw new Error("callback URL could not be parsed");
  }

  const error = parsed.searchParams.get("error");
  if (error) {
    const description = parsed.searchParams.get("error_description");
    throw new Error(
      `OAuth callback returned error: ${[error, description].filter(Boolean).join(" ")}`,
    );
  }

  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  if (!code) {
    throw new Error("callback URL is missing an authorization code");
  }
  if (state !== expectedState) {
    throw new Error("callback URL state did not match the login session");
  }
  return code;
}
