import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const validateAgentUrl = vi.hoisted(() => vi.fn());
const enqueueJobInTransaction = vi.hoisted(() => vi.fn());
const notifyJobQueued = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: async (handler: (client: { query: typeof query }) => Promise<unknown>) => handler({ query })
}));

vi.mock("../src/config/env.js", () => ({
  env: {
    NODE_ENV: "production",
    ALLOW_PRIVATE_AGENT_URLS: false
  }
}));

vi.mock("../src/services/crypto.js", () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.replace(/^encrypted:/, "")
}));

vi.mock("../src/services/ssrf.js", () => ({
  validateAgentUrl
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction,
  notifyJobQueued
}));

const {
  createHost,
  createHostWithSync,
  getHostForWorker,
  restoreHost,
  updateHost
} = await import("../src/services/hosts.js");

function hostRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Production",
    hostname: "host.example.test",
    port: 22,
    username: "docker",
    connection_mode: "ssh",
    ssh_auth_type: "password",
    ssh_key_encrypted: null,
    ssh_key_passphrase_encrypted: null,
    ssh_password_encrypted: "encrypted:retained-password",
    agent_url: null,
    agent_token_encrypted: null,
    docker_socket_path: "/var/run/docker.sock",
    tags: [],
    last_status: "online",
    last_seen_at: null,
    last_error: null,
    docker_version: "29.0.0",
    compose_version: "2.40.0",
    agent_version: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides
  };
}

