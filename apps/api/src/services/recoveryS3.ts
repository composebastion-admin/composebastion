import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import { isPrivateIp, resolveAgentHostname, type LookupAll } from "./ssrf.js";

export type S3TargetConfig = {
  endpoint: string;
  bucket: string;
  region?: string | null;
  prefix?: string | null;
  forcePathStyle?: boolean;
};

export type S3TargetCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type S3UploadResult = {
  objectKey: string;
  sizeBytes: number;
  etag: string | null;
};

export type S3HeadResult = {
  sizeBytes: number | null;
  etag: string | null;
  checksum: string | null;
};

export type S3DownloadResult = {
  objectKey: string;
  sizeBytes: number;
  etag: string | null;
  checksum: string | null;
};

export function normalizeS3Prefix(prefix?: string | null) {
  if (!prefix) return "";
  return prefix.replace(/^\/+|\/+$/g, "");
}

export function buildS3ObjectKey(prefix: string | null | undefined, recoveryPointId: string, storageKey: string) {
  const parts = [normalizeS3Prefix(prefix), recoveryPointId, storageKey.replace(/^\/+/, "")]
    .filter(Boolean);
  return parts.join("/").replace(/\/+/g, "/");
}

export function createS3Client(config: S3TargetConfig, credentials: S3TargetCredentials) {
  const clientConfig: S3ClientConfig = {
    endpoint: config.endpoint,
    region: config.region || "us-east-1",
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  };
  return new S3Client(clientConfig);
}

export function parseS3Config(raw: Record<string, unknown>): S3TargetConfig {
  const endpoint = String(raw.endpoint ?? "");
  const bucket = String(raw.bucket ?? "");
  if (!endpoint || !bucket) {
    throw new Error("S3 backup target is missing endpoint or bucket");
  }
  return {
    endpoint,
    bucket,
    region: raw.region ? String(raw.region) : null,
    prefix: raw.prefix ? String(raw.prefix) : null,
    forcePathStyle: raw.forcePathStyle === true || raw.pathStyle === true
  };
}

export async function validateS3Endpoint(endpoint: string, blockPrivateEndpoints: boolean, resolve?: LookupAll) {
  if (!blockPrivateEndpoints) return true;
  const parsed = new URL(endpoint);
  const addresses = await resolveAgentHostname(parsed.hostname, resolve);
  for (const entry of addresses) {
    if (isPrivateIp(entry.address)) return false;
  }
  return true;
}

export async function uploadRecoveryArtifactToS3(
  client: S3Client,
  bucket: string,
  objectKey: string,
  localPath: string,
  checksum?: string | null
): Promise<S3UploadResult> {
  const body = createReadStream(localPath);
  const response = await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    Metadata: checksum ? { sha256: checksum.replace(/^sha256:/, "") } : undefined
  }));
  const stat = await import("node:fs/promises").then((fs) => fs.stat(localPath));
  return {
    objectKey,
    sizeBytes: stat.size,
    etag: response.ETag ?? null
  };
}

export async function headRecoveryArtifactOnS3(client: S3Client, bucket: string, objectKey: string): Promise<S3HeadResult> {
  const response = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
  return {
    sizeBytes: response.ContentLength ?? null,
    etag: response.ETag ?? null,
    checksum: response.Metadata?.sha256 ? `sha256:${response.Metadata.sha256}` : null
  };
}

export async function downloadRecoveryArtifactFromS3(
  client: S3Client,
  bucket: string,
  objectKey: string,
  localPath: string
): Promise<S3DownloadResult> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!response.Body) throw new Error(`S3 object ${objectKey} did not include a response body`);

  await mkdir(path.dirname(localPath), { recursive: true });
  const body = response.Body as unknown;
  if (body instanceof Readable || (body && typeof (body as { pipe?: unknown }).pipe === "function")) {
    await pipeline(body as NodeJS.ReadableStream, createWriteStream(localPath));
  } else if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    await writeFile(localPath, Buffer.from(bytes));
  } else if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    const webStream = (body as { transformToWebStream: () => unknown }).transformToWebStream();
    await pipeline(
      Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(localPath)
    );
  } else {
    throw new Error(`S3 object ${objectKey} used an unsupported response body type`);
  }

  const fileStat = await stat(localPath);
  return {
    objectKey,
    sizeBytes: fileStat.size,
    etag: response.ETag ?? null,
    checksum: response.Metadata?.sha256 ? `sha256:${response.Metadata.sha256}` : null
  };
}

export async function openRecoveryArtifactStreamFromS3(
  client: S3Client,
  bucket: string,
  objectKey: string
) {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!response.Body) throw new Error(`S3 object ${objectKey} did not include a response body`);

  const body = response.Body as unknown;
  let stream: NodeJS.ReadableStream;
  if (body instanceof Readable || (body && typeof (body as { pipe?: unknown }).pipe === "function")) {
    stream = body as NodeJS.ReadableStream;
  } else if (body && typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function") {
    const webStream = (body as { transformToWebStream: () => unknown }).transformToWebStream();
    stream = Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]);
  } else if (body && typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    stream = Readable.from((async function * bytes() {
      const data = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      yield Buffer.from(data);
    })());
  } else {
    throw new Error(`S3 object ${objectKey} used an unsupported response body type`);
  }

  return {
    stream,
    sizeBytes: response.ContentLength ?? null,
    etag: response.ETag ?? null,
    checksum: response.Metadata?.sha256 ? `sha256:${response.Metadata.sha256}` : null
  };
}

export async function deleteRecoveryArtifactFromS3(
  client: S3Client,
  bucket: string,
  objectKey: string
) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
}

export function resolveRecoveryPointStatus(input: {
  localCompleted: number;
  localFailed: number;
  remoteUploadFailures: number;
}) {
  if (input.localFailed > 0 && input.localCompleted === 0) {
    return { status: "failed" as const, error: "All recovery artifacts failed" };
  }
  if (input.localFailed > 0 || input.remoteUploadFailures > 0) {
    const parts: string[] = [];
    if (input.localFailed > 0) parts.push("Some recovery artifacts failed");
    if (input.remoteUploadFailures > 0) parts.push("Some remote uploads failed");
    return { status: "partial" as const, error: parts.join("; ") };
  }
  return { status: "completed" as const, error: null };
}

export function redactS3Credentials<T extends Record<string, unknown>>(target: T): T {
  const clone = { ...target } as Record<string, unknown>;
  if ("secretAccessKey" in clone) clone.secretAccessKey = clone.secretAccessKey ? "[redacted]" : null;
  if ("secrets" in clone && clone.secrets && typeof clone.secrets === "object") {
    const secrets = { ...(clone.secrets as Record<string, unknown>) };
    if ("secretAccessKey" in secrets) secrets.secretAccessKey = secrets.secretAccessKey ? "[redacted]" : null;
    clone.secrets = secrets;
  }
  return clone as T;
}
