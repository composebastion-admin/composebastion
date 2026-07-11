import { describe, expect, it } from "vitest";
import { authorizationForRole, resolveAdminSection, resolveAuthorizedTab } from "./authorization.js";

describe("web authorization capabilities", () => {
  it("keeps viewers on read-only inventory and history surfaces", () => {
    const viewer = authorizationForRole("viewer");
    expect(viewer).toMatchObject({ canOperate: false, canAdminister: false, canUseTerminal: false });
    expect(viewer.allowedTabs.has("containers")).toBe(true);
    expect(viewer.allowedTabs.has("recovery-runs")).toBe(true);
    expect(viewer.allowedTabs.has("deploy")).toBe(false);
    expect(viewer.allowedTabs.has("users")).toBe(false);
  });

  it("allows operators to operate without exposing administration or terminals", () => {
    const operator = authorizationForRole("operator");
    expect(operator).toMatchObject({ canOperate: true, canAdminister: false, canUseTerminal: false });
    expect(operator.allowedTabs.has("deploy")).toBe(true);
    expect(operator.allowedTabs.has("registries")).toBe(true);
    expect(operator.allowedTabs.has("audit")).toBe(false);
    expect(operator.allowedAdminSections).not.toContain("users");
  });

  it("allows owners and admins to administer and use host terminals", () => {
    for (const role of ["owner", "admin"] as const) {
      const authorization = authorizationForRole(role);
      expect(authorization.canAdminister).toBe(true);
      expect(authorization.canUseTerminal).toBe(true);
      expect(authorization.allowedTabs.has("users")).toBe(true);
      expect(authorization.allowedAdminSections).toContain("audit");
    }
  });

  it("redirects disallowed tabs and nested admin sections to safe defaults", () => {
    const viewer = authorizationForRole("viewer");
    expect(resolveAuthorizedTab("users", viewer.allowedTabs)).toBe("overview");
    expect(resolveAuthorizedTab("containers", viewer.allowedTabs)).toBe("containers");
    expect(resolveAdminSection("users", viewer.allowedAdminSections)).toBe("settings");
  });
});
