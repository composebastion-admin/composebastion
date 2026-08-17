import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  assertBackupTargetUsable: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.poolQuery(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/backups.js", () => ({
  assertBackupTargetUsable: (...args: unknown[]) => mocks.assertBackupTargetUsable(...args),
  insertPreparedBackupRecord: vi.fn(),
  prepareBackupRecord: vi.fn(),
  prepareHostPathBackupRecord: vi.fn()
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/backupFailureAlerts.js", () => ({
  recordBackupScheduleResult: vi.fn()
}));

const hostId = "00000000-0000-4000-8000-000000000021";
const targetId = "00000000-0000-4000-8000-000000000022";
const userId = "00000000-0000-4000-8000-000000000023";
const scheduleId = "00000000-0000-4000-8000-000000000024";
const client = { query: (...args: unknown[]) => mocks.transactionQuery(...args) };

describe("backup schedule target atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertBackupTargetUsable.mockResolvedValue(targetId);
    mocks.withTransaction.mockImplementation(async (
      handler: (transactionClient: typeof client) => Promise<unknown>
    ) => handler(client));
    mocks.transactionQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM backup_targets")) {
        return { rows: [{ id: targetId, kind: "s3", enabled: true }] };
      }
      if (sql.includes("INSERT INTO backup_schedules")) {
        return {
          rows: [{
            id: scheduleId,
            host_id: values?.[1],
            kind: values?.[2],
            volume_name: values?.[3],
            source_path: values?.[4],
            backup_target_id: values?.[5],
            encryption: values?.[6],
            interval_ms: values?.[7],
            retention_count: values?.[8],
            enabled: true,
            last_run_at: null,
            next_run_at: values?.[9],
            last_status: null,
            last_error: null,
            created_at: new Date("2026-07-30T00:00:00.000Z"),
            updated_at: new Date("2026-07-30T00:00:00.000Z")
          }]
        };
      }
      return { rows: [] };
    });
  });

  it("locks and revalidates a remote target in the schedule insert transaction", async () => {
    const { createBackupSchedule } = await import("../src/services/backupSchedules.js");

    const result = await createBackupSchedule({
      kind: "volume",
      hostId,
      volumeName: "app-data",
      backupTargetId: targetId,
      intervalMs: 300_000
    }, userId);

    expect(result).toMatchObject({
      id: scheduleId,
      hostId,
      backupTargetId: targetId
    });
    const guardCall = mocks.transactionQuery.mock.calls.findIndex((call) => (
      String(call[0]).includes("FROM backup_targets")
      && String(call[0]).includes("FOR KEY SHARE")
    ));
    const insertCall = mocks.transactionQuery.mock.calls.findIndex((call) => (
      String(call[0]).includes("INSERT INTO backup_schedules")
    ));
    expect(guardCall).toBeGreaterThanOrEqual(0);
    expect(insertCall).toBeGreaterThan(guardCall);
    expect(mocks.poolQuery.mock.calls.some((call) => (
      String(call[0]).includes("INSERT INTO backup_schedules")
    ))).toBe(false);
  });
});
