export type OpenApiPath = {
  method: "delete" | "get" | "patch" | "post" | "put";
  path: string;
  summary: string;
  tags: string[];
  auth: "public" | "session" | "viewer" | "operator" | "admin";
  responseSchema?: Record<string, unknown>;
  streaming?: boolean;
  download?: boolean;
  websocket?: boolean;
  notes?: string[];
};

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (schema: Record<string, unknown>) => ({ type: "array", items: schema });
const OPENAPI_VERSION = "0.9.4";

export const openApiRoutes: OpenApiPath[] = [
  { method: "get", path: "/api/v1/health", summary: "Basic API health check", tags: ["Health"], auth: "public", responseSchema: schemaRef("HealthResponse") },
  { method: "get", path: "/api/v1/health/ready", summary: "Composite readiness check", tags: ["Health"], auth: "public", responseSchema: schemaRef("ReadinessResponse") },
  { method: "get", path: "/api/v1/auth/setup-state", summary: "Read setup state", tags: ["Auth"], auth: "public", responseSchema: schemaRef("SetupStateResponse") },
  { method: "post", path: "/api/v1/auth/setup", summary: "Create the first owner account", tags: ["Auth"], auth: "public", responseSchema: schemaRef("UserResponse") },
  { method: "post", path: "/api/v1/auth/login", summary: "Create a session cookie", tags: ["Auth"], auth: "public", responseSchema: schemaRef("UserResponse") },
  { method: "post", path: "/api/v1/auth/logout", summary: "Destroy the current session", tags: ["Auth"], auth: "session", responseSchema: schemaRef("OkResponse") },
  { method: "get", path: "/api/v1/auth/me", summary: "Read the current signed-in user", tags: ["Auth"], auth: "session", responseSchema: schemaRef("UserResponse") },
  { method: "get", path: "/api/v1/auth/sessions", summary: "List active sessions for current user", tags: ["Auth"], auth: "session", responseSchema: schemaRef("SessionsResponse") },
  { method: "delete", path: "/api/v1/auth/sessions/{id}", summary: "Revoke one active session", tags: ["Auth"], auth: "session", responseSchema: schemaRef("OkResponse") },
  { method: "get", path: "/api/v1/hosts", summary: "List Docker hosts", tags: ["Hosts"], auth: "viewer", responseSchema: schemaRef("HostsResponse") },
  { method: "post", path: "/api/v1/hosts", summary: "Create a Docker host", tags: ["Hosts"], auth: "operator", responseSchema: schemaRef("HostJobResponse") },
  { method: "get", path: "/api/v1/hosts/{id}/resources", summary: "List host resource inventory", tags: ["Resources"], auth: "viewer", responseSchema: schemaRef("ResourcesResponse") },
  { method: "get", path: "/api/v1/hosts/{id}/image-cleanup", summary: "Preview removable and blocked Docker images", tags: ["Images"], auth: "operator", responseSchema: schemaRef("ImageCleanupPreviewResponse") },
  { method: "post", path: "/api/v1/hosts/{id}/actions", summary: "Enqueue a typed Docker action", tags: ["Jobs"], auth: "operator", responseSchema: schemaRef("JobResponse") },
  { method: "get", path: "/api/v1/hosts/{hostId}/metrics", summary: "Read one host metrics snapshot", tags: ["Metrics"], auth: "viewer", responseSchema: schemaRef("HostMetricsResponse") },
  { method: "get", path: "/api/v1/hosts/metrics", summary: "Read fleet metrics snapshot", tags: ["Metrics"], auth: "viewer", responseSchema: schemaRef("FleetMetricsResponse") },
  {
    method: "get",
    path: "/api/v1/hosts/{hostId}/metrics-stream",
    summary: "SSE host metrics stream",
    tags: ["Streams"],
    auth: "viewer",
    streaming: true,
    notes: ["Events: `stats`, `error`, `ping`.", "`stats` payload is `{ stats: HostStats }`; errors use `{ error }` and the stream remains reconnectable."]
  },
  { method: "get", path: "/api/v1/hosts/{hostId}/containers/{containerId}/logs", summary: "Read container logs", tags: ["Containers"], auth: "viewer", responseSchema: schemaRef("ContainerLogsResponse") },
  {
    method: "get",
    path: "/api/v1/hosts/{hostId}/containers/{containerId}/logs-stream",
    summary: "SSE container log stream",
    tags: ["Streams"],
    auth: "viewer",
    streaming: true,
    notes: ["Events: `message`, `error`, `ping`, `end`.", "`message` payload is `{ line: string }` and preserves blank lines plus leading/trailing whitespace."]
  },
  { method: "get", path: "/api/v1/hosts/{hostId}/containers/{containerId}/inspect", summary: "Read redacted/full container inspect details by role", tags: ["Containers"], auth: "viewer", responseSchema: schemaRef("ContainerInspectResponse") },
  { method: "post", path: "/api/v1/hosts/{hostId}/containers/{containerId}/exec", summary: "Run audited container exec", tags: ["Containers"], auth: "operator", responseSchema: schemaRef("DockerCommandResponse") },
  {
    method: "get",
    path: "/api/v1/hosts/{hostId}/containers/usage-stream",
    summary: "SSE container usage stream",
    tags: ["Streams"],
    auth: "viewer",
    streaming: true,
    notes: ["Events: `usage`, `error`, `ping`.", "`usage` payload is `{ stats }` with Docker stats rows; malformed rows are surfaced as `error` events."]
  },
  {
    method: "get",
    path: "/api/v1/hosts/{hostId}/terminal",
    summary: "Interactive host terminal websocket",
    tags: ["Streams"],
    auth: "admin",
    websocket: true,
    notes: ["WebSocket route for owner/admin shell access on SSH-capable hosts.", "Authentication and authorization failures are returned before upgrade with the standard error envelope."]
  },
  { method: "get", path: "/api/v1/jobs", summary: "List operation jobs", tags: ["Jobs"], auth: "viewer", responseSchema: schemaRef("JobsResponse") },
  { method: "get", path: "/api/v1/jobs/status", summary: "Read worker queue status", tags: ["Jobs"], auth: "viewer", responseSchema: schemaRef("WorkerStatusResponse") },
  { method: "get", path: "/api/v1/jobs/{id}", summary: "Read one operation job", tags: ["Jobs"], auth: "viewer", responseSchema: schemaRef("JobResponse") },
  { method: "post", path: "/api/v1/jobs/{id}/retry", summary: "Retry a failed or canceled operation job", tags: ["Jobs"], auth: "operator", responseSchema: schemaRef("JobRetryResponse") },
  { method: "post", path: "/api/v1/jobs/{id}/cancel", summary: "Cancel a queued operation job", tags: ["Jobs"], auth: "operator", responseSchema: schemaRef("JobResponse") },
  { method: "get", path: "/api/v1/backups", summary: "List backups", tags: ["Backups"], auth: "viewer", responseSchema: schemaRef("BackupsResponse") },
  { method: "get", path: "/api/v1/backups/health", summary: "Read backup health", tags: ["Backups"], auth: "viewer", responseSchema: schemaRef("BackupHealthResponse") },
  { method: "post", path: "/api/v1/backups", summary: "Create a volume backup", tags: ["Backups"], auth: "operator", responseSchema: schemaRef("BackupJobResponse") },
  {
    method: "get",
    path: "/api/v1/backups/{id}/download",
    summary: "Download a backup archive",
    tags: ["Backups"],
    auth: "operator",
    download: true,
    notes: ["Returns an attachment stream on success.", "Validation, authorization, missing-file, and unsupported-remote failures use the standard JSON error envelope with `requestId`."]
  },
  { method: "get", path: "/api/v1/recovery/targets", summary: "List recovery backup targets", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("BackupTargetsResponse") },
  { method: "post", path: "/api/v1/recovery/targets", summary: "Create a recovery backup target", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("BackupTargetResponse") },
  { method: "get", path: "/api/v1/recovery/targets/{id}", summary: "Read one recovery backup target", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("BackupTargetResponse") },
  { method: "patch", path: "/api/v1/recovery/targets/{id}", summary: "Update a recovery backup target", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("BackupTargetResponse") },
  { method: "delete", path: "/api/v1/recovery/targets/{id}", summary: "Delete a recovery backup target", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("OkResponse") },
  { method: "post", path: "/api/v1/recovery/targets/{id}/test", summary: "Test a recovery backup target connection", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("BackupTargetTestResponse") },
  { method: "post", path: "/api/v1/recovery/analyze", summary: "Analyze app recovery data locations", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("RecoveryAnalysisResponse") },
  { method: "get", path: "/api/v1/recovery/readiness", summary: "List app recovery readiness scores", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("RecoveryReadinessListResponse") },
  { method: "post", path: "/api/v1/recovery/readiness/analyze", summary: "Analyze one app recovery readiness score", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("RecoveryReadinessResponse") },
  { method: "post", path: "/api/v1/recovery/profiles/lookup", summary: "Find the saved recovery profile for an app", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("RecoveryProfileResponse") },
  { method: "put", path: "/api/v1/recovery/profiles", summary: "Create or update an app recovery profile", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("RecoveryProfileResponse") },
  { method: "get", path: "/api/v1/recovery/profiles/{id}", summary: "Read one app recovery profile", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("RecoveryProfileResponse") },
  { method: "delete", path: "/api/v1/recovery/profiles/{id}", summary: "Delete an app recovery profile", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("OkResponse") },
  { method: "get", path: "/api/v1/recovery/points", summary: "List recovery points", tags: ["Recovery"], auth: "viewer", responseSchema: schemaRef("RecoveryPointsResponse") },
  { method: "post", path: "/api/v1/recovery/points", summary: "Create a recovery point", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("RecoveryPointJobResponse") },
  { method: "post", path: "/api/v1/recovery/points/{id}/drill", summary: "Enqueue a clone-only recovery restore drill", tags: ["Recovery"], auth: "operator", responseSchema: schemaRef("RecoveryDrillResponse") },
  { method: "get", path: "/api/v1/apps", summary: "List managed apps", tags: ["Apps"], auth: "viewer", responseSchema: schemaRef("AppsResponse") },
  { method: "get", path: "/api/v1/image-updates", summary: "List image update intelligence", tags: ["Images"], auth: "viewer", responseSchema: schemaRef("ImageUpdatesResponse") },
  { method: "get", path: "/api/v1/image-updates/preview", summary: "Preview an image update action", tags: ["Images"], auth: "viewer", responseSchema: schemaRef("ImageUpdatePreviewResponse") },
  { method: "get", path: "/api/v1/image-scanner/status", summary: "Read vulnerability scanner availability", tags: ["Images"], auth: "viewer", responseSchema: schemaRef("ImageScannerStatusResponse") },
  { method: "get", path: "/api/v1/alerts/channels", summary: "List alert notification channels", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("NotificationChannelsResponse") },
  { method: "post", path: "/api/v1/alerts/channels", summary: "Create alert notification channel", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("NotificationChannelResponse") },
  { method: "post", path: "/api/v1/alerts/channels/{id}/test", summary: "Send alert channel test notification", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("AlertChannelTestResponse") },
  { method: "get", path: "/api/v1/alerts/channels/test-history", summary: "List recent alert channel test history", tags: ["Alerts"], auth: "viewer", responseSchema: schemaRef("AlertChannelTestHistoryResponse") },
  { method: "get", path: "/api/v1/alerts/channels/{id}/test-history", summary: "List alert channel test history", tags: ["Alerts"], auth: "viewer", responseSchema: schemaRef("AlertChannelTestHistoryResponse") },
  { method: "get", path: "/api/v1/alerts/rules", summary: "List alert rules", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("AlertRulesResponse") },
  { method: "post", path: "/api/v1/alerts/rules", summary: "Create alert rule", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("AlertRuleResponse") },
  { method: "get", path: "/api/v1/alerts/silences", summary: "List alert silences", tags: ["Alerts"], auth: "viewer", responseSchema: schemaRef("AlertSilencesResponse") },
  { method: "post", path: "/api/v1/alerts/silences", summary: "Create alert silence", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("AlertSilenceResponse") },
  { method: "delete", path: "/api/v1/alerts/silences/{id}", summary: "Delete alert silence", tags: ["Alerts"], auth: "operator", responseSchema: schemaRef("OkResponse") },
  { method: "get", path: "/api/v1/alerts/history", summary: "List alert history events", tags: ["Alerts"], auth: "viewer", responseSchema: schemaRef("AlertHistoryResponse") },
  { method: "get", path: "/api/v1/audit", summary: "List audit events", tags: ["Audit"], auth: "admin", responseSchema: schemaRef("AuditEventsResponse") },
  { method: "get", path: "/api/v1/users", summary: "List users", tags: ["Users"], auth: "admin", responseSchema: schemaRef("UsersResponse") }
];

