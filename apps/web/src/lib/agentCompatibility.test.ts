import { describe, expect, it } from "vitest";
import { describeAgentCompatibility } from "./agentCompatibility.js";

describe("describeAgentCompatibility", () => {
  it("labels compatible, outdated, and unknown agent versions", () => {
    expect(describeAgentCompatibility("0.9.0")).toMatchObject({ status: "compatible" });
    expect(describeAgentCompatibility("0.9.6")).toMatchObject({ status: "compatible" });
    expect(describeAgentCompatibility("0.8.9")).toMatchObject({ status: "outdated" });
    expect(describeAgentCompatibility(null)).toMatchObject({ status: "unknown" });
  });
});
