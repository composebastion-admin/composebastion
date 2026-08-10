import type { PoolClient } from "pg";
import {
  stackVersionSourceSchema,
  type StackVersionSource
} from "@composebastion/shared";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { deploymentEnvironmentBinding } from "./deploymentEnvironment.js";
import type { JobExecutionFence } from "./jobs.js";

export const COMPOSE_STACK_DEPLOYMENT_INTENT_KEY =
  "composeStackDeploymentIntent";

const INTENT_VERSION = 1 as const;
const MAX_COMPOSE_BYTES = 512 * 1024;
const MAX_ENVIRONMENT_BYTES = 512 * 1024;
const MAX_ENCRYPTED_INTENT_BYTES = 4 * 1024 * 1024;

const uuidSchema = z.string().uuid();
const nullableUuidSchema = uuidSchema.nullable().optional().default(null);
const nullableBoundedString = (maximum: number) =>
  z.string().max(maximum).nullable().optional().default(null);

const sourceInputSchema = z.object({
  type: z.string().trim().min(1).max(64),
  repositoryUrl: nullableBoundedString(2_048),
  branch: nullableBoundedString(512),
  workingDir: nullableBoundedString(1_024),
  composePath: nullableBoundedString(1_024),
  currentCommitSha: nullableBoundedString(128),
  latestCommitSha: nullableBoundedString(128),
  environment: z.string()
    .max(MAX_ENVIRONMENT_BYTES)
    .nullable()
    .optional()
    .default(null),
  deploymentSourceId: nullableUuidSchema
}).strict();

const sourceIntentSchema = sourceInputSchema.extend({
  environmentBinding: z.string().regex(/^[0-9a-f]{64}$/).nullable()
}).strict();

const versionInputSchema = z.object({
  source: stackVersionSourceSchema,
  note: nullableBoundedString(500),
  createdBy: nullableUuidSchema
}).strict();

const composeStackDeploymentIntentInputSchema = z.object({
  jobId: uuidSchema,
  attemptCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostId: uuidSchema,
  projectName: z.string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().trim().min(1).max(80),
  composeYaml: z.string().min(1).max(MAX_COMPOSE_BYTES),
  env: z.string().max(MAX_ENVIRONMENT_BYTES),
  source: sourceInputSchema,
  version: versionInputSchema,
  githubCloneOperationJobId: nullableUuidSchema
}).strict();

const composeStackDeploymentIntentSchema =
  composeStackDeploymentIntentInputSchema.extend({
    intentVersion: z.literal(INTENT_VERSION),
    candidateStackId: uuidSchema,
    candidateVersionId: uuidSchema,
    source: sourceIntentSchema
  }).strict();

const composeStackDeploymentIntentIdentitySchema = z.object({
  jobId: uuidSchema,
  attemptCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  hostId: uuidSchema
}).strict();

export type ComposeStackDeploymentIntentInput = z.input<
  typeof composeStackDeploymentIntentInputSchema
>;

export type ComposeStackDeploymentIntent = z.output<
  typeof composeStackDeploymentIntentSchema
>;

export type ComposeStackDeploymentIntentIdentity = z.input<
  typeof composeStackDeploymentIntentIdentitySchema
>;

export type FinalizedComposeStackDeploymentIntent = {
  stackId: string;
  versionId: string;
  versionNumber: number;
  replayed: boolean;
  githubCloneOperationJobId: string | null;
};

function invalidIntent(): Error {
  return new Error("Compose stack deployment intent is invalid.");
}

export function deriveComposeStackDeploymentIntentIds(
  jobId: string,
  attemptCount: number
) {
  const identity = composeStackDeploymentIntentIdentitySchema.safeParse({
    jobId,
    attemptCount,
    hostId: jobId
  });
  if (!identity.success) throw invalidIntent();
  return {
    candidateStackId: uuidv5(
      `compose-stack:${identity.data.attemptCount}`,
      identity.data.jobId
    ),
    candidateVersionId: uuidv5(
      `compose-stack-version:${identity.data.attemptCount}`,
      identity.data.jobId
    )
  };
}

