import { describe, expect, it } from "vitest";
import { backupTargetCreateSchema } from "@composebastion/shared";
import {
  assertBackupTargetS3EndpointAllowed,
  exportBackupTargetSecrets,
  mapBackupTargetFields,
  normalizeBackupTargetCreate,
  normalizeBackupTargetUpdate,
  toWorkerBackupTarget
} from "../src/services/recoveryBackupTargets.js";
import { decryptSecret } from "../src/services/crypto.js";

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
