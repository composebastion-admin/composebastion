import { describe, expect, it } from "vitest";
import { containersToRestart, recordRunningStates, wasAnyContainerRunning } from "../src/services/recoveryManifest.js";

describe("recovery capture stop-first behavior", () => {
  it("only restarts containers that were running before backup", () => {
    const before = recordRunningStates([
      { id: "web", inspect: { Name: "/demoapp-web-1", State: { Running: true, Status: "running" } } },
      { id: "db", inspect: { Name: "/demoapp-db-1", State: { Running: false, Status: "exited" } } }
    ]);

    expect(wasAnyContainerRunning(before)).toBe(true);
    expect(containersToRestart(before)).toEqual(["web"]);
  });

  it("skips stop-first when every container is already stopped", () => {
    const before = recordRunningStates([
      { id: "web", inspect: { Name: "/demoapp-web-1", State: { Running: false, Status: "exited" } } }
    ]);
    expect(wasAnyContainerRunning(before)).toBe(false);
    expect(containersToRestart(before)).toEqual([]);
  });
});
