import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { encryptSecret } from "../../src/services/crypto.js";
import { deploymentEnvironmentBinding } from "../../src/services/deploymentEnvironment.js";
import { queueDeployment } from "../../src/services/deployments.js";
import { deleteHost, updateHost } from "../../src/services/hosts.js";
import { retryJob } from "../../src/services/jobs.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const hostIds = new Set<string>();
const analysisIds = new Set<string>();
const registryIds = new Set<string>();
const composeYaml = "services:\n  app:\n    build: .\n";
const privateRegistryAuthority = "retry-lock-order.example.test";
const privateRegistryEnvironment =
  `REGISTRY_AUTHORITY='${privateRegistryAuthority}'`;
const privateRegistryComposeYaml = [
  "services:",
  "  app:",
  "    image: ${REGISTRY_AUTHORITY}/acme/app:1"
].join("\n");

async function createReadyGitAnalysis() {
  const hostId = randomUUID();
  const analysisId = randomUUID();
  hostIds.add(hostId);
  analysisIds.add(analysisId);
  await pool.query(
    `INSERT INTO docker_hosts (
       id, name, hostname, port, username, docker_socket_path,
       connection_mode, ssh_auth_type, ssh_password_encrypted
     )
     VALUES ($1, $2, '127.0.0.1', 22, 'docker', '/var/run/docker.sock',
             'ssh', 'password', $3)`,
    [
      hostId,
      `Deployment lock order ${hostId}`,
      encryptSecret("integration-placeholder")
    ]
  );
  await pool.query(
    `INSERT INTO deployment_analyses (
       id, host_id, source_type, source_input, source_locator, status,
       display_name, project_name, branch, compose_path, working_dir,
       compose_yaml, source_revision, compose_sha256, environment_sha256,
       summary, expires_at
     )
     VALUES (
       $1, $2, 'git', 'https://git.example.test/acme/lock-order.git',
       'https://git.example.test/acme/lock-order.git', 'ready',
       'Lock order', $3, 'main', 'compose.yaml', $4,
       $5, $6, $7, $8, $9, now() + interval '1 hour'
     )`,
    [
      analysisId,
      hostId,
      `lock-order-${analysisId}`,
      `/srv/lock-order/${analysisId}`,
      composeYaml,
      "a".repeat(40),
      createHash("sha256").update(composeYaml).digest("hex"),
      deploymentEnvironmentBinding(""),
      {
        services: [{
          name: "app",
          image: null,
          build: ".",
          ports: [],
          volumes: []
        }],
        composeCandidates: ["compose.yaml"],
        dockerfileGenerated: false,
        trackedEnvFile: false
      }
    ]
  );
  return { hostId, analysisId };
}

async function createFailedDeploymentRetry() {
  const { hostId, analysisId } = await createReadyGitAnalysis();
  const registryId = randomUUID();
  const jobId = randomUUID();
  registryIds.add(registryId);
  await pool.query(
    `INSERT INTO registries (
       id, name, url, username, password_encrypted, insecure
     )
     VALUES ($1, $2, $3, 'operator', $4, false)`,
    [
      registryId,
      `Retry lock order ${registryId}`,
      `https://${privateRegistryAuthority}`,
      encryptSecret("integration-registry-placeholder")
    ]
  );
  await pool.query(
    `UPDATE deployment_analyses
     SET status = 'failed',
         compose_yaml = $2,
         compose_sha256 = $3,
         env_encrypted = $4,
         environment_sha256 = $5,
         summary = $6,
         updated_at = now()
     WHERE id = $1`,
    [
      analysisId,
      privateRegistryComposeYaml,
      createHash("sha256").update(privateRegistryComposeYaml).digest("hex"),
      encryptSecret(privateRegistryEnvironment),
      deploymentEnvironmentBinding(privateRegistryEnvironment),
      {
        services: [{
          name: "app",
          image: "${REGISTRY_AUTHORITY}/acme/app:1",
          build: null,
          ports: [],
          volumes: []
        }],
        composeCandidates: ["compose.yaml"],
        dockerfileGenerated: false,
        trackedEnvFile: false
      }
    ]
  );
  await pool.query(
    `INSERT INTO operation_jobs (
       id, type, status, host_id, payload, error, attempt_count
     )
     VALUES ($1, 'deploy.execute', 'failed', $2, $3, 'deterministic failure', 1)`,
    [jobId, hostId, { analysisId }]
  );
  return { hostId, analysisId, registryId, jobId };
}

