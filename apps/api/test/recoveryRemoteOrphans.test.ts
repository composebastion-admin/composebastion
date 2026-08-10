import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerBackupTarget } from "../src/services/recoveryBackupTargets.js";
import { decryptSecret } from "../src/services/crypto.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transactionQuery: vi.fn(),
  withTransaction: vi.fn(),
  deleteRemoteArtifact: vi.fn()
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => mocks.query(...args),
  withTransaction: (...args: unknown[]) => mocks.withTransaction(...args)
}));

vi.mock("../src/services/recoveryRemoteStorage.js", () => ({
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args)
}));

import {
  beginRemoteArtifactWriteIntent,
  reconcileRemoteArtifactOrphans,
  recordRemoteArtifactOrphan,
  remoteArtifactTargetBindingFingerprint
} from "../src/services/recoveryRemoteOrphans.js";

const targetId = "00000000-0000-4000-8000-000000000701";
const orphanId = "00000000-0000-4000-8000-000000000702";
const ownerId = "00000000-0000-4000-8000-000000000703";
const objectKey = `${ownerId}/attempts/attempt-old/backup.tar.gz`;

function s3Target(overrides: Partial<WorkerBackupTarget> = {}): WorkerBackupTarget {
  return {
    id: targetId,
    name: "Immutable cleanup target",
    kind: "s3",
    enabled: true,
    config: {
      endpoint: "https://old-storage.example.test",
      bucket: "recovery",
      region: "eu-west-1",
      prefix: "client",
      forcePathStyle: true
    },
    localCachePolicy: "remote_only",
    s3: {
      config: {
        endpoint: "https://old-storage.example.test",
        bucket: "recovery",
        region: "eu-west-1",
        prefix: "client",
        forcePathStyle: true
      },
      credentials: {
        accessKeyId: "old-access",
        secretAccessKey: "1234"
      }
    },
    ...overrides
  };
}

function insertedOrphan() {
  const call = mocks.query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO remote_artifact_orphans")
  );
  if (!call) throw new Error("Expected an orphan INSERT");
  const values = call[1] as unknown[];
  return {
    id: orphanId,
    owner_kind: values[1] as "backup" | "recovery_artifact" | "backup_target_probe",
    owner_id: values[2] as string,
    backup_target_id: values[3] as string,
    object_key: values[4] as string,
    backend: values[5] as "s3" | "rclone",
    attempt_token: values[6] as string,
    target_binding_fingerprint: values[7] as string,
    target_snapshot_encrypted: values[8] as string,
    cleanup_error: values[9] as string
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mocks.withTransaction.mockImplementation(async (
    handler: (client: { query: typeof mocks.transactionQuery }) => Promise<unknown>
  ) => handler({ query: mocks.transactionQuery }));
  mocks.deleteRemoteArtifact.mockResolvedValue(undefined);
});

