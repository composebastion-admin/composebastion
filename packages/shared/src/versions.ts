import { compare, prerelease, valid } from "semver";

function normalizedInput(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown" || trimmed.toLowerCase() === "latest") return null;
  return trimmed.replace(/^v(?=\d)/i, "");
}

export function parseReleaseVersion(value: string | null | undefined) {
  const normalized = normalizedInput(value);
  return normalized && valid(normalized) ? normalized : null;
}

export function compareReleaseVersions(left: string | null | undefined, right: string | null | undefined) {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);
  return parsedLeft && parsedRight ? compare(parsedLeft, parsedRight) : null;
}

export function isStableReleaseVersion(value: string | null | undefined) {
  const parsed = parseReleaseVersion(value);
  return Boolean(parsed && prerelease(parsed) === null);
}

export function parseLooseVersionTag(value: string | null | undefined) {
  const normalized = normalizedInput(value);
  if (!normalized) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(normalized);
  if (!match) return null;
  const padded = `${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}${match[4] ?? ""}`;
  return valid(padded) ? padded : null;
}

export function compareLooseVersionTags(left: string | null | undefined, right: string | null | undefined) {
  const parsedLeft = parseLooseVersionTag(left);
  const parsedRight = parseLooseVersionTag(right);
  return parsedLeft && parsedRight ? compare(parsedLeft, parsedRight) : null;
}
