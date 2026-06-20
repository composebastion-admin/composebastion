import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getHost = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHost: (...args: unknown[]) => getHost(...args)
}));

import { analyzeMigrationPlan, buildMigrationPlan } from "../src/services/migrationPlanning.js";

describe("migration planning warnings", () => {
  const baseInput = {
    sourceHostId: "00000000-0000-4000-8000-000000000001",
    targetHostId: "00000000-0000-4000-8000-000000000002",
    sourceAppIdentity: { kind: "compose" as const, projectName: "demoapp" },
    createRecoveryPoint: true
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getHost.mockResolvedValue({
      id: "host",
      lastStatus: "online",
      dockerVersion: "29.0.0",
      composeVersion: "2.34.0"
    });
    query.mockResolvedValue({ rows: [] });
  });

  it("warns when source and target hosts are the same", () => {
    const plan = buildMigrationPlan(
      { ...baseInput, targetHostId: baseInput.sourceHostId },
      {
        label: "Demo",
        projectName: "demoapp",
        stackId: null,
        composeYaml: "services:\n  web:\n    image: nginx\n",
        env: "",
        workingDir: null,
        composePath: null,
        containerIds: ["web"],
        volumeNames: ["demoapp_data"]
      }
    );
    expect(plan.warnings.some((warning) => warning.includes("same"))).toBe(true);
    expect(plan.checks.sourceHostAvailable).toBe(true);
    expect(plan.blockingIssues).toEqual([]);
  });

  it("warns when compose is missing for container-only apps", () => {
    const plan = buildMigrationPlan(baseInput, {
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["abc123"],
      volumeNames: []
    });
    expect(plan.warnings.some((warning) => warning.includes("standalone containers"))).toBe(true);
    expect(plan.estimatedArtifacts).toBe(1);
  });

  it("counts compose working directories as host folders", () => {
    const plan = buildMigrationPlan(baseInput, {
      label: "DemoApp",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  demoapp:\n    image: ghcr.io/admin-dockermender/demo-app:beta\n",
      env: "",
      workingDir: "/home/docker/DemoApp",
      composePath: "docker-compose.release.yml",
      containerIds: ["demoapp"],
      volumeNames: []
    });

    expect(plan.estimatedHostFolders).toBe(1);
    expect(plan.estimatedArtifacts).toBe(3);
    expect(plan.warnings).toContain("Compose working directory /home/docker/DemoApp will be captured and recreated on the target at the same path.");
  });

  it("detects static IP conflicts when target networks are reused", async () => {
    const sourceHostId = baseInput.sourceHostId;
    const targetHostId = baseInput.targetHostId;
    query.mockImplementation(async (sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (sql.includes("kind = 'container'") && hostId === sourceHostId && params.length === 1) {
        return {
          rows: [{
            external_id: "web-1",
            name: "demoapp-web-1",
            data: {
              Image: "nginx:alpine",
              State: "running",
              Labels: { "com.docker.compose.project": "demoapp" },
              NetworkSettings: {
                Networks: {
                  backend: {
                    IPAddress: "172.28.0.10",
                    Aliases: ["web"]
                  }
                }
              },
              Mounts: []
            }
          }]
        };
      }
      if (kind === "container" && hostId === targetHostId) {
        return {
          rows: [{
            name: "existing-api",
            data: {
              NetworkSettings: {
                Networks: {
                  backend: { IPAddress: "172.28.0.10" }
                }
              }
            }
          }]
        };
      }
      if (kind === "network" && hostId === targetHostId) {
        return { rows: [{ name: "backend", data: { Name: "backend" } }] };
      }
      return { rows: [] };
    });

    const plan = await analyzeMigrationPlan(baseInput, {
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["web-1"],
      volumeNames: []
    });

    expect(plan.missingNetworks).toEqual([]);
    expect(plan.networkConflicts).toEqual([
      "Network backend already has 172.28.0.10 assigned to existing-api; reusing that network would conflict with demoapp-web-1."
    ]);
    expect(plan.warnings.some((warning) => warning.includes("static IP conflict"))).toBe(true);
  });
});
