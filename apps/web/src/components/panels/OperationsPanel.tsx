import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import type { BackupHealthSummary, DockerHost, OperationJob, RecoveryPointListItem, SelfUpdateConfig } from "@composebastion/shared";
import { api, parseApiJson, postJson, putJson } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { activeJobPhase, jobProgressSteps, jobRecoveryHint } from "../../lib/jobProgress.js";
import { sleep } from "../../lib/hostScope.js";
import { ButtonRow, CardSection, DataTable, Field, InlineStatus, Panel, ProgressSteps, StatusPill, VirtualDataTable } from "../ui/primitives.js";

type ReadyCheck = {
  ok: boolean;
  error?: string;
  queued?: number;
  running?: number;
  lastJobCompletedAt?: string | null;
};

type ReadyResponse = {
  ok: boolean;
  checks: Record<string, ReadyCheck>;
};

type WorkerStatus = {
  queued: number;
  running: number;
  lastJobCompletedAt: string | null;
};

type CheckRow = {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
};

type RuntimeVersion = {
  version: string;
  revision: string | null;
  buildDate: string | null;
};

type LatestRelease = {
  version: string | null;
  checkedAt: string | null;
  error: string | null;
  htmlUrl?: string | null;
};

type SelfUpdateStatus = {
  configured: boolean;
  config: SelfUpdateConfig;
  runtime: RuntimeVersion;
  latest: LatestRelease;
  updateAvailable: boolean;
  lastJob: OperationJob | null;
};

function checkDetail(check: ReadyCheck) {
  if (check.error) return check.error;
  const parts = [
    typeof check.queued === "number" ? `${check.queued} queued` : "",
    typeof check.running === "number" ? `${check.running} running` : "",
    check.lastJobCompletedAt ? `last completed ${formatDate(check.lastJobCompletedAt)}` : ""
  ].filter(Boolean);
  return parts.join(", ") || "Healthy";
}

async function getReadiness() {
  const response = await fetch("/api/health/ready", { credentials: "include" });
  const data = parseApiJson(await response.text());
  if (!data || typeof data !== "object" || !("checks" in data)) {
    throw new Error(`Readiness check failed with ${response.status}`);
  }
  return data as ReadyResponse;
}

function normalizeVersion(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/^v/i, "");
}

function compareVersions(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b || a === "latest" || b === "latest") return 0;
  const aParts = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const bParts = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(aParts.length, bParts.length, 3); index += 1) {
    const nextA = Number.isFinite(aParts[index]) ? aParts[index]! : 0;
    const nextB = Number.isFinite(bParts[index]) ? bParts[index]! : 0;
    if (nextA !== nextB) return nextA > nextB ? 1 : -1;
  }
  return 0;
}

