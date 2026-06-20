import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTestNotification = vi.hoisted(() => vi.fn());
const listAlertChannelTestEvents = vi.hoisted(() => vi.fn());
const listRecentAlertChannelTestEvents = vi.hoisted(() => vi.fn());
const passthrough = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({ role: "operator" }));
const requireRole = vi.hoisted(() => vi.fn((roles: string[]) => async (request: any, reply: any) => {
  if (!roles.includes(authState.role)) {
    return reply.code(403).send({ error: "Forbidden" });
  }
  request.user = { id: "22222222-2222-4222-8222-222222222222", role: authState.role };
}));

vi.mock("../src/services/auth.js", () => ({
  requireRole
}));

vi.mock("../src/services/alerts.js", () => ({
  createAlertRule: passthrough,
  createAlertSilence: passthrough,
  createChannel: passthrough,
  deleteAlertRule: passthrough,
  deleteAlertSilence: passthrough,
  deleteChannel: passthrough,
  listAlertChannelTestEvents,
  listAlertEvents: passthrough,
  listAlertRules: passthrough,
  listAlertSilences: passthrough,
  listRecentAlertChannelTestEvents,
  listChannels: passthrough,
  sendTestNotification
}));

vi.mock("../src/services/audit.js", () => ({
  writeAuditEvent: passthrough
}));

const { registerAlertRoutes } = await import("../src/routes/alerts.js");

const channelId = "11111111-1111-4111-8111-111111111111";
const event = {
  id: "33333333-3333-4333-8333-333333333333",
  channelId,
  status: "success",
  error: null,
  testedBy: "22222222-2222-4222-8222-222222222222",
  testedAt: new Date(0).toISOString()
};

async function buildApp() {
  const app = Fastify();
  await registerAlertRoutes(app);
  return app;
}

describe("alert routes", () => {
  beforeEach(() => {
    authState.role = "operator";
    requireRole.mockClear();
    sendTestNotification.mockReset();
    listAlertChannelTestEvents.mockReset();
    listRecentAlertChannelTestEvents.mockReset();
    passthrough.mockReset();
    passthrough.mockResolvedValue([]);
  });

  it("returns alert channel test history", async () => {
    listAlertChannelTestEvents.mockResolvedValue([event]);
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: `/api/alerts/channels/${channelId}/test-history?limit=3`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [event] });
    expect(listAlertChannelTestEvents).toHaveBeenCalledWith(channelId, 3);
    await app.close();
  });

  it("returns recent alert channel test history for viewer role", async () => {
    authState.role = "viewer";
    listRecentAlertChannelTestEvents.mockResolvedValue([event]);
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/alerts/channels/test-history?limit=5"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [event] });
    expect(listRecentAlertChannelTestEvents).toHaveBeenCalledWith(5);
    await app.close();
  });

  it("returns the persisted event from a channel test", async () => {
    sendTestNotification.mockResolvedValue(event);
    const app = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/alerts/channels/${channelId}/test`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, event });
    expect(sendTestNotification).toHaveBeenCalledWith(channelId, event.testedBy);
    await app.close();
  });

  it("keeps alert reads viewer-accessible and mutations operator-gated", async () => {
    authState.role = "viewer";
    listRecentAlertChannelTestEvents.mockResolvedValue([event]);
    const app = await buildApp();

    const readableRoutes = [
      "/api/alerts/history",
      "/api/alerts/silences",
      "/api/alerts/channels/test-history"
    ];
    for (const url of readableRoutes) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
    }

    const blockedRoutes = [
      { method: "GET", url: "/api/alerts/channels" },
      { method: "POST", url: "/api/alerts/channels" },
      { method: "POST", url: `/api/alerts/channels/${channelId}/test` },
      { method: "GET", url: "/api/alerts/rules" },
      { method: "POST", url: "/api/alerts/rules" },
      { method: "POST", url: "/api/alerts/silences" },
      { method: "DELETE", url: `/api/alerts/silences/${channelId}` }
    ];
    for (const route of blockedRoutes) {
      const response = await app.inject(route);
      expect(response.statusCode).toBe(403);
    }

    await app.close();
  });
});
