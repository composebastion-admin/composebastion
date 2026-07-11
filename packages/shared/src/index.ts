import { z } from "zod";
import { parseReleaseVersion } from "./versions.js";
export * from "./versions.js";
import { normalizeSavedRegistryOrigin } from "./registry.js";
export * from "./registry.js";
import { validatePasswordStrength } from "./password.js";
import { paginationQuerySchema } from "./pagination.js";

export const CONFIG_BACKUP_FORMAT_VERSION = 1;

export const idSchema = z.string().uuid();

// Docker volume names must match this rule. Enforcing it prevents a path-like value
// (e.g. "/etc" or "../foo") from turning an intended named-volume mount into a host
// bind mount, which on restore would extract a tarball onto the host filesystem.
export const dockerVolumeNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    "Volume name may only contain letters, digits, '_', '.', '-' and must start with a letter or digit"
  );

export const hostPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => value.startsWith("/"), "Use an absolute Linux path, for example /home/user/app")
  .refine((value) => !/[\x00-\x1F\x7F]/.test(value), "Path contains invalid control characters");

const composePathSchema = z.string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !/[\x00-\x1F\x7F]/.test(value), "Path contains invalid control characters");

const composeFileContentSchema = z.string().min(1).max(512 * 1024);
const envFileContentSchema = z.string().max(512 * 1024);

export const adminUserSchema = z.object({
  id: idSchema,
  name: z.string().nullable(),
  username: z.string().nullable(),
  email: z.string().email(),
  role: z.enum(["owner", "admin", "operator", "viewer"]),
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable().optional(),
  createdAt: z.string()
});

export const sessionSchema = z.object({
  id: idSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  expiresAt: z.string(),
  current: z.boolean()
});

export const usernameSchema = z.string()
  .min(3)
  .max(50)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, underscores, or hyphens");

export const setupRequestSchema = z.object({
  name: z.string().max(80).optional(),
  username: usernameSchema.optional(),
  email: z.string().email().optional(),
  password: z.string().min(12),
  includeDemoData: z.boolean().default(false)
}).superRefine((value, ctx) => {
  if (!value.username && !value.email) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Username or email is required", path: ["username"] });
  }
  for (const message of validatePasswordStrength(value.password)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["password"] });
  }
});

export const loginRequestSchema = z.object({
  identifier: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  password: z.string().min(1)
}).superRefine((value, ctx) => {
  if (!value.identifier && !value.email) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Username or email is required", path: ["identifier"] });
  }
});

export const demoSeedRequestSchema = z.object({
  includeDemoData: z.boolean().default(true)
});

const dockerHostBaseSchema = z.object({
  name: z.string().min(1).max(80),
  hostname: z.string().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(80),
  connectionMode: z.enum(["ssh", "agent"]).default("ssh"),
  sshAuthType: z.enum(["key", "password"]).default("key"),
  sshPrivateKey: z.string().optional(),
  sshKeyPassphrase: z.string().optional(),
  sshPassword: z.string().optional(),
  agentUrl: z.string().url().optional(),
  agentToken: z.string().optional(),
  dockerSocketPath: z.string().min(1).default("/var/run/docker.sock"),
  tags: z.array(z.string().min(1).max(32)).default([])
});

export const dockerHostCreateSchema = dockerHostBaseSchema.superRefine((value, ctx) => {
  if (value.connectionMode === "ssh" && value.sshAuthType === "key" && !value.sshPrivateKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SSH private key is required for SSH hosts", path: ["sshPrivateKey"] });
  }
  if (value.connectionMode === "ssh" && value.sshAuthType === "password" && !value.sshPassword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "SSH password is required for password auth", path: ["sshPassword"] });
  }
  if (value.connectionMode === "agent" && (!value.agentUrl || !value.agentToken)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Agent URL and token are required for agent hosts", path: ["agentUrl"] });
  }
});

export const dockerHostUpdateSchema = dockerHostBaseSchema.partial();

export type DockerHostStatus = "unknown" | "online" | "offline" | "checking";

