import path from "node:path";
import type { DockerActionRequest } from "@composebastion/shared";
import type { PoolClient } from "pg";

/**
 * Remote mutations that must not overlap another operation touching the same
 * Docker object, host path, or Compose project. The admission lock itself is
 * held only while a job is inserted; non-conflicting jobs still execute in
 * parallel.
 */
export const RECONCILABLE_DOCKER_MUTATION_TYPES = [
  "host.mkdir",
  "git.clone",
  "git.pull",
  "git.cloneDeploy",
  "container.run",
  "container.clone",
  "container.start",
  "container.stop",
  "container.restart",
  "container.rename",
  "container.update",
  "container.remove",
  "image.pull",
  "image.remove",
  "image.prune",
  "image.cleanup",
  "network.create",
  "network.remove",
  "network.prune",
  "volume.create",
  "volume.remove",
  "volume.prune",
  "compose.deployPath",
  "compose.writeDeployPath",
  "registry.login"
] as const;

export type ReconciliableDockerMutationType =
  typeof RECONCILABLE_DOCKER_MUTATION_TYPES[number];

type MutationTargetKind =
  | "host-path"
  | "compose-project"
  | "container"
  | "image"
  | "network"
  | "volume"
  | "registry-auth";

export type DockerMutationTarget = {
  hostId: string;
  kind: MutationTargetKind;
  value: string;
};

export type DockerMutationScope = {
  type: ReconciliableDockerMutationType;
  hostIds: string[];
  targets: DockerMutationTarget[];
};

type ActionLike = {
  type: string;
  hostId?: unknown;
  host_id?: unknown;
  payload?: unknown;
};

const mutationTypes = new Set<string>(RECONCILABLE_DOCKER_MUTATION_TYPES);

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedPath(value: unknown) {
  const input = stringValue(value);
  return input ? path.posix.normalize(input) : "";
}

