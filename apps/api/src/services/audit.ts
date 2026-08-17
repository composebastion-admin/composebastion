import { v4 as uuid } from "uuid";
import type { AuditAction, AuditEvent } from "@composebastion/shared";
import {
  paginationQuerySchema,
  paginatedResponse,
  sanitizeGitRepositoryUrlFields
} from "@composebastion/shared";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { query } from "../db/pool.js";

const secretDetailKeys = new Set([
  "password",
  "credentialpassword",
  "dbpassword",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "clientsecret",
  "privatekey",
  "secretkey",
  "sshprivatekey",
  "sshpassword",
  "sshkeypassphrase",
  "agenttoken",
  "githubtoken",
  "credentialsecret",
  "credentials",
  "rcloneconfig",
  "rclonecredentials",
  "genericconfig",
  "genericcredentials",
  "registrypassword",
  "smtppassword",
  "webhooksecret",
  "accesskeyid",
  "secretaccesskey",
  "appsecret",
  "appsecretkey"
]);

function isSecretDetailKey(key: string, value: unknown) {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (typeof value === "boolean" && (normalized === "secret" || normalized.startsWith("has"))) {
    return false;
  }
  if (secretDetailKeys.has(normalized)) return true;
  const encryptedSuffix = "encrypted";
  if (
    normalized.endsWith(encryptedSuffix)
    && secretDetailKeys.has(normalized.slice(0, -encryptedSuffix.length))
  ) {
    return true;
  }
  if (
    typeof value !== "boolean"
    && (
      normalized.includes("secret")
      || normalized.includes("apikey")
      || normalized.endsWith("credential")
      || normalized.endsWith("credentials")
    )
  ) {
    return true;
  }
  return ["password", "passphrase", "token", "privatekey"]
    .some((suffix) => normalized.endsWith(suffix));
}

function redactAuditSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditSecretFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSecretDetailKey(key, item) ? "[redacted]" : redactAuditSecretFields(item)
    ])
  );
}

function sanitizeAuditDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return redactAuditSecretFields(
    sanitizeGitRepositoryUrlFields(value)
  ) as Record<string, unknown>;
}

function mapAudit(row: any): AuditEvent {
  return {
    id: row.id,
    userId: row.user_id,
    hostId: row.host_id,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    details: sanitizeAuditDetails(row.details),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export function auditContextFromRequest(request: FastifyRequest) {
  // request.ip is derived by Fastify from X-Forwarded-For only when TRUST_PROXY is
  // configured; otherwise it is the direct socket address. Never read the header
  // directly here or clients can spoof the audited IP.
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
  };
}

export async function writeAuditEvent(input: {
  userId?: string | null;
  hostId?: string | null;
  action: AuditAction;
  targetKind?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}, client?: PoolClient) {
  const safeDetails = sanitizeAuditDetails(input.details);

  const execute = client ? client.query.bind(client) : query;
  await execute(
    `INSERT INTO audit_events (id, user_id, host_id, action, target_kind, target_id, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      uuid(),
      input.userId ?? null,
      input.hostId ?? null,
      input.action,
      input.targetKind ?? null,
      input.targetId ?? null,
      safeDetails,
      input.ipAddress ?? null,
      input.userAgent ?? null
    ]
  );
}

export async function listAuditEvents(queryInput: unknown) {
  const queryParams = paginationQuerySchema.parse(queryInput);
  const [rows, total] = await Promise.all([
    query(
      `SELECT *
       FROM audit_events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [queryParams.limit, queryParams.offset]
    ),
    query<{ count: string }>("SELECT count(*)::text AS count FROM audit_events")
  ]);
  return paginatedResponse(
    rows.rows.map(mapAudit),
    Number(total.rows[0]?.count ?? 0),
    queryParams
  );
}
