import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

const query = vi.fn();
const transactionQuery = vi.fn();
const withTransaction = vi.fn();
const bcryptHash = vi.hoisted(() => vi.fn(async () => "password-hash"));
const bcryptCompare = vi.hoisted(() => vi.fn(async () => false));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: (...args: unknown[]) => bcryptHash(...args),
    compare: (...args: unknown[]) => bcryptCompare(...args)
  }
}));

const {
  createLoginSession,
  createSession,
  createAdmin,
  deleteExpiredSessions,
  hashToken,
  listSessionsForUser,
  readSession,
  revokeSessionForUser,
  verifyAdmin
} = await import("../src/services/auth.js");

beforeEach(() => {
  query.mockReset();
  transactionQuery.mockReset();
  withTransaction.mockReset();
  bcryptHash.mockReset();
  bcryptHash.mockResolvedValue("password-hash");
  bcryptCompare.mockReset();
  bcryptCompare.mockResolvedValue(false);
  withTransaction.mockImplementation(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
    handler({ query: transactionQuery })
  );
});

describe("credential verification", () => {
  it("performs the same bcrypt work for an unknown account", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(verifyAdmin("unknown@example.test", "candidate-password"))
      .resolves.toBeNull();

    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    expect(bcryptCompare).toHaveBeenCalledWith(
      "candidate-password",
      expect.stringMatching(/^\$2[aby]\$12\$/)
    );
  });
});

describe("initial owner setup", () => {
  it("finishes password hashing before opening the setup transaction", async () => {
    let resolveHash: ((value: string) => void) | undefined;
    bcryptHash.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveHash = resolve;
    }));
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: null,
        username: "owner",
        email: "owner@local.composebastion",
        role: "owner",
        is_active: true,
        created_at: new Date(0)
      }] });

    const creating = createAdmin({
      username: "owner",
      password: "Very-Secure-Pass1"
    });
    await vi.waitFor(() => expect(bcryptHash).toHaveBeenCalledTimes(1));
    expect(withTransaction).not.toHaveBeenCalled();

    resolveHash?.("password-hash");
    await expect(creating).resolves.toMatchObject({ role: "owner" });
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it("serializes the count and insert under the owner invariant lock", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: null,
        username: "owner",
        email: "owner@local.composebastion",
        role: "owner",
        is_active: true,
        created_at: new Date(0)
      }] });

    const owner = await createAdmin({ username: "owner", password: "Very-Secure-Pass1" });

    expect(owner.role).toBe("owner");
    expect(transactionQuery.mock.calls[0]?.[0]).toBe("SELECT pg_advisory_xact_lock($1)");
    expect(transactionQuery.mock.calls[1]?.[0]).toContain("count(*)");
    expect(transactionQuery.mock.calls[2]?.[0]).toContain("INSERT INTO admin_users");
  });

  it("returns a conflict after a concurrent setup has already committed", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    await expect(createAdmin({ username: "owner", password: "Very-Secure-Pass1" })).rejects.toMatchObject({
      message: "Initial admin already exists",
      statusCode: 409
    });
    expect(transactionQuery).toHaveBeenCalledTimes(2);
  });
});

describe("session cleanup", () => {
  it("deletes expired sessions", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await deleteExpiredSessions();

    expect(query).toHaveBeenCalledWith("DELETE FROM sessions WHERE expires_at < now()");
  });
});

