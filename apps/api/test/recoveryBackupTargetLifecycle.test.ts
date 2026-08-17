import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupTargetUpdateSchema } from "@composebastion/shared";
import { decryptSecret, encryptSecret } from "../src/services/crypto.js";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  buildRemoteObjectKey: vi.fn(),
  uploadRemoteArtifact: vi.fn(),
  headRemoteArtifact: vi.fn(),
  downloadRemoteArtifactAtomically: vi.fn(),
  deleteRemoteArtifact: vi.fn(),
  recoveryPointsRootDir: vi.fn(),
  resolveAppContext: vi.fn(),
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.poolQuery(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/recoveryRemoteStorage.js")>(),
  buildRemoteObjectKey: (...args: unknown[]) => mocks.buildRemoteObjectKey(...args),
  uploadRemoteArtifact: (...args: unknown[]) => mocks.uploadRemoteArtifact(...args),
  headRemoteArtifact: (...args: unknown[]) => mocks.headRemoteArtifact(...args),
  downloadRemoteArtifactAtomically: (...args: unknown[]) => mocks.downloadRemoteArtifactAtomically(...args),
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args)
}));

vi.mock("../src/services/recoveryStorage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/recoveryStorage.js")>(),
  recoveryPointsRootDir: () => mocks.recoveryPointsRootDir()
}));

vi.mock("../src/services/recoveryAppContext.js", () => ({
  resolveAppContext: (...args: unknown[]) => mocks.resolveAppContext(...args)
}));

vi.mock("../src/services/jobs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/jobs.js")>(),
  enqueueJobInTransaction: (...args: unknown[]) => mocks.enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => mocks.notifyJobQueued(...args)
}));

import {
  createRecoveryPointWithJob,
  createRecoverySchedule,
  deleteBackupTarget,
  getRecoveryPoint,
  testBackupTarget,
  updateBackupTarget
} from "../src/services/recoveryCenter.js";
import { normalizeBackupTargetUpdate } from "../src/services/recoveryBackupTargets.js";

const targetId = "00000000-0000-4000-8000-000000000301";
const hostId = "00000000-0000-4000-8000-000000000302";
const probePayload = Buffer.from("ComposeBastion backup target health probe\n", "utf8");
const fixedDate = new Date("2026-07-30T12:00:00.000Z");
let localProbeRoot = "";
let localProbeParent = "";

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: targetId,
    name: "Qualification storage",
    kind: "s3",
    enabled: true,
    config: {
      endpoint: "https://s3.example.test",
      bucket: "recovery",
      region: "eu-west-1",
      prefix: "client",
      forcePathStyle: true
    },
    access_key_id: "ACCESS-KEY",
    secret_access_key_encrypted: encryptSecret("secret-key"),
    provider: null,
    remote_path: null,
    local_cache_policy: "remote_only",
    generic_config_encrypted: null,
    generic_credentials_encrypted: null,
    health_status: "unknown",
    health_checked_at: null,
    health_error: null,
    row_version: "42",
    created_at: fixedDate,
    updated_at: fixedDate,
    ...overrides
  };
}

function referenceRow(overrides: Partial<Record<string, number | string>> = {}) {
  return {
    backups: 0,
    backup_schedules: 0,
    recovery_points: 0,
    recovery_artifacts: 0,
    recovery_schedules: 0,
    ...overrides
  };
}

function mockTargetProbe(row: ReturnType<typeof targetRow>, stale = false) {
  mocks.poolQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("INSERT INTO remote_artifact_orphans")) {
      return {
        rows: [{ id: "00000000-0000-4000-8000-000000000399" }],
        rowCount: 1
      };
    }
    if (
      sql.includes("DELETE FROM remote_artifact_orphans")
      || sql.includes("UPDATE remote_artifact_orphans")
    ) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("xmin::text AS row_version")) return { rows: [row] };
    if (sql.includes("UPDATE backup_targets") && sql.includes("health_status")) {
      if (stale) return { rows: [] };
      return {
        rows: [{
          ...row,
          health_status: values?.[2],
          health_checked_at: values?.[1],
          health_error: values?.[3],
          updated_at: new Date("2026-07-30T12:01:00.000Z")
        }]
      };
    }
    return { rows: [] };
  });
}

