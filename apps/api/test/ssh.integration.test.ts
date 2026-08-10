import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { shQuote } from "../src/services/commands.js";
import {
  buildAcquireOwnedRemoteDirectoryCommand,
  buildCleanupOwnedRemoteDirectoryCommand
} from "../src/services/remoteOwnedDirectory.js";
import { runSshCommand } from "../src/services/ssh.js";

const required = [
  "COMPOSEBASTION_SSH_TEST_HOST",
  "COMPOSEBASTION_SSH_TEST_USER",
  "COMPOSEBASTION_SSH_TEST_KEY"
] as const;

const hasSshFixture = required.every((key) => Boolean(process.env[key]));

function sshTarget() {
  const port = process.env.COMPOSEBASTION_SSH_TEST_PORT?.trim()
    ? Number(process.env.COMPOSEBASTION_SSH_TEST_PORT)
    : 22;
  return {
    hostname: process.env.COMPOSEBASTION_SSH_TEST_HOST!,
    port,
    username: process.env.COMPOSEBASTION_SSH_TEST_USER!,
    privateKey:
      process.env.COMPOSEBASTION_SSH_TEST_KEY!.replace(/\\n/g, "\n"),
    passphrase:
      process.env.COMPOSEBASTION_SSH_TEST_KEY_PASSPHRASE
      || undefined
  };
}

