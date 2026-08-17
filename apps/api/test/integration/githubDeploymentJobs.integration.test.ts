import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool, withTransaction } from "../../src/db/pool.js";
import {
  cancelQueuedJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobInTransaction,
  failJob,
  lockComposeStackForMutation,
  lockGithubRepositoryForMutation,
  recoverExpiredJobs
} from "../../src/services/jobs.js";
import {
  resolveGithubDeploymentBindingAfterReconciliation
} from "../../src/services/githubDeploymentBinding.js";
import {
  resolveGithubCloneDeploymentBindingAfterReconciliation
} from "../../src/services/githubCloneDeploymentBinding.js";
import { encryptSecret } from "../../src/services/crypto.js";
import {
  deploymentEnvironmentBinding
} from "../../src/services/deploymentEnvironment.js";
import {
  reconcileAmbiguousRemoteOutcomes
} from "../../src/services/remoteOutcomeReconciliation.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const previousCommitSha = "1".repeat(40);
const nextCommitSha = "2".repeat(40);
const canceledCommitSha = "3".repeat(40);
const expiredCommitSha = "4".repeat(40);
const fixtureComposeYaml = "services: {}";
const fixtureComposeSha256 = createHash("sha256")
  .update(fixtureComposeYaml, "utf8")
  .digest("hex");
const cloneComposeYaml = "services:\n  app:\n    image: example/app:1\n";
const cloneComposeSha256 = createHash("sha256")
  .update(cloneComposeYaml, "utf8")
  .digest("hex");
const cloneEnvironment = "APP_TOKEN='integration-secret'";
const cloneEnvironmentBinding = deploymentEnvironmentBinding(
  cloneEnvironment
);
const cloneUrl = "git@github.example.test:pq-integration/app.git";
const cloneWorkingDir = "/srv/pq-integration/app";
const cloneComposePath = "compose.yml";

