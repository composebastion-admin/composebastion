import type { DockerHost, HostDisk, HostSpecs, HostStats } from "@composebastion/shared";
import { query } from "../db/pool.js";
import { getAgentHostStats } from "./agent.js";
import { runDocker } from "./docker.js";
import { isDemoHost } from "./demo.js";
import { getHostForWorker } from "./hosts.js";
import { runSshCommand } from "./ssh.js";

const HOST_STATS_SNAPSHOT_COMMAND = "LANG=C; printf '##stat\n'; head -1 /proc/stat; printf '##mem\n'; cat /proc/meminfo; printf '##load\n'; cat /proc/loadavg; printf '##up\n'; cat /proc/uptime; printf '##net\n'; cat /proc/net/dev; printf '##df\n'; df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null";
const SPECS_CACHE_MS = 60_000;
const STREAM_INTERVAL_MS = 2_000;
const DEFAULT_DOCKER_INFO_TIMEOUT_MS = 30_000;
const DEFAULT_HOST_STATS_TIMEOUT_MS = 15_000;
const FLEET_DOCKER_INFO_TIMEOUT_MS = 4_000;
const FLEET_HOST_STATS_TIMEOUT_MS = 4_000;
export const FLEET_SNAPSHOT_CACHE_MS = 4_000;

type CpuSample = { idle: number; total: number };
type NetSample = { rxBytes: number; txBytes: number };

export type HostMetricRawSample = {
  stat: CpuSample | null;
  net: NetSample | null;
  at: number;
};

export type HostMetricSnapshotInput = {
  stat: string;
  meminfo: string;
  loadavg: string;
  uptime: string;
  netdev: string;
  df?: string;
  disks?: HostDisk[];
};

type DockerInfo = Record<string, unknown>;
type SpecsCacheEntry = { specs: HostSpecs; info: DockerInfo; at: number };
type HostMetricsSnapshotOptions = {
  mode?: "detail" | "fleet";
};
type HostMetricsTimeouts = {
  dockerInfoTimeoutMs: number;
  hostStatsTimeoutMs: number;
};
export type HostMetricsSnapshot = {
  specs: HostSpecs;
  stats: HostStats;
  degradedReason?: string;
};

const previousSamples = new Map<string, HostMetricRawSample>();
const specsCache = new Map<string, SpecsCacheEntry>();
const fleetSnapshotCache = new Map<string, { snapshot: HostMetricsSnapshot; at: number }>();
const fleetSnapshotInflight = new Map<string, Promise<HostMetricsSnapshot>>();

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function timeoutOptions(options: HostMetricsSnapshotOptions = {}): HostMetricsTimeouts {
  return options.mode === "fleet"
    ? { dockerInfoTimeoutMs: FLEET_DOCKER_INFO_TIMEOUT_MS, hostStatsTimeoutMs: FLEET_HOST_STATS_TIMEOUT_MS }
    : { dockerInfoTimeoutMs: DEFAULT_DOCKER_INFO_TIMEOUT_MS, hostStatsTimeoutMs: DEFAULT_HOST_STATS_TIMEOUT_MS };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function parseSnapshotSections(output: string): Partial<HostMetricSnapshotInput> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const marker = /^##([a-z]+)$/.exec(line.trim());
    if (marker) {
      current = marker[1] ?? null;
      if (current && !sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }

  return {
    stat: sections.get("stat")?.join("\n") ?? "",
    meminfo: sections.get("mem")?.join("\n") ?? "",
    loadavg: sections.get("load")?.join("\n") ?? "",
    uptime: sections.get("up")?.join("\n") ?? "",
    netdev: sections.get("net")?.join("\n") ?? "",
    df: sections.get("df")?.join("\n") ?? ""
  };
}

export function parseProcStatCpu(text: string): CpuSample | null {
  const line = text.split(/\r?\n/).find((item) => item.trim().startsWith("cpu "));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map((value) => Number(value));
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return null;
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

export function computeCpuPercent(current: CpuSample | null, previous: CpuSample | null) {
  if (!current || !previous) return null;
  const idleDelta = current.idle - previous.idle;
  const totalDelta = current.total - previous.total;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

export function parseMeminfo(text: string) {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB/i.exec(line.trim());
    if (!match) continue;
    values.set(match[1] ?? "", Number(match[2] ?? 0) * 1024);
  }
  const totalBytes = values.get("MemTotal") ?? 0;
  const availableBytes = values.get("MemAvailable") ?? ((values.get("MemFree") ?? 0) + (values.get("Buffers") ?? 0) + (values.get("Cached") ?? 0));
  const swapTotalBytes = values.get("SwapTotal") ?? 0;
  const swapFreeBytes = values.get("SwapFree") ?? 0;
  return {
    memory: {
      totalBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
      availableBytes
    },
    swap: {
      totalBytes: swapTotalBytes,
      usedBytes: Math.max(0, swapTotalBytes - swapFreeBytes)
    }
  };
}

export function parseLoadAverage(text: string) {
  const [one, five, fifteen] = text.trim().split(/\s+/).slice(0, 3).map((value) => Number(value));
  if (![one, five, fifteen].every((value) => Number.isFinite(value))) return null;
  return { one: one ?? 0, five: five ?? 0, fifteen: fifteen ?? 0 };
}

export function parseUptimeSeconds(text: string) {
  const first = Number(text.trim().split(/\s+/)[0] ?? 0);
  return Number.isFinite(first) ? Math.floor(first) : 0;
}

export function parseNetworkDev(text: string): NetSample | null {
  let rxBytes = 0;
  let txBytes = 0;
  let seen = false;
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || iface === "lo") continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map((value) => Number(value));
    const rx = fields[0];
    const tx = fields[8];
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    rxBytes += rx ?? 0;
    txBytes += tx ?? 0;
    seen = true;
  }
  return seen ? { rxBytes, txBytes } : null;
}

