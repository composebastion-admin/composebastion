import path from "node:path";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import type { RecoveryPointDetail } from "@composebastion/shared";
import type { RecoveryProfile } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { loadWorkerBackupTarget } from "./recoveryBackupTargets.js";
import { shQuote, withDockerEnv } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { runDocker } from "./docker.js";
import { getHostForWorker } from "./hosts.js";
import { mapRecoveryArtifact, mapRecoveryPoint } from "./mappers.js";
import { isComposeApp, resolveAppContext } from "./recoveryAppContext.js";
import {
  bindMountArtifactName,
  buildContainerManifest,
  buildNetworkManifest,
  buildRecoveryManifest,
  composeWorkingDirHostFolder,
  containersToRestart,
  isHostPathInside,
  recordRunningStates,
  sanitizeArtifactName,
  wasAnyContainerRunning
} from "./recoveryManifest.js";
import {
  startContainersOneByOne,
  stopContainersWithRestartOnFailure
} from "./recoveryContainerControl.js";
import { buildBindMountCaptureCommand } from "./recoveryRestoreUtils.js";
import { enforceScheduledRecoveryRetention } from "./recoveryRetention.js";
import {
  artifactRelativePath,
  hashFile,
  safeRecoveryPointFile,
  writeRecoveryPointFile
} from "./recoveryStorage.js";
import {
  resolveRecoveryPointStatus
} from "./recoveryS3.js";
import { headRemoteArtifact, uploadRemoteArtifact } from "./recoveryRemoteStorage.js";
import { ensureRecoveryArtifactLocalPath, readRecoveryArtifact } from "./recoveryArtifactStore.js";
import { getRecoveryProfile } from "./recoveryProfiles.js";
import { runSshCommand, streamSshCommandToFile } from "./ssh.js";
import type { JobExecutionFence } from "./jobs.js";

type InspectRow = { id: string; inspect: Record<string, unknown> };

const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);

async function executionQuery(fence: JobExecutionFence | undefined, text: string, values: unknown[]) {
  if (!fence) return query(text, values);
  return fence.withActiveLease((client) => client.query(text, values));
}

async function findResource(hostId: string, kind: string, externalId: string) {
  const result = await query<any>(
    `SELECT data FROM resource_snapshots WHERE host_id = $1 AND kind = $2 AND external_id = $3`,
    [hostId, kind, externalId]
  );
  return result.rows[0] ?? null;
}

async function inspectContainer(hostId: string, containerId: string): Promise<Record<string, unknown>> {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const row = await findResource(hostId, "container", containerId);
    if (!row) throw new Error(`Demo container not found: ${containerId}`);
    const data = row.data ?? {};
    return {
      Id: containerId,
      Name: String(data.Names ?? containerId),
      State: { Running: String(data.State ?? "").toLowerCase().includes("running"), Status: String(data.State ?? "running") },
      Config: { Image: String(data.Image ?? "demo:latest"), Env: [], Labels: data.Labels ?? {} },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" }, PortBindings: {} },
      NetworkSettings: { Ports: data.Ports ? { "80/tcp": [{ HostPort: "8080" }] } : {}, Networks: { bridge: {} } },
      Mounts: data.Mounts ?? []
    };
  }
  const result = await runDocker(hostId, `docker inspect ${shQuote(containerId)}`, 60_000);
  const [inspect] = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
  if (!inspect) throw new Error(`Container not found: ${containerId}`);
  return inspect;
}

async function getDockerVersions(hostId: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return { serverVersion: host.public.dockerVersion, composeVersion: host.public.composeVersion };
  }
  try {
    const version = await runDocker(hostId, "docker version --format '{{.Server.Version}}'", 30_000);
    const compose = await runDocker(hostId, "docker compose version --short", 30_000);
    return { serverVersion: version.stdout.trim(), composeVersion: compose.stdout.trim() };
  } catch {
    return { serverVersion: host.public.dockerVersion, composeVersion: host.public.composeVersion };
  }
}

