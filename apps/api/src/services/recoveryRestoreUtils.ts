import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import type { ContainerManifest } from "./recoveryManifest.js";
import { isAllowedBindMountPath, normalizeBindMountPath } from "./recoveryManifest.js";
import { shQuote } from "./commands.js";

export const MANAGED_RESTORE_ROOT = "/var/lib/composebastion/restores";

export type PublishedPort = {
  hostPort: string;
  protocol: string;
  containerName: string | null;
};

export type PortConflict = {
  hostPort: string;
  protocol: string;
  sourceContainer: string | null;
  reason: string;
};

export type ComposeServiceBindMounts = Record<string, Record<string, string>>;

export function shortRestoreId(recoveryPointId: string) {
  return recoveryPointId.replace(/-/g, "").slice(0, 8);
}

export function buildCloneRestoreProjectName(originalProjectName: string, recoveryPointId: string) {
  const suffix = `-restore-${shortRestoreId(recoveryPointId)}`;
  const maxBase = Math.max(1, 80 - suffix.length);
  const base = originalProjectName.replace(/[^a-z0-9][^a-z0-9_-]*/gi, "").toLowerCase().slice(0, maxBase)
    || originalProjectName.slice(0, maxBase).replace(/[^a-z0-9_-]/g, "");
  return `${base || "app"}${suffix}`.slice(0, 80);
}

export function sanitizeDockerName(value: string, maxLength = 255) {
  return value.replace(/[^a-zA-Z0-9][^a-zA-Z0-9_.-]*/g, "_").replace(/^_+|_+$/g, "").slice(0, maxLength) || "restore";
}

export function buildCloneVolumeName(originalVolumeName: string, restoreProjectName: string) {
  const suffix = `_${sanitizeDockerName(originalVolumeName, 120)}`;
  const prefix = sanitizeDockerName(restoreProjectName, Math.max(1, 255 - suffix.length));
  return `${prefix}${suffix}`;
}

export function composeVolumeNameFromEngineName(engineVolumeName: string, sourceProjectName: string | null | undefined) {
  if (!sourceProjectName) return engineVolumeName;
  const prefix = `${sourceProjectName}_`;
  if (engineVolumeName.startsWith(prefix) && engineVolumeName.length > prefix.length) {
    return engineVolumeName.slice(prefix.length);
  }
  return engineVolumeName;
}

export function buildComposeProjectVolumeName(projectName: string, composeVolumeName: string) {
  const suffix = `_${composeVolumeName.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "data"}`;
  const prefix = (projectName.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, Math.max(1, 255 - suffix.length)) || "restore");
  return `${prefix}${suffix}`;
}

export function buildManagedRestoreBindPath(restoreRoot: string, recoveryPointId: string, sourcePath: string) {
  const normalized = normalizeBindMountPath(sourcePath);
  const relative = normalized.replace(/^\//, "").replace(/\//g, "_") || "root";
  return path.posix.join(restoreRoot.replace(/\/+$/, ""), recoveryPointId, relative);
}

export function assertAllowedHostFolderTargetPath(targetPath: string) {
  const normalized = normalizeBindMountPath(targetPath);
  if (!normalized.startsWith("/") || !isAllowedBindMountPath(normalized)) {
    throw new Error(`Host folder restore target ${normalized} is not allowed.`);
  }
  return normalized;
}

export function resolveHostFolderRestorePath(input: {
  restoreRoot: string;
  recoveryPointId: string;
  sourcePath: string;
  restorePath?: unknown;
  forceManaged?: boolean;
}) {
  if (!input.forceManaged && typeof input.restorePath === "string" && input.restorePath.trim()) {
    return assertAllowedHostFolderTargetPath(input.restorePath);
  }
  return buildManagedRestoreBindPath(input.restoreRoot, input.recoveryPointId, input.sourcePath);
}

export function assertAllowedRestoreRoot(restoreRoot?: string) {
  const normalized = path.posix.normalize((restoreRoot ?? MANAGED_RESTORE_ROOT).replace(/\\/g, "/"));
  if (normalized === MANAGED_RESTORE_ROOT || normalized.startsWith(`${MANAGED_RESTORE_ROOT}/`)) {
    return normalized;
  }
  throw new Error(`Restore root ${normalized} is not allowed. Use ${MANAGED_RESTORE_ROOT}.`);
}

export function buildBindMountCaptureCommand(sourcePath: string, excludePatterns: string[] = []) {
  const normalized = path.posix.normalize(sourcePath);
  const excludes = excludePatterns
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => `--exclude=${shQuote(pattern)}`)
    .join(" ");
  return ["tar czf -", excludes, `-C ${shQuote(normalized)} .`].filter(Boolean).join(" ");
}

