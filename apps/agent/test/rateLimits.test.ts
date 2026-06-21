import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectRateLimit(method: string, path: string, limiter: string) {
  const routePattern = new RegExp(
    `app\\.${method}\\(\\s*["\`]${escapeRegExp(path)}["\`]\\s*,\\s*\\{[\\s\\S]{0,260}rateLimit:\\s*${limiter}`
  );
  expect(source, `${method.toUpperCase()} ${path}`).toMatch(routePattern);
}

describe("agent route rate-limit coverage", () => {
  it("pins limits on command, stream, stats, and file endpoints", () => {
    expect(source).toContain("await app.register(rateLimit");
    expectRateLimit("get", "/api/host-stats", "agentReadRateLimit");
    expectRateLimit("post", "/api/run", "agentRunRateLimit");
    expectRateLimit("get", "/api/containers/:id/logs-stream", "agentRunRateLimit");
    expectRateLimit("post", "/api/files/write", "agentFileRateLimit");
    expectRateLimit("get", "/api/files/stat", "agentFileRateLimit");
    expectRateLimit("get", "/api/files/read", "agentFileRateLimit");
  });
});
