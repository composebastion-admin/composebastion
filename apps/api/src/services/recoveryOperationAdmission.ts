import { createHash } from "node:crypto";
import path from "node:path";
import type { RecoveryAppIdentity } from "@composebastion/shared";
import { recoveryAppIdentitySchema } from "@composebastion/shared";
import type { PoolClient } from "pg";
import {
  canonicalizeDockerMutationScope,
  dockerMutationAdmissionKeys,
  dockerMutationScope,
  dockerMutationScopesConflict,
  type DockerMutationScope,
  type DockerMutationTarget
} from "./dockerMutationScope.js";
import { stackRemoteDirectory } from "./remoteFiles.js";

export const RECOVERY_SOURCE_SCOPE_METADATA_KEY =
  "operationSourceScopeKeys";
export const MIGRATION_SOURCE_SCOPE_PLAN_KEY =
  "_operationSourceScopeKeys";
export const MIGRATION_TARGET_SCOPE_PLAN_KEY =
  "_operationTargetScopeKeys";
export const RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY =
  "_recoveryDockerMutationScopes";

type RecoverySourceContext = {
  containerIds?: readonly string[];
  volumeNames?: readonly string[];
  projectName?: string | null;
  stackId?: string | null;
  workingDir?: string | null;
};

export type RecoveryAdmissionOperationKind =
  | "capture"
  | "verify"
  | "restore"
  | "migration";

export type RecoveryOperationAdmission = {
  kind: RecoveryAdmissionOperationKind;
  recoveryPointId?: string | null;
  sourceScopeKeys?: readonly string[];
  targetScopeKeys?: readonly string[];
  sourceDockerScopes?: readonly DockerMutationScope[];
  targetDockerScopes?: readonly DockerMutationScope[];
};

export type StoredRecoveryDockerScopes = {
  source: DockerMutationScope[];
  target: DockerMutationScope[];
};

