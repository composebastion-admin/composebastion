import { v4 as uuid } from "uuid";
import path from "node:path";
import type { PoolClient } from "pg";
import type { DockerActionRequest, JobProgressStep, OperationJob } from "@composebastion/shared";
import {
  canonicalizeDockerRegistryAuthority,
  dockerActionSchema,
  jobProgressStepSchema,
  normalizeSavedRegistryOrigin,
  paginationQuerySchema,
  paginatedResponse,
  sanitizeGitRepositoryUrlFields,
  sanitizeUrlDiagnosticText
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { createRedis } from "./redis.js";
import { mapJob, sanitizeOperationJobForRead } from "./mappers.js";
import {
  canonicalizeDockerMutationScope,
  dockerMutationAdmissionKeys,
  dockerMutationScope,
  dockerMutationScopesConflict,
  RECONCILABLE_DOCKER_MUTATION_TYPES,
  type DockerMutationScope
} from "./dockerMutationScope.js";
import {
  hasReconciledRemoteOutcome,
  REMOTE_OUTCOME_RECONCILIATION_KEY
} from "./remoteOutcomeReconciliation.js";
import type { SelfUpdateHandoff } from "./selfUpdate.js";
import { stackRemoteDirectory } from "./remoteFiles.js";
import { extractImagesFromCompose } from "./composeImages.js";
import { decryptSecret } from "./crypto.js";
import { parseImageReference } from "./registryManifest.js";
import {
  assertDockerMutationDoesNotConflictWithRecovery
} from "./recoveryOperationAdmission.js";
import {
  applyGithubDeploymentBinding,
  discardGithubDeploymentBinding,
  failGithubDeploymentBinding,
  githubDeploymentFailureNeedsReconciliation,
  retainGithubDeploymentBinding
} from "./githubDeploymentBinding.js";
import {
  applyGithubCloneDeploymentBinding,
  discardGithubCloneDeploymentBinding,
  failGithubCloneDeploymentBinding,
  retainGithubCloneDeploymentBinding
} from "./githubCloneDeploymentBinding.js";
import {
  remoteMutationProofFromResult
} from "./remoteMutationProof.js";

export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_ACTIVE_WINDOW_SECONDS = 20;
export const JOB_LEASE_SECONDS = 60;
export const JOB_LEASE_MAINTENANCE_INTERVAL_MS = 10_000;
export const MAX_AUTO_ATTEMPTS = 3;

export const AUTO_RETRY_JOB_TYPES = new Set([
  "host.check",
  "host.sync",
  "git.testRemote",
  "backup.verify",
  "recovery.verify"
]);

export const MANUAL_RETRY_JOB_TYPES = new Set([
  ...AUTO_RETRY_JOB_TYPES,
  "host.configureRegistryTrust",
  "deploy.analyze",
  "deploy.execute"
]);

const NON_IDEMPOTENT_WORKER_LOSS_RETRY_TYPES = new Set([
  "host.configureRegistryTrust",
  "deploy.analyze",
  "deploy.execute"
]);

export type JobLease = {
  workerId: string;
  attemptCount: number;
};

export class JobLeaseLostError extends Error {
  readonly code = "JOB_LEASE_LOST";

  constructor(readonly jobId: string) {
    super(`Job ${jobId} no longer has an active lease`);
    this.name = "JobLeaseLostError";
  }
}

export type JobExecutionFence = {
  jobId?: string;
  attemptCount?: number;
  assertActive: () => Promise<void>;
  withActiveLease: <T>(callback: (client: PoolClient) => Promise<T>) => Promise<T>;
};

export type ClaimedOperationJob = OperationJob & JobLease & {
  leaseExpiresAt: string;
};

export function shouldStopWorkerClaimsAfterHandoff(type: string, handoffPending: boolean) {
  return type === "system.self_update" && handoffPending;
}

export function shouldResumeWorkerClaimsAfterReconciliation(result: { completed: number; failed: number; pending: number }) {
  // Another worker may have reconciled the last durable handoff between this
  // worker's polling intervals. An empty result is therefore just as terminal
  // as one that reports a locally completed or failed handoff.
  return result.pending === 0;
}

function mapClaimedJob(row: any): ClaimedOperationJob {
  return {
    ...mapJob(row),
    workerId: row.lease_owner,
    attemptCount: Number(row.attempt_count),
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString()
  };
}

function jobInsert(action: DockerActionRequest, createdBy?: string | null, idempotencyKey?: string | null) {
  return {
    text: `INSERT INTO operation_jobs (id, type, host_id, payload, created_by, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET id = operation_jobs.id
           RETURNING *`,
    values: [uuid(), action.type, action.hostId, action.payload, createdBy ?? null, idempotencyKey ?? null]
  };
}

function actionHostIds(action: DockerActionRequest) {
  const targetHostId = "targetHostId" in action.payload
    && typeof action.payload.targetHostId === "string"
    ? action.payload.targetHostId
    : null;
  return [...new Set([
    action.hostId,
    ...(targetHostId ? [targetHostId] : [])
  ])].sort();
}

async function lockJobHostsForEnqueue(
  client: PoolClient,
  action: DockerActionRequest
) {
  const hostIds = actionHostIds(action);
  const selected = await client.query<{ id: string }>(
    `SELECT id
     FROM docker_hosts
     WHERE id = ANY($1::uuid[])
       AND deleted_at IS NULL
     ORDER BY id
     FOR SHARE`,
    [hostIds]
  );
  if (selected.rows.length !== hostIds.length) {
    throw Object.assign(
      new Error("One or more Docker hosts are unavailable or were deleted."),
      { statusCode: 409 }
    );
  }
  for (const hostId of hostIds) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [`docker-mutation-admission:${hostId}`]
    );
  }
}

type SingleFlightScope = {
  key: string;
  keys?: string[];
  types: string[];
  hostId?: string;
  hostIds?: string[];
  dockerScope?: DockerMutationScope;
  matches: (row: any) => boolean;
  conflictMessage: string;
};

const CROSS_TARGET_JOB_TYPES = [
  ...RECONCILABLE_DOCKER_MUTATION_TYPES,
  "compose.deploy",
  "compose.stop",
  "compose.remove",
  "deploy.analyze",
  "deploy.execute"
] as const;

