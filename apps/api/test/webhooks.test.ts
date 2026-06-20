import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { postJsonWebhook, shouldAllowPrivateWebhookUrls, validateWebhookUrl } from "../src/services/webhooks.js";

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => error ? reject(error) : resolve());
  });
  server = null;
});

function listen(handler: http.RequestListener) {
  server = http.createServer(handler);
  return new Promise<number>((resolve) => {
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

describe("webhook delivery SSRF guard", () => {
  it("uses the same private-target policy shape as other outbound guards", () => {
    expect(shouldAllowPrivateWebhookUrls("development", false)).toBe(true);
    expect(shouldAllowPrivateWebhookUrls("production", false)).toBe(false);
    expect(shouldAllowPrivateWebhookUrls("production", true)).toBe(true);
  });

  it("rejects private webhook targets when private networks are not allowed", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];

    await expect(postJsonWebhook("http://hooks.internal.test/alert", { ok: true }, {
      allowPrivateNetwork: false,
      resolve
    })).rejects.toThrow("private network address");
    await expect(validateWebhookUrl("http://hooks.internal.test/alert", {
      allowPrivateNetwork: false,
      resolve
    })).resolves.toBe(false);
  });

  it("posts JSON through a validated pinned lookup when the target is allowed", async () => {
    let received = "";
    let receivedPath = "";
    const port = await listen((request, response) => {
      receivedPath = request.url ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        received += chunk;
      });
      request.on("end", () => {
        response.writeHead(202);
        response.end("accepted");
      });
    });
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];

    const result = await postJsonWebhook(`http://hooks.internal.test:${port}/alert?source=test`, { subject: "Hello" }, {
      allowPrivateNetwork: true,
      resolve
    });

    expect(result).toEqual({ ok: true, statusCode: 202 });
    expect(receivedPath).toBe("/alert?source=test");
    expect(JSON.parse(received)).toEqual({ subject: "Hello" });
  });

  it("rejects non-http webhook URLs", async () => {
    await expect(postJsonWebhook("file:///tmp/hook", { ok: true })).rejects.toThrow("http or https");
    await expect(validateWebhookUrl("file:///tmp/hook")).resolves.toBe(false);
  });
});