function mockLockedLifecycle(
  row: ReturnType<typeof targetRow>,
  references = referenceRow(),
  orphanCount = 0
) {
  mocks.transactionQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM backup_targets") && sql.includes("FOR UPDATE")) return { rows: [row] };
    if (sql.includes("FROM remote_artifact_orphans")) {
      return { rows: [{ count: String(orphanCount) }] };
    }
    if (sql.includes("SELECT count(*) FROM backups")) return { rows: [references] };
    if (sql.includes("UPDATE backup_targets")) {
      return {
        rows: [{
          ...row,
          name: values?.[1] ?? row.name,
          enabled: values?.[2] ?? row.enabled,
          config: values?.[3] ?? row.config,
          access_key_id: values?.[4] as string | null,
          secret_access_key_encrypted: values?.[5] as string | null,
          provider: values?.[6] ?? row.provider,
          remote_path: values?.[7] ?? row.remote_path,
          generic_config_encrypted: values?.[9] as string | null,
          generic_credentials_encrypted: values?.[10] as string | null
        }]
      };
    }
    if (sql.includes("DELETE FROM backup_targets")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  localProbeParent = await mkdtemp(path.join(tmpdir(), "composebastion-lifecycle-"));
  localProbeRoot = path.join(localProbeParent, "recovery-points");
  mocks.recoveryPointsRootDir.mockReturnValue(localProbeRoot);
  mocks.withTransaction.mockImplementation(async (
    handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
  ) => handler({ query: mocks.transactionQuery }));
  mocks.buildRemoteObjectKey.mockImplementation((
    _target: unknown,
    namespaceId: string,
    storageKey: string
  ) => `${namespaceId}/${storageKey}`);
  mocks.uploadRemoteArtifact.mockImplementation(async (input: {
    target: { kind: "s3" | "rclone" };
    namespaceId: string;
    storageKey: string;
    localPath: string;
  }) => ({
    remoteObjectKey: `${input.namespaceId}/${input.storageKey}`,
    remoteBackend: input.target.kind,
    remoteSizeBytes: (await readFile(input.localPath)).byteLength,
    remoteEtag: null
  }));
  mocks.headRemoteArtifact.mockResolvedValue({
    sizeBytes: probePayload.byteLength,
    checksum: null,
    etag: null
  });
  mocks.downloadRemoteArtifactAtomically.mockImplementation(async (
    _target: unknown,
    _objectKey: string,
    localPath: string
  ) => {
    await writeFile(localPath, probePayload);
    return { sizeBytes: probePayload.byteLength };
  });
  mocks.deleteRemoteArtifact.mockResolvedValue(undefined);
  mocks.resolveAppContext.mockResolvedValue({
    label: "Client app",
    projectName: null,
    stackId: null,
    composeYaml: null,
    env: "",
    workingDir: null,
    composePath: null,
    containerIds: ["client-app"],
    volumeNames: []
  });
  mocks.enqueueJobInTransaction.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000303"
  });
  mocks.notifyJobQueued.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(localProbeParent, { recursive: true, force: true });
});

