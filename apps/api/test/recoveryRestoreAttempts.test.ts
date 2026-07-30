import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  getHostForWorker: vi.fn(),
  runSshCommand: vi.fn(),
  runAgentDockerCommandResult: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) =>
    mocks.withTransaction(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) =>
    mocks.getHostForWorker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) =>
    mocks.runSshCommand(...args)
}));

vi.mock("../src/services/agent.js", () => ({
  runAgentDockerCommandResult: (...args: unknown[]) =>
    mocks.runAgentDockerCommandResult(...args)
}));

const {
  RECOVERY_RESTORE_QUIESCENCE_MS,
  RECOVERY_RESTORE_RECONCILIATION_MARGIN_MS,
  markRecoveryRestoreAttemptCleanupPending,
  reconcileRecoveryRestoreAttempts
} = await import(
  "../src/services/recoveryRestoreAttempts.js"
);

const attemptId =
  "00000000-0000-4000-8000-000000000501";
const pointId =
  "00000000-0000-4000-8000-000000000502";
const hostId =
  "00000000-0000-4000-8000-000000000503";
const jobId =
  "00000000-0000-4000-8000-000000000504";

function attemptRow() {
  return {
    id: attemptId,
    recovery_point_id: pointId,
    backup_id: null,
    target_host_id: hostId,
    operation_job_id: jobId,
    migration_run_id: null,
    restore_scope: `recovery:${pointId}`,
    allowed_path_roots: [],
    retain_on_success: false,
    status: "cleanup_pending",
    reconciliation_token: null
  };
}

