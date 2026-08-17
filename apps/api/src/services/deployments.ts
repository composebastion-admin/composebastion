import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { v4 as uuid } from "uuid";
import type { PoolClient, QueryResultRow } from "pg";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  canonicalizeGitRepositoryUrl,
  canonicalizePlaintextHttpSourceUrl,
  deploymentAnalysisCreateSchema,
  deploymentAnalysisDeploySchema,
  deploymentAnalysisSchema,
  deploymentSourceSchema,
  deploymentSourceCreateSchema,
  deploymentSourceUpdateSchema,
  normalizeRegistryAuthority,
  registryTrustSchema,
  sanitizeDeploymentSourceLocator,
  sanitizeUrlDiagnosticText,
  type DeploymentAnalysis,
  type DeploymentSource,
  type DeploymentSourceType
} from "@composebastion/shared";
import { query, withTransaction } from "../db/pool.js";
import { shQuote } from "./commands.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { executeDockerAction, runDocker } from "./docker.js";
import {
  dockerMutationAdmissionKeys,
  dockerMutationScope,
  dockerMutationScopesConflict,
  RECONCILABLE_DOCKER_MUTATION_TYPES
} from "./dockerMutationScope.js";
import { statHostPath } from "./files.js";
import { getHostForWorker, listHostIds } from "./hosts.js";
import { findRegistryAuthForReference } from "./imageUpdates.js";
import {
  enqueueJobInTransaction,
  notifyJobQueued,
  type JobExecutionFence
} from "./jobs.js";
import {
  lockRegistryCredentialsForDeployment,
  registryCredentialIdsForImages
} from "./registries.js";
import { guardedRegistryRequest, type RegistryResolver } from "./registryHttp.js";
import { parseImageReference } from "./registryManifest.js";
import {
  hasReconciledRemoteOutcome,
  REMOTE_OUTCOME_RECONCILIATION_KEY
} from "./remoteOutcomeReconciliation.js";
import {
  GitComposeSourceIntegrityError,
  gitComposeCheckoutCleanGuardCommands,
  inspectGitComposeSourceIntegrity,
  type GitComposeSourceIntegrity
} from "./gitComposeIntegrity.js";
import {
  deploymentEnvironmentBinding,
  interpolateDeploymentEnvironment,
  parseDeploymentEnvironment,
  redactErrorSensitiveValues,
  SENSITIVE_ENVIRONMENT_NAME,
  sensitiveDeploymentEnvironmentValues,
  serializeDeploymentEnvironment
} from "./deploymentEnvironment.js";
import { extractImagesFromCompose } from "./composeImages.js";
import {
  currentRemoteMutationContext,
  isRemoteMutationOutcomeUnknown,
  withRemoteMutationContext
} from "./remoteMutationProof.js";
import { registryTrustArtifactPaths } from "./registryTrustArtifacts.js";
import { readRemoteFile, runSshCommand, writeRemoteFile } from "./ssh.js";

const ANALYSIS_TTL_HOURS = 2;
const MAX_COMPOSE_BYTES = 512 * 1024;
const SECRET_NAME = SENSITIVE_ENVIRONMENT_NAME;
const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const COMPOSE_FILE = /(^|\/)(?:compose|docker-compose)\.ya?ml$/i;
const SAFE_PROJECT = /[^a-z0-9_-]+/g;
const GIT_CREDENTIAL_MAX_AGE_MINUTES = 15;
const GIT_CREDENTIAL_DIRECTORY_TEMPLATE = "/tmp/composebastion-git-XXXXXXXXXX";
const GIT_CREDENTIAL_DIRECTORY_PATTERN = /^\/tmp\/composebastion-git-[A-Za-z0-9]{6,}$/;
const GIT_CREDENTIAL_OWNER_FILE = ".composebastion-owner";
const GIT_CREDENTIAL_OWNER_PREFIX = "composebastion-git-credentials-v1";
const GIT_CREDENTIAL_FILE = "credentials";
const GIT_ASKPASS_FILE = "askpass";
const DEPLOYMENT_ANALYSIS_OWNER_FILE = ".composebastion-owner";
const DEPLOYMENT_ANALYSIS_OWNER_PREFIX = "composebastion-deployment-analysis-v1";
const DEPLOYMENT_ANALYSIS_CHECKOUT_OWNER_FILE = "composebastion-owner";
const UUID_PATH_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DeploymentJobContext = {
  jobId: string;
  attemptCount: number;
};

type DeploymentAnalysisAttempt = {
  token: string;
  directory: string;
  checkoutDirectory: string;
  ownerRecord: string;
};

export class DeploymentRemoteOutcomeUnknownError extends Error {
  readonly code = "DEPLOYMENT_REMOTE_OUTCOME_UNKNOWN";

  constructor(
    readonly analysisId: string,
    readonly phase: string,
    cause: unknown
  ) {
    super(
      `REMOTE_OUTCOME_UNKNOWN: Deployment phase '${phase}' may have changed the remote host. `
      + "Reconcile the recorded project and working directory before retrying.",
      { cause }
    );
    this.name = "DeploymentRemoteOutcomeUnknownError";
  }
}

export class RegistryTrustRemoteOutcomeUnknownError extends Error {
  readonly code = "REGISTRY_TRUST_REMOTE_OUTCOME_UNKNOWN";

  constructor(
    readonly hostId: string,
    readonly registry: string,
    cause: unknown
  ) {
    super(
      "REMOTE_OUTCOME_UNKNOWN: Docker registry trust configuration may have been installed or Docker may have restarted. "
      + "Inspect /etc/docker/daemon.json and Docker readiness before retrying.",
      { cause }
    );
    this.name = "RegistryTrustRemoteOutcomeUnknownError";
  }
}

export class RegistryTrustCandidateCleanupRequiredError extends Error {
  readonly code = "REGISTRY_TRUST_CANDIDATE_CLEANUP_REQUIRED";

  constructor(cause: unknown) {
    super(
      "REMOTE_OUTCOME_UNKNOWN: The registry trust operation is terminal, but its owned temporary candidate could not be removed. Reconciliation must complete cleanup before this target is retried.",
      { cause }
    );
    this.name = "RegistryTrustCandidateCleanupRequiredError";
  }
}

function isJobLeaseLost(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "JOB_LEASE_LOST"
  );
}

async function executionCheckpoint(executionFence?: JobExecutionFence) {
  await executionFence?.assertActive();
}

async function executionQuery<T extends QueryResultRow = any>(
  executionFence: JobExecutionFence | undefined,
  text: string,
  values: unknown[] = []
) {
  return executionFence
    ? executionFence.withActiveLease((client) => client.query<T>(text, values))
    : query<T>(text, values);
}

async function withExecutionLease<T>(
  executionFence: JobExecutionFence | undefined,
  callback: (client: PoolClient) => Promise<T>
) {
  return executionFence
    ? executionFence.withActiveLease(callback)
    : withTransaction(callback);
}

async function runDeploymentRemoteMutation<T>(
  analysisId: string,
  phase: string,
  executionFence: JobExecutionFence | undefined,
  operation: () => Promise<T>,
  evidence: Record<string, unknown> = {}
) {
  await executionCheckpoint(executionFence);
  return withRemoteMutationContext(executionFence, phase, async () => {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const code = error
        && typeof error === "object"
        && "code" in error
        ? String(error.code)
        : "";
      if (
        !isJobLeaseLost(error)
        && !isRemoteMutationOutcomeUnknown(error)
        && code !== "DOCKER_REMOTE_OUTCOME_UNKNOWN"
      ) {
        throw error;
      }
      console.warn("worker.deployment.remote_outcome_unknown", {
        analysisId,
        phase,
        ...evidence
      });
      throw new DeploymentRemoteOutcomeUnknownError(
        analysisId,
        phase,
        error
      );
    }
    try {
      await executionCheckpoint(executionFence);
    } catch (error) {
      console.warn("worker.deployment.remote_outcome_unknown", {
        analysisId,
        phase,
        ...evidence
      });
      throw new DeploymentRemoteOutcomeUnknownError(
        analysisId,
        phase,
        error
      );
    }
    return result;
  });
}

type Warning = { code: string; message: string };
type Variable = {
  key: string;
  value: string;
  defaultValue: string | null;
  required: boolean;
  secret: boolean;
  source: "compose" | "example_env" | "image" | "user";
};
type ServiceSummary = {
  name: string;
  image: string | null;
  build: string | null;
  ports: string[];
  volumes: string[];
};
type AnalysisResult = {
  sourceLocator: string;
  displayName: string;
  projectName: string;
  branch: string | null;
  composePath: string;
  workingDir: string;
  composeYaml: string;
  env: string;
  stagingDirectory: string | null;
  sourceRevision?: string | null;
  summary: {
    services: ServiceSummary[];
    composeCandidates: string[];
    dockerfileGenerated: boolean;
    trackedEnvFile: boolean;
  };
  variables: Variable[];
  warnings: Warning[];
  blockers: Warning[];
  registryIssues: Array<{
    registry: string;
    insecure: boolean;
    trusted: boolean;
    canApply: boolean;
    message: string;
  }>;
};

const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function composeSha256(composeYaml: string) {
  return createHash("sha256").update(composeYaml, "utf8").digest("hex");
}

function environmentSha256(environment: string) {
  return deploymentEnvironmentBinding(environment);
}

function exactGitRevision(value: unknown) {
  const revision = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!GIT_REVISION.test(revision)) {
    throw new Error(
      "The analyzed Git revision is missing or invalid. Analyze the repository again."
    );
  }
  return revision;
}

function exactComposeSha256(value: unknown) {
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX.test(digest)) {
    throw new Error(
      "The analyzed Compose digest is missing or invalid. Analyze the source again."
    );
  }
  return digest;
}

function exactEnvironmentSha256(value: unknown) {
  const digest = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX.test(digest)) {
    throw new Error(
      "The analyzed environment digest is missing or invalid. Analyze the source again."
    );
  }
  return digest;
}

