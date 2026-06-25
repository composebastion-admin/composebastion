import { z } from "zod";

const idSchema = z.string().uuid();
const composeProjectNameSchema = z.string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use lowercase letters, numbers, hyphens, or underscores, and start with a letter or number");

export const stackVersionSourceSchema = z.enum([
  "ui",
  "catalog",
  "github",
  "host_files",
  "rollback",
  "deploy",
  "proxy_labels"
]);

export const composeStackProxySchema = z.object({
  domains: z.array(z.string().min(1).max(255)).default([]),
  exposedService: z.string().max(80).optional(),
  exposedPort: z.coerce.number().int().min(1).max(65535).optional(),
  tlsDesired: z.boolean().default(false),
  updatePolicyEnabled: z.boolean().default(false),
  updatePolicyChannel: z.enum(["digest", "patch", "minor"]).optional()
});

export const composeStackVersionSchema = z.object({
  id: idSchema,
  stackId: idSchema,
  versionNumber: z.number().int().positive(),
  composeYaml: z.string(),
  env: z.string(),
  source: stackVersionSourceSchema,
  note: z.string().nullable(),
  createdBy: idSchema.nullable(),
  createdAt: z.string()
});

export const stackVersionDiffSchema = z.object({
  fromVersionId: idSchema,
  toVersionId: idSchema,
  fromVersionNumber: z.number().int(),
  toVersionNumber: z.number().int(),
  composeChanges: z.array(z.object({
    type: z.enum(["add", "remove", "change"]),
    line: z.number(),
    text: z.string()
  })),
  envChanged: z.boolean()
});

export const catalogDeploySchema = z.object({
  templateId: z.string().min(1),
  hostId: idSchema,
  projectName: composeProjectNameSchema,
  name: z.string().min(1).max(80).optional(),
  env: z.record(z.string()).default({}),
  composeYaml: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
  proxy: composeStackProxySchema.optional()
});

export const stackRollbackSchema = z.object({
  versionId: idSchema,
  note: z.string().max(500).optional()
});

export const imageUpdateStatusSchema = z.enum([
  "up_to_date",
  "update_available",
  "unknown",
  "error",
  "local"
]);

export const imageUpdateCheckSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  imageReference: z.string(),
  currentDigest: z.string().nullable(),
  remoteDigest: z.string().nullable(),
  status: imageUpdateStatusSchema,
  riskNote: z.string().nullable(),
  affectedContainers: z.array(z.object({ id: z.string(), name: z.string() })),
  affectedStacks: z.array(z.object({ id: z.string(), name: z.string() })),
  lastCheckedAt: z.string(),
  severityCounts: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative()
  }).optional()
});

export const dockerAppSourceSchema = z.enum(["image", "compose", "git", "unknown"]);
export const dockerAppUpdateKindSchema = z.enum(["image", "git", "none"]);
export const appSourceLinkTypeSchema = z.enum(["image", "compose", "git"]);
export const appGithubVersionKindSchema = z.enum(["branch", "tag", "release"]);

export const appSourceLinkInputSchema = z.object({
  sourceType: appSourceLinkTypeSchema,
  name: z.string().trim().min(1).max(120).nullable().optional(),
  repositoryUrl: z.string().trim().max(500).nullable().optional(),
  branch: z.string().trim().max(120).nullable().optional(),
  workingDir: z.string().trim().max(500).nullable().optional(),
  composePath: z.string().trim().max(500).nullable().optional(),
  imageReference: z.string().trim().max(500).nullable().optional()
}).superRefine((value, ctx) => {
  if (value.sourceType === "image" && !value.imageReference) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Image reference is required", path: ["imageReference"] });
  }
  if ((value.sourceType === "compose" || value.sourceType === "git") && !value.workingDir) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Working directory is required", path: ["workingDir"] });
  }
  if ((value.sourceType === "compose" || value.sourceType === "git") && !value.composePath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Compose path is required", path: ["composePath"] });
  }
});

export const appSourceLinkSchema = z.object({
  id: idSchema,
  sourceType: appSourceLinkTypeSchema,
  name: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  branch: z.string().nullable(),
  workingDir: z.string().nullable(),
  composePath: z.string().nullable(),
  imageReference: z.string().nullable(),
  currentCommitSha: z.string().nullable(),
  latestCommitSha: z.string().nullable(),
  checkedAt: z.string().nullable(),
  checkError: z.string().nullable(),
  updatedAt: z.string()
});

export const dockerAppUpdateSchema = z.object({
  status: imageUpdateStatusSchema,
  kind: dockerAppUpdateKindSchema,
  imageReference: z.string().nullable().optional(),
  currentDigest: z.string().nullable().optional(),
  remoteDigest: z.string().nullable().optional(),
  currentVersion: z.string().nullable().optional(),
  availableVersion: z.string().nullable().optional(),
  checkedAt: z.string().nullable().optional(),
  riskNote: z.string().nullable().optional()
});

