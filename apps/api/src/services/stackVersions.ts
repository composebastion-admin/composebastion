import { v4 as uuid } from "uuid";
import type { StackVersionSource } from "@dockermender/shared";
import { diffText } from "@dockermender/shared";
import { query } from "../db/pool.js";
import { enqueueJob } from "./jobs.js";

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

export async function recordStackVersion(input: {
  stackId: string;
  composeYaml: string;
  env: string;
  source: StackVersionSource;
  createdBy?: string | null;
  note?: string | null;
}) {
  const next = await query<{ version_number: number }>(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
     FROM compose_stack_versions WHERE stack_id = $1`,
    [input.stackId]
  );
  const versionNumber = Number(next.rows[0]?.version_number ?? 1);
  const id = uuid();
  const result = await query(
    `INSERT INTO compose_stack_versions (id, stack_id, version_number, compose_yaml, env, source, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [id, input.stackId, versionNumber, input.composeYaml, input.env, input.source, input.note ?? null, input.createdBy ?? null]
  );
  await query(
    `UPDATE compose_stacks SET current_version_id = $2, updated_at = now() WHERE id = $1`,
    [input.stackId, id]
  );
  return mapStackVersion(result.rows[0]);
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
  const version = await getStackVersion(stackId, versionId);
  const stack = await query<any>("SELECT * FROM compose_stacks WHERE id = $1", [stackId]);
  const row = stack.rows[0];
  if (!row) throw new Error("Compose stack not found");

  await recordStackVersion({
    stackId,
    composeYaml: row.compose_yaml,
    env: row.env ?? "",
    source: "rollback",
    createdBy,
    note: note ?? `Snapshot before rollback to v${version.versionNumber}`
  });

  await query(
    `UPDATE compose_stacks
     SET compose_yaml = $2, env = $3, updated_at = now()
     WHERE id = $1`,
    [stackId, version.composeYaml, version.env]
  );

  await recordStackVersion({
    stackId,
    composeYaml: version.composeYaml,
    env: version.env,
    source: "rollback",
    createdBy,
    note: note ?? `Rolled back to v${version.versionNumber}`
  });

  const job = await enqueueJob({
    type: "compose.deploy",
    hostId: row.host_id,
    payload: { stackId }
  }, createdBy);

  return { version, job };
}
