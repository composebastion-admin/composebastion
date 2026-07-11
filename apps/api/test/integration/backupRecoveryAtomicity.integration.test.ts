import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../../src/config/env.js";
import { runMigrations } from "../../src/db/migrate.js";
import { pool } from "../../src/db/pool.js";
import { createBackupWithJob, createVolumeCloneWithJob } from "../../src/services/backups.js";
import { runDueBackupSchedules } from "../../src/services/backupSchedules.js";
import { createRecoveryPointWithJob, runDueRecoverySchedules } from "../../src/services/recoveryCenter.js";

const integrationEnabled = process.env.COMPOSEBASTION_INTEGRATION === "1";
const userId = "8a000000-0000-4000-8000-000000000001";
const hostId = "8a000000-0000-4000-8000-000000000002";
const stackId = "8a000000-0000-4000-8000-000000000003";
const backupScheduleId = "8a000000-0000-4000-8000-000000000004";
const recoveryScheduleId = "8a000000-0000-4000-8000-000000000005";
const triggerName = "operation_jobs_atomicity_test_trigger";
const triggerFunction = "operation_jobs_atomicity_test_failure";
const backupDir = path.join(tmpdir(), `composebastion-atomicity-${process.pid}`);

describe.skipIf(!integrationEnabled)("backup and recovery job atomicity", () => {
  beforeAll(async () => {
    env.BACKUP_DIR = backupDir;
    await runMigrations();
    await pool.query("DELETE FROM operation_jobs WHERE created_by = $1", [userId]);
    await pool.query("DELETE FROM recovery_schedules WHERE id = $1", [recoveryScheduleId]);
    await pool.query("DELETE FROM backup_schedules WHERE id = $1", [backupScheduleId]);
    await pool.query("DELETE FROM recovery_points WHERE created_by = $1", [userId]);
    await pool.query("DELETE FROM backups WHERE host_id = $1", [hostId]);
    await pool.query("DELETE FROM compose_stacks WHERE id = $1", [stackId]);
    await pool.query("DELETE FROM docker_hosts WHERE id = $1", [hostId]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [userId]);
    await pool.query(
      `INSERT INTO admin_users (id, email, password_hash, name, role, is_active)
       VALUES ($1, $2, 'not-a-login-password', 'Atomicity Test', 'owner', true)`,
      [userId, `atomicity-${userId}@example.test`]
    );
    await pool.query(
      `INSERT INTO docker_hosts (id, name, hostname, port, username, docker_socket_path, connection_mode, ssh_auth_type)
       VALUES ($1, 'Atomicity Host', '127.0.0.1', 22, 'docker', '/var/run/docker.sock', 'ssh', 'key')`,
      [hostId]
    );
    await pool.query(
      `INSERT INTO compose_stacks (id, host_id, name, project_name, compose_yaml, env, status)
       VALUES ($1, $2, 'Atomicity App', 'atomicity-app', 'services:\n  web:\n    image: nginx:alpine\n', '', 'deployed')`,
      [stackId, hostId]
    );
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON operation_jobs`);
    await pool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    await pool.query(
      `CREATE FUNCTION ${triggerFunction}() RETURNS trigger AS $$
       BEGIN
         IF NEW.created_by = '${userId}'::uuid THEN
           RAISE EXCEPTION 'forced operation job insert failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON operation_jobs
       FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`
    );
  });

  afterAll(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON operation_jobs`);
    await pool.query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    await pool.query("DELETE FROM operation_jobs WHERE created_by = $1 OR host_id = $2", [userId, hostId]);
    await pool.query("DELETE FROM recovery_schedules WHERE id = $1", [recoveryScheduleId]);
    await pool.query("DELETE FROM backup_schedules WHERE id = $1", [backupScheduleId]);
    await pool.query("DELETE FROM recovery_points WHERE created_by = $1 OR host_id = $2", [userId, hostId]);
    await pool.query("DELETE FROM backups WHERE host_id = $1", [hostId]);
    await pool.query("DELETE FROM compose_stacks WHERE id = $1", [stackId]);
    await pool.query("DELETE FROM docker_hosts WHERE id = $1", [hostId]);
    await pool.query("DELETE FROM admin_users WHERE id = $1", [userId]);
    await rm(backupDir, { recursive: true, force: true });
  });

  it("rolls back a manual backup record when its job insert fails", async () => {
    await expect(createBackupWithJob(hostId, "atomicity-manual", {}, userId))
      .rejects.toThrow("forced operation job insert failure");

    const backups = await pool.query("SELECT id FROM backups WHERE host_id = $1 AND volume_name = 'atomicity-manual'", [hostId]);
    const jobs = await pool.query("SELECT id FROM operation_jobs WHERE created_by = $1", [userId]);
    expect(backups.rowCount).toBe(0);
    expect(jobs.rowCount).toBe(0);
  });

  it("rolls back the pre-created volume-clone backup when its linked job insert fails", async () => {
    await expect(createVolumeCloneWithJob({
      sourceHostId: hostId,
      targetHostId: hostId,
      sourceVolumeName: "atomicity-clone-source",
      targetVolumeName: "atomicity-clone-target"
    }, userId)).rejects.toThrow("forced operation job insert failure");

    const backups = await pool.query(
      "SELECT id FROM backups WHERE host_id = $1 AND volume_name = 'atomicity-clone-source'",
      [hostId]
    );
    expect(backups.rowCount).toBe(0);
  });

  it("rolls back a recovery point and artifacts when its job insert fails", async () => {
    await expect(createRecoveryPointWithJob({
      hostId,
      name: "Atomicity recovery point",
      appIdentity: { kind: "stack", stackId, projectName: "atomicity-app" },
      triggerKind: "manual"
    }, userId)).rejects.toThrow("forced operation job insert failure");

    const points = await pool.query("SELECT id FROM recovery_points WHERE created_by = $1", [userId]);
    const artifacts = await pool.query(
      "SELECT id FROM recovery_artifacts WHERE recovery_point_id IN (SELECT id FROM recovery_points WHERE created_by = $1)",
      [userId]
    );
    expect(points.rowCount).toBe(0);
    expect(artifacts.rowCount).toBe(0);
  });

  it("does not advance a backup schedule or leave a backup when enqueue fails", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    await pool.query(
      `INSERT INTO backup_schedules
        (id, host_id, kind, volume_name, interval_ms, next_run_at, created_by)
       VALUES ($1, $2, 'volume', 'atomicity-scheduled', 300000, $3, $4)`,
      [backupScheduleId, hostId, dueAt, userId]
    );

    await runDueBackupSchedules();

    const schedule = await pool.query("SELECT next_run_at, last_status FROM backup_schedules WHERE id = $1", [backupScheduleId]);
    const backups = await pool.query("SELECT id FROM backups WHERE host_id = $1 AND volume_name = 'atomicity-scheduled'", [hostId]);
    expect(new Date(schedule.rows[0].next_run_at).getTime()).toBe(dueAt.getTime());
    expect(schedule.rows[0].last_status).toBe("failed");
    expect(backups.rowCount).toBe(0);
  });

  it("does not advance a recovery schedule or leave a point when enqueue fails", async () => {
    const dueAt = new Date(Date.now() - 60_000);
    await pool.query(
      `INSERT INTO recovery_schedules
        (id, host_id, name, app_identity, interval_ms, next_run_at, created_by, capture_mode)
       VALUES ($1, $2, 'Atomicity recovery schedule', $3, 300000, $4, $5, 'hot')`,
      [
        recoveryScheduleId,
        hostId,
        { kind: "stack", stackId, projectName: "atomicity-app" },
        dueAt,
        userId
      ]
    );

    await runDueRecoverySchedules();

    const schedule = await pool.query("SELECT next_run_at FROM recovery_schedules WHERE id = $1", [recoveryScheduleId]);
    const points = await pool.query(
      "SELECT id FROM recovery_points WHERE metadata->>'scheduleId' = $1",
      [recoveryScheduleId]
    );
    expect(new Date(schedule.rows[0].next_run_at).getTime()).toBe(dueAt.getTime());
    expect(points.rowCount).toBe(0);
  });
});
