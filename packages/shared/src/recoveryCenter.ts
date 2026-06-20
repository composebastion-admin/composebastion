import { z } from "zod";

const idSchema = z.string().uuid();

export const backupTargetKindSchema = z.enum(["local", "s3", "rclone"]);
export const rcloneProviderSchema = z.enum(["smb", "drive", "onedrive", "iclouddrive", "webdav", "sftp", "custom"]);
export const localCachePolicySchema = z.enum(["keep", "remote_only"]);
export const backupTargetHealthStatusSchema = z.enum(["unknown", "healthy", "failed"]);
export const recoveryPointStatusSchema = z.enum(["queued", "running", "completed", "partial", "failed"]);
export const recoveryArtifactStatusSchema = recoveryPointStatusSchema;
export const recoveryTriggerKindSchema = z.enum(["manual", "scheduled", "pre_migration", "policy"]);
export const recoveryArtifactKindSchema = z.enum([
  "volume",
  "compose_yaml",
  "env_file",
  "image_manifest",
  "host_folder",
  "metadata",
  "config_export"
]);
export const migrationModeSchema = z.enum(["plan", "execute"]);
export const migrationRunStatusSchema = recoveryPointStatusSchema;
export const recoveryCaptureModeSchema = z.enum(["hot", "stop_first"]);
export const recoveryNetworkModeSchema = z.enum(["clone", "reuse"]);

export const recoveryAppIdentitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stack"),
    stackId: idSchema,
    projectName: z.string().min(1).max(80).optional(),
    label: z.string().max(120).optional()
  }),
  z.object({
    kind: z.literal("compose"),
    projectName: z.string().min(1).max(80),
    stackId: idSchema.optional(),
    label: z.string().max(120).optional()
  }),
  z.object({
    kind: z.literal("git"),
    repositoryId: idSchema,
    projectName: z.string().min(1).max(80).optional(),
    label: z.string().max(120).optional()
  }),
  z.object({
    kind: z.literal("standalone"),
    containerIds: z.array(z.string().min(1)).min(1),
    label: z.string().max(120).optional()
  })
]);

const backupTargetLocalConfigSchema = z.object({
  basePath: z.string().min(1).max(1024).optional()
});

const backupTargetS3ConfigSchema = z.object({
  endpoint: z.string().url(),
  bucket: z.string().min(1).max(255),
  region: z.string().max(64).optional(),
  prefix: z.string().max(512).optional(),
  pathStyle: z.boolean().default(false),
  forcePathStyle: z.boolean().default(false).optional()
});

const backupTargetRcloneSmbConfigSchema = z.object({
  server: z.string().min(1).max(255),
  share: z.string().min(1).max(255),
  subPath: z.string().max(512).optional(),
  domain: z.string().max(255).optional(),
  username: z.string().max(255).optional(),
  password: z.string().optional(),
  port: z.coerce.number().int().min(1).max(65535).optional()
});

const backupTargetRcloneConfigSchema = z.object({
  provider: rcloneProviderSchema,
  remotePath: z.string().min(1).max(1024).optional(),
  remoteName: z.string().min(1).max(120).optional(),
  rcloneConfig: z.string().min(1).optional(),
  smb: backupTargetRcloneSmbConfigSchema.optional()
});

const backupTargetSharedFieldsSchema = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  localCachePolicy: localCachePolicySchema.default("keep")
});

