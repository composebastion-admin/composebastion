import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deploymentEnvironmentBinding,
  interpolateDeploymentEnvironment,
  parseDeploymentEnvironment,
  redactSensitiveValues,
  serializeDeploymentEnvironment
} from "../src/services/deploymentEnvironment.js";

describe("deployment environment durability", () => {
  it("round trips Compose-sensitive values without semantic loss", () => {
    const expected = new Map([
      ["COMMENT", "alpha #beta"],
      ["DOLLAR", "cost $5 and ${HOME}"],
      ["DOUBLE_QUOTE", "say \"hello\""],
      ["SINGLE_QUOTE", "it's qualified"],
      ["BACKSLASH", "c:\\qualified\\path"],
      ["PADDED", "  padded  "],
      ["MULTILINE", "line one\nline two"],
      ["EMPTY", ""]
    ]);

    const serialized = serializeDeploymentEnvironment(expected);
    expect(parseDeploymentEnvironment(serialized)).toEqual(expected);
    expect(serialized).toContain("COMMENT='alpha #beta'");
    expect(serialized).toContain("DOLLAR='cost $5 and ${HOME}'");
    expect(serialized).toContain("SINGLE_QUOTE='it\\'s qualified'");
  });

  it("parses quoted, exported, commented, escaped, and multiline dotenv values", () => {
    expect(parseDeploymentEnvironment([
      "export A=\"alpha #beta\"",
      "B=plain value # comment",
      "C='say \\'hello\\''",
      "D=\"line\\nnext\"",
      "E='first",
      "second'",
      "EMPTY="
    ].join("\n"))).toEqual(new Map([
      ["A", "alpha #beta"],
      ["B", "plain value"],
      ["C", "say 'hello'"],
      ["D", "line\nnext"],
      ["E", "first\nsecond"],
      ["EMPTY", ""]
    ]));
  });

  it("evaluates unquoted and double-quoted references while preserving single-quoted literals", () => {
    const parsed = parseDeploymentEnvironment([
      "HOST=registry.example",
      "REGISTRY=${HOST}",
      "DOUBLE=\"${HOST}/team\"",
      "LITERAL='${HOST}'",
      "ESCAPED=\\${HOST}",
      "DOLLAR=$$HOST"
    ].join("\n"));
    expect(parsed).toEqual(new Map([
      ["HOST", "registry.example"],
      ["REGISTRY", "registry.example"],
      ["DOUBLE", "registry.example/team"],
      ["LITERAL", "${HOST}"],
      ["ESCAPED", "\\registry.example"],
      ["DOLLAR", "$HOST"]
    ]));
    expect(parseDeploymentEnvironment(
      serializeDeploymentEnvironment(parsed)
    )).toEqual(parsed);
  });

  it("uses a server-keyed environment binding rather than a plaintext oracle", () => {
    const environment = "DB_PASSWORD='summer2026'";
    expect(deploymentEnvironmentBinding(environment)).toMatch(/^[0-9a-f]{64}$/);
    expect(deploymentEnvironmentBinding(environment)).not.toBe(
      createHash("sha256").update(environment).digest("hex")
    );
    expect(deploymentEnvironmentBinding(environment)).not.toBe(
      deploymentEnvironmentBinding("DB_PASSWORD='different'")
    );
  });

  it("resolves Compose variable operators from the bound environment", () => {
    const env = new Map([
      ["REGISTRY", "registry.internal:5000"],
      ["TAG", ""]
    ]);
    expect(interpolateDeploymentEnvironment(
      "${REGISTRY}/team/app:${TAG:-latest}",
      env
    )).toBe("registry.internal:5000/team/app:latest");
    expect(interpolateDeploymentEnvironment("$REGISTRY/team/app:$$TAG", env))
      .toBe("registry.internal:5000/team/app:$TAG");
    expect(() =>
      interpolateDeploymentEnvironment("${MISSING:?required}", env)
    ).toThrow("MISSING");
  });

  it("redacts raw, URL-encoded, and JSON-escaped secret forms", () => {
    const secret = "alpha #beta\nnext";
    const redacted = redactSensitiveValues(
      `${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)}`,
      [secret]
    );
    expect(redacted).not.toContain("alpha");
    expect(redacted).toContain("[REDACTED]");
  });
});
