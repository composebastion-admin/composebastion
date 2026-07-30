import path from "node:path";
import type {
  RecoveryArtifact,
  RecoveryPointDetail,
  RecoveryRestoreRequest
} from "@composebastion/shared";
import { query } from "../db/pool.js";
import type {
  DockerMutationScope,
  DockerMutationTarget
} from "./dockerMutationScope.js";
import { mapRecoveryArtifact, mapRecoveryPoint } from "./mappers.js";
import { readRecoveryArtifact } from "./recoveryArtifactStore.js";
import type { RecoveryManifest } from "./recoveryManifest.js";
import {
  assertAllowedRestoreRoot,
  buildCloneContainerName,
  buildCloneRestoreProjectName,
  buildCloneVolumeName,
  buildComposeProjectVolumeName,
  composeVolumeNameFromEngineName,
  resolveHostFolderRestorePath,
  sanitizeDockerName
} from "./recoveryRestoreUtils.js";
import { stackRemoteDirectory } from "./remoteFiles.js";

const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);

export type RecoveryRestorePlannedResource = {
  kind:
    | "volume"
    | "network"
    | "container"
    | "directory"
    | "compose_project"
    | "database";
  name: string;
  owned: boolean;
};

export type RecoveryRestorePlan = {
  point: RecoveryPointDetail;
  manifest: RecoveryManifest | null;
  composeArtifact: RecoveryArtifact | null;
  projectName: string;
  restoreRoot: string;
  sameHostComposeClone: boolean;
  volumeMap: Record<string, string>;
  bindMap: Record<string, string>;
  networkMap: Record<string, string>;
  standaloneContainerNames: string[];
  predictedComposeContainerNames: string[];
  stackDirectory: string | null;
  allowedPathRoots: string[];
  resources: RecoveryRestorePlannedResource[];
  dockerMutationScope: DockerMutationScope;
};

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function composeNetworkNameFromEngineName(
  networkName: string,
  projectName: string | null | undefined
) {
  if (!projectName) return networkName;
  const prefix = `${projectName}_`;
  return networkName.startsWith(prefix)
    ? networkName.slice(prefix.length)
    : networkName;
}

export function buildRecoveryNetworkMap(
  manifest: RecoveryManifest | null,
  projectName: string,
  networkMode: "clone" | "reuse"
) {
  const map: Record<string, string> = {};
  if (!manifest) return map;
  for (const container of manifest.containers) {
    for (const network of container.networks) {
      if (!network || BUILTIN_NETWORKS.has(network)) continue;
      const sourceNetwork = (manifest.networks ?? [])
        .find((item) => item.name === network);
      const composeLogicalName =
        sourceNetwork?.labels["com.docker.compose.network"]?.trim();
      const logicalName = composeLogicalName
        || composeNetworkNameFromEngineName(
          network,
          manifest.compose.projectName
        );
      const targetName = networkMode === "reuse"
        ? network
        : `${projectName}_${logicalName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`
          .slice(0, 255);
      map[network] = targetName;
      if (logicalName !== network) map[logicalName] = targetName;
    }
  }
  return map;
}

function isDatabaseContainer(input: {
  name: string;
  image: string;
  labels: Record<string, string>;
}) {
  const role = [
    input.name,
    input.image,
    input.labels["com.composebastion.role"] ?? "",
    input.labels["com.docker.compose.service"] ?? ""
  ].join(" ");
  return /(?:^|[/:_.-])(postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|mssql|cockroach|couchdb|influxdb|elasticsearch|opensearch)(?:$|[/:_.-])/i
    .test(role);
}

