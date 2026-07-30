import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { v4 as uuid } from "uuid";
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
import { statHostPath } from "./files.js";
import { getHostForWorker } from "./hosts.js";
import { findRegistryAuthForReference } from "./imageUpdates.js";
import { enqueueJobInTransaction, notifyJobQueued } from "./jobs.js";
import { guardedRegistryRequest, type RegistryResolver } from "./registryHttp.js";
import { parseImageReference } from "./registryManifest.js";
import { readRemoteFile, runSshCommand, writeRemoteFile } from "./ssh.js";

const ANALYSIS_TTL_HOURS = 2;
const MAX_COMPOSE_BYTES = 512 * 1024;
const SECRET_NAME = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth|database[_-]?url|dsn|connection[_-]?string)/i;
const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const COMPOSE_FILE = /(^|\/)(?:compose|docker-compose)\.ya?ml$/i;
const SAFE_PROJECT = /[^a-z0-9_-]+/g;

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

function mapAnalysis(row: any): DeploymentAnalysis {
  const status = row.status !== "deployed" && new Date(row.expires_at).getTime() <= Date.now()
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
  const parsed = parseYaml(composeYaml) as any;
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
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let entryValue = match[2] ?? "";
    if ((entryValue.startsWith("\"") && entryValue.endsWith("\"")) || (entryValue.startsWith("'") && entryValue.endsWith("'"))) {
      entryValue = entryValue.slice(1, -1);
    }
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
  const result = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let entryValue = match[2] ?? "";
    if ((entryValue.startsWith("\"") && entryValue.endsWith("\"")) || (entryValue.startsWith("'") && entryValue.endsWith("'"))) {
      entryValue = entryValue.slice(1, -1);
    }
    result.set(match[1]!, entryValue);
  }
  return result;
}

function serializeEnv(values: Map<string, string>) {
  return Array.from(values, ([key, value]) => `${key}=${value}`).join("\n");
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
  return variables
    .filter((variable) => variable.value !== "" || !variable.required)
    .map((variable) => `${variable.key}=${variable.value}`)
    .join("\n");
}

function referencedImages(services: ServiceSummary[]) {
  return services.map((service) => service.image).filter((image): image is string => Boolean(image && !image.includes("${")));
}

function normalizedGitUrl(value: string) {
  return value.trim().replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase();
}

async function gitCredentialEnvironment(
  analysisId: string,
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  username: string | null,
  secret: string | null
) {
  if (!username || !secret) return { prefix: "GIT_TERMINAL_PROMPT=0", cleanup: async () => undefined };
  const askpass = `/tmp/composebastion-git-${analysisId}.askpass`;
  const credentialFile = `/tmp/composebastion-git-${analysisId}.credentials`;
  await writeRemoteFile(
    host.ssh,
    credentialFile,
    `${Buffer.from(username).toString("base64")}\n${Buffer.from(secret).toString("base64")}\n`
  );
  const script = [
    "#!/bin/sh",
    "case \"$1\" in",
    `  *Username*) sed -n '1p' ${shQuote(credentialFile)} | base64 -d ;;`,
    `  *) sed -n '2p' ${shQuote(credentialFile)} | base64 -d ;;`,
    "esac",
    ""
  ].join("\n");
  try {
    await writeRemoteFile(host.ssh, askpass, script);
    const chmod = await runSshCommand(host.ssh, `chmod 0700 ${shQuote(askpass)}`, { timeoutMs: 30_000 });
    if (chmod.code !== 0) throw new Error("Could not protect the temporary Git credential helper.");
  } catch (error) {
    await runSshCommand(
      host.ssh,
      `rm -f -- ${shQuote(askpass)} ${shQuote(credentialFile)}`,
      { timeoutMs: 30_000 }
    ).catch(() => undefined);
    throw error;
  }
  return {
    prefix: `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=${shQuote(askpass)}`,
    cleanup: async () => {
      await runSshCommand(
        host.ssh,
        `rm -f -- ${shQuote(askpass)} ${shQuote(credentialFile)}`,
        { timeoutMs: 30_000 }
      ).catch(() => undefined);
    }
  };
}

