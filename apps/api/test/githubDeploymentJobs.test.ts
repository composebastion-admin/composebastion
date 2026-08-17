import { createHash } from "node:crypto";
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
  cancelQueuedJob,
  completeJob,
  failJob,
  recoverExpiredJobs
} = await import("../src/services/jobs.js");
const {
  resolveGithubDeploymentBindingAfterReconciliation
} = await import("../src/services/githubDeploymentBinding.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const repositoryId = "22222222-2222-4222-8222-222222222222";
const stackId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const oldJobId = "55555555-5555-4555-8555-555555555555";
const workerId = "66666666-6666-4666-8666-666666666666";
const lease = { workerId, attemptCount: 1 };
const sourceCommitSha = "a".repeat(40);
const newerCommitSha = "b".repeat(40);
const composeYaml = "services: {}\n";
const composeSha256 = createHash("sha256")
  .update(composeYaml, "utf8")
  .digest("hex");

function jobRow(id = jobId, status = "running") {
  return {
    id,
    type: "compose.deploy",
    status,
    host_id: hostId,
    payload: { stackId },
    result: null,
    progress: [],
    error: null,
    created_by: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    started_at: new Date(0),
    completed_at: null,
    lease_owner: workerId,
    lease_expires_at: new Date(Date.now() + 60_000),
    attempt_count: 1
  };
}

function completedApiDeploymentProof() {
  return {
    remoteMutationProof: {
      operationId: "f".repeat(64),
      jobId,
      attemptCount: 1,
      sequence: 3,
      phase: "compose.deploy",
      transport: "ssh",
      timeoutMs: 60_000,
      status: "terminal",
      terminalState: "completed"
    }
  };
}

function successfulBindingImplementation(
  operationJobId = jobId,
  commitSha = sourceCommitSha,
  customCompose = false,
  stackComposeYaml = composeYaml
) {
  return async (sql: string, values?: unknown[]) => {
    if (sql.includes("UPDATE operation_jobs") && sql.includes("status = 'completed'")) {
      return { rows: [{ id: operationJobId }], rowCount: 1 };
    }
    if (sql.includes("FROM github_deployment_jobs") && sql.includes("FOR UPDATE")) {
      expect(values).toEqual([operationJobId]);
      return {
        rows: [{
          repository_id: repositoryId,
          stack_id: stackId,
          source_repository_url: "https://github.com/acme/app",
          source_branch: "release",
          source_compose_path: "compose.yml",
          source_commit_sha: commitSha,
          compose_sha256: composeSha256,
          custom_compose: customCompose
        }],
        rowCount: 1
      };
    }
    if (sql.includes("FROM compose_stacks") && sql.includes("source_repository_url")) {
      return {
        rows: [{
          compose_yaml: stackComposeYaml,
          source_repository_url: "https://github.com/acme/app",
          source_branch: "release",
          source_compose_path: "compose.yml"
        }],
        rowCount: 1
      };
    }
    if (sql.includes("FROM github_repositories") && sql.includes("repository_url")) {
      return {
        rows: [{
          repository_url: "https://github.com/acme/app",
          branch: "main",
          compose_path: "compose.yml"
        }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 1 };
  };
}

describe("GitHub API deployment completion binding", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
  });

  it("stamps repository success and deployed commit only inside exact leased completion", async () => {
    transactionQuery.mockImplementation(successfulBindingImplementation());

    await expect(completeJob(jobId, { ok: true }, lease)).resolves.toBe(true);

    const stackUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE compose_stacks")
      && String(sql).includes("source_current_commit_sha")
    );
    const repositoryUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE github_repositories")
      && String(sql).includes("last_deployed_at")
    );
    expect(stackUpdate?.[1]).toEqual([stackId, sourceCommitSha, false]);
    expect(repositoryUpdate?.[1]).toEqual([repositoryId, sourceCommitSha, false]);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(true);
  });

  it("does not touch the binding or success fields after a stale lease loses completion", async () => {
    transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(completeJob(jobId, { ok: true }, lease)).resolves.toBe(false);

    expect(transactionQuery).toHaveBeenCalledTimes(1);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("github_deployment_jobs")
    )).toBe(false);
  });

  it("preserves prior deployment success while recording a failed attempt", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE operation_jobs") && sql.includes("status = 'failed'")) {
        return { rows: [jobRow(jobId, "failed")], rowCount: 1 };
      }
      if (sql.includes("FROM github_deployment_jobs") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            repository_id: repositoryId,
            stack_id: stackId,
            source_repository_url: "https://github.com/acme/app",
            source_branch: "release",
            source_compose_path: "compose.yml",
            source_commit_sha: sourceCommitSha,
            compose_sha256: composeSha256,
            custom_compose: false
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(failJob(jobId, new Error("compose failed"), lease)).resolves.toBe(true);

    const repositoryUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE github_repositories")
      && String(sql).includes("last_error")
    );
    expect(repositoryUpdate?.[0]).toContain("SET last_error = $2");
    expect(repositoryUpdate?.[1]).toEqual([repositoryId, "compose failed"]);
    expect(repositoryUpdate?.[0]).not.toContain("last_deployed_at");
    expect(repositoryUpdate?.[0]).not.toContain("last_deployed_commit_sha");
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(true);
  });

  it("retains the binding and repository/stack locks when a remote outcome is ambiguous", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE operation_jobs") && sql.includes("status = 'failed'")) {
        return { rows: [jobRow(jobId, "failed")], rowCount: 1 };
      }
      if (sql.includes("FROM github_deployment_jobs") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            repository_id: repositoryId,
            stack_id: stackId,
            source_repository_url: "https://github.com/acme/app",
            source_branch: "release",
            source_compose_path: "compose.yml",
            source_commit_sha: sourceCommitSha,
            compose_sha256: composeSha256,
            custom_compose: false
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const message = "REMOTE_OUTCOME_UNKNOWN: compose.deploy response was lost";
    await expect(failJob(jobId, new Error(message), lease)).resolves.toBe(true);

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("UPDATE compose_stacks")
      && Array.isArray(values)
      && values[1] === message
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("UPDATE github_repositories")
      && Array.isArray(values)
      && values[1] === message
    )).toBe(true);
  });

  it("promotes a post-deploy local failure to authoritative reconciliation", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE operation_jobs") && sql.includes("status = 'failed'")) {
        return {
          rows: [{
            ...jobRow(jobId, "failed"),
            result: completedApiDeploymentProof()
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM github_deployment_jobs") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            repository_id: repositoryId,
            stack_id: stackId,
            source_repository_url: "https://github.com/acme/app",
            source_branch: "release",
            source_compose_path: "compose.yml",
            source_commit_sha: sourceCommitSha,
            compose_sha256: composeSha256,
            custom_compose: false
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(failJob(
      jobId,
      new Error("inventory refresh failed"),
      lease
    )).resolves.toBe(true);

    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("SET error = $2")
      && Array.isArray(values)
      && String(values[1]).startsWith("REMOTE_OUTCOME_UNKNOWN:")
      && String(values[1]).includes("inventory refresh failed")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(false);
  });

  it("retains the binding after an expired worker lease", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        return {
          rows: [{
            ...jobRow(jobId, "running"),
            lease_expires_at: new Date(0)
          }],
          rowCount: 1
        };
      }
      if (sql.includes("FROM github_deployment_jobs") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            repository_id: repositoryId,
            stack_id: stackId,
            source_repository_url: "https://github.com/acme/app",
            source_branch: "release",
            source_compose_path: "compose.yml",
            source_commit_sha: sourceCommitSha,
            compose_sha256: composeSha256,
            custom_compose: false
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverExpiredJobs()).resolves.toEqual({
      requeued: 0,
      failed: 1
    });

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("UPDATE github_repositories")
      && Array.isArray(values)
      && String(values[1]).startsWith("WORKER_LOST:")
    )).toBe(true);
  });

  it("discards a retained binding as failure unless exact compose.deploy proof completed", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM github_deployment_jobs") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            repository_id: repositoryId,
            stack_id: stackId,
            source_repository_url: "https://github.com/acme/app",
            source_branch: "release",
            source_compose_path: "compose.yml",
            source_commit_sha: sourceCommitSha,
            compose_sha256: composeSha256,
            custom_compose: false
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(resolveGithubDeploymentBindingAfterReconciliation(
      { query: transactionQuery } as any,
      jobId,
      { phase: "compose.stack.write_files", state: "completed" }
    )).resolves.toMatchObject({
      status: "failed",
      repositoryId,
      stackId,
      deployedSourceCommitSha: null
    });

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("UPDATE compose_stacks")
      && Array.isArray(values)
      && String(values[1]).includes("compose.stack.write_files")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("last_deployed_at")
    )).toBe(false);
  });

  it("cancels a queued attempt without claiming repository deployment success", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE operation_jobs")) {
        return {
          rows: [{
            ...jobRow(jobId, "canceled"),
            error: "Canceled before start"
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(cancelQueuedJob(jobId)).resolves.toMatchObject({
      canceled: true,
      job: { status: "canceled" }
    });

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_deployment_jobs")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("last_deployed_at")
    )).toBe(false);
  });

  it("cannot let an older stale attempt overwrite a newer completion", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(completeJob(oldJobId, { ok: true }, lease)).resolves.toBe(false);

    transactionQuery.mockImplementation(successfulBindingImplementation(jobId, newerCommitSha));
    await expect(completeJob(jobId, { ok: true }, lease)).resolves.toBe(true);

    const successValues = transactionQuery.mock.calls
      .filter(([sql]) => String(sql).includes("last_deployed_at"))
      .map(([, values]) => values);
    expect(successValues).toEqual([[repositoryId, newerCommitSha, false]]);
    expect(JSON.stringify(transactionQuery.mock.calls)).not.toContain("older-commit");
  });

  it("records a custom Compose deployment without falsely claiming upstream commit bytes", async () => {
    transactionQuery.mockImplementation(
      successfulBindingImplementation(jobId, sourceCommitSha, true)
    );

    await expect(completeJob(jobId, { ok: true }, lease)).resolves.toBe(true);

    const stackUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE compose_stacks")
      && String(sql).includes("source_current_commit_sha")
    );
    const repositoryUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE github_repositories")
      && String(sql).includes("last_deployed_at")
    );
    expect(stackUpdate?.[0]).toContain("WHEN $3::boolean THEN NULL");
    expect(repositoryUpdate?.[0]).toContain("WHEN $3::boolean THEN NULL");
    expect(stackUpdate?.[1]).toEqual([stackId, sourceCommitSha, true]);
    expect(repositoryUpdate?.[1]).toEqual([repositoryId, sourceCommitSha, true]);
  });

  it("refuses to stamp success when queued Compose bytes changed before completion", async () => {
    transactionQuery.mockImplementation(
      successfulBindingImplementation(
        jobId,
        sourceCommitSha,
        false,
        "services:\n  tampered: {}\n"
      )
    );

    await expect(completeJob(jobId, { ok: true }, lease)).rejects.toThrow(
      "deployment identity changed before completion"
    );

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("source_current_commit_sha = CASE")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("last_deployed_at = now()")
    )).toBe(false);
  });
});
