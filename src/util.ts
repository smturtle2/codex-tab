import * as os from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";

import type { CompletionResult } from "./types";

export function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function parseJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const payload = Buffer.from(normalized + padding, "base64").toString("utf8");
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return parsed;
  } catch {
    return undefined;
  }
}

export function extractAccountId(jwt?: string): string | undefined {
  if (!jwt) {
    return undefined;
  }

  const claims = parseJwtClaims(jwt);
  const auth =
    claims?.["https://api.openai.com/auth"] &&
    typeof claims["https://api.openai.com/auth"] === "object"
      ? (claims["https://api.openai.com/auth"] as Record<string, unknown>)
      : undefined;

  const accountId =
    typeof auth?.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : typeof auth?.account_id === "string"
        ? auth.account_id
        : undefined;

  return accountId || undefined;
}

export function extractExpirationMs(jwt?: string): number | undefined {
  if (!jwt) {
    return undefined;
  }
  const claims = parseJwtClaims(jwt);
  const exp = claims?.exp;
  if (typeof exp !== "number") {
    return undefined;
  }
  return exp * 1000;
}

export function stripMarkdownCodeFence(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/u);
  if (lines.length < 3) {
    return trimmed;
  }
  if (!lines.at(-1)?.startsWith("```")) {
    return trimmed;
  }
  return lines.slice(1, -1).join("\n").trim();
}

export function parseStructuredCompletion(rawText: string): CompletionResult {
  const normalized = stripMarkdownCodeFence(rawText);
  const candidate = extractJsonObject(normalized);
  const parsed = JSON.parse(candidate) as Record<string, unknown>;
  if (typeof parsed.completion !== "string") {
    throw new Error("structured completion payload is missing string field `completion`");
  }
  return {
    completion: parsed.completion,
    rawText,
  };
}

function extractJsonObject(text: string): string {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return text.slice(first, last + 1);
  }
  return text;
}

export function trimSuggestion(
  typedPrefix: string,
  suggestedText: string,
  existingSuffix: string,
): string {
  let trimmed = suggestedText;

  const leadingOverlap = longestSuffixPrefixMatch(typedPrefix, trimmed);
  if (leadingOverlap > 0) {
    trimmed = trimmed.slice(leadingOverlap);
  }

  const trailingOverlap = longestPrefixSuffixMatch(trimmed, existingSuffix);
  if (trailingOverlap > 0) {
    trimmed = trimmed.slice(0, trimmed.length - trailingOverlap);
  }

  return trimmed;
}

function longestSuffixPrefixMatch(prefix: string, completion: string): number {
  const max = Math.min(prefix.length, completion.length, 200);
  for (let size = max; size > 0; size -= 1) {
    if (completion.startsWith(prefix.slice(-size))) {
      return size;
    }
  }
  return 0;
}

function longestPrefixSuffixMatch(completion: string, suffix: string): number {
  const max = Math.min(completion.length, suffix.length, 400);
  for (let size = max; size > 0; size -= 1) {
    if (completion.endsWith(suffix.slice(0, size))) {
      return size;
    }
  }
  return 0;
}

export function buildRelativePathLabel(
  workspaceFolderPath: string | undefined,
  documentPath: string,
): string {
  if (!workspaceFolderPath) {
    return path.basename(documentPath);
  }
  const relative = path.relative(workspaceFolderPath, documentPath);
  return relative || path.basename(documentPath);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("request aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      cleanup();
      reject(new Error("request aborted"));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && /aborted/i.test(error.message);
}