export function buildBindMountRestoreCommand(targetPath: string) {
  const normalized = path.posix.normalize(targetPath);
  return `mkdir -p ${shQuote(normalized)} && tar xzf - -C ${shQuote(normalized)}`;
}

export function buildCloneContainerName(originalName: string, restoreProjectName: string) {
  const suffix = `_${sanitizeDockerName(originalName, 120)}`;
  const prefix = sanitizeDockerName(restoreProjectName, Math.max(1, 255 - suffix.length));
  return `${prefix}${suffix}`.slice(0, 255);
}

function remapHostPortValue(hostPort: string | null, portRemap: Record<string, string>) {
  if (!hostPort) return null;
  const numeric = hostPort.replace(/^\[.*\]/, "").replace(/^.*:/, "");
  const remapped = portRemap[numeric] ?? numeric;
  if (hostPort.includes(":")) {
    return hostPort.replace(numeric, remapped);
  }
  return remapped;
}

export function buildStandaloneContainerCreateCommand(input: {
  container: ContainerManifest;
  name: string;
  volumeMap: Record<string, string>;
  bindMap: Record<string, string>;
  portRemap: Record<string, string>;
  networkMap?: Record<string, string>;
}) {
  const args = ["docker create"];
  if (input.container.restartPolicy && input.container.restartPolicy !== "no") {
    args.push("--restart", shQuote(input.container.restartPolicy));
  }
  if (input.container.user) args.push("--user", shQuote(input.container.user));
  if (input.container.workingDir) args.push("--workdir", shQuote(input.container.workingDir));
  for (const env of input.container.env) args.push("--env", shQuote(env));
  for (const [key, value] of Object.entries(input.container.labels)) {
    args.push("--label", shQuote(`${key}=${value}`));
  }
  for (const port of input.container.ports) {
    if (!port.host) continue;
    const host = remapHostPortValue(port.host, input.portRemap);
    if (!host) continue;
    args.push("-p", shQuote(`${host}:${port.container}/${port.protocol}`));
  }
  for (const volume of input.container.volumes) {
    const targetVolume = input.volumeMap[volume.name] ?? volume.name;
    args.push("-v", shQuote(`${targetVolume}:${volume.destination}${volume.readOnly ? ":ro" : ""}`));
  }
  for (const bind of input.container.bindMounts) {
    const targetPath = input.bindMap[bind.source] ?? bind.source;
    args.push("-v", shQuote(`${targetPath}:${bind.destination}${bind.readOnly ? ":ro" : ""}`));
  }
  const firstNetwork = input.container.networks[0];
  if (firstNetwork) {
    const targetNetwork = input.networkMap?.[firstNetwork] ?? firstNetwork;
    args.push("--network", shQuote(targetNetwork));
    const attachment = input.container.networkAttachments?.find((item) => item.name === firstNetwork);
    if (attachment?.ipAddress && targetNetwork !== "bridge") args.push("--ip", shQuote(attachment.ipAddress));
    for (const alias of attachment?.aliases ?? []) {
      if (alias && alias !== input.container.name) args.push("--network-alias", shQuote(alias));
    }
  }
  args.push("--name", shQuote(input.name));
  if (input.container.entrypoint.length) {
    args.push("--entrypoint", shQuote(input.container.entrypoint.join(" ")));
  }
  args.push(shQuote(input.container.image));
  for (const part of input.container.command) {
    args.push(shQuote(part));
  }
  return args.join(" ");
}

export function standaloneContainerExtraNetworks(container: ContainerManifest) {
  return Array.from(new Set(container.networks.slice(1).filter((network) => network && network !== "none")));
}

export function buildStandaloneNetworkConnectCommand(
  network: string,
  containerName: string,
  options: { ipAddress?: string | null; aliases?: string[] } = {}
) {
  const args = ["docker network connect"];
  if (options.ipAddress) args.push("--ip", shQuote(options.ipAddress));
  for (const alias of options.aliases ?? []) {
    if (alias && alias !== containerName) args.push("--alias", shQuote(alias));
  }
  args.push(shQuote(network), shQuote(containerName));
  return args.join(" ");
}

