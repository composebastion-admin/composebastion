import Fastify from "fastify";
import { readFileSync } from "node:fs";
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

  it("returns a validation error for malformed image references", async () => {
    fetchRegistryTags.mockRejectedValue(new RegistryLookupError("Invalid image reference: schemes are not allowed", "invalid"));
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/image-tags?image=https%3A%2F%2Fregistry.example.com%2Facme%2Fapp",
      headers: { "x-request-id": "tags-invalid" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_IMAGE_REFERENCE", requestId: "tags-invalid" });
    await app.close();
  });

  it("exposes blocked private registry addresses as a policy failure", async () => {
    fetchRegistryTags.mockRejectedValue(new RegistryLookupError("Registry target resolves to a blocked network address", "private_address"));
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/image-tags?image=registry.internal%2Facme%2Fapp",
      headers: { "x-request-id": "tags-blocked" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "PRIVATE_REGISTRY_ADDRESS", requestId: "tags-blocked" });
    await app.close();
  });

  it("uses operator authorization and forwards saved-registry trust", async () => {
    const source = readFileSync(new URL("../src/routes/imageIntelligence.ts", import.meta.url), "utf8");
    expect(source).toContain('app.get("/api/image-tags", { preHandler: operator');
    findRegistryAuthForReference.mockResolvedValue({
      username: null,
      password: null,
      insecure: true,
      trustedOrigin: "http://registry.internal:5000"
    });
    fetchRegistryTags.mockResolvedValue(["latest"]);
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/image-tags?image=registry.internal%3A5000%2Facme%2Fapp" });
    expect(response.statusCode).toBe(200);
    expect(fetchRegistryTags).toHaveBeenCalledWith("registry.internal:5000/acme/app", {
      username: null,
      password: null,
      insecure: true,
      trustedOrigin: "http://registry.internal:5000"
    });
    await app.close();
  });
});
