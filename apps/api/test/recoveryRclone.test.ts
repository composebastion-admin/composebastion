import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  process.stdout.write("obscured-" + args[1]);
  process.exit(0);
}
const command = configIndex >= 0 ? args[configIndex + 2] : args[0];
if (process.env.RCLONE_FAIL_COMMAND === command) {
  process.stderr.write("forced rclone failure");
  process.exit(12);
}
if (command === "lsjson") {
  process.stdout.write(JSON.stringify({ Size: 123, Hashes: { SHA256: "abc123" } }));
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
        smb: {
          server: "nas.local",
          share: "Backups",
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
        remotePath: "/Dockermender/backups/",
        configText: "[gdrive]\ntype = drive\n",
        credentials: {}
      }
    } as any;

    expect(buildRcloneObjectPath(target, "/points/rp-1/manifest.json"))
      .toBe("gdrive:Dockermender/backups/points/rp-1/manifest.json");
  });
});
