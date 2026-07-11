import path from "node:path";
import type { RecoveryArtifact, RecoveryPointDetail, RecoveryRestoreRequest } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { getHostForWorker } from "./hosts.js";
import { mapRecoveryArtifact, mapRecoveryPoint } from "./mappers.js";
import { isDemoHost } from "./demo.js";
import { buildComposeCommand, shQuote, withDockerEnv } from "./commands.js";
import { pipeFileToSshCommand, runSshCommand } from "./ssh.js";
import { stackRemoteDirectory, writeHostStackFiles } from "./remoteFiles.js";
import { ensureRecoveryArtifactLocalPath, readRecoveryArtifact } from "./recoveryArtifactStore.js";
import type { RecoveryManifest } from "./recoveryManifest.js";
import type { JobExecutionFence } from "./jobs.js";
import {
  assertAllowedRestoreRoot,
  buildComposeProjectVolumeName,
  buildBindMountRestoreCommand,
  buildCloneContainerName,
  buildCloneRestoreProjectName,
  buildCloneVolumeName,
  composeVolumeNameFromEngineName,
  buildPortRemap,
  buildStandaloneContainerCreateCommand,
  buildStandaloneNetworkConnectCommand,
  buildStandaloneContainerStartCommand,
  detectPortConflicts,
  extractPublishedPorts,
  remapComposeYaml,
  assertAllowedHostFolderTargetPath,
  resolveHostFolderRestorePath,
  standaloneContainerExtraNetworks
} from "./recoveryRestoreUtils.js";

const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);

export type RestoreResult = {
  mode: "clone" | "in_place";
  projectName: string | null;
  restoredVolumes: number;
  restoredBindMounts: number;
  composeRestored: boolean;
  standaloneContainersRestored: number;
  restoredContainerNames: string[];
  volumeMap: Record<string, string>;
  bindMap: Record<string, string>;
  portRemap: Record<string, string>;
  networkMap: Record<string, string>;
  demo?: boolean;
  stdout?: string;
  stderr?: string;
};

async function getRecoveryPoint(id: string): Promise<RecoveryPointDetail | null> {
  const result = await query("SELECT * FROM recovery_points WHERE id = $1", [id]);
  if (!result.rows[0]) return null;
  const artifacts = await query(
    "SELECT * FROM recovery_artifacts WHERE recovery_point_id = $1 ORDER BY created_at ASC",
    [id]
  );
  return {
    ...mapRecoveryPoint(result.rows[0]),
    artifacts: artifacts.rows.map(mapRecoveryArtifact)
  };
}

async function loadManifest(point: RecoveryPointDetail): Promise<RecoveryManifest | null> {
  const metadataArtifact = point.artifacts.find((artifact) => artifact.kind === "metadata" && artifact.status === "completed");
  if (!metadataArtifact) return null;
  const raw = await readRecoveryArtifact(point, metadataArtifact);
  return JSON.parse(raw.toString("utf8")) as RecoveryManifest;
}

