import { describe, expect, it } from "vitest";
import { selfUpdateComposeFileSchema, selfUpdateConfigSchema, selfUpdateStartSchema } from "./index.js";

describe("self-update version validation", () => {
  it.each(["latest", "1.0.7", "v1.0.7", "1.1.0-rc.1"])("accepts supported target %s", (targetVersion) => {
    expect(selfUpdateStartSchema.parse({ targetVersion })).toEqual({ targetVersion });
  });

  it.each(["main", "nightly", "1.2", "1.0.0.0", "latest-dev"])("rejects unsupported target %s", (targetVersion) => {
    expect(() => selfUpdateStartSchema.parse({ targetVersion })).toThrow(/strict semantic release/);
  });

  it("does not allow latest in pinned mode", () => {
    expect(() => selfUpdateConfigSchema.parse({ versionMode: "pinned", targetVersion: "latest" })).toThrow(/Pinned updates/);
  });

  it.each([
    "/etc/docker-compose.yml",
    "../docker-compose.yml",
    "config/../../docker-compose.yml",
    "./docker-compose.yml",
    "config//docker-compose.yml",
    "config\\docker-compose.yml"
  ])("rejects compose path escape %s", (composeFile) => {
    expect(() => selfUpdateComposeFileSchema.parse(composeFile)).toThrow(/relative Linux path|must not contain/);
  });

  it.each([
    "docker-compose.image.yml",
    "deploy/compose production.yml"
  ])("accepts confined relative compose path %s", (composeFile) => {
    expect(selfUpdateComposeFileSchema.parse(composeFile)).toBe(composeFile);
  });
});