async function runGit(
  analysisId: string,
  host: Awaited<ReturnType<typeof getHostForWorker>>,
  command: string,
  credentialUsername: string | null,
  credentialSecret: string | null,
  timeoutMs = 60_000
) {
  const credential = await gitCredentialEnvironment(analysisId, host, credentialUsername, credentialSecret);
  try {
    return await runSshCommand(host.ssh, `${credential.prefix} ${command}`, { timeoutMs });
  } finally {
    await credential.cleanup();
  }
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

async function analyzeGit(row: any): Promise<Omit<AnalysisResult, "registryIssues">> {
  const host = await getHostForWorker(row.host_id);
  const locator = canonicalizeDeploymentSource(row.source_input, "git");
  const repoName = sourceBasename(locator).replace(/\.git$/i, "");
  const appProject = projectName(row.project_name || repoName);
  const root = homeDeploymentRoot(host.public.username);
  const staging = path.posix.join(root, ".analysis", row.id);
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
  const noCredentialAccess = await runGit(row.id, host, `git ls-remote --symref ${shQuote(remote)} HEAD`, null, null);
  let access = noCredentialAccess;
  if (access.code !== 0 && /^https?:\/\//i.test(remote) && !/\.git$/i.test(new URL(remote).pathname)) {
    const withSuffix = `${remote}.git`;
    const suffixAccess = await runGit(row.id, host, `git ls-remote --symref ${shQuote(withSuffix)} HEAD`, null, null);
    if (suffixAccess.code === 0) {
      remote = withSuffix;
      access = suffixAccess;
    }
  }
  if (access.code !== 0 && secret) {
    access = await runGit(row.id, host, `git ls-remote --symref ${shQuote(remote)} HEAD`, username, secret);
    usedCredentials = access.code === 0;
    if (access.code !== 0 && /^https?:\/\//i.test(remote) && !/\.git$/i.test(new URL(remote).pathname)) {
      const withSuffix = `${remote}.git`;
      const suffixAccess = await runGit(row.id, host, `git ls-remote --symref ${shQuote(withSuffix)} HEAD`, username, secret);
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
  await runSshCommand(
    host.ssh,
    `mkdir -p ${shQuote(path.posix.dirname(staging))} && rm -rf -- ${shQuote(staging)}`,
    { timeoutMs: 30_000 }
  );
  const cloneArgs = [
    "git clone --depth 1",
    detectedBranch ? `--branch ${shQuote(detectedBranch)}` : "",
    shQuote(remote),
    shQuote(staging)
  ].filter(Boolean).join(" ");
  const clone = await runGit(row.id, host, cloneArgs, usedCredentials ? username : null, usedCredentials ? secret : null, 10 * 60_000);
  if (clone.code !== 0) {
    await runSshCommand(host.ssh, `rm -rf -- ${shQuote(staging)}`, { timeoutMs: 30_000 }).catch(() => undefined);
    throw new Error("The repository was reachable but could not be staged on the selected host.");
  }

  const listing = await runSshCommand(host.ssh, `cd ${shQuote(staging)} && git ls-files`, { timeoutMs: 30_000 });
  if (listing.code !== 0) throw new Error("Could not inspect the staged repository.");
  const files = listing.stdout.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
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
  if (composeYaml) {
    services = summarizeCompose(composeYaml);
    variables = extractDeploymentVariables(composeYaml, exampleEnv);
  }

  const checkoutStatus = dockerfileGenerated
    ? "git status --porcelain -- . ':(exclude)composebastion.generated.yaml'"
    : "git status --porcelain";
  const existing = await runSshCommand(
    host.ssh,
    `if test ! -e ${shQuote(workingDir)}; then echo absent; elif test -d ${shQuote(path.posix.join(workingDir, ".git"))}; then cd ${shQuote(workingDir)} && printf 'git\\n' && git remote get-url origin && ${checkoutStatus}; else echo unrelated; fi`,
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
    } else if (changes.length) {
      blockers.push({ code: "dirty_checkout", message: `${workingDir} has local changes. Commit, stash, or remove them before deploying.` });
    } else {
      warnings.push({ code: "existing_checkout", message: "A clean checkout of this source already exists and will be fast-forwarded during deployment." });
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

async function analyzeImage(row: any): Promise<Omit<AnalysisResult, "registryIssues">> {
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
      await runDocker(row.host_id, `docker pull ${shQuote(locator)}`, 10 * 60_000);
      inspect = await runDocker(row.host_id, `docker image inspect ${shQuote(locator)}`, 30_000);
    } catch {
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

async function preflightDeploymentImages(hostId: string, composeYaml: string) {
  const services = summarizeCompose(composeYaml);
  const images = referencedImages(services);
  for (const image of images) {
    const saved = await findRegistryAuthForReference(image).catch(() => null);
    if (saved) {
      await executeDockerAction({
        type: "registry.login",
        hostId,
        payload: { registryId: saved.id }
      });
    }
    await runDocker(hostId, `docker pull ${shQuote(image)}`, 10 * 60_000);
  }
}

export async function createDeploymentAnalysis(input: unknown, createdBy?: string | null) {
  const parsed = deploymentAnalysisCreateSchema.parse(input);
  const sourceRow = parsed.sourceId
    ? (await query<any>("SELECT * FROM deployment_sources WHERE id = $1", [parsed.sourceId])).rows[0]
    : null;
  if (parsed.sourceId && !sourceRow) throw Object.assign(new Error("Deployment source not found."), { statusCode: 404 });
  const source = parsed.source || sourceRow?.source_locator;
  const sourceType = parsed.sourceType ?? sourceRow?.source_type ?? detectDeploymentSourceType(source, parsed.composeYaml);
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
  const id = uuid();
  const result = await withTransaction(async (client) => {
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
    return { analysis: mapAnalysis(inserted.rows[0]), job };
  });
  await notifyJobQueued(result.job.id);
  return result;
}

export async function getDeploymentAnalysis(id: string) {
  const result = await query<any>("SELECT * FROM deployment_analyses WHERE id = $1", [id]);
  if (!result.rows[0]) return null;
  const analysis = mapAnalysis(result.rows[0]);
  if (analysis.status === "expired" && result.rows[0].status !== "expired") {
    await query(
      `UPDATE deployment_analyses
       SET status = 'expired',
           env_encrypted = null,
           credential_secret_encrypted = null,
           updated_at = now()
       WHERE id = $1`,
      [id]
    );
  }
  return analysis;
}

export async function analyzeDeployment(analysisId: string) {
  const rowResult = await query<any>("SELECT * FROM deployment_analyses WHERE id = $1", [analysisId]);
  const row = rowResult.rows[0];
  if (!row) throw new Error("Deployment analysis not found.");
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("Deployment analysis expired. Analyze the source again.");
  await query(
    `UPDATE deployment_analyses
     SET status = 'analyzing', error = null, warnings = '[]', blockers = '[]', registry_issues = '[]', updated_at = now()
     WHERE id = $1`,
    [analysisId]
  );
  try {
    const base = row.source_type === "git"
      ? await analyzeGit(row)
      : row.source_type === "compose_url" || row.source_type === "compose_upload"
        ? await analyzeCompose(row, row.source_type)
        : await analyzeImage(row);
    const storedEnv = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
    const mergedConfiguration = mergeStoredAnalysisEnv(base.env, storedEnv, base.variables);
    base.env = mergedConfiguration.env;
    base.variables = mergedConfiguration.variables;
    const registryIssues = base.composeYaml
      ? await registryIssuesFor(row.host_id, referencedImages(base.summary.services), row.source_input)
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
    const updated = await query<any>(
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
           error = null,
           updated_at = now()
       WHERE id = $1
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
        JSON.stringify(registryIssues)
      ]
    );
    return { analysis: mapAnalysis(updated.rows[0]) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query(
      "UPDATE deployment_analyses SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
      [analysisId, message]
    );
    throw error;
  }
}

export async function queueDeployment(analysisId: string, input: unknown, createdBy?: string | null) {
  const parsed = deploymentAnalysisDeploySchema.parse(input ?? {});
  const rowResult = await query<any>("SELECT * FROM deployment_analyses WHERE id = $1", [analysisId]);
  const row = rowResult.rows[0];
  if (!row) throw Object.assign(new Error("Deployment analysis not found."), { statusCode: 404 });
  if (new Date(row.expires_at).getTime() <= Date.now()) throw Object.assign(new Error("Deployment analysis expired. Analyze the source again."), { statusCode: 409 });
  if (row.status !== "ready") throw Object.assign(new Error("This source is not ready to deploy."), { statusCode: 409 });
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
    ...await composePortConflicts(row.host_id, candidateProjectName, candidateServices, row.source_id),
    ...(await registryIssuesFor(row.host_id, referencedImages(candidateServices), row.source_input))
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

  const result = await withTransaction(async (client) => {
    const updated = await client.query<any>(
      `UPDATE deployment_analyses
       SET status = 'deploying',
           display_name = COALESCE($2, display_name),
           project_name = COALESCE($3, project_name),
           branch = COALESCE($4, branch),
           compose_path = COALESCE($5, compose_path),
           working_dir = COALESCE($6, working_dir),
           compose_yaml = COALESCE($7, compose_yaml),
           env_encrypted = CASE WHEN $8::text IS NULL THEN env_encrypted ELSE $8 END,
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
        encryptSecret(requestedEnv)
      ]
    );
    if (!updated.rows[0]) {
      throw Object.assign(
        new Error("This deployment is already queued or is no longer ready to deploy."),
        { statusCode: 409 }
      );
    }
    const job = await enqueueJobInTransaction(
      client,
      { type: "deploy.execute", hostId: row.host_id, payload: { analysisId } },
      createdBy
    );
    return { analysis: mapAnalysis(updated.rows[0]), job };
  });
  await notifyJobQueued(result.job.id);
  return result;
}

async function prepareGitCheckout(row: any) {
  const host = await getHostForWorker(row.host_id);
  if (host.connectionMode !== "ssh") throw new Error("Git deployment requires an SSH host.");
  const target = row.working_dir;
  const source = row.source_locator;
  const username = row.credential_username ?? null;
  const secret = row.credential_secret_encrypted ? decryptSecret(row.credential_secret_encrypted) : null;
  const generatedCompose = row.compose_path === "composebastion.generated.yaml";
  const cleanupStaging = async () => {
    if (typeof row.staging_directory !== "string" || !/\/\.analysis\/[0-9a-f-]+$/i.test(row.staging_directory)) return;
    await runSshCommand(
      host.ssh,
      `rm -rf -- ${shQuote(row.staging_directory)}`,
      { timeoutMs: 30_000 }
    ).catch(() => undefined);
  };
  const writeGeneratedCompose = async () => {
    if (!generatedCompose) return;
    if (typeof row.compose_yaml !== "string" || !row.compose_yaml.trim()) {
      throw new Error("The generated Compose draft is missing. Analyze the repository again.");
    }
    await writeRemoteFile(host.ssh, path.posix.join(target, row.compose_path), row.compose_yaml);
  };
  const exists = await runSshCommand(host.ssh, `test -d ${shQuote(path.posix.join(target, ".git"))} && echo yes || echo no`, { timeoutMs: 30_000 });
  if (exists.stdout.trim() === "yes") {
    const checkoutStatus = generatedCompose
      ? "git status --porcelain -- . ':(exclude)composebastion.generated.yaml'"
      : "git status --porcelain";
    const command = [
      `cd ${shQuote(target)}`,
      `test -z "$(${checkoutStatus})"`,
      `test ${shQuote(normalizedGitUrl(source))} = "$(git remote get-url origin | sed -E 's/\\.git$//; s#/$##' | tr '[:upper:]' '[:lower:]')"`,
      `git fetch --quiet --tags origin`,
      row.branch ? `git checkout ${shQuote(row.branch)}` : "",
      row.branch ? `git pull --ff-only origin ${shQuote(row.branch)}` : "git pull --ff-only"
    ].filter(Boolean).join(" && ");
    const pulled = await runGit(row.id, host, command, username, secret, 10 * 60_000);
    if (pulled.code !== 0) throw new Error("The existing checkout could not be updated safely. Check for local changes or branch divergence.");
    await writeGeneratedCompose();
    await cleanupStaging();
    return;
  }
  const stagingDirectory = typeof row.staging_directory === "string" ? row.staging_directory : "";
  const stagingExists = stagingDirectory
    ? await runSshCommand(host.ssh, `test -d ${shQuote(path.posix.join(stagingDirectory, ".git"))} && echo yes || echo no`, { timeoutMs: 30_000 })
    : { stdout: "no" };
  if (stagingExists.stdout.trim() === "yes") {
    const moved = await runSshCommand(
      host.ssh,
      `mkdir -p ${shQuote(path.posix.dirname(target))} && test ! -e ${shQuote(target)} && mv ${shQuote(stagingDirectory)} ${shQuote(target)}`,
      { timeoutMs: 60_000 }
    );
    if (moved.code === 0) {
      await writeGeneratedCompose();
      return;
    }
  }
  const cloned = await runGit(
    row.id,
    host,
    `mkdir -p ${shQuote(path.posix.dirname(target))} && test ! -e ${shQuote(target)} && git clone ${row.branch ? `--branch ${shQuote(row.branch)}` : ""} ${shQuote(source)} ${shQuote(target)}`,
    username,
    secret,
    10 * 60_000
  );
  if (cloned.code !== 0) throw new Error("The repository could not be cloned into the deployment directory.");
  await writeGeneratedCompose();
  await cleanupStaging();
}

async function upsertDeploymentSource(row: any, stackId: string) {
  const metadata = JSON.stringify({ lastAnalysisId: row.id });
  const source = row.source_id
    ? await query<any>(
      `UPDATE deployment_sources
       SET name = $2,
           source_locator = $3,
           branch = $4,
           compose_path = $5,
           working_dir = $6,
           project_name = $7,
           compose_yaml = $8,
           env_encrypted = $9,
           credential_username = $10,
           credential_secret_encrypted = $11,
           default_host_id = $12,
           metadata = metadata || $13::jsonb,
           last_deployed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        row.source_id,
        row.display_name,
        row.source_locator,
        row.branch,
        row.compose_path,
        row.working_dir,
        row.project_name,
        row.compose_yaml,
        row.env_encrypted,
        row.credential_username,
        row.credential_secret_encrypted,
        row.host_id,
        metadata
      ]
    )
    : await query<any>(
      `INSERT INTO deployment_sources (
      id, source_type, name, source_locator, branch, compose_path, working_dir, project_name,
      compose_yaml, env_encrypted, credential_username, credential_secret_encrypted,
      default_host_id, metadata, last_deployed_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
    ON CONFLICT (source_type, source_locator, (COALESCE(branch, '')), (COALESCE(compose_path, '')))
    DO UPDATE SET
      name = EXCLUDED.name,
      project_name = EXCLUDED.project_name,
      working_dir = EXCLUDED.working_dir,
      compose_yaml = EXCLUDED.compose_yaml,
      env_encrypted = EXCLUDED.env_encrypted,
      credential_username = EXCLUDED.credential_username,
      credential_secret_encrypted = EXCLUDED.credential_secret_encrypted,
      default_host_id = EXCLUDED.default_host_id,
      metadata = deployment_sources.metadata || EXCLUDED.metadata,
      last_deployed_at = now(),
      updated_at = now()
    RETURNING *`,
      [
        uuid(),
        row.source_type,
        row.display_name,
        row.source_locator,
        row.branch,
        row.compose_path,
        row.working_dir,
        row.project_name,
        row.compose_yaml,
        row.env_encrypted,
        row.credential_username,
        row.credential_secret_encrypted,
        row.host_id,
        metadata
      ]
    );
  if (!source.rows[0]) throw new Error("The deployment source no longer exists.");
  await query("UPDATE compose_stacks SET deployment_source_id = $2 WHERE id = $1", [stackId, source.rows[0].id]);
  return mapSource(source.rows[0]);
}

export async function executeDeployment(analysisId: string) {
  const rowResult = await query<any>("SELECT * FROM deployment_analyses WHERE id = $1", [analysisId]);
  const row = rowResult.rows[0];
  if (!row) throw new Error("Deployment analysis not found.");
  if (row.status !== "deploying" && row.status !== "failed") {
    throw new Error("Deployment analysis is not queued for deployment.");
  }
  if (row.status === "failed") {
    await query("UPDATE deployment_analyses SET status = 'deploying', error = null, updated_at = now() WHERE id = $1", [analysisId]);
    row.status = "deploying";
  }
  try {
    if (row.source_type === "git") await prepareGitCheckout(row);
    let overwriteManagedFiles = false;
    if (row.source_type !== "git") {
      overwriteManagedFiles = await sourceOwnsDeploymentPath(
        row,
        row.working_dir,
        row.compose_path,
        true
      );
      const existingDirectory = await statHostPath(row.host_id, row.working_dir).catch(() => ({ exists: false }));
      if (existingDirectory?.exists && !overwriteManagedFiles) {
        throw new Error(`${row.working_dir} appeared after analysis and is not managed by this library source. Nothing was overwritten.`);
      }
    }
    await preflightDeploymentImages(row.host_id, row.compose_yaml);
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
    const deployed = await executeDockerAction(action as any);
    const source = await upsertDeploymentSource(row, String((deployed as any).stackId));
    const stackId = String((deployed as any).stackId);
    const deploymentVariables = Array.isArray(row.variables) ? row.variables as Variable[] : [];
    const secretKeys = new Set(
      deploymentVariables.filter((variable) => variable.secret).map((variable) => variable.key)
    );
    const decryptedEnvironment = row.env_encrypted ? decryptSecret(row.env_encrypted) : "";
    for (const key of rawEnvValues(decryptedEnvironment).keys()) {
      if (SECRET_NAME.test(key)) secretKeys.add(key);
    }
    const protectedEnvironment = sanitizeEnvForResponse(decryptedEnvironment, secretKeys);
    await query("UPDATE compose_stacks SET env = $2 WHERE id = $1", [stackId, protectedEnvironment]);
    await query(
      `UPDATE compose_stack_versions AS versions
       SET env = $2
       FROM compose_stacks AS stacks
       WHERE stacks.id = $1
         AND versions.id = stacks.current_version_id`,
      [stackId, protectedEnvironment]
    );
    const updated = await query<any>(
      `UPDATE deployment_analyses
       SET status = 'deployed',
           source_id = $2,
           env_encrypted = null,
           credential_secret_encrypted = null,
           deployed_at = now(),
           updated_at = now(),
           error = null
       WHERE id = $1
       RETURNING *`,
      [analysisId, source.id]
    );
    return { analysis: mapAnalysis(updated.rows[0]), source, stackId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query(
      "UPDATE deployment_analyses SET status = 'failed', error = $2, updated_at = now() WHERE id = $1",
      [analysisId, message]
    );
    throw error;
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

export async function createDeploymentSource(input: unknown) {
  const parsed = deploymentSourceCreateSchema.parse(input);
  const sourceLocator = canonicalizeDeploymentSource(parsed.sourceLocator, parsed.sourceType);
  try {
    const result = await query<any>(
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
    return mapSource(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw Object.assign(new Error("This deployment source is already in My Library."), { statusCode: 409 });
    }
    throw error;
  }
}

export async function updateDeploymentSource(id: string, input: unknown) {
  const parsed = deploymentSourceUpdateSchema.parse(input);
  const current = (await query<any>("SELECT * FROM deployment_sources WHERE id = $1", [id])).rows[0];
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
    : parsed.credentialSecret ? encryptSecret(parsed.credentialSecret) : current.credential_secret_encrypted;
  let result;
  try {
    result = await query<any>(
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
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw Object.assign(new Error("Another My Library source already uses this branch and Compose path."), { statusCode: 409 });
    }
    throw error;
  }
  return mapSource(result.rows[0]);
}

export async function deleteDeploymentSource(id: string) {
  const result = await query("DELETE FROM deployment_sources WHERE id = $1 RETURNING id", [id]);
  return Boolean(result.rows[0]);
}

export async function cleanupExpiredDeploymentAnalyses() {
  const expired = await query<any>(
    `UPDATE deployment_analyses
     SET status = 'expired',
         env_encrypted = null,
         credential_secret_encrypted = null,
         updated_at = now()
     WHERE expires_at <= now() AND status NOT IN ('deployed', 'expired')
     RETURNING host_id, staging_directory`
  );
  for (const row of expired.rows) {
    if (!row.staging_directory || !/\/\.analysis\/[0-9a-f-]+$/i.test(row.staging_directory)) continue;
    const host = await getHostForWorker(row.host_id).catch(() => null);
    if (host?.connectionMode === "ssh") {
      await runSshCommand(host.ssh, `rm -rf -- ${shQuote(row.staging_directory)}`, { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }
  return { expired: expired.rowCount ?? 0 };
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
  declaredHostPort,
  dockerRegistryTrust
};

export async function configureRegistryTrust(hostId: string, registry: string) {
  const before = await checkRegistryTrust(hostId, registry, true);
  if (before.trusted) return { ...before, changed: false };
  if (!before.canApply) throw new Error("Passwordless sudo is required to configure Docker registry trust automatically.");
  const host = await getHostForWorker(hostId);
  if (host.connectionMode !== "ssh") throw new Error("Automatic registry trust repair currently requires an SSH host.");

  const currentResult = await runSshCommand(
    host.ssh,
    "if sudo -n test -f /etc/docker/daemon.json; then sudo -n cat /etc/docker/daemon.json; else printf '{}'; fi",
    { timeoutMs: 30_000 }
  );
  if (currentResult.code !== 0) throw new Error("Could not read Docker's daemon configuration.");
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(currentResult.stdout || "{}");
  } catch {
    throw new Error("/etc/docker/daemon.json is not valid JSON. Repair it manually before applying registry trust.");
  }
  const merged = mergeDockerDaemonRegistryTrust(current, before.registry);
  const candidate = `${JSON.stringify(merged, null, 2)}\n`;
  const candidatePath = `/tmp/composebastion-daemon-${uuid()}.json`;
  const backupPath = `/etc/docker/daemon.json.composebastion-${Date.now()}.bak`;
  await writeRemoteFile(host.ssh, candidatePath, candidate);
  try {
    const validate = await runSshCommand(
      host.ssh,
      `sudo -n dockerd --validate --config-file ${shQuote(candidatePath)}`,
      { timeoutMs: 60_000 }
    );
    if (validate.code !== 0) throw new Error(validate.stderr || "Docker rejected the candidate daemon configuration.");
    const install = await runSshCommand(
      host.ssh,
      [
        "sudo -n mkdir -p /etc/docker",
        `if sudo -n test -f /etc/docker/daemon.json; then sudo -n cp /etc/docker/daemon.json ${shQuote(backupPath)}; fi`,
        `sudo -n cp ${shQuote(candidatePath)} /etc/docker/daemon.json`,
        "sudo -n systemctl restart docker"
      ].join(" && "),
      { timeoutMs: 120_000 }
    );
    if (install.code !== 0) {
      await runSshCommand(
        host.ssh,
        `if sudo -n test -f ${shQuote(backupPath)}; then sudo -n cp ${shQuote(backupPath)} /etc/docker/daemon.json; else sudo -n rm -f /etc/docker/daemon.json; fi; sudo -n systemctl restart docker`,
        { timeoutMs: 120_000 }
      ).catch(() => undefined);
      throw new Error("Docker did not restart cleanly. The original daemon configuration was restored.");
    }
    const after = await checkRegistryTrust(hostId, before.registry, true);
    if (!after.trusted) {
      await runSshCommand(
        host.ssh,
        `if sudo -n test -f ${shQuote(backupPath)}; then sudo -n cp ${shQuote(backupPath)} /etc/docker/daemon.json; else sudo -n rm -f /etc/docker/daemon.json; fi; sudo -n systemctl restart docker`,
        { timeoutMs: 120_000 }
      ).catch(() => undefined);
      throw new Error("Docker restarted, but the registry was still not trusted. The original daemon configuration was restored.");
    }
    return { ...after, changed: true, backupPath };
  } finally {
    await runSshCommand(host.ssh, `rm -f -- ${shQuote(candidatePath)}`, { timeoutMs: 30_000 }).catch(() => undefined);
  }
}
