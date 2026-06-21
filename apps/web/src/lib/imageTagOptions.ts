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
