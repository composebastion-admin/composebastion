import { useState } from "react";
import { Plus, Server } from "lucide-react";
import type { DockerHost, OperationJob } from "@dockermender/shared";
import { postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { hostFormPayload } from "../../lib/hostScope.js";
import type { Jobish } from "../../lib/dashboardTypes.js";

type HostConnectionMode = "ssh" | "agent";

export function HostForm({
  onCreated,
  runJob,
  defaultConnectionMode = "ssh",
  allowedConnectionModes = ["ssh", "agent"],
  intro = "Add a real SSH/agent host, or load the built-in demo workspace to explore Dockermender without a server.",
  showDemoWorkspace = true,
  submitLabel = "Save"
}: {
  onCreated: () => void;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  defaultConnectionMode?: HostConnectionMode;
  allowedConnectionModes?: HostConnectionMode[];
  intro?: string;
  showDemoWorkspace?: boolean;
  submitLabel?: string;
}) {
  const action = useAsyncAction();
  const [form, setForm] = useState({
    name: "",
    hostname: "",
    port: 22,
    username: "",
    connectionMode: defaultConnectionMode,
    sshAuthType: "password",
    sshPrivateKey: "",
    sshKeyPassphrase: "",
    sshPassword: "",
    agentUrl: "",
    agentToken: "",
    dockerSocketPath: "/var/run/docker.sock"
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    let created = false;
    await action.run(async () => {
      try {
        await runJob(async () => {
          const result = await postJson<{ host: DockerHost; job: OperationJob }>("/api/hosts", hostFormPayload(form));
          created = true;
          return result;
        });
      } catch (caught) {
        if (!created) throw caught;
      }
    });
    if (created) {
      onCreated();
    }
  }

  async function addDemoWorkspace() {
    await action.run(async () => {
      await postJson<{ host: DockerHost; seeded: boolean }>("/api/demo/seed", {});
      onCreated();
    });
  }

  return (
    <form className="hostForm" onSubmit={submit}>
      <div className="formHint">{intro}</div>
      {showDemoWorkspace && (
        <button type="button" onClick={() => void addDemoWorkspace()} disabled={action.busy}>
          <Server size={18} />
          Load Demo Workspace
        </button>
      )}
      <input placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
      {allowedConnectionModes.length > 1 ? (
        <select value={form.connectionMode} onChange={(event) => setForm({ ...form, connectionMode: event.target.value as HostConnectionMode })}>
          {allowedConnectionModes.includes("ssh") && <option value="ssh">SSH executor</option>}
          {allowedConnectionModes.includes("agent") && <option value="agent">Host agent</option>}
        </select>
      ) : (
        <div className="formHint compact">SSH executor</div>
      )}
      <input placeholder="Hostname or IP" value={form.hostname} onChange={(event) => setForm({ ...form, hostname: event.target.value })} required />
      <div className="two">
        <input type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} />
        <input placeholder="SSH user" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required />
      </div>
      <input value={form.dockerSocketPath} onChange={(event) => setForm({ ...form, dockerSocketPath: event.target.value })} />
      {form.connectionMode === "ssh" ? (
        <>
          <select value={form.sshAuthType} onChange={(event) => setForm({ ...form, sshAuthType: event.target.value })}>
            <option value="password">SSH password</option>
            <option value="key">SSH private key</option>
          </select>
          {form.sshAuthType === "password" ? (
            <input placeholder="SSH login password" type="password" value={form.sshPassword} onChange={(event) => setForm({ ...form, sshPassword: event.target.value })} required />
          ) : (
            <>
              <textarea placeholder="SSH private key" value={form.sshPrivateKey} onChange={(event) => setForm({ ...form, sshPrivateKey: event.target.value })} required />
              <input placeholder="Key passphrase, if the private key has one" type="password" value={form.sshKeyPassphrase} onChange={(event) => setForm({ ...form, sshKeyPassphrase: event.target.value })} />
            </>
          )}
        </>
      ) : (
        <>
          <input placeholder="Agent URL, e.g. http://host:8090" value={form.agentUrl} onChange={(event) => setForm({ ...form, agentUrl: event.target.value })} required />
          <input placeholder="Agent token" type="password" value={form.agentToken} onChange={(event) => setForm({ ...form, agentToken: event.target.value })} required />
        </>
      )}
      {action.error && <div className="notice error">{action.error}</div>}
      <button className="primary" type="submit" disabled={action.busy}>
        <Plus size={18} />
        {submitLabel}
      </button>
    </form>
  );
}