describe("session metadata", () => {
  it("couples session creation, last-login, and audit callback in one transaction", async () => {
    transactionQuery.mockResolvedValue({ rows: [] });
    const auditFailure = new Error("audit insert failed");
    const onCreated = vi.fn(async (client: { query: typeof transactionQuery }) => {
      expect(client.query).toBe(transactionQuery);
      throw auditFailure;
    });

    await expect(createLoginSession(
      "00000000-0000-4000-8000-000000000001",
      { ipAddress: "203.0.113.10", userAgent: "Test Agent" },
      onCreated
    )).rejects.toBe(auditFailure);

    expect(transactionQuery.mock.calls[0]?.[0]).toContain("INSERT INTO sessions");
    expect(transactionQuery.mock.calls[1]?.[0]).toContain("last_login_at");
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ query: transactionQuery })
    );
  });

  it("stores metadata when creating a session", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const session = await createSession("00000000-0000-4000-8000-000000000001", {
      ipAddress: "203.0.113.10",
      userAgent: "Mozilla/5.0"
    });

    expect(session.token).toBeTruthy();
    expect(query.mock.calls[0]?.[0]).toContain("ip_address, user_agent, last_seen_at");
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      "00000000-0000-4000-8000-000000000001",
      hashToken(session.token),
      expect.any(Date),
      "203.0.113.10",
      "Mozilla/5.0"
    ]);
  });

  it("bumps last_seen_at after a successful read using the throttled update", async () => {
    const token = "session-token";
    query
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          name: "Admin User",
          username: "admin",
          email: "admin@composebastion.local",
          role: "owner",
          is_active: true,
          last_login_at: null,
          created_at: new Date(0)
        }]
      })
      .mockResolvedValueOnce({ rows: [] });

    const user = await readSession({ cookies: { cb_session: token } } as unknown as FastifyRequest);

    expect(user?.email).toBe("admin@composebastion.local");
    expect(query.mock.calls[1]?.[0]).toContain("last_seen_at < now() - interval '60 seconds'");
    expect(query.mock.calls[1]?.[1]).toEqual([hashToken(token)]);
  });

  it("can reauthorize a long-lived connection without amplifying last-seen writes", async () => {
    const token = "session-token";
    query.mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "Admin User",
        username: "admin",
        email: "admin@composebastion.local",
        role: "admin",
        is_active: true,
        last_login_at: null,
        created_at: new Date(0)
      }]
    });

    const user = await readSession(
      { cookies: { cb_session: token } } as unknown as FastifyRequest,
      { touch: false }
    );

    expect(user?.role).toBe("admin");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("sessions.expires_at > now()");
  });

  it("lists only safe session fields and marks the current session", async () => {
    const createdAt = new Date("2026-06-16T10:00:00.000Z");
    const lastSeenAt = new Date("2026-06-16T10:05:00.000Z");
    const expiresAt = new Date("2026-06-23T10:00:00.000Z");
    query.mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-4000-8000-000000000010",
        ip_address: "203.0.113.10",
        user_agent: "Mozilla/5.0",
        created_at: createdAt,
        last_seen_at: lastSeenAt,
        expires_at: expiresAt,
        current: true,
        token_hash: "must-not-leak"
      }]
    });

    const sessions = await listSessionsForUser("00000000-0000-4000-8000-000000000001", "current-hash");

    expect(query.mock.calls[0]?.[1]).toEqual(["00000000-0000-4000-8000-000000000001", "current-hash"]);
    expect(sessions).toEqual([{
      id: "00000000-0000-4000-8000-000000000010",
      ipAddress: "203.0.113.10",
      userAgent: "Mozilla/5.0",
      createdAt: createdAt.toISOString(),
      lastSeenAt: lastSeenAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      current: true
    }]);
    expect(JSON.stringify(sessions)).not.toContain("must-not-leak");
  });

  it("revokes sessions only within the user's scope and reports current-session revocation", async () => {
    transactionQuery.mockResolvedValueOnce({ rows: [{ token_hash: "current-hash" }] });

    await expect(revokeSessionForUser("00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000001", "current-hash")).resolves.toEqual({
      revoked: true,
      wasCurrent: true
    });
    expect(transactionQuery).toHaveBeenCalledWith(
      "DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash",
      ["00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000001"]
    );

    transactionQuery.mockResolvedValueOnce({ rows: [] });
    await expect(revokeSessionForUser("00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000001", "current-hash")).resolves.toEqual({
      revoked: false,
      wasCurrent: false
    });
  });
});