function iso(value: Date | string | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

function jsonValue<T>(value: unknown, fallback: T): T {
  return value && typeof value === "object" ? value as T : fallback;
}

function mapSource(row: any): DeploymentSource {
  const savedEnvironment = row.env_encrypted ? rawEnvValues(decryptSecret(row.env_encrypted)) : new Map<string, string>();
  const safeEnvironment = Object.fromEntries(
    Array.from(savedEnvironment).filter(([key]) => !SECRET_NAME.test(key))
  );
  return deploymentSourceSchema.parse({
    id: row.id,
    sourceType: row.source_type,
    name: row.name,
    sourceLocator: sanitizeDeploymentSourceLocator(row.source_locator, row.source_type) ?? "",
    branch: row.branch ?? null,
    composePath: row.compose_path ?? null,
    workingDir: row.working_dir ?? null,
    projectName: row.project_name,
    defaultHostId: row.default_host_id ?? null,
    targetHostIds: Array.isArray(row.target_host_ids) ? row.target_host_ids : [],
    safeEnvironment,
    hasCredential: Boolean(row.credential_secret_encrypted),
    metadata: row.metadata ?? {},
    lastDeployedAt: iso(row.last_deployed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  });
}

function mapAnalysis(row: any, deriveExpiredStatus = true): DeploymentAnalysis {
  const status = deriveExpiredStatus
    && row.status !== "deployed"
    && new Date(row.expires_at).getTime() <= Date.now()
    ? "expired"
    : row.status;
  const analysisVariables = Array.isArray(row.variables) ? row.variables as Variable[] : [];
  const secretKeys = new Set(analysisVariables.filter((variable) => variable.secret).map((variable) => variable.key));
  const decryptedEnv = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
  for (const key of rawEnvValues(decryptedEnv).keys()) {
    if (SECRET_NAME.test(key)) secretKeys.add(key);
  }
  const protectedEnv = sanitizeEnvForResponse(decryptedEnv, secretKeys);
  return deploymentAnalysisSchema.parse({
    id: row.id,
    hostId: row.host_id,
    sourceId: row.source_id ?? null,
    sourceType: row.source_type,
    sourceInput: sanitizeDeploymentSourceLocator(row.source_input, row.source_type) ?? "",
    sourceLocator: row.source_locator === null || row.source_locator === undefined
      ? null
      : sanitizeDeploymentSourceLocator(row.source_locator, row.source_type),
    status,
    displayName: row.display_name ?? null,
    projectName: row.project_name ?? null,
    branch: row.branch ?? null,
    composePath: row.compose_path ?? null,
    workingDir: row.working_dir ?? null,
    composeYaml: row.compose_yaml ?? null,
    env: protectedEnv,
    summary: jsonValue(row.summary, {
      services: [],
      composeCandidates: [],
      dockerfileGenerated: false,
      trackedEnvFile: false
    }),
    variables: analysisVariables,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    blockers: Array.isArray(row.blockers) ? row.blockers : [],
    registryIssues: Array.isArray(row.registry_issues) ? row.registry_issues : [],
    error: sanitizeUrlDiagnosticText(row.error ?? null) as string | null,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deployedAt: iso(row.deployed_at)
  });
}

function projectName(value: string) {
  return value
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(SAFE_PROJECT, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9_-]+$/g, "")
    .slice(0, 80) || "deployed-app";
}

function displayName(value: string) {
  return value
    .replace(/\.git$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase()) || "Deployed App";
}

function sourceBasename(value: string) {
  try {
    const url = new URL(value);
    return path.posix.basename(url.pathname.replace(/\/$/, "")) || url.hostname;
  } catch {
    const scpPath = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value;
    return path.posix.basename(scpPath.replace(/\/$/, ""));
  }
}

function isYamlText(value: string) {
  return /^\s*(?:---\s*)?(?:name\s*:|version\s*:|services\s*:)/m.test(value) && /\bservices\s*:/m.test(value);
}

function isGitLikeUrl(value: string) {
  if (/^(?:git|ssh):\/\//i.test(value) || /^[^@\s]+@[^:\s]+:.+/.test(value)) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (COMPOSE_FILE.test(url.pathname)) return false;
    return /\.git\/?$/i.test(url.pathname)
      || /(?:github\.com|gitlab\.com|bitbucket\.org)$/i.test(url.hostname)
      || url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

export function detectDeploymentSourceType(
  source: string,
  composeYaml?: string
): DeploymentSourceType {
  const value = source.trim();
  if (composeYaml || isYamlText(value)) return "compose_upload";
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (COMPOSE_FILE.test(url.pathname)) return "compose_url";
    if (/[:@][^/]+$/.test(url.pathname)) return "image";
  }
  if (isGitLikeUrl(value)) return "git";
  return "image";
}

export function canonicalizeDeploymentSource(source: string, sourceType: DeploymentSourceType) {
  const value = source.trim();
  if (sourceType === "image" && /^https?:\/\//i.test(value)) {
    const checkedUrl = new URL(value);
    if (checkedUrl.username || checkedUrl.password) {
      throw Object.assign(
        new Error("URLs containing credentials are not accepted. Enter credentials in the protected credential fields."),
        { statusCode: 400 }
      );
    }
  }
  if (sourceType === "git") {
    try {
      return canonicalizeGitRepositoryUrl(value);
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : "Repository URL is invalid"),
        { statusCode: 400 }
      );
    }
  }
  if (sourceType === "image") {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      return `${url.host}${url.pathname}`.replace(/^\/|\/$/g, "");
    }
    return value.replace(/^docker:\/\//i, "").replace(/^\/|\/$/g, "");
  }
  if (sourceType === "compose_url") {
    try {
      return canonicalizePlaintextHttpSourceUrl(value);
    } catch (error) {
      throw Object.assign(
        new Error(
          `${error instanceof Error ? error.message : "Compose URL is invalid"}. `
          + "Private Compose URLs with credentials are not supported; upload the Compose file instead."
        ),
        { statusCode: 400 }
      );
    }
  }
  if (isYamlText(value)) {
    return `inline-compose:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  }
  return value || "uploaded-compose.yaml";
}

function homeDeploymentRoot(username: string) {
  return username === "root" ? "/root/composebastion" : `/home/${username}/composebastion`;
}

function deploymentAnalysisAttempt(
  username: string,
  analysisId: string,
  token = uuid()
): DeploymentAnalysisAttempt {
  const directory = path.posix.join(
    homeDeploymentRoot(username),
    ".analysis",
    analysisId,
    token
  );
  return {
    token,
    directory,
    checkoutDirectory: path.posix.join(directory, "checkout"),
    ownerRecord: `${DEPLOYMENT_ANALYSIS_OWNER_PREFIX}:${analysisId}:${token}`
  };
}

function expectedDeploymentAnalysisAttempt(
  username: string,
  analysisId: string,
  checkoutDirectory: string
): DeploymentAnalysisAttempt | null {
  const root = path.posix.join(homeDeploymentRoot(username), ".analysis", analysisId);
  const relative = path.posix.relative(root, checkoutDirectory);
  const [token, checkout, ...rest] = relative.split("/");
  if (
    rest.length
    || checkout !== "checkout"
    || !token
    || !UUID_PATH_SEGMENT.test(token)
    || path.posix.isAbsolute(relative)
    || relative.startsWith("../")
  ) {
    return null;
  }
  return deploymentAnalysisAttempt(username, analysisId, token);
}

function deploymentAnalysisLegacyStagingDirectory(username: string, analysisId: string) {
  return path.posix.join(homeDeploymentRoot(username), ".analysis", analysisId);
}

async function removeDeploymentAnalysisStaging(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  analysisId: string,
  stagingDirectory: string
) {
  const legacy = deploymentAnalysisLegacyStagingDirectory(host.public.username, analysisId);
  const attempt = expectedDeploymentAnalysisAttempt(
    host.public.username,
    analysisId,
    stagingDirectory
  );
  // Versions before the attempt-token ownership protocol wrote directly to
  // `.analysis/<analysisId>`. That path has no marker tying its present
  // inode/content to this database row, so an automated retry must never
  // recursively delete it: it may now belong to an operator or successor.
  if (stagingDirectory === legacy) {
    return { removed: false, code: "legacy_unowned" as const };
  }
  if (stagingDirectory !== legacy && !attempt) {
    return { removed: false, code: "path_mismatch" as const };
  }
  const removalDirectory = attempt?.directory ?? legacy;
  const lines = [
    `staging_directory=${shQuote(removalDirectory)}`,
    "if [ ! -e \"$staging_directory\" ] && [ ! -L \"$staging_directory\" ]; then exit 0; fi"
  ];
  if (attempt) {
    const ownerFile = path.posix.join(attempt.directory, DEPLOYMENT_ANALYSIS_OWNER_FILE);
    lines.push(
      `owner_file=${shQuote(ownerFile)}`,
      "if [ -L \"$staging_directory\" ] || [ ! -d \"$staging_directory\" ] || [ -L \"$owner_file\" ] || [ ! -f \"$owner_file\" ]; then exit 73; fi",
      `if [ "$(cat -- "$owner_file")" != ${shQuote(attempt.ownerRecord)} ]; then exit 74; fi`
    );
  }
  lines.push(
    "rm -rf -- \"$staging_directory\" || exit $?",
    "if [ -e \"$staging_directory\" ] || [ -L \"$staging_directory\" ]; then exit 75; fi"
  );
  const result = await runSshCommand(host.ssh, lines.join("\n"), { timeoutMs: 30_000 });
  return {
    removed: result.code === 0,
    code: result.code === 0 ? null : "remove_failed" as const,
    result,
    removalDirectory
  };
}

function scalar(value: unknown) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function summarizedPort(value: unknown) {
  const simple = scalar(value);
  if (simple) return simple;
  if (!value || typeof value !== "object") return null;
  const published = scalar((value as any).published);
  const target = scalar((value as any).target);
  if (!target) return null;
  const hostIp = scalar((value as any).host_ip);
  const protocol = scalar((value as any).protocol);
  return `${hostIp ? `${hostIp}:` : ""}${published ? `${published}:` : ""}${target}${protocol ? `/${protocol}` : ""}`;
}

function summarizeCompose(composeYaml: string): ServiceSummary[] {
  const parsed = parseYaml(composeYaml, { merge: true }) as any;
  if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object" || Array.isArray(parsed.services)) {
    throw Object.assign(new Error("The supplied YAML is not a valid Compose file: a services map is required."), { statusCode: 400 });
  }
  const services = Object.entries(parsed.services).map(([name, raw]) => {
    const service = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const build = typeof service.build === "string"
      ? service.build
      : service.build && typeof service.build === "object" ? scalar((service.build as any).context) : null;
    return {
      name,
      image: scalar(service.image),
      build,
      ports: Array.isArray(service.ports) ? service.ports.map(summarizedPort).filter((item): item is string => Boolean(item)) : [],
      volumes: Array.isArray(service.volumes) ? service.volumes.map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const source = scalar((item as any).source);
          const target = scalar((item as any).target);
          return source && target ? `${source}:${target}` : target;
        }
        return null;
      }).filter((item): item is string => Boolean(item)) : []
    };
  });
  if (services.length === 0) throw Object.assign(new Error("The Compose file does not define any services."), { statusCode: 400 });
  return services;
}

function parseEnvText(value: string, source: Variable["source"]) {
  const result = new Map<string, Variable>();
  for (const [key, entryValue] of parseDeploymentEnvironment(value)) {
    const secret = SECRET_NAME.test(key);
    result.set(key, {
      key,
      value: secret ? "" : entryValue,
      defaultValue: secret ? null : entryValue || null,
      required: secret || !entryValue,
      secret,
      source
    });
  }
  return result;
}

function rawEnvValues(value: string) {
  return parseDeploymentEnvironment(value);
}

function serializeEnv(values: Map<string, string>) {
  return serializeDeploymentEnvironment(values);
}

function sanitizeEnvForResponse(value: string, secretKeys: Set<string>) {
  const values = rawEnvValues(value);
  for (const key of secretKeys) {
    if (values.has(key)) values.set(key, "");
  }
  return serializeEnv(values);
}

function mergeStoredAnalysisEnv(
  generatedEnv: string,
  storedEnv: string,
  variables: Variable[]
) {
  const merged = rawEnvValues(generatedEnv);
  const stored = rawEnvValues(storedEnv);
  for (const [key, value] of stored) merged.set(key, value);
  const safeVariables = variables.map((variable) => ({
    ...variable,
    value: variable.secret ? "" : stored.get(variable.key) ?? variable.value
  }));
  return { env: serializeEnv(merged), variables: safeVariables };
}

function mergeRequestedEnv(
  storedEnv: string,
  requestedEnv: string,
  variables: Variable[]
) {
  const merged = rawEnvValues(storedEnv);
  const requested = rawEnvValues(requestedEnv);
  const secrets = new Set(variables.filter((variable) => variable.secret).map((variable) => variable.key));
  for (const [key, value] of requested) {
    if (secrets.has(key) && !value && merged.get(key)) continue;
    merged.set(key, value);
  }
  return serializeEnv(merged);
}

export function extractDeploymentVariables(composeYaml: string, exampleEnv = "") {
  const variables = parseEnvText(exampleEnv, "example_env");
  const expression = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g;
  for (const match of composeYaml.matchAll(expression)) {
    const key = match[1]!;
    const operator = match[2] ?? "";
    const rawDefault = match[3] ?? "";
    const hasDefault = operator.includes("-");
    const secret = SECRET_NAME.test(key);
    const existing = variables.get(key);
    const defaultValue = secret ? null : hasDefault ? rawDefault : existing?.defaultValue ?? null;
    variables.set(key, {
      key,
      value: secret ? "" : existing?.value || defaultValue || "",
      defaultValue,
      required: secret || operator.includes("?") || (!hasDefault && !existing?.value),
      secret,
      source: "compose"
    });
  }
  return Array.from(variables.values()).sort((left, right) => left.key.localeCompare(right.key));
}

function variablesToEnv(variables: Variable[]) {
  return serializeEnv(new Map(
    variables
      .filter((variable) => variable.value !== "" || !variable.required)
      .map((variable) => [variable.key, variable.value])
  ));
}

function referencedImages(services: ServiceSummary[], environment = "") {
  const values = rawEnvValues(environment);
  return services
    .map((service) => service.image
      ? interpolateDeploymentEnvironment(service.image, values)
      : null
    )
    .filter((image): image is string => Boolean(image && !image.includes("$")));
}

function normalizedGitUrl(value: string) {
  return value.trim().replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase();
}

type GitCredentialDirectory = {
  directory: string;
  ownerRecord: string;
  credentialFile: string;
  askpass: string;
};

function gitCredentialOwnerRecord(analysisId: string, ownerToken: string) {
  return `${GIT_CREDENTIAL_OWNER_PREFIX}:${analysisId}:${ownerToken}`;
}

function assertGitCredentialDirectoryPath(directory: string) {
  if (!GIT_CREDENTIAL_DIRECTORY_PATTERN.test(directory)) {
    throw new Error("Remote Git credential helper returned an invalid private directory path.");
  }
  return directory;
}

async function cleanupStaleGitCredentialFilesOnHost(
  host: Awaited<ReturnType<typeof getHostForWorker>>
) {
  if (host.connectionMode !== "ssh") return { cleaned: 0 };
  const staleLegacyFileCleanup = [
    "find /tmp -maxdepth 1 -type f",
    "\\(",
    "-name 'composebastion-git-*.askpass'",
    "-o",
    "-name 'composebastion-git-*.credentials'",
    "\\)",
    "-user \"$(id -un)\"",
    `-mmin +${GIT_CREDENTIAL_MAX_AGE_MINUTES}`,
    "-delete -print"
  ].join(" ");
  const staleDirectoryCleanup = [
    "find /tmp -maxdepth 1 -mindepth 1 -type d",
    "-name 'composebastion-git-*'",
    "-user \"$(id -un)\"",
    `-mmin +${GIT_CREDENTIAL_MAX_AGE_MINUTES}`,
    "-exec sh -c",
    shQuote([
      "for credential_directory do",
      `owner_file="$credential_directory/${GIT_CREDENTIAL_OWNER_FILE}"`,
      "if [ -L \"$credential_directory\" ] || [ ! -d \"$credential_directory\" ] || [ -L \"$owner_file\" ] || [ ! -f \"$owner_file\" ]; then continue; fi",
      `if ! grep -Eq '^${GIT_CREDENTIAL_OWNER_PREFIX}:[0-9a-f-]+:[0-9a-f-]+$' -- "$owner_file"; then continue; fi`,
      "rm -rf -- \"$credential_directory\" && printf '%s\\n' \"$credential_directory\"",
      "done"
    ].join("\n")),
    "sh {} +"
  ].join(" ");
  const result = await runSshCommand(
    host.ssh,
    [staleLegacyFileCleanup, staleDirectoryCleanup].join("\n"),
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) {
    throw new Error("Could not clean stale private Git credential files on the SSH host.");
  }
  return {
    cleaned: result.stdout.split(/\r?\n/).filter(Boolean).length
  };
}

export async function cleanupStaleDeploymentGitCredentialFiles() {
  const hostIds = await listHostIds();
  const results = await Promise.all(hostIds.map(async (hostId) => {
    try {
      const host = await getHostForWorker(hostId);
      const result = await cleanupStaleGitCredentialFilesOnHost(host);
      return { hostId, cleaned: result.cleaned, error: null };
    } catch (error) {
      return {
        hostId,
        cleaned: 0,
        error: sanitizeUrlDiagnosticText(error instanceof Error ? error.message : String(error))
      };
    }
  }));
  return {
    checked: hostIds.length,
    cleaned: results.reduce((total, result) => total + result.cleaned, 0),
    failures: results.filter((result) => result.error !== null)
  };
}

async function acquireGitCredentialDirectory(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  analysisId: string
): Promise<GitCredentialDirectory> {
  const ownerRecord = gitCredentialOwnerRecord(analysisId, uuid());
  const result = await runSshCommand(
    host.ssh,
    [
      "umask 077",
      `credential_directory="$(mktemp -d ${shQuote(GIT_CREDENTIAL_DIRECTORY_TEMPLATE)})" || exit $?`,
      "chmod 0700 -- \"$credential_directory\" || { rm -rf -- \"$credential_directory\"; exit 72; }",
      [
        "if ! (set -C",
        `printf '%s\\n' ${shQuote(ownerRecord)} > "$credential_directory/${GIT_CREDENTIAL_OWNER_FILE}"`,
        `: > "$credential_directory/${GIT_CREDENTIAL_FILE}"`,
        `: > "$credential_directory/${GIT_ASKPASS_FILE}")`
      ].join(" && "),
      [
        "then rm -rf -- \"$credential_directory\"",
        "printf '%s\\n' 'Could not exclusively create private Git credential files.' >&2",
        "exit 73",
        "fi"
      ].join("; "),
      "printf '%s\\n' \"$credential_directory\""
    ].join("; "),
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) {
    throw new Error("Could not atomically create a private Git credential directory on the SSH host.");
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("Remote Git credential helper returned an invalid private directory path.");
  }
  const directory = assertGitCredentialDirectoryPath(lines[0]!);
  return {
    directory,
    ownerRecord,
    credentialFile: path.posix.join(directory, GIT_CREDENTIAL_FILE),
    askpass: path.posix.join(directory, GIT_ASKPASS_FILE)
  };
}

async function removeGitCredentialDirectory(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  credential: GitCredentialDirectory
) {
  const directory = assertGitCredentialDirectoryPath(credential.directory);
  const ownerFile = path.posix.join(directory, GIT_CREDENTIAL_OWNER_FILE);
  const mismatchMessage = "Private Git credential directory ownership changed; refusing cleanup.";
  const result = await runSshCommand(
    host.ssh,
    [
      `if [ ! -e ${shQuote(directory)} ] && [ ! -L ${shQuote(directory)} ]; then exit 0; fi`,
      [
        `if [ -L ${shQuote(directory)} ]`,
        `|| [ ! -d ${shQuote(directory)} ]`,
        `|| [ -L ${shQuote(ownerFile)} ]`,
        `|| [ ! -f ${shQuote(ownerFile)} ]`,
        `then printf '%s\\n' ${shQuote(mismatchMessage)} >&2`,
        "exit 73",
        "fi"
      ].join(" "),
      `credential_owner="$(cat -- ${shQuote(ownerFile)})" || exit $?`,
      [
        `if [ "$credential_owner" != ${shQuote(credential.ownerRecord)} ]`,
        `then printf '%s\\n' ${shQuote(mismatchMessage)} >&2`,
        "exit 74",
        "fi"
      ].join("; "),
      `rm -rf -- ${shQuote(directory)}`
    ].join("; "),
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) {
    throw new Error("Could not safely remove the temporary private Git credential directory from the SSH host.");
  }
}

async function gitCredentialEnvironment(
  analysisId: string,
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  username: string | null,
  secret: string | null
) {
  if (!username || !secret) return { prefix: "GIT_TERMINAL_PROMPT=0", cleanup: async () => undefined };
  await cleanupStaleGitCredentialFilesOnHost(host);
  const credential = await acquireGitCredentialDirectory(host, analysisId);
  try {
    await writeRemoteFile(
      host.ssh,
      credential.credentialFile,
      `${Buffer.from(username).toString("base64")}\n${Buffer.from(secret).toString("base64")}\n`
    );
    const script = [
      "#!/bin/sh",
      "case \"$1\" in",
      `  *Username*) sed -n '1p' ${shQuote(credential.credentialFile)} | base64 -d ;;`,
      `  *) sed -n '2p' ${shQuote(credential.credentialFile)} | base64 -d ;;`,
      "esac",
      ""
    ].join("\n");
    await writeRemoteFile(host.ssh, credential.askpass, script);
    const chmod = await runSshCommand(
      host.ssh,
      [
        `if [ -L ${shQuote(credential.credentialFile)} ] || [ ! -f ${shQuote(credential.credentialFile)} ]`,
        `|| [ -L ${shQuote(credential.askpass)} ] || [ ! -f ${shQuote(credential.askpass)} ]`,
        "then exit 73; fi",
        `chmod 0700 ${shQuote(credential.askpass)}`
      ].join(" "),
      { timeoutMs: 30_000 }
    );
    if (chmod.code !== 0) throw new Error("Could not protect the temporary Git credential helper.");
  } catch (error) {
    if (isJobLeaseLost(error) || isRemoteMutationOutcomeUnknown(error)) {
      // The credential directory is private and has an age-based sweeper.
      // Never launch cleanup after an operation whose exact remote completion
      // is unknown; doing so would overwrite its durable proof and could race
      // the still-running primitive.
      throw error;
    }
    try {
      await removeGitCredentialDirectory(host, credential);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Private Git credential setup failed and its temporary files could not be removed"
      );
    }
    throw error;
  }
  return {
    prefix: `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=${shQuote(credential.askpass)}`,
    cleanup: () => removeGitCredentialDirectory(host, credential)
  };
}

async function runGit(
  analysisId: string,
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  command: string,
  credentialUsername: string | null,
  credentialSecret: string | null,
  timeoutMs = 60_000,
  executionFence?: JobExecutionFence
) {
  const operation = async () => {
    await executionCheckpoint(executionFence);
    const credential = await gitCredentialEnvironment(
      analysisId,
      host,
      credentialUsername,
      credentialSecret
    );
    let completed = false;
    let result: Awaited<ReturnType<typeof runSshCommand>> | undefined;
    let operationError: unknown;
    try {
      await executionCheckpoint(executionFence);
      result = await runSshCommand(
        host.ssh,
        `${credential.prefix} ${command}`,
        { timeoutMs }
      );
      completed = true;
    } catch (error) {
      operationError = error;
    }
    if (
      !completed
      && (
        isJobLeaseLost(operationError)
        || isRemoteMutationOutcomeUnknown(operationError)
      )
    ) {
      // Preserve the exact ambiguous operation marker. The private credential
      // sweeper will remove these files after the operation's hard bound.
      throw operationError;
    }
    let cleanupError: unknown;
    try {
      await credential.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    if (!completed) {
      if (cleanupError) {
        if (
          isJobLeaseLost(cleanupError)
          || isRemoteMutationOutcomeUnknown(cleanupError)
        ) {
          throw cleanupError;
        }
        throw new AggregateError(
          [operationError, cleanupError],
          "Private Git operation failed and its temporary credentials could not be removed"
        );
      }
      throw operationError;
    }
    if (cleanupError) {
      if (
        isJobLeaseLost(cleanupError)
        || isRemoteMutationOutcomeUnknown(cleanupError)
      ) {
        throw cleanupError;
      }
      throw new AggregateError(
        [cleanupError],
        "Private Git operation completed but its temporary credentials could not be removed"
      );
    }
    await executionCheckpoint(executionFence);
    return result!;
  };
  if (currentRemoteMutationContext() || !executionFence) {
    return operation();
  }
  return runDeploymentRemoteMutation(
    analysisId,
    "git-remote-operation",
    executionFence,
    operation,
    {
      hostId: host.public.id
    }
  );
}

async function readOptionalRemoteFile(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  remotePath: string
) {
  try {
    return await readRemoteFile(host.ssh, remotePath, MAX_COMPOSE_BYTES);
  } catch {
    return "";
  }
}

export function selectComposeCandidates(files: string[]) {
  const candidates = files
    .filter((file) => COMPOSE_FILE.test(file))
    .filter((file) => !/(^|\/)(?:node_modules|vendor|\.git)\//.test(file));
  return candidates.sort((left, right) => {
    const leftRoot = left.includes("/") ? 1 : 0;
    const rightRoot = right.includes("/") ? 1 : 0;
    if (leftRoot !== rightRoot) return leftRoot - rightRoot;
    const leftPriority = COMPOSE_NAMES.indexOf(path.posix.basename(left).toLowerCase());
    const rightPriority = COMPOSE_NAMES.indexOf(path.posix.basename(right).toLowerCase());
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.localeCompare(right);
  });
}

export function generatedDockerfileCompose(dockerfile: string, usedPorts = new Set<number>()) {
  const containerPorts = Array.from(dockerfile.matchAll(/^\s*EXPOSE\s+(.+)$/gmi))
    .flatMap((match) => (match[1] ?? "").split(/\s+/))
    .map((port) => port.replace(/\/(?:tcp|udp)$/i, ""))
    .filter((port) => /^\d+$/.test(port))
    .map(Number);
  const ports = selectGeneratedHostPorts(Array.from(new Set(containerPorts)), usedPorts);
  const volumes = Array.from(dockerfile.matchAll(/^\s*VOLUME\s+(?:\[\s*)?(.+?)(?:\s*\])?\s*$/gmi))
    .flatMap((match) => (match[1] ?? "").split(/\s*,\s*|\s+/))
    .map((volume) => volume.replace(/^["']|["']$/g, ""))
    .filter((volume) => volume.startsWith("/"));
  const service: any = { build: ".", restart: "unless-stopped" };
  if (ports.length) service.ports = ports.map((port) => `${port.hostPort}:${port.containerPort}`);
  if (volumes.length) service.volumes = volumes.map((volume, index) => `app-data-${index + 1}:${volume}`);
  const document: any = { services: { app: service } };
  if (volumes.length) {
    document.volumes = Object.fromEntries(volumes.map((_volume, index) => [`app-data-${index + 1}`, {}]));
  }
  return stringifyYaml(document);
}

function trackedGitFiles(nulDelimitedOutput: string) {
  return nulDelimitedOutput
    .split("\0")
    .filter((file) => file.length > 0);
}

async function analyzeGit(
  row: any,
  attempt: DeploymentAnalysisAttempt,
  executionFence?: JobExecutionFence
): Promise<Omit<AnalysisResult, "registryIssues">> {
  const host = await getHostForWorker(row.host_id);
  const locator = canonicalizeDeploymentSource(row.source_input, "git");
  const repoName = sourceBasename(locator).replace(/\.git$/i, "");
  const appProject = projectName(row.project_name || repoName);
  const root = homeDeploymentRoot(host.public.username);
  const staging = attempt.checkoutDirectory;
  const workingDir = row.working_dir || path.posix.join(root, appProject);
  const warnings: Warning[] = [];
  const blockers: Warning[] = [];

  if (host.connectionMode !== "ssh") {
    return {
      sourceLocator: locator,
      displayName: row.display_name || displayName(repoName),
      projectName: appProject,
      branch: row.branch ?? null,
      composePath: row.compose_path || "compose.yaml",
      workingDir,
      composeYaml: "",
      env: "",
      stagingDirectory: null,
      summary: { services: [], composeCandidates: [], dockerfileGenerated: false, trackedEnvFile: false },
      variables: [],
      warnings,
      blockers: [{ code: "git_requires_ssh", message: "Git analysis currently requires an SSH-connected host. Compose and image sources still work on agent hosts." }]
    };
  }

  const username = row.credential_username ?? null;
  const secret = row.credential_secret_encrypted ? decryptSecret(row.credential_secret_encrypted) : null;
  let remote = locator;
  let usedCredentials = false;
  const noCredentialAccess = await runGit(
    row.id,
    host,
    `git ls-remote --symref ${shQuote(remote)} HEAD`,
    null,
    null,
    60_000,
    executionFence
  );
  let access = noCredentialAccess;
  if (access.code !== 0 && /^https?:\/\//i.test(remote) && !/\.git$/i.test(new URL(remote).pathname)) {
    const withSuffix = `${remote}.git`;
    const suffixAccess = await runGit(
      row.id,
      host,
      `git ls-remote --symref ${shQuote(withSuffix)} HEAD`,
      null,
      null,
      60_000,
      executionFence
    );
    if (suffixAccess.code === 0) {
      remote = withSuffix;
      access = suffixAccess;
    }
  }
  if (access.code !== 0 && secret) {
    access = await runGit(
      row.id,
      host,
      `git ls-remote --symref ${shQuote(remote)} HEAD`,
      username,
      secret,
      60_000,
      executionFence
    );
    usedCredentials = access.code === 0;
    if (access.code !== 0 && /^https?:\/\//i.test(remote) && !/\.git$/i.test(new URL(remote).pathname)) {
      const withSuffix = `${remote}.git`;
      const suffixAccess = await runGit(
        row.id,
        host,
        `git ls-remote --symref ${shQuote(withSuffix)} HEAD`,
        username,
        secret,
        60_000,
        executionFence
      );
      if (suffixAccess.code === 0) {
        remote = withSuffix;
        access = suffixAccess;
        usedCredentials = true;
      }
    }
  }
  if (access.code !== 0) {
    throw new Error(
      "The selected host cannot read this Git repository. Add a read-only deploy key, or enter an HTTPS username and token under Advanced."
    );
  }

  const detectedBranch = row.branch
    || /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m.exec(access.stdout)?.[1]
    || null;
  await runDeploymentRemoteMutation(
    row.id,
    "analysis-stage-create",
    executionFence,
    async () => {
      const ownerFile = path.posix.join(attempt.directory, DEPLOYMENT_ANALYSIS_OWNER_FILE);
      const created = await runSshCommand(
        host.ssh,
        [
          "umask 077",
          `mkdir -p -- ${shQuote(path.posix.dirname(attempt.directory))}`,
          `test ! -e ${shQuote(attempt.directory)} && test ! -L ${shQuote(attempt.directory)}`,
          `mkdir -- ${shQuote(attempt.directory)}`,
          [
            `if ! (set -C; printf '%s\\n' ${shQuote(attempt.ownerRecord)} > ${shQuote(ownerFile)})`,
            `then rm -rf -- ${shQuote(attempt.directory)}; exit 73`,
            "fi"
          ].join("; ")
        ].join(" && "),
        { timeoutMs: 30_000 }
      );
      if (created.code !== 0) {
        throw new Error("Could not exclusively create the deployment analysis staging directory.");
      }
    },
    { hostId: row.host_id, stagingDirectory: staging }
  );
  const cloneArgs = [
    "git clone --depth 1",
    detectedBranch ? `--branch ${shQuote(detectedBranch)}` : "",
    shQuote(remote),
    shQuote(staging)
  ].filter(Boolean).join(" ");
  const clone = await runGit(
    row.id,
    host,
    cloneArgs,
    usedCredentials ? username : null,
    usedCredentials ? secret : null,
    10 * 60_000,
    executionFence
  );
  if (clone.code !== 0) {
    await runDeploymentRemoteMutation(
      row.id,
      "analysis-stage-failed-clone-cleanup",
      executionFence,
      () => removeDeploymentAnalysisStaging(host, row.id, staging),
      { hostId: row.host_id, stagingDirectory: staging }
    ).catch(() => undefined);
    throw new Error("The repository was reachable but could not be staged on the selected host.");
  }

  await runDeploymentRemoteMutation(
    row.id,
    "analysis-stage-bind-checkout",
    executionFence,
    () => writeRemoteFile(
      host.ssh,
      path.posix.join(
        staging,
        ".git",
        DEPLOYMENT_ANALYSIS_CHECKOUT_OWNER_FILE
      ),
      `${attempt.ownerRecord}\n`
    ),
    { hostId: row.host_id, stagingDirectory: staging }
  );
  await executionCheckpoint(executionFence);
  const revisionResult = await runSshCommand(
    host.ssh,
    `cd ${shQuote(staging)} && git rev-parse --verify HEAD^{commit}`,
    { timeoutMs: 30_000 }
  );
  await executionCheckpoint(executionFence);
  if (revisionResult.code !== 0) {
    throw new Error("Could not bind this analysis to the staged Git revision.");
  }
  const sourceRevision = exactGitRevision(revisionResult.stdout);

  const listing = await runSshCommand(
    host.ssh,
    `cd ${shQuote(staging)} && git -c core.quotepath=false ls-files -z`,
    { timeoutMs: 30_000 }
  );
  if (listing.code !== 0) throw new Error("Could not inspect the staged repository.");
  const files = trackedGitFiles(listing.stdout);
  const candidates = selectComposeCandidates(files);
  let composePath = row.compose_path || candidates[0] || "";
  let composeYaml = "";
  let dockerfileGenerated = false;

  if (row.compose_path && !files.includes(row.compose_path)) {
    blockers.push({ code: "compose_not_found", message: `The selected Compose file '${row.compose_path}' was not found in this repository.` });
  } else if (composePath) {
    composeYaml = await readRemoteFile(host.ssh, path.posix.join(staging, composePath), MAX_COMPOSE_BYTES);
  } else {
    const dockerfile = files.find((file) => file.toLowerCase() === "dockerfile");
    if (!dockerfile) {
      blockers.push({ code: "no_deployment_definition", message: "No Compose file or root Dockerfile was found in this repository." });
    } else {
      composePath = "composebastion.generated.yaml";
      composeYaml = generatedDockerfileCompose(
        await readRemoteFile(host.ssh, path.posix.join(staging, dockerfile), MAX_COMPOSE_BYTES),
        await usedHostPorts(row.host_id)
      );
      dockerfileGenerated = true;
      warnings.push({ code: "compose_generated", message: "No Compose file was found, so a managed Compose draft was generated from the root Dockerfile." });
    }
  }
  if (!row.compose_path && candidates.length > 1) {
    blockers.push({ code: "multiple_compose_files", message: "Multiple Compose files were found. Select the intended file under Advanced, then analyze again." });
  }

  const trackedEnvFile = files.some((file) => path.posix.basename(file) === ".env");
  if (trackedEnvFile) {
    warnings.push({ code: "tracked_env", message: "This repository tracks a .env file. Its contents were not read or exposed; review the repository for committed secrets." });
  }
  const composeDirectory = composePath.includes("/") ? path.posix.dirname(composePath) : "";
  const exampleNames = [".env.example", ".env.sample", "example.env"];
  const exampleFile = exampleNames
    .map((name) => composeDirectory ? path.posix.join(composeDirectory, name) : name)
    .find((candidate) => files.includes(candidate));
  const exampleEnv = exampleFile ? await readOptionalRemoteFile(host, path.posix.join(staging, exampleFile)) : "";
  let services: ServiceSummary[] = [];
  let variables: Variable[] = [];
  let sourceIntegrity: GitComposeSourceIntegrity | null = null;
  if (composeYaml) {
    try {
      sourceIntegrity = inspectGitComposeSourceIntegrity(
        composeYaml,
        composePath,
        files
      );
    } catch (error) {
      if (!(error instanceof GitComposeSourceIntegrityError)) throw error;
      blockers.push({
        code: "compose_source_integrity",
        message: error.message
      });
    }
    services = summarizeCompose(composeYaml);
    variables = extractDeploymentVariables(composeYaml, exampleEnv);
  }

  const checkoutCleanGuard = gitComposeCheckoutCleanGuardCommands(
    workingDir,
    sourceIntegrity ?? {
      composePath,
      referencedFiles: composePath ? [composePath] : [],
      buildContexts: [],
      runtimePaths: []
    },
    dockerfileGenerated ? composePath : undefined
  ).join(" && ");
  const existing = await runSshCommand(
    host.ssh,
    `if test ! -e ${shQuote(workingDir)}; then echo absent; elif test -d ${shQuote(path.posix.join(workingDir, ".git"))}; then cd ${shQuote(workingDir)} && printf 'git\\n' && git remote get-url origin && ${checkoutCleanGuard}; else echo unrelated; fi`,
    { timeoutMs: 30_000 }
  );
  const existingLines = existing.stdout.split(/\r?\n/);
  if (existingLines[0] === "unrelated") {
    blockers.push({ code: "directory_conflict", message: `${workingDir} already exists and is not a Git checkout. Nothing will be overwritten.` });
  } else if (existingLines[0] === "git") {
    const existingRemote = existingLines[1] ?? "";
    const changes = existingLines.slice(2).filter(Boolean);
    if (normalizedGitUrl(existingRemote) !== normalizedGitUrl(remote)) {
      blockers.push({ code: "repository_conflict", message: `${workingDir} is a checkout of a different repository. Nothing will be overwritten.` });
    } else if (existing.code !== 0 || changes.length) {
      blockers.push({ code: "dirty_checkout", message: `${workingDir} has local changes. Commit, stash, or remove them before deploying.` });
    } else {
      warnings.push({ code: "existing_checkout", message: "A clean checkout of this source already exists and will be pinned to the analyzed revision during deployment." });
    }
  }

  return {
    sourceLocator: remote,
    displayName: row.display_name || displayName(repoName),
    projectName: appProject,
    branch: detectedBranch,
    composePath: composePath || "compose.yaml",
    workingDir,
    composeYaml,
    env: variablesToEnv(variables),
    stagingDirectory: staging,
    sourceRevision,
    summary: { services, composeCandidates: candidates, dockerfileGenerated, trackedEnvFile },
    variables,
    warnings,
    blockers
  };
}

export const lanComposeResolver: RegistryResolver = async (hostname) => {
  const unwrapped = hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(unwrapped);
  const entries = family
    ? [{ address: unwrapped, family }]
    : await dnsLookup(unwrapped, { all: true, verbatim: true });
  if (!entries.length) throw Object.assign(new Error("Compose URL hostname did not resolve."), { code: "ENOTFOUND" });
  for (const entry of entries) {
    const address = entry.address.toLowerCase();
    const mappedV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1]
      ?? (() => {
        const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
        if (!mappedHex) return null;
        const high = Number.parseInt(mappedHex[1]!, 16);
        const low = Number.parseInt(mappedHex[2]!, 16);
        return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      })();
    const v4Address = entry.family === 4 ? address : mappedV4;
    const unsafeV4 = entry.family === 4 && (
      v4Address!.startsWith("127.")
      || v4Address!.startsWith("169.254.")
      || v4Address!.startsWith("0.")
      || Number(v4Address!.split(".")[0]) >= 224
    );
    const unsafeMappedV4 = Boolean(mappedV4) && (
      mappedV4!.startsWith("127.")
      || mappedV4!.startsWith("169.254.")
      || mappedV4!.startsWith("0.")
      || Number(mappedV4!.split(".")[0]) >= 224
    );
    const unsafeV6 = entry.family === 6 && (
      address === "::"
      || address === "::1"
      || address.startsWith("fe8")
      || address.startsWith("fe9")
      || address.startsWith("fea")
      || address.startsWith("feb")
      || address.startsWith("ff")
    );
    if (unsafeV4 || unsafeMappedV4 || unsafeV6) {
      throw Object.assign(new Error(`Compose URL resolved to a blocked address (${entry.address}).`), { code: "UNSAFE_COMPOSE_ADDRESS" });
    }
  }
  return entries.map((entry) => ({ address: entry.address, family: entry.family }));
};

async function downloadCompose(source: string) {
  const url = new URL(source);
  if (url.username || url.password) throw new Error("Compose URLs may not contain credentials.");
  const response = await guardedRegistryRequest(url, {
    maxBytes: MAX_COMPOSE_BYTES,
    maxRedirects: 3,
    timeoutMs: 20_000,
    policy: { trustedOrigins: [url.origin], allowPrivateResolvedAddresses: true },
    resolve: lanComposeResolver
  });
  if (!response.ok) throw new Error(`Compose download returned HTTP ${response.status}.`);
  return response.body.toString("utf8");
}

async function sourceOwnsDeploymentPath(
  row: any,
  workingDir: string,
  composePath: string,
  allowInterruptedDeployment = false
) {
  const absoluteComposePath = path.posix.join(workingDir, composePath);
  const result = await query<any>(
    `SELECT deployment_source_id, project_name, source_working_dir, source_compose_path, compose_yaml
     FROM compose_stacks
     WHERE host_id = $1
       AND source_working_dir = $2
       AND source_compose_path IN ($3, $4)
     LIMIT 1`,
    [row.host_id, workingDir, composePath, absoluteComposePath]
  );
  const stack = result.rows[0];
  if (!stack) return false;
  if (row.source_id && stack.deployment_source_id === row.source_id) return true;
  return Boolean(
    allowInterruptedDeployment
    && !row.source_id
    && stack.project_name === row.project_name
    && stack.compose_yaml === row.compose_yaml
  );
}

async function analyzeCompose(row: any, sourceType: "compose_url" | "compose_upload"): Promise<Omit<AnalysisResult, "registryIssues">> {
  const host = await getHostForWorker(row.host_id);
  const sourceLocator = row.source_locator || canonicalizeDeploymentSource(row.source_input, sourceType);
  const composeYaml = row.compose_yaml
    || (sourceType === "compose_url" ? await downloadCompose(sourceLocator) : row.source_input);
  const services = summarizeCompose(composeYaml);
  const nameSeed = sourceType === "compose_url"
    ? sourceBasename(sourceLocator).replace(/(?:docker-)?compose\.ya?ml$/i, "") || services[0]!.name
    : sourceBasename(row.source_input).replace(/\.ya?ml$/i, "") || services[0]!.name;
  const appProject = projectName(row.project_name || nameSeed || services[0]!.name);
  const workingDir = row.working_dir || path.posix.join(homeDeploymentRoot(host.public.username), appProject);
  const composePath = row.compose_path || "compose.yaml";
  const variables = extractDeploymentVariables(composeYaml);
  const blockers: Warning[] = [];
  const [existingDirectory, managedDirectory] = await Promise.all([
    statHostPath(row.host_id, workingDir).catch(() => ({ exists: false })),
    sourceOwnsDeploymentPath(row, workingDir, composePath)
  ]);
  if (existingDirectory?.exists && !managedDirectory) {
    blockers.push({ code: "directory_conflict", message: `${workingDir} already exists and is not managed by this library source. Nothing will be overwritten.` });
  }
  return {
    sourceLocator,
    displayName: row.display_name || displayName(appProject),
    projectName: appProject,
    branch: null,
    composePath,
    workingDir,
    composeYaml,
    env: variablesToEnv(variables),
    stagingDirectory: null,
    summary: { services, composeCandidates: [], dockerfileGenerated: false, trackedEnvFile: false },
    variables,
    warnings: [],
    blockers
  };
}

function imageAuthority(image: string) {
  if (!image.includes("/")) return null;
  const first = image.split("/")[0] ?? "";
  return first.includes(".") || first.includes(":") || first === "localhost" ? first : null;
}

function parseImageInspect(stdout: string) {
  try {
    const parsed = JSON.parse(stdout) as Array<any>;
    const config = parsed[0]?.Config ?? {};
    return {
      ports: Object.keys(config.ExposedPorts ?? {}).map((port) => port.split("/")[0]!).filter((port) => /^\d+$/.test(port)),
      volumes: Object.keys(config.Volumes ?? {}).filter((volume) => volume.startsWith("/")),
      env: Array.isArray(config.Env) ? config.Env as string[] : []
    };
  } catch {
    return { ports: [] as string[], volumes: [] as string[], env: [] as string[] };
  }
}

export function selectGeneratedHostPorts(containerPorts: number[], usedPorts: Set<number>) {
  return containerPorts.map((containerPort) => {
    let candidate = containerPort === 80 ? 8080 : containerPort === 443 ? 8443 : containerPort;
    while (usedPorts.has(candidate) && candidate <= 65535) candidate += 1;
    if (candidate > 65535) throw new Error(`No free host port could be selected for container port ${containerPort}.`);
    usedPorts.add(candidate);
    return { hostPort: candidate, containerPort };
  });
}

async function usedHostPorts(hostId: string) {
  const result = await runDocker(hostId, "docker ps --format '{{.Ports}}'", 30_000).catch(() => ({ stdout: "" }));
  const used = new Set<number>();
  for (const match of result.stdout.matchAll(/(?:0\.0\.0\.0|\[::\]|:::):(\d+)->/g)) used.add(Number(match[1]));
  return used;
}

async function analyzeImage(
  row: any,
  executionFence?: JobExecutionFence
): Promise<Omit<AnalysisResult, "registryIssues">> {
  const host = await getHostForWorker(row.host_id);
  const locator = canonicalizeDeploymentSource(row.source_input, "image");
  if (!locator || /\s/.test(locator)) throw new Error("Enter a valid OCI image reference.");
  parseImageReference(locator);
  const imageName = sourceBasename(locator).split("@")[0]!.split(":")[0]!;
  const appProject = projectName(row.project_name || imageName);
  const workingDir = row.working_dir || path.posix.join(homeDeploymentRoot(host.public.username), appProject);
  let inspect = await runDocker(row.host_id, `docker image inspect ${shQuote(locator)}`, 30_000).catch(() => ({ stdout: "" }));
  let metadataWarning: Warning | null = null;
  if (!inspect.stdout.trim()) {
    try {
      await runDeploymentRemoteMutation(
        row.id,
        "analysis-image-pull",
        executionFence,
        () => runDocker(row.host_id, `docker pull ${shQuote(locator)}`, 10 * 60_000),
        { hostId: row.host_id, image: locator }
      );
      inspect = await runDocker(row.host_id, `docker image inspect ${shQuote(locator)}`, 30_000);
    } catch (error) {
      if (
        isJobLeaseLost(error)
        || isRemoteMutationOutcomeUnknown(error)
        || error instanceof DeploymentRemoteOutcomeUnknownError
      ) {
        throw error;
      }
      metadataWarning = {
        code: "image_metadata_unavailable",
        message: "Image metadata could not be inspected yet. Registry readiness is shown below; you can add ports under Advanced."
      };
    }
  }
  const metadata = parseImageInspect(inspect.stdout);
  const ports = selectGeneratedHostPorts(metadata.ports.map(Number), await usedHostPorts(row.host_id));
  const variables = metadata.env
    .map((entry) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .filter((match) => !/^(?:PATH|HOME|HOSTNAME|TERM|LANG|LC_|NODE_VERSION|YARN_VERSION|NPM_CONFIG_)/.test(match[1]!))
    .map((match): Variable => ({
      key: match[1]!,
      value: SECRET_NAME.test(match[1]!) ? "" : match[2] ?? "",
      defaultValue: SECRET_NAME.test(match[1]!) ? null : match[2] || null,
      required: SECRET_NAME.test(match[1]!),
      secret: SECRET_NAME.test(match[1]!),
      source: "image"
    }));
  const service: any = { image: locator, restart: "unless-stopped" };
  if (ports.length) service.ports = ports.map((port) => `${port.hostPort}:${port.containerPort}`);
  if (metadata.volumes.length) service.volumes = metadata.volumes.map((volume, index) => `app-data-${index + 1}:${volume}`);
  if (variables.length) {
    service.environment = Object.fromEntries(variables.map((variable) => [
      variable.key,
      variable.secret
        ? `\${${variable.key}:?required}`
        : variable.defaultValue !== null
          ? `\${${variable.key}:-${variable.defaultValue}}`
          : `\${${variable.key}}`
    ]));
  }
  const document: any = { services: { app: service } };
  if (metadata.volumes.length) document.volumes = Object.fromEntries(metadata.volumes.map((_volume, index) => [`app-data-${index + 1}`, {}]));
  const composeYaml = stringifyYaml(document);
  const [existingDirectory, managedDirectory] = await Promise.all([
    statHostPath(row.host_id, workingDir).catch(() => ({ exists: false })),
    sourceOwnsDeploymentPath(row, workingDir, "compose.yaml")
  ]);
  const blockers: Warning[] = existingDirectory?.exists && !managedDirectory
    ? [{ code: "directory_conflict", message: `${workingDir} already exists and is not managed by this library source. Nothing will be overwritten.` }]
    : [];
  return {
    sourceLocator: locator,
    displayName: row.display_name || displayName(imageName),
    projectName: appProject,
    branch: null,
    composePath: "compose.yaml",
    workingDir,
    composeYaml,
    env: variablesToEnv(variables),
    stagingDirectory: null,
    summary: {
      services: summarizeCompose(composeYaml),
      composeCandidates: [],
      dockerfileGenerated: false,
      trackedEnvFile: false
    },
    variables,
    warnings: metadataWarning
      ? [metadataWarning]
      : metadata.ports.length
        ? []
        : [{ code: "no_exposed_ports", message: "The image does not declare exposed ports. You can add ports under Advanced if the app needs them." }],
    blockers
  };
}

function declaredHostPort(port: string) {
  const withoutProtocol = port.replace(/\/(?:tcp|udp)$/i, "");
  const parts = withoutProtocol.split(":");
  if (parts.length < 2) return null;
  const hostPort = Number(parts[parts.length - 2]);
  return Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535 ? hostPort : null;
}

async function composePortConflicts(
  hostId: string,
  project: string,
  services: ServiceSummary[],
  sourceId?: string | null
) {
  const existingProject = await query<any>(
    "SELECT id, deployment_source_id FROM compose_stacks WHERE host_id = $1 AND project_name = $2 LIMIT 1",
    [hostId, project]
  );
  if (existingProject.rows[0]) {
    return sourceId && existingProject.rows[0].deployment_source_id === sourceId
      ? [] as Warning[]
      : [{
          code: "project_conflict",
          message: `Compose project '${project}' is already managed by another service on this host. Choose another project name.`
        }];
  }
  const used = await usedHostPorts(hostId);
  const conflicts = Array.from(new Set(
    services.flatMap((service) => service.ports.map(declaredHostPort))
      .filter((port): port is number => Boolean(port && used.has(port)))
  )).sort((left, right) => left - right);
  return conflicts.length
    ? [{
        code: "port_conflict",
        message: `Host port${conflicts.length === 1 ? "" : "s"} ${conflicts.join(", ")} ${conflicts.length === 1 ? "is" : "are"} already in use. Existing Compose ports are never rewritten automatically.`
      }]
    : [];
}

export function normalizeRegistryTrustAuthority(value: string) {
  const input = value.trim();
  let authority = input;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1]!)) {
      throw Object.assign(new Error("Registry trust accepts only HTTP(S) origins or a hostname and optional port."), { statusCode: 400 });
    }
    let parsed: URL;
    try {
      parsed = new URL(input);
    } catch {
      throw Object.assign(new Error("Enter a registry hostname and optional port."), { statusCode: 400 });
    }
    if (
      parsed.username
      || parsed.password
      || (parsed.pathname && parsed.pathname !== "/")
      || parsed.search
      || parsed.hash
      || input.includes("?")
      || input.includes("#")
    ) {
      throw Object.assign(
        new Error("Registry trust accepts only a hostname and optional port, without credentials, a path, query parameters, or a fragment."),
        { statusCode: 400 }
      );
    }
    const rawTarget = input.slice(input.indexOf("://") + 3);
    authority = rawTarget.endsWith("/") ? rawTarget.slice(0, -1) : rawTarget;
  }
  try {
    return normalizeRegistryAuthority(authority);
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : "Enter a registry hostname and optional port."),
      { statusCode: 400 }
    );
  }
}

function dockerRegistryTrust(indexConfigs: unknown, registry: string) {
  if (!indexConfigs || typeof indexConfigs !== "object") return false;
  const entries = Object.entries(indexConfigs as Record<string, any>);
  return entries.some(([key, value]) => {
    const authority = key.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
    return authority === registry.toLowerCase() && value?.Secure === false;
  });
}

export async function checkRegistryTrust(hostId: string, registry: string, insecure = true) {
  const host = await getHostForWorker(hostId);
  const normalized = normalizeRegistryTrustAuthority(registry);
  const info = await runDocker(hostId, "docker info --format '{{json .RegistryConfig.IndexConfigs}}'", 30_000).catch(() => ({ stdout: "{}" }));
  let configs: unknown = {};
  try {
    configs = JSON.parse(info.stdout.trim() || "{}");
  } catch {
    configs = {};
  }
  const trusted = !insecure || dockerRegistryTrust(configs, normalized);
  let canApply = false;
  if (!trusted && host.connectionMode === "ssh") {
    const sudo = await runSshCommand(host.ssh, "sudo -n true", { timeoutMs: 15_000 }).catch(() => ({ code: 1 }));
    canApply = sudo.code === 0;
  }
  return registryTrustSchema.parse({
    registry: normalized,
    insecure,
    trusted,
    canApply,
    requiresRestart: !trusted,
    message: trusted
      ? `${host.public.name} trusts HTTP registry '${normalized}'.`
      : `${host.public.name} does not trust HTTP registry '${normalized}'.`
  });
}

async function registryIssuesFor(hostId: string, images: string[], sourceInput: string) {
  const host = await getHostForWorker(hostId);
  const unique = new Map<string, boolean>();
  for (const image of images) {
    const authority = imageAuthority(image);
    if (!authority) continue;
    const saved = await findRegistryAuthForReference(image).catch(() => null);
    const explicitInsecure = sourceInput.startsWith(`http://${authority}/`);
    if (saved?.insecure || explicitInsecure) {
      unique.set(authority, true);
      continue;
    }
    if (host.connectionMode === "ssh") {
      const probe = await runSshCommand(
        host.ssh,
        [
          `if command -v curl >/dev/null 2>&1; then`,
          `if curl --insecure --silent --show-error --head --max-time 5 ${shQuote(`https://${authority}/v2/`)} >/dev/null 2>&1; then echo https;`,
          `elif curl --silent --show-error --head --max-time 5 ${shQuote(`http://${authority}/v2/`)} >/dev/null 2>&1; then echo http;`,
          "else echo unknown; fi;",
          "else echo unknown; fi"
        ].join(" "),
        { timeoutMs: 15_000 }
      ).catch(() => ({ stdout: "unknown" }));
      if (probe.stdout.trim() === "http") {
        unique.set(authority, true);
        continue;
      }
    }
    unique.set(authority, false);
  }
  return Promise.all(Array.from(unique).map(async ([registry, insecure]) => {
    if (!insecure) {
      return {
        registry,
        insecure: false,
        trusted: true,
        canApply: false,
        message: `${host.public.name} will connect to registry '${registry}' over HTTPS.`
      };
    }
    const check = await checkRegistryTrust(hostId, registry, true);
    return {
      registry,
      insecure: true,
      trusted: check.trusted,
      canApply: check.canApply,
      message: check.message
    };
  }));
}