describe("backup target readiness probes", () => {
  it("round-trips unique bytes through S3 and rclone remote_only targets and cleans both copies", async () => {
    for (const kind of ["s3", "rclone"] as const) {
      const row = kind === "s3"
        ? targetRow()
        : targetRow({
          kind: "rclone",
          config: {
            provider: "smb",
            remoteName: "composebastion",
            remotePath: "Backups/client",
            smb: { server: "nas.example.test", share: "Backups" }
          },
          access_key_id: null,
          secret_access_key_encrypted: null,
          provider: "smb",
          remote_path: "Backups/client"
        });
      mockTargetProbe(row);
      let uploadedLocalPath = "";
      let downloadedLocalPath = "";
      mocks.uploadRemoteArtifact.mockImplementationOnce(async (input: {
        target: { kind: "s3" | "rclone"; localCachePolicy: string };
        namespaceId: string;
        storageKey: string;
        localPath: string;
      }) => {
        uploadedLocalPath = input.localPath;
        expect(input.target.localCachePolicy).toBe("remote_only");
        expect(await readFile(input.localPath)).toEqual(probePayload);
        return {
          remoteObjectKey: `${input.namespaceId}/${input.storageKey}`,
          remoteBackend: input.target.kind,
          remoteSizeBytes: probePayload.byteLength,
          remoteEtag: null
        };
      });
      mocks.downloadRemoteArtifactAtomically.mockImplementationOnce(async (
        _target: unknown,
        _objectKey: string,
        localPath: string
      ) => {
        downloadedLocalPath = localPath;
        await writeFile(localPath, probePayload);
      });

      await expect(testBackupTarget(targetId)).resolves.toMatchObject({ ok: true });

      expect(mocks.headRemoteArtifact).toHaveBeenCalledOnce();
      expect(mocks.downloadRemoteArtifactAtomically).toHaveBeenCalledOnce();
      expect(mocks.deleteRemoteArtifact).toHaveBeenCalledOnce();
      const intentInsertIndex = mocks.poolQuery.mock.calls.findIndex(([sql]) =>
        String(sql).includes("INSERT INTO remote_artifact_orphans")
      );
      const intentClearIndex = mocks.poolQuery.mock.calls.findIndex(([sql]) =>
        String(sql).includes("DELETE FROM remote_artifact_orphans")
      );
      expect(mocks.poolQuery.mock.invocationCallOrder[intentInsertIndex])
        .toBeLessThan(mocks.uploadRemoteArtifact.mock.invocationCallOrder[0]!);
      expect(mocks.deleteRemoteArtifact.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.poolQuery.mock.invocationCallOrder[intentClearIndex]!);
      await expect(access(uploadedLocalPath)).rejects.toThrow();
      await expect(access(downloadedLocalPath)).rejects.toThrow();
      vi.clearAllMocks();
    }
  });

  it("marks a target failed when downloaded probe bytes differ and still deletes the object", async () => {
    const row = targetRow();
    mockTargetProbe(row);
    let uploadedLocalPath = "";
    mocks.uploadRemoteArtifact.mockImplementationOnce(async (input: {
      namespaceId: string;
      storageKey: string;
      localPath: string;
    }) => {
      uploadedLocalPath = input.localPath;
      return {
        remoteObjectKey: `${input.namespaceId}/${input.storageKey}`,
        remoteBackend: "s3",
        remoteSizeBytes: probePayload.byteLength,
        remoteEtag: null
      };
    });
    mocks.downloadRemoteArtifactAtomically.mockImplementationOnce(async (
      _target: unknown,
      _objectKey: string,
      localPath: string
    ) => {
      await writeFile(localPath, "wrong probe");
    });

    await expect(testBackupTarget(targetId)).resolves.toMatchObject({
      ok: false,
      error: "Remote backup target probe download did not match the uploaded content"
    });
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledOnce();
    await expect(access(uploadedLocalPath)).rejects.toThrow();
  });

  it("cleans the adapter-returned probe key when it differs from the expected key", async () => {
    const row = targetRow();
    mockTargetProbe(row);
    const returnedKey = `unexpected/${targetId}/probe`;
    mocks.uploadRemoteArtifact.mockResolvedValueOnce({
      remoteObjectKey: returnedKey,
      remoteBackend: "s3",
      remoteSizeBytes: probePayload.byteLength,
      remoteEtag: null
    });

    await expect(testBackupTarget(targetId)).resolves.toMatchObject({
      ok: false,
      error: "Remote backup target did not return the expected probe object"
    });

    expect(mocks.deleteRemoteArtifact.mock.calls.map(([, key]) => key)).toEqual([
      returnedKey,
      expect.stringMatching(new RegExp(`^target-tests/${targetId}/.+\\.probe$`))
    ]);
  });

  it("persists both the primary probe failure and a remote cleanup failure", async () => {
    const row = targetRow();
    mockTargetProbe(row);
    mocks.downloadRemoteArtifactAtomically.mockImplementationOnce(async (
      _target: unknown,
      _objectKey: string,
      localPath: string
    ) => {
      await writeFile(localPath, "wrong probe");
    });
    mocks.deleteRemoteArtifact.mockRejectedValueOnce(new Error("cleanup-denied"));

    const result = await testBackupTarget(targetId);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("probe download did not match");
    expect(result.error).toContain("cleanup failed");
    expect(result.error).toContain("cleanup-denied");
    const healthWrite = mocks.poolQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    );
    expect(healthWrite?.[1]?.[3]).toContain("probe download did not match");
    expect(healthWrite?.[1]?.[3]).toContain("cleanup-denied");
  });

  it("sanitizes target-test diagnostics before persistence and response", async () => {
    const row = targetRow();
    const secret = "target-health-secret";
    mocks.uploadRemoteArtifact.mockRejectedValueOnce(
      new Error(`request failed https://worker:${secret}@s3.example.test/recovery?token=${secret}#detail`)
    );
    mockTargetProbe(row);

    const result = await testBackupTarget(targetId);

    expect(result).toMatchObject({
      ok: false,
      error: "request failed https://s3.example.test/recovery",
      target: {
        healthError: "request failed https://s3.example.test/recovery"
      }
    });
    const healthWrite = mocks.poolQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    );
    expect(healthWrite?.[1]?.[3]).toBe("request failed https://s3.example.test/recovery");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("tests the confined global recovery directory for local aliases and removes the probe", async () => {
    const row = targetRow({
      kind: "local",
      config: { basePath: "/legacy/ignored" },
      access_key_id: null,
      secret_access_key_encrypted: null,
      local_cache_policy: "keep"
    });
    mockTargetProbe(row);

    await expect(testBackupTarget(targetId)).resolves.toMatchObject({ ok: true });

    expect(await readdir(localProbeRoot)).toEqual([]);
    expect(mocks.uploadRemoteArtifact).not.toHaveBeenCalled();
  });

  it("reports a local filesystem probe failure without leaving probe state", async () => {
    await mkdir(path.dirname(localProbeRoot), { recursive: true });
    await writeFile(localProbeRoot, "not a directory");
    const row = targetRow({
      kind: "local",
      config: {},
      access_key_id: null,
      secret_access_key_encrypted: null,
      local_cache_policy: "keep"
    });
    mockTargetProbe(row);

    await expect(testBackupTarget(targetId)).resolves.toMatchObject({ ok: false });

    expect(mocks.uploadRemoteArtifact).not.toHaveBeenCalled();
  });

  it("persists an unchanged probe by xmin and rejects a concurrent update or delete", async () => {
    const row = targetRow({ row_version: "987654" });
    mockTargetProbe(row);

    await expect(testBackupTarget(targetId)).resolves.toMatchObject({ ok: true });
    const successfulUpdate = mocks.poolQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    );
    expect(successfulUpdate?.[0]).toContain("xmin::text = $5");
    expect(successfulUpdate?.[1]?.[4]).toBe("987654");

    vi.clearAllMocks();
    mocks.recoveryPointsRootDir.mockReturnValue(localProbeRoot);
    mocks.buildRemoteObjectKey.mockImplementation((
      _target: unknown,
      namespaceId: string,
      storageKey: string
    ) => `${namespaceId}/${storageKey}`);
    mocks.uploadRemoteArtifact.mockResolvedValue({
      remoteObjectKey: expect.anything(),
      remoteBackend: "s3",
      remoteSizeBytes: probePayload.byteLength,
      remoteEtag: null
    });
    mocks.uploadRemoteArtifact.mockImplementationOnce(async (input: {
      namespaceId: string;
      storageKey: string;
    }) => ({
      remoteObjectKey: `${input.namespaceId}/${input.storageKey}`,
      remoteBackend: "s3",
      remoteSizeBytes: probePayload.byteLength,
      remoteEtag: null
    }));
    mocks.headRemoteArtifact.mockResolvedValue({ sizeBytes: probePayload.byteLength, checksum: null });
    mocks.downloadRemoteArtifactAtomically.mockImplementation(async (
      _target: unknown,
      _key: string,
      localPath: string
    ) => writeFile(localPath, probePayload));
    mocks.deleteRemoteArtifact.mockResolvedValue(undefined);
    mockTargetProbe(row, true);

    await expect(testBackupTarget(targetId)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("stale health result was discarded")
    });
    expect(mocks.poolQuery.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    )).toHaveLength(1);
  });
});

