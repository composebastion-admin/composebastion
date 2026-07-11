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

describe("migration plan execution binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTransaction.mockImplementation(async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery }));
    query.mockResolvedValue({ rows: [planRow] });
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
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: planRunId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [executeRow] });
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
    clientQuery.mockReset();
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: planRunId }] })
      .mockResolvedValueOnce({ rows: [{ id: executeRunId }] });

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
    clientQuery.mockReset();
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: planRunId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          host_id: sourceHostId,
          app_identity: { kind: "compose", projectName: "different-app" },
          status: "completed",
          migration_run_id: null
        }]
      });

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

  it("binds a reusable legacy recovery point through the execution row without claiming child ownership", async () => {
    const legacyPointId = "00000000-0000-4000-8000-000000000098";
    clientQuery.mockReset();
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: planRunId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          host_id: sourceHostId,
          app_identity: sourceAppIdentity,
          status: "completed",
          migration_run_id: null
        }]
      })
      .mockResolvedValueOnce({ rows: [{ ...executeRow, recovery_point_id: legacyPointId }] });

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
