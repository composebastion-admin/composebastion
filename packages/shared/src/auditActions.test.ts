import { describe, expect, it } from "vitest";
import { directHostActionTypes } from "./index.js";
import { auditActions } from "./auditActions.js";

describe("audit action catalog", () => {
  it("is unique, stable, and covers every direct host action", () => {
    expect(auditActions).toHaveLength(142);
    expect(new Set(auditActions).size).toBe(auditActions.length);
    expect([...auditActions].sort()).toEqual(auditActions);
    expect(auditActions).toEqual(expect.arrayContaining([...directHostActionTypes]));
  });
});
