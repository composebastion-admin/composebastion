import type { DockerHost, MigrationRun, OperationJob } from "@dockermender/shared";
import { formatDate } from "../../../lib/format.js";
import { hostName } from "../../../lib/hostScope.js";
import { DataTable, Panel, StatusPill } from "../../ui/primitives.js";

function migrationAppLabel(run: MigrationRun) {
  const identity = run.sourceAppIdentity;
  if ("label" in identity && identity.label) return identity.label;
  if (identity.kind === "compose") return identity.projectName;
  if (identity.kind === "stack") return identity.projectName ?? identity.stackId;
  if (identity.kind === "git") return identity.projectName ?? identity.repositoryId;
  return identity.kind;
}

export function RecoveryRunsPanel({
  hosts,
  runs,
  jobs,
  refresh
}: {
  hosts: DockerHost[];
  runs: MigrationRun[];
  jobs: OperationJob[];
  refresh: () => Promise<void>;
}) {
  const recoveryJobs = jobs.filter((job) => job.type === "recovery.restore" || job.type === "migration.execute");

  return (
    <div className="stack">
      <Panel title="Migration Runs" count={runs.length}>
        <DataTable
          rows={runs}
          columns={["Mode", "App", "Source", "Target", "Status", "Created", "Error"]}
          render={(run) => [
            run.mode,
            migrationAppLabel(run),
            hostName(hosts, run.sourceHostId),
            hostName(hosts, run.targetHostId),
            <StatusPill key="status" status={run.status} />,
            formatDate(run.createdAt),
            run.error ?? "—"
          ]}
        />
      </Panel>
      <Panel title="Recent Restore / Migration Jobs" count={recoveryJobs.length}>
        <DataTable
          rows={recoveryJobs}
          columns={["Type", "Host", "Status", "Created", "Error"]}
          render={(job) => [
            job.type,
            hostName(hosts, job.hostId ?? ""),
            <StatusPill key="status" status={job.status} />,
            formatDate(job.createdAt),
            job.error ?? "—"
          ]}
        />
        <button type="button" onClick={() => void refresh()}>Refresh runs</button>
      </Panel>
    </div>
  );
}
