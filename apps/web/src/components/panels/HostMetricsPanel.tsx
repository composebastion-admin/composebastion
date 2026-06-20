import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, Database, HardDrive, MemoryStick, Network, Server, Timer } from "lucide-react";
import type { DockerHost, HostSpecs, HostStats } from "@composebastion/shared";
import { api } from "../../api.js";
import { useHostMetricHistory } from "../../hooks/useHostMetricHistory.js";
import { useHostStatsStream } from "../../hooks/useHostStatsStream.js";
import { formatBytes, formatDate } from "../../lib/format.js";
import { ButtonRow, DataTable, EmptyState, Panel, StatusPill } from "../ui/primitives.js";

function percent(used: number, total: number) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatRate(value: number) {
  return `${formatBytes(value)}/s`;
}

function Spark({ values }: { values: number[] }) {
  const width = 120;
  const height = 28;
  const series = values.length ? values : [0];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const spread = Math.max(max - min, 1);
  const points = series.map((value, index) => {
    const x = (index / Math.max(series.length - 1, 1)) * width;
    const y = height - ((value - min) / spread) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg className="hostMetricSpark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function GaugeTile({ icon: Icon, label, value, detail, percentValue, series, tone = "info" }: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail?: string;
  percentValue?: number | null;
  series?: number[];
  tone?: "ok" | "warning" | "danger" | "info";
}) {
  return (
    <div className={`hostMetricTile ${tone}`}>
      <div className="hostMetricTileTop">
        <span className="hostMetricIcon"><Icon size={16} /></span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
      {typeof percentValue === "number" && (
        <div className="thinMeter" aria-label={`${label} ${percentValue}%`}>
          <span style={{ width: `${Math.max(2, Math.min(100, percentValue))}%` }} />
        </div>
      )}
      {series && <Spark values={series} />}
    </div>
  );
}

function toneFor(value: number | null | undefined, warning: number, danger: number) {
  if (value === null || value === undefined) return "info" as const;
  if (value >= danger) return "danger" as const;
  if (value >= warning) return "warning" as const;
  return "ok" as const;
}

type FleetMetricRow = {
  id: string;
  hostId: string;
  name: string;
  online: boolean;
  specs?: HostSpecs;
  stats?: HostStats;
  degradedReason?: string;
  error?: string;
};

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function FleetMetricsPanel({ hosts, scopeHosts }: { hosts: DockerHost[]; scopeHosts: DockerHost[] }) {
  const [rows, setRows] = useState<FleetMetricRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scopeIds = useMemo(() => new Set(scopeHosts.map((host) => host.id)), [scopeHosts]);

  useEffect(() => {
    if (hosts.length === 0) {
      setRows([]);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const result = await api<Array<Omit<FleetMetricRow, "id">>>("/api/hosts/metrics");
        if (!cancelled) {
          setRows(result.map((row) => ({ ...row, id: row.hostId })));
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hosts.length]);

  const scopedRows = useMemo<FleetMetricRow[]>(() => {
    const filtered = rows.filter((row) => scopeIds.has(row.hostId));
    if (filtered.length > 0) return filtered;
    return scopeHosts.map((host) => ({ id: host.id, hostId: host.id, name: host.name, online: host.lastStatus === "online" }));
  }, [rows, scopeHosts, scopeIds]);
  const reportingRows = scopedRows.filter((row) => row.online && row.stats);
  const cpuAverage = average(reportingRows.flatMap((row) => typeof row.stats?.cpuPercent === "number" ? [row.stats.cpuPercent] : []));
  const memoryAverage = average(reportingRows.map((row) => percent(row.stats!.memory.usedBytes, row.stats!.memory.totalBytes)));
  const diskMax = reportingRows.flatMap((row) => row.stats?.disks.map((disk) => disk.usedPercent) ?? []).reduce<number | null>((max, value) => max === null ? value : Math.max(max, value), null);
  const runningContainers = reportingRows.reduce((sum, row) => sum + (row.stats?.containers?.running ?? 0), 0);
  const totalContainers = reportingRows.reduce((sum, row) => sum + (row.stats?.containers?.total ?? 0), 0);
  const title = scopeHosts.length === hosts.length ? "Fleet metrics" : `${scopeHosts.length} selected host metrics`;

  return (
    <Panel title={title}>
      <div className="hostMetricsHeader">
        <div>
          <div className="hostMetricsTitle">
            <Server size={18} />
            <strong>{reportingRows.length}/{scopedRows.length} reporting</strong>
          </div>
          <div className="hostSpecsLine">
            <span>{scopeHosts.length} host{scopeHosts.length === 1 ? "" : "s"} in scope</span>
            <span>{scopedRows.filter((row) => row.online).length} online</span>
          </div>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      <div className="hostMetricGrid">
        <GaugeTile icon={Cpu} label="CPU avg" value={cpuAverage === null ? "n/a" : `${cpuAverage}%`} percentValue={cpuAverage} tone={toneFor(cpuAverage, 65, 85)} />
        <GaugeTile icon={MemoryStick} label="Memory avg" value={memoryAverage === null ? "n/a" : `${memoryAverage}%`} percentValue={memoryAverage} tone={toneFor(memoryAverage, 70, 88)} />
        <GaugeTile icon={HardDrive} label="Disk max" value={diskMax === null ? "n/a" : `${diskMax}%`} percentValue={diskMax} tone={toneFor(diskMax, 75, 90)} />
        <GaugeTile icon={Database} label="Containers" value={`${runningContainers}/${totalContainers}`} detail="running / total" percentValue={totalContainers > 0 ? percent(runningContainers, totalContainers) : null} />
      </div>
      <DataTable
        rows={scopedRows}
        compact
        columns={["Host", "CPU", "Memory", "Disk", "Containers", "Network"]}
        render={(row) => {
          const memoryPercent = row.stats ? percent(row.stats.memory.usedBytes, row.stats.memory.totalBytes) : null;
          const diskPercent = row.stats?.disks.length ? Math.max(...row.stats.disks.map((disk) => disk.usedPercent)) : null;
          return [
            <span key="host" className="hostMetricTableHost">
              <StatusPill status={row.online ? "online" : "offline"} />
              <strong>{row.name}</strong>
              {row.degradedReason && <small>Degraded: {row.degradedReason}</small>}
              {!row.online && row.error && <small>{row.error}</small>}
            </span>,
            row.stats?.cpuPercent === null || row.stats?.cpuPercent === undefined ? "n/a" : `${row.stats.cpuPercent}%`,
            memoryPercent === null ? "n/a" : `${memoryPercent}%`,
            diskPercent === null ? "n/a" : `${diskPercent}%`,
            row.stats?.containers ? `${row.stats.containers.running}/${row.stats.containers.total}` : "n/a",
            row.stats?.network ? `${formatRate(row.stats.network.rxBytesPerSec)} in, ${formatRate(row.stats.network.txBytesPerSec)} out` : "n/a"
          ];
        }}
      />
    </Panel>
  );
}

export function HostMetricsPanel({ host }: { host: DockerHost }) {
  const [specs, setSpecs] = useState<HostSpecs | null>(null);
  const [snapshotStats, setSnapshotStats] = useState<HostStats | null>(null);
  const [degradedReason, setDegradedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stream = useHostStatsStream(host.id);
  const stats = stream.stats ?? snapshotStats;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDegradedReason(null);
    setSnapshotStats(null);
    setSpecs(null);
    void api<{ specs: HostSpecs; stats: HostStats; degradedReason?: string }>(`/api/hosts/${host.id}/metrics`)
      .then((result) => {
        if (cancelled) return;
        setSpecs(result.specs);
        setSnapshotStats(result.stats);
        setDegradedReason(result.degradedReason ?? null);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [host.id]);

  const memoryPercent = stats ? percent(stats.memory.usedBytes, stats.memory.totalBytes) : 0;
  const diskPercent = stats?.disks.length ? Math.max(...stats.disks.map((disk) => disk.usedPercent)) : 0;
  const values = useMemo(() => ({
    cpu: stats?.cpuPercent ?? null,
    memory: memoryPercent,
    disk: diskPercent,
    rx: stats?.network?.rxBytesPerSec ?? null,
    tx: stats?.network?.txBytesPerSec ?? null
  }), [stats?.cpuPercent, stats?.network?.rxBytesPerSec, stats?.network?.txBytesPerSec, memoryPercent, diskPercent]);
  const history = useHostMetricHistory(host.id, values);
  const series = (metric: string) => history[`${host.id}:${metric}`]?.map((sample) => sample.value) ?? [];

  if (error && !stats) {
    return (
      <Panel title={`${host.name} metrics`}>
        <EmptyState headline="Metrics unavailable" hint={error} />
      </Panel>
    );
  }

  return (
    <Panel title={`${host.name} metrics`}>
      <div className="hostMetricsHeader">
        <div>
          <div className="hostMetricsTitle">
            <Server size={18} />
            <strong>{specs?.os ?? host.hostname}</strong>
            <StatusPill status={host.lastStatus} />
          </div>
          <div className="hostSpecsLine">
            <span>{specs ? `${specs.cpuCores} cores` : "CPU pending"}</span>
            <span>{specs ? formatBytes(specs.memTotalBytes) : "Memory pending"}</span>
            <span>{specs?.arch ?? "arch pending"}</span>
            <span>{specs?.dockerVersion ? `Docker ${specs.dockerVersion}` : host.dockerVersion ? `Docker ${host.dockerVersion}` : "Docker pending"}</span>
            {specs?.composeVersion && <span>Compose {specs.composeVersion}</span>}
          </div>
        </div>
        <ButtonRow>
          <span className={`streamState ${stream.state}`}>{stream.state}</span>
          {stats?.collectedAt && <span className="hostCollectedAt">{formatDate(stats.collectedAt)}</span>}
        </ButtonRow>
      </div>

      {stream.error && <div className="notice error">{stream.error}</div>}
      {error && <div className="notice error">{error}</div>}
      {degradedReason && <div className="notice warning">Degraded: {degradedReason}</div>}

      {stats ? (
        <>
          <div className="hostMetricGrid">
            <GaugeTile
              icon={Cpu}
              label="CPU"
              value={stats.cpuPercent === null ? "Pending" : `${stats.cpuPercent}%`}
              detail={stats.load ? `Load ${stats.load.one.toFixed(2)} / ${stats.load.five.toFixed(2)} / ${stats.load.fifteen.toFixed(2)}` : "Load pending"}
              percentValue={stats.cpuPercent}
              series={series("cpu")}
              tone={toneFor(stats.cpuPercent, 65, 85)}
            />
            <GaugeTile
              icon={MemoryStick}
              label="Memory"
              value={`${memoryPercent}%`}
              detail={`${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)}`}
              percentValue={memoryPercent}
              series={series("memory")}
              tone={toneFor(memoryPercent, 70, 88)}
            />
            <GaugeTile
              icon={HardDrive}
              label="Disk"
              value={stats.disks.length ? `${diskPercent}%` : "Pending"}
              detail={stats.disks.length ? `${stats.disks.length} mount${stats.disks.length === 1 ? "" : "s"}` : "No disk sample"}
              percentValue={stats.disks.length ? diskPercent : null}
              series={series("disk")}
              tone={toneFor(diskPercent, 75, 90)}
            />
            <GaugeTile
              icon={Network}
              label="Network"
              value={stats.network ? `${formatRate(stats.network.rxBytesPerSec)} in` : "Pending"}
              detail={stats.network ? `${formatRate(stats.network.txBytesPerSec)} out` : "Rate needs two samples"}
              series={series("rx")}
            />
            <GaugeTile
              icon={Database}
              label="Containers"
              value={stats.containers ? `${stats.containers.running}/${stats.containers.total}` : "Pending"}
              detail="running / total"
              percentValue={stats.containers ? percent(stats.containers.running, Math.max(stats.containers.total, 1)) : null}
              tone={stats.containers && stats.containers.total > 0 && stats.containers.running === 0 ? "warning" : "ok"}
            />
            <GaugeTile
              icon={Timer}
              label="Uptime"
              value={formatDuration(stats.uptimeSeconds)}
              detail={specs?.kernel ? `Kernel ${specs.kernel}` : undefined}
            />
          </div>

          <div className="hostDiskList">
            {stats.disks.map((disk) => (
              <div className="hostDiskRow" key={disk.mount}>
                <div>
                  <strong>{disk.mount}</strong>
                  <span>{formatBytes(disk.usedBytes)} of {formatBytes(disk.totalBytes)}</span>
                </div>
                <div className="thinMeter">
                  <span style={{ width: `${Math.max(2, Math.min(100, disk.usedPercent))}%` }} />
                </div>
                <small>{disk.usedPercent}%</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <EmptyState headline="Collecting metrics" hint="Waiting for the first host sample." />
      )}
    </Panel>
  );
}
