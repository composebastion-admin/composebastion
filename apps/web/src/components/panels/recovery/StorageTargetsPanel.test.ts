import { describe, expect, it } from "vitest";
import { buildBackupTargetPayload, formFromTarget, rcloneProviderOptions } from "./StorageTargetsPanel.js";

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
      remotePath: "recovery",
      server: "nas.internal",
      share: "backups",
      subPath: "composebastion",
      domain: "ACME",
      username: "backup-user",
      port: 445
    });
    expect(payload).not.toHaveProperty("password");
  });
});
