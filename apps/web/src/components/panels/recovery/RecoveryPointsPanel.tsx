import { useMemo, useState } from "react";
import { Copy, Play, Plus, ShieldCheck } from "lucide-react";
import type { BackupTarget, DockerApp, DockerHost, RecoveryAnalysis, RecoveryDataMount, RecoveryPointListItem, RecoveryReadiness } from "@dockermender/shared";
import { api, postJson, putJson } from "../../../api.js";
import { useAsyncAction } from "../../../hooks/useAsyncAction.js";
import type { Jobish, JobResult } from "../../../lib/dashboardTypes.js";
import { formatBytes, formatDate } from "../../../lib/format.js";
import { hostName } from "../../../lib/hostScope.js";
import { dockerAppToRecoveryIdentity, recoveryAppLabel, recoveryIdentityKey, recoveryLocalState, recoveryReadinessClass, recoveryReadinessLabel, recoveryRemoteState } from "../../../lib/recovery.js";
import { formatRestorePathMappings, parseProfileLines, parseRestorePathMappings } from "../../../lib/recoveryProfile.js";
import { statusClassName } from "../../../lib/dockerMetrics.js";
import { HostSelect } from "../../dashboard/HostSelect.js";
import { useConfirm } from "../../ConfirmProvider.js";
import { ButtonRow, DataTable, InlineForm, Panel, StatusPill } from "../../ui/primitives.js";

function statePill(label: string, value: string) {
  const mapped = value === "complete" || value === "synced" ? "completed" : value === "partial" ? "partial" : value;
  return <span className={`pill ${statusClassName(mapped)}`}>{label}: {value}</span>;
}

function drillSummary(point: RecoveryPointListItem) {
  if (point.lastSuccessfulDrillAt) return `Last passed ${formatDate(point.lastSuccessfulDrillAt)}`;
  if (point.lastDrillStatus) return point.lastDrillError ? `${point.lastDrillStatus}: ${point.lastDrillError}` : point.lastDrillStatus;
  return "No drill yet";
}

function readinessDataMountLabel(mount: RecoveryDataMount) {
  if (mount.type === "volume") return `Volume ${mount.name ?? "unnamed"} -> ${mount.destination}`;
  if (mount.type === "bind") return `Path ${mount.source ?? "unknown"} -> ${mount.destination}`;
  if (mount.type === "tmpfs") return `tmpfs -> ${mount.destination}`;
  if (mount.type === "manual") return `Manual ${mount.source ?? "unknown"}`;
  return `Compose folder ${mount.source ?? "unknown"}`;
}

function readinessKeyForApp(app: DockerApp) {
  try {
    return recoveryIdentityKey(dockerAppToRecoveryIdentity(app));
  } catch {
    return "";
  }
}

