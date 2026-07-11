import { describe, expect, it } from "vitest";
import { terminalPhaseLabel } from "./hostTerminalStatus.js";

describe("host terminal connection announcements", () => {
  it("describes every active connection state", () => {
    expect(terminalPhaseLabel("connecting", "prod-01")).toBe("Connecting to prod-01");
    expect(terminalPhaseLabel("ready", "prod-01")).toBe("Connected to prod-01");
    expect(terminalPhaseLabel("closed", "prod-01")).toBe("Terminal disconnected from prod-01");
    expect(terminalPhaseLabel("error", "prod-01")).toBe("Terminal connection error for prod-01");
  });
});
