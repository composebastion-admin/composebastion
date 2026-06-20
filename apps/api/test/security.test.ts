import { describe, expect, it } from "vitest";
import { DEFAULT_APP_SECRET, parseEnv } from "../src/config/env.js";
import { isAllowedCorsOrigin, isLocalDevelopmentOrigin, isSameHostOrigin, isTrustedUnsafeRequestOrigin, isUnsafeHttpMethod } from "../src/services/httpSecurity.js";
import { isPrivateIp } from "../src/services/ssrf.js";

describe("HTTP security configuration", () => {
  it("rejects the documented default app secret in production", () => {
    expect(() => parseEnv({ NODE_ENV: "production", APP_SECRET: DEFAULT_APP_SECRET })).toThrow("APP_SECRET");
  });

  it("parses comma separated CORS origins", () => {
    const parsed = parseEnv({
      APP_SECRET: "a-unique-test-secret-value-with-more-than-32-characters",
      CORS_ORIGINS: "https://console.example.com/app, http://localhost:5173"
    });
    expect(parsed.CORS_ORIGINS).toEqual(["https://console.example.com", "http://localhost:5173"]);
  });

  it("allows explicit production origins without reflecting arbitrary sites", () => {
    expect(isAllowedCorsOrigin(undefined, [], "production")).toBe(true);
    expect(isAllowedCorsOrigin("https://console.example.com", ["https://console.example.com"], "production")).toBe(true);
    expect(isAllowedCorsOrigin("https://evil.example", ["https://console.example.com"], "production")).toBe(false);
  });

  it("keeps localhost convenient in development only", () => {
    expect(isLocalDevelopmentOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5173", [], "development")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5173", [], "production")).toBe(false);
  });

  it("classifies unsafe methods and trusted mutation origins", () => {
    expect(isUnsafeHttpMethod("GET")).toBe(false);
    expect(isUnsafeHttpMethod("POST")).toBe(true);
    expect(isUnsafeHttpMethod("delete")).toBe(true);
    expect(isSameHostOrigin("https://composebastion.example.com/app", "composebastion.example.com")).toBe(true);
    expect(isSameHostOrigin("https://evil.example", "composebastion.example.com")).toBe(false);
    expect(isTrustedUnsafeRequestOrigin(undefined, "composebastion.example.com", [], "production")).toBe(true);
    expect(isTrustedUnsafeRequestOrigin("https://composebastion.example.com", "composebastion.example.com", [], "production")).toBe(true);
    expect(isTrustedUnsafeRequestOrigin("https://console.example.com", "api.example.com", ["https://console.example.com"], "production")).toBe(true);
    expect(isTrustedUnsafeRequestOrigin("https://evil.example", "composebastion.example.com", [], "production")).toBe(false);
    expect(isTrustedUnsafeRequestOrigin("http://localhost:5173", "127.0.0.1:8080", [], "development")).toBe(true);
  });

  it("enables Secure cookies by default in production", () => {
    const prod = parseEnv({
      NODE_ENV: "production",
      APP_SECRET: "a-unique-test-secret-value-with-more-than-32-characters"
    });
    expect(prod.SECURE_COOKIES).toBe(true);
    const optedOut = parseEnv({
      NODE_ENV: "production",
      APP_SECRET: "a-unique-test-secret-value-with-more-than-32-characters",
      SECURE_COOKIES: "false"
    });
    expect(optedOut.SECURE_COOKIES).toBe(false);
    expect(parseEnv({}).SECURE_COOKIES).toBe(false);
  });

  it("parses TRUST_PROXY into boolean, hop count, or proxy list", () => {
    const base = { APP_SECRET: "a-unique-test-secret-value-with-more-than-32-characters" };
    expect(parseEnv(base).TRUST_PROXY).toBe(false);
    expect(parseEnv({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(parseEnv({ ...base, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
    expect(parseEnv({ ...base, TRUST_PROXY: "10.0.0.0/8,192.168.0.0/16" }).TRUST_PROXY).toBe("10.0.0.0/8,192.168.0.0/16");
    expect(parseEnv(base).BLOCK_PRIVATE_S3_ENDPOINTS).toBe(false);
    expect(parseEnv({ ...base, BLOCK_PRIVATE_S3_ENDPOINTS: "true" }).BLOCK_PRIVATE_S3_ENDPOINTS).toBe(true);
    expect(parseEnv(base).ALLOW_PRIVATE_WEBHOOK_URLS).toBe(false);
    expect(parseEnv({ ...base, ALLOW_PRIVATE_WEBHOOK_URLS: "true" }).ALLOW_PRIVATE_WEBHOOK_URLS).toBe(true);
  });
});

describe("isPrivateIp", () => {
  it("flags private and loopback IPv4 ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.1.1", "0.0.0.0", "100.64.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows public IPv4 (including 172.32/172.15 boundaries and non-CGNAT 100.x)", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("flags private IPv6, link-local, ULA, and IPv4-mapped private addresses", () => {
    for (const ip of ["::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a00:1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  it("allows public IPv6 and IPv4-mapped public addresses", () => {
    for (const ip of ["2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});
