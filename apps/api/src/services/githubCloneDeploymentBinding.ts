import { createHash } from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import {
  deploymentEnvironmentBinding
} from "./deploymentEnvironment.js";
import { decryptSecret } from "./crypto.js";
import {
  inspectGitComposeSourceIntegrity,
  type GitComposeSourceIntegrity
} from "./gitComposeIntegrity.js";
import { normalizeRemotePath } from "./files.js";

type GithubCloneDeploymentBindingRow = {
  repository_id: string;
  host_id: string;
  stack_id: string | null;
  source_repository_url: string;
  clone_repository_url: string;
  source_branch: string;
  source_commit_sha: string;
  source_compose_path: string;
  compose_yaml: string;
  compose_sha256: string;
  project_name: string;
  working_dir: string;
  environment_encrypted: string;
  environment_binding: string;
};

export type GithubCloneDeploymentExecutionInput = {
  repositoryId: string;
  hostId: string;
  sourceRepositoryUrl: string;
  cloneRepositoryUrl: string;
  sourceBranch: string;
  sourceCommitSha: string;
  sourceComposePath: string;
  composeYaml: string;
  composeSha256: string;
  sourceIntegrity: GitComposeSourceIntegrity;
  projectName: string;
  workingDir: string;
  environment: string;
  environmentBinding: string;
};

export type GithubCloneDeploymentBindingResolution =
  | { status: "not_applicable" }
  | {
    status: "deployed" | "failed";
    repositoryId: string;
    stackId: string | null;
    sourceCommitSha: string;
    composeSha256: string;
    environmentBinding: string;
    projectName: string;
    workingDir: string;
  };

type GithubCloneActionIdentity = {
  repositoryId?: string;
  hostId: string;
  repositoryUrl: string;
  directory: string;
  branch?: string;
  composePath: string;
  projectName: string;
  sourceCommitSha?: string;
  composeSha256?: string;
};

type AuthoritativeRemoteOperation = {
  phase: string;
  state: string | undefined;
};

async function lockGithubCloneDeploymentBinding(
  client: PoolClient,
  operationJobId: string
) {
  const binding = await client.query<GithubCloneDeploymentBindingRow>(
    `SELECT repository_id, host_id, stack_id, source_repository_url,
            clone_repository_url, source_branch, source_commit_sha,
            source_compose_path, compose_yaml, compose_sha256, project_name,
            working_dir, environment_encrypted, environment_binding
     FROM github_clone_deployment_jobs
     WHERE operation_job_id = $1
     FOR UPDATE`,
    [operationJobId]
  );
  return binding.rows[0] ?? null;
}

function bindingResolution(
  binding: GithubCloneDeploymentBindingRow,
  status: "deployed" | "failed",
  stackId = binding.stack_id
): GithubCloneDeploymentBindingResolution {
  return {
    status,
    repositoryId: binding.repository_id,
    stackId,
    sourceCommitSha: binding.source_commit_sha,
    composeSha256: binding.compose_sha256,
    environmentBinding: binding.environment_binding,
    projectName: binding.project_name,
    workingDir: binding.working_dir
  };
}

function validateExecutionBinding(
  binding: GithubCloneDeploymentBindingRow
): GithubCloneDeploymentExecutionInput {
  const actualComposeSha256 = createHash("sha256")
    .update(binding.compose_yaml, "utf8")
    .digest("hex");
  const environment = decryptSecret(binding.environment_encrypted);
  const normalizedWorkingDir = normalizeRemotePath(binding.working_dir);
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(binding.source_commit_sha)
    || !/^[0-9a-f]{64}$/.test(binding.compose_sha256)
    || !/^[0-9a-f]{64}$/.test(binding.environment_binding)
    || actualComposeSha256 !== binding.compose_sha256
    || deploymentEnvironmentBinding(environment)
      !== binding.environment_binding
  ) {
    throw new Error(
      "The tracked clone deployment binding is corrupt. Queue a fresh deployment."
    );
  }
  const sourceIntegrity = inspectGitComposeSourceIntegrity(
    binding.compose_yaml,
    binding.source_compose_path
  );
  return {
    repositoryId: binding.repository_id,
    hostId: binding.host_id,
    sourceRepositoryUrl: binding.source_repository_url,
    cloneRepositoryUrl: binding.clone_repository_url,
    sourceBranch: binding.source_branch,
    sourceCommitSha: binding.source_commit_sha,
    sourceComposePath: binding.source_compose_path,
    composeYaml: binding.compose_yaml,
    composeSha256: binding.compose_sha256,
    sourceIntegrity,
    projectName: binding.project_name,
    workingDir: normalizedWorkingDir,
    environment,
    environmentBinding: binding.environment_binding
  };
}

