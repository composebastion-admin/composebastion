import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction
}));

const { createFavoriteImage } = await import("../src/services/favorites.js");

describe("favorite image audit atomicity", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
    withTransaction.mockReset();
    withTransaction.mockImplementation(async (
      callback: (client: { query: typeof transactionQuery }) => Promise<unknown>
    ) => callback({ query: transactionQuery }));
  });

  it("runs persistence and its required audit callback on one transaction client", async () => {
    const auditFailure = new Error("audit insert failed");
    transactionQuery.mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        image: "registry.example.test/team/app:1.2.0",
        name: "App",
        notes: "",
        created_at: new Date(0),
        updated_at: new Date(0)
      }]
    });
    const onChanged = vi.fn(async (client: { query: typeof transactionQuery }) => {
      expect(client.query).toBe(transactionQuery);
      throw auditFailure;
    });

    await expect(createFavoriteImage({
      image: "registry.example.test/team/app:1.2.0",
      name: "App",
      notes: ""
    }, onChanged)).rejects.toBe(auditFailure);

    expect(transactionQuery.mock.calls[0]?.[0]).toContain(
      "INSERT INTO favorite_images"
    );
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ query: transactionQuery }),
      expect.objectContaining({
        image: "registry.example.test/team/app:1.2.0"
      })
    );
  });
});
