import { randomUUID } from "node:crypto";
import path from "node:path";
import { sanitizeUrlDiagnosticText } from "@composebastion/shared";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";
import { runAgentDockerCommandResult } from "./agent.js";
import { shQuote, withDockerEnv } from "./commands.js";
import { isDemoHost } from "./demo.js";
import { getHostForWorker } from "./hosts.js";
import type { JobExecutionFence } from "./jobs.js";
import { runSshCommand } from "./ssh.js";
import {
  buildCleanupOwnedRemoteDirectoryCommand,
  isOwnedRemoteDirectorySafetyRefusal
} from "./remoteOwnedDirectory.js";

const RESTORE_ATTEMPT_LABEL = "com.composebastion.recovery.restore-attempt";
const RESTORE_SCOPE_LABEL = "com.composebastion.recovery.restore-scope";

export const RECOVERY_RESTORE_MAX_REMOTE_MUTATION_MS = 10 * 60_000;
export const RECOVERY_RESTORE_RECONCILIATION_MARGIN_MS = 60_000;
export const RECOVERY_RESTORE_QUIESCENCE_MS =
  RECOVERY_RESTORE_MAX_REMOTE_MUTATION_MS
  + RECOVERY_RESTORE_RECONCILIATION_MARGIN_MS;
const RECOVERY_RESTORE_CLEANUP_REMOTE_COMMAND_MS = 60_000;
const RECOVERY_RESTORE_CLEANUP_CLAIM_MS =
  RECOVERY_RESTORE_CLEANUP_REMOTE_COMMAND_MS
  + RECOVERY_RESTORE_RECONCILIATION_MARGIN_MS;

export type RecoveryRestoreResourceKind =
  | "volume"
  | "network"
  | "container"
  | "directory"
  | "compose_project"
  | "database";

export type RecoveryRestoreAttemptContext = {
  attemptToken: string;
  recoveryPointId?: string | null;
  backupId?: string | null;
  targetHostId: string;
  restoreScope: string;
  operationJobId?: string | null;
  migrationRunId?: string | null;
  allowedPathRoots?: readonly string[];
  retainOnSuccess?: boolean;
};

type AttemptRow = {
  id: string;
  recovery_point_id: string | null;
  backup_id: string | null;
  target_host_id: string;
  operation_job_id: string | null;
  migration_run_id: string | null;
  restore_scope: string;
  allowed_path_roots: unknown;
  retain_on_success: boolean;
  status: string;
  reconciliation_token: string | null;
};

type ResourceRow = {
  attempt_id: string;
  kind: RecoveryRestoreResourceKind;
  resource_name: string;
  status: string;
};

function boundedDiagnostic(value: unknown, limit = 2_048) {
  const sanitized = String(sanitizeUrlDiagnosticText(
    value instanceof Error ? value.message : String(value)
  ));
  return sanitized.length <= limit
    ? sanitized
    : `${sanitized.slice(0, Math.max(0, limit - 1))}…`;
}

async function fencedQuery(
  executionFence: JobExecutionFence | undefined,
  text: string,
  values: unknown[]
) {
  if (!executionFence) return query(text, values);
  return executionFence.withActiveLease((client) => client.query(text, values));
}

export async function beginRecoveryRestoreAttempt(
  context: RecoveryRestoreAttemptContext,
  executionFence?: JobExecutionFence
) {
  const owners = [context.recoveryPointId, context.backupId].filter(Boolean);
  if (owners.length !== 1) {
    throw new Error("A restore attempt must have exactly one recovery-point or backup owner");
  }
  const allowedPathRoots = [...new Set(
    (context.allowedPathRoots ?? [])
      .map((value) => String(value).trim())
      .filter(Boolean)
  )];
  await fencedQuery(
    executionFence,
    `INSERT INTO recovery_restore_attempts (
       id,
       recovery_point_id,
       backup_id,
       target_host_id,
       operation_job_id,
       migration_run_id,
       restore_scope,
       allowed_path_roots,
       retain_on_success,
       status,
       heartbeat_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'active', now())`,
    [
      context.attemptToken,
      context.recoveryPointId ?? null,
      context.backupId ?? null,
      context.targetHostId,
      context.operationJobId ?? null,
      context.migrationRunId ?? null,
      context.restoreScope,
      JSON.stringify(allowedPathRoots),
      context.retainOnSuccess ?? true
    ]
  );
}

