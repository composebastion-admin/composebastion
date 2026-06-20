import { describe, expect, it } from "vitest";
import { filterAndSortContainers } from "./containerList.js";

const containers = [
  {
    id: "1",
    hostId: "h1",
    kind: "container" as const,
    externalId: "a",
    name: "web",
    data: { Names: "beta", State: "running", Image: "nginx:alpine" },
    updatedAt: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "2",
    hostId: "h1",
    kind: "container" as const,
    externalId: "b",
    name: "db",
    data: { Names: "alpha", State: "exited", Image: "postgres:16" },
    updatedAt: "2026-01-01T00:00:00.000Z"
  }
];

describe("filterAndSortContainers", () => {
  it("filters by query and running state", () => {
    const filtered = filterAndSortContainers(containers, "beta", "running", "name", false);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe("web");
  });

  it("sorts by name descending", () => {
    const sorted = filterAndSortContainers(containers, "", "all", "name", true);
    expect(sorted.map((row) => row.name)).toEqual(["web", "db"]);
  });
});
