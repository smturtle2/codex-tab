import * as path from "node:path";
import { Buffer } from "node:buffer";

import type { SseEvent } from "./types";

export function parseJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    return undefined;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const payload = Buffer.from(normalized + padding, "base64").toString("utf8");
    return JSON.parse(payload) as Record<string, unknown>;
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

  if (typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id) {
    return auth.chatgpt_account_id;
  }
  if (typeof auth?.account_id === "string" && auth.account_id) {
    return auth.account_id;
  }
  return undefined;
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
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return input;
  }

  const lines = trimmed.split(/\r?\n/u);
  if (lines.length < 3) {
    return input;
  }
  return lines.slice(1, -1).join("\n");
}

export function normalizeCompletionText(rawText: string): string {
  return stripMarkdownCodeFence(rawText);
}

export function parseSseEvents(bodyText: string): SseEvent[] {
  const blocks = bodyText.replace(/\r\n/g, "\n").split("\n\n");
  const events: SseEvent[] = [];

  for (const block of blocks) {
    if (!block.trim()) {
      continue;
    }

    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    events.push({
      event,
      dataText: dataLines.join("\n"),
    });
  }

  return events;
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