async function updateArtifactStatus(
  artifactId: string,
  status: string,
  fields: { sizeBytes?: number | null; checksum?: string | null; error?: string | null } = {},
  executionFence?: JobExecutionFence
) {
  await executionQuery(
    executionFence,
    `UPDATE recovery_artifacts
     SET status = $2,
         size_bytes = COALESCE($3, size_bytes),
         checksum = COALESCE($4, checksum),
         error = $5,
         completed_at = CASE WHEN $2 IN ('completed', 'partial', 'failed') THEN now() ELSE completed_at END
     WHERE id = $1`,
    [artifactId, status, fields.sizeBytes ?? null, fields.checksum ?? null, fields.error ?? null]
  );
}

async function insertArtifact(
  recoveryPointId: string,
  kind: string,
  storageKey: string,
  metadata: Record<string, unknown>,
  executionFence?: JobExecutionFence
) {
  const id = uuid();
  const insert = async (client: { query: typeof query }) => {
    await client.query(
      `INSERT INTO recovery_artifacts
        (id, recovery_point_id, kind, backup_target_id, storage_key, status, metadata)
       VALUES ($1, $2, $3, NULL, $4, 'queued', $5)`,
      [id, recoveryPointId, kind, storageKey, metadata]
    );
    await client.query(
      `UPDATE recovery_points
       SET artifact_count = artifact_count + 1
       WHERE id = $1`,
      [recoveryPointId]
    );
  };
  if (executionFence) await executionFence.withActiveLease(insert);
  else await withTransaction(insert);
  return id;
}

async function loadRecoveryPoint(recoveryPointId: string): Promise<RecoveryPointDetail | null> {
  const result = await query("SELECT * FROM recovery_points WHERE id = $1", [recoveryPointId]);
  if (!result.rows[0]) return null;
  const artifacts = await query(
    "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
    [recoveryPointId]
  );
  return {
    ...mapRecoveryPoint(result.rows[0]),
    artifacts: artifacts.rows.map(mapRecoveryArtifact)
  };
}

async function finalizeRecoveryPoint(recoveryPointId: string, remoteUploadFailures = 0, executionFence?: JobExecutionFence) {
  await executionFence?.assertActive();
  const artifacts = await query<any>(
    "SELECT status FROM recovery_artifacts WHERE recovery_point_id = $1",
    [recoveryPointId]
  );
  const statuses = artifacts.rows.map((row: any) => row.status);
  const localCompleted = statuses.filter((status: string) => status === "completed").length;
  const localFailed = statuses.filter((status: string) => status === "failed").length;
  const totalBytes = await query<any>(
    "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM recovery_artifacts WHERE recovery_point_id = $1",
    [recoveryPointId]
  );

  const resolved = resolveRecoveryPointStatus({ localCompleted, localFailed, remoteUploadFailures });

  await executionQuery(
    executionFence,
    `UPDATE recovery_points
     SET status = $2,
         completed_artifact_count = $3,
         total_bytes = $4,
         error = $5,
         completed_at = now()
     WHERE id = $1`,
    [recoveryPointId, resolved.status, localCompleted, Number(totalBytes.rows[0]?.total ?? 0), resolved.error]
  );
}

