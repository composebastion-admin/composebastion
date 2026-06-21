import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQuery = vi.fn();
const withTransaction = vi.fn();
const transactionQuery = vi.fn();
const resolveAppContext = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => poolQuery(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => resolveAppContext(...args)
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
});
