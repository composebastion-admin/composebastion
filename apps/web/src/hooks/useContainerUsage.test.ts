import { describe, expect, it } from "vitest";
import {
  CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS,
  CONTAINER_USAGE_STREAM_RETRY_MS,
  CONTAINER_USAGE_STREAM_STALE_MS,
  containerUsageSnapshotRequestGeneration,
  containerUsageStreamDecision,
  isContainerUsageSnapshotRequestCurrent,
  parseContainerUsageSnapshot,
  reduceContainerUsageRows,
  shouldApplyContainerUsageSnapshot
} from "./useContainerUsage.js";

const fullId = "5fb479d76eb43580fcd59f1739151aa4922d80b8292d25fecc76af9a149b7398";
const tombstone = { Container: fullId, ID: "", Name: "--", CPUPerc: "0.00%" };

describe("container usage stream freshness", () => {
  it("keeps polling until both a stream frame and an authoritative snapshot succeed", () => {
    expect(containerUsageStreamDecision(10_000, 0, undefined, undefined)).toEqual({ poll: true, reconnect: false });
    expect(containerUsageStreamDecision(10_000, 0, 9_999, undefined)).toEqual({ poll: true, reconnect: false });
    expect(containerUsageStreamDecision(10_000, 0, 9_999, 9_998)).toEqual({ poll: false, reconnect: false });
  });

  it("polls stale streams and reconnects them after sixty seconds", () => {
    expect(containerUsageStreamDecision(CONTAINER_USAGE_STREAM_STALE_MS - 1, 0, 1, 1)).toEqual({ poll: false, reconnect: false });
    expect(containerUsageStreamDecision(CONTAINER_USAGE_STREAM_STALE_MS + 1, 0, 1, 1)).toEqual({ poll: true, reconnect: false });
    expect(containerUsageStreamDecision(CONTAINER_USAGE_STREAM_RETRY_MS + 1, 0, 1, 1)).toEqual({ poll: true, reconnect: true });
  });

  it("reconciles fresh streams against an authoritative snapshot every sixty seconds", () => {
    const now = CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS;
    expect(containerUsageStreamDecision(now - 1, 0, now - 2, 0)).toEqual({ poll: false, reconnect: false });
    expect(containerUsageStreamDecision(now, 0, now - 1, 0)).toEqual({ poll: true, reconnect: false });
  });
});

describe("container usage snapshot lifecycle", () => {
  it("ignores a removed host's late result and lets a re-added generation start immediately", () => {
    let activeGeneration: number | undefined = 1;
    let inFlightGeneration: number | undefined;

    const removedHostRequest = containerUsageSnapshotRequestGeneration(activeGeneration, inFlightGeneration);
    expect(removedHostRequest).toBe(1);
    inFlightGeneration = removedHostRequest ?? undefined;

    activeGeneration = undefined;
    expect(isContainerUsageSnapshotRequestCurrent(activeGeneration, removedHostRequest!)).toBe(false);

    activeGeneration = 2;
    const readdedHostRequest = containerUsageSnapshotRequestGeneration(activeGeneration, inFlightGeneration);
    expect(readdedHostRequest).toBe(2);
    inFlightGeneration = readdedHostRequest ?? undefined;

    if (inFlightGeneration === removedHostRequest) inFlightGeneration = undefined;
    expect(inFlightGeneration).toBe(readdedHostRequest);
    expect(isContainerUsageSnapshotRequestCurrent(activeGeneration, removedHostRequest!)).toBe(false);
    expect(isContainerUsageSnapshotRequestCurrent(activeGeneration, readdedHostRequest!)).toBe(true);
    expect(containerUsageSnapshotRequestGeneration(activeGeneration, inFlightGeneration)).toBeNull();
  });

  it("does not let a slower snapshot overwrite a newer stream frame", () => {
    expect(shouldApplyContainerUsageSnapshot(4, 4)).toBe(true);
    expect(shouldApplyContainerUsageSnapshot(4, 5)).toBe(false);
  });
});