export const dockerHostSchema = z.object({
  id: idSchema,
  name: z.string(),
  hostname: z.string(),
  port: z.number(),
  username: z.string(),
  connectionMode: z.enum(["ssh", "agent"]),
  sshAuthType: z.enum(["key", "password"]),
  agentUrl: z.string().nullable(),
  dockerSocketPath: z.string(),
  tags: z.array(z.string()),
  lastStatus: z.enum(["unknown", "online", "offline", "checking"]),
  lastSeenAt: z.string().nullable(),
  lastError: z.string().nullable(),
  dockerVersion: z.string().nullable(),
  composeVersion: z.string().nullable(),
  agentVersion: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const hostSpecsSchema = z.object({
  hostId: idSchema,
  cpuCores: z.number(),
  cpuModel: z.string().optional(),
  memTotalBytes: z.number(),
  os: z.string(),
  kernel: z.string().optional(),
  arch: z.string(),
  dockerVersion: z.string(),
  composeVersion: z.string().optional(),
  collectedAt: z.string()
});

export const hostDiskSchema = z.object({
  mount: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  usedPercent: z.number()
});

export const hostStatsSchema = z.object({
  hostId: idSchema,
  collectedAt: z.string(),
  cpuPercent: z.number().nullable(),
  load: z.object({
    one: z.number(),
    five: z.number(),
    fifteen: z.number()
  }).nullable(),
  memory: z.object({
    totalBytes: z.number(),
    usedBytes: z.number(),
    availableBytes: z.number()
  }),
  swap: z.object({
    totalBytes: z.number(),
    usedBytes: z.number()
  }),
  disks: z.array(hostDiskSchema),
  network: z.object({
    rxBytesPerSec: z.number(),
    txBytesPerSec: z.number()
  }).nullable(),
  containers: z.object({
    running: z.number(),
    total: z.number()
  }).nullable(),
  uptimeSeconds: z.number()
});

export const resourceKindSchema = z.enum([
  "container",
  "image",
  "network",
  "volume"
]);

export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const resourceSnapshotSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  kind: resourceKindSchema,
  externalId: z.string(),
  name: z.string(),
  data: z.record(z.unknown()),
  updatedAt: z.string()
});

export const composeProjectNameSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens, or underscores, and start with a letter or number");

export const composeStackCreateSchema = z.object({
  name: z.string().min(1).max(80),
  projectName: composeProjectNameSchema,
  composeYaml: z.string().min(1),
  env: z.string().default("")
});

export const composeStackUpdateSchema = composeStackCreateSchema.partial();

export const composeStackProxyFieldsSchema = z.object({
  domains: z.array(z.string()).default([]),
  exposedService: z.string().nullable().optional(),
  exposedPort: z.number().nullable().optional(),
  tlsDesired: z.boolean().default(false),
  updatePolicyEnabled: z.boolean().default(false),
  updatePolicyChannel: z.enum(["digest", "patch", "minor"]).nullable().optional()
});

export const composeStackSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  name: z.string(),
  projectName: z.string(),
  composeYaml: z.string(),
  env: z.string(),
  status: z.string(),
  currentVersionId: idSchema.nullable().optional(),
  currentVersionNumber: z.number().int().nullable().optional(),
  domains: z.array(z.string()).default([]),
  exposedService: z.string().nullable().optional(),
  exposedPort: z.number().nullable().optional(),
  tlsDesired: z.boolean().default(false),
  updatePolicyEnabled: z.boolean().default(false),
  updatePolicyChannel: z.enum(["digest", "patch", "minor"]).nullable().optional(),
  sourceType: z.string().default("ui").optional(),
  sourceRepositoryUrl: z.string().nullable().optional(),
  sourceBranch: z.string().nullable().optional(),
  sourceWorkingDir: z.string().nullable().optional(),
  sourceComposePath: z.string().nullable().optional(),
  sourceCurrentCommitSha: z.string().nullable().optional(),
  sourceLatestCommitSha: z.string().nullable().optional(),
  sourceCheckedAt: z.string().nullable().optional(),
  sourceCheckError: z.string().nullable().optional(),
  lastDeployError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const composeStackProxyUpdateSchema = composeStackProxyFieldsSchema.partial();

export const backupKindSchema = z.enum(["volume", "host_path"]);
export const backupStatusSchema = z.enum(["queued", "running", "completed", "partial", "failed"]);
export const backupEncryptionSchema = z.enum(["none", "app_secret"]);

export const backupSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  kind: backupKindSchema.default("volume"),
  volumeName: z.string().nullable(),
  sourcePath: z.string().nullable(),
  targetVolumeName: z.string().nullable(),
  fileName: z.string(),
  sizeBytes: z.number().nullable(),
  checksum: z.string().nullable(),
  backupTargetId: idSchema.nullable(),
  remoteObjectKey: z.string().nullable(),
  encryption: backupEncryptionSchema.default("none"),
  encryptionKeyId: z.string().nullable(),
  encryptionKeyFingerprint: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  lastDrillAt: z.string().nullable(),
  lastDrillStatus: z.enum(["completed", "failed"]).nullable(),
  status: backupStatusSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  metadata: z.record(z.unknown())
});

export const backupCreateSchema = z.object({
  hostId: idSchema,
  volumeName: dockerVolumeNameSchema,
  backupTargetId: idSchema.optional(),
  encryption: backupEncryptionSchema.default("none")
});

