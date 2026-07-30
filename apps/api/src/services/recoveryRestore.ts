import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RecoveryArtifact, RecoveryPointDetail, RecoveryRestoreRequest } from "@composebastion/shared";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";
import { getHostForWorker } from "./hosts.js";
import { isDemoHost } from "./demo.js";
import { runAgentDockerCommandResult } from "./agent.js";
import { buildComposeCommand, shQuote, withDockerEnv } from "./commands.js";
import { pipeFileToSshCommand, runSshCommand } from "./ssh.js";
import { writeHostStackFiles } from "./remoteFiles.js";
import { readRecoveryArtifact, withRecoveryArtifactLocalPath } from "./recoveryArtifactStore.js";
import type { RecoveryManifest } from "./recoveryManifest.js";
import type { JobExecutionFence } from "./jobs.js";
import {
  beginRecoveryRestoreAttempt,
  markRecoveryRestoreAttemptAwaitingDisposition,
  markRecoveryRestoreAttemptCleaned,
  markRecoveryRestoreAttemptCleanupPending,
  markRecoveryRestoreAttemptRetained,
  markRecoveryRestoreResourceObserved,
  recoveryRestoreAttemptCleanupIsDeferred,
  registerRecoveryRestoreResource
} from "./recoveryRestoreAttempts.js";
import {
  buildRecoveryNetworkMap,
  buildRecoveryRestorePlan,
  getRecoveryPointForRestore,
  loadRecoveryManifest,
  type RecoveryRestorePlan
} from "./recoveryRestorePlan.js";
import {
  assertAllowedRestoreRoot,
  buildComposeProjectVolumeName,
  buildBindMountRestoreCommand,
  buildCloneContainerName,
  buildCloneRestoreProjectName,
  buildCloneVolumeName,
  buildComposeServiceBindMounts,
  composeVolumeNameFromEngineName,
  buildPortRemap,
  buildStandaloneContainerCreateCommand,
  buildStandaloneNetworkConnectCommand,
  buildStandaloneContainerStartCommand,
  detectPortConflicts,
  extractPublishedPorts,
  remapComposeYaml,
  assertAllowedHostFolderTargetPath,
  resolveRestoredBindMountPath,
  resolveHostFolderRestorePath,
  standaloneContainerExtraNetworks
} from "./recoveryRestoreUtils.js";
import {
  buildAcquireOwnedRemoteDirectoryCommand,
  buildCleanupOwnedRemoteDirectoryCommand
} from "./remoteOwnedDirectory.js";
import {
  isRemoteMutationOutcomeUnknown,
  withRemoteMutationContext
} from "./remoteMutationProof.js";

const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);
const RESTORE_ATTEMPT_LABEL = "com.composebastion.recovery.restore-attempt";
const RESTORE_SCOPE_LABEL = "com.composebastion.recovery.restore-scope";

export type RestoreResult = {
  mode: "clone" | "in_place";
  projectName: string | null;
  restoredVolumes: number;
  restoredBindMounts: number;
  composeRestored: boolean;
  standaloneContainersRestored: number;
  restoredContainerNames: string[];
  volumeMap: Record<string, string>;
  bindMap: Record<string, string>;
  portRemap: Record<string, string>;
  networkMap: Record<string, string>;
  demo?: boolean;
  stdout?: string;
  stderr?: string;
};

export type RecoveryRestoreCleanup = {
  cleanup: () => Promise<void>;
  retain: () => Promise<void>;
  retainForReconciliation: () => Promise<void>;
};

export type RecoveryRestoreExecutionContext = {
  operationJobId?: string | null;
  migrationRunId?: string | null;
  retainOnSuccess?: boolean;
  beforeRemoteMutation?: (
    attemptToken: string
  ) => Promise<void> | void;
};

export class RecoveryRestoreCleanupRequiredError extends Error {
  readonly code = "RECOVERY_RESTORE_CLEANUP_REQUIRED";

  constructor(
    message: string,
    readonly cleanup: RecoveryRestoreCleanup,
    readonly remoteOutcomeUnknown: boolean,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "RecoveryRestoreCleanupRequiredError";
  }
}

class RecoveryRestoreRemoteOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      "A recovery restore remote mutation may still be running; exact-resource cleanup is deferred until bounded quiescence.",
      { cause }
    );
    this.name = "RecoveryRestoreRemoteOutcomeUnknownError";
  }
}

type RestoreRemoteMutation = <T>(
  phase: string,
  mutation: () => Promise<T>
) => Promise<T>;

type RecoveryRestoreDrillContainerExpectation = {
  restoredName: string | null;
  composeService: string | null;
  originallyRunning: boolean;
};

type RecoveryRestoreDrillExpectations = {
  containers: RecoveryRestoreDrillContainerExpectation[];
  requiredVolumeNames: string[];
  requiredBindPaths: string[];
  requiredNetworkNames: string[];
};

export type RecoveryRestoreWithCleanupResult = {
  restore: RestoreResult;
  cleanup: RecoveryRestoreCleanup;
  drillExpectations: RecoveryRestoreDrillExpectations;
};

async function restoreVolumeArtifact(
  targetHostId: string,
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  targetVolumeName: string,
  restoreAttemptToken: string,
  restoreScope: string,
  executionFence?: JobExecutionFence,
  onMutationIntent?: (volumeName: string) => void,
  onCreated?: (volumeName: string) => void,
  mutate: RestoreRemoteMutation = (_phase, mutation) => mutation()
) {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) {
    return { demo: true, targetVolumeName };
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery volume restore currently requires SSH host mode.");
  }
  return withRecoveryArtifactLocalPath(point, artifact, async (sourcePath) => {
    const ownershipFormat = `{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`;
    const inspectOwnershipCommand = withDockerEnv(
      `docker volume inspect --format ${shQuote(ownershipFormat)} ${shQuote(targetVolumeName)}`,
      host.public.dockerSocketPath
    );
    const inspect = await runSshCommand(
      host.ssh,
      inspectOwnershipCommand,
      { timeoutMs: 60_000 }
    );
    if (inspect.code === 0) {
      const existingOwnership = inspect.stdout.trim();
      const sameScope = existingOwnership.endsWith(`|${restoreScope}`);
      throw new Error(
        sameScope
          ? `Recovery volume ${targetVolumeName} belongs to another attempt in this recovery scope; refusing to adopt or replace it without authoritative proof that its owner is inactive.`
          : `Recovery volume ${targetVolumeName} already exists; refusing to merge restored data into an existing volume.`
      );
    }
    onMutationIntent?.(targetVolumeName);
    const createResult = await mutate(
      "recovery.restore.volume.create",
      () =>
      runSshCommand(
        host.ssh,
        withDockerEnv(
          [
            "docker volume create",
            `--label ${shQuote(`${RESTORE_ATTEMPT_LABEL}=${restoreAttemptToken}`)}`,
            `--label ${shQuote(`${RESTORE_SCOPE_LABEL}=${restoreScope}`)}`,
            shQuote(targetVolumeName)
          ].join(" "),
          host.public.dockerSocketPath
        ),
        { timeoutMs: 60_000 }
      )
    );
    if (createResult.code !== 0) {
      throw new Error(createResult.stderr || createResult.stdout || `Failed to create recovery volume ${targetVolumeName}`);
    }

    // Register compensation as soon as Docker reports creation. The ownership
    // guard inside cleanup makes this safe even if a concurrent creator won,
    // while still cleaning our resource when the follow-up inspect itself
    // fails or times out.
    onCreated?.(targetVolumeName);
    const ownership = await runSshCommand(host.ssh, inspectOwnershipCommand, { timeoutMs: 60_000 });
    await executionFence?.assertActive();
    const expectedOwnership = `${restoreAttemptToken}|${restoreScope}`;
    if (ownership.code !== 0) {
      throw new Error(
        commandFailure(ownership, `Failed to verify ownership of recovery volume ${targetVolumeName} after creation`)
      );
    }
    if (ownership.stdout.trim() !== expectedOwnership) {
      throw new Error(
        `Recovery volume ${targetVolumeName} was concurrently created or replaced by another owner; refusing to restore into, claim, or remove it.`
      );
    }

    const restoreCommand = withDockerEnv(
      `docker run --rm -i -v ${shQuote(`${targetVolumeName}:/volume`)} alpine:3.20 sh -c ${shQuote("cd /volume && tar xzf -")}`,
      host.public.dockerSocketPath
    );
    const result = await mutate(
      "recovery.restore.volume.extract",
      () =>
      pipeFileToSshCommand(
        host.ssh,
        sourcePath,
        restoreCommand
      )
    );
    await executionFence?.assertActive();
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Recovery volume restore failed");
    return { stdout: result.stdout, stderr: result.stderr };
  });
}

async function restoreBindMountArtifact(
  targetHostId: string,
  point: RecoveryPointDetail,
  artifact: RecoveryArtifact,
  targetPath: string,
  executionFence?: JobExecutionFence,
  mutate: RestoreRemoteMutation = (_phase, mutation) => mutation()
) {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) {
    return { demo: true, targetPath };
  }
  if (host.connectionMode !== "ssh") {
    throw new Error("Recovery bind mount restore currently requires SSH host mode.");
  }
  return withRecoveryArtifactLocalPath(point, artifact, async (sourcePath) => {
    const restoreCommand = buildBindMountRestoreCommand(targetPath);
    const result = await mutate(
      "recovery.restore.bind.extract",
      () =>
      pipeFileToSshCommand(
        host.ssh,
        sourcePath,
        restoreCommand
      )
    );
    await executionFence?.assertActive();
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Recovery bind mount restore failed");
    return { stdout: result.stdout, stderr: result.stderr };
  });
}

