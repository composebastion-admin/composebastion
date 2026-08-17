import { v4 as uuid } from "uuid";
import { createHash } from "node:crypto";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  isDockerStatsLifecycleTombstone,
  isDockerStatsRecord,
  type DockerActionRequest,
  type DockerStatsRecord,
  type ImageCleanupCandidate,
  type ImageCleanupTarget,
  type ResourceKind,
  sanitizeUrlDiagnosticText
} from "@composebastion/shared";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";
import { buildComposeCommand, buildDockerActionCommand, dockerCommandFailureMessage, inventoryCommands, shQuote, withDockerEnv } from "./commands.js";
import {
  AgentHttpError,
  checkAgent,
  getAgentContainerUsage,
  runAgentDockerCommand,
  streamAgentContainerLogs,
  streamAgentContainerUsage
} from "./agent.js";
import {
  demoInventorySummary,
  execDemoContainer,
  executeDemoDockerAction,
  getDemoContainerLogs,
  getDemoContainerStats,
  getDemoContainerUsage,
  getDemoContainerVolumeMounts,
  isDemoHost,
  streamDemoContainerUsage
} from "./demo.js";
import { getRegistryForWorker } from "./registries.js";
import { normalizeRemotePath, parentRemotePath, statHostPath, writeHostTextFile } from "./files.js";
import { getHostForWorker, markHostChecking, markHostOffline, markHostOnline } from "./hosts.js";
import { mapResource } from "./mappers.js";
import { runSshCommand, streamSshCommandLines } from "./ssh.js";
import { readHostTextFileFromWorker, stackRemoteDirectory, writeHostStackFiles } from "./remoteFiles.js";
import { checkImageUpdatesForHost, findRegistryAuthForReference } from "./imageUpdates.js";
import { extractImagesFromCompose } from "./composeImages.js";
import { safeErrorMessage, safeLogValue } from "./operationLogs.js";
import type { JobExecutionFence } from "./jobs.js";
import {
  isRemoteMutationOutcomeUnknown,
  withRemoteMutationContext
} from "./remoteMutationProof.js";
import {
  gitComposeCheckoutCleanGuardCommands,
  inspectGitComposeSourceIntegrity,
  type GitComposeSourceIntegrity
} from "./gitComposeIntegrity.js";
import {
  deploymentEnvironmentBinding,
  parseDeploymentEnvironment,
  redactErrorSensitiveValues
} from "./deploymentEnvironment.js";
import { decryptSecret } from "./crypto.js";
import {
  linkGithubCloneDeploymentStack,
  loadGithubCloneDeploymentBindingForExecution,
  type GithubCloneDeploymentExecutionInput
} from "./githubCloneDeploymentBinding.js";
import {
  createAndPersistComposeStackDeploymentIntent,
  finalizeComposeStackDeploymentIntent
} from "./composeStackDeploymentIntent.js";
import { finalizeDeploymentExecutionInTransaction } from "./deploymentExecutionFinalization.js";

function isJobLeaseLost(error: unknown) {
  return error instanceof Error && "code" in error && (error as Error & { code?: unknown }).code === "JOB_LEASE_LOST";
}

export class DockerRemoteOutcomeUnknownError extends Error {
  readonly code = "DOCKER_REMOTE_OUTCOME_UNKNOWN";

  constructor(readonly phase: string, readonly operationId?: string) {
    super(
      `REMOTE_OUTCOME_UNKNOWN: Remote mutation '${phase}'${operationId ? ` (${operationId})` : ""} lost its authoritative completion response. `
      + "Wait for bounded quiescence and target reconciliation before retrying this resource."
    );
    this.name = "DockerRemoteOutcomeUnknownError";
  }
}

type DockerExecutionConstraints = {
  expectedComposeSha256?: string;
  expectedGitRevision?: string;
  expectedGitBranch?: string | null;
  expectedEnvironmentSha256?: string;
  environmentOverride?: string;
  persistedEnvironment?: string;
  githubCloneOperationJobId?: string;
  deploymentSourceId?: string | null;
  deploymentAnalysisId?: string;
};

function isAmbiguousRemoteTransportError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if ([
    "AGENT_REQUEST_TIMEOUT",
    "ABORT_ERR",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "ENOTCONN",
    "ERR_STREAM_PREMATURE_CLOSE"
  ].includes(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|closed without an exit status|socket hang up|connection (?:reset|closed|lost)|stream.*(?:closed|destroyed)/i.test(message);
}

async function executionCheckpoint(fence?: JobExecutionFence) {
  await fence?.assertActive();
}

async function runFencedRemoteMutation<T>(
  executionFence: JobExecutionFence | undefined,
  phase: string,
  callback: () => Promise<T>
) {
  await executionCheckpoint(executionFence);
  return withRemoteMutationContext(executionFence, phase, async () => {
    try {
      const result = await callback();
      await executionCheckpoint(executionFence);
      return result;
    } catch (error) {
      if (
        isJobLeaseLost(error)
        || error instanceof DockerRemoteOutcomeUnknownError
      ) {
        throw error;
      }
      if (isRemoteMutationOutcomeUnknown(error)) {
        throw new DockerRemoteOutcomeUnknownError(
          phase,
          error && typeof error === "object" && "operationId" in error
            ? String(error.operationId)
            : undefined
        );
      }
      if (isAmbiguousRemoteTransportError(error)) {
        throw new DockerRemoteOutcomeUnknownError(phase);
      }
      throw error;
    }
  });
}

async function withExecutionLease<T>(
  fence: JobExecutionFence | undefined,
  callback: (client: PoolClient) => Promise<T>
) {
  return fence ? fence.withActiveLease(callback) : withTransaction(callback);
}

async function executionQuery(
  fence: JobExecutionFence | undefined,
  text: string,
  values: unknown[]
) {
  if (!fence) return query(text, values);
  return fence.withActiveLease((client) => client.query(text, values));
}

function parseJsonLines(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function normalizeDockerStatsRows(value: unknown, message = "Docker returned malformed container stats") {
  if (!Array.isArray(value)) throw new Error(message);
  const rows: DockerStatsRecord[] = [];
  for (const row of value) {
    if (isDockerStatsLifecycleTombstone(row)) continue;
    if (!isDockerStatsRecord(row)) throw new Error(message);
    rows.push(row);
  }
  return rows;
}

function parseDockerStatsStreamLine(line: string) {
  const normalized = line
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
  if (!normalized) return null;
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Docker stats row must be a JSON object");
  }
  const stats = parsed as Record<string, unknown>;
  // Docker 29 emits this terminal identity row when a container disappears
  // during a continuous stats stream. It is lifecycle bookkeeping, not stats.
  if (isDockerStatsLifecycleTombstone(stats)) return null;
  if (!isDockerStatsRecord(stats)) {
    throw new Error("Docker stats row must include a container identity");
  }
  return stats;
}

function parseDockerStatsSnapshot(stdout: string) {
  const rows: DockerStatsRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const stats = parseDockerStatsStreamLine(line);
    if (stats) rows.push(stats);
  }
  return rows;
}

function normalizeImageReference(value: string) {
  return value.trim().split("@")[0] ?? "";
}

function isDanglingImageReference(repository: string, tag: string, reference: string) {
  return repository === "<none>" || tag === "<none>" || reference === "<none>" || reference === "<none>:<none>";
}

type ImageUsage = { name: string; state: string };

function appendImageUsage(map: Map<string, ImageUsage[]>, key: string, usage: ImageUsage) {
  const normalized = normalizeImageReference(key);
  if (!normalized) return;
  const current = map.get(normalized) ?? [];
  if (!current.some((item) => item.name === usage.name && item.state === usage.state)) {
    current.push(usage);
  }
  map.set(normalized, current);
}

function combineImageUsage(...groups: Array<ImageUsage[] | undefined>) {
  const seen = new Set<string>();
  const combined: ImageUsage[] = [];
  for (const group of groups) {
    for (const usage of group ?? []) {
      const key = `${usage.name}:${usage.state}`;
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(usage);
    }
  }
  return combined;
}

async function containerImageUsage(hostId: string, containers: Array<{ external_id: string; name: string; data: Record<string, unknown> }>) {
  const usageByImage = new Map<string, ImageUsage[]>();
  if (!containers.length) return usageByImage;

  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    for (const container of containers) {
      const data = container.data ?? {};
      const usage = {
        name: String(data.Names ?? container.name),
        state: String(data.State ?? "unknown")
      };
      appendImageUsage(usageByImage, String(data.Image ?? ""), usage);
    }
    return usageByImage;
  }

  const ids = containers.map((container) => String(container.external_id)).filter(Boolean);
  if (!ids.length) return usageByImage;

  try {
    const result = await runDocker(hostId, `docker inspect ${ids.map(shQuote).join(" ")}`, 60_000);
    const inspected = JSON.parse(result.stdout) as Array<Record<string, any>>;
    for (const item of inspected) {
      const usage = {
        name: String(item.Name ?? "container").replace(/^\//, ""),
        state: item.State?.Running ? "running" : String(item.State?.Status ?? "unknown")
      };
      appendImageUsage(usageByImage, String(item.Image ?? ""), usage);
      appendImageUsage(usageByImage, String(item.Config?.Image ?? ""), usage);
    }
  } catch {
    for (const container of containers) {
      const data = container.data ?? {};
      const usage = {
        name: String(data.Names ?? container.name),
        state: String(data.State ?? "unknown")
      };
      appendImageUsage(usageByImage, String(data.Image ?? ""), usage);
    }
  }

  return usageByImage;
}

function resourceIdentity(kind: ResourceKind, data: Record<string, any>) {
  if (kind === "container") return { externalId: String(data.ID), name: String(data.Names || data.Image || data.ID) };
  if (kind === "image") {
    const repository = String(data.Repository || "<none>");
    const tag = String(data.Tag || "<none>");
    const digest = String(data.Digest || "");
    return { externalId: String(data.ID || `${repository}:${tag}@${digest}`), name: `${repository}:${tag}` };
  }
  if (kind === "network") return { externalId: String(data.ID), name: String(data.Name || data.ID) };
  return { externalId: String(data.Name), name: String(data.Name) };
}

