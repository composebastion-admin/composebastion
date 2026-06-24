import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Eye,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Tags,
  Terminal,
  Trash2,
  Copy
} from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@composebastion/shared";
import { publishedWebLinks } from "@composebastion/shared";
import { api, postJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useToast } from "../ToastProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { formatDate } from "../../lib/format.js";
import {
  containerMetricKey,
  containerStateLabel,
  findUsageRow,
  parsePercent,
  pushMetricSample
} from "../../lib/dockerMetrics.js";
import {
  filterAndSortContainers,
  type ContainerSortKey,
  type ContainerStateFilter
} from "../../lib/containerList.js";
import type { ContainerMetricHistory, Jobish, MultiJobResult } from "../../lib/dashboardTypes.js";
import { ButtonRow, Panel, VirtualDataTable } from "../ui/primitives.js";
import { ContainerStatePill } from "../dashboard/ContainerStatePill.js";
import { ContainerAuditPanel } from "../containers/ContainerAuditPanel.js";
import { ContainerDetailDrawer } from "../containers/ContainerConsole.js";
import { ContainerRunForm } from "../containers/ContainerRunForm.js";
import { ContainerUpdatePanel } from "../containers/ContainerUpdatePanel.js";
import { UsageSparkCell } from "../containers/UsageSparkCell.js";

