import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { BackupTarget, DockerApp, DockerHost, RecoverySchedule } from "@dockermender/shared";
import { deleteJson, postJson } from "../../../api.js";
import { useAsyncAction } from "../../../hooks/useAsyncAction.js";
import { formatDate } from "../../../lib/format.js";
import { hostName } from "../../../lib/hostScope.js";
import { dockerAppToRecoveryIdentity } from "../../../lib/recovery.js";
import { HostSelect } from "../../dashboard/HostSelect.js";
import { useConfirm } from "../../ConfirmProvider.js";
import { DataTable, InlineForm, Panel, StatusPill } from "../../ui/primitives.js";

export function RecoverySchedulesPanel({
  hosts,
  apps,
  targets,
  schedules,
  refresh
}: {
  hosts: DockerHost[];
  apps: DockerApp[];
  targets: BackupTarget[];
  schedules: RecoverySchedule[];
  refresh: () => Promise<void>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [form, setForm] = useState({
    hostId: hosts[0]?.id ?? "",
    appId: apps[0]?.id ?? "",
    name: "",
    backupTargetId: "",
    intervalHours: 24,
    retentionCount: 7,
    captureMode: "hot" as "hot" | "stop-first",
    enabled: true
  });

  const hostApps = useMemo(
    () => apps.filter((app) => app.hostId === form.hostId),
    [apps, form.hostId]
  );
  const selectedApp = apps.find((app) => app.id === form.appId) ?? hostApps[0] ?? null;

  return (
    <Panel title="Recovery Schedules" count={schedules.length}>
      <InlineForm
        onSubmit={async () => {
          if (!selectedApp || !form.name.trim()) throw new Error("Schedule name and app are required");
          await action.run(async () => {
            await postJson("/api/recovery/schedules", {
              hostId: selectedApp.hostId,
              name: form.name.trim(),
              appIdentity: dockerAppToRecoveryIdentity(selectedApp),
              backupTargetId: form.backupTargetId || undefined,
              intervalMs: form.intervalHours * 60 * 60 * 1000,
              retentionCount: form.retentionCount,
              captureMode: form.captureMode === "stop-first" ? "stop_first" : "hot",
              enabled: form.enabled
            });
            setForm((current) => ({ ...current, name: "" }));
            await refresh();
          });
        }}
      >
        <strong>Create schedule</strong>
        <input placeholder="Schedule name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
        <HostSelect hosts={hosts} value={form.hostId} onChange={(hostId) => setForm((current) => ({
          ...current,
          hostId,
          appId: apps.find((app) => app.hostId === hostId)?.id ?? ""
        }))} />
        <select value={form.appId} onChange={(event) => setForm((current) => ({ ...current, appId: event.target.value }))} required>
          <option value="">App</option>
          {hostApps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
        </select>
        <select value={form.backupTargetId} onChange={(event) => setForm((current) => ({ ...current, backupTargetId: event.target.value }))}>
          <option value="">Local only</option>
          {targets.filter((target) => target.enabled).map((target) => (
            <option key={target.id} value={target.id}>{target.name}</option>
          ))}
        </select>
        <select value={form.intervalHours} onChange={(event) => setForm((current) => ({ ...current, intervalHours: Number(event.target.value) }))}>
          <option value={6}>Every 6 hours</option>
          <option value={12}>Every 12 hours</option>
          <option value={24}>Every 24 hours</option>
          <option value={168}>Every week</option>
        </select>
        <input
          type="number"
          min={1}
          max={365}
          value={form.retentionCount}
          onChange={(event) => setForm((current) => ({ ...current, retentionCount: Number(event.target.value) }))}
          title="Retention count"
        />
        <label className="checkLine">
          <input
            type="radio"
            name="schedule-capture-mode"
            checked={form.captureMode === "hot"}
            onChange={() => setForm((current) => ({ ...current, captureMode: "hot" }))}
          />
          Hot capture (app stays running)
        </label>
        <label className="checkLine">
          <input
            type="radio"
            name="schedule-capture-mode"
            checked={form.captureMode === "stop-first"}
            onChange={() => setForm((current) => ({ ...current, captureMode: "stop-first" }))}
          />
          Stop-first (quiesce app before capture)
        </label>
        <label className="checkLine">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
          Enabled
        </label>
        <button type="submit" className="primary" disabled={action.busy || !selectedApp}>
          <Plus size={16} />
          Add schedule
        </button>
      </InlineForm>

      {action.error && <div className="notice error">{action.error}</div>}

      <DataTable
        rows={schedules}
        columns={["Name", "Host", "Interval", "Capture", "Retention", "Next run", "Drill", "Enabled", ""]}
        render={(schedule) => [
          schedule.name,
          hostName(hosts, schedule.hostId),
          `${Math.round(schedule.intervalMs / 3_600_000)}h`,
          schedule.captureMode === "stop_first" ? "stop-first" : "hot",
          schedule.retentionCount ?? "—",
          formatDate(schedule.nextRunAt),
          <div key="drill" className="alertRuleState">
            {schedule.lastDrillStatus && <StatusPill status={schedule.lastDrillStatus} />}
            <small>{schedule.lastSuccessfulDrillAt ? `Passed ${formatDate(schedule.lastSuccessfulDrillAt)}` : schedule.lastDrillError ?? "No drill yet"}</small>
          </div>,
          schedule.enabled ? "yes" : "no",
          <button
            key="delete"
            type="button"
            className="danger"
            onClick={() => void (async () => {
              const ok = await confirm({
                title: "Delete schedule",
                tone: "danger",
                confirmLabel: "Delete",
                message: `Delete recovery schedule ${schedule.name}?`
              });
              if (!ok) return;
              await deleteJson(`/api/recovery/schedules/${schedule.id}`);
              await refresh();
            })()}
          >
            <Trash2 size={16} />
          </button>
        ]}
      />
    </Panel>
  );
}