export const hostPathBackupCreateSchema = z.object({
  hostId: idSchema,
  sourcePath: hostPathSchema,
  backupTargetId: idSchema.optional(),
  encryption: backupEncryptionSchema.default("none")
});

export const backupListQuerySchema = paginationQuerySchema.extend({
  hostId: idSchema.optional(),
  kind: backupKindSchema.optional()
});

export const backupRestoreSchema = z.object({
  targetHostId: idSchema,
  targetVolumeName: dockerVolumeNameSchema,
  overwrite: z.boolean().default(false)
});

export const hostPathBackupRestoreSchema = z.object({
  targetHostId: idSchema,
  targetPath: hostPathSchema,
  overwrite: z.boolean().default(false)
});

export const backupVerifySchema = z.object({
  testArchive: z.boolean().default(false)
});

export const backupDrillSchema = z.object({});

export const backupHealthStatusSchema = z.enum(["healthy", "warning", "critical"]);
export const backupHealthAttentionReasonSchema = z.enum([
  "failed",
  "partial",
  "never_verified",
  "never_drilled",
  "stale_verified",
  "stale_drilled"
]);

export const backupHealthAttentionSchema = z.object({
  backupId: idSchema,
  hostId: idSchema,
  hostName: z.string(),
  kind: backupKindSchema,
  label: z.string(),
  status: backupStatusSchema,
  severity: backupHealthStatusSchema,
  reason: backupHealthAttentionReasonSchema,
  recommendedAction: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  ageMs: z.number().nullable()
});

export const backupHealthHostSchema = z.object({
  hostId: idSchema.nullable(),
  hostName: z.string(),
  newestSuccessfulBackupAt: z.string().nullable(),
  newestSuccessfulBackupAgeMs: z.number().nullable(),
  scheduleIntervalMs: z.number().nullable(),
  staleSuccessfulBackup: z.boolean(),
  recentFailureCount: z.number().int(),
  totalSizeBytes: z.number(),
  neverVerifiedCount: z.number().int(),
  neverDrilledCount: z.number().int(),
  staleVerifiedCount: z.number().int(),
  staleDrilledCount: z.number().int(),
  status: backupHealthStatusSchema
});

export const backupHealthSummarySchema = z.object({
  windowMs: z.number(),
  proofStaleMs: z.number(),
  overall: backupHealthHostSchema,
  hosts: z.array(backupHealthHostSchema),
  attention: z.array(backupHealthAttentionSchema).default([])
});

export const backupScheduleCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("volume"),
    hostId: idSchema,
    volumeName: dockerVolumeNameSchema,
    backupTargetId: idSchema.optional(),
    encryption: backupEncryptionSchema.default("none"),
    intervalMs: z.coerce.number().int().min(300_000).max(7 * 24 * 60 * 60 * 1000),
    retentionCount: z.coerce.number().int().min(1).max(365).optional()
  }),
  z.object({
    kind: z.literal("host_path"),
    hostId: idSchema,
    sourcePath: hostPathSchema,
    backupTargetId: idSchema.optional(),
    encryption: backupEncryptionSchema.default("none"),
    intervalMs: z.coerce.number().int().min(300_000).max(7 * 24 * 60 * 60 * 1000),
    retentionCount: z.coerce.number().int().min(1).max(365).optional()
  })
]);

export const backupScheduleSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  kind: backupKindSchema,
  volumeName: z.string().nullable(),
  sourcePath: z.string().nullable(),
  backupTargetId: idSchema.nullable(),
  encryption: backupEncryptionSchema,
  intervalMs: z.number().int(),
  retentionCount: z.number().int().nullable(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const containerPortMappingSchema = z.object({
  hostPort: z.coerce.number().int().min(1).max(65535),
  containerPort: z.coerce.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp")
});

export const containerEnvSchema = z.object({
  key: z.string().min(1),
  value: z.string()
});

export const containerVolumeMountSchema = z.object({
  volumeName: dockerVolumeNameSchema,
  containerPath: z.string().min(1),
  readOnly: z.boolean().default(false)
});

export const imageCleanupTargetSchema = z.object({
  imageId: z.string().min(1),
  reference: z.string().min(1).optional()
});

export const imageCleanupUsageSchema = z.object({
  name: z.string(),
  state: z.string()
});

export const imageCleanupCandidateSchema = z.object({
  imageId: z.string(),
  reference: z.string(),
  repository: z.string(),
  tag: z.string(),
  size: z.string(),
  usedBy: z.array(imageCleanupUsageSchema),
  eligible: z.boolean(),
  reason: z.string()
});

export const containerExecRequestSchema = z.object({
  command: z.string().min(1).max(4000)
});

export const selfUpdateComposeFileSchema = z.string()
  .trim()
  .min(1)
  .max(1024)
  .refine((value) => !/[\x00-\x1F\x7F]/.test(value), "Compose file contains invalid control characters");

export const selfUpdateVersionSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => value === "latest" || Boolean(parseReleaseVersion(value)),
    "Use latest or a strict semantic release such as 1.0.7 or v1.0.7"
  );

