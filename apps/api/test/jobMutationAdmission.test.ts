import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: async (
    callback: (client: { query: typeof transactionQuery }) => Promise<unknown>
  ) => callback({ query: transactionQuery })
}));
vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

const {
  enqueueJob,
  lockComposeStackForMutation,
  lockGithubRepositoryForMutation,
  withSynchronousDockerMutationAdmission
} = await import("../src/services/jobs.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const stackId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";

describe("job target mutation admission", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
  });

  it("serializes stack edits with enqueue and rejects an already queued Compose operation", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: stackId, host_id: hostId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: jobId, status: "queued", error: null, result: null }]
      });

    await expect(lockComposeStackForMutation(
      { query: transactionQuery } as any,
      stackId
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("cannot be changed")
    });

    expect(transactionQuery.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(transactionQuery.mock.calls[1]?.[1]).toEqual([
      `compose-stack:${hostId}:${stackId}`
    ]);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).startsWith("UPDATE compose_stacks")
    )).toBe(false);
  });

  it("keeps an ambiguous stack immutable until durable authoritative reconciliation", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: stackId, host_id: hostId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: jobId,
          status: "failed",
          error: "WORKER_LOST: lease expired",
          result: null
        }]
      });

    await expect(lockComposeStackForMutation(
      { query: transactionQuery } as any,
      stackId
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("authoritatively reconciled")
    });

    transactionQuery.mockReset();
    const stack = { id: stackId, host_id: hostId };
    transactionQuery
      .mockResolvedValueOnce({ rows: [stack] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: jobId,
          status: "failed",
          error: "WORKER_LOST: lease expired",
          result: {
            remoteOutcomeReconciliation: {
              status: "reconciled",
              inspectedAt: new Date().toISOString()
            }
          }
        }]
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(lockComposeStackForMutation(
      { query: transactionQuery } as any,
      stackId
    )).resolves.toEqual(stack);
  });

  it("blocks repository mutation or deletion for both API and host-clone deployments", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: repositoryId }] })
      .mockResolvedValueOnce({ rows: [{ operation_job_id: jobId }] });
    await expect(lockGithubRepositoryForMutation(
      { query: transactionQuery } as any,
      repositoryId
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("outcome is unresolved")
    });

    transactionQuery.mockReset();
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: repositoryId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: jobId, status: "running", error: null, result: null }]
      });
    await expect(lockGithubRepositoryForMutation(
      { query: transactionQuery } as any,
      repositoryId
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("clone/build deployment")
    });
  });

  it("blocks a fresh path deployment behind an unreconciled stale command", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("status IN ('queued', 'running')")) return { rows: [] };
      if (sql.includes("status = 'failed'")) {
        return {
          rows: [{
            id: jobId,
            type: "compose.deployPath",
            status: "failed",
            host_id: hostId,
            payload: {
              workingDir: "/srv/apps/example",
              projectName: "example",
              composePath: "compose.yml"
            },
            error: "REMOTE_OUTCOME_UNKNOWN: SSH command timed out",
            result: null,
            completed_at: new Date()
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(enqueueJob({
      type: "compose.writeDeployPath",
      hostId,
      payload: {
        workingDir: "/srv/apps/example",
        projectName: "example",
        composePath: "compose.yml",
        composeYaml: "services: {}\n",
        overwrite: true,
        pullBeforeDeploy: false
      }
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("unknown outcome")
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )).toBe(false);
  });

  it("blocks a generic Docker mutation behind an unreconciled deployment analysis on the same host", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("FROM recovery_restore_attempts")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("status IN ('queued', 'running')")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("status = 'failed'")) {
        return {
          rows: [{
            id: jobId,
            type: "deploy.analyze",
            status: "failed",
            host_id: hostId,
            payload: {
              analysisId: "55555555-5555-4555-8555-555555555555"
            },
            error: "REMOTE_OUTCOME_UNKNOWN: SSH transport disconnected",
            result: null,
            completed_at: new Date()
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(enqueueJob({
      type: "container.start",
      hostId,
      payload: { containerId: "example-container" }
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("unknown outcome")
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )).toBe(false);
  });

  it("rejects a synchronous host-file mutation while a path deployment owns the host", async () => {
    const remoteWrite = vi.fn(async () => ({ path: "/srv/apps/example/compose.yml" }));
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("FROM recovery_restore_attempts")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("status IN ('queued', 'running')")) {
        return {
          rows: [{
            id: jobId,
            type: "compose.deployPath",
            status: "running",
            host_id: hostId,
            payload: {
              workingDir: "/srv/apps/example",
              projectName: "example",
              composePath: "compose.yml"
            },
            error: null,
            result: null
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(withSynchronousDockerMutationAdmission(
      {
        type: "host.mkdir",
        hostId,
        payload: { path: "/srv/apps/example/compose.yml" }
      },
      remoteWrite
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("remote mutation")
    });

    expect(remoteWrite).not.toHaveBeenCalled();
    const hostRowIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("FROM docker_hosts")
    );
    const firstAdvisoryIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock")
    );
    expect(String(transactionQuery.mock.calls[hostRowIndex]?.[0])).toContain("FOR SHARE");
    expect(firstAdvisoryIndex).toBeGreaterThan(hostRowIndex);
  });
});
