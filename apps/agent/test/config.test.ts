import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  AGENT_RATE_LIMIT_DEFAULTS,
  REPOSITORY_AGENT_TOKEN_PLACEHOLDERS,
  agentTokenSchema,
  parseAgentEnvironment,
  resolveAgentVersion
} from "../src/config.js";

const token = "agent-config-test-token-that-is-long-enough";

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

  it("uses the documented rate-limit defaults for missing and blank values", () => {
    expect(parseAgentEnvironment({ AGENT_TOKEN: token })).toMatchObject({
      AGENT_READ_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.read,
      AGENT_RUN_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.run,
      AGENT_FILE_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.file,
      AGENT_STREAM_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.stream
    });
    expect(parseAgentEnvironment({
      AGENT_TOKEN: token,
      AGENT_READ_RATE_LIMIT: "",
      AGENT_RUN_RATE_LIMIT: "   ",
      AGENT_FILE_RATE_LIMIT: "\t",
      AGENT_STREAM_RATE_LIMIT: "\n"
    })).toMatchObject({
      AGENT_READ_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.read,
      AGENT_RUN_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.run,
      AGENT_FILE_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.file,
      AGENT_STREAM_RATE_LIMIT: AGENT_RATE_LIMIT_DEFAULTS.stream
    });
  });

  it("accepts custom positive safe integer rate limits", () => {
    expect(parseAgentEnvironment({
      AGENT_TOKEN: token,
      AGENT_READ_RATE_LIMIT: "240",
      AGENT_RUN_RATE_LIMIT: "45",
      AGENT_FILE_RATE_LIMIT: "90",
      AGENT_STREAM_RATE_LIMIT: "20"
    })).toMatchObject({
      AGENT_READ_RATE_LIMIT: 240,
      AGENT_RUN_RATE_LIMIT: 45,
      AGENT_FILE_RATE_LIMIT: 90,
      AGENT_STREAM_RATE_LIMIT: 20
    });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["non-numeric", "many"],
    ["unsafe", String(Number.MAX_SAFE_INTEGER + 1)]
  ])("rejects %s rate-limit values with an actionable startup error", (_label, value) => {
    expect(() => parseAgentEnvironment({
      AGENT_TOKEN: token,
      AGENT_READ_RATE_LIMIT: value
    })).toThrow(/AGENT_READ_RATE_LIMIT must be a positive safe integer.*leave it blank to use 120/);
  });
});
