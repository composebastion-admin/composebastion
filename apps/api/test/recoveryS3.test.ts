import { describe, expect, it, vi } from "vitest";
import {
  buildS3ObjectKey,
  createS3Client,
  deleteRecoveryArtifactFromS3,
  headRecoveryArtifactOnS3,
  redactS3Credentials,
  resolveRecoveryPointStatus
} from "../src/services/recoveryS3.js";

describe("recovery S3 helpers", () => {
  it("builds normalized object keys with optional prefix", () => {
    expect(buildS3ObjectKey(null, "rp-1", "manifest.json")).toBe("rp-1/manifest.json");
    expect(buildS3ObjectKey("backups", "rp-1", "/volumes/data.tar.gz")).toBe("backups/rp-1/volumes/data.tar.gz");
    expect(buildS3ObjectKey("/offsite/", "rp-2", "compose.yml")).toBe("offsite/rp-2/compose.yml");
  });

  it("marks recovery points partial when local capture succeeded but remote upload failed", () => {
    expect(resolveRecoveryPointStatus({ localCompleted: 3, localFailed: 0, remoteUploadFailures: 1 })).toEqual({
      status: "partial",
      error: "Some remote uploads failed"
    });
    expect(resolveRecoveryPointStatus({ localCompleted: 2, localFailed: 1, remoteUploadFailures: 0 })).toEqual({
      status: "partial",
      error: "Some recovery artifacts failed"
    });
    expect(resolveRecoveryPointStatus({ localCompleted: 0, localFailed: 2, remoteUploadFailures: 1 })).toEqual({
      status: "failed",
      error: "All recovery artifacts failed"
    });
    expect(resolveRecoveryPointStatus({ localCompleted: 4, localFailed: 0, remoteUploadFailures: 0 })).toEqual({
      status: "completed",
      error: null
    });
  });

  it("redacts S3 credentials from export payloads", () => {
    expect(redactS3Credentials({
      name: "Offsite",
      accessKeyId: "key",
      secretAccessKey: "super-secret"
    })).toEqual({
      name: "Offsite",
      accessKeyId: "key",
      secretAccessKey: "[redacted]"
    });

    expect(redactS3Credentials({
      secrets: { accessKeyId: "key", secretAccessKey: "super-secret" }
    })).toEqual({
      secrets: { accessKeyId: "key", secretAccessKey: "[redacted]" }
    });
  });

  it("deletes exact S3 object keys", async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };

    await deleteRecoveryArtifactFromS3(client as never, "recovery", "stored/exact/object.tar.gz");

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].input).toEqual({
      Bucket: "recovery",
      Key: "stored/exact/object.tar.gz"
    });
  });

  it("enforces the private-network policy again in the live S3 socket lookup", async () => {
    const resolve = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }]);
    const client = createS3Client(
      {
        endpoint: "http://s3-rebind.example.test:4567",
        bucket: "recovery",
        forcePathStyle: true
      },
      { accessKeyId: "test-access", secretAccessKey: "test-secret" },
      { blockPrivateEndpoints: true, resolve }
    );

    await expect(headRecoveryArtifactOnS3(client, "recovery", "point/artifact"))
      .rejects.toThrow("S3 endpoint resolved to a private network address");
    expect(resolve).toHaveBeenCalled();
    client.destroy();
  });
});
