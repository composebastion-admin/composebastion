import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerConfigRoutes } from "../src/routes/config.js";

const importConfigBackup = vi.hoisted(() => vi.fn());
const exportConfigBackup = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  requireRole: vi.fn(() => async () => undefined)
}));

vi.mock("../src/services/configBackup.js", () => ({
  exportConfigBackup,
  importConfigBackup
}));

vi.mock("../src/services/audit.js", () => ({
  writeAuditEvent
}));

describe("config routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a typed client error when config import rejects an invalid backup", async () => {
    const app = Fastify({
      genReqId: () => "config-import-request"
    });
    app.setErrorHandler((error, request, reply) => {
      const statusCode = Number((error as { statusCode?: number }).statusCode ?? 500);
      reply.code(statusCode).send({
        error: error instanceof Error ? error.message : "Internal server error",
        code: statusCode >= 500 ? "INTERNAL_ERROR" : "VALIDATION_FAILED",
        requestId: request.id
      });
    });
    await registerConfigRoutes(app);
    importConfigBackup.mockRejectedValue(Object.assign(
      new Error("Config backup could not be decrypted. Check the passphrase and JSON file."),
      { statusCode: 400 }
    ));

    const response = await app.inject({
      method: "POST",
      url: "/api/config/import",
      headers: { "content-type": "application/json" },
      payload: {
        passphrase: "long-test-passphrase",
        backup: { version: "cfg1", algorithm: "aes-256-gcm" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Config backup could not be decrypted. Check the passphrase and JSON file.",
      code: "VALIDATION_FAILED",
      requestId: "config-import-request"
    });
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});
