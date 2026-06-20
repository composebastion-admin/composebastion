import type { ComposeStack, DockerApp, DockerHost, ResourceSnapshot } from "@dockermender/shared";
import { containerData, containerStateLabel } from "@dockermender/shared";

// A "service" is every container that came up from one compose file (one
// `docker compose up`) or one standalone `docker run`. Compose containers are
// grouped by their `com.docker.compose.project` label; everything else is its
// own single-container group.

const SEP = "|";

export type ServiceGroupKind = "compose" | "standalone";
export type ServiceGroupStatus = "running" | "partial" | "stopped";
export type ServiceStateFilter = "all" | "running" | "stopped";

export type ServiceMember = {
  resource: ResourceSnapshot;
  externalId: string;
  serviceName: string;
  containerName: string;
  image: string;
  rawState: string;
  state: string;
  ports: string;
  mounts: ServiceDataMount[];
};

export type ServiceDataMount = {
  type: "volume" | "bind" | "tmpfs" | "compose_working_dir";
  source: string | null;
  name: string | null;
  destination: string;
  readOnly: boolean;
  containerName: string | null;
};

export type ServiceGroup = {
  key: string;
  kind: ServiceGroupKind;
  projectName: string | null;
  name: string;
  hostId: string;
  hostName: string;
  hostHostname: string;
  stack: ComposeStack | null;
  configFile: string | null;
  workingDir: string | null;
  members: ServiceMember[];
  status: ServiceGroupStatus;
  runningCount: number;
  totalCount: number;
  images: string[];
  ports: string;
  dataMounts: ServiceDataMount[];
  dataWarnings: string[];
};

// Container labels arrive either as a `{ key: value }` object or, more commonly
// from `docker ps --format '{{json .}}'`, as a single comma-joined string.
export function parseContainerLabels(value: unknown): Record<string, string> {
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

function cleanName(value: string) {
  return value.replace(/^\//, "").trim();
}

function memberFrom(resource: ResourceSnapshot, labels: Record<string, string>): ServiceMember {
  const data = containerData(resource);
  const containerName = cleanName(String(data.Names ?? resource.name ?? ""));
  const serviceName = labels["com.docker.compose.service"] || containerName || "service";
  const rawState = String(data.State ?? "");
  return {
    resource,
    externalId: resource.externalId,
    serviceName,
    containerName,
    image: String(data.Image ?? ""),
    rawState,
    state: containerStateLabel(rawState),
    ports: String(data.Ports ?? ""),
    mounts: dataMountsFromResource(data, containerName)
  };
}

function dataMountsFromResource(data: Record<string, unknown>, containerName: string): ServiceDataMount[] {
  if (!Array.isArray(data.Mounts)) return [];
  return data.Mounts.flatMap((mount: any) => {
    const type = mount.Type === "volume" ? "volume" : mount.Type === "bind" ? "bind" : mount.Type === "tmpfs" ? "tmpfs" : null;
    if (!type) return [];
    return [{
      type,
      source: mount.Source ? String(mount.Source) : null,
      name: mount.Name ? String(mount.Name) : null,
      destination: String(mount.Destination ?? ""),
      readOnly: mount.RW === false,
      containerName
    }];
  });
}

const databaseHints = ["postgres", "mysql", "mariadb", "mongo", "redis", "valkey", "influxdb", "clickhouse", "elasticsearch", "opensearch"];

function looksDatabaseLike(member: ServiceMember) {
  const text = `${member.serviceName} ${member.containerName} ${member.image}`.toLowerCase();
  return databaseHints.some((hint) => text.includes(hint));
}

function firstConfigFile(value: string | undefined) {
  return value?.split(",")[0]?.trim() || null;
}

export function groupServices(
  containers: ResourceSnapshot[],
  stacks: ComposeStack[],
  hosts: DockerHost[]
): ServiceGroup[] {
  const hostById = new Map(hosts.map((host) => [host.id, host]));
  const stackByKey = new Map(stacks.map((stack) => [`${stack.hostId}${SEP}${stack.projectName}`, stack]));
  const groups = new Map<string, ServiceGroup>();

  for (const resource of containers) {
    if (resource.kind !== "container") continue;
    const labels = parseContainerLabels((resource.data as Record<string, unknown> | undefined)?.Labels);
    const project = labels["com.docker.compose.project"] || null;
    const host = hostById.get(resource.hostId);
    const member = memberFrom(resource, labels);
    const key = project
      ? `${resource.hostId}${SEP}${project}`
      : `${resource.hostId}${SEP}container:${resource.externalId}`;

    let group = groups.get(key);
    if (!group) {
      const stack = project ? stackByKey.get(key) ?? null : null;
      group = {
        key,
        kind: project ? "compose" : "standalone",
        projectName: project,
        name: project ? stack?.name || project : member.serviceName || member.containerName,
        hostId: resource.hostId,
        hostName: host?.name ?? "Unknown host",
        hostHostname: host?.hostname ?? "localhost",
        stack,
        configFile: firstConfigFile(labels["com.docker.compose.project.config_files"]),
        workingDir: labels["com.docker.compose.project.working_dir"] || stack?.sourceWorkingDir || null,
        members: [],
        status: "stopped",
        runningCount: 0,
        totalCount: 0,
        images: [],
        ports: "",
        dataMounts: [],
        dataWarnings: []
      };
      groups.set(key, group);
    } else {
      if (!group.configFile) group.configFile = firstConfigFile(labels["com.docker.compose.project.config_files"]);
      if (!group.workingDir && labels["com.docker.compose.project.working_dir"]) {
        group.workingDir = labels["com.docker.compose.project.working_dir"];
      }
    }
    group.members.push(member);
  }

  // Managed/discovered stacks with no live containers still deserve a card so the
  // user can deploy or clean them up.
  for (const stack of stacks) {
    const key = `${stack.hostId}${SEP}${stack.projectName}`;
    if (groups.has(key)) continue;
    const host = hostById.get(stack.hostId);
    groups.set(key, {
      key,
      kind: "compose",
      projectName: stack.projectName,
      name: stack.name || stack.projectName,
      hostId: stack.hostId,
      hostName: host?.name ?? "Unknown host",
      hostHostname: host?.hostname ?? "localhost",
      stack,
      configFile: null,
      workingDir: stack.sourceWorkingDir ?? null,
      members: [],
      status: "stopped",
      runningCount: 0,
      totalCount: 0,
      images: [],
      ports: "",
      dataMounts: [],
      dataWarnings: []
    });
  }

  const result = Array.from(groups.values());
  for (const group of result) {
    group.members.sort((left, right) =>
      left.serviceName.localeCompare(right.serviceName) || left.containerName.localeCompare(right.containerName)
    );
    group.totalCount = group.members.length;
    group.runningCount = group.members.filter((member) => member.state === "running").length;
    group.status =
      group.totalCount === 0 || group.runningCount === 0
        ? "stopped"
        : group.runningCount === group.totalCount
          ? "running"
          : "partial";
    group.images = Array.from(new Set(group.members.map((member) => member.image).filter(Boolean)));
    group.ports = group.members.map((member) => member.ports).filter(Boolean).join(", ");
    const mounts = group.members.flatMap((member) => member.mounts);
    if (group.workingDir) {
      mounts.push({
        type: "compose_working_dir",
        source: group.workingDir,
        name: null,
        destination: "",
        readOnly: false,
        containerName: null
      });
    }
    const seenMounts = new Set<string>();
    group.dataMounts = mounts.filter((mount) => {
      const key = `${mount.type}:${mount.source ?? mount.name ?? ""}:${mount.destination}`;
      if (seenMounts.has(key)) return false;
      seenMounts.add(key);
      return true;
    });
    group.dataWarnings = group.members
      .filter((member) => looksDatabaseLike(member) && member.mounts.filter((mount) => mount.type === "volume" || mount.type === "bind").length === 0)
      .map((member) => `${member.serviceName} looks database-like but has no detected persistent data mount.`);
  }

  return result.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "compose" ? -1 : 1;
    return left.name.localeCompare(right.name) || left.hostName.localeCompare(right.hostName);
  });
}

