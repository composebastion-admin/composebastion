import { describe, expect, it } from "vitest";
import { backupTargetCreateSchema, backupTargetUpdateSchema } from "@composebastion/shared";
import {
  assertBackupTargetS3EndpointAllowed,
  exportBackupTargetSecrets,
  mapBackupTargetFields,
  normalizeBackupTargetCreate,
  normalizeBackupTargetUpdate,
  toWorkerBackupTarget
} from "../src/services/recoveryBackupTargets.js";
import { decryptSecret, encryptSecret } from "../src/services/crypto.js";

describe("recovery backup targets", () => {
  it("encrypts S3 secret access keys at rest", () => {
    const row = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "Offsite",
      type: "s3",
      endpoint: "https://s3.example.com",
      bucket: "recovery",
      region: "us-east-1",
      prefix: "apps",
      accessKeyId: "AKIA123",
      secretAccessKey: "plain-secret-key",
      enabled: true
    }));

    expect(row.kind).toBe("s3");
    expect(row.accessKeyId).toBe("AKIA123");
    expect(row.secretAccessKeyEncrypted).toBeTruthy();
    expect(row.secretAccessKeyEncrypted).not.toBe("plain-secret-key");
    expect(decryptSecret(row.secretAccessKeyEncrypted!)).toBe("plain-secret-key");
  });

  it("maps API responses without exposing encrypted secrets", () => {
    const encrypted = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "Offsite",
      type: "s3",
      endpoint: "https://s3.example.com",
      bucket: "recovery",
      accessKeyId: "AKIA123",
      secretAccessKey: "plain-secret-key",
      enabled: true
    }));

    const mapped = mapBackupTargetFields({
      id: "00000000-0000-4000-8000-000000000001",
      name: encrypted.name,
      kind: encrypted.kind,
      enabled: encrypted.enabled,
      config: encrypted.config,
      access_key_id: encrypted.accessKeyId,
      secret_access_key_encrypted: encrypted.secretAccessKeyEncrypted,
      created_at: new Date("2026-06-15T12:00:00.000Z"),
      updated_at: new Date("2026-06-15T12:00:00.000Z")
    });

    expect(mapped.type).toBe("s3");
    expect(mapped.endpoint).toBe("https://s3.example.com");
    expect(mapped.bucket).toBe("recovery");
    expect(mapped.hasSecretAccessKey).toBe(true);
    expect(mapped).not.toHaveProperty("secretAccessKey");
    expect(mapped).not.toHaveProperty("secret_access_key_encrypted");
  });

  it("redacts an unsafe legacy S3 endpoint before returning a viewer-readable target", () => {
    const mapped = mapBackupTargetFields({
      id: "00000000-0000-4000-8000-000000000009",
      name: "Legacy offsite",
      kind: "s3",
      enabled: true,
      config: {
        endpoint: "https://legacy-user:legacy-password@s3.example.com?token=private#fragment",
        bucket: "recovery"
      },
      access_key_id: "AKIA123",
      secret_access_key_encrypted: "ciphertext",
      created_at: new Date("2026-06-15T12:00:00.000Z"),
      updated_at: new Date("2026-06-15T12:00:00.000Z")
    });

    expect(mapped.endpoint).toBeNull();
    expect(mapped.config.endpoint).toBeNull();
    expect(JSON.stringify(mapped)).not.toContain("legacy-password");
    expect(JSON.stringify(mapped)).not.toContain("token=private");
  });

  it("sanitizes provider health diagnostics before returning target state", () => {
    const mapped = mapBackupTargetFields({
      id: "00000000-0000-4000-8000-000000000010",
      name: "Offsite",
      kind: "s3",
      enabled: true,
      config: {
        endpoint: "https://s3.example.com",
        bucket: "recovery"
      },
      access_key_id: "AKIA123",
      secret_access_key_encrypted: "ciphertext",
      health_status: "failed",
      health_error: "request failed https://worker:health-password@s3.example.com/archive?token=health-token#detail",
      created_at: new Date("2026-06-15T12:00:00.000Z"),
      updated_at: new Date("2026-06-15T12:00:00.000Z")
    });

    expect(mapped.healthError).toBe("request failed https://s3.example.com/archive");
    expect(JSON.stringify(mapped)).not.toContain("health-password");
    expect(JSON.stringify(mapped)).not.toContain("health-token");
  });

  it("canonicalizes legacy local targets to the manager backup directory contract", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000019",
      name: "Legacy local",
      kind: "local",
      enabled: true,
      config: { basePath: "/legacy/custom/path" },
      local_cache_policy: "remote_only",
      created_at: new Date("2026-06-15T12:00:00.000Z"),
      updated_at: new Date("2026-06-15T12:00:00.000Z")
    };

    const mapped = mapBackupTargetFields(row);
    expect(mapped.config).toEqual({});
    expect(mapped.basePath).toBeNull();
    expect(mapped.localCachePolicy).toBe("keep");
    expect(toWorkerBackupTarget(row)).toMatchObject({ config: {}, localCachePolicy: "keep" });
    expect(exportBackupTargetSecrets(row)).toMatchObject({ config: {}, localCachePolicy: "keep" });

    let updateError: unknown;
    try {
      normalizeBackupTargetUpdate(row, { localCachePolicy: "remote_only" });
    } catch (error) {
      updateError = error;
    }
    expect(updateError).toMatchObject({ statusCode: 400 });
    expect(normalizeBackupTargetUpdate(row, { name: "Canonical local" })).toMatchObject({
      config: {},
      localCachePolicy: "keep"
    });
  });

  it("normalizes SMB rclone targets without storing plaintext passwords in config", () => {
    const row = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "NAS",
      type: "rclone",
      provider: "smb",
      server: "nas.local",
      share: "Backups",
      subPath: "docker",
      remotePath: "must-not-override-share",
      domain: "WORKGROUP",
      username: "backup",
      password: "plain-password",
      port: 445,
      localCachePolicy: "remote_only",
      enabled: true
    }));

    expect(row.kind).toBe("rclone");
    expect(row.provider).toBe("smb");
    expect(row.remotePath).toBe("Backups/docker");
    expect(row.localCachePolicy).toBe("remote_only");
    expect(row.config).toMatchObject({
      provider: "smb",
      remoteName: "composebastion",
      remotePath: "Backups/docker",
      smb: {
        server: "nas.local",
        share: "Backups",
        subPath: "docker",
        domain: "WORKGROUP",
        username: "backup",
        port: 445
      }
    });
    expect(JSON.stringify(row.config)).not.toContain("plain-password");
    expect(JSON.parse(decryptSecret(row.genericCredentialsEncrypted!))).toEqual({ password: "plain-password" });
  });

  it("uses rclone's supported remote-name characters for SMB and imported configs", () => {
    const supportedName = "Team NAS 2+ops@example.com";
    const smb = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "NAS",
      type: "rclone",
      provider: "smb",
      remoteName: supportedName,
      server: "nas.internal",
      share: "Backups"
    }));
    expect(smb.config.remoteName).toBe(supportedName);

    const unicodeName = "Café.東京";
    const imported = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "Imported Drive",
      type: "rclone",
      provider: "drive",
      rcloneConfig: `[${unicodeName}]\ntype = drive\n`
    }));
    expect(imported.config.remoteName).toBe(unicodeName);

    for (const unsupportedName of ["archive#prod", "archive;prod"]) {
      expect(() => normalizeBackupTargetCreate({
        name: "Unsafe NAS",
        type: "rclone",
        provider: "smb",
        remoteName: unsupportedName,
        server: "nas.internal",
        share: "Backups",
        enabled: true,
        localCachePolicy: "keep"
      } as any)).toThrow("Rclone remote name");
      expect(() => normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
        name: "Unsafe imported config",
        type: "rclone",
        provider: "drive",
        rcloneConfig: `[${unsupportedName}]\ntype = drive\n`
      }))).toThrow("Rclone remote name");
    }
  });

  it("enforces SMB confinement when create and update normalization are called directly", () => {
    const create = {
      name: "NAS",
      type: "rclone",
      provider: "smb",
      remoteName: "nas",
      server: "nas.internal",
      share: "Backups",
      subPath: "docker",
      enabled: true,
      localCachePolicy: "remote_only"
    };
    for (const remoteName of [":local", "nas#prod", "nas;prod"]) {
      expect(() => normalizeBackupTargetCreate({
        ...create,
        remoteName
      } as any)).toThrow("Rclone remote name");
    }
    expect(() => normalizeBackupTargetCreate({
      ...create,
      share: "../../../../tmp"
    } as any)).toThrow("SMB share");
    expect(() => normalizeBackupTargetCreate({
      ...create,
      subPath: "../escape"
    } as any)).toThrow("SMB subpath");
    expect(normalizeBackupTargetCreate({
      ...create,
      rcloneConfig: "[nas]\ntype = local\n"
    } as any).genericConfigEncrypted).toBeNull();
    expect(() => normalizeBackupTargetCreate({
      ...create,
      config: {
        provider: "drive",
        rcloneConfig: "[drive]\ntype = drive\n"
      }
    } as any)).toThrow("must match config.provider");

    const current = {
      kind: "rclone",
      provider: "smb",
      remote_path: "Backups/docker",
      config: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        smb: {
          server: "nas.internal",
          share: "Backups",
          subPath: "docker"
        }
      },
      generic_config_encrypted: null,
      generic_credentials_encrypted: null
    };
    for (const remoteName of [":local", "nas#prod", "nas;prod"]) {
      expect(() => normalizeBackupTargetUpdate(current, { remoteName } as any))
        .toThrow("Rclone remote name");
    }
    expect(() => normalizeBackupTargetUpdate(current, { share: "../../../../tmp" } as any))
      .toThrow("SMB share");
    expect(() => normalizeBackupTargetUpdate(current, { subPath: "../escape" } as any))
      .toThrow("SMB subpath");
    expect(normalizeBackupTargetUpdate(current, {
      rcloneConfig: "[nas]\ntype = local\n"
    } as any).genericConfigEncrypted).toBeNull();
    expect(() => normalizeBackupTargetUpdate(current, {
      provider: "smb",
      config: {
        provider: "drive",
        rcloneConfig: "[drive]\ntype = drive\n"
      }
    } as any)).toThrow("must match config.provider");
  });

  it("fails closed when legacy persisted SMB targets violate confinement", () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000020",
      name: "NAS",
      kind: "rclone",
      enabled: true,
      config: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        smb: {
          server: "nas.internal",
          share: "Backups",
          subPath: "docker"
        }
      },
      provider: "smb",
      remote_path: "Backups/docker",
      local_cache_policy: "remote_only",
      generic_config_encrypted: null,
      generic_credentials_encrypted: null
    };

    expect(toWorkerBackupTarget(row)).toMatchObject({
      rclone: {
        provider: "smb",
        remoteName: "nas",
        remotePath: "Backups/docker",
        configText: null
      }
    });
    expect(() => toWorkerBackupTarget({
      ...row,
      config: { ...row.config, remoteName: ":local" }
    })).toThrow("Rclone remote name");
    expect(() => toWorkerBackupTarget({
      ...row,
      config: { ...row.config, remoteName: "nas#prod" }
    })).toThrow("Rclone remote name");
    expect(() => toWorkerBackupTarget({
      ...row,
      config: { ...row.config, remoteName: "nas;prod" }
    })).toThrow("Rclone remote name");
    expect(() => toWorkerBackupTarget({
      ...row,
      config: { ...row.config, provider: "drive" }
    })).toThrow("does not match config.provider");
    expect(() => toWorkerBackupTarget({
      ...row,
      config: {
        ...row.config,
        remotePath: "../../../../tmp/docker",
        smb: { ...row.config.smb, share: "../../../../tmp" }
      },
      remote_path: "../../../../tmp/docker"
    })).toThrow("SMB share");
    expect(() => toWorkerBackupTarget({
      ...row,
      config: {
        ...row.config,
        remotePath: "Backups/../escape",
        smb: { ...row.config.smb, subPath: "../escape" }
      },
      remote_path: "Backups/../escape"
    })).toThrow("SMB subpath");
    expect(() => toWorkerBackupTarget({
      ...row,
      remote_path: "../../../../tmp"
    })).toThrow("SMB target");
    expect(() => toWorkerBackupTarget({
      ...row,
      generic_config_encrypted: encryptSecret("[nas]\ntype = local\n")
    })).toThrow("do not accept imported rclone config");
  });

  it("recomputes SMB remote paths and explicitly clears optional settings", () => {
    const normalized = normalizeBackupTargetUpdate({
      kind: "rclone",
      provider: "smb",
      remote_path: "stale-hidden-path",
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "stale-hidden-path",
        smb: {
          server: "nas.internal",
          share: "old-share",
          subPath: "old-subpath",
          domain: "OLD",
          username: "old-user",
          port: 445
        }
      },
      generic_config_encrypted: encryptSecret("[legacy]\ntype = drive\n"),
      generic_credentials_encrypted: encryptSecret(JSON.stringify({ password: "old-password" }))
    }, {
      share: "new-share",
      subPath: null,
      domain: null,
      username: null,
      port: null,
      password: null,
      // A stale or malicious independent path must never override share/subPath.
      remotePath: "stale-hidden-path"
    });

    expect(normalized).toMatchObject({
      provider: "smb",
      remotePath: "new-share",
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "new-share",
        smb: {
          server: "nas.internal",
          share: "new-share",
          subPath: null,
          domain: null,
          username: null,
          port: null
        }
      },
      genericConfigEncrypted: null,
      genericCredentialsEncrypted: null
    });
  });

  it("retains omitted SMB settings and credentials on unrelated patches", () => {
    const created = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "NAS",
      type: "rclone",
      provider: "smb",
      server: "nas.internal",
      share: "backups",
      password: "saved-password",
      enabled: true
    }));
    const normalized = normalizeBackupTargetUpdate({
      kind: created.kind,
      provider: created.provider,
      remote_path: created.remotePath,
      config: created.config,
      generic_config_encrypted: created.genericConfigEncrypted,
      generic_credentials_encrypted: created.genericCredentialsEncrypted
    }, { name: "Renamed NAS" });

    expect(normalized.config).toEqual(created.config);
    expect(normalized.remotePath).toBe(created.remotePath);
    expect(normalized.genericCredentialsEncrypted).toBe(created.genericCredentialsEncrypted);
  });

  it("rebuilds imported-to-SMB transitions without retaining imported config or credentials", () => {
    const normalized = normalizeBackupTargetUpdate({
      kind: "rclone",
      provider: "drive",
      remote_path: "old-drive-root",
      config: {
        provider: "drive",
        remoteName: "gdrive",
        remotePath: "old-drive-root",
        smb: { server: "stale.internal", share: "stale-share" }
      },
      generic_config_encrypted: encryptSecret("[gdrive]\ntype = drive\ntoken = stale\n"),
      generic_credentials_encrypted: encryptSecret(JSON.stringify({ password: "stale-password" }))
    }, backupTargetUpdateSchema.parse({
      provider: "smb",
      server: "nas.internal",
      share: "backups",
      subPath: "composebastion",
      password: "fresh-password",
      remotePath: "must-not-win"
    }));

    expect(normalized.provider).toBe("smb");
    expect(normalized.remotePath).toBe("backups/composebastion");
    expect(normalized.config).toEqual({
      provider: "smb",
      remoteName: "composebastion",
      remotePath: "backups/composebastion",
      smb: {
        server: "nas.internal",
        share: "backups",
        subPath: "composebastion"
      }
    });
    expect(normalized.genericConfigEncrypted).toBeNull();
    expect(JSON.parse(decryptSecret(normalized.genericCredentialsEncrypted!)))
      .toEqual({ password: "fresh-password" });
    expect(JSON.stringify(normalized)).not.toContain("stale");
  });

  it("requires a fresh imported config for SMB-to-imported transitions and purges SMB secrets", () => {
    const current = {
      kind: "rclone",
      provider: "smb",
      remote_path: "backups/composebastion",
      config: {
        provider: "smb",
        remoteName: "composebastion",
        remotePath: "backups/composebastion",
        smb: {
          server: "nas.internal",
          share: "backups",
          subPath: "composebastion",
          domain: "ACME",
          username: "backup-user",
          port: 445
        }
      },
      generic_config_encrypted: null,
      generic_credentials_encrypted: encryptSecret(JSON.stringify({ password: "smb-password" }))
    };

    expect(() => normalizeBackupTargetUpdate(
      current,
      backupTargetUpdateSchema.parse({ provider: "drive" })
    )).toThrow("new imported rclone config");

    const normalized = normalizeBackupTargetUpdate(current, backupTargetUpdateSchema.parse({
      provider: "drive",
      rcloneConfig: "[fresh-drive]\ntype = drive\ntoken = fresh\n",
      remotePath: "new-root"
    }));
    expect(normalized).toMatchObject({
      provider: "drive",
      remotePath: "new-root",
      config: {
        provider: "drive",
        remoteName: "fresh-drive",
        remotePath: "new-root"
      },
      genericCredentialsEncrypted: null
    });
    expect(normalized.config).not.toHaveProperty("smb");
    expect(decryptSecret(normalized.genericConfigEncrypted!))
      .toBe("[fresh-drive]\ntype = drive\ntoken = fresh\n");
    expect(JSON.stringify(normalized)).not.toContain("smb-password");
    expect(JSON.stringify(normalized)).not.toContain("backup-user");
  });

  it("clears nullable S3 region and prefix while omitted fields retain patch semantics", () => {
    const current = {
      kind: "s3",
      config: {
        endpoint: "https://s3.example.test",
        bucket: "recovery",
        region: "eu-west-1",
        prefix: "client"
      }
    };
    expect(normalizeBackupTargetUpdate(current, { region: null, prefix: null }).config)
      .toMatchObject({ region: null, prefix: null });
    expect(normalizeBackupTargetUpdate(current, { name: "Renamed" }).config)
      .toMatchObject({ region: "eu-west-1", prefix: "client" });
  });

  it("rejects provider-incompatible S3 patches and never returns legacy config secrets", () => {
    const canary = "PLAINTEXT-PROVIDER-SECRET";
    const current = {
      kind: "s3",
      config: {
        endpoint: "https://s3.example.test",
        bucket: "recovery",
        provider: "custom",
        remotePath: "hidden",
        rcloneConfig: `[remote]\ntoken = ${canary}`,
        smb: { password: canary }
      }
    };

    expect(() => normalizeBackupTargetUpdate(current, backupTargetUpdateSchema.parse({
      config: {
        provider: "custom",
        remotePath: "hidden",
        rcloneConfig: `[remote]\ntoken = ${canary}`
      }
    }))).toThrow("config.provider is not valid for s3 backup targets");

    const mapped = mapBackupTargetFields({
      id: "00000000-0000-4000-8000-000000000011",
      name: "Legacy contaminated target",
      kind: "s3",
      enabled: true,
      config: current.config,
      access_key_id: "ACCESS",
      secret_access_key_encrypted: "ciphertext",
      created_at: new Date("2026-06-15T12:00:00.000Z"),
      updated_at: new Date("2026-06-15T12:00:00.000Z")
    });
    expect(mapped.config).toEqual({
      endpoint: "https://s3.example.test",
      bucket: "recovery"
    });
    expect(JSON.stringify(mapped)).not.toContain(canary);
    expect(JSON.stringify(mapped)).not.toContain("rcloneConfig");
    expect(JSON.stringify(mapped)).not.toContain("password");
  });

  it("maps rclone targets with redacted config and health metadata", () => {
    const encrypted = normalizeBackupTargetCreate(backupTargetCreateSchema.parse({
      name: "Drive",
      type: "rclone",
      provider: "drive",
      rcloneConfig: "[gdrive]\ntype = drive\n",
      remotePath: "ComposeBastion",
      localCachePolicy: "keep",
      enabled: true
    }));

    const mapped = mapBackupTargetFields({
      id: "00000000-0000-4000-8000-000000000002",
      name: encrypted.name,
      kind: encrypted.kind,
      enabled: encrypted.enabled,
      config: encrypted.config,
      provider: encrypted.provider,
      remote_path: encrypted.remotePath,
      local_cache_policy: encrypted.localCachePolicy,
      generic_config_encrypted: encrypted.genericConfigEncrypted,
      generic_credentials_encrypted: encrypted.genericCredentialsEncrypted,
      health_status: "healthy",
      health_checked_at: new Date("2026-06-15T12:00:00.000Z"),
      health_error: null,
      created_at: new Date("2026-06-15T12:00:00.000Z"),
      updated_at: new Date("2026-06-15T12:00:00.000Z")
    });

    expect(mapped.kind).toBe("rclone");
    expect(mapped.rcloneProvider).toBe("drive");
    expect(mapped.remoteName).toBe("gdrive");
    expect(mapped.remotePath).toBe("ComposeBastion");
    expect(mapped.healthStatus).toBe("healthy");
    expect(mapped.hasGenericConfig).toBe(true);
    expect(mapped).not.toHaveProperty("rcloneConfig");
  });

  it("blocks private S3 endpoints only when the opt-in guard is enabled", async () => {
    const target = {
      kind: "s3",
      config: { endpoint: "http://minio.internal:9000", bucket: "recovery" }
    };
    const resolve = async () => [{ address: "169.254.169.254", family: 4 }];

    await expect(assertBackupTargetS3EndpointAllowed(target, false, resolve)).resolves.toBeUndefined();
    await expect(assertBackupTargetS3EndpointAllowed(target, true, resolve)).rejects.toThrow("private network address");
  });
});
