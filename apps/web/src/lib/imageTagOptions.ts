import { compareReleaseVersions, isStableReleaseVersion, parseReleaseVersion } from "@composebastion/shared";

const channelPriority = new Map([
  ["latest", 0],
  ["main", 1],
  ["stable", 2],
  ["beta", 3],
  ["dev", 4],
  ["nightly", 5],
  ["edge", 6]
]);

type ParsedVersion = {
  normalized: string;
  prerelease: boolean;
};

function parseVersionTag(value: string): ParsedVersion | null {
  const normalized = parseReleaseVersion(value);
  if (!normalized) return null;
  return {
    normalized,
    prerelease: !isStableReleaseVersion(normalized)
  };
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion) {
  return compareReleaseVersions(right.normalized, left.normalized) ?? 0;
}

export function isImageChannelTag(tag: string) {
  return channelPriority.has(tag.trim().toLowerCase());
}

export function isPrereleaseImageChannelTag(tag: string) {
  const normalized = tag.trim().toLowerCase();
  return normalized === "beta" || normalized === "dev" || normalized === "nightly" || normalized === "edge";
}

function parsedVersionEntry(tag: string) {
  const parsed = parseVersionTag(tag);
  if (!parsed || isImageChannelTag(tag)) return null;
  return { tag, parsed };
}

export function latestStableImageTag(tags: string[]) {
  return tags
    .map(parsedVersionEntry)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && !entry.parsed.prerelease))
    .sort((left, right) => compareParsedVersions(left.parsed, right.parsed))[0]?.tag ?? null;
}

export function latestPrereleaseImageTag(tags: string[]) {
  return tags
    .map(parsedVersionEntry)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.parsed.prerelease))
    .sort((left, right) => compareParsedVersions(left.parsed, right.parsed))[0]?.tag ?? null;
}

export function isVersionImageTag(tag: string) {
  return Boolean(parsedVersionEntry(tag));
}

export function isNewerVersionTag(candidate: string | null | undefined, current: string | null | undefined) {
  const candidateEntry = candidate ? parsedVersionEntry(candidate) : null;
  const currentEntry = current ? parsedVersionEntry(current) : null;
  if (!candidateEntry || !currentEntry) return false;
  return (compareReleaseVersions(candidateEntry.parsed.normalized, currentEntry.parsed.normalized) ?? 0) > 0;
}

export function recommendedImageVersionTag(tags: string[], currentTag: string) {
  const latestStable = latestStableImageTag(tags);
  const latestPrerelease = latestPrereleaseImageTag(tags);
  const normalizedCurrent = currentTag.trim().toLowerCase();

  if (isImageChannelTag(currentTag)) {
    if (isPrereleaseImageChannelTag(normalizedCurrent)) {
      return latestPrerelease ?? latestStable;
    }
    return latestStable ?? latestPrerelease;
  }

  const currentEntry = parsedVersionEntry(currentTag);
  if (!currentEntry) return null;
  if (currentEntry.parsed.prerelease) {
    if (isNewerVersionTag(latestPrerelease, currentTag)) return latestPrerelease;
    if (isNewerVersionTag(latestStable, currentTag)) return latestStable;
    return null;
  }

  return isNewerVersionTag(latestStable, currentTag) ? latestStable : null;
}

export function summarizeImageVersionTags(tags: string[], currentTag: string) {
  const latestStable = latestStableImageTag(tags);
  const latestPrerelease = latestPrereleaseImageTag(tags);
  const recommendedUpdateTag = recommendedImageVersionTag(tags, currentTag);
  return {
    currentTag,
    latestStable,
    latestPrerelease,
    stableUpdateAvailable: isNewerVersionTag(latestStable, currentTag),
    prereleaseUpdateAvailable: isNewerVersionTag(latestPrerelease, currentTag),
    recommendedUpdateTag,
    versionUpdateAvailable: Boolean(recommendedUpdateTag && (isPrereleaseImageChannelTag(currentTag) || isNewerVersionTag(recommendedUpdateTag, currentTag)))
  };
}

export function compareImageTags(left: string, right: string) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  const leftChannel = channelPriority.get(normalizedLeft);
  const rightChannel = channelPriority.get(normalizedRight);
  if (leftChannel !== undefined || rightChannel !== undefined) {
    return (leftChannel ?? 99) - (rightChannel ?? 99);
  }

  const leftVersion = parseVersionTag(left);
  const rightVersion = parseVersionTag(right);
  if (leftVersion && rightVersion) return compareParsedVersions(leftVersion, rightVersion);
  if (leftVersion) return -1;
  if (rightVersion) return 1;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function uniqueSortedImageTags(...tagGroups: Array<Array<string | null | undefined>>) {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const group of tagGroups) {
    for (const tag of group) {
      const normalized = tag?.trim();
      if (!normalized || normalized === "<none>" || seen.has(normalized)) continue;
      seen.add(normalized);
      tags.push(normalized);
    }
  }
  return tags.sort(compareImageTags);
}

export function filterImageTags(tags: string[], query: string, limit = 80) {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized ? tags.filter((tag) => tag.toLowerCase().includes(normalized)) : tags;
  return filtered.slice(0, limit);
}