function validateIntent(value: unknown): ComposeStackDeploymentIntent {
  const parsed = composeStackDeploymentIntentSchema.safeParse(value);
  if (!parsed.success) throw invalidIntent();
  const intent = parsed.data;
  const expectedIds = deriveComposeStackDeploymentIntentIds(
    intent.jobId,
    intent.attemptCount
  );
  const expectedEnvironmentBinding = intent.source.environment === null
    ? null
    : deploymentEnvironmentBinding(intent.source.environment);
  if (
    intent.candidateStackId !== expectedIds.candidateStackId
    || intent.candidateVersionId !== expectedIds.candidateVersionId
    || intent.source.environmentBinding !== expectedEnvironmentBinding
  ) {
    throw invalidIntent();
  }
  return intent;
}

function encryptedIntentFromResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw invalidIntent();
  }
  const encrypted = (
    result as Record<string, unknown>
  )[COMPOSE_STACK_DEPLOYMENT_INTENT_KEY];
  if (
    typeof encrypted !== "string"
    || encrypted.length === 0
    || encrypted.length > MAX_ENCRYPTED_INTENT_BYTES
  ) {
    throw invalidIntent();
  }
  return encrypted;
}

/**
 * Decrypt a durable intent only when its authenticated payload is bound to the
 * exact job, attempt, and host expected by the caller.
 */
export function parseComposeStackDeploymentIntent(
  result: unknown,
  expectedIdentity: ComposeStackDeploymentIntentIdentity
): ComposeStackDeploymentIntent {
  const expected = composeStackDeploymentIntentIdentitySchema.safeParse(
    expectedIdentity
  );
  if (!expected.success) throw invalidIntent();

  try {
    const encrypted = encryptedIntentFromResult(result);
    const intent = validateIntent(JSON.parse(decryptSecret(encrypted)));
    if (
      intent.jobId !== expected.data.jobId
      || intent.attemptCount !== expected.data.attemptCount
      || intent.hostId !== expected.data.hostId
    ) {
      throw invalidIntent();
    }
    return intent;
  } catch {
    throw invalidIntent();
  }
}

/**
 * Build an authenticated, deterministic deployment intent and, when a fence is
 * supplied, persist only its ciphertext under the active job attempt before a
 * remote mutation may be launched. Unfenced callers receive the validated
 * intent without touching the database.
 */
export async function createAndPersistComposeStackDeploymentIntent(
  input: ComposeStackDeploymentIntentInput,
  executionFence?: JobExecutionFence
): Promise<ComposeStackDeploymentIntent> {
  const parsed = composeStackDeploymentIntentInputSchema.safeParse(input);
  if (!parsed.success) throw invalidIntent();
  const ids = deriveComposeStackDeploymentIntentIds(
    parsed.data.jobId,
    parsed.data.attemptCount
  );
  const intent = validateIntent({
    ...parsed.data,
    ...ids,
    intentVersion: INTENT_VERSION,
    source: {
      ...parsed.data.source,
      environmentBinding: parsed.data.source.environment === null
        ? null
        : deploymentEnvironmentBinding(parsed.data.source.environment)
    }
  });

  if (!executionFence) return intent;
  if (
    executionFence.jobId !== intent.jobId
    || executionFence.attemptCount !== intent.attemptCount
  ) {
    throw invalidIntent();
  }

  const encrypted = encryptSecret(JSON.stringify(intent));
  await executionFence.withActiveLease(async (client) => {
    const persisted = await client.query(
      `UPDATE operation_jobs
       SET result = COALESCE(result, '{}'::jsonb)
                    || jsonb_build_object($4::text, $5::text),
           updated_at = now()
       WHERE id = $1
         AND attempt_count = $2
         AND host_id = $3
         AND status = 'running'
         AND (result IS NULL OR jsonb_typeof(result) = 'object')
       RETURNING id`,
      [
        intent.jobId,
        intent.attemptCount,
        intent.hostId,
        COMPOSE_STACK_DEPLOYMENT_INTENT_KEY,
        encrypted
      ]
    );
    if (persisted.rowCount !== 1) {
      throw invalidIntent();
    }
  });
  return intent;
}

type ExistingStackEnvironment = {
  id: string;
  source_environment_encrypted: string | null;
  source_environment_binding: string | null;
};

