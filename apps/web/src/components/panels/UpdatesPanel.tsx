import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Play, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { DockerHost, ImageScannerStatus, ImageUpdateCheck, ImageUpdatePreview } from "@composebastion/shared";
import { api, postJson } from "../../api.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { formatDate } from "../../lib/format.js";
import { captureFocusReturn, scheduleFocusRestoration, type FocusReturnContext } from "../../lib/focusRestoration.js";
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
    focusReturn: FocusReturnContext;
  } | null>(null);
  const previewDialogRef = useRef<HTMLDivElement | null>(null);
  const previewCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const previewRequestRef = useRef(0);

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
    void load().catch((caught) => action.setError(caught instanceof Error ? caught.message : String(caught)));
  }, [load]);

  useEffect(() => {
    setLastContainerUpdate(null);
  }, [hostId]);

  const closePreview = useCallback(() => {
    if (!preview) return;
    previewRequestRef.current += 1;
    setPreview(null);
    scheduleFocusRestoration(preview.focusReturn);
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    const animationFrame = window.requestAnimationFrame(() => previewCancelButtonRef.current?.focus());

    function handlePreviewKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closePreview();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = previewDialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])"
      )).filter((element) => element.getClientRects().length > 0);
      event.preventDefault();
      event.stopImmediatePropagation();
      if (focusable.length === 0) {
        dialog.focus();
        return;
      }
      const activeIndex = document.activeElement instanceof HTMLElement
        ? focusable.indexOf(document.activeElement)
        : -1;
      const nextIndex = activeIndex < 0
        ? event.shiftKey ? focusable.length - 1 : 0
        : event.shiftKey
          ? (activeIndex - 1 + focusable.length) % focusable.length
          : (activeIndex + 1) % focusable.length;
      focusable[nextIndex]!.focus();
    }

    window.addEventListener("keydown", handlePreviewKeys, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("keydown", handlePreviewKeys, true);
    };
  }, [preview, closePreview]);

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

  async function openPreview(
    imageReference: string,
    title: string,
    confirmLabel: string,
    onConfirm: () => Promise<void>,
    returnFocus: HTMLElement
  ) {
    if (!hostId) return;
    const focusReturn = captureFocusReturn(returnFocus);
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    try {
      const result = await action.run(() =>
        api<{ preview: ImageUpdatePreview }>(`/api/image-updates/preview?hostId=${encodeURIComponent(hostId)}&image=${encodeURIComponent(imageReference)}`)
      );
      if (requestId !== previewRequestRef.current || !document.contains(returnFocus)) return;
      setPreview({ data: result.preview, title, confirmLabel, onConfirm, focusReturn });
    } catch {
      // The action hook renders the failure inline. Consume the rejection at
      // this click boundary and return keyboard focus to the preview trigger.
      if (requestId === previewRequestRef.current) {
        scheduleFocusRestoration(focusReturn, { afterRender: true });
      }
    }
  }

  async function confirmPreview() {
    const current = preview;
    if (!current) return;
    previewRequestRef.current += 1;
    setPreview(null);
    try {
      await current.onConfirm();
    } catch {
      // The action hook renders the failure inline. Consume the rejection at
      // this event boundary so a failed update cannot become an unhandled one.
    } finally {
      scheduleFocusRestoration(current.focusReturn, { afterRender: true });
    }
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
        <button type="button" className="primary" disabled={!hostId || action.busy} onClick={() => void checkNow().catch(() => undefined)}><RefreshCw size={16} />Check now</button>
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
              <button disabled={action.busy} title="Scan image" onClick={() => void scanImage(update.imageReference).catch(() => undefined)}><ShieldAlert size={16} /></button>
              <button disabled={action.busy} title="Pull latest" onClick={() => void pullImage(update.imageReference).catch(() => undefined)}><Download size={16} /></button>
              {update.affectedContainers?.[0] && (
                <button disabled={action.busy} title="Update container" onClick={(event) => void openPreview(
                  update.imageReference,
                  "Update container",
                  "Update container",
                  () => updateContainerNow(update.affectedContainers?.[0]!.id, update.imageReference, update.affectedContainers?.[0]!.name),
                  event.currentTarget
                )}><Play size={16} /></button>
              )}
              {update.affectedStacks?.[0] && update.status === "update_available" && (
                <button disabled={action.busy} title={`Redeploy ${update.affectedStacks?.[0]!.name}`} onClick={(event) => void openPreview(
                  update.imageReference,
                  `Redeploy ${update.affectedStacks?.[0]!.name}`,
                  "Redeploy stack",
                  () => redeployStackNow(update.affectedStacks?.[0]!.id),
                  event.currentTarget
                )}><RefreshCw size={16} /></button>
              )}
              <span className="monoText">{hostName(hosts, update.hostId)}</span>
            </ButtonRow>
          ]}
        />
      )}
      {action.error && <div className="notice error" role="alert">{action.error}</div>}
      {preview && (
        <div className="drawerOverlay" role="presentation">
          <div
            ref={previewDialogRef}
            className="drawer previewDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-preview-title"
            aria-describedby="update-preview-description"
            tabIndex={-1}
          >
            <div className="panelHeader">
              <div>
                <h3 id="update-preview-title">{preview.title}</h3>
                <p id="update-preview-description">{preview.data.imageReference}</p>
              </div>
              <button type="button" onClick={closePreview} title="Close" aria-label="Close update preview"><X size={16} /></button>
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
                <button ref={previewCancelButtonRef} type="button" onClick={closePreview}>Cancel</button>
                <button type="button" className="primary" onClick={() => void confirmPreview()}>{preview.confirmLabel}</button>
              </ButtonRow>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}
