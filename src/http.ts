import * as http from "node:http";
import * as https from "node:https";
import { Buffer } from "node:buffer";

import type { HttpClient, HttpRequestOptions, HttpResponse } from "./types";

export class HttpError extends Error {
  public readonly status: number | undefined;
  public readonly bodyText: string | undefined;

  public constructor(message: string, status?: number, bodyText?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export class NodeHttpClient implements HttpClient {
  public async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const url = new URL(options.url);
    const bodyText =
      options.jsonBody === undefined ? undefined : JSON.stringify(options.jsonBody);
    const transport = url.protocol === "http:" ? http : https;

    return await new Promise<HttpResponse>((resolve, reject) => {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (bodyText !== undefined) {
        headers["content-type"] ??= "application/json";
        headers["content-length"] = String(Buffer.byteLength(bodyText));
      }

      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: options.method,
          headers,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on("end", () => {
            cleanup();
            resolve({
              status: response.statusCode ?? 0,
              headers: normalizeHeaders(response.headers),
              bodyText: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );

      request.on("error", (error) => {
        cleanup();
        reject(error);
      });

      let timeoutHandle: NodeJS.Timeout | undefined;
      if (options.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          request.destroy(new HttpError(`request timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs);
      }

      const onAbort = () => {
        request.destroy(new Error("request aborted"));
      };

      const cleanup = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        options.signal?.removeEventListener("abort", onAbort);
      };

      if (options.signal?.aborted) {
        cleanup();
        request.destroy(new Error("request aborted"));
        return;
      }

      options.signal?.addEventListener("abort", onAbort, { once: true });

      if (bodyText !== undefined) {
        request.write(bodyText);
      }
      request.end();
    });
  }
}

function normalizeHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
    }
  }
  return normalized;
}

export function parseJsonResponse<T>(response: HttpResponse): T {
  try {
    return JSON.parse(response.bodyText) as T;
  } catch (error) {
    throw new HttpError(
      `expected JSON response but received invalid payload: ${String(error)}`,
      response.status,
      response.bodyText,
    );
  }
}

export function assertOk(response: HttpResponse, message: string): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  throw new HttpError(
    `${message}: ${response.status} ${extractErrorMessage(response.bodyText)}`,
    response.status,
    response.bodyText,
  );
}

function extractErrorMessage(bodyText: string): string {
  if (!bodyText.trim()) {
    return "(empty body)";
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object") {
      const errorRecord = error as Record<string, unknown>;
      const code =
        typeof errorRecord.code === "string" ? errorRecord.code : undefined;
      const message =
        typeof errorRecord.message === "string"
          ? errorRecord.message
          : undefined;
      return [code, message].filter(Boolean).join(": ") || bodyText;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return bodyText;
  }

  return bodyText;
}
