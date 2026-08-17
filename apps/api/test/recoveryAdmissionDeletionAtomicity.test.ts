import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn(),
  deleteRecoveryPointRemoteArtifacts: vi.fn(),
  deleteRecoveryPointLocalFiles: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

vi.mock("../src/services/recoveryArtifactDelete.js", () => ({
  deleteRecoveryPointRemoteArtifacts: (...args: unknown[]) =>
    mocks.deleteRecoveryPointRemoteArtifacts(...args)
}));

vi.mock("../src/services/recoveryCapture.js", () => ({
  runRecoveryCreate: vi.fn(),
  runRecoveryPointCapture: vi.fn(),
  runRecoveryVerify: vi.fn()
}));

vi.mock("../src/services/recoveryStorage.js", () => ({
  artifactRelativePath: (...parts: string[]) => parts.join("/"),
  deleteRecoveryPointLocalFiles: (...args: unknown[]) =>
    mocks.deleteRecoveryPointLocalFiles(...args)
}));

const {
  deleteRecoveryPoint,
  enqueueRecoveryCapture,
  enqueueRecoveryCreate,
  enqueueRecoveryDrill,
  enqueueRecoveryRestore,
  enqueueRecoveryVerify
} = await import("../src/services/recoveryCenter.js");
const { enforceScheduledRecoveryRetention } = await import("../src/services/recoveryRetention.js");

const recoveryPointId = "00000000-0000-4000-8000-000000000411";
const hostId = "00000000-0000-4000-8000-000000000412";
const targetHostId = "00000000-0000-4000-8000-000000000413";
const retentionSourcePoint = {
  id: "00000000-0000-4000-8000-000000000414",
  hostId,
  name: "Current scheduled point",
  appIdentity: { kind: "standalone", containerIds: ["web"] },
  triggerKind: "scheduled",
  status: "completed",
  backupTargetId: null,
  legacyVolumeBackupId: null,
  profileId: null,
  artifactCount: 0,
  completedArtifactCount: 0,
  remoteArtifactCount: 0,
  remoteUploadFailureCount: 0,
  localRetainedArtifactCount: 0,
  localRemovedArtifactCount: 0,
  totalBytes: 0,
  error: null,
  metadata: {
    scheduleId: "00000000-0000-4000-8000-000000000415",
    retentionCount: 1
  },
  lastDrillAt: null,
  lastDrillStatus: null,
  lastDrillError: null,
  lastSuccessfulDrillAt: null,
  createdAt: "2026-07-30T10:00:00.000Z",
  startedAt: "2026-07-30T10:00:00.000Z",
  completedAt: "2026-07-30T10:00:00.000Z",
  artifacts: []
} as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recoveryPointRow(metadata: Record<string, unknown> = {}) {
  const now = new Date("2026-07-30T10:00:00.000Z");
  return {
    id: recoveryPointId,
    host_id: hostId,
    name: "Atomic recovery point",
    app_identity: { kind: "standalone", containerIds: ["web"] },
    trigger_kind: "manual",
    status: "completed",
    backup_target_id: null,
    legacy_volume_backup_id: null,
    migration_run_id: null,
    artifact_count: 0,
    completed_artifact_count: 0,
    total_bytes: 0,
    error: null,
    metadata,
    created_at: now,
    started_at: now,
    completed_at: now
  };
}

