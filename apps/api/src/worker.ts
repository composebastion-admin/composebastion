import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dockerActionSchema } from "@composebastion/shared";
import { env } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { deleteExpiredSessions } from "./services/auth.js";
import { runAlertChecks } from "./services/alerts.js";
import { runBackupDrill, runBackupVerify, runHostPathBackup, runHostPathRestore, runVolumeBackup, runVolumeClone, runVolumeRestore } from "./services/backups.js";
import { executeDockerAction } from "./services/docker.js";
import { listHostIds } from "./services/hosts.js";
import {
  buildJobProgress,
  assertJobLeaseActive,
  claimNextJob,
  cleanupWorkerInstances,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatWorker,
  JOB_LEASE_MAINTENANCE_INTERVAL_MS,
  JobLeaseLostError,
  markJobProgressStep,
  markWorkerDraining,
  markWorkerStopped,
  recoverExpiredJobs,
  registerWorkerInstance,
  renewJobLease,
  updateJobProgress,
  withActiveJobLeaseTransaction,
  WORKER_HEARTBEAT_INTERVAL_MS,
  type JobExecutionFence,
  type JobLease
} from "./services/jobs.js";
import { startRedisWakeupSubscription, type RedisWakeupSubscription } from "./services/redisWakeups.js";
import { runDueBackupSchedules } from "./services/backupSchedules.js";
import { markRecoveryDrillResult, runDueRecoverySchedules, runMigrationExecute, runRecoveryCreate, runRecoveryRestore, runRecoveryVerify } from "./services/recoveryCenter.js";
import { runSelfUpdate } from "./services/selfUpdate.js";
import { runStackUpdatePolicies } from "./services/stackUpdatePolicies.js";
import { safeErrorMessage, workerJobLogFields } from "./services/operationLogs.js";
import { createNonOverlappingTask } from "./services/nonOverlappingTask.js";
import { APP_VERSION } from "./services/version.js";

let processing = false;
let acceptingJobs = true;
let shuttingDown = false;
let workerRegistered = false;
const workerId = randomUUID();
const scheduledTasks = new Set<string>();
const timers = new Set<NodeJS.Timeout>();
let redisWakeups: RedisWakeupSubscription | null = null;

function primaryProgressStep(type: string) {
  if (type === "host.check") return "check";
  if (type === "host.sync") return "inventory";
  if (type === "backup.verify" || type === "recovery.verify") return "verify";
  if (type === "backup.drill") return "drill";
  if (type === "volume.backup" || type === "hostPath.backup" || type === "recovery.create" || type === "recovery.capture") return "capture";
  if (type === "volume.restore" || type === "hostPath.restore" || type === "recovery.restore") return "restore";
  if (type.startsWith("migration.")) return "plan";
  if (type.startsWith("compose.") || type === "git.cloneDeploy") return "deploy";
  if (type === "system.self_update") return "handoff";
  if (type.startsWith("image.") || type === "container.update") return "apply";
  return "run";
}

