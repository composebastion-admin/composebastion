import { v4 as uuid } from "uuid";
import type { PoolClient } from "pg";
import type { DockerHost } from "@composebastion/shared";
import { dockerHostCreateSchema, dockerHostUpdateSchema } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { mapHost } from "./mappers.js";
import type { SshTarget } from "./ssh.js";
import { env } from "../config/env.js";
import { validateAgentUrl } from "./ssrf.js";
import { enqueueJobInTransaction, notifyJobQueued } from "./jobs.js";
import { lockHostIdentityScope } from "./hostIdentity.js";

export { HOST_CREATE_LOCK_ID } from "./hostIdentity.js";
const PRIVATE_AGENT_URL_ERROR = "This agent URL points at a private network address, which is blocked by default to prevent request forgery. If your agent really lives on a private LAN (typical for homelabs), set ALLOW_PRIVATE_AGENT_URLS=true on the ComposeBastion server and try again.";

async function assertAgentUrlAllowed(agentUrl: string) {
  if (env.NODE_ENV !== "production" || env.ALLOW_PRIVATE_AGENT_URLS) return;
  const isValid = await validateAgentUrl(agentUrl);
  if (!isValid) {
    throw Object.assign(new Error(PRIVATE_AGENT_URL_ERROR), { statusCode: 400 });
  }
}

function updateEncryptedSecret(
  currentValue: string | null | undefined,
  replacement: string | undefined,
  clear: boolean | undefined
) {
  if (clear) return null;
  if (replacement !== undefined) return encryptSecret(replacement);
  return currentValue ?? null;
}

