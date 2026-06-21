import { beforeEach, describe, expect, it, vi } from "vitest";
import { stopContainersWithRestartOnFailure } from "../src/services/recoveryContainerControl.js";

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: vi.fn(async () => ({
    public: { dockerSocketPath: "/var/run/docker.sock", tags: [] },
    ssh: {}
  }))
}));

const runSshCommand = vi.fn();
vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args)
}));

describe("recovery container stop safety", () => {
  beforeEach(() => {
    runSshCommand.mockReset();
  });

  it("restarts containers stopped before a later stop failure", async () => {
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "stop failed" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await expect(
      stopContainersWithRestartOnFailure("host-1", ["web", "db"], ["web"])
    ).rejects.toThrow("stop failed");

    expect(runSshCommand).toHaveBeenCalledTimes(3);
    expect(runSshCommand.mock.calls[2]?.[1]).toContain("docker start");
    expect(runSshCommand.mock.calls[2]?.[1]).toContain("web");
  });

  it("surfaces restart failures after a partial stop failure", async () => {
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "stop failed" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "start failed" });

    await expect(
      stopContainersWithRestartOnFailure("host-1", ["web", "db"], ["web"])
    ).rejects.toThrow("stop failed; restart failed for web: start failed");
  });
});
