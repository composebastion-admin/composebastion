import { v4 as uuid } from "uuid";
import type { RecoveryAppIdentity, RecoveryProfile, RecoveryProfileInput } from "@composebastion/shared";
import { recoveryProfileInputSchema } from "@composebastion/shared";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export function mapRecoveryProfile(row: any): RecoveryProfile {
  return {
    id: row.id,
    hostId: row.host_id,
    appIdentity: row.app_identity,
    name: row.name,
    includePaths: row.include_paths ?? [],
    excludePatterns: row.exclude_patterns ?? [],
    restorePaths: row.restore_paths ?? {},
    preCaptureCommand: row.pre_capture_command ?? null,
    postCaptureCommand: row.post_capture_command ?? null,
    captureMode: row.capture_mode === "stop_first" ? "stop_first" : "hot",
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export function redactRecoveryProfileForViewer(profile: RecoveryProfile | null) {
  if (!profile) return null;
  return {
    ...profile,
    includePaths: [],
    excludePatterns: [],
    restorePaths: {},
    preCaptureCommand: null,
    postCaptureCommand: null,
    sensitiveFieldsRedacted: true as const
  };
}

export async function getRecoveryProfile(id: string) {
  const result = await query("SELECT * FROM recovery_profiles WHERE id = $1", [id]);
  return result.rows[0] ? mapRecoveryProfile(result.rows[0]) : null;
}

export async function getRecoveryProfileForApp(hostId: string, appIdentity: RecoveryAppIdentity) {
  const result = await query(
    "SELECT * FROM recovery_profiles WHERE host_id = $1 AND app_identity = $2::jsonb",
    [hostId, appIdentity]
  );
  return result.rows[0] ? mapRecoveryProfile(result.rows[0]) : null;
}

export async function upsertRecoveryProfile(
  input: RecoveryProfileInput,
  createdBy?: string | null,
  onUpserted?: (
    client: PoolClient,
    profile: RecoveryProfile
  ) => Promise<void>
) {
  const body = recoveryProfileInputSchema.parse(input);
  const name = body.name ?? (body.appIdentity.label || body.appIdentity.kind);
  return withTransaction(async (client) => {
    // Serialize the no-row case as well as updates. The expression-backed
    // unique index remains the final duplicate guard.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`recovery-profile:${body.hostId}:${JSON.stringify(body.appIdentity)}`]
    );
    const existing = await client.query(
      `SELECT *
       FROM recovery_profiles
       WHERE host_id = $1 AND app_identity = $2::jsonb
       FOR UPDATE`,
      [body.hostId, body.appIdentity]
    );
    const result = existing.rows[0]
      ? await client.query(
          `UPDATE recovery_profiles
           SET name = $3,
               include_paths = $4,
               exclude_patterns = $5,
               restore_paths = $6,
               pre_capture_command = $7,
               post_capture_command = $8,
               capture_mode = $9,
               updated_at = now()
           WHERE id = $1 AND host_id = $2
           RETURNING *`,
          [
            existing.rows[0].id,
            body.hostId,
            name,
            body.includePaths,
            body.excludePatterns,
            body.restorePaths,
            body.preCaptureCommand ?? null,
            body.postCaptureCommand ?? null,
            body.captureMode
          ]
        )
      : await client.query(
          `INSERT INTO recovery_profiles (
             id, host_id, app_identity, name, include_paths, exclude_patterns,
             restore_paths, pre_capture_command, post_capture_command, capture_mode, created_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            uuid(),
            body.hostId,
            body.appIdentity,
            name,
            body.includePaths,
            body.excludePatterns,
            body.restorePaths,
            body.preCaptureCommand ?? null,
            body.postCaptureCommand ?? null,
            body.captureMode,
            createdBy ?? null
          ]
        );
    const profile = mapRecoveryProfile(result.rows[0]);
    await onUpserted?.(client, profile);
    return profile;
  });
}

export async function deleteRecoveryProfile(
  id: string,
  onDeleted?: (
    client: PoolClient,
    profile: RecoveryProfile
  ) => Promise<void>
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      "DELETE FROM recovery_profiles WHERE id = $1 RETURNING *",
      [id]
    );
    if (!result.rows[0]) return null;
    const profile = mapRecoveryProfile(result.rows[0]);
    await onDeleted?.(client, profile);
    return profile;
  });
}
