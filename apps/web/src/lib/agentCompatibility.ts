export const MIN_COMPATIBLE_AGENT_VERSION = "0.10.0-pre.1";

function versionParts(version: string | null | undefined) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:-pre\.(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? null : Number(match[4])
  };
}

export function describeAgentCompatibility(version: string | null | undefined) {
  const current = versionParts(version);
  const minimum = versionParts(MIN_COMPATIBLE_AGENT_VERSION)!;
  if (!current) return { status: "unknown" as const, label: "Agent version unknown" };
  const compatible = current.major !== minimum.major
    ? current.major > minimum.major
    : current.minor !== minimum.minor
      ? current.minor > minimum.minor
      : current.patch !== minimum.patch
        ? current.patch > minimum.patch
        : current.pre === null || (minimum.pre !== null && current.pre >= minimum.pre);
  return compatible
    ? { status: "compatible" as const, label: `Agent ${version}` }
    : { status: "outdated" as const, label: `Agent ${version} needs update` };
}
