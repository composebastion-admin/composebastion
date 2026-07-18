import type { RecoveryAnalysis, RecoveryAnalysisRequest, RecoveryDataMount } from "@composebastion/shared";
import { recoveryAnalysisSchema } from "@composebastion/shared";
import { getContainerInspect, type ContainerInspectDetails } from "./docker.js";
import { composeWorkingDirHostFolder } from "./recoveryManifest.js";
import { resolveAppContext } from "./recoveryAppContext.js";
import { getRecoveryProfile, getRecoveryProfileForApp } from "./recoveryProfiles.js";

const DATABASE_IMAGE_PATTERNS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "valkey",
  "influxdb",
  "clickhouse",
  "elasticsearch",
  "opensearch",
  "mssql",
  "cockroach"
];

const DATABASE_DATA_PATHS = [
  "/var/lib/postgresql",
  "/var/lib/mysql",
  "/var/lib/mongodb",
  "/data/db",
  "/data",
  "/bitnami",
  "/var/lib/redis",
  "/var/opt/mssql",
  "/usr/share/elasticsearch/data",
  "/usr/share/opensearch/data"
];

function isDatabaseLike(name: string, image: string) {
  const haystack = `${name} ${image}`.toLowerCase();
  return DATABASE_IMAGE_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function hasPersistentDatabaseMount(mounts: RecoveryDataMount[]) {
  return mounts.some((mount) =>
    mount.included &&
    mount.destination &&
    DATABASE_DATA_PATHS.some((dataPath) => mount.destination === dataPath || mount.destination.startsWith(`${dataPath}/`))
  );
}

function mountKey(mount: Pick<RecoveryDataMount, "type" | "source" | "name" | "destination">) {
  return `${mount.type}:${mount.source ?? mount.name ?? ""}:${mount.destination}`;
}

type RecoveryAnalysisOptions = {
  containerInspects?: ReadonlyMap<string, ContainerInspectDetails>;
};

export async function analyzeRecovery(
  input: RecoveryAnalysisRequest,
  options: RecoveryAnalysisOptions = {}
): Promise<RecoveryAnalysis> {
  const context = await resolveAppContext(input.hostId, input.appIdentity, options);
  const profile = input.profileId
    ? await getRecoveryProfile(input.profileId)
    : await getRecoveryProfileForApp(input.hostId, input.appIdentity);
  const dataMounts: RecoveryDataMount[] = [];
  const warnings: string[] = [];
  const blockingIssues: string[] = [];
  const seen = new Set<string>();
  let databaseLikeWithoutStopFirst = false;

  const addMount = (mount: RecoveryDataMount) => {
    const key = mountKey(mount);
    if (seen.has(key)) return;
    seen.add(key);
    dataMounts.push(mount);
  };

  if (!context.containerIds.length && input.appIdentity.kind === "standalone") {
    blockingIssues.push("No containers were found for this standalone app.");
  }

  for (const containerId of context.containerIds) {
    const inspect = options.containerInspects
      ? options.containerInspects.get(containerId)
      : await getContainerInspect(input.hostId, containerId);
    if (!inspect) throw new Error(`Container ${containerId} is missing from the batched inspection result`);
    const labels = inspect.labels ?? {};
    const containerName = labels["com.docker.compose.service"] || labels["com.docker.compose.project"] || containerId;
    const containerMounts: RecoveryDataMount[] = [];
    for (const mount of inspect.mounts) {
      const type = mount.type === "volume" ? "volume" : mount.type === "bind" ? "bind" : mount.type === "tmpfs" ? "tmpfs" : null;
      if (!type) continue;
      const included = type === "volume" || type === "bind";
      const warning = type === "tmpfs"
        ? "tmpfs data is memory-backed and cannot be captured as a persistent artifact."
        : null;
      const dataMount: RecoveryDataMount = {
        type,
        containerName,
        source: mount.source ?? null,
        name: mount.name ?? null,
        destination: mount.destination,
        readOnly: mount.readOnly,
        included,
        warning
      };
      if (warning) warnings.push(`${containerName}: ${warning}`);
      containerMounts.push(dataMount);
      addMount(dataMount);
    }

    if (isDatabaseLike(containerName, inspect.image)) {
      if (!hasPersistentDatabaseMount(containerMounts)) {
        warnings.push(`${containerName} looks like a database container, but no mounted database data directory was detected.`);
      }
      databaseLikeWithoutStopFirst = true;
    }

    if (containerMounts.length === 0) {
      warnings.push(`${containerName} has no Docker volume, bind mount, or tmpfs entries; mutable data may be inside the container writable layer.`);
    }
  }

  const composeFolder = composeWorkingDirHostFolder(context.workingDir);
  if (composeFolder) {
    addMount({
      type: "compose_working_dir",
      containerName: null,
      source: composeFolder.source,
      name: null,
      destination: composeFolder.destination,
      readOnly: false,
      included: true,
      warning: null
    });
  }

  for (const includePath of profile?.includePaths ?? []) {
    addMount({
      type: "manual",
      containerName: null,
      source: includePath,
      name: null,
      destination: "",
      readOnly: false,
      included: true,
      warning: null
    });
  }

  if (!dataMounts.some((mount) => mount.included)) {
    warnings.push("No persistent data mounts were detected. Only configuration metadata may be recoverable.");
  }

  const recommendedCaptureMode = profile?.captureMode === "stop_first" || databaseLikeWithoutStopFirst
    ? "stop_first"
    : "hot";
  const status = blockingIssues.length ? "blocked" : warnings.length ? "warning" : "ready";

  return recoveryAnalysisSchema.parse({
    hostId: input.hostId,
    appIdentity: input.appIdentity,
    profile,
    status,
    recommendedCaptureMode,
    dataMounts,
    volumes: Array.from(new Set(dataMounts.filter((mount) => mount.type === "volume" && mount.name).map((mount) => mount.name!))),
    bindMounts: Array.from(new Set(dataMounts.filter((mount) => (mount.type === "bind" || mount.type === "manual" || mount.type === "compose_working_dir") && mount.source).map((mount) => mount.source!))),
    warnings: Array.from(new Set(warnings)),
    blockingIssues
  });
}
