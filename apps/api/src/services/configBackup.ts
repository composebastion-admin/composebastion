import {
  alertRuleCreateSchema,
  appSourceLinkInputSchema,
  backupTargetCreateSchema,
  canonicalizeGithubRepositoryUrl,
  canonicalizeGitRepositoryUrl,
  canonicalizePlaintextHttpSourceUrl,
  composeStackCreateSchema,
  composeStackProxyFieldsSchema,
  CONFIG_BACKUP_FORMAT_VERSION,
  deploymentSourceCreateSchema,
  dockerHostCreateSchema,
  githubRepositoryCreateSchema,
  idSchema,
  sanitizeDeploymentSourceLocator,
  sanitizeGithubRepositoryUrl,
  sanitizeGitRepositoryUrl,
  sanitizePlaintextHttpSourceUrl,
  registryCreateSchema
} from "@composebastion/shared";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { query, withTransaction } from "../db/pool.js";
import {
  assertBackupTargetIdentityChangeAllowed,
  lockBackupTarget
} from "./backupTargetLifecycle.js";
import { decryptConfigPayload, decryptSecret, encryptConfigPayload, encryptSecret, type EncryptedConfigPayload } from "./crypto.js";
import {
  assertBackupTargetS3EndpointAllowed,
  exportBackupTargetSecrets,
  normalizeBackupTargetCreate,
  type BackupTargetRowInput
} from "./recoveryBackupTargets.js";
import { APP_VERSION } from "./version.js";
import { validateAgentUrl } from "./ssrf.js";
import {
  lockHostForMutation,
  normalizeHostCreateCredentials
} from "./hosts.js";
import { lockHostIdentityScope } from "./hostIdentity.js";
import {
  lockComposeStackForMutation,
  lockGithubRepositoryForMutation
} from "./jobs.js";
import { lockRegistryForMutation } from "./registries.js";

const CONFIG_BACKUP_APP_NAME = "ComposeBastion";

type ConfigBackupPayload = {
  app: string;
  formatVersion: number;
  version: string;
  exportedAt: string;
  hosts: Array<Record<string, any>>;
  composeStacks: Array<Record<string, any>>;
  registries: Array<Record<string, any>>;
  notificationChannels: Array<Record<string, any>>;
  alertRules: Array<Record<string, any>>;
  favoriteImages: Array<Record<string, any>>;
  githubRepositories: Array<Record<string, any>>;
  deploymentSources?: Array<Record<string, any>>;
  appSourceLinks?: Array<Record<string, any>>;
  backupTargets?: Array<Record<string, any>>;
};

function decryptNullable(value: string | null | undefined) {
  return value ? decryptSecret(value) : null;
}

function encryptNullable(value: unknown) {
  return typeof value === "string" && value.length > 0 ? encryptSecret(value) : null;
}

function configImportError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function decryptConfigBackupPayload(backup: Record<string, unknown>, passphrase: string) {
  try {
    return decryptConfigPayload<ConfigBackupPayload>(backup as unknown as EncryptedConfigPayload, passphrase);
  } catch {
    throw configImportError("Config backup could not be decrypted. Check the passphrase and JSON file.");
  }
}

const payloadArrayFields = [
  "hosts",
  "composeStacks",
  "registries",
  "notificationChannels",
  "alertRules",
  "favoriteImages",
  "githubRepositories"
] as const;

function validateConfigBackupPayload(payload: ConfigBackupPayload) {
  if (payload.app !== CONFIG_BACKUP_APP_NAME) {
    throw configImportError("This is not a ComposeBastion config backup");
  }
  if (payload.formatVersion !== CONFIG_BACKUP_FORMAT_VERSION) {
    throw configImportError(`Unsupported ComposeBastion config backup format version ${String(payload.formatVersion)}`);
  }
  for (const field of payloadArrayFields) {
    if (!Array.isArray(payload[field])) {
      throw configImportError(`Config backup is missing the ${field} list`);
    }
  }
  if (payload.appSourceLinks !== undefined && !Array.isArray(payload.appSourceLinks)) {
    throw configImportError("Config backup appSourceLinks must be a list");
  }
  if (payload.deploymentSources !== undefined && !Array.isArray(payload.deploymentSources)) {
    throw configImportError("Config backup deploymentSources must be a list");
  }
  if (payload.backupTargets !== undefined && !Array.isArray(payload.backupTargets)) {
    throw configImportError("Config backup backupTargets must be a list");
  }
}

function normalizeImportedRegistries(registries: Array<Record<string, any>>) {
  return registries.map((registry, index) => {
    if (!registry || typeof registry !== "object") {
      throw configImportError(`Config backup registry ${index + 1} is invalid`);
    }
    const parsed = registryCreateSchema.safeParse({
      name: registry.name,
      url: registry.url,
      username: registry.username ?? undefined,
      password: registry.password ?? undefined,
      insecure: registry.insecure ?? false
    });
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "Registry configuration is invalid";
      throw configImportError(`Config backup registry ${index + 1} is invalid: ${detail}`);
    }
    return { ...registry, ...parsed.data, id: registry.id };
  });
}

async function normalizeImportedHosts(hosts: Array<Record<string, any>>) {
  return Promise.all(hosts.map(async (host, index) => {
    if (!host || typeof host !== "object") {
      throw configImportError(`Config backup host ${index + 1} is invalid`);
    }
    const parsedId = idSchema.safeParse(host.id);
    if (!parsedId.success) {
      const detail = parsedId.error.issues[0]?.message ?? "Host id is invalid";
      throw configImportError(`Config backup host ${index + 1} is invalid: ${detail}`);
    }
    const parsed = dockerHostCreateSchema.safeParse({
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      connectionMode: host.connectionMode ?? "ssh",
      sshAuthType: host.sshAuthType ?? "key",
      sshPrivateKey: host.secrets?.sshPrivateKey ?? undefined,
      sshKeyPassphrase: host.secrets?.sshKeyPassphrase ?? undefined,
      sshPassword: host.secrets?.sshPassword ?? undefined,
      agentUrl: host.agentUrl ?? undefined,
      agentToken: host.secrets?.agentToken ?? undefined,
      dockerSocketPath: host.dockerSocketPath ?? "/var/run/docker.sock",
      tags: host.tags ?? []
    });
    if (!parsed.success) {
      const detail = parsed.error.issues[0]?.message ?? "Host configuration is invalid";
      throw configImportError(`Config backup host ${index + 1} is invalid: ${detail}`);
    }
    if (
      parsed.data.connectionMode === "agent"
      && parsed.data.agentUrl
      && env.NODE_ENV === "production"
      && !env.ALLOW_PRIVATE_AGENT_URLS
      && !await validateAgentUrl(parsed.data.agentUrl)
    ) {
      throw configImportError(
        `Config backup host ${index + 1} is invalid: the agent URL is blocked by the private-network request policy`
      );
    }
    return {
      id: parsedId.data.toLowerCase(),
      ...normalizeHostCreateCredentials(parsed.data)
    };
  }));
}

