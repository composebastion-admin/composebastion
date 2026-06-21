import { dockerActionSchema } from "@composebastion/shared";
import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { deleteExpiredSessions } from "./services/auth.js";
import { runAlertChecks } from "./services/alerts.js";
import { runBackupDrill, runBackupVerify, runHostPathBackup, runHostPathRestore, runVolumeBackup, runVolumeClone, runVolumeRestore } from "./services/backups.js";
import { executeDockerAction } from "./services/docker.js";
import { listHostIds } from "./services/hosts.js";
import { buildJobProgress, claimNextJob, completeJob, failJob, markJobProgressStep, updateJobProgress } from "./services/jobs.js";
import { enqueueJob } from "./services/jobs.js";
import { createRedis } from "./services/redis.js";
import { runDueBackupSchedules } from "./services/backupSchedules.js";
import { markRecoveryDrillResult, runDueRecoverySchedules, runMigrationExecute, runRecoveryCreate, runRecoveryRestore, runRecoveryVerify } from "./services/recoveryCenter.js";
import { runStackUpdatePolicies } from "./services/stackUpdatePolicies.js";
import { safeErrorMessage, workerJobLogFields } from "./services/operationLogs.js";

let processing = false;

function primaryProgressStep(type: string) {
  if (type === "host.check") return "check";
  if (type === "host.sync") return "inventory";
  if (type === "backup.verify" || type === "recovery.verify") return "verify";
  if (type === "backup.drill") return "drill";
  if (type === "volume.backup" || type === "hostPath.backup" || type === "recovery.create" || type === "recovery.capture") return "capture";
  if (type === "volume.restore" || type === "hostPath.restore" || type === "recovery.restore") return "restore";
  if (type.startsWith("migration.")) return "plan";
  if (type.startsWith("compose.") || type === "git.cloneDeploy") return "deploy";
  if (type.startsWith("image.") || type === "container.update") return "apply";
  return "run";
}