export function buildStandaloneContainerStartCommand(name: string) {
  return `docker start ${shQuote(name)}`;
}

export function extractPublishedPorts(containers: ContainerManifest[]): PublishedPort[] {
  const ports: PublishedPort[] = [];
  for (const container of containers) {
    for (const port of container.ports) {
      if (!port.host) continue;
      const hostPort = port.host.replace(/^\[.*\]/, "").replace(/^.*:/, "");
      if (!hostPort) continue;
      ports.push({
        hostPort,
        protocol: port.protocol || "tcp",
        containerName: container.name || null
      });
    }
  }
  return ports;
}

export function parseInventoryPortString(ports: string, containerName: string | null = null): PublishedPort[] {
  const results: PublishedPort[] = [];
  for (const part of ports.split(",")) {
    const match = part.trim().match(/:(\d+)->\d+\/(tcp|udp)/i);
    if (!match?.[1] || !match[2]) continue;
    results.push({ hostPort: match[1], protocol: match[2].toLowerCase(), containerName });
  }
  return results;
}

export function portKey(hostPort: string, protocol: string) {
  return `${hostPort}/${protocol}`;
}

export function detectPortConflicts(
  sourcePorts: PublishedPort[],
  targetPortsInUse: Map<string, string>
): PortConflict[] {
  const conflicts: PortConflict[] = [];
  const seen = new Set<string>();
  for (const port of sourcePorts) {
    const key = portKey(port.hostPort, port.protocol);
    if (seen.has(key)) continue;
    seen.add(key);
    const occupant = targetPortsInUse.get(key);
    if (occupant) {
      conflicts.push({
        hostPort: port.hostPort,
        protocol: port.protocol,
        sourceContainer: port.containerName,
        reason: `Host port ${port.hostPort}/${port.protocol} is already used by ${occupant}`
      });
    }
  }
  return conflicts;
}

export function buildPortRemap(conflicts: PortConflict[], usedPorts: Set<string>, startAt = 18080) {
  const remap: Record<string, string> = {};
  let candidate = startAt;
  for (const conflict of conflicts) {
    while (usedPorts.has(`${candidate}/${conflict.protocol}`) || Object.values(remap).includes(String(candidate))) {
      candidate += 1;
    }
    remap[conflict.hostPort] = String(candidate);
    usedPorts.add(`${candidate}/${conflict.protocol}`);
    candidate += 1;
  }
  return remap;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scalarString(node: unknown) {
  return isScalar(node) && typeof node.value === "string" ? node.value : null;
}

function setScalarString(node: unknown, value: string) {
  if (isScalar(node)) node.value = value;
}

function getMapValue(map: YAMLMap, key: string) {
  return map.get(key, true);
}

function bindMountPathAliases(source: string) {
  const normalized = normalizeBindMountPath(source);
  const aliases = new Set([normalized]);
  if (normalized.startsWith("/host_mnt/")) {
    aliases.add(normalized.slice("/host_mnt".length));
  }
  for (const alias of [...aliases]) {
    if (alias.startsWith("/private/")) aliases.add(alias.slice("/private".length));
  }
  return [...aliases];
}

function containedRelativePath(parent: string, child: string) {
  const normalizedParent = path.posix.normalize(parent);
  const normalizedChild = path.posix.normalize(child);
  if (normalizedChild === normalizedParent) return "";
  if (!normalizedChild.startsWith(`${normalizedParent.replace(/\/+$/, "")}/`)) return null;
  const relative = path.posix.relative(normalizedParent, normalizedChild);
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) return null;
  return relative;
}

function uniqueBestBindMountMatch(matches: Array<{
  artifactSource: string;
  replacement: string;
  specificity: number;
}>, source: string) {
  if (!matches.length) return undefined;
  const bestSpecificity = Math.max(...matches.map((match) => match.specificity));
  const best = matches.filter((match) => match.specificity === bestSpecificity);
  const replacements = new Set(best.map((match) => match.replacement));
  if (replacements.size > 1) {
    throw new Error(
      `Cannot safely resolve restored bind mount ${source}: matching recovery artifacts ${best.map((match) => match.artifactSource).join(", ")} are ambiguous.`
    );
  }
  return best[0]?.replacement;
}

