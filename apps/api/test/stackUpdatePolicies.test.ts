import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  writeAuditEvent: vi.fn(),
  checkImageUpdatesForHost: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  lockComposeStackForMutation: vi.fn(),
  notifyJobQueued: vi.fn(),
  recordStackVersionInTransaction: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/audit.js", () => ({
  writeAuditEvent: (...args: unknown[]) => mocks.writeAuditEvent(...args)
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: (...args: unknown[]) =>
    mocks.checkImageUpdatesForHost(...args)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (...args: unknown[]) =>
    mocks.enqueueJobInTransaction(...args),
  lockComposeStackForMutation: (...args: unknown[]) =>
    mocks.lockComposeStackForMutation(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

vi.mock("../src/services/stackVersions.js", () => ({
  recordStackVersionInTransaction: (...args: unknown[]) =>
    mocks.recordStackVersionInTransaction(...args)
}));

const hostId = "10000000-0000-4000-8000-000000000001";
const stackId = "20000000-0000-4000-8000-000000000002";
const jobId = "30000000-0000-4000-8000-000000000003";
const stack = {
  id: stackId,
  host_id: hostId,
  name: "Policy app",
  project_name: "policy-app",
  compose_yaml: "services:\n  app:\n    image: registry.example.test/team/app:1\n",
  env: "PUBLIC_SETTING=value",
  status: "deployed",
  update_policy_enabled: true,
  update_policy_channel: "stable"
};
const client = {
  query: (...args: unknown[]) => mocks.transactionQuery(...args)
};

describe("stack update policy job atomicity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [stack] });
    mocks.withTransaction.mockImplementation(async (
      callback: (transactionClient: typeof client) => Promise<unknown>
    ) => callback(client));
    mocks.lockComposeStackForMutation.mockResolvedValue(stack);
    mocks.transactionQuery.mockResolvedValue({
      rows: [{
        image_reference: "registry.example.test/team/app:1"
      }]
    });
    mocks.checkImageUpdatesForHost.mockResolvedValue(undefined);
    mocks.recordStackVersionInTransaction.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000004"
    });
    mocks.enqueueJobInTransaction.mockResolvedValue({
      id: jobId,
      type: "compose.deploy",
      hostId,
      status: "queued"
    });
    mocks.writeAuditEvent.mockResolvedValue(undefined);
    mocks.notifyJobQueued.mockResolvedValue(undefined);
  });

  it("persists one fenced pull-and-deploy job, version, and audit before notifying", async () => {
    const { runStackUpdatePolicies } = await import("../src/services/stackUpdatePolicies.js");

    await expect(runStackUpdatePolicies()).resolves.toEqual({
      checked: 1,
      triggered: 1
    });

    expect(mocks.recordStackVersionInTransaction).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        stackId,
        composeYaml: stack.compose_yaml,
        env: stack.env,
        source: "deploy",
        note: expect.stringContaining("will pull 1 image")
      })
    );
    expect(mocks.enqueueJobInTransaction).toHaveBeenCalledWith(
      client,
      {
        type: "compose.deploy",
        hostId,
        payload: {
          stackId,
          pullBeforeDeploy: true
        }
      }
    );
    expect(mocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        hostId,
        action: "compose.auto_update",
        targetKind: "compose_stack",
        targetId: stackId,
        details: expect.objectContaining({
          images: ["registry.example.test/team/app:1"],
          jobId
        })
      }),
      client
    );
    expect(mocks.notifyJobQueued).toHaveBeenCalledWith(jobId);
    expect(mocks.notifyJobQueued.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.withTransaction.mock.invocationCallOrder[0]
    );
  });

  it("does not notify when the transactional audit fails", async () => {
    const auditFailure = new Error("audit insert failed");
    mocks.writeAuditEvent.mockRejectedValueOnce(auditFailure);
    const { runStackUpdatePolicies } = await import("../src/services/stackUpdatePolicies.js");

    await expect(runStackUpdatePolicies()).rejects.toBe(auditFailure);

    expect(mocks.enqueueJobInTransaction).toHaveBeenCalledOnce();
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });

  it("revalidates the locked policy and skips stale disabled rows", async () => {
    mocks.lockComposeStackForMutation.mockResolvedValue({
      ...stack,
      update_policy_enabled: false
    });
    const { runStackUpdatePolicies } = await import("../src/services/stackUpdatePolicies.js");

    await expect(runStackUpdatePolicies()).resolves.toEqual({
      checked: 1,
      triggered: 0
    });

    expect(mocks.transactionQuery).not.toHaveBeenCalled();
    expect(mocks.recordStackVersionInTransaction).not.toHaveBeenCalled();
    expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });
});
