import { describe, expect, it } from "vitest";
import { diffText } from "./diffText.js";

describe("diffText", () => {
  it("detects added, removed, and changed lines", () => {
    const changes = diffText("a\nb", "a\nc\nd");
    expect(changes.some((change) => change.type === "change" && change.line === 2)).toBe(true);
    expect(changes.some((change) => change.type === "add" && change.line === 3)).toBe(true);
  });
});
