import { describe, expect, it } from "vitest";
import type { AppGithubVersionOption } from "@composebastion/shared";
import { compareGithubVersionOptions, countGithubVersionUpdates, groupGithubVersionOptions, shortVersionSha } from "./sourceVersions.js";

const option = (kind: AppGithubVersionOption["kind"], ref: string, updateAvailable = false): AppGithubVersionOption => ({
  kind,
  name: ref,
  ref,
  label: ref,
  commitSha: `${ref}-sha`,
  publishedAt: null,
  htmlUrl: null,
  selected: false,
  deployed: false,
  updateAvailable
});

describe("source version helpers", () => {
  it("groups GitHub options by kind", () => {
    const groups = groupGithubVersionOptions([
      option("tag", "v1.0.0"),
      option("branch", "main"),
      option("release", "v1.0.0")
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["branch", "tag", "release"]);
    expect(groups[0]?.options.map((item) => item.ref)).toEqual(["main"]);
  });

  it("counts update candidates and shortens SHAs", () => {
    expect(countGithubVersionUpdates([option("branch", "main", true), option("branch", "dev")])).toBe(1);
    expect(shortVersionSha("1234567890abcdef")).toBe("1234567890ab");
    expect(shortVersionSha(null)).toBe("unknown");
  });

  it("sorts version-like refs newest first and keeps selected refs prominent", () => {
    const selected = { ...option("tag", "v1.0.0"), selected: true };
    expect([
      option("tag", "1.6.2-beta.1"),
      option("tag", "1.5.10"),
      option("tag", "1.6.2-beta.5"),
      option("tag", "1.6.3")
    ].sort(compareGithubVersionOptions).map((item) => item.ref)).toEqual([
      "1.6.3",
      "1.6.2-beta.5",
      "1.6.2-beta.1",
      "1.5.10"
    ]);
    expect([option("tag", "v2.0.0"), selected].sort(compareGithubVersionOptions)[0]).toBe(selected);
  });

  it("filters grouped versions by query", () => {
    const groups = groupGithubVersionOptions([
      option("tag", "v1.0.0"),
      option("tag", "v2.0.0"),
      option("branch", "dev")
    ], "v2");
    expect(groups.find((group) => group.kind === "tag")?.options.map((item) => item.ref)).toEqual(["v2.0.0"]);
    expect(groups.find((group) => group.kind === "branch")?.options).toEqual([]);
  });
});
