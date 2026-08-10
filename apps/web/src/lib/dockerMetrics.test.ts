import { describe, expect, it } from "vitest";
import type { ResourceSnapshot } from "@composebastion/shared";
import { findUsageRow } from "./dockerMetrics.js";

const fullId = "5fb479d76eb43580fcd59f1739151aa4922d80b8292d25fecc76af9a149b7398";
const container: ResourceSnapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  hostId: "00000000-0000-4000-8000-000000000002",
  kind: "container",
  externalId: fullId,
  name: "web",
  data: { Names: "web" },
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("findUsageRow", () => {
  it("matches abbreviated IDs and full Container identities", () => {
    const abbreviated = { ID: fullId.slice(0, 12), CPUPerc: "1.00%" };
    const byContainer = { Container: fullId, Name: "renamed-web", CPUPerc: "2.00%" };

    expect(findUsageRow(container, [abbreviated])).toBe(abbreviated);
    expect(findUsageRow(container, [byContainer])).toBe(byContainer);
  });

  it("matches Name and Names variants without accepting identity-less metrics", () => {
    const byNames = { Names: "web", CPUPerc: "1.00%" };
    expect(findUsageRow(container, [{ CPUPerc: "9.00%" }, byNames])).toBe(byNames);
    expect(findUsageRow(container, [{ CPUPerc: "9.00%" }])).toBeUndefined();
  });
});
