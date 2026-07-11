import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { userCreateSchema, userUpdateSchema } from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { OWNER_INVARIANT_LOCK_KEY } from "./auth.js";
import { mapAdmin } from "./mappers.js";

function conflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

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
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [OWNER_INVARIANT_LOCK_KEY]);
    const result = await client.query(
      `INSERT INTO admin_users (id, name, username, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, username, email, role, is_active, last_login_at, created_at`,
      [uuid(), body.name ?? null, body.username?.toLowerCase() ?? null, body.email.toLowerCase(), passwordHash, body.role]
    );
    return mapAdmin(result.rows[0]);
  });
}

export async function updateUser(id: string, input: unknown, actorId?: string | null) {
  const body = userUpdateSchema.parse(input);
  const passwordHash = body.password ? await bcrypt.hash(body.password, 12) : null;
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [OWNER_INVARIANT_LOCK_KEY]);
    const current = await client.query<any>("SELECT * FROM admin_users WHERE id = $1 FOR UPDATE", [id]);
    const row = current.rows[0];
    if (!row) return null;

    if (actorId === id && body.role !== undefined && body.role !== row.role) {
      throw conflict("You cannot change your own role");
    }
    if (actorId === id && body.isActive === false) {
      throw conflict("You cannot disable your own account");
    }

    const nextRole = body.role ?? row.role;
    const nextActive = body.isActive ?? row.is_active;
    if (row.role === "owner" && row.is_active === true && (nextRole !== "owner" || nextActive !== true)) {
      const owners = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM admin_users WHERE role = 'owner' AND is_active = true AND id <> $1",
        [id]
      );
      if (Number(owners.rows[0]?.count ?? 0) === 0) {
        throw conflict(nextRole !== "owner" ? "Cannot demote the last active owner" : "Cannot disable the last active owner");
      }
    }

    const result = await client.query(
      `UPDATE admin_users
       SET name = $2, role = $3, is_active = $4, password_hash = $5, username = $6
       WHERE id = $1
       RETURNING id, name, username, email, role, is_active, last_login_at, created_at`,
      [
        id,
        body.name === undefined ? row.name : body.name,
        nextRole,
        nextActive,
        passwordHash ?? row.password_hash,
        body.username === undefined ? row.username : body.username?.toLowerCase() ?? null
      ]
    );
    if (body.password || (row.is_active === true && nextActive === false)) {
      await client.query("DELETE FROM sessions WHERE user_id = $1", [id]);
    }
    return mapAdmin(result.rows[0]);
  });
}

export async function deleteUser(id: string, actorId?: string | null) {
  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [OWNER_INVARIANT_LOCK_KEY]);
    const current = await client.query<{ id: string; role: string; is_active: boolean }>(
      "SELECT id, role, is_active FROM admin_users WHERE id = $1 FOR UPDATE",
      [id]
    );
    const row = current.rows[0];
    if (!row) return false;
    if (actorId === id) throw conflict("You cannot delete your own account");
    if (row.role === "owner" && row.is_active === true) {
      const owners = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM admin_users WHERE role = 'owner' AND is_active = true AND id <> $1",
        [id]
      );
      if (Number(owners.rows[0]?.count ?? 0) === 0) {
        throw conflict("Cannot delete the last active owner account");
      }
    }
    await client.query("DELETE FROM admin_users WHERE id = $1", [id]);
    return true;
  });
}
