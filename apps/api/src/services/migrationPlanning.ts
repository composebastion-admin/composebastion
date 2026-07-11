import { createHmac } from "node:crypto";
import type { MigrationIntent, MigrationPlan, MigrationPlanRequest, MigrationRun, RecoveryAppIdentity } from "@composebastion/shared";
import { migrationIntentSchema, migrationPlanSchema, recoveryAppIdentitySchema } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { appSecretKey } from "../config/env.js";
import { runDocker, syncDockerInventory } from "./docker.js";
import { getHost } from "./hosts.js";
import { isDemoHost } from "./demo.js";
import { shQuote } from "./commands.js";
import { resolveAppContext, type ResolvedAppContext } from "./recoveryAppContext.js";
import {
  detectPortConflicts,
  extractPublishedPorts,
  portKey
} from "./recoveryRestoreUtils.js";
import type { ContainerManifest, NetworkManifest } from "./recoveryManifest.js";
import {
  buildContainerManifest,
  buildNetworkManifest,
  composeWorkingDirHostFolder,
  isHostPathInside
} from "./recoveryManifest.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)])
  );
}

function fingerprint(value: unknown) {
  // Plans are visible to signed-in viewers. HMAC keeps low-entropy configuration
  // values (notably environment entries) from becoming offline-guessable hashes.
  return createHmac("sha256", appSecretKey).update(JSON.stringify(canonicalize(value))).digest("hex");
}

/**
 * Build the configuration projection used by migration fingerprints. Values
 * that commonly contain credentials are reduced to keyed digests before they
 * enter the projection. The stored plan therefore contains only the final
 * HMAC while still detecting environment, label, command, and IPAM drift.
 */
export function sanitizedManifestForFingerprint(manifest: ContainerManifest) {
  const { state: _state, ...stable } = manifest;
  return {
    id: stable.id,
    name: stable.name,
    image: stable.image,
    // Docker's human-readable state text can contain volatile uptime, but the
    // running/stopped transition changes migration intent and must stale a
    // reviewed plan before capture or deployment.
    running: stable.running,
    ports: [...stable.ports].sort((left, right) => `${left.host}:${left.container}/${left.protocol}`.localeCompare(`${right.host}:${right.container}/${right.protocol}`)),
    networks: [...stable.networks].sort(),
    networkAttachments: [...(stable.networkAttachments ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((attachment) => ({
        name: attachment.name,
        ipAddress: attachment.ipAddress,
        globalIPv6Address: attachment.globalIPv6Address,
        gateway: attachment.gateway,
        macAddress: attachment.macAddress,
        aliases: [...attachment.aliases].sort(),
        ipamConfigFingerprint: fingerprint(attachment.ipamConfig ?? null)
      })),
    labels: Object.entries(stable.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, valueFingerprint: fingerprint(value) })),
    restartPolicy: stable.restartPolicy,
    env: [...stable.env]
      .map((entry) => ({
        name: entry.includes("=") ? entry.slice(0, entry.indexOf("=")) : entry,
        valueFingerprint: fingerprint(entry)
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.valueFingerprint.localeCompare(right.valueFingerprint)),
    volumes: [...stable.volumes].sort((left, right) => `${left.name}:${left.destination}`.localeCompare(`${right.name}:${right.destination}`)),
    bindMounts: [...stable.bindMounts].sort((left, right) => `${left.source}:${left.destination}`.localeCompare(`${right.source}:${right.destination}`)),
    entrypointFingerprint: fingerprint(stable.entrypoint),
    commandFingerprint: fingerprint(stable.command),
    user: stable.user,
    workingDir: stable.workingDir
  };
}

function fingerprintRecordEntries(input: Record<string, unknown>) {
  return Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, valueFingerprint: fingerprint(value) }));
}

export function sanitizedNetworkForFingerprint(network: NetworkManifest) {
  const ipamConfig = [...network.ipam.config]
    .map((entry) => canonicalize(entry) as Record<string, unknown>)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    name: network.name,
    driver: network.driver,
    scope: network.scope,
    internal: network.internal,
    attachable: network.attachable,
    ingress: network.ingress,
    enableIPv6: network.enableIPv6,
    ipam: {
      driver: network.ipam.driver,
      options: fingerprintRecordEntries(network.ipam.options),
      config: ipamConfig.map((entry) => ({ valueFingerprint: fingerprint(entry) }))
    },
    labels: fingerprintRecordEntries(network.labels),
    options: fingerprintRecordEntries(network.options)
  };
}

