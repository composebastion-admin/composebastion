import { useEffect, useState } from "react";
import { Copy, Save, Wand2 } from "lucide-react";
import type { ComposeStack } from "@dockermender/shared";
import { api, postJson, putJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ButtonRow, Panel } from "../ui/primitives.js";

type ProxySnippet = {
  traefikLabels: string[];
  caddySnippet: string;
  warnings: string[];
};

export function ProxyPanel({ stack, onChanged }: { stack: ComposeStack; onChanged: () => Promise<void> }) {
  const action = useAsyncAction();
  const [domains, setDomains] = useState((stack.domains ?? []).join(", "));
  const [exposedService, setExposedService] = useState(stack.exposedService ?? "");
  const [exposedPort, setExposedPort] = useState(stack.exposedPort ? String(stack.exposedPort) : "");
  const [tlsDesired, setTlsDesired] = useState(stack.tlsDesired);
  const [updatePolicyEnabled, setUpdatePolicyEnabled] = useState(stack.updatePolicyEnabled);
  const [updatePolicyChannel, setUpdatePolicyChannel] = useState(stack.updatePolicyChannel ?? "digest");
  const [snippets, setSnippets] = useState<ProxySnippet | null>(null);

  useEffect(() => {
    setDomains((stack.domains ?? []).join(", "));
    setExposedService(stack.exposedService ?? "");
    setExposedPort(stack.exposedPort ? String(stack.exposedPort) : "");
    setTlsDesired(stack.tlsDesired);
    setUpdatePolicyEnabled(stack.updatePolicyEnabled);
    setUpdatePolicyChannel(stack.updatePolicyChannel ?? "digest");
  }, [stack]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await putJson(`/api/compose/${stack.id}/proxy`, {
        domains: domains.split(",").map((value) => value.trim()).filter(Boolean),
        exposedService: exposedService || undefined,
        exposedPort: exposedPort ? Number(exposedPort) : undefined,
        tlsDesired,
        updatePolicyEnabled,
        updatePolicyChannel: updatePolicyEnabled ? updatePolicyChannel : undefined
      });
      await onChanged();
      const result = await api<ProxySnippet>(`/api/compose/${stack.id}/proxy/snippets`);
      setSnippets(result);
    });
  }

  async function loadSnippets() {
    const result = await api<ProxySnippet>(`/api/compose/${stack.id}/proxy/snippets`);
    setSnippets(result);
  }

  async function applyTraefikLabels() {
    await action.run(async () => {
      await postJson(`/api/compose/${stack.id}/proxy/apply-labels`, {});
      await onChanged();
      await loadSnippets();
    });
  }

  return (
    <div className="subPanel composeForm">
      <div className="panelHeader">
        <h3>Proxy & update policy</h3>
        <button type="button" onClick={() => void loadSnippets()}><Copy size={16} />Preview snippets</button>
      </div>
      <form onSubmit={save}>
        <input placeholder="Domains, comma separated" value={domains} onChange={(event) => setDomains(event.target.value)} />
        <div className="two">
          <input placeholder="Exposed service" value={exposedService} onChange={(event) => setExposedService(event.target.value)} />
          <input placeholder="Exposed port" value={exposedPort} onChange={(event) => setExposedPort(event.target.value)} />
        </div>
        <label className="checkLine"><input type="checkbox" checked={tlsDesired} onChange={(event) => setTlsDesired(event.target.checked)} />TLS desired</label>
        <label className="checkLine"><input type="checkbox" checked={updatePolicyEnabled} onChange={(event) => setUpdatePolicyEnabled(event.target.checked)} />Enable optional auto-update policy (disabled by default)</label>
        {updatePolicyEnabled && (
          <select value={updatePolicyChannel} onChange={(event) => setUpdatePolicyChannel(event.target.value as "digest" | "patch" | "minor")}>
            <option value="digest">Digest pin</option>
            <option value="patch">Patch channel</option>
            <option value="minor">Minor channel</option>
          </select>
        )}
        {action.error && <div className="notice error">{action.error}</div>}
        <ButtonRow>
          <button className="primary" disabled={action.busy}><Save size={16} />Save proxy metadata</button>
          <button type="button" disabled={action.busy} onClick={() => void applyTraefikLabels()}><Wand2 size={16} />Apply Traefik labels</button>
        </ButtonRow>
      </form>
      {snippets && (
        <Panel title="Recommended proxy snippets">
          {snippets.warnings.map((warning) => <div key={warning} className="notice">{warning}</div>)}
          <strong>Traefik labels</strong>
          <pre className="monoTextarea">{snippets.traefikLabels.join("\n")}</pre>
          <strong>Caddy snippet</strong>
          <pre className="monoTextarea">{snippets.caddySnippet}</pre>
        </Panel>
      )}
    </div>
  );
}
