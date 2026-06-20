import { describe, expect, it } from "vitest";
import { activeSourceChannel, imageReferenceWithTag, imageTagFromReference } from "./sourceChannels.js";

describe("source channel helpers", () => {
  it("extracts image tags without confusing registry ports for tags", () => {
    expect(imageTagFromReference("ghcr.io/example/app:beta")).toBe("beta");
    expect(imageTagFromReference("registry.local:5000/example/app:dev")).toBe("dev");
    expect(imageTagFromReference("registry.local:5000/example/app")).toBe("");
  });

  it("switches image tags while preserving registry and repository", () => {
    expect(imageReferenceWithTag("ghcr.io/example/app:latest", "beta")).toBe("ghcr.io/example/app:beta");
    expect(imageReferenceWithTag("registry.local:5000/example/app", "dev")).toBe("registry.local:5000/example/app:dev");
    expect(imageReferenceWithTag("ghcr.io/example/app@sha256:abc", "main")).toBe("ghcr.io/example/app:main");
  });

  it("uses branch for git and tag for image channel display", () => {
    expect(activeSourceChannel("git", "main", "ghcr.io/example/app:dev")).toBe("main");
    expect(activeSourceChannel("image", "main", "ghcr.io/example/app:dev")).toBe("dev");
    expect(activeSourceChannel("compose", "main", "ghcr.io/example/app:dev")).toBe("");
  });
});