function bindMountSpecificity(source: string) {
  return Math.min(...bindMountPathAliases(source).map((alias) => alias.length));
}

export function resolveRestoredBindMountPath(source: string, bindMounts: Record<string, string>) {
  const exact = bindMounts[source];
  if (exact) return exact;

  const sourceAliases = bindMountPathAliases(source);
  const aliasMatches: Array<{ artifactSource: string; replacement: string; specificity: number }> = [];
  for (const [inspectedSource, replacement] of Object.entries(bindMounts)) {
    const artifactAliases = bindMountPathAliases(inspectedSource);
    if (artifactAliases.some((artifactAlias) => sourceAliases.includes(artifactAlias))) {
      aliasMatches.push({ artifactSource: inspectedSource, replacement, specificity: bindMountSpecificity(inspectedSource) });
    }
  }
  const aliasMatch = uniqueBestBindMountMatch(aliasMatches, source);
  if (aliasMatch) return aliasMatch;

  const parentMatches: Array<{ artifactSource: string; replacement: string; specificity: number }> = [];
  for (const [artifactSource, artifactTarget] of Object.entries(bindMounts)) {
    const artifactAliases = bindMountPathAliases(artifactSource);
    for (const artifactAlias of artifactAliases) {
      for (const sourceAlias of sourceAliases) {
        const relative = containedRelativePath(artifactAlias, sourceAlias);
        if (relative === null || relative === "") continue;
        const replacement = path.posix.join(artifactTarget, relative);
        if (containedRelativePath(artifactTarget, replacement) !== relative) continue;
        parentMatches.push({
          artifactSource,
          replacement,
          specificity: bindMountSpecificity(artifactSource)
        });
      }
    }
  }
  return uniqueBestBindMountMatch(parentMatches, source);
}

export function buildComposeServiceBindMounts(
  containers: ContainerManifest[],
  bindMounts: Record<string, string>
): ComposeServiceBindMounts {
  const result: ComposeServiceBindMounts = {};
  for (const container of containers) {
    const serviceName = container.labels["com.docker.compose.service"]?.trim();
    if (!serviceName) continue;
    for (const bind of container.bindMounts) {
      const replacement = resolveRestoredBindMountPath(bind.source, bindMounts);
      if (!replacement) continue;
      if (!bind.destination) {
        throw new Error(`Cannot safely remap restored bind mount for Compose service ${serviceName}: the inspected destination is empty.`);
      }
      const serviceMounts = result[serviceName] ??= {};
      const existing = serviceMounts[bind.destination];
      if (existing && existing !== replacement) {
        throw new Error(
          `Cannot safely remap restored bind mount for Compose service ${serviceName} at ${bind.destination}: replicas resolved to conflicting restored paths.`
        );
      }
      serviceMounts[bind.destination] = replacement;
    }
  }
  return result;
}

function remapVolumeString(value: string, mappings: { volumes: Record<string, string>; bindMounts: Record<string, string> }) {
  const parts = value.split(":");
  if (parts.length < 2) return value;
  const source = parts[0] ?? "";
  const replacement = resolveRestoredBindMountPath(source, mappings.bindMounts) ?? mappings.volumes[source];
  return replacement ? [replacement, ...parts.slice(1)].join(":") : value;
}

function remapServiceBindVolumeString(value: string, bindMounts: Record<string, string>) {
  const destinations = Object.keys(bindMounts).sort((left, right) => right.length - left.length);
  for (const destination of destinations) {
    const marker = `:${destination}`;
    if (value.endsWith(marker)) {
      return { value: `${bindMounts[destination]}${marker}`, destination };
    }
    const markerWithMode = `${marker}:`;
    const markerIndex = value.lastIndexOf(markerWithMode);
    if (markerIndex > 0) {
      const mode = value.slice(markerIndex + markerWithMode.length);
      if (mode && !mode.includes(":")) {
        return { value: `${bindMounts[destination]}${value.slice(markerIndex)}`, destination };
      }
    }
  }
  return null;
}

