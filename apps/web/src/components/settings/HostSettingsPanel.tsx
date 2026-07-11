import { useEffect, useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import type { DockerHost } from "@composebastion/shared";
import { deleteJson, putJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { describeAgentCompatibility } from "../../lib/agentCompatibility.js";
import { hostFormPayload } from "../../lib/hostScope.js";
import { ButtonRow, Panel } from "../ui/primitives.js";
import { ConfigBackupPanel } from "./ConfigBackupPanel.js";
import { useAuthorization } from "../AuthorizationContext.js";

export function HostSettingsPanel({ host, onChanged }: { host: DockerHost; onChanged: () => Promise<void> }) {
  const { canAdminister } = useAuthorization();
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const agentCompatibility = describeAgentCompatibility(host.agentVersion);
  const [form, setForm] = useState({
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    connectionMode: host.connectionMode,
    sshAuthType: host.sshAuthType,
    agentUrl: host.agentUrl ?? "",
    dockerSocketPath: host.dockerSocketPath,
    sshPrivateKey: "",
    sshKeyPassphrase: "",
    sshPassword: "",
    agentToken: "",
    tags: host.tags.join(", ")
  });

  useEffect(() => {
    setForm({
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      connectionMode: host.connectionMode,
      sshAuthType: host.sshAuthType,
      agentUrl: host.agentUrl ?? "",
      dockerSocketPath: host.dockerSocketPath,
      sshPrivateKey: "",
      sshKeyPassphrase: "",
      sshPassword: "",
      agentToken: "",
      tags: host.tags.join(", ")
    });
  }, [host]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await putJson(`/api/hosts/${host.id}`, hostFormPayload(form));
      await onChanged();
    });
  }

  async function remove() {
    const confirmed = await confirm({
      title: "Delete host",
      tone: "danger",
      confirmLabel: "Delete host",
      message: `Delete ${host.name} from ComposeBastion? This removes saved inventory, stacks, alerts, and backup records for this host, but it does not remove containers from the server.`
    });
    if (!confirmed) return;
    await action.run(async () => {
      await deleteJson(`/api/hosts/${host.id}`);
      await onChanged();
    });
  }

  return (
    <Panel title="Host Settings">
      {host.connectionMode === "agent" && (
        <div className={`notice ${agentCompatibility.status === "compatible" ? "" : "warning"}`}>
          Agent compatibility: {agentCompatibility.label}
        </div>
      )}
      <form className="composeForm" onSubmit={save}>
        <div className="two">
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          <select value={form.connectionMode} onChange={(event) => setForm({ ...form, connectionMode: event.target.value as DockerHost["connectionMode"] })}>
            <option value="ssh">SSH executor</option>
            <option value="agent">Host agent</option>
          </select>
        </div>
        <div className="two">
          <input value={form.hostname} onChange={(event) => setForm({ ...form, hostname: event.target.value })} required />
          <input type="number" min={1} max={65535} value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} />
        </div>
        <div className="two">
          <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          <input value={form.dockerSocketPath} onChange={(event) => setForm({ ...form, dockerSocketPath: event.target.value })} />
        </div>
        <input placeholder="Tags, comma separated" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
        {form.connectionMode === "ssh" ? (
          <>
            <select value={form.sshAuthType} onChange={(event) => setForm({ ...form, sshAuthType: event.target.value as DockerHost["sshAuthType"] })}>
              <option value="password">SSH password</option>
              <option value="key">SSH private key</option>
            </select>
            {form.sshAuthType === "password" ? (
              <input placeholder="Replace SSH login password" type="password" value={form.sshPassword} onChange={(event) => setForm({ ...form, sshPassword: event.target.value })} />
            ) : (
              <div className="two">
                <textarea placeholder="Replace SSH private key" value={form.sshPrivateKey} onChange={(event) => setForm({ ...form, sshPrivateKey: event.target.value })} />
                <input placeholder="Replace key passphrase" type="password" value={form.sshKeyPassphrase} onChange={(event) => setForm({ ...form, sshKeyPassphrase: event.target.value })} />
              </div>
            )}
          </>
        ) : (
          <div className="two">
            <input placeholder="Agent URL" value={form.agentUrl} onChange={(event) => setForm({ ...form, agentUrl: event.target.value })} />
            <input placeholder="Replace agent token" type="password" value={form.agentToken} onChange={(event) => setForm({ ...form, agentToken: event.target.value })} />
          </div>
        )}
        {action.error && <div className="notice error">{action.error}</div>}
        <ButtonRow>
          <button className="primary" disabled={action.busy}><Settings size={18} />{action.busy ? "Saving..." : "Save Host"}</button>
          <button type="button" className="danger" disabled={action.busy} onClick={() => void remove()}><Trash2 size={18} />Delete Host</button>
        </ButtonRow>
      </form>
      {canAdminister && <ConfigBackupPanel onImported={onChanged} />}
    </Panel>
  );
}