describe("durable remote artifact orphan cleanup", () => {
  it("persists and owns the exact-key cleanup intent before a remote write can start", async () => {
    const target = s3Target();
    const intent = await beginRemoteArtifactWriteIntent({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target
    });

    const call = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO remote_artifact_orphans")
    );
    expect(call?.[0]).toContain("cleanup_claim_token");
    expect(call?.[0]).toContain("cleanup_claimed_at");
    expect(call?.[0]).toContain(
      "remote_artifact_orphans.attempt_token = EXCLUDED.attempt_token"
    );
    expect(call?.[1]?.[4]).toBe(objectKey);
    expect(call?.[1]?.[6]).toBe("attempt-old");
    expect(call?.[1]?.[9]).toContain("pending authoritative commit");
    expect(intent).toMatchObject({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      claimToken: expect.any(String)
    });
  });

  it("fails closed when an exact key is already bound to another attempt", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(beginRemoteArtifactWriteIntent({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target: s3Target()
    })).rejects.toThrow("conflicts with a different owner or attempt");
  });

  it("encrypts the exact target snapshot, uses an APP_SECRET HMAC, and sanitizes cleanup diagnostics", async () => {
    const target = s3Target();
    const diagnosticSecret = "url-query-secret";
    await recordRemoteArtifactOrphan({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target,
      cleanupError: new Error(
        `cleanup failed https://worker:${diagnosticSecret}@old-storage.example.test/private?token=${diagnosticSecret}#detail`
      )
    });

    const inserted = insertedOrphan();
    const plaintextSnapshot = decryptSecret(inserted.target_snapshot_encrypted);
    const snapshot = JSON.parse(plaintextSnapshot) as WorkerBackupTarget;

    expect(snapshot).toEqual(target);
    expect(inserted.target_snapshot_encrypted).toMatch(/^v1:/);
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain("1234");
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(diagnosticSecret);
    expect(inserted.cleanup_error).toBe(
      "cleanup failed https://old-storage.example.test/private"
    );
    expect(inserted.target_binding_fingerprint).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);

    const rawSnapshotDigest = createHash("sha256")
      .update(plaintextSnapshot)
      .digest("hex");
    expect(inserted.target_binding_fingerprint.split(":")[1]).not.toBe(rawSnapshotDigest);
    expect(remoteArtifactTargetBindingFingerprint(target)).toBe(
      inserted.target_binding_fingerprint
    );
  });

  it("reconciles the exact attempt key with the encrypted pre-edit target snapshot", async () => {
    const originalTarget = s3Target();
    await recordRemoteArtifactOrphan({
      ownerKind: "recovery_artifact",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target: originalTarget,
      cleanupError: new Error("initial cleanup failed")
    });
    const orphan = insertedOrphan();

    // This represents a target edit that committed after capture loaded the
    // original target but before its cleanup obligation was durably recorded.
    const editedCurrentTarget = s3Target({
      config: {
        endpoint: "https://new-storage.example.test",
        bucket: "different-bucket"
      },
      s3: {
        config: {
          endpoint: "https://new-storage.example.test",
          bucket: "different-bucket",
          region: "us-east-1",
          prefix: "new-client",
          forcePathStyle: false
        },
        credentials: {
          accessKeyId: "new-access",
          secretAccessKey: "new-password"
        }
      }
    });
    expect(editedCurrentTarget).not.toEqual(originalTarget);

    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, owner_kind")) return { rows: [orphan] };
      if (sql.includes("UPDATE remote_artifact_orphans")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 1,
      failed: 0
    });
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledTimes(1);
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledWith(originalTarget, objectKey);
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalledWith(editedCurrentTarget, objectKey);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM remote_artifact_orphans"),
      [orphanId, expect.any(String)]
    );
  });

  it("releases a failed claim for retry without persisting credential-bearing URLs", async () => {
    const target = s3Target();
    await recordRemoteArtifactOrphan({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target,
      cleanupError: new Error("first failure")
    });
    const orphan = insertedOrphan();
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, owner_kind")) return { rows: [orphan] };
      return { rows: [], rowCount: 1 };
    });
    const urlSecret = "retry-secret";
    mocks.deleteRemoteArtifact.mockRejectedValueOnce(
      new Error(
        `delete failed https://operator:${urlSecret}@old-storage.example.test/object?signature=${urlSecret}#debug`
      )
    );

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 0,
      failed: 1
    });
    const releaseCall = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET cleanup_error = $3")
        && String(sql).includes("cleanup_claim_token = NULL")
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall?.[1]?.[2]).toBe(
      "delete failed https://old-storage.example.test/object"
    );
    expect(JSON.stringify(releaseCall)).not.toContain(urlSecret);
  });

  it("defers a stale intent while its exact backup attempt is still active", async () => {
    await recordRemoteArtifactOrphan({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target: s3Target(),
      cleanupError: new Error("pending retry")
    });
    const orphan = insertedOrphan();
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, owner_kind")) return { rows: [orphan] };
      return { rows: [], rowCount: 1 };
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM backups")) {
        return {
          rows: [{
            status: "running",
            remote_object_key: null,
            metadata: {
              backupCaptureAttemptToken: "attempt-old"
            }
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 0,
      failed: 0
    });
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("SET cleanup_claimed_at = now()")
    )).toBe(true);
  });

  it("drops only the intent when its exact backup locator already committed", async () => {
    await recordRemoteArtifactOrphan({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target: s3Target(),
      cleanupError: new Error("commit outcome was initially unknown")
    });
    const orphan = insertedOrphan();
    mocks.transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id, owner_kind")) return { rows: [orphan] };
      return { rows: [], rowCount: 1 };
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM backups")) {
        return {
          rows: [{
            status: "completed",
            remote_object_key: objectKey,
            metadata: {
              backupCaptureCommittedToken: "attempt-old"
            }
          }]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 1,
      failed: 0
    });
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM remote_artifact_orphans")
    )).toBe(true);
  });
});
