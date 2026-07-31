import { randomUUID } from "node:crypto";
import { CONFIG_BACKUP_FORMAT_VERSION } from "@composebastion/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { createChannel } from "../../src/services/alerts.js";
import { renameApp } from "../../src/services/apps.js";
import {
  saveCustomCatalogTemplate
} from "../../src/services/catalog.js";
import {
  importConfigBackup
} from "../../src/services/configBackup.js";
import { encryptConfigPayload } from "../../src/services/crypto.js";
import { createDeploymentSource } from "../../src/services/deployments.js";
import { createFavoriteImage } from "../../src/services/favorites.js";
import { createGithubRepository } from "../../src/services/github.js";
import {
  createRegistry
} from "../../src/services/registries.js";
import { saveSelfUpdateConfig } from "../../src/services/selfUpdate.js";
import { createUser } from "../../src/services/users.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const prefix = "sync-audit-atomicity";

function auditFailure() {
  return new Error("intentional synchronous mutation audit failure");
}

async function rejectAudit() {
  throw auditFailure();
}

describe.skipIf(!integrationEnabled)("synchronous mutation audit atomicity", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.query(
      "DROP TRIGGER IF EXISTS synchronous_registry_audit_reject ON audit_events"
    );
    await pool.query(
      "DROP FUNCTION IF EXISTS synchronous_registry_audit_reject_fn()"
    );
    await pool.query(
      "DELETE FROM audit_events WHERE action LIKE 'sync_audit_test.%'"
    );
    await pool.query(
      "DELETE FROM custom_catalog_templates WHERE id LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM deployment_sources WHERE name LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM github_repositories WHERE name LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM favorite_images WHERE image LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM notification_channels WHERE name LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM registries WHERE name LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM admin_users WHERE email LIKE $1",
      [`${prefix}%`]
    );
    await pool.query(
      "DELETE FROM system_settings WHERE key IN ('self_update.config', 'self_update.latest')"
    );
    await pool.query(
      "DELETE FROM docker_hosts WHERE name LIKE $1",
      [`${prefix}%`]
    );
  });

  it("rolls back alert-channel persistence when its audit callback fails", async () => {
    const name = `${prefix}-channel-${randomUUID()}`;
    await expect(createChannel({
      name,
      type: "email",
      emailTo: "atomicity@example.test",
      enabled: true
    }, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT id FROM notification_channels WHERE name = $1",
      [name]
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back favorite-image persistence when its audit callback fails", async () => {
    const image = `${prefix}/favorite:${randomUUID()}`;
    await expect(createFavoriteImage({
      image,
      name: "Atomic favorite",
      notes: ""
    }, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT id FROM favorite_images WHERE image = $1",
      [image]
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back custom-catalog persistence when its audit callback fails", async () => {
    const id = `${prefix}-${randomUUID().slice(0, 8)}`;
    await expect(saveCustomCatalogTemplate({
      id,
      name: "Atomic template",
      description: "Must roll back with its audit.",
      category: "utility",
      composeYaml: "services:\n  app:\n    image: nginx:alpine\n",
      defaultEnv: {},
      suggestedVolumes: [],
      suggestedPorts: []
    }, null, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT id FROM custom_catalog_templates WHERE id = $1",
      [id]
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back deployment-library persistence when its audit callback fails", async () => {
    const unique = randomUUID().slice(0, 8);
    const name = `${prefix}-source-${unique}`;
    await expect(createDeploymentSource({
      sourceType: "git",
      name,
      sourceLocator: `https://example.test/${unique}/app.git`,
      branch: "main",
      composePath: "compose.yml",
      projectName: `atomic-${unique}`
    }, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT id FROM deployment_sources WHERE name = $1",
      [name]
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back GitHub repository persistence when its audit callback fails", async () => {
    const unique = randomUUID().slice(0, 8);
    const name = `${prefix}-github-${unique}`;
    await expect(createGithubRepository({
      name,
      repositoryUrl: `https://github.com/composebastion-tests/${name}`,
      branch: "main",
      composePath: "docker-compose.yml",
      projectName: `atomic-${unique}`,
      env: ""
    }, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT id FROM github_repositories WHERE name = $1",
      [name]
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back self-update settings when its audit callback fails", async () => {
    await pool.query(
      "DELETE FROM system_settings WHERE key = 'self_update.config'"
    );
    await expect(saveSelfUpdateConfig({
      versionMode: "latest"
    }, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT key FROM system_settings WHERE key = 'self_update.config'"
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back user persistence when its audit callback fails", async () => {
    const email = `${prefix}-${randomUUID()}@example.test`;
    await expect(createUser({
      name: "Atomic operator",
      email,
      password: "Very-Secure-Pass1!",
      role: "operator"
    }, rejectAudit)).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query(
      "SELECT id FROM admin_users WHERE email = $1",
      [email]
    );
    expect(saved.rowCount).toBe(0);
  });

  it("rolls back app metadata when its audit callback fails", async () => {
    const hostId = randomUUID();
    const stackId = randomUUID();
    const unique = randomUUID().slice(0, 8);
    const hostName = `${prefix}-host-${unique}`;
    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, username, ssh_key_encrypted
       )
       VALUES ($1, $2, $3, 'atomicity', 'not-a-real-key')`,
      [hostId, hostName, `${unique}.invalid`]
    );
    await pool.query(
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status
       )
       VALUES ($1, $2, 'Original app name', $3, $4, '', 'deployed')`,
      [
        stackId,
        hostId,
        `atomic-${unique}`,
        "services:\n  app:\n    image: nginx:alpine\n"
      ]
    );

    try {
      await expect(renameApp(
        `stack:${stackId}`,
        { name: "Changed app name" },
        rejectAudit
      )).rejects.toThrow("intentional synchronous mutation audit failure");

      const saved = await pool.query<{ name: string }>(
        "SELECT name FROM compose_stacks WHERE id = $1",
        [stackId]
      );
      expect(saved.rows[0]?.name).toBe("Original app name");
    } finally {
      await pool.query("DELETE FROM docker_hosts WHERE id = $1", [hostId]);
    }
  });

  it("rolls back a config import when its audit callback fails", async () => {
    const image = `${prefix}/config:${randomUUID()}`;
    const passphrase = "Atomic-Config-Passphrase-1!";
    const exported = await createFavoriteImage({
      image,
      name: "Exported name",
      notes: ""
    });
    const backup = encryptConfigPayload({
      app: "ComposeBastion",
      formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
      version: "1.2.0-beta.1",
      exportedAt: "2026-07-30T12:00:00.000Z",
      hosts: [],
      composeStacks: [],
      registries: [],
      notificationChannels: [],
      alertRules: [],
      favoriteImages: [{
        id: exported.id,
        image: exported.image,
        name: exported.name,
        notes: exported.notes
      }],
      githubRepositories: [],
      deploymentSources: [],
      appSourceLinks: [],
      backupTargets: []
    }, passphrase);
    await createFavoriteImage({ image, name: "Current name", notes: "" });

    await expect(importConfigBackup(
      backup as unknown as Record<string, unknown>,
      passphrase,
      rejectAudit
    )).rejects.toThrow("intentional synchronous mutation audit failure");

    const saved = await pool.query<{ name: string | null }>(
      "SELECT name FROM favorite_images WHERE image = $1",
      [image]
    );
    expect(saved.rows[0]?.name).toBe("Current name");
  });

  it("rolls back registry persistence when its required audit insert fails", async () => {
    await pool.query(
      "DROP TRIGGER IF EXISTS synchronous_registry_audit_reject ON audit_events"
    );
    await pool.query(
      "DROP FUNCTION IF EXISTS synchronous_registry_audit_reject_fn()"
    );
    await pool.query(`
      CREATE FUNCTION synchronous_registry_audit_reject_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'registry.create' THEN
          RAISE EXCEPTION 'intentional registry audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER synchronous_registry_audit_reject
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION synchronous_registry_audit_reject_fn()
    `);
    const name = `${prefix}-registry-${randomUUID().slice(0, 8)}`;

    try {
      await expect(createRegistry({
        name,
        url: "https://registry.example.test",
        insecure: false
      })).rejects.toThrow("intentional registry audit failure");

      const saved = await pool.query(
        "SELECT id FROM registries WHERE name = $1",
        [name]
      );
      expect(saved.rowCount).toBe(0);
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS synchronous_registry_audit_reject ON audit_events"
      );
      await pool.query(
        "DROP FUNCTION IF EXISTS synchronous_registry_audit_reject_fn()"
      );
    }
  });
});
