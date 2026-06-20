import { describe, expect, it } from "vitest";
import type { OperationJob } from "@composebastion/shared";
import { activeJobPhase, jobProgressSteps, jobRecoveryHint } from "./jobProgress.js";

const baseJob: OperationJob = {
  id: "11111111-1111-4111-8111-111111111111",
  correlationId: "11111111-1111-4111-8111-111111111111",
  type: "host.sync",
  status: "running",
  hostId: "22222222-2222-4222-8222-222222222222",
  payload: {},
  result: null,
  progress: [],
  error: null,
  createdBy: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  startedAt: null,
  completedAt: null
};

describe("job progress helpers", () => {
  it("prefers persisted progress over fallback steps", () => {
    const steps = jobProgressSteps({
      ...baseJob,
      progress: [
        { id: "connect", label: "Connect", status: "completed" },
        { id: "inventory", label: "Inventory", status: "running" }
      ]
    });

    expect(steps).toEqual([
      { label: "Connect", status: "done" },
      { label: "Inventory", status: "active" }
    ]);
    expect(activeJobPhase({ ...baseJob, progress: [{ id: "inventory", label: "Inventory", status: "running" }] })).toBe("Inventory");
  });

  it("returns useful recovery hints by job family", () => {
    expect(jobRecoveryHint({ type: "backup.drill", status: "failed", error: "boom" })).toContain("backup target");
    expect(jobRecoveryHint({ type: "migration.execute", status: "failed", error: "boom" })).toContain("migration run");
    expect(jobRecoveryHint({ type: "host.sync", status: "failed", error: "boom" })).toContain("connectivity");
    expect(jobRecoveryHint({ type: "container.update", status: "failed", error: "boom" })).toContain("registry");
  });

  it("keeps non-failed states calm and actionable", () => {
    expect(jobRecoveryHint({ type: "host.sync", status: "queued", error: null })).toContain("Waiting");
    expect(jobRecoveryHint({ type: "host.sync", status: "completed", error: null })).toContain("No recovery");
  });
});
