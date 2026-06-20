import { v4 as uuid } from "uuid";
import { favoriteImageCreateSchema } from "@dockermender/shared";
import { query } from "../db/pool.js";

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

export function mapFavoriteImage(row: any) {
  return {
    id: row.id,
    image: row.image,
    name: row.name,
    notes: row.notes ?? "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export async function listFavoriteImages() {
  const result = await query("SELECT * FROM favorite_images ORDER BY image ASC");
  return result.rows.map(mapFavoriteImage);
}

export async function createFavoriteImage(input: unknown) {
  const body = favoriteImageCreateSchema.parse(input);
  const result = await query(
    `INSERT INTO favorite_images (id, image, name, notes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (image)
     DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()
     RETURNING *`,
    [uuid(), body.image, body.name ?? null, body.notes]
  );
  return mapFavoriteImage(result.rows[0]);
}

export async function deleteFavoriteImage(id: string) {
  await query("DELETE FROM favorite_images WHERE id = $1", [id]);
}