function indexedConfigError(kind: string, index: number, error: unknown) {
  const detail = error instanceof Error ? error.message : `${kind} configuration is invalid`;
  return configImportError(`Config backup ${kind} ${index + 1} is invalid: ${detail}`);
}

type NormalizedImportedBackupTarget = BackupTargetRowInput & { id: string };

function importedRclonePassword(target: Record<string, any>, index: number) {
  const credentials = target.rcloneCredentials;
  if (credentials === undefined || credentials === null) return undefined;
  if (typeof credentials !== "object" || Array.isArray(credentials)) {
    throw indexedConfigError("backup target", index, new Error("rcloneCredentials must be an object"));
  }
  const password = credentials.password;
  if (password === undefined || password === null) return undefined;
  if (typeof password !== "string") {
    throw indexedConfigError("backup target", index, new Error("rcloneCredentials.password must be a string"));
  }
  return password;
}

async function normalizeImportedBackupTargets(
  targets: Array<Record<string, any>>
): Promise<NormalizedImportedBackupTarget[]> {
  return Promise.all(targets.map(async (target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw configImportError(`Config backup backup target ${index + 1} is invalid`);
    }
    const parsedId = idSchema.safeParse(target.id);
    if (!parsedId.success) {
      throw indexedConfigError(
        "backup target",
        index,
        new Error(parsedId.error.issues[0]?.message ?? "Backup target id is invalid")
      );
    }
    const importedKind = target.type ?? target.kind;
    const rcloneConfig = target.config
      && typeof target.config === "object"
      && !Array.isArray(target.config)
      ? {
          ...target.config,
          rcloneConfig: target.config.rcloneConfig ?? undefined
        }
      : target.config;
    const schemaInput = importedKind === "local"
      ? {
        ...target,
        basePath: undefined,
        config: {},
        localCachePolicy: "keep"
      }
      : importedKind === "rclone"
        ? {
            ...target,
            config: rcloneConfig,
            rcloneConfig: target.rcloneConfig ?? undefined
          }
        : target;
    const parsed = backupTargetCreateSchema.safeParse(schemaInput);
    if (!parsed.success) {
      throw indexedConfigError(
        "backup target",
        index,
        new Error(parsed.error.issues[0]?.message ?? "Backup target configuration is invalid")
      );
    }
    try {
      const kind = (parsed.data as { type?: string; kind?: string }).type
        ?? (parsed.data as { kind?: string }).kind;
      const password = kind === "rclone" ? importedRclonePassword(target, index) : undefined;
      const normalizedInput = password === undefined
        ? parsed.data
        : Object.assign(parsed.data, { password });
      const normalized = normalizeBackupTargetCreate(normalizedInput);
      await assertBackupTargetS3EndpointAllowed(normalized);
      return { id: parsedId.data, ...normalized };
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      throw indexedConfigError("backup target", index, error);
    }
  }));
}

function normalizeImportedGithubRepositories(repositories: Array<Record<string, any>>) {
  return repositories.map((repository, index) => {
    if (!repository || typeof repository !== "object") {
      throw configImportError(`Config backup GitHub repository ${index + 1} is invalid`);
    }
    const parsed = githubRepositoryCreateSchema.safeParse({
      name: repository.name,
      repositoryUrl: repository.repositoryUrl,
      branch: repository.branch ?? "main",
      composePath: repository.composePath ?? "docker-compose.yml",
      projectName: repository.projectName ?? undefined,
      env: repository.env ?? "",
      defaultHostId: repository.defaultHostId ?? undefined,
      hostCloneUrl: repository.hostCloneUrl ?? undefined,
      hostCloneDirectory: repository.hostCloneDirectory ?? undefined,
      githubToken: repository.githubToken ?? undefined
    });
    if (!parsed.success) {
      throw indexedConfigError(
        "GitHub repository",
        index,
        new Error(parsed.error.issues[0]?.message ?? "Repository configuration is invalid")
      );
    }
    try {
      const repositoryUrl = canonicalizeGithubRepositoryUrl(parsed.data.repositoryUrl);
      const [owner, repo] = new URL(repositoryUrl).pathname.replace(/^\/|\/$/g, "").split("/");
      return {
        ...repository,
        ...parsed.data,
        id: repository.id,
        repositoryUrl,
        owner,
        repo,
        projectName: parsed.data.projectName ?? repo,
        hostCloneUrl: parsed.data.hostCloneUrl
          ? canonicalizeGitRepositoryUrl(parsed.data.hostCloneUrl)
          : null
      };
    } catch (error) {
      throw indexedConfigError("GitHub repository", index, error);
    }
  });
}

