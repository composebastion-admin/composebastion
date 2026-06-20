import { describe, expect, it } from "vitest";
import type { ImageUpdateCheck } from "@dockermender/shared";
import { buildImageUpdatePreview, resolveImageUpdateOutcome } from "../src/services/imageUpdates.js";

const hostId = "11111111-1111-4111-8111-111111111111";

function update(overrides: Partial<ImageUpdateCheck>): ImageUpdateCheck {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    hostId,
    imageReference: "nginx:latest",
    currentDigest: "sha256:local",
    remoteDigest: "sha256:remote",
    status: "update_available",
    riskNote: "Mutable tag",
    affectedContainers: [],
    affectedStacks: [],
    lastCheckedAt: new Date(0).toISOString(),
    ...overrides
  };
}

describe("image update preview mapping", () => {
  it("recommends scanning before applying an unscanned update", () => {
    const preview = buildImageUpdatePreview(hostId, "nginx:latest", [update({})]);

    expect(preview.safeAction).toBe("scan_first");
    expect(preview.riskNote).toBe("Mutable tag");
  });

  it("recommends container or stack actions from affected resources", () => {
    expect(buildImageUpdatePreview(hostId, "nginx:latest", [update({
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0 },
      affectedContainers: [{ id: "abc", name: "web" }]
    })]).safeAction).toBe("update_container");

    expect(buildImageUpdatePreview(hostId, "nginx:latest", [update({
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      affectedStacks: [{ id: "stack-1", name: "web" }]
    })]).safeAction).toBe("redeploy_stack");
  });

  it("turns private/local registry hints into an add-credentials recommendation", () => {
    const preview = buildImageUpdatePreview(hostId, "private.example.com/app:latest", [update({
      imageReference: "private.example.com/app:latest",
      status: "local",
      remoteDigest: null,
      riskNote: "Not in a public registry; likely built on this host. If it is a private repository, add credentials under Settings -> Registries."
    })]);

    expect(preview.safeAction).toBe("add_credentials");
    expect(preview.credentialHint).toContain("registry credentials");
  });

  it("treats a local platform manifest digest as current when it belongs to the remote index", () => {
    const outcome = resolveImageUpdateOutcome({
      currentDigest: "linux-amd64",
      remoteDigest: "index",
      remoteEquivalentDigests: ["index", "linux-amd64", "linux-arm64"],
      mutableRisk: null,
      lookupError: null,
      hasStoredAuth: false
    });

    expect(outcome.status).toBe("up_to_date");
    expect(outcome.remoteDigest).toBe("linux-amd64");
  });
});
