import { describe, expect, it, vi } from "vitest";
import {
  currentRemoteMutationContext,
  recordRemoteMutationDispatch,
  recordRemoteMutationTerminal,
  remoteMutationProofFromResult,
  withRemoteMutationContext
} from "../src/services/remoteMutationProof.js";

describe("remote mutation proof identity", () => {
  it("allocates a unique durable identity for every remote primitive in one phase", async () => {
    const writes: unknown[][] = [];
    const query = vi.fn(async (_sql: string, values: unknown[]) => {
      writes.push(values);
      return {
        rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
        rowCount: 1
      };
    });
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 2,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };

    await withRemoteMutationContext(fence as any, "compose.write", async () => {
      const context = currentRemoteMutationContext();
      expect(context).toBeDefined();
      await recordRemoteMutationDispatch(context!, "ssh", 30_000);
      const firstOperationId = context!.operationId;
      await recordRemoteMutationTerminal(context!, "completed");

      await recordRemoteMutationDispatch(context!, "ssh", 30_000);
      expect(context!.operationId).not.toBe(firstOperationId);
      expect(context!.sequence).toBe(2);
      await recordRemoteMutationTerminal(context!, "completed");
    });

    const first = JSON.parse(String(writes[0]?.[2]));
    const second = JSON.parse(String(writes[2]?.[2]));
    expect(first).toMatchObject({
      attemptCount: 2,
      sequence: 1,
      phase: "compose.write",
      transport: "ssh",
      status: "dispatched"
    });
    expect(second).toMatchObject({
      attemptCount: 2,
      sequence: 2,
      phase: "compose.write",
      transport: "ssh",
      status: "dispatched"
    });
    expect(first.operationId).not.toBe(second.operationId);
  });

  it("rejects malformed or overlong proof instead of treating it as terminal", () => {
    expect(remoteMutationProofFromResult({
      remoteMutationProof: {
        operationId: "a".repeat(64),
        jobId: "11111111-1111-4111-8111-111111111111",
        attemptCount: 1,
        sequence: 1,
        phase: "compose.deploy",
        transport: "ssh",
        timeoutMs: 10 * 60_000 + 1,
        status: "terminal",
        terminalState: "completed"
      }
    })).toBeNull();
  });
});
