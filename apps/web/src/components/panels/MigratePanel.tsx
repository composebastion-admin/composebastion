import { useState } from "react";
import { Copy } from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@composebastion/shared";
import { postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { ButtonRow, CardSection, Field, Panel } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";

export function MigratePanel({ hosts, resources, runJob }: { hosts: DockerHost[]; resources: ResourceSnapshot[]; refresh: () => Promise<void>; runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T> }) {
  const volumes = resources.filter((resource) => resource.kind === "volume");
  const containers = resources.filter((resource) => resource.kind === "container");
  const [volumeForm, setVolumeForm] = useState({ sourceHostId: hosts[0]?.id ?? "", targetHostId: hosts[1]?.id ?? hosts[0]?.id ?? "", sourceVolumeName: "", targetVolumeName: "", overwrite: false });
  const [containerForm, setContainerForm] = useState({ sourceHostId: hosts[0]?.id ?? "", targetHostId: hosts[1]?.id ?? hosts[0]?.id ?? "", containerId: "", targetName: "", start: false });
  const action = useAsyncAction();

  return (
    <Panel title="Clone and migrate">
      {action.error && <div className="notice error">{action.error}</div>}
      <div className="recoveryTaskGrid">
        <form className="recoveryTaskCard" onSubmit={(event) => { event.preventDefault(); void action.run(() => runJob(() => postJson<JobResult>("/api/migrations/volume-clone", volumeForm))); }}>
          <CardSection title="Clone volume data">
            <div className="recoveryFieldGrid twoColumn">
              <Field label="Source host">
                <HostSelect hosts={hosts} value={volumeForm.sourceHostId} onChange={(sourceHostId) => setVolumeForm({ ...volumeForm, sourceHostId })} />
              </Field>
              <Field label="Target host">
                <HostSelect hosts={hosts} value={volumeForm.targetHostId} onChange={(targetHostId) => setVolumeForm({ ...volumeForm, targetHostId })} />
              </Field>
            </div>
            <Field label="Source volume">
              <select value={volumeForm.sourceVolumeName} onChange={(event) => setVolumeForm({ ...volumeForm, sourceVolumeName: event.target.value, targetVolumeName: volumeForm.targetVolumeName || event.target.value })}>
                <option value="">Select volume</option>
                {volumes
                  .filter((volume) => volume.hostId === volumeForm.sourceHostId)
                  .map((volume) => <option key={volume.id} value={volume.name}>{volume.name}</option>)}
              </select>
            </Field>
            <Field label="Target volume">
              <input placeholder="Target volume" value={volumeForm.targetVolumeName} onChange={(event) => setVolumeForm({ ...volumeForm, targetVolumeName: event.target.value })} required />
            </Field>
            <label className="checkLine"><input type="checkbox" checked={volumeForm.overwrite} onChange={(event) => setVolumeForm({ ...volumeForm, overwrite: event.target.checked })} /> Overwrite existing volume</label>
          </CardSection>
          <ButtonRow className="recoveryActionRow">
            <button className="primary" disabled={action.busy || !volumeForm.sourceVolumeName || !volumeForm.targetVolumeName}><Copy size={18} />Clone volume</button>
          </ButtonRow>
        </form>
        <form className="recoveryTaskCard" onSubmit={(event) => { event.preventDefault(); void action.run(() => runJob(() => postJson<JobResult>("/api/migrations/container-clone", containerForm))); }}>
          <CardSection title="Clone container definition">
            <div className="recoveryFieldGrid twoColumn">
              <Field label="Source host">
                <HostSelect hosts={hosts} value={containerForm.sourceHostId} onChange={(sourceHostId) => setContainerForm({ ...containerForm, sourceHostId })} />
              </Field>
              <Field label="Target host">
                <HostSelect hosts={hosts} value={containerForm.targetHostId} onChange={(targetHostId) => setContainerForm({ ...containerForm, targetHostId })} />
              </Field>
            </div>
            <Field label="Source container">
              <select value={containerForm.containerId} onChange={(event) => setContainerForm({ ...containerForm, containerId: event.target.value })}>
                <option value="">Select container</option>
                {containers
                  .filter((container) => container.hostId === containerForm.sourceHostId)
                  .map((container) => <option key={container.id} value={container.externalId}>{container.name}</option>)}
              </select>
            </Field>
            <Field label="Target name">
              <input placeholder="Target name" value={containerForm.targetName} onChange={(event) => setContainerForm({ ...containerForm, targetName: event.target.value })} />
            </Field>
            <label className="checkLine"><input type="checkbox" checked={containerForm.start} onChange={(event) => setContainerForm({ ...containerForm, start: event.target.checked })} /> Start after clone</label>
          </CardSection>
          <ButtonRow className="recoveryActionRow">
            <button className="primary" disabled={action.busy || !containerForm.containerId}><Copy size={18} />Clone container</button>
          </ButtonRow>
        </form>
      </div>
    </Panel>
  );
}
