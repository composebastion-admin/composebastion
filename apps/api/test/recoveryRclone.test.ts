import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeRclone = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = process.env.RCLONE_LOG;
let config = "";
const configIndex = args.indexOf("--config");
if (configIndex >= 0) {
  config = fs.readFileSync(args[configIndex + 1], "utf8");
}
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({ args, config }) + "\\n");
}
if (args[0] === "obscure") {
  if (args[1] === "-") {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => process.stdout.write("obscured-" + input.split(/\\r?\\n/, 1)[0]));
  } else {
    process.stdout.write("obscured-" + args[1]);
  }
} else {
  const command = configIndex >= 0 ? args[configIndex + 2] : args[0];
  if (process.env.RCLONE_FAIL_COMMAND === command) {
    process.stderr.write(process.env.RCLONE_FAIL_MESSAGE || "forced rclone failure");
    process.exit(Number(process.env.RCLONE_FAIL_CODE || 12));
  }
  if (command === "lsjson") {
    process.stdout.write(JSON.stringify({ Size: 123, Hashes: { SHA256: "abc123" } }));
  }
}
`;

async function writeFakeRclone() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fake-rclone-"));
  const binPath = path.join(tempDir, "rclone");
  const logPath = path.join(tempDir, "rclone.log");
  await writeFile(binPath, fakeRclone);
  await chmod(binPath, 0o755);
  vi.stubEnv("RCLONE_PATH", binPath);
  vi.stubEnv("RCLONE_LOG", logPath);
  return { logPath };
}

async function readLog(logPath: string) {
  const text = await readFile(logPath, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    args: string[];
    config: string;
  });
}

describe("recovery rclone adapter", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds SMB config and copy commands without requiring a CIFS mount", async () => {
    const { logPath } = await writeFakeRclone();
    const { uploadRecoveryArtifactToRclone } = await import("../src/services/recoveryRclone.js");
    const target = {
      kind: "rclone",
      enabled: true,
      config: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        smb: {
          server: "nas.local",
          share: "Backups",
          subPath: "docker",
          domain: "WORKGROUP",
          username: "docker",
          port: 445
        }
      },
      localCachePolicy: "remote_only",
      rclone: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        credentials: { password: "secret" }
      }
    } as any;

    const result = await uploadRecoveryArtifactToRclone(target, "points/rp-1/manifest.json", "/tmp/manifest.json");

    expect(result).toEqual({ sizeBytes: 123, checksum: "sha256:abc123" });
    const calls = await readLog(logPath);
    const copyCall = calls.find((call) => call.args.includes("copyto"));
    expect(copyCall?.args).toContain("nas:Backups/docker/points/rp-1/manifest.json");
    expect(copyCall?.config).toContain("type = smb");
    expect(copyCall?.config).toContain("host = nas.local");
    expect(copyCall?.config).toContain("domain = WORKGROUP");
    expect(copyCall?.config).toContain("user = docker");
    expect(copyCall?.config).toContain("pass = obscured-secret");
    const obscureCall = calls.find((call) => call.args[0] === "obscure");
    expect(obscureCall?.args).toEqual(["obscure", "-"]);
    expect(JSON.stringify(calls)).not.toContain("\"secret\"");
    const configPaths = calls
      .map((call) => call.args[call.args.indexOf("--config") + 1])
      .filter((value): value is string => Boolean(value));
    for (const configPath of configPaths) {
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("builds object paths for imported cloud configs", async () => {
    const { buildRcloneObjectPath } = await import("../src/services/recoveryRclone.js");
    const target = {
      kind: "rclone",
      enabled: true,
      config: {},
      rclone: {
        provider: "drive",
        remoteName: "gdrive",
        remotePath: "/ComposeBastion/backups/",
        configText: "[gdrive]\ntype = drive\n",
        credentials: {}
      }
    } as any;

    expect(buildRcloneObjectPath(target, "/points/rp-1/manifest.json"))
      .toBe("gdrive:ComposeBastion/backups/points/rp-1/manifest.json");
  });

  it("rejects rclone backend switching and SMB path traversal", async () => {
    const { buildRcloneObjectPath } = await import("../src/services/recoveryRclone.js");
    const target = {
      kind: "rclone",
      enabled: true,
      config: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        smb: {
          server: "nas.local",
          share: "Backups",
          subPath: "docker"
        }
      },
      localCachePolicy: "remote_only",
      rclone: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        configText: null,
        credentials: {}
      }
    } as any;

    expect(buildRcloneObjectPath(target, "points/rp-1/manifest.json"))
      .toBe("nas:Backups/docker/points/rp-1/manifest.json");
    expect(buildRcloneObjectPath({
      ...target,
      config: { ...target.config, remoteName: "Team NAS 2+ops@example.com" },
      rclone: { ...target.rclone, remoteName: "Team NAS 2+ops@example.com" }
    }, "points/rp-1/manifest.json"))
      .toBe("Team NAS 2+ops@example.com:Backups/docker/points/rp-1/manifest.json");
    for (const remoteName of [":local", "nas#prod", "nas;prod"]) {
      expect(() => buildRcloneObjectPath({
        ...target,
        config: { ...target.config, remoteName },
        rclone: { ...target.rclone, remoteName }
      }, "points/rp-1/manifest.json")).toThrow("Rclone remote name");
    }
    expect(() => buildRcloneObjectPath({
      ...target,
      config: {
        ...target.config,
        remotePath: "../../../../tmp/docker",
        smb: { ...target.config.smb, share: "../../../../tmp" }
      },
      rclone: { ...target.rclone, remotePath: "../../../../tmp/docker" }
    }, "points/rp-1/manifest.json")).toThrow("SMB share");
    expect(() => buildRcloneObjectPath({
      ...target,
      config: {
        ...target.config,
        remotePath: "Backups/../escape",
        smb: { ...target.config.smb, subPath: "../escape" }
      },
      rclone: { ...target.rclone, remotePath: "Backups/../escape" }
    }, "points/rp-1/manifest.json")).toThrow("SMB subpath");
    expect(() => buildRcloneObjectPath({
      ...target,
      rclone: { ...target.rclone, remotePath: "../../../../tmp" }
    }, "points/rp-1/manifest.json")).toThrow("does not match");
    expect(() => buildRcloneObjectPath({
      ...target,
      rclone: { ...target.rclone, configText: "[nas]\ntype = local\n" }
    }, "points/rp-1/manifest.json")).toThrow("cannot use an imported rclone config");
    expect(() => buildRcloneObjectPath(target, "../escape/manifest.json"))
      .toThrow("SMB subpath");
  });

  it("treats an already-missing remote file as deleted while preserving real failures", async () => {
    await writeFakeRclone();
    const { deleteRecoveryArtifactFromRclone } = await import("../src/services/recoveryRclone.js");
    const target = {
      kind: "rclone",
      enabled: true,
      config: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        smb: {
          server: "nas.local",
          share: "Backups",
          subPath: "docker"
        }
      },
      rclone: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        configText: null,
        credentials: {}
      }
    } as any;

    vi.stubEnv("RCLONE_FAIL_COMMAND", "deletefile");
    vi.stubEnv("RCLONE_FAIL_CODE", "4");
    vi.stubEnv("RCLONE_FAIL_MESSAGE", "remote object not found");
    await expect(deleteRecoveryArtifactFromRclone(target, "points/rp-1/manifest.json"))
      .resolves.toBeUndefined();

    vi.stubEnv("RCLONE_FAIL_CODE", "1");
    vi.stubEnv(
      "RCLONE_FAIL_MESSAGE",
      "failed to read service account file /run/credentials/account.json: no such file or directory"
    );
    await expect(deleteRecoveryArtifactFromRclone(target, "points/rp-1/manifest.json"))
      .rejects.toThrow("service account file");

    vi.stubEnv("RCLONE_FAIL_CODE", "12");
    vi.stubEnv("RCLONE_FAIL_MESSAGE", "permission denied");
    await expect(deleteRecoveryArtifactFromRclone(target, "points/rp-1/manifest.json"))
      .rejects.toThrow("permission denied");
  });

  it("removes only old owned rclone temp directories and never follows symlinks", async () => {
    const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), "rclone-cleanup-test-"));
    const stale = path.join(cleanupRoot, "composebastion-rclone-stale01");
    const recent = path.join(cleanupRoot, "composebastion-rclone-recent1");
    const unrelated = path.join(cleanupRoot, "unrelated");
    const outside = await mkdtemp(path.join(os.tmpdir(), "rclone-cleanup-outside-"));
    const link = path.join(cleanupRoot, "composebastion-rclone-link001");
    const nowMs = Date.now();
    try {
      await Promise.all([
        mkdir(stale),
        mkdir(recent),
        mkdir(unrelated)
      ]);
      await writeFile(path.join(stale, "rclone.conf"), "token = stale-secret", { mode: 0o600 });
      await writeFile(path.join(recent, "rclone.conf"), "token = active-secret", { mode: 0o600 });
      await writeFile(path.join(outside, "keep"), "outside");
      await symlink(outside, link);
      const staleTime = new Date(nowMs - 60 * 60_000);
      await utimes(stale, staleTime, staleTime);

      const { cleanupStaleRcloneConfigDirectories } = await import("../src/services/recoveryRclone.js");
      const result = await cleanupStaleRcloneConfigDirectories({
        root: cleanupRoot,
        maxAgeMs: 15 * 60_000,
        nowMs
      });

      expect(result).toEqual({ removed: 1, skipped: 2 });
      await expect(readFile(path.join(stale, "rclone.conf"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(recent, "rclone.conf"), "utf8")).resolves.toBe("token = active-secret");
      await expect(readFile(path.join(outside, "keep"), "utf8")).resolves.toBe("outside");
      await expect(readFile(path.join(unrelated, "missing"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cleanupRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
