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

  it("attempts every partial-stop restart and reports every failed container id", async () => {
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "stop failed" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "web start failed" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "cache start failed" });

    await expect(
      stopContainersWithRestartOnFailure(
        "host-1",
        ["web", "worker", "cache", "db"],
        ["web", "worker", "cache"]
      )
    ).rejects.toMatchObject({
      message: "stop failed; Failed to restart containers: web (web start failed); cache (cache start failed)",
      restartFailedIds: ["web", "cache"]
    });

    expect(runSshCommand).toHaveBeenCalledTimes(7);
    expect(runSshCommand.mock.calls.slice(4).map((call) => call[1])).toEqual([
      expect.stringContaining("docker start 'web'"),
      expect.stringContaining("docker start 'worker'"),
      expect.stringContaining("docker start 'cache'")
    ]);
  });

  it("restarts prior and outcome-ambiguous containers when an SSH stop rejects", async () => {
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("SSH connection reset"))
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await expect(
      stopContainersWithRestartOnFailure("host-1", ["web", "db"], ["web", "db"])
    ).rejects.toThrow("SSH connection reset");

    expect(runSshCommand.mock.calls.slice(2).map((call) => call[1])).toEqual([
      expect.stringContaining("docker start 'web'"),
      expect.stringContaining("docker start 'db'")
    ]);
  });
});
