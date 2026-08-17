import { Readable } from "node:stream";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getBackupDownloadStream = vi.hoisted(() => vi.fn());
const writeAuditEvent = vi.hoisted(() => vi.fn());
const auditClient = { query: vi.fn() };
const userId = "00000000-0000-4000-8000-000000000101";
const hostId = "00000000-0000-4000-8000-000000000102";
const backupId = "00000000-0000-4000-8000-000000000103";
let streamOpened = false;

vi.mock("../src/services/auth.js", () => ({
  requireRole: vi.fn(() => async (request: any) => {
    request.user = { id: userId, role: "operator" };
  })
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: vi.fn(() => ({
    ipAddress: "203.0.113.10",
    userAgent: "qualification-test"
  })),
  writeAuditEvent
}));

vi.mock("../src/services/backups.js", () => ({
  createBackupWithJob: vi.fn(),
  createHostPathBackupWithJob: vi.fn(),
  deleteBackup: vi.fn(),
  enqueueBackupDrillJob: vi.fn(),
  enqueueBackupVerifyJob: vi.fn(),
  enqueueHostPathRestoreJob: vi.fn(),
  enqueueVolumeRestoreJob: vi.fn(),
  getBackup: vi.fn(),
  getBackupDownloadStream,
  getBackupHealthSummary: vi.fn(),
  listBackups: vi.fn()
}));

vi.mock("../src/services/mappers.js", () => ({
  sanitizeBackupForRead: vi.fn((backup) => backup)
}));

const { registerBackupRoutes } = await import("../src/routes/backups.js");

describe("backup download audit boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamOpened = false;
    getBackupDownloadStream.mockImplementation(async (
      id: string,
      onAuthorized: (
        client: typeof auditClient,
        backup: Record<string, unknown>
      ) => Promise<void>
    ) => {
      const backup = {
        id,
        hostId,
        kind: "volume",
        volumeName: "client-data",
        sourcePath: null,
        fileName: "client-data.tar.gz"
      };
      await onAuthorized(auditClient, backup);
      streamOpened = true;
      return {
        backup,
        stream: Readable.from(Buffer.from("backup-bytes"))
      };
    });
  });

  it.each([
    `/api/backups/${backupId}/download`,
    `/api/v1/backups/${backupId}/download`
  ])("fails closed before opening or returning bytes when audit persistence fails for %s", async (url) => {
    writeAuditEvent.mockRejectedValue(new Error("audit insert failed"));
    const app = Fastify();
    await registerBackupRoutes(app);

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("backup-bytes");
    expect(streamOpened).toBe(false);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        hostId,
        action: "backup.download",
        targetKind: "backup",
        targetId: backupId,
        details: {
          kind: "volume",
          label: "client-data"
        }
      }),
      auditClient
    );
    await app.close();
  });

  it("streams only after the audit record succeeds", async () => {
    writeAuditEvent.mockResolvedValue(undefined);
    const app = Fastify();
    await registerBackupRoutes(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/backups/${backupId}/download`
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("backup-bytes");
    expect(streamOpened).toBe(true);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="client-data.tar.gz"'
    );
    await app.close();
  });
});