export const dockerAppSchema = z.object({
  id: z.string(),
  hostId: idSchema,
  hostName: z.string(),
  hostHostname: z.string(),
  name: z.string(),
  source: dockerAppSourceSchema,
  status: z.string(),
  imageReferences: z.array(z.string()),
  ports: z.string(),
  containerIds: z.array(z.string()),
  primaryContainerId: z.string().nullable(),
  stackId: idSchema.nullable(),
  repositoryId: idSchema.nullable(),
  repositoryUrl: z.string().nullable(),
  branch: z.string().nullable(),
  projectName: z.string().nullable(),
  sourceLink: appSourceLinkSchema.nullable(),
  update: dockerAppUpdateSchema,
  updatedAt: z.string()
});

export const appGithubVersionOptionSchema = z.object({
  kind: appGithubVersionKindSchema,
  name: z.string(),
  ref: z.string(),
  label: z.string(),
  commitSha: z.string().nullable(),
  publishedAt: z.string().nullable(),
  htmlUrl: z.string().nullable(),
  selected: z.boolean(),
  deployed: z.boolean(),
  updateAvailable: z.boolean()
});

export const appGithubVersionsSchema = z.object({
  repositoryUrl: z.string(),
  selectedRef: z.string().nullable(),
  currentCommitSha: z.string().nullable(),
  options: z.array(appGithubVersionOptionSchema)
});

export const appGithubVersionSelectSchema = z.object({
  ref: z.string().trim().min(1).max(255),
  kind: appGithubVersionKindSchema.optional()
});

export const appRenameInputSchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export const imageScanRequestSchema = z.object({
  hostId: idSchema,
  imageReference: z.string().min(1)
});

export const imageScanResultSchema = z.object({
  id: idSchema,
  hostId: idSchema,
  imageReference: z.string(),
  imageDigest: z.string().nullable(),
  scanner: z.string(),
  severityCounts: z.object({
    critical: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    low: z.number().int().nonnegative()
  }),
  generatedAt: z.string()
});

export const imageScannerStatusSchema = z.object({
  provider: z.enum(["auto", "mock", "trivy"]),
  effectiveProvider: z.enum(["mock", "trivy"]),
  available: z.boolean(),
  trivyVersion: z.string().nullable(),
  error: z.string().nullable(),
  guidance: z.string()
});

export const imageUpdatePreviewSchema = z.object({
  hostId: idSchema,
  imageReference: z.string(),
  status: imageUpdateStatusSchema,
  currentDigest: z.string().nullable(),
  remoteDigest: z.string().nullable(),
  riskNote: z.string().nullable(),
  credentialHint: z.string().nullable(),
  safeAction: z.enum(["none", "pull", "update_container", "redeploy_stack", "add_credentials", "scan_first"]),
  affectedContainers: imageUpdateCheckSchema.shape.affectedContainers,
  affectedStacks: imageUpdateCheckSchema.shape.affectedStacks,
  severityCounts: imageUpdateCheckSchema.shape.severityCounts.optional()
});

export const proxySnippetSchema = z.object({
  traefikLabels: z.array(z.string()),
  caddySnippet: z.string(),
  warnings: z.array(z.string())
});

export const composeStackExtendedSchema = z.object({
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
  createdAt: z.string(),
  updatedAt: z.string()
});

export type StackVersionSource = z.infer<typeof stackVersionSourceSchema>;
export type ComposeStackVersion = z.infer<typeof composeStackVersionSchema>;
export type CatalogDeployRequest = z.infer<typeof catalogDeploySchema>;
export type ImageUpdateCheck = z.infer<typeof imageUpdateCheckSchema>;
export type DockerApp = z.infer<typeof dockerAppSchema>;
export type DockerAppUpdate = z.infer<typeof dockerAppUpdateSchema>;
export type AppSourceLink = z.infer<typeof appSourceLinkSchema>;
export type AppSourceLinkInput = z.infer<typeof appSourceLinkInputSchema>;
export type AppGithubVersionKind = z.infer<typeof appGithubVersionKindSchema>;
export type AppGithubVersionOption = z.infer<typeof appGithubVersionOptionSchema>;
export type AppGithubVersions = z.infer<typeof appGithubVersionsSchema>;
export type AppGithubVersionSelect = z.infer<typeof appGithubVersionSelectSchema>;
export type AppRenameInput = z.infer<typeof appRenameInputSchema>;
export type ImageScanResult = z.infer<typeof imageScanResultSchema>;
export type ImageScannerStatus = z.infer<typeof imageScannerStatusSchema>;
export type ImageUpdatePreview = z.infer<typeof imageUpdatePreviewSchema>;
export type ProxySnippet = z.infer<typeof proxySnippetSchema>;
