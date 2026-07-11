import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const transactionQuery = vi.fn();
const withTransaction = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn(async () => "new-password-hash") }
}));

const { deleteUser, updateUser } = await import("../src/services/users.js");

const ownerId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const ownerRow = {
  id: ownerId,
  name: "Owner",
  username: "owner",
  email: "owner@example.test",
  password_hash: "old-password-hash",
  role: "owner",
  is_active: true,
  last_login_at: null,
  created_at: new Date(0)
};

beforeEach(() => {
  query.mockReset();
  transactionQuery.mockReset();
  withTransaction.mockReset();
  withTransaction.mockImplementation(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
    handler({ query: transactionQuery })
  );
});

describe("account owner invariants", () => {
  it("prevents an actor from changing their own role", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ownerRow] });

    await expect(updateUser(ownerId, { role: "admin" }, ownerId)).rejects.toMatchObject({ statusCode: 409 });
    expect(transactionQuery.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  });

  it("prevents disabling the last active owner", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ownerRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await expect(updateUser(ownerId, { isActive: false }, otherId)).rejects.toMatchObject({
      message: "Cannot disable the last active owner",
      statusCode: 409
    });
  });

  it("atomically disables an owner and revokes sessions when another active owner exists", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ownerRow] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows: [{ ...ownerRow, is_active: false }] })
      .mockResolvedValueOnce({ rows: [] });

    const updated = await updateUser(ownerId, { isActive: false }, otherId);

    expect(updated?.isActive).toBe(false);
    expect(transactionQuery.mock.calls[4]).toEqual(["DELETE FROM sessions WHERE user_id = $1", [ownerId]]);
  });

  it("revokes sessions in the password-update transaction", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ownerRow] })
      .mockResolvedValueOnce({ rows: [ownerRow] })
      .mockResolvedValueOnce({ rows: [] });

    await updateUser(ownerId, { password: "Another-Secure-Pass2" }, ownerId);

    expect(transactionQuery.mock.calls[3]).toEqual(["DELETE FROM sessions WHERE user_id = $1", [ownerId]]);
  });

  it("prevents self-deletion and deletion of the last active owner", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ownerRow] });
    await expect(deleteUser(ownerId, ownerId)).rejects.toMatchObject({ statusCode: 409 });

    transactionQuery.mockReset();
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ownerRow] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });
    await expect(deleteUser(ownerId, otherId)).rejects.toMatchObject({
      message: "Cannot delete the last active owner account",
      statusCode: 409
    });
  });
});