async function createReadyPrivateRegistryAnalysisOnHost(
  hostId: string,
  target: { projectName: string; workingDir: string }
) {
  const analysisId = randomUUID();
  analysisIds.add(analysisId);
  await pool.query(
    `INSERT INTO deployment_analyses (
       id, host_id, source_type, source_input, source_locator, status,
       display_name, project_name, branch, compose_path, working_dir,
       compose_yaml, env_encrypted, source_revision, compose_sha256,
       environment_sha256,
       summary, expires_at
     )
     VALUES (
       $1, $2, 'git', 'https://git.example.test/acme/retry-race.git',
       'https://git.example.test/acme/retry-race.git', 'ready',
       'Retry race', $3, 'main', 'compose.yaml', $4,
       $5, $6, $7, $8, $9, $10, now() + interval '1 hour'
     )`,
    [
      analysisId,
      hostId,
      target.projectName,
      target.workingDir,
      privateRegistryComposeYaml,
      encryptSecret(privateRegistryEnvironment),
      "b".repeat(40),
      createHash("sha256").update(privateRegistryComposeYaml).digest("hex"),
      deploymentEnvironmentBinding(privateRegistryEnvironment),
      {
        services: [{
          name: "app",
          image: "${REGISTRY_AUTHORITY}/acme/app:1",
          build: null,
          ports: [],
          volumes: []
        }],
        composeCandidates: ["compose.yaml"],
        dockerfileGenerated: false,
        trackedEnvFile: false
      }
    ]
  );
  return analysisId;
}

