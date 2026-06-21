import { describe, expect, it } from "vitest";
import { createAgentLookup, isPrivateIp, shouldAllowPrivateAgentUrls, shouldAllowPrivateOutboundUrls, validateAgentUrl } from "../src/services/ssrf.js";

describe("isPrivateIp", () => {
  it("should classify loopback and private IPs correctly", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.10")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("0.0.0.0")).toBe(true);

    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fc00::")).toBe(true);

    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("validateAgentUrl", () => {
  it("should validate urls correctly", async () => {
    const resolve = async (hostname: string) => {
      const records: Record<string, Array<{ address: string }>> = {
        localhost: [{ address: "127.0.0.1" }],
        "127.0.0.1": [{ address: "127.0.0.1" }],
        "169.254.169.254": [{ address: "169.254.169.254" }],
        "agent.example.test": [{ address: "1.1.1.1" }]
      };
      if (!records[hostname]) throw new Error("DNS lookup failed");
      return records[hostname];
    };

    expect(await validateAgentUrl("http://localhost:8080", resolve)).toBe(false);
    expect(await validateAgentUrl("http://127.0.0.1:8080", resolve)).toBe(false);
    expect(await validateAgentUrl("https://169.254.169.254/latest/meta-data", resolve)).toBe(false);
    expect(await validateAgentUrl("file:///tmp/agent.sock", resolve)).toBe(false);
    expect(await validateAgentUrl("https://agent.example.test", resolve)).toBe(true);
  });
});

describe("agent request-time lookup guard", () => {
  function lookupAddress(lookup: ReturnType<typeof createAgentLookup>, hostname: string, family?: 4 | 6) {
    return new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup(hostname, { family }, (error, address, addressFamily) => {
        if (error) reject(error);
        else resolve({ address, family: addressFamily });
      });
    });
  }

  it("pins the connection to the public address that was validated", async () => {
    const resolve = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 }
    ];
    await expect(lookupAddress(createAgentLookup(false, resolve), "agent.example.test")).resolves.toEqual({
      address: "8.8.8.8",
      family: 4
    });
  });

  it("rejects hostnames when any resolved address is private", async () => {
    const resolve = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ];
    await expect(lookupAddress(createAgentLookup(false, resolve), "agent.example.test")).rejects.toThrow("private network address");
  });

  it("handles direct IP addresses without a DNS lookup", async () => {
    let resolved = false;
    const resolve = async () => {
      resolved = true;
      return [];
    };

    await expect(lookupAddress(createAgentLookup(false, resolve), "8.8.8.8")).resolves.toEqual({
      address: "8.8.8.8",
      family: 4
    });
    await expect(lookupAddress(createAgentLookup(false, resolve), "127.0.0.1")).rejects.toThrow("private network address");
    expect(resolved).toBe(false);
  });

  it("uses the same private-agent policy as host validation", async () => {
    expect(shouldAllowPrivateAgentUrls("development", false)).toBe(true);
    expect(shouldAllowPrivateAgentUrls("production", false)).toBe(false);
    expect(shouldAllowPrivateAgentUrls("production", true)).toBe(true);
    expect(shouldAllowPrivateOutboundUrls("production", false)).toBe(false);

    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(lookupAddress(createAgentLookup(true, resolve), "localhost")).resolves.toEqual({
      address: "127.0.0.1",
      family: 4
    });
  });
});