export async function registerRecoveryRestoreResource(
  attemptToken: string,
  kind: RecoveryRestoreResourceKind,
  resourceName: string,
  executionFence?: JobExecutionFence
) {
  await fencedQuery(
    executionFence,
    `INSERT INTO recovery_restore_resources (
       attempt_id,
       kind,
       resource_name,
       status
     )
     VALUES ($1, $2, $3, 'intended')
     ON CONFLICT (attempt_id, kind, resource_name)
     DO UPDATE SET updated_at = now()
     RETURNING attempt_id`,
    [attemptToken, kind, resourceName]
  );
  await fencedQuery(
    executionFence,
    `UPDATE recovery_restore_attempts
     SET heartbeat_at = now(), updated_at = now()
     WHERE id = $1
       AND status IN ('active', 'awaiting_disposition')`,
    [attemptToken]
  );
}

export async function markRecoveryRestoreResourceObserved(
  attemptToken: string,
  kind: RecoveryRestoreResourceKind,
  resourceName: string,
  executionFence?: JobExecutionFence
) {
  await fencedQuery(
    executionFence,
    `UPDATE recovery_restore_resources
     SET status = 'observed', last_error = null, updated_at = now()
     WHERE attempt_id = $1
       AND kind = $2
       AND resource_name = $3
       AND status = 'intended'`,
    [attemptToken, kind, resourceName]
  );
  await fencedQuery(
    executionFence,
    `UPDATE recovery_restore_attempts
     SET heartbeat_at = now(), updated_at = now()
     WHERE id = $1
       AND status IN ('active', 'awaiting_disposition')`,
    [attemptToken]
  );
}

export async function markRecoveryRestoreAttemptAwaitingDisposition(
  attemptToken: string,
  executionFence?: JobExecutionFence
) {
  await fencedQuery(
    executionFence,
    `UPDATE recovery_restore_attempts
     SET status = 'awaiting_disposition',
         heartbeat_at = now(),
         cleanup_not_before = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE id = $1
       AND status = 'active'`,
    [attemptToken]
  );
}

export async function markRecoveryRestoreAttemptCleanupPending(
  attemptToken: string,
  error: unknown,
  options: { remoteOutcomeUnknown?: boolean } = {}
) {
  const cleanupNotBefore = options.remoteOutcomeUnknown
    ? new Date(Date.now() + RECOVERY_RESTORE_QUIESCENCE_MS)
    : new Date();
  await query(
    `UPDATE recovery_restore_attempts
     SET status = 'cleanup_pending',
         cleanup_not_before = $2,
         last_error = $3,
         updated_at = now()
     WHERE id = $1
       AND status NOT IN ('retained', 'cleaned')`,
    [attemptToken, cleanupNotBefore, boundedDiagnostic(error)]
  );
}

export async function markRecoveryRestoreAttemptRetained(
  attemptToken: string,
  executionFence?: JobExecutionFence
) {
  const result = await fencedQuery(
    executionFence,
    `UPDATE recovery_restore_attempts
     SET status = 'retained',
         cleanup_not_before = NULL,
         reconciliation_token = NULL,
         reconciliation_started_at = NULL,
         last_error = NULL,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1
       AND status IN ('active', 'awaiting_disposition')
     RETURNING id`,
    [attemptToken]
  );
  if (result.rowCount !== 1) {
    throw new Error("Recovery restore attempt could not be durably retained");
  }
}

export async function recoveryRestoreAttemptCleanupIsDeferred(attemptToken: string) {
  const result = await query<{ deferred: boolean }>(
    `SELECT cleanup_not_before IS NOT NULL
       AND cleanup_not_before > now() AS deferred
     FROM recovery_restore_attempts
     WHERE id = $1`,
    [attemptToken]
  );
  return result.rows[0]?.deferred === true;
}