function normalizedRecoveryAppIdentity(input: RecoveryAppIdentity) {
  const identity = recoveryAppIdentitySchema.parse(input);
  const { label: _label, ...stable } = identity;
  if (stable.kind === "standalone") {
    return { ...stable, containerIds: [...stable.containerIds].sort() };
  }
  return stable;
}

export function recoveryAppIdentitiesEqual(left: RecoveryAppIdentity, right: RecoveryAppIdentity) {
  return fingerprint(normalizedRecoveryAppIdentity(left)) === fingerprint(normalizedRecoveryAppIdentity(right));
}

export function normalizeMigrationIntent(input: Partial<Pick<MigrationPlanRequest, "strategy" | "options">>): MigrationIntent {
  return migrationIntentSchema.parse({
    strategy: input.strategy ?? "clone",
    options: input.options ?? {}
  });
}

export function migrationIntentsEqual(left: MigrationIntent, right: MigrationIntent) {
  return fingerprint(migrationIntentSchema.parse(left)) === fingerprint(migrationIntentSchema.parse(right));
}

export async function refreshMigrationInventories(sourceHostId: string, targetHostId: string) {
  const hostIds = Array.from(new Set([sourceHostId, targetHostId]));
  await Promise.all(hostIds.map((hostId) => syncDockerInventory(hostId)));
}

export class MigrationPlanStaleError extends Error {
  readonly statusCode = 409;
  readonly code = "MIGRATION_PLAN_STALE";

  constructor(message: string, readonly blockingIssues: string[] = []) {
    super(message);
    this.name = "MigrationPlanStaleError";
  }
}

function migrationPlanRequestFromRun(run: MigrationRun): MigrationPlanRequest {
  const plan = run.plan;
  if (!plan?.intent || !plan.sourceFingerprint || !plan.targetFingerprint) {
    throw new MigrationPlanStaleError("Migration plan predates plan binding; create and review a new plan.");
  }
  if (
    plan.sourceHostId !== run.sourceHostId
    || plan.targetHostId !== run.targetHostId
    || fingerprint(recoveryAppIdentitySchema.parse(plan.sourceAppIdentity))
      !== fingerprint(recoveryAppIdentitySchema.parse(run.sourceAppIdentity))
  ) {
    throw new MigrationPlanStaleError("Migration plan identity no longer matches its stored run.");
  }
  return {
    sourceHostId: run.sourceHostId,
    targetHostId: run.targetHostId,
    sourceAppIdentity: run.sourceAppIdentity,
    createRecoveryPoint: true,
    strategy: plan.intent.strategy,
    options: plan.intent.options
  };
}

export async function revalidateMigrationPlan(
  run: MigrationRun,
  options: { refreshSource?: boolean; refreshTarget?: boolean } = {}
) {
  if (run.mode === "plan" && run.status !== "completed") {
    throw new MigrationPlanStaleError("Migration plan is unavailable; create and review a new plan.");
  }
  if (run.mode !== "plan" && !run.planRunId) {
    throw new MigrationPlanStaleError("Migration execution is not bound to a reviewed plan.");
  }
  if (!run.plan) {
    throw new MigrationPlanStaleError("Migration plan is unavailable; create and review a new plan.");
  }
  const input = migrationPlanRequestFromRun(run);
  const hostIds = Array.from(new Set([
    options.refreshSource === false ? null : run.sourceHostId,
    options.refreshTarget === false ? null : run.targetHostId
  ].filter((hostId): hostId is string => Boolean(hostId))));
  try {
    await Promise.all(hostIds.map((hostId) => syncDockerInventory(hostId)));
  } catch {
    throw new MigrationPlanStaleError("Could not refresh migration host state; create a new plan after both hosts are reachable.");
  }
  const context = await resolveAppContext(input.sourceHostId, input.sourceAppIdentity);
  const latestPlan = await analyzeMigrationPlan(input, context);
  if (latestPlan.blockingIssues.length > 0) {
    throw new MigrationPlanStaleError(
      "Migration plan now has blocking issues; review a new plan before executing.",
      latestPlan.blockingIssues
    );
  }
  if (
    latestPlan.sourceFingerprint !== run.plan.sourceFingerprint
    || latestPlan.targetFingerprint !== run.plan.targetFingerprint
  ) {
    throw new MigrationPlanStaleError("Source or target state changed after planning; review a new plan before executing.");
  }
  return latestPlan;
}

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