async function uploadRecoveryArtifactsToRemote(recoveryPointId: string, backupTargetId: string, executionFence?: JobExecutionFence) {
  const target = await loadWorkerBackupTarget(backupTargetId);
  if ((target.kind !== "s3" && target.kind !== "rclone") || !target.enabled) return 0;

  const point = await loadRecoveryPoint(recoveryPointId);
  if (!point) return 0;

  let failures = 0;

  for (const artifact of point.artifacts) {
    if (artifact.status !== "completed") continue;
    const localPath = safeRecoveryPointFile(recoveryPointId, artifact.storageKey);
    try {
      await executionFence?.assertActive();
      const uploaded = await uploadRemoteArtifact({
        target,
        namespaceId: recoveryPointId,
        storageKey: artifact.storageKey,
        localPath,
        checksum: artifact.checksum
      });
      if (!uploaded) continue;
      await executionQuery(
        executionFence,
        `UPDATE recovery_artifacts
         SET backup_target_id = $2,
             metadata = metadata || $3::jsonb
         WHERE id = $1`,
        [
          artifact.id,
          backupTargetId,
          JSON.stringify({
            remoteObjectKey: uploaded.remoteObjectKey,
            remoteBackend: uploaded.remoteBackend,
            remoteSizeBytes: uploaded.remoteSizeBytes,
            remoteEtag: uploaded.remoteEtag,
            localCachePolicy: target.localCachePolicy
          })
        ]
      );
      if (target.localCachePolicy === "remote_only") {
        await rm(localPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      failures += 1;
      await executionQuery(
        executionFence,
        `UPDATE recovery_artifacts
         SET metadata = metadata || $2::jsonb
         WHERE id = $1`,
        [
          artifact.id,
          JSON.stringify({
            remoteUploadError: error instanceof Error ? error.message : String(error)
          })
        ]
      );
    }
  }

  return failures;
}

async function captureNamedVolume(
  hostId: string,
  recoveryPointId: string,
  artifactId: string,
  storageKey: string,
  volumeName: string,
  executionFence?: JobExecutionFence
) {
  await executionFence?.assertActive();
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const written = await writeRecoveryPointFile(
      recoveryPointId,
      storageKey,
      `ComposeBastion demo recovery volume for ${volumeName}\n`
    );
    await updateArtifactStatus(artifactId, "completed", written, executionFence);
    return written;
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery volume capture requires SSH host mode.");
  }
  const targetPath = safeRecoveryPointFile(recoveryPointId, storageKey);
  const command = withDockerEnv(
    `docker run --rm -v ${shQuote(`${volumeName}:/volume:ro`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar czf - .")}`,
    host.public.dockerSocketPath
  );
  const result = await streamSshCommandToFile(host.ssh, command, targetPath);
  const checksum = await hashFile(targetPath);
  await updateArtifactStatus(artifactId, "completed", { sizeBytes: result.sizeBytes, checksum }, executionFence);
  return { sizeBytes: result.sizeBytes, checksum };
}

async function captureBindMount(
  hostId: string,
  recoveryPointId: string,
  artifactId: string,
  storageKey: string,
  sourcePath: string,
  excludePatterns: string[] = [],
  executionFence?: JobExecutionFence
) {
  await executionFence?.assertActive();
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const written = await writeRecoveryPointFile(
      recoveryPointId,
      storageKey,
      `ComposeBastion demo bind mount backup for ${sourcePath}\n`
    );
    await updateArtifactStatus(artifactId, "completed", written, executionFence);
    return written;
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery bind mount capture requires SSH host mode.");
  }
  const normalized = path.posix.normalize(sourcePath);
  const targetPath = safeRecoveryPointFile(recoveryPointId, storageKey);
  const command = buildBindMountCaptureCommand(normalized, excludePatterns);
  const result = await streamSshCommandToFile(host.ssh, command, targetPath);
  const checksum = await hashFile(targetPath);
  await updateArtifactStatus(artifactId, "completed", { sizeBytes: result.sizeBytes, checksum }, executionFence);
  return { sizeBytes: result.sizeBytes, checksum };
}

