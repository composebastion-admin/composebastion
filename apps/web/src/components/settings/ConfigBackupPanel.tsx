import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { useConfirm } from "../ConfirmProvider.js";
import { ButtonRow } from "../ui/primitives.js";

export function ConfigBackupPanel({ onImported }: { onImported: () => Promise<void> }) {
  const action = useAsyncAction();
  const { confirm } = useConfirm();
  const [passphrase, setPassphrase] = useState("");
  const [backupText, setBackupText] = useState("");
  const [message, setMessage] = useState("");

  async function exportConfig() {
    await action.run(async () => {
      const result = await postJson<{ backup: Record<string, unknown> }>("/api/config/export", { passphrase });
      const text = JSON.stringify(result.backup, null, 2);
      setBackupText(text);
      setMessage("Config export ready");
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `composebastion-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  }

  async function importConfig() {
    if (!await confirm({
      title: "Import configuration",
      tone: "danger",
      confirmLabel: "Import configuration",
      message: "Importing replaces matching ComposeBastion configuration records and can change host access, credentials, and automation.",
      verificationText: "IMPORT",
      verificationLabel: "Type IMPORT to continue"
    })) return;
    await action.run(async () => {
      const text = backupText.trim();
      if (!text) throw new Error("Paste an encrypted config JSON export or choose a .json file before importing.");
      let backup: Record<string, unknown>;
      try {
        backup = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("Config restore JSON is invalid. Paste the full ComposeBastion export file contents.");
      }
      const result = await postJson<{ imported: Record<string, number> }>("/api/config/import", { passphrase, backup });
      setMessage(`Imported ${Object.values(result.imported).reduce((sum, value) => sum + value, 0)} records`);
      await onImported();
    });
  }

  async function loadBackupFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setBackupText(await file.text());
    setMessage(`Loaded ${file.name}`);
    event.target.value = "";
  }

  return (
    <div className="subPanel">
      <div className="panelHeader">
        <h3>Config Backup</h3>
      </div>
      <div className="two">
        <input aria-label="Backup passphrase" placeholder="Backup passphrase" type="password" minLength={12} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        <ButtonRow>
          <button type="button" disabled={action.busy || passphrase.length < 12} onClick={() => void exportConfig().catch(() => undefined)}><Download size={16} />Export</button>
          <label className="buttonLike">
            <Upload size={16} />
            Choose JSON
            <input aria-label="Choose encrypted config JSON" type="file" accept="application/json,.json" disabled={action.busy} onChange={(event) => void loadBackupFile(event).catch(() => undefined)} />
          </label>
          <button type="button" disabled={action.busy || passphrase.length < 12} onClick={() => void importConfig().catch(() => undefined)}><Upload size={16} />Import</button>
        </ButtonRow>
      </div>
      <textarea aria-label="Encrypted config JSON" className="monoTextarea" placeholder="Encrypted config JSON" value={backupText} onChange={(event) => setBackupText(event.target.value)} />
      {message && <div className="notice success" role="status">{message}</div>}
      {action.error && <div className="notice error" role="alert">{action.error}</div>}
    </div>
  );
}
