import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Play, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { DockerHost, ImageScannerStatus, ImageUpdateCheck, ImageUpdatePreview } from "@composebastion/shared";
import { api, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { formatDate } from "../../lib/format.js";
import type { Jobish, JobResult } from "../../lib/dashboardTypes.js";
import { hostName } from "../../lib/hostScope.js";
import { HostSelect } from "../dashboard/HostSelect.js";
import { ButtonRow, DataTable, EmptyState, Panel, StatusPill } from "../ui/primitives.js";

function severityBadge(counts?: ImageUpdateCheck["severityCounts"]) {
  if (!counts) return "—";
  const total = counts.critical + counts.high + counts.medium + counts.low;
  if (total === 0) return <span className="pill ok">Clean</span>;
  if (counts.critical > 0) return <span className="pill danger">C {counts.critical}</span>;
  if (counts.high > 0) return <span className="pill warn">H {counts.high}</span>;
  return <span className="pill info">M {counts.medium}</span>;
}

export function UpdatesPanel({
  hosts,
  runJob,
  refresh
}: {
  hosts: DockerHost[];
  runJob: <T extends Jobish>(request: () => Promise<T>) => Promise<T>;
  refresh: () => Promise<void>;
}) {
  const action = useAsyncAction();
  const [hostId, setHostId] = useState(hosts[0]?.id ?? "");
  const [updates, setUpdates] = useState<ImageUpdateCheck[]>([]);
  const [scannerStatus, setScannerStatus] = useState<ImageScannerStatus | null>(null);
  const [lastContainerUpdate, setLastContainerUpdate] = useState<{
    containerName: string;
    imageReference: string;
    completedAt: string;
  } | null>(null);
  const [preview, setPreview] = useState<{
    data: ImageUpdatePreview;
    title: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const previewCloseButtonRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    const query = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
    const [result, statusResult] = await Promise.all([
      api<{ updates: ImageUpdateCheck[] }>(`/api/image-updates${query}`),
      api<{ status: ImageScannerStatus }>("/api/image-scanner/status").catch(() => null)
    ]);
    setUpdates(result.updates);
    setScannerStatus(statusResult?.status ?? null);
  }, [hostId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setLastContainerUpdate(null);
  }, [hostId]);

  useEffect(() => {
    if (preview) previewCloseButtonRef.current?.focus();
  }, [preview]);

  async function checkNow() {
    if (!hostId) return;
    await action.run(async () => {
      await postJson("/api/image-updates/check", { hostId });
      await load();
    });
  }

  async function pullImage(imageReference: string) {
    if (!hostId) return;
    await action.run(() => runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/actions`, {
      type: "image.pull",
      hostId,
      payload: { image: imageReference }
    })));
    await refresh();
    await load();
  }

  async function scanImage(imageReference: string) {
    if (!hostId) return;
    await action.run(async () => {
      await postJson("/api/image-scans", { hostId, imageReference });
      await load();
    });
  }

  async function updateContainerNow(containerId: string, imageReference: string, containerName?: string) {
    if (!hostId) return;
    await action.run(() => runJob(() => postJson<JobResult>(`/api/hosts/${hostId}/actions`, {
      type: "container.update",
      hostId,
      payload: { containerId, targetImage: imageReference }
    })));
    setLastContainerUpdate({
      containerName: containerName?.trim() || containerId,
      imageReference,
      completedAt: new Date().toISOString()
    });
    await refresh();
    await load();
  }

  async function redeployStackNow(stackId: string) {
    await action.run(() => runJob(() => postJson<JobResult>(`/api/compose/${stackId}/deploy`, {})));
    await refresh();
    await load();
  }

  async function openPreview(imageReference: string, title: string, confirmLabel: string, onConfirm: () => Promise<void>) {
    if (!hostId) return;
    previewReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const result = await api<{ preview: ImageUpdatePreview }>(`/api/image-updates/preview?hostId=${encodeURIComponent(hostId)}&image=${encodeURIComponent(imageReference)}`);
    setPreview({ data: result.preview, title, confirmLabel, onConfirm });
  }

  function closePreview() {
    const returnTarget = previewReturnFocusRef.current;
    setPreview(null);
    window.setTimeout(() => returnTarget?.focus(), 0);
  }

  async function confirmPreview() {
    const current = preview;
    if (!current) return;
    setPreview(null);
    await current.onConfirm();
  }

  return (
    <Panel title="Image Updates" count={updates.length}>
      <div className="formHint">Check whether tracked image tags have newer digests available. Mutable tags like <code>latest</code> are flagged with risk notes. Auto-update policies stay disabled unless enabled per stack.</div>
      {scannerStatus && (
        <div className={`notice ${scannerStatus.available ? "" : "warning"}`}>
          Scanner: {scannerStatus.effectiveProvider}
          {scannerStatus.trivyVersion ? ` (${scannerStatus.trivyVersion})` : ""}
          {!scannerStatus.available && ` - ${scannerStatus.guidance}`}
        </div>
      )}
      <div className="inlineForm">
        <HostSelect hosts={hosts} value={hostId} onChange={setHostId} />
        <button type="button" className="primary" disabled={!hostId || action.busy} onClick={() => void checkNow()}><RefreshCw size={16} />Check now</button>
      </div>
      {lastContainerUpdate && (
        <div className="notice success" role="status">
          Container update successful for <strong>{lastContainerUpdate.containerName}</strong>. Now using <code>{lastContainerUpdate.imageReference}</code> as of {formatDate(lastContainerUpdate.completedAt)}.
        </div>
      )}
      {updates.length === 0 ? (
        <EmptyState headline="No update checks yet" hint="Run a check to compare local image digests and flag mutable tags." />
      ) : (
        <DataTable
          rows={updates}
          columns={["Image", "Status", "Risk", "Containers", "Scan", "Checked", "Actions"]}
          render={(update) => [
            <code key="image">{update.imageReference}</code>,
            <StatusPill key="status" status={update.status} />,
            update.riskNote ?? "—",
            update.affectedContainers?.length ?? 0,
            severityBadge(update.severityCounts),
            formatDate(update.lastCheckedAt),
            <ButtonRow key="actions">
              <button title="Scan image" onClick={() => void scanImage(update.imageReference)}><ShieldAlert size={16} /></button>
              <button title="Pull latest" onClick={() => void pullImage(update.imageReference)}><Download size={16} /></button>
              {update.affectedContainers?.[0] && (
                <button title="Update container" onClick={() => void openPreview(
                  update.imageReference,
                  "Update container",
                  "Update container",
                  () => updateContainerNow(update.affectedContainers?.[0]!.id, update.imageReference, update.affectedContainers?.[0]!.name)
                )}><Play size={16} /></button>
              )}
              {update.affectedStacks?.[0] && update.status === "update_available" && (
                <button title={`Redeploy ${update.affectedStacks?.[0]!.name}`} onClick={() => void openPreview(
                  update.imageReference,
                  `Redeploy ${update.affectedStacks?.[0]!.name}`,
                  "Redeploy stack",
                  () => redeployStackNow(update.affectedStacks?.[0]!.id)
                )}><RefreshCw size={16} /></button>
              )}
              <span className="monoText">{hostName(hosts, update.hostId)}</span>
            </ButtonRow>
          ]}
        />
      )}
      {action.error && <div className="notice error">{action.error}</div>}
      {preview && (
        <div className="drawerOverlay" role="dialog" aria-modal="true" aria-label={preview.title}>
          <div className="drawer previewDialog">
            <div className="panelHeader">
              <div>
                <h3>{preview.title}</h3>
                <p>{preview.data.imageReference}</p>
              </div>
              <button type="button" ref={previewCloseButtonRef} onClick={closePreview} title="Close" aria-label="Close update preview"><X size={16} /></button>
            </div>
            <div className="detailStack">
              <div className="detailKeyValueGrid">
                <span><strong>Status</strong><code>{preview.data.status}</code></span>
                <span><strong>Safe action</strong><code>{preview.data.safeAction}</code></span>
                <span><strong>Containers</strong><code>{preview.data.affectedContainers.length}</code></span>
                <span><strong>Stacks</strong><code>{preview.data.affectedStacks.length}</code></span>
              </div>
              {preview.data.riskNote && <div className="notice warning">{preview.data.riskNote}</div>}
              {preview.data.credentialHint && <div className="notice warning">{preview.data.credentialHint}</div>}
              {preview.data.severityCounts && (
                <div className="notice">Vulnerabilities: C {preview.data.severityCounts.critical}, H {preview.data.severityCounts.high}, M {preview.data.severityCounts.medium}, L {preview.data.severityCounts.low}</div>
              )}
              <ButtonRow>
                <button type="button" onClick={closePreview}>Cancel</button>
                <button type="button" className="primary" onClick={() => void confirmPreview()}>{preview.confirmLabel}</button>
              </ButtonRow>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
