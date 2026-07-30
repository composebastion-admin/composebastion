import { randomUUID } from "node:crypto";
import { CONFIG_BACKUP_FORMAT_VERSION } from "@composebastion/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { importConfigBackup } from "../../src/services/configBackup.js";
import { decryptSecret, encryptConfigPayload } from "../../src/services/crypto.js";
import { listHosts } from "../../src/services/hosts.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const passphrase = "def-012-integration-passphrase";

function configPayload(overrides: Record<string, unknown>) {
  return {
    app: "ComposeBastion",
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    version: "1.2.0-beta.1",
    exportedAt: "2026-07-30T12:00:00.000Z",
    hosts: [],
    composeStacks: [],
    registries: [],
    notificationChannels: [],
    alertRules: [],
    favoriteImages: [],
    githubRepositories: [],
    deploymentSources: [],
    appSourceLinks: [],
    backupTargets: [],
    ...overrides
  };
}

function importedPasswordHost(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "Imported active host",
    hostname: "imported.example.test",
    port: 22,
    username: "docker",
    connectionMode: "ssh",
    sshAuthType: "password",
    dockerSocketPath: "/var/run/docker.sock",
    tags: ["imported"],
    secrets: { sshPassword: "new-imported-password" },
    ...overrides
  };
}

describe.skipIf(!integrationEnabled)("configuration backup host reactivation integration", () => {
  const hostIds = new Set<string>();
  const favoriteImageIds = new Set<string>();

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    if (favoriteImageIds.size) {
      await pool.query(
        "DELETE FROM favorite_images WHERE id = ANY($1::uuid[])",
        [[...favoriteImageIds]]
      );
      favoriteImageIds.clear();
    }
    if (hostIds.size) {
      await pool.query(
        "DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])",
        [[...hostIds]]
      );
      hostIds.clear();
    }
  });

  it("reactivates a same-id deleted host, resets stale health, and exposes imported dependents", async () => {
    const hostId = randomUUID();
    const importedHostId = hostId.toUpperCase();
    const stackId = randomUUID();
    hostIds.add(hostId);
    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, port, username, connection_mode, ssh_auth_type,
         ssh_password_encrypted, docker_socket_path, tags, last_status,
         last_seen_at, last_error, docker_version, compose_version, agent_version,
         deleted_at
       )
       VALUES (
         $1, 'Deleted old host', 'old.example.test', 2222, 'old-user', 'ssh', 'password',
         'obsolete-ciphertext', '/old/docker.sock', ARRAY['old'], 'offline',
         '2026-07-29T10:00:00.000Z', 'stale connection error', '28.0.0', '2.30.0', '1.0.0',
         '2026-07-29T11:00:00.000Z'
       )`,
      [hostId]
    );

    const encrypted = encryptConfigPayload(configPayload({
      hosts: [importedPasswordHost(importedHostId)],
      composeStacks: [{
        id: stackId,
        hostId: importedHostId,
        name: "Imported dependent stack",
        projectName: `def012-${stackId.slice(0, 8)}`,
        composeYaml: "services:\n  app:\n    image: nginx:alpine\n",
        env: "MODE=qualification",
        status: "created"
      }]
    }), passphrase);

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      passphrase
    )).resolves.toMatchObject({
      imported: {
        hosts: 1,
        composeStacks: 1
      }
    });

    const persisted = await pool.query(
      `SELECT id, name, hostname, port, username, tags, ssh_password_encrypted,
              last_status, last_seen_at, last_error, docker_version,
              compose_version, agent_version, deleted_at
       FROM docker_hosts
       WHERE id = $1`,
      [hostId]
    );
    expect(persisted.rows[0]).toMatchObject({
      id: hostId,
      name: "Imported active host",
      hostname: "imported.example.test",
      port: 22,
      username: "docker",
      tags: ["imported"],
      last_status: "unknown",
      last_seen_at: null,
      last_error: null,
      docker_version: null,
      compose_version: null,
      agent_version: null,
      deleted_at: null
    });
    expect(decryptSecret(persisted.rows[0]?.ssh_password_encrypted)).toBe(
      "new-imported-password"
    );

    const visibleHosts = await listHosts();
    expect(visibleHosts.find((host) => host.id === hostId)).toMatchObject({
      name: "Imported active host",
      lastStatus: "unknown"
    });
    const visibleStack = await pool.query(
      `SELECT stack.id, stack.name, stack.status
       FROM compose_stacks AS stack
       JOIN docker_hosts AS host ON host.id = stack.host_id
       WHERE stack.id = $1 AND host.deleted_at IS NULL`,
      [stackId]
    );
    expect(visibleStack.rows).toEqual([{
      id: stackId,
      name: "Imported dependent stack",
      status: "created"
    }]);
  });

  it("rejects a different active normalized identity without mutating the deleted row", async () => {
    const deletedHostId = randomUUID();
    const conflictingHostId = randomUUID();
    const favoriteImageId = randomUUID();
    hostIds.add(deletedHostId);
    hostIds.add(conflictingHostId);
    favoriteImageIds.add(favoriteImageId);

    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, port, username, connection_mode, ssh_auth_type,
         ssh_password_encrypted, docker_socket_path, tags, last_status,
         last_error, docker_version, compose_version, deleted_at
       )
       VALUES
         ($1, 'Deleted import target', 'old-target.example.test', 22, 'docker', 'ssh', 'password',
          'deleted-ciphertext', '/var/run/docker.sock', ARRAY['preserve'], 'offline',
          'preserve this error', '27.0.0', '2.20.0', '2026-07-29T11:00:00.000Z'),
         ($2, 'Active conflict', ' CONFLICT.EXAMPLE.TEST ', 2022, 'docker', 'ssh', 'password',
          'active-ciphertext', '/var/run/docker.sock', ARRAY[]::text[], 'online',
          NULL, '29.0.0', '2.40.0', NULL)`,
      [deletedHostId, conflictingHostId]
    );

    const encrypted = encryptConfigPayload(configPayload({
      hosts: [importedPasswordHost(deletedHostId, {
        name: "Imported replacement",
        hostname: "conflict.example.test",
        port: 2022
      })],
      favoriteImages: [{
        id: favoriteImageId,
        image: `def012/image-${favoriteImageId}:latest`,
        name: "Must roll back",
        notes: ""
      }]
    }), passphrase);

    await expect(importConfigBackup(
      encrypted as unknown as Record<string, unknown>,
      passphrase
    )).rejects.toMatchObject({
      message: "A host with this name or connection already exists",
      statusCode: 409
    });

    const preserved = await pool.query(
      `SELECT name, hostname, port, tags, last_status, last_error,
              docker_version, compose_version, deleted_at
       FROM docker_hosts
       WHERE id = $1`,
      [deletedHostId]
    );
    expect(preserved.rows[0]).toMatchObject({
      name: "Deleted import target",
      hostname: "old-target.example.test",
      port: 22,
      tags: ["preserve"],
      last_status: "offline",
      last_error: "preserve this error",
      docker_version: "27.0.0",
      compose_version: "2.20.0"
    });
    expect(preserved.rows[0]?.deleted_at).not.toBeNull();
    await expect(pool.query(
      "SELECT id FROM favorite_images WHERE id = $1",
      [favoriteImageId]
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