const selfUpdateConfigBaseSchema = z.object({
  hostId: idSchema.nullable().default(null),
  workingDir: hostPathSchema.default("/srv/composebastion"),
  composeFile: selfUpdateComposeFileSchema.default("docker-compose.image.yml"),
  versionMode: z.enum(["latest", "pinned"]).default("latest"),
  targetVersion: selfUpdateVersionSchema.nullable().default("latest")
});

export const selfUpdateConfigSchema = selfUpdateConfigBaseSchema.superRefine((value, ctx) => {
  if (value.versionMode === "pinned" && (!value.targetVersion || value.targetVersion === "latest")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pinned updates require a release version", path: ["targetVersion"] });
  } else if (value.versionMode === "pinned" && !parseReleaseVersion(value.targetVersion)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pinned updates require a valid semantic release version", path: ["targetVersion"] });
  }
});

export const selfUpdateConfigInputSchema = selfUpdateConfigBaseSchema.partial().superRefine((value, ctx) => {
  if (value.versionMode === "pinned" && (!value.targetVersion || value.targetVersion === "latest")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pinned updates require a release version", path: ["targetVersion"] });
  } else if (value.versionMode === "pinned" && !parseReleaseVersion(value.targetVersion)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pinned updates require a valid semantic release version", path: ["targetVersion"] });
  }
});

export const selfUpdateStartSchema = z.object({
  targetVersion: selfUpdateVersionSchema.optional()
}).default({});

export type SelfUpdateConfig = z.infer<typeof selfUpdateConfigSchema>;
export type SelfUpdateConfigInput = z.infer<typeof selfUpdateConfigInputSchema>;

const withHost = <TType extends string, T extends z.ZodRawShape>(type: TType, payload: T) =>
  z.object({
    type: z.literal(type),
    hostId: idSchema,
    payload: z.object(payload)
  });

