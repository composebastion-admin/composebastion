import { compareLooseVersionTags, parseLooseVersionTag, type AppGithubVersionKind, type AppGithubVersionOption } from "@composebastion/shared";

export const githubVersionKinds: AppGithubVersionKind[] = ["branch", "tag", "release"];

export const githubVersionKindLabels: Record<AppGithubVersionKind, string> = {
  branch: "Branches",
  tag: "Tags",
  release: "Releases"
};

export function shortVersionSha(value?: string | null) {
  return value ? value.slice(0, 12) : "unknown";
}

export function compareGithubVersionOptions(left: AppGithubVersionOption, right: AppGithubVersionOption) {
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  if (left.deployed !== right.deployed) return left.deployed ? -1 : 1;
  if (left.updateAvailable !== right.updateAvailable) return left.updateAvailable ? -1 : 1;

  const leftVersion = parseLooseVersionTag(left.ref);
  const rightVersion = parseLooseVersionTag(right.ref);
  if (leftVersion && rightVersion) {
    const comparison = compareLooseVersionTags(rightVersion, leftVersion);
    if (comparison) return comparison;
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
