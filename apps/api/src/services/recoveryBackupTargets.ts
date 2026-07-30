import {
  s3EndpointSchema,
  type BackupTarget,
  type BackupTargetCreate,
  type BackupTargetUpdate,
  type LocalCachePolicy,
  type RcloneProvider
} from "@composebastion/shared";
import { env } from "../config/env.js";
import { query } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { S3TargetConfig, S3TargetCredentials } from "./recoveryS3.js";
import { parseS3Config, validateS3Endpoint } from "./recoveryS3.js";
import type { LookupAll } from "./ssrf.js";

export type BackupTargetRowInput = {
  name: string;
  kind: "local" | "s3" | "rclone";
  enabled: boolean;
  config: Record<string, unknown>;
  accessKeyId: string | null;
  secretAccessKeyEncrypted: string | null;
  provider: string | null;
  remotePath: string | null;
  localCachePolicy: LocalCachePolicy;
  genericConfigEncrypted: string | null;
  genericCredentialsEncrypted: string | null;
};

type RcloneSmbInput = {
  server?: string | null;
  share?: string | null;
  subPath?: string | null;
  domain?: string | null;
  username?: string | null;
  password?: string | null;
  port?: number | null;
};

type RcloneCreateInput = BackupTargetCreate & {
  provider?: RcloneProvider;
  remotePath?: string;
  remoteName?: string;
  rcloneConfig?: string;
  server?: string;
  share?: string;
  subPath?: string;
  domain?: string;
  username?: string;
  password?: string;
  port?: number;
  config?: {
    provider?: RcloneProvider;
    remotePath?: string;
    remoteName?: string;
    rcloneConfig?: string;
    smb?: RcloneSmbInput;
  };
};

export function s3ConfigFromFlat(input: {
  endpoint: string;
  bucket: string;
  region?: string | null;
  prefix?: string | null;
  forcePathStyle?: boolean;
}): Record<string, unknown> {
  return {
    endpoint: input.endpoint,
    bucket: input.bucket,
    region: input.region ?? null,
    prefix: input.prefix ?? null,
    forcePathStyle: input.forcePathStyle ?? false
  };
}

function emptyToNull(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

function parseFirstRcloneRemote(configText?: string | null) {
  if (!configText) return null;
  const match = configText.match(/^\s*\[([^\]]+)\]/m);
  return match?.[1]?.trim() || null;
}

function rcloneConfigFromFlat(input: {
  provider: RcloneProvider;
  remotePath?: string | null;
  remoteName?: string | null;
  rcloneConfig?: string | null;
  server?: string | null;
  share?: string | null;
  subPath?: string | null;
  domain?: string | null;
  username?: string | null;
  password?: string | null;
  port?: number | null;
}) {
  const remoteName = emptyToNull(input.remoteName)
    ?? parseFirstRcloneRemote(input.rcloneConfig)
    ?? "composebastion";
  const provider = input.provider;
  const subPath = emptyToNull(input.subPath);
  const share = emptyToNull(input.share);
  const remotePath = emptyToNull(input.remotePath)
    ?? (provider === "smb" && share ? [share, subPath].filter(Boolean).join("/") : null)
    ?? "composebastion";
  const config: Record<string, unknown> = { provider, remoteName, remotePath };
  if (provider === "smb") {
    config.smb = {
      server: emptyToNull(input.server),
      share,
      subPath,
      domain: emptyToNull(input.domain),
      username: emptyToNull(input.username),
      port: input.port ?? null
    };
  }
  return config;
}

