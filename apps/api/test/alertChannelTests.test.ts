import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const postJsonWebhook = vi.hoisted(() => vi.fn());
const validateWebhookUrl = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../src/db/pool.js", () => ({ query }));
vi.mock("../src/services/webhooks.js", () => ({
  postJsonWebhook,
  shouldAllowPrivateWebhookUrls: (nodeEnv: string, allowPrivateWebhookUrls: boolean) => nodeEnv !== "production" || allowPrivateWebhookUrls,
  validateWebhookUrl
}));

const { createChannel, listAlertChannelTestEvents, listRecentAlertChannelTestEvents, runAlertChecks, sendTestNotification } = await import("../src/services/alerts.js");

const channelId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const eventRow = {
  id: "33333333-3333-4333-8333-333333333333",
  channel_id: channelId,
  status: "success",
  error: null,
  tested_by: userId,
  tested_at: new Date("2026-06-17T05:00:00.000Z")
};

describe("alert channel test history", () => {
  beforeEach(() => {
    query.mockReset();
    postJsonWebhook.mockReset();
    validateWebhookUrl.mockReset();
    validateWebhookUrl.mockResolvedValue(true);
    vi.unstubAllGlobals();
  });

  it("rejects blocked webhook targets before inserting the channel", async () => {
    validateWebhookUrl.mockResolvedValueOnce(false);

    await expect(createChannel({
      name: "Blocked hook",
      type: "webhook",
      webhookUrl: "http://127.0.0.1/hook",
      enabled: true
    })).rejects.toThrow("private network address");
    expect(query).not.toHaveBeenCalled();
  });

  it("records a successful channel test", async () => {
    postJsonWebhook.mockResolvedValueOnce({ ok: true, statusCode: 202 });
    query
      .mockResolvedValueOnce({ rows: [{ id: channelId, enabled: true, type: "webhook", webhook_url: "https://example.com/hook" }] })
      .mockResolvedValueOnce({ rows: [eventRow] });

    const event = await sendTestNotification(channelId, userId);

    expect(event).toMatchObject({ channelId, status: "success", testedBy: userId });
    expect(postJsonWebhook).toHaveBeenCalledWith(
      "https://example.com/hook",
      { subject: "ComposeBastion test notification", message: "This is a test notification from ComposeBastion.", source: "ComposeBastion" },
      expect.objectContaining({ allowPrivateNetwork: true })
    );
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO alert_channel_test_events");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([channelId, "success", null, userId]));
  });

  it("records failed channel tests before rethrowing", async () => {
    postJsonWebhook.mockResolvedValueOnce({ ok: false, statusCode: 500 });
    query
      .mockResolvedValueOnce({ rows: [{ id: channelId, enabled: true, type: "webhook", webhook_url: "https://example.com/hook" }] })
      .mockResolvedValueOnce({ rows: [{ ...eventRow, status: "failed", error: "Webhook failed with 500" }] });

    await expect(sendTestNotification(channelId, userId)).rejects.toThrow("Webhook failed with 500");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([channelId, "failed", "Webhook failed with 500", userId]));
  });

  it("lists recent channel test events with a bounded limit", async () => {
    query.mockResolvedValueOnce({ rows: [eventRow] });

    const events = await listAlertChannelTestEvents(channelId, 999);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channelId, testedAt: "2026-06-17T05:00:00.000Z" });
    expect(query.mock.calls[0]?.[1]).toEqual([channelId, 100]);
  });

  it("lists aggregate channel test events with a bounded limit", async () => {
    query.mockResolvedValueOnce({ rows: [eventRow] });

    const events = await listRecentAlertChannelTestEvents(0);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channelId, testedAt: "2026-06-17T05:00:00.000Z" });
    expect(query.mock.calls[0]?.[0]).toContain("FROM alert_channel_test_events");
    expect(query.mock.calls[0]?.[0]).not.toContain("WHERE channel_id");
    expect(query.mock.calls[0]?.[1]).toEqual([20]);
  });

  it("uses the alert rule name rather than the joined channel name in worker notifications", async () => {
    postJsonWebhook.mockResolvedValueOnce({ ok: true, statusCode: 202 });
    query
      .mockResolvedValueOnce({
        rows: [{
          id: channelId,
          rule_id: "44444444-4444-4444-8444-444444444444",
          rule_name: "Production host offline",
          channel_name: "Operations webhook",
          condition: "host.offline",
          host_id: "55555555-5555-4555-8555-555555555555",
          channel_id: channelId,
          container_id: null,
          enabled: true,
          type: "webhook",
          webhook_url: "https://example.com/hook",
          last_state: "ok",
          last_notified_at: null
        }]
      })
      .mockResolvedValueOnce({ rows: [{ name: "prod-01", last_status: "offline", last_error: "connection refused" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runAlertChecks();

    expect(query.mock.calls[0]?.[0]).toContain("alert_rules.name AS rule_name");
    expect(postJsonWebhook).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({ subject: "ComposeBastion alert: Production host offline" }),
      expect.objectContaining({ allowPrivateNetwork: true })
    );
  });
});
