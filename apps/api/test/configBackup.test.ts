import {
  CONFIG_BACKUP_FORMAT_VERSION,
  type HostStats,
  type HostThresholdParams
} from "@composebastion/shared";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { decryptConfigPayload, decryptSecret, encryptConfigPayload, encryptSecret } from "../src/services/crypto.js";
import { exportConfigBackup, importConfigBackup } from "../src/services/configBackup.js";
import { evaluateHostThreshold } from "../src/services/hostAlertEvaluation.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const query = vi.fn();
const withTransaction = vi.fn();
const transactionQuery = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

function emptyConfigPayload(app: string) {
  return {
    app,
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    version: "0.9.0",
    exportedAt: "2026-06-15T00:00:00.000Z",
    hosts: [],
    composeStacks: [],
    registries: [],
    notificationChannels: [],
    alertRules: [],
    favoriteImages: [],
    githubRepositories: [],
    appSourceLinks: [],
    backupTargets: []
  };
}

describe("config backup product identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
    transactionQuery.mockReset();
    transactionQuery.mockResolvedValue({ rows: [] });
    withTransaction.mockImplementation(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
      handler({ query: transactionQuery })
    );
  });

  it("exports new config backups as ComposeBastion", async () => {
    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{ app: string; version: string }>(encrypted, "long-test-passphrase");

    expect(payload.app).toBe("ComposeBastion");
    expect(payload.version).toBe(packageJson.version);
  });

  it("rejects config backups from other apps", async () => {
    const encrypted = encryptConfigPayload(emptyConfigPayload("OtherApp"), "long-test-passphrase");

    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase"))
      .rejects.toThrow("This is not a ComposeBastion config backup");
    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase"))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("reports unreadable config backups as client errors", async () => {
    const encrypted = encryptConfigPayload(emptyConfigPayload("ComposeBastion"), "long-test-passphrase");

    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "different-passphrase"))
      .rejects.toMatchObject({
        message: "Config backup could not be decrypted. Check the passphrase and JSON file.",
        statusCode: 400
      });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("rejects unsupported config backup formats before importing", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      formatVersion: CONFIG_BACKUP_FORMAT_VERSION + 1
    }, "long-test-passphrase");

    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase"))
      .rejects.toMatchObject({
        message: `Unsupported ComposeBastion config backup format version ${CONFIG_BACKUP_FORMAT_VERSION + 1}`,
        statusCode: 400
      });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("rejects malformed config payloads before opening a transaction", async () => {
    const payload = emptyConfigPayload("ComposeBastion") as Record<string, unknown>;
    delete payload.hosts;
    const encrypted = encryptConfigPayload(payload, "long-test-passphrase");

    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase"))
      .rejects.toMatchObject({
        message: "Config backup is missing the hosts list",
        statusCode: 400
      });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("round-trips Compose settings and alert parameters without changing alert evaluation", async () => {
    const hostId = "00000000-0000-4000-8000-000000000201";
    const stackId = "00000000-0000-4000-8000-000000000202";
    const channelId = "00000000-0000-4000-8000-000000000203";
    const ruleId = "00000000-0000-4000-8000-000000000204";
    const stackSettings = {
      domains: ["app.example.test", "api.example.test"],
      exposedService: "web",
      exposedPort: 8443,
      tlsDesired: true,
      updatePolicyEnabled: true,
      updatePolicyChannel: "minor"
    } as const;
    const alertParams: HostThresholdParams = {
      comparator: "gte",
      threshold: 90,
      durationSeconds: 300,
      mount: "/data"
    };

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return {
          rows: [{
            id: hostId,
            name: "Qualification host",
            hostname: "docker.example.test",
            port: 22,
            username: "docker",
            connection_mode: "ssh",
            ssh_auth_type: "password",
            ssh_password_encrypted: encryptSecret("qualification-password"),
            docker_socket_path: "/var/run/docker.sock",
            tags: ["qualification"],
            deleted_at: null
          }]
        };
      }
      if (sql.includes("FROM compose_stacks")) {
        return {
          rows: [{
            id: stackId,
            host_id: hostId,
            name: "Client app",
            project_name: "client-app",
            compose_yaml: "services:\n  web:\n    image: nginx:alpine\n",
            env: "APP_MODE=qualification",
            status: "running",
            source_type: "ui",
            source_repository_url: null,
            source_branch: null,
            source_working_dir: null,
            source_compose_path: null,
            source_current_commit_sha: null,
            source_latest_commit_sha: null,
            deployment_source_id: null,
            domains: stackSettings.domains,
            exposed_service: stackSettings.exposedService,
            exposed_port: String(stackSettings.exposedPort),
            tls_desired: stackSettings.tlsDesired,
            update_policy_enabled: stackSettings.updatePolicyEnabled,
            update_policy_channel: stackSettings.updatePolicyChannel
          }]
        };
      }
      if (sql.includes("FROM alert_rules")) {
        return {
          rows: [{
            id: ruleId,
            name: "Data disk pressure",
            condition: "host.disk",
            host_id: hostId,
            container_id: null,
            channel_id: channelId,
            enabled: true,
            params: alertParams
          }]
        };
      }
      return { rows: [] };
    });

    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{
      composeStacks: Array<Record<string, unknown>>;
      alertRules: Array<Record<string, unknown>>;
    }>(encrypted, "long-test-passphrase");

    expect(payload.composeStacks).toHaveLength(1);
    expect(payload.composeStacks[0]).toMatchObject(stackSettings);
    expect(payload.alertRules).toHaveLength(1);
    expect(payload.alertRules[0]).toMatchObject({ id: ruleId, params: alertParams });

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const stackValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO compose_stacks")
    )?.[1] as unknown[];
    expect(stackValues.slice(15, 21)).toEqual([
      stackSettings.domains,
      stackSettings.exposedService,
      stackSettings.exposedPort,
      stackSettings.tlsDesired,
      stackSettings.updatePolicyEnabled,
      stackSettings.updatePolicyChannel
    ]);

    const ruleValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO alert_rules")
    )?.[1] as unknown[];
    expect(ruleValues[7]).toEqual(alertParams);

    const now = new Date("2026-07-30T12:00:00.000Z");
    const stats: HostStats = {
      hostId,
      collectedAt: now.toISOString(),
      cpuPercent: 12,
      load: { one: 0.5, five: 0.4, fifteen: 0.3 },
      memory: { totalBytes: 1_000, usedBytes: 400, availableBytes: 600 },
      swap: { totalBytes: 0, usedBytes: 0 },
      disks: [{ mount: "/data", totalBytes: 1_000, usedBytes: 910, usedPercent: 91 }],
      network: null,
      containers: { running: 1, total: 1 },
      uptimeSeconds: 3_600
    };
    expect(evaluateHostThreshold(
      "host.disk",
      ruleValues[7] as HostThresholdParams,
      stats,
      new Date(now.getTime() - alertParams.durationSeconds * 1_000),
      now,
      "Qualification host"
    )).toMatchObject({
      value: 91,
      overThreshold: true,
      triggered: true,
      message: "Qualification host disk /data 91% >= 90% for 5m"
    });
  });

  it("rejects invalid Compose stack and alert rule backup fields before mutation", async () => {
    const hostId = "00000000-0000-4000-8000-000000000211";
    const baseStack = {
      id: "00000000-0000-4000-8000-000000000212",
      hostId,
      name: "Client app",
      projectName: "client-app",
      composeYaml: "services: {}"
    };
    const invalidPayloads = [
      {
        composeStacks: [{ ...baseStack, projectName: "Invalid Project Name" }]
      },
      {
        composeStacks: [{ ...baseStack, exposedPort: 0 }]
      },
      {
        composeStacks: [{ ...baseStack, domains: [""] }]
      },
      {
        alertRules: [{
          id: "00000000-0000-4000-8000-000000000213",
          name: "Invalid CPU threshold",
          condition: "host.cpu",
          hostId,
          channelId: "00000000-0000-4000-8000-000000000214",
          enabled: true,
          params: { comparator: "gte", threshold: 101, durationSeconds: 300 }
        }]
      }
    ];

    for (const invalid of invalidPayloads) {
      withTransaction.mockClear();
      const encrypted = encryptConfigPayload({
        ...emptyConfigPayload("ComposeBastion"),
        ...invalid
      }, "long-test-passphrase");

      await expect(importConfigBackup(
        encrypted as unknown as Record<string, unknown>,
        "long-test-passphrase"
      )).rejects.toMatchObject({ statusCode: 400 });
      expect(withTransaction).not.toHaveBeenCalled();
    }
  });

  it("omits deleted hosts and host-bound records from exported configuration", async () => {
    const activeHostId = "00000000-0000-4000-8000-000000000221";
    const deletedHostId = "00000000-0000-4000-8000-000000000222";
    const hostRow = (id: string, name: string, deletedAt: string | null) => ({
      id,
      name,
      hostname: `${name.toLowerCase().replaceAll(" ", "-")}.example.test`,
      port: 22,
      username: "docker",
      connection_mode: "ssh",
      ssh_auth_type: "password",
      ssh_password_encrypted: encryptSecret(`${name}-password`),
      docker_socket_path: "/var/run/docker.sock",
      tags: [],
      deleted_at: deletedAt
    });
    const stackRow = (id: string, hostId: string) => ({
      id,
      host_id: hostId,
      name: `Stack ${id.slice(-1)}`,
      project_name: `stack-${id.slice(-1)}`,
      compose_yaml: "services: {}",
      env: "",
      status: "created",
      source_type: "ui",
      source_repository_url: null
    });
    const alertRow = (id: string, hostId: string) => ({
      id,
      name: `Alert ${id.slice(-1)}`,
      condition: "host.offline",
      host_id: hostId,
      container_id: null,
      channel_id: "00000000-0000-4000-8000-000000000223",
      enabled: true,
      params: null
    });
    const appLinkRow = (id: string, hostId: string) => ({
      id,
      host_id: hostId,
      container_external_id: `container-${id.slice(-1)}`,
      source_type: "image",
      name: `App ${id.slice(-1)}`,
      repository_url: null,
      image_reference: "nginx:alpine"
    });

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return {
          rows: [
            hostRow(activeHostId, "Active host", null),
            hostRow(deletedHostId, "Deleted host", "2026-07-29T12:00:00.000Z")
          ]
        };
      }
      if (sql.includes("FROM compose_stacks")) {
        return {
          rows: [
            stackRow("00000000-0000-4000-8000-000000000224", activeHostId),
            stackRow("00000000-0000-4000-8000-000000000225", deletedHostId)
          ]
        };
      }
      if (sql.includes("FROM alert_rules")) {
        return {
          rows: [
            alertRow("00000000-0000-4000-8000-000000000226", activeHostId),
            alertRow("00000000-0000-4000-8000-000000000227", deletedHostId)
          ]
        };
      }
      if (sql.includes("FROM app_source_links")) {
        return {
          rows: [
            appLinkRow("00000000-0000-4000-8000-000000000228", activeHostId),
            appLinkRow("00000000-0000-4000-8000-000000000229", deletedHostId)
          ]
        };
      }
      if (sql.includes("FROM github_repositories")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000230",
            name: "Reusable GitHub source",
            repository_url: "https://github.com/example/app",
            owner: "example",
            repo: "app",
            branch: "main",
            compose_path: "compose.yaml",
            project_name: "example-app",
            env: "",
            default_host_id: deletedHostId
          }]
        };
      }
      if (sql.includes("FROM deployment_sources")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000231",
            source_type: "image",
            name: "Reusable image source",
            source_locator: "nginx:alpine",
            project_name: "nginx",
            default_host_id: deletedHostId
          }]
        };
      }
      return { rows: [] };
    });

    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{
      hosts: Array<Record<string, unknown>>;
      composeStacks: Array<Record<string, unknown>>;
      alertRules: Array<Record<string, unknown>>;
      appSourceLinks: Array<Record<string, unknown>>;
      githubRepositories: Array<Record<string, unknown>>;
      deploymentSources: Array<Record<string, unknown>>;
    }>(encrypted, "long-test-passphrase");

    expect(query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes("FROM docker_hosts"))?.[0])
      .toContain("WHERE deleted_at IS NULL");
    expect(payload.hosts.map((row) => row.id)).toEqual([activeHostId]);
    expect(payload.composeStacks.map((row) => row.hostId)).toEqual([activeHostId]);
    expect(payload.alertRules.map((row) => row.hostId)).toEqual([activeHostId]);
    expect(payload.appSourceLinks.map((row) => row.hostId)).toEqual([activeHostId]);
    expect(payload.githubRepositories[0]?.defaultHostId).toBeNull();
    expect(payload.deploymentSources[0]?.defaultHostId).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(deletedHostId);
  });

  it("normalizes imported registries before an insert or conflict update", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      registries: [{
        id: "00000000-0000-4000-8000-000000000099",
        name: "Local registry",
        url: "registry.internal:5000",
        username: "operator",
        password: "registry-secret",
        insecure: true
      }]
    }, "long-test-passphrase");

    await importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase");

    const registryQuery = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO registries")
    );
    expect(registryQuery).toBeTruthy();
    const values = registryQuery?.[1] as unknown[];
    expect(values.slice(1, 4)).toEqual(["Local registry", "http://registry.internal:5000", "operator"]);
    expect(values[5]).toBe(true);
  });

  it("rejects an unsafe imported registry before opening a transaction", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      registries: [{
        id: "00000000-0000-4000-8000-000000000099",
        name: "Unsafe registry",
        url: "https://user:secret@registry.example.com",
        username: "operator",
        password: "registry-secret",
        insecure: false
      }]
    }, "long-test-passphrase");

    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase"))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("validates imported host credentials before opening a transaction", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [{
        id: "00000000-0000-4000-8000-000000000077",
        name: "Unsafe agent",
        hostname: "agent.example.test",
        port: 22,
        username: "docker",
        connectionMode: "agent",
        sshAuthType: "key",
        agentUrl: "https://agent-user:agent-secret@agent.example.test",
        dockerSocketPath: "/var/run/docker.sock",
        tags: [],
        secrets: { agentToken: "separate-agent-token" }
      }]
    }, "long-test-passphrase");

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    )).rejects.toMatchObject({
      message: expect.stringContaining("Agent URL must not contain embedded credentials"),
      statusCode: 400
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("rejects every persisted Git or Compose URL surface before opening a transaction", async () => {
    const urlSecret = "config-url-secret";
    const unsafePayloads = [
      {
        githubRepositories: [{
          id: "00000000-0000-4000-8000-000000000101",
          name: "Unsafe GitHub URL",
          repositoryUrl: `https://user:${urlSecret}@github.com/example/app`,
          projectName: "unsafe"
        }]
      },
      {
        githubRepositories: [{
          id: "00000000-0000-4000-8000-000000000102",
          name: "Unsafe clone URL",
          repositoryUrl: "https://github.com/example/app",
          projectName: "unsafe",
          hostCloneUrl: `ssh://git:${urlSecret}@github.com/example/app.git`
        }]
      },
      {
        deploymentSources: [{
          id: "00000000-0000-4000-8000-000000000103",
          sourceType: "git",
          name: "Unsafe Git source",
          sourceLocator: `https://git.example.test/team/app.git?token=${urlSecret}`,
          projectName: "unsafe"
        }]
      },
      {
        deploymentSources: [{
          id: "00000000-0000-4000-8000-000000000104",
          sourceType: "compose_url",
          name: "Unsafe Compose source",
          sourceLocator: `https://compose.example.test/compose.yaml#${urlSecret}`,
          projectName: "unsafe"
        }]
      },
      {
        composeStacks: [{
          id: "00000000-0000-4000-8000-000000000105",
          hostId: "00000000-0000-4000-8000-000000000001",
          name: "Unsafe stack",
          projectName: "unsafe",
          composeYaml: "services: {}",
          sourceRepositoryUrl: `git://git:${urlSecret}@git.example.test/team/app.git`
        }]
      },
      {
        appSourceLinks: [{
          id: "00000000-0000-4000-8000-000000000106",
          hostId: "00000000-0000-4000-8000-000000000001",
          containerExternalId: "unsafe-app",
          sourceType: "git",
          name: "Unsafe app link",
          repositoryUrl: `https://git.example.test/team/app.git?token=${urlSecret}`,
          workingDir: "/srv/unsafe",
          composePath: "compose.yaml"
        }]
      }
    ];

    for (const unsafe of unsafePayloads) {
      withTransaction.mockClear();
      const encrypted = encryptConfigPayload({
        ...emptyConfigPayload("ComposeBastion"),
        ...unsafe
      }, "long-test-passphrase");
      let caught: unknown;
      try {
        await importConfigBackup(
          encrypted as unknown as Record<string, unknown>,
          "long-test-passphrase"
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ statusCode: 400 });
      expect(caught instanceof Error ? caught.message : String(caught)).not.toContain(urlSecret);
      expect(withTransaction).not.toHaveBeenCalled();
    }
  });

  it("canonicalizes safe imported Git URLs before persistence", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      githubRepositories: [{
        id: "00000000-0000-4000-8000-000000000111",
        name: "Tracked repository",
        repositoryUrl: "https://www.github.com/Owner/App.git/",
        projectName: "tracked",
        hostCloneUrl: "ssh://git@Git.Example.Test/Team/App.git/"
      }],
      deploymentSources: [{
        id: "00000000-0000-4000-8000-000000000112",
        sourceType: "git",
        name: "Library source",
        sourceLocator: "git@Git.Example.Test:Team/App.git/",
        projectName: "library"
      }],
      composeStacks: [{
        id: "00000000-0000-4000-8000-000000000113",
        hostId: "00000000-0000-4000-8000-000000000001",
        name: "Tracked stack",
        projectName: "tracked-stack",
        composeYaml: "services: {}",
        sourceRepositoryUrl: "https://Git.Example.Test/Team/App.git/"
      }],
      appSourceLinks: [{
        id: "00000000-0000-4000-8000-000000000114",
        hostId: "00000000-0000-4000-8000-000000000001",
        containerExternalId: "tracked-app",
        sourceType: "git",
        name: "Tracked app",
        repositoryUrl: "https://Git.Example.Test/Team/App.git/",
        workingDir: "/srv/tracked",
        composePath: "compose.yaml"
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const githubValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO github_repositories")
    )?.[1] as unknown[];
    expect(githubValues[2]).toBe("https://github.com/owner/app");
    expect(githubValues[3]).toBe("owner");
    expect(githubValues[4]).toBe("app");
    expect(githubValues[10]).toBe("ssh://git@git.example.test/Team/App.git");

    const sourceValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO deployment_sources")
    )?.[1] as unknown[];
    expect(sourceValues[3]).toBe("git@git.example.test:Team/App.git");

    const stackValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO compose_stacks")
    )?.[1] as unknown[];
    expect(stackValues[8]).toBe("https://git.example.test/Team/App.git");

    const linkValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO app_source_links")
    )?.[1] as unknown[];
    expect(linkValues[5]).toBe("https://git.example.test/Team/App.git");
  });

  it("rejects an invalid imported host id before opening a transaction", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [{
        id: "not-a-uuid",
        name: "Invalid id host",
        hostname: "invalid-id.example.test",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        dockerSocketPath: "/var/run/docker.sock",
        tags: [],
        secrets: { sshPassword: "password" }
      }]
    }, "long-test-passphrase");

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    )).rejects.toMatchObject({
      message: expect.stringContaining("Config backup host 1 is invalid"),
      statusCode: 400
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("canonicalizes uppercase imported host ids while retaining dependent UUID references", async () => {
    const uppercaseHostId = "A0000000-0000-4000-8000-000000000125";
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [{
        id: uppercaseHostId,
        name: "Uppercase id host",
        hostname: "uppercase-id.example.test",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        dockerSocketPath: "/var/run/docker.sock",
        tags: [],
        secrets: { sshPassword: "password" }
      }],
      composeStacks: [{
        id: "B0000000-0000-4000-8000-000000000126",
        hostId: uppercaseHostId,
        name: "Uppercase host dependency",
        projectName: "uppercase-host-dependency",
        composeYaml: "services: {}"
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const hostValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO docker_hosts")
    )?.[1] as unknown[];
    const stackValues = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO compose_stacks")
    )?.[1] as unknown[];
    expect(hostValues[0]).toBe(uppercaseHostId.toLowerCase());
    expect(String(stackValues[1]).toLowerCase()).toBe(uppercaseHostId.toLowerCase());
  });

  it("rejects exact and case-equivalent duplicate imported host ids before a transaction", async () => {
    const canonicalId = "a0000000-0000-4000-8000-000000000127";
    for (const duplicateId of [canonicalId, canonicalId.toUpperCase()]) {
      withTransaction.mockClear();
      const encrypted = encryptConfigPayload({
        ...emptyConfigPayload("ComposeBastion"),
        hosts: [
          {
            id: canonicalId,
            name: "First id owner",
            hostname: "first-id.example.test",
            port: 22,
            username: "docker",
            connectionMode: "ssh",
            sshAuthType: "password",
            dockerSocketPath: "/var/run/docker.sock",
            tags: [],
            secrets: { sshPassword: "password" }
          },
          {
            id: duplicateId,
            name: "Second id owner",
            hostname: "second-id.example.test",
            port: 2222,
            username: "operator",
            connectionMode: "ssh",
            sshAuthType: "password",
            dockerSocketPath: "/var/run/docker.sock",
            tags: [],
            secrets: { sshPassword: "password" }
          }
        ]
      }, "long-test-passphrase");

      await expect(importConfigBackup(
        encrypted as unknown as Record<string, unknown>,
        "long-test-passphrase"
      )).rejects.toMatchObject({
        message: "Config backup contains duplicate host ids",
        statusCode: 400
      });
      expect(withTransaction).not.toHaveBeenCalled();
    }
  });

  it("rejects duplicate imported hosts before opening a transaction", async () => {
    const host = {
      name: "Duplicate host",
      hostname: "docker.example.test",
      port: 22,
      username: "docker",
      connectionMode: "ssh",
      sshAuthType: "password",
      dockerSocketPath: "/var/run/docker.sock",
      tags: [],
      secrets: { sshPassword: "password" }
    };
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [
        { ...host, id: "00000000-0000-4000-8000-000000000121" },
        {
          ...host,
          id: "00000000-0000-4000-8000-000000000122",
          name: " duplicate HOST "
        }
      ]
    }, "long-test-passphrase");

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    )).rejects.toMatchObject({
      message: "Config backup contains duplicate host names or connection identities",
      statusCode: 400
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("takes the shared host lock and rolls back active-host conflicts before mutation", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts") && sql.includes("deleted_at IS NULL")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000199",
            name: "Existing host",
            hostname: "DOCKER.EXAMPLE.TEST",
            port: 22,
            username: "docker"
          }]
        };
      }
      return { rows: [] };
    });
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [{
        id: "00000000-0000-4000-8000-000000000123",
        name: "Imported host",
        hostname: "docker.example.test",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        dockerSocketPath: "/var/run/docker.sock",
        tags: [],
        secrets: { sshPassword: "password" }
      }]
    }, "long-test-passphrase");

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    )).rejects.toMatchObject({ statusCode: 409 });
    expect(transactionQuery.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
    expect(transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && /\b(?:INSERT|UPDATE|DELETE)\b/.test(sql)
    )).toBe(false);
  });

  it("reactivates imported host ids with a fresh health state", async () => {
    const hostId = "00000000-0000-4000-8000-000000000124";
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [{
        id: hostId,
        name: "Restored host",
        hostname: "restored.example.test",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        dockerSocketPath: "/var/run/docker.sock",
        tags: ["restored"],
        secrets: { sshPassword: "imported-password" }
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const hostUpsert = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO docker_hosts")
    );
    expect(hostUpsert?.[1]?.[0]).toBe(hostId);
    const sql = String(hostUpsert?.[0]);
    expect(sql).toContain("last_status = 'unknown'");
    for (const field of [
      "last_seen_at",
      "last_error",
      "docker_version",
      "compose_version",
      "agent_version",
      "deleted_at"
    ]) {
      expect(sql).toContain(`${field} = NULL`);
    }
  });

  it("imports only a fully usable active host credential set", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      hosts: [{
        id: "00000000-0000-4000-8000-000000000078",
        name: "SSH host",
        hostname: "ssh.example.test",
        port: 22,
        username: "docker",
        connectionMode: "ssh",
        sshAuthType: "password",
        agentUrl: "https://inactive-agent.example.test",
        dockerSocketPath: "/var/run/docker.sock",
        tags: ["production"],
        secrets: {
          sshPrivateKey: "inactive-private-key",
          sshKeyPassphrase: "inactive-passphrase",
          sshPassword: "imported-password",
          agentToken: "inactive-agent-token"
        }
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const hostQuery = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO docker_hosts")
    );
    expect(hostQuery).toBeTruthy();
    const values = hostQuery?.[1] as unknown[];
    expect(values.slice(1, 7)).toEqual([
      "SSH host",
      "ssh.example.test",
      22,
      "docker",
      "ssh",
      "password"
    ]);
    expect(values[7]).toBeNull();
    expect(values[8]).toBeNull();
    expect(decryptSecret(values[9] as string)).toBe("imported-password");
    expect(values[10]).toBeNull();
    expect(values[11]).toBeNull();
    const lockIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === "string" && sql.includes("pg_advisory_xact_lock")
    );
    const hostInsertIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO docker_hosts")
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(hostInsertIndex).toBeGreaterThan(lockIndex);
  });

  it("exports supported SMB backup target settings without an imported config", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          name: "NAS",
          kind: "rclone",
          enabled: true,
          config: {
            provider: "smb",
            remoteName: "composebastion",
            remotePath: "Backups/docker",
            smb: {
              server: "nas.internal",
              share: "Backups",
              subPath: "docker",
              username: "backup"
            }
          },
          access_key_id: null,
          secret_access_key_encrypted: null,
          provider: "smb",
          remote_path: "Backups/docker",
          local_cache_policy: "remote_only",
          generic_config_encrypted: null,
          generic_credentials_encrypted: encryptSecret(JSON.stringify({ password: "plain-password" }))
        }]
      });

    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{ backupTargets: Array<Record<string, unknown>> }>(encrypted, "long-test-passphrase");

    expect(payload.backupTargets[0]).toMatchObject({
      kind: "rclone",
      provider: "smb",
      remotePath: "Backups/docker",
      localCachePolicy: "remote_only",
      rcloneConfig: null,
      rcloneCredentials: { password: "plain-password" }
    });
    expect(payload.backupTargets[0]?.config).toMatchObject({
      provider: "smb",
      remoteName: "composebastion",
      remotePath: "Backups/docker",
      smb: {
        server: "nas.internal",
        share: "Backups",
        subPath: "docker",
        username: "backup"
      }
    });
  });

  it("exports legacy local targets in the canonical manager-directory form", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000021",
          name: "Legacy local",
          kind: "local",
          enabled: true,
          config: { basePath: "/legacy/custom/path" },
          local_cache_policy: "remote_only"
        }]
      });

    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{ backupTargets: Array<Record<string, unknown>> }>(
      encrypted,
      "long-test-passphrase"
    );

    expect(payload.backupTargets[0]).toMatchObject({
      kind: "local",
      config: {},
      localCachePolicy: "keep"
    });
    expect(JSON.stringify(payload.backupTargets[0])).not.toContain("/legacy/custom/path");
  });

  it("exports and imports GitHub host clone defaults", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000123",
          name: "Private App",
          repository_url: "https://github.com/owner/private-app",
          owner: "owner",
          repo: "private-app",
          branch: "main",
          compose_path: "docker-compose.yml",
          project_name: "private-app",
          env: "",
          default_host_id: null,
          host_clone_url: "git@github-private-app:owner/private-app.git",
          host_clone_directory: "/srv/apps/private-app",
          github_token_encrypted: null
        }]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{ githubRepositories: Array<Record<string, unknown>> }>(encrypted, "long-test-passphrase");

    expect(payload.githubRepositories[0]).toMatchObject({
      hostCloneUrl: "git@github-private-app:owner/private-app.git",
      hostCloneDirectory: "/srv/apps/private-app"
    });

    await importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase");
    const githubRepoQuery = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO github_repositories")
    );
    expect(githubRepoQuery).toBeTruthy();
    const values = githubRepoQuery?.[1] as unknown[];
    expect(values.slice(10, 12)).toEqual(["git@github-private-app:owner/private-app.git", "/srv/apps/private-app"]);
  });

  it("imports canonical SMB target fields while keeping generated config authoritative", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "NAS",
        kind: "rclone",
        enabled: true,
        config: {
          provider: "smb",
          remoteName: "composebastion",
          remotePath: "Backups/docker",
          smb: {
            server: "nas.internal",
            share: "Backups",
            subPath: "docker",
            username: "backup"
          }
        },
        provider: "smb",
        remotePath: "Backups/docker",
        localCachePolicy: "remote_only",
        rcloneConfig: null,
        rcloneCredentials: { password: "plain-password" }
      }]
    }, "long-test-passphrase");

    await importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase");

    const backupTargetQuery = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO backup_targets")
    );
    expect(backupTargetQuery).toBeTruthy();
    const values = backupTargetQuery?.[1] as unknown[];
    expect(values.slice(7, 10)).toEqual(["smb", "Backups/docker", "remote_only"]);
    expect(values[4]).toMatchObject({
      provider: "smb",
      remoteName: "composebastion",
      remotePath: "Backups/docker",
      smb: {
        server: "nas.internal",
        share: "Backups",
        subPath: "docker",
        username: "backup"
      }
    });
    expect(values[10]).toBeNull();
    expect(JSON.parse(decryptSecret(values[11] as string))).toEqual({ password: "plain-password" });
  });

  it("canonicalizes a legacy local target during config import", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id: "00000000-0000-4000-8000-000000000022",
        name: "Legacy local",
        kind: "local",
        enabled: true,
        config: { basePath: "/legacy/custom/path" },
        localCachePolicy: "remote_only"
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const backupTargetQuery = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO backup_targets")
    );
    const values = backupTargetQuery?.[1] as unknown[];
    expect(values[4]).toEqual({});
    expect(values[9]).toBe("keep");
  });

  it("refuses to replace the storage identity of a referenced target during config import", async () => {
    const id = "00000000-0000-4000-8000-000000000023";
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM backup_targets") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id,
            kind: "s3",
            config: {
              endpoint: "https://s3.example.test",
              bucket: "recovery",
              prefix: "production",
              forcePathStyle: true
            },
            provider: null,
            remote_path: null,
            generic_config_encrypted: null
          }]
        };
      }
      if (sql.includes("SELECT count(*) FROM backups")) {
        return {
          rows: [{
            backups: 0,
            backup_schedules: 0,
            recovery_points: 0,
            recovery_artifacts: 2,
            recovery_schedules: 0
          }]
        };
      }
      return { rows: [] };
    });
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id,
        name: "Object storage",
        kind: "s3",
        enabled: true,
        config: {
          endpoint: "https://replacement.example.test",
          bucket: "recovery",
          prefix: "production",
          forcePathStyle: true
        },
        accessKeyId: "new-access-key",
        secretAccessKey: "new-secret-key"
      }]
    }, "long-test-passphrase");

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    )).rejects.toMatchObject({
      statusCode: 409,
      referenceCounts: expect.objectContaining({ recoveryArtifacts: 2 })
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO backup_targets")
    )).toBe(false);
  });

  it("allows imported credential rotation for the same identity and resets stale health", async () => {
    const id = "00000000-0000-4000-8000-000000000024";
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM backup_targets") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id,
            kind: "s3",
            config: {
              endpoint: "https://s3.example.test",
              bucket: "recovery",
              prefix: "production",
              forcePathStyle: true
            },
            provider: null,
            remote_path: null,
            generic_config_encrypted: null
          }]
        };
      }
      return { rows: [] };
    });
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id,
        name: "Object storage",
        kind: "s3",
        enabled: true,
        config: {
          endpoint: "https://s3.example.test",
          bucket: "recovery",
          prefix: "production",
          forcePathStyle: true
        },
        accessKeyId: "rotated-access-key",
        secretAccessKey: "rotated-secret-key"
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const upsert = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO backup_targets")
    );
    expect(upsert?.[0]).toContain("health_status = 'unknown'");
    expect(upsert?.[0]).toContain("health_checked_at = NULL");
    expect(upsert?.[0]).toContain("health_error = NULL");
    expect(transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);
  });

  it("rejects a link-local S3 backup target before opening a transaction when private endpoints are blocked", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id: "00000000-0000-4000-8000-000000000002",
        name: "Unsafe object storage",
        kind: "s3",
        enabled: true,
        config: {
          endpoint: "http://169.254.169.254:9000",
          bucket: "composebastion",
          pathStyle: true
        },
        accessKeyId: "access-key",
        secretAccessKey: "secret-key"
      }]
    }, "long-test-passphrase");
    const previousPolicy = env.BLOCK_PRIVATE_S3_ENDPOINTS;
    env.BLOCK_PRIVATE_S3_ENDPOINTS = true;

    try {
      await expect(importConfigBackup(
        encrypted as unknown as Record<string, unknown>,
        "long-test-passphrase"
      )).rejects.toMatchObject({
        message: expect.stringContaining("private network address"),
        statusCode: 400
      });
      expect(withTransaction).not.toHaveBeenCalled();
    } finally {
      env.BLOCK_PRIVATE_S3_ENDPOINTS = previousPolicy;
    }
  });

  it("rejects unsafe S3 endpoint URL components before opening a transaction", async () => {
    for (const endpoint of [
      "ftp://s3.example.test",
      "file:///tmp/s3",
      "https://user:password@s3.example.test",
      "https://s3.example.test?token=secret",
      "https://s3.example.test#private"
    ]) {
      withTransaction.mockClear();
      const encrypted = encryptConfigPayload({
        ...emptyConfigPayload("ComposeBastion"),
        backupTargets: [{
          id: "00000000-0000-4000-8000-000000000004",
          name: "Unsafe object storage",
          kind: "s3",
          enabled: true,
          config: {
            endpoint,
            bucket: "composebastion",
            pathStyle: true
          },
          accessKeyId: "access-key",
          secretAccessKey: "secret-key"
        }]
      }, "long-test-passphrase");

      await expect(importConfigBackup(
        encrypted as unknown as Record<string, unknown>,
        "long-test-passphrase"
      )).rejects.toMatchObject({ statusCode: 400 });
      expect(withTransaction).not.toHaveBeenCalled();
    }
  });

  it("normalizes and encrypts valid imported S3 backup target fields", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id: "00000000-0000-4000-8000-000000000003",
        name: "Object storage",
        kind: "s3",
        enabled: true,
        config: {
          endpoint: "https://S3.Example.Test:443/storage/",
          bucket: "composebastion",
          pathStyle: true
        },
        accessKeyId: "access-key",
        secretAccessKey: "secret-key"
      }]
    }, "long-test-passphrase");

    await importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      "long-test-passphrase"
    );

    const backupTargetQuery = transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO backup_targets")
    );
    expect(backupTargetQuery).toBeTruthy();
    const values = backupTargetQuery?.[1] as unknown[];
    expect(values.slice(0, 6)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "Object storage",
      "s3",
      true,
      {
        endpoint: "https://s3.example.test/storage",
        bucket: "composebastion",
        region: null,
        prefix: null,
        forcePathStyle: true
      },
      "access-key"
    ]);
    expect(values[6]).not.toBe("secret-key");
    expect(decryptSecret(values[6] as string)).toBe("secret-key");
  });
});
