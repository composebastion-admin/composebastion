import type { DockerHost } from "@composebastion/shared";
import type { HostScope } from "../../lib/navigation.js";
import { getScopedHostIds } from "../../lib/hostScope.js";
import { HostSelect } from "./HostSelect.js";

export function HostScopeControl({
  hosts,
  selectedHostId,
  scope,
  customHostIds,
  onScopeChange,
  onSelectedHostChange,
  onCustomHostIdsChange,
  variant = "panel"
}: {
  hosts: DockerHost[];
  selectedHostId: string;
  scope: HostScope;
  customHostIds: string[];
  onScopeChange: (scope: HostScope) => void;
  onSelectedHostChange: (hostId: string) => void;
  onCustomHostIdsChange: (hostIds: string[]) => void;
  variant?: "panel" | "topbar";
}) {
  const scopedIds = getScopedHostIds(hosts, selectedHostId, scope, customHostIds);
  const isTopbar = variant === "topbar";

  function toggleHost(hostId: string) {
    const current = new Set(customHostIds);
    if (current.has(hostId)) current.delete(hostId);
    else current.add(hostId);
    onCustomHostIdsChange(Array.from(current));
  }

  const hostChecks = (
    <div className="hostScopeList">
      {hosts.map((host) => (
        <label className="checkLine" key={host.id}>
          <input type="checkbox" checked={customHostIds.includes(host.id)} onChange={() => toggleHost(host.id)} />
          <span>{host.name}</span>
          <small>{host.lastStatus}</small>
        </label>
      ))}
    </div>
  );

  return (
    <section className={`scopeBar ${variant === "topbar" ? "topbarScopeBar" : ""}`}>
      <div className="scopeControls">
        <label>
          <span>Management scope</span>
          <select value={scope} onChange={(event) => onScopeChange(event.target.value as HostScope)}>
            <option value="selected">Current host</option>
            <option value="all">All hosts</option>
            <option value="custom">Selected hosts</option>
          </select>
        </label>
        {scope === "selected" && (
          <label>
            <span>Host</span>
            <HostSelect hosts={hosts} value={selectedHostId} onChange={onSelectedHostChange} />
          </label>
        )}
        <div className="scopeSummary">
          <strong>{scopedIds.length}</strong>
          <span>{scopedIds.length === 1 ? "host in view" : "hosts in view"}</span>
        </div>
        {isTopbar && scope === "custom" && (
          <details className="hostScopeMenu">
            <summary>Edit hosts</summary>
            {hostChecks}
          </details>
        )}
      </div>
      {!isTopbar && scope === "custom" && hostChecks}
    </section>
  );
}
