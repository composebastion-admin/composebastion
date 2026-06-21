import type { ResourceSnapshot } from "@composebastion/shared";
import { containerData } from "@composebastion/shared";
import { containerStateLabel } from "./dockerMetrics.js";

export type ContainerSortKey = "name" | "state" | "image";
export type ContainerStateFilter = "all" | "running" | "stopped";

export function filterAndSortContainers(
  containers: ResourceSnapshot[],
  query: string,
  stateFilter: ContainerStateFilter,
  sortKey: ContainerSortKey,
  sortDesc: boolean
) {
  const normalizedQuery = query.trim().toLowerCase();
  let rows = containers.filter((container) => {
    const data = containerData(container);
    const name = String(data.Names ?? container.name).toLowerCase();
    const image = String(data.Image ?? "").toLowerCase();
    const state = containerStateLabel(String(data.State ?? ""));
    if (stateFilter === "running" && state !== "running") return false;
    if (stateFilter === "stopped" && state === "running") return false;
    if (!normalizedQuery) return true;
    return name.includes(normalizedQuery) || image.includes(normalizedQuery) || state.includes(normalizedQuery);
  });

  rows = [...rows].sort((left, right) => {
    const leftData = containerData(left);
    const rightData = containerData(right);
    const compare = (() => {
      if (sortKey === "state") {
        return containerStateLabel(String(leftData.State ?? "")).localeCompare(containerStateLabel(String(rightData.State ?? "")));
      }
      if (sortKey === "image") {
        return String(leftData.Image ?? "").localeCompare(String(rightData.Image ?? ""));
      }
      return String(leftData.Names ?? left.name).localeCompare(String(rightData.Names ?? right.name));
    })();
    return sortDesc ? -compare : compare;
  });

  return rows;
}