async function processAvailableJobs() {
  if (processing || !acceptingJobs) return;
  processing = true;
  try {
    while (acceptingJobs) {
      const job = await claimNextJob(workerId);
      if (!job) break;
      const lease: JobLease = { workerId: job.workerId, attemptCount: job.attemptCount };
      let leaseLost = false;
      const executionFence: JobExecutionFence = {
        assertActive: async () => {
          if (leaseLost) throw new JobLeaseLostError(job.id);
          await assertJobLeaseActive(job.id, lease);
        },
        withActiveLease: (callback) => withActiveJobLeaseTransaction(job.id, lease, callback)
      };
      const leaseRenewal = createNonOverlappingTask(() => renewJobLease(job.id, lease));
      const leaseRenewalTimer = setInterval(() => {
        void leaseRenewal.run()
          .then((result) => {
            if (result.started && !leaseRenewal.isStopped() && !result.value) leaseLost = true;
          })
          .catch((error) => {
            console.error("worker.lease.renew", {
              jobId: job.id,
              error: safeErrorMessage(error)
            });
          });
      }, JOB_LEASE_MAINTENANCE_INTERVAL_MS);

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
        await updateJobProgress(job.id, buildJobProgress(action.type, "running"), lease);
        await markJobProgressStep(job.id, action.type, activeStepForFailure, undefined, lease);

        let result: Record<string, unknown>;
        if (action.type === "volume.backup") {
          result = await runVolumeBackup(action.hostId, action.payload.backupId, action.payload.volumeName, executionFence);
        } else if (action.type === "volume.restore") {
          result = await runVolumeRestore(action.hostId, action.payload.backupId, action.payload.targetVolumeName, action.payload.overwrite, executionFence);
        } else if (action.type === "volume.clone") {
          result = await runVolumeClone(action.hostId, action.payload.targetHostId, action.payload.sourceVolumeName, action.payload.targetVolumeName, action.payload.overwrite, action.payload.backupId, executionFence);
        } else if (action.type === "hostPath.backup") {
          result = await runHostPathBackup(action.hostId, action.payload.backupId, action.payload.sourcePath, executionFence);
        } else if (action.type === "hostPath.restore") {
          result = await runHostPathRestore(action.hostId, action.payload.backupId, action.payload.targetPath, action.payload.overwrite, executionFence);
        } else if (action.type === "backup.verify") {
          result = await runBackupVerify(action.hostId, action.payload.backupId, { testArchive: action.payload.testArchive }, executionFence);
        } else if (action.type === "backup.drill") {
          result = await runBackupDrill(action.hostId, action.payload.backupId, executionFence);
        } else if (action.type === "recovery.create" || action.type === "recovery.capture") {
          result = await runRecoveryCreate(action.hostId, action.payload.recoveryPointId, {
            stopFirst: action.payload.stopFirst,
            executionFence
          });
        } else if (action.type === "recovery.verify") {
          result = await runRecoveryVerify(action.hostId, action.payload.recoveryPointId, executionFence);
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
          }, executionFence);
          if (action.payload.drill) {
            await markRecoveryDrillResult(action.payload.recoveryPointId, "completed", null, executionFence);
          }
        } else if (action.type === "migration.execute") {
          result = await runMigrationExecute(action.hostId, action.payload.migrationRunId, {
            strategy: action.payload.strategy,
            stopSource: action.payload.stopSource,
            projectNameOverride: action.payload.projectNameOverride,
            remapPorts: action.payload.remapPorts,
            networkMode: action.payload.networkMode,
            executionFence,
            onProgress: async (stepId, detail) => {
              activeStepForFailure = stepId;
              await markJobProgressStep(job.id, action.type, stepId, detail, lease);
            }
          });
        } else if (action.type === "system.self_update") {
          result = await runSelfUpdate(action.hostId, action.payload, {
            onProgress: async (stepId, detail) => {
              await executionFence.assertActive();
              activeStepForFailure = stepId;
              await markJobProgressStep(job.id, action.type, stepId, detail, lease);
            }
          });
        } else {
          await executionFence.assertActive();
          result = await executeDockerAction(action, executionFence);
        }
        await updateJobProgress(job.id, buildJobProgress(action.type, "completed"), lease);
        const completed = await completeJob(job.id, result, lease);
        if (completed) {
          console.info("worker.job", workerJobLogFields(job, "completed", jobStartedAtMs));
        } else {
          leaseLost = true;
          console.warn("worker.job.lease_lost", { jobId: job.id, attemptCount: job.attemptCount });
        }
      } catch (error) {
        if (actionForFailure?.type === "recovery.restore" && actionForFailure.payload.drill === true && typeof actionForFailure.payload.recoveryPointId === "string") {
          await markRecoveryDrillResult(
            actionForFailure.payload.recoveryPointId,
            "failed",
            error instanceof Error ? error.message : String(error),
            executionFence
          ).catch((drillError) => {
            if (drillError instanceof JobLeaseLostError) leaseLost = true;
            else console.error("worker.drill.finalize", { jobId: job.id, error: safeErrorMessage(drillError) });
          });
        }
        const failureMessage = safeErrorMessage(error);
        await updateJobProgress(
          job.id,
          buildJobProgress(actionForFailure?.type ?? job.type, "failed", activeStepForFailure, failureMessage),
          lease
        ).catch((progressError) => {
          if (progressError instanceof JobLeaseLostError) leaseLost = true;
        });
        const failed = await failJob(job.id, error, lease);
        if (failed) {
          console.error("worker.job", workerJobLogFields(job, "failed", jobStartedAtMs, error));
        } else {
          leaseLost = true;
          console.warn("worker.job.lease_lost", { jobId: job.id, attemptCount: job.attemptCount });
        }
      } finally {
        leaseRenewal.stop();
        clearInterval(leaseRenewalTimer);
        if (leaseLost) {
          console.warn("Worker discarded terminal state after losing its fenced lease", { jobId: job.id });
        }
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

async function runScheduled(name: string, task: () => Promise<unknown>) {
  if (shuttingDown || scheduledTasks.has(name)) return;
  scheduledTasks.add(name);
  try {
    await task();
  } catch (error) {
    console.error("worker.scheduled", { task: name, error: safeErrorMessage(error) });
  } finally {
    scheduledTasks.delete(name);
  }
}

function schedule(name: string, intervalMs: number, task: () => Promise<unknown>) {
  const timer = setInterval(() => void runScheduled(name, task), intervalMs);
  timers.add(timer);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  acceptingJobs = false;
  console.info(`ComposeBastion worker received ${signal}, draining...`);
  for (const timer of timers) clearInterval(timer);
  timers.clear();

  if (workerRegistered) {
    await markWorkerDraining(workerId).catch((error) => {
      console.error("worker.drain", { error: safeErrorMessage(error) });
    });
  }

  const deadline = Date.now() + 30_000;
  while (processing && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  redisWakeups?.close();
  redisWakeups = null;
  if (workerRegistered) {
    await markWorkerStopped(workerId).catch((error) => {
      console.error("worker.stop", { error: safeErrorMessage(error) });
    });
  }
  await pool.end();
  process.exit(0);
}

// Install signal handlers before migrations, subscriptions, timers, or job
// claims so early container shutdowns cannot leave the worker accepting work.
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  await runMigrations();
  await registerWorkerInstance({ id: workerId, version: APP_VERSION, hostname: hostname() });
  workerRegistered = true;
  await cleanupWorkerInstances();
  await recoverExpiredJobs();

  redisWakeups = startRedisWakeupSubscription({
    onWakeup: () => void runScheduled("job-poll", processAvailableJobs)
  });

  schedule("job-poll", 2_500, processAvailableJobs);
  schedule("worker-heartbeat", WORKER_HEARTBEAT_INTERVAL_MS, async () => {
    if (!(await heartbeatWorker(workerId))) throw new Error("Worker heartbeat row is no longer active");
  });
  schedule("lease-recovery", JOB_LEASE_MAINTENANCE_INTERVAL_MS, async () => {
    const recovered = await recoverExpiredJobs();
    if (recovered.requeued || recovered.failed) console.warn("worker.jobs.recovered", recovered);
  });
  schedule("host-checks", env.HOST_CHECK_INTERVAL_MS, enqueueHostChecks);
  schedule("inventory-syncs", env.INVENTORY_SYNC_INTERVAL_MS, enqueueInventorySyncs);
  schedule("alert-checks", 30_000, runAlertChecks);
  schedule("backup-schedules", 60_000, runDueBackupSchedules);
  schedule("recovery-schedules", 60_000, runDueRecoverySchedules);
  schedule("stack-update-policies", 30 * 60_000, runStackUpdatePolicies);
  schedule("session-cleanup", 60 * 60_000, deleteExpiredSessions);
  schedule("worker-cleanup", 60 * 60_000, cleanupWorkerInstances);
  await runScheduled("session-cleanup-initial", deleteExpiredSessions);
  await runScheduled("job-poll", processAvailableJobs);

  console.info(`ComposeBastion worker started for ${env.DATABASE_URL.replace(/:\/\/.*@/, "://***@")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
