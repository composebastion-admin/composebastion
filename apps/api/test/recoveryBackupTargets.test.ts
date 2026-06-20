import { describe, expect, it } from "vitest";
import { backupTargetCreateSchema } from "@dockermender/shared";
import {
  assertBackupTargetS3EndpointAllowed,
  mapBackupTargetFields,
  normalizeBackupTargetCreate
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
      remoteName: "dockermender",
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
      remotePath: "Dockermender",
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
    expect(mapped.remotePath).toBe("Dockermender");
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
