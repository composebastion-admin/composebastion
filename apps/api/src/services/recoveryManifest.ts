import path from "node:path";
import type { RecoveryAppIdentity } from "@composebastion/shared";

export type ContainerRunningState = {
  id: string;
  name: string;
  running: boolean;
};

export type BindMountRef = {
  source: string;
  destination: string;
  readOnly: boolean;
};

export type HostFolderArtifactRef = BindMountRef & {
  role?: "bind_mount" | "compose_working_dir";
  restorePath?: string | null;
};

export type VolumeMountRef = {
  name: string;
  destination: string;
  readOnly: boolean;
};

export type ContainerManifest = {
  id: string;
  name: string;
  image: string;
  state: string;
  running: boolean;
  ports: Array<{ host: string | null; container: string; protocol: string }>;
  networks: string[];
  networkAttachments?: Array<{
    name: string;
    ipAddress: string | null;
    globalIPv6Address: string | null;
    gateway: string | null;
    macAddress: string | null;
    aliases: string[];
    ipamConfig: Record<string, unknown> | null;
  }>;
  labels: Record<string, string>;
  restartPolicy: string;
  env: string[];
  volumes: VolumeMountRef[];
  bindMounts: BindMountRef[];
  entrypoint: string[];
  command: string[];
  user: string | null;
  workingDir: string | null;
};

export type NetworkManifest = {
  name: string;
  id: string | null;
  driver: string | null;
  scope: string | null;
  internal: boolean;
  attachable: boolean;
  ingress: boolean;
  enableIPv6: boolean;
  ipam: {
    driver: string | null;
    options: Record<string, unknown>;
    config: Array<Record<string, unknown>>;
  };
  labels: Record<string, string>;
  options: Record<string, unknown>;
};

export type RecoveryManifest = {
  version: 2;
  recoveryPointId: string;
  hostId: string;
  appIdentity: RecoveryAppIdentity;
  captureMode: "online" | "stop-first";
  originalRunningState: ContainerRunningState[];
  docker: {
    serverVersion: string | null;
    composeVersion: string | null;
  };
  compose: {
    projectName: string | null;
    stackId: string | null;
    workingDir: string | null;
    composePath: string | null;
    yaml: string | null;
    env: string | null;
  };
  containers: ContainerManifest[];
  networks: NetworkManifest[];
  imageReferences: string[];
  artifacts: Array<{ kind: string; storageKey: string; metadata: Record<string, unknown> }>;
  profile: Record<string, unknown> | null;
  restoreOptions: {
    defaultNetworkMode: "clone";
    inPlaceRestoreEnabled: false;
  };
  capturedAt: string;
};

const BLOCKED_BIND_MOUNT_PREFIXES = [
  "/etc/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/boot/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/var/run/",
  "/var/lib/docker/",
  "/root/",
  "/snap/",
  "/System/",
  "/private/"
];

const BLOCKED_BIND_MOUNT_EXACT = new Set(["/", "/var/run/docker.sock"]);

export function normalizeBindMountPath(hostPath: string) {
  const normalized = path.posix.normalize(hostPath.replace(/\\/g, "/"));
  if (!normalized.startsWith("/")) return normalized;
  return normalized.replace(/\/+$/, "") || "/";
}

export function isAllowedBindMountPath(hostPath: string) {
  const normalized = normalizeBindMountPath(hostPath);
  if (!normalized || BLOCKED_BIND_MOUNT_EXACT.has(normalized)) return false;
  if (normalized.includes("..")) return false;
  for (const prefix of BLOCKED_BIND_MOUNT_PREFIXES) {
    const bare = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    if (normalized === bare || normalized.startsWith(prefix)) return false;
  }
  return true;
}

export function filterBindMounts(mounts: BindMountRef[]) {
  return mounts.filter((mount) => isAllowedBindMountPath(mount.source));
}

export function isHostPathInside(parentPath: string, childPath: string) {
  const parent = normalizeBindMountPath(parentPath).replace(/\/+$/, "") || "/";
  const child = normalizeBindMountPath(childPath);
  return child === parent || child.startsWith(`${parent}/`);
}

