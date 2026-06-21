import { useState } from "react";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@composebastion/shared";
import { postJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { hostName } from "../../lib/hostScope.js";
import { ButtonRow, DataTable, InlineForm, Panel } from "../ui/primitives.js";

export function VolumesPanel({
  host,
  hosts,
  volumes,
  onAction,
  runJob
}: {
  host: DockerHost;
  hosts: DockerHost[];
  volumes: ResourceSnapshot[];
  onAction: (type: string, payload?: Record<string, unknown>, hostId?: string) => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const { confirm } = useConfirm();
  const [name, setName] = useState("");
  const action = useAsyncAction();
  const showHostColumn = new Set(volumes.map((volume) => volume.hostId)).size > 1;

  async function backupVolume(volume: ResourceSnapshot) {
    await action.run(() => runJob(() => postJson<JobResult>("/api/backups", { hostId: volume.hostId, volumeName: volume.name })));
  }

  return (
    <Panel title="Volumes" count={volumes.length}>
      <InlineForm onSubmit={() => onAction("volume.create", { name, labels: {} }, host.id)}>
        <input placeholder="Volume name" value={name} onChange={(event) => setName(event.target.value)} required />
        <button className="primary"><Plus size={18} />Create</button>
        <button
          type="button"
          onClick={() => void (async () => {
            if (await confirm({ title: "Prune volumes", tone: "danger", confirmLabel: "Prune", message: "Remove unused volumes on this host?" })) {
              void onAction("volume.prune", {}, host.id);
            }
          })()}
        >
          <Trash2 size={18} />Prune
        </button>
      </InlineForm>
      {action.error && <div className="notice error">{action.error}</div>}
      <DataTable
        rows={volumes}
        columns={showHostColumn ? ["Host", "Name", "Driver", "Scope", "Actions"] : ["Name", "Driver", "Scope", "Actions"]}
        render={(volume) => {
          const data = volume.data as any;
          const cells: React.ReactNode[] = [
            data.Name ?? volume.name,
            data.Driver ?? "",
            data.Scope ?? "",
            <ButtonRow key="actions">
              <button title="Back up volume" disabled={action.busy} onClick={() => void backupVolume(volume)}><ShieldCheck size={16} /></button>
              <button title="Remove volume" className="danger" onClick={() => void onAction("volume.remove", { volumeName: volume.name, force: false }, volume.hostId)}><Trash2 size={16} /></button>
            </ButtonRow>
          ];
          return showHostColumn ? [hostName(hosts, volume.hostId), ...cells] : cells;
        }}
      />
    </Panel>
  );
}
