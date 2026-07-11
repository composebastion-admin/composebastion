import { useState } from "react";
import { Activity, Boxes, GitBranch, Plus, RefreshCw, Server, Settings, Terminal } from "lucide-react";
import type { AdminUser, DockerHost } from "@composebastion/shared";
import { formatDate } from "../../lib/format.js";
import { describeAgentCompatibility } from "../../lib/agentCompatibility.js";
import { canOpenHostTerminal } from "../../lib/hostTerminal.js";
import type { Jobish } from "../../lib/dashboardTypes.js";
import { HostForm } from "../dashboard/HostForm.js";
import { ButtonRow, DataTable, StatusPill } from "../ui/primitives.js";
import { useAuthorization } from "../AuthorizationContext.js";

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
  const { canOperate, canUseTerminal } = useAuthorization();
  const [showHostForm, setShowHostForm] = useState(false);
  const onlineHosts = hosts.filter((host) => host.lastStatus === "online").length;
  const totalContainers = Object.values(containerCounts).reduce((total, count) => total + count, 0);

  const openHostForm = () => setShowHostForm(true);

  return (
    <div className="hostsSurface">
      <div className="hostsHero">
        <div className="hostsHeroTitle">
          <span>Fleet inventory</span>
          <h3>Hosts</h3>
          <p>Register Docker endpoints, track health, and keep inventory ready for action.</p>
        </div>
        <div className="hostsHeroStats" aria-label="Host summary">
          <div>
            <span>Hosts</span>
            <strong>{hosts.length}</strong>
          </div>
          <div>
            <span>Online</span>
            <strong>{onlineHosts}</strong>
          </div>
          <div>
            <span>Containers</span>
            <strong>{totalContainers}</strong>
          </div>
        </div>
        {canOperate && (
          <ButtonRow className="hostsHeroActions">
            <button type="button" className="primary" onClick={() => setShowHostForm((value) => !value)}>
              <Plus size={16} />
              {showHostForm ? "Close form" : "Add host"}
            </button>
          </ButtonRow>
        )}
      </div>
      {canOperate && showHostForm && (
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
        <section className="hostsEmptyState" aria-label="No hosts added">
          <div className="hostsEmptyInner">
            <div className="hostsEmptyVisual" aria-hidden="true">
              <span className="hostsEmptyNode">
                <Server size={26} />
              </span>
              <span className="hostsEmptyNode isPrimary">
                <Activity size={30} />
              </span>
              <span className="hostsEmptyNode">
                <Boxes size={26} />
              </span>
            </div>
            <div className="hostsEmptyCopy">
              <span>Ready for first contact</span>
              <h3>No hosts added</h3>
              <p>Add your first Docker server to begin discovering containers, images, and compose apps.</p>
            </div>
            <div className="hostsEmptyChecks" aria-hidden="true">
              <span><Server size={14} />SSH or agent</span>
              <span><GitBranch size={14} />Compose aware</span>
              <span><Activity size={14} />Health tracked</span>
            </div>
            {canOperate && (
              <button type="button" className="primary hostsEmptyAction" onClick={openHostForm}>
                <Plus size={16} />
                Add host
              </button>
            )}
          </div>
        </section>
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
              {canOperate && <button title="Check host" onClick={() => void onHostAction("host.check", host.id)}><Activity size={16} /></button>}
              <button title="View metrics" onClick={() => onOpenMetrics(host)}><Server size={16} /></button>
              {canOperate && <button title="Refresh inventory" onClick={() => void onHostAction("host.sync", host.id)}><RefreshCw size={16} /></button>}
              {canUseTerminal && canOpenHostTerminal(user, host) && (
                <button title="Open SSH terminal" onClick={() => onOpenTerminal(host)}><Terminal size={16} /></button>
              )}
              {canOperate && <button title="Host settings" onClick={() => { onSelectHost(host.id); onOpenAdmin(); }}><Settings size={16} /></button>}
            </ButtonRow>
          ]}
        />
      )}
    </div>
  );
}