export function composeWorkingDirHostFolder(workingDir: string | null): HostFolderArtifactRef | null {
  if (!workingDir) return null;
  const normalized = normalizeBindMountPath(workingDir);
  if (!normalized.startsWith("/") || !isAllowedBindMountPath(normalized)) return null;
  return {
    source: normalized,
    destination: "",
    readOnly: false,
    role: "compose_working_dir",
    restorePath: normalized
  };
}

export function recordRunningStates(inspects: Array<{ id: string; inspect: Record<string, unknown> }>): ContainerRunningState[] {
  return inspects.map(({ id, inspect }) => {
    const state = inspect.State as Record<string, unknown> | undefined;
    const config = inspect.Config as Record<string, unknown> | undefined;
    const name = String(inspect.Name ?? config?.Hostname ?? id).replace(/^\//, "");
    return {
      id,
      name,
      running: Boolean(state?.Running)
    };
  });
}

export function wasAnyContainerRunning(states: ContainerRunningState[]) {
  return states.some((state) => state.running);
}

export function containersToRestart(states: ContainerRunningState[]) {
  return states.filter((state) => state.running).map((state) => state.id);
}

function labelsFromInspect(inspect: Record<string, unknown>) {
  const labels = (inspect.Config as Record<string, unknown> | undefined)?.Labels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]));
}

function portsFromInspect(inspect: Record<string, unknown>) {
  const ports = (inspect.NetworkSettings as Record<string, unknown> | undefined)?.Ports as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined;
  if (!ports) return [];
  const mapped: ContainerManifest["ports"] = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (!bindings?.length) continue;
    const [rawContainer, rawProtocol] = containerPort.includes("/") ? containerPort.split("/") : [containerPort, "tcp"];
    const container = rawContainer || containerPort;
    const protocol = rawProtocol || "tcp";
    for (const binding of bindings) {
      mapped.push({
        host: binding.HostPort ? `${binding.HostIp && binding.HostIp !== "0.0.0.0" ? `[${binding.HostIp}]` : ""}${binding.HostPort}` : null,
        container,
        protocol
      });
    }
  }
  return mapped;
}

function networksFromInspect(inspect: Record<string, unknown>) {
  const networks = (inspect.NetworkSettings as Record<string, unknown> | undefined)?.Networks as Record<string, unknown> | undefined;
  return networks ? Object.keys(networks) : [];
}

function networkAttachmentsFromInspect(inspect: Record<string, unknown>): ContainerManifest["networkAttachments"] {
  const networks = (inspect.NetworkSettings as Record<string, unknown> | undefined)?.Networks as Record<string, unknown> | undefined;
  if (!networks) return [];
  return Object.entries(networks).map(([name, value]) => {
    const network = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return {
      name,
      ipAddress: network.IPAddress ? String(network.IPAddress) : null,
      globalIPv6Address: network.GlobalIPv6Address ? String(network.GlobalIPv6Address) : null,
      gateway: network.Gateway ? String(network.Gateway) : null,
      macAddress: network.MacAddress ? String(network.MacAddress) : null,
      aliases: Array.isArray(network.Aliases) ? network.Aliases.map(String).filter(Boolean) : [],
      ipamConfig: network.IPAMConfig && typeof network.IPAMConfig === "object" && !Array.isArray(network.IPAMConfig)
        ? network.IPAMConfig as Record<string, unknown>
        : null
    };
  });
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(plainRecord(value)).map(([key, item]) => [key, String(item)])
  );
}

export function buildNetworkManifest(inspect: Record<string, unknown>, fallbackName?: string): NetworkManifest {
  const ipam = plainRecord(inspect.IPAM);
  const ipamConfig = Array.isArray(ipam.Config)
    ? ipam.Config.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item) => item as Record<string, unknown>)
    : [];
  return {
    name: String(inspect.Name ?? fallbackName ?? ""),
    id: inspect.Id ? String(inspect.Id) : null,
    driver: inspect.Driver ? String(inspect.Driver) : null,
    scope: inspect.Scope ? String(inspect.Scope) : null,
    internal: Boolean(inspect.Internal),
    attachable: Boolean(inspect.Attachable),
    ingress: Boolean(inspect.Ingress),
    enableIPv6: Boolean(inspect.EnableIPv6),
    ipam: {
      driver: ipam.Driver ? String(ipam.Driver) : null,
      options: plainRecord(ipam.Options),
      config: ipamConfig
    },
    labels: stringRecord(inspect.Labels),
    options: plainRecord(inspect.Options)
  };
}