function invalidHostConfiguration(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

type ParsedHostCreate = ReturnType<typeof dockerHostCreateSchema.parse>;

/**
 * Keep only the credential material used by the selected connection and SSH
 * authentication modes. This invariant is shared by create, restore, and
 * configuration import so inactive secrets never remain at rest.
 */
export function normalizeHostCreateCredentials(parsed: ParsedHostCreate): ParsedHostCreate {
  if (parsed.connectionMode === "agent") {
    return {
      ...parsed,
      sshPrivateKey: undefined,
      sshKeyPassphrase: undefined,
      sshPassword: undefined
    };
  }
  if (parsed.sshAuthType === "key") {
    return {
      ...parsed,
      sshPassword: undefined,
      agentUrl: undefined,
      agentToken: undefined
    };
  }
  return {
    ...parsed,
    sshPrivateKey: undefined,
    sshKeyPassphrase: undefined,
    agentUrl: undefined,
    agentToken: undefined
  };
}

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

async function findDuplicateHost(
  parsed: { name: string; hostname: string; username: string; port: number },
  excludeId?: string,
  client?: PoolClient
) {
  const dbQuery = client ? client.query.bind(client) : query;
  const result = excludeId
    ? await dbQuery(
        `SELECT id FROM docker_hosts
         WHERE deleted_at IS NULL AND id <> $4
           AND (
             lower(btrim(name)) = lower(btrim($1))
             OR (lower(btrim(hostname)) = lower(btrim($2)) AND username = $3 AND port = $5)
           )`,
        [parsed.name, parsed.hostname, parsed.username, excludeId, parsed.port]
      )
    : await dbQuery(
        `SELECT id FROM docker_hosts
         WHERE deleted_at IS NULL
           AND (
             lower(btrim(name)) = lower(btrim($1))
             OR (lower(btrim(hostname)) = lower(btrim($2)) AND username = $3 AND port = $4)
           )`,
        [parsed.name, parsed.hostname, parsed.username, parsed.port]
      );
  return result.rows[0]?.id ?? null;
}

export async function getHostForWorker(id: string) {
  const result = await query("SELECT * FROM docker_hosts WHERE id = $1 AND deleted_at IS NULL", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Docker host not found");
  const publicHost = mapHost(row);
  return {
    public: publicHost,
    connectionMode: row.connection_mode ?? "ssh",
    ssh: {
      hostname: row.hostname,
      port: Number(row.port),
      username: row.username,
      password: row.ssh_password_encrypted ? decryptSecret(row.ssh_password_encrypted) : undefined,
      privateKey: row.ssh_key_encrypted ? decryptSecret(row.ssh_key_encrypted) : "",
      passphrase: row.ssh_key_passphrase_encrypted ? decryptSecret(row.ssh_key_passphrase_encrypted) : null
    } satisfies SshTarget,
    // Legacy rows may predate strict agent URL validation. Use the same
    // credential/query-stripped value exposed by the mapper so a worker never
    // transmits embedded URL secrets.
    agent: publicHost.agentUrl
      ? {
          url: publicHost.agentUrl,
          token: row.agent_token_encrypted ? decryptSecret(row.agent_token_encrypted) : ""
        }
      : null
  };
}

export async function createHost(input: unknown) {
  const prepared = await prepareHostCreate(input);
  return withTransaction((client) => insertPreparedHost(client, prepared));
}

async function prepareHostCreate(input: unknown) {
  const parsed = normalizeHostCreateCredentials(dockerHostCreateSchema.parse(input));
  if (parsed.connectionMode === "agent" && parsed.agentUrl) {
    await assertAgentUrlAllowed(parsed.agentUrl);
  }
  return {
    parsed,
    sshKeyEncrypted: parsed.sshPrivateKey ? encryptSecret(parsed.sshPrivateKey) : null,
    sshKeyPassphraseEncrypted: parsed.sshKeyPassphrase ? encryptSecret(parsed.sshKeyPassphrase) : null,
    sshPasswordEncrypted: parsed.sshPassword ? encryptSecret(parsed.sshPassword) : null,
    agentTokenEncrypted: parsed.agentToken ? encryptSecret(parsed.agentToken) : null
  };
}

async function insertPreparedHost(client: PoolClient, prepared: Awaited<ReturnType<typeof prepareHostCreate>>) {
  const { parsed } = prepared;
  await lockHostIdentityScope(client);
  if (await findDuplicateHost(parsed, undefined, client)) {
    throw Object.assign(new Error("A host with this name or connection already exists"), { statusCode: 409 });
  }
  const id = uuid();
  const result = await client.query(
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
      prepared.sshKeyEncrypted,
      prepared.sshKeyPassphraseEncrypted,
      prepared.sshPasswordEncrypted,
      parsed.agentUrl ?? null,
      prepared.agentTokenEncrypted,
      parsed.dockerSocketPath,
      parsed.tags
    ]
  );
  return mapHost(result.rows[0]);
}

export async function createHostWithSync(input: unknown, createdBy?: string | null) {
  // URL validation and secret encryption happen before the transaction so the
  // database lock is held only for the two durable writes.
  const prepared = await prepareHostCreate(input);
  const result = await withTransaction(async (client) => {
    const host = await insertPreparedHost(client, prepared);
    const job = await enqueueJobInTransaction(
      client,
      { type: "host.sync", hostId: host.id, payload: {} },
      createdBy
    );
    return { host, job };
  });
  await notifyJobQueued(result.job.id);
  return result;
}

export async function updateHost(id: string, input: unknown) {
  const parsed = dockerHostUpdateSchema.parse(input);
  // Validate an explicitly supplied URL before opening a transaction. A
  // previously stored URL that becomes active is validated below against the
  // row-locked snapshot.
  if (typeof parsed.agentUrl === "string") {
    await assertAgentUrlAllowed(parsed.agentUrl);
  }

  return withTransaction(async (client) => {
    // Serialize create/update duplicate checks, then lock this row so two
    // partial patches cannot overwrite each other's effective settings.
    await lockHostIdentityScope(client);
    const currentResult = await client.query(
      "SELECT * FROM docker_hosts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [id]
    );
    const currentRow = currentResult.rows[0];
    if (!currentRow) return null;
    const current = mapHost(currentRow);

    const updates = {
      name: parsed.name ?? current.name,
      hostname: parsed.hostname ?? current.hostname,
      port: parsed.port ?? current.port,
      username: parsed.username ?? current.username,
      connectionMode: parsed.connectionMode ?? current.connectionMode,
      sshAuthType: parsed.sshAuthType ?? current.sshAuthType,
      agentUrl: parsed.agentUrl === undefined ? current.agentUrl : parsed.agentUrl,
      dockerSocketPath: parsed.dockerSocketPath ?? current.dockerSocketPath,
      tags: parsed.tags ?? current.tags
    };

    const agentModeActivated = updates.connectionMode === "agent" && current.connectionMode !== "agent";
    if (
      agentModeActivated
      && parsed.agentUrl === undefined
      && typeof updates.agentUrl === "string"
    ) {
      await assertAgentUrlAllowed(updates.agentUrl);
    }

    let sshKeyEncrypted = updateEncryptedSecret(
      currentRow.ssh_key_encrypted,
      parsed.sshPrivateKey,
      parsed.clearSshPrivateKey
    );
    let sshKeyPassphraseEncrypted = updateEncryptedSecret(
      currentRow.ssh_key_passphrase_encrypted,
      parsed.sshKeyPassphrase,
      parsed.clearSshKeyPassphrase
    );
    let sshPasswordEncrypted = updateEncryptedSecret(
      currentRow.ssh_password_encrypted,
      parsed.sshPassword,
      parsed.clearSshPassword
    );
    let agentTokenEncrypted = updateEncryptedSecret(
      currentRow.agent_token_encrypted,
      parsed.agentToken,
      parsed.clearAgentToken
    );

    // Credentials for an inactive transport/auth mode should not remain at
    // rest. This also gives mode changes deterministic cleanup semantics.
    if (updates.connectionMode === "agent") {
      sshKeyEncrypted = null;
      sshKeyPassphraseEncrypted = null;
      sshPasswordEncrypted = null;
    } else {
      updates.agentUrl = null;
      agentTokenEncrypted = null;
      if (updates.sshAuthType === "key") {
        sshPasswordEncrypted = null;
      } else {
        sshKeyEncrypted = null;
        sshKeyPassphraseEncrypted = null;
      }
    }

    if (updates.connectionMode === "agent") {
      if (!updates.agentUrl) {
        throw invalidHostConfiguration("Agent URL is required for agent hosts");
      }
      if (!agentTokenEncrypted) {
        throw invalidHostConfiguration("Agent token is required for agent hosts");
      }
    } else if (updates.sshAuthType === "key") {
      if (!sshKeyEncrypted) {
        throw invalidHostConfiguration("SSH private key is required for key authentication");
      }
    } else if (!sshPasswordEncrypted) {
      throw invalidHostConfiguration("SSH password is required for password authentication");
    }

    const candidate = {
      name: updates.name,
      hostname: updates.hostname,
      username: updates.username,
      port: updates.port
    };
    if (await findDuplicateHost(candidate, id, client)) {
      throw Object.assign(new Error("A host with this name or connection already exists"), { statusCode: 409 });
    }

    const result = await client.query(
      `UPDATE docker_hosts
       SET name = $2,
           hostname = $3,
           port = $4,
           username = $5,
           connection_mode = $6,
           ssh_auth_type = $7,
           ssh_key_encrypted = $8,
           ssh_key_passphrase_encrypted = $9,
           ssh_password_encrypted = $10,
           agent_url = $11,
           agent_token_encrypted = $12,
           docker_socket_path = $13,
           tags = $14,
           updated_at = now()
       WHERE id = $1
         AND deleted_at IS NULL
       RETURNING *`,
      [
        id,
        updates.name,
        updates.hostname,
        updates.port,
        updates.username,
        updates.connectionMode,
        updates.sshAuthType,
        sshKeyEncrypted,
        sshKeyPassphraseEncrypted,
        sshPasswordEncrypted,
        updates.agentUrl,
        agentTokenEncrypted,
        updates.dockerSocketPath,
        updates.tags
      ]
    );
    return result.rows[0] ? mapHost(result.rows[0]) : null;
  });
}

export async function deleteHost(id: string) {
  await query("UPDATE docker_hosts SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL", [id]);
}

export async function restoreHost(id: string) {
  return withTransaction(async (client) => {
    await lockHostIdentityScope(client);
    const selected = await client.query(
      "SELECT * FROM docker_hosts WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE",
      [id]
    );
    const row = selected.rows[0];
    if (!row) return null;
    const prepared = await prepareHostCreate({
      name: row.name,
      hostname: row.hostname,
      port: Number(row.port),
      username: row.username,
      connectionMode: row.connection_mode ?? "ssh",
      sshAuthType: row.ssh_auth_type ?? "key",
      sshPrivateKey: row.ssh_key_encrypted ? decryptSecret(row.ssh_key_encrypted) : undefined,
      sshKeyPassphrase: row.ssh_key_passphrase_encrypted
        ? decryptSecret(row.ssh_key_passphrase_encrypted)
        : undefined,
      sshPassword: row.ssh_password_encrypted ? decryptSecret(row.ssh_password_encrypted) : undefined,
      agentUrl: row.agent_url ?? undefined,
      agentToken: row.agent_token_encrypted ? decryptSecret(row.agent_token_encrypted) : undefined,
      dockerSocketPath: row.docker_socket_path ?? "/var/run/docker.sock",
      tags: row.tags ?? []
    });
    if (await findDuplicateHost({
      name: prepared.parsed.name,
      hostname: prepared.parsed.hostname,
      username: prepared.parsed.username,
      port: prepared.parsed.port
    }, id, client)) {
      throw Object.assign(
        new Error("This host cannot be restored because an active host now has the same name or connection"),
        { statusCode: 409 }
      );
    }
    const result = await client.query(
      `UPDATE docker_hosts
       SET name = $2,
           hostname = $3,
           port = $4,
           username = $5,
           connection_mode = $6,
           ssh_auth_type = $7,
           ssh_key_encrypted = $8,
           ssh_key_passphrase_encrypted = $9,
           ssh_password_encrypted = $10,
           agent_url = $11,
           agent_token_encrypted = $12,
           docker_socket_path = $13,
           tags = $14,
           last_status = 'unknown',
           last_seen_at = NULL,
           last_error = NULL,
           docker_version = NULL,
           compose_version = NULL,
           agent_version = NULL,
           deleted_at = NULL,
           updated_at = now()
       WHERE id = $1 AND deleted_at IS NOT NULL
       RETURNING *`,
      [
        id,
        prepared.parsed.name,
        prepared.parsed.hostname,
        prepared.parsed.port,
        prepared.parsed.username,
        prepared.parsed.connectionMode,
        prepared.parsed.sshAuthType,
        prepared.sshKeyEncrypted,
        prepared.sshKeyPassphraseEncrypted,
        prepared.sshPasswordEncrypted,
        prepared.parsed.agentUrl ?? null,
        prepared.agentTokenEncrypted,
        prepared.parsed.dockerSocketPath,
        prepared.parsed.tags
      ]
    );
    return result.rows[0] ? mapHost(result.rows[0]) : null;
  });
}

export async function markHostChecking(id: string, client?: PoolClient) {
  const execute = client ? client.query.bind(client) : query;
  await execute("UPDATE docker_hosts SET last_status = 'checking', updated_at = now() WHERE id = $1", [id]);
}

export async function markHostOnline(
  id: string,
  dockerVersion: string,
  composeVersion: string,
  agentVersion: string | null = null,
  client?: PoolClient
) {
  const execute = client ? client.query.bind(client) : query;
  await execute(
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

export async function markHostOffline(id: string, error: unknown, client?: PoolClient) {
  const execute = client ? client.query.bind(client) : query;
  await execute(
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
