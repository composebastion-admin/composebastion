import { randomUUID } from "node:crypto";
import { CONFIG_BACKUP_FORMAT_VERSION } from "@composebastion/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { importConfigBackup } from "../../src/services/configBackup.js";
import { encryptConfigPayload } from "../../src/services/crypto.js";
import { deleteRegistry } from "../../src/services/registries.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const passphrase = "mutation-guard-integration-passphrase";

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

describe.skipIf(!integrationEnabled)("live dependency mutation guards integration", () => {
  const hostIds = new Set<string>();
  const repositoryIds = new Set<string>();
  const stackIds = new Set<string>();
  const registryIds = new Set<string>();
  const jobIds = new Set<string>();

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    if (jobIds.size) {
      await pool.query("DELETE FROM operation_jobs WHERE id = ANY($1::uuid[])", [[...jobIds]]);
      jobIds.clear();
    }
    if (stackIds.size) {
      await pool.query("DELETE FROM compose_stacks WHERE id = ANY($1::uuid[])", [[...stackIds]]);
      stackIds.clear();
    }
    if (repositoryIds.size) {
      await pool.query("DELETE FROM github_repositories WHERE id = ANY($1::uuid[])", [[...repositoryIds]]);
      repositoryIds.clear();
    }
    if (registryIds.size) {
      await pool.query(
        "DELETE FROM audit_events WHERE target_kind = 'registry' AND target_id = ANY($1::text[])",
        [[...registryIds]]
      );
      await pool.query("DELETE FROM registries WHERE id = ANY($1::uuid[])", [[...registryIds]]);
      registryIds.clear();
    }
    if (hostIds.size) {
      await pool.query("DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])", [[...hostIds]]);
      hostIds.clear();
    }
  });

  it("rolls back every config row when a later stack guard rejects active work", async () => {
    const hostId = randomUUID();
    const repositoryId = randomUUID();
    const stackId = randomUUID();
    const jobId = randomUUID();
    hostIds.add(hostId);
    repositoryIds.add(repositoryId);
    stackIds.add(stackId);
    jobIds.add(jobId);

    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, port, username, connection_mode, ssh_auth_type,
         ssh_password_encrypted, docker_socket_path, tags
       )
       VALUES ($1, 'Guard host', 'guard.example.test', 22, 'docker', 'ssh', 'password',
               'preserve-password', '/var/run/docker.sock', ARRAY[]::text[])`,
      [hostId]
    );
    await pool.query(
      `INSERT INTO github_repositories (
         id, name, repository_url, owner, repo, branch, compose_path, project_name,
         env, default_host_id
       )
       VALUES ($1, 'Preserve repository', 'https://github.com/example/guarded',
               'example', 'guarded', 'main', 'compose.yml', 'guarded', '', $2)`,
      [repositoryId, hostId]
    );
    await pool.query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status
       )
       VALUES ($1, $2, 'Preserve stack', 'guarded',
               'services:\n  app:\n    image: nginx:alpine\n', '', 'deployed')`,
      [stackId, hostId]
    );
    await pool.query(
      `INSERT INTO operation_jobs (id, type, status, host_id, payload)
       VALUES ($1, 'compose.deploy', 'running', $2, $3)`,
      [jobId, hostId, { stackId }]
    );

    const backup = encryptConfigPayload(configPayload({
      githubRepositories: [{
        id: repositoryId,
        name: "Must roll back",
        repositoryUrl: "https://github.com/example/guarded",
        branch: "main",
        composePath: "compose.yml",
        projectName: "guarded",
        defaultHostId: hostId
      }],
      composeStacks: [{
        id: stackId,
        hostId,
        name: "Must roll back",
        projectName: "guarded",
        composeYaml: "services:\n  app:\n    image: nginx:1.27\n"
      }]
    }), passphrase);

    await expect(importConfigBackup(
      backup as unknown as Record<string, unknown>,
      passphrase
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });

    await expect(pool.query(
      "SELECT name FROM github_repositories WHERE id = $1",
      [repositoryId]
    )).resolves.toMatchObject({ rows: [{ name: "Preserve repository" }] });
    await expect(pool.query(
      "SELECT name, compose_yaml FROM compose_stacks WHERE id = $1",
      [stackId]
    )).resolves.toMatchObject({
      rows: [{
        name: "Preserve stack",
        compose_yaml: "services:\n  app:\n    image: nginx:alpine\n"
      }]
    });
  });

  it("retains a registry credential until its login job is terminal and audits deletion atomically", async () => {
    const hostId = randomUUID();
    const registryId = randomUUID();
    const jobId = randomUUID();
    hostIds.add(hostId);
    registryIds.add(registryId);
    jobIds.add(jobId);
    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, port, username, connection_mode, ssh_auth_type,
         ssh_password_encrypted, docker_socket_path, tags
       )
       VALUES ($1, 'Registry host', 'registry-host.example.test', 22, 'docker', 'ssh', 'password',
               'password', '/var/run/docker.sock', ARRAY[]::text[])`,
      [hostId]
    );
    await pool.query(
      `INSERT INTO registries (id, name, url, username, password_encrypted, insecure)
       VALUES ($1, 'Guarded registry', 'https://registry.example.test', 'operator',
               'encrypted-password', false)`,
      [registryId]
    );
    await pool.query(
      `INSERT INTO operation_jobs (id, type, status, host_id, payload)
       VALUES ($1, 'registry.login', 'queued', $2, $3)`,
      [jobId, hostId, { registryId }]
    );

    await expect(deleteRegistry(registryId)).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId
    });
    await expect(pool.query("SELECT id FROM registries WHERE id = $1", [registryId]))
      .resolves.toMatchObject({ rowCount: 1 });

    await pool.query(
      "UPDATE operation_jobs SET status = 'completed', completed_at = now() WHERE id = $1",
      [jobId]
    );
    await expect(deleteRegistry(registryId)).resolves.toBe(true);
    await expect(pool.query("SELECT id FROM registries WHERE id = $1", [registryId]))
      .resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      `SELECT action
       FROM audit_events
       WHERE target_kind = 'registry' AND target_id = $1`,
      [registryId]
    )).resolves.toMatchObject({ rows: [{ action: "registry.delete" }] });
  });
});
