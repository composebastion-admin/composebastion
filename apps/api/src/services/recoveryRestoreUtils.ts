import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import type { ContainerManifest } from "./recoveryManifest.js";
import { isAllowedBindMountPath, normalizeBindMountPath } from "./recoveryManifest.js";
import { shQuote } from "./commands.js";

export const MANAGED_RESTORE_ROOT = "/var/lib/dockermender/restores";

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
}) {
  if (typeof input.restorePath === "string" && input.restorePath.trim()) {
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
    const oldKey = portKey(conflict.hostPort, conflict.protocol);
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

function remapVolumeString(value: string, mappings: { volumes: Record<string, string>; bindMounts: Record<string, string> }) {
  const parts = value.split(":");
  if (parts.length < 2) return value;
  const source = parts[0] ?? "";
  const replacement = mappings.bindMounts[source] ?? mappings.volumes[source];
  return replacement ? [replacement, ...parts.slice(1)].join(":") : value;
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
    portRemap?: Record<string, string>;
    networks?: Record<string, string>;
  }
) {
  const volumes = mappings.volumes ?? {};
  const bindMounts = mappings.bindMounts ?? {};
  const portRemap = mappings.portRemap ?? {};
  const networks = mappings.networks ?? {};
  if (
    !Object.keys(volumes).length &&
    !Object.keys(bindMounts).length &&
    !Object.keys(portRemap).length &&
    !Object.keys(networks).length
  ) {
    return yaml;
  }

  try {
    const document = parseDocument(yaml, { keepSourceTokens: true });
    const root = document.contents;
    if (!isMap(root)) return yaml;

    const services = getMapValue(root, "services");
    if (isMap(services)) {
      for (const service of services.items) {
        if (!isMap(service.value)) continue;
        const serviceVolumes = getMapValue(service.value, "volumes");
        if (isSeq(serviceVolumes)) {
          for (const item of serviceVolumes.items) {
            const raw = scalarString(item);
            if (raw) {
              setScalarString(item, remapVolumeString(raw, { volumes, bindMounts }));
              continue;
            }
            if (!isMap(item)) continue;
            const source = getMapValue(item, "source");
            const sourceValue = scalarString(source);
            const replacement = sourceValue ? bindMounts[sourceValue] ?? volumes[sourceValue] : null;
            if (replacement) setScalarString(source, replacement);
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
          }
        }
      }
    }

    const topVolumes = getMapValue(root, "volumes");
    if (isMap(topVolumes)) {
      for (const [oldName, newName] of Object.entries(volumes)) {
        if (!topVolumes.has(oldName)) continue;
        const value = topVolumes.get(oldName, true);
        topVolumes.delete(oldName);
        topVolumes.set(newName, value ?? {});
      }
    }

    const topNetworks = getMapValue(root, "networks");
    if (isMap(topNetworks)) {
      for (const [oldName, newName] of Object.entries(networks)) {
        if (oldName === newName || !topNetworks.has(oldName)) continue;
        const value = topNetworks.get(oldName, true);
        topNetworks.delete(oldName);
        if (isMap(value)) {
          const explicitName = getMapValue(value, "name");
          if (explicitName) setScalarString(explicitName, newName);
          else value.set("name", newName);
          topNetworks.set(newName, value);
        } else {
          topNetworks.set(newName, { name: newName });
        }
      }
    }

    return String(document);
  } catch {
    let result = yaml;
    for (const [oldPath, newPath] of Object.entries(bindMounts)) {
      result = result.split(oldPath).join(newPath);
    }
    for (const [oldName, newName] of Object.entries(networks)) {
      result = result.replace(new RegExp(`(^|\\s)${escapeRegex(oldName)}:`, "gm"), `$1${newName}:`);
    }
    for (const [oldPort, newPort] of Object.entries(portRemap)) {
      result = result.replace(new RegExp(`(["']?)(\\d*:?)${escapeRegex(oldPort)}:`, "g"), `$1$2${newPort}:`);
      result = result.replace(new RegExp(`(^|\\s)${escapeRegex(oldPort)}:`, "gm"), `$1${newPort}:`);
    }
    return result;
  }
}

export function shouldRestartSourceAfterFailure(input: {
  strategy: "safe_move" | "warm_move" | "clone";
  sourceWasStopped: boolean;
  sourceHadRunningContainers: boolean;
}) {
  return input.sourceWasStopped && input.sourceHadRunningContainers && input.strategy !== "clone";
}