async function upsertResources(
  hostId: string,
  kind: ResourceKind,
  resources: Record<string, unknown>[],
  executionFence?: JobExecutionFence
) {
  const externalIds: string[] = [];

  await withExecutionLease(executionFence, async (client) => {
    for (const data of resources) {
      const { externalId, name } = resourceIdentity(kind, data);
      externalIds.push(externalId);
      await client.query(
        `INSERT INTO resource_snapshots (id, host_id, kind, external_id, name, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (host_id, kind, external_id)
         DO UPDATE SET name = EXCLUDED.name, data = EXCLUDED.data, updated_at = now()`,
        [uuid(), hostId, kind, externalId, name, data]
      );
    }

    if (externalIds.length > 0) {
      await client.query(
        "DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = $2 AND NOT (external_id = ANY($3::text[]))",
        [hostId, kind, externalIds]
      );
    } else {
      await client.query("DELETE FROM resource_snapshots WHERE host_id = $1 AND kind = $2", [hostId, kind]);
    }
  });
}

export async function runDocker(hostId: string, command: string, timeoutMs?: number) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    throw new Error("Demo hosts use simulated Docker operations instead of SSH commands.");
  }
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    return runAgentDockerCommand(host.agent, command, timeoutMs);
  }
  const result = await runSshCommand(host.ssh, withDockerEnv(command, host.public.dockerSocketPath), { timeoutMs });
  if (result.code !== 0) {
    throw new Error(dockerCommandFailureMessage(`${result.stderr}${result.stdout}`, `Docker command failed with exit code ${result.code}`));
  }
  return result;
}

async function runComposeInWorkingDir(
  hostId: string,
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  workingDir: string,
  composeCommand: string,
  timeoutMs: number,
  input?: string | Buffer,
  executionGuard?: string
) {
  const command = `cd ${shQuote(workingDir)} && ${composeCommand}`;
  if (host.connectionMode === "agent") {
    if (input !== undefined) {
      throw new Error("An in-memory Compose environment override requires an SSH host.");
    }
    return runDocker(hostId, command, timeoutMs);
  }
  const remoteComposeCommand = input === undefined
    ? withDockerEnv(composeCommand, host.public.dockerSocketPath)
    : (() => {
        const prefix = "docker compose";
        if (!composeCommand.startsWith(`${prefix} `)) {
          throw new Error("The isolated Compose command has an unexpected executable prefix.");
        }
        const safePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin";
        return [
          "env -i",
          `PATH=${shQuote(safePath)}`,
          "docker",
          "--host",
          shQuote(`unix://${host.public.dockerSocketPath}`),
          "--config",
          "\"$HOME/.docker\"",
          `compose${composeCommand.slice(prefix.length)}`
        ].join(" ");
      })();
  const inputGuard = input === undefined
    ? []
    : [
        'test -n "${COMPOSEBASTION_REMOTE_INPUT:-}"',
        'test ! -L "$COMPOSEBASTION_REMOTE_INPUT"',
        'test -f "$COMPOSEBASTION_REMOTE_INPUT"',
        'test "$(stat -c %u -- "$COMPOSEBASTION_REMOTE_INPUT")" = "$(id -u)"',
        'test "$(stat -c %a -- "$COMPOSEBASTION_REMOTE_INPUT")" = 600'
      ];
  const guardedCommand = [
    ...inputGuard,
    ...(executionGuard ? [executionGuard] : []),
    remoteComposeCommand
  ].join(" && ");
  const result = await runSshCommand(
    host.ssh,
    `cd ${shQuote(workingDir)} && ${guardedCommand}`,
    { timeoutMs, input }
  );
  if (result.code !== 0) {
    throw new Error(dockerCommandFailureMessage(`${result.stderr}${result.stdout}`, `Compose command failed with exit code ${result.code}`));
  }
  return result;
}

function gitComposeExecutionGuard(
  workingDir: string,
  composePath: string,
  constraints: DockerExecutionConstraints,
  sourceIntegrity: GitComposeSourceIntegrity | null
) {
  if (!constraints.expectedGitRevision) return undefined;
  if (!constraints.expectedComposeSha256) {
    throw new Error(
      "A revision-bound Git deployment is missing its Compose digest."
    );
  }
  const relativeComposePath = path.posix.relative(workingDir, composePath);
  if (
    !relativeComposePath
    || relativeComposePath === ".."
    || relativeComposePath.startsWith("../")
    || path.posix.isAbsolute(relativeComposePath)
  ) {
    throw new Error(
      "A revision-bound Git deployment must use a Compose file inside its checkout."
    );
  }
  const generatedCompose = relativeComposePath === "composebastion.generated.yaml";
  const validation = [
    'checkout_real=$(pwd -P)',
    'test -n "$checkout_real"',
    `test "$(git rev-parse --verify HEAD^{commit})" = ${shQuote(constraints.expectedGitRevision)}`,
    ...(sourceIntegrity?.referencedFiles ?? []).flatMap((relativePath) => {
      const absolutePath = path.posix.join(workingDir, relativePath);
      const tracked = generatedCompose && relativePath === relativeComposePath
        ? []
        : [`git --literal-pathspecs ls-files --error-unmatch -- ${shQuote(relativePath)} >/dev/null`];
      return [
        `test ! -L ${shQuote(absolutePath)}`,
        `test -f ${shQuote(absolutePath)}`,
        `resolved_path=$(realpath ${shQuote(absolutePath)})`,
        'case "$resolved_path" in "$checkout_real"|"$checkout_real"/*) : ;; *) false ;; esac',
        ...tracked
      ];
    }),
    ...(sourceIntegrity?.buildContexts ?? []).flatMap((relativePath) => {
      const absolutePath = relativePath === "."
        ? workingDir
        : path.posix.join(workingDir, relativePath);
      return [
        `test ! -L ${shQuote(absolutePath)}`,
        `test -d ${shQuote(absolutePath)}`,
        `resolved_path=$(realpath ${shQuote(absolutePath)})`,
        'case "$resolved_path" in "$checkout_real"|"$checkout_real"/*) : ;; *) false ;; esac'
      ];
    }),
    ...gitComposeCheckoutCleanGuardCommands(
      workingDir,
      sourceIntegrity ?? {
        composePath: relativeComposePath,
        referencedFiles: [relativeComposePath],
        buildContexts: [],
        runtimePaths: []
      },
      generatedCompose ? relativeComposePath : undefined
    ),
    `test "$(sha256sum -- ${shQuote(composePath)} | awk '{print $1}')" = ${shQuote(constraints.expectedComposeSha256)}`
  ].join(" && ");
  return [
    `if ! ( ${validation} )`,
    "then echo 'The Git deployment checkout changed after analysis. Analyze the repository again.' >&2",
    "exit 74",
    "fi"
  ].join("; ");
}

function composeRequiresBuild(composeYaml: string) {
  const parsed = parseYaml(composeYaml, { merge: true }) as {
    services?: Record<string, { build?: unknown } | null>;
  } | null;
  return Boolean(
    parsed?.services
    && Object.values(parsed.services).some((service) =>
      service && service.build !== undefined && service.build !== null
    )
  );
}

export async function checkDockerHost(hostId: string, executionFence?: JobExecutionFence) {
  await executionCheckpoint(executionFence);
  if (executionFence) {
    await executionFence.withActiveLease((client) => markHostChecking(hostId, client));
  } else {
    await markHostChecking(hostId);
  }
  try {
    const host = await getHostForWorker(hostId);
    if (isDemoHost(host.public)) {
      await executionCheckpoint(executionFence);
      if (executionFence) {
        await executionFence.withActiveLease((client) => markHostOnline(hostId, "29.4.0-demo", "5.1.1-demo", null, client));
      } else {
        await markHostOnline(hostId, "29.4.0-demo", "5.1.1-demo", null);
      }
      return { dockerVersion: "29.4.0-demo", composeVersion: "5.1.1-demo", demo: true };
    }
    if (host.connectionMode === "agent") {
      if (!host.agent) throw new Error("Agent host is missing agent connection details");
      const result = await checkAgent(host.agent);
      await executionCheckpoint(executionFence);
      if (executionFence) {
        await executionFence.withActiveLease((client) => markHostOnline(
          hostId,
          result.dockerVersion ?? "agent",
          result.composeVersion ?? "agent",
          result.agentVersion ?? null,
          client
        ));
      } else {
        await markHostOnline(hostId, result.dockerVersion ?? "agent", result.composeVersion ?? "agent", result.agentVersion ?? null);
      }
      return { dockerVersion: result.dockerVersion ?? "agent", composeVersion: result.composeVersion ?? "agent", agentVersion: result.agentVersion ?? null };
    }
    const version = await runDocker(hostId, "docker version --format '{{.Server.Version}}'", 30_000);
    await executionCheckpoint(executionFence);
    const compose = await runDocker(hostId, "docker compose version --short", 30_000);
    await executionCheckpoint(executionFence);
    if (executionFence) {
      await executionFence.withActiveLease((client) => markHostOnline(hostId, version.stdout.trim(), compose.stdout.trim(), null, client));
    } else {
      await markHostOnline(hostId, version.stdout.trim(), compose.stdout.trim(), null);
    }
    return { dockerVersion: version.stdout.trim(), composeVersion: compose.stdout.trim() };
  } catch (error) {
    if (executionFence) {
      await executionFence.withActiveLease((client) => markHostOffline(hostId, error, client));
    } else {
      await markHostOffline(hostId, error);
    }
    throw error;
  }
}

export async function syncDockerInventory(hostId: string, executionFence?: JobExecutionFence) {
  await checkDockerHost(hostId, executionFence);
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return demoInventorySummary(hostId);
  }
  const kinds: Array<[ResourceKind, string]> = [
    ["container", inventoryCommands.containers],
    ["image", inventoryCommands.images],
    ["network", inventoryCommands.networks],
    ["volume", inventoryCommands.volumes]
  ];

  const summary: Record<ResourceKind, number> = {
    container: 0,
    image: 0,
    network: 0,
    volume: 0
  };

  for (const [kind, command] of kinds) {
    await executionCheckpoint(executionFence);
    const result = await runDocker(hostId, command, 60_000);
    const resources = parseJsonLines(result.stdout);
    await upsertResources(hostId, kind, resources, executionFence);
    summary[kind] = resources.length;
  }

  await executionCheckpoint(executionFence);
  await reconcileComposeStacks(hostId, executionFence).catch((error) => {
    if (isJobLeaseLost(error)) throw error;
    console.warn("Compose stack reconcile failed", {
      hostId: safeLogValue(hostId),
      error: safeErrorMessage(error)
    });
  });

  return summary;
}

function parseContainerLabels(value: unknown): Record<string, string> {
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
  }
  if (typeof value !== "string" || !value) return {};
  const labels: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return labels;
}

function titleCaseProject(project: string) {
  return project.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()).trim() || project;
}

