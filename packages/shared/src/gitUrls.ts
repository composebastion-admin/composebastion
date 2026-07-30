import { z } from "zod";

const scpStyleRepositoryUrl =
  /^(?<user>[a-z0-9._-]+)@(?<host>[a-z0-9._-]+):(?<path>\/?[a-z0-9._~+@/-]+)$/i;
const allowedUrlProtocols = new Set(["http:", "https:", "ssh:", "git:"]);
const credentialBearingDiagnosticSchemes = [
  "http",
  "https",
  "ssh",
  "git",
  "postgres",
  "postgresql",
  "redis",
  "rediss",
  "sftp",
  "ftp",
  "ftps",
  "mysql",
  "mariadb",
  "mongodb",
  "mongodb+srv",
  "amqp",
  "amqps",
  "smtp",
  "smtps",
  "nats"
].join("|");
const urlDiagnosticSchemePattern = new RegExp(
  `(?:${credentialBearingDiagnosticSchemes}):|[a-z][a-z0-9+.-]*:[\\\\/]{2}`,
  "gi"
);
const trailingDiagnosticPunctuationPattern = /[)\]},.;:!?'"`>]+$/u;

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

function normalizedDiagnosticUrlCandidate(value: string) {
  const match = /^([a-z][a-z0-9+.-]*):[\\/]*(.*)$/isu.exec(value);
  if (!match?.[1]) return value;
  return `${match[1].toLowerCase()}://${match[2] ?? ""}`;
}

function sanitizeGenericDiagnosticUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!parsed.protocol || !parsed.hostname) return null;
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function diagnosticTokenEnd(value: string, start: number) {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    const codePoint = character.charCodeAt(0);
    const isAsciiControl = codePoint <= 0x1f || codePoint === 0x7f;
    if (!isAsciiControl && /\s/u.test(character)) return index;
  }
  return value.length;
}

function apparentAuthorityHasCredentialDelimiter(value: string) {
  let insideIpv6Literal = false;
  for (const character of value) {
    if (character === "[") {
      insideIpv6Literal = true;
      continue;
    }
    if (character === "]") {
      insideIpv6Literal = false;
      continue;
    }
    if (character === ":" && !insideIpv6Literal) return true;
  }
  return false;
}

function hasWhitespaceAfterQueryOrFragmentStart(value: string) {
  const queryStart = value.indexOf("?");
  const fragmentStart = value.indexOf("#");
  const delimiterStart = [queryStart, fragmentStart]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return delimiterStart !== undefined
    && /\s/u.test(value.slice(delimiterStart + 1));
}

function canWhitespaceContinueApparentUserInfo(
  value: string,
  start: number,
  whitespaceStart: number,
  userInfoEnd: number
) {
  const schemeColon = value.indexOf(":", start);
  if (schemeColon < 0 || schemeColon >= whitespaceStart) return false;
  let authorityStart = schemeColon + 1;
  while (value[authorityStart] === "/" || value[authorityStart] === "\\") {
    authorityStart += 1;
  }
  if (userInfoEnd < authorityStart) return false;
  if (value.slice(authorityStart, whitespaceStart).includes("@")) return false;

  let authorityEnd = whitespaceStart;
  for (let index = authorityStart; index < whitespaceStart; index += 1) {
    const character = value[index]!;
    if (character === "/" || character === "\\" || character === "?" || character === "#") {
      authorityEnd = index;
      break;
    }
  }
  if (authorityEnd === whitespaceStart) return true;
  return apparentAuthorityHasCredentialDelimiter(
    value.slice(authorityStart, authorityEnd)
  );
}

function hasWhitespaceInApparentUserInfo(value: string) {
  const whitespaceStart = diagnosticTokenEnd(value, 0);
  if (whitespaceStart >= value.length) return false;
  const userInfoEnd = value.indexOf("@", whitespaceStart);
  return userInfoEnd >= whitespaceStart
    && canWhitespaceContinueApparentUserInfo(
      value,
      0,
      whitespaceStart,
      userInfoEnd
    );
}

function diagnosticSensitiveContinuationEnd(
  value: string,
  start: number,
  whitespaceStart: number
) {
  if (whitespaceStart >= value.length) return whitespaceStart;

  const candidateBeforeWhitespace = value.slice(start, whitespaceStart);
  if (candidateBeforeWhitespace.includes("?") || candidateBeforeWhitespace.includes("#")) {
    return value.length;
  }

  const userInfoEnd = value.indexOf("@", whitespaceStart);
  if (
    userInfoEnd >= whitespaceStart
    && canWhitespaceContinueApparentUserInfo(value, start, whitespaceStart, userInfoEnd)
  ) {
    return diagnosticTokenEnd(value, userInfoEnd + 1);
  }

  let continuationStart = whitespaceStart;
  while (
    continuationStart < value.length
    && /\s/u.test(value[continuationStart]!)
    && !/[\u0000-\u001f\u007f]/u.test(value[continuationStart]!)
  ) {
    continuationStart += 1;
  }
  if (
    continuationStart < value.length
    && (value[continuationStart] === "?" || value[continuationStart] === "#")
  ) {
    return value.length;
  }
  return whitespaceStart;
}

