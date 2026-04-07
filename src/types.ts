export const DEFAULT_MODEL = "gpt-5.4-mini";
export const DEFAULT_REASONING_EFFORT = "low";
export const DEFAULT_REASONING_SUMMARY = "auto";
export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const REFRESH_LEEWAY_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DISCOVERY_ENDPOINT = "https://auth.openai.com/.well-known/oauth-authorization-server";
export const AUTHORIZATION_ENDPOINT = "https://auth.openai.com/oauth/authorize";
export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OAUTH_SCOPE = "openid profile email offline_access";
export const OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OAUTH_ORIGINATOR = "codex_cli_rs";
export const AUTH_SECRET_KEY = "codexAutocomplete.oauthSession";

export type ReasoningEffort = typeof REASONING_EFFORT_VALUES[number];

export interface ExtensionSettings {
  enabled: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  debounceMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  requestTimeoutMs: number;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  defaultReasoningEffort?: ReasoningEffort | undefined;
  isDefault?: boolean | undefined;
  supportedReasoningEfforts?: ReasoningEffort[] | undefined;
  reasoningEffortSource?: "backend" | "inferred" | undefined;
}

export interface AuthSessionRecord {
  access_token: string;
  refresh_token: string;
  id_token?: string | undefined;
  account_id?: string | undefined;
  expires_at?: number | undefined;
  token_type?: string | undefined;
  scope?: string | undefined;
  last_refresh?: number | undefined;
}

export interface AuthSnapshot {
  accessToken: string;
  refreshToken: string;
  accountId: string | undefined;
  idToken: string | undefined;
  expiresAt: number | undefined;
  lastRefresh: number | undefined;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AuthUi {
  authorize(authorizeUrl: string): Promise<string | undefined>;
}

export interface AuthStore {
  invalidate(): void;
  hasSession(): Promise<boolean>;
  ensureValid(signal?: AbortSignal): Promise<AuthSnapshot>;
  forceRefresh(signal?: AbortSignal): Promise<AuthSnapshot>;
  signIn(signal?: AbortSignal): Promise<AuthSnapshot>;
  signOut(): Promise<void>;
}

export interface OAuthEndpointConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface RefreshTokenPayload {
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  id_token?: string | undefined;
  token_type?: string | undefined;
  scope?: string | undefined;
  expires_in?: number | undefined;
  account_id?: string | undefined;
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
  bodyText?: string | undefined;
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

export interface SseEvent {
  event: string;
  dataText: string;
}