export function filterServiceGroups(groups: ServiceGroup[], query: string, stateFilter: ServiceStateFilter): ServiceGroup[] {
  const normalized = query.trim().toLowerCase();
  return groups.filter((group) => {
    if (stateFilter === "running" && group.runningCount === 0) return false;
    if (stateFilter === "stopped" && group.runningCount > 0) return false;
    if (!normalized) return true;
    if (group.name.toLowerCase().includes(normalized)) return true;
    if (group.projectName?.toLowerCase().includes(normalized)) return true;
    if (group.hostName.toLowerCase().includes(normalized)) return true;
    return group.members.some((member) =>
      member.serviceName.toLowerCase().includes(normalized) ||
      member.containerName.toLowerCase().includes(normalized) ||
      member.image.toLowerCase().includes(normalized)
    );
  });
}

export function summarizeServiceGroups(groups: ServiceGroup[]) {
  let totalContainers = 0;
  let runningContainers = 0;
  let runningServices = 0;
  let partialServices = 0;
  for (const group of groups) {
    totalContainers += group.totalCount;
    runningContainers += group.runningCount;
    if (group.status === "running") runningServices += 1;
    else if (group.status === "partial") partialServices += 1;
  }
  return {
    totalServices: groups.length,
    runningServices,
    partialServices,
    totalContainers,
    runningContainers
  };
}

export function findAppForServiceGroup(group: ServiceGroup, apps: DockerApp[]) {
  const memberIds = new Set(group.members.map((member) => member.externalId));
  const candidates = apps.filter((app) => {
    if (app.hostId !== group.hostId) return false;
    if (group.stack?.id && app.stackId === group.stack.id) return true;
    if (group.projectName && app.projectName === group.projectName) return true;
    if (app.primaryContainerId && memberIds.has(app.primaryContainerId)) return true;
    return app.containerIds.some((containerId) => memberIds.has(containerId));
  });

  return candidates.sort((left, right) => {
    const leftPriority = left.update.status === "update_available" ? 0 : left.update.status === "error" ? 1 : 2;
    const rightPriority = right.update.status === "update_available" ? 0 : right.update.status === "error" ? 1 : 2;
    return leftPriority - rightPriority || left.name.localeCompare(right.name);
  })[0] ?? null;
}

export function isSelfManagementServiceGroup(group: ServiceGroup) {
  const projectName = group.projectName?.toLowerCase() ?? "";
  const groupName = group.name.toLowerCase();
  const looksLikeSelfManagedProject = ["dockermender", "docker-manager", "docker_manager"].includes(projectName || groupName);
  if (!looksLikeSelfManagedProject) return false;

  return group.members.some((member) => {
    const serviceName = member.serviceName.toLowerCase();
    const containerName = member.containerName.toLowerCase();
    const image = member.image.toLowerCase();
    return (
      serviceName === "app" ||
      serviceName === "worker" ||
      containerName.includes("dockermender-app") ||
      containerName.includes("dockermender-worker") ||
      image.includes("dockermender-app") ||
      image.includes("dockermender-worker")
    );
  });
}
