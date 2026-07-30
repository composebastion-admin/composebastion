import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  testBackupTarget,
  updateBackupTarget
} from "../src/services/recoveryCenter.js";
import { normalizeBackupTargetUpdate } from "../src/services/recoveryBackupTargets.js";

const targetId = "00000000-0000-4000-8000-000000000301";
const hostId = "00000000-0000-4000-8000-000000000302";
const probePayload = Buffer.from("ComposeBastion backup target health probe\n", "utf8");
const fixedDate = new Date("2026-07-30T12:00:00.000Z");
let localProbeRoot = "";

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
  references = referenceRow()
) {
  mocks.transactionQuery.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM backup_targets") && sql.includes("FOR UPDATE")) return { rows: [row] };
    if (sql.includes("SELECT count(*) FROM backups")) return { rows: [references] };
    if (sql.includes("UPDATE backup_targets")) {
      return {
        rows: [{
          ...row,
          name: values?.[1] ?? row.name,
          config: values?.[3] ?? row.config,
          access_key_id: values?.[4] ?? row.access_key_id,
          secret_access_key_encrypted: values?.[5] ?? row.secret_access_key_encrypted,
          provider: values?.[6] ?? row.provider,
          remote_path: values?.[7] ?? row.remote_path,
          generic_config_encrypted: values?.[9] ?? row.generic_config_encrypted,
          generic_credentials_encrypted: values?.[10] ?? row.generic_credentials_encrypted
        }]
      };
    }
    if (sql.includes("DELETE FROM backup_targets")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localProbeRoot = path.join(
    tmpdir(),
    `composebastion-lifecycle-${process.pid}-${Math.random().toString(16).slice(2)}`
  );
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
  await rm(localProbeRoot, { recursive: true, force: true });
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
        smb: { server: "nas.example.test", share: "Backups" }
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
          username: "backup",
          password: "nested-secret"
        }
      }
    });
    expect(smbPatch.config).toMatchObject({
      provider: "smb",
      remotePath: "Backups/client",
      smb: { server: "nas.example.test", share: "Backups" }
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
          username: "backup"
        }
      }
    });
    expect(JSON.stringify(normalizedSmb.config)).not.toContain("nested-secret");
    expect(JSON.stringify(normalizedSmb.config)).not.toContain("rcloneConfig");
    expect(decryptSecret(normalizedSmb.genericConfigEncrypted as string))
      .toBe("[composebastion]\ntype = smb\n");
    expect(JSON.parse(decryptSecret(normalizedSmb.genericCredentialsEncrypted as string)))
      .toEqual({ password: "nested-secret" });

    expect(backupTargetUpdateSchema.safeParse({ basePath: "/custom" }).success).toBe(false);
    expect(backupTargetUpdateSchema.safeParse({ config: { basePath: "/custom" } }).success).toBe(false);
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
