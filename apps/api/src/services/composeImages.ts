export function extractImagesFromCompose(composeYaml: string) {
  const images = new Set<string>();
  const imageLine = /^\s*image:\s*["']?([^"'\s]+)["']?\s*$/gm;
  for (const match of composeYaml.matchAll(imageLine)) {
    const image = resolveImageDefaults(match[1]?.trim() ?? "");
    // A value that still contains a variable cannot be safely resolved until
    // Docker Compose reads the host's environment. It must not be sent to the
    // registry-reference parser as though it were a literal image name.
    if (image && !image.includes("${")) images.add(image);
  }
  return Array.from(images);
}

/**
 * Compose permits a useful pattern such as `image: registry/app:${TAG:-latest}`.
 * For the limited purpose of locating saved registry credentials, its fallback
 * is a valid literal reference. Leave other interpolation forms untouched: they
 * depend on the host environment and Compose will resolve them at deploy time.
 */
function resolveImageDefaults(image: string) {
  return image.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-)([^${}]*)\}/g, "$1");
}
