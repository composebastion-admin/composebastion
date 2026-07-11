import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn(),
  mkdir: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: (...args: unknown[]) => mocks.mkdir(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.poolQuery(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

const hostId = "00000000-0000-4000-8000-000000000011";
const userId = "00000000-0000-4000-8000-000000000012";
const client = { query: (...args: unknown[]) => mocks.transactionQuery(...args) };

describe("backup record and job atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.withTransaction.mockImplementation(async (handler: (transactionClient: typeof client) => Promise<unknown>) => handler(client));
    mocks.transactionQuery.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.includes("INSERT INTO backups")) {
        return {
          rows: [{
            id: values[0],
            host_id: values[1],
            kind: values[2],
            volume_name: values[3],
            source_path: values[4],
            file_name: values[5],
            status: "queued",
            backup_target_id: values[6],
            encryption: values[7],
            encryption_key_id: values[8],
            encryption_key_fingerprint: values[9],
            metadata: values[10],
            created_at: new Date("2026-07-10T12:00:00.000Z"),
            completed_at: null
          }]
        };
      }
      return { rows: [] };
    });
    mocks.enqueueJobInTransaction.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000013" });
    mocks.notifyJobQueued.mockResolvedValue(undefined);
  });

  it("inserts the backup and its job through the same transaction client", async () => {
    const { createBackupWithJob } = await import("../src/services/backups.js");
    const result = await createBackupWithJob(hostId, "app-data", {}, userId);

    expect(result.backup).toMatchObject({ hostId, kind: "volume", volumeName: "app-data", status: "queued" });
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.transactionQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO backups"), expect.any(Array));
    expect(mocks.poolQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO backups"))).toBe(false);
    expect(mocks.enqueueJobInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        type: "volume.backup",
        hostId,
        payload: expect.objectContaining({ volumeName: "app-data" })
      }),
      userId
    );
    expect(mocks.notifyJobQueued).toHaveBeenCalledWith(result.job.id);
  });

  it("does not publish a wake-up when the transactional job insert fails", async () => {
    mocks.enqueueJobInTransaction.mockRejectedValueOnce(new Error("job insert failed"));
    const { createBackupWithJob } = await import("../src/services/backups.js");

    await expect(createBackupWithJob(hostId, "app-data", {}, userId)).rejects.toThrow("job insert failed");
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });

  it("pre-creates and links the clone backup in the same job transaction", async () => {
    const { createVolumeCloneWithJob } = await import("../src/services/backups.js");
    const result = await createVolumeCloneWithJob({
      sourceHostId: hostId,
      targetHostId: "00000000-0000-4000-8000-000000000014",
      sourceVolumeName: "source-data",
      targetVolumeName: "target-data",
      overwrite: false
    }, userId);

    expect(mocks.enqueueJobInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        type: "volume.clone",
        hostId,
        payload: expect.objectContaining({ backupId: result.backup.id, sourceVolumeName: "source-data" })
      }),
      userId
    );
    expect(mocks.notifyJobQueued).toHaveBeenCalledWith(result.job.id);
  });
});
