import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool, withTransaction } from "../../src/db/pool.js";
import { encryptSecret } from "../../src/services/crypto.js";
import {
  createAndPersistComposeStackDeploymentIntent
} from "../../src/services/composeStackDeploymentIntent.js";
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  recoverExpiredJobs
} from "../../src/services/jobs.js";

const getHostForWorker = vi.hoisted(() => vi.fn());
const statHostPath = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());
const cleanupSshRemoteOperation = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/hosts.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/services/hosts.js")
  >();
  return { ...original, getHostForWorker };
});
vi.mock("../../src/services/files.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/services/files.js")
  >();
  return { ...original, statHostPath };
});
vi.mock("../../src/services/ssh.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/services/ssh.js")
  >();
  return {
    ...original,
    cleanupSshRemoteOperation,
    runSshCommand
  };
});

const {
  reconcileAmbiguousRemoteOutcomes
} = await import("../../src/services/remoteOutcomeReconciliation.js");

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const composeYaml = "services:\n  app:\n    image: nginx:alpine\n";
const secretEnvironment =
  "MODE=production\nAPI_TOKEN=real-postgres-secret\n";
const protectedEnvironment = "MODE='production'\nAPI_TOKEN=''";

describe.skipIf(!integrationEnabled)(
  "Compose deployment intent reconciliation integration",
  () => {
    const jobIds = new Set<string>();
    const hostIds = new Set<string>();
    const analysisIds = new Set<string>();

    async function cleanupFixtures() {
      if (jobIds.size) {
        await pool.query(
          `DELETE FROM audit_events
           WHERE target_kind = 'operation_job'
             AND target_id = ANY($1::text[])`,
          [[...jobIds]]
        );
        await pool.query(
          "DELETE FROM operation_jobs WHERE id = ANY($1::uuid[])",
          [[...jobIds]]
        );
      }
      if (hostIds.size) {
        await pool.query(
          "DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])",
          [[...hostIds]]
        );
      }
      if (analysisIds.size) {
        await pool.query(
          `DELETE FROM deployment_sources
           WHERE metadata->>'lastAnalysisId' = ANY($1::text[])`,
          [[...analysisIds]]
        );
      }
      jobIds.clear();
      hostIds.clear();
      analysisIds.clear();
    }

    beforeAll(async () => {
      await runMigrations();
      await pool.query("DELETE FROM operation_jobs");
    });

    beforeEach(async () => {
      await cleanupFixtures();
      getHostForWorker.mockReset();
      statHostPath.mockReset();
      runSshCommand.mockReset();
      cleanupSshRemoteOperation.mockReset();
      getHostForWorker.mockResolvedValue({
        public: {
          id: "fixture-host",
          name: "PQ intent host",
          username: "docker",
          dockerSocketPath: "/var/run/docker.sock"
        },
        connectionMode: "ssh",
        ssh: {
          hostname: "127.0.0.1",
          port: 22,
          username: "docker"
        },
        agent: null
      });
      statHostPath.mockResolvedValue({
        exists: false,
        type: null,
        size: null,
        modifiedAt: null
      });
      runSshCommand.mockResolvedValue({
        code: 0,
        stdout: "",
        stderr: ""
      });
      cleanupSshRemoteOperation.mockResolvedValue(undefined);
    });

    afterAll(async () => {
      await cleanupFixtures();
      await pool.end();
    });

    async function createHost() {
      const hostId = randomUUID();
      hostIds.add(hostId);
      await pool.query(
        `INSERT INTO docker_hosts
           (id, name, hostname, port, username, docker_socket_path,
            connection_mode, ssh_auth_type, tags)
         VALUES ($1, $2, '127.0.0.1', 22, 'docker',
                 '/var/run/docker.sock', 'ssh', 'key', '{}')`,
        [hostId, `PQ intent ${hostId}`]
      );
      return hostId;
    }

    async function activeFence(
      jobId: string,
      attemptCount: number,
      hostId: string
    ) {
      return {
        jobId,
        attemptCount,
        assertActive: async () => undefined,
        withActiveLease: <T>(
          callback: Parameters<typeof withTransaction<T>>[0]
        ) => withTransaction(callback),
        hostId
      };
    }

    async function makeIntent(
      jobId: string,
      attemptCount: number,
      hostId: string,
      projectName: string
    ) {
      return createAndPersistComposeStackDeploymentIntent({
        jobId,
        attemptCount,
        hostId,
        projectName,
        name: `PQ ${projectName}`,
        composeYaml,
        env: protectedEnvironment,
        source: {
          type: "host_files",
          repositoryUrl: null,
          branch: null,
          workingDir: `/srv/${projectName}`,
          composePath: `/srv/${projectName}/compose.yml`,
          currentCommitSha: null,
          latestCommitSha: null,
          environment: null,
          deploymentSourceId: null
        },
        version: {
          source: "host_files",
          note: `Deploy from /srv/${projectName}/compose.yml`,
          createdBy: null
        },
        githubCloneOperationJobId: null
      }, await activeFence(jobId, attemptCount, hostId) as any);
    }

    async function ageFailedJob(jobId: string) {
      await pool.query(
        `UPDATE operation_jobs
         SET completed_at = now() - interval '12 minutes'
         WHERE id = $1`,
        [jobId]
      );
    }

    it("discards a pre-up intent without creating stack metadata when the worker lost no-dispatch attempt", async () => {
      const hostId = await createHost();
      const projectName = `pq-no-dispatch-${randomUUID().slice(0, 8)}`;
      const queued = await enqueueJob({
        type: "compose.deployPath",
        hostId,
        payload: {
          projectName,
          workingDir: `/srv/${projectName}`,
          composePath: "compose.yml"
        }
      });
      jobIds.add(queued.id);
      const workerId = randomUUID();
      const claimed = await claimNextJob(workerId);
      expect(claimed?.id).toBe(queued.id);
      const intent = await makeIntent(
        queued.id,
        claimed!.attemptCount,
        hostId,
        projectName
      );

      await pool.query(
        `UPDATE operation_jobs
         SET lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [queued.id]
      );
      await expect(recoverExpiredJobs()).resolves.toMatchObject({ failed: 1 });
      await ageFailedJob(queued.id);

      await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
        checked: 1,
        reconciled: 1,
        pending: 0
      });
      await expect(pool.query(
        `SELECT result ? 'composeStackDeploymentIntent' AS has_intent,
                result->'remoteOutcomeReconciliation' AS reconciliation
         FROM operation_jobs
         WHERE id = $1`,
        [queued.id]
      )).resolves.toMatchObject({
        rows: [{
          has_intent: false,
          reconciliation: {
            status: "reconciled",
            remoteOperation: {
              phase: "not_dispatched",
              state: "not_dispatched"
            },
            composeStackDeployment: {
              status: "not_materialized"
            }
          }
        }]
      });
      await expect(pool.query(
        `SELECT count(*)::int AS count
         FROM compose_stacks
         WHERE id = $1`,
        [intent.candidateStackId]
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
      expect(getHostForWorker).not.toHaveBeenCalled();
    });

    it("reconstructs completed deploy.execute metadata exactly once after post-up local failure", async () => {
      const hostId = await createHost();
      const analysisId = randomUUID();
      const projectName = `pq-post-up-${randomUUID().slice(0, 8)}`;
      analysisIds.add(analysisId);
      await pool.query(
        `INSERT INTO deployment_analyses (
           id, host_id, source_type, source_input, source_locator, status,
           display_name, project_name, compose_path, working_dir,
           compose_yaml, env_encrypted, variables
         )
         VALUES (
           $1, $2, 'compose_upload', $3, $3, 'deploying',
           $4, $5, 'compose.yml', $6, $7, $8, $9::jsonb
         )`,
        [
          analysisId,
          hostId,
          `pq://${analysisId}`,
          `PQ intent ${analysisId}`,
          projectName,
          `/srv/${projectName}`,
          composeYaml,
          encryptSecret(secretEnvironment),
          JSON.stringify([{ key: "API_TOKEN", secret: true }])
        ]
      );
      const queued = await enqueueJob({
        type: "deploy.execute",
        hostId,
        payload: { analysisId }
      });
      jobIds.add(queued.id);
      const workerId = randomUUID();
      const claimed = await claimNextJob(workerId);
      expect(claimed?.id).toBe(queued.id);
      const intent = await makeIntent(
        queued.id,
        claimed!.attemptCount,
        hostId,
        projectName
      );
      await pool.query(
        `UPDATE operation_jobs
         SET result = COALESCE(result, '{}'::jsonb)
           || jsonb_build_object(
                'remoteMutationProof',
                jsonb_build_object(
                  'operationId', $2::text,
                  'jobId', id::text,
                  'attemptCount', attempt_count,
                  'sequence', 4,
                  'phase', 'compose.deployPath.up',
                  'transport', 'ssh',
                  'timeoutMs', 60000,
                  'status', 'terminal',
                  'terminalState', 'completed'
                )
              )
         WHERE id = $1`,
        [queued.id, "a".repeat(64)]
      );
      await expect(failJob(
        queued.id,
        new Error("postgres failed after Compose up"),
        { workerId, attemptCount: claimed!.attemptCount }
      )).resolves.toBe(true);
      await ageFailedJob(queued.id);

      await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
        checked: 1,
        reconciled: 1,
        pending: 0
      });

      const job = await pool.query<{
        result: Record<string, any>;
        error: string;
      }>(
        "SELECT result, error FROM operation_jobs WHERE id = $1",
        [queued.id]
      );
      expect(job.rows[0]?.error).toMatch(/^REMOTE_OUTCOME_UNKNOWN:/);
      expect(job.rows[0]?.result.composeStackDeploymentIntent).toBeUndefined();
      expect(job.rows[0]?.result.remoteOutcomeReconciliation).toMatchObject({
        status: "reconciled",
        composeStackDeployment: {
          status: "deployed",
          stackId: intent.candidateStackId,
          versionId: intent.candidateVersionId
        },
        deploymentExecution: {
          status: "deployed",
          analysisId,
          stackId: intent.candidateStackId
        }
      });
      expect(JSON.stringify(
        job.rows[0]?.result.remoteOutcomeReconciliation
      )).not.toContain("real-postgres-secret");

      const analysis = await pool.query<{
        status: string;
        source_id: string;
        env_encrypted: string | null;
        credential_secret_encrypted: string | null;
      }>(
        `SELECT status, source_id, env_encrypted,
                credential_secret_encrypted
         FROM deployment_analyses
         WHERE id = $1`,
        [analysisId]
      );
      expect(analysis.rows[0]).toMatchObject({
        status: "deployed",
        env_encrypted: null,
        credential_secret_encrypted: null
      });
      expect(analysis.rows[0]?.source_id).toBeTruthy();

      await expect(pool.query(
        `SELECT stacks.id, stacks.status, stacks.current_version_id,
                stacks.deployment_source_id, stacks.env,
                versions.id AS version_id, versions.env AS version_env,
                versions.version_number
         FROM compose_stacks AS stacks
         JOIN compose_stack_versions AS versions
           ON versions.stack_id = stacks.id
         WHERE stacks.id = $1`,
        [intent.candidateStackId]
      )).resolves.toMatchObject({
        rows: [{
          id: intent.candidateStackId,
          status: "deployed",
          current_version_id: intent.candidateVersionId,
          deployment_source_id: analysis.rows[0]?.source_id,
          env: protectedEnvironment,
          version_id: intent.candidateVersionId,
          version_env: protectedEnvironment,
          version_number: 1
        }]
      });
      await expect(pool.query(
        `SELECT count(*)::int AS count
         FROM compose_stack_versions
         WHERE stack_id = $1`,
        [intent.candidateStackId]
      )).resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
        checked: 0,
        reconciled: 0,
        pending: 0
      });
    });

    it("successful completion replaces persisted intent ciphertext instead of merging it", async () => {
      const hostId = await createHost();
      const projectName = `pq-complete-${randomUUID().slice(0, 8)}`;
      const queued = await enqueueJob({
        type: "compose.deployPath",
        hostId,
        payload: {
          projectName,
          workingDir: `/srv/${projectName}`,
          composePath: "compose.yml"
        }
      });
      jobIds.add(queued.id);
      const workerId = randomUUID();
      const claimed = await claimNextJob(workerId);
      expect(claimed?.id).toBe(queued.id);
      await makeIntent(
        queued.id,
        claimed!.attemptCount,
        hostId,
        projectName
      );

      await expect(completeJob(
        queued.id,
        { stackId: randomUUID() },
        { workerId, attemptCount: claimed!.attemptCount }
      )).resolves.toBe(true);
      await expect(pool.query(
        `SELECT result, result ? 'composeStackDeploymentIntent' AS has_intent
         FROM operation_jobs
         WHERE id = $1`,
        [queued.id]
      )).resolves.toMatchObject({
        rows: [{
          result: { stackId: expect.any(String) },
          has_intent: false
        }]
      });
    });
  }
);
