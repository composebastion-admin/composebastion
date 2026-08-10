import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import type { DockerHost, Registry } from "@composebastion/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { ButtonRow, DataTable, Panel } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { useConfirm } from "../ConfirmProvider.js";

export function RegistriesPanel({ hosts, selectedHost, runJob }: { hosts: DockerHost[]; selectedHost: DockerHost; refresh: () => Promise<void>; runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T> }) {
  const { confirm } = useConfirm();
  const [registries, setRegistries] = useState<Registry[]>([]);
  const [form, setForm] = useState({ name: "", url: "", username: "", password: "", insecure: false });
  const [hostId, setHostId] = useState(selectedHost.id);
  const action = useAsyncAction();
  const load = useCallback(async () => {
    const result = await api<{ registries: Registry[] }>("/api/registries");
    setRegistries(result.registries);
  }, []);

  useEffect(() => {
    void action.run(load).catch(() => undefined);
  }, [action.run, load]);

  useEffect(() => {
    setHostId((current) => hosts.some((item) => item.id === current) ? current : selectedHost.id);
  }, [hosts, selectedHost.id]);

  async function saveRegistry() {
    await action.run(async () => {
      await postJson("/api/registries", form);
      setForm({ name: "", url: "", username: "", password: "", insecure: false });
      await load();
    });
  }

  async function login(registry: Registry) {
    await action.run(() =>
      runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/registries/${registry.id}/login`, {}))
    );
  }

  async function remove(registry: Registry) {
    if (!await confirm({
      title: "Delete registry",
      tone: "danger",
      confirmLabel: "Delete",
      message: `Delete registry ${registry.name} and its stored credentials?`
    })) return;
    await action.run(async () => {
      await deleteJson(`/api/registries/${registry.id}`);
      await load();
    });
  }

  return (
    <Panel title="Registries" count={registries.length}>
      <form className="composeForm" onSubmit={(event) => {
        event.preventDefault();
        void saveRegistry().catch(() => undefined);
      }}>
        <div className="two">
          <input aria-label="Registry name" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          <input aria-label="Registry URL" placeholder="Registry URL" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} required />
        </div>
        <div className="two">
          <input aria-label="Registry username" placeholder="Username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          <input aria-label="Registry password or token" placeholder="Password/token" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </div>
        <label className="checkLine"><input type="checkbox" checked={form.insecure} onChange={(event) => setForm({ ...form, insecure: event.target.checked })} /> Insecure registry</label>
        <button type="submit" className="primary" disabled={action.busy}><KeyRound size={18} />{action.busy ? "Saving..." : "Save Registry"}</button>
      </form>
      {action.error && <div className="notice error" role="alert">{action.error}</div>}
      <HostSelect hosts={hosts} value={hostId} onChange={setHostId} />
      <DataTable rows={registries} columns={["Name", "URL", "User", "Actions"]} render={(registry) => [
        registry.name,
        registry.url,
        registry.username ?? "",
        <ButtonRow key="actions">
          <button disabled={action.busy || !hostId} onClick={() => void login(registry).catch(() => undefined)}>Login</button>
          <button
            className="danger"
            title={`Delete ${registry.name}`}
            disabled={action.busy}
            onClick={() => void remove(registry).catch(() => undefined)}
          >
            <Trash2 size={16} />
          </button>
        </ButtonRow>
      ]} />
    </Panel>
  );
}
