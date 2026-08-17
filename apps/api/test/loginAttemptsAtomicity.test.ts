import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction
}));

const { isLoginLocked, recordLoginAttempt } = await import("../src/services/loginAttempts.js");

describe("login attempt audit atomicity", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
    withTransaction.mockReset();
    withTransaction.mockImplementation(async (
      callback: (client: { query: typeof transactionQuery }) => Promise<unknown>
    ) => callback({ query: transactionQuery }));
  });

  it("records the attempt and required audit callback on one transaction client", async () => {
    const auditFailure = new Error("audit insert failed");
    transactionQuery.mockResolvedValueOnce({ rows: [] });
    const onRecorded = vi.fn(async (client: { query: typeof transactionQuery }) => {
      expect(client.query).toBe(transactionQuery);
      throw auditFailure;
    });

    await expect(recordLoginAttempt(
      "  OWNER@Example.Test ",
      " 203.0.113.10 ",
      false,
      onRecorded
    )).rejects.toBe(auditFailure);

    expect(transactionQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO login_attempts"),
      ["owner@example.test", "203.0.113.10", false]
    );
    expect(onRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ query: transactionQuery })
    );
  });
});

describe("login lockout scope", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("counts one attacking IP across every attempted identifier", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        ip_failures: "10",
        identifier_failures: "1",
        identifier_distinct_ips: "1"
      }]
    });

    await expect(isLoginLocked("new-target@example.test", "203.0.113.10"))
      .resolves.toBe(true);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain(
      "count(*) FILTER (WHERE COALESCE(ip_address, 'unknown') = $2)"
    );
    expect(sql).toContain(
      "count(*) FILTER (WHERE lower(identifier) = lower($1))"
    );
    expect(sql).not.toMatch(
      /FROM login_attempts\s+WHERE lower\(identifier\) = lower\(\$1\)/
    );
  });
});