async function ensurePlannedArtifacts(
  point: RecoveryPointDetail,
  inspects: InspectRow[],
  context: Awaited<ReturnType<typeof resolveAppContext>>,
  profile: RecoveryProfile | null,
  executionFence?: JobExecutionFence
) {
  const existingVolumes = new Set(
    point.artifacts.filter((artifact) => artifact.kind === "volume").map((artifact) => String(artifact.metadata.volumeName ?? ""))
  );
  const existingBinds = new Set(
    point.artifacts.filter((artifact) => artifact.kind === "host_folder").map((artifact) => String(artifact.metadata.sourcePath ?? ""))
  );
  const composeFolder = composeWorkingDirHostFolder(context.workingDir);
  const excludePatterns = profile?.excludePatterns ?? [];

  if (composeFolder && !existingBinds.has(composeFolder.source)) {
    const storageKey = artifactRelativePath("host_folder", bindMountArtifactName(composeFolder.source));
    await insertArtifact(point.id, "host_folder", storageKey, {
      sourcePath: composeFolder.source,
      destination: composeFolder.destination,
      readOnly: composeFolder.readOnly,
      role: composeFolder.role,
      restorePath: composeFolder.restorePath,
      excludePatterns
    }, executionFence);
    existingBinds.add(composeFolder.source);
  }

  for (const { inspect } of inspects) {
    const manifest = buildContainerManifest(inspect);
    for (const volume of manifest.volumes) {
      if (existingVolumes.has(volume.name)) continue;
      const storageKey = artifactRelativePath("volume", sanitizeArtifactName(volume.name));
      await insertArtifact(point.id, "volume", storageKey, { volumeName: volume.name, destination: volume.destination }, executionFence);
      existingVolumes.add(volume.name);
    }
    for (const bind of manifest.bindMounts) {
      if (composeFolder && isHostPathInside(composeFolder.source, bind.source)) continue;
      if (existingBinds.has(bind.source)) continue;
      const storageKey = artifactRelativePath("host_folder", bindMountArtifactName(bind.source));
      await insertArtifact(point.id, "host_folder", storageKey, {
        sourcePath: bind.source,
        destination: bind.destination,
        readOnly: bind.readOnly,
        excludePatterns
      }, executionFence);
      existingBinds.add(bind.source);
    }
  }

  const extraIncludePaths = Array.isArray(point.metadata.extraIncludePaths)
    ? point.metadata.extraIncludePaths.map(String)
    : [];
  for (const includePath of Array.from(new Set([...(profile?.includePaths ?? []), ...extraIncludePaths]))) {
    if (existingBinds.has(includePath)) continue;
    const storageKey = artifactRelativePath("host_folder", bindMountArtifactName(includePath));
    await insertArtifact(point.id, "host_folder", storageKey, {
      sourcePath: includePath,
      destination: "",
      readOnly: false,
      role: "manual_include",
      restorePath: profile?.restorePaths[includePath] ?? null,
      excludePatterns
    }, executionFence);
    existingBinds.add(includePath);
  }

  if (context.composeYaml && !point.artifacts.some((artifact) => artifact.kind === "compose_yaml")) {
    await insertArtifact(point.id, "compose_yaml", "compose.yml", { projectName: context.projectName }, executionFence);
  }
  if (context.env && !point.artifacts.some((artifact) => artifact.kind === "env_file")) {
    await insertArtifact(point.id, "env_file", ".env", { projectName: context.projectName }, executionFence);
  }
}

async function loadPointProfile(point: RecoveryPointDetail) {
  const profileId = typeof point.metadata.profileId === "string"
    ? point.metadata.profileId
    : point.profileId ?? null;
  return profileId ? getRecoveryProfile(profileId) : null;
}