async function preflightDeploymentImages(
  analysisId: string,
  hostId: string,
  composeYaml: string,
  environment: string,
  executionFence?: JobExecutionFence
) {
  const images = extractImagesFromCompose(composeYaml, environment);
  for (const image of images) {
    await executionCheckpoint(executionFence);
    const saved = await findRegistryAuthForReference(image).catch(() => null);
    if (saved) {
      await runDeploymentRemoteMutation(
        analysisId,
        "registry-login",
        executionFence,
        () => executeDockerAction({
          type: "registry.login",
          hostId,
          payload: { registryId: saved.id }
        }, executionFence),
        { hostId, registryId: saved.id }
      );
    }
    await runDeploymentRemoteMutation(
      analysisId,
      "deployment-image-pull",
      executionFence,
      () => runDocker(hostId, `docker pull ${shQuote(image)}`, 10 * 60_000),
      { hostId, image }
    );
  }
}

export async function createDeploymentAnalysis(
  input: unknown,
  createdBy?: string | null,
  onQueued?: (
    client: PoolClient,
    result: {
      analysis: ReturnType<typeof mapAnalysis>;
      job: Awaited<ReturnType<typeof enqueueJobInTransaction>>;
    }
  ) => Promise<void>
) {
  const parsed = deploymentAnalysisCreateSchema.parse(input);
  // Reject caller-supplied unsafe locators and unsupported credential modes
  // before opening a transaction. Stored-library values are re-read under a
  // row lock below.
  if (parsed.source) {
    const explicitSourceType = parsed.sourceType
      ?? detectDeploymentSourceType(parsed.source, parsed.composeYaml);
    canonicalizeDeploymentSource(parsed.source, explicitSourceType);
    if (
      explicitSourceType === "compose_url"
      && (parsed.credentialUsername || parsed.credentialSecret)
    ) {
      throw Object.assign(
        new Error("Compose URL credentials are not supported; upload the Compose file instead."),
        { statusCode: 400 }
      );
    }
  } else if (
    parsed.sourceType === "compose_url"
    && (parsed.credentialUsername || parsed.credentialSecret)
  ) {
    throw Object.assign(
      new Error("Compose URL credentials are not supported; upload the Compose file instead."),
      { statusCode: 400 }
    );
  }
  const id = uuid();
  const result = await withTransaction(async (client) => {
    // A library source is copied into the durable analysis. Lock it through
    // analysis/job insertion so config import or library edits happen wholly
    // before this snapshot, or wait and then observe the new active analysis.
    const sourceRow = parsed.sourceId
      ? (await client.query<any>(
          "SELECT * FROM deployment_sources WHERE id = $1 FOR UPDATE",
          [parsed.sourceId]
        )).rows[0]
      : null;
    if (parsed.sourceId && !sourceRow) {
      throw Object.assign(new Error("Deployment source not found."), { statusCode: 404 });
    }
    const source = parsed.source || sourceRow?.source_locator;
    const sourceType = parsed.sourceType
      ?? sourceRow?.source_type
      ?? detectDeploymentSourceType(source, parsed.composeYaml);
    const sourceLocator = canonicalizeDeploymentSource(source, sourceType);
    if (
      sourceType === "compose_url"
      && (parsed.credentialUsername || parsed.credentialSecret)
    ) {
      throw Object.assign(
        new Error("Compose URL credentials are not supported; upload the Compose file instead."),
        { statusCode: 400 }
      );
    }
    const sourceInput = sourceType === "git" || sourceType === "compose_url"
      ? sourceLocator
      : source;
    const storedComposeYaml = sourceType === "compose_url" && parsed.composeYaml === undefined
      ? null
      : parsed.composeYaml ?? sourceRow?.compose_yaml ?? null;
    const inserted = await client.query<any>(
      `INSERT INTO deployment_analyses (
        id, host_id, source_id, source_type, source_input, source_locator, status,
        display_name, project_name, branch, compose_path, working_dir, compose_yaml, env_encrypted,
        credential_username, credential_secret_encrypted, created_by, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now() + ($17 || ' hours')::interval)
      RETURNING *`,
      [
        id,
        parsed.hostId,
        parsed.sourceId ?? null,
        sourceType,
        sourceInput,
        sourceLocator,
        sourceRow?.name ?? null,
        sourceRow?.project_name ?? null,
        parsed.branch ?? sourceRow?.branch ?? null,
        parsed.composePath ?? sourceRow?.compose_path ?? null,
        sourceRow?.working_dir ?? null,
        storedComposeYaml,
        sourceRow?.env_encrypted ?? null,
        parsed.credentialUsername ?? sourceRow?.credential_username ?? null,
        parsed.credentialSecret ? encryptSecret(parsed.credentialSecret) : sourceRow?.credential_secret_encrypted ?? null,
        createdBy ?? null,
        ANALYSIS_TTL_HOURS
      ]
    );
    const job = await enqueueJobInTransaction(
      client,
      { type: "deploy.analyze", hostId: parsed.hostId, payload: { analysisId: id } },
      createdBy
    );
    const queued = { analysis: mapAnalysis(inserted.rows[0]), job };
    await onQueued?.(client, queued);
    return queued;
  });
  await notifyJobQueued(result.job.id);
  return result;
}