describe("recovery operation admission and deletion atomicity", () => {
  let row: ReturnType<typeof recoveryPointRow>;
  let activeJob = false;
  let retentionCandidates: string[];
  let transactionTail: Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    row = recoveryPointRow();
    activeJob = false;
    retentionCandidates = [];
    transactionTail = Promise.resolve();
    mocks.withTransaction.mockImplementation(async (
      callback: (client: { query: typeof mocks.query }) => Promise<unknown>
    ) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((done) => {
        release = done;
      });
      await previous;
      try {
        return await callback({ query: mocks.query });
      } finally {
        release();
      }
    });
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("SELECT id") && sql.includes("OFFSET")) {
        return { rows: retentionCandidates.map((id) => ({ id })) };
      }
      if (sql.includes("SELECT * FROM recovery_points WHERE id = $1")) {
        return { rows: [row] };
      }
      if (sql.includes("FROM operation_jobs job")) {
        return { rows: activeJob ? [{ id: "active-job" }] : [] };
      }
      if (
        sql.includes("SET metadata = metadata || $2::jsonb")
        && values
        && values[0] === recoveryPointId
      ) {
        row.metadata = {
          ...row.metadata,
          ...JSON.parse(String(values[1]))
        };
        return { rows: [{ id: recoveryPointId }], rowCount: 1 };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) {
        return { rows: [] };
      }
      if (sql.includes("DELETE FROM recovery_points") && values) {
        const matchesClaim = row.metadata.deletionClaimToken === values[1];
        return { rows: [], rowCount: matchesClaim ? 1 : 0 };
      }
      if (
        sql.includes("SET metadata = metadata - 'deletionClaimToken'")
        && values
      ) {
        if (row.metadata.deletionClaimToken !== values[1]) {
          return { rows: [], rowCount: 0 };
        }
        const { deletionClaimToken: _token, deletionClaimedAt: _claimedAt, ...metadata } = row.metadata;
        row.metadata = metadata;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.enqueueJobInTransaction.mockImplementation(async () => {
      activeJob = true;
      return { id: "queued-job" };
    });
    mocks.notifyJobQueued.mockResolvedValue(undefined);
    mocks.deleteRecoveryPointRemoteArtifacts.mockResolvedValue({
      deletedObjectKeys: []
    });
    mocks.deleteRecoveryPointLocalFiles.mockResolvedValue(undefined);
  });

  it("lets a committed admission win, then makes deletion observe the queued job", async () => {
    const insertEntered = deferred();
    const allowAdmissionCommit = deferred();
    mocks.enqueueJobInTransaction.mockImplementationOnce(async () => {
      activeJob = true;
      insertEntered.resolve();
      await allowAdmissionCommit.promise;
      return { id: "queued-job" };
    });

    const admission = enqueueRecoveryVerify(recoveryPointId);
    await insertEntered.promise;
    const deletion = deleteRecoveryPoint(recoveryPointId);
    allowAdmissionCommit.resolve();

    await expect(admission).resolves.toMatchObject({ job: { id: "queued-job" } });
    await expect(deletion).rejects.toMatchObject({ statusCode: 409 });
    expect(row.metadata.deletionClaimToken).toBeUndefined();
    expect(mocks.deleteRecoveryPointRemoteArtifacts).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE")
    )).toHaveLength(2);
  });

  it("performs no remote or local cleanup when the deletion audit/intention transaction fails", async () => {
    const auditFailure = new Error("audit insert failed");
    await expect(
      deleteRecoveryPoint(
        recoveryPointId,
        async () => {
          throw auditFailure;
        }
      )
    ).rejects.toBe(auditFailure);

    expect(
      mocks.deleteRecoveryPointRemoteArtifacts
    ).not.toHaveBeenCalled();
    expect(
      mocks.deleteRecoveryPointLocalFiles
    ).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "DELETE FROM recovery_points"
        )
      )
    ).toBe(false);
  });

  it("keeps the durable claim when external cleanup fails after deletion began", async () => {
    mocks.deleteRecoveryPointRemoteArtifacts
      .mockRejectedValueOnce(
        new Error("object storage unavailable")
      );

    await expect(
      deleteRecoveryPoint(recoveryPointId)
    ).rejects.toThrow("object storage unavailable");

    expect(row.metadata.deletionClaimToken).toEqual(
      expect.any(String)
    );
    expect(
      mocks.deleteRecoveryPointLocalFiles
    ).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "metadata = metadata - 'deletionClaimToken'"
        )
      )
    ).toBe(false);
  });

  it("lets a committed deletion claim win, then rejects admission before enqueue", async () => {
    const remoteDeleteEntered = deferred();
    const allowDelete = deferred();
    mocks.deleteRecoveryPointRemoteArtifacts.mockImplementationOnce(async () => {
      remoteDeleteEntered.resolve();
      await allowDelete.promise;
      return { deletedObjectKeys: [] };
    });

    const deletion = deleteRecoveryPoint(recoveryPointId);
    await remoteDeleteEntered.promise;

    await expect(enqueueRecoveryVerify(recoveryPointId)).rejects.toMatchObject({
      statusCode: 409
    });
    expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("SELECT * FROM recovery_points WHERE id = $1 FOR UPDATE")
    )).toBe(true);

    allowDelete.resolve();
    await expect(deletion).resolves.toMatchObject({ id: recoveryPointId });
  });

  it("never supersedes a stale deletion claim or reopens operation admission", async () => {
    const remoteDeleteEntered = deferred();
    const allowDelete = deferred();
    mocks.deleteRecoveryPointRemoteArtifacts.mockImplementationOnce(async () => {
      remoteDeleteEntered.resolve();
      await allowDelete.promise;
      return { deletedObjectKeys: [] };
    });

    const deletion = deleteRecoveryPoint(recoveryPointId);
    await remoteDeleteEntered.promise;
    const originalClaimToken = row.metadata.deletionClaimToken;
    row.metadata = {
      ...row.metadata,
      deletionClaimedAt: "1970-01-01T00:00:00.000Z"
    };

    await expect(deleteRecoveryPoint(recoveryPointId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("reconciliation is required")
    });
    await expect(enqueueRecoveryVerify(recoveryPointId)).rejects.toMatchObject({
      statusCode: 409
    });
    expect(row.metadata.deletionClaimToken).toBe(originalClaimToken);
    expect(mocks.deleteRecoveryPointRemoteArtifacts).toHaveBeenCalledTimes(1);

    allowDelete.resolve();
    await expect(deletion).resolves.toMatchObject({ id: recoveryPointId });
  });

  it.each([undefined, "not-a-date"])(
    "preserves an existing claim with deletionClaimedAt=%s for manual reconciliation",
    async (deletionClaimedAt) => {
      row.metadata = {
        deletionClaimToken: "unreconciled-delete-claim",
        ...(deletionClaimedAt === undefined ? {} : { deletionClaimedAt })
      };

      await expect(deleteRecoveryPoint(recoveryPointId)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("reconciliation is required")
      });
      expect(row.metadata.deletionClaimToken).toBe("unreconciled-delete-claim");
      expect(mocks.deleteRecoveryPointRemoteArtifacts).not.toHaveBeenCalled();
      expect(mocks.deleteRecoveryPointLocalFiles).not.toHaveBeenCalled();
    }
  );

  it("reports reconciliation when a deletion owner loses its claim without clearing the replacement", async () => {
    const remoteDeleteEntered = deferred();
    const allowDelete = deferred();
    mocks.deleteRecoveryPointRemoteArtifacts.mockImplementationOnce(async () => {
      remoteDeleteEntered.resolve();
      await allowDelete.promise;
      return { deletedObjectKeys: [] };
    });

    const deletion = deleteRecoveryPoint(recoveryPointId);
    await remoteDeleteEntered.promise;
    const staleClaimToken = row.metadata.deletionClaimToken;
    row.metadata = {
      ...row.metadata,
      deletionClaimToken: "successor-delete-claim",
      deletionClaimedAt: "2026-07-30T10:10:00.000Z"
    };
    allowDelete.resolve();

    await expect(deletion).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("reconciliation is required")
    });
    expect(staleClaimToken).toEqual(expect.any(String));
    expect(row.metadata.deletionClaimToken).toBe("successor-delete-claim");
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "DELETE FROM recovery_points"
        )
      )
    ).toBe(false);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "metadata = metadata - 'deletionClaimToken'"
        )
      )
    ).toBe(false);
  });

  it("makes scheduled retention wait for admission and retain a point with a queued job", async () => {
    retentionCandidates = [recoveryPointId];
    const insertEntered = deferred();
    const allowAdmissionCommit = deferred();
    mocks.enqueueJobInTransaction.mockImplementationOnce(async () => {
      activeJob = true;
      insertEntered.resolve();
      await allowAdmissionCommit.promise;
      return { id: "queued-job" };
    });

    const admission = enqueueRecoveryVerify(recoveryPointId);
    await insertEntered.promise;
    const retention = enforceScheduledRecoveryRetention(retentionSourcePoint);
    allowAdmissionCommit.resolve();

    await expect(admission).resolves.toMatchObject({ job: { id: "queued-job" } });
    await expect(retention).resolves.toMatchObject({
      deletedIds: [],
      failures: [expect.stringContaining("active operation")]
    });
    expect(row.metadata.deletionClaimToken).toBeUndefined();
    expect(mocks.deleteRecoveryPointRemoteArtifacts).not.toHaveBeenCalled();
  });

  it("makes a scheduled-retention claim reject a later admission before enqueue", async () => {
    retentionCandidates = [recoveryPointId];
    const remoteDeleteEntered = deferred();
    const allowDelete = deferred();
    mocks.deleteRecoveryPointRemoteArtifacts.mockImplementationOnce(async () => {
      remoteDeleteEntered.resolve();
      await allowDelete.promise;
      return { deletedObjectKeys: [] };
    });

    const retention = enforceScheduledRecoveryRetention(retentionSourcePoint);
    await remoteDeleteEntered.promise;

    await expect(enqueueRecoveryVerify(recoveryPointId)).rejects.toMatchObject({
      statusCode: 409
    });
    expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();

    allowDelete.resolve();
    await expect(retention).resolves.toMatchObject({
      deletedIds: [recoveryPointId],
      failures: []
    });
  });

  it.each([
    ["capture", () => enqueueRecoveryCapture(recoveryPointId, hostId)],
    ["create", () => enqueueRecoveryCreate(recoveryPointId, hostId)],
    ["verify", () => enqueueRecoveryVerify(recoveryPointId)],
    ["restore", () => enqueueRecoveryRestore({
      recoveryPointId,
      targetHostId,
      options: {
        mode: "clone",
        stopExisting: false,
        remapPorts: true,
        networkMode: "clone"
      }
    })],
    ["drill", () => enqueueRecoveryDrill(recoveryPointId)]
  ])("rejects %s while any deletion claim is present", async (_label, admit) => {
    row.metadata = {
      deletionClaimToken: "delete-claim",
      deletionClaimedAt: "2026-07-30T10:00:00.000Z"
    };

    await expect(admit()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
  });
});
