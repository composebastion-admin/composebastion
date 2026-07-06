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
  numbers: number[];
  prerelease: string;
  prereleaseNumber: number;
};

function parseVersionTag(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(\d+(?:\.\d+){0,4})(?:[-._]?([a-z][a-z0-9-]*?)(?:[.-]?(\d+))?)?$/i);
  if (!match) return null;
  return {
    numbers: match[1]!.split(".").map((part) => Number(part)),
    prerelease: (match[2] ?? "").toLowerCase(),
    prereleaseNumber: Number(match[3] ?? 0)
  };
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion) {
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (right.numbers[index] ?? 0) - (left.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.prerelease && right.prerelease) return -1;
  if (left.prerelease && !right.prerelease) return 1;
  const prereleaseDiff = left.prerelease.localeCompare(right.prerelease);
  if (prereleaseDiff !== 0) return prereleaseDiff;
  return right.prereleaseNumber - left.prereleaseNumber;
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
  return compareParsedVersions(candidateEntry.parsed, currentEntry.parsed) < 0;
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
