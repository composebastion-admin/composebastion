export type DockerStatsRecord = Record<string, unknown>;

const fullContainerIdPattern = /^[0-9a-f]{64}$/i;
const abbreviatedContainerIdPattern = /^[0-9a-f]{12,64}$/i;

function isRecord(value: unknown): value is DockerStatsRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function usableContainerName(value: unknown): value is string {
  return nonBlankString(value) && value.trim() !== "--";
}

function normalizedContainerId(value: unknown) {
  if (!nonBlankString(value)) return null;
  const normalized = value.trim();
  return /^[0-9a-f]+$/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizedContainerName(value: unknown) {
  return usableContainerName(value) ? value.trim() : null;
}

function identityParts(value: unknown) {
  if (!isDockerStatsRecord(value)) return { ids: [] as string[], names: [] as string[] };
  const ids = [
    normalizedContainerId(value.ID),
    typeof value.Container === "string" && fullContainerIdPattern.test(value.Container)
      ? value.Container.toLowerCase()
      : null
  ].filter((identity): identity is string => identity !== null);
  const names = [
    normalizedContainerName(value.Name),
    normalizedContainerName(value.Names)
  ].filter((identity): identity is string => identity !== null);
  return {
    ids: [...new Set(ids)],
    names: [...new Set(names)]
  };
}

/**
 * Docker 29 emits this terminal identity when a container disappears from a
 * continuous `docker stats` stream. The metrics can vary between Docker
 * releases, so the lifecycle identity itself is the stable discriminator.
 */
export function isDockerStatsLifecycleTombstone(value: unknown): boolean {
  return isRecord(value)
    && typeof value.Container === "string"
    && fullContainerIdPattern.test(value.Container)
    && value.ID === ""
    && value.Name === "--";
}

/**
 * Returns true only for a Docker stats object with a usable container
 * identity. Lifecycle tombstones are recognized separately and never count as
 * stats records.
 */
export function isDockerStatsRecord(value: unknown): value is DockerStatsRecord {
  if (!isRecord(value) || isDockerStatsLifecycleTombstone(value)) return false;
  return nonBlankString(value.ID)
    || usableContainerName(value.Name)
    || usableContainerName(value.Names);
}

export function dockerStatsIdentityKeys(value: unknown) {
  if (!isDockerStatsRecord(value)) return [];
  const { ids, names } = identityParts(value);
  return [
    ...ids.map((identity) => `id:${identity}`),
    ...names.map((identity) => `name:${identity}`)
  ];
}

function containerIdsMatch(left: string, right: string) {
  if (left === right) return true;
  if (!abbreviatedContainerIdPattern.test(left) || !abbreviatedContainerIdPattern.test(right)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function dockerStatsRecordsMatch(left: unknown, right: unknown) {
  if (!isDockerStatsRecord(left) || !isDockerStatsRecord(right)) return false;
  const leftIdentity = identityParts(left);
  const rightIdentity = identityParts(right);
  return leftIdentity.ids.some((leftId) => rightIdentity.ids.some((rightId) => containerIdsMatch(leftId, rightId)))
    || leftIdentity.names.some((leftName) => rightIdentity.names.includes(leftName));
}
