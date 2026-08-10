import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());
const readRemoteFile = vi.hoisted(() => vi.fn());
const writeRemoteFile = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: (callback: (client: { query: typeof query }) => Promise<unknown>) => (
    callback({ query })
  )
}));

vi.mock("../src/services/crypto.js", () => ({
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => value
}));

vi.mock("../src/services/docker.js", () => ({
  executeDockerAction: vi.fn(),
  runDocker: vi.fn()
}));

vi.mock("../src/services/files.js", () => ({
  statHostPath: vi.fn()
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker,
  listHostIds: vi.fn()
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  findRegistryAuthForReference: vi.fn()
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/ssh.js", () => ({
  readRemoteFile,
  runSshCommand,
  writeRemoteFile
}));

const { deploymentAnalysisInternals } = await import(
  "../src/services/deployments.js"
);

const hostId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";
const attemptToken = "33333333-3333-4333-8333-333333333333";
const revision = "a".repeat(40);
const composeYaml = "services:\n  app:\n    build: .\n";
const workingDir = "/home/docker/composebastion/pinned-app";

function gitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: analysisId,
    host_id: hostId,
    source_type: "git",
    source_locator: "https://git.example.test/acme/pinned-app.git",
    branch: "main",
    compose_path: "compose.yaml",
    working_dir: workingDir,
    project_name: "pinned-app",
    compose_yaml: composeYaml,
    compose_sha256: deploymentAnalysisInternals.composeSha256(composeYaml),
    environment_sha256: deploymentAnalysisInternals.environmentSha256(""),
    source_revision: revision,
    env_encrypted: null,
    variables: [],
    credential_username: null,
    credential_secret_encrypted: null,
    staging_directory: null,
    ...overrides
  };
}

function sshResult(code = 0, stdout = "") {
  return { code, stdout, stderr: code === 0 ? "" : "rejected" };
}

describe("Git deployment analysis binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    getHostForWorker.mockResolvedValue({
      public: {
        id: hostId,
        username: "docker",
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: {
        hostname: "docker.example.test",
        port: 22,
        username: "docker"
      },
      agent: null
    });
    runSshCommand.mockResolvedValue(sshResult());
    readRemoteFile.mockResolvedValue(composeYaml);
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("pins an existing checkout to the analyzed commit without pulling the moving branch", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        command === `test -d '${workingDir}/.git' && echo yes || echo no`
      ) {
        return sshResult(0, "yes\n");
      }
      return sshResult();
    });

    await deploymentAnalysisInternals.prepareGitCheckout(gitRow());

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    const checkout = commands.find((command) =>
      command.includes("git checkout --quiet --detach")
    );
    expect(checkout).toContain(revision);
    expect(checkout).toContain("git cat-file -e");
    expect(checkout).not.toContain("git pull");
    expect(commands.some((command) =>
      command.includes(`git rev-parse --verify HEAD^{commit}`)
      && command.includes(revision)
    )).toBe(true);
  });

  it("keeps a checkout with verified untracked runtime bind data eligible for redeploy", async () => {
    const runtimeComposeYaml = [
      "services:",
      "  app:",
      "    image: nginx",
      "    volumes:",
      "      - ./runtime:/runtime"
    ].join("\n");
    readRemoteFile.mockResolvedValue(runtimeComposeYaml);
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (
        command === `test -d '${workingDir}/.git' && echo yes || echo no`
      ) {
        return sshResult(0, "yes\n");
      }
      return sshResult();
    });

    await deploymentAnalysisInternals.prepareGitCheckout(gitRow({
      compose_yaml: runtimeComposeYaml,
      compose_sha256: deploymentAnalysisInternals.composeSha256(runtimeComposeYaml)
    }));

    const guardedCommands = runSshCommand.mock.calls
      .map((call) => String(call[1]))
      .filter((command) => command.includes("git status --porcelain"));
    expect(guardedCommands.length).toBeGreaterThanOrEqual(2);
    for (const command of guardedCommands) {
      expect(command).toContain("git --literal-pathspecs ls-files --");
      expect(command).toContain("/home/docker/composebastion/pinned-app/runtime");
      expect(command).toContain(
        "git status --porcelain=v1 --untracked-files=all --ignored=matching -- ."
      );
      expect(command).toContain(":(exclude,literal)runtime");
      expect(command.indexOf("git --literal-pathspecs ls-files")).toBeLessThan(
        command.indexOf("git status --porcelain")
      );
    }
  });

  it("refuses an owner-valid staging path whose checkout revision changed", async () => {
    const attempt = deploymentAnalysisInternals.deploymentAnalysisAttempt(
      "docker",
      analysisId,
      attemptToken
    );
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command === `test -d '${workingDir}/.git' && echo yes || echo no`) {
        return sshResult(0, "no\n");
      }
      if (command.includes(`if [ -e '${attempt.checkoutDirectory}' ]`)) {
        return sshResult(0, "yes\n");
      }
      if (
        command.includes(attempt.ownerRecord)
        && command.includes("git rev-parse --verify HEAD^{commit}")
      ) {
        return sshResult(1);
      }
      return sshResult();
    });

    await expect(
      deploymentAnalysisInternals.prepareGitCheckout(
        gitRow({ staging_directory: attempt.checkoutDirectory })
      )
    ).rejects.toThrow("staged checkout no longer matches");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) => command.includes("git clone --no-checkout"))).toBe(false);
    const guardedAdoption = commands.find((command) =>
      command.includes(`mv -T -- '${attempt.checkoutDirectory}'`)
    );
    expect(guardedAdoption).toContain(attempt.ownerRecord);
    expect(guardedAdoption).toContain(`git rev-parse --verify HEAD^{commit}`);
    expect(guardedAdoption).toContain(
      `${attempt.checkoutDirectory}/.git/composebastion-owner`
    );
    expect(guardedAdoption).toContain(
      `${workingDir}/.git/composebastion-owner`
    );
  });

  it("refuses missing staging without cloning a moving branch or leaving a partial target", async () => {
    runSshCommand.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command === `test -d '${workingDir}/.git' && echo yes || echo no`) {
        return sshResult(0, "no\n");
      }
      return sshResult();
    });

    await expect(
      deploymentAnalysisInternals.prepareGitCheckout(gitRow())
    ).rejects.toThrow("staging checkout is no longer available");

    const commands = runSshCommand.mock.calls.map((call) => String(call[1]));
    expect(commands.some((command) =>
      command.includes("git clone")
      || command.includes("git pull")
      || command.includes(`mkdir -p '${workingDir}'`)
    )).toBe(false);
  });

  it("fails closed before remote access when the durable revision or Compose digest is absent", async () => {
    await expect(
      deploymentAnalysisInternals.prepareGitCheckout(
        gitRow({ source_revision: null })
      )
    ).rejects.toThrow("analyzed Git revision is missing");
    await expect(
      deploymentAnalysisInternals.prepareGitCheckout(
        gitRow({ compose_sha256: null })
      )
    ).rejects.toThrow("analyzed Compose digest is missing");

    expect(getHostForWorker).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });
});