export const backupTargetCreateSchema = z.union([
  backupTargetSharedFieldsSchema.extend({
    type: z.literal("local"),
    kind: z.literal("local").optional(),
    basePath: z.string().min(1).max(1024).optional(),
    config: backupTargetLocalConfigSchema.optional()
  }),
  backupTargetSharedFieldsSchema.extend({
    type: z.literal("s3"),
    kind: z.literal("s3").optional(),
    endpoint: z.string().url(),
    bucket: z.string().min(1).max(255),
    region: z.string().max(64).optional(),
    prefix: z.string().max(512).optional(),
    forcePathStyle: z.boolean().default(false),
    accessKeyId: z.string().min(1).max(255),
    secretAccessKey: z.string().min(1),
    config: backupTargetS3ConfigSchema.optional()
  }),
  backupTargetSharedFieldsSchema.extend({
    type: z.literal("rclone"),
    kind: z.literal("rclone").optional(),
    provider: rcloneProviderSchema,
    remotePath: z.string().min(1).max(1024).optional(),
    remoteName: z.string().min(1).max(120).optional(),
    rcloneConfig: z.string().min(1).optional(),
    server: z.string().min(1).max(255).optional(),
    share: z.string().min(1).max(255).optional(),
    subPath: z.string().max(512).optional(),
    domain: z.string().max(255).optional(),
    username: z.string().max(255).optional(),
    password: z.string().optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
    config: backupTargetRcloneConfigSchema.optional()
  }).superRefine((value, ctx) => {
    const provider = value.provider;
    if (provider === "smb") {
      const server = value.server ?? value.config?.smb?.server;
      const share = value.share ?? value.config?.smb?.share;
      if (!server) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SMB server is required", path: ["server"] });
      if (!share) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SMB share is required", path: ["share"] });
      return;
    }
    if (!value.rcloneConfig && !value.config?.rcloneConfig) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Imported rclone config is required for cloud beta targets", path: ["rcloneConfig"] });
    }
  }),
  backupTargetSharedFieldsSchema.extend({
    kind: z.literal("local"),
    config: backupTargetLocalConfigSchema.default({})
  }),
  backupTargetSharedFieldsSchema.extend({
    kind: z.literal("s3"),
    config: backupTargetS3ConfigSchema,
    accessKeyId: z.string().min(1).max(255).optional(),
    secretAccessKey: z.string().min(1).optional()
  }).superRefine((value, ctx) => {
    if (!value.accessKeyId || !value.secretAccessKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "S3 targets require accessKeyId and secretAccessKey", path: ["accessKeyId"] });
    }
  }),
  backupTargetSharedFieldsSchema.extend({
    kind: z.literal("rclone"),
    config: backupTargetRcloneConfigSchema,
    provider: rcloneProviderSchema.optional(),
    remotePath: z.string().min(1).max(1024).optional(),
    rcloneConfig: z.string().min(1).optional()
  }).superRefine((value, ctx) => {
    const provider = value.provider ?? value.config.provider;
    if (provider !== "smb" && !value.rcloneConfig && !value.config.rcloneConfig) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Imported rclone config is required for cloud beta targets", path: ["rcloneConfig"] });
    }
  })
]);

export const backupTargetUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  endpoint: z.string().url().optional(),
  bucket: z.string().min(1).max(255).optional(),
  region: z.string().max(64).nullable().optional(),
  prefix: z.string().max(512).nullable().optional(),
  forcePathStyle: z.boolean().optional(),
  basePath: z.string().min(1).max(1024).nullable().optional(),
  config: z.union([backupTargetLocalConfigSchema, backupTargetS3ConfigSchema, backupTargetRcloneConfigSchema]).optional(),
  accessKeyId: z.string().min(1).max(255).nullable().optional(),
  secretAccessKey: z.string().min(1).nullable().optional()
}).extend({
  provider: rcloneProviderSchema.nullable().optional(),
  remotePath: z.string().min(1).max(1024).nullable().optional(),
  remoteName: z.string().min(1).max(120).nullable().optional(),
  rcloneConfig: z.string().min(1).nullable().optional(),
  localCachePolicy: localCachePolicySchema.optional(),
  server: z.string().min(1).max(255).nullable().optional(),
  share: z.string().min(1).max(255).nullable().optional(),
  subPath: z.string().max(512).nullable().optional(),
  domain: z.string().max(255).nullable().optional(),
  username: z.string().max(255).nullable().optional(),
  password: z.string().nullable().optional(),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional()
});

export const backupTargetSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: backupTargetKindSchema,
  kind: backupTargetKindSchema,
  enabled: z.boolean(),
  config: z.record(z.unknown()),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  prefix: z.string().nullable(),
  forcePathStyle: z.boolean(),
  basePath: z.string().nullable(),
  provider: rcloneProviderSchema.nullable(),
  rcloneProvider: rcloneProviderSchema.nullable(),
  remotePath: z.string().nullable(),
  remoteName: z.string().nullable(),
  localCachePolicy: localCachePolicySchema,
  healthStatus: backupTargetHealthStatusSchema,
  healthCheckedAt: z.string().nullable(),
  healthError: z.string().nullable(),
  hasCredentials: z.boolean(),
  hasSecretAccessKey: z.boolean(),
  hasGenericConfig: z.boolean(),
  hasGenericCredentials: z.boolean(),
  accessKeyId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const recoveryArtifactSchema = z.object({
  id: idSchema,
  recoveryPointId: idSchema,
  kind: recoveryArtifactKindSchema,
  backupTargetId: idSchema.nullable(),
  storageKey: z.string(),
  sizeBytes: z.number().nullable(),
  checksum: z.string().nullable(),
  status: recoveryArtifactStatusSchema,
  error: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  completedAt: z.string().nullable()
});

