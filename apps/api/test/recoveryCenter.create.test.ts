import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecutionFence } from "../src/services/jobs.js";

const poolQuery = vi.fn();
const withTransaction = vi.fn();
const transactionQuery = vi.fn();
const resolveAppContext = vi.fn();
const enqueueJobInTransaction = vi.fn();
const notifyJobQueued = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => poolQuery(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob: vi.fn(),
  enqueueJobInTransaction: (...args: unknown[]) => enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => notifyJobQueued(...args)
}));

const recoveryCenterSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/services/recoveryCenter.ts"),
  "utf8"
);

describe("createRecoveryPoint transaction integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTransaction.mockImplementation(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
      handler({ query: transactionQuery })
    );
    resolveAppContext.mockResolvedValue({
      label: "Standalone",
      projectName: null,
      stackId: null,
      composeYaml: null,
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["source-web"],
      volumeNames: ["demo_data"]
    });
    enqueueJobInTransaction.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000010" });
    notifyJobQueued.mockResolvedValue(undefined);
  });

  it("routes artifact inserts through the transaction client", () => {
    expect(recoveryCenterSource).toMatch(/async function insertArtifact\(\s*client: pg\.PoolClient/);
    expect(recoveryCenterSource).toMatch(/await insertArtifact\(\s*client,/);
    expect(recoveryCenterSource).not.toMatch(/await insertArtifact\(\s*id,/);
  });

  it("uses the transaction client for artifact inserts when a later transaction query fails", async () => {
    let transactionCall = 0;
    transactionQuery.mockImplementation(async () => {
      transactionCall += 1;
      if (transactionCall === 3) throw new Error("transaction insert failed");
      return { rows: [] };
    });

    const { createRecoveryPoint } = await import("../src/services/recoveryCenter.js");
    await expect(createRecoveryPoint({
      hostId: "00000000-0000-4000-8000-000000000001",
      appIdentity: { kind: "standalone", containerIds: ["source-web"] },
      triggerKind: "manual"
    })).rejects.toThrow("transaction insert failed");

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(transactionQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO recovery_points"), expect.any(Array));
    expect(transactionQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO recovery_artifacts"), expect.any(Array));
    expect(poolQuery.mock.calls.some((call) => String(call[0]).includes("INSERT INTO recovery_artifacts"))).toBe(false);
  });

  it("stores internal schedule metadata for scheduled retention", async () => {
    transactionQuery.mockResolvedValue({ rows: [] });
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            host_id: "00000000-0000-4000-8000-000000000002",
            name: "Nightly",
            app_identity: { kind: "standalone", containerIds: ["source-web"] },
            trigger_kind: "scheduled",
            status: "queued",
            backup_target_id: null,
            legacy_volume_backup_id: null,
            artifact_count: 1,
            completed_artifact_count: 0,
            total_bytes: null,
            error: null,
            metadata: {
              projectName: null,
              stackId: null,
              stopFirst: false,
              scheduleId: "00000000-0000-4000-8000-000000000003",
              retentionCount: 2
            },
            created_at: new Date("2026-06-15T12:00:00.000Z"),
            started_at: null,
            completed_at: null
          }]
        };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [] };
      return { rows: [] };
    });

    const { createRecoveryPoint } = await import("../src/services/recoveryCenter.js");
    await createRecoveryPoint({
      hostId: "00000000-0000-4000-8000-000000000002",
      appIdentity: { kind: "standalone", containerIds: ["source-web"] },
      triggerKind: "scheduled"
    }, null, {
      scheduleId: "00000000-0000-4000-8000-000000000003",
      retentionCount: 2
    });

    const insertCall = transactionQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO recovery_points"));
    expect(insertCall?.[1][7]).toMatchObject({
      scheduleId: "00000000-0000-4000-8000-000000000003",
      retentionCount: 2
    });
  });

  it("inserts a manual recovery point and job on the same transaction client", async () => {
    transactionQuery.mockResolvedValue({ rows: [] });
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM recovery_points")) {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000011",
            host_id: "00000000-0000-4000-8000-000000000001",
            name: "Standalone",
            app_identity: { kind: "standalone", containerIds: ["source-web"] },
            trigger_kind: "manual",
            status: "queued",
            backup_target_id: null,
            legacy_volume_backup_id: null,
            artifact_count: 2,
            completed_artifact_count: 0,
            total_bytes: null,
            error: null,
            metadata: { stopFirst: false },
            created_at: new Date("2026-07-10T12:00:00.000Z"),
            started_at: null,
            completed_at: null
          }]
        };
      }
      if (sql.includes("SELECT * FROM recovery_artifacts")) return { rows: [] };
      return { rows: [] };
    });

    const { createRecoveryPointWithJob } = await import("../src/services/recoveryCenter.js");
    const result = await createRecoveryPointWithJob({
      hostId: "00000000-0000-4000-8000-000000000001",
      appIdentity: { kind: "standalone", containerIds: ["source-web"] },
      triggerKind: "manual"
    }, "00000000-0000-4000-8000-000000000012");

    expect(enqueueJobInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: transactionQuery }),
      expect.objectContaining({
        type: "recovery.create",
        payload: expect.objectContaining({ recoveryPointId: expect.any(String), stopFirst: false })
      }),
      "00000000-0000-4000-8000-000000000012"
    );
    expect(notifyJobQueued).toHaveBeenCalledWith(result.job.id);
  });

  it("durably links a migration child and primary pointer in one fenced transaction", async () => {
    const migrationRunId = "00000000-0000-4000-8000-000000000020";
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT source_host_id")) {
        return {
          rows: [{
            source_host_id: "00000000-0000-4000-8000-000000000001",
            source_app_identity: { kind: "standalone", containerIds: ["source-web"] },
            mode: "execute",
            status: "running"
          }],
          rowCount: 1
        };
      }
      if (sql.includes("UPDATE migration_runs")) return { rows: [{ id: migrationRunId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const executionFence = {
      assertActive: vi.fn().mockResolvedValue(undefined),
      withActiveLease: vi.fn(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
        handler({ query: transactionQuery }))
    } as unknown as JobExecutionFence;

    const { createMigrationRecoveryPoint } = await import("../src/services/recoveryCenter.js");
    const created = await createMigrationRecoveryPoint({
      hostId: "00000000-0000-4000-8000-000000000001",
      appIdentity: { kind: "standalone", containerIds: ["source-web"] },
      triggerKind: "pre_migration",
      stopFirst: true
    }, migrationRunId, { primary: true, executionFence });

    const pointInsert = transactionQuery.mock.calls.find((call) => String(call[0]).includes("INSERT INTO recovery_points"));
    expect(pointInsert?.[1].at(-1)).toBe(migrationRunId);
    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE migration_runs"),
      [migrationRunId, created.id]
    );
    expect(executionFence.withActiveLease).toHaveBeenCalledOnce();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("does not publish a wake-up when recovery job insertion fails", async () => {
    transactionQuery.mockResolvedValue({ rows: [] });
    enqueueJobInTransaction.mockRejectedValueOnce(new Error("job insert failed"));
    const { createRecoveryPointWithJob } = await import("../src/services/recoveryCenter.js");

    await expect(createRecoveryPointWithJob({
      hostId: "00000000-0000-4000-8000-000000000001",
      appIdentity: { kind: "standalone", containerIds: ["source-web"] },
      triggerKind: "manual"
    })).rejects.toThrow("job insert failed");
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });
});
