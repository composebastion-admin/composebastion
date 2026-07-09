import nodemailer from "nodemailer";
import { v4 as uuid } from "uuid";
import { alertRuleCreateSchema, alertSilenceCreateSchema, hostMetricAlertConditionSchema, hostThresholdParamsSchema, notificationChannelCreateSchema } from "@composebastion/shared";
import type { HostMetricAlertCondition } from "@composebastion/shared";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { evaluateHostThreshold } from "./hostAlertEvaluation.js";
import { getFleetHostSnapshot } from "./hostMetrics.js";
import { postJsonWebhook, shouldAllowPrivateWebhookUrls, validateWebhookUrl } from "./webhooks.js";

export function mapChannel(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    emailTo: row.email_to,
    webhookUrl: row.webhook_url,
    enabled: row.enabled,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export function mapAlertRule(row: any) {
  return {
    id: row.id,
    name: row.name,
    condition: row.condition,
    hostId: row.host_id,
    containerId: row.container_id,
    channelId: row.channel_id,
    enabled: row.enabled,
    params: row.params ?? null,
    breachingSince: row.breaching_since ? new Date(row.breaching_since).toISOString() : null,
    lastState: row.last_state,
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    lastNotifiedAt: row.last_notified_at ? new Date(row.last_notified_at).toISOString() : null,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export function mapAlertSilence(row: any) {
  return {
    id: row.id,
    name: row.name,
    hostId: row.host_id ?? null,
    ruleId: row.rule_id ?? null,
    startsAt: new Date(row.starts_at).toISOString(),
    endsAt: new Date(row.ends_at).toISOString(),
    reason: row.reason ?? null,
    createdBy: row.created_by ?? null,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export function mapAlertEvent(row: any) {
  return {
    id: row.id,
    ruleId: row.rule_id ?? null,
    hostId: row.host_id ?? null,
    channelId: row.channel_id ?? null,
    state: row.state,
    message: row.message,
    notified: Boolean(row.notified),
    silenced: Boolean(row.silenced),
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export function mapAlertChannelTestEvent(row: any) {
  return {
    id: row.id,
    channelId: row.channel_id,
    status: row.status,
    error: row.error ?? null,
    testedBy: row.tested_by ?? null,
    testedAt: new Date(row.tested_at).toISOString()
  };
}

export async function listChannels() {
  const result = await query("SELECT * FROM notification_channels ORDER BY name ASC");
  return result.rows.map(mapChannel);
}

export async function createChannel(input: unknown) {
  const body = notificationChannelCreateSchema.parse(input);
  if (body.type === "webhook" && body.webhookUrl) {
    const allowed = await validateWebhookUrl(body.webhookUrl, {
      allowPrivateNetwork: shouldAllowPrivateWebhookUrls(env.NODE_ENV, env.ALLOW_PRIVATE_WEBHOOK_URLS)
    });
    if (!allowed) {
      throw Object.assign(new Error("Webhook URL resolves to a private network address, which is blocked by default in production to prevent request forgery. Set ALLOW_PRIVATE_WEBHOOK_URLS=true only when internal webhook targets are intentional."), { statusCode: 400 });
    }
  }
  const result = await query(
    `INSERT INTO notification_channels (id, name, type, email_to, webhook_url, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [uuid(), body.name, body.type, body.emailTo ?? null, body.webhookUrl ?? null, body.enabled]
  );
  return mapChannel(result.rows[0]);
}

export async function deleteChannel(id: string) {
  await query("DELETE FROM notification_channels WHERE id = $1", [id]);
}

export async function listAlertChannelTestEvents(channelId: string, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await query(
    `SELECT *
     FROM alert_channel_test_events
     WHERE channel_id = $1
     ORDER BY tested_at DESC
     LIMIT $2`,
    [channelId, safeLimit]
  );
  return result.rows.map(mapAlertChannelTestEvent);
}

export async function listRecentAlertChannelTestEvents(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await query(
    `SELECT *
     FROM alert_channel_test_events
     ORDER BY tested_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map(mapAlertChannelTestEvent);
}

async function recordAlertChannelTestEvent(channelId: string, status: "success" | "failed", error: string | null, testedBy?: string | null) {
  const result = await query(
    `INSERT INTO alert_channel_test_events (id, channel_id, status, error, tested_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [uuid(), channelId, status, error, testedBy ?? null]
  );
  return mapAlertChannelTestEvent(result.rows[0]);
}

export async function listAlertRules() {
  const result = await query("SELECT * FROM alert_rules ORDER BY name ASC");
  return result.rows.map(mapAlertRule);
}

export async function createAlertRule(input: unknown) {
  const body = alertRuleCreateSchema.parse(input);
  const params = "params" in body ? body.params : null;
  const containerId = "containerId" in body ? body.containerId ?? null : null;
  const result = await query(
    `INSERT INTO alert_rules (id, name, condition, host_id, container_id, channel_id, enabled, params)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [uuid(), body.name, body.condition, body.hostId, containerId, body.channelId, body.enabled, params]
  );
  return mapAlertRule(result.rows[0]);
}

export async function deleteAlertRule(id: string) {
  await query("DELETE FROM alert_rules WHERE id = $1", [id]);
}

export async function listAlertSilences() {
  const result = await query("SELECT * FROM alert_silences ORDER BY ends_at DESC, created_at DESC");
  return result.rows.map(mapAlertSilence);
}

export async function createAlertSilence(input: unknown, createdBy?: string | null) {
  const body = alertSilenceCreateSchema.parse(input);
  const result = await query(
    `INSERT INTO alert_silences (id, name, host_id, rule_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      uuid(),
      body.name,
      body.hostId ?? null,
      body.ruleId ?? null,
      body.startsAt ? new Date(body.startsAt) : new Date(),
      new Date(body.endsAt),
      body.reason ?? null,
      createdBy ?? null
    ]
  );
  return mapAlertSilence(result.rows[0]);
}

export async function deleteAlertSilence(id: string) {
  await query("DELETE FROM alert_silences WHERE id = $1", [id]);
}

export async function listAlertEvents(input: unknown = {}) {
  const parsed = (input && typeof input === "object" ? input : {}) as { limit?: unknown; ruleId?: unknown };
  const limit = Math.min(Math.max(Number(parsed.limit ?? 100) || 100, 1), 200);
  const ruleId = typeof parsed.ruleId === "string" ? parsed.ruleId : null;
  const result = ruleId
    ? await query(
      `SELECT * FROM alert_events
       WHERE rule_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [ruleId, limit]
    )
    : await query(
      `SELECT * FROM alert_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
  return result.rows.map(mapAlertEvent);
}

async function sendChannel(row: any, subject: string, message: string) {
  if (!row.enabled) return;
  if (row.type === "webhook") {
    const response = await postJsonWebhook(row.webhook_url, { subject, message, source: "ComposeBastion" }, {
      allowPrivateNetwork: shouldAllowPrivateWebhookUrls(env.NODE_ENV, env.ALLOW_PRIVATE_WEBHOOK_URLS)
    });
    if (!response.ok) throw new Error(`Webhook failed with ${response.statusCode}`);
    return;
  }

  if (!env.SMTP_HOST) throw new Error("SMTP_HOST is not configured");
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined
  });
  await transporter.sendMail({
    from: env.SMTP_FROM,
    to: row.email_to,
    subject,
    text: message
  });
}

export async function sendTestNotification(channelId: string, testedBy?: string | null) {
  const result = await query<any>("SELECT * FROM notification_channels WHERE id = $1", [channelId]);
  const channel = result.rows[0];
  if (!channel) throw new Error("Notification channel not found");
  try {
    await sendChannel(channel, "ComposeBastion test notification", "This is a test notification from ComposeBastion.");
    return await recordAlertChannelTestEvent(channelId, "success", null, testedBy);
  } catch (error) {
    await recordAlertChannelTestEvent(channelId, "failed", error instanceof Error ? error.message : String(error), testedBy);
    throw error;
  }
}

export async function sendNotificationToEnabledChannels(subject: string, message: string) {
  const result = await query<any>(
    "SELECT * FROM notification_channels WHERE enabled = true ORDER BY name ASC"
  );
  const failures: string[] = [];
  let sent = 0;
  for (const channel of result.rows) {
    try {
      await sendChannel(channel, subject, message);
      sent += 1;
    } catch (error) {
      failures.push(`${channel.name ?? channel.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sent, failures };
}

function isHostMetricCondition(condition: string): condition is HostMetricAlertCondition {
  return hostMetricAlertConditionSchema.safeParse(condition).success;
}

export function alertSilenceMatches(
  silence: { rule_id?: string | null; host_id?: string | null; starts_at: Date | string; ends_at: Date | string },
  rule: { rule_id: string; host_id: string },
  now = new Date()
) {
  const startsAt = new Date(silence.starts_at).getTime();
  const endsAt = new Date(silence.ends_at).getTime();
  const at = now.getTime();
  if (at < startsAt || at > endsAt) return false;
  return silence.rule_id === rule.rule_id || silence.host_id === rule.host_id;
}

async function activeSilenceForRule(row: any, now: Date) {
  const result = await query<any>(
    `SELECT *
     FROM alert_silences
     WHERE starts_at <= $1
       AND ends_at >= $1
       AND (rule_id = $2 OR host_id = $3)
     ORDER BY rule_id NULLS LAST, created_at DESC
     LIMIT 1`,
    [now, row.rule_id, row.host_id]
  );
  const silence = result.rows[0];
  return silence && alertSilenceMatches(silence, row, now) ? silence : null;
}

async function recordAlertEvent(row: any, state: string, message: string, options: { notified?: boolean; silenced?: boolean; error?: string | null } = {}) {
  await query(
    `INSERT INTO alert_events (id, rule_id, host_id, channel_id, state, message, notified, silenced, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuid(),
      row.rule_id ?? null,
      row.host_id ?? null,
      row.channel_id ?? null,
      state,
      message,
      options.notified ?? false,
      options.silenced ?? false,
      options.error ?? null
    ]
  );
}

export async function runAlertChecks() {
  const result = await query<any>(
    `SELECT notification_channels.*, alert_rules.*,
            alert_rules.id AS rule_id,
            alert_rules.name AS rule_name,
            notification_channels.name AS channel_name
     FROM alert_rules
     JOIN notification_channels ON notification_channels.id = alert_rules.channel_id
     WHERE alert_rules.enabled = true`
  );

  for (const row of result.rows) {
    try {
      const now = new Date();
      let triggered = false;
      let message = "";
      let nextBreachingSince: Date | null = null;
      if (row.condition === "host.offline") {
        const host = await query<any>("SELECT * FROM docker_hosts WHERE id = $1", [row.host_id]);
        const hostRow = host.rows[0];
        triggered = hostRow?.last_status === "offline";
        message = `${hostRow?.name ?? "Host"} is offline: ${hostRow?.last_error ?? "No error recorded"}`;
      } else if (row.condition === "container.not_running" && row.container_id) {
        const container = await query<any>(
          "SELECT * FROM resource_snapshots WHERE host_id = $1 AND kind = 'container' AND external_id = $2",
          [row.host_id, row.container_id]
        );
        const data = container.rows[0]?.data ?? {};
        triggered = data.State && data.State !== "running";
        message = `${container.rows[0]?.name ?? row.container_id} is ${data.State ?? "missing"}`;
      } else if (isHostMetricCondition(row.condition)) {
        const host = await query<any>("SELECT name FROM docker_hosts WHERE id = $1", [row.host_id]);
        const hostName = host.rows[0]?.name ?? "Host";
        const params = hostThresholdParamsSchema.parse(row.params);
        const snapshot = await getFleetHostSnapshot(row.host_id);
        const evaluation = evaluateHostThreshold(
          row.condition,
          params,
          snapshot.stats,
          row.breaching_since ? new Date(row.breaching_since) : null,
          now,
          hostName
        );
        triggered = evaluation.triggered;
        message = evaluation.message;
        nextBreachingSince = evaluation.nextBreachingSince;
      }

      const nextState = triggered ? "triggered" : "ok";
      const silence = await activeSilenceForRule(row, now);
      const silenced = Boolean(silence);
      await query("UPDATE alert_rules SET last_checked_at = now(), last_state = $2, last_error = null, breaching_since = $3 WHERE id = $1", [
        row.rule_id,
        nextState,
        nextBreachingSince
      ]);

      const shouldNotify = !silenced && triggered && (!row.last_notified_at || Date.now() - new Date(row.last_notified_at).getTime() > 15 * 60_000);
      if (shouldNotify) {
        await sendChannel(row, `ComposeBastion alert: ${row.rule_name}`, message);
        await query("UPDATE alert_rules SET last_notified_at = now() WHERE id = $1", [row.rule_id]);
      }
      const recovered = !silenced && row.last_state === "triggered" && nextState === "ok" && row.last_notified_at;
      if (recovered) {
        await sendChannel(row, `ComposeBastion recovered: ${row.rule_name}`, `${row.rule_name} recovered.`);
        await query("UPDATE alert_rules SET last_notified_at = now() WHERE id = $1", [row.rule_id]);
      }
      if (row.last_state !== nextState || shouldNotify || recovered || silenced) {
        await recordAlertEvent(row, nextState, silenced ? `${message || row.rule_name} (silenced by ${silence?.name ?? "silence"})` : message || row.rule_name, {
          notified: shouldNotify || Boolean(recovered),
          silenced
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await query("UPDATE alert_rules SET last_error = $2 WHERE id = $1", [row.rule_id, message]);
      await recordAlertEvent(row, "error", message, { error: message });
    }
  }
}