export const recoveryPointCreateSchema = z.object({
  hostId: idSchema,
  name: z.string().min(1).max(120).optional(),
  appIdentity: recoveryAppIdentitySchema,
  backupTargetId: idSchema.optional(),
  profileId: idSchema.optional(),
  extraIncludePaths: z.array(z.string().min(1).max(1024)).default([]),
  captureMode: recoveryCaptureModeSchema.default("hot"),
  triggerKind: recoveryTriggerKindSchema.default("manual"),
  stopFirst: z.boolean().default(false)
});

export const recoveryPointListItemSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  name: z.string().nullable(),
  appIdentity: recoveryAppIdentitySchema,
  triggerKind: recoveryTriggerKindSchema,
  status: recoveryPointStatusSchema,
  backupTargetId: idSchema.nullable(),
  legacyVolumeBackupId: idSchema.nullable(),
  profileId: idSchema.nullable().optional(),
  artifactCount: z.number().int().nonnegative(),
  completedArtifactCount: z.number().int().nonnegative(),
  totalBytes: z.number().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.unknown()),
  lastDrillAt: z.string().nullable(),
  lastDrillStatus: z.string().nullable(),
  lastDrillError: z.string().nullable(),
  lastSuccessfulDrillAt: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
});

export const recoveryPointDetailSchema = recoveryPointListItemSchema.extend({
  artifacts: z.array(recoveryArtifactSchema)
});

export const recoveryAppKindSchema = z.enum(["stack", "compose", "git", "standalone"]);

export const recoveryPointListQuerySchema = z.object({
  hostId: idSchema.optional(),
  status: recoveryPointStatusSchema.optional(),
  appKind: recoveryAppKindSchema.optional()
});

export const recoveryRestoreModeSchema = z.enum(["clone", "in_place"]);

export const recoveryRestoreRequestSchema = z.object({
  recoveryPointId: idSchema,
  targetHostId: idSchema,
  options: z.object({
    mode: recoveryRestoreModeSchema.default("clone"),
    stopExisting: z.boolean().default(false),
    projectNameOverride: z.string().min(1).max(80).optional(),
    volumePrefix: z.string().min(1).max(80).optional(),
    restoreRoot: z.string().min(1).max(1024).optional(),
    remapPorts: z.boolean().default(true),
    networkMode: recoveryNetworkModeSchema.default("clone")
  }).default({})
});

export const recoveryProfileInputSchema = z.object({
  hostId: idSchema,
  appIdentity: recoveryAppIdentitySchema,
  name: z.string().min(1).max(80).optional(),
  includePaths: z.array(z.string().min(1).max(1024)).default([]),
  excludePatterns: z.array(z.string().min(1).max(512)).default([]),
  restorePaths: z.record(z.string()).default({}),
  preCaptureCommand: z.string().max(4000).nullable().optional(),
  postCaptureCommand: z.string().max(4000).nullable().optional(),
  captureMode: recoveryCaptureModeSchema.default("hot")
});

