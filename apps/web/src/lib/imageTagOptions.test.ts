import { describe, expect, it } from "vitest";
import { compareImageTags, filterImageTags, uniqueSortedImageTags } from "./imageTagOptions.js";

describe("image tag options", () => {
  it("pins common channels before numbered versions", () => {
    expect(["v1.1.0", "dev", "main", "beta", "latest"].sort(compareImageTags)).toEqual([
      "latest",
      "main",
      "beta",
      "dev",
      "v1.1.0"
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
    const tags = uniqueSortedImageTags(["dev", "1.0.0", "dev"], ["<none>", "1.2.0"]);
    expect(tags).toEqual(["dev", "1.2.0", "1.0.0"]);
    expect(filterImageTags(tags, "1.", 1)).toEqual(["1.2.0"]);
  });
});