const pseudoDiskFilesystems = new Set(["tmpfs", "devtmpfs", "overlay", "squashfs"]);

export function parseDfDisks(text: string): HostDisk[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const cols = line.split(/\s+/);
      const filesystem = cols[0] ?? "";
      const totalBytes = Number(cols[1] ?? 0);
      const usedBytes = Number(cols[2] ?? 0);
      const usedPercent = Number(String(cols[4] ?? "").replace("%", ""));
      const mount = cols[5] ?? "";
      if (!mount.startsWith("/") || pseudoDiskFilesystems.has(filesystem)) return [];
      if ([totalBytes, usedBytes, usedPercent].some((value) => !Number.isFinite(value)) || totalBytes <= 0) return [];
      return [{ mount, totalBytes, usedBytes, usedPercent }];
    });
}

function computeNetworkRate(current: NetSample | null, previous: NetSample | null, seconds: number) {
  if (!current || !previous || seconds <= 0) return null;
  return {
    rxBytesPerSec: Math.max(0, Math.round((current.rxBytes - previous.rxBytes) / seconds)),
    txBytesPerSec: Math.max(0, Math.round((current.txBytes - previous.txBytes) / seconds))
  };
}

export function parseHostStatsSnapshot(
  hostId: string,
  input: HostMetricSnapshotInput,
  previous: HostMetricRawSample | null = null,
  now = Date.now(),
  containers: HostStats["containers"] = null
) {
  const stat = parseProcStatCpu(input.stat);
  const net = parseNetworkDev(input.netdev);
  const seconds = previous ? (now - previous.at) / 1000 : 0;
  const { memory, swap } = parseMeminfo(input.meminfo);
  const stats: HostStats = {
    hostId,
    collectedAt: new Date(now).toISOString(),
    cpuPercent: computeCpuPercent(stat, previous?.stat ?? null),
    load: parseLoadAverage(input.loadavg),
    memory,
    swap,
    disks: input.disks ?? parseDfDisks(input.df ?? ""),
    network: computeNetworkRate(net, previous?.net ?? null, seconds),
    containers,
    uptimeSeconds: parseUptimeSeconds(input.uptime)
  };
  return { stats, raw: { stat, net, at: now } satisfies HostMetricRawSample };
}

