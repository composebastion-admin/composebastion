import { useEffect, useMemo, useState } from "react";

export type HostMetricHistory = Record<string, Array<{ at: number; value: number }>>;

const HOST_METRIC_HISTORY_KEY = "composebastion.hostMetrics.history.v1";

function loadHostMetricHistory(): HostMetricHistory {
  try {
    const raw = window.localStorage.getItem(HOST_METRIC_HISTORY_KEY);
    return raw ? JSON.parse(raw) as HostMetricHistory : {};
  } catch {
    return {};
  }
}

export function useHostMetricHistory(hostId: string, values: Record<string, number | null | undefined>) {
  const [history, setHistory] = useState<HostMetricHistory>(() => loadHostMetricHistory());
  const valueKey = useMemo(
    () => Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value ?? ""}`).join("|"),
    [values]
  );

  useEffect(() => {
    const at = Date.now();
    setHistory((current) => {
      const next: HostMetricHistory = { ...current };
      for (const [metric, rawValue] of Object.entries(values)) {
        if (rawValue === null || rawValue === undefined || !Number.isFinite(rawValue)) continue;
        const key = `${hostId}:${metric}`;
        next[key] = [...(current[key] ?? []), { at, value: rawValue }].slice(-120);
      }
      window.localStorage.setItem(HOST_METRIC_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [hostId, valueKey, values]);

  return history;
}