async function processAvailableJobs() {
  if (processing) return;
  processing = true;
  try {
    while (true) {
      const job = await claimNextJob();
      if (!job) break;

      let actionForFailure: { type: string; payload: Record<string, unknown> } | null = null;
      let activeStepForFailure: string | undefined;
      const jobStartedAtMs = Date.now();
      try {
        console.info("worker.job", workerJobLogFields(job, "running", jobStartedAtMs));
        if (!job.hostId) throw new Error("Job has no host");
        const action = dockerActionSchema.parse({
          type: job.type,
          hostId: job.hostId,
          payload: job.payload
        });
        actionForFailure = action;
        activeStepForFailure = primaryProgressStep(action.type);
        await updateJobProgress(job.id, buildJobProgress(action.type, "running"));
        await markJobProgressStep(job.id, action.type, activeStepForFailure).catch(() => undefined);

        let result: Record<string, unknown>;
        if (action.type === "volume.backup") {
          result = await runVolumeBackup(action.hostId, action.payload.backupId, action.payload.volumeName);
        } else if (action.type === "volume.restore") {
          result = await runVolumeRestore(action.hostId, action.payload.backupId, action.payload.targetVolumeName, action.payload.overwrite);
        } else if (action.type === "volume.clone") {
          result = await runVolumeClone(action.hostId, action.payload.targetHostId, action.payload.sourceVolumeName, action.payload.targetVolumeName, action.payload.overwrite);
        } else if (action.type === "hostPath.backup") {
          result = await runHostPathBackup(action.hostId, action.payload.backupId, action.payload.sourcePath);
        } else if (action.type === "hostPath.restore") {
          result = await runHostPathRestore(action.hostId, action.payload.backupId, action.payload.targetPath, action.payload.overwrite);
        } else if (action.type === "backup.verify") {
          result = await runBackupVerify(action.hostId, action.payload.backupId, { testArchive: action.payload.testArchive });
        } else if (action.type === "backup.drill") {
          result = await runBackupDrill(action.hostId, action.payload.backupId);
        } else if (action.type === "recovery.create" || action.type === "recovery.capture") {
          result = await runRecoveryCreate(action.hostId, action.payload.recoveryPointId, {
            stopFirst: action.payload.stopFirst
          });
        } else if (action.type === "recovery.verify") {
          result = await runRecoveryVerify(action.hostId, action.payload.recoveryPointId);
        } else if (action.type === "recovery.restore") {
          result = await runRecoveryRestore(action.hostId, {
            recoveryPointId: action.payload.recoveryPointId,
            targetHostId: action.hostId,
            options: {
              mode: action.payload.mode,
              stopExisting: action.payload.stopExisting,
              projectNameOverride: action.payload.projectNameOverride,
              volumePrefix: action.payload.volumePrefix,
              restoreRoot: action.payload.restoreRoot,
              remapPorts: action.payload.remapPorts,
              networkMode: action.payload.networkMode
            }
          });
          if (action.payload.drill) {
            await markRecoveryDrillResult(action.payload.recoveryPointId, "completed");
          }
        } else if (action.type === "migration.execute") {
          result = await runMigrationExecute(action.hostId, action.payload.migrationRunId, {
            strategy: action.payload.strategy,
            stopSource: action.payload.stopSource,
            projectNameOverride: action.payload.projectNameOverride,
            remapPorts: action.payload.remapPorts,
            networkMode: action.payload.networkMode,
            onProgress: async (stepId, detail) => {
              activeStepForFailure = stepId;
              await markJobProgressStep(job.id, action.type, stepId, detail).catch(() => undefined);
            }
          });
        } else {
          result = await executeDockerAction(action);
        }
        await updateJobProgress(job.id, buildJobProgress(action.type, "completed"));
        await completeJob(job.id, result);
        console.info("worker.job", workerJobLogFields(job, "completed", jobStartedAtMs));
      } catch (error) {
        if (actionForFailure?.type === "recovery.restore" && actionForFailure.payload.drill === true && typeof actionForFailure.payload.recoveryPointId === "string") {
          await markRecoveryDrillResult(
            actionForFailure.payload.recoveryPointId,
            "failed",
            error instanceof Error ? error.message : String(error)
          ).catch(() => undefined);
        }
        const failureMessage = safeErrorMessage(error);
        await updateJobProgress(
          job.id,
          buildJobProgress(actionForFailure?.type ?? job.type, "failed", activeStepForFailure, failureMessage)
        ).catch(() => undefined);
        await failJob(job.id, error);
        console.error("worker.job", workerJobLogFields(job, "failed", jobStartedAtMs, error), failureMessage);
      }
    }
  } finally {
    processing = false;
  }
}

async function enqueueHostChecks() {
  const hostIds = await listHostIds();
  for (const hostId of hostIds) {
    await enqueueJob({ type: "host.check", hostId, payload: {} }, null);
  }
  await processAvailableJobs();
}

async function enqueueInventorySyncs() {
  const hostIds = await listHostIds();
  for (const hostId of hostIds) {
    await enqueueJob({ type: "host.sync", hostId, payload: {} }, null);
  }
  await processAvailableJobs();
}

async function main() {
  await runMigrations();

  const redis = createRedis();
  if (redis) {
    try {
      await redis.connect();
      await redis.subscribe("jobs:queued");
      redis.on("message", () => void processAvailableJobs());
    } catch (error) {
      console.warn("Redis subscription unavailable, falling back to polling:", error instanceof Error ? error.message : error);
    }
  }

  setInterval(() => void processAvailableJobs(), 2_500);
  setInterval(() => void enqueueHostChecks(), env.HOST_CHECK_INTERVAL_MS);
  setInterval(() => void enqueueInventorySyncs(), env.INVENTORY_SYNC_INTERVAL_MS);
  setInterval(() => void runAlertChecks(), 30_000);
  setInterval(() => void runDueBackupSchedules(), 60_000);
  setInterval(() => void runDueRecoverySchedules(), 60_000);
  setInterval(() => void runStackUpdatePolicies(), 30 * 60_000);
  setInterval(() => void deleteExpiredSessions(), 60 * 60_000);
  await deleteExpiredSessions();
  await processAvailableJobs();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`ComposeBastion worker received ${signal}, draining...`);
    const deadline = Date.now() + 30_000;
    while (processing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    redis?.disconnect();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.info(`ComposeBastion worker started for ${env.DATABASE_URL.replace(/:\/\/.*@/, "://***@")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
