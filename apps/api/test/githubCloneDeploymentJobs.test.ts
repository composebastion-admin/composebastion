import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/services/crypto.js";
import {
  deploymentEnvironmentBinding
} from "../src/services/deploymentEnvironment.js";

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

const { completeJob, failJob } = await import("../src/services/jobs.js");
const {
  resolveGithubCloneDeploymentBindingAfterReconciliation
} = await import("../src/services/githubCloneDeploymentBinding.js");

const repositoryId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const stackId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const workerId = "55555555-5555-4555-8555-555555555555";
const lease = { workerId, attemptCount: 1 };
const sourceCommitSha = "a".repeat(40);
const composeYaml = "services:\n  app:\n    image: example/app:1\n";
const composeSha256 = createHash("sha256")
  .update(composeYaml, "utf8")
  .digest("hex");
const environment = "APP_TOKEN='qualified-secret'";
const environmentBinding = deploymentEnvironmentBinding(environment);
const cloneUrl = "git@github-private-app:owner/private-app.git";
const sourceUrl = "https://github.com/owner/private-app";
const workingDir = "/srv/apps/private-app";
const composePath = "docker-compose.yml";
const absoluteComposePath = `${workingDir}/${composePath}`;

function cloneBindingRow() {
  return {
    repository_id: repositoryId,
    host_id: hostId,
    stack_id: stackId,
    source_repository_url: sourceUrl,
    clone_repository_url: cloneUrl,
    source_branch: "release",
    source_commit_sha: sourceCommitSha,
    source_compose_path: composePath,
    compose_yaml: composeYaml,
    compose_sha256: composeSha256,
    project_name: "private-app",
    working_dir: workingDir,
    environment_encrypted: encryptSecret(environment),
    environment_binding: environmentBinding
  };
}

function stackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: stackId,
    host_id: hostId,
    project_name: "private-app",
    compose_yaml: composeYaml,
    env: environment,
    status: "created",
    source_type: "git",
    source_repository_url: cloneUrl,
    source_branch: "release",
    source_working_dir: workingDir,
    source_compose_path: absoluteComposePath,
    source_current_commit_sha: sourceCommitSha,
    source_environment_encrypted: encryptSecret(environment),
    source_environment_binding: environmentBinding,
    ...overrides
  };
}

function completedCloneProof() {
  return {
    remoteMutationProof: {
      operationId: "f".repeat(64),
      jobId,
      attemptCount: 1,
      sequence: 4,
      phase: "compose.deployPath.up",
      transport: "ssh",
      timeoutMs: 60_000,
      status: "terminal",
      terminalState: "completed"
    }
  };
}

function failedJobRow(result: Record<string, unknown> | null = null) {
  return {
    id: jobId,
    type: "git.cloneDeploy",
    status: "failed",
    host_id: hostId,
    payload: {
      repositoryId,
      repositoryUrl: cloneUrl,
      directory: workingDir,
      branch: "release",
      composePath,
      projectName: "private-app",
      sourceCommitSha,
      composeSha256
    },
    result,
    progress: [],
    error: null,
    created_by: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    started_at: new Date(0),
    completed_at: new Date(0),
    lease_owner: workerId,
    lease_expires_at: new Date(Date.now() + 60_000),
    attempt_count: 1
  };
}

