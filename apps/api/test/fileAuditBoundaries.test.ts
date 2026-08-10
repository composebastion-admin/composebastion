import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostDirectory = vi.hoisted(() => vi.fn());
const readHostTextFile = vi.hoisted(() => vi.fn());
const statHostPath = vi.hoisted(() => vi.fn());
const writeHostTextFile = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  requireRole: vi.fn(() => async (request: any) => {
    request.user = {
      id: "00000000-0000-4000-8000-000000000001",
      role: "owner"
    };
  })
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: vi.fn(() => ({ ipAddress: "203.0.113.10" })),
  writeAuditEvent
}));

vi.mock("../src/services/files.js", () => ({
  listHostDirectory,
  normalizeRemotePath: (value: string) => value,
  readHostTextFile,
  statHostPath,
  writeHostTextFile
}));

vi.mock("../src/services/jobs.js", () => ({
  withSynchronousDockerMutationAdmission: (
    _action: unknown,
    operation: () => Promise<unknown>
  ) => operation()
}));

const { registerFileRoutes } = await import("../src/routes/files.js");

describe("host file audit boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAuditEvent.mockRejectedValue(new Error("audit insert failed"));
  });

  it.each([
    ["GET", "/api/hosts/00000000-0000-4000-8000-000000000002/files?path=%2Fsrv", undefined, listHostDirectory],
    ["GET", "/api/hosts/00000000-0000-4000-8000-000000000002/files/read?path=%2Fsrv%2Fsecret.env", undefined, readHostTextFile],
    ["GET", "/api/hosts/00000000-0000-4000-8000-000000000002/files/exists?path=%2Fsrv%2Fsecret.env", undefined, statHostPath],
    ["POST", "/api/hosts/00000000-0000-4000-8000-000000000002/files/write", { path: "/srv/app.env", content: "SECRET=value" }, writeHostTextFile]
  ] as const)("prevents %s %s when the audit record cannot be persisted", async (method, url, payload, remoteCall) => {
    const app = Fastify();
    await registerFileRoutes(app);

    const response = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {})
    });

    expect(response.statusCode).toBe(500);
    expect(remoteCall).not.toHaveBeenCalled();
    await app.close();
  });
});