type PersistedStack = {
  id: string;
};

type PersistedVersion = {
  id: string;
  stack_id: string;
  version_number: number | string;
  compose_yaml: string;
  env: string | null;
  source: string;
  note: string | null;
  created_by: string | null;
};

function sourceEnvironmentCiphertext(
  intent: ComposeStackDeploymentIntent,
  existing: ExistingStackEnvironment | undefined
) {
  const environment = intent.source.environment;
  if (environment === null) return null;
  if (
    existing?.source_environment_encrypted
    && existing.source_environment_binding
      === intent.source.environmentBinding
  ) {
    try {
      if (
        decryptSecret(existing.source_environment_encrypted) !== environment
      ) {
        throw invalidIntent();
      }
      return existing.source_environment_encrypted;
    } catch {
      throw invalidIntent();
    }
  }
  return encryptSecret(environment);
}

function validateExistingVersion(
  row: PersistedVersion,
  stackId: string,
  intent: ComposeStackDeploymentIntent
) {
  const versionNumber = Number(row.version_number);
  if (
    row.id !== intent.candidateVersionId
    || row.stack_id !== stackId
    || !Number.isSafeInteger(versionNumber)
    || versionNumber <= 0
    || row.compose_yaml !== intent.composeYaml
    || (row.env ?? "") !== intent.env
    || row.source !== intent.version.source
    || (row.note ?? null) !== intent.version.note
    || (row.created_by ?? null) !== intent.version.createdBy
  ) {
    throw new Error(
      "REMOTE_OUTCOME_UNKNOWN: The deterministic Compose stack version does not match its deployment intent."
    );
  }
  return versionNumber;
}

/**
 * Materialize a validated intent using the caller's transaction. The
 * deterministic version identifier makes replay safe; an existing identifier
 * must match every persisted version field or finalization fails closed.
 */
