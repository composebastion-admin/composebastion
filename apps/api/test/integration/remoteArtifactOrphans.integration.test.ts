import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteRemoteArtifact: vi.fn()
}));

vi.mock("../../src/services/recoveryRemoteStorage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/services/recoveryRemoteStorage.js")>(),
  deleteRemoteArtifact: (...args: unknown[]) => mocks.deleteRemoteArtifact(...args)
}));

import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { decryptSecret, encryptSecret } from "../../src/services/crypto.js";
import { deleteBackupTarget, updateBackupTarget } from "../../src/services/recoveryCenter.js";
import { loadWorkerBackupTarget } from "../../src/services/recoveryBackupTargets.js";
import {
  beginRemoteArtifactWriteIntent,
  reconcileRemoteArtifactOrphans,
  recordRemoteArtifactOrphan
} from "../../src/services/recoveryRemoteOrphans.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("remote artifact orphan PostgreSQL durability", () => {
  let targetId = "";
  let hostId = "";

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.deleteRemoteArtifact.mockResolvedValue(undefined);
    await pool.query("DELETE FROM remote_artifact_orphans");
    targetId = randomUUID();
    hostId = randomUUID();
    await pool.query(
      `INSERT INTO docker_hosts (
         id, name, hostname, username, ssh_key_encrypted
       )
       VALUES ($1, $2, '127.0.0.1', 'fixture', $3)`,
      [hostId, "Remote orphan fixture host", encryptSecret("fixture-key")]
    );
    await pool.query(
      `INSERT INTO backup_targets (
         id, name, kind, enabled, config, access_key_id,
         secret_access_key_encrypted, local_cache_policy, health_status
       )
       VALUES ($1, $2, 's3', true, $3::jsonb, $4, $5, 'remote_only', 'unknown')`,
      [
        targetId,
        "Remote orphan integration target",
        JSON.stringify({
          endpoint: "https://old-storage.example.test",
          bucket: "old-bucket",
          region: "eu-west-1",
          prefix: "old-prefix",
          forcePathStyle: true
        }),
        "old-access",
        encryptSecret("1234")
      ]
    );
  });

  afterEach(async () => {
    await pool.query(
      "DELETE FROM remote_artifact_orphans WHERE backup_target_id = $1",
      [targetId]
    );
    await pool.query("DELETE FROM backups WHERE host_id = $1", [hostId]);
    await pool.query("DELETE FROM backup_targets WHERE id = $1", [targetId]);
    await pool.query("DELETE FROM docker_hosts WHERE id = $1", [hostId]);
  });

  it("rejects owner/token turnover, retries safely, and cleans with the immutable pre-edit target", async () => {
    const ownerId = randomUUID();
    const successorOwnerId = randomUUID();
    const objectKey = `${ownerId}/attempts/attempt-old/backup.tar.gz`;
    const originalTarget = await loadWorkerBackupTarget(targetId);

    // Deterministic load -> target edit -> orphan record interleaving. The
    // durable cleanup must still use the target that performed the PUT.
    await pool.query(
      `UPDATE backup_targets
       SET config = $2::jsonb,
           access_key_id = $3,
           secret_access_key_encrypted = $4,
           updated_at = now()
       WHERE id = $1`,
      [
        targetId,
        JSON.stringify({
          endpoint: "https://new-storage.example.test",
          bucket: "new-bucket",
          region: "us-east-1",
          prefix: "new-prefix",
          forcePathStyle: false
        }),
        "new-access",
        encryptSecret("new-secret")
      ]
    );

    await recordRemoteArtifactOrphan({
      ownerKind: "backup",
      ownerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-old",
      target: originalTarget,
      cleanupError: new Error("initial compensation failed")
    });
    // An exact key can never be rebound to a successor owner or token.
    await expect(recordRemoteArtifactOrphan({
      ownerKind: "backup",
      ownerId: successorOwnerId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken: "attempt-successor",
      target: originalTarget,
      cleanupError: new Error("successor still observes the cleanup obligation")
    })).rejects.toThrow("conflicts with a different owner or attempt");

    const stored = await pool.query<{
      owner_id: string;
      attempt_token: string;
      object_key: string;
      target_binding_fingerprint: string;
      target_snapshot_encrypted: string;
    }>(
      `SELECT owner_id, attempt_token, object_key,
              target_binding_fingerprint, target_snapshot_encrypted
       FROM remote_artifact_orphans
       WHERE backup_target_id = $1`,
      [targetId]
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      owner_id: ownerId,
      attempt_token: "attempt-old",
      object_key: objectKey
    });
    expect(stored.rows[0]?.target_binding_fingerprint)
      .toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(stored.rows[0]?.target_snapshot_encrypted).not.toContain("1234");
    expect(JSON.parse(decryptSecret(stored.rows[0]!.target_snapshot_encrypted)))
      .toEqual(originalTarget);
    const missingOwner = await pool.query(
      `SELECT id FROM backups WHERE id = $1
       UNION ALL
       SELECT id FROM recovery_artifacts WHERE id = $1`,
      [ownerId]
    );
    expect(missingOwner.rows).toHaveLength(0);

    const retrySecret = "retry-url-secret";
    mocks.deleteRemoteArtifact.mockRejectedValueOnce(
      new Error(
        `delete failed https://worker:${retrySecret}@old-storage.example.test/object?signature=${retrySecret}#debug`
      )
    );
    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 0,
      failed: 1
    });
    const retained = await pool.query<{
      cleanup_error: string;
      cleanup_claim_token: string | null;
    }>(
      `SELECT cleanup_error, cleanup_claim_token
       FROM remote_artifact_orphans
       WHERE backup_target_id = $1`,
      [targetId]
    );
    expect(retained.rows[0]).toEqual({
      cleanup_error: "delete failed https://old-storage.example.test/object",
      cleanup_claim_token: null
    });
    expect(JSON.stringify(retained.rows)).not.toContain(retrySecret);

    await expect(updateBackupTarget(targetId, {
      accessKeyId: "third-access",
      secretAccessKey: "third-secret"
    })).rejects.toMatchObject({
      statusCode: 409,
      remoteArtifactOrphanCount: 1
    });
    await expect(deleteBackupTarget(targetId)).rejects.toMatchObject({
      statusCode: 409,
      remoteArtifactOrphanCount: 1
    });

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 1,
      failed: 0
    });
    expect(mocks.deleteRemoteArtifact).toHaveBeenCalledTimes(2);
    for (const [target, key] of mocks.deleteRemoteArtifact.mock.calls) {
      expect(target).toEqual(originalTarget);
      expect(key).toBe(objectKey);
    }
    expect(await pool.query(
      "SELECT id FROM remote_artifact_orphans WHERE backup_target_id = $1",
      [targetId]
    )).toMatchObject({ rowCount: 0 });

    await expect(deleteBackupTarget(targetId)).resolves.toMatchObject({ id: targetId });
  });

  it("keeps a pre-PUT intent while its owner is active and drops only the ledger after commit", async () => {
    const backupId = randomUUID();
    const attemptToken = randomUUID();
    const objectKey = `${backupId}/attempts/${attemptToken}/backup.tar.gz`;
    await pool.query(
      `INSERT INTO backups (
         id, host_id, volume_name, file_name, status, backup_target_id, metadata
       )
       VALUES ($1, $2, 'fixture-volume', 'backup.tar.gz', 'running', $3, $4::jsonb)`,
      [
        backupId,
        hostId,
        targetId,
        JSON.stringify({ backupCaptureAttemptToken: attemptToken })
      ]
    );
    const target = await loadWorkerBackupTarget(targetId);
    await beginRemoteArtifactWriteIntent({
      ownerKind: "backup",
      ownerId: backupId,
      backupTargetId: targetId,
      objectKey,
      backend: "s3",
      attemptToken,
      target
    });
    await pool.query(
      `UPDATE remote_artifact_orphans
       SET cleanup_claimed_at = now() - interval '10 minutes'
       WHERE backup_target_id = $1 AND object_key = $2`,
      [targetId, objectKey]
    );

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 0,
      failed: 0
    });
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(await pool.query(
      `SELECT id FROM remote_artifact_orphans
       WHERE backup_target_id = $1 AND object_key = $2`,
      [targetId, objectKey]
    )).toMatchObject({ rowCount: 1 });

    await pool.query(
      `UPDATE backups
       SET status = 'completed',
           remote_object_key = $2,
           metadata = metadata || $3::jsonb
       WHERE id = $1`,
      [
        backupId,
        objectKey,
        JSON.stringify({ backupCaptureCommittedToken: attemptToken })
      ]
    );
    await pool.query(
      `UPDATE remote_artifact_orphans
       SET cleanup_claimed_at = now() - interval '10 minutes'
       WHERE backup_target_id = $1 AND object_key = $2`,
      [targetId, objectKey]
    );

    await expect(reconcileRemoteArtifactOrphans()).resolves.toEqual({
      checked: 1,
      cleaned: 1,
      failed: 0
    });
    expect(mocks.deleteRemoteArtifact).not.toHaveBeenCalled();
    expect(await pool.query(
      `SELECT id FROM remote_artifact_orphans
       WHERE backup_target_id = $1 AND object_key = $2`,
      [targetId, objectKey]
    )).toMatchObject({ rowCount: 0 });
  });
});