function normalizedScopePart(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function identityFallback(identity: RecoveryAppIdentity) {
  const stable = identity.kind === "standalone"
    ? {
        ...identity,
        label: undefined,
        containerIds: [...identity.containerIds].sort()
      }
    : { ...identity, label: undefined };
  return createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
}

function uniqueScopeKeys(values: readonly string[]) {
  return [...new Set(
    values.map((value) => value.trim()).filter(Boolean)
  )].sort();
}

function addTarget(
  targets: DockerMutationTarget[],
  hostId: string,
  kind: DockerMutationTarget["kind"],
  rawValue: unknown
) {
  const value = kind === "host-path"
    ? path.posix.normalize(String(rawValue ?? "").trim())
    : kind === "compose-project"
      ? normalizedScopePart(rawValue)
      : String(rawValue ?? "").trim();
  if (!hostId || !value || (kind === "host-path" && value === ".")) return;
  if (!targets.some((target) =>
    target.hostId === hostId
    && target.kind === kind
    && target.value === value
  )) {
    targets.push({ hostId, kind, value });
  }
  if (
    kind === "host-path"
    && value !== "*"
    && !targets.some((target) =>
      target.hostId === hostId
      && target.kind === "host-path"
      && target.value === "*"
    )
  ) {
    // A lexical SSH path is not an authoritative remote identity. Symlink
    // aliases and retargeting can make two different strings address the same
    // directory, so recovery operations serialize the host-path domain while
    // retaining the exact path for evidence and future descriptor binding.
    targets.push({ hostId, kind: "host-path", value: "*" });
  }
}

export function conservativeRecoveryDockerMutationScope(
  scope: DockerMutationScope
): DockerMutationScope {
  const targets: DockerMutationTarget[] = [];
  for (const target of scope.targets) {
    addTarget(
      targets,
      target.hostId,
      target.kind,
      target.value
    );
  }
  return {
    ...scope,
    hostIds: [...new Set([
      ...scope.hostIds,
      ...targets.map((target) => target.hostId)
    ])].sort(),
    targets
  };
}

export function buildRecoverySourceDockerMutationScope(
  hostId: string,
  identityInput: RecoveryAppIdentity,
  context: RecoverySourceContext = {}
): DockerMutationScope {
  const identity = recoveryAppIdentitySchema.parse(identityInput);
  const targets: DockerMutationTarget[] = [];
  const projectName = context.projectName
    ?? ("projectName" in identity ? identity.projectName : null);
  const containerIds = [
    ...(context.containerIds ?? []),
    ...(identity.kind === "standalone" ? identity.containerIds : [])
  ];
  for (const containerId of containerIds) {
    addTarget(targets, hostId, "container", containerId);
  }
  for (const volumeName of context.volumeNames ?? []) {
    addTarget(targets, hostId, "volume", volumeName);
  }
  if (projectName) {
    addTarget(targets, hostId, "compose-project", projectName);
  }
  if (context.workingDir) {
    addTarget(targets, hostId, "host-path", context.workingDir);
  }
  // An inventory gap must not turn a destructive capture/migration into an
  // unscoped operation. The app identity fallback is represented as a
  // deterministic Compose-project namespace which conflicts with another
  // recovery operation while exact Docker targets remain available for direct
  // job admission whenever inventory is complete.
  if (!targets.length) {
    addTarget(
      targets,
      hostId,
      "compose-project",
      `recovery-identity-${identityFallback(identity)}`
    );
  }
  return {
    type: "compose.deployPath",
    hostIds: [hostId],
    targets
  };
}

export function buildRecoverySourceOperationScopeKeys(
  hostId: string,
  identityInput: RecoveryAppIdentity,
  context: RecoverySourceContext = {}
) {
  const identity = recoveryAppIdentitySchema.parse(identityInput);
  const prefix = `recovery-source:${hostId}`;
  const projectName = normalizedScopePart(
    context.projectName
      ?? ("projectName" in identity ? identity.projectName : null)
  );
  const stackId = normalizedScopePart(
    context.stackId
      ?? ("stackId" in identity ? identity.stackId : null)
  );
  const containerIds = uniqueScopeKeys([
    ...(context.containerIds ?? []),
    ...(identity.kind === "standalone" ? identity.containerIds : [])
  ]);
  const volumeNames = uniqueScopeKeys(context.volumeNames ?? []);
  const keys = [
    ...containerIds.map((id) => `${prefix}:container:${id}`),
    ...volumeNames.map((name) => `${prefix}:volume:${name}`),
    ...(projectName ? [`${prefix}:project:${projectName}`] : []),
    ...(stackId ? [`${prefix}:stack:${stackId}`] : []),
    ...(context.workingDir
      ? [`${prefix}:path:${path.posix.normalize(context.workingDir)}`]
      : []),
    ...(identity.kind === "git"
      ? [
          `${prefix}:repository:${
            normalizedScopePart(identity.repositoryId)
          }`
        ]
      : []),
    `${prefix}:identity:${identityFallback(identity)}`
  ];
  return uniqueScopeKeys(keys);
}

function targetKey(target: DockerMutationTarget) {
  return [
    "recovery-target",
    target.hostId,
    target.kind,
    target.value
  ].join(":");
}

/**
 * Admission keys are based on the actual intended destination identities, not
 * the recovery-point id. Different points that map to the same project,
 * container, network, volume, path, or database-owned Docker resources
 * therefore serialize correctly.
 */
export function buildRecoveryTargetOperationScopeKeys(
  scope: DockerMutationScope
) {
  return uniqueScopeKeys(scope.targets.map(targetKey));
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? uniqueScopeKeys(
      value.filter((item): item is string => typeof item === "string")
    )
    : [];
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validTarget(value: unknown): value is DockerMutationTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const target = value as Record<string, unknown>;
  return typeof target.hostId === "string"
    && typeof target.kind === "string"
    && [
      "host-path",
      "compose-project",
      "container",
      "image",
      "network",
      "volume",
      "registry-auth"
    ].includes(target.kind)
    && typeof target.value === "string";
}

function validScope(value: unknown): value is DockerMutationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const scope = value as Record<string, unknown>;
  return typeof scope.type === "string"
    && Array.isArray(scope.hostIds)
    && scope.hostIds.every((hostId) => typeof hostId === "string")
    && Array.isArray(scope.targets)
    && scope.targets.every(validTarget);
}

