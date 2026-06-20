import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const withTransaction = vi.fn();
const getHostForWorker = vi.fn();
const markHostOffline = vi.fn();
const markHostOnline = vi.fn();
const runSshCommand = vi.fn();
const streamSshCommandLines = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args),
  markHostChecking: vi.fn(),
  markHostOffline: (...args: unknown[]) => markHostOffline(...args),
  markHostOnline: (...args: unknown[]) => markHostOnline(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  streamSshCommandLines: (...args: unknown[]) => streamSshCommandLines(...args)
}));

const hostId = "00000000-0000-4000-8000-000000000001";
const blockedImage = {
  external_id: "sha256:old",
  name: "ghcr.io/composebastion-admin/demo-app:beta",
  data: { ID: "sha256:old", Repository: "ghcr.io/composebastion-admin/demo-app", Tag: "beta", Size: "560MB" }
};
const unusedImage = {
  external_id: "sha256:unused",
  name: "nginx:old",
  data: { ID: "sha256:unused", Repository: "nginx", Tag: "old", Size: "80MB" }
};
const stoppedContainer = {
  external_id: "container-old",
  name: "demoapp-old",
  data: { ID: "container-old", Names: "demoapp-old", Image: "ghcr.io/composebastion-admin/demo-app:beta", State: "exited" }
};

function sshOk(stdout = "") {
  return { code: 0, stdout, stderr: "" };
}

describe("image cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHostForWorker.mockResolvedValue({
      public: { tags: [], dockerSocketPath: "/var/run/docker.sock" },
      connectionMode: "ssh",
      ssh: { hostname: "docker.local" }
    });
    markHostOnline.mockResolvedValue(undefined);
    markHostOffline.mockResolvedValue(undefined);
    withTransaction.mockImplementation(async (callback) => callback({ query: vi.fn() }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT external_id, name, data") && sql.includes("kind = 'image'")) {
        return { rows: [blockedImage, unusedImage] };
      }
      if (sql.includes("SELECT external_id, name, data") && sql.includes("kind = 'container'")) {
        return { rows: [stoppedContainer] };
      }
      return { rows: [] };
    });
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes("docker version")) return sshOk("29.4.0\n");
      if (command.includes("docker compose version")) return sshOk("5.1.3\n");
      if (command.includes("docker ps --all") || command.includes("docker image ls") || command.includes("docker network ls") || command.includes("docker volume ls")) {
        return sshOk("");
      }
      if (command.includes("docker inspect 'container-old'")) {
        return sshOk(JSON.stringify([{
          Name: "/demoapp-old",
          Image: "sha256:old",
          Config: { Image: "ghcr.io/composebastion-admin/demo-app:beta" },
          State: { Running: false, Status: "exited" }
        }]));
      }
      if (command.includes("docker image rm 'nginx:old'")) return sshOk("Untagged: nginx:old\n");
      return sshOk("");
    });
  });

  it("marks images held by stopped containers as blocked", async () => {
    const { listImageCleanupCandidates } = await import("../src/services/docker.js");
    const candidates = await listImageCleanupCandidates(hostId);

    expect(candidates.find((candidate) => candidate.imageId === "sha256:old")).toMatchObject({
      eligible: false,
      reason: "held by stopped container demoapp-old"
    });
    expect(candidates.find((candidate) => candidate.imageId === "sha256:unused")).toMatchObject({
      eligible: true,
      reason: "unused tagged image"
    });
  });

  it("refuses blocked images and removes selected eligible images", async () => {
    const { executeDockerAction } = await import("../src/services/docker.js");

    await expect(executeDockerAction({
      type: "image.cleanup",
      hostId,
      payload: { targets: [{ imageId: "sha256:old", reference: "ghcr.io/composebastion-admin/demo-app:beta" }] }
    })).rejects.toThrow("held by stopped container demoapp-old");

    await expect(executeDockerAction({
      type: "image.cleanup",
      hostId,
      payload: { targets: [{ imageId: "sha256:unused", reference: "nginx:old" }] }
    })).resolves.toMatchObject({ count: 1 });

    expect(runSshCommand.mock.calls.some((call) => String(call[1]).includes("docker image rm 'nginx:old'"))).toBe(true);
  });
});
