import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkAgent,
  inspectAgentRemoteOperation,
  runAgentDockerCommandResult,
  writeAgentRemoteFile
} from "../src/services/agent.js";
import {
  RemoteMutationOutcomeUnknownError,
  withRemoteMutationContext
} from "../src/services/remoteMutationProof.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function healthServer(status: number, body: unknown) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  return { url: `http://127.0.0.1:${address.port}`, token: "a".repeat(32) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("agent health verification", () => {
  it("requires both a successful status and an explicit ok=true body", async () => {
    await expect(checkAgent(await healthServer(200, {
      ok: false,
      dockerVersion: "27.0.0",
      composeVersion: "2.29.0"
    }))).rejects.toThrow("Docker or Compose is unavailable");

    await expect(checkAgent(await healthServer(503, { ok: false }))).rejects.toMatchObject({ status: 503 });

    await expect(checkAgent(await healthServer(200, {
      ok: true,
      agentVersion: "1.0.7-rc.1",
      dockerVersion: "27.0.0",
      composeVersion: "2.29.0"
    }))).resolves.toMatchObject({ ok: true, agentVersion: "1.0.7-rc.1" });
  });

  it("propagates the manager timeout and maps structured agent timeout ambiguity", async () => {
    let received: Record<string, unknown> | null = null;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(504, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          stdout: "",
          stderr: "Docker command timed out",
          code: 124,
          outcome: "timed_out",
          operation: {
            operationId: received?.operationId,
            status: "timed_out"
          }
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const target = {
      url: `http://127.0.0.1:${address.port}`,
      token: "a".repeat(32)
    };
    const query = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 2,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };

    await expect(withRemoteMutationContext(
      fence,
      "compose.deploy",
      () => runAgentDockerCommandResult(
        target,
        "docker compose up -d",
        10 * 60_000
      )
    )).rejects.toBeInstanceOf(RemoteMutationOutcomeUnknownError);

    expect(received).toMatchObject({
      command: "docker compose up -d",
      timeoutMs: 10 * 60_000,
      operationId: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain("dispatchedAt");
    expect(String(query.mock.calls[1]?.[0])).toContain("'terminal'");
  });

  it("reads exact agent operation liveness without treating absence as terminal", async () => {
    const operationId = "c".repeat(64);
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        operationId,
        status: "running",
        startedAt: "2026-07-30T10:00:00.000Z",
        completedAt: null,
        path: request.url
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    await expect(inspectAgentRemoteOperation({
      url: `http://127.0.0.1:${address.port}`,
      token: "a".repeat(32)
    }, operationId)).resolves.toMatchObject({
      operationId,
      state: "running"
    });
  });

  it("reconnects to the exact agent file-write receipt after response loss", async () => {
    let received: Record<string, unknown> | null = null;
    let operationId = "";
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          operationId = String(received?.operationId ?? "");
          request.socket.destroy();
        });
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        operationId,
        status: "completed",
        startedAt: "2026-07-30T10:00:00.000Z",
        completedAt: "2026-07-30T10:00:01.000Z"
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const target = {
      url: `http://127.0.0.1:${address.port}`,
      token: "a".repeat(32)
    };
    const query = vi.fn(async () => ({
      rows: [{ id: "11111111-1111-4111-8111-111111111111" }],
      rowCount: 1
    }));
    const fence = {
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptCount: 3,
      assertActive: vi.fn(async () => undefined),
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };

    await expect(
      withRemoteMutationContext(
        fence,
        "compose.agent-file-write",
        () => writeAgentRemoteFile(
          target,
          "/tmp/composebastion/test/compose.yml",
          "services: {}\n"
        )
      )
    ).rejects.toMatchObject({
      name: "RemoteMutationOutcomeUnknownError",
      remoteState: "transport_lost"
    });

    expect(received).toMatchObject({
      path: "/tmp/composebastion/test/compose.yml",
      content: "services: {}\n",
      operationId: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(query).toHaveBeenCalledTimes(1);

    await expect(
      inspectAgentRemoteOperation(target, operationId)
    ).resolves.toMatchObject({
      operationId,
      state: "completed"
    });
  });
});
