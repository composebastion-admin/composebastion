import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

const query = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

const {
  createSession,
  deleteExpiredSessions,
  hashToken,
  listSessionsForUser,
  readSession,
  revokeSessionForUser
} = await import("../src/services/auth.js");

beforeEach(() => {
  query.mockReset();
});

describe("session cleanup", () => {
  it("deletes expired sessions", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await deleteExpiredSessions();

    expect(query).toHaveBeenCalledWith("DELETE FROM sessions WHERE expires_at < now()");
  });
});

describe("session metadata", () => {
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
          email: "admin@dockermender.local",
          role: "owner",
          is_active: true,
          last_login_at: null,
          created_at: new Date(0)
        }]
      })
      .mockResolvedValueOnce({ rows: [] });

    const user = await readSession({ cookies: { dm_session: token } } as unknown as FastifyRequest);

    expect(user?.email).toBe("admin@dockermender.local");
    expect(query.mock.calls[1]?.[0]).toContain("last_seen_at < now() - interval '60 seconds'");
    expect(query.mock.calls[1]?.[1]).toEqual([hashToken(token)]);
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
    query.mockResolvedValueOnce({ rows: [{ token_hash: "current-hash" }] });

    await expect(revokeSessionForUser("00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000001", "current-hash")).resolves.toEqual({
      revoked: true,
      wasCurrent: true
    });
    expect(query).toHaveBeenCalledWith(
      "DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash",
      ["00000000-0000-4000-8000-000000000010", "00000000-0000-4000-8000-000000000001"]
    );

    query.mockResolvedValueOnce({ rows: [] });
    await expect(revokeSessionForUser("00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000001", "current-hash")).resolves.toEqual({
      revoked: false,
      wasCurrent: false
    });
  });
});
