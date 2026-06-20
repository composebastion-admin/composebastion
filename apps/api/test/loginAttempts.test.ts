import { describe, expect, it } from "vitest";
import { isLoginLockedForSnapshot } from "../src/services/loginAttempts.js";

describe("login lockout decisions", () => {
  it("locks the attacking IP after repeated failures", () => {
    expect(isLoginLockedForSnapshot({
      ipFailures: 10,
      identifierFailures: 10,
      identifierDistinctIps: 1
    })).toBe(true);
  });

  it("does not globally lock an identifier from one attacking IP", () => {
    expect(isLoginLockedForSnapshot({
      ipFailures: 0,
      identifierFailures: 30,
      identifierDistinctIps: 1
    })).toBe(false);
  });

  it("keeps a higher identifier-wide lockout for distributed attacks", () => {
    expect(isLoginLockedForSnapshot({
      ipFailures: 9,
      identifierFailures: 30,
      identifierDistinctIps: 3
    })).toBe(true);
  });
});