function normalizeImportedDeploymentSources(sources: Array<Record<string, any>>) {
  return sources.map((source, index) => {
    if (!source || typeof source !== "object") {
      throw configImportError(`Config backup deployment source ${index + 1} is invalid`);
    }
    const parsed = deploymentSourceCreateSchema.safeParse({
      sourceType: source.sourceType,
      name: source.name,
      sourceLocator: source.sourceLocator,
      branch: source.branch ?? undefined,
      composePath: source.composePath ?? undefined,
      workingDir: source.workingDir ?? undefined,
      projectName: source.projectName,
      composeYaml: source.composeYaml ?? undefined,
      env: source.env ?? undefined,
      defaultHostId: source.defaultHostId ?? undefined,
      credentialUsername: source.credentialUsername ?? undefined,
      credentialSecret: source.credentialSecret ?? undefined
    });
    if (!parsed.success) {
      throw indexedConfigError(
        "deployment source",
        index,
        new Error(parsed.error.issues[0]?.message ?? "Deployment source configuration is invalid")
      );
    }
    try {
      const sourceLocator = parsed.data.sourceType === "git"
        ? canonicalizeGitRepositoryUrl(parsed.data.sourceLocator)
        : parsed.data.sourceType === "compose_url"
          ? canonicalizePlaintextHttpSourceUrl(parsed.data.sourceLocator)
          : parsed.data.sourceLocator;
      return {
        ...source,
        ...parsed.data,
        id: source.id,
        sourceLocator,
        metadata: source.metadata ?? {},
        lastDeployedAt: source.lastDeployedAt ?? null
      };
    } catch (error) {
      throw indexedConfigError("deployment source", index, error);
    }
  });
}

function normalizeImportedComposeStacks(
  stacks: Array<Record<string, any>>
): Array<Record<string, any>> {
  return stacks.map((stack, index) => {
    if (!stack || typeof stack !== "object") {
      throw configImportError(`Config backup Compose stack ${index + 1} is invalid`);
    }
    const parsedStack = composeStackCreateSchema.safeParse({
      name: stack.name,
      projectName: stack.projectName,
      composeYaml: stack.composeYaml,
      env: stack.env ?? ""
    });
    const parsedProxy = composeStackProxyFieldsSchema.safeParse({
      domains: stack.domains ?? [],
      exposedService: stack.exposedService ?? null,
      exposedPort: stack.exposedPort ?? null,
      tlsDesired: stack.tlsDesired ?? false,
      updatePolicyEnabled: stack.updatePolicyEnabled ?? false,
      updatePolicyChannel: stack.updatePolicyChannel ?? null
    });
    const parsedId = idSchema.safeParse(stack.id);
    const parsedHostId = idSchema.safeParse(stack.hostId);
    const issue = !parsedStack.success
      ? parsedStack.error.issues[0]
      : !parsedProxy.success
        ? parsedProxy.error.issues[0]
        : !parsedId.success
          ? parsedId.error.issues[0]
          : !parsedHostId.success
            ? parsedHostId.error.issues[0]
            : null;
    if (issue || !parsedStack.success || !parsedProxy.success || !parsedId.success || !parsedHostId.success) {
      throw indexedConfigError(
        "Compose stack",
        index,
        new Error(issue?.message ?? "Stack configuration is invalid")
      );
    }
    try {
      return {
        ...stack,
        ...parsedStack.data,
        ...parsedProxy.data,
        id: parsedId.data,
        hostId: parsedHostId.data,
        exposedService: parsedProxy.data.exposedService ?? null,
        exposedPort: parsedProxy.data.exposedPort ?? null,
        updatePolicyChannel: parsedProxy.data.updatePolicyChannel ?? null,
        sourceRepositoryUrl: stack.sourceRepositoryUrl
          ? canonicalizeGitRepositoryUrl(stack.sourceRepositoryUrl)
          : null
      };
    } catch (error) {
      throw indexedConfigError("Compose stack", index, error);
    }
  });
}

function normalizeImportedAlertRules(
  rules: Array<Record<string, any>>
): Array<Record<string, any>> {
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== "object") {
      throw configImportError(`Config backup alert rule ${index + 1} is invalid`);
    }
    const parsed = alertRuleCreateSchema.safeParse({
      name: rule.name,
      condition: rule.condition,
      hostId: rule.hostId,
      containerId: rule.containerId ?? undefined,
      channelId: rule.channelId,
      enabled: rule.enabled ?? true,
      params: rule.params ?? undefined
    });
    const parsedId = idSchema.safeParse(rule.id);
    const issue = !parsed.success
      ? parsed.error.issues[0]
      : !parsedId.success
        ? parsedId.error.issues[0]
        : null;
    if (issue || !parsed.success || !parsedId.success) {
      throw indexedConfigError(
        "alert rule",
        index,
        new Error(issue?.message ?? "Alert rule configuration is invalid")
      );
    }
    return {
      id: parsedId.data,
      ...parsed.data,
      containerId: "containerId" in parsed.data ? parsed.data.containerId ?? null : null,
      params: "params" in parsed.data ? parsed.data.params : null
    };
  });
}

function normalizeImportedAppSourceLinks(
  links: Array<Record<string, any>>
): Array<Record<string, any>> {
  return links.map((link, index) => {
    if (!link || typeof link !== "object") {
      throw configImportError(`Config backup app source link ${index + 1} is invalid`);
    }
    const parsed = appSourceLinkInputSchema.safeParse({
      sourceType: link.sourceType,
      name: link.name ?? null,
      repositoryUrl: link.repositoryUrl ?? null,
      branch: link.branch ?? null,
      workingDir: link.workingDir ?? null,
      composePath: link.composePath ?? null,
      imageReference: link.imageReference ?? null
    });
    if (!parsed.success) {
      throw indexedConfigError(
        "app source link",
        index,
        new Error(parsed.error.issues[0]?.message ?? "App source link configuration is invalid")
      );
    }
    try {
      return {
        ...link,
        ...parsed.data,
        id: link.id,
        hostId: link.hostId,
        containerExternalId: link.containerExternalId,
        repositoryUrl: parsed.data.repositoryUrl
          ? canonicalizeGitRepositoryUrl(parsed.data.repositoryUrl)
          : null
      };
    } catch (error) {
      throw indexedConfigError("app source link", index, error);
    }
  });
}

function normalizedHostName(host: { name: string }) {
  return host.name.trim().toLowerCase();
}

function normalizedHostConnection(host: {
  hostname: string;
  username: string;
  port: number;
}) {
  return `${host.hostname.trim().toLowerCase()}\u0000${host.username}\u0000${host.port}`;
}

function assertUniqueImportedHosts(hosts: Array<{
  id: string;
  name: string;
  hostname: string;
  username: string;
  port: number;
}>) {
  const ids = new Set<string>();
  const names = new Set<string>();
  const connections = new Set<string>();
  for (const host of hosts) {
    if (ids.has(host.id)) {
      throw configImportError("Config backup contains duplicate host ids");
    }
    const name = normalizedHostName(host);
    const connection = normalizedHostConnection(host);
    if (names.has(name) || connections.has(connection)) {
      throw configImportError("Config backup contains duplicate host names or connection identities");
    }
    ids.add(host.id);
    names.add(name);
    connections.add(connection);
  }
}