function normalizedRegistry(value: unknown) {
  return String(value ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function normalizedJobTargetPath(value: unknown) {
  const target = String(value ?? "").trim();
  return target ? path.posix.normalize(target) : target;
}

function isAmbiguousRemoteOutcome(row: any) {
  return row?.status === "failed"
    && (
      String(row.error ?? "").startsWith("WORKER_LOST")
      || String(row.error ?? "").startsWith("REMOTE_OUTCOME_UNKNOWN:")
    );
}

function isUnreconciledRemoteOutcome(row: any) {
  return isAmbiguousRemoteOutcome(row) && !hasReconciledRemoteOutcome(row.result);
}

export async function resolveDockerMutationScopeForJob(
  client: PoolClient,
  input: DockerActionRequest | any
) {
  const direct = dockerMutationScope(input);
  if (direct) return direct;
  const type = String(input?.type ?? "");
  const hostId = String(input?.hostId ?? input?.host_id ?? "");
  const payload = input?.payload && typeof input.payload === "object"
    ? input.payload as Record<string, unknown>
    : {};
  if (
    type === "compose.deploy"
    || type === "compose.stop"
    || type === "compose.remove"
  ) {
    const stackId = String(payload.stackId ?? "");
    if (!stackId || !hostId) return null;
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
    if (!stack) return null;
    return dockerMutationScope({
      type: "compose.deployPath",
      host_id: stack.host_id,
      payload: {
        workingDir: stack.source_working_dir || stackRemoteDirectory(stack.id),
        projectName: stack.project_name,
        _scopeKnown: true
      }
    });
  }
  if (type === "deploy.analyze" && hostId) {
    // Analysis can clone Git state, write an isolated staging tree, and pull
    // images. Until its exact remote primitive is terminal, conservatively
    // serialize it against every mutable Docker/path domain on this host.
    return dockerMutationScope({
      type: "compose.deployPath",
      host_id: hostId,
      payload: {
        workingDir: "*",
        projectName: "*"
      }
    });
  }
  if (type === "deploy.execute") {
    const analysisId = String(payload.analysisId ?? "");
    if (!analysisId || !hostId) return null;
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
    if (!analysis?.working_dir || !analysis.project_name) return null;
    return dockerMutationScope({
      type: "compose.deployPath",
      host_id: analysis.host_id,
      payload: {
        workingDir: analysis.working_dir,
        projectName: analysis.project_name,
        _scopeKnown: true
      }
    });
  }
  return null;
}

function singleFlightScope(action: DockerActionRequest): SingleFlightScope | null {
  if (action.type === "system.self_update") {
    return {
      key: "system.self_update",
      types: ["system.self_update"],
      matches: () => true,
      conflictMessage: "A ComposeBastion self-update is already queued or running."
    };
  }
  if (action.type === "deploy.analyze" || action.type === "deploy.execute") {
    const analysisId = action.payload.analysisId;
    return {
      key: `deployment:${analysisId}`,
      types: ["deploy.analyze", "deploy.execute"],
      matches: (row) => row.payload?.analysisId === analysisId,
      conflictMessage: "This deployment already has an analysis or deployment job queued or running."
    };
  }
  if (action.type === "host.configureRegistryTrust") {
    const registry = normalizedRegistry(action.payload.registry);
    return {
      key: `registry-trust:${action.hostId}:${registry}`,
      types: ["host.configureRegistryTrust"],
      hostId: action.hostId,
      matches: (row) => normalizedRegistry(row.payload?.registry) === registry,
      conflictMessage: "Registry trust configuration for this host and registry is already queued or running."
    };
  }
  if (
    action.type === "compose.deploy"
    || action.type === "compose.stop"
    || action.type === "compose.remove"
  ) {
    const stackId = action.payload.stackId;
    return {
      key: `compose-stack:${action.hostId}:${stackId}`,
      types: ["compose.deploy", "compose.stop", "compose.remove"],
      hostId: action.hostId,
      matches: (row) => row.payload?.stackId === stackId,
      conflictMessage: "This Compose stack already has a deployment, stop, or removal job queued or running."
    };
  }
  const mutationScope = dockerMutationScope(action);
  if (mutationScope) {
    const keys = dockerMutationAdmissionKeys(mutationScope);
    return {
      key: keys[0]!,
      keys,
      types: [...RECONCILABLE_DOCKER_MUTATION_TYPES],
      hostIds: mutationScope.hostIds,
      dockerScope: mutationScope,
      matches: (row) => {
        const candidate = dockerMutationScope(row);
        return Boolean(candidate)
          && dockerMutationScopesConflict(mutationScope, candidate!);
      },
      conflictMessage: "Another remote mutation for the same Docker resource, host path, or Compose project is already queued or running."
    };
  }
  return null;
}

async function findActiveSingleFlightJob(
  client: PoolClient,
  action: DockerActionRequest,
  idempotencyKey?: string | null,
  revivedJobId?: string | null
) {
  const scope = singleFlightScope(action);
  if (!scope) return null;

  const initiallyResolvedDockerScope = await resolveDockerMutationScopeForJob(
    client,
    action
  );
  if (initiallyResolvedDockerScope) {
    scope.dockerScope = initiallyResolvedDockerScope;
    scope.hostIds = initiallyResolvedDockerScope.hostIds;
    scope.keys = [...new Set([
      ...(scope.keys ?? [scope.key]),
      ...dockerMutationAdmissionKeys(initiallyResolvedDockerScope)
    ])].sort();
    scope.key = scope.keys[0]!;
    scope.types = [...new Set([
      ...scope.types,
      ...CROSS_TARGET_JOB_TYPES
    ])];
  }
  for (const key of scope.keys ?? [scope.key]) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [key]
    );
  }
  const values: unknown[] = [scope.types];
  const hostPredicate = scope.hostId
    ? ` AND host_id = $${values.push(scope.hostId)}`
    : scope.hostIds?.length
      ? ` AND (
            host_id = ANY($${values.push(scope.hostIds)}::uuid[])
            OR payload->>'targetHostId' = ANY($${values.length}::text[])
          )`
      : "";
  const requestedDockerScope = scope.dockerScope
    ? await canonicalizeDockerMutationScope(client, scope.dockerScope)
    : null;
  if (requestedDockerScope) {
    await assertDockerMutationDoesNotConflictWithRecovery(
      client,
      requestedDockerScope
    );
  }
  const matches = async (row: any) => {
    if (scope.matches(row)) return true;
    if (!requestedDockerScope) return false;
    const candidate = await resolveDockerMutationScopeForJob(client, row);
    if (!candidate) return false;
    const canonicalCandidate = await canonicalizeDockerMutationScope(client, candidate);
    return dockerMutationScopesConflict(requestedDockerScope, canonicalCandidate);
  };
  const active = await client.query(
    `SELECT *
     FROM operation_jobs
     WHERE status IN ('queued', 'running')
       AND type = ANY($1::text[])${hostPredicate}
     FOR UPDATE`,
    values
  );
  let row: any = null;
  for (const candidate of active.rows) {
    if (await matches(candidate)) {
      row = candidate;
      break;
    }
  }
  if (row) {
    if (revivedJobId && row.id === revivedJobId) return row;
    if (idempotencyKey && row.idempotency_key === idempotencyKey) return row;
    throw Object.assign(new Error(scope.conflictMessage), {
      statusCode: 409,
      activeJobId: row.id
    });
  }

  const ambiguous = await client.query(
    `SELECT *
     FROM operation_jobs
     WHERE status = 'failed'
       AND type = ANY($1::text[])${hostPredicate}
       AND (
         error LIKE 'WORKER_LOST%'
         OR error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
       )
     ORDER BY completed_at DESC`,
    values
  );
  let unresolved: any = null;
  for (const candidate of ambiguous.rows) {
    if (
      isUnreconciledRemoteOutcome(candidate)
      && await matches(candidate)
    ) {
      unresolved = candidate;
      break;
    }
  }
  if (unresolved) {
    throw conflictError(
      "A prior remote operation on this target has an unknown outcome. ComposeBastion will unlock it only after bounded quiescence and authoritative target reconciliation.",
      unresolved.id
    );
  }
  return null;
}

/**
 * Hold the same host rows and advisory domains used by queued Docker work
 * while a synchronous external mutation runs. Active or unresolved jobs are
 * rejected before the callback, and enqueues that arrive afterward wait until
 * the callback finishes. This is intentionally conservative for host paths:
 * remote symlinks make lexical path disjointness non-authoritative.
 */
export async function withSynchronousDockerMutationAdmission<T>(
  action: DockerActionRequest,
  operation: (client: PoolClient) => Promise<T>
) {
  const parsed = dockerActionSchema.parse(action);
  return withTransaction(async (client) => {
    await lockJobHostsForEnqueue(client, parsed);
    await findActiveSingleFlightJob(client, parsed);
    return operation(client);
  });
}

function conflictError(message: string, activeJobId?: string) {
  return Object.assign(new Error(message), {
    statusCode: 409,
    ...(activeJobId ? { activeJobId } : {})
  });
}

/**
 * Serialize a user-visible stack mutation with compose job enqueueing.
 *
 * Callers must perform the mutation through the same transaction/client after
 * this returns. The stack row lock protects its identity while the advisory
 * lock establishes an ordering against enqueueJobInTransaction.
 */
export async function lockComposeStackForMutation<T = any>(
  client: PoolClient,
  stackId: string
): Promise<T | null> {
  const selected = await client.query(
    "SELECT * FROM compose_stacks WHERE id = $1 FOR UPDATE",
    [stackId]
  );
  const stack = selected.rows[0] as (
    T & { host_id: string; project_name: string }
  ) | undefined;
  if (!stack) return null;

  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`compose-stack:${stack.host_id}:${stackId}`]
  );
  const operations = await client.query(
    `SELECT id, status, error, result
     FROM operation_jobs
     WHERE type IN ('compose.deploy', 'compose.stop', 'compose.remove')
       AND host_id = $2
       AND payload->>'stackId' = $1
       AND (
         status IN ('queued', 'running')
         OR (
           status = 'failed'
           AND (
             error LIKE 'WORKER_LOST%'
             OR error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
         )
       )
     ORDER BY created_at ASC`,
    [stackId, stack.host_id]
  );
  const active = operations.rows.find((row) =>
    row.status === "queued" || row.status === "running"
  );
  if (active) {
    throw conflictError(
      "This Compose stack cannot be changed while a deployment, stop, or removal job is queued or running.",
      active.id
    );
  }
  const unresolved = operations.rows.find(isUnreconciledRemoteOutcome);
  if (unresolved) {
    throw conflictError(
      "This Compose stack cannot be changed until its prior unknown remote outcome has been authoritatively reconciled.",
      unresolved.id
    );
  }

  // Bindings are normally paired with a queued/running compose.deploy row.
  // Check independently so a damaged or manually altered queue cannot make a
  // still-authoritative deployment snapshot mutable.
  const binding = await client.query<{ operation_job_id: string }>(
    `SELECT operation_job_id
     FROM (
       SELECT operation_job_id, created_at
       FROM github_deployment_jobs
       WHERE stack_id = $1
       UNION ALL
       SELECT operation_job_id, created_at
       FROM github_clone_deployment_jobs
       WHERE stack_id = $1
          OR (host_id = $2 AND project_name = $3)
     ) AS bindings
     ORDER BY created_at ASC
     LIMIT 1`,
    [stackId, stack.host_id, stack.project_name]
  );
  if (binding.rows[0]) {
    throw conflictError(
      "This Compose stack cannot be changed while its GitHub deployment outcome is unresolved.",
      binding.rows[0].operation_job_id
    );
  }
  return stack;
}

/**
 * Lock a repository and reject edits, deletion, or a second deployment while
 * an API-mode binding or host-clone deployment still owns its outcome.
 */
