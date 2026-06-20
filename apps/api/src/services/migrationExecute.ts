import type { MigrationStrategy, RecoveryPointDetail } from "@dockermender/shared";
import type { RecoveryNetworkMode } from "@dockermender/shared";
import { query } from "../db/pool.js";
import { writeAuditEvent } from "./audit.js";
import { buildComposeCommand, shQuote, withDockerEnv } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { getHostForWorker } from "./hosts.js";
import { mapMigrationRun } from "./mappers.js";
import { runRecoveryCreate } from "./recoveryCapture.js";
import { runRecoveryRestore, type RestoreResult } from "./recoveryRestore.js";
import { resolveAppContext } from "./recoveryAppContext.js";
import {
  recordRunningStates,
  wasAnyContainerRunning,
  containersToRestart,
  type ContainerRunningState
} from "./recoveryManifest.js";
import {
  startContainersOneByOne
} from "./recoveryContainerControl.js";
import { runSshCommand } from "./ssh.js";
import { buildCloneContainerName, shouldRestartSourceAfterFailure } from "./recoveryRestoreUtils.js";
import { syncDockerInventory } from "./docker.js";
import { checkImageUpdatesForHost } from "./imageUpdates.js";

async function getMigrationRun(id: string) {
  const result = await query("SELECT * FROM migration_runs WHERE id = $1", [id]);
  return result.rows[0] ? mapMigrationRun(result.rows[0]) : null;
}

type ExecuteConfig = {
  strategy: MigrationStrategy;
  stopSource: boolean;
  projectNameOverride?: string;
  remapPorts: boolean;
  networkMode?: RecoveryNetworkMode;
  onProgress?: (stepId: MigrationProgressStep, detail: string) => Promise<void> | void;
  inventoryPollAttempts?: number;
  inventoryPollDelayMs?: number;
};

type CaptureResult = {
  sourceLeftStopped?: boolean;
  stoppedContainerIds?: string[];
};

type MigrationProgressStep = "plan" | "capture" | "transfer" | "deploy" | "verify";

async function reportProgress(config: ExecuteConfig, stepId: MigrationProgressStep, detail: string) {
  await config.onProgress?.(stepId, detail);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseContainerLabels(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
  }
  if (typeof value !== "string" || !value) return {};
  const labels: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return labels;
}

function assertMigrationRecoveryPointReady(point: { status?: string; hostId?: string } | null, sourceHostId: string): asserts point is RecoveryPointDetail {
  if (!point || (point.status !== "completed" && point.status !== "partial")) {
    throw new Error("Migration recovery point is not ready");
  }
  if (point.hostId && point.hostId !== sourceHostId) {
    throw new Error("Migration recovery point belongs to a different source host");
  }
}

function dataArtifacts(point: RecoveryPointDetail) {
  return point.artifacts.filter((artifact) => artifact.kind === "volume" || artifact.kind === "host_folder");
}

function artifactLabel(artifact: RecoveryPointDetail["artifacts"][number]) {
  const sourcePath = artifact.metadata.sourcePath;
  const volumeName = artifact.metadata.volumeName;
  if (artifact.kind === "host_folder" && typeof sourcePath === "string") return sourcePath;
  if (artifact.kind === "volume" && typeof volumeName === "string") return volumeName;
  return artifact.storageKey;
}

function assertMigrationDataCaptureComplete(point: RecoveryPointDetail) {
  const artifacts = dataArtifacts(point);
  const incomplete = artifacts.filter((artifact) => artifact.status !== "completed");
  if (incomplete.length) {
    const sample = incomplete.slice(0, 3).map((artifact) => `${artifact.kind} ${artifactLabel(artifact)}: ${artifact.error ?? artifact.status}`);
    throw new Error(
      `Migration data capture incomplete: ${incomplete.length} required data artifact(s) did not complete (${sample.join("; ")}). ` +
      "No target deployment was accepted; retry after checking source paths, permissions, and backup storage."
    );
  }
}

