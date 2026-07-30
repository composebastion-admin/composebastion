import { createHmac } from "node:crypto";
import { appSecretKey } from "../config/env.js";

const ENV_BINDING_DOMAIN = "composebastion:deployment-environment:v1";
export const SENSITIVE_ENVIRONMENT_NAME =
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth|database[_-]?url|dsn|connection[_-]?string)/i;

function skipToNextLine(value: string, start: number) {
  const newline = value.indexOf("\n", start);
  return newline === -1 ? value.length : newline + 1;
}

function decodeDoubleQuotedCharacter(character: string) {
  if (character === "n") return "\n";
  if (character === "r") return "\r";
  if (character === "t") return "\t";
  if (character === "\\") return "\\";
  if (character === "\"") return "\"";
  if (character === "$") return "$$";
  return `\\${character}`;
}

/**
 * Parse the dotenv subset accepted by Docker Compose while preserving the
 * semantic value that will later be emitted through a canonical env file.
 * Duplicate keys use the final value, matching Compose.
 */
export function parseDeploymentEnvironment(value: string) {
  const result = new Map<string, string>();
  let index = 0;
  while (index < value.length) {
    while (value[index] === " " || value[index] === "\t" || value[index] === "\r") index += 1;
    if (value[index] === "\n") {
      index += 1;
      continue;
    }
    if (value[index] === "#") {
      index = skipToNextLine(value, index);
      continue;
    }
    if (
      value.slice(index, index + 6) === "export"
      && (value[index + 6] === " " || value[index + 6] === "\t")
    ) {
      index += 6;
      while (value[index] === " " || value[index] === "\t") index += 1;
    }
    const keyMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(index));
    if (!keyMatch) {
      index = skipToNextLine(value, index);
      continue;
    }
    const key = keyMatch[0];
    index += key.length;
    while (value[index] === " " || value[index] === "\t") index += 1;
    if (value[index] !== "=") {
      index = skipToNextLine(value, index);
      continue;
    }
    index += 1;
    while (value[index] === " " || value[index] === "\t") index += 1;

    let parsed = "";
    let interpolate = true;
    if (value[index] === "'" || value[index] === "\"") {
      const quote = value[index]!;
      interpolate = quote !== "'";
      index += 1;
      while (index < value.length) {
        const character = value[index]!;
        if (character === quote) {
          index += 1;
          break;
        }
        if (character === "\\" && index + 1 < value.length) {
          const next = value[index + 1]!;
          if (quote === "'" && next === "'") {
            parsed += "'";
            index += 2;
            continue;
          }
          if (quote === "\"") {
            parsed += decodeDoubleQuotedCharacter(next);
            index += 2;
            continue;
          }
        }
        parsed += character;
        index += 1;
      }
      index = skipToNextLine(value, index);
    } else {
      const end = value.indexOf("\n", index);
      const lineEnd = end === -1 ? value.length : end;
      let raw = value.slice(index, lineEnd).replace(/\r$/, "");
      const comment = raw.search(/\s#/);
      if (comment >= 0) raw = raw.slice(0, comment);
      parsed = raw.trim();
      index = end === -1 ? value.length : end + 1;
    }
    if (interpolate) {
      parsed = interpolateDeploymentEnvironment(parsed, result);
    }
    result.set(key, parsed);
  }
  return result;
}

/**
 * Canonical single-quoted dotenv output prevents comments, whitespace,
 * backslashes, dollar interpolation, and embedded newlines from changing
 * meaning when Docker Compose reads the durable job input.
 */
export function serializeDeploymentEnvironment(values: Map<string, string>) {
  return Array.from(
    values,
    ([key, value]) => `${key}='${value.replace(/'/g, "\\'")}'`
  ).join("\n");
}

export function deploymentEnvironmentBinding(environment: string) {
  return createHmac("sha256", appSecretKey)
    .update(ENV_BINDING_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(environment, "utf8")
    .digest("hex");
}

function interpolateOnce(input: string, environment: Map<string, string>) {
  return input
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([^}]*))?\}/g,
      (_match, key: string, operator: string | undefined, operand: string | undefined) => {
        const present = environment.has(key);
        const current = environment.get(key) ?? "";
        const nonempty = present && current !== "";
        if (!operator) return current;
        if (operator === ":-") return nonempty ? current : operand ?? "";
        if (operator === "-") return present ? current : operand ?? "";
        if (operator === ":+") return nonempty ? operand ?? "" : "";
        if (operator === "+") return present ? operand ?? "" : "";
        if (operator === ":?" && !nonempty) {
          throw new Error(`Required deployment environment variable ${key} is missing.`);
        }
        if (operator === "?" && !present) {
          throw new Error(`Required deployment environment variable ${key} is missing.`);
        }
        return current;
      }
    )
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) =>
      environment.get(key) ?? ""
    );
}

export function interpolateDeploymentEnvironment(
  input: string,
  environment: Map<string, string>
) {
  const escapedDollar = "\u0000COMPOSEBASTION_DOLLAR\u0000";
  return interpolateOnce(
    input.replace(/\$\$/g, escapedDollar),
    environment
  ).replaceAll(escapedDollar, "$");
}

export function sensitiveDeploymentEnvironmentValues(
  environment: string,
  explicitSecretKeys: Iterable<string> = []
) {
  const keys = new Set(explicitSecretKeys);
  const values = parseDeploymentEnvironment(environment);
  for (const key of values.keys()) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(key)) keys.add(key);
  }
  return [...keys]
    .map((key) => values.get(key) ?? "")
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

export function redactSensitiveValues(text: string, sensitiveValues: Iterable<string>) {
  const replacements = [...new Set(sensitiveValues)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let result = text;
  const placeholders: string[] = [];
  for (const value of replacements) {
    const variants = new Set([
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1)
    ]);
    const placeholder = `\u0000COMPOSEBASTION_SECRET_${placeholders.length}\u0000`;
    placeholders.push(placeholder);
    for (const variant of variants) {
      if (variant) result = result.replaceAll(variant, placeholder);
    }
  }
  for (const placeholder of placeholders) {
    result = result.replaceAll(placeholder, "[REDACTED]");
  }
  return result;
}

export function redactErrorSensitiveValues(
  error: unknown,
  sensitiveValues: Iterable<string>
) {
  const original = error instanceof Error ? error : new Error(String(error));
  original.message = redactSensitiveValues(original.message, sensitiveValues);
  if (original.stack) {
    original.stack = redactSensitiveValues(original.stack, sensitiveValues);
  }
  return original;
}
