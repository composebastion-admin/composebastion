import { describe, expect, it } from "vitest";
import { registryCreateSchema } from "./index.js";
import {
  canonicalizeDockerRegistryAuthority,
  normalizeRegistryAuthority,
  normalizeSavedRegistryOrigin,
  savedRegistryOriginSchema
} from "./registry.js";

describe("saved registry origins", () => {
  it("normalizes HTTP(S) origins and legacy bare authorities", () => {
    expect(normalizeSavedRegistryOrigin(" HTTPS://Registry.Example.COM:443/ "))
      .toBe("https://registry.example.com");
    expect(normalizeSavedRegistryOrigin("registry.internal:5000", { defaultProtocol: "http" }))
      .toBe("http://registry.internal:5000");
    expect(normalizeSavedRegistryOrigin("https://[2001:db8::1]:5443/"))
      .toBe("https://[2001:db8::1]:5443");
    expect(normalizeSavedRegistryOrigin("http://registry.example.com:443"))
      .toBe("http://registry.example.com:443");
    expect(savedRegistryOriginSchema.parse("registry.example.com"))
      .toBe("https://registry.example.com");
  });

  it.each([
    "ftp://registry.example.com",
    "https://user:secret@registry.example.com",
    "https://registry.example.com/v2",
    "https://registry.example.com?scope=pull",
    "https://registry.example.com?",
    "https://registry.example.com#fragment",
    "https://registry.example.com#",
    "https://registry.example.com/%2e%2e",
    "https://registry.example.com/a/..",
    "https://bad_host.example.com",
    "https://-bad.example.com",
    "https://bad-.example.com",
    "https://foo..example.com",
    "https://registry.example.com:0",
    "https://registry.example.com:65536",
    "https://0177.0.0.1",
    "https://registry.example.com\\evil"
  ])("rejects a non-origin or malformed saved target: %s", (value) => {
    expect(() => normalizeSavedRegistryOrigin(value)).toThrow();
    expect(savedRegistryOriginSchema.safeParse(value).success).toBe(false);
  });

  it("normalizes registry create input and keeps protocol semantics consistent", () => {
    expect(registryCreateSchema.parse({
      name: "Private",
      url: "registry.internal:5000",
      insecure: true
    })).toMatchObject({
      url: "http://registry.internal:5000",
      insecure: true
    });
    expect(registryCreateSchema.parse({
      name: "Secure",
      url: "https://registry.example.com/",
      insecure: true
    })).toMatchObject({
      url: "https://registry.example.com",
      insecure: false
    });
  });
});

describe("registry authorities", () => {
  it("canonicalizes valid DNS names, IP addresses, ports, and Docker Hub aliases", () => {
    expect(normalizeRegistryAuthority("Registry.Example.COM:5443")).toBe("registry.example.com:5443");
    expect(normalizeRegistryAuthority("127.0.0.1:5000")).toBe("127.0.0.1:5000");
    expect(normalizeRegistryAuthority("[2001:db8::1]:5000")).toBe("[2001:db8::1]:5000");
    expect(canonicalizeDockerRegistryAuthority("docker.io")).toBe("registry-1.docker.io");
    expect(canonicalizeDockerRegistryAuthority("index.docker.io")).toBe("registry-1.docker.io");
    expect(canonicalizeDockerRegistryAuthority("registry-1.docker.io")).toBe("registry-1.docker.io");
    expect(canonicalizeDockerRegistryAuthority("docker.io:443")).toBe("registry-1.docker.io");
  });

  it.each([
    "bad_host.example",
    "-bad.example",
    "bad-.example",
    "foo..example",
    "registry.example:0",
    "registry.example:65536",
    "user@registry.example",
    "https://registry.example",
    "127.01.0.1"
  ])("rejects an invalid registry authority: %s", (value) => {
    expect(() => normalizeRegistryAuthority(value)).toThrow();
  });
});
