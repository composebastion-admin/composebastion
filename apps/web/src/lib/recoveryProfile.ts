export function parseProfileLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function parseRestorePathMappings(value: string) {
  const entries: Record<string, string> = {};
  for (const line of parseProfileLines(value)) {
    const separator = line.includes("=>") ? "=>" : line.includes("=") ? "=" : "";
    if (!separator) continue;
    const [source, ...rest] = line.split(separator);
    const target = rest.join(separator).trim();
    if (source?.trim() && target) entries[source.trim()] = target;
  }
  return entries;
}

export function formatRestorePathMappings(paths: Record<string, string> | null | undefined) {
  return Object.entries(paths ?? {}).map(([source, target]) => `${source} => ${target}`).join("\n");
}
