import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

type GithubDeploymentBindingRow = {
  repository_id: string;
  stack_id: string;
  source_repository_url: string;
  source_branch: string;
  source_compose_path: string;
  source_commit_sha: string;
  compose_sha256: string;
  custom_compose: boolean;
};

export type GithubDeploymentBindingResolution =
  | { status: "not_applicable" }
  | {
    status: "deployed" | "failed";
    repositoryId: string;
    stackId: string;
    candidateSourceCommitSha: string;
    deployedSourceCommitSha: string | null;
    composeSha256: string;
    customCompose: boolean;
  };

type AuthoritativeRemoteOperation = {
  phase: string;
  state: string | undefined;
};

async function lockGithubDeploymentBinding(
  client: PoolClient,
  operationJobId: string
) {
  const binding = await client.query<GithubDeploymentBindingRow>(
    `SELECT repository_id, stack_id, source_repository_url, source_branch,
            source_compose_path, source_commit_sha, compose_sha256,
            custom_compose
     FROM github_deployment_jobs
     WHERE operation_job_id = $1
     FOR UPDATE`,
    [operationJobId]
  );
  return binding.rows[0] ?? null;
}

function bindingResolution(
  binding: GithubDeploymentBindingRow,
  status: "deployed" | "failed"
): GithubDeploymentBindingResolution {
  return {
    status,
    repositoryId: binding.repository_id,
    stackId: binding.stack_id,
    candidateSourceCommitSha: binding.source_commit_sha,
    deployedSourceCommitSha: status === "deployed" && !binding.custom_compose
      ? binding.source_commit_sha
      : null,
    composeSha256: binding.compose_sha256,
    customCompose: binding.custom_compose
  };
}

async function applyLockedGithubDeploymentBinding(
  client: PoolClient,
  operationJobId: string,
  binding: GithubDeploymentBindingRow
) {
  const stackResult = await client.query<{
    compose_yaml: string;
    source_repository_url: string | null;
    source_branch: string | null;
    source_compose_path: string | null;
  }>(
    `SELECT compose_yaml, source_repository_url, source_branch,
            source_compose_path
     FROM compose_stacks
     WHERE id = $1
     FOR UPDATE`,
    [binding.stack_id]
  );
  const repositoryResult = await client.query<{
    repository_url: string;
    compose_path: string;
  }>(
    `SELECT repository_url, compose_path
     FROM github_repositories
     WHERE id = $1
     FOR UPDATE`,
    [binding.repository_id]
  );
  const stack = stackResult.rows[0];
  const repository = repositoryResult.rows[0];
  const actualComposeSha256 = stack
    ? createHash("sha256")
        .update(stack.compose_yaml, "utf8")
        .digest("hex")
    : null;
  if (
    !stack
    || !repository
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
      binding.source_commit_sha
    )
    || !/^[0-9a-f]{64}$/.test(binding.compose_sha256)
    || actualComposeSha256 !== binding.compose_sha256
    || stack.source_repository_url !== binding.source_repository_url
    || stack.source_branch !== binding.source_branch
    || stack.source_compose_path !== binding.source_compose_path
    || repository.repository_url !== binding.source_repository_url
    || repository.compose_path !== binding.source_compose_path
  ) {
    throw new Error(
      "REMOTE_OUTCOME_UNKNOWN: GitHub deployment identity changed before completion; authoritative reconciliation must retain the target locks."
    );
  }

  await client.query(
    `UPDATE compose_stacks
     SET status = 'deployed',
         source_current_commit_sha = CASE
           WHEN $3::boolean THEN NULL
           ELSE $2
         END,
         last_deploy_error = null,
         updated_at = now()
     WHERE id = $1`,
    [
      binding.stack_id,
      binding.source_commit_sha,
      binding.custom_compose
    ]
  );
  await client.query(
    `UPDATE github_repositories
     SET last_deployed_at = now(),
         last_deployed_commit_sha = CASE
           WHEN $3::boolean THEN NULL
           ELSE $2
         END,
         update_check_error = null,
         last_error = null,
         updated_at = now()
     WHERE id = $1`,
    [
      binding.repository_id,
      binding.source_commit_sha,
      binding.custom_compose
    ]
  );
  await client.query(
    "DELETE FROM github_deployment_jobs WHERE operation_job_id = $1",
    [operationJobId]
  );
  return bindingResolution(binding, "deployed");
}

async function recordLockedGithubDeploymentFailure(
  client: PoolClient,
  operationJobId: string,
  binding: GithubDeploymentBindingRow,
  message: string,
  discard: boolean
) {
  await client.query(
    `UPDATE compose_stacks
     SET last_deploy_error = $2, updated_at = now()
     WHERE id = $1`,
    [binding.stack_id, message]
  );
  await client.query(
    `UPDATE github_repositories
     SET last_error = $2, updated_at = now()
     WHERE id = $1`,
    [binding.repository_id, message]
  );
  if (discard) {
    await client.query(
      "DELETE FROM github_deployment_jobs WHERE operation_job_id = $1",
      [operationJobId]
    );
  }
  return bindingResolution(binding, "failed");
}

export function githubDeploymentFailureNeedsReconciliation(message: string) {
  return message.startsWith("WORKER_LOST")
    || message.startsWith("REMOTE_OUTCOME_UNKNOWN:");
}

export async function applyGithubDeploymentBinding(
  client: PoolClient,
  operationJobId: string
) {
  const binding = await lockGithubDeploymentBinding(client, operationJobId);
  return binding
    ? applyLockedGithubDeploymentBinding(client, operationJobId, binding)
    : null;
}

export async function discardGithubDeploymentBinding(
  client: PoolClient,
  operationJobId: string
) {
  await client.query(
    "DELETE FROM github_deployment_jobs WHERE operation_job_id = $1",
    [operationJobId]
  );
}

export async function failGithubDeploymentBinding(
  client: PoolClient,
  operationJobId: string,
  message: string
) {
  const binding = await lockGithubDeploymentBinding(client, operationJobId);
  return binding
    ? recordLockedGithubDeploymentFailure(
      client,
      operationJobId,
      binding,
      message,
      true
    )
    : null;
}

export async function retainGithubDeploymentBinding(
  client: PoolClient,
  operationJobId: string,
  message: string
) {
  const binding = await lockGithubDeploymentBinding(client, operationJobId);
  return binding
    ? recordLockedGithubDeploymentFailure(
      client,
      operationJobId,
      binding,
      message,
      false
    )
    : null;
}

/**
 * Resolve a retained API-mode GitHub deployment only after the exact remote
 * mutation has authoritative terminal proof. The caller must invoke this in
 * the same transaction that publishes the reconciliation result and audit.
 */
export async function resolveGithubDeploymentBindingAfterReconciliation(
  client: PoolClient,
  operationJobId: string,
  remoteOperation: AuthoritativeRemoteOperation
): Promise<GithubDeploymentBindingResolution> {
  const binding = await lockGithubDeploymentBinding(client, operationJobId);
  if (!binding) return { status: "not_applicable" };
  if (
    remoteOperation.phase === "compose.deploy"
    && remoteOperation.state === "completed"
  ) {
    return applyLockedGithubDeploymentBinding(
      client,
      operationJobId,
      binding
    );
  }

  const message = [
    "GitHub deployment did not complete.",
    "Authoritative remote reconciliation observed",
    `phase '${remoteOperation.phase}' with state '${remoteOperation.state ?? "unknown"}'.`
  ].join(" ");
  return recordLockedGithubDeploymentFailure(
    client,
    operationJobId,
    binding,
    message,
    true
  );
}