function arrangeCurrentHost(
  current: ReturnType<typeof hostRow>,
  operationRows: Array<Record<string, unknown>> = []
) {
  query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (sql.includes("SELECT *") && sql.includes("FROM docker_hosts")) {
      return { rows: [current] };
    }
    if (sql.includes("FROM operation_jobs AS jobs")) {
      const unknownMutationTypes = Array.isArray(values[1])
        ? values[1] as string[]
        : [];
      return {
        rows: operationRows.filter((row) =>
          row.status === "queued"
          || row.status === "running"
          || unknownMutationTypes.includes(String(row.type))
        )
      };
    }
    if (
      sql.includes("FROM recovery_restore_attempts")
      || sql.includes("FROM recovery_points")
    ) {
      return { rows: [] };
    }
    if (sql.includes("SELECT id FROM docker_hosts")) {
      return { rows: [] };
    }
    if (sql.includes("UPDATE docker_hosts")) {
      return {
        rows: [hostRow({
          ...current,
          id: values[0],
          name: values[1],
          hostname: values[2],
          port: values[3],
          username: values[4],
          connection_mode: values[5],
          ssh_auth_type: values[6],
          ssh_key_encrypted: values[7],
          ssh_key_passphrase_encrypted: values[8],
          ssh_password_encrypted: values[9],
          agent_url: values[10],
          agent_token_encrypted: values[11],
          docker_socket_path: values[12],
          tags: values[13]
        })]
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function updateParameters() {
  const updateCall = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE docker_hosts"));
  return updateCall?.[1] as unknown[] | undefined;
}

describe("Docker host updates", () => {
  beforeEach(() => {
    query.mockReset();
    validateAgentUrl.mockReset();
    validateAgentUrl.mockResolvedValue(true);
    enqueueJobInTransaction.mockReset();
    notifyJobQueued.mockReset();
  });

  it("rejects a switch to agent mode without an effective token", async () => {
    arrangeCurrentHost(hostRow());

    await expect(updateHost(
      "00000000-0000-4000-8000-000000000001",
      {
        connectionMode: "agent",
        agentUrl: "https://agent.example.test"
      }
    )).rejects.toThrow("Agent token is required for agent hosts");

    expect(updateParameters()).toBeUndefined();
  });

  it("scrubs inactive credentials when creating a host", async () => {
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock") || sql.includes("SELECT id FROM docker_hosts")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO docker_hosts")) {
        return {
          rows: [hostRow({
            id: values[0],
            name: values[1],
            hostname: values[2],
            port: values[3],
            username: values[4],
            connection_mode: values[5],
            ssh_auth_type: values[6],
            ssh_key_encrypted: values[7],
            ssh_key_passphrase_encrypted: values[8],
            ssh_password_encrypted: values[9],
            agent_url: values[10],
            agent_token_encrypted: values[11],
            docker_socket_path: values[12],
            tags: values[13]
          })]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await createHost({
      name: "Password host",
      hostname: "host.example.test",
      username: "docker",
      connectionMode: "ssh",
      sshAuthType: "password",
      sshPrivateKey: "inactive-key",
      sshKeyPassphrase: "inactive-passphrase",
      sshPassword: "active-password",
      agentUrl: "https://inactive-agent.example.test",
      agentToken: "inactive-agent-token"
    });

    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO docker_hosts"));
    const values = insert?.[1] as unknown[];
    expect(values[7]).toBeNull();
    expect(values[8]).toBeNull();
    expect(values[9]).toBe("encrypted:active-password");
    expect(values[10]).toBeNull();
    expect(values[11]).toBeNull();
  });

  it("keeps host creation, initial sync, and required audit in one transaction", async () => {
    const createdJob = {
      id: "00000000-0000-4000-8000-000000000099"
    };
    enqueueJobInTransaction.mockResolvedValue(createdJob);
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock") || sql.includes("SELECT id FROM docker_hosts")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO docker_hosts")) {
        return {
          rows: [hostRow({
            id: values[0],
            name: values[1],
            hostname: values[2],
            port: values[3],
            username: values[4]
          })]
        };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        throw new Error("audit unavailable");
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(createHostWithSync({
      name: "Atomic host",
      hostname: "atomic.example.test",
      username: "docker",
      connectionMode: "ssh",
      sshAuthType: "password",
      sshPassword: "secret"
    }, "00000000-0000-4000-8000-000000000088", {
      userId: "00000000-0000-4000-8000-000000000088"
    })).rejects.toThrow("audit unavailable");

    expect(enqueueJobInTransaction).toHaveBeenCalledOnce();
    expect(notifyJobQueued).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO audit_events")
    )).toBe(true);
  });

  it("applies private-address validation when an existing agent URL changes", async () => {
    arrangeCurrentHost(hostRow({
      connection_mode: "agent",
      agent_url: "https://old-agent.example.test",
      agent_token_encrypted: "encrypted:retained-token",
      ssh_password_encrypted: null
    }));
    validateAgentUrl.mockResolvedValue(false);

    await expect(updateHost(
      "00000000-0000-4000-8000-000000000001",
      { agentUrl: "http://127.0.0.1:8090" }
    )).rejects.toThrow("blocked by default to prevent request forgery");

    expect(validateAgentUrl).toHaveBeenCalledWith("http://127.0.0.1:8090");
    expect(updateParameters()).toBeUndefined();
  });

  it("retains an encrypted active secret when its patch field is omitted", async () => {
    arrangeCurrentHost(hostRow({
      connection_mode: "agent",
      agent_url: "https://agent.example.test",
      agent_token_encrypted: "encrypted:retained-token",
      ssh_password_encrypted: null
    }));

    await expect(updateHost(
      "00000000-0000-4000-8000-000000000001",
      { name: "Renamed production" }
    )).resolves.toMatchObject({
      name: "Renamed production",
      connectionMode: "agent"
    });

    expect(updateParameters()?.[11]).toBe("encrypted:retained-token");
    expect(validateAgentUrl).not.toHaveBeenCalled();
  });

  it("explicitly clears an optional encrypted secret", async () => {
    arrangeCurrentHost(hostRow({
      ssh_auth_type: "key",
      ssh_key_encrypted: "encrypted:retained-key",
      ssh_key_passphrase_encrypted: "encrypted:old-passphrase",
      ssh_password_encrypted: null
    }));

    await expect(updateHost(
      "00000000-0000-4000-8000-000000000001",
      { clearSshKeyPassphrase: true }
    )).resolves.toMatchObject({
      connectionMode: "ssh",
      sshAuthType: "key"
    });

    expect(updateParameters()?.[7]).toBe("encrypted:retained-key");
    expect(updateParameters()?.[8]).toBeNull();
  });

  it("locks the duplicate scope and current row before applying a patch", async () => {
    arrangeCurrentHost(hostRow());

    await updateHost(
      "00000000-0000-4000-8000-000000000001",
      { name: "Serialized production" }
    );

    expect(String(query.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock");
    expect(String(query.mock.calls[1]?.[0])).toContain("FOR UPDATE");
    expect(String(query.mock.calls[2]?.[1]?.[0])).toContain(
      "docker-mutation-admission:"
    );
    expect(String(query.mock.calls.at(-1)?.[0])).toContain("deleted_at IS NULL");
  });

  it("does not permanently block host updates after a read-only worker loss", async () => {
    arrangeCurrentHost(hostRow(), [{
      id: "00000000-0000-4000-8000-000000000099",
      type: "host.check",
      status: "failed",
      error: "WORKER_LOST: retry limit reached",
      result: null
    }]);

    await expect(updateHost(
      "00000000-0000-4000-8000-000000000001",
      { name: "Still manageable" }
    )).resolves.toMatchObject({ name: "Still manageable" });

    const guardCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM operation_jobs AS jobs")
    );
    expect(guardCall?.[1]?.[1]).not.toContain("host.check");
  });

  it("blocks host updates while a mutating remote outcome is unresolved", async () => {
    arrangeCurrentHost(hostRow(), [{
      id: "00000000-0000-4000-8000-000000000099",
      type: "container.restart",
      status: "failed",
      error: "REMOTE_OUTCOME_UNKNOWN: connection reset",
      result: null
    }]);

    await expect(updateHost(
      "00000000-0000-4000-8000-000000000001",
      { name: "Must wait" }
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: "00000000-0000-4000-8000-000000000099"
    });
    expect(updateParameters()).toBeUndefined();
  });

  it("strips legacy URL credentials before an agent worker connection", async () => {
    query.mockResolvedValueOnce({
      rows: [hostRow({
        connection_mode: "agent",
        agent_url: "https://legacy-user:legacy-secret@agent.example.test/path?token=legacy-secret#fragment",
        agent_token_encrypted: "encrypted:separate-token",
        ssh_password_encrypted: null
      })]
    });

    await expect(
      getHostForWorker("00000000-0000-4000-8000-000000000001")
    ).resolves.toMatchObject({
      agent: {
        url: "https://agent.example.test/path",
        token: "separate-token"
      }
    });
  });

  it("validates and scrubs the effective credential set when restoring a host", async () => {
    const deleted = hostRow({
      connection_mode: "agent",
      agent_url: "https://agent.example.test",
      agent_token_encrypted: "encrypted:active-agent-token",
      ssh_key_encrypted: "encrypted:inactive-key",
      ssh_key_passphrase_encrypted: "encrypted:inactive-passphrase",
      ssh_password_encrypted: "encrypted:inactive-password",
      deleted_at: new Date(0)
    });
    query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock") || sql.includes("SELECT id FROM docker_hosts")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT *") && sql.includes("FROM docker_hosts")) {
        return { rows: [deleted] };
      }
      if (
        sql.includes("FROM operation_jobs AS jobs")
        || sql.includes("FROM recovery_restore_attempts")
        || sql.includes("FROM recovery_points")
      ) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE docker_hosts")) {
        return {
          rows: [hostRow({
            id: values[0],
            name: values[1],
            hostname: values[2],
            port: values[3],
            username: values[4],
            connection_mode: values[5],
            ssh_auth_type: values[6],
            ssh_key_encrypted: values[7],
            ssh_key_passphrase_encrypted: values[8],
            ssh_password_encrypted: values[9],
            agent_url: values[10],
            agent_token_encrypted: values[11],
            docker_socket_path: values[12],
            tags: values[13],
            last_status: "unknown",
            last_seen_at: null,
            last_error: null,
            docker_version: null,
            compose_version: null,
            agent_version: null,
            deleted_at: null
          })]
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(restoreHost(deleted.id)).resolves.toMatchObject({
      connectionMode: "agent",
      agentUrl: "https://agent.example.test/",
      lastStatus: "unknown",
      lastSeenAt: null,
      lastError: null,
      dockerVersion: null,
      composeVersion: null,
      agentVersion: null
    });
    expect(validateAgentUrl).toHaveBeenCalledWith("https://agent.example.test");
    const update = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE docker_hosts"));
    const sql = String(update?.[0]);
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
    const values = update?.[1] as unknown[];
    expect(values.slice(7, 10)).toEqual([null, null, null]);
    expect(values[11]).toBe("encrypted:active-agent-token");
  });

  it("rejects a deleted legacy host with an unsafe effective agent URL before restore", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("SELECT *") && sql.includes("FROM docker_hosts")) {
        return {
          rows: [hostRow({
            connection_mode: "agent",
            agent_url: "https://agent-user:agent-secret@agent.example.test",
            agent_token_encrypted: "encrypted:separate-token",
            ssh_password_encrypted: null,
            deleted_at: new Date(0)
          })]
        };
      }
      if (
        sql.includes("FROM operation_jobs AS jobs")
        || sql.includes("FROM recovery_restore_attempts")
        || sql.includes("FROM recovery_points")
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(restoreHost("00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("Agent URL must not contain embedded credentials");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE docker_hosts"))).toBe(false);
    expect(validateAgentUrl).not.toHaveBeenCalled();
  });
});