export const recoveryProfileSchema = recoveryProfileInputSchema.extend({
  id: idSchema,
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const recoveryAnalysisRequestSchema = z.object({
  hostId: idSchema,
  appIdentity: recoveryAppIdentitySchema,
  profileId: idSchema.optional()
});

export const recoveryDataMountSchema = z.object({
  type: z.enum(["volume", "bind", "tmpfs", "compose_working_dir", "manual"]),
  containerName: z.string().nullable(),
  source: z.string().nullable(),
  name: z.string().nullable(),
  destination: z.string(),
  readOnly: z.boolean(),
  included: z.boolean(),
  warning: z.string().nullable()
});

export const recoveryAnalysisSchema = z.object({
  hostId: idSchema,
  appIdentity: recoveryAppIdentitySchema,
  profile: recoveryProfileSchema.nullable(),
  status: z.enum(["ready", "warning", "blocked"]),
  recommendedCaptureMode: recoveryCaptureModeSchema,
  dataMounts: z.array(recoveryDataMountSchema),
  volumes: z.array(z.string()),
  bindMounts: z.array(z.string()),
  warnings: z.array(z.string()),
  blockingIssues: z.array(z.string())
});

export const recoveryReadinessStatusSchema = z.enum(["ready", "needs_profile", "risky", "blocked"]);
export const recoveryReadinessSeveritySchema = z.enum(["info", "warning", "critical"]);

export const recoveryReadinessReasonSchema = z.object({
  code: z.string(),
  severity: recoveryReadinessSeveritySchema,
  message: z.string(),
  action: z.string().optional()
});

export const recoveryReadinessPointSchema = z.object({
  id: idSchema,
  status: recoveryPointStatusSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  verified: z.boolean(),
  artifactCount: z.number().int().nonnegative(),
  completedArtifactCount: z.number().int().nonnegative(),
  backupTargetId: idSchema.nullable(),
  localUsable: z.boolean(),
  remoteUsable: z.boolean(),
  error: z.string().nullable()
});

export const recoveryReadinessDrillSchema = z.object({
  lastDrillAt: z.string().nullable(),
  lastDrillStatus: z.string().nullable(),
  lastDrillError: z.string().nullable(),
  lastSuccessfulDrillAt: z.string().nullable(),
  passed: z.boolean()
});

export const recoveryReadinessTargetHealthSchema = z.object({
  targetId: idSchema.nullable(),
  targetName: z.string().nullable(),
  status: backupTargetHealthStatusSchema.nullable(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable()
}).nullable();

export const recoveryReadinessSchema = z.object({
  hostId: idSchema,
  appIdentity: recoveryAppIdentitySchema,
  label: z.string(),
  status: recoveryReadinessStatusSchema,
  score: z.number().int().min(0).max(100),
  reasons: z.array(recoveryReadinessReasonSchema),
  recommendedCaptureMode: recoveryCaptureModeSchema,
  lastRecoveryPoint: recoveryReadinessPointSchema.nullable(),
  lastDrill: recoveryReadinessDrillSchema.nullable(),
  profile: recoveryProfileSchema.nullable(),
  targetHealth: recoveryReadinessTargetHealthSchema,
  dataMounts: z.array(recoveryDataMountSchema)
});

export const recoveryReadinessListQuerySchema = z.object({
  hostId: idSchema.optional()
});

export const recoveryReadinessAnalyzeRequestSchema = recoveryAnalysisRequestSchema;

export const migrationPlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["backup", "transfer", "deploy", "verify", "cleanup"]),
  required: z.boolean().default(true)
});

export const migrationPlanCheckSchema = z.object({
  sourceHostAvailable: z.boolean(),
  targetHostAvailable: z.boolean(),
  sourceDockerAvailable: z.boolean(),
  targetDockerAvailable: z.boolean(),
  sourceComposeAvailable: z.boolean(),
  targetComposeAvailable: z.boolean()
});

export const migrationPortConflictSchema = z.object({
  hostPort: z.string(),
  protocol: z.string(),
  sourceContainer: z.string().nullable(),
  reason: z.string()
});

export const migrationPlanSchema = z.object({
  sourceHostId: idSchema,
  targetHostId: idSchema,
  sourceAppIdentity: recoveryAppIdentitySchema,
  steps: z.array(migrationPlanStepSchema),
  warnings: z.array(z.string()).default([]),
  estimatedArtifacts: z.number().int().nonnegative().default(0),
  estimatedVolumes: z.number().int().nonnegative().default(0),
  estimatedHostFolders: z.number().int().nonnegative().default(0),
  checks: migrationPlanCheckSchema,
  portConflicts: z.array(migrationPortConflictSchema).default([]),
  volumeCollisions: z.array(z.string()).default([]),
  nameCollisions: z.array(z.string()).default([]),
  missingNetworks: z.array(z.string()).default([]),
  networkConflicts: z.array(z.string()).default([]),
  estimatedDataBytes: z.number().int().nonnegative().nullable().default(null),
  blockingIssues: z.array(z.string()).default([])
});

export const migrationPlanRequestSchema = z.object({
  sourceHostId: idSchema,
  targetHostId: idSchema,
  sourceAppIdentity: recoveryAppIdentitySchema,
  createRecoveryPoint: z.boolean().default(true)
});

export const migrationStrategySchema = z.enum(["safe_move", "warm_move", "clone"]);

export const migrationExecuteRequestSchema = z.object({
  sourceHostId: idSchema,
  targetHostId: idSchema,
  sourceAppIdentity: recoveryAppIdentitySchema,
  recoveryPointId: idSchema.optional(),
  strategy: migrationStrategySchema.default("clone"),
  options: z.object({
    stopSource: z.boolean().default(false),
    projectNameOverride: z.string().min(1).max(80).optional(),
    remapPorts: z.boolean().default(true),
    networkMode: recoveryNetworkModeSchema.default("clone")
  }).default({})
});

