export function normalizeLayerPath(value) {
  if (typeof value !== "string") {
    throw new TypeError("OCI layer paths must be strings");
  }
  if (value.startsWith("/")) {
    throw new Error(`OCI layer paths must be relative POSIX paths, got ${JSON.stringify(value)}`);
  }
  const segments = value.split("/");
  if (segments.includes("..")) {
    throw new Error(`OCI layer paths must not traverse parent directories, got ${JSON.stringify(value)}`);
  }
  return segments
    .filter((segment) => segment && segment !== ".")
    .join("/");
}

export function addLayerEntry(entries, entry) {
  const normalized = normalizeLayerPath(entry);
  if (!normalized) return null;
  if (entries.has(normalized)) {
    throw new Error(
      `OCI layer contains duplicate normalized member ${JSON.stringify(normalized)}`
    );
  }
  entries.set(normalized, entry);
  return normalized;
}

export function layerHidesTarget(entries, target) {
  const segments = normalizeLayerPath(target).split("/");
  if (entries.has(".wh..wh..opq")) return ".wh..wh..opq";
  for (let index = 0; index < segments.length; index += 1) {
    const parent = segments.slice(0, index).join("/");
    const whiteout = [parent, `.wh.${segments[index]}`].filter(Boolean).join("/");
    if (entries.has(whiteout)) return whiteout;
    if (index < segments.length - 1) {
      const directory = segments.slice(0, index + 1).join("/");
      const opaque = `${directory}/.wh..wh..opq`;
      if (entries.has(opaque)) return opaque;
    }
  }
  return null;
}

export function resolveLayerTarget(entries, target) {
  const normalizedTarget = normalizeLayerPath(target);
  const entry = entries.get(normalizedTarget);
  if (entry) return { entry, whiteout: null };
  return { entry: null, whiteout: layerHidesTarget(entries, normalizedTarget) };
}
