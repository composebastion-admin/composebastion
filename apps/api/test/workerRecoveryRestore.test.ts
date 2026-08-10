import { beforeEach, describe, expect, it, vi } from "vitest";

const restoreMocks = vi.hoisted(() => ({
  runRecoveryRestore: vi.fn(),
  runRecoveryRestoreDrill: vi.fn()
}));

vi.mock("../src/services/recoveryRestore.js", () => ({
  runRecoveryRestore: restoreMocks.runRecoveryRestore,
  runRecoveryRestoreDrill: restoreMocks.runRecoveryRestoreDrill
}));

describe("worker recovery restore dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreMocks.runRecoveryRestore.mockResolvedValue({ mode: "clone" });
    restoreMocks.runRecoveryRestoreDrill.mockResolvedValue({ mode: "clone" });
  });

  it("routes every drill attempt through validated teardown and leaves normal restore unchanged", async () => {
    const { runWorkerRecoveryRestore } = await import("../src/services/workerRecoveryRestore.js");
    const hostId = "00000000-0000-4000-8000-000000000002";
    const request = {
      recoveryPointId: "00000000-0000-4000-8000-000000000004",
      targetHostId: hostId,
      options: {
        mode: "clone" as const,
        stopExisting: false,
        remapPorts: true,
        networkMode: "clone" as const
      }
    };
    const fence = {
      assertActive: vi.fn(),
      withActiveLease: vi.fn()
    };

    await runWorkerRecoveryRestore(hostId, request, true, fence);
    await runWorkerRecoveryRestore(hostId, request, true, fence);
    await runWorkerRecoveryRestore(hostId, request, false, fence);

    expect(restoreMocks.runRecoveryRestoreDrill).toHaveBeenCalledTimes(2);
    expect(restoreMocks.runRecoveryRestoreDrill).toHaveBeenNthCalledWith(1, hostId, request, fence);
    expect(restoreMocks.runRecoveryRestoreDrill).toHaveBeenNthCalledWith(2, hostId, request, fence);
    expect(restoreMocks.runRecoveryRestore).toHaveBeenCalledOnce();
    expect(restoreMocks.runRecoveryRestore).toHaveBeenCalledWith(hostId, request, fence);
  });

  it("propagates drill teardown failures to the worker's durable failure path", async () => {
    const { runWorkerRecoveryRestore } = await import("../src/services/workerRecoveryRestore.js");
    const hostId = "00000000-0000-4000-8000-000000000002";
    const request = {
      recoveryPointId: "00000000-0000-4000-8000-000000000004",
      targetHostId: hostId,
      options: {
        mode: "clone" as const,
        stopExisting: false,
        remapPorts: true,
        networkMode: "clone" as const
      }
    };
    const fence = {
      assertActive: vi.fn(),
      withActiveLease: vi.fn()
    };
    restoreMocks.runRecoveryRestoreDrill.mockRejectedValueOnce(
      new Error("Failed to clean up completed clone restore: teardown blocked")
    );

    await expect(
      runWorkerRecoveryRestore(hostId, request, true, fence)
    ).rejects.toThrow("Failed to clean up completed clone restore: teardown blocked");

    expect(restoreMocks.runRecoveryRestore).not.toHaveBeenCalled();
  });
});
