import { describe, expect, it } from "vitest";
import {
  compareLooseVersionTags,
  compareReleaseVersions,
  isStableReleaseVersion,
  parseLooseVersionTag,
  parseReleaseVersion
} from "./versions.js";

describe("release version helpers", () => {
  it("uses SemVer prerelease ordering", () => {
    expect(compareReleaseVersions("1.1.0", "1.1.0-rc.1")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.1.0-rc.10", "1.1.0-rc.2")).toBeGreaterThan(0);
    expect(compareReleaseVersions("v1.0.7+build.4", "1.0.7+build.3")).toBe(0);
  });

  it("rejects channels and malformed release versions", () => {
    expect(parseReleaseVersion("latest")).toBeNull();
    expect(parseReleaseVersion("1.2")).toBeNull();
    expect(parseReleaseVersion("1.2.3.4")).toBeNull();
    expect(compareReleaseVersions("beta", "1.0.0")).toBeNull();
  });

  it("identifies stable releases", () => {
    expect(isStableReleaseVersion("v1.1.0")).toBe(true);
    expect(isStableReleaseVersion("1.1.0-rc.1")).toBe(false);
  });

  it("pads short source tags without weakening release parsing", () => {
    expect(parseLooseVersionTag("v2")).toBe("2.0.0");
    expect(parseLooseVersionTag("2.3")).toBe("2.3.0");
    expect(compareLooseVersionTags("2.3", "2.2.9")).toBeGreaterThan(0);
  });
});
