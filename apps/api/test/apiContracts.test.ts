import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  directHostActionTypes,
  type DirectHostActionType
} from "@composebastion/shared";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { buildOpenApiDocument, buildOpenApiMarkdown } from "../src/openapi/document.js";
import { registerApiVersionAliasRoutes } from "../src/routes/apiVersion.js";
import { isTrustedUnsafeRequestOrigin } from "../src/services/httpSecurity.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
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
      expect(response.json()).toMatchObject({
        ok: true,
        version: packageJson.version,
        revision: null,
        buildDate: null
      });
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

  it("preserves same-origin checks through unsafe v1 aliases without trusting forwarded hosts", async () => {
    const app = await buildServer();
    try {
      const sameOrigin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          host: "composebastion.example.com",
          origin: "https://composebastion.example.com"
        }
      });
      expect(sameOrigin.statusCode).toBe(200);
      expect(sameOrigin.json()).toEqual({ ok: true });

      const blocked = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          "x-request-id": "contract-v1-origin-block",
          host: "composebastion.example.com",
          origin: "https://evil.example",
          "x-forwarded-host": "evil.example"
        }
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({
        error: "Origin is not allowed for mutating API requests",
        code: "FORBIDDEN",
        requestId: "contract-v1-origin-block"
      });
    } finally {
      await app.close();
    }
  });

  it("uses the literal outer Host for v1 alias origin checks behind a trusted proxy", async () => {
    const app = Fastify({ trustProxy: true });
    app.addHook("preHandler", async (request, reply) => {
      if (request.method !== "POST") return;
      if (isTrustedUnsafeRequestOrigin(request.headers.origin, request.headers.host, [], "production")) return;
      return reply.code(403).send({ code: "FORBIDDEN" });
    });
    app.post("/api/probe", async () => ({ ok: true }));
    await registerApiVersionAliasRoutes(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/probe",
        headers: {
          host: "composebastion.example.com",
          origin: "https://composebastion.example.com",
          "x-forwarded-host": "attacker.example"
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
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
    const migrationRun = (document.components.schemas as any).MigrationRun;
    const recoveryProfile = (document.components.schemas as any).RecoveryProfile;
    const migrationPlan = (document.paths["/api/v1/recovery/migrations/plan"] as any).post;
    const migrationExecute = (document.paths["/api/v1/recovery/migrations/execute"] as any).post;
    const readiness = (document.paths["/api/v1/health/ready"] as any).get;
    const redisHealth = (document.paths["/api/v1/health/redis"] as any).get;
    const setup = (document.paths["/api/v1/auth/setup"] as any).post;
    const githubCreate = (document.paths["/api/v1/github/repos"] as any).post;
    const deploymentCreate = (document.paths["/api/v1/deploy/analyses"] as any).post;
    const backupTargetCreate = (document.paths["/api/v1/recovery/targets"] as any).post;
    const backupTargetUpdate = (document.paths["/api/v1/recovery/targets/{id}"] as any).patch;
    const jobRetry = (document.paths["/api/v1/jobs/{id}/retry"] as any).post;

    expect(jobsResponse).toEqual({ $ref: "#/components/schemas/JobsResponse" });
    expect(aggregateChannelHistoryResponse).toEqual({ $ref: "#/components/schemas/AlertChannelTestHistoryResponse" });
    expect(channelHistoryResponse).toEqual({ $ref: "#/components/schemas/AlertChannelTestHistoryResponse" });
    expect(operationJob.required).toContain("correlationId");
    expect(operationJob.required).toContain("progress");
    expect(dockerHost.required).toContain("agentVersion");
    expect(migrationRun.required).toContain("planRunId");
    expect(recoveryProfile.properties.sensitiveFieldsRedacted).toEqual({ type: "boolean" });
    expect(recoveryProfile.required).not.toContain("sensitiveFieldsRedacted");
    expect(migrationPlan.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/MigrationPlanRequest" });
    expect(migrationExecute.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/MigrationExecuteRequest" });
    expect((document.components.schemas as any).MigrationExecuteRequest.oneOf).toEqual([
      { $ref: "#/components/schemas/BoundMigrationExecuteRequest" },
      { $ref: "#/components/schemas/LegacyMigrationExecuteRequest" }
    ]);
    expect(migrationExecute.responses["409"].description).toContain("MIGRATION_PLAN_STALE");
    expect(readiness.responses["503"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/ReadinessResponse" });
    expect(redisHealth.responses["503"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/RedisHealthResponse" });
    expect((document.components.schemas as any).ReadinessResponse.properties.checks.additionalProperties.required)
      .toContain("required");
    expect((document.components.schemas as any).ReadinessResponse.properties.checks.additionalProperties.properties.required.description)
      .toContain("top-level readiness");
    expect(setup.responses["409"].description).toContain("setup is already complete");
    expect(githubCreate.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/GithubRepositoryCreateRequest" });
    expect((document.components.schemas as any).GithubRepositoryCreateRequest.properties.repositoryUrl.description)
      .toContain("Credential-free HTTPS github.com");
    expect(deploymentCreate.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/DeploymentAnalysisCreateRequest" });
    expect((document.components.schemas as any).DeploymentAnalysisCreateRequest.properties.source.description)
      .toContain("reject embedded credentials");
    expect(backupTargetCreate.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/BackupTargetCreateRequest" });
    expect(backupTargetUpdate.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/BackupTargetUpdateRequest" });
    const targetSchemas = document.components.schemas as any;
    const remoteName = targetSchemas.BackupTargetSmbCreateFlatRequest.properties.remoteName;
    const remoteNamePattern = new RegExp(remoteName.pattern, "u");
    expect(remoteName).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 120
    });
    expect(remoteNamePattern.test("Team NAS 2+ops@example.com")).toBe(true);
    expect(remoteNamePattern.test("Café.東京")).toBe(true);
    for (const invalid of ["-nas", " nas", "nas ", "nas#prod", "nas;prod", ":local"]) {
      expect(remoteNamePattern.test(invalid)).toBe(false);
    }
    const smbSubPathPattern = new RegExp(
      targetSchemas.BackupTargetSmbConnectionRequest.properties.subPath.pattern,
      "u"
    );
    for (const valid of ["", "daily", "ComposeBastion/daily"]) {
      expect(smbSubPathPattern.test(valid)).toBe(true);
    }
    for (const invalid of ["/absolute", "daily/", "../escape", "safe/../../escape", "safe//escape"]) {
      expect(smbSubPathPattern.test(invalid)).toBe(false);
    }
    expect(targetSchemas.BackupTargetSmbCreateFlatRequest.anyOf).toContainEqual({
      required: ["server", "share"]
    });
    expect(targetSchemas.BackupTargetImportedCreateFlatRequest.oneOf).toHaveLength(6);
    expect(targetSchemas.BackupTargetImportedCreateFlatRequest.oneOf.every(
      (variant: any) => variant.anyOf.some((option: any) => option.required?.includes("rcloneConfig"))
    )).toBe(true);
    expect(targetSchemas.BackupTargetUpdateRequest.description).toContain(
      "Switching to SMB requires a valid server/share"
    );
    expect(targetSchemas.BackupTargetUpdateRequest.properties.remoteName.pattern)
      .toBe(remoteName.pattern);
    expect((document.components.schemas as any).RegistryTrustRequest.properties.registry.examples)
      .toContain("[2001:db8::1]:5000");
    expect(jobRetry.responses["409"].description).toContain("WORKER_LOST");
    expect(document.info.version).toBe(packageJson.version);
    expect(document.components.schemas).toHaveProperty("AlertChannelTestEvent");
  });

  it("documents every direct host action as a closed discriminated request shape", () => {
    const document = buildOpenApiDocument();
    const actionOperation = (document.paths["/api/v1/hosts/{id}/actions"] as any).post;
    const actionRequest = (document.components.schemas as any).DirectHostActionRequest;
    const expectedPayloadProperties = {
      "host.check": [],
      "host.sync": [],
      "host.mkdir": ["path"],
      "git.clone": ["repositoryUrl", "directory", "branch", "shallow"],
      "git.pull": ["directory", "branch"],
      "git.testRemote": ["repositoryUrl", "branch"],
      "container.run": ["image", "name", "restartPolicy", "ports", "env", "volumes", "network", "command"],
      "container.start": ["containerId"],
      "container.stop": ["containerId", "timeoutSeconds"],
      "container.restart": ["containerId", "timeoutSeconds"],
      "container.rename": ["containerId", "name"],
      "container.update": ["containerId", "targetImage"],
      "container.remove": ["containerId", "force", "removeVolumes"],
      "image.pull": ["image"],
      "image.remove": ["imageId", "force"],
      "image.prune": ["all"],
      "image.cleanup": ["targets"],
      "network.create": ["name", "driver", "subnet", "gateway", "attachable", "internal", "labels"],
      "network.remove": ["networkId"],
      "network.prune": [],
      "volume.create": ["name", "labels"],
      "volume.remove": ["volumeName", "force"],
      "volume.prune": [],
      "compose.deployPath": [
        "projectName",
        "workingDir",
        "composePath",
        "gitPullBeforeDeploy",
        "branch"
      ]
    } satisfies Record<DirectHostActionType, string[]>;
    const expectedRequiredPayloadProperties = {
      "host.check": [],
      "host.sync": [],
      "host.mkdir": ["path"],
      "git.clone": ["repositoryUrl", "directory"],
      "git.pull": ["directory"],
      "git.testRemote": ["repositoryUrl"],
      "container.run": ["image"],
      "container.start": ["containerId"],
      "container.stop": ["containerId"],
      "container.restart": ["containerId"],
      "container.rename": ["containerId", "name"],
      "container.update": ["containerId"],
      "container.remove": ["containerId"],
      "image.pull": ["image"],
      "image.remove": ["imageId"],
      "image.prune": [],
      "image.cleanup": ["targets"],
      "network.create": ["name"],
      "network.remove": ["networkId"],
      "network.prune": [],
      "volume.create": ["name"],
      "volume.remove": ["volumeName"],
      "volume.prune": [],
      "compose.deployPath": ["projectName", "workingDir", "composePath"]
    } satisfies Record<DirectHostActionType, string[]>;

    expect(actionOperation.requestBody.content["application/json"].schema)
      .toEqual({ $ref: "#/components/schemas/DirectHostActionRequest" });
    expect(actionRequest.discriminator).toEqual({ propertyName: "type" });
    expect(actionRequest.oneOf).toHaveLength(directHostActionTypes.length);
    expect(actionRequest.oneOf.map((branch: any) => branch.properties.type.const))
      .toEqual([...directHostActionTypes]);

    for (const type of directHostActionTypes) {
      const branch = actionRequest.oneOf.find((candidate: any) => candidate.properties.type.const === type);
      expect(branch, type).toBeDefined();
      expect(branch).toMatchObject({
        title: type,
        required: ["type", "payload"],
        additionalProperties: false
      });
      expect(branch.properties.payload.additionalProperties, type).toBe(false);
      expect(Object.keys(branch.properties.payload.properties), type)
        .toEqual(expectedPayloadProperties[type]);
      expect(branch.properties.payload.required, type)
        .toEqual(expectedRequiredPayloadProperties[type]);
    }

    const byType = (type: DirectHostActionType) =>
      actionRequest.oneOf.find((branch: any) => branch.properties.type.const === type).properties.payload;
    expect(byType("container.restart").properties.timeoutSeconds)
      .toMatchObject({ type: "integer", minimum: 1, maximum: 300 });
    expect(byType("container.run").properties.ports)
      .toMatchObject({
        type: "array",
        default: [],
        items: {
          required: ["hostPort", "containerPort"],
          properties: {
            hostPort: { type: "integer", minimum: 1, maximum: 65535 },
            containerPort: { type: "integer", minimum: 1, maximum: 65535 }
          }
        }
      });
    expect(byType("image.cleanup").properties.targets)
      .toMatchObject({ type: "array", minItems: 1, maxItems: 200 });
    expect(byType("network.create").properties.driver)
      .toMatchObject({
        enum: ["bridge", "host", "overlay", "macvlan", "ipvlan", "none"],
        default: "bridge"
      });
    expect(byType("volume.create").properties.name.pattern)
      .toBe("^[a-zA-Z0-9][a-zA-Z0-9_.-]*$");
    expect(byType("compose.deployPath").properties.projectName.pattern)
      .toBe("^[a-z0-9][a-z0-9_-]*$");
    expect(actionRequest.oneOf.some((branch: any) => branch.properties.type.const === "deploy.execute"))
      .toBe(false);
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