export function OperationsPanel() {
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [failedJobs, setFailedJobs] = useState<OperationJob[]>([]);
  const [backupHealth, setBackupHealth] = useState<BackupHealthSummary | null>(null);
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPointListItem[]>([]);
  const [hosts, setHosts] = useState<DockerHost[]>([]);
  const [selfUpdate, setSelfUpdate] = useState<SelfUpdateStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [readyResult, workerResult, jobsResult, backupHealthResult, recoveryResult, hostsResult, selfUpdateResult] = await Promise.all([
        getReadiness(),
        api<{ worker: WorkerStatus }>("/api/jobs/status"),
        api<{ jobs: OperationJob[] }>("/api/jobs?limit=40"),
        api<{ health: BackupHealthSummary }>("/api/backups/health").catch(() => null),
        api<{ points: RecoveryPointListItem[] }>("/api/recovery/points").catch(() => null),
        api<{ hosts: DockerHost[] }>("/api/hosts").catch(() => null),
        api<SelfUpdateStatus>("/api/self-update").catch(() => null)
      ]);
      setReady(readyResult);
      setWorker(workerResult.worker);
      setFailedJobs(jobsResult.jobs.filter((job) => job.status === "failed"));
      setBackupHealth(backupHealthResult?.health ?? null);
      setRecoveryPoints(recoveryResult?.points ?? []);
      setHosts(hostsResult?.hosts ?? []);
      setSelfUpdate(selfUpdateResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows: CheckRow[] = Object.entries(ready?.checks ?? {}).map(([name, check]) => ({
    id: name,
    name,
    ok: check.ok,
    detail: checkDetail(check)
  }));
  const drilledCount = recoveryPoints.filter((point) => point.lastSuccessfulDrillAt).length;
  const failedDrillCount = recoveryPoints.filter((point) => point.lastDrillStatus === "failed").length;

  return (
    <Panel title="Operations">
      <div className="opsSummary">
        <div>
          <strong>Readiness</strong>
          <StatusPill status={ready?.ok ? "healthy" : "warning"} />
        </div>
        <div>
          <strong>Worker</strong>
          <span>{worker ? `${worker.queued} queued / ${worker.running} running` : "Loading"}</span>
        </div>
        <div>
          <strong>Last job</strong>
          <span>{worker?.lastJobCompletedAt ? formatDate(worker.lastJobCompletedAt) : "No completed jobs yet"}</span>
        </div>
        <div>
          <strong>Backups</strong>
          <span>{backupHealth ? backupHealth.overall.status : "Unavailable"}</span>
        </div>
        <div>
          <strong>Restore drills</strong>
          <span>{recoveryPoints.length ? `${drilledCount}/${recoveryPoints.length} passed${failedDrillCount ? `, ${failedDrillCount} failed` : ""}` : "No recovery points"}</span>
        </div>
        <div>
          <strong>Proof window</strong>
          <span>{backupHealth ? `${Math.round(backupHealth.proofStaleMs / 86_400_000)}d backup verify/drill` : "Unavailable"}</span>
        </div>
        <div>
          <strong>Failed jobs</strong>
          <span>{failedJobs.length}</span>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
      <ButtonRow>
        <button type="button" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
          Refresh health
        </button>
      </ButtonRow>
      <CardSection
        title="Readiness checks"
        aside={<InlineStatus tone={ready?.ok ? "success" : "warning"}>{ready?.ok ? "healthy" : "needs attention"}</InlineStatus>}
      >
        {!ready && !error ? (
          <div className="notice">Loading operations health...</div>
        ) : (
          <DataTable
            rows={rows}
            columns={["Check", "Status", "Detail"]}
            render={(row) => [
              row.name,
              <StatusPill key="status" status={row.ok ? "healthy" : "warning"} />,
              row.detail
            ]}
          />
        )}
      </CardSection>
      {selfUpdate && <SelfUpdateCard hosts={hosts} status={selfUpdate} onChanged={load} />}
      <CardSection title="Failed jobs" aside={<InlineStatus tone={failedJobs.length ? "danger" : "success"}>{failedJobs.length} failed</InlineStatus>}>
        <VirtualDataTable
          rows={failedJobs}
          maxRows={8}
          compact
          columns={["Type", "Phase", "Progress", "Correlation", "Failure / Recovery"]}
          render={(job) => [
            job.type,
            activeJobPhase(job),
            <ProgressSteps key="progress" steps={jobProgressSteps(job)} />,
            <code key="correlation">{job.correlationId}</code>,
            <div key="failure" className="jobFailureDetail">
              {job.error && <strong>{job.error}</strong>}
              <small>{jobRecoveryHint(job)}</small>
              <small>Created {formatDate(job.createdAt)}</small>
            </div>
          ]}
        />
      </CardSection>
    </Panel>
  );
}

function SelfUpdateCard({ hosts, status, onChanged }: { hosts: DockerHost[]; status: SelfUpdateStatus; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState<SelfUpdateConfig>(status.config);
  const [busy, setBusy] = useState<"saving" | "checking" | "starting" | "waiting" | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "warning" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    setForm(status.config);
  }, [status.config]);

  async function saveConfig() {
    setBusy("saving");
    setMessage(null);
    try {
      await putJson<{ config: SelfUpdateConfig }>("/api/self-update/config", form);
      setMessage({ tone: "success", text: "Self-update settings saved." });
      await onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(null);
    }
  }

  async function checkLatest() {
    setBusy("checking");
    setMessage(null);
    try {
      await postJson<SelfUpdateStatus & { latest: LatestRelease }>("/api/self-update/check", {});
      await onChanged();
    } catch (caught) {
      setMessage({ tone: "error", text: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setBusy(null);
    }
  }

  async function waitForRestart(expectedVersion: string | null, previousVersion: string) {
    setBusy("waiting");
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await sleep(2_000);
      try {
        const health = await api<RuntimeVersion & { ok: boolean }>("/api/health");
        const current = normalizeVersion(health.version);
        const expected = normalizeVersion(expectedVersion);
        if ((expected && current === expected) || (!expected && current && current !== normalizeVersion(previousVersion))) {
          setMessage({ tone: "success", text: `ComposeBastion is running v${health.version}.` });
          await onChanged();
          setBusy(null);
          return;
        }
      } catch {
        // The app may be restarting; keep polling.
      }
    }
    setMessage({ tone: "warning", text: "Update handoff started. The app did not confirm the new version yet; refresh after the containers finish restarting." });
    setBusy(null);
  }

  async function startUpdate() {
    setBusy("starting");
    setMessage(null);
    try {
      const targetVersion = form.versionMode === "latest"
        ? "latest"
        : form.targetVersion ?? undefined;
      await postJson<{ job: OperationJob }>("/api/self-update/start", { targetVersion });
      setMessage({ tone: "info", text: "Self-update handoff started. ComposeBastion may disconnect briefly while app and worker restart." });
      await onChanged();
      void waitForRestart(form.versionMode === "latest" ? status.latest.version : form.targetVersion, status.runtime.version);
    } catch (caught) {
      setMessage({ tone: "error", text: caught instanceof Error ? caught.message : String(caught) });
      setBusy(null);
    }
  }

  const latestText = status.latest.error
    ? status.latest.error
    : status.latest.version
      ? `v${status.latest.version}${status.latest.checkedAt ? ` checked ${formatDate(status.latest.checkedAt)}` : ""}`
      : "Not checked";
  const canStart = Boolean(form.hostId && form.workingDir && form.composeFile && (form.versionMode === "latest" || form.targetVersion));
  const latestKnown = Boolean(status.latest.version && !status.latest.error);
  const latestNotNewer = form.versionMode === "latest" && latestKnown && !status.updateAvailable;
  const pinnedNotNewer = form.versionMode === "pinned" && Boolean(form.targetVersion) && compareVersions(form.targetVersion, status.runtime.version) <= 0;
  const targetLabel = form.versionMode === "latest"
    ? status.latest.version ? `latest version v${status.latest.version}` : "latest image tag"
    : `v${form.targetVersion}`;
  const startLabel = latestNotNewer
    ? `Already at or above v${status.latest.version}`
    : pinnedNotNewer
      ? `Pinned version is not newer`
      : `Update to ${targetLabel}`;

  return (
    <CardSection
      title="ComposeBastion self-update"
      aside={<InlineStatus tone={status.updateAvailable ? "warning" : "success"}>{status.updateAvailable ? "update available" : "current"}</InlineStatus>}
    >
      <div className="selfUpdateSummary">
        <div>
          <strong>Running</strong>
          <span>v{status.runtime.version}</span>
        </div>
        <div>
          <strong>Latest</strong>
          <span>{latestText}</span>
        </div>
        <div>
          <strong>Last update job</strong>
          <span>{status.lastJob ? `${status.lastJob.status} ${formatDate(status.lastJob.updatedAt)}` : "None yet"}</span>
        </div>
      </div>
      <div className="selfUpdateForm">
        <Field label="Manager host">
          <select value={form.hostId ?? ""} onChange={(event) => setForm({ ...form, hostId: event.target.value || null })}>
            <option value="">Choose host</option>
            {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
          </select>
        </Field>
        <Field label="Compose directory">
          <input value={form.workingDir} onChange={(event) => setForm({ ...form, workingDir: event.target.value })} />
        </Field>
        <Field label="Compose file">
          <input value={form.composeFile} onChange={(event) => setForm({ ...form, composeFile: event.target.value })} />
        </Field>
        <Field label="Version mode">
          <select value={form.versionMode} onChange={(event) => setForm({ ...form, versionMode: event.target.value as SelfUpdateConfig["versionMode"], targetVersion: event.target.value === "latest" ? "latest" : status.latest.version ?? "" })}>
            <option value="latest">Follow latest</option>
            <option value="pinned">Pin release</option>
          </select>
        </Field>
        {form.versionMode === "pinned" && (
          <Field label="Target version">
            <input value={form.targetVersion ?? ""} onChange={(event) => setForm({ ...form, targetVersion: event.target.value })} />
          </Field>
        )}
      </div>
      {message && <div className={`notice ${message.tone === "error" ? "error" : message.tone === "success" ? "success" : message.tone === "warning" ? "warning" : ""}`}>{message.text}</div>}
      <ButtonRow>
        <button type="button" onClick={() => void saveConfig()} disabled={Boolean(busy)}>
          <Save size={16} />
          Save self-update
        </button>
        <button type="button" onClick={() => void checkLatest()} disabled={Boolean(busy)}>
          <RefreshCw size={16} className={busy === "checking" ? "spin" : undefined} />
          Check latest
        </button>
        <button type="button" className="primary" onClick={() => void startUpdate()} disabled={!canStart || latestNotNewer || pinnedNotNewer || Boolean(busy)}>
          <RefreshCw size={16} className={busy === "starting" || busy === "waiting" ? "spin" : undefined} />
          {startLabel}
        </button>
      </ButtonRow>
      {status.lastJob?.type === "system.self_update" && (
        <ProgressSteps steps={jobProgressSteps(status.lastJob)} />
      )}
    </CardSection>
  );
}