describe.skipIf(!integrationEnabled)("GitHub deployment completion binding integration", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM operation_jobs");
    await pool.query("DELETE FROM github_repositories WHERE owner = 'pq-integration'");
    await pool.query("DELETE FROM docker_hosts WHERE name LIKE 'PQ GitHub binding %'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM operation_jobs");
    await pool.query("DELETE FROM github_repositories WHERE owner = 'pq-integration'");
    await pool.query("DELETE FROM docker_hosts WHERE name LIKE 'PQ GitHub binding %'");
    await pool.end();
  });

  async function fixtures() {
    const hostId = randomUUID();
    const repositoryId = randomUUID();
    const stackId = randomUUID();
    await pool.query(
      `INSERT INTO docker_hosts
         (id, name, hostname, port, username, docker_socket_path, connection_mode, ssh_auth_type, tags)
       VALUES ($1, $2, '127.0.0.1', 22, 'docker', '/var/run/docker.sock', 'ssh', 'key', '{}')`,
      [hostId, `PQ GitHub binding ${hostId}`]
    );
    await pool.query(
      `INSERT INTO github_repositories
         (id, name, repository_url, owner, repo, branch, compose_path, project_name,
          default_host_id, last_deployed_commit_sha)
       VALUES ($1, 'PQ app', 'https://github.com/pq-integration/app', 'pq-integration',
               $2, 'main', 'compose.yml', $3, $4, $5)`,
      [
        repositoryId,
        `app-${repositoryId}`,
        `pq-${repositoryId}`,
        hostId,
        previousCommitSha
      ]
    );
    await pool.query(
      `INSERT INTO compose_stacks
         (id, host_id, name, project_name, compose_yaml, status, source_type,
          source_repository_url, source_branch, source_compose_path,
          source_current_commit_sha, source_latest_commit_sha)
       VALUES ($1, $2, 'PQ app', $3, $4, 'created', 'github',
               'https://github.com/pq-integration/app', 'main', 'compose.yml',
               $5, $6)`,
      [
        stackId,
        hostId,
        `pq-${repositoryId}`,
        fixtureComposeYaml,
        previousCommitSha,
        nextCommitSha
      ]
    );
    return { hostId, repositoryId, stackId };
  }

  async function queueBoundDeployment(
    fixture: Awaited<ReturnType<typeof fixtures>>,
    commitSha = nextCommitSha,
    customCompose = false
  ) {
    return withTransaction(async (client) => {
      const job = await enqueueJobInTransaction(client, {
        type: "compose.deploy",
        hostId: fixture.hostId,
        payload: { stackId: fixture.stackId }
      });
      await client.query(
        `INSERT INTO github_deployment_jobs
           (operation_job_id, repository_id, stack_id, source_repository_url,
            source_branch, source_compose_path, source_commit_sha,
            compose_sha256, custom_compose)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          job.id,
          fixture.repositoryId,
          fixture.stackId,
          "https://github.com/pq-integration/app",
          "main",
          "compose.yml",
          commitSha,
          fixtureComposeSha256,
          customCompose
        ]
      );
      return job;
    });
  }

  async function queueBoundCloneDeployment(
    fixture: Awaited<ReturnType<typeof fixtures>>
  ) {
    await pool.query(
      `UPDATE github_repositories
       SET host_clone_url = $2,
           host_clone_directory = $3
       WHERE id = $1`,
      [fixture.repositoryId, cloneUrl, cloneWorkingDir]
    );
    await pool.query(
      `UPDATE compose_stacks
       SET compose_yaml = $2,
           env = $3,
           status = 'created',
           source_type = 'git',
           source_repository_url = $4,
           source_branch = 'main',
           source_working_dir = $5,
           source_compose_path = $6,
           source_current_commit_sha = NULL,
           source_environment_encrypted = $7,
           source_environment_binding = $8
       WHERE id = $1`,
      [
        fixture.stackId,
        cloneComposeYaml,
        cloneEnvironment,
        cloneUrl,
        cloneWorkingDir,
        `${cloneWorkingDir}/${cloneComposePath}`,
        encryptSecret(cloneEnvironment),
        cloneEnvironmentBinding
      ]
    );
    return withTransaction(async (client) => {
      const job = await enqueueJobInTransaction(client, {
        type: "git.cloneDeploy",
        hostId: fixture.hostId,
        payload: {
          repositoryId: fixture.repositoryId,
          repositoryUrl: cloneUrl,
          directory: cloneWorkingDir,
          branch: "main",
          composePath: cloneComposePath,
          projectName: `pq-${fixture.repositoryId}`,
          sourceCommitSha: nextCommitSha,
          composeSha256: cloneComposeSha256
        }
      });
      await client.query(
        `INSERT INTO github_clone_deployment_jobs (
           operation_job_id, repository_id, host_id, stack_id,
           source_repository_url, clone_repository_url, source_branch,
           source_commit_sha, source_compose_path, compose_yaml,
           compose_sha256, project_name, working_dir,
           environment_encrypted, environment_binding
         )
         VALUES (
           $1, $2, $3, $4,
           'https://github.com/pq-integration/app', $5, 'main',
           $6, $7, $8, $9, $10, $11, $12, $13
         )`,
        [
          job.id,
          fixture.repositoryId,
          fixture.hostId,
          fixture.stackId,
          cloneUrl,
          nextCommitSha,
          cloneComposePath,
          cloneComposeYaml,
          cloneComposeSha256,
          `pq-${fixture.repositoryId}`,
          cloneWorkingDir,
          encryptSecret(cloneEnvironment),
          cloneEnvironmentBinding
        ]
      );
      return job;
    });
  }

  it("applies success exactly once for the claimed lease", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundDeployment(fixture);
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(queued.id);

    await expect(completeJob(
      queued.id,
      { ok: true },
      { workerId, attemptCount: claimed!.attemptCount }
    )).resolves.toBe(true);
    await expect(completeJob(
      queued.id,
      { stale: true },
      { workerId, attemptCount: claimed!.attemptCount }
    )).resolves.toBe(false);

    await expect(pool.query(
      `SELECT last_deployed_commit_sha, last_error
       FROM github_repositories WHERE id = $1`,
      [fixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{ last_deployed_commit_sha: nextCommitSha, last_error: null }]
    });
    await expect(pool.query(
      "SELECT source_current_commit_sha FROM compose_stacks WHERE id = $1",
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{ source_current_commit_sha: nextCommitSha }]
    });
    await expect(pool.query(
      "SELECT operation_job_id FROM github_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 0 });
  });

  it("cancellation discards while expired-worker ambiguity retains the binding and both mutation locks", async () => {
    const canceledFixture = await fixtures();
    const canceled = await queueBoundDeployment(
      canceledFixture,
      canceledCommitSha
    );
    await expect(cancelQueuedJob(canceled.id)).resolves.toMatchObject({ canceled: true });
    await expect(pool.query(
      "SELECT last_deployed_commit_sha FROM github_repositories WHERE id = $1",
      [canceledFixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{ last_deployed_commit_sha: previousCommitSha }]
    });

    const expiredFixture = await fixtures();
    const expired = await queueBoundDeployment(expiredFixture, expiredCommitSha);
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(expired.id);
    await pool.query(
      "UPDATE operation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [expired.id]
    );
    await expect(completeJob(
      expired.id,
      { stale: true },
      { workerId, attemptCount: claimed!.attemptCount }
    )).resolves.toBe(false);
    await expect(recoverExpiredJobs()).resolves.toMatchObject({ failed: 1 });
    await expect(pool.query(
      "SELECT last_deployed_commit_sha, last_error FROM github_repositories WHERE id = $1",
      [expiredFixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{
        last_deployed_commit_sha: previousCommitSha,
        last_error: expect.stringContaining("WORKER_LOST")
      }]
    });
    await expect(pool.query(
      "SELECT operation_job_id FROM github_deployment_jobs WHERE operation_job_id = $1",
      [expired.id]
    )).resolves.toMatchObject({
      rows: [{ operation_job_id: expired.id }],
      rowCount: 1
    });
    await expect(withTransaction((client) =>
      lockComposeStackForMutation(client, expiredFixture.stackId)
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: expired.id });
    await expect(withTransaction((client) =>
      lockGithubRepositoryForMutation(client, expiredFixture.repositoryId)
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: expired.id });
  });

  it("rolls binding resolution back with its transaction, then applies exact completed compose proof once", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundDeployment(fixture);
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(queued.id);
    await pool.query(
      "UPDATE operation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );
    await expect(recoverExpiredJobs()).resolves.toMatchObject({ failed: 1 });

    await expect(withTransaction(async (client) => {
      await resolveGithubDeploymentBindingAfterReconciliation(
        client,
        queued.id,
        { phase: "compose.deploy", state: "completed" }
      );
      throw new Error("simulate reconciliation audit failure");
    })).rejects.toThrow("simulate reconciliation audit failure");

    await expect(pool.query(
      "SELECT operation_job_id FROM github_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      "SELECT source_current_commit_sha, status FROM compose_stacks WHERE id = $1",
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{
        source_current_commit_sha: previousCommitSha,
        status: "created"
      }]
    });

    await expect(withTransaction((client) =>
      resolveGithubDeploymentBindingAfterReconciliation(
        client,
        queued.id,
        { phase: "compose.deploy", state: "completed" }
      )
    )).resolves.toMatchObject({
      status: "deployed",
      repositoryId: fixture.repositoryId,
      stackId: fixture.stackId,
      deployedSourceCommitSha: nextCommitSha
    });
    await expect(pool.query(
      "SELECT operation_job_id FROM github_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      "SELECT source_current_commit_sha, status FROM compose_stacks WHERE id = $1",
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{
        source_current_commit_sha: nextCommitSha,
        status: "deployed"
      }]
    });
  });

  it("records custom Compose success without claiming an upstream commit", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundDeployment(
      fixture,
      nextCommitSha,
      true
    );
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(queued.id);

    await expect(completeJob(
      queued.id,
      { ok: true },
      { workerId, attemptCount: claimed!.attemptCount }
    )).resolves.toBe(true);

    await expect(pool.query(
      `SELECT last_deployed_at, last_deployed_commit_sha
       FROM github_repositories
       WHERE id = $1`,
      [fixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{
        last_deployed_at: expect.any(Date),
        last_deployed_commit_sha: null
      }]
    });
    await expect(pool.query(
      "SELECT source_current_commit_sha FROM compose_stacks WHERE id = $1",
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{ source_current_commit_sha: null }]
    });
  });

  it("blocks stack and repository mutation while the binding is unresolved", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundDeployment(fixture);

    await expect(withTransaction((client) =>
      lockComposeStackForMutation(client, fixture.stackId)
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: queued.id });
    await expect(withTransaction((client) =>
      lockGithubRepositoryForMutation(client, fixture.repositoryId)
    )).rejects.toMatchObject({ statusCode: 409, activeJobId: queued.id });

    await expect(pool.query(
      "DELETE FROM compose_stacks WHERE id = $1",
      [fixture.stackId]
    )).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(
      "DELETE FROM github_repositories WHERE id = $1",
      [fixture.repositoryId]
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("linearizes an edit-vs-enqueue race on the shared stack advisory lock", async () => {
    const fixture = await fixtures();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockComposeStackForMutation(client, fixture.stackId);
      await client.query(
        "UPDATE compose_stacks SET compose_yaml = $2 WHERE id = $1",
        [fixture.stackId, "services:\n  edited: {}\n"]
      );

      let enqueueSettled = false;
      const enqueue = enqueueJob({
        type: "compose.deploy",
        hostId: fixture.hostId,
        payload: { stackId: fixture.stackId }
      }).finally(() => {
        enqueueSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(enqueueSettled).toBe(false);

      await client.query("COMMIT");
      const queued = await enqueue;
      expect(queued.status).toBe("queued");
      await expect(pool.query(
        "SELECT compose_yaml FROM compose_stacks WHERE id = $1",
        [fixture.stackId]
      )).resolves.toMatchObject({
        rows: [{ compose_yaml: "services:\n  edited: {}\n" }]
      });

      await expect(withTransaction((mutationClient) =>
        lockComposeStackForMutation(mutationClient, fixture.stackId)
      )).rejects.toMatchObject({
        statusCode: 409,
        activeJobId: queued.id
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("retains tracked-clone locks across worker loss and resolves exact provenance atomically", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundCloneDeployment(fixture);
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(queued.id);
    await pool.query(
      "UPDATE operation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );
    await expect(recoverExpiredJobs()).resolves.toMatchObject({ failed: 1 });

    await expect(pool.query(
      "SELECT operation_job_id FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(withTransaction((client) =>
      lockComposeStackForMutation(client, fixture.stackId)
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: queued.id
    });
    await expect(withTransaction((client) =>
      lockGithubRepositoryForMutation(client, fixture.repositoryId)
    )).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: queued.id
    });

    await expect(withTransaction(async (client) => {
      await client.query(
        `UPDATE operation_jobs
         SET result = jsonb_build_object(
           'remoteOutcomeReconciliation',
           jsonb_build_object('status', 'reconciled')
         )
         WHERE id = $1`,
        [queued.id]
      );
      await resolveGithubCloneDeploymentBindingAfterReconciliation(
        client,
        queued.id,
        { phase: "compose.deployPath.up", state: "completed" }
      );
      throw new Error("simulate reconciliation audit failure");
    })).rejects.toThrow("simulate reconciliation audit failure");

    await expect(pool.query(
      "SELECT operation_job_id FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query(
      "SELECT last_deployed_commit_sha FROM github_repositories WHERE id = $1",
      [fixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{ last_deployed_commit_sha: previousCommitSha }]
    });

    await expect(withTransaction(async (client) => {
      await client.query(
        `UPDATE operation_jobs
         SET result = jsonb_build_object(
           'remoteOutcomeReconciliation',
           jsonb_build_object('status', 'reconciled')
         )
         WHERE id = $1`,
        [queued.id]
      );
      return resolveGithubCloneDeploymentBindingAfterReconciliation(
        client,
        queued.id,
        { phase: "compose.deployPath.up", state: "completed" }
      );
    })).resolves.toMatchObject({
      status: "deployed",
      repositoryId: fixture.repositoryId,
      stackId: fixture.stackId,
      sourceCommitSha: nextCommitSha,
      composeSha256: cloneComposeSha256
    });

    await expect(pool.query(
      "SELECT operation_job_id FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      "SELECT last_deployed_commit_sha, last_error FROM github_repositories WHERE id = $1",
      [fixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{
        last_deployed_commit_sha: nextCommitSha,
        last_error: null
      }]
    });
    await expect(pool.query(
      `SELECT status, source_current_commit_sha,
              source_environment_binding
       FROM compose_stacks
       WHERE id = $1`,
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{
        status: "deployed",
        source_current_commit_sha: nextCommitSha,
        source_environment_binding: cloneEnvironmentBinding
      }]
    });
    await expect(withTransaction((client) =>
      lockComposeStackForMutation(client, fixture.stackId)
    )).resolves.toMatchObject({ id: fixture.stackId });
    await expect(withTransaction((client) =>
      lockGithubRepositoryForMutation(client, fixture.repositoryId)
    )).resolves.toMatchObject({ id: fixture.repositoryId });
  });

  it("retains completed clone deployment proof across a later local failure and reconciles exact provenance", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundCloneDeployment(fixture);
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(queued.id);
    await pool.query(
      `UPDATE operation_jobs
       SET result = jsonb_build_object(
         'remoteMutationProof',
         jsonb_build_object(
           'operationId', $2::text,
           'jobId', $1::text,
           'attemptCount', $3::int,
           'sequence', 4,
           'phase', 'compose.deployPath.up',
           'transport', 'ssh',
           'timeoutMs', 60000,
           'status', 'terminal',
           'terminalState', 'completed'
         )
       )
       WHERE id = $1`,
      [queued.id, "f".repeat(64), claimed!.attemptCount]
    );

    await expect(failJob(
      queued.id,
      new Error("inventory refresh failed"),
      { workerId, attemptCount: claimed!.attemptCount }
    )).resolves.toBe(true);
    await expect(pool.query(
      `SELECT error
       FROM operation_jobs
       WHERE id = $1`,
      [queued.id]
    )).resolves.toMatchObject({
      rows: [{
        error: expect.stringMatching(
          /^REMOTE_OUTCOME_UNKNOWN:.*inventory refresh failed/
        )
      }]
    });
    await expect(pool.query(
      "SELECT operation_job_id FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 1 });

    await expect(withTransaction(async (client) => {
      await client.query(
        `UPDATE operation_jobs
         SET result = result
           || jsonb_build_object(
             'remoteOutcomeReconciliation',
             jsonb_build_object('status', 'reconciled')
           )
         WHERE id = $1`,
        [queued.id]
      );
      return resolveGithubCloneDeploymentBindingAfterReconciliation(
        client,
        queued.id,
        { phase: "compose.deployPath.up", state: "completed" }
      );
    })).resolves.toMatchObject({
      status: "deployed",
      repositoryId: fixture.repositoryId,
      stackId: fixture.stackId,
      sourceCommitSha: nextCommitSha,
      environmentBinding: cloneEnvironmentBinding
    });

    await expect(pool.query(
      `SELECT status, source_current_commit_sha,
              source_environment_binding
       FROM compose_stacks
       WHERE id = $1`,
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{
        status: "deployed",
        source_current_commit_sha: nextCommitSha,
        source_environment_binding: cloneEnvironmentBinding
      }]
    });
    await expect(pool.query(
      `SELECT last_deployed_commit_sha, last_error
       FROM github_repositories
       WHERE id = $1`,
      [fixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{
        last_deployed_commit_sha: nextCommitSha,
        last_error: null
      }]
    });
    await expect(withTransaction((client) =>
      lockComposeStackForMutation(client, fixture.stackId)
    )).resolves.toMatchObject({ id: fixture.stackId });
    await expect(withTransaction((client) =>
      lockGithubRepositoryForMutation(client, fixture.repositoryId)
    )).resolves.toMatchObject({ id: fixture.repositoryId });
  });

  it("reconciles expired tracked clone work with no dispatch proof and releases its locks", async () => {
    const fixture = await fixtures();
    const queued = await queueBoundCloneDeployment(fixture);
    const workerId = randomUUID();
    const claimed = await claimNextJob(workerId);
    expect(claimed?.id).toBe(queued.id);
    await pool.query(
      "UPDATE operation_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.id]
    );
    await expect(recoverExpiredJobs()).resolves.toMatchObject({ failed: 1 });
    await pool.query(
      "UPDATE operation_jobs SET completed_at = now() - interval '12 minutes' WHERE id = $1",
      [queued.id]
    );

    await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
      checked: 1,
      reconciled: 1,
      pending: 0
    });
    await expect(pool.query(
      `SELECT result->'remoteOutcomeReconciliation' AS reconciliation
       FROM operation_jobs
       WHERE id = $1`,
      [queued.id]
    )).resolves.toMatchObject({
      rows: [{
        reconciliation: {
          status: "reconciled",
          remoteOperation: {
            phase: "not_dispatched",
            state: "not_dispatched",
            transport: null
          }
        }
      }]
    });
    await expect(pool.query(
      "SELECT operation_job_id FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
      [queued.id]
    )).resolves.toMatchObject({ rowCount: 0 });
    await expect(pool.query(
      `SELECT last_deployed_commit_sha
       FROM github_repositories
       WHERE id = $1`,
      [fixture.repositoryId]
    )).resolves.toMatchObject({
      rows: [{ last_deployed_commit_sha: previousCommitSha }]
    });
    await expect(pool.query(
      `SELECT status, source_current_commit_sha,
              source_environment_binding
       FROM compose_stacks
       WHERE id = $1`,
      [fixture.stackId]
    )).resolves.toMatchObject({
      rows: [{
        status: "created",
        source_current_commit_sha: null,
        source_environment_binding: cloneEnvironmentBinding
      }]
    });
    await expect(withTransaction((client) =>
      lockComposeStackForMutation(client, fixture.stackId)
    )).resolves.toMatchObject({ id: fixture.stackId });
    await expect(withTransaction((client) =>
      lockGithubRepositoryForMutation(client, fixture.repositoryId)
    )).resolves.toMatchObject({ id: fixture.repositoryId });
  });
});
