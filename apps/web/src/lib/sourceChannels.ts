export const sourceChannels = ["main", "beta", "dev"] as const;

export type SourceChannel = typeof sourceChannels[number];

export function imageTagFromReference(reference: string) {
  const withoutDigest = reference.trim().split("@")[0] ?? "";
  const slashIndex = withoutDigest.lastIndexOf("/");
  const tagIndex = withoutDigest.lastIndexOf(":");
  return tagIndex > slashIndex ? withoutDigest.slice(tagIndex + 1) : "";
}

export function imageReferenceWithTag(reference: string, tag: string) {
  const trimmed = reference.trim();
  if (!trimmed) return "";
  const withoutDigest = trimmed.split("@")[0] ?? trimmed;
  const slashIndex = withoutDigest.lastIndexOf("/");
  const tagIndex = withoutDigest.lastIndexOf(":");
  const base = tagIndex > slashIndex ? withoutDigest.slice(0, tagIndex) : withoutDigest;
  return `${base}:${tag}`;
}

export function activeSourceChannel(sourceType: "image" | "compose" | "git", branch: string, imageReference: string) {
  if (sourceType === "git") return branch.trim();
  if (sourceType === "image") return imageTagFromReference(imageReference);
  return "";
}
