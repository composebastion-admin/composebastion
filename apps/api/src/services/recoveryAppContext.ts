import type { RecoveryAppIdentity } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { getContainerVolumeMounts } from "./docker.js";

export type ResolvedAppContext = {
  label: string;
  projectName: string | null;
  stackId: string | null;
  composeYaml: string | null;
  env: string | null;
  workingDir: string | null;
  composePath: string | null;
  containerIds: string[];
  volumeNames: string[];
};

function readLabel(data: Record<string, unknown>, key: string) {
  const labels = data.Labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    return String((labels as Record<string, unknown>)[key] ?? "");
  }
  if (typeof labels === "string") {
    for (const pair of labels.split(",")) {
      const eq = pair.indexOf("=");
      if (eq > 0 && pair.slice(0, eq).trim() === key) return pair.slice(eq + 1);
    }
  }
  return "";
}

async function getStackRow(hostId: string, stackId: string) {
  const result = await query<any>("SELECT * FROM compose_stacks WHERE id = $1 AND host_id = $2", [stackId, hostId]);
  return result.rows[0] ?? null;
}

async function getStackByProject(hostId: string, projectName: string) {
  const result = await query<any>(
    "SELECT * FROM compose_stacks WHERE host_id = $1 AND project_name = $2",
    [hostId, projectName]
  );
  return result.rows[0] ?? null;
}

async function getRepositoryRow(repositoryId: string) {
  const result = await query<any>("SELECT * FROM github_repositories WHERE id = $1", [repositoryId]);
  return result.rows[0] ?? null;
}

async function listContainersForProject(hostId: string, projectName: string) {
  const result = await query<any>(
    `SELECT external_id, data
     FROM resource_snapshots
     WHERE host_id = $1 AND kind = 'container'`,
    [hostId]
  );
  return result.rows.filter((row: any) => readLabel(row.data ?? {}, "com.docker.compose.project") === projectName);
}

async function collectVolumeNames(hostId: string, containerIds: string[]) {
  const names = new Set<string>();
  for (const containerId of containerIds) {
    try {
      const mounts = await getContainerVolumeMounts(hostId, containerId);
      for (const mount of mounts) names.add(mount.name);
    } catch {
      // Container may be gone from inventory; capture will inspect directly.
    }
  }
  return Array.from(names);
}

export async function resolveAppContext(hostId: string, appIdentity: RecoveryAppIdentity): Promise<ResolvedAppContext> {
  if (appIdentity.kind === "stack" || appIdentity.kind === "compose") {
    const stack = appIdentity.kind === "stack"
      ? await getStackRow(hostId, appIdentity.stackId)
      : appIdentity.stackId
        ? await getStackRow(hostId, appIdentity.stackId)
        : await getStackByProject(hostId, appIdentity.projectName);
    if (appIdentity.kind === "stack" && !stack) {
      throw new Error("Compose stack not found for recovery app identity");
    }
    const projectName = stack?.project_name ?? (appIdentity.kind === "compose" ? appIdentity.projectName : null);
    if (!projectName) throw new Error("Compose project name is required");
    const containers = await listContainersForProject(hostId, projectName);
    const containerIds = containers.map((row: any) => String(row.external_id));
    const volumeNames = await collectVolumeNames(hostId, containerIds);
    return {
      label: appIdentity.label ?? stack?.name ?? projectName,
      projectName,
      stackId: stack?.id ?? null,
      composeYaml: stack?.compose_yaml ?? null,
      env: stack?.env ?? "",
      workingDir: stack?.source_working_dir ?? null,
      composePath: stack?.source_compose_path ?? null,
      containerIds,
      volumeNames
    };
  }

  if (appIdentity.kind === "git") {
    const repo = await getRepositoryRow(appIdentity.repositoryId);
    if (!repo) throw new Error("Tracked repository not found for recovery app identity");
    const effectiveHostId = repo.default_host_id ?? hostId;
    const stack = await getStackByProject(effectiveHostId, repo.project_name);
    const containers = stack ? await listContainersForProject(effectiveHostId, stack.project_name) : [];
    const containerIds = containers.map((row: any) => String(row.external_id));
    const volumeNames = await collectVolumeNames(effectiveHostId, containerIds);
    return {
      label: appIdentity.label ?? repo.name,
      projectName: repo.project_name,
      stackId: stack?.id ?? null,
      composeYaml: stack?.compose_yaml ?? null,
      env: stack?.env ?? repo.env ?? "",
      workingDir: stack?.source_working_dir ?? null,
      composePath: stack?.source_compose_path ?? null,
      containerIds,
      volumeNames
    };
  }

  const volumeNames = await collectVolumeNames(hostId, appIdentity.containerIds);
  return {
    label: appIdentity.label ?? appIdentity.containerIds[0] ?? "standalone",
    projectName: null,
    stackId: null,
    composeYaml: null,
    env: "",
    workingDir: null,
    composePath: null,
    containerIds: appIdentity.containerIds,
    volumeNames
  };
}

export function isComposeApp(appIdentity: RecoveryAppIdentity) {
  return appIdentity.kind === "stack" || appIdentity.kind === "compose" || appIdentity.kind === "git";
}