// Keeps compose_stacks aligned with what is actually running on the host:
// updates stack status from container states, registers compose projects that
// were deployed outside ComposeBastion as "external" stacks, and drops external
// stacks whose containers are gone.
async function reconcileComposeStacks(hostId: string, executionFence?: JobExecutionFence) {
  const containers = await query<any>(
    "SELECT data FROM resource_snapshots WHERE host_id = $1 AND kind = 'container'",
    [hostId]
  );

  type ProjectInfo = { states: string[]; workingDir: string | null; configFile: string | null };
  const projects = new Map<string, ProjectInfo>();
  for (const row of containers.rows) {
    const labels = parseContainerLabels(row.data?.Labels);
    const project = labels["com.docker.compose.project"];
    if (!project) continue;
    const entry = projects.get(project) ?? { states: [], workingDir: null, configFile: null };
    entry.states.push(String(row.data?.State ?? ""));
    if (!entry.workingDir && labels["com.docker.compose.project.working_dir"]) {
      entry.workingDir = labels["com.docker.compose.project.working_dir"];
    }
    if (!entry.configFile && labels["com.docker.compose.project.config_files"]) {
      entry.configFile = labels["com.docker.compose.project.config_files"].split(",")[0]?.trim() || null;
    }
    projects.set(project, entry);
  }

  const stacks = await query<any>(
    "SELECT id, project_name, status, source_type FROM compose_stacks WHERE host_id = $1",
    [hostId]
  );
  const stackByProject = new Map(stacks.rows.map((row) => [String(row.project_name), row]));

  for (const [project, info] of projects) {
    const anyRunning = info.states.some((state) => state.toLowerCase().includes("running") || state.toLowerCase().includes("up"));
    const liveStatus = anyRunning ? "deployed" : "stopped";
    const existing = stackByProject.get(project);

    if (existing) {
      if (existing.status !== liveStatus) {
        await executionQuery(executionFence, "UPDATE compose_stacks SET status = $2, updated_at = now() WHERE id = $1", [existing.id, liveStatus]);
      }
      continue;
    }

    let composeYaml = `# Compose project "${project}" was discovered running on this host.\n# ComposeBastion could not read its compose file${info.configFile ? ` at ${info.configFile}` : ""}.\n`;
    if (info.configFile) {
      try {
        const content = await readHostTextFileFromWorker(hostId, info.configFile);
        if (content.trim()) composeYaml = content;
      } catch {
        // Keep the placeholder; the project is still manageable via its folder.
      }
    }

    await executionQuery(
      executionFence,
      `INSERT INTO compose_stacks (
         id, host_id, name, project_name, compose_yaml, env, status,
         source_type, source_working_dir, source_compose_path
       )
       VALUES ($1, $2, $3, $4, $5, '', $6, 'external', $7, $8)
       ON CONFLICT (host_id, project_name) DO NOTHING`,
      [
        uuid(),
        hostId,
        titleCaseProject(project),
        project,
        composeYaml,
        liveStatus,
        info.workingDir,
        info.configFile
      ]
    );
  }

  for (const row of stacks.rows) {
    if (!projects.has(String(row.project_name))) {
      if (row.source_type === "external") {
        // Discovered projects with no containers left were removed outside ComposeBastion.
        await executionQuery(executionFence, "DELETE FROM compose_stacks WHERE id = $1", [row.id]);
      } else if (row.status === "deployed") {
        await executionQuery(executionFence, "UPDATE compose_stacks SET status = 'stopped', updated_at = now() WHERE id = $1", [row.id]);
      }
    }
  }
}

export async function listResources(hostId: string, kind?: ResourceKind) {
  const result = kind
    ? await query("SELECT * FROM resource_snapshots WHERE host_id = $1 AND kind = $2 ORDER BY name ASC", [hostId, kind])
    : await query("SELECT * FROM resource_snapshots WHERE host_id = $1 ORDER BY kind ASC, name ASC", [hostId]);
  return result.rows.map((row) => mapResource(row));
}

export async function listImageCleanupCandidates(hostId: string): Promise<ImageCleanupCandidate[]> {
  await syncDockerInventory(hostId);
  const [imageRows, containerRows] = await Promise.all([
    query<any>("SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = 'image' ORDER BY name ASC", [hostId]),
    query<any>("SELECT external_id, name, data FROM resource_snapshots WHERE host_id = $1 AND kind = 'container' ORDER BY name ASC", [hostId])
  ]);
  const usageByImage = await containerImageUsage(hostId, containerRows.rows);

  return imageRows.rows.map((row): ImageCleanupCandidate => {
    const data = row.data ?? {};
    const repository = String(data.Repository ?? "");
    const tag = String(data.Tag ?? "");
    const reference = repository && tag ? `${repository}:${tag}` : String(row.name ?? row.external_id);
    const imageId = String(row.external_id);
    const usedBy = combineImageUsage(
      usageByImage.get(normalizeImageReference(imageId)),
      usageByImage.get(normalizeImageReference(reference)),
      usageByImage.get(normalizeImageReference(String(row.name ?? "")))
    );
    const dangling = isDanglingImageReference(repository, tag, reference);
    const holder = usedBy.find((usage) => usage.state.toLowerCase().includes("running")) ?? usedBy[0];
    const eligible = usedBy.length === 0;
    const reason = holder
      ? `held by ${holder.state.toLowerCase().includes("running") ? "running" : "stopped"} container ${holder.name}`
      : dangling ? "dangling image layer" : "unused tagged image";

    return {
      imageId,
      reference,
      repository,
      tag,
      size: String(data.Size ?? ""),
      usedBy,
      eligible,
      reason
    };
  });
}

async function cleanupUnusedImages(
  hostId: string,
  targets: ImageCleanupTarget[],
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const candidates = await listImageCleanupCandidates(hostId);
  await executionCheckpoint(executionFence);
  const byImageId = new Map(candidates.map((candidate) => [candidate.imageId, candidate]));
  const byReference = new Map(candidates.map((candidate) => [candidate.reference, candidate]));
  const selected = targets.map((target) => byImageId.get(target.imageId) ?? (target.reference ? byReference.get(target.reference) : undefined));
  const missing = targets.filter((_, index) => !selected[index]);
  if (missing.length) {
    throw new Error(`Image cleanup refused ${missing.length} image(s) that are no longer present in inventory.`);
  }

  const blocked = selected.filter((candidate): candidate is ImageCleanupCandidate => Boolean(candidate && !candidate.eligible));
  if (blocked.length) {
    throw new Error(`Image cleanup refused ${blocked.length} image(s): ${blocked.slice(0, 3).map((candidate) => `${candidate.reference} ${candidate.reason}`).join("; ")}`);
  }

  const removed: Array<{ imageId: string; reference: string }> = [];
  for (const candidate of selected.filter((item): item is ImageCleanupCandidate => Boolean(item))) {
    const dangling = isDanglingImageReference(candidate.repository, candidate.tag, candidate.reference);
    const removeTarget = dangling ? candidate.imageId : candidate.reference;
    await runFencedRemoteMutation(
      executionFence,
      "image.cleanup.remove",
      () => runDocker(hostId, `docker image rm ${shQuote(removeTarget)}`, 5 * 60_000)
    );
    removed.push({ imageId: candidate.imageId, reference: candidate.reference });
  }
  await syncDockerInventory(hostId, executionFence);
  return { removed, count: removed.length };
}

export async function executeDockerAction(
  action: DockerActionRequest,
  executionFence?: JobExecutionFence,
  constraints: DockerExecutionConstraints = {}
) {
  const host = await getHostForWorker(action.hostId);
  if (action.type === "host.check") return checkDockerHost(action.hostId, executionFence);
  if (action.type === "host.sync") return syncDockerInventory(action.hostId, executionFence);
  if (isDemoHost(host.public)) {
    await executionCheckpoint(executionFence);
    const result = await executeDemoDockerAction(action);
    await executionCheckpoint(executionFence);
    return result;
  }
  if (action.type === "host.mkdir") {
    return createRemoteDirectory(
      action.hostId,
      action.payload.path,
      executionFence
    );
  }
  if (action.type === "git.clone") {
    return cloneGitRepository(
      action.hostId,
      action.payload.repositoryUrl,
      action.payload.directory,
      action.payload.branch,
      action.payload.shallow,
      executionFence
    );
  }
  if (action.type === "git.pull") {
    return pullGitRepository(
      action.hostId,
      action.payload.directory,
      action.payload.branch,
      executionFence
    );
  }
  if (action.type === "git.testRemote") return testGitRemoteAccess(action.hostId, action.payload.repositoryUrl, action.payload.branch);
  if (action.type === "git.cloneDeploy") {
    return cloneAndDeployRepository(
      action.hostId,
      action.payload.repositoryUrl,
      action.payload.directory,
      action.payload.projectName,
      action.payload.composePath,
      action.payload.branch,
      action.payload.repositoryId,
      action.payload.sourceCommitSha,
      action.payload.composeSha256,
      executionFence
    );
  }
  if (action.type === "compose.deployPath") {
    if (action.payload.gitPullBeforeDeploy) {
      await pullGitRepository(
        action.hostId,
        action.payload.workingDir,
        action.payload.branch,
        executionFence
      );
    }
    return deployComposeFromHostPath(
      action.hostId,
      action.payload.projectName,
      action.payload.workingDir,
      action.payload.composePath,
      {},
      executionFence,
      constraints
    );
  }
  if (action.type === "compose.writeDeployPath") {
    return writeAndDeployComposeFromHostPath(
      action.hostId,
      action.payload.projectName,
      action.payload.workingDir,
      action.payload.composePath,
      action.payload.composeYaml,
      action.payload.env,
      action.payload.overwrite,
      action.payload.pullBeforeDeploy,
      executionFence
    );
  }

  if (action.type === "compose.deploy" || action.type === "compose.stop" || action.type === "compose.remove") {
    return executeComposeAction(action, executionFence);
  }

  if (action.type === "container.clone") {
    return cloneContainer(
      action.hostId,
      action.payload.targetHostId,
      action.payload.containerId,
      action.payload.targetName,
      action.payload.start,
      executionFence
    );
  }
  if (action.type === "container.update") {
    return updateContainerToLatest(
      action.hostId,
      action.payload.containerId,
      action.payload.targetImage,
      executionFence
    );
  }
  if (action.type === "image.cleanup") {
    return cleanupUnusedImages(
      action.hostId,
      action.payload.targets,
      executionFence
    );
  }
  if (action.type === "registry.login") {
    return loginRegistry(
      action.hostId,
      action.payload.registryId,
      executionFence
    );
  }

  if (action.type === "volume.backup" || action.type === "volume.restore" || action.type === "volume.clone") {
    throw new Error(`${action.type} is handled by the backup service.`);
  }

  if (action.type === "image.pull") {
    await loginRegistryForImageIfAvailable(
      action.hostId,
      action.payload.image,
      executionFence
    );
  }
  if (action.type === "container.run") {
    await loginRegistryForImageIfAvailable(
      action.hostId,
      action.payload.image,
      executionFence
    );
  }

  const command = buildDockerActionCommand(action);
  const result = await runFencedRemoteMutation(
    executionFence,
    action.type,
    () => runDocker(action.hostId, command, 5 * 60_000)
  );
  await syncDockerInventory(action.hostId, executionFence);
  if (action.type === "image.pull") {
    await executionCheckpoint(executionFence);
    await checkImageUpdatesForHost(action.hostId).catch(() => undefined);
    await executionCheckpoint(executionFence);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function getContainerLogs(hostId: string, containerId: string, tail = 200) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return getDemoContainerLogs(hostId, containerId, tail);
  const safeTail = Math.min(Math.max(Number(tail) || 200, 1), 5000);
  const result = await runDocker(hostId, `docker logs --timestamps --tail ${safeTail} ${shQuote(containerId)}`, 60_000);
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function getContainerStats(hostId: string, containerId: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return getDemoContainerStats(hostId, containerId);
  const result = await runDocker(hostId, `docker stats --no-stream --format '{{json .}}' ${shQuote(containerId)}`, 30_000);
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
}

export async function getContainerUsage(hostId: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    return normalizeDockerStatsRows(await getDemoContainerUsage(hostId));
  }
  if (host.public.lastStatus === "offline") return [];
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    try {
      return normalizeDockerStatsRows(await getAgentContainerUsage(host.agent), "Agent returned malformed container usage data");
    } catch (error) {
      // Agents older than 1.0.7 do not expose the read-only usage endpoint. Keep
      // one low-frequency snapshot fallback during rolling upgrades.
      if (!(error instanceof AgentHttpError) || error.status !== 404) throw error;
    }
  }
  const result = await runDocker(hostId, "docker stats --no-stream --format '{{json .}}'", 60_000);
  return parseDockerStatsSnapshot(result.stdout);
}

