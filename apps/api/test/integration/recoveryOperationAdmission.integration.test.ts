import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import type { DockerMutationScope } from "../../src/services/dockerMutationScope.js";
import { enqueueJobInTransaction } from "../../src/services/jobs.js";
import {
  RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY,
  lockRecoveryOperationAdmission,
  type RecoveryAdmissionOperationKind
} from "../../src/services/recoveryOperationAdmission.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const hostId = "8f000000-0000-4000-8000-000000000001";
const secondHostId =
  "8f000000-0000-4000-8000-000000000002";

function overlappingScope(): DockerMutationScope {
  return {
    type: "compose.deployPath",
    hostIds: [hostId],
    targets: [
      { hostId, kind: "host-path", value: "/srv/qualification/client-app" },
      { hostId, kind: "compose-project", value: "qualification-client" },
      { hostId, kind: "container", value: "qualification-client-web" },
      { hostId, kind: "volume", value: "qualification-client-data" }
    ]
  };
}

function hostPathScope(
  targetHostId: string,
  targetPath: string
): DockerMutationScope {
  return {
    type: "compose.deployPath",
    hostIds: [targetHostId],
    targets: [{
      hostId: targetHostId,
      kind: "host-path",
      value: targetPath
    }]
  };
}

async function begin(client: PoolClient) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '6s'");
}

async function enqueueRecovery(
  client: PoolClient,
  input: {
    kind: RecoveryAdmissionOperationKind;
    type: "recovery.capture" | "recovery.restore";
    source?: DockerMutationScope[];
    target?: DockerMutationScope[];
  }
) {
  const source = input.source ?? [];
  const target = input.target ?? [];
  await lockRecoveryOperationAdmission(client, {
    kind: input.kind,
    sourceDockerScopes: source,
    targetDockerScopes: target
  });
  const id = randomUUID();
  await client.query(
    `INSERT INTO operation_jobs (
       id, type, host_id, payload, status
     )
     VALUES ($1, $2, $3, $4, 'queued')`,
    [
      id,
      input.type,
      hostId,
      {
        [RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY]: {
          source,
          target
        }
      }
    ]
  );
  return id;
}