function normalizedProject(value: unknown) {
  return stringValue(value).toLowerCase();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function addTarget(
  targets: DockerMutationTarget[],
  hostId: string,
  kind: MutationTargetKind,
  value: unknown
) {
  const normalized = kind === "host-path"
    ? normalizedPath(value)
    : kind === "compose-project"
      ? normalizedProject(value)
      : stringValue(value);
  if (!hostId || !normalized) return;
  if (!targets.some((target) =>
    target.hostId === hostId
    && target.kind === kind
    && target.value === normalized
  )) {
    targets.push({ hostId, kind, value: normalized });
  }
  if (
    kind === "host-path"
    && normalized !== "*"
    && !targets.some((target) =>
      target.hostId === hostId
      && target.kind === "host-path"
      && target.value === "*"
    )
  ) {
    // A lexical path is not an authoritative remote identity: an SSH-host
    // symlink can make two different spellings address the same directory and
    // can be retargeted after a one-time realpath probe. Until execution is
    // bound to a no-follow remote file descriptor, serialize every host-path
    // mutation on the host while retaining the exact path for evidence.
    targets.push({ hostId, kind: "host-path", value: "*" });
  }
}

function addContainerRunTargets(
  targets: DockerMutationTarget[],
  hostId: string,
  payload: Record<string, unknown>
) {
  addTarget(targets, hostId, "container", payload.name);
  addTarget(targets, hostId, "image", payload.image);
  addTarget(targets, hostId, "network", payload.network);
  if (Array.isArray(payload.volumes)) {
    for (const raw of payload.volumes) {
      addTarget(targets, hostId, "volume", objectValue(raw).volumeName);
    }
  }
}

/**
 * Produce a deterministic, secret-free mutation scope from a parsed action or
 * an operation_jobs row. Unknown/malformed rows fail closed by returning null
 * and are never treated as reconciled by the caller.
 */
export function dockerMutationScope(input: ActionLike | DockerActionRequest) {
  const type = stringValue(input.type);
  if (!mutationTypes.has(type)) return null;
  const action = input as ActionLike;
  const hostId = stringValue(action.hostId ?? action.host_id);
  if (!hostId) return null;
  const payload = objectValue(input.payload);
  const targets: DockerMutationTarget[] = [];

  switch (type as ReconciliableDockerMutationType) {
    case "host.mkdir":
      addTarget(targets, hostId, "host-path", payload.path);
      break;
    case "git.clone":
    case "git.pull":
      addTarget(targets, hostId, "host-path", payload.directory);
      break;
    case "git.cloneDeploy":
      addTarget(targets, hostId, "host-path", payload.directory);
      addTarget(targets, hostId, "compose-project", payload.projectName);
      addTarget(targets, hostId, "registry-auth", "*");
      addTarget(targets, hostId, "container", "*");
      addTarget(targets, hostId, "image", "*");
      addTarget(targets, hostId, "network", "*");
      addTarget(targets, hostId, "volume", "*");
      break;
    case "compose.deployPath":
    case "compose.writeDeployPath":
      addTarget(targets, hostId, "host-path", payload.workingDir);
      addTarget(targets, hostId, "compose-project", payload.projectName);
      addTarget(targets, hostId, "registry-auth", "*");
      // Current inventory cannot describe resources introduced by the
      // reviewed Compose snapshot. In particular, an updated definition can
      // create a new volume while recovery is hydrating the same name. Keep
      // the deployment fail-closed against every resource kind until the job
      // is pinned to, and scopes, an exact env-resolved Compose snapshot.
      addTarget(targets, hostId, "container", "*");
      addTarget(targets, hostId, "image", "*");
      addTarget(targets, hostId, "network", "*");
      addTarget(targets, hostId, "volume", "*");
      break;
    case "container.run":
      addContainerRunTargets(targets, hostId, payload);
      addTarget(targets, hostId, "registry-auth", "*");
      break;
    case "container.clone": {
      const targetHostId = stringValue(payload.targetHostId);
      addTarget(targets, hostId, "container", payload.containerId);
      // A user-provided name is the authoritative target identity. Repeated
      // default-name clones of the same source still share a deterministic key.
      addTarget(
        targets,
        targetHostId,
        "container",
        stringValue(payload.targetName) || `clone-of:${stringValue(payload.containerId)}`
      );
      addTarget(targets, targetHostId, "registry-auth", "*");
      break;
    }
    case "container.start":
    case "container.stop":
    case "container.restart":
    case "container.remove":
      addTarget(targets, hostId, "container", payload.containerId);
      break;
    case "container.rename":
      addTarget(targets, hostId, "container", payload.containerId);
      addTarget(targets, hostId, "container", payload.name);
      break;
    case "container.update":
      addTarget(targets, hostId, "container", payload.containerId);
      addTarget(targets, hostId, "image", payload.targetImage);
      addTarget(targets, hostId, "registry-auth", "*");
      break;
    case "image.pull":
      addTarget(targets, hostId, "image", payload.image);
      addTarget(targets, hostId, "registry-auth", "*");
      break;
    case "image.remove":
      addTarget(targets, hostId, "image", payload.imageId);
      break;
    case "image.cleanup":
      if (Array.isArray(payload.targets)) {
        for (const raw of payload.targets) {
          const target = objectValue(raw);
          addTarget(targets, hostId, "image", target.imageId);
          addTarget(targets, hostId, "image", target.reference);
        }
      }
      break;
    case "image.prune":
      addTarget(targets, hostId, "image", "*");
      break;
    case "network.create":
      addTarget(targets, hostId, "network", payload.name);
      break;
    case "network.remove":
      addTarget(targets, hostId, "network", payload.networkId);
      break;
    case "network.prune":
      addTarget(targets, hostId, "network", "*");
      break;
    case "volume.create":
    case "volume.remove":
      addTarget(targets, hostId, "volume", payload.name ?? payload.volumeName);
      break;
    case "volume.prune":
      addTarget(targets, hostId, "volume", "*");
      break;
    case "registry.login":
      // docker login rewrites one shared config file. Different registries are
      // therefore the same mutable resource even though their auth entries are
      // logically independent.
      addTarget(targets, hostId, "registry-auth", "*");
      break;
  }

  if (!targets.length) return null;
  const hostIds = [...new Set(targets.map((target) => target.hostId))].sort();
  return {
    type: type as ReconciliableDockerMutationType,
    hostIds,
    targets
  } satisfies DockerMutationScope;
}

function pathsOverlap(left: string, right: string) {
  if (left === right) return true;
  const leftPrefix = left.endsWith("/") ? left : `${left}/`;
  const rightPrefix = right.endsWith("/") ? right : `${right}/`;
  return left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
}

function targetsConflict(left: DockerMutationTarget, right: DockerMutationTarget) {
  if (left.hostId !== right.hostId || left.kind !== right.kind) return false;
  if (left.value === "*" || right.value === "*") return true;
  if (left.kind === "host-path") return pathsOverlap(left.value, right.value);
  return left.value === right.value;
}

export function dockerMutationScopesConflict(
  left: DockerMutationScope,
  right: DockerMutationScope
) {
  return left.targets.some((leftTarget) =>
    right.targets.some((rightTarget) => targetsConflict(leftTarget, rightTarget))
  );
}

export function dockerMutationAdmissionKeys(scope: DockerMutationScope) {
  const hostKeys = [...new Set(
    scope.hostIds.map((hostId) => `docker-mutation-admission:${hostId}`)
  )].sort();
  const targetKeys = [...new Set(
    scope.targets.flatMap((target) => {
      if (target.kind === "host-path") {
        return [`deployment-target:path:${target.hostId}:${target.value}`];
      }
      if (target.kind === "compose-project") {
        return [`deployment-target:project:${target.hostId}:${target.value}`];
      }
      return [];
    })
  )].sort();
  // This is the global enqueue order used by generic jobs, deployment, and
  // recovery: every host admission domain first, then deterministic target
  // keys. Lexically sorting the combined set puts deployment-target:* first
  // and can deadlock a caller that later delegates to generic enqueue.
  return [...hostKeys, ...targetKeys];
}

export function dockerMutationScopeEvidence(scope: DockerMutationScope) {
  return {
    type: scope.type,
    hostIds: scope.hostIds,
    targets: scope.targets
  };
}

const snapshotKinds = new Set(["container", "image", "network", "volume"]);
const existingReferenceTypes = new Set<ReconciliableDockerMutationType>([
  "git.pull",
  "container.clone",
  "container.start",
  "container.stop",
  "container.restart",
  "container.rename",
  "container.update",
  "container.remove",
  "image.remove",
  "image.cleanup",
  "network.remove",
  "volume.remove"
]);
const futureResourceCreatingTypes = new Set<ReconciliableDockerMutationType>([
  "git.cloneDeploy",
  "compose.deployPath",
  "compose.writeDeployPath"
]);

function snapshotData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function composeProjectFromSnapshot(value: unknown) {
  const data = snapshotData(value);
  const labels = data.Labels ?? data.labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    const project = (labels as Record<string, unknown>)[
      "com.docker.compose.project"
    ];
    return stringValue(project).toLowerCase();
  }
  if (typeof labels !== "string") return "";
  for (const label of labels.split(",")) {
    const [key, ...rest] = label.split("=");
    if (key?.trim() === "com.docker.compose.project") {
      return rest.join("=").trim().toLowerCase();
    }
  }
  return "";
}

