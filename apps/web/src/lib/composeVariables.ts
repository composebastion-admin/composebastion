export type ComposeVariableOverride = {
  key: string;
  defaultValue: string;
  containerPort?: string;
  value: string;
};

export function parseEnvMap(env: string) {
  const values: Record<string, string> = {};
  env.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index <= 0) return;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  });
  return values;
}

export function upsertEnvValue(env: string, key: string, value: string) {
  const lines = env.trim() ? env.split(/\r?\n/) : [];
  let changed = false;
  const next = lines.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(`${key}=`)) return line;
    changed = true;
    return `${key}=${value}`;
  });
  if (!changed) next.push(`${key}=${value}`);
  return next.filter((line, index, all) => line.trim() || (index > 0 && index < all.length - 1)).join("\n");
}

export function composeVariableOverrides(composeYaml: string, env: string) {
  const envValues = parseEnvMap(env);
  const variables = new Map<string, ComposeVariableOverride>();
  const addVariable = (key: string, defaultValue: string, containerPort?: string) => {
    const existing = variables.get(key);
    if (existing) {
      if (!existing.defaultValue && defaultValue) {
        existing.defaultValue = defaultValue;
        if (envValues[key] === undefined) existing.value = defaultValue;
      }
      if (!existing.containerPort && containerPort) existing.containerPort = containerPort;
      return;
    }
    variables.set(key, {
      key,
      defaultValue,
      containerPort,
      value: envValues[key] ?? defaultValue
    });
  };
  const bracedMatcher = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g;
  let match: RegExpExecArray | null;
  while ((match = bracedMatcher.exec(composeYaml)) !== null) {
    const key = match[1];
    if (!key) continue;
    const operator = match[2] ?? "";
    const defaultValue = operator.includes("-") ? match[3] ?? "" : "";
    const portMatch = composeYaml.slice(bracedMatcher.lastIndex).match(/^:(\d+)(?:\/(?:tcp|udp))?/);
    addVariable(key, defaultValue, portMatch?.[1]);
  }
  const plainMatcher = /(^|[^$])\$([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((match = plainMatcher.exec(composeYaml)) !== null) {
    const key = match[2];
    if (!key) continue;
    const portMatch = composeYaml.slice(plainMatcher.lastIndex).match(/^:(\d+)(?:\/(?:tcp|udp))?/);
    addVariable(key, "", portMatch?.[1]);
  }
  return Array.from(variables.values()).sort((left, right) => {
    if (left.containerPort && !right.containerPort) return -1;
    if (!left.containerPort && right.containerPort) return 1;
    return left.key.localeCompare(right.key);
  });
}
