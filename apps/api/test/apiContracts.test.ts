import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { buildOpenApiDocument, buildOpenApiMarkdown } from "../src/openapi/document.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("API contracts", () => {
  it("serves stable JSON endpoints through /api/v1 aliases", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/health",
        headers: { "x-request-id": "contract-health" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("includes requestId in API error envelopes", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/not-a-real-route",
        headers: { "x-request-id": "contract-missing" }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: "Not found",
        code: "NOT_FOUND",
        requestId: "contract-missing"
      });
    } finally {
      await app.close();
    }
  });

  it("rejects cross-site unsafe API requests before route handlers", async () => {
    const app = await buildServer();
    try {
      const blocked = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          "x-request-id": "contract-origin-block",
          host: "composebastion.example.com",
          origin: "https://evil.example"
        }
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({
        error: "Origin is not allowed for mutating API requests",
        code: "FORBIDDEN",
        requestId: "contract-origin-block"
      });

      const sameOrigin = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: {
          host: "composebastion.example.com",
          origin: "https://composebastion.example.com"
        }
      });
      expect(sameOrigin.statusCode).toBe(200);

      const safeRead = await app.inject({
        method: "GET",
        url: "/api/health",
        headers: {
          host: "composebastion.example.com",
          origin: "https://evil.example"
        }
      });
      expect(safeRead.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("uses explicit v1 routes for non-JSON streams and downloads", async () => {
    const app = await buildServer();
    try {
      const hostId = "11111111-1111-4111-8111-111111111111";
      const backupId = "22222222-2222-4222-8222-222222222222";
      const cases = [
        `/api/v1/hosts/${hostId}/metrics-stream`,
        `/api/v1/hosts/${hostId}/containers/${encodeURIComponent("web")}/logs-stream`,
        `/api/v1/backups/${backupId}/download`
      ];

      for (const url of cases) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: { "x-request-id": `contract-${url.split("/").at(-1)}` }
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({
          code: "AUTH_REQUIRED"
        });
        expect(response.json().requestId).toMatch(/^contract-/);
      }
    } finally {
      await app.close();
    }
  });

  it("documents concrete response envelopes for core JSON routes", () => {
    const document = buildOpenApiDocument();
    const jobsResponse = (document.paths["/api/v1/jobs"] as any).get.responses["200"].content["application/json"].schema;
    const aggregateChannelHistoryResponse = (document.paths["/api/v1/alerts/channels/test-history"] as any).get.responses["200"].content["application/json"].schema;
    const channelHistoryResponse = (document.paths["/api/v1/alerts/channels/{id}/test-history"] as any).get.responses["200"].content["application/json"].schema;
    const operationJob = (document.components.schemas as any).OperationJob;
    const dockerHost = (document.components.schemas as any).DockerHost;

    expect(jobsResponse).toEqual({ $ref: "#/components/schemas/JobsResponse" });
    expect(aggregateChannelHistoryResponse).toEqual({ $ref: "#/components/schemas/AlertChannelTestHistoryResponse" });
    expect(channelHistoryResponse).toEqual({ $ref: "#/components/schemas/AlertChannelTestHistoryResponse" });
    expect(operationJob.required).toContain("correlationId");
    expect(operationJob.required).toContain("progress");
    expect(dockerHost.required).toContain("agentVersion");
    expect(document.components.schemas).toHaveProperty("AlertChannelTestEvent");
  });

  it("returns a standard error envelope before terminal websocket upgrade when unauthenticated", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/hosts/11111111-1111-4111-8111-111111111111/terminal",
        headers: { "x-request-id": "contract-terminal" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: "Authentication required",
        code: "AUTH_REQUIRED",
        requestId: "contract-terminal"
      });
    } finally {
      await app.close();
    }
  });

  it("keeps generated OpenAPI artifacts in sync", async () => {
    const [json, markdown] = await Promise.all([
      readFile(path.join(repoRoot, "docs/openapi.json"), "utf8"),
      readFile(path.join(repoRoot, "docs/openapi.md"), "utf8")
    ]);
    expect(json).toBe(`${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
    expect(markdown).toBe(buildOpenApiMarkdown());
  });
});
