import { v4 as uuid } from "uuid";
import {
  canonicalizeDockerRegistryAuthority,
  normalizeSavedRegistryOrigin,
  registryCreateSchema
} from "@composebastion/shared";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";
import { writeAuditEvent } from "./audit.js";
import { inspectImagesFromCompose } from "./composeImages.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { deploymentEnvironmentBinding } from "./deploymentEnvironment.js";
import {
  enqueueJobInTransaction,
  notifyJobQueued
} from "./jobs.js";
import { parseImageReference } from "./registryManifest.js";
import { hasReconciledRemoteOutcome } from "./remoteOutcomeReconciliation.js";

export function mapRegistry(row: any) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username,
    insecure: row.insecure,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function listRegistries() {
  const result = await query("SELECT * FROM registries ORDER BY name ASC");
  return result.rows.map(mapRegistry);
}

type RegistryAuditContext = {
  userId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function createRegistry(
  input: unknown,
  audit: RegistryAuditContext = {}
) {
  const body = registryCreateSchema.parse(input);
  return withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO registries (id, name, url, username, password_encrypted, insecure)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [uuid(), body.name, body.url, body.username ?? null, body.password ? encryptSecret(body.password) : null, body.insecure]
    );
    const registry = mapRegistry(result.rows[0]);
    await writeAuditEvent({
      ...audit,
      action: "registry.create",
      targetKind: "registry",
      targetId: registry.id,
      details: { authority: registryAuthority(result.rows[0]) }
    }, client);
    return registry;
  });
}

function registryAuthority(row: { url: string; insecure?: boolean }) {
  const origin = normalizeSavedRegistryOrigin(String(row.url), {
    defaultProtocol: row.insecure ? "http" : "https"
  });
  return canonicalizeDockerRegistryAuthority(new URL(origin).host);
}

function composeUsesRegistry(
  composeYaml: unknown,
  authorities: Set<string>,
  environment?: string | null
) {
  if (typeof composeYaml !== "string" || !composeYaml.trim()) return false;
  // A null environment means the durable ciphertext/binding could not be
  // authenticated. Fail closed while the associated job can still execute.
  if (environment === null) return true;
  try {
    const inspection = inspectImagesFromCompose(composeYaml, environment);
    return inspection.unresolved || inspection.images.some((reference) =>
      authorities.has(
        canonicalizeDockerRegistryAuthority(parseImageReference(reference).registry)
      )
    );
  } catch {
    // A deployment cannot execute malformed Compose YAML. Do not turn an
    // unrelated malformed/failed analysis into a global registry lock.
    return false;
  }
}

function boundStackEnvironment(row: any): string | undefined | null {
  if (row.stack_source_type !== "git") {
    return typeof row.stack_env === "string" ? row.stack_env : undefined;
  }
  try {
    const environment = row.stack_source_environment_encrypted
      ? decryptSecret(String(row.stack_source_environment_encrypted))
      : "";
    const binding = String(row.stack_source_environment_binding ?? "").toLowerCase();
    if (
      !/^[0-9a-f]{64}$/.test(binding)
      || deploymentEnvironmentBinding(environment) !== binding
    ) {
      return null;
    }
    return environment;
  } catch {
    return null;
  }
}

function boundAnalysisEnvironment(row: any): string | undefined | null {
  if (!row.analysis_env_encrypted) return undefined;
  try {
    const environment = decryptSecret(String(row.analysis_env_encrypted));
    const binding = String(row.analysis_environment_sha256 ?? "").toLowerCase();
    if (
      !/^[0-9a-f]{64}$/.test(binding)
      || deploymentEnvironmentBinding(environment) !== binding
    ) {
      return null;
    }
    return environment;
  } catch {
    return null;
  }
}

function unresolvedRemoteOutcome(row: any) {
  return row.status === "failed"
    && (
      String(row.error ?? "").startsWith("WORKER_LOST")
      || String(row.error ?? "").startsWith("REMOTE_OUTCOME_UNKNOWN:")
    )
    && !hasReconciledRemoteOutcome(row.result);
}

function unresolvedDeploymentOutcome(row: any) {
  return row.status === "failed"
    && (
      String(row.error ?? "").startsWith("WORKER_LOST")
      || String(row.error ?? "").startsWith("REMOTE_OUTCOME_UNKNOWN:")
      || String(row.analysis_error ?? "").startsWith("WORKER_LOST:")
      || String(row.analysis_error ?? "").startsWith("REMOTE_OUTCOME_UNKNOWN:")
    )
    && !hasReconciledRemoteOutcome(row.result);
}