export async function getDeploymentAnalysis(id: string) {
  const row = await withTransaction(async (client) => {
    const selected = await client.query<any>(
      `SELECT analyses.*,
              analyses.expires_at <= clock_timestamp() AS expiration_due
       FROM deployment_analyses AS analyses
       WHERE analyses.id = $1
       FOR UPDATE OF analyses`,
      [id]
    );
    if (!selected.rows[0]) return null;
    const expiration = await expireLockedDeploymentAnalysisRows(client, selected.rows);
    return expiration.rows[0] ?? null;
  });
  return row ? mapAnalysis(row, false) : null;
}

export async function analyzeDeployment(
  analysisId: string,
  executionFence?: JobExecutionFence,
  jobContext?: DeploymentJobContext
) {
  await executionCheckpoint(executionFence);
  const rowResult = await executionQuery<any>(
    executionFence,
    "SELECT * FROM deployment_analyses WHERE id = $1",
    [analysisId]
  );
  const row = rowResult.rows[0];
  if (!row) throw new Error("Deployment analysis not found.");
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new Error("Deployment analysis expired. Analyze the source again.");
  }

  let analysisHost: Awaited<ReturnType<typeof getHostForWorker>> | null = null;
  let attempt: DeploymentAnalysisAttempt | null = null;
  if (row.source_type === "git") {
    analysisHost = await getHostForWorker(row.host_id);
    if (analysisHost.connectionMode === "ssh") {
      attempt = deploymentAnalysisAttempt(analysisHost.public.username, analysisId);
    }
  }

  try {
    if (
      analysisHost
      && attempt
      && typeof row.staging_directory === "string"
      && row.staging_directory !== attempt.checkoutDirectory
    ) {
      const previousCleanup = await runDeploymentRemoteMutation(
        analysisId,
        "analysis-previous-stage-cleanup",
        executionFence,
        () => removeDeploymentAnalysisStaging(
          analysisHost!,
          analysisId,
          row.staging_directory
        ),
        {
          hostId: row.host_id,
          jobId: jobContext?.jobId,
          attemptCount: jobContext?.attemptCount
        }
      );
      if (!previousCleanup.removed) {
        throw new Error(
          previousCleanup.code === "path_mismatch"
            ? "The recorded deployment analysis staging path is outside the managed directory."
            : previousCleanup.code === "legacy_unowned"
              ? "The legacy deployment analysis staging directory has no ownership marker and requires manual inspection and removal before retrying."
            : "The previous deployment analysis staging directory could not be removed safely."
        );
      }
    }

    const started = await executionQuery<any>(
      executionFence,
      `UPDATE deployment_analyses
       SET status = 'analyzing',
           error = null,
           warnings = '[]',
           blockers = '[]',
           registry_issues = '[]',
           staging_directory = $2,
           updated_at = now()
       WHERE id = $1
         AND status IN ('queued', 'failed', 'analyzing')
         AND expires_at > clock_timestamp()
       RETURNING *`,
      [analysisId, attempt?.checkoutDirectory ?? null]
    );
    if (!started.rows[0]) {
      throw new Error("This deployment analysis attempt is no longer active.");
    }
    Object.assign(row, started.rows[0]);

    const base = row.source_type === "git"
      ? await analyzeGit(
          row,
          attempt ?? deploymentAnalysisAttempt(
            analysisHost?.public.username ?? "root",
            analysisId
          ),
          executionFence
        )
      : row.source_type === "compose_url" || row.source_type === "compose_upload"
        ? await analyzeCompose(row, row.source_type)
        : await analyzeImage(row, executionFence);
    await executionCheckpoint(executionFence);
    const storedEnv = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
    const mergedConfiguration = mergeStoredAnalysisEnv(base.env, storedEnv, base.variables);
    base.env = mergedConfiguration.env;
    base.variables = mergedConfiguration.variables;
    const registryIssues = base.composeYaml
      ? await registryIssuesFor(
          row.host_id,
          extractImagesFromCompose(base.composeYaml, base.env),
          row.source_input
        )
      : [];
    const portBlockers = base.composeYaml
      ? await composePortConflicts(row.host_id, base.projectName, base.summary.services, row.source_id)
      : [];
    const blockers = [
      ...base.blockers,
      ...portBlockers,
      ...registryIssues
        .filter((issue) => !issue.trusted)
        .map((issue) => ({ code: "registry_trust", message: issue.message }))
    ];
    const updated = await executionQuery<any>(
      executionFence,
      `UPDATE deployment_analyses
       SET status = 'ready',
           source_locator = $2,
           display_name = $3,
           project_name = $4,
           branch = $5,
           compose_path = $6,
           working_dir = $7,
           compose_yaml = $8,
           env_encrypted = $9,
           staging_directory = $10,
           summary = $11,
           variables = $12,
           warnings = $13,
           blockers = $14,
           registry_issues = $15,
           source_revision = $16,
           compose_sha256 = $17,
           environment_sha256 = $18,
           error = null,
           updated_at = now()
       WHERE id = $1
         AND status = 'analyzing'
         AND staging_directory IS NOT DISTINCT FROM $10
       RETURNING *`,
      [
        analysisId,
        base.sourceLocator,
        base.displayName,
        base.projectName,
        base.branch,
        base.composePath,
        base.workingDir,
        base.composeYaml,
        base.env ? encryptSecret(base.env) : null,
        base.stagingDirectory,
        JSON.stringify(base.summary),
        JSON.stringify(base.variables),
        JSON.stringify(base.warnings),
        JSON.stringify(blockers),
        JSON.stringify(registryIssues),
        base.sourceRevision ?? null,
        base.composeYaml ? composeSha256(base.composeYaml) : null,
        environmentSha256(base.env)
      ]
    );
    if (!updated.rows[0]) {
      throw new Error("This deployment analysis attempt was superseded before it could publish its result.");
    }
    return { analysis: mapAnalysis(updated.rows[0]) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let stagingRemoved = false;
    if (
      analysisHost
      && attempt
      && !isJobLeaseLost(error)
      && !isRemoteMutationOutcomeUnknown(error)
      && !(error instanceof DeploymentRemoteOutcomeUnknownError)
    ) {
      const cleanup = await runDeploymentRemoteMutation(
        analysisId,
        "analysis-stage-error-cleanup",
        executionFence,
        () => removeDeploymentAnalysisStaging(
          analysisHost!,
          analysisId,
          attempt!.checkoutDirectory
        ),
        {
          hostId: row.host_id,
          stagingDirectory: attempt.checkoutDirectory,
          jobId: jobContext?.jobId,
          attemptCount: jobContext?.attemptCount
        }
      ).catch(() => null);
      stagingRemoved = cleanup?.removed === true;
    }
    if (
      !isJobLeaseLost(error)
      && !isRemoteMutationOutcomeUnknown(error)
      && !(error instanceof DeploymentRemoteOutcomeUnknownError)
    ) {
      await executionQuery(
        executionFence,
        `UPDATE deployment_analyses
         SET status = 'failed',
             error = $2,
             staging_directory = CASE WHEN $3::boolean THEN null ELSE staging_directory END,
             updated_at = now()
         WHERE id = $1
           AND status IN ('queued', 'analyzing', 'failed')
           AND staging_directory IS NOT DISTINCT FROM $4`,
        [analysisId, message, stagingRemoved, attempt?.checkoutDirectory ?? null]
      ).catch(() => undefined);
    }
    throw error;
  }
}

