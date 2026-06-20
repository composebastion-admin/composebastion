import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import type { DockerHost, Registry } from "@dockermender/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { ButtonRow, DataTable, Panel } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";

export function RegistriesPanel({ hosts, selectedHost, runJob }: { hosts: DockerHost[]; selectedHost: DockerHost; refresh: () => Promise<void>; runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T> }) {
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [form, setForm] = useState({ name: "", url: "", username: "", password: "", insecure: false });
  const [hostId, setHostId] = useState(selectedHost.id);
  const action = useAsyncAction();
  const load = useCallback(async () => {
    const result = await api<{ registries: Registry[] }>("/api/registries");
    setRegistries(result.registries);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Panel title="Registries" count={registries.length}>
      <form className="composeForm" onSubmit={(event) => { event.preventDefault(); void postJson("/api/registries", form).then(load); }}>
        <div className="two">
          <input placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          <input placeholder="Registry URL" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} required />
        </div>
        <div className="two">
          <input placeholder="Username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          <input placeholder="Password/token" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </div>
        <label className="checkLine"><input type="checkbox" checked={form.insecure} onChange={(event) => setForm({ ...form, insecure: event.target.checked })} /> Insecure registry</label>
        <button className="primary"><KeyRound size={18} />Save Registry</button>
      </form>
      {action.error && <div className="notice error">{action.error}</div>}
      <HostSelect hosts={hosts} value={hostId} onChange={setHostId} />
      <DataTable rows={registries} columns={["Name", "URL", "User", "Actions"]} render={(registry) => [
        registry.name,
        registry.url,
        registry.username ?? "",
        <ButtonRow key="actions"><button disabled={action.busy} onClick={() => void action.run(() => runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/registries/${registry.id}/login`, {})))}>Login</button><button className="danger" onClick={() => void deleteJson(`/api/registries/${registry.id}`).then(load)}><Trash2 size={16} /></button></ButtonRow>
      ]} />
    </Panel>
  );
}
