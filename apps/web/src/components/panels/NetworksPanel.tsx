import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@dockermender/shared";
import { networkDriverExplanations, type NetworkDriver } from "@dockermender/shared";
import { useConfirm } from "../ConfirmProvider.js";
import { ButtonRow, DataTable, EmptyState, InlineForm, Panel } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { hostName } from "../../lib/hostScope.js";

export function NetworksPanel({ host, hosts, networks, onAction }: { host: DockerHost; hosts: DockerHost[]; networks: ResourceSnapshot[]; onAction: (type: string, payload?: Record<string, unknown>, hostId?: string) => Promise<void> }) {
  const { confirm } = useConfirm();
  const [name, setName] = useState("");
  const [driver, setDriver] = useState<NetworkDriver>("bridge");
  const [subnet, setSubnet] = useState("");
  const explanation = networkDriverExplanations[driver];
  const builtIn = driver === "host" || driver === "none";
  const showHostColumn = new Set(networks.map((network) => network.hostId)).size > 1;

  return (
    <Panel title="Networks" count={networks.length}>
      <ButtonRow>
        <button
          type="button"
          onClick={() => void (async () => {
            if (await confirm({ title: "Prune networks", tone: "danger", confirmLabel: "Prune", message: "Remove unused networks on this host?" })) {
              void onAction("network.prune", {}, host.id);
            }
          })()}
        >
          <Trash2 size={18} />Prune Unused
        </button>
      </ButtonRow>
      <div className="split">
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void onAction("network.create", { name, driver, subnet: subnet || undefined, labels: {} }, host.id);
          }}
        >
          <input placeholder="Network name" value={name} onChange={(event) => setName(event.target.value)} required />
          <select value={driver} onChange={(event) => setDriver(event.target.value as NetworkDriver)}>
            {Object.keys(networkDriverExplanations).map((key) => (
              <option key={key} value={key}>{networkDriverExplanations[key as NetworkDriver].title}</option>
            ))}
          </select>
          <input placeholder="Subnet, optional" value={subnet} onChange={(event) => setSubnet(event.target.value)} />
          <button className="primary" disabled={builtIn}><Plus size={18} />Create</button>
        </form>
        <aside className="helpBox">
          <strong>{explanation.title}</strong>
          <p>{explanation.summary}</p>
          <span>{explanation.bestFor}</span>
          <small>{explanation.watchOut}</small>
        </aside>
      </div>
      <DataTable
        rows={networks}
        columns={showHostColumn ? ["Host", "Name", "Driver", "Scope", "Actions"] : ["Name", "Driver", "Scope", "Actions"]}
        render={(network) => {
          const data = network.data as any;
          const protectedNetwork = ["bridge", "host", "none"].includes(String(data.Name));
          const cells: React.ReactNode[] = [
            data.Name ?? network.name,
            data.Driver ?? "",
            data.Scope ?? "",
            <ButtonRow key="actions">
              <button title="Remove network" className="danger" disabled={protectedNetwork} onClick={() => void onAction("network.remove", { networkId: network.externalId }, network.hostId)}><Trash2 size={16} /></button>
            </ButtonRow>
          ];
          return showHostColumn ? [hostName(hosts, network.hostId), ...cells] : cells;
        }}
      />
    </Panel>
  );
}
