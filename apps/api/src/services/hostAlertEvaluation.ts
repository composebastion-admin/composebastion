import type { HostMetricAlertCondition, HostStats, HostThresholdParams } from "@composebastion/shared";

export type HostThresholdEvaluation = {
  value: number | null;
  overThreshold: boolean;
  triggered: boolean;
  nextBreachingSince: Date | null;
  message: string;
};

function percent(usedBytes: number, totalBytes: number) {
  if (totalBytes <= 0) return null;
  return Math.round((usedBytes / totalBytes) * 100);
}

function valueForCondition(condition: HostMetricAlertCondition, params: HostThresholdParams, stats: HostStats) {
  if (condition === "host.cpu") return stats.cpuPercent;
  if (condition === "host.memory") return percent(stats.memory.usedBytes, stats.memory.totalBytes);
  if (condition === "host.swap") return stats.swap.totalBytes <= 0 ? 0 : percent(stats.swap.usedBytes, stats.swap.totalBytes);
  if (condition === "host.disk") {
    const disk = params.mount
      ? stats.disks.find((item) => item.mount === params.mount)
      : stats.disks.reduce<{ usedPercent: number } | null>((max, item) => !max || item.usedPercent > max.usedPercent ? item : max, null);
    return disk?.usedPercent ?? null;
  }
  if (condition === "host.load") return stats.load?.one ?? null;
  return null;
}

function conditionLabel(condition: HostMetricAlertCondition) {
  if (condition === "host.cpu") return "CPU";
  if (condition === "host.memory") return "memory";
  if (condition === "host.disk") return "disk";
  if (condition === "host.swap") return "swap";
  return "load";
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function formatMetricValue(condition: HostMetricAlertCondition, value: number) {
  return condition === "host.load" ? formatNumber(value) : `${Math.round(value)}%`;
}

function formatDuration(seconds: number) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function evaluateHostThreshold(
  condition: HostMetricAlertCondition,
  params: HostThresholdParams,
  stats: HostStats,
  breachingSince: Date | string | null,
  now: Date,
  hostName = "Host"
): HostThresholdEvaluation {
  const value = valueForCondition(condition, params, stats);
  const label = conditionLabel(condition);
  const target = condition === "host.disk" && params.mount ? `${label} ${params.mount}` : label;

  if (value === null) {
    return {
      value,
      overThreshold: false,
      triggered: false,
      nextBreachingSince: null,
      message: `${hostName} ${target} metric is unavailable`
    };
  }

  const overThreshold = params.comparator === "gt" ? value > params.threshold : value >= params.threshold;
  const currentBreachingSince = breachingSince ? new Date(breachingSince) : null;
  const nextBreachingSince = overThreshold ? currentBreachingSince ?? now : null;
  const elapsedMs = nextBreachingSince ? now.getTime() - nextBreachingSince.getTime() : 0;
  const triggered = overThreshold && elapsedMs >= params.durationSeconds * 1000;
  const comparator = params.comparator === "gt" ? ">" : ">=";

  return {
    value,
    overThreshold,
    triggered,
    nextBreachingSince,
    message: `${hostName} ${target} ${formatMetricValue(condition, value)} ${comparator} ${formatMetricValue(condition, params.threshold)} for ${formatDuration(params.durationSeconds)}`
  };
}
