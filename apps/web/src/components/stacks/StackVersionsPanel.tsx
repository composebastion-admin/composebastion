import { useCallback, useEffect, useState } from "react";
import { GitCompare, RotateCcw } from "lucide-react";
import type { ComposeStack, ComposeStackVersion } from "@composebastion/shared";
import { api, postJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { formatDate } from "../../lib/format.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { ButtonRow, DataTable, Panel } from "../ui/primitives.js";

type VersionDiff = {
  fromVersionNumber: number;
  toVersionNumber: number;
  composeChanges: Array<{ type: string; line: number; text: string }>;
  envChanged: boolean;
};

export function StackVersionsPanel({
  stack,
  runJob,
  refresh
}: {
  stack: ComposeStack;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [versions, setVersions] = useState<ComposeStackVersion[]>([]);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [compareFrom, setCompareFrom] = useState("");
  const [compareTo, setCompareTo] = useState("");

  const load = useCallback(async () => {
    const result = await api<{ versions: ComposeStackVersion[] }>(`/api/compose/${stack.id}/versions`);
    setVersions(result.versions);
    if (!compareFrom && result.versions[1]) setCompareFrom(result.versions[1].id);
    if (!compareTo && result.versions[0]) setCompareTo(result.versions[0].id);
  }, [stack.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function showDiff() {
    if (!compareFrom || !compareTo) return;
    const result = await api<VersionDiff>(`/api/compose/${stack.id}/versions/diff?from=${encodeURIComponent(compareFrom)}&to=${encodeURIComponent(compareTo)}`);
    setDiff(result);
  }

  async function rollback(versionId: string, versionNumber: number) {
    const ok = await confirm({
      title: "Rollback stack",
      tone: "danger",
      confirmLabel: "Rollback",
      message: `Rollback ${stack.name} to version ${versionNumber}? This deploys the previous compose file through the job queue.`
    });
    if (!ok) return;
    await action.run(async () => {
      await runJob(() => postJson<JobResult>(`/api/compose/${stack.id}/rollback`, { versionId }));
      await refresh();
      await load();
    });
  }

  return (
    <div className="subPanel">
      <div className="panelHeader">
        <h3>Versions for {stack.name}</h3>
        <small>Current v{stack.currentVersionNumber ?? "—"}</small>
      </div>
      <DataTable
        rows={versions}
        columns={["Version", "Source", "Created", "Note", "Actions"]}
        render={(version) => [
          `v${version.versionNumber}`,
          version.source,
          formatDate(version.createdAt),
          version.note ?? "",
          <ButtonRow key="actions">
            <button type="button" onClick={() => { setCompareFrom(version.id); setCompareTo(versions[0]?.id ?? version.id); }}><GitCompare size={16} /></button>
            <button type="button" className="danger" disabled={action.busy} onClick={() => void rollback(version.id, version.versionNumber)}><RotateCcw size={16} /></button>
          </ButtonRow>
        ]}
      />
      <div className="inlineForm">
        <select value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}>
          {versions.map((version) => <option key={version.id} value={version.id}>From v{version.versionNumber}</option>)}
        </select>
        <select value={compareTo} onChange={(event) => setCompareTo(event.target.value)}>
          {versions.map((version) => <option key={version.id} value={version.id}>To v{version.versionNumber}</option>)}
        </select>
        <button type="button" onClick={() => void showDiff()}><GitCompare size={16} />Diff</button>
      </div>
      {diff && (
        <Panel title={`Diff v${diff.fromVersionNumber} → v${diff.toVersionNumber}`}>
          {diff.envChanged && <div className="notice">Environment file changed between versions.</div>}
          <pre className="monoTextarea">{diff.composeChanges.map((change) => `${change.type} ${change.line}: ${change.text}`).join("\n") || "No compose changes."}</pre>
        </Panel>
      )}
      {action.error && <div className="notice error">{action.error}</div>}
    </div>
  );
}
