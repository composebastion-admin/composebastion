import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkerBackupTarget } from "./recoveryBackupTargets.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type RcloneHeadResult = {
  sizeBytes: number | null;
  checksum: string | null;
};

function rcloneBinary() {
  return process.env.RCLONE_PATH || "rclone";
}

function quoteConfigValue(value: unknown) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

async function obscurePassword(password: string) {
  if (!password) return "";
  const result = await execFileAsync(rcloneBinary(), ["obscure", password], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  return result.stdout.trim();
}

async function buildSmbConfig(target: WorkerBackupTarget) {
  const smb = target.config.smb && typeof target.config.smb === "object" && !Array.isArray(target.config.smb)
    ? target.config.smb as Record<string, unknown>
    : {};
  const password = typeof target.rclone?.credentials.password === "string"
    ? target.rclone.credentials.password
    : "";
  const lines = [
    `[${target.rclone?.remoteName ?? "composebastion"}]`,
    "type = smb",
    `host = ${quoteConfigValue(smb.server)}`
  ];
  if (smb.domain) lines.push(`domain = ${quoteConfigValue(smb.domain)}`);
  if (smb.username) lines.push(`user = ${quoteConfigValue(smb.username)}`);
  if (password) lines.push(`pass = ${await obscurePassword(password)}`);
  if (smb.port) lines.push(`port = ${quoteConfigValue(smb.port)}`);
  return `${lines.join("\n")}\n`;
}

async function resolveConfigText(target: WorkerBackupTarget) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  if (target.rclone.configText) return target.rclone.configText;
  if (target.rclone.provider === "smb") return buildSmbConfig(target);
  throw new Error("Rclone target requires an imported rclone config");
}

async function withConfigFile<T>(target: WorkerBackupTarget, work: (configPath: string) => Promise<T>) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "composebastion-rclone-"));
  const configPath = path.join(tempDir, "rclone.conf");
  try {
    await writeFile(configPath, await resolveConfigText(target), { mode: 0o600 });
    return await work(configPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runRclone(target: WorkerBackupTarget, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  return withConfigFile(target, async (configPath) => {
    const result = await execFileAsync(rcloneBinary(), ["--config", configPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr
    };
  });
}

function cleanRemotePath(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export function buildRcloneObjectPath(target: WorkerBackupTarget, objectKey: string) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  const parts = [cleanRemotePath(target.rclone.remotePath), cleanRemotePath(objectKey)].filter(Boolean);
  return `${target.rclone.remoteName}:${parts.join("/")}`;
}

export async function uploadRecoveryArtifactToRclone(
  target: WorkerBackupTarget,
  objectKey: string,
  localPath: string
) {
  const remote = buildRcloneObjectPath(target, objectKey);
  await runRclone(target, ["copyto", localPath, remote]);
  return headRecoveryArtifactOnRclone(target, objectKey);
}

export async function downloadRecoveryArtifactFromRclone(
  target: WorkerBackupTarget,
  objectKey: string,
  localPath: string
) {
  await mkdir(path.dirname(localPath), { recursive: true });
  await runRclone(target, ["copyto", buildRcloneObjectPath(target, objectKey), localPath]);
  return headRecoveryArtifactOnRclone(target, objectKey);
}

export async function headRecoveryArtifactOnRclone(
  target: WorkerBackupTarget,
  objectKey: string
): Promise<RcloneHeadResult> {
  const remote = buildRcloneObjectPath(target, objectKey);
  const result = await runRclone(target, ["lsjson", "--stat", remote], 120_000);
  const parsed = JSON.parse(result.stdout.trim() || "{}") as { Size?: number; Hashes?: Record<string, string> };
  const sha256 = parsed.Hashes?.SHA256 ?? parsed.Hashes?.sha256 ?? null;
  return {
    sizeBytes: typeof parsed.Size === "number" ? parsed.Size : null,
    checksum: sha256 ? `sha256:${sha256}` : null
  };
}

export async function deleteRecoveryArtifactFromRclone(target: WorkerBackupTarget, objectKey: string) {
  await runRclone(target, ["deletefile", buildRcloneObjectPath(target, objectKey)], 120_000);
}

export async function testRcloneTarget(target: WorkerBackupTarget) {
  if (!target.rclone) throw new Error("Rclone target is missing worker config");
  const base = `${target.rclone.remoteName}:${cleanRemotePath(target.rclone.remotePath)}`;
  await runRclone(target, ["mkdir", base], 120_000);
  await runRclone(target, ["lsf", base, "--max-depth", "1"], 120_000);
  return { ok: true };
}