function bindingQueryImplementation(options: {
  jobTransition: "completed" | "failed";
  stack?: Record<string, unknown>;
  jobResult?: Record<string, unknown> | null;
}) {
  return async (sql: string) => {
    if (
      sql.includes("UPDATE operation_jobs")
      && sql.includes(`status = '${options.jobTransition}'`)
    ) {
      return {
        rows: options.jobTransition === "completed"
          ? [{ id: jobId }]
          : [failedJobRow(options.jobResult)],
        rowCount: 1
      };
    }
    if (
      sql.includes("FROM github_deployment_jobs")
      && sql.includes("FOR UPDATE")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("FROM github_clone_deployment_jobs")
      && sql.includes("FOR UPDATE")
    ) {
      return { rows: [cloneBindingRow()], rowCount: 1 };
    }
    if (sql.includes("FROM compose_stacks") && sql.includes("FOR UPDATE")) {
      return { rows: [options.stack ?? stackRow()], rowCount: 1 };
    }
    if (
      sql.includes("FROM github_repositories")
      && sql.includes("FOR UPDATE")
    ) {
      return {
        rows: [{
          repository_url: sourceUrl,
          compose_path: composePath,
          host_clone_url: cloneUrl,
          host_clone_directory: workingDir
        }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 1 };
  };
}

describe("tracked GitHub clone deployment binding", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
  });

  it("stamps only the exact queued commit when leased completion validates the stack snapshot", async () => {
    transactionQuery.mockImplementation(bindingQueryImplementation({
      jobTransition: "completed"
    }));

    await expect(completeJob(
      jobId,
      {
        currentCommitSha: sourceCommitSha,
        composeSha256
      },
      lease
    )).resolves.toBe(true);

    const stackUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE compose_stacks")
      && String(sql).includes("source_current_commit_sha = $2")
    );
    const repositoryUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE github_repositories")
      && String(sql).includes("last_deployed_at")
    );
    expect(stackUpdate?.[1]).toEqual([stackId, sourceCommitSha]);
    expect(repositoryUpdate?.[1]).toEqual([
      repositoryId,
      sourceCommitSha
    ]);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_clone_deployment_jobs")
    )).toBe(true);
  });

  it("keeps the encrypted binding on an ambiguous transport outcome", async () => {
    transactionQuery.mockImplementation(bindingQueryImplementation({
      jobTransition: "failed"
    }));

    await expect(failJob(
      jobId,
      new Error("REMOTE_OUTCOME_UNKNOWN: compose response was lost"),
      lease
    )).resolves.toBe(true);

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_clone_deployment_jobs")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("UPDATE github_repositories")
      && Array.isArray(values)
      && String(values[1]).startsWith("REMOTE_OUTCOME_UNKNOWN:")
    )).toBe(true);
  });

  it("retains completed Compose-up proof when later local finalization fails", async () => {
    transactionQuery.mockImplementation(bindingQueryImplementation({
      jobTransition: "failed",
      jobResult: completedCloneProof()
    }));

    await expect(failJob(
      jobId,
      new Error("inventory refresh failed"),
      lease
    )).resolves.toBe(true);

    const promotedFailure = transactionQuery.mock.calls.find(([sql, values]) =>
      String(sql).includes("SET error = $2")
      && Array.isArray(values)
      && String(values[1]).startsWith("REMOTE_OUTCOME_UNKNOWN:")
    );
    expect(promotedFailure?.[1]).toEqual([
      jobId,
      expect.stringContaining("inventory refresh failed")
    ]);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_clone_deployment_jobs")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql, values]) =>
      String(sql).includes("UPDATE github_repositories")
      && Array.isArray(values)
      && String(values[1]).startsWith("REMOTE_OUTCOME_UNKNOWN:")
    )).toBe(true);
  });

  it("discards the binding after an authoritative ordinary failure", async () => {
    transactionQuery.mockImplementation(bindingQueryImplementation({
      jobTransition: "failed"
    }));

    await expect(failJob(
      jobId,
      new Error("git checkout rejected local changes"),
      lease
    )).resolves.toBe(true);

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_clone_deployment_jobs")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("last_deployed_at")
    )).toBe(false);
  });

  it("does not stamp success when terminal proof stopped before Compose up", async () => {
    transactionQuery.mockImplementation(bindingQueryImplementation({
      jobTransition: "failed"
    }));

    await expect(resolveGithubCloneDeploymentBindingAfterReconciliation(
      { query: transactionQuery } as any,
      jobId,
      {
        phase: "git.cloneDeploy.checkout",
        state: "completed"
      }
    )).resolves.toMatchObject({
      status: "failed",
      repositoryId,
      stackId,
      sourceCommitSha
    });

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("last_deployed_at")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_clone_deployment_jobs")
    )).toBe(true);
  });

  it("fails closed without deleting when completion sees changed Compose bytes", async () => {
    transactionQuery.mockImplementation(bindingQueryImplementation({
      jobTransition: "completed",
      stack: stackRow({
        compose_yaml: "services:\n  tampered: {}\n"
      })
    }));

    await expect(completeJob(
      jobId,
      { currentCommitSha: sourceCommitSha },
      lease
    )).rejects.toThrow("REMOTE_OUTCOME_UNKNOWN:");

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("last_deployed_at")
    )).toBe(false);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM github_clone_deployment_jobs")
    )).toBe(false);
  });
});
