import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostMetricsSnapshot = vi.fn();
const getFleetHostSnapshot = vi.fn();
const streamHostStats = vi.fn();
const listHosts = vi.fn();

vi.mock("../src/services/auth.js", () => ({
  requireRole: vi.fn(() => async () => undefined)
}));

vi.mock("../src/services/hostMetrics.js", () => ({
  getFleetHostSnapshot,
  getHostMetricsSnapshot,
  streamHostStats
}));

vi.mock("../src/services/hosts.js", () => ({
  listHosts
}));

const { registerHostMetricRoutes } = await import("../src/routes/hostMetrics.js");

const hostId = "00000000-0000-4000-8000-000000000201";

function specs() {
  return {
    hostId,
    cpuCores: 4,
    memTotalBytes: 8_589_934_592,
    os: "Linux",
    arch: "x86_64",
    dockerVersion: "29.0.0",
    collectedAt: new Date(0).toISOString()
  };
}

function stats() {
  return {
    hostId,
    collectedAt: new Date(0).toISOString(),
    cpuPercent: null,
    load: null,
    memory: { totalBytes: 8_589_934_592, usedBytes: 0, availableBytes: 8_589_934_592 },
    swap: { totalBytes: 0, usedBytes: 0 },
    disks: [],
    network: null,
    containers: { running: 1, total: 2 },
    uptimeSeconds: 0
  };
}

async function buildApp() {
  const app = Fastify();
  await registerHostMetricRoutes(app);
  return app;
}

describe("host metrics routes", () => {
  beforeEach(() => {
    getHostMetricsSnapshot.mockReset();
    getFleetHostSnapshot.mockReset();
    streamHostStats.mockReset();
    listHosts.mockReset();
  });

  it("returns degraded fleet rows without failing the host", async () => {
    listHosts.mockResolvedValue([{ id: hostId, name: "Agent Host" }]);
    getFleetHostSnapshot.mockResolvedValue({
      specs: specs(),
      stats: stats(),
      degradedReason: "Agent host stats unavailable: not found"
    });
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/hosts/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        hostId,
        name: "Agent Host",
        online: true,
        specs: specs(),
        stats: stats(),
        degradedReason: "Agent host stats unavailable: not found"
      }
    ]);
    expect(getFleetHostSnapshot).toHaveBeenCalledWith(hostId);
    expect(getHostMetricsSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns an offline row when fleet snapshot collection times out or fails", async () => {
    listHosts.mockResolvedValue([{ id: hostId, name: "Slow Host" }]);
    getFleetHostSnapshot.mockRejectedValue(new Error("SSH command timed out after 4000ms"));
    const app = await buildApp();

    const response = await app.inject({ method: "GET", url: "/api/hosts/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        hostId,
        name: "Slow Host",
        online: false,
        error: "SSH command timed out after 4000ms"
      }
    ]);
    await app.close();
  });
});