export async function streamContainerUsage(hostId: string, onStats: (stats: Record<string, unknown>) => void, onError: (error: Error) => void) {
  const host = await getHostForWorker(hostId);
  const forwardStats = (stats: unknown) => {
    if (isDockerStatsLifecycleTombstone(stats)) return;
    if (!isDockerStatsRecord(stats)) {
      onError(new Error("Docker stats row must include a container identity"));
      return;
    }
    onStats(stats);
  };
  if (isDemoHost(host.public)) {
    return streamDemoContainerUsage(hostId, forwardStats);
  }
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    return streamAgentContainerUsage(
      host.agent,
      forwardStats,
      onError
    );
  }
  return streamSshCommandLines(
    host.ssh,
    withDockerEnv("docker stats --format '{{json .}}'", host.public.dockerSocketPath),
    (line) => {
      try {
        const stats = parseDockerStatsStreamLine(line);
        if (stats) onStats(stats);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    onError
  );
}

export type ContainerInspectDetails = {
  image: string;
  status: string;
  restartPolicy: string;
  env: string[];
  mounts: Array<{
    type: string;
    name?: string;
    source?: string;
    destination: string;
    readOnly: boolean;
  }>;
  networks: Array<{
    name: string;
    ipAddress?: string;
    aliases: string[];
  }>;
  ports: Array<{
    containerPort: string;
    protocol: string;
    hostIp?: string;
    hostPort?: string;
  }>;
  labels: Record<string, string>;
};

export const CONTAINER_INSPECT_BATCH_SIZE = 100;

export function containerInspectBatches(containerIds: string[]) {
  const uniqueIds = Array.from(new Set(containerIds.filter(Boolean)));
  const batches: string[][] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += CONTAINER_INSPECT_BATCH_SIZE) {
    batches.push(uniqueIds.slice(offset, offset + CONTAINER_INSPECT_BATCH_SIZE));
  }
  return batches;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
}

function parseInspectPorts(source: any): ContainerInspectDetails["ports"] {
  const ports = source.HostConfig?.PortBindings && Object.keys(source.HostConfig.PortBindings).length > 0
    ? source.HostConfig.PortBindings
    : source.NetworkSettings?.Ports ?? source.Config?.ExposedPorts ?? {};
  const parsed: ContainerInspectDetails["ports"] = [];
  for (const [portSpec, bindings] of Object.entries(ports)) {
    const [containerPort = portSpec, protocol = "tcp"] = String(portSpec).split("/");
    if (Array.isArray(bindings) && bindings.length > 0) {
      for (const binding of bindings as any[]) {
        parsed.push({
          containerPort,
          protocol,
          hostIp: binding?.HostIp ? String(binding.HostIp) : undefined,
          hostPort: binding?.HostPort ? String(binding.HostPort) : undefined
        });
      }
    } else {
      parsed.push({ containerPort, protocol });
    }
  }
  return parsed;
}

function parseContainerInspectSource(source: any): ContainerInspectDetails {
  if (!source) throw new Error("Container not found");
  const restartName = String(source.HostConfig?.RestartPolicy?.Name || "no");
  const retryCount = Number(source.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0);
  return {
    image: String(source.Config?.Image ?? ""),
    status: String(source.State?.Status ?? (source.State?.Running ? "running" : "unknown")),
    restartPolicy: restartName === "on-failure" && retryCount > 0 ? `${restartName}:${retryCount}` : restartName,
    env: Array.isArray(source.Config?.Env) ? source.Config.Env.map((item: unknown) => String(item)) : [],
    mounts: (Array.isArray(source.Mounts) ? source.Mounts : []).map((mount: any) => ({
      type: String(mount.Type ?? ""),
      name: mount.Name ? String(mount.Name) : undefined,
      source: mount.Source ? String(mount.Source) : undefined,
      destination: String(mount.Destination ?? ""),
      readOnly: mount.RW === false
    })),
    networks: Object.entries(source.NetworkSettings?.Networks ?? {}).map(([name, network]) => {
      const details = network as any;
      return {
        name,
        ipAddress: details.IPAddress ? String(details.IPAddress) : undefined,
        aliases: Array.isArray(details.Aliases) ? details.Aliases.map((item: unknown) => String(item)).filter(Boolean) : []
      };
    }),
    ports: parseInspectPorts(source),
    labels: stringRecord(source.Config?.Labels)
  };
}

export function parseContainerInspectJson(stdout: string): ContainerInspectDetails {
  const [source] = JSON.parse(stdout) as any[];
  return parseContainerInspectSource(source);
}

export function parseContainerInspectBatchJson(stdout: string, requestedIds: string[]) {
  const sources = JSON.parse(stdout) as any[];
  if (!Array.isArray(sources)) throw new Error("Docker returned malformed container inspection data");
  const used = new Set<number>();
  const result = new Map<string, ContainerInspectDetails>();
  for (const requestedId of requestedIds) {
    const normalizedId = requestedId.replace(/^\//, "");
    let sourceIndex = sources.findIndex((source, index) => {
      if (used.has(index)) return false;
      const sourceId = String(source?.Id ?? "");
      const sourceName = String(source?.Name ?? "").replace(/^\//, "");
      return sourceId === normalizedId || sourceId.startsWith(normalizedId) || sourceName === normalizedId;
    });
    if (sourceIndex === -1) {
      throw new Error(`Container ${requestedId} disappeared while Docker inventory was being inspected`);
    }
    used.add(sourceIndex);
    result.set(requestedId, parseContainerInspectSource(sources[sourceIndex]));
  }
  return result;
}

export function redactInspectEnv(details: ContainerInspectDetails): ContainerInspectDetails {
  return {
    ...details,
    env: details.env.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) return entry;
      return `${entry.slice(0, separator)}=<redacted>`;
    })
  };
}

async function getDemoContainerInspect(hostId: string, containerId: string): Promise<ContainerInspectDetails> {
  const result = await query<any>(
    "SELECT data FROM resource_snapshots WHERE host_id = $1 AND kind = 'container' AND external_id = $2",
    [hostId, containerId]
  );
  const data = result.rows[0]?.data;
  if (!data) throw new Error("Container not found");
  return {
    image: String(data.Image ?? ""),
    status: containerStateLabelForInspect(String(data.State ?? "")),
    restartPolicy: "unless-stopped",
    env: ["DEMO=true"],
    mounts: (Array.isArray(data.Mounts) ? data.Mounts : []).map((mount: any) => ({
      type: String(mount.Type ?? ""),
      name: mount.Name ? String(mount.Name) : undefined,
      source: mount.Source ? String(mount.Source) : undefined,
      destination: String(mount.Destination ?? ""),
      readOnly: mount.RW === false
    })),
    networks: data.Network ? [{ name: String(data.Network), aliases: [String(data.Names ?? "")].filter(Boolean) }] : [],
    ports: [],
    labels: { "composebastion.demo": "true" }
  };
}

function containerStateLabelForInspect(state: string) {
  const normalized = state.toLowerCase();
  if (normalized === "exited") return "stopped";
  return normalized || "unknown";
}

export async function getContainerInspect(hostId: string, containerId: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return getDemoContainerInspect(hostId, containerId);
  const inspect = await runDocker(hostId, `docker inspect ${shQuote(containerId)}`, 60_000);
  return parseContainerInspectJson(inspect.stdout);
}

export async function getContainerInspects(hostId: string, containerIds: string[]) {
  const batches = containerInspectBatches(containerIds);
  const uniqueIds = batches.flat();
  const result = new Map<string, ContainerInspectDetails>();
  if (!uniqueIds.length) return result;

  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    for (const containerId of uniqueIds) {
      result.set(containerId, await getDemoContainerInspect(hostId, containerId));
    }
    return result;
  }

  for (const batch of batches) {
    const inspect = await runDocker(hostId, `docker inspect ${batch.map(shQuote).join(" ")}`, 60_000);
    for (const [containerId, details] of parseContainerInspectBatchJson(inspect.stdout, batch)) {
      result.set(containerId, details);
    }
  }
  return result;
}

