import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());
const enqueueJobInTransaction = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction,
  notifyJobQueued: vi.fn()
}));

const {
  backfillDeploymentSourceEncryptedEnvironment,
  createDeploymentAnalysis,
  createDeploymentSource,
  deploymentAnalysisInternals
} = await import("../src/services/deployments.js");
const { decryptSecret } = await import("../src/services/crypto.js");

const hostId = "00000000-0000-4000-8000-000000000001";

describe("deployment URL validation boundaries", () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
    enqueueJobInTransaction.mockReset();
  });

  it.each([
    ["https://git-user:git-secret@git.example.test/team/app.git", undefined],
    ["https://git.example.test/team/app.git?token=git-secret", undefined],
    ["ssh://git:git-secret@git.example.test/team/app.git", "git"],
    ["git://git:git-secret@git.example.test/team/app.git", "git"],
    ["https://compose-user:compose-secret@example.test/compose.yaml", undefined],
    ["https://example.test/compose.yaml?token=compose-secret", undefined],
    ["https://example.test/compose.yaml#compose-secret", "compose_url"]
  ])("rejects unsafe analysis source %s before persistence or enqueue", async (source, sourceType) => {
    await expect(createDeploymentAnalysis({
      hostId,
      source,
      ...(sourceType ? { sourceType } : {})
    })).rejects.toThrow();

    expect(query).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
  });

  it("rejects unsupported Compose URL credential fields before persistence", async () => {
    await expect(createDeploymentAnalysis({
      hostId,
      source: "https://example.test/compose.yaml",
      credentialUsername: "compose-user",
      credentialSecret: "compose-secret"
    })).rejects.toThrow("Compose URL credentials are not supported");

    expect(query).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["git", "https://git.example.test/team/app.git?token=git-secret"],
    ["compose_url", "https://example.test/compose.yaml?token=compose-secret"]
  ] as const)("rejects unsafe %s library sources before persistence", async (sourceType, sourceLocator) => {
    await expect(createDeploymentSource({
      sourceType,
      name: "Unsafe source",
      sourceLocator,
      projectName: "unsafe-source"
    })).rejects.toThrow();

    expect(query).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

describe("deployment source environment backfill", () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockReset();
    enqueueJobInTransaction.mockReset();
  });

  it("encrypts legacy environment values, redacts secrets from API output, and is idempotent", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    const legacyEnvironment = "PUBLIC_SETTING=upgrade-preserved\nSECRET_TOKEN=upgrade-secret";
    query
      .mockResolvedValueOnce({
        rows: [{ id, env: legacyEnvironment }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(backfillDeploymentSourceEncryptedEnvironment()).resolves.toEqual({ updated: 1 });

    const updateCall = query.mock.calls[1] as [string, unknown[]];
    expect(updateCall[0]).toContain("WHERE id = $1 AND env_encrypted IS NULL");
    expect(updateCall[1][0]).toBe(id);
    const encryptedEnvironment = updateCall[1][1] as string;
    expect(encryptedEnvironment).not.toContain("upgrade-secret");
    expect(decryptSecret(encryptedEnvironment)).toBe(legacyEnvironment);

    const timestamp = "2026-07-30T00:00:00.000Z";
    const mapped = deploymentAnalysisInternals.mapSource({
      id,
      source_type: "git",
      name: "Upgraded source",
      source_locator: "https://git.example.test/team/app.git",
      branch: null,
      compose_path: null,
      working_dir: null,
      project_name: "upgraded-source",
      default_host_id: null,
      target_host_ids: [],
      env_encrypted: encryptedEnvironment,
      credential_secret_encrypted: null,
      metadata: {},
      last_deployed_at: null,
      created_at: timestamp,
      updated_at: timestamp
    });
    expect(mapped.safeEnvironment).toEqual({ PUBLIC_SETTING: "upgrade-preserved" });
    expect(mapped.safeEnvironment).not.toHaveProperty("SECRET_TOKEN");

    await expect(backfillDeploymentSourceEncryptedEnvironment()).resolves.toEqual({ updated: 0 });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
