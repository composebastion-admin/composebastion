import { describe, expect, it } from "vitest";
import { agentCompatibilityStatus } from "../src/services/agent.js";

describe("agentCompatibilityStatus", () => {
  it("maps compatible, outdated, and unknown versions", () => {
    expect(agentCompatibilityStatus("0.10.0-pre.2")).toMatchObject({ status: "compatible" });
    expect(agentCompatibilityStatus("0.10.0")).toMatchObject({ status: "compatible" });
    expect(agentCompatibilityStatus("0.10.0-pre.0")).toMatchObject({ status: "outdated" });
    expect(agentCompatibilityStatus("0.9.9")).toMatchObject({ status: "outdated" });
    expect(agentCompatibilityStatus(undefined)).toMatchObject({ status: "unknown" });
  });
});
