import type { MigrationPlan, MigrationPlanRequest } from "@composebastion/shared";
import { migrationPlanSchema } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { getHost } from "./hosts.js";
import { isDemoHost } from "./demo.js";
import type { ResolvedAppContext } from "./recoveryAppContext.js";
import {
  detectPortConflicts,
  extractPublishedPorts,
  parseInventoryPortString,
  portKey
} from "./recoveryRestoreUtils.js";
import type { ContainerManifest } from "./recoveryManifest.js";
import { buildContainerManifest, composeWorkingDirHostFolder, isHostPathInside } from "./recoveryManifest.js";

function buildPlanSteps() {
  return [
    {
      id: "capture",
      title: "Capture recovery point",
      description: "Back up compose configuration, metadata, Docker volumes, and host-folder bind mounts from the source host.",
      kind: "backup" as const
    },
    {
      id: "transfer",
      title: "Transfer artifacts",
      description: "Copy recovery artifacts to the target host backup target.",
      kind: "transfer" as const
    },
    {
      id: "deploy",
      title: "Deploy on target host",
      description: "Restore data artifacts, remap target mounts, and redeploy the application on the destination host.",
      kind: "deploy" as const
    },
    {
      id: "verify",
      title: "Verify restored app",
      description: "Confirm containers are running and inventory sync succeeds on the target host.",
      kind: "verify" as const
    }
  ];
}

async function checkHostDocker(hostId: string) {
  const host = await getHost(hostId);
  if (!host) return { available: false, docker: false, compose: false };
  if (isDemoHost(host)) return { available: true, docker: true, compose: true };
  return {
    available: true,
    docker: host.lastStatus === "online" || Boolean(host.dockerVersion),
    compose: Boolean(host.composeVersion)
  };
}

async function listInventoryNames(hostId: string, kind: "volume" | "container" | "network") {
  const result = await query<{ name: string; data: Record<string, unknown> }>(
    `SELECT name, data FROM resource_snapshots WHERE host_id = $1 AND kind = $2`,
    [hostId, kind]
  );
  return result.rows;
}

async function listTargetUsedPorts(hostId: string) {
  const containers = await listInventoryNames(hostId, "container");
  const used = new Map<string, string>();
  for (const row of containers) {
    const ports = parseInventoryPortString(String(row.data.Ports ?? ""), row.name);
    for (const port of ports) {
      used.set(portKey(port.hostPort, port.protocol), row.name);
    }
  }
  return used;
}

function snapshotNetworkEntries(data: Record<string, unknown>) {
  const networkSettings = data.NetworkSettings && typeof data.NetworkSettings === "object" && !Array.isArray(data.NetworkSettings)
    ? data.NetworkSettings as Record<string, unknown>
    : {};
  const networks = networkSettings.Networks && typeof networkSettings.Networks === "object" && !Array.isArray(networkSettings.Networks)
    ? networkSettings.Networks as Record<string, unknown>
    : null;
  if (networks) return networks;

  const names = new Set<string>();
  if (typeof data.Networks === "string") {
    for (const name of data.Networks.split(",")) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  if (data.Network) names.add(String(data.Network));
  const singleIp = data.IPAddress ? String(data.IPAddress) : "";
  return Object.fromEntries(Array.from(names).map((name) => [name, {
    IPAddress: names.size === 1 ? singleIp : "",
    Aliases: [String(data.Names ?? "")].filter(Boolean)
  }]));
}

function networkSettingsFromSnapshot(data: Record<string, unknown>) {
  return {
    Ports: {},
    Networks: snapshotNetworkEntries(data)
  };
}

function collectNetworkIpUsage(rows: Array<{ name: string; data: Record<string, unknown> }>) {
  const usage = new Map<string, Map<string, string>>();
  for (const row of rows) {
    for (const [networkName, value] of Object.entries(snapshotNetworkEntries(row.data))) {
      const network = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      const ipAddress = network.IPAddress ? String(network.IPAddress) : "";
      if (!ipAddress) continue;
      const networkUsage = usage.get(networkName) ?? new Map<string, string>();
      networkUsage.set(ipAddress, row.name);
      usage.set(networkName, networkUsage);
    }
  }
  return usage;
}

function detectNetworkConflicts(
  manifests: ContainerManifest[],
  targetNetworkIps: Map<string, Map<string, string>>
) {
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const container of manifests) {
    for (const attachment of container.networkAttachments ?? []) {
      if (!attachment.ipAddress || attachment.name === "bridge" || attachment.name === "host" || attachment.name === "none") continue;
      const occupant = targetNetworkIps.get(attachment.name)?.get(attachment.ipAddress);
      if (!occupant) continue;
      const message = `Network ${attachment.name} already has ${attachment.ipAddress} assigned to ${occupant}; reusing that network would conflict with ${container.name}.`;
      if (!seen.has(message)) {
        conflicts.push(message);
        seen.add(message);
      }
    }
  }
  return conflicts;
}

