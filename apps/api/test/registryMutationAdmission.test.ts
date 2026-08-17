import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  writeAuditEvent: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/audit.js", () => ({
  writeAuditEvent: (...args: unknown[]) => mocks.writeAuditEvent(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

vi.mock("../src/services/crypto.js", () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.replace(/^encrypted:/, "")
}));

const { deploymentEnvironmentBinding } = await import(
  "../src/services/deploymentEnvironment.js"
);
const {
  deleteRegistry,
  enqueueRegistryLogin,
  lockRegistryForMutation
} = await import("../src/services/registries.js");

const registryId = "10000000-0000-4000-8000-000000000001";
const hostId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";
const registryRow = {
  id: registryId,
  url: "https://registry.example.test",
  insecure: false
};

describe("registry credential mutation admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.transactionQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (
      callback: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => callback({ query: mocks.transactionQuery }));
    mocks.writeAuditEvent.mockResolvedValue(undefined);
    mocks.enqueueJobInTransaction.mockResolvedValue({
      id: jobId,
      type: "registry.login",
      hostId,
      status: "queued"
    });
    mocks.notifyJobQueued.mockResolvedValue(undefined);
  });

  it.each([
    {
      status: "running",
      error: null,
      result: null,
      message: "queued or running"
    },
    {
      status: "failed",
      error: "REMOTE_OUTCOME_UNKNOWN: login timed out",
      result: null,
      message: "outcome is reconciled"
    }
  ])("blocks deletion for a $status registry login", async ({ status, error, result, message }) => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM registries")) return { rows: [registryRow] };
      if (sql.includes("type = 'registry.login'")) {
        return { rows: [{ id: jobId, status, error, result }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(deleteRegistry(registryId, { userId: "owner" }))
      .rejects.toMatchObject({
        statusCode: 409,
        activeJobId: jobId,
        message: expect.stringContaining(message)
      });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      String(sql).startsWith("DELETE FROM registries")
    )).toBe(false);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("blocks a deployment that resolves the credential inside the worker", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM registries")) return { rows: [registryRow] };
      if (sql.includes("type = 'registry.login'")) return { rows: [] };
      if (sql.includes("JOIN deployment_analyses")) {
        return {
          rows: [{
            id: jobId,
            status: "queued",
            error: null,
            result: null,
            analysis_error: null,
            compose_yaml: "services:\n  app:\n    image: registry.example.test/team/app:latest\n"
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(lockRegistryForMutation(
      { query: mocks.transactionQuery } as any,
      registryId
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
  });

  it("resolves an interpolated deployment registry from its authenticated environment", async () => {
    const environment = "REGISTRY='registry.example.test'";
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM registries")) return { rows: [registryRow] };
      if (sql.includes("type = 'registry.login'")) return { rows: [] };
      if (sql.includes("JOIN deployment_analyses")) {
        return {
          rows: [{
            id: jobId,
            status: "queued",
            error: null,
            result: null,
            analysis_error: null,
            compose_yaml: "services:\n  app:\n    image: ${REGISTRY}/team/app:latest\n",
            analysis_env_encrypted: `encrypted:${environment}`,
            analysis_environment_sha256: deploymentEnvironmentBinding(environment)
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(lockRegistryForMutation(
      { query: mocks.transactionQuery } as any,
      registryId
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
  });

  it("does not block an unrelated authenticated interpolated deployment registry", async () => {
    const environment = "REGISTRY='unrelated.example.test'";
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM registries")) return { rows: [registryRow] };
      if (sql.includes("type = 'registry.login'")) return { rows: [] };
      if (sql.includes("JOIN deployment_analyses")) {
        return {
          rows: [{
            id: jobId,
            status: "queued",
            error: null,
            result: null,
            analysis_error: null,
            compose_yaml: "services:\n  app:\n    image: ${REGISTRY}/team/app:latest\n",
            analysis_env_encrypted: `encrypted:${environment}`,
            analysis_environment_sha256: deploymentEnvironmentBinding(environment)
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(lockRegistryForMutation(
      { query: mocks.transactionQuery } as any,
      registryId
    )).resolves.toEqual(registryRow);
  });

  it("fails closed when an interpolated deployment environment binding is corrupt", async () => {
    const environment = "REGISTRY='unrelated.example.test'";
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM registries")) return { rows: [registryRow] };
      if (sql.includes("type = 'registry.login'")) return { rows: [] };
      if (sql.includes("JOIN deployment_analyses")) {
        return {
          rows: [{
            id: jobId,
            status: "queued",
            error: null,
            result: null,
            analysis_error: null,
            compose_yaml: "services:\n  app:\n    image: ${REGISTRY}/team/app:latest\n",
            analysis_env_encrypted: `encrypted:${environment}`,
            analysis_environment_sha256: "0".repeat(64)
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(lockRegistryForMutation(
      { query: mocks.transactionQuery } as any,
      registryId
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: jobId });
  });

  it("preserves unrelated deployments and records deletion audit in the same transaction", async () => {
    const transactionClient = { query: mocks.transactionQuery };
    mocks.withTransaction.mockImplementation(async (
      callback: (client: typeof transactionClient) => Promise<unknown>
    ) => callback(transactionClient));
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM registries")) return { rows: [registryRow] };
      if (sql.includes("type = 'registry.login'")) return { rows: [] };
      if (sql.includes("JOIN deployment_analyses")) {
        return {
          rows: [{
            id: jobId,
            status: "running",
            error: null,
            result: null,
            analysis_error: null,
            compose_yaml: "services:\n  app:\n    image: unrelated.example.test/team/app:latest\n"
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(deleteRegistry(registryId, { userId: "owner" })).resolves.toBe(true);
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      String(sql).startsWith("DELETE FROM registries")
    )).toBe(true);
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith({
      userId: "owner",
      action: "registry.delete",
      targetKind: "registry",
      targetId: registryId,
      details: { authority: "registry.example.test" }
    }, transactionClient);
  });

  it("locks the credential row through login job insertion", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM registries") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: registryId }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(enqueueRegistryLogin(hostId, registryId, "owner"))
      .resolves.toMatchObject({ id: jobId });

    expect(mocks.transactionQuery.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(mocks.enqueueJobInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.transactionQuery }),
      { type: "registry.login", hostId, payload: { registryId } },
      "owner"
    );
    expect(mocks.notifyJobQueued).toHaveBeenCalledWith(jobId);
  });

  it("does not publish a registry login job when its transactional audit fails", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM registries") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: registryId }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const auditFailure = new Error("audit insert failed");
    mocks.writeAuditEvent.mockRejectedValueOnce(auditFailure);

    await expect(enqueueRegistryLogin(
      hostId,
      registryId,
      "owner",
      {
        ipAddress: "192.0.2.10",
        userAgent: "qualification-client"
      }
    )).rejects.toBe(auditFailure);

    expect(mocks.writeAuditEvent).toHaveBeenCalledWith({
      userId: "owner",
      hostId,
      action: "registry.login",
      targetKind: "registry",
      targetId: registryId,
      ipAddress: "192.0.2.10",
      userAgent: "qualification-client"
    }, expect.objectContaining({ query: mocks.transactionQuery }));
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });
});
