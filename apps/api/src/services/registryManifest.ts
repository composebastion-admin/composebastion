import { createHash } from "node:crypto";

export type ParsedImageReference = {
  registry: string;
  repository: string;
  tag: string;
  digest: string | null;
  canonical: string;
};

export type RegistryLookupAuth = {
  username: string;
  password: string;
  insecure?: boolean;
};

export type RegistryManifestDigestResolution = {
  digest: string;
  equivalentDigests: string[];
  childDigests: string[];
  mediaType: string | null;
};

export type RegistryLookupReason = "not_found" | "unauthorized" | "rate_limited" | "network";

export class RegistryLookupError extends Error {
  constructor(message: string, public readonly reason: RegistryLookupReason) {
    super(message);
    this.name = "RegistryLookupError";
  }
}

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json"
].join(", ");

const REQUEST_TIMEOUT_MS = 20_000;

export function parseImageReference(image: string): ParsedImageReference {
  let remainder = image.trim();
  let registry = "registry-1.docker.io";
  let digest: string | null = null;

  const digestIndex = remainder.indexOf("@");
  if (digestIndex > 0) {
    digest = remainder.slice(digestIndex + 1);
    remainder = remainder.slice(0, digestIndex);
  }

  const slashIndex = remainder.indexOf("/");
  if (slashIndex > 0) {
    const head = remainder.slice(0, slashIndex);
    if (head.includes(".") || head.includes(":") || head === "localhost") {
      registry = head;
      remainder = remainder.slice(slashIndex + 1);
    }
  }

  const tagIndex = remainder.lastIndexOf(":");
  const hasTag = tagIndex > 0 && !remainder.slice(tagIndex + 1).includes("/");
  const repository = hasTag ? remainder.slice(0, tagIndex) : remainder;
  const tag = hasTag ? remainder.slice(tagIndex + 1) : "latest";
  const normalizedRepository = registry === "registry-1.docker.io" && !repository.includes("/")
    ? `library/${repository}`
    : repository;

  return {
    registry,
    repository: normalizedRepository,
    tag,
    digest,
    canonical: `${registry}/${normalizedRepository}:${tag}`
  };
}

export function isDanglingImageReference(image: string) {
  return image.includes("<none>");
}

function registryBaseUrl(registry: string, insecure = false) {
  if (registry === "docker.io" || registry === "registry-1.docker.io" || registry === "index.docker.io") {
    return "https://registry-1.docker.io";
  }
  if (registry.startsWith("http://") || registry.startsWith("https://")) return registry.replace(/\/+$/, "");
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

function timedFetch(url: string | URL, init: RequestInit = {}) {
  return fetch(url, { redirect: "follow", ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

async function fetchBearerToken(challenge: AuthChallenge, auth: RegistryLookupAuth | undefined, cacheKey: string) {
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

  let response: Response;
  try {
    response = await timedFetch(tokenUrl, { headers });
  } catch {
    throw new RegistryLookupError(`Could not reach auth service ${tokenUrl.hostname}`, "network");
  }
  if (!response.ok) {
    throw new RegistryLookupError(
      auth
        ? `Registry rejected the stored credentials (${response.status})`
        : `Registry requires authentication (${response.status})`,
      "unauthorized"
    );
  }
  const body = await response.json() as { token?: string; access_token?: string; expires_in?: number };
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
  init: { method?: string; accept?: string }
) {
  const baseHeaders: Record<string, string> = {};
  if (init.accept) baseHeaders.Accept = init.accept;

  let response: Response;
  try {
    response = await timedFetch(url, { method: init.method ?? "GET", headers: baseHeaders });
  } catch {
    throw new RegistryLookupError(`Could not reach registry ${parsed.registry}`, "network");
  }
  if (response.status !== 401) return response;

  const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
  const headers: Record<string, string> = { ...baseHeaders };
  if (challenge?.scheme === "bearer") {
    const cacheKey = `${parsed.registry}|${parsed.repository}|${auth?.username ?? ""}`;
    headers.Authorization = `Bearer ${await fetchBearerToken(challenge, auth, cacheKey)}`;
  } else if (auth?.username && auth.password) {
    headers.Authorization = basicAuthHeader(auth);
  } else {
    return response;
  }

  try {
    return await timedFetch(url, { method: init.method ?? "GET", headers });
  } catch {
    throw new RegistryLookupError(`Could not reach registry ${parsed.registry}`, "network");
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
  auth?: RegistryLookupAuth
) {
  const parsed = parseImageReference(imageReference);
  const base = registryBaseUrl(parsed.registry, auth?.insecure);
  const manifestUrl = `${base}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;

  // HEAD is cheap and most registries return the digest header for it.
  const headResponse = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "HEAD", accept: MANIFEST_ACCEPT });
  if (headResponse.ok) {
    const digest = normalizeDigest(headResponse.headers.get("docker-content-digest"));
    if (digest) return digest;
  } else if (![405, 501].includes(headResponse.status)) {
    throw classifyManifestFailure(headResponse.status, parsed, Boolean(auth));
  }

  const response = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "GET", accept: MANIFEST_ACCEPT });
  if (!response.ok) {
    throw classifyManifestFailure(response.status, parsed, Boolean(auth));
  }
  const headerDigest = normalizeDigest(response.headers.get("docker-content-digest"));
  if (headerDigest) return headerDigest;

  // The manifest digest is by definition the sha256 of the raw manifest body.
  const body = Buffer.from(await response.arrayBuffer());
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
  localDigest?: string | null
): Promise<RegistryManifestDigestResolution> {
  const parsed = parseImageReference(imageReference);
  const base = registryBaseUrl(parsed.registry, auth?.insecure);
  const manifestUrl = `${base}/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
  const normalizedLocalDigest = normalizeDigest(localDigest);

  const headResponse = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "HEAD", accept: MANIFEST_ACCEPT });
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

  const response = await authorizedRegistryRequest(manifestUrl, parsed, auth, { method: "GET", accept: MANIFEST_ACCEPT });
  if (!response.ok) {
    throw classifyManifestFailure(response.status, parsed, Boolean(auth));
  }

  const body = Buffer.from(await response.arrayBuffer());
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

export async function fetchRegistryTags(imageReference: string, auth?: RegistryLookupAuth) {
  const parsed = parseImageReference(imageReference);
  const base = registryBaseUrl(parsed.registry, auth?.insecure);
  const tagsUrl = new URL(`${base}/v2/${parsed.repository}/tags/list`);
  tagsUrl.searchParams.set("n", "100");

  const response = await authorizedRegistryRequest(tagsUrl.toString(), parsed, auth, { accept: "application/json" });
  if (!response.ok) {
    throw classifyManifestFailure(response.status, parsed, Boolean(auth));
  }

  const body = await response.json() as { tags?: unknown };
  if (!Array.isArray(body.tags)) return [];
  return body.tags
    .filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}