export async function markRecoveryRestoreAttemptCleaned(
  attemptToken: string,
  executionFence?: JobExecutionFence
) {
  await fencedQuery(
    executionFence,
    `UPDATE recovery_restore_attempts
     SET status = 'cleaned',
         cleanup_not_before = NULL,
         reconciliation_token = NULL,
         reconciliation_started_at = NULL,
         last_error = NULL,
         completed_at = now(),
         updated_at = now()
     WHERE id = $1
       AND status <> 'retained'`,
    [attemptToken]
  );
}

function isAlreadyMissingOutput(value: string) {
  return /(?:no such (?:container|network|volume|file)|not found|does not exist)/i.test(value);
}

function restoreOwnershipValue(attempt: AttemptRow) {
  return `${attempt.id}|${attempt.restore_scope}`;
}

type RestoreDockerResourceKind =
  "container" | "network" | "volume";

function ownedDockerResourceLabelsField(
  kind: RestoreDockerResourceKind
) {
  return kind === "container"
    ? ".Config.Labels"
    : ".Labels";
}

function ownedDockerResourceInspectCommand(
  kind: RestoreDockerResourceKind,
  resourceReference: string
) {
  const identityField = kind === "volume" ? ".Name" : ".Id";
  const labelsField = ownedDockerResourceLabelsField(kind);
  const format =
    `{{${identityField}}}|{{ index ${labelsField} "${RESTORE_ATTEMPT_LABEL}" }}|{{ index ${labelsField} "${RESTORE_SCOPE_LABEL}" }}`;
  return `docker ${kind} inspect --format ${shQuote(format)} ${shQuote(resourceReference)}`;
}

function parseOwnedDockerResourceBoundary(value: string) {
  const separator = value.indexOf("|");
  if (separator <= 0) return null;
  return {
    id: value.slice(0, separator).trim(),
    ownership: value.slice(separator + 1).trim()
  };
}

async function runHostDockerCommand(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  command: string
) {
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    return runAgentDockerCommandResult(
      host.agent,
      command,
      RECOVERY_RESTORE_CLEANUP_REMOTE_COMMAND_MS
    );
  }
  return runSshCommand(
    host.ssh,
    withDockerEnv(command, host.public.dockerSocketPath),
    { timeoutMs: RECOVERY_RESTORE_CLEANUP_REMOTE_COMMAND_MS }
  );
}

class RestoreAttemptClaimLostError extends Error {
  constructor() {
    super("Recovery restore reconciliation lost its durable cleanup claim");
    this.name = "RestoreAttemptClaimLostError";
  }
}

class RestoreCleanupRemoteOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      "Recovery restore cleanup command outcome is unknown; retry is deferred until the command is quiescent",
      { cause }
    );
    this.name = "RestoreCleanupRemoteOutcomeUnknownError";
  }
}

async function renewRestoreAttemptClaim(attempt: AttemptRow) {
  const renewed = await query(
    `UPDATE recovery_restore_attempts
     SET reconciliation_started_at = now(),
         heartbeat_at = now(),
         updated_at = now()
     WHERE id = $1
       AND reconciliation_token = $2
       AND status = 'reconciling'
     RETURNING id`,
    [attempt.id, attempt.reconciliation_token]
  );
  if (renewed.rowCount !== 1) throw new RestoreAttemptClaimLostError();
}

async function runClaimedRemoteCommand<T>(
  attempt: AttemptRow,
  command: () => Promise<T>
) {
  await renewRestoreAttemptClaim(attempt);
  let result: T;
  try {
    result = await command();
  } catch (error) {
    throw new RestoreCleanupRemoteOutcomeUnknownError(error);
  }
  await renewRestoreAttemptClaim(attempt);
  return result;
}

