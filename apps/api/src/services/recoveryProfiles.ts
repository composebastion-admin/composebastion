import { v4 as uuid } from "uuid";
import type { RecoveryAppIdentity, RecoveryProfile, RecoveryProfileInput } from "@composebastion/shared";
import { recoveryProfileInputSchema } from "@composebastion/shared";
import { query } from "../db/pool.js";

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

export async function upsertRecoveryProfile(input: RecoveryProfileInput, createdBy?: string | null) {
  const body = recoveryProfileInputSchema.parse(input);
  const existing = await getRecoveryProfileForApp(body.hostId, body.appIdentity);
  const name = body.name ?? (body.appIdentity.label || body.appIdentity.kind);
  if (existing) {
    const result = await query(
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
        existing.id,
        body.hostId,
        name,
        body.includePaths,
        body.excludePatterns,
        body.restorePaths,
        body.preCaptureCommand ?? null,
        body.postCaptureCommand ?? null,
        body.captureMode
      ]
    );
    return mapRecoveryProfile(result.rows[0]);
  }

  const result = await query(
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
  return mapRecoveryProfile(result.rows[0]);
}

export async function deleteRecoveryProfile(id: string) {
  const result = await query("DELETE FROM recovery_profiles WHERE id = $1 RETURNING *", [id]);
  return result.rows[0] ? mapRecoveryProfile(result.rows[0]) : null;
}