export const dockerActionSchema = z.discriminatedUnion("type", [
  withHost("host.check", {}),
  withHost("host.sync", {}),
  withHost("host.mkdir", { path: z.string().min(1).max(1024) }),
  withHost("git.clone", {
    repositoryUrl: z.string().min(1).max(2048),
    directory: z.string().min(1).max(1024),
    branch: z.string().min(1).max(255).optional(),
    shallow: z.boolean().default(true)
  }),
  withHost("git.pull", {
    directory: z.string().min(1).max(1024),
    branch: z.string().min(1).max(255).optional()
  }),
  withHost("git.testRemote", {
    repositoryUrl: z.string().min(1).max(2048),
    branch: z.string().min(1).max(255).optional()
  }),
  withHost("git.cloneDeploy", {
    repositoryUrl: z.string().min(1).max(2048),
    directory: z.string().min(1).max(1024),
    branch: z.string().min(1).max(255).optional(),
    composePath: z.string().min(1).max(1024).default("docker-compose.yml"),
    projectName: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "Project name must be lowercase and contain only letters, numbers, hyphens, and underscores"),
    repositoryId: idSchema.optional()
  }),
  withHost("container.run", {
    image: z.string().min(1),
    name: z.string().min(1).optional(),
    restartPolicy: z.enum(["no", "unless-stopped", "always", "on-failure"]).default("unless-stopped"),
    ports: z.array(containerPortMappingSchema).default([]),
    env: z.array(containerEnvSchema).default([]),
    volumes: z.array(containerVolumeMountSchema).default([]),
    network: z.string().optional(),
    command: z.string().optional()
  }),
  withHost("container.clone", {
    targetHostId: idSchema,
    containerId: z.string().min(1),
    targetName: z.string().min(1).optional(),
    start: z.boolean().default(false)
  }),
  withHost("container.start", { containerId: z.string().min(1) }),
  withHost("container.stop", { containerId: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(300).optional() }),
  withHost("container.restart", { containerId: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(300).optional() }),
  withHost("container.rename", { containerId: z.string().min(1), name: z.string().min(1).max(128) }),
  withHost("container.update", { containerId: z.string().min(1), targetImage: z.string().min(1).optional() }),
  withHost("container.remove", { containerId: z.string().min(1), force: z.boolean().default(false), removeVolumes: z.boolean().default(false) }),
  withHost("image.pull", { image: z.string().min(1) }),
  withHost("image.remove", { imageId: z.string().min(1), force: z.boolean().default(false) }),
  withHost("image.prune", { all: z.boolean().default(false) }),
  withHost("image.cleanup", { targets: z.array(imageCleanupTargetSchema).min(1).max(200) }),
  withHost("network.create", {
    name: z.string().min(1),
    driver: z.enum(["bridge", "host", "overlay", "macvlan", "ipvlan", "none"]).default("bridge"),
    subnet: z.string().optional(),
    gateway: z.string().optional(),
    attachable: z.boolean().default(false),
    internal: z.boolean().default(false),
    labels: z.record(z.string()).default({})
  }),
  withHost("network.remove", { networkId: z.string().min(1) }),
  withHost("network.prune", {}),
  withHost("volume.create", { name: dockerVolumeNameSchema, labels: z.record(z.string()).default({}) }),
  withHost("volume.remove", { volumeName: z.string().min(1), force: z.boolean().default(false) }),
  withHost("volume.prune", {}),
  withHost("volume.backup", { backupId: idSchema, volumeName: dockerVolumeNameSchema }),
  withHost("volume.restore", { backupId: idSchema, targetVolumeName: dockerVolumeNameSchema, overwrite: z.boolean().default(false) }),
  withHost("volume.clone", { backupId: idSchema.optional(), targetHostId: idSchema, sourceVolumeName: dockerVolumeNameSchema, targetVolumeName: dockerVolumeNameSchema, overwrite: z.boolean().default(false) }),
  withHost("hostPath.backup", { backupId: idSchema, sourcePath: hostPathSchema }),
  withHost("hostPath.restore", { backupId: idSchema, targetPath: hostPathSchema, overwrite: z.boolean().default(false) }),
  withHost("backup.verify", { backupId: idSchema, testArchive: z.boolean().default(false) }),
  withHost("backup.drill", { backupId: idSchema }),
  withHost("recovery.create", { recoveryPointId: idSchema, stopFirst: z.boolean().default(false) }),
  withHost("recovery.capture", { recoveryPointId: idSchema, stopFirst: z.boolean().default(false) }),
  withHost("recovery.verify", { recoveryPointId: idSchema }),
  withHost("recovery.restore", {
    recoveryPointId: idSchema,
    mode: z.enum(["clone", "in_place"]).default("clone"),
    stopExisting: z.boolean().default(false),
    projectNameOverride: z.string().min(1).max(80).optional(),
    volumePrefix: z.string().min(1).max(80).optional(),
    restoreRoot: z.string().min(1).max(1024).optional(),
    remapPorts: z.boolean().default(true),
    networkMode: z.enum(["clone", "reuse"]).default("clone"),
    drill: z.boolean().default(false)
  }),
  withHost("migration.execute", {
    migrationRunId: idSchema,
    strategy: z.enum(["safe_move", "warm_move", "clone"]).default("clone"),
    stopSource: z.boolean().default(false),
    projectNameOverride: z.string().min(1).max(80).optional(),
    remapPorts: z.boolean().default(true),
    networkMode: z.enum(["clone", "reuse"]).default("clone")
  }),
  withHost("compose.deployPath", {
    projectName: composeProjectNameSchema,
    workingDir: hostPathSchema,
    composePath: composePathSchema
  }),
  withHost("compose.writeDeployPath", {
    projectName: composeProjectNameSchema,
    workingDir: hostPathSchema,
    composePath: composePathSchema.default("docker-compose.yml"),
    composeYaml: composeFileContentSchema,
    env: envFileContentSchema.optional(),
    overwrite: z.boolean().default(false),
    pullBeforeDeploy: z.boolean().default(false)
  }),
  withHost("compose.deploy", { stackId: idSchema }),
  withHost("compose.stop", { stackId: idSchema }),
  withHost("compose.remove", { stackId: idSchema, removeVolumes: z.boolean().default(false) }),
  withHost("registry.login", { registryId: idSchema }),
  withHost("system.self_update", {
    workingDir: hostPathSchema,
    composeFile: selfUpdateComposeFileSchema,
    versionMode: z.enum(["latest", "pinned"]),
    targetVersion: selfUpdateVersionSchema
  })
]);

export type DockerActionRequest = z.infer<typeof dockerActionSchema>;
export type DockerActionType = DockerActionRequest["type"];
export type ImageCleanupCandidate = z.infer<typeof imageCleanupCandidateSchema>;
export type ImageCleanupTarget = z.infer<typeof imageCleanupTargetSchema>;

export const jobProgressStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  status: z.enum(["pending", "running", "completed", "failed"]),
  detail: z.string().max(500).optional()
});