export function normalizeBackupTargetCreate(input: BackupTargetCreate): BackupTargetRowInput {
  const localCachePolicy = (input as { localCachePolicy?: LocalCachePolicy }).localCachePolicy ?? "keep";
  const kind = (input as { type?: "local" | "s3" | "rclone"; kind?: "local" | "s3" | "rclone" }).type
    ?? (input as { kind?: "local" | "s3" | "rclone" }).kind;
  if (kind === "local") {
    const local = input as Extract<BackupTargetCreate, { kind: "local" }>;
    return {
      name: local.name,
      kind: "local",
      enabled: local.enabled,
      config: {},
      accessKeyId: null,
      secretAccessKeyEncrypted: null,
      provider: null,
      remotePath: null,
      localCachePolicy: "keep",
      genericConfigEncrypted: null,
      genericCredentialsEncrypted: null
    };
  }

  if (kind === "rclone") {
    const rclone = input as RcloneCreateInput;
    const provider = rclone.provider ?? rclone.config?.provider;
    if (!provider) throw new Error("rclone backup targets require a provider");
    const rcloneConfig = rclone.rcloneConfig ?? rclone.config?.rcloneConfig ?? null;
    const smb = rclone.config?.smb ?? {};
    const config = rcloneConfigFromFlat({
      provider,
      remotePath: rclone.remotePath ?? rclone.config?.remotePath,
      remoteName: rclone.remoteName ?? rclone.config?.remoteName,
      rcloneConfig,
      server: rclone.server ?? smb.server,
      share: rclone.share ?? smb.share,
      subPath: rclone.subPath ?? smb.subPath,
      domain: rclone.domain ?? smb.domain,
      username: rclone.username ?? smb.username,
      password: rclone.password ?? smb.password,
      port: rclone.port ?? smb.port
    });
    const password = rclone.password ?? smb.password ?? null;
    return {
      name: rclone.name,
      kind: "rclone",
      enabled: rclone.enabled,
      config,
      accessKeyId: null,
      secretAccessKeyEncrypted: null,
      provider,
      remotePath: String(config.remotePath ?? ""),
      localCachePolicy,
      genericConfigEncrypted: rcloneConfig ? encryptSecret(rcloneConfig) : null,
      genericCredentialsEncrypted: password ? encryptSecret(JSON.stringify({ password })) : null
    };
  }

  const s3 = input as Extract<BackupTargetCreate, { kind: "s3" }> & {
    endpoint?: string;
    bucket?: string;
    region?: string;
    prefix?: string;
    forcePathStyle?: boolean;
  };
  const config = s3.endpoint && s3.bucket
    ? s3ConfigFromFlat({
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      region: s3.region ?? s3.config?.region,
      prefix: s3.prefix ?? s3.config?.prefix,
      forcePathStyle: s3.forcePathStyle ?? s3.config?.pathStyle ?? s3.config?.forcePathStyle
    })
    : s3ConfigFromFlat({
      endpoint: s3.config.endpoint,
      bucket: s3.config.bucket,
      region: s3.config.region,
      prefix: s3.config.prefix,
      forcePathStyle: s3.config.pathStyle ?? s3.config.forcePathStyle
    });

  if (!s3.accessKeyId || !s3.secretAccessKey) {
    throw new Error("S3 backup targets require accessKeyId and secretAccessKey");
  }

  return {
    name: s3.name,
    kind: "s3",
    enabled: s3.enabled,
    config,
    accessKeyId: s3.accessKeyId,
    secretAccessKeyEncrypted: encryptSecret(s3.secretAccessKey),
    provider: null,
    remotePath: null,
    localCachePolicy,
    genericConfigEncrypted: null,
    genericCredentialsEncrypted: null
  };
}

