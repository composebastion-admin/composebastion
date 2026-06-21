import { describe, expect, it } from "vitest";
import type { AdminUser } from "@composebastion/shared";
import {
  assertHostTerminalAccess,
  assertHostTerminalOrigin,
  parseTerminalControlMessage
} from "../src/services/hostTerminal.js";

describe("host terminal service", () => {
  it("requires owner or admin", () => {
    expect(() => assertHostTerminalAccess({ role: "viewer" } as AdminUser, { tags: [], connectionMode: "ssh" })).toThrow(
      "Insufficient permissions"
    );
    expect(() => assertHostTerminalAccess({ role: "operator" } as AdminUser, { tags: [], connectionMode: "ssh" })).toThrow(
      "Insufficient permissions"
    );
    expect(() => assertHostTerminalAccess({ role: "admin" } as AdminUser, { tags: [], connectionMode: "ssh" })).not.toThrow();
  });

  it("rejects demo hosts and agent mode", () => {
    expect(() => assertHostTerminalAccess({ role: "owner" } as AdminUser, { tags: ["demo"], connectionMode: "ssh" })).toThrow(
      "demo hosts"
    );
    expect(() => assertHostTerminalAccess({ role: "owner" } as AdminUser, { tags: [], connectionMode: "agent" })).toThrow(
      "SSH connection mode"
    );
  });

  it("parses resize control messages safely", () => {
    expect(parseTerminalControlMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))).toEqual({
      type: "resize",
      cols: 120,
      rows: 40
    });
    expect(parseTerminalControlMessage(JSON.stringify({ type: "resize", cols: 0, rows: 10 }))).toBeNull();
    expect(parseTerminalControlMessage("not-json")).toBeNull();
  });

  it("rejects disallowed websocket origins in production", () => {
    expect(() => assertHostTerminalOrigin(
      "https://console.example.com",
      "api.example.com",
      ["https://console.example.com"],
      "production"
    )).not.toThrow();
    expect(() => assertHostTerminalOrigin(
      "https://evil.example",
      "api.example.com",
      ["https://console.example.com"],
      "production"
    )).toThrow("Origin is not allowed");
  });

  it("allows same-host websocket origins in production", () => {
    expect(() => assertHostTerminalOrigin(
      "http://10.0.21.57:8080",
      "10.0.21.57:8080",
      [],
      "production"
    )).not.toThrow();
  });
});