function importedGithubRepositoryIdentity(repository: Record<string, any>) {
  return `${repository.owner}/${repository.repo}:${repository.branch ?? "main"}:${repository.composePath ?? "docker-compose.yml"}`;
}

function importedComposeStackIdentity(stack: Record<string, any>) {
  return `${stack.hostId}:${stack.projectName}`;
}

function configMutationConflict(message: string) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

async function preflightImportedMutationTargets(
  client: PoolClient,
  hosts: Array<Record<string, any>>,
  registries: Array<Record<string, any>>,
  repositories: Array<Record<string, any>>,
  stacks: Array<Record<string, any>>,
  deploymentSources: Array<Record<string, any>>
) {
  const repositoryByIdentity = new Map<string, Record<string, any>>();
  for (const repository of repositories) {
    repositoryByIdentity.set(importedGithubRepositoryIdentity(repository), repository);
  }
  const stackByIdentity = new Map<string, Record<string, any>>();
  for (const stack of stacks) {
    stackByIdentity.set(importedComposeStackIdentity(stack), stack);
  }
  const registryById = new Map<string, Record<string, any>>();
  for (const registry of registries) {
    registryById.set(String(registry.id), registry);
  }
  const deploymentSourceById = new Map<string, Record<string, any>>();
  for (const source of deploymentSources) {
    deploymentSourceById.set(String(source.id), source);
  }

  // Acquire every identity key before any row or mutation lock. Sorting the
  // combined set gives concurrent bulk imports the same global lock order.
  const identityLockKeys = [
    ...[...repositoryByIdentity.entries()].map(([identity]) => `github-repository:${identity}`),
    ...[...stackByIdentity.entries()].map(([identity]) => `compose-stack-identity:${identity}`)
  ].sort();
  for (const key of identityLockKeys) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [key]
    );
  }

  const repositoryTargetIds = new Map<string, string>();
  for (const [identity, repository] of [...repositoryByIdentity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM github_repositories
       WHERE owner = $1 AND repo = $2 AND branch = $3 AND compose_path = $4`,
      [
        repository.owner,
        repository.repo,
        repository.branch ?? "main",
        repository.composePath ?? "docker-compose.yml"
      ]
    );
    if (existing.rows[0]) repositoryTargetIds.set(identity, existing.rows[0].id);
  }

  const stackTargetIds = new Map<string, string>();
  for (const [identity, stack] of [...stackByIdentity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM compose_stacks
       WHERE host_id = $1 AND project_name = $2`,
      [stack.hostId, stack.projectName]
    );
    if (existing.rows[0]) stackTargetIds.set(identity, existing.rows[0].id);
  }

  const registryTargetIds = new Set<string>();
  for (const id of [...registryById.keys()].sort()) {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM registries WHERE id = $1",
      [id]
    );
    if (existing.rows[0]) registryTargetIds.add(existing.rows[0].id);
  }
  const deploymentSourceTargetIds = new Set<string>();
  for (const id of [...deploymentSourceById.keys()].sort()) {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM deployment_sources WHERE id = $1",
      [id]
    );
    if (existing.rows[0]) deploymentSourceTargetIds.add(existing.rows[0].id);
  }

  // Deployment queueing locks registry credentials before target mutation
  // scopes. GitHub deploy admission then uses repository -> stack ordering.
  // Match that order here and sort ids within each class so two overlapping
  // imports cannot deadlock.
  for (const registryId of [...registryTargetIds].sort()) {
    const imported = registryById.get(registryId);
    const registry = await lockRegistryForMutation(client, registryId, {
      additionalAuthorities: imported
        ? [new URL(imported.url).host]
        : []
    });
    if (!registry) {
      throw configMutationConflict(
        "A registry credential changed while the configuration import was being prepared. Retry the import."
      );
    }
  }
  for (const repositoryId of [...new Set(repositoryTargetIds.values())].sort()) {
    const repository = await lockGithubRepositoryForMutation(client, repositoryId);
    if (!repository) {
      throw configMutationConflict(
        "A GitHub repository changed while the configuration import was being prepared. Retry the import."
      );
    }
  }
  for (const stackId of [...new Set(stackTargetIds.values())].sort()) {
    const stack = await lockComposeStackForMutation(client, stackId);
    if (!stack) {
      throw configMutationConflict(
        "A Compose stack changed while the configuration import was being prepared. Retry the import."
      );
    }
  }
  for (const sourceId of [...deploymentSourceTargetIds].sort()) {
    const source = await client.query(
      "SELECT id FROM deployment_sources WHERE id = $1 FOR UPDATE",
      [sourceId]
    );
    if (!source.rows[0]) {
      throw configMutationConflict(
        "A deployment source changed while the configuration import was being prepared. Retry the import."
      );
    }
    const analyses = await client.query(
      `SELECT analyses.id, analyses.status, analyses.error,
              jobs.id AS operation_job_id, jobs.status AS job_status,
              jobs.error AS job_error, jobs.result AS job_result
       FROM deployment_analyses AS analyses
       LEFT JOIN operation_jobs AS jobs
         ON jobs.payload->>'analysisId' = analyses.id::text
        AND jobs.type IN ('deploy.analyze', 'deploy.execute')
       WHERE analyses.source_id = $1
         AND (
           (
             analyses.expires_at > clock_timestamp()
             AND analyses.status IN ('queued', 'analyzing', 'ready', 'deploying', 'failed')
           )
           OR (
             jobs.status = 'failed'
             AND (
               jobs.error LIKE 'WORKER_LOST%'
               OR jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
               OR analyses.error LIKE 'WORKER_LOST:%'
               OR analyses.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'
             )
           )
         )
       ORDER BY analyses.created_at ASC
       FOR UPDATE OF analyses`,
      [sourceId]
    );
    if (analyses.rows[0]) {
      throw Object.assign(
        new Error(
          "A deployment source cannot be imported over while one of its analyses is active, deployable, retryable, or awaiting remote-outcome reconciliation."
        ),
        {
          statusCode: 409,
          analysisId: analyses.rows[0].id,
          ...(analyses.rows[0].operation_job_id
            ? { activeJobId: analyses.rows[0].operation_job_id }
            : {})
        }
      );
    }
  }
  const hostTargetIds = new Set<string>();
  for (const host of [...hosts].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const locked = await lockHostForMutation(
      client,
      String(host.id),
      { includeDeleted: true }
    );
    if (locked) hostTargetIds.add(String(host.id));
  }

  return {
    hostTargetIds,
    registryTargetIds,
    repositoryTargetIds,
    stackTargetIds,
    deploymentSourceTargetIds
  };
}

