import * as fs from "node:fs/promises";

import { assertOk, parseJsonResponse } from "./http";
import {
  extractAccountId,
  extractExpirationMs,
  expandHome,
} from "./util";
import type {
  AuthFileRecord,
  AuthSnapshot,
  AuthStore,
  HttpClient,
  LoggerLike,
  RefreshTokenPayload,
} from "./types";
import {
  OAUTH_CLIENT_ID,
  REFRESH_LEEWAY_MS,
  TOKEN_ENDPOINT,
} from "./types";

export class CodexAuthStore implements AuthStore {
  private authFilePath: string;
  private readonly httpClient: HttpClient;
  private readonly logger: LoggerLike;
  private cache: { mtimeMs: number; snapshot: AuthSnapshot } | undefined;

  public constructor(
    authFilePath: string,
    httpClient: HttpClient,
    logger: LoggerLike,
  ) {
    this.authFilePath = expandHome(authFilePath);
    this.httpClient = httpClient;
    this.logger = logger;
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  public updateAuthFilePath(authFilePath: string): void {
    this.authFilePath = expandHome(authFilePath);
    this.invalidate();
  }

  public async ensureValid(signal?: AbortSignal): Promise<AuthSnapshot> {
    const snapshot = await this.loadSnapshot(false);
    if (!needsRefresh(snapshot)) {
      return snapshot;
    }
    return await this.refresh(snapshot, signal);
  }

  public async forceRefresh(signal?: AbortSignal): Promise<AuthSnapshot> {
    const snapshot = await this.loadSnapshot(false);
    return await this.refresh(snapshot, signal);
  }

  public async loadSnapshot(forceReload: boolean): Promise<AuthSnapshot> {
    const stat = await fs.stat(this.authFilePath);
    if (!forceReload && this.cache?.mtimeMs === stat.mtimeMs) {
      return this.cache.snapshot;
    }

    const text = await fs.readFile(this.authFilePath, "utf8");
    const parsed = JSON.parse(text) as AuthFileRecord;
    const snapshot = buildSnapshot(this.authFilePath, parsed);
    this.cache = { mtimeMs: stat.mtimeMs, snapshot };
    return snapshot;
  }

  private async refresh(
    snapshot: AuthSnapshot,
    signal?: AbortSignal,
  ): Promise<AuthSnapshot> {
    this.logger.info(`Refreshing Codex auth token via ${TOKEN_ENDPOINT}`);
    const response = await this.httpClient.request({
      method: "POST",
      url: TOKEN_ENDPOINT,
      headers: {
        Accept: "application/json",
      },
      jsonBody: {
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: snapshot.refreshToken,
      },
      timeoutMs: 15_000,
      signal,
    });
    assertOk(response, "token refresh failed");
    const payload = parseJsonResponse<RefreshTokenPayload>(response);
    const nextAccessToken = payload.access_token ?? snapshot.accessToken;
    const nextRefreshToken = payload.refresh_token ?? snapshot.refreshToken;
    const nextIdToken = payload.id_token ?? snapshot.idToken;
    if (!nextAccessToken) {
      throw new Error("refresh response did not include an access token");
    }

    const updated: AuthFileRecord = {
      ...snapshot.raw,
      auth_mode: snapshot.raw.auth_mode ?? "chatgpt",
      tokens: {
        ...(snapshot.raw.tokens ?? {}),
        access_token: nextAccessToken,
        refresh_token: nextRefreshToken,
        id_token: nextIdToken ?? snapshot.raw.tokens?.id_token,
        account_id:
          snapshot.raw.tokens?.account_id ??
          extractAccountId(nextIdToken) ??
          extractAccountId(nextAccessToken) ??
          snapshot.accountId,
      },
      last_refresh: new Date().toISOString(),
    };

    await fs.writeFile(this.authFilePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    this.invalidate();
    return await this.loadSnapshot(true);
  }
}

function buildSnapshot(authFilePath: string, raw: AuthFileRecord): AuthSnapshot {
  const tokens = raw.tokens;
  if (!tokens) {
    throw new Error(`Codex auth file at ${authFilePath} has no tokens object`);
  }

  const accessToken =
    typeof tokens.access_token === "string" ? tokens.access_token : undefined;
  const refreshToken =
    typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;

  if (!accessToken || !refreshToken) {
    throw new Error(`Codex auth file at ${authFilePath} is missing access or refresh tokens`);
  }

  const idToken =
    typeof tokens.id_token === "string"
      ? tokens.id_token
      : tokens.id_token &&
          typeof tokens.id_token === "object" &&
          typeof (tokens.id_token as Record<string, unknown>).raw_jwt === "string"
        ? ((tokens.id_token as Record<string, unknown>).raw_jwt as string)
        : undefined;

  const accountId =
    typeof tokens.account_id === "string"
      ? tokens.account_id
      : extractAccountId(idToken) ?? extractAccountId(accessToken);

  return {
    authFilePath,
    accessToken,
    refreshToken,
    accountId,
    idToken,
    expiresAt: extractExpirationMs(accessToken),
    raw,
  };
}

function needsRefresh(snapshot: AuthSnapshot): boolean {
  if (!snapshot.expiresAt) {
    return false;
  }
  return snapshot.expiresAt - REFRESH_LEEWAY_MS <= Date.now();
}