async function getContainerCounts(hostId: string, info?: DockerInfo): Promise<HostStats["containers"]> {
  const result = await query<{ total: string; running: string }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE lower(coalesce(data->>'State', '')) = 'running')::text AS running
     FROM resource_snapshots
     WHERE host_id = $1 AND kind = 'container'`,
    [hostId]
  );
  const row = result.rows[0];
  const total = Number(row?.total ?? 0);
  const running = Number(row?.running ?? 0);
  if (total > 0 || !info) return { total, running };
  return {
    total: numberValue(info.Containers, 0),
    running: numberValue(info.ContainersRunning, 0)
  };
}

async function collectDockerSpecs(hostId: string, host: { public: DockerHost }, timeouts: HostMetricsTimeouts = timeoutOptions()) {
  const now = Date.now();
  const cached = specsCache.get(hostId);
  if (cached && now - cached.at < SPECS_CACHE_MS) return cached;

  if (isDemoHost(host.public)) {
    const info: DockerInfo = { Containers: 4, ContainersRunning: 3 };
    const entry: SpecsCacheEntry = {
      info,
      at: now,
      specs: {
        hostId,
        cpuCores: 4,
        cpuModel: "Demo CPU",
        memTotalBytes: 16 * 1024 * 1024 * 1024,
        os: "Demo Linux",
        kernel: "demo",
        arch: "x86_64",
        dockerVersion: host.public.dockerVersion ?? "29.4.0-demo",
        composeVersion: host.public.composeVersion ?? "5.1.1-demo",
        collectedAt: new Date(now).toISOString()
      }
    };
    specsCache.set(hostId, entry);
    return entry;
  }

  const [infoResult, composeResult] = await Promise.all([
    runDocker(hostId, "docker info --format '{{json .}}'", timeouts.dockerInfoTimeoutMs),
    runDocker(hostId, "docker compose version --short", timeouts.dockerInfoTimeoutMs).catch(() => null)
  ]);
  const info = JSON.parse(infoResult.stdout.trim()) as DockerInfo;
  const composeVersion = composeResult?.stdout.trim() || host.public.composeVersion || undefined;
  const entry: SpecsCacheEntry = {
    info,
    at: now,
    specs: {
      hostId,
      cpuCores: numberValue(info.NCPU, 0),
      memTotalBytes: numberValue(info.MemTotal, 0),
      os: stringValue(info.OperatingSystem, "Unknown Linux"),
      kernel: stringValue(info.KernelVersion) || undefined,
      arch: stringValue(info.Architecture, "unknown"),
      dockerVersion: stringValue(info.ServerVersion, host.public.dockerVersion ?? "unknown"),
      composeVersion,
      collectedAt: new Date(now).toISOString()
    }
  };
  specsCache.set(hostId, entry);
  return entry;
}

export async function getHostSpecs(hostId: string) {
  const host = await getHostForWorker(hostId);
  return (await collectDockerSpecs(hostId, host)).specs;
}

function fallbackStats(hostId: string, specs: HostSpecs, containers: HostStats["containers"]): HostStats {
  return {
    hostId,
    collectedAt: new Date().toISOString(),
    cpuPercent: null,
    load: null,
    memory: {
      totalBytes: specs.memTotalBytes,
      usedBytes: 0,
      availableBytes: specs.memTotalBytes
    },
    swap: {
      totalBytes: 0,
      usedBytes: 0
    },
    disks: [],
    network: null,
    containers,
    uptimeSeconds: 0
  };
}

function demoStats(hostId: string, containers: HostStats["containers"]): HostStats {
  const now = Date.now();
  const wave = (Math.sin(now / 3500) + 1) / 2;
  const memTotalBytes = 16 * 1024 * 1024 * 1024;
  const memUsedBytes = Math.round(memTotalBytes * (0.35 + wave * 0.18));
  return {
    hostId,
    collectedAt: new Date(now).toISOString(),
    cpuPercent: Math.round(18 + wave * 42),
    load: { one: 0.62 + wave, five: 0.48 + wave / 2, fifteen: 0.38 + wave / 3 },
    memory: {
      totalBytes: memTotalBytes,
      usedBytes: memUsedBytes,
      availableBytes: memTotalBytes - memUsedBytes
    },
    swap: {
      totalBytes: 2 * 1024 * 1024 * 1024,
      usedBytes: Math.round(128 * 1024 * 1024 * wave)
    },
    disks: [
      { mount: "/", totalBytes: 240 * 1024 * 1024 * 1024, usedBytes: Math.round(91 * 1024 * 1024 * 1024 + wave * 9 * 1024 * 1024 * 1024), usedPercent: Math.round(38 + wave * 4) }
    ],
    network: {
      rxBytesPerSec: Math.round(80_000 + wave * 220_000),
      txBytesPerSec: Math.round(28_000 + wave * 120_000)
    },
    containers,
    uptimeSeconds: Math.round(12 * 24 * 60 * 60 + now / 1000)
  };
}

async function collectHostStats(
  hostId: string,
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  specsEntry: SpecsCacheEntry,
  timeouts: HostMetricsTimeouts
): Promise<{ stats: HostStats; degradedReason?: string }> {
  const containers = await getContainerCounts(hostId, specsEntry.info);

  if (isDemoHost(host.public)) return { stats: demoStats(hostId, containers) };

  if (host.connectionMode === "agent") {
    if (!host.agent) {
      return {
        stats: fallbackStats(hostId, specsEntry.specs, containers),
        degradedReason: "Agent connection details are missing."
      };
    }
    try {
      const agentStats = await getAgentHostStats(host.agent, timeouts.hostStatsTimeoutMs);
      const parsed = parseHostStatsSnapshot(
        hostId,
        {
          stat: agentStats.stat,
          meminfo: agentStats.meminfo,
          loadavg: agentStats.loadavg,
          uptime: agentStats.uptime,
          netdev: agentStats.netdev,
          disks: agentStats.disks
        },
        previousSamples.get(hostId) ?? null,
        Date.now(),
        containers
      );
      previousSamples.set(hostId, parsed.raw);
      return { stats: parsed.stats };
    } catch (error) {
      return {
        stats: fallbackStats(hostId, specsEntry.specs, containers),
        degradedReason: `Agent host stats unavailable: ${errorMessage(error)}`
      };
    }
  }

  const result = await runSshCommand(host.ssh, HOST_STATS_SNAPSHOT_COMMAND, { timeoutMs: timeouts.hostStatsTimeoutMs });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Host metrics snapshot failed");
  const sections = parseSnapshotSections(result.stdout);
  const parsed = parseHostStatsSnapshot(
    hostId,
    {
      stat: sections.stat ?? "",
      meminfo: sections.meminfo ?? "",
      loadavg: sections.loadavg ?? "",
      uptime: sections.uptime ?? "",
      netdev: sections.netdev ?? "",
      df: sections.df ?? ""
    },
    previousSamples.get(hostId) ?? null,
    Date.now(),
    containers
  );
  previousSamples.set(hostId, parsed.raw);
  return { stats: parsed.stats };
}

export async function getHostStats(hostId: string) {
  return (await getHostMetricsSnapshot(hostId)).stats;
}

export async function getHostMetricsSnapshot(hostId: string, options: HostMetricsSnapshotOptions = {}): Promise<HostMetricsSnapshot> {
  const host = await getHostForWorker(hostId);
  const timeouts = timeoutOptions(options);
  const specsEntry = await collectDockerSpecs(hostId, host, timeouts);
  const result = await collectHostStats(hostId, host, specsEntry, timeouts);
  return {
    specs: specsEntry.specs,
    stats: result.stats,
    ...(result.degradedReason ? { degradedReason: result.degradedReason } : {})
  };
}

export async function getFleetHostSnapshot(hostId: string): Promise<HostMetricsSnapshot> {
  const now = Date.now();
  const cached = fleetSnapshotCache.get(hostId);
  if (cached && now - cached.at < FLEET_SNAPSHOT_CACHE_MS) return cached.snapshot;
  const inflight = fleetSnapshotInflight.get(hostId);
  if (inflight) return inflight;
  const promise = getHostMetricsSnapshot(hostId, { mode: "fleet" })
    .then((snapshot) => {
      fleetSnapshotCache.set(hostId, { snapshot, at: Date.now() });
      return snapshot;
    })
    .finally(() => {
      fleetSnapshotInflight.delete(hostId);
    });
  fleetSnapshotInflight.set(hostId, promise);
  return promise;
}

export async function streamHostStats(hostId: string, onStats: (stats: HostStats) => void, onError: (error: Error) => void) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      onStats(await getHostStats(hostId));
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), STREAM_INTERVAL_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
