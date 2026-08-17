import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/pool.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_IP_FAILURES = 10;
const MAX_IDENTIFIER_FAILURES = 30;
const MIN_IDENTIFIER_LOCK_IPS = 3;

export type LoginFailureSnapshot = {
  ipFailures: number;
  identifierFailures: number;
  identifierDistinctIps: number;
};

function normalizeIdentifier(identifier: string) {
  return identifier.trim().toLowerCase();
}

function normalizeIpAddress(ipAddress: string) {
  return ipAddress.trim() || "unknown";
}

export function isLoginLockedForSnapshot(snapshot: LoginFailureSnapshot) {
  return snapshot.ipFailures >= MAX_IP_FAILURES ||
    (snapshot.identifierFailures >= MAX_IDENTIFIER_FAILURES && snapshot.identifierDistinctIps >= MIN_IDENTIFIER_LOCK_IPS);
}

export async function recordLoginAttempt(
  identifier: string,
  ipAddress: string,
  success: boolean,
  onRecorded?: (client: PoolClient) => Promise<void>
) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO login_attempts (identifier, ip_address, success) VALUES ($1, $2, $3)`,
      [normalizeIdentifier(identifier), normalizeIpAddress(ipAddress), success]
    );
    await onRecorded?.(client);
  });
}

export async function isLoginLocked(identifier: string, ipAddress: string) {
  const since = new Date(Date.now() - WINDOW_MS);
  const result = await query<{
    ip_failures: string;
    identifier_failures: string;
    identifier_distinct_ips: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE COALESCE(ip_address, 'unknown') = $2)::text AS ip_failures,
       count(*) FILTER (WHERE lower(identifier) = lower($1))::text AS identifier_failures,
       count(DISTINCT COALESCE(ip_address, 'unknown'))
         FILTER (WHERE lower(identifier) = lower($1))::text AS identifier_distinct_ips
     FROM login_attempts
     WHERE success = false
       AND attempted_at >= $3`,
    [normalizeIdentifier(identifier), normalizeIpAddress(ipAddress), since]
  );
  const row = result.rows[0];
  return isLoginLockedForSnapshot({
    ipFailures: Number(row?.ip_failures ?? 0),
    identifierFailures: Number(row?.identifier_failures ?? 0),
    identifierDistinctIps: Number(row?.identifier_distinct_ips ?? 0)
  });
}