describe("durable recovery restore reconciliation", () => {
  let attempt: ReturnType<typeof attemptRow>;
  let resources: Array<{
    attempt_id: string;
    kind: string;
    resource_name: string;
    status: string;
  }>;
  let claimValid: boolean;
  let claimedOnce: boolean;
  let dispositions: string[];
  let failureDelayMs: number | null;

  beforeEach(() => {
    vi.clearAllMocks();
    attempt = attemptRow();
    resources = [{
      attempt_id: attemptId,
      kind: "volume",
      resource_name: "restore-data",
      status: "observed"
    }];
    claimValid = true;
    claimedOnce = false;
    dispositions = [];
    failureDelayMs = null;

    mocks.getHostForWorker.mockResolvedValue({
      public: {
        id: hostId,
        tags: [],
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test" },
      agent: null
    });

    const client = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("SELECT attempt.*")) {
          if (claimedOnce) return { rows: [] };
          claimedOnce = true;
          return { rows: [attempt] };
        }
        if (
          sql.includes("SET status = 'reconciling'")
          && sql.includes("RETURNING *")
        ) {
          attempt = {
            ...attempt,
            status: "reconciling",
            reconciliation_token: String(values?.[1])
          };
          return { rows: [attempt], rowCount: 1 };
        }
        if (
          sql.includes("SET status = 'cleaned'")
          && sql.includes("reconciliation_token = $2")
        ) {
          if (
            claimValid
            && attempt.reconciliation_token === values?.[1]
          ) {
            attempt = {
              ...attempt,
              status: "cleaned",
              reconciliation_token: null
            };
            return { rows: [{ id: attemptId }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    mocks.withTransaction.mockImplementation(
      async (
        callback: (
          transactionClient: typeof client
        ) => Promise<unknown>
      ) => callback(client)
    );

    mocks.query.mockImplementation(
      async (sql: string, values?: unknown[]) => {
        if (
          sql.includes("FROM recovery_restore_resources")
          && sql.includes("ORDER BY created_at DESC")
        ) {
          return { rows: resources };
        }
        if (
          sql.includes(
            "SET reconciliation_started_at = now()"
          )
          && sql.includes("RETURNING id")
        ) {
          return claimValid
            ? { rows: [{ id: attemptId }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (
          sql.includes(
            "UPDATE recovery_restore_resources resource"
          )
        ) {
          if (!claimValid) {
            return { rows: [], rowCount: 0 };
          }
          dispositions.push(String(values?.[3]));
          return {
            rows: [{ attempt_id: attemptId }],
            rowCount: 1
          };
        }
        if (
          sql.includes("SET status = 'cleanup_pending'")
          && sql.includes(
            "cleanup_not_before = now() +"
          )
        ) {
          failureDelayMs = Number(values?.[2]);
          if (
            claimValid
            && attempt.reconciliation_token === values?.[1]
          ) {
            attempt = {
              ...attempt,
              status: "cleanup_pending",
              reconciliation_token: null
            };
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }
    );
  });

  it("never removes or finalizes after its cleanup claim is stolen", async () => {
    mocks.runSshCommand.mockImplementation(
      async (_ssh: unknown, command: string) => {
        expect(command).toContain(
          "docker volume inspect --format"
        );
        const oldToken = attempt.reconciliation_token;
        claimValid = false;
        attempt = {
          ...attempt,
          reconciliation_token:
            "00000000-0000-4000-8000-000000000599"
        };
        expect(oldToken).not.toBe(
          attempt.reconciliation_token
        );
        return {
          code: 0,
          stdout:
            `${attemptId}|recovery:${pointId}`,
          stderr: ""
        };
      }
    );

    await expect(
      reconcileRecoveryRestoreAttempts()
    ).resolves.toEqual({ checked: 1, cleaned: 0, failed: 1 });

    expect(
      mocks.runSshCommand.mock.calls.some(([, command]) =>
        String(command).includes("docker volume rm")
      )
    ).toBe(false);
    expect(dispositions).toEqual([]);
    expect(attempt.status).toBe("reconciling");
    expect(attempt.reconciliation_token).toBe(
      "00000000-0000-4000-8000-000000000599"
    );
  });

  it("defers a transport-unknown cleanup for the full quiescence window", async () => {
    mocks.runSshCommand.mockRejectedValue(
      new Error("SSH response lost")
    );

    await expect(
      reconcileRecoveryRestoreAttempts()
    ).resolves.toEqual({ checked: 1, cleaned: 0, failed: 1 });

    expect(failureDelayMs).toBe(
      RECOVERY_RESTORE_QUIESCENCE_MS
    );
    expect(
      mocks.runSshCommand.mock.calls.some(([, command]) =>
        String(command).includes("docker volume rm")
      )
    ).toBe(false);
    expect(attempt.status).toBe("cleanup_pending");
  });

  it("preserves a same-name Docker resource whose ownership labels differ", async () => {
    mocks.runSshCommand.mockResolvedValue({
      code: 0,
      stdout: "another-attempt|another-scope",
      stderr: ""
    });

    await expect(
      reconcileRecoveryRestoreAttempts()
    ).resolves.toEqual({ checked: 1, cleaned: 1, failed: 0 });

    expect(dispositions).toEqual([
      "preserved_unrelated"
    ]);
    expect(
      mocks.runSshCommand.mock.calls.some(([, command]) =>
        String(command).includes("docker volume rm")
      )
    ).toBe(false);
    expect(attempt.status).toBe("cleaned");
  });

  it("removes a captured immutable Docker ID and preserves a same-name successor", async () => {
    const resourceName = "restore-web";
    const originalId = "a".repeat(64);
    const successorId = "b".repeat(64);
    const ownership = `${attemptId}|recovery:${pointId}`;
    resources = [{
      attempt_id: attemptId,
      kind: "container",
      resource_name: resourceName,
      status: "observed"
    }];
    mocks.getHostForWorker.mockResolvedValue({
      public: {
        id: hostId,
        tags: [],
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "agent",
      ssh: null,
      agent: { baseUrl: "https://agent.example.test" }
    });
    let successorPresent = false;
    let originalPresent = true;
    mocks.runAgentDockerCommandResult.mockImplementation(
      async (_agent: unknown, command: string) => {
        if (
          command.includes("docker container inspect")
          && command.endsWith(`'${resourceName}'`)
        ) {
          successorPresent = true;
          return {
            code: 0,
            stdout: `${originalId}|${ownership}`,
            stderr: ""
          };
        }
        if (
          command.includes("docker container inspect")
          && command.endsWith(`'${originalId}'`)
        ) {
          return originalPresent
            ? {
                code: 0,
                stdout: `${originalId}|${ownership}`,
                stderr: ""
              }
            : {
                code: 1,
                stdout: "",
                stderr: "No such container"
              };
        }
        if (command === `docker rm --force '${originalId}'`) {
          originalPresent = false;
          return { code: 0, stdout: originalId, stderr: "" };
        }
        if (command === `docker rm --force '${successorId}'`) {
          successorPresent = false;
          return { code: 0, stdout: successorId, stderr: "" };
        }
        return {
          code: 1,
          stdout: "",
          stderr: `unexpected command: ${command}`
        };
      }
    );

    await expect(
      reconcileRecoveryRestoreAttempts()
    ).resolves.toEqual({ checked: 1, cleaned: 1, failed: 0 });

    expect(originalPresent).toBe(false);
    expect(successorPresent).toBe(true);
    expect(
      mocks.runAgentDockerCommandResult.mock.calls.some(
        ([, command]) =>
          String(command) ===
          `docker rm --force '${resourceName}'`
      )
    ).toBe(false);
    expect(dispositions).toEqual(["cleaned"]);
  });

  it("rejects root or out-of-ledger directory cleanup before any host command", async () => {
    attempt.allowed_path_roots = ["/"];
    resources = [{
      attempt_id: attemptId,
      kind: "directory",
      resource_name: "/",
      status: "observed"
    }];

    await expect(
      reconcileRecoveryRestoreAttempts()
    ).resolves.toEqual({ checked: 1, cleaned: 0, failed: 1 });

    expect(mocks.runSshCommand).not.toHaveBeenCalled();
    expect(failureDelayMs).toBe(
      RECOVERY_RESTORE_RECONCILIATION_MARGIN_MS
    );
  });

  it("persists response-loss cleanup_not_before in the future", async () => {
    const before = Date.now();
    await markRecoveryRestoreAttemptCleanupPending(
      attemptId,
      new Error("remote response lost"),
      { remoteOutcomeUnknown: true }
    );

    const update = mocks.query.mock.calls.find(
      ([sql]) => String(sql).includes(
        "cleanup_not_before = $2"
      )
    );
    expect(update).toBeDefined();
    const cleanupNotBefore = update?.[1]?.[1];
    expect(cleanupNotBefore).toBeInstanceOf(Date);
    expect(
      (cleanupNotBefore as Date).getTime()
    ).toBeGreaterThanOrEqual(
      before + RECOVERY_RESTORE_QUIESCENCE_MS
    );
  });
});
