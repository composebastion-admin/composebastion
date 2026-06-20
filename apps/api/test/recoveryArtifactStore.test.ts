import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadWorkerBackupTarget = vi.fn();
const createS3Client = vi.fn();
const downloadRecoveryArtifactFromS3 = vi.fn();

const recoveryPointId = "00000000-0000-4000-8000-000000000011";
const backupTargetId = "00000000-0000-4000-8000-000000000012";

function checksum(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function recoveryPoint() {
  return {
    id: recoveryPointId,
    hostId: "00000000-0000-4000-8000-000000000013",
    name: "Point",
    appIdentity: { kind: "standalone", containerIds: ["web"] },
    triggerKind: "manual",
    status: "completed",
    backupTargetId,
    legacyVolumeBackupId: null,
    artifactCount: 1,
    completedArtifactCount: 1,
    totalBytes: null,
    error: null,
    metadata: {},
    createdAt: "2026-06-15T12:00:00.000Z",
    startedAt: "2026-06-15T12:00:00.000Z",
    completedAt: "2026-06-15T12:00:00.000Z",
    artifacts: []
  } as const;
}

function artifact(content: string, metadata: Record<string, unknown> = { remoteObjectKey: "points/rp/manifest.json" }) {
  return {
    id: "00000000-0000-4000-8000-000000000014",
    recoveryPointId,
    kind: "metadata",
    backupTargetId,
    storageKey: "manifest.json",
    sizeBytes: Buffer.byteLength(content),
    checksum: checksum(content),
    status: "completed",
    error: null,
    metadata,
    createdAt: "2026-06-15T12:00:00.000Z",
    completedAt: "2026-06-15T12:00:00.000Z"
  } as const;
}

async function importStore(tmpDir: string) {
  vi.resetModules();
  vi.stubEnv("BACKUP_DIR", tmpDir);
  vi.doMock("../src/services/recoveryBackupTargets.js", () => ({
    loadWorkerBackupTarget: (...args: unknown[]) => loadWorkerBackupTarget(...args)
  }));
  vi.doMock("../src/services/recoveryS3.js", () => ({
    createS3Client: (...args: unknown[]) => createS3Client(...args),
    downloadRecoveryArtifactFromS3: (...args: unknown[]) => downloadRecoveryArtifactFromS3(...args)
  }));
  return import("../src/services/recoveryArtifactStore.js");
}

describe("recovery artifact store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "recovery-artifacts-"));
    loadWorkerBackupTarget.mockResolvedValue({
      kind: "s3",
      enabled: true,
      s3: {
        config: { bucket: "recovery", endpoint: "https://s3.example.com" },
        credentials: { accessKeyId: "key", secretAccessKey: "secret" }
      }
    });
    createS3Client.mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("../src/services/recoveryBackupTargets.js");
    vi.doUnmock("../src/services/recoveryS3.js");
  });

  it("downloads and verifies a missing local artifact from S3", async () => {
    const content = "{\"ok\":true}";
    downloadRecoveryArtifactFromS3.mockImplementation(async (_client: unknown, _bucket: string, _key: string, downloadPath: string) => {
      await mkdir(path.dirname(downloadPath), { recursive: true });
      await writeFile(downloadPath, content);
      return { objectKey: "points/rp/manifest.json", sizeBytes: Buffer.byteLength(content), etag: null, checksum: checksum(content) };
    });

    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    const localPath = await ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact(content));
    const downloadPath = downloadRecoveryArtifactFromS3.mock.calls[0][3] as string;

    expect(await readFile(localPath, "utf8")).toBe(content);
    expect(downloadPath).not.toBe(localPath);
    expect(path.dirname(downloadPath)).toBe(path.dirname(localPath));
    expect(path.basename(downloadPath)).toMatch(/^\.download-manifest\.json-.+\.tmp$/);
    expect(downloadRecoveryArtifactFromS3).toHaveBeenCalledWith(
      {},
      "recovery",
      "points/rp/manifest.json",
      downloadPath
    );
    await expect(stat(downloadPath)).rejects.toThrow();
  });

  it("uses a valid local artifact without downloading from S3", async () => {
    const content = "{\"local\":true}";
    const localPath = path.join(tmpDir, "recovery-points", recoveryPointId, "manifest.json");
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, content);

    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    await expect(ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact(content))).resolves.toBe(localPath);
    expect(downloadRecoveryArtifactFromS3).not.toHaveBeenCalled();
  });

  it("redownloads a corrupt local artifact from S3 before returning it", async () => {
    const content = "{\"remote\":true}";
    const localPath = path.join(tmpDir, "recovery-points", recoveryPointId, "manifest.json");
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, "corrupt");
    downloadRecoveryArtifactFromS3.mockImplementation(async (_client: unknown, _bucket: string, _key: string, downloadPath: string) => {
      await writeFile(downloadPath, content);
      return { objectKey: "points/rp/manifest.json", sizeBytes: Buffer.byteLength(content), etag: null, checksum: checksum(content) };
    });

    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    await expect(ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact(content))).resolves.toBe(localPath);

    const downloadPath = downloadRecoveryArtifactFromS3.mock.calls[0][3] as string;
    expect(await readFile(localPath, "utf8")).toBe(content);
    await expect(stat(downloadPath)).rejects.toThrow();
  });

  it("fails corrupt local artifacts without a remote copy before restore can use them", async () => {
    const localPath = path.join(tmpDir, "recovery-points", recoveryPointId, "manifest.json");
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, "corrupt");

    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    await expect(ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact("expected", {})))
      .rejects.toThrow("size mismatch");
    expect(downloadRecoveryArtifactFromS3).not.toHaveBeenCalled();
  });

  it("removes a downloaded artifact when checksum verification fails", async () => {
    downloadRecoveryArtifactFromS3.mockImplementation(async (_client: unknown, _bucket: string, _key: string, downloadPath: string) => {
      await mkdir(path.dirname(downloadPath), { recursive: true });
      await writeFile(downloadPath, "corrupt");
      return { objectKey: "points/rp/manifest.json", sizeBytes: 7, etag: null, checksum: checksum("corrupt") };
    });

    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    await expect(ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact("expected")))
      .rejects.toThrow("size mismatch");

    const localPath = path.join(tmpDir, "recovery-points", recoveryPointId, "manifest.json");
    const downloadPath = downloadRecoveryArtifactFromS3.mock.calls[0][3] as string;
    await expect(stat(localPath)).rejects.toThrow();
    await expect(stat(downloadPath)).rejects.toThrow();
  });

  it("cleans up a temp download when S3 download fails", async () => {
    downloadRecoveryArtifactFromS3.mockImplementation(async (_client: unknown, _bucket: string, _key: string, downloadPath: string) => {
      await mkdir(path.dirname(downloadPath), { recursive: true });
      await writeFile(downloadPath, "partial");
      throw new Error("download failed");
    });

    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    await expect(ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact("expected")))
      .rejects.toThrow("download failed");

    const localPath = path.join(tmpDir, "recovery-points", recoveryPointId, "manifest.json");
    const downloadPath = downloadRecoveryArtifactFromS3.mock.calls[0][3] as string;
    await expect(stat(localPath)).rejects.toThrow();
    await expect(stat(downloadPath)).rejects.toThrow();
  });

  it("fails cleanly when neither local nor remote artifact exists", async () => {
    const { ensureRecoveryArtifactLocalPath } = await importStore(tmpDir);
    await expect(ensureRecoveryArtifactLocalPath(recoveryPoint(), artifact("expected", {})))
      .rejects.toThrow("missing locally and has no remote copy");
    expect(downloadRecoveryArtifactFromS3).not.toHaveBeenCalled();
  });
});
