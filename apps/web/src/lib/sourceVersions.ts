import type { AppGithubVersionKind, AppGithubVersionOption } from "@composebastion/shared";

export const githubVersionKinds: AppGithubVersionKind[] = ["branch", "tag", "release"];

export const githubVersionKindLabels: Record<AppGithubVersionKind, string> = {
  branch: "Branches",
  tag: "Tags",
  release: "Releases"
};

export function shortVersionSha(value?: string | null) {
  return value ? value.slice(0, 12) : "unknown";
}

function normalizedVersionLabel(value: string) {
  return value.trim().replace(/^v/i, "");
}

function parseVersion(value: string) {
  const match = normalizedVersionLabel(value).match(/^(\d+(?:\.\d+){0,4})(?:[-._]?([a-z][a-z0-9-]*?)(?:[.-]?(\d+))?)?$/i);
  if (!match) return null;
  return {
    numbers: match[1]!.split(".").map((part) => Number(part)),
    prerelease: (match[2] ?? "").toLowerCase(),
    prereleaseNumber: Number(match[3] ?? 0)
  };
}

export function compareGithubVersionOptions(left: AppGithubVersionOption, right: AppGithubVersionOption) {
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  if (left.deployed !== right.deployed) return left.deployed ? -1 : 1;
  if (left.updateAvailable !== right.updateAvailable) return left.updateAvailable ? -1 : 1;

  const leftVersion = parseVersion(left.ref);
  const rightVersion = parseVersion(right.ref);
  if (leftVersion && rightVersion) {
    const length = Math.max(leftVersion.numbers.length, rightVersion.numbers.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (rightVersion.numbers[index] ?? 0) - (leftVersion.numbers[index] ?? 0);
      if (diff !== 0) return diff;
    }
    if (!leftVersion.prerelease && rightVersion.prerelease) return -1;
    if (leftVersion.prerelease && !rightVersion.prerelease) return 1;
    const prereleaseDiff = leftVersion.prerelease.localeCompare(rightVersion.prerelease);
    if (prereleaseDiff !== 0) return prereleaseDiff;
    const prereleaseNumberDiff = rightVersion.prereleaseNumber - leftVersion.prereleaseNumber;
    if (prereleaseNumberDiff !== 0) return prereleaseNumberDiff;
  } else if (leftVersion) {
    return -1;
  } else if (rightVersion) {
    return 1;
  }

  return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
}

export function groupGithubVersionOptions(options: AppGithubVersionOption[], query = "") {
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? options.filter((option) =>
      option.label.toLowerCase().includes(normalized) ||
      option.ref.toLowerCase().includes(normalized) ||
      option.name.toLowerCase().includes(normalized)
    )
    : options;
  return githubVersionKinds.map((kind) => ({
    kind,
    label: githubVersionKindLabels[kind],
    options: filtered.filter((option) => option.kind === kind).sort(compareGithubVersionOptions)
  }));
}

export function countGithubVersionUpdates(options: AppGithubVersionOption[]) {
  return options.filter((option) => option.updateAvailable).length;
}
