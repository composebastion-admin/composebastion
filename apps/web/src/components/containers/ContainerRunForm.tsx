import { useEffect, useState } from "react";
import { Play, Plus } from "lucide-react";
import type { DockerHost, ResourceSnapshot } from "@composebastion/shared";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";

export function ContainerRunForm({
  host,
  networks,
  onCreateNetwork,
  onRun,
  imagePreset,
  buttonLabel = "Create Container",
  hint
}: {
  host: DockerHost;
  networks: ResourceSnapshot[];
  onCreateNetwork: (payload: Record<string, unknown>) => Promise<void>;
  onRun: (payload: Record<string, unknown>) => Promise<void>;
  imagePreset?: { image: string; nonce: number } | null;
  buttonLabel?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    image: "",
    name: "",
    restartPolicy: "unless-stopped",
    ports: "",
    env: "",
    volumes: "",
    network: "",
    networkMode: "existing",
    newNetworkName: "",
    newNetworkDriver: "bridge",
    command: ""
  });
  const action = useAsyncAction();
  const networkOptions = networks
    .map((network) => String((network.data as any).Name ?? network.name))
    .filter((name, index, all) => name && all.indexOf(name) === index)
    .sort((a, b) => a.localeCompare(b));

  useEffect(() => {
    if (!imagePreset?.image) return;
    setOpen(true);
    setForm((current) => ({ ...current, image: imagePreset.image }));
  }, [imagePreset?.nonce, imagePreset?.image]);

  function parseLines(value: string, mapper: (line: string) => unknown) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(mapper);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      const network = form.networkMode === "new" ? form.newNetworkName.trim() : form.networkMode === "existing" ? form.network : "";
      if (form.networkMode === "new") {
        await onCreateNetwork({
          name: network,
          driver: form.newNetworkDriver,
          labels: {}
        });
      }
      await onRun({
        image: form.image,
        name: form.name || undefined,
        restartPolicy: form.restartPolicy,
        ports: parseLines(form.ports, (line) => {
          const [hostPort, rest] = line.split(":");
          const [containerPort, protocol = "tcp"] = (rest ?? "").split("/");
          return { hostPort: Number(hostPort), containerPort: Number(containerPort), protocol };
        }),
        env: parseLines(form.env, (line) => {
          const index = line.indexOf("=");
          return { key: line.slice(0, index), value: line.slice(index + 1) };
        }),
        volumes: parseLines(form.volumes, (line) => {
          const [volumeName, containerPath, mode] = line.split(":");
          return { volumeName, containerPath, readOnly: mode === "ro" };
        }),
        network: network || undefined,
        command: form.command || undefined
      });
    });
  }

  return (
    <div className="subPanel">
      <button onClick={() => setOpen((value) => !value)}><Plus size={18} />{buttonLabel}</button>
      {open && (
        <form className="composeForm" onSubmit={submit}>
          <div className="formHint">{hint ?? `New containers are created on ${host.name}. Select a host in the sidebar first to run it somewhere else.`}</div>
          <div className="two">
            <input placeholder="Image, e.g. nginx:alpine" value={form.image} onChange={(event) => setForm({ ...form, image: event.target.value })} required />
            <input placeholder="Container name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="two">
            <select value={form.restartPolicy} onChange={(event) => setForm({ ...form, restartPolicy: event.target.value })}>
              <option value="unless-stopped">unless-stopped</option>
              <option value="always">always</option>
              <option value="on-failure">on-failure</option>
              <option value="no">no restart</option>
            </select>
            <select value={form.networkMode} onChange={(event) => setForm({ ...form, networkMode: event.target.value })}>
              <option value="existing">Use existing network</option>
              <option value="new">Create new network</option>
              <option value="default">Docker default</option>
            </select>
          </div>
          {form.networkMode === "existing" && (
            <select value={form.network} onChange={(event) => setForm({ ...form, network: event.target.value })}>
              <option value="">Docker default bridge</option>
              {networkOptions.map((network) => <option key={network} value={network}>{network}</option>)}
            </select>
          )}
          {form.networkMode === "new" && (
            <div className="two">
              <input placeholder="New network name" value={form.newNetworkName} onChange={(event) => setForm({ ...form, newNetworkName: event.target.value })} required />
              <select value={form.newNetworkDriver} onChange={(event) => setForm({ ...form, newNetworkDriver: event.target.value })}>
                <option value="bridge">bridge</option>
                <option value="overlay">overlay</option>
                <option value="macvlan">macvlan</option>
                <option value="ipvlan">ipvlan</option>
              </select>
            </div>
          )}
          <textarea placeholder={"Ports, one per line: 8080:80/tcp"} value={form.ports} onChange={(event) => setForm({ ...form, ports: event.target.value })} />
          <textarea placeholder={"Environment, one per line: KEY=value"} value={form.env} onChange={(event) => setForm({ ...form, env: event.target.value })} />
          <textarea placeholder={"Volumes, one per line: volume:/path[:ro]"} value={form.volumes} onChange={(event) => setForm({ ...form, volumes: event.target.value })} />
          <input placeholder="Optional command" value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} />
          {action.error && <div className="notice error">{action.error}</div>}
          <button className="primary" disabled={action.busy}><Play size={18} />Run</button>
        </form>
      )}
    </div>
  );
}
