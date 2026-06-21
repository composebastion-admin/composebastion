import { describe, expect, it } from "vitest";
import { validateAgentFilePath } from "../src/paths.js";

describe("validateAgentFilePath", () => {
  it("allows paths under the agent stack root", () => {
    expect(validateAgentFilePath("/tmp/composebastion/stack-1/compose.yml")).toBe(
      "/tmp/composebastion/stack-1/compose.yml"
    );
  });

  it("rejects paths outside the agent stack root", () => {
    expect(() => validateAgentFilePath("/etc/passwd")).toThrow(/limited to \/tmp\/composebastion/);
  });
});