export const operationJobSchema = z.object({
  id: idSchema,
  type: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "canceled"]),
  hostId: idSchema.nullable(),
  payload: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  progress: z.array(jobProgressStepSchema).default([]),
  correlationId: z.string(),
  error: z.string().nullable(),
  createdBy: idSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
});

export const workerStateSchema = z.enum(["active", "draining", "stale", "absent"]);
export const workerStatusSchema = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  lastJobCompletedAt: z.string().nullable(),
  available: z.boolean(),
  activeWorkers: z.number().int().nonnegative(),
  lastHeartbeatAt: z.string().nullable(),
  state: workerStateSchema
});

export const auditEventSchema = z.object({
  id: idSchema,
  userId: idSchema.nullable(),
  hostId: idSchema.nullable(),
  action: z.string(),
  targetKind: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.unknown()),
  createdAt: z.string()
});

export type AdminUser = z.infer<typeof adminUserSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type DockerHost = z.infer<typeof dockerHostSchema>;
export type HostSpecs = z.infer<typeof hostSpecsSchema>;
export type HostDisk = z.infer<typeof hostDiskSchema>;
export type HostStats = z.infer<typeof hostStatsSchema>;
export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
export type ComposeStack = z.infer<typeof composeStackSchema>;
export type Backup = z.infer<typeof backupSchema>;
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export type BackupHealthSummary = z.infer<typeof backupHealthSummarySchema>;
export type JobProgressStep = z.infer<typeof jobProgressStepSchema>;
export type OperationJob = z.infer<typeof operationJobSchema>;
export type WorkerStatus = z.infer<typeof workerStatusSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const favoriteImageCreateSchema = z.object({
  image: z.string().min(1).max(255),
  name: z.string().max(80).optional(),
  notes: z.string().max(500).default("")
});

