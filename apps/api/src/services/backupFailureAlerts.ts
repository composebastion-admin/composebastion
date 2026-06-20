import { query } from "../db/pool.js";
import { sendNotificationToEnabledChannels } from "./alerts.js";

type FailureStatus = "failed" | "partial";
type FailurePhase = "backup" | "verify";

function isFailureStatus(status: string | null | undefined): status is FailureStatus {
  return status === "failed" || status === "partial";
}

function scheduleTarget(row: any) {
  return row.kind === "host_path" ? row.source_path ?? "host path" : row.volume_name ?? "volume";
}

export async function notifyBackupScheduleFailure(
  scheduleId: string,
  status: FailureStatus,
  error: string | null,
  phase: FailurePhase = "backup"
) {
  try {
    const result = await query<any>(
      `SELECT backup_schedules.*, docker_hosts.name AS host_name, docker_hosts.hostname AS host_hostname
       FROM backup_schedules
       LEFT JOIN docker_hosts ON docker_hosts.id = backup_schedules.host_id
       WHERE backup_schedules.id = $1`,
      [scheduleId]
    );
    const schedule = result.rows[0];
    if (!schedule) return;
    const target = scheduleTarget(schedule);
    const host = schedule.host_name ?? schedule.host_hostname ?? schedule.host_id;
    const subject = `Dockermender scheduled ${phase} ${status}: ${target}`;
    const message = [
      `Scheduled ${phase} finished with status: ${status}`,
      `Host: ${host}`,
      `Target: ${target}`,
      `Error: ${error || "No error details recorded"}`
    ].join("\n");
    const sent = await sendNotificationToEnabledChannels(subject, message);
    if (sent.failures.length) {
      console.warn("Backup failure notification had delivery failures", sent.failures);
    }
  } catch (notificationError) {
    console.warn(
      "Failed to send backup failure notification",
      notificationError instanceof Error ? notificationError.message : String(notificationError)
    );
  }
}

export async function recordBackupScheduleResult(scheduleId: string, status: string, error: string | null = null) {
  const previous = await query<{ last_status: string | null }>(
    "SELECT last_status FROM backup_schedules WHERE id = $1",
    [scheduleId]
  );
  await query(
    `UPDATE backup_schedules
     SET last_status = $2, last_error = $3, updated_at = now()
     WHERE id = $1`,
    [scheduleId, status, error]
  );
  const previousStatus = previous.rows[0]?.last_status ?? null;
  if (isFailureStatus(status) && !isFailureStatus(previousStatus)) {
    await notifyBackupScheduleFailure(scheduleId, status, error);
  }
}
