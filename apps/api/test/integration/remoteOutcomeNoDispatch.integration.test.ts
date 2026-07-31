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
import { pool } from "../../src/db/pool.js";
import {
  claimNextJob,
  enqueueJob,
  recoverExpiredJobs,
  withSynchronousDockerMutationAdmission
} from "../../src/services/jobs.js";
import {
  reconcileAmbiguousRemoteOutcomes
} from "../../src/services/remoteOutcomeReconciliation.js";

const getHostForWorker = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/hosts.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/services/hosts.js")
  >();
  return { ...original, getHostForWorker };
});
vi.mock("../../src/services/ssh.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/services/ssh.js")
  >();
  return { ...original, runSshCommand };
});

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)(
  "authoritative no-dispatch reconciliation integration",
  () => {
    const jobIds = new Set<string>();
    const hostIds = new Set<string>();

    beforeAll(async () => {
      await runMigrations();
      await pool.query("DELETE FROM operation_jobs");
    });

    beforeEach(async () => {
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
      jobIds.clear();
      hostIds.clear();
      getHostForWorker.mockReset();
      runSshCommand.mockReset();
      getHostForWorker.mockImplementation(async (hostId: string) => ({
        public: {
          id: hostId,
          name: "PQ no-dispatch host",
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
      }));
      runSshCommand.mockResolvedValue({
        code: 0,
        stdout: "absent\n",
        stderr: ""
      });
    });

    afterAll(async () => {
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
        [hostId, `PQ no-dispatch ${hostId}`]
      );
      return hostId;
    }

    async function loseWorkerBeforeDispatch(jobId: string) {
      const workerId = randomUUID();
      const claimed = await claimNextJob(workerId);
      expect(claimed?.id).toBe(jobId);
      await pool.query(
        `UPDATE operation_jobs
         SET lease_expires_at = now() - interval '1 second'
         WHERE id = $1`,
        [jobId]
      );
      await expect(recoverExpiredJobs()).resolves.toMatchObject({
        failed: 1
      });
      await pool.query(
        `UPDATE operation_jobs
         SET completed_at = now() - interval '12 minutes'
         WHERE id = $1`,
        [jobId]
      );
    }

    async function expectNoDispatchEvidence(jobId: string) {
      await expect(pool.query(
        `SELECT result->'remoteOutcomeReconciliation' AS reconciliation
         FROM operation_jobs
         WHERE id = $1`,
        [jobId]
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
    }

    it("releases a generic Docker mutation target after pre-dispatch worker loss", async () => {
      const hostId = await createHost();
      const containerId = "pq-no-dispatch-container";
      const queued = await enqueueJob({
        type: "container.start",
        hostId,
        payload: { containerId }
      });
      jobIds.add(queued.id);
      await loseWorkerBeforeDispatch(queued.id);

      await expect(withSynchronousDockerMutationAdmission(
        {
          type: "container.stop",
          hostId,
          payload: { containerId }
        },
        async () => "allowed"
      )).rejects.toMatchObject({
        statusCode: 409,
        activeJobId: queued.id
      });

      await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
        checked: 1,
        reconciled: 1,
        pending: 0
      });
      await expectNoDispatchEvidence(queued.id);
      await expect(withSynchronousDockerMutationAdmission(
        {
          type: "container.stop",
          hostId,
          payload: { containerId }
        },
        async () => "allowed"
      )).resolves.toBe("allowed");
    });

    it("releases the registry-trust single-flight lock after pre-dispatch worker loss", async () => {
      const hostId = await createHost();
      const action = {
        type: "host.configureRegistryTrust" as const,
        hostId,
        payload: { registry: "registry.internal:5000" }
      };
      const queued = await enqueueJob(action);
      jobIds.add(queued.id);
      await loseWorkerBeforeDispatch(queued.id);

      await expect(enqueueJob(action)).rejects.toMatchObject({
        statusCode: 409,
        activeJobId: queued.id
      });
      await expect(reconcileAmbiguousRemoteOutcomes()).resolves.toEqual({
        checked: 1,
        reconciled: 1,
        pending: 0
      });
      await expectNoDispatchEvidence(queued.id);

      const replacement = await enqueueJob(action);
      jobIds.add(replacement.id);
      expect(replacement.status).toBe("queued");
    });
  }
);
