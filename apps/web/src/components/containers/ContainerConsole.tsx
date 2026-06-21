import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Play, RefreshCw, RotateCcw, Square, Terminal, X } from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@composebastion/shared";
import { api, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { findUsageRow } from "../../lib/dockerMetrics.js";
import { ButtonRow, StatusPill } from "../ui/primitives.js";
import { ContainerStatePill } from "../dashboard/ContainerStatePill.js";

type ContainerInspectDetails = {
  image: string;
  status: string;
  restartPolicy: string;
  env: string[];
  mounts: Array<{ type: string; name?: string; source?: string; destination: string; readOnly: boolean }>;
  networks: Array<{ name: string; ipAddress?: string; aliases: string[] }>;
  ports: Array<{ containerPort: string; protocol: string; hostIp?: string; hostPort?: string }>;
  labels: Record<string, string>;
};

type DetailTab = "overview" | "logs" | "stats" | "inspect" | "exec";

const tabs: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "stats", label: "Stats" },
  { id: "inspect", label: "Inspect" },
  { id: "exec", label: "Exec" }
];

function compactPorts(inspect: ContainerInspectDetails | null, rawPorts: unknown) {
  if (inspect?.ports.length) {
    return inspect.ports.map((port) => port.hostPort ? `${port.hostIp ? `${port.hostIp}:` : ""}${port.hostPort}->${port.containerPort}/${port.protocol}` : `${port.containerPort}/${port.protocol}`).join(", ");
  }
  return String(rawPorts ?? "").trim() || "No published ports";
}

function appendCapped(current: string[], next: string[]) {
  return [...current, ...next].slice(-5000);
}

