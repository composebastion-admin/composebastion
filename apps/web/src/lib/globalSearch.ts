import type { DockerHost, ResourceSnapshot } from "@composebastion/shared";
import type { Tab } from "./navigation.js";

export type SearchResult =
  | { kind: "host"; hostId: string; label: string; detail: string; tab: Tab }
  | { kind: "resource"; hostId: string; resourceId: string; label: string; detail: string; tab: Tab };

const resourceTab: Record<ResourceSnapshot["kind"], Tab> = {
  container: "containers",
  image: "images",
  volume: "volumes",
  network: "networks"
};

function matchesQuery(value: string, query: string) {
  return value.toLowerCase().includes(query.toLowerCase());
}

export function searchScope(
  hosts: DockerHost[],
  resources: ResourceSnapshot[],
  scopedHostIds: string[],
  query: string,
  limit = 12
): SearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const scope = new Set(scopedHostIds);
  const results: SearchResult[] = [];

  for (const host of hosts) {
    if (!scope.has(host.id)) continue;
    const haystack = [host.name, host.hostname, host.username, host.tags.join(" ")].join(" ");
    if (matchesQuery(haystack, trimmed)) {
      results.push({
        kind: "host",
        hostId: host.id,
        label: host.name,
        detail: `${host.username}@${host.hostname}`,
        tab: "overview"
      });
    }
  }

  for (const resource of resources) {
    if (!scope.has(resource.hostId)) continue;
    const haystack = [resource.name, resource.externalId, resource.kind].join(" ");
    if (!matchesQuery(haystack, trimmed)) continue;
    results.push({
      kind: "resource",
      hostId: resource.hostId,
      resourceId: resource.id,
      label: resource.name,
      detail: resource.kind,
      tab: resourceTab[resource.kind]
    });
  }

  return results.slice(0, limit);
}