function predictedComposeContainerNames(
  manifest: RecoveryManifest,
  projectName: string
) {
  const names: string[] = [];
  for (const container of manifest.containers) {
    const service =
      container.labels["com.docker.compose.service"]?.trim();
    const number =
      container.labels["com.docker.compose.container-number"]?.trim() || "1";
    if (service) {
      names.push(
        `${projectName}-${service}-${number}`,
        `${projectName}_${service}_${number}`
      );
    }
    // Explicit container_name cannot be inferred from engine labels alone.
    // Include both the captured name and the safe clone derivation so direct
    // mutations using either identity are conservatively serialized.
    names.push(
      container.name,
      buildCloneContainerName(container.name, projectName)
    );
  }
  return unique(names);
}

function addTarget(
  targets: DockerMutationTarget[],
  hostId: string,
  kind: DockerMutationTarget["kind"],
  rawValue: string
) {
  const value = kind === "host-path"
    ? path.posix.normalize(rawValue)
    : kind === "compose-project"
      ? rawValue.trim().toLowerCase()
      : rawValue.trim();
  if (!value) return;
  if (!targets.some((target) =>
    target.hostId === hostId
    && target.kind === kind
    && target.value === value
  )) {
    targets.push({ hostId, kind, value });
  }
}

export async function getRecoveryPointForRestore(
  id: string
): Promise<RecoveryPointDetail | null> {
  const result = await query(
    "SELECT * FROM recovery_points WHERE id = $1",
    [id]
  );
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

export async function loadRecoveryManifest(
  point: RecoveryPointDetail
): Promise<RecoveryManifest | null> {
  const metadataArtifact = point.artifacts.find(
    (artifact) =>
      artifact.kind === "metadata"
      && artifact.status === "completed"
  );
  if (!metadataArtifact) return null;
  const raw = await readRecoveryArtifact(point, metadataArtifact);
  return JSON.parse(raw.toString("utf8")) as RecoveryManifest;
}

export function buildRecoveryRestorePlan(
  point: RecoveryPointDetail,
  manifest: RecoveryManifest | null,
  input: RecoveryRestoreRequest
): RecoveryRestorePlan {
  const mode = input.options.mode ?? "clone";
  const networkMode = input.options.networkMode ?? "clone";
  const restoreRoot = assertAllowedRestoreRoot(input.options.restoreRoot);
  const composeArtifact = point.artifacts.find(
    (artifact) =>
      artifact.kind === "compose_yaml"
      && artifact.status === "completed"
  ) ?? null;
  const sameHostComposeClone = mode === "clone"
    && point.hostId === input.targetHostId
    && Boolean(composeArtifact && manifest?.compose.projectName);
  const originalProjectName = input.options.projectNameOverride
    ?? manifest?.compose.projectName
    ?? (
      typeof point.metadata.projectName === "string"
        ? point.metadata.projectName
        : null
    )
    ?? point.id;
  const projectName = buildCloneRestoreProjectName(
    originalProjectName,
    point.id
  );
  const volumeNamespace = input.options.volumePrefix
    ? sanitizeDockerName(input.options.volumePrefix, 80)
    : projectName;
  const volumeMap: Record<string, string> = {};
  const bindMap: Record<string, string> = {};

  for (const artifact of point.artifacts) {
    if (artifact.kind !== "volume" || artifact.status !== "completed") {
      continue;
    }
    const volumeName = String(artifact.metadata.volumeName ?? "");
    if (!volumeName) continue;
    const composeVolumeName = composeVolumeNameFromEngineName(
      volumeName,
      manifest?.compose.projectName
    );
    const targetVolumeName = manifest?.compose.projectName
      ? buildComposeProjectVolumeName(volumeNamespace, composeVolumeName)
      : buildCloneVolumeName(volumeName, volumeNamespace);
    volumeMap[volumeName] = targetVolumeName;
    if (manifest?.compose.projectName) {
      volumeMap[composeVolumeName] = targetVolumeName;
    }
  }

  for (const artifact of point.artifacts) {
    if (
      artifact.kind !== "host_folder"
      || artifact.status !== "completed"
    ) {
      continue;
    }
    const sourcePath = String(artifact.metadata.sourcePath ?? "");
    if (!sourcePath) continue;
    bindMap[sourcePath] = resolveHostFolderRestorePath({
      restoreRoot,
      recoveryPointId: point.id,
      sourcePath,
      restorePath: artifact.metadata.restorePath,
      forceManaged: sameHostComposeClone
    });
  }

  const networkMap = buildRecoveryNetworkMap(
    manifest,
    projectName,
    networkMode
  );
  const standaloneContainerNames = manifest && !composeArtifact
    ? unique(manifest.containers.map((container) =>
      buildCloneContainerName(container.name, projectName)
    ))
    : [];
  const predictedComposeNames = manifest && composeArtifact
    ? predictedComposeContainerNames(manifest, projectName)
    : [];
  const stackDirectory = composeArtifact
    ? stackRemoteDirectory(point.id)
    : null;
  const ownedNetworkNames = networkMode === "clone"
    ? unique(Object.values(networkMap))
    : [];
  const databaseNames = manifest
    ? unique(
      manifest.containers
        .filter(isDatabaseContainer)
        .map((container) => {
          if (!composeArtifact) {
            return buildCloneContainerName(container.name, projectName);
          }
          const service =
            container.labels["com.docker.compose.service"]?.trim();
          return service
            ? `${projectName}:${service}`
            : `${projectName}:${container.name}`;
        })
    )
    : [];
  const resources: RecoveryRestorePlannedResource[] = [
    ...unique(Object.values(volumeMap))
      .map((name) => ({ kind: "volume" as const, name, owned: true })),
    ...ownedNetworkNames
      .map((name) => ({ kind: "network" as const, name, owned: true })),
    ...standaloneContainerNames
      .map((name) => ({ kind: "container" as const, name, owned: true })),
    ...unique(Object.values(bindMap))
      .map((name) => ({ kind: "directory" as const, name, owned: true })),
    ...(stackDirectory
      ? [{
          kind: "directory" as const,
          name: stackDirectory,
          owned: true
        }]
      : []),
    ...(composeArtifact
      ? [{
          kind: "compose_project" as const,
          name: projectName,
          owned: true
        }]
      : []),
    ...databaseNames
      .map((name) => ({ kind: "database" as const, name, owned: true }))
  ];

  const targets: DockerMutationTarget[] = [];
  addTarget(
    targets,
    input.targetHostId,
    "compose-project",
    projectName
  );
  for (const volume of unique(Object.values(volumeMap))) {
    addTarget(targets, input.targetHostId, "volume", volume);
  }
  for (const targetPath of unique(Object.values(bindMap))) {
    addTarget(targets, input.targetHostId, "host-path", targetPath);
  }
  if (stackDirectory) {
    addTarget(
      targets,
      input.targetHostId,
      "host-path",
      stackDirectory
    );
  }
  for (const network of unique(Object.values(networkMap))) {
    addTarget(targets, input.targetHostId, "network", network);
  }
  for (const container of [
    ...standaloneContainerNames,
    ...predictedComposeNames
  ]) {
    addTarget(targets, input.targetHostId, "container", container);
  }

  return {
    point,
    manifest,
    composeArtifact,
    projectName,
    restoreRoot,
    sameHostComposeClone,
    volumeMap,
    bindMap,
    networkMap,
    standaloneContainerNames,
    predictedComposeContainerNames: predictedComposeNames,
    stackDirectory,
    allowedPathRoots: unique([
      ...Object.values(bindMap),
      ...(stackDirectory ? [stackDirectory] : [])
    ]),
    resources,
    dockerMutationScope: {
      type: "compose.deployPath",
      hostIds: [input.targetHostId],
      targets
    }
  };
}

export async function loadRecoveryRestorePlan(
  input: RecoveryRestoreRequest
) {
  const point = await getRecoveryPointForRestore(input.recoveryPointId);
  if (!point) throw new Error("Recovery point not found");
  const manifest = await loadRecoveryManifest(point);
  return buildRecoveryRestorePlan(point, manifest, input);
}
