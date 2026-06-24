import path from "node:path";
import {
  selfUpdateConfigInputSchema,
  selfUpdateConfigSchema,
  type DockerActionRequest,
  type SelfUpdateConfig
} from "@composebastion/shared";
import { query } from "../db/pool.js";
import { shQuote } from "./commands.js";
import { getHost, getHostForWorker } from "./hosts.js";
import { enqueueJob } from "./jobs.js";
import { mapJob } from "./mappers.js";
import { runSshCommand, writeRemoteFile } from "./ssh.js";
import { runtimeVersionMetadata } from "./version.js";

const SELF_UPDATE_CONFIG_KEY = "self_update.config";
const SELF_UPDATE_LATEST_KEY = "self_update.latest";
const RELEASES_LATEST_URL = "https://api.github.com/repos/composebastion-admin/composebastion/releases/latest";
const DOCKER_SSH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin";

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

function compareVersions(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b || a === "latest" || b === "latest") return 0;
  const aParts = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const bParts = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(aParts.length, bParts.length, 3); index += 1) {
    const nextA = Number.isFinite(aParts[index]) ? aParts[index]! : 0;
    const nextB = Number.isFinite(bParts[index]) ? bParts[index]! : 0;
    if (nextA !== nextB) return nextA > nextB ? 1 : -1;
  }
  return 0;
}

function updateAvailable(current: string, latest: string | null) {
  return compareVersions(latest, current) > 0;
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

async function fetchLatestRelease(): Promise<LatestRelease> {
  const response = await fetch(RELEASES_LATEST_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ComposeBastion"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} while checking releases`);
  const body = await response.json() as { tag_name?: string; html_url?: string | null };
  return {
    version: body.tag_name ? normalizeVersion(body.tag_name) : null,
    checkedAt: new Date().toISOString(),
    error: null,
    htmlUrl: body.html_url ?? null
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

function selfUpdateScript(payload: SelfUpdatePayload, socketPath: string) {
  return [
    "#!/bin/sh",
    "set -eu",
    dockerShellExports(socketPath),
    `cd ${shQuote(payload.workingDir)}`,
    `echo "ComposeBastion self-update started $(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    envUpdateScript(payload.targetVersion),
    `docker compose -f ${shQuote(payload.composeFile)} pull app worker`,
    `docker compose -f ${shQuote(payload.composeFile)} up -d app worker`,
    `echo "ComposeBastion self-update finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"`
  ].join("\n");
}

export async function runSelfUpdate(
  hostId: string,
  payload: SelfUpdatePayload,
  options: { onProgress?: (stepId: "prepare" | "handoff", detail?: string) => Promise<void> | void } = {}
) {
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") {
    throw new Error("Self-update currently requires the manager host to use SSH mode so ComposeBastion can start a detached host-side update script.");
  }

  await options.onProgress?.("prepare", "Checking compose directory and file on the manager host");
  const preflight = [
    dockerShellExports(host.public.dockerSocketPath),
    `cd ${shQuote(payload.workingDir)}`,
    `test -f ${shQuote(payload.composeFile)}`,
    `docker compose -f ${shQuote(payload.composeFile)} config --services >/dev/null`
  ].join(" && ");
  const preflightResult = await runSshCommand(host.ssh, preflight, { timeoutMs: 60_000 });
  if (preflightResult.code !== 0) {
    throw new Error(preflightResult.stderr || preflightResult.stdout || "Self-update preflight failed");
  }

  const scriptPath = path.posix.join(payload.workingDir, ".composebastion-self-update.sh");
  const logPath = path.posix.join(payload.workingDir, ".composebastion-self-update.log");
  await writeRemoteFile(host.ssh, scriptPath, `${selfUpdateScript(payload, host.public.dockerSocketPath)}\n`);

  await options.onProgress?.("handoff", "Starting detached host-side update script");
  const launch = `chmod 700 ${shQuote(scriptPath)} && nohup ${shQuote(scriptPath)} > ${shQuote(logPath)} 2>&1 < /dev/null & printf '%s\\n' "$!"`;
  const launchResult = await runSshCommand(host.ssh, launch, { timeoutMs: 30_000 });
  if (launchResult.code !== 0) {
    throw new Error(launchResult.stderr || launchResult.stdout || "Self-update handoff failed");
  }

  return {
    handoffStarted: true,
    pid: launchResult.stdout.trim() || null,
    targetVersion: payload.targetVersion,
    workingDir: payload.workingDir,
    composeFile: payload.composeFile,
    logPath
  };
}
