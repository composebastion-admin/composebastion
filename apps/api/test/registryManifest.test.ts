import { describe, expect, it, vi } from "vitest";
import type { RegistryHttpResponse, RegistryRequestOptions } from "../src/services/registryHttp.js";
import {
  fetchRegistryManifestDigest,
  fetchRegistryManifestDigests,
  fetchRegistryTags,
  parseImageReference,
  RegistryLookupError
} from "../src/services/registryManifest.js";

function registryResponse(status: number, body: unknown = "", headers: Record<string, string> = {}): RegistryHttpResponse {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    ok: status >= 200 && status < 300,
    body: bytes,
    headers: { get: (name) => normalizedHeaders[name.toLowerCase()] ?? null }
  };
}

describe("parseImageReference", () => {
  it("normalizes docker hub library images", () => {
    expect(parseImageReference("nginx:latest")).toEqual({
      registry: "registry-1.docker.io",
      repository: "library/nginx",
      tag: "latest",
      digest: null,
      reference: "latest",
      canonical: "registry-1.docker.io/library/nginx:latest"
    });
  });

  it("parses private registry references", () => {
    expect(parseImageReference("registry.example.com:5443/acme/app:1.2.3")).toEqual({
      registry: "registry.example.com:5443",
      repository: "acme/app",
      tag: "1.2.3",
      digest: null,
      reference: "1.2.3",
      canonical: "registry.example.com:5443/acme/app:1.2.3"
    });
  });

  it("uses complete digest references for manifest lookup", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const parsed = parseImageReference(`ghcr.io/acme/app:1.0@${digest}`);
    expect(parsed).toMatchObject({ registry: "ghcr.io", repository: "acme/app", tag: "1.0", digest, reference: digest });
  });

  it("accepts Docker Distribution separator forms and enforces length after Docker Hub normalization", () => {
    expect(parseImageReference("registry.example.com/acme/foo__bar--baz.qux:1").repository)
      .toBe("acme/foo__bar--baz.qux");
    expect(parseImageReference(`${"a".repeat(247)}:latest`).repository)
      .toBe(`library/${"a".repeat(247)}`);
    expect(() => parseImageReference(`${"a".repeat(248)}:latest`))
      .toThrow(RegistryLookupError);
  });

  it.each([
    "https://registry.example.com/acme/app:latest",
    "user@registry.example.com/acme/app:latest",
    "registry.example.com/acme/../app:latest",
    "registry.example.com/foo..bar/app:latest",
    "registry.example.com/foo._bar/app:latest",
    "registry.example.com/foo___bar/app:latest",
    "bad_host.example/foo/app:latest",
    "-bad.example/foo/app:latest",
    "bad-.example/foo/app:latest",
    "foo..example/foo/app:latest",
    "registry.example.com:0/acme/app:latest",
    "registry.example.com:65536/acme/app:latest",
    "0177.0.0.1/acme/app:latest",
    "registry.example.com/acme/app:latest?redirect=http://localhost",
    "registry.example.com/acme/app:latest#fragment",
    "registry.example.com/Acme/app:latest",
    "registry.example.com/acme/app@sha256:deadbeef"
  ])("rejects malformed or ambiguous references: %s", (reference) => {
    expect(() => parseImageReference(reference)).toThrow(RegistryLookupError);
    try {
      parseImageReference(reference);
    } catch (error) {
      expect(error).toMatchObject({ reason: "invalid" });
    }
  });
});

describe("registry manifest requests", () => {
  it("preserves blocked-address policy failures for the API boundary", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("blocked"), { code: "PRIVATE_REGISTRY_ADDRESS" });
    });
    await expect(fetchRegistryManifestDigest("registry.internal/blocked/app:1.0", undefined, request))
      .rejects.toMatchObject({ reason: "private_address" });
  });

  it("returns docker-content-digest from an anonymous HEAD", async () => {
    const request = vi.fn(async () => registryResponse(200, "", { "docker-content-digest": "sha256:abc123" }));
    await expect(fetchRegistryManifestDigest("registry.example.com/anon/app:1.2.3", undefined, request)).resolves.toBe("abc123");
  });

  it("performs the bearer token flow on a validated challenge", async () => {
    const calls: Array<{ url: string; auth?: string; options?: RegistryRequestOptions }> = [];
    const request = vi.fn(async (input: string | URL, options?: RegistryRequestOptions) => {
      const url = String(input);
      const auth = Object.entries(options?.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
      calls.push({ url, auth, options });
      if (url.includes("/token")) return registryResponse(200, { token: "anon-token", expires_in: 300 });
      if (!auth) {
        return registryResponse(401, "", {
          "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:bearer/app:pull"'
        });
      }
      return registryResponse(200, "", { "docker-content-digest": "sha256:tokened" });
    });

    await expect(fetchRegistryManifestDigest("registry.example.com/bearer/app:2.0", undefined, request)).resolves.toBe("tokened");
    expect(calls.some((call) => call.url.startsWith("https://auth.example.com/token"))).toBe(true);
    expect(calls.at(-1)?.auth).toBe("Bearer anon-token");
    expect(calls.every((call) => call.options?.maxRedirects === 3)).toBe(true);
  });

  it("classifies missing manifests as not_found", async () => {
    const request = vi.fn(async () => registryResponse(404));
    await expect(fetchRegistryManifestDigest("registry.example.com/missing/app:1.0", undefined, request))
      .rejects.toMatchObject({ reason: "not_found" });
  });

  it("includes child manifest digests from an image index", async () => {
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { digest: "sha256:linux-amd64", platform: { os: "linux", architecture: "amd64" } },
        { digest: "sha256:linux-arm64", platform: { os: "linux", architecture: "arm64" } }
      ]
    };
    const request = vi.fn(async (_input: string | URL, options?: RegistryRequestOptions) => options?.method === "HEAD"
      ? registryResponse(200, "", { "docker-content-digest": "sha256:index" })
      : registryResponse(200, index, {
          "content-type": "application/vnd.oci.image.index.v1+json",
          "docker-content-digest": "sha256:index"
        }));

    const result = await fetchRegistryManifestDigests(
      "registry.example.com/multi/app:latest",
      undefined,
      "linux-amd64",
      request
    );
    expect(result.digest).toBe("index");
    expect(result.childDigests).toEqual(["linux-amd64", "linux-arm64"]);
    expect(result.equivalentDigests).toEqual(expect.arrayContaining(["index", "linux-amd64", "linux-arm64"]));
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("fetchRegistryTags", () => {
  it("retries with basic credentials and applies bounded request policy", async () => {
    const request = vi.fn(async (_input: string | URL, options?: RegistryRequestOptions) => {
      const authorization = Object.entries(options?.headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
      if (!authorization) return registryResponse(401, "", { "www-authenticate": 'Basic realm="registry"' });
      expect(authorization).toMatch(/^Basic /);
      expect(options?.maxBytes).toBe(1024 * 1024);
      return registryResponse(200, { tags: ["1.10.0", "latest", "1.2.0", "latest"] });
    });

    await expect(fetchRegistryTags("registry.example.com/basic/app:1.2.0", {
      username: "user",
      password: "pass"
    }, request)).resolves.toEqual(["1.2.0", "1.10.0", "latest"]);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
