import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildAcquireOwnedRemoteDirectoryCommand,
  buildCleanupOwnedRemoteDirectoryCommand
} from "../src/services/remoteOwnedDirectory.js";

const attemptToken =
  "00000000-0000-4000-8000-000000000911";
const targetPath =
  "/var/lib/composebastion/qualification/owned-directory";
const ownerValue = `${attemptToken}|qualification-scope`;

function commands() {
  const input = {
    targetPath,
    ownerValue,
    attemptToken,
    label: "qualification restore directory"
  };
  return {
    acquire: buildAcquireOwnedRemoteDirectoryCommand(input),
    cleanup: buildCleanupOwnedRemoteDirectoryCommand(input)
  };
}

describe("attempt-owned remote directory protocol", () => {
  it("emits syntax-valid acquisition and cleanup commands", () => {
    for (const command of Object.values(commands())) {
      expect(
        spawnSync("sh", ["-n", "-c", command], {
          encoding: "utf8"
        })
      ).toMatchObject({
        status: 0,
        stderr: ""
      });
    }
  });

  it("publishes complete ownership evidence before creating and publishing the target", () => {
    const { acquire } = commands();
    const acquisitionMarker =
      `${targetPath}.composebastion-restore-owner.acquire-${attemptToken}`;
    const buildMarker = `${acquisitionMarker}.building`;
    const stagingTarget = `${targetPath}.acquire-${attemptToken}`;

    const publishReservation = acquire.indexOf(
      `mv -T -n -- '${buildMarker}' '${acquisitionMarker}'`
    );
    const createStaging = acquire.indexOf(
      `mkdir -m 700 -- '${stagingTarget}'`
    );
    const publishTarget = acquire.indexOf(
      `mv -T -n -- '${stagingTarget}' '${targetPath}'`
    );
    const publishMarker = acquire.indexOf(
      `mv -T -n -- '${acquisitionMarker}' '${targetPath}.composebastion-restore-owner'`
    );

    expect([
      publishReservation,
      createStaging,
      publishTarget,
      publishMarker
    ].every((index) => index >= 0)).toBe(true);
    expect(publishReservation).toBeLessThan(createStaging);
    expect(createStaging).toBeLessThan(publishTarget);
    expect(publishTarget).toBeLessThan(publishMarker);
    expect(acquire).toContain("target-identity.pending-");
    expect(acquire).toContain("stat -c '%d:%i'");
  });

  it("resumes both target and marker quarantines and checks every path before success", () => {
    const { cleanup } = commands();
    const targetQuarantine =
      `${targetPath}.composebastion-delete-${attemptToken}`;
    const markerPath =
      `${targetPath}.composebastion-restore-owner`;
    const markerQuarantine =
      `${markerPath}.composebastion-delete-${attemptToken}`;

    expect(cleanup).toContain(
      `stat -c '%d:%i' -- '${targetQuarantine}'`
    );
    expect(cleanup).toContain(
      `find '${targetQuarantine}' -xdev -depth -delete`
    );
    expect(cleanup).toContain(
      `stat -c '%d:%i' -- '${markerQuarantine}'`
    );
    expect(cleanup).toContain(
      `find '${markerQuarantine}' -xdev -depth -delete`
    );
    expect(cleanup).not.toContain("rm -rf --one-file-system");
    expect(cleanup).toContain(
      `if [ -e '${targetPath}' ] || [ -L '${targetPath}' ]; then`
    );
    expect(cleanup).toContain(
      `if [ -e '${markerPath}' ] || [ -L '${markerPath}' ]; then`
    );
  });

  it("rejects unsafe roots and quarantine tokens before emitting shell", () => {
    expect(() => buildAcquireOwnedRemoteDirectoryCommand({
      targetPath: "/",
      ownerValue,
      attemptToken,
      label: "unsafe"
    })).toThrow("canonical absolute non-root");
    expect(() => buildCleanupOwnedRemoteDirectoryCommand({
      targetPath,
      ownerValue,
      attemptToken: "bad token",
      label: "unsafe"
    })).toThrow("unsafe for a quarantine path");
  });
});
