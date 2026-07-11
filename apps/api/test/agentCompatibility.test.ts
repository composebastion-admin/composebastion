import { describe, expect, it } from "vitest";
import { compareReleaseVersions } from "@composebastion/shared";
import { agentCompatibilityStatus } from "../src/services/agent.js";

describe("agentCompatibilityStatus", () => {
  it("maps compatible, outdated, and unknown versions", () => {
    expect(agentCompatibilityStatus("0.9.0")).toMatchObject({
      status: "compatible",
      message: "Agent 0.9.0 supports the current V1 agent API surface."
    });
    expect(agentCompatibilityStatus("0.9.6")).toMatchObject({ status: "compatible" });
    expect(agentCompatibilityStatus("0.8.9")).toMatchObject({ status: "outdated" });
    expect(agentCompatibilityStatus(undefined)).toMatchObject({ status: "unknown" });
    expect(agentCompatibilityStatus("0.9.0-rc.10")).toMatchObject({ status: "outdated" });
    expect(agentCompatibilityStatus("0.9.0-rc.10").status).toBe(agentCompatibilityStatus("0.9.0-rc.2").status);
    expect(agentCompatibilityStatus("0.9.0").status).toBe("compatible");
  });

  it("uses SemVer precedence for release candidates", () => {
    expect(compareReleaseVersions("1.0.7-rc.10", "1.0.7-rc.2")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.7", "1.0.7-rc.10")).toBeGreaterThan(0);
  });
});
