import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { appSecretKey, env } from "../config/env.js";

export type BackupEncryption = "none" | "app_secret";

const MAGIC = Buffer.from("DMBKENC1");
const HEADER_ENCODING = "utf8";
const CHUNK_SIZE = 64 * 1024;
const MAX_FRAME_SIZE = 16 * 1024 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ARTIFACT_NONCE_BYTES = 16;
const FRAME_METADATA_BYTES = 4 + 4 + 1 + IV_BYTES + TAG_BYTES;
const KEY_ID_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

type BackupEncryptionKey = {
  id: string;
  key: Buffer;
  fingerprint: string;
};

export type BackupEncryptionKeyring = {
  activeKey: BackupEncryptionKey;
  keysById: Map<string, BackupEncryptionKey>;
  keysByFingerprint: Map<string, BackupEncryptionKey>;
};

type BackupEncryptionHeaderV2 = {
  version: 2;
  algorithm: "aes-256-gcm-chunked";
  keySource: "app_secret";
  keyFingerprint: string;
  chunkSize: number;
};

type BackupEncryptionHeaderV3 = {
  version: 3;
  algorithm: "aes-256-gcm-chunked";
  keySource: "keyring";
  keyId: string;
  keyFingerprint: string;
  chunkSize: number;
  artifactNonce: string;
};

type BackupEncryptionHeader = BackupEncryptionHeaderV2 | BackupEncryptionHeaderV3;

