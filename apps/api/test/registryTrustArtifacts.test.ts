import { describe, expect, it } from "vitest";
import {
  registryTrustArtifactPaths
} from "../src/services/registryTrustArtifacts.js";

describe("registry trust artifact ownership", () => {
  it("derives deterministic job-attempt-owned candidate and rollback paths", () => {
    const identity = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 2
    };

    expect(registryTrustArtifactPaths(identity)).toEqual({
      candidatePath:
        "/tmp/composebastion-daemon-11111111-1111-4111-8111-111111111111-2.json",
      backupPath:
        "/etc/docker/daemon.json.composebastion-11111111-1111-4111-8111-111111111111-2.bak"
    });
    expect(registryTrustArtifactPaths(identity)).toEqual(
      registryTrustArtifactPaths(identity)
    );
  });

  it.each([
    [{ jobId: "../escape", attemptCount: 1 }],
    [{ jobId: "11111111-1111-4111-8111-111111111111", attemptCount: 0 }],
    [{ jobId: "11111111-1111-4111-8111-111111111111", attemptCount: 1.5 }]
  ])("rejects unsafe or ambiguous ownership %#", (identity) => {
    expect(() => registryTrustArtifactPaths(identity)).toThrow(
      "Registry trust artifact ownership"
    );
  });
});
