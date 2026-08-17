import { describe, expect, it } from "vitest";
import {
  buildBackupTargetPayload,
  formFromTarget,
  formWithRcloneProvider,
  rcloneProviderOptions
} from "./StorageTargetsPanel.js";

describe("rclone provider labels", () => {
  it("keeps SMB stable and marks imported rclone providers experimental", () => {
    const smb = rcloneProviderOptions.find((option) => option.value === "smb");
    const experimental = rcloneProviderOptions.filter((option) => option.value !== "smb");

    expect(smb).toMatchObject({ label: "SMB / CIFS", experimental: false });
    expect(experimental).not.toHaveLength(0);
    expect(experimental.every((option) => option.experimental)).toBe(true);
    expect(experimental.every((option) => option.label.includes("experimental"))).toBe(true);
  });

  it("never sends custom-path or remote-only fields for a local target", () => {
    const payload = buildBackupTargetPayload({
      name: "Manager storage",
      type: "local",
      enabled: true,
      localCachePolicy: "remote_only",
      basePath: "/unsupported/custom/path"
    } as never, null);

    expect(payload).toEqual({
      name: "Manager storage",
      type: "local",
      enabled: true
    });
  });

  it("hydrates safe SMB settings and leaves a saved password unchanged when editing", () => {
    const target = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Production NAS",
      type: "rclone",
      kind: "rclone",
      enabled: true,
      localCachePolicy: "remote_only",
      rcloneProvider: "smb",
      remoteName: "composebastion",
      remotePath: "recovery",
      hasGenericCredentials: true,
      config: {
        provider: "smb",
        smb: {
          server: "nas.internal",
          share: "backups",
          subPath: "composebastion",
          domain: "ACME",
          username: "backup-user",
          port: 445
        }
      }
    } as never;

    const form = formFromTarget(target);
    const payload = buildBackupTargetPayload(form, target);

    expect(form.password).toBe("");
    expect(payload).toMatchObject({
      type: "rclone",
      provider: "smb",
      remoteName: "composebastion",
      server: "nas.internal",
      share: "backups",
      subPath: "composebastion",
      domain: "ACME",
      username: "backup-user",
      port: 445
    });
    expect(payload).not.toHaveProperty("remotePath");
    expect(payload).not.toHaveProperty("password");
  });

  it("sends explicit nulls when an operator clears optional S3 and SMB settings", () => {
    const s3Target = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Object storage",
      type: "s3",
      kind: "s3",
      enabled: true,
      localCachePolicy: "keep",
      endpoint: "https://s3.example.test",
      bucket: "recovery",
      region: "eu-west-1",
      prefix: "client",
      forcePathStyle: true,
      accessKeyId: "ACCESS",
      hasSecretAccessKey: true,
      config: {}
    } as never;
    const s3Form = {
      ...formFromTarget(s3Target),
      region: "",
      prefix: ""
    };
    expect(buildBackupTargetPayload(s3Form, s3Target)).toMatchObject({
      region: null,
      prefix: null
    });

    const smbTarget = {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Production NAS",
      type: "rclone",
      kind: "rclone",
      enabled: true,
      localCachePolicy: "keep",
      rcloneProvider: "smb",
      remoteName: "composebastion",
      remotePath: "backups/composebastion",
      hasGenericCredentials: true,
      createdAt: "2026-07-30T12:00:00.000Z",
      updatedAt: "2026-07-30T12:00:00.000Z",
      config: {
        provider: "smb",
        smb: {
          server: "nas.internal",
          share: "backups",
          subPath: "composebastion",
          domain: "ACME",
          username: "backup",
          port: 445
        }
      }
    } as never;
    const smbForm = {
      ...formFromTarget(smbTarget),
      subPath: "",
      domain: "",
      username: "",
      port: "",
      clearPassword: true
    };
    const smbPayload = buildBackupTargetPayload(smbForm, smbTarget);
    expect(smbPayload).toMatchObject({
      subPath: null,
      domain: null,
      username: null,
      port: null,
      password: null
    });
    expect(smbPayload).not.toHaveProperty("remotePath");

  });

  it("clears both saved S3 credential halves and disables the target atomically", () => {
    const target = {
      id: "00000000-0000-4000-8000-000000000008",
      name: "Object storage",
      type: "s3",
      kind: "s3",
      enabled: true,
      localCachePolicy: "keep",
      endpoint: "https://s3.example.test",
      bucket: "recovery",
      region: null,
      prefix: null,
      forcePathStyle: true,
      accessKeyId: "ACCESS",
      hasSecretAccessKey: true,
      config: {}
    } as never;
    const form = {
      ...formFromTarget(target),
      clearS3Credentials: true
    };

    expect(buildBackupTargetPayload(form, target)).toMatchObject({
      enabled: false,
      accessKeyId: null,
      secretAccessKey: null
    });
  });

  it("clears provider-specific form state for imported-to-SMB transitions", () => {
    const importedTarget = {
      id: "00000000-0000-4000-8000-000000000004",
      name: "Imported Drive",
      type: "rclone",
      kind: "rclone",
      enabled: true,
      localCachePolicy: "keep",
      rcloneProvider: "drive",
      remoteName: "gdrive",
      remotePath: "old-root",
      hasGenericConfig: true,
      hasGenericCredentials: true,
      config: { provider: "drive" }
    } as never;
    const transitioned = {
      ...formWithRcloneProvider(formFromTarget(importedTarget), "smb"),
      server: "nas.internal",
      share: "backups",
      subPath: "composebastion",
      password: "fresh-password"
    };
    const payload = buildBackupTargetPayload(transitioned, importedTarget);

    expect(transitioned.rcloneConfig).toBe("");
    expect(transitioned.remotePath).toBe("");
    expect(payload).toMatchObject({
      provider: "smb",
      server: "nas.internal",
      share: "backups",
      subPath: "composebastion",
      password: "fresh-password"
    });
    expect(payload).not.toHaveProperty("remotePath");
    expect(payload).not.toHaveProperty("rcloneConfig");
  });

  it("clears SMB form state and sends a fresh config for SMB-to-imported transitions", () => {
    const smbTarget = {
      id: "00000000-0000-4000-8000-000000000005",
      name: "Production NAS",
      type: "rclone",
      kind: "rclone",
      enabled: true,
      localCachePolicy: "keep",
      rcloneProvider: "smb",
      remoteName: "composebastion",
      remotePath: "backups/composebastion",
      hasGenericCredentials: true,
      config: {
        provider: "smb",
        smb: {
          server: "nas.internal",
          share: "backups",
          subPath: "composebastion",
          username: "backup"
        }
      }
    } as never;
    const transitioned = {
      ...formWithRcloneProvider(formFromTarget(smbTarget), "drive"),
      remotePath: "new-root",
      rcloneConfig: "[fresh]\ntype = drive\n"
    };
    const payload = buildBackupTargetPayload(transitioned, smbTarget);

    expect(transitioned.server).toBe("");
    expect(transitioned.username).toBe("");
    expect(transitioned.password).toBe("");
    expect(payload).toMatchObject({
      provider: "drive",
      remotePath: "new-root",
      rcloneConfig: "[fresh]\ntype = drive\n"
    });
    expect(payload).not.toHaveProperty("server");
    expect(payload).not.toHaveProperty("share");
    expect(payload).not.toHaveProperty("password");
  });
});
