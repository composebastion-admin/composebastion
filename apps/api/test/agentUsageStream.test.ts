import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentContainerUsage, streamAgentContainerUsage } from "../src/services/agent.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const fullId = "5fb479d76eb43580fcd59f1739151aa4922d80b8292d25fecc76af9a149b7398";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("agent usage stream establishment", () => {
  it("forwards record stats and reports invalid agent frames without changing stream events", async () => {
    let authorizationHeader: string | undefined;
    const server = createServer((request, response) => {
      authorizationHeader = request.headers.authorization;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive"
      });
      response.end([
        'data: {"stats":{"ID":"container-1","Name":"web"}}',
        'data: {"stats":{"CPUPerc":"1.00%","MemPerc":"2.00%"}}',
        `data: {"stats":{"Container":"${fullId}","ID":"","Name":"--"}}`,
        'data: {"stats":{"Container":"5fb479d76eb4","CPUPerc":"1.00%"}}',
        'data: {"stats":[]}',
        'data: {"stats":null}',
        'data: {"stats":"invalid"}',
        "data: not-json",
        'event: ping\ndata: {"ok":true}',
        'event: end\ndata: {"code":0}',
        'event: error\ndata: {"error":"agent stream failure"}',
        ""
      ].join("\n\n"));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    const stats: Array<Record<string, unknown>> = [];
    const errors: Error[] = [];
    const stop = await streamAgentContainerUsage(
      { url: `http://127.0.0.1:${address.port}`, token: "a".repeat(32) },
      (row) => stats.push(row),
      (error) => errors.push(error)
    );

    await vi.waitFor(() => expect(errors).toHaveLength(8));
    expect(stats).toEqual([{ ID: "container-1", Name: "web" }]);
    expect(errors.slice(0, 5).map((error) => error.message)).toEqual([
      "Agent returned malformed container usage stream data",
      "Agent returned malformed container usage stream data",
      "Agent returned malformed container usage stream data",
      "Agent returned malformed container usage stream data",
      "Agent returned malformed container usage stream data"
    ]);
    expect(errors[5]).toBeInstanceOf(SyntaxError);
    expect(errors[6]?.message).toBe("agent stream failure");
    expect(errors[7]?.message).toBe("Agent stream ended");
    expect(authorizationHeader).toBe(`Bearer ${"a".repeat(32)}`);
    stop();
  });

  it("accepts an entire valid snapshot, drops tombstones, and rejects an identity-less row atomically", async () => {
    const authorizationHeaders: Array<string | undefined> = [];
    let responseBody = JSON.stringify({
      usage: [
        { ID: "container-1", Name: "web" },
        { Container: fullId, ID: "", Name: "--" }
      ]
    });
    const server = createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(responseBody);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    const target = { url: `http://127.0.0.1:${address.port}`, token: "a".repeat(32) };

    await expect(getAgentContainerUsage(target)).resolves.toEqual([{ ID: "container-1", Name: "web" }]);

    responseBody = JSON.stringify({
      usage: [
        { ID: "container-1", Name: "web" },
        { CPUPerc: "1.00%", MemPerc: "2.00%" }
      ]
    });
    await expect(getAgentContainerUsage(target)).rejects.toThrow("malformed container usage data");
    expect(authorizationHeaders).toEqual([
      `Bearer ${target.token}`,
      `Bearer ${target.token}`
    ]);
  });

  it("rejects an accepted connection that never returns response headers", async () => {
    const server = createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    await expect(streamAgentContainerUsage(
      { url: `http://127.0.0.1:${address.port}`, token: "a".repeat(32) },
      () => undefined,
      () => undefined,
      30
    )).rejects.toThrow("timed out");
  });
});
