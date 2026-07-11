const numericIdentifier = String.raw`(?:0|[1-9][0-9]*)`;
const nonNumericIdentifier = String.raw`(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;
const buildIdentifier = String.raw`(?:[0-9A-Za-z-]+)`;

export const strictSemVerPattern = new RegExp(
  String.raw`^${numericIdentifier}\.${numericIdentifier}\.${numericIdentifier}`
  + String.raw`(?:-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*)?`
  + String.raw`(?:\+${buildIdentifier}(?:\.${buildIdentifier})*)?$`
);

export function isStrictSemVer(value) {
  return typeof value === "string" && strictSemVerPattern.test(value);
}
