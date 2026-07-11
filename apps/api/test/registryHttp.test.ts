import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { guardedRegistryRequest, resolveRegistryRequestTarget } from "../src/services/registryHttp.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("registry request target validation", () => {
  it("rejects private and mixed DNS answers before a connection is opened", async () => {
    const mixed = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ];
    await expect(resolveRegistryRequestTarget(new URL("https://registry.example.test"), {}, mixed))
      .rejects.toMatchObject({ code: "PRIVATE_REGISTRY_ADDRESS" });
  });

  it("allows a private address only for the exact operator-saved origin", async () => {
    const resolve = async () => [{ address: "10.0.0.8", family: 4 }];
    await expect(resolveRegistryRequestTarget(
      new URL("https://registry.internal:5443/v2/"),
      { trustedOrigins: ["https://registry.internal:5443"] },
      resolve
    )).resolves.toEqual({ address: "10.0.0.8", family: 4 });
    await expect(resolveRegistryRequestTarget(
      new URL("https://auth.registry.internal:5443/token"),
      { trustedOrigins: ["https://registry.internal:5443"] },
      resolve
    )).rejects.toMatchObject({ code: "PRIVATE_REGISTRY_ADDRESS" });
  });
});

describe("guarded registry HTTP transport", () => {
  it("strips authorization on cross-origin redirects", async () => {
    let forwardedAuthorization: string | undefined;
    const destination = await listen((request, response) => {
      forwardedAuthorization = request.headers.authorization;
      response.end("ok");
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { Location: `${destination}/target` });
      response.end();
    });

    const response = await guardedRegistryRequest(`${source}/start`, {
      headers: { Authorization: "Bearer must-not-leak" },
      policy: { trustedOrigins: [source, destination], allowInsecureCredentials: true }
    });
    expect(response.status).toBe(200);
    expect(forwardedAuthorization).toBeUndefined();
  });

  it("connects to the selected address when Node requests all lookup results", async () => {
    const loopbackOrigin = new URL(await listen((_request, response) => response.end("pinned")));
    const savedOrigin = `http://saved.registry.test:${loopbackOrigin.port}`;

    const response = await guardedRegistryRequest(`${savedOrigin}/v2/`, {
      policy: { trustedOrigins: [savedOrigin] },
      resolve: async () => [{ address: "127.0.0.1", family: 4 }]
    });

    expect(response.status).toBe(200);
    expect(response.body.toString("utf8")).toBe("pinned");
  });

  it("rejects credential-bearing cleartext requests unless the exact saved registry is insecure", async () => {
    await expect(guardedRegistryRequest("http://127.0.0.1:9/v2/", {
      headers: { Authorization: "Basic secret" },
      policy: { trustedOrigins: ["http://127.0.0.1:9"] }
    })).rejects.toMatchObject({ code: "INSECURE_REGISTRY_CREDENTIALS" });
  });

  it("enforces response size limits", async () => {
    const origin = await listen((_request, response) => response.end("too-large"));
    await expect(guardedRegistryRequest(origin, {
      maxBytes: 3,
      policy: { trustedOrigins: [origin] }
    })).rejects.toMatchObject({ code: "REGISTRY_RESPONSE_TOO_LARGE" });
  });

  it("enforces one absolute deadline across redirects and body trickle", async () => {
    const destination = await listen((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => response.write("."), 5);
      response.on("close", () => clearInterval(interval));
    });
    const source = await listen((_request, response) => {
      setTimeout(() => {
        response.writeHead(302, { Location: destination });
        response.end();
      }, 20);
    });

    const startedAt = Date.now();
    await expect(guardedRegistryRequest(source, {
      timeoutMs: 50,
      policy: { trustedOrigins: [source, destination] }
    })).rejects.toMatchObject({ code: "REGISTRY_REQUEST_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
