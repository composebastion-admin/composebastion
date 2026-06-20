import { useEffect, useState } from "react";
import type { OverviewMetricHistory } from "../lib/dashboardTypes.js";
import { loadOverviewHistory, OVERVIEW_HISTORY_KEY } from "../lib/dockerMetrics.js";

export function useOverviewMetricHistory(values: Record<string, number>) {
  const [history, setHistory] = useState<OverviewMetricHistory>(() => loadOverviewHistory());
  const valueKey = Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join("|");

  useEffect(() => {
    const minute = Math.floor(Date.now() / 60_000);
    setHistory((current) => {
      const next: OverviewMetricHistory = {};
      for (const [key, value] of Object.entries(values)) {
        const samples = current[key]?.filter((sample) => sample.minute >= minute - 119 && sample.minute !== minute) ?? [];
        next[key] = [...samples, { minute, value }];
      }
      window.localStorage.setItem(OVERVIEW_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [valueKey, values]);

  return history;
}