type InventoryRow = { external_id: string; name: string; data: Record<string, unknown> };

async function listInventoryNames(hostId: string, kind: "volume" | "container" | "network") {
  const result = await query<InventoryRow>(
    `SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = $2`,
    [hostId, kind]
  );
  return result.rows;
}

function usedPortsFromManifests(containers: ContainerManifest[]) {
  const used = new Map<string, string>();
  for (const port of extractPublishedPorts(containers)) {
    used.set(portKey(port.hostPort, port.protocol), port.containerName ?? "an existing target container");
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

function manifestsFromInventoryRows(rows: InventoryRow[], containerIds: string[]): ContainerManifest[] {
  if (!containerIds.length) return [];
  const manifests: ContainerManifest[] = [];
  for (const containerId of containerIds) {
    const row = rows.find((item) => item.external_id === containerId);
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

async function inspectContainerManifests(
  hostId: string,
  containerIds: string[],
  inventoryRows: InventoryRow[]
): Promise<ContainerManifest[]> {
  if (!containerIds.length) return [];
  const host = await getHost(hostId);
  if (host && isDemoHost(host)) {
    return manifestsFromInventoryRows(inventoryRows, containerIds);
  }

  const manifests: ContainerManifest[] = [];
  // Keep commands below conservative shell argument limits on large hosts.
  for (let offset = 0; offset < containerIds.length; offset += 100) {
    const chunk = containerIds.slice(offset, offset + 100);
    const result = await runDocker(hostId, `docker inspect ${chunk.map(shQuote).join(" ")}`, 60_000);
    const inspected = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(inspected)) throw new Error("Docker inspect did not return an array");
    manifests.push(...inspected.map((item) => buildContainerManifest(item as Record<string, unknown>)));
  }
  return manifests;
}

async function inspectNetworkManifests(hostId: string, inventoryRows: InventoryRow[]): Promise<NetworkManifest[]> {
  if (!inventoryRows.length) return [];
  const host = await getHost(hostId);
  if (host && isDemoHost(host)) {
    return inventoryRows.map((row) => buildNetworkManifest(row.data, row.name));
  }

  const manifests: NetworkManifest[] = [];
  for (let offset = 0; offset < inventoryRows.length; offset += 100) {
    const chunk = inventoryRows.slice(offset, offset + 100);
    const identifiers = chunk.map((row) => row.external_id || row.name).filter(Boolean);
    if (!identifiers.length) continue;
    const result = await runDocker(hostId, `docker network inspect ${identifiers.map(shQuote).join(" ")}`, 60_000);
    const inspected = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(inspected)) throw new Error("Docker network inspect did not return an array");
    manifests.push(...inspected.map((item) => buildNetworkManifest(item as Record<string, unknown>)));
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

  const targetVolumeRows = await listInventoryNames(input.targetHostId, "volume");
  const targetVolumes = new Set(targetVolumeRows.map((row) => row.name));
  const targetContainerRows = await listInventoryNames(input.targetHostId, "container");
  const targetContainers = new Set(targetContainerRows.map((row) => row.name));
  const targetNetworkRows = await listInventoryNames(input.targetHostId, "network");
  const targetNetworks = new Set(targetNetworkRows.map((row) => row.name));
  const sourceNetworkRows = await listInventoryNames(input.sourceHostId, "network");

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

  const sourceContainerRows = await listInventoryNames(input.sourceHostId, "container");
  let manifests: ContainerManifest[] = [];
  let targetManifests: ContainerManifest[] = [];
  try {
    manifests = await inspectContainerManifests(input.sourceHostId, context.containerIds, sourceContainerRows);
    if (manifests.length !== context.containerIds.length) {
      blockingIssues.push("One or more selected source containers could not be inspected directly.");
    }
  } catch {
    blockingIssues.push("Selected source containers could not be inspected directly.");
  }
  try {
    targetManifests = await inspectContainerManifests(
      input.targetHostId,
      targetContainerRows.map((row) => row.external_id).filter(Boolean),
      targetContainerRows
    );
    if (targetManifests.length !== targetContainerRows.length) {
      blockingIssues.push("One or more target containers could not be inspected directly.");
    }
  } catch {
    blockingIssues.push("Target containers could not be inspected directly.");
  }
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
  const targetUsedPorts = usedPortsFromManifests(targetManifests);
  const portConflicts = detectPortConflicts(sourcePorts, targetUsedPorts);

  const requiredNetworks = Array.from(new Set(manifests.flatMap((container) => container.networks)));
  const requiredSourceNetworks = requiredNetworks.filter((network) =>
    network && network !== "bridge" && network !== "host" && network !== "none"
  );
  let sourceNetworkManifests: NetworkManifest[] = [];
  let targetNetworkManifests: NetworkManifest[] = [];
  const sourceNetworkSnapshotNames = new Set(sourceNetworkRows.map((row) => row.name));
  const missingSourceNetworkSnapshots = requiredSourceNetworks.filter((name) => !sourceNetworkSnapshotNames.has(name));
  if (missingSourceNetworkSnapshots.length) {
    blockingIssues.push(
      `Source network definitions are missing for: ${missingSourceNetworkSnapshots.sort().join(", ")}.`
    );
  }
  try {
    const requiredSourceRows = sourceNetworkRows.filter((row) => requiredSourceNetworks.includes(row.name));
    sourceNetworkManifests = await inspectNetworkManifests(input.sourceHostId, requiredSourceRows);
    const inspectedNames = new Set(sourceNetworkManifests.map((network) => network.name));
    const missingInspectedNames = requiredSourceNetworks.filter((name) => !inspectedNames.has(name));
    if (missingInspectedNames.length) {
      blockingIssues.push(
        `Source network definitions could not be inspected for: ${missingInspectedNames.sort().join(", ")}.`
      );
    }
  } catch {
    blockingIssues.push("Source network definitions could not be inspected directly.");
  }
  try {
    targetNetworkManifests = await inspectNetworkManifests(input.targetHostId, targetNetworkRows);
    const inspectedNames = new Set(targetNetworkManifests.map((network) => network.name));
    const missingInspectedNames = targetNetworkRows
      .map((row) => row.name)
      .filter((name) => !inspectedNames.has(name));
    if (missingInspectedNames.length) {
      blockingIssues.push(
        `Target network definitions could not be inspected for: ${missingInspectedNames.sort().join(", ")}.`
      );
    }
  } catch {
    blockingIssues.push("Target network definitions could not be inspected directly.");
  }
  const missingNetworks = requiredNetworks.filter((network) => network && !targetNetworks.has(network) && network !== "bridge" && network !== "host");
  const networkConflicts = detectNetworkConflicts(
    manifests,
    collectNetworkIpUsage(targetManifests.map((manifest) => ({
      name: manifest.name,
      data: {
        NetworkSettings: {
          Networks: Object.fromEntries((manifest.networkAttachments ?? []).map((attachment) => [attachment.name, {
            IPAddress: attachment.ipAddress,
            Aliases: attachment.aliases
          }]))
        }
      }
    })))
  );
  if (networkConflicts.length) {
    warnings.push(`Detected ${networkConflicts.length} static IP conflict(s) if existing target networks are reused.`);
  }

  let estimatedArtifacts = 1;
  if (context.composeYaml) estimatedArtifacts += 1;
  if (context.env) estimatedArtifacts += 1;
  estimatedArtifacts += context.volumeNames.length;
  estimatedArtifacts += hostFolderSources.size;

  const sourceFingerprint = fingerprint({
    host: sourceCheck,
    appIdentity: input.sourceAppIdentity,
    context: {
      projectName: context.projectName,
      stackId: context.stackId,
      workingDir: context.workingDir,
      composePath: context.composePath,
      containerIds: [...context.containerIds].sort(),
      volumeNames: [...context.volumeNames].sort(),
      composeYamlFingerprint: fingerprint(context.composeYaml ?? ""),
      envFingerprint: fingerprint(context.env ?? "")
    },
    manifests: [...manifests]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(sanitizedManifestForFingerprint),
    networks: [...sourceNetworkManifests]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(sanitizedNetworkForFingerprint)
  });
  const targetFingerprint = fingerprint({
    host: targetCheck,
    volumes: targetVolumeRows.map((row) => row.name).sort(),
    containers: [...targetManifests]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(sanitizedManifestForFingerprint),
    networks: [...targetNetworkManifests]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(sanitizedNetworkForFingerprint)
  });

  return migrationPlanSchema.parse({
    sourceHostId: input.sourceHostId,
    targetHostId: input.targetHostId,
    sourceAppIdentity: input.sourceAppIdentity,
    intent: normalizeMigrationIntent(input),
    sourceFingerprint,
    targetFingerprint,
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
    intent: normalizeMigrationIntent(input),
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
