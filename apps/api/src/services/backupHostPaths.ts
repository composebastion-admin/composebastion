import { normalizeRemotePath } from "./files.js";
import { shQuote } from "./commands.js";
import { env } from "../config/env.js";
import { buildBindMountCaptureCommand, buildBindMountRestoreCommand } from "./recoveryRestoreUtils.js";
import { runSshCommand, type SshTarget } from "./ssh.js";

export type HostPathRestoreState = "missing" | "empty_directory" | "non_empty_directory" | "not_directory";

function rejectControlCharacters(value: string, label: string) {
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(`${label} contains invalid control characters`);
  }
}

export function parseHostPathAllowedRoots(value: string) {
  return Array.from(new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => normalizeHostBackupPath(entry, "Allowed host path root"))
  ));
}

export const hostPathAllowedRoots = parseHostPathAllowedRoots(env.BACKUP_HOST_PATH_ALLOWED_ROOTS);

export function normalizeHostBackupPath(value: string, label = "Host path") {
  rejectControlCharacters(value, label);
  const normalized = normalizeRemotePath(value).replace(/\/+$/, "") || "/";
  if (normalized === "/") {
    throw new Error(`${label} cannot be /`);
  }
  return normalized;
}

export function assertHostBackupPathAllowed(value: string, label = "Host path", roots = hostPathAllowedRoots) {
  const normalized = normalizeHostBackupPath(value, label);
  if (!roots.length) return normalized;
  if (roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    return normalized;
  }
  throw new Error(`${label} ${normalized} is outside configured backup host path roots`);
}

export function normalizeHostSourcePath(value: string) {
  return assertHostBackupPathAllowed(value, "Source path");
}

export function normalizeHostTargetPath(value: string) {
  return assertHostBackupPathAllowed(value, "Target path");
}

export function buildHostPathCaptureCommand(sourcePath: string) {
  return buildBindMountCaptureCommand(normalizeHostSourcePath(sourcePath));
}

export function buildHostPathRestoreCommand(targetPath: string) {
  return buildBindMountRestoreCommand(normalizeHostTargetPath(targetPath));
}

export function buildHostPathRestoreStateCommand(targetPath: string) {
  const quoted = shQuote(normalizeHostTargetPath(targetPath));
  return [
    `if [ ! -e ${quoted} ]; then echo missing`,
    `elif [ ! -d ${quoted} ]; then echo not_directory`,
    `elif find ${quoted} -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then echo non_empty_directory`,
    "else echo empty_directory",
    "fi"
  ].join("; ");
}

export function hostPathRestoreDecision(state: HostPathRestoreState, overwrite: boolean, targetPath: string) {
  if (state === "not_directory") {
    return {
      allowed: false,
      reason: `Target path ${targetPath} exists and is not a directory. Choose a directory path.`
    };
  }
  if (state === "non_empty_directory" && !overwrite) {
    return {
      allowed: false,
      reason: `Target path ${targetPath} already exists and is not empty. Pass overwrite=true to restore into it.`
    };
  }
  return { allowed: true, reason: null };
}

export async function inspectSshHostPathForRestore(ssh: SshTarget, targetPath: string) {
  const normalized = normalizeHostTargetPath(targetPath);
  const result = await runSshCommand(ssh, buildHostPathRestoreStateCommand(normalized), { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to inspect target path ${normalized}`);
  }
  const state = result.stdout.trim() as HostPathRestoreState;
  if (!["missing", "empty_directory", "non_empty_directory", "not_directory"].includes(state)) {
    throw new Error(`Unexpected target path state for ${normalized}: ${state || "empty response"}`);
  }
  return state;
}

export async function assertHostPathCanBeRestored(ssh: SshTarget, targetPath: string, overwrite: boolean) {
  const normalized = normalizeHostTargetPath(targetPath);
  const state = await inspectSshHostPathForRestore(ssh, normalized);
  const decision = hostPathRestoreDecision(state, overwrite, normalized);
  if (!decision.allowed) {
    throw new Error(decision.reason ?? `Target path ${normalized} cannot be restored`);
  }
}