export const favoriteImageSchema = z.object({
  id: idSchema,
  image: z.string(),
  name: z.string().nullable(),
  notes: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const githubRepositoryCreateSchema = z.object({
  name: z.string().min(1).max(80),
  repositoryUrl: z.string().url(),
  branch: z.string().min(1).max(120).default("main"),
  composePath: z.string().min(1).max(255).default("docker-compose.yml"),
  projectName: composeProjectNameSchema.optional(),
  env: z.string().default(""),
  defaultHostId: idSchema.optional(),
  hostCloneUrl: z.string().max(2048).optional(),
  hostCloneDirectory: z.string().max(1024).optional(),
  githubToken: z.string().max(4096).optional()
});

export const githubRepositoryUpdateSchema = githubRepositoryCreateSchema.partial().extend({
  clearGithubToken: z.boolean().default(false).optional()
});

export const githubRepositoryAccessCheckSchema = z.object({
  repositoryUrl: z.string().url(),
  branch: z.string().min(1).max(120).default("main"),
  composePath: z.string().min(1).max(255).default("docker-compose.yml"),
  githubToken: z.string().max(4096).optional()
});

export const githubTokenStatusSchema = z.enum(["none", "unchecked", "valid", "error"]);

export const githubRepositorySchema = z.object({
  id: idSchema,
  name: z.string(),
  repositoryUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  composePath: z.string(),
  projectName: z.string(),
  env: z.string(),
  defaultHostId: idSchema.nullable(),
  hostCloneUrl: z.string().nullable(),
  hostCloneDirectory: z.string().nullable(),
  lastDeployedAt: z.string().nullable(),
  lastDeployedCommitSha: z.string().nullable().optional(),
  latestCommitSha: z.string().nullable().optional(),
  updateCheckedAt: z.string().nullable().optional(),
  updateCheckError: z.string().nullable().optional(),
  hasGithubToken: z.boolean(),
  githubTokenStatus: githubTokenStatusSchema,
  githubTokenCheckedAt: z.string().nullable(),
  githubTokenCheckError: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const githubRepositoryDeploySchema = z.object({
  hostId: idSchema.optional(),
  branch: z.string().min(1).max(120).optional(),
  projectName: composeProjectNameSchema.optional(),
  composeYaml: z.string().min(1).optional(),
  env: z.string().optional(),
  mode: z.enum(["api", "host_clone"]).default("api").optional(),
  hostCloneUrl: z.string().min(1).max(2048).optional(),
  hostCloneDirectory: z.string().min(1).max(1024).optional()
});

export const githubRepositoryBranchesRequestSchema = z.object({
  repositoryUrl: z.string().url(),
  githubToken: z.string().max(4096).optional()
});

export const configExportSchema = z.object({
  passphrase: z.string().min(12)
});

export const configImportSchema = z.object({
  passphrase: z.string().min(12),
  backup: z.record(z.unknown())
});

export type FavoriteImage = z.infer<typeof favoriteImageSchema>;
export type GithubRepository = z.infer<typeof githubRepositorySchema>;

export const userCreateSchema = z.object({
  name: z.string().max(80).optional(),
  username: usernameSchema.optional(),
  email: z.string().email(),
  password: z.string().min(12),
  role: z.enum(["admin", "operator", "viewer"]).default("operator")
}).superRefine((value, ctx) => {
  for (const message of validatePasswordStrength(value.password)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["password"] });
  }
});

export const userUpdateSchema = z.object({
  name: z.string().max(80).nullable().optional(),
  username: usernameSchema.nullable().optional(),
  role: z.enum(["owner", "admin", "operator", "viewer"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(12).optional()
});

export const notificationChannelCreateSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["email", "webhook"]),
  emailTo: z.string().email().optional(),
  webhookUrl: z.string().url().optional(),
  enabled: z.boolean().default(true)
}).superRefine((value, ctx) => {
  if (value.type === "email" && !value.emailTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Email recipient is required", path: ["emailTo"] });
  }
  if (value.type === "webhook" && !value.webhookUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Webhook URL is required", path: ["webhookUrl"] });
  }
});

export const alertRuleConditionSchema = z.enum([
  "host.offline",
  "container.not_running",
  "host.cpu",
  "host.memory",
  "host.disk",
  "host.swap",
  "host.load"
]);

export const hostMetricAlertConditionSchema = z.enum(["host.cpu", "host.memory", "host.disk", "host.swap", "host.load"]);

export const hostThresholdParamsSchema = z.object({
  comparator: z.enum(["gt", "gte"]).default("gte"),
  threshold: z.number().refine(Number.isFinite, "Threshold must be a finite number"),
  durationSeconds: z.coerce.number().int().min(60).max(86_400).default(300),
  mount: z.string().trim().min(1).max(255).optional()
});

const percentHostThresholdParamsSchema = hostThresholdParamsSchema.superRefine((value, ctx) => {
  if (value.threshold < 1 || value.threshold > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Threshold must be between 1 and 100", path: ["threshold"] });
  }
});

const nonDiskPercentHostThresholdParamsSchema = percentHostThresholdParamsSchema.superRefine((value, ctx) => {
  if (value.mount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Mount is only supported for disk alerts", path: ["mount"] });
  }
});

const loadHostThresholdParamsSchema = hostThresholdParamsSchema.superRefine((value, ctx) => {
  if (value.threshold <= 0 || value.threshold > 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Load threshold must be greater than 0 and no more than 1024", path: ["threshold"] });
  }
  if (value.mount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Mount is only supported for disk alerts", path: ["mount"] });
  }
});

const alertRuleCreateBaseSchema = z.object({
  name: z.string().min(1).max(80),
  hostId: idSchema,
  channelId: idSchema,
  enabled: z.boolean().default(true)
});

export const alertRuleCreateSchema = z.discriminatedUnion("condition", [
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("host.offline"),
    containerId: z.string().optional()
  }),
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("container.not_running"),
    containerId: z.string().optional()
  }),
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("host.cpu"),
    params: nonDiskPercentHostThresholdParamsSchema
  }),
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("host.memory"),
    params: nonDiskPercentHostThresholdParamsSchema
  }),
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("host.disk"),
    params: percentHostThresholdParamsSchema
  }),
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("host.swap"),
    params: nonDiskPercentHostThresholdParamsSchema
  }),
  alertRuleCreateBaseSchema.extend({
    condition: z.literal("host.load"),
    params: loadHostThresholdParamsSchema
  })
]);

export const registryCreateSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().trim().min(1).max(512),
  username: z.string().optional(),
  password: z.string().optional(),
  insecure: z.boolean().default(false)
}).transform((value, ctx) => {
  try {
    const url = normalizeSavedRegistryOrigin(value.url, {
      defaultProtocol: value.insecure ? "http" : "https"
    });
    return {
      ...value,
      url,
      // The normalized origin is authoritative so cleartext credentials can
      // never be mislabeled as a secure registry (or the inverse).
      insecure: url.startsWith("http://")
    };
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: error instanceof Error ? error.message : "Registry URL is invalid"
    });
    return z.NEVER;
  }
});