async function runProfileHook(hostId: string, profile: RecoveryProfile | null, phase: "pre" | "post") {
  const command = phase === "pre" ? profile?.preCaptureCommand : profile?.postCaptureCommand;
  if (!command?.trim()) return null;
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return { demo: true };
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery profile capture hooks require SSH host mode.");
  }
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 5 * 60_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Recovery ${phase}-capture hook failed`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function inspectRecoveryNetwork(hostId: string, networkName: string) {
  const snapshot = await findResource(hostId, "network", networkName);
  if (snapshot?.data && typeof snapshot.data === "object") {
    return buildNetworkManifest(snapshot.data as Record<string, unknown>, networkName);
  }
  try {
    const result = await runDocker(hostId, `docker network inspect ${shQuote(networkName)}`, 60_000);
    const parsed = JSON.parse(result.stdout || "[]");
    const inspect = Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object"
      ? parsed[0] as Record<string, unknown>
      : { Name: networkName };
    return buildNetworkManifest(inspect, networkName);
  } catch {
    return buildNetworkManifest({ Name: networkName }, networkName);
  }
}

async function collectNetworkManifests(hostId: string, containers: ReturnType<typeof buildContainerManifest>[]) {
  const names = Array.from(new Set(
    containers.flatMap((container) => container.networks).filter((name) => name && !BUILTIN_NETWORKS.has(name))
  ));
  const networks = [];
  for (const name of names) networks.push(await inspectRecoveryNetwork(hostId, name));
  return networks;
}

export async function runRecoveryCreate(
  hostId: string,
  recoveryPointId: string,
  options: { stopFirst?: boolean; restartAfterStopFirst?: boolean; executionFence?: JobExecutionFence } = {}
) {
  const executionFence = options.executionFence;
  await executionFence?.assertActive();
  const point = await loadRecoveryPoint(recoveryPointId);
  if (!point || point.hostId !== hostId) throw new Error("Recovery point not found");

  const stopFirst = options.stopFirst
    ?? Boolean((point.metadata as Record<string, unknown>).stopFirst);
  const restartAfterStopFirst = options.restartAfterStopFirst ?? true;

  await executionQuery(
    executionFence,
    `UPDATE recovery_points
     SET status = 'running', started_at = now(), error = null,
         metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [recoveryPointId, JSON.stringify({
      captureMode: stopFirst ? "stop-first" : "online",
      restartAfterStopFirst
    })]
  );

  const context = await resolveAppContext(point.hostId, point.appIdentity);
  const profile = await loadPointProfile(point);
  const containerIds = context.containerIds.length
    ? context.containerIds
    : point.appIdentity.kind === "standalone"
      ? point.appIdentity.containerIds
      : [];

  if (!containerIds.length && !isComposeApp(point.appIdentity)) {
    throw new Error("No containers found for recovery point");
  }

  const inspects: InspectRow[] = [];
  for (const containerId of containerIds) {
    inspects.push({ id: containerId, inspect: await inspectContainer(hostId, containerId) });
  }

  const runningStates = recordRunningStates(inspects);
  const shouldStopFirst = stopFirst && wasAnyContainerRunning(runningStates);
  let stoppedForBackup = false;

  try {
    if (shouldStopFirst) {
      await executionFence?.assertActive();
      await stopContainersWithRestartOnFailure(
        hostId,
        containerIds,
        containersToRestart(runningStates)
      );
      stoppedForBackup = true;
    }

    await executionFence?.assertActive();
    const preHookResult = await runProfileHook(hostId, profile, "pre");
    if (preHookResult) {
      await executionQuery(
        executionFence,
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1`,
        [recoveryPointId, JSON.stringify({ preCaptureHook: preHookResult })]
      );
    }

    await ensurePlannedArtifacts(point, inspects, context, profile, executionFence);
    const refreshed = await loadRecoveryPoint(recoveryPointId);
    if (!refreshed) throw new Error("Recovery point not found after planning artifacts");

    const artifactManifest: Array<{ kind: string; storageKey: string; metadata: Record<string, unknown> }> = [];

    for (const artifact of refreshed.artifacts) {
      if (artifact.kind === "metadata") continue;
      artifactManifest.push({ kind: artifact.kind, storageKey: artifact.storageKey, metadata: artifact.metadata });
    }

    for (const artifact of refreshed.artifacts) {
      try {
        await executionFence?.assertActive();
        if (artifact.kind === "compose_yaml") {
          if (!context.composeYaml) {
            await updateArtifactStatus(artifact.id, "failed", { error: "Compose YAML unavailable" }, executionFence);
            continue;
          }
          const written = await writeRecoveryPointFile(recoveryPointId, artifact.storageKey, context.composeYaml);
          await updateArtifactStatus(artifact.id, "completed", written, executionFence);
          continue;
        }
        if (artifact.kind === "env_file") {
          const written = await writeRecoveryPointFile(recoveryPointId, artifact.storageKey, context.env ?? "");
          await updateArtifactStatus(artifact.id, "completed", written, executionFence);
          continue;
        }
        if (artifact.kind === "volume") {
          const volumeName = String(artifact.metadata.volumeName ?? "");
          if (!volumeName) {
            await updateArtifactStatus(artifact.id, "failed", { error: "Missing volume name metadata" }, executionFence);
            continue;
          }
          await updateArtifactStatus(artifact.id, "running", {}, executionFence);
          await captureNamedVolume(hostId, recoveryPointId, artifact.id, artifact.storageKey, volumeName, executionFence);
          continue;
        }
        if (artifact.kind === "host_folder") {
          const sourcePath = String(artifact.metadata.sourcePath ?? "");
          if (!sourcePath) {
            await updateArtifactStatus(artifact.id, "failed", { error: "Missing bind mount source path" }, executionFence);
            continue;
          }
          await updateArtifactStatus(artifact.id, "running", {}, executionFence);
          const excludePatterns = Array.isArray(artifact.metadata.excludePatterns)
            ? artifact.metadata.excludePatterns.map(String)
            : [];
          await captureBindMount(hostId, recoveryPointId, artifact.id, artifact.storageKey, sourcePath, excludePatterns, executionFence);
          continue;
        }
        await updateArtifactStatus(artifact.id, "failed", { error: `Unsupported artifact kind: ${artifact.kind}` }, executionFence);
      } catch (error) {
        await updateArtifactStatus(artifact.id, "failed", {
          error: error instanceof Error ? error.message : String(error)
        }, executionFence);
      }
    }

    const latest = await loadRecoveryPoint(recoveryPointId);
    const dockerVersions = await getDockerVersions(hostId);
    const containerManifests = inspects.map(({ inspect }) => buildContainerManifest(inspect));
    const networkManifests = await collectNetworkManifests(hostId, containerManifests);
    const manifest = buildRecoveryManifest({
      recoveryPointId,
      hostId: point.hostId,
      appIdentity: point.appIdentity,
      captureMode: stopFirst ? "stop-first" : "online",
      originalRunningState: runningStates,
      docker: dockerVersions,
      compose: {
        projectName: context.projectName,
        stackId: context.stackId,
        workingDir: context.workingDir,
        composePath: context.composePath,
        yaml: context.composeYaml,
        env: context.env
      },
      containers: containerManifests,
      networks: networkManifests,
      artifacts: (latest?.artifacts ?? [])
        .filter((artifact) => artifact.kind !== "metadata")
        .map((artifact) => ({ kind: artifact.kind, storageKey: artifact.storageKey, metadata: artifact.metadata })),
      profile: profile ?? (typeof point.metadata.profileSnapshot === "object" && point.metadata.profileSnapshot ? point.metadata.profileSnapshot as Record<string, unknown> : null)
    });

    await executionFence?.assertActive();
    const postHookResult = await runProfileHook(hostId, profile, "post");
    if (postHookResult) {
      await executionQuery(
        executionFence,
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1`,
        [recoveryPointId, JSON.stringify({ postCaptureHook: postHookResult })]
      );
    }

    const metadataArtifact = latest?.artifacts.find((artifact) => artifact.kind === "metadata");
    const manifestKey = metadataArtifact?.storageKey ?? "manifest.json";
    await executionFence?.assertActive();
    const written = await writeRecoveryPointFile(recoveryPointId, manifestKey, JSON.stringify(manifest, null, 2));
    if (metadataArtifact) {
      await updateArtifactStatus(metadataArtifact.id, "completed", written, executionFence);
    } else {
      await insertArtifact(recoveryPointId, "metadata", manifestKey, { manifestVersion: 1 }, executionFence);
      const created = await query(
        `SELECT id FROM recovery_artifacts
         WHERE recovery_point_id = $1 AND kind = 'metadata'
         ORDER BY created_at DESC LIMIT 1`,
        [recoveryPointId]
      );
      if (created.rows[0]) await updateArtifactStatus(created.rows[0].id, "completed", written, executionFence);
    }

    let remoteUploadFailures = 0;
    if (point.backupTargetId) {
      try {
        remoteUploadFailures = await uploadRecoveryArtifactsToRemote(recoveryPointId, point.backupTargetId, executionFence);
      } catch (error) {
        remoteUploadFailures = 1;
        await executionQuery(
          executionFence,
          `UPDATE recovery_points
           SET metadata = metadata || $2::jsonb
           WHERE id = $1`,
          [
            recoveryPointId,
            JSON.stringify({
              remoteUploadError: error instanceof Error ? error.message : String(error)
            })
          ]
        );
      }
    }

    await finalizeRecoveryPoint(recoveryPointId, remoteUploadFailures, executionFence);
    if (stoppedForBackup && !restartAfterStopFirst) {
      await executionQuery(
        executionFence,
        `UPDATE recovery_points
         SET metadata = metadata || $2::jsonb
         WHERE id = $1`,
        [
          recoveryPointId,
          JSON.stringify({
            sourceLeftStopped: true,
            stoppedContainerIds: containersToRestart(runningStates)
          })
        ]
      );
    }
    const completedPoint = await loadRecoveryPoint(recoveryPointId);
    if (completedPoint && (completedPoint.status === "completed" || completedPoint.status === "partial")) {
      try {
        await executionFence?.assertActive();
        await enforceScheduledRecoveryRetention(completedPoint);
      } catch (retentionError) {
        await query(
          `UPDATE recovery_points
           SET metadata = metadata || $2::jsonb
           WHERE id = $1`,
          [
            recoveryPointId,
            JSON.stringify({
              retentionCleanupError: retentionError instanceof Error ? retentionError.message : String(retentionError)
            })
          ]
        );
      }
    }
    return {
      recoveryPointId,
      status: (await loadRecoveryPoint(recoveryPointId))?.status ?? "completed",
      captureMode: stopFirst ? "stop-first" : "online",
      manifestKey,
      sourceLeftStopped: stoppedForBackup && !restartAfterStopFirst,
      stoppedContainerIds: stoppedForBackup && !restartAfterStopFirst
        ? containersToRestart(runningStates)
        : []
    };
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error));
    const restartFailedIds = (thrown as Error & { restartFailedIds?: string[] }).restartFailedIds ?? [];
    let sourceStoppedIds: string[] = [];
    if (stoppedForBackup && !restartAfterStopFirst) {
      sourceStoppedIds = containersToRestart(runningStates);
    } else if (!restartAfterStopFirst && restartFailedIds.length) {
      sourceStoppedIds = restartFailedIds;
    }
    if (sourceStoppedIds.length) {
      (thrown as Error & { sourceStoppedIds?: string[] }).sourceStoppedIds = sourceStoppedIds;
    }
    try {
      await executionQuery(
        executionFence,
        "UPDATE recovery_points SET status = 'failed', error = $2, completed_at = now() WHERE id = $1",
        [recoveryPointId, thrown.message]
      );
    } catch (failureUpdateError) {
      const updateThrown = failureUpdateError instanceof Error
        ? failureUpdateError
        : new Error(String(failureUpdateError));
      if (sourceStoppedIds.length) {
        (updateThrown as Error & { sourceStoppedIds?: string[] }).sourceStoppedIds = sourceStoppedIds;
      }
      throw updateThrown;
    }
    throw thrown;
  } finally {
    if (stoppedForBackup && restartAfterStopFirst) {
      try {
        await startContainersOneByOne(hostId, containersToRestart(runningStates));
      } catch (restartError) {
        await executionQuery(
          executionFence,
          `UPDATE recovery_points
           SET status = CASE WHEN status IN ('completed', 'partial') THEN 'partial' ELSE status END,
               error = COALESCE(error, '') || $2
           WHERE id = $1`,
          [recoveryPointId, restartError instanceof Error ? ` Restart failed: ${restartError.message}` : " Restart failed"]
        );
      }
    }
  }
}