function validateMigrationDataRestore(point: RecoveryPointDetail, restore: RestoreResult) {
  const artifacts = dataArtifacts(point);
  const expectedVolumes = artifacts.filter((artifact) => artifact.kind === "volume").length;
  const expectedBindMounts = artifacts.filter((artifact) => artifact.kind === "host_folder").length;
  if (restore.restoredVolumes < expectedVolumes || restore.restoredBindMounts < expectedBindMounts) {
    throw new Error(
      `Migration data restore incomplete: expected ${expectedVolumes} Docker volume(s) and ${expectedBindMounts} host folder(s), ` +
      `restored ${restore.restoredVolumes} volume(s) and ${restore.restoredBindMounts} host folder(s). ` +
      "The target deployment was not accepted because required data did not restore."
    );
  }
}

async function inspectSourceContainers(hostId: string, containerIds: string[]) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return containerIds.map((id) => ({
      id,
      inspect: {
        Name: `/${id}`,
        State: { Running: true, Status: "running" }
      }
    }));
  }
  const inspects = [];
  for (const containerId of containerIds) {
    const result = await runSshCommand(
      host.ssh,
      withDockerEnv(`docker inspect ${shQuote(containerId)}`, host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
    if (result.code !== 0) continue;
    const [inspect] = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    if (inspect) inspects.push({ id: containerId, inspect });
  }
  return inspects;
}

async function startSourceContainers(hostId: string, containerIds: string[]) {
  if (!containerIds.length) return;
  await startContainersOneByOne(hostId, containerIds);
}

type VerificationResult = {
  ok: boolean;
  error?: string;
  demo?: boolean;
};

function parseInspectArray(stdout: string) {
  return JSON.parse(stdout) as Array<Record<string, unknown>>;
}

async function verifyComposeDeployment(targetHostId: string, projectName: string, restore: RestoreResult): Promise<VerificationResult> {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) return { ok: true, demo: true };
  const command = withDockerEnv(
    `docker compose -p ${shQuote(projectName)} ps --format json`,
    host.public.dockerSocketPath
  );
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    return { ok: false, error: result.stderr || result.stdout || "Target verification failed" };
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: "No containers found for restored project" };
  const running = lines.some((line) => {
    try {
      const row = JSON.parse(line) as { State?: string };
      return String(row.State ?? "").toLowerCase().includes("running");
    } catch {
      return line.toLowerCase().includes("running");
    }
  });
  if (!running) return { ok: false, error: "Restored containers are not running" };

  const expectedVolumes = Array.from(new Set(Object.values(restore.volumeMap).filter(Boolean)));
  if (!expectedVolumes.length) return { ok: true };

  const idsResult = await runSshCommand(
    host.ssh,
    withDockerEnv(`docker compose -p ${shQuote(projectName)} ps -q`, host.public.dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  if (idsResult.code !== 0) {
    return { ok: false, error: idsResult.stderr || idsResult.stdout || "Could not list restored compose containers" };
  }
  const containerIds = idsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!containerIds.length) return { ok: false, error: "No container IDs found for restored project" };

  const inspectResult = await runSshCommand(
    host.ssh,
    withDockerEnv(`docker inspect ${containerIds.map(shQuote).join(" ")}`, host.public.dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  if (inspectResult.code !== 0) {
    return { ok: false, error: inspectResult.stderr || inspectResult.stdout || "Could not inspect restored compose containers" };
  }

  try {
    const mountedVolumes = new Set<string>();
    for (const inspect of parseInspectArray(inspectResult.stdout)) {
      const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts as Array<Record<string, unknown>> : [];
      for (const mount of mounts) {
        if (mount.Type === "volume" && mount.Name) mountedVolumes.add(String(mount.Name));
      }
    }
    const missing = expectedVolumes.filter((volume) => !mountedVolumes.has(volume));
    if (missing.length) {
      return {
        ok: false,
        error: `Restored compose containers are not using restored volume(s): ${missing.join(", ")}`
      };
    }
  } catch {
    return { ok: false, error: "Could not parse restored compose container mounts" };
  }

  return { ok: true };
}

function inspectResultIsRunning(stdout: string) {
  const [inspect] = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const state = inspect?.State as Record<string, unknown> | undefined;
  return Boolean(state?.Running) || String(state?.Status ?? "").toLowerCase() === "running";
}

async function verifyStandaloneDeployment(input: {
  targetHostId: string;
  restoredContainerNames: string[];
  expectedRunningContainerNames: string[];
  sourceHadRunningContainers: boolean;
}): Promise<VerificationResult> {
  const host = await getHostForWorker(input.targetHostId);
  if (isDemoHost(host.public)) return { ok: true, demo: true };

  const restoredNames = Array.from(new Set(input.restoredContainerNames.filter(Boolean)));
  if (!restoredNames.length) {
    return { ok: false, error: "No standalone containers were restored" };
  }

  const expectedRunning = new Set(input.expectedRunningContainerNames.filter((name) => restoredNames.includes(name)));
  if (input.sourceHadRunningContainers && expectedRunning.size === 0) {
    return { ok: false, error: "No expected running standalone containers were restored" };
  }

  let expectedRunningFound = false;
  for (const containerName of restoredNames) {
    const result = await runSshCommand(
      host.ssh,
      withDockerEnv(`docker inspect ${shQuote(containerName)}`, host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
    if (result.code !== 0) {
      return {
        ok: false,
        error: result.stderr || result.stdout || `Restored container ${containerName} was not found`
      };
    }

    try {
      if (expectedRunning.has(containerName) && inspectResultIsRunning(result.stdout)) {
        expectedRunningFound = true;
      }
    } catch {
      return { ok: false, error: `Could not parse restored container state for ${containerName}` };
    }
  }

  if (expectedRunning.size > 0 && !expectedRunningFound) {
    return { ok: false, error: "Expected running standalone containers are not running" };
  }

  return { ok: true };
}

function expectedRunningRestoreNames(restore: RestoreResult, runningStates: ContainerRunningState[]) {
  if (!restore.projectName) return [];
  return runningStates
    .filter((state) => state.running)
    .map((state) => buildCloneContainerName(state.name, restore.projectName!));
}

async function verifyTargetDeployment(input: {
  targetHostId: string;
  restore: RestoreResult;
  runningStates: ContainerRunningState[];
  sourceHadRunningContainers: boolean;
}) {
  if (input.restore.composeRestored) {
    if (!input.restore.projectName) {
      return { ok: false, error: "Migration restore did not produce a target project name" };
    }
    return verifyComposeDeployment(input.targetHostId, input.restore.projectName, input.restore);
  }

  return verifyStandaloneDeployment({
    targetHostId: input.targetHostId,
    restoredContainerNames: input.restore.restoredContainerNames,
    expectedRunningContainerNames: expectedRunningRestoreNames(input.restore, input.runningStates),
    sourceHadRunningContainers: input.sourceHadRunningContainers
  });
}

type InventoryConfirmation = {
  synced: boolean;
  attempts: number;
  detectedProjectName: string | null;
  detectedContainerNames: string[];
  error: string | null;
};

async function findTargetInventoryMatch(targetHostId: string, restore: RestoreResult) {
  const result = await query<any>(
    "SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = 'container'",
    [targetHostId]
  );
  const rows = result.rows as Array<{ external_id: string; name: string; data: Record<string, unknown> }>;
  if (restore.composeRestored && restore.projectName) {
    const matched = rows.filter((row) => parseContainerLabels(row.data?.Labels)["com.docker.compose.project"] === restore.projectName);
    return {
      ok: matched.length > 0,
      detectedProjectName: matched.length > 0 ? restore.projectName : null,
      detectedContainerNames: matched.map((row) => String(row.data?.Names ?? row.name))
    };
  }

  const expected = new Set(restore.restoredContainerNames.filter(Boolean));
  if (!expected.size) {
    return { ok: false, detectedProjectName: null, detectedContainerNames: [] };
  }
  const matched = rows.filter((row) => {
    const names = [row.name, row.external_id, String(row.data?.Names ?? "")];
    return names.some((name) => expected.has(name));
  });
  return {
    ok: matched.length >= expected.size,
    detectedProjectName: null,
    detectedContainerNames: matched.map((row) => String(row.data?.Names ?? row.name))
  };
}

async function confirmTargetInventoryVisible(targetHostId: string, restore: RestoreResult, config: ExecuteConfig): Promise<InventoryConfirmation> {
  const attempts = config.inventoryPollAttempts ?? 12;
  const delayMs = config.inventoryPollDelayMs ?? 2_000;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await reportProgress(config, "verify", `Syncing target inventory (${attempt}/${attempts})`);
    try {
      await syncDockerInventory(targetHostId);
      const match = await findTargetInventoryMatch(targetHostId, restore);
      if (match.ok) {
        await checkImageUpdatesForHost(targetHostId).catch(() => undefined);
        return {
          synced: true,
          attempts: attempt,
          detectedProjectName: match.detectedProjectName,
          detectedContainerNames: match.detectedContainerNames,
          error: null
        };
      }
      lastError = restore.composeRestored && restore.projectName
        ? `project ${restore.projectName} was not visible in inventory`
        : `restored container(s) ${restore.restoredContainerNames.join(", ")} were not visible in inventory`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  return {
    synced: false,
    attempts,
    detectedProjectName: null,
    detectedContainerNames: [],
    error: lastError
  };
}

async function cleanupStandaloneRestoreContainers(targetHostId: string, containerNames: string[]) {
  const uniqueNames = Array.from(new Set(containerNames.filter(Boolean)));
  if (!uniqueNames.length) return;

  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) return;

  const failures: string[] = [];
  for (const containerName of uniqueNames) {
    const result = await runSshCommand(
      host.ssh,
      withDockerEnv(`docker rm --force ${shQuote(containerName)}`, host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
    if (result.code !== 0) {
      failures.push(`${containerName}: ${result.stderr || result.stdout || "remove failed"}`);
    }
  }

  if (failures.length) {
    throw new Error(`Failed to clean up restored standalone containers: ${failures.join("; ")}`);
  }
}

async function rollbackSource(input: {
  migrationRunId: string;
  sourceHostId: string;
  containerIds: string[];
  strategy: MigrationStrategy;
  sourceWasStopped: boolean;
  sourceHadRunningContainers: boolean;
  reason: string;
}) {
  if (!shouldRestartSourceAfterFailure({
    strategy: input.strategy,
    sourceWasStopped: input.sourceWasStopped,
    sourceHadRunningContainers: input.sourceHadRunningContainers
  })) {
    return { restarted: false };
  }

  await startSourceContainers(input.sourceHostId, input.containerIds);
  await writeAuditEvent({
    hostId: input.sourceHostId,
    action: "migration.rollback",
    targetKind: "migration_run",
    targetId: input.migrationRunId,
    details: { reason: input.reason, restartedSource: true }
  });
  return { restarted: true };
}

export async function runMigrationExecute(
  sourceHostId: string,
  migrationRunId: string,
  config: ExecuteConfig = { strategy: "clone", stopSource: false, remapPorts: true, networkMode: "clone" }
) {
  const run = await getMigrationRun(migrationRunId);
  if (!run || run.sourceHostId !== sourceHostId) throw new Error("Migration run not found");

  await query(
    "UPDATE migration_runs SET status = 'running', started_at = now(), error = null WHERE id = $1",
    [migrationRunId]
  );

  await reportProgress(config, "plan", "Resolving source app and inspecting source containers");
  const context = await resolveAppContext(run.sourceHostId, run.sourceAppIdentity);
  const inspects = await inspectSourceContainers(run.sourceHostId, context.containerIds);
  const runningStates = recordRunningStates(inspects);
  const sourceHadRunningContainers = wasAnyContainerRunning(runningStates);
  let sourceWasStopped = false;
  const restartIds = containersToRestart(runningStates);

  try {
    let recoveryPointId = run.recoveryPointId;
    const recoveryCenter = await import("./recoveryCenter.js");

    if (recoveryPointId && (config.strategy === "safe_move" || config.strategy === "warm_move")) {
      await reportProgress(config, "capture", "Creating final stop-first recovery point from supplied pre-copy");
      assertMigrationRecoveryPointReady(
        await recoveryCenter.getRecoveryPoint(recoveryPointId),
        run.sourceHostId
      );
      const finalPoint = await recoveryCenter.createRecoveryPoint({
        hostId: run.sourceHostId,
        appIdentity: run.sourceAppIdentity,
        triggerKind: "pre_migration",
        name: `Migration final ${migrationRunId}`,
        stopFirst: true
      });
      recoveryPointId = finalPoint.id;
      await query("UPDATE migration_runs SET recovery_point_id = $2 WHERE id = $1", [migrationRunId, recoveryPointId]);
      const capture = await runRecoveryCreate(run.sourceHostId, recoveryPointId, {
        stopFirst: true,
        restartAfterStopFirst: false
      }) as CaptureResult;
      sourceWasStopped = Boolean(capture.sourceLeftStopped);
    } else if (config.strategy === "warm_move" && !recoveryPointId) {
      await reportProgress(config, "capture", "Creating warm pre-copy recovery point while source keeps running");
      const prePoint = await recoveryCenter.createRecoveryPoint({
        hostId: run.sourceHostId,
        appIdentity: run.sourceAppIdentity,
        triggerKind: "pre_migration",
        name: `Migration pre-copy ${migrationRunId}`,
        stopFirst: false
      });
      await runRecoveryCreate(run.sourceHostId, prePoint.id, { stopFirst: false });
      const finalPoint = await recoveryCenter.createRecoveryPoint({
        hostId: run.sourceHostId,
        appIdentity: run.sourceAppIdentity,
        triggerKind: "pre_migration",
        name: `Migration final ${migrationRunId}`,
        stopFirst: true
      });
      recoveryPointId = finalPoint.id;
      await query("UPDATE migration_runs SET recovery_point_id = $2 WHERE id = $1", [migrationRunId, recoveryPointId]);
      await reportProgress(config, "capture", "Stopping source containers for final migration capture");
      const capture = await runRecoveryCreate(run.sourceHostId, recoveryPointId, {
        stopFirst: true,
        restartAfterStopFirst: false
      }) as CaptureResult;
      sourceWasStopped = Boolean(capture.sourceLeftStopped);
    } else if (config.strategy === "safe_move" && !recoveryPointId) {
      await reportProgress(config, "capture", "Creating stop-first recovery point for safe move");
      const finalPoint = await recoveryCenter.createRecoveryPoint({
        hostId: run.sourceHostId,
        appIdentity: run.sourceAppIdentity,
        triggerKind: "pre_migration",
        name: `Migration final ${migrationRunId}`,
        stopFirst: true
      });
      recoveryPointId = finalPoint.id;
      await query("UPDATE migration_runs SET recovery_point_id = $2 WHERE id = $1", [migrationRunId, recoveryPointId]);
      const capture = await runRecoveryCreate(run.sourceHostId, recoveryPointId, {
        stopFirst: true,
        restartAfterStopFirst: false
      }) as CaptureResult;
      sourceWasStopped = Boolean(capture.sourceLeftStopped);
    } else if (!recoveryPointId) {
      await reportProgress(config, "capture", "Creating online recovery point for clone migration");
      const created = await recoveryCenter.createRecoveryPoint({
        hostId: run.sourceHostId,
        appIdentity: run.sourceAppIdentity,
        triggerKind: "pre_migration",
        name: `Migration ${migrationRunId}`,
        stopFirst: false
      });
      recoveryPointId = created.id;
      await query("UPDATE migration_runs SET recovery_point_id = $2 WHERE id = $1", [migrationRunId, recoveryPointId]);
      await runRecoveryCreate(run.sourceHostId, recoveryPointId, {
        stopFirst: false
      });
    }

    const point = await recoveryCenter.getRecoveryPoint(recoveryPointId);
    assertMigrationRecoveryPointReady(point, run.sourceHostId);
    await reportProgress(
      config,
      "transfer",
      `Recovery point ready: ${point.completedArtifactCount}/${point.artifactCount} artifact(s) completed; validating data artifacts before target restore`
    );
    assertMigrationDataCaptureComplete(point);

    const restoreMode = config.strategy === "clone" ? "clone" : "clone";
    const restore = await runRecoveryRestore(run.targetHostId, {
      recoveryPointId,
      targetHostId: run.targetHostId,
      options: {
        mode: restoreMode,
        stopExisting: false,
        projectNameOverride: config.projectNameOverride,
        remapPorts: config.remapPorts,
        networkMode: config.networkMode ?? "clone"
      }
    });

    validateMigrationDataRestore(point, restore);
    await reportProgress(
      config,
      "deploy",
      `Restored ${restore.restoredVolumes} Docker volume(s) and ${restore.restoredBindMounts} host folder(s); checking target deployment`
    );

    if (!restore.projectName) {
      throw new Error("Migration restore did not produce a target project name");
    }

    const verification = await verifyTargetDeployment({
      targetHostId: run.targetHostId,
      restore,
      runningStates,
      sourceHadRunningContainers
    });
    if (!verification.ok) {
      let cleanupError: string | null = null;
      if (!restore.composeRestored) {
        try {
          await cleanupStandaloneRestoreContainers(run.targetHostId, restore.restoredContainerNames);
        } catch (error) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
      }

      throw new Error(
        `${verification.error ?? "Target verification failed"}${cleanupError ? `; cleanup failed: ${cleanupError}` : ""}`
      );
    }

    await reportProgress(config, "verify", "Target containers verified; syncing target inventory");
    const inventory = await confirmTargetInventoryVisible(run.targetHostId, restore, config);
    if (!inventory.synced) {
      throw new Error(
        `Target deployed, but inventory did not sync before completion: ${inventory.error ?? "target containers were not visible"}. ` +
        "Refresh or retry host sync after confirming the target host is reachable."
      );
    }

    await reportProgress(config, "verify", "Target inventory confirmed and image status refreshed");

    if (config.strategy === "safe_move" || config.strategy === "warm_move") {
      // Source is intentionally left stopped after a successful move.
    }

    await query(
      "UPDATE migration_runs SET status = 'completed', completed_at = now() WHERE id = $1",
      [migrationRunId]
    );

    return {
      migrationRunId,
      recoveryPointId,
      strategy: config.strategy,
      restore,
      inventory,
      sourceLeftStopped: config.strategy !== "clone" && sourceWasStopped
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const captureStoppedIds = (error as { sourceStoppedIds?: string[] }).sourceStoppedIds ?? [];
    if (captureStoppedIds.length) {
      sourceWasStopped = true;
    }
    let finalMessage = message;
    if (sourceWasStopped) {
      try {
        const rollback = await rollbackSource({
          migrationRunId,
          sourceHostId: run.sourceHostId,
          containerIds: captureStoppedIds.length ? captureStoppedIds : restartIds,
          strategy: config.strategy,
          sourceWasStopped,
          sourceHadRunningContainers,
          reason: message
        });
        if (rollback.restarted && !finalMessage.includes("source restarted")) {
          finalMessage = `${finalMessage}; source restarted`;
        }
      } catch (rollbackError) {
        await query(
          "UPDATE migration_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1",
          [migrationRunId, `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`]
        );
        throw rollbackError;
      }
    }
    await query(
      "UPDATE migration_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1",
      [migrationRunId, finalMessage]
    );
    if (finalMessage !== message) {
      throw new Error(finalMessage);
    }
    throw error;
  }
}
