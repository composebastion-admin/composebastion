import { Panel } from "../ui/primitives.js";
import { ConfigBackupPanel } from "./ConfigBackupPanel.js";

export function GlobalSettingsPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  return (
    <Panel title="Settings">
      <div className="formHint">Restore a ComposeBastion config before adding hosts. Imported hosts, tracked repos, registries, alerts, and Compose stacks will appear after import.</div>
      <ConfigBackupPanel onImported={onChanged} />
    </Panel>
  );
}