async function cleanupDockerResource(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  attempt: AttemptRow,
  kind: RestoreDockerResourceKind,
  resourceName: string
) {
  const inspect = await runClaimedRemoteCommand(
    attempt,
    () => runHostDockerCommand(
      host,
      ownedDockerResourceInspectCommand(kind, resourceName)
    )
  );
  if (inspect.code !== 0) {
    if (isAlreadyMissingOutput(`${inspect.stderr}\n${inspect.stdout}`)) return "cleaned" as const;
    throw new Error(inspect.stderr || inspect.stdout || `Failed to inspect restore ${kind}`);
  }
  const captured = parseOwnedDockerResourceBoundary(
    inspect.stdout.trim()
  );
  if (
    !captured?.id
    || captured.ownership !== restoreOwnershipValue(attempt)
  ) {
    return "preserved_unrelated" as const;
  }
  const boundary = await runClaimedRemoteCommand(
    attempt,
    () => runHostDockerCommand(
      host,
      ownedDockerResourceInspectCommand(kind, captured.id)
    )
  );
  if (
    boundary.code !== 0
    && isAlreadyMissingOutput(
      `${boundary.stderr}\n${boundary.stdout}`
    )
  ) {
    return "cleaned" as const;
  }
  if (
    boundary.code !== 0
    || boundary.stdout.trim() !== inspect.stdout.trim()
  ) {
    return "preserved_unrelated" as const;
  }
  const removeAction = kind === "container"
    ? "docker rm --force"
    : kind === "network"
      ? "docker network rm"
      : "docker volume rm --force";
  const removed = await runClaimedRemoteCommand(
    attempt,
    () => runHostDockerCommand(
      host,
      `${removeAction} ${shQuote(captured.id)}`
    )
  );
  if (
    removed.code !== 0
    && !isAlreadyMissingOutput(`${removed.stderr}\n${removed.stdout}`)
  ) {
    throw new Error(removed.stderr || removed.stdout || `Failed to remove restore ${kind}`);
  }
  return "cleaned" as const;
}

function isSafeAbsoluteNonRootPath(value: string) {
  if (!value.startsWith("/") || value === "/") return false;
  if (value.split("/").some((part) => part === "..")) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value.replace(/\/+$/, "") && normalized !== "/";
}

function pathIsWithin(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);
}

function allowedPathRoots(attempt: AttemptRow) {
  if (!Array.isArray(attempt.allowed_path_roots)) return [];
  return [...new Set(
    attempt.allowed_path_roots
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().replace(/\/+$/, ""))
      .filter(isSafeAbsoluteNonRootPath)
  )];
}

function assertAttemptDirectoryIsSafe(attempt: AttemptRow, targetPath: string) {
  const raw = targetPath.trim().replace(/\/+$/, "");
  if (!isSafeAbsoluteNonRootPath(raw)) {
    throw new Error("Restore directory ledger contains an unsafe, non-absolute, traversing, or root target");
  }
  const roots = allowedPathRoots(attempt);
  if (!roots.length || !roots.some((root) => pathIsWithin(root, raw))) {
    throw new Error(
      "Restore directory ledger target is outside this attempt's durable allowed path roots"
    );
  }
  return raw;
}

async function cleanupOwnedDirectory(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  attempt: AttemptRow,
  targetPath: string
) {
  if (host.connectionMode !== "ssh") {
    throw new Error("Owned restore directory cleanup requires the original SSH host mode");
  }
  const normalizedTargetPath = assertAttemptDirectoryIsSafe(attempt, targetPath);
  const command = buildCleanupOwnedRemoteDirectoryCommand({
    targetPath: normalizedTargetPath,
    ownerValue: restoreOwnershipValue(attempt),
    attemptToken: attempt.id,
    label: `restore directory ${normalizedTargetPath}`
  });
  const result = await runClaimedRemoteCommand(
    attempt,
    () => runSshCommand(
      host.ssh,
      command,
      { timeoutMs: RECOVERY_RESTORE_CLEANUP_REMOTE_COMMAND_MS }
    )
  );
  if (isOwnedRemoteDirectorySafetyRefusal(result.code)) {
    return "preserved_unrelated" as const;
  }
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to clean restore directory");
  }
  return "cleaned" as const;
}

function outputNames(stdout: string) {
  return [...new Set(
    stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  )];
}