function imageUsesRegistry(image: unknown, authorities: Set<string>) {
  if (typeof image !== "string" || !image.trim()) return false;
  try {
    return authorities.has(
      canonicalizeDockerRegistryAuthority(parseImageReference(image).registry)
    );
  } catch {
    return false;
  }
}

function queuedJobMayUseRegistry(row: any, authorities: Set<string>) {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  switch (row.type) {
    case "image.pull":
    case "container.run":
      return imageUsesRegistry(payload.image, authorities);
    case "container.update":
      // Without an explicit target image the worker resolves the current
      // container image after dequeue, so no registry can be proven unrelated.
      return payload.targetImage
        ? imageUsesRegistry(payload.targetImage, authorities)
        : true;
    case "container.clone":
    case "compose.deployPath":
      // Both resolve the source image/Compose file on the host at execution.
      return true;
    case "compose.writeDeployPath":
      return composeUsesRegistry(
        payload.composeYaml,
        authorities,
        typeof payload.env === "string" ? payload.env : undefined
      );
    case "compose.deploy":
      return composeUsesRegistry(
        row.stack_compose_yaml,
        authorities,
        boundStackEnvironment(row)
      );
    default:
      return false;
  }
}

export async function lockRegistryForMutation(
  client: PoolClient,
  id: string,
  options: { additionalAuthorities?: string[] } = {}
) {
  const selected = await client.query<any>(
    "SELECT * FROM registries WHERE id = $1 FOR UPDATE",
    [id]
  );
  const registry = selected.rows[0];
  if (!registry) return null;

  const directJobs = await client.query(
    `SELECT id, status, error, result
     FROM operation_jobs
     WHERE type = 'registry.login'
       AND payload->>'registryId' = $1
     ORDER BY created_at ASC
     FOR UPDATE`,
    [id]
  );
  const activeLogin = directJobs.rows.find((row) =>
    row.status === "queued" || row.status === "running"
  );
  if (activeLogin) {
    throw Object.assign(
      new Error("This registry credential cannot be changed while a registry login is queued or running."),
      { statusCode: 409, activeJobId: activeLogin.id }
    );
  }
  const unresolvedLogin = directJobs.rows.find(unresolvedRemoteOutcome);
  if (unresolvedLogin) {
    throw Object.assign(
      new Error("This registry credential cannot be changed until its prior registry login outcome is reconciled."),
      { statusCode: 409, activeJobId: unresolvedLogin.id }
    );
  }

  const authorities = new Set([
    registryAuthority(registry),
    ...(options.additionalAuthorities ?? []).map((authority) =>
      canonicalizeDockerRegistryAuthority(authority)
    )
  ]);
  const queuedConsumers = await client.query(
    `SELECT jobs.id, jobs.type, jobs.status, jobs.error, jobs.result,
            jobs.payload, stacks.compose_yaml AS stack_compose_yaml,
            stacks.env AS stack_env,
            stacks.source_type AS stack_source_type,
            stacks.source_environment_encrypted AS stack_source_environment_encrypted,
            stacks.source_environment_binding AS stack_source_environment_binding
     FROM operation_jobs AS jobs
     LEFT JOIN compose_stacks AS stacks
       ON stacks.id::text = jobs.payload->>'stackId'
     WHERE jobs.type = ANY($1::text[])
       AND (
         jobs.status IN ('queued', 'running')
         OR (
           jobs.status = 'failed'
           AND (
             jobs.error LIKE 'WORKER_LOST%'
             OR jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
         )
       )
     ORDER BY jobs.created_at ASC
     FOR UPDATE OF jobs`,
    [[
      "image.pull",
      "container.run",
      "container.clone",
      "container.update",
      "compose.deploy",
      "compose.deployPath",
      "compose.writeDeployPath"
    ]]
  );
  const queuedConsumer = queuedConsumers.rows.find((row) =>
    queuedJobMayUseRegistry(row, authorities)
    && (
      row.status === "queued"
      || row.status === "running"
      || unresolvedRemoteOutcome(row)
    )
  );
  if (queuedConsumer) {
    throw Object.assign(
      new Error(
        queuedConsumer.status === "failed"
          ? "This registry credential cannot be changed until the prior image or Compose operation using it is reconciled."
          : "This registry credential cannot be changed while an image or Compose operation may resolve it in the worker."
      ),
      { statusCode: 409, activeJobId: queuedConsumer.id }
    );
  }
  const deploymentJobs = await client.query(
    `SELECT jobs.id, jobs.status, jobs.error, jobs.result,
            analyses.error AS analysis_error, analyses.compose_yaml,
            analyses.env_encrypted AS analysis_env_encrypted,
            analyses.environment_sha256 AS analysis_environment_sha256
     FROM operation_jobs AS jobs
     JOIN deployment_analyses AS analyses
       ON analyses.id::text = jobs.payload->>'analysisId'
     WHERE jobs.type = 'deploy.execute'
       AND jobs.status IN ('queued', 'running', 'failed', 'canceled')
     ORDER BY jobs.created_at ASC
     FOR UPDATE OF jobs`,
    []
  );
  const deployment = deploymentJobs.rows.find((row) =>
    composeUsesRegistry(
      row.compose_yaml,
      authorities,
      boundAnalysisEnvironment(row)
    )
    && (
      row.status === "queued"
      || row.status === "running"
      || unresolvedDeploymentOutcome(row)
    )
  );
  if (deployment) {
    const unknown = deployment.status === "failed";
    throw Object.assign(
      new Error(
        unknown
          ? "This registry credential cannot be changed until the prior deployment outcome using it is reconciled."
          : "This registry credential cannot be changed while a deployment that may use it is queued or running."
      ),
      { statusCode: 409, activeJobId: deployment.id }
    );
  }
  return registry;
}

