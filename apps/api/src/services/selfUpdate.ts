import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  compareReleaseVersions,
  dockerActionSchema,
  isStableReleaseVersion,
  parseReleaseVersion,
  selfUpdateConfigInputSchema,
  selfUpdateConfigSchema,
  type DockerActionRequest,
  type SelfUpdateConfig
} from "@composebastion/shared";
import { query } from "../db/pool.js";
import { shQuote } from "./commands.js";
import { getHost, getHostForWorker } from "./hosts.js";
import { buildJobProgress, enqueueJob } from "./jobs.js";
import { mapJob } from "./mappers.js";
import { runSshCommand, writeRemoteFile } from "./ssh.js";
import { runtimeVersionMetadata } from "./version.js";

const SELF_UPDATE_CONFIG_KEY = "self_update.config";
const SELF_UPDATE_LATEST_KEY = "self_update.latest";
const GITHUB_API_REPO = "https://api.github.com/repos/composebastion-admin/composebastion";
const GITHUB_REPO_URL = "https://github.com/composebastion-admin/composebastion";
const DOCKER_SSH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin";
const COMPOSEBASTION_IMAGE_SOURCE = "https://github.com/composebastion-admin/composebastion";
export const BRIDGE_SELF_UPDATE_LOCK_PATH = "/tmp/composebastion-self-update.lock";
const SELF_UPDATE_MISSING_OUTCOME_GRACE_MS = 2 * 60_000;
const SELF_UPDATE_HANDOFF_TIMEOUT_MS = 30 * 60_000;

type LatestRelease = {
  version: string | null;
  checkedAt: string | null;
  error: string | null;
  htmlUrl?: string | null;
};

type SelfUpdatePayload = Extract<DockerActionRequest, { type: "system.self_update" }>["payload"];

const defaultSelfUpdateConfig = selfUpdateConfigSchema.parse({});

function normalizeVersion(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed.replace(/^v/i, "");
}

export function compareVersions(left: string | null | undefined, right: string | null | undefined) {
  return compareReleaseVersions(left, right) ?? 0;
}

export function updateAvailable(current: string, latest: string | null) {
  return compareVersions(latest, current) > 0;
}

function isStableVersion(value: string | null | undefined) {
  return isStableReleaseVersion(value);
}

