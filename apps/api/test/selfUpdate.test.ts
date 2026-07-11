import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const writeRemoteFile = vi.fn();
const query = vi.fn();
const enqueueJob = vi.fn();

vi.mock("../src/services/hosts.js", () => ({
  getHost: vi.fn(),
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJob: (...args: unknown[]) => enqueueJob(...args)
}));

const hostId = "11111111-1111-4111-8111-111111111111";

function sshHost(mode: "ssh" | "agent" = "ssh") {
  return {
    public: { dockerSocketPath: "/var/run/docker.sock" },
    connectionMode: mode,
    ssh: { hostname: "vm.local", port: 22, username: "docker" },
    agent: mode === "agent" ? { url: "http://vm.local:8090", token: "token" } : null
  };
}

describe("self update service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueJob.mockReset();
    getHostForWorker.mockResolvedValue(sshHost());
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "4242\n", stderr: "" });
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("writes and starts a detached host-side self-update script", async () => {
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    const result = await runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "pinned",
      targetVersion: "1.0.2"
    });

    expect(result).toMatchObject({
      handoffStarted: true,
      pid: "4242",
      targetVersion: "1.0.2",
      logPath: "/srv/composebastion/.composebastion-self-update.log"
    });
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      "/srv/composebastion/.composebastion-self-update.sh",
      expect.stringContaining("COMPOSEBASTION_VERSION=1.0.2")
    );
    const script = String(writeRemoteFile.mock.calls[0]?.[2] ?? "");
    expect(script).toContain("docker compose -f 'docker-compose.image.yml' pull app worker");
    expect(script).toContain("docker compose -f 'docker-compose.image.yml' up -d app worker");
    expect(String(runSshCommand.mock.calls[1]?.[1])).toContain("nohup '/srv/composebastion/.composebastion-self-update.sh'");
  });

  it("requires SSH mode for the detached self-update handoff", async () => {
    getHostForWorker.mockResolvedValueOnce(sshHost("agent"));
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "latest",
      targetVersion: "latest"
    })).rejects.toThrow("requires the manager host to use SSH mode");
  });

  it("rejects non-semver start overrides even while following latest", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        value: {
          hostId,
          workingDir: "/srv/composebastion",
          composeFile: "docker-compose.image.yml",
          versionMode: "latest",
          targetVersion: "latest"
        }
      }]
    });
    const { enqueueSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(enqueueSelfUpdate({ targetVersion: "nightly" }, "user-1"))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("compares semantic versions without treating older releases as updates", async () => {
    const { compareVersions, updateAvailable } = await import("../src/services/selfUpdate.js");

    expect(compareVersions("1.0.4", "1.0.0")).toBe(1);
    expect(compareVersions("v1.0.0", "v1.0.2")).toBe(-1);
    expect(compareVersions("1.0.4-beta.1", "1.0.4")).toBe(-1);
    expect(updateAvailable("1.0.2", "1.0.0")).toBe(false);
    expect(updateAvailable("1.0.2", "1.0.4")).toBe(true);
  });

  it("uses the newest semver tag when GitHub latest release is stale", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/tags")) {
        return new Response(JSON.stringify([{ name: "v1.0.4" }, { name: "v1.0.3" }, { name: "v1.0.0" }]), { status: 200 });
      }
      if (url.includes("/releases")) {
        return new Response(JSON.stringify([{ tag_name: "v1.0.0", html_url: "https://example.test/v1.0.0", draft: false }]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    query.mockResolvedValue({ rows: [] });
    const { checkSelfUpdateLatest } = await import("../src/services/selfUpdate.js");

    const latest = await checkSelfUpdateLatest();

    expect(latest.version).toBe("1.0.4");
    fetchSpy.mockRestore();
  });
});
