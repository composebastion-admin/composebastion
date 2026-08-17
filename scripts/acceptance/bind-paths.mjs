import path from "node:path";

function normalizedAbsolutePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || /[\r\n]/.test(value)) {
    return null;
  }
  return path.posix.normalize(value);
}

export function dockerBindPathAliases(value) {
  const normalized = normalizedAbsolutePath(value);
  if (!normalized) return [];

  const aliases = new Set([normalized]);
  if (normalized.startsWith("/host_mnt/")) {
    aliases.add(normalized.slice("/host_mnt".length));
  }
  for (const alias of [...aliases]) {
    if (alias.startsWith("/private/")) {
      aliases.add(alias.slice("/private".length));
    }
  }
  return [...aliases];
}

export function isDockerBindPathStrictlyBeneath(parent, child) {
  return dockerBindPathRelativeChild(parent, child) !== null;
}

export function dockerBindPathRelativeChild(parent, child) {
  const parentAliases = dockerBindPathAliases(parent);
  const childAliases = dockerBindPathAliases(child);
  for (const parentAlias of parentAliases) {
    const prefix = parentAlias === "/" ? "/" : `${parentAlias.replace(/\/+$/, "")}/`;
    for (const childAlias of childAliases) {
      if (childAlias === parentAlias || !childAlias.startsWith(prefix)) continue;
      const relative = childAlias.slice(prefix.length);
      if (relative && !relative.startsWith("/") && !relative.split("/").includes("..")) {
        return relative;
      }
    }
  }
  return null;
}
