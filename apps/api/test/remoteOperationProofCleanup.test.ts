import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const listHostIds = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());
const sweepSshTerminalRemoteOperations = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({ query }));
vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker,
  listHostIds
}));
vi.mock("../src/services/ssh.js", () => ({
  sweepSshTerminalRemoteOperations
}));

const { cleanupTerminalRemoteOperationProofs } = await import(
  "../src/services/remoteOperationProofCleanup.js"
);

const sshHostId = "11111111-1111-4111-8111-111111111111";
const agentHostId = "22222222-2222-4222-8222-222222222222";

describe("terminal remote-operation proof cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    listHostIds.mockReset();
    getHostForWorker.mockReset();
    sweepSshTerminalRemoteOperations.mockReset();
  });

  it("protects active and unreconciled proofs while sweeping only SSH hosts", async () => {
    const operationId = "a".repeat(64);
    query.mockResolvedValue({
      rows: [{
        host_id: sshHostId,
        target_host_id: agentHostId,
        operation_id: operationId
      }, {
        host_id: sshHostId,
        target_host_id: null,
        operation_id: "not-an-operation-id"
      }],
      rowCount: 2
    });
    listHostIds.mockResolvedValue([sshHostId, agentHostId]);
    getHostForWorker.mockImplementation(async (hostId: string) =>
      hostId === sshHostId
        ? {
            connectionMode: "ssh",
            ssh: {
              hostname: "ssh.example.test",
              port: 22,
              username: "operator"
            }
          }
        : {
            connectionMode: "agent",
            agent: { baseUrl: "https://agent.example.test" }
          }
    );
    sweepSshTerminalRemoteOperations.mockResolvedValue({
      removed: 2,
      operationIds: ["b".repeat(64), "c".repeat(64)]
    });

    await expect(cleanupTerminalRemoteOperationProofs()).resolves.toEqual({
      checked: 1,
      removed: 2,
      failures: []
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("jobs.status = 'running'");
    expect(sql).toContain("jobs.status = 'failed'");
    expect(sql).toContain("REMOTE_OUTCOME_UNKNOWN:%");
    expect(sql).toContain("<> 'reconciled'");
    expect(sweepSshTerminalRemoteOperations).toHaveBeenCalledOnce();
    expect(sweepSshTerminalRemoteOperations).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "ssh.example.test" }),
      [operationId],
      {
        maxScanned: 200,
        maxRemoved: 50,
        graceSeconds: 15 * 60
      }
    );
  });

  it("fails closed at the protection bound without deleting any proof", async () => {
    query.mockResolvedValue({
      rows: Array.from({ length: 1_001 }, (_, index) => ({
        host_id: sshHostId,
        target_host_id: null,
        operation_id: index.toString(16).padStart(64, "0")
      })),
      rowCount: 1_001
    });
    listHostIds.mockResolvedValue([sshHostId]);
    getHostForWorker.mockResolvedValue({
      connectionMode: "ssh",
      ssh: {
        hostname: "ssh.example.test",
        port: 22,
        username: "operator"
      }
    });

    await expect(cleanupTerminalRemoteOperationProofs()).resolves.toEqual({
      checked: 1,
      removed: 0,
      failures: [{ hostId: sshHostId }]
    });
    expect(sweepSshTerminalRemoteOperations).not.toHaveBeenCalled();
  });

  it("redacts transport diagnostics from cleanup failures", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    listHostIds.mockResolvedValue([sshHostId]);
    getHostForWorker.mockResolvedValue({
      connectionMode: "ssh",
      ssh: {
        hostname: "ssh.example.test",
        port: 22,
        username: "operator"
      }
    });
    sweepSshTerminalRemoteOperations.mockRejectedValue(
      new Error("ssh://operator:TOP-SECRET@ssh.example.test failed")
    );

    const result = await cleanupTerminalRemoteOperationProofs();

    expect(result).toEqual({
      checked: 1,
      removed: 0,
      failures: [{ hostId: sshHostId }]
    });
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
  });
});