export async function streamContainerLogs(hostId: string, containerId: string, tail: number, onLine: (line: string) => void, onError: (error: Error) => void) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) {
    const result = await getDemoContainerLogs(hostId, containerId, tail);
    const lines = result.stdout.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) onLine(line);
    return () => undefined;
  }
  if (host.connectionMode === "agent") {
    if (!host.agent) throw new Error("Agent host is missing agent connection details");
    return streamAgentContainerLogs(host.agent, containerId, tail, onLine, onError);
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Live log following currently requires SSH or agent host mode.");
  }
  const safeTail = Math.min(Math.max(Number(tail) || 500, 1), 5000);
  return streamSshCommandLines(
    host.ssh,
    withDockerEnv(`docker logs -f --tail ${safeTail} ${shQuote(containerId)}`, host.public.dockerSocketPath),
    onLine,
    onError,
    { preserveLineFormatting: true }
  );
}

export async function getContainerVolumeMounts(hostId: string, containerId: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return getDemoContainerVolumeMounts(hostId, containerId);
  const inspect = await runDocker(hostId, `docker inspect ${shQuote(containerId)}`, 60_000);
  const [container] = JSON.parse(inspect.stdout) as any[];
  if (!container) throw new Error("Container not found");
  return (container.Mounts ?? [])
    .filter((mount: any) => mount.Type === "volume" && mount.Name)
    .map((mount: any) => ({
      name: String(mount.Name),
      destination: String(mount.Destination ?? ""),
      readOnly: mount.RW === false
    }));
}

export async function execInContainer(hostId: string, containerId: string, command: string) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return execDemoContainer(hostId, containerId, command);
  const result = await runDocker(hostId, `docker exec ${shQuote(containerId)} sh -lc ${shQuote(command)}`, 120_000);
  return { stdout: result.stdout, stderr: result.stderr };
}

type RegistryLoginCredentials = {
  url: string;
  username: string | null;
  password: string | null;
};

async function loginRegistryCredentials(
  hostId: string,
  registry: RegistryLoginCredentials,
  executionFence?: JobExecutionFence
) {
  if (!registry.username || !registry.password) throw new Error("Registry username and password are required for login");
  const host = await getHostForWorker(hostId);
  const loginCommand = `docker login ${shQuote(registry.url)} --username ${shQuote(registry.username)} --password-stdin`;
  const result = await runFencedRemoteMutation(
    executionFence,
    "registry.login",
    async () => {
      if (host.connectionMode === "agent") {
        // Compatible agents parse this exact legacy pipe into execFile stdin;
        // the password never becomes a Docker process argument.
        return runDocker(
          hostId,
          `printf %s ${shQuote(registry.password!)} | ${loginCommand}`,
          120_000
        );
      }
      const sshResult = await runSshCommand(
        host.ssh,
        withDockerEnv(loginCommand, host.public.dockerSocketPath),
        {
          input: registry.password!,
          timeoutMs: 120_000
        }
      );
      if (sshResult.code !== 0) {
        throw new Error(dockerCommandFailureMessage(
          `${sshResult.stderr}${sshResult.stdout}`,
          `Docker login failed with exit code ${sshResult.code}`
        ));
      }
      return sshResult;
    }
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

async function loginRegistry(
  hostId: string,
  registryId: string,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const registry = await getRegistryForWorker(registryId);
  await executionCheckpoint(executionFence);
  return loginRegistryCredentials(hostId, registry, executionFence);
}

async function loginRegistryForImageIfAvailable(
  hostId: string,
  image: string,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const registry = await findRegistryAuthForReference(image);
  await executionCheckpoint(executionFence);
  if (!registry?.username || !registry.password) return false;
  await loginRegistryCredentials(hostId, registry, executionFence);
  return true;
}

async function loginRegistriesForComposeImages(
  hostId: string,
  composeYaml: string,
  environment: string,
  executionFence?: JobExecutionFence
) {
  const images = extractImagesFromCompose(composeYaml, environment);
  for (const image of images) {
    await loginRegistryForImageIfAvailable(hostId, image, executionFence);
  }
}

async function cloneContainer(
  sourceHostId: string,
  targetHostId: string,
  containerId: string,
  targetName?: string,
  start = false,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const inspect = await runDocker(sourceHostId, `docker inspect ${shQuote(containerId)}`, 60_000);
  await executionCheckpoint(executionFence);
  const [source] = JSON.parse(inspect.stdout) as any[];
  if (!source) throw new Error("Source container not found");
  const image = String(source.Config?.Image ?? "");
  if (!image) throw new Error("Source container has no image");

  await loginRegistryForImageIfAvailable(targetHostId, image, executionFence);
  await runFencedRemoteMutation(
    executionFence,
    "container.clone.pull",
    () => runDocker(targetHostId, `docker pull ${shQuote(image)}`, 10 * 60_000)
  );
  const args = [start ? "docker run -d" : "docker create"];
  args.push("--name", shQuote(targetName || `${String(source.Name ?? "container").replace(/^\//, "")}-clone`));
  for (const env of source.Config?.Env ?? []) args.push("--env", shQuote(String(env)));
  const restart = source.HostConfig?.RestartPolicy?.Name;
  if (restart && restart !== "no") args.push("--restart", shQuote(String(restart)));
  const ports = source.HostConfig?.PortBindings && Object.keys(source.HostConfig.PortBindings).length > 0
    ? source.HostConfig.PortBindings
    : source.NetworkSettings?.Ports ?? {};
  for (const [containerPort, bindings] of Object.entries(ports)) {
    const first = Array.isArray(bindings) ? bindings[0] as any : null;
    if (first?.HostPort) args.push("--publish", shQuote(`${first.HostPort}:${containerPort}`));
  }
  for (const mount of source.Mounts ?? []) {
    if (mount.Type === "volume" && mount.Name && mount.Destination) {
      args.push("--volume", shQuote(`${mount.Name}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`));
    }
  }
  args.push(shQuote(image));
  const result = await runFencedRemoteMutation(
    executionFence,
    "container.clone.create",
    () => runDocker(targetHostId, args.join(" "), 5 * 60_000)
  );
  await syncDockerInventory(targetHostId, executionFence);
  return { stdout: result.stdout, stderr: result.stderr, image };
}

function dockerValueList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value) return [value];
  return [];
}

function buildRunFromInspect(source: any, name: string, start: boolean, imageOverride?: string) {
  const args = [start ? "docker run -d" : "docker create"];
  args.push("--name", shQuote(name));

  const config = source.Config ?? {};
  const hostConfig = source.HostConfig ?? {};
  if (config.User) args.push("--user", shQuote(String(config.User)));
  if (config.WorkingDir) args.push("--workdir", shQuote(String(config.WorkingDir)));
  if (hostConfig.Privileged) args.push("--privileged");

  for (const env of config.Env ?? []) args.push("--env", shQuote(String(env)));
  for (const [key, value] of Object.entries(config.Labels ?? {})) args.push("--label", shQuote(`${key}=${String(value)}`));

  const restart = hostConfig.RestartPolicy?.Name;
  if (restart && restart !== "no") {
    const retryCount = Number(hostConfig.RestartPolicy?.MaximumRetryCount ?? 0);
    args.push("--restart", shQuote(restart === "on-failure" && retryCount > 0 ? `${restart}:${retryCount}` : String(restart)));
  }

  // HostConfig.PortBindings is the configured truth and survives stops, unlike
  // NetworkSettings.Ports, which is empty for stopped containers. A running
  // container also lists one entry per address family (0.0.0.0 and ::) for the
  // same published port, so bindings must be deduplicated or the new container
  // tries to bind the same host port twice and fails with "address in use".
  const ports = source.HostConfig?.PortBindings && Object.keys(source.HostConfig.PortBindings).length > 0
    ? source.HostConfig.PortBindings
    : source.NetworkSettings?.Ports ?? {};
  const seenPublishes = new Set<string>();
  for (const [containerPort, bindings] of Object.entries(ports)) {
    for (const binding of Array.isArray(bindings) ? bindings as any[] : []) {
      if (!binding?.HostPort) continue;
      const hostIp = binding.HostIp && !["0.0.0.0", "::", ""].includes(String(binding.HostIp)) ? `${binding.HostIp}:` : "";
      const publish = `${hostIp}${binding.HostPort}:${containerPort}`;
      if (seenPublishes.has(publish)) continue;
      seenPublishes.add(publish);
      args.push("--publish", shQuote(publish));
    }
  }

  for (const mount of source.Mounts ?? []) {
    if (mount.Type === "volume" && mount.Name && mount.Destination) {
      args.push("--volume", shQuote(`${mount.Name}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`));
    } else if (mount.Type === "bind" && mount.Source && mount.Destination) {
      args.push("--volume", shQuote(`${mount.Source}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`));
    } else if (mount.Type === "tmpfs" && mount.Destination) {
      args.push("--tmpfs", shQuote(String(mount.Destination)));
    }
  }

  const networkNames = Object.keys(source.NetworkSettings?.Networks ?? {}).filter((network) => network !== "none");
  if (networkNames[0]) args.push("--network", shQuote(networkNames[0]));

  const entrypoint = dockerValueList(config.Entrypoint);
  if (entrypoint.length > 0) args.push("--entrypoint", shQuote(entrypoint.join(" ")));

  args.push(shQuote(imageOverride || String(config.Image)));
  args.push(...dockerValueList(config.Cmd).map(shQuote));
  return { command: args.join(" "), extraNetworks: networkNames.slice(1) };
}

function isTransientPortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /address already in use|port is already allocated|bind for .* failed/i.test(message);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Engines release host port forwards asynchronously after a container stops, so
// an immediate restart of the same binding can transiently fail.
async function startContainerWithRetry(
  hostId: string,
  name: string,
  attempts = 4,
  executionFence?: JobExecutionFence
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await runFencedRemoteMutation(
        executionFence,
        "container.update.start",
        () => runDocker(hostId, `docker start ${shQuote(name)}`, 5 * 60_000)
      );
    } catch (error) {
      lastError = error;
      if (!isTransientPortError(error) || attempt === attempts - 1) throw error;
      await delay(2_000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function updateContainerToLatest(
  hostId: string,
  containerId: string,
  targetImage?: string,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const inspect = await runDocker(hostId, `docker inspect ${shQuote(containerId)}`, 60_000);
  await executionCheckpoint(executionFence);
  const [source] = JSON.parse(inspect.stdout) as any[];
  if (!source) throw new Error("Container not found");

  const image = targetImage || String(source.Config?.Image ?? "");
  const name = String(source.Name ?? "container").replace(/^\//, "");
  if (!image || !name) throw new Error("Container inspect data is missing image or name");

  const wasRunning = Boolean(source.State?.Running);
  const previousName = `${name}-previous-${Date.now()}`;
  let renamed = false;

  await loginRegistryForImageIfAvailable(hostId, image, executionFence);
  await runFencedRemoteMutation(
    executionFence,
    "container.update.pull",
    () => runDocker(hostId, `docker pull ${shQuote(image)}`, 10 * 60_000)
  );

  try {
    if (wasRunning) {
      await runFencedRemoteMutation(
        executionFence,
        "container.update.stop",
        () => runDocker(hostId, `docker stop ${shQuote(containerId)}`, 5 * 60_000)
      );
    }
    await runFencedRemoteMutation(
      executionFence,
      "container.update.rename_previous",
      () => runDocker(hostId, `docker rename ${shQuote(containerId)} ${shQuote(previousName)}`, 60_000)
    );
    renamed = true;

    // Create the replacement and only start it once configuration succeeded. The
    // old container is kept (stopped, renamed) until the new one is running so a
    // failure at any point can still roll back to the previous state.
    const run = buildRunFromInspect(source, name, false, image);
    const created = await runFencedRemoteMutation(
      executionFence,
      "container.update.create",
      () => runDocker(hostId, run.command, 5 * 60_000)
    );
    for (const network of run.extraNetworks) {
      await runFencedRemoteMutation(
        executionFence,
        "container.update.network_connect",
        () => runDocker(hostId, `docker network connect ${shQuote(network)} ${shQuote(name)}`, 60_000)
      );
    }
    if (wasRunning) {
      await startContainerWithRetry(
        hostId,
        name,
        4,
        executionFence
      );
    }
    await runFencedRemoteMutation(
      executionFence,
      "container.update.remove_previous",
      () => runDocker(hostId, `docker rm ${shQuote(previousName)}`, 120_000)
    );
    await syncDockerInventory(hostId, executionFence);
    await executionCheckpoint(executionFence);
    await checkImageUpdatesForHost(hostId).catch(() => undefined);
    await executionCheckpoint(executionFence);
    return { stdout: created.stdout, stderr: created.stderr, image, previousName };
  } catch (error) {
    if (
      isJobLeaseLost(error)
      || error instanceof DockerRemoteOutcomeUnknownError
    ) {
      throw error;
    }
    let compensationFailed = false;
    await runFencedRemoteMutation(
      executionFence,
      "container.update.compensate_remove_replacement",
      () => runDocker(hostId, `docker rm --force ${shQuote(name)}`, 60_000)
    ).catch((compensationError) => {
      if (!/no such container/i.test(safeErrorMessage(compensationError))) {
        compensationFailed = true;
      }
    });
    if (renamed) {
      await runFencedRemoteMutation(
        executionFence,
        "container.update.compensate_restore_name",
        () => runDocker(hostId, `docker rename ${shQuote(previousName)} ${shQuote(name)}`, 60_000)
      ).catch(() => {
        compensationFailed = true;
      });
      if (wasRunning) {
        await startContainerWithRetry(
          hostId,
          name,
          4,
          executionFence
        ).catch(() => {
          compensationFailed = true;
        });
      }
    }
    await syncDockerInventory(hostId, executionFence).catch(() => {
      compensationFailed = true;
    });
    if (compensationFailed) {
      throw new DockerRemoteOutcomeUnknownError(
        "container.update.compensation"
      );
    }
    throw error;
  }
}

async function createRemoteDirectory(
  hostId: string,
  directory: string,
  executionFence?: JobExecutionFence
) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Folder creation currently requires SSH host mode.");
  const normalized = normalizeRemotePath(directory);
  const result = await runFencedRemoteMutation(
    executionFence,
    "host.mkdir",
    () => runSshCommand(
      host.ssh,
      `mkdir -p ${shQuote(normalized)}`,
      { timeoutMs: 30_000 }
    )
  );
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Failed to create directory");
  return { path: normalized };
}

async function cloneGitRepository(
  hostId: string,
  repositoryUrl: string,
  directory: string,
  branch?: string,
  shallow = true,
  executionFence?: JobExecutionFence
) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Repository clone currently requires SSH host mode.");
  const target = normalizeRemotePath(directory);
  const parent = parentRemotePath(target);
  const args = ["git clone"];
  if (shallow) args.push("--depth", "1");
  if (branch) args.push("--branch", shQuote(branch));
  args.push(shQuote(repositoryUrl), shQuote(target));
  const command = `mkdir -p ${shQuote(parent)} && test ! -e ${shQuote(target)} && ${args.join(" ")}`;
  const result = await runFencedRemoteMutation(
    executionFence,
    "git.clone",
    () => runSshCommand(
      host.ssh,
      command,
      { timeoutMs: 10 * 60_000 }
    )
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to clone repository. Check the URL, branch, host SSH keys, and whether the target folder already exists.");
  }
  return { path: target, stdout: result.stdout, stderr: result.stderr };
}

async function readHostGitMetadata(hostId: string, directory: string, branchOverride?: string, fetchRemote = false) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") return null;
  const target = normalizeRemotePath(directory);
  const branchAssignment = branchOverride ? `branch=${shQuote(branchOverride)}` : "branch=$(git rev-parse --abbrev-ref HEAD)";
  const remoteCheck = fetchRemote
    ? [
        "git fetch --quiet --tags origin",
        'latest=$(git rev-parse "origin/$branch" 2>/dev/null || git rev-list -n 1 "refs/tags/$branch" 2>/dev/null || true)',
        'test -n "$latest"'
      ]
    : ['latest=$(git rev-parse "origin/$branch" 2>/dev/null || git rev-list -n 1 "refs/tags/$branch" 2>/dev/null || true)'];
  const command = [
    `cd ${shQuote(target)}`,
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1",
    "current=$(git rev-parse HEAD)",
    branchAssignment,
    "remote=$(git remote get-url origin 2>/dev/null || true)",
    ...remoteCheck,
    `printf '{"currentCommit":"%s","latestCommit":"%s","branch":"%s","repositoryUrl":"%s"}' "$current" "$latest" "$branch" "$remote"`
  ].join(" && ");
  const result = await runSshCommand(host.ssh, command, { timeoutMs: fetchRemote ? 5 * 60_000 : 30_000 });
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return JSON.parse(result.stdout.trim()) as {
    currentCommit: string;
    latestCommit: string;
    branch: string;
    repositoryUrl: string;
  };
}

async function refreshStackSourceMetadata(
  hostId: string,
  stackId: string,
  workingDir: string,
  branch?: string | null,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const metadata = await readHostGitMetadata(hostId, workingDir, branch ?? undefined, false).catch(() => null);
  await executionCheckpoint(executionFence);
  if (!metadata) return;
  await executionQuery(
    executionFence,
    `UPDATE compose_stacks
     SET source_repository_url = COALESCE($3, source_repository_url),
         source_branch = COALESCE($4, source_branch),
         source_current_commit_sha = $5,
         source_latest_commit_sha = COALESCE(NULLIF($6, ''), source_latest_commit_sha, $5),
         source_checked_at = now(),
         source_check_error = null,
         updated_at = now()
     WHERE id = $1 AND host_id = $2`,
    [
      stackId,
      hostId,
      metadata.repositoryUrl || null,
      metadata.branch || branch || null,
      metadata.currentCommit || null,
      metadata.latestCommit || null
    ]
  );
}

async function checkoutTrackedCloneRevision(
  hostId: string,
  target: string,
  binding: GithubCloneDeploymentExecutionInput,
  executionFence: JobExecutionFence
) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") {
    throw new Error("Tracked clone checkout requires SSH host mode.");
  }
  const checkoutGuard = gitComposeCheckoutCleanGuardCommands(
    target,
    binding.sourceIntegrity
  );
  const script = [
    "set -e",
    `test ! -L ${shQuote(target)}`,
    `cd ${shQuote(target)}`,
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1",
    ...checkoutGuard,
    "git fetch --quiet --tags origin",
    [
      `if ! git cat-file -e ${shQuote(`${binding.sourceCommitSha}^{commit}`)} 2>/dev/null`,
      `then git fetch --quiet --depth=1 origin ${shQuote(binding.sourceCommitSha)} || true`,
      "fi"
    ].join("; "),
    [
      `if ! git cat-file -e ${shQuote(`${binding.sourceCommitSha}^{commit}`)} 2>/dev/null`,
      `then git fetch --quiet origin ${shQuote(binding.sourceBranch)} || true`,
      "fi"
    ].join("; "),
    `git cat-file -e ${shQuote(`${binding.sourceCommitSha}^{commit}`)}`,
    `git checkout --quiet --detach ${shQuote(binding.sourceCommitSha)}`,
    `test "$(git rev-parse --verify HEAD^{commit})" = ${shQuote(binding.sourceCommitSha)}`,
    ...checkoutGuard
  ].join("\n");
  const checkedOut = await runFencedRemoteMutation(
    executionFence,
    "git.cloneDeploy.checkout",
    () => runSshCommand(
      host.ssh,
      `sh -c ${shQuote(script)}`,
      { timeoutMs: 10 * 60_000 }
    )
  );
  if (checkedOut.code !== 0) {
    throw new Error(
      checkedOut.stderr
      || checkedOut.stdout
      || "The tracked clone could not be pinned to its queued Git revision."
    );
  }
}