export async function lockRegistryCredentialsForDeployment(
  client: PoolClient,
  registryIds: string[]
) {
  const rows = [];
  for (const id of [...new Set(registryIds)].sort()) {
    const selected = await client.query<any>(
      "SELECT * FROM registries WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!selected.rows[0]) {
      throw Object.assign(
        new Error("Registry credentials changed while this deployment was being prepared. Analyze again."),
        { statusCode: 409 }
      );
    }
    rows.push(selected.rows[0]);
  }
  return rows;
}

export async function registryCredentialIdsForImages(images: string[]) {
  const references = new Set(images.map((image) =>
    canonicalizeDockerRegistryAuthority(parseImageReference(image).registry)
  ));
  const result = await query<any>("SELECT * FROM registries ORDER BY id ASC");
  return result.rows
    .filter((row) => references.has(registryAuthority(row)))
    .map((row) => String(row.id))
    .sort();
}

export async function enqueueRegistryLogin(
  hostId: string,
  registryId: string,
  createdBy?: string | null,
  auditContext: {
    ipAddress?: string | null;
    userAgent?: string | null;
  } = {}
) {
  const job = await withTransaction(async (client) => {
    const selected = await client.query(
      "SELECT id FROM registries WHERE id = $1 FOR UPDATE",
      [registryId]
    );
    if (!selected.rows[0]) {
      throw Object.assign(new Error("Registry not found"), { statusCode: 404 });
    }
    const queued = await enqueueJobInTransaction(
      client,
      { type: "registry.login", hostId, payload: { registryId } },
      createdBy
    );
    await writeAuditEvent({
      userId: createdBy,
      hostId,
      action: "registry.login",
      targetKind: "registry",
      targetId: registryId,
      ...auditContext
    }, client);
    return queued;
  });
  await notifyJobQueued(job.id);
  return job;
}

export async function deleteRegistry(
  id: string,
  audit: RegistryAuditContext = {}
) {
  return withTransaction(async (client) => {
    const registry = await lockRegistryForMutation(client, id);
    if (!registry) return false;
    await client.query("DELETE FROM registries WHERE id = $1", [id]);
    await writeAuditEvent({
      ...audit,
      action: "registry.delete",
      targetKind: "registry",
      targetId: id,
      details: { authority: registryAuthority(registry) }
    }, client);
    return true;
  });
}

export async function getRegistryForWorker(id: string) {
  const result = await query<any>("SELECT * FROM registries WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Registry not found");
  const origin = normalizeSavedRegistryOrigin(String(row.url), {
    defaultProtocol: row.insecure ? "http" : "https"
  });
  return {
    id: row.id,
    name: row.name,
    // `docker login` takes a registry server authority rather than an API URL.
    url: new URL(origin).host,
    username: row.username as string | null,
    password: row.password_encrypted ? decryptSecret(row.password_encrypted) : null,
    insecure: origin.startsWith("http://")
  };
}