async function listComposeProjectResources(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  projectName: string,
  attempt: AttemptRow
) {
  const filter = shQuote(`label=com.docker.compose.project=${projectName}`);
  const definitions = [
    {
      kind: "container" as const,
      command: `docker ps --all --filter ${filter} --format '{{.Names}}'`
    },
    {
      kind: "network" as const,
      command: `docker network ls --filter ${filter} --format '{{.Name}}'`
    },
    {
      kind: "volume" as const,
      command: `docker volume ls --filter ${filter} --format '{{.Name}}'`
    }
  ];
  const resources: Array<{
    kind: "container" | "network" | "volume";
    name: string;
  }> = [];
  for (const definition of definitions) {
    const result = await runClaimedRemoteCommand(
      attempt,
      () => runHostDockerCommand(host, definition.command)
    );
    if (result.code !== 0) {
      throw new Error(
        result.stderr
        || result.stdout
        || `Failed to inspect restore Compose ${definition.kind} resources`
      );
    }
    resources.push(
      ...outputNames(result.stdout).map((name) => ({ kind: definition.kind, name }))
    );
  }
  return resources;
}

async function markResourceDisposition(
  attempt: AttemptRow,
  resource: ResourceRow,
  status: "cleaned" | "preserved_unrelated"
) {
  const updated = await query(
    `UPDATE recovery_restore_resources resource
     SET status = $4, last_error = NULL, updated_at = now()
     FROM recovery_restore_attempts attempt
     WHERE resource.attempt_id = $1
       AND resource.kind = $2
       AND resource.resource_name = $3
       AND attempt.id = resource.attempt_id
       AND attempt.reconciliation_token = $5
       AND attempt.status = 'reconciling'
     RETURNING resource.attempt_id`,
    [
      attempt.id,
      resource.kind,
      resource.resource_name,
      status,
      attempt.reconciliation_token
    ]
  );
  if (updated.rowCount !== 1) throw new RestoreAttemptClaimLostError();
}

async function cleanupAttemptResources(attempt: AttemptRow) {
  const host = await getHostForWorker(attempt.target_host_id);
  const resourcesResult = await query<ResourceRow>(
    `SELECT attempt_id, kind, resource_name, status
     FROM recovery_restore_resources
     WHERE attempt_id = $1
       AND status NOT IN ('cleaned', 'preserved_unrelated')
     ORDER BY created_at DESC`,
    [attempt.id]
  );
  if (isDemoHost(host.public)) {
    for (const resource of resourcesResult.rows) {
      await renewRestoreAttemptClaim(attempt);
      await markResourceDisposition(attempt, resource, "cleaned");
    }
    return;
  }

  const composeResources = new Map<string, ResourceRow>();
  for (const resource of resourcesResult.rows) {
    if (resource.kind !== "compose_project") continue;
    const discovered = await listComposeProjectResources(
      host,
      resource.resource_name,
      attempt
    );
    for (const item of discovered) {
      composeResources.set(`${item.kind}\u0000${item.name}`, {
        ...resource,
        kind: item.kind,
        resource_name: item.name
      });
    }
  }

  const explicitDocker = resourcesResult.rows
    .filter((resource): resource is ResourceRow & {
      kind: "container" | "network" | "volume";
    } => (
      resource.kind === "container"
      || resource.kind === "network"
      || resource.kind === "volume"
    ));
  const dockerResources = [
    ...composeResources.values(),
    ...explicitDocker
  ].sort((left, right) => {
    const order = { container: 0, network: 1, volume: 2 } as const;
    return order[left.kind as keyof typeof order] - order[right.kind as keyof typeof order];
  });
  const seenDocker = new Set<string>();
  for (const resource of dockerResources) {
    const key = `${resource.kind}\u0000${resource.resource_name}`;
    if (seenDocker.has(key)) continue;
    seenDocker.add(key);
    const disposition = await cleanupDockerResource(
      host,
      attempt,
      resource.kind as "container" | "network" | "volume",
      resource.resource_name
    );
    if (resource.attempt_id === attempt.id && resource.status !== "cleaned") {
      const stored = resourcesResult.rows.find((candidate) =>
        candidate.kind === resource.kind
        && candidate.resource_name === resource.resource_name
      );
      if (stored) await markResourceDisposition(attempt, stored, disposition);
    }
  }

  for (const resource of resourcesResult.rows.filter((item) => item.kind === "compose_project")) {
    await markResourceDisposition(attempt, resource, "cleaned");
  }

  const directories = resourcesResult.rows
    .filter((resource) => resource.kind === "directory")
    .sort((left, right) => right.resource_name.length - left.resource_name.length);
  for (const resource of directories) {
    const disposition = await cleanupOwnedDirectory(
      host,
      attempt,
      resource.resource_name
    );
    await markResourceDisposition(attempt, resource, disposition);
  }

  for (const resource of resourcesResult.rows.filter((item) => item.kind === "database")) {
    // Database restores are implemented through their attempt-owned container
    // and storage resources. This logical row is evidence that the database
    // instance was part of the durable plan; it is complete only after those
    // exact physical resources have been reconciled above.
    await renewRestoreAttemptClaim(attempt);
    await markResourceDisposition(attempt, resource, "cleaned");
  }
}

