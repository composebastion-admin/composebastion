import { createHash } from "node:crypto";
import { normalizeRegistryAuthority } from "@composebastion/shared";
import {
  guardedRegistryRequest,
  type RegistryHttpResponse,
  type RegistryRequestOptions
} from "./registryHttp.js";

export type ParsedImageReference = {
  registry: string;
  repository: string;
  tag: string;
  digest: string | null;
  reference: string;
  canonical: string;
};

export type RegistryLookupAuth = {
  username?: string | null;
  password?: string | null;
  insecure?: boolean;
  trustedOrigin?: string;
};

export type RegistryManifestDigestResolution = {
  digest: string;
  equivalentDigests: string[];
  childDigests: string[];
  mediaType: string | null;
};

export type RegistryLookupReason = "invalid" | "private_address" | "not_found" | "unauthorized" | "rate_limited" | "network";

export class RegistryLookupError extends Error {
  constructor(message: string, public readonly reason: RegistryLookupReason) {
    super(message);
    this.name = "RegistryLookupError";
  }
}

function registryTransportFailure(error: unknown, fallbackMessage: string) {
  if (error && typeof error === "object" && "code" in error && error.code === "PRIVATE_REGISTRY_ADDRESS") {
    return new RegistryLookupError("Registry target resolves to a blocked network address", "private_address");
  }
  return new RegistryLookupError(fallbackMessage, "network");
}

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json"
].join(", ");

const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_RESPONSE_LIMIT = 256 * 1024;
const TAG_RESPONSE_LIMIT = 1024 * 1024;
const MANIFEST_RESPONSE_LIMIT = 8 * 1024 * 1024;

type RegistryRequest = (url: string | URL, options?: RegistryRequestOptions) => Promise<RegistryHttpResponse>;

function invalidReference(message: string): never {
  throw new RegistryLookupError(`Invalid image reference: ${message}`, "invalid");
}

function validateRegistryHost(value: string) {
  try {
    return normalizeRegistryAuthority(value);
  } catch {
    invalidReference("registry host is malformed");
  }
}

function validateRepository(value: string) {
  if (!value) invalidReference("repository is missing");
  const segments = value.split("/");
  // Docker Distribution name components allow one dot, one or two
  // underscores, or one-or-more hyphens between lowercase alphanumerics.
  // Other repeated or mixed separators are ambiguous and are rejected.
  if (segments.some((segment) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(segment))) {
    invalidReference("repository must contain lowercase OCI name components");
  }
  return value;
}

export function parseImageReference(image: string): ParsedImageReference {
  let remainder = image.trim();
  if (!remainder || remainder.length > 512) invalidReference("value is missing or too long");
  if (/[\u0000-\u001f\u007f\s\\?#]/.test(remainder) || remainder.includes("://")) {
    invalidReference("schemes, whitespace, control characters, query strings, fragments, and backslashes are not allowed");
  }
  if ((remainder.match(/@/g) ?? []).length > 1) invalidReference("multiple digests are not allowed");
  let registry = "registry-1.docker.io";
  let digest: string | null = null;

  const digestIndex = remainder.indexOf("@");
  if (digestIndex > 0) {
    digest = remainder.slice(digestIndex + 1);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) invalidReference("digest must be a complete lowercase sha256 value");
    remainder = remainder.slice(0, digestIndex);
  }

  const slashIndex = remainder.indexOf("/");
  if (slashIndex > 0) {
    const head = remainder.slice(0, slashIndex);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registry = validateRegistryHost(head);
      remainder = remainder.slice(slashIndex + 1);
    }
  }

  const tagIndex = remainder.lastIndexOf(":");
  const hasTag = tagIndex > 0 && !remainder.slice(tagIndex + 1).includes("/");
  const repository = hasTag ? remainder.slice(0, tagIndex) : remainder;
  const tag = hasTag ? remainder.slice(tagIndex + 1) : "latest";
  if (!/^[\w][\w.-]{0,127}$/.test(tag)) invalidReference("tag is malformed");
  const validatedRepository = validateRepository(repository);
  const normalizedRepository = registry === "registry-1.docker.io" && !validatedRepository.includes("/")
    ? `library/${validatedRepository}`
    : validatedRepository;
  if (normalizedRepository.length > 255) {
    invalidReference("normalized repository is longer than 255 characters");
  }
  const reference = digest ?? tag;

  return {
    registry,
    repository: normalizedRepository,
    tag,
    digest,
    reference,
    canonical: digest
      ? `${registry}/${normalizedRepository}@${digest}`
      : `${registry}/${normalizedRepository}:${tag}`
  };
}

export function isDanglingImageReference(image: string) {
  return image.includes("<none>");
}

function registryBaseUrl(registry: string, insecure = false) {
  if (registry === "docker.io" || registry === "registry-1.docker.io" || registry === "index.docker.io") {
    return "https://registry-1.docker.io";
  }
  return `${insecure ? "http" : "https"}://${registry}`;
}

function normalizeDigest(value: string | null | undefined) {
  const digest = value?.trim();
  if (!digest) return null;
  return digest.replace(/^sha256:/, "");
}

