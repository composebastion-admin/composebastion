import Fastify from "fastify";
import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/crypto.js", () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.replace(/^encrypted:/, "")
}));

vi.mock("../src/services/auth.js", () => ({
  requireRole: vi.fn(() => async (request: any) => {
    request.user = { id: "11111111-1111-4111-8111-111111111111", role: "owner" };
  })
}));

vi.mock("../src/services/audit.js", () => ({ writeAuditEvent }));
vi.mock("../src/services/jobs.js", () => ({ enqueueJob: vi.fn() }));

const { registerRegistryRoutes } = await import("../src/routes/registries.js");

async function buildApp() {
  const app = Fastify({ genReqId: () => "registry-request" });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "Validation failed",
        code: "VALIDATION_FAILED",
        requestId: request.id,
        issues: error.issues
      });
      return;
    }
    reply.send(error);
  });
  await registerRegistryRoutes(app);
  return app;
}

describe("registry routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (_sql: string, values: unknown[]) => ({
      rows: [{
        id: values[0],
        name: values[1],
        url: values[2],
        username: values[3],
        password_encrypted: values[4],
        insecure: values[5],
        created_at: new Date(0),
        updated_at: new Date(0)
      }]
    }));
  });

  it("normalizes a saved registry to an exact origin before persistence", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/registries",
        payload: {
          name: "Production",
          url: "HTTPS://Registry.Example.COM:443/",
          username: "operator",
          password: "secret",
          insecure: false
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().registry).toMatchObject({
        name: "Production",
        url: "https://registry.example.com",
        username: "operator",
        insecure: false
      });
      expect(query.mock.calls[0]?.[1]).toEqual([
        expect.any(String),
        "Production",
        "https://registry.example.com",
        "operator",
        "encrypted:secret",
        false
      ]);
      expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it.each([
    "https://user:secret@registry.example.com",
    "https://registry.example.com/v2",
    "https://registry.example.com?scope=pull",
    "https://registry.example.com#fragment",
    "https://bad_host.example.com",
    "file:///var/run/docker.sock"
  ])("rejects an unsafe saved registry without touching persistence: %s", async (url) => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/registries",
        payload: { name: "Unsafe", url, insecure: false }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(query).not.toHaveBeenCalled();
      expect(writeAuditEvent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