function normalizedDeploymentTargetPath(value: unknown) {
  const target = String(value ?? "").trim();
  return target ? path.posix.normalize(target) : "";
}

function normalizedDeploymentProject(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function deploymentTargetAdmissionKeys(
  hostId: string,
  workingDir: unknown,
  project: unknown
) {
  const normalizedPath = normalizedDeploymentTargetPath(workingDir);
  const normalizedProject = normalizedDeploymentProject(project);
  if (!normalizedPath || !normalizedProject) {
    throw Object.assign(
      new Error("The deployment target is missing a working directory or Compose project name."),
      { statusCode: 409 }
    );
  }
  return {
    normalizedPath,
    normalizedProject,
    keys: dockerMutationAdmissionKeys(dockerMutationScope({
      type: "compose.deployPath",
      hostId,
      payload: {
        workingDir: normalizedPath,
        projectName: normalizedProject,
        _scopeKnown: true
      }
    })!)
  };
}

async function lockDeploymentHostForAdmission(
  client: PoolClient,
  hostId: string
) {
  const selected = await client.query<{ id: string }>(
    `SELECT id
     FROM docker_hosts
     WHERE id = $1
       AND deleted_at IS NULL
     FOR SHARE`,
    [hostId]
  );
  if (!selected.rows[0]) {
    throw Object.assign(
      new Error("The Docker host is unavailable or was deleted."),
      { statusCode: 409 }
    );
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`docker-mutation-admission:${hostId}`]
  );
}

async function assertDeploymentTargetAvailable(
  client: PoolClient,
  row: {
    id: string;
    host_id: string;
    working_dir: unknown;
    project_name: unknown;
  }
) {
  const target = deploymentTargetAdmissionKeys(
    row.host_id,
    row.working_dir,
    row.project_name
  );
  for (const key of target.keys.filter((candidate) =>
    !candidate.startsWith("docker-mutation-admission:")
  )) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [key]
    );
  }
  const conflict = await client.query<{ id: string; reconciliation_required: boolean }>(
    `SELECT analyses.id
            ,(
              (
                (
                  analyses.error LIKE 'WORKER_LOST:%'
                  OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM operation_jobs AS reconciled_jobs
                  WHERE reconciled_jobs.type = 'deploy.execute'
                    AND reconciled_jobs.payload->>'analysisId' = analyses.id::text
                    AND reconciled_jobs.result-> $5 ->> 'status' = 'reconciled'
                )
              )
              OR EXISTS (
                SELECT 1
                FROM operation_jobs AS ambiguous_jobs
                WHERE ambiguous_jobs.type = 'deploy.execute'
                  AND ambiguous_jobs.payload->>'analysisId' = analyses.id::text
                  AND ambiguous_jobs.status = 'failed'
                  AND (
                    ambiguous_jobs.error LIKE 'WORKER_LOST:%'
                    OR ambiguous_jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
                  )
                  AND COALESCE(
                    ambiguous_jobs.result-> $5 ->> 'status',
                    ''
                  ) <> 'reconciled'
              )
            ) AS reconciliation_required
     FROM deployment_analyses AS analyses
     WHERE analyses.id <> $1
       AND analyses.host_id = $2
       AND (
         analyses.working_dir = $3
         OR lower(analyses.project_name) = $4
       )
       AND (
         EXISTS (
           SELECT 1
           FROM operation_jobs AS active_jobs
           WHERE active_jobs.type = 'deploy.execute'
             AND active_jobs.payload->>'analysisId' = analyses.id::text
             AND active_jobs.status IN ('queued', 'running')
         )
         OR (
           (
             analyses.error LIKE 'WORKER_LOST:%'
             OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM operation_jobs AS reconciled_jobs
             WHERE reconciled_jobs.type = 'deploy.execute'
               AND reconciled_jobs.payload->>'analysisId' = analyses.id::text
               AND reconciled_jobs.result-> $5 ->> 'status' = 'reconciled'
           )
         )
         OR EXISTS (
           SELECT 1
           FROM operation_jobs AS ambiguous_jobs
           WHERE ambiguous_jobs.type = 'deploy.execute'
             AND ambiguous_jobs.payload->>'analysisId' = analyses.id::text
             AND ambiguous_jobs.status = 'failed'
             AND (
               ambiguous_jobs.error LIKE 'WORKER_LOST:%'
               OR ambiguous_jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
             )
             AND COALESCE(
               ambiguous_jobs.result-> $5 ->> 'status',
               ''
             ) <> 'reconciled'
         )
       )
     LIMIT 1`,
    [
      row.id,
      row.host_id,
      target.normalizedPath,
      target.normalizedProject,
      REMOTE_OUTCOME_RECONCILIATION_KEY
    ]
  );
  if (conflict.rows[0]) {
    if (conflict.rows[0].reconciliation_required) {
      throw Object.assign(
        new Error(
          "A previous deployment for this host working directory or Compose project has an unresolved remote outcome. "
          + "Reconcile the remote stack and checkout before using this target again."
        ),
        { statusCode: 409, code: "DEPLOYMENT_TARGET_RECONCILIATION_REQUIRED" }
      );
    }
    throw Object.assign(
      new Error(
        "Another deployment is already queued or running for this host working directory or Compose project."
      ),
      { statusCode: 409 }
    );
  }
  const requestedScope = dockerMutationScope({
    type: "compose.deployPath",
    hostId: row.host_id,
    payload: {
      workingDir: target.normalizedPath,
      projectName: target.normalizedProject,
      _scopeKnown: true
    }
  })!;
  const directOperations = await client.query(
    `SELECT *
     FROM operation_jobs
     WHERE host_id = $1
       AND type = ANY($2::text[])
       AND (
         status IN ('queued', 'running')
         OR (
           status = 'failed'
           AND (
             error LIKE 'WORKER_LOST%'
             OR error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
           )
         )
       )
     ORDER BY created_at ASC
     FOR UPDATE`,
    [row.host_id, [...RECONCILABLE_DOCKER_MUTATION_TYPES]]
  );
  const directConflict = directOperations.rows.find((job) => {
    const candidate = dockerMutationScope(job);
    if (!candidate || !dockerMutationScopesConflict(requestedScope, candidate)) {
      return false;
    }
    return job.status === "queued"
      || job.status === "running"
      || !hasReconciledRemoteOutcome(job.result);
  });
  if (directConflict) {
    const unresolved = directConflict.status === "failed";
    throw Object.assign(
      new Error(
        unresolved
          ? "A previous Git or path operation for this deployment target has an unresolved remote outcome. Reconcile the remote checkout and stack before using this target again."
          : "A Git or path operation is already queued or running for this deployment target."
      ),
      {
        statusCode: 409,
        activeJobId: directConflict.id,
        ...(unresolved
          ? { code: "DEPLOYMENT_TARGET_RECONCILIATION_REQUIRED" }
          : {})
      }
    );
  }
}