describe("backup target lifecycle references and identity", () => {
  it("reports all reference counts and refuses a referenced delete under lock", async () => {
    const references = referenceRow({
      backups: "1",
      backup_schedules: "2",
      recovery_points: "3",
      recovery_artifacts: "4",
      recovery_schedules: "5"
    });
    mockLockedLifecycle(targetRow(), references);

    await expect(deleteBackupTarget(targetId)).rejects.toMatchObject({
      statusCode: 409,
      referenceCounts: {
        backups: 1,
        backupSchedules: 2,
        recoveryPoints: 3,
        recoveryArtifacts: 4,
        recoverySchedules: 5
      }
    });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("DELETE FROM backup_targets")
    )).toBe(false);
    expect(mocks.transactionQuery.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
    expect(mocks.transactionQuery.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  });

  it("deletes an unreferenced target inside the locked transaction", async () => {
    mockLockedLifecycle(targetRow());

    await expect(deleteBackupTarget(targetId)).resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("DELETE FROM backup_targets")
    )).toBe(true);
  });

  it("refuses cleanup-binding edits and deletion while a durable remote orphan remains", async () => {
    mockLockedLifecycle(targetRow(), referenceRow(), 1);

    await expect(updateBackupTarget(targetId, {
      accessKeyId: "ROTATED-KEY",
      secretAccessKey: "rotated-secret"
    })).rejects.toMatchObject({
      statusCode: 409,
      remoteArtifactOrphanCount: 1,
      message: expect.stringContaining("cleanup obligation")
    });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    )).toBe(false);
    expect(mocks.transactionQuery.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
    expect(mocks.transactionQuery.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("FROM remote_artifact_orphans")
    )).toBe(true);

    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (
      handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => handler({ query: mocks.transactionQuery }));
    mockLockedLifecycle(targetRow(), referenceRow(), 2);

    await expect(deleteBackupTarget(targetId)).rejects.toMatchObject({
      statusCode: 409,
      remoteArtifactOrphanCount: 2,
      message: expect.stringContaining("cannot be deleted")
    });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("DELETE FROM backup_targets")
    )).toBe(false);
  });

  it("allows name, enabled-state, and cache-policy edits while a remote orphan remains", async () => {
    mockLockedLifecycle(targetRow(), referenceRow(), 1);

    await expect(updateBackupTarget(targetId, {
      name: "Renamed while cleanup waits",
      enabled: false,
      localCachePolicy: "keep"
    })).resolves.toMatchObject({
      id: targetId,
      name: "Renamed while cleanup waits",
      enabled: false
    });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("FROM remote_artifact_orphans")
    )).toBe(false);
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    )).toBe(true);
  });

  it("blocks referenced S3 and SMB storage changes but allows credential rotation", async () => {
    for (const storageChange of [
      { endpoint: "https://replacement.example.test" },
      { bucket: "replacement-bucket" },
      { prefix: "replacement-prefix" }
    ]) {
      mockLockedLifecycle(targetRow(), referenceRow({ recovery_artifacts: 1 }));
      await expect(updateBackupTarget(targetId, storageChange))
        .rejects.toMatchObject({ statusCode: 409 });
      vi.clearAllMocks();
      mocks.withTransaction.mockImplementation(async (
        handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
      ) => handler({ query: mocks.transactionQuery }));
    }

    mockLockedLifecycle(targetRow(), referenceRow({ recovery_artifacts: 1 }));
    await expect(updateBackupTarget(targetId, {
      region: "us-east-2",
      forcePathStyle: false
    })).resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);

    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (
      handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => handler({ query: mocks.transactionQuery }));
    const s3 = targetRow();
    mockLockedLifecycle(s3, referenceRow({ recovery_artifacts: 1 }));
    await expect(updateBackupTarget(targetId, {
      accessKeyId: "ROTATED-KEY",
      secretAccessKey: "rotated-secret"
    })).resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);
    const s3Update = mocks.transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    );
    expect(s3Update?.[0]).toContain("health_checked_at = CASE");
    expect(s3Update?.[0]).toContain("health_error = CASE");
    expect(s3Update?.[1]?.[4]).toBe("ROTATED-KEY");
    expect(s3Update?.[1]?.[5]).not.toBe("rotated-secret");

    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (
      handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => handler({ query: mocks.transactionQuery }));
    const smb = targetRow({
      kind: "rclone",
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "Backups/client",
        smb: {
          server: "nas.example.test",
          share: "Backups",
          subPath: "client",
          username: "old-user",
          domain: "OLD"
        }
      },
      access_key_id: null,
      secret_access_key_encrypted: null,
      provider: "smb",
      remote_path: "Backups/client"
    });
    mockLockedLifecycle(smb, referenceRow({ recovery_points: 1 }));
    await expect(updateBackupTarget(targetId, {
      username: "new-user",
      domain: "NEW",
      password: "new-password"
    })).resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);

    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (
      handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => handler({ query: mocks.transactionQuery }));
    mockLockedLifecycle(smb, referenceRow({ recovery_points: 1 }));
    await expect(updateBackupTarget(targetId, {
      server: "other-nas.example.test"
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows harmless updates to referenced legacy local aliases", async () => {
    const local = targetRow({
      kind: "local",
      config: { basePath: "/legacy/custom/path" },
      access_key_id: null,
      secret_access_key_encrypted: null,
      local_cache_policy: "remote_only"
    });
    mockLockedLifecycle(local, referenceRow({ recovery_points: 1 }));

    await expect(updateBackupTarget(targetId, { name: "Renamed local alias" }))
      .resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);
  });

  it("clears both S3 credential halves only when the target is disabled", async () => {
    const s3 = targetRow();
    mockLockedLifecycle(s3);

    await expect(updateBackupTarget(targetId, {
      enabled: false,
      accessKeyId: null,
      secretAccessKey: null
    })).resolves.toMatchObject({
      enabled: false,
      accessKeyId: null,
      hasCredentials: false,
      hasSecretAccessKey: false
    });

    const update = mocks.transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    );
    expect(update?.[0]).toContain("access_key_id = $5");
    expect(update?.[0]).toContain("$5 IS DISTINCT FROM access_key_id");
    expect(update?.[1]?.[4]).toBeNull();
    expect(update?.[1]?.[5]).toBeNull();

    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (
      handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => handler({ query: mocks.transactionQuery }));
    mockLockedLifecycle(s3);
    await expect(updateBackupTarget(targetId, {
      accessKeyId: null,
      secretAccessKey: null
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    )).toBe(false);
  });

  it("retains S3 credentials when credential fields are omitted", async () => {
    const s3 = targetRow();
    mockLockedLifecycle(s3);

    await expect(updateBackupTarget(targetId, { name: "Renamed S3" })).resolves.toMatchObject({
      accessKeyId: "ACCESS-KEY",
      hasCredentials: true,
      hasSecretAccessKey: true
    });
    const update = mocks.transactionQuery.mock.calls.find(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    );
    expect(update?.[1]?.[4]).toBe("ACCESS-KEY");
    expect(update?.[1]?.[5]).toBe(s3.secret_access_key_encrypted);
  });

  it("treats canonical S3 endpoints, prefixes, and rclone paths as the same storage identity", async () => {
    const s3 = targetRow({
      config: {
        endpoint: "https://S3.Example.Test:443/",
        bucket: "recovery",
        prefix: "/client/"
      }
    });
    mockLockedLifecycle(s3, referenceRow({ recovery_artifacts: 1 }));

    await expect(updateBackupTarget(targetId, {
      endpoint: "https://s3.example.test",
      prefix: "client"
    })).resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);

    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (
      handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
    ) => handler({ query: mocks.transactionQuery }));
    const rclone = targetRow({
      kind: "rclone",
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "/Backups/client/",
        smb: { server: "nas.example.test", share: "Backups", subPath: "client" }
      },
      access_key_id: null,
      secret_access_key_encrypted: null,
      provider: "smb",
      remote_path: "/Backups/client/"
    });
    mockLockedLifecycle(rclone, referenceRow({ recovery_points: 1 }));

    await expect(updateBackupTarget(targetId, {
      remotePath: "Backups/client"
    })).resolves.toMatchObject({ id: targetId });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("SELECT count(*) FROM backups")
    )).toBe(false);
  });
});