async function restoreVolumeArtifact(
  targetHostId: string,
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  targetVolumeName: string
) {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) {
    return { demo: true, targetVolumeName };
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery volume restore currently requires SSH host mode.");
  }
  const sourcePath = await ensureRecoveryArtifactLocalPath(point, artifact);
  const inspect = await runSshCommand(
    host.ssh,
    withDockerEnv(`docker volume inspect ${shQuote(targetVolumeName)}`, host.public.dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  if (inspect.code === 0) {
    throw new Error(`Recovery volume ${targetVolumeName} already exists; refusing to merge restored data into an existing volume.`);
  }
  const createResult = await runSshCommand(
    host.ssh,
    withDockerEnv(`docker volume create ${shQuote(targetVolumeName)}`, host.public.dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  if (createResult.code !== 0) {
    throw new Error(createResult.stderr || createResult.stdout || `Failed to create recovery volume ${targetVolumeName}`);
  }
  const restoreCommand = withDockerEnv(
    `docker run --rm -i -v ${shQuote(`${targetVolumeName}:/volume`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar xzf -")}`,
    host.public.dockerSocketPath
  );
  const result = await pipeFileToSshCommand(host.ssh, sourcePath, restoreCommand);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Recovery volume restore failed");
  return { stdout: result.stdout, stderr: result.stderr };
}

async function restoreBindMountArtifact(
  targetHostId: string,
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  targetPath: string
) {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) {
    return { demo: true, targetPath };
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery bind mount restore currently requires SSH host mode.");
  }
  const sourcePath = await ensureRecoveryArtifactLocalPath(point, artifact);
  const restoreCommand = buildBindMountRestoreCommand(targetPath);
  const result = await pipeFileToSshCommand(host.ssh, sourcePath, restoreCommand);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Recovery bind mount restore failed");
  return { stdout: result.stdout, stderr: result.stderr };
}

function isPathInside(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);
}

function composeRestoreFilePaths(manifest: RecoveryManifest | null, recoveryPointId: string) {
  let remoteDir = stackRemoteDirectory(recoveryPointId);
  if (manifest?.compose.workingDir) {
    try {
      remoteDir = assertAllowedHostFolderTargetPath(manifest.compose.workingDir);
    } catch {
      remoteDir = stackRemoteDirectory(recoveryPointId);
    }
  }

  const rawComposePath = manifest?.compose.composePath?.trim() || "compose.yml";
  const normalizedComposePath = path.posix.normalize(rawComposePath.replace(/\\/g, "/"));
  const composePath = path.posix.isAbsolute(normalizedComposePath)
    ? isPathInside(remoteDir, normalizedComposePath)
      ? normalizedComposePath
      : path.posix.join(remoteDir, path.posix.basename(normalizedComposePath))
    : (() => {
      const joined = path.posix.normalize(path.posix.join(remoteDir, normalizedComposePath));
      return isPathInside(remoteDir, joined)
        ? joined
        : path.posix.join(remoteDir, path.posix.basename(normalizedComposePath));
    })();

  return {
    remoteDir,
    composePath,
    envPath: path.posix.join(remoteDir, ".env")
  };
}

async function listTargetUsedPorts(targetHostId: string) {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) return new Map<string, string>();
  const result = await runSshCommand(
    host.ssh,
    withDockerEnv(`docker ps --format '{{.Names}} {{.Ports}}'`, host.public.dockerSocketPath),
    { timeoutMs: 60_000 }
  );
  const used = new Map<string, string>();
  if (result.code !== 0) return used;
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    const name = space > 0 ? trimmed.slice(0, space) : trimmed;
    const ports = space > 0 ? trimmed.slice(space + 1) : "";
    for (const match of ports.matchAll(/:(\d+)->\d+\/(tcp|udp)/gi)) {
      if (!match[1] || !match[2]) continue;
      used.set(`${match[1]}/${match[2].toLowerCase()}`, name);
    }
  }
  return used;
}

