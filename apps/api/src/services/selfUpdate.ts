import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  compareReleaseVersions,
  dockerActionSchema,
  isStableReleaseVersion,
  parseReleaseVersion,
  selfUpdateConfigInputSchema,
  selfUpdateConfigSchema,
  type DockerActionRequest
} from "@composebastion/shared";
import type pg from "pg";
import { query, withTransaction } from "../db/pool.js";
import { shQuote } from "./commands.js";
import { getHostForWorker } from "./hosts.js";
import {
  buildJobProgress,
  enqueueJob,
  enqueueJobInTransaction,
  notifyJobQueued
} from "./jobs.js";
import { mapJob } from "./mappers.js";
import { runSshCommand, writeRemoteFile } from "./ssh.js";
import { runtimeVersionMetadata } from "./version.js";

const SELF_UPDATE_CONFIG_KEY = "self_update.config";
const SELF_UPDATE_LATEST_KEY = "self_update.latest";
const GITHUB_API_REPO = "https://api.github.com/repos/composebastion-admin/composebastion";
const GITHUB_REPO_URL = "https://github.com/composebastion-admin/composebastion";
const DOCKER_SSH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin";
export const SELF_UPDATE_LOCK_PATH = "/tmp/composebastion-self-update.lock";
const SELF_UPDATE_MISSING_OUTCOME_GRACE_MS = 2 * 60_000;
const SELF_UPDATE_HANDOFF_TIMEOUT_MS = 30 * 60_000;
const COMPOSEBASTION_IMAGE_SOURCE = "https://github.com/composebastion-admin/composebastion";

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

async function readSetting<T>(key: string, client?: pg.PoolClient) {
  const execute = client ? client.query.bind(client) : query;
  const result = await execute<{ value: T }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [key]
  );
  return result.rows[0]?.value ?? null;
}