export function RecoveryPointsPanel({
  hosts,
  apps,
  points,
  readiness,
  targets,
  targetNames,
  refresh,
  runJob
}: {
  hosts: DockerHost[];
  apps: DockerApp[];
  points: RecoveryPointListItem[];
  readiness: RecoveryReadiness[];
  targets: BackupTarget[];
  targetNames: Record<string, string>;
  refresh: () => Promise<void>;
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
}) {
  const { confirm } = useConfirm();
  const action = useAsyncAction();
  const [createForm, setCreateForm] = useState({
    hostId: hosts[0]?.id ?? "",
    appId: apps[0]?.id ?? "",
    backupTargetId: "",
    stopFirst: false,
    captureMode: "hot" as "hot" | "stop_first",
    includePaths: "",
    excludePatterns: "",
    restorePaths: "",
    preCaptureCommand: "",
    postCaptureCommand: ""
  });
  const [restoreHost, setRestoreHost] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<RecoveryAnalysis | null>(null);
  const [singleReadiness, setSingleReadiness] = useState<RecoveryReadiness | null>(null);

  const hostApps = useMemo(
    () => apps.filter((app) => app.hostId === createForm.hostId),
    [apps, createForm.hostId]
  );

  const selectedApp = apps.find((app) => app.id === createForm.appId) ?? hostApps[0] ?? null;
  const readinessByKey = useMemo(() => {
    const map = new Map<string, RecoveryReadiness>();
    for (const item of readiness) map.set(recoveryIdentityKey(item.appIdentity), item);
    return map;
  }, [readiness]);
  const selectedReadinessKey = selectedApp ? readinessKeyForApp(selectedApp) : "";
  const selectedReadiness = singleReadiness && recoveryIdentityKey(singleReadiness.appIdentity) === selectedReadinessKey
    ? singleReadiness
    : selectedReadinessKey
      ? readinessByKey.get(selectedReadinessKey) ?? null
      : null;

  async function analyzeSelectedApp() {
    if (!selectedApp) throw new Error("Select an app to analyze");
    await action.run(async () => {
      const result = await api<{ analysis: RecoveryAnalysis }>("/api/recovery/analyze", {
        method: "POST",
        body: JSON.stringify({
          hostId: selectedApp.hostId,
          appIdentity: dockerAppToRecoveryIdentity(selectedApp)
        })
      });
      setAnalysis(result.analysis);
      setCreateForm((current) => ({
        ...current,
        captureMode: result.analysis.recommendedCaptureMode,
        stopFirst: result.analysis.recommendedCaptureMode === "stop_first",
        includePaths: result.analysis.profile?.includePaths.join("\n") ?? current.includePaths,
        excludePatterns: result.analysis.profile?.excludePatterns.join("\n") ?? current.excludePatterns,
        restorePaths: result.analysis.profile ? formatRestorePathMappings(result.analysis.profile.restorePaths) : current.restorePaths,
        preCaptureCommand: result.analysis.profile?.preCaptureCommand ?? current.preCaptureCommand,
        postCaptureCommand: result.analysis.profile?.postCaptureCommand ?? current.postCaptureCommand
      }));
    });
  }

  async function refreshSelectedReadiness() {
    if (!selectedApp) throw new Error("Select an app to refresh readiness");
    await action.run(async () => {
      const result = await api<{ readiness: RecoveryReadiness }>("/api/recovery/readiness/analyze", {
        method: "POST",
        body: JSON.stringify({
          hostId: selectedApp.hostId,
          appIdentity: dockerAppToRecoveryIdentity(selectedApp)
        })
      });
      setSingleReadiness(result.readiness);
    });
  }

  async function saveProfile() {
    if (!selectedApp) throw new Error("Select an app to save a recovery profile");
    await action.run(async () => {
      const result = await putJson<{ profile: NonNullable<RecoveryAnalysis["profile"]> }>("/api/recovery/profiles", {
        hostId: selectedApp.hostId,
        appIdentity: dockerAppToRecoveryIdentity(selectedApp),
        name: `${selectedApp.name} recovery`,
        includePaths: parseProfileLines(createForm.includePaths),
        excludePatterns: parseProfileLines(createForm.excludePatterns),
        captureMode: createForm.captureMode,
        restorePaths: parseRestorePathMappings(createForm.restorePaths),
        preCaptureCommand: createForm.preCaptureCommand.trim() || null,
        postCaptureCommand: createForm.postCaptureCommand.trim() || null
      });
      setAnalysis((current) => current ? { ...current, profile: result.profile } : current);
    });
  }

  return (
    <Panel title="Recovery Points" count={points.length}>
      <InlineForm
        onSubmit={async () => {
          if (!selectedApp) throw new Error("Select an app to capture");
          await action.run(async () => {
            await postJson("/api/recovery/points", {
              hostId: selectedApp.hostId,
              appIdentity: dockerAppToRecoveryIdentity(selectedApp),
              backupTargetId: createForm.backupTargetId || undefined,
              profileId: analysis?.profile?.id,
              extraIncludePaths: parseProfileLines(createForm.includePaths),
              captureMode: createForm.captureMode,
              stopFirst: createForm.stopFirst,
              triggerKind: "manual"
            });
            await refresh();
          });
        }}
      >
        <strong>Create recovery point</strong>
        <HostSelect
          hosts={hosts}
          value={createForm.hostId}
          onChange={(hostId) => setCreateForm((current) => ({
            ...current,
            hostId,
            appId: apps.find((app) => app.hostId === hostId)?.id ?? ""
          }))}
        />
        <select
          value={createForm.appId}
          onChange={(event) => setCreateForm((current) => ({ ...current, appId: event.target.value }))}
          required
        >
          <option value="">App</option>
          {hostApps.map((app) => {
            const readinessKey = readinessKeyForApp(app);
            const item = readinessKey ? readinessByKey.get(readinessKey) : null;
            return (
              <option key={app.id} value={app.id}>
                {app.name}{item ? ` - ${recoveryReadinessLabel(item.status)} ${item.score}` : ""}
              </option>
            );
          })}
        </select>
        <select
          value={createForm.backupTargetId}
          onChange={(event) => setCreateForm((current) => ({ ...current, backupTargetId: event.target.value }))}
        >
          <option value="">Local only</option>
          {targets.filter((target) => target.enabled).map((target) => (
            <option key={target.id} value={target.id}>{target.name} ({target.type})</option>
          ))}
        </select>
        <label className="checkLine">
          <input
            type="checkbox"
            checked={createForm.stopFirst}
            onChange={(event) => setCreateForm((current) => ({ ...current, stopFirst: event.target.checked }))}
          />
          Stop app before capture
        </label>
        <select value={createForm.captureMode} onChange={(event) => setCreateForm((current) => ({ ...current, captureMode: event.target.value as "hot" | "stop_first", stopFirst: event.target.value === "stop_first" ? true : current.stopFirst }))}>
          <option value="hot">Hot capture</option>
          <option value="stop_first">Stop-first capture</option>
        </select>
        <textarea
          placeholder="Manual include paths, one per line"
          value={createForm.includePaths}
          onChange={(event) => setCreateForm((current) => ({ ...current, includePaths: event.target.value }))}
        />
        <textarea
          placeholder="Exclude patterns, one per line"
          value={createForm.excludePatterns}
          onChange={(event) => setCreateForm((current) => ({ ...current, excludePatterns: event.target.value }))}
        />
        <textarea
          placeholder="Restore path mappings, /source => /target"
          value={createForm.restorePaths}
          onChange={(event) => setCreateForm((current) => ({ ...current, restorePaths: event.target.value }))}
        />
        <textarea
          placeholder="Pre-capture command"
          value={createForm.preCaptureCommand}
          onChange={(event) => setCreateForm((current) => ({ ...current, preCaptureCommand: event.target.value }))}
        />
        <textarea
          placeholder="Post-capture command"
          value={createForm.postCaptureCommand}
          onChange={(event) => setCreateForm((current) => ({ ...current, postCaptureCommand: event.target.value }))}
        />
        <ButtonRow>
          <button type="button" disabled={action.busy || !selectedApp} onClick={() => void analyzeSelectedApp()}>
            <ShieldCheck size={16} />
            Analyze
          </button>
          <button type="button" disabled={action.busy || !selectedApp} onClick={() => void refreshSelectedReadiness()}>
            <ShieldCheck size={16} />
            Refresh readiness
          </button>
          <button type="button" disabled={action.busy || !selectedApp} onClick={() => void saveProfile()}>
            <Plus size={16} />
            Save profile
          </button>
        </ButtonRow>
        <button type="submit" className="primary" disabled={action.busy || !selectedApp}>
          <Plus size={16} />
          Capture
        </button>
      </InlineForm>

      {analysis && (
        <div className={`notice ${analysis.status === "ready" ? "" : analysis.status === "blocked" ? "error" : "warning"}`}>
          Recovery analysis: {analysis.status}; {analysis.dataMounts.length} data location(s) detected; recommended {analysis.recommendedCaptureMode === "stop_first" ? "stop-first" : "hot"} capture.
          {analysis.warnings.length > 0 && <small>{analysis.warnings.slice(0, 2).join(" ")}</small>}
        </div>
      )}

      {selectedReadiness && (
        <div className="readinessDetailPanel">
          <div className="readinessDetailHeader">
            <div>
              <span className={`readinessPill ${recoveryReadinessClass(selectedReadiness.status)}`}>
                {recoveryReadinessLabel(selectedReadiness.status)} {selectedReadiness.score}
              </span>
              <strong>{selectedReadiness.label}</strong>
            </div>
            <span>Recommended {selectedReadiness.recommendedCaptureMode === "stop_first" ? "stop-first" : "hot"} capture</span>
          </div>
          <div className="readinessDetailGrid">
            <div>
              <span>Detected data</span>
              {selectedReadiness.dataMounts.length > 0 ? (
                <ul>
                  {selectedReadiness.dataMounts.slice(0, 6).map((mount) => (
                    <li key={`${mount.type}:${mount.source ?? mount.name}:${mount.destination}`}>
                      <code>{readinessDataMountLabel(mount)}</code>
                      {mount.warning && <small>{mount.warning}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <small>No persistent data locations detected.</small>
              )}
            </div>
            <div>
              <span>Profile</span>
              <strong>{selectedReadiness.profile ? selectedReadiness.profile.name : "Not saved"}</strong>
              {selectedReadiness.profile && <small>{selectedReadiness.profile.captureMode === "stop_first" ? "Stop-first" : "Hot"} capture profile</small>}
            </div>
            <div>
              <span>Latest point</span>
              {selectedReadiness.lastRecoveryPoint ? (
                <>
                  <strong>{selectedReadiness.lastRecoveryPoint.status}</strong>
                  <small>
                    {selectedReadiness.lastRecoveryPoint.completedArtifactCount}/{selectedReadiness.lastRecoveryPoint.artifactCount} artifacts
                    {selectedReadiness.lastRecoveryPoint.verified ? " - verified" : " - not verified"}
                  </small>
                </>
              ) : (
                <small>No recovery point yet.</small>
              )}
            </div>
            <div>
              <span>Latest drill</span>
              {selectedReadiness.lastDrill ? (
                <>
                  <strong>{selectedReadiness.lastDrill.passed ? "Passed" : selectedReadiness.lastDrill.lastDrillStatus ?? "Not run"}</strong>
                  <small>{selectedReadiness.lastDrill.lastSuccessfulDrillAt ? formatDate(selectedReadiness.lastDrill.lastSuccessfulDrillAt) : selectedReadiness.lastDrill.lastDrillError ?? "Run a clone drill"}</small>
                </>
              ) : (
                <small>No drill yet.</small>
              )}
            </div>
            <div>
              <span>Target health</span>
              {selectedReadiness.targetHealth ? (
                <>
                  <strong>{selectedReadiness.targetHealth.targetName ?? "Backup target"}</strong>
                  <small>{selectedReadiness.targetHealth.status ?? "unknown"}{selectedReadiness.targetHealth.error ? ` - ${selectedReadiness.targetHealth.error}` : ""}</small>
                </>
              ) : (
                <small>Local-only capture.</small>
              )}
            </div>
            <div>
              <span>Next actions</span>
              {selectedReadiness.reasons.length > 0 ? (
                <ul>
                  {selectedReadiness.reasons.slice(0, 4).map((reason) => (
                    <li key={`${reason.code}:${reason.message}`}>
                      <strong>{reason.message}</strong>
                      {reason.action && <small>{reason.action}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <small>No readiness actions pending.</small>
              )}
            </div>
          </div>
        </div>
      )}

      {action.error && <div className="notice error">{action.error}</div>}

      <DataTable
        rows={points}
        columns={["App", "Host", "Status", "Artifacts", "Size", "Local", "Remote", "Drill", "Created", "Actions"]}
        render={(point) => {
          const local = recoveryLocalState(point);
          const remote = recoveryRemoteState(point);
          const remoteLabel = point.backupTargetId ? (targetNames[point.backupTargetId] ?? "S3 target") : "—";
          return [
            recoveryAppLabel(point),
            hostName(hosts, point.hostId),
            <StatusPill key="status" status={point.status} />,
            `${point.completedArtifactCount}/${point.artifactCount}`,
            point.totalBytes != null ? formatBytes(point.totalBytes) : "—",
            statePill("local", local),
            point.backupTargetId ? statePill(remoteLabel, remote) : "—",
            <div key="drill" className="alertRuleState">
              {point.lastDrillStatus && <StatusPill status={point.lastDrillStatus} />}
              <small>{drillSummary(point)}</small>
            </div>,
            formatDate(point.createdAt),
            <ButtonRow key="actions">
              <button
                type="button"
                title="Verify artifacts"
                disabled={action.busy || (point.status !== "completed" && point.status !== "partial")}
                onClick={() => void action.run(() => runJob(() => postJson<JobResult>(`/api/recovery/points/${point.id}/verify`, {})))}
              >
                <ShieldCheck size={16} />
              </button>
              <button
                type="button"
                title="Run restore drill"
                disabled={action.busy || (point.status !== "completed" && point.status !== "partial")}
                onClick={() => void action.run(async () => {
                  const ok = await confirm({
                    title: "Run restore drill",
                    message: `Restore ${recoveryAppLabel(point)} as a disposable clone and record the result? The original app is left untouched.`,
                    confirmLabel: "Run drill"
                  });
                  if (!ok) return;
                  await runJob(() => postJson<JobResult>(`/api/recovery/points/${point.id}/drill`, {}));
                  await refresh();
                })}
              >
                <Play size={16} />
              </button>
              <select
                value={restoreHost[point.id] ?? point.hostId}
                onChange={(event) => setRestoreHost((current) => ({ ...current, [point.id]: event.target.value }))}
              >
                {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </select>
              <button
                type="button"
                className="primary"
                title="Restore clone"
                disabled={action.busy || (point.status !== "completed" && point.status !== "partial")}
                onClick={() => void action.run(async () => {
                  const ok = await confirm({
                    title: "Restore clone",
                    message: `Restore ${recoveryAppLabel(point)} as a cloned app on ${hostName(hosts, restoreHost[point.id] ?? point.hostId)}? The original app is left untouched.`,
                    confirmLabel: "Restore clone"
                  });
                  if (!ok) return;
                  await runJob(() => postJson<JobResult>("/api/recovery/restore", {
                    recoveryPointId: point.id,
                    targetHostId: restoreHost[point.id] ?? point.hostId,
                    options: { mode: "clone", remapPorts: true }
                  }));
                  await refresh();
                })}
              >
                <Copy size={16} />
              </button>
            </ButtonRow>
          ];
        }}
      />
    </Panel>
  );
}