function linesFromLogResult(result: { stdout: string; stderr: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").split(/\r?\n/).filter(Boolean);
}

function KeyValueGrid({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && String(value) !== "");
  if (entries.length === 0) return <div className="detailEmpty">No values reported.</div>;
  return (
    <div className="detailKeyValueGrid">
      {entries.map(([key, value]) => (
        <span key={key}>
          <strong>{key}</strong>
          <code>{String(value)}</code>
        </span>
      ))}
    </div>
  );
}

export function ContainerDetailDrawer({
  host,
  container,
  onClose,
  onAction
}: {
  host: DockerHost;
  container: ResourceSnapshot;
  onClose: () => void;
  onAction: (type: string, payload?: Record<string, unknown>, hostId?: string) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [logs, setLogs] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState("");
  const [wrapLogs, setWrapLogs] = useState(true);
  const [followLogs, setFollowLogs] = useState(false);
  const [tail, setTail] = useState(500);
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [usageStats, setUsageStats] = useState<Record<string, unknown> | null>(null);
  const [inspect, setInspect] = useState<ContainerInspectDetails | null>(null);
  const [command, setCommand] = useState("pwd && ls -la");
  const [output, setOutput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const action = useAsyncAction();
  const data = container.data as Record<string, unknown>;
  const canFollowLogs = host.connectionMode === "ssh" || host.connectionMode === "agent";
  const canStreamUsage = host.connectionMode === "ssh";
  const displayedStats = usageStats ?? stats;
  const filteredLogs = useMemo(() => {
    const query = logFilter.trim().toLowerCase();
    return query ? logs.filter((line) => line.toLowerCase().includes(query)) : logs;
  }, [logFilter, logs]);

  const refreshLogs = useCallback(async () => {
    const result = await api<{ stdout: string; stderr: string }>(`/api/hosts/${host.id}/containers/${encodeURIComponent(container.externalId)}/logs?tail=${tail}`);
    setLogs(linesFromLogResult(result));
  }, [host.id, container.externalId, tail]);

  const refreshStats = useCallback(async () => {
    const result = await api<{ stats: Record<string, unknown> }>(`/api/hosts/${host.id}/containers/${encodeURIComponent(container.externalId)}/stats`);
    setStats(result.stats);
  }, [host.id, container.externalId]);

  const refreshInspect = useCallback(async () => {
    const result = await api<{ inspect: ContainerInspectDetails }>(`/api/hosts/${host.id}/containers/${encodeURIComponent(container.externalId)}/inspect`);
    setInspect(result.inspect);
  }, [host.id, container.externalId]);

  useEffect(() => {
    setLoadError(null);
    setLogs([]);
    setStats({});
    setUsageStats(null);
    setInspect(null);
    void Promise.all([refreshLogs(), refreshStats(), refreshInspect()]).catch((caught) => setLoadError(caught instanceof Error ? caught.message : String(caught)));
  }, [refreshLogs, refreshStats, refreshInspect]);

  useEffect(() => {
    if (followLogs && canFollowLogs) return undefined;
    const timer = window.setInterval(() => void refreshLogs().catch(() => undefined), 5_000);
    return () => window.clearInterval(timer);
  }, [canFollowLogs, followLogs, refreshLogs]);

  useEffect(() => {
    if (!followLogs || !canFollowLogs || !("EventSource" in window)) return undefined;
    setLogs([]);
    const source = new EventSource(`/api/hosts/${host.id}/containers/${encodeURIComponent(container.externalId)}/logs-stream?tail=${tail}`);
    source.onopen = () => setLoadError(null);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { line?: string };
        if ("line" in payload) {
          setLoadError(null);
          setLogs((current) => appendCapped(current, [payload.line ?? ""]));
        }
      } catch {
        // Ignore malformed stream frames and keep following.
      }
    };
    source.addEventListener("error", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { error?: string };
        if (payload.error) setLoadError(payload.error);
      } catch {
        setLoadError("Log stream is reconnecting.");
      }
    });
    source.onerror = () => {
      setLoadError("Log stream is reconnecting.");
    };
    return () => source.close();
  }, [canFollowLogs, container.externalId, followLogs, host.id, tail]);

  useEffect(() => {
    void refreshStats().catch(() => undefined);
    const timer = window.setInterval(() => void refreshStats().catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [refreshStats]);

  useEffect(() => {
    if (!("EventSource" in window) || !canStreamUsage) return undefined;
    const source = new EventSource(`/api/hosts/${host.id}/containers/usage-stream`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { stats?: Record<string, unknown> };
        if (payload.stats && findUsageRow(container, [payload.stats])) setUsageStats(payload.stats);
      } catch {
        // Stats polling remains active as the fallback.
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [canStreamUsage, container, host.id]);

  async function exec(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const result = await postJson<{ stdout: string; stderr: string }>(`/api/hosts/${host.id}/containers/${encodeURIComponent(container.externalId)}/exec`, { command });
      setOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
    });
  }

  function downloadLogs() {
    const blob = new Blob([logs.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${container.name || container.externalId}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function quickAction(type: "container.start" | "container.stop" | "container.restart") {
    await action.run(() => onAction(type, { containerId: container.externalId }, container.hostId));
  }

  return (
    <div className="drawer containerDetailDrawer">
      <div className="panelHeader">
        <div>
          <h3>{String(data.Names ?? container.name)}</h3>
          <p>{inspect?.image ?? String(data.Image ?? "")}</p>
        </div>
        <button onClick={onClose} title="Close"><X size={16} /></button>
      </div>

      <div className="drawerTabs" role="tablist" aria-label="Container detail sections">
        {tabs.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {loadError && <div className="notice error">{loadError}</div>}
      {action.error && <div className="notice error">{action.error}</div>}

      {activeTab === "overview" && (
        <div className="detailStack">
          <div className="containerOverviewGrid">
            <span>
              <strong>Status</strong>
              <ContainerStatePill state={inspect?.status ?? String(data.State ?? "")} />
            </span>
            <span>
              <strong>Image</strong>
              <code>{inspect?.image ?? String(data.Image ?? "")}</code>
            </span>
            <span>
              <strong>Restart</strong>
              <StatusPill status={inspect?.restartPolicy ?? "unknown"} />
            </span>
            <span>
              <strong>Ports</strong>
              <code>{compactPorts(inspect, data.Ports)}</code>
            </span>
          </div>
          <ButtonRow>
            <button onClick={() => void quickAction("container.start")}><Play size={16} />Start</button>
            <button onClick={() => void quickAction("container.stop")}><Square size={16} />Stop</button>
            <button onClick={() => void quickAction("container.restart")}><RotateCcw size={16} />Restart</button>
            <button onClick={() => void refreshInspect()}><RefreshCw size={16} />Refresh</button>
          </ButtonRow>
        </div>
      )}

      {activeTab === "logs" && (
        <div className="detailStack">
          <div className="logToolbar">
            <input placeholder="Filter logs" value={logFilter} onChange={(event) => setLogFilter(event.target.value)} />
            <select value={tail} onChange={(event) => setTail(Number(event.target.value))}>
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
              <option value={5000}>5000</option>
            </select>
            <label className="checkLine">
              <input type="checkbox" checked={wrapLogs} onChange={(event) => setWrapLogs(event.target.checked)} />
              Wrap
            </label>
            <label className="checkLine" title={canFollowLogs ? "Follow log output" : "Follow is available on SSH and agent hosts"}>
              <input type="checkbox" checked={followLogs && canFollowLogs} disabled={!canFollowLogs} onChange={(event) => setFollowLogs(event.target.checked)} />
              Follow
            </label>
            <button onClick={() => void refreshLogs()}><RefreshCw size={16} />Refresh</button>
            <button onClick={downloadLogs}><Download size={16} />Download</button>
          </div>
          <pre className={`terminal ${wrapLogs ? "" : "nowrap"}`}>{filteredLogs.join("\n") || "No logs yet."}</pre>
        </div>
      )}

      {activeTab === "stats" && (
        <div className="detailStack">
          <KeyValueGrid values={displayedStats} />
        </div>
      )}

      {activeTab === "inspect" && (
        <div className="detailStack inspectGrid">
          <section>
            <h4>Environment</h4>
            <pre className="detailPre">{inspect?.env.join("\n") || "No environment reported."}</pre>
          </section>
          <section>
            <h4>Mounts</h4>
            <pre className="detailPre">{inspect?.mounts.map((mount) => `${mount.type} ${mount.source ?? mount.name ?? ""} -> ${mount.destination}${mount.readOnly ? " (ro)" : ""}`).join("\n") || "No mounts reported."}</pre>
          </section>
          <section>
            <h4>Networks</h4>
            <pre className="detailPre">{inspect?.networks.map((network) => `${network.name}${network.ipAddress ? ` ${network.ipAddress}` : ""}${network.aliases.length ? ` aliases=${network.aliases.join(",")}` : ""}`).join("\n") || "No networks reported."}</pre>
          </section>
          <section>
            <h4>Labels</h4>
            <pre className="detailPre">{inspect ? Object.entries(inspect.labels).map(([key, value]) => `${key}=${value}`).join("\n") || "No labels reported." : "No labels reported."}</pre>
          </section>
        </div>
      )}

      {activeTab === "exec" && (
        <div className="detailStack">
          <form className="inlineForm" onSubmit={exec}>
            <input value={command} onChange={(event) => setCommand(event.target.value)} />
            <button className="primary"><Terminal size={18} />Exec</button>
          </form>
          {output && <pre className="terminal">{output}</pre>}
        </div>
      )}
    </div>
  );
}

export const ContainerConsole = ContainerDetailDrawer;