function uniqueDigests(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map(normalizeDigest).filter((value): value is string => Boolean(value))));
}

function requestPolicy(auth: RegistryLookupAuth | undefined) {
  return {
    trustedOrigins: auth?.trustedOrigin ? [auth.trustedOrigin] : [],
    allowInsecureCredentials: Boolean(auth?.insecure && auth.trustedOrigin)
  };
}

function basicAuthHeader(auth: RegistryLookupAuth) {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

type AuthChallenge = {
  scheme: string;
  params: Record<string, string>;
};

function parseWwwAuthenticate(header: string | null): AuthChallenge | null {
  if (!header) return null;
  const spaceIndex = header.indexOf(" ");
  const scheme = (spaceIndex > 0 ? header.slice(0, spaceIndex) : header).trim().toLowerCase();
  const params: Record<string, string> = {};
  const remainder = spaceIndex > 0 ? header.slice(spaceIndex + 1) : "";
  for (const match of remainder.matchAll(/(\w+)="([^"]*)"/g)) {
    params[match[1]!.toLowerCase()] = match[2]!;
  }
  return { scheme, params };
}

// Tokens are cached per registry+repository+credentials for the worker process lifetime
// of one check run; registries return short-lived tokens so the cache also expires.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function fetchBearerToken(
  challenge: AuthChallenge,
  auth: RegistryLookupAuth | undefined,
  cacheKey: string,
  request: RegistryRequest
) {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const realm = challenge.params.realm;
  if (!realm || !/^https?:\/\//i.test(realm)) {
    throw new RegistryLookupError("Registry sent an unusable auth challenge", "unauthorized");
  }
  const tokenUrl = new URL(realm);
  if (challenge.params.service) tokenUrl.searchParams.set("service", challenge.params.service);
  if (challenge.params.scope) tokenUrl.searchParams.set("scope", challenge.params.scope);

  const headers: Record<string, string> = {};
  if (auth?.username && auth.password) headers.Authorization = basicAuthHeader(auth);

  let response: RegistryHttpResponse;
  try {
    response = await request(tokenUrl, {
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: TOKEN_RESPONSE_LIMIT,
      maxRedirects: 3,
      policy: requestPolicy(auth)
    });
  } catch (error) {
    throw registryTransportFailure(error, `Could not reach auth service ${tokenUrl.hostname}`);
  }
  if (!response.ok) {
    throw new RegistryLookupError(
      auth
        ? `Registry rejected the stored credentials (${response.status})`
        : `Registry requires authentication (${response.status})`,
      "unauthorized"
    );
  }
  let body: { token?: string; access_token?: string; expires_in?: number };
  try {
    body = JSON.parse(response.body.toString("utf8")) as typeof body;
  } catch {
    throw new RegistryLookupError("Registry auth response was malformed", "unauthorized");
  }
  const token = body.token ?? body.access_token;
  if (!token) throw new RegistryLookupError("Registry auth response did not include a token", "unauthorized");
  const ttlSeconds = Math.min(Math.max(Number(body.expires_in) || 60, 30), 300);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + (ttlSeconds - 10) * 1_000 });
  return token;
}

async function authorizedRegistryRequest(
  url: string,
  parsed: ParsedImageReference,
  auth: RegistryLookupAuth | undefined,
  init: { method?: "GET" | "HEAD"; accept?: string; maxBytes: number },
  request: RegistryRequest
) {
  const baseHeaders: Record<string, string> = {};
  if (init.accept) baseHeaders.Accept = init.accept;

  let response: RegistryHttpResponse;
  try {
    response = await request(url, {
      method: init.method ?? "GET",
      headers: baseHeaders,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: init.maxBytes,
      maxRedirects: 3,
      policy: requestPolicy(auth)
    });
  } catch (error) {
    throw registryTransportFailure(error, `Could not reach registry ${parsed.registry}`);
  }
  if (response.status !== 401) return response;

  const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
  const headers: Record<string, string> = { ...baseHeaders };
  if (challenge?.scheme === "bearer") {
    const cacheKey = `${parsed.registry}|${parsed.repository}|${auth?.username ?? ""}`;
    headers.Authorization = `Bearer ${await fetchBearerToken(challenge, auth, cacheKey, request)}`;
  } else if (auth?.username && auth.password) {
    headers.Authorization = basicAuthHeader(auth);
  } else {
    return response;
  }

  try {
    return await request(url, {
      method: init.method ?? "GET",
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: init.maxBytes,
      maxRedirects: 3,
      policy: requestPolicy(auth)
    });
  } catch (error) {
    throw registryTransportFailure(error, `Could not reach registry ${parsed.registry}`);
  }
}

