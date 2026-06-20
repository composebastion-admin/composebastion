import { CONFIG_BACKUP_FORMAT_VERSION } from "@dockermender/shared";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptConfigPayload, encryptConfigPayload } from "../src/services/crypto.js";
import { exportConfigBackup, importConfigBackup } from "../src/services/configBackup.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };
const query = vi.fn();
const withTransaction = vi.fn();
const transactionQuery = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

function emptyConfigPayload(app: string) {
  return {
    app,
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    version: "0.9.0",
    exportedAt: "2026-06-15T00:00:00.000Z",
    hosts: [],
    composeStacks: [],
    registries: [],
    notificationChannels: [],
    alertRules: [],
    favoriteImages: [],
    githubRepositories: [],
    appSourceLinks: [],
    backupTargets: []
  };
}

describe("config backup product identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
    withTransaction.mockImplementation(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
      handler({ query: transactionQuery })
    );
  });

  it("exports new config backups as Dockermender", async () => {
    const encrypted = await exportConfigBackup("long-test-passphrase");
    const payload = decryptConfigPayload<{ app: string; version: string }>(encrypted, "long-test-passphrase");

    expect(payload.app).toBe("Dockermender");
    expect(payload.version).toBe(packageJson.version);
  });

  it("rejects config backups from other apps", async () => {
    const encrypted = encryptConfigPayload(emptyConfigPayload("OtherApp"), "long-test-passphrase");

    await expect(importConfigBackup(encrypted as unknown as Record<string, unknown>, "long-test-passphrase"))
      .rejects.toThrow("This is not a Dockermender config backup");
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
