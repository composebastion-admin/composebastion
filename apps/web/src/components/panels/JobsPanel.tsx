import { useState } from "react";
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
  const { canOperate: showActions } = useAuthorization();

  async function retry(job: OperationJob) {
    setBusyJobId(job.id);
    try {
      await postJson(`/api/jobs/${job.id}/retry`, {});
      await refresh();
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
    try {
      await postJson(`/api/jobs/${job.id}/cancel`, {});
      await refresh();
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
        <VirtualDataTable
          rows={jobs}
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
      </CardSection>
    </Panel>
  );
}