function isPathInside(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent.replace(/\/+$/, "")}/`);
}

type RestoreCleanupAction = {
  cleanup: () => Promise<string[]>;
  completed: boolean;
};

function createRestoreCompensation() {
  const actions: RestoreCleanupAction[] = [];
  const ownedDirectoryTrees: string[] = [];
  let rollbackPromise: Promise<string[]> | null = null;

  const performRollback = async () => {
    const failures: string[] = [];
    for (const action of [...actions].reverse()) {
      if (action.completed) continue;
      try {
        const actionFailures = await action.cleanup();
        if (actionFailures.length) {
          failures.push(...actionFailures);
        } else {
          action.completed = true;
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    return failures;
  };

  return {
    track(cleanup: RestoreCleanupAction["cleanup"]) {
      actions.push({ cleanup, completed: false });
    },
    trackOwnedDirectoryTree(targetPath: string, cleanup: RestoreCleanupAction["cleanup"]) {
      ownedDirectoryTrees.push(path.posix.normalize(targetPath));
      actions.push({ cleanup, completed: false });
    },
    ownsPath(targetPath: string) {
      const normalized = path.posix.normalize(targetPath);
      return ownedDirectoryTrees.some((directory) => isPathInside(directory, normalized));
    },
    rollback() {
      rollbackPromise ??= performRollback().finally(() => {
        rollbackPromise = null;
      });
      return rollbackPromise;
    }
  };
}

function createRecoveryRestoreCleanup(
  compensation: ReturnType<typeof createRestoreCompensation>,
  durableAttempt: {
    attemptToken: string;
    executionFence?: JobExecutionFence;
  } | null
): RecoveryRestoreCleanup {
  let cleaned = false;
  let retained = false;
  return {
    async cleanup() {
      if (cleaned) return;
      if (retained) {
        throw new Error(
          "A retained restore attempt cannot be cleaned automatically"
        );
      }
      if (
        durableAttempt
        && await recoveryRestoreAttemptCleanupIsDeferred(
          durableAttempt.attemptToken
        )
      ) {
        throw new Error(
          "Recovery restore cleanup is deferred until the last remote mutation is quiescent"
        );
      }
      const failures = await compensation.rollback();
      if (failures.length) {
        if (durableAttempt) {
          await markRecoveryRestoreAttemptCleanupPending(
            durableAttempt.attemptToken,
            failures.join("; ")
          ).catch(() => undefined);
        }
        throw new Error(
          `Failed to clean up completed clone restore: ${
            failures.join("; ")
          }`
        );
      }
      if (durableAttempt) {
        await markRecoveryRestoreAttemptCleaned(
          durableAttempt.attemptToken,
          durableAttempt.executionFence
        );
      }
      cleaned = true;
    },
    async retain() {
      if (retained) return;
      if (cleaned) {
        throw new Error("A cleaned restore attempt cannot be retained");
      }
      if (durableAttempt) {
        await markRecoveryRestoreAttemptRetained(
          durableAttempt.attemptToken,
          durableAttempt.executionFence
        );
      }
      retained = true;
    },
    async retainForReconciliation() {
      if (retained) return;
      if (cleaned) {
        throw new Error("A cleaned restore attempt cannot be retained");
      }
      if (durableAttempt) {
        // This unfenced transition is intentionally narrower than retain():
        // callers may use it only after the target has been fully verified and
        // the migration completion write has an ambiguous outcome. Retention is
        // the fail-safe direction because automated cleanup could otherwise
        // destroy a successfully migrated target.
        await markRecoveryRestoreAttemptRetained(
          durableAttempt.attemptToken
        );
      }
      retained = true;
    }
  };
}

function completedRestore(
  restore: RestoreResult,
  compensation: ReturnType<typeof createRestoreCompensation>,
  drillExpectations: RecoveryRestoreDrillExpectations,
  durableAttempt: {
    attemptToken: string;
    executionFence?: JobExecutionFence;
  } | null
): RecoveryRestoreWithCleanupResult {
  return {
    restore,
    drillExpectations,
    cleanup: createRecoveryRestoreCleanup(
      compensation,
      durableAttempt
    )
  };
}

type WorkerHost = Awaited<ReturnType<typeof getHostForWorker>>;

async function runRestoreHostDockerCommand(
  host: WorkerHost,
  command: string,
  timeoutMs = 60_000
) {
  if (host.connectionMode === "agent") {
    if (!host.agent) {
      throw new Error(
        "Agent host is missing agent connection details"
      );
    }
    return runAgentDockerCommandResult(
      host.agent,
      command,
      timeoutMs
    );
  }
  return runSshCommand(
    host.ssh,
    withDockerEnv(
      command,
      host.public.dockerSocketPath
    ),
    { timeoutMs }
  );
}

function commandFailure(result: { stdout: string; stderr: string }, fallback: string) {
  return result.stderr || result.stdout || fallback;
}

function isAlreadyMissingOutput(value: string) {
  return /(?:no such (?:container|network|volume|file)|not found|does not exist)/i.test(value);
}

async function cleanupSshCommand(
  host: WorkerHost,
  command: string,
  label: string,
  options: { missingIsSuccess?: boolean } = {}
) {
  const result = await runSshCommand(host.ssh, command, { timeoutMs: 60_000 });
  if (
    result.code === 0
    || (options.missingIsSuccess && isAlreadyMissingOutput(`${result.stderr}\n${result.stdout}`))
  ) {
    return [];
  }
  return [`${label}: ${commandFailure(result, "cleanup failed")}`];
}

type RestoreOwnership = {
  attemptToken: string;
  scope: string;
};

function restoreOwnershipValue(ownership: RestoreOwnership) {
  return `${ownership.attemptToken}|${ownership.scope}`;
}

async function acquireOwnedRemoteDirectory(
  host: WorkerHost,
  targetPath: string,
  ownership: RestoreOwnership,
  label: string,
  mutate: RestoreRemoteMutation = (_phase, mutation) => mutation()
) {
  const command = buildAcquireOwnedRemoteDirectoryCommand({
    targetPath,
    ownerValue: restoreOwnershipValue(ownership),
    attemptToken: ownership.attemptToken,
    label
  });
  const result = await mutate(
    "recovery.restore.directory.acquire",
    () =>
    runSshCommand(
      host.ssh,
      command,
      { timeoutMs: 60_000 }
    )
  );
  if (result.code !== 0) {
    throw new Error(
      `${commandFailure(result, `Failed to acquire ${label}`)}; refusing to adopt, overwrite, or remove a path owned by another attempt.`
    );
  }
}

async function cleanupOwnedRemoteDirectory(
  host: WorkerHost,
  targetPath: string,
  ownership: RestoreOwnership,
  label: string
) {
  const command = buildCleanupOwnedRemoteDirectoryCommand({
    targetPath,
    ownerValue: restoreOwnershipValue(ownership),
    attemptToken: ownership.attemptToken,
    label
  });
  return cleanupSshCommand(host, command, label);
}

type OwnedDockerResourceKind = "container" | "network" | "volume";

function ownedDockerResourceInspectCommand(
  kind: OwnedDockerResourceKind,
  resourceName: string
) {
  const ownershipFormat = `{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`;
  return `docker ${kind} inspect --format ${shQuote(ownershipFormat)} ${shQuote(resourceName)}`;
}

function ownedDockerResourceBoundaryInspectCommand(
  kind: OwnedDockerResourceKind,
  resourceReference: string
) {
  const identityField = kind === "volume" ? ".Name" : ".Id";
  const format =
    `{{${identityField}}}|{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`;
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

async function verifyOwnedDockerResource(
  host: WorkerHost,
  kind: OwnedDockerResourceKind,
  resourceName: string,
  ownership: RestoreOwnership,
  context: string
) {
  const result = await runRestoreHostDockerCommand(
    host,
    ownedDockerResourceInspectCommand(kind, resourceName)
  );
  if (result.code !== 0) {
    throw new Error(commandFailure(result, `Failed to verify ownership of ${context}`));
  }
  if (result.stdout.trim() !== restoreOwnershipValue(ownership)) {
    throw new Error(
      `${context} was concurrently created or replaced by another owner; refusing to claim, use, or remove it.`
    );
  }
}

async function cleanupOwnedDockerResource(
  host: WorkerHost,
  kind: OwnedDockerResourceKind,
  resourceName: string,
  ownership: RestoreOwnership
) {
  const inspectCommand =
    ownedDockerResourceBoundaryInspectCommand(kind, resourceName);
  const removeAction = kind === "container"
    ? "docker rm --force"
    : kind === "network"
      ? "docker network rm"
      : "docker volume rm --force";
  const requestedRemoveEvidence =
    `${removeAction} ${shQuote(resourceName)}`;
  const expectedOwnership = restoreOwnershipValue(ownership);

  if (host.connectionMode === "agent") {
    const inspected = await runRestoreHostDockerCommand(
      host,
      inspectCommand
    );
    if (
      inspected.code !== 0
      && isAlreadyMissingOutput(
        `${inspected.stderr}\n${inspected.stdout}`
      )
    ) {
      return [];
    }
    if (inspected.code !== 0) {
      return [
        `${kind} ${resourceName}: ${commandFailure(
          inspected,
          "ownership inspection failed"
        )}`
      ];
    }
    const captured = parseOwnedDockerResourceBoundary(
      inspected.stdout.trim()
    );
    if (
      !captured?.id
      || captured.ownership !== expectedOwnership
    ) {
      return [
        `${kind} ${resourceName}: ownership labels do not match this restore attempt; refusing cleanup`
      ];
    }
    const boundary = await runRestoreHostDockerCommand(
      host,
      ownedDockerResourceBoundaryInspectCommand(
        kind,
        captured.id
      )
    );
    if (
      boundary.code !== 0
      && isAlreadyMissingOutput(
        `${boundary.stderr}\n${boundary.stdout}`
      )
    ) {
      return [];
    }
    if (
      boundary.code !== 0
      || boundary.stdout.trim() !== inspected.stdout.trim()
    ) {
      return [
        `${kind} ${resourceName}: immutable identity or ownership changed before cleanup; refusing cleanup`
      ];
    }
    const removed = await runRestoreHostDockerCommand(
      host,
      `${removeAction} ${shQuote(captured.id)}`
    );
    if (
      removed.code === 0
      || isAlreadyMissingOutput(
        `${removed.stderr}\n${removed.stdout}`
      )
    ) {
      return [];
    }
    return [
      `${kind} ${resourceName}: ${commandFailure(
        removed,
        "cleanup failed"
      )}`
    ];
  }

  const inspectByName = withDockerEnv(
    inspectCommand,
    host.public.dockerSocketPath
  );
  const inspectById = kind === "volume"
    ? `docker volume inspect --format ${shQuote(
        `{{.Name}}|{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`
      )} "$restore_id"`
    : `docker ${kind} inspect --format ${shQuote(
        `{{.Id}}|{{ index .Labels "${RESTORE_ATTEMPT_LABEL}" }}|{{ index .Labels "${RESTORE_SCOPE_LABEL}" }}`
      )} "$restore_id"`;
  const boundaryInspect = withDockerEnv(
    inspectById,
    host.public.dockerSocketPath
  );
  const removeCommand = withDockerEnv(
    `${removeAction} "$restore_id"`,
    host.public.dockerSocketPath
  );
  const command = [
    `restore_identity="$(${inspectByName} 2>/dev/null)" || { ${withDockerEnv(
      `docker ${kind} inspect ${shQuote(resourceName)}`,
      host.public.dockerSocketPath
    )} >/dev/null 2>&1 || exit 0; exit 72; }`,
    `restore_id="\${restore_identity%%|*}"`,
    `restore_owner="\${restore_identity#*|}"`,
    [
      `if [ -z "$restore_id" ] || [ "$restore_owner" != ${shQuote(expectedOwnership)} ]`,
      `then printf '%s\\n' ${shQuote(`${kind} ${resourceName} ownership labels do not match this restore attempt; refusing cleanup`)} >&2`,
      "exit 73",
      "fi"
    ].join("; "),
    `restore_boundary="$(${boundaryInspect} 2>/dev/null)" || { ${withDockerEnv(
      `docker ${kind} inspect "$restore_id"`,
      host.public.dockerSocketPath
    )} >/dev/null 2>&1 || exit 0; exit 72; }`,
    [
      `if [ "$restore_boundary" != "$restore_identity" ]`,
      `then printf '%s\\n' ${shQuote(`${kind} ${resourceName} immutable identity or ownership changed before cleanup; refusing cleanup`)} >&2`,
      "exit 73",
      "fi"
    ].join("; "),
    removeCommand,
    `\n# requested cleanup boundary: ${requestedRemoveEvidence}`
  ].join("; ");
  return cleanupSshCommand(host, command, `${kind} ${resourceName}`, { missingIsSuccess: true });
}