async function claimRestoreAttempts(limit: number) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE recovery_restore_attempts attempt
       SET status = 'retained',
           cleanup_not_before = NULL,
           last_error = NULL,
           completed_at = COALESCE(attempt.completed_at, now()),
           updated_at = now()
       FROM operation_jobs job
       WHERE attempt.operation_job_id = job.id
         AND job.status = 'completed'
         AND attempt.retain_on_success = true
         AND attempt.status IN ('active', 'awaiting_disposition')`
    );
    await client.query(
      `UPDATE recovery_restore_attempts attempt
       SET status = 'cleanup_pending',
           cleanup_not_before = now(),
           last_error = NULL,
           updated_at = now()
       FROM operation_jobs job
       WHERE attempt.operation_job_id = job.id
         AND job.status = 'completed'
         AND attempt.retain_on_success = false
         AND attempt.status IN ('active', 'awaiting_disposition')`
    );

    const selected = await client.query<AttemptRow>(
      `SELECT attempt.*
       FROM recovery_restore_attempts attempt
       LEFT JOIN operation_jobs bound_job
         ON bound_job.id = attempt.operation_job_id
       WHERE attempt.status IN (
           'active',
           'awaiting_disposition',
           'cleanup_pending',
           'reconciling'
         )
         AND (
           (
             attempt.cleanup_not_before IS NOT NULL
             AND attempt.cleanup_not_before <= now()
           )
           OR (
             attempt.cleanup_not_before IS NULL
             AND attempt.heartbeat_at
               <= now() - ($2::double precision * interval '1 millisecond')
           )
         )
         AND (
           attempt.status <> 'reconciling'
           OR attempt.reconciliation_started_at IS NULL
           OR attempt.reconciliation_started_at
             <= now() - ($3::double precision * interval '1 millisecond')
         )
         AND (
           bound_job.id IS NULL
           OR bound_job.status NOT IN ('queued', 'running')
         )
         AND NOT EXISTS (
           SELECT 1
           FROM operation_jobs active_job
           WHERE active_job.status IN ('queued', 'running')
             AND active_job.id IS DISTINCT FROM attempt.operation_job_id
             AND (
               (
                 active_job.type = 'recovery.restore'
                 AND active_job.host_id = attempt.target_host_id
                 AND attempt.recovery_point_id IS NOT NULL
                 AND active_job.payload->>'recoveryPointId'
                   = attempt.recovery_point_id::text
               )
               OR (
                 active_job.type = 'migration.execute'
                 AND EXISTS (
                   SELECT 1
                   FROM migration_runs active_migration
                   WHERE active_migration.id::text
                       = active_job.payload->>'migrationRunId'
                     AND active_migration.target_host_id
                       = attempt.target_host_id
                     AND attempt.recovery_point_id IS NOT NULL
                     AND active_migration.recovery_point_id
                       = attempt.recovery_point_id
                 )
               )
             )
         )
       ORDER BY attempt.created_at ASC
       FOR UPDATE OF attempt SKIP LOCKED
       LIMIT $1`,
      [
        limit,
        RECOVERY_RESTORE_QUIESCENCE_MS,
        RECOVERY_RESTORE_CLEANUP_CLAIM_MS
      ]
    );
    const claimed: AttemptRow[] = [];
    for (const attempt of selected.rows) {
      const token = randomUUID();
      const updated = await client.query<AttemptRow>(
        `UPDATE recovery_restore_attempts
         SET status = 'reconciling',
             reconciliation_token = $2,
             reconciliation_started_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [attempt.id, token]
      );
      if (updated.rows[0]) claimed.push(updated.rows[0]);
    }
    return claimed;
  });
}