function classifyManifestFailure(status: number, parsed: ParsedImageReference, hasAuth: boolean): RegistryLookupError {
  if (status === 404) {
    return new RegistryLookupError(`${parsed.canonical} was not found in the registry`, "not_found");
  }
  if (status === 401 || status === 403) {
    return new RegistryLookupError(
      hasAuth
        ? `${parsed.registry} rejected the stored credentials for ${parsed.repository}`
        : `${parsed.canonical} is private or does not exist in the registry`,
      "unauthorized"
    );
  }
  if (status === 429) {
    return new RegistryLookupError(`${parsed.registry} rate limit reached; try again later`, "rate_limited");
  }
  return new RegistryLookupError(`Registry lookup failed with HTTP ${status} for ${parsed.canonical}`, "network");
}

export async function fetchRegistryManifestDigest(
  imageReference: string,
  auth?: RegistryLookupAuth,
  request: RegistryRequest = guardedRegistryRequest
) {
  const parsed = parseImageReference(imageReference);
  const base = registryBaseUrl(parsed.registry, auth?.insecure);
  const manifestUrl = `${base}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.reference)}`;

  // HEAD is cheap and most registries return the digest header for it.
  const headResponse = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "HEAD", accept: MANIFEST_ACCEPT, maxBytes: 0 }, request);
  if (headResponse.ok) {
    const digest = normalizeDigest(headResponse.headers.get("docker-content-digest"));
    if (digest) return digest;
  } else if (![405, 501].includes(headResponse.status)) {
    throw classifyManifestFailure(headResponse.status, parsed, Boolean(auth));
  }

  const response = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "GET", accept: MANIFEST_ACCEPT, maxBytes: MANIFEST_RESPONSE_LIMIT }, request);
  if (!response.ok) {
    throw classifyManifestFailure(response.status, parsed, Boolean(auth));
  }
  const headerDigest = normalizeDigest(response.headers.get("docker-content-digest"));
  if (headerDigest) return headerDigest;

  // The manifest digest is by definition the sha256 of the raw manifest body.
  const body = response.body;
  return createHash("sha256").update(body).digest("hex");
}

function manifestChildDigests(body: Buffer) {
  try {
    const manifest = JSON.parse(body.toString("utf8")) as { manifests?: unknown };
    if (!Array.isArray(manifest.manifests)) return [];
    return uniqueDigests(
      manifest.manifests.map((item) => {
        if (!item || typeof item !== "object") return null;
        const digest = (item as { digest?: unknown }).digest;
        return typeof digest === "string" ? digest : null;
      })
    );
  } catch {
    return [];
  }
}

export async function fetchRegistryManifestDigests(
  imageReference: string,
  auth?: RegistryLookupAuth,
  localDigest?: string | null,
  request: RegistryRequest = guardedRegistryRequest
): Promise<RegistryManifestDigestResolution> {
  const parsed = parseImageReference(imageReference);
  const base = registryBaseUrl(parsed.registry, auth?.insecure);
  const manifestUrl = `${base}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.reference)}`;
  const normalizedLocalDigest = normalizeDigest(localDigest);

  const headResponse = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "HEAD", accept: MANIFEST_ACCEPT, maxBytes: 0 }, request);
  if (headResponse.ok) {
    const headDigest = normalizeDigest(headResponse.headers.get("docker-content-digest"));
    if (headDigest && (!normalizedLocalDigest || normalizedLocalDigest === headDigest)) {
      return {
        digest: headDigest,
        equivalentDigests: [headDigest],
        childDigests: [],
        mediaType: null
      };
    }
  } else if (![405, 501].includes(headResponse.status)) {
    throw classifyManifestFailure(headResponse.status, parsed, Boolean(auth));
  }

  const response = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "GET", accept: MANIFEST_ACCEPT, maxBytes: MANIFEST_RESPONSE_LIMIT }, request);
  if (!response.ok) {
    throw classifyManifestFailure(response.status, parsed, Boolean(auth));
  }

  const body = response.body;
  const headerDigest = normalizeDigest(response.headers.get("docker-content-digest"));
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const digest = headerDigest ?? bodyDigest;
  const childDigests = manifestChildDigests(body);
  return {
    digest,
    equivalentDigests: uniqueDigests([digest, headerDigest, bodyDigest, ...childDigests]),
    childDigests,
    mediaType: response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? null
  };
}

export async function fetchRegistryTags(
  imageReference: string,
  auth?: RegistryLookupAuth,
  request: RegistryRequest = guardedRegistryRequest
) {
  const parsed = parseImageReference(imageReference);
  const base = registryBaseUrl(parsed.registry, auth?.insecure);
  const tagsUrl = new URL(`${base}/v2/${parsed.repository}/tags/list`);
  tagsUrl.searchParams.set("n", "100");

  const response = await authorizedRegistryRequest(tagsUrl.toString(), parsed, auth, { accept: "application/json", maxBytes: TAG_RESPONSE_LIMIT }, request);
  if (!response.ok) {
    throw classifyManifestFailure(response.status, parsed, Boolean(auth));
  }

  let body: { tags?: unknown };
  try {
    body = JSON.parse(response.body.toString("utf8")) as { tags?: unknown };
  } catch {
    throw new RegistryLookupError("Registry returned malformed tag data", "network");
  }
  if (!Array.isArray(body.tags)) return [];
  return body.tags
    .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}
