import { useMemo, useState } from "react";
import type { OperationJob } from "@composebastion/shared";
import { postJson } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { activeJobPhase, jobProgressSteps, jobRecoveryHint } from "../../lib/jobProgress.js";
import { useConfirm } from "../ConfirmProvider.js";
import { CardSection, InlineStatus, Panel, ProgressSteps, StatusPill, Toolbar, VirtualDataTable } from "../ui/primitives.js";
import { useAuthorization } from "../AuthorizationContext.js";

export function JobsPanel({ jobs, refresh }: { jobs: OperationJob[]; refresh: () => Promise<void> }) {
  const { confirm } = useConfirm();
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { canOperate: showActions } = useAuthorization();
  const pageSize = 20;
  const filteredJobs = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return jobs;
    return jobs.filter((job) => [
      job.type,
      job.status,
      job.correlationId,
      job.error ?? "",
      job.hostId ?? ""
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [jobs, query]);
  const maxPage = Math.max(0, Math.ceil(filteredJobs.length / pageSize) - 1);
  const currentPage = Math.min(page, maxPage);
  const visibleJobs = filteredJobs.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  async function retry(job: OperationJob) {
    setBusyJobId(job.id);
    setError(null);
    try {
      await postJson(`/api/jobs/${job.id}/retry`, {});
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyJobId(null);
    }
  }

  async function cancel(job: OperationJob) {
    const ok = await confirm({
      title: "Cancel queued job",
      message: `Cancel ${job.type}? Running jobs cannot be canceled from here.`,
      tone: "danger"
    });
    if (!ok) return;
    setBusyJobId(job.id);
    setError(null);
    try {
      await postJson(`/api/jobs/${job.id}/cancel`, {});
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <Panel title="Jobs" count={jobs.length}>
      <CardSection
        title="Operation jobs"
        aside={<InlineStatus tone="muted">{jobs.filter((job) => job.status === "failed").length} failed</InlineStatus>}
      >
        <Toolbar className="compactToolbar">
          <label>
            <span className="srOnly">Filter jobs</span>
            <input
              aria-label="Filter jobs"
              placeholder="Filter type, status, correlation, or error"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </label>
          <span>{filteredJobs.length} matching</span>
        </Toolbar>
        {error && <div className="notice error" role="alert">{error}</div>}
        <VirtualDataTable
          rows={visibleJobs}
          columns={[
            "Type",
            "Status",
            "Progress",
            "Created",
            "Correlation",
            "Failure / Recovery",
            ...(showActions ? ["Actions"] : [])
          ]}
          render={(job) => [
            job.type,
            <StatusPill key="status" status={job.status} />,
            <div key="progress" className="jobProgressCell">
              <ProgressSteps steps={jobProgressSteps(job)} />
              <small>Phase: {activeJobPhase(job)}</small>
            </div>,
            formatDate(job.createdAt),
            <code key="correlation">{job.correlationId}</code>,
            <div key="failure" className="jobFailureDetail">
              {job.error && <strong>{job.error}</strong>}
              <small>{jobRecoveryHint(job)}</small>
              {job.completedAt && <small>Finished {formatDate(job.completedAt)}</small>}
              <details>
                <summary>Job details</summary>
                <dl className="detailKeyValueGrid">
                  <div><dt>ID</dt><dd><code>{job.id}</code></dd></div>
                  <div><dt>Host</dt><dd><code>{job.hostId ?? "none"}</code></dd></div>
                  <div><dt>Created by</dt><dd><code>{job.createdBy ?? "system"}</code></dd></div>
                  <div><dt>Updated</dt><dd>{formatDate(job.updatedAt)}</dd></div>
                </dl>
              </details>
            </div>,
            ...(showActions ? [<Toolbar key="actions" className="compactToolbar">
                {(job.status === "failed" || job.status === "canceled") && (
                  <button type="button" disabled={busyJobId === job.id} onClick={() => void retry(job)}>Retry</button>
                )}
                {job.status === "queued" && (
                  <button type="button" className="danger" disabled={busyJobId === job.id} onClick={() => void cancel(job)}>Cancel</button>
                )}
              </Toolbar>] : [])
          ]}
        />
        {filteredJobs.length > pageSize && (
          <Toolbar className="compactToolbar">
            <button type="button" disabled={currentPage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous jobs</button>
            <span>Page {currentPage + 1} of {maxPage + 1}</span>
            <button type="button" disabled={currentPage >= maxPage} onClick={() => setPage((value) => Math.min(maxPage, value + 1))}>Next jobs</button>
          </Toolbar>
        )}
      </CardSection>
    </Panel>
  );
}
