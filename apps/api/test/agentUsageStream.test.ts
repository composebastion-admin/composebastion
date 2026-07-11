import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { streamAgentContainerUsage } from "../src/services/agent.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("agent usage stream establishment", () => {
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
