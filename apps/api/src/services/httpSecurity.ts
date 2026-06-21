export function isLocalDevelopmentOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isAllowedCorsOrigin(origin: string | undefined, allowedOrigins: string[], nodeEnv: string) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  return nodeEnv !== "production" && isLocalDevelopmentOrigin(origin);
}

export function isUnsafeHttpMethod(method: string) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function normalizedOrigin(origin: string | undefined) {
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function normalizedHost(host: string | undefined) {
  return host?.split(",")[0]?.trim().toLowerCase() ?? "";
}

export function isSameHostOrigin(origin: string | undefined, host: string | undefined) {
  const normalized = normalizedOrigin(origin);
  const requestHost = normalizedHost(host);
  if (!normalized || !requestHost) return false;
  try {
    return new URL(normalized).host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

export function isTrustedUnsafeRequestOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: string[],
  nodeEnv: string
) {
  if (!origin) return true;
  const normalized = normalizedOrigin(origin);
  if (!normalized) return false;
  if (allowedOrigins.includes(normalized)) return true;
  if (isSameHostOrigin(normalized, host)) return true;
  return nodeEnv !== "production" && isLocalDevelopmentOrigin(normalized);
}