describe("backup target PATCH and recovery creation contracts", () => {
  it("preserves nested S3 and SMB updates, promotes routing fields, and encrypts secrets", () => {
    const s3Patch = backupTargetUpdateSchema.parse({
      config: {
        endpoint: "https://s3.example.test",
        bucket: "recovery",
        region: "eu-west-1",
        prefix: "client",
        forcePathStyle: true
      }
    });
    expect(s3Patch.config).toMatchObject({
      endpoint: "https://s3.example.test",
      bucket: "recovery",
      prefix: "client"
    });
    expect(normalizeBackupTargetUpdate(targetRow(), s3Patch).config).toMatchObject({
      endpoint: "https://s3.example.test",
      bucket: "recovery",
      prefix: "client"
    });

    const smbPatch = backupTargetUpdateSchema.parse({
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "Backups/client",
        rcloneConfig: "[composebastion]\ntype = smb\n",
        smb: {
          server: "nas.example.test",
          share: "Backups",
          subPath: "client",
          username: "backup",
          password: "nested-secret"
        }
      }
    });
    expect(smbPatch.config).toMatchObject({
      provider: "smb",
      remotePath: "Backups/client",
      smb: { server: "nas.example.test", share: "Backups", subPath: "client" }
    });
    const normalizedSmb = normalizeBackupTargetUpdate(targetRow({
      kind: "rclone",
      config: {
        provider: "smb",
        remoteName: "old",
        remotePath: "old",
        smb: { server: "old-nas.example.test", share: "Old" }
      },
      access_key_id: null,
      secret_access_key_encrypted: null,
      provider: "smb",
      remote_path: "old"
    }), smbPatch);
    expect(normalizedSmb).toMatchObject({
      provider: "smb",
      remotePath: "Backups/client",
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "Backups/client",
        smb: {
          server: "nas.example.test",
          share: "Backups",
          subPath: "client",
          username: "backup"
        }
      }
    });
    expect(JSON.stringify(normalizedSmb.config)).not.toContain("nested-secret");
    expect(JSON.stringify(normalizedSmb.config)).not.toContain("rcloneConfig");
    expect(normalizedSmb.genericConfigEncrypted).toBeNull();
    expect(JSON.parse(decryptSecret(normalizedSmb.genericCredentialsEncrypted as string)))
      .toEqual({ password: "nested-secret" });

    expect(backupTargetUpdateSchema.safeParse({ basePath: "/custom" }).success).toBe(false);
    expect(backupTargetUpdateSchema.safeParse({ config: { basePath: "/custom" } }).success).toBe(false);
  });

  it("rejects a cross-provider secret patch before issuing an S3 update", async () => {
    const canary = "PLAINTEXT-CROSS-PROVIDER-CANARY";
    mockLockedLifecycle(targetRow());

    await expect(updateBackupTarget(targetId, {
      config: {
        provider: "custom",
        remotePath: "hidden",
        rcloneConfig: `[remote]\ntoken = ${canary}`
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      message: "config.provider is not valid for s3 backup targets"
    });

    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("UPDATE backup_targets")
    )).toBe(false);
    expect(JSON.stringify(mocks.transactionQuery.mock.calls)).not.toContain(canary);
  });

  it("rejects missing, disabled, and unsupported targets before recovery point insert or enqueue", async () => {
    for (const target of [
      null,
      { id: targetId, kind: "s3", enabled: false },
      { id: targetId, kind: "unsupported", enabled: true }
    ]) {
      vi.clearAllMocks();
      mocks.withTransaction.mockImplementation(async (
        handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
      ) => handler({ query: mocks.transactionQuery }));
      mocks.resolveAppContext.mockResolvedValue({
        label: "Client app",
        projectName: null,
        stackId: null,
        composeYaml: null,
        env: "",
        workingDir: null,
        composePath: null,
        containerIds: ["client-app"],
        volumeNames: []
      });
      mocks.transactionQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("FOR KEY SHARE")) return { rows: target ? [target] : [] };
        return { rows: [] };
      });

      await expect(createRecoveryPointWithJob({
        hostId,
        appIdentity: { kind: "standalone", containerIds: ["client-app"] },
        triggerKind: "manual",
        backupTargetId: targetId
      })).rejects.toMatchObject({ statusCode: 409 });
      expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
        typeof sql === "string" && sql.includes("INSERT INTO recovery_points")
      )).toBe(false);
      expect(mocks.enqueueJobInTransaction).not.toHaveBeenCalled();
      expect(mocks.notifyJobQueued).not.toHaveBeenCalled();
    }
  });

  it("rejects an unusable target before recovery schedule insertion", async () => {
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR KEY SHARE")) {
        return { rows: [{ id: targetId, kind: "s3", enabled: false }] };
      }
      return { rows: [] };
    });

    await expect(createRecoverySchedule({
      hostId,
      name: "Nightly",
      appIdentity: { kind: "standalone", containerIds: ["client-app"] },
      backupTargetId: targetId,
      intervalMs: 300_000
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.transactionQuery.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("INSERT INTO recovery_schedules")
    )).toBe(false);
  });
});

