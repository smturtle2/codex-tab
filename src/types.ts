export const REQUIRED_MODEL = "gpt-5.4-mini";
export const REQUIRED_REASONING_EFFORT = "low";
export const REFRESH_LEEWAY_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface ExtensionSettings {
  enabled: boolean;
  debounceMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  authFilePath: string;
  requestTimeoutMs: number;
}

export interface TokenRecord {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
}

export interface AuthFileRecord {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: TokenRecord | null;
  last_refresh?: unknown;
  [key: string]: unknown;
}

export interface AuthSnapshot {
  authFilePath: string;
  accessToken: string;
  refreshToken: string;
  accountId: string | undefined;
  idToken: string | undefined;
  expiresAt: number | undefined;
  raw: AuthFileRecord;
}

export interface AuthStore {
  invalidate(): void;
  ensureValid(signal?: AbortSignal): Promise<AuthSnapshot>;
  forceRefresh(signal?: AbortSignal): Promise<AuthSnapshot>;
  updateAuthFilePath?(authFilePath: string): void;
}

export interface RefreshTokenPayload {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
}

export interface CompletionRequest {
  languageId: string;
  relativePath: string;
  prefix: string;
  suffix: string;
  linePrefix: string;
  lineSuffix: string;
  cursorLine: number;
  cursorCharacter: number;
}

export interface CompletionResult {
  completion: string;
  rawText: string;
}

export interface LoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface HttpRequestOptions {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string> | undefined;
  jsonBody?: unknown;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface HttpClient {
  request(options: HttpRequestOptions): Promise<HttpResponse>;
}

export interface ModelAvailabilityResponse {
  available: boolean;
  modelIds: string[];
}
