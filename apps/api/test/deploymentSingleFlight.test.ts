import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());
const enqueueJobInTransaction = vi.hoisted(() => vi.fn());
const notifyJobQueued = vi.hoisted(() => vi.fn());
const runDocker = vi.hoisted(() => vi.fn());
const statHostPath = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: (callback: (client: { query: typeof transactionQuery }) => Promise<unknown>) => (
    callback({ query: transactionQuery })
  )
}));

vi.mock("../src/services/crypto.js", () => ({
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => `encrypted:${value}`
}));

vi.mock("../src/services/docker.js", () => ({
  executeDockerAction: vi.fn(),
  runDocker
}));

vi.mock("../src/services/files.js", () => ({
  statHostPath
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  findRegistryAuthForReference: vi.fn(async () => null)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction,
  notifyJobQueued
}));

const { queueDeployment } = await import("../src/services/deployments.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";

const readyAnalysis = {
  id: analysisId,
  host_id: hostId,
  source_id: null,
  source_type: "image",
  source_input: "nginx:latest",
  source_locator: "nginx:latest",
  status: "ready",
  display_name: "Nginx",
  project_name: "nginx",
  branch: null,
  compose_path: "compose.yaml",
  working_dir: "/srv/nginx",
  compose_yaml: "services:\n  app:\n    image: nginx:latest\n",
  env_encrypted: null,
  variables: [],
  blockers: [],
  expires_at: new Date(Date.now() + 60_000)
};

describe("deployment execution single flight", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
    enqueueJobInTransaction.mockReset();
    notifyJobQueued.mockReset();
    runDocker.mockReset();
    statHostPath.mockReset();
    getHostForWorker.mockReset();

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM deployment_analyses")) return { rows: [readyAnalysis] };
      return { rows: [] };
    });
    runDocker.mockResolvedValue({ stdout: "" });
    statHostPath.mockResolvedValue({ exists: false });
    getHostForWorker.mockResolvedValue({
      public: {
        name: "Manager",
        username: "docker",
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: {}
    });
  });

  it("uses a ready-to-deploy compare-and-set before creating the job", async () => {
    transactionQuery.mockResolvedValueOnce({ rows: [] });

    await expect(queueDeployment(analysisId, {}, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already queued")
    });

    expect(transactionQuery).toHaveBeenCalledOnce();
    const update = String(transactionQuery.mock.calls[0]?.[0] ?? "");
    expect(update).toContain("AND status = 'ready'");
    expect(update).toContain("AND expires_at > now()");
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });
});
