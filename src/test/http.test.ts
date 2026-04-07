import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import { NodeHttpClient } from "../http";

test("NodeHttpClient normalizes request header casing before applying defaults", async () => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server failed to bind");
    }

    const client = new NodeHttpClient();
    const response = await client.request({
      method: "POST",
      url: `http://127.0.0.1:${address.port}/token`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      bodyText: "grant_type=authorization_code&code=abc",
      timeoutMs: 5_000,
    });

    const payload = JSON.parse(response.bodyText) as {
      contentType: string;
      body: string;
    };
    assert.equal(payload.contentType, "application/x-www-form-urlencoded");
    assert.equal(payload.body, "grant_type=authorization_code&code=abc");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
