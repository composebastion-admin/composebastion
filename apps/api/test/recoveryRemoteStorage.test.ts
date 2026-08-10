import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
  createS3Client: vi.fn(),
  deleteFromS3: vi.fn(),
  deleteFromRclone: vi.fn(),
  uploadToS3: vi.fn(),
  uploadToRclone: vi.fn(),
  destroy: vi.fn()
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  assertBackupTargetS3EndpointAllowed: (...args: unknown[]) => mocks.assertAllowed(...args)
}));

vi.mock("../src/services/recoveryS3.js", () => ({
  buildS3ObjectKey: (_prefix: string | null, namespaceId: string, storageKey: string) =>
    `${namespaceId}/${storageKey}`,
  createS3Client: (...args: unknown[]) => mocks.createS3Client(...args),
  deleteRecoveryArtifactFromS3: (...args: unknown[]) => mocks.deleteFromS3(...args),
  downloadRecoveryArtifactFromS3: vi.fn(),
  headRecoveryArtifactOnS3: vi.fn(),
  uploadRecoveryArtifactToS3: (...args: unknown[]) => mocks.uploadToS3(...args)
}));
vi.mock("../src/services/recoveryRclone.js", () => ({
  deleteRecoveryArtifactFromRclone: (...args: unknown[]) => mocks.deleteFromRclone(...args),
  downloadRecoveryArtifactFromRclone: vi.fn(),
  headRecoveryArtifactOnRclone: vi.fn(),
  uploadRecoveryArtifactToRclone: (...args: unknown[]) => mocks.uploadToRclone(...args)
}));

import { uploadRemoteArtifact } from "../src/services/recoveryRemoteStorage.js";

const target = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "Offsite S3",
  kind: "s3" as const,
  enabled: true,
  config: {
    endpoint: "http://metadata.internal",
    bucket: "recovery"
  },
  localCachePolicy: "keep" as const,
  s3: {
    config: {
      endpoint: "http://metadata.internal",
      bucket: "recovery"
    },
    credentials: {
      accessKeyId: "access",
      secretAccessKey: "secret"
    }
  }
};

const rcloneTarget = {
  id: "00000000-0000-4000-8000-000000000011",
  name: "SMB vault",
  kind: "rclone" as const,
  enabled: true,
  config: {},
  localCachePolicy: "remote_only" as const,
  rclone: {
    provider: "smb",
    remoteName: "vault",
    remotePath: "Backups/composebastion",
    configText: "[vault]\ntype = smb\n"
  }
};

describe("recovery remote S3 policy boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAllowed.mockResolvedValue(undefined);
    mocks.createS3Client.mockReturnValue({ destroy: mocks.destroy });
    mocks.deleteFromS3.mockResolvedValue(undefined);
    mocks.deleteFromRclone.mockResolvedValue(undefined);
    mocks.uploadToS3.mockResolvedValue({ sizeBytes: 123, etag: "etag" });
    mocks.uploadToRclone.mockResolvedValue({ sizeBytes: 123, checksum: null });
  });

  it("refuses a recovery capture upload before creating an S3 client when the endpoint is blocked", async () => {
    const policyError = new Error("S3 endpoint is private");
    mocks.assertAllowed.mockRejectedValueOnce(policyError);

    await expect(uploadRemoteArtifact({
      target,
      namespaceId: "00000000-0000-4000-8000-000000000020",
      storageKey: "volumes/data.tar.gz",
      localPath: "/tmp/data.tar.gz",
      checksum: "sha256:abc"
    })).rejects.toBe(policyError);

    expect(mocks.assertAllowed).toHaveBeenCalledOnce();
    expect(mocks.assertAllowed).toHaveBeenCalledWith(target);
    expect(mocks.createS3Client).not.toHaveBeenCalled();
    expect(mocks.uploadToS3).not.toHaveBeenCalled();
  });

  it("destroys its one-shot S3 client after a successful recovery upload", async () => {
    await expect(uploadRemoteArtifact({
      target,
      namespaceId: "00000000-0000-4000-8000-000000000020",
      storageKey: "volumes/data.tar.gz",
      localPath: "/tmp/data.tar.gz"
    })).resolves.toMatchObject({
      remoteObjectKey: "00000000-0000-4000-8000-000000000020/volumes/data.tar.gz",
      remoteSizeBytes: 123
    });

    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("destroys its one-shot S3 client after a failed recovery upload", async () => {
    const uploadError = new Error("S3 upload failed");
    mocks.uploadToS3.mockRejectedValueOnce(uploadError);

    await expect(uploadRemoteArtifact({
      target,
      namespaceId: "00000000-0000-4000-8000-000000000020",
      storageKey: "volumes/data.tar.gz",
      localPath: "/tmp/data.tar.gz"
    })).rejects.toMatchObject({
      code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
      uploadError: "S3 upload failed",
      expectedRemoteObject: {
        key: "00000000-0000-4000-8000-000000000020/volumes/data.tar.gz",
        backend: "s3"
      },
      remoteObjectDeletedAfterAmbiguousUpload: true,
      orphanRemoteObject: null
    });

    expect(mocks.deleteFromS3).toHaveBeenCalledWith(
      expect.anything(),
      "recovery",
      "00000000-0000-4000-8000-000000000020/volumes/data.tar.gz"
    );
    expect(mocks.destroy).toHaveBeenCalledTimes(2);
  });

  it("reports the deterministic locator when ambiguous upload cleanup also fails", async () => {
    mocks.uploadToS3.mockRejectedValueOnce(new Error("socket timed out after PUT"));
    mocks.deleteFromS3.mockRejectedValueOnce(new Error("delete endpoint unavailable"));

    await expect(uploadRemoteArtifact({
      target,
      namespaceId: "00000000-0000-4000-8000-000000000020",
      storageKey: "volumes/data.tar.gz",
      localPath: "/tmp/data.tar.gz"
    })).rejects.toMatchObject({
      code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
      uploadError: "socket timed out after PUT",
      remoteObjectDeletedAfterAmbiguousUpload: false,
      orphanRemoteObject: {
        key: "00000000-0000-4000-8000-000000000020/volumes/data.tar.gz",
        backend: "s3",
        cleanupError: "delete endpoint unavailable"
      }
    });
  });

  it("deletes the deterministic rclone key when copy metadata fails after the backend may have committed", async () => {
    mocks.uploadToRclone.mockRejectedValueOnce(new Error("lsjson failed after copyto"));

    await expect(uploadRemoteArtifact({
      target: rcloneTarget,
      namespaceId: "00000000-0000-4000-8000-000000000020",
      storageKey: "manifest.json",
      localPath: "/tmp/manifest.json"
    })).rejects.toMatchObject({
      code: "REMOTE_ARTIFACT_UPLOAD_FAILED",
      uploadError: "lsjson failed after copyto",
      expectedRemoteObject: {
        key: "00000000-0000-4000-8000-000000000020/manifest.json",
        backend: "rclone"
      },
      remoteObjectDeletedAfterAmbiguousUpload: true
    });

    expect(mocks.deleteFromRclone).toHaveBeenCalledWith(
      rcloneTarget,
      "00000000-0000-4000-8000-000000000020/manifest.json"
    );
  });
});