export async function lockGithubRepositoryForMutation<T = any>(
  client: PoolClient,
  repositoryId: string
): Promise<T | null> {
  const selected = await client.query(
    "SELECT * FROM github_repositories WHERE id = $1 FOR UPDATE",
    [repositoryId]
  );
  const repository = selected.rows[0] as T | undefined;
  if (!repository) return null;

  const binding = await client.query<{ operation_job_id: string }>(
    `SELECT operation_job_id
     FROM (
       SELECT operation_job_id, created_at
       FROM github_deployment_jobs
       WHERE repository_id = $1
       UNION ALL
       SELECT operation_job_id, created_at
       FROM github_clone_deployment_jobs
       WHERE repository_id = $1
     ) AS bindings
     ORDER BY created_at ASC
     LIMIT 1`,
    [repositoryId]
  );
  if (binding.rows[0]) {
    throw conflictError(
      "This GitHub repository cannot be changed while its deployment outcome is unresolved.",
      binding.rows[0].operation_job_id
    );
  }

  const cloneDeploy = await client.query(
    `SELECT id, status, error, result
     FROM operation_jobs
     WHERE type = 'git.cloneDeploy'
       AND payload->>'repositoryId' = $1
       AND (
         status IN ('queued', 'running')
         OR (
           status = 'failed'
           AND (
             error LIKE 'WORKER_LOST%'
             OR error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
         )
       )
     ORDER BY created_at ASC`,
    [repositoryId]
  );
  const activeClone = cloneDeploy.rows.find((row) =>
    row.status === "queued" || row.status === "running"
  );
  if (activeClone) {
    throw conflictError(
      "This GitHub repository cannot be changed while a clone/build deployment is queued or running.",
      activeClone.id
    );
  }
  const unresolvedClone = cloneDeploy.rows.find(isUnreconciledRemoteOutcome);
  if (unresolvedClone) {
    throw conflictError(
      "This GitHub repository cannot be changed until its prior clone/build outcome has been authoritatively reconciled.",
      unresolvedClone.id
    );
  }
  return repository;
}

export async function notifyJobQueued(jobId: string) {
  const redis = createRedis();
  if (!redis) return;
  try {
    await redis.connect();
    await redis.publish("jobs:queued", jobId);
  } catch (error) {
    // PostgreSQL is the durable queue. Redis only reduces pickup latency, so
    // never report a failed request after the job row has committed.
    console.warn("Job wake-up publish failed; database polling will pick it up", {
      jobId,
      errorType: typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "REDIS_ERROR")
        : error instanceof Error ? error.name : "REDIS_ERROR"
    });
  } finally {
    redis.disconnect();
  }
}

/**
 * Insert a job as part of a caller-owned PostgreSQL transaction. The caller
 * must invoke notifyJobQueued(job.id) only after that transaction commits.
 */
export async function enqueueJobInTransaction(
  client: PoolClient,
  action: DockerActionRequest,
  createdBy?: string | null,
  idempotencyKey?: string | null
) {
  const parsed = dockerActionSchema.parse(action);
  await lockJobHostsForEnqueue(client, parsed);
  const active = await findActiveSingleFlightJob(client, parsed, idempotencyKey);
  if (active) return mapJob(active);
  const insert = jobInsert(parsed, createdBy, idempotencyKey);
  const result = await client.query(insert.text, insert.values);
  const row = result.rows[0];
  if (!row) throw new Error("Failed to enqueue job");
  return sanitizeOperationJobForRead(mapJob(row));
}

export async function enqueueJob(
  action: DockerActionRequest,
  createdBy?: string | null,
  idempotencyKey?: string | null
) {
  const parsed = dockerActionSchema.parse(action);
  const job = await withTransaction((client) => (
    enqueueJobInTransaction(client, parsed, createdBy, idempotencyKey)
  ));
  await notifyJobQueued(job.id);
  return sanitizeOperationJobForRead(job);
}

