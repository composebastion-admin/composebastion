import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, FileArchive, FlaskConical, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import type {
  Backup,
  BackupHealthSummary,
  BackupSchedule,
  BackupTarget,
  DockerHost,
  OperationJob,
  RecoveryPointListItem
} from "@composebastion/shared";
import { api, deleteJson, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { formatBytes, formatDate } from "../../lib/format.js";
import { hostName, jobLabel } from "../../lib/hostScope.js";
import { ButtonRow, CardSection, DataTable, Field, Panel, StatusPill } from "../ui/primitives.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { useConfirm } from "../ConfirmProvider.js";
import { useAuthorization } from "../AuthorizationContext.js";

type BackupKindFilter = "all" | "volume" | "host_path" | "recovery_point";
type CreateKind = "volume" | "host_path";
type BackupEncryption = Backup["encryption"];

const BACKUP_PAGE_SIZE = 50;

type BackupListResponse = {
  backups?: Backup[];
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
};

type UnifiedBackupRow =
  | { id: string; rowKind: "backup"; backup: Backup }
  | { id: string; rowKind: "recovery_point"; point: RecoveryPointListItem };

type RestoreState = {
  hostId: string;
  target: string;
  overwrite?: boolean;
};

function backupTitle(backup: Backup) {
  return backup.kind === "host_path" ? backup.sourcePath ?? "Host path" : backup.volumeName ?? "Volume";
}

function backupTypeLabel(backup: Backup) {
  return backup.kind === "host_path" ? "Host path" : "Volume";
}

function scheduleTitle(schedule: BackupSchedule) {
  return schedule.kind === "host_path" ? schedule.sourcePath ?? "Host path" : schedule.volumeName ?? "Volume";
}

function recoveryPointLabel(point: RecoveryPointListItem) {
  const label = point.name ?? point.appIdentity.label;
  if (label) return label;
  if (point.appIdentity.kind === "compose") return point.appIdentity.projectName;
  if (point.appIdentity.kind === "stack") return point.appIdentity.projectName ?? point.appIdentity.stackId;
  if (point.appIdentity.kind === "git") return point.appIdentity.projectName ?? point.appIdentity.repositoryId;
  return point.appIdentity.containerIds.join(", ");
}

function targetLabel(targets: BackupTarget[], id: string | null | undefined) {
  if (!id) return "Local";
  return targets.find((target) => target.id === id)?.name ?? "Remote";
}

function healthPillClass(status: "healthy" | "warning" | "critical") {
  if (status === "healthy") return "completed";
  if (status === "warning") return "partial";
  return "failed";
}

function healthLabel(status: "healthy" | "warning" | "critical") {
  if (status === "healthy") return "Healthy";
  if (status === "warning") return "Needs proof";
  return "Attention";
}

type BackupAttentionItem = BackupHealthSummary["attention"][number];

function attentionReasonLabel(reason: BackupAttentionItem["reason"]) {
  switch (reason) {
    case "failed":
      return "Backup failed";
    case "partial":
      return "Remote incomplete";
    case "never_verified":
      return "Never verified";
    case "stale_verified":
      return "Verify stale";
    case "never_drilled":
      return "No drill";
    case "stale_drilled":
      return "Drill stale";
  }
}

function formatAge(ms: number | null) {
  if (ms === null) return "No successful backups";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

function arrayOrEmpty<T>(value: T[] | undefined | null) {
  return Array.isArray(value) ? value : [];
}

export function BackupsPanel({
  hosts,
  backups,
  jobs = [],
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  backups: Backup[];
  jobs?: OperationJob[];
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const { canOperate } = useAuthorization();
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [restore, setRestore] = useState<Record<string, RestoreState>>({});
  const [pagedBackups, setPagedBackups] = useState<Backup[]>(backups);
  const [backupPage, setBackupPage] = useState({
    total: backups.length,
    limit: BACKUP_PAGE_SIZE,
    offset: 0,
    hasMore: false
  });
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupPageError, setBackupPageError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<BackupSchedule[]>([]);
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [points, setPoints] = useState<RecoveryPointListItem[]>([]);
  const [health, setHealth] = useState<BackupHealthSummary | null>(null);
  const [filters, setFilters] = useState<{ hostId: string; kind: BackupKindFilter }>({ hostId: "all", kind: "all" });
  const [createForm, setCreateForm] = useState({
    kind: "volume" as CreateKind,
    hostId: hosts[0]?.id ?? "",
    volumeName: "",
    sourcePath: "",
    backupTargetId: "",
    encryption: "none" as BackupEncryption
  });
  const [scheduleForm, setScheduleForm] = useState({
    kind: "volume" as CreateKind,
    hostId: hosts[0]?.id ?? "",
    volumeName: "",
    sourcePath: "",
    intervalHours: 24,
    retentionCount: 7,
    backupTargetId: "",
    encryption: "none" as BackupEncryption
  });

  const remoteTargets = useMemo(
    () => targets.filter((target) => target.enabled && (target.kind === "s3" || target.kind === "rclone")),
    [targets]
  );

  const loadAuxiliaryData = useCallback(async () => {
    const [scheduleResult, targetResult, pointResult, healthResult] = await Promise.allSettled([
      canOperate
        ? api<{ schedules: BackupSchedule[] }>("/api/backup-schedules")
        : Promise.resolve({ schedules: [] as BackupSchedule[] }),
      api<{ targets: BackupTarget[] }>("/api/recovery/targets"),
      api<{ points: RecoveryPointListItem[] }>("/api/recovery/points"),
      api<{ health: BackupHealthSummary }>("/api/backups/health")
    ]);
    if (scheduleResult.status === "fulfilled") setSchedules(arrayOrEmpty(scheduleResult.value.schedules));
    if (targetResult.status === "fulfilled") setTargets(arrayOrEmpty(targetResult.value.targets));
    if (pointResult.status === "fulfilled") setPoints(arrayOrEmpty(pointResult.value.points));
    if (healthResult.status === "fulfilled") {
      const healthSummary = healthResult.value.health;
      setHealth(healthSummary ? { ...healthSummary, hosts: arrayOrEmpty(healthSummary.hosts) } : null);
    }
  }, [canOperate]);

  useEffect(() => {
    void loadAuxiliaryData();
  }, [loadAuxiliaryData]);

  useEffect(() => {
    setPagedBackups(backups);
    setBackupPage((current) => ({
      ...current,
      total: Math.max(current.total, backups.length),
      hasMore: current.hasMore && backups.length < current.total
    }));
  }, [backups]);

  useEffect(() => {
    if (!createForm.hostId && hosts[0]) setCreateForm((current) => ({ ...current, hostId: hosts[0]!.id }));
    if (!scheduleForm.hostId && hosts[0]) setScheduleForm((current) => ({ ...current, hostId: hosts[0]!.id }));
  }, [createForm.hostId, hosts, scheduleForm.hostId]);

  const loadBackupPage = useCallback(async (offset = 0) => {
    if (filters.kind === "recovery_point") {
      setPagedBackups([]);
      setBackupPage({ total: 0, limit: BACKUP_PAGE_SIZE, offset: 0, hasMore: false });
      return;
    }
    setBackupsLoading(true);
    setBackupPageError(null);
    try {
      const params = new URLSearchParams({
        limit: String(BACKUP_PAGE_SIZE),
        offset: String(offset)
      });
      if (filters.hostId !== "all") params.set("hostId", filters.hostId);
      if (filters.kind === "volume" || filters.kind === "host_path") params.set("kind", filters.kind);
      const page = await api<BackupListResponse>(`/api/backups?${params.toString()}`);
      const pageBackups = Array.isArray(page.backups) ? page.backups : [];
      const pageTotal = typeof page.total === "number" ? page.total : offset + pageBackups.length;
      setPagedBackups((current) => {
        if (offset === 0) return pageBackups;
        const seen = new Set(current.map((backup) => backup.id));
        return [...current, ...pageBackups.filter((backup) => !seen.has(backup.id))];
      });
      setBackupPage({
        total: pageTotal,
        limit: page.limit ?? BACKUP_PAGE_SIZE,
        offset: page.offset ?? offset,
        hasMore: page.hasMore ?? offset + pageBackups.length < pageTotal
      });
    } catch (error) {
      setBackupPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setBackupsLoading(false);
    }
  }, [filters.hostId, filters.kind]);

  useEffect(() => {
    void loadBackupPage(0);
  }, [loadBackupPage]);

  const rows = useMemo<UnifiedBackupRow[]>(() => {
    const backupRows = pagedBackups
      .filter((backup) => filters.hostId === "all" || backup.hostId === filters.hostId)
      .filter((backup) => filters.kind === "all" || filters.kind === backup.kind)
      .map((backup) => ({ id: backup.id, rowKind: "backup" as const, backup }));
    const recoveryRows = points
      .filter((point) => filters.hostId === "all" || point.hostId === filters.hostId)
      .filter(() => filters.kind === "all" || filters.kind === "recovery_point")
      .map((point) => ({ id: `recovery-${point.id}`, rowKind: "recovery_point" as const, point }));
    return [...backupRows, ...recoveryRows];
  }, [pagedBackups, filters.hostId, filters.kind, points]);

  const panelCount = useMemo(() => {
    const recoveryCount = points
      .filter((point) => filters.hostId === "all" || point.hostId === filters.hostId)
      .filter(() => filters.kind === "all" || filters.kind === "recovery_point")
      .length;
    return backupPage.total + recoveryCount;
  }, [backupPage.total, filters.hostId, filters.kind, points]);

  const activeBackupJobs = jobs.filter((job) =>
    (job.status === "queued" || job.status === "running")
    && ["volume.backup", "volume.restore", "hostPath.backup", "hostPath.restore", "backup.verify", "backup.drill"].includes(job.type)
  );

  const healthHighlights = useMemo(
    () => health?.hosts
      .filter((host) => host.status !== "healthy")
      .slice(0, 4) ?? [],
    [health]
  );
  const attentionItems = useMemo(() => health?.attention?.slice(0, 6) ?? [], [health]);

  async function createBackup() {
    await action.run(async () => {
      if (createForm.kind === "volume") {
        await runJob(() => postJson<JobResult>("/api/backups", {
          hostId: createForm.hostId,
          volumeName: createForm.volumeName,
          backupTargetId: createForm.backupTargetId || undefined,
          encryption: createForm.encryption
        }));
        setCreateForm((current) => ({ ...current, volumeName: "" }));
      } else {
        await runJob(() => postJson<JobResult>("/api/backups/host-path", {
          hostId: createForm.hostId,
          sourcePath: createForm.sourcePath,
          backupTargetId: createForm.backupTargetId || undefined,
          encryption: createForm.encryption
        }));
        setCreateForm((current) => ({ ...current, sourcePath: "" }));
      }
      await refresh();
      await loadBackupPage(0);
      await loadAuxiliaryData();
    });
  }

  async function createSchedule() {
    await action.run(async () => {
      await postJson("/api/backup-schedules", {
        kind: scheduleForm.kind,
        hostId: scheduleForm.hostId,
        volumeName: scheduleForm.kind === "volume" ? scheduleForm.volumeName : undefined,
        sourcePath: scheduleForm.kind === "host_path" ? scheduleForm.sourcePath : undefined,
        backupTargetId: scheduleForm.backupTargetId || undefined,
        encryption: scheduleForm.encryption,
        intervalMs: scheduleForm.intervalHours * 60 * 60 * 1000,
        retentionCount: scheduleForm.retentionCount || undefined
      });
      setScheduleForm((current) => ({ ...current, volumeName: "", sourcePath: "" }));
      await loadAuxiliaryData();
    });
  }

  async function restoreBackup(backup: Backup) {
    const state = restoreStateFor(backup);
    const targetHostId = state.hostId;
    const target = state.target;
    const targetKind = backup.kind === "host_path" ? "path" : "volume";
    const targetHost = hostName(hosts, targetHostId);
    const overwrite = state.overwrite ?? false;
    const ok = await confirm({
      title: "Restore backup",
      tone: "danger",
      confirmLabel: "Restore",
      message: overwrite
        ? `Restore ${backupTitle(backup)} to ${targetHost} ${targetKind} ${target}? Overwrite is enabled, so existing data in the target will be overwritten.`
        : `Restore ${backupTitle(backup)} to ${targetHost} ${targetKind} ${target}? The restore will be refused if the target already contains data.`
    });
    if (!ok) return;
    await action.run(() => runJob(() => postJson<JobResult>(
      backup.kind === "host_path"
        ? `/api/backups/${backup.id}/restore-host-path`
        : `/api/backups/${backup.id}/restore`,
      backup.kind === "host_path"
        ? { targetHostId, targetPath: target, overwrite }
        : { targetHostId, targetVolumeName: target, overwrite }
    )));
  }

  async function verifyBackup(backup: Backup, testArchive: boolean) {
    await action.run(() => runJob(() => postJson<JobResult>(`/api/backups/${backup.id}/verify`, { testArchive })));
  }

  async function drillBackup(backup: Backup) {
    await action.run(() => runJob(() => postJson<JobResult>(`/api/backups/${backup.id}/drill`, {})));
  }

  function restoreStateFor(backup: Backup): RestoreState {
    return restore[backup.id] ?? {
      hostId: backup.hostId,
      target: backup.kind === "host_path" ? backup.sourcePath ?? "" : backup.volumeName ?? "",
      overwrite: false
    };
  }

  return (
    <Panel title="Backup inventory" count={panelCount}>
      {health && (
        <div className="backupHealthSummary">
          <div className="backupHealthOverall">
            <strong>Backup health</strong>
            <span className={`pill ${healthPillClass(health.overall.status)}`}>{healthLabel(health.overall.status)}</span>
          </div>
          <span>Newest: {formatAge(health.overall.newestSuccessfulBackupAgeMs)}</span>
          <span>Stored: {formatBytes(health.overall.totalSizeBytes)}</span>
          <span>Recent failures: {health.overall.recentFailureCount}</span>
          <span>Never drilled: {health.overall.neverDrilledCount}</span>
          {healthHighlights.map((host) => (
            <span key={host.hostId ?? host.hostName} className="backupHealthHost">
              {host.hostName}: <span className={`pill ${healthPillClass(host.status)}`}>{healthLabel(host.status)}</span>
            </span>
          ))}
        </div>
      )}
      {attentionItems.length > 0 && (
        <div className="backupAttentionList">
          <strong>Needs attention</strong>
          {attentionItems.map((item) => (
            <div key={`${item.backupId}-${item.reason}`} className="backupAttentionItem">
              <span className={`pill ${healthPillClass(item.severity)}`}>{attentionReasonLabel(item.reason)}</span>
              <span className="backupAttentionTarget">
                {item.hostName} / <span className={item.kind === "host_path" ? "monoText" : undefined}>{item.label}</span>
              </span>
              <span>{item.recommendedAction}</span>
              <small>{formatAge(item.ageMs)}</small>
            </div>
          ))}
        </div>
      )}

      <div className="recoveryBackupControls">
        <div className="backupToolbar">
          <Field label="Host">
            <select value={filters.hostId} onChange={(event) => setFilters((current) => ({ ...current, hostId: event.target.value }))}>
              <option value="all">All hosts</option>
              {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={filters.kind} onChange={(event) => setFilters((current) => ({ ...current, kind: event.target.value as BackupKindFilter }))}>
              <option value="all">All types</option>
              <option value="volume">Volumes</option>
              <option value="host_path">Host paths</option>
              <option value="recovery_point">Recovery points</option>
            </select>
          </Field>
        </div>

        {canOperate && <div className="recoveryTaskGrid">
          <form className="recoveryTaskCard" onSubmit={(event) => { event.preventDefault(); void createBackup(); }}>
            <CardSection title="Create backup">
              <div className="recoveryFieldGrid twoColumn">
                <Field label="Host">
                  <HostSelect hosts={hosts} value={createForm.hostId} onChange={(hostId) => setCreateForm((current) => ({ ...current, hostId }))} />
                </Field>
                <Field label="Type">
                  <select value={createForm.kind} onChange={(event) => setCreateForm((current) => ({ ...current, kind: event.target.value as CreateKind }))}>
                    <option value="volume">Volume</option>
                    <option value="host_path">Host path</option>
                  </select>
                </Field>
              </div>
              <Field label={createForm.kind === "volume" ? "Volume name" : "Host path"}>
                {createForm.kind === "volume" ? (
                  <input placeholder="Volume name" value={createForm.volumeName} onChange={(event) => setCreateForm((current) => ({ ...current, volumeName: event.target.value }))} required />
                ) : (
                  <input placeholder="/srv/app/data" value={createForm.sourcePath} onChange={(event) => setCreateForm((current) => ({ ...current, sourcePath: event.target.value }))} required />
                )}
              </Field>
              <div className="recoveryFieldGrid targetRow">
                <Field label="Storage">
                  <select value={createForm.backupTargetId} onChange={(event) => setCreateForm((current) => ({ ...current, backupTargetId: event.target.value }))}>
                    <option value="">Local</option>
                    {remoteTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                  </select>
                </Field>
                <label className="checkLine recoveryCheckLine">
                  <input
                    type="checkbox"
                    checked={createForm.encryption === "app_secret"}
                    onChange={(event) => setCreateForm((current) => ({ ...current, encryption: event.target.checked ? "app_secret" : "none" }))}
                  />
                  Encrypt
                </label>
              </div>
            </CardSection>
            <ButtonRow className="recoveryActionRow">
              <button type="submit" className="primary" disabled={action.busy || !createForm.hostId}>
                <Plus size={16} />
                Create
              </button>
            </ButtonRow>
          </form>

          <form className="recoveryTaskCard" onSubmit={(event) => { event.preventDefault(); void createSchedule(); }}>
            <CardSection title="Schedule backup">
              <div className="recoveryFieldGrid twoColumn">
                <Field label="Host">
                  <HostSelect hosts={hosts} value={scheduleForm.hostId} onChange={(hostId) => setScheduleForm((current) => ({ ...current, hostId }))} />
                </Field>
                <Field label="Type">
                  <select value={scheduleForm.kind} onChange={(event) => setScheduleForm((current) => ({ ...current, kind: event.target.value as CreateKind }))}>
                    <option value="volume">Volume</option>
                    <option value="host_path">Host path</option>
                  </select>
                </Field>
              </div>
              <Field label={scheduleForm.kind === "volume" ? "Volume name" : "Host path"}>
                {scheduleForm.kind === "volume" ? (
                  <input placeholder="Volume name" value={scheduleForm.volumeName} onChange={(event) => setScheduleForm((current) => ({ ...current, volumeName: event.target.value }))} required />
                ) : (
                  <input placeholder="/srv/app/data" value={scheduleForm.sourcePath} onChange={(event) => setScheduleForm((current) => ({ ...current, sourcePath: event.target.value }))} required />
                )}
              </Field>
              <div className="recoveryFieldGrid scheduleRow">
                <Field label="Interval">
                  <select value={scheduleForm.intervalHours} onChange={(event) => setScheduleForm((current) => ({ ...current, intervalHours: Number(event.target.value) }))}>
                    <option value={6}>Every 6 hours</option>
                    <option value={12}>Every 12 hours</option>
                    <option value={24}>Every 24 hours</option>
                    <option value={168}>Every week</option>
                  </select>
                </Field>
                <Field label="Keep">
                  <input type="number" min={1} max={365} value={scheduleForm.retentionCount} onChange={(event) => setScheduleForm((current) => ({ ...current, retentionCount: Number(event.target.value) }))} aria-label="Retention count" />
                </Field>
              </div>
              <div className="recoveryFieldGrid targetRow">
                <Field label="Storage">
                  <select value={scheduleForm.backupTargetId} onChange={(event) => setScheduleForm((current) => ({ ...current, backupTargetId: event.target.value }))}>
                    <option value="">Local</option>
                    {remoteTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                  </select>
                </Field>
                <label className="checkLine recoveryCheckLine">
                  <input
                    type="checkbox"
                    checked={scheduleForm.encryption === "app_secret"}
                    onChange={(event) => setScheduleForm((current) => ({ ...current, encryption: event.target.checked ? "app_secret" : "none" }))}
                  />
                  Encrypt
                </label>
              </div>
            </CardSection>
            <ButtonRow className="recoveryActionRow">
              <button type="submit" className="primary" disabled={action.busy || !scheduleForm.hostId}>
                <Plus size={16} />
                Add schedule
              </button>
            </ButtonRow>
          </form>
        </div>}
      </div>

      {action.error && <div className="notice error">{action.error}</div>}
      {backupPageError && <div className="notice error">{backupPageError}</div>}
      {backupsLoading && <div className="notice">Loading backups…</div>}

      {activeBackupJobs.length > 0 && (
        <DataTable
          compact
          rows={activeBackupJobs}
          columns={["Job", "Status", "Host", "Updated"]}
          render={(job) => [
            jobLabel(job.type),
            <StatusPill key="status" status={job.status} />,
            job.hostId ? hostName(hosts, job.hostId) : "—",
            formatDate(job.updatedAt)
          ]}
        />
      )}

      {canOperate && schedules.length > 0 && (
        <DataTable
          compact
          rows={schedules}
          columns={["Schedule", "Host", "Type", "Target", "Keep", "Next run", "Status", ""]}
          render={(schedule) => [
            <span key="name" className="monoText">{scheduleTitle(schedule)}</span>,
            hostName(hosts, schedule.hostId),
            <span key="type" className="backupTypeCell">
              <span>{schedule.kind === "host_path" ? "Host path" : "Volume"}</span>
              {schedule.encryption === "app_secret" && <span className="pill muted">Encrypted</span>}
            </span>,
            targetLabel(targets, schedule.backupTargetId),
            schedule.retentionCount ?? "—",
            formatDate(schedule.nextRunAt),
            schedule.lastStatus ? <StatusPill key="status" status={schedule.lastStatus} /> : "—",
            <button
              key="delete"
              type="button"
              className="danger"
              title="Delete schedule"
              onClick={() => void (async () => {
                const ok = await confirm({ title: "Delete schedule", tone: "danger", confirmLabel: "Delete", message: `Remove scheduled backup for ${scheduleTitle(schedule)}?` });
                if (!ok) return;
                await deleteJson(`/api/backup-schedules/${schedule.id}`);
                await loadAuxiliaryData();
              })()}
            >
              <Trash2 size={16} />
            </button>
          ]}
        />
      )}

      <DataTable
        rows={rows}
        columns={[
          "Name",
          "Host",
          "Type",
          "Status",
          "Size",
          "Storage",
          "Created",
          "Verified",
          "Drilled",
          ...(canOperate ? ["Restore", "Actions"] : [])
        ]}
        render={(row) => {
          if (row.rowKind === "recovery_point") {
            const point = row.point;
            return [
              recoveryPointLabel(point),
              hostName(hosts, point.hostId),
              "Recovery point",
              <StatusPill key="status" status={point.status} />,
              point.totalBytes != null ? formatBytes(point.totalBytes) : "—",
              targetLabel(targets, point.backupTargetId),
              formatDate(point.createdAt),
              typeof point.metadata.verifiedAt === "string" ? formatDate(point.metadata.verifiedAt) : "—",
              "—",
              ...(canOperate ? [
                <span key="restore" className="pill muted">Recovery Center</span>,
                <FileArchive key="actions" size={16} />
              ] : [])
            ];
          }

          const backup = row.backup;
          const state = restoreStateFor(backup);
          const canUseArtifact = backup.status === "completed" || backup.status === "partial";
          return [
            <span key="name" className={backup.kind === "host_path" ? "monoText" : undefined}>{backupTitle(backup)}</span>,
            hostName(hosts, backup.hostId),
            <span key="type" className="backupTypeCell">
              <span>{backupTypeLabel(backup)}</span>
              {backup.encryption === "app_secret" && (
                <span className="pill muted" title={backup.encryptionKeyId ? `Key: ${backup.encryptionKeyId}` : "Encrypted"}>
                  Encrypted
                </span>
              )}
            </span>,
            <StatusPill key="status" status={backup.status} />,
            backup.sizeBytes != null ? formatBytes(backup.sizeBytes) : "—",
            backup.remoteObjectKey ? targetLabel(targets, backup.backupTargetId) : "Local",
            formatDate(backup.createdAt),
            backup.verifiedAt ? formatDate(backup.verifiedAt) : "—",
            <span key="drilled" className="backupTypeCell">
              <span>{backup.lastDrillAt ? formatDate(backup.lastDrillAt) : "Never"}</span>
              {backup.lastDrillStatus && <span className={`pill ${backup.lastDrillStatus === "completed" ? "completed" : "failed"}`}>{backup.lastDrillStatus}</span>}
            </span>,
            ...(canOperate ? [<div className="backupRestoreRow" key="restore">
              <select value={state.hostId} onChange={(event) => setRestore((current) => ({ ...current, [backup.id]: { ...state, hostId: event.target.value } }))}>
                {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </select>
              <input
                placeholder={backup.kind === "host_path" ? "/restore/path" : "Target volume"}
                value={state.target}
                onChange={(event) => setRestore((current) => ({ ...current, [backup.id]: { ...state, target: event.target.value } }))}
              />
              <label className="checkLine">
                <input
                  type="checkbox"
                  checked={state.overwrite ?? false}
                  onChange={(event) => setRestore((current) => ({ ...current, [backup.id]: { ...state, overwrite: event.target.checked } }))}
                />
                Overwrite
              </label>
              <button type="button" disabled={action.busy || !canUseArtifact} title="Restore" onClick={() => void restoreBackup(backup)}>
                <RotateCcw size={16} />
              </button>
            </div>,
            <ButtonRow key="actions">
              <button
                type="button"
                title="Verify checksum and remote copy"
                disabled={action.busy || !canUseArtifact}
                onClick={() => void verifyBackup(backup, false)}
              >
                <ShieldCheck size={16} />
              </button>
              <button
                type="button"
                title="Deep verify archive"
                disabled={action.busy || !canUseArtifact}
                onClick={() => void verifyBackup(backup, true)}
              >
                <FileArchive size={16} />
              </button>
              <button
                type="button"
                title="Test restore"
                disabled={action.busy || !canUseArtifact}
                onClick={() => void drillBackup(backup)}
              >
                <FlaskConical size={16} />
              </button>
              {canUseArtifact ? (
                <a className="buttonLink" href={`/api/backups/${backup.id}/download`} title="Download">
                  <Download size={16} />
                </a>
              ) : (
                <a className="buttonLink disabled" aria-disabled="true" tabIndex={-1} title="Download unavailable">
                  <Download size={16} />
                </a>
              )}
              <button
                type="button"
                className="danger"
                title="Delete backup"
                onClick={() => void (async () => {
                  const ok = await confirm({ title: "Delete backup", tone: "danger", confirmLabel: "Delete", message: `Delete backup for ${backupTitle(backup)}?` });
                  if (!ok) return;
                  await deleteJson(`/api/backups/${backup.id}`);
                  await refresh();
                  await loadAuxiliaryData();
                })()}
              >
                <Trash2 size={16} />
              </button>
            </ButtonRow>] : [])
          ];
        }}
      />
      {backupPage.hasMore && filters.kind !== "recovery_point" && (
        <div className="backupPager">
          <button type="button" disabled={backupsLoading} onClick={() => void loadBackupPage(pagedBackups.length)}>
            Load more
          </button>
          <span>{pagedBackups.length} of {backupPage.total}</span>
        </div>
      )}
    </Panel>
  );
}
