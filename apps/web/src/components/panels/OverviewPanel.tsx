import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Box, Layers, Server } from "lucide-react";
import type { ComponentType } from "react";
import type { Backup, DockerApp, DockerHost, HostSpecs, HostStats, OperationJob, ResourceSnapshot } from "@dockermender/shared";
import { containerData, containerStateLabel, publishedWebLinks } from "@dockermender/shared";
import { api } from "../../api.js";
import { formatBytes, formatDate } from "../../lib/format.js";
import { metricDelta, metricSeries } from "../../lib/dockerMetrics.js";
import type { MetricTone } from "../../lib/dashboardTypes.js";
import { useOverviewMetricHistory } from "../../hooks/useOverviewMetricHistory.js";
import { DataTable, Panel, StatusPill } from "../ui/primitives.js";

function sourceLabel(source: DockerApp["source"]) {
  if (source === "git") return "Git";
  if (source === "compose") return "Compose";
  if (source === "image") return "Image";
  return "Unknown";
}

function compactPorts(hostname: string, ports: string): ReactNode {
  const links = publishedWebLinks(hostname, ports);
  if (!ports.trim()) return <span className="overviewPortNull">No ports</span>;
  if (!links || links.length === 0) return <span className="overviewPortSummary">{ports}</span>;
  const [primary, ...extra] = links;
  if (!primary) return <span className="overviewPortSummary">{ports}</span>;
  return (
    <span className="overviewPortsCell">
      <a className="overviewPortLink" href={primary.url} target="_blank" rel="noreferrer">{primary.port}</a>
      {extra.length > 0 && <span className="overviewPortsOverflow">+{extra.length}</span>}
    </span>
  );
}

function compactText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function updateLabel(app: DockerApp) {
  if (app.update.status === "update_available") return "Available";
  if (app.update.status === "error") return "Check failed";
  if (app.update.status === "up_to_date") return "Up to date";
  if (app.update.status === "local") return "Local image";
  return "Unknown";
}

function updateDetail(app: DockerApp) {
  if (app.update.kind === "git") {
    const current = app.update.currentVersion ? compactText(app.update.currentVersion, 11) : "";
    const next = app.update.availableVersion ? compactText(app.update.availableVersion, 11) : "";
    if (current && next) return `${current} → ${next}`;
    return app.update.riskNote ?? "Git check pending";
  }
  if (app.update.kind === "image") {
    const current = app.update.currentDigest ? compactText(app.update.currentDigest, 11) : "";
    const next = app.update.remoteDigest ? compactText(app.update.remoteDigest, 11) : "";
    if (current && next) return `${current} → ${next}`;
    return app.update.imageReference ?? app.update.riskNote ?? "";
  }
  return app.update.riskNote ?? "";
}

function serviceNeedsAttention(app: DockerApp) {
  return app.update.status === "update_available" || (app.status !== "running" && app.status !== "deployed");
}