describe("recovery point detail durability evidence", () => {
  it("derives the same nonzero evidence counters returned by the list projection", async () => {
    const pointId = "00000000-0000-4000-8000-000000000399";
    const artifactBase = {
      recovery_point_id: pointId,
      backup_target_id: targetId,
      size_bytes: 1024,
      checksum: "sha256:abc",
      status: "completed",
      error: null,
      created_at: fixedDate,
      completed_at: fixedDate
    };
    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [{
          id: pointId,
          host_id: hostId,
          name: "Evidence point",
          app_identity: { kind: "standalone", containerIds: ["web"] },
          backup_target_id: targetId,
          profile_id: null,
          status: "partial",
          capture_mode: "hot",
          trigger_kind: "manual",
          verified: false,
          total_bytes: 2048,
          error: null,
          metadata: {},
          created_at: fixedDate,
          started_at: fixedDate,
          completed_at: fixedDate
        }]
      })
      .mockResolvedValueOnce({
        rows: [
          {
            ...artifactBase,
            id: "00000000-0000-4000-8000-000000000397",
            kind: "metadata",
            storage_key: "manifest.json",
            metadata: {
              remoteObjectKey: "points/evidence/manifest.json",
              remoteVerified: true,
              localCachePolicy: "remote_only",
              localCacheRemoved: true
            }
          },
          {
            ...artifactBase,
            id: "00000000-0000-4000-8000-000000000398",
            kind: "volume",
            storage_key: "volumes/data.tar.gz",
            status: "partial",
            metadata: {
              remoteVerificationError: "checksum mismatch",
              remoteVerified: false,
              localCachePolicy: "keep",
              localCacheRemoved: false
            }
          }
        ]
      });

    await expect(getRecoveryPoint(pointId)).resolves.toMatchObject({
      remoteArtifactCount: 1,
      remoteUploadFailureCount: 1,
      localRetainedArtifactCount: 1,
      localRemovedArtifactCount: 1,
      artifacts: [{ storageKey: "manifest.json" }, { storageKey: "volumes/data.tar.gz" }]
    });
  });
});
