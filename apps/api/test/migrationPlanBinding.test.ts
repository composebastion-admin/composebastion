import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const clientQuery = vi.fn();
const withTransaction = vi.fn();
const enqueueJob = vi.fn();
const enqueueJobInTransaction = vi.fn();
const notifyJobQueued = vi.fn();
const revalidateMigrationPlan = vi.fn();
const refreshMigrationInventories = vi.fn();
const analyzeMigrationPlan = vi.fn();
const resolveAppContext = vi.fn();
const recoveryAppIdentitiesEqual = vi.fn();

class MockMigrationPlanStaleError extends Error {
  readonly statusCode = 409;
  readonly code = "MIGRATION_PLAN_STALE";

  constructor(message: string, readonly blockingIssues: string[] = []) {
    super(message);
    this.name = "MigrationPlanStaleError";
  }
}

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJob(...args),
  enqueueJobInTransaction: (...args: unknown[]) => enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => notifyJobQueued(...args)
}));

vi.mock("../src/services/migrationPlanning.js", () => ({
  analyzeMigrationPlan: (...args: unknown[]) => analyzeMigrationPlan(...args),
  buildMigrationPlan: vi.fn(),
  MigrationPlanStaleError: MockMigrationPlanStaleError,
  recoveryAppIdentitiesEqual: (...args: unknown[]) => recoveryAppIdentitiesEqual(...args),
  revalidateMigrationPlan: (...args: unknown[]) => revalidateMigrationPlan(...args),
  refreshMigrationInventories: (...args: unknown[]) => refreshMigrationInventories(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
}));

const sourceHostId = "00000000-0000-4000-8000-000000000001";
const targetHostId = "00000000-0000-4000-8000-000000000002";
const planRunId = "00000000-0000-4000-8000-000000000003";
const executeRunId = "00000000-0000-4000-8000-000000000004";
const sourceAppIdentity = { kind: "compose", projectName: "demoapp" } as const;
const plan = {
  sourceHostId,
  targetHostId,
  sourceAppIdentity,
  intent: {
    strategy: "clone" as const,
    options: { stopSource: false, remapPorts: true, networkMode: "clone" as const }
  },
  sourceFingerprint: "a".repeat(64),
  targetFingerprint: "b".repeat(64),
  steps: [],
  warnings: [],
  estimatedArtifacts: 1,
  estimatedVolumes: 0,
  estimatedHostFolders: 0,
  checks: {
    sourceHostAvailable: true,
    targetHostAvailable: true,
    sourceDockerAvailable: true,
    targetDockerAvailable: true,
    sourceComposeAvailable: true,
    targetComposeAvailable: true
  },
  portConflicts: [],
  volumeCollisions: [],
  nameCollisions: [],
  missingNetworks: [],
  networkConflicts: [],
  estimatedDataBytes: null,
  blockingIssues: []
};
const planRow = {
  id: planRunId,
  plan_run_id: null,
  source_host_id: sourceHostId,
  target_host_id: targetHostId,
  source_app_identity: sourceAppIdentity,
  mode: "plan",
  status: "completed",
  recovery_point_id: null,
  plan,
  error: null,
  created_at: new Date("2026-07-10T10:00:00.000Z"),
  started_at: new Date("2026-07-10T10:00:00.000Z"),
  completed_at: new Date("2026-07-10T10:00:00.000Z")
};
const executeRow = {
  ...planRow,
  id: executeRunId,
  plan_run_id: planRunId,
  mode: "execute",
  status: "queued",
  started_at: null,
  completed_at: null
};
const job = {
  id: "00000000-0000-4000-8000-000000000005",
  type: "migration.execute",
  hostId: sourceHostId,
  payload: { migrationRunId: executeRunId }
};

function recoveryPointRow(
  id: string,
  appIdentity = sourceAppIdentity,
  metadata: Record<string, unknown> = {}
) {
  return {
    id,
    host_id: sourceHostId,
    name: "Reusable migration point",
    app_identity: appIdentity,
    trigger_kind: "pre_migration",
    status: "completed",
    backup_target_id: null,
    legacy_volume_backup_id: null,
    profile_id: null,
    migration_run_id: null,
    artifact_count: 0,
    completed_artifact_count: 0,
    total_bytes: 0,
    error: null,
    metadata,
    created_at: new Date("2026-07-10T10:00:00.000Z"),
    started_at: new Date("2026-07-10T10:00:00.000Z"),
    completed_at: new Date("2026-07-10T10:00:00.000Z")
  };
}

describe("migration plan execution binding", () => {
  let existingExecution: boolean;
  let suppliedPoint: ReturnType<typeof recoveryPointRow> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    existingExecution = false;
    suppliedPoint = null;
    withTransaction.mockImplementation(async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM migration_runs")) {
        return { rows: [planRow] };
      }
      if (sql.includes("INSERT INTO migration_runs")) {
        return { rows: [planRow] };
      }
      if (sql.includes("SELECT * FROM recovery_points")) {
        return { rows: suppliedPoint ? [suppliedPoint] : [] };
      }
      if (sql.includes("FROM recovery_artifacts")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    refreshMigrationInventories.mockResolvedValue(undefined);
    resolveAppContext.mockResolvedValue({
      label: "Demo",
      projectName: "demoapp",
      stackId: null,
      composeYaml: "services:\n  web:\n    image: nginx\n",
      env: "",
      workingDir: null,
      composePath: null,
      containerIds: ["web"],
      volumeNames: []
    });
    analyzeMigrationPlan.mockResolvedValue(plan);
    revalidateMigrationPlan.mockResolvedValue(plan);
    recoveryAppIdentitiesEqual.mockReturnValue(true);
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("FROM operation_jobs")) {
        return { rows: [] };
      }
      if (sql.includes("FROM recovery_restore_attempts")) {
        return { rows: [] };
      }
      if (
        sql.includes("FROM recovery_points")
        && sql.includes("sourceRestartPending")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("SELECT id FROM migration_runs")
        && sql.includes("mode = 'plan'")
      ) {
        return { rows: [{ id: planRunId }] };
      }
      if (sql.includes("WHERE plan_run_id = $1")) {
        return {
          rows: existingExecution
            ? [{ id: executeRunId }]
            : []
        };
      }
      if (
        sql.includes("SELECT host_id, app_identity")
        && sql.includes("FROM recovery_points")
      ) {
        return { rows: suppliedPoint ? [suppliedPoint] : [] };
      }
      if (sql.includes("INSERT INTO migration_runs")) {
        return {
          rows: [{
            ...executeRow,
            recovery_point_id: suppliedPoint?.id ?? null
          }]
        };
      }
      if (sql.includes("UPDATE operation_jobs")) {
        return { rows: [{ id: job.id }], rowCount: 1 };
      }
      return { rows: [] };
    });
    enqueueJobInTransaction.mockResolvedValue(job);
    notifyJobQueued.mockResolvedValue(undefined);
  });

  it("atomically inserts the execution and job, then notifies after commit", async () => {
    const { startMigrationExecute } = await import("../src/services/recoveryCenter.js");
    const result = await startMigrationExecute({ planRunId });

    expect(result.run.planRunId).toBe(planRunId);
    expect(enqueueJobInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query: clientQuery }),
      expect.objectContaining({
        type: "migration.execute",
        hostId: sourceHostId,
        payload: expect.objectContaining({
          migrationRunId: executeRunId,
          strategy: "clone",
          remapPorts: true
        })
      }),
      undefined
    );
    expect(notifyJobQueued).toHaveBeenCalledWith(job.id);
    expect(notifyJobQueued.mock.invocationCallOrder[0]).toBeGreaterThan(withTransaction.mock.invocationCallOrder[0]);
  });

  it("rejects a second execution of the same reviewed plan", async () => {
    existingExecution = true;

    const { startMigrationExecute } = await import("../src/services/recoveryCenter.js");
    await expect(startMigrationExecute({ planRunId })).rejects.toMatchObject({
      code: "MIGRATION_PLAN_STALE",
      statusCode: 409
    });
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("keeps legacy execute requests compatible by creating an implicit fresh plan", async () => {
    const { startMigrationExecute } = await import("../src/services/recoveryCenter.js");
    const result = await startMigrationExecute({
      sourceHostId,
      targetHostId,
      sourceAppIdentity,
      strategy: "clone",
      options: { stopSource: false, remapPorts: true, networkMode: "clone" }
    });

    expect(refreshMigrationInventories).toHaveBeenCalledWith(sourceHostId, targetHostId);
    expect(analyzeMigrationPlan).toHaveBeenCalledWith(
      expect.objectContaining({ sourceHostId, targetHostId, strategy: "clone" }),
      expect.any(Object)
    );
    expect(result.run.planRunId).toBe(planRunId);
    expect(enqueueJobInTransaction).toHaveBeenCalledOnce();
  });

  it("rejects a legacy recovery point that belongs to a different source application", async () => {
    recoveryAppIdentitiesEqual.mockReturnValue(false);
    suppliedPoint = recoveryPointRow(
      "00000000-0000-4000-8000-000000000099",
      { kind: "compose", projectName: "different-app" }
    );

    const { startMigrationExecute } = await import("../src/services/recoveryCenter.js");
    await expect(startMigrationExecute({
      sourceHostId,
      targetHostId,
      sourceAppIdentity,
      recoveryPointId: "00000000-0000-4000-8000-000000000099",
      strategy: "clone",
      options: { stopSource: false, remapPorts: true, networkMode: "clone" }
    })).rejects.toMatchObject({
      code: "MIGRATION_PLAN_STALE",
      statusCode: 409
    });

    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("rejects a legacy recovery point after deletion has claimed it", async () => {
    suppliedPoint = recoveryPointRow(
      "00000000-0000-4000-8000-000000000097",
      sourceAppIdentity,
      {
        deletionClaimToken: "delete-claim",
        deletionClaimedAt: "2026-07-30T10:00:00.000Z"
      }
    );

    const { startMigrationExecute } = await import("../src/services/recoveryCenter.js");
    await expect(startMigrationExecute({
      sourceHostId,
      targetHostId,
      sourceAppIdentity,
      recoveryPointId: "00000000-0000-4000-8000-000000000097",
      strategy: "clone",
      options: { stopSource: false, remapPorts: true, networkMode: "clone" }
    })).rejects.toMatchObject({
      code: "MIGRATION_PLAN_STALE",
      statusCode: 409
    });

    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("binds a reusable legacy recovery point through the execution row without claiming child ownership", async () => {
    const legacyPointId = "00000000-0000-4000-8000-000000000098";
    suppliedPoint = recoveryPointRow(legacyPointId);

    const { startMigrationExecute } = await import("../src/services/recoveryCenter.js");
    const result = await startMigrationExecute({
      sourceHostId,
      targetHostId,
      sourceAppIdentity,
      recoveryPointId: legacyPointId,
      strategy: "clone",
      options: { stopSource: false, remapPorts: true, networkMode: "clone" }
    });

    expect(result.run.recoveryPointId).toBe(legacyPointId);
    expect(clientQuery.mock.calls.some((call) => String(call[0]).includes("SET migration_run_id"))).toBe(false);
    expect(enqueueJobInTransaction).toHaveBeenCalledOnce();
  });
});
