import type { ResourceSnapshot } from "@dockermender/shared";
import { containerData } from "@dockermender/shared";
import type { OverviewMetricHistory } from "./dashboardTypes.js";

export const OVERVIEW_HISTORY_KEY = "dockermender.overview.history.v1";

export function containerStateLabel(state: string) {
  const normalized = state.toLowerCase();
  if (normalized === "exited") return "stopped";
  if (normalized === "dead") return "failed";
  return normalized || "unknown";
}

export function statusClassName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "unknown";
}

export function parsePercent(value: unknown) {
  const parsed = Number(String(value ?? "0").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function containerMetricKey(container: ResourceSnapshot) {
  return `${container.hostId}:${container.externalId}`;
}

export function pushMetricSample(samples: number[], value: number) {
  return [...samples.slice(-59), value];
}

export function findUsageRow(container: ResourceSnapshot, rows: Record<string, unknown>[]) {
  const data = containerData(container);
  return rows.find((item) => {
    const row = item as { ID?: string; Name?: string };
    return String(container.externalId).startsWith(String(row.ID)) || String(row.Name) === String(data.Names ?? container.name);
  }) as Record<string, unknown> | undefined;
}

export function loadOverviewHistory(): OverviewMetricHistory {
  try {
    const raw = window.localStorage.getItem(OVERVIEW_HISTORY_KEY);
    return raw ? JSON.parse(raw) as OverviewMetricHistory : {};
  } catch {
    return {};
  }
}

export function metricSeries(history: OverviewMetricHistory, key: string, currentValue: number) {
  const minute = Math.floor(Date.now() / 60_000);
  const samples = new Map((history[key] ?? []).map((sample) => [sample.minute, sample.value]));
  return Array.from({ length: 60 }, (_, index) => samples.get(minute - 59 + index) ?? currentValue);
}

export function metricDelta(history: OverviewMetricHistory, key: string, currentValue: number) {
  const minute = Math.floor(Date.now() / 60_000);
  const previousHour = history[key]?.find((sample) => sample.minute === minute - 60)?.value;
  return currentValue - (previousHour ?? currentValue);
}