const errorSchema = {
  type: "object",
  required: ["error", "code", "requestId"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
    requestId: { type: ["string", "null"] },
    issues: { type: "array", items: { type: "object" } }
  }
};

const idSchema = { type: "string", format: "uuid" };
const dateTimeSchema = { type: "string", format: "date-time" };
const stringOrNullSchema = { type: ["string", "null"] };
const idOrNullSchema = { anyOf: [idSchema, { type: "null" }] };
const objectSchema = { type: "object", additionalProperties: true };
const recordSchema = { type: "object", additionalProperties: true };

const object = (
  required: string[],
  properties: Record<string, unknown>,
  additionalProperties: boolean | Record<string, unknown> = false
) => ({
  type: "object",
  required,
  additionalProperties,
  properties
});

const enumSchema = (values: string[]) => ({ type: "string", enum: values });
const namedArrayResponse = (key: string, itemSchema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  object([key, ...Object.keys(extra)], { [key]: arrayOf(itemSchema), ...extra });
const namedItemResponse = (key: string, itemSchema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  object([key, ...Object.keys(extra)], { [key]: itemSchema, ...extra });

const componentSchemas = {
  Error: errorSchema,
  OkResponse: object(["ok"], { ok: { type: "boolean" } }),
  HealthResponse: object(["ok"], { ok: { type: "boolean" } }),
  ReadinessResponse: object(["ok", "checks"], {
    ok: { type: "boolean" },
    checks: {
      type: "object",
      additionalProperties: object(["ok"], {
        ok: { type: "boolean" },
        error: stringOrNullSchema
      }, true)
    }
  }),
  SetupStateResponse: object(["needsSetup"], { needsSetup: { type: "boolean" } }),
  AdminUser: object(["id", "email", "role", "isActive", "createdAt"], {
    id: idSchema,
    name: stringOrNullSchema,
    username: stringOrNullSchema,
    email: { type: "string", format: "email" },
    role: enumSchema(["owner", "admin", "operator", "viewer"]),
    isActive: { type: "boolean" },
    lastLoginAt: stringOrNullSchema,
    createdAt: dateTimeSchema
  }),
  UserResponse: namedItemResponse("user", schemaRef("AdminUser")),
  Session: object(["id", "ipAddress", "userAgent", "createdAt", "lastSeenAt", "expiresAt", "current"], {
    id: idSchema,
    ipAddress: stringOrNullSchema,
    userAgent: stringOrNullSchema,
    createdAt: dateTimeSchema,
    lastSeenAt: stringOrNullSchema,
    expiresAt: dateTimeSchema,
    current: { type: "boolean" }
  }),
  SessionsResponse: namedArrayResponse("sessions", schemaRef("Session")),
  DockerHost: object(["id", "name", "hostname", "port", "username", "connectionMode", "sshAuthType", "agentUrl", "dockerSocketPath", "tags", "lastStatus", "lastSeenAt", "lastError", "dockerVersion", "composeVersion", "agentVersion", "createdAt", "updatedAt"], {
    id: idSchema,
    name: { type: "string" },
    hostname: { type: "string" },
    port: { type: "number" },
    username: { type: "string" },
    connectionMode: enumSchema(["ssh", "agent"]),
    sshAuthType: enumSchema(["key", "password"]),
    agentUrl: stringOrNullSchema,
    dockerSocketPath: { type: "string" },
    tags: arrayOf({ type: "string" }),
    lastStatus: enumSchema(["unknown", "online", "offline", "checking"]),
    lastSeenAt: stringOrNullSchema,
    lastError: stringOrNullSchema,
    dockerVersion: stringOrNullSchema,
    composeVersion: stringOrNullSchema,
    agentVersion: stringOrNullSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema
  }),
  HostsResponse: namedArrayResponse("hosts", schemaRef("DockerHost")),
  ResourceSnapshot: object(["id", "hostId", "kind", "externalId", "name", "data", "updatedAt"], {
    id: idSchema,
    hostId: idSchema,
    kind: enumSchema(["container", "image", "network", "volume"]),
    externalId: { type: "string" },
    name: { type: "string" },
    data: recordSchema,
    updatedAt: dateTimeSchema
  }),
  ResourcesResponse: namedArrayResponse("resources", schemaRef("ResourceSnapshot")),
  ImageCleanupUsage: object(["name", "state"], {
    name: { type: "string" },
    state: { type: "string" }
  }),
  ImageCleanupCandidate: object(["imageId", "reference", "repository", "tag", "size", "usedBy", "eligible", "reason"], {
    imageId: { type: "string" },
    reference: { type: "string" },
    repository: { type: "string" },
    tag: { type: "string" },
    size: { type: "string" },
    usedBy: arrayOf(schemaRef("ImageCleanupUsage")),
    eligible: { type: "boolean" },
    reason: { type: "string" }
  }),
  ImageCleanupPreviewResponse: namedArrayResponse("candidates", schemaRef("ImageCleanupCandidate")),
  HostSpecs: object(["hostId", "cpuCores", "memTotalBytes", "os", "arch", "dockerVersion", "collectedAt"], {
    hostId: idSchema,
    cpuCores: { type: "number" },
    cpuModel: { type: "string" },
    memTotalBytes: { type: "number" },
    os: { type: "string" },
    kernel: { type: "string" },
    arch: { type: "string" },
    dockerVersion: { type: "string" },
    composeVersion: { type: "string" },
    collectedAt: dateTimeSchema
  }),
  HostStats: object(["hostId", "collectedAt", "cpuPercent", "load", "memory", "swap", "disks", "network", "containers", "uptimeSeconds"], {
    hostId: idSchema,
    collectedAt: dateTimeSchema,
    cpuPercent: { type: ["number", "null"] },
    load: { anyOf: [object(["one", "five", "fifteen"], { one: { type: "number" }, five: { type: "number" }, fifteen: { type: "number" } }), { type: "null" }] },
    memory: object(["totalBytes", "usedBytes", "availableBytes"], { totalBytes: { type: "number" }, usedBytes: { type: "number" }, availableBytes: { type: "number" } }),
    swap: object(["totalBytes", "usedBytes"], { totalBytes: { type: "number" }, usedBytes: { type: "number" } }),
    disks: arrayOf(schemaRef("HostDisk")),
    network: { anyOf: [object(["rxBytesPerSec", "txBytesPerSec"], { rxBytesPerSec: { type: "number" }, txBytesPerSec: { type: "number" } }), { type: "null" }] },
    containers: { anyOf: [object(["running", "total"], { running: { type: "number" }, total: { type: "number" } }), { type: "null" }] },
    uptimeSeconds: { type: "number" }
  }),
  HostDisk: object(["mount", "totalBytes", "usedBytes", "usedPercent"], {
    mount: { type: "string" },
    totalBytes: { type: "number" },
    usedBytes: { type: "number" },
    usedPercent: { type: "number" }
  }),
  HostMetricsResponse: object(["specs", "stats"], {
    specs: schemaRef("HostSpecs"),
    stats: schemaRef("HostStats"),
    degradedReason: { type: "string" }
  }),
  FleetMetricHost: object(["hostId", "name", "online"], {
    hostId: idSchema,
    name: { type: "string" },
    online: { type: "boolean" },
    specs: schemaRef("HostSpecs"),
    stats: schemaRef("HostStats"),
    degradedReason: { type: "string" },
    error: { type: "string" }
  }),
  FleetMetricsResponse: namedArrayResponse("hosts", schemaRef("FleetMetricHost")),
  ContainerLogsResponse: object(["logs"], { logs: { type: "string" } }),
  ContainerInspectResponse: namedItemResponse("inspect", objectSchema),
  DockerCommandResponse: object([], {
    stdout: { type: "string" },
    stderr: { type: "string" },
    code: { type: "number" }
  }, true),
  JobProgressStep: object(["id", "label", "status"], {
    id: { type: "string" },
    label: { type: "string" },
    status: enumSchema(["pending", "running", "completed", "failed"]),
    detail: { type: "string" }
  }),
  OperationJob: object(["id", "correlationId", "type", "status", "hostId", "payload", "result", "progress", "error", "createdBy", "createdAt", "updatedAt", "startedAt", "completedAt"], {
    id: idSchema,
    correlationId: { type: "string" },
    type: { type: "string" },
    status: enumSchema(["queued", "running", "completed", "failed", "canceled"]),
    hostId: idOrNullSchema,
    payload: recordSchema,
    result: { anyOf: [recordSchema, { type: "null" }] },
    progress: arrayOf(schemaRef("JobProgressStep")),
    error: stringOrNullSchema,
    createdBy: idOrNullSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    startedAt: stringOrNullSchema,
    completedAt: stringOrNullSchema
  }),
  JobResponse: namedItemResponse("job", schemaRef("OperationJob")),
  HostJobResponse: object(["host", "job"], { host: schemaRef("DockerHost"), job: schemaRef("OperationJob") }),
  JobsResponse: namedArrayResponse("jobs", schemaRef("OperationJob"), {
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" }
  }),
  WorkerStatusResponse: namedItemResponse("worker", object(["queued", "running"], {
    queued: { type: "number" },
    running: { type: "number" },
    lastJobCompletedAt: stringOrNullSchema
  }, true)),
  JobRetryResponse: object(["job", "original"], { job: schemaRef("OperationJob"), original: schemaRef("OperationJob") }),
  Backup: object(["id", "hostId", "kind", "fileName", "status", "createdAt", "metadata"], {
    id: idSchema,
    hostId: idSchema,
    kind: enumSchema(["volume", "host_path"]),
    volumeName: stringOrNullSchema,
    sourcePath: stringOrNullSchema,
    targetVolumeName: stringOrNullSchema,
    fileName: { type: "string" },
    sizeBytes: { type: ["number", "null"] },
    checksum: stringOrNullSchema,
    backupTargetId: idOrNullSchema,
    remoteObjectKey: stringOrNullSchema,
    encryption: enumSchema(["none", "app_secret"]),
    encryptionKeyId: stringOrNullSchema,
    encryptionKeyFingerprint: stringOrNullSchema,
    verifiedAt: stringOrNullSchema,
    lastDrillAt: stringOrNullSchema,
    lastDrillStatus: { type: ["string", "null"], enum: ["completed", "failed", null] },
    status: enumSchema(["queued", "running", "completed", "partial", "failed"]),
    error: stringOrNullSchema,
    createdAt: dateTimeSchema,
    completedAt: stringOrNullSchema,
    metadata: recordSchema
  }),
  BackupsResponse: namedArrayResponse("backups", schemaRef("Backup")),
  BackupHealthResponse: namedItemResponse("health", objectSchema),
  BackupJobResponse: object(["backup", "job"], { backup: schemaRef("Backup"), job: schemaRef("OperationJob") }),
  BackupTarget: object(["id", "name", "type", "kind", "enabled", "config", "localCachePolicy", "healthStatus", "createdAt", "updatedAt"], {
    id: idSchema,
    name: { type: "string" },
    type: enumSchema(["local", "s3", "rclone"]),
    kind: enumSchema(["local", "s3", "rclone"]),
    enabled: { type: "boolean" },
    config: recordSchema,
    endpoint: stringOrNullSchema,
    region: stringOrNullSchema,
    bucket: stringOrNullSchema,
    prefix: stringOrNullSchema,
    forcePathStyle: { type: "boolean" },
    basePath: stringOrNullSchema,
    provider: { type: ["string", "null"], enum: ["smb", "drive", "onedrive", "iclouddrive", "webdav", "sftp", "custom", null] },
    rcloneProvider: { type: ["string", "null"], enum: ["smb", "drive", "onedrive", "iclouddrive", "webdav", "sftp", "custom", null] },
    remotePath: stringOrNullSchema,
    remoteName: stringOrNullSchema,
    localCachePolicy: enumSchema(["keep", "remote_only"]),
    healthStatus: enumSchema(["unknown", "healthy", "failed"]),
    healthCheckedAt: stringOrNullSchema,
    healthError: stringOrNullSchema,
    hasCredentials: { type: "boolean" },
    hasSecretAccessKey: { type: "boolean" },
    hasGenericConfig: { type: "boolean" },
    hasGenericCredentials: { type: "boolean" },
    accessKeyId: stringOrNullSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema
  }),
  BackupTargetsResponse: namedArrayResponse("targets", schemaRef("BackupTarget")),
  BackupTargetResponse: namedItemResponse("target", schemaRef("BackupTarget")),
  BackupTargetTestResponse: object(["target", "ok"], {
    target: schemaRef("BackupTarget"),
    ok: { type: "boolean" },
    error: stringOrNullSchema
  }),
  RecoveryAppIdentity: recordSchema,
  RecoveryProfile: object(["id", "hostId", "appIdentity", "name", "includePaths", "excludePatterns", "restorePaths", "captureMode", "createdAt", "updatedAt"], {
    id: idSchema,
    hostId: idSchema,
    appIdentity: schemaRef("RecoveryAppIdentity"),
    name: { type: "string" },
    includePaths: arrayOf({ type: "string" }),
    excludePatterns: arrayOf({ type: "string" }),
    restorePaths: recordSchema,
    preCaptureCommand: stringOrNullSchema,
    postCaptureCommand: stringOrNullSchema,
    captureMode: enumSchema(["hot", "stop_first"]),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema
  }),
  RecoveryProfileResponse: object(["profile"], { profile: { anyOf: [schemaRef("RecoveryProfile"), { type: "null" }] } }),
  RecoveryDataMount: object(["type", "containerName", "source", "name", "destination", "readOnly", "included", "warning"], {
    type: enumSchema(["volume", "bind", "tmpfs", "compose_working_dir", "manual"]),
    containerName: stringOrNullSchema,
    source: stringOrNullSchema,
    name: stringOrNullSchema,
    destination: { type: "string" },
    readOnly: { type: "boolean" },
    included: { type: "boolean" },
    warning: stringOrNullSchema
  }),
  RecoveryAnalysis: object(["hostId", "appIdentity", "profile", "status", "recommendedCaptureMode", "dataMounts", "volumes", "bindMounts", "warnings", "blockingIssues"], {
    hostId: idSchema,
    appIdentity: schemaRef("RecoveryAppIdentity"),
    profile: { anyOf: [schemaRef("RecoveryProfile"), { type: "null" }] },
    status: enumSchema(["ready", "warning", "blocked"]),
    recommendedCaptureMode: enumSchema(["hot", "stop_first"]),
    dataMounts: arrayOf(schemaRef("RecoveryDataMount")),
    volumes: arrayOf({ type: "string" }),
    bindMounts: arrayOf({ type: "string" }),
    warnings: arrayOf({ type: "string" }),
    blockingIssues: arrayOf({ type: "string" })
  }),
  RecoveryAnalysisResponse: namedItemResponse("analysis", schemaRef("RecoveryAnalysis")),
  RecoveryReadinessReason: object(["code", "severity", "message"], {
    code: { type: "string" },
    severity: enumSchema(["info", "warning", "critical"]),
    message: { type: "string" },
    action: { type: "string" }
  }),
  RecoveryReadinessPoint: object(["id", "status", "createdAt", "completedAt", "verified", "artifactCount", "completedArtifactCount", "backupTargetId", "localUsable", "remoteUsable", "error"], {
    id: idSchema,
    status: enumSchema(["queued", "running", "completed", "partial", "failed"]),
    createdAt: dateTimeSchema,
    completedAt: stringOrNullSchema,
    verified: { type: "boolean" },
    artifactCount: { type: "number" },
    completedArtifactCount: { type: "number" },
    backupTargetId: idOrNullSchema,
    localUsable: { type: "boolean" },
    remoteUsable: { type: "boolean" },
    error: stringOrNullSchema
  }),
  RecoveryReadinessDrill: object(["lastDrillAt", "lastDrillStatus", "lastDrillError", "lastSuccessfulDrillAt", "passed"], {
    lastDrillAt: stringOrNullSchema,
    lastDrillStatus: stringOrNullSchema,
    lastDrillError: stringOrNullSchema,
    lastSuccessfulDrillAt: stringOrNullSchema,
    passed: { type: "boolean" }
  }),
  RecoveryReadinessTargetHealth: object(["targetId", "targetName", "status", "checkedAt", "error"], {
    targetId: idOrNullSchema,
    targetName: stringOrNullSchema,
    status: { type: ["string", "null"], enum: ["unknown", "healthy", "failed", null] },
    checkedAt: stringOrNullSchema,
    error: stringOrNullSchema
  }),
  RecoveryReadiness: object(["hostId", "appIdentity", "label", "status", "score", "reasons", "recommendedCaptureMode", "lastRecoveryPoint", "lastDrill", "profile", "targetHealth", "dataMounts"], {
    hostId: idSchema,
    appIdentity: schemaRef("RecoveryAppIdentity"),
    label: { type: "string" },
    status: enumSchema(["ready", "needs_profile", "risky", "blocked"]),
    score: { type: "number", minimum: 0, maximum: 100 },
    reasons: arrayOf(schemaRef("RecoveryReadinessReason")),
    recommendedCaptureMode: enumSchema(["hot", "stop_first"]),
    lastRecoveryPoint: { anyOf: [schemaRef("RecoveryReadinessPoint"), { type: "null" }] },
    lastDrill: { anyOf: [schemaRef("RecoveryReadinessDrill"), { type: "null" }] },
    profile: { anyOf: [schemaRef("RecoveryProfile"), { type: "null" }] },
    targetHealth: { anyOf: [schemaRef("RecoveryReadinessTargetHealth"), { type: "null" }] },
    dataMounts: arrayOf(schemaRef("RecoveryDataMount"))
  }),
  RecoveryReadinessListResponse: namedArrayResponse("readiness", schemaRef("RecoveryReadiness")),
  RecoveryReadinessResponse: namedItemResponse("readiness", schemaRef("RecoveryReadiness")),
  RecoveryPoint: object(["id", "hostId", "name", "appIdentity", "triggerKind", "status", "artifactCount", "completedArtifactCount", "totalBytes", "metadata", "createdAt"], {
    id: idSchema,
    hostId: idSchema,
    name: { type: "string" },
    appIdentity: recordSchema,
    triggerKind: { type: "string" },
    status: { type: "string" },
    backupTargetId: idOrNullSchema,
    legacyVolumeBackupId: idOrNullSchema,
    artifactCount: { type: "number" },
    completedArtifactCount: { type: "number" },
    totalBytes: { type: "number" },
    error: stringOrNullSchema,
    metadata: recordSchema,
    createdAt: dateTimeSchema,
    startedAt: stringOrNullSchema,
    completedAt: stringOrNullSchema,
    lastDrillAt: stringOrNullSchema,
    lastDrillStatus: stringOrNullSchema,
    lastDrillError: stringOrNullSchema,
    lastSuccessfulDrillAt: stringOrNullSchema
  }),
  RecoveryPointsResponse: namedArrayResponse("points", schemaRef("RecoveryPoint")),
  RecoveryPointJobResponse: object(["point", "job"], { point: schemaRef("RecoveryPoint"), job: schemaRef("OperationJob") }),
  RecoveryDrillResponse: object(["point", "job"], { point: schemaRef("RecoveryPoint"), job: schemaRef("OperationJob") }),
  AppsResponse: namedArrayResponse("apps", objectSchema),
  ImageUpdateCheck: object(["id", "hostId", "imageReference", "status", "lastCheckedAt"], {
    id: idSchema,
    hostId: idSchema,
    imageReference: { type: "string" },
    currentDigest: stringOrNullSchema,
    remoteDigest: stringOrNullSchema,
    status: { type: "string" },
    riskNote: stringOrNullSchema,
    credentialHint: stringOrNullSchema,
    safeAction: stringOrNullSchema,
    affectedContainers: arrayOf(recordSchema),
    affectedStacks: arrayOf(recordSchema),
    severityCounts: recordSchema,
    lastCheckedAt: dateTimeSchema
  }),
  ImageUpdatesResponse: namedArrayResponse("updates", schemaRef("ImageUpdateCheck")),
  ImageUpdatePreviewResponse: namedItemResponse("preview", objectSchema),
  ImageScannerStatusResponse: namedItemResponse("status", object(["provider", "available", "guidance"], {
    provider: { type: "string" },
    effectiveProvider: stringOrNullSchema,
    available: { type: "boolean" },
    trivyVersion: stringOrNullSchema,
    error: stringOrNullSchema,
    guidance: { type: "string" }
  }, true)),
  NotificationChannel: object(["id", "name", "type", "emailTo", "webhookUrl", "enabled", "createdAt", "updatedAt"], {
    id: idSchema,
    name: { type: "string" },
    type: enumSchema(["email", "webhook"]),
    emailTo: stringOrNullSchema,
    webhookUrl: stringOrNullSchema,
    enabled: { type: "boolean" },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema
  }),
  NotificationChannelsResponse: namedArrayResponse("channels", schemaRef("NotificationChannel")),
  NotificationChannelResponse: namedItemResponse("channel", schemaRef("NotificationChannel")),
  AlertChannelTestEvent: object(["id", "channelId", "status", "error", "testedBy", "testedAt"], {
    id: idSchema,
    channelId: idSchema,
    status: enumSchema(["success", "failed"]),
    error: stringOrNullSchema,
    testedBy: idOrNullSchema,
    testedAt: dateTimeSchema
  }),
  AlertChannelTestResponse: object(["ok", "event"], { ok: { type: "boolean" }, event: schemaRef("AlertChannelTestEvent") }),
  AlertChannelTestHistoryResponse: namedArrayResponse("events", schemaRef("AlertChannelTestEvent")),
  AlertRule: object(["id", "name", "condition", "hostId", "containerId", "channelId", "enabled", "params", "breachingSince", "lastState", "lastCheckedAt", "lastNotifiedAt", "lastError", "createdAt", "updatedAt"], {
    id: idSchema,
    name: { type: "string" },
    condition: enumSchema(["host.offline", "container.not_running", "host.cpu", "host.memory", "host.disk", "host.swap", "host.load"]),
    hostId: idSchema,
    containerId: stringOrNullSchema,
    channelId: idSchema,
    enabled: { type: "boolean" },
    params: { anyOf: [recordSchema, { type: "null" }] },
    breachingSince: stringOrNullSchema,
    lastState: stringOrNullSchema,
    lastCheckedAt: stringOrNullSchema,
    lastNotifiedAt: stringOrNullSchema,
    lastError: stringOrNullSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema
  }),
  AlertRulesResponse: namedArrayResponse("rules", schemaRef("AlertRule")),
  AlertRuleResponse: namedItemResponse("rule", schemaRef("AlertRule")),
  AlertSilence: object(["id", "name", "hostId", "ruleId", "startsAt", "endsAt", "reason", "createdBy", "createdAt"], {
    id: idSchema,
    name: { type: "string" },
    hostId: idOrNullSchema,
    ruleId: idOrNullSchema,
    startsAt: dateTimeSchema,
    endsAt: dateTimeSchema,
    reason: stringOrNullSchema,
    createdBy: idOrNullSchema,
    createdAt: dateTimeSchema
  }),
  AlertSilencesResponse: namedArrayResponse("silences", schemaRef("AlertSilence")),
  AlertSilenceResponse: namedItemResponse("silence", schemaRef("AlertSilence")),
  AlertEvent: object(["id", "ruleId", "hostId", "channelId", "state", "message", "notified", "silenced", "error", "createdAt"], {
    id: idSchema,
    ruleId: idOrNullSchema,
    hostId: idOrNullSchema,
    channelId: idOrNullSchema,
    state: { type: "string" },
    message: { type: "string" },
    notified: { type: "boolean" },
    silenced: { type: "boolean" },
    error: stringOrNullSchema,
    createdAt: dateTimeSchema
  }),
  AlertHistoryResponse: namedArrayResponse("events", schemaRef("AlertEvent")),
  AuditEvent: object(["id", "userId", "hostId", "action", "targetKind", "targetId", "details", "createdAt"], {
    id: idSchema,
    userId: idOrNullSchema,
    hostId: idOrNullSchema,
    action: { type: "string" },
    targetKind: stringOrNullSchema,
    targetId: stringOrNullSchema,
    details: recordSchema,
    createdAt: dateTimeSchema
  }),
  AuditEventsResponse: namedArrayResponse("events", schemaRef("AuditEvent"), {
    total: { type: "number" },
    limit: { type: "number" },
    offset: { type: "number" }
  }),
  UsersResponse: namedArrayResponse("users", schemaRef("AdminUser"))
};

const response = (description: string, schema: Record<string, unknown> = { type: "object" }) => ({
  description,
  content: {
    "application/json": {
      schema
    }
  }
});

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of openApiRoutes) {
    const item = paths[route.path] ?? {};
    item[route.method] = {
      summary: route.summary,
      tags: route.tags,
      security: route.auth === "public" ? [] : [{ cookieSession: [] }],
      responses: {
        "200": route.streaming
          ? { description: "Event stream" }
          : route.download
            ? { description: "File download stream" }
            : route.websocket
              ? { description: "WebSocket upgrade" }
          : response("Successful response", route.responseSchema ?? { type: "object" }),
        "400": response("Validation failed", { $ref: "#/components/schemas/Error" }),
        "401": response("Authentication required", { $ref: "#/components/schemas/Error" }),
        "403": response("Insufficient permissions", { $ref: "#/components/schemas/Error" }),
        "404": response("Not found", { $ref: "#/components/schemas/Error" })
      }
    };
    paths[route.path] = item;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "ComposeBastion API",
      version: OPENAPI_VERSION,
      description: "Pre-1.0 API contract. Stable JSON endpoints are available under /api/v1 while legacy /api routes remain compatible."
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: "cb_session"
        }
      },
      schemas: componentSchemas
    },
    paths
  };
}

export function buildOpenApiMarkdown() {
  const lines = [
    "# ComposeBastion OpenAPI",
    "",
    "Generated from `apps/api/src/openapi/document.ts`.",
    "",
    "Stable JSON endpoints are documented under `/api/v1/*`. Existing `/api/*` endpoints remain compatibility aliases before 1.0.",
    "",
    "| Method | Path | Auth | Summary |",
    "|--------|------|------|---------|"
  ];
  for (const route of openApiRoutes) {
    lines.push(`| ${route.method.toUpperCase()} | \`${route.path}\` | ${route.auth} | ${route.summary} |`);
  }
  lines.push("");
  lines.push("## Non-JSON Contracts");
  lines.push("");
  for (const route of openApiRoutes.filter((item) => item.streaming || item.download || item.websocket)) {
    lines.push(`### ${route.method.toUpperCase()} ${route.path}`);
    lines.push("");
    lines.push(`Auth: ${route.auth}.`);
    if (route.streaming) lines.push("Transport: Server-Sent Events (`text/event-stream`).");
    if (route.download) lines.push("Transport: attachment download stream.");
    if (route.websocket) lines.push("Transport: WebSocket upgrade.");
    for (const note of route.notes ?? []) lines.push(`- ${note}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
