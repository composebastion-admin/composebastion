import { useState } from "react";
import { Activity, Plus, RefreshCw, Server, Settings, Terminal } from "lucide-react";
import type { AdminUser, DockerHost } from "@composebastion/shared";
import { formatDate } from "../../lib/format.js";
import { describeAgentCompatibility } from "../../lib/agentCompatibility.js";
import { canOpenHostTerminal } from "../../lib/hostTerminal.js";
import type { Jobish } from "../../lib/dashboardTypes.js";
import { HostForm } from "../dashboard/HostForm.js";
import { ButtonRow, DataTable, EmptyState, StatusPill } from "../ui/primitives.js";

export function HostsPanel({
  hosts,
  selectedHostId,
  containerCounts,
  user,
  onSelectHost,
  refresh,
  runJob,
  onHostAction,
  onOpenMetrics,
  onOpenAdmin,
  onOpenTerminal
}: {
  hosts: DockerHost[];
  selectedHostId: string;
  containerCounts: Record<string, number>;
  user: AdminUser;
  onSelectHost: (hostId: string) => void;
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  onHostAction: (type: string, hostId: string) => Promise<void>;
  onOpenMetrics: (host: DockerHost) => void;
  onOpenAdmin: () => void;
  onOpenTerminal: (host: DockerHost) => void;
}) {
  const [showHostForm, setShowHostForm] = useState(false);

  const openHostForm = () => setShowHostForm(true);

  return (
    <div className="hostsSurface">
      <div className="resourceHeader">
        <div>
          <h3>Hosts</h3>
          <p>Add a server once, then let ComposeBastion keep inventory fresh in the background.</p>
        </div>
        <ButtonRow>
          <button type="button" className="primary" onClick={() => setShowHostForm((value) => !value)}>
            <Plus size={16} />
            {showHostForm ? "Close form" : "Add host"}
          </button>
        </ButtonRow>
      </div>
      {showHostForm && (
        <div className="hostsAddPanel">
          <HostForm
            runJob={runJob}
            onCreated={() => {
              setShowHostForm(false);
              void refresh();
            }}
            submitLabel="Save host"
          />
        </div>
      )}
      {hosts.length === 0 ? (
        <EmptyState headline="No hosts added" hint="Add your first Docker server to begin discovering containers, images, and compose apps." actionLabel="Add host" onAction={openHostForm} />
      ) : (
        <DataTable
          rows={hosts}
          columns={["Host", "Address", "Status", "Containers", "Docker", "Last Seen", "Actions"]}
          render={(host) => [
            <button key="host" className="linkButton" onClick={() => onSelectHost(host.id)}>
              {host.name}{host.id === selectedHostId ? " (selected)" : ""}
            </button>,
            <code key="address">{host.username}@{host.hostname}:{host.port}</code>,
            <StatusPill key="status" status={host.lastStatus} />,
            containerCounts[host.id] ?? 0,
            <div key="docker" className="alertRuleState">
              <span>{host.dockerVersion ? `Docker ${host.dockerVersion}${host.composeVersion ? ` / Compose ${host.composeVersion}` : ""}` : "Pending"}</span>
              {host.connectionMode === "agent" && (
                <small>{describeAgentCompatibility(host.agentVersion).label}</small>
              )}
            </div>,
            formatDate(host.updatedAt),
            <ButtonRow key="actions">
              <button title="Check host" onClick={() => void onHostAction("host.check", host.id)}><Activity size={16} /></button>
              <button title="View metrics" onClick={() => onOpenMetrics(host)}><Server size={16} /></button>
              <button title="Refresh inventory" onClick={() => void onHostAction("host.sync", host.id)}><RefreshCw size={16} /></button>
              {canOpenHostTerminal(user, host) && (
                <button title="Open SSH terminal" onClick={() => onOpenTerminal(host)}><Terminal size={16} /></button>
              )}
              <button title="Host settings" onClick={() => { onSelectHost(host.id); onOpenAdmin(); }}><Settings size={16} /></button>
            </ButtonRow>
          ]}
        />
      )}
    </div>
  );
}