function outputNames(stdout: string) {
  return [...new Set(stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

type ComposeProjectResources = {
  containers: string[];
  networks: string[];
  volumes: string[];
};

async function listComposeProjectResources(host: WorkerHost, projectName: string): Promise<ComposeProjectResources> {
  const filter = shQuote(`label=com.docker.compose.project=${projectName}`);
  const commands = {
    containers:
      `docker ps --all --filter ${filter} --format '{{.Names}}'`,
    networks:
      `docker network ls --filter ${filter} --format '{{.Name}}'`,
    volumes:
      `docker volume ls --filter ${filter} --format '{{.Name}}'`
  };
  const resources: ComposeProjectResources = { containers: [], networks: [], volumes: [] };
  for (const kind of ["containers", "networks", "volumes"] as const) {
    const result = await runRestoreHostDockerCommand(
      host,
      commands[kind]
    );
    if (result.code !== 0) {
      throw new Error(commandFailure(result, `Failed to inspect existing Compose ${kind}`));
    }
    resources[kind] = outputNames(result.stdout);
  }
  return resources;
}

async function assertComposeProjectIsUnused(host: WorkerHost, projectName: string) {
  const resources = await listComposeProjectResources(host, projectName);
  const existing = [
    ...resources.containers.map((name) => `container:${name}`),
    ...resources.networks.map((name) => `network:${name}`),
    ...resources.volumes.map((name) => `volume:${name}`)
  ];
  if (existing.length) {
    throw new Error(
      `Clone restore project ${projectName} already has Docker resources; refusing to replace them (${existing.join(", ")}).`
    );
  }
}

async function cleanupComposeProjectResources(
  host: WorkerHost,
  projectName: string,
  ownership: RestoreOwnership,
  ownedResources?: ComposeProjectResources
) {
  const failures: string[] = [];
  let resources = ownedResources;
  if (!resources) {
    try {
      resources = await listComposeProjectResources(host, projectName);
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  }
  const cleanupGroups = [
    {
      kind: "container" as const,
      names: resources.containers
    },
    {
      kind: "network" as const,
      names: resources.networks
    },
    {
      kind: "volume" as const,
      names: resources.volumes
    }
  ];
  for (const group of cleanupGroups) {
    for (const name of [...group.names].reverse()) {
      failures.push(...await cleanupOwnedDockerResource(host, group.kind, name, ownership));
    }
  }
  return failures;
}

async function verifyComposeProjectResourcesOwned(
  host: WorkerHost,
  resources: ComposeProjectResources,
  ownership: RestoreOwnership
) {
  for (const group of [
    { kind: "container" as const, names: resources.containers },
    { kind: "network" as const, names: resources.networks },
    { kind: "volume" as const, names: resources.volumes }
  ]) {
    for (const name of group.names) {
      await verifyOwnedDockerResource(
        host,
        group.kind,
        name,
        ownership,
        `Compose ${group.kind} ${name}`
      );
    }
  }
}

async function trackCreatedStackFiles(
  host: WorkerHost,
  files: { remoteDir: string; composePath: string; envPath: string },
  compensation: ReturnType<typeof createRestoreCompensation>,
  ownership: RestoreOwnership,
  mutate: RestoreRemoteMutation = (_phase, mutation) => mutation()
) {
  if (compensation.ownsPath(files.remoteDir)) return;
  const label = `clone restore stack directory ${files.remoteDir}`;
  await acquireOwnedRemoteDirectory(
    host,
    files.remoteDir,
    ownership,
    label,
    mutate
  );
  compensation.trackOwnedDirectoryTree(files.remoteDir, () =>
    cleanupOwnedRemoteDirectory(host, files.remoteDir, ownership, label)
  );
}

function setComposeRestoreOwnershipLabels(node: YAMLMap, ownership: RestoreOwnership) {
  const values = {
    [RESTORE_ATTEMPT_LABEL]: ownership.attemptToken,
    [RESTORE_SCOPE_LABEL]: ownership.scope
  };
  const labels = node.get("labels", true);
  if (isMap(labels)) {
    for (const [key, value] of Object.entries(values)) labels.set(key, value);
    return;
  }
  if (isSeq(labels)) {
    const mapped: Record<string, string> = {};
    for (const item of labels.items) {
      if (!isScalar(item)) continue;
      const raw = String(item.value ?? "");
      const separator = raw.indexOf("=");
      const key = separator >= 0 ? raw.slice(0, separator) : raw;
      if (key) mapped[key] = separator >= 0 ? raw.slice(separator + 1) : "";
    }
    node.set("labels", { ...mapped, ...values });
    return;
  }
  node.set("labels", values);
}

function isExternalComposeResource(node: YAMLMap) {
  const external = node.get("external", true);
  return isScalar(external)
    && (external.value === true || String(external.value).toLowerCase() === "true");
}

function addComposeRestoreOwnershipLabels(
  composeYaml: string,
  ownership: RestoreOwnership,
  precreated: {
    networks: Record<string, string>;
    volumes: Record<string, string>;
  }
) {
  const document = parseDocument(composeYaml, { keepSourceTokens: true });
  if (document.errors.length) {
    throw new Error(
      `Cannot safely label restored Compose resources: ${document.errors[0]?.message ?? "invalid Compose YAML"}`
    );
  }
  const root = document.contents;
  if (!isMap(root)) {
    throw new Error("Cannot safely label restored Compose resources: the Compose document root is not a mapping.");
  }

  const services = root.get("services", true);
  if (isMap(services)) {
    for (const item of services.items) {
      if (isMap(item.value)) setComposeRestoreOwnershipLabels(item.value, ownership);
    }
  }

  const volumes = root.get("volumes", true);
  if (isMap(volumes)) {
    const precreatedVolumeNames = new Set(Object.values(precreated.volumes));
    for (const item of [...volumes.items]) {
      if (!isScalar(item.key)) continue;
      const key = String(item.key.value ?? "");
      if (!key) continue;
      const explicitName = isMap(item.value)
        ? item.value.get("name", true)
        : null;
      const explicitNameValue = isScalar(explicitName)
        ? String(explicitName.value ?? "")
        : "";
      const targetName = precreated.volumes[key]
        ?? (precreatedVolumeNames.has(explicitNameValue) ? explicitNameValue : null);
      if (targetName) {
        (volumes as YAMLMap).set(key, { name: targetName, external: true });
      } else if (!isMap(item.value)) volumes.set(key, { labels: {
        [RESTORE_ATTEMPT_LABEL]: ownership.attemptToken,
        [RESTORE_SCOPE_LABEL]: ownership.scope
      } });
      else if (!isExternalComposeResource(item.value)) {
        setComposeRestoreOwnershipLabels(item.value, ownership);
      }
    }
  }

  let networks = root.get("networks", true);
  if (!isMap(networks)) {
    (root as YAMLMap).set("networks", document.createNode({
      default: {
        labels: {
          [RESTORE_ATTEMPT_LABEL]: ownership.attemptToken,
          [RESTORE_SCOPE_LABEL]: ownership.scope
        }
      }
    }));
    networks = root.get("networks", true);
  }
  if (isMap(networks)) {
    const precreatedNetworkNames = new Set(Object.values(precreated.networks));
    for (const item of [...networks.items]) {
      if (!isScalar(item.key)) continue;
      const key = String(item.key.value ?? "");
      if (!key) continue;
      const explicitName = isMap(item.value)
        ? item.value.get("name", true)
        : null;
      const explicitNameValue = isScalar(explicitName)
        ? String(explicitName.value ?? "")
        : "";
      const targetName = precreated.networks[key]
        ?? (precreatedNetworkNames.has(explicitNameValue) ? explicitNameValue : null);
      if (targetName) {
        (networks as YAMLMap).set(key, { name: targetName, external: true });
      } else if (!isMap(item.value)) networks.set(key, { labels: {
        [RESTORE_ATTEMPT_LABEL]: ownership.attemptToken,
        [RESTORE_SCOPE_LABEL]: ownership.scope
      } });
      else if (!isExternalComposeResource(item.value)) {
        setComposeRestoreOwnershipLabels(item.value, ownership);
      }
    }
    const precreatedDefaultNetwork = precreated.networks.default;
    if (precreatedDefaultNetwork) {
      (networks as YAMLMap).set("default", {
        name: precreatedDefaultNetwork,
        external: true
      });
    } else if (!networks.has("default")) {
      networks.set("default", { labels: {
        [RESTORE_ATTEMPT_LABEL]: ownership.attemptToken,
        [RESTORE_SCOPE_LABEL]: ownership.scope
      } });
    }
  }

  return String(document);
}

function yamlScalarString(value: unknown) {
  return isScalar(value) ? String(value.value ?? "") : null;
}

function composeResourceDefinition(
  definitions: unknown,
  logicalName: string
): { name: string | null; external: boolean } | null {
  if (!isMap(definitions)) return null;
  const definition = definitions.get(logicalName, true);
  if (!isMap(definition)) return null;
  const explicitName = yamlScalarString(definition.get("name", true));
  return {
    name: explicitName?.trim() || null,
    external: isExternalComposeResource(definition)
  };
}

function isOwnedRestoredPath(source: string, ownedPaths: ReadonlySet<string>) {
  if (!path.posix.isAbsolute(source)) return false;
  const normalized = path.posix.normalize(source);
  return [...ownedPaths].some((ownedPath) => isPathInside(path.posix.normalize(ownedPath), normalized));
}

function assertComposeVolumeReferenceOwned(input: {
  source: string | null;
  kind: "bind" | "volume";
  serviceName: string;
  topVolumes: unknown;
  ownedVolumeNames: ReadonlySet<string>;
  ownedBindPaths: ReadonlySet<string>;
}) {
  if (!input.source) {
    throw new Error(
      `Cannot safely clone Compose service ${input.serviceName}: an anonymous volume has no exact restored-volume mapping.`
    );
  }
  if (input.kind === "bind") {
    if (!isOwnedRestoredPath(input.source, input.ownedBindPaths)) {
      throw new Error(
        `Cannot safely clone Compose service ${input.serviceName}: bind source ${input.source} is not inside an owned restored host-folder path.`
      );
    }
    return;
  }
  const definition = composeResourceDefinition(input.topVolumes, input.source);
  if (
    !definition?.name
    || !definition.external
    || !input.ownedVolumeNames.has(definition.name)
  ) {
    throw new Error(
      `Cannot safely clone Compose service ${input.serviceName}: volume ${input.source} is not mapped to an exact owned restored volume.`
    );
  }
}

function shortComposeVolumeSource(value: string) {
  const separator = value.indexOf(":");
  if (separator < 0) return { source: null, kind: "volume" as const };
  const source = value.slice(0, separator).trim();
  const kind = (
    source.startsWith("/")
    || source.startsWith("./")
    || source.startsWith("../")
    || source.startsWith("~")
  )
    ? "bind" as const
    : "volume" as const;
  return { source: source || null, kind };
}

function assertComposeServiceVolumesOwned(input: {
  serviceName: string;
  service: YAMLMap;
  topVolumes: unknown;
  ownedVolumeNames: ReadonlySet<string>;
  ownedBindPaths: ReadonlySet<string>;
}) {
  const volumes = input.service.get("volumes", true);
  if (volumes === undefined || volumes === null) return;
  if (!isSeq(volumes)) {
    throw new Error(
      `Cannot safely clone Compose service ${input.serviceName}: its volume declarations are not a sequence.`
    );
  }
  for (const item of volumes.items) {
    if (isScalar(item)) {
      const reference = shortComposeVolumeSource(String(item.value ?? ""));
      assertComposeVolumeReferenceOwned({ ...input, ...reference });
      continue;
    }
    if (!isMap(item)) {
      throw new Error(
        `Cannot safely clone Compose service ${input.serviceName}: an unsupported volume declaration cannot be ownership-verified.`
      );
    }
    const type = yamlScalarString(item.get("type", true))?.trim().toLowerCase() || "volume";
    if (type === "tmpfs") continue;
    if (type !== "bind" && type !== "volume") {
      throw new Error(
        `Cannot safely clone Compose service ${input.serviceName}: volume type ${type} cannot be ownership-verified.`
      );
    }
    assertComposeVolumeReferenceOwned({
      ...input,
      source: yamlScalarString(item.get("source", true))?.trim() || null,
      kind: type
    });
  }
}

function assertComposeNetworkReferenceOwned(input: {
  logicalName: string;
  serviceName: string;
  topNetworks: unknown;
  ownedNetworkNames: ReadonlySet<string>;
}) {
  const definition = composeResourceDefinition(input.topNetworks, input.logicalName);
  if (
    !definition?.name
    || !definition.external
    || !input.ownedNetworkNames.has(definition.name)
  ) {
    throw new Error(
      `Cannot safely clone Compose service ${input.serviceName}: network ${input.logicalName} is not mapped to the exact expected restore network.`
    );
  }
}

function assertComposeServiceNetworksOwned(input: {
  serviceName: string;
  service: YAMLMap;
  topNetworks: unknown;
  ownedNetworkNames: ReadonlySet<string>;
}) {
  const networkMode = yamlScalarString(input.service.get("network_mode", true))?.trim() ?? "";
  if (networkMode) {
    if (BUILTIN_NETWORKS.has(networkMode) || networkMode.startsWith("service:")) return;
    throw new Error(
      `Cannot safely clone Compose service ${input.serviceName}: network_mode ${networkMode} can escape the owned clone network set.`
    );
  }
  const networks = input.service.get("networks", true);
  if (networks === undefined || networks === null || (isSeq(networks) && networks.items.length === 0)) {
    assertComposeNetworkReferenceOwned({ ...input, logicalName: "default" });
    return;
  }
  if (isSeq(networks)) {
    for (const item of networks.items) {
      const logicalName = yamlScalarString(item)?.trim();
      if (!logicalName) {
        throw new Error(
          `Cannot safely clone Compose service ${input.serviceName}: an empty network reference cannot be ownership-verified.`
        );
      }
      assertComposeNetworkReferenceOwned({ ...input, logicalName });
    }
    return;
  }
  if (isMap(networks)) {
    for (const item of networks.items) {
      const logicalName = yamlScalarString(item.key)?.trim();
      if (!logicalName) {
        throw new Error(
          `Cannot safely clone Compose service ${input.serviceName}: an empty network reference cannot be ownership-verified.`
        );
      }
      assertComposeNetworkReferenceOwned({ ...input, logicalName });
    }
    return;
  }
  throw new Error(
    `Cannot safely clone Compose service ${input.serviceName}: its network declarations cannot be ownership-verified.`
  );
}

function assertComposeCloneResourcesOwned(
  composeYaml: string,
  mappings: {
    volumes: Record<string, string>;
    bindMounts: Record<string, string>;
    networks: Record<string, string>;
  }
) {
  const document = parseDocument(composeYaml);
  if (document.errors.length || !isMap(document.contents)) {
    throw new Error(
      `Cannot safely validate restored Compose resources: ${document.errors[0]?.message ?? "the Compose root is not a mapping"}`
    );
  }
  const services = document.contents.get("services", true);
  if (!isMap(services)) {
    throw new Error("Cannot safely validate restored Compose resources: services is not a mapping.");
  }
  const topVolumes = document.contents.get("volumes", true);
  const topNetworks = document.contents.get("networks", true);
  const ownedVolumeNames = new Set(Object.values(mappings.volumes));
  const ownedBindPaths = new Set(Object.values(mappings.bindMounts));
  const ownedNetworkNames = new Set(Object.values(mappings.networks));
  for (const item of services.items) {
    const serviceName = yamlScalarString(item.key)?.trim() || "<unknown>";
    if (!isMap(item.value)) {
      throw new Error(
        `Cannot safely validate restored Compose service ${serviceName}: aliases or non-mapping service definitions are unsupported.`
      );
    }
    assertComposeServiceVolumesOwned({
      serviceName,
      service: item.value,
      topVolumes,
      ownedVolumeNames,
      ownedBindPaths
    });
    assertComposeServiceNetworksOwned({
      serviceName,
      service: item.value,
      topNetworks,
      ownedNetworkNames
    });
  }
}

function composeRestoreFilePaths(
  manifest: RecoveryManifest | null,
  plannedStackDirectory: string,
  options: { restoredWorkingDir?: string | null } = {}
) {
  // Generated Compose and environment files are always written inside the
  // attempt-owned stack directory. A restored working tree is used only as the
  // Compose project directory, never as a file-write destination; this avoids
  // following a captured compose-path symlink outside the managed restore.
  const remoteDir =
    assertAllowedHostFolderTargetPath(plannedStackDirectory);
  const projectDirectory = options.restoredWorkingDir
    ? assertAllowedHostFolderTargetPath(options.restoredWorkingDir)
    : remoteDir;

  const rawComposePath = manifest?.compose.composePath?.trim() || "compose.yml";
  const normalizedComposePath = path.posix.normalize(rawComposePath.replace(/\\/g, "/"));
  const composePath = path.posix.isAbsolute(normalizedComposePath)
    ? isPathInside(remoteDir, normalizedComposePath)
      ? normalizedComposePath
      : path.posix.join(remoteDir, path.posix.basename(normalizedComposePath))
    : (() => {
      const joined = path.posix.normalize(path.posix.join(remoteDir, normalizedComposePath));
      return isPathInside(remoteDir, joined)
        ? joined
        : path.posix.join(remoteDir, path.posix.basename(normalizedComposePath));
    })();

  return {
    remoteDir,
    projectDirectory,
    composePath,
    envPath: path.posix.join(remoteDir, ".env")
  };
}

async function listTargetUsedPorts(targetHostId: string) {
  const host = await getHostForWorker(targetHostId);
  if (isDemoHost(host.public)) return new Map<string, string>();
  const result = await runRestoreHostDockerCommand(
    host,
    `docker ps --format '{{.Names}} {{.Ports}}'`
  );
  const used = new Map<string, string>();
  if (result.code !== 0) return used;
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    const name = space > 0 ? trimmed.slice(0, space) : trimmed;
    const ports = space > 0 ? trimmed.slice(space + 1) : "";
    for (const match of ports.matchAll(/:(\d+)->\d+\/(tcp|udp)/gi)) {
      if (!match[1] || !match[2]) continue;
      used.set(`${match[1]}/${match[2].toLowerCase()}`, name);
    }
  }
  return used;
}

async function cleanupStandaloneContainers(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  containerNames: string[],
  ownership: RestoreOwnership
) {
  const failures: string[] = [];
  for (const containerName of Array.from(new Set(containerNames.filter(Boolean))).reverse()) {
    failures.push(...await cleanupOwnedDockerResource(host, "container", containerName, ownership));
  }
  return failures;
}

async function restoreStandaloneContainers(input: {
  hostId: string;
  manifest: RecoveryManifest;
  projectName: string;
  volumeMap: Record<string, string>;
  bindMap: Record<string, string>;
  portRemap: Record<string, string>;
  networkMap: Record<string, string>;
  preserveNetworkAddresses: boolean;
  ownership: RestoreOwnership;
  executionFence?: JobExecutionFence;
  onMutationIntent?: (containerName: string) => void;
  onCreated?: (containerName: string) => void;
  mutate?: RestoreRemoteMutation;
}) {
  const host = await getHostForWorker(input.hostId);
  if (isDemoHost(host.public)) {
    return {
      restoredContainerNames: input.manifest.containers.map((container) =>
        buildCloneContainerName(container.name, input.projectName)
      )
    };
  }
  const restoredContainerNames: string[] = [];
  let stdout = "";
  let stderr = "";
  const mutate: RestoreRemoteMutation =
    input.mutate ?? ((_phase, mutation) => mutation());

  for (const container of input.manifest.containers) {
    const name = buildCloneContainerName(container.name, input.projectName);
    const ownedContainer = {
      ...container,
      labels: {
        ...container.labels,
        [RESTORE_ATTEMPT_LABEL]: input.ownership.attemptToken,
        [RESTORE_SCOPE_LABEL]: input.ownership.scope
      }
    };
    const createCommand =
      buildStandaloneContainerCreateCommand({
        container: ownedContainer,
        name,
        volumeMap: input.volumeMap,
        bindMap: input.bindMap,
        portRemap: input.portRemap,
        networkMap: input.networkMap
      });
    input.onMutationIntent?.(name);
    const createResult = await mutate(
      "recovery.restore.container.create",
      () => runRestoreHostDockerCommand(
        host,
        createCommand,
        5 * 60_000
      )
    );
    if (createResult.code !== 0) {
      throw new Error(createResult.stderr || createResult.stdout || `Failed to create restored container ${name}`);
    }
    input.onCreated?.(name);
    await verifyOwnedDockerResource(
      host,
      "container",
      name,
      input.ownership,
      `restored container ${name}`
    );
    await input.executionFence?.assertActive();
    stdout += createResult.stdout;
    stderr += createResult.stderr;
    for (const network of standaloneContainerExtraNetworks(container)) {
      const attachment = container.networkAttachments?.find((item) => item.name === network);
      const targetNetwork = input.networkMap[network] ?? network;
      const connectCommand =
        buildStandaloneNetworkConnectCommand(targetNetwork, name, {
          ipAddress: input.preserveNetworkAddresses ? attachment?.ipAddress ?? null : null,
          aliases: attachment?.aliases ?? []
        });
      const connectResult = await mutate(
        "recovery.restore.container.network-connect",
        () => runRestoreHostDockerCommand(
          host,
          connectCommand,
          60_000
        )
      );
      await input.executionFence?.assertActive();
      if (connectResult.code !== 0) {
        throw new Error(connectResult.stderr || connectResult.stdout || `Failed to connect restored container ${name} to ${targetNetwork}`);
      }
      stdout += connectResult.stdout;
      stderr += connectResult.stderr;
    }
    if (container.running) {
      const startCommand =
        buildStandaloneContainerStartCommand(name);
      const startResult = await mutate(
        "recovery.restore.container.start",
        () => runRestoreHostDockerCommand(
          host,
          startCommand,
          60_000
        )
      );
      await input.executionFence?.assertActive();
      if (startResult.code !== 0) {
        throw new Error(startResult.stderr || startResult.stdout || `Failed to start restored container ${name}`);
      }
      stdout += startResult.stdout;
      stderr += startResult.stderr;
    }
    restoredContainerNames.push(name);
  }

  return { restoredContainerNames, stdout, stderr };
}

function composeNetworkNameFromEngineName(networkName: string, projectName: string | null | undefined) {
  if (!projectName) return networkName;
  const prefix = `${projectName}_`;
  return networkName.startsWith(prefix) ? networkName.slice(prefix.length) : networkName;
}

function buildNetworkMap(manifest: RecoveryManifest | null, projectName: string, networkMode: "clone" | "reuse") {
  const map: Record<string, string> = {};
  if (!manifest) return map;
  for (const container of manifest.containers) {
    for (const network of container.networks) {
      if (!network || BUILTIN_NETWORKS.has(network)) continue;
      const sourceNetwork = (manifest.networks ?? []).find((item) => item.name === network);
      const composeLogicalName = sourceNetwork?.labels["com.docker.compose.network"]?.trim();
      const logicalName = composeLogicalName
        || composeNetworkNameFromEngineName(network, manifest.compose.projectName);
      const targetName = networkMode === "reuse"
        ? network
        : `${projectName}_${logicalName.replace(/[^a-zA-Z0-9_.-]/g, "_")}`.slice(0, 255);
      map[network] = targetName;
      if (logicalName !== network) map[logicalName] = targetName;
    }
  }
  return map;
}

function findSourceNetwork(manifest: RecoveryManifest | null, sourceName: string) {
  return (manifest?.networks ?? []).find((network) =>
    network.name === sourceName ||
    composeNetworkNameFromEngineName(network.name, manifest?.compose.projectName) === sourceName
  ) ?? null;
}

function buildNetworkCreateCommand(
  targetName: string,
  source: NonNullable<RecoveryManifest["networks"]>[number] | null,
  ownership: RestoreOwnership
) {
  const args = ["docker", "network", "create"];
  if (source?.driver) args.push("--driver", shQuote(source.driver));
  if (source?.internal) args.push("--internal");
  if (source?.attachable) args.push("--attachable");
  if (source?.enableIPv6) args.push("--ipv6");
  for (const [key, value] of Object.entries(source?.options ?? {})) {
    if (value !== null && value !== undefined && value !== "") args.push("--opt", shQuote(`${key}=${String(value)}`));
  }
  args.push(
    "--label",
    shQuote(`${RESTORE_ATTEMPT_LABEL}=${ownership.attemptToken}`),
    "--label",
    shQuote(`${RESTORE_SCOPE_LABEL}=${ownership.scope}`)
  );
  // A clone can live beside its source on the same host. Reusing the source
  // IPAM subnet would overlap, so let Docker allocate a free pool and remove
  // captured static addresses from the cloned Compose definition below.
  args.push(shQuote(targetName));
  return args.join(" ");
}

async function ensureStandaloneNetworks(
  hostId: string,
  networkMap: Record<string, string>,
  manifest: RecoveryManifest | null,
  networkMode: "clone" | "reuse",
  ownership: RestoreOwnership,
  executionFence?: JobExecutionFence,
  onMutationIntent?: (networkName: string) => void,
  onCreated?: (networkName: string) => void,
  mutate: RestoreRemoteMutation = (_phase, mutation) => mutation()
) {
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return;
  const seen = new Set<string>();
  for (const [sourceName, network] of Object.entries(networkMap)) {
    if (seen.has(network)) continue;
    seen.add(network);
    if (networkMode === "reuse") {
      const existing = await runRestoreHostDockerCommand(
        host,
        `docker network inspect ${shQuote(network)}`
      );
      await executionFence?.assertActive();
      if (existing.code !== 0) {
        throw new Error(
          existing.stderr || existing.stdout || `Required reused network ${network} does not exist on the target host`
        );
      }
      continue;
    }
    const inspect = await runRestoreHostDockerCommand(
      host,
      ownedDockerResourceInspectCommand("network", network)
    );
    if (inspect.code === 0) {
      if (inspect.stdout.trim().endsWith(`|${ownership.scope}`)) {
        throw new Error(
          `Restore network ${network} belongs to another attempt in this recovery scope; refusing to adopt or replace it without authoritative proof that its owner is inactive.`
        );
      }
      throw new Error(
        `Restore network ${network} already exists; refusing to attach a clone to an unrelated deterministic-name network.`
      );
    }
    onMutationIntent?.(network);
    const create = await mutate(
      "recovery.restore.network.create",
      () =>
      runRestoreHostDockerCommand(
        host,
        buildNetworkCreateCommand(
          network,
          findSourceNetwork(manifest, sourceName),
          ownership
        ),
        60_000
      )
    );
    if (create.code !== 0) {
      throw new Error(create.stderr || create.stdout || `Failed to create restore network ${network}`);
    }
    onCreated?.(network);
    await verifyOwnedDockerResource(host, "network", network, ownership, `restore network ${network}`);
    await executionFence?.assertActive();
  }
}

function assertRequiredLocalDataArtifactsComplete(point: RecoveryPointDetail) {
  const incomplete = point.artifacts.filter(
    (artifact) => (
      artifact.kind === "volume"
      || artifact.kind === "host_folder"
    ) && artifact.status !== "completed"
  );
  if (!incomplete.length) return;
  const labels = incomplete.slice(0, 5).map((artifact) => {
    const identity = artifact.kind === "volume"
      ? artifact.metadata.volumeName
      : artifact.metadata.sourcePath;
    return `${artifact.kind}:${String(identity ?? artifact.storageKey)} (${artifact.status})`;
  });
  throw new Error(
    `Recovery point has ${incomplete.length} incomplete required local data artifact(s): ${labels.join(", ")}. ` +
    "Refusing a clone that could attach existing source/external data or certify an incomplete restore."
  );
}

function assertManifestDataMappingsComplete(
  manifest: RecoveryManifest | null,
  volumeMap: Record<string, string>,
  bindMap: Record<string, string>
) {
  if (!manifest) return;
  const missingVolumes = new Set<string>();
  const missingBinds = new Set<string>();
  for (const container of manifest.containers) {
    for (const volume of container.volumes) {
      if (!volumeMap[volume.name]) missingVolumes.add(volume.name);
    }
    for (const bind of container.bindMounts) {
      if (!resolveRestoredBindMountPath(bind.source, bindMap)) missingBinds.add(bind.source);
    }
  }
  if (missingVolumes.size || missingBinds.size) {
    throw new Error(
      "Recovery clone data mappings are incomplete; refusing to fall through to source/external storage. " +
      `Unmapped volumes: ${[...missingVolumes].join(", ") || "none"}; ` +
      `unmapped host folders: ${[...missingBinds].join(", ") || "none"}.`
    );
  }
}

function assertManifestNetworkMappingsComplete(
  manifest: RecoveryManifest | null,
  networkMap: Record<string, string>
) {
  if (!manifest) return;
  const missing = new Set<string>();
  for (const container of manifest.containers) {
    for (const network of container.networks) {
      if (network && !BUILTIN_NETWORKS.has(network) && !networkMap[network]) missing.add(network);
    }
  }
  if (missing.size) {
    throw new Error(
      `Recovery clone network mappings are incomplete; refusing to attach to source/external network(s): ${[...missing].join(", ")}.`
    );
  }
}

function buildRecoveryRestoreDrillExpectations(
  manifest: RecoveryManifest | null,
  projectName: string,
  composeRestored: boolean,
  volumeMap: Record<string, string>,
  bindMap: Record<string, string>,
  networkMap: Record<string, string>
): RecoveryRestoreDrillExpectations {
  if (!manifest) {
    return {
      containers: [],
      requiredVolumeNames: [],
      requiredBindPaths: [],
      requiredNetworkNames: []
    };
  }
  const containers = manifest.containers.map((container) => ({
    restoredName: composeRestored
      ? null
      : buildCloneContainerName(container.name, projectName),
    composeService: composeRestored
      ? container.labels["com.docker.compose.service"]?.trim() || null
      : null,
    originallyRunning: container.running
  }));
  const requiredVolumeNames = manifest.containers.flatMap((container) =>
    container.volumes
      .map((volume) => volumeMap[volume.name])
      .filter((name): name is string => Boolean(name))
  );
  const requiredBindPaths = manifest.containers.flatMap((container) =>
    container.bindMounts
      .map((bind) => resolveRestoredBindMountPath(bind.source, bindMap))
      .filter((source): source is string => Boolean(source))
  );
  const requiredNetworkNames = manifest.containers.flatMap((container) =>
    container.networks
      .filter((network) => network && !BUILTIN_NETWORKS.has(network))
      .map((network) => networkMap[network])
      .filter((name): name is string => Boolean(name))
  );
  return {
    containers,
    requiredVolumeNames: [...new Set(requiredVolumeNames)],
    requiredBindPaths: [...new Set(requiredBindPaths.map((source) => path.posix.normalize(source)))],
    requiredNetworkNames: [...new Set(requiredNetworkNames)]
  };
}

async function runRecoveryRestoreInternal(
  hostId: string,
  input: RecoveryRestoreRequest,
  executionFence?: JobExecutionFence,
  executionContext?: RecoveryRestoreExecutionContext
): Promise<RecoveryRestoreWithCleanupResult> {
  await executionFence?.assertActive();
  const mode = input.options.mode ?? "clone";
  const networkMode = input.options.networkMode ?? "clone";
  if (mode === "in_place") {
    throw new Error("In-place restore is disabled until source stop validation is implemented.");
  }

  const point = await getRecoveryPointForRestore(
    input.recoveryPointId
  );
  if (!point) throw new Error("Recovery point not found");
  if (point.status !== "completed" && point.status !== "partial") {
    throw new Error("Recovery point is not ready for restore");
  }

  const manifest = await loadRecoveryManifest(point);
  assertRequiredLocalDataArtifactsComplete(point);
  const plan = buildRecoveryRestorePlan(
    point,
    manifest,
    { ...input, targetHostId: hostId }
  );
  const {
    composeArtifact,
    sameHostComposeClone,
    projectName,
    volumeMap,
    bindMap,
    networkMap
  } = plan;
  const restoreHost = await getHostForWorker(hostId);
  if (
    !isDemoHost(restoreHost.public)
    && restoreHost.connectionMode !== "ssh"
    && plan.resources.some((resource) =>
      resource.kind === "directory"
      || resource.kind === "volume"
    )
  ) {
    throw new Error(
      "Recovery restores containing volume archives, bind mounts, or Compose files require SSH host mode; refusing before durable intent or remote mutation."
    );
  }
  const compensation = createRestoreCompensation();
  const ownership: RestoreOwnership = {
    attemptToken: randomUUID(),
    scope: point.id
  };
  const durableAttempt = executionContext
    ? {
        attemptToken: ownership.attemptToken,
        executionFence
      }
    : null;
  let completedComposeResources:
    | ComposeProjectResources
    | undefined;

  if (durableAttempt) {
    await beginRecoveryRestoreAttempt(
      {
        attemptToken: durableAttempt.attemptToken,
        recoveryPointId: point.id,
        targetHostId: hostId,
        restoreScope: point.id,
        operationJobId:
          executionContext?.operationJobId ?? null,
        migrationRunId:
          executionContext?.migrationRunId ?? null,
        allowedPathRoots: plan.allowedPathRoots,
        retainOnSuccess:
          executionContext?.retainOnSuccess ?? true
      },
      executionFence
    );
    for (const resource of plan.resources) {
      await registerRecoveryRestoreResource(
        durableAttempt.attemptToken,
        resource.kind,
        resource.name,
        executionFence
      );
    }
  }

  const mutate: RestoreRemoteMutation = async (
    phase,
    mutation
  ) => {
    try {
      return await withRemoteMutationContext(
        executionFence,
        phase,
        mutation
      );
    } catch (error) {
      if (!durableAttempt) throw error;
      let ledgerError: unknown;
      try {
        await markRecoveryRestoreAttemptCleanupPending(
          durableAttempt.attemptToken,
          error,
          { remoteOutcomeUnknown: true }
        );
      } catch (markError) {
        ledgerError = markError;
      }
      if (isRemoteMutationOutcomeUnknown(error)) {
        // The transport layer has already persisted the exact operation
        // identity and proved that its terminal outcome is not authoritative.
        // Preserve that structured error and its REMOTE_OUTCOME_UNKNOWN prefix
        // so the worker can reconcile this operation rather than retrying it.
        throw error;
      }
      throw new RecoveryRestoreRemoteOutcomeUnknownError(
        ledgerError
          ? new AggregateError(
              [error, ledgerError],
              "Remote mutation and durable unknown-outcome update failed"
            )
          : error
      );
    }
  };

  if (
    durableAttempt
    && plan.resources.some((resource) =>
      resource.kind !== "database"
    )
  ) {
    await executionContext?.beforeRemoteMutation?.(
      durableAttempt.attemptToken
    );
  }

  let restoredVolumes = 0;
  let restoredBindMounts = 0;

  const finish = async (
    restore: RestoreResult,
    drillExpectations: RecoveryRestoreDrillExpectations
  ) => {
    if (durableAttempt) {
      for (const resource of plan.resources) {
        await markRecoveryRestoreResourceObserved(
          durableAttempt.attemptToken,
          resource.kind,
          resource.name,
          executionFence
        );
      }
      await markRecoveryRestoreAttemptAwaitingDisposition(
        durableAttempt.attemptToken,
        executionFence
      );
    }
    return completedRestore(
      restore,
      compensation,
      drillExpectations,
      durableAttempt
    );
  };

  try {
    for (const artifact of point.artifacts) {
      if (
        artifact.kind !== "volume"
        || artifact.status !== "completed"
      ) continue;
      const volumeName = String(
        artifact.metadata.volumeName ?? ""
      );
      if (!volumeName) continue;
      const targetVolumeName = volumeMap[volumeName];
      if (!targetVolumeName) {
        throw new Error(
          `Recovery volume ${volumeName} has no durable target mapping`
        );
      }
      await executionFence?.assertActive();
      await restoreVolumeArtifact(
        hostId,
        point,
        artifact,
        targetVolumeName,
        ownership.attemptToken,
        ownership.scope,
        executionFence,
        (volumeName) => {
          compensation.track(() =>
            cleanupOwnedDockerResource(
              restoreHost,
              "volume",
              volumeName,
              ownership
            )
          );
        },
        undefined,
        mutate
      );
      restoredVolumes += 1;
    }

    for (const artifact of point.artifacts) {
      if (
        artifact.kind !== "host_folder"
        || artifact.status !== "completed"
      ) continue;
      const sourcePath = String(
        artifact.metadata.sourcePath ?? ""
      );
      if (!sourcePath) continue;
      const targetPath = bindMap[sourcePath];
      if (!targetPath) {
        throw new Error(
          `Recovery host folder ${sourcePath} has no durable target mapping`
        );
      }
      await executionFence?.assertActive();
      if (
        !isDemoHost(restoreHost.public)
        && restoreHost.connectionMode === "ssh"
        && !compensation.ownsPath(targetPath)
      ) {
        const label =
          `clone restore host folder ${targetPath}`;
        await acquireOwnedRemoteDirectory(
          restoreHost,
          targetPath,
          ownership,
          label,
          mutate
        );
        compensation.trackOwnedDirectoryTree(
          targetPath,
          () => cleanupOwnedRemoteDirectory(
            restoreHost,
            targetPath,
            ownership,
            label
          )
        );
        await executionFence?.assertActive();
      }
      await restoreBindMountArtifact(
        hostId,
        point,
        artifact,
        targetPath,
        executionFence,
        mutate
      );
      restoredBindMounts += 1;
    }
    assertManifestDataMappingsComplete(
      manifest,
      volumeMap,
      bindMap
    );

    let portRemap: Record<string, string> = {};
    if (manifest && input.options.remapPorts !== false) {
      const sourcePorts = extractPublishedPorts(
        manifest.containers
      );
      const targetUsed = await listTargetUsedPorts(hostId);
      const conflicts = detectPortConflicts(
        sourcePorts,
        targetUsed
      );
      if (conflicts.length) {
        portRemap = buildPortRemap(
          conflicts,
          new Set(targetUsed.keys())
        );
      }
    }
    assertManifestNetworkMappingsComplete(
      manifest,
      networkMap
    );
    const drillExpectations =
      buildRecoveryRestoreDrillExpectations(
        manifest,
        projectName,
        Boolean(composeArtifact),
        volumeMap,
        bindMap,
        networkMap
      );
    await executionFence?.assertActive();
    await ensureStandaloneNetworks(
      hostId,
      networkMap,
      manifest,
      networkMode,
      ownership,
      executionFence,
      (networkName) => {
        compensation.track(() =>
          cleanupOwnedDockerResource(
            restoreHost,
            "network",
            networkName,
            ownership
          )
        );
      },
      undefined,
      mutate
    );
    await executionFence?.assertActive();

    if (!composeArtifact) {
      if (!manifest?.containers.length) {
        await executionFence?.assertActive();
        return finish(
          {
            mode,
            projectName,
            restoredVolumes,
            restoredBindMounts,
            composeRestored: false,
            standaloneContainersRestored: 0,
            restoredContainerNames: [],
            volumeMap,
            bindMap,
            portRemap,
            networkMap
          },
          drillExpectations
        );
      }

      await executionFence?.assertActive();
      const standalone = await restoreStandaloneContainers({
        hostId,
        manifest,
        projectName,
        volumeMap,
        bindMap,
        portRemap,
        networkMap,
        preserveNetworkAddresses: networkMode === "reuse",
        ownership,
        executionFence,
        onMutationIntent: (containerName) => {
          compensation.track(() =>
            cleanupOwnedDockerResource(
              restoreHost,
              "container",
              containerName,
              ownership
            )
          );
        },
        mutate
      });

      await executionFence?.assertActive();
      return finish(
        {
          mode,
          projectName,
          restoredVolumes,
          restoredBindMounts,
          composeRestored: false,
          standaloneContainersRestored:
            standalone.restoredContainerNames.length,
          restoredContainerNames:
            standalone.restoredContainerNames,
          volumeMap,
          bindMap,
          portRemap,
          networkMap,
          stdout: standalone.stdout,
          stderr: standalone.stderr
        },
        drillExpectations
      );
    }

    let composeYaml = (
      await readRecoveryArtifact(point, composeArtifact)
    ).toString("utf8");
    const envArtifact = point.artifacts.find(
      (artifact) =>
        artifact.kind === "env_file"
        && artifact.status === "completed"
    );
    const env = envArtifact
      ? (
          await readRecoveryArtifact(point, envArtifact)
        ).toString("utf8")
      : "";

    composeYaml = remapComposeYaml(composeYaml, {
      volumes: volumeMap,
      bindMounts: bindMap,
      serviceBindMounts: manifest
        ? buildComposeServiceBindMounts(
            manifest.containers,
            bindMap
          )
        : new Map(),
      portRemap,
      networks: networkMap,
      resetNetworkAddressing: networkMode === "clone"
    });
    composeYaml = addComposeRestoreOwnershipLabels(
      composeYaml,
      ownership,
      {
        networks: networkMap,
        volumes: volumeMap
      }
    );
    assertComposeCloneResourcesOwned(
      composeYaml,
      {
        volumes: volumeMap,
        bindMounts: bindMap,
        networks: networkMap
      }
    );

    let restoredWorkingDir: string | null = null;
    if (manifest?.compose.workingDir) {
      restoredWorkingDir =
        resolveRestoredBindMountPath(
          manifest.compose.workingDir,
          bindMap
        ) ?? null;
      if (sameHostComposeClone && !restoredWorkingDir) {
        throw new Error(
          `Cannot safely restore Compose project ${
            manifest.compose.projectName ?? projectName
          }: the captured working directory ${
            manifest.compose.workingDir
          } was not restored.`
        );
      }
    }
    if (!plan.stackDirectory) {
      throw new Error(
        "Recovery plan is missing its generated Compose stack directory."
      );
    }
    const restoreFiles = composeRestoreFilePaths(
      manifest,
      plan.stackDirectory,
      { restoredWorkingDir }
    );
    if (isDemoHost(restoreHost.public)) {
      await executionFence?.assertActive();
      return finish(
        {
          mode,
          projectName,
          restoredVolumes,
          restoredBindMounts,
          composeRestored: true,
          standaloneContainersRestored: 0,
          restoredContainerNames: [],
          volumeMap,
          bindMap,
          portRemap,
          networkMap,
          demo: true
        },
        drillExpectations
      );
    }

    await executionFence?.assertActive();
    if (restoreHost.connectionMode !== "ssh") {
      throw new Error(
        "Recovery Compose restore currently requires SSH host mode."
      );
    }
    await trackCreatedStackFiles(
      restoreHost,
      restoreFiles,
      compensation,
      ownership,
      mutate
    );
    await executionFence?.assertActive();
    await assertComposeProjectIsUnused(
      restoreHost,
      projectName
    );
    // Compose may mutate several Docker resources in one remote command. Add
    // its project-scoped cleanup immediately before that command, after owned
    // files have been acquired, so rollback order is containers/networks/
    // volumes first and then the stack directory.
    compensation.track(() =>
      cleanupComposeProjectResources(
        restoreHost,
        projectName,
        ownership,
        completedComposeResources
      )
    );
    const files = await mutate(
      "recovery.restore.compose.files.write",
      () =>
      writeHostStackFiles(
        hostId,
        restoreFiles.remoteDir,
        composeYaml,
        env,
        {
          composePath: restoreFiles.composePath,
          envPath: restoreFiles.envPath
        }
      )
    );
    await executionFence?.assertActive();
    const baseComposeCommand = buildComposeCommand(
      projectName,
      files.composePath,
      "up"
    ).replace(
      "docker compose ",
      `docker compose --project-directory ${
        shQuote(restoreFiles.projectDirectory)
      } --env-file ${shQuote(files.envPath)} `
    );
    const command =
      `cd ${shQuote(restoreFiles.remoteDir)} && ${
        withDockerEnv(
          baseComposeCommand,
          restoreHost.public.dockerSocketPath
        )
      }`;
    const result = await mutate(
      "recovery.restore.compose.up",
      () =>
      runSshCommand(
        restoreHost.ssh,
        command,
        { timeoutMs: 10 * 60_000 }
      )
    );
    await executionFence?.assertActive();
    if (result.code !== 0) {
      throw new Error(
        result.stderr
        || result.stdout
        || "Compose restore failed"
      );
    }
    completedComposeResources =
      await listComposeProjectResources(
        restoreHost,
        projectName
      );
    await verifyComposeProjectResourcesOwned(
      restoreHost,
      completedComposeResources,
      ownership
    );

    await executionFence?.assertActive();
    return finish(
      {
        mode,
        projectName,
        restoredVolumes,
        restoredBindMounts,
        composeRestored: true,
        standaloneContainersRestored: 0,
        restoredContainerNames: [],
        volumeMap,
        bindMap,
        portRemap,
        networkMap,
        stdout: result.stdout,
        stderr: result.stderr
      },
      drillExpectations
    );
  } catch (error) {
    if (durableAttempt) {
      const cleanup =
        createRecoveryRestoreCleanup(
          compensation,
          durableAttempt
        );
      if (
        error instanceof
          RecoveryRestoreRemoteOutcomeUnknownError
        || isRemoteMutationOutcomeUnknown(error)
      ) {
        throw new RecoveryRestoreCleanupRequiredError(
          error instanceof Error
            ? error.message
            : String(error),
          cleanup,
          true,
          error
        );
      }
      await markRecoveryRestoreAttemptCleanupPending(
        durableAttempt.attemptToken,
        error
      ).catch(() => undefined);
      try {
        await cleanup.cleanup();
      } catch (cleanupError) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        const cleanupMessage =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        throw new RecoveryRestoreCleanupRequiredError(
          `${message}; cleanup failed or remains pending: ${
            cleanupMessage
          }`,
          cleanup,
          false,
          new AggregateError([error, cleanupError])
        );
      }
      throw error;
    }
    const cleanupFailures = await compensation.rollback();
    if (cleanupFailures.length) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}; cleanup failed: ${cleanupFailures.join("; ")}`, { cause: error });
    }
    throw error;
  }
}

export async function runRecoveryRestoreWithCleanup(
  hostId: string,
  input: RecoveryRestoreRequest,
  executionFence?: JobExecutionFence,
  executionContext?: RecoveryRestoreExecutionContext
): Promise<RecoveryRestoreWithCleanupResult> {
  return runRecoveryRestoreInternal(
    hostId,
    input,
    executionFence,
    executionContext
  );
}

const RECOVERY_DRILL_VALIDATION_TIMEOUT_MS = 60_000;
const RECOVERY_DRILL_VALIDATION_POLL_MS = 1_000;

function restoredContainerState(inspect: Record<string, unknown>) {
  const state = inspect.State && typeof inspect.State === "object" && !Array.isArray(inspect.State)
    ? inspect.State as Record<string, unknown>
    : {};
  const health = state.Health && typeof state.Health === "object" && !Array.isArray(state.Health)
    ? state.Health as Record<string, unknown>
    : {};
  const rawExitCode = state.ExitCode;
  const parsedExitCode = (
    typeof rawExitCode === "number"
    || (typeof rawExitCode === "string" && rawExitCode.trim() !== "")
  )
    ? Number(rawExitCode)
    : Number.NaN;
  return {
    running: Boolean(state.Running) || String(state.Status ?? "").toLowerCase() === "running",
    health: String(health.Status ?? "").toLowerCase(),
    exitCode: Number.isFinite(parsedExitCode) ? parsedExitCode : null
  };
}

function restoredContainerLabels(inspect: Record<string, unknown>) {
  const config = inspect.Config && typeof inspect.Config === "object" && !Array.isArray(inspect.Config)
    ? inspect.Config as Record<string, unknown>
    : {};
  const labels = config.Labels && typeof config.Labels === "object" && !Array.isArray(config.Labels)
    ? config.Labels as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value ?? "")]));
}

function restoredContainerName(inspect: Record<string, unknown>) {
  return String(inspect.Name ?? inspect.Id ?? "<unknown>").replace(/^\//, "");
}

function inspectRowsStableForExpectations(
  rows: Array<Record<string, unknown>>,
  expectations: RecoveryRestoreDrillContainerExpectation[]
) {
  const observations = rows.map((row) => ({
    name: restoredContainerName(row),
    labels: restoredContainerLabels(row),
    state: restoredContainerState(row)
  }));
  for (const observation of observations) {
    if (observation.state.health === "unhealthy") {
      throw new Error(`Recovery restore drill container ${observation.name} is unhealthy.`);
    }
    if (!observation.state.running && observation.state.exitCode !== null && observation.state.exitCode !== 0) {
      throw new Error(
        `Recovery restore drill container ${observation.name} exited with code ${observation.state.exitCode}.`
      );
    }
  }

  const pending = new Set<string>();
  for (const observation of observations) {
    if (observation.state.running && observation.state.health === "starting") {
      pending.add(`${observation.name} health is starting`);
    }
  }

  if (!expectations.length) {
    for (const observation of observations) {
      if (!observation.state.running && observation.state.exitCode !== 0) {
        pending.add(`${observation.name} has no successful stable outcome`);
      }
    }
    return { stable: pending.size === 0, pending: [...pending] };
  }

  for (const expectation of expectations.filter((item) => item.restoredName)) {
    const observation = observations.find((item) => item.name === expectation.restoredName);
    if (!observation) {
      pending.add(`${expectation.restoredName} is missing`);
    } else if (
      expectation.originallyRunning
      && !observation.state.running
      && observation.state.exitCode !== 0
    ) {
      pending.add(`${expectation.restoredName} has no successful stable outcome`);
    }
  }

  const composeServices = new Map<string, RecoveryRestoreDrillContainerExpectation[]>();
  for (const expectation of expectations.filter((item) => item.composeService)) {
    const service = expectation.composeService!;
    const group = composeServices.get(service) ?? [];
    group.push(expectation);
    composeServices.set(service, group);
  }
  for (const [service, serviceExpectations] of composeServices) {
    const serviceRows = observations.filter(
      (observation) => observation.labels["com.docker.compose.service"] === service
    );
    if (serviceRows.length < serviceExpectations.length) {
      pending.add(`Compose service ${service} has ${serviceRows.length}/${serviceExpectations.length} expected container(s)`);
      continue;
    }
    const expectedRunning = serviceExpectations.filter((expectation) => expectation.originallyRunning).length;
    const stableOutcomes = serviceRows.filter(
      (observation) => (
        observation.state.running && observation.state.health !== "starting"
      ) || (
        !observation.state.running && observation.state.exitCode === 0
      )
    ).length;
    if (stableOutcomes < expectedRunning) {
      pending.add(`Compose service ${service} has ${stableOutcomes}/${expectedRunning} successful stable outcome(s)`);
    }
  }
  return { stable: pending.size === 0, pending: [...pending] };
}

function waitForRecoveryDrillPoll() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, RECOVERY_DRILL_VALIDATION_POLL_MS);
  });
}

export async function validateRecoveryRestoreDrill(
  hostId: string,
  restore: RestoreResult,
  executionFence?: JobExecutionFence,
  drillExpectations?: RecoveryRestoreDrillExpectations
) {
  await executionFence?.assertActive();
  if (restore.demo) return;
  const host = await getHostForWorker(hostId);
  if (isDemoHost(host.public)) return;
  const containerNames = restore.composeRestored
    ? restore.projectName
      ? (await listComposeProjectResources(host, restore.projectName)).containers
      : []
    : [...new Set(restore.restoredContainerNames.filter(Boolean))];
  if (!containerNames.length) {
    throw new Error("Recovery restore drill did not create any containers to validate.");
  }
  const deadline = Date.now() + RECOVERY_DRILL_VALIDATION_TIMEOUT_MS;
  let rows: Array<Record<string, unknown>> = [];
  let lastPending: string[] = [];
  while (true) {
    await executionFence?.assertActive();
    const inspected = await runRestoreHostDockerCommand(
      host,
      `docker inspect ${containerNames.map(shQuote).join(" ")}`
    );
    await executionFence?.assertActive();
    if (inspected.code !== 0) {
      throw new Error(commandFailure(inspected, "Recovery restore drill containers could not be inspected."));
    }
    try {
      const parsed = JSON.parse(inspected.stdout) as unknown;
      rows = Array.isArray(parsed)
        ? parsed.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
        : [];
    } catch {
      throw new Error("Recovery restore drill container inspection returned invalid JSON.");
    }
    if (rows.length !== containerNames.length) {
      throw new Error(
        `Recovery restore drill found ${rows.length}/${containerNames.length} expected container(s).`
      );
    }
    const stability = inspectRowsStableForExpectations(rows, drillExpectations?.containers ?? []);
    if (stability.stable) break;
    lastPending = stability.pending;
    if (Date.now() >= deadline) {
      throw new Error(
        `Recovery restore drill timed out waiting for stable containers: ${lastPending.join("; ") || "unknown state"}.`
      );
    }
    await waitForRecoveryDrillPoll();
  }

  const mountedVolumes = new Set<string>();
  const mountedBindPaths = new Set<string>();
  const attachedNetworks = new Set<string>();
  for (const row of rows) {
    const mounts = Array.isArray(row.Mounts) ? row.Mounts as Array<Record<string, unknown>> : [];
    for (const mount of mounts) {
      if (mount.Type === "volume" && mount.Name) mountedVolumes.add(String(mount.Name));
      if (mount.Type === "bind" && mount.Source) {
        mountedBindPaths.add(path.posix.normalize(String(mount.Source)));
      }
    }
    const networkSettings = row.NetworkSettings
      && typeof row.NetworkSettings === "object"
      && !Array.isArray(row.NetworkSettings)
      ? row.NetworkSettings as Record<string, unknown>
      : {};
    const networks = networkSettings.Networks
      && typeof networkSettings.Networks === "object"
      && !Array.isArray(networkSettings.Networks)
      ? networkSettings.Networks as Record<string, unknown>
      : {};
    for (const networkName of Object.keys(networks)) attachedNetworks.add(networkName);
  }
  const requiredVolumeNames = drillExpectations?.requiredVolumeNames
    ?? [...new Set(Object.values(restore.volumeMap))];
  const requiredBindPaths = drillExpectations?.requiredBindPaths
    ?? [...new Set(Object.values(restore.bindMap))];
  const requiredNetworkNames = drillExpectations?.requiredNetworkNames
    ?? [...new Set(Object.values(restore.networkMap))];
  const missingVolumes = requiredVolumeNames
    .filter((name) => !mountedVolumes.has(name));
  const missingBindPaths = requiredBindPaths
    .filter((source) => !mountedBindPaths.has(path.posix.normalize(source)));
  const missingNetworks = requiredNetworkNames
    .filter((name) => !attachedNetworks.has(name));
  if (missingVolumes.length || missingBindPaths.length || missingNetworks.length) {
    throw new Error(
      "Recovery restore drill containers are not attached to every restored resource. " +
      `Missing volumes: ${missingVolumes.join(", ") || "none"}; ` +
      `missing host folders: ${missingBindPaths.join(", ") || "none"}; ` +
      `missing clone networks: ${missingNetworks.join(", ") || "none"}.`
    );
  }
  await executionFence?.assertActive();
}

export async function runRecoveryRestoreDrill(
  hostId: string,
  input: RecoveryRestoreRequest,
  executionFence?: JobExecutionFence,
  executionContext?: RecoveryRestoreExecutionContext
): Promise<RestoreResult> {
  const completed = await runRecoveryRestoreWithCleanup(
    hostId,
    input,
    executionFence,
    executionContext
      ? {
          ...executionContext,
          retainOnSuccess: false
        }
      : undefined
  );
  let validationError: unknown;
  try {
    await validateRecoveryRestoreDrill(
      hostId,
      completed.restore,
      executionFence,
      completed.drillExpectations
    );
  } catch (error) {
    validationError = error;
  }
  let cleanupError: unknown;
  try {
    await completed.cleanup.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (!validationError) {
    try {
      await executionFence?.assertActive();
    } catch (error) {
      validationError = error;
    }
  }
  if (validationError && cleanupError) {
    const validationMessage = validationError instanceof Error ? validationError.message : String(validationError);
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(
      `${validationMessage}; drill teardown failed: ${cleanupMessage}`,
      { cause: new AggregateError([validationError, cleanupError]) }
    );
  }
  if (validationError) throw validationError;
  if (cleanupError) throw cleanupError;
  return completed.restore;
}

export async function runRecoveryRestore(
  hostId: string,
  input: RecoveryRestoreRequest,
  executionFence?: JobExecutionFence,
  executionContext?: RecoveryRestoreExecutionContext
): Promise<RestoreResult> {
  const completed = await runRecoveryRestoreInternal(
    hostId,
    input,
    executionFence,
    executionContext
  );
  return completed.restore;
}