export async function exportConfigBackup(passphrase: string) {
  const [hosts, composeStacks, registries, notificationChannels, alertRules, favoriteImages, githubRepositories, appSourceLinks, backupTargets, deploymentSources] = await Promise.all([
    query("SELECT * FROM docker_hosts WHERE deleted_at IS NULL ORDER BY name ASC"),
    query("SELECT * FROM compose_stacks ORDER BY name ASC"),
    query("SELECT * FROM registries ORDER BY name ASC"),
    query("SELECT * FROM notification_channels ORDER BY name ASC"),
    query("SELECT * FROM alert_rules ORDER BY name ASC"),
    query("SELECT * FROM favorite_images ORDER BY image ASC"),
    query("SELECT * FROM github_repositories ORDER BY name ASC"),
    query("SELECT * FROM app_source_links ORDER BY host_id, name ASC"),
    query("SELECT * FROM backup_targets ORDER BY name ASC"),
    query("SELECT * FROM deployment_sources ORDER BY name ASC")
  ]);
  const activeHostRows = hosts.rows.filter((row: any) => row.deleted_at == null);
  const activeHostIds = new Set(activeHostRows.map((row: any) => row.id));

  const payload: ConfigBackupPayload = {
    app: CONFIG_BACKUP_APP_NAME,
    formatVersion: CONFIG_BACKUP_FORMAT_VERSION,
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    hosts: activeHostRows.map((row: any) => {
      const connectionMode = row.connection_mode ?? "ssh";
      const sshAuthType = row.ssh_auth_type ?? "key";
      return {
        id: row.id,
        name: row.name,
        hostname: row.hostname,
        port: Number(row.port),
        username: row.username,
        connectionMode,
        sshAuthType,
        dockerSocketPath: row.docker_socket_path,
        tags: row.tags ?? [],
        agentUrl: connectionMode === "agent"
          ? sanitizePlaintextHttpSourceUrl(row.agent_url)
          : null,
        secrets: {
          sshPrivateKey: connectionMode === "ssh" && sshAuthType === "key"
            ? decryptNullable(row.ssh_key_encrypted)
            : null,
          sshKeyPassphrase: connectionMode === "ssh" && sshAuthType === "key"
            ? decryptNullable(row.ssh_key_passphrase_encrypted)
            : null,
          sshPassword: connectionMode === "ssh" && sshAuthType === "password"
            ? decryptNullable(row.ssh_password_encrypted)
            : null,
          agentToken: connectionMode === "agent"
            ? decryptNullable(row.agent_token_encrypted)
            : null
        }
      };
    }),
    composeStacks: composeStacks.rows.filter((row: any) => activeHostIds.has(row.host_id)).map((row: any) => ({
      id: row.id,
      hostId: row.host_id,
      name: row.name,
      projectName: row.project_name,
      composeYaml: row.compose_yaml,
      env: row.env ?? "",
      status: row.status,
      sourceType: row.source_type ?? "ui",
      sourceRepositoryUrl: sanitizeGitRepositoryUrl(row.source_repository_url),
      sourceBranch: row.source_branch,
      sourceWorkingDir: row.source_working_dir,
      sourceComposePath: row.source_compose_path,
      sourceCurrentCommitSha: row.source_current_commit_sha,
      sourceLatestCommitSha: row.source_latest_commit_sha,
      deploymentSourceId: row.deployment_source_id,
      domains: row.domains ?? [],
      exposedService: row.exposed_service ?? null,
      exposedPort: row.exposed_port === null || row.exposed_port === undefined
        ? null
        : Number(row.exposed_port),
      tlsDesired: row.tls_desired ?? false,
      updatePolicyEnabled: row.update_policy_enabled ?? false,
      updatePolicyChannel: row.update_policy_channel ?? null
    })),
    registries: registries.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      username: row.username,
      insecure: row.insecure,
      password: decryptNullable(row.password_encrypted)
    })),
    notificationChannels: notificationChannels.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      emailTo: row.email_to,
      webhookUrl: row.webhook_url,
      enabled: row.enabled,
      config: row.config ?? {}
    })),
    alertRules: alertRules.rows.filter((row: any) => activeHostIds.has(row.host_id)).map((row: any) => ({
      id: row.id,
      name: row.name,
      condition: row.condition,
      hostId: row.host_id,
      containerId: row.container_id,
      channelId: row.channel_id,
      enabled: row.enabled,
      params: row.params ?? null
    })),
    favoriteImages: favoriteImages.rows.map((row: any) => ({
      id: row.id,
      image: row.image,
      name: row.name,
      notes: row.notes ?? ""
    })),
    githubRepositories: githubRepositories.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      repositoryUrl: sanitizeGithubRepositoryUrl(row.repository_url, {
        owner: row.owner,
        repo: row.repo
      }) ?? "",
      owner: row.owner,
      repo: row.repo,
      branch: row.branch,
      composePath: row.compose_path,
      projectName: row.project_name,
      env: row.env ?? "",
      defaultHostId: activeHostIds.has(row.default_host_id) ? row.default_host_id : null,
      hostCloneUrl: sanitizeGitRepositoryUrl(row.host_clone_url),
      hostCloneDirectory: row.host_clone_directory,
      githubToken: decryptNullable(row.github_token_encrypted)
    })),
    deploymentSources: (deploymentSources?.rows ?? []).map((row: any) => ({
      id: row.id,
      sourceType: row.source_type,
      name: row.name,
      sourceLocator: sanitizeDeploymentSourceLocator(row.source_locator, row.source_type) ?? "",
      branch: row.branch,
      composePath: row.compose_path,
      workingDir: row.working_dir,
      projectName: row.project_name,
      composeYaml: row.compose_yaml,
      env: decryptNullable(row.env_encrypted),
      credentialUsername: row.credential_username,
      credentialSecret: decryptNullable(row.credential_secret_encrypted),
      defaultHostId: activeHostIds.has(row.default_host_id) ? row.default_host_id : null,
      metadata: row.metadata ?? {},
      lastDeployedAt: row.last_deployed_at
    })),
    appSourceLinks: appSourceLinks.rows.filter((row: any) => activeHostIds.has(row.host_id)).map((row: any) => ({
      id: row.id,
      hostId: row.host_id,
      containerExternalId: row.container_external_id,
      sourceType: row.source_type,
      name: row.name,
      repositoryUrl: sanitizeGitRepositoryUrl(row.repository_url),
      branch: row.branch,
      workingDir: row.working_dir,
      composePath: row.compose_path,
      imageReference: row.image_reference,
      currentCommitSha: row.current_commit_sha,
      latestCommitSha: row.latest_commit_sha
    })),
    backupTargets: backupTargets.rows.map((row: any) => {
      const secrets = exportBackupTargetSecrets(row);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        config: secrets.config,
        accessKeyId: secrets.accessKeyId,
        secretAccessKey: secrets.secretAccessKey,
        provider: secrets.provider,
        remotePath: secrets.remotePath,
        localCachePolicy: secrets.localCachePolicy,
        rcloneConfig: secrets.rcloneConfig,
        rcloneCredentials: secrets.rcloneCredentials
      };
    })
  };

  return encryptConfigPayload(payload, passphrase);
}

