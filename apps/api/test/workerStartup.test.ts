import { afterAll, describe, expect, it, vi } from "vitest";

const workerMocks = vi.hoisted(() => ({
  backfillDeploymentSourceEncryptedEnvironment: vi.fn(),
  claimNextJob: vi.fn(),
  reconcileSelfUpdateHandoffs: vi.fn(),
  redisClose: vi.fn(),
  startRedisWakeupSubscription: vi.fn()
}));

const asyncNoop = () => vi.fn().mockResolvedValue(undefined);

vi.mock("../src/config/env.js", () => ({
  env: {
    DATABASE_URL: "postgresql://worker:secret@database/composebastion",
    HOST_CHECK_INTERVAL_MS: 60_000,
    INVENTORY_SYNC_INTERVAL_MS: 60_000
  }
}));
vi.mock("../src/db/migrate.js", () => ({ runMigrations: asyncNoop() }));
vi.mock("../src/db/pool.js", () => ({ pool: { end: asyncNoop() } }));
vi.mock("../src/services/auth.js", () => ({ deleteExpiredSessions: asyncNoop() }));
vi.mock("../src/services/alerts.js", () => ({ runAlertChecks: asyncNoop() }));
vi.mock("../src/services/backups.js", () => ({
  runBackupDrill: asyncNoop(),
  runBackupVerify: asyncNoop(),
  runHostPathBackup: asyncNoop(),
  runHostPathRestore: asyncNoop(),
  runVolumeBackup: asyncNoop(),
  runVolumeClone: asyncNoop(),
  runVolumeRestore: asyncNoop()
}));
vi.mock("../src/services/docker.js", () => ({ executeDockerAction: asyncNoop() }));
vi.mock("../src/services/deployments.js", () => ({
  analyzeDeployment: asyncNoop(),
  backfillDeploymentSourceEncryptedEnvironment: workerMocks.backfillDeploymentSourceEncryptedEnvironment,
  cleanupExpiredDeploymentAnalyses: asyncNoop(),
  configureRegistryTrust: asyncNoop(),
  executeDeployment: asyncNoop()
}));
vi.mock("../src/services/hosts.js", () => ({ listHostIds: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/services/jobs.js", () => {
  class MockJobLeaseLostError extends Error {}
  return {
    buildJobProgress: vi.fn().mockReturnValue([]),
    assertJobLeaseActive: asyncNoop(),
    claimNextJob: workerMocks.claimNextJob,
    cleanupWorkerInstances: asyncNoop(),
    completeJob: vi.fn().mockResolvedValue(true),
    enqueueJob: asyncNoop(),
    failJob: vi.fn().mockResolvedValue(true),
    heartbeatWorker: vi.fn().mockResolvedValue(true),
    JOB_LEASE_MAINTENANCE_INTERVAL_MS: 10_000,
    JobLeaseLostError: MockJobLeaseLostError,
    markJobProgressStep: asyncNoop(),
    markSelfUpdateHandoffPending: vi.fn().mockResolvedValue(true),
    markWorkerDraining: asyncNoop(),
    markWorkerStopped: asyncNoop(),
    recoverExpiredJobs: vi.fn().mockResolvedValue({ requeued: 0, failed: 0 }),
    registerWorkerInstance: asyncNoop(),
    renewJobLease: vi.fn().mockResolvedValue(true),
    shouldResumeWorkerClaimsAfterReconciliation: (result: { completed: number; failed: number; pending: number }) =>
      result.pending === 0,
    shouldStopWorkerClaimsAfterHandoff: (type: string, pending: boolean) =>
      type === "system.self_update" && pending,
    updateJobProgress: asyncNoop(),
    withActiveJobLeaseTransaction: asyncNoop(),
    WORKER_HEARTBEAT_INTERVAL_MS: 5_000
  };
});
vi.mock("../src/services/redisWakeups.js", () => ({
  startRedisWakeupSubscription: workerMocks.startRedisWakeupSubscription
}));
vi.mock("../src/services/backupSchedules.js", () => ({ runDueBackupSchedules: asyncNoop() }));
vi.mock("../src/services/recoveryCenter.js", () => ({
  markRecoveryDrillResult: asyncNoop(),
  runDueRecoverySchedules: asyncNoop(),
  runMigrationExecute: asyncNoop(),
  runRecoveryCreate: asyncNoop(),
  runRecoveryRestore: asyncNoop(),
  runRecoveryVerify: asyncNoop()
}));
vi.mock("../src/services/selfUpdate.js", () => ({
  confirmSelfUpdateHandoff: asyncNoop(),
  reconcileSelfUpdateHandoffs: workerMocks.reconcileSelfUpdateHandoffs,
  runSelfUpdate: asyncNoop()
}));
vi.mock("../src/services/stackUpdatePolicies.js", () => ({ runStackUpdatePolicies: asyncNoop() }));
vi.mock("../src/services/operationLogs.js", () => ({
  safeErrorMessage: (error: unknown) => String(error),
  workerJobLogFields: vi.fn().mockReturnValue({})
}));
vi.mock("../src/services/nonOverlappingTask.js", () => ({
  createNonOverlappingTask: vi.fn().mockReturnValue({
    isStopped: () => false,
    run: vi.fn().mockResolvedValue({ started: true, value: true }),
    stop: vi.fn()
  })
}));
vi.mock("../src/services/version.js", () => ({ APP_VERSION: "1.2.0-beta.1" }));

describe("worker self-update startup handoff", () => {
  it("does not claim jobs while a handoff is pending and resumes only after terminal reconciliation", async () => {
    const intervals: Array<{ handler: () => void; timeout: number }> = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      intervals.push({ handler, timeout: timeout ?? 0 });
      return intervals.length as unknown as NodeJS.Timeout;
    }) as typeof setInterval);
    vi.spyOn(process, "once").mockImplementation((() => process) as typeof process.once);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    workerMocks.claimNextJob.mockResolvedValue(null);
    let finishBackfill!: () => void;
    workerMocks.backfillDeploymentSourceEncryptedEnvironment.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishBackfill = resolve;
      })
    );
    workerMocks.startRedisWakeupSubscription.mockReturnValue({ close: workerMocks.redisClose });
    workerMocks.reconcileSelfUpdateHandoffs
      .mockResolvedValueOnce({ completed: 0, failed: 0, pending: 1 })
      // A different worker can consume and reconcile the durable handoff.
      .mockResolvedValueOnce({ completed: 0, failed: 0, pending: 0 })
      .mockResolvedValue({ completed: 0, failed: 0, pending: 0 });

    await import("../src/worker.js");
    await vi.waitFor(() => {
      expect(workerMocks.backfillDeploymentSourceEncryptedEnvironment).toHaveBeenCalledTimes(1);
    });
    expect(workerMocks.startRedisWakeupSubscription).not.toHaveBeenCalled();
    expect(workerMocks.claimNextJob).not.toHaveBeenCalled();

    finishBackfill();
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith(expect.stringContaining("ComposeBastion worker started"));
    });

    expect(workerMocks.startRedisWakeupSubscription).toHaveBeenCalledTimes(1);
    expect(workerMocks.backfillDeploymentSourceEncryptedEnvironment.mock.invocationCallOrder[0])
      .toBeLessThan(workerMocks.startRedisWakeupSubscription.mock.invocationCallOrder[0]!);
    expect(workerMocks.claimNextJob).not.toHaveBeenCalled();
    expect(intervals.slice(0, 4).map(({ timeout }) => timeout)).toEqual([2_500, 5_000, 10_000, 10_000]);

    intervals[3]!.handler();
    await vi.waitFor(() => {
      expect(workerMocks.reconcileSelfUpdateHandoffs).toHaveBeenCalledTimes(2);
    });
    expect(workerMocks.claimNextJob).not.toHaveBeenCalled();

    intervals[0]!.handler();
    await vi.waitFor(() => {
      expect(workerMocks.claimNextJob).toHaveBeenCalledTimes(1);
    });
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});
