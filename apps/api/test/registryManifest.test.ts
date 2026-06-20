import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRegistryManifestDigest,
  fetchRegistryManifestDigests,
  fetchRegistryTags,
  parseImageReference,
  RegistryLookupError
} from "../src/services/registryManifest.js";

describe("parseImageReference", () => {
  it("normalizes docker hub library images", () => {
    expect(parseImageReference("nginx:latest")).toEqual({
      registry: "registry-1.docker.io",
      repository: "library/nginx",
      tag: "latest",
      digest: null,
      canonical: "registry-1.docker.io/library/nginx:latest"
    });
  });

  it("parses private registry references", () => {
    expect(parseImageReference("registry.example.com/acme/app:1.2.3")).toEqual({
      registry: "registry.example.com",
      repository: "acme/app",
      tag: "1.2.3",
      digest: null,
      canonical: "registry.example.com/acme/app:1.2.3"
    });
  });

  it("splits digest references", () => {
    const parsed = parseImageReference("ghcr.io/acme/app:1.0@sha256:deadbeef");
    expect(parsed.registry).toBe("ghcr.io");
    expect(parsed.repository).toBe("acme/app");
    expect(parsed.tag).toBe("1.0");
    expect(parsed.digest).toBe("sha256:deadbeef");
  });
});

describe("fetchRegistryManifestDigest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns docker-content-digest from an anonymous HEAD", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 200,
      headers: { "docker-content-digest": "sha256:abc123" }
    })));

    await expect(fetchRegistryManifestDigest("registry.example.com/anon/app:1.2.3")).resolves.toBe("abc123");
  });

  it("performs the bearer token flow on a 401 challenge", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization });
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ token: "anon-token", expires_in: 300 }), { status: 200 });
      }
      if (!headers.Authorization) {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:bearer/app:pull"' }
        });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:tokened" } });
    }));

    await expect(fetchRegistryManifestDigest("registry.example.com/bearer/app:2.0")).resolves.toBe("tokened");
    expect(calls.some((call) => call.url.startsWith("https://auth.example.com/token"))).toBe(true);
    expect(calls.at(-1)?.auth).toBe("Bearer anon-token");
  });

  it("classifies missing manifests as not_found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(fetchRegistryManifestDigest("registry.example.com/missing/app:1.0"))
      .rejects.toMatchObject({ reason: "not_found" });
    await expect(fetchRegistryManifestDigest("registry.example.com/missing/app:1.0"))
      .rejects.toBeInstanceOf(RegistryLookupError);
  });

  it("includes child manifest digests from a remote image index", async () => {
    const index = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { digest: "sha256:linux-amd64", platform: { os: "linux", architecture: "amd64" } },
        { digest: "sha256:linux-arm64", platform: { os: "linux", architecture: "arm64" } }
      ]
    };
    const fetchMock = vi.fn(async (_input: any, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "docker-content-digest": "sha256:index" }
        });
      }
      return new Response(JSON.stringify(index), {
        status: 200,
        headers: {
          "content-type": "application/vnd.oci.image.index.v1+json",
          "docker-content-digest": "sha256:index"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRegistryManifestDigests("registry.example.com/multi/app:latest", undefined, "linux-amd64");

    expect(result.digest).toBe("index");
    expect(result.childDigests).toEqual(["linux-amd64", "linux-arm64"]);
    expect(result.equivalentDigests).toEqual(expect.arrayContaining(["index", "linux-amd64", "linux-arm64"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchRegistryTags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries with basic credentials after a basic challenge and normalizes tags", async () => {
    const fetchMock = vi.fn(async (_input: any, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers.Authorization) {
        return new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="registry"' } });
      }
      expect(headers.Authorization).toMatch(/^Basic /);
      return new Response(JSON.stringify({ tags: ["1.10.0", "latest", "1.2.0", "latest"] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRegistryTags("registry.example.com/basic/app:1.2.0", {
      username: "user",
      password: "pass"
    })).resolves.toEqual(["1.2.0", "1.10.0", "latest"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
