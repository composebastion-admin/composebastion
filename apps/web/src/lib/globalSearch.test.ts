import { describe, expect, it } from "vitest";
import { searchScope } from "./globalSearch.js";

const hosts = [
  { id: "h1", name: "Prod", hostname: "10.0.0.1", username: "docker", tags: [] },
  { id: "h2", name: "Staging", hostname: "10.0.0.2", username: "docker", tags: [] }
] as any[];

const resources = [
  { id: "c1", hostId: "h1", kind: "container", name: "nginx-web", externalId: "abc" },
  { id: "i1", hostId: "h2", kind: "image", name: "redis:7", externalId: "def" }
] as any[];

describe("searchScope", () => {
  it("returns empty for short queries", () => {
    expect(searchScope(hosts, resources, ["h1", "h2"], "a")).toEqual([]);
  });

  it("finds hosts and resources in scope", () => {
    const results = searchScope(hosts, resources, ["h1", "h2"], "nginx");
    expect(results).toHaveLength(1);
    expect(results[0]?.kind).toBe("resource");
    expect(results[0]?.tab).toBe("containers");
  });

  it("respects scoped host ids", () => {
    const results = searchScope(hosts, resources, ["h2"], "prod");
    expect(results).toHaveLength(0);
  });
});
