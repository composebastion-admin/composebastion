import { v4 as uuid } from "uuid";
import { registryCreateSchema } from "@dockermender/shared";
import { query } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

export function mapRegistry(row: any) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username,
    insecure: row.insecure,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function listRegistries() {
  const result = await query("SELECT * FROM registries ORDER BY name ASC");
  return result.rows.map(mapRegistry);
}

export async function createRegistry(input: unknown) {
  const body = registryCreateSchema.parse(input);
  const result = await query(
    `INSERT INTO registries (id, name, url, username, password_encrypted, insecure)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [uuid(), body.name, body.url, body.username ?? null, body.password ? encryptSecret(body.password) : null, body.insecure]
  );
  return mapRegistry(result.rows[0]);
}

export async function deleteRegistry(id: string) {
  await query("DELETE FROM registries WHERE id = $1", [id]);
}

export async function getRegistryForWorker(id: string) {
  const result = await query<any>("SELECT * FROM registries WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Registry not found");
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username as string | null,
    password: row.password_encrypted ? decryptSecret(row.password_encrypted) : null,
    insecure: row.insecure as boolean
  };
}