function assertActionMatchesBinding(
  action: GithubCloneActionIdentity,
  binding: GithubCloneDeploymentExecutionInput
) {
  if (
    action.repositoryId !== binding.repositoryId
    || action.hostId !== binding.hostId
    || action.repositoryUrl !== binding.cloneRepositoryUrl
    || normalizeRemotePath(action.directory) !== binding.workingDir
    || action.branch !== binding.sourceBranch
    || action.composePath !== binding.sourceComposePath
    || action.projectName !== binding.projectName
    || action.sourceCommitSha !== binding.sourceCommitSha
    || action.composeSha256 !== binding.composeSha256
  ) {
    throw new Error(
      "The tracked clone job no longer matches its durable source binding."
    );
  }
}

export async function loadGithubCloneDeploymentBindingForExecution(
  client: PoolClient,
  operationJobId: string,
  action: GithubCloneActionIdentity
) {
  const row = await lockGithubCloneDeploymentBinding(client, operationJobId);
  if (!row) {
    throw new Error(
      "The tracked clone job is missing its durable source binding."
    );
  }
  const binding = validateExecutionBinding(row);
  assertActionMatchesBinding(action, binding);
  return binding;
}

export async function linkGithubCloneDeploymentStack(
  client: PoolClient,
  operationJobId: string,
  stackId: string
) {
  const linked = await client.query(
    `UPDATE github_clone_deployment_jobs AS bindings
     SET stack_id = $2
     FROM compose_stacks AS stacks
     WHERE bindings.operation_job_id = $1
       AND (bindings.stack_id IS NULL OR bindings.stack_id = $2)
       AND stacks.id = $2
       AND stacks.host_id = bindings.host_id
       AND stacks.project_name = bindings.project_name
     RETURNING bindings.operation_job_id`,
    [operationJobId, stackId]
  );
  if (linked.rowCount !== 1) {
    throw new Error(
      "The tracked clone stack no longer matches its durable deployment binding."
    );
  }
}

type LockedCloneStack = {
  id: string;
  host_id: string;
  project_name: string;
  compose_yaml: string;
  env: string;
  status: string;
  source_type: string | null;
  source_repository_url: string | null;
  source_branch: string | null;
  source_working_dir: string | null;
  source_compose_path: string | null;
  source_current_commit_sha: string | null;
  source_environment_encrypted: string | null;
  source_environment_binding: string | null;
};

async function lockBoundCloneStack(
  client: PoolClient,
  binding: GithubCloneDeploymentBindingRow
) {
  const stack = await client.query<LockedCloneStack>(
    `SELECT id, host_id, project_name, compose_yaml, env, status, source_type,
            source_repository_url, source_branch, source_working_dir,
            source_compose_path, source_current_commit_sha,
            source_environment_encrypted, source_environment_binding
     FROM compose_stacks
     WHERE (
       ($1::uuid IS NOT NULL AND id = $1)
       OR (
         $1::uuid IS NULL
         AND host_id = $2
         AND project_name = $3
       )
     )
     FOR UPDATE`,
    [binding.stack_id, binding.host_id, binding.project_name]
  );
  return stack.rows[0] ?? null;
}

async function applyLockedGithubCloneDeploymentBinding(
  client: PoolClient,
  operationJobId: string,
  binding: GithubCloneDeploymentBindingRow
) {
  const expected = validateExecutionBinding(binding);
  const stack = await lockBoundCloneStack(client, binding);
  const repositoryResult = await client.query<{
    repository_url: string;
    compose_path: string;
    host_clone_url: string | null;
    host_clone_directory: string | null;
  }>(
    `SELECT repository_url, compose_path, host_clone_url,
            host_clone_directory
     FROM github_repositories
     WHERE id = $1
     FOR UPDATE`,
    [binding.repository_id]
  );
  const repository = repositoryResult.rows[0];
  const stackEnvironment = stack?.source_environment_encrypted
    ? decryptSecret(stack.source_environment_encrypted)
    : "";
  const expectedComposePath = normalizeRemotePath(
    path.posix.join(binding.working_dir, binding.source_compose_path)
  );
  const actualComposeSha256 = stack
    ? createHash("sha256")
        .update(stack.compose_yaml, "utf8")
        .digest("hex")
    : null;
  if (
    !stack
    || !repository
    || stack.host_id !== binding.host_id
    || stack.project_name !== binding.project_name
    || actualComposeSha256 !== binding.compose_sha256
    || stack.env !== expected.environment
    || stack.source_type !== "git"
    || stack.source_repository_url !== binding.clone_repository_url
    || stack.source_branch !== binding.source_branch
    || stack.source_working_dir !== binding.working_dir
    || stack.source_compose_path !== expectedComposePath
    || (
      stack.source_current_commit_sha !== null
      && stack.source_current_commit_sha !== binding.source_commit_sha
    )
    || stack.source_environment_binding !== binding.environment_binding
    || deploymentEnvironmentBinding(stackEnvironment)
      !== binding.environment_binding
    || stackEnvironment !== expected.environment
    || repository.repository_url !== binding.source_repository_url
    || repository.compose_path !== binding.source_compose_path
    || repository.host_clone_url !== binding.clone_repository_url
    || repository.host_clone_directory !== binding.working_dir
  ) {
    throw new Error(
      "REMOTE_OUTCOME_UNKNOWN: Tracked clone deployment identity changed before completion; authoritative reconciliation must retain the target locks."
    );
  }

  await client.query(
    `UPDATE compose_stacks
     SET status = 'deployed',
         source_current_commit_sha = $2,
         last_deploy_error = null,
         updated_at = now()
     WHERE id = $1`,
    [stack.id, binding.source_commit_sha]
  );
  await client.query(
    `UPDATE github_repositories
     SET last_deployed_at = now(),
         last_deployed_commit_sha = $2,
         latest_commit_sha = COALESCE(latest_commit_sha, $2),
         update_checked_at = now(),
         update_check_error = null,
         last_error = null,
         updated_at = now()
     WHERE id = $1`,
    [binding.repository_id, binding.source_commit_sha]
  );
  await client.query(
    "DELETE FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
    [operationJobId]
  );
  return bindingResolution(binding, "deployed", stack.id);
}

