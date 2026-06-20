import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ButtonRow } from "../ui/primitives.js";

export function ConfigBackupPanel({ onImported }: { onImported: () => Promise<void> }) {
  const action = useAsyncAction();
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
      anchor.download = `dockermender-config-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  async function importConfig() {
    await action.run(async () => {
      const text = backupText.trim();
      if (!text) throw new Error("Paste an encrypted config JSON export or choose a .json file before importing.");
      let backup: Record<string, unknown>;
      try {
        backup = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error("Config restore JSON is invalid. Paste the full Dockermender export file contents.");
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
        <input placeholder="Backup passphrase" type="password" minLength={12} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        <ButtonRow>
          <button type="button" onClick={() => void exportConfig()}><Download size={16} />Export</button>
          <label className="buttonLike">
            <Upload size={16} />
            Choose JSON
            <input type="file" accept="application/json,.json" onChange={(event) => void loadBackupFile(event)} />
          </label>
          <button type="button" onClick={() => void importConfig()}><Upload size={16} />Import</button>
        </ButtonRow>
      </div>
      <textarea className="monoTextarea" placeholder="Encrypted config JSON" value={backupText} onChange={(event) => setBackupText(event.target.value)} />
      {message && <div className="notice success">{message}</div>}
      {action.error && <div className="notice error">{action.error}</div>}
    </div>
  );
}