export async function queueDeployment(
  analysisId: string,
  input: unknown,
  createdBy?: string | null,
  onQueued?: (
    client: PoolClient,
    result: {
      analysis: ReturnType<typeof mapAnalysis>;
      job: Awaited<ReturnType<typeof enqueueJobInTransaction>>;
    }
  ) => Promise<void>
) {
  const parsed = deploymentAnalysisDeploySchema.parse(input ?? {});
  const rowResult = await query<any>("SELECT * FROM deployment_analyses WHERE id = $1", [analysisId]);
  const row = rowResult.rows[0];
  if (!row) throw Object.assign(new Error("Deployment analysis not found."), { statusCode: 404 });
  if (new Date(row.expires_at).getTime() <= Date.now()) throw Object.assign(new Error("Deployment analysis expired. Analyze the source again."), { statusCode: 409 });
  if (row.status !== "ready") throw Object.assign(new Error("This source is not ready to deploy."), { statusCode: 409 });
  if (row.source_type === "git") {
    try {
      exactGitRevision(row.source_revision);
      const analyzedDigest = exactComposeSha256(row.compose_sha256);
      const analyzedEnvironmentDigest = exactEnvironmentSha256(row.environment_sha256);
      const analyzedEnvironment = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
      if (
        typeof row.compose_yaml !== "string"
        || composeSha256(row.compose_yaml) !== analyzedDigest
      ) {
        throw new Error(
          "The stored Git Compose definition no longer matches its analysis. Analyze the repository again."
        );
      }
      if (environmentSha256(analyzedEnvironment) !== analyzedEnvironmentDigest) {
        throw new Error(
          "The stored Git environment no longer matches its analysis. Analyze the repository again."
        );
      }
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error(String(error)),
        { statusCode: 409 }
      );
    }
  }
  const blockers = Array.isArray(row.blockers) ? row.blockers as Warning[] : [];
  if (blockers.length) throw Object.assign(new Error("Resolve the deployment blockers before deploying."), { statusCode: 409 });
  const candidateComposeYaml = parsed.composeYaml ?? row.compose_yaml;
  if (typeof candidateComposeYaml !== "string" || !candidateComposeYaml.trim()) {
    throw Object.assign(new Error("The deployment has no Compose configuration."), { statusCode: 409 });
  }
  if (
    row.source_type === "git"
    && row.compose_path !== "composebastion.generated.yaml"
    && parsed.composeYaml !== undefined
    && parsed.composeYaml !== row.compose_yaml
  ) {
    throw Object.assign(
      new Error("Compose YAML for a Git source must be changed in the repository, then analyzed again."),
      { statusCode: 409 }
    );
  }
  if (
    row.source_type === "git"
    && parsed.branch !== undefined
    && parsed.branch !== row.branch
  ) {
    throw Object.assign(
      new Error("A Git branch cannot be changed after analysis. Select the branch and analyze the repository again."),
      { statusCode: 409 }
    );
  }
  if (
    row.source_type === "git"
    && parsed.composePath !== undefined
    && parsed.composePath !== row.compose_path
  ) {
    throw Object.assign(
      new Error("A Git Compose path cannot be changed after analysis. Select the file and analyze the repository again."),
      { statusCode: 409 }
    );
  }
  const candidateServices = summarizeCompose(candidateComposeYaml);
  const candidateProjectName = parsed.projectName ?? row.project_name;
  const candidateWorkingDir = parsed.workingDir ?? row.working_dir;
  const candidateComposePath = parsed.composePath ?? row.compose_path;
  const candidateBranch = parsed.branch ?? row.branch;
  if (row.source_id) {
    const identityConflict = await query(
      `SELECT id
       FROM deployment_sources
       WHERE id <> $1
         AND source_type = $2
         AND source_locator = $3
         AND COALESCE(branch, '') = COALESCE($4, '')
         AND COALESCE(compose_path, '') = COALESCE($5, '')
       LIMIT 1`,
      [row.source_id, row.source_type, row.source_locator, candidateBranch, candidateComposePath]
    );
    if (identityConflict.rows[0]) {
      throw Object.assign(
        new Error("Another My Library source already uses this branch and Compose path."),
        { statusCode: 409 }
      );
    }
  }
  const freshVariables = extractDeploymentVariables(candidateComposeYaml);
  const savedVariables = Array.isArray(row.variables) ? row.variables as Variable[] : [];
  const variablesByKey = new Map(savedVariables.map((variable) => [variable.key, variable]));
  for (const variable of freshVariables) variablesByKey.set(variable.key, variable);
  const variables = Array.from(variablesByKey.values());
  const storedEnv = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
  const requestedEnv = mergeRequestedEnv(storedEnv, parsed.env ?? "", variables);
  const candidateImages = extractImagesFromCompose(
    candidateComposeYaml,
    requestedEnv
  );
  const envValues = rawEnvValues(requestedEnv);
  const missingVariables = variables
    .filter((variable) => variable.required && !(envValues.get(variable.key) ?? "").trim())
    .map((variable) => variable.key);
  if (missingVariables.length) {
    throw Object.assign(
      new Error(`Enter required configuration before deploying: ${missingVariables.join(", ")}.`),
      { statusCode: 409 }
    );
  }
  const currentBlockers = [
    ...(row.source_type === "git"
      ? (() => {
          try {
            inspectGitComposeSourceIntegrity(candidateComposeYaml, candidateComposePath);
            return [];
          } catch (error) {
            if (!(error instanceof GitComposeSourceIntegrityError)) throw error;
            return [{
              code: "compose_source_integrity",
              message: error.message
            }];
          }
        })()
      : []),
    ...await composePortConflicts(row.host_id, candidateProjectName, candidateServices, row.source_id),
    ...(await registryIssuesFor(row.host_id, candidateImages, row.source_input))
      .filter((issue) => !issue.trusted)
      .map((issue) => ({ code: "registry_trust", message: issue.message }))
  ];
  if (row.source_type !== "git") {
    const [existingDirectory, managedDirectory] = await Promise.all([
      statHostPath(row.host_id, candidateWorkingDir).catch(() => ({ exists: false })),
      sourceOwnsDeploymentPath(row, candidateWorkingDir, candidateComposePath)
    ]);
    if (existingDirectory?.exists && !managedDirectory) {
      currentBlockers.push({
        code: "directory_conflict",
        message: `${candidateWorkingDir} already exists and is not managed by this library source. Nothing will be overwritten.`
      });
    }
  }
  if (currentBlockers.length) {
    throw Object.assign(new Error(currentBlockers.map((blocker) => blocker.message).join(" ")), { statusCode: 409 });
  }
  const registryCredentialIds = await registryCredentialIdsForImages(candidateImages);

  const result = await withTransaction(async (client) => {
    const deploymentJob = {
      type: "deploy.execute" as const,
      hostId: row.host_id,
      payload: { analysisId }
    };
    // Host lifecycle mutations lock docker_hosts before taking the shared
    // admission advisory. Establish the same global order here before target
    // advisories; enqueueJobInTransaction safely reacquires both locks later.
    await lockDeploymentHostForAdmission(client, row.host_id);
    // Registry credentials are resolved by id inside the worker. Hold their
    // rows through job insertion so deletion/import either happens first and
    // forces a fresh analysis, or observes the queued deployment and blocks.
    await lockRegistryCredentialsForDeployment(client, registryCredentialIds);
    const updated = await client.query<any>(
      `UPDATE deployment_analyses
       SET status = 'deploying',
           display_name = COALESCE($2, display_name),
           project_name = COALESCE($3, project_name),
           branch = COALESCE($4, branch),
           compose_path = COALESCE($5, compose_path),
           working_dir = COALESCE($6, working_dir),
           compose_yaml = COALESCE($7, compose_yaml),
           env_encrypted = $8,
           compose_sha256 = $9,
           environment_sha256 = $10,
           updated_at = now()
       WHERE id = $1
         AND status = 'ready'
         AND expires_at > now()
       RETURNING *`,
      [
        analysisId,
        parsed.displayName ?? null,
        parsed.projectName ?? null,
        parsed.branch ?? null,
        parsed.composePath ?? null,
        parsed.workingDir ?? null,
        candidateComposeYaml,
        requestedEnv ? encryptSecret(requestedEnv) : null,
        composeSha256(candidateComposeYaml),
        environmentSha256(requestedEnv)
      ]
    );
    if (!updated.rows[0]) {
      throw Object.assign(
        new Error("This deployment is already queued or is no longer ready to deploy."),
        { statusCode: 409 }
      );
    }
    await assertDeploymentTargetAvailable(client, updated.rows[0]);
    const job = await enqueueJobInTransaction(
      client,
      deploymentJob,
      createdBy
    );
    const queued = { analysis: mapAnalysis(updated.rows[0]), job };
    await onQueued?.(client, queued);
    return queued;
  });
  await notifyJobQueued(result.job.id);
  return result;
}

async function prepareGitCheckout(
  row: any,
  executionFence?: JobExecutionFence
) {
  const revision = exactGitRevision(row.source_revision);
  const expectedComposeDigest = exactComposeSha256(row.compose_sha256);
  if (
    typeof row.compose_yaml !== "string"
    || composeSha256(row.compose_yaml) !== expectedComposeDigest
  ) {
    throw new Error(
      "The stored Compose definition no longer matches its analyzed digest. Analyze the repository again."
    );
  }
  const sourceIntegrity = inspectGitComposeSourceIntegrity(
    row.compose_yaml,
    row.compose_path
  );
  const host = await getHostForWorker(row.host_id);
  if (host.connectionMode !== "ssh") throw new Error("Git deployment requires an SSH host.");
  const target = row.working_dir;
  const source = row.source_locator;
  const username = row.credential_username ?? null;
  const secret = row.credential_secret_encrypted ? decryptSecret(row.credential_secret_encrypted) : null;
  const generatedCompose = row.compose_path === "composebastion.generated.yaml";
  const checkoutCleanGuard = gitComposeCheckoutCleanGuardCommands(
    target,
    sourceIntegrity,
    generatedCompose ? row.compose_path : undefined
  );
  const verifyTargetRevision = async () => {
    const verified = await runSshCommand(
      host.ssh,
      [
        `cd ${shQuote(target)}`,
        `test "$(git rev-parse --verify HEAD^{commit})" = ${shQuote(revision)}`,
        ...checkoutCleanGuard
      ].join(" && "),
      { timeoutMs: 30_000 }
    );
    if (verified.code !== 0) {
      throw new Error(
        "The deployment checkout no longer matches the analyzed Git revision. Analyze the repository again."
      );
    }
  };
  const cleanupStaging = async () => {
    if (typeof row.staging_directory !== "string") return;
    await runDeploymentRemoteMutation(
      row.id,
      "git-stage-cleanup",
      executionFence,
      () => removeDeploymentAnalysisStaging(
        host,
        row.id,
        row.staging_directory
      ),
      { hostId: row.host_id, workingDir: target, projectName: row.project_name }
    ).catch(() => undefined);
  };
  const writeGeneratedCompose = async () => {
    if (!generatedCompose) return;
    if (typeof row.compose_yaml !== "string" || !row.compose_yaml.trim()) {
      throw new Error("The generated Compose draft is missing. Analyze the repository again.");
    }
    await runDeploymentRemoteMutation(
      row.id,
      "generated-compose-write",
      executionFence,
      () => writeRemoteFile(host.ssh, path.posix.join(target, row.compose_path), row.compose_yaml),
      { hostId: row.host_id, workingDir: target, projectName: row.project_name }
    );
  };
  const verifyTargetCompose = async () => {
    const deployedCompose = await readRemoteFile(
      host.ssh,
      path.posix.join(target, row.compose_path),
      MAX_COMPOSE_BYTES
    );
    if (composeSha256(deployedCompose) !== expectedComposeDigest) {
      throw new Error(
        "The deployed Compose file does not match the analyzed definition. Analyze the repository again."
      );
    }
  };
  await executionCheckpoint(executionFence);
  const exists = await runSshCommand(host.ssh, `test -d ${shQuote(path.posix.join(target, ".git"))} && echo yes || echo no`, { timeoutMs: 30_000 });
  await executionCheckpoint(executionFence);
  if (exists.stdout.trim() === "yes") {
    const script = [
      "set -e",
      `cd ${shQuote(target)}`,
      ...checkoutCleanGuard,
      `test ${shQuote(normalizedGitUrl(source))} = "$(git remote get-url origin | sed -E 's/\\.git$//; s#/$##' | tr '[:upper:]' '[:lower:]')"`,
      `git fetch --quiet --tags origin`,
      [
        `if ! git cat-file -e ${shQuote(`${revision}^{commit}`)} 2>/dev/null`,
        `then git fetch --quiet --depth=1 origin ${shQuote(revision)} || true`,
        "fi"
      ].join("; "),
      row.branch
        ? [
            `if ! git cat-file -e ${shQuote(`${revision}^{commit}`)} 2>/dev/null`,
            `then git fetch --quiet origin ${shQuote(row.branch)} || true`,
            "fi"
          ].join("; ")
        : "",
      `git cat-file -e ${shQuote(`${revision}^{commit}`)}`,
      `git checkout --quiet --detach ${shQuote(revision)}`,
      `test "$(git rev-parse --verify HEAD^{commit})" = ${shQuote(revision)}`
    ].filter(Boolean).join("\n");
    const checkedOut = await runDeploymentRemoteMutation(
      row.id,
      "git-checkout-update",
      executionFence,
      () => runGit(
        row.id,
        host,
        `sh -c ${shQuote(script)}`,
        username,
        secret,
        10 * 60_000,
        executionFence
      ),
      { hostId: row.host_id, workingDir: target, projectName: row.project_name }
    );
    if (checkedOut.code !== 0) {
      throw new Error(
        "The existing checkout could not be pinned to the analyzed Git revision. Analyze the repository again."
      );
    }
    await verifyTargetRevision();
    await writeGeneratedCompose();
    await verifyTargetCompose();
    await cleanupStaging();
    return;
  }
  const stagingDirectory = typeof row.staging_directory === "string" ? row.staging_directory : "";
  const stagingAttempt = stagingDirectory
    ? expectedDeploymentAnalysisAttempt(
        host.public.username,
        row.id,
        stagingDirectory
      )
    : null;
  if (stagingDirectory && !stagingAttempt) {
    throw new Error(
      "The recorded deployment staging path is not owned by this analysis. Analyze the repository again."
    );
  }
  await executionCheckpoint(executionFence);
  const stagingExists = stagingDirectory
    ? await runSshCommand(
        host.ssh,
        `if [ -e ${shQuote(stagingDirectory)} ] || [ -L ${shQuote(stagingDirectory)} ]; then echo yes; else echo no; fi`,
        { timeoutMs: 30_000 }
      )
    : { stdout: "no" };
  await executionCheckpoint(executionFence);
  if (stagingExists.stdout.trim() === "yes") {
    const ownerFile = path.posix.join(
      stagingAttempt!.directory,
      DEPLOYMENT_ANALYSIS_OWNER_FILE
    );
    const checkoutOwnerFile = path.posix.join(
      stagingDirectory,
      ".git",
      DEPLOYMENT_ANALYSIS_CHECKOUT_OWNER_FILE
    );
    const targetCheckoutOwnerFile = path.posix.join(
      target,
      ".git",
      DEPLOYMENT_ANALYSIS_CHECKOUT_OWNER_FILE
    );
    const moved = await runDeploymentRemoteMutation(
      row.id,
      "git-stage-adopt",
      executionFence,
      () => runSshCommand(
        host.ssh,
        [
          `test ! -L ${shQuote(stagingAttempt!.directory)}`,
          `test -d ${shQuote(stagingAttempt!.directory)}`,
          `test ! -L ${shQuote(stagingDirectory)}`,
          `test ! -L ${shQuote(path.posix.join(stagingDirectory, ".git"))}`,
          `test -d ${shQuote(path.posix.join(stagingDirectory, ".git"))}`,
          `test ! -L ${shQuote(ownerFile)}`,
          `test -f ${shQuote(ownerFile)}`,
          `test "$(cat -- ${shQuote(ownerFile)})" = ${shQuote(stagingAttempt!.ownerRecord)}`,
          `test ! -L ${shQuote(checkoutOwnerFile)}`,
          `test -f ${shQuote(checkoutOwnerFile)}`,
          `test "$(cat -- ${shQuote(checkoutOwnerFile)})" = ${shQuote(stagingAttempt!.ownerRecord)}`,
          `cd ${shQuote(stagingDirectory)}`,
          `test "$(git rev-parse --verify HEAD^{commit})" = ${shQuote(revision)}`,
          ...gitComposeCheckoutCleanGuardCommands(
            stagingDirectory,
            sourceIntegrity,
            generatedCompose ? row.compose_path : undefined
          ),
          `mkdir -p ${shQuote(path.posix.dirname(target))}`,
          `test ! -e ${shQuote(target)} && test ! -L ${shQuote(target)}`,
          `mv -T -- ${shQuote(stagingDirectory)} ${shQuote(target)}`,
          `test ! -L ${shQuote(target)}`,
          `test -d ${shQuote(target)}`,
          `test ! -L ${shQuote(path.posix.join(target, ".git"))}`,
          `test -d ${shQuote(path.posix.join(target, ".git"))}`,
          `test ! -L ${shQuote(targetCheckoutOwnerFile)}`,
          `test -f ${shQuote(targetCheckoutOwnerFile)}`,
          `test "$(cat -- ${shQuote(targetCheckoutOwnerFile)})" = ${shQuote(stagingAttempt!.ownerRecord)}`
        ].join(" && "),
        { timeoutMs: 60_000 }
      ),
      { hostId: row.host_id, workingDir: target, projectName: row.project_name }
    );
    if (moved.code !== 0) {
      throw new Error(
        "The staged checkout no longer matches this analysis, its Git revision, or an unoccupied target path. Analyze the repository again."
      );
    }
    await verifyTargetRevision();
    await writeGeneratedCompose();
    await verifyTargetCompose();
    await cleanupStaging();
    return;
  }
  // A replacement clone would either follow a moving branch or need a new
  // crash-recoverable staging intent. Never create an unowned partial target
  // as a fallback. The user can safely generate a fresh pinned staging
  // checkout by analyzing the repository again.
  throw new Error(
    "The analyzed Git staging checkout is no longer available. Analyze the repository again."
  );
}

