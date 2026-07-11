import { v4 as uuid } from "uuid";
import type { PoolClient } from "pg";
import type { StackVersionSource } from "@composebastion/shared";
import { diffText } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { enqueueJobInTransaction, notifyJobQueued } from "./jobs.js";

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export function mapStackVersion(row: any) {
  return {
    id: row.id,
    stackId: row.stack_id,
    versionNumber: Number(row.version_number),
    composeYaml: row.compose_yaml,
    env: row.env ?? "",
    source: row.source as StackVersionSource,
    note: row.note ?? null,
    createdBy: row.created_by ?? null,
    createdAt: iso(row.created_at)!
  };
}

export type StackVersionInput = {
  stackId: string;
  composeYaml: string;
  env: string;
  source: StackVersionSource;
  createdBy?: string | null;
  note?: string | null;
};

export async function recordStackVersionInTransaction(client: PoolClient, input: StackVersionInput) {
  // Serialize version allocation per stack so concurrent callers cannot choose
  // the same MAX(version_number) + 1 value.
  const stack = await client.query("SELECT id FROM compose_stacks WHERE id = $1 FOR UPDATE", [input.stackId]);
  if (!stack.rows[0]) throw new Error("Compose stack not found");
  const next = await client.query<{ version_number: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
     FROM compose_stack_versions WHERE stack_id = $1`,
    [input.stackId]
  );
  const versionNumber = Number(next.rows[0]?.version_number ?? 1);
  const id = uuid();
  const result = await client.query(
    `INSERT INTO compose_stack_versions (id, stack_id, version_number, compose_yaml, env, source, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, input.stackId, versionNumber, input.composeYaml, input.env, input.source, input.note ?? null, input.createdBy ?? null]
  );
  await client.query(
    `UPDATE compose_stacks SET current_version_id = $2, updated_at = now() WHERE id = $1`,
    [input.stackId, id]
  );
  return mapStackVersion(result.rows[0]);
}

export async function recordStackVersion(input: StackVersionInput) {
  return withTransaction((client) => recordStackVersionInTransaction(client, input));
}

export async function listStackVersions(stackId: string) {
  const result = await query(
    `SELECT * FROM compose_stack_versions WHERE stack_id = $1 ORDER BY version_number DESC`,
    [stackId]
  );
  return result.rows.map(mapStackVersion);
}

export async function getStackVersion(stackId: string, versionId: string) {
  const result = await query(
    `SELECT * FROM compose_stack_versions WHERE stack_id = $1 AND id = $2`,
    [stackId, versionId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Stack version not found");
  return mapStackVersion(row);
}

export async function diffStackVersions(stackId: string, fromVersionId: string, toVersionId: string) {
  const fromVersion = await getStackVersion(stackId, fromVersionId);
  const toVersion = await getStackVersion(stackId, toVersionId);
  return {
    fromVersionId,
    toVersionId,
    fromVersionNumber: fromVersion.versionNumber,
    toVersionNumber: toVersion.versionNumber,
    composeChanges: diffText(fromVersion.composeYaml, toVersion.composeYaml),
    envChanged: fromVersion.env !== toVersion.env
  };
}

export async function rollbackStackVersion(
  stackId: string,
  versionId: string,
  createdBy?: string | null,
  note?: string | null
) {
  const result = await withTransaction(async (client) => {
    const versionResult = await client.query(
      `SELECT * FROM compose_stack_versions WHERE stack_id = $1 AND id = $2`,
      [stackId, versionId]
    );
    const versionRow = versionResult.rows[0];
    if (!versionRow) throw new Error("Stack version not found");
    const version = mapStackVersion(versionRow);

    const stack = await client.query<any>("SELECT * FROM compose_stacks WHERE id = $1 FOR UPDATE", [stackId]);
    const row = stack.rows[0];
    if (!row) throw new Error("Compose stack not found");

    await recordStackVersionInTransaction(client, {
      stackId,
      composeYaml: row.compose_yaml,
      env: row.env ?? "",
      source: "rollback",
      createdBy,
      note: note ?? `Snapshot before rollback to v${version.versionNumber}`
    });

    await client.query(
      `UPDATE compose_stacks
       SET compose_yaml = $2, env = $3, updated_at = now()
       WHERE id = $1`,
      [stackId, version.composeYaml, version.env]
    );

    await recordStackVersionInTransaction(client, {
      stackId,
      composeYaml: version.composeYaml,
      env: version.env,
      source: "rollback",
      createdBy,
      note: note ?? `Rolled back to v${version.versionNumber}`
    });

    const job = await enqueueJobInTransaction(client, {
      type: "compose.deploy",
      hostId: row.host_id,
      payload: { stackId }
    }, createdBy);

    return { version, job };
  });
  await notifyJobQueued(result.job.id);
  return result;
}
