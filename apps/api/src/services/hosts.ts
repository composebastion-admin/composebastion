import { v4 as uuid } from "uuid";
import type { DockerHost } from "@dockermender/shared";
import { dockerHostCreateSchema, dockerHostUpdateSchema } from "@dockermender/shared";
import { query } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { mapHost } from "./mappers.js";
import type { SshTarget } from "./ssh.js";
import { env } from "../config/env.js";
import { validateAgentUrl } from "./ssrf.js";

export async function listHosts(includeDeleted = false) {
  const result = includeDeleted
    ? await query("SELECT * FROM docker_hosts ORDER BY name ASC")
    : await query("SELECT * FROM docker_hosts WHERE deleted_at IS NULL ORDER BY name ASC");
  return result.rows.map(mapHost);
}

export async function listHostIds() {
  const result = await query<{ id: string }>(
    "SELECT id FROM docker_hosts WHERE deleted_at IS NULL ORDER BY name ASC"
  );
  return result.rows.map((row) => row.id);
}

export async function getHost(id: string) {
  const result = await query("SELECT * FROM docker_hosts WHERE id = $1 AND deleted_at IS NULL", [id]);
  return result.rows[0] ? mapHost(result.rows[0]) : null;
}

async function findDuplicateHost(parsed: { name: string; hostname: string; username: string; port: number }, excludeId?: string) {
  const result = excludeId
    ? await query(
        `SELECT id FROM docker_hosts
         WHERE deleted_at IS NULL AND id <> $4
           AND (lower(name) = lower($1) OR (hostname = $2 AND username = $3 AND port = $5))`,
        [parsed.name, parsed.hostname, parsed.username, excludeId, parsed.port]
      )
    : await query(
        `SELECT id FROM docker_hosts
         WHERE deleted_at IS NULL
           AND (lower(name) = lower($1) OR (hostname = $2 AND username = $3 AND port = $4))`,
        [parsed.name, parsed.hostname, parsed.username, parsed.port]
      );
  return result.rows[0]?.id ?? null;
}