export async function executeDeployment(
  analysisId: string,
  executionFence?: JobExecutionFence,
  jobContext?: DeploymentJobContext
) {
  await executionCheckpoint(executionFence);
  const row = await withExecutionLease(executionFence, async (client) => {
    const rowResult = await client.query<any>(
      "SELECT * FROM deployment_analyses WHERE id = $1 FOR UPDATE",
      [analysisId]
    );
    const selected = rowResult.rows[0];
    if (!selected) throw new Error("Deployment analysis not found.");
    if (selected.status !== "deploying" && selected.status !== "failed") {
      throw new Error("Deployment analysis is not queued for deployment.");
    }
    // Queue/retry admission already owns the host and target through this
    // running operation_jobs row. Reacquiring enqueue advisory locks while
    // withActiveLease holds that row creates the inverse of enqueue's
    // host/target -> operation_jobs order and can deadlock a concurrent
    // generic mutation. Execution therefore relies on the immutable queued
    // scope; new work observes this running job and is rejected.
    if (selected.status === "failed") {
      const restarted = await client.query<any>(
        `UPDATE deployment_analyses
         SET status = 'deploying', error = null, updated_at = now()
         WHERE id = $1 AND status = 'failed'
         RETURNING *`,
        [analysisId]
      );
      if (!restarted.rows[0]) {
        throw new Error("This deployment execution attempt was superseded.");
      }
      return restarted.rows[0];
    }
    return selected;
  });

  let sensitiveFailureValues: string[] = [];
  try {
    const decryptedEnvironment = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
    const deploymentVariables = Array.isArray(row.variables) ? row.variables as Variable[] : [];
    const secretKeys = new Set(
      deploymentVariables.filter((variable) => variable.secret).map((variable) => variable.key)
    );
    for (const key of rawEnvValues(decryptedEnvironment).keys()) {
      if (SECRET_NAME.test(key)) secretKeys.add(key);
    }
    sensitiveFailureValues = sensitiveDeploymentEnvironmentValues(
      decryptedEnvironment,
      secretKeys
    );
    if (row.credential_secret_encrypted) {
      const credentialSecret = decryptSecret(row.credential_secret_encrypted);
      if (credentialSecret) sensitiveFailureValues.push(credentialSecret);
    }
    const protectedEnvironment = sanitizeEnvForResponse(decryptedEnvironment, secretKeys);
    if (row.source_type === "git") {
      const expectedEnvironmentDigest = exactEnvironmentSha256(row.environment_sha256);
      if (environmentSha256(decryptedEnvironment) !== expectedEnvironmentDigest) {
        throw new Error(
          "The queued Git environment no longer matches its durable digest. Analyze the repository again."
        );
      }
    }
    if (row.source_type === "git") await prepareGitCheckout(row, executionFence);
    let overwriteManagedFiles = false;
    if (row.source_type !== "git") {
      await executionCheckpoint(executionFence);
      overwriteManagedFiles = await sourceOwnsDeploymentPath(
        row,
        row.working_dir,
        row.compose_path,
        true
      );
      const existingDirectory = await statHostPath(row.host_id, row.working_dir).catch(() => ({ exists: false }));
      await executionCheckpoint(executionFence);
      if (existingDirectory?.exists && !overwriteManagedFiles) {
        throw new Error(`${row.working_dir} appeared after analysis and is not managed by this library source. Nothing was overwritten.`);
      }
    }
    await preflightDeploymentImages(
      analysisId,
      row.host_id,
      row.compose_yaml,
      decryptedEnvironment,
      executionFence
    );
    const action = row.source_type === "git"
      ? {
          type: "compose.deployPath" as const,
          hostId: row.host_id,
          payload: {
            projectName: row.project_name,
            workingDir: row.working_dir,
            composePath: row.compose_path
          }
        }
      : {
          type: "compose.writeDeployPath" as const,
          hostId: row.host_id,
          payload: {
            projectName: row.project_name,
            workingDir: row.working_dir,
            composePath: row.compose_path,
            composeYaml: row.compose_yaml,
            env: row.env_encrypted ? decryptSecret(row.env_encrypted) : "",
            overwrite: overwriteManagedFiles,
            pullBeforeDeploy: true
          }
        };
    const deployed = await runDeploymentRemoteMutation(
      analysisId,
      "compose-deploy",
      executionFence,
      () => executeDockerAction(
        action as any,
        executionFence,
        row.source_type === "git"
          ? {
              expectedComposeSha256: exactComposeSha256(row.compose_sha256),
              expectedGitRevision: exactGitRevision(row.source_revision),
              expectedGitBranch: row.branch ?? null,
              expectedEnvironmentSha256: exactEnvironmentSha256(row.environment_sha256),
              environmentOverride: decryptedEnvironment,
              persistedEnvironment: protectedEnvironment,
              deploymentSourceId: row.source_id ?? null,
              deploymentAnalysisId: analysisId
            }
          : {
              deploymentSourceId: row.source_id ?? null,
              deploymentAnalysisId: analysisId
            }
      ),
      {
        hostId: row.host_id,
        workingDir: row.working_dir,
        projectName: row.project_name,
        jobId: jobContext?.jobId,
        attemptCount: jobContext?.attemptCount
      }
    );
    try {
      const stackId = String((deployed as any).stackId);
      if (!stackId || stackId === "undefined" || stackId === "null") {
        throw new Error(
          "The deployment completed without a durable Compose stack identifier."
        );
      }
      const finalized = (deployed as any).deploymentFinalization;
      if (
        !finalized
        || finalized.stackId !== stackId
        || !finalized.analysis
        || !finalized.source
      ) {
        throw new Error(
          "The deployment completed without atomic source and analysis finalization."
        );
      }
      return {
        analysis: mapAnalysis(finalized.analysis),
        source: mapSource(finalized.source),
        stackId
      };
    } catch (error) {
      throw new DeploymentRemoteOutcomeUnknownError(
        analysisId,
        "compose-deploy-finalization",
        error
      );
    }
  } catch (error) {
    const redactedError = redactErrorSensitiveValues(
      error,
      sensitiveFailureValues
    );
    redactedError.message = String(
      sanitizeUrlDiagnosticText(redactedError.message)
    );
    const message = redactedError.message;
    if (!isJobLeaseLost(redactedError) && !(redactedError instanceof DeploymentRemoteOutcomeUnknownError)) {
      await executionQuery(
        executionFence,
        `UPDATE deployment_analyses
         SET status = 'failed', error = $2, updated_at = now()
         WHERE id = $1 AND status = 'deploying'`,
        [analysisId, message]
      ).catch(() => undefined);
    }
    throw redactedError;
  }
}

export async function listDeploymentSources() {
  const result = await query<any>(
    `SELECT sources.*,
            COALESCE(
              array_agg(DISTINCT stacks.host_id) FILTER (WHERE stacks.host_id IS NOT NULL),
              ARRAY[]::uuid[]
            ) AS target_host_ids
     FROM deployment_sources AS sources
     LEFT JOIN compose_stacks AS stacks ON stacks.deployment_source_id = sources.id
     GROUP BY sources.id
     ORDER BY sources.last_deployed_at DESC NULLS LAST, sources.name ASC`
  );
  return result.rows.map(mapSource);
}

export async function getDeploymentSource(id: string) {
  const result = await query<any>(
    `SELECT sources.*,
            COALESCE(
              array_agg(DISTINCT stacks.host_id) FILTER (WHERE stacks.host_id IS NOT NULL),
              ARRAY[]::uuid[]
            ) AS target_host_ids
     FROM deployment_sources AS sources
     LEFT JOIN compose_stacks AS stacks ON stacks.deployment_source_id = sources.id
     WHERE sources.id = $1
     GROUP BY sources.id`,
    [id]
  );
  return result.rows[0] ? mapSource(result.rows[0]) : null;
}

export async function createDeploymentSource(
  input: unknown,
  onChanged?: (
    client: PoolClient,
    source: DeploymentSource
  ) => Promise<void>
) {
  const parsed = deploymentSourceCreateSchema.parse(input);
  const sourceLocator = canonicalizeDeploymentSource(parsed.sourceLocator, parsed.sourceType);
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<any>(
        `INSERT INTO deployment_sources (
           id, source_type, name, source_locator, branch, compose_path, working_dir, project_name,
           compose_yaml, env_encrypted, credential_username, credential_secret_encrypted,
           default_host_id, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '{}')
         RETURNING *`,
        [
          uuid(),
          parsed.sourceType,
          parsed.name,
          sourceLocator,
          parsed.branch ?? null,
          parsed.composePath ?? null,
          parsed.workingDir ?? null,
          parsed.projectName,
          parsed.composeYaml ?? null,
          parsed.env ? encryptSecret(parsed.env) : null,
          parsed.credentialUsername ?? null,
          parsed.credentialSecret ? encryptSecret(parsed.credentialSecret) : null,
          parsed.defaultHostId ?? null
        ]
      );
      const source = mapSource(result.rows[0]);
      await onChanged?.(client, source);
      return source;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw Object.assign(new Error("This deployment source is already in My Library."), { statusCode: 409 });
    }
    throw error;
  }
}

