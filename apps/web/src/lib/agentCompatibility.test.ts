import { describe, expect, it } from "vitest";
import { describeAgentCompatibility } from "./agentCompatibility.js";

describe("describeAgentCompatibility", () => {
  it("labels compatible, outdated, and unknown agent versions", () => {
    expect(describeAgentCompatibility("0.10.0-pre.2")).toMatchObject({ status: "compatible" });
    expect(describeAgentCompatibility("0.10.0")).toMatchObject({ status: "compatible" });
    expect(describeAgentCompatibility("0.10.0-pre.0")).toMatchObject({ status: "outdated" });
    expect(describeAgentCompatibility("0.9.9")).toMatchObject({ status: "outdated" });
    expect(describeAgentCompatibility(null)).toMatchObject({ status: "unknown" });
  });
});
