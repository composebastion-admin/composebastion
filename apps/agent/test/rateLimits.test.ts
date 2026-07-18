import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentApp } from "../src/server.js";

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
    expectRateLimit("get", "/api/health", "agentReadRateLimit");
    expectRateLimit("get", "/api/host-stats", "agentReadRateLimit");
    expectRateLimit("get", "/api/containers/usage", "agentReadRateLimit");
    expectRateLimit("get", "/api/containers/usage-stream", "agentStreamRateLimit");
    expectRateLimit("post", "/api/run", "agentRunRateLimit");
    expectRateLimit("get", "/api/containers/:id/logs-stream", "agentRunRateLimit");
    expectRateLimit("post", "/api/files/write", "agentFileRateLimit");
    expectRateLimit("get", "/api/files/stat", "agentFileRateLimit");
    expectRateLimit("get", "/api/files/read", "agentFileRateLimit");
  });

  it("caps concurrent usage streams separately from request rate limits", () => {
    expect(source).toContain("MAX_CONCURRENT_USAGE_STREAMS = 4");
    expect(source).toContain("activeUsageStreams >= MAX_CONCURRENT_USAGE_STREAMS");
    expect(source).toContain("Too many concurrent container usage streams");
  });

  it("returns an unhealthy status unless Docker and Compose both work", () => {
    expect(source).toContain("docker.code === 0 && compose.code === 0");
    expect(source).toContain("if (!ok) reply.code(503)");
  });

  it("enforces a configured request boundary through Fastify", async () => {
    const { app } = await createAgentApp({
      AGENT_TOKEN: "agent-rate-limit-test-token-that-is-long-enough",
      AGENT_RUN_RATE_LIMIT: "2"
    });
    try {
      const request = { method: "POST" as const, url: "/api/run", payload: { command: "docker ps" } };
      expect((await app.inject(request)).statusCode).toBe(401);
      expect((await app.inject(request)).statusCode).toBe(401);
      const limited = await app.inject(request);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ statusCode: 429 });
    } finally {
      await app.close();
    }
  });
});