async function releaseSourceRestartAfterCleanup(
  client: PoolClient,
  attempt: AttemptRow
) {
  if (!attempt.migration_run_id || !attempt.recovery_point_id) return;
  const now = new Date().toISOString();
  await client.query(
    `UPDATE recovery_points
     SET metadata = (
       metadata
       - 'sourceRestartReconciliationToken'
       - 'sourceRestartReconciliationStartedAt'
       - 'sourceRestartTargetCleanupBlockedAt'
     ) || $3::jsonb
     WHERE id = $1
       AND migration_run_id = $2
       AND metadata->>'sourceRestartPending' = 'true'
       AND metadata->>'sourceRestartReconciliationState'
         = 'blocked_target_cleanup'
       AND metadata->>'sourceRestartTargetCleanupBlocked' = 'true'`,
    [
      attempt.recovery_point_id,
      attempt.migration_run_id,
      JSON.stringify({
        sourceRestartReconciliationState: "pending",
        sourceRestartTargetCleanupBlocked: false,
        sourceRestartTargetCleanupError: null,
        sourceRestartTargetCleanupCompletedAt: now,
        sourceRestartRearmedAt: now
      })
    ]
  );
}

async function completeClaimedAttempt(attempt: AttemptRow) {
  await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE recovery_restore_attempts
       SET status = 'cleaned',
           cleanup_not_before = NULL,
           reconciliation_token = NULL,
           reconciliation_started_at = NULL,
           last_error = NULL,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1
         AND reconciliation_token = $2
         AND status = 'reconciling'
       RETURNING id`,
      [attempt.id, attempt.reconciliation_token]
    );
    if (updated.rowCount !== 1) {
      throw new Error("Recovery restore reconciliation lost its durable claim");
    }
    await releaseSourceRestartAfterCleanup(client, attempt);
  });
}

async function failClaimedAttempt(attempt: AttemptRow, error: unknown) {
  const retryDelayMs = error instanceof RestoreCleanupRemoteOutcomeUnknownError
    ? RECOVERY_RESTORE_QUIESCENCE_MS
    : RECOVERY_RESTORE_RECONCILIATION_MARGIN_MS;
  await query(
    `UPDATE recovery_restore_attempts
     SET status = 'cleanup_pending',
         cleanup_not_before = now() + ($3::double precision * interval '1 millisecond'),
         reconciliation_token = NULL,
         reconciliation_started_at = NULL,
         last_error = $4,
         updated_at = now()
     WHERE id = $1
       AND reconciliation_token = $2
       AND status = 'reconciling'`,
    [
      attempt.id,
      attempt.reconciliation_token,
      retryDelayMs,
      boundedDiagnostic(error)
    ]
  );
}

export async function reconcileRecoveryRestoreAttempts(limit = 10) {
  const attempts = await claimRestoreAttempts(limit);
  let cleaned = 0;
  let failed = 0;
  for (const attempt of attempts) {
    try {
      await cleanupAttemptResources(attempt);
      await completeClaimedAttempt(attempt);
      cleaned += 1;
    } catch (error) {
      await failClaimedAttempt(attempt, error);
      failed += 1;
    }
  }
  return { checked: attempts.length, cleaned, failed };
}