function remapComposeYamlFallback(
  yaml: string,
  mappings: {
    bindMounts: Record<string, string>;
    portRemap: Record<string, string>;
    networks: Record<string, string>;
  }
) {
  let result = yaml;
  for (const [oldPath, newPath] of Object.entries(mappings.bindMounts)) {
    result = result.split(oldPath).join(newPath);
  }
  for (const [oldName, newName] of Object.entries(mappings.networks)) {
    result = result.replace(new RegExp(`(^|\\s)${escapeRegex(oldName)}:`, "gm"), `$1${newName}:`);
  }
  for (const [oldPort, newPort] of Object.entries(mappings.portRemap)) {
    result = result.replace(new RegExp(`(["']?)(\\d*:?)${escapeRegex(oldPort)}:`, "g"), `$1$2${newPort}:`);
    result = result.replace(new RegExp(`(^|\\s)${escapeRegex(oldPort)}:`, "gm"), `$1${newPort}:`);
  }
  return result;
}

function remapPortString(value: string, portRemap: Record<string, string>) {
  const parts = value.split(":");
  if (parts.length < 2) return value;
  const containerPart = parts.at(-1) ?? "";
  const hostPart = parts.length === 2 ? parts[0] : parts.at(-2);
  if (!hostPart || !portRemap[hostPart]) return value;
  if (parts.length === 2) return [portRemap[hostPart], containerPart].join(":");
  return [...parts.slice(0, -2), portRemap[hostPart], containerPart].join(":");
}

