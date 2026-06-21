import { describe, expect, it } from "vitest";
import type { HostStats } from "@composebastion/shared";
import { evaluateHostThreshold } from "../src/services/hostAlertEvaluation.js";

const now = new Date("2026-06-16T12:00:00.000Z");

function stats(overrides: Partial<HostStats> = {}): HostStats {
  return {
    hostId: "00000000-0000-4000-8000-000000000001",
    collectedAt: now.toISOString(),
    cpuPercent: 85,
    load: { one: 2.5, five: 2.1, fifteen: 1.9 },
    memory: {
      totalBytes: 1_000,
      usedBytes: 750,
      availableBytes: 250
    },
    swap: {
      totalBytes: 500,
      usedBytes: 100
    },
    disks: [
      { mount: "/", totalBytes: 1_000, usedBytes: 700, usedPercent: 70 },
      { mount: "/data", totalBytes: 1_000, usedBytes: 920, usedPercent: 92 }
    ],
    network: null,
    containers: null,
    uptimeSeconds: 1_000,
    ...overrides
  };
}

describe("host threshold alert evaluation", () => {
  it("honors gt and gte comparators", () => {
    expect(evaluateHostThreshold("host.cpu", { comparator: "gt", threshold: 85, durationSeconds: 60 }, stats(), null, now).overThreshold).toBe(false);
    expect(evaluateHostThreshold("host.cpu", { comparator: "gte", threshold: 85, durationSeconds: 60 }, stats(), null, now).overThreshold).toBe(true);
  });

  it("computes percent metrics and guards zero totals", () => {
    expect(evaluateHostThreshold("host.memory", { comparator: "gte", threshold: 75, durationSeconds: 60 }, stats(), null, now).value).toBe(75);
    expect(evaluateHostThreshold(
      "host.memory",
      { comparator: "gte", threshold: 1, durationSeconds: 60 },
      stats({ memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0 } }),
      null,
      now
    )).toMatchObject({ value: null, overThreshold: false, triggered: false, nextBreachingSince: null });
    expect(evaluateHostThreshold(
      "host.swap",
      { comparator: "gte", threshold: 1, durationSeconds: 60 },
      stats({ swap: { totalBytes: 0, usedBytes: 0 } }),
      null,
      now
    )).toMatchObject({ value: 0, overThreshold: false });
  });

  it("uses a selected disk mount or the max disk percent", () => {
    expect(evaluateHostThreshold("host.disk", { comparator: "gte", threshold: 90, durationSeconds: 60, mount: "/" }, stats(), null, now).value).toBe(70);
    expect(evaluateHostThreshold("host.disk", { comparator: "gte", threshold: 90, durationSeconds: 60 }, stats(), null, now).value).toBe(92);
  });

  it("requires the threshold to breach for the configured duration", () => {
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const sixMinutesAgo = new Date(now.getTime() - 6 * 60_000);

    expect(evaluateHostThreshold("host.cpu", { comparator: "gte", threshold: 80, durationSeconds: 300 }, stats(), oneMinuteAgo, now)).toMatchObject({
      overThreshold: true,
      triggered: false,
      nextBreachingSince: oneMinuteAgo
    });
    expect(evaluateHostThreshold("host.cpu", { comparator: "gte", threshold: 80, durationSeconds: 300 }, stats(), sixMinutesAgo, now)).toMatchObject({
      overThreshold: true,
      triggered: true,
      nextBreachingSince: sixMinutesAgo
    });
  });

  it("starts and clears the breaching window", () => {
    const started = evaluateHostThreshold("host.load", { comparator: "gte", threshold: 2, durationSeconds: 60 }, stats(), null, now, "prod-01");
    expect(started).toMatchObject({ value: 2.5, overThreshold: true, triggered: false, nextBreachingSince: now });
    expect(started.message).toBe("prod-01 load 2.5 >= 2 for 1m");

    expect(evaluateHostThreshold(
      "host.load",
      { comparator: "gte", threshold: 3, durationSeconds: 60 },
      stats(),
      new Date(now.getTime() - 120_000),
      now
    )).toMatchObject({ overThreshold: false, triggered: false, nextBreachingSince: null });
  });

  it("never triggers when the metric value is unknown", () => {
    expect(evaluateHostThreshold("host.cpu", { comparator: "gte", threshold: 80, durationSeconds: 60 }, stats({ cpuPercent: null }), new Date(now.getTime() - 120_000), now)).toMatchObject({
      value: null,
      overThreshold: false,
      triggered: false,
      nextBreachingSince: null
    });
  });
});
