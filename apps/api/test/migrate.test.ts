import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "../src/db/migrate.js";

type FakeRunnerOptions = {
  bootstrapError?: Error;
  lockError?: Error;
  unlockError?: Error;
};

function makeFakeRunner(options: FakeRunnerOptions = {}) {
  const events: string[] = [];
  const query = vi.fn(async (sql: string) => {
    const normalized = sql.replaceAll(/\s+/g, " ").trim();
    events.push(normalized);

    if (normalized.startsWith("SELECT pg_advisory_lock") && options.lockError) {
      throw options.lockError;
    }
    if (normalized.startsWith("CREATE TABLE") && options.bootstrapError) {
      throw options.bootstrapError;
    }
    if (normalized.startsWith("SELECT pg_advisory_unlock")) {
      if (options.unlockError) throw options.unlockError;
      return { rowCount: 1, rows: [{ unlocked: true }] };
    }
    if (normalized.startsWith("SELECT 1 FROM schema_migrations")) {
      return { rowCount: 1, rows: [{ "?column?": 1 }] };
    }
    return { rowCount: 0, rows: [] };
  });
  const release = vi.fn((error?: Error | boolean) => {
    events.push(error ? "release:error" : "release");
  });
  const client = { query, release };
  const connect = vi.fn(async () => client);
  const connectionPool = { connect } as unknown as Pick<Pool, "connect">;

  return { client, connect, connectionPool, events, release };
}

describe("runMigrations", () => {
  it("holds one session lock from before ledger bootstrap until the checked-out client is released", async () => {
    const runner = makeFakeRunner();

    await runMigrations(runner.connectionPool);

    expect(runner.connect).toHaveBeenCalledTimes(1);
    expect(runner.events[0]).toBe("SELECT pg_advisory_lock($1::bigint)");
    expect(runner.events[1]).toContain("CREATE TABLE IF NOT EXISTS schema_migrations");
    expect(runner.events).not.toContain(expect.stringContaining("pg_advisory_xact_lock"));
    expect(runner.events.at(-2)).toBe("SELECT pg_advisory_unlock($1::bigint) AS unlocked");
    expect(runner.events.at(-1)).toBe("release");
    expect(runner.release).toHaveBeenCalledWith();
  });

  it("unlocks and releases the checked-out client when ledger bootstrap fails", async () => {
    const bootstrapError = new Error("bootstrap failed");
    const runner = makeFakeRunner({ bootstrapError });

    await expect(runMigrations(runner.connectionPool)).rejects.toBe(bootstrapError);

    expect(runner.events).toEqual([
      "SELECT pg_advisory_lock($1::bigint)",
      expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"),
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      "release"
    ]);
  });

  it("destroys the client when lock acquisition has an indeterminate outcome", async () => {
    const lockError = new Error("connection interrupted during lock acquisition");
    const runner = makeFakeRunner({ lockError });

    await expect(runMigrations(runner.connectionPool)).rejects.toBe(lockError);

    expect(runner.events).toEqual([
      "SELECT pg_advisory_lock($1::bigint)",
      "release:error"
    ]);
    expect(runner.release).toHaveBeenCalledWith(lockError);
  });

  it("destroys the checked-out client when the session lock cannot be released", async () => {
    const unlockError = new Error("unlock failed");
    const runner = makeFakeRunner({ unlockError });

    await expect(runMigrations(runner.connectionPool)).rejects.toBe(unlockError);

    expect(runner.release).toHaveBeenCalledWith(unlockError);
    expect(runner.events.at(-1)).toBe("release:error");
  });
});