async function expectSerializedConflict(
  first: (client: PoolClient) => Promise<unknown>,
  second: (client: PoolClient) => Promise<unknown>
) {
  const firstClient = await pool.connect();
  const secondClient = await pool.connect();
  let firstOpen = false;
  let secondOpen = false;
  try {
    await begin(firstClient);
    firstOpen = true;
    await begin(secondClient);
    secondOpen = true;
    await first(firstClient);

    let secondSettled = false;
    const secondOutcome = second(secondClient).then(
      (value) => {
        secondSettled = true;
        return { value, error: null };
      },
      (error: unknown) => {
        secondSettled = true;
        return { value: null, error };
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondSettled).toBe(false);

    await firstClient.query("COMMIT");
    firstOpen = false;
    const outcome = await secondOutcome;
    expect(outcome.error).toMatchObject({
      statusCode: 409,
      activeJobId: expect.any(String)
    });
    await secondClient.query("ROLLBACK");
    secondOpen = false;
  } finally {
    if (firstOpen) await firstClient.query("ROLLBACK").catch(() => undefined);
    if (secondOpen) await secondClient.query("ROLLBACK").catch(() => undefined);
    firstClient.release();
    secondClient.release();
  }
}

describe.skipIf(!integrationEnabled)(
  "recovery operation cross-domain admission integration",
  () => {
    beforeAll(async () => {
      await runMigrations();
      await pool.query("DELETE FROM operation_jobs WHERE host_id = $1", [hostId]);
      await pool.query(
        "DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])",
        [[hostId, secondHostId]]
      );
      await pool.query(
        `INSERT INTO docker_hosts (
           id, name, hostname, port, username, docker_socket_path,
           connection_mode, ssh_auth_type
         )
         VALUES (
           $1, 'Recovery admission integration', '127.0.0.1', 22,
           'docker', '/var/run/docker.sock', 'ssh', 'key'
         )`,
        [hostId]
      );
      await pool.query(
        `INSERT INTO docker_hosts (
           id, name, hostname, port, username, docker_socket_path,
           connection_mode, ssh_auth_type
         )
         VALUES (
           $1, 'Recovery admission integration second',
           '127.0.0.2', 22, 'docker', '/var/run/docker.sock',
           'ssh', 'key'
         )`,
        [secondHostId]
      );
    });

    afterEach(async () => {
      await pool.query("DELETE FROM operation_jobs WHERE host_id = $1", [hostId]);
    });

    afterAll(async () => {
      await pool.query("DELETE FROM operation_jobs WHERE host_id = $1", [hostId]);
      await pool.query(
        "DELETE FROM docker_hosts WHERE id = ANY($1::uuid[])",
        [[hostId, secondHostId]]
      );
    });

    it("serializes generic enqueue first and rejects the overlapping recovery enqueue without deadlock", async () => {
      const scope = overlappingScope();
      await expectSerializedConflict(
        async (client) => {
          await enqueueJobInTransaction(client, {
            type: "compose.deployPath",
            hostId,
            payload: {
              projectName: "qualification-client",
              workingDir: "/srv/qualification/client-app",
              composePath: "compose.yml"
            }
          });
        },
        async (client) => {
          await enqueueRecovery(client, {
            kind: "restore",
            type: "recovery.restore",
            target: [scope]
          });
        }
      );
    });

    it("serializes recovery enqueue first and rejects the overlapping generic enqueue without deadlock", async () => {
      const scope = overlappingScope();
      await expectSerializedConflict(
        async (client) => {
          await enqueueRecovery(client, {
            kind: "restore",
            type: "recovery.restore",
            target: [scope]
          });
        },
        async (client) => {
          await enqueueJobInTransaction(client, {
            type: "compose.deployPath",
            hostId,
            payload: {
              projectName: "qualification-client",
              workingDir: "/srv/qualification/client-app",
              composePath: "compose.yml"
            }
          });
        }
      );
    });

    it("rejects a target enqueue that races an overlapping active source enqueue", async () => {
      const scope = overlappingScope();
      await expectSerializedConflict(
        async (client) => {
          await enqueueRecovery(client, {
            kind: "capture",
            type: "recovery.capture",
            source: [scope]
          });
        },
        async (client) => {
          await enqueueRecovery(client, {
            kind: "restore",
            type: "recovery.restore",
            target: [scope]
          });
        }
      );
    });

    it("rejects a source enqueue that races an overlapping active target enqueue", async () => {
      const scope = overlappingScope();
      await expectSerializedConflict(
        async (client) => {
          await enqueueRecovery(client, {
            kind: "restore",
            type: "recovery.restore",
            target: [scope]
          });
        },
        async (client) => {
          await enqueueRecovery(client, {
            kind: "capture",
            type: "recovery.capture",
            source: [scope]
          });
        }
      );
    });

    it("waits on the host row before taking the host admission advisory", async () => {
      const rowLocker = await pool.connect();
      const admissionClient = await pool.connect();
      const advisoryProbe = await pool.connect();
      let rowLockerOpen = false;
      let admissionOpen = false;
      let probeOpen = false;
      try {
        await begin(rowLocker);
        rowLockerOpen = true;
        await rowLocker.query(
          "SELECT id FROM docker_hosts WHERE id = $1 FOR UPDATE",
          [hostId]
        );
        await begin(admissionClient);
        admissionOpen = true;
        const admissionOutcome =
          lockRecoveryOperationAdmission(admissionClient, {
            kind: "restore",
            targetDockerScopes: [
              hostPathScope(
                hostId,
                "/srv/qualification/row-order"
              )
            ]
          }).then(
            () => ({ error: null }),
            (error: unknown) => ({ error })
          );
        await new Promise((resolve) => setTimeout(resolve, 75));

        await begin(advisoryProbe);
        probeOpen = true;
        const probed = await advisoryProbe.query<{
          locked: boolean;
        }>(
          `SELECT pg_try_advisory_xact_lock(
             hashtextextended($1::text, 0)
           ) AS locked`,
          [`docker-mutation-admission:${hostId}`]
        );
        expect(probed.rows[0]?.locked).toBe(true);
        await advisoryProbe.query("ROLLBACK");
        probeOpen = false;

        await rowLocker.query("ROLLBACK");
        rowLockerOpen = false;
        expect((await admissionOutcome).error).toBeNull();
        await admissionClient.query("ROLLBACK");
        admissionOpen = false;
      } finally {
        if (rowLockerOpen) {
          await rowLocker.query("ROLLBACK").catch(() => undefined);
        }
        if (admissionOpen) {
          await admissionClient.query("ROLLBACK").catch(() => undefined);
        }
        if (probeOpen) {
          await advisoryProbe.query("ROLLBACK").catch(() => undefined);
        }
        rowLocker.release();
        admissionClient.release();
        advisoryProbe.release();
      }
    });

    it("locks reversed multi-host inputs in sorted row order before any advisory", async () => {
      const sortedFirstHostId = [hostId, secondHostId].sort()[0]!;
      const rowLocker = await pool.connect();
      const admissionClient = await pool.connect();
      const advisoryProbe = await pool.connect();
      let rowLockerOpen = false;
      let admissionOpen = false;
      let probeOpen = false;
      try {
        await begin(rowLocker);
        rowLockerOpen = true;
        await rowLocker.query(
          "SELECT id FROM docker_hosts WHERE id = $1 FOR UPDATE",
          [sortedFirstHostId]
        );
        await begin(admissionClient);
        admissionOpen = true;
        const admissionOutcome =
          lockRecoveryOperationAdmission(admissionClient, {
            kind: "restore",
            targetDockerScopes: [
              hostPathScope(
                secondHostId,
                "/srv/qualification/second"
              ),
              hostPathScope(
                hostId,
                "/srv/qualification/first"
              )
            ]
          }).then(
            () => ({ error: null }),
            (error: unknown) => ({ error })
          );
        await new Promise((resolve) => setTimeout(resolve, 75));

        await begin(advisoryProbe);
        probeOpen = true;
        for (const targetHostId of [hostId, secondHostId]) {
          const probed = await advisoryProbe.query<{
            locked: boolean;
          }>(
            `SELECT pg_try_advisory_xact_lock(
               hashtextextended($1::text, 0)
             ) AS locked`,
            [`docker-mutation-admission:${targetHostId}`]
          );
          expect(probed.rows[0]?.locked).toBe(true);
        }
        await advisoryProbe.query("ROLLBACK");
        probeOpen = false;

        await rowLocker.query("ROLLBACK");
        rowLockerOpen = false;
        expect((await admissionOutcome).error).toBeNull();
        await admissionClient.query("ROLLBACK");
        admissionOpen = false;
      } finally {
        if (rowLockerOpen) {
          await rowLocker.query("ROLLBACK").catch(() => undefined);
        }
        if (admissionOpen) {
          await admissionClient.query("ROLLBACK").catch(() => undefined);
        }
        if (probeOpen) {
          await advisoryProbe.query("ROLLBACK").catch(() => undefined);
        }
        rowLocker.release();
        admissionClient.release();
        advisoryProbe.release();
      }
    });
  }
);
