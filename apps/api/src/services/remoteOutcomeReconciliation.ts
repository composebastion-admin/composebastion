import path from "node:path";
import type { PoolClient } from "pg";
import { v4 as uuid } from "uuid";
import {
  normalizeRegistryAuthority,
  sanitizeGitRepositoryUrlFields,
  sanitizeUrlDiagnosticText
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import {
  inspectAgentRemoteOperation,
  runAgentDockerCommand
} from "./agent.js";
import { writeAuditEvent } from "./audit.js";
import { inventoryCommands, shQuote, withDockerEnv } from "./commands.js";
import {
  canonicalizeDockerMutationScope,
  dockerMutationScope,
  dockerMutationScopeEvidence,
  dockerMutationScopesConflict,
  RECONCILABLE_DOCKER_MUTATION_TYPES,
  type DockerMutationScope
} from "./dockerMutationScope.js";
import { normalizeRemotePath, statHostPath } from "./files.js";
import { getHostForWorker } from "./hosts.js";
import { safeErrorMessage } from "./operationLogs.js";
import { stackRemoteDirectory } from "./remoteFiles.js";
import {
  cleanupSshRemoteOperation,
  inspectSshRemoteOperation,
  runSshCommand
} from "./ssh.js";
import {
  REMOTE_MUTATION_PROOF_KEY,
  remoteMutationProofFromResult,
  type RemoteMutationProof,
  type RemoteMutationRuntimeStatus
} from "./remoteMutationProof.js";
import {
  resolveGithubDeploymentBindingAfterReconciliation
} from "./githubDeploymentBinding.js";
import {
  resolveGithubCloneDeploymentBindingAfterReconciliation
} from "./githubCloneDeploymentBinding.js";
import { registryTrustArtifactPaths } from "./registryTrustArtifacts.js";
import {
  discardComposeStackDeploymentIntent,
  finalizeComposeStackDeploymentIntent,
  parseComposeStackDeploymentIntent
} from "./composeStackDeploymentIntent.js";
import {
  finalizeDeploymentExecutionInTransaction
} from "./deploymentExecutionFinalization.js";

// Every generic fenced SSH/agent mutation is supervised on the target with a
// hard ten-minute cap. The extra minute allows forced process-group teardown
// and durable terminal-proof publication before reconciliation may inspect.
export const REMOTE_OUTCOME_QUIESCENCE_SECONDS = 11 * 60;
export const REMOTE_OUTCOME_RECONCILIATION_KEY = "remoteOutcomeReconciliation";
export const REMOTE_OUTCOME_CLAIM_LEASE_SECONDS = 3 * 60;
export const REMOTE_OUTCOME_RETRY_BASE_SECONDS = 60;
export const REMOTE_OUTCOME_RETRY_MAX_SECONDS = 60 * 60;

type ReconciliationClaim = {
  token: string;
  attemptCount: number;
};

type ReconciliationHeartbeat = () => Promise<void>;

class ReconciliationClaimLostError extends Error {
  constructor(readonly jobId: string) {
    super(`Remote-outcome reconciliation claim for job ${jobId} was lost`);
    this.name = "ReconciliationClaimLostError";
  }
}

type AmbiguousJobRow = {
  id: string;
  type: string;
  host_id: string;
  error: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  remote_mutation_proof_absent?: boolean;
  attempt_count: string | number;
  completed_at: Date | string;
  stack_project_name: string | null;
  stack_working_dir: string | null;
  stack_compose_path: string | null;
  analysis_project_name: string | null;
  analysis_working_dir: string | null;
  analysis_compose_path: string | null;
};

/**
 * Every type in this allowlist persists a remote-mutation proof under the
 * active job lease before its first remote side effect is launched. After
 * worker loss and bounded quiescence, SQL-authoritative absence of that key
 * therefore proves that no remote mutation was dispatched for the attempt.
 */
export const REMOTE_OUTCOME_NO_DISPATCH_TYPES = Object.freeze([
  ...RECONCILABLE_DOCKER_MUTATION_TYPES,
  "compose.deploy",
  "compose.stop",
  "compose.remove",
  "deploy.analyze",
  "deploy.execute",
  "host.configureRegistryTrust"
]);
const remoteOutcomeNoDispatchTypes = new Set<string>(
  REMOTE_OUTCOME_NO_DISPATCH_TYPES
);

export type RemoteOutcomeTarget = {
  hostId: string;
  workingDir: string;
  projectName: string;
  composePath: string;
};

function normalizedRegistry(value: unknown) {
  const input = String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return input ? normalizeRegistryAuthority(input) : "";
}

function reconciliationState(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, unknown>)[REMOTE_OUTCOME_RECONCILIATION_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function workerLostBeforeRemoteMutationDispatch(row: AmbiguousJobRow) {
  return String(row.error ?? "").startsWith("WORKER_LOST")
    && remoteOutcomeNoDispatchTypes.has(row.type)
    && row.remote_mutation_proof_absent === true;
}

export function hasReconciledRemoteOutcome(result: unknown) {
  return reconciliationState(result)?.status === "reconciled";
}

function targetForJob(row: AmbiguousJobRow): RemoteOutcomeTarget | null {
  const payload = row.payload ?? {};
  const stackId = typeof payload.stackId === "string" ? payload.stackId : null;
  const isDeploymentAnalysis = row.type === "deploy.execute";
  const isCloneDeploy = row.type === "git.cloneDeploy";
  const isPathDeploy = row.type === "compose.deployPath"
    || row.type === "compose.writeDeployPath";
  const projectName = isDeploymentAnalysis
    ? row.analysis_project_name
    : isCloneDeploy || isPathDeploy
      ? typeof payload.projectName === "string" ? payload.projectName : null
      : row.stack_project_name;
  const workingDir = isDeploymentAnalysis
    ? row.analysis_working_dir
    : isCloneDeploy || isPathDeploy
      ? typeof (isCloneDeploy ? payload.directory : payload.workingDir) === "string"
        ? String(isCloneDeploy ? payload.directory : payload.workingDir)
        : null
      : row.stack_working_dir ?? (stackId ? stackRemoteDirectory(stackId) : null);
  const configuredComposePath = isDeploymentAnalysis
    ? row.analysis_compose_path
    : isCloneDeploy || isPathDeploy
      ? typeof payload.composePath === "string" ? payload.composePath : null
      : row.stack_compose_path;
  if (!projectName?.trim() || !workingDir?.trim()) return null;
  const normalizedWorkingDir = normalizeRemotePath(workingDir);
  const composePath = configuredComposePath?.trim()
    ? configuredComposePath.startsWith("/")
      ? normalizeRemotePath(configuredComposePath)
      : normalizeRemotePath(path.posix.join(normalizedWorkingDir, configuredComposePath))
    : normalizeRemotePath(path.posix.join(normalizedWorkingDir, "compose.yml"));
  return {
    hostId: row.host_id,
    workingDir: normalizedWorkingDir,
    projectName: projectName.trim(),
    composePath
  };
}

async function hasActiveRegistryTrustOperation(
  failedJobId: string,
  hostId: string,
  registry: string
) {
  const active = await query<{
    id: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT id, payload
     FROM operation_jobs
     WHERE id <> $1
       AND host_id = $2
       AND type = 'host.configureRegistryTrust'
       AND status IN ('queued', 'running')`,
    [failedJobId, hostId]
  );
  return active.rows.some((row) => {
    try {
      return normalizedRegistry(row.payload?.registry) === registry;
    } catch {
      return false;
    }
  });
}

function parseDockerRows(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const crossTargetJobTypes = [
  ...RECONCILABLE_DOCKER_MUTATION_TYPES,
  "compose.deploy",
  "compose.stop",
  "compose.remove",
  "deploy.analyze",
  "deploy.execute"
] as const;

function scopeFromRow(row: AmbiguousJobRow) {
  const direct = dockerMutationScope(row);
  if (direct) return direct;
  const target = targetForJob(row);
  if (!target) return null;
  return dockerMutationScope({
    type: "compose.deployPath",
    host_id: target.hostId,
    payload: {
      workingDir: target.workingDir,
      projectName: target.projectName,
      _scopeKnown: true
    }
  });
}

async function canonicalizeScope(scope: DockerMutationScope) {
  return canonicalizeDockerMutationScope(
    { query } as unknown as PoolClient,
    scope
  );
}

function terminalRemoteState(state: RemoteMutationRuntimeStatus["state"]) {
  return state === "completed" || state === "failed" || state === "timed_out";
}

async function inspectRemoteOperationProofOnHost(
  hostId: string,
  proof: RemoteMutationProof,
  heartbeat?: ReconciliationHeartbeat
) {
  await heartbeat?.();
  const host = await getHostForWorker(hostId);
  let status: RemoteMutationRuntimeStatus;
  if (proof.transport === "agent") {
    if (host.connectionMode !== "agent" || !host.agent) {
      return {
        operationId: proof.operationId,
        state: "missing" as const
      };
    }
    status = await inspectAgentRemoteOperation(host.agent, proof.operationId);
  } else {
    if (host.connectionMode !== "ssh") {
      return {
        operationId: proof.operationId,
        state: "missing" as const
      };
    }
    status = await inspectSshRemoteOperation(host.ssh, proof.operationId);
  }
  await heartbeat?.();
  return status;
}

async function requireTerminalRemoteOperationProof(
  row: AmbiguousJobRow,
  heartbeat?: ReconciliationHeartbeat
) {
  const proof = remoteMutationProofFromResult(row.result);
  if (
    !proof
    || proof.jobId !== row.id
    || proof.attemptCount !== Number(row.attempt_count)
  ) {
    throw new Error(
      "Durable remote-operation proof is absent or does not match this exact job attempt"
    );
  }
  if (proof.status === "terminal") {
    return {
      source: "operation_job",
      operationId: proof.operationId,
      phase: proof.phase,
      transport: proof.transport,
      state: proof.terminalState
    };
  }

  const scope = scopeFromRow(row);
  const hostIds = scope?.hostIds?.length
    ? scope.hostIds
    : [row.host_id];
  const statuses: Array<RemoteMutationRuntimeStatus & { hostId: string }> = [];
  for (const hostId of hostIds) {
    const status = await inspectRemoteOperationProofOnHost(
      hostId,
      proof,
      heartbeat
    );
    statuses.push({ ...status, hostId });
  }
  if (statuses.some((status) => status.state === "running")) {
    throw new Error(
      `Remote operation ${proof.operationId} is still running; target inspection remains locked`
    );
  }
  const terminal = statuses.find((status) => terminalRemoteState(status.state));
  if (!terminal) {
    throw new Error(
      `Remote operation ${proof.operationId} has no authoritative terminal proof`
    );
  }
  return {
    source: proof.transport,
    operationId: proof.operationId,
    phase: proof.phase,
    transport: proof.transport,
    hostId: terminal.hostId,
    state: terminal.state
  };
}

async function hasActiveMutationForScope(
  failedJobId: string,
  requestedScope: DockerMutationScope
) {
  const active = await query<AmbiguousJobRow>(
    `SELECT jobs.id,
            jobs.type,
            jobs.host_id,
            jobs.error,
            jobs.payload,
            jobs.result,
            jobs.attempt_count,
            jobs.completed_at,
            stacks.project_name AS stack_project_name,
            stacks.source_working_dir AS stack_working_dir,
            stacks.source_compose_path AS stack_compose_path,
            analyses.project_name AS analysis_project_name,
            analyses.working_dir AS analysis_working_dir,
            analyses.compose_path AS analysis_compose_path
     FROM operation_jobs AS jobs
     LEFT JOIN compose_stacks AS stacks
       ON stacks.id::text = jobs.payload->>'stackId'
     LEFT JOIN deployment_analyses AS analyses
       ON analyses.id::text = jobs.payload->>'analysisId'
     WHERE jobs.id <> $1
       AND jobs.status IN ('queued', 'running')
       AND jobs.type = ANY($2::text[])
       AND (
         jobs.host_id = ANY($3::uuid[])
         OR jobs.payload->>'targetHostId' = ANY($3::text[])
       )`,
    [failedJobId, [...crossTargetJobTypes], requestedScope.hostIds]
  );
  const canonicalRequested = await canonicalizeScope(requestedScope);
  for (const row of active.rows) {
    const candidate = scopeFromRow(row);
    if (!candidate) continue;
    const canonicalCandidate = await canonicalizeScope(candidate);
    if (dockerMutationScopesConflict(canonicalRequested, canonicalCandidate)) {
      return true;
    }
  }
  return false;
}

async function runDockerInspection(
  hostId: string,
  command: string,
  heartbeat?: ReconciliationHeartbeat
) {
  await heartbeat?.();
  const host = await getHostForWorker(hostId);
  const result = host.connectionMode === "agent"
    ? host.agent
      ? await runAgentDockerCommand(host.agent, command, 60_000)
      : (() => { throw new Error("Agent host is missing agent connection details"); })()
    : await runSshCommand(
      host.ssh,
      withDockerEnv(command, host.public.dockerSocketPath),
      { timeoutMs: 60_000 }
    );
  await heartbeat?.();
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Docker target inspection failed");
  }
  return result;
}

function dockerRowIdentities(
  kind: "container" | "image" | "network" | "volume",
  row: Record<string, unknown>
) {
  if (kind === "container") {
    return [
      String(row.ID ?? ""),
      String(row.Names ?? "").replace(/^\//, "")
    ].filter(Boolean);
  }
  if (kind === "image") {
    const repository = String(row.Repository ?? "");
    const tag = String(row.Tag ?? "");
    return [
      String(row.ID ?? ""),
      repository && tag ? `${repository}:${tag}` : "",
      String(row.Digest ?? "")
    ].filter(Boolean);
  }
  if (kind === "network") {
    return [String(row.ID ?? ""), String(row.Name ?? "")].filter(Boolean);
  }
  return [String(row.Name ?? "")].filter(Boolean);
}

function safeDockerRow(
  kind: "container" | "image" | "network" | "volume",
  row: Record<string, unknown>
) {
  if (kind === "container") {
    return {
      id: String(row.ID ?? ""),
      name: String(row.Names ?? "").replace(/^\//, ""),
      image: String(row.Image ?? ""),
      state: String(row.State ?? ""),
      status: String(row.Status ?? "")
    };
  }
  if (kind === "image") {
    return {
      id: String(row.ID ?? ""),
      repository: String(row.Repository ?? ""),
      tag: String(row.Tag ?? ""),
      digest: String(row.Digest ?? "")
    };
  }
  if (kind === "network") {
    return {
      id: String(row.ID ?? ""),
      name: String(row.Name ?? ""),
      driver: String(row.Driver ?? ""),
      scope: String(row.Scope ?? "")
    };
  }
  return {
    name: String(row.Name ?? ""),
    driver: String(row.Driver ?? ""),
    scope: String(row.Scope ?? "")
  };
}

async function inspectGitPath(
  hostId: string,
  workingDir: string,
  heartbeat?: ReconciliationHeartbeat
) {
  await heartbeat?.();
  const directory = await statHostPath(hostId, workingDir);
  await heartbeat?.();
  const indexLock = await statHostPath(
    hostId,
    path.posix.join(workingDir, ".git", "index.lock")
  );
  await heartbeat?.();
  if (indexLock.exists) {
    throw new Error("Git index remains locked; remote outcome is not yet safe to reconcile");
  }
  const host = await getHostForWorker(hostId);
  let git: Record<string, unknown> | null = null;
  if (directory.exists && host.connectionMode === "ssh") {
    const inspected = await runSshCommand(
      host.ssh,
      [
        `cd ${shQuote(workingDir)}`,
        "if test -d .git; then",
        "remote=$(git remote get-url origin 2>/dev/null || true);",
        "commit=$(git rev-parse HEAD 2>/dev/null || true);",
        `printf '%s\\t%s\\n' "$remote" "$commit";`,
        "fi"
      ].join(" "),
      { timeoutMs: 30_000 }
    );
    await heartbeat?.();
    if (inspected.code !== 0) {
      throw new Error(inspected.stderr || inspected.stdout || "Could not inspect the Git working tree");
    }
    const [repositoryUrl = "", currentCommitSha = ""] = inspected.stdout
      .trim()
      .split("\t");
    git = sanitizeGitRepositoryUrlFields({
      repositoryUrl: repositoryUrl || null,
      currentCommitSha: currentCommitSha || null
    });
  }
  return {
    path: workingDir,
    exists: directory.exists,
    type: directory.type,
    gitIndexLocked: false,
    git
  };
}

async function inspectGenericMutation(
  row: AmbiguousJobRow,
  scope: DockerMutationScope,
  heartbeat?: ReconciliationHeartbeat
) {
  const hosts: Array<Record<string, unknown>> = [];
  for (const hostId of scope.hostIds) {
    const hostTargets = scope.targets.filter((target) => target.hostId === hostId);
    const pathTargets = hostTargets.filter((target) => target.kind === "host-path");
    const pathEvidence = [];
    for (const target of pathTargets) {
      pathEvidence.push(
        row.type === "git.clone" || row.type === "git.pull"
          ? await inspectGitPath(hostId, target.value, heartbeat)
          : {
            ...await (async () => {
              await heartbeat?.();
              const inspected = await statHostPath(hostId, target.value);
              await heartbeat?.();
              return inspected;
            })()
          }
      );
    }

    const dockerKinds = ["container", "image", "network", "volume"] as const;
    const requestedKinds = dockerKinds.filter((kind) =>
      hostTargets.some((target) => target.kind === kind)
    );
    const dockerEvidence: Record<string, unknown> = {};
    if (
      requestedKinds.length
      || hostTargets.some((target) => target.kind === "registry-auth")
    ) {
      const info = await runDockerInspection(
        hostId,
        "docker info --format '{{json .ServerVersion}}'",
        heartbeat
      );
      let serverVersion: unknown = info.stdout.trim();
      try {
        serverVersion = JSON.parse(info.stdout.trim());
      } catch {
        // Keep the sanitized plain version string returned by older engines.
      }
      dockerEvidence.serverVersion = String(serverVersion ?? "");
      for (const kind of requestedKinds) {
        const result = await runDockerInspection(
          hostId,
          inventoryCommands[`${kind}s`],
          heartbeat
        );
        const rows = parseDockerRows(result.stdout);
        const values = hostTargets
          .filter((target) => target.kind === kind)
          .map((target) => target.value);
        const wildcard = values.includes("*");
        const matches = rows.filter((item) =>
          wildcard
          || dockerRowIdentities(kind, item)
            .some((identity) => values.includes(identity))
        );
        dockerEvidence[kind] = {
          inventoryCount: rows.length,
          matchedCount: matches.length,
          matches: matches.slice(0, 50).map((item) => safeDockerRow(kind, item)),
          truncated: matches.length > 50
        };
      }
    }
    hosts.push({
      hostId,
      paths: pathEvidence,
      docker: dockerEvidence
    });
  }
  return sanitizeGitRepositoryUrlFields({
    inspectedAt: new Date().toISOString(),
    scope: dockerMutationScopeEvidence(scope),
    hosts
  });
}

function dockerRuntimeTrust(indexConfigs: unknown, registry: string) {
  if (!indexConfigs || typeof indexConfigs !== "object" || Array.isArray(indexConfigs)) {
    return false;
  }
  return Object.entries(indexConfigs as Record<string, unknown>).some(([authority, raw]) => {
    try {
      return normalizedRegistry(authority) === registry
        && Boolean(raw)
        && typeof raw === "object"
        && (raw as { Secure?: unknown }).Secure === false;
    } catch {
      return false;
    }
  });
}

/**
 * Reconcile the privileged registry-trust mutation from authoritative state.
 * Both daemon.json and the running daemon must agree; either the installed or
 * restored state is safe to unlock because a later request will then no-op or
 * perform a fresh fenced installation.
 */
export async function inspectRegistryTrustRemoteOutcome(
  hostId: string,
  registryInput: string,
  heartbeat?: ReconciliationHeartbeat
) {
  const registry = normalizedRegistry(registryInput);
  if (!registry) throw new Error("Registry trust target metadata is incomplete");
  await heartbeat?.();
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") {
    throw new Error("Registry trust reconciliation requires the original SSH host");
  }
  const daemon = await runSshCommand(
    host.ssh,
    "if sudo -n test -f /etc/docker/daemon.json; then sudo -n cat /etc/docker/daemon.json; else printf '{}'; fi",
    { timeoutMs: 30_000 }
  );
  await heartbeat?.();
  if (daemon.code !== 0) {
    throw new Error(daemon.stderr || daemon.stdout || "Could not inspect Docker daemon configuration");
  }
  let daemonConfig: Record<string, unknown>;
  try {
    const parsed = JSON.parse(daemon.stdout || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Docker daemon configuration is not an object");
    }
    daemonConfig = parsed as Record<string, unknown>;
  } catch {
    throw new Error("Docker daemon configuration is not valid JSON");
  }
  const configuredAuthorities = Array.isArray(daemonConfig["insecure-registries"])
    ? daemonConfig["insecure-registries"]
        .filter((value): value is string => typeof value === "string")
        .flatMap((value) => {
          try {
            return [normalizedRegistry(value)];
          } catch {
            return [];
          }
        })
    : [];
  const daemonConfigured = configuredAuthorities.includes(registry);

  const docker = await runSshCommand(
    host.ssh,
    withDockerEnv(
      "docker info --format '{{json .RegistryConfig.IndexConfigs}}'",
      host.public.dockerSocketPath
    ),
    { timeoutMs: 60_000 }
  );
  await heartbeat?.();
  if (docker.code !== 0) {
    throw new Error(docker.stderr || docker.stdout || "Docker is not ready");
  }
  let indexConfigs: unknown;
  try {
    indexConfigs = JSON.parse(docker.stdout.trim() || "{}");
  } catch {
    throw new Error("Docker returned malformed registry trust state");
  }
  const runtimeTrusted = dockerRuntimeTrust(indexConfigs, registry);
  if (daemonConfigured !== runtimeTrusted) {
    throw new Error(
      "Docker daemon configuration and running registry trust state do not agree"
    );
  }
  return {
    inspectedAt: new Date().toISOString(),
    hostId,
    registry,
    dockerReady: true,
    daemonConfigured,
    runtimeTrusted
  };
}

export async function cleanupRegistryTrustCandidate(
  hostId: string,
  jobId: string,
  attemptCount: number,
  heartbeat?: ReconciliationHeartbeat
) {
  const { candidatePath } = registryTrustArtifactPaths({
    jobId,
    attemptCount
  });
  await heartbeat?.();
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") {
    throw new Error(
      "Registry trust candidate cleanup requires the original SSH host"
    );
  }
  const quoted = shQuote(candidatePath);
  const cleanup = await runSshCommand(
    host.ssh,
    [
      `if [ -L ${quoted} ]; then exit 73; fi`,
      `if [ ! -e ${quoted} ]; then printf 'absent\\n'; exit 0; fi`,
      `test -f ${quoted}`,
      `test "$(stat -c %u -- ${quoted})" = "$(id -u)"`,
      `rm -f -- ${quoted}`,
      `test ! -e ${quoted} && test ! -L ${quoted}`,
      "printf 'removed\\n'"
    ].join(" && "),
    { timeoutMs: 30_000 }
  );
  await heartbeat?.();
  if (cleanup.code !== 0) {
    throw new Error(
      cleanup.stderr
      || cleanup.stdout
      || "Could not remove the owned registry trust candidate"
    );
  }
  const state = cleanup.stdout.trim() === "removed" ? "removed" : "absent";
  return { state };
}

/**
 * Read-only inspection used only after bounded quiescence. It verifies the
 * target directory and Compose file, checks that Git has no index lock, reads
 * sanitized repository/commit metadata on SSH hosts, and inventories the
 * authoritative Docker Compose project by label.
 */
export async function inspectRemoteOutcomeTarget(
  target: RemoteOutcomeTarget,
  heartbeat?: ReconciliationHeartbeat
) {
  await heartbeat?.();
  const host = await getHostForWorker(target.hostId);
  const [directory, composeFile, gitIndexLock] = await Promise.all([
    statHostPath(target.hostId, target.workingDir),
    statHostPath(target.hostId, target.composePath),
    statHostPath(target.hostId, path.posix.join(target.workingDir, ".git", "index.lock"))
  ]);
  await heartbeat?.();
  if (gitIndexLock.exists) {
    throw new Error("Git index remains locked; remote outcome is not yet safe to reconcile");
  }

  const projectFilter = shQuote(
    `label=com.docker.compose.project=${target.projectName}`
  );
  const containers = parseDockerRows((await runDockerInspection(
    target.hostId,
    [
      "docker ps --all",
      `--filter ${projectFilter}`,
      "--no-trunc",
      "--format '{{json .}}'"
    ].join(" "),
    heartbeat
  )).stdout);
  const networks = parseDockerRows((await runDockerInspection(
    target.hostId,
    [
      "docker network ls",
      `--filter ${projectFilter}`,
      "--no-trunc",
      "--format '{{json .}}'"
    ].join(" "),
    heartbeat
  )).stdout);
  const volumes = parseDockerRows((await runDockerInspection(
    target.hostId,
    [
      "docker volume ls",
      `--filter ${projectFilter}`,
      "--format '{{json .}}'"
    ].join(" "),
    heartbeat
  )).stdout);
  const referencedImages = new Set(
    containers.map((row) => String(row.Image ?? "")).filter(Boolean)
  );
  const images = referencedImages.size
    ? parseDockerRows((await runDockerInspection(
      target.hostId,
      inventoryCommands.images,
      heartbeat
    )).stdout).filter((row) =>
      dockerRowIdentities("image", row).some((identity) =>
        referencedImages.has(identity)
      )
    )
    : [];

  let git: {
    repositoryUrl: string | null;
    currentCommitSha: string | null;
  } | null = null;
  if (host.connectionMode === "ssh" && directory.exists) {
    const inspected = await runSshCommand(
      host.ssh,
      [
        `cd ${shQuote(target.workingDir)}`,
        "if test -d .git; then",
        "remote=$(git remote get-url origin 2>/dev/null || true);",
        "commit=$(git rev-parse HEAD 2>/dev/null || true);",
        `printf '%s\\t%s\\n' "$remote" "$commit";`,
        "fi"
      ].join(" "),
      { timeoutMs: 30_000 }
    );
    await heartbeat?.();
    if (inspected.code !== 0) {
      throw new Error(inspected.stderr || inspected.stdout || "Could not inspect the Git working tree");
    }
    const [repositoryUrl = "", currentCommitSha = ""] = inspected.stdout.trim().split("\t");
    if (repositoryUrl || currentCommitSha) {
      git = sanitizeGitRepositoryUrlFields({
        repositoryUrl: repositoryUrl || null,
        currentCommitSha: currentCommitSha || null
      });
    }
  }

  return sanitizeGitRepositoryUrlFields({
    inspectedAt: new Date().toISOString(),
    hostId: target.hostId,
    workingDir: target.workingDir,
    projectName: target.projectName,
    composePath: target.composePath,
    directoryExists: directory.exists,
    composeFileExists: composeFile.exists,
    gitIndexLocked: false,
    git,
    composeProject: {
      containerCount: containers.length,
      states: [...new Set(containers.map((row) => String(row.State ?? "")).filter(Boolean))].sort(),
      containers: containers.slice(0, 100).map((row) =>
        safeDockerRow("container", row)
      ),
      containersTruncated: containers.length > 100,
      networkCount: networks.length,
      networks: networks.slice(0, 100).map((row) =>
        safeDockerRow("network", row)
      ),
      networksTruncated: networks.length > 100,
      volumeCount: volumes.length,
      volumes: volumes.slice(0, 100).map((row) =>
        safeDockerRow("volume", row)
      ),
      volumesTruncated: volumes.length > 100,
      referencedImageCount: images.length,
      images: images.slice(0, 100).map((row) =>
        safeDockerRow("image", row)
      ),
      imagesTruncated: images.length > 100
    }
  });
}

async function claimReconciliation(
  row: AmbiguousJobRow
): Promise<ReconciliationClaim | null> {
  const token = uuid();
  const result = await query<{ attempt_count: string | number }>(
    `UPDATE operation_jobs
     SET result = COALESCE(result, '{}'::jsonb)
       || jsonb_build_object(
            $2::text,
            jsonb_build_object(
              'status', 'inspecting',
              'claimToken', $3::text,
              'startedAt', clock_timestamp(),
              'heartbeatAt', clock_timestamp(),
              'attemptCount',
                CASE
                  WHEN COALESCE(result-> $2 ->> 'attemptCount', '') ~ '^[0-9]+$'
                    THEN (result-> $2 ->> 'attemptCount')::integer + 1
                  ELSE 1
                END
            )
          ),
         updated_at = now()
     WHERE id = $1
       AND status = 'failed'
       AND (
         error LIKE 'WORKER_LOST%'
         OR error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
       )
       AND (
         result-> $2 IS NULL
         OR COALESCE(result-> $2 ->> 'status', '') NOT IN ('inspecting', 'pending')
         OR (
           result-> $2 ->> 'status' = 'inspecting'
           AND COALESCE(
             NULLIF(result-> $2 ->> 'heartbeatAt', '')::timestamptz,
             NULLIF(result-> $2 ->> 'startedAt', '')::timestamptz,
             '-infinity'::timestamptz
           ) < now() - ($4 * interval '1 second')
         )
         OR (
           result-> $2 ->> 'status' = 'pending'
           AND COALESCE(
             NULLIF(result-> $2 ->> 'nextAttemptAt', '')::timestamptz,
             '-infinity'::timestamptz
           ) <= now()
         )
       )
     RETURNING result-> $2 ->> 'attemptCount' AS attempt_count`,
    [
      row.id,
      REMOTE_OUTCOME_RECONCILIATION_KEY,
      token,
      REMOTE_OUTCOME_CLAIM_LEASE_SECONDS
    ]
  );
  const claimed = result.rows[0];
  if (!claimed) return null;
  return {
    token,
    attemptCount: Math.max(1, Number(claimed.attempt_count) || 1)
  };
}

async function heartbeatReconciliation(
  row: AmbiguousJobRow,
  claim: ReconciliationClaim
) {
  const result = await query(
    `UPDATE operation_jobs
     SET result = COALESCE(result, '{}'::jsonb)
       || jsonb_build_object(
            $2::text,
            (result-> $2)
              || jsonb_build_object('heartbeatAt', clock_timestamp())
          ),
         updated_at = now()
     WHERE id = $1
       AND status = 'failed'
       AND result-> $2 ->> 'status' = 'inspecting'
       AND result-> $2 ->> 'claimToken' = $3
     RETURNING id`,
    [row.id, REMOTE_OUTCOME_RECONCILIATION_KEY, claim.token]
  );
  if (!result.rows[0]) {
    throw new ReconciliationClaimLostError(row.id);
  }
}

function reconciliationRetryDelaySeconds(attemptCount: number) {
  return Math.min(
    REMOTE_OUTCOME_RETRY_MAX_SECONDS,
    REMOTE_OUTCOME_RETRY_BASE_SECONDS
      * (2 ** Math.max(0, Math.min(attemptCount - 1, 16)))
  );
}

async function persistReconciliation(
  row: AmbiguousJobRow,
  claim: ReconciliationClaim,
  status: "reconciled" | "pending",
  detail: Record<string, unknown>,
  finalize?: (
    client: PoolClient
  ) => Promise<Record<string, unknown> | null>,
  requireRemoteMutationProofAbsent = false
) {
  const nextAttemptAt = status === "pending"
    ? new Date(
      Date.now() + reconciliationRetryDelaySeconds(claim.attemptCount) * 1_000
    ).toISOString()
    : undefined;
  const evidence = sanitizeGitRepositoryUrlFields({
    ...detail,
    status,
    attemptCount: claim.attemptCount,
    ...(nextAttemptAt ? { nextAttemptAt } : {})
  });
  const update = async (execute: typeof query) => execute(
    `UPDATE operation_jobs
     SET result = COALESCE(result, '{}'::jsonb)
       || jsonb_build_object($2::text, $3::jsonb),
         updated_at = now()
     WHERE id = $1
       AND status = 'failed'
       AND (
         error LIKE 'WORKER_LOST%'
         OR error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
       )
       AND result-> $2 ->> 'status' = 'inspecting'
       AND result-> $2 ->> 'claimToken' = $4
       AND (
         NOT $5::boolean
         OR (
           jsonb_typeof(result) = 'object'
           AND NOT (result ? $6::text)
         )
       )
     RETURNING id`,
    [
      row.id,
      REMOTE_OUTCOME_RECONCILIATION_KEY,
      JSON.stringify(evidence),
      claim.token,
      requireRemoteMutationProofAbsent,
      REMOTE_MUTATION_PROOF_KEY
    ]
  );
  if (status === "pending") {
    const result = await update(query);
    return result.rowCount === 1;
  }
  return withTransaction(async (client) => {
    const result = await update(client.query.bind(client) as typeof query);
    if (result.rowCount !== 1) return false;
    const finalizedDetail = await finalize?.(client);
    const finalizedEvidence = finalizedDetail
      ? sanitizeGitRepositoryUrlFields({
        ...evidence,
        ...finalizedDetail
      })
      : evidence;
    if (finalizedDetail) {
      await client.query(
        `UPDATE operation_jobs
         SET result = COALESCE(result, '{}'::jsonb)
           || jsonb_build_object($2::text, $3::jsonb),
             updated_at = now()
         WHERE id = $1
         RETURNING id`,
        [
          row.id,
          REMOTE_OUTCOME_RECONCILIATION_KEY,
          JSON.stringify(finalizedEvidence)
        ]
      );
    }
    await writeAuditEvent({
      hostId: row.host_id,
      action: "operation.remote_outcome.reconciled",
      targetKind: "operation_job",
      targetId: row.id,
      details: finalizedEvidence
    }, client);
    return true;
  });
}

async function cleanupPersistedTerminalRemoteOperation(
  row: AmbiguousJobRow,
  terminalOperation: Awaited<
    ReturnType<typeof requireTerminalRemoteOperationProof>
  >
) {
  if (terminalOperation.transport !== "ssh") return;
  const hostIds = new Set<string>([row.host_id]);
  const targetHostId = row.payload?.targetHostId;
  if (typeof targetHostId === "string" && targetHostId) {
    hostIds.add(targetHostId);
  }
  try {
    const mutationScope = scopeFromRow(row);
    for (const hostId of mutationScope?.hostIds ?? []) {
      hostIds.add(hostId);
    }
  } catch {
    // Malformed historical scope metadata must not make a committed
    // reconciliation fail. Direct and proof-observed hosts remain eligible.
  }
  if ("hostId" in terminalOperation && terminalOperation.hostId) {
    hostIds.add(terminalOperation.hostId);
  }

  for (const hostId of hostIds) {
    try {
      const host = await getHostForWorker(hostId);
      if (host.connectionMode === "ssh") {
        await cleanupSshRemoteOperation(
          host.ssh,
          terminalOperation.operationId
        );
      }
    } catch {
      // Reconciliation and its audit record are already committed. A cleanup
      // failure must not roll that durable evidence back; the bounded orphan
      // sweeper will retry without logging marker contents or host secrets.
    }
  }
}

async function finalizeGithubDeploymentBinding(
  client: PoolClient,
  row: AmbiguousJobRow,
  remoteOperation: {
    phase: string;
    state: string | undefined;
  }
) {
  if (row.type === "git.cloneDeploy") {
    const resolution =
      await resolveGithubCloneDeploymentBindingAfterReconciliation(
        client,
        row.id,
        remoteOperation
      );
    return resolution.status === "not_applicable"
      ? null
      : { githubCloneDeploymentBinding: resolution };
  }
  if (row.type === "compose.deploy") {
    const resolution =
      await resolveGithubDeploymentBindingAfterReconciliation(
        client,
        row.id,
        remoteOperation
      );
    return resolution.status === "not_applicable"
      ? null
      : { githubDeploymentBinding: resolution };
  }
  return null;
}

const composeStackIntentJobTypes = new Set([
  "compose.deployPath",
  "compose.writeDeployPath",
  "deploy.execute",
  "git.cloneDeploy"
]);

async function finalizeReconciledOutcome(
  client: PoolClient,
  row: AmbiguousJobRow,
  remoteOperation: {
    phase: string;
    state: string | undefined;
  }
) {
  const detail: Record<string, unknown> = {};
  if (composeStackIntentJobTypes.has(row.type)) {
    const identity = {
      jobId: row.id,
      attemptCount: Number(row.attempt_count),
      hostId: row.host_id
    };
    if (
      remoteOperation.phase === "compose.deployPath.up"
      && remoteOperation.state === "completed"
    ) {
      const intent = parseComposeStackDeploymentIntent(row.result, identity);
      if (
        row.type === "git.cloneDeploy"
        && intent.githubCloneOperationJobId !== row.id
      ) {
        throw new Error(
          "Compose stack deployment intent is missing its exact tracked-clone binding."
        );
      }
      const finalized = await finalizeComposeStackDeploymentIntent(
        client,
        intent
      );
      detail.composeStackDeployment = {
        status: "deployed",
        stackId: finalized.stackId,
        versionId: finalized.versionId,
        versionNumber: finalized.versionNumber,
        replayed: finalized.replayed
      };
      if (row.type === "deploy.execute") {
        const analysisId = row.payload?.analysisId;
        if (typeof analysisId !== "string" || !analysisId) {
          throw new Error(
            "Deployment execution reconciliation is missing its analysis identity."
          );
        }
        const deployment = await finalizeDeploymentExecutionInTransaction(
          client,
          analysisId,
          finalized.stackId
        );
        detail.deploymentExecution = {
          status: "deployed",
          analysisId,
          sourceId: String(deployment.source.id),
          stackId: finalized.stackId,
          replayed: deployment.replayed
        };
      }
    } else {
      detail.composeStackDeployment = {
        status: "not_materialized",
        phase: remoteOperation.phase,
        state: remoteOperation.state ?? null
      };
    }
    const githubDetail = await finalizeGithubDeploymentBinding(
      client,
      row,
      remoteOperation
    );
    if (githubDetail) Object.assign(detail, githubDetail);
    // Discard only in the same transaction that publishes authoritative
    // reconciliation. Normal execution retains ciphertext until completeJob
    // replaces the running result, closing the post-commit lease-loss gap.
    await discardComposeStackDeploymentIntent(client, identity);
    return detail;
  }

  return finalizeGithubDeploymentBinding(client, row, remoteOperation);
}

function reconciledOutcomeFinalizer(
  row: AmbiguousJobRow,
  remoteOperation: {
    phase: string;
    state: string | undefined;
  }
) {
  return composeStackIntentJobTypes.has(row.type)
    || row.type === "compose.deploy"
    || row.type === "git.cloneDeploy"
    ? (client: PoolClient) => finalizeReconciledOutcome(
      client,
      row,
      remoteOperation
    )
    : undefined;
}

async function persistTerminalReconciliation(
  row: AmbiguousJobRow,
  claim: ReconciliationClaim,
  terminalOperation: Awaited<
    ReturnType<typeof requireTerminalRemoteOperationProof>
  >,
  detail: Record<string, unknown>
) {
  const persisted = await persistReconciliation(
    row,
    claim,
    "reconciled",
    detail,
    reconciledOutcomeFinalizer(row, terminalOperation)
  );
  if (persisted) {
    await cleanupPersistedTerminalRemoteOperation(row, terminalOperation);
  }
  return persisted;
}

export async function reconcileAmbiguousRemoteOutcomes(limit = 20) {
  const candidates = await query<AmbiguousJobRow>(
    `SELECT jobs.id,
            jobs.type,
            jobs.host_id,
            jobs.error,
            jobs.payload,
            jobs.result,
            CASE
              WHEN jobs.result IS NULL THEN true
              WHEN jsonb_typeof(jobs.result) = 'object'
                AND NOT (jobs.result ? $6::text)
                THEN true
              ELSE false
            END AS remote_mutation_proof_absent,
            jobs.attempt_count,
            jobs.completed_at,
            stacks.project_name AS stack_project_name,
            stacks.source_working_dir AS stack_working_dir,
            stacks.source_compose_path AS stack_compose_path,
            analyses.project_name AS analysis_project_name,
            analyses.working_dir AS analysis_working_dir,
            analyses.compose_path AS analysis_compose_path
     FROM operation_jobs AS jobs
     LEFT JOIN compose_stacks AS stacks
       ON stacks.id::text = jobs.payload->>'stackId'
     LEFT JOIN deployment_analyses AS analyses
       ON analyses.id::text = jobs.payload->>'analysisId'
     WHERE jobs.status = 'failed'
       AND jobs.type = ANY($4::text[])
       AND jobs.lease_owner IS NULL
       AND jobs.lease_expires_at IS NULL
       AND (
         jobs.error LIKE 'WORKER_LOST%'
         OR jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
         OR analyses.error LIKE 'WORKER_LOST:%'
         OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
       )
       AND jobs.completed_at <= now() - ($1 * interval '1 second')
       AND COALESCE(jobs.result-> $2 ->> 'status', '') <> 'reconciled'
       AND (
         jobs.result-> $2 IS NULL
         OR COALESCE(jobs.result-> $2 ->> 'status', '') NOT IN ('inspecting', 'pending')
         OR (
           jobs.result-> $2 ->> 'status' = 'inspecting'
           AND COALESCE(
             NULLIF(jobs.result-> $2 ->> 'heartbeatAt', '')::timestamptz,
             NULLIF(jobs.result-> $2 ->> 'startedAt', '')::timestamptz,
             '-infinity'::timestamptz
           ) < now() - ($5 * interval '1 second')
         )
         OR (
           jobs.result-> $2 ->> 'status' = 'pending'
           AND COALESCE(
             NULLIF(jobs.result-> $2 ->> 'nextAttemptAt', '')::timestamptz,
             '-infinity'::timestamptz
           ) <= now()
         )
       )
     ORDER BY jobs.completed_at ASC
     LIMIT $3`,
    [
      REMOTE_OUTCOME_QUIESCENCE_SECONDS,
      REMOTE_OUTCOME_RECONCILIATION_KEY,
      Math.max(1, Math.min(limit, 100)),
      REMOTE_OUTCOME_NO_DISPATCH_TYPES,
      REMOTE_OUTCOME_CLAIM_LEASE_SECONDS,
      REMOTE_MUTATION_PROOF_KEY
    ]
  );

  let reconciled = 0;
  let pending = 0;
  for (const row of candidates.rows) {
    const claim = await claimReconciliation(row);
    if (!claim) continue;
    const heartbeat = () => heartbeatReconciliation(row, claim);
    if (workerLostBeforeRemoteMutationDispatch(row)) {
      const remoteOperation = {
        source: "operation_job",
        phase: "not_dispatched",
        transport: null,
        state: "not_dispatched"
      } as const;
      try {
        const registryTrustCandidateCleanup =
          row.type === "host.configureRegistryTrust"
            ? await cleanupRegistryTrustCandidate(
                row.host_id,
                row.id,
                Number(row.attempt_count),
                heartbeat
              )
            : undefined;
        const persisted = await persistReconciliation(
          row,
          claim,
          "reconciled",
          {
            inspectedAt: new Date().toISOString(),
            remoteOperation,
            ...(registryTrustCandidateCleanup
              ? { registryTrustCandidateCleanup }
              : {}),
            note: "No durable remote-mutation dispatch proof exists for this exact failed attempt; no remote mutation was launched."
          },
          reconciledOutcomeFinalizer(row, remoteOperation),
          true
        );
        if (persisted) reconciled += 1;
      } catch (error) {
        if (error instanceof ReconciliationClaimLostError) continue;
        const persisted = await persistReconciliation(
          row,
          claim,
          "pending",
          {
            inspectedAt: new Date().toISOString(),
            error: String(
              sanitizeUrlDiagnosticText(safeErrorMessage(error))
            )
          }
        );
        if (persisted) pending += 1;
      }
      continue;
    }
    let terminalOperation: Awaited<
      ReturnType<typeof requireTerminalRemoteOperationProof>
    >;
    try {
      terminalOperation = await requireTerminalRemoteOperationProof(
        row,
        heartbeat
      );
    } catch (error) {
      if (error instanceof ReconciliationClaimLostError) continue;
      const persisted = await persistReconciliation(row, claim, "pending", {
        inspectedAt: new Date().toISOString(),
        error: String(sanitizeUrlDiagnosticText(safeErrorMessage(error)))
      });
      if (persisted) pending += 1;
      continue;
    }
    if (row.type === "deploy.analyze") {
      if (await persistTerminalReconciliation(row, claim, terminalOperation, {
        inspectedAt: new Date().toISOString(),
        remoteOperation: terminalOperation,
        note: "The isolated analysis operation is terminal; no production deployment was executed."
      })) {
        reconciled += 1;
      }
      continue;
    }
    if (row.type === "host.configureRegistryTrust") {
      let registry: string;
      try {
        registry = normalizedRegistry(row.payload?.registry);
      } catch {
        registry = "";
      }
      if (!registry) {
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: "Registry trust target metadata is incomplete and requires operator reconciliation"
        });
        if (persisted) pending += 1;
        continue;
      }
      await heartbeat();
      if (await hasActiveRegistryTrustOperation(row.id, row.host_id, registry)) {
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: "A newer registry trust operation still owns this target"
        });
        if (persisted) pending += 1;
        continue;
      }
      try {
        const inspection = await inspectRegistryTrustRemoteOutcome(
          row.host_id,
          registry,
          heartbeat
        );
        const registryTrustCandidateCleanup =
          await cleanupRegistryTrustCandidate(
            row.host_id,
            row.id,
            Number(row.attempt_count),
            heartbeat
          );
        if (await persistTerminalReconciliation(
          row,
          claim,
          terminalOperation,
          { inspection, registryTrustCandidateCleanup }
        )) {
          reconciled += 1;
        }
      } catch (error) {
        if (error instanceof ReconciliationClaimLostError) continue;
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: String(sanitizeUrlDiagnosticText(safeErrorMessage(error)))
        });
        if (persisted) pending += 1;
      }
      continue;
    }
    const target = targetForJob(row);
    const mutationScope = scopeFromRow(row);
    if (target && mutationScope) {
      await heartbeat();
      if (await hasActiveMutationForScope(row.id, mutationScope)) {
        // Never bless an old ambiguous outcome while another operation still
        // owns the same directory, Compose project, or canonical Docker target.
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: "A newer remote mutation still owns this target"
        });
        if (persisted) pending += 1;
        continue;
      }
      try {
        const inspection = await inspectRemoteOutcomeTarget(target, heartbeat);
        if (await persistTerminalReconciliation(
          row,
          claim,
          terminalOperation,
          { inspection }
        )) {
          reconciled += 1;
        }
      } catch (error) {
        if (error instanceof ReconciliationClaimLostError) continue;
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: String(sanitizeUrlDiagnosticText(safeErrorMessage(error)))
        });
        if (persisted) pending += 1;
      }
      continue;
    }
    if (mutationScope) {
      await heartbeat();
      if (await hasActiveMutationForScope(row.id, mutationScope)) {
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: "A newer remote mutation still owns this target"
        });
        if (persisted) pending += 1;
        continue;
      }
      try {
        const inspection = await inspectGenericMutation(
          row,
          mutationScope,
          heartbeat
        );
        if (await persistTerminalReconciliation(
          row,
          claim,
          terminalOperation,
          { inspection }
        )) {
          reconciled += 1;
        }
      } catch (error) {
        if (error instanceof ReconciliationClaimLostError) continue;
        const persisted = await persistReconciliation(row, claim, "pending", {
          inspectedAt: new Date().toISOString(),
          error: String(sanitizeUrlDiagnosticText(safeErrorMessage(error)))
        });
        if (persisted) pending += 1;
      }
      continue;
    }
    const persisted = await persistReconciliation(row, claim, "pending", {
      inspectedAt: new Date().toISOString(),
      error: "Remote mutation target metadata is incomplete and requires operator reconciliation"
    });
    if (persisted) pending += 1;
  }
  return { checked: candidates.rows.length, reconciled, pending };
}