export async function listJobs(queryInput: unknown) {
  const queryParams = paginationQuerySchema.parse(queryInput);
  const [rows, total] = await Promise.all([
    query(
      `SELECT *
       FROM operation_jobs
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [queryParams.limit, queryParams.offset]
    ),
    query<{ count: string }>("SELECT count(*)::text AS count FROM operation_jobs")
  ]);
  return paginatedResponse(
    rows.rows.map(mapJob),
    Number(total.rows[0]?.count ?? 0),
    queryParams
  );
}

export async function getJob(id: string) {
  const result = await query("SELECT * FROM operation_jobs WHERE id = $1", [id]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

function progressLabels(type: string) {
  if (type === "backup.verify" || type === "recovery.verify") return ["Prepare", "Verify", "Finish"];
  if (type === "backup.drill") return ["Prepare", "Drill", "Verify", "Finish"];
  if (type === "volume.backup" || type === "hostPath.backup" || type === "recovery.create" || type === "recovery.capture") return ["Prepare", "Capture", "Store", "Finish"];
  if (type === "volume.restore" || type === "hostPath.restore" || type === "recovery.restore") return ["Prepare", "Restore", "Verify", "Finish"];
  if (type.startsWith("migration.")) return ["Plan", "Capture", "Transfer", "Deploy", "Verify"];
  if (type === "deploy.analyze") return ["Detect", "Inspect", "Preflight", "Review"];
  if (type === "deploy.execute") return ["Prepare", "Deploy", "Save", "Verify"];
  if (type === "host.configureRegistryTrust") return ["Backup", "Validate", "Restart", "Verify"];
  if (type.startsWith("compose.") || type === "git.cloneDeploy") return ["Prepare", "Deploy", "Verify"];
  if (type === "system.self_update") return ["Prepare", "Handoff", "Reconnect"];
  if (type === "host.sync") return ["Connect", "Inventory", "Store"];
  if (type === "host.check") return ["Connect", "Check", "Store"];
  if (type.startsWith("image.") || type === "container.update") return ["Inspect", "Apply", "Verify"];
  return ["Run", "Finish"];
}

function stepId(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function buildJobProgress(type: string, phase: "running" | "completed" | "failed", activeStepId?: string, detail?: string): JobProgressStep[] {
  const labels = progressLabels(type);
  const requestedIndex = labels.findIndex((label) => stepId(label) === activeStepId);
  const activeIndex = requestedIndex >= 0 ? requestedIndex : phase === "failed" ? labels.length - 1 : 0;
  return labels.map((label, index) => {
    const status = phase === "running"
      ? index < activeIndex ? "completed" : index === activeIndex ? "running" : "pending"
      : phase === "completed"
        ? "completed"
        : index < activeIndex ? "completed" : index === activeIndex ? "failed" : "pending";
    return jobProgressStepSchema.parse({
      id: stepId(label),
      label,
      status,
      detail: (phase === "running" || phase === "failed") && index === activeIndex ? detail : undefined
    });
  });
}

export async function updateJobProgress(id: string, steps: JobProgressStep[], lease: JobLease) {
  const parsed = sanitizeGitRepositoryUrlFields(
    steps.map((step) => jobProgressStepSchema.parse(step))
  );
  const predicate = leasePredicate(lease);
  const result = await query(
    `UPDATE operation_jobs
     SET progress = $2, updated_at = now()
     WHERE id = $1${predicate.sql}
     RETURNING *`,
    [id, JSON.stringify(parsed), ...predicate.values]
  );
  if (!result.rows[0]) throw new JobLeaseLostError(id);
  return mapJob(result.rows[0]);
}

export async function markJobProgressStep(jobId: string, type: string, activeStepId: string, detail: string | undefined, lease: JobLease) {
  return updateJobProgress(jobId, buildJobProgress(type, "running", activeStepId, detail), lease);
}

export async function cancelQueuedJob(
  id: string,
  onCanceled?: (
    client: PoolClient,
    result: { job: OperationJob; canceled: true }
  ) => Promise<void>
) {
  const cancellationMessage = "Canceled before start";
  return withTransaction(async (client) => {
    // Claim and cancellation both transition the same queued row under its
    // PostgreSQL row lock. Whichever transition commits first wins, and linked
    // domain state is finalized in the same transaction as cancellation.
    const result = await client.query(
      `UPDATE operation_jobs
       SET status = 'canceled',
           error = $2,
           completed_at = now(),
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1 AND status = 'queued'
       RETURNING *`,
      [id, cancellationMessage]
    );
    if (result.rows[0]) {
      await finalizeLinkedOperationFailure(client, result.rows[0], cancellationMessage);
      await discardGithubDeploymentBinding(client, id);
      await discardGithubCloneDeploymentBinding(client, id);
      const canceled = {
        job: mapJob(result.rows[0]),
        canceled: true as const
      };
      await onCanceled?.(client, canceled);
      return canceled;
    }
    const selected = await client.query(
      "SELECT * FROM operation_jobs WHERE id = $1",
      [id]
    );
    return {
      job: selected.rows[0] ? mapJob(selected.rows[0]) : null,
      canceled: false
    };
  });
}

async function lockRetryAdmissionResource(
  client: PoolClient,
  action: DockerActionRequest
) {
  const reference = action.type === "backup.verify"
    ? {
      table: "backups",
      id: action.payload.backupId
    }
    : action.type === "recovery.verify"
      ? {
        table: "recovery_points",
        id: action.payload.recoveryPointId
      }
      : null;
  if (!reference) return true;
  const selected = await client.query(
    `SELECT metadata
     FROM ${reference.table}
     WHERE id = $1
     FOR UPDATE`,
    [reference.id]
  );
  const metadata = selected.rows[0]?.metadata;
  return Boolean(selected.rows[0])
    && !(
      typeof metadata === "object"
      && metadata !== null
      && typeof metadata.deletionClaimToken === "string"
      && metadata.deletionClaimToken.length > 0
    );
}

function canRetryJob(original: OperationJob, row: any) {
  const ambiguousWorkerLoss = NON_IDEMPOTENT_WORKER_LOSS_RETRY_TYPES.has(original.type)
    && (
      original.error?.startsWith("WORKER_LOST")
      || original.error?.startsWith("REMOTE_OUTCOME_UNKNOWN:")
    );
  return (
    (original.status === "failed" || original.status === "canceled")
    && Boolean(original.hostId)
    && MANUAL_RETRY_JOB_TYPES.has(original.type)
    && Number(row.attempt_count ?? 0) < MAX_AUTO_ATTEMPTS
    // The expired worker may still be mutating Docker or deployment state.
    // Reconciliation must establish the remote outcome before a new
    // dedicated operation is allowed; replaying this row is unsafe.
    && !ambiguousWorkerLoss
  );
}

function deploymentAnalysisAllowsRetry(action: DockerActionRequest, row: any) {
  if (
    (action.type !== "deploy.analyze" && action.type !== "deploy.execute")
    || !row
    || row.unexpired !== true
    || row.host_id !== action.hostId
  ) {
    return false;
  }
  return action.type === "deploy.analyze"
    ? row.status === "queued" || row.status === "failed"
    : row.status === "deploying" || row.status === "failed";
}

async function lockDeploymentRetryTargets(
  client: PoolClient,
  action: DockerActionRequest,
  analysis: {
    id: string;
    host_id: string;
    working_dir: string | null;
    project_name: string | null;
  }
) {
  if (action.type !== "deploy.execute") return;
  const normalizedPath = normalizedJobTargetPath(analysis.working_dir);
  const normalizedProject = String(analysis.project_name ?? "").trim().toLowerCase();
  if (!normalizedPath || !normalizedProject) {
    throw conflictError(
      "This deployment cannot be retried until its working directory and project name are resolved."
    );
  }
  const keys = [...new Set([
    `deployment-target:path:${analysis.host_id}:${normalizedPath}`,
    `deployment-target:project:${analysis.host_id}:${normalizedProject}`
  ])].sort();
  for (const key of keys) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [key]
    );
  }

  const conflict = await client.query<{ id: string }>(
    `SELECT jobs.id
     FROM deployment_analyses AS analyses
     JOIN operation_jobs AS jobs
       ON jobs.type = 'deploy.execute'
      AND jobs.payload->>'analysisId' = analyses.id::text
     WHERE analyses.id <> $1
       AND analyses.host_id = $2
       AND (
         jobs.status IN ('queued', 'running')
         OR (
           (
             jobs.status = 'failed'
             OR analyses.error LIKE 'WORKER_LOST:%'
             OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
           AND (
             jobs.error LIKE 'WORKER_LOST%'
             OR jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
             OR analyses.error LIKE 'WORKER_LOST:%'
             OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
           AND COALESCE(jobs.result-> $5 ->> 'status', '') <> 'reconciled'
         )
       )
       AND (
         analyses.working_dir = $3
         OR lower(analyses.project_name) = $4
       )
     ORDER BY jobs.created_at ASC
     LIMIT 1
     FOR UPDATE OF jobs`,
    [
      analysis.id,
      analysis.host_id,
      normalizedPath,
      normalizedProject,
      REMOTE_OUTCOME_RECONCILIATION_KEY
    ]
  );
  if (conflict.rows[0]) {
    throw conflictError(
      "Another deployment for this host directory or Compose project is already queued or running.",
      conflict.rows[0].id
    );
  }
}

async function requeueJob(
  client: PoolClient,
  id: string,
  createdBy?: string | null
) {
  return client.query(
    `UPDATE operation_jobs
     SET status = 'queued', result = NULL, error = NULL, progress = '[]'::jsonb,
         created_by = COALESCE($2, created_by), started_at = NULL, completed_at = NULL,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1
       AND status IN ('failed', 'canceled')
       AND attempt_count < $3
     RETURNING *`,
    [id, createdBy ?? null, MAX_AUTO_ATTEMPTS]
  );
}

function registryAuthorityForRetry(row: {
  url: string;
  insecure: boolean;
}) {
  const origin = normalizeSavedRegistryOrigin(String(row.url), {
    defaultProtocol: row.insecure ? "http" : "https"
  });
  return canonicalizeDockerRegistryAuthority(new URL(origin).host);
}

async function deploymentRegistryCredentialWasDeleted(
  client: PoolClient,
  authorities: Set<string>,
  originalCreatedAt: unknown
) {
  const deletedSinceOriginal = await client.query<{
    authority: string | null;
  }>(
    `SELECT details->>'authority' AS authority
     FROM audit_events
     WHERE action = 'registry.delete'
       AND created_at >= $1::timestamptz
     ORDER BY created_at ASC`,
    [new Date(String(originalCreatedAt)).toISOString()]
  );
  return deletedSinceOriginal.rows.some((row) => {
    if (!row.authority) return true;
    try {
      return authorities.has(
        canonicalizeDockerRegistryAuthority(row.authority)
      );
    } catch {
      return true;
    }
  });
}

function deletedDeploymentRegistryCredentialError() {
  return Object.assign(
    new Error(
      "Registry credentials used by this deployment may have been deleted. Analyze the deployment again before retrying."
    ),
    { statusCode: 409 }
  );
}

async function lockDeploymentRetryRegistryCredentials(
  client: PoolClient,
  composeYaml: unknown,
  encryptedEnvironment: unknown,
  originalCreatedAt: unknown
) {
  if (typeof composeYaml !== "string" || !composeYaml.trim()) return;
  let authorities: Set<string>;
  try {
    const environment = typeof encryptedEnvironment === "string"
      && encryptedEnvironment
      ? decryptSecret(encryptedEnvironment)
      : "";
    authorities = new Set(
      extractImagesFromCompose(composeYaml, environment).map((image) =>
        canonicalizeDockerRegistryAuthority(
          parseImageReference(image).registry
        )
      )
    );
  } catch {
    throw Object.assign(
      new Error(
        "The saved deployment definition is no longer valid. Analyze the deployment again before retrying."
      ),
      { statusCode: 409 }
    );
  }
  if (!authorities.size) return;

  if (await deploymentRegistryCredentialWasDeleted(
    client,
    authorities,
    originalCreatedAt
  )) {
    throw deletedDeploymentRegistryCredentialError();
  }

  const available = await client.query<{
    id: string;
    url: string;
    insecure: boolean;
  }>(
    "SELECT id, url, insecure FROM registries ORDER BY id ASC"
  );
  const relevantIds = available.rows
    .filter((row) => authorities.has(registryAuthorityForRetry(row)))
    .map((row) => row.id)
    .sort();
  for (const registryId of relevantIds) {
    try {
      const locked = await client.query(
        "SELECT id FROM registries WHERE id = $1 FOR UPDATE NOWAIT",
        [registryId]
      );
      if (!locked.rows[0]) {
        throw Object.assign(
          new Error(
            "Registry credentials changed while this deployment retry was being prepared. Analyze again."
          ),
          { statusCode: 409 }
        );
      }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 409) throw error;
      throw Object.assign(
        new Error(
          "Registry credentials are being changed. Retry the deployment after that change finishes."
        ),
        { statusCode: 409 }
      );
    }
  }
  // Registry mutation transactions write registry.delete audit evidence
  // atomically with deletion. Re-read it after the relevant row locks: a
  // deletion that committed between the first audit snapshot and the unlocked
  // registry enumeration must not silently turn a credentialed retry into an
  // anonymous pull. Any deletion that starts after this point is blocked by
  // the held registry row until the retry job is durably queued.
  if (await deploymentRegistryCredentialWasDeleted(
    client,
    authorities,
    originalCreatedAt
  )) {
    throw deletedDeploymentRegistryCredentialError();
  }
}

export async function retryJob(
  id: string,
  createdBy?: string | null,
  onRetried?: (
    client: PoolClient,
    result: { original: OperationJob; retried: OperationJob }
  ) => Promise<void>
) {
  // Determine whether this retry must participate in deployment-analysis
  // admission before taking any operation_jobs lock. The row is re-read under
  // lock before mutation, so this read is only a lock-order routing hint.
  const preliminarySelected = await query("SELECT * FROM operation_jobs WHERE id = $1", [id]);
  const preliminaryRow = preliminarySelected.rows[0];
  if (!preliminaryRow) return { original: null, retried: null };
  const preliminaryOriginal = mapJob(preliminaryRow);
  if (!canRetryJob(preliminaryOriginal, preliminaryRow)) {
    return { original: preliminaryOriginal, retried: null };
  }
  const preliminaryAction = dockerActionSchema.parse({
    type: preliminaryOriginal.type,
    hostId: preliminaryOriginal.hostId,
    payload: preliminaryOriginal.payload
  });

  const deploymentRetry = preliminaryAction.type === "deploy.analyze"
    || preliminaryAction.type === "deploy.execute";
  const preliminaryAnalysis = deploymentRetry
    ? (
        await query(
          `SELECT id,
                  host_id,
                  status,
                  working_dir,
                  project_name,
                  compose_yaml,
                  env_encrypted,
                  expires_at,
                  expires_at > clock_timestamp() AS unexpired
           FROM deployment_analyses
           WHERE id = $1`,
          [preliminaryAction.payload.analysisId]
        )
      ).rows[0]
    : null;
  const result = deploymentRetry
    ? await withTransaction(async (client) => {
      // All deployment producers use one global order: host row/admission
      // advisory, registry rows, analysis row, target advisories, then job rows.
      // The unlocked analysis read above is only a routing snapshot. Any change
      // to the Compose definition while these earlier locks are acquired makes
      // this retry fail closed after the analysis row is locked.
      const analysisId = preliminaryAction.payload.analysisId;
      await lockJobHostsForEnqueue(client, preliminaryAction);
      if (preliminaryAction.type === "deploy.execute") {
        await lockDeploymentRetryRegistryCredentials(
          client,
          preliminaryAnalysis?.compose_yaml,
          preliminaryAnalysis?.env_encrypted,
          preliminaryRow.created_at
        );
      }
      const analysisSelected = await client.query(
        `SELECT id,
                host_id,
                status,
                working_dir,
                project_name,
                compose_yaml,
                env_encrypted,
                expires_at,
                expires_at > clock_timestamp() AS unexpired
         FROM deployment_analyses
         WHERE id = $1
         FOR UPDATE`,
        [analysisId]
      );
      if (!deploymentAnalysisAllowsRetry(preliminaryAction, analysisSelected.rows[0])) {
        return { original: preliminaryOriginal, retried: null };
      }
      if (
        preliminaryAction.type === "deploy.execute"
        && (
          analysisSelected.rows[0]?.compose_yaml !== preliminaryAnalysis?.compose_yaml
          || analysisSelected.rows[0]?.env_encrypted !== preliminaryAnalysis?.env_encrypted
        )
      ) {
        return { original: preliminaryOriginal, retried: null };
      }

      await lockDeploymentRetryTargets(client, preliminaryAction, analysisSelected.rows[0]);
      await findActiveSingleFlightJob(client, preliminaryAction, null, id);

      const selected = await client.query(
        "SELECT * FROM operation_jobs WHERE id = $1 FOR UPDATE",
        [id]
      );
      const row = selected.rows[0];
      if (!row) return { original: null, retried: null };
      const original = mapJob(row);
      if (!canRetryJob(original, row)) return { original, retried: null };
      const retryAction = dockerActionSchema.parse({
        type: original.type,
        hostId: original.hostId,
        payload: original.payload
      });
      if (
        retryAction.type !== preliminaryAction.type
        || (
          retryAction.type !== "deploy.analyze"
          && retryAction.type !== "deploy.execute"
        )
        || retryAction.payload.analysisId !== analysisId
        || retryAction.hostId !== preliminaryAction.hostId
      ) {
        return { original, retried: null };
      }

      const retriedResult = await requeueJob(client, id, createdBy);
      const retried = retriedResult.rows[0]
        ? mapJob(retriedResult.rows[0])
        : null;
      if (retried) {
        await onRetried?.(client, { original, retried });
      }
      return {
        original,
        retried
      };
    })
    : await withTransaction(async (client) => {
      await lockJobHostsForEnqueue(client, preliminaryAction);
      const selected = await client.query("SELECT * FROM operation_jobs WHERE id = $1 FOR UPDATE", [id]);
      const row = selected.rows[0];
      if (!row) return { original: null, retried: null };
      const original = mapJob(row);
      if (!canRetryJob(original, row)) {
        return { original, retried: null };
      }

      // Manual retry is another enqueue path. Apply the same advisory-lock
      // single-flight policy before reviving the existing row so it cannot race a
      // newly queued deployment or registry-trust operation.
      const retryAction = dockerActionSchema.parse({
        type: original.type,
        hostId: original.hostId,
        payload: original.payload
      });
      if (!(await lockRetryAdmissionResource(client, retryAction))) {
        return { original, retried: null };
      }
      await findActiveSingleFlightJob(client, retryAction);

      const retriedResult = await requeueJob(client, id, createdBy);
      const retried = retriedResult.rows[0]
        ? mapJob(retriedResult.rows[0])
        : null;
      if (retried) {
        await onRetried?.(client, { original, retried });
      }
      return {
        original,
        retried
      };
    });
  if (result.retried) await notifyJobQueued(result.retried.id);
  return result;
}

export async function getWorkerStatus() {
  const [result, queued, running, workers, pendingSelfUpdateHandoffs] = await Promise.all([
    query<{ completed_at: Date | string | null }>(
      `SELECT completed_at
       FROM operation_jobs
       WHERE status IN ('completed', 'failed', 'canceled')
       ORDER BY completed_at DESC NULLS LAST
       LIMIT 1`
    ),
    query<{ count: string }>("SELECT count(*)::text AS count FROM operation_jobs WHERE status = 'queued'"),
    query<{ count: string }>("SELECT count(*)::text AS count FROM operation_jobs WHERE status = 'running'"),
    query<{
      active_count: string;
      recent_draining_count: string;
      last_heartbeat_at: Date | string | null;
      heartbeat_fresh: boolean;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE status = 'active'
             AND last_heartbeat_at >= now() - ($1 * interval '1 second')
         )::text AS active_count,
         count(*) FILTER (
           WHERE status = 'draining'
             AND last_heartbeat_at >= now() - ($1 * interval '1 second')
         )::text AS recent_draining_count,
         max(last_heartbeat_at) AS last_heartbeat_at,
         COALESCE(
           max(last_heartbeat_at) >= now() - ($1 * interval '1 second'),
           false
         ) AS heartbeat_fresh
       FROM worker_instances`,
      [WORKER_ACTIVE_WINDOW_SECONDS]
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM operation_jobs
       WHERE type = 'system.self_update'
         AND status = 'running'
         AND result @> '{"handoffPending":true}'::jsonb`
    )
  ]);
  const last = result.rows[0]?.completed_at;
  const workerRow = workers.rows[0];
  const activeWorkers = Number(workerRow?.active_count ?? 0);
  const recentDrainingWorkers = Number(workerRow?.recent_draining_count ?? 0);
  const lastHeartbeat = workerRow?.last_heartbeat_at;
  const lastHeartbeatAt = lastHeartbeat ? new Date(lastHeartbeat).toISOString() : null;
  const lastHeartbeatIsFresh = workerRow?.heartbeat_fresh ?? false;
  // A pending self-update handoff is a durable, global claim-admission gate:
  // every worker intentionally refuses new jobs until one reconciles the
  // authoritative outcome. Fresh process heartbeats must not make readiness
  // claim that this blocked worker pool is available.
  const claimsBlockedBySelfUpdate = Number(pendingSelfUpdateHandoffs.rows[0]?.count ?? 0) > 0;
  const available = activeWorkers > 0 && !claimsBlockedBySelfUpdate;
  return {
    queued: Number(queued.rows[0]?.count ?? 0),
    running: Number(running.rows[0]?.count ?? 0),
    lastJobCompletedAt: last ? new Date(last).toISOString() : null,
    available,
    activeWorkers,
    lastHeartbeatAt,
    state: claimsBlockedBySelfUpdate && activeWorkers > 0
      ? "draining" as const
      : activeWorkers > 0
        ? "active" as const
        : recentDrainingWorkers > 0
          ? "draining" as const
          : lastHeartbeatIsFresh || !lastHeartbeatAt
            ? "absent" as const
            : "stale" as const
  };
}

export async function registerWorkerInstance(input: { id: string; version: string; hostname: string }) {
  await query(
    `INSERT INTO worker_instances (id, version, hostname, status, started_at, last_heartbeat_at, stopped_at)
     VALUES ($1, $2, $3, 'active', now(), now(), NULL)
     ON CONFLICT (id) DO UPDATE
     SET version = EXCLUDED.version,
         hostname = EXCLUDED.hostname,
         status = 'active',
         started_at = now(),
         last_heartbeat_at = now(),
         stopped_at = NULL`,
    [input.id, input.version, input.hostname]
  );
}

export async function heartbeatWorker(id: string) {
  const result = await query(
    `UPDATE worker_instances
     SET last_heartbeat_at = now()
     WHERE id = $1 AND status = 'active'`,
    [id]
  );
  return result.rowCount === 1;
}

export async function markWorkerDraining(id: string) {
  await query(
    `UPDATE worker_instances
     SET status = 'draining', last_heartbeat_at = now()
     WHERE id = $1 AND status = 'active'`,
    [id]
  );
}

export async function markWorkerStopped(id: string) {
  await query(
    `UPDATE worker_instances
     SET status = 'stopped', stopped_at = now(), last_heartbeat_at = now()
     WHERE id = $1`,
    [id]
  );
}

export async function cleanupWorkerInstances() {
  await query(
    `DELETE FROM worker_instances
     WHERE (status = 'stopped' AND stopped_at < now() - interval '7 days')
        OR (status <> 'stopped' AND last_heartbeat_at < now() - interval '7 days')`
  );
}

export async function claimNextJob(workerId: string): Promise<ClaimedOperationJob | null> {
  const result = await query(
    `WITH next_job AS (
       SELECT id
       FROM operation_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE operation_jobs AS jobs
     SET status = 'running',
         started_at = COALESCE(jobs.started_at, now()),
         completed_at = NULL,
         error = NULL,
         lease_owner = $1,
         lease_expires_at = now() + ($2 * interval '1 second'),
         attempt_count = jobs.attempt_count + 1,
         updated_at = now()
     FROM next_job
     WHERE jobs.id = next_job.id
     RETURNING jobs.*`,
    [workerId, JOB_LEASE_SECONDS]
  );
  return result.rows[0] ? mapClaimedJob(result.rows[0]) : null;
}

export async function renewJobLease(id: string, lease: JobLease) {
  const result = await query(
    `UPDATE operation_jobs
     SET lease_expires_at = now() + ($4 * interval '1 second'), updated_at = now()
     WHERE id = $1
       AND status = 'running'
       AND lease_owner = $2
       AND attempt_count = $3
       AND lease_expires_at > clock_timestamp()`,
    [id, lease.workerId, lease.attemptCount, JOB_LEASE_SECONDS]
  );
  return result.rowCount === 1;
}

function leasePredicate(lease: JobLease) {
  return {
    sql: " AND status = 'running' AND lease_owner = $3 AND attempt_count = $4 AND lease_expires_at > clock_timestamp()",
    values: [lease.workerId, lease.attemptCount]
  };
}

export async function assertJobLeaseActive(id: string, lease: JobLease) {
  const result = await query(
    `SELECT 1
     FROM operation_jobs
     WHERE id = $1
       AND status = 'running'
       AND lease_owner = $2
       AND attempt_count = $3
       AND lease_expires_at > clock_timestamp()`,
    [id, lease.workerId, lease.attemptCount]
  );
  if (result.rowCount !== 1) throw new JobLeaseLostError(id);
}

export async function withActiveJobLeaseTransaction<T>(
  id: string,
  lease: JobLease,
  callback: (client: PoolClient) => Promise<T>
) {
  return withTransaction(async (client) => {
    const active = await client.query(
      `SELECT 1
       FROM operation_jobs
       WHERE id = $1
         AND status = 'running'
         AND lease_owner = $2
         AND attempt_count = $3
         AND lease_expires_at > clock_timestamp()
       FOR UPDATE`,
      [id, lease.workerId, lease.attemptCount]
    );
    if (active.rowCount !== 1) throw new JobLeaseLostError(id);
    return callback(client);
  });
}

export async function completeJob(id: string, resultValue: Record<string, unknown>, lease: JobLease) {
  const predicate = leasePredicate(lease);
  const safeResult = sanitizeGitRepositoryUrlFields(resultValue);
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE operation_jobs
       SET status = 'completed', result = $2, error = null, completed_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1${predicate.sql}
       RETURNING id, type, host_id, payload`,
      [id, safeResult, ...predicate.values]
    );
    if (result.rowCount !== 1) return false;
    const completionRow = result.rows[0] as SuccessfulJobCompletionRow;
    const migrationIdentity = parseMigrationCompletionIdentity(
      completionRow,
      safeResult
    );
    const backupRestoreIdentity = parseBackupRestoreCompletionIdentity(
      completionRow,
      safeResult
    );
    const completedRestoreAttempt = await finalizeSuccessfulRestoreAttempt(
      client,
      completionRow,
      migrationIdentity,
      backupRestoreIdentity
    );
    if (migrationIdentity) {
      await finalizeLinkedMigrationSuccess(
        client,
        migrationIdentity,
        completedRestoreAttempt?.target_host_id ?? null
      );
    }
    await applyGithubDeploymentBinding(client, id);
    await applyGithubCloneDeploymentBinding(client, id);
    return true;
  });
}

type SuccessfulJobCompletionRow = {
  id: string;
  type: string;
  host_id: string | null;
  payload: unknown;
};

type RestoreAttemptCompletionRow = {
  id: string;
  recovery_point_id: string | null;
  backup_id: string | null;
  target_host_id: string;
  operation_job_id: string | null;
  migration_run_id: string | null;
  restore_scope: string;
  retain_on_success: boolean;
  status: string;
};

type MigrationCompletionIdentity = {
  migrationRunId: string;
  recoveryPointId: string;
  sourceLeftStopped: boolean;
};

type BackupRestoreCompletionIdentity = {
  backupId: string;
  targetHostId: string;
  disposition: "retained" | "cleaned";
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseMigrationCompletionIdentity(
  row: SuccessfulJobCompletionRow,
  resultValue: Record<string, unknown>
): MigrationCompletionIdentity | null {
  if (row.type !== "migration.execute") return null;
  const payload = recordValue(row.payload);
  const migrationRunId = payload.migrationRunId;
  const recoveryPointId = resultValue.recoveryPointId;
  const resultMigrationRunId = resultValue.migrationRunId;
  const sourceLeftStopped = resultValue.sourceLeftStopped;
  const strategy = payload.strategy;
  if (
    typeof migrationRunId !== "string"
    || resultMigrationRunId !== migrationRunId
    || typeof recoveryPointId !== "string"
    || typeof sourceLeftStopped !== "boolean"
    || typeof strategy !== "string"
    || resultValue.strategy !== strategy
  ) {
    throw new Error(
      "Migration completion result does not match its linked operation"
    );
  }
  return {
    migrationRunId,
    recoveryPointId,
    sourceLeftStopped
  };
}

function parseBackupRestoreCompletionIdentity(
  row: SuccessfulJobCompletionRow,
  resultValue: Record<string, unknown>
): BackupRestoreCompletionIdentity | null {
  if (
    row.type !== "volume.restore"
    && row.type !== "hostPath.restore"
    && row.type !== "volume.clone"
    && row.type !== "backup.drill"
  ) {
    return null;
  }
  const payload = recordValue(row.payload);
  const payloadBackupId = payload.backupId;
  const backupId = row.type === "volume.clone"
    ? resultValue.backupId
    : payloadBackupId;
  const targetHostId = row.type === "volume.clone"
    ? payload.targetHostId
    : row.host_id;
  if (
    typeof backupId !== "string"
    || typeof targetHostId !== "string"
    || (
      typeof payloadBackupId === "string"
      && payloadBackupId !== backupId
    )
    || (
      row.type === "volume.clone"
      && resultValue.targetHostId !== targetHostId
    )
    || (
      row.type === "backup.drill"
      && resultValue.backupId !== backupId
    )
  ) {
    throw new Error(
      "Backup restore completion result does not match its linked operation"
    );
  }
  return {
    backupId,
    targetHostId,
    disposition: row.type === "backup.drill"
      ? "cleaned"
      : "retained"
  };
}

function assertExactlyOneRestoreAttempt(
  attempts: RestoreAttemptCompletionRow[],
  description: string
) {
  if (attempts.length !== 1) {
    throw new Error(
      `${description} requires exactly one authoritative restore attempt`
    );
  }
  return attempts[0]!;
}

async function retainExactRestoreAttempt(
  client: PoolClient,
  attempt: RestoreAttemptCompletionRow,
  input: {
    jobId: string;
    recoveryPointId: string;
    migrationRunId: string | null;
  }
) {
  const retained = await client.query(
    `UPDATE recovery_restore_attempts
     SET status = 'retained',
         cleanup_not_before = NULL,
         reconciliation_token = NULL,
         reconciliation_started_at = NULL,
         last_error = NULL,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1
       AND operation_job_id = $2
       AND recovery_point_id = $3
       AND backup_id IS NULL
       AND migration_run_id IS NOT DISTINCT FROM $4::uuid
       AND retain_on_success = true
       AND status = 'awaiting_disposition'
     RETURNING id`,
    [
      attempt.id,
      input.jobId,
      input.recoveryPointId,
      input.migrationRunId
    ]
  );
  if (retained.rowCount !== 1) {
    throw new Error(
      "Successful restore attempt could not be durably retained"
    );
  }
}

async function retainExactBackupRestoreAttempt(
  client: PoolClient,
  attempt: RestoreAttemptCompletionRow,
  input: {
    jobId: string;
    backupId: string;
    targetHostId: string;
  }
) {
  const retained = await client.query(
    `UPDATE recovery_restore_attempts
     SET status = 'retained',
         cleanup_not_before = NULL,
         reconciliation_token = NULL,
         reconciliation_started_at = NULL,
         last_error = NULL,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1
       AND operation_job_id = $2
       AND recovery_point_id IS NULL
       AND backup_id = $3
       AND target_host_id = $4
       AND migration_run_id IS NULL
       AND retain_on_success = true
       AND status = 'awaiting_disposition'
     RETURNING id`,
    [
      attempt.id,
      input.jobId,
      input.backupId,
      input.targetHostId
    ]
  );
  if (retained.rowCount !== 1) {
    throw new Error(
      "Successful backup restore attempt could not be durably retained"
    );
  }
}

async function finalizeSuccessfulRestoreAttempt(
  client: PoolClient,
  row: SuccessfulJobCompletionRow,
  migrationIdentity: MigrationCompletionIdentity | null,
  backupRestoreIdentity: BackupRestoreCompletionIdentity | null
) {
  const attemptsResult = await client.query<RestoreAttemptCompletionRow>(
    `SELECT
       id,
       recovery_point_id,
       backup_id,
       target_host_id,
       operation_job_id,
       migration_run_id,
       restore_scope,
       retain_on_success,
       status
     FROM recovery_restore_attempts
     WHERE operation_job_id = $1
     ORDER BY created_at ASC, id ASC
     FOR UPDATE`,
    [row.id]
  );
  if (
    row.type !== "recovery.restore"
    && row.type !== "migration.execute"
    && !backupRestoreIdentity
  ) {
    if (attemptsResult.rows.length !== 0) {
      throw new Error(
        "Operation job type does not support a bound restore attempt"
      );
    }
    return null;
  }

  if (backupRestoreIdentity) {
    const targetHost = await client.query<{ tags: string[] }>(
      `SELECT tags
       FROM docker_hosts
       WHERE id = $1`,
      [backupRestoreIdentity.targetHostId]
    );
    if (targetHost.rowCount !== 1) {
      throw new Error(
        "Backup restore completion target host is no longer authoritative"
      );
    }
    const targetTags = targetHost.rows[0]?.tags;
    const isDemoTarget = Array.isArray(targetTags)
      && targetTags.includes("demo");
    if (isDemoTarget) {
      if (attemptsResult.rows.length !== 0) {
        throw new Error(
          "Demo backup restore completion must not have a durable remote attempt"
        );
      }
      return null;
    }
    const attempt = assertExactlyOneRestoreAttempt(
      attemptsResult.rows,
      "Backup restore completion"
    );
    if (
      attempt.recovery_point_id !== null
      || attempt.backup_id !== backupRestoreIdentity.backupId
      || attempt.target_host_id !== backupRestoreIdentity.targetHostId
      || attempt.operation_job_id !== row.id
      || attempt.migration_run_id !== null
      || attempt.restore_scope !== `backup:${backupRestoreIdentity.backupId}`
    ) {
      throw new Error(
        "Backup restore attempt does not match its exact operation identity"
      );
    }
    if (backupRestoreIdentity.disposition === "cleaned") {
      if (
        attempt.retain_on_success
        || attempt.status !== "cleaned"
      ) {
        throw new Error(
          "Backup drill completion requires its exact restore attempt to be cleaned"
        );
      }
      return attempt;
    }
    if (
      !attempt.retain_on_success
      || attempt.status !== "awaiting_disposition"
    ) {
      throw new Error(
        "Backup restore completion requires its exact attempt to await retention"
      );
    }
    await retainExactBackupRestoreAttempt(
      client,
      attempt,
      {
        jobId: row.id,
        backupId: backupRestoreIdentity.backupId,
        targetHostId: backupRestoreIdentity.targetHostId
      }
    );
    return attempt;
  }

  const attempt = assertExactlyOneRestoreAttempt(
    attemptsResult.rows,
    row.type === "migration.execute"
      ? "Migration completion"
      : "Recovery restore completion"
  );

  if (row.type === "migration.execute") {
    if (
      !migrationIdentity
      || attempt.recovery_point_id !== migrationIdentity.recoveryPointId
      || attempt.backup_id !== null
      || attempt.operation_job_id !== row.id
      || attempt.migration_run_id !== migrationIdentity.migrationRunId
      || attempt.restore_scope !== migrationIdentity.recoveryPointId
      || !attempt.retain_on_success
      || attempt.status !== "awaiting_disposition"
    ) {
      throw new Error(
        "Migration completion restore attempt does not match its exact operation identity"
      );
    }
    await retainExactRestoreAttempt(client, attempt, {
      jobId: row.id,
      recoveryPointId: migrationIdentity.recoveryPointId,
      migrationRunId: migrationIdentity.migrationRunId
    });
    return attempt;
  }

  const payload = recordValue(row.payload);
  const recoveryPointId = payload.recoveryPointId;
  const drill = payload.drill === true;
  if (
    typeof recoveryPointId !== "string"
    || attempt.recovery_point_id !== recoveryPointId
    || attempt.backup_id !== null
    || attempt.target_host_id !== row.host_id
    || attempt.operation_job_id !== row.id
    || attempt.migration_run_id !== null
    || attempt.restore_scope !== recoveryPointId
  ) {
    throw new Error(
      "Recovery restore attempt does not match its exact operation identity"
    );
  }
  if (drill) {
    if (
      attempt.retain_on_success
      || attempt.status !== "cleaned"
    ) {
      throw new Error(
        "Recovery drill completion requires its exact restore attempt to be cleaned"
      );
    }
    return attempt;
  }
  if (
    !attempt.retain_on_success
    || attempt.status !== "awaiting_disposition"
  ) {
    throw new Error(
      "Recovery restore completion requires its exact attempt to await retention"
    );
  }
  await retainExactRestoreAttempt(client, attempt, {
    jobId: row.id,
    recoveryPointId,
    migrationRunId: null
  });
  return attempt;
}

async function finalizeLinkedMigrationSuccess(
  client: PoolClient,
  identity: MigrationCompletionIdentity,
  restoreTargetHostId: string | null
) {
  const migration = await client.query(
    `UPDATE migration_runs
     SET status = 'completed',
         error = NULL,
         completed_at = now()
     WHERE id = $1
       AND mode = 'execute'
       AND status = 'running'
       AND recovery_point_id = $2
     RETURNING id, target_host_id`,
    [identity.migrationRunId, identity.recoveryPointId]
  );
  if (migration.rowCount !== 1) {
    throw new Error("Migration completion did not update its active linked run");
  }
  if (
    typeof restoreTargetHostId !== "string"
    || migration.rows[0]?.target_host_id !== restoreTargetHostId
  ) {
    throw new Error(
      "Migration restore attempt target does not match its linked migration run"
    );
  }

  const pendingObligations = await client.query<{
    id: string;
    metadata: unknown;
  }>(
    `SELECT id, metadata
     FROM recovery_points
     WHERE migration_run_id = $1
       AND metadata->>'sourceRestartPending' = 'true'
     ORDER BY id
     FOR UPDATE`,
    [identity.migrationRunId]
  );
  if (!identity.sourceLeftStopped) {
    if (pendingObligations.rowCount !== 0) {
      throw new Error(
        "Migration reported no stopped source but has a pending restart obligation"
      );
    }
    return;
  }
  if (
    pendingObligations.rowCount !== 1
    || pendingObligations.rows[0]?.id !== identity.recoveryPointId
  ) {
    throw new Error(
      "Migration stopped-source disposition is not bound to its exact final recovery point"
    );
  }
  const obligationMetadata = recordValue(
    pendingObligations.rows[0]?.metadata
  );
  if (
    obligationMetadata.sourceRestartReconciliationState
      !== "blocked_target_cleanup"
    || obligationMetadata.sourceRestartTargetCleanupBlocked !== true
    || !Array.isArray(obligationMetadata.sourceRestartContainerIds)
    || obligationMetadata.sourceRestartContainerIds.length === 0
  ) {
    throw new Error(
      "Migration stopped-source obligation is not safely blocked on target cleanup"
    );
  }

  const resolvedAt = new Date().toISOString();
  const obligations = await client.query(
    `UPDATE recovery_points
     SET metadata = (
       metadata
       - 'sourceRestartReconciliationToken'
       - 'sourceRestartReconciliationStartedAt'
       - 'sourceRestartReconciliationError'
       - 'sourceRestartReconciliationFailedAt'
       - 'sourceRestartTargetCleanupBlocked'
       - 'sourceRestartTargetCleanupBlockedAt'
       - 'sourceRestartTargetCleanupError'
       - 'sourceRestartTargetCleanupCompletedAt'
       - 'sourceRestartRearmedAt'
     ) || jsonb_build_object(
       'sourceRestartPending', false,
       'sourceRestartContainerIds', '[]'::jsonb,
       'sourceLeftStopped', true,
       'sourceStoppedIds', COALESCE(metadata->'sourceRestartContainerIds', '[]'::jsonb),
       'stoppedContainerIds', COALESCE(metadata->'sourceRestartContainerIds', '[]'::jsonb),
       'restartFailedIds', '[]'::jsonb,
       'sourceRestartResolvedAt', $3::text,
       'sourceRestartResolution', 'intentionally_left_stopped',
       'sourceRestartReconciliationState', 'completed'
     )
     WHERE id = $1
       AND migration_run_id = $2
       AND metadata->>'sourceRestartPending' = 'true'
       AND metadata->>'sourceRestartReconciliationState'
         = 'blocked_target_cleanup'
       AND metadata->>'sourceRestartTargetCleanupBlocked' = 'true'
       AND jsonb_typeof(metadata->'sourceRestartContainerIds') = 'array'
       AND jsonb_array_length(metadata->'sourceRestartContainerIds') > 0
     RETURNING id`,
    [
      identity.recoveryPointId,
      identity.migrationRunId,
      resolvedAt
    ]
  );
  if (obligations.rowCount !== 1) {
    throw new Error(
      "Migration stopped-source disposition could not resolve its exact obligation"
    );
  }
}

export async function markSelfUpdateHandoffPending(id: string, handoff: SelfUpdateHandoff, lease: JobLease) {
  const progress = buildJobProgress(
    "system.self_update",
    "running",
    "reconnect",
    "Waiting for the restarted app and worker to report the authoritative update outcome"
  );
  const result = await query(
    `UPDATE operation_jobs
     SET result = $2::jsonb,
         progress = $3::jsonb,
         error = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1
       AND type = 'system.self_update'
       AND status = 'running'
       AND lease_owner = $4
       AND attempt_count = $5
       AND lease_expires_at > clock_timestamp()
     RETURNING id`,
    [id, JSON.stringify(handoff), JSON.stringify(progress), lease.workerId, lease.attemptCount]
  );
  return result.rowCount === 1;
}

async function finalizeLinkedOperationFailure(client: PoolClient, row: any, message: string) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  if ((row.type === "deploy.analyze" || row.type === "deploy.execute") && typeof payload.analysisId === "string") {
    await client.query(
      `UPDATE deployment_analyses
       SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1 AND status IN ('queued', 'analyzing', 'ready', 'deploying')`,
      [payload.analysisId, message]
    );
  }
  if ((row.type === "volume.backup" || row.type === "hostPath.backup" || row.type === "volume.clone") && typeof payload.backupId === "string") {
    await client.query(
      `UPDATE backups SET status = 'failed', error = $2, completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [payload.backupId, message]
    );
    await client.query(
      `UPDATE backup_schedules AS schedules
       SET last_status = 'failed', last_error = $2, updated_at = now()
       FROM backups
       WHERE backups.id = $1
         AND schedules.id::text = backups.metadata->>'scheduleId'`,
      [payload.backupId, message]
    );
  }

  if (row.type === "backup.drill" && typeof payload.backupId === "string") {
    await client.query(
      `UPDATE backups
       SET last_drill_at = now(), last_drill_status = 'failed'
       WHERE id = $1`,
      [payload.backupId]
    );
  }

  if ((row.type === "recovery.create" || row.type === "recovery.capture") && typeof payload.recoveryPointId === "string") {
    await client.query(
      `UPDATE recovery_points
       SET status = 'failed',
           error = CASE
             WHEN metadata->>'sourceLeftStopped' = 'true'
               AND NULLIF(error, '') IS NOT NULL
               THEN error || '; ' || $2
             ELSE $2
           END,
           completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [payload.recoveryPointId, message]
    );
    await client.query(
      `UPDATE recovery_artifacts
       SET status = 'failed', error = $2, completed_at = now()
       WHERE recovery_point_id = $1 AND status IN ('queued', 'running')`,
      [payload.recoveryPointId, message]
    );
  }

  if (row.type === "recovery.restore" && payload.drill === true && typeof payload.recoveryPointId === "string") {
    await client.query(
      `UPDATE recovery_points
       SET last_drill_at = now(), last_drill_status = 'failed', last_drill_error = $2
       WHERE id = $1`,
      [payload.recoveryPointId, message]
    );
    await client.query(
      `UPDATE recovery_schedules AS schedules
       SET last_drill_at = now(), last_drill_status = 'failed', last_drill_error = $2, updated_at = now()
       FROM recovery_points
       WHERE recovery_points.id = $1
         AND schedules.id::text = recovery_points.metadata->>'scheduleId'`,
      [payload.recoveryPointId, message]
    );
  }

  if (row.type === "migration.execute" && typeof payload.migrationRunId === "string") {
    // The migration executor records its own failure before the operation job is
    // finalized. Read the linked recovery point independently of that status
    // transition so child capture rows cannot remain running when the worker is
    // subsequently lost or the job failure is centralized here.
    const migration = await client.query<{ recovery_point_id: string | null }>(
      `SELECT recovery_point_id
       FROM migration_runs
       WHERE id = $1
       FOR UPDATE`,
      [payload.migrationRunId]
    );
    await client.query(
      `UPDATE migration_runs
       SET status = 'failed',
           error = CASE
             WHEN position(
               'Automatic migration compensation remains armed. Reconciliation evidence:'
               IN COALESCE(error, '')
             ) > 0
               THEN error || E'\\n' || $2
             ELSE $2
           END,
           completed_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [payload.migrationRunId, message]
    );
    const recoveryPointId = migration.rows[0]?.recovery_point_id ?? null;
    await client.query(
      `UPDATE recovery_points
       SET status = 'failed', error = $3, completed_at = now()
       WHERE (migration_run_id = $1 OR id = $2)
         AND status IN ('queued', 'running')`,
      [payload.migrationRunId, recoveryPointId, message]
    );
    await client.query(
      `UPDATE recovery_artifacts
       SET status = 'failed', error = $3, completed_at = now()
       WHERE recovery_point_id IN (
         SELECT id
         FROM recovery_points
         WHERE migration_run_id = $1 OR id = $2
       )
         AND status IN ('queued', 'running')`,
      [payload.migrationRunId, recoveryPointId, message]
    );
  }
}

function completedDeploymentProofNeedsReconciliation(row: any) {
  const proof = remoteMutationProofFromResult(row?.result);
  if (
    !proof
    || proof.jobId !== row?.id
    || proof.attemptCount !== Number(row?.attempt_count)
    || proof.status !== "terminal"
    || proof.terminalState !== "completed"
  ) {
    return false;
  }
  return (
    row.type === "compose.deploy"
    && proof.phase === "compose.deploy"
  ) || (
    (
      row.type === "compose.deployPath"
      || row.type === "compose.writeDeployPath"
      || row.type === "deploy.execute"
      || row.type === "git.cloneDeploy"
    )
    && proof.phase === "compose.deployPath.up"
  );
}

export async function failJob(id: string, error: unknown, lease: JobLease) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = String(sanitizeUrlDiagnosticText(rawMessage));
  return withTransaction(async (client) => {
    const values: unknown[] = [id, sanitizedMessage];
    const predicate = " AND status = 'running' AND lease_owner = $3 AND attempt_count = $4 AND lease_expires_at > clock_timestamp()";
    values.push(lease.workerId, lease.attemptCount);
    const result = await client.query(
      `UPDATE operation_jobs
       SET status = 'failed', error = $2, completed_at = now(),
           lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1${predicate}
       RETURNING *`,
      values
    );
    const row = result.rows[0];
    if (!row) return false;
    const message = (
      !githubDeploymentFailureNeedsReconciliation(sanitizedMessage)
      && completedDeploymentProofNeedsReconciliation(row)
    )
      ? `REMOTE_OUTCOME_UNKNOWN: The remote Compose deployment completed, but local finalization failed: ${sanitizedMessage}`
      : sanitizedMessage;
    if (message !== sanitizedMessage) {
      await client.query(
        `UPDATE operation_jobs
         SET error = $2, updated_at = now()
         WHERE id = $1 AND status = 'failed'`,
        [id, message]
      );
    }
    await finalizeLinkedOperationFailure(client, row, message);
    if (githubDeploymentFailureNeedsReconciliation(message)) {
      await retainGithubDeploymentBinding(client, id, message);
      await retainGithubCloneDeploymentBinding(client, id, message);
    } else {
      await failGithubDeploymentBinding(client, id, message);
      await failGithubCloneDeploymentBinding(client, id, message);
    }
    return true;
  });
}

export async function recoverExpiredJobs() {
  return withTransaction(async (client) => {
    const expired = await client.query(
      `SELECT *
       FROM operation_jobs
       WHERE status = 'running'
         AND NOT (
           type = 'system.self_update'
           AND result @> '{"handoffPending":true}'::jsonb
         )
         AND (
           lease_expires_at <= now()
           OR (
             lease_owner IS NULL
             AND lease_expires_at IS NULL
             AND COALESCE(started_at, updated_at, created_at) <= now() - interval '2 minutes'
           )
         )
       ORDER BY lease_expires_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 100`
    );
    let requeued = 0;
    let failed = 0;
    for (const row of expired.rows) {
      const message = `WORKER_LOST: Worker lease expired during attempt ${Number(row.attempt_count)}`;
      if (AUTO_RETRY_JOB_TYPES.has(row.type) && Number(row.attempt_count) < MAX_AUTO_ATTEMPTS) {
        await client.query(
          `UPDATE operation_jobs
           SET status = 'queued', started_at = NULL, lease_owner = NULL, lease_expires_at = NULL,
               error = $2, progress = '[]'::jsonb, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [row.id, message]
        );
        requeued += 1;
      } else {
        await client.query(
          `UPDATE operation_jobs
           SET status = 'failed', error = $2, completed_at = now(),
               lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
           WHERE id = $1 AND status = 'running'`,
          [row.id, message]
        );
        await finalizeLinkedOperationFailure(client, row, message);
        await retainGithubDeploymentBinding(client, row.id, message);
        await retainGithubCloneDeploymentBinding(client, row.id, message);
        failed += 1;
      }
    }
    return { requeued, failed };
  });
}
