import type { OperationJob } from "@dockermender/shared";

export type JobResult = { job: OperationJob };
export type MultiJobResult = { jobs: OperationJob[] };
export type Jobish = { job?: OperationJob; jobs?: OperationJob[] };
export type MetricTone = "ok" | "warning" | "danger" | "info";
export type OverviewMetricHistory = Record<string, Array<{ minute: number; value: number }>>;
export type ContainerMetricHistory = Record<string, { cpu: number[]; memory: number[] }>;