async function loadSourceContainerManifests(hostId: string, containerIds: string[]): Promise<ContainerManifest[]> {
  if (!containerIds.length) return [];
  const result = await query<{ external_id: string; name: string; data: Record<string, unknown> }>(
    `SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = 'container'`,
    [hostId]
  );
  const manifests: ContainerManifest[] = [];
  for (const containerId of containerIds) {
    const row = result.rows.find((item) => item.external_id === containerId);
    if (!row) continue;
    manifests.push(buildContainerManifest({
      Id: containerId,
      Name: `/${row.name ?? containerId}`,
      Config: { Image: row.data.Image, Env: [], Labels: row.data.Labels ?? {} },
      State: { Running: String(row.data.State ?? "").toLowerCase().includes("running"), Status: String(row.data.State ?? "") },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" }, PortBindings: {} },
      NetworkSettings: networkSettingsFromSnapshot(row.data),
      Mounts: row.data.Mounts ?? []
    }));
  }
  return manifests;
}

export async function analyzeMigrationPlan(
  input: MigrationPlanRequest,
  context: ResolvedAppContext,
  options: { estimatedDataBytes?: number | null } = {}
): Promise<MigrationPlan> {
  const warnings: string[] = [];
  const blockingIssues: string[] = [];

  if (input.sourceHostId === input.targetHostId) {
    warnings.push("Source and target host are the same; migration will recreate the app in place.");
  }
  if (!context.composeYaml && context.containerIds.length > 0) {
    warnings.push("No compose stack was found; restore will recreate standalone containers from captured metadata only.");
  }

  const sourceHost = await getHost(input.sourceHostId);
  const targetHost = await getHost(input.targetHostId);
  if (!sourceHost) blockingIssues.push("Source host was not found.");
  if (!targetHost) blockingIssues.push("Target host was not found.");

  const sourceCheck = sourceHost ? await checkHostDocker(input.sourceHostId) : { available: false, docker: false, compose: false };
  const targetCheck = targetHost ? await checkHostDocker(input.targetHostId) : { available: false, docker: false, compose: false };

  if (sourceHost && !sourceCheck.docker) blockingIssues.push("Docker is unavailable on the source host.");
  if (targetHost && !targetCheck.docker) blockingIssues.push("Docker is unavailable on the target host.");
  if (context.composeYaml && sourceHost && !sourceCheck.compose) {
    warnings.push("Docker Compose may be unavailable on the source host.");
  }
  if (context.composeYaml && targetHost && !targetCheck.compose) {
    blockingIssues.push("Docker Compose is required on the target host for compose-based apps.");
  }

  const targetVolumes = new Set((await listInventoryNames(input.targetHostId, "volume")).map((row) => row.name));
  const targetContainerRows = await listInventoryNames(input.targetHostId, "container");
  const targetContainers = new Set(targetContainerRows.map((row) => row.name));
  const targetNetworks = new Set((await listInventoryNames(input.targetHostId, "network")).map((row) => row.name));

  const volumeCollisions = context.volumeNames.filter((name) => targetVolumes.has(name));
  if (volumeCollisions.length) {
    warnings.push(`Target host already has ${volumeCollisions.length} matching volume name(s); clone restore will use derived names.`);
  }

  const projectName = context.projectName;
  const nameCollisions: string[] = [];
  if (projectName) {
    for (const containerName of targetContainers) {
      if (containerName.includes(projectName)) nameCollisions.push(containerName);
    }
  }

  const manifests = await loadSourceContainerManifests(input.sourceHostId, context.containerIds);
  const bindMountSources = Array.from(new Set(
    manifests.flatMap((container) => container.bindMounts.map((bind) => bind.source))
  ));
  const composeFolder = composeWorkingDirHostFolder(context.workingDir);
  const managedBindMountSources = composeFolder
    ? bindMountSources.filter((source) => !isHostPathInside(composeFolder.source, source))
    : bindMountSources;
  const hostFolderSources = new Set(managedBindMountSources);
  if (composeFolder) hostFolderSources.add(composeFolder.source);
  if (context.volumeNames.length === 0 && hostFolderSources.size === 0) {
    warnings.push("No Docker volumes or host folders were discovered for this app; only configuration artifacts will be captured.");
  }
  if (composeFolder) {
    warnings.push(`Compose working directory ${composeFolder.source} will be captured and recreated on the target at the same path.`);
  }
  if (managedBindMountSources.length > 0) {
    warnings.push(`Detected ${managedBindMountSources.length} host-folder bind mount(s) outside the compose working directory; those separate bind mounts will be copied into managed restore folders on the target and remapped there.`);
  }
  const sourcePorts = extractPublishedPorts(manifests);
  const targetUsedPorts = await listTargetUsedPorts(input.targetHostId);
  const portConflicts = detectPortConflicts(sourcePorts, targetUsedPorts);

  const requiredNetworks = Array.from(new Set(manifests.flatMap((container) => container.networks)));
  const missingNetworks = requiredNetworks.filter((network) => network && !targetNetworks.has(network) && network !== "bridge" && network !== "host");
  const networkConflicts = detectNetworkConflicts(manifests, collectNetworkIpUsage(targetContainerRows));
  if (networkConflicts.length) {
    warnings.push(`Detected ${networkConflicts.length} static IP conflict(s) if existing target networks are reused.`);
  }

  let estimatedArtifacts = 1;
  if (context.composeYaml) estimatedArtifacts += 1;
  if (context.env) estimatedArtifacts += 1;
  estimatedArtifacts += context.volumeNames.length;
  estimatedArtifacts += hostFolderSources.size;

  return migrationPlanSchema.parse({
    sourceHostId: input.sourceHostId,
    targetHostId: input.targetHostId,
    sourceAppIdentity: input.sourceAppIdentity,
    steps: buildPlanSteps(),
    warnings,
    estimatedArtifacts,
    estimatedVolumes: context.volumeNames.length,
    estimatedHostFolders: hostFolderSources.size,
    checks: {
      sourceHostAvailable: Boolean(sourceHost),
      targetHostAvailable: Boolean(targetHost),
      sourceDockerAvailable: sourceCheck.docker,
      targetDockerAvailable: targetCheck.docker,
      sourceComposeAvailable: sourceCheck.compose,
      targetComposeAvailable: targetCheck.compose
    },
    portConflicts,
    volumeCollisions,
    nameCollisions,
    missingNetworks,
    networkConflicts,
    estimatedDataBytes: options.estimatedDataBytes ?? null,
    blockingIssues
  });
}

