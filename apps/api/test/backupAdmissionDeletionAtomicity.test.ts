import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn(),
  unlink: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  unlink: (...args: unknown[]) => mocks.unlink(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

const {
  deleteBackup,
  enqueueBackupDrillJob,
  enqueueBackupVerifyJob,
  enqueueHostPathRestoreJob,
  enqueueVolumeRestoreJob
} = await import("../src/services/backups.js");

const backupId = "00000000-0000-4000-8000-000000000401";
const hostId = "00000000-0000-4000-8000-000000000402";
const targetHostId = "00000000-0000-4000-8000-000000000403";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function backupRow(metadata: Record<string, unknown> = {}) {
  const now = new Date("2026-07-30T10:00:00.000Z");
  return {
    id: backupId,
    host_id: hostId,
    kind: "volume",
    volume_name: "app-data",
    source_path: null,
    target_volume_name: null,
    file_name: "atomicity.tar.gz",
    size_bytes: 64,
    checksum: "sha256:atomicity",
    backup_target_id: null,
    remote_object_key: null,
    encryption: "none",
    encryption_key_id: null,
    encryption_key_fingerprint: null,
    verified_at: null,
    last_drill_at: null,
    last_drill_status: null,
    status: "completed",
    error: null,
    created_at: now,
    completed_at: now,
    metadata
  };
}

describe("backup operation admission and deletion atomicity", () => {
  let row: ReturnType<typeof backupRow>;
  let activeJob = false;
  let transactionTail: Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    row = backupRow();
    activeJob = false;
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
      if (sql.includes("SELECT * FROM backups WHERE id = $1")) {
        return { rows: [row] };
      }
      if (sql.includes("FROM operation_jobs")) {
        return { rows: activeJob ? [{ id: "active-job" }] : [] };
      }
      if (sql.includes("SET metadata = metadata || $2::jsonb") && values) {
        row.metadata = {
          ...row.metadata,
          ...JSON.parse(String(values[1]))
        };
        return { rows: [{ id: backupId }], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM backups") && values) {
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
    mocks.unlink.mockResolvedValue(undefined);
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

    const admission = enqueueBackupVerifyJob(backupId, true);
    await insertEntered.promise;
    const deletion = deleteBackup(backupId);
    allowAdmissionCommit.resolve();

    await expect(admission).resolves.toMatchObject({ job: { id: "queued-job" } });
    await expect(deletion).rejects.toMatchObject({ statusCode: 409 });
    expect(row.metadata.deletionClaimToken).toBeUndefined();
    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SELECT * FROM backups WHERE id = $1 FOR UPDATE")
    )).toHaveLength(2);
  });

  it("performs no artifact cleanup when the deletion audit/intention transaction fails", async () => {
    const auditFailure = new Error("audit insert failed");
    await expect(
      deleteBackup(
        backupId,
        async () => {
          throw auditFailure;
        }
      )
    ).rejects.toBe(auditFailure);

    expect(mocks.unlink).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM backups")
      )
    ).toBe(false);
  });

  it("keeps the durable claim when local cleanup fails after deletion began", async () => {
    mocks.unlink.mockRejectedValueOnce(
      new Error("filesystem unavailable")
    );

    await expect(
      deleteBackup(backupId)
    ).rejects.toThrow("filesystem unavailable");

    expect(row.metadata.deletionClaimToken).toEqual(
      expect.any(String)
    );
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "metadata = metadata - 'deletionClaimToken'"
        )
      )
    ).toBe(false);
  });

  it("lets a committed deletion claim win, then rejects admission before enqueue", async () => {
    const unlinkEntered = deferred();
    const allowDelete = deferred();
    mocks.unlink.mockImplementationOnce(async () => {
      unlinkEntered.resolve();
      await allowDelete.promise;
    });

    const deletion = deleteBackup(backupId);
    await unlinkEntered.promise;

    await expect(enqueueBackupVerifyJob(backupId, true)).rejects.toMatchObject({
      statusCode: 409
    });
    expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("SELECT * FROM backups WHERE id = $1 FOR UPDATE")
    )).toBe(true);

    allowDelete.resolve();
    await expect(deletion).resolves.toMatchObject({ id: backupId });
  });

  it("never supersedes a stale deletion claim or reopens operation admission", async () => {
    const unlinkEntered = deferred();
    const allowDelete = deferred();
    mocks.unlink.mockImplementationOnce(async () => {
      unlinkEntered.resolve();
      await allowDelete.promise;
    });

    const deletion = deleteBackup(backupId);
    await unlinkEntered.promise;
    const originalClaimToken = row.metadata.deletionClaimToken;
    row.metadata = {
      ...row.metadata,
      deletionClaimedAt: "1970-01-01T00:00:00.000Z"
    };

    await expect(deleteBackup(backupId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("reconciliation is required")
    });
    await expect(enqueueBackupVerifyJob(backupId, true)).rejects.toMatchObject({
      statusCode: 409
    });
    expect(row.metadata.deletionClaimToken).toBe(originalClaimToken);
    expect(mocks.unlink).toHaveBeenCalledTimes(1);

    allowDelete.resolve();
    await expect(deletion).resolves.toMatchObject({ id: backupId });
  });

  it.each([undefined, "not-a-date"])(
    "preserves an existing claim with deletionClaimedAt=%s for manual reconciliation",
    async (deletionClaimedAt) => {
      row.metadata = {
        deletionClaimToken: "unreconciled-delete-claim",
        ...(deletionClaimedAt === undefined ? {} : { deletionClaimedAt })
      };

      await expect(deleteBackup(backupId)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("reconciliation is required")
      });
      expect(row.metadata.deletionClaimToken).toBe("unreconciled-delete-claim");
      expect(mocks.unlink).not.toHaveBeenCalled();
    }
  );

  it("reports reconciliation when a deletion owner loses its claim without clearing the replacement", async () => {
    const unlinkEntered = deferred();
    const allowDelete = deferred();
    mocks.unlink.mockImplementationOnce(async () => {
      unlinkEntered.resolve();
      await allowDelete.promise;
    });

    const deletion = deleteBackup(backupId);
    await unlinkEntered.promise;
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
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM backups")
    )).toBe(false);
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes(
          "metadata = metadata - 'deletionClaimToken'"
        )
      )
    ).toBe(false);
  });

  it.each([
    ["volume restore", () => enqueueVolumeRestoreJob({
      backupId,
      targetHostId,
      targetVolumeName: "restored-data",
      overwrite: false
    })],
    ["host-path restore", () => enqueueHostPathRestoreJob({
      backupId,
      targetHostId,
      targetPath: "/srv/restore",
      overwrite: false
    })],
    ["verify", () => enqueueBackupVerifyJob(backupId, true)],
    ["drill", () => enqueueBackupDrillJob(backupId)]
  ])("rejects %s while any deletion claim is present", async (_label, admit) => {
    row.metadata = {
      deletionClaimToken: "delete-claim",
      deletionClaimedAt: "2026-07-30T10:00:00.000Z"
    };

    await expect(admit()).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
  });
});
