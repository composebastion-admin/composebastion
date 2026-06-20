import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { imageScanRequestSchema } from "@dockermender/shared";
import { requireRole } from "../services/auth.js";
import { checkImageUpdatesForHost, findRegistryAuthForReference, getImageUpdatePreview, listImageUpdateChecks } from "../services/imageUpdates.js";
import {
  createImageScannerProvider,
  getImageScannerStatus,
  isTrivyAvailable,
  listLatestScans,
  MockImageScannerProvider,
  scanImageReference
} from "../services/imageScanner.js";
import { isDemoHostId } from "../services/demo.js";
import { fetchRegistryTags, RegistryLookupError } from "../services/registryManifest.js";
import { writeAuditEvent, auditContextFromRequest } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";
import { sendApiError } from "../services/apiError.js";

import { env } from "../config/env.js";

export async function registerImageIntelligenceRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/image-updates", { preHandler: viewer }, async (request) => {
    const { hostId } = request.query as { hostId?: string };
    return { updates: await listImageUpdateChecks(hostId) };
  });

  app.get("/api/image-updates/preview", { preHandler: viewer }, async (request) => {
    const { hostId, image } = z.object({
      hostId: z.string().uuid(),
      image: z.string().trim().min(1).max(512)
    }).parse(request.query);
    return { preview: await getImageUpdatePreview(hostId, image) };
  });

  app.get("/api/image-scanner/status", { preHandler: viewer }, async () => ({
    status: await getImageScannerStatus((env.IMAGE_SCANNER_PROVIDER || "auto") as "auto" | "mock" | "trivy")
  }));

  app.get("/api/image-tags", { preHandler: viewer }, async (request, reply) => {
    const { image } = z.object({ image: z.string().trim().min(1).max(512) }).parse(request.query);
    try {
      const auth = await findRegistryAuthForReference(image);
      const tags = await fetchRegistryTags(
        image,
        auth?.username && auth.password
          ? { username: auth.username, password: auth.password, insecure: auth.insecure }
          : undefined
      );
      return { image, tags };
    } catch (error) {
      if (error instanceof RegistryLookupError) {
        return sendApiError(
          reply,
          error.reason === "rate_limited" ? 429 : 503,
          error.reason === "rate_limited" ? "RATE_LIMITED" : "REGISTRY_UNAVAILABLE",
          error.message
        );
      }
      throw error;
    }
  });

  app.post("/api/image-updates/check", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { hostId } = request.body as { hostId: string };
    const updates = await checkImageUpdatesForHost(hostId);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId,
      action: "image.update_check",
      targetKind: "host",
      targetId: hostId,
      ...auditContextFromRequest(request)
    });
    return { updates };
  });

  app.get("/api/image-scans", { preHandler: viewer }, async (request) => {
    const { hostId } = request.query as { hostId?: string };
    return { scans: await listLatestScans(hostId) };
  });

  app.post("/api/image-scans", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request, reply) => {
    const body = imageScanRequestSchema.parse(request.body);
    const demoHost = await isDemoHostId(body.hostId);
    const preferred = (env.IMAGE_SCANNER_PROVIDER || "auto") as "auto" | "mock" | "trivy";
    if (demoHost && preferred !== "trivy") {
      // Demo images do not exist in any registry; a real scanner cannot pull them.
      const scan = await scanImageReference(body.hostId, body.imageReference, new MockImageScannerProvider());
      return { scan };
    }
    if (preferred === "auto" && !isTrivyAvailable()) {
      reply.code(503);
      return {
        error: "Vulnerability scanning needs Trivy on the Dockermender server. The official Docker image ships with it; for manual installs see trivy.dev, or set IMAGE_SCANNER_PROVIDER=mock for simulated results."
      };
    }
    const provider = createImageScannerProvider(preferred);
    const scan = await scanImageReference(body.hostId, body.imageReference, provider);
    await writeAuditEvent({
      userId: request.user?.id,
      hostId: body.hostId,
      action: "image.scan",
      targetKind: "image",
      targetId: body.imageReference,
      details: { scanner: scan.scanner, severityCounts: scan.severityCounts },
      ...auditContextFromRequest(request)
    });
    return { scan };
  });
}