export async function updateDeploymentSource(
  id: string,
  input: unknown,
  onChanged?: (
    client: PoolClient,
    source: DeploymentSource
  ) => Promise<void>
) {
  const parsed = deploymentSourceUpdateSchema.parse(input);
  try {
    return await withTransaction(async (client) => {
      const current = (
        await client.query<any>(
          "SELECT * FROM deployment_sources WHERE id = $1 FOR UPDATE",
          [id]
        )
      ).rows[0];
      if (!current) return null;
      let environmentEncrypted = current.env_encrypted;
      if (parsed.safeEnvironment) {
        const invalidKey = Object.keys(parsed.safeEnvironment).find(
          (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SECRET_NAME.test(key)
        );
        if (invalidKey) {
          throw Object.assign(
            new Error(`'${invalidKey}' is not a safe non-secret environment default.`),
            { statusCode: 400 }
          );
        }
        const mergedEnvironment = current.env_encrypted
          ? rawEnvValues(decryptSecret(current.env_encrypted))
          : new Map<string, string>();
        for (const key of Array.from(mergedEnvironment.keys())) {
          if (!SECRET_NAME.test(key)) mergedEnvironment.delete(key);
        }
        for (const [key, value] of Object.entries(parsed.safeEnvironment)) {
          mergedEnvironment.set(key, value);
        }
        const serialized = serializeEnv(mergedEnvironment);
        environmentEncrypted = serialized ? encryptSecret(serialized) : null;
      }
      const credentialSecret = parsed.clearCredential
        ? null
        : parsed.credentialSecret
          ? encryptSecret(parsed.credentialSecret)
          : current.credential_secret_encrypted;
      const result = await client.query<any>(
        `UPDATE deployment_sources
         SET name = COALESCE($2, name),
             branch = CASE WHEN $3::boolean THEN $4 ELSE branch END,
             compose_path = CASE WHEN $5::boolean THEN $6 ELSE compose_path END,
             working_dir = CASE WHEN $7::boolean THEN $8 ELSE working_dir END,
             project_name = COALESCE($9, project_name),
             default_host_id = CASE WHEN $10::boolean THEN $11 ELSE default_host_id END,
             credential_username = CASE WHEN $12::boolean THEN $13 ELSE credential_username END,
             credential_secret_encrypted = $14,
             env_encrypted = $15,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          parsed.name ?? null,
          parsed.branch !== undefined,
          parsed.branch ?? null,
          parsed.composePath !== undefined,
          parsed.composePath ?? null,
          parsed.workingDir !== undefined,
          parsed.workingDir ?? null,
          parsed.projectName ?? null,
          parsed.defaultHostId !== undefined,
          parsed.defaultHostId ?? null,
          parsed.credentialUsername !== undefined || parsed.clearCredential,
          parsed.clearCredential ? null : parsed.credentialUsername ?? null,
          credentialSecret,
          environmentEncrypted
        ]
      );
      const source = mapSource(result.rows[0]);
      await onChanged?.(client, source);
      return source;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw Object.assign(new Error("Another My Library source already uses this branch and Compose path."), { statusCode: 409 });
    }
    throw error;
  }
}

export async function deleteDeploymentSource(
  id: string,
  onChanged?: (client: PoolClient) => Promise<void>
) {
  return withTransaction(async (client) => {
    const result = await client.query(
      "DELETE FROM deployment_sources WHERE id = $1 RETURNING id",
      [id]
    );
    if (!result.rows[0]) return false;
    await onChanged?.(client);
    return true;
  });
}

async function expireLockedDeploymentAnalysisRows(client: PoolClient, lockedRows: any[]) {
  const candidates = lockedRows.filter((row) => (
    row.expiration_due === true
    && row.status !== "deployed"
    && row.status !== "expired"
  ));
  if (!candidates.length) return { rows: lockedRows, expired: [] as any[] };

  const candidateIds = candidates.map((row) => String(row.id));
  const active = await client.query<{ analysis_id: string }>(
    `SELECT DISTINCT jobs.payload->>'analysisId' AS analysis_id
     FROM operation_jobs AS jobs
     WHERE jobs.status IN ('queued', 'running')
       AND jobs.type IN ('deploy.analyze', 'deploy.execute')
       AND jobs.payload->>'analysisId' = ANY($1::text[])`,
    [candidateIds]
  );
  const activeIds = new Set(active.rows.map((row) => row.analysis_id));
  const expirableIds = candidateIds.filter((id) => !activeIds.has(id));
  if (!expirableIds.length) return { rows: lockedRows, expired: [] as any[] };

  const updated = await client.query<any>(
    `UPDATE deployment_analyses
     SET status = 'expired',
         env_encrypted = null,
         credential_secret_encrypted = null,
         updated_at = now()
     WHERE id = ANY($1::uuid[])
       AND expires_at <= clock_timestamp()
       AND status NOT IN ('deployed', 'expired')
     RETURNING *, true AS expiration_due`,
    [expirableIds]
  );
  const updatedById = new Map(updated.rows.map((row) => [String(row.id), row]));
  return {
    rows: lockedRows.map((row) => updatedById.get(String(row.id)) ?? row),
    expired: updated.rows
  };
}

type DeploymentAnalysisStagingCleanupFailure = {
  analysisId: string;
  hostId: string;
  code:
    | "host_unavailable"
    | "host_not_ssh"
    | "path_mismatch"
    | "legacy_unowned"
    | "remove_failed"
    | "obligation_changed"
    | "cleanup_error";
  error: string;
};

function deploymentAnalysisCleanupDiagnostic(error: unknown) {
  const sanitized = String(sanitizeUrlDiagnosticText(
    error instanceof Error ? error.message : String(error)
  ));
  return sanitized.length <= 2_048 ? sanitized : `${sanitized.slice(0, 2_047)}…`;
}

function expectedDeploymentAnalysisStagingDirectory(
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  analysisId: string,
  recordedDirectory?: string
) {
  const username = host.public.username;
  if (typeof username !== "string" || !username) return null;
  const legacy = deploymentAnalysisLegacyStagingDirectory(username, analysisId);
  if (!recordedDirectory || recordedDirectory === legacy) return legacy;
  return expectedDeploymentAnalysisAttempt(username, analysisId, recordedDirectory)
    ?.checkoutDirectory ?? null;
}

async function cleanupDeploymentAnalysisStagingResidue(limit = 100) {
  const candidates = await query<{
    id: string;
    host_id: string;
  }>(
    `SELECT analyses.id, analyses.host_id
     FROM deployment_analyses AS analyses
     WHERE analyses.staging_directory IS NOT NULL
       AND analyses.status IN ('failed', 'deployed', 'expired')
       AND NOT EXISTS (
         SELECT 1
         FROM operation_jobs AS jobs
         WHERE jobs.status IN ('queued', 'running')
           AND jobs.type IN ('deploy.analyze', 'deploy.execute')
           AND jobs.payload->>'analysisId' = analyses.id::text
       )
     ORDER BY analyses.updated_at ASC
     LIMIT $1`,
    [limit]
  );
  let cleaned = 0;
  let skipped = 0;
  const failures: DeploymentAnalysisStagingCleanupFailure[] = [];

  for (const candidate of candidates.rows) {
    try {
      const outcome = await withTransaction(async (client) => {
        // Keep the terminal analysis row locked across the remote removal.
        // Every supported retry/admission path takes this row before reviving
        // work, so cleanup cannot delete a checkout that became active.
        const selected = await client.query<{
          id: string;
          host_id: string;
          staging_directory: string;
        }>(
          `SELECT analyses.id, analyses.host_id, analyses.staging_directory
           FROM deployment_analyses AS analyses
           WHERE analyses.id = $1
             AND analyses.host_id = $2
             AND analyses.staging_directory IS NOT NULL
             AND analyses.status IN ('failed', 'deployed', 'expired')
             AND NOT EXISTS (
               SELECT 1
               FROM operation_jobs AS jobs
               WHERE jobs.status IN ('queued', 'running')
                 AND jobs.type IN ('deploy.analyze', 'deploy.execute')
                 AND jobs.payload->>'analysisId' = analyses.id::text
             )
           FOR UPDATE OF analyses SKIP LOCKED`,
          [candidate.id, candidate.host_id]
        );
        const row = selected.rows[0];
        if (!row) return { kind: "skipped" as const };

        let host: Awaited<ReturnType<typeof getHostForWorker>>;
        try {
          host = await getHostForWorker(row.host_id);
        } catch (error) {
          return {
            kind: "failed" as const,
            failure: {
              analysisId: row.id,
              hostId: row.host_id,
              code: "host_unavailable" as const,
              error: deploymentAnalysisCleanupDiagnostic(error)
            }
          };
        }
        if (host.connectionMode !== "ssh") {
          return {
            kind: "failed" as const,
            failure: {
              analysisId: row.id,
              hostId: row.host_id,
              code: "host_not_ssh" as const,
              error: "The analysis staging host is no longer available through SSH."
            }
          };
        }

        const expectedDirectory = expectedDeploymentAnalysisStagingDirectory(
          host,
          row.id,
          row.staging_directory
        );
        if (!expectedDirectory || row.staging_directory !== expectedDirectory) {
          return {
            kind: "failed" as const,
            failure: {
              analysisId: row.id,
              hostId: row.host_id,
              code: "path_mismatch" as const,
              error: "The recorded staging directory does not match the managed path for this analysis and host."
            }
          };
        }

        const removal = await removeDeploymentAnalysisStaging(
          host,
          row.id,
          expectedDirectory
        );
        if (!removal.removed) {
          if (removal.code === "legacy_unowned") {
            return {
              kind: "failed" as const,
              failure: {
                analysisId: row.id,
                hostId: row.host_id,
                code: "legacy_unowned" as const,
                error: "The legacy staging directory has no ownership marker and was preserved for manual inspection."
              }
            };
          }
          return {
            kind: "failed" as const,
            failure: {
              analysisId: row.id,
              hostId: row.host_id,
              code: "remove_failed" as const,
              error: deploymentAnalysisCleanupDiagnostic(
                removal.result?.stderr
                || removal.result?.stdout
                || `Remote removal exited with code ${removal.result?.code ?? "unknown"}.`
              )
            }
          };
        }

        const cleared = await client.query(
          `UPDATE deployment_analyses AS analyses
           SET staging_directory = null, updated_at = now()
           WHERE analyses.id = $1
             AND analyses.host_id = $2
             AND analyses.staging_directory = $3
             AND analyses.status IN ('failed', 'deployed', 'expired')
             AND NOT EXISTS (
               SELECT 1
               FROM operation_jobs AS jobs
               WHERE jobs.status IN ('queued', 'running')
                 AND jobs.type IN ('deploy.analyze', 'deploy.execute')
                 AND jobs.payload->>'analysisId' = analyses.id::text
             )
           RETURNING analyses.id`,
          [row.id, row.host_id, expectedDirectory]
        );
        if (cleared.rowCount !== 1) {
          return {
            kind: "failed" as const,
            failure: {
              analysisId: row.id,
              hostId: row.host_id,
              code: "obligation_changed" as const,
              error: "The staging cleanup obligation changed before its successful removal could be recorded."
            }
          };
        }
        return { kind: "cleaned" as const };
      });

      if (outcome.kind === "cleaned") cleaned += 1;
      else if (outcome.kind === "skipped") skipped += 1;
      else failures.push(outcome.failure);
    } catch (error) {
      failures.push({
        analysisId: candidate.id,
        hostId: candidate.host_id,
        code: "cleanup_error",
        error: deploymentAnalysisCleanupDiagnostic(error)
      });
    }
  }

  const result = {
    checked: candidates.rows.length,
    cleaned,
    skipped,
    failures
  };
  if (failures.length) {
    console.warn("worker.deployment_analysis_staging_cleanup", result);
  }
  return result;
}

export async function cleanupExpiredDeploymentAnalyses() {
  const expired = await withTransaction(async (client) => {
    const selected = await client.query<any>(
      `SELECT analyses.*,
              true AS expiration_due
       FROM deployment_analyses AS analyses
       WHERE analyses.expires_at <= now()
         AND analyses.status NOT IN ('deployed', 'expired')
       FOR UPDATE OF analyses SKIP LOCKED`
    );
    return expireLockedDeploymentAnalysisRows(client, selected.rows);
  });
  const stagingCleanup = await cleanupDeploymentAnalysisStagingResidue();
  return { expired: expired.expired.length, stagingCleanup };
}

export async function backfillDeploymentSourceEncryptedEnvironment() {
  const pending = await query<any>(
    `SELECT sources.id,
            COALESCE(repositories.env, stacks.env, '') AS env
     FROM deployment_sources AS sources
     LEFT JOIN github_repositories AS repositories
       ON repositories.id::text = sources.metadata->>'legacyGithubRepositoryId'
     LEFT JOIN compose_stacks AS stacks
       ON stacks.id::text = sources.metadata->>'backfilledFromStack'
     WHERE sources.env_encrypted IS NULL
       AND COALESCE(repositories.env, stacks.env, '') <> ''`
  );
  let updated = 0;
  for (const row of pending.rows) {
    const result = await query(
      `UPDATE deployment_sources
       SET env_encrypted = $2, updated_at = now()
       WHERE id = $1 AND env_encrypted IS NULL`,
      [row.id, encryptSecret(row.env)]
    );
    updated += result.rowCount ?? 0;
  }
  return { updated };
}

export function mergeDockerDaemonRegistryTrust(
  current: Record<string, unknown>,
  registry: string
) {
  const existing = Array.isArray(current["insecure-registries"])
    ? current["insecure-registries"].filter((item): item is string => typeof item === "string")
    : [];
  return {
    ...current,
    "insecure-registries": Array.from(new Set([...existing, registry])).sort()
  };
}

export const deploymentAnalysisInternals = {
  iso,
  jsonValue,
  mapSource,
  mapAnalysis,
  projectName,
  displayName,
  sourceBasename,
  isYamlText,
  isGitLikeUrl,
  homeDeploymentRoot,
  scalar,
  summarizedPort,
  summarizeCompose,
  parseEnvText,
  rawEnvValues,
  serializeEnv,
  sanitizeEnvForResponse,
  mergeStoredAnalysisEnv,
  mergeRequestedEnv,
  variablesToEnv,
  referencedImages,
  normalizedGitUrl,
  imageAuthority,
  parseImageInspect,
  composeSha256,
  environmentSha256,
  exactGitRevision,
  exactComposeSha256,
  exactEnvironmentSha256,
  declaredHostPort,
  dockerRegistryTrust,
  gitCredentialEnvironment,
  trackedGitFiles,
  deploymentAnalysisAttempt,
  expectedDeploymentAnalysisAttempt,
  removeDeploymentAnalysisStaging,
  prepareGitCheckout,
  deploymentTargetAdmissionKeys,
  assertDeploymentTargetAvailable
};

export async function configureRegistryTrust(
  hostId: string,
  registry: string,
  executionFence?: JobExecutionFence,
  jobContext?: DeploymentJobContext
) {
  await executionCheckpoint(executionFence);
  const before = await checkRegistryTrust(hostId, registry, true);
  await executionCheckpoint(executionFence);
  if (before.trusted) return { ...before, changed: false };
  if (!before.canApply) throw new Error("Passwordless sudo is required to configure Docker registry trust automatically.");
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Automatic registry trust repair currently requires an SSH host.");

  const currentResult = await runSshCommand(
    host.ssh,
    "if sudo -n test -f /etc/docker/daemon.json; then sudo -n cat /etc/docker/daemon.json; else printf '{}'; fi",
    { timeoutMs: 30_000 }
  );
  await executionCheckpoint(executionFence);
  if (currentResult.code !== 0) throw new Error("Could not read Docker's daemon configuration.");
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(currentResult.stdout || "{}");
  } catch {
    throw new Error("/etc/docker/daemon.json is not valid JSON. Repair it manually before applying registry trust.");
  }
  const merged = mergeDockerDaemonRegistryTrust(current, before.registry);
  const candidate = `${JSON.stringify(merged, null, 2)}\n`;
  if (
    !jobContext
    || executionFence?.jobId !== jobContext.jobId
    || executionFence?.attemptCount !== jobContext.attemptCount
  ) {
    throw new Error(
      "Registry trust configuration requires its exact durable job attempt."
    );
  }
  const { candidatePath, backupPath } =
    registryTrustArtifactPaths(jobContext);
  const restoreOriginalConfiguration = async () => {
    try {
      const restored = await withRemoteMutationContext(
        executionFence,
        "registry-trust-restore",
        () => runSshCommand(
          host.ssh,
          `if sudo -n test -f ${shQuote(backupPath)}; then sudo -n cp ${shQuote(backupPath)} /etc/docker/daemon.json; else sudo -n rm -f /etc/docker/daemon.json; fi; sudo -n systemctl restart docker`,
          { timeoutMs: 120_000 }
        )
      );
      return restored.code === 0;
    } catch {
      return false;
    }
  };
  let preserveAmbiguousRemoteMutationProof = false;
  try {
    await executionCheckpoint(executionFence);
    await withRemoteMutationContext(
      executionFence,
      "registry-trust-stage",
      () => writeRemoteFile(host.ssh, candidatePath, candidate)
    );
    await executionCheckpoint(executionFence);
    const validate = await runSshCommand(
      host.ssh,
      `sudo -n dockerd --validate --config-file ${shQuote(candidatePath)}`,
      { timeoutMs: 60_000 }
    );
    await executionCheckpoint(executionFence);
    if (validate.code !== 0) throw new Error(validate.stderr || "Docker rejected the candidate daemon configuration.");
    let install: Awaited<ReturnType<typeof runSshCommand>>;
    try {
      await executionCheckpoint(executionFence);
      install = await withRemoteMutationContext(
        executionFence,
        "registry-trust-install",
        () => runSshCommand(
          host.ssh,
          [
            "sudo -n mkdir -p /etc/docker",
            `if sudo -n test -f /etc/docker/daemon.json; then sudo -n cp /etc/docker/daemon.json ${shQuote(backupPath)}; fi`,
            `sudo -n cp ${shQuote(candidatePath)} /etc/docker/daemon.json`,
            "sudo -n systemctl restart docker"
          ].join(" && "),
          { timeoutMs: 120_000 }
        )
      );
      await executionCheckpoint(executionFence);
    } catch (error) {
      console.warn("worker.registry_trust.remote_outcome_unknown", {
        hostId,
        registry: before.registry,
        backupPath,
        jobId: jobContext?.jobId,
        attemptCount: jobContext?.attemptCount
      });
      throw new RegistryTrustRemoteOutcomeUnknownError(
        hostId,
        before.registry,
        error
      );
    }
    if (install.code !== 0) {
      const restored = await restoreOriginalConfiguration();
      if (!restored) {
        throw new RegistryTrustRemoteOutcomeUnknownError(
          hostId,
          before.registry,
          new Error("Docker configuration installation and automatic restoration both failed.")
        );
      }
      throw new Error("Docker did not restart cleanly. The original daemon configuration was restored.");
    }
    let after: Awaited<ReturnType<typeof checkRegistryTrust>>;
    try {
      await executionCheckpoint(executionFence);
      after = await checkRegistryTrust(hostId, before.registry, true);
      await executionCheckpoint(executionFence);
    } catch (error) {
      throw new RegistryTrustRemoteOutcomeUnknownError(
        hostId,
        before.registry,
        error
      );
    }
    if (!after.trusted) {
      const restored = await restoreOriginalConfiguration();
      if (!restored) {
        throw new RegistryTrustRemoteOutcomeUnknownError(
          hostId,
          before.registry,
          new Error("Docker registry trust verification and automatic restoration both failed.")
        );
      }
      throw new Error("Docker restarted, but the registry was still not trusted. The original daemon configuration was restored.");
    }
    return { ...after, changed: true, backupPath };
  } catch (error) {
    preserveAmbiguousRemoteMutationProof = (
      isJobLeaseLost(error)
      || isRemoteMutationOutcomeUnknown(error)
      || error instanceof RegistryTrustRemoteOutcomeUnknownError
    );
    throw error;
  } finally {
    if (!preserveAmbiguousRemoteMutationProof) {
      try {
        const cleanup = await withRemoteMutationContext(
          executionFence,
          "registry-trust-stage-cleanup",
          () => runSshCommand(
            host.ssh,
            `rm -f -- ${shQuote(candidatePath)}`,
            { timeoutMs: 30_000 }
          )
        );
        if (cleanup.code !== 0) {
          throw new Error(
            cleanup.stderr
            || cleanup.stdout
            || "Registry trust candidate cleanup failed"
          );
        }
      } catch (error) {
        throw new RegistryTrustCandidateCleanupRequiredError(error);
      }
    }
  }
}
