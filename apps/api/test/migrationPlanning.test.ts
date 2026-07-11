import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const getHost = vi.fn();
const syncDockerInventory = vi.fn();
const runDocker = vi.fn();
const resolveAppContext = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHost: (...args: unknown[]) => getHost(...args)
}));

vi.mock("../src/services/docker.js", () => ({
  syncDockerInventory: (...args: unknown[]) => syncDockerInventory(...args),
  runDocker: (...args: unknown[]) => runDocker(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

import { analyzeMigrationPlan, buildMigrationPlan, revalidateMigrationPlan, sanitizedManifestForFingerprint } from "../src/services/migrationPlanning.js";

function containerInspect(input: {
  id: string;
  name: string;
  env?: string[];
  ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  networks?: Record<string, Record<string, unknown>>;
  mounts?: Array<Record<string, unknown>>;
}) {
  return {
    Id: input.id,
    Name: `/${input.name}`,
    Config: {
      Image: "nginx:alpine",
      Env: input.env ?? [],
      Labels: { "com.docker.compose.project": "demoapp" },
      Cmd: ["nginx", "-g", "daemon off;"]
    },
    HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    State: { Running: true, Status: "running" },
    NetworkSettings: {
      Ports: input.ports ?? {},
      Networks: input.networks ?? {}
    },
    Mounts: input.mounts ?? []
  };
}

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
    syncDockerInventory.mockResolvedValue({});
    runDocker.mockResolvedValue({ stdout: "[]", stderr: "", code: 0 });
  });

  it("does not retain environment or label secret values in the fingerprint projection", () => {
    const projection = sanitizedManifestForFingerprint({
      id: "web-1",
      name: "web",
      image: "nginx:alpine",
      state: "running",
      running: true,
      ports: [],
      networks: [],
      networkAttachments: [],
      labels: { TOKEN: "top-secret-label" },
      restartPolicy: "unless-stopped",
      env: ["PASSWORD=top-secret-env"],
      volumes: [],
      bindMounts: [],
      entrypoint: [],
      command: ["--token", "top-secret-command"],
      user: null,
      workingDir: null
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("top-secret-label");
    expect(serialized).not.toContain("top-secret-env");
    expect(serialized).not.toContain("top-secret-command");
    expect(serialized).toContain("PASSWORD");
    expect(projection).toMatchObject({ running: true });
    expect(projection).not.toHaveProperty("state");
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
      composeYaml: "services:\n  demoapp:\n    image: ghcr.io/composebastion-admin/demo-app:beta\n",
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
      if (kind === "container" && hostId === sourceHostId) {
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
            external_id: "target-1",
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
    runDocker.mockImplementation(async (hostId: string) => ({
      stdout: JSON.stringify(hostId === sourceHostId
        ? [containerInspect({
            id: "web-1",
            name: "demoapp-web-1",
            networks: { backend: { IPAddress: "172.28.0.10", Aliases: ["web"] } }
          })]
        : [containerInspect({
            id: "target-1",
            name: "existing-api",
            networks: { backend: { IPAddress: "172.28.0.10", Aliases: ["api"] } }
          })]),
      stderr: "",
      code: 0
    }));

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

  it("detects published-port conflicts from direct container inspect data", async () => {
    query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (kind !== "container") return { rows: [] };
      return hostId === baseInput.sourceHostId
        ? { rows: [{ external_id: "source-web", name: "source-web", data: {} }] }
        : { rows: [{ external_id: "target-web", name: "target-web", data: {} }] };
    });
    runDocker.mockImplementation(async (hostId: string) => ({
      stdout: JSON.stringify([containerInspect({
        id: hostId === baseInput.sourceHostId ? "source-web" : "target-web",
        name: hostId === baseInput.sourceHostId ? "source-web" : "target-web",
        ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] }
      })]),
      stderr: "",
      code: 0
    }));

    const plan = await analyzeMigrationPlan(baseInput, {
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web"],
      volumeNames: []
    });

    expect(plan.portConflicts).toEqual([expect.objectContaining({
      hostPort: "8080",
      protocol: "tcp",
      sourceContainer: "source-web"
    })]);
  });

  it("rejects reviewed plans when source or target network IPAM configuration drifts", async () => {
    const context = {
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["web-1"],
      volumeNames: []
    };
    query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (hostId === baseInput.sourceHostId && kind === "container") {
        return { rows: [{ external_id: "web-1", name: "web", data: {} }] };
      }
      if (kind === "network") {
        return {
          rows: [{
            external_id: hostId === baseInput.sourceHostId ? "source-network-id" : "target-network-id",
            name: "backend",
            data: { Name: "backend", Driver: "bridge", Scope: "local" }
          }]
        };
      }
      return { rows: [] };
    });
    let sourceSubnet = "172.28.0.0/24";
    let targetGateway = "172.28.0.1";
    runDocker.mockImplementation(async (hostId: string, command: string) => {
      if (command.startsWith("docker network inspect")) {
        return {
          stdout: JSON.stringify([{
            Id: hostId === baseInput.sourceHostId ? "source-network-id" : "target-network-id",
            Name: "backend",
            Driver: "bridge",
            Scope: "local",
            Internal: false,
            Attachable: false,
            Ingress: false,
            EnableIPv6: false,
            IPAM: {
              Driver: "default",
              Options: {},
              Config: [{
                Subnet: hostId === baseInput.sourceHostId ? sourceSubnet : "172.28.0.0/24",
                Gateway: hostId === baseInput.sourceHostId ? "172.28.0.1" : targetGateway
              }]
            },
            Labels: {},
            Options: {}
          }]),
          stderr: "",
          code: 0
        };
      }
      return {
        stdout: JSON.stringify([containerInspect({
          id: "web-1",
          name: "web",
          networks: { backend: { IPAddress: "172.28.0.10", Gateway: "172.28.0.1" } }
        })]),
        stderr: "",
        code: 0
      };
    });

    const storedPlan = await analyzeMigrationPlan(baseInput, context);
    expect(storedPlan.blockingIssues).toEqual([]);
    resolveAppContext.mockResolvedValue(context);
    const run = {
      id: "00000000-0000-4000-8000-000000000023",
      planRunId: null,
      sourceHostId: baseInput.sourceHostId,
      targetHostId: baseInput.targetHostId,
      sourceAppIdentity: baseInput.sourceAppIdentity,
      mode: "plan" as const,
      status: "completed" as const,
      recoveryPointId: null,
      plan: storedPlan,
      error: null,
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString()
    };

    sourceSubnet = "172.29.0.0/24";
    await expect(revalidateMigrationPlan(run)).rejects.toMatchObject({ code: "MIGRATION_PLAN_STALE" });

    sourceSubnet = "172.28.0.0/24";
    targetGateway = "172.28.0.254";
    await expect(revalidateMigrationPlan(run)).rejects.toMatchObject({ code: "MIGRATION_PLAN_STALE" });
  });

  it("blocks planning when a selected app network has no inspectable source definition", async () => {
    query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (hostId === baseInput.sourceHostId && kind === "container") {
        return { rows: [{ external_id: "web-1", name: "web", data: {} }] };
      }
      return { rows: [] };
    });
    runDocker.mockResolvedValue({
      stdout: JSON.stringify([containerInspect({
        id: "web-1",
        name: "web",
        networks: { backend: { IPAddress: "172.28.0.10" } }
      })]),
      stderr: "",
      code: 0
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

    expect(plan.blockingIssues).toEqual(expect.arrayContaining([
      expect.stringContaining("Source network definitions are missing for: backend")
    ]));
  });

  it("rejects a reviewed plan when target inventory changes", async () => {
    const context = {
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["web-1"],
      volumeNames: []
    };
    runDocker.mockImplementation(async (hostId: string) => ({
      stdout: JSON.stringify(hostId === baseInput.sourceHostId
        ? [containerInspect({ id: "web-1", name: "demoapp-web-1" })]
        : []),
      stderr: "",
      code: 0
    }));
    const storedPlan = await analyzeMigrationPlan(baseInput, context);
    resolveAppContext.mockResolvedValue(context);
    const run = {
      id: "00000000-0000-4000-8000-000000000020",
      planRunId: null,
      sourceHostId: baseInput.sourceHostId,
      targetHostId: baseInput.targetHostId,
      sourceAppIdentity: baseInput.sourceAppIdentity,
      mode: "plan" as const,
      status: "completed" as const,
      recoveryPointId: null,
      plan: storedPlan,
      error: null,
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString()
    };

    await expect(revalidateMigrationPlan(run)).resolves.toMatchObject({
      sourceFingerprint: storedPlan.sourceFingerprint,
      targetFingerprint: storedPlan.targetFingerprint
    });

    query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (hostId === baseInput.targetHostId && kind === "volume") {
        return { rows: [{ name: "new-target-volume", data: {} }] };
      }
      return { rows: [] };
    });

    await expect(revalidateMigrationPlan(run)).rejects.toMatchObject({
      code: "MIGRATION_PLAN_STALE",
      statusCode: 409
    });
    expect(syncDockerInventory).toHaveBeenCalledWith(baseInput.sourceHostId);
    expect(syncDockerInventory).toHaveBeenCalledWith(baseInput.targetHostId);
  });

  it("ignores volatile state text but rejects a running-to-stopped transition", async () => {
    const context = {
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: [],
      volumeNames: []
    };
    let state = "Up 1 minute";
    let running = true;
    query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (hostId === baseInput.targetHostId && kind === "container") {
        return {
          rows: [{
            external_id: "target-web-id",
            name: "target-web",
            data: { State: state, Status: state, RunningFor: state, Ports: "8080->80/tcp", Labels: {} }
          }]
        };
      }
      return { rows: [] };
    });
    runDocker.mockImplementation(async (hostId: string) => ({
      stdout: JSON.stringify(hostId === baseInput.targetHostId
        ? [{
            ...containerInspect({
              id: "target-web-id",
              name: "target-web",
              ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] }
            }),
            State: { Running: running, Status: state }
          }]
        : []),
      stderr: "",
      code: 0
    }));
    const storedPlan = await analyzeMigrationPlan(baseInput, context);
    resolveAppContext.mockResolvedValue(context);
    state = "Up 2 minutes";

    const run = {
      id: "00000000-0000-4000-8000-000000000021",
      planRunId: null,
      sourceHostId: baseInput.sourceHostId,
      targetHostId: baseInput.targetHostId,
      sourceAppIdentity: baseInput.sourceAppIdentity,
      mode: "plan",
      status: "completed",
      recoveryPointId: null,
      plan: storedPlan,
      error: null,
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString()
    } as const;

    await expect(revalidateMigrationPlan(run)).resolves.toMatchObject({
      targetFingerprint: storedPlan.targetFingerprint
    });

    running = false;
    state = "exited";
    await expect(revalidateMigrationPlan(run)).rejects.toMatchObject({
      code: "MIGRATION_PLAN_STALE",
      statusCode: 409
    });
  });

  it("rejects a reviewed plan when live environment or bind configuration drifts", async () => {
    const context = {
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["web-1"],
      volumeNames: []
    };
    query.mockImplementation(async (_sql: string, params: unknown[]) => {
      const [hostId, kind] = params as [string, string];
      if (hostId === baseInput.sourceHostId && kind === "container") {
        return { rows: [{ external_id: "web-1", name: "web", data: {} }] };
      }
      return { rows: [] };
    });
    let envValue = "PASSWORD=first-secret";
    let bindSource = "/srv/demo-v1";
    runDocker.mockImplementation(async (hostId: string) => ({
      stdout: JSON.stringify(hostId === baseInput.sourceHostId
        ? [containerInspect({
            id: "web-1",
            name: "web",
            env: [envValue],
            mounts: [{ Type: "bind", Source: bindSource, Destination: "/data", RW: true }]
          })]
        : []),
      stderr: "",
      code: 0
    }));
    const storedPlan = await analyzeMigrationPlan(baseInput, context);
    resolveAppContext.mockResolvedValue(context);
    envValue = "PASSWORD=second-secret";
    bindSource = "/srv/demo-v2";

    await expect(revalidateMigrationPlan({
      id: "00000000-0000-4000-8000-000000000022",
      planRunId: null,
      sourceHostId: baseInput.sourceHostId,
      targetHostId: baseInput.targetHostId,
      sourceAppIdentity: baseInput.sourceAppIdentity,
      mode: "plan",
      status: "completed",
      recoveryPointId: null,
      plan: storedPlan,
      error: null,
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString()
    })).rejects.toMatchObject({ code: "MIGRATION_PLAN_STALE" });
  });
});