export function extractMountsFromInspect(inspect: Record<string, unknown>) {
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts as Array<Record<string, unknown>> : [];
  const volumes: VolumeMountRef[] = mounts
    .filter((mount) => mount.Type === "volume" && mount.Name)
    .map((mount) => ({
      name: String(mount.Name),
      destination: String(mount.Destination ?? ""),
      readOnly: mount.RW === false
    }));
  const bindMounts = filterBindMounts(
    mounts
      .filter((mount) => mount.Type === "bind" && mount.Source)
      .map((mount) => ({
        source: String(mount.Source),
        destination: String(mount.Destination ?? ""),
        readOnly: mount.RW === false
      }))
  );
  return { volumes, bindMounts };
}

export function buildContainerManifest(inspect: Record<string, unknown>): ContainerManifest {
  const config = inspect.Config as Record<string, unknown> | undefined;
  const hostConfig = inspect.HostConfig as Record<string, unknown> | undefined;
  const state = inspect.State as Record<string, unknown> | undefined;
  const { volumes, bindMounts } = extractMountsFromInspect(inspect);
  const restartPolicy = (hostConfig?.RestartPolicy as Record<string, unknown> | undefined)?.Name;
  const entrypoint = Array.isArray(config?.Entrypoint) ? config.Entrypoint.map(String) : [];
  const command = Array.isArray(config?.Cmd) ? config.Cmd.map(String) : [];
  return {
    id: String(inspect.Id ?? ""),
    name: String(inspect.Name ?? "").replace(/^\//, ""),
    image: String(config?.Image ?? ""),
    state: String(state?.Status ?? (state?.Running ? "running" : "unknown")),
    running: Boolean(state?.Running),
    ports: portsFromInspect(inspect),
    networks: networksFromInspect(inspect),
    networkAttachments: networkAttachmentsFromInspect(inspect),
    labels: labelsFromInspect(inspect),
    restartPolicy: restartPolicy ? String(restartPolicy) : "no",
    env: Array.isArray(config?.Env) ? config.Env.map(String) : [],
    volumes,
    bindMounts,
    entrypoint,
    command,
    user: config?.User ? String(config.User) : null,
    workingDir: config?.WorkingDir ? String(config.WorkingDir) : null
  };
}

export function buildRecoveryManifest(input: {
  recoveryPointId: string;
  hostId: string;
  appIdentity: RecoveryAppIdentity;
  captureMode: "online" | "stop-first";
  originalRunningState: ContainerRunningState[];
  docker: RecoveryManifest["docker"];
	  compose: RecoveryManifest["compose"];
	  containers: ContainerManifest[];
	  networks?: NetworkManifest[];
	  artifacts: RecoveryManifest["artifacts"];
	  profile?: Record<string, unknown> | null;
	  capturedAt?: string;
	}): RecoveryManifest {
  const imageReferences = Array.from(new Set(input.containers.map((container) => container.image).filter(Boolean)));
  return {
    version: 2,
    recoveryPointId: input.recoveryPointId,
    hostId: input.hostId,
    appIdentity: input.appIdentity,
    captureMode: input.captureMode,
    originalRunningState: input.originalRunningState,
    docker: input.docker,
    compose: input.compose,
    containers: input.containers,
    networks: input.networks ?? [],
    imageReferences,
    artifacts: input.artifacts,
    profile: input.profile ?? null,
    restoreOptions: {
      defaultNetworkMode: "clone",
      inPlaceRestoreEnabled: false
    },
    capturedAt: input.capturedAt ?? new Date().toISOString()
  };
}

export function sanitizeArtifactName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

export function bindMountArtifactName(sourcePath: string) {
  return sanitizeArtifactName(normalizeBindMountPath(sourcePath).replace(/^\//, "").replace(/\//g, "_"));
}