async function readSetting<T>(key: string) {
  const result = await query<{ value: T }>("SELECT value FROM system_settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

async function writeSetting(key: string, value: unknown) {
  await query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

async function latestJob() {
  const result = await query(
    `SELECT *
     FROM operation_jobs
     WHERE type = 'system.self_update'
     ORDER BY created_at DESC
     LIMIT 1`
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function getSelfUpdateConfig() {
  const stored = await readSetting<unknown>(SELF_UPDATE_CONFIG_KEY);
  return selfUpdateConfigSchema.parse({
    ...defaultSelfUpdateConfig,
    ...(stored && typeof stored === "object" ? stored : {})
  });
}

export async function saveSelfUpdateConfig(input: unknown) {
  const current = await getSelfUpdateConfig();
  const patch = selfUpdateConfigInputSchema.parse(input);
  const next = selfUpdateConfigSchema.parse({
    ...current,
    ...patch
  });

  if (next.hostId) {
    const host = await getHost(next.hostId);
    if (!host) throw Object.assign(new Error("Selected manager host was not found"), { statusCode: 404 });
  }

  await writeSetting(SELF_UPDATE_CONFIG_KEY, next);
  return next;
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ComposeBastion"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while checking releases`);
  return await response.json() as T;
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const [tags, releases] = await Promise.all([
    fetchGithubJson<Array<{ name?: string }>>(`${GITHUB_API_REPO}/tags?per_page=100`),
    fetchGithubJson<Array<{ tag_name?: string; html_url?: string | null; draft?: boolean }>>(`${GITHUB_API_REPO}/releases?per_page=100`).catch(() => [])
  ]);
  const releaseUrlByVersion = new Map(
    releases
      .filter((release) => !release.draft)
      .flatMap((release): Array<[string, string | null]> => {
        const version = normalizeVersion(release.tag_name);
        return version ? [[version, release.html_url ?? null]] : [];
      })
  );
  const versions = Array.from(new Set([
    ...tags.map((tag) => normalizeVersion(tag.name)).filter((version): version is string => Boolean(version)),
    ...Array.from(releaseUrlByVersion.keys())
  ]));
  const stableVersions = versions.filter(isStableVersion);
  const candidates = stableVersions.length > 0 ? stableVersions : versions.filter((version) => Boolean(parseReleaseVersion(version)));
  const version = candidates.sort((left, right) => compareVersions(right, left))[0] ?? null;

  return {
    version,
    checkedAt: new Date().toISOString(),
    error: null,
    htmlUrl: version ? releaseUrlByVersion.get(version) ?? `${GITHUB_REPO_URL}/releases/tag/v${version}` : null
  };
}

export async function checkSelfUpdateLatest() {
  try {
    const latest = await fetchLatestRelease();
    await writeSetting(SELF_UPDATE_LATEST_KEY, latest);
    return latest;
  } catch (caught) {
    const latest = {
      version: null,
      checkedAt: new Date().toISOString(),
      error: caught instanceof Error ? caught.message : String(caught)
    };
    await writeSetting(SELF_UPDATE_LATEST_KEY, latest);
    return latest;
  }
}

export async function getSelfUpdateStatus() {
  const [config, latest, job] = await Promise.all([
    getSelfUpdateConfig(),
    readSetting<LatestRelease>(SELF_UPDATE_LATEST_KEY),
    latestJob()
  ]);
  const runtime = runtimeVersionMetadata();
  return {
    configured: Boolean(config.hostId),
    config,
    runtime,
    latest: latest ?? { version: null, checkedAt: null, error: null },
    updateAvailable: updateAvailable(runtime.version, latest?.version ?? null),
    lastJob: job
  };
}

export async function enqueueSelfUpdate(input: { targetVersion?: string }, createdBy?: string | null) {
  const config = await getSelfUpdateConfig();
  if (!config.hostId) {
    throw Object.assign(new Error("Choose the manager host before starting a self-update"), { statusCode: 400 });
  }

  const targetVersion = input.targetVersion?.trim()
    || (config.versionMode === "latest" ? "latest" : config.targetVersion)
    || "latest";
  if (targetVersion !== "latest" && !parseReleaseVersion(targetVersion)) {
    throw Object.assign(new Error("Self-updates require latest or a valid semantic release version"), { statusCode: 400 });
  }
  if (config.versionMode === "pinned" && targetVersion === "latest") {
    throw Object.assign(new Error("Pinned updates require a valid semantic release version"), { statusCode: 400 });
  }

  const action: DockerActionRequest = {
    type: "system.self_update",
    hostId: config.hostId,
    payload: {
      workingDir: config.workingDir,
      composeFile: config.composeFile,
      versionMode: config.versionMode,
      targetVersion
    }
  };
  return enqueueJob(action, createdBy ?? null);
}

function dockerShellExports(socketPath: string) {
  return [
    `export PATH=${DOCKER_SSH_PATH}:$PATH`,
    `export DOCKER_HOST=${shQuote(`unix://${socketPath}`)}`
  ].join("\n");
}

export type BridgeSelfUpdateHandoff = {
  handoffStarted: true;
  handoffPending: true;
  pid: string | null;
  targetVersion: string;
  workingDir: string;
  composeFile: string;
  scriptPath: string;
  logPath: string;
  outcomePath: string;
  gatePath: string;
  lockPath: string;
  handedOffAt: string;
};

type BridgeSelfUpdateOutcome = {
  status: "passed" | "failed";
  stage: string;
  rollback: "not_required" | "succeeded" | "failed";
  targetVersion: string;
  exitCode: number;
};

function bridgeArtifactPath(workingDir: string, jobId: string, suffix: string) {
  return path.posix.join(workingDir, `.composebastion-self-update-${jobId}.${suffix}`);
}

export function buildBridgeSelfUpdateControls(
  payload: SelfUpdatePayload,
  socketPath: string,
  input: {
    jobId: string;
    lockPath: string;
    outcomePath: string;
    gatePath: string;
    envBackupPath: string;
    rollbackComposePath: string;
  }
) {
  const values = {
    WORKING_DIR: payload.workingDir,
    COMPOSE_FILE: payload.composeFile,
    TARGET_VERSION: payload.targetVersion,
    JOB_ID: input.jobId,
    LOCK_PATH: input.lockPath,
    OUTCOME_PATH: input.outcomePath,
    GATE_PATH: input.gatePath,
    ENV_BACKUP_PATH: input.envBackupPath,
    ROLLBACK_COMPOSE_PATH: input.rollbackComposePath,
    COMPOSEBASTION_DOCKER_PATH: DOCKER_SSH_PATH,
    COMPOSEBASTION_DOCKER_SOCKET: socketPath
  };
  return [
    "#!/bin/sh",
    ...Object.entries(values).map(([name, value]) => `${name}=${shQuote(value)}`)
  ].join("\n");
}

export function buildBridgeSelfUpdateLaunchScript(input: {
  jobId: string;
  scriptPath: string;
  logPath: string;
  lockPath: string;
}) {
  return [
    "#!/bin/sh",
    "set -eu",
    `LOCK_PATH=${shQuote(input.lockPath)}`,
    `JOB_ID=${shQuote(input.jobId)}`,
    `SCRIPT_PATH=${shQuote(input.scriptPath)}`,
    `LOG_PATH=${shQuote(input.logPath)}`,
    "release_lock() { rm -f -- \"$LOCK_PATH/owner\" \"$LOCK_PATH/job\" \"$LOCK_PATH/script\"; rmdir -- \"$LOCK_PATH\" 2>/dev/null || true; }",
    "lock_age_seconds() {",
    "  now=\"$(date +%s)\"",
    "  modified=\"$(stat -c %Y -- \"$LOCK_PATH\" 2>/dev/null || stat -f %m -- \"$LOCK_PATH\" 2>/dev/null || true)\"",
    "  case \"$modified\" in ''|*[!0-9]*) printf '%s\\n' 0 ;; *) printf '%s\\n' \"$((now - modified))\" ;; esac",
    "}",
    "if ! mkdir -- \"$LOCK_PATH\" 2>/dev/null; then",
    "  existing_owner=\"$(sed -n '1p' \"$LOCK_PATH/owner\" 2>/dev/null || true)\"",
    "  existing_job=\"$(sed -n '1p' \"$LOCK_PATH/job\" 2>/dev/null || true)\"",
    "  existing_script=\"$(sed -n '1p' \"$LOCK_PATH/script\" 2>/dev/null || true)\"",
    "  lock_age=\"$(lock_age_seconds)\"",
    "  owner_alive=0; owner_inspected=0; owner_is_updater=0; metadata_valid=1",
    "  case \"$existing_owner\" in ''|*[!0-9]*) metadata_valid=0 ;; *) kill -0 \"$existing_owner\" 2>/dev/null && owner_alive=1 || true ;; esac",
    "  case \"$existing_job\" in ''|*[!0-9A-Za-z_-]*) metadata_valid=0 ;; esac",
    "  case \"$existing_script\" in /*) ;; *) metadata_valid=0 ;; esac",
    "  if [ \"$metadata_valid\" -eq 1 ] && [ \"$owner_alive\" -eq 1 ] && [ -r \"/proc/$existing_owner/cmdline\" ] && [ -e \"/proc/$existing_owner/cwd\" ]; then",
    "    owner_inspected=1",
    "    process_args=\"$(tr '\\000' ' ' < \"/proc/$existing_owner/cmdline\")\"",
    "    process_cwd=\"$(readlink -f -- \"/proc/$existing_owner/cwd\" 2>/dev/null || true)\"",
    "    expected_cwd=\"$(readlink -f -- \"${existing_script%/*}\" 2>/dev/null || true)\"",
    "    case \"$process_args\" in *\"$existing_script\"*) [ \"$process_cwd\" = \"$expected_cwd\" ] && owner_is_updater=1 ;; esac",
    "  fi",
    "  if [ \"$owner_is_updater\" -eq 1 ]; then printf '%s\\n' \"A self-update is already running (job $existing_job).\" >&2; exit 75; fi",
    "  if [ \"$owner_alive\" -eq 1 ] && [ \"$owner_inspected\" -eq 0 ]; then printf '%s\\n' 'A self-update lock has an uninspectable live owner.' >&2; exit 75; fi",
    "  if [ \"$lock_age\" -lt 120 ] && { [ \"$metadata_valid\" -eq 0 ] || [ \"$owner_alive\" -eq 1 ]; }; then printf '%s\\n' 'A recent self-update lock is still initializing.' >&2; exit 75; fi",
    "  suffix=\"$existing_owner\"; case \"$suffix\" in ''|*[!0-9]*) suffix=unknown ;; esac",
    "  stale=\"${LOCK_PATH}.stale.$$.${suffix}\"",
    "  mv -- \"$LOCK_PATH\" \"$stale\" 2>/dev/null || { printf '%s\\n' 'The stale self-update lock changed during recovery.' >&2; exit 75; }",
    "  rm -f -- \"$stale/owner\" \"$stale/job\" \"$stale/script\"; rmdir -- \"$stale\" 2>/dev/null || true",
    "  mkdir -- \"$LOCK_PATH\" 2>/dev/null || { printf '%s\\n' 'Another self-update acquired the manager-host lock.' >&2; exit 75; }",
    "fi",
    "printf '%s\\n' \"$$\" > \"$LOCK_PATH/owner\"",
    "printf '%s\\n' \"$JOB_ID\" > \"$LOCK_PATH/job\"",
    "printf '%s\\n' \"$SCRIPT_PATH\" > \"$LOCK_PATH/script\"",
    "chmod 700 \"$SCRIPT_PATH\" || { release_lock; exit 1; }",
    "nohup \"$SCRIPT_PATH\" > \"$LOG_PATH\" 2>&1 < /dev/null & child_pid=$!",
    "owner_tmp=\"$LOCK_PATH/owner.$$\"; printf '%s\\n' \"$child_pid\" > \"$owner_tmp\"; mv -- \"$owner_tmp\" \"$LOCK_PATH/owner\"",
    "printf '%s\\n' \"$child_pid\""
  ].join("\n");
}

function bridgePreflightScript(payload: SelfUpdatePayload, socketPath: string) {
  return [
    "#!/bin/sh",
    "set -eu",
    dockerShellExports(socketPath),
    `cd ${shQuote(payload.workingDir)}`,
    `COMPOSE_FILE=${shQuote(payload.composeFile)}`,
    "working_real=\"$(readlink -f -- .)\"",
    "compose_real=\"$(readlink -f -- \"$COMPOSE_FILE\")\"",
    "[ -n \"$working_real\" ] && [ -n \"$compose_real\" ] && [ -f \"$compose_real\" ]",
    "case \"$compose_real\" in \"$working_real\"/*) ;; *) printf '%s\\n' 'Compose file escapes the configured working directory.' >&2; exit 64 ;; esac",
    "services=\"$(docker compose -f \"$COMPOSE_FILE\" config --services)\"",
    "printf '%s\\n' \"$services\" | grep -Fx app >/dev/null",
    "printf '%s\\n' \"$services\" | grep -Fx worker >/dev/null",
    "config_tmp=\"$(mktemp /tmp/composebastion-bridge-preflight.XXXXXX)\"",
    "trap 'rm -f -- \"$config_tmp\"' EXIT HUP INT TERM",
    "docker compose -f \"$COMPOSE_FILE\" config > \"$config_tmp\"",
    "service_block() { awk -v service=\"$1\" '$0 == \"  \" service \":\" { active=1; next } active && /^  [^ ]/ { exit } active { print }' \"$config_tmp\"; }",
    "service_block app | grep -F 'apps/api/dist/server.js' >/dev/null",
    "service_block worker | grep -F 'apps/api/dist/worker.js' >/dev/null",
    "app_id=\"$(docker compose -f \"$COMPOSE_FILE\" ps -q app | sed -n '1p')\"",
    "worker_id=\"$(docker compose -f \"$COMPOSE_FILE\" ps -q worker | sed -n '1p')\"",
    "[ -n \"$app_id\" ] && [ -n \"$worker_id\" ]",
    "for id in \"$app_id\" \"$worker_id\"; do",
    "  [ \"$(docker inspect --format '{{ index .Config.Labels \"org.opencontainers.image.title\" }}' \"$id\")\" = ComposeBastion ]",
    `  [ "$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "$id")" = ${shQuote(COMPOSEBASTION_IMAGE_SOURCE)} ]`,
    "done",
    "[ \"$(docker inspect --format '{{.Image}}' \"$app_id\")\" = \"$(docker inspect --format '{{.Image}}' \"$worker_id\")\" ]"
  ].join("\n");
}

export async function runSelfUpdate(
  hostId: string,
  payload: SelfUpdatePayload,
  options: {
    jobId?: string;
    onProgress?: (stepId: "prepare" | "handoff", detail?: string) => Promise<void> | void;
  } = {}
) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") {
    throw new Error("Self-update currently requires the manager host to use SSH mode so ComposeBastion can start a detached host-side update script.");
  }

  await options.onProgress?.("prepare", "Checking compose directory and file on the manager host");
  const preflight = bridgePreflightScript(payload, host.public.dockerSocketPath);
  const preflightResult = await runSshCommand(host.ssh, preflight, { timeoutMs: 60_000 });
  if (preflightResult.code !== 0) {
    throw new Error(preflightResult.stderr || preflightResult.stdout || "Self-update preflight failed");
  }

  const jobId = (options.jobId ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "");
  const scriptPath = bridgeArtifactPath(payload.workingDir, jobId, "sh");
  const logPath = bridgeArtifactPath(payload.workingDir, jobId, "log");
  const outcomePath = bridgeArtifactPath(payload.workingDir, jobId, "outcome");
  const gatePath = bridgeArtifactPath(payload.workingDir, jobId, "gate");
  const envBackupPath = bridgeArtifactPath(payload.workingDir, jobId, "env.backup");
  const rollbackComposePath = bridgeArtifactPath(payload.workingDir, jobId, "rollback.yml");
  const lockPath = BRIDGE_SELF_UPDATE_LOCK_PATH;
  const program = await readFile(new URL("../../../../scripts/bridge-self-update.sh", import.meta.url), "utf8");
  const controls = buildBridgeSelfUpdateControls(payload, host.public.dockerSocketPath, {
    jobId,
    lockPath,
    outcomePath,
    gatePath,
    envBackupPath,
    rollbackComposePath
  });
  await writeRemoteFile(host.ssh, scriptPath, `${controls}\n${program.trim()}\n`);

  await options.onProgress?.("handoff", "Starting detached host-side update script");
  const launch = buildBridgeSelfUpdateLaunchScript({ jobId, scriptPath, logPath, lockPath });
  const launchResult = await runSshCommand(host.ssh, launch, { timeoutMs: 30_000 });
  if (launchResult.code !== 0) {
    throw new Error(launchResult.stderr || launchResult.stdout || "Self-update handoff failed");
  }

  return {
    handoffStarted: true,
    handoffPending: true,
    pid: launchResult.stdout.trim() || null,
    targetVersion: payload.targetVersion,
    workingDir: payload.workingDir,
    composeFile: payload.composeFile,
    scriptPath,
    logPath,
    outcomePath,
    gatePath,
    lockPath,
    handedOffAt: new Date().toISOString()
  } satisfies BridgeSelfUpdateHandoff;
}

export async function confirmBridgeSelfUpdateHandoff(hostId: string, handoff: BridgeSelfUpdateHandoff) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Self-update handoff confirmation requires SSH mode");
  const result = await runSshCommand(
    host.ssh,
    `umask 077 && : > ${shQuote(handoff.gatePath)}`,
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Self-update handoff confirmation failed");
}

export function parseBridgeSelfUpdateOutcome(
  contents: string,
  expectedJobId: string,
  expectedTargetVersion: string
): BridgeSelfUpdateOutcome {
  const fields = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Bridge self-update outcome contains an invalid field");
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error("Bridge self-update outcome contains a duplicate field");
    fields.set(key, line.slice(separator + 1));
  }
  const allowedKeys = new Set(["schema", "job_id", "status", "stage", "rollback", "target_version", "exit_code"]);
  if (fields.size !== allowedKeys.size || Array.from(fields.keys()).some((key) => !allowedKeys.has(key))) {
    throw new Error("Bridge self-update outcome has an unexpected schema");
  }
  if (fields.get("schema") !== "1"
      || fields.get("job_id") !== expectedJobId
      || fields.get("target_version") !== expectedTargetVersion) {
    throw new Error("Bridge self-update outcome does not match the pending handoff");
  }
  const status = fields.get("status");
  const stage = fields.get("stage") ?? "";
  const rollback = fields.get("rollback");
  const exitCodeText = fields.get("exit_code") ?? "";
  if ((status !== "passed" && status !== "failed")
      || !/^[a-z][a-z0-9_]{0,63}$/.test(stage)
      || !["not_required", "succeeded", "failed"].includes(rollback ?? "")
      || !/^(?:0|[1-9][0-9]{0,2})$/.test(exitCodeText)) {
    throw new Error("Bridge self-update outcome contains an invalid value");
  }
  const exitCode = Number(exitCodeText);
  if ((status === "passed" && (stage !== "complete" || rollback !== "not_required" || exitCode !== 0))
      || (status === "failed" && exitCode === 0)) {
    throw new Error("Bridge self-update outcome is internally inconsistent");
  }
  return {
    status,
    stage,
    rollback: rollback as BridgeSelfUpdateOutcome["rollback"],
    targetVersion: expectedTargetVersion,
    exitCode
  };
}

async function finalizePendingBridgeSelfUpdate(jobId: string, outcome: BridgeSelfUpdateOutcome) {
  const completed = outcome.status === "passed";
  const error = completed
    ? null
    : `Self-update failed during ${outcome.stage}; rollback ${outcome.rollback.replace("_", " ")}.`;
  const result = await query(
    `UPDATE operation_jobs
     SET status = $2,
         result = COALESCE(result, '{}'::jsonb) || $3::jsonb,
         error = $4,
         progress = $5::jsonb,
         completed_at = now(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1
       AND type = 'system.self_update'
       AND status = 'running'
       AND result ->> 'handoffPending' = 'true'
     RETURNING id`,
    [
      jobId,
      completed ? "completed" : "failed",
      JSON.stringify({
        handoffPending: false,
        outcome: {
          status: outcome.status,
          stage: outcome.stage,
          rollback: outcome.rollback,
          targetVersion: outcome.targetVersion,
          exitCode: outcome.exitCode
        },
        reconciledAt: new Date().toISOString()
      }),
      error,
      JSON.stringify(buildJobProgress("system.self_update", completed ? "completed" : "failed", "reconnect", error ?? undefined))
    ]
  );
  return result.rowCount === 1;
}

async function failUnreconciledBridgeSelfUpdate(jobId: string, message: string) {
  const result = await query(
    `UPDATE operation_jobs
     SET status = 'failed',
         result = COALESCE(result, '{}'::jsonb) || $2::jsonb,
         error = $3,
         progress = $4::jsonb,
         completed_at = now(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1
       AND type = 'system.self_update'
       AND status = 'running'
       AND result ->> 'handoffPending' = 'true'
     RETURNING id`,
    [
      jobId,
      JSON.stringify({ handoffPending: false, reconciledAt: new Date().toISOString() }),
      message,
      JSON.stringify(buildJobProgress("system.self_update", "failed", "reconnect", message))
    ]
  );
  return result.rowCount === 1;
}

function pendingHandoffAgeMs(row: any) {
  const handedOffAt = typeof row.result?.handedOffAt === "string" ? Date.parse(row.result.handedOffAt) : Number.NaN;
  const fallback = new Date(row.updated_at ?? row.started_at ?? row.created_at).getTime();
  return Date.now() - (Number.isFinite(handedOffAt) ? handedOffAt : fallback);
}

export async function reconcileBridgeSelfUpdateHandoffs() {
  const pending = await query(
    `SELECT *
     FROM operation_jobs
     WHERE type = 'system.self_update'
       AND status = 'running'
       AND result ->> 'handoffPending' = 'true'
     ORDER BY created_at ASC
     LIMIT 20`
  );
  let completed = 0;
  let failed = 0;
  let pendingCount = 0;
  for (const row of pending.rows) {
    const ageMs = pendingHandoffAgeMs(row);
    try {
      const action = dockerActionSchema.parse({ type: row.type, hostId: row.host_id, payload: row.payload });
      if (action.type !== "system.self_update") throw new Error("Pending bridge job is not a self-update");
      const executionId = String(row.id).replace(/[^a-zA-Z0-9_-]/g, "");
      const outcomePath = bridgeArtifactPath(action.payload.workingDir, executionId, "outcome");
      const scriptPath = bridgeArtifactPath(action.payload.workingDir, executionId, "sh");
      const host = await getHostForWorker(action.hostId);
      if (host.connectionMode !== "ssh") {
        if (await failUnreconciledBridgeSelfUpdate(row.id, "Self-update outcome could not be reconciled because the manager host is no longer configured for SSH.")) failed += 1;
        continue;
      }
      const outcomeResult = await runSshCommand(
        host.ssh,
        `if [ -f ${shQuote(outcomePath)} ]; then cat -- ${shQuote(outcomePath)}; else exit 44; fi`,
        { timeoutMs: 30_000 }
      );
      if (outcomeResult.code === 0) {
        let outcome: BridgeSelfUpdateOutcome;
        try {
          outcome = parseBridgeSelfUpdateOutcome(outcomeResult.stdout, row.id, action.payload.targetVersion);
        } catch {
          if (await failUnreconciledBridgeSelfUpdate(row.id, "Self-update wrote an invalid authoritative outcome.")) failed += 1;
          continue;
        }
        if (await finalizePendingBridgeSelfUpdate(row.id, outcome)) {
          if (outcome.status === "passed") completed += 1;
          else failed += 1;
        }
        continue;
      }
      const lockResult = await runSshCommand(
        host.ssh,
        [
          `owner="$(sed -n '1p' ${shQuote(`${BRIDGE_SELF_UPDATE_LOCK_PATH}/owner`)} 2>/dev/null || true)"`,
          `owner_job="$(sed -n '1p' ${shQuote(`${BRIDGE_SELF_UPDATE_LOCK_PATH}/job`)} 2>/dev/null || true)"`,
          `owner_script="$(sed -n '1p' ${shQuote(`${BRIDGE_SELF_UPDATE_LOCK_PATH}/script`)} 2>/dev/null || true)"`,
          `if [ "$owner_job" = ${shQuote(row.id)} ] && [ "$owner_script" = ${shQuote(scriptPath)} ] && case "$owner" in ''|*[!0-9]*) false ;; *) kill -0 "$owner" 2>/dev/null ;; esac; then`,
          "  process_args=\"$(tr '\\000' ' ' < \"/proc/$owner/cmdline\" 2>/dev/null || true)\"",
          "  process_cwd=\"$(readlink -f -- \"/proc/$owner/cwd\" 2>/dev/null || true)\"",
          `  expected_cwd="$(readlink -f -- ${shQuote(action.payload.workingDir)} 2>/dev/null || true)"`,
          `  case "$process_args" in *${shQuote(scriptPath)}*) [ "$process_cwd" = "$expected_cwd" ] && exit 0 ;; esac`,
          "fi",
          "exit 1"
        ].join("\n"),
        { timeoutMs: 30_000 }
      );
      if (lockResult.code === 0 && ageMs < SELF_UPDATE_HANDOFF_TIMEOUT_MS) {
        pendingCount += 1;
        continue;
      }
      if (ageMs < SELF_UPDATE_MISSING_OUTCOME_GRACE_MS) {
        pendingCount += 1;
        continue;
      }
      const message = ageMs >= SELF_UPDATE_HANDOFF_TIMEOUT_MS
        ? "Self-update handoff timed out before an authoritative outcome was written."
        : "Self-update process exited without writing an authoritative outcome.";
      if (await failUnreconciledBridgeSelfUpdate(row.id, message)) failed += 1;
    } catch {
      if (ageMs >= SELF_UPDATE_HANDOFF_TIMEOUT_MS) {
        if (await failUnreconciledBridgeSelfUpdate(row.id, "Self-update outcome could not be reconciled before the handoff timeout.")) failed += 1;
      } else {
        pendingCount += 1;
      }
    }
  }
  return { completed, failed, pending: pendingCount };
}
