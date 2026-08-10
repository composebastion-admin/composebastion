import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({ query }));

const { listAuditEvents, writeAuditEvent } = await import("../src/services/audit.js");

const auditId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const urlCanary = "audit-url-secret";
const diagnosticCanary = "authorized-audit-detail";
const unsafeDynamicKey = `https://key-user:${urlCanary}@keys.example.test/path`;
const safeDynamicKey = "https://keys.example.test/path";

function legacyDetails() {
  return {
    summary: `summary ${diagnosticCanary}; remote https://git-user:${urlCanary}@git.example.test/team/app.git?token=${urlCanary}`,
    nested: {
      stdout: `stdout ${diagnosticCanary}; remote ssh://git:${urlCanary}@git.example.test/team/app.git#${urlCanary}`,
      token: `nested-token-${urlCanary}`,
      credentialSecret: `credential-secret-${urlCanary}`,
      credential_secret: `credential-secret-snake-${urlCanary}`,
      "credential-secret": `credential-secret-kebab-${urlCanary}`,
      rcloneConfig: `rclone-config-${urlCanary}`,
      rclone_config: `rclone-config-snake-${urlCanary}`,
      "rclone-config": `rclone-config-kebab-${urlCanary}`,
      rcloneCredentials: `rclone-credentials-${urlCanary}`,
      rclone_credentials: `rclone-credentials-snake-${urlCanary}`,
      "rclone-credentials": `rclone-credentials-kebab-${urlCanary}`,
      genericCredentialsEncrypted: `generic-credentials-encrypted-${urlCanary}`,
      APP_SECRET: `app-secret-upper-${urlCanary}`,
      app_secret: `app-secret-snake-${urlCanary}`,
      appSecret: `app-secret-camel-${urlCanary}`,
      credentialPassword: `credential-password-${urlCanary}`,
      dbPassword: `database-password-${urlCanary}`,
      secretValue: `nested-secret-value-${urlCanary}`,
      secret: true,
      hasSecretAccessKey: true,
      attempts: [
        `attempt ${diagnosticCanary}; remote git://git-user:${urlCanary}@git.example.test/team/app.git`,
        {
          ssh_password: `nested-password-${urlCanary}`,
          note: diagnosticCanary
        }
      ]
    },
    dynamic: {
      [unsafeDynamicKey]: `first ${diagnosticCanary}`,
      [safeDynamicKey]: `second ${diagnosticCanary}`
    },
    repositoryUrl: `https://git-user:${urlCanary}@git.example.test/team/app.git?token=${urlCanary}`,
    unchanged: diagnosticCanary
  };
}

function safeLegacyDetails() {
  return {
    summary: `summary ${diagnosticCanary}; remote https://git.example.test/team/app.git`,
    nested: {
      stdout: `stdout ${diagnosticCanary}; remote ssh://git@git.example.test/team/app.git`,
      token: "[redacted]",
      credentialSecret: "[redacted]",
      credential_secret: "[redacted]",
      "credential-secret": "[redacted]",
      rcloneConfig: "[redacted]",
      rclone_config: "[redacted]",
      "rclone-config": "[redacted]",
      rcloneCredentials: "[redacted]",
      rclone_credentials: "[redacted]",
      "rclone-credentials": "[redacted]",
      genericCredentialsEncrypted: "[redacted]",
      APP_SECRET: "[redacted]",
      app_secret: "[redacted]",
      appSecret: "[redacted]",
      credentialPassword: "[redacted]",
      dbPassword: "[redacted]",
      secretValue: "[redacted]",
      secret: true,
      hasSecretAccessKey: true,
      attempts: [
        `attempt ${diagnosticCanary}; remote git://git.example.test/team/app.git`,
        {
          ssh_password: "[redacted]",
          note: diagnosticCanary
        }
      ]
    },
    dynamic: {
      [safeDynamicKey]: `first ${diagnosticCanary}`,
      [`${safeDynamicKey} [2]`]: `second ${diagnosticCanary}`
    },
    repositoryUrl: "https://git.example.test/team/app.git",
    unchanged: diagnosticCanary
  };
}

describe("audit URL sanitization", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("sanitizes schemaless URL diagnostics before writing without removing non-URL detail", async () => {
    query.mockResolvedValue({ rows: [] });

    await writeAuditEvent({
      userId,
      action: "config.export",
      targetKind: "test",
      targetId: auditId,
      details: {
        ...legacyDetails(),
        token: "top-level-token",
        secret: `top-level-secret-${urlCanary}`
      }
    });

    const written = query.mock.calls[0]?.[1]?.[6];
    expect(written).toEqual({
      ...safeLegacyDetails(),
      token: "[redacted]",
      secret: "[redacted]"
    });
    expect(JSON.stringify(written)).not.toContain(urlCanary);
  });

  it("sanitizes legacy URL diagnostics on audit reads without removing authorized non-URL detail", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{
          id: auditId,
          user_id: userId,
          host_id: null,
          action: "config.export",
          target_kind: "test",
          target_id: auditId,
          details: legacyDetails(),
          created_at: new Date(0)
        }]
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    const page = await listAuditEvents({});
    const details = page.items[0]?.details;

    expect(details).toEqual(safeLegacyDetails());
    expect(JSON.stringify(details)).not.toContain(urlCanary);
  });
});