export async function finalizeComposeStackDeploymentIntent(
  client: PoolClient,
  value: ComposeStackDeploymentIntent
): Promise<FinalizedComposeStackDeploymentIntent> {
  const intent = validateIntent(value);
  const existingStack = await client.query<ExistingStackEnvironment>(
    `SELECT id, source_environment_encrypted, source_environment_binding
     FROM compose_stacks
     WHERE host_id = $1 AND project_name = $2
     FOR UPDATE`,
    [intent.hostId, intent.projectName]
  );
  const existing = existingStack.rows[0];
  const expectedStackId = existing?.id ?? intent.candidateStackId;
  const encryptedSourceEnvironment = sourceEnvironmentCiphertext(
    intent,
    existing
  );

  const stackResult = await client.query<PersistedStack>(
    `INSERT INTO compose_stacks (
       id, host_id, name, project_name, compose_yaml, env,
       source_environment_encrypted, source_environment_binding, status,
       source_type, source_repository_url, source_branch, source_working_dir,
       source_compose_path, source_current_commit_sha,
       source_latest_commit_sha, source_checked_at, source_check_error,
       deployment_source_id, last_deploy_error
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'deployed',
       $9, $10, $11, $12, $13, $14, $15,
       CASE
         WHEN $14::text IS NULL AND $15::text IS NULL THEN NULL
         ELSE now()
       END,
       NULL, $16, NULL
     )
     ON CONFLICT (host_id, project_name)
     DO UPDATE SET
       name = EXCLUDED.name,
       compose_yaml = EXCLUDED.compose_yaml,
       env = EXCLUDED.env,
       source_environment_encrypted =
         EXCLUDED.source_environment_encrypted,
       source_environment_binding =
         EXCLUDED.source_environment_binding,
       status = 'deployed',
       source_type = EXCLUDED.source_type,
       source_repository_url = EXCLUDED.source_repository_url,
       source_branch = EXCLUDED.source_branch,
       source_working_dir = EXCLUDED.source_working_dir,
       source_compose_path = EXCLUDED.source_compose_path,
       source_current_commit_sha = EXCLUDED.source_current_commit_sha,
       source_latest_commit_sha = EXCLUDED.source_latest_commit_sha,
       source_checked_at = EXCLUDED.source_checked_at,
       source_check_error = NULL,
       deployment_source_id = COALESCE(
         EXCLUDED.deployment_source_id,
         compose_stacks.deployment_source_id
       ),
       last_deploy_error = NULL,
       updated_at = now()
     RETURNING id`,
    [
      intent.candidateStackId,
      intent.hostId,
      intent.name,
      intent.projectName,
      intent.composeYaml,
      intent.env,
      encryptedSourceEnvironment,
      intent.source.environmentBinding,
      intent.source.type,
      intent.source.repositoryUrl,
      intent.source.branch,
      intent.source.workingDir,
      intent.source.composePath,
      intent.source.currentCommitSha,
      intent.source.latestCommitSha,
      intent.source.deploymentSourceId
    ]
  );
  const stackId = stackResult.rows[0]?.id;
  if (stackResult.rowCount !== 1 || stackId !== expectedStackId) {
    throw new Error(
      "REMOTE_OUTCOME_UNKNOWN: The Compose stack identity changed while its deployment intent was finalized."
    );
  }

  const existingVersion = await client.query<PersistedVersion>(
    `SELECT id, stack_id, version_number, compose_yaml, env, source, note,
            created_by
     FROM compose_stack_versions
     WHERE id = $1
     FOR UPDATE`,
    [intent.candidateVersionId]
  );

  let versionNumber: number;
  let replayed = false;
  const version = existingVersion.rows[0];
  if (version) {
    replayed = true;
    versionNumber = validateExistingVersion(version, stackId, intent);
  } else {
    const nextVersion = await client.query<{ version_number: number | string }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
       FROM compose_stack_versions
       WHERE stack_id = $1`,
      [stackId]
    );
    versionNumber = Number(nextVersion.rows[0]?.version_number ?? 1);
    if (!Number.isSafeInteger(versionNumber) || versionNumber <= 0) {
      throw new Error("Could not allocate a Compose stack version.");
    }
    const inserted = await client.query<PersistedVersion>(
      `INSERT INTO compose_stack_versions (
         id, stack_id, version_number, compose_yaml, env, source, note,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, stack_id, version_number, compose_yaml, env, source,
                 note, created_by`,
      [
        intent.candidateVersionId,
        stackId,
        versionNumber,
        intent.composeYaml,
        intent.env,
        intent.version.source,
        intent.version.note,
        intent.version.createdBy
      ]
    );
    if (inserted.rowCount !== 1 || !inserted.rows[0]) {
      throw new Error("Could not persist the Compose stack version.");
    }
    validateExistingVersion(inserted.rows[0], stackId, intent);
  }

  const current = await client.query(
    `UPDATE compose_stacks
     SET current_version_id = $2,
         status = 'deployed',
         updated_at = now()
     WHERE id = $1
     RETURNING id`,
    [stackId, intent.candidateVersionId]
  );
  if (current.rowCount !== 1) {
    throw new Error("Could not publish the Compose stack version.");
  }

  return {
    stackId,
    versionId: intent.candidateVersionId,
    versionNumber,
    replayed,
    githubCloneOperationJobId: intent.githubCloneOperationJobId
  };
}

/**
 * Remove the encrypted intent without disturbing other result evidence. The
 * caller can invoke this after finalization in the same transaction.
 */
export async function discardComposeStackDeploymentIntent(
  client: PoolClient,
  identity: ComposeStackDeploymentIntentIdentity
) {
  const expected = composeStackDeploymentIntentIdentitySchema.safeParse(
    identity
  );
  if (!expected.success) throw invalidIntent();
  const discarded = await client.query(
    `UPDATE operation_jobs
     SET result = CASE
           WHEN result IS NULL THEN NULL
           ELSE result - $4::text
         END,
         updated_at = now()
     WHERE id = $1
       AND attempt_count = $2
       AND host_id = $3
       AND (result IS NULL OR jsonb_typeof(result) = 'object')
     RETURNING id`,
    [
      expected.data.jobId,
      expected.data.attemptCount,
      expected.data.hostId,
      COMPOSE_STACK_DEPLOYMENT_INTENT_KEY
    ]
  );
  if (discarded.rowCount !== 1) throw invalidIntent();
}

export type { StackVersionSource };