export const migrationRunSchema = z.object({
  id: idSchema,
  sourceHostId: idSchema,
  targetHostId: idSchema,
  sourceAppIdentity: recoveryAppIdentitySchema,
  mode: migrationModeSchema,
  status: migrationRunStatusSchema,
  recoveryPointId: idSchema.nullable(),
  plan: migrationPlanSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
});

export const recoveryScheduleCreateSchema = z.object({
  hostId: idSchema,
  name: z.string().min(1).max(80),
  appIdentity: recoveryAppIdentitySchema,
  backupTargetId: idSchema.optional(),
  profileId: idSchema.optional(),
  intervalMs: z.coerce.number().int().min(300_000).max(7 * 24 * 60 * 60 * 1000),
  retentionCount: z.coerce.number().int().min(1).max(365).optional(),
  enabled: z.boolean().default(true),
  captureMode: recoveryCaptureModeSchema.default("hot")
});

export const recoveryScheduleSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  name: z.string(),
  appIdentity: recoveryAppIdentitySchema,
  backupTargetId: idSchema.nullable(),
  profileId: idSchema.nullable().optional(),
  intervalMs: z.number().int(),
  retentionCount: z.number().int().nullable(),
  captureMode: recoveryCaptureModeSchema,
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastDrillAt: z.string().nullable(),
  lastDrillStatus: z.string().nullable(),
  lastDrillError: z.string().nullable(),
  lastSuccessfulDrillAt: z.string().nullable(),
  nextRunAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type RecoveryAppKind = z.infer<typeof recoveryAppKindSchema>;
export type BackupTargetKind = z.infer<typeof backupTargetKindSchema>;
export type RcloneProvider = z.infer<typeof rcloneProviderSchema>;
export type LocalCachePolicy = z.infer<typeof localCachePolicySchema>;
export type BackupTarget = z.infer<typeof backupTargetSchema>;
export type BackupTargetCreate = z.infer<typeof backupTargetCreateSchema>;
export type BackupTargetUpdate = z.infer<typeof backupTargetUpdateSchema>;
export type RecoveryAppIdentity = z.infer<typeof recoveryAppIdentitySchema>;
export type RecoveryPointStatus = z.infer<typeof recoveryPointStatusSchema>;
export type RecoveryArtifactKind = z.infer<typeof recoveryArtifactKindSchema>;
export type RecoveryArtifact = z.infer<typeof recoveryArtifactSchema>;
export type RecoveryPointListItem = z.infer<typeof recoveryPointListItemSchema>;
export type RecoveryPointDetail = z.infer<typeof recoveryPointDetailSchema>;
export type RecoveryPointCreate = z.infer<typeof recoveryPointCreateSchema>;
export type RecoveryCaptureMode = z.infer<typeof recoveryCaptureModeSchema>;
export type RecoveryRestoreMode = z.infer<typeof recoveryRestoreModeSchema>;
export type RecoveryNetworkMode = z.infer<typeof recoveryNetworkModeSchema>;
export type RecoveryProfile = z.infer<typeof recoveryProfileSchema>;
export type RecoveryProfileInput = z.infer<typeof recoveryProfileInputSchema>;
export type RecoveryDataMount = z.infer<typeof recoveryDataMountSchema>;
export type RecoveryAnalysis = z.infer<typeof recoveryAnalysisSchema>;
export type RecoveryAnalysisRequest = z.infer<typeof recoveryAnalysisRequestSchema>;
export type RecoveryReadinessStatus = z.infer<typeof recoveryReadinessStatusSchema>;
export type RecoveryReadinessSeverity = z.infer<typeof recoveryReadinessSeveritySchema>;
export type RecoveryReadinessReason = z.infer<typeof recoveryReadinessReasonSchema>;
export type RecoveryReadiness = z.infer<typeof recoveryReadinessSchema>;
export type RecoveryReadinessAnalyzeRequest = z.infer<typeof recoveryReadinessAnalyzeRequestSchema>;
export type MigrationStrategy = z.infer<typeof migrationStrategySchema>;
export type RecoveryRestoreRequest = z.infer<typeof recoveryRestoreRequestSchema>;
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;
export type MigrationPlanRequest = z.infer<typeof migrationPlanRequestSchema>;
export type MigrationExecuteRequest = z.infer<typeof migrationExecuteRequestSchema>;
export type MigrationRun = z.infer<typeof migrationRunSchema>;
export type RecoverySchedule = z.infer<typeof recoveryScheduleSchema>;
export type RecoveryScheduleCreate = z.infer<typeof recoveryScheduleCreateSchema>;
