import { CONFIG_BACKUP_FORMAT_VERSION } from "@composebastion/shared";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptConfigPayload, decryptSecret, encryptConfigPayload, encryptSecret } from "../src/services/crypto.js";
import { exportConfigBackup, importConfigBackup } from "../src/services/configBackup.js";

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

  it("exports rclone backup target secrets", async () => {
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
          config: { provider: "smb", remoteName: "composebastion", remotePath: "Backups/docker" },
          access_key_id: null,
          secret_access_key_encrypted: null,
          provider: "smb",
          remote_path: "Backups/docker",
          local_cache_policy: "remote_only",
          generic_config_encrypted: encryptSecret("[nas]\ntype = smb\n"),
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
      rcloneConfig: "[nas]\ntype = smb\n",
      rcloneCredentials: { password: "plain-password" }
    });
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

  it("imports backup target rclone fields", async () => {
    const encrypted = encryptConfigPayload({
      ...emptyConfigPayload("ComposeBastion"),
      backupTargets: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "NAS",
        kind: "rclone",
        enabled: true,
        config: { provider: "smb", remoteName: "composebastion", remotePath: "Backups/docker" },
        provider: "smb",
        remotePath: "Backups/docker",
        localCachePolicy: "remote_only",
        rcloneConfig: "[nas]\ntype = smb\n",
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
    expect(decryptSecret(values[10] as string)).toBe("[nas]\ntype = smb\n");
    expect(JSON.parse(decryptSecret(values[11] as string))).toEqual({ password: "plain-password" });
  });
});