export async function getHostForWorker(id: string) {
  const result = await query("SELECT * FROM docker_hosts WHERE id = $1 AND deleted_at IS NULL", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Docker host not found");
  return {
    public: mapHost(row),
    connectionMode: row.connection_mode ?? "ssh",
    ssh: {
      hostname: row.hostname,
      port: Number(row.port),
      username: row.username,
      password: row.ssh_password_encrypted ? decryptSecret(row.ssh_password_encrypted) : undefined,
      privateKey: row.ssh_key_encrypted ? decryptSecret(row.ssh_key_encrypted) : "",
      passphrase: row.ssh_key_passphrase_encrypted ? decryptSecret(row.ssh_key_passphrase_encrypted) : null
    } satisfies SshTarget,
    agent: row.agent_url
      ? {
          url: row.agent_url,
          token: row.agent_token_encrypted ? decryptSecret(row.agent_token_encrypted) : ""
        }
      : null
  };
}

export async function createHost(input: unknown) {
  const parsed = dockerHostCreateSchema.parse(input);
  if (parsed.connectionMode === "agent" && parsed.agentUrl) {
    if (env.NODE_ENV === "production" && !env.ALLOW_PRIVATE_AGENT_URLS) {
      const isValid = await validateAgentUrl(parsed.agentUrl);
      if (!isValid) {
        throw Object.assign(new Error("This agent URL points at a private network address, which is blocked by default to prevent request forgery. If your agent really lives on a private LAN (typical for homelabs), set ALLOW_PRIVATE_AGENT_URLS=true on the Dockermender server and try again."), { statusCode: 400 });
      }
    }
  }
  if (await findDuplicateHost(parsed)) {
    throw Object.assign(new Error("A host with this name or connection already exists"), { statusCode: 409 });
  }
  const id = uuid();
  const result = await query(
    `INSERT INTO docker_hosts
      (id, name, hostname, port, username, connection_mode, ssh_auth_type, ssh_key_encrypted, ssh_key_passphrase_encrypted, ssh_password_encrypted, agent_url, agent_token_encrypted, docker_socket_path, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      id,
      parsed.name,
      parsed.hostname,
      parsed.port,
      parsed.username,
      parsed.connectionMode,
      parsed.sshAuthType,
      parsed.sshPrivateKey ? encryptSecret(parsed.sshPrivateKey) : null,
      parsed.sshKeyPassphrase ? encryptSecret(parsed.sshKeyPassphrase) : null,
      parsed.sshPassword ? encryptSecret(parsed.sshPassword) : null,
      parsed.agentUrl ?? null,
      parsed.agentToken ? encryptSecret(parsed.agentToken) : null,
      parsed.dockerSocketPath,
      parsed.tags
    ]
  );
  return mapHost(result.rows[0]);
}

export async function updateHost(id: string, input: unknown) {
  const parsed = dockerHostUpdateSchema.parse(input);
  if (parsed.connectionMode === "agent" && parsed.agentUrl) {
    if (env.NODE_ENV === "production" && !env.ALLOW_PRIVATE_AGENT_URLS) {
      const isValid = await validateAgentUrl(parsed.agentUrl);
      if (!isValid) {
        throw Object.assign(new Error("This agent URL points at a private network address, which is blocked by default to prevent request forgery. If your agent really lives on a private LAN (typical for homelabs), set ALLOW_PRIVATE_AGENT_URLS=true on the Dockermender server and try again."), { statusCode: 400 });
      }
    }
  }
  const current = await getHost(id);
  if (!current) return null;

  const candidate = {
    name: parsed.name ?? current.name,
    hostname: parsed.hostname ?? current.hostname,
    username: parsed.username ?? current.username,
    port: parsed.port ?? current.port
  };
  if (await findDuplicateHost(candidate, id)) {
    throw Object.assign(new Error("A host with this name or connection already exists"), { statusCode: 409 });
  }

  const updates = {
    name: parsed.name ?? current.name,
    hostname: parsed.hostname ?? current.hostname,
    port: parsed.port ?? current.port,
    username: parsed.username ?? current.username,
    connectionMode: parsed.connectionMode ?? current.connectionMode,
    sshAuthType: parsed.sshAuthType ?? current.sshAuthType,
    agentUrl: parsed.agentUrl ?? current.agentUrl,
    dockerSocketPath: parsed.dockerSocketPath ?? current.dockerSocketPath,
    tags: parsed.tags ?? current.tags
  };

  const result = await query(
    `UPDATE docker_hosts
     SET name = $2,
         hostname = $3,
         port = $4,
         username = $5,
         connection_mode = $6,
         ssh_auth_type = $7,
         ssh_key_encrypted = COALESCE($8, ssh_key_encrypted),
         ssh_key_passphrase_encrypted = COALESCE($9, ssh_key_passphrase_encrypted),
         ssh_password_encrypted = COALESCE($10, ssh_password_encrypted),
         agent_url = $11,
         agent_token_encrypted = COALESCE($12, agent_token_encrypted),
         docker_socket_path = $13,
         tags = $14,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      updates.name,
      updates.hostname,
      updates.port,
      updates.username,
      updates.connectionMode,
      updates.sshAuthType,
      parsed.sshPrivateKey ? encryptSecret(parsed.sshPrivateKey) : null,
      parsed.sshKeyPassphrase ? encryptSecret(parsed.sshKeyPassphrase) : null,
      parsed.sshPassword ? encryptSecret(parsed.sshPassword) : null,
      updates.agentUrl,
      parsed.agentToken ? encryptSecret(parsed.agentToken) : null,
      updates.dockerSocketPath,
      updates.tags
    ]
  );
  return result.rows[0] ? mapHost(result.rows[0]) : null;
}

export async function deleteHost(id: string) {
  await query("UPDATE docker_hosts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
}

export async function restoreHost(id: string) {
  const result = await query(
    `UPDATE docker_hosts SET deleted_at = NULL, updated_at = now()
     WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING *`,
    [id]
  );
  return result.rows[0] ? mapHost(result.rows[0]) : null;
}

export async function markHostChecking(id: string) {
  await query("UPDATE docker_hosts SET last_status = 'checking', updated_at = now() WHERE id = $1", [id]);
}

export async function markHostOnline(id: string, dockerVersion: string, composeVersion: string, agentVersion: string | null = null) {
  await query(
    `UPDATE docker_hosts
     SET last_status = 'online',
         last_seen_at = now(),
         last_error = null,
         docker_version = $2,
         compose_version = $3,
         agent_version = $4,
         updated_at = now()
     WHERE id = $1`,
    [id, dockerVersion, composeVersion, agentVersion]
  );
}

export async function markHostOffline(id: string, error: unknown) {
  await query(
    `UPDATE docker_hosts
     SET last_status = 'offline',
         last_error = $2,
         updated_at = now()
     WHERE id = $1`,
    [id, error instanceof Error ? error.message : String(error)]
  );
}

export async function getHostResources(hostId: string, kind?: string) {
  const result = kind
    ? await query("SELECT * FROM resource_snapshots WHERE host_id = $1 AND kind = $2 ORDER BY name ASC", [hostId, kind])
    : await query("SELECT * FROM resource_snapshots WHERE host_id = $1 ORDER BY kind ASC, name ASC", [hostId]);
  return result.rows;
}