async function writeSetting(key: string, value: unknown, client?: pg.PoolClient) {
  const execute = client ? client.query.bind(client) : query;
  await execute(
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

export async function saveSelfUpdateConfig(
  input: unknown,
  onChanged?: (
    client: pg.PoolClient,
    config: ReturnType<typeof selfUpdateConfigSchema.parse>
  ) => Promise<void>
) {
  const patch = selfUpdateConfigInputSchema.parse(input);
  return withTransaction(async (client) => {
    const stored = await readSetting<unknown>(SELF_UPDATE_CONFIG_KEY, client);
    const current = selfUpdateConfigSchema.parse({
      ...defaultSelfUpdateConfig,
      ...(stored && typeof stored === "object" ? stored : {})
    });
    const next = selfUpdateConfigSchema.parse({
      ...current,
      ...patch
    });

    if (next.hostId) {
      const host = await client.query(
        "SELECT id FROM docker_hosts WHERE id = $1 AND deleted_at IS NULL",
        [next.hostId]
      );
      if (!host.rows[0]) {
        throw Object.assign(
          new Error("Selected manager host was not found"),
          { statusCode: 404 }
        );
      }
    }

    await writeSetting(SELF_UPDATE_CONFIG_KEY, next, client);
    await onChanged?.(client, next);
    return next;
  });
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

export async function checkSelfUpdateLatest(
  onChanged?: (
    client: pg.PoolClient,
    latest: LatestRelease
  ) => Promise<void>
) {
  let latest: LatestRelease;
  try {
    latest = await fetchLatestRelease();
  } catch (caught) {
    latest = {
      version: null,
      checkedAt: new Date().toISOString(),
      error: caught instanceof Error ? caught.message : String(caught)
    };
  }
  return withTransaction(async (client) => {
    await writeSetting(SELF_UPDATE_LATEST_KEY, latest, client);
    await onChanged?.(client, latest);
    return latest;
  });
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

export async function enqueueSelfUpdate(
  input: { targetVersion?: string },
  createdBy?: string | null,
  onQueued?: (
    client: pg.PoolClient,
    job: Awaited<ReturnType<typeof enqueueJobInTransaction>>
  ) => Promise<void>
) {
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
  if (!onQueued) return enqueueJob(action, createdBy ?? null);

  const job = await withTransaction(async (client) => {
    const queued = await enqueueJobInTransaction(client, action, createdBy ?? null);
    await onQueued(client, queued);
    return queued;
  });
  await notifyJobQueued(job.id);
  return job;
}

function dockerShellExports(socketPath: string) {
  return [
    `export PATH=${DOCKER_SSH_PATH}:$PATH`,
    `export DOCKER_HOST=${shQuote(`unix://${socketPath}`)}`
  ].join("\n");
}

function envUpdateScript(targetVersion: string) {
  const replacement = `COMPOSEBASTION_VERSION=${targetVersion}`;
  return [
    `tmp="$(mktemp .env.composebastion.XXXXXX)"`,
    "if [ -f .env ]; then",
    `  awk -v replacement=${shQuote(replacement)} 'BEGIN { done = 0 } /^COMPOSEBASTION_VERSION=/ { print replacement; done = 1; next } { print } END { if (!done) print replacement }' .env > "$tmp"`,
    "else",
    `  printf '%s\\n' ${shQuote(replacement)} > "$tmp"`,
    "fi",
    "mv \"$tmp\" .env"
  ].join("\n");
}

export type SelfUpdateHandoff = {
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

type SelfUpdateOutcome = {
  status: "passed" | "failed";
  stage: string;
  rollback: "not_required" | "succeeded" | "failed";
  targetVersion: string;
  exitCode: number;
};

function selfUpdateArtifactPath(workingDir: string, jobId: string, suffix: "sh" | "log" | "outcome" | "gate" | "env.backup" | "rollback.yml") {
  return path.posix.join(workingDir, `.composebastion-self-update-${jobId}.${suffix}`);
}

export function buildSelfUpdateScript(
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
  const { jobId, lockPath, outcomePath, gatePath, envBackupPath, rollbackComposePath } = input;
  const upgradeStateDirectory = path.posix.join(payload.workingDir, `.composebastion-self-update-${jobId}.upgrade`);
  return [
    "#!/bin/sh",
    "set -u",
    "umask 077",
    dockerShellExports(socketPath),
    `LOCK_PATH=${shQuote(lockPath)}`,
    `OUTCOME_PATH=${shQuote(outcomePath)}`,
    `GATE_PATH=${shQuote(gatePath)}`,
    `ENV_BACKUP_PATH=${shQuote(envBackupPath)}`,
    `ROLLBACK_COMPOSE_PATH=${shQuote(rollbackComposePath)}`,
    `UPGRADE_STATE_DIR=${shQuote(upgradeStateDirectory)}`,
    "COMPOSE_CONFIG_PATH=\"$UPGRADE_STATE_DIR/compose-config.json\"",
    "CANDIDATE_COMPOSE_PATH=\"$UPGRADE_STATE_DIR/candidate.yml\"",
    "DATABASE_STATE_PATH=\"$UPGRADE_STATE_DIR/database-transition.json\"",
    `COMPOSE_FILE=${shQuote(payload.composeFile)}`,
    `TARGET_VERSION=${shQuote(payload.targetVersion)}`,
    `JOB_ID=${shQuote(jobId)}`,
    "DOCKER_BIN=\"${COMPOSEBASTION_SELF_UPDATE_DOCKER_BIN:-docker}\"",
    "ENV_EXISTED=0",
    "ENV_CHANGED=0",
    "SERVICES_TOUCHED=0",
    "PREVIOUS_APP_VERSION=",
    "PREVIOUS_WORKER_VERSION=",
    "PREVIOUS_APP_IMAGE_ID=",
    "PREVIOUS_WORKER_IMAGE_ID=",
    "PREVIOUS_APP_IMAGE_REF=",
    "PREVIOUS_WORKER_IMAGE_REF=",
    "CANDIDATE_APP_IMAGE_ID=",
    "CANDIDATE_WORKER_IMAGE_ID=",
    "release_lock() {",
    "  owner=\"$(sed -n '1p' \"$LOCK_PATH/owner\" 2>/dev/null || true)\"",
    "  if [ \"$owner\" = \"$$\" ]; then",
    "    rm -f -- \"$LOCK_PATH/owner\" \"$LOCK_PATH/job\" \"$LOCK_PATH/script\"",
    "    rmdir -- \"$LOCK_PATH\" 2>/dev/null || true",
    "  fi",
    "}",
    "write_outcome() {",
    "  outcome_status=\"$1\"",
    "  outcome_stage=\"$2\"",
    "  outcome_rollback=\"$3\"",
    "  outcome_code=\"$4\"",
    "  outcome_tmp=\"${OUTCOME_PATH}.tmp.$$\"",
    "  {",
    "    printf 'schema=1\\n'",
    "    printf 'job_id=%s\\n' \"$JOB_ID\"",
    "    printf 'status=%s\\n' \"$outcome_status\"",
    "    printf 'stage=%s\\n' \"$outcome_stage\"",
    "    printf 'rollback=%s\\n' \"$outcome_rollback\"",
    "    printf 'target_version=%s\\n' \"$TARGET_VERSION\"",
    "    printf 'exit_code=%s\\n' \"$outcome_code\"",
    "  } > \"$outcome_tmp\"",
    "  mv -- \"$outcome_tmp\" \"$OUTCOME_PATH\"",
    "}",
    "cleanup_upgrade_state() {",
    "  rm -f -- \"$COMPOSE_CONFIG_PATH\" \"$CANDIDATE_COMPOSE_PATH\" \"$DATABASE_STATE_PATH\"",
    "  rmdir -- \"$UPGRADE_STATE_DIR\" 2>/dev/null || true",
    "}",
    "run_upgrade_preparation() {",
    "  preparation_mode=\"$1\"",
    "  \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" -f \"$CANDIDATE_COMPOSE_PATH\" run --rm --no-deps --user 0:0 \\",
    "    --volume \"$UPGRADE_STATE_DIR:/run/composebastion-upgrade\" \\",
    "    app node /app/scripts/prepare-compose-upgrade.mjs \"$preparation_mode\" \\",
    "    --compose-config /run/composebastion-upgrade/compose-config.json \\",
    "    --state-file /run/composebastion-upgrade/database-transition.json",
    "}",
    "case \"$DOCKER_BIN\" in docker|/*) ;; *) write_outcome failed docker_binary not_required 64; release_lock; exit 64 ;; esac",
    "update_environment() {",
    envUpdateScript(payload.targetVersion),
    "}",
    "container_id() {",
    "  \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" ps -q \"$1\" 2>/dev/null | sed -n '1p'",
    "}",
    "container_is_composebastion() {",
    "  identity_id=\"$1\"",
    "  identity_title=\"$(\"$DOCKER_BIN\" inspect --format '{{ index .Config.Labels \"org.opencontainers.image.title\" }}' \"$identity_id\" 2>/dev/null || true)\"",
    "  identity_source=\"$(\"$DOCKER_BIN\" inspect --format '{{ index .Config.Labels \"org.opencontainers.image.source\" }}' \"$identity_id\" 2>/dev/null || true)\"",
    `  [ "$identity_title" = "ComposeBastion" ] && [ "$identity_source" = ${shQuote(COMPOSEBASTION_IMAGE_SOURCE)} ]`,
    "}",
    "stack_is_ready() {",
    "  expected_app_version=\"$1\"",
    "  expected_worker_version=\"$2\"",
    "  expected_app_image_id=\"$3\"",
    "  expected_worker_image_id=\"$4\"",
    "  ready_app_id=\"$(container_id app)\"",
    "  ready_worker_id=\"$(container_id worker)\"",
    "  [ -n \"$ready_app_id\" ] && [ -n \"$ready_worker_id\" ] || return 1",
    "  [ \"$(\"$DOCKER_BIN\" inspect --format '{{.State.Running}}' \"$ready_app_id\" 2>/dev/null || true)\" = \"true\" ] || return 1",
    "  [ \"$(\"$DOCKER_BIN\" inspect --format '{{.State.Health.Status}}' \"$ready_app_id\" 2>/dev/null || true)\" = \"healthy\" ] || return 1",
    "  [ \"$(\"$DOCKER_BIN\" inspect --format '{{.State.Running}}' \"$ready_worker_id\" 2>/dev/null || true)\" = \"true\" ] || return 1",
    "  container_is_composebastion \"$ready_app_id\" || return 1",
    "  container_is_composebastion \"$ready_worker_id\" || return 1",
    "  ready_app_version=\"$(\"$DOCKER_BIN\" inspect --format '{{ index .Config.Labels \"org.opencontainers.image.version\" }}' \"$ready_app_id\" 2>/dev/null || true)\"",
    "  ready_worker_version=\"$(\"$DOCKER_BIN\" inspect --format '{{ index .Config.Labels \"org.opencontainers.image.version\" }}' \"$ready_worker_id\" 2>/dev/null || true)\"",
    "  ready_app_image_id=\"$(\"$DOCKER_BIN\" inspect --format '{{.Image}}' \"$ready_app_id\" 2>/dev/null || true)\"",
    "  ready_worker_image_id=\"$(\"$DOCKER_BIN\" inspect --format '{{.Image}}' \"$ready_worker_id\" 2>/dev/null || true)\"",
    "  [ -n \"$ready_app_version\" ] && [ \"$ready_app_version\" != \"unknown\" ] || return 1",
    "  [ -n \"$ready_worker_version\" ] && [ \"$ready_worker_version\" != \"unknown\" ] || return 1",
    "  if [ \"$expected_app_version\" != \"latest\" ]; then",
    "    normalized_expected_app=\"${expected_app_version#v}\"",
    "    normalized_actual_app=\"${ready_app_version#v}\"",
    "    [ \"$normalized_actual_app\" = \"$normalized_expected_app\" ] || return 1",
    "  fi",
    "  if [ \"$expected_worker_version\" != \"latest\" ]; then",
    "    normalized_expected_worker=\"${expected_worker_version#v}\"",
    "    normalized_actual_worker=\"${ready_worker_version#v}\"",
    "    [ \"$normalized_actual_worker\" = \"$normalized_expected_worker\" ] || return 1",
    "  fi",
    "  [ \"$ready_app_version\" = \"$ready_worker_version\" ] || return 1",
    "  if [ -n \"$expected_app_image_id\" ]; then [ \"$ready_app_image_id\" = \"$expected_app_image_id\" ] || return 1; fi",
    "  if [ -n \"$expected_worker_image_id\" ]; then [ \"$ready_worker_image_id\" = \"$expected_worker_image_id\" ] || return 1; fi",
    "  \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" exec -T app node -e 'const expected=process.argv[1].replace(/^v/, \"\"); const label=process.argv[2].replace(/^v/, \"\"); Promise.all([fetch(\"http://127.0.0.1:8080/api/health\").then(r=>r.ok?r.json():Promise.reject(new Error(\"health\"))),fetch(\"http://127.0.0.1:8080/api/health/ready\").then(r=>r.ok?r.json():Promise.reject(new Error(\"ready\")))]).then(([health,ready])=>{const actual=String(health.version||\"\").replace(/^v/, \"\"); if(!health.ok||!ready.ok||!ready.checks?.worker?.ok||!actual||actual===\"unknown\"||actual!==label||(expected!==\"latest\"&&actual!==expected))process.exit(1)}).catch(()=>process.exit(1))' \"$expected_app_version\" \"$ready_app_version\" >/dev/null 2>&1",
    "}",
    "wait_for_stack() {",
    "  wait_expected_app_version=\"$1\"",
    "  wait_expected_worker_version=\"$2\"",
    "  wait_expected_app_image_id=\"$3\"",
    "  wait_expected_worker_image_id=\"$4\"",
    "  wait_attempts=\"${COMPOSEBASTION_SELF_UPDATE_VERIFY_ATTEMPTS:-60}\"",
    "  case \"$wait_attempts\" in ''|*[!0-9]*) wait_attempts=60 ;; esac",
    "  [ \"$wait_attempts\" -ge 1 ] || wait_attempts=1",
    "  wait_index=0",
    "  while [ \"$wait_index\" -lt \"$wait_attempts\" ]; do",
    "    if stack_is_ready \"$wait_expected_app_version\" \"$wait_expected_worker_version\" \"$wait_expected_app_image_id\" \"$wait_expected_worker_image_id\"; then return 0; fi",
    "    wait_index=$((wait_index + 1))",
    "    [ \"$wait_index\" -ge \"$wait_attempts\" ] || sleep \"${COMPOSEBASTION_SELF_UPDATE_VERIFY_INTERVAL_SECONDS:-2}\"",
    "  done",
    "  return 1",
    "}",
    "fail_update() {",
    "  failed_stage=\"$1\"",
    "  failed_code=\"$2\"",
    "  trap - HUP INT TERM",
    "  rollback_status=failed",
    "  credential_restored=1",
    "  if [ \"$SERVICES_TOUCHED\" -eq 1 ]; then",
    "    \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" stop app worker >/dev/null 2>&1 || true",
    "  fi",
    "  if [ -f \"$DATABASE_STATE_PATH\" ]; then",
    "    if ! run_upgrade_preparation restore-legacy >/dev/null 2>&1; then credential_restored=0; fi",
    "  fi",
    "  environment_restored=1",
    "  if [ \"$ENV_CHANGED\" -eq 1 ]; then",
    "    if [ \"$ENV_EXISTED\" -eq 1 ]; then",
    "      cp -p -- \"$ENV_BACKUP_PATH\" .env 2>/dev/null || environment_restored=0",
    "    else",
    "      rm -f -- .env || environment_restored=0",
    "    fi",
    "  fi",
    "  rollback_ready=0",
    "  references_restored=1",
    "  case \"$PREVIOUS_APP_IMAGE_ID:$PREVIOUS_WORKER_IMAGE_ID\" in sha256:*:sha256:*) rollback_ready=1 ;; esac",
    "  if [ \"$rollback_ready\" -eq 1 ]; then",
    "    case \"$PREVIOUS_APP_IMAGE_REF\" in sha256:*|*@sha256:*) ;; *) \"$DOCKER_BIN\" image tag \"$PREVIOUS_APP_IMAGE_ID\" \"$PREVIOUS_APP_IMAGE_REF\" >/dev/null 2>&1 || references_restored=0 ;; esac",
    "    case \"$PREVIOUS_WORKER_IMAGE_REF\" in sha256:*|*@sha256:*) ;; *) \"$DOCKER_BIN\" image tag \"$PREVIOUS_WORKER_IMAGE_ID\" \"$PREVIOUS_WORKER_IMAGE_REF\" >/dev/null 2>&1 || references_restored=0 ;; esac",
    "  fi",
    "  if [ \"$SERVICES_TOUCHED\" -eq 0 ] && [ \"$environment_restored\" -eq 1 ] && [ \"$credential_restored\" -eq 1 ]; then",
    "    rollback_status=succeeded",
    "  elif [ \"$rollback_ready\" -eq 1 ] && \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" -f \"$ROLLBACK_COMPOSE_PATH\" up -d --pull never --no-deps --force-recreate app worker >/dev/null 2>&1 && wait_for_stack \"$PREVIOUS_APP_VERSION\" \"$PREVIOUS_WORKER_VERSION\" \"$PREVIOUS_APP_IMAGE_ID\" \"$PREVIOUS_WORKER_IMAGE_ID\" && [ \"$environment_restored\" -eq 1 ] && [ \"$references_restored\" -eq 1 ] && [ \"$credential_restored\" -eq 1 ]; then",
    "    rollback_status=succeeded",
    "  fi",
    "  rm -f -- \"$GATE_PATH\"",
    "  if [ \"$rollback_status\" = succeeded ]; then",
    "    rm -f -- \"$ENV_BACKUP_PATH\" \"$ROLLBACK_COMPOSE_PATH\"",
    "    cleanup_upgrade_state",
    "  fi",
    "  write_outcome failed \"$failed_stage\" \"$rollback_status\" \"$failed_code\"",
    "  release_lock",
    "  exit \"$failed_code\"",
    "}",
    "trap 'fail_update interrupted 130' HUP INT TERM",
    `if ! cd ${shQuote(payload.workingDir)}; then`,
    "  write_outcome failed working_directory not_required 1",
    "  release_lock",
    "  exit 1",
    "fi",
    "owner_wait=0",
    "while [ \"$(sed -n '1p' \"$LOCK_PATH/owner\" 2>/dev/null || true)\" != \"$$\" ] && [ \"$owner_wait\" -lt 10 ]; do",
    "  owner_wait=$((owner_wait + 1))",
    "  sleep 1",
    "done",
    "if [ \"$(sed -n '1p' \"$LOCK_PATH/owner\" 2>/dev/null || true)\" != \"$$\" ]; then",
    "  write_outcome failed lock_ownership not_required 75",
    "  exit 75",
    "fi",
    "gate_wait=0",
    "while [ ! -f \"$GATE_PATH\" ] && [ \"$gate_wait\" -lt \"${COMPOSEBASTION_SELF_UPDATE_GATE_ATTEMPTS:-60}\" ]; do",
    "  gate_wait=$((gate_wait + 1))",
    "  sleep 1",
    "done",
    "if [ ! -f \"$GATE_PATH\" ]; then",
    "  write_outcome failed handoff_confirmation not_required 75",
    "  release_lock",
    "  exit 75",
    "fi",
    "rm -f -- \"$GATE_PATH\"",
    "current_app_id=\"$(container_id app)\"",
    "current_worker_id=\"$(container_id worker)\"",
    "PREVIOUS_APP_VERSION=\"$(\"$DOCKER_BIN\" inspect --format '{{ index .Config.Labels \"org.opencontainers.image.version\" }}' \"$current_app_id\" 2>/dev/null || true)\"",
    "PREVIOUS_WORKER_VERSION=\"$(\"$DOCKER_BIN\" inspect --format '{{ index .Config.Labels \"org.opencontainers.image.version\" }}' \"$current_worker_id\" 2>/dev/null || true)\"",
    "PREVIOUS_APP_IMAGE_ID=\"$(\"$DOCKER_BIN\" inspect --format '{{.Image}}' \"$current_app_id\" 2>/dev/null || true)\"",
    "PREVIOUS_WORKER_IMAGE_ID=\"$(\"$DOCKER_BIN\" inspect --format '{{.Image}}' \"$current_worker_id\" 2>/dev/null || true)\"",
    "PREVIOUS_APP_IMAGE_REF=\"$(\"$DOCKER_BIN\" inspect --format '{{.Config.Image}}' \"$current_app_id\" 2>/dev/null || true)\"",
    "PREVIOUS_WORKER_IMAGE_REF=\"$(\"$DOCKER_BIN\" inspect --format '{{.Config.Image}}' \"$current_worker_id\" 2>/dev/null || true)\"",
    "case \"$PREVIOUS_APP_IMAGE_ID:$PREVIOUS_WORKER_IMAGE_ID\" in sha256:*:sha256:*) ;; *) fail_update prior_image_identity 1 ;; esac",
    "[ \"$PREVIOUS_APP_IMAGE_ID\" = \"$PREVIOUS_WORKER_IMAGE_ID\" ] || fail_update prior_image_identity 1",
    "[ -n \"$PREVIOUS_APP_IMAGE_REF\" ] && [ -n \"$PREVIOUS_WORKER_IMAGE_REF\" ] || fail_update prior_image_identity 1",
    "[ -n \"$PREVIOUS_APP_VERSION\" ] && [ -n \"$PREVIOUS_WORKER_VERSION\" ] || fail_update prior_image_identity 1",
    "{",
    "  printf 'services:\\n'",
    "  printf '  app:\\n    image: %s\\n    pull_policy: never\\n' \"$PREVIOUS_APP_IMAGE_ID\"",
    "  printf '  worker:\\n    image: %s\\n    pull_policy: never\\n' \"$PREVIOUS_WORKER_IMAGE_ID\"",
    "} > \"$ROLLBACK_COMPOSE_PATH\" || fail_update rollback_state 1",
    "if [ -f .env ]; then",
    "  if ! cp -p -- .env \"$ENV_BACKUP_PATH\" || ! chmod 600 \"$ENV_BACKUP_PATH\"; then fail_update env_backup 1; fi",
    "  ENV_EXISTED=1",
    "else",
    "  : > \"$ENV_BACKUP_PATH\"",
    "fi",
    "ENV_CHANGED=1",
    "if ! update_environment; then fail_update env_update 1; fi",
    "if ! \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" pull app worker; then fail_update pull 1; fi",
    "if ! mkdir -m 700 -- \"$UPGRADE_STATE_DIR\"; then fail_update upgrade_state 1; fi",
    "config_tmp=\"$UPGRADE_STATE_DIR/compose-config.tmp.$$\"",
    "if ! \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" config --format json > \"$config_tmp\"; then rm -f -- \"$config_tmp\"; fail_update compose_config 1; fi",
    "if ! chmod 600 \"$config_tmp\" || ! mv -- \"$config_tmp\" \"$COMPOSE_CONFIG_PATH\"; then rm -f -- \"$config_tmp\"; fail_update compose_config 1; fi",
    "config_yaml_tmp=\"$UPGRADE_STATE_DIR/compose-config.tmp.$$.yml\"",
    "if ! \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" config > \"$config_yaml_tmp\"; then rm -f -- \"$config_yaml_tmp\"; fail_update compose_config 1; fi",
    "service_image_from_config() {",
    "  config_service=\"$1\"",
    "  awk -v service=\"$config_service\" '$0 == \"  \" service \":\" { active=1; next } active && /^  [^ ]/ { exit } active && /^    image: / { sub(/^    image: /, \"\"); print; exit }' \"$config_yaml_tmp\"",
    "}",
    "candidate_app_ref=\"$(service_image_from_config app)\"",
    "candidate_worker_ref=\"$(service_image_from_config worker)\"",
    "rm -f -- \"$config_yaml_tmp\"",
    "[ -n \"$candidate_app_ref\" ] && [ -n \"$candidate_worker_ref\" ] || fail_update candidate_image_identity 1",
    "CANDIDATE_APP_IMAGE_ID=\"$(\"$DOCKER_BIN\" image inspect --format '{{.Id}}' \"$candidate_app_ref\" 2>/dev/null || true)\"",
    "CANDIDATE_WORKER_IMAGE_ID=\"$(\"$DOCKER_BIN\" image inspect --format '{{.Id}}' \"$candidate_worker_ref\" 2>/dev/null || true)\"",
    "case \"$CANDIDATE_APP_IMAGE_ID:$CANDIDATE_WORKER_IMAGE_ID\" in sha256:*:sha256:*) ;; *) fail_update candidate_image_identity 1 ;; esac",
    "{",
    "  printf 'services:\\n'",
    "  printf '  app:\\n    image: %s\\n    pull_policy: never\\n' \"$CANDIDATE_APP_IMAGE_ID\"",
    "  printf '  worker:\\n    image: %s\\n    pull_policy: never\\n' \"$CANDIDATE_WORKER_IMAGE_ID\"",
    "} > \"$CANDIDATE_COMPOSE_PATH\" || fail_update candidate_image_identity 1",
    "SERVICES_TOUCHED=1",
    "if ! \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" stop app worker; then fail_update stop 1; fi",
    "if ! run_upgrade_preparation reconcile; then fail_update prepare 1; fi",
    "if ! \"$DOCKER_BIN\" compose -f \"$COMPOSE_FILE\" -f \"$CANDIDATE_COMPOSE_PATH\" up -d --pull never --no-deps --force-recreate app worker; then fail_update up 1; fi",
    "if ! wait_for_stack \"$TARGET_VERSION\" \"$TARGET_VERSION\" \"$CANDIDATE_APP_IMAGE_ID\" \"$CANDIDATE_WORKER_IMAGE_ID\"; then fail_update verification 1; fi",
    "rm -f -- \"$ENV_BACKUP_PATH\" \"$ROLLBACK_COMPOSE_PATH\"",
    "cleanup_upgrade_state",
    "write_outcome passed complete not_required 0",
    "release_lock",
    "exit 0"
  ].join("\n");
}

function preflightScript(payload: SelfUpdatePayload, socketPath: string) {
  return [
    "#!/bin/sh",
    "set -eu",
    dockerShellExports(socketPath),
    `cd ${shQuote(payload.workingDir)}`,
    `COMPOSE_FILE=${shQuote(payload.composeFile)}`,
    "working_real=\"$(readlink -f -- .)\"",
    "compose_real=\"$(readlink -f -- \"$COMPOSE_FILE\")\"",
    "[ -n \"$working_real\" ] && [ -n \"$compose_real\" ] && [ -f \"$compose_real\" ]",
    "if [ \"$working_real\" = / ]; then",
    "  case \"$compose_real\" in /*) ;; *) printf '%s\\n' 'Compose file escapes the configured working directory.' >&2; exit 64 ;; esac",
    "else",
    "  case \"$compose_real\" in \"$working_real\"/*) ;; *) printf '%s\\n' 'Compose file escapes the configured working directory.' >&2; exit 64 ;; esac",
    "fi",
    "services=\"$(docker compose -f \"$COMPOSE_FILE\" config --services)\"",
    "printf '%s\\n' \"$services\" | grep -Fx app >/dev/null",
    "printf '%s\\n' \"$services\" | grep -Fx worker >/dev/null",
    "config_tmp=\"$(mktemp /tmp/composebastion-self-update-config.XXXXXX)\"",
    "trap 'rm -f -- \"$config_tmp\"' EXIT HUP INT TERM",
    "docker compose -f \"$COMPOSE_FILE\" config > \"$config_tmp\"",
    "service_block() {",
    "  awk -v service=\"$1\" '$0 == \"  \" service \":\" { active=1; next } active && /^  [^ ]/ { exit } active { print }' \"$config_tmp\"",
    "}",
    "service_image() {",
    "  service_block \"$1\" | awk '/^    image: / { sub(/^    image: /, \"\"); print; exit }'",
    "}",
    "service_block app | grep -F 'apps/api/dist/server.js' >/dev/null",
    "service_block worker | grep -F 'apps/api/dist/worker.js' >/dev/null",
    "configured_app_image=\"$(service_image app)\"",
    "configured_worker_image=\"$(service_image worker)\"",
    "[ -n \"$configured_app_image\" ] && [ \"$configured_app_image\" = \"$configured_worker_image\" ]",
    "app_id=\"$(docker compose -f \"$COMPOSE_FILE\" ps -q app | sed -n '1p')\"",
    "worker_id=\"$(docker compose -f \"$COMPOSE_FILE\" ps -q worker | sed -n '1p')\"",
    "[ -n \"$app_id\" ] && [ -n \"$worker_id\" ]",
    "for container_id in \"$app_id\" \"$worker_id\"; do",
    "  [ \"$(docker inspect --format '{{ index .Config.Labels \"org.opencontainers.image.title\" }}' \"$container_id\")\" = 'ComposeBastion' ]",
    `  [ "$(docker inspect --format '{{ index .Config.Labels \"org.opencontainers.image.source\" }}' "$container_id")" = ${shQuote(COMPOSEBASTION_IMAGE_SOURCE)} ]`,
    "done",
    "image_repository() {",
    "  image_ref=\"${1%@*}\"",
    "  image_last=\"${image_ref##*/}\"",
    "  case \"$image_last\" in *:*) image_ref=\"${image_ref%:*}\" ;; esac",
    "  printf '%s\\n' \"$image_ref\"",
    "}",
    "current_app_image=\"$(docker inspect --format '{{.Config.Image}}' \"$app_id\")\"",
    "current_worker_image=\"$(docker inspect --format '{{.Config.Image}}' \"$worker_id\")\"",
    "current_app_image_id=\"$(docker inspect --format '{{.Image}}' \"$app_id\")\"",
    "current_worker_image_id=\"$(docker inspect --format '{{.Image}}' \"$worker_id\")\"",
    "[ \"$current_app_image_id\" = \"$current_worker_image_id\" ]",
    "configured_matches_current() {",
    "  configured_ref=\"$1\"",
    "  current_ref=\"$2\"",
    "  current_id=\"$3\"",
    "  case \"$current_ref\" in",
    "    sha256:*) [ \"$(docker image inspect --format '{{.Id}}' \"$configured_ref\" 2>/dev/null || true)\" = \"$current_id\" ] ;;",
    "    *) [ \"$(image_repository \"$configured_ref\")\" = \"$(image_repository \"$current_ref\")\" ] ;;",
    "  esac",
    "}",
    "configured_matches_current \"$configured_app_image\" \"$current_app_image\" \"$current_app_image_id\"",
    "configured_matches_current \"$configured_worker_image\" \"$current_worker_image\" \"$current_worker_image_id\""
  ].join("\n");
}

export function buildSelfUpdateLockLaunchScript(input: {
  jobId: string;
  scriptPath: string;
  logPath: string;
  lockPath: string;
}) {
  const { jobId, scriptPath, logPath, lockPath } = input;
  return [
    "#!/bin/sh",
    "set -eu",
    `LOCK_PATH=${shQuote(lockPath)}`,
    `JOB_ID=${shQuote(jobId)}`,
    "release_launcher_lock() {",
    "  rm -f -- \"$LOCK_PATH/owner\" \"$LOCK_PATH/job\" \"$LOCK_PATH/script\"",
    "  rmdir -- \"$LOCK_PATH\" 2>/dev/null || true",
    "}",
    "lock_age_seconds() {",
    "  lock_now=\"$(date +%s)\"",
    "  lock_mtime=\"$(stat -c %Y -- \"$LOCK_PATH\" 2>/dev/null || stat -f %m -- \"$LOCK_PATH\" 2>/dev/null || true)\"",
    "  case \"$lock_mtime\" in ''|*[!0-9]*) printf '%s\\n' 0 ;; *) printf '%s\\n' \"$((lock_now - lock_mtime))\" ;; esac",
    "}",
    "if ! mkdir -- \"$LOCK_PATH\" 2>/dev/null; then",
    "  existing_owner=\"$(sed -n '1p' \"$LOCK_PATH/owner\" 2>/dev/null || true)\"",
    "  existing_job=\"$(sed -n '1p' \"$LOCK_PATH/job\" 2>/dev/null || true)\"",
    "  existing_script=\"$(sed -n '1p' \"$LOCK_PATH/script\" 2>/dev/null || true)\"",
    "  lock_age=\"$(lock_age_seconds)\"",
    "  owner_is_updater=0",
    "  owner_is_alive=0",
    "  owner_inspected=0",
    "  metadata_valid=1",
    "  case \"$existing_owner\" in ''|*[!0-9]*) metadata_valid=0 ;; esac",
    "  case \"$existing_job\" in ''|*[!0-9A-Za-z_-]*) metadata_valid=0 ;; esac",
    "  case \"$existing_script\" in /*) ;; *) metadata_valid=0 ;; esac",
    "  case \"$existing_owner\" in ''|*[!0-9]*) ;; *) if kill -0 \"$existing_owner\" 2>/dev/null; then owner_is_alive=1; fi ;; esac",
    "  if [ \"$metadata_valid\" -eq 1 ] && [ \"$owner_is_alive\" -eq 1 ] && [ -r \"/proc/$existing_owner/cmdline\" ] && [ -e \"/proc/$existing_owner/cwd\" ]; then",
    "    owner_inspected=1",
    "    process_args=\"$(tr '\\000' ' ' < \"/proc/$existing_owner/cmdline\")\"",
    "    process_cwd=\"$(readlink -f -- \"/proc/$existing_owner/cwd\" 2>/dev/null || true)\"",
    "    expected_cwd=\"$(readlink -f -- \"${existing_script%/*}\" 2>/dev/null || true)\"",
    "    case \"$process_args\" in *\"$existing_script\"*) [ \"$process_cwd\" = \"$expected_cwd\" ] && owner_is_updater=1 ;; esac",
    "  fi",
    "  if [ \"$owner_is_updater\" -eq 1 ]; then",
    "    printf '%s\\n' \"A self-update is already running on the manager host (job $existing_job).\" >&2",
    "    exit 75",
    "  fi",
    "  if [ \"$owner_is_alive\" -eq 1 ] && [ \"$owner_inspected\" -eq 0 ]; then",
    "    printf '%s\\n' 'A self-update lock has a live owner that cannot be safely inspected.' >&2",
    "    exit 75",
    "  fi",
    "  if [ \"$lock_age\" -lt 120 ] && { [ \"$metadata_valid\" -eq 0 ] || [ \"$owner_is_alive\" -eq 1 ]; }; then",
    "    printf '%s\\n' 'A recent self-update lock is still initializing or has an unverifiable live owner.' >&2",
    "    exit 75",
    "  fi",
    "  stale_suffix=\"$existing_owner\"",
    "  case \"$stale_suffix\" in ''|*[!0-9]*) stale_suffix=unknown ;; esac",
    "  stale_path=\"${LOCK_PATH}.stale.$$.${stale_suffix}\"",
    "  if ! mv -- \"$LOCK_PATH\" \"$stale_path\" 2>/dev/null; then",
    "    printf '%s\\n' 'The stale self-update lock changed while it was being recovered.' >&2",
    "    exit 75",
    "  fi",
    "  rm -f -- \"$stale_path/owner\" \"$stale_path/job\" \"$stale_path/script\"",
    "  rmdir -- \"$stale_path\" 2>/dev/null || true",
    "  if ! mkdir -- \"$LOCK_PATH\" 2>/dev/null; then",
    "    printf '%s\\n' 'Another self-update acquired the manager-host lock.' >&2",
    "    exit 75",
    "  fi",
    "fi",
    "printf '%s\\n' \"$$\" > \"$LOCK_PATH/owner\"",
    "printf '%s\\n' \"$JOB_ID\" > \"$LOCK_PATH/job\"",
    `printf '%s\\n' ${shQuote(scriptPath)} > "$LOCK_PATH/script"`,
    `if ! chmod 700 ${shQuote(scriptPath)}; then release_launcher_lock; exit 1; fi`,
    `nohup ${shQuote(scriptPath)} > ${shQuote(logPath)} 2>&1 < /dev/null & child_pid=$!`,
    "owner_tmp=\"$LOCK_PATH/owner.$$\"",
    "printf '%s\\n' \"$child_pid\" > \"$owner_tmp\"",
    "mv -- \"$owner_tmp\" \"$LOCK_PATH/owner\"",
    "printf '%s\\n' \"$child_pid\""
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
  const preflight = preflightScript(payload, host.public.dockerSocketPath);
  const preflightResult = await runSshCommand(host.ssh, preflight, { timeoutMs: 60_000 });
  if (preflightResult.code !== 0) {
    throw new Error(preflightResult.stderr || preflightResult.stdout || "Self-update preflight failed");
  }

  const executionId = (options.jobId ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "");
  const scriptPath = selfUpdateArtifactPath(payload.workingDir, executionId, "sh");
  const logPath = selfUpdateArtifactPath(payload.workingDir, executionId, "log");
  const outcomePath = selfUpdateArtifactPath(payload.workingDir, executionId, "outcome");
  const gatePath = selfUpdateArtifactPath(payload.workingDir, executionId, "gate");
  const envBackupPath = selfUpdateArtifactPath(payload.workingDir, executionId, "env.backup");
  const rollbackComposePath = selfUpdateArtifactPath(payload.workingDir, executionId, "rollback.yml");
  const lockPath = SELF_UPDATE_LOCK_PATH;
  await writeRemoteFile(
    host.ssh,
    scriptPath,
    `${buildSelfUpdateScript(payload, host.public.dockerSocketPath, {
      jobId: executionId,
      lockPath,
      outcomePath,
      gatePath,
      envBackupPath,
      rollbackComposePath
    })}\n`
  );

  await options.onProgress?.("handoff", "Starting detached host-side update script");
  const launch = buildSelfUpdateLockLaunchScript({ jobId: executionId, scriptPath, logPath, lockPath });
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
  } satisfies SelfUpdateHandoff;
}

export async function confirmSelfUpdateHandoff(hostId: string, handoff: SelfUpdateHandoff) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Self-update handoff confirmation requires SSH mode");
  const result = await runSshCommand(
    host.ssh,
    `umask 077 && : > ${shQuote(handoff.gatePath)}`,
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Self-update handoff confirmation failed");
  }
}

function parseSelfUpdateOutcome(contents: string, expectedJobId: string, expectedTargetVersion: string): SelfUpdateOutcome {
  const fields = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Self-update outcome contains an invalid field");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (fields.has(key)) throw new Error("Self-update outcome contains a duplicate field");
    fields.set(key, value);
  }
  const allowedKeys = new Set(["schema", "job_id", "status", "stage", "rollback", "target_version", "exit_code"]);
  if (Array.from(fields.keys()).some((key) => !allowedKeys.has(key)) || fields.size !== allowedKeys.size) {
    throw new Error("Self-update outcome has an unexpected schema");
  }
  if (
    fields.get("schema") !== "1"
    || fields.get("job_id") !== expectedJobId
    || fields.get("target_version") !== expectedTargetVersion
  ) {
    throw new Error("Self-update outcome does not match the pending handoff");
  }
  const status = fields.get("status");
  const stage = fields.get("stage") ?? "";
  const rollback = fields.get("rollback");
  const exitCodeText = fields.get("exit_code") ?? "";
  if (
    (status !== "passed" && status !== "failed")
    || !/^[a-z][a-z0-9_]{0,63}$/.test(stage)
    || !["not_required", "succeeded", "failed"].includes(rollback ?? "")
    || !/^(?:0|[1-9][0-9]{0,2})$/.test(exitCodeText)
  ) {
    throw new Error("Self-update outcome contains an invalid value");
  }
  const exitCode = Number(exitCodeText);
  if ((status === "passed" && (stage !== "complete" || rollback !== "not_required" || exitCode !== 0)) || (status === "failed" && exitCode === 0)) {
    throw new Error("Self-update outcome is internally inconsistent");
  }
  return {
    status,
    stage,
    rollback: rollback as SelfUpdateOutcome["rollback"],
    targetVersion: expectedTargetVersion,
    exitCode
  };
}

async function finalizePendingSelfUpdate(jobId: string, outcome: SelfUpdateOutcome) {
  const completed = outcome.status === "passed";
  const result = {
    handoffPending: false,
    outcome: {
      status: outcome.status,
      stage: outcome.stage,
      rollback: outcome.rollback,
      targetVersion: outcome.targetVersion,
      exitCode: outcome.exitCode
    },
    reconciledAt: new Date().toISOString()
  };
  const error = completed
    ? null
    : `Self-update failed during ${outcome.stage}; rollback ${outcome.rollback.replace("_", " ")}.`;
  const updated = await query(
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
      JSON.stringify(result),
      error,
      JSON.stringify(buildJobProgress("system.self_update", completed ? "completed" : "failed", "reconnect", error ?? undefined))
    ]
  );
  return updated.rowCount === 1;
}

async function failUnreconciledSelfUpdate(jobId: string, message: string) {
  const updated = await query(
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
  return updated.rowCount === 1;
}

function pendingHandoffAgeMs(row: any) {
  const handedOffAt = typeof row.result?.handedOffAt === "string"
    ? Date.parse(row.result.handedOffAt)
    : Number.NaN;
  const fallback = new Date(row.updated_at ?? row.started_at ?? row.created_at).getTime();
  return Date.now() - (Number.isFinite(handedOffAt) ? handedOffAt : fallback);
}

function expectedHandoffArtifacts(row: any) {
  const action = dockerActionSchema.parse({
    type: row.type,
    hostId: row.host_id,
    payload: row.payload
  });
  if (action.type !== "system.self_update") throw new Error("Pending job is not a self-update");
  const executionId = String(row.id).replace(/[^a-zA-Z0-9_-]/g, "");
  return {
    action,
    outcomePath: selfUpdateArtifactPath(action.payload.workingDir, executionId, "outcome"),
    scriptPath: selfUpdateArtifactPath(action.payload.workingDir, executionId, "sh")
  };
}

export async function reconcileSelfUpdateHandoffs() {
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
      const { action, outcomePath, scriptPath } = expectedHandoffArtifacts(row);
      const host = await getHostForWorker(action.hostId);
      if (host.connectionMode !== "ssh") {
        if (await failUnreconciledSelfUpdate(row.id, "Self-update outcome could not be reconciled because the manager host is no longer configured for SSH.")) failed += 1;
        continue;
      }
      const outcomeResult = await runSshCommand(
        host.ssh,
        `if [ -f ${shQuote(outcomePath)} ]; then cat -- ${shQuote(outcomePath)}; else exit 44; fi`,
        { timeoutMs: 30_000 }
      );
      if (outcomeResult.code === 0) {
        let outcome: SelfUpdateOutcome;
        try {
          outcome = parseSelfUpdateOutcome(outcomeResult.stdout, row.id, action.payload.targetVersion);
        } catch {
          if (await failUnreconciledSelfUpdate(row.id, "Self-update wrote an invalid authoritative outcome.")) failed += 1;
          continue;
        }
        if (await finalizePendingSelfUpdate(row.id, outcome)) {
          if (outcome.status === "passed") completed += 1;
          else failed += 1;
        }
        continue;
      }

      const lockResult = await runSshCommand(
        host.ssh,
        [
          `owner="$(sed -n '1p' ${shQuote(`${SELF_UPDATE_LOCK_PATH}/owner`)} 2>/dev/null || true)"`,
          `owner_job="$(sed -n '1p' ${shQuote(`${SELF_UPDATE_LOCK_PATH}/job`)} 2>/dev/null || true)"`,
          `owner_script="$(sed -n '1p' ${shQuote(`${SELF_UPDATE_LOCK_PATH}/script`)} 2>/dev/null || true)"`,
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
      if (await failUnreconciledSelfUpdate(row.id, message)) failed += 1;
    } catch {
      if (ageMs >= SELF_UPDATE_HANDOFF_TIMEOUT_MS) {
        if (await failUnreconciledSelfUpdate(row.id, "Self-update outcome could not be reconciled before the handoff timeout.")) failed += 1;
      } else {
        pendingCount += 1;
      }
    }
  }

  return { completed, failed, pending: pendingCount };
}
