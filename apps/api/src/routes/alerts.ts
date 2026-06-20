import type { FastifyInstance } from "fastify";
import { idSchema } from "@composebastion/shared";
import { z } from "zod";
import { requireRole } from "../services/auth.js";
import { createAlertRule, createAlertSilence, createChannel, deleteAlertRule, deleteAlertSilence, deleteChannel, listAlertChannelTestEvents, listAlertEvents, listAlertRules, listAlertSilences, listChannels, listRecentAlertChannelTestEvents, sendTestNotification } from "../services/alerts.js";
import { writeAuditEvent } from "../services/audit.js";
import { sensitiveMutationRateLimit } from "../services/rateLimits.js";

const testHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

export async function registerAlertRoutes(app: FastifyInstance) {
  const viewer = requireRole(["owner", "admin", "operator", "viewer"]);
  const operator = requireRole(["owner", "admin", "operator"]);

  app.get("/api/alerts/channels", { preHandler: operator }, async () => ({ channels: await listChannels() }));
  app.post("/api/alerts/channels", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const channel = await createChannel(request.body);
    await writeAuditEvent({ userId: request.user?.id, action: "alert.channel.create", targetKind: "notification_channel", targetId: channel.id });
    return { channel };
  });
  app.delete("/api/alerts/channels/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteChannel(id);
    return { ok: true };
  });
  app.post("/api/alerts/channels/:id/test", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const event = await sendTestNotification(id, request.user?.id);
    return { ok: true, event };
  });
  app.get("/api/alerts/channels/test-history", { preHandler: viewer }, async (request) => {
    const { limit } = testHistoryQuerySchema.parse(request.query ?? {});
    return { events: await listRecentAlertChannelTestEvents(limit ?? 20) };
  });
  app.get("/api/alerts/channels/:id/test-history", { preHandler: viewer }, async (request) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    const { limit } = testHistoryQuerySchema.parse(request.query ?? {});
    return { events: await listAlertChannelTestEvents(id, limit ?? 20) };
  });

  app.get("/api/alerts/rules", { preHandler: operator }, async () => ({ rules: await listAlertRules() }));
  app.post("/api/alerts/rules", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const rule = await createAlertRule(request.body);
    await writeAuditEvent({ userId: request.user?.id, action: "alert.rule.create", targetKind: "alert_rule", targetId: rule.id });
    return { rule };
  });
  app.delete("/api/alerts/rules/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteAlertRule(id);
    return { ok: true };
  });

  app.get("/api/alerts/silences", { preHandler: viewer }, async () => ({ silences: await listAlertSilences() }));
  app.post("/api/alerts/silences", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const silence = await createAlertSilence(request.body, request.user?.id);
    await writeAuditEvent({ userId: request.user?.id, hostId: silence.hostId, action: "alert.silence.create", targetKind: "alert_silence", targetId: silence.id });
    return { silence };
  });
  app.delete("/api/alerts/silences/:id", { preHandler: operator, config: { rateLimit: sensitiveMutationRateLimit } }, async (request) => {
    const id = idSchema.parse((request.params as { id: string }).id);
    await deleteAlertSilence(id);
    await writeAuditEvent({ userId: request.user?.id, action: "alert.silence.delete", targetKind: "alert_silence", targetId: id });
    return { ok: true };
  });

  app.get("/api/alerts/history", { preHandler: viewer }, async (request) => ({ events: await listAlertEvents(request.query) }));
}