export const registrySchema = z.object({
  id: idSchema,
  name: z.string(),
  url: z.string(),
  username: z.string().nullable(),
  insecure: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const notificationChannelSchema = z.object({
  id: idSchema,
  name: z.string(),
  type: z.enum(["email", "webhook"]),
  emailTo: z.string().nullable(),
  webhookUrl: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const alertChannelTestEventSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  status: z.enum(["success", "failed"]),
  error: z.string().nullable(),
  testedBy: idSchema.nullable(),
  testedAt: z.string()
});

export const alertRuleSchema = z.object({
  id: idSchema,
  name: z.string(),
  condition: alertRuleConditionSchema,
  hostId: idSchema,
  containerId: z.string().nullable(),
  channelId: idSchema,
  enabled: z.boolean(),
  params: hostThresholdParamsSchema.nullable(),
  breachingSince: z.string().nullable(),
  lastState: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastNotifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const alertSilenceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  hostId: idSchema.optional(),
  ruleId: idSchema.optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime(),
  reason: z.string().max(500).optional()
}).superRefine((value, ctx) => {
  if (!value.hostId && !value.ruleId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose a host or alert rule to silence", path: ["hostId"] });
  }
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt ?? new Date().toISOString())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Silence must end after it starts", path: ["endsAt"] });
  }
});

export const alertSilenceSchema = z.object({
  id: idSchema,
  name: z.string(),
  hostId: idSchema.nullable(),
  ruleId: idSchema.nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  reason: z.string().nullable(),
  createdBy: idSchema.nullable(),
  createdAt: z.string()
});

export const alertEventSchema = z.object({
  id: idSchema,
  ruleId: idSchema.nullable(),
  hostId: idSchema.nullable(),
  channelId: idSchema.nullable(),
  state: z.string(),
  message: z.string(),
  notified: z.boolean(),
  silenced: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string()
});

export type Registry = z.infer<typeof registrySchema>;
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type AlertChannelTestEvent = z.infer<typeof alertChannelTestEventSchema>;
export type AlertRule = z.infer<typeof alertRuleSchema>;
export type AlertRuleCondition = z.infer<typeof alertRuleConditionSchema>;
export type HostMetricAlertCondition = z.infer<typeof hostMetricAlertConditionSchema>;
export type HostThresholdParams = z.infer<typeof hostThresholdParamsSchema>;
export type AlertSilenceCreate = z.infer<typeof alertSilenceCreateSchema>;
export type AlertSilence = z.infer<typeof alertSilenceSchema>;
export type AlertEvent = z.infer<typeof alertEventSchema>;

export const volumeCloneSchema = z.object({
  sourceHostId: idSchema,
  targetHostId: idSchema,
  sourceVolumeName: dockerVolumeNameSchema,
  targetVolumeName: dockerVolumeNameSchema,
  overwrite: z.boolean().default(false)
});

export const containerCloneSchema = z.object({
  sourceHostId: idSchema,
  targetHostId: idSchema,
  containerId: z.string().min(1),
  targetName: z.string().min(1).optional(),
  start: z.boolean().default(false)
});

export const networkDriverExplanations = {
  bridge: {
    title: "Bridge",
    summary: "Default single-host networking. Containers get private addresses and can publish ports through the host.",
    bestFor: "Most standalone apps and Compose projects on one server.",
    watchOut: "Container names only resolve inside the same user-created bridge network."
  },
  host: {
    title: "Host",
    summary: "The container shares the host network namespace and skips Docker port publishing.",
    bestFor: "Low-latency tools that need to bind directly to host interfaces.",
    watchOut: "Port conflicts and weaker isolation are common risks."
  },
  overlay: {
    title: "Overlay",
    summary: "Multi-host networking for Swarm services and attachable distributed networks.",
    bestFor: "Swarm workloads or containers that must communicate across Docker hosts.",
    watchOut: "Requires Swarm mode and correct inter-host firewall rules."
  },
  macvlan: {
    title: "Macvlan",
    summary: "Gives containers their own MAC address on the physical network.",
    bestFor: "Services that must appear as first-class devices on the LAN.",
    watchOut: "Host-to-container communication often needs extra routing or a shim interface."
  },
  ipvlan: {
    title: "IPvlan",
    summary: "Similar to macvlan but shares the parent interface MAC address.",
    bestFor: "Dense LAN deployments where switches dislike many MAC addresses.",
    watchOut: "Network behavior depends heavily on L2/L3 mode and upstream routing."
  },
  none: {
    title: "None",
    summary: "Creates a container with no external network interface.",
    bestFor: "Isolated batch jobs or security-sensitive processing.",
    watchOut: "The container cannot reach package repositories or external services."
  }
} as const;

export type NetworkDriver = keyof typeof networkDriverExplanations;

export * from "./dockerResource.js";
export * from "./pagination.js";
export * from "./password.js";
export * from "./auditActions.js";
export * from "./catalog/templates.js";
export * from "./stackPlatform.js";
export * from "./diffText.js";
export * from "./recoveryCenter.js";
