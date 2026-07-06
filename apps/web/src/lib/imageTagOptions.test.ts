import { describe, expect, it } from "vitest";
import {
  compareImageTags,
  filterImageTags,
  isNewerVersionTag,
  latestPrereleaseImageTag,
  latestStableImageTag,
  recommendedImageVersionTag,
  summarizeImageVersionTags,
  uniqueSortedImageTags
} from "./imageTagOptions.js";

describe("image tag options", () => {
  it("pins common channels before numbered versions", () => {
    expect(["v0.9.7", "dev", "main", "beta", "latest"].sort(compareImageTags)).toEqual([
      "latest",
      "main",
      "beta",
      "dev",
      "v0.9.7"
    ]);
  });

  it("sorts semantic versions newest first", () => {
    expect(["1.6.2-beta.1", "1.5.10", "1.6.2-beta.5", "1.6.3", "1.6.2"].sort(compareImageTags)).toEqual([
      "1.6.3",
      "1.6.2",
      "1.6.2-beta.5",
      "1.6.2-beta.1",
      "1.5.10"
    ]);
  });

  it("deduplicates, filters, and limits tags", () => {
    const tags = uniqueSortedImageTags(["dev", "0.9.6", "dev"], ["<none>", "0.9.7"]);
    expect(tags).toEqual(["dev", "0.9.7", "0.9.6"]);
    expect(filterImageTags(tags, "0.9", 1)).toEqual(["0.9.7"]);
  });

  it("summarizes numbered versions separately from mutable channels", () => {
    const tags = uniqueSortedImageTags(["latest", "main", "dev", "1.6.6-beta.2", "1.6.5", "1.2", "1.1"]);

    expect(latestStableImageTag(tags)).toBe("1.6.5");
    expect(latestPrereleaseImageTag(tags)).toBe("1.6.6-beta.2");
    expect(isNewerVersionTag("1.2", "1.1")).toBe(true);
    expect(isNewerVersionTag("dev", "1.1")).toBe(false);
    expect(summarizeImageVersionTags(tags, "1.1")).toMatchObject({
      latestStable: "1.6.5",
      latestPrerelease: "1.6.6-beta.2",
      stableUpdateAvailable: true,
      prereleaseUpdateAvailable: true
    });
  });

  it("recommends prerelease versions for beta channel updates", () => {
    const tags = uniqueSortedImageTags(["latest", "main", "beta", "dev", "1.7.0-beta.4", "1.7.0-beta.3", "1.6.7", "1.2.2"]);

    expect(recommendedImageVersionTag(tags, "beta")).toBe("1.7.0-beta.4");
    expect(summarizeImageVersionTags(tags, "beta")).toMatchObject({
      latestStable: "1.6.7",
      latestPrerelease: "1.7.0-beta.4",
      recommendedUpdateTag: "1.7.0-beta.4",
      versionUpdateAvailable: true
    });
    expect(summarizeImageVersionTags(tags, "latest")).toMatchObject({
      recommendedUpdateTag: "1.6.7",
      versionUpdateAvailable: false
    });
  });

  it("keeps stable version users on stable updates", () => {
    const tags = uniqueSortedImageTags(["latest", "beta", "1.7.0-beta.4", "1.6.7", "1.6.6"]);

    expect(recommendedImageVersionTag(tags, "1.6.6")).toBe("1.6.7");
    expect(recommendedImageVersionTag(tags, "1.6.7")).toBeNull();
  });
});
