import { describe, expect, it } from "vitest";
import { agentCompatibilityStatus } from "../src/services/agent.js";

describe("agentCompatibilityStatus", () => {
  it("maps compatible, outdated, and unknown versions", () => {
    expect(agentCompatibilityStatus("0.9.0")).toMatchObject({ status: "compatible" });
    expect(agentCompatibilityStatus("0.9.1")).toMatchObject({ status: "compatible" });
    expect(agentCompatibilityStatus("0.8.9")).toMatchObject({ status: "outdated" });
    expect(agentCompatibilityStatus(undefined)).toMatchObject({ status: "unknown" });
  });
});