export function normalizeBackupTargetUpdate(
  current: {
    kind: string;
    config: Record<string, unknown>;
    access_key_id?: string | null;
    secret_access_key_encrypted?: string | null;
    generic_config_encrypted?: string | null;
    generic_credentials_encrypted?: string | null;
    local_cache_policy?: string | null;
  },
  input: BackupTargetUpdate
): Partial<BackupTargetRowInput> {
  if (current.kind === "local" && input.localCachePolicy === "remote_only") {
    throw Object.assign(
      new Error("Local backup targets always keep artifacts in the manager backup directory"),
      { statusCode: 400 }
    );
  }
  const nextConfig: Record<string, unknown> = current.kind === "local"
    ? {}
    : { ...current.config, ...(input.config ?? {}) };
  if (input.endpoint !== undefined) nextConfig.endpoint = input.endpoint;
  if (input.bucket !== undefined) nextConfig.bucket = input.bucket;
  if (input.region !== undefined) nextConfig.region = input.region;
  if (input.prefix !== undefined) nextConfig.prefix = input.prefix;
  if (input.forcePathStyle !== undefined) nextConfig.forcePathStyle = input.forcePathStyle;
  let nestedRcloneConfig: string | undefined;
  let nestedRclonePassword: string | undefined;
  let nestedProvider: RcloneProvider | undefined;
  let nestedRemotePath: string | undefined;
  if (current.kind === "rclone") {
    const nested = input.config && "provider" in input.config
      ? input.config as {
        provider?: RcloneProvider;
        remoteName?: string;
        remotePath?: string;
        rcloneConfig?: string;
        smb?: { password?: string };
      }
      : undefined;
    nestedProvider = nested?.provider;
    nestedRemotePath = nested?.remotePath;
    nestedRcloneConfig = nested?.rcloneConfig;
    nestedRclonePassword = nested?.smb?.password;
    const provider = input.provider !== undefined ? input.provider : nestedProvider;
    const remoteName = input.remoteName !== undefined ? input.remoteName : nested?.remoteName;
    const remotePath = input.remotePath !== undefined ? input.remotePath : nestedRemotePath;
    if (provider !== undefined && provider !== null) nextConfig.provider = provider;
    if (remoteName !== undefined && remoteName !== null) nextConfig.remoteName = remoteName;
    if (remotePath !== undefined && remotePath !== null) nextConfig.remotePath = remotePath;
    delete nextConfig.rcloneConfig;
    const smb = {
      ...((nextConfig.smb && typeof nextConfig.smb === "object" && !Array.isArray(nextConfig.smb)) ? nextConfig.smb as Record<string, unknown> : {})
    };
    delete smb.password;
    for (const key of ["server", "share", "subPath", "domain", "username", "port"] as const) {
      if (input[key] !== undefined) smb[key] = input[key];
    }
    if (Object.keys(smb).length) nextConfig.smb = smb;
  }

  let secret = current.secret_access_key_encrypted ?? null;
  if (input.secretAccessKey === null) secret = null;
  else if (input.secretAccessKey) secret = encryptSecret(input.secretAccessKey);

  let genericConfig = current.generic_config_encrypted ?? null;
  const rcloneConfigUpdate = input.rcloneConfig !== undefined
    ? input.rcloneConfig
    : nestedRcloneConfig;
  if (rcloneConfigUpdate === null) genericConfig = null;
  else if (rcloneConfigUpdate) genericConfig = encryptSecret(rcloneConfigUpdate);

  let genericCredentials = current.generic_credentials_encrypted ?? null;
  const passwordUpdate = input.password !== undefined
    ? input.password
    : nestedRclonePassword;
  if (passwordUpdate === null) genericCredentials = null;
  else if (passwordUpdate) genericCredentials = encryptSecret(JSON.stringify({ password: passwordUpdate }));

  const result: Partial<BackupTargetRowInput> = {
    name: input.name,
    enabled: input.enabled,
    config: current.kind === "local" ? {} : Object.keys(nextConfig).length ? nextConfig : undefined,
    accessKeyId: input.accessKeyId === undefined ? undefined : input.accessKeyId,
    provider: input.provider === undefined ? nestedProvider : input.provider,
    remotePath: input.remotePath === undefined ? nestedRemotePath : input.remotePath,
    localCachePolicy: current.kind === "local"
      ? "keep"
      : input.localCachePolicy ?? current.local_cache_policy as LocalCachePolicy ?? undefined
  };
  if (input.secretAccessKey !== undefined) result.secretAccessKeyEncrypted = secret;
  if (rcloneConfigUpdate !== undefined) result.genericConfigEncrypted = genericConfig;
  if (passwordUpdate !== undefined) result.genericCredentialsEncrypted = genericCredentials;
  return result;
}

