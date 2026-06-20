import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchRegistryTags = vi.hoisted(() => vi.fn());
const findRegistryAuthForReference = vi.hoisted(() => vi.fn());

vi.mock("../src/services/auth.js", () => ({
  requireRole: vi.fn(() => async (request: any) => {
    request.user = { id: "22222222-2222-4222-8222-222222222222", role: "owner" };
  })
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  checkImageUpdatesForHost: vi.fn(async () => []),
  findRegistryAuthForReference,
  getImageUpdatePreview: vi.fn(async () => ({ status: "unknown" })),
  listImageUpdateChecks: vi.fn(async () => [])
}));

vi.mock("../src/services/registryManifest.js", () => {
  class RegistryLookupError extends Error {
    constructor(message: string, public readonly reason: string) {
      super(message);
      this.name = "RegistryLookupError";
    }
  }
  return { fetchRegistryTags, RegistryLookupError };
});

vi.mock("../src/services/imageScanner.js", () => ({
  createImageScannerProvider: vi.fn(),
  getImageScannerStatus: vi.fn(async () => ({ provider: "mock", effectiveProvider: "mock", available: true })),
  isTrivyAvailable: vi.fn(() => true),
  listLatestScans: vi.fn(async () => []),
  MockImageScannerProvider: class MockImageScannerProvider {},
  scanImageReference: vi.fn()
}));

vi.mock("../src/services/demo.js", () => ({
  isDemoHostId: vi.fn(async () => false)
}));

vi.mock("../src/services/audit.js", () => ({
  auditContextFromRequest: vi.fn(() => ({})),
  writeAuditEvent: vi.fn(async () => undefined)
}));

const { registerImageIntelligenceRoutes } = await import("../src/routes/imageIntelligence.js");
const { RegistryLookupError } = await import("../src/services/registryManifest.js");

async function buildApp() {
  const app = Fastify({ requestIdHeader: "x-request-id" });
  await registerImageIntelligenceRoutes(app);
  return app;
}

describe("image intelligence routes", () => {
  beforeEach(() => {
    fetchRegistryTags.mockReset();
    findRegistryAuthForReference.mockReset();
    findRegistryAuthForReference.mockResolvedValue(null);
  });

  it("returns a registry error envelope when image tags cannot be listed", async () => {
    fetchRegistryTags.mockRejectedValue(new RegistryLookupError(
      "registry.example.com/acme/app:latest is private or does not exist in the registry",
      "unauthorized"
    ));
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/image-tags?image=registry.example.com/acme/app:latest",
      headers: { "x-request-id": "tags-private" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "registry.example.com/acme/app:latest is private or does not exist in the registry",
      code: "REGISTRY_UNAVAILABLE",
      requestId: "tags-private"
    });
    await app.close();
  });
});
