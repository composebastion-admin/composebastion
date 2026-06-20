import { useState, type ReactNode } from "react";
import { History, Play, Plus, Square, Trash2, X } from "lucide-react";
import type { ComposeStack, DockerHost } from "@dockermender/shared";
import { deleteJson, postJson } from "../../api.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { formatDate } from "../../lib/format.js";
import { emptyCompose } from "../../lib/navigation.js";
import { hostName, normalizeComposeProjectName } from "../../lib/hostScope.js";
import { ButtonRow, DataTable, Panel, StatusPill } from "../ui/primitives.js";
import { ProxyPanel } from "../stacks/ProxyPanel.js";
import { StackVersionsPanel } from "../stacks/StackVersionsPanel.js";

function sourceTypeLabel(sourceType?: string) {
  if (sourceType === "git" || sourceType === "github") return "Git";
  if (sourceType === "host_files") return "Host folder";
  if (sourceType === "external") return "Discovered";
  if (sourceType === "catalog") return "Catalog";
  return "UI";
}

export function ComposePanel({ host, hosts, stacks, refresh, runJob }: { host: DockerHost; hosts: DockerHost[]; stacks: ComposeStack[]; refresh: () => Promise<void>; runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T> }) {
  const { confirm } = useConfirm();
  const [form, setForm] = useState({ name: "", projectName: "", composeYaml: emptyCompose, env: "" });
  const [focusedStackId, setFocusedStackId] = useState<string | null>(null);
  const focusedStack = stacks.find((stack) => stack.id === focusedStackId) ?? null;
  const action = useAsyncAction();
  const showHostColumn = new Set(stacks.map((stack) => stack.hostId)).size > 1;

  async function createStack(event: React.FormEvent) {
    event.preventDefault();
    await action.run(async () => {
      await postJson(`/api/hosts/${host.id}/compose`, form);
      setForm({ name: "", projectName: "", composeYaml: emptyCompose, env: "" });
      await refresh();
    });
  }

  async function stackAction(stackId: string, verb: "deploy" | "stop" | "remove", stackName?: string) {
    if (verb === "remove" && !await confirm({
      title: "Remove compose stack",
      tone: "danger",
      confirmLabel: "Remove",
      message: `Remove stack "${stackName ?? stackId}" from Docker on this host?`
    })) return;
    await action.run(async () => {
      await runJob(() => postJson<JobResult>(`/api/compose/${stackId}/${verb}`, verb === "remove" ? { removeVolumes: false } : {}));
    });
  }

  async function forgetStack(stack: ComposeStack) {
    if (!await confirm({
      title: "Forget stack",
      tone: "danger",
      confirmLabel: "Forget",
      message: `Forget stack "${stack.name}"? This only removes the Dockermender record.`
    })) return;
    await action.run(async () => {
      await deleteJson(`/api/compose/${stack.id}`);
      await refresh();
    });
  }

  return (
    <Panel title="Compose Stacks" count={stacks.length}>
      <form className="composeForm" onSubmit={createStack}>
        <div className="formHint">New stacks are saved on {host.name}. Use the fleet selector above to view stacks from multiple hosts.</div>
        <div className="two">
          <input placeholder="Stack name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          <input placeholder="Project name, lowercase" value={form.projectName} onChange={(event) => setForm({ ...form, projectName: normalizeComposeProjectName(event.target.value) })} required />
        </div>
        <textarea value={form.composeYaml} onChange={(event) => setForm({ ...form, composeYaml: event.target.value })} required />
        <textarea placeholder="Optional .env content" value={form.env} onChange={(event) => setForm({ ...form, env: event.target.value })} />
        {action.error && <div className="notice error">{action.error}</div>}
        <button className="primary"><Plus size={18} />Save Stack</button>
      </form>
      <DataTable
        rows={stacks}
        columns={showHostColumn ? ["Host", "Name", "Project", "Source", "Status", "Updated", "Actions"] : ["Name", "Project", "Source", "Status", "Updated", "Actions"]}
        render={(stack) => {
          const cells: ReactNode[] = [
            stack.name,
            stack.projectName,
            <span key="source" className="stackSourceCell" title={stack.sourceWorkingDir ?? undefined}>
              {sourceTypeLabel(stack.sourceType)}
              {stack.sourceWorkingDir && <small className="monoText">{stack.sourceWorkingDir}</small>}
            </span>,
            <span key="status" className="stackStatusCell">
              <StatusPill status={stack.status} />
              {stack.lastDeployError && <small className="stackErrorNote" title={stack.lastDeployError}>{stack.lastDeployError}</small>}
            </span>,
            formatDate(stack.updatedAt),
            <ButtonRow key="actions">
              <button title="Versions & proxy" onClick={() => setFocusedStackId(stack.id)}><History size={16} /></button>
              <button title="Deploy" onClick={() => void stackAction(stack.id, "deploy")}><Play size={16} /></button>
              <button title="Stop" onClick={() => void stackAction(stack.id, "stop")}><Square size={16} /></button>
              <button title="Remove from Docker" className="danger" onClick={() => void stackAction(stack.id, "remove", stack.name)}><Trash2 size={16} /></button>
              <button title="Forget record only" onClick={() => void forgetStack(stack)}><X size={16} /></button>
            </ButtonRow>
          ];
          return showHostColumn ? [hostName(hosts, stack.hostId), ...cells] : cells;
        }}
      />
      {focusedStack && (
        <>
          <StackVersionsPanel stack={focusedStack} runJob={runJob} refresh={refresh} />
          <ProxyPanel stack={focusedStack} onChanged={refresh} />
          <ButtonRow>
            <button type="button" onClick={() => setFocusedStackId(null)}><X size={16} />Close stack details</button>
          </ButtonRow>
        </>
      )}
    </Panel>
  );
}
