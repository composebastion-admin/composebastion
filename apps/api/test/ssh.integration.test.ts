import { describe, expect, it } from "vitest";
import { runSshCommand } from "../src/services/ssh.js";

const required = [
  "COMPOSEBASTION_SSH_TEST_HOST",
  "COMPOSEBASTION_SSH_TEST_USER",
  "COMPOSEBASTION_SSH_TEST_KEY"
] as const;

const hasSshFixture = required.every((key) => Boolean(process.env[key]));

describe.skipIf(!hasSshFixture)("SSH Docker host integration", () => {
  it("connects to a real host and verifies Docker/Compose are available", async () => {
    const port = process.env.COMPOSEBASTION_SSH_TEST_PORT?.trim()
      ? Number(process.env.COMPOSEBASTION_SSH_TEST_PORT)
      : 22;
    const target = {
      hostname: process.env.COMPOSEBASTION_SSH_TEST_HOST!,
      port,
      username: process.env.COMPOSEBASTION_SSH_TEST_USER!,
      privateKey: process.env.COMPOSEBASTION_SSH_TEST_KEY!.replace(/\\n/g, "\n"),
      passphrase: process.env.COMPOSEBASTION_SSH_TEST_KEY_PASSPHRASE || undefined
    };

    const docker = await runSshCommand(target, "docker version --format '{{.Server.Version}}'", { timeoutMs: 30_000 });
    expect(docker.code).toBe(0);
    expect(docker.stdout.trim()).not.toBe("");

    const compose = await runSshCommand(target, "docker compose version --short", { timeoutMs: 30_000 });
    expect(compose.code).toBe(0);
    expect(compose.stdout.trim()).not.toBe("");
  });
});
