import { compareReleaseVersions, parseReleaseVersion } from "@composebastion/shared";

export const MIN_COMPATIBLE_AGENT_VERSION = "0.9.0";

export function describeAgentCompatibility(version: string | null | undefined) {
  const current = parseReleaseVersion(version);
  const comparison = compareReleaseVersions(current, MIN_COMPATIBLE_AGENT_VERSION);
  if (!current || comparison === null) return { status: "unknown" as const, label: "Agent version unknown" };
  const compatible = comparison >= 0;
  return compatible
    ? { status: "compatible" as const, label: `Agent ${version}` }
    : { status: "outdated" as const, label: `Agent ${version} needs update` };
}
