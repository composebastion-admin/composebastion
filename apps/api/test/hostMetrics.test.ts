import { describe, expect, it } from "vitest";
import {
  computeCpuPercent,
  parseDfDisks,
  parseHostStatsSnapshot,
  parseMeminfo,
  parseNetworkDev,
  parseProcStatCpu,
  parseSnapshotSections
} from "../src/services/hostMetrics.js";

const hostId = "00000000-0000-4000-8000-000000000001";

const meminfo = `MemTotal:       8000000 kB
MemFree:        1000000 kB
MemAvailable:   5000000 kB
Buffers:         250000 kB
Cached:         1000000 kB
SwapTotal:      2000000 kB
SwapFree:       1500000 kB
`;

const net1 = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
  eth0: 1000 1 0 0 0 0 0 0 5000 1 0 0 0 0 0 0
 wlan0: 2000 1 0 0 0 0 0 0 7000 1 0 0 0 0 0 0
`;

const net2 = net1
  .replace("eth0: 1000", "eth0: 5000")
  .replace("5000 1 0 0 0 0 0 0", "9000 1 0 0 0 0 0 0")
  .replace("wlan0: 2000", "wlan0: 6000")
  .replace("7000 1 0 0 0 0 0 0", "11000 1 0 0 0 0 0 0");

const df = `Filesystem     1B-blocks     Used Available Use% Mounted on
/dev/sda1     1000000000 250000000 750000000  25% /
tmpfs           10000000   1000000   9000000  10% /run
overlay       2000000000 100000000 1900000000 5% /var/lib/docker/overlay2/demo
/dev/sdb1     4000000000 3000000000 1000000000 75% /data
`;

describe("host metric parsers", () => {
  it("splits the SSH snapshot sections", () => {
    const sections = parseSnapshotSections("##stat\ncpu  1 0 2 7\n##mem\nMemTotal: 1 kB\n##load\n0.1 0.2 0.3 1/2 3\n");
    expect(sections.stat).toBe("cpu  1 0 2 7");
    expect(sections.meminfo).toContain("MemTotal");
    expect(sections.loadavg).toContain("0.1");
  });

  it("computes CPU percent from /proc/stat deltas", () => {
    const previous = parseProcStatCpu("cpu  100 0 100 800 0 0 0 0 0 0");
    const current = parseProcStatCpu("cpu  160 0 140 900 0 0 0 0 0 0");
    expect(computeCpuPercent(current, previous)).toBe(50);
    expect(computeCpuPercent(current, null)).toBeNull();
  });

  it("converts meminfo kB fields to byte totals", () => {
    const parsed = parseMeminfo(meminfo);
    expect(parsed.memory.totalBytes).toBe(8_000_000 * 1024);
    expect(parsed.memory.availableBytes).toBe(5_000_000 * 1024);
    expect(parsed.memory.usedBytes).toBe(3_000_000 * 1024);
    expect(parsed.swap.totalBytes).toBe(2_000_000 * 1024);
    expect(parsed.swap.usedBytes).toBe(500_000 * 1024);
  });

  it("sums non-loopback network interfaces and leaves first-sample rates null", () => {
    expect(parseNetworkDev(net1)).toEqual({ rxBytes: 3000, txBytes: 12000 });
    const first = parseHostStatsSnapshot(hostId, {
      stat: "cpu  100 0 100 800 0 0 0 0 0 0",
      meminfo,
      loadavg: "0.10 0.20 0.30 1/100 123",
      uptime: "1234.56 1000.00",
      netdev: net1,
      df
    }, null, 1_000);
    expect(first.stats.cpuPercent).toBeNull();
    expect(first.stats.network).toBeNull();

    const second = parseHostStatsSnapshot(hostId, {
      stat: "cpu  160 0 140 900 0 0 0 0 0 0",
      meminfo,
      loadavg: "0.40 0.50 0.60 1/100 123",
      uptime: "1240.99 1000.00",
      netdev: net2,
      df
    }, first.raw, 3_000);
    expect(second.stats.cpuPercent).toBe(50);
    expect(second.stats.network).toEqual({ rxBytesPerSec: 6000, txBytesPerSec: 2000 });
    expect(second.stats.load).toEqual({ one: 0.4, five: 0.5, fifteen: 0.6 });
    expect(second.stats.uptimeSeconds).toBe(1240);
  });

  it("parses df output and filters pseudo filesystems", () => {
    expect(parseDfDisks(df)).toEqual([
      { mount: "/", totalBytes: 1_000_000_000, usedBytes: 250_000_000, usedPercent: 25 },
      { mount: "/data", totalBytes: 4_000_000_000, usedBytes: 3_000_000_000, usedPercent: 75 }
    ]);
  });
});
