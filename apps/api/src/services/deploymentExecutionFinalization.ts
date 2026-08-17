import { v4 as uuid } from "uuid";
import path from "node:path";
import type { PoolClient } from "pg";
import {
  parseDeploymentEnvironment,
  serializeDeploymentEnvironment,
  SENSITIVE_ENVIRONMENT_NAME
} from "./deploymentEnvironment.js";
import { decryptSecret } from "./crypto.js";
import { normalizeRemotePath } from "./files.js";

function protectedDeploymentEnvironment(row: any) {
  const environment = row.env_encrypted
    ? decryptSecret(row.env_encrypted)
    : "";
  const values = parseDeploymentEnvironment(environment);
  const secretKeys = new Set<string>(
    (Array.isArray(row.variables) ? row.variables : [])
      .filter((variable: any) => variable?.secret === true)
      .map((variable: any) => String(variable.key ?? ""))
      .filter(Boolean)
  );
  for (const key of values.keys()) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(key)) secretKeys.add(key);
  }
  for (const key of secretKeys) {
    if (values.has(key)) values.set(key, "");
  }
  return serializeDeploymentEnvironment(values);
}

async function upsertDeploymentSourceInTransaction(
  client: PoolClient,
  row: any
) {
  const metadata = JSON.stringify({ lastAnalysisId: row.id });
  const source = row.source_id
    ? await client.query<any>(
        `UPDATE deployment_sources
         SET name = $2,
             source_locator = $3,
             branch = $4,
             compose_path = $5,
             working_dir = $6,
             project_name = $7,
             compose_yaml = $8,
             env_encrypted = $9,
             credential_username = $10,
             credential_secret_encrypted = $11,
             default_host_id = $12,
             metadata = metadata || $13::jsonb,
             last_deployed_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          row.source_id,
          row.display_name,
          row.source_locator,
          row.branch,
          row.compose_path,
          row.working_dir,
          row.project_name,
          row.compose_yaml,
          row.env_encrypted,
          row.credential_username,
          row.credential_secret_encrypted,
          row.host_id,
          metadata
        ]
      )
    : await client.query<any>(
        `INSERT INTO deployment_sources (
           id, source_type, name, source_locator, branch, compose_path,
           working_dir, project_name, compose_yaml, env_encrypted,
           credential_username, credential_secret_encrypted, default_host_id,
           metadata, last_deployed_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, now()
         )
         ON CONFLICT (
           source_type,
           source_locator,
           (COALESCE(branch, '')),
           (COALESCE(compose_path, ''))
         )
         DO UPDATE SET
           name = EXCLUDED.name,
           project_name = EXCLUDED.project_name,
           working_dir = EXCLUDED.working_dir,
           compose_yaml = EXCLUDED.compose_yaml,
           env_encrypted = EXCLUDED.env_encrypted,
           credential_username = EXCLUDED.credential_username,
           credential_secret_encrypted =
             EXCLUDED.credential_secret_encrypted,
           default_host_id = EXCLUDED.default_host_id,
           metadata = deployment_sources.metadata || EXCLUDED.metadata,
           last_deployed_at = now(),
           updated_at = now()
         RETURNING *`,
        [
          uuid(),
          row.source_type,
          row.display_name,
          row.source_locator,
          row.branch,
          row.compose_path,
          row.working_dir,
          row.project_name,
          row.compose_yaml,
          row.env_encrypted,
          row.credential_username,
          row.credential_secret_encrypted,
          row.host_id,
          metadata
        ]
      );
  if (!source.rows[0]) {
    throw new Error("The deployment source no longer exists.");
  }
  return source.rows[0];
}

export async function finalizeDeploymentExecutionInTransaction(
  client: PoolClient,
  analysisId: string,
  stackId: string
) {
  const selected = await client.query<any>(
    "SELECT * FROM deployment_analyses WHERE id = $1 FOR UPDATE",
    [analysisId]
  );
  const analysis = selected.rows[0];
  if (!analysis) throw new Error("Deployment analysis not found.");

  const stackResult = await client.query<any>(
    `SELECT id, host_id, project_name, compose_yaml, source_working_dir,
            source_compose_path, deployment_source_id, current_version_id
     FROM compose_stacks
     WHERE id = $1
     FOR UPDATE`,
    [stackId]
  );
  const stack = stackResult.rows[0];
  const expectedWorkingDirectory = normalizeRemotePath(
    String(analysis.working_dir ?? "")
  );
  const analysisComposePath = String(analysis.compose_path ?? "");
  const expectedComposePath = analysisComposePath.startsWith("/")
    ? normalizeRemotePath(analysisComposePath)
    : normalizeRemotePath(
        path.posix.join(expectedWorkingDirectory, analysisComposePath)
      );
  if (
    !stack
    || stack.host_id !== analysis.host_id
    || stack.project_name !== analysis.project_name
    || stack.compose_yaml !== analysis.compose_yaml
    || normalizeRemotePath(String(stack.source_working_dir ?? ""))
      !== expectedWorkingDirectory
    || normalizeRemotePath(String(stack.source_compose_path ?? ""))
      !== expectedComposePath
    || typeof stack.current_version_id !== "string"
  ) {
    throw new Error(
      "The completed remote deployment no longer matches its durable analysis."
    );
  }

  if (analysis.status === "deployed") {
    if (
      !analysis.source_id
      || stack.deployment_source_id !== analysis.source_id
    ) {
      throw new Error(
        "The deployed analysis is missing its durable stack/source binding."
      );
    }
    const source = await client.query<any>(
      "SELECT * FROM deployment_sources WHERE id = $1 FOR UPDATE",
      [analysis.source_id]
    );
    if (!source.rows[0]) {
      throw new Error("The deployment source no longer exists.");
    }
    return {
      analysis,
      source: source.rows[0],
      stackId,
      replayed: true
    };
  }
  if (analysis.status !== "deploying" && analysis.status !== "failed") {
    throw new Error(
      "Deployment analysis is not eligible for terminal finalization."
    );
  }

  const protectedEnvironment = protectedDeploymentEnvironment(analysis);
  const source = await upsertDeploymentSourceInTransaction(client, analysis);
  await client.query(
    `UPDATE compose_stacks
     SET deployment_source_id = $2,
         env = $3,
         status = 'deployed',
         updated_at = now()
     WHERE id = $1`,
    [stackId, source.id, protectedEnvironment]
  );
  await client.query(
    `UPDATE compose_stack_versions
     SET env = $2
     WHERE id = $1`,
    [stack.current_version_id, protectedEnvironment]
  );
  const updated = await client.query<any>(
    `UPDATE deployment_analyses
     SET status = 'deployed',
         source_id = $2,
         env_encrypted = null,
         credential_secret_encrypted = null,
         deployed_at = now(),
         updated_at = now(),
         error = null
     WHERE id = $1
       AND status IN ('deploying', 'failed')
     RETURNING *`,
    [analysisId, source.id]
  );
  if (!updated.rows[0]) {
    throw new Error(
      "This deployment execution attempt was superseded before terminal state was recorded."
    );
  }
  return {
    analysis: updated.rows[0],
    source,
    stackId,
    replayed: false
  };
}
