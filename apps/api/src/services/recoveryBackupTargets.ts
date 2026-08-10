import {
  rcloneRemoteNameIssue,
  sanitizeUrlDiagnosticText,
  s3EndpointSchema,
  smbShareIssue,
  smbSubPathIssue,
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

function invalidBackupTarget(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function requireSafeRcloneRemoteName(value: unknown) {
  if (typeof value !== "string") {
    throw invalidBackupTarget("Rclone remote name must be a string");
  }
  const issue = rcloneRemoteNameIssue(value);
  if (issue) throw invalidBackupTarget(issue);
  return value;
}

function requireSafeSmbShare(value: unknown) {
  if (typeof value !== "string") {
    throw invalidBackupTarget("SMB share must be a string");
  }
  const issue = smbShareIssue(value);
  if (issue) throw invalidBackupTarget(issue);
  return value;
}

function requireSafeSmbSubPath(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw invalidBackupTarget("SMB subpath must be a string");
  }
  const issue = smbSubPathIssue(value);
  if (issue) throw invalidBackupTarget(issue);
  return value;
}

function buildSmbRemotePath(share: string, subPath: string | null) {
  return subPath ? `${share}/${subPath}` : share;
}

function own(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function publicBackupTargetConfig(kind: string, input: Record<string, unknown> | null | undefined) {
  const source = input ?? {};
  if (kind === "s3") {
    const config: Record<string, unknown> = {};
    for (const key of ["endpoint", "bucket", "region", "prefix", "pathStyle", "forcePathStyle"]) {
      if (own(source, key)) config[key] = source[key];
    }
    return config;
  }
  if (kind === "rclone") {
    const config: Record<string, unknown> = {};
    for (const key of ["provider", "remoteName", "remotePath"]) {
      if (own(source, key)) config[key] = source[key];
    }
    if (source.smb && typeof source.smb === "object" && !Array.isArray(source.smb)) {
      const sourceSmb = source.smb as Record<string, unknown>;
      const smb: Record<string, unknown> = {};
      for (const key of ["server", "share", "subPath", "domain", "username", "port"]) {
        if (own(sourceSmb, key)) smb[key] = sourceSmb[key];
      }
      config.smb = smb;
    }
    return config;
  }
  return {};
}

function rejectIncompatibleBackupTargetFields(
  kind: string,
  input: BackupTargetUpdate
) {
  const incompatibleTopLevel = kind === "s3"
    ? [
        "provider", "remotePath", "remoteName", "rcloneConfig",
        "server", "share", "subPath", "domain", "username", "password", "port"
      ]
    : kind === "rclone"
      ? ["endpoint", "bucket", "region", "prefix", "forcePathStyle", "accessKeyId", "secretAccessKey"]
      : [
          "endpoint", "bucket", "region", "prefix", "forcePathStyle", "accessKeyId", "secretAccessKey",
          "provider", "remotePath", "remoteName", "rcloneConfig",
          "server", "share", "subPath", "domain", "username", "password", "port"
        ];
  const suppliedTopLevel = incompatibleTopLevel.find((key) => own(input, key));
  if (suppliedTopLevel) {
    throw Object.assign(
      new Error(`${suppliedTopLevel} is not valid for ${kind} backup targets`),
      { statusCode: 400 }
    );
  }

  const config = input.config ?? {};
  const incompatibleConfig = kind === "s3"
    ? ["provider", "remoteName", "remotePath", "rcloneConfig", "smb"]
    : kind === "rclone"
      ? ["endpoint", "bucket", "region", "prefix", "pathStyle", "forcePathStyle"]
      : Object.keys(config);
  const suppliedConfig = incompatibleConfig.find((key) => own(config, key));
  if (suppliedConfig) {
    throw Object.assign(
      new Error(`config.${suppliedConfig} is not valid for ${kind} backup targets`),
      { statusCode: 400 }
    );
  }
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
  const provider = input.provider;
  const remoteName = requireSafeRcloneRemoteName(
    emptyToNull(input.remoteName)
      ?? (provider === "smb" ? null : parseFirstRcloneRemote(input.rcloneConfig))
      ?? "composebastion"
  );
  let subPath = emptyToNull(input.subPath);
  let share = emptyToNull(input.share);
  let remotePath = emptyToNull(input.remotePath) ?? "composebastion";
  const config: Record<string, unknown> = { provider, remoteName, remotePath };
  if (provider === "smb") {
    const server = emptyToNull(input.server);
    if (!server) throw invalidBackupTarget("SMB server is required");
    if (!share) throw invalidBackupTarget("SMB share is required");
    share = requireSafeSmbShare(share);
    subPath = requireSafeSmbSubPath(subPath);
    remotePath = buildSmbRemotePath(share, subPath);
    config.remotePath = remotePath;
    config.smb = {
      server,
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
    if (
      rclone.provider
      && rclone.config?.provider
      && rclone.provider !== rclone.config.provider
    ) {
      throw invalidBackupTarget("Rclone provider must match config.provider");
    }
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
      genericConfigEncrypted: provider === "smb" || !rcloneConfig ? null : encryptSecret(rcloneConfig),
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
    provider?: string | null;
    remote_path?: string | null;
    generic_config_encrypted?: string | null;
    generic_credentials_encrypted?: string | null;
    local_cache_policy?: string | null;
  },
  input: BackupTargetUpdate
): Partial<BackupTargetRowInput> {
  rejectIncompatibleBackupTargetFields(current.kind, input);
  if (current.kind === "local" && input.localCachePolicy === "remote_only") {
    throw Object.assign(
      new Error("Local backup targets always keep artifacts in the manager backup directory"),
      { statusCode: 400 }
    );
  }
  const nextConfig: Record<string, unknown> = {
    ...publicBackupTargetConfig(current.kind, current.config),
    ...publicBackupTargetConfig(current.kind, input.config)
  };
  if (input.endpoint !== undefined) nextConfig.endpoint = input.endpoint;
  if (input.bucket !== undefined) nextConfig.bucket = input.bucket;
  if (input.region !== undefined) nextConfig.region = input.region;
  if (input.prefix !== undefined) nextConfig.prefix = input.prefix;
  if (input.forcePathStyle !== undefined) nextConfig.forcePathStyle = input.forcePathStyle;

  let nextProvider: RcloneProvider | undefined;
  let nextRemotePath: string | undefined;
  let genericConfig = current.generic_config_encrypted ?? null;
  let genericCredentials = current.generic_credentials_encrypted ?? null;
  if (current.kind === "rclone") {
    const nested = input.config && "provider" in input.config
      ? input.config as {
        provider?: RcloneProvider | null;
        remoteName?: string | null;
        remotePath?: string | null;
        rcloneConfig?: string | null;
        smb?: RcloneSmbInput;
      }
      : undefined;

    const currentProvider = (
      current.provider
      ?? (typeof current.config.provider === "string" ? current.config.provider : null)
    ) as RcloneProvider | null;
    const requestedProvider = input.provider !== undefined
      ? input.provider
      : nested?.provider;
    if (
      input.provider !== undefined
      && nested?.provider !== undefined
      && input.provider !== nested.provider
    ) {
      throw invalidBackupTarget("Rclone provider must match config.provider");
    }
    if (requestedProvider === null) {
      throw Object.assign(new Error("rclone backup targets require a provider"), { statusCode: 400 });
    }
    const provider = requestedProvider ?? currentProvider;
    if (!provider) {
      throw Object.assign(new Error("rclone backup targets require a provider"), { statusCode: 400 });
    }
    const providerChanged = provider !== currentProvider;
    const currentSmb = currentProvider === "smb"
      && current.config.smb
      && typeof current.config.smb === "object"
      && !Array.isArray(current.config.smb)
      ? current.config.smb as Record<string, unknown>
      : {};
    const nestedSmb = nested?.smb ?? {};
    const smbValueWasProvided = (key: keyof RcloneSmbInput) =>
      input[key] !== undefined || Object.prototype.hasOwnProperty.call(nestedSmb, key);
    const smbValue = (key: keyof RcloneSmbInput) => {
      if (input[key] !== undefined) return input[key];
      if (Object.prototype.hasOwnProperty.call(nestedSmb, key)) return nestedSmb[key];
      return providerChanged ? undefined : currentSmb[key];
    };
    const hasRcloneConfigUpdate = input.rcloneConfig !== undefined
      || nested?.rcloneConfig !== undefined;
    const rcloneConfigUpdate = input.rcloneConfig !== undefined
      ? input.rcloneConfig
      : nested?.rcloneConfig;
    const hasPasswordUpdate = input.password !== undefined
      || nestedSmb.password !== undefined;
    const passwordUpdate = input.password !== undefined
      ? input.password
      : nestedSmb.password;
    const requestedRemoteName = input.remoteName !== undefined
      ? input.remoteName
      : nested?.remoteName;
    const requestedRemotePath = input.remotePath !== undefined
      ? input.remotePath
      : nested?.remotePath;

    if (provider === "smb") {
      const server = emptyToNull(smbValue("server"));
      let share = emptyToNull(smbValue("share"));
      if (!server) {
        throw invalidBackupTarget("SMB server is required");
      }
      if (!share) {
        throw invalidBackupTarget("SMB share is required");
      }
      share = requireSafeSmbShare(share);
      const subPath = requireSafeSmbSubPath(emptyToNull(smbValue("subPath")));
      const rawPort = smbValue("port");
      const port = rawPort === null || rawPort === undefined || rawPort === ""
        ? null
        : Number(rawPort);
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw invalidBackupTarget("SMB port must be between 1 and 65535");
      }
      const remoteName = requireSafeRcloneRemoteName(
        emptyToNull(requestedRemoteName)
          ?? (providerChanged ? null : emptyToNull(current.config.remoteName))
          ?? "composebastion"
      );
      // SMB's object path is defined by the share and optional subpath. Never
      // retain or accept an independent hidden remotePath that can diverge.
      nextRemotePath = buildSmbRemotePath(share, subPath);
      nextConfig.provider = provider;
      nextConfig.remoteName = remoteName;
      nextConfig.remotePath = nextRemotePath;
      const smbConfig: Record<string, unknown> = {
        server,
        share
      };
      const domain = emptyToNull(smbValue("domain"));
      const username = emptyToNull(smbValue("username"));
      const retainSmbFieldShape = (key: keyof RcloneSmbInput) =>
        !providerChanged && Object.prototype.hasOwnProperty.call(currentSmb, key);
      if (subPath !== null || smbValueWasProvided("subPath") || retainSmbFieldShape("subPath")) {
        smbConfig.subPath = subPath;
      }
      if (domain !== null || smbValueWasProvided("domain") || retainSmbFieldShape("domain")) {
        smbConfig.domain = domain;
      }
      if (username !== null || smbValueWasProvided("username") || retainSmbFieldShape("username")) {
        smbConfig.username = username;
      }
      if (port !== null || smbValueWasProvided("port") || retainSmbFieldShape("port")) {
        smbConfig.port = port;
      }
      nextConfig.smb = smbConfig;
      for (const key of Object.keys(nextConfig)) {
        if (!["provider", "remoteName", "remotePath", "smb"].includes(key)) delete nextConfig[key];
      }

      // Imported rclone config is incompatible with the supported SMB builder.
      genericConfig = null;
      if (hasPasswordUpdate) {
        genericCredentials = passwordUpdate === null
          ? null
          : encryptSecret(JSON.stringify({ password: passwordUpdate ?? "" }));
      } else if (providerChanged) {
        genericCredentials = null;
      }
    } else {
      if (providerChanged && (typeof rcloneConfigUpdate !== "string" || !rcloneConfigUpdate.trim())) {
        throw Object.assign(
          new Error("A new imported rclone config is required when changing providers"),
          { statusCode: 400 }
        );
      }
      if (hasRcloneConfigUpdate) {
        if (typeof rcloneConfigUpdate !== "string" || !rcloneConfigUpdate.trim()) {
          throw Object.assign(
            new Error("Imported rclone providers require a non-empty rclone config"),
            { statusCode: 400 }
          );
        }
        genericConfig = encryptSecret(rcloneConfigUpdate);
      }
      const remoteName = requireSafeRcloneRemoteName(
        emptyToNull(requestedRemoteName)
          ?? (providerChanged ? parseFirstRcloneRemote(rcloneConfigUpdate) : emptyToNull(current.config.remoteName))
          ?? parseFirstRcloneRemote(rcloneConfigUpdate)
          ?? "composebastion"
      );
      nextRemotePath = emptyToNull(requestedRemotePath)
        ?? (providerChanged ? null : emptyToNull(current.remote_path ?? current.config.remotePath))
        ?? "composebastion";
      nextConfig.provider = provider;
      nextConfig.remoteName = remoteName;
      nextConfig.remotePath = nextRemotePath;
      for (const key of Object.keys(nextConfig)) {
        if (!["provider", "remoteName", "remotePath"].includes(key)) delete nextConfig[key];
      }
      // SMB passwords and provider-specific public settings cannot remain
      // dormant when an imported provider becomes active.
      genericCredentials = null;
    }

    nextProvider = provider;
  }

  let secret = current.secret_access_key_encrypted ?? null;
  if (input.secretAccessKey === null) secret = null;
  else if (input.secretAccessKey) secret = encryptSecret(input.secretAccessKey);

  const result: Partial<BackupTargetRowInput> = {
    name: input.name,
    enabled: input.enabled,
    config: current.kind === "local" ? {} : Object.keys(nextConfig).length ? nextConfig : undefined,
    accessKeyId: input.accessKeyId === undefined ? undefined : input.accessKeyId,
    provider: current.kind === "rclone" ? nextProvider : undefined,
    remotePath: current.kind === "rclone" ? nextRemotePath : undefined,
    localCachePolicy: current.kind === "local"
      ? "keep"
      : input.localCachePolicy ?? current.local_cache_policy as LocalCachePolicy ?? undefined
  };
  if (input.secretAccessKey !== undefined) result.secretAccessKeyEncrypted = secret;
  if (current.kind === "rclone") {
    result.genericConfigEncrypted = genericConfig;
    result.genericCredentialsEncrypted = genericCredentials;
  }
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
  const storedConfig = publicBackupTargetConfig(row.kind, row.config);
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
    healthError: sanitizeUrlDiagnosticText(row.health_error ?? null) as string | null,
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
    config: publicBackupTargetConfig(row.kind, row.config),
    localCachePolicy: isLocal ? "keep" : row.local_cache_policy === "remote_only" ? "remote_only" : "keep"
  };
  if (row.kind === "s3") {
    target.s3 = getS3TargetForWorker(row);
  }
  if (row.kind === "rclone") {
    if (
      row.provider
      && typeof row.config?.provider === "string"
      && row.provider !== row.config.provider
    ) {
      throw invalidBackupTarget("Stored rclone provider does not match config.provider");
    }
    const provider = (row.provider ?? row.config?.provider ?? "custom") as RcloneProvider;
    const remoteName = requireSafeRcloneRemoteName(row.config?.remoteName ?? "composebastion");
    let remotePath = String(row.remote_path ?? row.config?.remotePath ?? "");
    let configText: string | null = null;
    if (provider === "smb") {
      if (row.generic_config_encrypted) {
        throw invalidBackupTarget("SMB targets do not accept imported rclone config");
      }
      const smb = target.config.smb && typeof target.config.smb === "object" && !Array.isArray(target.config.smb)
        ? target.config.smb as Record<string, unknown>
        : null;
      if (!smb) throw invalidBackupTarget("SMB target is missing its connection settings");
      if (!emptyToNull(smb.server)) throw invalidBackupTarget("SMB server is required");
      const share = requireSafeSmbShare(smb.share);
      let subPath = requireSafeSmbSubPath(smb.subPath);
      const storedRemotePaths = [row.remote_path, target.config.remotePath]
        .filter((value) => value !== null && value !== undefined);
      if (storedRemotePaths.some((value) => typeof value !== "string")) {
        throw invalidBackupTarget("SMB target path must be a string");
      }
      const distinctRemotePaths = new Set(storedRemotePaths as string[]);
      if (distinctRemotePaths.size > 1) {
        throw invalidBackupTarget("SMB target has conflicting stored paths");
      }
      const storedRemotePath = distinctRemotePaths.values().next().value as string | undefined;
      if (!subPath && storedRemotePath && storedRemotePath !== share) {
        const sharePrefix = `${share}/`;
        if (!storedRemotePath.startsWith(sharePrefix)) {
          throw invalidBackupTarget("SMB target path does not match its configured share and subpath");
        }
        subPath = requireSafeSmbSubPath(storedRemotePath.slice(sharePrefix.length));
        if (subPath) smb.subPath = subPath;
      }
      const expectedRemotePath = buildSmbRemotePath(share, subPath);
      for (const persistedRemotePath of storedRemotePaths) {
        if (
          typeof persistedRemotePath !== "string"
          || persistedRemotePath !== expectedRemotePath
        ) {
          throw invalidBackupTarget("SMB target path does not match its configured share and subpath");
        }
      }
      remotePath = expectedRemotePath;
      configText = null;
    } else if (row.generic_config_encrypted) {
      configText = decryptSecret(row.generic_config_encrypted);
    }
    let credentials: Record<string, unknown> = {};
    if (row.generic_credentials_encrypted) {
      credentials = JSON.parse(decryptSecret(row.generic_credentials_encrypted)) as Record<string, unknown>;
    }
    target.rclone = {
      provider,
      remoteName,
      remotePath,
      configText,
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
    config: publicBackupTargetConfig(row.kind, row.config),
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
