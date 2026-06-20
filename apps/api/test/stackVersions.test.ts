import { describe, expect, it } from "vitest";
import { diffText } from "@dockermender/shared";

describe("stack version diff helper", () => {
  it("reports env-agnostic compose line changes", () => {
    const changes = diffText("services:\n  app:\n    image: nginx:1", "services:\n  app:\n    image: nginx:2");
    expect(changes.some((change) => change.type === "change")).toBe(true);
  });
});