function keyFingerprint(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function configuredKey(entry: string) {
  const separator = entry.indexOf(":");
  if (separator <= 0) {
    throw new Error("BACKUP_ENCRYPTION_KEYS entries must use keyId:secret");
  }
  const id = entry.slice(0, separator).trim();
  const secret = entry.slice(separator + 1);
  if (!KEY_ID_PATTERN.test(id)) {
    throw new Error("BACKUP_ENCRYPTION_KEYS key ids may only contain letters, digits, '_', '.', '-' and be at most 64 characters");
  }
  if (secret.length < 32) {
    throw new Error(`Backup encryption key ${id} must be at least 32 characters`);
  }
  const key = createHash("sha256").update(secret).digest();
  return { id, key, fingerprint: keyFingerprint(key) };
}

export function parseBackupEncryptionKeyring(input: {
  appSecretKey: Buffer;
  configuredKeys?: string;
  activeKeyId?: string;
}): BackupEncryptionKeyring {
  const keys = [
    {
      id: "app_secret",
      key: input.appSecretKey,
      fingerprint: keyFingerprint(input.appSecretKey)
    },
    ...(input.configuredKeys ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(configuredKey)
  ];
  const keysById = new Map<string, BackupEncryptionKey>();
  const keysByFingerprint = new Map<string, BackupEncryptionKey>();
  for (const key of keys) {
    if (keysById.has(key.id)) {
      throw new Error(`Duplicate backup encryption key id ${key.id}`);
    }
    if (keysByFingerprint.has(key.fingerprint)) {
      throw new Error(`Duplicate backup encryption key fingerprint ${key.fingerprint}`);
    }
    keysById.set(key.id, key);
    keysByFingerprint.set(key.fingerprint, key);
  }
  const activeKeyId = input.activeKeyId?.trim() || "app_secret";
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error("BACKUP_ENCRYPTION_ACTIVE_KEY_ID may only contain letters, digits, '_', '.', '-' and be at most 64 characters");
  }
  const activeKey = keysById.get(activeKeyId);
  if (!activeKey) {
    throw new Error(`BACKUP_ENCRYPTION_ACTIVE_KEY_ID ${activeKeyId} is not configured`);
  }
  return { activeKey, keysById, keysByFingerprint };
}

export const backupEncryptionKeyring = parseBackupEncryptionKeyring({
  appSecretKey,
  configuredKeys: env.BACKUP_ENCRYPTION_KEYS,
  activeKeyId: env.BACKUP_ENCRYPTION_ACTIVE_KEY_ID
});

export const backupEncryptionKeyId = backupEncryptionKeyring.activeKey.id;
export const backupEncryptionKeyFingerprint = backupEncryptionKeyring.activeKey.fingerprint;

function headerBytes(key: BackupEncryptionKey, artifactNonce: Buffer) {
  const header: BackupEncryptionHeaderV3 = {
    version: 3,
    algorithm: "aes-256-gcm-chunked",
    keySource: "keyring",
    keyId: key.id,
    keyFingerprint: key.fingerprint,
    chunkSize: CHUNK_SIZE,
    artifactNonce: artifactNonce.toString("base64url")
  };
  const json = Buffer.from(JSON.stringify(header), HEADER_ENCODING);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([MAGIC, length, json]);
}

function parseHeader(raw: Buffer, keyring: BackupEncryptionKeyring) {
  const parsed = JSON.parse(raw.toString(HEADER_ENCODING)) as BackupEncryptionHeader;
  if (
    parsed.algorithm !== "aes-256-gcm-chunked"
    || (parsed.version !== 2 && parsed.version !== 3)
  ) {
    throw new Error("Unsupported encrypted backup format");
  }
  if (parsed.version === 2) {
    if (parsed.keySource !== "app_secret" || parsed.chunkSize !== CHUNK_SIZE) {
      throw new Error("Unsupported encrypted backup format");
    }
    const key = keyring.keysByFingerprint.get(parsed.keyFingerprint);
    if (!key) {
      throw new Error("Encrypted backup was encrypted with a different APP_SECRET or unavailable backup encryption key. Restore, verify, or download requires the original key material.");
    }
    return { header: parsed, key, artifactNonce: null };
  }
  if (
    parsed.keySource !== "keyring"
    || parsed.chunkSize !== CHUNK_SIZE
    || !KEY_ID_PATTERN.test(parsed.keyId)
    || typeof parsed.artifactNonce !== "string"
  ) {
    throw new Error("Unsupported encrypted backup format");
  }
  const key = keyring.keysById.get(parsed.keyId);
  if (!key) {
    throw new Error(`Encrypted backup requires backup encryption key ${parsed.keyId}. Configure BACKUP_ENCRYPTION_KEYS or restore the original APP_SECRET.`);
  }
  if (key.fingerprint !== parsed.keyFingerprint) {
    if (parsed.keyId === "app_secret") {
      throw new Error("Encrypted backup was encrypted with a different APP_SECRET. Restore, verify, or download requires the original APP_SECRET.");
    }
    throw new Error(`Encrypted backup key ${parsed.keyId} fingerprint mismatch. Check BACKUP_ENCRYPTION_KEYS.`);
  }
  const artifactNonce = Buffer.from(parsed.artifactNonce, "base64url");
  if (artifactNonce.length !== ARTIFACT_NONCE_BYTES) {
    throw new Error("Encrypted backup artifact nonce is invalid");
  }
  return { header: parsed, key, artifactNonce };
}

function frameMarker(index: number, finalFrame: boolean) {
  const aad = Buffer.alloc(5);
  aad.writeUInt32BE(index, 0);
  aad[4] = finalFrame ? 1 : 0;
  return aad;
}

function frameAad(header: BackupEncryptionHeader, headerRaw: Buffer, artifactNonce: Buffer | null, index: number, finalFrame: boolean) {
  if (header.version === 2) return frameMarker(index, finalFrame);
  return Buffer.concat([headerRaw, artifactNonce ?? Buffer.alloc(0), frameMarker(index, finalFrame)]);
}

function frameAadV3(headerRaw: Buffer, artifactNonce: Buffer, index: number, finalFrame: boolean) {
  return Buffer.concat([headerRaw, artifactNonce, frameMarker(index, finalFrame)]);
}

function encryptFrame(plaintext: Buffer, index: number, finalFrame: boolean, key: BackupEncryptionKey, headerRaw: Buffer, artifactNonce: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(frameAadV3(headerRaw, artifactNonce, index, finalFrame));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(ciphertext.length, 0);
  const frameIndex = Buffer.alloc(4);
  frameIndex.writeUInt32BE(index, 0);
  const flags = Buffer.from([finalFrame ? 1 : 0]);
  return Buffer.concat([length, frameIndex, flags, iv, tag, ciphertext]);
}

function decryptFrame(
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  index: number,
  finalFrame: boolean,
  header: BackupEncryptionHeader,
  headerRaw: Buffer,
  artifactNonce: Buffer | null,
  key: BackupEncryptionKey
) {
  const decipher = createDecipheriv("aes-256-gcm", key.key, iv);
  decipher.setAAD(frameAad(header, headerRaw, artifactNonce, index, finalFrame));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isBackupEncrypted(encryption?: string | null): encryption is "app_secret" {
  return encryption === "app_secret";
}

export class BackupEncryptTransform extends Transform {
  private readonly key: BackupEncryptionKey;
  private readonly artifactNonce = randomBytes(ARTIFACT_NONCE_BYTES);
  private readonly headerRaw: Buffer;
  private wroteHeader = false;
  private frameIndex = 0;
  private buffer = Buffer.alloc(0);
  private finalized = false;

  constructor(keyring: BackupEncryptionKeyring = backupEncryptionKeyring) {
    super();
    this.key = keyring.activeKey;
    this.headerRaw = headerBytes(this.key, this.artifactNonce);
  }

  private writeHeader() {
    if (this.wroteHeader) return;
    this.push(this.headerRaw);
    this.wroteHeader = true;
  }

  private pushFrame(plaintext: Buffer, finalFrame: boolean) {
    this.writeHeader();
    this.push(encryptFrame(plaintext, this.frameIndex, finalFrame, this.key, this.headerRaw, this.artifactNonce));
    this.frameIndex += 1;
    this.finalized = finalFrame;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
    try {
      if (this.finalized) throw new Error("Encrypted backup stream already finalized");
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.buffer = Buffer.concat([this.buffer, buffer]);
      while (this.buffer.length > CHUNK_SIZE) {
        this.pushFrame(this.buffer.subarray(0, CHUNK_SIZE), false);
        this.buffer = this.buffer.subarray(CHUNK_SIZE);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback) {
    try {
      this.pushFrame(this.buffer, true);
      this.buffer = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export class BackupDecryptTransform extends Transform {
  private buffer = Buffer.alloc(0);
  private header: BackupEncryptionHeader | null = null;
  private headerRaw: Buffer | null = null;
  private key: BackupEncryptionKey | null = null;
  private artifactNonce: Buffer | null = null;
  private expectedFrameIndex = 0;
  private finalFrameSeen = false;

  constructor(private readonly keyring: BackupEncryptionKeyring = backupEncryptionKeyring) {
    super();
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback) {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.buffer = Buffer.concat([this.buffer, buffer]);
      this.drainFrames();
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback) {
    try {
      this.drainFrames();
      if (!this.header) throw new Error("Encrypted backup is missing its header");
      if (this.buffer.length) throw new Error("Encrypted backup ended with a partial frame");
      if (!this.finalFrameSeen) throw new Error("Encrypted backup ended before its final frame");
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private drainFrames() {
    if (!this.header) {
      if (this.buffer.length < MAGIC.length + 4) return;
      if (!this.buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error("Encrypted backup header is invalid");
      }
      const headerLength = this.buffer.readUInt32BE(MAGIC.length);
      if (headerLength > MAX_FRAME_SIZE) throw new Error("Encrypted backup header is too large");
      const headerEnd = MAGIC.length + 4 + headerLength;
      if (this.buffer.length < headerEnd) return;
      this.headerRaw = this.buffer.subarray(0, headerEnd);
      const parsed = parseHeader(this.buffer.subarray(MAGIC.length + 4, headerEnd), this.keyring);
      this.header = parsed.header;
      this.key = parsed.key;
      this.artifactNonce = parsed.artifactNonce;
      this.buffer = this.buffer.subarray(headerEnd);
    }

    while (this.buffer.length >= 4) {
      if (this.finalFrameSeen) {
        throw new Error("Encrypted backup contains data after its final frame");
      }
      const ciphertextLength = this.buffer.readUInt32BE(0);
      if (ciphertextLength > MAX_FRAME_SIZE) throw new Error("Encrypted backup frame is too large");
      const frameLength = FRAME_METADATA_BYTES + ciphertextLength;
      if (this.buffer.length < frameLength) return;
      const frameIndex = this.buffer.readUInt32BE(4);
      const flag = this.buffer[8];
      if (flag !== 0 && flag !== 1) throw new Error("Encrypted backup frame flag is invalid");
      const finalFrame = flag === 1;
      if (frameIndex !== this.expectedFrameIndex) {
        throw new Error("Encrypted backup frame order is invalid");
      }
      const ivStart = 9;
      const tagStart = ivStart + IV_BYTES;
      const ciphertextStart = tagStart + TAG_BYTES;
      const iv = this.buffer.subarray(ivStart, tagStart);
      const tag = this.buffer.subarray(tagStart, ciphertextStart);
      const ciphertext = this.buffer.subarray(ciphertextStart, frameLength);
      this.push(decryptFrame(
        iv,
        tag,
        ciphertext,
        frameIndex,
        finalFrame,
        this.header,
        this.headerRaw!,
        this.artifactNonce,
        this.key!
      ));
      this.expectedFrameIndex += 1;
      this.finalFrameSeen = finalFrame;
      this.buffer = this.buffer.subarray(frameLength);
    }
  }
}

export function createBackupEncryptTransform(encryption: BackupEncryption) {
  return isBackupEncrypted(encryption) ? new BackupEncryptTransform() : null;
}

export function createBackupDecryptTransform(encryption: BackupEncryption | string | null | undefined) {
  return isBackupEncrypted(encryption) ? new BackupDecryptTransform() : null;
}