export async function runRecoveryVerify(hostId: string, recoveryPointId: string, executionFence?: JobExecutionFence) {
  await executionFence?.assertActive();
  const point = await loadRecoveryPoint(recoveryPointId);
  if (!point || point.hostId !== hostId) throw new Error("Recovery point not found");

  const manifestArtifact = point.artifacts.find((artifact) => artifact.kind === "metadata");
  if (!manifestArtifact) throw new Error("Recovery manifest artifact not found");

  const manifestRaw = await readRecoveryArtifact(point, manifestArtifact);
  const manifest = JSON.parse(manifestRaw.toString("utf8")) as { artifacts?: Array<{ storageKey: string }> };
  const failures: string[] = [];

  for (const artifact of point.artifacts) {
    await executionFence?.assertActive();
    if (artifact.status !== "completed") {
      failures.push(`${artifact.kind}:${artifact.storageKey} status=${artifact.status}`);
      continue;
    }
    try {
      const filePath = await ensureRecoveryArtifactLocalPath(point, artifact);
      const checksum = await hashFile(filePath);
      if (artifact.checksum && artifact.checksum !== checksum) {
        failures.push(`${artifact.storageKey} checksum mismatch`);
      }
    } catch (error) {
      failures.push(`${artifact.storageKey} missing (${error instanceof Error ? error.message : String(error)})`);
    }

    if (point.backupTargetId) {
      const remoteKey = artifact.metadata.remoteObjectKey;
      if (typeof remoteKey === "string" && remoteKey) {
        try {
          const target = await loadWorkerBackupTarget(point.backupTargetId);
          if ((target.kind === "s3" && target.s3) || (target.kind === "rclone" && target.rclone)) {
            const head = await headRemoteArtifact(target, remoteKey);
            if (artifact.sizeBytes != null && head.sizeBytes != null && artifact.sizeBytes !== head.sizeBytes) {
              failures.push(`${artifact.storageKey} remote size mismatch`);
            }
            if (artifact.checksum && head.checksum && artifact.checksum !== head.checksum) {
              failures.push(`${artifact.storageKey} remote checksum mismatch`);
            }
          }
        } catch (error) {
          failures.push(`${artifact.storageKey} remote verify failed (${error instanceof Error ? error.message : String(error)})`);
        }
      } else if (artifact.metadata.remoteUploadError) {
        failures.push(`${artifact.storageKey} remote upload failed`);
      }
    }
  }

  const verifyStatus = failures.length ? "failed" : "completed";
  await executionQuery(
    executionFence,
    `UPDATE recovery_points
     SET metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [recoveryPointId, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      verifyStatus,
      verifyFailures: failures,
      manifestArtifactCount: manifest.artifacts?.length ?? point.artifacts.length
    })]
  );

  if (failures.length) {
    throw new Error(`Recovery verification failed: ${failures.join("; ")}`);
  }

  return { recoveryPointId, verifyStatus, artifactCount: point.artifacts.length };
}

/** Backward-compatible alias */
export const runRecoveryPointCapture = runRecoveryCreate;
