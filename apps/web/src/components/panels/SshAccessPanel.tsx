import { useState } from "react";
import { Activity, Plus, RefreshCw, Server, Settings, Terminal } from "lucide-react";
import type { AdminUser, DockerHost } from "@composebastion/shared";
import { formatDate } from "../../lib/format.js";
import { canOpenHostTerminal } from "../../lib/hostTerminal.js";
import type { Jobish } from "../../lib/dashboardTypes.js";
import { HostForm } from "../dashboard/HostForm.js";
import { ButtonRow, DataTable, EmptyState, StatusPill } from "../ui/primitives.js";

export function SshAccessPanel({
  hosts,
  selectedHostId,
  user,
  onSelectHost,
  onHostAction,
  onOpenHostSettings,
  onOpenTerminal,
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  selectedHostId: string;
  user: AdminUser;
  onSelectHost: (hostId: string) => void;
  onHostAction: (type: string, hostId: string) => Promise<void>;
  onOpenHostSettings: (hostId: string) => void;
  onOpenTerminal: (host: DockerHost) => void;
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const sshHosts = hosts.filter((host) => host.connectionMode === "ssh");
  const agentHosts = hosts.filter((host) => host.connectionMode === "agent");
  const onlineSshHosts = sshHosts.filter((host) => host.lastStatus === "online").length;
  const terminalReadyHosts = sshHosts.filter((host) => canOpenHostTerminal(user, host)).length;

  return (
    <div className="sshAccessSurface">
      <div className="resourceHeader sshAccessHeader">
        <div>
          <h3>SSH connections</h3>
          <p>Add and open SSH-backed Docker hosts from one place.</p>
        </div>
        <ButtonRow>
          <button type="button" className="primary" onClick={() => setShowAddForm((value) => !value)}>
            <Plus size={16} />Add SSH connection
          </button>
        </ButtonRow>
      </div>

      <div className="sshSummary" aria-label="SSH connection summary">
        <div>
          <span>SSH hosts</span>
          <strong>{sshHosts.length}</strong>
        </div>
        <div>
          <span>Online</span>
          <strong>{onlineSshHosts}/{sshHosts.length}</strong>
        </div>
        <div>
          <span>Terminal ready</span>
          <strong>{terminalReadyHosts}</strong>
        </div>
        <div>
          <span>Agent hosts</span>
          <strong>{agentHosts.length}</strong>
        </div>
      </div>

      {showAddForm && (
        <section className="sshFormPanel" aria-label="Add SSH connection">
          <HostForm
            runJob={runJob}
            onCreated={() => {
              setShowAddForm(false);
              void refresh();
            }}
            defaultConnectionMode="ssh"
            allowedConnectionModes={["ssh"]}
            showDemoWorkspace={false}
            intro="Add a Docker host reachable over SSH. ComposeBastion will use this same connection for inventory, actions, and terminal access."
            submitLabel="Save SSH connection"
          />
        </section>
      )}

      {sshHosts.length === 0 ? (
        <EmptyState
          headline="No SSH connections"
          hint="Add an SSH-backed Docker host to sync inventory and open a managed shell."
          actionLabel="Add SSH connection"
          onAction={() => setShowAddForm(true)}
        />
      ) : (
        <DataTable
          rows={sshHosts}
          columns={["Host", "Connection", "Status", "Docker socket", "Last seen", "Actions"]}
          render={(host) => [
            <button key="host" className="linkButton sshHostName" onClick={() => onSelectHost(host.id)}>
              {host.name}{host.id === selectedHostId ? " (selected)" : ""}
            </button>,
            <code key="connection">{host.username}@{host.hostname}:{host.port}</code>,
            <div key="status" className="alertRuleState">
              <StatusPill status={host.lastStatus} />
            </div>,
            <code key="socket">{host.dockerSocketPath}</code>,
            formatDate(host.lastSeenAt ?? host.updatedAt),
            <ButtonRow key="actions">
              <button title="Check SSH host" onClick={() => void onHostAction("host.check", host.id)}><Activity size={16} /></button>
              <button title="Refresh inventory" onClick={() => void onHostAction("host.sync", host.id)}><RefreshCw size={16} /></button>
              {canOpenHostTerminal(user, host) && (
                <button title="Open SSH terminal" onClick={() => onOpenTerminal(host)}><Terminal size={16} /></button>
              )}
              <button title="Open in Hosts" onClick={() => onSelectHost(host.id)}><Server size={16} /></button>
              <button title="SSH host settings" onClick={() => onOpenHostSettings(host.id)}><Settings size={16} /></button>
            </ButtonRow>
          ]}
        />
      )}
    </div>
  );
}