export function buildMigrationPlan(input: MigrationPlanRequest, context: ResolvedAppContext): MigrationPlan {
  const warnings: string[] = [];
  if (input.sourceHostId === input.targetHostId) {
    warnings.push("Source and target host are the same; migration will recreate the app in place.");
  }
  if (!context.composeYaml && context.containerIds.length > 0) {
    warnings.push("No compose stack was found; restore will recreate standalone containers from captured metadata only.");
  }
  const composeFolder = composeWorkingDirHostFolder(context.workingDir);
  if (context.volumeNames.length === 0 && !composeFolder) {
    warnings.push("No Docker volumes were discovered during quick planning; detailed planning will also check host-folder bind mounts.");
  }
  if (composeFolder) {
    warnings.push(`Compose working directory ${composeFolder.source} will be captured and recreated on the target at the same path.`);
  }

  let estimatedArtifacts = 1;
  if (context.composeYaml) estimatedArtifacts += 1;
  if (context.env) estimatedArtifacts += 1;
  estimatedArtifacts += context.volumeNames.length;
  if (composeFolder) estimatedArtifacts += 1;

  return migrationPlanSchema.parse({
    sourceHostId: input.sourceHostId,
    targetHostId: input.targetHostId,
    sourceAppIdentity: input.sourceAppIdentity,
    steps: buildPlanSteps(),
    warnings,
    estimatedArtifacts,
    estimatedVolumes: context.volumeNames.length,
    estimatedHostFolders: composeFolder ? 1 : 0,
    checks: {
      sourceHostAvailable: true,
      targetHostAvailable: true,
      sourceDockerAvailable: true,
      targetDockerAvailable: true,
      sourceComposeAvailable: true,
      targetComposeAvailable: true
    },
    portConflicts: [],
    volumeCollisions: [],
    nameCollisions: [],
    missingNetworks: [],
    networkConflicts: [],
    estimatedDataBytes: null,
    blockingIssues: []
  });
}