describe.skipIf(!integrationEnabled)(
  "deployment enqueue and host lifecycle lock order",
  () => {
    beforeAll(async () => {
      await runMigrations();
    });

    afterEach(async () => {
      if (analysisIds.size) {
        await pool.query(
          `DELETE FROM operation_jobs
           WHERE type = 'deploy.execute'
             AND payload->>'analysisId' = ANY($1::text[])`,
          [[...analysisIds]]
        );
        await pool.query(
          "DELETE FROM deployment_analyses WHERE id = ANY($1::uuid[])",
          [[...analysisIds]]
        );
        analysisIds.clear();
      }
      if (registryIds.size) {
        await pool.query(
          "DELETE FROM registries WHERE id = ANY($1::uuid[])",
          [[...registryIds]]
        );
        registryIds.clear();
      }
      if (hostIds.size) {
        await pool.query(
          "DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])",
          [[...hostIds]]
        );
        hostIds.clear();
      }
    });

    it.each([
      ["update", (hostId: string) => updateHost(hostId, { tags: ["qualified"] })],
      ["delete", (hostId: string) => deleteHost(hostId)]
    ])(
      "serializes deployment queue before host %s without a PostgreSQL deadlock",
      async (_name, mutateHost) => {
        const { hostId, analysisId } = await createReadyGitAnalysis();
        let releaseQueue!: () => void;
        let signalQueueLocked!: () => void;
        const queueLocked = new Promise<void>((resolve) => {
          signalQueueLocked = resolve;
        });
        const queueRelease = new Promise<void>((resolve) => {
          releaseQueue = resolve;
        });

        const queued = queueDeployment(
          analysisId,
          {},
          null,
          async () => {
            signalQueueLocked();
            await queueRelease;
          }
        );
        await queueLocked;

        let mutationSettled = false;
        const mutation = mutateHost(hostId).then(
          (value) => {
            mutationSettled = true;
            return { value, error: null };
          },
          (error: unknown) => {
            mutationSettled = true;
            return { value: null, error };
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(mutationSettled).toBe(false);

        releaseQueue();
        await expect(queued).resolves.toMatchObject({
          analysis: { id: analysisId, status: "deploying" },
          job: { type: "deploy.execute", status: "queued" }
        });
        const outcome = await mutation;
        expect(outcome.error).toMatchObject({
          statusCode: 409,
          activeJobId: expect.any(String)
        });
        expect((outcome.error as { code?: string } | null)?.code).not.toBe("40P01");
      }
    );

    it("does not capture the host advisory while blocked on the host row", async () => {
      const { hostId, analysisId } = await createReadyGitAnalysis();
      const hostLocker = await pool.connect();
      try {
        await hostLocker.query("BEGIN");
        const lockerPid = Number(
          (await hostLocker.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid"
          )).rows[0]?.pid
        );
        await hostLocker.query(
          "SELECT id FROM docker_hosts WHERE id = $1 FOR UPDATE",
          [hostId]
        );

        let queueSettled = false;
        const queued = queueDeployment(analysisId, {}, null).then(
          (value) => {
            queueSettled = true;
            return value;
          },
          (error: unknown) => {
            queueSettled = true;
            throw error;
          }
        );

        const deadline = Date.now() + 5_000;
        let rowWaitObserved = false;
        while (Date.now() < deadline) {
          const waiting = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_stat_activity
               WHERE $1 = ANY(pg_blocking_pids(pid))
                 AND state = 'active'
                 AND query LIKE '%FROM docker_hosts%'
                 AND query LIKE '%FOR SHARE%'
             ) AS waiting`,
            [lockerPid]
          );
          if (waiting.rows[0]?.waiting) {
            rowWaitObserved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(rowWaitObserved).toBe(true);
        expect(queueSettled).toBe(false);

        const advisoryProbe = await pool.connect();
        try {
          await advisoryProbe.query("BEGIN");
          const probe = await advisoryProbe.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_xact_lock(
               hashtextextended($1::text, 0)
             ) AS acquired`,
            [`docker-mutation-admission:${hostId}`]
          );
          expect(probe.rows[0]?.acquired).toBe(true);
          await advisoryProbe.query("COMMIT");
        } finally {
          advisoryProbe.release();
        }

        await hostLocker.query("COMMIT");
        await expect(queued).resolves.toMatchObject({
          analysis: { id: analysisId, status: "deploying" },
          job: { type: "deploy.execute", status: "queued" }
        });
      } finally {
        await hostLocker.query("ROLLBACK").catch(() => undefined);
        hostLocker.release();
      }
    });

    it("does not capture registry or analysis locks while retry waits on the host row", async () => {
      const { hostId, analysisId, registryId, jobId } =
        await createFailedDeploymentRetry();
      const hostLocker = await pool.connect();
      let retrySettled = false;
      try {
        await hostLocker.query("BEGIN");
        const lockerPid = Number(
          (await hostLocker.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid"
          )).rows[0]?.pid
        );
        await hostLocker.query(
          "SELECT id FROM docker_hosts WHERE id = $1 FOR UPDATE",
          [hostId]
        );

        const retried = retryJob(jobId).then(
          (value) => {
            retrySettled = true;
            return value;
          },
          (error: unknown) => {
            retrySettled = true;
            throw error;
          }
        );

        const deadline = Date.now() + 5_000;
        let rowWaitObserved = false;
        while (Date.now() < deadline) {
          const waiting = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_stat_activity
               WHERE $1 = ANY(pg_blocking_pids(pid))
                 AND state = 'active'
                 AND query LIKE '%FROM docker_hosts%'
                 AND query LIKE '%FOR SHARE%'
             ) AS waiting`,
            [lockerPid]
          );
          if (waiting.rows[0]?.waiting) {
            rowWaitObserved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(rowWaitObserved).toBe(true);
        expect(retrySettled).toBe(false);

        for (const [table, id] of [
          ["registries", registryId],
          ["deployment_analyses", analysisId]
        ] as const) {
          const rowProbe = await pool.connect();
          try {
            await rowProbe.query("BEGIN");
            await expect(rowProbe.query(
              `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`,
              [id]
            )).resolves.toMatchObject({ rowCount: 1 });
            await rowProbe.query("ROLLBACK");
          } finally {
            await rowProbe.query("ROLLBACK").catch(() => undefined);
            rowProbe.release();
          }
        }

        const advisoryProbe = await pool.connect();
        try {
          await advisoryProbe.query("BEGIN");
          const probe = await advisoryProbe.query<{ acquired: boolean }>(
            `SELECT pg_try_advisory_xact_lock(
               hashtextextended($1::text, 0)
             ) AS acquired`,
            [`docker-mutation-admission:${hostId}`]
          );
          expect(probe.rows[0]?.acquired).toBe(true);
          await advisoryProbe.query("ROLLBACK");
        } finally {
          await advisoryProbe.query("ROLLBACK").catch(() => undefined);
          advisoryProbe.release();
        }

        await hostLocker.query("COMMIT");
        await expect(retried).resolves.toMatchObject({
          original: { id: jobId, status: "failed", type: "deploy.execute" },
          retried: { id: jobId, status: "queued", type: "deploy.execute" }
        });
      } finally {
        await hostLocker.query("ROLLBACK").catch(() => undefined);
        hostLocker.release();
      }
    });

    it("serializes queue and retry across two analyses without a PostgreSQL deadlock", async () => {
      const { hostId, analysisId, jobId } =
        await createFailedDeploymentRetry();
      const target = {
        projectName: `lock-order-${analysisId}`,
        workingDir: `/srv/lock-order/${analysisId}`
      };
      const queuedAnalysisId = await createReadyPrivateRegistryAnalysisOnHost(
        hostId,
        target
      );
      let releaseQueue = () => {};
      let signalQueueLocked!: (pid: number) => void;
      let failQueueLocked!: (error: unknown) => void;
      const queueLocked = new Promise<number>((resolve, reject) => {
        signalQueueLocked = resolve;
        failQueueLocked = reject;
      });
      const queuePromise = queueDeployment(
        queuedAnalysisId,
        {},
        null,
        async (client) => {
          const queuePid = Number(
            (await client.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid"
            )).rows[0]?.pid
          );
          signalQueueLocked(queuePid);
          await new Promise<void>((release) => {
            releaseQueue = release;
          });
        }
      ).catch((error) => {
        failQueueLocked(error);
        throw error;
      });

      try {
        const queuePid = await queueLocked;
        let retrySettled = false;
        const retried = retryJob(jobId).then(
          (value) => {
            retrySettled = true;
            return { value, error: null };
          },
          (error: unknown) => {
            retrySettled = true;
            return { value: null, error };
          }
        );

        const deadline = Date.now() + 5_000;
        let admissionWaitObserved = false;
        while (Date.now() < deadline) {
          const waiting = await pool.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1
               FROM pg_stat_activity
               WHERE $1 = ANY(pg_blocking_pids(pid))
                 AND state = 'active'
                 AND query LIKE '%pg_advisory_xact_lock%'
             ) AS waiting`,
            [queuePid]
          );
          if (waiting.rows[0]?.waiting) {
            admissionWaitObserved = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (retrySettled) {
          const earlyOutcome = await retried;
          throw new Error(
            `Competing retry settled before queue admission released: ${
              earlyOutcome.error instanceof Error
                ? earlyOutcome.error.message
                : String(earlyOutcome.error)
            }`
          );
        }
        if (!admissionWaitObserved) {
          const activity = await pool.query<{
            pid: number;
            wait_event_type: string | null;
            wait_event: string | null;
            query: string;
            blockers: number[];
          }>(
            `SELECT pid, wait_event_type, wait_event, query,
                    pg_blocking_pids(pid) AS blockers
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND state = 'active'
               AND pid <> pg_backend_pid()
             ORDER BY pid`
          );
          throw new Error(
            `Competing retry did not reach the expected admission wait: ${
              JSON.stringify(activity.rows)
            }`
          );
        }

        releaseQueue();
        await expect(queuePromise).resolves.toMatchObject({
          analysis: { id: queuedAnalysisId, status: "deploying" },
          job: { status: "queued", type: "deploy.execute" }
        });
        const retryOutcome = await retried;
        expect(retryOutcome.value).toBeNull();
        expect(retryOutcome.error).toMatchObject({ statusCode: 409 });
        expect((retryOutcome.error as { code?: string } | null)?.code)
          .not.toBe("40P01");
      } finally {
        releaseQueue();
        await queuePromise.catch(() => undefined);
      }
    }, 30_000);
  }
);