export function storedRecoveryDockerScopes(
  value: unknown
): StoredRecoveryDockerScopes {
  const record = metadataRecord(value);
  return {
    source: Array.isArray(record.source)
      ? record.source
          .filter(validScope)
          .map(conservativeRecoveryDockerMutationScope)
      : [],
    target: Array.isArray(record.target)
      ? record.target
          .filter(validScope)
          .map(conservativeRecoveryDockerMutationScope)
      : []
  };
}

export async function persistRecoveryDockerMutationScopes(
  client: PoolClient,
  operationJobId: string,
  scopes: {
    source?: readonly DockerMutationScope[];
    target?: readonly DockerMutationScope[];
  }
) {
  const evidence: StoredRecoveryDockerScopes = {
    source: (scopes.source ?? [])
      .map(conservativeRecoveryDockerMutationScope),
    target: (scopes.target ?? [])
      .map(conservativeRecoveryDockerMutationScope)
  };
  const updated = await client.query(
    `UPDATE operation_jobs
     SET payload = jsonb_set(
           payload,
           ARRAY[$2]::text[],
           $3::jsonb,
           true
         ),
         updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [
      operationJobId,
      RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY,
      JSON.stringify(evidence)
    ]
  );
  if (updated.rowCount !== 1) {
    throw new Error("Failed to persist recovery operation resource intent");
  }
}

type ExistingRecoveryOperation = {
  kind: RecoveryAdmissionOperationKind;
  recoveryPointId: string | null;
  sourceScopeKeys: string[];
  targetScopeKeys: string[];
  sourceDockerScopes: DockerMutationScope[];
  targetDockerScopes: DockerMutationScope[];
};

function operationScopesFromRow(
  row: Record<string, unknown>
): ExistingRecoveryOperation | null {
  const type = String(row.type ?? "");
  const payload = metadataRecord(row.payload);
  const pointMetadata = metadataRecord(row.point_metadata);
  const migrationPlan = metadataRecord(row.migration_plan);
  const recoveryPointId =
    typeof payload.recoveryPointId === "string"
      ? payload.recoveryPointId
      : (
          typeof row.migration_recovery_point_id === "string"
            ? row.migration_recovery_point_id
            : null
        );
  const dockerScopes = storedRecoveryDockerScopes(
    payload[RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY]
  );

  if (type === "recovery.create" || type === "recovery.capture") {
    const stored = stringArray(
      pointMetadata[RECOVERY_SOURCE_SCOPE_METADATA_KEY]
    );
    const sourceFallback =
      row.point_host_id && row.point_app_identity
        ? buildRecoverySourceOperationScopeKeys(
            String(row.point_host_id),
            recoveryAppIdentitySchema.parse(row.point_app_identity),
            {
              projectName:
                typeof pointMetadata.projectName === "string"
                  ? pointMetadata.projectName
                  : null,
              stackId:
                typeof pointMetadata.stackId === "string"
                  ? pointMetadata.stackId
                  : null
            }
          )
        : [];
    const dockerFallback =
      row.point_host_id && row.point_app_identity
        ? [
            buildRecoverySourceDockerMutationScope(
              String(row.point_host_id),
              recoveryAppIdentitySchema.parse(row.point_app_identity),
              {
                projectName:
                  typeof pointMetadata.projectName === "string"
                    ? pointMetadata.projectName
                    : null,
                stackId:
                  typeof pointMetadata.stackId === "string"
                    ? pointMetadata.stackId
                    : null
              }
            )
          ]
        : [];
    return {
      kind: "capture",
      recoveryPointId,
      sourceScopeKeys: stored.length ? stored : sourceFallback,
      targetScopeKeys: [],
      sourceDockerScopes:
        dockerScopes.source.length
          ? dockerScopes.source
          : dockerFallback,
      targetDockerScopes: []
    };
  }
  if (type === "recovery.verify") {
    return {
      kind: "verify",
      recoveryPointId,
      sourceScopeKeys: [],
      targetScopeKeys: [],
      sourceDockerScopes: [],
      targetDockerScopes: []
    };
  }
  if (type === "recovery.restore") {
    return {
      kind: "restore",
      recoveryPointId,
      sourceScopeKeys: [],
      targetScopeKeys: dockerScopes.target.flatMap(
        buildRecoveryTargetOperationScopeKeys
      ),
      sourceDockerScopes: [],
      targetDockerScopes: dockerScopes.target
    };
  }
  if (type === "migration.execute") {
    const sourceStored = stringArray(
      migrationPlan[MIGRATION_SOURCE_SCOPE_PLAN_KEY]
    );
    const targetStored = stringArray(
      migrationPlan[MIGRATION_TARGET_SCOPE_PLAN_KEY]
    );
    const sourceFallback =
      row.migration_source_host_id
      && row.migration_source_app_identity
        ? buildRecoverySourceOperationScopeKeys(
            String(row.migration_source_host_id),
            recoveryAppIdentitySchema.parse(
              row.migration_source_app_identity
            )
          )
        : [];
    const dockerFallback =
      row.migration_source_host_id
      && row.migration_source_app_identity
        ? [
            buildRecoverySourceDockerMutationScope(
              String(row.migration_source_host_id),
              recoveryAppIdentitySchema.parse(
                row.migration_source_app_identity
              )
            )
          ]
        : [];
    return {
      kind: "migration",
      recoveryPointId,
      sourceScopeKeys: sourceStored.length
        ? sourceStored
        : sourceFallback,
      targetScopeKeys: targetStored,
      sourceDockerScopes: dockerScopes.source.length
        ? dockerScopes.source
        : dockerFallback,
      targetDockerScopes: dockerScopes.target
    };
  }
  return null;
}

function scopesOverlap(
  left: readonly string[] = [],
  right: readonly string[] = []
) {
  if (!left.length || !right.length) return false;
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function dockerScopesOverlap(
  left: readonly DockerMutationScope[] = [],
  right: readonly DockerMutationScope[] = []
) {
  return left.some((leftScope) =>
    right.some((rightScope) =>
      dockerMutationScopesConflict(leftScope, rightScope)
    )
  );
}

function operationsConflict(
  proposed: RecoveryOperationAdmission,
  existing: ExistingRecoveryOperation
) {
  // Reads may overlap reads only where the existing source/source policy
  // permits it. Any source that overlaps the other operation's destination is
  // a read/write collision and must serialize in both directions.
  if (
    scopesOverlap(
      proposed.sourceScopeKeys,
      existing.targetScopeKeys
    )
    || dockerScopesOverlap(
      proposed.sourceDockerScopes,
      existing.targetDockerScopes
    )
    || scopesOverlap(
      proposed.targetScopeKeys,
      existing.sourceScopeKeys
    )
    || dockerScopesOverlap(
      proposed.targetDockerScopes,
      existing.sourceDockerScopes
    )
  ) {
    return true;
  }
  if (
    (
      scopesOverlap(
        proposed.sourceScopeKeys,
        existing.sourceScopeKeys
      )
      || dockerScopesOverlap(
        proposed.sourceDockerScopes,
        existing.sourceDockerScopes
      )
    )
    && (
      proposed.kind === "capture"
      || proposed.kind === "migration"
    )
    && (
      existing.kind === "capture"
      || existing.kind === "migration"
    )
  ) {
    return true;
  }
  if (
    proposed.recoveryPointId
    && proposed.recoveryPointId === existing.recoveryPointId
    && (
      proposed.kind === "capture"
      || existing.kind === "capture"
    )
  ) {
    return true;
  }
  return scopesOverlap(
    proposed.targetScopeKeys,
    existing.targetScopeKeys
  ) || dockerScopesOverlap(
    proposed.targetDockerScopes,
    existing.targetDockerScopes
  );
}

function admissionConflict(
  message: string,
  activeJobId?: string
) {
  return Object.assign(new Error(message), {
    statusCode: 409,
    ...(activeJobId ? { activeJobId } : {})
  });
}

async function canonicalScopes(
  client: PoolClient,
  scopes: readonly DockerMutationScope[]
) {
  const resolved: DockerMutationScope[] = [];
  for (const scope of scopes) {
    resolved.push(
      await canonicalizeDockerMutationScope(client, scope)
    );
  }
  return resolved;
}

async function resolvedDirectDockerMutationScopes(
  client: PoolClient,
  row: Record<string, unknown>
) {
  const payload = metadataRecord(row.payload);
  const stored = storedRecoveryDockerScopes(
    payload[RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY]
  );
  if (stored.source.length || stored.target.length) {
    return [...stored.source, ...stored.target];
  }
  const direct = dockerMutationScope({
    type: String(row.type ?? ""),
    host_id: row.host_id,
    payload: row.payload
  });
  if (direct) return [direct];
  const type = String(row.type ?? "");
  const hostId = String(row.host_id ?? "");
  if (
    type === "compose.deploy"
    || type === "compose.stop"
    || type === "compose.remove"
  ) {
    const stackId = String(payload.stackId ?? "");
    if (!stackId || !hostId) return [];
    const selected = await client.query<{
      id: string;
      host_id: string;
      project_name: string;
      source_working_dir: string | null;
    }>(
      `SELECT id, host_id, project_name, source_working_dir
       FROM compose_stacks
       WHERE id = $1 AND host_id = $2`,
      [stackId, hostId]
    );
    const stack = selected.rows[0];
    if (!stack) return [];
    const scope = dockerMutationScope({
      type: "compose.deployPath",
      host_id: stack.host_id,
      payload: {
        workingDir:
          stack.source_working_dir
          || stackRemoteDirectory(stack.id),
        projectName: stack.project_name
      }
    });
    return scope ? [scope] : [];
  }
  if (type === "deploy.execute") {
    const analysisId = String(payload.analysisId ?? "");
    if (!analysisId || !hostId) return [];
    const selected = await client.query<{
      host_id: string;
      working_dir: string | null;
      project_name: string | null;
    }>(
      `SELECT host_id, working_dir, project_name
       FROM deployment_analyses
       WHERE id = $1 AND host_id = $2`,
      [analysisId, hostId]
    );
    const analysis = selected.rows[0];
    if (!analysis?.working_dir || !analysis.project_name) return [];
    const scope = dockerMutationScope({
      type: "compose.deployPath",
      host_id: analysis.host_id,
      payload: {
        workingDir: analysis.working_dir,
        projectName: analysis.project_name
      }
    });
    return scope ? [scope] : [];
  }
  return [];
}

function attemptDockerScope(
  row: Record<string, unknown>
): DockerMutationScope | null {
  const hostId = String(row.target_host_id ?? "");
  const resources = Array.isArray(row.resources)
    ? row.resources
    : [];
  const targets: DockerMutationTarget[] = [];
  for (const rawResource of resources) {
    const resource = metadataRecord(rawResource);
    const kind = String(resource.kind ?? "");
    const resourceName = String(resource.resource_name ?? "");
    if (
      kind === "volume"
      || kind === "network"
      || kind === "container"
    ) {
      addTarget(
        targets,
        hostId,
        kind as "volume" | "network" | "container",
        resourceName
      );
    } else if (kind === "directory") {
      addTarget(targets, hostId, "host-path", resourceName);
    } else if (kind === "compose_project") {
      addTarget(
        targets,
        hostId,
        "compose-project",
        resourceName
      );
    }
  }
  return targets.length
    ? {
        type: "compose.deployPath",
        hostIds: [hostId],
        targets
      }
    : null;
}

async function activeRestoreAttemptScopes(
  client: PoolClient,
  hostIds?: readonly string[]
) {
  const values: unknown[] = [];
  const hostPredicate = hostIds?.length
    ? `AND attempt.target_host_id = ANY($${
        values.push([...hostIds])
      }::uuid[])`
    : "";
  const attempts = await client.query(
    `SELECT attempt.id,
            attempt.target_host_id,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'kind', resource.kind,
                    'resource_name', resource.resource_name
                  )
                  ORDER BY resource.kind, resource.resource_name
                )
                FROM recovery_restore_resources resource
                WHERE resource.attempt_id = attempt.id
                  AND resource.status NOT IN (
                    'cleaned',
                    'preserved_unrelated'
                  )
              ),
              '[]'::jsonb
            ) AS resources
     FROM recovery_restore_attempts attempt
     WHERE attempt.status IN (
       'active',
       'awaiting_disposition',
       'cleanup_pending',
       'reconciling'
     )
     ${hostPredicate}
     ORDER BY attempt.id`,
    values
  );
  return (attempts.rows as Array<Record<string, unknown>>)
    .map(attemptDockerScope)
    .filter((scope): scope is DockerMutationScope => Boolean(scope));
}

/**
 * Called by generic Docker enqueue after its Docker admission keys are held.
 * It intentionally acquires no additional advisory locks, preventing inverse
 * lock order with recovery enqueue.
 */
export async function assertDockerMutationDoesNotConflictWithRecovery(
  client: PoolClient,
  requested: DockerMutationScope
) {
  const conservativeRequested =
    conservativeRecoveryDockerMutationScope(requested);
  const requestedHostIds = [...new Set(
    conservativeRequested.hostIds
  )];
  const requestedCanonical =
    await canonicalizeDockerMutationScope(
      client,
      conservativeRequested
    );
  const active = await client.query(
    `SELECT job.id, job.type, job.host_id, job.payload
     FROM operation_jobs job
     WHERE job.status IN ('queued', 'running')
       AND job.type IN (
         'recovery.create',
         'recovery.capture',
         'recovery.restore',
         'migration.execute',
         'volume.backup',
         'volume.restore',
         'volume.clone',
         'hostPath.backup',
         'hostPath.restore',
         'backup.drill'
       )
       AND (
         job.host_id = ANY($1::uuid[])
         OR job.payload->>'targetHostId' = ANY($1::text[])
         OR EXISTS (
           SELECT 1
           FROM migration_runs migration
           WHERE migration.id::text =
                 job.payload->>'migrationRunId'
             AND (
               migration.source_host_id = ANY($1::uuid[])
               OR migration.target_host_id = ANY($1::uuid[])
             )
         )
       )
     ORDER BY job.id
    `,
    [requestedHostIds]
  );
  for (const row of active.rows as Array<Record<string, unknown>>) {
    const payload = metadataRecord(row.payload);
    const stored = storedRecoveryDockerScopes(
      payload[RECOVERY_DOCKER_SCOPES_PAYLOAD_KEY]
    );
    for (const candidate of [...stored.source, ...stored.target]) {
      const canonicalCandidate =
        await canonicalizeDockerMutationScope(client, candidate);
      if (
        dockerMutationScopesConflict(
          requestedCanonical,
          canonicalCandidate
        )
      ) {
        throw admissionConflict(
          "This Docker mutation conflicts with an active recovery, migration, backup, restore, clone, or drill resource intent.",
          typeof row.id === "string" ? row.id : undefined
        );
      }
    }
  }
  for (
    const candidate of await activeRestoreAttemptScopes(
      client,
      requestedHostIds
    )
  ) {
    const canonicalCandidate =
      await canonicalizeDockerMutationScope(client, candidate);
    if (
      dockerMutationScopesConflict(
        requestedCanonical,
        canonicalCandidate
      )
    ) {
      throw admissionConflict(
        "This Docker mutation conflicts with a restore attempt awaiting exact-resource reconciliation."
      );
    }
  }

  const obligations = await client.query(
    `SELECT host_id, app_identity, metadata
     FROM recovery_points
     WHERE metadata->>'sourceRestartPending' = 'true'
       AND host_id = ANY($1::uuid[])
     ORDER BY id
    `,
    [requestedHostIds]
  );
  for (const row of obligations.rows as Array<Record<string, unknown>>) {
    const metadata = metadataRecord(row.metadata);
    const candidate = buildRecoverySourceDockerMutationScope(
      String(row.host_id),
      recoveryAppIdentitySchema.parse(row.app_identity),
      {
        projectName:
          typeof metadata.projectName === "string"
            ? metadata.projectName
            : null,
        stackId:
          typeof metadata.stackId === "string"
            ? metadata.stackId
            : null
      }
    );
    const canonicalCandidate =
      await canonicalizeDockerMutationScope(client, candidate);
    if (
      dockerMutationScopesConflict(
        requestedCanonical,
        canonicalCandidate
      )
    ) {
      throw admissionConflict(
        "This Docker mutation conflicts with an unresolved migration source restart or target-cleanup obligation."
      );
    }
  }
}

export async function lockRecoveryOperationAdmission(
  client: PoolClient,
  proposed: RecoveryOperationAdmission
) {
  const admission: RecoveryOperationAdmission = {
    ...proposed,
    sourceDockerScopes: (proposed.sourceDockerScopes ?? [])
      .map(conservativeRecoveryDockerMutationScope),
    targetDockerScopes: (proposed.targetDockerScopes ?? [])
      .map(conservativeRecoveryDockerMutationScope)
  };
  const proposedDockerScopes = [
    ...(admission.sourceDockerScopes ?? []),
    ...(admission.targetDockerScopes ?? [])
  ];
  const proposedHostIds = [...new Set(
    proposedDockerScopes.flatMap((scope) => scope.hostIds)
  )].sort();
  if (proposedHostIds.length) {
    // Host lifecycle mutations take the docker_hosts row lock before their
    // Docker admission advisory. Recovery and backup enqueue must use the same
    // global order or an update/delete can deadlock with a custom recovery
    // admission path that later calls enqueueJobInTransaction.
    await client.query(
      `SELECT id
       FROM docker_hosts
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR SHARE`,
      [proposedHostIds]
    );
  }
  const hostAdmissionKeys = proposedHostIds.map(
    (hostId) => `docker-mutation-admission:${hostId}`
  );
  const scopedDockerKeys = uniqueScopeKeys(
    proposedDockerScopes.flatMap(dockerMutationAdmissionKeys)
  ).filter((key) => !hostAdmissionKeys.includes(key));
  // Generic enqueue always locks every host admission domain first, then its
  // deterministic target keys. Recovery must use that exact global order:
  // sorting the combined list can put deployment-target:* ahead of
  // docker-mutation-admission:* and invert concurrent generic enqueue.
  for (const key of [...hostAdmissionKeys, ...scopedDockerKeys]) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [key]
    );
  }

  const recoveryKeys = uniqueScopeKeys([
    ...(admission.sourceScopeKeys ?? []),
    ...(admission.targetScopeKeys ?? []),
    ...(admission.recoveryPointId
      ? [`recovery-point:${admission.recoveryPointId}`]
      : [])
  ]);
  for (const key of recoveryKeys) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [key]
    );
  }

  const active = await client.query(
    `SELECT job.id, job.type, job.host_id, job.payload,
            point.host_id AS point_host_id,
            point.app_identity AS point_app_identity,
            point.metadata AS point_metadata,
            migration.source_host_id
              AS migration_source_host_id,
            migration.source_app_identity
              AS migration_source_app_identity,
            migration.recovery_point_id
              AS migration_recovery_point_id,
            migration.plan AS migration_plan
     FROM operation_jobs job
     LEFT JOIN recovery_points point
       ON point.id::text = job.payload->>'recoveryPointId'
     LEFT JOIN migration_runs migration
       ON migration.id::text = job.payload->>'migrationRunId'
     WHERE job.status IN ('queued', 'running')
       AND job.type IN (
         'recovery.create',
         'recovery.capture',
         'recovery.verify',
         'recovery.restore',
         'migration.execute'
       )
       AND (
         cardinality($1::uuid[]) = 0
         OR job.host_id = ANY($1::uuid[])
         OR point.host_id = ANY($1::uuid[])
         OR migration.source_host_id = ANY($1::uuid[])
         OR migration.target_host_id = ANY($1::uuid[])
         OR (
           $2::text IS NOT NULL
           AND job.payload->>'recoveryPointId' = $2
         )
       )
     ORDER BY job.id
    `,
    [proposedHostIds, admission.recoveryPointId ?? null]
  );
  for (const row of active.rows as Array<Record<string, unknown>>) {
    const existing = operationScopesFromRow(row);
    if (existing && operationsConflict(admission, existing)) {
      throw admissionConflict(
        "A conflicting recovery or migration operation is already queued or running for this application, recovery point, or exact target resource.",
        typeof row.id === "string" ? row.id : undefined
      );
    }
  }

  if (
    admission.kind === "capture"
    || admission.kind === "migration"
  ) {
    const obligations = await client.query(
      `SELECT id, host_id, app_identity, metadata
       FROM recovery_points
       WHERE metadata->>'sourceRestartPending' = 'true'
         AND (
           cardinality($1::uuid[]) = 0
           OR host_id = ANY($1::uuid[])
         )
       ORDER BY id
      `,
      [
        (admission.sourceDockerScopes ?? [])
          .flatMap((scope) => scope.hostIds)
      ]
    );
    for (const row of obligations.rows as Array<Record<string, unknown>>) {
      const metadata = metadataRecord(row.metadata);
      const stored = stringArray(
        metadata[RECOVERY_SOURCE_SCOPE_METADATA_KEY]
      );
      const fallback = buildRecoverySourceOperationScopeKeys(
        String(row.host_id),
        recoveryAppIdentitySchema.parse(row.app_identity),
        {
          projectName:
            typeof metadata.projectName === "string"
              ? metadata.projectName
              : null,
          stackId:
            typeof metadata.stackId === "string"
              ? metadata.stackId
              : null
        }
      );
      if (
        scopesOverlap(
          admission.sourceScopeKeys,
          stored.length ? stored : fallback
        )
      ) {
        throw admissionConflict(
          "The source application has an unresolved restart or target-cleanup obligation. Reconcile it before starting another capture or migration."
        );
      }
    }
  }

  const canonicalProposed =
    await canonicalScopes(client, proposedDockerScopes);
  if (canonicalProposed.length) {
    const directJobs = await client.query(
      `SELECT job.id, job.type, job.host_id, job.payload
       FROM operation_jobs job
       WHERE job.status IN ('queued', 'running')
         AND job.type NOT IN (
           'recovery.create',
           'recovery.capture',
           'recovery.verify',
           'recovery.restore',
           'migration.execute'
         )
         AND (
           job.host_id = ANY($1::uuid[])
           OR job.payload->>'targetHostId' = ANY($1::text[])
         )
       ORDER BY job.id
      `,
      [proposedHostIds]
    );
    for (
      const row of directJobs.rows as Array<Record<string, unknown>>
    ) {
      const directScopes =
        await resolvedDirectDockerMutationScopes(
        client,
        row
      );
      for (const direct of directScopes) {
        const canonicalDirect =
          await canonicalizeDockerMutationScope(client, direct);
        if (
          canonicalProposed.some((scope) =>
            dockerMutationScopesConflict(scope, canonicalDirect)
          )
        ) {
          throw admissionConflict(
            "This recovery or migration operation conflicts with an active Docker mutation for an exact source or target resource.",
            typeof row.id === "string" ? row.id : undefined
          );
        }
      }
    }

    for (
      const pending of await activeRestoreAttemptScopes(
        client,
        proposedHostIds
      )
    ) {
      const canonicalPending =
        await canonicalizeDockerMutationScope(client, pending);
      if (
        canonicalProposed.some((scope) =>
          dockerMutationScopesConflict(scope, canonicalPending)
        )
      ) {
        throw admissionConflict(
          "A prior restore attempt still owns an overlapping target resource or is awaiting exact-resource reconciliation."
        );
      }
    }
  }
}
