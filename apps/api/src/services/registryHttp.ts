import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import net, { type LookupFunction } from "node:net";
import { isPrivateIp } from "./ssrf.js";

export type RegistryResolvedAddress = { address: string; family: number };
export type RegistryResolver = (hostname: string) => Promise<RegistryResolvedAddress[]>;

export type RegistryRequestPolicy = {
  trustedOrigins?: string[];
  allowInsecureCredentials?: boolean;
};

export type RegistryRequestOptions = {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  policy?: RegistryRequestPolicy;
  resolve?: RegistryResolver;
};

export type RegistryHttpResponse = {
  status: number;
  ok: boolean;
  body: Buffer;
  headers: {
    get(name: string): string | null;
  };
};

const defaultResolver: RegistryResolver = async (hostname) => {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const directFamily = net.isIP(host);
  if (directFamily === 4 || directFamily === 6) return [{ address: host, family: directFamily }];
  const entries = await dnsLookup(host, { all: true, verbatim: true });
  return entries.map((entry) => ({ address: entry.address, family: entry.family }));
};

function registryTransportError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function normalizedOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.origin.toLowerCase();
  } catch {
    return "";
  }
}

function hasAuthorization(headers: Record<string, string>) {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

function withoutAuthorization(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
}

export function isTrustedRegistryOrigin(url: URL, policy: RegistryRequestPolicy = {}) {
  const origin = url.origin.toLowerCase();
  return (policy.trustedOrigins ?? []).some((candidate) => normalizedOrigin(candidate) === origin);
}

export async function resolveRegistryRequestTarget(
  url: URL,
  policy: RegistryRequestPolicy = {},
  resolve: RegistryResolver = defaultResolver
) {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw registryTransportError("Registry requests must use HTTP or HTTPS", "INVALID_REGISTRY_PROTOCOL");
  }
  if (url.username || url.password) {
    throw registryTransportError("Registry request URLs must not contain credentials", "INVALID_REGISTRY_URL");
  }
  const addresses = await resolve(url.hostname);
  if (addresses.length === 0) throw registryTransportError("Registry hostname did not resolve", "ENOTFOUND");
  for (const entry of addresses) {
    if ((entry.family !== 4 && entry.family !== 6) || net.isIP(entry.address) !== entry.family) {
      throw registryTransportError("Registry DNS returned an invalid address", "ENOTFOUND");
    }
  }
  if (!isTrustedRegistryOrigin(url, policy)) {
    const blocked = addresses.find((entry) => isPrivateIp(entry.address));
    if (blocked) {
      throw registryTransportError(
        `Registry hostname resolved to a blocked network address (${blocked.address})`,
        "PRIVATE_REGISTRY_ADDRESS"
      );
    }
  }
  return addresses[0]!;
}

function responseHeaders(headers: http.IncomingHttpHeaders) {
  return {
    get(name: string) {
      const value = headers[name.toLowerCase()];
      if (Array.isArray(value)) return value.join(", ");
      return value ?? null;
    }
  };
}

function registryDeadlineError() {
  return registryTransportError("Registry request timed out", "REGISTRY_REQUEST_TIMEOUT");
}

function remainingDeadlineMs(deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw registryDeadlineError();
  return remaining;
}

async function withinRegistryDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = remainingDeadlineMs(deadlineAt);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(registryDeadlineError()), remaining);
      operation.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestOnce(
  url: URL,
  options: RegistryRequestOptions,
  headers: Record<string, string>,
  deadlineAt: number
): Promise<RegistryHttpResponse> {
  const policy = options.policy ?? {};
  const trusted = isTrustedRegistryOrigin(url, policy);
  if (hasAuthorization(headers) && url.protocol !== "https:" && !(trusted && policy.allowInsecureCredentials)) {
    throw registryTransportError("Registry credentials require HTTPS unless the saved registry is explicitly insecure", "INSECURE_REGISTRY_CREDENTIALS");
  }

  const selected = await withinRegistryDeadline(
    resolveRegistryRequestTarget(url, policy, options.resolve ?? defaultResolver),
    deadlineAt
  );
  const transport = url.protocol === "https:" ? https : http;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === "object" && lookupOptions.all) {
      (callback as (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [
        { address: selected.address, family: selected.family }
      ]);
      return;
    }
    (callback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(
      null,
      selected.address,
      selected.family
    );
  };
  const requestDeadlineMs = remainingDeadlineMs(deadlineAt);

  return new Promise<RegistryHttpResponse>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      handler();
    };
    const request = transport.request(url, {
      method: options.method ?? "GET",
      headers,
      lookup: pinnedLookup,
      servername: url.hostname.replace(/^\[|\]$/g, "")
    }, (response) => {
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if ((options.method ?? "GET") !== "HEAD" && declaredLength > maxBytes) {
        response.destroy(registryTransportError("Registry response exceeded the allowed size", "REGISTRY_RESPONSE_TOO_LARGE"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) {
          response.destroy(registryTransportError("Registry response exceeded the allowed size", "REGISTRY_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        finish(() => resolve({
          status: response.statusCode ?? 0,
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          body: Buffer.concat(chunks),
          headers: responseHeaders(response.headers)
        }));
      });
      response.on("error", (error) => finish(() => reject(error)));
    });
    deadlineTimer = setTimeout(() => request.destroy(registryDeadlineError()), requestDeadlineMs);
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

export async function guardedRegistryRequest(urlInput: string | URL, options: RegistryRequestOptions = {}): Promise<RegistryHttpResponse> {
  let current = new URL(urlInput);
  let headers = { ...(options.headers ?? {}) };
  const maxRedirects = options.maxRedirects ?? 3;
  const deadlineAt = Date.now() + (options.timeoutMs ?? 20_000);

  for (let redirects = 0; ; redirects += 1) {
    const response = await requestOnce(current, options, headers, deadlineAt);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= maxRedirects) {
      throw registryTransportError("Registry redirected too many times", "REGISTRY_REDIRECT_LIMIT");
    }
    const next = new URL(location, current);
    if (next.origin.toLowerCase() !== current.origin.toLowerCase()) headers = withoutAuthorization(headers);
    current = next;
  }
}