export function ContainersPanel({
  host,
  hosts,
  containers,
  images,
  networks,
  onAction,
  refresh,
  runJob,
  listQuery,
  listQueryKey = 0,
  transitioningContainerIds = new Set(),
  optimisticContainerStates = {},
  onSetOptimisticStates
}: {
  host: DockerHost;
  hosts: DockerHost[];
  containers: ResourceSnapshot[];
  images: ResourceSnapshot[];
  networks: ResourceSnapshot[];
  onAction: (type: string, payload?: Record<string, unknown>, hostId?: string) => Promise<void>;
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  listQuery?: string;
  listQueryKey?: number;
  transitioningContainerIds?: Set<string>;
  optimisticContainerStates?: Record<string, { state: string; timestamp: number }>;
  onSetOptimisticStates?: (updates: Record<string, string>) => void;
}) {
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [query, setQuery] = useState("");
  const [showRunForm, setShowRunForm] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastContainerUpdate, setLastContainerUpdate] = useState<{
    containerName: string;
    targetImage: string;
    completedAt: string;
  } | null>(null);

  useEffect(() => {
    if (listQuery !== undefined) setQuery(listQuery);
  }, [listQuery, listQueryKey]);

  useEffect(() => {
    setLastContainerUpdate(null);
  }, [host.id]);

  const [stateFilter, setStateFilter] = useState<ContainerStateFilter>("all");
  const [sortKey, setSortKey] = useState<ContainerSortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [selected, setSelected] = useState<ResourceSnapshot | null>(null);
  const [updateTarget, setUpdateTarget] = useState<ResourceSnapshot | null>(null);
  const [auditTarget, setAuditTarget] = useState<ResourceSnapshot | null>(null);
  const [usage, setUsage] = useState<Record<string, Record<string, any>[]>>({});
  const [metricHistory, setMetricHistory] = useState<ContainerMetricHistory>({});
  const action = useAsyncAction();
  const networkOptions = networks.filter((network) => network.hostId === host.id);
  const showHostColumn = new Set(containers.map((container) => container.hostId)).size > 1;
  const containerHostKey = useMemo(() => Array.from(new Set(containers.map((container) => container.hostId))).sort().join(","), [containers]);
  const visibleContainers = useMemo(
    () => filterAndSortContainers(containers, query, stateFilter, sortKey, sortDesc),
    [containers, query, stateFilter, sortKey, sortDesc]
  );
  const runningCount = visibleContainers.filter((container) => containerStateLabel(String((container.data as any).State ?? "")) === "running").length;

  const loadUsage = useCallback(async () => {
    const hostIds = containerHostKey.split(",").filter(Boolean);
    if (hostIds.length === 0) {
      setUsage({});
      return;
    }
    try {
      const results = await Promise.all(hostIds.map(async (hostId) => ({
        hostId,
        result: await api<{ usage: Record<string, any>[] }>(`/api/hosts/${hostId}/containers/usage`)
      })));
      const nextUsage = Object.fromEntries(results.map(({ hostId, result }) => [hostId, result.usage]));
      setUsage(nextUsage);
      setMetricHistory((current) => {
        const next = { ...current };
        for (const container of containers) {
          const stats = findUsageRow(container, nextUsage[container.hostId] ?? []);
          if (!stats) continue;
          const key = containerMetricKey(container);
          const existing = next[key] ?? { cpu: [], memory: [] };
          next[key] = {
            cpu: pushMetricSample(existing.cpu, parsePercent(stats.CPUPerc)),
            memory: pushMetricSample(existing.memory, parsePercent(stats.MemPerc))
          };
        }
        return next;
      });
    } catch {
      setUsage({});
    }
  }, [containerHostKey, containers]);

  useEffect(() => {
    void loadUsage();
    const timer = window.setInterval(() => void loadUsage(), 2_000);
    return () => window.clearInterval(timer);
  }, [loadUsage]);

  useEffect(() => {
    if (!("EventSource" in window)) return undefined;
    const hostIds = containerHostKey.split(",").filter(Boolean);
    if (hostIds.length === 0) return undefined;
    const sources = hostIds.map((hostId) => {
      const source = new EventSource(`/api/hosts/${hostId}/containers/usage-stream`);
      source.onmessage = (event) => {
        let payload: { stats?: Record<string, any> };
        try {
          payload = JSON.parse(event.data) as { stats?: Record<string, any> };
        } catch {
          return;
        }
        const stats = payload.stats;
        if (!stats) return;
        setUsage((current) => {
          const rows = current[hostId] ?? [];
          const nextRows = [
            ...rows.filter((row) => String(row.ID) !== String(stats.ID) && String(row.Name) !== String(stats.Name)),
            stats
          ];
          return { ...current, [hostId]: nextRows };
        });
        setMetricHistory((current) => {
          const container = containers.find((item) => item.hostId === hostId && findUsageRow(item, [stats]));
          if (!container) return current;
          const key = containerMetricKey(container);
          const existing = current[key] ?? { cpu: [], memory: [] };
          return {
            ...current,
            [key]: {
              cpu: pushMetricSample(existing.cpu, parsePercent(stats.CPUPerc)),
              memory: pushMetricSample(existing.memory, parsePercent(stats.MemPerc))
            }
          };
        });
      };
      source.onerror = () => {
        source.close();
        void loadUsage();
      };
      return source;
    });
    return () => sources.forEach((source) => source.close());
  }, [containerHostKey, containers, loadUsage]);

  function usageFor(container: ResourceSnapshot) {
    return findUsageRow(container, usage[container.hostId] ?? []) ?? {};
  }

  async function backupContainer(container: ResourceSnapshot) {
    await action.run(() => runJob(() => postJson<MultiJobResult>(`/api/hosts/${container.hostId}/containers/${encodeURIComponent(container.externalId)}/backups`, {})));
  }

  const handleSelectToggle = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllToggle = () => {
    const visibleIds = visibleContainers.map((c) => c.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds((current) => {
        const next = new Set(current);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((current) => {
        const next = new Set(current);
        visibleIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast("Copied to clipboard", "success");
    } catch {
      pushToast("Failed to copy", "error");
    }
  };

  async function handleBulkAction(type: string) {
    const selectedContainers = visibleContainers.filter((c) => selectedIds.has(c.id));
    if (selectedContainers.length === 0) return;
    const actionLabel = type === "container.start" ? "Start" : type === "container.stop" ? "Stop" : "Restart";
    if (
      !(await confirm({
        title: `${actionLabel} selected containers`,
        confirmLabel: actionLabel,
        message: `${actionLabel} ${selectedContainers.length} selected container(s)?`
      }))
    ) {
      return;
    }
    
    const targetState = type === "container.start" || type === "container.restart"
      ? "running"
      : type === "container.stop"
        ? "exited"
        : null;

    if (targetState && onSetOptimisticStates) {
      const updates = Object.fromEntries(selectedContainers.map((c) => [c.externalId, targetState]));
      onSetOptimisticStates(updates);
    }

    try {
      await action.run(async () => {
        await runJob(async () => {
          const results = await Promise.all(
            selectedContainers.map((container) =>
              postJson<{ job: any }>(`/api/hosts/${container.hostId}/actions`, {
                type,
                payload: { containerId: container.externalId }
              })
            )
          );
          return { jobs: results.map((r) => r.job) };
        });
      });
    } catch (err) {
      await refresh();
      throw err;
    }
    setSelectedIds(new Set());
    await refresh();
  }

  async function handleBulkDelete() {
    const selectedContainers = visibleContainers.filter((c) => selectedIds.has(c.id));
    if (selectedContainers.length === 0) return;
    
    if (
      await confirm({
        title: "Delete multiple containers",
        tone: "danger",
        confirmLabel: "Delete All",
        message: `Are you sure you want to delete ${selectedContainers.length} container(s)?`
      })
    ) {
      if (onSetOptimisticStates) {
        const updates = Object.fromEntries(selectedContainers.map((c) => [c.externalId, "removing"]));
        onSetOptimisticStates(updates);
      }
      try {
        await action.run(async () => {
          await runJob(async () => {
            const results = await Promise.all(
              selectedContainers.map((container) =>
                postJson<{ job: any }>(`/api/hosts/${container.hostId}/actions`, {
                  type: "container.remove",
                  payload: { containerId: container.externalId, force: true, removeVolumes: false }
                })
              )
            );
            return { jobs: results.map((r) => r.job) };
          });
        });
      } catch (err) {
        await refresh();
        throw err;
      }
      setSelectedIds(new Set());
      await refresh();
    }
  }

  const compactMetric = (value: unknown, maxLength = 18) => {
    const text = String(value ?? "").trim();
    if (!text) return "—";
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
  };

  const compactPorts = (rawPorts: unknown, links: Array<{ port: string }>) => {
    const primaryLink = links[0];
    if (!primaryLink) return compactMetric(rawPorts, 26);
    return links.length === 1 ? primaryLink.port : `${primaryLink.port} (+${links.length - 1})`;
  };

  return (
    <Panel title="Containers" count={visibleContainers.length}>
      <div className="containerFilterToolbar">
        <div className="containerFilterSummary">
          <strong>{runningCount} running</strong>
          <span>{visibleContainers.length} of {containers.length} containers</span>
        </div>
        <input
          placeholder="Filter by name, image, or state"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter containers"
        />
        <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as ContainerStateFilter)} aria-label="Filter by state">
          <option value="all">All states</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
        </select>
        <select value={sortKey} onChange={(event) => setSortKey(event.target.value as ContainerSortKey)} aria-label="Sort by">
          <option value="name">Sort by name</option>
          <option value="state">Sort by state</option>
          <option value="image">Sort by image</option>
        </select>
        <label className="checkLine">
          <input type="checkbox" checked={sortDesc} onChange={(event) => setSortDesc(event.target.checked)} />
          Descending
        </label>
        <button type="button" className="primary" onClick={() => setShowRunForm((value) => !value)}>
          <Plus size={16} />
          Run container
        </button>
      </div>
      {showRunForm && (
        <ContainerRunForm
          host={host}
          networks={networkOptions}
          onCreateNetwork={(payload) => onAction("network.create", payload, host.id)}
          onRun={async (payload) => { await onAction("container.run", payload, host.id); await refresh(); setShowRunForm(false); }}
        />
      )}
      {action.error && <div className="notice error">{action.error}</div>}
      {lastContainerUpdate && (
        <div className="notice success" role="status">
          Container update successful for <strong>{lastContainerUpdate.containerName}</strong>. Now using <code>{lastContainerUpdate.targetImage}</code> as of {formatDate(lastContainerUpdate.completedAt)}.
        </div>
      )}
      <VirtualDataTable
        rows={visibleContainers}
        maxRows={300}
        columns={showHostColumn ? ["Host", "Name", "Image", "State", "CPU", "Memory", "Disk", "Web", "Ports", "Console", "Actions"] : ["Name", "Image", "State", "CPU", "Memory", "Disk", "Web", "Ports", "Console", "Actions"]}
        compact={true}
        tableClassName="containerTable"
        selectable={true}
        selectedIds={selectedIds}
        onSelectToggle={handleSelectToggle}
        onSelectAllToggle={handleSelectAllToggle}
        render={(container) => {
          const data = container.data as any;
          const stats = usageFor(container);
          const rowHost = hosts.find((item) => item.id === container.hostId) ?? host;
          const links = publishedWebLinks(rowHost.hostname, String(data.Ports ?? ""));
          const primaryLink = links[0];
          const portsSummary = compactPorts(data.Ports, links);
          const history = metricHistory[containerMetricKey(container)] ?? { cpu: [], memory: [] };
          const optimisticRecord = optimisticContainerStates[container.externalId];
          const isTransitioning = transitioningContainerIds.has(container.externalId) || !!optimisticRecord;
          const displayState = optimisticRecord ? optimisticRecord.state : String(data.State ?? "");
          const cells: React.ReactNode[] = [
            <div key="name" className="copyContainer">
              <span>{data.Names ?? container.name}</span>
              <button className="copyButton" title="Copy container ID" onClick={() => void handleCopy(container.externalId)}><Copy size={12} /></button>
            </div>,
            <div key="image" className="copyContainer">
              <span>{data.Image ?? ""}</span>
              {data.Image && <button className="copyButton" title="Copy image reference" onClick={() => void handleCopy(data.Image)}><Copy size={12} /></button>}
            </div>,
            <div key="state" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <ContainerStatePill state={displayState} />
              {isTransitioning && (
                <RefreshCw className="spin" size={14} style={{ color: "var(--warning)" }} />
              )}
            </div>,
            <UsageSparkCell key="cpu" compact label={String(stats.CPUPerc ?? "0.00%")} values={history.cpu} tone={parsePercent(stats.CPUPerc) > 80 ? "danger" : parsePercent(stats.CPUPerc) > 60 ? "warning" : "ok"} />,
            <UsageSparkCell key="memory" compact label={`${String(stats.MemPerc ?? "0.00%")} ${stats.MemUsage ? `(${stats.MemUsage})` : ""}`} values={history.memory} tone={parsePercent(stats.MemPerc) > 85 ? "danger" : parsePercent(stats.MemPerc) > 70 ? "warning" : "ok"} />,
            <span key="disk" className="containerMetricText" title={String(data.Size ?? stats.BlockIO ?? "")}>
              {compactMetric(data.Size ?? stats.BlockIO)}
            </span>,
            primaryLink ? (
              <ButtonRow key="web" className="containerWebLinks">
                <a className="buttonLink webLink" href={primaryLink.url} target="_blank" rel="noreferrer" title={`Open ${primaryLink.url}`}>
                  <ExternalLink size={14} />
                  {primaryLink.port}
                </a>
                {links.length > 1 && <span className="containerPortsExtra">+{links.length - 1}</span>}
              </ButtonRow>
            ) : "",
            <span key="ports" className="containerPortsCell" title={String(data.Ports ?? "")}>
              {portsSummary}
            </span>,
            <button key="console" className="containerIconButton" title="Open logs, stats, and exec" onClick={() => setSelected(container)}><Terminal size={16} /></button>,
            <ButtonRow key="actions" className="containerActionRow">
              <button title="Start" disabled={isTransitioning} onClick={() => void onAction("container.start", { containerId: container.externalId }, container.hostId)}><Play size={16} /></button>
              <button title="Stop" disabled={isTransitioning} onClick={() => void onAction("container.stop", { containerId: container.externalId }, container.hostId)}><Square size={16} /></button>
              <button title="Restart" disabled={isTransitioning} onClick={() => void onAction("container.restart", { containerId: container.externalId }, container.hostId)}><RotateCcw size={16} /></button>
              <details className="overflowMenu" style={{ pointerEvents: isTransitioning ? "none" : "auto", opacity: isTransitioning ? 0.5 : 1 }}>
                <summary title="More actions"><MoreHorizontal size={16} /></summary>
                <div className="overflowMenuPanel">
                  <button onClick={() => { const name = window.prompt("Rename container", String(data.Names ?? container.name)); if (name) void onAction("container.rename", { containerId: container.externalId, name }, container.hostId); }}><Pencil size={16} />Rename</button>
                  <button onClick={() => setAuditTarget(container)}><Eye size={16} />Audit</button>
                  <button onClick={() => setUpdateTarget(container)}><Tags size={16} />Update Tag</button>
                  <button onClick={() => void backupContainer(container)}><ShieldCheck size={16} />Backup</button>
                  <button
                    className="danger"
                    onClick={() => void (async () => {
                      if (await confirm({
                        title: "Delete container",
                        tone: "danger",
                        confirmLabel: "Delete",
                        message: `Delete container "${data.Names ?? container.name}"?`
                      })) {
                        void onAction("container.remove", { containerId: container.externalId, force: true, removeVolumes: false }, container.hostId);
                      }
                    })()}
                  >
                    <Trash2 size={16} />Delete
                  </button>
                </div>
              </details>
            </ButtonRow>
          ];
          return showHostColumn ? [rowHost.name, ...cells] : cells;
        }}
      />
      {selectedIds.size > 0 && (
        <div className="bulkActionBar">
          <span>{selectedIds.size} container(s) selected</span>
          <ButtonRow>
            <button className="primary" onClick={() => void handleBulkAction("container.start")} title="Start selected"><Play size={16} />Start</button>
            <button className="secondary" onClick={() => void handleBulkAction("container.stop")} title="Stop selected"><Square size={16} />Stop</button>
            <button className="secondary" onClick={() => void handleBulkAction("container.restart")} title="Restart selected"><RotateCcw size={16} />Restart</button>
            <button className="danger" onClick={() => void handleBulkDelete()} title="Delete selected"><Trash2 size={16} />Delete</button>
          </ButtonRow>
        </div>
      )}
      {updateTarget && (
        <ContainerUpdatePanel
          container={updateTarget}
          images={images.filter((image) => image.hostId === updateTarget.hostId)}
          onClose={() => setUpdateTarget(null)}
          onUpdate={async (targetImage) => {
            const target = updateTarget;
            await onAction("container.update", { containerId: target.externalId, targetImage }, target.hostId);
            setLastContainerUpdate({
              containerName: String((target.data as any).Names ?? target.name),
              targetImage,
              completedAt: new Date().toISOString()
            });
            setUpdateTarget(null);
          }}
        />
      )}
      {auditTarget && <ContainerAuditPanel host={hosts.find((item) => item.id === auditTarget.hostId) ?? host} container={auditTarget} onClose={() => setAuditTarget(null)} />}
      {selected && (
        <ContainerDetailDrawer
          host={hosts.find((item) => item.id === selected.hostId) ?? host}
          container={selected}
          onClose={() => setSelected(null)}
          onAction={onAction}
        />
      )}
    </Panel>
  );
}
