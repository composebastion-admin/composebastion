import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_CREATE_LOCK_ID,
  lockHostIdentityScope
} from "../src/services/hostIdentity.js";

describe("demo host identity serialization", () => {
  it("uses the canonical host identity advisory transaction lock", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await lockHostIdentityScope({
      query
    } as unknown as Pick<PoolClient, "query">);

    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock($1::bigint)",
      [HOST_CREATE_LOCK_ID]
    );
  });

  it("takes the shared lock before every demo host identity read or write", async () => {
    const source = await readFile(
      new URL("../src/services/demo.ts", import.meta.url),
      "utf8"
    );
    const seedStart = source.indexOf("export async function seedDemoWorkspace");
    const seedEnd = source.indexOf(
      "\nexport async function demoInventorySummary",
      seedStart
    );
    const seedSource = source.slice(seedStart, seedEnd);
    const lockIndex = seedSource.indexOf("await lockHostIdentityScope(client)");
    const identityOperations = [
      "const staleHosts = await client.query",
      "const candidates = await client.query",
      "const conflicting = await client.query",
      "`UPDATE docker_hosts",
      "`INSERT INTO docker_hosts"
    ];

    expect(seedStart).toBeGreaterThanOrEqual(0);
    expect(seedEnd).toBeGreaterThan(seedStart);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    for (const operation of identityOperations) {
      expect(seedSource.indexOf(operation)).toBeGreaterThan(lockIndex);
    }
    expect(seedSource).toContain("lower(btrim(hostname))");
    expect(seedSource).toContain("lower(btrim(name))");
    expect(seedSource).toContain("WHERE $2 = ANY(tags)");
    expect(seedSource.indexOf("const conflicting = await client.query"))
      .toBeLessThan(seedSource.indexOf("`UPDATE docker_hosts"));
  });

  it("routes production, import, and demo identity writers through the same lock helper", async () => {
    const [hostsSource, configSource, demoSource] = await Promise.all([
      readFile(new URL("../src/services/hosts.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/services/configBackup.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/services/demo.ts", import.meta.url), "utf8")
    ]);

    expect(hostsSource.match(/await lockHostIdentityScope\(client\)/g)).toHaveLength(3);
    expect(configSource.match(/await lockHostIdentityScope\(client\)/g)).toHaveLength(1);
    expect(demoSource.match(/await lockHostIdentityScope\(client\)/g)).toHaveLength(1);
  });

  it("seeds the demo SMB target in the canonical confined worker shape", async () => {
    const source = await readFile(
      new URL("../src/services/demo.ts", import.meta.url),
      "utf8"
    );
    const smbStart = source.indexOf('key: "smb"');
    const smbEnd = source.indexOf('key: "s3"', smbStart);
    const smbSource = source.slice(smbStart, smbEnd);

    expect(smbStart).toBeGreaterThanOrEqual(0);
    expect(smbEnd).toBeGreaterThan(smbStart);
    expect(smbSource).toContain('remoteName: "demo-smb"');
    expect(smbSource.match(/remotePath: "composebastion\/showcase"/g)).toHaveLength(2);
    expect(smbSource).toContain('share: "composebastion"');
    expect(smbSource).toContain('subPath: "showcase"');
    expect(smbSource).toContain('username: "demo"');
    expect(smbSource).toContain("genericConfig: null");
    expect(smbSource).toContain('encryptSecret(JSON.stringify({ password: "demo" }))');
    expect(smbSource).not.toContain("demo-smb:composebastion/showcase");
    expect(smbSource).not.toContain("type = smb");
  });
});