async function cloneAndDeployRepository(
  hostId: string,
  repositoryUrl: string,
  directory: string,
  projectName: string,
  composePath: string,
  branch?: string,
  repositoryId?: string,
  sourceCommitSha?: string,
  composeSha256?: string,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Clone and deploy currently requires SSH host mode.");
  let trackedBinding: GithubCloneDeploymentExecutionInput | null = null;
  if (repositoryId) {
    if (!executionFence?.jobId) {
      throw new Error(
        "A tracked clone deployment requires a durable job execution fence."
      );
    }
    trackedBinding = await executionFence.withActiveLease((client) =>
      loadGithubCloneDeploymentBindingForExecution(
        client,
        executionFence.jobId!,
        {
          repositoryId,
          hostId,
          repositoryUrl,
          directory,
          branch,
          composePath,
          projectName,
          sourceCommitSha,
          composeSha256
        }
      )
    );
  }
  const cloneRepositoryUrl =
    trackedBinding?.cloneRepositoryUrl ?? repositoryUrl;
  const target = trackedBinding?.workingDir ?? normalizeRemotePath(directory);
  const selectedBranch = trackedBinding?.sourceBranch ?? branch;
  const selectedComposePath =
    trackedBinding?.sourceComposePath ?? composePath;
  const selectedProjectName = trackedBinding?.projectName ?? projectName;

  try {
    await executionCheckpoint(executionFence);
    await testGitRemoteAccess(
      hostId,
      cloneRepositoryUrl,
      trackedBinding ? undefined : selectedBranch
    );
    await executionCheckpoint(executionFence);
    const existing = await runSshCommand(host.ssh, `test -d ${shQuote(`${target}/.git`)} && echo yes || echo no`, { timeoutMs: 30_000 });
    await executionCheckpoint(executionFence);
    if (existing.stdout.trim() === "yes") {
      await executionCheckpoint(executionFence);
      const remoteResult = await runFencedRemoteMutation(
          executionFence,
          "git.cloneDeploy.configure_origin",
          () => runSshCommand(
            host.ssh,
          `cd ${shQuote(target)} && (git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${shQuote(cloneRepositoryUrl)} || git remote add origin ${shQuote(cloneRepositoryUrl)})`,
            { timeoutMs: 30_000 }
          )
        );
      if (remoteResult.code !== 0) {
        throw new Error(remoteResult.stderr || remoteResult.stdout || "Failed to update repository origin before pulling.");
      }
      await executionCheckpoint(executionFence);
      if (trackedBinding && executionFence) {
        await checkoutTrackedCloneRevision(
          hostId,
          target,
          trackedBinding,
          executionFence
        );
      } else {
        await pullGitRepository(
          hostId,
          target,
          selectedBranch,
          executionFence
        );
      }
      await executionCheckpoint(executionFence);
    } else {
      await executionCheckpoint(executionFence);
      await cloneGitRepository(
        hostId,
        cloneRepositoryUrl,
        target,
        trackedBinding ? undefined : selectedBranch,
        false,
        executionFence
      );
      await executionCheckpoint(executionFence);
      if (trackedBinding && executionFence) {
        await checkoutTrackedCloneRevision(
          hostId,
          target,
          trackedBinding,
          executionFence
        );
        await executionCheckpoint(executionFence);
      }
    }

    await executionCheckpoint(executionFence);
    const deployed = await deployComposeFromHostPath(
      hostId,
      selectedProjectName,
      target,
      selectedComposePath,
      {},
      executionFence,
      trackedBinding
        ? {
          expectedComposeSha256: trackedBinding.composeSha256,
          expectedGitRevision: trackedBinding.sourceCommitSha,
          expectedGitBranch: trackedBinding.sourceBranch,
          expectedEnvironmentSha256: trackedBinding.environmentBinding,
          environmentOverride: trackedBinding.environment,
          persistedEnvironment: trackedBinding.environment,
          githubCloneOperationJobId: executionFence?.jobId
        }
        : {}
    );
    await executionCheckpoint(executionFence);
    const metadata = await readHostGitMetadata(
      hostId,
      target,
      selectedBranch,
      false
    ).catch(() => null);
    await executionCheckpoint(executionFence);
    return {
      ...deployed,
      repositoryUrl: cloneRepositoryUrl,
      branch: trackedBinding?.sourceBranch
        ?? metadata?.branch
        ?? selectedBranch
        ?? null,
      currentCommitSha: trackedBinding?.sourceCommitSha
        ?? metadata?.currentCommit
        ?? null,
      latestCommitSha: metadata?.latestCommit
        ?? trackedBinding?.sourceCommitSha
        ?? null,
      sourceCommitSha: trackedBinding?.sourceCommitSha ?? null,
      composeSha256: trackedBinding?.composeSha256 ?? null
    };
  } catch (error) {
    if (repositoryId && !isJobLeaseLost(error)) {
      const message = String(sanitizeUrlDiagnosticText(safeErrorMessage(error)));
      await executionQuery(
        executionFence,
        "UPDATE github_repositories SET last_error = $2, updated_at = now() WHERE id = $1",
        [repositoryId, message]
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function pullGitRepository(
  hostId: string,
  directory: string,
  branchOverride?: string,
  executionFence?: JobExecutionFence
) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Repository pull currently requires SSH host mode.");
  const target = normalizeRemotePath(directory);
  const branchAssignment = branchOverride ? `branch=${shQuote(branchOverride)}` : "branch=$(git rev-parse --abbrev-ref HEAD)";
  const command = [
    `cd ${shQuote(target)}`,
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1",
    branchAssignment,
    "git fetch --quiet --tags origin",
    'if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then if git show-ref --verify --quiet "refs/heads/$branch"; then git checkout "$branch"; else git checkout -b "$branch" "origin/$branch"; fi && git pull --ff-only origin "$branch"; elif git rev-parse --verify --quiet "refs/tags/$branch" >/dev/null; then git checkout --detach "refs/tags/$branch"; else echo "Git ref not found: $branch" >&2; exit 1; fi'
  ].join(" && ");
  const result = await runFencedRemoteMutation(
    executionFence,
    "git.pull",
    () => runSshCommand(
      host.ssh,
      command,
      { timeoutMs: 10 * 60_000 }
    )
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to pull repository. Resolve local changes or branch divergence on the host.");
  }
  await executionCheckpoint(executionFence);
  const metadata = await readHostGitMetadata(
    hostId,
    target,
    branchOverride,
    false
  ).catch(() => null);
  await executionCheckpoint(executionFence);
  return { path: target, stdout: result.stdout, stderr: result.stderr, ...metadata };
}

async function testGitRemoteAccess(hostId: string, repositoryUrl: string, branch?: string) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Git remote access checks currently require SSH host mode.");
  const ref = branch?.trim();
  const command = ref
    ? `GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code --heads --tags ${shQuote(repositoryUrl)} ${shQuote(ref)}`
    : `GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code ${shQuote(repositoryUrl)} HEAD`;
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 60_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${detail || "Host could not access this repository."} For private GitHub clones, add a read-only deploy key to the repository and use the host's SSH URL or SSH alias.`
    );
  }
  const refs = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);
  return { repositoryUrl, branch: ref || null, refs };
}

async function writeAndDeployComposeFromHostPath(
  hostId: string,
  projectName: string,
  workingDir: string,
  composePath: string,
  composeYaml: string,
  env: string | undefined,
  overwrite: boolean,
  pullBeforeDeploy: boolean,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const cwd = normalizeRemotePath(workingDir);
  const file = composePath.startsWith("/") ? normalizeRemotePath(composePath) : normalizeRemotePath(path.posix.join(cwd, composePath));
  const envPath = path.posix.join(cwd, ".env");
  if (!overwrite) {
    const composeStat = await statHostPath(hostId, file);
    await executionCheckpoint(executionFence);
    if (composeStat.exists) throw new Error(`${file} already exists. Confirm overwrite before replacing it.`);
    if (env !== undefined) {
      const envStat = await statHostPath(hostId, envPath);
      await executionCheckpoint(executionFence);
      if (envStat.exists) throw new Error(`${envPath} already exists. Confirm overwrite before replacing it.`);
    }
  }

  await runFencedRemoteMutation(
    executionFence,
    "compose.writeDeployPath.write_compose",
    () => writeHostTextFile(hostId, file, composeYaml)
  );
  if (env !== undefined) {
    await runFencedRemoteMutation(
      executionFence,
      "compose.writeDeployPath.write_env",
      () => writeHostTextFile(hostId, envPath, env)
    );
  }
  return deployComposeFromHostPath(
    hostId,
    projectName,
    cwd,
    file,
    { pullBeforeDeploy },
    executionFence
  );
}

