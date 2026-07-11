import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { checkAgent } from "../src/services/agent.js";

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
});
