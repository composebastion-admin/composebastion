import { describe, expect, it } from "vitest";
import { navigationGroups } from "./navigation.js";
import { isTab, tabFromPath, tabPath } from "./tabRoute.js";

describe("tabRoute", () => {
  it("maps known tabs to paths", () => {
    expect(tabPath("containers")).toBe("/containers");
    expect(isTab("jobs")).toBe(true);
  });

  it("falls back for unknown segments", () => {
    expect(tabFromPath("not-a-tab")).toBe("overview");
    expect(tabFromPath("audit")).toBe("audit");
    expect(tabFromPath("recovery")).toBe("recovery");
    expect(tabFromPath("recovery-schedules")).toBe("recovery-schedules");
    expect(tabFromPath("host-metrics")).toBe("host-metrics");
  });

  it("keeps apps routable but hidden from primary navigation", () => {
    expect(isTab("apps")).toBe(true);
    expect(tabPath("apps")).toBe("/apps");
    expect(navigationGroups.flatMap((group) => group.items)).not.toContain("apps");
  });

  it("keeps updates routable but out of primary navigation", () => {
    const deploy = navigationGroups.find((group) => group.title === "Deploy");
    expect(isTab("updates")).toBe(true);
    expect(tabPath("updates")).toBe("/updates");
    expect(navigationGroups.flatMap((group) => group.items)).not.toContain("updates");
    expect(deploy?.items).not.toContain("updates");
  });

  it("keeps host inventory and SSH access together in Docker navigation", () => {
    const docker = navigationGroups.find((group) => group.title === "Docker");
    const dockerItems = docker?.items ?? [];
    expect(isTab("ssh")).toBe(true);
    expect(tabPath("ssh")).toBe("/ssh");
    expect(dockerItems).toEqual(expect.arrayContaining(["hosts", "ssh"]));
    expect(dockerItems.indexOf("ssh")).toBeGreaterThan(dockerItems.indexOf("hosts"));
  });
});
