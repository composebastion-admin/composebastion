import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { userCreateSchema, userUpdateSchema } from "@dockermender/shared";
import { query } from "../db/pool.js";
import { destroyAllSessionsForUser } from "./auth.js";
import { mapAdmin } from "./mappers.js";

export async function listUsers() {
  const result = await query(
    "SELECT id, name, username, email, role, is_active, last_login_at, created_at FROM admin_users ORDER BY created_at ASC"
  );
  return result.rows.map(mapAdmin);
}

export async function countActiveOwners(excludeUserId?: string) {
  const result = excludeUserId
    ? await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM admin_users WHERE role = 'owner' AND is_active = true AND id <> $1",
        [excludeUserId]
      )
    : await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM admin_users WHERE role = 'owner' AND is_active = true"
      );
  return Number(result.rows[0]?.count ?? 0);
}

export async function createUser(input: unknown) {
  const body = userCreateSchema.parse(input);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const result = await query(
    `INSERT INTO admin_users (id, name, username, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, username, email, role, is_active, last_login_at, created_at`,
    [uuid(), body.name ?? null, body.username?.toLowerCase() ?? null, body.email.toLowerCase(), passwordHash, body.role]
  );
  return mapAdmin(result.rows[0]);
}

export async function updateUser(id: string, input: unknown) {
  const body = userUpdateSchema.parse(input);
  const current = await query<any>("SELECT * FROM admin_users WHERE id = $1", [id]);
  const row = current.rows[0];
  if (!row) return null;
  if (body.role && body.role !== "owner" && row.role === "owner") {
    const owners = await countActiveOwners(id);
    if (owners === 0) throw Object.assign(new Error("Cannot demote the last owner"), { statusCode: 409 });
  }
  const passwordHash = body.password ? await bcrypt.hash(body.password, 12) : row.password_hash;
  const result = await query(
    `UPDATE admin_users
     SET name = $2, role = $3, is_active = $4, password_hash = $5, username = $6
     WHERE id = $1
     RETURNING id, name, username, email, role, is_active, last_login_at, created_at`,
    [
      id,
      body.name === undefined ? row.name : body.name,
      body.role ?? row.role,
      body.isActive ?? row.is_active,
      passwordHash,
      body.username === undefined ? row.username : body.username?.toLowerCase() ?? null
    ]
  );
  if (body.password) await destroyAllSessionsForUser(id);
  return mapAdmin(result.rows[0]);
}

export async function deleteUser(id: string) {
  const current = await query<{ id: string; role: string }>("SELECT id, role FROM admin_users WHERE id = $1", [id]);
  const row = current.rows[0];
  if (!row) return;
  if (row.role === "owner" && (await countActiveOwners()) <= 1) {
    throw Object.assign(new Error("Cannot delete the last owner account"), { statusCode: 409 });
  }
  await query("DELETE FROM admin_users WHERE id = $1", [id]);
}