async function cleanupStandaloneContainers(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  containerNames: string[]
) {
  const failures: string[] = [];
  for (const containerName of Array.from(new Set(containerNames.filter(Boolean))).reverse()) {
    const result = await runSshCommand(
      host.ssh,
      withDockerEnv(`docker rm --force ${shQuote(containerName)}`, host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
    if (result.code !== 0) {
      failures.push(`${containerName}: ${result.stderr || result.stdout || "remove failed"}`);
    }
  }
  return failures;
}

async function restoreStandaloneContainers(input: {
  hostId: string;
  manifest: RecoveryManifest;
  projectName: string;
  volumeMap: Record<string, string>;
  bindMap: Record<string, string>;
  portRemap: Record<string, string>;
  networkMap: Record<string, string>;
  preserveNetworkAddresses: boolean;
}) {
  const host = await getHostForWorker(input.hostId);
  if (isDemoHost(host.public)) {
    return {
      restoredContainerNames: input.manifest.containers.map((container) =>
        buildCloneContainerName(container.name, input.projectName)
      )
    };
  }
  const restoredContainerNames: string[] = [];
  const createdContainerNames: string[] = [];
  let stdout = "";
  let stderr = "";

  try {
    for (const container of input.manifest.containers) {
      const name = buildCloneContainerName(container.name, input.projectName);
      const createCommand = withDockerEnv(
        buildStandaloneContainerCreateCommand({
          container,
          name,
          volumeMap: input.volumeMap,
          bindMap: input.bindMap,
          portRemap: input.portRemap,
          networkMap: input.networkMap
        }),
        host.public.dockerSocketPath
      );
      const createResult = await runSshCommand(host.ssh, createCommand, { timeoutMs: 5 * 60_000 });
      if (createResult.code !== 0) {
        throw new Error(createResult.stderr || createResult.stdout || `Failed to create restored container ${name}`);
      }
      createdContainerNames.push(name);
      stdout += createResult.stdout;
      stderr += createResult.stderr;
      for (const network of standaloneContainerExtraNetworks(container)) {
        const attachment = container.networkAttachments?.find((item) => item.name === network);
        const targetNetwork = input.networkMap[network] ?? network;
        const connectCommand = withDockerEnv(
          buildStandaloneNetworkConnectCommand(targetNetwork, name, {
            ipAddress: input.preserveNetworkAddresses ? attachment?.ipAddress ?? null : null,
            aliases: attachment?.aliases ?? []
          }),
          host.public.dockerSocketPath
        );
        const connectResult = await runSshCommand(host.ssh, connectCommand, { timeoutMs: 60_000 });
        if (connectResult.code !== 0) {
          throw new Error(connectResult.stderr || connectResult.stdout || `Failed to connect restored container ${name} to ${targetNetwork}`);
        }
        stdout += connectResult.stdout;
        stderr += connectResult.stderr;
      }
      if (container.running) {
        const startCommand = withDockerEnv(buildStandaloneContainerStartCommand(name), host.public.dockerSocketPath);
        const startResult = await runSshCommand(host.ssh, startCommand, { timeoutMs: 60_000 });
        if (startResult.code !== 0) {
          throw new Error(startResult.stderr || startResult.stdout || `Failed to start restored container ${name}`);
        }
        stdout += startResult.stdout;
        stderr += startResult.stderr;
      }
      restoredContainerNames.push(name);
    }
  } catch (error) {
    const cleanupFailures = await cleanupStandaloneContainers(host, createdContainerNames);
    const message = error instanceof Error ? error.message : String(error);
    if (cleanupFailures.length) {
      throw new Error(`${message}; cleanup failed: ${cleanupFailures.join("; ")}`);
    }
    throw error;
  }

  return { restoredContainerNames, stdout, stderr };
}

function composeNetworkNameFromEngineName(networkName: string, projectName: string | null | undefined) {
  if (!projectName) return networkName;
  const prefix = `${projectName}_`;
  return networkName.startsWith(prefix) ? networkName.slice(prefix.length) : networkName;
}

function buildNetworkMap(manifest: RecoveryManifest | null, projectName: string, networkMode: "clone" | "reuse") {
  const map: Record<string, string> = {};
  if (!manifest || networkMode === "reuse") return map;
  for (const container of manifest.containers) {
    for (const network of container.networks) {
      if (!network || BUILTIN_NETWORKS.has(network)) continue;
      const logicalName = composeNetworkNameFromEngineName(network, manifest.compose.projectName);
      const targetName = `${projectName}_${logicalName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`.slice(0, 255);
      map[network] = targetName;
      if (logicalName !== network) map[logicalName] = targetName;
    }
  }
  return map;
}

function findSourceNetwork(manifest: RecoveryManifest | null, sourceName: string) {
  return (manifest?.networks ?? []).find((network) =>
    network.name === sourceName ||
    composeNetworkNameFromEngineName(network.name, manifest?.compose.projectName) === sourceName
  ) ?? null;
}

function buildNetworkCreateCommand(targetName: string, source: NonNullable<RecoveryManifest["networks"]>[number] | null) {
  const args = ["docker", "network", "create"];
  if (source?.driver) args.push("--driver", shQuote(source.driver));
  if (source?.internal) args.push("--internal");
  if (source?.attachable) args.push("--attachable");
  if (source?.enableIPv6) args.push("--ipv6");
  for (const [key, value] of Object.entries(source?.options ?? {})) {
    if (value !== null && value !== undefined && value !== "") args.push("--opt", shQuote(`${key}=${String(value)}`));
  }
  // A clone can live beside its source on the same host. Reusing the source
  // IPAM subnet would overlap, so let Docker allocate a free pool and remove
  // captured static addresses from the cloned Compose definition below.
  args.push(shQuote(targetName));
  return args.join(" ");
}

async function ensureStandaloneNetworks(hostId: string, networkMap: Record<string, string>, manifest: RecoveryManifest | null) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public) || host.connectionMode !== "ssh") return;
  const seen = new Set<string>();
  for (const [sourceName, network] of Object.entries(networkMap)) {
    if (seen.has(network)) continue;
    seen.add(network);
    const inspect = await runSshCommand(
      host.ssh,
      withDockerEnv(`docker network inspect ${shQuote(network)}`, host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
    if (inspect.code === 0) continue;
    const create = await runSshCommand(
      host.ssh,
      withDockerEnv(buildNetworkCreateCommand(network, findSourceNetwork(manifest, sourceName)), host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
    if (create.code !== 0) {
      throw new Error(create.stderr || create.stdout || `Failed to create restore network ${network}`);
    }
  }
}

export async function runRecoveryRestore(hostId: string, input: RecoveryRestoreRequest, executionFence?: JobExecutionFence): Promise<RestoreResult> {
  await executionFence?.assertActive();
  const mode = input.options.mode ?? "clone";
  const networkMode = input.options.networkMode ?? "clone";
  if (mode === "in_place") {
    throw new Error("In-place restore is disabled until source stop validation is implemented.");
  }

  const point = await getRecoveryPoint(input.recoveryPointId);
  if (!point) throw new Error("Recovery point not found");
  if (point.status !== "completed" && point.status !== "partial") {
    throw new Error("Recovery point is not ready for restore");
  }

  const restoreRoot = assertAllowedRestoreRoot(input.options.restoreRoot);
  const manifest = await loadManifest(point);
  const originalProjectName = input.options.projectNameOverride
    ?? manifest?.compose.projectName
    ?? (typeof point.metadata.projectName === "string" ? point.metadata.projectName : null)
    ?? point.id;

  const projectName = buildCloneRestoreProjectName(originalProjectName, point.id);

  const volumeMap: Record<string, string> = {};
  const bindMap: Record<string, string> = {};
  let restoredVolumes = 0;
  let restoredBindMounts = 0;

  for (const artifact of point.artifacts) {
    if (artifact.kind !== "volume" || artifact.status !== "completed") continue;
    const volumeName = String(artifact.metadata.volumeName ?? "");
    if (!volumeName) continue;
    const composeVolumeName = composeVolumeNameFromEngineName(volumeName, manifest?.compose.projectName);
    const targetVolumeName = manifest?.compose.projectName
      ? buildComposeProjectVolumeName(projectName, composeVolumeName)
      : buildCloneVolumeName(volumeName, projectName);
    volumeMap[volumeName] = targetVolumeName;
    if (manifest?.compose.projectName) volumeMap[composeVolumeName] = targetVolumeName;
    await executionFence?.assertActive();
    await restoreVolumeArtifact(hostId, point, artifact, targetVolumeName);
    restoredVolumes += 1;
  }

  for (const artifact of point.artifacts) {
    if (artifact.kind !== "host_folder" || artifact.status !== "completed") continue;
    const sourcePath = String(artifact.metadata.sourcePath ?? "");
    if (!sourcePath) continue;
    const targetPath = resolveHostFolderRestorePath({
      restoreRoot,
      recoveryPointId: point.id,
      sourcePath,
      restorePath: artifact.metadata.restorePath
    });
    bindMap[sourcePath] = targetPath;
    await executionFence?.assertActive();
    await restoreBindMountArtifact(hostId, point, artifact, targetPath);
    restoredBindMounts += 1;
  }

  let portRemap: Record<string, string> = {};
  if (manifest && input.options.remapPorts !== false) {
    const sourcePorts = extractPublishedPorts(manifest.containers);
    const targetUsed = await listTargetUsedPorts(hostId);
    const conflicts = detectPortConflicts(sourcePorts, targetUsed);
    if (conflicts.length) {
      portRemap = buildPortRemap(conflicts, new Set(targetUsed.keys()));
    }
  }
  const networkMap = buildNetworkMap(manifest, projectName, networkMode);
  await executionFence?.assertActive();
  await ensureStandaloneNetworks(hostId, networkMap, manifest);

  const composeArtifact = point.artifacts.find((artifact) => artifact.kind === "compose_yaml" && artifact.status === "completed");
  if (!composeArtifact || !projectName) {
    if (!manifest?.containers.length) {
      return {
        mode,
        projectName,
        restoredVolumes,
        restoredBindMounts,
        composeRestored: false,
        standaloneContainersRestored: 0,
        restoredContainerNames: [],
        volumeMap,
        bindMap,
        portRemap,
        networkMap
      };
    }

    await executionFence?.assertActive();
    const standalone = await restoreStandaloneContainers({
      hostId,
      manifest,
      projectName,
      volumeMap,
      bindMap,
      portRemap,
      networkMap,
      preserveNetworkAddresses: networkMode === "reuse"
    });

    return {
      mode,
      projectName,
      restoredVolumes,
      restoredBindMounts,
      composeRestored: false,
      standaloneContainersRestored: standalone.restoredContainerNames.length,
      restoredContainerNames: standalone.restoredContainerNames,
      volumeMap,
      bindMap,
      portRemap,
      networkMap,
      stdout: standalone.stdout,
      stderr: standalone.stderr
    };
  }

  let composeYaml = (await readRecoveryArtifact(point, composeArtifact)).toString("utf8");
  const envArtifact = point.artifacts.find((artifact) => artifact.kind === "env_file" && artifact.status === "completed");
  const env = envArtifact
    ? (await readRecoveryArtifact(point, envArtifact)).toString("utf8")
    : "";

  composeYaml = remapComposeYaml(composeYaml, {
    volumes: volumeMap,
    bindMounts: bindMap,
    portRemap,
    networks: networkMap,
    resetNetworkAddressing: networkMode === "clone"
  });

  const restoreFiles = composeRestoreFilePaths(manifest, point.id);
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return {
      mode,
      projectName,
      restoredVolumes,
      restoredBindMounts,
      composeRestored: true,
      standaloneContainersRestored: 0,
      restoredContainerNames: [],
      volumeMap,
      bindMap,
      portRemap,
      networkMap,
      demo: true
    };
  }

  await executionFence?.assertActive();
  const files = await writeHostStackFiles(hostId, restoreFiles.remoteDir, composeYaml, env, {
    composePath: restoreFiles.composePath,
    envPath: restoreFiles.envPath
  });
  await executionFence?.assertActive();
  const command = `cd ${shQuote(restoreFiles.remoteDir)} && ${withDockerEnv(buildComposeCommand(projectName, files.composePath, "up"), host.public.dockerSocketPath)}`;
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Compose restore failed");

  return {
    mode,
    projectName,
    restoredVolumes,
    restoredBindMounts,
    composeRestored: true,
    standaloneContainersRestored: 0,
    restoredContainerNames: [],
    volumeMap,
    bindMap,
    portRemap,
    networkMap,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