/**
 * Resolve Docker names and IDs through the latest inventory snapshot while the
 * host admission lock is held. Both aliases are added to the scope, so an
 * action submitted by name cannot overlap one submitted by ID.
 */
export async function canonicalizeDockerMutationScope(
  client: PoolClient,
  scope: DockerMutationScope
) {
  const targets = [...scope.targets];
  for (const hostId of scope.hostIds) {
    for (const kind of snapshotKinds) {
      const values = targets
        .filter((target) =>
          target.hostId === hostId
          && target.kind === kind
          && target.value !== "*"
        )
        .map((target) => target.value);
      if (!values.length) continue;
      const snapshots = await client.query<{
        external_id: string;
        name: string;
        data: Record<string, unknown>;
      }>(
        `SELECT external_id, name, data
         FROM resource_snapshots
         WHERE host_id = $1
           AND kind = $2
           AND (
             external_id = ANY($3::text[])
             OR name = ANY($3::text[])
           )`,
        [hostId, kind, values]
      );
      const matchedValues = new Set<string>();
      for (const row of snapshots.rows) {
        addTarget(targets, hostId, kind as MutationTargetKind, row.external_id);
        addTarget(targets, hostId, kind as MutationTargetKind, row.name);
        for (const value of values) {
          if (value === row.external_id || value === row.name) {
            matchedValues.add(value);
          }
        }
        const project = composeProjectFromSnapshot(row.data);
        if (project) {
          addTarget(targets, hostId, "compose-project", project);
        }
      }
      if (
        existingReferenceTypes.has(scope.type)
        && values.some((value) => !matchedValues.has(value))
      ) {
        addTarget(targets, hostId, kind as MutationTargetKind, "*");
      }
    }

    const projects = targets
      .filter((target) =>
        target.hostId === hostId
        && target.kind === "compose-project"
      )
      .map((target) => target.value);
    for (const project of projects) {
      const managed = await client.query<{
        kind: "container" | "image" | "network" | "volume";
        external_id: string;
        name: string;
        data: Record<string, unknown>;
      }>(
        `SELECT kind, external_id, name, data
         FROM resource_snapshots
         WHERE host_id = $1
           AND kind IN ('container', 'network', 'volume')`,
        [hostId]
      );
      const projectRows = managed.rows.filter((row) =>
        composeProjectFromSnapshot(row.data) === project
      );
      for (const row of projectRows) {
        addTarget(targets, hostId, row.kind, row.external_id);
        addTarget(targets, hostId, row.kind, row.name);
        if (row.kind === "container") {
          const data = snapshotData(row.data);
          addTarget(targets, hostId, "image", data.Image ?? data.image);
        }
      }
      if (
        !projectRows.length
        || futureResourceCreatingTypes.has(scope.type)
      ) {
        // A non-empty inventory only describes the resources that exist now.
        // Deploy/up operations can introduce additional resources from the
        // reviewed Compose definition, so exact snapshot rows never justify
        // dropping the fail-closed future-resource domains.
        addTarget(targets, hostId, "container", "*");
        addTarget(targets, hostId, "image", "*");
        addTarget(targets, hostId, "network", "*");
        addTarget(targets, hostId, "volume", "*");
      }
    }
  }
  return {
    ...scope,
    targets
  } satisfies DockerMutationScope;
}
