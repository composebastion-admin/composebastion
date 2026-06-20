import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { BackupHealthSummary, OperationJob, RecoveryPointListItem } from "@composebastion/shared";
import { api, parseApiJson } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { activeJobPhase, jobProgressSteps, jobRecoveryHint } from "../../lib/jobProgress.js";
import { ButtonRow, CardSection, DataTable, InlineStatus, Panel, ProgressSteps, StatusPill, VirtualDataTable } from "../ui/primitives.js";

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

export function OperationsPanel() {
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [failedJobs, setFailedJobs] = useState<OperationJob[]>([]);
  const [backupHealth, setBackupHealth] = useState<BackupHealthSummary | null>(null);
  const [recoveryPoints, setRecoveryPoints] = useState<RecoveryPointListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [readyResult, workerResult, jobsResult, backupHealthResult, recoveryResult] = await Promise.all([
        getReadiness(),
        api<{ worker: WorkerStatus }>("/api/jobs/status"),
        api<{ jobs: OperationJob[] }>("/api/jobs?limit=40"),
        api<{ health: BackupHealthSummary }>("/api/backups/health").catch(() => null),
        api<{ points: RecoveryPointListItem[] }>("/api/recovery/points").catch(() => null)
      ]);
      setReady(readyResult);
      setWorker(workerResult.worker);
      setFailedJobs(jobsResult.jobs.filter((job) => job.status === "failed"));
      setBackupHealth(backupHealthResult?.health ?? null);
      setRecoveryPoints(recoveryResult?.points ?? []);
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