async function recordLockedGithubCloneDeploymentFailure(
  client: PoolClient,
  operationJobId: string,
  binding: GithubCloneDeploymentBindingRow,
  message: string,
  discard: boolean
) {
  await client.query(
    `UPDATE compose_stacks
     SET last_deploy_error = $4, updated_at = now()
     WHERE (
       ($1::uuid IS NOT NULL AND id = $1)
       OR (
         $1::uuid IS NULL
         AND host_id = $2
         AND project_name = $3
       )
     )`,
    [
      binding.stack_id,
      binding.host_id,
      binding.project_name,
      message
    ]
  );
  await client.query(
    `UPDATE github_repositories
     SET last_error = $2, updated_at = now()
     WHERE id = $1`,
    [binding.repository_id, message]
  );
  if (discard) {
    await client.query(
      "DELETE FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
      [operationJobId]
    );
  }
  return bindingResolution(binding, "failed");
}

export async function applyGithubCloneDeploymentBinding(
  client: PoolClient,
  operationJobId: string
) {
  const binding = await lockGithubCloneDeploymentBinding(
    client,
    operationJobId
  );
  return binding
    ? applyLockedGithubCloneDeploymentBinding(
      client,
      operationJobId,
      binding
    )
    : null;
}

export async function discardGithubCloneDeploymentBinding(
  client: PoolClient,
  operationJobId: string
) {
  await client.query(
    "DELETE FROM github_clone_deployment_jobs WHERE operation_job_id = $1",
    [operationJobId]
  );
}

export async function failGithubCloneDeploymentBinding(
  client: PoolClient,
  operationJobId: string,
  message: string
) {
  const binding = await lockGithubCloneDeploymentBinding(
    client,
    operationJobId
  );
  return binding
    ? recordLockedGithubCloneDeploymentFailure(
      client,
      operationJobId,
      binding,
      message,
      true
    )
    : null;
}

export async function retainGithubCloneDeploymentBinding(
  client: PoolClient,
  operationJobId: string,
  message: string
) {
  const binding = await lockGithubCloneDeploymentBinding(
    client,
    operationJobId
  );
  return binding
    ? recordLockedGithubCloneDeploymentFailure(
      client,
      operationJobId,
      binding,
      message,
      false
    )
    : null;
}

export async function resolveGithubCloneDeploymentBindingAfterReconciliation(
  client: PoolClient,
  operationJobId: string,
  remoteOperation: AuthoritativeRemoteOperation
): Promise<GithubCloneDeploymentBindingResolution> {
  const binding = await lockGithubCloneDeploymentBinding(
    client,
    operationJobId
  );
  if (!binding) return { status: "not_applicable" };
  if (
    remoteOperation.phase === "compose.deployPath.up"
    && remoteOperation.state === "completed"
  ) {
    return applyLockedGithubCloneDeploymentBinding(
      client,
      operationJobId,
      binding
    );
  }
  const message = [
    "Tracked clone deployment did not complete.",
    "Authoritative remote reconciliation observed",
    `phase '${remoteOperation.phase}' with state '${remoteOperation.state ?? "unknown"}'.`
  ].join(" ");
  return recordLockedGithubCloneDeploymentFailure(
    client,
    operationJobId,
    binding,
    message,
    true
  );
}