export function mapBackupTargetFields(row: {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  access_key_id?: string | null;
  secret_access_key_encrypted?: string | null;
  provider?: string | null;
  remote_path?: string | null;
  local_cache_policy?: string | null;
  generic_config_encrypted?: string | null;
  generic_credentials_encrypted?: string | null;
  health_status?: string | null;
  health_checked_at?: Date | string | null;
  health_error?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): BackupTarget {
  const storedConfig = row.config ?? {};
  const isLocal = row.kind === "local";
  const isS3 = row.kind === "s3";
  const isRclone = row.kind === "rclone";
  const parsedEndpoint = isS3 ? s3EndpointSchema.safeParse(storedConfig.endpoint) : null;
  const config = isLocal
    ? {}
    : isS3 && Object.prototype.hasOwnProperty.call(storedConfig, "endpoint")
      ? { ...storedConfig, endpoint: parsedEndpoint?.success ? parsedEndpoint.data : null }
      : storedConfig;
  const s3Config = isS3 ? config : {};
  return {
    id: row.id,
    name: row.name,
    type: row.kind as BackupTarget["type"],
    kind: row.kind as BackupTarget["kind"],
    enabled: row.enabled,
    config,
    endpoint: isS3 ? String(s3Config.endpoint ?? "") || null : null,
    region: isS3 ? (s3Config.region ? String(s3Config.region) : null) : null,
    bucket: isS3 ? String(s3Config.bucket ?? "") || null : null,
    prefix: isS3 ? (s3Config.prefix ? String(s3Config.prefix) : null) : null,
    forcePathStyle: isS3 ? Boolean(s3Config.forcePathStyle ?? s3Config.pathStyle) : false,
    basePath: null,
    provider: isRclone ? row.provider as BackupTarget["provider"] ?? config.provider as BackupTarget["provider"] ?? null : null,
    rcloneProvider: isRclone ? row.provider as BackupTarget["rcloneProvider"] ?? config.provider as BackupTarget["rcloneProvider"] ?? null : null,
    remotePath: isRclone ? row.remote_path ?? (config.remotePath ? String(config.remotePath) : null) : null,
    remoteName: isRclone && config.remoteName ? String(config.remoteName) : null,
    localCachePolicy: (isLocal ? "keep" : row.local_cache_policy === "remote_only" ? "remote_only" : "keep") as BackupTarget["localCachePolicy"],
    healthStatus: (row.health_status ?? "unknown") as BackupTarget["healthStatus"],
    healthCheckedAt: row.health_checked_at ? new Date(row.health_checked_at).toISOString() : null,
    healthError: row.health_error ?? null,
    hasCredentials: Boolean(row.access_key_id || row.secret_access_key_encrypted || row.generic_credentials_encrypted || row.generic_config_encrypted),
    hasSecretAccessKey: Boolean(row.secret_access_key_encrypted),
    hasGenericConfig: Boolean(row.generic_config_encrypted),
    hasGenericCredentials: Boolean(row.generic_credentials_encrypted),
    accessKeyId: row.access_key_id ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export function getS3TargetForWorker(row: {
  config?: Record<string, unknown> | null;
  access_key_id?: string | null;
  secret_access_key_encrypted?: string | null;
}) {
  if (!row.access_key_id || !row.secret_access_key_encrypted) {
    throw new Error("S3 backup target is missing credentials");
  }
  return {
    config: parseS3Config(row.config ?? {}),
    credentials: {
      accessKeyId: row.access_key_id,
      secretAccessKey: decryptSecret(row.secret_access_key_encrypted)
    }
  };
}

export async function assertBackupTargetS3EndpointAllowed(
  target: { kind: string; config?: Record<string, unknown> | null },
  blockPrivateEndpoints = env.BLOCK_PRIVATE_S3_ENDPOINTS,
  resolve?: LookupAll
) {
  if (target.kind !== "s3" || !blockPrivateEndpoints) return;
  const config = parseS3Config(target.config ?? {});
  if (!await validateS3Endpoint(config.endpoint, true, resolve)) {
    throw new Error("S3 backup target endpoint resolves to a private network address, which is blocked when BLOCK_PRIVATE_S3_ENDPOINTS=true.");
  }
}

export function toWorkerBackupTarget(row: {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  access_key_id?: string | null;
  secret_access_key_encrypted?: string | null;
  provider?: string | null;
  remote_path?: string | null;
  local_cache_policy?: string | null;
  generic_config_encrypted?: string | null;
  generic_credentials_encrypted?: string | null;
}): WorkerBackupTarget {
  const isLocal = row.kind === "local";
  const target: WorkerBackupTarget = {
    id: row.id,
    name: row.name,
    kind: row.kind as "local" | "s3" | "rclone",
    enabled: row.enabled,
    config: isLocal ? {} : row.config ?? {},
    localCachePolicy: isLocal ? "keep" : row.local_cache_policy === "remote_only" ? "remote_only" : "keep"
  };
  if (row.kind === "s3") {
    target.s3 = getS3TargetForWorker(row);
  }
  if (row.kind === "rclone") {
    let credentials: Record<string, unknown> = {};
    if (row.generic_credentials_encrypted) {
      credentials = JSON.parse(decryptSecret(row.generic_credentials_encrypted)) as Record<string, unknown>;
    }
    target.rclone = {
      provider: (row.provider ?? row.config?.provider ?? "custom") as RcloneProvider,
      remoteName: String(row.config?.remoteName ?? "composebastion"),
      remotePath: String(row.remote_path ?? row.config?.remotePath ?? ""),
      configText: row.generic_config_encrypted ? decryptSecret(row.generic_config_encrypted) : null,
      credentials
    };
  }
  return target;
}

export async function loadWorkerBackupTarget(id: string) {
  const result = await query<any>("SELECT * FROM backup_targets WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) throw new Error("Backup target not found");
  return toWorkerBackupTarget(row);
}

export function exportBackupTargetSecrets(row: {
  kind: string;
  config?: Record<string, unknown> | null;
  access_key_id?: string | null;
  secret_access_key_encrypted?: string | null;
  provider?: string | null;
  remote_path?: string | null;
  local_cache_policy?: string | null;
  generic_config_encrypted?: string | null;
  generic_credentials_encrypted?: string | null;
}) {
  const isLocal = row.kind === "local";
  return {
    kind: row.kind,
    config: isLocal ? {} : row.config ?? {},
    accessKeyId: isLocal ? null : row.access_key_id ?? null,
    secretAccessKey: isLocal ? null : row.secret_access_key_encrypted ? decryptSecret(row.secret_access_key_encrypted) : null,
    provider: isLocal ? null : row.provider ?? null,
    remotePath: isLocal ? null : row.remote_path ?? null,
    localCachePolicy: isLocal ? "keep" : row.local_cache_policy ?? "keep",
    rcloneConfig: isLocal ? null : row.generic_config_encrypted ? decryptSecret(row.generic_config_encrypted) : null,
    rcloneCredentials: isLocal ? null : row.generic_credentials_encrypted ? JSON.parse(decryptSecret(row.generic_credentials_encrypted)) : null
  };
}

export type WorkerBackupTarget = {
  id: string;
  name: string;
  kind: "local" | "s3" | "rclone";
  enabled: boolean;
  config: Record<string, unknown>;
  localCachePolicy: LocalCachePolicy;
  s3?: {
    config: S3TargetConfig;
    credentials: S3TargetCredentials;
  };
  rclone?: {
    provider: RcloneProvider;
    remoteName: string;
    remotePath: string;
    configText: string | null;
    credentials: Record<string, unknown>;
  };
};