describe("container usage row reduction", () => {
  it("never grows state for repeated identity-less, placeholder, or tombstone frames", () => {
    const original = [{ ID: "container-1", Name: "web", CPUPerc: "1.00%" }];
    const invalidFrames: unknown[] = [
      null,
      [],
      "invalid",
      {},
      { CPUPerc: "2.00%", MemPerc: "3.00%" },
      { Name: "--", CPUPerc: "0.00%" },
      { Container: "5fb479d76eb4", CPUPerc: "0.00%" },
      { Container: fullId, CPUPerc: "0.00%" },
      tombstone
    ];

    let rows: Record<string, unknown>[] = original;
    for (let index = 0; index < 100; index += 1) {
      rows = reduceContainerUsageRows(rows, invalidFrames[index % invalidFrames.length]);
    }

    expect(rows).toBe(original);
    expect(rows).toHaveLength(1);
  });

  it("replaces a valid row that has the same ID or container name", () => {
    const byId = reduceContainerUsageRows(
      [{ ID: "container-1", Name: "old-name", CPUPerc: "1.00%" }],
      { ID: "container-1", Name: "new-name", CPUPerc: "2.00%" }
    );
    expect(byId).toEqual([{ ID: "container-1", Name: "new-name", CPUPerc: "2.00%" }]);

    const byName = reduceContainerUsageRows(
      [{ ID: "old-id", Names: "web", CPUPerc: "1.00%" }],
      { ID: "new-id", Name: "web", CPUPerc: "3.00%" }
    );
    expect(byName).toEqual([{ ID: "new-id", Name: "web", CPUPerc: "3.00%" }]);
  });

  it("correlates a full Container identity with an abbreviated ID on otherwise valid rows", () => {
    const rows = reduceContainerUsageRows(
      [{ Container: fullId, Name: "web", CPUPerc: "1.00%" }],
      { ID: fullId.slice(0, 12), Name: "renamed-web", CPUPerc: "4.00%" }
    );

    expect(rows).toEqual([
      { ID: fullId.slice(0, 12), Name: "renamed-web", CPUPerc: "4.00%" }
    ]);
  });

  it("validates snapshots atomically, deduplicates identities, and never stores tombstones", () => {
    expect(parseContainerUsageSnapshot([
      { ID: "container-1", Name: "web", CPUPerc: "1.00%" },
      tombstone,
      { ID: "container-1", Name: "web", CPUPerc: "2.00%" }
    ])).toEqual([{ ID: "container-1", Name: "web", CPUPerc: "2.00%" }]);
    expect(parseContainerUsageSnapshot([
      { ID: "container-1", Name: "web" },
      { CPUPerc: "2.00%" }
    ])).toBeNull();
    expect(parseContainerUsageSnapshot({ usage: [] })).toBeNull();
  });

  it("eventually removes a tombstoned container through fresh-stream snapshot reconciliation", () => {
    const containerA = { ID: "container-a", Name: "web", CPUPerc: "1.00%" };
    const containerB = { ID: "container-b", Name: "worker", CPUPerc: "2.00%" };
    const lastGoodRows = [containerA, containerB];
    const afterFilteredTombstone = reduceContainerUsageRows(lastGoodRows, tombstone);

    expect(afterFilteredTombstone).toBe(lastGoodRows);
    expect(afterFilteredTombstone).toEqual([containerA, containerB]);
    expect(containerUsageStreamDecision(
      CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS,
      0,
      CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS - 1,
      0
    )).toEqual({ poll: true, reconnect: false });

    const failedReconciliation = parseContainerUsageSnapshot([
      containerA,
      { CPUPerc: "identity-less" }
    ]);
    const rowsAfterFailure = failedReconciliation ?? afterFilteredTombstone;
    expect(rowsAfterFailure).toBe(lastGoodRows);
    expect(containerUsageStreamDecision(
      CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS + 10_000,
      0,
      CONTAINER_USAGE_SNAPSHOT_RECONCILE_MS + 9_999,
      0
    )).toEqual({ poll: true, reconnect: false });

    const authoritativeRows = parseContainerUsageSnapshot([containerA]);
    expect(authoritativeRows).toEqual([containerA]);
    expect(authoritativeRows).not.toContain(containerB);
  });
});
