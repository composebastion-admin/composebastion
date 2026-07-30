import { z } from "zod";

const scpStyleRepositoryUrl =
  /^(?<user>[a-z0-9._-]+)@(?<host>[a-z0-9._-]+):(?<path>\/?[a-z0-9._~+@/-]+)$/i;
const allowedUrlProtocols = new Set(["http:", "https:", "ssh:", "git:"]);
const urlDiagnosticPattern = /\b(?:https?|ssh|git):\/\/[^\s<>"']+/gi;

function parseScpStyleRepositoryUrl(value: string) {
  const match = scpStyleRepositoryUrl.exec(value);
  if (!match?.groups?.user || !match.groups.host || !match.groups.path) return null;
  return {
    user: match.groups.user,
    host: match.groups.host,
    path: match.groups.path
  };
}

function parsedRepositoryUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (!allowedUrlProtocols.has(parsed.protocol)) return null;
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function gitRepositoryUrlIssue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    return "Use an HTTP(S), SSH, Git, or scp-style SSH repository URL";
  }
  if (parseScpStyleRepositoryUrl(trimmed)) return null;

  const parsed = parsedRepositoryUrl(trimmed);
  if (!parsed) {
    return "Use an HTTP(S), SSH, Git, or scp-style SSH repository URL";
  }
  const hasForbiddenUrlParts = parsed.password
    || parsed.search
    || parsed.hash
    || trimmed.includes("?")
    || trimmed.includes("#")
    || ((parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "git:")
      && parsed.username);
  if (hasForbiddenUrlParts) {
    return "Repository URL must not contain credentials, query parameters, or a fragment";
  }
  return null;
}

export const gitRepositoryUrlSchema = z.string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    const issue = gitRepositoryUrlIssue(value);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

export function canonicalizeGitRepositoryUrl(value: string): string {
  const issue = gitRepositoryUrlIssue(value);
  if (issue) throw new Error(issue);
  const trimmed = value.trim();
  const scp = parseScpStyleRepositoryUrl(trimmed);
  if (scp) return `${scp.user}@${scp.host.toLowerCase()}:${scp.path.replace(/\/$/, "")}`;

  const parsed = parsedRepositoryUrl(trimmed)!;
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function githubRepositoryUrlIssue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    return "Use a GitHub repository URL like https://github.com/owner/repo";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Use a GitHub repository URL like https://github.com/owner/repo";
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/i, "");
  if (
    parsed.protocol !== "https:"
    || host !== "github.com"
    || path.split("/").filter(Boolean).length !== 2
  ) {
    return "Use a GitHub repository URL like https://github.com/owner/repo";
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || trimmed.includes("?")
    || trimmed.includes("#")
  ) {
    return "GitHub repository URL must not contain credentials, query parameters, or a fragment";
  }
  return null;
}

export const githubRepositoryUrlSchema = z.string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    const issue = githubRepositoryUrlIssue(value);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

export function canonicalizeGithubRepositoryUrl(value: string): string {
  const issue = githubRepositoryUrlIssue(value);
  if (issue) throw new Error(issue);
  const parsed = new URL(value.trim());
  const [owner, rawRepo] = parsed.pathname.replace(/^\/|\/$/g, "").split("/");
  const repo = rawRepo!.replace(/\.git$/i, "");
  return `https://github.com/${owner!.toLowerCase()}/${repo.toLowerCase()}`;
}

export function plaintextHttpSourceUrlIssue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s]/.test(trimmed)) {
    return "Use an HTTP(S) URL without embedded credentials";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Use an HTTP(S) URL without embedded credentials";
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || trimmed.includes("?")
    || trimmed.includes("#")
  ) {
    return "URL must use HTTP(S) and must not contain credentials, query parameters, or a fragment";
  }
  return null;
}

export const plaintextHttpSourceUrlSchema = z.string()
  .trim()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    const issue = plaintextHttpSourceUrlIssue(value);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

export function canonicalizePlaintextHttpSourceUrl(value: string): string {
  const issue = plaintextHttpSourceUrlIssue(value);
  if (issue) throw new Error(issue);
  const parsed = new URL(value.trim());
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

/**
 * Return a display-safe Git URL for records created before URL validation was
 * enforced. HTTP credentials and token-like query/fragment data are removed;
 * invalid or unsupported values are not reflected to the client.
 */
export function sanitizeGitRepositoryUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const scp = parseScpStyleRepositoryUrl(trimmed);
  if (scp) return `${scp.user}@${scp.host.toLowerCase()}:${scp.path}`;

  const parsed = parsedRepositoryUrl(trimmed);
  if (!parsed) return null;
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    parsed.username = "";
  }
  if (parsed.protocol === "git:") {
    parsed.username = "";
  }
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function sanitizeGithubRepositoryUrl(
  value: unknown,
  fallback?: { owner?: unknown; repo?: unknown }
): string | null {
  if (typeof value === "string" && !githubRepositoryUrlIssue(value)) {
    return canonicalizeGithubRepositoryUrl(value);
  }
  const owner = typeof fallback?.owner === "string" ? fallback.owner.trim() : "";
  const repo = typeof fallback?.repo === "string"
    ? fallback.repo.trim().replace(/\.git$/i, "")
    : "";
  if (
    owner
    && repo
    && /^[a-z0-9_.-]+$/i.test(owner)
    && /^[a-z0-9_.-]+$/i.test(repo)
  ) {
    return `https://github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  }
  return null;
}

export function sanitizePlaintextHttpSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    return null;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function sanitizeDeploymentSourceLocator(
  value: unknown,
  sourceType?: unknown
): string | null {
  if (typeof value !== "string") return null;
  if (sourceType === "git") return sanitizeGitRepositoryUrl(value);
  if (sourceType === "compose_url") return sanitizePlaintextHttpSourceUrl(value);
  if (/^(?:https?|ssh|git):\/\//i.test(value) || parseScpStyleRepositoryUrl(value.trim())) {
    return sanitizeGitRepositoryUrl(value) ?? sanitizePlaintextHttpSourceUrl(value);
  }
  return value;
}

/**
 * Scrub URL-shaped fragments in human-readable job diagnostics. Non-URL
 * diagnostics are retained verbatim so useful worker failure context remains
 * available to operators.
 */
export function sanitizeUrlDiagnosticText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(urlDiagnosticPattern, (match) => {
    const trailing = /[),.;:]+$/.exec(match)?.[0] ?? "";
    const candidate = trailing ? match.slice(0, -trailing.length) : match;
    const sanitized = sanitizeGitRepositoryUrl(candidate)
      ?? sanitizePlaintextHttpSourceUrl(candidate)
      ?? "[redacted-url]";
    return `${sanitized}${trailing}`;
  });
}

/**
 * Operation-job payloads and results are schemaless JSON. Sanitize known Git
 * URL fields recursively so legacy rows cannot reflect embedded credentials to
 * operators while preserving all unrelated diagnostic data.
 */
export function sanitizeGitRepositoryUrlFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGitRepositoryUrlFields(item)) as T;
  }
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/^(?:repositoryUrl|repository_url|hostCloneUrl|host_clone_url)$/i.test(key)) {
        return [key, sanitizeGitRepositoryUrl(item)];
      }
      if (/^(?:sourceInput|source_input|sourceLocator|source_locator)$/i.test(key)) {
        return [key, sanitizeDeploymentSourceLocator(item)];
      }
      if (/^(?:error|detail)$/i.test(key)) {
        return [key, sanitizeUrlDiagnosticText(item)];
      }
      return [key, sanitizeGitRepositoryUrlFields(item)];
    })
  ) as T;
}
