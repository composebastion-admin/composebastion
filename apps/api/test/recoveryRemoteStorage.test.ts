import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
  createS3Client: vi.fn(),
  uploadToS3: vi.fn(),
  destroy: vi.fn()
}));

vi.mock("../src/services/recoveryBackupTargets.js", () => ({
  assertBackupTargetS3EndpointAllowed: (...args: unknown[]) => mocks.assertAllowed(...args)
}));

vi.mock("../src/services/recoveryS3.js", () => ({
  buildS3ObjectKey: (_prefix: string | null, namespaceId: string, storageKey: string) =>
    `${namespaceId}/${storageKey}`,
  createS3Client: (...args: unknown[]) => mocks.createS3Client(...args),
  deleteRecoveryArtifactFromS3: vi.fn(),
  downloadRecoveryArtifactFromS3: vi.fn(),
  headRecoveryArtifactOnS3: vi.fn(),
  uploadRecoveryArtifactToS3: (...args: unknown[]) => mocks.uploadToS3(...args)
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

describe("recovery remote S3 policy boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAllowed.mockResolvedValue(undefined);
    mocks.createS3Client.mockReturnValue({ destroy: mocks.destroy });
    mocks.uploadToS3.mockResolvedValue({ sizeBytes: 123, etag: "etag" });
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
    })).rejects.toBe(uploadError);

    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
