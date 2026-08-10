import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());
const assertDockerMutationDoesNotConflictWithRecovery = vi.hoisted(() =>
  vi.fn()
);

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: async (
    callback: (client: { query: typeof transactionQuery }) => Promise<unknown>
  ) => callback({ query: transactionQuery })
}));
vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));
vi.mock("../src/services/recoveryOperationAdmission.js", () => ({
  assertDockerMutationDoesNotConflictWithRecovery
}));

const { enqueueJob } = await import("../src/services/jobs.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";
const stackId = "33333333-3333-4333-8333-333333333333";
const activeJobId = "44444444-4444-4444-8444-444444444444";
const queuedJobId = "55555555-5555-4555-8555-555555555555";

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: activeJobId,
    type: "container.stop",
    status: "running",
    host_id: hostId,
    payload: { containerId: "web" },
    result: null,
    progress: [],
    error: null,
    created_by: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    started_at: new Date(0),
    completed_at: null,
    lease_owner: "worker",
    lease_expires_at: new Date(Date.now() + 60_000),
    attempt_count: 1,
    ...overrides
  };
}

type RouterOptions = {
  active?: Array<Record<string, unknown>>;
  ambiguous?: Array<Record<string, unknown>>;
  managed?: Array<Record<string, unknown>>;
};

function arrangeRouter({
  active = [],
  ambiguous = [],
  managed = []
}: RouterOptions = {}) {
  const standalone = [
    {
      kind: "container",
      external_id: "sha256:web",
      name: "web",
      data: { Labels: {} }
    },
    {
      kind: "container",
      external_id: "sha256:other",
      name: "other",
      data: { Labels: {} }
    }
  ];
  transactionQuery.mockImplementation(async (
    sql: string,
    values: unknown[] = []
  ) => {
    if (sql.includes("FROM docker_hosts")) {
      return { rows: [{ id: hostId }], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM deployment_analyses")) {
      return {
        rows: [{
          host_id: hostId,
          working_dir: "/srv/demo",
          project_name: "demo"
        }]
      };
    }
    if (sql.includes("FROM compose_stacks")) {
      return {
        rows: [{
          id: stackId,
          host_id: hostId,
          source_working_dir: "/srv/demo",
          project_name: "demo"
        }]
      };
    }
    if (sql.includes("kind IN ('container', 'network', 'volume')")) {
      return { rows: managed };
    }
    if (sql.includes("external_id = ANY")) {
      const requested = new Set(values[2] as string[]);
      return {
        rows: [...standalone, ...managed].filter((row) =>
          requested.has(String(row.external_id))
          || requested.has(String(row.name))
        )
      };
    }
    if (
      sql.includes("FROM operation_jobs")
      && sql.includes("status IN ('queued', 'running')")
    ) {
      return { rows: active, rowCount: active.length };
    }
    if (
      sql.includes("FROM operation_jobs")
      && sql.includes("status = 'failed'")
    ) {
      return { rows: ambiguous, rowCount: ambiguous.length };
    }
    if (sql.includes("INSERT INTO operation_jobs")) {
      return {
        rows: [operationRow({
          id: queuedJobId,
          type: values[1],
          status: "queued",
          host_id: values[2],
          payload: values[3],
          started_at: null,
          lease_owner: null,
          lease_expires_at: null,
          attempt_count: 0
        })],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  });
}

const managedWeb = {
  kind: "container",
  external_id: "sha256:web",
  name: "web",
  data: {
    Image: "registry.example.test/demo:1",
    Labels: { "com.docker.compose.project": "demo" }
  }
};

describe("cross-surface Docker mutation admission", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
    assertDockerMutationDoesNotConflictWithRecovery.mockReset();
    assertDockerMutationDoesNotConflictWithRecovery.mockResolvedValue(
      undefined
    );
  });

  it.each([
    {
      label: "deployment",
      active: operationRow({
        type: "deploy.execute",
        payload: { analysisId }
      })
    },
    {
      label: "standard Compose",
      active: operationRow({
        type: "compose.stop",
        payload: { stackId }
      })
    }
  ])("blocks a direct object mutation behind an active $label", async ({
    active
  }) => {
    arrangeRouter({ active: [active], managed: [managedWeb] });

    await expect(enqueueJob({
      type: "container.stop",
      hostId,
      payload: { containerId: "web" }
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )).toBe(false);
  });

  it.each([
    {
      label: "deployment",
      action: {
        type: "deploy.execute" as const,
        hostId,
        payload: { analysisId }
      }
    },
    {
      label: "standard Compose",
      action: {
        type: "compose.stop" as const,
        hostId,
        payload: { stackId }
      }
    }
  ])("blocks a $label behind an active direct managed-object mutation", async ({
    action
  }) => {
    arrangeRouter({
      active: [operationRow()],
      managed: [managedWeb]
    });

    await expect(enqueueJob(action)).rejects.toMatchObject({
      statusCode: 409,
      activeJobId
    });
  });

  it("keeps unrelated known standalone objects concurrent", async () => {
    arrangeRouter({
      active: [operationRow({
        id: activeJobId,
        payload: { containerId: "other" }
      })]
    });

    await expect(enqueueJob({
      type: "container.stop",
      hostId,
      payload: { containerId: "web" }
    })).resolves.toMatchObject({
      id: queuedJobId,
      type: "container.stop"
    });
  });

  it("blocks enqueue when an exact recovery intent owns the resource", async () => {
    arrangeRouter();
    assertDockerMutationDoesNotConflictWithRecovery.mockRejectedValueOnce(
      Object.assign(new Error("recovery owns web"), {
        statusCode: 409,
        activeJobId
      })
    );

    await expect(enqueueJob({
      type: "container.stop",
      hostId,
      payload: { containerId: "web" }
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId
    });
    expect(assertDockerMutationDoesNotConflictWithRecovery)
      .toHaveBeenCalledOnce();
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )).toBe(false);
  });
});
