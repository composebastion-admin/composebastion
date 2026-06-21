import { describe, expect, it } from "vitest";
import { parseApiJson } from "./api.js";

describe("parseApiJson", () => {
  it("returns null for empty bodies", () => {
    expect(parseApiJson("")).toBeNull();
  });

  it("parses valid JSON", () => {
    expect(parseApiJson('{"ok":true}')).toEqual({ ok: true });
  });

  it("returns null instead of throwing on invalid JSON", () => {
    expect(parseApiJson("not json")).toBeNull();
  });
});
