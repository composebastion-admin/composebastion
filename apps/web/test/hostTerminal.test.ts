import { describe, expect, it } from "vitest";
import type { AdminUser, DockerHost } from "@composebastion/shared";
import { canOpenHostTerminal, isDemoHost } from "../src/lib/hostTerminal.js";

const baseHost: DockerHost = {
  id: "host-1",
  name: "prod",
  hostname: "10.0.0.1",
  port: 22,
  username: "root",
  connectionMode: "ssh",
  sshAuthType: "key",
  agentUrl: null,
  dockerSocketPath: "/var/run/docker.sock",
  tags: [],
  lastStatus: "online",
  lastSeenAt: null,
  lastError: null,
  dockerVersion: null,
  composeVersion: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("host terminal access policy", () => {
  it("allows owner and admin on ssh hosts", () => {
    expect(canOpenHostTerminal({ role: "owner" } as AdminUser, baseHost)).toBe(true);
    expect(canOpenHostTerminal({ role: "admin" } as AdminUser, baseHost)).toBe(true);
  });

  it("blocks viewers and operators", () => {
    expect(canOpenHostTerminal({ role: "viewer" } as AdminUser, baseHost)).toBe(false);
    expect(canOpenHostTerminal({ role: "operator" } as AdminUser, baseHost)).toBe(false);
  });

  it("blocks demo and agent-mode hosts", () => {
    expect(canOpenHostTerminal({ role: "owner" } as AdminUser, { ...baseHost, tags: ["demo"] })).toBe(false);
    expect(canOpenHostTerminal({ role: "owner" } as AdminUser, { ...baseHost, connectionMode: "agent" })).toBe(false);
    expect(isDemoHost({ tags: ["demo"] })).toBe(true);
  });
});
