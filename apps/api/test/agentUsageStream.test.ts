import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAgentContainerUsage } from "../src/services/agent.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("agent usage stream establishment", () => {
  it("forwards record stats and reports invalid agent frames without changing stream events", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive"
      });
      response.end([
        'data: {"stats":{"ID":"container-1","Name":"web"}}',
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

    await vi.waitFor(() => expect(errors).toHaveLength(6));
    expect(stats).toEqual([{ ID: "container-1", Name: "web" }]);
    expect(errors.slice(0, 3).map((error) => error.message)).toEqual([
      "Agent returned malformed container usage stream data",
      "Agent returned malformed container usage stream data",
      "Agent returned malformed container usage stream data"
    ]);
    expect(errors[3]).toBeInstanceOf(SyntaxError);
    expect(errors[4]?.message).toBe("agent stream failure");
    expect(errors[5]?.message).toBe("Agent stream ended");
    stop();
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
