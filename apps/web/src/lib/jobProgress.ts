import type { OperationJob } from "@composebastion/shared";
import type { ProgressStep } from "../components/ui/primitives.js";

function progressStatus(status: unknown): ProgressStep["status"] | null {
  if (status === "running") return "active";
  if (status === "completed") return "done";
  if (status === "pending" || status === "active" || status === "done" || status === "failed") return status;
  return null;
}

function customProgress(progress: unknown): ProgressStep[] | null {
  if (!Array.isArray(progress)) return null;
  const steps = progress.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const value = step as { label?: unknown; status?: unknown; detail?: unknown };
    if (typeof value.label !== "string") return [];
    const status = progressStatus(value.status);
    if (!status) return [];
    return [{
      label: value.label,
      status,
      detail: typeof value.detail === "string" ? value.detail : undefined
    }];
  });
  return steps.length ? steps : null;
}

export function jobProgressSteps(job: OperationJob): ProgressStep[] {
  const custom = customProgress(job.progress) ?? customProgress(job.result?.progress);
  if (custom) return custom;
  return [
    { label: "Queued", status: job.status === "queued" ? "active" : "done" },
    {
      label: "Running",
      status: job.status === "running"
        ? "active"
        : job.status === "queued" || job.status === "canceled"
          ? "pending"
          : "done"
    },
    {
      label: job.status === "failed" ? "Failed" : job.status === "canceled" ? "Canceled" : "Completed",
      status: job.status === "failed"
        ? "failed"
        : job.status === "completed"
          ? "done"
          : job.status === "canceled"
            ? "failed"
            : "pending"
    }
  ];
}

export function activeJobPhase(job: OperationJob) {
  const active = jobProgressSteps(job).find((step) => step.status === "active");
  if (active) return active.label;
  if (job.status === "failed") return "Failed";
  if (job.status === "canceled") return "Canceled";
  if (job.status === "completed") return "Completed";
  return "Pending";
}

export function jobRecoveryHint(job: Pick<OperationJob, "type" | "status" | "error">) {
  if (job.status === "queued") return "Waiting for a worker to claim the job.";
  if (job.status === "running") return "Watch progress and correlate logs with the job ID if it stalls.";
  if (job.status === "canceled") return "Retry when the host and inputs are ready.";
  if (job.status !== "failed") return "No recovery action needed.";

  if (job.type.includes("backup") || job.type.includes("restore") || job.type.startsWith("recovery.")) {
    return "Check backup target health, encryption settings, and restore drill notes before retrying.";
  }
  if (job.type.startsWith("migration.") || job.type.includes("clone")) {
    return "Review the migration run, source/target host reachability, and storage capacity before retrying.";
  }
  if (job.type === "host.sync" || job.type === "host.check") {
    return "Confirm SSH or agent connectivity, Docker availability, and host credentials.";
  }
  if (job.type.startsWith("image.") || job.type === "container.update" || job.type === "registry.login") {
    return "Check registry credentials, image availability, and update preview details.";
  }
  if (job.type.startsWith("container.") || job.type.startsWith("compose.") || job.type === "git.cloneDeploy") {
    return "Check container state, compose files, deployment logs, and host capacity before retrying.";
  }
  return job.error ? "Use the correlation ID to trace API and worker logs before retrying." : "Retry after confirming the target host is healthy.";
}