async function deployComposeFromHostPath(
  hostId: string,
  projectName: string,
  workingDir: string,
  composePath: string,
  options: { pullBeforeDeploy?: boolean } = {},
  executionFence?: JobExecutionFence,
  constraints: DockerExecutionConstraints = {}
) {
  await executionCheckpoint(executionFence);
  const host = await getHostForWorker(hostId);
  const cwd = normalizeRemotePath(workingDir);
  const file = composePath.startsWith("/") ? normalizeRemotePath(composePath) : normalizeRemotePath(path.posix.join(cwd, composePath));
  const composeYaml = await readHostTextFileFromWorker(hostId, file);
  await executionCheckpoint(executionFence);
  if (constraints.expectedComposeSha256) {
    const actualComposeSha256 = createHash("sha256")
      .update(composeYaml, "utf8")
      .digest("hex");
    if (actualComposeSha256 !== constraints.expectedComposeSha256) {
      throw new Error(
        "The host Compose file changed after analysis. Analyze the repository again."
      );
    }
  }
  const hasEnvironmentOverride = constraints.environmentOverride !== undefined;
  if (hasEnvironmentOverride) {
    if (!constraints.expectedEnvironmentSha256) {
      throw new Error("The deployment environment override is missing its durable digest.");
    }
    const actualEnvironmentSha256 = deploymentEnvironmentBinding(
      constraints.environmentOverride ?? ""
    );
    if (actualEnvironmentSha256 !== constraints.expectedEnvironmentSha256) {
      throw new Error(
        "The deployment environment changed after it was queued. Analyze the source again."
      );
    }
    if (host.connectionMode !== "ssh") {
      throw new Error("An in-memory Compose environment override requires an SSH host.");
    }
    if (!executionFence) {
      throw new Error(
        "The deployment environment override requires a durable job execution fence."
      );
    }
  }
  let env = constraints.persistedEnvironment ?? "";
  if (!hasEnvironmentOverride) {
    try {
      env = await readHostTextFileFromWorker(hostId, path.posix.join(cwd, ".env"));
    } catch {
      env = "";
    }
  }
  await executionCheckpoint(executionFence);
  const gitMetadata = host.connectionMode === "ssh"
    ? await readHostGitMetadata(
        hostId,
        cwd,
        constraints.expectedGitBranch ?? undefined,
        false
      ).catch(() => null)
    : null;
  await executionCheckpoint(executionFence);
  if (
    constraints.expectedGitRevision
    && gitMetadata?.currentCommit !== constraints.expectedGitRevision
  ) {
    throw new Error(
      "The host Git checkout changed after analysis. Analyze the repository again."
    );
  }
  const sourceType = gitMetadata?.repositoryUrl ? "git" : "host_files";
  const relativeComposePath = path.posix.relative(cwd, file);
  const sourceIntegrity = constraints.expectedGitRevision
    ? inspectGitComposeSourceIntegrity(composeYaml, relativeComposePath)
    : null;
  const buildBeforeUp = composeRequiresBuild(composeYaml);
  const executionGuard = gitComposeExecutionGuard(
    cwd,
    file,
    constraints,
    sourceIntegrity
  );
  const boundSourceEnvironment = constraints.expectedGitRevision
    ? constraints.environmentOverride ?? ""
    : null;
  const intentJobId = executionFence?.jobId ?? uuid();
  const intentAttemptCount = executionFence?.attemptCount ?? 1;
  const stackName = projectName.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  const stackIntent = await createAndPersistComposeStackDeploymentIntent({
    jobId: intentJobId,
    attemptCount: intentAttemptCount,
    hostId,
    projectName,
    name: stackName,
    composeYaml,
    env,
    source: {
      type: sourceType,
      repositoryUrl: gitMetadata?.repositoryUrl || null,
      branch: gitMetadata?.branch || null,
      workingDir: cwd,
      composePath: file,
      currentCommitSha: gitMetadata?.currentCommit || null,
      latestCommitSha:
        gitMetadata?.latestCommit || gitMetadata?.currentCommit || null,
      environment: boundSourceEnvironment,
      deploymentSourceId: constraints.deploymentSourceId ?? null
    },
    version: {
      source: "host_files",
      note: `Deploy from ${file}`,
      createdBy: null
    },
    githubCloneOperationJobId:
      constraints.githubCloneOperationJobId ?? null
  }, executionFence);

  await executionCheckpoint(executionFence);
  await loginRegistriesForComposeImages(
    hostId,
    composeYaml,
    hasEnvironmentOverride ? constraints.environmentOverride ?? "" : env,
    executionFence
  );
  if (options.pullBeforeDeploy) {
    await runFencedRemoteMutation(
      executionFence,
      "compose.deployPath.pull",
      () => runComposeInWorkingDir(
        hostId,
        host,
        cwd,
        buildComposeCommand(
          projectName,
          file,
          "pull",
          false,
          hasEnvironmentOverride
            ? { environmentVariable: "COMPOSEBASTION_REMOTE_INPUT" }
            : undefined
        ),
        10 * 60_000,
        constraints.environmentOverride,
        executionGuard
      )
    );
  }
  const result = await runFencedRemoteMutation(
    executionFence,
    "compose.deployPath.up",
    () => runComposeInWorkingDir(
      hostId,
      host,
      cwd,
      buildComposeCommand(
        projectName,
        file,
        "up",
        false,
        hasEnvironmentOverride
          ? { environmentVariable: "COMPOSEBASTION_REMOTE_INPUT" }
          : undefined,
        buildBeforeUp
      ),
      10 * 60_000,
      constraints.environmentOverride,
      executionGuard
    )
  );

  // Materialize the encrypted intent only after the exact fenced Compose-up
  // primitive completed. If the lease is lost here, reconciliation can replay
  // this same transaction from the terminal proof without duplicating versions.
  try {
    const finalizedStack = await withExecutionLease(
      executionFence,
      async (client) => {
        const finalized = await finalizeComposeStackDeploymentIntent(
          client,
          stackIntent
        );
        if (constraints.githubCloneOperationJobId) {
          await linkGithubCloneDeploymentStack(
            client,
            constraints.githubCloneOperationJobId,
            finalized.stackId
          );
        }
        const deploymentFinalization = constraints.deploymentAnalysisId
          ? await finalizeDeploymentExecutionInTransaction(
              client,
              constraints.deploymentAnalysisId,
              finalized.stackId
            )
          : null;
        return { ...finalized, deploymentFinalization };
      }
    );
    const stackId = finalizedStack.stackId;
    // Keep a fenced intent until completeJob atomically replaces the running
    // job result. If the lease is lost after this commit, reconciliation still
    // has authenticated replay material. Unfenced calls never persisted it.
    if (gitMetadata?.repositoryUrl) {
      await refreshStackSourceMetadata(
        hostId,
        stackId,
        cwd,
        gitMetadata.branch ?? null,
        executionFence
      );
    }
    await syncDockerInventory(hostId, executionFence);
    await executionCheckpoint(executionFence);
    await checkImageUpdatesForHost(hostId).catch(() => undefined);
    await executionCheckpoint(executionFence);
    return {
      stackId,
      workingDir: cwd,
      composePath: file,
      stdout: result.stdout,
      stderr: result.stderr,
      deploymentFinalization: finalizedStack.deploymentFinalization
    };
  } catch (error) {
    if (error instanceof DockerRemoteOutcomeUnknownError) throw error;
    throw new DockerRemoteOutcomeUnknownError("compose.deployPath.up");
  }
}

async function executeComposeAction(
  action: Extract<DockerActionRequest, { type: "compose.deploy" | "compose.stop" | "compose.remove" }>,
  executionFence?: JobExecutionFence
) {
  await executionCheckpoint(executionFence);
  const stackResult = await query<any>(
    "SELECT * FROM compose_stacks WHERE id = $1 AND host_id = $2",
    [action.payload.stackId, action.hostId]
  );
  const stack = stackResult.rows[0];
  if (!stack) throw new Error("Compose stack not found");

  const host = await getHostForWorker(action.hostId);
  await executionCheckpoint(executionFence);

  // Stacks that live in a real folder on the host (git clones, folder deploys,
  // discovered external projects) must run compose from that folder so relative
  // build contexts, env files, and bind mounts keep working. Stacks created in
  // the UI or from the GitHub API have no folder and use a managed copy instead.
  let cwd: string;
  let composeFile: string;
  let sourceEnvironment: string | undefined;
  let sourceExecutionGuard: string | undefined;
  if (stack.source_working_dir && stack.source_compose_path) {
    cwd = normalizeRemotePath(String(stack.source_working_dir));
    composeFile = String(stack.source_compose_path).startsWith("/")
      ? normalizeRemotePath(String(stack.source_compose_path))
      : normalizeRemotePath(path.posix.join(cwd, String(stack.source_compose_path)));
    if (stack.source_type === "git") {
      if (!executionFence) {
        throw new Error(
          "A source-backed Git Compose lifecycle action requires a durable job execution fence."
        );
      }
      const binding = String(stack.source_environment_binding ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(binding)) {
        throw new Error(
          "The Git-backed Compose stack has no durable environment binding. Deploy it again from My Library."
        );
      }
      sourceEnvironment = stack.source_environment_encrypted
        ? decryptSecret(String(stack.source_environment_encrypted))
        : "";
      if (deploymentEnvironmentBinding(sourceEnvironment) !== binding) {
        throw new Error(
          "The Git-backed Compose stack environment no longer matches its durable binding. Deploy it again from My Library."
        );
      }
      const revision = String(stack.source_current_commit_sha ?? "").toLowerCase();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
        throw new Error(
          "The Git-backed Compose stack is missing its pinned source revision. Deploy it again from My Library."
        );
      }
      const integrity = inspectGitComposeSourceIntegrity(
        String(stack.compose_yaml),
        path.posix.relative(cwd, composeFile)
      );
      sourceExecutionGuard = gitComposeExecutionGuard(
        cwd,
        composeFile,
        {
          expectedGitRevision: revision,
          expectedComposeSha256: createHash("sha256")
            .update(String(stack.compose_yaml), "utf8")
            .digest("hex")
        },
        integrity
      );
    }
  } else {
    cwd = stackRemoteDirectory(stack.id);
    const written = await runFencedRemoteMutation(
      executionFence,
      "compose.stack.write_files",
      () => writeHostStackFiles(
        action.hostId,
        cwd,
        stack.compose_yaml,
        stack.env ?? ""
      )
    );
    composeFile = written.composePath;
  }

  const composeAction = action.type === "compose.deploy" ? "up" : action.type === "compose.stop" ? "stop" : "down";
  const command = buildComposeCommand(
    stack.project_name,
    composeFile,
    composeAction,
    action.type === "compose.remove" ? action.payload.removeVolumes : false,
    sourceEnvironment !== undefined
      ? { environmentVariable: "COMPOSEBASTION_REMOTE_INPUT" }
      : undefined,
    action.type === "compose.deploy" && composeRequiresBuild(stack.compose_yaml)
  );
  const sensitiveFailureValues = sourceEnvironment === undefined
    ? []
    : [...parseDeploymentEnvironment(sourceEnvironment).values()].filter(Boolean);

  let result: { stdout: string; stderr: string };
  try {
    if (action.type === "compose.deploy") {
      await executionCheckpoint(executionFence);
      await loginRegistriesForComposeImages(
        action.hostId,
        stack.compose_yaml,
        sourceEnvironment ?? stack.env ?? "",
        executionFence
      );
      if (action.payload.pullBeforeDeploy) {
        await runFencedRemoteMutation(
          executionFence,
          "compose.deploy.pull",
          () => runComposeInWorkingDir(
            action.hostId,
            host,
            cwd,
            buildComposeCommand(
              stack.project_name,
              composeFile,
              "pull",
              false,
              sourceEnvironment !== undefined
                ? { environmentVariable: "COMPOSEBASTION_REMOTE_INPUT" }
                : undefined
            ),
            10 * 60_000,
            sourceEnvironment,
            sourceExecutionGuard
          )
        );
      }
    }
    result = await runFencedRemoteMutation(
      executionFence,
      action.type,
      () => runComposeInWorkingDir(
        action.hostId,
        host,
        cwd,
        command,
        10 * 60_000,
        sourceEnvironment,
        sourceExecutionGuard
      )
    );
  } catch (error) {
    if (isJobLeaseLost(error)) throw error;
    const redactedError = redactErrorSensitiveValues(
      error,
      sensitiveFailureValues
    );
    redactedError.message = String(
      sanitizeUrlDiagnosticText(safeErrorMessage(redactedError))
    );
    const message = redactedError.message;
    await executionQuery(
      executionFence,
      "UPDATE compose_stacks SET last_deploy_error = $2, updated_at = now() WHERE id = $1",
      [stack.id, message]
    );
    throw redactedError;
  }

  await executionQuery(
    executionFence,
    "UPDATE compose_stacks SET status = $2, last_deploy_error = null, updated_at = now() WHERE id = $1",
    [
      stack.id,
      action.type === "compose.deploy" ? "deployed" : action.type === "compose.stop" ? "stopped" : "removed"
    ]
  );
  if (action.type === "compose.deploy" && stack.source_working_dir) {
    await refreshStackSourceMetadata(
      action.hostId,
      stack.id,
      cwd,
      stack.source_branch ?? null,
      executionFence
    );
  }
  await syncDockerInventory(action.hostId, executionFence);
  await executionCheckpoint(executionFence);
  if (action.type === "compose.deploy") {
    await checkImageUpdatesForHost(action.hostId).catch(() => undefined);
    await executionCheckpoint(executionFence);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