export async function importConfigBackup(
  backup: Record<string, unknown>,
  passphrase: string,
  onImported?: (
    client: PoolClient,
    result: {
      imported: {
        hosts: number;
        composeStacks: number;
        registries: number;
        notificationChannels: number;
        alertRules: number;
        favoriteImages: number;
        githubRepositories: number;
        deploymentSources: number;
        appSourceLinks: number;
        backupTargets: number;
      };
      exportedAt: string;
      version: string;
    }
  ) => Promise<void>
) {
  const payload = decryptConfigBackupPayload(backup, passphrase);
  validateConfigBackupPayload(payload);
  const normalizedHosts = await normalizeImportedHosts(payload.hosts);
  const normalizedRegistries = normalizeImportedRegistries(payload.registries ?? []);
  const normalizedGithubRepositories = normalizeImportedGithubRepositories(payload.githubRepositories ?? []);
  const normalizedDeploymentSources = normalizeImportedDeploymentSources(payload.deploymentSources ?? []);
  const normalizedComposeStacks = normalizeImportedComposeStacks(payload.composeStacks ?? []);
  const normalizedAlertRules = normalizeImportedAlertRules(payload.alertRules ?? []);
  const normalizedAppSourceLinks = normalizeImportedAppSourceLinks(payload.appSourceLinks ?? []);
  const normalizedBackupTargets = await normalizeImportedBackupTargets(payload.backupTargets ?? []);
  assertUniqueImportedHosts(normalizedHosts);

  return withTransaction(async (client) => {
    await lockHostIdentityScope(client);
    const activeHosts = await client.query(
      `SELECT id, name, hostname, username, port
       FROM docker_hosts
       WHERE deleted_at IS NULL`
    );
    for (const importedHost of normalizedHosts) {
      const conflictingHost = activeHosts.rows.find((activeHost: any) =>
        activeHost.id !== importedHost.id
        && (
          normalizedHostName(activeHost) === normalizedHostName(importedHost)
          || normalizedHostConnection({
            ...activeHost,
            port: Number(activeHost.port)
          }) === normalizedHostConnection(importedHost)
        )
      );
      if (conflictingHost) {
        throw Object.assign(
          new Error("A host with this name or connection already exists"),
          { statusCode: 409 }
        );
      }
    }
    const mutationTargets = await preflightImportedMutationTargets(
      client,
      normalizedHosts,
      normalizedRegistries,
      normalizedGithubRepositories,
      normalizedComposeStacks,
      normalizedDeploymentSources
    );

    const counts = {
      hosts: 0,
      composeStacks: 0,
      registries: 0,
      notificationChannels: 0,
      alertRules: 0,
      favoriteImages: 0,
      githubRepositories: 0,
      deploymentSources: 0,
      appSourceLinks: 0,
      backupTargets: 0
    };

    for (const host of normalizedHosts) {
      await client.query(
        `INSERT INTO docker_hosts
          (id, name, hostname, port, username, connection_mode, ssh_auth_type, ssh_key_encrypted,
           ssh_key_passphrase_encrypted, ssh_password_encrypted, agent_url, agent_token_encrypted, docker_socket_path, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       hostname = EXCLUDED.hostname,
                       port = EXCLUDED.port,
                       username = EXCLUDED.username,
                       connection_mode = EXCLUDED.connection_mode,
                       ssh_auth_type = EXCLUDED.ssh_auth_type,
                       ssh_key_encrypted = EXCLUDED.ssh_key_encrypted,
                       ssh_key_passphrase_encrypted = EXCLUDED.ssh_key_passphrase_encrypted,
                       ssh_password_encrypted = EXCLUDED.ssh_password_encrypted,
                       agent_url = EXCLUDED.agent_url,
                       agent_token_encrypted = EXCLUDED.agent_token_encrypted,
                       docker_socket_path = EXCLUDED.docker_socket_path,
                       tags = EXCLUDED.tags,
                       last_status = 'unknown',
                       last_seen_at = NULL,
                       last_error = NULL,
                       docker_version = NULL,
                       compose_version = NULL,
                       agent_version = NULL,
                       deleted_at = NULL,
                       updated_at = now()`,
        [
          host.id,
          host.name,
          host.hostname,
          Number(host.port ?? 22),
          host.username,
          host.connectionMode ?? "ssh",
          host.sshAuthType ?? "key",
          encryptNullable(host.sshPrivateKey),
          encryptNullable(host.sshKeyPassphrase),
          encryptNullable(host.sshPassword),
          host.agentUrl ?? null,
          encryptNullable(host.agentToken),
          host.dockerSocketPath ?? "/var/run/docker.sock",
          host.tags ?? []
        ]
      );
      counts.hosts += 1;
    }

    for (const image of payload.favoriteImages ?? []) {
      await client.query(
        `INSERT INTO favorite_images (id, image, name, notes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (image)
         DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes, updated_at = now()`,
        [image.id, image.image, image.name ?? null, image.notes ?? ""]
      );
      counts.favoriteImages += 1;
    }

    for (const registry of normalizedRegistries) {
      const values = [
        registry.id,
        registry.name,
        registry.url,
        registry.username ?? null,
        encryptNullable(registry.password),
        registry.insecure ?? false
      ];
      if (mutationTargets.registryTargetIds.has(String(registry.id))) {
        await client.query(
          `UPDATE registries
           SET name = $2,
               url = $3,
               username = $4,
               password_encrypted = $5,
               insecure = $6,
               updated_at = now()
           WHERE id = $1`,
          values
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO registries (id, name, url, username, password_encrypted, insecure)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          values
        );
        if (inserted.rowCount === 0) {
          throw configMutationConflict(
            "A registry credential changed while the configuration import was being prepared. Retry the import."
          );
        }
        mutationTargets.registryTargetIds.add(String(registry.id));
      }
      counts.registries += 1;
    }

    for (const channel of payload.notificationChannels ?? []) {
      await client.query(
        `INSERT INTO notification_channels (id, name, type, email_to, webhook_url, enabled, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       type = EXCLUDED.type,
                       email_to = EXCLUDED.email_to,
                       webhook_url = EXCLUDED.webhook_url,
                       enabled = EXCLUDED.enabled,
                       config = EXCLUDED.config,
                       updated_at = now()`,
        [channel.id, channel.name, channel.type, channel.emailTo ?? null, channel.webhookUrl ?? null, channel.enabled ?? true, channel.config ?? {}]
      );
      counts.notificationChannels += 1;
    }

    for (const repo of normalizedGithubRepositories) {
      const identity = importedGithubRepositoryIdentity(repo);
      const existingId = mutationTargets.repositoryTargetIds.get(identity);
      const values = [
        repo.id,
        repo.name,
        repo.repositoryUrl,
        repo.owner,
        repo.repo,
        repo.branch ?? "main",
        repo.composePath ?? "docker-compose.yml",
        repo.projectName,
        repo.env ?? "",
        repo.defaultHostId ?? null,
        repo.hostCloneUrl ?? null,
        repo.hostCloneDirectory ?? null,
        encryptNullable(repo.githubToken)
      ];
      if (existingId) {
        await client.query(
          `UPDATE github_repositories
           SET name = $2,
               repository_url = $3,
               project_name = $4,
               env = $5,
               default_host_id = $6,
               host_clone_url = $7,
               host_clone_directory = $8,
               github_token_encrypted = $9,
               updated_at = now()
           WHERE id = $1`,
          [
            existingId,
            repo.name,
            repo.repositoryUrl,
            repo.projectName,
            repo.env ?? "",
            repo.defaultHostId ?? null,
            repo.hostCloneUrl ?? null,
            repo.hostCloneDirectory ?? null,
            encryptNullable(repo.githubToken)
          ]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO github_repositories
            (id, name, repository_url, owner, repo, branch, compose_path, project_name, env, default_host_id,
             host_clone_url, host_clone_directory, github_token_encrypted)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (owner, repo, branch, compose_path) DO NOTHING
           RETURNING id`,
          values
        );
        if (inserted.rowCount === 0) {
          throw configMutationConflict(
            "A GitHub repository changed while the configuration import was being prepared. Retry the import."
          );
        }
        // Preserve the historical last-entry-wins behavior for duplicate
        // identities within one backup without re-entering admission.
        mutationTargets.repositoryTargetIds.set(identity, repo.id);
      }
      counts.githubRepositories += 1;
    }

    for (const source of normalizedDeploymentSources) {
      const values = [
        source.id,
        source.sourceType,
        source.name,
        source.sourceLocator,
        source.branch ?? null,
        source.composePath ?? null,
        source.projectName,
        source.workingDir ?? null,
        source.composeYaml ?? null,
        encryptNullable(source.env),
        source.credentialUsername ?? null,
        encryptNullable(source.credentialSecret),
        source.defaultHostId ?? null,
        source.metadata ?? {},
        source.lastDeployedAt ?? null
      ];
      if (mutationTargets.deploymentSourceTargetIds.has(String(source.id))) {
        await client.query(
          `UPDATE deployment_sources
           SET source_type = $2,
               name = $3,
               source_locator = $4,
               branch = $5,
               compose_path = $6,
               project_name = $7,
               working_dir = $8,
               compose_yaml = $9,
               env_encrypted = $10,
               credential_username = $11,
               credential_secret_encrypted = $12,
               default_host_id = $13,
               metadata = $14,
               last_deployed_at = $15,
               updated_at = now()
           WHERE id = $1`,
          values
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO deployment_sources (
             id, source_type, name, source_locator, branch, compose_path, project_name,
             working_dir, compose_yaml, env_encrypted, credential_username, credential_secret_encrypted,
             default_host_id, metadata, last_deployed_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          values
        );
        if (inserted.rowCount === 0) {
          throw configMutationConflict(
            "A deployment source changed while the configuration import was being prepared. Retry the import."
          );
        }
        mutationTargets.deploymentSourceTargetIds.add(String(source.id));
      }
      counts.deploymentSources += 1;
    }

    for (const stack of normalizedComposeStacks) {
      const identity = importedComposeStackIdentity(stack);
      const existingId = mutationTargets.stackTargetIds.get(identity);
      if (existingId) {
        await client.query(
          `UPDATE compose_stacks
           SET name = $2,
               compose_yaml = $3,
               env = $4,
               status = $5,
               source_type = $6,
               source_repository_url = $7,
               source_branch = $8,
               source_working_dir = $9,
               source_compose_path = $10,
               source_current_commit_sha = $11,
               source_latest_commit_sha = $12,
               deployment_source_id = $13,
               domains = $14,
               exposed_service = $15,
               exposed_port = $16,
               tls_desired = $17,
               update_policy_enabled = $18,
               update_policy_channel = $19,
               updated_at = now()
           WHERE id = $1`,
          [
            existingId,
            stack.name,
            stack.composeYaml,
            stack.env ?? "",
            stack.status ?? "created",
            stack.sourceType ?? "ui",
            stack.sourceRepositoryUrl ?? null,
            stack.sourceBranch ?? null,
            stack.sourceWorkingDir ?? null,
            stack.sourceComposePath ?? null,
            stack.sourceCurrentCommitSha ?? null,
            stack.sourceLatestCommitSha ?? null,
            stack.deploymentSourceId ?? null,
            stack.domains,
            stack.exposedService,
            stack.exposedPort,
            stack.tlsDesired,
            stack.updatePolicyEnabled,
            stack.updatePolicyChannel
          ]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO compose_stacks (
             id, host_id, name, project_name, compose_yaml, env, status,
             source_type, source_repository_url, source_branch, source_working_dir, source_compose_path,
             source_current_commit_sha, source_latest_commit_sha, deployment_source_id,
             domains, exposed_service, exposed_port, tls_desired, update_policy_enabled, update_policy_channel
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                   $16, $17, $18, $19, $20, $21)
           ON CONFLICT (host_id, project_name) DO NOTHING
           RETURNING id`,
          [
            stack.id,
            stack.hostId,
            stack.name,
            stack.projectName,
            stack.composeYaml,
            stack.env ?? "",
            stack.status ?? "created",
            stack.sourceType ?? "ui",
            stack.sourceRepositoryUrl ?? null,
            stack.sourceBranch ?? null,
            stack.sourceWorkingDir ?? null,
            stack.sourceComposePath ?? null,
            stack.sourceCurrentCommitSha ?? null,
            stack.sourceLatestCommitSha ?? null,
            stack.deploymentSourceId ?? null,
            stack.domains,
            stack.exposedService,
            stack.exposedPort,
            stack.tlsDesired,
            stack.updatePolicyEnabled,
            stack.updatePolicyChannel
          ]
        );
        if (inserted.rowCount === 0) {
          throw configMutationConflict(
            "A Compose stack changed while the configuration import was being prepared. Retry the import."
          );
        }
        mutationTargets.stackTargetIds.set(identity, stack.id);
      }
      counts.composeStacks += 1;
    }

    for (const link of normalizedAppSourceLinks) {
      await client.query(
        `INSERT INTO app_source_links (
           id, host_id, container_external_id, source_type, name, repository_url, branch,
           working_dir, compose_path, image_reference, current_commit_sha, latest_commit_sha
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (host_id, container_external_id)
         DO UPDATE SET source_type = EXCLUDED.source_type,
                       name = EXCLUDED.name,
                       repository_url = EXCLUDED.repository_url,
                       branch = EXCLUDED.branch,
                       working_dir = EXCLUDED.working_dir,
                       compose_path = EXCLUDED.compose_path,
                       image_reference = EXCLUDED.image_reference,
                       current_commit_sha = EXCLUDED.current_commit_sha,
                       latest_commit_sha = EXCLUDED.latest_commit_sha,
                       updated_at = now()`,
        [
          link.id,
          link.hostId,
          link.containerExternalId,
          link.sourceType,
          link.name ?? null,
          link.repositoryUrl ?? null,
          link.branch ?? null,
          link.workingDir ?? null,
          link.composePath ?? null,
          link.imageReference ?? null,
          link.currentCommitSha ?? null,
          link.latestCommitSha ?? null
        ]
      );
      counts.appSourceLinks += 1;
    }

    for (const rule of normalizedAlertRules) {
      await client.query(
        `INSERT INTO alert_rules (id, name, condition, host_id, container_id, channel_id, enabled, params)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       condition = EXCLUDED.condition,
                       host_id = EXCLUDED.host_id,
                       container_id = EXCLUDED.container_id,
                       channel_id = EXCLUDED.channel_id,
                       enabled = EXCLUDED.enabled,
                       params = EXCLUDED.params,
                       updated_at = now()`,
        [
          rule.id,
          rule.name,
          rule.condition,
          rule.hostId,
          rule.containerId,
          rule.channelId,
          rule.enabled,
          rule.params
        ]
      );
      counts.alertRules += 1;
    }

    for (const target of normalizedBackupTargets) {
      const currentTarget = await lockBackupTarget(client, target.id);
      if (currentTarget) {
        await assertBackupTargetIdentityChangeAllowed(client, target.id, currentTarget, {
          kind: target.kind,
          config: target.config,
          provider: target.provider,
          remote_path: target.remotePath,
          generic_config_encrypted: target.genericConfigEncrypted
        });
      }
      await client.query(
        `INSERT INTO backup_targets (
           id, name, kind, enabled, config, access_key_id, secret_access_key_encrypted,
           provider, remote_path, local_cache_policy, generic_config_encrypted,
           generic_credentials_encrypted
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id)
         DO UPDATE SET name = EXCLUDED.name,
                       kind = EXCLUDED.kind,
                       enabled = EXCLUDED.enabled,
                       config = EXCLUDED.config,
                       access_key_id = EXCLUDED.access_key_id,
                       secret_access_key_encrypted = EXCLUDED.secret_access_key_encrypted,
                       provider = EXCLUDED.provider,
                       remote_path = EXCLUDED.remote_path,
                       local_cache_policy = EXCLUDED.local_cache_policy,
                       generic_config_encrypted = EXCLUDED.generic_config_encrypted,
                       generic_credentials_encrypted = EXCLUDED.generic_credentials_encrypted,
                       health_status = 'unknown',
                       health_checked_at = NULL,
                       health_error = NULL,
                       updated_at = now()`,
        [
          target.id,
          target.name,
          target.kind,
          target.enabled,
          target.config,
          target.accessKeyId,
          target.secretAccessKeyEncrypted,
          target.provider,
          target.remotePath,
          target.localCachePolicy,
          target.genericConfigEncrypted,
          target.genericCredentialsEncrypted
        ]
      );
      counts.backupTargets += 1;
    }

    const result = {
      imported: counts,
      exportedAt: payload.exportedAt,
      version: payload.version
    };
    await onImported?.(client, result);
    return result;
  });
}
