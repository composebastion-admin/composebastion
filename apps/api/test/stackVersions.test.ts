import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffText } from "@composebastion/shared";
import { rollbackStackVersion } from "../src/services/stackVersions.js";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (work: (client: { query: typeof mocks.clientQuery }) => unknown) =>
    work({ query: mocks.clientQuery }))
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  lockComposeStackForMutation: async (
    client: { query: typeof mocks.clientQuery },
    stackId: string
  ) => {
    const selected = await client.query(
      "SELECT * FROM compose_stacks WHERE id = $1 FOR UPDATE",
      [stackId]
    );
    return selected.rows[0] ?? null;
  },
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

const v1 = {
  id: "00000000-0000-4000-8000-000000000101",
  stack_id: "00000000-0000-4000-8000-000000000100",
  version_number: 1,
  compose_yaml: "services:\n  app:\n    image: nginx:1\n",
  env: "",
  source: "host_files",
  note: null,
  created_by: null,
  created_at: "2026-07-30T00:00:00.000Z"
};

function folderBackedStack(sourceType: "host_files" | "git") {
  return {
    id: v1.stack_id,
    host_id: "00000000-0000-4000-8000-000000000102",
    compose_yaml: "services:\n  app:\n    image: nginx:2\n",
    env: "",
    source_type: sourceType,
    source_working_dir: "/srv/apps/example",
    source_compose_path: "compose.yaml"
  };
}

describe("stack version diff helper", () => {
  it("reports env-agnostic compose line changes", () => {
    const changes = diffText("services:\n  app:\n    image: nginx:1", "services:\n  app:\n    image: nginx:2");
    expect(changes.some((change) => change.type === "change")).toBe(true);
  });
});

describe("stack version rollback safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["host_files", "git"] as const)(
    "fails closed before changing a %s folder-backed stack",
    async (sourceType) => {
      mocks.clientQuery
        .mockResolvedValueOnce({ rows: [v1] })
        .mockResolvedValueOnce({ rows: [folderBackedStack(sourceType)] });

      const rollback = rollbackStackVersion(v1.stack_id, v1.id);
      await expect(rollback).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("cannot safely overwrite source files")
      });

      expect(mocks.clientQuery).toHaveBeenCalledTimes(2);
      expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE "))).toBe(false);
      expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).startsWith("INSERT "))).toBe(false);
      expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
      expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
    }
  );

  it("does not publish a rollback job when its transactional audit fails", async () => {
    const managedStack = {
      ...folderBackedStack("git"),
      source_working_dir: null,
      source_compose_path: null
    };
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM compose_stack_versions") && sql.includes("id = $2")) {
        return { rows: [v1] };
      }
      if (sql.includes("FROM compose_stacks") && sql.includes("FOR UPDATE")) {
        return { rows: [managedStack] };
      }
      if (sql.includes("COALESCE(MAX(version_number)")) {
        return { rows: [{ version_number: 2 }] };
      }
      if (sql.includes("INSERT INTO compose_stack_versions")) {
        return {
          rows: [{
            ...v1,
            id: "00000000-0000-4000-8000-000000000104",
            version_number: 2
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.enqueueJobInTransaction.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000103",
      type: "compose.deploy",
      hostId: managedStack.host_id,
      status: "queued"
    });
    const auditFailure = new Error("audit insert failed");
    const onQueued = vi.fn(async () => {
      throw auditFailure;
    });

    await expect(rollbackStackVersion(
      v1.stack_id,
      v1.id,
      "user-1",
      null,
      onQueued
    )).rejects.toBe(auditFailure);

    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.clientQuery }),
      expect.objectContaining({
        version: expect.objectContaining({ id: v1.id }),
        job: expect.objectContaining({
          id: "00000000-0000-4000-8000-000000000103"
        })
      })
    );
    expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
  });
});