describe.skipIf(!hasSshFixture)("SSH Docker host integration", () => {
  it("connects to a real host and verifies Docker/Compose are available", async () => {
    const target = sshTarget();

    const docker = await runSshCommand(target, "docker version --format '{{.Server.Version}}'", { timeoutMs: 30_000 });
    expect(docker.code).toBe(0);
    expect(docker.stdout.trim()).not.toBe("");

    const compose = await runSshCommand(target, "docker compose version --short", { timeoutMs: 30_000 });
    expect(compose.code).toBe(0);
    expect(compose.stdout.trim()).not.toBe("");
  });

  it("resumes owned-directory acquisition and cleanup at every destructive rename cutpoint", async () => {
    const ssh = sshTarget();
    const pwd = await runSshCommand(ssh, "pwd -P", {
      timeoutMs: 30_000
    });
    expect(pwd.code).toBe(0);
    const home = pwd.stdout.trim().replace(/\/+$/, "");
    expect(home).not.toBe("");
    expect(home).not.toBe("/");
    const root =
      `${home}/.composebastion-qualification-owned-${randomUUID()}`;
    const attemptToken = randomUUID();
    const ownerValue = `${attemptToken}|ssh-integration`;

    const protocol = (targetPath: string) => ({
      acquire: buildAcquireOwnedRemoteDirectoryCommand({
        targetPath,
        ownerValue,
        attemptToken,
        label: `SSH qualification path ${targetPath}`
      }),
      cleanup: buildCleanupOwnedRemoteDirectoryCommand({
        targetPath,
        ownerValue,
        attemptToken,
        label: `SSH qualification path ${targetPath}`
      })
    });
    const run = (command: string) =>
      runSshCommand(ssh, command, { timeoutMs: 60_000 });
    const mustCut = (
      command: string,
      needle: string,
      replacement: string
    ) => {
      expect(command).toContain(needle);
      return command.replace(needle, replacement);
    };

    try {
      for (const [name, cut] of [
        ["before-staging", "before-staging"],
        ["after-staging", "after-staging"],
        ["before-marker", "before-marker"],
        ["before-reservation", "before-reservation"]
      ] as const) {
        const targetPath = `${root}/${name}`;
        const { acquire, cleanup } = protocol(targetPath);
        const acquisitionMarker =
          `${targetPath}.composebastion-restore-owner.acquire-${attemptToken}`;
        const buildMarker = `${acquisitionMarker}.building`;
        const stagingTarget = `${targetPath}.acquire-${attemptToken}`;
        const fixedMarker =
          `${targetPath}.composebastion-restore-owner`;
        const targetQuarantine =
          `${targetPath}.composebastion-delete-${attemptToken}`;
        const markerQuarantine =
          `${fixedMarker}.composebastion-delete-${attemptToken}`;
        const acquisitionQuarantine =
          `${acquisitionMarker}.composebastion-delete`;
        const buildQuarantine =
          `${buildMarker}.composebastion-delete`;
        const stagingQuarantine =
          `${stagingTarget}.composebastion-delete`;
        const stagingMkdir =
          `mkdir -m 700 -- ${shQuote(stagingTarget)} || exit $?;`;
        const publishMarker =
          `mv -T -n -- ${shQuote(acquisitionMarker)} ${shQuote(fixedMarker)} || exit $?;`;
        const publishReservation =
          `mv -T -n -- ${shQuote(buildMarker)} ${shQuote(acquisitionMarker)} || exit $?;`;
        const interrupted = cut === "before-staging"
          ? mustCut(
              acquire,
              stagingMkdir,
              `exit 91; ${stagingMkdir}`
            )
          : cut === "after-staging"
            ? mustCut(
                acquire,
                stagingMkdir,
                `${stagingMkdir} exit 92;`
              )
            : cut === "before-marker"
              ? mustCut(
                  acquire,
                  publishMarker,
                  `exit 93; ${publishMarker}`
                )
              : mustCut(
                  acquire,
                  publishReservation,
                  `exit 94; ${publishReservation}`
                );
        expect((await run(interrupted)).code).toBe(
          cut === "before-staging"
            ? 91
            : cut === "after-staging"
              ? 92
              : cut === "before-marker"
                ? 93
                : 94
        );
        const cleanupResult = await run(cleanup);
        expect(
          cleanupResult,
          `${name} cleanup failed: ${cleanupResult.stderr || cleanupResult.stdout}`
        ).toMatchObject({ code: 0 });
        const residue = await run(
          [
            targetPath,
            fixedMarker,
            acquisitionMarker,
            buildMarker,
            stagingTarget,
            targetQuarantine,
            markerQuarantine,
            acquisitionQuarantine,
            buildQuarantine,
            stagingQuarantine
          ].map((candidate) =>
            `[ ! -e ${shQuote(candidate)} ] && [ ! -L ${shQuote(candidate)} ]`
          ).join(" && ")
        );
        expect(residue.code).toBe(0);
      }

      const targetPath = `${root}/quarantine-resume`;
      const { acquire, cleanup } = protocol(targetPath);
      expect((await run(acquire)).code).toBe(0);
      expect((await run(
        `printf '%s\\n' canary > ${shQuote(`${targetPath}/canary`)}`
      )).code).toBe(0);
      const targetQuarantine =
        `${targetPath}.composebastion-delete-${attemptToken}`;
      const targetMove =
        `mv -T -n -- ${shQuote(targetPath)} ${shQuote(targetQuarantine)} || exit $?;`;
      expect((await run(mustCut(
        cleanup,
        targetMove,
        `${targetMove} exit 95;`
      ))).code).toBe(95);
      expect((await run(
        `[ -f ${shQuote(`${targetQuarantine}/canary`)} ]`
      )).code).toBe(0);
      expect((await run(cleanup)).code).toBe(0);

      expect((await run(acquire)).code).toBe(0);
      const markerPath =
        `${targetPath}.composebastion-restore-owner`;
      const markerQuarantine =
        `${markerPath}.composebastion-delete-${attemptToken}`;
      const markerMove =
        `mv -T -n -- ${shQuote(markerPath)} ${shQuote(markerQuarantine)} || exit $?;`;
      expect((await run(mustCut(
        cleanup,
        markerMove,
        `${markerMove} exit 96;`
      ))).code).toBe(96);
      expect((await run(
        `[ -d ${shQuote(markerQuarantine)} ]`
      )).code).toBe(0);
      expect((await run(cleanup)).code).toBe(0);
    } finally {
      const cleaned = await runSshCommand(
        ssh,
        [
          `if [ -e ${shQuote(root)} ] || [ -L ${shQuote(root)} ]; then`,
          `find ${shQuote(root)} -xdev -depth -delete || exit $?;`,
          "fi;",
          `if [ -e ${shQuote(root)} ] || [ -L ${shQuote(root)} ]; then exit 98; fi`
        ].join(" "),
        { timeoutMs: 60_000 }
      );
      expect(cleaned.code).toBe(0);
    }
  });

  it("preserves a replaced target and a target reached through a replaced parent symlink", async () => {
    const ssh = sshTarget();
    const pwd = await runSshCommand(ssh, "pwd -P", {
      timeoutMs: 30_000
    });
    const home = pwd.stdout.trim().replace(/\/+$/, "");
    expect(pwd.code).toBe(0);
    expect(home).not.toBe("/");
    const root =
      `${home}/.composebastion-qualification-replacement-${randomUUID()}`;
    const outside =
      `${home}/.composebastion-qualification-outside-${randomUUID()}`;
    const attemptToken = randomUUID();
    const ownerValue = `${attemptToken}|ssh-replacement`;
    const run = (command: string) =>
      runSshCommand(ssh, command, { timeoutMs: 60_000 });
    const protocol = (targetPath: string) => ({
      acquire: buildAcquireOwnedRemoteDirectoryCommand({
        targetPath,
        ownerValue,
        attemptToken,
        label: `SSH replacement path ${targetPath}`
      }),
      cleanup: buildCleanupOwnedRemoteDirectoryCommand({
        targetPath,
        ownerValue,
        attemptToken,
        label: `SSH replacement path ${targetPath}`
      })
    });

    try {
      const targetPath = `${root}/target`;
      const targetProtocol = protocol(targetPath);
      expect((await run(targetProtocol.acquire)).code).toBe(0);
      expect((await run(
        [
          `mv -T -- ${shQuote(targetPath)} ${shQuote(`${targetPath}.original`)}`,
          `mkdir -m 700 -- ${shQuote(targetPath)}`,
          `printf '%s\\n' successor > ${shQuote(`${targetPath}/canary`)}`
        ].join("; ")
      )).code).toBe(0);
      expect((await run(targetProtocol.cleanup)).code).toBe(77);
      expect((await run(
        `[ -f ${shQuote(`${targetPath}/canary`)} ]`
      )).code).toBe(0);

      const parent = `${root}/parent`;
      const nestedTarget = `${parent}/target`;
      const nestedProtocol = protocol(nestedTarget);
      expect((await run(nestedProtocol.acquire)).code).toBe(0);
      expect((await run(
        [
          `mv -T -- ${shQuote(parent)} ${shQuote(`${parent}.original`)}`,
          `mkdir -m 700 -- ${shQuote(outside)}`,
          `printf '%s\\n' outside > ${shQuote(`${outside}/canary`)}`,
          `ln -s -- ${shQuote(outside)} ${shQuote(parent)}`
        ].join("; ")
      )).code).toBe(0);
      expect((await run(nestedProtocol.cleanup)).code).toBeGreaterThanOrEqual(73);
      expect((await run(
        `[ -f ${shQuote(`${outside}/canary`)} ]`
      )).code).toBe(0);
    } finally {
      const cleaned = await runSshCommand(
        ssh,
        [
          `for cleanup_path in ${shQuote(root)} ${shQuote(outside)}; do`,
          `if [ -e "$cleanup_path" ] || [ -L "$cleanup_path" ]; then`,
          'find "$cleanup_path" -xdev -depth -delete || exit $?;',
          "fi;",
          'if [ -e "$cleanup_path" ] || [ -L "$cleanup_path" ]; then exit 98; fi;',
          "done"
        ].join(" "),
        { timeoutMs: 60_000 }
      );
      expect(cleaned.code).toBe(0);
    }
  });
});
