import type { PoolClient } from "pg";

export const HOST_CREATE_LOCK_ID = "484624819832837";

/**
 * Serialize every transaction that reads and then writes normalized host
 * identities. Call this before any host identity read so create, restore,
 * configuration import, and demo seeding cannot race each other's preflight.
 */
export async function lockHostIdentityScope(client: Pick<PoolClient, "query">) {
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [HOST_CREATE_LOCK_ID]);
}