export function remapComposeYaml(
  yaml: string,
  mappings: {
    volumes?: Record<string, string>;
    bindMounts?: Record<string, string>;
    serviceBindMounts?: ComposeServiceBindMounts;
    portRemap?: Record<string, string>;
    networks?: Record<string, string>;
    resetNetworkAddressing?: boolean;
  }
) {
  const volumes = mappings.volumes ?? {};
  const bindMounts = mappings.bindMounts ?? {};
  const serviceBindMounts = mappings.serviceBindMounts ?? {};
  const portRemap = mappings.portRemap ?? {};
  const networks = mappings.networks ?? {};
  const resetNetworkAddressing = mappings.resetNetworkAddressing ?? false;
  if (
    !Object.keys(volumes).length &&
    !Object.keys(bindMounts).length &&
    !Object.keys(serviceBindMounts).length &&
    !Object.keys(portRemap).length &&
    !Object.keys(networks).length &&
    !resetNetworkAddressing
  ) {
    return yaml;
  }

  let document;
  try {
    document = parseDocument(yaml, { keepSourceTokens: true });
    if (document.errors.length) throw document.errors[0];
  } catch (error) {
    if (Object.keys(serviceBindMounts).length) {
      throw new Error(
        `Cannot safely remap restored Compose bind mounts because the Compose YAML could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return remapComposeYamlFallback(yaml, { bindMounts, portRemap, networks });
  }

  const requiredServiceBindMounts = new Set(
    Object.entries(serviceBindMounts).flatMap(([serviceName, destinations]) =>
      Object.keys(destinations).map((destination) => `${serviceName}\u0000${destination}`)
    )
  );
  const remappedServiceBindMounts = new Set<string>();
  const root = document.contents;
  if (isMap(root)) {

    const topVolumes = getMapValue(root, "volumes");
    const services = getMapValue(root, "services");
    if (isMap(services)) {
      for (const service of services.items) {
        if (!isMap(service.value)) continue;
        const serviceName = isScalar(service.key) ? String(service.key.value ?? "") : "";
        const destinationBindMounts = serviceBindMounts[serviceName] ?? {};
        const serviceVolumes = getMapValue(service.value, "volumes");
        if (isSeq(serviceVolumes)) {
          for (const item of serviceVolumes.items) {
            const raw = scalarString(item);
            if (raw) {
              const destinationRemap = remapServiceBindVolumeString(raw, destinationBindMounts);
              if (destinationRemap) {
                setScalarString(item, destinationRemap.value);
                remappedServiceBindMounts.add(`${serviceName}\u0000${destinationRemap.destination}`);
                continue;
              }
              // Keep named-volume references on their logical Compose key.
              // The top-level definition below binds that key to the exact
              // pre-restored engine volume while preserving `down -v` cleanup.
              setScalarString(item, remapVolumeString(raw, { volumes: {}, bindMounts }));
              continue;
            }
            if (!isMap(item)) continue;
            const source = getMapValue(item, "source");
            const sourceValue = scalarString(source);
            const targetValue = scalarString(getMapValue(item, "target"));
            const destinationReplacement = targetValue ? destinationBindMounts[targetValue] : undefined;
            const replacement = destinationReplacement
              ?? (sourceValue ? resolveRestoredBindMountPath(sourceValue, bindMounts) : null);
            if (replacement && isScalar(source)) setScalarString(source, replacement);
            if (destinationReplacement && targetValue && isScalar(source)) {
              remappedServiceBindMounts.add(`${serviceName}\u0000${targetValue}`);
            }
          }
        }

        const servicePorts = getMapValue(service.value, "ports");
        if (isSeq(servicePorts)) {
          for (const item of servicePorts.items) {
            const raw = scalarString(item);
            if (raw) {
              setScalarString(item, remapPortString(raw, portRemap));
              continue;
            }
            if (!isMap(item)) continue;
            const published = getMapValue(item, "published");
            const publishedValue = isScalar(published) ? String(published.value ?? "") : null;
            if (publishedValue && portRemap[publishedValue] && isScalar(published)) {
              published.value = portRemap[publishedValue];
            }
          }
        }

        const serviceNetworks = getMapValue(service.value, "networks");
        if (isSeq(serviceNetworks)) {
          for (const item of serviceNetworks.items) {
            const raw = scalarString(item);
            if (raw && networks[raw]) setScalarString(item, networks[raw]);
          }
        } else if (isMap(serviceNetworks)) {
          for (const item of serviceNetworks.items) {
            if (!isScalar(item.key)) continue;
            const oldName = String(item.key.value ?? "");
            if (networks[oldName]) item.key.value = networks[oldName];
            if (resetNetworkAddressing && isMap(item.value)) {
              item.value.delete("ipv4_address");
              item.value.delete("ipv6_address");
              item.value.delete("link_local_ips");
            }
          }
        }
      }
    }

    if (isMap(topVolumes)) {
      const remappedDefinitions: Array<{ logicalName: string; targetName: string }> = [];
      for (const item of topVolumes.items) {
        if (!isScalar(item.key)) continue;
        const logicalName = String(item.key.value ?? "");
        if (!logicalName) continue;
        const explicitName = isMap(item.value)
          ? scalarString(getMapValue(item.value, "name"))
          : null;
        const targetName = volumes[logicalName] ?? (explicitName ? volumes[explicitName] : undefined);
        if (targetName) remappedDefinitions.push({ logicalName, targetName });
      }
      for (const { logicalName, targetName } of remappedDefinitions) {
        // The data was restored into this exact, pre-created engine volume.
        // Keep the logical key and set only `name`: marking it external would
        // prevent Compose-down-with-volumes from cleaning up the clone.
        topVolumes.set(logicalName, { name: targetName });
      }
    }

    const topNetworks = getMapValue(root, "networks");
    if (isMap(topNetworks)) {
      for (const [oldName, newName] of Object.entries(networks)) {
        if (oldName === newName || !topNetworks.has(oldName)) continue;
        const value = topNetworks.get(oldName, true);
        topNetworks.delete(oldName);
        if (isMap(value)) {
          if (resetNetworkAddressing) {
            for (const key of ["driver", "driver_opts", "attachable", "internal", "ipam", "enable_ipv4", "enable_ipv6", "labels"]) {
              value.delete(key);
            }
            value.set("external", true);
          }
          const explicitName = getMapValue(value, "name");
          if (explicitName) setScalarString(explicitName, newName);
          else value.set("name", newName);
          topNetworks.set(newName, value);
        } else {
          topNetworks.set(newName, { name: newName });
        }
      }
    }

  }

  const missingServiceBindMounts = [...requiredServiceBindMounts]
    .filter((key) => !remappedServiceBindMounts.has(key))
    .map((key) => key.split("\u0000").join(":"));
  if (missingServiceBindMounts.length) {
    throw new Error(
      `Cannot safely remap restored Compose bind mounts because these service destinations were not found: ${missingServiceBindMounts.join(", ")}`
    );
  }
  return String(document);
}

export function shouldRestartSourceAfterFailure(input: {
  strategy: "safe_move" | "warm_move" | "clone";
  sourceWasStopped: boolean;
  sourceHadRunningContainers: boolean;
}) {
  return input.sourceWasStopped && input.sourceHadRunningContainers && input.strategy !== "clone";
}
