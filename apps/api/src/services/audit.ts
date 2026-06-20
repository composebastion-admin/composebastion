import { v4 as uuid } from "uuid";
import type { AuditEvent } from "@dockermender/shared";
import { paginationQuerySchema, paginatedResponse } from "@dockermender/shared";
import type { FastifyRequest } from "fastify";
import { query } from "../db/pool.js";
function mapAudit(row: any): AuditEvent {
  return {
    id: row.id,
    userId: row.user_id,
    hostId: row.host_id,
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    details: row.details ?? {},
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
  action: string;
  targetKind?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const safeDetails = { ...(input.details ?? {}) };
  for (const key of ["password", "sshPrivateKey", "sshPassword", "agentToken", "token", "passphrase"]) {
    if (key in safeDetails) safeDetails[key] = "[redacted]";
  }

  await query(
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
