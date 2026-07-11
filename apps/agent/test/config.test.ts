import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { REPOSITORY_AGENT_TOKEN_PLACEHOLDERS, agentTokenSchema, parseAgentEnvironment, resolveAgentVersion } from "../src/config.js";

describe("agent configuration", () => {
  it("requires an explicit strong, non-placeholder token", () => {
    expect(() => parseAgentEnvironment({})).toThrow(/AGENT_TOKEN/);
    expect(() => agentTokenSchema.parse("short-token")).toThrow(/24 characters/);
    for (const placeholder of REPOSITORY_AGENT_TOKEN_PLACEHOLDERS) {
      expect(() => agentTokenSchema.parse(placeholder)).toThrow(/placeholder/);
      expect(() => agentTokenSchema.parse(`  ${placeholder.toUpperCase()}  `)).toThrow(/placeholder/);
    }
    const generated = randomBytes(32).toString("hex");
    expect(agentTokenSchema.parse(generated)).toBe(generated);
  });

  it("falls back to the package version for source and unknown image labels", () => {
    expect(resolveAgentVersion(undefined, "1.0.7-rc.1")).toBe("1.0.7-rc.1");
    expect(resolveAgentVersion("source", "1.0.7-rc.1")).toBe("1.0.7-rc.1");
    expect(resolveAgentVersion("unknown", "1.0.7-rc.1")).toBe("1.0.7-rc.1");
    expect(resolveAgentVersion("1.0.8", "1.0.7-rc.1")).toBe("1.0.8");
  });
});
