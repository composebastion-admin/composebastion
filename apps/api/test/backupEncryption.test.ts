import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { appSecretKey } from "../src/config/env.js";
import {
  BackupDecryptTransform,
  BackupEncryptTransform,
  parseBackupEncryptionKeyring
} from "../src/services/backupEncryption.js";

async function collect(readable: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function splitEncryptedBackup(encrypted: Buffer) {
  const headerLength = encrypted.readUInt32BE(8);
  const headerEnd = 8 + 4 + headerLength;
  const frames: Buffer[] = [];
  let offset = headerEnd;
  while (offset < encrypted.length) {
    const ciphertextLength = encrypted.readUInt32BE(offset);
    const frameLength = 4 + 4 + 1 + 12 + 16 + ciphertextLength;
    frames.push(encrypted.subarray(offset, offset + frameLength));
    offset += frameLength;
  }
  return {
    header: encrypted.subarray(0, headerEnd),
    frames
  };
}

function rewriteHeader(encrypted: Buffer, update: (header: Record<string, unknown>) => void) {
  const headerLength = encrypted.readUInt32BE(8);
  const headerStart = 12;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(encrypted.subarray(headerStart, headerEnd).toString("utf8")) as Record<string, unknown>;
  update(header);
  const nextHeader = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(nextHeader.length, 0);
  return Buffer.concat([encrypted.subarray(0, 8), length, nextHeader, encrypted.subarray(headerEnd)]);
}

function keyFromSecret(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function fingerprint(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function frameAad(index: number, finalFrame: boolean) {
  const aad = Buffer.alloc(5);
  aad.writeUInt32BE(index, 0);
  aad[4] = finalFrame ? 1 : 0;
  return aad;
}

function legacyV2Backup(plaintext: Buffer) {
  const header = {
    version: 2,
    algorithm: "aes-256-gcm-chunked",
    keySource: "app_secret",
    keyFingerprint: fingerprint(appSecretKey),
    chunkSize: 64 * 1024
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerJson.length, 0);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", appSecretKey, iv);
  cipher.setAAD(frameAad(0, true));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(ciphertext.length, 0);
  const frameIndex = Buffer.alloc(4);
  frameIndex.writeUInt32BE(0, 0);
  return Buffer.concat([
    Buffer.from("DMBKENC1"),
    headerLength,
    headerJson,
    length,
    frameIndex,
    Buffer.from([1]),
    iv,
    tag,
    ciphertext
  ]);
}

describe("backup encryption keyring", () => {
  const appKey = keyFromSecret("app-secret-value-with-at-least-thirty-two-characters");
  const rotatedSecret = "rotated-backup-key-secret-with-more-than-32-characters";

  it("always includes app_secret and selects the configured active key", () => {
    const keyring = parseBackupEncryptionKeyring({
      appSecretKey: appKey,
      configuredKeys: `backup_2026:${rotatedSecret}`,
      activeKeyId: "backup_2026"
    });

    expect(keyring.keysById.has("app_secret")).toBe(true);
    expect(keyring.activeKey.id).toBe("backup_2026");
    expect(keyring.activeKey.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it("rejects invalid keyring configuration", () => {
    expect(() => parseBackupEncryptionKeyring({
      appSecretKey: appKey,
      configuredKeys: "bad key:secret-with-more-than-thirty-two-characters"
    })).toThrow("key ids");
    expect(() => parseBackupEncryptionKeyring({
      appSecretKey: appKey,
      configuredKeys: "short:too-short"
    })).toThrow("at least 32");
    expect(() => parseBackupEncryptionKeyring({
      appSecretKey: appKey,
      configuredKeys: `dup:${rotatedSecret},dup:another-rotated-secret-with-more-than-32-characters`
    })).toThrow("Duplicate");
    expect(() => parseBackupEncryptionKeyring({
      appSecretKey: keyFromSecret(rotatedSecret),
      configuredKeys: `same:${rotatedSecret}`
    })).toThrow("Duplicate");
    expect(() => parseBackupEncryptionKeyring({
      appSecretKey: appKey,
      activeKeyId: "missing"
    })).toThrow("not configured");
  });
});

describe("backup encryption streams", () => {
  it("round trips encrypted backup bytes without exposing plaintext", async () => {
    const plaintext = Buffer.concat([
      Buffer.from("secret backup payload\n"),
      Buffer.alloc(140 * 1024, "a")
    ]);

    const encrypted = await collect(Readable.from([plaintext]).pipe(new BackupEncryptTransform()));
    expect(encrypted.subarray(0, 8).toString("utf8")).toBe("DMBKENC1");
    expect(encrypted.toString("utf8")).not.toContain("secret backup payload");
    const headerLength = encrypted.readUInt32BE(8);
    const header = JSON.parse(encrypted.subarray(12, 12 + headerLength).toString("utf8"));
    expect(header.version).toBe(3);
    expect(header.keyId).toBe("app_secret");
    expect(header.keyFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(typeof header.artifactNonce).toBe("string");

    const decrypted = await collect(Readable.from([
      encrypted.subarray(0, 31),
      encrypted.subarray(31, 80_000),
      encrypted.subarray(80_000)
    ]).pipe(new BackupDecryptTransform()));
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("detects tampered encrypted backup frames", async () => {
    const encrypted = await collect(Readable.from(["important archive"]).pipe(new BackupEncryptTransform()));
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;

    await expect(collect(Readable.from([tampered]).pipe(new BackupDecryptTransform()))).rejects.toThrow();
  });

  it("rejects encrypted backup header tampering", async () => {
    const encrypted = await collect(Readable.from(["important archive"]).pipe(new BackupEncryptTransform()));
    const tampered = rewriteHeader(encrypted, (header) => {
      header.artifactNonce = Buffer.alloc(16, 1).toString("base64url");
    });

    await expect(collect(Readable.from([tampered]).pipe(new BackupDecryptTransform()))).rejects.toThrow();
  });

  it("rejects frames spliced from a different encrypted backup", async () => {
    const first = await collect(Readable.from(["first archive"]).pipe(new BackupEncryptTransform()));
    const second = await collect(Readable.from(["second archive"]).pipe(new BackupEncryptTransform()));
    const firstParts = splitEncryptedBackup(first);
    const secondParts = splitEncryptedBackup(second);
    const spliced = Buffer.concat([firstParts.header, ...secondParts.frames]);

    await expect(collect(Readable.from([spliced]).pipe(new BackupDecryptTransform()))).rejects.toThrow();
  });

  it("rejects reordered encrypted backup frames", async () => {
    const encrypted = await collect(
      Readable.from([Buffer.alloc(150 * 1024, "x")]).pipe(new BackupEncryptTransform())
    );
    const { header, frames } = splitEncryptedBackup(encrypted);
    expect(frames.length).toBeGreaterThan(2);

    const reordered = Buffer.concat([header, frames[1]!, frames[0]!, ...frames.slice(2)]);
    await expect(collect(Readable.from([reordered]).pipe(new BackupDecryptTransform()))).rejects.toThrow("frame order");
  });

  it("rejects truncated encrypted backups without a final frame", async () => {
    const encrypted = await collect(
      Readable.from([Buffer.alloc(150 * 1024, "x")]).pipe(new BackupEncryptTransform())
    );
    const { header, frames } = splitEncryptedBackup(encrypted);
    const truncated = Buffer.concat([header, ...frames.slice(0, -1)]);

    await expect(collect(Readable.from([truncated]).pipe(new BackupDecryptTransform()))).rejects.toThrow("final frame");
  });

  it("reports a clear missing-key error", async () => {
    const keyring = parseBackupEncryptionKeyring({
      appSecretKey: keyFromSecret("app-secret-value-with-at-least-thirty-two-characters"),
      configuredKeys: "rotated:rotated-backup-key-secret-with-more-than-32-characters",
      activeKeyId: "rotated"
    });
    const decryptKeyring = parseBackupEncryptionKeyring({
      appSecretKey: keyFromSecret("different-app-secret-value-with-at-least-thirty-two")
    });
    const encrypted = await collect(Readable.from(["important archive"]).pipe(new BackupEncryptTransform(keyring)));

    await expect(collect(Readable.from([encrypted]).pipe(new BackupDecryptTransform(decryptKeyring)))).rejects.toThrow("requires backup encryption key rotated");
  });

  it("reports a clear app-secret fingerprint mismatch", async () => {
    const encrypted = await collect(Readable.from(["important archive"]).pipe(new BackupEncryptTransform()));
    const wrongFingerprint = rewriteHeader(encrypted, (header) => {
      header.keyFingerprint = "0000000000000000";
    });

    await expect(collect(Readable.from([wrongFingerprint]).pipe(new BackupDecryptTransform()))).rejects.toThrow("different APP_SECRET");
  });

  it("decrypts existing v2 app-secret backups by fingerprint", async () => {
    const plaintext = Buffer.from("legacy encrypted backup");
    const encrypted = legacyV2Backup(plaintext);

    const decrypted = await collect(Readable.from([encrypted]).pipe(new BackupDecryptTransform()));
    expect(decrypted.equals(plaintext)).toBe(true);
  });
});
