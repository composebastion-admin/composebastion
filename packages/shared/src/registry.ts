import { z } from "zod";

export type RegistryProtocol = "http" | "https";

export type SavedRegistryOriginOptions = {
  /** Protocol used for legacy hostname[:port] inputs that omit a scheme. */
  defaultProtocol?: RegistryProtocol;
};

const registryDomainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const dockerHubAliases = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io"
]);

function invalidRegistry(message: string): never {
  throw new Error(message);
}

function isCanonicalIpv4(value: string) {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) =>
    /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255
  );
}

function validateRegistryHostname(value: string) {
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!/^\[[0-9a-f:.]+\]$/i.test(value) || !value.includes(":")) {
      invalidRegistry("Registry hostname must be a valid bracketed IPv6 address");
    }
    return;
  }

  if (/^[0-9.]+$/.test(value)) {
    if (!isCanonicalIpv4(value)) invalidRegistry("Registry hostname must be a valid IPv4 address");
    return;
  }

  if (value.length > 253 || value.endsWith(".")) {
    invalidRegistry("Registry hostname is too long or has a trailing dot");
  }
  const labels = value.split(".");
  if (labels.some((label) => !registryDomainLabel.test(label))) {
    invalidRegistry("Registry hostname contains an invalid DNS label");
  }
}

/**
 * Validate and canonicalize the hostname[:port] authority used by an OCI registry.
 * The returned value is lowercase and uses a canonical IP representation. An
 * explicitly supplied port is preserved because an authority has no protocol
 * context from which to infer a default.
 */
export function normalizeRegistryAuthority(input: string) {
  const value = String(input ?? "").trim();
  if (!value || value.length > 320) invalidRegistry("Registry host is missing or too long");
  if (/[\u0000-\u0020\u007f\\/?#@]/.test(value) || value.includes("://")) {
    invalidRegistry("Registry host must contain only a hostname or IP address and an optional port");
  }

  let rawHostname: string;
  let rawPort: string | undefined;
  if (value.startsWith("[")) {
    const match = /^(\[[^\]]+\])(?::([0-9]+))?$/.exec(value);
    if (!match) invalidRegistry("Registry IPv6 hosts must be bracketed and may include one numeric port");
    rawHostname = match[1]!;
    rawPort = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/.exec(value);
    if (!match) invalidRegistry("Registry host may include one numeric port");
    rawHostname = match[1]!;
    rawPort = match[2];
  }

  if (rawPort !== undefined && (!/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65_535)) {
    invalidRegistry("Registry port must be between 1 and 65535");
  }

  validateRegistryHostname(rawHostname);

  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    invalidRegistry("Registry host is malformed");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    invalidRegistry("Registry host is malformed");
  }

  // WHATWG URL parsing canonicalizes IPv6 and IPv4. Reject legacy alternate IPv4
  // spellings (octal, hexadecimal, shortened) instead of silently changing them.
  if (/^[0-9.]+$/.test(rawHostname) && parsed.hostname !== rawHostname) {
    invalidRegistry("Registry IPv4 addresses must use canonical dotted-decimal notation");
  }
  validateRegistryHostname(parsed.hostname);
  const hostname = parsed.hostname.toLowerCase();
  return rawPort === undefined ? hostname : `${hostname}:${rawPort}`;
}

/**
 * Normalize an operator-saved registry target to an exact HTTP(S) origin.
 * Legacy bare hostname[:port] values remain accepted and are assigned the
 * requested default protocol, while every persisted value becomes an origin.
 */
export function normalizeSavedRegistryOrigin(
  input: string,
  options: SavedRegistryOriginOptions = {}
) {
  const value = String(input ?? "").trim();
  if (!value || value.length > 512) invalidRegistry("Registry URL is missing or too long");
  if (/[\u0000-\u0020\u007f\\]/.test(value)) {
    invalidRegistry("Registry URL contains whitespace, control characters, or backslashes");
  }
  if (value.includes("?")) invalidRegistry("Registry URL must not contain a query string");
  if (value.includes("#")) invalidRegistry("Registry URL must not contain a fragment");

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (scheme && !/^https?$/i.test(scheme[1]!)) {
    invalidRegistry("Registry URL must use http or https");
  }
  if (!scheme && value.includes("://")) invalidRegistry("Registry URL scheme is malformed");

  const protocol = scheme
    ? scheme[1]!.toLowerCase() as RegistryProtocol
    : options.defaultProtocol ?? "https";
  const candidate = scheme ? value : `${protocol}://${value}`;
  const rawTarget = candidate.slice(candidate.indexOf("://") + 3);
  const rawPathIndex = rawTarget.indexOf("/");
  if (rawPathIndex !== -1 && rawTarget.slice(rawPathIndex) !== "/") {
    invalidRegistry("Registry URL must not contain a path");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    invalidRegistry("Registry URL is malformed");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    invalidRegistry("Registry URL must use http or https");
  }
  if (parsed.username || parsed.password) invalidRegistry("Registry URL must not contain credentials");
  if (parsed.pathname !== "/") invalidRegistry("Registry URL must not contain a path");
  if (parsed.search) invalidRegistry("Registry URL must not contain a query string");
  if (parsed.hash) invalidRegistry("Registry URL must not contain a fragment");

  const rawAuthority = rawPathIndex === -1 ? rawTarget : rawTarget.slice(0, rawPathIndex);
  const authority = normalizeRegistryAuthority(rawAuthority);
  return new URL(`${parsed.protocol}//${authority}`).origin;
}

export const savedRegistryOriginSchema = z.string()
  .trim()
  .min(1)
  .max(512)
  .transform((value, ctx) => {
    try {
      return normalizeSavedRegistryOrigin(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Registry URL is invalid"
      });
      return z.NEVER;
    }
  });

export function canonicalizeDockerRegistryAuthority(input: string) {
  const authority = normalizeRegistryAuthority(input);
  const defaultTlsHost = authority.endsWith(":443") ? authority.slice(0, -4) : authority;
  return dockerHubAliases.has(defaultTlsHost) ? "registry-1.docker.io" : authority;
}