function versionValue(app: DockerApp, type: "current" | "latest") {
  if (app.update.kind === "git") {
    const value = type === "current" ? app.update.currentVersion : app.update.availableVersion;
    return compactText(value ?? "", 12) || "Unknown";
  }
  if (app.update.kind === "image") {
    const value = type === "current" ? app.update.currentDigest : app.update.remoteDigest;
    return compactText(value ?? "", 12) || compactText(app.update.imageReference ?? "", 22) || "Unknown";
  }
  return type === "current" ? compactText(app.imageReferences[0] ?? "", 22) || "Unknown" : "Unknown";
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

function metricPercent(used: number, total: number) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function MiniMeter({ value, tone = "ok" }: { value: number | null | undefined; tone?: "ok" | "warning" | "danger" | "offline" }) {
  const width = typeof value === "number" ? Math.max(2, Math.min(100, value)) : 0;
  return (
    <span className={`miniMeter ${tone}`} title={typeof value === "number" ? `${value}%` : "No sample"}>
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

function toneForPercent(value: number | null | undefined, warning: number, danger: number) {
  if (value === null || value === undefined) return "offline" as const;
  if (value >= danger) return "danger" as const;
  if (value >= warning) return "warning" as const;
  return "ok" as const;
}

type OverviewMetric = {
  key: "hostsOnline" | "runningContainers" | "updates" | "alerts";
  label: string;
  value: string;
  icon: typeof Server;
  tone: MetricTone;
  deltaGood: "up" | "down";
  tooltip: string;
};

export function OverviewPanel({ host, hosts, apps, resources, backups, jobs, scopeHosts }: {
  host: DockerHost;
  hosts: DockerHost[];
  apps: DockerApp[];
  resources: ResourceSnapshot[];
  backups: Backup[];
  jobs: OperationJob[];
  scopeHosts: DockerHost[];
}) {
  const hostById = useMemo(() => new Map(hosts.map((entry) => [entry.id, entry])), [hosts]);
  const scopeHostIds = useMemo(() => new Set(scopeHosts.map((entry) => entry.id)), [scopeHosts]);
  const onlineScopedHosts = scopeHosts.filter((entry) => entry.lastStatus === "online").length;
  const healthHostCount = scopeHostIds.size > 0 ? scopeHosts.length : hosts.length;
  const healthOnlineCount = scopeHostIds.size > 0 ? onlineScopedHosts : hosts.filter((entry) => entry.lastStatus === "online").length;

  const counts = {
    containers: resources.filter((resource) => resource.kind === "container").length,
    running: resources.filter((resource) => resource.kind === "container" && containerStateLabel(String(containerData(resource).State ?? "")) === "running").length,
    images: resources.filter((resource) => resource.kind === "image").length,
    volumes: resources.filter((resource) => resource.kind === "volume").length,
    networks: resources.filter((resource) => resource.kind === "network").length
  };

  const alerts = {
    queuedOrRunning: jobs.filter((job) => job.status === "queued" || job.status === "running").length,
    failed: jobs.filter((job) => job.status === "failed").length
  };
  const updatesAvailable = apps.filter((app) => app.update.status === "update_available").length;
  const scopedBackups = backups.filter((backup) => scopeHostIds.has(backup.hostId));
  const failedBackups = scopedBackups.filter((backup) => backup.status === "failed").length;

  const servicesNeedingAttention = useMemo(() => apps.filter(serviceNeedsAttention).slice(0, 8), [apps]);
  const containersNeedingAttention = useMemo(
    () => resources
      .filter((resource) => resource.kind === "container")
      .filter((resource) => containerStateLabel(String(containerData(resource).State ?? "")) !== "running")
      .slice(0, 8),
    [resources]
  );
  const recentJobs = jobs.slice(0, 8);
  const [fleetMetrics, setFleetMetrics] = useState<FleetMetricRow[]>([]);

  useEffect(() => {
    if (hosts.length === 0) {
      setFleetMetrics([]);
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await api<Array<Omit<FleetMetricRow, "id">>>("/api/hosts/metrics");
        if (!cancelled) setFleetMetrics(rows.map((row) => ({ ...row, id: row.hostId })));
      } catch {
        if (!cancelled) setFleetMetrics([]);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hosts.length]);

  const scopedFleetMetrics = useMemo<FleetMetricRow[]>(() => {
    const rows = fleetMetrics.filter((row) => scopeHostIds.has(row.hostId));
    if (rows.length > 0) return rows;
    return scopeHosts.map((item) => ({ id: item.id, hostId: item.id, name: item.name, online: item.lastStatus === "online" }));
  }, [fleetMetrics, scopeHostIds, scopeHosts]);

  const metricValues = useMemo(() => ({
    hostsOnline: Math.max(healthHostCount, 1),
    runningContainers: counts.running,
    updates: updatesAvailable,
    alerts: alerts.failed + alerts.queuedOrRunning
  }), [healthHostCount, counts.running, updatesAvailable, alerts.failed, alerts.queuedOrRunning]);
  const history = useOverviewMetricHistory(metricValues);
  const metrics: OverviewMetric[] = [
    {
      key: "hostsOnline",
      label: "Hosts",
      value: `${healthOnlineCount}/${healthHostCount}`,
      icon: Server,
      tone: healthHostCount === 0 || healthOnlineCount === 0 ? "danger" : healthOnlineCount === healthHostCount ? "ok" : "warning",
      deltaGood: "up" as const,
      tooltip: `${healthHostCount} hosts in scope`
    },
    {
      key: "runningContainers",
      label: "Containers",
      value: `${counts.running}/${counts.containers}`,
      icon: Box,
      tone: counts.containers === 0 ? "warning" : counts.running === counts.containers ? "ok" : counts.running === 0 ? "danger" : "warning",
      deltaGood: "up" as const,
      tooltip: `${counts.containers} total containers`
    },
    {
      key: "updates",
      label: "Updates",
      value: String(updatesAvailable),
      icon: Layers,
      tone: updatesAvailable > 0 ? "warning" : "ok",
      deltaGood: "down" as const,
      tooltip: `${updatesAvailable} services waiting on update`
    },
    {
      key: "alerts",
      label: "Failed jobs",
      value: String(alerts.failed),
      icon: AlertCircle,
      tone: alerts.failed > 0 ? "danger" : alerts.queuedOrRunning > 0 ? "warning" : "ok",
      deltaGood: "down" as const,
      tooltip: `${alerts.failed} failed jobs, ${alerts.queuedOrRunning} active`
    }
  ];

  const resourceCards = [
    { label: "Images", value: String(counts.images), hint: "tracked" },
    { label: "Volumes", value: String(counts.volumes), hint: "volumes" },
    { label: "Networks", value: String(counts.networks), hint: "networks" },
    { label: "Backups", value: String(scopedBackups.length), hint: `${failedBackups} failed` }
  ];

  return (
    <Panel title={`Dashboard: ${healthHostCount > 1 ? "Fleet" : host.name}`}>
      <div className="overviewHealthStrip">
        {metrics.map((metric) => (
          <SummaryCard
            key={metric.key}
            label={metric.label}
            value={metric.value}
            tone={metric.tone}
            icon={metric.icon}
            series={metricSeries(history, metric.key, metricValues[metric.key as keyof typeof metricValues])}
            delta={metricDelta(history, metric.key, metricValues[metric.key as keyof typeof metricValues])}
            deltaGood={metric.deltaGood}
            compact
            title={metric.tooltip}
          />
        ))}
      </div>

      <section className="overviewPanelCard fleetMetricsCard">
        <div className="overviewSectionHeader">
          <h3>Fleet metrics</h3>
          <p>{scopedFleetMetrics.filter((row) => row.online).length}/{scopedFleetMetrics.length} reporting</p>
        </div>
        <DataTable
          rows={scopedFleetMetrics}
          compact
          tableClassName="fleetMetricsTable"
          columns={["Host", "CPU", "Memory", "Disk", "Containers", "Network"]}
          render={(row) => {
            const memoryPercent = row.stats ? metricPercent(row.stats.memory.usedBytes, row.stats.memory.totalBytes) : null;
            const diskPercent = row.stats?.disks.length ? Math.max(...row.stats.disks.map((disk) => disk.usedPercent)) : null;
            const cpuPercent = row.stats?.cpuPercent ?? null;
            return [
              <span key="host" className={`fleetHostCell ${row.online ? "" : "offline"}`}>
                <span className={`hostHealthDot ${row.online ? "online" : "offline"}`} />
                <span>{row.name}</span>
                {row.degradedReason && <small className="degraded">Degraded: {row.degradedReason}</small>}
                {!row.online && row.error && <small>{row.error}</small>}
              </span>,
              <span key="cpu" className="fleetMetricCell">
                <MiniMeter value={cpuPercent} tone={toneForPercent(cpuPercent, 65, 85)} />
                <small>{cpuPercent === null ? "n/a" : `${cpuPercent}%`}</small>
              </span>,
              <span key="memory" className="fleetMetricCell">
                <MiniMeter value={memoryPercent} tone={toneForPercent(memoryPercent, 70, 88)} />
                <small>{memoryPercent === null ? "n/a" : `${memoryPercent}%`}</small>
              </span>,
              <span key="disk" className="fleetMetricCell">
                <MiniMeter value={diskPercent} tone={toneForPercent(diskPercent, 75, 90)} />
                <small>{diskPercent === null ? "n/a" : `${diskPercent}%`}</small>
              </span>,
              <span key="containers">{row.stats?.containers ? `${row.stats.containers.running}/${row.stats.containers.total}` : "n/a"}</span>,
              <span key="network" className="fleetNetworkCell">
                {row.stats?.network ? `${formatBytes(row.stats.network.rxBytesPerSec)}/s in, ${formatBytes(row.stats.network.txBytesPerSec)}/s out` : "n/a"}
              </span>
            ];
          }}
        />
      </section>

      <div className="overviewMainGrid">
        <section className="overviewPanelCard">
          <div className="overviewSectionHeader">
            <h3>Services needing attention</h3>
            <p>{servicesNeedingAttention.length ? `${servicesNeedingAttention.length} need action` : "All services are healthy"}</p>
          </div>
          {servicesNeedingAttention.length === 0 ? (
            <div className="overviewEmpty">
              <span>No service updates or unhealthy states are waiting right now.</span>
            </div>
          ) : (
            <DataTable
              rows={servicesNeedingAttention}
              compact
              tableClassName="overviewServicesTable"
              columns={[
                "Service",
                "Source",
                "Status",
                "Current",
                "Latest",
                "Update",
                "Ports"
              ]}
              render={(app) => {
                const compactedPorts = compactPorts(app.hostHostname, app.ports);
                return [
                  <div key="app" className="appNameCell">
                    <span className="appNameLine">{app.name}</span>
                    <span className="appHostLine">{app.hostName}</span>
                  </div>,
                  <span key="source" className={`appSourcePill ${app.source}`}>{sourceLabel(app.source)}</span>,
                  <StatusPill key="status" status={app.status} />,
                  <code key="current" className="monoText">{versionValue(app, "current")}</code>,
                  <code key="latest" className="monoText">{versionValue(app, "latest")}</code>,
                  <span key="update" className={`updateCell ${app.update.status}`}>
                    <strong>{updateLabel(app)}</strong>
                    {updateDetail(app) && <small>{updateDetail(app)}</small>}
                  </span>,
                  <span key="ports">{compactedPorts}</span>
                ];
              }}
            />
          )}
        </section>

        <section className="overviewPanelCard">
          <div className="overviewSectionHeader">
            <h3>Containers needing attention</h3>
            <p>{containersNeedingAttention.length ? `${containersNeedingAttention.length} non-running` : "All containers are running"}</p>
          </div>
          {containersNeedingAttention.length === 0 ? (
            <div className="overviewEmpty">
              <span>No containers are in a stopped or unknown state.</span>
            </div>
          ) : (
            <DataTable
              rows={containersNeedingAttention}
              compact
              tableClassName="overviewContainersTable"
              columns={[
                "Container",
                "Host",
                "State",
                "Ports"
              ]}
              render={(resource) => {
                const state = containerStateLabel(String(containerData(resource).State ?? ""));
                const rowHost = hostById.get(resource.hostId);
                const portsCell = compactPorts(rowHost?.hostname ?? "localhost", String((resource.data as any).Ports ?? ""));
                return [
                  <span key="container" className="monoText">{String((containerData(resource).Names ?? resource.name) || resource.name)}</span>,
                  <span key="host">{rowHost?.name ?? resource.hostId}</span>,
                  <StatusPill key="status" status={state} />,
                  portsCell
                ];
              }}
            />
          )}
        </section>

        <section className="overviewPanelCard overviewUsageCard">
          <div className="overviewSectionHeader">
            <h3>Inventory footprint</h3>
            <p>Current scope inventory</p>
          </div>
          <div className="overviewUsageGrid">
            {resourceCards.map((item) => (
              <div className="overviewUsageMetric" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.hint}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="overviewPanelCard overviewRecentJobs">
        <div className="overviewSectionHeader">
          <h3>Recent jobs / queue</h3>
          <p>Latest operations and pending activity</p>
        </div>
        <DataTable
          rows={recentJobs}
          compact
          tableClassName="overviewJobsTable"
          columns={[
            "Recent Job",
            "Status",
            "Created",
            "Error"
          ]}
          render={(job) => [
            job.type,
            <StatusPill key="status" status={job.status} />,
            formatDate(job.createdAt),
            <span key="error" className="overviewJobsError">{job.error ?? ""}</span>
          ]}
        />
      </section>
    </Panel>
  );
}

export function SummaryCard({ label, value, tone, icon: Icon, series, delta, deltaGood, title, compact = false }: {
  label: string;
  value: string;
  tone: MetricTone;
  icon: ComponentType<{ size?: number }>;
  series: number[];
  delta: number;
  deltaGood: "up" | "down";
  title?: string;
  compact?: boolean;
}) {
  const deltaTone = delta === 0 ? "neutral" : deltaGood === "up" ? delta > 0 ? "good" : "bad" : delta < 0 ? "good" : "bad";
  const deltaLabel = `${delta > 0 ? "+" : ""}${delta}`;

  return (
    <div className={`summaryCard ${tone}${compact ? " compact" : ""}`} title={title}>
      <div className="summaryCardTop">
        <span className="summaryIcon"><Icon size={16} /></span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      {!compact && <Sparkline values={series} />}
      {delta !== 0 && (
        <div className="summaryMeta">
          <span className={`trendDelta ${deltaTone}`}>{deltaLabel}</span>
          <small>vs previous hour</small>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  const width = 154;
  const height = 38;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - ((value - min) / spread) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <svg className="summarySparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Last 60 minutes">
      <polyline points={points} />
    </svg>
  );
}