function schemeStartFallsInsideUserInfo(
  value: string,
  outerSchemeStart: number,
  nestedSchemeStart: number
) {
  const colon = value.indexOf(":", outerSchemeStart);
  if (colon < 0 || colon >= nestedSchemeStart) return false;
  let authorityStart = colon + 1;
  while (value[authorityStart] === "/" || value[authorityStart] === "\\") {
    authorityStart += 1;
  }
  const tokenEnd = diagnosticTokenEnd(value, authorityStart);
  let authorityEnd = tokenEnd;
  for (let index = authorityStart; index < tokenEnd; index += 1) {
    const character = value[index]!;
    if (character === "/" || character === "\\" || character === "?" || character === "#") {
      authorityEnd = index;
      break;
    }
  }
  const userInfoEnd = value.lastIndexOf("@", authorityEnd);
  return userInfoEnd >= authorityStart
    && nestedSchemeStart >= authorityStart
    && nestedSchemeStart < userInfoEnd;
}

function sanitizeDiagnosticUrlCandidate(value: string) {
  const trailing = trailingDiagnosticPunctuationPattern.exec(value)?.[0] ?? "";
  const candidate = trailing ? value.slice(0, -trailing.length) : value;
  const normalized = normalizedDiagnosticUrlCandidate(candidate);
  if (
    /[\u0000-\u001f\u007f]/u.test(normalized)
    || hasWhitespaceInApparentUserInfo(normalized)
    || hasWhitespaceAfterQueryOrFragmentStart(normalized)
  ) {
    return `[redacted-url]${trailing}`;
  }
  const sanitized = sanitizeGitRepositoryUrl(normalized)
    ?? sanitizePlaintextHttpSourceUrl(normalized)
    ?? sanitizeGenericDiagnosticUrl(normalized)
    ?? "[redacted-url]";
  return `${sanitized}${trailing}`;
}

/**
 * Scrub URL-shaped fragments in human-readable job diagnostics. Non-URL
 * diagnostics are retained verbatim so useful worker failure context remains
 * available to operators.
 */
export function sanitizeUrlDiagnosticText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const schemeStarts = Array.from(value.matchAll(urlDiagnosticSchemePattern), (match) => match.index);
  if (schemeStarts.length === 0) return value;

  const output: string[] = [];
  let cursor = 0;
  for (let index = 0; index < schemeStarts.length; index += 1) {
    const start = schemeStarts[index]!;
    if (start < cursor) continue;
    output.push(value.slice(cursor, start));

    const whitespaceEnd = diagnosticTokenEnd(value, start);
    let nextSchemeStart: number | undefined;
    for (let candidateIndex = index + 1; candidateIndex < schemeStarts.length; candidateIndex += 1) {
      const candidateStart = schemeStarts[candidateIndex]!;
      if (candidateStart >= whitespaceEnd) break;
      if (!schemeStartFallsInsideUserInfo(value, start, candidateStart)) {
        nextSchemeStart = candidateStart;
        break;
      }
    }
    const defaultEnd = nextSchemeStart !== undefined && nextSchemeStart < whitespaceEnd
      ? nextSchemeStart
      : whitespaceEnd;
    const end = defaultEnd === whitespaceEnd
      ? diagnosticSensitiveContinuationEnd(
        value,
        start,
        whitespaceEnd
      )
      : defaultEnd;
    output.push(sanitizeDiagnosticUrlCandidate(value.slice(start, end)));
    cursor = end;
  }
  output.push(value.slice(cursor));
  return output.join("");
}

/**
 * Operation-job payloads, results, and other persisted diagnostics are
 * schemaless JSON. Sanitize URL-shaped fragments in every string leaf so
 * legacy rows cannot reflect embedded credentials to operators while
 * preserving all unrelated diagnostic text. Known repository and source
 * locator fields retain their stricter whole-value handling.
 */
export function sanitizeGitRepositoryUrlFields<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeUrlDiagnosticText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGitRepositoryUrlFields(item)) as T;
  }
  if (!value || typeof value !== "object") return value;

  const sanitizedEntries: Array<[string, unknown]> = [];
  const usedKeys = new Set<string>();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const sanitizedKeyValue = sanitizeUrlDiagnosticText(key);
    const sanitizedKey = typeof sanitizedKeyValue === "string" ? sanitizedKeyValue : key;
    let uniqueKey = sanitizedKey;
    for (let suffix = 2; usedKeys.has(uniqueKey); suffix += 1) {
      uniqueKey = `${sanitizedKey} [${suffix}]`;
    }
    usedKeys.add(uniqueKey);

    let sanitizedItem: unknown;
    if (/^(?:repositoryUrl|repository_url|hostCloneUrl|host_clone_url)$/i.test(key)) {
      sanitizedItem = sanitizeGitRepositoryUrl(item);
    } else if (/^(?:sourceInput|source_input|sourceLocator|source_locator)$/i.test(key)) {
      sanitizedItem = sanitizeUrlDiagnosticText(sanitizeDeploymentSourceLocator(item));
    } else {
      sanitizedItem = sanitizeGitRepositoryUrlFields(item);
    }
    sanitizedEntries.push([uniqueKey, sanitizedItem]);
  }
  return Object.fromEntries(sanitizedEntries) as T;
}
